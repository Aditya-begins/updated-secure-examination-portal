import { ProctoringPolicy, ViolationType } from '../types';
import { evaluateViolationAction, shouldDebounceViolation } from './exam-rules';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// Display capture must be initiated by a click. Keep the verified readiness stream
// alive long enough for the exam session to attach it without prompting twice.
let preflightScreenStream: MediaStream | null = null;
export const savePreflightScreenStream = (stream: MediaStream) => { preflightScreenStream = stream; };
export const takePreflightScreenStream = (): MediaStream | null => {
  const stream = preflightScreenStream;
  preflightScreenStream = null;
  return stream;
};

export interface ProctoringState {
  isCameraActive: boolean;
  isMicActive: boolean;
  isScreenShareActive: boolean;
  isFullscreen: boolean;
  audioLevel: number; // 0 to 100
  faceDetected: boolean;
  headPose: 'centered' | 'looking_left' | 'looking_right' | 'looking_down' | 'absent';
  warningCount: number;
  headYaw: number;
  headPitch: number;
  gazeOffset: number;
  movementScore: number;
  latestViolation?: ViolationType;
}

export type ViolationCallback = (
  violation: ViolationType,
  confidence: number,
  action: 'warning_1' | 'warning_2' | 'auto_submitted',
  message: string,
  newWarningCount: number
) => void;

export class ProctoringEngine {
  private policy: ProctoringPolicy;
  private videoElement: HTMLVideoElement | null = null;
  private mediaStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrameId: number | null = null;
  private faceLandmarker: FaceLandmarker | null = null;
  private lastLandmarkTime = 0;
  private lastMovementSample = 0;

  private warningCount: number = 0;
  private lastViolationTime: number = 0;
  private onViolationCallback: ViolationCallback | null = null;
  private onStateChangeCallback: ((state: ProctoringState) => void) | null = null;

  private isRunning: boolean = false;
  private lookingAwayDurationMs: number = 0;
  private abnormalAudioDurationMs: number = 0;

  private state: ProctoringState = {
    isCameraActive: false,
    isMicActive: false,
    isScreenShareActive: false,
    isFullscreen: false,
    audioLevel: 0,
    faceDetected: true,
    headPose: 'centered',
    warningCount: 0,
    headYaw: 0,
    headPitch: 0,
    gazeOffset: 0,
    movementScore: 0,
  };

  constructor(policy: ProctoringPolicy, initialWarningCount = 0) {
    this.policy = policy;
    this.warningCount = initialWarningCount;
    this.state.warningCount = initialWarningCount;
  }

  public setCallbacks(onViolation: ViolationCallback, onStateChange: (state: ProctoringState) => void) {
    this.onViolationCallback = onViolation;
    this.onStateChangeCallback = onStateChange;
  }

  public async startMonitoring(videoEl: HTMLVideoElement): Promise<{ success: boolean; error?: string }> {
    this.videoElement = videoEl;
    this.isRunning = true;

    try {
      // 1. Camera & Microphone
      if (this.policy.enableCamera || this.policy.enableMicrophone) {
        try {
          const constraints: MediaStreamConstraints = {
            video: this.policy.enableCamera ? { width: { ideal: 640 }, height: { ideal: 480 } } : false,
            audio: this.policy.enableMicrophone,
          };
          this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

          if (this.videoElement && this.policy.enableCamera) {
            this.videoElement.srcObject = this.mediaStream;
            this.videoElement.muted = true;
            await this.videoElement.play().catch(() => {});
          this.state.isCameraActive = true;
          this.initialiseFaceLandmarks();
          }

          // 2. Audio Analyser
          if (this.policy.enableMicrophone && this.mediaStream.getAudioTracks().length > 0) {
            this.setupAudioAnalysis(this.mediaStream);
            this.state.isMicActive = true;
          }
        } catch (mediaErr) {
          const message = mediaErr instanceof DOMException
            ? mediaErr.message || mediaErr.name
            : 'Camera or microphone permission was not granted.';
          this.isRunning = false;
          return { success: false, error: `Camera/microphone unavailable: ${message}` };
        }
      }

      // 3. Screen Sharing
      if (this.policy.enableScreenShare) {
        try {
          if (navigator.mediaDevices.getDisplayMedia) {
            this.screenStream = takePreflightScreenStream() || await navigator.mediaDevices.getDisplayMedia({ video: true });
            this.state.isScreenShareActive = true;

            // Monitor if user stops screen sharing
            const screenTrack = this.screenStream.getVideoTracks()[0];
            if (screenTrack) {
              screenTrack.onended = () => {
                this.state.isScreenShareActive = false;
                this.triggerViolation('screen_share_stopped', 0.99);
              };
            }
          }
        } catch (err) {
          const message = err instanceof DOMException
            ? err.message || err.name
            : 'Screen sharing permission was not granted.';
          this.stopMonitoring();
          return { success: false, error: `Screen sharing unavailable: ${message}` };
        }
      }

      // 4. Tab Visibility and Fullscreen Listeners
      this.setupBrowserEventListeners();

      // 5. Start Real-time loop
      this.runDetectionLoop();

      this.updateState();
      return { success: true };
    } catch (err) {
      console.error('Proctoring start failed:', err);
      return { success: false, error: (err as Error).message };
    }
  }

  private async initialiseFaceLandmarks() {
    try {
      const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm');
      this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
      });
    } catch (error) {
      console.warn('Face-landmark detector unavailable:', error);
    }
  }

  private detectFaceLandmarks(now: number) {
    if (!this.faceLandmarker || !this.videoElement || this.videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || now - this.lastLandmarkTime < 100) return;
    this.lastLandmarkTime = now;
    const faces = this.faceLandmarker.detectForVideo(this.videoElement, now).faceLandmarks;
    const points = faces[0];
    if (!points) {
      this.state.faceDetected = false;
      this.state.headPose = 'absent';
      return;
    }
    this.state.faceDetected = true;
    const leftEye = points[33], rightEye = points[263], nose = points[1], forehead = points[10], chin = points[152];
    const eyeMidX = (leftEye.x + rightEye.x) / 2;
    const eyeDistance = Math.max(Math.abs(rightEye.x - leftEye.x), 0.01);
    const faceMidY = (forehead.y + chin.y) / 2;
    const faceHeight = Math.max(Math.abs(chin.y - forehead.y), 0.01);
    const yaw = ((nose.x - eyeMidX) / (eyeDistance / 2)) * 35;
    const pitch = ((nose.y - faceMidY) / faceHeight) * 70;
    const leftIris = points[468], rightIris = points[473];
    const gaze = leftIris && rightIris ? (((leftIris.x - leftEye.x) / Math.max(Math.abs(points[133].x - leftEye.x), 0.01)) + ((rightIris.x - points[362].x) / Math.max(Math.abs(rightEye.x - points[362].x), 0.01)) - 1) * 50 : yaw;
    this.state.headYaw = Math.round(yaw);
    this.state.headPitch = Math.round(pitch);
    this.state.gazeOffset = Math.round(gaze);
    this.state.movementScore = Math.min(100, Math.round(Math.abs(yaw) * 1.8 + Math.abs(pitch) * 1.2 + Math.abs(gaze) * 0.8));
    const threshold = this.policy.headPoseSensitivity === 'high' ? 10 : this.policy.headPoseSensitivity === 'medium' ? 16 : 24;
    this.state.headPose = pitch > threshold ? 'looking_down' : yaw < -threshold || gaze < -threshold ? 'looking_left' : yaw > threshold || gaze > threshold ? 'looking_right' : 'centered';
    if (this.state.headPose !== 'centered' && now - this.lastMovementSample > 1500) {
      this.lastMovementSample = now;
      this.triggerViolation('looking_away', 0.9);
    }
  }

  private setupAudioAnalysis(stream: MediaStream) {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      this.audioContext = new AudioCtx();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);
    } catch (e) {
      console.warn('Web Audio API not supported in current environment', e);
    }
  }

  private setupBrowserEventListeners() {
    // Visibility / Tab switch
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('blur', this.handleWindowBlur);
    document.addEventListener('fullscreenchange', this.handleFullscreenChange);
  }

  private handleVisibilityChange = () => {
    if (!this.isRunning) return;
    if (document.visibilityState === 'hidden' && this.policy.trackTabSwitch) {
      this.triggerViolation('tab_switched', 0.95);
    }
  };

  private handleWindowBlur = () => {
    if (!this.isRunning) return;
    if (this.policy.trackTabSwitch) {
      this.triggerViolation('window_blurred', 0.9);
    }
  };

  private handleFullscreenChange = () => {
    if (!this.isRunning) return;
    const isFull = !!document.fullscreenElement;
    this.state.isFullscreen = isFull;
    if (!isFull && this.policy.enforceFullscreen) {
      this.triggerViolation('fullscreen_exited', 0.95);
    }
    this.updateState();
  };

  private runDetectionLoop = () => {
    if (!this.isRunning) return;

    this.detectFaceLandmarks(performance.now());
    // Check Audio Level
    if (this.analyser) {
      const dataArray = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(dataArray);
      let sumSquares = 0;
      for (const sample of dataArray) {
        const normalizedSample = (sample - 128) / 128;
        sumSquares += normalizedSample * normalizedSample;
      }
      // RMS reflects actual microphone amplitude; spectral averages mostly hide speech.
      const rms = Math.sqrt(sumSquares / dataArray.length);
      const normalizedLevel = Math.min(100, Math.round((rms / 0.15) * 100));
      this.state.audioLevel = normalizedLevel;

      // Warn for sustained sound. Higher sensitivity intentionally catches quieter sound.
      const threshold = this.policy.noiseSensitivity === 'high' ? 8 : this.policy.noiseSensitivity === 'medium' ? 14 : 25;
      if (normalizedLevel > threshold) {
        this.abnormalAudioDurationMs += 16;
        if (this.abnormalAudioDurationMs >= 1500) { // sustained for 1.5 seconds
          this.triggerViolation('abnormal_noise', 0.88);
          this.abnormalAudioDurationMs = 0;
        }
      } else {
        this.abnormalAudioDurationMs = Math.max(0, this.abnormalAudioDurationMs - 24);
      }
    }

    this.updateState();
    this.animFrameId = window.requestAnimationFrame(this.runDetectionLoop);
  };

  /**
   * Manual or automated violation trigger
   */
  public triggerViolation(type: ViolationType, confidence = 0.9) {
    if (!this.isRunning) return;

    const now = Date.now();
    // Debounce to prevent multiple violations in short succession
    if (shouldDebounceViolation(this.lastViolationTime, now, 6000)) {
      return;
    }

    this.lastViolationTime = now;
    const evaluation = evaluateViolationAction(this.warningCount, this.policy.maxWarnings);
    this.warningCount = evaluation.newWarningCount;
    this.state.warningCount = this.warningCount;
    this.state.latestViolation = type;

    if (this.onViolationCallback) {
      this.onViolationCallback(
        type,
        confidence,
        evaluation.actionTaken,
        evaluation.message,
        this.warningCount
      );
    }

    this.updateState();
  }

  public simulateHeadPose(pose: 'centered' | 'looking_left' | 'looking_right' | 'looking_down' | 'absent') {
    this.state.headPose = pose;
    this.state.faceDetected = pose !== 'absent';

    if (pose === 'absent') {
      this.triggerViolation('face_absent', 0.92);
    } else if (pose === 'looking_left' || pose === 'looking_right' || pose === 'looking_down') {
      this.triggerViolation('looking_away', 0.85);
    }

    this.updateState();
  }

  private updateState() {
    if (this.onStateChangeCallback) {
      this.onStateChangeCallback({ ...this.state });
    }
  }

  public stopMonitoring() {
    this.isRunning = false;

    if (this.animFrameId) {
      window.cancelAnimationFrame(this.animFrameId);
    }

    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('blur', this.handleWindowBlur);
    document.removeEventListener('fullscreenchange', this.handleFullscreenChange);

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    if (this.screenStream) {
      this.screenStream.getTracks().forEach(track => track.stop());
      this.screenStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.faceLandmarker?.close();
    this.faceLandmarker = null;

    this.state.isCameraActive = false;
    this.state.isMicActive = false;
    this.state.isScreenShareActive = false;
    this.updateState();
  }
}

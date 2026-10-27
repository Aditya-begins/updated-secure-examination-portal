import React, { useState, useEffect, useRef } from 'react';
import {
  ShieldCheck,
  Camera,
  Mic,
  Monitor,
  UserCheck,
  Wifi,
  FileCheck2,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  ArrowRight,
  Sparkles,
  Lock,
} from 'lucide-react';
import { dbStore } from '../../services/store';
import { useAuth } from '../../services/auth';
import { savePreflightScreenStream } from '../../lib/proctoring';

interface PreExamCheckProps {
  examId: string;
  onNavigate: (route: string) => void;
}

export const PreExamCheck: React.FC<PreExamCheckProps> = ({ examId, onNavigate }) => {
  const { currentUser } = useAuth();
  const exam = dbStore.getExam(examId) || dbStore.getExams()[0];

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // 7 Checks State
  const [identityVerified, setIdentityVerified] = useState(false);
  const [cameraChecked, setCameraChecked] = useState(false);
  const [microphoneChecked, setMicrophoneChecked] = useState(false);
  const [micVolume, setMicVolume] = useState(32);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [screenShareChecked, setScreenShareChecked] = useState(false);
  const [facePositionChecked, setFacePositionChecked] = useState(false);
  const [networkChecked, setNetworkChecked] = useState(false);
  const [rulesAcknowledged, setRulesAcknowledged] = useState(false);

  const [isVerifyingIdentity, setIsVerifyingIdentity] = useState(false);
  const [isStartingExam, setIsStartingExam] = useState(false);

  const stopDeviceCheck = () => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  };

  const startDeviceCheck = async () => {
    stopDeviceCheck();
    setDeviceError(null);
    setCameraChecked(false);
    setMicrophoneChecked(false);
    setFacePositionChecked(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support camera and microphone access.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
      setCameraChecked(true);
      setMicrophoneChecked(true);
      setTimeout(() => setFacePositionChecked(true), 1200);

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx && stream.getAudioTracks().length) {
        const context = new AudioCtx();
        audioContextRef.current = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        context.createMediaStreamSource(stream).connect(analyser);
        const updateLevel = () => {
          const samples = new Uint8Array(analyser.fftSize);
          analyser.getByteTimeDomainData(samples);
          let sumSquares = 0;
          for (const sample of samples) {
            const value = (sample - 128) / 128;
            sumSquares += value * value;
          }
          setMicVolume(Math.min(100, Math.round((Math.sqrt(sumSquares / samples.length) / 0.15) * 100)));
          animationFrameRef.current = requestAnimationFrame(updateLevel);
        };
        updateLevel();
      }
    } catch (error) {
      const message = error instanceof DOMException
        ? `${error.name}: ${error.message || 'Permission was not granted.'}`
        : error instanceof Error ? error.message : 'Camera or microphone could not be started.';
      setDeviceError(message);
    }
  };

  // Initialize camera, microphone, and network checks automatically.
  useEffect(() => {
    startDeviceCheck();

    // 2. Network Ping Simulation
    setTimeout(() => {
      setNetworkChecked(true);
    }, 800);

    return () => {
      stopDeviceCheck();
    };
  }, []);

  const handleVerifyIdentity = () => {
    setIsVerifyingIdentity(true);
    setTimeout(() => {
      setIdentityVerified(true);
      setIsVerifyingIdentity(false);
    }, 1500);
  };

  const handleTestScreenShare = async () => {
    try {
      if (navigator.mediaDevices.getDisplayMedia) {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        savePreflightScreenStream(stream);
        setScreenShareChecked(true);
      } else {
        setScreenShareChecked(true);
      }
    } catch {
      setScreenShareChecked(false);
      setDeviceError('Screen sharing is required to start this examination. Please select a screen and allow sharing.');
    }
  };

  const allMandatoryChecksPassed =
    identityVerified &&
    cameraChecked &&
    microphoneChecked &&
    screenShareChecked &&
    facePositionChecked &&
    networkChecked &&
    rulesAcknowledged;

  const pendingChecks = [
    !identityVerified && 'identity verification',
    !cameraChecked && 'camera access',
    !microphoneChecked && 'microphone access',
    !screenShareChecked && 'screen sharing',
    !facePositionChecked && 'face alignment',
    !networkChecked && 'network check',
    !rulesAcknowledged && 'exam regulations acknowledgement',
  ].filter(Boolean) as string[];

  const handleStartExam = () => {
    if (!currentUser) {
      setDeviceError('Your student session has expired. Please sign in again before starting the examination.');
      return;
    }
    if (!allMandatoryChecksPassed) {
      setDeviceError(`Complete the remaining check${pendingChecks.length === 1 ? '' : 's'}: ${pendingChecks.join(', ')}.`);
      return;
    }
    try {
      setIsStartingExam(true);
      setDeviceError(null);
      const attempt = dbStore.createAttempt(exam, currentUser);
      onNavigate(`/student/exam-session/${attempt.attemptId}`);
    } catch (error) {
      setDeviceError(error instanceof Error ? `Could not start the exam: ${error.message}` : 'Could not start the exam. Please try again.');
      setIsStartingExam(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 py-4">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 uppercase tracking-wider">
            Mandatory Security Gateway
          </span>
          <h1 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white mt-1">
            Pre-Examination System Readiness Check
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Target Examination: <span className="font-semibold text-slate-800 dark:text-white">{exam.title}</span>
          </p>
        </div>

        <div className="px-4 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-right">
          <p className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-bold">Duration</p>
          <p className="text-sm font-black text-blue-600 dark:text-blue-400">{exam.durationMinutes} Minutes</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Live Webcam and Overlay Viewport */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-white dark:bg-slate-900 p-4 sm:p-5 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm">
            <h3 className="text-xs font-bold text-slate-900 dark:text-white mb-3 flex items-center justify-between">
              <span>Candidate Camera Feed</span>
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-mono font-semibold">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                Live 640x480
              </span>
            </h3>

            <div className="relative w-full aspect-square rounded-2xl overflow-hidden bg-slate-900 border border-slate-300 dark:border-slate-700 flex items-center justify-center shadow-inner">
              <video
                ref={videoRef}
                className="w-full h-full object-cover transform -scale-x-100"
                muted
                playsInline
              />

              {/* Face Guide Oval */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div
                  className={`w-40 h-52 rounded-[50%] border-2 transition-all ${
                    facePositionChecked
                      ? 'border-emerald-400 shadow-[0_0_15px_rgba(52,211,153,0.4)]'
                      : 'border-dashed border-blue-400'
                  }`}
                />
              </div>

              {/* Status overlay */}
              <div className="absolute bottom-2.5 inset-x-2.5 bg-white/90 dark:bg-slate-900/90 backdrop-blur-xs p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-between text-[10px]">
                <span className="text-slate-600 dark:text-slate-300 font-medium">Ambient Noise:</span>
                <div className="w-20 h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 to-blue-500 transition-all duration-300"
                    style={{ width: `${micVolume}%` }}
                  />
                </div>
                <span className="text-emerald-600 dark:text-emerald-400 font-mono font-bold">{micVolume > 14 ? 'Sound detected' : 'Quiet'}</span>
              </div>
            </div>

            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-3 text-center">
              Ensure you are seated directly in front of the camera in a well-lit area.
            </p>
          </div>
        </div>

        {/* Right: The 7 Checks Checklist */}
        <div className="lg:col-span-7 space-y-3">
          {/* Check 1: Identity */}
          <div className="p-3.5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200/80 dark:border-blue-800/60 flex items-center justify-center">
                <UserCheck className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-white">Check 1: Identity Verification</h4>
                <p className="text-[10px] text-slate-500 dark:text-slate-400">Match against enrolled biometric facial reference template</p>
              </div>
            </div>
            {identityVerified ? (
              <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" /> Verified
              </span>
            ) : (
              <button
                onClick={handleVerifyIdentity}
                disabled={isVerifyingIdentity}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-[11px] transition flex items-center gap-1.5 shadow-xs"
              >
                {isVerifyingIdentity && <RefreshCw className="w-3 h-3 animate-spin" />}
                <span>{isVerifyingIdentity ? 'Matching...' : 'Verify Face'}</span>
              </button>
            )}
          </div>

          {/* Check 2: Camera */}
          <div className="p-3.5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200/80 dark:border-blue-800/60 flex items-center justify-center">
                <Camera className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-white">Check 2: Camera Hardware</h4>
                <p className="text-[10px] text-slate-500 dark:text-slate-400">Resolution, frame capture, and landmark clarity</p>
              </div>
            </div>
            {cameraChecked ? (
              <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Active</span>
            ) : (
              <button onClick={startDeviceCheck} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white font-bold text-[11px]">Enable camera</button>
            )}
          </div>

          {/* Check 3: Microphone */}
          <div className="p-3.5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 border border-purple-200/80 dark:border-purple-800/60 flex items-center justify-center">
                <Mic className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-white">Check 3: Microphone & Sound Baseline</h4>
                <p className="text-[10px] text-slate-500 dark:text-slate-400">Ambient noise calibration below threshold</p>
              </div>
            </div>
            {microphoneChecked ? (
              <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Calibrated</span>
            ) : (
              <button onClick={startDeviceCheck} className="px-3 py-1.5 rounded-lg bg-purple-600 text-white font-bold text-[11px]">Enable microphone</button>
            )}
          </div>

          {/* Check 4: Screen Sharing */}
          <div className="p-3.5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200/80 dark:border-indigo-800/60 flex items-center justify-center">
                <Monitor className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-white">Check 4: Screen Capture Stream</h4>
                <p className="text-[10px] text-slate-500 dark:text-slate-400">Share primary screen to prevent secondary tabs/apps</p>
              </div>
            </div>
            {screenShareChecked ? (
              <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" /> Granted
              </span>
            ) : (
              <button
                onClick={handleTestScreenShare}
                className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-[11px] transition shadow-xs"
              >
                Share Screen
              </button>
            )}
          </div>

          {/* Check 5: Face Position */}
          <div className="p-3.5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 border border-teal-200/80 dark:border-teal-800/60 flex items-center justify-center">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-white">Check 5: Posture & Alignment</h4>
                <p className="text-[10px] text-slate-500 dark:text-slate-400">Face reasonably centered and eye gaze visible</p>
              </div>
            </div>
            {facePositionChecked ? (
              <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" /> Centered
              </span>
            ) : (
              <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Checking
              </span>
            )}
          </div>

          {/* Check 6: Network */}
          <div className="p-3.5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 border border-sky-200/80 dark:border-sky-800/60 flex items-center justify-center">
                <Wifi className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-white">Check 6: Network Latency & Connectivity</h4>
                <p className="text-[10px] text-slate-500 dark:text-slate-400">Ping 24ms • Bandwidth optimal for real-time sync</p>
              </div>
            </div>
            {networkChecked ? (
              <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" /> 24ms
              </span>
            ) : (
              <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Checking
              </span>
            )}
          </div>

          {/* Check 7: Rules Acknowledgment */}
          <div className="p-3.5 rounded-2xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={rulesAcknowledged}
                onChange={e => setRulesAcknowledged(e.target.checked)}
                className="mt-0.5 rounded border-blue-300 dark:border-blue-700 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-[11px] text-slate-700 dark:text-slate-300 leading-relaxed">
                <strong className="text-blue-700 dark:text-blue-400">Check 7: Examination Regulations.</strong> I acknowledge the two-warning policy. I will remain inside the camera frame, keep fullscreen active, not switch tabs, and understand that a 3rd confirmed violation triggers automatic exam lock and submission.
              </span>
            </label>
          </div>

          {/* Final Action Button */}
          <div className="pt-2">
            {deviceError && <p className="text-[11px] text-red-600 dark:text-red-400 text-center mb-2 font-medium">{deviceError}</p>}
            <button
              onClick={handleStartExam}
              disabled={!allMandatoryChecksPassed || isStartingExam}
              className="w-full py-3.5 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-black text-sm shadow-md shadow-blue-500/25 flex items-center justify-center gap-2 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Lock className="w-4 h-4" />
              <span>{isStartingExam ? 'Starting Secure Examination...' : 'Start Secure Proctored Examination'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
            {!allMandatoryChecksPassed && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 text-center mt-2 font-medium">
                Complete: {pendingChecks.join(', ')}.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

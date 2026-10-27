import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  ConfirmationResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore';
import firebaseConfigData from '../../firebase-applet-config.json' with { type: 'json' };

export const firebaseConfig = firebaseConfigData;

// Initialize Firebase App
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Firebase Auth
export const auth = getAuth(app);

// Initialize Firestore
const customDatabaseId = (firebaseConfig as any).firestoreDatabaseId;
export const db = customDatabaseId && customDatabaseId !== '(default)'
  ? getFirestore(app, customDatabaseId)
  : getFirestore(app);

export const isFirebaseConfigured = (): boolean => {
  return !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);
};

// Create a reCAPTCHA verifier for Firebase Phone Authentication
export function createRecaptchaVerifier(
  container: HTMLElement | string,
  onSuccess?: () => void,
  onExpired?: () => void
): RecaptchaVerifier {
  // Clear any existing recaptcha instance if necessary
  return new RecaptchaVerifier(auth, container, {
    size: 'normal',
    callback: () => {
      console.log('reCAPTCHA verified for Phone Auth');
      if (onSuccess) onSuccess();
    },
    'expired-callback': () => {
      console.warn('reCAPTCHA token expired');
      if (onExpired) onExpired();
    },
  });
}

// Send Phone SMS OTP via Firebase
export async function sendFirebasePhoneOtp(
  phoneNumberE164: string,
  verifier: RecaptchaVerifier
): Promise<ConfirmationResult> {
  try {
    const confirmationResult = await signInWithPhoneNumber(auth, phoneNumberE164, verifier);
    return confirmationResult;
  } catch (error: any) {
    console.error('Firebase Phone Auth send error:', error);
    throw error;
  }
}

// Firestore operations for user profiles & exams
export async function syncUserToFirestore(userData: any): Promise<void> {
  if (!isFirebaseConfigured()) return;
  try {
    // Use Firebase UID when the profile belongs to the authenticated account.
    // This makes subsequent profile updates satisfy the owner rule.
    const profileId = auth.currentUser?.email?.toLowerCase() === userData.email?.toLowerCase()
      ? auth.currentUser?.uid || userData.userId || userData.email
      : userData.userId || userData.email;
    const userRef = doc(db, 'users', profileId);
    await setDoc(userRef, {
      ...userData,
      updatedAt: new Date().toISOString(),
      timestamp: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.warn('Firestore user sync error (non-fatal, local fallback active):', err);
  }
}

export async function fetchUserFromFirestore(userIdOrEmail: string): Promise<any | null> {
  if (!isFirebaseConfigured()) return null;
  try {
    const userRef = doc(db, 'users', userIdOrEmail);
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      return snap.data();
    }
    // User profiles are stored by portal user ID, while authentication starts
    // with an email address. Fall back to an indexed email lookup.
    const users = await getDocs(query(collection(db, 'users'), where('email', '==', userIdOrEmail.toLowerCase())));
    if (!users.empty) return users.docs[0].data();
    return null;
  } catch (err) {
    console.warn('Firestore user fetch error:', err);
    return null;
  }
}

export async function syncExamToFirestore(exam: any): Promise<void> {
  if (!isFirebaseConfigured()) return;
  try {
    const examRef = doc(db, 'exams', exam.examId);
    await setDoc(examRef, {
      ...exam,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (err) {
    console.warn('Firestore exam sync error:', err);
  }
}

export async function syncAttemptToFirestore(attempt: any): Promise<void> {
  if (!isFirebaseConfigured()) return;
  try {
    const attemptRef = doc(db, 'attempts', attempt.attemptId);
    await setDoc(attemptRef, {
      ...attempt,
      // Firestore rules can now match the Firebase-authenticated owner while
      // preserving the portal's studentId for reporting.
      userId: auth.currentUser?.uid || attempt.studentId,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (err) {
    console.warn('Firestore attempt sync error:', err);
  }
}

export async function logAuditToFirestore(auditEntry: any): Promise<void> {
  if (!isFirebaseConfigured()) return;
  try {
    const logRef = doc(db, 'auditLogs', auditEntry.id || `audit_${Date.now()}`);
    await setDoc(logRef, {
      ...auditEntry,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('Firestore audit sync error:', err);
  }
}

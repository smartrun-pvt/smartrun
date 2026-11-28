import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  ConfirmationResult,
  signOut as firebaseSignOut,
  User as FirebaseUser
} from 'firebase/auth';
import { supabase } from '../lib/supabaseClient';
import { UserProfile } from '../types';
import {
  getUserScopeKeyFromUser,
  setActiveUserScope,
  getSavedUserProfile,
  saveUserProfile,
  fetchUserProfileFromSupabase,
  cleanPhoneAutofill,
  safeGetItem,
  safeSetItem
} from './supabaseService';
import firebaseConfig from '../../firebase-applet-config.json';
import { apiUrl } from '../lib/apiBase';
import { Capacitor } from '@capacitor/core';
import { sanitizeCustomerName } from '../utils/nameHelper';
import {
  PRODUCTION_FIREBASE_AUTH_DOMAIN,
  resolveFirebaseAuthDomainForEnv,
  shouldAllowFallbackFirebaseAuthDomain,
  buildRecaptchaSlotId,
  isRecaptchaAlreadyRenderedError,
  normalizeNativeFirebaseAuthError,
  parseIndianMobileNumber,
  isExpiredOtpErrorCode,
  isRateLimitErrorCode,
  RATE_LIMIT_ERROR_MESSAGE,
  OTP_TIMEOUT_HINT,
  DEFAULT_INVISIBLE_RECAPTCHA_CONTAINER_ID,
  DEFAULT_VISIBLE_RECAPTCHA_CONTAINER_ID,
  resolveRecaptchaContainerId,
  type RecaptchaDisplayMode,
  type RecaptchaWidgetStatus
} from '../utils/firebaseAuthDomain';
import {
  getNativePendingPhoneVerification,
  clearNativePendingPhoneVerification
} from '../utils/otpAutofill';
import { getAuthHeaders, setServerAuthToken } from './serverAuthService';

export { sanitizeCustomerName };

function resolveFirebaseAuthDomain(): string {
  const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : ((process as any)?.env || {});
  return resolveFirebaseAuthDomainForEnv({
    configuredDomain: String(env.VITE_FIREBASE_AUTH_DOMAIN || '').trim(),
    isNativePlatform: Capacitor.isNativePlatform(),
    windowHostname: typeof window !== 'undefined' ? window.location.hostname : '',
    fallbackAuthDomain: firebaseConfig.authDomain,
  });
}

const resolvedFirebaseConfig = {
  ...firebaseConfig,
  authDomain: resolveFirebaseAuthDomain(),
};

// Initialize Firebase App singleton
export const firebaseApp = !getApps().length ? initializeApp(resolvedFirebaseConfig) : getApp();
export const firebaseAuth = getAuth(firebaseApp);

// Lazy fallback Firebase Auth bound to default project authDomain in case custom domain
// (smartrun.in / www.smartrun.in) is temporarily blocked by Firebase Authorized Domains.
let fallbackFirebaseAuth: ReturnType<typeof getAuth> | null = null;
function getFallbackFirebaseAuth(): ReturnType<typeof getAuth> {
  if (fallbackFirebaseAuth) return fallbackFirebaseAuth;
  const fallbackName = 'smartrun-firebase-fallback';
  const existing = getApps().find((a) => a.name === fallbackName);
  const app = existing || initializeApp(firebaseConfig, fallbackName);
  fallbackFirebaseAuth = getAuth(app);
  return fallbackFirebaseAuth;
}

// Global reference to active ConfirmationResult for multi-step verification
let activeConfirmationResult: ConfirmationResult | null = null;
let activeRecaptchaVerifier: RecaptchaVerifier | null = null;
let activeRecaptchaAuthInstance: ReturnType<typeof getAuth> | null = null;
let activeRecaptchaRenderPromise: Promise<number> | null = null;
let activeRecaptchaConsumed = false;
let activeRecaptchaHostId = DEFAULT_INVISIBLE_RECAPTCHA_CONTAINER_ID;
let activeRecaptchaSize: 'invisible' | 'normal' = 'invisible';
let activeRecaptchaVerified = false;
let recaptchaSlotSeq = 0;
let recaptchaRenderSeq = 0;
let activeSendRequestSeq = 0;
let lastSentPhoneNumber: string | null = null;
let activeNativeVerificationId: string | null = null;
let activeNativeCompletedSub: { remove?: () => Promise<void> | void } | null = null;
let activeNativeCodeSentSub: { remove?: () => Promise<void> | void } | null = null;
let activeNativeFailedSub: { remove?: () => Promise<void> | void } | null = null;
let activeNativeCompletedTimeoutId: ReturnType<typeof setTimeout> | null = null;

function clearNativePhoneListeners(): void {
  if (activeNativeCompletedTimeoutId) {
    clearTimeout(activeNativeCompletedTimeoutId);
    activeNativeCompletedTimeoutId = null;
  }
  try {
    activeNativeCompletedSub?.remove?.();
  } catch {}
  try {
    activeNativeCodeSentSub?.remove?.();
  } catch {}
  try {
    activeNativeFailedSub?.remove?.();
  } catch {}
  activeNativeCompletedSub = null;
  activeNativeCodeSentSub = null;
  activeNativeFailedSub = null;
}

const PENDING_PHONE_OTP_STORAGE_KEY = 'smartrun_pending_phone_otp_v1';
const PENDING_PHONE_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface PendingPhoneOtpSession {
  phone: string; // E.164 (+91XXXXXXXXXX)
  provider: 'firebase';
  purpose?: 'login' | 'profile_update';
  verificationId?: string;
  createdAt: number;
}

export function savePendingPhoneOtpSession(session: PendingPhoneOtpSession): void {
  try {
    if (typeof window === 'undefined' || !session?.phone) return;
    localStorage.setItem(PENDING_PHONE_OTP_STORAGE_KEY, JSON.stringify(session));
  } catch {}
}

export function clearPendingPhoneOtpSession(): void {
  activeNativeVerificationId = null;
  try {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(PENDING_PHONE_OTP_STORAGE_KEY);
    }
  } catch {}
  clearNativePendingPhoneVerification();
}

export function getPendingPhoneOtpSession(): PendingPhoneOtpSession | null {
  // 1. Check native Android SharedPreferences first (survives WebView / Activity destruction during RecaptchaActivity)
  const nativePending = getNativePendingPhoneVerification();
  if (nativePending?.verificationId) {
    const formatted = nativePending.phone ? formatToE164Phone(nativePending.phone) : '';
    const session: PendingPhoneOtpSession = {
      phone: formatted,
      provider: 'firebase',
      verificationId: nativePending.verificationId,
      createdAt: nativePending.timestamp
    };
    activeNativeVerificationId = nativePending.verificationId;
    if (formatted) {
      lastSentPhoneNumber = formatted;
    }
    return session;
  }

  // 2. Fallback to localStorage (survives page reload / WebView refresh for Firebase sessions)
  try {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem(PENDING_PHONE_OTP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingPhoneOtpSession;
    if (!parsed || !parsed.phone || !parsed.createdAt) {
      localStorage.removeItem(PENDING_PHONE_OTP_STORAGE_KEY);
      return null;
    }
    if (Date.now() - Number(parsed.createdAt) > PENDING_PHONE_OTP_TTL_MS) {
      localStorage.removeItem(PENDING_PHONE_OTP_STORAGE_KEY);
      return null;
    }
    if (parsed.provider === 'firebase' && parsed.verificationId) {
      activeNativeVerificationId = parsed.verificationId;
      lastSentPhoneNumber = formatToE164Phone(parsed.phone);
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format any Indian phone number into strict E.164 (+91XXXXXXXXXX)
 */
export function formatToE164Phone(rawPhone: string): string {
  const digits = (rawPhone || '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return `+91${digits.slice(1)}`;
  }
  return `+91${digits.slice(-10)}`;
}


/**
 * Detailed diagnostic breakdown for Firebase Phone Auth errors
 */
export interface FirebaseDiagnostic {
  code: string;
  userMessage: string;
  technicalCause: string;
  resolution: string;
}

export function formatFirebasePhoneError(err: any): FirebaseDiagnostic {
  const normalized = normalizeNativeFirebaseAuthError(err);
  const code = normalized.code;
  const rawMsg = normalized.message;
  const currentHost =
    Capacitor.isNativePlatform()
      ? PRODUCTION_FIREBASE_AUTH_DOMAIN
      : (typeof window !== 'undefined' ? window.location.hostname : PRODUCTION_FIREBASE_AUTH_DOMAIN);

  // Check specifically for Hostname match not found
  if (rawMsg.toLowerCase().includes('hostname match not found')) {
    const isLocal = currentHost === 'localhost' || currentHost === '127.0.0.1';
    return {
      code: 'auth/unauthorized-domain',
      userMessage: isLocal
        ? `Firebase Web reCAPTCHA does not authorize "${currentHost}". On Android, native Play Integrity verification is used; on web, please sign in via https://www.smartrun.in.`
        : `Firebase Error: Hostname match not found for "${currentHost}".`,
      technicalCause: `The current domain "${currentHost}" is not added in Firebase Authorized Domains.`,
      resolution: `Go to Firebase Console -> Authentication -> Settings tab -> Authorized domains, and click "Add domain" to add "${currentHost}".`
    };
  }

  switch (code) {
    case 'auth/unauthorized-domain':
      return {
        code,
        userMessage: `Firebase Error (auth/unauthorized-domain): The domain "${currentHost}" is not added in Firebase Authorized Domains.`,
        technicalCause: 'Google reCAPTCHA verification blocked this origin.',
        resolution: `Go to Firebase Console -> Authentication -> Settings -> Authorized domains -> Click "Add domain" and add: "${currentHost}".`
      };

    case 'auth/operation-not-allowed':
      return {
        code,
        userMessage: 'Firebase Error (auth/operation-not-allowed): Phone sign-in provider or SMS region is disabled in Firebase Console.',
        technicalCause: 'The Phone sign-in method or India (+91) SMS region is not enabled.',
        resolution: 'Go to Firebase Console -> Authentication -> Sign-in method -> Phone -> Enable Phone & allow India (+91).'
      };

    case 'auth/missing-client-identifier':
      return {
        code,
        userMessage:
          'Unable to verify Android app identity with Firebase (Play Integrity & reCAPTCHA check failed). For sideloaded APKs, ensure Chrome is enabled, upload keystore SHA-1 & SHA-256 are registered in Firebase Console with a fresh google-services.json, or install via Play Internal Testing.',
        technicalCause:
          rawMsg || 'Play Integrity verification failed (expected on sideloaded APKs outside Google Play) and the Chrome Custom Tab reCAPTCHA fallback did not complete.',
        resolution:
          '1. Register your exact signing keystore SHA-1 & SHA-256 in Firebase Console -> Project Settings -> Android app (in.smartrun.app) and download a fresh google-services.json.\n2. Ensure Chrome Custom Tabs are enabled and /__/auth/* is not intercepted by App Links.\n3. For silent Play Integrity verification, install via Google Play Internal Testing.'
      };

    case 'auth/invalid-app-credential':
    case 'auth/app-not-authorized':
      return {
        code,
        userMessage: `Firebase Error (${code}): App credentials or reCAPTCHA check failed for "${currentHost}".`,
        technicalCause: 'reCAPTCHA token or Android Play Integrity / SHA-256 certificate is missing or invalid.',
        resolution: `1. Ensure "${currentHost}" is in Firebase Authorized Domains.\n2. On Android, add your debug & release SHA-1 and SHA-256 fingerprints in Firebase Project Settings -> Your Apps (in.smartrun.app).`
      };

    case 'auth/captcha-check-failed':
      return {
        code,
        userMessage: `Firebase Error (auth/captcha-check-failed): reCAPTCHA check failed for "${currentHost}".`,
        technicalCause: 'The reCAPTCHA challenge was cancelled, timed out, or the domain is not authorized.',
        resolution: `Ensure "${currentHost}" is listed in Firebase Console -> Authentication -> Settings -> Authorized domains and retry.`
      };

    case 'auth/invalid-verification-code':
      return {
        code,
        userMessage: 'Invalid 6-digit verification code. Please check and try again.',
        technicalCause: 'The entered OTP did not match the Firebase verification session.',
        resolution: 'Re-enter the 6-digit OTP from the latest SMS.'
      };

    case 'auth/code-expired':
    case 'auth/session-expired':
      return {
        code,
        userMessage: 'Verification code has expired. Please request a new OTP code.',
        technicalCause: 'The Firebase verification session timed out before confirmation.',
        resolution: 'Tap Resend OTP to receive a fresh 6-digit code.'
      };

    case 'auth/network-request-failed':
      return {
        code,
        userMessage: 'Network error while contacting verification service. Please check your internet connection and try again.',
        technicalCause: 'Device could not reach Firebase Auth or https://www.smartrun.in.',
        resolution: 'Check mobile data / Wi-Fi connectivity and retry.'
      };

    case 'auth/quota-exceeded':
      return {
        code,
        userMessage: RATE_LIMIT_ERROR_MESSAGE,
        technicalCause: 'Identity Platform SMS quota limit reached for the current billing cycle.',
        resolution: 'In Google Cloud Console -> Identity Platform -> Settings -> Quotas, check daily SMS quota. Or add Test Phone Numbers in Firebase Console.'
      };

    case 'auth/too-many-requests':
      return {
        code,
        userMessage: RATE_LIMIT_ERROR_MESSAGE,
        technicalCause:
          rawMsg || 'Firebase anti-abuse rate limit was triggered for this device or phone number (failed Play Integrity / reCAPTCHA attempts also count toward this block even if no SMS was sent).',
        resolution:
          'Wait 15-30 minutes before retrying this number/device, or sign in with Google.'
      };

    case 'auth/invalid-phone-number':
      return {
        code,
        userMessage: 'Please enter a valid 10-digit mobile number.',
        technicalCause: 'Phone number did not match standard 10-digit format.',
        resolution: 'Enter 10 numeric digits (e.g. 9876543210).'
      };

    case 'auth/missing-phone-number':
      return {
        code,
        userMessage: 'Please enter your 10-digit mobile number.',
        technicalCause: 'Empty phone number supplied.',
        resolution: 'Enter your 10-digit mobile number.'
      };

    default: {
      if (rawMsg.toLowerCase().includes('sms region') || rawMsg.toLowerCase().includes('blocked') || rawMsg.toLowerCase().includes('region')) {
        return {
          code: code || 'auth/sms-region-blocked',
          userMessage: 'Firebase Error: India (+91) SMS delivery is restricted by Firebase SMS Region Policy.',
          technicalCause: 'India (+91) is not in the allowed regions list in Firebase Console.',
          resolution: 'Go to Firebase Console -> Authentication -> Settings -> SMS Region Policy -> Allow India (+91).'
        };
      }
      return {
        code: code || 'auth/unknown',
        userMessage: rawMsg ? `Firebase Phone Auth: ${rawMsg}` : 'Failed to dispatch SMS verification code.',
        technicalCause: rawMsg,
        resolution: 'Check Firebase Console Authentication logs for more details.'
      };
    }
  }
}

/**
 * Clears and resets reCAPTCHA instance and removes any rendered child slot nodes
 * so Google reCAPTCHA never encounters a previously rendered DOM element.
 */
export function resetRecaptchaVerifier(containerId?: string): void {
  const targetHostId = containerId || activeRecaptchaHostId;
  const prevVerifier = activeRecaptchaVerifier;
  activeRecaptchaVerifier = null;
  activeRecaptchaAuthInstance = null;
  activeRecaptchaRenderPromise = null;
  activeRecaptchaConsumed = false;
  activeRecaptchaSize = 'invisible';
  activeRecaptchaVerified = false;
  recaptchaRenderSeq += 1;

  try {
    if (prevVerifier) {
      prevVerifier.clear();
    }
  } catch (err) {
    console.debug('[Firebase Auth] Error clearing recaptcha verifier:', err);
  }

  if (typeof window !== 'undefined') {
    try {
      const hostIdsToClear = new Set<string>([targetHostId]);
      if (!containerId) {
        hostIdsToClear.add(DEFAULT_INVISIBLE_RECAPTCHA_CONTAINER_ID);
        hostIdsToClear.add(DEFAULT_VISIBLE_RECAPTCHA_CONTAINER_ID);
      }
      hostIdsToClear.forEach((id) => {
        const container = document.getElementById(id);
        if (container) {
          container.replaceChildren();
          if (id === DEFAULT_INVISIBLE_RECAPTCHA_CONTAINER_ID) {
            container.style.display = 'block';
            container.style.visibility = 'visible';
          }
        }
      });
      // Soft-hide any lingering reCAPTCHA challenge wrapper overlays without mutating
      // display or pointerEvents, which Google reCAPTCHA's reused bframe overlay does
      // not restore on subsequent challenges.
      const recaptchaFrames = document.querySelectorAll('iframe[src*="recaptcha"], iframe[title*="recaptcha" i]');
      recaptchaFrames.forEach((frame) => {
        const wrapper = frame.closest('div[style*="z-index"]') as HTMLElement | null;
        if (wrapper && wrapper.parentElement === document.body) {
          wrapper.style.visibility = 'hidden';
          wrapper.style.opacity = '0';
        }
      });
    } catch {}
  }
}

/**
 * Allocates a brand-new virgin child <div> slot inside the host container so
 * grecaptcha.render() NEVER sees a previously rendered DOM node.
 * Supports both hidden ('invisible') and inline visible ('normal') containers.
 */
function createFreshRecaptchaSlot(
  containerId: string,
  size: 'invisible' | 'normal' = 'invisible'
): HTMLDivElement {
  activeRecaptchaHostId = containerId;
  let hostEl = document.getElementById(containerId);
  if (!hostEl) {
    hostEl = document.createElement('div');
    hostEl.id = containerId;
    document.body.appendChild(hostEl);
  }
  hostEl.replaceChildren();

  if (size === 'normal') {
    hostEl.style.position = 'relative';
    hostEl.style.bottom = 'auto';
    hostEl.style.right = 'auto';
    hostEl.style.width = '100%';
    hostEl.style.height = 'auto';
    hostEl.style.overflow = 'visible';
    hostEl.style.opacity = '1';
    hostEl.style.pointerEvents = 'auto';
    hostEl.style.zIndex = '1';
    hostEl.style.display = 'flex';
    hostEl.style.justifyContent = 'center';
    hostEl.style.alignItems = 'center';
    hostEl.style.visibility = 'visible';
  } else {
    hostEl.style.position = 'fixed';
    hostEl.style.bottom = '0';
    hostEl.style.right = '0';
    hostEl.style.width = '0';
    hostEl.style.height = '0';
    hostEl.style.overflow = 'hidden';
    hostEl.style.opacity = '0';
    hostEl.style.pointerEvents = 'none';
    hostEl.style.zIndex = '-1';
    hostEl.style.display = 'block';
    hostEl.style.visibility = 'visible';
  }

  const slotEl = document.createElement('div');
  slotEl.id = buildRecaptchaSlotId(containerId, ++recaptchaSlotSeq);
  slotEl.dataset.recaptchaSlot = 'true';
  slotEl.dataset.recaptchaSize = size;
  hostEl.appendChild(slotEl);
  return slotEl;
}

export interface RecaptchaVerifierOptions {
  size?: 'invisible' | 'normal';
  onVerified?: (token: string) => void;
  onExpired?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * Prepares the RecaptchaVerifier on a fresh virgin child DOM slot (invisible or visible normal box).
 * Never reuses a consumed or previously rendered DOM node, eliminating
 * "reCAPTCHA has already been rendered in this element".
 */
export function getOrCreateRecaptchaVerifier(
  containerId = DEFAULT_INVISIBLE_RECAPTCHA_CONTAINER_ID,
  authInstance: ReturnType<typeof getAuth> = firebaseAuth,
  forceFresh = false,
  options?: RecaptchaVerifierOptions
): RecaptchaVerifier {
  if (typeof window === 'undefined') {
    throw new Error('RecaptchaVerifier requires a browser window environment.');
  }

  const requestedSize: 'invisible' | 'normal' = options?.size || 'invisible';

  if (
    !forceFresh &&
    activeRecaptchaVerifier &&
    !activeRecaptchaConsumed &&
    activeRecaptchaAuthInstance === authInstance &&
    activeRecaptchaHostId === containerId &&
    activeRecaptchaSize === requestedSize
  ) {
    const hostEl = document.getElementById(containerId);
    if (hostEl && hostEl.querySelector('[data-recaptcha-slot="true"]')) {
      return activeRecaptchaVerifier;
    }
  }

  resetRecaptchaVerifier(containerId);
  const slotEl = createFreshRecaptchaSlot(containerId, requestedSize);

  activeRecaptchaAuthInstance = authInstance;
  activeRecaptchaConsumed = false;
  activeRecaptchaSize = requestedSize;
  activeRecaptchaVerified = false;

  const verifier = new RecaptchaVerifier(authInstance, slotEl, {
    size: requestedSize,
    callback: (token: string) => {
      if (activeRecaptchaVerifier !== verifier) return;
      activeRecaptchaVerified = true;
      console.log(`[Firebase Auth] ${requestedSize === 'normal' ? 'Visible' : 'Invisible'} reCAPTCHA verification passed`);
      try {
        options?.onVerified?.(token);
      } catch {}
    },
    'expired-callback': () => {
      if (activeRecaptchaVerifier !== verifier) return;
      activeRecaptchaVerified = false;
      console.warn(`[Firebase Auth] ${requestedSize === 'normal' ? 'Visible' : 'Invisible'} reCAPTCHA expired`);
      try {
        options?.onExpired?.();
      } catch {}
      if (requestedSize === 'invisible') {
        resetRecaptchaVerifier(containerId);
      }
    },
    'error-callback': (err: unknown) => {
      if (activeRecaptchaVerifier !== verifier) return;
      activeRecaptchaVerified = false;
      console.warn(`[Firebase Auth] ${requestedSize === 'normal' ? 'Visible' : 'Invisible'} reCAPTCHA widget error:`, err);
      try {
        options?.onError?.(err);
      } catch {}
    }
  });

  activeRecaptchaVerifier = verifier;
  return verifier;
}

/**
 * Returns true if the inline visible Firebase reCAPTCHA box has been solved and is ready to be consumed.
 */
export function isVisibleRecaptchaVerified(
  containerId = DEFAULT_VISIBLE_RECAPTCHA_CONTAINER_ID
): boolean {
  return Boolean(
    activeRecaptchaVerifier &&
      !activeRecaptchaConsumed &&
      activeRecaptchaSize === 'normal' &&
      activeRecaptchaHostId === containerId &&
      activeRecaptchaVerified
  );
}

/**
 * Renders the visible inline Firebase reCAPTCHA ("I'm not a robot") box inside the login card
 * while keeping the hidden invisible container intact for instant toggling between modes.
 */
export async function renderVisibleRecaptchaVerifier(
  containerId = DEFAULT_VISIBLE_RECAPTCHA_CONTAINER_ID,
  callbacks?: {
    onStatusChange?: (status: RecaptchaWidgetStatus, errorMessage?: string) => void;
    onVerified?: (token: string) => void;
    onExpired?: () => void;
  }
): Promise<{ rendered: boolean; error?: string }> {
  if (typeof window === 'undefined' || Capacitor.isNativePlatform()) {
    return { rendered: false };
  }

  const hostEl = document.getElementById(containerId);
  if (!hostEl) {
    callbacks?.onStatusChange?.('error', 'Captcha container is not mounted yet.');
    return { rendered: false, error: 'Captcha container is not mounted yet.' };
  }

  callbacks?.onStatusChange?.('loading');

  const tryRenderWithAuth = async (authInstance: ReturnType<typeof getAuth>) => {
    const verifier = getOrCreateRecaptchaVerifier(containerId, authInstance, true, {
      size: 'normal',
      onVerified: (token) => {
        if (activeRecaptchaVerifier !== verifier) return;
        callbacks?.onStatusChange?.('verified');
        callbacks?.onVerified?.(token);
      },
      onExpired: () => {
        if (activeRecaptchaVerifier !== verifier) return;
        callbacks?.onStatusChange?.('expired', 'Captcha expired. Please verify again.');
        callbacks?.onExpired?.();
      },
      onError: () => {
        if (activeRecaptchaVerifier !== verifier) return;
        callbacks?.onStatusChange?.('error', 'Unable to verify captcha. Please reload and try again.');
      }
    });
    const seq = recaptchaRenderSeq;

    const renderPromise = verifier.render();
    activeRecaptchaRenderPromise = renderPromise;
    await renderPromise;

    if (activeRecaptchaRenderPromise === renderPromise) {
      activeRecaptchaRenderPromise = null;
    }
    if (seq !== recaptchaRenderSeq || activeRecaptchaVerifier !== verifier) {
      return { rendered: false };
    }

    callbacks?.onStatusChange?.(activeRecaptchaVerified ? 'verified' : 'ready');
    return { rendered: true };
  };

  try {
    return await tryRenderWithAuth(firebaseAuth);
  } catch (primaryErr: unknown) {
    const canFallback = shouldAllowFallbackFirebaseAuthDomain({
      isNativePlatform: Capacitor.isNativePlatform(),
      windowHostname: typeof window !== 'undefined' ? window.location.hostname : '',
    });

    if (canFallback && resolvedFirebaseConfig.authDomain !== firebaseConfig.authDomain) {
      try {
        return await tryRenderWithAuth(getFallbackFirebaseAuth());
      } catch (fallbackErr: unknown) {
        const diag = formatFirebasePhoneError(fallbackErr);
        callbacks?.onStatusChange?.('error', diag.userMessage || 'Unable to load Firebase captcha.');
        return { rendered: false, error: diag.userMessage };
      }
    }

    const diag = formatFirebasePhoneError(primaryErr);
    callbacks?.onStatusChange?.('error', diag.userMessage || 'Unable to load Firebase captcha.');
    return { rendered: false, error: diag.userMessage };
  }
}

/**
 * Pre-warms invisible reCAPTCHA on Web browsers while the user types their mobile number,
 * shaving 2-5 seconds off OTP send latency on mobile networks. No-op on native APK or when
 * the visible captcha box is currently active.
 * Serialized via activeRecaptchaRenderPromise so clicking "Get OTP" never races render().
 */
export function prewarmRecaptchaVerifier(
  containerId = DEFAULT_INVISIBLE_RECAPTCHA_CONTAINER_ID
): void {
  if (typeof window === 'undefined' || Capacitor.isNativePlatform()) return;
  try {
    if (activeRecaptchaRenderPromise) return;
    if (activeRecaptchaVerifier && !activeRecaptchaConsumed && activeRecaptchaSize === 'normal') {
      return;
    }
    if (
      activeRecaptchaVerifier &&
      !activeRecaptchaConsumed &&
      activeRecaptchaSize === 'invisible' &&
      activeRecaptchaAuthInstance === firebaseAuth
    ) {
      return;
    }
    const verifier = getOrCreateRecaptchaVerifier(containerId, firebaseAuth, true, {
      size: 'invisible'
    });
    const renderPromise = verifier
      .render()
      .catch(() => {
        if (activeRecaptchaVerifier === verifier) {
          resetRecaptchaVerifier(containerId);
        }
        return -1;
      })
      .finally(() => {
        if (activeRecaptchaRenderPromise === renderPromise) {
          activeRecaptchaRenderPromise = null;
        }
      });
    activeRecaptchaRenderPromise = renderPromise;
  } catch {}
}

export interface SendFirebaseOtpResult {
  success: boolean;
  formattedPhone?: string;
  provider?: 'firebase';
  autoVerified?: boolean;
  error?: string;
  isBillingRequired?: boolean;
  isRateLimited?: boolean;
  message?: string;
  diagnostic?: FirebaseDiagnostic;
}

export interface SendFirebaseOtpCallbacks {
  purpose?: 'login' | 'profile_update';
  recaptchaMode?: RecaptchaDisplayMode;
  onAutoFillOtp?: (code: string) => void;
  onNativeVerificationCompleted?: (result: VerifyFirebaseOtpResult) => void;
}

/**
 * Extracts a Firebase ID token from either a Web SDK FirebaseUser or native Capacitor Firebase Auth.
 */
async function resolveFirebaseIdToken(firebaseUser?: FirebaseUser): Promise<string | undefined> {
  try {
    if (firebaseUser && typeof (firebaseUser as any).getIdToken === 'function') {
      const token = await firebaseUser.getIdToken();
      if (token) return token;
    }
  } catch {}
  try {
    if (Capacitor.isNativePlatform()) {
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      const res = await FirebaseAuthentication.getIdToken();
      if (res?.token) return res.token;
    }
  } catch {}
  return undefined;
}

/**
 * Sends phone OTP via official Google Firebase Phone Auth SDK only.
 * On native Android / iOS devices, utilizes native Play Integrity, Instant Verification,
 * and Google Play Services SMS Auto-Retrieval without web reCAPTCHA or localhost origin restrictions.
 * On Web, utilizes Firebase Web SDK with invisible reCAPTCHA first (escalating to visible reCAPTCHA on failure).
 */
export async function sendFirebasePhoneOtp(
  rawPhone: string,
  containerId = 'recaptcha-container',
  callbacks?: SendFirebaseOtpCallbacks
): Promise<SendFirebaseOtpResult> {
  const parsedPhone = parseIndianMobileNumber(rawPhone);
  if (!parsedPhone.valid) {
    return {
      success: false,
      error: parsedPhone.error || 'Please enter a valid 10-digit Indian mobile number.'
    };
  }

  const formattedPhone = parsedPhone.e164;
  const purpose = callbacks?.purpose || 'login';
  const requestSeq = ++activeSendRequestSeq;

  lastSentPhoneNumber = formattedPhone;
  activeConfirmationResult = null;
  clearPendingPhoneOtpSession();
  clearNativePhoneListeners();

  // 1. Native Android & iOS Capacitor Platform Phone Auth (Firebase Native SDK + Play Integrity)
  if (Capacitor.isNativePlatform()) {
    try {
      console.log(`[Native Firebase Phone Auth] Initiating native verification for ${formattedPhone}...`);
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');

      const nativeResult = await new Promise<SendFirebaseOtpResult>(async (resolve) => {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let hasResolved = false;
        let hasHandledCompletion = false;

        const cleanupWaiters = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          try { activeNativeCodeSentSub?.remove?.(); } catch {}
          try { activeNativeFailedSub?.remove?.(); } catch {}
          activeNativeCodeSentSub = null;
          activeNativeFailedSub = null;
        };

        // Listen for Google Play Services SMS Auto-Retrieval & Instant Verification
        activeNativeCompletedSub = await FirebaseAuthentication.addListener('phoneVerificationCompleted', async (event) => {
          if (hasHandledCompletion) return;
          hasHandledCompletion = true;

          const retrievedCode = (event?.verificationCode || '').replace(/\D/g, '').slice(0, 6);
          if (retrievedCode.length === 6) {
            try {
              callbacks?.onAutoFillOtp?.(retrievedCode);
            } catch {}
          }

          if (!hasResolved) {
            hasResolved = true;
            cleanupWaiters();
            resolve({
              success: true,
              formattedPhone,
              provider: 'firebase',
              autoVerified: true,
              message: `Verified ${formattedPhone} automatically.`
            });
          }

          try {
            if (event?.user) {
              clearPendingPhoneOtpSession();
              clearNativePhoneListeners();
              if (purpose === 'profile_update') {
                callbacks?.onNativeVerificationCompleted?.({
                  success: true,
                  firebaseUser: event.user as any
                });
              } else {
                const firebaseIdToken = await resolveFirebaseIdToken(event.user as any);
                const bridgeResult = await bridgeVerifiedPhoneToSupabase(
                  formattedPhone,
                  undefined,
                  event.user as any,
                  firebaseIdToken
                );
                callbacks?.onNativeVerificationCompleted?.({
                  success: bridgeResult.success,
                  user: bridgeResult.user,
                  session: bridgeResult.session,
                  profile: bridgeResult.profile,
                  firebaseUser: event.user as any,
                  error: bridgeResult.error
                });
              }
            } else if (retrievedCode.length === 6 && activeNativeVerificationId) {
              if (purpose === 'profile_update') {
                const verifyOnly = await verifyPhoneOtpOnly(retrievedCode, formattedPhone);
                callbacks?.onNativeVerificationCompleted?.({
                  success: verifyOnly.success,
                  error: verifyOnly.error
                });
              } else {
                const autoResult = await verifyFirebaseOtpAndBridgeToSupabase(retrievedCode, undefined, formattedPhone);
                callbacks?.onNativeVerificationCompleted?.(autoResult);
              }
            } else {
              callbacks?.onNativeVerificationCompleted?.({
                success: false,
                error: 'Automatic verification could not complete. Please enter the 6-digit OTP or request a new code.'
              });
            }
          } catch (autoErr: any) {
            console.warn('[Native Firebase Phone Auth] Auto-completion error:', autoErr);
            callbacks?.onNativeVerificationCompleted?.({
              success: false,
              error: autoErr?.message || 'Automatic verification failed. Please try again.'
            });
          }
        });

        // Auto-expire lingering SMS retrieval listener after 2 minutes
        activeNativeCompletedTimeoutId = setTimeout(() => {
          try { activeNativeCompletedSub?.remove?.(); } catch {}
          activeNativeCompletedSub = null;
          activeNativeCompletedTimeoutId = null;
        }, 120000);

        activeNativeCodeSentSub = await FirebaseAuthentication.addListener('phoneCodeSent', (event) => {
          if (requestSeq !== activeSendRequestSeq) return;
          if (event?.verificationId) {
            activeNativeVerificationId = event.verificationId;
            savePendingPhoneOtpSession({
              phone: formattedPhone,
              provider: 'firebase',
              purpose,
              verificationId: event.verificationId,
              createdAt: Date.now()
            });
          }
          if (!hasResolved) {
            hasResolved = true;
            console.log('[Native Firebase Phone Auth] phoneCodeSent event received, verificationId:', event.verificationId);
            cleanupWaiters();
            resolve({
              success: true,
              formattedPhone,
              provider: 'firebase',
              message: `OTP verification code sent to ${formattedPhone}. Enter the 6-digit code below.`
            });
          }
        });

        activeNativeFailedSub = await FirebaseAuthentication.addListener('phoneVerificationFailed', (event) => {
          if (!hasResolved) {
            hasResolved = true;
            console.error('[Native Firebase Phone Auth] phoneVerificationFailed event:', event);
            cleanupWaiters();
            clearNativePhoneListeners();
            const diagnostic = formatFirebasePhoneError(event);
            resolve({
              success: false,
              formattedPhone,
              isRateLimited: diagnostic.code === 'auth/too-many-requests' || diagnostic.code === 'auth/quota-exceeded',
              error: diagnostic.userMessage || (event as any)?.message || 'Failed to dispatch SMS verification on device.',
              diagnostic
            });
          }
        });

        // 120s safety watchdog timeout (gives users ample time to complete visual reCAPTCHA in Chrome Custom Tab on mobile networks)
        timeoutId = setTimeout(() => {
          if (!hasResolved) {
            hasResolved = true;
            cleanupWaiters();
            console.warn('[Native Firebase Phone Auth] Timed out waiting for phoneCodeSent event...');
            resolve({
              success: false,
              formattedPhone,
              error: `Timed out waiting for SMS dispatch. ${OTP_TIMEOUT_HINT}`
            });
          }
        }, 120000);

        try {
          await FirebaseAuthentication.signInWithPhoneNumber({ phoneNumber: formattedPhone, timeout: 120 });
        } catch (nativeErr: any) {
          if (!hasResolved) {
            hasResolved = true;
            cleanupWaiters();
            clearNativePhoneListeners();
            console.error('[Native Firebase Phone Auth] signInWithPhoneNumber invocation error:', nativeErr);
            const diagnostic = formatFirebasePhoneError(nativeErr);
            resolve({
              success: false,
              formattedPhone,
              isRateLimited: diagnostic.code === 'auth/too-many-requests' || diagnostic.code === 'auth/quota-exceeded',
              error: diagnostic.userMessage || nativeErr?.message || 'Failed to start phone verification on Android.',
              diagnostic
            });
          }
        }
      });

      if (nativeResult.success) {
        return nativeResult;
      }
      // Do NOT fall through to Web SDK signInWithPhoneNumber on Capacitor's https://localhost origin,
      // which triggers unauthorized-domain / default firebaseapp.com web reCAPTCHA failures.
      return {
        success: false,
        formattedPhone,
        isRateLimited: nativeResult.isRateLimited,
        diagnostic: nativeResult.diagnostic,
        error:
          nativeResult.error ||
          'Unable to complete native phone verification on this Android build. Please verify SHA-1/SHA-256 and Play Integrity in Firebase Console.',
      };
    } catch (pluginErr: any) {
      console.warn('[Native Firebase Phone Auth] Native plugin unavailable or error:', pluginErr);
      clearNativePhoneListeners();
      return {
        success: false,
        formattedPhone,
        error:
          pluginErr?.message ||
          'Native Firebase Phone Auth is unavailable in this build. Please reinstall from Google Play or rebuild the signed APK.',
      };
    }
  }

  // 2. Web Firebase Phone Auth SDK (Supports BOTH hidden invisible reCAPTCHA & visible inline captcha box)
  const effectiveRecaptchaMode: RecaptchaDisplayMode = callbacks?.recaptchaMode || 'invisible';
  const targetContainerId = resolveRecaptchaContainerId(effectiveRecaptchaMode, containerId);
  const requestedRecaptchaSize: 'invisible' | 'normal' =
    effectiveRecaptchaMode === 'visible' ? 'normal' : 'invisible';
  const WEB_OTP_SEND_TIMEOUT_MS = effectiveRecaptchaMode === 'visible' ? 90000 : 35000;

  const attemptWebFirebaseSend = async (
    authInstance: ReturnType<typeof getAuth>,
    forceFresh = false
  ) => {
    if (!forceFresh && activeRecaptchaRenderPromise && activeRecaptchaAuthInstance === authInstance) {
      await activeRecaptchaRenderPromise.catch(() => {});
    }
    const appVerifier = getOrCreateRecaptchaVerifier(
      targetContainerId,
      authInstance,
      forceFresh,
      { size: requestedRecaptchaSize }
    );
    activeRecaptchaConsumed = true;
    activeRecaptchaVerified = false;
    console.log(
      `[Firebase Phone Auth] Requesting Web SDK OTP dispatch (${effectiveRecaptchaMode} reCAPTCHA) for ${formattedPhone}...`
    );

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const confirmationResult = await Promise.race([
      signInWithPhoneNumber(authInstance, formattedPhone, appVerifier),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const timeoutErr: any = new Error(
            `Verification timed out waiting for Google reCAPTCHA / Firebase SMS. ${OTP_TIMEOUT_HINT}`
          );
          timeoutErr.code = 'auth/network-request-failed';
          reject(timeoutErr);
        }, WEB_OTP_SEND_TIMEOUT_MS);
      })
    ]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });

    if (requestSeq !== activeSendRequestSeq) {
      return {
        success: false as const,
        formattedPhone,
        error: 'OTP request superseded by a newer attempt.'
      };
    }

    activeConfirmationResult = confirmationResult;
    return {
      success: true as const,
      formattedPhone,
      provider: 'firebase' as const,
      message: `Firebase OTP code sent to ${formattedPhone}. Enter the 6-digit code below.`
    };
  };

  // When a visible captcha widget was already solved using the fallback dev authDomain,
  // use that exact auth instance so signInWithPhoneNumber consumes the verified token directly.
  const primaryWebAuthInstance =
    effectiveRecaptchaMode === 'visible' &&
    activeRecaptchaVerifier &&
    !activeRecaptchaConsumed &&
    activeRecaptchaSize === 'normal' &&
    activeRecaptchaHostId === targetContainerId &&
    activeRecaptchaAuthInstance
      ? activeRecaptchaAuthInstance
      : firebaseAuth;

  try {
    return await attemptWebFirebaseSend(primaryWebAuthInstance, false);
  } catch (webErr: any) {
    console.warn('[Firebase Phone Auth] Web SDK primary attempt failed:', webErr);
    resetRecaptchaVerifier(targetContainerId);

    const initialDiag = formatFirebasePhoneError(webErr);
    if (isRateLimitErrorCode(initialDiag.code)) {
      return {
        success: false,
        formattedPhone,
        isRateLimited: true,
        error: initialDiag.userMessage,
        diagnostic: initialDiag
      };
    }

    // Self-heal immediately if a stale/prewarmed widget threw "already been rendered in this element"
    if (isRecaptchaAlreadyRenderedError(webErr)) {
      try {
        console.log('[Firebase Phone Auth] Retrying Web SDK OTP on a brand-new virgin reCAPTCHA slot...');
        return await attemptWebFirebaseSend(primaryWebAuthInstance, true);
      } catch (freshErr: any) {
        webErr = freshErr;
        resetRecaptchaVerifier(targetContainerId);
      }
    }

    // Only fall back to default Firebase authDomain on local dev / preview hosts.
    // On production smartrun.in / www.smartrun.in / native APK, strictly enforce smartrun.in
    // so users never see or route through *.firebaseapp.com.
    const errCode = String(webErr?.code || '');
    const errMsg = String(webErr?.message || '').toLowerCase();
    const isDomainOrCaptchaErr =
      !isRateLimitErrorCode(errCode) &&
      (errCode === 'auth/unauthorized-domain' ||
        errCode === 'auth/captcha-check-failed' ||
        errCode === 'auth/invalid-app-credential' ||
        errCode === 'auth/internal-error' ||
        errMsg.includes('hostname match not found') ||
        errMsg.includes('recaptcha'));

    const canFallbackAuthDomain = shouldAllowFallbackFirebaseAuthDomain({
      isNativePlatform: Capacitor.isNativePlatform(),
      windowHostname: typeof window !== 'undefined' ? window.location.hostname : '',
    });

    if (
      canFallbackAuthDomain &&
      isDomainOrCaptchaErr &&
      primaryWebAuthInstance !== getFallbackFirebaseAuth() &&
      resolvedFirebaseConfig.authDomain !== firebaseConfig.authDomain
    ) {
      try {
        console.log('[Firebase Phone Auth] Retrying Web SDK OTP with dev preview fallback authDomain...');
        return await attemptWebFirebaseSend(getFallbackFirebaseAuth(), true);
      } catch (retryErr: any) {
        console.warn('[Firebase Phone Auth] Fallback authDomain retry also failed:', retryErr);
        resetRecaptchaVerifier(targetContainerId);
        const retryDiag = formatFirebasePhoneError(retryErr);
        return {
          success: false,
          formattedPhone,
          isRateLimited: isRateLimitErrorCode(retryDiag.code),
          error: retryDiag.userMessage || retryErr?.message || 'Failed to dispatch OTP verification code.',
          diagnostic: retryDiag
        };
      }
    }

    const diagnostic = formatFirebasePhoneError(webErr);
    return {
      success: false,
      formattedPhone,
      isRateLimited: isRateLimitErrorCode(diagnostic.code),
      error: diagnostic.userMessage || webErr?.message || 'Failed to dispatch OTP verification code.',
      diagnostic
    };
  }
}

export interface VerifyFirebaseOtpResult {
  success: boolean;
  user?: any;
  session?: any;
  profile?: UserProfile;
  firebaseUser?: FirebaseUser;
  error?: string;
}

/**
 * Verifies the 6-digit OTP code directly using Firebase Auth confirmation result or Native Android plugin,
 * then bridges the authenticated Firebase phone identity into the EXACT SAME Supabase account and user session!
 */
export async function verifyFirebaseOtpAndBridgeToSupabase(
  otpCode: string,
  userFullName?: string,
  phoneOverride?: string
): Promise<VerifyFirebaseOtpResult> {
  const cleanCode = (otpCode || '').trim();
  if (!cleanCode || cleanCode.length < 6) {
    return {
      success: false,
      error: 'Please enter the complete 6-digit verification code.'
    };
  }

  // Hydrate persisted verificationId if WebView restarted after RecaptchaActivity
  if (!activeNativeVerificationId && !activeConfirmationResult) {
    getPendingPhoneOtpSession();
  }

  const verifiedPhoneNumber = phoneOverride ? formatToE164Phone(phoneOverride) : lastSentPhoneNumber;
  if (!verifiedPhoneNumber) {
    return {
      success: false,
      error: 'Could not determine verified phone number from session.'
    };
  }

  let firebaseUser: FirebaseUser | undefined;
  let firebaseIdToken: string | undefined;

  // 1. Verify OTP with Native Android / Capacitor Firebase Auth
  if (activeNativeVerificationId) {
    try {
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      const signInResult = await FirebaseAuthentication.confirmVerificationCode({
        verificationId: activeNativeVerificationId,
        verificationCode: cleanCode
      });
      clearPendingPhoneOtpSession();
      clearNativePhoneListeners();
      console.log('[Native Firebase Phone Auth] Successfully verified OTP! Native User UID:', signInResult.user?.uid);
      firebaseUser = signInResult.user as any;
      firebaseIdToken = await resolveFirebaseIdToken(firebaseUser);
    } catch (err: any) {
      console.error('[Native Firebase Phone Auth] OTP confirmation failed:', err);
      const diagnostic = formatFirebasePhoneError(err);
      if (isExpiredOtpErrorCode(diagnostic.code)) {
        clearPendingPhoneOtpSession();
        clearNativePhoneListeners();
      }
      return {
        success: false,
        error: diagnostic.userMessage || err?.message || 'Invalid 6-digit verification code. Please check and try again.'
      };
    }
  } else if (activeConfirmationResult) {
    try {
      const userCredential = await activeConfirmationResult.confirm(cleanCode);
      firebaseUser = userCredential.user;
      firebaseIdToken = await resolveFirebaseIdToken(firebaseUser);
      activeConfirmationResult = null;
      clearPendingPhoneOtpSession();
      resetRecaptchaVerifier();
      console.log('[Firebase Phone Auth] Successfully verified OTP! Firebase UID:', firebaseUser.uid);
    } catch (err: any) {
      console.error('[Firebase Phone Auth] OTP verification failed:', err);
      const diagnostic = formatFirebasePhoneError(err);
      if (isExpiredOtpErrorCode(diagnostic.code)) {
        activeConfirmationResult = null;
        clearPendingPhoneOtpSession();
        resetRecaptchaVerifier();
      }
      return {
        success: false,
        error:
          diagnostic.code === 'auth/invalid-verification-code'
            ? 'Invalid 6-digit verification code. Please check and try again.'
            : isExpiredOtpErrorCode(diagnostic.code)
            ? 'Verification code has expired. Please request a new code.'
            : diagnostic.userMessage || err?.message || 'Failed to verify OTP code with Firebase.'
      };
    }
  } else {
    return {
      success: false,
      error: 'Verification session expired. Please request a new OTP code.'
    };
  }

  // 2. Bridge verified Firebase phone identity into Supabase
  const bridgeResult = await bridgeVerifiedPhoneToSupabase(
    verifiedPhoneNumber,
    userFullName,
    firebaseUser,
    firebaseIdToken
  );
  if (!bridgeResult.success) {
    return {
      success: false,
      error: bridgeResult.error || 'Failed to authenticate into Supabase account.'
    };
  }

  return {
    success: true,
    user: bridgeResult.user,
    session: bridgeResult.session,
    profile: bridgeResult.profile,
    firebaseUser
  };
}

/**
 * Verifies phone OTP directly with Firebase Auth WITHOUT altering the active Supabase session.
 * Used when an already authenticated user links or verifies their mobile number in UpdateMobileSubPage.
 */
export async function verifyPhoneOtpOnly(
  otpCode: string,
  targetPhone?: string
): Promise<{ success: boolean; formattedPhone?: string; error?: string }> {
  const cleanCode = (otpCode || '').trim();
  const parsedTarget = parseIndianMobileNumber(targetPhone || lastSentPhoneNumber || '');

  if (!parsedTarget.valid) {
    return {
      success: false,
      error: parsedTarget.error || 'Invalid mobile number.'
    };
  }

  const formattedPhone = parsedTarget.e164;

  if (cleanCode.length !== 6) {
    return {
      success: false,
      error: 'Please enter the complete 6-digit verification code.'
    };
  }

  // Hydrate persisted verificationId if Android WebView restarted after RecaptchaActivity
  if (!activeNativeVerificationId && !activeConfirmationResult) {
    getPendingPhoneOtpSession();
  }

  if (activeNativeVerificationId) {
    try {
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      await FirebaseAuthentication.confirmVerificationCode({
        verificationId: activeNativeVerificationId,
        verificationCode: cleanCode
      });
      clearPendingPhoneOtpSession();
      clearNativePhoneListeners();
      console.log('[Native Firebase Phone Auth] Phone number updated and verified successfully.');
      return { success: true, formattedPhone };
    } catch (err: any) {
      console.error('[Native Firebase Phone Auth] Profile update OTP verification error:', err);
      const diagnostic = formatFirebasePhoneError(err);
      if (isExpiredOtpErrorCode(diagnostic.code)) {
        clearPendingPhoneOtpSession();
        clearNativePhoneListeners();
      }
      return {
        success: false,
        error: diagnostic.userMessage || err?.message || 'Invalid 6-digit OTP code.'
      };
    }
  } else if (activeConfirmationResult) {
    try {
      await activeConfirmationResult.confirm(cleanCode);
      activeConfirmationResult = null;
      clearPendingPhoneOtpSession();
      resetRecaptchaVerifier();
      console.log('[Firebase Phone Auth] Phone number updated and verified successfully.');
      return { success: true, formattedPhone };
    } catch (err: any) {
      console.error('[Firebase Phone Auth] Profile update OTP verification error:', err);
      const diagnostic = formatFirebasePhoneError(err);
      if (isExpiredOtpErrorCode(diagnostic.code)) {
        activeConfirmationResult = null;
        clearPendingPhoneOtpSession();
        resetRecaptchaVerifier();
      }
      return {
        success: false,
        error:
          diagnostic.code === 'auth/invalid-verification-code'
            ? 'Invalid 6-digit OTP code.'
            : isExpiredOtpErrorCode(diagnostic.code)
            ? 'Verification code has expired. Please request a new code.'
            : diagnostic.userMessage || err?.message || 'Failed to verify OTP code.'
      };
    }
  }

  return {
    success: false,
    error: 'Verification session expired. Please request a new OTP code.'
  };
}

/**
 * Bridges any verified phone number into a genuine, persistent Supabase Auth session
 * guaranteeing that the user retains the same account, order history, addresses, and profile.
 */
export async function bridgeVerifiedPhoneToSupabase(
  verifiedPhoneNumber: string,
  preferredName?: string,
  firebaseUser?: FirebaseUser,
  firebaseIdToken?: string
): Promise<{
  success: boolean;
  user: any;
  session: any;
  profile: UserProfile;
  error?: string;
}> {
  const clean10 = verifiedPhoneNumber.replace(/\D/g, '').slice(-10);
  const formattedE164 = `+91${clean10}`;
  const canonicalEmail = `p${clean10}@girirajpower.internal`;
  const deterministicPassword = `GirirajPower@${clean10}#2026`;

  // Step 0: Ensure any previous different user session in the client is signed out cleanly
  try {
    const { data: currentAuth } = await supabase.auth.getUser();
    if (currentAuth?.user && currentAuth.user.email !== canonicalEmail) {
      await supabase.auth.signOut({ scope: 'local' });
    }
  } catch {
    // Ignore signout cleanup errors
  }

  // Pre-resolve existing customer profile across backend resolver and local storage
  let preResolvedUserId = '';
  let preResolvedName = preferredName || '';
  let preResolvedEmail = '';
  let preResolvedPhoto = '';
  let preResolvedDob = '';
  let preResolvedWallet = 0;
  let preResolvedRefund = 0;
  let preResolvedCashback = 0;

  try {
    const resolveRes = await fetch(apiUrl('/api/auth/resolve-phone-user'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: clean10 })
    }).catch(() => null);

    if (resolveRes && resolveRes.ok) {
      const resolveJson = await resolveRes.json().catch(() => null);
      if (resolveJson?.profile) {
        const p = resolveJson.profile;
        if (p.user_id) preResolvedUserId = p.user_id;
        if (p.full_name) preResolvedName = p.full_name;
        if (p.email && !p.email.includes('@girirajpower.internal')) preResolvedEmail = p.email;
        if (p.avatar_url) preResolvedPhoto = p.avatar_url;
        if (p.dob) preResolvedDob = p.dob;
        if (p.wallet_balance !== undefined) preResolvedWallet = Number(p.wallet_balance);
        if (p.refund_balance !== undefined) preResolvedRefund = Number(p.refund_balance);
        if (p.cashback_balance !== undefined) preResolvedCashback = Number(p.cashback_balance);
      }
    }
  } catch (e) {
    console.debug('[Phone Bridge] Profile resolver notice:', e);
  }

  const existingPhoneLocal = getSavedUserProfile(`phone_${clean10}`);
  if (existingPhoneLocal) {
    if (!preResolvedUserId && existingPhoneLocal.id && !existingPhoneLocal.id.startsWith('phone_')) {
      preResolvedUserId = existingPhoneLocal.id;
    }
    if (!preResolvedName && existingPhoneLocal.name) preResolvedName = existingPhoneLocal.name;
    if (!preResolvedEmail && existingPhoneLocal.email && !existingPhoneLocal.email.includes('@girirajpower.internal')) {
      preResolvedEmail = existingPhoneLocal.email;
    }
    if (!preResolvedPhoto && existingPhoneLocal.photoURL) preResolvedPhoto = existingPhoneLocal.photoURL;
    if (!preResolvedDob && existingPhoneLocal.dob) preResolvedDob = existingPhoneLocal.dob;
    if (!preResolvedWallet && existingPhoneLocal.walletBalance) preResolvedWallet = existingPhoneLocal.walletBalance;
    if (!preResolvedRefund && existingPhoneLocal.refundBalance) preResolvedRefund = existingPhoneLocal.refundBalance;
    if (!preResolvedCashback && existingPhoneLocal.cashbackBalance) preResolvedCashback = existingPhoneLocal.cashbackBalance;
  }

  let supabaseUser: any = null;
  let supabaseSession: any = null;

  try {
    // Step 1: Request server-side session provisioning to ensure credentials exist and match master_user_id
    try {
      const resolvedToken = firebaseIdToken || (await resolveFirebaseIdToken(firebaseUser));
      const sessionProvRes = await fetch(apiUrl('/api/auth/phone-login-session'), {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          phone: clean10,
          fullName: preResolvedName || preferredName || 'Customer',
          preResolvedUserId: preResolvedUserId || undefined,
          firebaseIdToken: resolvedToken || undefined
        })
      });
      if (sessionProvRes.ok) {
        const provData = await sessionProvRes.json().catch(() => null);
        if (provData?.sessionToken) {
          setServerAuthToken(provData.sessionToken);
        }
        if (provData?.effectiveUserId && !preResolvedUserId) {
          preResolvedUserId = provData.effectiveUserId;
        }
        if (provData?.resolvedName && (!preResolvedName || preResolvedName === 'Customer')) {
          preResolvedName = provData.resolvedName;
        }
        if (provData?.resolvedEmail && !preResolvedEmail) {
          preResolvedEmail = provData.resolvedEmail;
        }
      }
    } catch (provErr) {
      console.debug('[Phone Bridge] Server session provisioning notice:', provErr);
    }

    // Step 2: Sign-in with the canonical credentials
    const signInRes = await supabase.auth.signInWithPassword({
      email: canonicalEmail,
      password: deterministicPassword
    });

    if (!signInRes.error && signInRes.data?.session) {
      supabaseSession = signInRes.data.session;
      supabaseUser = signInRes.data.user;
    } else {
      // Step 2b: Fallback to signup if first-time user
      const defaultName = sanitizeCustomerName(preResolvedName) || sanitizeCustomerName(preferredName) || 'Customer';
      const signUpRes = await supabase.auth.signUp({
        email: canonicalEmail,
        password: deterministicPassword,
        options: {
          data: {
            phone: formattedE164,
            contact_number: formattedE164,
            full_name: defaultName,
            master_user_id: preResolvedUserId || `uid_${clean10}`,
            linked_user_id: preResolvedUserId || `uid_${clean10}`,
            ...(preResolvedEmail ? { email: preResolvedEmail, real_email: preResolvedEmail } : {})
          }
        }
      });

      if (signUpRes.data?.session) {
        supabaseSession = signUpRes.data.session;
        supabaseUser = signUpRes.data.user;
      } else if (signUpRes.data?.user) {
        // Retry sign-in immediately if user was created but session needs explicit token
        const retrySignIn = await supabase.auth.signInWithPassword({
          email: canonicalEmail,
          password: deterministicPassword
        });
        if (retrySignIn.data?.session) {
          supabaseSession = retrySignIn.data.session;
          supabaseUser = retrySignIn.data.user;
        } else {
          supabaseUser = signUpRes.data.user;
        }
      } else {
        // If already registered or error, attempt final sign-in retry
        const finalRetry = await supabase.auth.signInWithPassword({
          email: canonicalEmail,
          password: deterministicPassword
        });
        if (finalRetry.data?.session) {
          supabaseSession = finalRetry.data.session;
          supabaseUser = finalRetry.data.user;
        } else {
          console.info('[Phone Bridge] Operating with verified phone identity:', preResolvedUserId || clean10);
          supabaseUser = {
            id: preResolvedUserId || `uid_${clean10}`,
            email: preResolvedEmail || canonicalEmail,
            phone: formattedE164,
            user_metadata: {
              full_name: sanitizeCustomerName(preResolvedName) || sanitizeCustomerName(preferredName) || 'Customer',
              phone: formattedE164,
              master_user_id: preResolvedUserId || `uid_${clean10}`
            }
          };
        }
      }
    }

    // Set session in Supabase client to trigger onAuthStateChange and persist across tabs
    if (supabaseSession) {
      await supabase.auth.setSession({
        access_token: supabaseSession.access_token,
        refresh_token: supabaseSession.refresh_token
      });
    }

    const effectiveUserId = preResolvedUserId || supabaseUser?.user_metadata?.master_user_id || supabaseUser?.id || `uid_${clean10}`;
    const scope = `uid_${effectiveUserId}`;
    setActiveUserScope(scope);

    // Step 3: Fetch linked user profile from user_profiles table (querying effectiveUserId)
    let resolvedName = sanitizeCustomerName(preResolvedName) || sanitizeCustomerName(preferredName) || 'Customer';
    let resolvedEmail = preResolvedEmail || '';
    let resolvedDob = preResolvedDob || '';
    let resolvedPhoto = preResolvedPhoto || '';
    let resolvedWallet = preResolvedWallet || 0;
    let resolvedRefund = preResolvedRefund || 0;
    let resolvedCashback = preResolvedCashback || 0;

    try {
      const { data: userProfileRecord } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('user_id', effectiveUserId)
        .maybeSingle();

      if (userProfileRecord) {
        if (userProfileRecord.full_name) {
          const cleanDbName = sanitizeCustomerName(userProfileRecord.full_name);
          if (cleanDbName) resolvedName = cleanDbName;
        }
        // ONLY accept email if it is a real, non-internal email
        if (userProfileRecord.email && !userProfileRecord.email.includes('@girirajpower.internal')) {
          resolvedEmail = userProfileRecord.email;
        }
        if (userProfileRecord.avatar_url) resolvedPhoto = userProfileRecord.avatar_url;
        if (userProfileRecord.dob) resolvedDob = userProfileRecord.dob;
        if (userProfileRecord.wallet_balance !== undefined) resolvedWallet = userProfileRecord.wallet_balance;
        if (userProfileRecord.refund_balance !== undefined) resolvedRefund = userProfileRecord.refund_balance;
        if (userProfileRecord.cashback_balance !== undefined) resolvedCashback = userProfileRecord.cashback_balance;
      }
    } catch (e) {
      console.debug('[Firebase-Supabase Bridge] Cloud profile query notice:', e);
    }

    // Check localStorage fallback STRICTLY for this user's scope
    const localProfile = getSavedUserProfile(scope);
    if (localProfile) {
      if (!resolvedName || resolvedName === 'Customer') {
        const cleanLocalName = sanitizeCustomerName(localProfile.name);
        if (cleanLocalName) resolvedName = cleanLocalName;
      }
      if (!resolvedEmail && localProfile.email && !localProfile.email.includes('@girirajpower.internal')) {
        resolvedEmail = localProfile.email;
      }
      if (!resolvedPhoto) resolvedPhoto = localProfile.photoURL || '';
      if (!resolvedDob) resolvedDob = localProfile.dob || '';
      if (!resolvedWallet && localProfile.walletBalance) resolvedWallet = localProfile.walletBalance;
      if (!resolvedRefund && localProfile.refundBalance) resolvedRefund = localProfile.refundBalance;
      if (!resolvedCashback && localProfile.cashbackBalance) resolvedCashback = localProfile.cashbackBalance;
    }

    // Sync Auth metadata with user details so Supabase Auth table reflects them
    try {
      await supabase.auth.updateUser({
        data: {
          phone: formattedE164,
          contact_number: formattedE164,
          full_name: resolvedName,
          master_user_id: effectiveUserId,
          linked_user_id: effectiveUserId,
          ...(firebaseUser?.uid ? { firebase_uid: firebaseUser.uid } : {}),
          ...(resolvedEmail ? { real_email: resolvedEmail } : {})
        }
      });
    } catch {}

    const finalizedProfile: UserProfile = {
      id: effectiveUserId,
      phone: formattedE164,
      phoneVerified: true,
      name: resolvedName,
      email: resolvedEmail,
      emailVerified: Boolean(resolvedEmail),
      photoURL: resolvedPhoto,
      dob: resolvedDob,
      walletBalance: resolvedWallet,
      refundBalance: resolvedRefund,
      cashbackBalance: resolvedCashback
    };

    // Save profile under both user scope AND phone scope for instant multi-login consistency
    saveUserProfile(finalizedProfile, scope);
    saveUserProfile(finalizedProfile, `phone_${clean10}`);
    if (supabaseUser?.id && supabaseUser.id !== effectiveUserId) {
      saveUserProfile(finalizedProfile, `uid_${supabaseUser.id}`);
    }

    // Save to user_profiles table in Supabase under effective master user_id
    try {
      await supabase.from('user_profiles').upsert(
        {
          user_id: effectiveUserId,
          phone: formattedE164,
          full_name: resolvedName,
          email: resolvedEmail || null,
          avatar_url: resolvedPhoto || null,
          dob: resolvedDob || null,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'user_id' }
      );

      if (supabaseUser?.id && supabaseUser.id !== effectiveUserId) {
        try {
          await supabase.from('user_profiles').upsert(
            {
              user_id: supabaseUser.id,
              phone: formattedE164,
              full_name: resolvedName,
              email: resolvedEmail || null,
              avatar_url: resolvedPhoto || null,
              dob: resolvedDob || null,
              updated_at: new Date().toISOString()
            },
            { onConflict: 'user_id' }
          );
        } catch {}
      }
    } catch {}

    // Synchronize to backend server-side store
    fetch(apiUrl('/api/user-profile'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: effectiveUserId,
        phone: formattedE164,
        full_name: resolvedName,
        email: resolvedEmail || null,
        avatar_url: resolvedPhoto || null,
        dob: resolvedDob || null
      })
    }).catch(() => {});

    // Sync login profile to Firebase on backend server
    try {
      fetch(apiUrl('/api/auth/sync-user-to-firebase'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: effectiveUserId,
          profile: {
            phone: formattedE164,
            full_name: resolvedName,
            email: resolvedEmail || undefined,
            avatar_url: resolvedPhoto || undefined,
            dob: resolvedDob || undefined
          }
        })
      }).catch(() => {});
    } catch {}

    const unifiedUser = {
      ...(supabaseUser || {}),
      id: effectiveUserId,
      auth_id: supabaseUser?.id,
      email: resolvedEmail || supabaseUser?.email,
      phone: formattedE164,
      user_metadata: {
        ...(supabaseUser?.user_metadata || {}),
        full_name: resolvedName,
        name: resolvedName,
        phone: formattedE164,
        master_user_id: effectiveUserId,
        linked_user_id: effectiveUserId,
        real_email: resolvedEmail
      }
    };

    return {
      success: true,
      user: unifiedUser,
      session: supabaseSession,
      profile: finalizedProfile
    };
  } catch (bridgeErr: any) {
    console.error('[Firebase-Supabase Bridge Error]:', bridgeErr);
    return {
      success: false,
      user: null,
      session: null,
      profile: {
        id: `uid_${clean10}`,
        phone: formattedE164,
        phoneVerified: true,
        name: preferredName || 'Customer',
        email: '',
        emailVerified: false
      },
      error: bridgeErr?.message || 'Authentication bridge failed.'
    };
  }
}

/**
 * Sign out from both Firebase Auth (Web + Fallback + Native Capacitor) and Supabase Auth
 */
export async function signOutFromAll(): Promise<void> {
  activeSendRequestSeq += 1;
  try {
    await firebaseSignOut(firebaseAuth);
  } catch {}
  try {
    if (fallbackFirebaseAuth) {
      await firebaseSignOut(fallbackFirebaseAuth);
    }
  } catch {}
  try {
    if (Capacitor.isNativePlatform()) {
      const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
      await FirebaseAuthentication.signOut();
    }
  } catch {}
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {}
  try {
    await supabase.auth.signOut();
  } catch {}
  resetRecaptchaVerifier();
  clearNativePhoneListeners();
  clearPendingPhoneOtpSession();
  activeConfirmationResult = null;
  lastSentPhoneNumber = null;
}

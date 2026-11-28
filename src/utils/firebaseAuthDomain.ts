export const PRODUCTION_APP_ORIGIN = 'https://www.smartrun.in';
export const PRODUCTION_FIREBASE_AUTH_DOMAIN = 'www.smartrun.in';
export const CAPACITOR_APK_HOSTNAME = 'app.smartrun.in';

export interface AuthDomainResolutionContext {
  configuredDomain?: string;
  isNativePlatform: boolean;
  windowHostname?: string;
  fallbackAuthDomain: string;
}

export interface PublicOriginContext {
  isNativePlatform?: boolean;
  windowOrigin?: string;
  windowHostname?: string;
}

/**
 * Strips any protocol/path from a Firebase authDomain value so both Web SDK and
 * Android FirebaseAuth.setCustomAuthDomain(...) always receive a bare hostname
 * (e.g. "www.smartrun.in").
 */
export function normalizeAuthDomainHostname(rawDomain: string): string {
  const trimmed = String(rawDomain || '').trim();
  if (!trimmed) return '';
  return trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase();
}

export function isSmartRunHost(hostname?: string): boolean {
  const host = String(hostname || '').trim().toLowerCase();
  return host === 'smartrun.in' || host === 'www.smartrun.in' || host.endsWith('.smartrun.in');
}

function isDisallowedProdAuthDomain(domain: string): boolean {
  const host = normalizeAuthDomainHostname(domain);
  return (
    !host ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '10.0.2.2' ||
    host.endsWith('.firebaseapp.com') ||
    host.endsWith('.web.app') ||
    host.includes('girirajpower')
  );
}

/**
 * Resolves the canonical public SmartRun origin (`https://www.smartrun.in`) for
 * redirects, password reset links, OAuth callbacks, and share URLs across
 * native Android/iOS APK builds and web deployments.
 */
export function resolvePublicAppOrigin(ctx?: PublicOriginContext): string {
  const isNative = Boolean(ctx?.isNativePlatform);
  const origin = String(ctx?.windowOrigin || '').trim();
  const host = String(ctx?.windowHostname || '').trim().toLowerCase();

  if (
    isNative ||
    !origin ||
    origin.startsWith('capacitor://') ||
    origin.startsWith('ionic://') ||
    origin.startsWith('file://') ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '10.0.2.2' ||
    isSmartRunHost(host) ||
    host.includes('girirajpower') ||
    host.endsWith('.firebaseapp.com') ||
    host.endsWith('.run.app')
  ) {
    return PRODUCTION_APP_ORIGIN;
  }

  return PRODUCTION_APP_ORIGIN;
}

/**
 * Resolves the Firebase Auth domain so production web (`smartrun.in`, `www.smartrun.in`)
 * and native Android/iOS APK builds (`app.smartrun.in`) always use the canonical public
 * SmartRun domain (`www.smartrun.in`) rather than `*.firebaseapp.com` or `localhost`.
 */
export function resolveFirebaseAuthDomainForEnv(ctx: AuthDomainResolutionContext): string {
  const host = String(ctx.windowHostname || '').trim().toLowerCase();
  const isProdOrNative = Boolean(ctx.isNativePlatform) || isSmartRunHost(host);

  const configured = normalizeAuthDomainHostname(ctx.configuredDomain || '');
  if (configured) {
    // Reject localhost / firebaseapp.com / legacy domain overrides on native APK or smartrun.in
    if (isProdOrNative && isDisallowedProdAuthDomain(configured)) {
      return PRODUCTION_FIREBASE_AUTH_DOMAIN;
    }
    return configured;
  }

  if (isProdOrNative) {
    return PRODUCTION_FIREBASE_AUTH_DOMAIN;
  }

  return normalizeAuthDomainHostname(ctx.fallbackAuthDomain) || PRODUCTION_FIREBASE_AUTH_DOMAIN;
}

/**
 * Returns false on native APK and production smartrun.in domains so Firebase Phone Auth
 * never silently falls back to `*.firebaseapp.com` in production.
 * Only permits the project fallback authDomain on local dev / Cloud Run preview hosts.
 */
export function shouldAllowFallbackFirebaseAuthDomain(ctx: {
  isNativePlatform: boolean;
  windowHostname?: string;
}): boolean {
  if (ctx.isNativePlatform) return false;
  if (isSmartRunHost(ctx.windowHostname)) return false;
  return true;
}

/**
 * Normalizes native Android / iOS Capacitor Firebase Phone Auth error payloads
 * (which often arrive with raw FirebaseException messages or uppercase codes
 * instead of Web SDK `auth/*` codes) into standard `auth/*` error codes.
 */
export function normalizeNativeFirebaseAuthError(err: unknown): { code: string; message: string } {
  const rawCode = String((err as { code?: string } | null)?.code ?? '').trim();
  const rawMessage = String(
    (err as { message?: string } | null)?.message ?? (typeof err === 'string' ? err : '')
  ).trim();
  const lowerCode = rawCode.toLowerCase();
  const lowerMsg = rawMessage.toLowerCase();

  if (lowerCode.startsWith('auth/')) {
    return { code: lowerCode, message: rawMessage };
  }

  if (
    lowerCode.includes('missing_client_identifier') ||
    lowerMsg.includes('missing a valid app identifier') ||
    lowerMsg.includes('play integrity') ||
    lowerMsg.includes('safetynet') ||
    lowerMsg.includes('missing_client_identifier')
  ) {
    return { code: 'auth/missing-client-identifier', message: rawMessage };
  }

  if (
    lowerCode.includes('app_not_authorized') ||
    lowerMsg.includes('not authorized to use firebase authentication') ||
    lowerMsg.includes('correct package name and sha-1')
  ) {
    return { code: 'auth/app-not-authorized', message: rawMessage };
  }

  if (
    lowerCode.includes('invalid_app_credential') ||
    lowerMsg.includes('invalid_app_credential') ||
    lowerMsg.includes('invalid app credential')
  ) {
    return { code: 'auth/invalid-app-credential', message: rawMessage };
  }

  if (
    lowerCode.includes('captcha_check_failed') ||
    lowerMsg.includes('captcha') ||
    lowerMsg.includes('recaptcha')
  ) {
    return { code: 'auth/captcha-check-failed', message: rawMessage };
  }

  if (
    lowerCode.includes('invalid_verification_code') ||
    lowerMsg.includes('verification code from sms/topt is invalid') ||
    lowerMsg.includes('sms verification code used to create the phone auth credential is invalid') ||
    lowerMsg.includes('invalid verification code')
  ) {
    return { code: 'auth/invalid-verification-code', message: rawMessage };
  }

  if (
    lowerCode.includes('session_expired') ||
    lowerCode.includes('code_expired') ||
    lowerMsg.includes('sms code has expired') ||
    lowerMsg.includes('session expired')
  ) {
    return { code: 'auth/code-expired', message: rawMessage };
  }

  if (
    lowerCode.includes('too_many_requests') ||
    lowerMsg.includes('blocked all requests from this device') ||
    lowerMsg.includes('unusual activity') ||
    lowerMsg.includes('too many requests')
  ) {
    return { code: 'auth/too-many-requests', message: rawMessage };
  }

  if (lowerCode.includes('quota_exceeded') || lowerMsg.includes('quota')) {
    return { code: 'auth/quota-exceeded', message: rawMessage };
  }

  if (
    lowerCode.includes('operation_not_allowed') ||
    lowerMsg.includes('operation is not allowed') ||
    lowerMsg.includes('sms unable to be sent until this region enabled')
  ) {
    return { code: 'auth/operation-not-allowed', message: rawMessage };
  }

  if (
    lowerCode.includes('network_request_failed') ||
    lowerMsg.includes('network error') ||
    lowerMsg.includes('unable to resolve host') ||
    lowerMsg.includes('timeout')
  ) {
    return { code: 'auth/network-request-failed', message: rawMessage };
  }

  if (lowerCode.includes('invalid_phone_number') || lowerMsg.includes('invalid phone number')) {
    return { code: 'auth/invalid-phone-number', message: rawMessage };
  }

  return { code: rawCode, message: rawMessage };
}

/**
 * Determines whether the native Android Google Play Services SMS User Consent
 * listener should be armed. It must ONLY run after Firebase has finished any
 * verification/captcha step and dispatched the SMS (`otpSent && showSecondField`),
 * preventing background Activity launches while a verification screen is active.
 */
export function shouldArmNativeSmsConsent(params: {
  authStep: string;
  isPhone: boolean;
  otpSent: boolean;
  showSecondField: boolean;
  otpAttemptId: number;
}): boolean {
  return (
    params.authStep === 'primary' &&
    params.isPhone &&
    params.otpSent &&
    params.showSecondField &&
    params.otpAttemptId > 0
  );
}

/**
 * Generates a unique virgin child DOM slot ID under the reCAPTCHA host container
 * so Google reCAPTCHA never sees a previously rendered DOM element on retries or resends.
 */
export function buildRecaptchaSlotId(baseContainerId: string, sequence: number): string {
  const safeBase = String(baseContainerId || 'recaptcha-container')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '') || 'recaptcha-container';
  const safeSeq = Math.max(1, Math.floor(Number(sequence) || 1));
  return `${safeBase}-slot-${safeSeq}`;
}

/**
 * Detects Google reCAPTCHA / Firebase Web SDK duplicate-element render errors
 * so the service can automatically allocate a fresh virgin DOM slot and retry once.
 */
export function isRecaptchaAlreadyRenderedError(err: unknown): boolean {
  const msg = String(
    (err as { message?: string } | null)?.message ?? err ?? ''
  ).toLowerCase();
  return (
    msg.includes('already been rendered') ||
    msg.includes('already rendered') ||
    msg.includes('recaptcha-already-rendered')
  );
}

export interface ParsedIndianMobile {
  valid: boolean;
  clean10: string;
  e164: string;
  error?: string;
}

/**
 * Strictly parses and validates an Indian mobile number.
 * Accepts 10 digits ([6-9]XXXXXXXXX), 11 digits with leading 0, or 12 digits with 91/+91.
 * Rejects overlong numbers (e.g. 13+ digits) and non-Indian prefixes instead of silently
 * truncating to a different user's phone number.
 */
export function parseIndianMobileNumber(raw: string): ParsedIndianMobile {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      clean10: '',
      e164: '',
      error: 'Please enter your 10-digit mobile number.',
    };
  }

  // Reject strings containing letters (e.g. emails or malformed input)
  if (/[a-zA-Z@]/.test(trimmed)) {
    return {
      valid: false,
      clean10: '',
      e164: '',
      error: 'Please enter a valid 10-digit Indian mobile number.',
    };
  }

  const digits = trimmed.replace(/\D/g, '');
  let clean10 = '';

  if (digits.length === 10) {
    clean10 = digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    clean10 = digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    clean10 = digits.slice(2);
  } else {
    return {
      valid: false,
      clean10: '',
      e164: '',
      error: 'Please enter a valid 10-digit Indian mobile number.',
    };
  }

  if (!/^[6-9]\d{9}$/.test(clean10)) {
    return {
      valid: false,
      clean10: '',
      e164: '',
      error: 'Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9.',
    };
  }

  return {
    valid: true,
    clean10,
    e164: `+91${clean10}`,
  };
}

/**
 * Returns true if an active OTP session must be invalidated because the user edited
 * the login identifier away from the phone number the OTP was originally sent to.
 */
export function shouldResetOtpSessionOnIdentifierChange(params: {
  otpSent: boolean;
  sentToPhone: string;
  nextIdentifier: string;
}): boolean {
  if (!params.otpSent) return false;
  const sentClean10 = String(params.sentToPhone || '').replace(/\D/g, '').slice(-10);
  const nextParsed = parseIndianMobileNumber(params.nextIdentifier);
  if (!nextParsed.valid || !sentClean10) {
    return true;
  }
  return nextParsed.clean10 !== sentClean10;
}

/**
 * Determines whether a persisted pending OTP session (from localStorage or native
 * SharedPreferences) should be restored into LoginPage UI.
 * Prevents background window.focus events from clobbering active verification,
 * overriding a different identifier the user typed, or leaking profile-update OTPs.
 */
export function shouldRestorePendingOtpSession(params: {
  authStep: string;
  hasCompletedAuth: boolean;
  isBusy: boolean;
  currentIdentifier: string;
  pendingPhone: string;
  pendingPurpose?: 'login' | 'profile_update';
}): boolean {
  if (params.authStep !== 'primary') return false;
  if (params.hasCompletedAuth || params.isBusy) return false;
  if (params.pendingPurpose === 'profile_update') return false;

  const pendingParsed = parseIndianMobileNumber(params.pendingPhone);
  if (!pendingParsed.valid) return false;

  const trimmedCurrent = String(params.currentIdentifier || '').trim();
  if (!trimmedCurrent) {
    return true;
  }

  // Never hijack if the user has started typing an email or a different phone number
  if (trimmedCurrent.includes('@')) {
    return false;
  }
  const currentParsed = parseIndianMobileNumber(trimmedCurrent);
  if (!currentParsed.valid) {
    return false;
  }
  return currentParsed.clean10 === pendingParsed.clean10;
}

export function isExpiredOtpErrorCode(code: string): boolean {
  const c = String(code || '').toLowerCase();
  return c === 'auth/code-expired' || c === 'auth/session-expired';
}

export function isRateLimitErrorCode(code: string): boolean {
  const c = String(code || '').toLowerCase();
  return c === 'auth/too-many-requests' || c === 'auth/quota-exceeded';
}

export type OtpProvider = 'fast2sms' | 'firebase';

export const FAST_SMS_ABORT_TIMEOUT_MS = 12000;
export const NATIVE_SLOW_SEND_NOTICE_MS = 15000;
export const OTP_RESEND_COOLDOWN_SECONDS = 30;
export const NATIVE_SLOW_SEND_INFO_MESSAGE = 'Taking longer than usual, please check your signal';

/**
 * Resolves the `forceProvider` override for a phone OTP send attempt.
 * - First send for a phone number (`sendAttempt <= 0`): returns `undefined` (default gateway order).
 * - Resends (`sendAttempt > 0`) for the same number: alternates to the OTHER provider than `lastProvider`
 *   so silent non-delivery on one gateway is covered by the other.
 */
export function resolveNextOtpProvider(params: {
  sendAttempt: number;
  lastProvider: OtpProvider | null | undefined;
}): OtpProvider | undefined {
  if (!Number.isFinite(params.sendAttempt) || params.sendAttempt <= 0) {
    return undefined;
  }
  if (params.lastProvider === 'fast2sms') {
    return 'firebase';
  }
  if (params.lastProvider === 'firebase') {
    return 'fast2sms';
  }
  return undefined;
}

/**
 * Determines whether a non-OK response from `/api/auth/send-phone-otp` should stop immediately
 * with a user-facing validation error or fall through to Firebase Phone Auth.
 * HTTP 429 MUST always fall through to Firebase rather than blocking the user.
 */
export function shouldStopOnFastSmsResponse(params: {
  status: number;
  error?: string;
  fallbackToFirebase?: boolean;
}): boolean {
  if (params.status === 429) {
    return false;
  }
  if (params.status === 400 && Boolean(params.error) && !params.fallbackToFirebase) {
    return true;
  }
  return false;
}

/**
 * Determines whether a Firebase OTP confirmation failure should trigger a single fallback retry
 * against `POST /api/auth/verify-phone-otp` (`{ phone, otp }`, no token) because an earlier
 * Fast2SMS request timed out/aborted with an unknown outcome (`fastSmsMayHaveSent === true`).
 */
export function shouldRetryFast2SmsVerifyAfterFirebaseFailure(params: {
  firebaseErrorCode: string;
  fastSmsMayHaveSent: boolean;
  fastSmsMayHaveSentPhone?: string | null;
  targetPhone?: string | null;
}): boolean {
  if (!params.fastSmsMayHaveSent) return false;
  if (String(params.firebaseErrorCode || '').toLowerCase() !== 'auth/invalid-verification-code') {
    return false;
  }
  const flagDigits = String(params.fastSmsMayHaveSentPhone || '').replace(/\D/g, '').slice(-10);
  const targetDigits = String(params.targetPhone || '').replace(/\D/g, '').slice(-10);
  if (flagDigits && targetDigits && flagDigits !== targetDigits) {
    return false;
  }
  return true;
}

export type RecaptchaDisplayMode = 'invisible' | 'visible';
export type RecaptchaWidgetStatus = 'idle' | 'loading' | 'ready' | 'verified' | 'expired' | 'error';

export const DEFAULT_INVISIBLE_RECAPTCHA_CONTAINER_ID = 'recaptcha-container';
export const DEFAULT_VISIBLE_RECAPTCHA_CONTAINER_ID = 'login-visible-recaptcha-container';

/**
 * Resolves the active DOM host container ID for Firebase RecaptchaVerifier so
 * invisible (hidden) and visible (inline box) verifiers stay isolated in separate
 * containers present in the DOM at the same time.
 */
export function resolveRecaptchaContainerId(
  mode: RecaptchaDisplayMode,
  customContainerId?: string
): string {
  const trimmed = String(customContainerId || '').trim();
  if (mode === 'visible') {
    if (!trimmed || trimmed === DEFAULT_INVISIBLE_RECAPTCHA_CONTAINER_ID) {
      return DEFAULT_VISIBLE_RECAPTCHA_CONTAINER_ID;
    }
    return trimmed;
  }
  return trimmed || DEFAULT_INVISIBLE_RECAPTCHA_CONTAINER_ID;
}

/**
 * Determines whether a web OTP dispatch failure in hidden/invisible mode should
 * automatically reveal the inline visible reCAPTCHA box so the user can manually
 * complete device verification.
 */
export function shouldEscalateToVisibleRecaptcha(params: {
  errorCode?: string;
  errorMessage?: string;
  currentMode: RecaptchaDisplayMode;
  isNativePlatform: boolean;
}): boolean {
  if (params.isNativePlatform) return false;
  if (params.currentMode === 'visible') return false;

  const code = String(params.errorCode || '').toLowerCase();
  const msg = String(params.errorMessage || '').toLowerCase();

  if (
    code === 'auth/unauthorized-domain' ||
    code === 'auth/invalid-phone-number' ||
    code === 'auth/missing-phone-number' ||
    code === 'auth/quota-exceeded' ||
    code === 'auth/operation-not-allowed'
  ) {
    return false;
  }

  return (
    code === 'auth/captcha-check-failed' ||
    code === 'auth/invalid-app-credential' ||
    code === 'auth/internal-error' ||
    msg.includes('recaptcha') ||
    msg.includes('captcha') ||
    msg.includes('timed out waiting for google recaptcha')
  );
}

/**
 * Checks whether the login form may proceed to dispatch OTP given the current
 * captcha visibility mode and verification status.
 */
export function canSubmitWithVisibleRecaptcha(params: {
  captchaMode: RecaptchaDisplayMode;
  captchaStatus: RecaptchaWidgetStatus;
  isNativePlatform: boolean;
}): boolean {
  if (params.isNativePlatform) return true;
  if (params.captchaMode === 'invisible') return true;
  return params.captchaStatus === 'verified';
}

/**
 * Resolves the effective OTP provider override for the current captcha mode:
 * - Hidden/invisible mode keeps the default dual-gateway flow (Fast2SMS primary + Firebase fallback + Resend alternation).
 * - Visible captcha mode explicitly routes through Firebase so the device captcha verification is enforced end-to-end.
 */
export function resolveEffectiveForceProviderForCaptcha(params: {
  baseForceProvider?: OtpProvider;
  captchaMode: RecaptchaDisplayMode;
  isNativePlatform: boolean;
}): OtpProvider | undefined {
  if (params.captchaMode === 'visible') {
    return 'firebase';
  }
  return params.baseForceProvider;
}



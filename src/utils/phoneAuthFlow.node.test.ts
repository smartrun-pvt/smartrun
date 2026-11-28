import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCTION_APP_ORIGIN,
  PRODUCTION_FIREBASE_AUTH_DOMAIN,
  CAPACITOR_APK_HOSTNAME,
  resolvePublicAppOrigin,
  resolveFirebaseAuthDomainForEnv,
  shouldAllowFallbackFirebaseAuthDomain,
  parseIndianMobileNumber,
  shouldResetOtpSessionOnIdentifierChange,
  shouldRestorePendingOtpSession,
  isExpiredOtpErrorCode,
  isRateLimitErrorCode,
  normalizeNativeFirebaseAuthError,
  buildRecaptchaSlotId,
  isRecaptchaAlreadyRenderedError,
  NATIVE_SLOW_SEND_NOTICE_MS,
  NATIVE_SLOW_SEND_INFO_MESSAGE,
  OTP_RESEND_COOLDOWN_SECONDS,
  RATE_LIMIT_ERROR_MESSAGE,
  OTP_TIMEOUT_HINT,
  DEFAULT_INVISIBLE_RECAPTCHA_CONTAINER_ID,
  DEFAULT_VISIBLE_RECAPTCHA_CONTAINER_ID,
  resolveRecaptchaContainerId,
  shouldEscalateToVisibleRecaptcha,
  canSubmitWithVisibleRecaptcha,
} from './firebaseAuthDomain';
import { extractOtpDigits } from './otpAutofill';
import { resolveWebAuthnRpConfig } from './passkeyHelper';
import { resolveApiBaseUrl } from '../lib/apiBase';

test('parseIndianMobileNumber accepts valid Indian formats and rejects overlong/invalid inputs', () => {
  assert.deepEqual(parseIndianMobileNumber('9876543210'), {
    valid: true,
    clean10: '9876543210',
    e164: '+919876543210',
  });
  assert.equal(parseIndianMobileNumber('+91 87774 00280').e164, '+918777400280');
  assert.equal(parseIndianMobileNumber('07001234567').clean10, '7001234567');

  // Regression: never silently truncate 13-digit numbers to a different phone
  assert.equal(parseIndianMobileNumber('9876543210123').valid, false);
  // Regression: reject non-Indian mobile prefixes 0-5
  assert.equal(parseIndianMobileNumber('1234567890').valid, false);
  assert.equal(parseIndianMobileNumber('5999999999').valid, false);
  // Reject email strings
  assert.equal(parseIndianMobileNumber('test9876543210@smartrun.in').valid, false);
});

test('shouldResetOtpSessionOnIdentifierChange invalidates stale OTP when phone changes', () => {
  assert.equal(
    shouldResetOtpSessionOnIdentifierChange({
      otpSent: true,
      sentToPhone: '+919876543210',
      nextIdentifier: '9876543210',
    }),
    false
  );
  assert.equal(
    shouldResetOtpSessionOnIdentifierChange({
      otpSent: true,
      sentToPhone: '+919876543210',
      nextIdentifier: '+91 9876543210',
    }),
    false
  );
  assert.equal(
    shouldResetOtpSessionOnIdentifierChange({
      otpSent: true,
      sentToPhone: '+919876543210',
      nextIdentifier: '9876543219',
    }),
    true
  );
  assert.equal(
    shouldResetOtpSessionOnIdentifierChange({
      otpSent: true,
      sentToPhone: '+919876543210',
      nextIdentifier: 'user@example.com',
    }),
    true
  );
});

test('shouldRestorePendingOtpSession blocks focus hijacking and profile_update leakage', () => {
  assert.equal(
    shouldRestorePendingOtpSession({
      authStep: 'primary',
      hasCompletedAuth: false,
      isBusy: false,
      currentIdentifier: '',
      pendingPhone: '+919876543210',
      pendingPurpose: 'login',
    }),
    true
  );
  assert.equal(
    shouldRestorePendingOtpSession({
      authStep: 'primary',
      hasCompletedAuth: false,
      isBusy: true,
      currentIdentifier: '9876543210',
      pendingPhone: '+919876543210',
      pendingPurpose: 'login',
    }),
    false
  );
  assert.equal(
    shouldRestorePendingOtpSession({
      authStep: 'primary',
      hasCompletedAuth: false,
      isBusy: false,
      currentIdentifier: '',
      pendingPhone: '+919876543210',
      pendingPurpose: 'profile_update',
    }),
    false
  );
  assert.equal(
    shouldRestorePendingOtpSession({
      authStep: 'primary',
      hasCompletedAuth: false,
      isBusy: false,
      currentIdentifier: '9999988888',
      pendingPhone: '+919876543210',
      pendingPurpose: 'login',
    }),
    false
  );
});

test('OTP error classification and SMS digit extraction behave accurately', () => {
  assert.equal(isExpiredOtpErrorCode('auth/code-expired'), true);
  assert.equal(isExpiredOtpErrorCode('auth/session-expired'), true);
  assert.equal(isRateLimitErrorCode('auth/too-many-requests'), true);
  assert.equal(isRateLimitErrorCode('auth/quota-exceeded'), true);
  assert.equal(
    normalizeNativeFirebaseAuthError({
      message: 'The sms code has expired. Please re-send the verification code.',
    }).code,
    'auth/code-expired'
  );
  assert.equal(
    extractOtpDigits('482910 is your SmartRun verification code. @www.smartrun.in #482910'),
    '482910'
  );
  assert.notEqual(
    buildRecaptchaSlotId('recaptcha-container', 1),
    buildRecaptchaSlotId('recaptcha-container', 2)
  );
  assert.equal(
    isRecaptchaAlreadyRenderedError(new Error('reCAPTCHA has already been rendered in this element')),
    true
  );
});

test('APK and production web strictly enforce smartrun.in (never localhost or firebaseapp.com)', () => {
  assert.equal(PRODUCTION_APP_ORIGIN, 'https://www.smartrun.in');
  assert.equal(PRODUCTION_FIREBASE_AUTH_DOMAIN, 'www.smartrun.in');
  assert.equal(CAPACITOR_APK_HOSTNAME, 'app.smartrun.in');

  // APK running on https://app.smartrun.in must call https://www.smartrun.in/api/*
  assert.equal(
    resolveApiBaseUrl({
      isNativePlatform: true,
      platform: 'android',
      origin: 'https://app.smartrun.in',
      hostname: 'app.smartrun.in',
    }),
    'https://www.smartrun.in'
  );

  // Even if an accidental localhost env var is passed into an APK build, it is blocked
  assert.equal(
    resolveApiBaseUrl({
      explicitApiUrl: 'http://localhost:3000',
      isNativePlatform: true,
      platform: 'android',
      origin: 'https://app.smartrun.in',
      hostname: 'app.smartrun.in',
    }),
    'https://www.smartrun.in'
  );

  // Live smartrun.in web uses relative same-origin API routes (never localhost)
  assert.equal(
    resolveApiBaseUrl({
      explicitApiUrl: 'http://localhost:3000',
      isNativePlatform: false,
      platform: 'web',
      origin: 'https://www.smartrun.in',
      hostname: 'www.smartrun.in',
    }),
    ''
  );

  // Firebase authDomain must resolve to www.smartrun.in on APK and smartrun.in hosts
  assert.equal(
    resolveFirebaseAuthDomainForEnv({
      configuredDomain: 'localhost',
      isNativePlatform: true,
      windowHostname: 'app.smartrun.in',
      fallbackAuthDomain: 'gen-lang-client-0708778333.firebaseapp.com',
    }),
    'www.smartrun.in'
  );
  assert.equal(
    resolveFirebaseAuthDomainForEnv({
      configuredDomain: '',
      isNativePlatform: false,
      windowHostname: 'smartrun.in',
      fallbackAuthDomain: 'gen-lang-client-0708778333.firebaseapp.com',
    }),
    'www.smartrun.in'
  );
  assert.equal(
    shouldAllowFallbackFirebaseAuthDomain({ isNativePlatform: true, windowHostname: 'app.smartrun.in' }),
    false
  );
  assert.equal(
    shouldAllowFallbackFirebaseAuthDomain({ isNativePlatform: false, windowHostname: 'www.smartrun.in' }),
    false
  );
  assert.equal(
    shouldAllowFallbackFirebaseAuthDomain({ isNativePlatform: false, windowHostname: 'localhost' }),
    true
  );

  // Public origin always resolves to https://www.smartrun.in
  assert.equal(
    resolvePublicAppOrigin({
      isNativePlatform: true,
      windowOrigin: 'https://app.smartrun.in',
      windowHostname: 'app.smartrun.in',
    }),
    'https://www.smartrun.in'
  );

  // Passkeys from APK https://app.smartrun.in resolve rpID smartrun.in
  const rp = resolveWebAuthnRpConfig({
    host: 'www.smartrun.in',
    origin: 'https://app.smartrun.in',
    isNativeAndroid: true,
  });
  assert.equal(rp.rpID, 'smartrun.in');
  assert.ok(rp.expectedOrigins.includes('https://app.smartrun.in'));
  assert.ok(rp.expectedOrigins.includes('https://www.smartrun.in'));
});

test('AndroidManifest HTTPS App Links scope to app routes so /__/auth/* is never hijacked from Firebase RecaptchaActivity', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const manifest = fs.readFileSync(
    path.resolve(process.cwd(), 'android/app/src/main/AndroidManifest.xml'),
    'utf8'
  );
  const autoVerifyMatch = manifest.match(/<intent-filter[^>]*android:autoVerify="true"[^>]*>([\s\S]*?)<\/intent-filter>/);
  assert.ok(autoVerifyMatch, 'Expected android:autoVerify="true" App Link intent-filter');
  const filterBody = autoVerifyMatch[1];
  // Must declare explicit path/pathPrefix entries instead of wildcard host-only matching
  assert.match(filterBody, /android:pathPrefix="\/electrical"/);
  assert.match(filterBody, /android:pathPrefix="\/login"/);
  assert.doesNotMatch(filterBody, /\/__\/auth/);
  assert.doesNotMatch(filterBody, /\/__\/firebase/);
});

test('Firebase-only OTP reliability policy: 60s resend cooldown, slow-send notice, rate-limit & timeout copy', () => {
  assert.equal(NATIVE_SLOW_SEND_NOTICE_MS, 15000);
  assert.equal(OTP_RESEND_COOLDOWN_SECONDS, 60);
  assert.equal(
    NATIVE_SLOW_SEND_INFO_MESSAGE,
    'Still sending... a verification page may open, please complete it.'
  );
  assert.equal(
    RATE_LIMIT_ERROR_MESSAGE,
    'Too many attempts. Please wait 15-30 minutes and try again, or sign in with Google.'
  );
  assert.equal(
    OTP_TIMEOUT_HINT,
    'If you did not get the SMS, check network/DND and try again after a minute.'
  );
});

test('Firebase web reCAPTCHA policy: isolated containers, visible gating, and invisible-first escalation', () => {
  // Hidden and visible containers stay strictly isolated
  assert.equal(
    resolveRecaptchaContainerId('invisible'),
    DEFAULT_INVISIBLE_RECAPTCHA_CONTAINER_ID
  );
  assert.equal(
    resolveRecaptchaContainerId('visible'),
    DEFAULT_VISIBLE_RECAPTCHA_CONTAINER_ID
  );
  assert.equal(
    resolveRecaptchaContainerId('visible', DEFAULT_INVISIBLE_RECAPTCHA_CONTAINER_ID),
    DEFAULT_VISIBLE_RECAPTCHA_CONTAINER_ID
  );
  assert.equal(
    resolveRecaptchaContainerId('visible', 'custom-visible-host'),
    'custom-visible-host'
  );

  // Visible mode on web gates submission until user ticks captcha; hidden mode and native APK proceed directly
  assert.equal(
    canSubmitWithVisibleRecaptcha({ captchaMode: 'invisible', captchaStatus: 'idle', isNativePlatform: false }),
    true
  );
  assert.equal(
    canSubmitWithVisibleRecaptcha({ captchaMode: 'visible', captchaStatus: 'ready', isNativePlatform: false }),
    false
  );
  assert.equal(
    canSubmitWithVisibleRecaptcha({ captchaMode: 'visible', captchaStatus: 'expired', isNativePlatform: false }),
    false
  );
  assert.equal(
    canSubmitWithVisibleRecaptcha({ captchaMode: 'visible', captchaStatus: 'verified', isNativePlatform: false }),
    true
  );
  assert.equal(
    canSubmitWithVisibleRecaptcha({ captchaMode: 'visible', captchaStatus: 'idle', isNativePlatform: true }),
    true
  );

  // Escalates from hidden -> visible on web captcha failures, never on native, domain, or rate-limit/quota errors
  assert.equal(
    shouldEscalateToVisibleRecaptcha({
      errorCode: 'auth/captcha-check-failed',
      currentMode: 'invisible',
      isNativePlatform: false,
    }),
    true
  );
  assert.equal(
    shouldEscalateToVisibleRecaptcha({
      errorCode: 'auth/network-request-failed',
      errorMessage: 'Verification timed out waiting for Google reCAPTCHA / Firebase SMS.',
      currentMode: 'invisible',
      isNativePlatform: false,
    }),
    true
  );
  assert.equal(
    shouldEscalateToVisibleRecaptcha({
      errorCode: 'auth/captcha-check-failed',
      currentMode: 'visible',
      isNativePlatform: false,
    }),
    false
  );
  assert.equal(
    shouldEscalateToVisibleRecaptcha({
      errorCode: 'auth/captcha-check-failed',
      currentMode: 'invisible',
      isNativePlatform: true,
    }),
    false
  );
  assert.equal(
    shouldEscalateToVisibleRecaptcha({
      errorCode: 'auth/unauthorized-domain',
      currentMode: 'invisible',
      isNativePlatform: false,
    }),
    false
  );
  assert.equal(
    shouldEscalateToVisibleRecaptcha({
      errorCode: 'auth/too-many-requests',
      currentMode: 'invisible',
      isNativePlatform: false,
    }),
    false
  );
  assert.equal(
    shouldEscalateToVisibleRecaptcha({
      errorCode: 'auth/quota-exceeded',
      currentMode: 'invisible',
      isNativePlatform: false,
    }),
    false
  );
});

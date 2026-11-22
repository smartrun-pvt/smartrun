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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideStartupLocationAction,
  isLocationPromptSuppressedRoute,
  resolveAreaFromCoordinates
} from './geolocationHelper';

test('decideStartupLocationAction shows prompt on launch when permission is prompt', () => {
  assert.equal(
    decideStartupLocationAction({
      permissionStatus: 'prompt',
      isPromptDismissedInSession: false,
      hasActiveSavedAddress: false,
      isSuppressedRoute: false
    }),
    'show_prompt'
  );
});

test('decideStartupLocationAction shows prompt even when logged-in user has active saved address and permission not granted', () => {
  assert.equal(
    decideStartupLocationAction({
      permissionStatus: 'prompt',
      isPromptDismissedInSession: false,
      hasActiveSavedAddress: true,
      isSuppressedRoute: false
    }),
    'show_prompt'
  );

  assert.equal(
    decideStartupLocationAction({
      permissionStatus: 'denied',
      isPromptDismissedInSession: false,
      hasActiveSavedAddress: true,
      isSuppressedRoute: false
    }),
    'show_prompt'
  );
});

test('decideStartupLocationAction never fetches GPS automatically when permission is denied or unsupported', () => {
  assert.equal(
    decideStartupLocationAction({
      permissionStatus: 'denied',
      isPromptDismissedInSession: true,
      hasActiveSavedAddress: false,
      isSuppressedRoute: false
    }),
    'none'
  );

  assert.equal(
    decideStartupLocationAction({
      permissionStatus: 'unsupported',
      isPromptDismissedInSession: true,
      hasActiveSavedAddress: false,
      isSuppressedRoute: false
    }),
    'none'
  );
});

test('decideStartupLocationAction suppresses prompt on auth/legal routes or once dismissed in session', () => {
  assert.equal(
    decideStartupLocationAction({
      permissionStatus: 'prompt',
      isPromptDismissedInSession: false,
      hasActiveSavedAddress: false,
      isSuppressedRoute: true
    }),
    'none'
  );

  assert.equal(
    decideStartupLocationAction({
      permissionStatus: 'prompt',
      isPromptDismissedInSession: true,
      hasActiveSavedAddress: false,
      isSuppressedRoute: false
    }),
    'none'
  );
});

test('decideStartupLocationAction fetches current GPS silently when permission is granted and no saved address is pinned', () => {
  assert.equal(
    decideStartupLocationAction({
      permissionStatus: 'granted',
      isPromptDismissedInSession: false,
      hasActiveSavedAddress: false,
      isSuppressedRoute: false
    }),
    'fetch_current'
  );

  assert.equal(
    decideStartupLocationAction({
      permissionStatus: 'granted',
      isPromptDismissedInSession: false,
      hasActiveSavedAddress: true,
      isSuppressedRoute: false
    }),
    'none'
  );
});

test('isLocationPromptSuppressedRoute detects auth/legal routes and allows browsing routes', () => {
  assert.equal(isLocationPromptSuppressedRoute('/'), false);
  assert.equal(isLocationPromptSuppressedRoute('/electrical'), false);
  assert.equal(isLocationPromptSuppressedRoute('/construction'), false);
  assert.equal(isLocationPromptSuppressedRoute('/technicians'), false);

  assert.equal(isLocationPromptSuppressedRoute('/login'), true);
  assert.equal(isLocationPromptSuppressedRoute('/privacy-policy'), true);
  assert.equal(isLocationPromptSuppressedRoute('/terms'), true);
  assert.equal(isLocationPromptSuppressedRoute('/account-deletion'), true);
});

test('resolveAreaFromCoordinates resolves serviceable Kolkata area and flags outside-Kolkata coords', () => {
  const saltLake = resolveAreaFromCoordinates(22.5867, 88.4171, 'Sector 1, Salt Lake', '700064');
  assert.equal(saltLake.serviceable, true);
  assert.equal(saltLake.pincode, '700064');
  assert.equal(saltLake.exactStreet, 'Sector 1, Salt Lake');

  const outside = resolveAreaFromCoordinates(28.6139, 77.209, 'Connaught Place, New Delhi', '110001');
  assert.equal(outside.serviceable, false);
  assert.equal(outside.pincode, '110001');
  assert.equal(outside.name, 'Connaught Place, New Delhi');
});

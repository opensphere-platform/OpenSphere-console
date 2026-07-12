import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialCommitError, shouldResetExistingTotp } from './credential-onboarding.mjs';

test('new accounts do not attempt to remove a nonexistent TOTP credential', () => {
  assert.equal(shouldResetExistingTotp({ primary: null, mfaregstate: 'None' }), false);
  assert.equal(shouldResetExistingTotp({ primary: { uuid: 'existing' } }), true);
});

test('MFA policy mismatch is not reported as weak password', () => {
  assert.match(credentialCommitError({ can_commit: false, warnings: 'MfaRequired' }), /requires MFA/);
  assert.match(credentialCommitError({ can_commit: false, warnings: ['MfaRequired'] }), /requires MFA/);
  assert.equal(credentialCommitError({ can_commit: true, warnings: [] }), null);
});

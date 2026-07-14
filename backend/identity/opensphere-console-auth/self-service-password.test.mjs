import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  MIN_PASSWORD_LENGTH,
  validateSelfPasswordChange,
  passwordUpdateOutcome,
  privilegedInitStep,
  credentialUpdateBeginRequest,
  passwordCredentialRequest,
} from './self-service-password.mjs';

test('accepts a valid, changed, confirmed password', () => {
  assert.deepEqual(
    validateSelfPasswordChange({ currentPassword: 'old-secret-1', newPassword: 'maple-river-88', confirmPassword: 'maple-river-88' }),
    { ok: true },
  );
});

test('rejects missing current password (re-authentication is mandatory)', () => {
  assert.deepEqual(
    validateSelfPasswordChange({ currentPassword: '', newPassword: 'maple-river-88', confirmPassword: 'maple-river-88' }),
    { ok: false, error: 'current_password_required' },
  );
});

test('rejects a new password shorter than the minimum', () => {
  const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
  assert.deepEqual(
    validateSelfPasswordChange({ currentPassword: 'old-secret-1', newPassword: short, confirmPassword: short }),
    { ok: false, error: 'new_password_too_short', minimumLength: MIN_PASSWORD_LENGTH },
  );
});

test('rejects a confirmation mismatch', () => {
  assert.deepEqual(
    validateSelfPasswordChange({ currentPassword: 'old-secret-1', newPassword: 'maple-river-88', confirmPassword: 'maple-river-89' }),
    { ok: false, error: 'password_confirmation_mismatch' },
  );
});

test('rejects reusing the current password', () => {
  assert.deepEqual(
    validateSelfPasswordChange({ currentPassword: 'maple-river-88', newPassword: 'maple-river-88', confirmPassword: 'maple-river-88' }),
    { ok: false, error: 'password_unchanged' },
  );
});

test('treats non-string / missing fields as absent, never throws', () => {
  assert.deepEqual(validateSelfPasswordChange(undefined), { ok: false, error: 'current_password_required' });
  assert.deepEqual(
    validateSelfPasswordChange({ currentPassword: 12345, newPassword: {}, confirmPassword: [] }),
    { ok: false, error: 'current_password_required' },
  );
});

test('password update outcome is ok only when Kanidm reports can_commit', () => {
  assert.deepEqual(passwordUpdateOutcome({ can_commit: true }), { ok: true });
  assert.deepEqual(passwordUpdateOutcome({ can_commit: false }), { ok: false, error: 'password_policy_rejected' });
  assert.deepEqual(passwordUpdateOutcome({}), { ok: false, error: 'password_policy_rejected' });
});

test('MFA-required is mapped distinctly from a weak-password rejection', () => {
  assert.deepEqual(passwordUpdateOutcome({ can_commit: false, warnings: 'MfaRequired' }), { ok: false, error: 'mfa_required' });
  assert.deepEqual(passwordUpdateOutcome({ can_commit: false, warnings: ['MfaRequired'] }), { ok: false, error: 'mfa_required' });
});

// ---- Kanidm 1.4.6 wire-contract builders (asserted directly, not by source regex) ----

test('privileged re-auth uses AuthStep::Init2 with privileged=true and a token issuance', () => {
  // Kanidm 1.4.6 proto/src/v1/auth.rs: AuthStep::Init2 { username, issue, privileged }.
  // A plain login session is privilege-capable read-only, so credential-update writes need
  // an explicitly privileged session.
  assert.deepEqual(privilegedInitStep('alice'), {
    init2: { username: 'alice', issue: 'token', privileged: true },
  });
});

test('credential-update begin is a GET on /v1/person/{id}/_credential/_update', () => {
  // libs/client/src/person.rs idm_account_credential_update_begin => GET (not POST).
  const req = credentialUpdateBeginRequest('bob smith');
  assert.equal(req.method, 'GET');
  assert.equal(req.path, '/v1/person/bob%20smith/_credential/_update');
});

test('CURequest password is serialized with a lowercase key', () => {
  assert.deepEqual(passwordCredentialRequest('maple-river-88'), { password: 'maple-river-88' });
});

// Contract guard: the server must derive the target from the authenticated session and must
// never trust a client-supplied username, must re-authenticate with a PRIVILEGED session,
// must begin the credential update with GET, must set ONLY the password (no TOTP/passkey
// reset), and must audit through the durable fail-closed store.
test('server binds the change to the session subject and preserves other credentials', () => {
  const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleAccountPasswordChange');
  const end = source.indexOf('// ---- discovery ----', start);
  assert.ok(start >= 0 && end > start, 'handler must exist and be bounded');
  const handler = source.slice(start, end);
  assert.match(handler, /session\.username/, 'target username must come from the verified session');
  assert.doesNotMatch(handler, /body\.username|form\.username/, 'must never read a client-supplied username');
  assert.match(handler, /kanidmPrivilegedAuthSession\(/, 'must re-authenticate with a privileged session');
  assert.match(handler, /credentialUpdateBeginRequest\(/, 'must use the GET credential-update-begin contract');
  assert.doesNotMatch(handler, /kanidmReq\('POST',\s*`?\/v1\/person\/[^)]*_credential\/_update/, 'must not POST to credential-update begin');
  // No Kanidm credential-update operation other than the single password set may appear.
  assert.doesNotMatch(handler, /totpremove|totpgenerate|totpverify|passkeyinit|passkeyfinish/, 'must not touch TOTP/passkey credentials');
  assert.match(handler, /publishAuthAudit\([^)]*'attempt'/, 'must open a fail-closed audit before mutating');
  assert.match(handler, /publishAuthAudit\([^)]*'accepted'/, 'must record durable success');
  assert.match(handler, /rotateBrowserSessionEpoch\(session\.sub, username\)/, 'must revoke all prior browser sessions before commit');
  assert.ok(
    handler.indexOf('rotateBrowserSessionEpoch(session.sub, username)') < handler.indexOf('cuCommit(cuSession)'),
    'session revocation must fail closed before the password commit',
  );
});

test('browser tokens are bound to a durable session epoch', () => {
  const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /payloadBase = \{[^\n]*session_epoch: sessionEpoch/, 'new browser tokens must carry the current epoch');
  assert.match(source, /validSessionEpoch\(pl\.session_epoch\) !== sessionEpoch/, 'introspection must reject tokens from an old epoch');
  assert.match(source, /credential-state\/session/, 'session epoch must live in the durable credential store');
});

test('interactive Console login stays non-privileged (legacy Init, never Init2)', () => {
  const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function kanidmAuthSession');
  const end = source.indexOf('async function kanidmAuthenticate', start);
  assert.ok(start >= 0 && end > start, 'kanidmAuthSession must exist and be bounded');
  const login = source.slice(start, end);
  assert.match(login, /\{ init: username \}/, 'interactive login must use the legacy non-privileged Init step');
  assert.doesNotMatch(login, /init2|privileged/, 'interactive login must not be promoted to a privileged session');
});

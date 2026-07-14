// Self-service password change — pure decision logic, extracted so it can be unit tested
// without a live Kanidm. The BFF endpoint (server.mjs) wires these helpers to:
//   1. the authoritative Console session subject (never a client-supplied username),
//   2. a fresh Kanidm re-authentication with the CURRENT password, and
//   3. a self-driven credential-update session that sets ONLY the password.
// Kanidm remains the final authority on password policy; these helpers only do the
// cheap client-mirroring checks and map Kanidm outcomes to stable, secret-free codes.

export const MIN_PASSWORD_LENGTH = 8;

// Basic input validation. Deliberately conservative: the definitive policy verdict
// (length, complexity, breach lists, …) is Kanidm's, returned as `can_commit`.
export function validateSelfPasswordChange(input) {
  const currentPassword = typeof input?.currentPassword === 'string' ? input.currentPassword : '';
  const newPassword = typeof input?.newPassword === 'string' ? input.newPassword : '';
  const confirmPassword = typeof input?.confirmPassword === 'string' ? input.confirmPassword : '';
  if (!currentPassword) return { ok: false, error: 'current_password_required' };
  if (!newPassword) return { ok: false, error: 'new_password_required' };
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: 'new_password_too_short', minimumLength: MIN_PASSWORD_LENGTH };
  }
  if (newPassword !== confirmPassword) return { ok: false, error: 'password_confirmation_mismatch' };
  if (newPassword === currentPassword) return { ok: false, error: 'password_unchanged' };
  return { ok: true };
}

// ---- Kanidm 1.4.6 wire contracts ----------------------------------------------------
// Kept as pure builders so the exact request method/shape can be asserted in unit tests
// without a live Kanidm, and so the security-critical details cannot silently regress.

// AuthStep::Init2 { username, issue: AuthIssueSession, privileged: bool }
// (kanidm proto/src/v1/auth.rs). A normal Console login uses AuthStep::Init and yields a
// privilege-capable *read-only* session; sensitive writes (credential-update begin) require
// a *privileged* session. Password-change re-authentication therefore uses Init2 with
// privileged=true. issue='token' keeps a bearer token usable as `Authorization`.
// IMPORTANT: normal interactive login must NOT use this — it stays non-privileged.
export function privilegedInitStep(username) {
  return { init2: { username, issue: 'token', privileged: true } };
}

// libs/client/src/person.rs `idm_account_credential_update_begin` =>
//   GET /v1/person/{id}/_credential/_update   (a GET, NOT a POST)
// Response body is the tuple [CUSessionToken, CUStatus].
export function credentialUpdateBeginRequest(username) {
  return { method: 'GET', path: `/v1/person/${encodeURIComponent(username)}/_credential/_update` };
}

// CURequest::Password is externally tagged with a lowercase key: { "password": "…" }.
// Applied via POST /v1/credential/_update with body [CURequest, CUSessionToken].
export function passwordCredentialRequest(newPassword) {
  return { password: newPassword };
}

// Map a Kanidm credential-update `_update` (apply) result for the password field into a
// stable outcome the client can act on. Never surfaces raw Kanidm internals or secrets.
export function passwordUpdateOutcome(applyStatus) {
  if (applyStatus?.can_commit === true) return { ok: true };
  const warnings = Array.isArray(applyStatus?.warnings)
    ? applyStatus.warnings
    : [applyStatus?.warnings].filter(Boolean);
  if (warnings.includes('MfaRequired')) return { ok: false, error: 'mfa_required' };
  return { ok: false, error: 'password_policy_rejected' };
}

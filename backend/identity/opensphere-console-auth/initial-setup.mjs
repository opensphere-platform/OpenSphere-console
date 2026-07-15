const USERNAME = /^[a-z][a-z0-9._-]{1,31}$/;
const RESERVED = new Set(['admin', 'idm_admin', 'anonymous']);

export function initialSetupView(configMap, now = Date.now()) {
  const data = configMap?.data || {};
  const state = data.state || 'complete';
  const claimedAt = Date.parse(data.claimedAt || '');
  const stale = state === 'configuring' && (!Number.isFinite(claimedAt) || now - claimedAt > 10 * 60 * 1000);
  return {
    required: state === 'required' || stale,
    busy: state === 'configuring' && !stale,
    username: data.username || 'opensphere-admin',
    displayName: data.displayName || 'OpenSphere Administrator',
    email: data.email || 'admin@opensphere.local',
  };
}

export function validateInitialSetup(body) {
  const username = String(body?.username || '').trim();
  const displayName = String(body?.displayName || '').trim();
  const email = String(body?.email || '').trim();
  const password = String(body?.password || '');
  const passwordConfirm = String(body?.passwordConfirm || '');
  if (!USERNAME.test(username) || RESERVED.has(username)) return { ok: false, error: 'invalid_username' };
  if (!displayName || displayName.length > 128) return { ok: false, error: 'invalid_display_name' };
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) return { ok: false, error: 'invalid_email' };
  if (password.length < 12 || password.length > 256) return { ok: false, error: 'password_policy' };
  if (password !== passwordConfirm) return { ok: false, error: 'password_mismatch' };
  return { ok: true, value: { username, displayName, email, password } };
}

export function initialSetupData(current, state, fields = {}) {
  const data = { ...(current?.data || {}), ...fields, state };
  for (const key of ['claimHash', 'claimedAt']) {
    if (fields[key] === null) delete data[key];
  }
  return data;
}

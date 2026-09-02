import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import { createDatabaseSessionResolver, readBrowserSessionProof } from './session-resolver.mjs';
import { validateAvatarSelection, validateAvatarUpload } from './profile-avatar.mjs';

const PENDING_MFA_TTL_MS = 5 * 60 * 1000;
const IDLE_TTL_MS = 12 * 60 * 60 * 1000;
const REFRESH_WINDOW_MS = 30 * 1000;
const SESSION_DURATION_MS = Object.freeze({
  browser: 24 * 60 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '14d': 14 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
});

function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function requestDigest(value) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function credentials(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('ValidationFailed', 'login body must be an object', 400);
  const unknown = Object.keys(body).filter((key) => !['email', 'password'].includes(key));
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  if (unknown.length || email.length < 3 || email.length > 254 || !email.includes('@')
      || password.length < 1 || password.length > 1024) {
    fail('ValidationFailed', 'email and password are required', 400);
  }
  return { email, password };
}

function passwordRecoveryInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('ValidationFailed', 'password recovery body must be an object', 400);
  }
  const unknown = Object.keys(body).filter((key) => !['recoveryAccessToken', 'password'].includes(key));
  const recoveryAccessToken = String(body.recoveryAccessToken || '');
  const password = String(body.password || '');
  if (unknown.length || recoveryAccessToken.length < 64 || recoveryAccessToken.length > 16384
      || !/^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/u.test(recoveryAccessToken)
      || password.length < 12 || password.length > 1024) {
    fail('ValidationFailed', 'a valid recovery proof and password of at least 12 characters are required', 400);
  }
  return { recoveryAccessToken, password };
}

function passwordRecoveryLinkInput(body, idempotencyKey) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'reason')) {
    fail('ValidationFailed', 'password recovery link request requires exactly reason', 400);
  }
  const reason = String(body.reason || '').trim();
  const key = String(idempotencyKey || '').trim();
  if (reason.length < 8 || reason.length > 500 || /[\r\n]/u.test(reason)
      || key.length < 8 || key.length > 256 || /[\r\n]/u.test(key)) {
    fail('ValidationFailed', 'password recovery link request is invalid', 400);
  }
  return { reason, idempotencyKey: key };
}

function initialAdministratorInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('ValidationFailed', 'initial administrator body must be an object', 400);
  }
  const allowed = ['username', 'displayName', 'email', 'password', 'passwordConfirm'];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  const username = String(body.username || '').trim().toLowerCase();
  const displayName = String(body.displayName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const passwordConfirm = String(body.passwordConfirm || '');
  if (unknown.length || !/^[a-z][a-z0-9._-]{1,31}$/u.test(username)
      || displayName.length < 1 || displayName.length > 128
      || email.length < 3 || email.length > 254 || !/^[^@\s]+@[^@\s]+[.][^@\s]+$/u.test(email)
      || password.length < 12 || password.length > 1024 || password !== passwordConfirm) {
    fail('ValidationFailed', 'initial administrator input is invalid', 400);
  }
  return { username, displayName, email, password };
}

const MANAGED_ROLES = new Set(['console-admins', 'console-operators', 'console-viewers']);

function managedRoleChangeInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('ValidationFailed', 'managed role body must be an object', 400);
  }
  const unknown = Object.keys(body).filter((key) => !['op', 'group', 'reason'].includes(key));
  const operation = String(body.op || '').trim().toLowerCase();
  const role = String(body.group || '').trim();
  const reason = String(body.reason || '').trim();
  if (unknown.length || !['add', 'remove'].includes(operation) || !MANAGED_ROLES.has(role)
      || reason.length < 8 || reason.length > 500 || /[\r\n]/u.test(reason)) {
    fail('ValidationFailed', 'managed role change is invalid', 400);
  }
  return { operation, role, reason };
}

function managedSubject(value) {
  const subjectId = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(subjectId)) {
    fail('ValidationFailed', 'managed identity subject is invalid', 400);
  }
  return subjectId;
}

function managedReason(value) {
  const reason = String(value || '').trim();
  if (reason.length < 8 || reason.length > 500 || /[\r\n]/u.test(reason)) {
    fail('ValidationFailed', 'managed identity reason is invalid', 400);
  }
  return reason;
}

function managedIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (key.length < 8 || key.length > 256 || /[\r\n]/u.test(key)) {
    fail('ValidationFailed', 'managed identity idempotency key is invalid', 400);
  }
  return key;
}

function managedCreateInput(body, idempotencyKey) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('ValidationFailed', 'managed identity creation body must be an object', 400);
  }
  const unknown = Object.keys(body).filter((key) => !['username', 'displayName', 'email', 'roles', 'reason'].includes(key));
  const username = String(body.username || '').trim().toLowerCase();
  const displayName = String(body.displayName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const roles = Array.isArray(body.roles) ? body.roles.map((role) => String(role).trim()) : [];
  const uniqueRoles = [...new Set(roles)].sort();
  if (unknown.length || !/^[a-z][a-z0-9._-]{1,62}$/u.test(username)
      || displayName.length < 1 || displayName.length > 120
      || /[\r\n\u0000-\u001f\u007f]/u.test(displayName)
      || email.length < 3 || email.length > 254 || !/^[^@\s]+@[^@\s]+[.][^@\s]+$/u.test(email)
      || uniqueRoles.length !== roles.length || uniqueRoles.some((role) => !MANAGED_ROLES.has(role))) {
    fail('ValidationFailed', 'managed identity creation input is invalid', 400);
  }
  return { username, displayName, email, roles: uniqueRoles, reason: managedReason(body.reason), idempotencyKey: managedIdempotencyKey(idempotencyKey) };
}

function managedProfileInput(body, idempotencyKey) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['displayName', 'email', 'reason'].includes(key))) {
    fail('ValidationFailed', 'managed identity profile body is invalid', 400);
  }
  const displayName = String(body.displayName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  if (displayName.length < 1 || displayName.length > 120
      || /[\r\n\u0000-\u001f\u007f]/u.test(displayName)
      || email.length < 3 || email.length > 254 || !/^[^@\s]+@[^@\s]+[.][^@\s]+$/u.test(email)) {
    fail('ValidationFailed', 'managed identity profile input is invalid', 400);
  }
  return { displayName, email, reason: managedReason(body.reason), idempotencyKey: managedIdempotencyKey(idempotencyKey) };
}

function managedEnabledInput(body, idempotencyKey) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['enabled', 'reason'].includes(key))
      || typeof body.enabled !== 'boolean') {
    fail('ValidationFailed', 'managed identity enabled body is invalid', 400);
  }
  return { enabled: body.enabled, reason: managedReason(body.reason), idempotencyKey: managedIdempotencyKey(idempotencyKey) };
}

function managedReasonInput(body, idempotencyKey) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'reason')) {
    fail('ValidationFailed', 'managed identity action requires exactly reason', 400);
  }
  return { reason: managedReason(body.reason), idempotencyKey: managedIdempotencyKey(idempotencyKey) };
}

function uncertain(error, message) {
  if (error && typeof error === 'object') {
    error.sideEffect = 'unknown';
    return error;
  }
  return Object.assign(new Error(message), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'unknown' });
}

async function mapBounded(items, mapper, concurrency = 8) {
  const output = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    output.push(...await Promise.all(items.slice(offset, offset + concurrency).map(mapper)));
  }
  return output;
}

function cookie(name, value, maxAge, httpOnly = false, persistent = true) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    ...(httpOnly ? ['HttpOnly'] : []),
    'Secure',
    'SameSite=Strict',
    ...(persistent ? [`Max-Age=${Math.floor(maxAge / 1000)}`] : []),
  ].join('; ');
}

function sessionPersistence(value) {
  const persistence = value == null ? '24h' : String(value);
  if (!Object.hasOwn(SESSION_DURATION_MS, persistence)) {
    fail('AuthorityUnavailable', 'Supabase Auth returned an invalid session persistence policy', 503);
  }
  return persistence;
}

function sessionPreferenceInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'duration')) {
    fail('ValidationFailed', 'session preference requires exactly duration', 400);
  }
  const duration = String(body.duration || '');
  if (!Object.hasOwn(SESSION_DURATION_MS, duration)) {
    fail('ValidationFailed', 'session preference duration is invalid', 400);
  }
  return duration;
}

function sessionPreferenceProjection(duration) {
  return Object.freeze({
    duration: sessionPersistence(duration),
    defaultDuration: '24h',
    idleTimeoutHours: 12,
    appliesTo: 'next-login',
  });
}

const SESSION_EVENT_NAMES = new Set([
  'login', 'refresh', 'step_up', 'revoke', 'revoke_all', 'refresh_rejected',
]);
const SESSION_EVENT_RESULTS = new Set(['ok', 'pending', 'rejected', 'error']);

function sessionEventLimit(value) {
  if (value == null || value === '') return 50;
  if (!/^[1-9][0-9]{0,2}$/u.test(String(value)) || Number(value) > 100) {
    fail('ValidationFailed', 'session event limit must be between 1 and 100', 400);
  }
  return Number(value);
}

export function createIdentitySessionBroker({
  store,
  authClient,
  storageClient,
  credentialCipher,
  publicOrigin,
  randomBytes = systemRandomBytes,
  clock = () => new Date(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!store?.issueSession) throw new TypeError('session issue store is required');
  if (!store?.getPendingMfa || !store?.activateMfa) throw new TypeError('session MFA store is required');
  if (!store?.getRefreshCredentials || !store?.rotateCredentials || !store?.rejectRefresh) throw new TypeError('session refresh store is required');
  if (!store?.touchActivity) throw new TypeError('session activity store is required');
  if (!store?.listOwnedSessions || !store?.revokeOwnedSession || !store?.revokeAllOwnedSessions) {
    throw new TypeError('owned session management store is required');
  }
  if (!authClient?.authenticatePassword || !authClient?.completeTotp || !authClient?.refreshSession || !authClient?.logout) throw new TypeError('Supabase Auth client is required');
  if (!credentialCipher?.encrypt || !credentialCipher?.decrypt) throw new TypeError('session credential cipher is required');
  if (typeof randomBytes !== 'function') throw new TypeError('secure random byte source is required');
  if (typeof wait !== 'function') throw new TypeError('bounded refresh wait is required');
  let origin;
  try { origin = new URL(publicOrigin).origin; } catch { throw new TypeError('Console public origin is invalid'); }
  if (origin !== publicOrigin || !origin.startsWith('https://')) throw new TypeError('Console public origin must be an HTTPS origin');
  const baseResolveSession = createDatabaseSessionResolver({ store });

  function refreshDue(session) {
    if (session.accessTokenExpiresAt == null) return false;
    const expiresAt = new Date(session.accessTokenExpiresAt).getTime();
    if (!Number.isFinite(expiresAt)) fail('AuthenticationRequired', 'session credential expiry is invalid', 401);
    return expiresAt <= clock().getTime() + REFRESH_WINDOW_MS;
  }

  async function peerRotation(request, options) {
    let latest;
    for (const milliseconds of [0, 25, 75, 150]) {
      if (milliseconds) await wait(milliseconds);
      latest = await baseResolveSession(request, options);
      if (!refreshDue(latest)) return latest;
    }
    return null;
  }

  const broker = {
    async listManagedIdentities(request, { correlationId } = {}) {
      if (!store?.listManagedIdentities || !authClient?.readManagedUser) {
        fail('AuthorityUnavailable', 'managed identity authority is unavailable', 503);
      }
      const session = await broker.resolveSession(request, { requireCsrf: false, correlationId });
      const inventory = await store.listManagedIdentities({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        expectedPermissionRevision: session.permissionRevision,
        expectedRevokeEpoch: session.revokeEpoch,
        correlationId,
      });
      if (!['self', 'managed'].includes(inventory?.scope)
          || !Array.isArray(inventory?.items) || inventory.items.length > 200
          || !Array.isArray(inventory?.groups) || inventory.groups.length !== 3) {
        fail('AuthorityUnavailable', 'managed identity authority returned an invalid inventory', 503);
      }
      const users = await mapBounded(inventory.items, async (item) => {
        const subjectId = String(item?.subjectId || '');
        const roles = Array.isArray(item?.roles) ? item.roles.map(String) : [];
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(subjectId)
            || roles.some((role) => !MANAGED_ROLES.has(role))) {
          fail('AuthorityUnavailable', 'managed identity authority returned an invalid subject', 503);
        }
        const profile = await authClient.readManagedUser(subjectId);
        if (profile?.id !== subjectId) fail('AuthorityUnavailable', 'Supabase Auth changed the managed identity subject', 503);
        return Object.freeze({
          ...profile,
          groups: Object.freeze(roles.map((name) => Object.freeze({ id: name, name, path: '/' + name }))),
        });
      });
      const groups = inventory.groups.map((group) => {
        const name = String(group?.name || '');
        if (!MANAGED_ROLES.has(name)) fail('AuthorityUnavailable', 'managed identity role catalog is invalid', 503);
        return Object.freeze({ id: name, name, path: '/' + name, description: String(group?.description || '') });
      });
      return Object.freeze({
        meta: Object.freeze({ service: 'opensphere-identity', idp: 'supabase', scope: inventory.scope, writeEnabled: inventory.scope === 'managed' }),
        users: Object.freeze(users),
        groups: Object.freeze(groups),
      });
    },

    async changeManagedIdentityRole(request, { targetSubjectId, body, correlationId }) {
      if (!store?.changeManagedIdentityRole) {
        fail('AuthorityUnavailable', 'managed identity role authority is unavailable', 503);
      }
      const target = String(targetSubjectId || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(target)) {
        fail('ValidationFailed', 'managed identity subject is invalid', 400);
      }
      const input = managedRoleChangeInput(body);
      const session = await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const changed = await store.changeManagedIdentityRole({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        expectedPermissionRevision: session.permissionRevision,
        expectedRevokeEpoch: session.revokeEpoch,
        targetSubjectId: target,
        ...input,
        correlationId,
      });
      if (String(changed?.targetSubjectId || '') !== target || !Array.isArray(changed?.roles)
          || changed.roles.some((role) => !MANAGED_ROLES.has(String(role)))) {
        fail('AuthorityUnavailable', 'managed identity role authority returned an invalid result', 503);
      }
      return Object.freeze({
        ok: true,
        targetSubjectId: target,
        roles: Object.freeze(changed.roles.map(String)),
        permissionRevision: Number(changed.permissionRevision),
        revokeEpoch: Number(changed.revokeEpoch),
        revokedSessionCount: Number(changed.revokedSessionCount || 0),
        replayed: Boolean(changed.replayed),
      });
    },

    async createManagedIdentity(request, { body, idempotencyKey, correlationId }) {
      if (!store?.prepareManagedIdentityLifecycle || !store?.completeManagedIdentityLifecycle
          || !authClient?.createManagedUser || !authClient?.deleteManagedUser
          || !authClient?.createManagedUserRecoveryLink) {
        fail('AuthorityUnavailable', 'managed identity lifecycle authority is unavailable', 503);
      }
      const input = managedCreateInput(body, idempotencyKey);
      const session = await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const action = 'identity.create';
      const requestHash = requestDigest({ action, username: input.username, displayName: input.displayName, email: input.email, roles: input.roles, reason: input.reason });
      await store.prepareManagedIdentityLifecycle({
        sessionId: session.sessionId, actorRef: session.subjectId,
        expectedPermissionRevision: session.permissionRevision, expectedRevokeEpoch: session.revokeEpoch,
        targetSubjectId: null, action, requestDigest: requestHash, idempotencyKey: input.idempotencyKey,
        roles: input.roles, enabled: null, reason: input.reason, correlationId,
      });
      let created;
      try {
        created = await authClient.createManagedUser(input);
        const link = await authClient.createManagedUserRecoveryLink({
          subjectId: created.subjectId, publicOrigin: origin, redirectUrl: origin + '/auth/recovery',
        });
        await store.completeManagedIdentityLifecycle({
          sessionId: session.sessionId, actorRef: session.subjectId,
          expectedPermissionRevision: session.permissionRevision, expectedRevokeEpoch: session.revokeEpoch,
          targetSubjectId: created.subjectId, action, requestDigest: requestHash, idempotencyKey: input.idempotencyKey,
          roles: input.roles, enabled: null, revokeSessions: false, effectCount: 0,
          reason: input.reason, correlationId,
        });
        return Object.freeze({ ok: true, id: created.subjectId, username: input.username, roles: Object.freeze(input.roles), onboardingPath: link.onboardingPath });
      } catch (error) {
        if (created?.subjectId) {
          try { await authClient.deleteManagedUser(created.subjectId); }
          catch { throw uncertain(error, 'managed identity creation cleanup failed'); }
        }
        throw error;
      }
    },

    async updateManagedIdentityProfile(request, { targetSubjectId, body, idempotencyKey, correlationId }) {
      if (!store?.prepareManagedIdentityLifecycle || !store?.completeManagedIdentityLifecycle
          || !authClient?.updateManagedUserProfile) {
        fail('AuthorityUnavailable', 'managed identity lifecycle authority is unavailable', 503);
      }
      const target = managedSubject(targetSubjectId);
      const input = managedProfileInput(body, idempotencyKey);
      const session = await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const action = 'profile.update';
      const requestHash = requestDigest({ action, target, displayName: input.displayName, email: input.email, reason: input.reason });
      await store.prepareManagedIdentityLifecycle({
        sessionId: session.sessionId, actorRef: session.subjectId,
        expectedPermissionRevision: session.permissionRevision, expectedRevokeEpoch: session.revokeEpoch,
        targetSubjectId: target, action, requestDigest: requestHash, idempotencyKey: input.idempotencyKey,
        roles: [], enabled: null, reason: input.reason, correlationId,
      });
      const changed = await authClient.updateManagedUserProfile({ subjectId: target, displayName: input.displayName, email: input.email });
      try {
        await store.completeManagedIdentityLifecycle({
          sessionId: session.sessionId, actorRef: session.subjectId,
          expectedPermissionRevision: session.permissionRevision, expectedRevokeEpoch: session.revokeEpoch,
          targetSubjectId: target, action, requestDigest: requestHash, idempotencyKey: input.idempotencyKey,
          roles: [], enabled: null, revokeSessions: false, effectCount: 0, reason: input.reason, correlationId,
        });
      } catch (error) {
        try { await authClient.updateManagedUserProfile({ subjectId: target, ...changed.previous }); }
        catch { throw uncertain(error, 'managed identity profile rollback failed'); }
        throw error;
      }
      return Object.freeze({ ok: true, targetSubjectId: target });
    },

    async setManagedIdentityEnabled(request, { targetSubjectId, body, idempotencyKey, correlationId }) {
      if (!store?.prepareManagedIdentityLifecycle || !store?.completeManagedIdentityLifecycle
          || !authClient?.setManagedUserEnabled) {
        fail('AuthorityUnavailable', 'managed identity lifecycle authority is unavailable', 503);
      }
      const target = managedSubject(targetSubjectId);
      const input = managedEnabledInput(body, idempotencyKey);
      const session = await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const action = 'enabled.change';
      const requestHash = requestDigest({ action, target, enabled: input.enabled, reason: input.reason });
      await store.prepareManagedIdentityLifecycle({
        sessionId: session.sessionId, actorRef: session.subjectId,
        expectedPermissionRevision: session.permissionRevision, expectedRevokeEpoch: session.revokeEpoch,
        targetSubjectId: target, action, requestDigest: requestHash, idempotencyKey: input.idempotencyKey,
        roles: [], enabled: input.enabled, reason: input.reason, correlationId,
      });
      const changed = await authClient.setManagedUserEnabled({ subjectId: target, enabled: input.enabled });
      try {
        const completed = await store.completeManagedIdentityLifecycle({
          sessionId: session.sessionId, actorRef: session.subjectId,
          expectedPermissionRevision: session.permissionRevision, expectedRevokeEpoch: session.revokeEpoch,
          targetSubjectId: target, action, requestDigest: requestHash, idempotencyKey: input.idempotencyKey,
          roles: [], enabled: input.enabled, revokeSessions: true, effectCount: 0, reason: input.reason, correlationId,
        });
        return Object.freeze({ ok: true, targetSubjectId: target, enabled: input.enabled, revokedSessionCount: Number(completed.revokedSessionCount || 0) });
      } catch (error) {
        try { await authClient.setManagedUserEnabled({ subjectId: target, enabled: changed.previousEnabled }); }
        catch { throw uncertain(error, 'managed identity enabled-state rollback failed'); }
        throw error;
      }
    },

    async createManagedIdentityOnboardingLink(request, { targetSubjectId, body, idempotencyKey, correlationId }) {
      if (!store?.prepareManagedIdentityLifecycle || !store?.completeManagedIdentityLifecycle
          || !authClient?.createManagedUserRecoveryLink) {
        fail('AuthorityUnavailable', 'managed identity lifecycle authority is unavailable', 503);
      }
      const target = managedSubject(targetSubjectId);
      const input = managedReasonInput(body, idempotencyKey);
      const session = await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const action = 'onboarding.link';
      const requestHash = requestDigest({ action, target, reason: input.reason });
      await store.prepareManagedIdentityLifecycle({
        sessionId: session.sessionId, actorRef: session.subjectId,
        expectedPermissionRevision: session.permissionRevision, expectedRevokeEpoch: session.revokeEpoch,
        targetSubjectId: target, action, requestDigest: requestHash, idempotencyKey: input.idempotencyKey,
        roles: [], enabled: null, reason: input.reason, correlationId,
      });
      const link = await authClient.createManagedUserRecoveryLink({ subjectId: target, publicOrigin: origin, redirectUrl: origin + '/auth/recovery' });
      try {
        await store.completeManagedIdentityLifecycle({
          sessionId: session.sessionId, actorRef: session.subjectId,
          expectedPermissionRevision: session.permissionRevision, expectedRevokeEpoch: session.revokeEpoch,
          targetSubjectId: target, action, requestDigest: requestHash, idempotencyKey: input.idempotencyKey,
          roles: [], enabled: null, revokeSessions: false, effectCount: 0, reason: input.reason, correlationId,
        });
      } catch (error) {
        throw uncertain(error, 'managed identity onboarding-link completion failed');
      }
      return Object.freeze({ ok: true, targetSubjectId: target, onboardingPath: link.onboardingPath });
    },

    async resetManagedIdentityMfa(request, { targetSubjectId, body, idempotencyKey, correlationId }) {
      if (!store?.prepareManagedIdentityLifecycle || !store?.completeManagedIdentityLifecycle
          || !authClient?.resetManagedUserTotp) {
        fail('AuthorityUnavailable', 'managed identity lifecycle authority is unavailable', 503);
      }
      const target = managedSubject(targetSubjectId);
      const input = managedReasonInput(body, idempotencyKey);
      const session = await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const action = 'mfa.reset';
      const requestHash = requestDigest({ action, target, reason: input.reason });
      await store.prepareManagedIdentityLifecycle({
        sessionId: session.sessionId, actorRef: session.subjectId,
        expectedPermissionRevision: session.permissionRevision, expectedRevokeEpoch: session.revokeEpoch,
        targetSubjectId: target, action, requestDigest: requestHash, idempotencyKey: input.idempotencyKey,
        roles: [], enabled: null, reason: input.reason, correlationId,
      });
      const reset = await authClient.resetManagedUserTotp(target);
      try {
        const completed = await store.completeManagedIdentityLifecycle({
          sessionId: session.sessionId, actorRef: session.subjectId,
          expectedPermissionRevision: session.permissionRevision, expectedRevokeEpoch: session.revokeEpoch,
          targetSubjectId: target, action, requestDigest: requestHash, idempotencyKey: input.idempotencyKey,
          roles: [], enabled: null, revokeSessions: true, effectCount: reset.removedFactorCount,
          reason: input.reason, correlationId,
        });
        return Object.freeze({
          ok: true, targetSubjectId: target, removedFactorCount: reset.removedFactorCount,
          revokedSessionCount: Number(completed.revokedSessionCount || 0),
          reloginRequired: reset.removedFactorCount > 0,
          enrollmentPath: '/me?tab=security&enroll=totp',
        });
      } catch (error) {
        throw uncertain(error, 'managed identity MFA-reset completion failed');
      }
    },

    async getProfileAvatar(request, { correlationId } = {}) {
      if (!store?.prepareOwnedProfileAvatarAccess || !authClient?.readProfileAvatar) {
        fail('AuthorityUnavailable', 'profile avatar authority is unavailable', 503);
      }
      await broker.resolveSession(request, { requireCsrf: false, correlationId });
      const proof = readBrowserSessionProof(request, { requireCsrf: false });
      const context = await store.prepareOwnedProfileAvatarAccess({
        tokenDigest: proof.tokenDigest, csrfTokenDigest: null, operation: 'read', correlationId,
      });
      const result = await authClient.readProfileAvatar({
        accessToken: credentialCipher.decrypt(context.accessTokenCiphertext),
        expectedSubjectId: context.subjectId,
      });
      if (result?.subjectId !== context.subjectId || !result?.projection?.current || !Array.isArray(result?.projection?.linkedAccounts)) {
        fail('AuthorityUnavailable', 'profile avatar authority changed subject or projection', 503);
      }
      return result.projection;
    },

    async selectProfileAvatar(request, { body, correlationId }) {
      if (!store?.prepareOwnedProfileAvatarAccess || !authClient?.readProfileAvatar || !authClient?.updateProfileAvatar) {
        fail('AuthorityUnavailable', 'profile avatar authority is unavailable', 503);
      }
      await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      const context = await store.prepareOwnedProfileAvatarAccess({
        tokenDigest: proof.tokenDigest, csrfTokenDigest: proof.csrfTokenDigest, operation: 'select', correlationId,
      });
      const accessToken = credentialCipher.decrypt(context.accessTokenCiphertext);
      const current = await authClient.readProfileAvatar({ accessToken, expectedSubjectId: context.subjectId });
      const metadata = validateAvatarSelection(body, current?.projection?.linkedAccounts);
      const updated = await authClient.updateProfileAvatar({ accessToken, expectedSubjectId: context.subjectId, metadata });
      if (updated?.subjectId !== context.subjectId || !updated?.projection?.current) {
        fail('AuthorityUnavailable', 'profile avatar authority changed subject or projection', 503);
      }
      if (current?.projection?.current?.source === 'upload' && storageClient?.deleteAvatar) {
        await storageClient.deleteAvatar({ subjectId: context.subjectId }).catch(() => {});
      }
      return updated.projection;
    },

    async uploadProfileAvatar(request, { body, correlationId }) {
      if (!store?.prepareOwnedProfileAvatarAccess || !authClient?.updateProfileAvatar || !storageClient?.upsertAvatar) {
        fail('AuthorityUnavailable', 'profile avatar upload authority is unavailable', 503);
      }
      const upload = validateAvatarUpload(body);
      await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      const context = await store.prepareOwnedProfileAvatarAccess({
        tokenDigest: proof.tokenDigest, csrfTokenDigest: proof.csrfTokenDigest, operation: 'upload', correlationId,
      });
      const metadata = Object.freeze({ source: 'upload', digest: upload.digest, contentType: upload.contentType });
      await storageClient.upsertAvatar({ subjectId: context.subjectId, bytes: upload.bytes, contentType: upload.contentType });
      try {
        const updated = await authClient.updateProfileAvatar({
          accessToken: credentialCipher.decrypt(context.accessTokenCiphertext),
          expectedSubjectId: context.subjectId, metadata,
        });
        if (updated?.subjectId !== context.subjectId || updated?.projection?.current?.digest !== upload.digest) {
          fail('AuthorityUnavailable', 'profile avatar authority changed subject or digest', 503);
        }
        return updated.projection;
      } catch (error) {
        await storageClient.deleteAvatar({ subjectId: context.subjectId }).catch(() => {});
        throw error;
      }
    },

    async readProfileAvatarContent(request, { digest: expectedDigest, correlationId }) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(String(expectedDigest || ''))
          || !store?.prepareOwnedProfileAvatarAccess || !authClient?.readProfileAvatar || !storageClient?.readAvatar) {
        if (!/^sha256:[a-f0-9]{64}$/u.test(String(expectedDigest || ''))) fail('ValidationFailed', 'profile avatar version is invalid', 400);
        fail('AuthorityUnavailable', 'profile avatar content authority is unavailable', 503);
      }
      await broker.resolveSession(request, { requireCsrf: false, correlationId });
      const proof = readBrowserSessionProof(request, { requireCsrf: false });
      const context = await store.prepareOwnedProfileAvatarAccess({
        tokenDigest: proof.tokenDigest, csrfTokenDigest: null, operation: 'content', correlationId,
      });
      const current = await authClient.readProfileAvatar({
        accessToken: credentialCipher.decrypt(context.accessTokenCiphertext), expectedSubjectId: context.subjectId,
      });
      if (current?.subjectId !== context.subjectId || current?.projection?.current?.source !== 'upload'
          || current.projection.current.digest !== expectedDigest) {
        fail('AvatarNotFound', 'profile avatar content version is unavailable', 404);
      }
      const object = await storageClient.readAvatar({ subjectId: context.subjectId });
      const actualDigest = `sha256:${createHash('sha256').update(object.bytes).digest('hex')}`;
      if (actualDigest !== expectedDigest || object.contentType !== current.projection.current.contentType) {
        fail('AuthorityUnavailable', 'stored profile avatar does not match its authority metadata', 503);
      }
      return Object.freeze({ bytes: object.bytes, contentType: object.contentType, digest: actualDigest });
    },

    async listSessionEvents(request, { limit } = {}) {
      if (!store?.listOwnedSessionEvents) {
        fail('AuthorityUnavailable', 'session event authority is unavailable', 503);
      }
      const boundedLimit = sessionEventLimit(limit);
      await broker.resolveSession(request, { requireCsrf: false });
      const proof = readBrowserSessionProof(request, { requireCsrf: false });
      const history = await store.listOwnedSessionEvents({
        tokenDigest: proof.tokenDigest,
        limit: boundedLimit,
      });
      if (!Array.isArray(history?.items) || history.items.length > 100) {
        fail('AuthorityUnavailable', 'session event authority returned an invalid result', 503);
      }
      const items = history.items.map((event) => {
        const occurredAt = new Date(event?.occurred_at).getTime();
        if (!Number.isSafeInteger(Number(event?.id)) || Number(event.id) < 1
            || (event.session_id != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(event.session_id)))
            || !SESSION_EVENT_NAMES.has(event?.event) || !SESSION_EVENT_RESULTS.has(event?.result)
            || !Number.isFinite(occurredAt)) {
          fail('AuthorityUnavailable', 'session event authority returned an invalid item', 503);
        }
        return Object.freeze({
          id: Number(event.id),
          session_id: event.session_id == null ? null : String(event.session_id),
          event: event.event,
          result: event.result,
          occurred_at: new Date(occurredAt).toISOString(),
        });
      });
      return Object.freeze({ items: Object.freeze(items) });
    },

    async getSessionPreference(request, { correlationId } = {}) {
      if (!store?.getSessionPreferenceCredentials || !authClient?.readSessionPreference) {
        fail('AuthorityUnavailable', 'session preference authority is unavailable', 503);
      }
      await broker.resolveSession(request, { requireCsrf: false, correlationId });
      const proof = readBrowserSessionProof(request, { requireCsrf: false });
      const context = await store.getSessionPreferenceCredentials({ tokenDigest: proof.tokenDigest });
      if (!context?.sessionId || !context?.subjectId || !context?.accessTokenCiphertext) {
        fail('AuthorityUnavailable', 'session preference authority returned an invalid context', 503);
      }
      const preference = await authClient.readSessionPreference({
        accessToken: credentialCipher.decrypt(context.accessTokenCiphertext),
        expectedSubjectId: context.subjectId,
      });
      if (preference?.subjectId !== context.subjectId) {
        fail('AuthorityUnavailable', 'session preference authority changed subject', 503);
      }
      return sessionPreferenceProjection(preference.duration);
    },

    async updateSessionPreference(request, { body, correlationId }) {
      if (!store?.prepareSessionPreferenceUpdate || !authClient?.updateSessionPreference) {
        fail('AuthorityUnavailable', 'session preference authority is unavailable', 503);
      }
      const duration = sessionPreferenceInput(body);
      await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      const context = await store.prepareSessionPreferenceUpdate({
        tokenDigest: proof.tokenDigest,
        csrfTokenDigest: proof.csrfTokenDigest,
        duration,
        correlationId,
      });
      if (!context?.sessionId || !context?.subjectId || !context?.accessTokenCiphertext
          || !context?.auditEventId) {
        fail('AuthorityUnavailable', 'session preference authority returned an invalid update context', 503);
      }
      const preference = await authClient.updateSessionPreference({
        accessToken: credentialCipher.decrypt(context.accessTokenCiphertext),
        expectedSubjectId: context.subjectId,
        duration,
      });
      if (preference?.subjectId !== context.subjectId || preference?.duration !== duration) {
        fail('AuthorityUnavailable', 'session preference authority changed subject or duration', 503);
      }
      return sessionPreferenceProjection(preference.duration);
    },

    async initialAdministratorStatus() {
      if (!store?.getInitialAdministratorBootstrapStatus) {
        fail('AuthorityUnavailable', 'initial administrator status authority is unavailable', 503);
      }
      const status = await store.getInitialAdministratorBootstrapStatus();
      if (!['required', 'complete'].includes(status?.state)) {
        fail('AuthorityUnavailable', 'initial administrator status authority returned an invalid state', 503);
      }
      return Object.freeze({ state: status.state });
    },

    async bootstrapInitialAdministrator({ body, requestOrigin, correlationId }) {
      if (String(requestOrigin || '') !== origin) fail('PermissionDenied', 'initial administrator origin is not allowed', 403);
      if (!store?.claimInitialAdministrator || !authClient?.createInitialAdministrator
          || !authClient?.deleteInitialAdministrator) {
        fail('AuthorityUnavailable', 'initial administrator authority is unavailable', 503);
      }
      const input = initialAdministratorInput(body);
      const created = await authClient.createInitialAdministrator(input);
      try {
        const claimed = await store.claimInitialAdministrator({
          subjectId: created.subjectId,
          correlationId,
        });
        if (claimed?.state !== 'complete' || String(claimed?.subjectId || '') !== created.subjectId
            || Number(claimed?.permissionRevision) !== 1 || Number(claimed?.permissionCount) !== 10) {
          fail('AuthorityUnavailable', 'initial administrator authority returned an invalid receipt', 503);
        }
        return Object.freeze({ state: 'complete' });
      } catch (error) {
        await authClient.deleteInitialAdministrator(created.subjectId).catch(() => {});
        throw error;
      }
    },

    async completePasswordRecovery({ body, requestOrigin, correlationId }) {
      if (String(requestOrigin || '') !== origin) fail('PermissionDenied', 'password recovery origin is not allowed', 403);
      if (!store?.revokeRecoveredSubjectSessions
          || !authClient?.completePasswordRecovery || !authClient?.logoutAll) {
        fail('AuthorityUnavailable', 'password recovery authority is unavailable', 503);
      }
      const recovered = await authClient.completePasswordRecovery(passwordRecoveryInput(body));
      const revoked = await store.revokeRecoveredSubjectSessions({
        subjectId: recovered.subjectId,
        correlationId,
      });
      if (String(revoked?.subjectId || '') !== recovered.subjectId
          || !Number.isInteger(revoked?.revokedCount)
          || !Number.isSafeInteger(Number(revoked?.revokeEpoch))) {
        fail('AuthorityUnavailable', 'password recovery session authority returned an invalid receipt', 503);
      }
      await authClient.logoutAll(recovered.accessToken);
      return Object.freeze({
        completed: true,
        revokedSessions: revoked.revokedCount,
      });
    },

    async requestOwnedPasswordRecoveryLink(request, { body, idempotencyKey, correlationId }) {
      if (!store?.prepareOwnedPasswordRecoveryLink || !authClient?.createOwnedPasswordRecoveryLink) {
        fail('AuthorityUnavailable', 'password recovery-link authority is unavailable', 503);
      }
      const input = passwordRecoveryLinkInput(body, idempotencyKey);
      await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      const context = await store.prepareOwnedPasswordRecoveryLink({
        tokenDigest: proof.tokenDigest,
        csrfTokenDigest: proof.csrfTokenDigest,
        idempotencyKey: input.idempotencyKey,
        correlationId,
        reason: input.reason,
      });
      if (context?.state === 'duplicate') {
        throw Object.assign(new Error('password recovery link replay cannot expose a prior one-time credential'), {
          code: 'IdempotencyReplayUnavailable', status: 409, sideEffect: 'unknown',
        });
      }
      if (context?.state !== 'prepared' || !context?.sessionId || !context?.subjectId
          || !context?.accessTokenCiphertext || !context?.auditEventId) {
        fail('AuthorityUnavailable', 'password recovery-link authority returned an invalid context', 503);
      }
      const result = await authClient.createOwnedPasswordRecoveryLink({
        accessToken: credentialCipher.decrypt(context.accessTokenCiphertext),
        expectedSubjectId: context.subjectId,
        publicOrigin: origin,
        redirectUrl: origin + '/auth/recovery',
      });
      if (result?.subjectId !== context.subjectId || typeof result?.resetUrl !== 'string') {
        fail('AuthorityUnavailable', 'password recovery-link authority changed subject', 503);
      }
      let resetUrl;
      try { resetUrl = new URL(result.resetUrl); } catch {
        fail('AuthorityUnavailable', 'password recovery-link authority returned an invalid URL', 503);
      }
      if (resetUrl.origin !== origin || resetUrl.pathname !== '/auth/v1/verify'
          || resetUrl.searchParams.get('type') !== 'recovery') {
        fail('AuthorityUnavailable', 'password recovery-link authority escaped the Console origin', 503);
      }
      return Object.freeze({ ok: true, resetUrl: resetUrl.toString() });
    },

    async login({ body, requestOrigin, correlationId }) {
      if (String(requestOrigin || '') !== origin) fail('PermissionDenied', 'login origin is not allowed', 403);
      const input = credentials(body);
      const auth = await authClient.authenticatePassword(input);
      const handle = Buffer.from(randomBytes(32)).toString('base64url');
      const csrf = Buffer.from(randomBytes(24)).toString('base64url');
      if (handle.length !== 43 || csrf.length !== 32) fail('AuthorityUnavailable', 'secure random byte source failed', 503);
      const pendingMfa = Boolean(auth.verifiedTotpFactorId) && auth.aal !== 'aal2';
      const persistence = sessionPersistence(auth.sessionPersistence);
      const absoluteTtl = SESSION_DURATION_MS[persistence];
      const absoluteExpiresAt = new Date(clock().getTime() + absoluteTtl);
      let issued;
      try {
        issued = await store.issueSession({
          subjectId: auth.subjectId,
          tokenDigest: digest(handle),
          csrfTokenDigest: digest(csrf),
          accessTokenCiphertext: credentialCipher.encrypt(auth.accessToken),
          refreshTokenCiphertext: credentialCipher.encrypt(auth.refreshToken),
          authSessionRef: auth.authSessionRef,
          aal: auth.aal,
          accessTokenExpiresAt: auth.accessTokenExpiresAt,
          absoluteExpiresAt: absoluteExpiresAt.toISOString(),
          persistence,
          pendingMfa,
          correlationId,
        });
      } catch (error) {
        await authClient.logout(auth.accessToken);
        throw error;
      }
      if (!issued?.sessionId || issued.subjectId !== auth.subjectId || issued.state !== (pendingMfa ? 'pending_mfa' : 'active')) {
        await authClient.logout(auth.accessToken);
        fail('AuthorityUnavailable', 'Console session authority returned an invalid record', 503);
      }
      const session = Object.freeze({
        id: issued.sessionId,
        current: true,
        status: issued.state,
        assurance: issued.aal,
        persistence: issued.persistence,
        createdAt: issued.createdAt,
        lastSeenAt: issued.lastSeenAt,
        idleExpiresAt: issued.idleExpiresAt,
        absoluteExpiresAt: issued.absoluteExpiresAt,
        userAgentDigest: null,
      });
      return Object.freeze({
        cookies: Object.freeze([
          cookie('__Host-opensphere-session', handle, pendingMfa ? PENDING_MFA_TTL_MS : absoluteTtl, true, pendingMfa || persistence !== 'browser'),
          cookie('__Host-opensphere_csrf', csrf, pendingMfa ? PENDING_MFA_TTL_MS : absoluteTtl, false, pendingMfa || persistence !== 'browser'),
        ]),
        body: Object.freeze({
          mfaRequired: pendingMfa,
          mfaEnrollmentRequired: !pendingMfa && auth.aal !== 'aal2',
          session,
        }),
      });
    },

    async completeMfa({ request, body, correlationId }) {
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some((key) => key !== 'code')
          || !/^\d{6}$/u.test(String(body.code || ''))) {
        fail('ValidationFailed', 'current 6-digit authentication code is required', 400);
      }
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      const pending = await store.getPendingMfa({
        tokenDigest: proof.tokenDigest,
        csrfTokenDigest: proof.csrfTokenDigest,
      });
      if (!pending?.sessionId || !pending?.subjectId || !pending?.accessTokenCiphertext) {
        fail('AuthorityUnavailable', 'pending MFA authority returned an invalid record', 503);
      }
      const accessToken = credentialCipher.decrypt(pending.accessTokenCiphertext);
      const completed = await authClient.completeTotp({
        accessToken,
        code: String(body.code),
        expectedSubjectId: pending.subjectId,
      });
      let activated;
      try {
        activated = await store.activateMfa({
          sessionId: pending.sessionId,
          subjectId: pending.subjectId,
          expectedAccessCiphertextDigest: digest(pending.accessTokenCiphertext),
          accessTokenCiphertext: credentialCipher.encrypt(completed.accessToken),
          refreshTokenCiphertext: credentialCipher.encrypt(completed.refreshToken),
          authSessionRef: completed.authSessionRef,
          accessTokenExpiresAt: completed.accessTokenExpiresAt,
          correlationId,
        });
      } catch (error) {
        await authClient.logout(completed.accessToken);
        throw error;
      }
      if (!activated?.sessionId || activated.sessionId !== pending.sessionId
          || activated.subjectId !== pending.subjectId || activated.state !== 'active' || activated.aal !== 'aal2') {
        await authClient.logout(completed.accessToken);
        fail('AuthorityUnavailable', 'Console session MFA authority returned an invalid record', 503);
      }
      return Object.freeze({
        cookies: Object.freeze([
          cookie('__Host-opensphere-session', proof.handle,
            Math.max(0, new Date(pending.absoluteExpiresAt).getTime() - clock().getTime()), true,
            pending.persistence !== 'browser'),
          cookie('__Host-opensphere_csrf', proof.csrf,
            Math.max(0, new Date(pending.absoluteExpiresAt).getTime() - clock().getTime()), false,
            pending.persistence !== 'browser'),
        ]),
        body: Object.freeze({ assurance: 'aal2', sessionId: activated.sessionId }),
      });
    },

    async beginTotpEnrollment({ request, body, correlationId }) {
      if (!store?.getTotpEnrollmentCredentials || !authClient?.beginTotpEnrollment) {
        fail('AuthorityUnavailable', 'TOTP enrollment authority is unavailable', 503);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some((key) => key !== 'friendlyName')) {
        fail('ValidationFailed', 'TOTP enrollment body is invalid', 400);
      }
      const friendlyName = String(body.friendlyName || '').trim();
      if (friendlyName.length < 1 || friendlyName.length > 64 || /[\r\n\u0000-\u001f\u007f]/u.test(friendlyName)) {
        fail('ValidationFailed', 'TOTP friendly name is invalid', 400);
      }
      await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      const current = await store.getTotpEnrollmentCredentials({
        tokenDigest: proof.tokenDigest,
        csrfTokenDigest: proof.csrfTokenDigest,
      });
      if (!current?.sessionId || !current?.subjectId || !current?.accessTokenCiphertext) {
        fail('AuthorityUnavailable', 'TOTP enrollment authority returned an invalid record', 503);
      }
      return authClient.beginTotpEnrollment({
        accessToken: credentialCipher.decrypt(current.accessTokenCiphertext),
        expectedSubjectId: current.subjectId,
        friendlyName,
      });
    },

    async verifyTotpEnrollment({ request, body, correlationId }) {
      if (!store?.getTotpEnrollmentCredentials || !store?.completeTotpEnrollment
          || !authClient?.verifyTotpEnrollment) {
        fail('AuthorityUnavailable', 'TOTP enrollment authority is unavailable', 503);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some((key) => !['factorId', 'code'].includes(key))) {
        fail('ValidationFailed', 'TOTP enrollment verification body is invalid', 400);
      }
      const factorId = String(body.factorId || '');
      const code = String(body.code || '');
      if (factorId.length < 1 || factorId.length > 256
          || /[\r\n\u0000-\u001f\u007f]/u.test(factorId) || !/^\d{6}$/u.test(code)) {
        fail('ValidationFailed', 'TOTP factor and current 6-digit authentication code are required', 400);
      }
      await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      const current = await store.getTotpEnrollmentCredentials({
        tokenDigest: proof.tokenDigest,
        csrfTokenDigest: proof.csrfTokenDigest,
      });
      if (!current?.sessionId || !current?.subjectId || !current?.accessTokenCiphertext) {
        fail('AuthorityUnavailable', 'TOTP enrollment authority returned an invalid record', 503);
      }
      const completed = await authClient.verifyTotpEnrollment({
        accessToken: credentialCipher.decrypt(current.accessTokenCiphertext),
        factorId,
        code,
        expectedSubjectId: current.subjectId,
      });
      let activated;
      try {
        activated = await store.completeTotpEnrollment({
          sessionId: current.sessionId,
          subjectId: current.subjectId,
          expectedAccessCiphertextDigest: digest(current.accessTokenCiphertext),
          accessTokenCiphertext: credentialCipher.encrypt(completed.accessToken),
          refreshTokenCiphertext: credentialCipher.encrypt(completed.refreshToken),
          authSessionRef: completed.authSessionRef,
          accessTokenExpiresAt: completed.accessTokenExpiresAt,
          correlationId,
        });
      } catch (error) {
        await authClient.logout(completed.accessToken);
        throw error;
      }
      if (!activated?.sessionId || activated.sessionId !== current.sessionId
          || activated.subjectId !== current.subjectId || activated.state !== 'active' || activated.aal !== 'aal2') {
        await authClient.logout(completed.accessToken);
        fail('AuthorityUnavailable', 'Console TOTP enrollment authority returned an invalid record', 503);
      }
      return Object.freeze({ assurance: 'aal2', sessionId: activated.sessionId });
    },

    async stepUp({ request, body, correlationId }) {
      if (!store?.getStepUpCredentials || !store?.completeStepUp) {
        fail('AuthorityUnavailable', 'session step-up authority is unavailable', 503);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some((key) => key !== 'code')
          || !/^\d{6}$/u.test(String(body.code || ''))) {
        fail('ValidationFailed', 'current 6-digit authentication code is required', 400);
      }
      await broker.resolveSession(request, { requireCsrf: true, correlationId });
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      const current = await store.getStepUpCredentials({
        tokenDigest: proof.tokenDigest, csrfTokenDigest: proof.csrfTokenDigest,
      });
      if (!current?.sessionId || !current?.subjectId || !current?.accessTokenCiphertext) {
        fail('AuthorityUnavailable', 'session step-up authority returned an invalid record', 503);
      }
      const completed = await authClient.completeTotp({
        accessToken: credentialCipher.decrypt(current.accessTokenCiphertext),
        code: String(body.code), expectedSubjectId: current.subjectId,
      });
      let steppedUp;
      try {
        steppedUp = await store.completeStepUp({
          sessionId: current.sessionId, subjectId: current.subjectId,
          expectedAccessCiphertextDigest: digest(current.accessTokenCiphertext),
          accessTokenCiphertext: credentialCipher.encrypt(completed.accessToken),
          refreshTokenCiphertext: credentialCipher.encrypt(completed.refreshToken),
          authSessionRef: completed.authSessionRef,
          accessTokenExpiresAt: completed.accessTokenExpiresAt,
          correlationId,
        });
      } catch (error) {
        await authClient.logout(completed.accessToken);
        throw error;
      }
      if (steppedUp?.sessionId !== current.sessionId || steppedUp?.subjectId !== current.subjectId
          || steppedUp?.state !== 'active' || steppedUp?.aal !== 'aal2' || !steppedUp?.reauthenticatedAt) {
        await authClient.logout(completed.accessToken);
        fail('AuthorityUnavailable', 'session step-up authority returned an invalid completion', 503);
      }
      return Object.freeze({ assurance: 'aal2', reauthenticatedAt: steppedUp.reauthenticatedAt });
    },

    async touchActivity(request) {
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      const session = await store.touchActivity({
        tokenDigest: proof.tokenDigest,
        csrfTokenDigest: proof.csrfTokenDigest,
      });
      if (!session?.sessionId || session.state !== 'active') {
        fail('AuthorityUnavailable', 'session activity authority returned an invalid record', 503);
      }
      return Object.freeze({
        id: session.sessionId,
        current: true,
        status: 'active',
        assurance: session.aal,
        persistence: session.persistence,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        userAgentDigest: null,
      });
    },

    async listSessions(request) {
      const proof = readBrowserSessionProof(request, { requireCsrf: false });
      const inventory = await store.listOwnedSessions({ tokenDigest: proof.tokenDigest });
      if (!Array.isArray(inventory?.items) || inventory.items.length > 100) {
        fail('AuthorityUnavailable', 'session inventory authority returned an invalid result', 503);
      }
      const items = inventory.items.map((session) => {
        if (!session?.id || !['active', 'pending_mfa'].includes(session.status)
            || !['aal1', 'aal2'].includes(session.assurance)
            || !Object.hasOwn(SESSION_DURATION_MS, session.persistence)) {
          fail('AuthorityUnavailable', 'session inventory authority returned an invalid item', 503);
        }
        return Object.freeze({
          id: session.id,
          current: session.current === true,
          status: session.status,
          assurance: session.assurance,
          persistence: session.persistence,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          idleExpiresAt: session.idleExpiresAt,
          absoluteExpiresAt: session.absoluteExpiresAt,
          userAgentDigest: session.userAgentDigest ?? null,
        });
      });
      if (items.filter((session) => session.current).length !== 1) {
        fail('AuthorityUnavailable', 'session inventory lost the current session binding', 503);
      }
      return Object.freeze({ items: Object.freeze(items) });
    },

    async revokeSession(request, { targetSessionId, correlationId }) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(targetSessionId || ''))) {
        fail('ValidationFailed', 'target browser session id is invalid', 400);
      }
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      return store.revokeOwnedSession({
        tokenDigest: proof.tokenDigest,
        csrfTokenDigest: proof.csrfTokenDigest,
        targetSessionId: String(targetSessionId),
        correlationId,
      });
    },

    async revokeAllSessions(request, { correlationId }) {
      const proof = readBrowserSessionProof(request, { requireCsrf: true });
      return store.revokeAllOwnedSessions({
        tokenDigest: proof.tokenDigest,
        csrfTokenDigest: proof.csrfTokenDigest,
        correlationId,
      });
    },

    async resolveSession(request, { requireCsrf = false, correlationId } = {}) {
      const options = { requireCsrf };
      let session = await baseResolveSession(request, options);
      if (!refreshDue(session)) return session;

      const proof = readBrowserSessionProof(request, options);
      let current;
      try {
        current = await store.getRefreshCredentials({
          tokenDigest: proof.tokenDigest,
          csrfTokenDigest: proof.csrfTokenDigest,
          requireCsrf,
        });
      } catch (error) {
        if (error?.code === 'RefreshNotRequired') return baseResolveSession(request, options);
        throw error;
      }
      if (!current?.sessionId || !current?.subjectId || !current?.refreshTokenCiphertext) {
        fail('AuthorityUnavailable', 'session refresh authority returned an invalid record', 503);
      }
      const expectedRefreshCiphertextDigest = digest(current.refreshTokenCiphertext);
      let refreshed;
      try {
        refreshed = await authClient.refreshSession({
          refreshToken: credentialCipher.decrypt(current.refreshTokenCiphertext),
          expectedSubjectId: current.subjectId,
        });
      } catch (error) {
        if (error?.code !== 'RefreshRejected') throw error;
        const peer = await peerRotation(request, options);
        if (peer) return peer;
        const rejected = await store.rejectRefresh({
          sessionId: current.sessionId,
          subjectId: current.subjectId,
          expectedRefreshCiphertextDigest,
          correlationId,
        });
        if (rejected.outcome === 'peer_rotated') {
          session = await baseResolveSession(request, options);
          if (!refreshDue(session)) return session;
          fail('AuthorityUnavailable', 'peer session refresh is still settling', 503);
        }
        fail('AuthenticationRequired', 'Supabase Auth explicitly rejected the current refresh credential', 401);
      }

      const rotated = await store.rotateCredentials({
        sessionId: current.sessionId,
        subjectId: current.subjectId,
        expectedRefreshCiphertextDigest,
        accessTokenCiphertext: credentialCipher.encrypt(refreshed.accessToken),
        refreshTokenCiphertext: credentialCipher.encrypt(refreshed.refreshToken),
        authSessionRef: refreshed.authSessionRef,
        aal: refreshed.aal,
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
        correlationId,
      });
      if (!['rotated', 'peer_rotated'].includes(rotated.outcome)) {
        fail('AuthorityUnavailable', 'session refresh authority returned an invalid outcome', 503);
      }
      session = await baseResolveSession(request, options);
      if (refreshDue(session)) fail('AuthorityUnavailable', 'session credential rotation is still settling', 503);
      return session;
    },
  };
  return Object.freeze(broker);
}

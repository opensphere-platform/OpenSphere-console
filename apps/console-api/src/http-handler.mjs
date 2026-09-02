import { randomUUID } from 'node:crypto';

const JSON_LIMIT = 1024 * 1024;

function send(response, status, body, headers = {}) {
  const payload = body == null ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { 'cache-control': 'no-store', ...headers });
  response.end();
}

function sendAvatar(response, avatar) {
  response.writeHead(200, {
    'content-type': avatar.contentType,
    'content-length': String(avatar.bytes.length),
    'cache-control': 'private, max-age=300, must-revalidate',
    'x-content-type-options': 'nosniff',
    etag: `"${avatar.digest}"`,
  });
  response.end(avatar.bytes);
}

function clearSessionCookies() {
  return [
    '__Host-opensphere-session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    '__Host-opensphere_csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0',
  ];
}

async function jsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > JSON_LIMIT) throw Object.assign(new Error('request body is too large'), { code: 'ValidationFailed', status: 400 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { code: 'ValidationFailed', status: 400 });
  }
}

function header(request, name, minimum = 1) {
  const value = String(request.headers[name] || '').trim();
  if (value.length < minimum) {
    throw Object.assign(new Error(name + ' header is required'), { code: 'ValidationFailed', status: 400 });
  }
  return value;
}

function onlyQueryParameter(url, name) {
  const keys = [...url.searchParams.keys()];
  const values = url.searchParams.getAll(name);
  if (keys.some((key) => key !== name) || values.length > 1) {
    throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
  }
  return values[0] ?? null;
}

function errorEnvelope(error, correlationId) {
  const internalCode = error?.code || 'AuthorityUnavailable';
  const code = {
    SessionInvalid: 'AuthenticationRequired',
    CsrfRejected: 'PermissionDenied',
    StaleAuthorityRevision: 'StaleRevision',
    StaleOperationVersion: 'StaleRevision',
    ReasonRequired: 'ValidationFailed',
    SelfApprovalDenied: 'PermissionDenied',
  }[internalCode] || internalCode;
  const sideEffect = ['none', 'unknown', 'present'].includes(error?.sideEffect)
    ? error.sideEffect
    : (code === 'AuthorityUnavailable' ? 'unknown' : 'none');
  return {
    schemaVersion: '1.0',
    code,
    message: String(error?.message || 'Console API request failed').slice(0, 500),
    retryable: code === 'AuthorityUnavailable' || code === 'DependencyTimeout',
    sideEffect,
    correlationId,
    operationId: error?.operationId || null,
    details: {},
  };
}

export function createConsoleApiHandler({ resolveSession, operationService, registryOperations, catalogOperations, ownerAdmissionOperations, auditOperations, identityOperations, identitySessionBroker, cliIdentityBroker, dataIdentityOperations, platformChangeOperations, platformReleaseOperations, health = async () => true }) {
  if (typeof resolveSession !== 'function') throw new TypeError('session resolver is required');
  return async function consoleApiHandler(request, response) {
    const requestedCorrelation = String(request.headers['x-os-correlation-id'] || '').trim();
    const correlationId = requestedCorrelation.length >= 8 && requestedCorrelation.length <= 128
      ? requestedCorrelation
      : randomUUID();
    try {
      const url = new URL(request.url, 'http://console-api.local');
      if (url.pathname === '/livez' && request.method === 'GET') {
        return send(response, 200, { state: 'Alive' });
      }
      if (url.pathname === '/healthz' && request.method === 'GET') {
        const ready = await health();
        return send(response, ready ? 200 : 503, {
          state: ready ? 'Ready' : 'Unavailable',
          authority: 'SupabasePostgreSQL',
        });
      }
      if (url.pathname === '/api/internal/r2d2-proxy-authn' && request.method === 'GET') {
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        if (!ownerAdmissionOperations?.authorizeOsaa) {
          throw Object.assign(new Error('OSAA owner admission is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        const admission = await ownerAdmissionOperations.authorizeOsaa(request, { correlationId });
        return sendEmpty(response, 204, { 'x-os-r2d2-authorization': admission.authorization });
      }
      if (url.pathname === '/api/identity/bootstrap/status' && request.method === 'GET') {
        if (!identitySessionBroker?.initialAdministratorStatus) {
          throw Object.assign(new Error('initial administrator status is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        return send(response, 200, await identitySessionBroker.initialAdministratorStatus());
      }
      if (url.pathname === '/api/identity/bootstrap' && request.method === 'POST') {
        if (!identitySessionBroker?.bootstrapInitialAdministrator) {
          throw Object.assign(new Error('initial administrator bootstrap is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        return send(response, 201, await identitySessionBroker.bootstrapInitialAdministrator({
          body: await jsonBody(request),
          requestOrigin: request.headers.origin,
          correlationId,
        }));
      }
      if (url.pathname === '/api/identity/cli/enrollments' && request.method === 'POST') {
        if (!cliIdentityBroker?.createEnrollment) throw Object.assign(new Error('CLI identity enrollment is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        return send(response, 201, await cliIdentityBroker.createEnrollment({ body: await jsonBody(request), correlationId }));
      }
      const cliEnrollmentMatch = url.pathname.match(/^\/api\/identity\/cli\/enrollments\/([0-9a-fA-F-]{36})$/u);
      const cliEnrollmentPollMatch = url.pathname.match(/^\/api\/identity\/cli\/enrollments\/([0-9a-fA-F-]{36})\/poll$/u);
      const cliEnrollmentApproveMatch = url.pathname.match(/^\/api\/identity\/cli\/enrollments\/([0-9a-fA-F-]{36})\/approve$/u);
      if (cliEnrollmentMatch && request.method === 'GET') {
        if (!cliIdentityBroker?.getEnrollment) throw Object.assign(new Error('CLI identity enrollment is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        return send(response, 200, await cliIdentityBroker.getEnrollment(request, {
          enrollmentId: cliEnrollmentMatch[1], userCode: onlyQueryParameter(url, 'code'), correlationId,
        }));
      }
      if (cliEnrollmentPollMatch && request.method === 'POST') {
        if (!cliIdentityBroker?.pollEnrollment) throw Object.assign(new Error('CLI identity enrollment poll is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        const polled = await cliIdentityBroker.pollEnrollment({
          enrollmentId: cliEnrollmentPollMatch[1], body: await jsonBody(request), correlationId,
        });
        return send(response, polled.status === 'pending' ? 202 : 200, polled);
      }
      if (cliEnrollmentApproveMatch && request.method === 'POST') {
        if (!cliIdentityBroker?.approveEnrollment) throw Object.assign(new Error('CLI identity enrollment approval is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        return send(response, 200, await cliIdentityBroker.approveEnrollment(request, {
          enrollmentId: cliEnrollmentApproveMatch[1], body: await jsonBody(request), correlationId,
        }));
      }
      if (url.pathname === '/api/identity/cli/challenge' && request.method === 'POST') {
        if (!cliIdentityBroker?.createChallenge) throw Object.assign(new Error('CLI identity challenge is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        return send(response, 200, await cliIdentityBroker.createChallenge({ body: await jsonBody(request), correlationId }));
      }
      if (url.pathname === '/api/identity/cli/session' && request.method === 'POST') {
        if (!cliIdentityBroker?.createSession) throw Object.assign(new Error('CLI identity session is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        return send(response, 200, await cliIdentityBroker.createSession({ body: await jsonBody(request), correlationId }));
      }
      if (url.pathname === '/api/identity/cli/introspect' && request.method === 'GET') {
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        if (!/^Bearer [A-Za-z0-9_-]{32,512}$/u.test(String(request.headers.authorization || ''))) {
          throw Object.assign(new Error('CLI bearer credential is required'), { code: 'AuthenticationRequired', status: 401 });
        }
        const session = await resolveSession(request, { requireCsrf: false, correlationId });
        const groups = (session.permissions || []).flatMap((permission) => ({
          'console.role.admin': ['console-admins'],
          'console.role.operator': ['console-operators'],
          'console.role.viewer': ['console-viewers'],
        })[permission] || []);
        return send(response, 200, {
          active: true,
          userId: session.subjectId,
          subject: session.subjectId,
          deviceId: session.deviceId || null,
          groups,
          permissions: session.permissions || [],
          type: 'cli',
          expiresAt: session.expiresAt,
        });
      }
      if (url.pathname === '/api/identity/cli/devices' && request.method === 'GET') {
        if (!cliIdentityBroker?.listDevices) throw Object.assign(new Error('CLI identity devices are unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        return send(response, 200, await cliIdentityBroker.listDevices(request, { correlationId }));
      }
      const cliDeviceMatch = url.pathname.match(/^\/api\/identity\/cli\/devices\/([0-9a-fA-F-]{36})$/u);
      if (cliDeviceMatch && request.method === 'DELETE') {
        if (!cliIdentityBroker?.revokeDevice) throw Object.assign(new Error('CLI identity device revocation is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        await cliIdentityBroker.revokeDevice(request, {
          deviceId: cliDeviceMatch[1], body: await jsonBody(request), correlationId,
        });
        return send(response, 204, null);
      }
      if (url.pathname === '/api/identity' && request.method === 'GET') {
        if (!identitySessionBroker?.listManagedIdentities) {
          throw Object.assign(new Error('managed identity inventory is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        return send(response, 200, await identitySessionBroker.listManagedIdentities(request, { correlationId }));
      }
      if (url.pathname === '/api/identity/users' && request.method === 'POST') {
        if (!identitySessionBroker?.createManagedIdentity) {
          throw Object.assign(new Error('managed identity creation is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        return send(response, 201, await identitySessionBroker.createManagedIdentity(request, {
          body: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        }));
      }
      const managedRoleMatch = url.pathname.match(/^\/api\/identity\/users\/([0-9a-fA-F-]{36})\/group$/u);
      if (managedRoleMatch && request.method === 'POST') {
        if (!identitySessionBroker?.changeManagedIdentityRole) {
          throw Object.assign(new Error('managed identity role change is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        return send(response, 200, await identitySessionBroker.changeManagedIdentityRole(request, {
          targetSubjectId: managedRoleMatch[1], body: await jsonBody(request), correlationId,
        }));
      }
      const managedLifecycleMatch = url.pathname.match(/^\/api\/identity\/users\/([0-9a-fA-F-]{36})\/(attrs|enabled|onboarding|mfa\/reset)$/u);
      if (managedLifecycleMatch && request.method === 'POST') {
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        const [, targetSubjectId, action] = managedLifecycleMatch;
        const method = {
          attrs: 'updateManagedIdentityProfile',
          enabled: 'setManagedIdentityEnabled',
          onboarding: 'createManagedIdentityOnboardingLink',
          'mfa/reset': 'resetManagedIdentityMfa',
        }[action];
        if (!identitySessionBroker?.[method]) {
          throw Object.assign(new Error('managed identity lifecycle action is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        return send(response, 200, await identitySessionBroker[method](request, {
          targetSubjectId,
          body: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        }));
      }
      if (url.pathname === '/api/identity/session/events' && request.method === 'GET') {
        if (!identitySessionBroker?.listSessionEvents) {
          throw Object.assign(new Error('session event history is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        return send(response, 200, await identitySessionBroker.listSessionEvents(request, {
          limit: onlyQueryParameter(url, 'limit'),
          correlationId,
        }));
      }
      if (url.pathname === '/api/identity/profile/avatar' && request.method === 'GET') {
        if (!identitySessionBroker?.getProfileAvatar) {
          throw Object.assign(new Error('profile avatar is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        return send(response, 200, await identitySessionBroker.getProfileAvatar(request, { correlationId }));
      }
      if (url.pathname === '/api/identity/profile/avatar' && request.method === 'PUT') {
        if (!identitySessionBroker?.selectProfileAvatar) {
          throw Object.assign(new Error('profile avatar selection is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        return send(response, 200, await identitySessionBroker.selectProfileAvatar(request, {
          body: await jsonBody(request), correlationId,
        }));
      }
      if (url.pathname === '/api/identity/profile/avatar/upload' && request.method === 'POST') {
        if (!identitySessionBroker?.uploadProfileAvatar) {
          throw Object.assign(new Error('profile avatar upload is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        return send(response, 200, await identitySessionBroker.uploadProfileAvatar(request, {
          body: await jsonBody(request), correlationId,
        }));
      }
      if (url.pathname === '/api/identity/profile/avatar/content' && request.method === 'GET') {
        if (!identitySessionBroker?.readProfileAvatarContent) {
          throw Object.assign(new Error('profile avatar content is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        return sendAvatar(response, await identitySessionBroker.readProfileAvatarContent(request, {
          digest: onlyQueryParameter(url, 'v'), correlationId,
        }));
      }
      if (url.pathname === '/api/identity/session/preference' && request.method === 'GET') {
        if (!identitySessionBroker?.getSessionPreference) {
          throw Object.assign(new Error('session preference is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        return send(response, 200, await identitySessionBroker.getSessionPreference(request, { correlationId }));
      }
      if (url.pathname === '/api/identity/session/preference' && request.method === 'PUT') {
        if (!identitySessionBroker?.updateSessionPreference) {
          throw Object.assign(new Error('session preference update is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        return send(response, 200, await identitySessionBroker.updateSessionPreference(request, {
          body: await jsonBody(request),
          correlationId,
        }));
      }
      if (url.pathname === '/api/identity/session/login' && request.method === 'POST') {
        if (!identitySessionBroker?.login) throw Object.assign(new Error('target session login is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        const result = await identitySessionBroker.login({
          body: await jsonBody(request),
          requestOrigin: request.headers.origin,
          correlationId,
        });
        return send(response, 200, result.body, { 'set-cookie': result.cookies });
      }
      if (url.pathname === '/api/identity/password/recovery' && request.method === 'POST') {
        if (!identitySessionBroker?.completePasswordRecovery) {
          throw Object.assign(new Error('target password recovery is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        await identitySessionBroker.completePasswordRecovery({
          body: await jsonBody(request),
          requestOrigin: request.headers.origin,
          correlationId,
        });
        return send(response, 204, null, { 'set-cookie': clearSessionCookies() });
      }
      if (url.pathname === '/api/identity/me/password' && request.method === 'POST') {
        if (!identitySessionBroker?.requestOwnedPasswordRecoveryLink) {
          throw Object.assign(new Error('password recovery-link request is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        return send(response, 200, await identitySessionBroker.requestOwnedPasswordRecoveryLink(request, {
          body: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        }));
      }
      if (url.pathname === '/api/identity/session/mfa' && request.method === 'POST') {
        if (!identitySessionBroker?.completeMfa) throw Object.assign(new Error('target session MFA is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        const result = await identitySessionBroker.completeMfa({
          request,
          body: await jsonBody(request),
          correlationId,
        });
        return send(response, 200, result.body, { 'set-cookie': result.cookies });
      }
      if (url.pathname === '/api/identity/session/totp/enrollment' && request.method === 'POST') {
        if (!identitySessionBroker?.beginTotpEnrollment) throw Object.assign(new Error('target TOTP enrollment is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        return send(response, 201, await identitySessionBroker.beginTotpEnrollment({
          request,
          body: await jsonBody(request),
          correlationId,
        }));
      }
      if (url.pathname === '/api/identity/session/totp/verification' && request.method === 'POST') {
        if (!identitySessionBroker?.verifyTotpEnrollment) throw Object.assign(new Error('target TOTP enrollment verification is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        return send(response, 200, await identitySessionBroker.verifyTotpEnrollment({
          request,
          body: await jsonBody(request),
          correlationId,
        }));
      }
      if (url.pathname === '/api/identity/session/step-up' && request.method === 'POST') {
        if (!identitySessionBroker?.stepUp) throw Object.assign(new Error('target session step-up is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        return send(response, 200, await identitySessionBroker.stepUp({
          request, body: await jsonBody(request), correlationId,
        }));
      }
      if (url.pathname === '/api/identity/session/touch' && request.method === 'POST') {
        if (!identitySessionBroker?.touchActivity) throw Object.assign(new Error('target session activity is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        const body = await jsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
          throw Object.assign(new Error('session activity body must be an empty object'), { code: 'ValidationFailed', status: 400 });
        }
        return send(response, 200, { session: await identitySessionBroker.touchActivity(request) });
      }
      if (url.pathname === '/api/identity/sessions' && request.method === 'GET') {
        if (!identitySessionBroker?.listSessions) throw Object.assign(new Error('target session inventory is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        return send(response, 200, await identitySessionBroker.listSessions(request));
      }
      if (url.pathname === '/api/identity/sessions' && request.method === 'DELETE') {
        if (!identitySessionBroker?.revokeAllSessions) throw Object.assign(new Error('target session revocation is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        await identitySessionBroker.revokeAllSessions(request, { correlationId });
        return send(response, 204, null, { 'set-cookie': clearSessionCookies() });
      }
      const ownedSessionMatch = url.pathname.match(/^\/api\/identity\/sessions\/([0-9a-fA-F-]{36})$/);
      if (ownedSessionMatch && request.method === 'DELETE') {
        if (!identitySessionBroker?.revokeSession) throw Object.assign(new Error('target session revocation is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        const revoked = await identitySessionBroker.revokeSession(request, {
          targetSessionId: ownedSessionMatch[1], correlationId,
        });
        return send(response, 204, null, revoked.current ? { 'set-cookie': clearSessionCookies() } : {});
      }
      if (url.pathname === '/api/identity/audit' && request.method === 'GET') {
        const session = await resolveSession(request, { requireCsrf: false, correlationId });
        return send(response, 200, await auditOperations.list({
          session,
          cursor: url.searchParams.get('cursor'),
          limit: url.searchParams.get('limit') || 50,
          correlationId,
        }));
      }
      if (url.pathname === '/api/identity/session' && request.method === 'GET') {
        const session = await resolveSession(request, { requireCsrf: false, correlationId });
        return send(response, 200, identityOperations.getSession({ session, correlationId }));
      }
      if (url.pathname === '/api/identity/me' && request.method === 'GET') {
        const session = await resolveSession(request, { requireCsrf: false, correlationId });
        return send(response, 200, identityOperations.getMe({ session, correlationId }));
      }
      if (url.pathname === '/api/identity/supabase/status' && request.method === 'GET') {
        const session = await resolveSession(request, { requireCsrf: false, correlationId });
        return send(response, 200, await dataIdentityOperations.getSupabaseStatus({ session, correlationId }));
      }
      if (url.pathname === '/api/identity/session' && request.method === 'DELETE') {
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        await identityOperations.revokeSession({ session, correlationId });
        return send(response, 204, null, { 'set-cookie': clearSessionCookies() });
      }
      const operationMatch = url.pathname.match(/^\/api\/platform\/operations\/([0-9a-f-]{36})$/);
      if (operationMatch && request.method === 'GET') {
        const session = await resolveSession(request, { requireCsrf: false, correlationId });
        return send(response, 200, await operationService.get({ session, operationId: operationMatch[1] }));
      }
      const approvalMatch = url.pathname.match(/^\/api\/platform\/operations\/([0-9a-f-]{36})\/approvals$/);
      if (approvalMatch && request.method === 'POST') {
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        const result = await operationService.approve({
          session,
          operationId: approvalMatch[1],
          request: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        });
        return send(response, 202, result.receipt, {
          location: '/api/platform/operations/' + result.receipt.operationId,
          'x-idempotent-replay': String(result.replayed),
        });
      }
      const verificationMatch = url.pathname.match(/^\/api\/platform\/operations\/([0-9a-f-]{36})\/verification$/);
      if (verificationMatch && request.method === 'POST') {
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        const result = await operationService.verify({
          session,
          operationId: verificationMatch[1],
          request: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        });
        return send(response, 200, result.receipt, {
          location: '/api/platform/operations/' + result.receipt.operationId,
          'x-idempotent-replay': String(result.replayed),
        });
      }
      if (url.pathname === '/api/platform/operations' && request.method === 'POST') {
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        const result = await operationService.accept({
          session,
          request: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        });
        return send(response, 202, result.receipt, {
          location: '/api/platform/operations/' + result.receipt.operationId,
          'x-idempotent-replay': String(result.replayed),
        });
      }
      if (url.pathname === '/api/platform/gitea/status' && request.method === 'GET') {
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        if (!platformChangeOperations?.status) {
          throw Object.assign(new Error('Gitea status authority is unavailable'), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'none' });
        }
        const session = await resolveSession(request, { requireCsrf: false, correlationId });
        return send(response, 200, await platformChangeOperations.status({ session, correlationId }));
      }
      if (url.pathname === '/api/platform/releases/status' && request.method === 'GET') {
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        if (!platformReleaseOperations?.status) {
          throw Object.assign(new Error('Platform Release status authority is unavailable'), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'none' });
        }
        const session = await resolveSession(request, { requireCsrf: false, correlationId });
        return send(response, 200, await platformReleaseOperations.status({ session, correlationId }));
      }
      if (url.pathname === '/api/platform/releases/component-target' && request.method === 'POST') {
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        if (!platformReleaseOperations?.generateComponentTarget) {
          throw Object.assign(new Error('Platform Release component target authority is unavailable'), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'none' });
        }
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        return send(response, 200, await platformReleaseOperations.generateComponentTarget({
          session,
          body: await jsonBody(request),
          correlationId,
        }));
      }
      if (url.pathname === '/api/platform/gitea/bootstrap/argocd-verification' && request.method === 'POST') {
        if (!platformChangeOperations?.bootstrapArgocdVerification) {
          throw Object.assign(new Error('Argo CD verification bootstrap is unavailable'), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'none' });
        }
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        const result = await platformChangeOperations.bootstrapArgocdVerification({
          session,
          body: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        });
        return send(response, result.changed ? 201 : 200, result, result.changed ? {
          location: '/api/platform/operations/' + result.requestId,
          'x-idempotent-replay': String(result.duplicate),
        } : {});
      }
      if (url.pathname === '/api/platform/changes' && request.method === 'POST') {
        if (!platformChangeOperations?.propose) {
          throw Object.assign(new Error('Gitea change authority is unavailable'), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'none' });
        }
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        const result = await platformChangeOperations.propose({
          session,
          body: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        });
        return send(response, 201, result, {
          location: '/api/platform/operations/' + result.requestId,
          'x-idempotent-replay': String(result.duplicate),
        });
      }
      const platformChangeApprovalMatch = url.pathname.match(/^\/api\/platform\/changes\/([0-9a-f-]{36})\/approve$/u);
      if (platformChangeApprovalMatch && request.method === 'POST') {
        if (!platformChangeOperations?.approve) {
          throw Object.assign(new Error('Gitea change approval is unavailable'), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'none' });
        }
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        const result = await platformChangeOperations.approve({
          session,
          operationId: platformChangeApprovalMatch[1],
          body: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        });
        return send(response, 200, result, {
          location: '/api/platform/operations/' + result.requestId,
          'x-idempotent-replay': String(result.duplicate),
        });
      }
      if (url.pathname === '/api/admin/extensions/registry-connections/opensphere-ghcr' && request.method === 'GET') {
        const session = await resolveSession(request, { requireCsrf: false, correlationId });
        return send(response, 200, await registryOperations.getRegistryConnection({ session, correlationId }));
      }
      if (url.pathname === '/api/admin/extensions/registry-connections/opensphere-ghcr' && request.method === 'PUT') {
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        const result = await registryOperations.replaceCredential({
          session,
          body: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        });
        return send(response, 202, result.receipt, {
          location: '/api/platform/operations/' + result.receipt.operationId,
          'x-idempotent-replay': String(result.replayed),
        });
      }
      if (url.pathname === '/api/admin/extensions/registry-connections/opensphere-ghcr' && request.method === 'DELETE') {
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        const result = await registryOperations.removeCredential({
          session,
          reason: header(request, 'x-opensphere-reason', 3),
          confirmation: header(request, 'x-opensphere-confirmation'),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        });
        return send(response, 202, result.receipt, {
          location: '/api/platform/operations/' + result.receipt.operationId,
          'x-idempotent-replay': String(result.replayed),
        });
      }
      if (url.pathname === '/api/admin/extensions/revocations' && request.method === 'POST') {
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        const result = await registryOperations.createRevocation({
          session,
          body: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        });
        return send(response, 202, result.receipt, {
          location: '/api/platform/operations/' + result.receipt.operationId,
          'x-idempotent-replay': String(result.replayed),
        });
      }
      if (url.pathname === '/api/admin/extensions/revocations' && request.method === 'GET') {
        const session = await resolveSession(request, { requireCsrf: false, correlationId });
        return send(response, 200, await registryOperations.listRevocations({ session, correlationId }));
      }
      if (url.pathname === '/api/admin/extensions/inspect' && request.method === 'POST') {
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        return send(response, 200, await registryOperations.inspectCandidate({
          session,
          body: await jsonBody(request),
          correlationId,
        }));
      }
      if (url.pathname === '/api/admin/extensions/install' && request.method === 'POST') {
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        const result = await registryOperations.installCandidate({
          session,
          body: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        });
        return send(response, 202, result.receipt, {
          location: '/api/platform/operations/' + result.receipt.operationId,
          'x-idempotent-replay': String(result.replayed),
        });
      }
      if (url.pathname === '/api/admin/extensions/remove' && request.method === 'POST') {
        const session = await resolveSession(request, { requireCsrf: true, correlationId });
        const result = await registryOperations.removeExtension({
          session,
          body: await jsonBody(request),
          idempotencyKey: header(request, 'x-os-idempotency-key', 8),
          correlationId,
        });
        return send(response, 202, result.receipt, {
          location: '/api/platform/operations/' + result.receipt.operationId,
          'x-idempotent-replay': String(result.replayed),
        });
      }
      if (url.pathname === '/api/catalog/entities' && request.method === 'GET') {
        if (!catalogOperations?.listEntities) {
          throw Object.assign(new Error('catalog projection is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        const queryKeys = [...url.searchParams.keys()];
        if (queryKeys.some((key) => !['filter', 'limit'].includes(key))
          || url.searchParams.getAll('filter').length > 1 || url.searchParams.getAll('limit').length > 1) {
          throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        }
        await resolveSession(request, { requireCsrf: false, correlationId });
        return send(response, 200, await catalogOperations.listEntities({
          filter: url.searchParams.get('filter'),
          limit: url.searchParams.get('limit'),
          correlationId,
        }));
      }
      const runtimeResourcesMatch = url.pathname.match(/^\/api\/kubernetes\/services\/([^/]+)$/u);
      if (runtimeResourcesMatch && request.method === 'POST') {
        if (url.search) throw Object.assign(new Error('request query is invalid'), { code: 'ValidationFailed', status: 400 });
        if (!catalogOperations?.runtimeResources) {
          throw Object.assign(new Error('runtime resource projection is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        }
        await resolveSession(request, { requireCsrf: false, correlationId });
        return send(response, 200, await catalogOperations.runtimeResources({
          entityName: runtimeResourcesMatch[1],
          body: await jsonBody(request),
          correlationId,
        }));
      }
      return send(response, 404, errorEnvelope(Object.assign(new Error('route was not found'), { code: 'NotFound' }), correlationId));
    } catch (error) {
      return send(response, Number(error?.status) || 503, errorEnvelope(error, correlationId));
    }
  };
}

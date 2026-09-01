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
  return {
    schemaVersion: '1.0',
    code,
    message: String(error?.message || 'Console API request failed').slice(0, 500),
    retryable: code === 'AuthorityUnavailable' || code === 'DependencyTimeout',
    sideEffect: code === 'AuthorityUnavailable' ? 'unknown' : 'none',
    correlationId,
    operationId: error?.operationId || null,
    details: {},
  };
}

export function createConsoleApiHandler({ resolveSession, operationService, registryOperations, auditOperations, identityOperations, identitySessionBroker, dataIdentityOperations, health = async () => true }) {
  if (typeof resolveSession !== 'function') throw new TypeError('session resolver is required');
  return async function consoleApiHandler(request, response) {
    const requestedCorrelation = String(request.headers['x-correlation-id'] || '').trim();
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
      if (url.pathname === '/api/identity/session/login' && request.method === 'POST') {
        if (!identitySessionBroker?.login) throw Object.assign(new Error('target session login is unavailable'), { code: 'AuthorityUnavailable', status: 503 });
        const result = await identitySessionBroker.login({
          body: await jsonBody(request),
          requestOrigin: request.headers.origin,
          correlationId,
        });
        return send(response, 200, result.body, { 'set-cookie': result.cookies });
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
        return send(response, 204, null, {
          'set-cookie': [
            '__Host-opensphere-session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
            '__Host-opensphere_csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0',
          ],
        });
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
          idempotencyKey: header(request, 'idempotency-key', 8),
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
          idempotencyKey: header(request, 'idempotency-key', 8),
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
          idempotencyKey: header(request, 'idempotency-key', 8),
          correlationId,
        });
        return send(response, 202, result.receipt, {
          location: '/api/platform/operations/' + result.receipt.operationId,
          'x-idempotent-replay': String(result.replayed),
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
          idempotencyKey: header(request, 'idempotency-key', 8),
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
          idempotencyKey: header(request, 'idempotency-key', 8),
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
          idempotencyKey: header(request, 'idempotency-key', 8),
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
          idempotencyKey: header(request, 'idempotency-key', 8),
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
          idempotencyKey: header(request, 'idempotency-key', 8),
          correlationId,
        });
        return send(response, 202, result.receipt, {
          location: '/api/platform/operations/' + result.receipt.operationId,
          'x-idempotent-replay': String(result.replayed),
        });
      }
      return send(response, 404, errorEnvelope(Object.assign(new Error('route was not found'), { code: 'NotFound' }), correlationId));
    } catch (error) {
      return send(response, Number(error?.status) || 503, errorEnvelope(error, correlationId));
    }
  };
}

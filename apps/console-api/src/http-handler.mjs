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

export function createConsoleApiHandler({ resolveSession, operationService, registryOperations, health = async () => true }) {
  if (typeof resolveSession !== 'function') throw new TypeError('session resolver is required');
  return async function consoleApiHandler(request, response) {
    const requestedCorrelation = String(request.headers['x-correlation-id'] || '').trim();
    const correlationId = requestedCorrelation.length >= 8 && requestedCorrelation.length <= 128
      ? requestedCorrelation
      : randomUUID();
    try {
      const url = new URL(request.url, 'http://console-api.local');
      if (url.pathname === '/healthz' && request.method === 'GET') {
        const ready = await health();
        return send(response, ready ? 200 : 503, {
          state: ready ? 'Ready' : 'Unavailable',
          authority: 'SupabasePostgreSQL',
        });
      }
      const operationMatch = url.pathname.match(/^\/api\/platform\/operations\/([0-9a-f-]{36})$/);
      if (operationMatch && request.method === 'GET') {
        const session = await resolveSession(request, { requireCsrf: false });
        return send(response, 200, await operationService.get({ session, operationId: operationMatch[1] }));
      }
      const approvalMatch = url.pathname.match(/^\/api\/platform\/operations\/([0-9a-f-]{36})\/approvals$/);
      if (approvalMatch && request.method === 'POST') {
        const session = await resolveSession(request, { requireCsrf: true });
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
      if (url.pathname === '/api/platform/operations' && request.method === 'POST') {
        const session = await resolveSession(request, { requireCsrf: true });
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
      if (url.pathname === '/api/admin/extensions/registry-connections/opensphere-ghcr' && request.method === 'PUT') {
        const session = await resolveSession(request, { requireCsrf: true });
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
        const session = await resolveSession(request, { requireCsrf: true });
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
        const session = await resolveSession(request, { requireCsrf: true });
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
        const session = await resolveSession(request, { requireCsrf: false });
        return send(response, 200, await registryOperations.listRevocations({ session, correlationId }));
      }
      return send(response, 404, errorEnvelope(Object.assign(new Error('route was not found'), { code: 'NotFound' }), correlationId));
    } catch (error) {
      return send(response, Number(error?.status) || 503, errorEnvelope(error, correlationId));
    }
  };
}

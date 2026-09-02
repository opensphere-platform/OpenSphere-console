const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const METHODS = new Set([...SAFE_METHODS, 'POST', 'PUT', 'PATCH', 'DELETE']);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PLUGIN_ID = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

const exact = (method, ...paths) => Object.freeze(paths.map((path) => Object.freeze([method, path])));
const contracts = Object.freeze({
  osaa: Object.freeze({
    internalMarker: 'r2d2-proxy-v1',
    ownerMarker: 'osaa-gateway-v1',
    routes: Object.freeze([
      ...exact('GET',
        '/api/manual', '/api/manual/document', '/api/manual/documents', '/api/manual/search', '/api/manual/sources',
        '/api/osaa/health', '/api/osaa/conversations', '/api/osaa/operational/status',
        '/api/osaa/graph/nodes', '/api/osaa/incidents', '/api/osaa/incidents/stream',
        '/api/osaa/context', '/api/osaa/metacognition', '/api/osaa/operations',
        '/api/osaa/remediations', '/api/osaa/remediations/', '/api/osaa/remediations/status',
        '/api/osaa/admin/dialogue-state', '/api/osaa/admin/evidence',
        '/api/osaa/admin/knowledge/stats', '/api/osaa/admin/llm-keys', '/api/osaa/admin/usage',
        '/api/osaa/tools/action-bindings', '/api/osaa/tools/manifest'),
      ...exact('POST',
        '/api/osaa/actions/bindings/execute', '/api/osaa/admin/dialogue-state',
        '/api/osaa/admin/evidence/retention', '/api/osaa/admin/knowledge/manual-seed/bundled',
        '/api/osaa/admin/knowledge/reembed', '/api/osaa/admin/llm-keys', '/api/osaa/chat',
        '/api/osaa/tools/control-plane/status'),
      ['GET|PATCH|DELETE', new RegExp(`^/api/osaa/conversations/${UUID}$`, 'iu')],
      ['GET', new RegExp(`^/api/osaa/(?:incidents|operations|remediations)/${UUID}$`, 'iu')],
      ['POST', new RegExp(`^/api/osaa/operations/${UUID}/approvals$`, 'iu')],
      ['POST', new RegExp(`^/api/osaa/remediations/${UUID}/(?:approvals/source|browser-verifications)$`, 'iu')],
      ['DELETE', /^\/api\/osaa\/admin\/llm-keys\/[a-z0-9-]{1,128}$/u],
      ['POST', /^\/api\/osaa\/admin\/llm-keys\/[a-z0-9-]{1,128}\/test$/u],
    ]),
  }),
  notification: Object.freeze({
    internalMarker: 'notification-dispatcher-v1',
    ownerMarker: 'notification-dispatcher-v1',
    routes: Object.freeze([
      ...exact('GET', '/api/notifications/summary', '/api/notifications/channels', '/api/notifications/rules', '/api/notifications/deliveries'),
      ...exact('POST', '/api/notifications/channels', '/api/notifications/rules'),
      ['GET|PUT', new RegExp(`^/api/notifications/channels/${UUID}$`, 'iu')],
      ['POST', new RegExp(`^/api/notifications/channels/${UUID}/(?:enable|disable|test)$`, 'iu')],
      ['POST', new RegExp(`^/api/notifications/deliveries/${UUID}/retry$`, 'iu')],
    ]),
  }),
  externalChannel: Object.freeze({
    internalMarker: 'external-channel-executor-v1',
    ownerMarker: 'external-channel-executor-v1',
    routes: Object.freeze([
      ...exact('GET', '/api/external-channels/summary', '/api/external-channels/backup-targets', '/api/external-channels/backups'),
      ...exact('POST', '/api/external-channels/backup-targets'),
      ['PUT|DELETE', new RegExp(`^/api/external-channels/backup-targets/${UUID}$`, 'iu')],
      ['POST', new RegExp(`^/api/external-channels/backup-targets/${UUID}/(?:test|backup|enable|disable)$`, 'iu')],
      ['POST', new RegExp(`^/api/external-channels/backups/${UUID}/restore-preview$`, 'iu')],
      ['POST', new RegExp(`^/api/external-channels/restores/${UUID}/apply$`, 'iu')],
    ]),
  }),
  osShell: Object.freeze({
    internalMarker: 'os-shell-v1',
    ownerMarker: 'os-shell-control-v1',
    routes: Object.freeze([
      ...exact('GET', '/api/os-shell/readiness', '/api/os-shell/sessions'),
      ...exact('POST', '/api/os-shell/sessions'),
      ['GET|DELETE', new RegExp(`^/api/os-shell/sessions/${UUID}$`, 'iu')],
      ['POST', new RegExp(`^/api/os-shell/sessions/${UUID}/attach-ticket$`, 'iu')],
      ['GET', new RegExp(`^/api/os-shell/sessions/${UUID}/attach$`, 'iu')],
    ]),
  }),
  extension: Object.freeze({
    internalMarker: 'plugin-proxy-v1',
    ownerMarker: 'extension-controller-v1',
    routes: Object.freeze([
      ['GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE', new RegExp(`^/api/plugins/${PLUGIN_ID}(?:/.*)?$`, 'u')],
    ]),
  }),
  extensionManagement: Object.freeze({
    internalMarker: 'extension-management-v1',
    ownerMarker: 'extension-controller-v1',
    routes: Object.freeze([
      ...exact('GET',
        '/api/admin/plugins/catalog', '/api/admin/plugins/registrations',
        '/api/admin/plugins/events', '/api/admin/bindings'),
      ['POST', new RegExp(`^/api/admin/bindings/${PLUGIN_ID}/(?:enable|disable)$`, 'u')],
      ['POST', new RegExp(`^/api/admin/plugins/registrations/${PLUGIN_ID}/(?:enable|disable|uninstall|rollback)$`, 'u')],
      ['POST', new RegExp(`^/api/admin/plugins/packages/${PLUGIN_ID}/(?:icon|navigation)$`, 'u')],
      ...exact('PUT', '/api/admin/plugins/navigation-order'),
    ]),
  }),
});

function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
}

function routeAllowed(contract, method, path) {
  return contract.routes.some(([verbs, target]) => verbs.split('|').includes(method)
    && (typeof target === 'string' ? target === path : target.test(path)));
}

function originalOwnerRequest(request, contract, ownerName) {
  if (request?.headers?.['x-os-internal-authn-subrequest'] !== contract.internalMarker) {
    fail('PermissionDenied', `${ownerName} owner admission is internal only`, 403);
  }
  if (String(request.headers.authorization || '').trim()) {
    fail('PermissionDenied', `${ownerName} browser admission does not accept bearer input`, 403);
  }
  const method = String(request.headers['x-os-original-method'] || '').toUpperCase();
  const uri = String(request.headers['x-os-original-uri'] || '');
  if (!METHODS.has(method) || uri.length < 1 || uri.length > 4096 || /[\r\n]/u.test(uri)) {
    fail('ValidationFailed', `${ownerName} original request is invalid`, 400);
  }
  let parsed;
  try { parsed = new URL(uri, 'http://console-owner.local'); }
  catch { fail('ValidationFailed', `${ownerName} original URI is invalid`, 400); }
  if (parsed.origin !== 'http://console-owner.local' || parsed.hash || !routeAllowed(contract, method, parsed.pathname)) {
    fail('PermissionDenied', `${ownerName} original target is outside the admitted owner routes`, 403);
  }
  return Object.freeze({ method, url: parsed.pathname + parsed.search, headers: request.headers });
}

function authorizer(identitySessionBroker, contract, ownerName) {
  return async (request, { correlationId } = {}) => {
    const original = originalOwnerRequest(request, contract, ownerName);
    const csrfVerified = !SAFE_METHODS.has(original.method);
    const exchanged = await identitySessionBroker.exchangeOwnerAccessCredential(original, {
      requireCsrf: csrfVerified,
      correlationId,
    });
    if (!/^Bearer [A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/u.test(String(exchanged?.authorization || ''))
        || exchanged.authorization.length > 16391) {
      fail('AuthorityUnavailable', `${ownerName} credential exchange returned an invalid credential`, 503);
    }
    return Object.freeze({
      authorization: exchanged.authorization,
      ownerMarker: contract.ownerMarker,
      csrfVerified,
    });
  };
}

export function createOwnerAdmissionOperations({ identitySessionBroker }) {
  if (!identitySessionBroker?.exchangeOwnerAccessCredential) {
    throw new TypeError('browser owner credential exchanger is required');
  }
  return Object.freeze({
    authorizeOsaa: authorizer(identitySessionBroker, contracts.osaa, 'OSAA'),
    authorizeNotification: authorizer(identitySessionBroker, contracts.notification, 'Notification'),
    authorizeExternalChannel: authorizer(identitySessionBroker, contracts.externalChannel, 'External Channel'),
    authorizeOsShell: authorizer(identitySessionBroker, contracts.osShell, 'OS Shell'),
    authorizeExtension: authorizer(identitySessionBroker, contracts.extension, 'Extension'),
    authorizeExtensionManagement: authorizer(identitySessionBroker, contracts.extensionManagement, 'Extension Management'),
  });
}

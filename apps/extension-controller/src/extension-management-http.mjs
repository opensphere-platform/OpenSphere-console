const ID = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const REGISTRATION_ACTION = new RegExp('^/api/admin/plugins/registrations/(' + ID + ')/(enable|disable|uninstall|rollback)$', 'u');
const BINDING_ACTION = new RegExp('^/api/admin/bindings/(' + ID + ')/(enable|disable)$', 'u');
const PACKAGE_PREFERENCE = new RegExp('^/api/admin/plugins/packages/(' + ID + ')/(icon|navigation)$', 'u');
const READ_ROUTES = new Map([
  ['/api/admin/plugins/catalog', 'catalog'],
  ['/api/admin/plugins/registrations', 'registrations'],
  ['/api/admin/plugins/events', 'events'],
  ['/api/admin/bindings', 'bindings'],
]);

function fault(message, code = 'ValidationFailed', status = 400) {
  return Object.assign(new Error(message), { code, status, sideEffect: 'none' });
}
function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function jsonBody(request, maximumBytes) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw fault('Extension management request must be JSON');
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maximumBytes) throw fault('Extension management request is too large', 'ValidationFailed', 413);
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    length += value.length;
    if (length > maximumBytes) throw fault('Extension management request is too large', 'ValidationFailed', 413);
    chunks.push(value);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks, length).toString('utf8') || '{}'); }
  catch { throw fault('Extension management request is invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fault('Extension management body must be an object');
  return body;
}
function exactBody(body, fields) {
  const unknown = Object.keys(body).filter((key) => !fields.includes(key));
  if (unknown.length) throw fault('Extension management body contains unknown fields');
  return body;
}
function noQuery(url) {
  if (url.search) throw fault('Extension management query is not supported');
}

export function isExtensionManagementRoute(method, pathname) {
  if (method === 'GET' && READ_ROUTES.has(pathname)) return true;
  if (method === 'POST' && (REGISTRATION_ACTION.test(pathname) || BINDING_ACTION.test(pathname) || PACKAGE_PREFERENCE.test(pathname))) return true;
  return method === 'PUT' && pathname === '/api/admin/plugins/navigation-order';
}

export function createExtensionManagementHttpHandler({
  operations,
  ownerAdmission,
  maximumBodyBytes = 32 * 1024,
} = {}) {
  if (!operations || typeof ownerAdmission !== 'function'
      || !Number.isInteger(maximumBodyBytes) || maximumBodyBytes < 1024 || maximumBodyBytes > 1024 * 1024) {
    throw new TypeError('Extension management HTTP dependencies are invalid');
  }
  return async function handleExtensionManagement(request, response, url) {
    const method = String(request.method || '').toUpperCase();
    if (!isExtensionManagementRoute(method, url.pathname)) return false;
    noQuery(url);
    const actor = await ownerAdmission(request);
    const correlationId = String(request.headers['x-os-correlation-id'] || '');

    const readOperation = READ_ROUTES.get(url.pathname);
    if (method === 'GET' && readOperation) {
      send(response, 200, await operations[readOperation]({ actor }));
      return true;
    }
    const registration = url.pathname.match(REGISTRATION_ACTION);
    if (method === 'POST' && registration) {
      const body = exactBody(await jsonBody(request, maximumBodyBytes), ['reason']);
      send(response, 202, await operations.registrationAction({
        actor, id: registration[1], action: registration[2], reason: body.reason, correlationId,
      }));
      return true;
    }
    const binding = url.pathname.match(BINDING_ACTION);
    if (method === 'POST' && binding) {
      if (Number(request.headers['content-length'] || 0) > 0 || request.headers['transfer-encoding']) {
        throw fault('Binding action body is not supported');
      }
      send(response, 202, await operations.bindingAction({
        actor, name: binding[1], action: binding[2], correlationId,
      }));
      return true;
    }
    const preference = url.pathname.match(PACKAGE_PREFERENCE);
    if (method === 'POST' && preference) {
      const body = await jsonBody(request, maximumBodyBytes);
      const result = preference[2] === 'icon'
        ? await operations.setIcon({
          actor, id: preference[1], icon: exactBody(body, ['icon']).icon, correlationId,
        })
        : await operations.setNavigation({
          actor, id: preference[1], settings: exactBody(body, ['icon', 'labelOverride', 'bandOverride']), correlationId,
        });
      send(response, 200, result);
      return true;
    }
    if (method === 'PUT' && url.pathname === '/api/admin/plugins/navigation-order') {
      const body = exactBody(await jsonBody(request, maximumBodyBytes), ['ids']);
      send(response, 200, await operations.setNavigationOrder({ actor, ids: body.ids, correlationId }));
      return true;
    }
    return false;
  };
}

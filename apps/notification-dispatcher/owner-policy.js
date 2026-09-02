'use strict';

const { requirePermission } = require('./owner-admission');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const NOTIFICATION_ROUTES = Object.freeze([
  ['GET', /^\/api\/notifications\/summary$/u],
  ['GET', /^\/api\/notifications\/channels$/u],
  ['POST', /^\/api\/notifications\/channels$/u],
  ['GET', new RegExp(`^/api/notifications/channels/${ID}$`, 'iu')],
  ['PUT', new RegExp(`^/api/notifications/channels/${ID}$`, 'iu')],
  ['POST', new RegExp(`^/api/notifications/channels/${ID}/(?:enable|disable|test)$`, 'iu')],
  ['GET', /^\/api\/notifications\/rules$/u],
  ['POST', /^\/api\/notifications\/rules$/u],
  ['GET', /^\/api\/notifications\/deliveries$/u],
  ['POST', new RegExp(`^/api/notifications/deliveries/${ID}/retry$`, 'iu')],
]);

function notificationRequestAllowed(method, path) {
  const verb = String(method || '').toUpperCase();
  return NOTIFICATION_ROUTES.some(([expected, pattern]) => expected === verb && pattern.test(String(path || '')));
}
function authorizeNotification(actor, method, { requireAal2 = true } = {}) {
  const mutation = !SAFE_METHODS.has(String(method || '').toUpperCase());
  return requirePermission(
    actor,
    mutation ? 'console.notification.manage' : 'console.notification.read',
    { requireAal2: mutation && requireAal2, allowAdmin: false },
  );
}

module.exports = { authorizeNotification, notificationRequestAllowed };
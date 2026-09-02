'use strict';

const { requirePermission } = require('./owner-admission');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const EXTERNAL_CHANNEL_ROUTES = Object.freeze([
  ['GET', /^\/api\/external-channels\/summary$/u],
  ['GET', /^\/api\/external-channels\/backup-targets$/u],
  ['POST', /^\/api\/external-channels\/backup-targets$/u],
  ['PUT', new RegExp(`^/api/external-channels/backup-targets/${ID}$`, 'iu')],
  ['DELETE', new RegExp(`^/api/external-channels/backup-targets/${ID}$`, 'iu')],
  ['POST', new RegExp(`^/api/external-channels/backup-targets/${ID}/(?:test|backup|enable|disable)$`, 'iu')],
  ['GET', /^\/api\/external-channels\/backups$/u],
  ['POST', new RegExp(`^/api/external-channels/backups/${ID}/restore-preview$`, 'iu')],
  ['POST', new RegExp(`^/api/external-channels/restores/${ID}/apply$`, 'iu')],
]);

function externalChannelRequestAllowed(method, path) {
  const verb = String(method || '').toUpperCase();
  return EXTERNAL_CHANNEL_ROUTES.some(([expected, pattern]) => expected === verb && pattern.test(String(path || '')));
}
function authorizeExternalChannel(actor, method, { requireAal2 = true } = {}) {
  const mutation = !SAFE_METHODS.has(String(method || '').toUpperCase());
  if (!mutation) return requirePermission(actor, 'console.recovery.read', { allowAdmin: false });
  requirePermission(actor, 'console.backup.restore', { requireAal2, allowAdmin: false });
  if (!actor?.permissions?.includes('console.role.admin')) {
    throw { code: 403, msg: 'external channel administration requires console.role.admin' };
  }
  return actor;
}

module.exports = { authorizeExternalChannel, externalChannelRequestAllowed };
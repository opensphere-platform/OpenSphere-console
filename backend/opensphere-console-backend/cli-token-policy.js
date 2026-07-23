'use strict';

const scopes = Object.freeze({ read: 'console-read', change: 'console-change', admin: 'console-admin' });
const ranks = Object.freeze({ 'console-read': 1, 'console-change': 2, 'console-admin': 3 });

function normalizePatScope(value) {
  const scope = scopes[String(value || 'read').trim().toLowerCase()];
  if (!scope) throw { code: 400, msg: 'scope must be read, change, or admin' };
  return scope;
}

function validatePatTTL(value, maximumSeconds) {
  const ttlSeconds = Number(value || (24 * 60 * 60));
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 5 * 60 || ttlSeconds > maximumSeconds) {
    throw { code: 400, msg: `ttlSeconds must be 300-${maximumSeconds}` };
  }
  return ttlSeconds;
}

function requiredPatScope(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return 'console-read';
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (/^\/api\/platform\/changes(?:\/[^/]+\/approve)?$/.test(pathname)) return 'console-change';
  return 'console-admin';
}

function enforcePatRequestScope(req, actor) {
  if (actor.cliCredentialType !== 'pat') return;
  const required = requiredPatScope(req);
  if ((ranks[actor.cliScope] || 0) < ranks[required]) {
    throw { code: 403, msg: `CLI token scope ${actor.cliScope || 'unknown'} does not allow this request; requires ${required}` };
  }
}

module.exports = { enforcePatRequestScope, normalizePatScope, requiredPatScope, validatePatTTL };

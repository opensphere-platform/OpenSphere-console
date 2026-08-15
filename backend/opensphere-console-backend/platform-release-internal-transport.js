'use strict';

const fs = require('node:fs');
const https = require('node:https');
const tls = require('node:tls');

const INTERNAL_AUTHORITY_CONTRACT = 'opensphere-platform-release-internal-authority/v1';
const INTERNAL_AUTHORITY_ORIGIN =
  'https://opensphere-platform-release-authority.opensphere-console.svc.cluster.local:8446';
const INTERNAL_AUTHORITY_HOST =
  'opensphere-platform-release-authority.opensphere-console.svc.cluster.local';
const INTERNAL_AUTHORITY_CA_FILE = '/var/run/opensphere-platform-release-control-ca/ca.crt';
const ALLOWED_PATHS = new Set([
  '/readyz',
  '/api/platform/reconcile/next',
  '/api/platform/reconcile/manifest',
  '/api/platform/reconcile/receipt',
]);

function exactAuthorityUrl(pathName, origin = INTERNAL_AUTHORITY_ORIGIN) {
  if (!ALLOWED_PATHS.has(pathName)) throw new Error('internal release authority path is not allowed');
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.hostname !== INTERNAL_AUTHORITY_HOST
    || parsedOrigin.port !== '8446' || parsedOrigin.pathname !== '/' || parsedOrigin.search
    || parsedOrigin.hash || parsedOrigin.username || parsedOrigin.password) {
    throw new Error('internal release authority origin is not canonical');
  }
  return new URL(pathName, parsedOrigin);
}

function canonicalCa(caFile = INTERNAL_AUTHORITY_CA_FILE, readFile = fs.readFileSync) {
  if (caFile !== INTERNAL_AUTHORITY_CA_FILE) {
    throw new Error('internal release authority CA path is not canonical');
  }
  const ca = readFile(caFile);
  if (ca.length < 128 || ca.length > 65536) throw new Error('internal release authority CA is invalid');
  return ca;
}

function requestJson(pathName, {
  method = 'GET',
  body,
  authorization,
  timeoutMs = 10000,
  origin = INTERNAL_AUTHORITY_ORIGIN,
  caFile = INTERNAL_AUTHORITY_CA_FILE,
  request = https.request,
  readFile = fs.readFileSync,
} = {}) {
  const url = exactAuthorityUrl(pathName, origin);
  const ca = canonicalCa(caFile, readFile);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method,
      ca,
      servername: INTERNAL_AUTHORITY_HOST,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      checkServerIdentity: tls.checkServerIdentity,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...(authorization ? { authorization } : {}),
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          response.destroy(new Error('internal release authority response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        let parsed;
        try { parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
        catch { return reject(new Error('internal release authority returned invalid JSON')); }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(parsed?.error || `internal release authority HTTP ${response.statusCode}`);
          error.status = response.statusCode;
          return reject(error);
        }
        return resolve(parsed);
      });
    });
    req.setTimeout(Math.max(1000, Math.min(30000, Number(timeoutMs))), () => {
      req.destroy(new Error('internal release authority request timed out'));
    });
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

module.exports = {
  ALLOWED_PATHS,
  INTERNAL_AUTHORITY_CA_FILE,
  INTERNAL_AUTHORITY_CONTRACT,
  INTERNAL_AUTHORITY_HOST,
  INTERNAL_AUTHORITY_ORIGIN,
  exactAuthorityUrl,
  requestJson,
};

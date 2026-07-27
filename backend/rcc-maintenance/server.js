'use strict';

/**
 * RCC node maintenance service.
 *
 * This exists for one reason: credential separation.
 *
 * Cordon, drain and uncordon need Kubernetes write verbs (`nodes: patch`,
 * `pods/eviction: create`). Binding those to the main Console backend would put
 * a token that can cordon every node in the cluster inside the same process
 * that terminates browser sessions, proxies Kubernetes reads, and parses agent
 * payloads. A single flaw there would reach the whole cluster.
 *
 * So the write-capable ServiceAccount lives here, in a process that:
 *   - has no browser surface, no Supabase access and no agent surface
 *   - exposes exactly four internal endpoints
 *   - accepts only HMAC-signed requests from the backend, bound to the body
 *   - is reachable only from the backend pod (NetworkPolicy)
 *
 * The backend holds a shared internal key. It never holds a Kubernetes token
 * that can write.
 */

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const {
  createMaintenanceCoordinator,
  createInClusterMaintenanceClient,
} = require('../opensphere-console-backend/maintenance-coordinator');

const PORT = Number(process.env.PORT || 8080);
const INTERNAL_KEY_FILE = process.env.RCC_MAINTENANCE_KEY_FILE || '';
const TOKEN_PATH = process.env.KUBERNETES_SERVICE_ACCOUNT_TOKEN
  || '/var/run/secrets/kubernetes.io/serviceaccount/token';

const SCHEME = 'RCC-MAINT-V1';
const HEADER_TIMESTAMP = 'x-rcc-maint-timestamp';
const HEADER_NONCE = 'x-rcc-maint-nonce';
const HEADER_SIGNATURE = 'x-rcc-maint-signature';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SKEW_SECONDS = 120;
const NONCE_CAPACITY = 4096;

const NONCE_RE = /^[A-Za-z0-9]{16,64}$/;
const TIMESTAMP_RE = /^[0-9]{1,12}$/;
const PATH_RE = /^\/internal\/maintenance\/(preflight|prepare|uncordon|healthz)$/;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function log(level, msg, detail = {}) {
  console.log(JSON.stringify({ level, msg, ...detail }));
}

/**
 * Loads the shared internal key.
 *
 * Without it the service refuses every request: an unauthenticated maintenance
 * API would be strictly worse than the arrangement it replaces.
 */
function loadInternalKey() {
  if (!INTERNAL_KEY_FILE) return null;
  try {
    const raw = fs.readFileSync(INTERNAL_KEY_FILE);
    const key = Buffer.from(raw.toString('utf8').trim(), 'utf8');
    if (key.length < 32) {
      log('error', 'maintenance internal key is too short');
      return null;
    }
    return key;
  } catch (error) {
    log('error', 'maintenance internal key is unreadable', { error: String(error?.message || error) });
    return null;
  }
}

/** Bounded replay guard for internal calls. */
function createNonceCache() {
  const seen = new Map();
  return {
    claim(nonce, nowSeconds) {
      for (const [value, at] of seen) {
        if (at < nowSeconds - MAX_SKEW_SECONDS * 2) seen.delete(value);
      }
      if (seen.has(nonce)) return false;
      if (seen.size >= NONCE_CAPACITY) return false;
      seen.set(nonce, nowSeconds);
      return true;
    },
  };
}

function canonicalString({ method, path, timestamp, nonce, bodySha256 }) {
  return [SCHEME, method, path, timestamp, nonce, bodySha256].join('\n');
}

function bodyDigest(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

/** Constant-time verification of an internal request. */
function verifyInternal(req, body, key, nonceCache, nowSeconds) {
  if (!key) throw { code: 503, msg: 'maintenance service has no internal key configured' };
  // Browser credentials have no meaning here and must never be a fallback.
  if (req.headers.authorization || req.headers.cookie) {
    throw { code: 401, msg: 'browser credentials are not accepted' };
  }
  const timestamp = String(req.headers[HEADER_TIMESTAMP] ?? '');
  const nonce = String(req.headers[HEADER_NONCE] ?? '');
  const presented = String(req.headers[HEADER_SIGNATURE] ?? '');
  if (!TIMESTAMP_RE.test(timestamp) || !NONCE_RE.test(nonce) || !presented) {
    throw { code: 401, msg: 'internal request is not signed' };
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) {
    throw { code: 401, msg: 'internal request is outside the replay window' };
  }
  const url = new URL(req.url, 'http://maintenance.local');
  const expected = crypto.createHmac('sha256', key)
    .update(canonicalString({
      method: String(req.method || '').toUpperCase(),
      path: url.pathname,
      timestamp,
      nonce,
      bodySha256: bodyDigest(body),
    }), 'utf8')
    .digest('base64');
  const left = Buffer.from(expected, 'base64');
  const right = Buffer.from(presented, 'base64');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw { code: 401, msg: 'internal signature does not verify' };
  }
  // Replay is refused only after the signature proves the caller, so an
  // unauthenticated caller cannot poison the cache.
  if (!nonceCache.claim(nonce, nowSeconds)) {
    throw { code: 409, msg: 'internal request replay detected' };
  }
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw { code: 413, msg: 'internal request too large' };
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function createServer({ coordinator, key = loadInternalKey(), nonceCache = createNonceCache(), now = () => Date.now() }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://maintenance.local');
    const match = PATH_RE.exec(url.pathname);

    if (url.pathname === '/internal/maintenance/healthz') {
      // Liveness only. It reveals nothing and needs no credential.
      return json(res, 200, { ok: true, coordinator: Boolean(coordinator) });
    }
    if (!match) return json(res, 404, { error: 'unknown maintenance route' });
    if (String(req.method || '').toUpperCase() !== 'POST') {
      return json(res, 405, { error: 'maintenance endpoints accept POST only' });
    }

    let body;
    try {
      body = await readBody(req);
      verifyInternal(req, body, key, nonceCache, Math.floor(now() / 1000));
    } catch (error) {
      return json(res, error?.code || 401, { error: error?.msg || 'internal request rejected' });
    }

    if (!coordinator) return json(res, 503, { error: 'kubernetes access is not configured' });

    let payload;
    try {
      payload = JSON.parse(body.toString('utf8') || '{}');
    } catch {
      return json(res, 400, { error: 'internal request body is not JSON' });
    }

    const action = match[1];
    try {
      if (action === 'preflight') {
        const findings = await coordinator.preflight(String(payload.hostId || ''), String(payload.hostname || ''));
        return json(res, 200, findings);
      }
      if (action === 'prepare') {
        const result = await coordinator.prepare(String(payload.hostId || ''), String(payload.hostname || ''));
        log('info', 'maintenance prepare', { host: payload.hostId, prepared: result.prepared });
        return json(res, 200, result);
      }
      // uncordon
      const result = await coordinator.uncordon(String(payload.node || ''));
      log('info', 'maintenance uncordon', { node: payload.node });
      return json(res, 200, result);
    } catch (error) {
      log('error', 'maintenance action failed', { action, error: String(error?.msg || error) });
      return json(res, error?.code || 500, { error: error?.msg || 'maintenance action failed' });
    }
  });
}

function buildCoordinator() {
  if (!fs.existsSync(TOKEN_PATH)) {
    log('warn', 'no kubernetes service account token; maintenance actions will be refused');
    return null;
  }
  return createMaintenanceCoordinator({
    client: createInClusterMaintenanceClient({ readToken: () => fs.readFileSync(TOKEN_PATH, 'utf8').trim() }),
    logger: (line) => console.log(line),
  });
}

if (require.main === module) {
  const key = loadInternalKey();
  if (!key) {
    log('error', 'refusing to start without an internal key: an unauthenticated maintenance API is unacceptable');
    process.exit(2);
  }
  const server = createServer({ coordinator: buildCoordinator(), key });
  server.listen(PORT, () => log('info', 'rcc maintenance service listening', { port: PORT }));
}

module.exports = { createServer, canonicalString, verifyInternal, createNonceCache, SCHEME,
  HEADER_TIMESTAMP, HEADER_NONCE, HEADER_SIGNATURE };

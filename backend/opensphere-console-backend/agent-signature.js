'use strict';

// Fail-closed verification for signed rcc-node-agent requests.
//
// The canonical string built here MUST stay byte-identical to the Go
// implementation in backend/rcc-node-agent/internal/protocol/signing.go.
//
// Design boundaries:
//   * Agent keys are read from a root-mounted file, never from PostgREST, so a
//     compromised operator token cannot enumerate host secrets.
//   * Browser credentials are rejected outright: this endpoint is not an
//     operator surface and must never accept a bearer token or cookie.
//   * Signatures bind method, path, key id, timestamp, nonce, control center,
//     host and body digest. Changing any of them invalidates the request.

const { createHash, createHmac, timingSafeEqual } = require('node:crypto');

const SCHEME = 'RCC-AGENT-V1';

const HEADER_KEY_ID = 'x-rcc-key-id';
const HEADER_TIMESTAMP = 'x-rcc-timestamp';
const HEADER_NONCE = 'x-rcc-nonce';
const HEADER_SIGNATURE = 'x-rcc-signature';
const HEADER_CONTROL_CENTER = 'x-rcc-control-center';
const HEADER_HOST = 'x-rcc-host';
const HEADER_AGENT_VERSION = 'x-rcc-agent-version';

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_SKEW_SECONDS = 300;
// Per key id, not global. A host reports about once a minute against a 600s
// window, so 256 leaves a wide margin while bounding worst-case memory to
// DEFAULT_NONCE_CAPACITY * DEFAULT_NONCE_MAX_KEYS entries.
const DEFAULT_NONCE_CAPACITY = 256;
// Replay protection needs one live nonce partition per configured key. The key
// document is therefore bounded by the same number, so a valid configuration can
// never need more partitions than the cache can hold. See MAX_AGENT_KEYS.
const DEFAULT_NONCE_MAX_KEYS = 512;
const MAX_AGENT_KEYS = DEFAULT_NONCE_MAX_KEYS;
const MIN_SECRET_BYTES = 32;

const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NONCE_RE = /^[A-Za-z0-9]{16,64}$/;
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TIMESTAMP_RE = /^[0-9]{1,12}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const METHOD_RE = /^[A-Z]{3,10}$/;
const PATH_RE = /^\/[A-Za-z0-9/._~-]{0,255}$/;
const SIGNATURE_RE = /^[A-Za-z0-9+/]{43}=$/;

const HEARTBEAT_PATH_RE =
  /^\/api\/control-centers\/([a-z0-9][a-z0-9-]{0,61}[a-z0-9]|[a-z0-9])\/hosts\/([a-z0-9][a-z0-9-]{0,61}[a-z0-9]|[a-z0-9])\/heartbeat$/;

// Stage 2 outbound operation endpoints. Closed set: poll, start, receipt only.
// There is deliberately no path here that could name an arbitrary resource.
const AGENT_OPERATION_PATH_RE =
  /^\/api\/control-centers\/([a-z0-9][a-z0-9-]{0,61}[a-z0-9]|[a-z0-9])\/hosts\/([a-z0-9][a-z0-9-]{0,61}[a-z0-9]|[a-z0-9])\/operations\/(?:poll|start|receipt)$/;

/** Lowercase hex SHA-256 of the raw request body. */
function bodyDigest(body) {
  return createHash('sha256')
    .update(Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8'))
    .digest('hex');
}

/** Builds the canonical signing payload, throwing on any malformed field. */
function canonicalString(request) {
  const checks = [
    ['method', request.method, METHOD_RE],
    ['path', request.path, PATH_RE],
    ['keyId', request.keyId, KEY_ID_RE],
    ['timestamp', request.timestamp, TIMESTAMP_RE],
    ['nonce', request.nonce, NONCE_RE],
    ['controlCenterId', request.controlCenterId, DNS_LABEL_RE],
    ['hostId', request.hostId, DNS_LABEL_RE],
    ['bodySha256', request.bodySha256, DIGEST_RE],
  ];
  for (const [name, value, re] of checks) {
    if (typeof value !== 'string' || !re.test(value)) {
      throw { code: 401, msg: `invalid agent signature field: ${name}` };
    }
  }
  return [
    SCHEME,
    request.method,
    request.path,
    request.keyId,
    request.timestamp,
    request.nonce,
    request.controlCenterId,
    request.hostId,
    request.bodySha256,
  ].join('\n');
}

/** Standard-base64 HMAC-SHA256 over the canonical string. */
function sign(secret, request) {
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
  if (key.length < MIN_SECRET_BYTES) {
    throw { code: 500, msg: 'agent signing key is too short' };
  }
  return createHmac('sha256', key).update(canonicalString(request), 'utf8').digest('base64');
}

/** Constant-time signature comparison. Never throws on attacker input. */
function signatureMatches(secret, request, presented) {
  if (typeof presented !== 'string' || !SIGNATURE_RE.test(presented)) return false;
  let expected;
  try {
    expected = sign(secret, request);
  } catch {
    return false;
  }
  const left = Buffer.from(expected, 'base64');
  const right = Buffer.from(presented, 'base64');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Parses the raw agent URL. Query strings are rejected outright so agent
 * material can never be smuggled through a logged URL.
 *
 * Stage 2 adds the outbound operation endpoints. The set is closed: a path that
 * is not one of these exact shapes is refused, so the signed channel cannot be
 * pointed at any other part of the API.
 */
function parseHeartbeatPath(rawUrl, allowedControlCenters) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 512) {
    throw { code: 400, msg: 'invalid agent request path' };
  }
  if (rawUrl.includes('?') || rawUrl.includes('#')) {
    throw { code: 400, msg: 'agent requests must not carry a query string' };
  }
  if (rawUrl.includes('%')) {
    throw { code: 400, msg: 'agent requests must not use percent encoding' };
  }
  const match = HEARTBEAT_PATH_RE.exec(rawUrl) || AGENT_OPERATION_PATH_RE.exec(rawUrl);
  if (!match) throw { code: 404, msg: 'unknown agent endpoint' };
  const [, controlCenterId, hostId] = match;
  if (!allowedControlCenters.has(controlCenterId)) {
    throw { code: 404, msg: 'unknown control center' };
  }
  return { controlCenterId, hostId, path: rawUrl };
}

/**
 * Bounded replay guard, partitioned per key id.
 *
 * A single shared map would let one key's traffic evict another key's nonces:
 * a compromised or merely chatty host could flush the window for every other
 * host and re-enable replay of a captured request it never signed. Each key id
 * therefore gets its own bounded partition, so eviction pressure from one key
 * can only ever discard that same key's nonces.
 *
 * Partitions are only created after `verifyAgentRequest` has resolved the key
 * id against the configured document, so their number is bounded by the number
 * of enrolled keys. `maxKeys` is a memory backstop, not the primary bound.
 */
function createNonceCache({
  capacity = DEFAULT_NONCE_CAPACITY,
  ttlSeconds = DEFAULT_SKEW_SECONDS * 2,
  maxKeys = DEFAULT_NONCE_MAX_KEYS,
} = {}) {
  const partitions = new Map();

  function prune(partition, cutoff) {
    for (const [nonce, seenAt] of partition) {
      if (seenAt >= cutoff) break;
      partition.delete(nonce);
    }
  }

  return {
    /** Returns false when the nonce was already used inside the window. */
    claim(keyId, nonce, nowSeconds) {
      const cutoff = nowSeconds - ttlSeconds;

      for (const [id, partition] of partitions) {
        prune(partition, cutoff);
        if (partition.size === 0 && id !== keyId) partitions.delete(id);
      }

      let partition = partitions.get(keyId);
      if (!partition) {
        if (partitions.size >= maxKeys) {
          // Never evict another key's partition to make room: dropping live
          // nonces would reopen the replay window for that key. The key
          // document is bounded by MAX_AGENT_KEYS so a valid configuration
          // cannot reach this branch; refusing is the fail-closed outcome.
          return false;
        }
        partition = new Map();
        partitions.set(keyId, partition);
      }

      if (partition.has(nonce)) return false;
      if (partition.size >= capacity) {
        const oldest = partition.keys().next();
        if (!oldest.done) partition.delete(oldest.value);
      }
      partition.set(nonce, nowSeconds);
      return true;
    },
    size() {
      let total = 0;
      for (const partition of partitions.values()) total += partition.size;
      return total;
    },
    sizeFor(keyId) {
      return partitions.get(keyId)?.size ?? 0;
    },
    keyCount() {
      return partitions.size;
    },
  };
}

/**
 * Parses the agent key document. Rotation is explicit: multiple keys may be
 * active at once, and a retired key is refused rather than silently accepted.
 */
function parseAgentKeyDocument(raw) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error('agent key document is not valid JSON');
  }
  if (!doc || doc.version !== 1 || !Array.isArray(doc.keys)) {
    throw new Error('agent key document must be {"version":1,"keys":[...]}');
  }
  // Each key needs its own nonce partition for replay protection to hold. A
  // document with more keys than the cache can retain is rejected here rather
  // than degrading silently once partitions start competing for space.
  if (doc.keys.length > MAX_AGENT_KEYS) {
    throw new Error(`agent key document declares ${doc.keys.length} keys; the replay cache retains at most ${MAX_AGENT_KEYS}`);
  }
  const keys = new Map();
  for (const entry of doc.keys) {
    if (!entry || typeof entry !== 'object') throw new Error('agent key entry must be an object');
    const { keyId, secret, controlCenterId, hostId } = entry;
    const status = entry.status === undefined ? 'active' : entry.status;
    if (!KEY_ID_RE.test(String(keyId ?? ''))) throw new Error(`invalid agent keyId: ${keyId}`);
    if (!DNS_LABEL_RE.test(String(controlCenterId ?? ''))) {
      throw new Error(`agent key ${keyId} has an invalid controlCenterId`);
    }
    if (!DNS_LABEL_RE.test(String(hostId ?? ''))) {
      throw new Error(`agent key ${keyId} has an invalid hostId`);
    }
    if (status !== 'active' && status !== 'revoked') {
      throw new Error(`agent key ${keyId} has an unknown status`);
    }
    const material = Buffer.from(String(secret ?? ''), 'utf8');
    if (material.length < MIN_SECRET_BYTES) {
      throw new Error(`agent key ${keyId} has insufficient key material`);
    }
    if (keys.has(keyId)) throw new Error(`duplicate agent keyId: ${keyId}`);
    keys.set(keyId, { keyId, secret: material, controlCenterId, hostId, status });
  }
  return keys;
}

/** Builds a resolver over a parsed key map. Unknown ids fail closed. */
function createAgentKeyResolver(keys) {
  return function resolveAgentKey(keyId) {
    return keys.get(keyId) ?? null;
  };
}

/**
 * Verifies a signed agent request end to end.
 *
 * @param {object} options
 * @param {import('node:http').IncomingMessage} options.req
 * @param {Buffer} options.body raw request bytes, already length-bounded
 * @param {(keyId: string) => object|null} options.resolveKey
 * @param {Set<string>} options.allowedControlCenters
 * @param {{claim: Function}} options.nonceCache
 * @param {number} [options.nowSeconds]
 * @param {number} [options.skewSeconds]
 * @returns {{keyId: string, controlCenterId: string, hostId: string, agentVersion: string, bodySha256: string}}
 */
function verifyAgentRequest(options) {
  const {
    req,
    body,
    resolveKey,
    allowedControlCenters,
    nonceCache,
    nowSeconds = Math.floor(Date.now() / 1000),
    skewSeconds = DEFAULT_SKEW_SECONDS,
  } = options;

  if (typeof resolveKey !== 'function') throw { code: 503, msg: 'agent key material is not configured' };

  const method = String(req.method || '').toUpperCase();
  if (method !== 'POST') throw { code: 405, msg: 'agent heartbeat requires POST' };

  // An agent must never present browser credentials, and the backend must never
  // fall back to them when the signature is absent or wrong.
  if (req.headers.authorization || req.headers.cookie) {
    throw { code: 401, msg: 'browser credentials are not accepted on agent endpoints' };
  }

  const route = parseHeartbeatPath(req.url, allowedControlCenters);

  const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  if (raw.length > MAX_BODY_BYTES) throw { code: 413, msg: 'agent payload too large' };

  const keyId = String(req.headers[HEADER_KEY_ID] ?? '');
  const timestamp = String(req.headers[HEADER_TIMESTAMP] ?? '');
  const nonce = String(req.headers[HEADER_NONCE] ?? '');
  const signature = String(req.headers[HEADER_SIGNATURE] ?? '');
  const headerControlCenter = String(req.headers[HEADER_CONTROL_CENTER] ?? '');
  const headerHost = String(req.headers[HEADER_HOST] ?? '');
  const agentVersion = String(req.headers[HEADER_AGENT_VERSION] ?? '').slice(0, 64);

  if (!KEY_ID_RE.test(keyId)) throw { code: 401, msg: 'invalid agent key id' };
  if (!TIMESTAMP_RE.test(timestamp)) throw { code: 401, msg: 'invalid agent timestamp' };
  if (!NONCE_RE.test(nonce)) throw { code: 401, msg: 'invalid agent nonce' };

  // Binding: the headers, the URL and the key record must all agree.
  if (headerControlCenter !== route.controlCenterId || headerHost !== route.hostId) {
    throw { code: 401, msg: 'agent binding headers do not match the request path' };
  }

  const skew = Math.abs(nowSeconds - Number(timestamp));
  if (!Number.isFinite(skew) || skew > skewSeconds) {
    throw { code: 401, msg: 'agent timestamp is outside the replay window' };
  }

  const key = resolveKey(keyId);
  // Unknown and revoked keys are indistinguishable to the caller on purpose.
  if (!key || key.status !== 'active') throw { code: 401, msg: 'agent key is not accepted' };
  if (key.controlCenterId !== route.controlCenterId || key.hostId !== route.hostId) {
    throw { code: 401, msg: 'agent key is not bound to this host' };
  }

  const bodySha256 = bodyDigest(raw);
  const signed = {
    method,
    path: route.path,
    keyId,
    timestamp,
    nonce,
    controlCenterId: route.controlCenterId,
    hostId: route.hostId,
    bodySha256,
  };
  if (!signatureMatches(key.secret, signed, signature)) {
    throw { code: 401, msg: 'agent signature verification failed' };
  }

  // The nonce is claimed only after the signature is proven, so an unauthenticated
  // caller cannot poison the replay cache.
  if (!nonceCache.claim(keyId, nonce, nowSeconds)) {
    throw { code: 409, msg: 'agent request replay detected' };
  }

  return {
    keyId,
    controlCenterId: route.controlCenterId,
    hostId: route.hostId,
    agentVersion,
    bodySha256,
  };
}

// ── plan response signing ────────────────────────────────────────────────────
//
// The agent authenticates to us; nothing authenticated us to the agent beyond
// TLS. A plan changes a production host, so it is signed with the same
// host-bound key and bound to the exact work it describes. Must stay
// byte-identical to protocol/response.go in the Go agent.
const RESPONSE_SCHEME = 'RCC-PLAN-V1';
const HEADER_RESPONSE_KEY_ID = 'x-rcc-response-key-id';
const HEADER_RESPONSE_NONCE = 'x-rcc-response-nonce';
const HEADER_RESPONSE_ISSUED_AT = 'x-rcc-response-issued-at';
const HEADER_RESPONSE_SIGNATURE = 'x-rcc-response-signature';

const RESPONSE_NONCE_RE = /^[A-Za-z0-9]{16,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function canonicalResponseString(binding) {
  const checks = [
    ['keyId', binding.keyId, KEY_ID_RE],
    ['controlCenterId', binding.controlCenterId, DNS_LABEL_RE],
    ['hostId', binding.hostId, DNS_LABEL_RE],
    ['operationId', binding.operationId, UUID_RE],
    ['issuedAt', binding.issuedAt, TIMESTAMP_RE],
    ['nonce', binding.nonce, RESPONSE_NONCE_RE],
    ['bodySha256', binding.bodySha256, DIGEST_RE],
  ];
  for (const [name, value, re] of checks) {
    if (typeof value !== 'string' || !re.test(value)) {
      throw { code: 500, msg: `invalid plan response field: ${name}` };
    }
  }
  const attempt = Number(binding.attempt);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100) {
    throw { code: 500, msg: 'invalid plan response field: attempt' };
  }
  return [
    RESPONSE_SCHEME,
    binding.keyId,
    binding.controlCenterId,
    binding.hostId,
    binding.operationId,
    String(attempt),
    binding.issuedAt,
    binding.nonce,
    binding.bodySha256,
  ].join('\n');
}

/** Standard-base64 HMAC over the canonical plan-response string. */
function signResponse(secret, binding) {
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
  if (key.length < MIN_SECRET_BYTES) throw { code: 500, msg: 'response signing key is too short' };
  return createHmac('sha256', key).update(canonicalResponseString(binding), 'utf8').digest('base64');
}

/** Builds the headers a signed plan response must carry. */
function planResponseHeaders({ secret, keyId, controlCenterId, hostId, operationId, attempt, body, nowSeconds, nonce }) {
  const binding = {
    keyId,
    controlCenterId,
    hostId,
    operationId,
    attempt,
    issuedAt: String(nowSeconds),
    nonce,
    bodySha256: bodyDigest(body),
  };
  return {
    [HEADER_RESPONSE_KEY_ID]: keyId,
    [HEADER_RESPONSE_NONCE]: nonce,
    [HEADER_RESPONSE_ISSUED_AT]: binding.issuedAt,
    [HEADER_RESPONSE_SIGNATURE]: signResponse(secret, binding),
  };
}

module.exports = {
  RESPONSE_SCHEME,
  HEADER_RESPONSE_KEY_ID,
  HEADER_RESPONSE_NONCE,
  HEADER_RESPONSE_ISSUED_AT,
  HEADER_RESPONSE_SIGNATURE,
  canonicalResponseString,
  signResponse,
  planResponseHeaders,
  SCHEME,
  MAX_BODY_BYTES,
  DEFAULT_SKEW_SECONDS,
  MIN_SECRET_BYTES,
  HEADER_KEY_ID,
  HEADER_TIMESTAMP,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_CONTROL_CENTER,
  HEADER_HOST,
  HEADER_AGENT_VERSION,
  bodyDigest,
  canonicalString,
  sign,
  signatureMatches,
  parseHeartbeatPath,
  createNonceCache,
  parseAgentKeyDocument,
  createAgentKeyResolver,
  verifyAgentRequest,
  MAX_AGENT_KEYS,
  DEFAULT_NONCE_CAPACITY,
};

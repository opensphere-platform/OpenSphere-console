'use strict';

/**
 * Backend-side client for the separate maintenance service.
 *
 * The Console backend must not hold a Kubernetes credential that can cordon
 * nodes or evict pods. It therefore does not talk to the Kubernetes API for
 * maintenance at all: it asks a small, separately-credentialed service to do
 * it, over an HMAC-signed internal call bound to the exact request body.
 *
 * The shape returned matches the coordinator interface the operation API
 * already consumes, so the API is unaware of which side of the boundary the
 * work happens on.
 */

const crypto = require('crypto');
const fs = require('fs');

/**
 * Reads a response body under a byte cap, or null if it exceeds it.
 *
 * `response.text()` buffers whatever the peer sends before anything can look at
 * the length, so a cap applied afterwards bounds what is parsed and not what is
 * held. The maintenance service is in-cluster and trusted, but a wedged or
 * compromised one should not be able to exhaust the console backend's memory.
 */
async function readBounded(response, limit) {
  if (!response.body) return '';
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) return null;
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

const SCHEME = 'RCC-MAINT-V1';
const HEADER_TIMESTAMP = 'x-rcc-maint-timestamp';
const HEADER_NONCE = 'x-rcc-maint-nonce';
const HEADER_SIGNATURE = 'x-rcc-maint-signature';

// A prepare waits for pods to leave and for replacements to become Ready, so
// this must outlast RCC_DRAIN_TIMEOUT_MS on the maintenance side twice over.
const DEFAULT_TIMEOUT_MS = 420000;
const MAX_RESPONSE_BYTES = 256 * 1024;

function canonicalString({ method, path, timestamp, nonce, bodySha256 }) {
  return [SCHEME, method, path, timestamp, nonce, bodySha256].join('\n');
}

/**
 * @param baseUrl   internal service URL, cluster-local only
 * @param keyFile   path to the shared internal key
 */
function createMaintenanceServiceClient({
  baseUrl = process.env.RCC_MAINTENANCE_URL || '',
  keyFile = process.env.RCC_MAINTENANCE_KEY_FILE || '',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
  logger = null,
} = {}) {
  if (!baseUrl || !keyFile) return null;

  let key;
  try {
    key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'utf8');
  } catch (error) {
    if (logger) logger(JSON.stringify({ level: 'error', msg: 'maintenance key unreadable', error: String(error?.message || error) }));
    return null;
  }
  if (key.length < 32) {
    if (logger) logger(JSON.stringify({ level: 'error', msg: 'maintenance key is too short' }));
    return null;
  }

  async function call(path, payload) {
    const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = crypto.randomBytes(16).toString('hex');
    const signature = crypto.createHmac('sha256', key)
      .update(canonicalString({
        method: 'POST',
        path,
        timestamp,
        nonce,
        bodySha256: crypto.createHash('sha256').update(body).digest('hex'),
      }), 'utf8')
      .digest('base64');

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        [HEADER_TIMESTAMP]: timestamp,
        [HEADER_NONCE]: nonce,
        [HEADER_SIGNATURE]: signature,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await readBounded(response, MAX_RESPONSE_BYTES);
    if (text === null) {
      throw { code: 502, msg: 'maintenance service response too large' };
    }
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw { code: 502, msg: 'maintenance service response is not JSON' };
    }
    if (!response.ok) {
      throw { code: response.status, msg: parsed?.error || `maintenance service returned ${response.status}` };
    }
    return parsed;
  }

  return {
    async preflight(hostId, hostname) {
      return call('/internal/maintenance/preflight', { hostId, hostname });
    },
    async prepare(hostId, hostname) {
      return call('/internal/maintenance/prepare', { hostId, hostname });
    },
    async uncordon(node) {
      return call('/internal/maintenance/uncordon', { node });
    },
  };
}

module.exports = { createMaintenanceServiceClient, canonicalString, SCHEME,
  HEADER_TIMESTAMP, HEADER_NONCE, HEADER_SIGNATURE };

'use strict';

/**
 * Read-only Beszel metrics adapter for the RCC Linux host page.
 *
 * The browser never receives a Beszel credential or PocketBase token. It asks
 * the normal RCC plugin API, which re-verifies the RCC reader assignment,
 * resolves one explicitly configured RCC host -> Beszel system binding, and
 * projects a small allowlisted metrics schema from Beszel's PocketBase API.
 *
 * Beszel remains an observation source only. This module has no mutation
 * method, agent credential, host-control path, Kubernetes credential or raw
 * PocketBase proxy.
 */

const fs = require('fs');

const PLUGIN_API_NAMESPACE = '/api/plugins/linux-host-manager';
const METRICS_ROUTE_RE = new RegExp(
  `^${PLUGIN_API_NAMESPACE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  + '/control-centers/([^/]+)/hosts/([^/]+)/metrics$',
);
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const BESZEL_SYSTEM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const POCKETBASE_ID_RE = /^[a-z0-9]{15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const GIB_BYTES = 1024 ** 3;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_UPSTREAM_BODY_BYTES = 1024 * 1024;
const MAX_SYSTEM_BINDINGS = 200;
const MAX_POINTS = 100;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const RANGE_SPECS = Object.freeze({
  '1h': Object.freeze({
    sourceType: '1m', durationMs: 60 * 60 * 1000, resolutionSeconds: 60, maxPoints: 65,
  }),
  '12h': Object.freeze({
    sourceType: '10m', durationMs: 12 * 60 * 60 * 1000, resolutionSeconds: 600, maxPoints: 75,
  }),
  '24h': Object.freeze({
    sourceType: '20m', durationMs: 24 * 60 * 60 * 1000, resolutionSeconds: 1200, maxPoints: 80,
  }),
  '1w': Object.freeze({
    sourceType: '120m', durationMs: 7 * 24 * 60 * 60 * 1000, resolutionSeconds: 7200, maxPoints: 90,
  }),
  '30d': Object.freeze({
    sourceType: '480m', durationMs: 30 * 24 * 60 * 60 * 1000, resolutionSeconds: 28800, maxPoints: 100,
  }),
});

class BeszelMetricsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BeszelMetricsError';
    this.code = code;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeCredential(value, { name, min, max }) {
  if (typeof value !== 'string' || value.length < min || value.length > max
      || CONTROL_CHARS_RE.test(value)) {
    throw new BeszelMetricsError(503, `Beszel ${name} is not valid`);
  }
  return value;
}

/**
 * Loads the one server-only Secret document mounted into the RCC backend.
 *
 * Shape:
 * {
 *   "email": "rcc-metrics@...",
 *   "password": "...",
 *   "systems": { "cc2/cmars-...": "CMARS-..." }
 * }
 */
function loadBeszelReaderConfig(filePath) {
  if (!filePath) return null;

  let stat;
  let raw;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CONFIG_BYTES) {
      throw new Error('not a bounded regular file');
    }
    // Kubernetes Secret volumes are root:fsGroup 0440. Local escrow is 0600.
    // Both are accepted; write/execute bits and all world access are not.
    const mode = stat.mode & 0o777;
    if ((mode & 0o022) !== 0 || (mode & 0o111) !== 0 || (mode & 0o007) !== 0) {
      throw new Error('unsafe file mode');
    }
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new BeszelMetricsError(503, 'Beszel reader configuration is unavailable or unsafe');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BeszelMetricsError(503, 'Beszel reader configuration is not valid JSON');
  }
  if (!plainObject(parsed) || !exactKeys(parsed, ['email', 'password', 'systems'])) {
    throw new BeszelMetricsError(503, 'Beszel reader configuration has an unsupported shape');
  }

  const email = safeCredential(parsed.email, { name: 'reader email', min: 3, max: 254 });
  if (!EMAIL_RE.test(email)) {
    throw new BeszelMetricsError(503, 'Beszel reader email is not valid');
  }
  const password = safeCredential(parsed.password, { name: 'reader password', min: 16, max: 512 });

  if (!plainObject(parsed.systems)) {
    throw new BeszelMetricsError(503, 'Beszel system bindings are not an object');
  }
  const bindings = Object.entries(parsed.systems);
  if (bindings.length < 1 || bindings.length > MAX_SYSTEM_BINDINGS) {
    throw new BeszelMetricsError(503, 'Beszel system binding count is outside the supported range');
  }

  const systems = {};
  for (const [binding, systemName] of bindings) {
    const parts = binding.split('/');
    if (parts.length !== 2 || !parts.every((part) => DNS_LABEL_RE.test(part))) {
      throw new BeszelMetricsError(503, `Beszel system binding '${binding}' is not valid`);
    }
    if (typeof systemName !== 'string' || !BESZEL_SYSTEM_NAME_RE.test(systemName)) {
      throw new BeszelMetricsError(503, `Beszel system name for '${binding}' is not valid`);
    }
    systems[binding] = systemName;
  }

  return Object.freeze({ email, password, systems: Object.freeze(systems) });
}

function parseBeszelBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    throw new BeszelMetricsError(503, 'Beszel URL is not valid');
  }
  if (!['https:', 'http:'].includes(url.protocol)
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) {
    throw new BeszelMetricsError(503, 'Beszel URL must be an HTTP(S) origin without credentials or a path');
  }
  // Cleartext is accepted only for the Kubernetes service DNS suffix. CC2 uses
  // the public HTTPS origin, so its reader credential is encrypted in transit.
  if (url.protocol === 'http:' && !url.hostname.endsWith('.svc.cluster.local')) {
    throw new BeszelMetricsError(503, 'cleartext Beszel URL is allowed only for cluster-local service DNS');
  }
  return url.origin;
}

function parseMetricsRoute(rawUrl, allowedControlCenters) {
  const url = new URL(String(rawUrl || ''), 'http://rcc.invalid');
  const match = METRICS_ROUTE_RE.exec(url.pathname);
  if (!match) return null;

  const [, controlCenterId, hostId] = match;
  if (!DNS_LABEL_RE.test(controlCenterId) || !DNS_LABEL_RE.test(hostId)) {
    throw new BeszelMetricsError(400, 'invalid control center or host id');
  }
  if (!allowedControlCenters.has(controlCenterId)) {
    throw new BeszelMetricsError(404, 'control center is not configured');
  }
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== 'range') || url.searchParams.getAll('range').length > 1) {
    throw new BeszelMetricsError(400, 'only one range query parameter is supported');
  }
  const range = url.searchParams.get('range') || '1h';
  if (!RANGE_SPECS[range]) {
    throw new BeszelMetricsError(400, `range must be one of ${Object.keys(RANGE_SPECS).join(', ')}`);
  }
  return { controlCenterId, hostId, range };
}

function boundedNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(Math.min(max, Math.max(min, number)) * 100) / 100;
}

function gibToBytes(value) {
  const gib = boundedNumber(value, { max: 16 * 1024 * 1024 });
  if (gib === null) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(gib * GIB_BYTES));
}

function tupleNumber(value, index, max = Number.MAX_SAFE_INTEGER) {
  return Array.isArray(value) ? boundedNumber(value[index], { max }) : null;
}

function projectPoint(record, { sinceMs, nowMs }) {
  if (!plainObject(record) || !plainObject(record.stats)) return null;
  const timestampMs = Date.parse(String(record.created || ''));
  if (!Number.isFinite(timestampMs) || timestampMs < sinceMs || timestampMs > nowMs + FUTURE_SKEW_MS) {
    return null;
  }
  const stats = record.stats;
  return {
    timestamp: new Date(timestampMs).toISOString(),
    cpuPercent: boundedNumber(stats.cpu, { max: 100 }),
    memoryTotalBytes: gibToBytes(stats.m),
    memoryUsedBytes: gibToBytes(stats.mu),
    memoryPercent: boundedNumber(stats.mp, { max: 100 }),
    diskTotalBytes: gibToBytes(stats.d),
    diskUsedBytes: gibToBytes(stats.du),
    diskPercent: boundedNumber(stats.dp, { max: 100 }),
    diskReadBytesPerSecond: tupleNumber(stats.dio, 0, 10 ** 15),
    diskWriteBytesPerSecond: tupleNumber(stats.dio, 1, 10 ** 15),
    networkSendBytesPerSecond: tupleNumber(stats.b, 0, 10 ** 15),
    networkReceiveBytesPerSecond: tupleNumber(stats.b, 1, 10 ** 15),
    load1: tupleNumber(stats.la, 0, 10 ** 6),
    load5: tupleNumber(stats.la, 1, 10 ** 6),
    load15: tupleNumber(stats.la, 2, 10 ** 6),
    gapBefore: false,
  };
}

async function readBoundedJson(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BODY_BYTES) {
    throw new BeszelMetricsError(502, 'Beszel response exceeded the accepted size');
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPSTREAM_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new BeszelMetricsError(502, 'Beszel response exceeded the accepted size');
    }
    chunks.push(Buffer.from(value));
  }
  if (!total) return null;
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new BeszelMetricsError(502, 'Beszel returned invalid JSON');
  }
}

function pocketBaseTimestamp(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function tokenExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(Number(payload.exp)) ? Number(payload.exp) * 1000 : 0;
  } catch {
    return 0;
  }
}

function createBeszelClient({
  baseUrl,
  config,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 8000,
}) {
  if (!config) return null;
  if (typeof fetchImpl !== 'function') {
    throw new BeszelMetricsError(503, 'Beszel HTTP client is unavailable');
  }
  const origin = parseBeszelBaseUrl(baseUrl);
  const timeout = Math.max(1000, Math.min(30000, Number(timeoutMs) || 8000));
  let token = '';
  let tokenExpiresAt = 0;
  let authInFlight = null;

  async function requestJson(pathname, {
    method = 'GET',
    body,
    authorization = '',
    query,
  } = {}) {
    const url = new URL(pathname, `${origin}/`);
    for (const [key, value] of Object.entries(query || {})) {
      url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(authorization ? { authorization } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const parsed = await readBoundedJson(response);
      return { status: response.status, ok: response.ok, body: parsed };
    } catch (error) {
      if (error instanceof BeszelMetricsError) throw error;
      throw new BeszelMetricsError(502, 'Beszel is unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  async function authenticate() {
    // Do not reuse a token close to expiry; a request racing expiry should
    // re-authenticate before it reaches the metrics query.
    if (token && (!tokenExpiresAt || tokenExpiresAt - now() > 60_000)) return token;
    if (authInFlight) return authInFlight;

    authInFlight = (async () => {
      const response = await requestJson('/api/collections/users/auth-with-password', {
        method: 'POST',
        body: { identity: config.email, password: config.password },
      });
      const record = response.body?.record;
      const nextToken = response.body?.token;
      if (!response.ok || typeof nextToken !== 'string' || nextToken.length < 32
          || nextToken.length > 8192 || /\s/.test(nextToken)) {
        throw new BeszelMetricsError(503, 'Beszel reader authentication failed');
      }
      // A credential accidentally promoted to user/admin would regain system
      // mutation routes. Refuse it instead of silently broadening RCC authority.
      if (record?.role !== 'readonly' || record?.verified !== true) {
        throw new BeszelMetricsError(503, 'Beszel RCC credential is not a verified readonly user');
      }
      token = nextToken;
      tokenExpiresAt = tokenExpiryMs(nextToken);
      return token;
    })();
    try {
      return await authInFlight;
    } finally {
      authInFlight = null;
    }
  }

  async function authenticatedGet(pathname, query, retry = true) {
    const authToken = await authenticate();
    const response = await requestJson(pathname, { authorization: authToken, query });
    if (response.status === 401 && retry) {
      token = '';
      tokenExpiresAt = 0;
      return authenticatedGet(pathname, query, false);
    }
    if (!response.ok) {
      throw new BeszelMetricsError(
        response.status === 401 || response.status === 403 ? 503 : 502,
        'Beszel refused the read-only metrics query',
      );
    }
    return response.body;
  }

  async function fetchMetrics({ controlCenterId, hostId, range }) {
    const spec = RANGE_SPECS[range];
    const binding = `${controlCenterId}/${hostId}`;
    const systemName = config.systems[binding];
    if (!systemName) {
      throw new BeszelMetricsError(503, 'Beszel metrics are not bound to this RCC host');
    }

    const systemFilter = `name="${systemName.replace(/(["\\])/g, '\\$1')}"`;
    const systems = await authenticatedGet('/api/collections/systems/records', {
      page: 1,
      perPage: 2,
      filter: systemFilter,
      fields: 'id,name,status,updated,info',
    });
    if (!Array.isArray(systems?.items) || systems.items.length !== 1) {
      throw new BeszelMetricsError(502, 'Beszel system binding did not resolve exactly once');
    }
    const system = systems.items[0];
    if (!POCKETBASE_ID_RE.test(String(system?.id || '')) || system?.name !== systemName) {
      throw new BeszelMetricsError(502, 'Beszel system binding returned an invalid identity');
    }

    const nowMs = now();
    const sinceMs = nowMs - spec.durationMs;
    const statsFilter = `system="${system.id}" && created > "${
      pocketBaseTimestamp(new Date(sinceMs))
    }" && type="${spec.sourceType}"`;
    const records = await authenticatedGet('/api/collections/system_stats/records', {
      page: 1,
      perPage: Math.min(MAX_POINTS, spec.maxPoints),
      filter: statsFilter,
      fields: 'created,stats',
      sort: 'created',
    });
    if (!Array.isArray(records?.items)) {
      throw new BeszelMetricsError(502, 'Beszel metrics response has an invalid shape');
    }

    const byTimestamp = new Map();
    let droppedPoints = 0;
    for (const record of records.items.slice(0, MAX_POINTS)) {
      const point = projectPoint(record, { sinceMs, nowMs });
      if (!point) {
        droppedPoints += 1;
        continue;
      }
      byTimestamp.set(point.timestamp, point);
    }
    const points = [...byTimestamp.values()]
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .slice(-spec.maxPoints);

    let gapCount = 0;
    for (let index = 1; index < points.length; index += 1) {
      const delta = Date.parse(points[index].timestamp) - Date.parse(points[index - 1].timestamp);
      if (delta > spec.resolutionSeconds * 1000 * 1.5) {
        points[index].gapBefore = true;
        gapCount += 1;
      }
    }

    const totalItems = Number(records.totalItems);
    const truncated = Number.isFinite(totalItems) && totalItems > records.items.length;
    const latest = points.at(-1) || null;
    const latestAgeSeconds = latest
      ? Math.max(0, Math.floor((nowMs - Date.parse(latest.timestamp)) / 1000))
      : null;
    const upstreamStatus = ['up', 'down', 'paused', 'pending'].includes(system.status)
      ? system.status : 'unknown';
    const staleAfter = Math.max(180, spec.resolutionSeconds * 3);
    const freshness = upstreamStatus !== 'up'
      ? 'offline'
      : (latestAgeSeconds === null || latestAgeSeconds > staleAfter ? 'stale' : 'fresh');

    const warnings = [];
    if (truncated) warnings.push('Beszel returned more points than the bounded RCC response can include.');
    if (droppedPoints) warnings.push(`${droppedPoints} invalid Beszel point(s) were discarded.`);
    if (gapCount) warnings.push(`${gapCount} collection gap(s) are shown as breaks in the charts.`);
    if (!points.length) warnings.push('Beszel has no points for the selected range.');
    if (upstreamStatus !== 'up') warnings.push(`Beszel reports the system as ${upstreamStatus}.`);

    return {
      schemaVersion: 'rcc.host.metrics/v1',
      source: {
        name: 'Beszel',
        agentVersion: typeof system.info?.v === 'string'
          ? system.info.v.replace(CONTROL_CHARS_RE, '').slice(0, 32) : '',
        mode: 'readonly-api',
      },
      controlCenterId,
      hostId,
      range,
      sourceResolution: spec.sourceType,
      resolutionSeconds: spec.resolutionSeconds,
      generatedAt: new Date(nowMs).toISOString(),
      system: {
        name: systemName,
        status: upstreamStatus,
        updatedAt: Number.isFinite(Date.parse(String(system.updated || '')))
          ? new Date(Date.parse(system.updated)).toISOString() : null,
        freshness,
        latestAgeSeconds,
      },
      truncated,
      gapCount,
      points,
      latest,
      warnings: warnings.slice(0, 8),
    };
  }

  return Object.freeze({ fetchMetrics });
}

function createBeszelMetricsApi({
  restRequest,
  verifyReader,
  audit = async () => {},
  allowedControlCenters: allowedInput,
  client,
}) {
  const allowedControlCenters = new Set(allowedInput || ['cc2']);

  async function loadHost(controlCenterId, hostId) {
    const rows = await restRequest('host', {
      query: [
        `control_center_id=eq.${encodeURIComponent(controlCenterId)}`,
        `host_id=eq.${encodeURIComponent(hostId)}`,
        'status=eq.active',
        'select=id,host_id,control_center_id,status',
        'limit=1',
      ].join('&'),
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  async function handle(req, res) {
    let route;
    try {
      route = parseMetricsRoute(req.url, allowedControlCenters);
    } catch (error) {
      sendJson(res, error?.code || 400, { error: error?.message || 'invalid metrics route' });
      return true;
    }
    if (!route) return false;

    if (String(req.method || '').toUpperCase() !== 'GET') {
      sendJson(res, 405, { error: 'Beszel metrics are read-only' });
      return true;
    }

    try {
      const actor = await verifyReader(req, route.controlCenterId);
      const host = await loadHost(route.controlCenterId, route.hostId);
      if (!host) throw new BeszelMetricsError(404, 'host not found');
      if (!client) throw new BeszelMetricsError(503, 'Beszel metrics source is not configured');

      const metrics = await client.fetchMetrics(route);
      await audit(actor, {
        action: 'rcc.host.metrics.read',
        controlCenterId: route.controlCenterId,
        hostId: route.hostId,
        source: 'beszel',
        range: route.range,
        pointCount: metrics.points.length,
        freshness: metrics.system.freshness,
      });
      sendJson(res, 200, metrics);
    } catch (error) {
      const code = Number.isInteger(error?.code) ? error.code : 502;
      sendJson(res, code, {
        error: error instanceof BeszelMetricsError
          ? error.message : 'Beszel metrics are unavailable',
      });
    }
    return true;
  }

  return Object.freeze({ handle });
}

module.exports = {
  PLUGIN_API_NAMESPACE,
  RANGE_SPECS,
  BeszelMetricsError,
  loadBeszelReaderConfig,
  parseMetricsRoute,
  projectPoint,
  createBeszelClient,
  createBeszelMetricsApi,
};

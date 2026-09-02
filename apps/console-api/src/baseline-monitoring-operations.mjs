const RANGE = Object.freeze({
  '1h': Object.freeze({ type: '1m', seconds: 60 * 60 }),
  '12h': Object.freeze({ type: '10m', seconds: 12 * 60 * 60 }),
  '24h': Object.freeze({ type: '20m', seconds: 24 * 60 * 60 }),
  '7d': Object.freeze({ type: '120m', seconds: 7 * 24 * 60 * 60 }),
  '30d': Object.freeze({ type: '480m', seconds: 30 * 24 * 60 * 60 }),
});

const SYSTEM_ID = /^[A-Za-z0-9_-]{1,64}$/u;

function fault(message, code = 'AuthorityUnavailable', status = 503) {
  return Object.assign(new Error(message), { code, status });
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function configuredOrigin(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new TypeError('Beszel base URL must be an absolute HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new TypeError('Beszel base URL must be an HTTP(S) origin without credentials, path, query, or fragment');
  }
  return parsed.origin;
}

async function boundedJson(response, maximumResponseBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumResponseBytes) {
    throw fault('Beszel response exceeds the configured limit', 'AuthorityContractViolation', 502);
  }
  if (!response.body) throw fault('Beszel returned no response body', 'AuthorityContractViolation', 502);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumResponseBytes) {
      await reader.cancel();
      throw fault('Beszel response exceeds the configured limit', 'AuthorityContractViolation', 502);
    }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8') || '{}'); }
  catch { throw fault('Beszel returned invalid JSON', 'AuthorityContractViolation', 502); }
}

export function normalizeBeszelSystem(row) {
  const info = row?.info && typeof row.info === 'object' && !Array.isArray(row.info) ? row.info : {};
  return Object.freeze({
    id: String(row?.id || ''),
    name: String(row?.name || info.h || ''),
    hostname: String(info.h || row?.name || ''),
    status: ['up', 'down', 'paused', 'pending'].includes(row?.status) ? row.status : 'unknown',
    observedAt: row?.updated || null,
    agentVersion: String(info.v || row?.v || ''),
    os: String(info.o || info.os?.name || ''),
    kernel: String(info.k || ''),
    cpuModel: String(info.m || ''),
    cpuThreads: finiteNumber(info.t),
    cpuCores: finiteNumber(info.c),
    cpuPercent: finiteNumber(info.cpu),
    memoryPercent: finiteNumber(info.mp),
    diskPercent: finiteNumber(info.dp),
    loadAverage: Object.freeze(Array.isArray(info.la) ? info.la.slice(0, 3).map(finiteNumber) : []),
    uptimeSeconds: finiteNumber(info.u),
    temperatureCelsius: finiteNumber(info.dt),
    bandwidthMegabytes: finiteNumber(info.b),
    connectionType: info.ct || null,
    kubernetes: null,
    binding: 'beszel-authoritative',
    identity: 'beszel-system',
    bindingEvidence: null,
    stateAgreement: 'not-applicable',
  });
}

export function normalizeBeszelStats(record) {
  const stats = record?.stats && typeof record.stats === 'object' && !Array.isArray(record.stats) ? record.stats : {};
  const diskIo = Array.isArray(stats.dio)
    ? [finiteNumber(stats.dio[0]), finiteNumber(stats.dio[1])]
    : [finiteNumber(stats.dr), finiteNumber(stats.dw)].map((value) => value === null ? null : value * 1024 * 1024);
  const network = Array.isArray(stats.b)
    ? [finiteNumber(stats.b[0]), finiteNumber(stats.b[1])]
    : [finiteNumber(stats.ns), finiteNumber(stats.nr)].map((value) => value === null ? null : value * 1024 * 1024);
  return Object.freeze({
    at: record?.created || null,
    cpuPercent: finiteNumber(stats.cpu),
    memoryPercent: finiteNumber(stats.mp),
    memoryUsedGb: finiteNumber(stats.mu),
    memoryTotalGb: finiteNumber(stats.m),
    diskPercent: finiteNumber(stats.dp),
    diskUsedGb: finiteNumber(stats.du),
    diskTotalGb: finiteNumber(stats.d),
    diskReadMb: finiteNumber(stats.dr),
    diskWriteMb: finiteNumber(stats.dw),
    networkSentMb: finiteNumber(stats.ns),
    networkReceivedMb: finiteNumber(stats.nr),
    diskReadBytesPerSecond: diskIo[0],
    diskWriteBytesPerSecond: diskIo[1],
    networkSentBytesPerSecond: network[0],
    networkReceivedBytesPerSecond: network[1],
    loadAverage: Object.freeze(Array.isArray(stats.la) ? stats.la.slice(0, 3).map(finiteNumber) : []),
  });
}

export function createBaselineMonitoringOperations({
  baseUrl,
  email,
  password,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  maximumResponseBytes = 512 * 1024,
  clock = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('Beszel timeout is invalid');
  if (!Number.isInteger(maximumResponseBytes) || maximumResponseBytes < 1024 || maximumResponseBytes > 1024 * 1024) {
    throw new TypeError('Beszel response limit is invalid');
  }
  const origin = configuredOrigin(baseUrl);
  const readerEmail = String(email || '').trim();
  const readerPassword = String(password || '');
  let authToken = '';
  let authenticatedAt = 0;
  let authenticationPromise = null;
  const cache = new Map();

  function configured() {
    return Boolean(origin && readerEmail && readerPassword);
  }

  async function request(path, options = {}, retry = true) {
    if (!configured()) throw fault('baseline monitoring reader is not configured');
    if (!authToken || clock() - authenticatedAt > 10 * 60 * 1000) await authenticate();
    let response;
    try {
      response = await fetchImpl(origin + path, {
        ...options,
        headers: { accept: 'application/json', authorization: authToken, ...(options.headers || {}) },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw fault('Beszel read timed out', 'DependencyTimeout', 504);
      }
      throw fault('Beszel reader is unavailable');
    }
    if (response.status === 401 && retry) {
      authToken = '';
      await authenticate();
      return request(path, options, false);
    }
    if (!response.ok) {
      throw fault(`Beszel adapter upstream HTTP ${response.status}`,
        response.status >= 500 ? 'AuthorityUnavailable' : 'AuthorityContractViolation',
        response.status >= 500 ? 503 : 502);
    }
    return boundedJson(response, maximumResponseBytes);
  }

  async function authenticate() {
    if (authToken && clock() - authenticatedAt <= 10 * 60 * 1000) return;
    if (!authenticationPromise) {
      authenticationPromise = login().finally(() => { authenticationPromise = null; });
    }
    await authenticationPromise;
  }

  async function login() {
    if (!configured()) throw fault('baseline monitoring reader is not configured');
    let response;
    try {
      response = await fetchImpl(origin + '/api/collections/users/auth-with-password', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ identity: readerEmail, password: readerPassword }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw fault('Beszel authentication timed out', 'DependencyTimeout', 504);
      }
      throw fault('Beszel reader authentication is unavailable');
    }
    const body = await boundedJson(response, maximumResponseBytes).catch(() => ({}));
    if (!response.ok || typeof body.token !== 'string' || body.token.length < 16 || body.token.length > 8192) {
      throw fault('baseline monitoring reader authentication failed');
    }
    authToken = body.token;
    authenticatedAt = clock();
  }

  async function records(collection, parameters = {}) {
    const perPage = Number(parameters.perPage || 500);
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 1000) {
      throw fault('Beszel record limit is invalid', 'ValidationFailed', 400);
    }
    const query = new URLSearchParams({ page: '1', perPage: String(perPage), skipTotal: '0' });
    for (const [key, value] of Object.entries(parameters)) {
      if (value === undefined || value === null || key === 'perPage') continue;
      query.set(key, String(value));
    }
    const result = await request(`/api/collections/${encodeURIComponent(collection)}/records?${query}`);
    if (!Array.isArray(result.items) || result.items.length > perPage) {
      throw fault('Beszel collection response violates the bounded contract', 'AuthorityContractViolation', 502);
    }
    return result.items;
  }

  async function cached(key, producer, maximumAgeMs = 30_000) {
    const previous = cache.get(key);
    if (previous && clock() - previous.fetchedAt <= maximumAgeMs) {
      return Object.freeze({ ...previous.value, freshness: 'fresh', observedAt: new Date(previous.fetchedAt).toISOString() });
    }
    try {
      const value = await producer();
      const entry = { value, fetchedAt: clock() };
      cache.set(key, entry);
      return Object.freeze({ ...value, freshness: 'fresh', observedAt: new Date(entry.fetchedAt).toISOString() });
    } catch (error) {
      if (previous && clock() - previous.fetchedAt <= 24 * 60 * 60 * 1000) {
        return Object.freeze({
          ...previous.value,
          freshness: 'stale',
          observedAt: new Date(previous.fetchedAt).toISOString(),
          upstreamError: String(error?.message || 'baseline monitoring unavailable').slice(0, 500),
        });
      }
      throw error;
    }
  }

  async function systems() {
    const items = await records('systems', { sort: '+name', fields: 'id,name,host,port,info,status,updated' });
    return items.map(normalizeBeszelSystem).filter((item) => item.id && item.name);
  }

  async function overview() {
    return cached('overview', async () => {
      const [nodes, alerts] = await Promise.all([
        systems(),
        records('alerts', { sort: '-updated', fields: 'id,system,name,triggered,value,min,updated' }),
      ]);
      return Object.freeze({
        provider: Object.freeze({ id: 'beszel', versionContract: '0.18.7', mode: 'read-only-adapter' }),
        systems: Object.freeze({
          total: nodes.length,
          up: nodes.filter((item) => item.status === 'up').length,
          down: nodes.filter((item) => item.status === 'down').length,
          unmatched: 0,
          identityRejected: 0,
          disagreement: 0,
        }),
        kubernetes: Object.freeze({ available: false, nodes: 0, nodesReady: 0, namespaces: 0, pods: Object.freeze({ total: 0 }) }),
        alerts: Object.freeze({ total: alerts.length, triggered: alerts.filter((alert) => alert.triggered).length }),
        retention: Object.freeze({ maximumDays: 30, authority: 'Beszel hierarchical retention' }),
      });
    });
  }

  async function nodes() {
    return cached('nodes', async () => Object.freeze({ items: Object.freeze(await systems()), kubernetesAvailable: false }));
  }

  async function series(systemId, requestedRange) {
    const normalizedId = String(systemId || '');
    if (!SYSTEM_ID.test(normalizedId)) throw fault('Beszel system id is invalid', 'ValidationFailed', 400);
    if (!Object.hasOwn(RANGE, requestedRange)) throw fault('monitoring range is invalid', 'ValidationFailed', 400);
    const contract = RANGE[requestedRange];
    const since = new Date(clock() - contract.seconds * 1000).toISOString().replace('T', ' ');
    const filter = `system="${normalizedId}" && created>"${since}" && type="${contract.type}"`;
    const items = await records('system_stats', {
      perPage: 1000,
      sort: '+created',
      fields: 'created,stats,type',
      filter,
    });
    return Object.freeze({
      systemId: normalizedId,
      range: requestedRange,
      resolution: contract.type,
      points: Object.freeze(items.map(normalizeBeszelStats)),
      observedAt: new Date(clock()).toISOString(),
    });
  }

  async function alerts() {
    return cached('alerts', async () => {
      const [active, history] = await Promise.all([
        records('alerts', { sort: '-updated', fields: 'id,system,name,triggered,value,min,updated' }),
        records('alerts_history', { perPage: 200, sort: '-created', fields: 'id,system,name,val,created,resolved' }),
      ]);
      return Object.freeze({
        active: Object.freeze(active.map((item) => Object.freeze({
          id: item.id,
          systemId: item.system,
          metric: item.name,
          triggered: Boolean(item.triggered),
          threshold: finiteNumber(item.value),
          durationMinutes: finiteNumber(item.min),
          updatedAt: item.updated || null,
        }))),
        history: Object.freeze(history.map((item) => Object.freeze({
          id: item.id,
          systemId: item.system,
          metric: item.name,
          value: finiteNumber(item.val),
          triggeredAt: item.created || null,
          resolvedAt: item.resolved || null,
        }))),
      });
    });
  }

  async function dataHealth() {
    const checkedAt = new Date(clock()).toISOString();
    if (!configured()) {
      return Object.freeze({ status: 'unconfigured', checkedAt, provider: 'beszel', adapter: 'v1', reasons: Object.freeze(['reader credential not configured']) });
    }
    try {
      let response;
      try {
        response = await fetchImpl(origin + '/api/health', {
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw fault('Beszel health read timed out', 'DependencyTimeout', 504);
        }
        throw fault('Beszel health endpoint is unavailable');
      }
      if (!response.ok) throw fault(`Beszel health endpoint returned HTTP ${response.status}`);
      const nodeResult = await nodes();
      return Object.freeze({
        status: nodeResult.freshness === 'fresh' ? 'healthy' : 'degraded',
        checkedAt,
        provider: 'beszel',
        adapter: 'v1',
        freshness: nodeResult.freshness,
        observedAt: nodeResult.observedAt,
        systemCount: nodeResult.items.length,
        staleAfterSeconds: 120,
        reasons: Object.freeze(nodeResult.upstreamError ? [nodeResult.upstreamError] : []),
      });
    } catch (error) {
      return Object.freeze({
        status: 'unavailable',
        checkedAt,
        provider: 'beszel',
        adapter: 'v1',
        reasons: Object.freeze([String(error?.message || 'health check failed').slice(0, 500)]),
      });
    }
  }

  return Object.freeze({ overview, nodes, series, alerts, dataHealth });
}

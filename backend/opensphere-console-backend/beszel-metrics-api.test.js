'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  PLUGIN_API_NAMESPACE,
  BeszelMetricsError,
  loadBeszelReaderConfig,
  parseMetricsRoute,
  projectPoint,
  createBeszelClient,
  createBeszelMetricsApi,
} = require('./beszel-metrics-api');

const NOW_MS = Date.parse('2026-07-27T00:00:00.000Z');
const CONFIG = Object.freeze({
  email: 'rcc-metrics@cc2.opl.io.kr',
  password: 'a-readonly-password-longer-than-16',
  systems: Object.freeze({ 'cc2/node-a': 'NODE-A' }),
});
const ALLOWED = new Set(['cc2']);

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function token(exp = Math.floor(NOW_MS / 1000) + 3600) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ exp })}.${'x'.repeat(43)}`;
}

function systemResponse() {
  return {
    page: 1,
    perPage: 2,
    totalItems: 1,
    items: [{
      id: 'isfovvd3qn7u9ke',
      name: 'NODE-A',
      status: 'up',
      updated: '2026-07-26 23:59:52.000Z',
      info: { v: '0.18.7' },
    }],
  };
}

function statsResponse() {
  return {
    page: 1,
    perPage: 65,
    totalItems: 2,
    items: [
      {
        created: '2026-07-26 23:58:52.000Z',
        stats: {
          cpu: 3.35, m: 23.41, mu: 2.08, mp: 8.87,
          d: 192.69, du: 11.71, dp: 6.08,
          b: [1680, 405], dio: [0, 89294], la: [0.27, 0.17, 0.19],
          injected: '<script>',
        },
      },
      {
        created: '2026-07-26 23:59:52.000Z',
        stats: {
          cpu: 4.25, m: 23.41, mu: 2.2, mp: 9.4,
          d: 192.69, du: 11.72, dp: 6.09,
          b: [1800, 500], dio: [4096, 2048], la: [0.31, 0.2, 0.19],
        },
      },
    ],
  };
}

function workingFetch(options = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      method: init.method || 'GET',
      authorization: init.headers?.authorization || '',
    });
    if (parsed.pathname.endsWith('/auth-with-password')) {
      return jsonResponse(200, {
        token: token(),
        record: {
          role: options.role === undefined ? 'readonly' : options.role,
          verified: options.verified !== false,
        },
      });
    }
    if (parsed.pathname.endsWith('/systems/records')) return jsonResponse(200, systemResponse());
    if (parsed.pathname.endsWith('/system_stats/records')) return jsonResponse(200, statsResponse());
    return jsonResponse(404, { message: 'not found' });
  };
  return { calls, fetchImpl };
}

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.body = null;
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
    return res;
  };
  res.end = (value) => {
    res.body = value ? JSON.parse(value) : null;
    return res;
  };
  return res;
}

test('the metrics route exists only under the signed plugin API namespace', () => {
  const route = `${PLUGIN_API_NAMESPACE}/control-centers/cc2/hosts/node-a/metrics?range=12h`;
  assert.deepEqual(parseMetricsRoute(route, ALLOWED), {
    controlCenterId: 'cc2', hostId: 'node-a', range: '12h',
  });
  assert.equal(
    parseMetricsRoute('/api/control-centers/cc2/hosts/node-a/metrics', ALLOWED),
    null,
  );
  assert.throws(
    () => parseMetricsRoute(`${route}&extra=1`, ALLOWED),
    (error) => error.code === 400,
  );
  assert.throws(
    () => parseMetricsRoute(
      `${PLUGIN_API_NAMESPACE}/control-centers/cc2/hosts/node-a/metrics?range=forever`,
      ALLOWED,
    ),
    (error) => error.code === 400,
  );
});

test('reader configuration is closed-schema, bounded and safely permissioned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-beszel-config-'));
  const file = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(file, JSON.stringify(CONFIG), { mode: 0o600 });
    assert.deepEqual(loadBeszelReaderConfig(file), CONFIG);

    fs.chmodSync(file, 0o644);
    assert.throws(() => loadBeszelReaderConfig(file), /unavailable or unsafe/);
    fs.chmodSync(file, 0o600);

    fs.writeFileSync(file, JSON.stringify({ ...CONFIG, token: 'must-not-be-accepted' }));
    assert.throws(() => loadBeszelReaderConfig(file), /unsupported shape/);

    fs.writeFileSync(file, JSON.stringify({ ...CONFIG, systems: { 'cc2/Node_A': 'NODE-A' } }));
    assert.throws(() => loadBeszelReaderConfig(file), /binding/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one Beszel record is projected into the small RCC metrics schema', () => {
  const point = projectPoint(statsResponse().items[0], {
    sinceMs: NOW_MS - 3600_000,
    nowMs: NOW_MS,
  });
  assert.equal(point.cpuPercent, 3.35);
  assert.equal(point.memoryTotalBytes, Math.round(23.41 * 1024 ** 3));
  assert.equal(point.diskWriteBytesPerSecond, 89294);
  assert.equal(point.networkSendBytesPerSecond, 1680);
  assert.equal(point.load15, 0.19);
  assert.equal(point.injected, undefined, 'unknown upstream keys must not cross the adapter');
});

test('the client authenticates as readonly and returns bounded chronological metrics', async () => {
  const { calls, fetchImpl } = workingFetch();
  const client = createBeszelClient({
    baseUrl: 'https://beszel.example.test',
    config: CONFIG,
    fetchImpl,
    now: () => NOW_MS,
  });
  const result = await client.fetchMetrics({
    controlCenterId: 'cc2', hostId: 'node-a', range: '1h',
  });

  assert.equal(result.schemaVersion, 'rcc.host.metrics/v1');
  assert.equal(result.source.name, 'Beszel');
  assert.equal(result.source.mode, 'readonly-api');
  assert.equal(result.source.agentVersion, '0.18.7');
  assert.equal(result.system.freshness, 'fresh');
  assert.equal(result.points.length, 2);
  assert.equal(result.latest.cpuPercent, 4.25);
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/collections/users/auth-with-password',
      '/api/collections/systems/records',
      '/api/collections/system_stats/records',
    ],
  );
  assert.equal(calls[1].authorization, token());
  assert.match(calls[2].query.filter, /type="1m"/);
  assert.equal(JSON.stringify(result).includes(CONFIG.password), false);
  assert.equal(JSON.stringify(result).includes(token()), false);
  assert.equal(JSON.stringify(result).includes('isfovvd3qn7u9ke'), false);
});

test('a Beszel credential with write authority is refused', async () => {
  for (const role of ['user', 'admin', '']) {
    const { fetchImpl } = workingFetch({ role });
    const client = createBeszelClient({
      baseUrl: 'https://beszel.example.test',
      config: CONFIG,
      fetchImpl,
      now: () => NOW_MS,
    });
    await assert.rejects(
      client.fetchMetrics({ controlCenterId: 'cc2', hostId: 'node-a', range: '1h' }),
      (error) => error instanceof BeszelMetricsError
        && error.code === 503
        && /readonly/.test(error.message),
    );
  }
});

test('the client retries one expired token without exposing it', async () => {
  const freshToken = token();
  let authCount = 0;
  let systemCount = 0;
  const client = createBeszelClient({
    baseUrl: 'https://beszel.example.test',
    config: CONFIG,
    now: () => NOW_MS,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/auth-with-password')) {
        authCount += 1;
        return jsonResponse(200, {
          token: freshToken,
          record: { role: 'readonly', verified: true },
        });
      }
      if (pathname.endsWith('/systems/records')) {
        systemCount += 1;
        if (systemCount === 1) return jsonResponse(401, { message: 'expired' });
        return jsonResponse(200, systemResponse());
      }
      return jsonResponse(200, statsResponse());
    },
  });
  const result = await client.fetchMetrics({
    controlCenterId: 'cc2', hostId: 'node-a', range: '1h',
  });
  assert.equal(result.points.length, 2);
  assert.equal(authCount, 2);
  assert.equal(systemCount, 2);
});

test('the API verifies RCC assignment and active host before reading Beszel', async () => {
  const audit = [];
  const calls = [];
  const api = createBeszelMetricsApi({
    allowedControlCenters: ALLOWED,
    verifyReader: async (_req, controlCenterId) => {
      calls.push(['verify', controlCenterId]);
      return { sub: 'operator-a' };
    },
    restRequest: async (resource, options) => {
      calls.push([resource, options.query]);
      return [{ id: 'host-uuid', host_id: 'node-a', control_center_id: 'cc2', status: 'active' }];
    },
    client: {
      fetchMetrics: async (route) => {
        calls.push(['beszel', route]);
        return {
          schemaVersion: 'rcc.host.metrics/v1',
          system: { freshness: 'fresh' },
          points: [{ timestamp: '2026-07-26T23:59:52.000Z' }],
        };
      },
    },
    audit: async (_actor, event) => audit.push(event),
  });
  const res = fakeRes();
  const handled = await api.handle({
    method: 'GET',
    url: `${PLUGIN_API_NAMESPACE}/control-centers/cc2/hosts/node-a/metrics?range=1h`,
    headers: {},
  }, res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map((call) => call[0]), ['verify', 'host', 'beszel']);
  assert.match(calls[1][1], /status=eq\.active/);
  assert.equal(audit[0].action, 'rcc.host.metrics.read');
  assert.equal(audit[0].pointCount, 1);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('the API is read-only and fails closed when no source is configured', async () => {
  const common = {
    allowedControlCenters: ALLOWED,
    verifyReader: async () => ({ sub: 'operator-a' }),
    restRequest: async () => [{
      id: 'host-uuid', host_id: 'node-a', control_center_id: 'cc2', status: 'active',
    }],
    client: null,
  };
  const api = createBeszelMetricsApi(common);
  const route = `${PLUGIN_API_NAMESPACE}/control-centers/cc2/hosts/node-a/metrics`;

  const write = fakeRes();
  await api.handle({ method: 'POST', url: route }, write);
  assert.equal(write.statusCode, 405);

  const missing = fakeRes();
  await api.handle({ method: 'GET', url: route }, missing);
  assert.equal(missing.statusCode, 503);
  assert.match(missing.body.error, /not configured/);
});

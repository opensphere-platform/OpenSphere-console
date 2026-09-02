import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createBaselineMonitoringOperations } from '../src/baseline-monitoring-operations.mjs';
import { createConsoleApiHandler } from '../src/http-handler.mjs';

const NOW = Date.parse('2026-09-02T12:00:00.000Z');

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('unconfigured target Beszel reader reports a closed state without network access', async () => {
  let calls = 0;
  const operations = createBaselineMonitoringOperations({
    baseUrl: '',
    email: '',
    password: '',
    fetchImpl: async () => { calls += 1; throw new Error('must not run'); },
    clock: () => NOW,
  });
  assert.deepEqual(await operations.dataHealth(), {
    status: 'unconfigured',
    checkedAt: '2026-09-02T12:00:00.000Z',
    provider: 'beszel',
    adapter: 'v1',
    reasons: ['reader credential not configured'],
  });
  await assert.rejects(operations.overview(), { code: 'AuthorityUnavailable', status: 503 });
  assert.equal(calls, 0);
});

test('target Beszel reader uses one fixed origin, read-only collections, bounded fields, and cached auth', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/api/collections/users/auth-with-password')) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { identity: 'reader@example.test', password: 'reader-secret' });
      return json({ token: 'target-beszel-reader-token' });
    }
    assert.equal(options.method, undefined);
    assert.equal(options.headers.authorization, 'target-beszel-reader-token');
    if (String(url).includes('/api/collections/systems/records?')) {
      return json({ items: [{ id: 'system_1', name: 'node-a', status: 'up', updated: '2026-09-02T11:59:00Z', info: { cpu: 12, mp: 34, dp: 56 } }] });
    }
    if (String(url).includes('/api/collections/alerts/records?')) {
      return json({ items: [{ id: 'alert-1', system: 'system_1', name: 'cpu', triggered: true }] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const operations = createBaselineMonitoringOperations({
    baseUrl: 'http://opensphere-beszel-hub.opensphere-monitoring.svc.cluster.local:8090',
    email: 'reader@example.test',
    password: 'reader-secret',
    fetchImpl,
    clock: () => NOW,
  });
  const first = await operations.overview();
  const second = await operations.overview();
  assert.equal(first.systems.total, 1);
  assert.equal(first.systems.up, 1);
  assert.equal(first.alerts.triggered, 1);
  assert.equal(first.kubernetes.available, false);
  assert.equal(second.observedAt, first.observedAt);
  assert.equal(calls.filter(({ url }) => url.endsWith('/auth-with-password')).length, 1);
  assert.equal(calls.length, 3);
  assert(calls.every(({ url }) => url.startsWith('http://opensphere-beszel-hub.opensphere-monitoring.svc.cluster.local:8090/')));
  assert(calls.slice(1).every(({ options }) => options.redirect === 'error'));
});

test('series accepts only a closed range and safe Beszel system identity', async () => {
  const operations = createBaselineMonitoringOperations({
    baseUrl: 'https://beszel.example.test',
    email: 'reader@example.test',
    password: 'reader-secret',
    fetchImpl: async () => json({ token: 'target-beszel-reader-token' }),
    clock: () => NOW,
  });
  await assert.rejects(operations.series('system_1', 'all'), { code: 'ValidationFailed', status: 400 });
  await assert.rejects(operations.series('system\" || created>\"1970', '24h'), { code: 'ValidationFailed', status: 400 });
});

test('monitoring HTTP family revalidates the target session permission before every Beszel read', async (t) => {
  const calls = [];
  const baselineMonitoringOperations = {
    async overview() { calls.push(['overview']); return { provider: { id: 'beszel' } }; },
    async nodes() { calls.push(['nodes']); return { items: [] }; },
    async series(systemId, range) { calls.push(['series', systemId, range]); return { systemId, range, points: [] }; },
    async alerts() { calls.push(['alerts']); return { active: [], history: [] }; },
    async dataHealth() { calls.push(['dataHealth']); return { status: 'healthy' }; },
  };
  let permissions = [];
  const server = createServer(createConsoleApiHandler({
    resolveSession: async () => ({ permissions }),
    baselineMonitoringOperations,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/monitoring/baseline/v1`;
  const denied = await fetch(base + '/overview');
  assert.equal(denied.status, 403);
  assert.deepEqual(calls, []);

  permissions = ['console.data_identity.read'];
  for (const [path, expected] of [
    ['/overview', { provider: { id: 'beszel' } }],
    ['/nodes', { items: [] }],
    ['/nodes/system_1/series?range=7d', { systemId: 'system_1', range: '7d', points: [] }],
    ['/alerts', { active: [], history: [] }],
    ['/data-health', { status: 'healthy' }],
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.deepEqual(await response.json(), expected, path);
  }
  assert.deepEqual(calls, [
    ['overview'], ['nodes'], ['series', 'system_1', '7d'], ['alerts'], ['dataHealth'],
  ]);

  const expanded = await fetch(base + '/nodes/system_1/series?range=7d&extra=true');
  assert.equal(expanded.status, 400);
  assert.equal(calls.length, 5);
});

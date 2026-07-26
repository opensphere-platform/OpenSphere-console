const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ExtensionProjectionCoordinator,
  MAX_PROJECTION_BYTES,
} = require('./extension-projection');

function snapshot(observedAt = '2026-07-26T00:00:00.000Z') {
  return {
    version: 1,
    observedAt,
    registry: {
      version: 3,
      trustedKeys: { edge: 'public-key' },
      capabilities: [],
      plugins: [{ id: 'cluster-manager', available: true }],
      templates: [],
    },
    catalog: { items: [{ name: 'cluster-manager', kind: 'subShell' }] },
    registrations: { items: [{ name: 'cluster-manager', status: { phase: 'Activated' }, health: 'Ready' }] },
  };
}

function fakeCluster() {
  const state = { configMap: null, available: true };
  const response = (status, json = null) => ({ ok: status >= 200 && status < 300, status, json });
  const k8s = async (method, path, body) => {
    if (!state.available) throw new Error('simulated Kubernetes API outage');
    if (path.endsWith('/configmaps/opensphere-extension-projection-v1')) {
      if (method === 'GET') return state.configMap ? response(200, state.configMap) : response(404);
      if (method === 'PATCH') {
        if (!state.configMap) return response(404);
        state.configMap.data = { ...state.configMap.data, ...(body.data || {}) };
        return response(200, state.configMap);
      }
    }
    if (path.endsWith('/configmaps') && method === 'POST') {
      if (state.configMap) return response(409);
      state.configMap = { metadata: body.metadata, data: { ...body.data } };
      return response(201, state.configMap);
    }
    throw new Error(`unexpected Kubernetes call ${method} ${path}`);
  };
  return { state, k8s };
}

test('every replica hydrates the same shared registry and admin projection', async () => {
  const cluster = fakeCluster();
  const a = new ExtensionProjectionCoordinator({ k8s: cluster.k8s, namespace: 'opensphere-console' });
  const b = new ExtensionProjectionCoordinator({ k8s: cluster.k8s, namespace: 'opensphere-console' });
  await a.persist(snapshot());
  assert.deepEqual(await b.hydrate(), a.current());
  assert.equal(b.requireCurrent().registry.plugins[0].id, 'cluster-manager');
});

test('a Kubernetes outage retains the last-known-good projection instead of returning an empty catalog', async () => {
  const cluster = fakeCluster();
  const coordinator = new ExtensionProjectionCoordinator({
    k8s: cluster.k8s,
    namespace: 'opensphere-console',
    now: () => new Date('2026-07-26T00:15:00.000Z'),
  });
  await coordinator.persist(snapshot());
  cluster.state.available = false;
  assert.deepEqual(await coordinator.hydrate(), snapshot());
  assert.equal(coordinator.requireCurrent().catalog.items.length, 1);
  assert.deepEqual(coordinator.servingStatus(), {
    ready: true,
    state: 'stale',
    observedAt: '2026-07-26T00:00:00.000Z',
    ageSeconds: 900,
    reason: 'ProjectionOlderThanFreshnessTarget',
  });
});

test('no valid projection is explicit unavailable, never an empty success', () => {
  const coordinator = new ExtensionProjectionCoordinator({ k8s: async () => ({}), namespace: 'opensphere-console' });
  assert.deepEqual(coordinator.servingStatus(), { ready: false, state: 'unavailable', reason: 'NoValidProjection' });
  assert.throws(() => coordinator.requireCurrent(), (error) => error.code === 503 && error.reason === 'ExtensionProjectionUnavailable');
});

test('invalid or oversized shared state cannot replace the serving snapshot', async () => {
  const cluster = fakeCluster();
  const coordinator = new ExtensionProjectionCoordinator({ k8s: cluster.k8s, namespace: 'opensphere-console' });
  await coordinator.persist(snapshot());
  cluster.state.configMap.data['projection.json'] = '{broken';
  await coordinator.hydrate();
  assert.equal(coordinator.requireCurrent().catalog.items[0].name, 'cluster-manager');
  const tooLarge = snapshot();
  tooLarge.catalog.items = [{ name: 'x', payload: 'x'.repeat(MAX_PROJECTION_BYTES) }];
  await assert.rejects(coordinator.persist(tooLarge), (error) => error.reason === 'ExtensionProjectionTooLarge');
  assert.equal(coordinator.requireCurrent().catalog.items[0].name, 'cluster-manager');
});

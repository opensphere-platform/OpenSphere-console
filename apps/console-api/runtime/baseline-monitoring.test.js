'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBaselineMonitoring, normalizeSystem, normalizeStats } = require('./baseline-monitoring');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function fixture() {
  let unavailable = false;
  const fetchImpl = async (url) => {
    if (unavailable) throw new Error('upstream down');
    if (url.endsWith('/api/collections/users/auth-with-password')) return response({ token: 'reader-token' });
    if (url.endsWith('/api/health')) return response({ code: 200, message: 'API is healthy.' });
    if (url.includes('/systems/records')) {
      return response({
        items: [{
          id: 'system000000001',
          name: 'node-a',
          status: 'up',
          updated: '2026-07-27T00:00:00Z',
          info: { h: 'node-a', cpu: 24, mp: 51, dp: 70, la: [0.2, 0.1, 0.05], v: '0.18.7', o: 'Linux' },
        }],
      });
    }
    if (url.includes('/fingerprints/records')) {
      return response({
        items: [{
          system: 'system000000001',
          fingerprint: 'machine-fingerprint-node-a',
          updated: '2026-07-27T00:00:00Z',
        }],
      });
    }
    if (url.includes('/alerts_history/records')) return response({ items: [] });
    if (url.includes('/alerts/records')) return response({ items: [{ id: 'alert-1', system: 'system000000001', name: 'CPU', triggered: true }] });
    if (url.includes('/system_stats/records')) {
      return response({ items: [{ created: '2026-07-27T00:00:00Z', stats: { cpu: 24, mp: 51, dp: 70, mu: 4, m: 8 } }] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const kubernetesGet = async (path) => {
    if (path === '/api/v1/nodes') {
      return {
        items: [{
          metadata: { uid: 'node-uid-a', name: 'node-a', labels: { 'node-role.kubernetes.io/control-plane': '' } },
          status: {
            conditions: [{ type: 'Ready', status: 'True' }],
            nodeInfo: { kubeletVersion: 'v1.36.1', osImage: 'Linux', architecture: 'amd64' },
            addresses: [{ type: 'InternalIP', address: '10.0.0.1' }],
          },
        }],
      };
    }
    if (path === '/api/v1/pods') return { items: [{ metadata: { namespace: 'default' }, spec: { nodeName: 'node-a' }, status: { phase: 'Running' } }] };
    if (path === '/api/v1/namespaces') return { items: [{ metadata: { name: 'default' }, status: { phase: 'Active' } }] };
    throw new Error(`unexpected Kubernetes path ${path}`);
  };
  let current = Date.parse('2026-07-27T00:05:00Z');
  const adapter = createBaselineMonitoring({
    baseUrl: 'http://beszel.example',
    email: 'reader@example.test',
    password: 'not-logged',
    fetchImpl,
    kubernetesGet,
    bindingStore: {
      ensure: async (candidate) => ({
        state: 'verified',
        mode: 'durable',
        kubernetesNodeUid: candidate.kubernetesNodeUid,
        beszelSystemId: candidate.beszelSystemId,
        fingerprintDigest: 'sha256:test-only',
      }),
    },
    clock: () => current,
  });
  return {
    adapter,
    setUnavailable: (value) => { unavailable = value; },
    advance: (ms) => { current += ms; },
  };
}

test('normalizes Beszel v0.18.7 compact system and stats fields', () => {
  const system = normalizeSystem({ id: 's', name: 'n', status: 'up', info: { cpu: 12, mp: 34, dp: 56, h: 'node', la: [1, 2, 3] } });
  assert.equal(system.cpuPercent, 12);
  assert.equal(system.memoryPercent, 34);
  assert.equal(system.diskPercent, 56);
  assert.deepEqual(system.loadAverage, [1, 2, 3]);
  const stats = normalizeStats({ created: 'now', stats: { cpu: 21, mp: 43, dp: 65, ns: 1.5, nr: 2.5 } });
  assert.equal(stats.networkSentMb, 1.5);
  assert.equal(stats.networkReceivedMb, 2.5);
  assert.equal(stats.networkSentBytesPerSecond, 1.5 * 1024 * 1024);
  assert.equal(stats.networkReceivedBytesPerSecond, 2.5 * 1024 * 1024);
  const currentStats = normalizeStats({ created: 'now', stats: { dio: [1024, 2048], b: [4096, 8192] } });
  assert.equal(currentStats.diskReadBytesPerSecond, 1024);
  assert.equal(currentStats.diskWriteBytesPerSecond, 2048);
  assert.equal(currentStats.networkSentBytesPerSecond, 4096);
  assert.equal(currentStats.networkReceivedBytesPerSecond, 8192);
});

test('combines Beszel node time-series authority with Kubernetes live state', async () => {
  const h = fixture();
  const overview = await h.adapter.overview();
  assert.equal(overview.systems.total, 1);
  assert.equal(overview.systems.up, 1);
  assert.equal(overview.systems.unmatched, 0);
  assert.equal(overview.kubernetes.nodesReady, 1);
  assert.equal(overview.kubernetes.pods.Running, 1);
  assert.equal(overview.alerts.triggered, 1);
  const nodes = await h.adapter.nodes();
  assert.equal(nodes.items[0].binding, 'matched');
  assert.equal(nodes.items[0].identity, 'verified');
  assert.equal(nodes.items[0].bindingEvidence.kubernetesNodeUid, 'node-uid-a');
  assert.equal(nodes.items[0].stateAgreement, 'agree');
  assert.equal(nodes.items[0].kubernetes.uid, 'node-uid-a');
});

test('returns explicitly stale last-known data during a bounded upstream outage', async () => {
  const h = fixture();
  const initial = await h.adapter.nodes();
  assert.equal(initial.freshness, 'fresh');
  h.advance(31_000);
  h.setUnavailable(true);
  const stale = await h.adapter.nodes();
  assert.equal(stale.freshness, 'stale');
  assert.match(stale.upstreamError, /upstream down/);
  assert.equal(stale.items.length, 1);
});

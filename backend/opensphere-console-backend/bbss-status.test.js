'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCpuMillicores,
  parseBytes,
  summarizeNamespace,
  buildBbssStatus,
} = require('./bbss-status');

const NOW = '2026-07-27T04:00:00.000Z';

function deployment(name, labels = {}) {
  return {
    metadata: { name, labels },
    spec: {
      replicas: 1,
      template: {
        metadata: { labels },
        spec: { containers: [{ name: 'app', image: `registry.invalid/${name}@sha256:${'a'.repeat(64)}` }] },
      },
    },
    status: { readyReplicas: 1, availableReplicas: 1 },
  };
}

function namespace(name, workloadName) {
  return summarizeNamespace({
    namespace: name,
    deployments: [deployment(workloadName, { 'app.kubernetes.io/version': '1.2.3' })],
    pods: [{
      metadata: { name: `${workloadName}-abc`, generateName: `${workloadName}-` },
      spec: { nodeName: 'cc2-node' },
      status: { containerStatuses: [{ restartCount: 2 }] },
    }],
    pvcs: [{
      metadata: { name: `${workloadName}-data` },
      spec: { storageClassName: 'local-path', resources: { requests: { storage: '5Gi' } } },
      status: { phase: 'Bound', capacity: { storage: '5Gi' } },
    }],
    podMetrics: [{ containers: [{ usage: { cpu: '125m', memory: '64Mi' } }] }],
    observedAt: NOW,
  });
}

function ok(value) {
  return { ok: true, value };
}

test('Kubernetes quantities are normalized without floating point unit confusion', () => {
  assert.equal(parseCpuMillicores('125m'), 125);
  assert.equal(parseCpuMillicores('250000u'), 250);
  assert.equal(parseCpuMillicores('500000000n'), 500);
  assert.equal(parseCpuMillicores('2'), 2000);
  assert.equal(parseBytes('64Mi'), 64 * 1024 ** 2);
  assert.equal(parseBytes('5Gi'), 5 * 1024 ** 3);
  assert.equal(parseBytes('100M'), 100_000_000);
  assert.equal(parseBytes('not-a-quantity'), null);
});

test('namespace evidence projects ready workloads, point usage, restarts and provisioned capacity', () => {
  const result = namespace('polyon-rcc-data', 'polyon-supabase');
  assert.equal(result.state, 'Healthy');
  assert.deepEqual(result.nodes, ['cc2-node']);
  assert.equal(result.components[0].ready, 1);
  assert.equal(result.components[0].restarts, 2);
  assert.equal(result.components[0].version, '1.2.3');
  assert.equal(result.capacity.cpuMillicores, 125);
  assert.equal(result.capacity.memoryBytes, 64 * 1024 ** 2);
  assert.equal(result.capacity.requestedBytes, 5 * 1024 ** 3);
  assert.equal(result.capacity.actualUsedBytes, null);
});

test('healthy live services remain overall degraded when resilience and application telemetry are unproven', () => {
  const status = buildBbssStatus({
    supabase: ok({
      meta: { checkedAt: NOW, version: 'test' },
      components: [
        { key: 'auth', name: 'Auth', ready: true, detail: 'HTTP 200' },
        { key: 'data', name: 'PostgREST', ready: true, detail: 'HTTP 200' },
        { key: 'storage', name: 'Storage', ready: true, detail: 'HTTP 200' },
      ],
      operators: 2,
      roles: [{}, {}],
      auditEvents: 3,
      buckets: [],
    }),
    gitea: ok({
      meta: { checkedAt: NOW },
      configured: true,
      ready: true,
      version: '1.26.3',
      repositoryCount: 1,
      repositories: [{ sizeKiB: 4 }],
      receipts: [],
      byStatus: { intent: 0, authorized: 0, committed: 0, failed: 0 },
    }),
    beszel: ok({
      configured: true,
      observedAt: NOW,
      systems: [{
        binding: 'cc2/host-1',
        name: 'HOST-1',
        status: 'up',
        freshness: 'fresh',
        latestAgeSeconds: 20,
        gapCount: 0,
        latest: { cpuPercent: 3, memoryPercent: 20, diskPercent: 10 },
      }],
    }),
    namespaces: {
      supabase: namespace('polyon-rcc-data', 'polyon-supabase'),
      gitea: namespace('polyon-rcc-change', 'polyon-gitea'),
      beszel: namespace('beszel-system', 'beszel-hub'),
    },
    telemetry: { state: 'NotConfigured', reason: 'not installed' },
    recovery: { available: false, reason: 'no evidence' },
    generatedAt: NOW,
  });

  assert.equal(status.schemaVersion, 'rcc.bbss.status/v1');
  assert.equal(status.overall.runtimeAvailability, 'Healthy');
  assert.equal(status.overall.resilience, 'Degraded');
  assert.equal(status.overall.applicationTelemetry, 'NotConfigured');
  assert.equal(status.overall.state, 'Degraded');
  assert.equal(status.summary.healthy, 3);
  assert.equal(status.services.find((item) => item.id === 'supabase').version, '1.2.3');
  assert.equal(status.dependencies.find((item) => item.id === 'failure-domain').state, 'Degraded');
  assert.equal(status.dependencies.find((item) => item.id === 'persistent-storage').state, 'Degraded');
});

test('one unavailable mandatory owner path makes BBSS unavailable without erasing healthy peers', () => {
  const status = buildBbssStatus({
    supabase: ok({
      meta: { checkedAt: NOW },
      components: [{ key: 'auth', name: 'Auth', ready: true, detail: 'HTTP 200' }],
      roles: [],
      buckets: [],
    }),
    gitea: { ok: false, error: 'Gitea owner API: timeout' },
    beszel: ok({
      configured: true,
      observedAt: NOW,
      systems: [{
        binding: 'cc2/host-1',
        name: 'HOST-1',
        status: 'up',
        freshness: 'fresh',
        latestAgeSeconds: 5,
        gapCount: 0,
      }],
    }),
    namespaces: {
      supabase: namespace('polyon-rcc-data', 'polyon-supabase'),
      gitea: namespace('polyon-rcc-change', 'polyon-gitea'),
      beszel: namespace('beszel-system', 'beszel-hub'),
    },
    telemetry: { state: 'Healthy', reason: 'ready' },
    recovery: {
      available: true,
      supabase: { state: 'Verified', checks: [] },
      storage: { state: 'Verified', checks: [] },
      gitea: { state: 'Verified', checks: [] },
    },
    generatedAt: NOW,
  });

  assert.equal(status.overall.state, 'Unavailable');
  const gitea = status.services.find((service) => service.id === 'gitea');
  assert.equal(gitea.state, 'Unavailable');
  assert.equal(gitea.activity.find((item) => item.label === 'Pending changes').value, null);
  assert.equal(gitea.activity.find((item) => item.label === 'Webhook receipts').value, null);
  assert.equal(status.services.find((service) => service.id === 'supabase').state, 'Healthy');
  assert.equal(status.services.find((service) => service.id === 'beszel').state, 'Healthy');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  THRESHOLDS,
  aggregateTrend,
  buildAdminOverview,
} = require('./admin-overview-status');

const NOW = '2026-07-27T06:20:00.000Z';

function host({
  hostId,
  collectedAt = '2026-07-27T06:19:30.000Z',
  status = 'active',
  failedUnitCount = 0,
  degraded = [],
  memoryPercent = 25,
  diskPercent = 40,
}) {
  const total = 16 * 1024 ** 3;
  const used = total * (memoryPercent / 100);
  return {
    host_id: hostId,
    display_name: hostId.toUpperCase(),
    control_center_id: 'cc2',
    status,
    labels: {},
    host_snapshot: {
      schema_version: 'rcc.host.snapshot/v1',
      agent_version: 'test',
      collected_at: collectedAt,
      received_at: collectedAt,
      payload: {
        identity: { hostname: hostId },
        resources: {
          cpuCount: 4,
          memTotalBytes: total,
          memAvailableBytes: total - used,
        },
        filesystems: [{
          mountPoint: '/',
          totalBytes: total,
          usedBytes: total * (diskPercent / 100),
        }],
        systemd: { available: true, failedUnitCount },
        degraded,
      },
    },
  };
}

function metric(binding, {
  cpu = 20,
  memory = 30,
  disk = 40,
  freshness = 'fresh',
  status = 'up',
  points,
} = {}) {
  return {
    binding,
    ok: true,
    value: {
      resolutionSeconds: 1200,
      system: { freshness, status, latestAgeSeconds: 5 },
      latest: { cpuPercent: cpu, memoryPercent: memory, diskPercent: disk },
      points: points || [
        {
          timestamp: '2026-07-27T06:00:00.000Z',
          cpuPercent: cpu,
          memoryPercent: memory,
          gapBefore: false,
        },
      ],
    },
  };
}

test('live overview projects real host authority and Beszel values without sample defaults', () => {
  const status = buildAdminOverview({
    hostRows: [host({ hostId: 'node-a' })],
    metricsConfigured: true,
    metricBindings: ['cc2/node-a'],
    metrics: [metric('cc2/node-a')],
    generatedAt: NOW,
  });

  assert.equal(status.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(status.thresholds, THRESHOLDS);
  assert.deepEqual(status.fleet, {
    observed: 1,
    healthy: 1,
    attention: 0,
    offline: 0,
    healthyPercent: 100,
    truncated: false,
    limit: 200,
  });
  assert.equal(status.nodes[0].cpuPercent, 20);
  assert.equal(status.nodes[0].memoryPercent, 30);
  assert.equal(status.nodes[0].diskPercent, 40);
  assert.equal(status.trend.state, 'Healthy');
  assert.equal(status.trend.points.length, 1);
  assert.equal(status.trend.points[0].contributingHosts, 1);
});

test('stale, offline, collector-degraded and saturated hosts become evidence-backed attention', () => {
  const status = buildAdminOverview({
    hostRows: [
      host({
        hostId: 'node-offline',
        collectedAt: '2026-07-27T05:00:00.000Z',
      }),
      host({
        hostId: 'node-degraded',
        failedUnitCount: 2,
        degraded: ['network', 'filesystemUsage'],
      }),
      host({ hostId: 'node-saturated' }),
    ],
    metricsConfigured: true,
    metricBindings: ['cc2/node-offline', 'cc2/node-degraded', 'cc2/node-saturated'],
    metrics: [
      metric('cc2/node-offline'),
      metric('cc2/node-degraded'),
      metric('cc2/node-saturated', { cpu: 91, memory: 92, disk: 90 }),
    ],
    generatedAt: NOW,
  });

  assert.equal(status.fleet.offline, 1);
  assert.equal(status.fleet.attention, 2);
  const degraded = status.nodes.find((node) => node.hostId === 'node-degraded');
  assert.match(degraded.reasons.join(' '), /실패한 systemd unit 2개/);
  assert.match(degraded.reasons.join(' '), /network, filesystemUsage/);
  const saturated = status.nodes.find((node) => node.hostId === 'node-saturated');
  assert.match(saturated.reasons.join(' '), /CPU 91\.0%/);
  assert.match(saturated.reasons.join(' '), /메모리 92\.0%/);
  assert.match(saturated.reasons.join(' '), /루트 디스크 90\.0%/);
});

test('missing Beszel binding is not rendered as zero and is reported as an observability gap', () => {
  const status = buildAdminOverview({
    hostRows: [host({ hostId: 'node-unbound', memoryPercent: 42, diskPercent: 51 })],
    metricsConfigured: true,
    metricBindings: [],
    metrics: [],
    generatedAt: NOW,
  });

  assert.equal(status.nodes[0].state, 'Degraded');
  assert.equal(status.nodes[0].cpuPercent, null);
  assert.equal(status.nodes[0].memoryPercent, 42);
  assert.equal(status.nodes[0].diskPercent, 51);
  assert.match(status.nodes[0].reasons.join(' '), /바인딩이 없습니다/);
  assert.equal(status.trend.state, 'NotConfigured');
  assert.deepEqual(status.trend.points, []);
});

test('explicit null metrics remain unknown instead of becoming zero', () => {
  const status = buildAdminOverview({
    hostRows: [host({ hostId: 'node-null', memoryPercent: 42, diskPercent: 51 })],
    metricsConfigured: true,
    metricBindings: ['cc2/node-null'],
    metrics: [metric('cc2/node-null', {
      cpu: null,
      memory: null,
      disk: null,
      points: [{
        timestamp: '2026-07-27T06:00:00.000Z',
        cpuPercent: null,
        memoryPercent: null,
        gapBefore: false,
      }],
    })],
    generatedAt: NOW,
  });

  assert.equal(status.nodes[0].cpuPercent, null);
  assert.equal(status.nodes[0].memoryPercent, 42);
  assert.equal(status.nodes[0].diskPercent, 51);
  assert.equal(status.trend.points[0].cpuPercent, null);
  assert.equal(status.trend.points[0].memoryPercent, null);
});

test('24-hour trend averages contributing hosts and preserves collection gaps', () => {
  const trend = aggregateTrend([
    metric('cc2/node-a', {
      points: [
        { timestamp: '2026-07-27T05:00:00.000Z', cpuPercent: 10, memoryPercent: 20, gapBefore: false },
        { timestamp: '2026-07-27T06:00:00.000Z', cpuPercent: 30, memoryPercent: 40, gapBefore: true },
      ],
    }),
    metric('cc2/node-b', {
      points: [
        { timestamp: '2026-07-27T05:00:10.000Z', cpuPercent: 30, memoryPercent: 40, gapBefore: false },
        { timestamp: '2026-07-27T06:00:10.000Z', cpuPercent: 50, memoryPercent: 60, gapBefore: false },
      ],
    }),
  ]);

  assert.equal(trend.resolutionSeconds, 1200);
  assert.equal(trend.points.length, 2);
  assert.equal(trend.points[0].cpuPercent, 20);
  assert.equal(trend.points[0].memoryPercent, 30);
  assert.equal(trend.points[0].contributingHosts, 2);
  assert.equal(trend.points[1].cpuPercent, 40);
  assert.equal(trend.points[1].gapBefore, true);
  assert.equal(trend.gapCount, 1);
});

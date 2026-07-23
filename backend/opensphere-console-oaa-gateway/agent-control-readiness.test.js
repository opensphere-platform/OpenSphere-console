const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAgentControlReadiness } = require('./agent-control-readiness');

const complete = {
  coreReadiness: {
    ready: true,
    capabilities: {
      semanticSearch: { ready: true, provider: 'openai', model: 'text-embedding-3-small' },
      runtimeProjection: { ready: true, fresh: 10, expected: 10 },
    },
  },
  llmConfigured: true,
  mutationLifecycle: { ready: true, clusterManagerActivated: true, hisPreflightReady: true },
  platformReadiness: { ready: true, phase: 'Ready', capabilities: [] },
  ownerApisUnavailable: [],
  observabilityCapabilities: ['metrics', 'alerting', 'dashboards', 'logs', 'traces', 'otlp'],
  hisOwnerCapabilities: ['observability-config-read', 'observability-plan', 'observability-configure'],
  cephOwnerCapabilities: ['status-read', 'plan-from-import', 'connect-from-import', 'disconnect'],
  recoveryOwnerCapabilities: ['status-read', 'plan-read', 'drill-request', 'evidence-promote'],
};

test('agent readiness is complete only when every control and knowledge gate is proven', () => {
  const result = buildAgentControlReadiness(complete);
  assert.equal(result.fullyOperational, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.missingCapabilities, { observability: [], hisOwner: [], cephOwner: [], recoveryOwner: [] });
});

test('reachable owner APIs cannot hide missing signed capabilities or degraded support', () => {
  const result = buildAgentControlReadiness({
    ...complete,
    coreReadiness: {
      ready: true,
      capabilities: {
        semanticSearch: { ready: false, reason: 'embedding_key_not_configured' },
        runtimeProjection: { ready: true },
      },
    },
    platformReadiness: { ready: false, phase: 'Degraded', capabilities: [{ type: 'BackupRestore', ready: false, reason: 'RestoreEvidenceMissing' }] },
    observabilityCapabilities: ['metrics', 'alerting', 'dashboards'],
    hisOwnerCapabilities: [],
    cephOwnerCapabilities: ['status-read'],
    recoveryOwnerCapabilities: ['status-read', 'plan-read'],
  });
  assert.equal(result.fullyOperational, false);
  assert.ok(result.blockers.includes('embedding_key_not_configured'));
  assert.ok(result.blockers.includes('platform_support_degraded'));
  assert.ok(result.blockers.includes('platform_support_backuprestore_not_ready'));
  assert.ok(result.blockers.includes('observability_capability_incomplete'));
  assert.deepEqual(result.missingCapabilities.observability, ['logs', 'traces', 'otlp']);
  assert.deepEqual(result.missingCapabilities.hisOwner, ['observability-config-read', 'observability-plan', 'observability-configure']);
  assert.deepEqual(result.missingCapabilities.cephOwner, ['plan-from-import', 'connect-from-import', 'disconnect']);
  assert.deepEqual(result.missingCapabilities.recoveryOwner, ['drill-request', 'evidence-promote']);
  assert.ok(result.blockers.includes('recovery_owner_capability_incomplete'));
});

test('owner API outages and mutation lifecycle failures remain explicit blockers', () => {
  const result = buildAgentControlReadiness({
    ...complete,
    mutationLifecycle: { ready: false, reason: 'cluster_manager_not_activated' },
    ownerApisUnavailable: ['Cluster Manager HIS preflight'],
  });
  assert.deepEqual(result.ownerApis.unavailable, ['Cluster Manager HIS preflight']);
  assert.ok(result.blockers.includes('cluster_manager_not_activated'));
  assert.ok(result.blockers.includes('owner_api_unavailable'));
});

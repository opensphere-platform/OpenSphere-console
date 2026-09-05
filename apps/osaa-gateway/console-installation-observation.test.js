'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { consoleInstallationObservation, requiresConsoleInstallationSummary, renderConsoleInstallationObservation } = require('./console-installation-observation');
const { sanitizeKubernetesObject } = require('./kubernetes-resource-catalog');

const node = (ready) => sanitizeKubernetesObject('node', { metadata: { name: 'private-node', labels: { private: 'DO_NOT_SEND' } }, status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False', message: 'DO_NOT_SEND' }] } });
const deployment = (observedGeneration = 2) => sanitizeKubernetesObject('deployment', {
  metadata: { name: 'opensphere-console', namespace: 'opensphere-console', generation: 2 },
  spec: { replicas: 2, template: { spec: { containers: [{ name: 'shell', image: 'DO_NOT_SEND', env: [{name: 'TOKEN', value: 'DO_NOT_SEND'}] }] } } },
  status: { readyReplicas: 2, availableReplicas: 2, updatedReplicas: 2, observedGeneration },
});
const snapshot = (items = [], state = 'live') => ({ projection: { state, ready: state === 'live' }, items });
const read = (overrides = {}) => consoleInstallationObservation({
  listResources: async ({kind, namespace}) => kind === 'node'
    ? {kind: 'Node', namespace: null, resources: [node(true), node(false)]}
    : (assert.equal(namespace, 'opensphere-console'), {kind: 'Deployment', namespace, resources: [deployment()]}),
  registrations: async () => snapshot(), now: () => new Date('2026-09-05T04:00:00Z'), ...overrides,
});

test('bootstrap view uses actual sanitized resource shapes and sends only approved summary fields', async () => {
  const result = await read();
  assert.equal(result.nodes.ready, 1); assert.equal(result.nodes.total, 2);
  assert.equal(result.console.ready, 1); assert.equal(result.clusterManager.state, 'NotRegistered');
  assert.equal(result.clusterManager.operationState, 'NotQueried');
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_SEND|private-node|TOKEN|containers|labels/);
  assert.match(renderConsoleInstallationObservation(result), /1\/2 Ready/);
  assert.match(renderConsoleInstallationObservation(result), /전체 기능·설치 재현 완료/);
});
test('incomplete lists, stale registration and API errors cannot assert absence or readiness', async () => {
  const result = await read({
    listResources: async ({kind, namespace}) => kind === 'node'
      ? {kind: 'Node', namespace: null, resources: [node(true)], continue: 'next'}
      : {kind: 'Deployment', namespace, resources: [deployment(1)]},
    registrations: async () => snapshot([], 'stale'),
  });
  assert.equal(result.nodes.state, 'Unknown'); assert.equal(result.nodes.total, undefined);
  assert.equal(result.console.ready, 0); assert.equal(result.clusterManager.state, 'Unknown');
  const failed = await read({listResources: async () => {throw new Error('DO_NOT_SEND');}, registrations: async () => {throw new Error('DO_NOT_SEND');}});
  assert.equal(failed.console.state, 'Unknown'); assert.doesNotMatch(JSON.stringify(failed), /DO_NOT_SEND/);
});
test('registration presence alone never means installed; verified current serving is required', async () => {
  const registration = {name: 'cluster-manager', desiredState: 'Enabled', health: 'Ready', requestedBy: 'DO_NOT_SEND', status: {
    phase: 'Activated', currentDigest: `sha256:${'a'.repeat(64)}`, serving: {phase: 'Current'}, verification: {manifest: 'Verified', signature: 'Verified', entryDigest: 'Verified'},
  }};
  const healthy = await read({registrations: async () => snapshot([registration])});
  assert.equal(healthy.clusterManager.state, 'Ready'); assert.doesNotMatch(JSON.stringify(healthy), /DO_NOT_SEND/);
  registration.status.verification.signature = 'Failed';
  assert.equal((await read({registrations: async () => snapshot([registration])})).clusterManager.state, 'RegisteredNotReady');
});
test('installation status selects only the bounded read tool and excludes automatic broad context', () => {
  assert.equal(requiresConsoleInstallationSummary('Console 배포 상태와 Cluster Manager 설치 상태를 점검해줘'), true);
  assert.equal(requiresConsoleInstallationSummary('Console 소스 코드를 설명해줘'), false);
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(server, /agentToolDefinitions\(actor\)\.filter\(\(tool\) => tool.function.name === 'get_console_installation_status'\)/);
  assert.match(server, /!canonicalSourceIntent && !surfaceDiagnosisIntent && !installationSummaryIntent/);
  assert.match(server, /includeEnvironment !== false[^\n]+!installationSummaryIntent/);
  assert.match(server, /case 'get_console_installation_status':[\s\S]*?requireClosedOwnerInputs\(input, \[\]\)/);
  assert.match(fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8'), /COPY console-installation-observation.js/);
});

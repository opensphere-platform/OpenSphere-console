'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { consoleInstallationObservation, requiresConsoleInstallationSummary, renderConsoleInstallationObservation, installationMutationReadiness } = require('./console-installation-observation');
const { sanitizeKubernetesObject } = require('./kubernetes-resource-catalog');

const node = (ready) => sanitizeKubernetesObject('node', { metadata: { name: 'private-node', labels: { private: 'DO_NOT_SEND' } }, status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False', message: 'DO_NOT_SEND' }] } });
const deployment = (observedGeneration = 2) => sanitizeKubernetesObject('deployment', {
  metadata: { name: 'opensphere-console', namespace: 'opensphere-console', generation: 2 },
  spec: { replicas: 2, template: { spec: { containers: [{ name: 'shell', image: 'DO_NOT_SEND', env: [{name: 'TOKEN', value: 'DO_NOT_SEND'}] }] } } },
  status: { readyReplicas: 2, availableReplicas: 2, updatedReplicas: 2, observedGeneration },
});
const snapshot = (resources = []) => ({kind: 'UIPluginRegistration', namespace: 'opensphere-console', resources});
const read = (overrides = {}) => consoleInstallationObservation({
  listResources: async ({kind, namespace}) => kind === 'node'
    ? {kind: 'Node', namespace: null, resources: [node(true), node(false)]}
    : (assert.equal(namespace, 'opensphere-console'), kind === 'deployment'
      ? {kind: 'Deployment', namespace, resources: [deployment()]} : snapshot()),
  now: () => new Date('2026-09-05T04:00:00Z'), ...overrides,
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

test('module owner admission observes current C_EXT evidence without depending on already installed HISS', async () => {
  const absent = await read();
  assert.equal(installationMutationReadiness(absent, true).reason, 'cluster_manager_not_installed');
  const observation = { ...absent, clusterManager: { state: 'Ready' } };
  const admission = installationMutationReadiness(observation, true);
  assert.equal(admission.ready, true);
  assert.equal(admission.ownerChecksRequired, true);
  assert.notEqual(admission.hisPreflightReady, true, 'Module installation is not HISS or Ceph acceptance');
  assert.equal(installationMutationReadiness(observation, false).ready, false);
  assert.equal(installationMutationReadiness({ ...observation, clusterManager: { state: 'RegisteredNotReady' } }, true).reason, 'cluster_manager_not_ready');
  assert.equal(installationMutationReadiness({}, true).reason, 'installation_authority_unavailable');
});

test('Gateway lifecycle uses current registration observation and no retired DUPA readiness call', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const begin = source.indexOf('async function osaaMutationLifecycle(');
  const end = source.indexOf('\nasync function requireOsaaMutationLifecycle', begin);
  assert.ok(begin > 0 && end > begin);
  const lifecycle = source.slice(begin, end);
  assert.match(lifecycle, /consoleInstallationObservation/);
  assert.match(lifecycle, /installationMutationReadiness/);
  assert.doesNotMatch(lifecycle, /DUPA|\/platform-readiness\/lifecycle|lifecycleGateCache/);
});
test('incomplete lists, wrong owner shapes and API errors cannot assert absence or readiness', async () => {
  const result = await read({
    listResources: async ({kind, namespace}) => kind === 'node'
      ? {kind: 'Node', namespace: null, resources: [node(true)], continue: 'next'}
      : kind === 'deployment' ? {kind: 'Deployment', namespace, resources: [deployment(1)]} : {items: [], projection: {state: 'live', ready: true}},
  });
  assert.equal(result.nodes.state, 'Unknown'); assert.equal(result.nodes.total, undefined);
  assert.equal(result.console.ready, 0); assert.equal(result.clusterManager.state, 'Unknown');
  const failed = await read({listResources: async () => {throw new Error('DO_NOT_SEND');}});
  assert.equal(failed.console.state, 'Unknown'); assert.doesNotMatch(JSON.stringify(failed), /DO_NOT_SEND/);
});
test('registration presence alone never means installed; verified current serving is required', async () => {
  const registration = {metadata: {name: 'cluster-manager', namespace: 'opensphere-console', generation: 3}, spec: {desiredState: 'Enabled', requestedBy: 'DO_NOT_SEND'}, status: {
    phase: 'Activated', observedGeneration: 3, workload: {phase: 'Ready'}, currentDigest: `sha256:${'a'.repeat(64)}`, serving: {phase: 'Current'}, verification: {manifest: 'Verified', signature: 'Verified', entryDigest: 'Verified', permissions: 'Approved'},
  }};
  const project = () => read({listResources: async ({kind}) => kind === 'uipluginregistration' ? snapshot([sanitizeKubernetesObject(kind, registration)]) : {}});
  const healthy = await project();
  assert.equal(healthy.clusterManager.state, 'Ready'); assert.doesNotMatch(JSON.stringify(healthy), /DO_NOT_SEND/);
  registration.status.verification.signature = 'Failed';
  assert.equal((await project()).clusterManager.state, 'RegisteredNotReady');
  registration.status.verification.signature = 'Verified'; registration.status.observedGeneration = 2;
  assert.equal((await project()).clusterManager.state, 'RegisteredNotReady');
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

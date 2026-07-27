const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  moduleDependencySpecifiers,
  kubernetesApiBase,
  catalogProjectionItems,
  registrationProjectionItems,
  integrationStatuses,
  retainableLastKnownGood,
} = require('./controller');

test('browser Blob artifact contract rejects every remaining module dependency', () => {
  assert.deepEqual(moduleDependencySpecifiers('export function activate() {}'), []);
  assert.deepEqual(moduleDependencySpecifiers('import "./chunk-A.js";'), ['./chunk-A.js']);
  assert.deepEqual(moduleDependencySpecifiers('import { x } from "./chunk-B.js";'), ['./chunk-B.js']);
  assert.deepEqual(moduleDependencySpecifiers('export { y } from "https://example.invalid/y.js";'), ['https://example.invalid/y.js']);
  assert.deepEqual(moduleDependencySpecifiers('const lazy = import("./lazy.js")'), ['./lazy.js']);
});

test('Kubernetes requests use the injected Service endpoint including IPv6', () => {
  assert.equal(kubernetesApiBase({
    KUBERNETES_SERVICE_HOST: '10.96.0.1',
    KUBERNETES_SERVICE_PORT_HTTPS: '443',
  }), 'https://10.96.0.1:443');
  assert.equal(kubernetesApiBase({
    KUBERNETES_SERVICE_HOST: 'fd00::1',
    KUBERNETES_SERVICE_PORT: '6443',
  }), 'https://[fd00::1]:6443');
});

test('one reconciliation projection preserves package and registration operational facts', () => {
  const packages = catalogProjectionItems([{
    metadata: { name: 'cluster-manager', labels: { 'opensphere.io/scope': 'sub-shell' } },
    spec: { kind: 'subShell', displayName: 'Cluster Manager', version: '1.3.5' },
  }]);
  const registrations = registrationProjectionItems([{
    metadata: { name: 'cluster-manager', creationTimestamp: '2026-07-26T00:00:00.000Z' },
    spec: { desiredState: 'Enabled', approval: { requestedBy: 'operator' } },
    status: { phase: 'Activated', workload: { phase: 'Ready' } },
  }]);
  assert.equal(packages[0].scope, 'sub-shell');
  assert.equal(registrations[0].health, 'Ready');
  assert.equal(registrations[0].installation.requestedBy, 'operator');
});

test('one artifact trust failure is not multiplied into independent integration failures', () => {
  const statuses = integrationStatuses({
    spec: {
      version: '0.2.2',
      contributions: {
        page: { enabled: true },
        api: { enabled: true },
        navigation: { enabled: false, reason: 'owned inside the subShell page' },
      },
    },
  }, 'Failed', false, '2026-07-28T00:00:00.000Z', 'UntrustedKey');

  assert.equal(statuses.page.phase, 'DependencyPending');
  assert.equal(statuses.page.reason, 'UntrustedKey');
  assert.equal(statuses.api.phase, 'DependencyPending');
  assert.equal(statuses.navigation.phase, 'Disabled');
  assert.equal(statuses.navigation.reason, 'owned inside the subShell page');
});

test('a retryable recheck keeps the exact previously verified artifact serving', () => {
  const prior = {
    id: 'shell-template',
    installedDigest: `sha256:${'a'.repeat(64)}`,
    manifestSha256: 'b'.repeat(64),
  };
  const pkg = {
    spec: {
      image: { digest: prior.installedDigest },
      manifest: { sha256: prior.manifestSha256 },
    },
  };
  const enabled = { spec: { desiredState: 'Enabled' } };

  assert.equal(retainableLastKnownGood(prior, pkg, enabled, 'ManifestUnreachable'), true);
  assert.equal(retainableLastKnownGood(prior, pkg, enabled, 'UntrustedKey'), false);
  assert.equal(retainableLastKnownGood(prior, pkg, { spec: { desiredState: 'Disabled' } }, 'ManifestUnreachable'), false);
  assert.equal(retainableLastKnownGood({ ...prior, installedDigest: `sha256:${'c'.repeat(64)}` }, pkg, enabled, 'ManifestUnreachable'), false);
});

test('controller image includes the shared projection module and probes serving readiness', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  const deployment = fs.readFileSync(path.join(__dirname, 'opensphere-console-dupa-controller.yaml'), 'utf8');
  assert.match(dockerfile, /COPY extension-projection\.js \/app\/extension-projection\.js/);
  assert.match(deployment, /readinessProbe:.*path: \/serving-readyz/);
  assert.doesNotMatch(deployment, /readinessProbe:.*path: \/readyz/);
});

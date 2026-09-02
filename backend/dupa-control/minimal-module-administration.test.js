'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const { extensionInstallTransition, navigationSettingsPatch, navigationOrderPlan } = require('./controller');

const extensionPackage = (kind = 'subShell', hostRef = 'main') => ({
  metadata: { name: 'cluster-manager' },
  spec: { kind, hostRef },
});
const extensionRegistration = (desiredState) => ({ spec: { desiredState } });

test('atomic navigation projection survives inactive serving without activating guest code', () => {
  const host = read('apps', 'console-web', 'src', 'app', 'core', 'extension-host.service.ts');
  const projectionStore = read('apps', 'console-web', 'src', 'app', 'core', 'extension-projection.store.ts');
  const navigation = read('apps', 'console-web', 'src', 'app', 'core', 'console-navigation-snapshot.ts');
  const page = read('apps', 'console-web', 'src', 'app', 'pages', 'plugin-host.ts');
  const shell = read('apps', 'console-web', 'src', 'app', 'os', 'os-shell.ts');
  assert.match(host, /readonly managementInventory = signal<ManagementInventoryItem\[\]>/);
  assert.match(projectionStore, /catalogSnapshot\(\)/);
  assert.match(projectionStore, /registrationsSnapshot\(\)/);
  assert.doesNotMatch(shell, /this\.ext\.managementInventory\(\)/);
  assert.match(navigation, /\(entry\.componentKind \?\? entry\.kind\) === 'subShell'/);
  assert.match(navigation, /\(entry\.hostRef \?\? 'main'\) === 'main'/);
  assert.match(host, /readonly navigationItems = computed/);
  assert.match(shell, /for \(const p of this\.ext\.navigationItems\(\)\)/);
  assert.match(host, /await this\.ensureRequestedRoute\(window\.location\.pathname\)/);
  assert.doesNotMatch(host, /startBackgroundChildActivation|backgroundChildren/);
  assert.match(page, /MODULE MANAGEMENT/);
  assert.match(page, /Installed/);
  assert.match(page, /Activated/);
  assert.match(page, /Ready/);
  assert.doesNotMatch(navigation, /loadOne|activate\(/);
});

test('Delivery evidence reads only its owner runtime and canonical Application', () => {
  const source = read('backend', 'dupa-control', 'controller.js');
  const start = source.indexOf('async function deliveryEvidence()');
  const end = source.indexOf('async function observabilityProfileEvidence()', start);
  const delivery = source.slice(start, end);
  assert.match(delivery, /namespaces\/\$\{ARGOCD_NAMESPACE\}\/deployments/);
  assert.match(delivery, /ARGOCD_DELIVERY_APPLICATION/);
  assert.match(source, /status\.sync\?\.status === 'Synced'/);
  assert.match(source, /status\.health\?\.status === 'Healthy'/);
  assert.doesNotMatch(delivery, /listPackages|listRegs|registrations/);
  assert.match(source, /Promise\.allSettled\(probes\.map\(\(probe\) => probe\.promise\)\)/);
  assert.match(source, /settledProbeProjection\(probes, settled\)/);
  assert.match(source, /reason: 'HostPending'[\s\S]{0,260}checkedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(source, /admission: Object\.hasOwn\(status, 'admission'\) \? status\.admission : null/);
});

test('module uninstall removes every verified labelled binding and general profiles retain data', () => {
  const source = read('backend', 'dupa-control', 'controller.js');
  const manifest = read('backend', 'dupa-control', 'opensphere-console-dupa-controller.yaml');
  assert.match(source, /function permissionBindingName\(pluginId, profile\)/);
  assert.match(source, /labelSelector=\$\{selector\}/);
  assert.match(source, /PermissionBindingOwnershipMismatch/);
  assert.match(source, /subjects\.every\(\(subject\) => subject\.kind === 'ServiceAccount'/);
  assert.doesNotMatch(source, /ClusterRoleManifest|PERMISSION_PROFILE_ROLES|PermissionProfileDrift/);
  assert.match(source, /for \(const profile of APPROVED_PERMISSION_PROFILES\)/);
  const documents = manifest.split(/\r?\n---\r?\n/);
  const infrastructure = documents.find((document) => document.includes('kind: ClusterRole')
    && document.includes('name: opensphere-module-cluster-infrastructure-manager-v1'));
  assert.doesNotMatch(infrastructure, /resources: \[volumesnapshots\][^\n]+delete/);
  assert.doesNotMatch(infrastructure, /apiGroups: \[ceph\.rook\.io, csi\.ceph\.io\][^\n]+delete/);
  const ai = documents.find((document) => document.includes('kind: ClusterRole')
    && document.includes('name: opensphere-module-ai-domain-operator-v1'));
  assert.doesNotMatch(ai, /resources: \[persistentvolumeclaims\][^\n]+delete/);
});

test('Console and CLI share lifecycle API with scoped development-edge MFA policy and durable reason gates', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  const backend = read('backend', 'opensphere-console-backend', 'server.js');
  const client = read('apps', 'console-web', 'src', 'app', 'core', 'plugin-control-client.service.ts');
  const page = read('apps', 'console-web', 'src', 'app', 'pages', 'admin-plugins.ts');
  assert.doesNotMatch(controller, /CliInstallationRequired/);
  assert.match(controller, /reason\.length < 8/);
  assert.match(backend, /module lifecycle mutation/);
  assert.match(backend, /moduleLifecycleNeedsRecentAal2/);
  assert.match(backend, /requireRecentAal2\(actor/);
  assert.match(client, /\/api\/admin\/extensions\/install/);
  assert.match(page, /Extension 설치/);
  assert.match(page, /\[reasonRequired\]="true"/);
});

test('artifact updates preserve operator intent and reject implicit topology replacement', () => {
  const current = extensionPackage();
  for (const desiredState of ['Enabled', 'Disabled', 'Installed']) {
    assert.deepEqual(
      extensionInstallTransition(current, extensionRegistration(desiredState), extensionPackage()),
      { allowed: true, operation: 'Update', desiredState, createRegistration: false },
    );
  }
  assert.deepEqual(
    extensionInstallTransition(current, null, extensionPackage()),
    { allowed: true, operation: 'Install', desiredState: 'Installed', createRegistration: true },
  );
  assert.equal(
    extensionInstallTransition(current, extensionRegistration('Enabled'), extensionPackage('plugin', 'foundation')).reason,
    'ExtensionTopologyChangeRequiresReinstall',
  );
  assert.deepEqual(
    extensionInstallTransition(current, extensionRegistration('Uninstalled'), extensionPackage()),
    { allowed: false, reason: 'ExtensionLifecycleTransitionInProgress' },
  );

  const controller = read('backend', 'dupa-control', 'controller.js');
  const endpoint = controller.slice(
    controller.indexOf("if (p === '/api/admin/extensions/install'"),
    controller.indexOf("if (p === '/api/admin/plugins/catalog')"),
  );
  assert.match(endpoint, /if \(transition\.createRegistration\)/);
  assert.match(endpoint, /operation: transition\.operation/);
  assert.match(endpoint, /desiredState: transition\.desiredState/);
});

test('Main Shell and extension APIs share the same MFA-aware command transport', () => {
  const http = read('apps', 'console-web', 'src', 'app', 'core', 'http.service.ts');
  const auth = read('apps', 'console-web', 'src', 'app', 'core', 'auth.service.ts');
  const host = read('apps', 'console-web', 'src', 'app', 'core', 'extension-host.service.ts');
  assert.match(http, /requestWithStepUp/);
  assert.match(http, /const headers = new Headers/);
  assert.match(http, /X-OS-Idempotency-Key/);
  assert.match(auth, /requestStepUp\(\): Promise<void>/);
  assert.match(host, /return this\.http\.request\(target/);
});

test('Backend serving readiness and verified-session outage cache are dependency-isolated', () => {
  const backend = read('backend', 'opensphere-console-backend', 'server.js');
  const deploy = read('backend', 'opensphere-console-backend', 'deploy.yaml');
  const session = read('backend', 'opensphere-console-backend', 'browser-session.js');
  const auth = read('apps', 'console-web', 'src', 'app', 'core', 'auth.service.ts');
  assert.match(backend, /p === '\/serving-readyz'/);
  assert.match(deploy, /readinessProbe: \{ httpGet: \{ path: \/serving-readyz, port: 8080 \}/);
  assert.match(session, /authorityDegraded: true/);
  assert.match(session, /if \(!readOnly \|\| !cached/);
  assert.match(auth, /Bootstrap status is not a session authority/);
});

test('DUPA runtime image contains every local controller module', () => {
  const dockerfile = read('backend', 'dupa-control', 'Dockerfile');
  assert.match(dockerfile, /COPY foundation-establishment\.js \/app\/foundation-establishment\.js/);
});

test('first-level navigation settings accept closed icon and optional label overrides', () => {
  assert.deepEqual(navigationSettingsPatch({ icon: 'logo--gitlab', labelOverride: '  Source Control  ' }), {
    ok: true,
    nav: { icon: 'logo--gitlab', labelOverride: 'Source Control' },
  });
  assert.deepEqual(navigationSettingsPatch({ labelOverride: '   ' }), {
    ok: true,
    nav: { labelOverride: null },
  });
  assert.equal(navigationSettingsPatch({ icon: '<svg onload=alert(1)>' }).reason, 'InvalidNavigationIcon');
  assert.equal(navigationSettingsPatch({ labelOverride: 'bad\nlabel' }).reason, 'InvalidNavigationLabel');
  assert.equal(navigationSettingsPatch({ icon: 'application', authority: 'guest' }).reason, 'InvalidNavigationSettings');
});

test('navigation order is a closed permutation of installed Main Shell subShells', () => {
  const packages = [
    { metadata: { name: 'alpha' }, spec: { kind: 'subShell', hostRef: 'main' } },
    { metadata: { name: 'beta' }, spec: { kind: 'subShell', hostRef: 'main' } },
    { metadata: { name: 'nested' }, spec: { kind: 'plugin', hostRef: 'alpha' } },
  ];
  const registrations = [
    { metadata: { name: 'alpha' } },
    { metadata: { name: 'beta' } },
    { metadata: { name: 'nested' } },
  ];
  assert.deepEqual(navigationOrderPlan(packages, registrations, ['beta', 'alpha']), {
    ok: true,
    items: [{ id: 'beta', order: 0 }, { id: 'alpha', order: 1 }],
  });
  assert.equal(navigationOrderPlan(packages, registrations, ['alpha']).reason, 'NavigationOrderInventoryMismatch');
  assert.equal(navigationOrderPlan(packages, registrations, ['alpha', 'alpha']).reason, 'InvalidNavigationOrder');
  assert.equal(navigationOrderPlan(packages, registrations, ['alpha', 'nested']).reason, 'NavigationOrderInventoryMismatch');
});

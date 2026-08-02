'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('management inventory survives inactive serving without loading inactive assets', () => {
  const host = read('src', 'app', 'core', 'extension-host.service.ts');
  const page = read('src', 'app', 'pages', 'plugin-host.ts');
  const shell = read('src', 'app', 'os', 'os-shell.ts');
  assert.match(host, /readonly managementInventory = signal<ManagementInventoryItem\[\]>/);
  assert.match(host, /\/api\/admin\/plugins\/catalog/);
  assert.match(host, /\/api\/admin\/plugins\/registrations/);
  assert.match(shell, /this\.ext\.managementInventory\(\)/);
  assert.match(page, /MODULE MANAGEMENT/);
  assert.match(page, /Installed/);
  assert.match(page, /Activated/);
  assert.match(page, /Ready/);
  assert.doesNotMatch(host, /managementInventory[\s\S]{0,300}loadOne\(/);
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
  assert.match(source, /Promise\.allSettled\(\[/);
  assert.match(source, /reason: 'HostPending'[\s\S]{0,260}checkedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(source, /admission: Object\.hasOwn\(status, 'admission'\) \? status\.admission : null/);
});

test('module uninstall removes every verified labelled binding and general profiles retain data', () => {
  const source = read('backend', 'dupa-control', 'controller.js');
  assert.match(source, /function permissionBindingName\(pluginId, profile\)/);
  assert.match(source, /labelSelector=\$\{selector\}/);
  assert.match(source, /PermissionBindingOwnershipMismatch/);
  assert.match(source, /subjects\.every\(\(subject\) => subject\.kind === 'ServiceAccount'/);
  const infrastructure = source.slice(
    source.indexOf('function infrastructureManagerClusterRoleManifest()'),
    source.indexOf('function aiDomainOperatorClusterRoleManifest()'),
  );
  assert.doesNotMatch(infrastructure, /resources: \['volumesnapshots'\][^\n]+delete/);
  assert.doesNotMatch(infrastructure, /apiGroups: \['ceph\.rook\.io', 'csi\.ceph\.io'\][^\n]+delete/);
  const ai = source.slice(
    source.indexOf('function aiDomainOperatorClusterRoleManifest()'),
    source.indexOf('const PERMISSION_PROFILE_ROLES'),
  );
  assert.doesNotMatch(ai, /resources: \['persistentvolumeclaims'\][^\n]+delete/);
});

test('Console and CLI share lifecycle API with recent AAL2 and durable reason gates', () => {
  const controller = read('backend', 'dupa-control', 'controller.js');
  const backend = read('backend', 'opensphere-console-backend', 'server.js');
  const client = read('src', 'app', 'core', 'plugin-control-client.service.ts');
  const page = read('src', 'app', 'pages', 'admin-plugins.ts');
  assert.doesNotMatch(controller, /CliInstallationRequired/);
  assert.match(controller, /reason\.length < 8/);
  assert.match(backend, /module lifecycle mutation/);
  assert.match(backend, /requireRecentAal2\(actor/);
  assert.match(client, /\/api\/admin\/extensions\/install/);
  assert.match(page, /Extension 설치/);
  assert.match(page, /\[reasonRequired\]="true"/);
});

test('Backend serving readiness and verified-session outage cache are dependency-isolated', () => {
  const backend = read('backend', 'opensphere-console-backend', 'server.js');
  const deploy = read('backend', 'opensphere-console-backend', 'deploy.yaml');
  const session = read('backend', 'opensphere-console-backend', 'browser-session.js');
  const auth = read('src', 'app', 'core', 'auth.service.ts');
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

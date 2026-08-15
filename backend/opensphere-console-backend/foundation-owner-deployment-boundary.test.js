'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const here = __dirname;
const deploySource = fs.readFileSync(path.join(here, 'deploy.yaml'), 'utf8');
const documents = [];
yaml.loadAll(deploySource, (document) => { if (document) documents.push(document); });
const find = (kind, name) => documents.find((item) => item.kind === kind && item.metadata?.name === name);

test('executor admission derives its exact digest from the governed reconciler Deployment', () => {
  const reconciler = find('Deployment', 'foundation-owner-release-reconciler');
  const reconcilerImage = reconciler.spec.template.spec.containers[0].image;
  assert.match(reconcilerImage,
    /^ghcr\.io\/opensphere-platform\/opensphere-console-backend@sha256:[a-f0-9]{64}$/);
  for (const suffix of ['job', 'pod']) {
    const policy = find('ValidatingAdmissionPolicy', `foundation-owner-release-executor-${suffix}-boundary`);
    const binding = find('ValidatingAdmissionPolicyBinding', `foundation-owner-release-executor-${suffix}-boundary`);
    assert.deepEqual(policy.spec.paramKind, { apiVersion: 'apps/v1', kind: 'Deployment' });
    assert.equal(binding.spec.paramRef.name, reconciler.metadata.name);
    assert.equal(binding.spec.paramRef.namespace, 'opensphere-console');
    assert.equal(binding.spec.paramRef.parameterNotFoundAction, 'Deny');
    const expression = policy.spec.validations.map((entry) => entry.expression).join('\n');
    assert.match(expression, /params\.metadata\.name == 'foundation-owner-release-reconciler'/);
    assert.match(expression, /params\.spec\.template\.spec\.containers\[0\]\.image\.matches/);
    assert.match(expression, /containers\[0\]\.image[\s\S]+?params\.spec\.template\.spec\.containers\[0\]\.image/);
    assert.doesNotMatch(expression, /GITEA_TOKEN|foundation-owner-release-gitea-readonly/);
    assert.match(expression, /opensphere-console-foundation-owner-release/);
    assert.match(expression, /initContainers/);
    assert.match(expression, /ephemeralContainers/);
    assert.match(expression, /envFrom/);
    assert.match(expression, /size\(object\.spec(?:\.template\.spec)?\.volumes\) == 3/);
    assert.match(expression, /opensphere-platform-release-control-ca/);
    assert.match(expression, /resources\.requests == \{'cpu':'50m','memory':'96Mi'\}/);
    assert.match(expression, /readOnlyRootFilesystem/);
  }

  const container = reconciler.spec.template.spec.containers[0];
  const executorImage = container.env.find((entry) => entry.name === 'EXECUTOR_IMAGE');
  assert.equal(executorImage.value, reconcilerImage);
  assert.equal(executorImage.valueFrom, undefined);
  const apiAccess = reconciler.spec.template.spec.volumes.find((volume) => volume.name === 'kube-api-access');
  assert.deepEqual(apiAccess.projected.sources, [
    { serviceAccountToken: {
      path: 'token', audience: 'https://kubernetes.default.svc', expirationSeconds: 600,
    } },
    { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
  ]);
  const identity = reconciler.spec.template.spec.volumes.find((volume) => volume.name === 'receipt-identity');
  assert.deepEqual(identity.projected.sources[0].serviceAccountToken,
    { path: 'token', audience: 'opensphere-console-foundation-owner-release', expirationSeconds: 600 });
});

test('executor API and receipt credentials are separate exact projections with no automount', () => {
  const serviceAccount = find('ServiceAccount', 'foundation-owner-release-executor');
  assert.equal(serviceAccount.automountServiceAccountToken, false);

  for (const suffix of ['job', 'pod']) {
    const policy = find('ValidatingAdmissionPolicy', `foundation-owner-release-executor-${suffix}-boundary`);
    const expression = policy.spec.validations.map((entry) => entry.expression).join('\n');
    const normalized = expression.replace(/\s+/g, ' ');
    const prefix = suffix === 'job' ? 'object.spec.template.spec' : 'object.spec';
    const container = `${prefix}.containers[0]`;
    for (const contract of [
      `${prefix}.automountServiceAccountToken == false`,
      `size(${prefix}.volumes) == 3`,
      `${prefix}.volumes[0].name == 'kube-api-access'`,
      `${prefix}.volumes[0].projected.defaultMode == 256`,
      `size(${prefix}.volumes[0].projected.sources) == 2`,
      `${prefix}.volumes[0].projected.sources[0].serviceAccountToken.path == 'token'`,
      `${prefix}.volumes[0].projected.sources[0].serviceAccountToken.audience\n            == 'https://kubernetes.default.svc'`,
      `${prefix}.volumes[0].projected.sources[0].serviceAccountToken.expirationSeconds == 600`,
      `${prefix}.volumes[0].projected.sources[1].configMap.name == 'kube-root-ca.crt'`,
      `size(${prefix}.volumes[0].projected.sources[1].configMap.items) == 1`,
      `${prefix}.volumes[0].projected.sources[1].configMap.items[0].key == 'ca.crt'`,
      `${prefix}.volumes[0].projected.sources[1].configMap.items[0].path == 'ca.crt'`,
      `${prefix}.volumes[1].name == 'receipt-identity'`,
      `${prefix}.volumes[1].projected.defaultMode == 256`,
      `size(${prefix}.volumes[1].projected.sources) == 1`,
      `${prefix}.volumes[1].projected.sources[0].serviceAccountToken.path == 'token'`,
      `${prefix}.volumes[1].projected.sources[0].serviceAccountToken.audience\n            == 'opensphere-console-foundation-owner-release'`,
      `${prefix}.volumes[1].projected.sources[0].serviceAccountToken.expirationSeconds == 600`,
      `${prefix}.volumes[2].name == 'release-control-ca'`,
      `${prefix}.volumes[2].configMap.name == 'opensphere-platform-release-control-ca'`,
      `size(${container}.volumeMounts) == 3`,
      `${container}.volumeMounts[0].name == 'kube-api-access'`,
      `${container}.volumeMounts[0].mountPath\n            == '/var/run/secrets/kubernetes.io/serviceaccount'`,
      `${container}.volumeMounts[1].name == 'receipt-identity'`,
      `${container}.volumeMounts[1].mountPath\n            == '/var/run/secrets/opensphere-foundation-owner-identity'`,
      `${container}.volumeMounts[2].name == 'release-control-ca'`,
      `${container}.volumeMounts[2].mountPath\n            == '/var/run/opensphere-platform-release-control-ca'`,
    ]) assert.ok(normalized.includes(contract.replace(/\s+/g, ' ')),
      `${suffix} boundary is missing: ${contract}`);
    assert.doesNotMatch(expression, /== 'opensphere-foundation-owner-release'/);
  }
});

test('reconciler Deployment and ReplicaSet Pod identities are reserved for one exact template', () => {
  const serviceAccount = find('ServiceAccount', 'foundation-owner-release-reconciler');
  const deployment = find('Deployment', 'foundation-owner-release-reconciler');
  assert.equal(serviceAccount.automountServiceAccountToken, false);
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.deepEqual(deployment.spec.template.spec.volumes.map((volume) => volume.name),
    ['kube-api-access', 'receipt-identity', 'release-control-ca']);
  assert.deepEqual(deployment.spec.template.spec.containers[0].volumeMounts, [
    { name: 'kube-api-access', mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', readOnly: true },
    { name: 'receipt-identity', mountPath: '/var/run/secrets/opensphere-foundation-owner-identity', readOnly: true },
    { name: 'release-control-ca', mountPath: '/var/run/opensphere-platform-release-control-ca', readOnly: true },
  ]);

  for (const [suffix, operations, prefix] of [
    ['deployment', ['CREATE', 'UPDATE'], 'object.spec.template.spec'],
    ['pod', ['CREATE'], 'object.spec'],
  ]) {
    const policy = find('ValidatingAdmissionPolicy', `foundation-owner-release-reconciler-${suffix}-boundary`);
    const binding = find('ValidatingAdmissionPolicyBinding',
      `foundation-owner-release-reconciler-${suffix}-boundary`);
    assert.deepEqual(policy.spec.matchConstraints.resourceRules[0].operations, operations);
    if (suffix === 'deployment') {
      assert.equal(policy.spec.paramKind, undefined);
      assert.equal(binding.spec.paramRef, undefined);
    } else {
      assert.deepEqual(policy.spec.paramKind, { apiVersion: 'apps/v1', kind: 'Deployment' });
      assert.equal(binding.spec.paramRef.name, deployment.metadata.name);
      assert.equal(binding.spec.paramRef.parameterNotFoundAction, 'Deny');
    }
    const expression = policy.spec.validations[0].expression;
    const exactBoundary = expression.indexOf(') || (');
    assert.ok(exactBoundary > 0);
    const reservationGate = expression.slice(0, exactBoundary);
    const exactTemplate = expression.slice(exactBoundary);
    assert.match(reservationGate, /foundation-owner-release-reconciler/);
    assert.match(reservationGate, /serviceAccountName == 'foundation-owner-release-reconciler'/);
    assert.match(reservationGate,
      /metadata\.labels\['app'\] == 'foundation-owner-release-reconciler'/);
    assert.match(exactTemplate, new RegExp(`${prefix.replaceAll('.', '\\.')}\\.automountServiceAccountToken == false`));
    assert.match(exactTemplate, new RegExp(`size\\(${prefix.replaceAll('.', '\\.')}\\.volumes\\) == 3`));
    if (suffix === 'deployment') {
      assert.match(exactTemplate, /containers\[0\]\.image\.matches/);
      assert.match(exactTemplate, /env\[5\]\.value[\s\S]+?containers\[0\]\.image/);
    } else {
      assert.match(exactTemplate, /params\.metadata\.name == 'foundation-owner-release-reconciler'/);
      assert.match(exactTemplate,
        /containers\[0\]\.image == params\.spec\.template\.spec\.containers\[0\]\.image/);
    }
    assert.match(exactTemplate, /opensphere-platform-release-control-ca/);
    assert.doesNotMatch(exactTemplate, /GITEA_TOKEN|foundation-owner-release-gitea-readonly/);
    assert.match(exactTemplate, /env\.map\(e, e\.name\) ==/);
    assert.match(exactTemplate, /size\(.+?volumeMounts\) == 3/);
    assert.doesNotMatch(expression,
      /^object\.spec(?:\.template\.spec)?\.serviceAccountName != 'foundation-owner-release-reconciler'\s*\|\|/);
  }

  const podExpression = find('ValidatingAdmissionPolicy',
    'foundation-owner-release-reconciler-pod-boundary').spec.validations[0].expression;
  assert.match(podExpression,
    /request\.userInfo\.username in \[[\s\S]+?system:kube-controller-manager[\s\S]+?replicaset-controller/);
  assert.match(podExpression, /ownerReferences\[0\]\.kind == 'ReplicaSet'/);
  assert.match(podExpression,
    /ownerReferences\[0\]\.name[\s\S]+?pod-template-hash/);
  assert.match(podExpression, /size\(object\.metadata\.labels\) == 3/);
  assert.doesNotMatch(podExpression,
    /system:serviceaccount:opensphere-console:foundation-owner-release-reconciler/);
});

test('component releases do not depend on a derived mutable executor authority object', () => {
  assert.equal(find('ValidatingAdmissionPolicy', 'foundation-owner-release-executor-authority-writer'), undefined);
  assert.equal(documents.some((item) => item.kind === 'ConfigMap'
    && item.metadata?.name?.startsWith('foundation-owner-release-executor-authority-')), false);
  const reconciler = find('Deployment', 'foundation-owner-release-reconciler');
  const image = reconciler.spec.template.spec.containers[0].image;
  assert.equal(reconciler.spec.template.spec.containers[0].env
    .find((entry) => entry.name === 'EXECUTOR_IMAGE').value, image);
  for (const suffix of ['job', 'pod']) {
    assert.equal(find('ValidatingAdmissionPolicyBinding',
      `foundation-owner-release-executor-${suffix}-boundary`).spec.paramRef.name,
    reconciler.metadata.name);
  }
});

test('reconciler identity and every reserved Job identity are fail-closed to the exact template', () => {
  const policy = find('ValidatingAdmissionPolicy', 'foundation-owner-release-executor-job-boundary');
  const expression = policy.spec.validations[0].expression;
  const exactBoundary = expression.indexOf(') || (');
  assert.ok(exactBoundary > 0);
  const reservationGate = expression.slice(0, exactBoundary);
  const exactTemplate = expression.slice(exactBoundary);
  assert.match(reservationGate,
    /request\.userInfo\.username == 'system:serviceaccount:opensphere-console:foundation-owner-release-reconciler'/);
  assert.match(reservationGate,
    /serviceAccountName == 'foundation-owner-release-executor'/);
  assert.match(reservationGate, /metadata\.name\.startsWith\('foundation-owner-release-'\)/);
  assert.match(reservationGate, /metadata\.labels\['app'\] == 'foundation-owner-release-executor'/);
  assert.match(exactTemplate,
    /request\.userInfo\.username == 'system:serviceaccount:opensphere-console:foundation-owner-release-reconciler'/);
  assert.match(exactTemplate, /serviceAccountName == 'foundation-owner-release-executor'/);
  assert.doesNotMatch(expression,
    /^object\.spec\.template\.spec\.serviceAccountName != 'foundation-owner-release-executor'\s*\|\|/);
});

test('executor Job policy is a single non-indexed run with server selector defaults only', () => {
  const policy = find('ValidatingAdmissionPolicy', 'foundation-owner-release-executor-job-boundary');
  const expression = policy.spec.validations[0].expression;
  for (const contract of [
    /object\.spec\.parallelism == 1/,
    /object\.spec\.completions == 1/,
    /object\.spec\.completionMode == 'NonIndexed'/,
    /object\.spec\.manualSelector == false/,
    /object\.spec\.suspend == false/,
    /object\.spec\.podReplacementPolicy == 'TerminatingOrFailed'/,
    /!has\(object\.spec\.podFailurePolicy\)/,
    /!has\(object\.spec\.successPolicy\)/,
    /!has\(object\.spec\.backoffLimitPerIndex\)/,
    /!has\(object\.spec\.maxFailedIndexes\)/,
    /!has\(object\.spec\.managedBy\)/,
    /size\(object\.spec\.selector\.matchLabels\) == 1/,
    /k == 'batch\.kubernetes\.io\/controller-uid'/,
    /size\(object\.spec\.selector\.matchExpressions\) == 0/,
  ]) assert.match(expression, contract);
  assert.match(expression,
    /metadata\.labels\['batch\.kubernetes\.io\/job-name'\] == object\.metadata\.name/);
  assert.match(expression,
    /metadata\.labels\['controller-uid'\][\s\S]+?selector\.matchLabels\['batch\.kubernetes\.io\/controller-uid'\]/);
});

test('executor Pod admits only the two DefaultTolerationSeconds mutations', () => {
  const policy = find('ValidatingAdmissionPolicy', 'foundation-owner-release-executor-pod-boundary');
  const expression = policy.spec.validations[0].expression;
  assert.match(expression, /size\(object\.spec\.tolerations\) == 2/);
  assert.match(expression,
    /t\.key in \['node\.kubernetes\.io\/not-ready','node\.kubernetes\.io\/unreachable'\]/);
  assert.match(expression, /t\.operator == 'Exists'/);
  assert.match(expression, /t\.effect == 'NoExecute'/);
  assert.match(expression, /t\.tolerationSeconds == 300/);
  assert.match(expression,
    /size\(object\.spec\.tolerations\.filter\(t, t\.key == 'node\.kubernetes\.io\/not-ready'\)\) == 1/);
  assert.match(expression,
    /size\(object\.spec\.tolerations\.filter\(t, t\.key == 'node\.kubernetes\.io\/unreachable'\)\) == 1/);
});

test('durable lock name allows canonical create, executor updates, and no deletion', () => {
  const initializer = find('ServiceAccount', 'foundation-owner-installation-lock-initializer');
  const role = find('Role', 'foundation-owner-installation-lock-initializer');
  assert.ok(initializer);
  assert.equal(initializer.automountServiceAccountToken, false);
  assert.ok(role.rules.some((rule) => rule.verbs.length === 1 && rule.verbs[0] === 'create'));
  assert.ok(role.rules.some((rule) => rule.verbs.length === 1 && rule.verbs[0] === 'get'
    && rule.resourceNames?.[0] === 'foundation-owner-installation-lock'));
  const policy = find('ValidatingAdmissionPolicy', 'foundation-owner-installation-lock-writer');
  assert.deepEqual(policy.spec.matchConstraints.resourceRules[0].operations, ['CREATE', 'UPDATE', 'DELETE']);
  const expression = policy.spec.validations[0].expression;
  assert.match(expression,
    /request\.operation == 'CREATE'[\s\S]+?foundation-owner-installation-lock-initializer/);
  assert.match(expression,
    /object\.data\['release\.json'\][\s\S]+?"phase":"Uninitialized"/);
  assert.match(expression,
    /request\.operation == 'UPDATE'[\s\S]+?foundation-owner-release-executor/);
  assert.doesNotMatch(expression, /request\.operation == 'DELETE'/);
  assert.doesNotMatch(expression, /platform-release-executor/);
});

test('Foundation release workers have selector-specific closed network paths', () => {
  const reconciler = find('NetworkPolicy', 'foundation-owner-release-reconciler');
  const executor = find('NetworkPolicy', 'foundation-owner-release-executor');
  for (const [policy, app, count] of [
    [reconciler, 'foundation-owner-release-reconciler', 3],
    [executor, 'foundation-owner-release-executor', 4],
  ]) {
    assert.deepEqual(policy.spec.podSelector.matchLabels, { app });
    assert.deepEqual(policy.spec.policyTypes, ['Ingress', 'Egress']);
    assert.deepEqual(policy.spec.ingress, []);
    assert.equal(policy.spec.egress.length, count);
    const dns = policy.spec.egress.find((rule) => rule.ports?.some((port) => port.port === 53));
    assert.deepEqual(dns.to[0].namespaceSelector.matchLabels,
      { 'kubernetes.io/metadata.name': 'kube-system' });
    assert.deepEqual(dns.to[0].podSelector.matchLabels, { 'k8s-app': 'kube-dns' });
    assert.deepEqual(dns.ports, [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }]);
    const kubeApi = policy.spec.egress.find((rule) => rule.ports?.[0]?.port === 443);
    assert.deepEqual(kubeApi.to, [{ ipBlock: { cidr: '10.96.0.1/32' } }]);
    const backend = policy.spec.egress.find((rule) =>
      rule.to?.[0]?.podSelector?.matchLabels?.app === 'opensphere-console-backend');
    assert.deepEqual(backend.ports, [{ protocol: 'TCP', port: 8446 }]);
    assert.equal(policy.spec.egress.some((rule) =>
      rule.to?.[0]?.podSelector?.matchLabels?.app === 'opensphere-gitea'), false);
  }
  const ownerEgress = executor.spec.egress.find((rule) =>
    rule.to?.[0]?.podSelector?.matchLabels?.app === 'foundation-oaa-owner');
  assert.deepEqual(ownerEgress.ports, [{ protocol: 'TCP', port: 8080 }]);
  const ownerIngress = find('NetworkPolicy', 'foundation-owner-release-executor-owner-read');
  assert.deepEqual(ownerIngress.spec.podSelector.matchLabels, { app: 'foundation-oaa-owner' });
  assert.deepEqual(ownerIngress.spec.ingress, [{
    from: [{ podSelector: { matchLabels: { app: 'foundation-owner-release-executor' } } }],
    ports: [{ protocol: 'TCP', port: 8080 }],
  }]);
});

test('release workers use only the TLS authority and do not receive Gitea credentials', () => {
  const reconciler = find('Deployment', 'foundation-owner-release-reconciler');
  const env = Object.fromEntries(reconciler.spec.template.spec.containers[0].env
    .filter((entry) => Object.hasOwn(entry, 'value')).map((entry) => [entry.name, entry.value]));
  assert.equal(env.CONSOLE_BACKEND_URL, undefined);
  assert.equal(env.GITEA_URL, undefined);
  assert.equal(reconciler.spec.template.spec.containers[0].env
    .some((entry) => entry.name === 'GITEA_TOKEN'), false);
  assert.deepEqual(reconciler.spec.template.spec.volumes.at(-1), {
    name: 'release-control-ca',
    configMap: { name: 'opensphere-platform-release-control-ca', items: [{ key: 'ca.crt', path: 'ca.crt' }] },
  });
});

test('installation lock initialization validates existing and concurrent winners through one path', () => {
  const initializer = fs.readFileSync(path.join(here, '..', '..', 'scripts',
    'Initialize-FoundationOwnerInstallationLock.ps1'), 'utf8');
  assert.match(initializer, /function ConvertFrom-ValidatedLockDocument/);
  assert.equal((initializer.match(/ConvertFrom-ValidatedLockDocument \(\$existingText -join/g) || []).length, 2);
  assert.match(initializer, /concurrent create winner/);
  assert.match(initializer, /@\(\$state\.PSObject\.Properties\)\.Count -ne 3/);
  assert.match(initializer,
    /--as', \$initializerIdentity/);
  assert.doesNotMatch(initializer, /kubectl[^\r\n]+\b(?:apply|replace)\b/i);
  const fixtures = spawnSync('pwsh', ['-NoProfile', '-File',
    path.join(here, 'foundation-owner-installation-lock-fixture.test.ps1')], { encoding: 'utf8' });
  assert.equal(fixtures.status, 0, fixtures.stderr || fixtures.stdout);
  assert.match(fixtures.stdout, /PASS Apply\/Rollback x Applying\/Completed\/Failed lock fixtures/);
});

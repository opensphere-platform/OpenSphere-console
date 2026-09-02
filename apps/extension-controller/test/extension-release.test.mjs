import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExtensionWorkloadPlan,
  parseTrustedExtensionKeys,
  planInactiveExtensionRevisionCleanup,
  verifyExtensionRelease,
} from '../src/extension-release.mjs';
import { artifactFetch, makeReleaseFixture } from './extension-release-fixture.mjs';

function copy(value) {
  return structuredClone(value);
}

test('workload plan binds every namespaced resource to one immutable Package revision', () => {
  const fixture = makeReleaseFixture();
  const plan = buildExtensionWorkloadPlan(fixture.pkg);
  assert.match(plan.revisionResourceName, /^workspace-r-[a-f0-9]{20}$/u);
  assert.equal(plan.resources.length, 4);
  for (const item of [...plan.resources, plan.activeService]) {
    const metadata = item.manifest.metadata;
    assert.equal(metadata.namespace, 'opensphere-console');
    assert.equal(metadata.labels['app.kubernetes.io/managed-by'], 'opensphere-extension-controller');
    assert.equal(metadata.labels['opensphere.io/extension-id'], 'workspace');
    assert.deepEqual(metadata.ownerReferences, [{
      apiVersion: 'plugins.opensphere.io/v1alpha1',
      kind: 'UIPluginPackage',
      name: 'workspace',
      uid: 'package-uid',
      controller: true,
      blockOwnerDeletion: false,
    }]);
  }
  const deployment = plan.resources.find((item) => item.manifest.kind === 'Deployment').manifest;
  const container = deployment.spec.template.spec.containers[0];
  assert.equal(container.image, fixture.pkg.spec.image.repository + '@' + fixture.pkg.spec.image.digest);
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.equal(
    container.env.find((entry) => entry.name === 'CONSOLE_IDENTITY_URL').value,
    'http://opensphere-console-api.opensphere-console.svc.cluster.local:8080',
  );
  assert.deepEqual(plan.activeService.manifest.spec.selector, deployment.spec.selector.matchLabels);
});

test('release verifier accepts only approved raw manifest, signature, and entry bytes', async () => {
  const fixture = makeReleaseFixture();
  const result = await verifyExtensionRelease({
    pkg: fixture.pkg,
    serviceName: 'workspace-r-0123456789abcdef0123',
    trustedKeys: parseTrustedExtensionKeys({ trustedKeys: fixture.trustedKeys }),
    fetchImpl: artifactFetch(fixture),
  });
  assert.equal(result.signature, 'Verified');
  assert.equal(result.manifestSha256, fixture.pkg.spec.manifest.sha256);
  assert.equal(result.entrySha256, fixture.manifest.entrySha256);
});

test('semantically equal manifest byte drift is rejected before signature interpretation', async () => {
  const fixture = makeReleaseFixture();
  await assert.rejects(verifyExtensionRelease({
    pkg: fixture.pkg,
    serviceName: 'workspace-r-0123456789abcdef0123',
    trustedKeys: fixture.trustedKeys,
    fetchImpl: artifactFetch(fixture, {
      manifestBytes: Buffer.concat([fixture.manifestBytes, Buffer.from('\n')]),
    }),
  }), { code: 'ManifestDigestMismatch' });
});

test('signature substitution and entry byte drift fail closed', async () => {
  const fixture = makeReleaseFixture();
  await assert.rejects(verifyExtensionRelease({
    pkg: fixture.pkg,
    serviceName: 'workspace-r-0123456789abcdef0123',
    trustedKeys: fixture.trustedKeys,
    fetchImpl: artifactFetch(fixture, { signatureBytes: Buffer.from(Buffer.alloc(64).toString('base64')) }),
  }), { code: 'ManifestSignatureInvalid' });
  await assert.rejects(verifyExtensionRelease({
    pkg: fixture.pkg,
    serviceName: 'workspace-r-0123456789abcdef0123',
    trustedKeys: fixture.trustedKeys,
    fetchImpl: artifactFetch(fixture, { entryBytes: Buffer.from('export const activate = () => false;\n') }),
  }), { code: 'EntryDigestMismatch' });
});

test('signed entry must be a closed module artifact', async () => {
  const fixture = makeReleaseFixture({ entrySource: "import './dependency.js';\nexport const activate = () => true;\n" });
  await assert.rejects(verifyExtensionRelease({
    pkg: fixture.pkg,
    serviceName: 'workspace-r-0123456789abcdef0123',
    trustedKeys: fixture.trustedKeys,
    fetchImpl: artifactFetch(fixture),
  }), { code: 'NonClosedModuleArtifact' });
});

test('unsafe runtime authority and cluster permission profiles are not materialized', () => {
  const fixture = makeReleaseFixture();
  const elevated = copy(fixture.pkg);
  elevated.spec.permissionProfile = 'cluster-read';
  assert.throws(() => buildExtensionWorkloadPlan(elevated), { code: 'UnsupportedPermissionProfile' });

  const tokenMount = copy(fixture.pkg);
  tokenMount.spec.runtime.security.automountServiceAccountToken = true;
  assert.throws(() => buildExtensionWorkloadPlan(tokenMount), { code: 'UnsafeRuntimeContract' });

  const autoscaled = copy(fixture.pkg);
  autoscaled.spec.runtime.availability.autoscaling.enabled = true;
  assert.throws(() => buildExtensionWorkloadPlan(autoscaled), { code: 'UnsafeRuntimeContract' });
});

test('trusted key set rejects malformed or excessive trust material', () => {
  const fixture = makeReleaseFixture();
  assert.deepEqual(Object.keys(parseTrustedExtensionKeys({ trustedKeys: fixture.trustedKeys })), ['release-key']);
  assert.throws(() => parseTrustedExtensionKeys({ trustedKeys: { 'bad key': 'AA==' } }), { code: 'TrustedKeysInvalid' });
  assert.throws(() => parseTrustedExtensionKeys({ trustedKeys: Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => ['key-' + index, fixture.trustedKeys['release-key']]),
  ) }), { code: 'TrustedKeysInvalid' });
});

function stored(manifest, suffix) {
  return {
    ...structuredClone(manifest),
    metadata: {
      ...structuredClone(manifest.metadata),
      uid: manifest.metadata.name + '-' + suffix + '-uid',
      resourceVersion: suffix,
    },
  };
}

test('pure GC planner selects only inactive, exactly-owned revision resources', () => {
  const fixture = makeReleaseFixture();
  const current = buildExtensionWorkloadPlan(fixture.pkg);
  const oldPackage = copy(fixture.pkg);
  oldPackage.spec.image.digest = 'sha256:' + 'c'.repeat(64);
  oldPackage.spec.resolution.resolvedDigest = oldPackage.spec.image.digest;
  oldPackage.spec.manifest.sha256 = 'd'.repeat(64);
  const previous = buildExtensionWorkloadPlan(oldPackage);

  const inventoryByPath = new Map(current.resources.map((item) => [
    item.basePath,
    { basePath: item.basePath, kind: item.manifest.kind, items: [] },
  ]));
  for (const [index, plan] of [previous, current].entries()) {
    for (const item of plan.resources) {
      inventoryByPath.get(item.basePath).items.push(stored(item.manifest, String(index + 1)));
    }
  }
  inventoryByPath.get(current.activeService.basePath).items.push(stored(current.activeService.manifest, '9'));
  const inventories = [...inventoryByPath.values()];

  const cleanup = planInactiveExtensionRevisionCleanup({ plan: current, inventories });
  assert.equal(cleanup.length, previous.resources.length);
  assert.deepEqual(cleanup.map((item) => item.apiPath), previous.resources
    .map((item) => item.basePath + '/' + item.manifest.metadata.name)
    .sort((left, right) => left.localeCompare(right)));
  assert.ok(cleanup.every((item) => item.revision === previous.revision));
  assert.equal(planInactiveExtensionRevisionCleanup({
    plan: current,
    inventories,
    retainRevision: null,
  }).length, previous.resources.length + current.resources.length);
});

test('pure GC planner rejects a forged managed label before returning any deletion coordinate', () => {
  const fixture = makeReleaseFixture();
  const plan = buildExtensionWorkloadPlan(fixture.pkg);
  const inventories = plan.resources.map((item, index) => ({
    basePath: item.basePath,
    kind: item.manifest.kind,
    items: [stored(item.manifest, String(index + 1))],
  }));
  inventories[0].items[0].metadata.labels['app.kubernetes.io/managed-by'] = 'foreign-controller';
  assert.throws(() => planInactiveExtensionRevisionCleanup({
    plan,
    inventories,
    retainRevision: null,
  }), { code: 'ResourceOwnershipMismatch' });

  const incomplete = inventories.slice(1);
  assert.throws(() => planInactiveExtensionRevisionCleanup({
    plan,
    inventories: incomplete,
  }), { code: 'AuthorityContractViolation' });
});

test('closed artifact policy rejects variable dynamic import and CommonJS require', async () => {
  for (const entrySource of [
    "const path = './dependency.js';\nexport const activate = () => import(path);\n",
    "export const activate = () => require('./dependency.js');\n",
  ]) {
    const fixture = makeReleaseFixture({ entrySource });
    await assert.rejects(verifyExtensionRelease({
      pkg: fixture.pkg,
      serviceName: 'workspace-r-0123456789abcdef0123',
      trustedKeys: fixture.trustedKeys,
      fetchImpl: artifactFetch(fixture),
    }), { code: 'NonClosedModuleArtifact' });
  }
});

test('materialization rejects missing provenance, duplicate evidence, and reserved Console env', () => {
  const fixture = makeReleaseFixture();

  const missingResourceVersion = copy(fixture.pkg);
  delete missingResourceVersion.metadata.resourceVersion;
  assert.throws(() => buildExtensionWorkloadPlan(missingResourceVersion), { code: 'PackageContractViolation' });

  const invalidAuthority = copy(fixture.pkg);
  invalidAuthority.spec.resolution.buildAuthority = 'developer-laptop';
  assert.throws(() => buildExtensionWorkloadPlan(invalidAuthority), { code: 'PackageContractViolation' });

  const duplicateEvidence = copy(fixture.pkg);
  duplicateEvidence.spec.resolution.evidenceRefs = ['release:test', 'release:test'];
  assert.throws(() => buildExtensionWorkloadPlan(duplicateEvidence), { code: 'PackageContractViolation' });

  const reservedEnv = copy(fixture.pkg);
  reservedEnv.spec.env.push({ name: 'CONSOLE_IDENTITY_URL', value: 'http://attacker.invalid' });
  assert.throws(() => buildExtensionWorkloadPlan(reservedEnv), { code: 'PackageContractViolation' });
});

test('release verifier enforces one aggregate asset byte budget including an exhausted exact boundary', async () => {
  const asset = (id, source) => ({ id, type: 'style', path: `/app/${id}.css`, source });
  const within = makeReleaseFixture({ assetSources: [asset('one', '1234'), asset('two', '5678'), asset('empty', '')] });
  await assert.doesNotReject(verifyExtensionRelease({
    pkg: within.pkg,
    serviceName: 'workspace-r-0123456789abcdef0123',
    trustedKeys: within.trustedKeys,
    fetchImpl: artifactFetch(within),
    assetMaximumTotalBytes: 8,
  }));

  const excessive = makeReleaseFixture({
    assetSources: [asset('one', '1234'), asset('two', '5678'), asset('three', '9')],
  });
  await assert.rejects(verifyExtensionRelease({
    pkg: excessive.pkg,
    serviceName: 'workspace-r-0123456789abcdef0123',
    trustedKeys: excessive.trustedKeys,
    fetchImpl: artifactFetch(excessive),
    assetMaximumTotalBytes: 8,
  }), { code: 'ArtifactTooLarge' });
});

test('pure GC planner refuses more than two inactive revisions or eight resources', () => {
  const current = buildExtensionWorkloadPlan(makeReleaseFixture().pkg);
  const oldPlans = ['c', 'd', 'e'].map((digit) => {
    const fixture = makeReleaseFixture();
    fixture.pkg.spec.image.digest = `sha256:${digit.repeat(64)}`;
    fixture.pkg.spec.resolution.resolvedDigest = fixture.pkg.spec.image.digest;
    fixture.pkg.spec.manifest.sha256 = digit.repeat(64);
    return buildExtensionWorkloadPlan(fixture.pkg);
  });
  const inventoryByPath = new Map(current.resources.map((item) => [
    item.basePath,
    { basePath: item.basePath, kind: item.manifest.kind, items: [] },
  ]));
  for (const [index, plan] of oldPlans.entries()) {
    for (const item of plan.resources) {
      inventoryByPath.get(item.basePath).items.push(stored(item.manifest, String(index + 1)));
    }
  }
  assert.throws(() => planInactiveExtensionRevisionCleanup({
    plan: current,
    inventories: [...inventoryByPath.values()],
  }), { code: 'AuthorityContractViolation' });
  assert.throws(() => planInactiveExtensionRevisionCleanup({
    plan: current,
    inventories: current.resources.map((item) => ({ basePath: item.basePath, kind: item.manifest.kind, items: [] })),
    maximumDeletes: 9,
  }), TypeError);
});

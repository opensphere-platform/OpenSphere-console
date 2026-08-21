'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  COMPONENT_REPOSITORIES,
  REQUIRED_COMPONENTS,
  backendComponentPublicationBinding,
  buildComponentReleaseLock,
  calculateReleaseDigest,
  canonicalJson,
  validateReleaseLock,
  validateReleaseTransition,
  validatePlatformReleaseDesiredState,
  validateBootstrapAInitializerCleanup,
  platformReleaseApprovalPolicy,
} = require('./platform-release-contract');
const executorImage = `ghcr.io/opensphere-platform/opensphere-console-backend@sha256:${'f'.repeat(64)}`;
process.env.EXECUTOR_IMAGE = executorImage;
const {
  validateGovernedManifest,
  executorJob,
  sameExecutorJob,
  ensureInternalAuthorityReady,
  claimWork,
} = require('./platform-release-reconciler');

const directory = __dirname;
const revision = 'a'.repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;

function cleanupProof() {
  const sourceRevision = 'a'.repeat(40);
  const bootstrapFrom = { requestId: '11111111-2222-4333-8444-555555555555', sourceRevision };
  const resources = [
    ['batch/v1', 'Job', 'opensphere-console', `opensphere-tls-init-${sourceRevision}`],
    ['v1', 'ServiceAccount', 'opensphere-console', 'platform-release-tls-initializer'],
    ['rbac.authorization.k8s.io/v1', 'Role', 'opensphere-console', 'platform-release-tls-initializer'],
    ['rbac.authorization.k8s.io/v1', 'RoleBinding', 'opensphere-console', 'platform-release-tls-initializer'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '', 'platform-release-tls-initializer-custody'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '', 'platform-release-tls-initializer-custody'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '', 'platform-release-tls-initializer-job-boundary'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '', 'platform-release-tls-initializer-job-boundary'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', '', 'platform-release-tls-initializer-pod-boundary'],
    ['admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', '', 'platform-release-tls-initializer-pod-boundary'],
    ['networking.k8s.io/v1', 'NetworkPolicy', 'opensphere-console', 'platform-release-tls-initializer'],
  ].map(([apiVersion, kind, namespace, name], index) => ({
    apiVersion, kind, namespace, name,
    uid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    resourceVersion: String(index + 10),
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const identity = (offset) => ({
    [`secretUid`]: `10000000-0000-4000-8000-${String(offset).padStart(12, '0')}`,
  });
  const retainedAuthority = {
    contract: 'opensphere-platform-release-authority-retained/v1',
    secretUid: identity(1).secretUid, secretResourceVersion: '101',
    caConfigMapUid: identity(2).secretUid, caConfigMapResourceVersion: '102',
    serviceUid: identity(3).secretUid, serviceResourceVersion: '103',
    caCertSha256: digest('a'), tlsCertSha256: digest('b'),
    serviceCustodyPolicyUid: identity(4).secretUid, serviceCustodyPolicyResourceVersion: '104',
    serviceCustodyBindingUid: identity(5).secretUid, serviceCustodyBindingResourceVersion: '105',
  };
  const proof = {
    contract: 'opensphere-bootstrap-a-initializer-cleanup/v1',
    bootstrapRequestId: bootstrapFrom.requestId,
    bootstrapSourceRevision: sourceRevision,
    targetReleaseDigest: digest('c'),
    cleanupSetDigest: `sha256:${require('node:crypto').createHash('sha256')
      .update(canonicalJson(resources)).digest('hex')}`,
    deletedResources: resources,
    retainedAuthority,
    journalCustody: {
      policyUid: identity(6).secretUid, policyResourceVersion: '106',
      bindingUid: identity(7).secretUid, bindingResourceVersion: '107',
    },
    journalUid: identity(8).secretUid, journalResourceVersion: '108', journalSha256: digest('d'),
    residueCount: 0, completedAt: '2026-08-15T14:00:00.000Z',
  };
  return { proof, bootstrapFrom };
}

test('Bootstrap B final gate accepts only journaled residue-zero initializer cleanup proof', () => {
  const { proof, bootstrapFrom } = cleanupProof();
  assert.equal(validateBootstrapAInitializerCleanup(proof, {
    bootstrapFrom, targetReleaseDigest: digest('c'),
  }), proof);
  for (const mutate of [
    (value) => { value.residueCount = 1; },
    (value) => { value.deletedResources.pop(); },
    (value) => { value.deletedResources[0].name = 'attacker'; },
    (value) => { value.cleanupSetDigest = digest('0'); },
    (value) => { delete value.journalCustody.policyUid; },
    (value) => { value.retainedAuthority.serviceUid = 'attacker'; },
  ]) {
    const tampered = structuredClone(proof); mutate(tampered);
    assert.throws(() => validateBootstrapAInitializerCleanup(tampered, {
      bootstrapFrom, targetReleaseDigest: digest('c'),
    }), /cleanup|authority|custody/i);
  }
});

test('Foundation feature gate consumes the exact Bootstrap cleanup proof from the final receipt', () => {
  const server = fs.readFileSync(path.join(directory, 'server.js'), 'utf8');
  const executor = fs.readFileSync(path.join(directory, 'platform-release-executor.mjs'), 'utf8');
  assert.match(server, /validateBootstrapAInitializerCleanup\(receipt\.evidence\.bootstrapAInitializerCleanup/);
  assert.match(server, /targetReleaseDigest: installedLock\.releaseDigest/);
  assert.match(server, /feature gate remains closed during Backend Bootstrap A convergence/);
  assert.match(server, /feature gate remains closed until Bootstrap A initializer cleanup is durably proven/);
  assert.match(executor, /validateBootstrapAInitializerCleanup\(result\.evidence\?\.bootstrapAInitializerCleanup/);
  assert.match(executor, /bootstrapAInitializerCleanup,/);
});

test('TLS authority readiness succeeds before the first governed mutation claim', async () => {
  const calls = [];
  const request = async (pathName) => {
    calls.push(pathName);
    if (pathName === '/readyz') return {
      ready: true, service: 'opensphere-platform-release-authority', tls: 'TLSv1.3',
    };
    if (pathName === '/api/platform/reconcile/next') return { items: [] };
    throw new Error(`unexpected path ${pathName}`);
  };
  await ensureInternalAuthorityReady(request);
  await claimWork(request, () => 'projected-fixture-token');
  assert.deepEqual(calls, ['/readyz', '/api/platform/reconcile/next']);
});

function componentPublication() {
  return {
    contract: 'opensphere-edge-component-publication-binding/v1',
    publisher: 'scripts/Publish-LocalEdgeBackendComponent.ps1',
    publisherGitBlob: 'd'.repeat(40),
    publisherSha256: digest('d'),
    documentSha256: digest('e'),
    signatureSha256: digest('f'),
    keyId: 'opensphere-edge-local-v1',
    setupSourceRevision: 'c'.repeat(40),
    setupSourceLockSha256: digest('b'),
    setupManifestProjectionGitBlob: 'e'.repeat(40),
    setupManifestProjectionSha256: digest('e'),
    migrationSetDigest: digest('a'),
    platformRevision: '9'.repeat(40),
    inventorySha256: digest('9'),
    verificationSetDigest: digest('8'),
  };
}

function backendPublicationDocument() {
  const value = {
    apiVersion: 'release.opensphere.io/v1alpha1',
    kind: 'OpenSphereEdgeComponentPublication',
    publicationScope: 'ComponentSet',
    channel: 'edge', status: 'Active', releaseTag: '202608151230', immutableTag: `local-${'a'.repeat(12)}`,
    source: 'https://github.com/opensphere-platform/OpenSphere-console', sourceRevision: 'a'.repeat(40),
    buildAuthority: 'localhost', releaseClass: 'pre-ga', gaEligible: false,
    supportedPlatforms: ['linux/amd64'], requestIntent: 'governed Backend component release',
    changedPaths: ['backend/opensphere-console-backend/server.js'], affectedImages: ['backend'],
    releaseScope: 'component', fullReleaseJustification: null,
    previous: { image: `ghcr.io/opensphere-platform/opensphere-console-backend@${digest('1')}`,
      sourceRevision: '1'.repeat(40), setupSourceRevision: '2'.repeat(40) },
    setupSource: { repository: 'https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git',
      sourceRevision: 'c'.repeat(40), changedPaths: ['src/bootstrap.mjs'], lockSha256: digest('2'),
      manifestProjectionTool: { path: 'src/platform-release-bootstrap-manifest.mjs',
        gitBlob: 'e'.repeat(40), sha256: digest('e') } },
    platformAuthority: {
      repository: 'https://github.com/opensphere-platform/OpenSphere-Platform-V2.git',
      sourceRevision: '9'.repeat(40),
      inventory: { path: 'repository-inventory.json', gitBlob: '8'.repeat(40), sha256: digest('9') },
    },
    verification: {
      contract: 'opensphere-backend-component-verification-set/v1', setDigest: '',
      results: [
        'console-full-test', 'console-test', 'fresh-ledger-verifier',
        'rendered-manifest-client-dry-run', 'rendered-manifest-server-dry-run',
        'setup-full-test', 'setup-test',
      ].map((id) => ({ id, result: 'PASS', artifactUri: `evidence://${id}.log`,
        artifactSha256: digest('7'), startedAt: '2026-08-15T03:00:00.000Z',
        completedAt: '2026-08-15T03:10:00.000Z' })),
      renderedManifest: { artifactUri: 'evidence://backend-deploy.yaml', sha256: digest('6') },
    },
    artifacts: { supabaseMigrationManifest: { path: 'backend/supabase/migrations/manifest.json',
      sha256: digest('3'), setDigest: digest('4'), latestMigrationId: '0063', migrationCount: 63 } },
    components: { backend: { image: `ghcr.io/opensphere-platform/opensphere-console-backend@${digest('5')}`,
      sourceRevision: 'a'.repeat(40), registryCredentialsRequired: false } },
    tooling: Object.fromEntries(Object.entries({ publisher: 'scripts/Publish-LocalEdgeBackendComponent.ps1',
      deployer: 'scripts/Invoke-LocalEdgePlatformRelease.ps1', signingHelper: 'scripts/os-shell-edge-signing.ps1',
      initializer: 'scripts/Initialize-FoundationOwnerInstallationLock.ps1' }).map(([name, toolPath]) =>
      [name, { path: toolPath, gitBlob: '6'.repeat(40), sha256: digest('6') }])),
    generatedAt: '2026-08-15T03:30:00.000Z',
  };
  value.verification.setDigest = `sha256:${require('node:crypto').createHash('sha256')
    .update(JSON.stringify({ contract: value.verification.contract, results: value.verification.results,
      renderedManifest: value.verification.renderedManifest })).digest('hex')}`;
  return value;
}

test('signed Backend publication becomes a closed digest-bound release-lock authority', () => {
  const binding = backendComponentPublicationBinding(backendPublicationDocument(), {
    documentSha256: digest('7'), signatureSha256: digest('8'), keyId: 'opensphere-edge-local-v1',
  });
  assert.equal(binding.publisher, 'scripts/Publish-LocalEdgeBackendComponent.ps1');
  assert.equal(binding.setupSourceRevision, 'c'.repeat(40));
  assert.equal(binding.setupSourceLockSha256, digest('2'));
  assert.equal(binding.setupManifestProjectionSha256, digest('e'));
  assert.throws(() => backendComponentPublicationBinding({
    ...backendPublicationDocument(), affectedImages: ['backend', 'console'],
  }, { documentSha256: digest('7'), signatureSha256: digest('8'), keyId: 'opensphere-edge-local-v1' }),
  /canonical component release contract/);
  const missingVerification = backendPublicationDocument();
  missingVerification.verification.results.pop();
  missingVerification.verification.setDigest = `sha256:${require('node:crypto').createHash('sha256')
    .update(JSON.stringify({ contract: missingVerification.verification.contract,
      results: missingVerification.verification.results,
      renderedManifest: missingVerification.verification.renderedManifest })).digest('hex')}`;
  assert.throws(() => backendComponentPublicationBinding(missingVerification, {
    documentSha256: digest('7'), signatureSha256: digest('8'), keyId: 'opensphere-edge-local-v1',
  }), /canonical component release contract/);

  const reusedSetup = backendPublicationDocument();
  reusedSetup.previous.setupSourceRevision = reusedSetup.setupSource.sourceRevision;
  reusedSetup.setupSource.changedPaths = [];
  assert.doesNotThrow(() => backendComponentPublicationBinding(reusedSetup, {
    documentSha256: digest('7'), signatureSha256: digest('8'), keyId: 'opensphere-edge-local-v1',
  }));
  reusedSetup.setupSource.changedPaths = ['src/bootstrap.mjs'];
  assert.throws(() => backendComponentPublicationBinding(reusedSetup, {
    documentSha256: digest('7'), signatureSha256: digest('8'), keyId: 'opensphere-edge-local-v1',
  }), /Setup revision and changed paths are inconsistent/);

  const missingSetupDiff = backendPublicationDocument();
  missingSetupDiff.setupSource.changedPaths = [];
  assert.throws(() => backendComponentPublicationBinding(missingSetupDiff, {
    documentSha256: digest('7'), signatureSha256: digest('8'), keyId: 'opensphere-edge-local-v1',
  }), /Setup revision and changed paths are inconsistent/);

  const cleanupSetup = backendPublicationDocument();
  cleanupSetup.setupSource.changedPaths = [
    'src/platform-release-bootstrap-cleanup.mjs',
    'src/platform-release-bootstrap-manifest.mjs',
    'test/platform-release-bootstrap-cleanup.test.mjs',
    'test/platform-release-bootstrap-manifest.test.mjs',
  ];
  assert.doesNotThrow(() => backendComponentPublicationBinding(cleanupSetup, {
    documentSha256: digest('7'), signatureSha256: digest('8'), keyId: 'opensphere-edge-local-v1',
  }));
  cleanupSetup.setupSource.changedPaths.push('src/attacker.mjs');
  assert.throws(() => backendComponentPublicationBinding(cleanupSetup, {
    documentSha256: digest('7'), signatureSha256: digest('8'), keyId: 'opensphere-edge-local-v1',
  }), /canonical component release contract/);
});

function releaseLock() {
  const hexCharacters = '0123456789abcdef';
  const lock = {
    apiVersion: 'release.opensphere.io/v1alpha1',
    kind: 'OpenSphereReleaseLock',
    channel: 'edge',
    releaseDigest: '',
    resolvedAt: '2026-07-30T00:00:00.000Z',
    source: 'https://github.com/opensphere-platform/OpenSphere-console',
    sourceRevision: revision,
    trust: {
      type: 'localhost-edge/v1',
      repository: 'opensphere-platform/OpenSphere-console',
      publisher: 'scripts/Publish-LocalEdge.ps1',
      buildAuthority: 'localhost',
      releaseClass: 'pre-ga',
      gaEligible: false,
    },
    components: Object.fromEntries(REQUIRED_COMPONENTS.map((name, index) => [
    name,
    {
        repository: COMPONENT_REPOSITORIES[name],
        image: `ghcr.io/opensphere-platform/${COMPONENT_REPOSITORIES[name]}@${digest(hexCharacters[index % hexCharacters.length])}`,
        sourceRevision: revision,
        registryCredentialsRequired: false,
      },
    ])),
  };
  lock.releaseDigest = calculateReleaseDigest(lock);
  return lock;
}

function desiredState() {
  return {
    contract: 'opensphere.platform.release/v1',
    previousReleaseDigest: digest('a'),
    targetLock: releaseLock(),
  };
}

test('Platform Release contract accepts only the complete canonical exact-digest release lock', () => {
  const valid = releaseLock();
  assert.equal(validateReleaseLock(valid), valid);
  assert.equal(
    validatePlatformReleaseDesiredState(desiredState()).targetLock.releaseDigest,
    valid.releaseDigest,
  );

  const incomplete = structuredClone(valid);
  delete incomplete.components.backend;
  assert.throws(() => validateReleaseLock(incomplete), /component set/);

  const mutable = structuredClone(valid);
  mutable.components.console.image = 'ghcr.io/opensphere-platform/opensphere-console:edge';
  assert.throws(() => validateReleaseLock(mutable), /exact-digest/);

  const substituted = structuredClone(valid);
  substituted.source = 'https://github.com/attacker/console';
  assert.throws(() => validateReleaseLock(substituted), /canonical Console repository/);

  const tamperedDigest = structuredClone(valid);
  tamperedDigest.components.console.image =
    `ghcr.io/opensphere-platform/opensphere-console@${digest('f')}`;
  assert.throws(() => validateReleaseLock(tamperedDigest), /releaseDigest does not match/);

  const spoofedTrust = structuredClone(valid);
  spoofedTrust.trust.publisher = 'scripts/attacker.ps1';
  spoofedTrust.releaseDigest = calculateReleaseDigest(spoofedTrust);
  assert.throws(() => validateReleaseLock(spoofedTrust), /trust root/);

  const unsupportedGa = structuredClone(valid);
  unsupportedGa.channel = 'ga';
  unsupportedGa.releaseDigest = calculateReleaseDigest(unsupportedGa);
  assert.throws(() => validateReleaseLock(unsupportedGa), /channel is unsupported/);

  const blockedPromotion = structuredClone(valid);
  blockedPromotion.channel = 'candidate';
  blockedPromotion.releaseDigest = calculateReleaseDigest(blockedPromotion);
  assert.throws(() => validateReleaseLock(blockedPromotion), /channel is unsupported/);
});

test('Console generates an atomic component target from the installed complete lock', () => {
  const base = releaseLock();
  const target = buildComponentReleaseLock(base, {
    sourceRevision: 'b'.repeat(40),
    components: {
      backend: {
        image: digest('f'),
        registryCredentialsRequired: false,
      },
    },
    componentPublication: componentPublication(),
  }, new Date('2026-07-30T12:34:56.000Z'));
  assert.equal(target.releaseScope, 'component');
  assert.equal(target.baseReleaseDigest, base.releaseDigest);
  assert.deepEqual(target.changedComponents, ['backend']);
  assert.equal(target.components.console.image, base.components.console.image);
  assert.equal(
    target.components.backend.image,
    `ghcr.io/opensphere-platform/opensphere-console-backend@${digest('f')}`,
  );
  assert.equal(target.components.backend.sourceRevision, 'b'.repeat(40));
  assert.equal(target.resolvedAt, '2026-07-30T12:34:56.000Z');
  assert.equal(Object.keys(target.components).length, REQUIRED_COMPONENTS.length);
  assert.equal(validateReleaseTransition(base, target), target);
});

test('component target rejects stale bases, hidden changes and non-local promotion', () => {
  const base = releaseLock();
  const target = buildComponentReleaseLock(base, {
    sourceRevision: 'b'.repeat(40),
    components: { backend: { image: digest('f') } },
    componentPublication: componentPublication(),
  });

  const stale = structuredClone(target);
  stale.baseReleaseDigest = digest('e');
  stale.releaseDigest = calculateReleaseDigest(stale);
  assert.throws(() => validateReleaseTransition(base, stale), /installed base release digest/);

  const hidden = structuredClone(target);
  hidden.components.console.image =
    `ghcr.io/opensphere-platform/opensphere-console@${digest('e')}`;
  hidden.releaseDigest = calculateReleaseDigest(hidden);
  assert.throws(() => validateReleaseTransition(base, hidden), /unlisted component console/);

  const promoted = structuredClone(target);
  promoted.channel = 'candidate';
  promoted.releaseDigest = calculateReleaseDigest(promoted);
  assert.throws(() => validateReleaseLock(promoted), /channel is unsupported|localhost edge/);
});

test('only localhost edge component apply uses the Docker Desktop automation boundary', () => {
  const base = releaseLock();
  const component = buildComponentReleaseLock(base, {
    sourceRevision: 'b'.repeat(40),
    components: { backend: { image: digest('f') } },
    componentPublication: componentPublication(),
  });
  const state = {
    contract: 'opensphere.platform.release/v1',
    previousReleaseDigest: base.releaseDigest,
    targetLock: component,
  };
  assert.deepEqual(platformReleaseApprovalPolicy('apply', state), {
    mode: 'local-edge-automation',
    requiredHumanApprovals: 0,
    autoMerge: true,
    rationale: 'localhost edge component apply is authorized by the docker-desktop local automation boundary',
  });
  assert.equal(platformReleaseApprovalPolicy('rollback', state).mode, 'cross-operator');

  const integrated = releaseLock();
  assert.equal(platformReleaseApprovalPolicy('apply', {
    contract: 'opensphere.platform.release/v1',
    previousReleaseDigest: digest('a'),
    targetLock: integrated,
  }).mode, 'cross-operator');
});

test('reviewed Gitea declaration is converted into one closed exact-digest executor Job', () => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const manifest = {
    apiVersion: 'platform.opensphere.io/v1alpha1',
    kind: 'GovernedChange',
    metadata: { requestId, consumerId: 'platform-release' },
    spec: {
      action: 'apply',
      target: 'opensphere-platform',
      reason: 'approved platform release',
      desiredState: desiredState(),
    },
  };
  const work = {
    request_id: requestId,
    action: 'gitea:apply',
    target: 'opensphere-platform',
    reason: 'approved platform release',
    attempt: 1,
    git_commit_sha: revision,
  };
  assert.equal(validateGovernedManifest(manifest, work), manifest);
  const job = executorJob(work, manifest);
  const container = job.spec.template.spec.containers[0];
  assert.equal(job.spec.template.spec.serviceAccountName, 'platform-release-executor');
  assert.equal(job.metadata.name, `platform-release-${requestId}-a1`);
  assert.equal(job.metadata.labels['opensphere.io/request-id'], requestId);
  assert.equal(container.image, executorImage);
  assert.deepEqual(container.command, ['node', '/app/opensphere-console-backend/platform-release-executor.mjs']);
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(container.env.find((entry) => entry.name === 'EXPECTED_PREVIOUS_RELEASE_DIGEST').value, digest('a'));
  assert.equal(container.env.find((entry) => entry.name === 'IDENTITY_TOKEN_PATH').value,
    '/var/run/secrets/opensphere-platform-release-identity/token');
  assert.equal(container.env.some((entry) => entry.name === 'RECONCILER_TOKEN'), false);
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.deepEqual(job.spec.template.spec.volumes.map((entry) => entry.name),
    ['kube-api-access', 'receipt-identity', 'tmp', 'ghcr', 'release-control-ca']);
  const retryJob = executorJob({ ...work, attempt: 2 }, manifest);
  assert.equal(retryJob.metadata.name, `platform-release-${requestId}-a2`);
  assert.notEqual(retryJob.metadata.name, job.metadata.name);
  assert.equal(retryJob.metadata.labels['opensphere.io/request-id'], requestId);
  assert.equal(container.env.some((entry) => entry.name === 'GITEA_TOKEN'), false);
  assert.equal(container.env.some((entry) => entry.name === 'GITEA_URL'), false);
  assert.equal(container.env.some((entry) => entry.name === 'CONSOLE_BACKEND_URL'), false);
  assert.deepEqual(container.volumeMounts.at(-1), {
    name: 'release-control-ca',
    mountPath: '/var/run/opensphere-platform-release-control-ca',
    readOnly: true,
  });
});

test('response-loss 409 accepts only the canonical server-defaulted executor Job', () => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const manifest = {
    apiVersion: 'platform.opensphere.io/v1alpha1', kind: 'GovernedChange',
    metadata: { requestId, consumerId: 'platform-release' },
    spec: { action: 'apply', target: 'opensphere-platform', reason: 'approved platform release',
      desiredState: desiredState() },
  };
  const work = { request_id: requestId, action: 'gitea:apply', target: 'opensphere-platform',
    reason: 'approved platform release', attempt: 1, git_commit_sha: revision };
  const intended = executorJob(work, manifest);
  const observed = structuredClone(intended);
  observed.metadata.uid = '123e4567-e89b-42d3-a456-426614174001';
  observed.metadata.resourceVersion = '123';
  observed.spec.selector = { matchLabels: { 'batch.kubernetes.io/controller-uid': 'server-default' } };
  Object.assign(observed.spec, { parallelism: 1, completions: 1, completionMode: 'NonIndexed',
    manualSelector: false, suspend: false, podReplacementPolicy: 'TerminatingOrFailed' });
  Object.assign(observed.spec.template.metadata.labels, {
    'controller-uid': 'server-default',
    'batch.kubernetes.io/controller-uid': 'server-default',
    'job-name': observed.metadata.name,
    'batch.kubernetes.io/job-name': observed.metadata.name,
  });
  Object.assign(observed.spec.template.spec, { serviceAccount: 'platform-release-executor',
    schedulerName: 'default-scheduler', dnsPolicy: 'ClusterFirst', terminationGracePeriodSeconds: 30,
    securityContext: {} });
  Object.assign(observed.spec.template.spec.containers[0], {
    terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File',
  });
  assert.equal(sameExecutorJob(observed, intended), true);

  for (const mutate of [
    (job) => { job.spec.template.spec.containers[0].image =
      `ghcr.io/opensphere-platform/opensphere-console-backend@${digest('0')}`; },
    (job) => { job.spec.template.spec.containers[0].command = ['node', '/tmp/attacker.mjs']; },
    (job) => { job.spec.template.spec.containers[0].env
      .find((entry) => entry.name === 'GIT_COMMIT_SHA').value = '0'.repeat(40); },
    (job) => { job.spec.template.spec.volumes.push({ name: 'attacker', hostPath: { path: '/' } }); },
    (job) => { job.spec.parallelism = 2; },
  ]) {
    const altered = structuredClone(observed);
    mutate(altered);
    assert.equal(sameExecutorJob(altered, intended), false);
  }
});

test('Platform Release runtime is isolated from browser and local workstation execution', () => {
  const server = fs.readFileSync(path.join(directory, 'server.js'), 'utf8');
  const deploy = fs.readFileSync(path.join(directory, 'deploy.yaml'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(directory, 'Dockerfile'), 'utf8');
  const migration = fs.readFileSync(path.join(directory, '..', 'supabase', 'migrations', '0033_platform_release_consumer.sql'), 'utf8');
  const ui = fs.readFileSync(path.join(directory, '..', '..', 'src', 'app', 'pages', 'admin-platform-release.ts'), 'utf8');

  assert.match(server, /validatePlatformReleaseDesiredState/);
  assert.match(server, /previousReleaseDigest !== installed\.summary\.releaseDigest/);
  assert.match(server, /\/api\/platform\/releases\/status/);
  assert.match(server, /\/api\/platform\/releases\/component-target/);
  assert.match(server, /buildComponentReleaseLock/);
  assert.match(server, /platform-release-component-target-generate[\s\S]*phase: 'intent'/);
  assert.doesNotMatch(server, /platform-release-component-target-generate[\s\S]*phase: 'planned'/);
  assert.match(server, /validateReleaseTransition\(installed\.lock, desiredState\.targetLock\)/);
  assert.match(server, /localEdgeAutomationRequest/);
  assert.match(server, /platformReleaseRuntimeStatus/);
  assert.match(server, /supportedChannels: \['edge'\]/);
  assert.match(server, /authorizeLocalEdgeComponentRelease/);
  assert.match(server, /logAudit\(actor, `\$\{targetType\}-edge-automation`/);
  assert.match(server, /\/api\/platform\/releases\/local-edge-automation/);
  assert.match(server, /authentication\.k8s\.io\/v1\/tokenreviews/);
  assert.match(server, /LOCAL_EDGE_AUTOMATION_AUDIENCE/);
  assert.match(server, /reconciliationQueued/);
  assert.match(deploy, /name: platform-release-reconciler/);
  assert.match(deploy, /name: platform-release-executor/);
  assert.match(deploy, /kind: ValidatingAdmissionPolicy[\s\S]*platform-release-executor-job-boundary/);
  assert.match(deploy, /kind: ValidatingAdmissionPolicy[\s\S]*platform-release-executor-pod-boundary/);
  assert.match(deploy, /system:serviceaccount:kube-system:job-controller/);
  assert.match(deploy, /object\.spec\.template\.spec\.containers\[0\]\.env\.map\(e, e\.name\)/);
  assert.match(deploy, /resources: \["jobs"\][\s\S]*verbs: \["get", "create"\]/);
  assert.match(deploy, /name: opensphere-local-edge-release/);
  assert.match(deploy, /resources: \["tokenreviews"\][\s\S]*verbs: \["create"\]/);
  assert.match(dockerfile, /COPY --from=setup-cli src \/app\/opensphere-setup-cli\/src/);
  assert.match(dockerfile, /COPY opensphere-console-backend\/platform-release-internal-transport\.js/);
  assert.match(dockerfile, /COPY opensphere-console-backend\/platform-release-manifest-projection\.js/);
  assert.match(dockerfile, /EXPOSE 8080 8444 8446/);
  assert.match(dockerfile, /registry\.k8s\.io\/kubectl@sha256:/);
  assert.match(dockerfile, /node:24-bookworm-slim@sha256:/);
  assert.match(dockerfile, /powershell-7\.5\.7-linux-\$\{PS_ARCH\}\.tar\.gz/);
  assert.match(dockerfile, /PS_SHA256='207a3c0b2f630e8e1226cc9beb651e2e16789f07729197f45fd3ad0902d1c593'/);
  assert.match(dockerfile, /PS_SHA256='8eb84faecd4834f4b961a6601c28c0c61a620a43f005e977f546b89e1e0f1aa2'/);
  assert.match(dockerfile, /pwsh -NoLogo -NoProfile -NonInteractive/);
  assert.match(dockerfile, /gh_2\.96\.0_linux_\$\{TARGETARCH\}/);
  assert.match(migration, /'platform-release-reconciler'/);
  assert.match(ui, /local kubeconfig/);
  assert.match(ui, /\/api\/platform\/changes/);
  assert.match(ui, /previousReleaseDigest/);
  assert.match(ui, /Component Lock 생성/);
  assert.match(ui, /\/api\/platform\/releases\/component-target/);
  assert.match(ui, /선택하지 않은 구성요소는 현재 설치 lock에서 그대로 계승/);
  assert.match(ui, /canGenerateComponentTarget\(\): boolean/);
  assert.doesNotMatch(ui, /canGenerateComponentTarget\s*=\s*computed/);
  assert.match(ui, /Docker Desktop 전용 자동화 신원/);
  assert.match(ui, /localEdgeAutomationTarget\(\): boolean/);
  assert.match(ui, /local edge 자동화 정책으로 승인·병합/);
  assert.match(ui, /this\.status\(\)\?\.execution\.ready/);
  assert.match(ui, /component apply는 docker-desktop에 결속된 단기 ServiceAccount 자동화 정책/);
});

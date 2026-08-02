'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  COMPONENT_REPOSITORIES,
  REQUIRED_COMPONENTS,
  calculateReleaseDigest,
  validateReleaseLock,
  validatePlatformReleaseDesiredState,
} = require('./platform-release-contract');
const executorImage = `ghcr.io/opensphere-platform/opensphere-console-backend@sha256:${'f'.repeat(64)}`;
process.env.EXECUTOR_IMAGE = executorImage;
const {
  validateGovernedManifest,
  executorJob,
} = require('./platform-release-reconciler');

const directory = __dirname;
const revision = 'a'.repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;

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
  assert.equal(container.image, executorImage);
  assert.deepEqual(container.command, ['node', '/app/opensphere-console-backend/platform-release-executor.mjs']);
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(container.env.find((entry) => entry.name === 'EXPECTED_PREVIOUS_RELEASE_DIGEST').value, digest('a'));
  assert.ok(container.env.every((entry) => !/TOKEN/.test(entry.name) || entry.valueFrom));
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
  assert.match(server, /platformReleaseRuntimeStatus/);
  assert.match(server, /supportedChannels: \['edge'\]/);
  assert.match(deploy, /name: platform-release-reconciler/);
  assert.match(deploy, /name: platform-release-executor/);
  assert.match(deploy, /kind: ValidatingAdmissionPolicy[\s\S]*platform-release-executor-job-boundary/);
  assert.match(deploy, /kind: ValidatingAdmissionPolicy[\s\S]*platform-release-executor-pod-boundary/);
  assert.match(deploy, /system:serviceaccount:kube-system:job-controller/);
  assert.match(deploy, /object\.spec\.template\.spec\.containers\[0\]\.env\.map\(e, e\.name\)/);
  assert.match(deploy, /resources: \["jobs"\][\s\S]*verbs: \["get", "create"\]/);
  assert.match(dockerfile, /COPY --from=setup-cli src \/app\/opensphere-setup-cli\/src/);
  assert.match(dockerfile, /registry\.k8s\.io\/kubectl@sha256:/);
  assert.match(dockerfile, /gh_2\.96\.0_linux_\$\{TARGETARCH\}/);
  assert.match(migration, /'platform-release-reconciler'/);
  assert.match(ui, /local kubeconfig/);
  assert.match(ui, /\/api\/platform\/changes/);
  assert.match(ui, /previousReleaseDigest/);
  assert.match(ui, /다른 관리자의 교차 승인/);
  assert.match(ui, /this\.status\(\)\?\.execution\.ready/);
  assert.match(ui, /candidate·stable은 통합 복구 drill/);
});

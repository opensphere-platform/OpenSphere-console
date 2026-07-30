'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  COMPONENT_REPOSITORIES,
  REQUIRED_COMPONENTS,
  buildComponentReleaseLock,
  calculateReleaseDigest,
  validateReleaseLock,
  validateReleaseTransition,
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
  assert.match(server, /\/api\/platform\/releases\/component-target/);
  assert.match(server, /buildComponentReleaseLock/);
  assert.match(server, /validateReleaseTransition\(installed\.lock, desiredState\.targetLock\)/);
  assert.match(server, /requireRecentAal2\(actor, 'Platform Release request'\)/);
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
  assert.match(ui, /다른 관리자의 교차 승인/);
  assert.match(ui, /this\.status\(\)\?\.execution\.ready/);
  assert.match(ui, /candidate·stable은 통합 복구 drill/);
});

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
  platformReleaseApprovalPolicy,
  releaseSummary,
} = require('./platform-release-contract');
const {
  LEGACY_INSTALLED_AGENT_COMPONENTS,
  CANONICAL_AGENT_COMPONENTS,
} = require('./platform-release-agent-identity-cutover');
const executorImage = `ghcr.io/opensphere-platform/opensphere-console-backend@sha256:${'f'.repeat(64)}`;
process.env.EXECUTOR_IMAGE = executorImage;
const {
  validateGovernedManifest,
  executorJob,
} = require('./platform-release-reconciler');

const directory = __dirname;
const revision = 'a'.repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;

test('release Job admission applies only to the reserved executor service account', () => {
  const deploy = fs.readFileSync(path.join(directory, 'deploy.yaml'), 'utf8');
  const policyStart = deploy.indexOf('metadata: { name: platform-release-executor-job-boundary }');
  const bindingStart = deploy.indexOf(
    'kind: ValidatingAdmissionPolicyBinding',
    policyStart,
  );
  assert.ok(policyStart >= 0 && bindingStart > policyStart);
  const expression = deploy.slice(policyStart, bindingStart);

  assert.match(expression,
    /!has\(object\.spec\.template\.spec\.serviceAccountName\)\s*\|\|\s*object\.spec\.template\.spec\.serviceAccountName != 'platform-release-executor'/);
  assert.match(expression,
    /\|\| \(\s*request\.userInfo\.username == 'system:serviceaccount:opensphere-console:platform-release-reconciler'/);
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

function legacyInstalledReleaseLock() {
  const lock = releaseLock();
  const components = Object.fromEntries(Object.entries(lock.components)
    .filter(([name]) => !Object.hasOwn(CANONICAL_AGENT_COMPONENTS, name)));
  for (const [legacyName, repository] of Object.entries(LEGACY_INSTALLED_AGENT_COMPONENTS)) {
    const canonicalName = legacyName === 'oaaGateway' ? 'osaaGateway' : 'osaaGovernedAdapter';
    const source = lock.components[canonicalName];
    components[legacyName] = {
      ...source,
      repository,
      image: `ghcr.io/opensphere-platform/${repository}@${source.image.split('@')[1]}`,
    };
  }
  lock.components = components;
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

test('installed pre-OSAA lock can build only one complete canonical OSAA cutover target', () => {
  const base = legacyInstalledReleaseLock();
  assert.throws(() => validateReleaseLock(base), /component set/);
  assert.equal(releaseSummary(base, {
    allowInstalledAgentIdentityCutover: true,
  }).componentCount, REQUIRED_COMPONENTS.length);
  const target = buildComponentReleaseLock(base, {
    sourceRevision: 'b'.repeat(40),
    components: {
      osaaGateway: { image: digest('e') },
      osaaGovernedAdapter: { image: digest('f') },
    },
  }, new Date('2026-08-21T00:00:00.000Z'));

  assert.deepEqual(target.changedComponents, ['osaaGateway', 'osaaGovernedAdapter']);
  assert.equal(Object.keys(target.components).length, REQUIRED_COMPONENTS.length);
  assert.equal(Object.hasOwn(target.components, 'oaaGateway'), false);
  assert.equal(Object.hasOwn(target.components, 'oaaGovernedAdapter'), false);
  assert.equal(target.components.osaaGateway.repository, 'opensphere-console-osaa-gateway');
  assert.equal(target.components.osaaGovernedAdapter.repository, 'opensphere-osaa-governed-adapter');
  assert.equal(validateReleaseTransition(base, target), target);

  assert.throws(() => buildComponentReleaseLock(base, {
    sourceRevision: 'b'.repeat(40),
    components: { osaaGateway: { image: digest('e') } },
  }), /both canonical agent components/);

  assert.throws(() => buildComponentReleaseLock(base, {
    sourceRevision: 'b'.repeat(40),
    components: { oaaGateway: { image: digest('e') } },
  }), /unsupported fields/);

  const wrongRepository = legacyInstalledReleaseLock();
  wrongRepository.components.oaaGateway.repository = 'opensphere-console-osaa-gateway';
  wrongRepository.releaseDigest = calculateReleaseDigest(wrongRepository);
  assert.throws(
    () => buildComponentReleaseLock(wrongRepository, {
      sourceRevision: 'b'.repeat(40),
      components: {
        osaaGateway: { image: digest('e') },
        osaaGovernedAdapter: { image: digest('f') },
      },
    }),
    /canonical exact-digest image/,
  );

  assert.throws(() => validateReleaseTransition(base, releaseLock()), /one-way OSAA component transition/);
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

test('only localhost edge component apply uses the Docker Desktop automation boundary', () => {
  const base = releaseLock();
  const component = buildComponentReleaseLock(base, {
    sourceRevision: 'b'.repeat(40),
    components: { backend: { image: digest('f') } },
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
  const retryJob = executorJob({ ...work, attempt: 2 }, manifest);
  assert.equal(retryJob.metadata.name, `platform-release-${requestId}-a2`);
  assert.notEqual(retryJob.metadata.name, job.metadata.name);
  assert.equal(retryJob.metadata.labels['opensphere.io/request-id'], requestId);
  assert.ok(container.env.every((entry) => !/TOKEN/.test(entry.name) || entry.valueFrom));
});

test('Platform Release runtime is isolated from browser and local workstation execution', () => {
  const server = fs.readFileSync(path.join(directory, 'server.js'), 'utf8');
  const deploy = fs.readFileSync(path.join(directory, 'deploy.yaml'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(directory, 'Dockerfile'), 'utf8');
  const migration = fs.readFileSync(path.join(directory, '..', 'supabase', 'migrations', '0033_platform_release_consumer.sql'), 'utf8');
  const ui = fs.readFileSync(path.join(directory, '..', '..', 'src', 'app', 'pages', 'admin-platform-release.ts'), 'utf8');
  const deployer = fs.readFileSync(path.join(directory, '..', '..', 'scripts', 'Invoke-LocalEdgePlatformRelease.ps1'), 'utf8');

  assert.match(server, /validatePlatformReleaseDesiredState/);
  assert.match(server, /previousReleaseDigest !== installed\.summary\.releaseDigest/);
  assert.match(server, /\/api\/platform\/releases\/status/);
  assert.match(server, /\/api\/platform\/releases\/component-target/);
  assert.match(server, /buildComponentReleaseLock/);
  assert.match(server, /platform-release-component-target-generate[\s\S]*phase: 'intent'/);
  assert.doesNotMatch(server, /platform-release-component-target-generate[\s\S]*phase: 'planned'/);
  assert.match(server, /validateReleaseTransition\(installed\.lock, desiredState\.targetLock\)/);
  assert.match(server, /localEdgeAutomationRequest/);
  assert.match(server, /if \(!localEdgeAutomationRequest\) requireRecentAal2\(actor, 'Platform Release request'\)/);
  assert.match(server, /local edge automation can apply only a localhost edge component transition/);
  assert.match(server, /p_actor_type: actor\?\.actorType === 'service' \? 'service' : 'human'/);
  assert.match(server, /Object\.keys\(body\)\.some\(\(key\) => !\['reason', 'sourceRevision', 'components'\]\.includes\(key\)\)/);
  assert.match(server, /platformReleaseRuntimeStatus/);
  assert.match(server, /supportedChannels: \['edge'\]/);
  assert.match(server, /authorizeLocalEdgeComponentRelease/);
  assert.match(server, /platform-release-edge-automation/);
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
  assert.match(deployer, /OpenSphereEdgeComponentPublication/);
  assert.match(deployer, /create token opensphere-local-edge-release/);
  assert.match(deployer, /\/api\/platform\/releases\/local-edge-automation/);
  assert.match(deployer, /Properties\['release\.json'\]/);
  assert.doesNotMatch(deployer, /release-lock\.json/);
  assert.doesNotMatch(deployer, /kubectl\s+(?:apply|patch|set|replace|delete)/i);
  assert.doesNotMatch(deployer, /SkipCertificateCheck|--insecure|-k\b/);
  assert.match(dockerfile, /COPY --from=setup-cli src \/app\/opensphere-setup-cli\/src/);
  assert.match(dockerfile, /COPY opensphere-console-backend\/platform-release-agent-identity-cutover\.js/);
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
  assert.match(ui, /최고 관리자의 최근 MFA/);
  assert.match(ui, /ownerMfaTarget\(\): boolean/);
  assert.match(ui, /최고 관리자 MFA로 승인·병합/);
  assert.match(ui, /this\.status\(\)\?\.execution\.ready/);
  assert.match(ui, /component apply는 최고 관리자 MFA 정책/);
});

test('session preference release publishes only the Console and Backend component pair', () => {
  const publisher = fs.readFileSync(
    path.join(directory, '..', '..', 'scripts', 'Publish-LocalEdgeConsoleSession.ps1'),
    'utf8',
  );

  assert.match(publisher, /\[Parameter\(Mandatory\)\]\[string\]\$PreviousConsolePublicationEvidence/);
  assert.match(publisher, /\[Parameter\(Mandatory\)\]\[string\]\$PreviousBackendPublicationEvidence/);
  assert.match(publisher, /\[Parameter\(Mandatory\)\]\[string\]\$SetupSourcePath/);
  assert.match(publisher, /\$components = @\('backend', 'console'\)/);
  assert.match(publisher, /Components = @\('console', 'backend'\)/);
  assert.match(publisher, /branch --show-current[\s\S]*-ne 'main'/);
  assert.match(publisher, /rev-parse origin\/main[\s\S]*-ne \$SourceRevision/);
  assert.match(publisher, /SetupSourcePath must be the exact Backend setup-source\.lock revision/);
  assert.match(publisher, /merge-base --is-ancestor \$setupLock origin\/main/);
  assert.match(publisher, /SetupSourcePath = \$setupRoot/);
  assert.match(publisher, /src\/app\/core\/auth\.service\.ts/);
  assert.match(publisher, /backend\/opensphere-console-backend\/browser-session\.js/);
  assert.match(publisher, /Installation lock .* differs from supplied publication evidence/);
  assert.match(publisher, /must not change the Supabase migration lineage/);
  assert.match(publisher, /affectedImages = @\([\s\S]*opensphere-console[\s\S]*opensphere-console-backend/);
  assert.match(publisher, /releaseScope = 'component'/);
  assert.match(publisher, /fullReleaseJustification = \$null/);
  assert.match(publisher, /imagetools create --prefer-index=false --tag "\$registry\/opensphere-console:edge"/);
  assert.doesNotMatch(publisher, /kubectl\s+(?:apply|patch|set|replace|delete)/i);
  assert.doesNotMatch(publisher, /Components\s*=\s*@\('console',\s*'backend',/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createHash, createPublicKey, generateKeyPairSync, sign } = require('crypto');
const {
  COMPONENT_REPOSITORIES,
  REQUIRED_COMPONENTS,
  PFSS_COMPONENTS,
  buildComponentReleaseLock,
  calculateReleaseDigest,
  pfssOperationId,
  validatePfssPublicationSubmission,
  validateReleaseLock,
  validateReleaseTransition,
  validatePlatformReleaseDesiredState,
  platformReleaseApprovalPolicy,
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

function componentPublication() {
  return {
    contract: 'opensphere-edge-component-publication-binding/v1',
    publisher: 'scripts/Publish-LocalEdgeBackendComponent.ps1',
    publisherGitBlob: '1'.repeat(40),
    publisherSha256: digest('1'),
    documentSha256: digest('2'),
    signatureSha256: digest('3'),
    keyId: 'opensphere-edge-local-v1',
    setupSourceRevision: '4'.repeat(40),
    setupSourceLockSha256: digest('4'),
    setupManifestProjectionGitBlob: '5'.repeat(40),
    setupManifestProjectionSha256: digest('5'),
    migrationSetDigest: digest('6'),
    platformRevision: '7'.repeat(40),
    inventorySha256: digest('7'),
    verificationSetDigest: digest('8'),
  };
}

function pfssEvidence() {
  return {
    sourceRevision: 'b'.repeat(40),
    componentPublication: componentPublication(),
    components: {
      backend: { image: digest('e'), registryCredentialsRequired: false },
      oaaGateway: { image: digest('f'), registryCredentialsRequired: false },
    },
  };
}

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function signedPfssSubmission() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sourceRevision = 'b'.repeat(40);
  const components = {
    backend: `ghcr.io/opensphere-platform/opensphere-console-backend@${digest('e')}`,
    oaaGateway: `ghcr.io/opensphere-platform/opensphere-console-oaa-gateway@${digest('f')}`,
  };
  const document = JSON.stringify({
    apiVersion: 'release.opensphere.io/v1alpha1', kind: 'OpenSphereEdgeComponentPublication',
    publicationScope: 'ComponentSet', channel: 'edge', status: 'Active',
    source: 'https://github.com/opensphere-platform/OpenSphere-console', sourceRevision,
    releaseTag: '202608201200', immutableTag: '202608201200', buildAuthority: 'localhost',
    releaseClass: 'pre-ga', gaEligible: false, supportedPlatforms: ['linux/amd64'],
    components: {
      backend: { repository: 'opensphere-console-backend', image: components.backend, sourceRevision },
      oaaGateway: { repository: 'opensphere-console-oaa-gateway', image: components.oaaGateway, sourceRevision },
    },
    changedPaths: ['backend/opensphere-console-backend/server.js'],
    affectedImages: ['backend', 'oaaGateway'], releaseScope: 'component', fullReleaseJustification: null,
  });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const documentSha256 = sha256(document);
  const envelope = {
    contract: 'opensphere-edge-detached-signature/v1', algorithm: 'ES256-P1363',
    keyId: 'opensphere-edge-local-v1',
    trustReference: 'configmap://opensphere-console/dupa-trusted-keys#opensphere-edge-local-v1',
    documentSha256, publicKeySpkiSha256: sha256(spki),
    signature: sign('sha256', Buffer.from(document), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
    releaseClass: 'pre-ga', gaPromotionEligible: false,
  };
  const publicationSignature = JSON.stringify(envelope);
  const binding = componentPublication();
  binding.documentSha256 = documentSha256;
  binding.signatureSha256 = sha256(publicationSignature);
  binding.platformRevision = sourceRevision;
  return {
    sourceRevision, components, componentPublication: binding, publicationDocument: document,
    publicationSignature, trustedSpki: spki.toString('base64'),
  };
}

function loadPfssTrustedKeyFromServer(raw, filePath = '/var/run/opensphere-dupa-trusted-keys/trusted-keys.json') {
  const server = fs.readFileSync(path.join(directory, 'server.js'), 'utf8');
  const start = server.indexOf('const PFSS_COMPONENT_TRUSTED_KEYS_FILE');
  const end = server.indexOf('\nasync function executePfssLocalEdgePlatformRelease', start);
  assert.ok(start >= 0 && end > start, 'PFSS trusted-key loader must remain an isolated pre-write boundary');
  const context = {
    Buffer,
    Error,
    JSON,
    Object,
    Array,
    Set,
    String,
    createPublicKey,
    fs: { readFileSync: () => raw },
    process: { env: { PFSS_COMPONENT_TRUSTED_KEYS_FILE: filePath } },
  };
  vm.runInNewContext(`${server.slice(start, end)}; globalThis.result = loadPfssTrustedPublicKeySpki();`, context);
  return context.result;
}

function pfssTrustProjectionFromBackendDeployment(yaml) {
  const deployment = yaml.split(/^---$/m).find((document) => document.includes('kind: Deployment')
    && document.includes('name: opensphere-console-backend'));
  assert.ok(deployment, 'Console Backend Deployment is present');
  const lines = deployment.split(/\r?\n/);
  const between = (start, end) => {
    const from = lines.findIndex((line) => line.trim() === start);
    const to = lines.findIndex((line, index) => index > from && line.trim() === end);
    assert.ok(from >= 0 && to > from, `${start} section is structurally present`);
    return lines.slice(from + 1, to);
  };
  const mounts = [];
  let mount;
  for (const line of between('volumeMounts:', 'env:')) {
    const name = line.match(/^            - name: (\S+)$/);
    const field = line.match(/^              (mountPath|readOnly): (\S+)$/);
    if (name) { mount = { name: name[1] }; mounts.push(mount); }
    else if (field && mount) mount[field[1]] = field[2] === 'true' ? true : field[2] === 'false' ? false : field[2];
  }
  const volumes = [];
  let volume;
  for (const line of lines.slice(lines.findIndex((entry) => entry.trim() === 'volumes:') + 1)) {
    if (/^---$/.test(line)) break;
    const name = line.match(/^        - name: (\S+)$/);
    const configMap = line.match(/^            name: (\S+)$/);
    const item = line.match(/^              - \{ key: ([^,]+), path: ([^ }]+) \}$/);
    if (name) { volume = { name: name[1] }; volumes.push(volume); }
    else if (line.trim() === 'configMap:' && volume) volume.configMap = {};
    else if (configMap && volume?.configMap) volume.configMap.name = configMap[1];
    else if (item && volume?.configMap) {
      volume.configMap.items ||= [];
      volume.configMap.items.push({ key: item[1], path: item[2] });
    }
  }
  const env = lines.find((line) => line.includes('PFSS_COMPONENT_TRUSTED_KEYS_FILE'));
  const envPath = env?.match(/value: (\S+)\s*\}$/)?.[1];
  return {
    mounts: mounts.filter((entry) => entry.name.startsWith('pfss-')),
    volumes: volumes.filter((entry) => entry.name.startsWith('pfss-')),
    envPath,
  };
}

function validatePfssTrustProjection(projection) {
  assert.deepEqual(projection.mounts, [{
    name: 'pfss-dupa-trusted-keys',
    mountPath: '/var/run/opensphere-dupa-trusted-keys',
    readOnly: true,
  }], 'PFSS has exactly one read-only trusted-key mount');
  assert.deepEqual(projection.volumes, [{
    name: 'pfss-dupa-trusted-keys',
    configMap: {
      name: 'dupa-trusted-keys',
      items: [{ key: 'trusted-keys.json', path: 'trusted-keys.json' }],
    },
  }], 'PFSS has exactly one projected trusted-key ConfigMap item');
  assert.equal(projection.envPath, '/var/run/opensphere-dupa-trusted-keys/trusted-keys.json');
}

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
  const target = buildComponentReleaseLock(base, pfssEvidence(), new Date('2026-07-30T12:34:56.000Z'));
  assert.equal(target.releaseScope, 'component');
  assert.equal(target.baseReleaseDigest, base.releaseDigest);
  assert.deepEqual(target.changedComponents, PFSS_COMPONENTS);
  assert.equal(target.components.console.image, base.components.console.image);
  assert.equal(
    target.components.backend.image,
    `ghcr.io/opensphere-platform/opensphere-console-backend@${digest('e')}`,
  );
  assert.equal(target.components.backend.sourceRevision, 'b'.repeat(40));
  assert.equal(target.components.oaaGateway.sourceRevision, 'b'.repeat(40));
  assert.equal(target.componentPublication.documentSha256, digest('2'));
  assert.equal(target.resolvedAt, '2026-07-30T12:34:56.000Z');
  assert.equal(Object.keys(target.components).length, REQUIRED_COMPONENTS.length);
  assert.equal(validateReleaseTransition(base, target), target);
});

test('component target rejects stale bases, hidden changes and non-local promotion', () => {
  const base = releaseLock();
  const target = buildComponentReleaseLock(base, pfssEvidence());

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

  const missingOaa = pfssEvidence();
  delete missingOaa.components.oaaGateway;
  assert.throws(() => buildComponentReleaseLock(base, missingOaa), /exactly backend,oaaGateway/);

  const forgedBinding = pfssEvidence();
  forgedBinding.componentPublication.publisher = 'scripts/attacker.ps1';
  assert.throws(() => buildComponentReleaseLock(base, forgedBinding), /publication binding/);
});

test('generic local-edge component transitions remain valid without PFSS publication evidence', () => {
  const base = releaseLock();
  const target = buildComponentReleaseLock(base, {
    sourceRevision: 'b'.repeat(40),
    components: { console: { image: digest('e') } },
  });
  assert.deepEqual(target.changedComponents, ['console']);
  assert.equal(target.componentPublication, undefined);
  assert.equal(validateReleaseTransition(base, target), target);
});

test('PFSS admits only the original P-256 signed two-image publication and derives a durable operation id', () => {
  const submission = signedPfssSubmission();
  const admitted = validatePfssPublicationSubmission({
    sourceRevision: submission.sourceRevision,
    components: submission.components,
    componentPublication: submission.componentPublication,
    publicationDocument: submission.publicationDocument,
    publicationSignature: submission.publicationSignature,
  }, submission.trustedSpki);
  assert.equal(admitted.operationId, pfssOperationId(admitted.documentSha256));
  assert.equal(admitted.binding.documentSha256, submission.componentPublication.documentSha256);
  assert.equal(admitted.documentSha256, sha256(submission.publicationDocument));
});

test('PFSS rejects closed-schema, type, digest, and source substitutions before a governed write', () => {
  const original = signedPfssSubmission();
  const cases = [
    ['extra root field', (value) => { value.extra = true; }],
    ['missing component', (value) => { delete value.components.oaaGateway; }],
    ['component type', (value) => { value.components.backend = 7; }],
    ['publication digest substitution', (value) => { value.componentPublication.documentSha256 = digest('0'); }],
    ['publication source mismatch', (value) => { value.sourceRevision = 'c'.repeat(40); }],
    ['detached signature substitution', (value) => {
      const signature = JSON.parse(value.publicationSignature);
      signature.signature = signature.signature.slice(0, -1) + (signature.signature.endsWith('A') ? 'B' : 'A');
      value.publicationSignature = JSON.stringify(signature);
    }],
  ];
  for (const [name, mutate] of cases) {
    const value = {
      sourceRevision: original.sourceRevision,
      components: structuredClone(original.components),
      componentPublication: structuredClone(original.componentPublication),
      publicationDocument: original.publicationDocument,
      publicationSignature: original.publicationSignature,
    };
    mutate(value);
    let writes = 0;
    assert.throws(() => {
      validatePfssPublicationSubmission(value, original.trustedSpki);
      writes += 1; // The server calls governedChange only after this admission returns.
    }, Error, name);
    assert.equal(writes, 0, `${name} must reject before a governed write`);
  }
});

test('PFSS selects only one P-256 key from the mounted DUPA trusted-key document and fails closed', () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const valid = JSON.stringify({ trustedKeys: {
    'opensphere-plugins-v1': spki,
    'opensphere-edge-local-v1': spki,
  } });
  assert.equal(loadPfssTrustedKeyFromServer(valid), spki);
  assert.throws(
    () => loadPfssTrustedKeyFromServer(JSON.stringify({ trustedKeys: { 'opensphere-plugins-v1': spki } })),
    (error) => error.code === 503 && /unavailable/.test(error.message),
    'missing edge key maps to the PFSS endpoint\'s 503 fail-closed boundary',
  );
  assert.throws(() => loadPfssTrustedKeyFromServer(`{"trustedKeys":{"opensphere-edge-local-v1":"${spki}","opensphere-edge-local-v1":"${spki}"}}`), /duplicate key/);
  assert.throws(() => loadPfssTrustedKeyFromServer('{"trustedKeys":'), /invalid JSON|unavailable/);
  assert.throws(() => loadPfssTrustedKeyFromServer(JSON.stringify({ trustedKeys: { 'opensphere-edge-local-v1': spki }, extra: true })), /schema/);
  assert.throws(() => loadPfssTrustedKeyFromServer(valid, '/tmp/trusted-keys.json'), /path is not canonical/);
});

test('only localhost edge component apply uses the Docker Desktop automation boundary', () => {
  const base = releaseLock();
  const component = buildComponentReleaseLock(base, pfssEvidence());
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
  assert.match(server, /\['reason', 'sourceRevision', 'components'\]/);
  assert.match(server, /\/api\/platform\/releases\/local-edge-automation\/pfss/);
  assert.match(server, /validatePfssPublicationSubmission/);
  assert.match(server, /PFSS_COMPONENT_TRUSTED_KEYS_FILE/);
  assert.match(server, /loadPfssTrustedPublicKeySpki/);
  assert.match(server, /code: 503/);
  assert.doesNotMatch(server, /PFSS_COMPONENT_PUBLIC_KEY_SPKI_BASE64/);
  assert.match(server, /idempotencyKey: publication\.operationId/);
  assert.match(server, /platformReleaseRuntimeStatus/);
  assert.match(server, /supportedChannels: \['edge'\]/);
  assert.match(server, /authorizeLocalEdgeComponentRelease/);
  assert.match(server, /platform-release-edge-automation/);
  assert.match(server, /\/api\/platform\/releases\/local-edge-automation/);
  assert.match(server, /localEdgePlatformReleaseReceipt/);
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

test('PFSS workload trust projection rejects all five manifest mutations', () => {
  const deploy = fs.readFileSync(path.join(directory, 'deploy.yaml'), 'utf8');
  const projection = pfssTrustProjectionFromBackendDeployment(deploy);
  validatePfssTrustProjection(projection);
  const mutations = [
    ['wrong ConfigMap name', (value) => { value.volumes[0].configMap.name = 'wrong-trusted-keys'; }],
    ['wrong ConfigMap key', (value) => { value.volumes[0].configMap.items[0].key = 'wrong-keys.json'; }],
    ['wrong mount path', (value) => { value.mounts[0].mountPath = '/tmp/trusted-keys'; }],
    ['writable mount', (value) => { value.mounts[0].readOnly = false; }],
    ['extra PFSS volume and mount', (value) => {
      value.mounts.push(structuredClone(value.mounts[0]));
      value.volumes.push(structuredClone(value.volumes[0]));
    }],
  ];
  for (const [name, mutate] of mutations) {
    const candidate = structuredClone(projection);
    mutate(candidate);
    assert.throws(() => validatePfssTrustProjection(candidate), assert.AssertionError, name);
  }
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

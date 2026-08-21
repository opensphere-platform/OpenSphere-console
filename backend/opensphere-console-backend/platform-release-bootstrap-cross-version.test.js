'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  BACKEND_BOOTSTRAP_CONTRACT,
  COMPONENT_REPOSITORIES,
  REQUIRED_COMPONENTS,
  backendComponentPublicationBinding,
  bootstrapEvidenceHashes,
  buildComponentReleaseLock,
  calculateReleaseDigest,
  canonicalJson,
  validateBackendBootstrapAPublication,
  validateBackendBootstrapEvidence,
  validateReleaseLock,
} = require('./platform-release-contract');
const { verifyEdgeSignedDocument } = require('./foundation-owner-release');

const digest = (character) => `sha256:${character.repeat(64)}`;
const OLD_REVISION = '1'.repeat(40);
const A_REVISION = '2'.repeat(40);
const B_REVISION = '3'.repeat(40);
const A_IMAGE = `ghcr.io/opensphere-platform/opensphere-console-backend@${digest('a')}`;
const B_IMAGE = `ghcr.io/opensphere-platform/opensphere-console-backend@${digest('b')}`;
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const MERGE_REVISION = '4'.repeat(40);

function integratedBaseLock() {
  const hexadecimal = '0123456789abc';
  const lock = {
    apiVersion: 'release.opensphere.io/v1alpha1',
    kind: 'OpenSphereReleaseLock',
    channel: 'edge',
    releaseDigest: '',
    resolvedAt: '2026-08-15T00:00:00.000Z',
    source: 'https://github.com/opensphere-platform/OpenSphere-console',
    sourceRevision: OLD_REVISION,
    trust: {
      type: 'localhost-edge/v1',
      repository: 'opensphere-platform/OpenSphere-console',
      publisher: 'scripts/Publish-LocalEdge.ps1',
      buildAuthority: 'localhost',
      releaseClass: 'pre-ga',
      gaEligible: false,
    },
    components: Object.fromEntries(REQUIRED_COMPONENTS.map((name, index) => [name, {
      repository: COMPONENT_REPOSITORIES[name],
      image: `ghcr.io/opensphere-platform/${COMPONENT_REPOSITORIES[name]}@${digest(hexadecimal[index])}`,
      sourceRevision: OLD_REVISION,
      registryCredentialsRequired: false,
    }])),
  };
  lock.releaseDigest = calculateReleaseDigest(lock);
  return lock;
}

function unsignedBootstrapALock(base) {
  const lock = structuredClone(base);
  lock.sourceRevision = A_REVISION;
  lock.releaseScope = 'component';
  lock.baseReleaseDigest = base.releaseDigest;
  lock.changedComponents = ['backend'];
  lock.components.backend = {
    repository: 'opensphere-console-backend',
    image: A_IMAGE,
    sourceRevision: A_REVISION,
    registryCredentialsRequired: false,
  };
  lock.releaseDigest = calculateReleaseDigest(lock);
  return lock;
}

class OldExactRequestLedger {
  constructor(targetLock) {
    this.targetLock = targetLock;
    this.persisted = null;
    this.mutationCount = 0;
  }

  submit(body, { loseResponse = false } = {}) {
    assert.deepEqual(Object.keys(body).sort(), ['components', 'reason', 'sourceRevision']);
    assert.equal(body.sourceRevision, A_REVISION);
    assert.equal(body.components.backend.image, A_IMAGE);
    if (!this.persisted) {
      this.mutationCount += 1;
      this.persisted = {
        requestId: REQUEST_ID,
        targetReleaseDigest: this.targetLock.releaseDigest,
        changedComponents: ['backend'],
      };
    }
    if (loseResponse) throw new Error('simulated response loss after durable old-server intent');
    return { ...this.persisted, duplicate: this.mutationCount === 1 };
  }
}

function bootstrapAProof(aLock) {
  const governedDocument = {
    apiVersion: 'platform.opensphere.io/v1alpha1',
    kind: 'GovernedChange',
    metadata: { requestId: REQUEST_ID, consumerId: 'platform-release' },
    spec: {
      action: 'apply',
      target: 'opensphere-platform',
      desiredState: {
        contract: 'opensphere.platform.release/v1',
        previousReleaseDigest: aLock.baseReleaseDigest,
        targetLock: aLock,
      },
    },
  };
  const receipt = {
    operationId: `${REQUEST_ID}:${MERGE_REVISION}:1`,
    desiredRevision: MERGE_REVISION,
    appliedRevision: A_REVISION,
    succeeded: true,
    result: 'signed Platform Release applied and verified',
    evidence: {
      stage: 'observed',
      previousReleaseDigest: aLock.baseReleaseDigest,
      installedReleaseDigest: aLock.releaseDigest,
      sourceRevision: A_REVISION,
    },
  };
  const hashes = bootstrapEvidenceHashes({
    requestId: REQUEST_ID,
    mergeRevision: MERGE_REVISION,
    governedDocument,
    receipt,
  });
  const bootstrapFrom = {
    contract: BACKEND_BOOTSTRAP_CONTRACT,
    requestId: REQUEST_ID,
    releaseDigest: aLock.releaseDigest,
    sourceRevision: A_REVISION,
    image: A_IMAGE,
    mergeRevision: MERGE_REVISION,
    receiptOperationId: receipt.operationId,
    handoffState: 'BootstrapApplied',
    convergenceState: 'PendingConvergence',
    foundationFeatureGate: 'Closed',
    trustConfigUid: '11111111-2222-4333-8444-555555555555',
    trustConfigResourceVersion: '12345',
    trustKeySpkiSha256: digest('9'),
    ...hashes,
  };
  validateBackendBootstrapEvidence(bootstrapFrom, {
    installedLock: aLock,
    governedDocument,
    mergeRevision: MERGE_REVISION,
    receipt,
  });
  return { bootstrapFrom, governedDocument, receipt };
}

function signedBPublication(bootstrapFrom) {
  const publication = {
    apiVersion: 'release.opensphere.io/v1alpha1',
    kind: 'OpenSphereEdgeComponentPublication',
    publicationScope: 'ComponentSet',
    channel: 'edge', status: 'Active', releaseTag: '202608151500',
    immutableTag: `local-${B_REVISION.slice(0, 12)}`,
    source: 'https://github.com/opensphere-platform/OpenSphere-console', sourceRevision: B_REVISION,
    buildAuthority: 'localhost', releaseClass: 'pre-ga', gaEligible: false,
    supportedPlatforms: ['linux/amd64'], requestIntent: 'converge signed Backend bootstrap B',
    changedPaths: ['backend/opensphere-console-backend/server.js'], affectedImages: ['backend'],
    releaseScope: 'component', fullReleaseJustification: null,
    previous: { image: A_IMAGE, sourceRevision: A_REVISION, setupSourceRevision: '5'.repeat(40) },
    setupSource: {
      repository: 'https://github.com/opensphere-platform/OpenSphere-Setup-CLI.git',
      sourceRevision: '6'.repeat(40), changedPaths: ['src/bootstrap.mjs'], lockSha256: digest('6'),
      manifestProjectionTool: { path: 'src/platform-release-bootstrap-manifest.mjs',
        gitBlob: '6'.repeat(40), sha256: digest('6') },
    },
    platformAuthority: {
      repository: 'https://github.com/opensphere-platform/OpenSphere-Platform-V2.git',
      sourceRevision: '7'.repeat(40),
      inventory: { path: 'repository-inventory.json', gitBlob: '8'.repeat(40), sha256: digest('8') },
    },
    verification: {
      contract: 'opensphere-backend-component-verification-set/v1', setDigest: '',
      results: [
        'console-full-test', 'console-test', 'fresh-ledger-verifier',
        'rendered-manifest-client-dry-run', 'rendered-manifest-server-dry-run',
        'setup-full-test', 'setup-test',
      ].map((id) => ({
        id, result: 'PASS', artifactUri: `evidence://${id}.log`, artifactSha256: digest('c'),
        startedAt: '2026-08-15T05:00:00.000Z', completedAt: '2026-08-15T05:01:00.000Z',
      })),
      renderedManifest: { artifactUri: 'evidence://backend-deploy.yaml', sha256: digest('d') },
    },
    artifacts: { supabaseMigrationManifest: {
      path: 'backend/supabase/migrations/manifest.json', sha256: digest('e'), setDigest: digest('f'),
      latestMigrationId: '0063', migrationCount: 63,
    } },
    components: { backend: { image: B_IMAGE, sourceRevision: B_REVISION, registryCredentialsRequired: false } },
    tooling: Object.fromEntries(Object.entries({
      publisher: 'scripts/Publish-LocalEdgeBackendComponent.ps1',
      deployer: 'scripts/Invoke-LocalEdgePlatformRelease.ps1',
      signingHelper: 'scripts/os-shell-edge-signing.ps1',
      initializer: 'scripts/Initialize-FoundationOwnerInstallationLock.ps1',
    }).map(([name, toolPath]) => [name, { path: toolPath, gitBlob: 'a'.repeat(40), sha256: digest('a') }])),
    bootstrapFrom,
    generatedAt: '2026-08-15T05:02:00.000Z',
  };
  publication.verification.setDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    contract: publication.verification.contract,
    results: publication.verification.results,
    renderedManifest: publication.verification.renderedManifest,
  })).digest('hex')}`;
  const bytes = Buffer.from(JSON.stringify(publication));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const envelope = {
    contract: 'opensphere-edge-detached-signature/v1', algorithm: 'ES256-P1363',
    keyId: 'opensphere-edge-local-v1',
    trustReference: 'configmap://opensphere-console/dupa-trusted-keys#opensphere-edge-local-v1',
    documentSha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    publicKeySpkiSha256: `sha256:${crypto.createHash('sha256').update(spki).digest('hex')}`,
    releaseClass: 'pre-ga', gaPromotionEligible: false,
    signature: crypto.sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
  };
  const verified = verifyEdgeSignedDocument({
    publicationDocumentBase64: bytes.toString('base64'),
    publicationSignature: envelope,
    trustedPublicKeySpkiBase64: spki.toString('base64'),
  });
  return { publication, verified };
}

function bootstrapAPublication() {
  const publication = signedBPublication(null).publication;
  publication.kind = 'OpenSphereBackendComponentBootstrapAPublication';
  publication.contract = 'opensphere-backend-component-bootstrap-a-publication/v1';
  publication.bootstrapPhase = 'A';
  delete publication.bootstrapFrom;
  publication.sourceRevision = A_REVISION;
  publication.immutableTag = `local-${A_REVISION.slice(0, 12)}`;
  publication.requestIntent = 'provision the governed Bootstrap A TLS bridge';
  publication.changedPaths = [
    'backend/opensphere-console-backend/platform-release-contract.js',
    'backend/opensphere-console-backend/platform-release-tls-initializer.mjs',
  ];
  publication.previous = {
    image: `ghcr.io/opensphere-platform/opensphere-console-backend@${digest('0')}`,
    sourceRevision: OLD_REVISION,
    setupSourceRevision: '5'.repeat(40),
  };
  publication.components.backend = {
    image: A_IMAGE, sourceRevision: A_REVISION, registryCredentialsRequired: false,
  };
  publication.artifacts.supabaseMigrationManifest.latestMigrationId = '0062';
  publication.artifacts.supabaseMigrationManifest.migrationCount = 62;
  publication.verification.results.push({
    id: 'bootstrap-a-invoke-fixture', result: 'PASS',
    artifactUri: 'evidence://bootstrap-a-invoke-fixture.log', artifactSha256: digest('c'),
    startedAt: '2026-08-15T05:00:00.000Z', completedAt: '2026-08-15T05:01:00.000Z',
  });
  publication.verification.results.sort((left, right) => left.id.localeCompare(right.id));
  publication.verification.setDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    contract: publication.verification.contract,
    results: publication.verification.results,
    renderedManifest: publication.verification.renderedManifest,
  })).digest('hex')}`;
  publication.tooling.bootstrapAValidator = {
    path: 'backend/opensphere-console-backend/platform-release-contract.js',
    gitBlob: 'b'.repeat(40), sha256: digest('b'),
  };
  return publication;
}

test('old exact request response loss recovers one A intent, then signed A to B converges across Setup versions', async () => {
  const base = integratedBaseLock();
  const aLock = unsignedBootstrapALock(base);
  assert.throws(() => validateReleaseLock(aLock), /signed component publication/);
  assert.equal(validateReleaseLock(aLock, { allowUnsignedComponentBootstrapBase: true }), aLock);

  const ledger = new OldExactRequestLedger(aLock);
  const oldRequest = { reason: 'install compatibility bootstrap A', sourceRevision: A_REVISION,
    components: { backend: { image: A_IMAGE } } };
  assert.throws(() => ledger.submit(oldRequest, { loseResponse: true }), /response loss/);
  const recovered = ledger.submit(structuredClone(oldRequest));
  assert.equal(recovered.requestId, REQUEST_ID);
  assert.equal(recovered.targetReleaseDigest, aLock.releaseDigest);
  assert.equal(ledger.mutationCount, 1);

  const { bootstrapFrom, governedDocument, receipt } = bootstrapAProof(aLock);
  const bootstrapFromKeys = [
    'contract', 'requestId', 'releaseDigest', 'sourceRevision', 'image', 'mergeRevision',
    'receiptOperationId', 'governedDocumentSha256', 'receiptSha256', 'handoffState',
    'convergenceState', 'foundationFeatureGate', 'trustConfigUid',
    'trustConfigResourceVersion', 'trustKeySpkiSha256',
  ];
  assert.equal(Object.keys(bootstrapFrom).length, 15);
  assert.deepEqual(Object.keys(bootstrapFrom).sort(), bootstrapFromKeys.sort());
  assert.throws(() => validateBackendBootstrapEvidence({ ...bootstrapFrom, unexpected: true }, {
    installedLock: aLock, governedDocument, mergeRevision: MERGE_REVISION, receipt,
  }), /unsupported fields/);
  const missingContract = structuredClone(bootstrapFrom);
  delete missingContract.contract;
  assert.throws(() => validateBackendBootstrapEvidence(missingContract, {
    installedLock: aLock, governedDocument, mergeRevision: MERGE_REVISION, receipt,
  }), /invalid/);
  assert.equal(bootstrapFrom.convergenceState, 'PendingConvergence');
  assert.equal(bootstrapFrom.foundationFeatureGate, 'Closed');
  const { publication, verified } = signedBPublication(bootstrapFrom);
  const binding = backendComponentPublicationBinding(publication, verified);
  const bLock = buildComponentReleaseLock(aLock, {
    sourceRevision: B_REVISION,
    components: { backend: { image: B_IMAGE, registryCredentialsRequired: false } },
    componentPublication: binding,
  });
  assert.notEqual(A_REVISION, B_REVISION);
  assert.notEqual(A_IMAGE, B_IMAGE);
  assert.equal(bLock.baseReleaseDigest, aLock.releaseDigest);
  assert.equal(bLock.componentPublication.bootstrapFrom.receiptSha256, bootstrapFrom.receiptSha256);
  assert.equal(validateReleaseLock(bLock), bLock);

  const setup = await import(pathToFileURL(path.resolve(
    __dirname, '../../../OpenSphere-Setup-CLI/src/release.mjs',
  )).href);
  assert.throws(() => setup.validateLock(aLock), /signed component publication/);
  assert.equal(setup.validateLock(aLock, { allowUnsignedComponentBootstrapBase: true }), aLock);
  assert.equal(setup.validateLock(bLock), bLock);
  assert.equal(setup.validateReleaseTransition(aLock, bLock), bLock);
});

test('Bootstrap A signed publication is closed over its versioned validator and nested evidence', () => {
  const publication = bootstrapAPublication();
  assert.equal(validateBackendBootstrapAPublication(publication), publication);

  const missingValidator = structuredClone(publication);
  delete missingValidator.tooling.bootstrapAValidator;
  assert.throws(() => validateBackendBootstrapAPublication(missingValidator), /tooling bootstrapAValidator/);

  const substitutedValidator = structuredClone(publication);
  substitutedValidator.tooling.bootstrapAValidator.path = 'scripts/Invoke-LocalEdgePlatformRelease.ps1';
  assert.throws(() => validateBackendBootstrapAPublication(substitutedValidator), /bootstrapAValidator is invalid/);

  const hiddenPreviousField = structuredClone(publication);
  hiddenPreviousField.previous.unreviewed = true;
  assert.throws(() => validateBackendBootstrapAPublication(hiddenPreviousField), /unsupported fields/);

  const outsideClosure = structuredClone(publication);
  outsideClosure.changedPaths.push('frontend/src/App.tsx');
  outsideClosure.changedPaths.sort();
  assert.throws(() => validateBackendBootstrapAPublication(outsideClosure), /outside the canonical/);

  const missingVerification = structuredClone(publication);
  missingVerification.verification.results.pop();
  assert.throws(() => validateBackendBootstrapAPublication(missingVerification), /outside the canonical/);

  const genericBWithBootstrapValidator = signedBPublication(bootstrapAProof(unsignedBootstrapALock(
    integratedBaseLock(),
  )).bootstrapFrom).publication;
  genericBWithBootstrapValidator.tooling.bootstrapAValidator = publication.tooling.bootstrapAValidator;
  assert.throws(() => backendComponentPublicationBinding(genericBWithBootstrapValidator, {
    documentSha256: digest('1'), signatureSha256: digest('2'), keyId: 'opensphere-edge-local-v1',
  }), /unsupported fields/);
});

test('B host crash and response loss resume only the same signed target until final receipt', () => {
  const durable = { requestId: REQUEST_ID, targetReleaseDigest: digest('e'), phase: 'Applying', submits: 1 };
  const afterResponseLoss = structuredClone(durable);
  assert.equal(afterResponseLoss.submits, 1);
  afterResponseLoss.phase = 'NeedsAttention';
  afterResponseLoss.lastError = 'host stopped before terminal receipt';
  const resumed = structuredClone(afterResponseLoss);
  resumed.phase = 'Completed';
  resumed.finalReceipt = {
    succeeded: true,
    targetReleaseDigest: resumed.targetReleaseDigest,
    bootstrapConvergence: {
      handoffState: 'BootstrapApplied', convergenceState: 'Converged',
      foundationFeatureGate: 'Open', bootstrapRequestId: REQUEST_ID,
    },
  };
  assert.equal(resumed.requestId, durable.requestId);
  assert.equal(resumed.targetReleaseDigest, durable.targetReleaseDigest);
  assert.equal(resumed.submits, 1);
  assert.equal(resumed.finalReceipt.bootstrapConvergence.convergenceState, 'Converged');
  assert.equal(resumed.finalReceipt.bootstrapConvergence.foundationFeatureGate, 'Open');
  assert.notEqual(canonicalJson(resumed), canonicalJson(afterResponseLoss));
});

test('A server legacy shape is recovery-only and never classifies the handoff as overall convergence', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const executor = fs.readFileSync(path.join(__dirname, 'platform-release-executor.mjs'), 'utf8');
  const deployer = fs.readFileSync(path.resolve(__dirname, '../../scripts/Invoke-LocalEdgePlatformRelease.ps1'), 'utf8');
  const recoveryStart = server.indexOf('async function recoverLegacyBackendBootstrapA');
  const recoveryEnd = server.indexOf('async function verifyInstalledBackendBootstrapA');
  const recovery = server.slice(recoveryStart, recoveryEnd);
  assert.ok(recoveryStart > 0 && recoveryEnd > recoveryStart);
  assert.match(server, /if \(keys === legacyBootstrapAKeys\) \{\s*return recoverLegacyBackendBootstrapA/);
  assert.match(recovery, /recoveryOnly: true/);
  assert.doesNotMatch(recovery, /governedChange\(/);
  assert.match(server, /phase: bootstrapFrom \? 'BootstrapApplied' : governedPhase/);
  assert.match(server, /overallPhase: bootstrapFrom \? 'PendingConvergence' : governedPhase/);
  assert.match(server, /foundationFeatureGate: bootstrapFrom \? 'Closed' : null/);
  assert.match(server, /first signed Backend release requires an exact bootstrapFrom proof/);
  assert.match(server, /await assertBackendBootstrapConvergedForFoundation\(installed\.lock\)/);
  assert.match(server, /feature gate remains closed until the signed Backend B final receipt/);
  assert.match(executor, /convergenceState: 'Converged'/);
  assert.match(executor, /foundationFeatureGate: 'Open'/);
  assert.match(executor, /convergenceState: 'Failed'/);
  assert.match(executor, /foundationFeatureGate: 'Closed'/);
  assert.match(server, /installedSignedRecovery = await recoverInstalledSignedBackendRelease/);
  assert.match(server, /bootstrapFrom replay differs from the installed signed Backend release/);
  assert.match(server, /async function recordBootstrapALegacyReceipt/);
  assert.match(server, /legacyTransportUsed: true/);
  assert.match(server, /Backend bootstrap A terminal receipt conflicts with its durable receipt/);
  assert.match(server, /currentResourceVersion: trust\.current\.resourceVersion/);
  assert.match(server, /trustConfigUid: trust\.observation\.configMapUid/);
  assert.match(server, /trustConfigResourceVersion: trust\.observation\.configMapResourceVersion/);
  assert.match(server, /if \(isInternalReleaseReconciler\([\s\S]+?res\.writeHead\(404/);
  assert.match(server, /if \(requestPath === '\/api\/platform\/reconcile\/manifest'\)/);
  assert.match(deployer, /retry the identical bytes/);
  assert.match(deployer, /\[bootstrap-a-trust:/);
  assert.match(deployer, /RequestPending state is not the signed exact old 3-key request/);
  assert.match(deployer, /Exact signed Platform Release request response was not recovered/);
  assert.match(deployer, /\[Math\]::Min\(600,\$TimeoutSeconds\)/);
});

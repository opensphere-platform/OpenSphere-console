'use strict';

const { createHash } = require('crypto');
const path = require('path');

const REPOSITORIES = Object.freeze({
  console: Object.freeze({ url: 'https://gitea.opensphere.local/opensphere/OpenSphere-console.git', allowedPaths: ['backend/', 'src/', 'nginx/', 'docs/'], components: ['console', 'consoleBackend', 'oaaGateway'] }),
  setup: Object.freeze({ url: 'https://gitea.opensphere.local/opensphere/OpenSphere-Setup-CLI.git', allowedPaths: ['src/', 'deploy/', 'tests/', 'docs/'], components: ['setup'] }),
  clusterManager: Object.freeze({ url: 'https://gitea.opensphere.local/opensphere/OpenSphere-shell-clusterManager.git', allowedPaths: ['src/', 'backend/', 'tests/'], components: ['clusterManager'] }),
  foundation: Object.freeze({ url: 'https://gitea.opensphere.local/opensphere/OpenSphere-shell-foundation.git', allowedPaths: ['src/', 'backend/', 'tests/'], components: ['foundation'] }),
});
const TEST_COMMANDS = Object.freeze(new Set(['unit', 'contract', 'integration', 'security', 'migration', 'ui-e2e', 'supply-chain']));
const STAGES = Object.freeze(['proposed','awaiting_approval','approved','sandboxed','patched','testing','test_failed','ready_to_commit','committed','building','build_failed','built','awaiting_deploy_approval','deploying','verifying','inconclusive','succeeded','rolling_back','rolled_back','failed','cancelled']);
const APPROVAL_SCOPES = Object.freeze(['source_patch', 'deployment']);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
function digest(value) { return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`; }
function patchTextDigest(value) { return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`; }

function assertSha(value, field = 'revision') { if (!/^[0-9a-f]{40}$/.test(String(value || ''))) throw new Error(`${field} must be an exact 40-character revision`); }
function assertDigest(value, field = 'digest') { if (!/^sha256:[0-9a-f]{64}$/.test(String(value || ''))) throw new Error(`${field} must be exact`); }

function normalizedRelativePath(value) {
  const candidate = String(value || '').replace(/\\/g, '/');
  if (!candidate || candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate) || candidate.includes('\0')) throw new Error('path must be repository-relative');
  const normalized = path.posix.normalize(candidate);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('path escapes repository');
  return normalized;
}

function assessRemediation(mismatch, attempts) {
  if (!mismatch || mismatch.epistemicState !== 'known') return { minimumLadderStep: 0, engineeringRequired: false, blocked: true, reason: 'fresh-known evidence required' };
  const ordered = [...(attempts || [])].sort((a, b) => a.step - b.step);
  for (let step = 0; step <= 4; step += 1) {
    const attempt = ordered.find((item) => item.step === step);
    if (!attempt || attempt.status !== 'exhausted' || !attempt.evidenceDigest) return { minimumLadderStep: step, engineeringRequired: false, blocked: true, reason: `ladder step ${step} not conclusively exhausted` };
  }
  return { minimumLadderStep: 5, engineeringRequired: true, blocked: false, reason: 'lower recovery ladder is evidence-bound and exhausted', evidenceDigest: digest({ mismatch, attempts: ordered }) };
}

function approvalBinding(envelope) {
  return digest({
    remediationRequestId: envelope.remediationRequestId, incidentId: envelope.incidentId,
    repository: envelope.repository, baseRevision: envelope.baseRevision, allowedPaths: envelope.allowedPaths,
    patchDigest: envelope.patchDigest, reason: envelope.reason, riskLevel: envelope.riskLevel, affectedComponents: envelope.affectedComponents,
    affectedImages: envelope.affectedImages, requiredTests: envelope.requiredTests, releaseScope: envelope.releaseScope,
    fullReleaseJustification: envelope.fullReleaseJustification || null,
    targetChannel: envelope.targetChannel, buildAuthority: envelope.buildAuthority,
    rollbackRevision: envelope.rollbackRevision, rollbackImageDigests: envelope.rollbackImageDigests,
    approvalExpiresAt: envelope.approvalExpiresAt,
  });
}

function validateEnvelope(input, policy = REPOSITORIES) {
  const repository = policy[input.repositoryId];
  if (!repository || input.repository !== repository.url) throw new Error('repository is not canonical or allowlisted');
  assertSha(input.baseRevision, 'baseRevision'); assertSha(input.rollbackRevision, 'rollbackRevision'); assertDigest(input.patchDigest, 'patchDigest');
  const allowedPaths = [...new Set((input.allowedPaths || []).map(normalizedRelativePath))];
  if (!allowedPaths.length || allowedPaths.some((candidate) => !repository.allowedPaths.some((prefix) => candidate.startsWith(prefix)))) throw new Error('allowed path is outside repository policy');
  const requiredTests = [...new Set(input.requiredTests || [])];
  if (!requiredTests.length || requiredTests.some((item) => !TEST_COMMANDS.has(item))) throw new Error('required test is not a registered command');
  const reason = String(input.reason || '').trim();
  if (reason.length < 8 || reason.length > 2000) throw new Error('engineering remediation reason must be 8 to 2000 characters');
  if (!['R2', 'R3'].includes(input.riskLevel)) throw new Error('engineering remediation must be R2 or R3');
  if (!['component', 'integrated'].includes(input.releaseScope)) throw new Error('releaseScope must be component or integrated');
  if (!['edge', 'candidate', 'stable', 'ga'].includes(input.targetChannel)) throw new Error('target channel is not governed');
  if (input.targetChannel === 'edge' && input.buildAuthority !== 'localhost') throw new Error('edge build authority must be localhost');
  if (['candidate','stable','ga'].includes(input.targetChannel) && input.buildAuthority !== 'github-actions') throw new Error('promoted channel build authority must be github-actions');
  if (input.releaseScope === 'integrated' && String(input.fullReleaseJustification || '').trim().length < 20) throw new Error('integrated release requires technical justification');
  const affectedComponents = [...new Set(input.affectedComponents || [])];
  if (!affectedComponents.length || affectedComponents.some((item) => !repository.components.includes(item))) throw new Error('affected component is outside repository policy');
  const affectedImages = [...new Set(input.affectedImages || [])];
  if (!affectedImages.length || affectedImages.some((item) => !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(String(item)))) throw new Error('affected image must use a canonical image id');
  const rollbackImageDigests = [...new Set(input.rollbackImageDigests || [])];
  if (!rollbackImageDigests.length) throw new Error('at least one exact rollback image digest is required');
  for (const item of rollbackImageDigests) assertDigest(item, 'rollbackImageDigest');
  const expires = Date.parse(input.approvalExpiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('approvalExpiresAt must be a future timestamp');
  const envelope = { ...input, reason, allowedPaths, requiredTests, affectedComponents, affectedImages, rollbackImageDigests };
  envelope.approvalBindingDigest = approvalBinding(envelope);
  return envelope;
}

function approvalStillValid(current, approved) {
  if (!approved || Date.parse(approved.approvalExpiresAt) <= Date.now()) return false;
  return approvalBinding(current) === approved.approvalBindingDigest;
}

function sandboxSpec(envelope, root) {
  const sandboxRoot = path.resolve(root, envelope.remediationRequestId);
  return Object.freeze({
    root: sandboxRoot, repository: envelope.repository, revision: envelope.baseRevision,
    network: 'none', credentials: [], readOnlySource: false, ephemeral: true,
    writablePaths: envelope.allowedPaths.map(normalizedRelativePath),
    commands: envelope.requiredTests.map((id) => ({ id, arguments: [], shell: false })),
  });
}

function validatePatchFiles(files, envelope) {
  const normalized = [...new Set(files.map(normalizedRelativePath))];
  if (normalized.some((file) => !envelope.allowedPaths.some((allowed) => file === allowed || file.startsWith(allowed.endsWith('/') ? allowed : `${allowed}/`)))) throw new Error('patch contains a path outside approval');
  return normalized;
}

function validatePatchArtifact(patchText, envelope) {
  const text = String(patchText || '').replace(/\r\n/g, '\n');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 1 || bytes > 262144 || text.includes('\0')) throw new Error('patch artifact must be 1 to 262144 UTF-8 bytes');
  const forbidden = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/i,
    /\b(?:ghp|github_pat|glpat)-?_[A-Za-z0-9_-]{16,}\b/i,
    /\b(?:password|passwd|api[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?[^\s'"$<{]{8,}/i,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) throw new Error('patch artifact contains credential-like material');
  const files = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\t\s]+)(?:\t.*)?$/);
    if (match && match[1] !== '/dev/null') files.push(match[1]);
  }
  const changedFiles = validatePatchFiles(files, envelope);
  if (!changedFiles.length) throw new Error('patch artifact has no allowlisted changed file');
  const patchDigest = patchTextDigest(text);
  if (patchDigest !== envelope.patchDigest) throw new Error('patch artifact digest differs from approval');
  return { patchText: text, patchDigest, byteLength: bytes, changedFiles, evidenceDigest: digest({ patchDigest, byteLength: bytes, changedFiles }) };
}

function validateBuildEvidence(envelope, evidence) {
  assertSha(evidence.sourceRevision, 'sourceRevision');
  for (const field of ['patchDigest','sbomDigest','provenanceDigest','signatureDigest','releaseLockDigest']) assertDigest(evidence[field], field);
  if (evidence.patchDigest !== envelope.patchDigest) throw new Error('built patch differs from approved patch');
  if (evidence.buildAuthority !== envelope.buildAuthority) throw new Error('build authority differs from approval');
  for (const image of evidence.imageDigests || []) assertDigest(image, 'imageDigest');
  if (!(evidence.imageDigests || []).length) throw new Error('exact image digest evidence required');
  const passed = new Set((evidence.tests || []).filter((item) => item.status === 'passed').map((item) => item.id));
  if (envelope.requiredTests.some((id) => !passed.has(id))) throw new Error('required tests are incomplete');
  return { valid: true, evidenceDigest: digest(evidence) };
}

function verifyDeployment(envelope, build, observed) {
  const expected = [...build.imageDigests].sort(); const actual = [...(observed.imageDigests || [])].sort();
  const exact = JSON.stringify(expected) === JSON.stringify(actual);
  const exactLock = observed.lockDigest === build.releaseLockDigest;
  const postconditions = observed.api?.passed === true && observed.ui?.passed === true;
  return { status: exact && exactLock && postconditions ? 'succeeded' : (observed.authorityFresh === false ? 'inconclusive' : 'failed'), exactDigest: exact, exactLock, postconditions, rollbackRequired: !(exact && exactLock && postconditions) };
}

function deploymentApprovalBinding(envelope, build) {
  validateBuildEvidence(envelope, build);
  return digest({
    remediationRequestId: envelope.remediationRequestId,
    sourceApprovalBindingDigest: envelope.approvalBindingDigest,
    sourceRevision: build.sourceRevision,
    patchDigest: build.patchDigest,
    imageDigests: [...build.imageDigests].sort(),
    sbomDigest: build.sbomDigest,
    provenanceDigest: build.provenanceDigest,
    signatureDigest: build.signatureDigest,
    releaseLockDigest: build.releaseLockDigest,
    releaseScope: envelope.releaseScope,
    targetChannel: envelope.targetChannel,
    rollbackRevision: envelope.rollbackRevision,
    rollbackImageDigests: [...envelope.rollbackImageDigests].sort(),
  });
}

function exactEngineeringConfirmation(scope, request, build) {
  if (scope === 'source_patch') {
    return `approve R2D2 source patch ${request.remediationRequestId} ${request.approvalBindingDigest}`;
  }
  if (scope === 'deployment') {
    return `approve R2D2 exact deployment ${request.remediationRequestId} ${deploymentApprovalBinding(request, build)}`;
  }
  throw new Error('unsupported Engineering Remediation approval scope');
}

function approvalsSatisfied(request, approvals, scope, bindingDigest, now = Date.now()) {
  if (!APPROVAL_SCOPES.includes(scope)) return { allowed: false, code: 'ApprovalScopeInvalid' };
  if (!/^sha256:[0-9a-f]{64}$/.test(String(bindingDigest || ''))) return { allowed: false, code: 'ApprovalBindingInvalid' };
  if (Date.parse(request.approvalExpiresAt) <= now) return { allowed: false, code: 'ApprovalExpired' };
  const active = [...new Set((approvals || [])
    .filter((item) => item.approvalScope === scope && item.bindingDigest === bindingDigest
      && item.assurance === 'aal2' && !item.revokedAt
      && (!item.expiresAt || Date.parse(item.expiresAt) > now))
    .map((item) => String(item.approverId)))];
  const required = request.riskLevel === 'R3' ? 2 : 1;
  return active.length >= required
    ? { allowed: true, code: 'Approved', approverIds: active, required }
    : { allowed: false, code: request.riskLevel === 'R3' ? 'TwoPersonApprovalRequired' : 'ApprovalRequired', approverIds: active, required };
}

function authorizeEngineeringExecution(request, session, approvals, scope, bindingDigest, now = Date.now()) {
  if (!session?.active || String(session.actorId || '') !== String(request.actorId || '')) {
    return { allowed: false, code: 'AuthorizationExpired' };
  }
  if (String(session.authzRevision || '') !== String(request.authzRevision || '')) {
    return { allowed: false, code: 'AuthorizationRevisionChanged' };
  }
  if (session.assurance !== 'aal2') return { allowed: false, code: 'AssuranceExpired' };
  if (!(session.permissions || []).includes('r2d2.engineering.execute')) return { allowed: false, code: 'PermissionDenied' };
  return approvalsSatisfied(request, approvals, scope, bindingDigest, now);
}

class EngineeringRemediationWorker {
  constructor(deps) {
    for (const name of ['store', 'sessions', 'sources', 'sandbox', 'tests', 'builder', 'deployer', 'verifier']) {
      if (!deps?.[name]) throw new Error(`${name} dependency is required`);
    }
    this.deps = deps;
    this.sandboxRoot = deps.sandboxRoot || '/var/lib/opensphere/r2d2-sandboxes';
    this.now = deps.now || (() => new Date());
  }

  async requireLease(requestId) {
    if (this.deps.store.heartbeat && !(await this.deps.store.heartbeat(requestId))) {
      throw Object.assign(new Error('Engineering Remediation claim lease was lost'), { code: 'ClaimLeaseLost' });
    }
  }

  async authorize(request, scope, bindingDigest) {
    const [session, approvals] = await Promise.all([
      this.deps.sessions.resolve(request.authSessionId, request.actorId),
      this.deps.store.getApprovals(request.operationId),
    ]);
    const authorization = authorizeEngineeringExecution(
      request, session, approvals, scope, bindingDigest, this.now().getTime(),
    );
    if (!authorization.allowed) {
      await this.deps.store.block(request.remediationRequestId, authorization.code);
      return null;
    }
    return authorization;
  }

  async build(request, patchArtifact) {
    if (request.stage !== 'approved') throw new Error('source patch worker requires approved stage');
    if (!approvalStillValid(request, {
      approvalBindingDigest: request.approvalBindingDigest,
      approvalExpiresAt: request.approvalExpiresAt,
    })) throw Object.assign(new Error('patch-bound approval is stale'), { code: 'ApprovalBindingChanged' });
    if (patchArtifact?.patchDigest !== request.patchDigest) throw Object.assign(new Error('patch artifact digest differs from approval'), { code: 'PatchDigestChanged' });
    if (!await this.authorize(request, 'source_patch', request.approvalBindingDigest)) return { status: 'blocked' };
    await this.requireLease(request.remediationRequestId);
    const currentRevision = await this.deps.sources.currentRevision(request.repository);
    if (currentRevision !== request.baseRevision) {
      await this.deps.store.block(request.remediationRequestId, 'BaseRevisionChanged');
      return { status: 'blocked', code: 'BaseRevisionChanged' };
    }
    const spec = sandboxSpec(request, this.sandboxRoot);
    let currentStage = request.stage;
    const advance = async (nextStage, evidence) => {
      await this.deps.store.stage(request.remediationRequestId, nextStage, evidence);
      currentStage = nextStage;
    };
    const workspace = await this.deps.sandbox.create(spec);
    try {
      await advance('sandboxed', { sandboxDigest: digest(spec) });
      const applied = await this.deps.sources.applyPatch(workspace, patchArtifact, { shell: false, network: 'none' });
      const changedFiles = validatePatchFiles(applied.changedFiles || [], request);
      if (applied.patchDigest !== request.patchDigest) throw Object.assign(new Error('applied patch differs from approval'), { code: 'PatchDigestChanged' });
      await advance('patched', { changedFiles, patchDigest: applied.patchDigest });
      await advance('testing', {});
      const testEvidence = [];
      for (const testId of request.requiredTests) {
        await this.requireLease(request.remediationRequestId);
        const result = await this.deps.tests.run(workspace, testId, { shell: false, network: 'none' });
        testEvidence.push({ id: testId, status: result?.status, evidenceDigest: result?.evidenceDigest });
        if (result?.status !== 'passed') {
          await advance('test_failed', { testId, evidenceDigest: result?.evidenceDigest });
          return { status: 'test_failed', testId };
        }
      }
      await advance('ready_to_commit', { tests: testEvidence });
      const commit = await this.deps.sources.commit(workspace, {
        baseRevision: request.baseRevision, patchDigest: request.patchDigest,
        remediationRequestId: request.remediationRequestId,
      });
      assertSha(commit.sourceRevision, 'sourceRevision');
      await advance('committed', { sourceRevision: commit.sourceRevision });
      await advance('building', {});
      await this.requireLease(request.remediationRequestId);
      const build = await this.deps.builder.build(workspace, {
        sourceRevision: commit.sourceRevision, patchDigest: request.patchDigest,
        components: request.affectedComponents, images: request.affectedImages,
        releaseScope: request.releaseScope, targetChannel: request.targetChannel,
      });
      const evidence = { ...build, sourceRevision: commit.sourceRevision, patchDigest: request.patchDigest, tests: testEvidence };
      const checked = validateBuildEvidence(request, evidence);
      const deployBinding = deploymentApprovalBinding(request, evidence);
      await this.deps.store.recordBuildEvidence(request.remediationRequestId, evidence, checked.evidenceDigest);
      await advance('built', { buildEvidenceDigest: checked.evidenceDigest, releaseLockDigest: evidence.releaseLockDigest });
      await advance('awaiting_deploy_approval', { deploymentBindingDigest: deployBinding });
      return { status: 'awaiting_deploy_approval', build: evidence, deploymentBindingDigest: deployBinding };
    } catch (error) {
      if (error?.code !== 'ClaimLeaseLost' && currentStage !== 'test_failed') {
        const failureStage = currentStage === 'testing' ? 'test_failed'
          : currentStage === 'building' ? 'build_failed' : 'failed';
        await advance(failureStage, { code: error?.code || 'EngineeringBuildFailed' });
      }
      throw error;
    } finally {
      await this.deps.sandbox.destroy(workspace);
    }
  }

  async deploy(request, build) {
    if (request.stage !== 'deploying') throw new Error('deployment worker requires deploying stage');
    const binding = deploymentApprovalBinding(request, build);
    if (!await this.authorize(request, 'deployment', binding)) return { status: 'blocked' };
    await this.requireLease(request.remediationRequestId);
    const receipt = await this.deps.deployer.deploy({ request, build, bindingDigest: binding });
    await this.deps.store.stage(request.remediationRequestId, 'verifying', { receiptDigest: digest(receipt) });
    const observed = await this.deps.verifier.observe({ request, build, receipt });
    const verification = verifyDeployment(request, build, observed);
    if (verification.status === 'succeeded') {
      await this.deps.store.recordDeploymentVerification(request.remediationRequestId, {
        ...verification, ...observed, expectedImageDigests: build.imageDigests,
        expectedLockDigest: build.releaseLockDigest, observedImageDigests: observed.imageDigests || [],
      });
      await this.deps.store.stage(request.remediationRequestId, 'succeeded', { verificationDigest: digest(verification) });
      return verification;
    }
    await this.deps.store.stage(request.remediationRequestId, 'rolling_back', { code: 'PostconditionFailed' });
    const rollbackReceipt = await this.deps.deployer.rollback({
      request, rollbackRevision: request.rollbackRevision,
      rollbackImageDigests: request.rollbackImageDigests, failedReceipt: receipt,
    });
    const rollback = await this.deps.verifier.verifyRollback({ request, rollbackReceipt });
    const terminal = rollback?.verified === true ? 'rolled_back' : 'failed';
    await this.deps.store.recordDeploymentVerification(request.remediationRequestId, {
      ...verification, ...observed, expectedImageDigests: build.imageDigests,
      expectedLockDigest: build.releaseLockDigest, observedImageDigests: observed.imageDigests || [],
      status: terminal, rollbackVerified: rollback?.verified === true,
    });
    await this.deps.store.stage(request.remediationRequestId, terminal, { rollbackDigest: digest(rollback) });
    return { ...verification, status: terminal, rollbackVerified: rollback?.verified === true };
  }
}

module.exports = {
  REPOSITORIES, TEST_COMMANDS, STAGES, APPROVAL_SCOPES, digest, patchTextDigest, normalizedRelativePath, assessRemediation,
  approvalBinding, validateEnvelope, approvalStillValid, sandboxSpec, validatePatchFiles,
  validatePatchArtifact, validateBuildEvidence, verifyDeployment, deploymentApprovalBinding, exactEngineeringConfirmation,
  approvalsSatisfied, authorizeEngineeringExecution, EngineeringRemediationWorker,
};

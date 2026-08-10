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
const STAGES = Object.freeze(['proposed','awaiting_approval','approved','sandboxed','patched','testing','test_failed','ready_to_commit','committed','building','build_failed','built','awaiting_deploy_approval','deploying','verifying','succeeded','rolling_back','rolled_back','failed','cancelled']);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
function digest(value) { return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`; }

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

function validateBuildEvidence(envelope, evidence) {
  assertSha(evidence.sourceRevision, 'sourceRevision');
  for (const field of ['patchDigest','sbomDigest','provenanceDigest','signatureDigest']) assertDigest(evidence[field], field);
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
  const postconditions = observed.api?.passed === true && observed.ui?.passed === true;
  return { status: exact && postconditions ? 'succeeded' : (observed.authorityFresh === false ? 'inconclusive' : 'failed'), exactDigest: exact, postconditions, rollbackRequired: !(exact && postconditions) };
}

module.exports = {
  REPOSITORIES, TEST_COMMANDS, STAGES, digest, normalizedRelativePath, assessRemediation,
  approvalBinding, validateEnvelope, approvalStillValid, sandboxSpec, validatePatchFiles,
  validateBuildEvidence, verifyDeployment,
};

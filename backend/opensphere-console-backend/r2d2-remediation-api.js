'use strict';

const { randomUUID } = require('crypto');
const {
  digest, patchTextDigest, validateEnvelope, validatePatchArtifact,
  deploymentApprovalBinding, exactEngineeringConfirmation,
} = require('./r2d2-engineering-remediation');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publicRemediation(row, executionEnabled = false, workerReady = false) {
  return {
    remediationRequestId: row.remediation_request_id,
    assessmentId: row.assessment_id,
    incidentId: row.incident_id,
    operationId: row.operation_id,
    repository: row.repository,
    baseRevision: row.base_revision,
    allowedPaths: row.allowed_paths,
    patchDigest: row.patch_digest,
    reason: row.reason,
    riskLevel: row.risk_level,
    affectedComponents: row.affected_components,
    affectedImages: row.affected_images,
    requiredTests: row.required_tests,
    releaseScope: row.release_scope,
    fullReleaseJustification: row.full_release_justification,
    targetChannel: row.target_channel,
    buildAuthority: row.build_authority,
    rollbackRevision: row.rollback_revision,
    rollbackImageDigests: row.rollback_image_digests,
    approvalBindingDigest: row.approval_binding_digest,
    approvalExpiresAt: row.approval_expires_at,
    stage: row.stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activation: {
      proposalOnly: !executionEnabled,
      approvalApi: executionEnabled,
      workerReady,
      repositoryWrite: executionEnabled && workerReady,
      build: executionEnabled && workerReady,
      publish: executionEnabled && workerReady,
      deploy: executionEnabled && workerReady,
    },
  };
}

function createR2d2RemediationApi(options) {
  const {
    authenticate, store, proposalEnabled = false, executionEnabled = false,
    workerReady = false, now = () => new Date(),
  } = options;

  async function propose(req, assessmentId, body) {
    if (!proposalEnabled) throw { code: 503, msg: 'R2D2 Engineering Remediation proposal intake is not activated' };
    if (!UUID.test(String(assessmentId || ''))) throw { code: 400, msg: 'valid assessment id required' };
    const session = await authenticate(req, { requireAal2: true });
    const actor = session.actor || session;
    const actorId = String(actor.sub || actor.subject || '');
    const authSessionId = String(actor.browserSessionId || actor.authSessionId || '');
    if (!UUID.test(actorId) || !UUID.test(authSessionId)) {
      throw { code: 401, msg: 'stable actor and managed browser session UUIDs are required' };
    }
    const incidentId = String(body?.incidentId || '');
    if (!UUID.test(incidentId)) throw { code: 400, msg: 'valid correlated incident id required' };
    const remediationRequestId = UUID.test(String(body?.remediationRequestId || ''))
      ? String(body.remediationRequestId) : randomUUID();
    let envelope; let patchArtifact;
    try {
      const patchText = String(body?.patchText || '').replace(/\r\n/g, '\n');
      envelope = validateEnvelope({ ...body, patchDigest: patchTextDigest(patchText), remediationRequestId, incidentId });
      patchArtifact = validatePatchArtifact(patchText, envelope);
    } catch (error) {
      throw { code: 400, msg: error.message || 'invalid Engineering Remediation approval envelope' };
    }
    const idempotencyKey = String(req.headers['x-os-idempotency-key'] || body?.idempotencyKey || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(idempotencyKey)) {
      throw { code: 400, msg: 'valid idempotency key required' };
    }
    const row = await store.propose({
      ...envelope,
      assessmentId,
      actorId,
      assurance: actor.assurance || 'aal1',
      authSessionId,
      authzRevision: String(actor.credentialRevision || actor.authzRevision || 0),
      idempotencyKey,
      patchArtifact,
    });
    return publicRemediation(row, executionEnabled, workerReady);
  }

  async function approve(req, remediationRequestId, scope, body) {
    if (!executionEnabled) throw { code: 503, msg: 'R2D2 Engineering Remediation execution is not activated' };
    if (!UUID.test(String(remediationRequestId || '')) || !['source_patch', 'deployment'].includes(scope)) {
      throw { code: 400, msg: 'valid remediation request and approval scope required' };
    }
    const session = await authenticate(req, { requireAal2: true });
    const actor = session.actor || session;
    const approverId = String(actor.sub || actor.subject || '');
    if (!UUID.test(approverId) || actor.assurance !== 'aal2') throw { code: 403, msg: 'stable AAL2 approver required' };
    const request = await store.get(remediationRequestId);
    if (!request) throw { code: 404, msg: 'Engineering Remediation request not found' };
    if (approverId === String(request.actorId || request.actor_id || '')) {
      throw { code: 409, msg: 'Engineering Remediation requires an independent approver' };
    }
    const build = scope === 'deployment' ? await store.latestBuild(remediationRequestId) : null;
    if (scope === 'deployment' && !build) throw { code: 409, msg: 'verified build evidence is required before deployment approval' };
    const bindingDigest = scope === 'source_patch' ? request.approvalBindingDigest : deploymentApprovalBinding(request, build);
    const expected = exactEngineeringConfirmation(scope, request, build);
    if (String(body?.confirmation || '') !== expected) throw { code: 400, msg: `confirmation required: ${expected}` };
    const requestedExpiry = Date.parse(body?.approvalExpiresAt || '');
    const maxExpiry = scope === 'source_patch' ? Date.parse(request.approvalExpiresAt) : now().getTime() + 15 * 60 * 1000;
    const expiry = Number.isFinite(requestedExpiry) ? Math.min(requestedExpiry, maxExpiry) : maxExpiry;
    if (expiry <= now().getTime()) throw { code: 400, msg: 'approval expiry must be in the future' };
    const row = await store.approveScoped({
      remediationRequestId, scope, approverId, assurance: 'aal2', bindingDigest,
      approvalDigest: digest({ remediationRequestId, scope, approverId, bindingDigest, confirmation: body.confirmation, expiresAt: new Date(expiry).toISOString() }),
      expiresAt: new Date(expiry).toISOString(),
    });
    return publicRemediation(row, executionEnabled, workerReady);
  }

  async function handle(req, res, pathname, bodyReader, json) {
    const proposal = pathname.match(/^\/api\/oaa\/remediations\/assessments\/([0-9a-f-]{36})\/proposals$/i);
    if (proposal && req.method === 'POST') {
      return json(res, 202, await propose(req, proposal[1], await bodyReader(req)));
    }
    const approval = pathname.match(/^\/api\/oaa\/remediations\/([0-9a-f-]{36})\/approvals\/(source|deployment)$/i);
    if (approval && req.method === 'POST') {
      return json(res, 202, await approve(req, approval[1], approval[2] === 'source' ? 'source_patch' : 'deployment', await bodyReader(req)));
    }
    return false;
  }

  return { propose, approve, handle, publicRemediation };
}

function createRestRemediationStore(restRequest) {
  const request = (resource, options = {}) => restRequest(resource, { ...options, profile: 'oaa' });
  return {
    async propose(input) {
      const rows = await request('rpc/propose_engineering_remediation_v2', {
        method: 'POST',
        body: {
          p_remediation_request_id: input.remediationRequestId,
          p_idempotency_key: input.idempotencyKey,
          p_actor_id: input.actorId,
          p_assurance: input.assurance,
          p_auth_session_id: input.authSessionId,
          p_authz_revision: input.authzRevision,
          p_assessment_id: input.assessmentId,
          p_incident_id: input.incidentId,
          p_repository: input.repository,
          p_base_revision: input.baseRevision,
          p_allowed_paths: input.allowedPaths,
          p_patch_digest: input.patchDigest,
          p_patch_text: input.patchArtifact.patchText,
          p_changed_paths: input.patchArtifact.changedFiles,
          p_patch_evidence_digest: input.patchArtifact.evidenceDigest,
          p_reason: input.reason,
          p_risk_level: input.riskLevel,
          p_affected_components: input.affectedComponents,
          p_affected_images: input.affectedImages,
          p_required_tests: input.requiredTests,
          p_release_scope: input.releaseScope,
          p_full_release_justification: input.fullReleaseJustification || null,
          p_target_channel: input.targetChannel,
          p_build_authority: input.buildAuthority,
          p_rollback_revision: input.rollbackRevision,
          p_rollback_image_digests: input.rollbackImageDigests,
          p_approval_binding_digest: input.approvalBindingDigest,
          p_approval_expires_at: input.approvalExpiresAt,
        },
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) throw { code: 503, msg: 'Engineering Remediation proposal was not persisted' };
      return row;
    },
    async get(id) {
      const rows = await request('engineering_remediation_request', { query: `remediation_request_id=eq.${encodeURIComponent(id)}&select=*` });
      const row = rows?.[0];
      return row ? {
        ...row, remediationRequestId: row.remediation_request_id, operationId: row.operation_id,
        approvalBindingDigest: row.approval_binding_digest, approvalExpiresAt: row.approval_expires_at,
        deploymentBindingDigest: row.deployment_binding_digest, riskLevel: row.risk_level,
        patchDigest: row.patch_digest, baseRevision: row.base_revision, allowedPaths: row.allowed_paths,
        affectedComponents: row.affected_components, affectedImages: row.affected_images,
        requiredTests: row.required_tests, releaseScope: row.release_scope, targetChannel: row.target_channel,
        buildAuthority: row.build_authority, rollbackRevision: row.rollback_revision,
        rollbackImageDigests: row.rollback_image_digests,
      } : null;
    },
    async latestBuild(id) {
      const rows = await request('build_evidence', { query: `remediation_request_id=eq.${encodeURIComponent(id)}&order=created_at.desc&limit=1&select=*` });
      const row = rows?.[0];
      return row ? {
        sourceRevision: row.source_revision, patchDigest: row.patch_digest, buildAuthority: row.build_authority,
        imageDigests: row.image_digests, sbomDigest: row.sbom_digest, provenanceDigest: row.provenance_digest,
        signatureDigest: row.signature_digest, releaseLockDigest: row.release_lock_digest,
        tests: Object.entries(row.test_evidence || {}).map(([id, value]) => ({ id, ...(value || {}) })),
      } : null;
    },
    async approveScoped(input) {
      const rows = await request('rpc/record_engineering_remediation_approval', { method: 'POST', body: {
        p_remediation_request_id: input.remediationRequestId, p_scope: input.scope,
        p_approver_id: input.approverId, p_assurance: input.assurance,
        p_binding_digest: input.bindingDigest, p_approval_digest: input.approvalDigest,
        p_expires_at: input.expiresAt,
      } });
      return Array.isArray(rows) ? rows[0] : rows;
    },
  };
}

function workerRequest(row, operation, patchArtifact) {
  return {
    remediationRequestId: row.remediation_request_id, assessmentId: row.assessment_id,
    incidentId: row.incident_id, operationId: row.operation_id, repository: row.repository,
    baseRevision: row.base_revision, allowedPaths: row.allowed_paths, patchDigest: row.patch_digest,
    reason: row.reason, riskLevel: row.risk_level, affectedComponents: row.affected_components,
    affectedImages: row.affected_images, requiredTests: row.required_tests, releaseScope: row.release_scope,
    fullReleaseJustification: row.full_release_justification, targetChannel: row.target_channel,
    buildAuthority: row.build_authority, rollbackRevision: row.rollback_revision,
    rollbackImageDigests: row.rollback_image_digests, approvalBindingDigest: row.approval_binding_digest,
    approvalExpiresAt: row.approval_expires_at, deploymentBindingDigest: row.deployment_binding_digest,
    deploymentApprovalExpiresAt: row.deployment_approval_expires_at, stage: row.stage,
    actorId: operation?.actor_id, authSessionId: operation?.auth_session_id, authzRevision: operation?.authz_revision,
    patchArtifact: patchArtifact ? {
      patchDigest: patchArtifact.patch_digest, patchText: patchArtifact.patch_text,
      changedFiles: patchArtifact.changed_paths, evidenceDigest: patchArtifact.evidence_digest,
    } : null,
  };
}

function createRestRemediationWorkerStore(restRequest, workerId, claimEpoch) {
  const oaa = (resource, options = {}) => restRequest(resource, { ...options, profile: 'oaa' });
  const consoleRequest = (resource, options = {}) => restRequest(resource, { ...options, profile: 'console' });
  const requests = new Map();
  const stages = new Map();
  return {
    async claim(limit = 5) {
      const rows = await oaa('rpc/claim_engineering_remediation', {
        method: 'POST', body: { p_worker: workerId, p_claim_epoch: claimEpoch, p_limit: limit },
      });
      return Promise.all((rows || []).map(async (row) => {
        const [operations, artifacts] = await Promise.all([
          consoleRequest('module_operation', { query: `operation_id=eq.${encodeURIComponent(row.operation_id)}&select=*` }),
          oaa('remediation_patch_artifact', { query: `remediation_request_id=eq.${encodeURIComponent(row.remediation_request_id)}&select=*` }),
        ]);
        const mapped = workerRequest(row, operations?.[0], artifacts?.[0]);
        requests.set(mapped.remediationRequestId, mapped); stages.set(mapped.remediationRequestId, mapped.stage);
        return mapped;
      }));
    },
    async heartbeat(id) {
      return oaa('rpc/heartbeat_engineering_remediation', { method: 'POST', body: {
        p_remediation_request_id: id, p_worker: workerId, p_claim_epoch: claimEpoch,
      } });
    },
    async getApprovals(operationId) {
      const rows = await consoleRequest('module_operation_approval', {
        query: `operation_id=eq.${encodeURIComponent(operationId)}&select=approver_id,assurance,approval_scope,binding_digest,approval_expires_at,revoked_at`,
      });
      return (rows || []).map((row) => ({ approverId: row.approver_id, assurance: row.assurance,
        approvalScope: row.approval_scope, bindingDigest: row.binding_digest,
        expiresAt: row.approval_expires_at, revokedAt: row.revoked_at }));
    },
    async stage(id, next, evidence = {}) {
      const current = stages.get(id);
      if (!current) throw new Error('Engineering Remediation worker stage is unknown');
      const row = await oaa('rpc/advance_engineering_remediation', { method: 'POST', body: {
        p_remediation_request_id: id, p_worker: workerId, p_claim_epoch: claimEpoch,
        p_expected_stage: current, p_next_stage: next, p_evidence: evidence,
        p_evidence_digest: digest(evidence),
      } });
      stages.set(id, next);
      return Array.isArray(row) ? row[0] : row;
    },
    async block(id, code) { return this.stage(id, 'failed', { code }); },
    async recordBuildEvidence(id, evidence) {
      const tests = Object.fromEntries((evidence.tests || []).map((item) => [item.id, {
        status: item.status, evidenceDigest: item.evidenceDigest || null,
      }]));
      await oaa('rpc/record_engineering_build_evidence', { method: 'POST', body: {
        p_remediation_request_id: id, p_worker: workerId, p_claim_epoch: claimEpoch,
        p_source_revision: evidence.sourceRevision, p_patch_digest: evidence.patchDigest,
        p_test_evidence: tests, p_sbom_digest: evidence.sbomDigest,
        p_provenance_digest: evidence.provenanceDigest, p_signature_digest: evidence.signatureDigest,
        p_image_digests: evidence.imageDigests, p_build_authority: evidence.buildAuthority,
        p_release_lock_digest: evidence.releaseLockDigest,
      } });
    },
    async recordDeploymentVerification(id, evidence) {
      const request = requests.get(id); if (!request) throw new Error('Engineering Remediation request is not claimed');
      await oaa('rpc/record_engineering_deployment_verification', { method: 'POST', body: {
        p_remediation_request_id: id, p_worker: workerId, p_claim_epoch: claimEpoch,
        p_operation_id: request.operationId,
        p_expected_image_digests: evidence.expectedImageDigests || evidence.imageDigests || [],
        p_observed_image_digests: evidence.observedImageDigests || evidence.imageDigests || [],
        p_expected_lock_digest: evidence.expectedLockDigest || evidence.releaseLockDigest || null,
        p_lock_digest: evidence.lockDigest || null, p_api_postcondition: evidence.api || { passed: false },
        p_ui_postcondition: evidence.ui || { passed: false }, p_rollback_verified: evidence.rollbackVerified === true,
        p_status: evidence.status,
      } });
    },
  };
}

module.exports = {
  createR2d2RemediationApi, createRestRemediationStore, createRestRemediationWorkerStore,
  workerRequest, publicRemediation,
};

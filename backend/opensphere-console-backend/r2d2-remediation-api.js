'use strict';

const { randomUUID } = require('crypto');
const { validateEnvelope } = require('./r2d2-engineering-remediation');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publicRemediation(row) {
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
      proposalOnly: true,
      repositoryWrite: false,
      build: false,
      publish: false,
      deploy: false,
    },
  };
}

function createR2d2RemediationApi(options) {
  const { authenticate, store, proposalEnabled = false } = options;

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
    let envelope;
    try {
      envelope = validateEnvelope({ ...body, remediationRequestId, incidentId });
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
    });
    return publicRemediation(row);
  }

  async function handle(req, res, pathname, bodyReader, json) {
    const proposal = pathname.match(/^\/api\/oaa\/remediations\/assessments\/([0-9a-f-]{36})\/proposals$/i);
    if (proposal && req.method === 'POST') {
      return json(res, 202, await propose(req, proposal[1], await bodyReader(req)));
    }
    return false;
  }

  return { propose, handle, publicRemediation };
}

function createRestRemediationStore(restRequest) {
  const request = (resource, options = {}) => restRequest(resource, { ...options, profile: 'oaa' });
  return {
    async propose(input) {
      const rows = await request('rpc/propose_engineering_remediation', {
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
  };
}

module.exports = { createR2d2RemediationApi, createRestRemediationStore, publicRemediation };

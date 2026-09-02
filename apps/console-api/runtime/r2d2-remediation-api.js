'use strict';

const { randomUUID } = require('crypto');
const {
  REPOSITORIES, digest, patchTextDigest, validateEnvelope, validatePatchArtifact,
  deploymentApprovalBinding, exactEngineeringConfirmation,
} = require('./r2d2-engineering-remediation');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OSAA_ENGINEERING_ACTOR_ID = '00000000-0000-4000-8000-000000000006';
const BROWSER_MARKERS = Object.freeze({
  'authenticated-health': 'os-shell',
  'manual-route': '[data-manual-contract="console-help-center-v2"]',
  'registry-plugins': 'os-admin-plugins',
  'osaa-admin': 'os-admin-osaa',
});

function field(row, snake, camel = snake) {
  return row?.[camel] ?? row?.[snake] ?? null;
}

function publicRemediation(row, executionEnabled = false, workerReady = false) {
  return {
    remediationRequestId: field(row, 'remediation_request_id', 'remediationRequestId'),
    assessmentId: field(row, 'assessment_id', 'assessmentId'),
    incidentId: field(row, 'incident_id', 'incidentId'),
    operationId: field(row, 'operation_id', 'operationId'),
    operatorId: field(row, 'operator_id', 'operatorId'),
    repository: field(row, 'repository'),
    baseRevision: field(row, 'base_revision', 'baseRevision'),
    allowedPaths: field(row, 'allowed_paths', 'allowedPaths') || [],
    changedPaths: field(row, 'changed_paths', 'changedPaths') || [],
    patchDigest: field(row, 'patch_digest', 'patchDigest'),
    reason: field(row, 'reason'),
    riskLevel: field(row, 'risk_level', 'riskLevel'),
    affectedComponents: field(row, 'affected_components', 'affectedComponents') || [],
    affectedImages: field(row, 'affected_images', 'affectedImages') || [],
    requiredTests: field(row, 'required_tests', 'requiredTests') || [],
    releaseScope: field(row, 'release_scope', 'releaseScope'),
    fullReleaseJustification: field(row, 'full_release_justification', 'fullReleaseJustification'),
    targetChannel: field(row, 'target_channel', 'targetChannel'),
    buildAuthority: field(row, 'build_authority', 'buildAuthority'),
    rollbackRevision: field(row, 'rollback_revision', 'rollbackRevision'),
    rollbackImageDigests: field(row, 'rollback_image_digests', 'rollbackImageDigests') || [],
    approvalBindingDigest: field(row, 'approval_binding_digest', 'approvalBindingDigest'),
    approvalMode: field(row, 'approval_mode', 'approvalMode'),
    verificationProfile: field(row, 'verification_profile', 'verificationProfile'),
    verificationRoute: field(row, 'verification_route', 'verificationRoute'),
    approvalExpiresAt: field(row, 'approval_expires_at', 'approvalExpiresAt'),
    stage: field(row, 'stage'),
    createdAt: field(row, 'created_at', 'createdAt'),
    updatedAt: field(row, 'updated_at', 'updatedAt'),
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
    workerReady = false, proposalRepositories = [], now = () => new Date(),
  } = options;
  const proposalPolicy = Object.freeze(Object.fromEntries(proposalRepositories.map((repositoryId) => {
    if (!Object.hasOwn(REPOSITORIES, repositoryId)) {
      throw new Error(`unknown R2D2 proposal repository: ${repositoryId}`);
    }
    return [repositoryId, REPOSITORIES[repositoryId]];
  })));
  const currentWorkerReady = async () => typeof workerReady === 'function'
    ? (await workerReady()) === true : workerReady === true;

  async function status(req) {
    await authenticate(req, { requireAal2: false });
    const ready = executionEnabled && await currentWorkerReady();
    return {
      schema: 'osaa-engineering-remediation-status.opensphere.io/v1alpha1',
      proposalEnabled,
      executionEnabled,
      workerReady: ready,
      repositories: Object.keys(proposalPolicy),
      approvalMode: executionEnabled ? 'local-edge-supervised' : 'disabled',
      capabilities: {
        diagnose: true,
        propose: proposalEnabled,
        approveExactWorkUnit: executionEnabled,
        repositoryWrite: ready,
        componentBuild: ready,
        exactDigestDeploy: ready,
        browserVerification: ready,
        rollback: ready,
      },
    };
  }

  async function list(req, limit = 20) {
    await authenticate(req, { requireAal2: false });
    const ready = executionEnabled && await currentWorkerReady();
    const rows = typeof store.list === 'function' ? await store.list(Math.max(1, Math.min(50, Number(limit) || 20))) : [];
    return {
      schema: 'osaa-engineering-remediation-list.opensphere.io/v1alpha1',
      remediations: rows.map((row) => publicRemediation(row, executionEnabled, ready)),
    };
  }

  async function details(req, remediationRequestId) {
    await authenticate(req, { requireAal2: false });
    if (!UUID.test(String(remediationRequestId || ''))) throw { code: 400, msg: 'valid remediation request id required' };
    const request = await store.get(remediationRequestId);
    if (!request) throw { code: 404, msg: 'Engineering Remediation request not found' };
    const ready = executionEnabled && await currentWorkerReady();
    const build = await store.latestBuild(remediationRequestId);
    const requiredConfirmation = request.stage === 'proposed'
      ? exactEngineeringConfirmation('source_patch', request)
      : (request.stage === 'awaiting_deploy_approval' && build
        ? exactEngineeringConfirmation('deployment', request, build) : null);
    return {
      ...publicRemediation(request, executionEnabled, ready),
      requiredConfirmation,
      latestBuild: build ? {
        sourceRevision: build.sourceRevision,
        patchDigest: build.patchDigest,
        buildAuthority: build.buildAuthority,
        imageDigests: build.imageDigests,
        releaseLockDigest: build.releaseLockDigest,
      } : null,
    };
  }

  async function propose(req, assessmentId, body) {
    if (!proposalEnabled) throw { code: 503, msg: 'R2D2 Engineering Remediation proposal intake is not activated' };
    if (!Object.hasOwn(proposalPolicy, String(body?.repositoryId || ''))) {
      throw { code: 503, msg: 'R2D2 Engineering Remediation repository proposal is not activated' };
    }
    if (!UUID.test(String(assessmentId || ''))) throw { code: 400, msg: 'valid assessment id required' };
    const session = await authenticate(req, { requireAal2: true });
    const actor = session.actor || session;
    const operatorId = String(actor.sub || actor.subject || '');
    const authSessionId = String(actor.browserSessionId || actor.authSessionId || '');
    if (!UUID.test(operatorId) || !UUID.test(authSessionId)) {
      throw { code: 401, msg: 'stable actor and managed browser session UUIDs are required' };
    }
    const incidentId = String(body?.incidentId || '');
    if (!UUID.test(incidentId)) throw { code: 400, msg: 'valid correlated incident id required' };
    const remediationRequestId = UUID.test(String(body?.remediationRequestId || ''))
      ? String(body.remediationRequestId) : randomUUID();
    let envelope; let patchArtifact;
    try {
      const patchText = String(body?.patchText || '').replace(/\r\n/g, '\n');
      envelope = validateEnvelope({ ...body, patchDigest: patchTextDigest(patchText), remediationRequestId, incidentId }, proposalPolicy);
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
      actorId: OSAA_ENGINEERING_ACTOR_ID,
      operatorId,
      assurance: actor.assurance || 'aal1',
      authSessionId,
      authzRevision: String(actor.credentialRevision || actor.authzRevision || 0),
      idempotencyKey,
      patchArtifact,
    });
    return publicRemediation(row, executionEnabled, await currentWorkerReady());
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
    return publicRemediation(row, executionEnabled, await currentWorkerReady());
  }

  async function recordBrowserVerification(req, remediationRequestId, body) {
    if (!executionEnabled) throw { code: 503, msg: 'R2D2 Engineering Remediation execution is not activated' };
    if (!UUID.test(String(remediationRequestId || ''))) throw { code: 400, msg: 'valid remediation request id required' };
    const session = await authenticate(req, { requireAal2: true });
    const actor = session.actor || session; const operatorId = String(actor.sub || actor.subject || '');
    const request = await store.get(remediationRequestId);
    if (!request) throw { code: 404, msg: 'Engineering Remediation request not found' };
    if (operatorId !== String(request.operatorId || '')) throw { code: 403, msg: 'only the approving operator browser may verify this repair' };
    if (request.stage !== 'verifying') throw { code: 409, msg: 'repair is not awaiting browser verification' };
    const allowed = ['verificationProfile','verificationRoute','observedSourceRevision','marker','markerPresent','consoleErrorCount','networkFailureCount'];
    const extra = Object.keys(body && typeof body === 'object' && !Array.isArray(body) ? body : {}).filter((key) => !allowed.includes(key));
    if (extra.length) throw { code: 400, msg: `browser verification contains unsupported fields: ${extra.join(', ')}` };
    const build = await store.latestBuild(remediationRequestId);
    const consoleErrorCount = Number(body?.consoleErrorCount); const networkFailureCount = Number(body?.networkFailureCount);
    if (body?.verificationProfile !== request.verificationProfile || body?.verificationRoute !== request.verificationRoute
      || body?.marker !== BROWSER_MARKERS[request.verificationProfile]
      || body?.observedSourceRevision !== build?.sourceRevision
      || !Number.isInteger(consoleErrorCount) || consoleErrorCount < 0
      || !Number.isInteger(networkFailureCount) || networkFailureCount < 0) {
      throw { code: 400, msg: 'browser verification differs from the approved fixed profile or exact source revision' };
    }
    const evidence = {
      remediationRequestId, operatorId, verificationProfile: request.verificationProfile,
      verificationRoute: request.verificationRoute, observedSourceRevision: build.sourceRevision,
      marker: body.marker, markerPresent: body.markerPresent === true,
      consoleErrorCount, networkFailureCount,
    };
    evidence.passed = evidence.markerPresent && consoleErrorCount === 0 && networkFailureCount === 0;
    evidence.evidenceDigest = digest(evidence);
    const row = await store.recordBrowserVerification(evidence);
    return { accepted: true, passed: evidence.passed, evidenceDigest: evidence.evidenceDigest, observedAt: row?.observed_at || null };
  }

  async function handle(req, res, pathname, bodyReader, json) {
    if (pathname === '/api/osaa/remediations/status' && req.method === 'GET') {
      return json(res, 200, await status(req), { 'cache-control': 'no-store' });
    }
    if ((pathname === '/api/osaa/remediations' || pathname === '/api/osaa/remediations/') && req.method === 'GET') {
      return json(res, 200, await list(req), { 'cache-control': 'no-store' });
    }
    const detail = pathname.match(/^\/api\/osaa\/remediations\/([0-9a-f-]{36})$/i);
    if (detail && req.method === 'GET') {
      return json(res, 200, await details(req, detail[1]), { 'cache-control': 'no-store' });
    }
    const proposal = pathname.match(/^\/api\/osaa\/remediations\/assessments\/([0-9a-f-]{36})\/proposals$/i);
    if (proposal && req.method === 'POST') {
      return json(res, 202, await propose(req, proposal[1], await bodyReader(req)));
    }
    const approval = pathname.match(/^\/api\/osaa\/remediations\/([0-9a-f-]{36})\/approvals\/(source|deployment)$/i);
    if (approval && req.method === 'POST') {
      return json(res, 202, await approve(req, approval[1], approval[2] === 'source' ? 'source_patch' : 'deployment', await bodyReader(req)));
    }
    const browserVerification = pathname.match(/^\/api\/osaa\/remediations\/([0-9a-f-]{36})\/browser-verifications$/i);
    if (browserVerification && req.method === 'POST') {
      return json(res, 202, await recordBrowserVerification(req, browserVerification[1], await bodyReader(req)));
    }
    return false;
  }

  return { status, list, details, propose, approve, recordBrowserVerification, handle, publicRemediation };
}

function createRestRemediationStore(restRequest) {
  const request = (resource, options = {}) => restRequest(resource, { ...options, profile: 'osaa' });
  return {
    async propose(input) {
      const rows = await request('rpc/propose_engineering_remediation_v3', {
        method: 'POST',
        body: {
          p_remediation_request_id: input.remediationRequestId,
          p_idempotency_key: input.idempotencyKey,
          p_agent_actor_id: input.actorId,
          p_operator_id: input.operatorId,
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
          p_approval_mode: input.approvalMode,
          p_verification_profile: input.verificationProfile,
          p_verification_route: input.verificationRoute,
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
      if (!row) return null;
      const [operations, artifacts] = await Promise.all([
        restRequest('module_operation', { profile: 'console', query: `operation_id=eq.${encodeURIComponent(row.operation_id)}&select=actor_id` }),
        request('remediation_patch_artifact', { query: `remediation_request_id=eq.${encodeURIComponent(id)}&select=changed_paths` }),
      ]);
      return {
        ...row, remediationRequestId: row.remediation_request_id, operationId: row.operation_id,
        actorId: operations?.[0]?.actor_id || null,
        operatorId: row.operator_id, approvalMode: row.approval_mode,
        verificationProfile: row.verification_profile, verificationRoute: row.verification_route,
        approvalBindingDigest: row.approval_binding_digest, approvalExpiresAt: row.approval_expires_at,
        deploymentBindingDigest: row.deployment_binding_digest, riskLevel: row.risk_level,
        patchDigest: row.patch_digest, baseRevision: row.base_revision, allowedPaths: row.allowed_paths,
        affectedComponents: row.affected_components, affectedImages: row.affected_images,
        requiredTests: row.required_tests, releaseScope: row.release_scope, targetChannel: row.target_channel,
        buildAuthority: row.build_authority, rollbackRevision: row.rollback_revision,
        rollbackImageDigests: row.rollback_image_digests,
        changedPaths: artifacts?.[0]?.changed_paths || [],
      };
    },
    async list(limit = 20) {
      const rows = await request('engineering_remediation_request', {
        query: `order=updated_at.desc&limit=${Math.max(1, Math.min(50, Number(limit) || 20))}&select=*`,
      });
      if (!rows?.length) return [];
      const ids = rows.map((row) => row.remediation_request_id).filter((id) => UUID.test(String(id)));
      const artifacts = ids.length ? await request('remediation_patch_artifact', {
        query: `remediation_request_id=in.(${ids.join(',')})&select=remediation_request_id,changed_paths`,
      }) : [];
      const changedPaths = new Map((artifacts || []).map((artifact) => [artifact.remediation_request_id, artifact.changed_paths || []]));
      return rows.map((row) => ({ ...row, changedPaths: changedPaths.get(row.remediation_request_id) || [] }));
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
    async recordBrowserVerification(input) {
      const rows = await request('engineering_browser_verification', { method: 'POST', body: [{
        remediation_request_id: input.remediationRequestId, operator_id: input.operatorId,
        verification_profile: input.verificationProfile, verification_route: input.verificationRoute,
        observed_source_revision: input.observedSourceRevision, marker: input.marker,
        console_error_count: input.consoleErrorCount, network_failure_count: input.networkFailureCount,
        passed: input.passed, evidence_digest: input.evidenceDigest,
      }], prefer: 'return=representation' });
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
    approvalMode: row.approval_mode, operatorId: row.operator_id,
    verificationProfile: row.verification_profile, verificationRoute: row.verification_route,
    actorId: row.operator_id, agentActorId: operation?.actor_id,
    authSessionId: operation?.auth_session_id, authzRevision: operation?.authz_revision,
    patchArtifact: patchArtifact ? {
      patchDigest: patchArtifact.patch_digest, patchText: patchArtifact.patch_text,
      changedFiles: patchArtifact.changed_paths, evidenceDigest: patchArtifact.evidence_digest,
    } : null,
  };
}

function createRestRemediationWorkerStore(restRequest, workerId, claimEpoch) {
  const osaa = (resource, options = {}) => restRequest(resource, { ...options, profile: 'osaa' });
  const consoleRequest = (resource, options = {}) => restRequest(resource, { ...options, profile: 'console' });
  const requests = new Map();
  const stages = new Map();
  return {
    async claim(limit = 5) {
      const rows = await osaa('rpc/claim_engineering_remediation', {
        method: 'POST', body: { p_worker: workerId, p_claim_epoch: claimEpoch, p_limit: limit },
      });
      return Promise.all((rows || []).map(async (row) => {
        const [operations, artifacts] = await Promise.all([
          consoleRequest('module_operation', { query: `operation_id=eq.${encodeURIComponent(row.operation_id)}&select=*` }),
          osaa('remediation_patch_artifact', { query: `remediation_request_id=eq.${encodeURIComponent(row.remediation_request_id)}&select=*` }),
        ]);
        const mapped = workerRequest(row, operations?.[0], artifacts?.[0]);
        requests.set(mapped.remediationRequestId, mapped); stages.set(mapped.remediationRequestId, mapped.stage);
        return mapped;
      }));
    },
    async heartbeat(id) {
      return osaa('rpc/heartbeat_engineering_remediation', { method: 'POST', body: {
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
      const row = await osaa('rpc/advance_engineering_remediation', { method: 'POST', body: {
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
      await osaa('rpc/record_engineering_build_evidence', { method: 'POST', body: {
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
      await osaa('rpc/record_engineering_deployment_verification', { method: 'POST', body: {
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
  workerRequest, publicRemediation, OSAA_ENGINEERING_ACTOR_ID,
};

'use strict';

const {
  authorizeEngineeringExecution, digest, validateBuildEvidence,
} = require('./r2d2-engineering-remediation');
const { workerRequest } = require('./r2d2-remediation-api');
const { CONSOLE_REPOSITORY, validateLocalEdgeRepair } = require('./r2d2-repair-runner-contract');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RUNNER_ID = /^local-edge-[a-z0-9][a-z0-9-]{7,80}$/;

function closedBody(value, keys) {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const extra = Object.keys(body).filter((key) => !keys.includes(key));
  if (extra.length) throw { code: 400, msg: `Repair Runner body contains unsupported fields: ${extra.join(', ')}` };
  return body;
}

function runnerIdentity(body) {
  const runnerId = String(body.runnerId || '');
  const claimEpoch = Number(body.claimEpoch);
  if (!RUNNER_ID.test(runnerId) || !Number.isSafeInteger(claimEpoch) || claimEpoch < 1) {
    throw { code: 400, msg: 'canonical Repair Runner id and positive claim epoch are required' };
  }
  return { runnerId, claimEpoch };
}

function mappedRequest(row, operation, patchArtifact) {
  return workerRequest(row, operation, patchArtifact);
}

function createR2d2RepairRunnerApi(options) {
  const {
    authenticateAutomation, restRequest, resolveSession, executionEnabled = false,
    now = () => new Date(),
  } = options;
  const osaa = (resource, requestOptions = {}) => restRequest(resource, { ...requestOptions, profile: 'osaa' });
  const consoleRequest = (resource, requestOptions = {}) => restRequest(resource, { ...requestOptions, profile: 'console' });

  async function requireRunner(req) {
    if (!executionEnabled) throw { code: 503, msg: 'R2D2 local edge Repair Runner is not activated' };
    return authenticateAutomation(req);
  }

  async function register(req, input) {
    await requireRunner(req);
    const body = closedBody(input, ['runnerId', 'claimEpoch', 'hostDigest', 'sourceRevision']);
    const identity = runnerIdentity(body);
    if (!DIGEST.test(String(body.hostDigest || '')) || !SHA.test(String(body.sourceRevision || ''))) {
      throw { code: 400, msg: 'exact host and runner source evidence are required' };
    }
    const row = await osaa('rpc/register_engineering_remediation_runner', { method: 'POST', body: {
      p_runner_id: identity.runnerId, p_claim_epoch: identity.claimEpoch,
      p_host_digest: body.hostDigest, p_source_revision: body.sourceRevision,
      p_repository: CONSOLE_REPOSITORY,
    } });
    return { ready: true, runnerId: identity.runnerId, claimEpoch: identity.claimEpoch,
      expiresAt: (Array.isArray(row) ? row[0] : row)?.expires_at || null };
  }

  async function ready() {
    if (!executionEnabled) return false;
    const value = await osaa('rpc/engineering_remediation_runner_ready', {
      method: 'POST', body: { p_repository: CONSOLE_REPOSITORY },
    }).catch(() => false);
    return value === true || value?.[0] === true || value?.engineering_remediation_runner_ready === true;
  }

  async function claim(req, input) {
    await requireRunner(req);
    const body = closedBody(input, ['runnerId', 'claimEpoch', 'limit']);
    const identity = runnerIdentity(body);
    const limit = Number(body.limit || 1);
    if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw { code: 400, msg: 'Repair Runner claim limit must be 1 to 3' };
    const rows = await osaa('rpc/claim_engineering_remediation', { method: 'POST', body: {
      p_worker: identity.runnerId, p_claim_epoch: identity.claimEpoch, p_limit: limit,
    } });
    const items = [];
    for (const row of rows || []) {
      const [operations, artifacts, builds] = await Promise.all([
        consoleRequest('module_operation', { query: `operation_id=eq.${encodeURIComponent(row.operation_id)}&select=*` }),
        osaa('remediation_patch_artifact', { query: `remediation_request_id=eq.${encodeURIComponent(row.remediation_request_id)}&select=*` }),
        osaa('build_evidence', { query: `remediation_request_id=eq.${encodeURIComponent(row.remediation_request_id)}&order=created_at.desc&limit=1&select=*` }),
      ]);
      const request = mappedRequest(row, operations?.[0], artifacts?.[0]);
      try { validateLocalEdgeRepair(request); }
      catch (error) {
        await osaa('rpc/advance_engineering_remediation', { method: 'POST', body: {
          p_remediation_request_id: request.remediationRequestId, p_worker: identity.runnerId,
          p_claim_epoch: identity.claimEpoch, p_expected_stage: request.stage, p_next_stage: 'failed',
          p_evidence: { code: 'RunnerScopeRejected' }, p_evidence_digest: digest({ code: 'RunnerScopeRejected' }),
        } });
        continue;
      }
      const build = builds?.[0] ? {
        sourceRevision: builds[0].source_revision, patchDigest: builds[0].patch_digest,
        tests: Object.entries(builds[0].test_evidence || {}).map(([id, value]) => ({ id, ...(value || {}) })),
        sbomDigest: builds[0].sbom_digest, provenanceDigest: builds[0].provenance_digest,
        signatureDigest: builds[0].signature_digest, imageDigests: builds[0].image_digests,
        buildAuthority: builds[0].build_authority, releaseLockDigest: builds[0].release_lock_digest,
      } : null;
      items.push({ request, build });
    }
    return { items };
  }

  async function loadClaimed(remediationRequestId, identity) {
    if (!UUID.test(String(remediationRequestId || ''))) throw { code: 400, msg: 'valid remediation request id required' };
    const rows = await osaa('engineering_remediation_request', {
      query: `remediation_request_id=eq.${encodeURIComponent(remediationRequestId)}&select=*`,
    });
    const row = rows?.[0];
    if (!row || row.claim_owner !== identity.runnerId || Number(row.claim_epoch) !== identity.claimEpoch
      || Date.parse(row.lease_expires_at || '') <= now().getTime()) {
      throw { code: 409, msg: 'Repair Runner claim lease is not current' };
    }
    const operations = await consoleRequest('module_operation', { query: `operation_id=eq.${encodeURIComponent(row.operation_id)}&select=*` });
    return mappedRequest(row, operations?.[0], null);
  }

  async function authorize(req, remediationRequestId, input) {
    await requireRunner(req);
    const body = closedBody(input, ['runnerId', 'claimEpoch', 'scope', 'bindingDigest']);
    const identity = runnerIdentity(body);
    const request = await loadClaimed(remediationRequestId, identity);
    if (!['source_patch', 'deployment'].includes(body.scope) || !DIGEST.test(String(body.bindingDigest || ''))) {
      throw { code: 400, msg: 'exact Repair Runner authorization scope and binding are required' };
    }
    const [session, approvals] = await Promise.all([
      resolveSession(request.authSessionId, request.actorId),
      consoleRequest('module_operation_approval', {
        query: `operation_id=eq.${encodeURIComponent(request.operationId)}&select=approver_id,assurance,approval_scope,binding_digest,approval_expires_at,revoked_at`,
      }),
    ]);
    return authorizeEngineeringExecution(request, session, (approvals || []).map((row) => ({
      approverId: row.approver_id, assurance: row.assurance, approvalScope: row.approval_scope,
      bindingDigest: row.binding_digest, expiresAt: row.approval_expires_at, revokedAt: row.revoked_at,
    })), body.scope, body.bindingDigest, now().getTime());
  }

  async function heartbeat(req, remediationRequestId, input) {
    await requireRunner(req);
    const identity = runnerIdentity(closedBody(input, ['runnerId', 'claimEpoch']));
    const alive = await osaa('rpc/heartbeat_engineering_remediation', { method: 'POST', body: {
      p_remediation_request_id: remediationRequestId, p_worker: identity.runnerId, p_claim_epoch: identity.claimEpoch,
    } });
    return { alive: alive === true };
  }

  async function transition(req, remediationRequestId, input) {
    await requireRunner(req);
    const body = closedBody(input, ['runnerId', 'claimEpoch', 'expectedStage', 'nextStage', 'evidence']);
    const identity = runnerIdentity(body); const evidence = body.evidence || {};
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || Buffer.byteLength(JSON.stringify(evidence)) > 16 * 1024) throw { code: 400, msg: 'bounded stage evidence object required' };
    const rows = await osaa('rpc/advance_engineering_remediation', { method: 'POST', body: {
      p_remediation_request_id: remediationRequestId, p_worker: identity.runnerId,
      p_claim_epoch: identity.claimEpoch, p_expected_stage: body.expectedStage,
      p_next_stage: body.nextStage, p_evidence: evidence, p_evidence_digest: digest(evidence),
    } });
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async function recordBuild(req, remediationRequestId, input) {
    await requireRunner(req);
    const body = closedBody(input, ['runnerId', 'claimEpoch', 'evidence']);
    const identity = runnerIdentity(body); const request = await loadClaimed(remediationRequestId, identity);
    const evidence = body.evidence || {}; validateBuildEvidence(request, evidence);
    await osaa('rpc/record_engineering_build_evidence', { method: 'POST', body: {
      p_remediation_request_id: remediationRequestId, p_worker: identity.runnerId, p_claim_epoch: identity.claimEpoch,
      p_source_revision: evidence.sourceRevision, p_patch_digest: evidence.patchDigest,
      p_test_evidence: Object.fromEntries((evidence.tests || []).map((item) => [item.id, {
        status: item.status, evidenceDigest: item.evidenceDigest || null,
      }])),
      p_sbom_digest: evidence.sbomDigest || null, p_provenance_digest: evidence.provenanceDigest,
      p_signature_digest: evidence.signatureDigest || null, p_image_digests: evidence.imageDigests,
      p_build_authority: evidence.buildAuthority, p_release_lock_digest: evidence.releaseLockDigest,
    } });
    return { recorded: true, evidenceDigest: digest(evidence) };
  }

  async function recordVerification(req, remediationRequestId, input) {
    await requireRunner(req);
    const body = closedBody(input, ['runnerId', 'claimEpoch', 'evidence']);
    const identity = runnerIdentity(body); const request = await loadClaimed(remediationRequestId, identity);
    const evidence = body.evidence || {};
    await osaa('rpc/record_engineering_deployment_verification', { method: 'POST', body: {
      p_remediation_request_id: remediationRequestId, p_worker: identity.runnerId, p_claim_epoch: identity.claimEpoch,
      p_operation_id: request.operationId, p_expected_image_digests: evidence.expectedImageDigests || [],
      p_observed_image_digests: evidence.observedImageDigests || [], p_expected_lock_digest: evidence.expectedLockDigest || null,
      p_lock_digest: evidence.lockDigest || null, p_api_postcondition: evidence.api || { passed: false },
      p_ui_postcondition: evidence.ui || { passed: false }, p_rollback_verified: evidence.rollbackVerified === true,
      p_status: evidence.status,
    } });
    return { recorded: true };
  }

  async function browserVerification(req, remediationRequestId, input) {
    await requireRunner(req);
    const identity = runnerIdentity(closedBody(input, ['runnerId', 'claimEpoch']));
    const request = await loadClaimed(remediationRequestId, identity);
    const rows = await osaa('engineering_browser_verification', {
      query: `remediation_request_id=eq.${encodeURIComponent(remediationRequestId)}&order=observed_at.desc&limit=1&select=*`,
    });
    const row = rows?.[0];
    if (!row) return { ready: false };
    if (row.operator_id !== request.operatorId || row.verification_profile !== request.verificationProfile
      || row.verification_route !== request.verificationRoute) {
      throw { code: 409, msg: 'browser verification is not bound to the claimed work unit' };
    }
    return {
      ready: true, passed: row.passed === true, evidenceDigest: row.evidence_digest,
      observedSourceRevision: row.observed_source_revision, marker: row.marker,
      consoleErrorCount: row.console_error_count, networkFailureCount: row.network_failure_count,
      observedAt: row.observed_at,
    };
  }

  async function handle(req, res, pathname, bodyReader, json) {
    if (!pathname.startsWith('/api/osaa/remediations/local-edge-runner/')) return false;
    const body = req.method === 'POST' ? await bodyReader(req) : {};
    if (pathname.endsWith('/register') && req.method === 'POST') return json(res, 200, await register(req, body));
    if (pathname.endsWith('/claim') && req.method === 'POST') return json(res, 200, await claim(req, body));
    const match = pathname.match(/\/local-edge-runner\/([0-9a-f-]{36})\/(authorize|heartbeat|stage|build-evidence|verification|browser-verification)$/i);
    if (!match || req.method !== 'POST') return false;
    const actions = { authorize, heartbeat, stage: transition, 'build-evidence': recordBuild,
      verification: recordVerification, 'browser-verification': browserVerification };
    return json(res, 200, await actions[match[2]](req, match[1], body));
  }

  return { register, ready, claim, authorize, heartbeat, transition, recordBuild, recordVerification, browserVerification, handle };
}

module.exports = { createR2d2RepairRunnerApi, runnerIdentity };

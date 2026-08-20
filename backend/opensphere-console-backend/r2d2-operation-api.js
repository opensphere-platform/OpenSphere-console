'use strict';

const { randomUUID } = require('crypto');
const { planOperation, bindOperation, expectedPostcondition, digest } = require('./r2d2-durable-operation');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PFSS_POSTGRES_CREATE_PUBLIC = Object.freeze({
  toolId: 'foundation.postgres.apply',
  semanticIdentity: Object.freeze({
    capabilityId: 'data.sql.postgres', requestType: 'Instance',
    actionId: 'cluster.create', toolId: 'foundation.postgres.apply',
  }),
  actionBinding: Object.freeze({
    method: 'POST', path: '/api/foundation/oaa/postgres/durable-apply/{planId}',
    pathParams: ['planId'], approval: 'exact-confirmation',
  }),
});

function publicPostgresCreateProjection(row) {
  if (row.action !== 'create-postgres-cluster') return {};
  return {
    toolId: PFSS_POSTGRES_CREATE_PUBLIC.toolId,
    semanticIdentity: { ...PFSS_POSTGRES_CREATE_PUBLIC.semanticIdentity },
    actionBinding: { ...PFSS_POSTGRES_CREATE_PUBLIC.actionBinding },
  };
}

function publicOperation(row) {
  const precondition = row.precondition || {};
  const postgresCreate = publicPostgresCreateProjection(row);
  return {
    operationId: row.operation_id, action: row.action, target: precondition.target || null,
    phase: row.phase, executionState: row.execution_state, verificationState: row.verification_state,
    riskClass: row.requested_risk_class || row.risk_class, requiredAssurance: row.required_assurance,
    incidentId: row.incident_id || null, descriptorRevision: row.descriptor_revision,
    toolId: postgresCreate.toolId || row.tool_id, verifierId: row.verifier_id, attempt: Number(row.attempt || 0),
    result: row.result || {}, errorCode: row.error_code || null,
    createdAt: row.created_at, updatedAt: row.updated_at, deadlineAt: row.deadline_at,
    // Immutable plan/action lineage is public evidence, not another plan ledger
    // and never carries an owner response body or credential.
    planId: precondition.planId || null,
    planDigest: precondition.planDigest || null,
    actionDigest: precondition.actionDigest || row.descriptor_digest || null,
    downstreamOperationId: row.downstream_operation_id || row.result?.downstream?.operationId || null,
    downstreamReceipt: row.result?.downstream || null,
    approvalConfirmation: row.phase === 'AwaitingApproval' && row.action !== 'engineering-remediation'
      ? `approve R2D2 operation ${row.operation_id} ${row.descriptor_digest}` : null,
    ...(postgresCreate.semanticIdentity ? {
      semanticIdentity: postgresCreate.semanticIdentity,
      actionBinding: postgresCreate.actionBinding,
    } : {}),
  };
}

function createR2d2OperationApi(options) {
  const { authenticate, store, resolveTarget, enabled = false, now = () => new Date() } = options;

  async function plan(req, body) {
    const auth = await authenticate(req);
    const actor = auth.actor || auth;
    if (typeof resolveTarget !== 'function') throw { code: 503, msg: 'durable target resolver is unavailable' };
    const target = await resolveTarget(String(body?.action || ''), body?.target || {}, auth);
    const planned = planOperation({ action: body?.action, target });
    const output = {
      action: planned.action, descriptorId: planned.descriptorId, descriptorRevision: planned.descriptorRevision,
      descriptorDigest: planned.descriptorDigest, riskClass: planned.riskClass,
      requiredAssurance: planned.requiredAssurance, target: planned.target,
      expectedConfirmation: planned.expectedConfirmation, expectedPostcondition: expectedPostcondition(planned),
    };
    if (planned.action !== 'create-postgres-cluster') return output;
    const actorId = String(actor.sub || actor.subject || '');
    const authSessionId = String(actor.browserSessionId || actor.authSessionId || '');
    if (!UUID.test(actorId) || !UUID.test(authSessionId)) throw { code: 401, msg: 'durable plan requires stable actor and session UUIDs' };
    if (typeof store.insertPlan !== 'function') throw { code: 503, msg: 'durable plan store is unavailable' };
    const expiresAt = new Date(now().getTime() + 15 * 60 * 1000).toISOString();
    const planId = `pgplan-${randomUUID()}`;
    const requestPayload = { action: planned.action, target: body?.target || {}, reason: String(body?.reason || '').trim() };
    if (requestPayload.reason.length < 8) throw { code: 400, msg: 'reason must contain at least eight characters' };
    const planDigest = digest({ actorId, action: planned.action, descriptorDigest: planned.descriptorDigest,
      target: planned.target, requestPayload, expectedPostcondition: output.expectedPostcondition, expiresAt });
    await store.insertPlan({
      plan_id: planId, actor_id: actorId, auth_session_id: authSessionId, action: planned.action,
      descriptor_revision: planned.descriptorRevision, descriptor_digest: planned.descriptorDigest,
      plan_digest: planDigest, target_revision: String(planned.target.resourceVersion || ''),
      risk_class: planned.riskClass, required_assurance: planned.requiredAssurance,
      expected_confirmation: planned.expectedConfirmation, target: planned.target,
      request_payload: requestPayload, expected_postcondition: output.expectedPostcondition,
      expires_at: expiresAt,
    });
    return { ...output, planId, planDigest, expiresAt, targetRevision: String(planned.target.resourceVersion || ''),
      postconditions: [
        'FoundationClaim Bound and observedGeneration equals metadata.generation',
        'PostgresClaim Ready=True and observedGeneration equals metadata.generation',
        'SGCluster Ready=True', 'connection binding Secret issued',
      ] };
  }

  async function accept(req, body) {
    if (!enabled) throw { code: 503, msg: 'R2D2 durable operation execution is not activated' };
    const auth = await authenticate(req);
    const actor = auth.actor || auth;
    const actorId = String(actor.sub || actor.subject || '');
    if (!UUID.test(actorId)) throw { code: 401, msg: 'durable operation requires a stable actor UUID' };
    if (typeof resolveTarget !== 'function') throw { code: 503, msg: 'durable target resolver is unavailable' };
    let requestBody = body || {};
    let storedPlan = null;
    let resolvedTarget = null;
    if (String(body?.planId || '')) {
      if (typeof store.getPlan !== 'function') throw { code: 503, msg: 'durable plan store is unavailable' };
      storedPlan = await store.getPlan(String(body.planId));
      if (!storedPlan) throw { code: 404, msg: 'durable plan not found' };
      if (String(storedPlan.actor_id) !== actorId) throw { code: 403, msg: 'durable plan belongs to a different actor' };
      const authSessionId = String(actor.browserSessionId || actor.authSessionId || '');
      if (!UUID.test(authSessionId) || String(storedPlan.auth_session_id) !== authSessionId) {
        throw { code: 403, msg: 'durable plan belongs to a different authenticated session' };
      }
      if (Date.parse(storedPlan.expires_at) <= now().getTime()) throw { code: 409, msg: 'durable plan expired' };
      const plannedTarget = await resolveTarget(storedPlan.action, storedPlan.request_payload?.target || {}, auth);
      resolvedTarget = plannedTarget;
      const replanned = planOperation({ action: storedPlan.action, target: plannedTarget });
      const recomputedDigest = digest({ actorId, action: replanned.action, descriptorDigest: replanned.descriptorDigest,
        target: replanned.target, requestPayload: storedPlan.request_payload,
        expectedPostcondition: expectedPostcondition(replanned), expiresAt: storedPlan.expires_at });
      if (recomputedDigest !== storedPlan.plan_digest || replanned.descriptorDigest !== storedPlan.descriptor_digest) {
        throw { code: 409, msg: 'durable plan target revision changed; create a new plan' };
      }
      requestBody = { action: storedPlan.action, target: storedPlan.request_payload.target,
        reason: storedPlan.request_payload.reason, confirmation: body.confirmation };
    }
    if (String(requestBody.action || '') === 'create-postgres-cluster' && !storedPlan) {
      throw { code: 409, msg: 'PFSS PostgreSQL create requires an unexpired owner-bound planId' };
    }
    const target = resolvedTarget || await resolveTarget(String(requestBody.action || ''), requestBody.target || {}, auth);
    const bound = bindOperation({ ...requestBody, target });
    const idempotencyKey = storedPlan?.plan_id || String(req.headers['x-os-idempotency-key'] || body?.idempotencyKey || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(idempotencyKey)) throw { code: 400, msg: 'valid idempotency key required' };
    const deadline = new Date(now().getTime() + Math.max(60000, Math.min(3600000, Number(body.deadlineMs || 600000))));
    const approvalRequired = ['R2', 'R3'].includes(bound.riskClass);
    const row = await store.insert({
      operation_id: randomUUID(), idempotency_key: idempotencyKey, module_id: 'r2d2', action: bound.action,
      actor_id: actorId, reason: bound.reason, assurance: actor.assurance || 'aal1', risk_class: bound.riskClass,
      target_fingerprint: digest(bound.target), phase: approvalRequired ? 'AwaitingApproval' : 'Queued',
      descriptor_revision: bound.descriptorRevision, descriptor_digest: bound.descriptorDigest,
      tool_id: bound.toolId, verifier_id: bound.verifierId, target_uid: bound.target.uid,
      target_generation: bound.target.generation, desired_revision: bound.target.desiredRevision,
      requested_risk_class: bound.riskClass, required_assurance: bound.requiredAssurance,
      actor_assurance_at_accept: actor.assurance || 'aal1', auth_session_id: actor.browserSessionId || actor.authSessionId,
      authz_revision: String(actor.credentialRevision || actor.authzRevision || 0),
      deadline_at: deadline.toISOString(), execution_state: approvalRequired ? 'awaiting_approval' : 'accepted',
      verification_state: 'pending', precondition: { target: bound.target, ownerRoute: bound.ownerRoute, requiredPermission: bound.requiredPermission,
        confirmationDigest: bound.confirmationDigest, humanConfirmation: String(body.confirmation),
        ...(storedPlan ? {
          planId: storedPlan.plan_id,
          planDigest: storedPlan.plan_digest,
          actionDigest: bound.descriptorDigest,
        } : { actionDigest: bound.descriptorDigest }),
      },
      expected_postcondition: expectedPostcondition(bound),
      incident_id: UUID.test(String(body.incidentId || '')) ? body.incidentId : null,
    });
    if (storedPlan && typeof store.consumePlan === 'function') {
      const consumed = await store.consumePlan(storedPlan.plan_id, row.operation_id);
      if (!consumed && String(storedPlan.consumed_operation_id || '') !== String(row.operation_id)) {
        throw { code: 409, msg: 'durable plan was already consumed' };
      }
    }
    return publicOperation(row);
  }

  async function approve(req, operationId, body) {
    const auth = await authenticate(req);
    const actor = auth.actor || auth;
    if (actor.assurance !== 'aal2') throw { code: 403, msg: 'AAL2 approval required' };
    const operation = await store.get(operationId);
    if (!operation) throw { code: 404, msg: 'operation not found' };
    if (operation.action === 'engineering-remediation') {
      throw { code: 409, msg: 'Engineering Remediation approval and execution are not activated' };
    }
    if (operation.phase !== 'AwaitingApproval') throw { code: 409, msg: 'operation is not awaiting approval' };
    if (Date.parse(operation.deadline_at || '') <= now().getTime()) throw { code: 409, msg: 'operation deadline exceeded; create a new plan' };
    const approverId = String(actor.sub || actor.subject || '');
    const approverSessionId = String(actor.browserSessionId || actor.authSessionId || '');
    if (!UUID.test(approverId)) throw { code: 401, msg: 'stable approver UUID required' };
    if (!UUID.test(approverSessionId)) throw { code: 401, msg: 'AAL2 approval requires a durable browser session' };
    if (['R2', 'R3'].includes(operation.requested_risk_class || operation.risk_class)
        && approverId === String(operation.actor_id || '')) {
      throw { code: 409, msg: 'R2/R3 operation requires an independent approver' };
    }
    const expected = `approve R2D2 operation ${operationId} ${operation.descriptor_digest}`;
    if (String(body.confirmation || '') !== expected) throw { code: 400, msg: `confirmation required: ${expected}` };
    await store.approve(operationId, { approverId, assurance: 'aal2', authSessionId: approverSessionId,
      authzRevision: String(actor.credentialRevision || actor.authzRevision || 0),
      approvalDigest: digest({ operationId, approverId, descriptorDigest: operation.descriptor_digest, confirmation: body.confirmation }) });
    const approvals = await store.approvals(operationId);
    const required = operation.requested_risk_class === 'R3' ? 2 : 1;
    if (new Set(approvals.filter((item) => !item.revoked_at).map((item) => item.approver_id)).size >= required) await store.queue(operationId);
    return { operationId, approvals: approvals.length, required };
  }

  async function handle(req, res, pathname, bodyReader, json) {
    if (pathname === '/api/oaa/operations/plan' && req.method === 'POST') return json(res, 200, await plan(req, await bodyReader(req)));
    if (pathname === '/api/oaa/operations' && req.method === 'POST') return json(res, 202, await accept(req, await bodyReader(req)));
    if (pathname === '/api/oaa/operations' && req.method === 'GET') {
      await authenticate(req); return json(res, 200, { operations: (await store.list()).map(publicOperation) });
    }
    const approval = pathname.match(/^\/api\/oaa\/operations\/([0-9a-f-]{36})\/approvals$/i);
    if (approval && req.method === 'POST') return json(res, 200, await approve(req, approval[1], await bodyReader(req)));
    const operation = pathname.match(/^\/api\/oaa\/operations\/([0-9a-f-]{36})$/i);
    if (operation && req.method === 'GET') {
      await authenticate(req); const row = await store.get(operation[1]);
      if (!row) return json(res, 404, { error: 'operation not found' });
      return json(res, 200, { ...publicOperation(row), steps: await store.steps(operation[1]), approvals: await store.approvals(operation[1]) });
    }
    return false;
  }

  return { plan, accept, approve, handle, publicOperation };
}

function createRestOperationStore(restRequest) {
  const request = (resource, options = {}) => restRequest(resource, { ...options, profile: 'console' });
  return {
    async insertPlan(row) {
      const rows = await request('module_operation_plan', { method: 'POST', query: 'select=*', body: [row], prefer: 'return=representation' });
      if (!rows?.[0]) throw { code: 503, msg: 'durable plan was not persisted' };
      return rows[0];
    },
    async getPlan(id) {
      const rows = await request('module_operation_plan', { query: `select=*&plan_id=eq.${encodeURIComponent(id)}&limit=1` });
      return rows?.[0] || null;
    },
    async consumePlan(id, operationId) {
      const rows = await request('module_operation_plan', { method: 'PATCH',
        query: `plan_id=eq.${encodeURIComponent(id)}&consumed_operation_id=is.null&select=*`,
        body: { consumed_operation_id: operationId, consumed_at: new Date().toISOString() }, prefer: 'return=representation' });
      if (rows?.[0]) return true;
      const current = await this.getPlan(id);
      return String(current?.consumed_operation_id || '') === String(operationId);
    },
    async insert(row) {
      const rows = await request('module_operation', { method: 'POST', query: 'select=*', body: [row], prefer: 'return=representation,resolution=ignore-duplicates' });
      if (rows?.[0]) return rows[0];
      const existing = await request('module_operation', { query: `select=*&idempotency_key=eq.${encodeURIComponent(row.idempotency_key)}&limit=1` });
      if (!existing?.[0]) throw { code: 503, msg: 'durable operation was not persisted' };
      if (existing[0].actor_id !== row.actor_id || existing[0].action !== row.action || existing[0].target_fingerprint !== row.target_fingerprint) {
        throw { code: 409, msg: 'idempotency key is already bound to a different durable operation' };
      }
      return existing[0];
    },
    async get(id) { const rows = await request('module_operation', { query: `select=*&operation_id=eq.${encodeURIComponent(id)}&limit=1` }); return rows?.[0] || null; },
    async list() { return request('module_operation', { query: 'select=*&order=created_at.desc&limit=100' }); },
    async steps(id) { return request('module_operation_step', { query: `select=*&operation_id=eq.${encodeURIComponent(id)}&order=sequence.asc&limit=500` }); },
    async approvals(id) { return request('module_operation_approval', { query: `select=approver_id,assurance,approval_digest,auth_session_id,authz_revision,approved_at,revoked_at&operation_id=eq.${encodeURIComponent(id)}&order=approved_at.asc` }); },
    async approve(id, item) {
      await request('module_operation_approval', { method: 'POST', body: [{ operation_id: id, approver_id: item.approverId,
        assurance: item.assurance, approval_digest: item.approvalDigest, auth_session_id: item.authSessionId,
        authz_revision: item.authzRevision }], prefer: 'return=minimal,resolution=merge-duplicates' });
    },
    async queue(id) {
      const rows = await request('module_operation', { method: 'PATCH', query: `operation_id=eq.${encodeURIComponent(id)}&phase=eq.AwaitingApproval&select=*`, body: { phase: 'Queued', execution_state: 'accepted', next_attempt_at: new Date().toISOString() }, prefer: 'return=representation' });
      return rows?.[0] || null;
    },
  };
}

const PHASE_TO_DB = Object.freeze({
  claimed: ['Claimed','claimed'], preflighting: ['Preflighting','preflighting'], authorization_expired: ['AuthorizationExpired','authorization_expired'],
  preflight_blocked: ['PreflightBlocked','preflight_blocked'], executing: ['Running','executing'], ambiguous: ['Ambiguous','ambiguous'],
  reconciling: ['Reconciling','reconciling'], verifying: ['Verifying','complete'], succeeded: ['Succeeded','complete'], failed: ['Failed','failed'],
  verification_failed: ['VerificationFailed','complete'], inconclusive: ['Inconclusive','complete'], timed_out: ['TimedOut','timed_out'],
  rolling_back: ['RollingBack','rolling_back'], rolled_back: ['RolledBack','rolled_back'], cancelled: ['Cancelled','cancelled'],
});

function workerOperation(row) {
  return {
    operationId: row.operation_id, phase: row.phase === 'Queued' ? 'accepted' : row.phase === 'AwaitingApproval' ? 'awaiting_approval' : String(row.phase || '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(),
    actorId: row.actor_id, authSessionId: row.auth_session_id, authzRevision: row.authz_revision,
    action: row.action, descriptorDigest: row.descriptor_digest, toolId: row.tool_id, verifierId: row.verifier_id,
    ownerRoute: row.precondition?.ownerRoute, riskClass: row.requested_risk_class, requiredAssurance: row.required_assurance,
    requiredPermission: row.precondition?.requiredPermission,
    confirmation: row.precondition?.humanConfirmation,
    deadlineAt: row.deadline_at,
    target: row.precondition?.target || { uid: row.target_uid, generation: row.target_generation, desiredRevision: row.desired_revision },
    reason: row.reason,
  };
}

function createRestWorkerStore(restRequest, workerId, claimEpoch) {
  const request = (resource, options = {}) => restRequest(resource, { ...options, profile: 'console' });
  return {
    async claim(limit = 10) {
      const rows = await request('rpc/claim_module_operation', { method: 'POST', body: { p_worker: workerId, p_claim_epoch: claimEpoch, p_limit: limit } });
      return (rows || []).map(workerOperation);
    },
    async appendStep(operationId, item) {
      const existing = await request('module_operation_step', { query: `select=sequence&operation_id=eq.${encodeURIComponent(operationId)}&order=sequence.desc&limit=1` });
      const sequence = Number(existing?.[0]?.sequence || 0) + 1;
      await request('module_operation_step', { method: 'POST', body: [{ operation_id: operationId, sequence, attempt: 0, step_type: item.type, status: item.status, evidence: item.evidence || {} }], prefer: 'return=minimal' });
    },
    async heartbeat(operationId) {
      const kept = await request('rpc/heartbeat_module_operation', {
        method: 'POST', body: { p_operation_id: operationId, p_worker: workerId, p_claim_epoch: claimEpoch },
      });
      return kept === true;
    },
    async recordDownstreamIntent(operationId, downstreamKey) {
      const rows = await request('module_operation', {
        method: 'PATCH',
        query: `operation_id=eq.${encodeURIComponent(operationId)}&claim_owner=eq.${encodeURIComponent(workerId)}&claim_epoch=eq.${claimEpoch}&select=operation_id`,
        body: { downstream_idempotency_key: downstreamKey, updated_at: new Date().toISOString() },
        prefer: 'return=representation',
      });
      if (!rows?.[0]) throw Object.assign(new Error('durable operation claim lease was lost'), { code: 'ClaimLeaseLost' });
    },
    async recordDownstreamReceipt(operationId, evidence) {
      const rows = await request('module_operation', {
        method: 'PATCH',
        query: `operation_id=eq.${encodeURIComponent(operationId)}&claim_owner=eq.${encodeURIComponent(workerId)}&claim_epoch=eq.${claimEpoch}&select=operation_id`,
        body: {
          downstream_operation_id: evidence.operationId,
          result: { downstream: evidence },
          updated_at: new Date().toISOString(),
        },
        prefer: 'return=representation',
      });
      if (!rows?.[0]) throw Object.assign(new Error('durable operation claim lease was lost'), { code: 'ClaimLeaseLost' });
      return true;
    },
    async setPhase(operationId, phase) {
      const mapped = PHASE_TO_DB[phase]; if (!mapped) throw new Error(`unmapped operation phase ${phase}`);
      const body = { phase: mapped[0], execution_state: mapped[1], updated_at: new Date().toISOString() };
      if (phase === 'succeeded') body.verification_state = 'succeeded';
      if (phase === 'verification_failed') body.verification_state = 'failed';
      if (phase === 'inconclusive') body.verification_state = 'inconclusive';
      const rows = await request('module_operation', {
        method: 'PATCH',
        query: `operation_id=eq.${encodeURIComponent(operationId)}&claim_owner=eq.${encodeURIComponent(workerId)}&claim_epoch=eq.${claimEpoch}&select=operation_id`,
        body, prefer: 'return=representation',
      });
      if (!rows?.[0]) throw Object.assign(new Error('durable operation claim lease was lost'), { code: 'ClaimLeaseLost' });
    },
    async getApprovals(operationId) {
      const rows = await request('module_operation_approval', { query: `select=approver_id,assurance,auth_session_id,authz_revision,revoked_at&operation_id=eq.${encodeURIComponent(operationId)}` });
      return (rows || []).map((row) => ({ approverId: row.approver_id, assurance: row.assurance,
        authSessionId: row.auth_session_id, authzRevision: row.authz_revision, revokedAt: row.revoked_at }));
    },
  };
}

module.exports = { createR2d2OperationApi, createRestOperationStore, createRestWorkerStore, workerOperation, publicOperation };

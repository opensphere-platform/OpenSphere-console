import { payloadDigest } from '../../../packages/operation-receipt/src/operation-receipt.mjs';
import { authorizeOperation } from '../../../packages/authz/src/authorize-operation.mjs';

const ACTION_ID = /^[a-z][a-z0-9.-]{2,127}$/;
const ACTION_VERSION = /^[0-9]+\.[0-9]+$/;

function fail(code, message, status = 422) {
  throw Object.assign(new Error(message), { code, status });
}

function text(value, name, minimum, maximum) {
  const normalized = String(value ?? '').trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    fail('ValidationFailed', name + ' must contain ' + minimum + '..' + maximum + ' characters', 400);
  }
  return normalized;
}

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('ValidationFailed', name + ' must be an object', 400);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail('ValidationFailed', name + ' contains unknown fields: ' + unknown.join(', '), 400);
}

export function indexActionPolicies(catalog) {
  if (catalog?.schemaVersion !== '1.0' || !Array.isArray(catalog.actions)) {
    throw new TypeError('invalid Console action policy catalog');
  }
  const policies = new Map();
  for (const policy of catalog.actions) {
    const key = policy.actionId + '@' + policy.actionVersion;
    if (policies.has(key)) throw new TypeError('duplicate action policy: ' + key);
    if (!ACTION_ID.test(policy.actionId) || !ACTION_VERSION.test(policy.actionVersion)) {
      throw new TypeError('invalid action policy identity: ' + key);
    }
    policies.set(key, Object.freeze({ ...policy, policyRevision: catalog.policyRevision }));
  }
  return policies;
}

export function validateOperationRequest(request) {
  const fields = new Set([
    'schemaVersion', 'actionId', 'actionVersion', 'targetRef', 'payload',
    'reason', 'risk', 'planRevision', 'confirmation',
  ]);
  exactObject(request, fields, 'operation request');
  if (request.schemaVersion !== '1.0') fail('ValidationFailed', 'unsupported operation schemaVersion', 400);
  const actionId = text(request.actionId, 'actionId', 3, 128);
  const actionVersion = text(request.actionVersion, 'actionVersion', 3, 16);
  if (!ACTION_ID.test(actionId) || !ACTION_VERSION.test(actionVersion)) {
    fail('ValidationFailed', 'invalid action identity', 400);
  }
  exactObject(request.payload, new Set(Object.keys(request.payload || {})), 'payload');
  return {
    schemaVersion: '1.0',
    actionId,
    actionVersion,
    targetRef: text(request.targetRef, 'targetRef', 1, 512),
    payload: request.payload,
    reason: text(request.reason, 'reason', 3, 500),
    risk: request.risk,
    planRevision: text(request.planRevision, 'planRevision', 1, 128),
    confirmation: request.confirmation == null ? null : text(request.confirmation, 'confirmation', 1, 500),
  };
}

export function validateApprovalRequest(request) {
  const fields = new Set(['reason', 'approvalRevision', 'expectedStateVersion', 'confirmation']);
  exactObject(request, fields, 'approval request');
  const expectedStateVersion = Number(request.expectedStateVersion);
  if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0) {
    fail('ValidationFailed', 'expectedStateVersion must be a non-negative safe integer', 400);
  }
  return {
    reason: text(request.reason, 'reason', 3, 500),
    approvalRevision: text(request.approvalRevision, 'approvalRevision', 1, 128),
    expectedStateVersion,
    confirmation: request.confirmation == null ? null : text(request.confirmation, 'confirmation', 1, 500),
  };
}

export function validateVerificationRequest(request) {
  exactObject(request, new Set(['expectedStateVersion']), 'verification request');
  const expectedStateVersion = Number(request.expectedStateVersion);
  if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0) {
    fail('ValidationFailed', 'expectedStateVersion must be a non-negative safe integer', 400);
  }
  return { expectedStateVersion };
}

function receipt(record) {
  if (!record) return null;
  return Object.freeze({
    schemaVersion: '1.0',
    operationId: record.operation_id,
    actionId: record.action_id,
    actionVersion: record.action_version,
    actorRef: record.actor_ref,
    targetRef: record.target_ref,
    requiredPermission: record.required_permission,
    payloadDigest: record.payload_digest,
    requestDigest: record.request_digest,
    reason: record.reason,
    risk: record.risk,
    aal: record.aal,
    permissionRevision: String(record.permission_revision),
    approvalRequired: Boolean(record.approval_required),
    approvalRevision: record.approval_revision ?? null,
    planRevision: record.plan_revision,
    idempotencyKey: record.idempotency_key,
    sourceRevision: record.source_revision ?? null,
    ownerRef: record.owner_ref ?? null,
    executionPlan: record.execution_plan ?? null,
    state: record.state,
    stateVersion: Number(record.state_version),
    expectedPostcondition: record.expected_postcondition ?? null,
    observedPostcondition: record.observed_postcondition ?? null,
    error: record.error ?? null,
    createdAt: new Date(record.created_at).toISOString(),
    updatedAt: new Date(record.updated_at).toISOString(),
    correlationId: record.correlation_id,
  });
}

export function createOperationService({ store, policyCatalog, clock = () => new Date() }) {
  if (!store?.accept || !store?.approve || !store?.verify || !store?.get) {
    throw new TypeError('operation store accept/approve/verify/get is required');
  }
  const policies = indexActionPolicies(policyCatalog);

  return Object.freeze({
    assertApprovalAuthority({ session, reason }) {
      const approvalReason = text(reason, 'reason', 3, 500);
      const authorization = authorizeOperation({
        session,
        permission: 'console.operation.approve',
        risk: 'R2',
        reason: approvalReason,
        now: clock(),
      });
      if (!session.sessionId) fail('AuthenticationRequired', 'opaque session id is required', 401);
      const permissionRevision = Number(authorization.permissionRevision);
      const revokeEpoch = Number(session.revokeEpoch);
      if (!Number.isSafeInteger(permissionRevision) || permissionRevision < 0
          || !Number.isSafeInteger(revokeEpoch) || revokeEpoch < 0) {
        fail('AuthenticationRequired', 'session authority revision is invalid', 401);
      }
      return Object.freeze({ actorRef: authorization.actorRef, reason: approvalReason });
    },

    async accept({ session, request, idempotencyKey, correlationId, executionPlan = null }) {
      const validated = validateOperationRequest(request);
      const policy = policies.get(validated.actionId + '@' + validated.actionVersion);
      if (!policy) fail('PolicyRejected', 'operation action is not registered', 422);
      if (validated.risk !== policy.risk) fail('PolicyRejected', 'request risk differs from the registered action policy', 422);
      if (validated.planRevision !== policy.policyRevision) fail('StaleRevision', 'operation policy revision is stale', 409);
      if (!(new RegExp(policy.targetPattern).test(validated.targetRef))) {
        fail('PolicyRejected', 'target is outside the registered action boundary', 422);
      }

      const authorization = authorizeOperation({
        session,
        permission: policy.permission,
        risk: policy.risk,
        reason: validated.reason,
        now: clock(),
      });
      const key = text(idempotencyKey, 'Idempotency-Key', 8, 256);
      const correlation = text(correlationId, 'correlationId', 8, 128);
      if (executionPlan !== null && (!executionPlan || typeof executionPlan !== 'object' || Array.isArray(executionPlan))) {
        fail('ValidationFailed', 'execution plan must be an object', 400);
      }
      if (!session.sessionId) fail('AuthenticationRequired', 'opaque session id is required', 401);
      const permissionRevision = Number(authorization.permissionRevision);
      const revokeEpoch = Number(session.revokeEpoch);
      if (!Number.isSafeInteger(permissionRevision) || permissionRevision < 0
          || !Number.isSafeInteger(revokeEpoch) || revokeEpoch < 0) {
        fail('AuthenticationRequired', 'session authority revision is invalid', 401);
      }

      const accepted = await store.accept({
        sessionId: session.sessionId,
        actorRef: authorization.actorRef,
        expectedPermissionRevision: permissionRevision,
        expectedRevokeEpoch: revokeEpoch,
        requiredPermission: policy.permission,
        actionId: validated.actionId,
        actionVersion: validated.actionVersion,
        targetRef: validated.targetRef,
        payloadDigest: payloadDigest(validated.payload),
        risk: policy.risk,
        reason: validated.reason,
        planRevision: policy.policyRevision,
        approvalRequired: Boolean(policy.approvalRequired),
        idempotencyKey: key,
        correlationId: correlation,
        sourceRevision: null,
        ownerRef: policy.ownerRef,
        expectedPostcondition: null,
        executionPlan,
      });
      return Object.freeze({ receipt: receipt(accepted.operationRecord), replayed: Boolean(accepted.replayed) });
    },

    async approve({ session, operationId, request, idempotencyKey, correlationId }) {
      const validated = validateApprovalRequest(request);
      const authorization = authorizeOperation({
        session,
        permission: 'console.operation.approve',
        risk: 'R2',
        reason: validated.reason,
        now: clock(),
      });
      if (!session.sessionId) fail('AuthenticationRequired', 'opaque session id is required', 401);
      const permissionRevision = Number(authorization.permissionRevision);
      const revokeEpoch = Number(session.revokeEpoch);
      if (!Number.isSafeInteger(permissionRevision) || permissionRevision < 0
          || !Number.isSafeInteger(revokeEpoch) || revokeEpoch < 0) {
        fail('AuthenticationRequired', 'session authority revision is invalid', 401);
      }
      const approved = await store.approve({
        sessionId: session.sessionId,
        actorRef: authorization.actorRef,
        expectedPermissionRevision: permissionRevision,
        expectedRevokeEpoch: revokeEpoch,
        operationId: text(operationId, 'operationId', 1, 128),
        expectedStateVersion: validated.expectedStateVersion,
        reason: validated.reason,
        approvalRevision: validated.approvalRevision,
        confirmation: validated.confirmation,
        idempotencyKey: text(idempotencyKey, 'Idempotency-Key', 8, 256),
        correlationId: text(correlationId, 'correlationId', 8, 128),
      });
      return Object.freeze({ receipt: receipt(approved.operationRecord), replayed: Boolean(approved.replayed) });
    },

    async verify({ session, operationId, request, idempotencyKey, correlationId }) {
      const validated = validateVerificationRequest(request);
      const authorization = authorizeOperation({
        session,
        permission: 'console.operation.verify',
        risk: 'R0',
        reason: '',
        now: clock(),
      });
      if (!session.sessionId) fail('AuthenticationRequired', 'opaque session id is required', 401);
      const permissionRevision = Number(authorization.permissionRevision);
      const revokeEpoch = Number(session.revokeEpoch);
      if (!Number.isSafeInteger(permissionRevision) || permissionRevision < 0
          || !Number.isSafeInteger(revokeEpoch) || revokeEpoch < 0) {
        fail('AuthenticationRequired', 'session authority revision is invalid', 401);
      }
      const verified = await store.verify({
        sessionId: session.sessionId,
        actorRef: authorization.actorRef,
        expectedPermissionRevision: permissionRevision,
        expectedRevokeEpoch: revokeEpoch,
        operationId: text(operationId, 'operationId', 1, 128),
        expectedStateVersion: validated.expectedStateVersion,
        idempotencyKey: text(idempotencyKey, 'Idempotency-Key', 8, 256),
        correlationId: text(correlationId, 'correlationId', 8, 128),
      });
      return Object.freeze({ receipt: receipt(verified.operationRecord), replayed: Boolean(verified.replayed) });
    },

    async get({ session, operationId }) {
      if (!session?.sessionId || !session?.subjectId) fail('AuthenticationRequired', 'active session is required', 401);
      const record = await store.get({
        sessionId: session.sessionId,
        actorRef: session.subjectId,
        operationId: text(operationId, 'operationId', 1, 128),
      });
      if (!record) fail('NotFound', 'operation was not found', 404);
      return receipt(record);
    },
  });
}

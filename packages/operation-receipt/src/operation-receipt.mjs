import { createHash, randomUUID } from 'node:crypto';
import { requireOperationTransition } from '../../domain/src/operation-state.mjs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function payloadDigest(payload) {
  return `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`;
}

export function planOperation(input, clock = () => new Date()) {
  for (const field of ['actionId', 'actionVersion', 'actorRef', 'targetRef', 'planRevision', 'idempotencyKey', 'correlationId']) {
    if (!String(input[field] || '').trim()) throw new TypeError(`${field} is required`);
  }
  const createdAt = clock().toISOString();
  return Object.freeze({
    schemaVersion: '1.0',
    operationId: input.operationId || randomUUID(),
    actionId: input.actionId,
    actionVersion: input.actionVersion,
    actorRef: input.actorRef,
    targetRef: input.targetRef,
    payloadDigest: payloadDigest(input.payload),
    reason: String(input.reason || ''),
    risk: input.risk,
    aal: input.aal || 'aal1',
    approvalRevision: null,
    planRevision: input.planRevision,
    idempotencyKey: input.idempotencyKey,
    sourceRevision: input.sourceRevision || null,
    ownerRef: input.ownerRef || null,
    state: 'Planned',
    expectedPostcondition: input.expectedPostcondition || null,
    observedPostcondition: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    correlationId: input.correlationId,
  });
}

export function transitionOperation(receipt, next, patch = {}, clock = () => new Date()) {
  requireOperationTransition(receipt.state, next);
  return Object.freeze({ ...receipt, ...patch, state: next, updatedAt: clock().toISOString() });
}

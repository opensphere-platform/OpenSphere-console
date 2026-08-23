'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueTransitionForToolResult } = require('./dialogue-transition');

const preparedPlan = {
  domain: 'pfss.postgresql', intent: 'create.plan', phase: 'plan_ready',
  operationRef: null,
};

test('read-only status and capability answers do not destroy a prepared creation plan', () => {
  assert.equal(dialogueTransitionForToolResult({
    schema: 'r2d2.foundation-postgres-status/v1', phase: 'Observed', claimSet: {},
  }, preparedPlan), null);
  assert.equal(dialogueTransitionForToolResult({
    schema: 'r2d2.foundation-postgres-capability-answer/v1', phase: 'Observed', question: 'cluster.create',
  }, preparedPlan), null);
  assert.equal(dialogueTransitionForToolResult({
    schema: 'r2d2.foundation-postgres-operation/v1', phase: 'Observed',
    operationId: '11111111-1111-4111-8111-111111111111',
  }, preparedPlan), null);
});

test('an accepted operation replaces plan state and preserves its operation reference', () => {
  const operationId = '11111111-1111-4111-8111-111111111111';
  const transition = dialogueTransitionForToolResult({
    action: 'binding-execute',
    binding: { toolId: 'osaa.foundation.postgres.claim.create' },
    result: { operationId, target: { namespace: 'opensphere-foundation', name: 'orders-pg' } },
  }, preparedPlan);
  assert.equal(transition.intent, 'create.apply');
  assert.equal(transition.phase, 'operation_accepted');
  assert.equal(transition.operationRef, operationId);
});

test('operation watch keeps the persisted operation reference in off-compatible paths', () => {
  const operationId = '22222222-2222-4222-8222-222222222222';
  const transition = dialogueTransitionForToolResult({
    schema: 'r2d2.foundation-postgres-operation/v1', phase: 'Observed', operationId,
    operationClaim: { operation: { stage: 'Ready' } },
  }, { domain: 'pfss.postgresql', intent: 'create.apply', phase: 'operation_accepted', operationRef: operationId });
  assert.equal(transition.intent, 'operation.watch');
  assert.equal(transition.operationRef, operationId);
});

test('operation watch cannot inject or replace a server-persisted operation reference', () => {
  const persisted = '22222222-2222-4222-8222-222222222222';
  const injected = '33333333-3333-4333-8333-333333333333';
  assert.equal(dialogueTransitionForToolResult({
    schema: 'r2d2.foundation-postgres-operation/v1', phase: 'Observed', operationId: injected,
    operationClaim: { operation: { stage: 'Ready' } },
  }, { domain: 'pfss.postgresql', intent: 'create.apply', phase: 'operation_accepted', operationRef: persisted }), null);
  assert.equal(dialogueTransitionForToolResult({
    schema: 'r2d2.foundation-postgres-operation/v1', phase: 'Observed', operationId: injected,
    operationClaim: { operation: { stage: 'Ready' } },
  }, { domain: 'pfss.postgresql', intent: 'status.read', phase: 'observed', operationRef: null }), null);
});

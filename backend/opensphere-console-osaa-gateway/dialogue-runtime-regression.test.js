'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  guardProviderCurrentFactResponse,
  isCurrentSystemFactQuery,
  isPfssContextualFollowupQuery,
} = require('./dialogue-evidence');
const { dialogueTransitionForToolResult } = require('./dialogue-transition');
const {
  projectVerifiedLiveToolObservation,
  renderVerifiedLiveToolObservation,
} = require('./live-tool-observation');

test('multi-turn PFSS planning survives read-only status and operation observations', () => {
  const plan = dialogueTransitionForToolResult({
    schema: 'r2d2.foundation-postgres-intake/v1',
    phase: 'AwaitingConfirmation',
    request: { name: 'orders-pg', namespace: 'opensphere-foundation' },
    plan: { capabilityBinding: { capabilityRef: 'pfss-capability@revision' } },
  });
  assert.equal(plan.phase, 'plan_ready');
  assert.equal(dialogueTransitionForToolResult({
    schema: 'r2d2.foundation-postgres-status/v1', phase: 'Observed', claimSet: {},
  }, plan), null);
  assert.equal(dialogueTransitionForToolResult({
    schema: 'r2d2.foundation-postgres-operation/v1', phase: 'Observed',
    operationId: '11111111-1111-4111-8111-111111111111',
  }, plan), null);
});

test('persisted PFSS context does not capture a later unknown-service current-fact turn', () => {
  assert.equal(isPfssContextualFollowupQuery('다시 확인해줘'), true);
  assert.equal(isPfssContextualFollowupQuery('Keycloak 지금 정상이야?'), false);
  assert.equal(isCurrentSystemFactQuery('Keycloak 지금 정상이야?'), true);
  const guarded = guardProviderCurrentFactResponse(
    'Keycloak 지금 정상이야?',
    'Keycloak은 현재 정상입니다.',
  );
  assert.equal(guarded.applied, true);
  assert.doesNotMatch(guarded.content, /정상입니다/);
});

test('a real runtime tool observation deterministically answers instead of being erased by the guard', () => {
  const observation = projectVerifiedLiveToolObservation([{
    tool: 'list_kubernetes_resources',
    arguments: { namespace: 'identity', kind: 'pod' },
    result: { ok: true, items: [{ name: 'keycloak-0', ready: true }] },
  }]);
  const content = renderVerifiedLiveToolObservation(observation);
  const guarded = guardProviderCurrentFactResponse('Keycloak 지금 정상이야?', content, {
    verifiedDeterministic: observation.epistemicState === 'known',
  });
  assert.equal(guarded.applied, false);
  assert.match(guarded.content, /keycloak-0/);
});

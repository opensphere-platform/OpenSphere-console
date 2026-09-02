'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildTransition, digest } = require('./dialogue-state');

const identity = {
  conversationId: '8fd10f3b-4f82-4acd-87bc-e81e259578a8',
  ownerId: 'user-123',
};

test('Dialogue State digest is canonical and transition revisions form a chain', () => {
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  const first = buildTransition({
    domain: 'pfss.postgresql', intent: 'create.plan', phase: 'needs_input',
    slots: { name: { value: 'analytics-pg', status: 'validated' } },
    missingSlots: ['storageClass'], capabilityRef: 'pfss.postgresql.cluster.plan@sha256:abc',
  }, identity);
  assert.equal(first.baseRevision, 0);
  assert.equal(first.nextRevision, 1);
  assert.equal(first.delta.prevStateDigest, first.previousDigest);
  const second = buildTransition({
    domain: 'pfss.postgresql', intent: 'create.plan', phase: 'plan_ready',
    slots: {}, missingSlots: [], capabilityRef: 'pfss.postgresql.cluster.plan@sha256:def',
  }, identity, { revision: 1, state_digest: first.stateDigest });
  assert.equal(second.baseRevision, 1);
  assert.equal(second.previousDigest, first.stateDigest);
  assert.notEqual(second.stateDigest, first.stateDigest);
});

test('Dialogue State rejects client-like authority fields and oversized slots', () => {
  assert.throws(() => buildTransition({ domain: 'pfss.postgresql', revision: 99 }, identity), /unsupported/);
  assert.throws(() => buildTransition({
    domain: 'pfss.postgresql', slots: { value: 'x'.repeat(17000) },
  }, identity), /slots exceed/);
});

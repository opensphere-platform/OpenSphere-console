'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateProposalShadow, validateProposal } = require('./dialogue-shadow');

test('proposal shadow accepts only domain, intent and slots', () => {
  assert.equal(validateProposal({ domain: 'pfss.postgresql', intent: 'status.read', slots: {}, operationRef: 'forged' }), null);
  assert.deepEqual(validateProposal({ domain: 'pfss.postgresql', intent: 'status.read', slots: {} }), {
    domain: 'pfss.postgresql', intent: 'status.read', slots: {},
  });
});

test('shadow calls the provider at most once and deterministic state always wins', async () => {
  let calls = 0;
  const deterministic = { domain: 'pfss.postgresql', intent: 'create.plan', slots: {} };
  const result = await evaluateProposalShadow({
    deterministic, enabled: true,
    propose: async () => { calls += 1; return { domain: 'evil', intent: 'create.apply', slots: {} }; },
  });
  assert.equal(calls, 1);
  assert.equal(result.calls, 1);
  assert.equal(result.deterministic, deterministic);
  assert.equal(result.matched, false);
});

test('shadow performs no automatic repair after malformed proposal', async () => {
  let calls = 0;
  const result = await evaluateProposalShadow({
    deterministic: { domain: 'pfss.postgresql', intent: 'status.read', slots: {} }, enabled: true,
    propose: async () => { calls += 1; return 'malformed'; },
  });
  assert.equal(calls, 1);
  assert.equal(result.proposal, null);
});

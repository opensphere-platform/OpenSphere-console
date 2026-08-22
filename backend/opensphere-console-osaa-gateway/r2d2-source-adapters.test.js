'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyProjection, projectAuthorityAdapters } = require('./r2d2-source-adapters');

test('projection classifier keeps Registry, Release, Gitea, HIS and owner authorities distinct', () => {
  assert.equal(classifyProjection({ name: 'main-shell-registry' }), 'registry');
  assert.equal(classifyProjection({ name: 'platform-release' }), 'release');
  assert.equal(classifyProjection({ name: 'gitea-change-control' }), 'gitea');
  assert.equal(classifyProjection({ name: 'his-observability-binding' }), 'his');
  assert.equal(classifyProjection({ name: 'foundation-control-plane' }), 'owner');
});

test('missing adapter is NotConfigured while stale configured adapter is stale', () => {
  const now = Date.parse('2026-08-10T00:10:00Z');
  const batches = projectAuthorityAdapters([{ kind: 'ControlPlaneAuthority', name: 'gitea-change-control',
    observed_at: '2026-08-10T00:00:00Z', expires_at: '2026-08-10T00:05:00Z', payload: {} }], now);
  const gitea = batches.find((item) => item.source === 'gitea');
  const his = batches.find((item) => item.source === 'his');
  assert.equal(gitea.configured, true);
  assert.equal(gitea.epistemicState, 'stale');
  assert.equal(his.configured, false);
  assert.equal(his.blockerCode, 'not_configured');
});

// The canonical source-evidence contract is part of the same source-adapter
// regression group so the root Console test inventory cannot omit it.
require('./source-evidence-contract.test');

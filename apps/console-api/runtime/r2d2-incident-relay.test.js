'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectNotification, IncidentNotificationRelay } = require('../../osaa-gateway/r2d2-incident-relay');

function row(overrides = {}) { return { outbox_id: 'o1', incident_id: 'i1', transition_sequence: 2, event_type: 'incident_resolved', payload: { status: 'resolved', severity: 'warning', primaryNodeId: 'node' }, created_at: '2026-08-10T00:00:00Z', attempt_count: 1, ...overrides }; }

test('material transition maps to stable idempotent notification source', () => {
  const projected = projectNotification(row());
  assert.equal(projected.sourceId, 'i1:2');
  assert.equal(projected.sourceType, 'r2d2_incident');
  assert.equal(projected.route, '/manage/osaa?incident=i1');
  assert.match(projected.evidenceDigest, /^sha256:[0-9a-f]{64}$/);
});

test('relay converges duplicate notification and marks source delivered', async () => {
  const delivered = [];
  const relay = new IncidentNotificationRelay({
    source: { claim: async () => [row()], delivered: async (...args) => delivered.push(args), failed: async () => assert.fail('must not fail') },
    notifications: { upsertBySource: async () => ({ id: 'n1', duplicate: true }) },
  });
  const out = await relay.runOnce();
  assert.equal(out[0].duplicate, true);
  assert.deepEqual(delivered[0].slice(0, 3), ['o1', relay.workerId, 'n1']);
});

test('notification outage retries and eventually dead-letters without changing Incident', async () => {
  const failed = [];
  const relay = new IncidentNotificationRelay({
    maxAttempts: 3,
    source: { claim: async () => [row({ attempt_count: 3 })], delivered: async () => assert.fail('must not deliver'), failed: async (...args) => failed.push(args) },
    notifications: { upsertBySource: async () => { throw Object.assign(new Error('down'), { code: 'NotificationDown' }); } },
  });
  const out = await relay.runOnce();
  assert.equal(out[0].status, 'dead-letter');
  assert.equal(failed[0][3], true);
});

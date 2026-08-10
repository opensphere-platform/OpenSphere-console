'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replayQuery, authorizationFingerprint } = require('./r2d2-sse-contract');

test('incident replay uses a stable timestamp and outbox UUID cursor', () => {
  const first = replayQuery(null, 999);
  assert.match(first.text, /ORDER BY created_at,outbox_id LIMIT \$1/);
  assert.deepEqual(first.values, [200]);

  const resumed = replayQuery({ created_at: '2026-08-10T00:00:00Z', outbox_id: '10000000-0000-4000-8000-000000000001' });
  assert.match(resumed.text, /\(created_at,outbox_id\) > \(\$1,\$2::uuid\)/);
  assert.deepEqual(resumed.values, ['2026-08-10T00:00:00Z', '10000000-0000-4000-8000-000000000001', 200]);
});

test('authorization fingerprint changes on subject, permission revision or groups', () => {
  const baseline = authorizationFingerprint({ sub: 'u-1', authzRevision: '7', groups: ['operators', 'viewers'] });
  assert.equal(baseline, authorizationFingerprint({ sub: 'u-1', authzRevision: '7', groups: ['viewers', 'operators'] }));
  assert.notEqual(baseline, authorizationFingerprint({ sub: 'u-1', authzRevision: '8', groups: ['operators', 'viewers'] }));
  assert.notEqual(baseline, authorizationFingerprint({ sub: 'u-1', authzRevision: '7', groups: ['viewers'] }));
});

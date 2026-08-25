'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyInstallReplay } = require('./extension-install-idempotency');

test('running install replays are blocked while leased and recoverable after expiry', () => {
  const now = Date.parse('2026-08-26T00:10:00.000Z');
  assert.equal(classifyInstallReplay(null, now).state, 'new');
  assert.equal(classifyInstallReplay({ phase: 'Succeeded' }, now).state, 'completed');
  const active = classifyInstallReplay({ phase: 'Running', updated_at: '2026-08-26T00:09:30.000Z' }, now);
  assert.equal(active.state, 'in-flight');
  assert.equal(active.retryAfter, 90);
  assert.equal(classifyInstallReplay({ phase: 'Running', updated_at: '2026-08-26T00:07:00.000Z' }, now).state, 'recoverable');
});

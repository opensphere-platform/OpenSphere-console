'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistryVerifyRateLimiter } = require('./registry-verify-policy');

test('registry verification limiter rejects excess probes and recovers after the window', () => {
  let clock = 1_000;
  const check = createRegistryVerifyRateLimiter({ limit: 2, windowMs: 10_000, now: () => clock });
  assert.equal(check('actor-a').allowed, true);
  assert.equal(check('actor-a').allowed, true);
  assert.deepEqual(check('actor-a'), { allowed: false, retryAfter: 10 });
  assert.equal(check('actor-b').allowed, true);
  clock += 10_001;
  assert.equal(check('actor-a').allowed, true);
});

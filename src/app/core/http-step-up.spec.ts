import test from 'node:test';
import assert from 'node:assert/strict';

import { requestWithStepUp } from './http-step-up.ts';

test('428 is one approval checkpoint and the original command continues once', async () => {
  const preparedIdempotencyKey = 'same-command-key';
  const observedKeys: string[] = [];
  let attempts = 0;
  let approvals = 0;

  const response = await requestWithStepUp(
    async () => {
      attempts += 1;
      observedKeys.push(preparedIdempotencyKey);
      return { status: attempts === 1 ? 428 : 202 };
    },
    async () => { approvals += 1; },
    () => true,
  );

  assert.equal(response.status, 202);
  assert.equal(attempts, 2);
  assert.equal(approvals, 1);
  assert.deepEqual(observedKeys, [preparedIdempotencyKey, preparedIdempotencyKey]);
});

test('a repeated 428 is returned without an approval loop', async () => {
  let attempts = 0;
  const response = await requestWithStepUp(
    async () => { attempts += 1; return { status: 428 }; },
    async () => undefined,
    () => true,
  );
  assert.equal(response.status, 428);
  assert.equal(attempts, 2);
});

test('unauthenticated 428 is not retried', async () => {
  let attempts = 0;
  const response = await requestWithStepUp(
    async () => { attempts += 1; return { status: 428 }; },
    async () => assert.fail('step-up must not be requested without a session'),
    () => false,
  );
  assert.equal(response.status, 428);
  assert.equal(attempts, 1);
});

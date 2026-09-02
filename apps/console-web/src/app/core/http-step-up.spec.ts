import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

test('R2D2 chat owns a bounded long-response timeout and exposes timeout failures', () => {
  const httpSource = fs.readFileSync(path.join(import.meta.dirname, 'http.service.ts'), 'utf8');
  const agentSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'os', 'os-osaa-agent.ts'), 'utf8');
  assert.match(httpSource, /export class HttpRequestTimeoutError/);
  assert.match(httpSource, /timeoutMs\?: number/);
  assert.match(agentSource, /R2D2_CHAT_TIMEOUT_MS = 120000/);
  assert.match(agentSource, /timeoutMs: R2D2_CHAT_TIMEOUT_MS/);
  assert.match(agentSource, /e instanceof HttpRequestTimeoutError/);
});

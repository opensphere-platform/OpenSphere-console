const assert = require('node:assert/strict');
const test = require('node:test');
const { boundedInteger, fetchDupaWithRetry } = require('./dupa-control-proxy');

test('DUPA proxy retries a transport failure inside one finite deadline', async () => {
  let calls = 0;
  const result = await fetchDupaWithRetry({
    fetchImpl: async (_url, init) => {
      calls += 1;
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['x-os-idempotency-key'], 'operation-1234');
      assert.deepEqual(init.body, Buffer.from('same-request'));
      if (calls === 1) throw Object.assign(new TypeError('connect failed'), { cause: { code: 'ETIMEDOUT' } });
      return { ok: true, status: 202 };
    },
    url: 'http://dupa/api/admin/extensions/install',
    method: 'POST',
    headers: { 'x-os-idempotency-key': 'operation-1234' },
    body: Buffer.from('same-request'),
    deadlineMs: 180000,
    maxAttempts: 2,
    now: () => 0,
    sleep: async () => undefined,
    signalFactory: () => undefined,
  });

  assert.equal(result.response.status, 202);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test('DUPA proxy never retries a deadline expiry', async () => {
  let calls = 0;
  await assert.rejects(
    fetchDupaWithRetry({
      fetchImpl: async () => {
        calls += 1;
        throw Object.assign(new Error('deadline'), { name: 'TimeoutError' });
      },
      url: 'http://dupa/api/admin/extensions/install',
      method: 'POST',
      deadlineMs: 180000,
      maxAttempts: 2,
      now: () => 0,
      sleep: async () => undefined,
      signalFactory: () => undefined,
    }),
    (error) => error.code === 504 && error.attempts === 1,
  );
  assert.equal(calls, 1);
});

test('DUPA proxy reports unavailable only after the bounded retry is exhausted', async () => {
  let calls = 0;
  await assert.rejects(
    fetchDupaWithRetry({
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError('connection reset');
      },
      url: 'http://dupa/healthz',
      method: 'GET',
      deadlineMs: 15000,
      maxAttempts: 2,
      now: () => 0,
      sleep: async () => undefined,
      signalFactory: () => undefined,
    }),
    (error) => error.code === 503 && error.attempts === 2,
  );
  assert.equal(calls, 2);
});

test('DUPA retry and deadline values remain finite and clamped', () => {
  assert.equal(boundedInteger('9', 1, 1, 3), 3);
  assert.equal(boundedInteger('-1', 2, 1, 3), 1);
  assert.equal(boundedInteger('not-a-number', 2, 1, 3), 2);
});

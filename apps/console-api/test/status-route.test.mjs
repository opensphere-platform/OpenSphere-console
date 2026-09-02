import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createConsoleApiHandler } from '../src/http-handler.mjs';

async function start(t, resolveSession) {
  const server = createServer(createConsoleApiHandler({ resolveSession }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('target platform status fails closed without a configured observation owner', async (t) => {
  const sessions = [];
  const base = await start(t, async (_request, input) => {
    sessions.push(input);
    return { subjectId: 'operator-1' };
  });
  const response = await fetch(base + '/api/status/api/status', {
    headers: { 'x-os-correlation-id': 'platform-status-correlation-0001' },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    schemaVersion: '1.0',
    code: 'AuthorityUnavailable',
    message: 'Platform status observation owner is not configured',
    retryable: true,
    sideEffect: 'unknown',
    correlationId: 'platform-status-correlation-0001',
    operationId: null,
    details: {
      reasonCode: 'PlatformStatusOwnerUnconfigured',
      authority: 'PlatformStatusObservation',
    },
  });
  assert.deepEqual(sessions, [{ requireCsrf: false, correlationId: 'platform-status-correlation-0001' }]);
});

test('target platform status rejects query input before resolving a session', async (t) => {
  let sessionCalls = 0;
  const base = await start(t, async () => {
    sessionCalls += 1;
    return { subjectId: 'operator-1' };
  });
  const response = await fetch(base + '/api/status/api/status?legacy=true', {
    headers: { 'x-os-correlation-id': 'platform-status-correlation-0002' },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'ValidationFailed');
  assert.equal(sessionCalls, 0);
});

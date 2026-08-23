'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  assertTurnLeaseActive,
  boundedSignal,
  runWithTurnSignal,
} = require('./turn-lease-execution');

test('lease loss aborts an in-flight provider/tool HTTP request and prevents later work', async (t) => {
  const server = http.createServer((_req, _res) => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const controller = new AbortController();
  let reachedPostcondition = false;
  const reason = { code: 409, errorCode: 'conversation_turn_lease_lost', msg: 'fault injected lease loss' };

  const execution = runWithTurnSignal(controller.signal, async () => {
    await fetch(`http://127.0.0.1:${server.address().port}/blocked`, { signal: boundedSignal(5000) });
    assertTurnLeaseActive();
    reachedPostcondition = true;
  });
  setTimeout(() => controller.abort(reason), 25).unref();

  await assert.rejects(execution, (error) => error === reason || error?.errorCode === reason.errorCode);
  assert.equal(reachedPostcondition, false);
});

test('lease loss is visible at synchronous tool boundaries', async () => {
  const controller = new AbortController();
  const reason = { code: 409, errorCode: 'conversation_turn_lease_lost', msg: 'lease lost' };
  await assert.rejects(
    runWithTurnSignal(controller.signal, async () => {
      controller.abort(reason);
      assertTurnLeaseActive();
    }),
    (error) => error === reason,
  );
});

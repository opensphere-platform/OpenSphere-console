'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  assertTurnLeaseActive,
  boundedSignal,
  independentBoundedSignal,
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

test('audit and post-side-effect receipts retain an independent bounded signal after lease loss', async () => {
  const controller = new AbortController();
  await runWithTurnSignal(controller.signal, async () => {
    controller.abort({ errorCode: 'conversation_turn_lease_lost' });
    const receiptSignal = independentBoundedSignal(1000);
    assert.equal(receiptSignal.aborted, false);
  });
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

test('heartbeat detection is capped at ten seconds even when the durable lease is longer', () => {
  const serverSource = readFileSync(join(__dirname, 'server.js'), 'utf8');
  assert.match(serverSource, /Math[.]min\(10000, Math[.]floor\(\(TURN_LEASE_SECONDS \* 1000\) \/ 3\)\)/);
});

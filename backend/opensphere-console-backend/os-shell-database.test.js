'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createOsShellDatabase } = require('./os-shell-database');

const REV1 = `sha256:${'1'.repeat(64)}`;
const REV2 = `sha256:${'2'.repeat(64)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;

function fixture(revisions = [REV1]) {
  const calls = [];
  let revisionIndex = 0;
  const db = createOsShellDatabase({
    now: () => Date.parse('2026-08-15T00:00:00.000Z'),
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes('has_function_privilege')) return { rows: [{ ready: true }] };
      if (text.includes('current_shell_permission_revision')) {
        const value = revisions[Math.min(revisionIndex, revisions.length - 1)];
        revisionIndex += 1;
        return { rows: [{ permission_revision: value }] };
      }
      if (text.includes('consume_shell_attach_ticket')) return { rows: [] };
      if (text.includes('heartbeat_shell_session')) return { rows: [{ renewed: true }] };
      return { rows: [{ session_id: '00000000-0000-0000-0000-000000000001' }] };
    },
  });
  return { calls, db };
}

function binding() {
  return {
    sessionId: '00000000-0000-0000-0000-000000000001',
    browserSessionId: '00000000-0000-0000-0000-000000000002',
    actorId: '00000000-0000-0000-0000-000000000003',
    origin: 'https://console.example.test', aal: 'aal2', generation: 1, fencingEpoch: 2,
  };
}

test('every actor-bound RPC re-reads the uncached permission revision', async () => {
  const { calls, db } = fixture([REV1, REV2]);
  assert.ok(await db.getSession(binding()));
  assert.ok(await db.getSession(binding()));
  assert.equal(calls.filter((call) => call.text.includes('current_shell_permission_revision')).length, 2);
  assert.equal(calls.filter((call) => call.text.includes('get_shell_session'))[0].values[3], REV1);
  assert.equal(calls.filter((call) => call.text.includes('get_shell_session'))[1].values[3], REV2);
});

test('mode health checks the exact login role and every required RPC privilege without invoking it', async () => {
  const { calls, db } = fixture();
  assert.equal(await db.health('gateway'), true);
  const call = calls.at(-1);
  assert.equal(call.values[1], 'opensphere_shell_gateway');
  assert.deepEqual(call.values[0], [
    'console.current_shell_permission_revision(uuid)',
    'console.resolve_shell_attach_binding(text,uuid,uuid,uuid,text,text,text)',
    'console.consume_shell_attach_ticket(text,uuid,uuid,uuid,text,bigint,bigint,text,text,text)',
    'console.revalidate_shell_session(uuid,uuid,uuid,text,bigint,bigint,text,text)',
  ]);
  assert.match(call.text, /has_schema_privilege/);
  assert.match(call.text, /has_function_privilege/);
  assert.doesNotMatch(call.text, /FROM console[.](shell_session|shell_attach_ticket|shell_session_event)/);
  await assert.rejects(() => db.health('unknown'), { code: 'ShellDatabaseContractInvalid' });
});

test('expected permission revision fails before the lifecycle RPC after a role change', async () => {
  const { calls, db } = fixture([REV2]);
  await assert.rejects(() => db.getSession({ ...binding(), permissionRevision: REV1 }), { code: 'PermissionRevisionChanged' });
  assert.equal(calls.length, 1);
});

test('database adapter calls only the closed RPC surface and never raw DML', async () => {
  const { calls, db } = fixture();
  await db.createSession({
    ...binding(), runtimeTemplateRevision: 'shell-runtime-v1',
    idleExpiresAt: '2026-08-15T00:10:00.000Z', absoluteExpiresAt: '2026-08-15T01:00:00.000Z',
    releaseEvidence: {
      releaseEvidenceRef: 'release://edge/202608150900', manifestSha256: DIGEST, keyId: 'edge-local-1',
      runtimeImageDigest: DIGEST, osArtifactDigest: DIGEST, sessionPolicyRevision: 'policy-v1',
    },
  });
  await db.issueAttachTicket({ ...binding(), ticket: Buffer.alloc(32, 7).toString('base64url'), expiresAt: '2026-08-15T00:00:20.000Z' });
  await db.consumeAttachTicket({ ...binding(), ticket: Buffer.alloc(32, 7).toString('base64url'), consumer: 'gateway-1' });
  await db.requestTeardown({ ...binding(), reasonCode: 'UserRequested' });
  await db.heartbeatSession({ ...binding(), worker: 'reconciler-1' });
  await db.transitionSession({ ...binding(), worker: 'reconciler-1', expectedState: 'Pending', nextState: 'Provisioning', reasonCode: 'PodAccepted' });
  for (const call of calls) {
    assert.doesNotMatch(call.text, /\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    assert.match(call.text, /^SELECT /);
  }
});

test('ticket issue is bounded to 30 seconds before reaching PostgreSQL', async () => {
  const { calls, db } = fixture();
  await assert.rejects(() => db.issueAttachTicket({
    ...binding(), ticket: Buffer.alloc(32, 7).toString('base64url'), expiresAt: '2026-08-15T00:00:31.000Z',
  }), { code: 'AttachTicketExpiryInvalid' });
  assert.equal(calls.filter((call) => call.text.includes('issue_shell_attach_ticket')).length, 0);
});

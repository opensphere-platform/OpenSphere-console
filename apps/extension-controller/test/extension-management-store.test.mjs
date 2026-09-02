import assert from 'node:assert/strict';
import test from 'node:test';
import { createExtensionManagementStore } from '../src/extension-management-store.mjs';

const actorRef = '70260000-0000-4000-8000-000000000001';
const correlationId = 'extension-management-correlation-0001';
const eventHash = 'sha256:' + 'a'.repeat(64);

test('management store binds only the four closed target database functions', async () => {
  const calls = [];
  const store = createExtensionManagementStore({
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes('list_presentation_preferences')) {
        return { rows: [{ projection: [{ extensionId: 'metrics', navigation: { icon: 'dashboard', order: 0 } }] }] };
      }
      if (sql.includes('write_presentation_preferences')) {
        return { rows: [{ projection: { items: [{ extensionId: 'metrics', navigation: { icon: 'dashboard', order: 0 } }] } }] };
      }
      if (sql.includes('record_management_event')) {
        return { rows: [{ receipt: { eventId: actorRef, sequenceId: 12, eventHash, occurredAt: '2026-09-02T10:00:00.000Z' } }] };
      }
      if (sql.includes('list_management_events')) {
        return { rows: [{ projection: {
          authority: 'ConsoleAuditLedger',
          items: [{
            time: '2026-09-02T10:00:00.000Z', actor: actorRef, actorId: actorRef,
            action: 'console.extension.enable', target: 'extension:metrics',
            result: 'succeeded', reason: 'activate verified extension',
            opId: actorRef, source: 'C_EXT',
          }],
        } }] };
      }
      throw new Error('unexpected query');
    },
  });
  const preferences = await store.preferences();
  assert.deepEqual(preferences.get('metrics'), { navigation: { icon: 'dashboard', order: 0 } });
  await store.writePreferences({
    actorRef, correlationId,
    updates: [{ extensionId: 'metrics', navigation: { icon: 'dashboard', order: 0 } }],
    reason: 'configure verified navigation',
  });
  const receipt = await store.recordEvent({
    actorRef, correlationId, action: 'console.extension.enable', targetRef: 'extension:metrics',
    outcome: 'succeeded', reason: 'activate verified extension', evidence: { resourceVersion: '12' },
  });
  assert.equal(receipt.eventHash, eventHash);
  const events = await store.events();
  assert.equal(events[0].action, 'console.extension.enable');

  assert.match(calls[0].sql, /console_extension[.]list_presentation_preferences/u);
  assert.match(calls[1].sql, /console_extension[.]write_presentation_preferences/u);
  assert.deepEqual(calls[1].parameters, [
    actorRef, correlationId,
    JSON.stringify([{ extensionId: 'metrics', navigation: { icon: 'dashboard', order: 0 } }]),
    'configure verified navigation',
  ]);
  assert.match(calls[2].sql, /console_extension[.]record_management_event/u);
  assert.match(calls[3].sql, /console_extension[.]list_management_events/u);
  assert.deepEqual(calls[3].parameters, [100]);
});

test('management store rejects malformed preference and event authority projections', async () => {
  const invalidPreference = createExtensionManagementStore({
    async query() {
      return { rows: [{ projection: [{ extensionId: 'metrics', navigation: { icon: '../../secret' } }] }] };
    },
  });
  await assert.rejects(invalidPreference.preferences(), { code: 'AuthorityContractViolation', status: 503 });

  const invalidEvents = createExtensionManagementStore({
    async query() {
      return { rows: [{ projection: {
        authority: 'ProcessMemory',
        items: [{ time: 'never', actor: '', action: '', target: '', result: '', reason: '', opId: '', source: 'legacy' }],
      } }] };
    },
  });
  await assert.rejects(invalidEvents.events(), { code: 'AuthorityContractViolation', status: 503 });
});

test('management store preserves database validation and fail-closed availability errors', async () => {
  const validation = createExtensionManagementStore({
    async query() {
      throw Object.assign(new Error('rejected'), { detail: 'ValidationFailed' });
    },
  });
  await assert.rejects(validation.writePreferences({
    actorRef, correlationId,
    updates: [{ extensionId: 'metrics', navigation: { icon: 'dashboard' } }],
    reason: 'configure verified navigation',
  }), { code: 'ValidationFailed', status: 400, sideEffect: 'none' });

  const unavailable = createExtensionManagementStore({ async query() { throw new Error('database down'); } });
  await assert.rejects(unavailable.events(), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'none' });
  await assert.rejects(unavailable.events(0), { code: 'ValidationFailed', status: 400, sideEffect: 'none' });
});

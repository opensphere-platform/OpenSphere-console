import assert from 'node:assert/strict';
import test from 'node:test';
import { createExtensionManagementOperations } from '../src/extension-management-operations.mjs';

const actor = Object.freeze({
  subjectId: '70260000-0000-4000-8000-000000000001',
  permissions: Object.freeze([
    'console.audit.read', 'console.extension.install', 'console.extension.remove',
  ]),
  permissionRevision: 4,
  revokeEpoch: 1,
  assurance: 'aal2',
});
const correlationId = 'extension-management-correlation-0001';

function fixture(overrides = {}) {
  const calls = [];
  const preferences = new Map([['metrics', { navigation: { icon: 'dashboard', order: 0 } }]]);
  const authority = {
    async catalog(input) { calls.push(['catalog', input]); return [{ name: 'metrics' }]; },
    async registrations() { calls.push(['registrations']); return [{ name: 'metrics' }]; },
    async bindings() { calls.push(['bindings']); return [{ name: 'workforce-cli' }]; },
    async setDesiredState(input) { calls.push(['setDesiredState', input]); return { id: input.id, desiredState: input.desiredState, registrationResourceVersion: '12' }; },
    async rollback(input) { calls.push(['rollback', input]); return { id: input.id, desiredState: 'Enabled', digest: 'sha256:' + 'a'.repeat(64) }; },
    async setBindingEnabled(input) { calls.push(['setBindingEnabled', input]); return { name: input.name, enabled: input.enabled, resourceVersion: '5' }; },
    async navigationInventory() { calls.push(['navigationInventory']); return ['metrics']; },
    ...(overrides.authority || {}),
  };
  const store = {
    async preferences() { calls.push(['preferences']); return preferences; },
    async writePreferences(input) { calls.push(['writePreferences', input]); return preferences; },
    async recordEvent(input) { calls.push(['recordEvent', input]); return { eventHash: 'sha256:' + 'b'.repeat(64) }; },
    async events(limit) { calls.push(['events', limit]); return [{ action: 'console.extension.enable' }]; },
    ...(overrides.store || {}),
  };
  const operations = createExtensionManagementOperations({
    authority, store, clock: () => new Date('2026-09-02T10:00:00.000Z'),
  });
  return { operations, calls };
}

test('read projections require exact Extension or audit permissions and preserve live authority', async () => {
  const { operations, calls } = fixture();
  assert.deepEqual(await operations.catalog({ actor }), {
    items: [{ name: 'metrics' }],
    projection: { ready: true, state: 'live', observedAt: '2026-09-02T10:00:00.000Z', ageSeconds: 0 },
  });
  assert.deepEqual(await operations.registrations({ actor }), {
    items: [{ name: 'metrics' }],
    projection: { ready: true, state: 'live', observedAt: '2026-09-02T10:00:00.000Z', ageSeconds: 0 },
  });
  assert.deepEqual(await operations.bindings({ actor }), { items: [{ name: 'workforce-cli' }] });
  assert.deepEqual(await operations.events({ actor }), { items: [{ action: 'console.extension.enable' }] });
  assert.equal(calls.find(([name]) => name === 'events')[1], 100);

  const denied = { ...actor, permissions: [] };
  await assert.rejects(operations.catalog({ actor: denied }), { code: 'PermissionDenied', status: 403 });
  await assert.rejects(operations.events({ actor: { ...actor, permissions: ['console.extension.install'] } }),
    { code: 'PermissionDenied', status: 403 });
});

test('registration mutation records accepted and succeeded evidence around one RV-bound owner call', async () => {
  const { operations, calls } = fixture();
  const result = await operations.registrationAction({
    actor, id: 'metrics', action: 'disable',
    reason: 'disable for planned maintenance', correlationId,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.desiredState, 'Disabled');
  assert.deepEqual(calls.map(([name]) => name), ['recordEvent', 'setDesiredState', 'recordEvent']);
  assert.equal(calls[0][1].action, 'console.extension.disable');
  assert.equal(calls[0][1].outcome, 'accepted');
  assert.equal(calls[1][1].actorRef, actor.subjectId);
  assert.equal(calls[2][1].outcome, 'succeeded');

  const rollback = fixture();
  await rollback.operations.registrationAction({
    actor, id: 'metrics', action: 'rollback',
    reason: 'restore previously verified release', correlationId,
  });
  assert.equal(rollback.calls.some(([name]) => name === 'rollback'), true);
  assert.equal(rollback.calls.some(([name]) => name === 'setDesiredState'), false);
});

test('mutation denies missing permission or aal2 before audit and Kubernetes authority', async () => {
  const { operations, calls } = fixture();
  await assert.rejects(operations.registrationAction({
    actor: { ...actor, permissions: ['console.extension.install'] },
    id: 'metrics', action: 'disable', reason: 'disable for maintenance', correlationId,
  }), { code: 'PermissionDenied', status: 403 });
  await assert.rejects(operations.registrationAction({
    actor: { ...actor, assurance: 'aal1' },
    id: 'metrics', action: 'enable', reason: 'enable after maintenance', correlationId,
  }), { code: 'StepUpRequired', status: 428 });
  assert.equal(calls.length, 0);
});

test('owner mutation failures append failed or unknown evidence without hiding side-effect state', async () => {
  const none = fixture({
    authority: {
      async setDesiredState() {
        throw Object.assign(new Error('conflict'), { code: 'WriteConflict', status: 409, sideEffect: 'none' });
      },
    },
  });
  await assert.rejects(none.operations.registrationAction({
    actor, id: 'metrics', action: 'enable', reason: 'enable after maintenance', correlationId,
  }), { code: 'WriteConflict', sideEffect: 'none' });
  assert.equal(none.calls.at(-1)[1].outcome, 'failed');

  const present = fixture({
    authority: {
      async rollback() {
        throw Object.assign(new Error('partial'), { code: 'AuthorityUnavailable', status: 503, sideEffect: 'present' });
      },
    },
  });
  await assert.rejects(present.operations.registrationAction({
    actor, id: 'metrics', action: 'rollback', reason: 'restore previously verified release', correlationId,
  }), { code: 'AuthorityUnavailable', sideEffect: 'present' });
  assert.equal(present.calls.at(-1)[1].outcome, 'unknown');
});

test('navigation and Binding mutations require current inventory and persist only closed updates', async () => {
  const { operations, calls } = fixture();
  assert.deepEqual(await operations.setNavigation({
    actor, id: 'metrics', settings: { icon: 'chart-line', labelOverride: 'Metrics' }, correlationId,
  }), { accepted: true, id: 'metrics', navigation: { icon: 'dashboard', order: 0 } });
  const write = calls.find(([name]) => name === 'writePreferences')[1];
  assert.deepEqual(write.updates, [{ extensionId: 'metrics', navigation: { icon: 'chart-line', labelOverride: 'Metrics' } }]);

  const ordered = fixture({
    authority: { async navigationInventory() { return ['audit', 'metrics']; } },
    store: {
      async writePreferences(input) {
        assert.deepEqual(input.updates, [
          { extensionId: 'metrics', navigation: { order: 0 } },
          { extensionId: 'audit', navigation: { order: 1 } },
        ]);
        return new Map();
      },
    },
  });
  assert.deepEqual(await ordered.operations.setNavigationOrder({
    actor, ids: ['metrics', 'audit'], correlationId,
  }), { accepted: true, ids: ['metrics', 'audit'] });

  const binding = fixture();
  assert.equal((await binding.operations.bindingAction({
    actor, name: 'workforce-cli', action: 'disable', correlationId,
  })).enabled, false);
  assert.deepEqual(binding.calls.map(([name]) => name), ['recordEvent', 'setBindingEnabled', 'recordEvent']);

  const mismatch = fixture({ authority: { async navigationInventory() { return ['other']; } } });
  await assert.rejects(mismatch.operations.setNavigation({
    actor, id: 'metrics', settings: { icon: 'chart-line' }, correlationId,
  }), { code: 'NavigationInventoryMismatch', status: 409 });
  await assert.rejects(mismatch.operations.setNavigationOrder({
    actor, ids: ['metrics'], correlationId,
  }), { code: 'NavigationInventoryMismatch', status: 409 });
});

test('audit completion failure after Kubernetes success is reported with present side effect', async () => {
  let event = 0;
  const { operations } = fixture({
    store: {
      async recordEvent() {
        event += 1;
        if (event === 2) throw new Error('audit unavailable');
        return {};
      },
    },
  });
  await assert.rejects(operations.registrationAction({
    actor, id: 'metrics', action: 'enable', reason: 'enable after maintenance', correlationId,
  }), { code: 'AuditUnavailable', status: 503, sideEffect: 'present' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionRouteTarget, prioritizeRequestedHost } from './extension-load-order.ts';

const registry = [
  { id: 'cluster-manager', hostRef: 'main' },
  { id: 'foundation', hostRef: 'main' },
  { id: 'postgres', hostRef: 'foundation' },
  { id: 'gitlab', hostRef: 'main' },
];

test('canonical plugin deep links identify both host and child ownership', () => {
  assert.deepEqual(extensionRouteTarget('/p/foundation/postgres/install'), {
    hostId: 'foundation',
    childId: 'postgres',
  });
  assert.deepEqual(extensionRouteTarget('/pfss/postgres/admin'), {
    hostId: 'foundation',
    childId: 'postgres',
  });
  assert.deepEqual(extensionRouteTarget('/pfss/foundation'), {
    hostId: 'foundation',
    childId: '',
  });
  assert.deepEqual(extensionRouteTarget('/manage/extensions/plugins'), { hostId: '', childId: '' });
});

test('cold extension activation prioritizes only the requested main subShell', () => {
  assert.deepEqual(
    prioritizeRequestedHost(registry, '/p/foundation/postgres').map((entry) => entry.id),
    ['foundation', 'cluster-manager', 'postgres', 'gitlab'],
  );
  assert.deepEqual(
    prioritizeRequestedHost(registry, '/pfss/postgres/admin').map((entry) => entry.id),
    ['foundation', 'cluster-manager', 'postgres', 'gitlab'],
  );
  assert.deepEqual(
    prioritizeRequestedHost(registry, '/manage/extensions/subshells').map((entry) => entry.id),
    registry.map((entry) => entry.id),
  );
});

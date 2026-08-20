import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConsoleNavigationSnapshot,
  parseConsoleNavigationSnapshot,
  parseStoredConsoleNavigationSnapshot,
} from './console-navigation-snapshot.ts';

const sha = 'a'.repeat(64);
const inventory = [
  { id: 'ai-workbench', title: 'AI-Workbench', navBand: '지능 Intelligence', hostRef: 'main', kind: 'subShell' as const, icon: 'application' },
  { id: 'postgres', title: 'Postgres', navBand: '운영 Operate', hostRef: 'foundation', kind: 'plugin' as const, icon: 'datastore' },
];
const registry = [
  { id: 'ai-workbench', manifestSha256: sha, hostRef: 'main', componentKind: 'subShell' as const, icon: 'grid' },
  { id: 'postgres', manifestSha256: sha, hostRef: 'foundation', componentKind: 'plugin' as const, icon: 'datastore' },
];

test('atomic navigation projection includes first-level subShells without activating guests', () => {
  const snapshot = buildConsoleNavigationSnapshot(registry, inventory, 'registry-v1', '2026-08-21T00:00:00.000Z');
  assert.deepEqual(snapshot.items, [{
    id: 'ai-workbench',
    title: 'AI-Workbench',
    navBand: '지능 Intelligence',
    route: '/p/ai-workbench',
    icon: 'application',
    manifestSha256: sha,
  }]);
});

test('stored navigation projection is closed and canonical', () => {
  const snapshot = buildConsoleNavigationSnapshot(registry, inventory, 'registry-v1', '2026-08-21T00:00:00.000Z');
  assert.deepEqual(parseStoredConsoleNavigationSnapshot(JSON.stringify(snapshot)), snapshot);
  assert.equal(parseConsoleNavigationSnapshot({ ...snapshot, authority: 'guest' }), null);
  assert.equal(parseConsoleNavigationSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], route: '/manage/roles' }] }), null);
  assert.equal(parseConsoleNavigationSnapshot({ ...snapshot, items: [snapshot.items[0], snapshot.items[0]] }), null);
  assert.equal(parseStoredConsoleNavigationSnapshot('{broken'), null);
});

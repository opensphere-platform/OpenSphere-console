import test from 'node:test';
import assert from 'node:assert/strict';

import { buildExtensionManagementViews } from './extension-view-model.ts';

test('subShells and plugins are separate management views and plugins group by host', () => {
  const catalog = [
    { name: 'cluster-manager', displayName: 'Cluster Manager', kind: 'subShell' as const, hostRef: 'main' },
    { name: 'foundation', displayName: 'Platform Foundation Service Stack', kind: 'subShell' as const, hostRef: 'main' },
    { name: 'postgres', displayName: 'PostgreSQL', kind: 'plugin' as const, hostRef: 'foundation' },
  ];
  const registrations = [{ name: 'postgres' }, { name: 'cluster-manager' }, { name: 'foundation' }];

  const views = buildExtensionManagementViews(catalog, registrations);
  assert.deepEqual(views.subShells.map((item) => item.name), ['cluster-manager', 'foundation']);
  assert.equal(views.pluginGroups.length, 1);
  assert.equal(views.pluginGroups[0].hostRef, 'foundation');
  assert.equal(views.pluginGroups[0].hostLabel, 'Platform Foundation Service Stack');
  assert.deepEqual(views.pluginGroups[0].items.map((item) => item.name), ['postgres']);
  assert.deepEqual(views.unclassified, []);
});

test('missing catalog identity is explicit unclassified data, never promoted to a shell or plugin', () => {
  const views = buildExtensionManagementViews([], [{ name: 'unknown-extension' }]);
  assert.deepEqual(views.subShells, []);
  assert.deepEqual(views.pluginGroups, []);
  assert.deepEqual(views.unclassified, [{ name: 'unknown-extension' }]);
});

test('plugin with an unknown hostRef is a contract violation, never attached to mainShell', () => {
  const catalog = [
    { name: 'postgres', displayName: 'PostgreSQL', kind: 'plugin' as const, hostRef: 'missing-host' },
  ];
  const registration = { name: 'postgres' };
  const views = buildExtensionManagementViews(catalog, [registration]);

  assert.deepEqual(views.pluginGroups, []);
  assert.deepEqual(views.unclassified, [registration]);
});

test('subShell management rows follow the persisted navigation order', () => {
  const catalog = [
    { name: 'alpha', displayName: 'Alpha', kind: 'subShell' as const, hostRef: 'main', nav: { order: 8 } },
    { name: 'zeta', displayName: 'Zeta', kind: 'subShell' as const, hostRef: 'main', nav: { order: 1 } },
  ];
  const views = buildExtensionManagementViews(catalog, [{ name: 'alpha' }, { name: 'zeta' }]);
  assert.deepEqual(views.subShells.map((item) => item.name), ['zeta', 'alpha']);
});

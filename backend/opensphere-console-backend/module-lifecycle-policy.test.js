'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isDevelopmentEdgeRuntime,
  moduleLifecycleRequiresRecentAal2,
  readInstallationPolicy,
} = require('./module-lifecycle-policy');

const localEdge = {
  channel: 'edge',
  authEnvironment: 'development',
  consoleUrl: 'https://localhost:1114',
};

test('development edge installation policy bypasses MFA only for install and update actions', () => {
  assert.equal(isDevelopmentEdgeRuntime(localEdge, 'https://localhost:1114'), true);
  for (const action of ['install', 'reinstall', 'update', 'upgrade']) {
    assert.equal(moduleLifecycleRequiresRecentAal2(action, localEdge, 'https://localhost:1114'), false);
  }
  for (const action of ['enable', 'disable', 'uninstall', 'rollback', 'verify', 'delete-runtime']) {
    assert.equal(moduleLifecycleRequiresRecentAal2(action, localEdge, 'https://localhost:1114'), true);
  }
});

test('GA, non-development, remote URL and missing policy all fail closed', () => {
  assert.equal(moduleLifecycleRequiresRecentAal2('install', { ...localEdge, channel: 'ga' }, 'https://localhost:1114'), true);
  assert.equal(moduleLifecycleRequiresRecentAal2('install', { ...localEdge, authEnvironment: 'production' }, 'https://localhost:1114'), true);
  assert.equal(moduleLifecycleRequiresRecentAal2('install', localEdge, 'https://console.example.com'), true);
  assert.equal(moduleLifecycleRequiresRecentAal2('install', {}, 'https://localhost:1114'), true);
});

test('installation policy parser is bounded to the non-secret deployment identity fields', () => {
  const policy = readInstallationPolicy('ignored', () => JSON.stringify({
    channel: 'EDGE',
    authEnvironment: 'Development',
    consoleUrl: 'https://localhost:1114',
    initialAdmin: { email: 'must-not-be-projected@example.test' },
  }));
  assert.deepEqual(policy, localEdge);
  assert.deepEqual(readInstallationPolicy('missing', () => { throw new Error('missing'); }), {
    channel: '', authEnvironment: '', consoleUrl: '',
  });
});

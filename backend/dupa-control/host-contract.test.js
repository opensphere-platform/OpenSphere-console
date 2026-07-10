const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validContributions, validCapabilities, integrationStatuses } = require('./controller.js');

const contributions = {
  page: { enabled: true },
  navigation: { enabled: true, mode: 'runtime' },
  api: { enabled: true, basePath: '/api/plugins/sample' },
  cli: { enabled: false, reason: 'not shipped' },
  manual: { enabled: false, mode: 'none', reason: 'not shipped' },
  search: { enabled: false, mode: 'none', reason: 'not shipped' },
  notification: { enabled: false, frontend: false, backend: false, reason: 'not shipped' },
  observability: { enabled: true, logs: true, metrics: true, traces: false },
};

test('Host Contract contributions require explicit disabled reasons', () => {
  assert.equal(validContributions(contributions), true);
  assert.equal(validContributions({ ...contributions, cli: { enabled: false } }), false);
});

test('Host Contract rejects enabled API outside the same-origin API plane', () => {
  assert.equal(validContributions({ ...contributions, api: { enabled: true, basePath: 'https://example.test' } }), false);
});

test('runtime contributions require the matching closed-set capability', () => {
  assert.equal(validCapabilities({ permissions: ['api:proxy', 'page:register', 'nav:contribute'], contributions }), true);
  assert.equal(validCapabilities({ permissions: [], contributions }), false);
  assert.equal(validCapabilities({ permissions: ['api:proxy', 'unknown:scope'], contributions }), false);
});

test('integration status exposes Ready and Disabled independently', () => {
  const status = integrationStatuses({ spec: { version: '1.0.0', contributions } }, 'Activated', false, '2026-07-10T00:00:00.000Z');
  assert.equal(status.page.phase, 'Ready');
  assert.equal(status.cli.phase, 'Disabled');
  assert.equal(status.logs.phase, 'Ready');
  assert.equal(status.traces.phase, 'Disabled');
});

test('release lifecycle retains a verified previous release and exposes rollback', () => {
  const controller = fs.readFileSync(path.join(__dirname, 'controller.js'), 'utf8');
  const crd = fs.readFileSync(path.join(__dirname, 'ui-plugin-crds.yaml'), 'utf8');
  assert.match(controller, /previousDigest/);
  assert.match(controller, /previousManifestSha256/);
  assert.match(controller, /install\|enable\|disable\|uninstall\|rollback/);
  assert.match(controller, /verified previous release is unavailable/);
  assert.match(crd, /previousDigest:/);
  assert.match(crd, /previousManifestSha256:/);
});

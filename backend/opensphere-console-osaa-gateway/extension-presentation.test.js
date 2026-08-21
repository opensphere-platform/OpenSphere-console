'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { projectExtensionPresentation } = require('./extension-presentation');

function registry(overrides = {}) {
  return {
    version: 3,
    plugins: [
      { id: 'foundation', name: 'Platform Foundation Service Stack', kind: 'subShell', hostRef: 'main', available: true },
      {
        id: 'postgres', name: 'PostgreSQL', kind: 'plugin', hostRef: 'foundation', available: true,
        contributions: {
          navigation: { enabled: false, reason: 'Foundation owns child navigation' },
          page: { enabled: false, reason: 'Mounted inside the Foundation subShell' },
        },
        ...overrides,
      },
    ],
  };
}

test('host-owned navigation remains eligible while child UI activation is on demand', () => {
  const out = projectExtensionPresentation(registry());
  assert.equal(out.diagnosis, 'HOST_NAVIGATION_LAZY_UI_SEPARATION');
  assert.deepEqual(out.summary, { total: 1, menuEligible: 1, onDemandUi: 1, blocked: 0 });
  assert.equal(out.items[0].expectedRoute, '/pfss/postgres');
  assert.equal(out.items[0].menuEligibility, 'Eligible');
  assert.equal(out.items[0].uiActivation, 'OnDemand');
  assert.equal(out.items[0].browserVisibilityVerified, false);
  assert.equal(out.items[0].lifecycleMutationRequired, false);
  assert.match(out.interpretation, /메뉴 미노출을 뜻하지 않습니다/);
});

test('real Registry or host blockers are reported without proposing blind lifecycle mutation', () => {
  const input = registry({ available: false, contributions: {} });
  input.plugins[0].available = false;
  const out = projectExtensionPresentation(input);
  assert.equal(out.diagnosis, 'EXTENSION_PRESENTATION_BLOCKED');
  assert.equal(out.summary.blocked, 1);
  assert.match(out.items[0].blockers.join(' / '), /unavailable/);
  assert.match(out.items[0].blockers.join(' / '), /navigation contract/);
  assert.match(out.mutationSafety, /일괄 enable\/restart\/reinstall을 실행하지 마십시오/);
});

test('Gateway runtime image carries the presentation classifier required by server.js', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY extension-presentation\.js \/app\/extension-presentation\.js/);
});

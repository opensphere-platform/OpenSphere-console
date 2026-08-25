'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveAdminControlEnforcement } = require('./admin-extension-route-policy');

test('canonical and deprecated credential deletion receive identical R2 and recent-AAL2 enforcement', () => {
  const canonical = resolveAdminControlEnforcement('/api/admin/extensions/registry-connections/opensphere-ghcr', 'DELETE');
  const legacy = resolveAdminControlEnforcement('/api/admin/extensions/registry-credentials', 'DELETE');
  for (const policy of [canonical, legacy]) {
    assert.equal(policy.permission, 'console.extension.security.manage');
    assert.equal(policy.risk, 'R2');
    assert.equal(policy.requireAal2, true);
  }
});

test('unknown administrator mutations remain fail-closed at R2 with recent AAL2', () => {
  const policy = resolveAdminControlEnforcement('/api/admin/unknown-mutation', 'POST');
  assert.equal(policy.permission, 'console.admin');
  assert.equal(policy.risk, 'R2');
  assert.equal(policy.requireAal2, true);
});

test('development edge install is honestly classified R1 while other environments remain R2', () => {
  const edge = resolveAdminControlEnforcement('/api/admin/extensions/install', 'POST', () => false);
  const governed = resolveAdminControlEnforcement('/api/admin/extensions/install', 'POST', () => true);
  assert.deepEqual({ risk: edge.risk, requireAal2: edge.requireAal2 }, { risk: 'R1', requireAal2: false });
  assert.deepEqual({ risk: governed.risk, requireAal2: governed.requireAal2 }, { risk: 'R2', requireAal2: true });
});

test('Console enforcement point consumes the declared permission before proxying', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const actorResolution = source.indexOf('actor = session.actor');
  const permissionGate = source.indexOf('requireActorPermission(actor, routePolicy.permission)');
  const proxyFetch = source.indexOf('fetch(`${DUPA_CONTROL_URL}${url.pathname}${url.search}`');
  assert.ok(actorResolution >= 0 && permissionGate > actorResolution && proxyFetch > permissionGate);
});

test('Backend runtime image contains the route and idempotency policy modules', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY opensphere-console-backend\/admin-extension-route-policy\.js/);
  assert.match(dockerfile, /COPY opensphere-console-backend\/extension-install-idempotency\.js/);
});

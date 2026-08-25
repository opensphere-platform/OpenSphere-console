'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('Extension administration declares permission, risk, and AAL policy as route metadata', () => {
  assert.match(source, /ADMIN_CONTROL_ROUTE_POLICIES/);
  assert.match(source, /extensions\.registry\.write[\s\S]*risk: 'R2'[\s\S]*requireAal2: true/);
  assert.match(source, /extensions\.registry\.delete[\s\S]*risk: 'R3'[\s\S]*requireAal2: true/);
  assert.match(source, /extensions\.trust\.revoke[\s\S]*risk: 'R3'[\s\S]*requireAal2: true/);
  assert.match(source, /'x-os-required-permission': routePolicy\.permission/);
  assert.match(source, /'x-os-risk-class': routePolicy\.risk/);
});

test('unknown administrator mutations remain fail-closed at AAL2', () => {
  assert.match(source, /requireAal2: !\['GET', 'HEAD'\]\.includes\(method\)/);
});

test('Extension install consumes the existing durable operation ledger', () => {
  assert.match(source, /function extensionInstallLedgerIntent/);
  assert.match(source, /restRequest\('module_operation'/);
  assert.match(source, /module_id: 'extension-catalog', action: 'install'/);
  assert.match(source, /existing\.target_fingerprint !== intent\.targetFingerprint/);
  assert.match(source, /errorCode: 'IdempotencyConflict'/);
  assert.match(source, /duplicate: true/);
  assert.doesNotMatch(source, /CREATE TABLE[\s\S]*extension_install/i);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enforcePatRequestScope, normalizePatScope, requiredPatScope, validatePatTTL } = require('./cli-token-policy');

const request = (method, url) => ({ method, url, headers: { host: 'console.test' } });
const actor = (scope) => ({ cliCredentialType: 'pat', cliScope: scope });

test('PAT scope defaults to read and validates explicit authority', () => {
  assert.equal(normalizePatScope(undefined), 'console-read');
  assert.equal(normalizePatScope('change'), 'console-change');
  assert.equal(normalizePatScope('admin'), 'console-admin');
  assert.throws(() => normalizePatScope('owner'), (error) => error.code === 400);
});

test('PAT TTL defaults to one day and is bounded by server maximum', () => {
  assert.equal(validatePatTTL(undefined, 30 * 86400), 86400);
  assert.equal(validatePatTTL(300, 30 * 86400), 300);
  assert.throws(() => validatePatTTL(299, 30 * 86400), (error) => error.code === 400);
  assert.throws(() => validatePatTTL(31 * 86400, 30 * 86400), (error) => error.code === 400);
});

test('read, governed-change, and admin requests require increasing PAT authority', () => {
  assert.equal(requiredPatScope(request('GET', '/api/catalog/entities')), 'console-read');
  assert.equal(requiredPatScope(request('POST', '/api/platform/changes')), 'console-change');
  assert.equal(requiredPatScope(request('POST', '/api/platform/changes/id/approve')), 'console-change');
  assert.equal(requiredPatScope(request('DELETE', '/api/identity/cli/devices/id')), 'console-admin');
  assert.doesNotThrow(() => enforcePatRequestScope(request('GET', '/api/catalog/entities'), actor('console-read')));
  assert.throws(() => enforcePatRequestScope(request('POST', '/api/platform/changes'), actor('console-read')), (error) => error.code === 403);
  assert.doesNotThrow(() => enforcePatRequestScope(request('POST', '/api/platform/changes'), actor('console-change')));
  assert.throws(() => enforcePatRequestScope(request('DELETE', '/api/identity/cli/devices/id'), actor('console-change')), (error) => error.code === 403);
  assert.doesNotThrow(() => enforcePatRequestScope(request('DELETE', '/api/identity/cli/devices/id'), actor('console-admin')));
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createConsoleIdentityVerifier } = require('./console-identity-client');

test('target Owner identity verifies through C_API and derives closed Console groups', async () => {
  const calls = [];
  const verify = createConsoleIdentityVerifier({
    baseUrl: 'http://opensphere-console-api.test', targetOwnerAdmission: true,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return new Response(JSON.stringify({ data: {
        subjectId: '11111111-1111-4111-8111-111111111111',
        permissions: ['console.role.admin', 'console.audit.read'], groups: ['untrusted-group'], aal: 'aal2', permissionRevision: '7',
      } }), { status: 200 });
    },
  });
  const actor = await verify({ headers: { authorization: 'Bearer ' + 'a.b.c'.padEnd(32, 'x') } });
  assert.equal(actor.provider, 'console-target-session');
  assert.equal(actor.subject, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(actor.groups, ['console-admins']);
  assert.deepEqual(actor.permissions, ['console.audit.read', 'console.role.admin']);
  assert.equal(calls[0].url, 'http://opensphere-console-api.test/api/identity/me');
  assert.equal(calls[0].options.headers['x-os-owner-admission'], 'osaa-gateway-v1');
});

test('legacy identity path remains available until the atomic browser cutover', async () => {
  const verify = createConsoleIdentityVerifier({
    baseUrl: 'http://opensphere-console-backend.test',
    async fetchImpl(url, options) {
      assert.equal(url, 'http://opensphere-console-backend.test/api/identity/session');
      assert.equal(Object.hasOwn(options.headers, 'x-os-owner-admission'), false);
      return new Response(JSON.stringify({
        subject: 'legacy-user', groups: ['console-operators'], permissions: ['catalog:read'], assurance: 'aal1',
      }), { status: 200 });
    },
  });
  const actor = await verify({ headers: { authorization: 'Bearer ' + 'legacy-token-value'.padEnd(32, 'x') } });
  assert.equal(actor.provider, 'supabase');
  assert.equal(actor.username, 'legacy-user');
});

test('target Owner identity fails closed on missing authority coordinates', async () => {
  const verify = createConsoleIdentityVerifier({
    baseUrl: 'http://opensphere-console-api.test', targetOwnerAdmission: true,
    async fetchImpl() {
      return new Response(JSON.stringify({ data: { subjectId: 'subject', permissions: [], aal: 'aal1' } }), { status: 200 });
    },
  });
  await assert.rejects(verify({ headers: { authorization: 'Bearer ' + 'x'.repeat(32) } }), { code: 503 });
});

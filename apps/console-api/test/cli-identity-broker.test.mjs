import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createCliIdentityBroker } from '../src/cli-identity-broker.mjs';
import { createConsoleApiHandler } from '../src/http-handler.mjs';

const enrollmentId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const challengeId = '33333333-3333-4333-8333-333333333333';
const subjectId = '44444444-4444-4444-8444-444444444444';
const sessionId = '55555555-5555-4555-8555-555555555555';
const now = new Date('2026-09-02T01:00:00.000Z');

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function identityStore(overrides = {}) {
  return {
    async createCliDeviceEnrollment() { throw new Error('unexpected create enrollment'); },
    async getCliDeviceEnrollment() { throw new Error('unexpected get enrollment'); },
    async approveCliDeviceEnrollment() { throw new Error('unexpected approve enrollment'); },
    async pollCliDeviceEnrollment() { throw new Error('unexpected poll enrollment'); },
    async createCliDeviceChallenge() { throw new Error('unexpected create challenge'); },
    async getCliDeviceChallenge() { throw new Error('unexpected get challenge'); },
    async completeCliDeviceSession() { throw new Error('unexpected complete session'); },
    async listOwnedCliDevices() { throw new Error('unexpected browser list'); },
    async revokeOwnedCliDevice() { throw new Error('unexpected browser revoke'); },
    async listOwnedCliDevicesWithCliSession() { throw new Error('unexpected CLI list'); },
    async revokeOwnedCliDeviceWithCliSession() { throw new Error('unexpected CLI revoke'); },
    ...overrides,
  };
}

test('interactive CLI flow stores digests, verifies the Go-compatible P-256 proof, and issues a short session', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const calls = [];
  let randomCall = 0;
  const store = identityStore({
    async createCliDeviceEnrollment(input) {
      calls.push({ name: 'createEnrollment', input });
      return { enrollmentId, expiresAt: new Date(now.getTime() + 300_000).toISOString() };
    },
    async getCliDeviceEnrollment(input) {
      calls.push({ name: 'getEnrollment', input });
      return { enrollmentId, label: 'operator-laptop', status: 'pending' };
    },
    async approveCliDeviceEnrollment(input) {
      calls.push({ name: 'approveEnrollment', input });
      return { deviceId, label: 'operator-laptop', fingerprint: 'aa:bb', replayed: false };
    },
    async pollCliDeviceEnrollment(input) {
      calls.push({ name: 'pollEnrollment', input });
      return { status: 'approved', deviceId, label: 'operator-laptop', fingerprint: 'aa:bb' };
    },
    async createCliDeviceChallenge(input) {
      calls.push({ name: 'createChallenge', input });
      return { challengeId, expiresAt: new Date(now.getTime() + 60_000).toISOString() };
    },
    async getCliDeviceChallenge(input) {
      calls.push({ name: 'getChallenge', input });
      return { deviceId, subjectId, challengeId, publicJwk };
    },
    async completeCliDeviceSession(input) {
      calls.push({ name: 'completeSession', input });
      return { sessionId, subjectId, deviceId, expiresAt: input.expiresAt };
    },
  });
  const resolveSession = async (_request, options) => ({
    sessionId, subjectId, permissionRevision: 4, revokeEpoch: 2, options,
  });
  const broker = createCliIdentityBroker({
    store, resolveSession, publicOrigin: 'https://console.example.test', clock: () => now,
    randomBytes(size) { randomCall += 1; return Buffer.alloc(size, randomCall * 17); },
  });

  const enrollment = await broker.createEnrollment({ body: { label: 'operator-laptop', publicJwk } });
  assert.equal(enrollment.userCode, '11111111');
  assert.equal(enrollment.pollInterval, 2);
  assert.equal(enrollment.verificationUriComplete,
    `https://console.example.test/me?tab=credentials&cli_enrollment=${enrollmentId}&code=11111111`);
  assert.deepEqual(calls[0].input.userCodeDigest, sha256(enrollment.userCode));
  assert.deepEqual(calls[0].input.pollTokenDigest, sha256(enrollment.pollToken));
  assert.equal(JSON.stringify(calls[0]).includes(enrollment.pollToken), false);

  await broker.getEnrollment({ headers: {} }, { enrollmentId, userCode: enrollment.userCode });
  await broker.approveEnrollment({ headers: {} }, {
    enrollmentId, body: { userCode: enrollment.userCode }, correlationId: 'cli-approve-test-0001',
  });
  const polled = await broker.pollEnrollment({ enrollmentId, body: { pollToken: enrollment.pollToken } });
  assert.equal(polled.deviceId, deviceId);

  const challenge = await broker.createChallenge({ body: { deviceId } });
  const message = `opensphere-cli-session-v2\n${deviceId}\n${challengeId}\n${challenge.nonce}`;
  const signature = sign('sha256', Buffer.from(message, 'utf8'), privateKey).toString('base64url');
  const issued = await broker.createSession({
    body: { deviceId, challengeId, nonce: challenge.nonce, signature },
    correlationId: 'cli-session-test-0001',
  });
  assert.equal(issued.expiresIn, 900);
  assert.match(issued.accessToken, /^[A-Za-z0-9_-]{43}$/u);
  const completion = calls.find(({ name }) => name === 'completeSession').input;
  assert.deepEqual(completion.tokenDigest, sha256(issued.accessToken));
  assert.equal(JSON.stringify(completion).includes(issued.accessToken), false);
});

test('CLI bearer selects digest-only device management while browser requests keep CSRF-bound RPCs', async () => {
  const calls = [];
  const token = 'A'.repeat(43);
  const store = identityStore({
    async listOwnedCliDevicesWithCliSession(input) { calls.push(['cli-list', input]); return { devices: [] }; },
    async revokeOwnedCliDeviceWithCliSession(input) { calls.push(['cli-revoke', input]); return { deviceId, auditEventId: 'audit-1' }; },
    async listOwnedCliDevices(input) { calls.push(['browser-list', input]); return { devices: [] }; },
    async revokeOwnedCliDevice(input) { calls.push(['browser-revoke', input]); return { deviceId, auditEventId: 'audit-2' }; },
  });
  let browserResolutions = 0;
  const broker = createCliIdentityBroker({
    store, publicOrigin: 'https://console.example.test',
    resolveSession: async () => {
      browserResolutions += 1;
      return { sessionId, subjectId, permissionRevision: 4, revokeEpoch: 2 };
    },
  });
  const bearerRequest = { headers: { authorization: 'Bearer ' + token } };
  await broker.listDevices(bearerRequest);
  await broker.revokeDevice(bearerRequest, {
    deviceId, body: { reason: 'operator revoked this device' }, correlationId: 'cli-revoke-test-0001',
  });
  assert.deepEqual(calls[0][1].tokenDigest, sha256(token));
  assert.deepEqual(calls[1][1].tokenDigest, sha256(token));
  assert.equal(browserResolutions, 0);

  await broker.listDevices({ headers: {} });
  await broker.revokeDevice({ headers: {} }, {
    deviceId, body: { reason: 'operator revoked this device' }, correlationId: 'browser-revoke-test-0001',
  });
  assert.equal(browserResolutions, 2);
  assert.deepEqual(calls.map(([name]) => name), ['cli-list', 'cli-revoke', 'browser-list', 'browser-revoke']);
});

test('CLI HTTP surface delegates enrollment, proof, introspection, and device routes', async (t) => {
  const delegated = [];
  const cliIdentityBroker = {
    async createEnrollment(options) { delegated.push(['create', options]); return { enrollmentId }; },
    async getEnrollment(_request, options) { delegated.push(['get', options]); return { enrollmentId }; },
    async pollEnrollment(options) { delegated.push(['poll', options]); return { status: 'pending' }; },
    async approveEnrollment(_request, options) { delegated.push(['approve', options]); return { deviceId }; },
    async createChallenge(options) { delegated.push(['challenge', options]); return { challengeId }; },
    async createSession(options) { delegated.push(['session', options]); return { accessToken: 'A'.repeat(43), expiresIn: 900 }; },
    async listDevices(_request, options) { delegated.push(['devices', options]); return { devices: [] }; },
    async revokeDevice(_request, options) { delegated.push(['revoke', options]); return { deviceId }; },
  };
  const handler = createConsoleApiHandler({
    resolveSession: async () => ({
      subjectId, deviceId, permissions: ['console.role.admin'], credentialType: 'cli-device',
      expiresAt: '2026-09-02T01:15:00.000Z',
    }),
    operationService: {}, registryOperations: {}, auditOperations: {}, identityOperations: {},
    identitySessionBroker: {}, cliIdentityBroker, dataIdentityOperations: {},
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/identity/cli';
  const json = { 'content-type': 'application/json', 'x-os-correlation-id': 'cli-http-test-0001' };
  const requests = [
    fetch(base + '/enrollments', { method: 'POST', headers: json, body: JSON.stringify({ label: 'laptop', publicJwk: {} }) }),
    fetch(base + `/enrollments/${enrollmentId}?code=11111111`, { headers: json }),
    fetch(base + `/enrollments/${enrollmentId}/poll`, { method: 'POST', headers: json, body: JSON.stringify({ pollToken: 'p' }) }),
    fetch(base + `/enrollments/${enrollmentId}/approve`, { method: 'POST', headers: json, body: JSON.stringify({ userCode: '11111111' }) }),
    fetch(base + '/challenge', { method: 'POST', headers: json, body: JSON.stringify({ deviceId }) }),
    fetch(base + '/session', { method: 'POST', headers: json, body: JSON.stringify({}) }),
    fetch(base + '/introspect', { headers: { authorization: 'Bearer ' + 'A'.repeat(43) } }),
    fetch(base + '/devices', { headers: json }),
    fetch(base + `/devices/${deviceId}`, { method: 'DELETE', headers: json, body: JSON.stringify({ reason: 'revoke test device' }) }),
  ];
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map(({ status }) => status), [201, 200, 202, 200, 200, 200, 200, 200, 204]);
  assert.deepEqual(delegated.map(([name]) => name).sort(), [
    'approve', 'challenge', 'create', 'devices', 'get', 'poll', 'revoke', 'session',
  ]);
  const introspection = await responses[6].json();
  assert.deepEqual(introspection.groups, ['console-admins']);
  assert.equal(introspection.type, 'cli');
  const browserIntrospection = await fetch(base + '/introspect', {
    headers: { cookie: '__Host-opensphere-session=browser-proof' },
  });
  assert.equal(browserIntrospection.status, 401);
});

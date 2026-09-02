import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createConsoleApiHandler } from '../src/http-handler.mjs';
import { createIdentitySessionBroker } from '../src/identity-session-broker.mjs';
import { avatarObjectPath, avatarProjection, validateAvatarSelection, validateAvatarUpload } from '../src/profile-avatar.mjs';
import { createSupabaseAuthClient } from '../src/supabase-auth-client.mjs';
import { createSupabaseStorageClient } from '../src/supabase-storage-client.mjs';
import { createPostgresOperationStore } from '../src/postgres-operation-store.mjs';

const now = new Date('2026-09-02T00:00:00.000Z');
const subjectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function token() {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: subjectId, role: 'authenticated', aal: 'aal1', exp: Math.floor(now.getTime() / 1000) + 900,
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

test('profile avatar input is bounded, magic-checked, and linked selection is exact', () => {
  const upload = validateAvatarUpload({ contentType: 'image/png', dataBase64: png.toString('base64') });
  assert.equal(upload.bytes.length, png.length);
  assert.equal(upload.digest, `sha256:${createHash('sha256').update(png).digest('hex')}`);
  assert.throws(() => validateAvatarUpload({ contentType: 'image/png', dataBase64: Buffer.from('bad').toString('base64') }), { code: 'ValidationFailed' });
  const linkedAccounts = [{ provider: 'github', url: 'https://avatars.example.test/u/1' }];
  assert.deepEqual(validateAvatarSelection({ source: 'linked', ...linkedAccounts[0] }, linkedAccounts), { source: 'linked', ...linkedAccounts[0] });
  assert.throws(() => validateAvatarSelection({ source: 'linked', provider: 'github', url: 'https://evil.example.test/u' }, linkedAccounts), { code: 'ValidationFailed' });
  assert.equal(avatarObjectPath(subjectId), `avatars/${subjectId}/profile`);
  assert.throws(() => avatarObjectPath('../../admin'), { code: 'ValidationFailed' });
});

test('profile avatar projection trusts only registered HTTPS identities and valid Auth metadata', () => {
  const user = { identities: [
    { provider: 'github', identity_data: { avatar_url: 'https://avatars.example.test/u/1#fragment' } },
    { provider: 'google', identity_data: { picture: 'http://insecure.example.test/u/1' } },
  ], user_metadata: {} };
  assert.deepEqual(avatarProjection(user).current, {
    source: 'linked', provider: 'github', url: 'https://avatars.example.test/u/1', digest: null, contentType: null,
  });
  user.user_metadata.console_avatar = { source: 'initial' };
  assert.equal(avatarProjection(user).current.source, 'initial');
});

test('Supabase Auth avatar metadata uses only the current subject access credential', async () => {
  const accessToken = token();
  let metadata = { source: 'initial' };
  const calls = [];
  const client = createSupabaseAuthClient({
    baseUrl: 'http://supabase-auth.test', now: () => now,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      assert.equal(init.headers.authorization, `Bearer ${accessToken}`);
      assert.equal(Object.hasOwn(init.headers, 'apikey'), false);
      if (init.method === 'PUT') metadata = JSON.parse(init.body).data.console_avatar;
      return new Response(JSON.stringify({ id: subjectId, identities: [], user_metadata: { console_avatar: metadata } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal((await client.readProfileAvatar({ accessToken, expectedSubjectId: subjectId })).projection.current.source, 'initial');
  const digest = `sha256:${'a'.repeat(64)}`;
  const updated = await client.updateProfileAvatar({
    accessToken, expectedSubjectId: subjectId, metadata: { source: 'upload', digest, contentType: 'image/webp' },
  });
  assert.equal(updated.projection.current.digest, digest);
  assert.equal(calls.length, 2);
});

test('Supabase Storage adapter fixes the private bucket, subject path, service credential, and size bound', async () => {
  const key = 's'.repeat(64);
  const calls = [];
  const client = createSupabaseStorageClient({
    baseUrl: 'http://supabase-storage.test', serviceRoleKey: key,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      if (init.method === 'GET') return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await client.upsertAvatar({ subjectId, bytes: png, contentType: 'image/png' });
  const stored = await client.readAvatar({ subjectId });
  await client.deleteAvatar({ subjectId });
  assert.deepEqual(stored, { bytes: png, contentType: 'image/png' });
  assert(calls.every(({ url }) => url === `http://supabase-storage.test/object/console-uploads/avatars/${subjectId}/profile`));
  assert(calls.every(({ init }) => init.headers.apikey === key && init.headers.authorization === `Bearer ${key}`));
  assert.equal(calls[0].init.headers['x-upsert'], 'true');
});

test('PostgreSQL avatar preparation binds only proof digests, closed operation, and correlation', async () => {
  const tokenDigest = Buffer.alloc(32, 1);
  const csrfTokenDigest = Buffer.alloc(32, 2);
  let observed;
  const store = createPostgresOperationStore({
    async query(sql, values) {
      observed = { sql, values };
      return { rows: [{ avatar_record: { sessionId, subjectId, accessTokenCiphertext: 'cipher', auditEventId: '1' } }] };
    },
  });
  await store.prepareOwnedProfileAvatarAccess({
    tokenDigest, csrfTokenDigest, operation: 'upload', correlationId: 'avatar-upload-0001',
  });
  assert.match(observed.sql, /prepare_owned_profile_avatar_access/);
  assert.deepEqual(observed.values, [tokenDigest, csrfTokenDigest, 'upload', 'avatar-upload-0001']);
});

test('profile avatar broker persists mutation intent and verifies stored bytes against Auth digest', async () => {
  const operations = [];
  let projection = avatarProjection({ identities: [], user_metadata: { console_avatar: { source: 'initial' } } });
  let stored;
  const requiredStore = {
    async resolveSession() { return { sessionId, subjectId, expiresAt: '2026-09-03T00:00:00.000Z', authorityFresh: true, permissions: [], permissionRevision: '1', revokeEpoch: '0', aal: 'aal1' }; },
    async prepareOwnedProfileAvatarAccess(input) { operations.push(input.operation); return { sessionId, subjectId, accessTokenCiphertext: 'cipher', ...(input.operation === 'upload' || input.operation === 'select' ? { auditEventId: '1' } : {}) }; },
    async issueSession() {}, async getPendingMfa() {}, async activateMfa() {}, async getRefreshCredentials() {},
    async rotateCredentials() {}, async rejectRefresh() {}, async touchActivity() {}, async listOwnedSessions() {},
    async revokeOwnedSession() {}, async revokeAllOwnedSessions() {},
  };
  const authClient = {
    async authenticatePassword() {}, async completeTotp() {}, async refreshSession() {}, async logout() {},
    async readProfileAvatar() { return { subjectId, projection }; },
    async updateProfileAvatar({ metadata }) { projection = avatarProjection({ identities: [], user_metadata: { console_avatar: metadata } }); return { subjectId, projection }; },
  };
  const storageClient = {
    async upsertAvatar(value) { stored = value; }, async deleteAvatar() { stored = undefined; },
    async readAvatar() { return { bytes: stored.bytes, contentType: stored.contentType }; },
  };
  const broker = createIdentitySessionBroker({
    store: requiredStore, authClient, storageClient,
    credentialCipher: { encrypt(value) { return value; }, decrypt() { return token(); } },
    publicOrigin: 'https://console.example.test', clock: () => now,
  });
  const request = { headers: { cookie: `__Host-opensphere-session=${'h'.repeat(32)}`, 'x-os-csrf-token': 'c'.repeat(16) } };
  const uploaded = await broker.uploadProfileAvatar(request, {
    body: { contentType: 'image/png', dataBase64: png.toString('base64') }, correlationId: 'avatar-upload-0001',
  });
  const content = await broker.readProfileAvatarContent(request, { digest: uploaded.current.digest, correlationId: 'avatar-read-0001' });
  assert.deepEqual(content.bytes, png);
  assert.deepEqual(operations, ['upload', 'content']);
});

test('HTTP profile avatar routes preserve JSON and binary response boundaries', async (t) => {
  const digest = `sha256:${createHash('sha256').update(png).digest('hex')}`;
  const projection = { current: { source: 'upload', provider: null, url: `/api/identity/profile/avatar/content?v=${encodeURIComponent(digest)}`, digest, contentType: 'image/png' }, linkedAccounts: [] };
  const broker = {
    async getProfileAvatar() { return projection; }, async selectProfileAvatar() { return projection; },
    async uploadProfileAvatar() { return projection; }, async readProfileAvatarContent() { return { bytes: png, contentType: 'image/png', digest }; },
  };
  const handler = createConsoleApiHandler({ resolveSession: async () => ({}), identitySessionBroker: broker });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const uploaded = await fetch(base + '/api/identity/profile/avatar/upload', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentType: 'image/png', dataBase64: png.toString('base64') }),
  });
  assert.equal(uploaded.status, 200);
  const content = await fetch(base + `/api/identity/profile/avatar/content?v=${encodeURIComponent(digest)}`);
  assert.equal(content.headers.get('cache-control'), 'private, max-age=300, must-revalidate');
  assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), png);
});

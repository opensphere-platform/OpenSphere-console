'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AVATAR_MAX_BYTES,
  avatarObjectPath,
  avatarProjection,
  linkedAvatarCandidates,
  validateAvatarSelection,
  validateAvatarUpload,
} = require('./profile-avatar');

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const throwsMessage = (operation, pattern) => assert.throws(operation, (error) => pattern.test(String(error?.msg || error)));

test('linked avatar candidates are provider-bound HTTPS URLs only', () => {
  const candidates = linkedAvatarCandidates({ identities: [
    { provider: 'github', identity_data: { avatar_url: 'https://avatars.example.test/u/1#fragment' } },
    { provider: 'google', identity_data: { picture: 'http://insecure.example.test/photo' } },
    { provider: 'custom', identity_data: { picture: 'https://user:secret@example.test/photo' } },
  ] });
  assert.deepEqual(candidates, [{ provider: 'github', url: 'https://avatars.example.test/u/1' }]);
});

test('avatar projection falls back when linked metadata is stale or malformed', () => {
  assert.equal(avatarProjection({ user_metadata: { console_avatar: { source: 'linked', provider: 'github', url: 'https://old.invalid/p' } } }).current.source, 'initial');
  const upload = avatarProjection({ user_metadata: { console_avatar: { source: 'upload', digest: `sha256:${'a'.repeat(64)}`, contentType: 'image/webp' } } });
  assert.equal(upload.current.url, `/api/identity/profile/avatar/content?v=sha256%3A${'a'.repeat(64)}`);
});

test('a registered avatar account is connected by default while explicit initials remain sticky', () => {
  const identity = { provider: 'github', identity_data: { avatar_url: 'https://avatars.example.test/u/1' } };
  assert.equal(avatarProjection({ identities: [identity], user_metadata: {} }).current.source, 'linked');
  assert.equal(avatarProjection({ identities: [identity], user_metadata: { console_avatar: { source: 'initial' } } }).current.source, 'initial');
});

test('avatar upload is closed, bounded, canonical, and magic-checked', () => {
  const valid = validateAvatarUpload({ contentType: 'image/png', dataBase64: png.toString('base64') });
  assert.equal(valid.bytes.length, png.length);
  assert.match(valid.digest, /^sha256:[a-f0-9]{64}$/);
  throwsMessage(() => validateAvatarUpload({ contentType: 'image/png', dataBase64: png.toString('base64'), name: 'x' }), /requires exactly/);
  throwsMessage(() => validateAvatarUpload({ contentType: 'image/svg+xml', dataBase64: png.toString('base64') }), /PNG, JPEG, or WebP/);
  throwsMessage(() => validateAvatarUpload({ contentType: 'image/png', dataBase64: Buffer.from('not png').toString('base64') }), /does not match/);
  throwsMessage(() => validateAvatarUpload({ contentType: 'image/png', dataBase64: Buffer.alloc(AVATAR_MAX_BYTES + 1).toString('base64') }), /at most/);
});

test('linked selection must match a currently registered identity exactly', () => {
  const linked = [{ provider: 'github', url: 'https://avatars.example.test/u/1' }];
  assert.deepEqual(validateAvatarSelection({ source: 'linked', ...linked[0] }, linked), { source: 'linked', ...linked[0] });
  assert.deepEqual(validateAvatarSelection({ source: 'initial' }, linked), { source: 'initial' });
  throwsMessage(() => validateAvatarSelection({ source: 'linked', provider: 'github', url: 'https://evil.example.test/u' }, linked), /not a currently linked/);
});

test('avatar object path is owner-scoped and rejects noncanonical subjects', () => {
  assert.equal(avatarObjectPath('00000000-0000-4000-8000-000000000001'), 'avatars/00000000-0000-4000-8000-000000000001/profile');
  throwsMessage(() => avatarObjectPath('../../admin'), /canonical user id/);
});

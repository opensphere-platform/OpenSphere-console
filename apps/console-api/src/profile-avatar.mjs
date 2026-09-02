import { createHash } from 'node:crypto';

export const AVATAR_METADATA_KEY = 'console_avatar';
export const AVATAR_BUCKET = 'console-uploads';
export const AVATAR_MAX_BYTES = 160 * 1024;
export const AVATAR_CONTENT_TYPES = new Set(['image/webp', 'image/png', 'image/jpeg']);

function fail(message) {
  throw Object.assign(new Error(message), { code: 'ValidationFailed', status: 400 });
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function httpsAvatarUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch { return ''; }
}

export function linkedAvatarCandidates(user) {
  const result = [];
  const seen = new Set();
  for (const identity of Array.isArray(user?.identities) ? user.identities : []) {
    if (!plainObject(identity)) continue;
    const provider = String(identity.provider || '').trim().toLowerCase();
    const data = plainObject(identity.identity_data) ? identity.identity_data : {};
    const url = httpsAvatarUrl(data.avatar_url || data.picture);
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(provider) || !url) continue;
    const key = provider + '\n' + url;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(Object.freeze({ provider, url }));
  }
  return Object.freeze(result.slice(0, 8));
}

export function avatarObjectPath(subjectId) {
  const subject = String(subjectId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(subject)) {
    fail('avatar owner is not a canonical subject');
  }
  return `avatars/${subject}/profile`;
}

export function avatarProjection(user) {
  const linkedAccounts = linkedAvatarCandidates(user);
  const metadata = plainObject(user?.user_metadata) ? user.user_metadata[AVATAR_METADATA_KEY] : null;
  if (plainObject(metadata) && metadata.source === 'upload') {
    const digest = String(metadata.digest || '');
    const contentType = String(metadata.contentType || '');
    if (/^sha256:[a-f0-9]{64}$/u.test(digest) && AVATAR_CONTENT_TYPES.has(contentType)) {
      return Object.freeze({ current: Object.freeze({
        source: 'upload', provider: null,
        url: `/api/identity/profile/avatar/content?v=${encodeURIComponent(digest)}`,
        digest, contentType,
      }), linkedAccounts });
    }
  }
  if (plainObject(metadata) && metadata.source === 'linked') {
    const provider = String(metadata.provider || '');
    const url = httpsAvatarUrl(metadata.url);
    const exact = linkedAccounts.find((candidate) => candidate.provider === provider && candidate.url === url);
    if (exact) return Object.freeze({ current: Object.freeze({ source: 'linked', ...exact, digest: null, contentType: null }), linkedAccounts });
  }
  if (metadata == null && linkedAccounts[0]) {
    return Object.freeze({ current: Object.freeze({ source: 'linked', ...linkedAccounts[0], digest: null, contentType: null }), linkedAccounts });
  }
  return Object.freeze({ current: Object.freeze({ source: 'initial', provider: null, url: null, digest: null, contentType: null }), linkedAccounts });
}

export function validateAvatarSelection(body, linkedAccounts) {
  if (!plainObject(body) || !Array.isArray(linkedAccounts)) fail('avatar selection is invalid');
  if (body.source === 'initial' && Object.keys(body).length === 1) return Object.freeze({ source: 'initial' });
  if (body.source !== 'linked' || Object.keys(body).length !== 3
      || !Object.hasOwn(body, 'provider') || !Object.hasOwn(body, 'url')) {
    fail('avatar selection requires initial or an exact linked account');
  }
  const provider = String(body.provider || '');
  const url = httpsAvatarUrl(body.url);
  const exact = linkedAccounts.find((candidate) => candidate.provider === provider && candidate.url === url);
  if (!exact) fail('avatar selection is not a currently linked account');
  return Object.freeze({ source: 'linked', provider: exact.provider, url: exact.url });
}

function uploadBytes(value) {
  const raw = String(value || '');
  if (!raw || raw.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(raw)) return null;
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length || bytes.length > AVATAR_MAX_BYTES || bytes.toString('base64') !== raw) return null;
  return bytes;
}

function hasMagic(bytes, contentType) {
  if (contentType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if (contentType === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

export function validateAvatarUpload(body) {
  if (!plainObject(body) || Object.keys(body).length !== 2
      || !Object.hasOwn(body, 'contentType') || !Object.hasOwn(body, 'dataBase64')) {
    fail('avatar upload requires exactly contentType and dataBase64');
  }
  const contentType = String(body.contentType || '').toLowerCase();
  if (!AVATAR_CONTENT_TYPES.has(contentType)) fail('avatar must be PNG, JPEG, or WebP');
  const bytes = uploadBytes(body.dataBase64);
  if (!bytes) fail(`avatar must be canonical base64 and at most ${AVATAR_MAX_BYTES} bytes`);
  if (!hasMagic(bytes, contentType)) fail('avatar content does not match its declared image type');
  return Object.freeze({ bytes, contentType, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
}

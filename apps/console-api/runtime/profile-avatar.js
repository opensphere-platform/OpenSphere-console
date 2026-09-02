'use strict';

const { createHash } = require('crypto');

const AVATAR_METADATA_KEY = 'console_avatar';
const AVATAR_BUCKET = 'console-uploads';
// The API transports the image as base64 inside the server's 256 KiB JSON
// body ceiling. Keep enough room for the closed JSON envelope.
const AVATAR_MAX_BYTES = 160 * 1024;
const AVATAR_CONTENT_TYPES = new Set(['image/webp', 'image/png', 'image/jpeg']);

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
  } catch {
    return '';
  }
}

function linkedAvatarCandidates(user) {
  const identities = Array.isArray(user?.identities) ? user.identities : [];
  const result = [];
  const seen = new Set();
  for (const identity of identities) {
    if (!plainObject(identity)) continue;
    const provider = String(identity.provider || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(provider)) continue;
    const data = plainObject(identity.identity_data) ? identity.identity_data : {};
    const url = httpsAvatarUrl(data.avatar_url || data.picture);
    if (!url) continue;
    const key = `${provider}\n${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ provider, url });
  }
  return result.slice(0, 8);
}

function avatarObjectPath(subject) {
  const value = String(subject || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw { code: 400, msg: 'avatar owner is not a canonical user id' };
  }
  return `avatars/${value}/profile`;
}

function uploadedAvatar(metadata) {
  if (!plainObject(metadata) || metadata.source !== 'upload') return null;
  const digest = String(metadata.digest || '');
  const contentType = String(metadata.contentType || '');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || !AVATAR_CONTENT_TYPES.has(contentType)) return null;
  return {
    source: 'upload',
    provider: null,
    url: `/api/identity/profile/avatar/content?v=${encodeURIComponent(digest)}`,
    digest,
    contentType,
  };
}

function avatarProjection(user) {
  const linkedAccounts = linkedAvatarCandidates(user);
  const metadata = plainObject(user?.user_metadata) ? user.user_metadata[AVATAR_METADATA_KEY] : null;
  const uploaded = uploadedAvatar(metadata);
  if (uploaded) return { current: uploaded, linkedAccounts };
  if (plainObject(metadata) && metadata.source === 'linked') {
    const provider = String(metadata.provider || '');
    const url = httpsAvatarUrl(metadata.url);
    const current = linkedAccounts.find((candidate) => candidate.provider === provider && candidate.url === url);
    if (current) {
      return {
        current: { source: 'linked', provider: current.provider, url: current.url, digest: null, contentType: null },
        linkedAccounts,
      };
    }
  }
  if (plainObject(metadata) && metadata.source === 'initial' && Object.keys(metadata).length === 1) {
    return {
      current: { source: 'initial', provider: null, url: null, digest: null, contentType: null },
      linkedAccounts,
    };
  }
  if (metadata === null || metadata === undefined) {
    const automatic = linkedAccounts[0];
    if (automatic) {
      return {
        current: { source: 'linked', provider: automatic.provider, url: automatic.url, digest: null, contentType: null },
        linkedAccounts,
      };
    }
  }
  return {
    current: { source: 'initial', provider: null, url: null, digest: null, contentType: null },
    linkedAccounts,
  };
}

function canonicalBase64(value) {
  const raw = String(value || '');
  if (!raw || raw.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length || bytes.length > AVATAR_MAX_BYTES || bytes.toString('base64') !== raw) return null;
  return bytes;
}

function hasMagic(bytes, contentType) {
  if (contentType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (contentType === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if (contentType === 'image/webp') {
    return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

function validateAvatarUpload(body) {
  if (!plainObject(body) || Object.keys(body).length !== 2
    || !Object.hasOwn(body, 'contentType') || !Object.hasOwn(body, 'dataBase64')) {
    throw { code: 400, msg: 'avatar upload requires exactly contentType and dataBase64' };
  }
  const contentType = String(body.contentType || '').toLowerCase();
  if (!AVATAR_CONTENT_TYPES.has(contentType)) throw { code: 400, msg: 'avatar must be PNG, JPEG, or WebP' };
  const bytes = canonicalBase64(body.dataBase64);
  if (!bytes) throw { code: 400, msg: `avatar must be canonical base64 and at most ${AVATAR_MAX_BYTES} bytes` };
  if (!hasMagic(bytes, contentType)) throw { code: 400, msg: 'avatar content does not match its declared image type' };
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return { bytes, contentType, digest };
}

function validateAvatarSelection(body, linkedAccounts) {
  if (!plainObject(body) || !Array.isArray(linkedAccounts)) throw { code: 400, msg: 'avatar selection is invalid' };
  if (body.source === 'initial' && Object.keys(body).length === 1) return { source: 'initial' };
  if (body.source !== 'linked' || Object.keys(body).length !== 3
    || !Object.hasOwn(body, 'provider') || !Object.hasOwn(body, 'url')) {
    throw { code: 400, msg: 'avatar selection requires initial or an exact linked account' };
  }
  const provider = String(body.provider || '');
  const url = httpsAvatarUrl(body.url);
  const exact = linkedAccounts.find((candidate) => candidate.provider === provider && candidate.url === url);
  if (!exact) throw { code: 400, msg: 'avatar selection is not a currently linked account' };
  return { source: 'linked', provider: exact.provider, url: exact.url };
}

module.exports = {
  AVATAR_BUCKET,
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  AVATAR_METADATA_KEY,
  avatarObjectPath,
  avatarProjection,
  linkedAvatarCandidates,
  validateAvatarSelection,
  validateAvatarUpload,
};

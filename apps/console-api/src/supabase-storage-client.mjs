import { AVATAR_BUCKET, AVATAR_CONTENT_TYPES, AVATAR_MAX_BYTES, avatarObjectPath } from './profile-avatar.mjs';

function fail(code, message, status = 503) {
  throw Object.assign(new Error(message), { code, status });
}

function configuredOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Supabase Storage URL must be an absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new TypeError('Supabase Storage URL must be an HTTP(S) origin');
  }
  return url.origin;
}

async function boundedBytes(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES) fail('AuthorityUnavailable', 'stored avatar is too large');
  if (!response.body) fail('AuthorityUnavailable', 'stored avatar body is missing');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > AVATAR_MAX_BYTES) {
      await reader.cancel();
      fail('AuthorityUnavailable', 'stored avatar is too large');
    }
    chunks.push(Buffer.from(value));
  }
  if (!length) fail('AuthorityUnavailable', 'stored avatar has an invalid size');
  return Buffer.concat(chunks, length);
}

export function createSupabaseStorageClient({ baseUrl, serviceRoleKey, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('Supabase Storage timeout is invalid');
  const origin = configuredOrigin(baseUrl);
  const key = String(serviceRoleKey || '');
  if (key.length < 32 || key.length > 8192 || /[\r\n]/u.test(key)) throw new TypeError('Supabase service role key is required');

  async function request(subjectId, { method, bytes, contentType } = {}) {
    const path = avatarObjectPath(subjectId).split('/').map(encodeURIComponent).join('/');
    let response;
    try {
      response = await fetchImpl(`${origin}/object/${AVATAR_BUCKET}/${path}`, {
        method,
        headers: {
          apikey: key, authorization: `Bearer ${key}`,
          ...(bytes ? { 'content-type': contentType, 'x-upsert': 'true' } : {}),
        },
        body: bytes,
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      fail(timeout ? 'DependencyTimeout' : 'AuthorityUnavailable', timeout ? 'Supabase Storage timed out' : 'Supabase Storage is unavailable');
    }
    if (!response.ok) fail('AuthorityUnavailable', 'Supabase Storage request failed');
    return response;
  }

  return Object.freeze({
    async upsertAvatar({ subjectId, bytes, contentType }) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > AVATAR_MAX_BYTES || !AVATAR_CONTENT_TYPES.has(contentType)) {
        fail('ValidationFailed', 'avatar object is invalid', 400);
      }
      await request(subjectId, { method: 'POST', bytes, contentType });
    },
    async deleteAvatar({ subjectId }) { await request(subjectId, { method: 'DELETE' }); },
    async readAvatar({ subjectId }) {
      const response = await request(subjectId, { method: 'GET' });
      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!AVATAR_CONTENT_TYPES.has(contentType)) fail('AuthorityUnavailable', 'stored avatar type is invalid');
      return Object.freeze({ bytes: await boundedBytes(response), contentType });
    },
  });
}

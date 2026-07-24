'use strict';

const http = require('http');
const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
  randomBytes,
} = require('crypto');

const PORT = Number(process.env.PORT || 8082);
const REST_URL = String(process.env.SUPABASE_REST_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const ISSUER = process.env.SUPABASE_AUTH_ISSUER || '';
const AUDIENCE = process.env.SUPABASE_AUTH_AUDIENCE || 'authenticated';
const INTERNAL_TOKEN = process.env.EXTERNAL_CHANNEL_EXECUTOR_TOKEN || '';
const MAX_SNAPSHOT_BYTES = Number(process.env.EXTERNAL_BACKUP_MAX_BYTES || 12 * 1024 * 1024);

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function executorToken() {
  if (!JWT_SECRET || !ISSUER) throw { code: 503, msg: 'external executor Supabase JWT configuration is missing' };
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({
    iss: ISSUER,
    aud: AUDIENCE,
    role: 'opensphere_external_channel_executor',
    sub: 'opensphere-external-channel-executor',
    iat: now,
    exp: now + 3600,
  }));
  const signed = `${header}.${body}`;
  return `${signed}.${createHmac('sha256', JWT_SECRET).update(signed).digest('base64url')}`;
}

function restHeaders() {
  if (!REST_URL || !SERVICE_KEY) throw { code: 503, msg: 'external executor Supabase REST configuration is missing' };
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${executorToken()}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'accept-profile': 'console',
    'content-profile': 'console',
  };
}

async function rest(resource, { method = 'GET', query = '', body, prefer = 'return=representation' } = {}) {
  const url = new URL(`${REST_URL}/${resource}`);
  if (query) url.search = query;
  const response = await fetch(url, {
    method,
    headers: { ...restHeaders(), Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  let output = [];
  try { output = text ? JSON.parse(text) : []; } catch { output = text; }
  if (!response.ok) throw {
    code: response.status,
    msg: `Supabase ${resource} ${method} failed`,
    detail: String(text).slice(0, 300),
  };
  return output;
}

function keyFrom(name) {
  const key = Buffer.from(process.env[name] || '', 'base64');
  if (key.length !== 32) throw { code: 503, msg: `${name} must be a base64-encoded 32-byte key` };
  return key;
}

function cipherJson(value, keyName, aad = '') {
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(keyName), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    plaintextDigest: `sha256:${createHash('sha256').update(plaintext).digest('hex')}`,
  };
}

function decipherJson(envelope, keyName, aad = '') {
  if (envelope?.algorithm !== 'aes-256-gcm') throw { code: 409, msg: 'unsupported backup encryption envelope' };
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(keyName), Buffer.from(envelope.iv, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  const digest = `sha256:${createHash('sha256').update(plaintext).digest('hex')}`;
  if (!safeEqual(digest, envelope.plaintextDigest)) throw { code: 409, msg: 'backup plaintext digest mismatch' };
  return { value: JSON.parse(plaintext.toString('utf8')), digest };
}

function targetInput(row) {
  if (!row || row.provider !== 's3' || row.vendor !== 'backblaze-b2') {
    throw { code: 400, msg: 'only Backblaze B2 S3 targets are supported by this executor' };
  }
  const endpoint = new URL(row.endpoint);
  const expectedHost = `s3.${row.region}.backblazeb2.com`;
  if (
    endpoint.protocol !== 'https:'
    || endpoint.hostname !== expectedHost
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || !['', '/'].includes(endpoint.pathname)
  ) throw { code: 400, msg: 'Backblaze endpoint must exactly match the configured region' };
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(row.bucket_name || '')) {
    throw { code: 400, msg: 'invalid S3 bucket name' };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(row.path_prefix || '')) {
    throw { code: 400, msg: 'invalid backup path prefix' };
  }
  return { ...row, endpoint: endpoint.origin };
}

function credentialInput(value) {
  const accessKeyId = String(value?.accessKeyId || '').trim();
  const applicationKey = String(value?.applicationKey || '').trim();
  if (!/^[A-Za-z0-9]{25}$/.test(accessKeyId)) {
    throw {
      code: 400,
      field: 'accessKeyId',
      msg: 'Backblaze Application Key ID must be the 25-character keyID issued for an S3-compatible application key',
    };
  }
  if (!/^[A-Za-z0-9]{31}$/.test(applicationKey)) {
    throw {
      code: 400,
      field: 'applicationKey',
      msg: 'Backblaze Application Key must be the 31-character secret shown when the application key is created',
    };
  }
  return { accessKeyId, applicationKey };
}

async function targetFor(id) {
  const rows = await rest('external_backup_target', {
    query: `select=*&id=eq.${encodeURIComponent(id)}&deleted_at=is.null`,
  });
  if (!rows[0]) throw { code: 404, msg: 'external backup target not found' };
  return targetInput(rows[0]);
}

async function storeCredential(targetId, input) {
  const target = await targetFor(targetId);
  const credential = credentialInput(input);
  const version = Number(target.secret_version || 0) + 1;
  const encrypted = cipherJson(credential, 'EXTERNAL_CREDENTIAL_ENCRYPTION_KEY');
  await rest('rpc/external_backup_store_secret', {
    method: 'POST',
    body: {
      p_target_id: targetId,
      p_version: version,
      p_iv: encrypted.iv,
      p_auth_tag: encrypted.authTag,
      p_ciphertext: encrypted.ciphertext,
      p_plaintext_digest: encrypted.plaintextDigest,
    },
  });
  await rest('external_backup_target', {
    method: 'PATCH',
    query: `id=eq.${encodeURIComponent(targetId)}`,
    body: {
      credential_configured: true,
      secret_version: version,
      health_state: 'Degraded',
      updated_at: new Date().toISOString(),
    },
    prefer: 'return=minimal',
  });
  return { configured: true, version };
}

async function credentialFor(targetId) {
  const rows = await rest('rpc/external_backup_read_secret', {
    method: 'POST',
    body: { p_target_id: targetId },
  });
  if (!rows[0]) throw { code: 409, msg: 'external backup credentials are not configured' };
  const envelope = {
    algorithm: rows[0].algorithm,
    iv: rows[0].iv,
    authTag: rows[0].auth_tag,
    ciphertext: rows[0].ciphertext,
    plaintextDigest: rows[0].plaintext_digest,
  };
  return credentialInput(decipherJson(envelope, 'EXTERNAL_CREDENTIAL_ENCRYPTION_KEY').value);
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(bucket, objectKey = '') {
  return `/${[bucket, ...String(objectKey).split('/').filter(Boolean)].map(awsEncode).join('/')}`;
}

function amzTime(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding);
}

function signedS3Request({ target, credential, method, objectKey = '', body = Buffer.alloc(0), query = {} }) {
  const date = new Date();
  const timestamp = amzTime(date);
  const day = timestamp.slice(0, 8);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  const path = canonicalPath(target.bucket_name, objectKey);
  const canonicalQuery = Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(String(value))}`)
    .join('&');
  const host = new URL(target.endpoint).host;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${day}/${target.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const dateKey = hmac(`AWS4${credential.applicationKey}`, day);
  const regionKey = hmac(dateKey, target.region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  const search = canonicalQuery ? `?${canonicalQuery}` : '';
  return {
    url: `${target.endpoint}${path}${search}`,
    options: {
      method,
      headers: {
        Authorization: `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': timestamp,
        ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}),
      },
      body: ['GET', 'HEAD'].includes(method) ? undefined : payload,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    },
    canonicalRequest,
  };
}

async function s3Request(args) {
  const signed = signedS3Request(args);
  const response = await fetch(signed.url, signed.options);
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
    const providerCode = detail.match(/<Code>([^<]+)<\/Code>/)?.[1] || '';
    const failure = s3Failure(providerCode, response.status);
    throw {
      code: 502,
      msg: failure.message || `S3 ${args.method} failed`,
      externalCode: providerCode ? `s3-${providerCode}` : `s3-http-${response.status}`,
      field: failure.field,
    };
  }
  return response;
}

function s3Failure(providerCode, status) {
  if (providerCode === 'InvalidAccessKeyId') {
    return { field: 'accessKeyId', message: 'Backblaze가 Application Key ID를 올바른 keyID로 인식하지 못했습니다.' };
  }
  if (providerCode === 'SignatureDoesNotMatch') {
    return { field: 'applicationKey', message: 'Backblaze Application Key가 Key ID와 일치하지 않습니다.' };
  }
  if (providerCode === 'NoSuchBucket') {
    return { field: 'bucketName', message: 'Backblaze에서 입력한 Bucket name을 찾을 수 없습니다.' };
  }
  if (providerCode === 'AuthorizationHeaderMalformed' || providerCode === 'PermanentRedirect') {
    return { field: 'region', message: 'Bucket의 Region 또는 S3 endpoint가 일치하지 않습니다.' };
  }
  if (providerCode === 'AccessDenied' || status === 403) {
    return {
      field: 'accessKeyId',
      message: 'Application Key에 이 Bucket의 목록·읽기·쓰기 권한이 없습니다.',
    };
  }
  return { field: '', message: '' };
}

async function testTarget(targetId) {
  const target = await targetFor(targetId);
  const credential = await credentialFor(targetId);
  try {
    // A bounded ListObjectsV2 request yields Backblaze's typed XML error body;
    // HeadBucket commonly returns an empty 403 and cannot identify the field.
    await s3Request({ target, credential, method: 'GET', query: { 'list-type': 2, 'max-keys': 1 } });
    const at = new Date().toISOString();
    await rest('external_backup_target', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(targetId)}`,
      body: {
        health_state: 'Ready',
        last_test_status: 'succeeded',
        last_test_at: at,
        last_error_code: null,
        updated_at: at,
      },
      prefer: 'return=minimal',
    });
    return { ready: true, checkedAt: at };
  } catch (error) {
    const at = new Date().toISOString();
    await rest('external_backup_target', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(targetId)}`,
      body: {
        health_state: 'Misconfigured',
        last_test_status: 'failed',
        last_test_at: at,
        last_error_code: error?.externalCode || 's3-test-failed',
        updated_at: at,
      },
      prefer: 'return=minimal',
    }).catch(() => undefined);
    throw error;
  }
}

async function backupRow(targetId, backupId) {
  const rows = await rest('configuration_backup', {
    query: `select=*&id=eq.${encodeURIComponent(backupId)}&target_id=eq.${encodeURIComponent(targetId)}`,
  });
  if (!rows[0]) throw { code: 404, msg: 'configuration backup not found' };
  return rows[0];
}

async function uploadBackup(targetId, backupId, snapshot) {
  const target = await targetFor(targetId);
  const backup = await backupRow(targetId, backupId);
  const credential = await credentialFor(targetId);
  const plaintextSize = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (plaintextSize > MAX_SNAPSHOT_BYTES) throw { code: 413, msg: 'configuration snapshot exceeds external backup limit' };
  await rest('configuration_backup', {
    method: 'PATCH',
    query: `id=eq.${encodeURIComponent(backupId)}`,
    body: { status: 'uploading', error_code: null },
    prefer: 'return=minimal',
  });
  try {
    const aad = `opensphere-console-configuration-backup/v1:${backupId}`;
    const encrypted = cipherJson(snapshot, 'EXTERNAL_BACKUP_ENCRYPTION_KEY', aad);
    const envelope = Buffer.from(JSON.stringify({
      apiVersion: 'encrypted-configuration-backup.opensphere.io/v1',
      backupId,
      algorithm: encrypted.algorithm,
      keyId: 'external-backup-key-v1',
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      plaintextDigest: encrypted.plaintextDigest,
      ciphertext: encrypted.ciphertext,
    }), 'utf8');
    await s3Request({
      target,
      credential,
      method: 'PUT',
      objectKey: backup.object_key,
      body: envelope,
    });
    const completedAt = new Date().toISOString();
    const objectDigest = `sha256:${createHash('sha256').update(envelope).digest('hex')}`;
    await Promise.all([
      rest('configuration_backup', {
        method: 'PATCH',
        query: `id=eq.${encodeURIComponent(backupId)}`,
        body: {
          status: 'ready',
          plaintext_digest: encrypted.plaintextDigest,
          object_digest: objectDigest,
          size_bytes: envelope.length,
          completed_at: completedAt,
          error_code: null,
        },
        prefer: 'return=minimal',
      }),
      rest('external_backup_target', {
        method: 'PATCH',
        query: `id=eq.${encodeURIComponent(targetId)}`,
        body: {
          health_state: 'Ready',
          last_backup_at: completedAt,
          last_error_code: null,
          updated_at: completedAt,
        },
        prefer: 'return=minimal',
      }),
    ]);
    return {
      backupId,
      plaintextDigest: encrypted.plaintextDigest,
      objectDigest,
      sizeBytes: envelope.length,
      completedAt,
    };
  } catch (error) {
    await rest('configuration_backup', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(backupId)}`,
      body: {
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_code: error?.externalCode || 'backup-upload-failed',
      },
      prefer: 'return=minimal',
    }).catch(() => undefined);
    throw error;
  }
}

async function readBackup(targetId, backupId) {
  const target = await targetFor(targetId);
  const backup = await backupRow(targetId, backupId);
  if (backup.status !== 'ready') throw { code: 409, msg: 'configuration backup is not ready' };
  const credential = await credentialFor(targetId);
  const response = await s3Request({
    target,
    credential,
    method: 'GET',
    objectKey: backup.object_key,
  });
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_SNAPSHOT_BYTES * 3) throw { code: 413, msg: 'encrypted backup object exceeds limit' };
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_SNAPSHOT_BYTES * 3) throw { code: 413, msg: 'encrypted backup object exceeds limit' };
  const objectDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (!safeEqual(objectDigest, backup.object_digest)) throw { code: 409, msg: 'backup object digest mismatch' };
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); }
  catch { throw { code: 409, msg: 'backup object envelope is invalid' }; }
  if (
    envelope.apiVersion !== 'encrypted-configuration-backup.opensphere.io/v1'
    || envelope.backupId !== backupId
  ) throw { code: 409, msg: 'backup object identity mismatch' };
  const decoded = decipherJson(
    envelope,
    'EXTERNAL_BACKUP_ENCRYPTION_KEY',
    `opensphere-console-configuration-backup/v1:${backupId}`,
  );
  if (!safeEqual(decoded.digest, backup.plaintext_digest)) throw { code: 409, msg: 'backup metadata digest mismatch' };
  if (decoded.value?.apiVersion !== 'configuration-backup.opensphere.io/v1') {
    throw { code: 409, msg: 'configuration snapshot format is invalid' };
  }
  return { backupId, digest: decoded.digest, snapshot: decoded.value };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_SNAPSHOT_BYTES) {
        reject({ code: 413, msg: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject({ code: 400, msg: 'invalid json body' }); }
    });
    req.on('error', reject);
  });
}

function json(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function internal(req) {
  return Boolean(INTERNAL_TOKEN) && safeEqual(req.headers['x-external-channel-executor-token'], INTERNAL_TOKEN);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (url.pathname === '/readyz') {
      keyFrom('EXTERNAL_CREDENTIAL_ENCRYPTION_KEY');
      keyFrom('EXTERNAL_BACKUP_ENCRYPTION_KEY');
      restHeaders();
      return json(res, 200, { ready: true });
    }
    if (!internal(req)) return json(res, 401, { error: 'internal external-channel executor authentication required' });
    const credential = url.pathname.match(/^\/internal\/targets\/([0-9a-fA-F-]+)\/credentials$/);
    if (credential && req.method === 'POST') {
      return json(res, 200, await storeCredential(credential[1], await readBody(req)));
    }
    const test = url.pathname.match(/^\/internal\/targets\/([0-9a-fA-F-]+)\/test$/);
    if (test && req.method === 'POST') {
      await readBody(req);
      return json(res, 200, await testTarget(test[1]));
    }
    const upload = url.pathname.match(/^\/internal\/targets\/([0-9a-fA-F-]+)\/backups\/([0-9a-fA-F-]+)$/);
    if (upload && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 201, await uploadBackup(upload[1], upload[2], body.snapshot));
    }
    const read = url.pathname.match(/^\/internal\/targets\/([0-9a-fA-F-]+)\/backups\/([0-9a-fA-F-]+)\/read$/);
    if (read && req.method === 'POST') {
      await readBody(req);
      return json(res, 200, await readBackup(read[1], read[2]));
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    return json(res, Number(error?.code) || 500, {
      error: error?.msg || error?.message || 'external backup executor failed',
      ...(error?.externalCode ? { code: error.externalCode } : {}),
      ...(error?.field ? { field: error.field } : {}),
    });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`opensphere-external-channel-executor listening :${PORT}`));
}

module.exports = {
  canonicalPath,
  cipherJson,
  credentialInput,
  decipherJson,
  s3Failure,
  signedS3Request,
  targetInput,
  server,
};

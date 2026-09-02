'use strict';

const http = require('http');
const https = require('https');
const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
  randomBytes,
  randomUUID,
  X509Certificate,
} = require('crypto');
const { createExternalChannelApi } = require('./external-channel-api');
const { createConsoleOwnerAdmission } = require('./owner-admission');
const { authorizeExternalChannel, externalChannelRequestAllowed } = require('./owner-policy');

const PORT = Number(process.env.PORT || 8082);
const REST_URL = String(process.env.SUPABASE_REST_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const ISSUER = process.env.SUPABASE_AUTH_ISSUER || '';
const AUDIENCE = process.env.SUPABASE_AUTH_AUDIENCE || 'authenticated';
const INTERNAL_TOKEN = process.env.EXTERNAL_CHANNEL_EXECUTOR_TOKEN || '';
const MAX_SNAPSHOT_BYTES = Number(process.env.EXTERNAL_BACKUP_MAX_BYTES || 12 * 1024 * 1024);
const CONSOLE_OWNER_AUTHORITY_URL = String(process.env.CONSOLE_OWNER_AUTHORITY_URL || 'http://opensphere-console-api.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const EXTERNAL_CHANNEL_REQUIRE_AAL2 = process.env.EXTERNAL_CHANNEL_REQUIRE_AAL2 !== 'false';

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

function restHeaders(profile = 'console') {
  if (!REST_URL || !SERVICE_KEY) throw { code: 503, msg: 'external executor Supabase REST configuration is missing' };
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${executorToken()}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'accept-profile': profile,
    'content-profile': profile,
  };
}

async function rest(resource, { method = 'GET', query = '', body, prefer = 'return=representation', profile = 'console' } = {}) {
  const url = new URL(`${REST_URL}/${resource}`);
  if (query) url.search = query;
  const response = await fetch(url, {
    method,
    headers: { ...restHeaders(profile), Prefer: prefer },
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
  if (!row || row.provider !== 's3') {
    throw { code: 400, msg: 'only S3-compatible targets are supported by this executor' };
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(row.vendor || '')) {
    throw { code: 400, field: 'vendor', msg: 'invalid S3 storage profile' };
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(row.region || '')) {
    throw { code: 400, field: 'region', msg: 'invalid S3 region' };
  }
  let endpoint;
  try { endpoint = new URL(row.endpoint); }
  catch { throw { code: 400, field: 'endpoint', msg: 'valid HTTPS S3 endpoint is required' }; }
  if (
    endpoint.protocol !== 'https:'
    || !endpoint.hostname
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || !['', '/'].includes(endpoint.pathname)
  ) throw { code: 400, field: 'endpoint', msg: 'endpoint must be an HTTPS origin without path, query or credentials' };
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(row.bucket_name || '')) {
    throw { code: 400, field: 'bucketName', msg: 'invalid S3 bucket name' };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(row.path_prefix || '')) {
    throw { code: 400, field: 'pathPrefix', msg: 'invalid backup path prefix' };
  }
  return { ...row, endpoint: endpoint.origin };
}

function credentialInput(value) {
  const accessKeyId = String(value?.accessKeyId || '').trim();
  const applicationKey = String(value?.applicationKey || '').trim();
  if (!/^[\x21-\x7e]{3,128}$/.test(accessKeyId)) {
    throw {
      code: 400,
      field: 'accessKeyId',
      msg: 'S3 Access key ID must be 3-128 printable characters without spaces',
    };
  }
  if (!/^[\x21-\x7e]{8,256}$/.test(applicationKey)) {
    throw {
      code: 400,
      field: 'applicationKey',
      msg: 'S3 Secret access key must be 8-256 printable characters without spaces',
    };
  }
  return { accessKeyId, applicationKey };
}

function certificateName(value) {
  return String(value || '').split(/\r?\n/).map((part) => part.trim()).filter(Boolean).join(', ');
}

function customCaInput(value) {
  const pem = String(value || '').trim();
  if (!pem || Buffer.byteLength(pem, 'utf8') > 65536) {
    throw { code: 400, field: 'customCaCertificatePem', msg: 'Custom CA bundle must be a non-empty PEM file no larger than 64 KiB' };
  }
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (!blocks.length || blocks.length > 8) {
    throw { code: 400, field: 'customCaCertificatePem', msg: 'Custom CA bundle must contain 1-8 PEM certificates' };
  }
  let certificates;
  try { certificates = blocks.map((block) => new X509Certificate(block)); }
  catch { throw { code: 400, field: 'customCaCertificatePem', msg: 'Custom CA bundle contains an invalid certificate' }; }
  if (certificates.some((certificate) => !certificate.ca)) {
    throw { code: 400, field: 'customCaCertificatePem', msg: 'Custom CA bundle may contain only CA certificates' };
  }
  const now = Date.now();
  if (certificates.some((certificate) => now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo))) {
    throw { code: 400, field: 'customCaCertificatePem', msg: 'Custom CA bundle contains a certificate outside its validity period' };
  }
  const primary = certificates[0];
  return {
    pem: `${blocks.join('\n')}\n`,
    subject: certificateName(primary.subject),
    issuer: certificateName(primary.issuer),
    validTo: new Date(primary.validTo).toISOString(),
    fingerprint: `SHA-256 ${primary.fingerprint256}`,
  };
}

function connectionSecretInput(value, existing = null) {
  const replacementAccessKeyId = String(value?.accessKeyId || '').trim();
  const replacementApplicationKey = String(value?.applicationKey || '').trim();
  const credential = replacementAccessKeyId || replacementApplicationKey
    ? credentialInput({ accessKeyId: replacementAccessKeyId, applicationKey: replacementApplicationKey })
    : credentialInput(existing || {});
  const tlsTrustMode = String(value?.tlsTrustMode || existing?.tlsTrustMode || 'system').trim().toLowerCase();
  if (!['system', 'custom-ca'].includes(tlsTrustMode)) {
    throw { code: 400, field: 'tlsTrustMode', msg: 'TLS trust mode must be system or custom-ca' };
  }
  if (tlsTrustMode === 'system') {
    return { secret: { ...credential, tlsTrustMode: 'system' }, metadata: null };
  }
  const customCa = customCaInput(value?.customCaCertificatePem || existing?.customCaCertificatePem);
  return {
    secret: { ...credential, tlsTrustMode: 'custom-ca', customCaCertificatePem: customCa.pem },
    metadata: customCa,
  };
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
  const existing = target.credential_configured ? await credentialFor(targetId) : null;
  const connection = connectionSecretInput(input, existing);
  const version = Number(target.secret_version || 0) + 1;
  const encrypted = cipherJson(connection.secret, 'EXTERNAL_CREDENTIAL_ENCRYPTION_KEY');
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
      tls_trust_mode: connection.secret.tlsTrustMode,
      custom_ca_configured: Boolean(connection.metadata),
      custom_ca_subject: connection.metadata?.subject || null,
      custom_ca_issuer: connection.metadata?.issuer || null,
      custom_ca_valid_to: connection.metadata?.validTo || null,
      custom_ca_fingerprint: connection.metadata?.fingerprint || null,
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
  const value = decipherJson(envelope, 'EXTERNAL_CREDENTIAL_ENCRYPTION_KEY').value;
  const credential = credentialInput(value);
  const tlsTrustMode = String(value?.tlsTrustMode || 'system').toLowerCase();
  if (tlsTrustMode === 'system') return { ...credential, tlsTrustMode: 'system' };
  const customCa = customCaInput(value?.customCaCertificatePem);
  return { ...credential, tlsTrustMode: 'custom-ca', customCaCertificatePem: customCa.pem };
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

function tlsFailure(error, usesCustomCa) {
  const cause = error?.cause || error;
  const code = String(cause?.code || '');
  const certificateErrors = new Set([
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ]);
  if (!certificateErrors.has(code)) return null;
  return {
    code: 502,
    msg: usesCustomCa
      ? '사용자 지정 CA로 S3 endpoint 인증서를 검증하지 못했습니다.'
      : 'S3 endpoint 인증서가 시스템 신뢰 저장소에서 검증되지 않았습니다. 사용자 지정 CA를 등록하세요.',
    externalCode: 's3-tls-certificate-untrusted',
    field: usesCustomCa ? 'customCaCertificatePem' : 'tlsTrustMode',
  };
}

function fetchWithCustomCa(url, options, customCaCertificatePem) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: options.method,
      headers: options.headers,
      ca: customCaCertificatePem,
      rejectUnauthorized: true,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_SNAPSHOT_BYTES * 3) {
          request.destroy(Object.assign(new Error('S3 response exceeds limit'), { code: 'RESPONSE_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: Number(response.statusCode || 500),
        headers: response.headers,
      })));
    });
    request.setTimeout(30000, () => request.destroy(Object.assign(new Error('S3 request timed out'), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

async function s3Request(args) {
  const signed = signedS3Request(args);
  const usesCustomCa = args.credential?.tlsTrustMode === 'custom-ca';
  let response;
  try {
    response = usesCustomCa
      ? await fetchWithCustomCa(signed.url, signed.options, args.credential.customCaCertificatePem)
      : await fetch(signed.url, signed.options);
  } catch (error) {
    const failure = tlsFailure(error, usesCustomCa);
    if (failure) throw failure;
    throw error;
  }
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
    return { field: 'accessKeyId', message: 'S3 저장소가 Access key ID를 인식하지 못했습니다.' };
  }
  if (providerCode === 'SignatureDoesNotMatch') {
    return { field: 'applicationKey', message: 'Secret access key가 Access key ID 또는 Region과 일치하지 않습니다.' };
  }
  if (providerCode === 'NoSuchBucket') {
    return { field: 'bucketName', message: 'S3 저장소에서 입력한 Bucket name을 찾을 수 없습니다.' };
  }
  if (providerCode === 'AuthorizationHeaderMalformed' || providerCode === 'PermanentRedirect') {
    return { field: 'region', message: 'Bucket의 Region 또는 S3 endpoint가 일치하지 않습니다.' };
  }
  if (providerCode === 'AccessDenied' || status === 403) {
    return {
      field: 'accessKeyId',
      message: 'S3 자격 증명에 이 Bucket의 목록·읽기·쓰기 권한이 없습니다.',
    };
  }
  return { field: '', message: '' };
}

async function testTarget(targetId) {
  const target = await targetFor(targetId);
  const credential = await credentialFor(targetId);
  try {
    // A bounded ListObjectsV2 request yields a typed S3 XML error body;
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

async function logAudit(actor, action, target, result, reason, options = {}) {
  const requestId = options.requestId || randomUUID();
  const actorId = String(actor?.sub || '');
  if (!actorId) throw { code: 401, msg: 'recovery audit actor is unavailable' };
  const row = {
    request_id: requestId,
    correlation_id: String(options.correlationId || requestId),
    actor_type: 'human', actor_id: actorId,
    auth_session_id: actor.browserSessionId || null,
    action, target_type: options.targetType || 'external-backup', target_id: String(target || ''),
    reason: String(reason || '').slice(0, 240), phase: options.phase || 'applied', result,
    payload_digest: options.payloadDigest ? `sha256:${options.payloadDigest}` : null,
    event_hash: `sha256:${createHash('sha256').update(JSON.stringify({ requestId, actorId, action, target, reason, result })).digest('hex')}`,
  };
  const output = await rest('event', {
    profile: 'audit', method: 'POST', query: 'select=request_id,correlation_id', body: [row], prefer: 'return=representation',
  });
  if (!Array.isArray(output) || !output[0]?.request_id) throw { code: 503, msg: 'recovery audit append failed' };
  return output[0];
}

async function executorRequest(path, body) {
  let match = path.match(/^\/internal\/targets\/([0-9a-f-]+)\/credentials$/i);
  if (match) return storeCredential(match[1], body);
  match = path.match(/^\/internal\/targets\/([0-9a-f-]+)\/test$/i);
  if (match) return testTarget(match[1]);
  match = path.match(/^\/internal\/targets\/([0-9a-f-]+)\/backups\/([0-9a-f-]+)$/i);
  if (match) return uploadBackup(match[1], match[2], body?.snapshot);
  match = path.match(/^\/internal\/targets\/([0-9a-f-]+)\/backups\/([0-9a-f-]+)\/read$/i);
  if (match) return readBackup(match[1], match[2]);
  throw { code: 500, msg: 'external channel API requested an unknown executor operation' };
}

const verifyExternalChannelOwner = createConsoleOwnerAdmission({
  baseUrl: CONSOLE_OWNER_AUTHORITY_URL,
  marker: 'external-channel-executor-v1',
  familyPrefix: '/api/external-channels',
  allowRequest: externalChannelRequestAllowed,
});
const externalChannelApi = createExternalChannelApi({
  restRequest: rest,
  logAudit,
  newOpId: () => randomUUID(),
  executorRequest,
});

async function verifyExternalChannelAdmin(req) {
  return authorizeExternalChannel(await verifyExternalChannelOwner(req), req.method, {
    requireAal2: EXTERNAL_CHANNEL_REQUIRE_AAL2,
  });
}

async function handleExternalChannelBrowserApi(req, res, url) {
  const path = url.pathname;
  if (path === '/api/external-channels/summary' && req.method === 'GET') {
    await verifyExternalChannelAdmin(req); json(res, 200, await externalChannelApi.summary()); return true;
  }
  if (path === '/api/external-channels/backup-targets' && req.method === 'GET') {
    await verifyExternalChannelAdmin(req); json(res, 200, { items: await externalChannelApi.targets() }); return true;
  }
  if (path === '/api/external-channels/backup-targets' && req.method === 'POST') {
    const actor = await verifyExternalChannelAdmin(req); json(res, 201, await externalChannelApi.createTarget(actor, await readBody(req))); return true;
  }
  const targetItem = path.match(/^\/api\/external-channels\/backup-targets\/([0-9a-f-]+)$/i);
  if (targetItem && ['PUT', 'DELETE'].includes(req.method)) {
    const actor = await verifyExternalChannelAdmin(req); const body = await readBody(req);
    json(res, 200, req.method === 'PUT'
      ? await externalChannelApi.updateTarget(actor, targetItem[1], body)
      : await externalChannelApi.removeTarget(actor, targetItem[1], body));
    return true;
  }
  const targetAction = path.match(/^\/api\/external-channels\/backup-targets\/([0-9a-f-]+)\/(test|backup|enable|disable)$/i);
  if (targetAction && req.method === 'POST') {
    const actor = await verifyExternalChannelAdmin(req); const body = await readBody(req); const action = targetAction[2];
    if (action === 'enable' || action === 'disable') {
      json(res, 200, await externalChannelApi.setTargetEnabled(actor, targetAction[1], action === 'enable', body));
    } else {
      json(res, action === 'test' ? 200 : 201, action === 'test'
        ? await externalChannelApi.test(actor, targetAction[1], body)
        : await externalChannelApi.backupNow(actor, targetAction[1], body));
    }
    return true;
  }
  if (path === '/api/external-channels/backups' && req.method === 'GET') {
    await verifyExternalChannelAdmin(req); json(res, 200, { items: await externalChannelApi.backups() }); return true;
  }
  const preview = path.match(/^\/api\/external-channels\/backups\/([0-9a-f-]+)\/restore-preview$/i);
  if (preview && req.method === 'POST') {
    const actor = await verifyExternalChannelAdmin(req); json(res, 201, await externalChannelApi.previewRestore(actor, preview[1], await readBody(req))); return true;
  }
  const apply = path.match(/^\/api\/external-channels\/restores\/([0-9a-f-]+)\/apply$/i);
  if (apply && req.method === 'POST') {
    const actor = await verifyExternalChannelAdmin(req); json(res, 200, await externalChannelApi.applyRestore(actor, apply[1], await readBody(req))); return true;
  }
  return false;
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
    if (url.pathname === '/api/external-channels' || url.pathname.startsWith('/api/external-channels/')) {
      if (await handleExternalChannelBrowserApi(req, res, url)) return;
      return json(res, 404, { error: 'not found' });
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
  connectionSecretInput,
  credentialInput,
  customCaInput,
  decipherJson,
  s3Failure,
  signedS3Request,
  tlsFailure,
  targetInput,
  server,
};

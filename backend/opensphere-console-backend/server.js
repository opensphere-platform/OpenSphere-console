// Console Backend — Supabase-backed identity/catalo​g/kubernetes proxy core.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual, createPublicKey, verify: verifySignature } = require('crypto');
const { createSupabaseVerifier } = require('./supabase-auth');
const { enforcePatRequestScope, normalizePatScope, validatePatTTL } = require('./cli-token-policy');
const { createNotificationApi } = require('./notification-api');
const { createExternalChannelApi } = require('./external-channel-api');
const { buildRecoveryOwnerStatus, buildRecoveryPlan, normalizedRecoveryEvidence } = require('./recovery-owner');
const { normalizedEvent } = require('../notification-dispatcher/contract');

const MAX_BODY = 256 * 1024; // prevent unbounded in-memory request buffering
const newOpId = () => randomUUID();

const PORT = process.env.PORT || 8080;
const PLUGIN_DIR = process.env.PLUGIN_DIR || '/plugins';
const VERSION = process.env.APP_VERSION || '0.6.0-supabase-cli';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

const SUPABASE_REST_URL = process.env.SUPABASE_REST_URL || '';
const SUPABASE_AUTH_URL = process.env.SUPABASE_AUTH_URL || process.env.SUPABASE_AUTH_ISSUER || '';
const SUPABASE_AUTH_ISSUER = process.env.SUPABASE_AUTH_ISSUER || '';
const SUPABASE_AUTH_AUDIENCE = process.env.SUPABASE_AUTH_AUDIENCE || 'authenticated';
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_STORAGE_URL = process.env.SUPABASE_STORAGE_URL || 'http://opensphere-supabase-storage.opensphere-console-data.svc.cluster.local:5000';
const SUPABASE_TIMEOUT_MS = Number(process.env.SUPABASE_TIMEOUT_MS || 3000);
const GITEA_URL = (process.env.GITEA_URL || '').replace(/\/$/, '');
const GITEA_TOKEN = process.env.GITEA_TOKEN || '';
const GITEA_REVIEW_TOKEN = process.env.GITEA_REVIEW_TOKEN || '';
const GITEA_ORGANIZATION = process.env.GITEA_ORGANIZATION || 'opensphere';
const GITEA_REPOSITORY = process.env.GITEA_REPOSITORY || 'platform-declarations';
const GITEA_DEFAULT_BRANCH = process.env.GITEA_DEFAULT_BRANCH || 'main';
const GITEA_WEBHOOK_SECRET = process.env.GITEA_WEBHOOK_SECRET || '';
const GITEA_RECONCILER_NAME = process.env.GITEA_RECONCILER_NAME || 'opensphere-declaration-reconciler';
const GITEA_RECONCILER_NAMES = new Set((process.env.GITEA_RECONCILER_NAMES || `${GITEA_RECONCILER_NAME},ceph-prerequisite-reconciler`)
  .split(',').map((value) => value.trim()).filter(Boolean));
const GITEA_CHANGE_REQUIRE_AAL2 = String(process.env.GITEA_CHANGE_REQUIRE_AAL2 || 'true').toLowerCase() !== 'false';
const GITEA_REQUIRE_VERIFIED_MERGE = String(process.env.GITEA_REQUIRE_VERIFIED_MERGE || 'true').toLowerCase() !== 'false';
const RECONCILER_RECEIPT_TOKEN = process.env.RECONCILER_RECEIPT_TOKEN || '';
const GITEA_TIMEOUT_MS = Number(process.env.GITEA_TIMEOUT_MS || 3000);
const SUPABASE_BACKEND_ROLE = process.env.SUPABASE_BACKEND_ROLE || 'console-admins';
const SUPABASE_BACKEND_DB_ROLE = process.env.SUPABASE_BACKEND_DB_ROLE || 'opensphere_console_backend';
const SUPABASE_BACKEND_TOKEN_TTL_SEC = Number(process.env.SUPABASE_BACKEND_TOKEN_TTL_SEC || (24 * 60 * 60 * 30));
const SUPABASE_BACKEND_TOKEN = process.env.SUPABASE_BACKEND_TOKEN || '';
const AUDIT_READ_LIMIT = Number(process.env.SUPABASE_AUDIT_READ_LIMIT || 200);
// Administrator mutations are MFA-protected by default in every environment.
// A deployment must opt out explicitly; local bootstrap is handled by the
// unauthenticated one-shot bootstrap route and is not a reason to weaken the
// normal Console policy boundary.
const SUPABASE_REQUIRE_AAL2 = String(process.env.SUPABASE_REQUIRE_AAL2 || 'true').toLowerCase() !== 'false';
const OAA_ACTION_REQUIRE_AAL2 = String(process.env.OAA_ACTION_REQUIRE_AAL2 || 'true').toLowerCase() !== 'false';
const DUPA_CONTROL_URL = (process.env.DUPA_CONTROL_URL || 'http://opensphere-console-dupa-controller.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const CONSOLE_PUBLIC_URL = (process.env.CONSOLE_PUBLIC_URL || 'https://localhost:8090').replace(/\/$/, '');
const CLI_TOKEN_ISSUER = 'opensphere-cli';
const CLI_TOKEN_AUDIENCE = 'opensphere-cli';
const CLI_JWT_SECRET = process.env.CLI_JWT_SECRET || '';
const CLI_SESSION_TTL_SEC = Number(process.env.CLI_SESSION_TTL_SEC || 900);
const CLI_PAT_TTL_SEC = Number(process.env.CLI_PAT_TTL_SEC || (30 * 24 * 60 * 60));
const CLI_ENROLLMENT_TTL_SEC = Number(process.env.CLI_ENROLLMENT_TTL_SEC || 300);
const CLI_CHALLENGE_TTL_SEC = Number(process.env.CLI_CHALLENGE_TTL_SEC || 60);
const NOTIFICATION_DISPATCHER_URL = (process.env.NOTIFICATION_DISPATCHER_URL || 'http://opensphere-notification-dispatcher.opensphere-console.svc.cluster.local:8081').replace(/\/$/, '');
const NOTIFICATION_DISPATCHER_TOKEN = process.env.NOTIFICATION_DISPATCHER_TOKEN || '';
const NOTIFICATION_EVENT_TOKEN = process.env.NOTIFICATION_EVENT_TOKEN || '';
const NOTIFICATION_REQUIRE_AAL2 = String(process.env.NOTIFICATION_REQUIRE_AAL2 || 'true').toLowerCase() !== 'false';
const EXTERNAL_CHANNEL_EXECUTOR_URL = (process.env.EXTERNAL_CHANNEL_EXECUTOR_URL || 'http://opensphere-external-channel-executor.opensphere-console.svc.cluster.local:8082').replace(/\/$/, '');
const EXTERNAL_CHANNEL_EXECUTOR_TOKEN = process.env.EXTERNAL_CHANNEL_EXECUTOR_TOKEN || '';
const EXTERNAL_CHANNEL_REQUIRE_AAL2 = String(process.env.EXTERNAL_CHANNEL_REQUIRE_AAL2 || 'true').toLowerCase() !== 'false';
const OAA_NAMESPACE = process.env.OAA_NAMESPACE || 'opensphere-console';
const OAA_KEY_NAMESPACE = process.env.OAA_KEY_NAMESPACE || 'opensphere-oaa-credentials';
const K8S_API = 'https://kubernetes.default.svc';
const OAA_KEY_LABEL = 'opensphere.io/oaa-llm-key';
const OAA_PART_LABEL = 'opensphere.io/part-of';
const OAA_KEY_ID_RE = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;
const OAA_PROVIDER_RE = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const OAA_MODEL_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const OAA_EMBED_DIM = Math.max(16, Math.min(4096, Number(process.env.OAA_EMBED_DIM || 1536) || 1536));
const OAA_SCALE_MAX = Math.max(1, Math.min(100, Number(process.env.OAA_SCALE_MAX || 10) || 10));
const OAA_ALLOWED_NAMESPACES = new Set((process.env.OAA_ALLOWED_NAMESPACES || 'opensphere-console,opensphere-console-data,opensphere-console-change')
  .split(',').map((value) => value.trim()).filter(Boolean));
const OAA_K8S_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const OAA_IMAGE_DIGEST_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*@sha256:[0-9a-f]{64}$/;
const OAA_RESOURCE_CONTRACT = Object.freeze({
  configmap: { kind: 'ConfigMap', apiVersion: 'v1' }, service: { kind: 'Service', apiVersion: 'v1' },
  persistentvolumeclaim: { kind: 'PersistentVolumeClaim', apiVersion: 'v1' },
  deployment: { kind: 'Deployment', apiVersion: 'apps/v1' }, statefulset: { kind: 'StatefulSet', apiVersion: 'apps/v1' },
  daemonset: { kind: 'DaemonSet', apiVersion: 'apps/v1' }, job: { kind: 'Job', apiVersion: 'batch/v1' }, cronjob: { kind: 'CronJob', apiVersion: 'batch/v1' },
  ingress: { kind: 'Ingress', apiVersion: 'networking.k8s.io/v1' }, networkpolicy: { kind: 'NetworkPolicy', apiVersion: 'networking.k8s.io/v1' },
  horizontalpodautoscaler: { kind: 'HorizontalPodAutoscaler', apiVersion: 'autoscaling/v2' }, poddisruptionbudget: { kind: 'PodDisruptionBudget', apiVersion: 'policy/v1' },
});
const OAA_WORKLOAD_KINDS = new Set(['deployment', 'statefulset', 'daemonset']);
const OAA_SCALABLE_KINDS = new Set(['deployment', 'statefulset']);
const OAA_APPLY_KINDS = new Set(Object.keys(OAA_RESOURCE_CONTRACT));
const OAA_DELETE_KINDS = new Set([...OAA_APPLY_KINDS].filter((kind) => kind !== 'persistentvolumeclaim'));

const CONSOLE_ROLE_GROUPS = new Set(
  (process.env.CONSOLE_ROLE_GROUPS || 'console-admins,console-operators,console-viewers')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const AUTH_PROVIDER = process.env.AUTH_PROVIDER || 'supabase';
let verifySupabaseToken = null;
if (AUTH_PROVIDER === 'supabase' || AUTH_PROVIDER === 'dual') {
  try {
    verifySupabaseToken = createSupabaseVerifier({
      serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
      dataAuthToken: () => backendHeaders('console').Authorization.replace('Bearer ', ''),
      profile: 'console',
      issuer: SUPABASE_AUTH_ISSUER,
      audience: SUPABASE_AUTH_AUDIENCE,
      jwtSecret: SUPABASE_JWT_SECRET,
      restUrl: SUPABASE_REST_URL,
      timeoutMs: process.env.SUPABASE_AUTHZ_TIMEOUT_MS,
    });
  } catch (error) {
    console.error('[auth] Supabase verifier initialization failed:', error?.message || error);
  }
}

const authErrorStatus = (error) => (
  Number.isInteger(error?.code) && error.code >= 400 && error.code <= 599 ? error.code : 502
);
const CONSOLE_ADMIN_COMPATIBILITY_GROUPS = (process.env.CONSOLE_ADMIN_COMPATIBILITY_GROUPS || 'opensphere-console-admins')
  .split(',').map((value) => value.trim()).filter(Boolean);
const audit = [];
let backendToken = SUPABASE_BACKEND_TOKEN;
let backendTokenExp = 0;

function b64urlDecode(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function b64urlParsePayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw { code: 401, msg: 'malformed token' };
  return JSON.parse(b64urlDecode(parts[1]));
}

function toHashHex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function b64urlEncode(value) {
  return Buffer.from(String(value)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlJson(value, label) {
  try { return JSON.parse(b64urlDecode(value)); }
  catch { throw { code: 401, msg: `invalid CLI ${label}` }; }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cliToken(payload) {
  if (!CLI_JWT_SECRET) throw { code: 503, msg: 'CLI_JWT_SECRET is required' };
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(JSON.stringify({ iss: CLI_TOKEN_ISSUER, aud: CLI_TOKEN_AUDIENCE, iat: Math.floor(Date.now() / 1000), ...payload }));
  const signed = `${header}.${body}`;
  return `${signed}.${createHmac('sha256', CLI_JWT_SECRET).update(signed).digest('base64url')}`;
}

function verifyCliToken(token) {
  if (!CLI_JWT_SECRET) throw { code: 503, msg: 'CLI_JWT_SECRET is required' };
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw { code: 401, msg: 'malformed CLI token' };
  const [headerPart, payloadPart, signature] = parts;
  const header = b64urlJson(headerPart, 'header');
  const claims = b64urlJson(payloadPart, 'payload');
  const expected = createHmac('sha256', CLI_JWT_SECRET).update(`${headerPart}.${payloadPart}`).digest('base64url');
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'HS256' || !safeEqual(expected, signature)) throw { code: 401, msg: 'bad CLI token signature' };
  if (claims.iss !== CLI_TOKEN_ISSUER || claims.aud !== CLI_TOKEN_AUDIENCE || !claims.sub || !claims.jti) throw { code: 401, msg: 'invalid CLI token claims' };
  if (!claims.iat || claims.iat > now + 30 || !claims.exp || claims.exp <= now) throw { code: 401, msg: 'expired CLI token' };
  if (!['cli_session', 'pat'].includes(claims.typ)) throw { code: 401, msg: 'unsupported CLI token type' };
  return claims;
}

function cliPublicJwk(value) {
  if (!value || typeof value !== 'object' || value.kty !== 'EC' || value.crv !== 'P-256' || typeof value.x !== 'string' || typeof value.y !== 'string') {
    throw { code: 400, msg: 'P-256 publicJwk is required' };
  }
  try { createPublicKey({ key: value, format: 'jwk' }); } catch { throw { code: 400, msg: 'invalid P-256 publicJwk' }; }
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
}

function cliFingerprint(jwk) {
  return createHash('sha256').update(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })).digest('hex').match(/.{1,2}/g).join(':');
}

function cliId(value, label = 'id') {
  const id = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw { code: 400, msg: `invalid CLI ${label}` };
  return id;
}

function cliLabel(value) {
  const label = String(value || '').trim();
  if (!label || label.length > 128) throw { code: 400, msg: 'CLI label must be 1-128 characters' };
  return label;
}

function buildBackendJwt() {
  if (!SUPABASE_JWT_SECRET || !SUPABASE_AUTH_ISSUER || !SUPABASE_BACKEND_DB_ROLE) return '';
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: SUPABASE_AUTH_ISSUER,
    aud: SUPABASE_AUTH_AUDIENCE,
    role: SUPABASE_BACKEND_DB_ROLE,
    sub: 'opensphere-console-backend',
    iat: now,
    exp: now + Math.max(3600, SUPABASE_BACKEND_TOKEN_TTL_SEC),
  };
  const token = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', SUPABASE_JWT_SECRET)
    .update(token)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${token}.${signature}`;
}

function backendHeaders(profile = 'console') {
  if (!backendToken || Date.now() / 1000 > backendTokenExp - 60) {
    backendToken = buildBackendJwt();
    const issuedAt = Math.floor(Date.now() / 1000);
    backendTokenExp = issuedAt + Math.max(3600, SUPABASE_BACKEND_TOKEN_TTL_SEC);
  }
  if (!backendToken || !SUPABASE_SERVICE_ROLE_KEY) throw { code: 503, msg: 'Supabase backend credentials are not configured' };
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${backendToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (profile) {
    headers['accept-profile'] = profile;
    headers['content-profile'] = profile;
  }
  return headers;
}

function adminHeaders() {
  if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_REST_URL) {
    throw { code: 503, msg: 'Supabase admin credentials are not configured' };
  }
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
}

function normalizeQuery(query) {
  if (typeof query === 'string') return query;
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  return params.toString();
}

async function restRequest(resource, {
  method = 'GET',
  query = '',
  body = undefined,
  prefer = 'return=representation',
  timeoutMs = SUPABASE_TIMEOUT_MS,
  profile = 'console',
} = {}) {
  const url = new URL(`${SUPABASE_REST_URL.replace(/\/$/, '')}/${resource}`);
  const q = normalizeQuery(query);
  if (q) url.search = q;
  const options = {
    method,
    headers: { ...backendHeaders(profile), Prefer: prefer },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(url, options);
  const text = await response.text();
  const parse = () => {
    if (!text) return [];
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  if (!response.ok) throw {
    code: response.status,
    msg: `Supabase REST ${resource} ${method} failed`,
    detail: text.slice(0, 300),
    source: response.statusText,
  };
  if (text.length === 0) return [];
  return parse();
}

/**
 * Credentials move from the authenticated Console Backend directly to the
 * Dispatcher over the cluster service path.  The Backend never persists or
 * reads the encrypted secret table; the Dispatcher is the sole decryptor.
 */
async function notificationDispatcherRequest(pathName, body) {
  if (!NOTIFICATION_DISPATCHER_TOKEN) throw { code: 503, msg: 'notification dispatcher credential path is not configured' };
  const response = await fetch(`${NOTIFICATION_DISPATCHER_URL}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-notification-dispatcher-token': NOTIFICATION_DISPATCHER_TOKEN },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  if (!response.ok) throw { code: response.status === 401 || response.status === 403 ? 502 : response.status, msg: parsed.error || 'notification dispatcher request failed' };
  return parsed;
}

/**
 * External backup execution uses a separate internal credential, DB role and
 * runtime process from notification delivery. The Backend passes plaintext
 * credentials only once and never receives stored credentials back.
 */
async function externalChannelExecutorRequest(pathName, body, timeoutMs = 15000) {
  if (!EXTERNAL_CHANNEL_EXECUTOR_TOKEN) throw { code: 503, msg: 'external channel executor credential path is not configured' };
  const response = await fetch(`${EXTERNAL_CHANNEL_EXECUTOR_URL}${pathName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-external-channel-executor-token': EXTERNAL_CHANNEL_EXECUTOR_TOKEN,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  let parsed = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
  if (!response.ok) throw {
    code: response.status === 401 || response.status === 403 ? 502 : response.status,
    msg: parsed.error || 'external channel executor request failed',
    externalCode: parsed.code || null,
    field: parsed.field || null,
  };
  return parsed;
}

async function authAdminRequest(pathName, { method = 'GET', body = undefined, timeoutMs = SUPABASE_TIMEOUT_MS, query = '' } = {}) {
  if (!SUPABASE_AUTH_URL) throw { code: 503, msg: 'SUPABASE_AUTH_URL is required' };
  const base = SUPABASE_AUTH_URL.replace(/\/$/, '');
  const url = new URL(`${base}${pathName}`);
  if (query && typeof query === 'string' && query.trim()) {
    url.search = query.startsWith('?') ? query.slice(1) : query;
  }
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const parse = () => {
    if (!text) return {};
    try { return JSON.parse(text); } catch { return text; }
  };
  if (!response.ok) throw {
    code: response.status,
    msg: `Supabase Auth ${pathName} ${method} failed`,
    detail: text.slice(0, 300),
  };
  if (!text) return {};
  return parse();
}

function inClause(values) {
  return `(${values.filter(Boolean).map((v) => `"${String(v)}"`).join(',')})`;
}

function userFromAuthRow(row, fallbackName = 'user') {
  if (!row) return { id: '', email: '', username: fallbackName, displayName: fallbackName };
  const raw = row.raw_user_meta_data || row.raw_app_meta_data || {};
  const display = (row.raw_user_meta_data && (row.raw_user_meta_data.name || row.raw_user_meta_data.display_name)) || raw?.preferred_username || '';
  return {
    id: row.id,
    email: row.email || '',
    username: raw?.preferred_username || (row.email ? String(row.email).split('@')[0] : 'user'),
    displayName: display || (row.email ? String(row.email).split('@')[0] : ''),
  };
}

async function verifyAuthed(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) throw { code: 401, msg: 'no bearer token' };
  // CLI credentials have a dedicated issuer/key, but resolve their subject and
  // current roles from the same Supabase projection as browser sessions.
  let unverifiedClaims = null;
  try { unverifiedClaims = b64urlParsePayload(match[1]); } catch { /* verified below */ }
  if (unverifiedClaims?.iss === CLI_TOKEN_ISSUER) {
    const actor = await verifyManagedCliToken(match[1]);
    enforcePatRequestScope(req, actor);
    return actor;
  }
  if (AUTH_PROVIDER !== 'supabase') {
    throw { code: 503, msg: 'unsupported Console identity provider; set AUTH_PROVIDER=supabase' };
  }
  if (!verifySupabaseToken) throw { code: 503, msg: 'supabase token verifier unavailable' };
  if (AUTH_PROVIDER === 'supabase' || AUTH_PROVIDER === 'dual') {
    if (AUTH_PROVIDER === 'dual') {
      const claims = b64urlParsePayload(match[1]);
      if (claims?.iss !== SUPABASE_AUTH_ISSUER) throw { code: 401, msg: 'unsupported token issuer' };
    }
    return verifySupabaseToken(match[1]);
  }
  return verifySupabaseToken(match[1]);
}

async function resolveConsoleActor(subject, claims = {}) {
  const encoded = encodeURIComponent(subject);
  const [operators, assignments] = await Promise.all([
    restRequest('operator', { query: `select=status,credential_revision,display_name&user_id=eq.${encoded}` }),
    restRequest('operator_role', { query: `select=expires_at,role(code)&user_id=eq.${encoded}` }),
  ]);
  const operator = Array.isArray(operators) ? operators[0] : null;
  if (!operator || operator.status !== 'active') throw { code: 401, msg: 'operator inactive or unknown' };
  if (claims.credential_revision !== undefined && Number(claims.credential_revision) !== Number(operator.credential_revision)) {
    throw { code: 401, msg: 'credential revision revoked' };
  }
  const groups = (Array.isArray(assignments) ? assignments : [])
    .filter((entry) => !entry.expires_at || Date.parse(entry.expires_at) > Date.now())
    .map((entry) => entry.role?.code).filter(Boolean);
  return {
    sub: subject,
    username: claims.email || subject,
    displayName: operator.display_name || '',
    groups,
    // A device key or PAT proves possession of that credential, not that the
    // user completed a current Supabase second-factor challenge.  CLI step-up
    // is a separate browser-mediated flow; until then CLI credentials remain
    // aal1 and cannot satisfy an AAL2-required management operation.
    assurance: 'aal1',
    authSessionId: claims.jti || null,
    deviceId: claims.device_id || null,
    provider: 'supabase-cli',
    credentialRevision: operator.credential_revision,
    cliCredentialType: claims.typ || null,
    cliScope: claims.scope || (claims.typ === 'pat' ? 'console-admin' : null),
  };
}

async function verifyManagedCliToken(token) {
  const claims = verifyCliToken(token);
  const resource = claims.typ === 'pat' ? 'api_token' : 'cli_session';
  const fields = claims.typ === 'pat'
    ? 'id,owner_id,credential_revision,status,expires_at,token_hash,scope'
    : 'id,owner_id,device_id,credential_revision,status,expires_at';
  const rows = await restRequest(resource, { query: `select=${fields}&id=eq.${encodeURIComponent(claims.jti)}` });
  const record = Array.isArray(rows) ? rows[0] : null;
  if (!record || record.status !== 'active' || Date.parse(record.expires_at) <= Date.now() || record.owner_id !== claims.sub) {
    throw { code: 401, msg: 'CLI credential inactive or revoked' };
  }
  if (claims.typ === 'pat' && !safeEqual(record.token_hash, toHashHex(token))) throw { code: 401, msg: 'CLI token binding mismatch' };
  if (claims.typ === 'cli_session' && (!claims.device_id || record.device_id !== claims.device_id)) throw { code: 401, msg: 'CLI session device mismatch' };
  if (Number(record.credential_revision) !== Number(claims.credential_revision)) throw { code: 401, msg: 'CLI credential revision revoked' };
  const usedAt = new Date().toISOString();
  const usageWrites = [
    restRequest(resource, { method: 'PATCH', query: `id=eq.${encodeURIComponent(claims.jti)}`, body: { last_used_at: usedAt }, prefer: 'return=minimal' }),
  ];
  if (claims.typ === 'cli_session') {
    usageWrites.push(restRequest('cli_device', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(record.device_id)}&owner_id=eq.${encodeURIComponent(claims.sub)}&status=eq.active`,
      body: { last_used_at: usedAt },
      prefer: 'return=minimal',
    }));
  }
  await Promise.all(usageWrites).catch((error) => {
    console.error('[auth] CLI credential usage timestamp update failed:', error?.message || error);
  });
  return resolveConsoleActor(claims.sub, { ...claims, scope: record.scope || claims.scope || (claims.typ === 'pat' ? 'console-admin' : null) });
}

async function verifyActor(req) {
  const actor = await verifyAuthed(req);
  if (!actor.groups || !actor.groups.includes(SUPABASE_BACKEND_ROLE)) throw { code: 403, msg: `requires ${SUPABASE_BACKEND_ROLE}` };
  if (SUPABASE_REQUIRE_AAL2 && actor.assurance !== 'aal2') {
    throw { code: 403, msg: 'admin action requires MFA assurance aal2' };
  }
  return actor;
}

function isMutationRequest(req) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(req?.method || 'GET').toUpperCase());
}

async function verifyConsoleAdmin(req, options = {}) {
  const actor = await verifyAuthed(req);
  if (!actor.groups || !actor.groups.includes(SUPABASE_BACKEND_ROLE)) {
    throw { code: 403, msg: `requires ${SUPABASE_BACKEND_ROLE}` };
  }
  const requireAal2 = options.requireAal2 === true
    || (options.requireAal2 !== false && SUPABASE_REQUIRE_AAL2 && isMutationRequest(req));
  if (requireAal2 && actor.assurance !== 'aal2') {
    throw { code: 403, msg: 'admin mutation requires MFA assurance aal2' };
  }
  return actor;
}

async function verifyOaaIdentityOwner(req, options = {}) {
  const actor = await verifyAuthed(req);
  if (!actor.groups?.includes(SUPABASE_BACKEND_ROLE)) throw { code: 403, msg: `requires ${SUPABASE_BACKEND_ROLE}` };
  requireActorPermission(actor, 'console.identity.manage');
  // Inventory reads are permission-gated and PII-minimized. Mutations never
  // receive the optional non-MFA bootstrap exception used by the interactive
  // Console during first-install recovery.
  if (options.requireAal2 === true && actor.assurance !== 'aal2') {
    throw { code: 403, msg: 'OAA identity owner action requires MFA assurance aal2' };
  }
  return actor;
}

function managementReason(value) {
  const reason = String(value || '').trim();
  return reason.length >= 8 ? reason : null;
}

function recordLocalAudit(entry) {
  audit.unshift(entry);
  if (audit.length > 200) audit.pop();
}
async function logAudit(actor, action, target, result, reason, opts = {}) {
  const requestId = opts.requestId || newOpId();
  const phase = opts.phase || 'applied';
  const targetType = opts.targetType || 'console-identity';
  const actorId = actor?.sub || actor?.id || actor?.user_id;
  if (!actorId) throw { code: 401, msg: 'audit actor identity unavailable' };
  const row = {
    request_id: requestId,
    correlation_id: requestId,
    actor_type: 'human',
    actor_id: actorId,
    auth_session_id: actor?.authSessionId || null,
    action,
    target_type: targetType,
    target_id: target,
    reason,
    phase,
    result,
    payload_digest: opts.payloadDigest ? `sha256:${opts.payloadDigest}` : null,
    event_hash: `sha256:${toHashHex(JSON.stringify({ requestId, actorId, action, target, reason, phase, result }))}`,
  };
  const r = await restRequest('event', {
    profile: 'audit',
    method: 'POST',
    query: 'select=correlation_id,request_id,actor_type,action,target_id,result',
    body: [row],
    prefer: 'return=representation',
  });
  const persisted = Array.isArray(r) && r[0] ? r[0] : row;
  recordLocalAudit({
    time: new Date().toISOString(),
    opId: requestId,
    actor: actorId,
    action,
    target,
    result,
    reason,
    phase,
    requestId: persisted.request_id,
  });
  return persisted;
}

function projectedSessionGroups(actor) {
  const groups = new Set(Array.isArray(actor?.groups) ? actor.groups : []);
  if (groups.has(SUPABASE_BACKEND_ROLE)) {
    for (const alias of CONSOLE_ADMIN_COMPATIBILITY_GROUPS) groups.add(alias);
  }
  return [...groups];
}

const notificationApi = createNotificationApi({
  restRequest,
  logAudit,
  managementReason,
  newOpId,
  dispatcherRequest: notificationDispatcherRequest,
});

const externalChannelApi = createExternalChannelApi({
  restRequest,
  logAudit,
  managementReason,
  newOpId,
  executorRequest: externalChannelExecutorRequest,
});

async function verifyNotificationAdmin(req) {
  const actor = await verifyConsoleAdmin(req);
  if (NOTIFICATION_REQUIRE_AAL2 && actor.assurance !== 'aal2') {
    throw { code: 403, msg: 'notification configuration requires MFA assurance aal2' };
  }
  return actor;
}

async function verifyExternalChannelAdmin(req) {
  const actor = await verifyConsoleAdmin(req);
  requireActorPermission(actor, 'console.backup.restore');
  if (EXTERNAL_CHANNEL_REQUIRE_AAL2 && isMutationRequest(req) && actor.assurance !== 'aal2') {
    throw { code: 403, msg: 'external backup mutation requires MFA assurance aal2' };
  }
  return actor;
}

async function verifyOaaNotificationOwner(req, options = {}) {
  const actor = await verifyAuthed(req);
  requireActorPermission(actor, options.mutation === true ? 'console.notification.manage' : 'console.notification.read');
  if (options.mutation === true && actor.assurance !== 'aal2') {
    throw { code: 403, msg: 'OAA notification owner action requires MFA assurance aal2' };
  }
  return actor;
}

async function verifyOaaRecoveryOwner(req) {
  const actor = await verifyAuthed(req);
  requireActorPermission(actor, 'console.recovery.read');
  return actor;
}

async function oaaNotificationStatus(rawLimit) {
  const limit = Number(rawLimit || 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw { code: 400, msg: 'notification delivery limit must be 1-100' };
  const [summary, channels, rules, deliveries] = await Promise.all([
    notificationApi.summary(), notificationApi.channels(), notificationApi.rules(), notificationApi.deliveries({ limit }),
  ]);
  return {
    schema: 'oaa-notification-owner-status.opensphere.io/v1alpha1',
    owner: 'Console Notification Delivery / Supabase',
    observedAt: new Date().toISOString(),
    summary,
    channels,
    rules: rules.map((rule) => ({
      id: rule.id, name: rule.name, enabled: rule.enabled, priority: rule.priority,
      minSeverity: rule.minSeverity, sources: rule.sources, categories: rule.categories,
      channelIds: rule.channelIds, channels: (rule.channels || []).map((channel) => ({
        id: channel.id, name: channel.name, provider: channel.provider,
        enabled: Boolean(channel.enabled), healthState: channel.health_state || channel.healthState || '',
      })),
      updatedAt: rule.updatedAt,
    })),
    // Message bodies, titles, routes, provider message IDs and recipients are
    // excluded from the LLM-facing delivery projection.
    deliveries: deliveries.map((delivery) => ({
      id: delivery.id, status: delivery.status, attempts: delivery.attempts,
      lastErrorCode: delivery.lastErrorCode || '', updatedAt: delivery.updatedAt,
      nextAttemptAt: delivery.nextAttemptAt || null,
      channel: delivery.channel ? {
        id: delivery.channel.id, name: delivery.channel.name, provider: delivery.channel.provider,
      } : null,
      event: delivery.event ? {
        source: delivery.event.source, severity: delivery.event.severity, occurredAt: delivery.event.occurred_at,
      } : null,
    })),
  };
}

function requireClosedOaaNotificationBody(body, allowed) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw { code: 400, msg: 'OAA notification owner body must be an object' };
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length) throw { code: 400, msg: `OAA notification owner action contains unsupported inputs: ${extra.join(', ')}` };
}

async function oaaNotificationOwnerAction(actor, rawBody) {
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {};
  const action = String(body.action || '').trim().toLowerCase();
  const reason = requireOaaText(body.reason, 'management reason');
  if (action === 'set-channel-enabled') {
    requireClosedOaaNotificationBody(body, ['action', 'channelId', 'enabled', 'confirm', 'reason']);
    const channelId = uuid(body.channelId, 'notification channel id');
    if (typeof body.enabled !== 'boolean') throw { code: 400, msg: 'enabled must be boolean' };
    const verb = body.enabled ? 'enable' : 'disable';
    requireExactOaaConfirmation(body.confirm, `${verb} notification channel ${channelId}`);
    await notificationApi.setChannelEnabled(actor, channelId, body.enabled, { reason });
    return { accepted: true, owner: 'Console Notification Delivery / Supabase', target: `NotificationChannel/${channelId}`, enabled: body.enabled };
  }
  if (action === 'test-channel') {
    requireClosedOaaNotificationBody(body, ['action', 'channelId', 'confirm', 'reason']);
    const channelId = uuid(body.channelId, 'notification channel id');
    requireExactOaaConfirmation(body.confirm, `test notification channel ${channelId}`);
    const result = await notificationApi.testChannel(actor, channelId, { reason });
    return { accepted: Boolean(result?.accepted), owner: 'Console Notification Delivery / Supabase', target: `NotificationChannel/${channelId}`, status: result?.accepted ? 'accepted' : 'rejected' };
  }
  if (action === 'retry-delivery') {
    requireClosedOaaNotificationBody(body, ['action', 'deliveryId', 'confirm', 'reason']);
    const deliveryId = uuid(body.deliveryId, 'notification delivery id');
    requireExactOaaConfirmation(body.confirm, `retry notification delivery ${deliveryId}`);
    await notificationApi.retryDelivery(actor, deliveryId, { reason });
    return { accepted: true, owner: 'Console Notification Delivery / Supabase', target: `NotificationDelivery/${deliveryId}`, status: 'queued' };
  }
  throw { code: 400, msg: 'OAA notification action must be set-channel-enabled, test-channel, or retry-delivery' };
}

async function publishNotificationEvent(req, body) {
  const supplied = String(req.headers['x-opensphere-notification-token'] || '');
  if (!NOTIFICATION_EVENT_TOKEN || !safeEqual(supplied, NOTIFICATION_EVENT_TOKEN)) throw { code: 401, msg: 'notification producer authentication failed' };
  const event = normalizedEvent(body);
  const rows = await restRequest('notification_event', {
    method: 'POST',
    body: [{
      source_type: event.sourceType,
      source_id: event.sourceId,
      source: event.source,
      category: event.category,
      severity: event.severity,
      title: event.title,
      body: event.body,
      route: event.route,
      labels: event.labels,
      occurred_at: event.occurredAt,
      correlation_id: String(req.headers['x-os-correlation-id'] || '').slice(0, 128) || null,
      payload_digest: `sha256:${toHashHex(JSON.stringify(event))}`,
    }],
  });
  return { accepted: true, id: rows[0]?.id || null };
}

const OAA_ACTION_POLICY = Object.freeze({
  'oaa.k8s.deployment.restart': { permission: 'oaa.action.execute.high', risk: 'high', targetType: 'kubernetes-deployment', action: 'apply' },
  'oaa.k8s.deployment.scale': { permission: 'oaa.action.execute.high', risk: 'high', targetType: 'kubernetes-deployment', action: 'apply' },
  'oaa.k8s.workload.restart': { permission: 'oaa.action.execute.high', risk: 'high', targetType: 'kubernetes-workload', action: 'apply' },
  'oaa.k8s.workload.scale': { permission: 'oaa.action.execute.high', risk: 'high', targetType: 'kubernetes-workload', action: 'apply' },
  'oaa.k8s.workload.update-image': { permission: 'oaa.action.execute.high', risk: 'high', targetType: 'kubernetes-workload', action: 'apply' },
  'oaa.k8s.workload.rollback-image': { permission: 'oaa.action.execute.high', risk: 'critical', targetType: 'kubernetes-workload', action: 'rollback' },
  'oaa.k8s.resource.apply': { permission: 'oaa.action.execute.high', risk: 'high', targetType: 'kubernetes-resource', action: 'apply' },
  'oaa.k8s.resource.delete': { permission: 'oaa.action.execute.high', risk: 'critical', targetType: 'kubernetes-resource', action: 'delete' },
  'oaa.k8s.cronjob.run': { permission: 'oaa.action.execute.high', risk: 'high', targetType: 'kubernetes-cronjob', action: 'apply' },
  'oaa.k8s.cronjob.suspend': { permission: 'oaa.action.execute.high', risk: 'high', targetType: 'kubernetes-cronjob', action: 'configure' },
});

function actorHasPermission(actor, permission) {
  return Boolean(actor?.groups?.includes(SUPABASE_BACKEND_ROLE) || actor?.permissions?.includes(permission));
}

function requireActorPermission(actor, permission) {
  if (!actorHasPermission(actor, permission)) throw { code: 403, msg: `requires ${permission}` };
}

function oaaTarget(value) {
  const target = String(value || '').trim();
  if (!target || target.length > 300 || /[\r\n]/.test(target)) throw { code: 400, msg: 'invalid OAA action target' };
  return target;
}

function oaaInputObject(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw { code: 400, msg: 'OAA action inputs must be an object' };
  return { ...value };
}

function oaaNamespace(value) {
  const namespace = String(value || '').trim();
  if (!OAA_K8S_NAME_RE.test(namespace) || !OAA_ALLOWED_NAMESPACES.has(namespace)) throw { code: 400, msg: 'OAA action namespace is not allowlisted' };
  return namespace;
}

function oaaName(value, label = 'name') {
  const name = String(value || '').trim();
  if (!OAA_K8S_NAME_RE.test(name)) throw { code: 400, msg: `invalid OAA ${label}` };
  return name;
}

function oaaKind(value, allowed) {
  const kind = String(value || '').trim().toLowerCase().replace(/[._-]/g, '');
  if (!allowed.has(kind)) throw { code: 400, msg: 'OAA Kubernetes kind is outside the action allowlist' };
  return kind;
}

function requireExactOaaConfirmation(actual, expected) {
  if (String(actual || '').trim() !== expected) throw { code: 400, msg: `confirmation required: ${expected}` };
}

function requireOaaText(value, label, minimum = 8) {
  const text = String(value || '').trim();
  if (text.length < minimum || text.length > 2000) throw { code: 400, msg: `${label} must be ${minimum}-2000 characters` };
  return text;
}

function validatePinnedManifestImages(kind, manifest) {
  let podSpec = null;
  if (['deployment', 'statefulset', 'daemonset', 'job'].includes(kind)) podSpec = manifest.spec?.template?.spec;
  if (kind === 'cronjob') podSpec = manifest.spec?.jobTemplate?.spec?.template?.spec;
  if (!podSpec) return;
  for (const container of [...(podSpec.initContainers || []), ...(podSpec.containers || [])]) {
    if (!OAA_K8S_NAME_RE.test(String(container?.name || ''))) throw { code: 400, msg: 'workload manifest container name is invalid' };
    if (!OAA_IMAGE_DIGEST_RE.test(String(container?.image || ''))) throw { code: 400, msg: 'OAA workload manifests require repository@sha256 digest-pinned images' };
  }
}

function validateOaaManifest(kind, namespace, name, value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw { code: 400, msg: 'manifest must be a Kubernetes JSON object' };
  const contract = OAA_RESOURCE_CONTRACT[kind];
  if (!contract || value.kind !== contract.kind || value.apiVersion !== contract.apiVersion) throw { code: 400, msg: 'manifest apiVersion/kind does not match the allowlisted resource contract' };
  if (value.metadata?.namespace !== namespace || value.metadata?.name !== name) throw { code: 400, msg: 'manifest metadata must match the confirmed namespace and name' };
  if (value.status !== undefined) throw { code: 400, msg: 'manifest status is observed state and may not be submitted' };
  const metadataKeys = Object.keys(value.metadata || {});
  if (metadataKeys.some((key) => !['name', 'namespace', 'labels', 'annotations'].includes(key))) throw { code: 400, msg: 'manifest metadata may contain only name, namespace, labels, and annotations' };
  validatePinnedManifestImages(kind, value);
  return value;
}

function validateOaaActionInputs(toolId, rawInputs) {
  const inputs = oaaInputObject(rawInputs);
  const namespace = oaaNamespace(inputs.namespace);
  const name = oaaName(inputs.name || inputs.deployment, 'resource name');
  let kind = 'deployment';
  let rollbackOf = null;
  if (toolId === 'oaa.k8s.deployment.restart') {
    requireExactOaaConfirmation(inputs.confirm, `restart deployment ${namespace}/${name}`);
  } else if (toolId === 'oaa.k8s.deployment.scale') {
    const replicas = Number(inputs.replicas);
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > OAA_SCALE_MAX) throw { code: 400, msg: `replicas must be between 0 and ${OAA_SCALE_MAX}` };
    inputs.replicas = replicas;
    requireExactOaaConfirmation(inputs.confirm, `scale deployment ${namespace}/${name} to ${replicas}`);
  } else if (toolId === 'oaa.k8s.workload.restart') {
    kind = oaaKind(inputs.kind, OAA_WORKLOAD_KINDS);
    requireExactOaaConfirmation(inputs.confirm, `restart ${kind} ${namespace}/${name}`);
  } else if (toolId === 'oaa.k8s.workload.scale') {
    kind = oaaKind(inputs.kind, OAA_SCALABLE_KINDS);
    const replicas = Number(inputs.replicas);
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > OAA_SCALE_MAX) throw { code: 400, msg: `replicas must be between 0 and ${OAA_SCALE_MAX}` };
    inputs.replicas = replicas;
    requireExactOaaConfirmation(inputs.confirm, `scale ${kind} ${namespace}/${name} to ${replicas}`);
  } else if (toolId === 'oaa.k8s.workload.update-image' || toolId === 'oaa.k8s.workload.rollback-image') {
    kind = oaaKind(inputs.kind, OAA_WORKLOAD_KINDS);
    inputs.container = oaaName(inputs.container, 'container name');
    inputs.image = String(inputs.image || '').trim();
    if (!OAA_IMAGE_DIGEST_RE.test(inputs.image)) throw { code: 400, msg: 'image must be pinned as repository@sha256:<64 hex>' };
    const verb = toolId.endsWith('rollback-image') ? 'rollback' : 'update';
    requireExactOaaConfirmation(inputs.confirm, `${verb} image ${kind} ${namespace}/${name} container ${inputs.container} to ${inputs.image}`);
    if (verb === 'rollback') {
      rollbackOf = uuid(inputs.rollbackOf, 'rollbackOf request id');
      inputs.rollbackOf = rollbackOf;
    }
  } else if (toolId === 'oaa.k8s.resource.apply') {
    kind = oaaKind(inputs.kind, OAA_APPLY_KINDS);
    inputs.manifest = validateOaaManifest(kind, namespace, name, inputs.manifest);
    requireExactOaaConfirmation(inputs.confirm, `apply ${kind} ${namespace}/${name}`);
  } else if (toolId === 'oaa.k8s.resource.delete') {
    kind = oaaKind(inputs.kind, OAA_DELETE_KINDS);
    inputs.impact = requireOaaText(inputs.impact, 'impact assessment');
    inputs.recoveryPlan = requireOaaText(inputs.recoveryPlan, 'recovery plan');
    inputs.backupReference = requireOaaText(inputs.backupReference, 'backup reference', 3);
    requireExactOaaConfirmation(inputs.confirm, `delete ${kind} ${namespace}/${name}`);
  } else if (toolId === 'oaa.k8s.cronjob.run') {
    kind = 'cronjob';
    requireExactOaaConfirmation(inputs.confirm, `run cronjob ${namespace}/${name}`);
  } else if (toolId === 'oaa.k8s.cronjob.suspend') {
    kind = 'cronjob';
    if (typeof inputs.suspend !== 'boolean') throw { code: 400, msg: 'suspend must be boolean' };
    requireExactOaaConfirmation(inputs.confirm, `set cronjob ${namespace}/${name} suspend ${inputs.suspend}`);
  } else {
    throw { code: 403, msg: 'OAA tool has no executable input contract' };
  }
  inputs.namespace = namespace;
  inputs.name = name;
  inputs.kind = kind;
  return { inputs, target: `${kind}:${namespace}/${name}`, rollbackOf };
}

async function requireOaaLifecycleGate(authorization) {
  let response;
  try {
    response = await fetch(`${DUPA_CONTROL_URL}/api/admin/platform-readiness/status`, {
      headers: { authorization: String(authorization || ''), accept: 'application/json' }, signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw { code: 503, msg: 'OAA lifecycle authority is unavailable' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw { code: response.status === 401 || response.status === 403 ? response.status : 503, msg: body.error || 'OAA lifecycle gate is unavailable' };
  const prerequisites = Array.isArray(body.prerequisites) ? body.prerequisites : [];
  const clusterManager = prerequisites.find((item) => item.key === 'cluster-manager');
  const hisBinding = prerequisites.find((item) => item.key === 'his-binding');
  if (!clusterManager?.ready || !hisBinding?.ready) throw { code: 409, msg: 'OAA mutations require Cluster Manager Activated and HIS Preflight Ready' };
  return { clusterManager: true, hisPreflight: true, observedAt: body.observedAt || null };
}

// OAA never receives Kubernetes write credentials. A non-read OAA request is
// materialized as a governed Gitea proposal through the same adapter used by
// the native Change Control screen.
async function submitOaaAction(actor, body = {}, authorization = '') {
  const toolId = String(body.toolId || '').trim();
  const policy = OAA_ACTION_POLICY[toolId];
  if (!policy) throw { code: 403, msg: 'OAA tool is not an approved Console control-plane action' };
  await requireOaaLifecycleGate(authorization);
  requireActorPermission(actor, policy.permission);
  if (OAA_ACTION_REQUIRE_AAL2 && ['high', 'critical'].includes(policy.risk) && actor.assurance !== 'aal2') {
    throw { code: 403, msg: 'high-risk OAA action requires MFA assurance aal2' };
  }
  const reason = managementReason(body.reason);
  if (!reason) throw { code: 400, msg: 'management reason must be at least 8 characters' };
  const validated = validateOaaActionInputs(toolId, body.inputs);
  const target = oaaTarget(validated.target);
  const inputs = validated.inputs;
  const payloadDigest = toHashHex(canonicalJson({ toolId, target, inputs, bindingId: body.bindingId || '' }));
  const proposal = await governedChange(actor, {
    consumerId: 'oaa-gateway', action: policy.action || 'apply', target, reason,
    desiredState: { toolId, target, inputs, bindingId: body.bindingId || '', requiredPermission: policy.permission },
    idempotencyKey: `oaa:${payloadDigest}:${actor.sub}`.slice(0, 200),
    ...(validated.rollbackOf ? { rollbackOf: validated.rollbackOf } : {}),
  });
  return {
    accepted: true,
    execution: proposal.duplicate ? 'existing-governed-change' : 'gitea-pr-created',
    requestId: proposal.requestId,
    status: proposal.status || 'authorized',
    pullRequest: proposal.pullRequest || null,
    toolId,
    target,
    requiredPermission: policy.permission,
  };
}

async function requireSupabase() {
  const result = await restRequest('operator', {
    query: 'select=user_id&limit=1',
    prefer: 'count=exact',
  });
  if (!Array.isArray(result)) {
    throw { code: 503, msg: 'Supabase data and identity authority unavailable' };
  }
  return { ready: true, service: 'supabase-data-identity', source: 'supabase', version: VERSION };
}

async function serviceProbe(key, name, url, responsibility) {
  if (!url) return { key, name, responsibility, ready: false, detail: 'not configured' };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });
    // Auth and Storage versions do not expose an identical health route.
    // A non-5xx response proves that the service is reachable; the database
    // projections below prove that its Console contract is usable.
    return { key, name, responsibility, ready: response.status < 500, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { key, name, responsibility, ready: false, detail: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

async function storageBuckets() {
  const response = await fetch(`${SUPABASE_STORAGE_URL.replace(/\/$/, '')}/bucket`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw { code: response.status, msg: 'Supabase Storage bucket query failed', detail: text.slice(0, 300) };
  const rows = JSON.parse(text || '[]');
  return Array.isArray(rows) ? rows : [];
}

// Recovery evidence is intentionally narrow: it gives operators verified
// state and assertions, never vault locations, key material or checksums.
// The ServiceAccount has a resource-name-scoped read permission only.
async function recoveryEvidence() {
  try {
    const configMap = await k8sGet('/api/v1/namespaces/opensphere-console/configmaps/opensphere-platform-recovery-evidence');
    const raw = String(configMap?.data?.['recovery-evidence.json'] || '');
    if (!raw) return { available: false, reason: 'recovery evidence is empty' };
    const normalized = normalizedRecoveryEvidence(JSON.parse(raw));
    return {
      ...normalized,
      // Compatibility aliases retained for the existing Data & Identity and
      // Gitea management screens while OAA consumes the typed restore map.
      supabase: normalized.restore.supabaseDatabase,
      storage: normalized.restore.supabaseStorage,
      gitea: normalized.restore.gitea,
    };
  } catch (error) {
    return { available: false, reason: String(error?.message || 'recovery evidence unavailable').slice(0, 240) };
  }
}

async function oaaRecoveryCapabilities() {
  return {
    apiVersion: 'opensphere.io/oaa-recovery-owner/v1',
    owner: 'Console Platform Recovery / Supabase + Gitea',
    capabilities: ['status-read', 'plan-read'],
    // This Backend is a read/plan owner only. A future signed executor must
    // advertise drill-request/evidence-promote before the Gateway exposes
    // either mutation; scripts or arbitrary shell are never a capability.
    executionAvailable: false,
  };
}

async function oaaRecoveryStatus() {
  return buildRecoveryOwnerStatus(await recoveryEvidence(), { executorAvailable: false });
}

async function oaaRecoveryPlan(rawBody) {
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {};
  const extra = Object.keys(body).filter((key) => key !== 'component');
  if (extra.length) throw { code: 400, msg: `OAA recovery plan contains unsupported inputs: ${extra.join(', ')}` };
  return buildRecoveryPlan(await recoveryEvidence(), body.component || 'all', { executorAvailable: false });
}

async function supabaseStatus() {
  const [operators, roles, auditEvents, buckets, auth, rest, storage, contracts, recovery] = await Promise.all([
    restRequest('operator', { query: 'select=user_id' }),
    restRequest('role', { query: 'select=id,code,description' }),
    restRequest('event', { profile: 'audit', query: 'select=request_id&limit=1000' }),
    storageBuckets(),
    serviceProbe('auth', 'Supabase Auth', `${SUPABASE_AUTH_URL.replace(/\/$/, '')}/health`, 'Console identity and session issuance'),
    serviceProbe('data', 'Supabase PostgREST', `${SUPABASE_REST_URL.replace(/\/$/, '')}/`, 'RLS-protected Console data API'),
    serviceProbe('storage', 'Supabase Storage', `${SUPABASE_STORAGE_URL.replace(/\/$/, '')}/status`, 'Console uploads and operation artifacts'),
    consumerContracts().catch(() => []),
    recoveryEvidence(),
  ]);
  return {
    meta: { source: 'supabase', version: VERSION, checkedAt: new Date().toISOString() },
    components: [auth, rest, storage],
    operators: Array.isArray(operators) ? operators.length : 0,
    roles: Array.isArray(roles) ? roles : [],
    auditEvents: Array.isArray(auditEvents) ? auditEvents.length : 0,
    buckets: Array.isArray(buckets) ? buckets : [],
    database: {
      authority: 'Supabase PostgreSQL',
      accessModel: 'Console API uses the dedicated opensphere_console_backend role; browser clients never receive that credential.',
      rls: { state: 'Enforced', evidence: 'Console schemas expose RLS-backed PostgREST projections only.' },
    },
    auth: {
      authority: 'Supabase Auth',
      sessionModel: 'Supabase access and refresh sessions; Console validates the issuer and audience at every API request.',
      elevatedChange: 'Governed Gitea changes require MFA assurance (aal2).',
    },
    integrations: (Array.isArray(contracts) ? contracts : []).map((contract) => ({
      consumerId: contract.consumer_id, displayName: contract.display_name, status: contract.status,
      schemas: contract.supabase_schemas || [], buckets: contract.storage_buckets || [],
      observability: contract.observability ? { phase: contract.observability.phase, binding: contract.observability.binding_name || null, observedAt: contract.observability.observed_at || null } : null,
    })),
    recovery,
  };
}

function giteaHeaders(token = GITEA_TOKEN) {
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (token) headers.Authorization = `token ${token}`;
  return headers;
}

function giteaRepoName() {
  return `${GITEA_ORGANIZATION}/${GITEA_REPOSITORY}`;
}

function giteaEncodedPath(value) {
  const source = String(value || '').replace(/^\/+|\/+$/g, '');
  if (!source || source.split('/').some((part) => !part || part === '.' || part === '..')) throw { code: 400, msg: 'invalid Gitea repository path' };
  return source.split('/').map((part) => encodeURIComponent(part)).join('/');
}

async function giteaRequest(pathName, { method = 'GET', body = undefined, headers = undefined, authToken = GITEA_TOKEN } = {}) {
  if (!GITEA_URL) throw { code: 503, msg: 'Gitea is not configured' };
  const url = new URL(pathName, `${GITEA_URL}/`);
  if (url.origin !== new URL(GITEA_URL).origin) throw { code: 400, msg: 'invalid Gitea request path' };
  const response = await fetch(url, {
    method,
    headers: { ...giteaHeaders(authToken), ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(GITEA_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsedBody = null;
  try { parsedBody = text ? JSON.parse(text) : null; } catch { parsedBody = null; }
  if (!response.ok) throw { code: response.status, msg: `Gitea API ${pathName} failed`, detail: text.slice(0, 160) };
  return { body: parsedBody, headers: response.headers };
}

async function changeRequests() {
  const [rows, executionRows, outboxRows, approvalRows] = await Promise.all([
    restRequest('change_request', {
    query: 'select=request_id,action,target,reason,status,git_repo,git_ref,git_commit_sha,k8s_operation_id,created_at,completed_at&order=created_at.desc&limit=50',
    }),
    restRequest('change_execution', { query: 'select=request_id,branch,pull_number,pull_url,desired_revision,merge_revision,reconciler,reconciler_status,drift_status,attempt_count,last_error,updated_at' }),
    restRequest('change_outbox', { query: 'select=request_id,status,attempts,next_attempt_at,last_error,updated_at' }),
    restRequest('change_approval', { query: 'select=request_id,approver_id,status,gitea_review_id,created_at,completed_at,error_code&order=created_at.asc' }),
  ]);
  const execution = new Map((Array.isArray(executionRows) ? executionRows : []).map((row) => [row.request_id, row]));
  const outbox = new Map((Array.isArray(outboxRows) ? outboxRows : []).map((row) => [row.request_id, row]));
  const approvals = new Map();
  for (const approval of (Array.isArray(approvalRows) ? approvalRows : [])) {
    const list = approvals.get(approval.request_id) || [];
    list.push(approval); approvals.set(approval.request_id, list);
  }
  return (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, execution: execution.get(row.request_id) || null, outbox: outbox.get(row.request_id) || null, approvals: approvals.get(row.request_id) || [] }));
}

async function consumerContracts() {
  const [contracts, claims] = await Promise.all([
    restRequest('consumer_contract', { query: 'select=consumer_id,display_name,owner_kind,supabase_schemas,storage_buckets,gitea_repository,gitea_path,reconciler,observability_claim,desired_revision,applied_revision,status,last_observed_at,metadata&order=consumer_id.asc' }),
    restRequest('observability_claim', { query: 'select=consumer_id,requested_capabilities,binding_name,binding_namespace,phase,observed_at,freshness_seconds,evidence&order=consumer_id.asc' }),
  ]);
  const byConsumer = new Map((Array.isArray(claims) ? claims : []).map((claim) => [claim.consumer_id, claim]));
  return (Array.isArray(contracts) ? contracts : []).map((contract) => ({ ...contract, observability: byConsumer.get(contract.consumer_id) || null }));
}

async function recentWebhookReceipts() {
  const rows = await restRequest('gitea_webhook_receipt', {
    query: 'select=delivery_id,event_type,repository,request_id,signature_valid,disposition,error_code,received_at&order=received_at.desc&limit=50',
  });
  return Array.isArray(rows) ? rows : [];
}

function giteaRepositoryView(repository) {
  return {
    name: repository.full_name || repository.name || '',
    private: repository.private !== false,
    archived: Boolean(repository.archived),
    empty: Boolean(repository.empty),
    defaultBranch: repository.default_branch || '',
    updatedAt: repository.updated_at || repository.updated_at || null,
    sizeKiB: Number(repository.size || 0),
  };
}

async function assertVerifiedGovernedMerge(mergeRevision) {
  if (!GITEA_REQUIRE_VERIFIED_MERGE) return { verified: false, bypassed: true };
  const commit = await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/git/commits/${encodeURIComponent(mergeRevision)}`);
  const verification = commit.body?.verification || commit.body?.commit?.verification || {};
  if (verification.verified !== true) {
    throw { code: 409, msg: 'merged commit signature is not verified by the configured Gitea trust model', detail: String(verification.reason || 'unverified').slice(0, 180) };
  }
  return {
    verified: true,
    reason: String(verification.reason || 'verified').slice(0, 180),
    signer: verification.signer?.username || verification.signer?.email || null,
  };
}

async function giteaStatus() {
  const meta = {
    source: 'gitea', checkedAt: new Date().toISOString(), organization: GITEA_ORGANIZATION,
    tokenConfigured: Boolean(GITEA_TOKEN),
  };
  const [changes, contracts, receipts, recovery] = await Promise.all([
    changeRequests(),
    consumerContracts(),
    recentWebhookReceipts(),
    recoveryEvidence(),
  ]);
  const byStatus = Object.fromEntries(['intent', 'authorized', 'committed', 'applied', 'failed', 'unknown']
    .map((status) => [status, changes.filter((change) => change.status === status).length]));
  if (!GITEA_URL) {
    return {
      meta, configured: false, ready: false, version: '', repositoryCount: null,
      repositories: [], contracts, receipts, changes, byStatus, recovery, supplyChain: null, reason: 'GITEA_URL is not configured for Console Change Control',
    };
  }
  try {
    const [version, repositories, protections] = await Promise.all([
      giteaRequest('/api/v1/version'),
      GITEA_TOKEN ? giteaRequest(`/api/v1/orgs/${encodeURIComponent(GITEA_ORGANIZATION)}/repos?limit=50&page=1`) : Promise.resolve(null),
      GITEA_TOKEN ? giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/branch_protections`) : Promise.resolve(null),
    ]);
    const repositoryCount = repositories ? Number(repositories.headers.get('x-total-count') || (Array.isArray(repositories.body) ? repositories.body.length : 0)) : null;
    const mainProtection = (Array.isArray(protections?.body) ? protections.body : []).find((item) => item.branch_name === GITEA_DEFAULT_BRANCH) || null;
    return {
      meta, configured: true, ready: true, version: version.body?.version || '', repositoryCount,
      repositories: Array.isArray(repositories?.body) ? repositories.body.map(giteaRepositoryView) : [],
      contracts, receipts, changes, byStatus, recovery,
      supplyChain: {
        repository: giteaRepoName(), defaultBranch: GITEA_DEFAULT_BRANCH,
        protected: Boolean(mainProtection), requiredApprovals: Number(mainProtection?.required_approvals || 0),
        directPushEnabled: mainProtection?.enable_push === true,
        signedCommitsRequired: mainProtection?.require_signed_commits === true,
        blockRejectedReviews: mainProtection?.block_on_rejected_reviews === true,
        blockOutdatedBranch: mainProtection?.block_on_outdated_branch === true,
        blockOfficialReviewRequests: mainProtection?.block_on_official_review_requests === true,
        approvalsAllowlistEnabled: mainProtection?.enable_approvals_whitelist === true,
        mergeAllowlistEnabled: mainProtection?.enable_merge_whitelist === true,
        blockAdminMergeOverride: mainProtection?.block_admin_merge_override === true,
        verifiedMergeRequired: GITEA_REQUIRE_VERIFIED_MERGE,
      },
      managementReady: Boolean(GITEA_TOKEN && GITEA_WEBHOOK_SECRET),
      reason: GITEA_TOKEN ? (GITEA_WEBHOOK_SECRET ? '' : 'Gitea webhook secret is not configured; merge events cannot start reconciliation') : 'Gitea is reachable, but repository inventory and governed changes require a Console service token',
    };
  } catch (error) {
    return {
      meta, configured: true, ready: false, version: '', repositoryCount: null,
      repositories: [], contracts, receipts, changes, byStatus, recovery, supplyChain: null, managementReady: false, reason: error?.msg || String(error),
    };
  }
}

function uuid(value, label = 'request id') {
  const parsed = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) throw { code: 400, msg: `invalid ${label}` };
  return parsed;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateDeclaration(value, pathName = 'desiredState') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw { code: 400, msg: `${pathName} must be a JSON object` };
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw { code: 413, msg: `${pathName} exceeds 64 KiB` };
  const visit = (node, at) => {
    if (Array.isArray(node)) return node.forEach((child, index) => visit(child, `${at}[${index}]`));
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      const secretReferenceKey = /(?:secret(?:key)?ref|secretrefs|secretname|secretnames|imagepullsecrets)$/i.test(key);
      if (/(password|token|credential|private.?key|secret)/i.test(key) && !secretReferenceKey) {
        throw { code: 400, msg: `${at}.${key} may not contain secret material; use a named Secret reference` };
      }
      visit(child, `${at}.${key}`);
    }
  };
  visit(value, pathName);
  return { value, canonical: encoded, digest: toHashHex(encoded) };
}

const CEPH_PREREQUISITE_TEMPLATE = Object.freeze({
  id: 'ceph-rook-prerequisite',
  displayName: '외부 Ceph Consumer 선행요소 설치',
  consumerId: 'ceph-prerequisites',
  action: 'apply',
  target: 'rook-ceph/v1.20.2',
  reasonPlaceholder: '외부 Ceph 연결을 위한 Rook CRD·Operator·CSI 설치 사유',
  returnTo: '/p/cluster-manager/ceph/ceph',
  desiredState: Object.freeze({
    contract: 'opensphere.ceph.rook-prerequisite/v1',
    release: Object.freeze({
      name: 'rook-ceph',
      namespace: 'rook-ceph',
      chart: 'rook-ceph',
      version: 'v1.20.2',
      sha256: '6e0f10f5ca54e618fb90dd149dc9dfbc8a4932955bff2227b692fb32069daf52',
    }),
    components: Object.freeze(['crds', 'operator', 'csi', 'runtime-rbac']),
    verification: Object.freeze(['cephclusters.ceph.rook.io Established', 'deployment/rook-ceph-operator Ready']),
  }),
});

function changeTemplate(templateId) {
  if (templateId !== CEPH_PREREQUISITE_TEMPLATE.id) throw { code: 404, msg: 'change template not found' };
  return JSON.parse(JSON.stringify(CEPH_PREREQUISITE_TEMPLATE));
}

function validateChangeTemplate(body, declaration) {
  if (!body.templateId) return;
  const template = changeTemplate(String(body.templateId));
  if (String(body.consumerId) !== template.consumerId
    || String(body.action).toLowerCase() !== template.action
    || String(body.target) !== template.target
    || canonicalJson(declaration.value) !== canonicalJson(template.desiredState)) {
    throw { code: 400, msg: 'change template fields are immutable and must match the signed release contract' };
  }
}

async function governedChange(actor, body = {}) {
  requireActorPermission(actor, 'console.git.change');
  if (GITEA_CHANGE_REQUIRE_AAL2 && actor.assurance !== 'aal2') throw { code: 403, msg: 'governed Gitea change requires MFA assurance aal2' };
  if (!GITEA_TOKEN || !GITEA_WEBHOOK_SECRET) throw { code: 503, msg: 'Gitea control-plane credentials are not configured' };
  const reason = managementReason(body.reason);
  if (!reason) throw { code: 400, msg: 'management reason must be at least 8 characters' };
  const consumerId = String(body.consumerId || '').trim();
  if (!/^[a-z][a-z0-9._-]{1,127}$/.test(consumerId)) throw { code: 400, msg: 'invalid consumerId' };
  const action = String(body.action || 'apply').trim();
  if (!/^(apply|delete|rollback|configure)$/i.test(action)) throw { code: 400, msg: 'action must be apply, delete, configure, or rollback' };
  const rollbackOf = body.rollbackOf ? uuid(body.rollbackOf, 'rollbackOf request id') : null;
  if (rollbackOf && action.toLowerCase() !== 'rollback') throw { code: 400, msg: 'rollbackOf is allowed only for rollback changes' };
  const target = String(body.target || consumerId).trim();
  if (!target || target.length > 300 || /[\r\n]/.test(target)) throw { code: 400, msg: 'invalid governed change target' };
  const declaration = validateDeclaration(body.desiredState);
  validateChangeTemplate(body, declaration);
  const contractRows = await restRequest('consumer_contract', { query: `select=consumer_id,gitea_repository,gitea_path,reconciler&consumer_id=eq.${encodeURIComponent(consumerId)}` });
  const contract = Array.isArray(contractRows) ? contractRows[0] : null;
  if (!contract) throw { code: 404, msg: 'consumer contract not found' };
  if (contract.gitea_repository !== giteaRepoName()) throw { code: 409, msg: 'consumer contract is not bound to the configured Gitea repository' };
  const requestId = randomUUID();
  const suppliedKey = String(body.idempotencyKey || '').trim();
  const idempotencyKey = suppliedKey || `gitea:${actor.sub}:${toHashHex(canonicalJson({ consumerId, action, target, rollbackOf, declaration: declaration.value }))}`;
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) throw { code: 400, msg: 'idempotencyKey must be 8-200 characters' };
  const started = await restRequest('rpc/begin_change', {
    method: 'POST',
    body: {
      p_request_id: requestId,
      p_idempotency_key: idempotencyKey,
      p_actor_type: 'human',
      p_actor_id: actor.sub,
      p_action: `gitea:${action.toLowerCase()}`,
      p_target: target,
      p_reason: reason,
      p_payload_digest: `sha256:${declaration.digest}`,
    },
  });
  const change = Array.isArray(started) ? started[0] : started;
  if (!change?.request_id) throw { code: 503, msg: 'governed change intent was not persisted' };
  if (change.request_id !== requestId) return { accepted: true, duplicate: true, requestId: change.request_id, status: change.status };

  const branch = `control/${requestId}`;
  const sourcePath = String(contract.gitea_path || `${consumerId}/`).replace(/^\/+/, '').replace(/\/+$/, '');
  const filePath = `${sourcePath}/requests/${requestId}.json`;
  const manifest = {
    apiVersion: 'platform.opensphere.io/v1alpha1', kind: 'GovernedChange',
    metadata: { requestId, consumerId, submittedAt: new Date().toISOString(), payloadDigest: `sha256:${declaration.digest}`, ...(rollbackOf ? { rollbackOf } : {}) },
    spec: { action: action.toLowerCase(), target, reason, desiredState: declaration.value, ...(rollbackOf ? { rollbackOf } : {}) },
  };
  const title = `[Console] ${consumerId}: ${action.toLowerCase()} ${target}`.slice(0, 180);
  try {
    const file = await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/contents/${giteaEncodedPath(filePath)}`, {
      method: 'POST',
      body: {
        branch: GITEA_DEFAULT_BRANCH,
        new_branch: branch,
        message: `${title} (${requestId})`,
        content: Buffer.from(JSON.stringify(manifest, null, 2)).toString('base64'),
      },
    });
    const desiredRevision = String(file.body?.commit?.sha || '').toLowerCase();
    const pull = await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/pulls`, {
      method: 'POST', body: { title, head: branch, base: GITEA_DEFAULT_BRANCH, body: `Console request ${requestId}.\n\nReason: ${reason}` },
    });
    await restRequest('rpc/record_change_proposal', {
      method: 'POST', body: {
        p_request_id: requestId, p_git_repo: giteaRepoName(), p_git_ref: branch, p_branch: branch,
        p_pull_number: Number.isInteger(pull.body?.number) ? pull.body.number : null,
        p_pull_url: String(pull.body?.html_url || ''), p_desired_revision: desiredRevision,
      },
    });
    // Bind the request to the consumer contract's dedicated reconciler before
    // the merge webhook can enqueue it. The Gateway never receives this
    // service credential and cannot bypass the reviewed declaration.
    await restRequest('change_execution', {
      method: 'PATCH',
      query: `request_id=eq.${encodeURIComponent(requestId)}`,
      body: { reconciler: contract.reconciler || GITEA_RECONCILER_NAME, updated_at: new Date().toISOString() },
      prefer: 'return=minimal',
    });
    return {
      accepted: true, requestId, status: 'authorized', branch, rollbackOf,
      pullRequest: { number: pull.body?.number || null, url: pull.body?.html_url || null },
      desiredRevision: desiredRevision || null,
    };
  } catch (error) {
    await restRequest('rpc/record_change_failure', { method: 'POST', body: { p_request_id: requestId, p_result: 'gitea-proposal-failed', p_error: String(error?.msg || 'Gitea proposal failed').slice(0, 1800) } }).catch(() => undefined);
    throw error;
  }
}

async function approveGovernedChange(actor, requestIdValue, body = {}) {
  requireActorPermission(actor, 'console.git.change');
  if (GITEA_CHANGE_REQUIRE_AAL2 && actor.assurance !== 'aal2') throw { code: 403, msg: 'governed Gitea approval requires MFA assurance aal2' };
  if (!GITEA_TOKEN || !GITEA_REVIEW_TOKEN) throw { code: 503, msg: 'Gitea control and review credentials are not configured' };
  const requestId = uuid(requestIdValue);
  const reason = managementReason(body.reason);
  if (!reason) throw { code: 400, msg: 'approval reason must be at least 8 characters' };
  const [changes, executions] = await Promise.all([
    restRequest('change_request', { query: `select=request_id,actor_id,status,target,git_repo&request_id=eq.${encodeURIComponent(requestId)}` }),
    restRequest('change_execution', { query: `select=request_id,pull_number,branch&request_id=eq.${encodeURIComponent(requestId)}` }),
  ]);
  const change = Array.isArray(changes) ? changes[0] : null;
  const execution = Array.isArray(executions) ? executions[0] : null;
  if (!change || change.status !== 'authorized' || !execution?.pull_number) throw { code: 409, msg: 'change is not awaiting a Gitea pull-request approval' };
  if (change.actor_id === actor.sub) throw { code: 403, msg: 'change creator cannot approve their own request' };
  await restRequest('rpc/begin_change_approval', { method: 'POST', body: { p_request_id: requestId, p_approver_id: actor.sub, p_reason: reason } });
  try {
    const review = await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/pulls/${execution.pull_number}/reviews`, {
      method: 'POST', authToken: GITEA_REVIEW_TOKEN,
      body: { event: 'APPROVED', body: `Approved by Console operator ${actor.sub}; correlation ${requestId}. Reason: ${reason}` },
    });
    await restRequest('rpc/record_change_approval_result', { method: 'POST', body: { p_request_id: requestId, p_approver_id: actor.sub, p_succeeded: true, p_gitea_review_id: Number.isInteger(review.body?.id) ? review.body.id : null, p_error_code: null } });
    await logAudit(actor, 'gitea-change-approval', requestId, 'ok', reason, { requestId, phase: 'authorized', targetType: 'gitea-pull-request', payloadDigest: toHashHex(canonicalJson({ pull: execution.pull_number, reviewer: actor.sub })) });
  } catch (error) {
    await restRequest('rpc/record_change_approval_result', { method: 'POST', body: { p_request_id: requestId, p_approver_id: actor.sub, p_succeeded: false, p_gitea_review_id: null, p_error_code: String(error?.msg || 'gitea-review-failed').slice(0, 180) } }).catch(() => undefined);
    await logAudit(actor, 'gitea-change-approval', requestId, 'failed', reason, { requestId, phase: 'failed', targetType: 'gitea-pull-request', payloadDigest: toHashHex(canonicalJson({ requestId, error: error?.msg || 'gitea-review-failed' })) }).catch(() => undefined);
    throw error;
  }
  try {
    const merge = await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/pulls/${execution.pull_number}/merge`, {
      method: 'POST', body: { Do: 'merge', delete_branch_after_merge: false },
    });
    return { requestId, approved: true, merged: Boolean(merge.body?.merged), mergeMessage: String(merge.body?.message || '') || null, pullNumber: execution.pull_number };
  } catch (error) {
    await logAudit(actor, 'gitea-change-merge', requestId, 'failed', reason, { requestId, phase: 'approved-awaiting-merge', targetType: 'gitea-pull-request', payloadDigest: toHashHex(canonicalJson({ requestId, error: error?.msg || 'gitea-merge-failed' })) }).catch(() => undefined);
    throw { code: error?.code === 409 ? 409 : 502, msg: 'Gitea review succeeded but merge is pending or failed', detail: String(error?.msg || 'Gitea merge failed').slice(0, 180) };
  }
}

async function webhookReceipt(row) {
  try {
    const rows = await restRequest('gitea_webhook_receipt', { method: 'POST', body: [row], prefer: 'return=representation' });
    return { duplicate: false, row: Array.isArray(rows) ? rows[0] : null };
  } catch (error) {
    if (error?.code === 409) return { duplicate: true, row: null };
    throw error;
  }
}

async function patchWebhookReceipt(deliveryId, body) {
  await restRequest('gitea_webhook_receipt', { method: 'PATCH', query: `delivery_id=eq.${encodeURIComponent(deliveryId)}`, body, prefer: 'return=minimal' });
}

async function processGiteaWebhook(req) {
  const raw = await readRawBody(req, 1024 * 1024);
  const deliveryId = String(req.headers['x-gitea-delivery'] || `missing-${toHashHex(raw).slice(0, 48)}`).slice(0, 255);
  const eventType = String(req.headers['x-gitea-event'] || 'unknown').slice(0, 120);
  const digest = `sha256:${toHashHex(raw)}`;
  const supplied = String(req.headers['x-gitea-signature'] || '');
  const signatureValid = Boolean(GITEA_WEBHOOK_SECRET && supplied && safeEqual(createHmac('sha256', GITEA_WEBHOOK_SECRET).update(raw).digest('hex'), supplied));
  const receipt = await webhookReceipt({ delivery_id: deliveryId, event_type: eventType, payload_digest: digest, signature_valid: signatureValid, disposition: signatureValid ? 'accepted' : 'rejected', error_code: signatureValid ? null : 'invalid-signature' });
  if (receipt.duplicate) return { duplicate: true, accepted: false };
  if (!signatureValid) throw { code: 401, msg: 'invalid Gitea webhook signature' };
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { await patchWebhookReceipt(deliveryId, { disposition: 'rejected', error_code: 'invalid-json' }); throw { code: 400, msg: 'invalid Gitea webhook body' }; }
  const repository = String(payload?.repository?.full_name || '');
  await patchWebhookReceipt(deliveryId, { repository: repository || null });
  if (eventType !== 'pull_request' || payload?.action !== 'closed' || !payload?.pull_request?.merged || repository !== giteaRepoName()) {
    await patchWebhookReceipt(deliveryId, { disposition: 'ignored', error_code: null });
    return { duplicate: false, accepted: false, ignored: true };
  }
  const branch = String(payload.pull_request?.head?.ref || '');
  const mergeRevision = String(payload.pull_request?.merge_commit_sha || '').toLowerCase();
  if (!/^control\/[0-9a-f-]{36}$/i.test(branch) || !/^[0-9a-f]{40,64}$/.test(mergeRevision)) {
    await patchWebhookReceipt(deliveryId, { disposition: 'rejected', error_code: 'invalid-merge-reference' });
    return { duplicate: false, accepted: false, ignored: true };
  }
  const executions = await restRequest('change_execution', { query: `select=request_id,reconciler&branch=eq.${encodeURIComponent(branch)}` });
  const execution = Array.isArray(executions) ? executions[0] : null;
  if (!execution?.request_id) {
    await patchWebhookReceipt(deliveryId, { disposition: 'ignored', error_code: 'unknown-branch' });
    return { duplicate: false, accepted: false, ignored: true };
  }
  try {
    await assertVerifiedGovernedMerge(mergeRevision);
  } catch (error) {
    await patchWebhookReceipt(deliveryId, { disposition: 'rejected', error_code: 'merge-signature-unverified' });
    return { duplicate: false, accepted: false, ignored: true, reason: error?.msg || 'merge-signature-unverified' };
  }
  await restRequest('rpc/record_change_commit', { method: 'POST', body: { p_request_id: execution.request_id, p_git_repo: repository, p_git_ref: GITEA_DEFAULT_BRANCH, p_git_commit_sha: mergeRevision } });
  await restRequest('change_execution', { method: 'PATCH', query: `request_id=eq.${encodeURIComponent(execution.request_id)}`, body: { merge_revision: mergeRevision, updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
  await restRequest('rpc/queue_change_reconcile', { method: 'POST', body: { p_request_id: execution.request_id, p_reconciler: execution.reconciler || GITEA_RECONCILER_NAME } });
  await patchWebhookReceipt(deliveryId, { request_id: execution.request_id, disposition: 'accepted', error_code: null });
  return { duplicate: false, accepted: true, requestId: execution.request_id, status: 'committed' };
}

function verifyReconcilerCredential(req) {
  if (!RECONCILER_RECEIPT_TOKEN || !safeEqual(req.headers['x-opensphere-reconciler-token'], RECONCILER_RECEIPT_TOKEN)) throw { code: 401, msg: 'invalid reconciler credential' };
}

async function claimReconcileWork(req, body = {}) {
  verifyReconcilerCredential(req);
  const limit = Math.max(1, Math.min(10, Number(body.limit || 1) || 1));
  const reconciler = String(body.reconciler || GITEA_RECONCILER_NAME).trim();
  if (!GITEA_RECONCILER_NAMES.has(reconciler)) throw { code: 403, msg: 'reconciler is outside the configured allowlist' };
  const rows = await restRequest('rpc/claim_change_reconcile', {
    method: 'POST',
    body: { p_reconciler: reconciler, p_limit: limit },
  });
  return {
    reconciler,
    leaseSeconds: 300,
    items: Array.isArray(rows) ? rows : (rows ? [rows] : []),
  };
}

async function recordReconcileReceipt(req, body) {
  verifyReconcilerCredential(req);
  const requestId = uuid(body.requestId);
  const operationId = String(body.operationId || '').trim();
  const reconciler = String(body.reconciler || GITEA_RECONCILER_NAME).trim();
  const result = String(body.result || '').trim();
  if (!operationId || operationId.length > 255 || !reconciler || reconciler.length > 255 || !result || result.length > 2000 || typeof body.succeeded !== 'boolean') throw { code: 400, msg: 'invalid reconcile receipt' };
  const evidence = body.evidence && typeof body.evidence === 'object' && !Array.isArray(body.evidence) ? validateDeclaration(body.evidence, 'evidence').value : {};
  const executionRows = await restRequest('change_execution', { query: `select=request_id,reconciler&request_id=eq.${encodeURIComponent(requestId)}` });
  const execution = Array.isArray(executionRows) ? executionRows[0] : null;
  if (!execution || execution.reconciler !== reconciler || !GITEA_RECONCILER_NAMES.has(reconciler)) {
    throw { code: 403, msg: 'reconcile receipt identity does not match the assigned consumer reconciler' };
  }
  try {
    await restRequest('reconcile_receipt', { method: 'POST', body: [{ operation_id: operationId, request_id: requestId, reconciler, desired_revision: body.desiredRevision || null, applied_revision: body.appliedRevision || null, observed_generation: Number.isSafeInteger(body.observedGeneration) ? body.observedGeneration : null, succeeded: body.succeeded, result, evidence }], prefer: 'return=minimal' });
  } catch (error) {
    if (error?.code === 409) return { duplicate: true, requestId };
    throw error;
  }
  await restRequest('rpc/record_reconcile_result', { method: 'POST', body: { p_request_id: requestId, p_operation_id: operationId, p_succeeded: body.succeeded, p_result: result } });
  return { duplicate: false, requestId, status: body.succeeded ? 'applied' : 'failed' };
}

async function listRoles() {
  const rows = await restRequest('role', {
    query: 'select=id,code,description,system_managed&order=code.asc',
  });
  return Array.isArray(rows) ? rows : [];
}

async function listOperators() {
  const rows = await restRequest('operator', {
    query: 'select=user_id,display_name,status,created_at,disabled_at&order=display_name.asc',
  });
  return Array.isArray(rows) ? rows : [];
}

async function listOperatorRoles() {
  const rows = await restRequest('operator_role', {
    query: 'select=user_id,role_id,expires_at',
  });
  return Array.isArray(rows) ? rows : [];
}

async function listAuthUsersByIds(userIds) {
  const ids = [...new Set((userIds || []).map((s) => String(s).trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const users = await Promise.all(ids.map((userId) => getAuthUser(userId).catch(() => null)));
  const list = users.filter(Boolean);
  const index = new Map();
  for (const row of list) index.set(row.id, row);
  return index;
}

async function listAuditEvents() {
  const rows = await restRequest('event', {
    profile: 'audit',
    query: `select=occurred_at,actor_id,action,target_type,target_id,result,reason,request_id,correlation_id&order=occurred_at.desc&limit=${AUDIT_READ_LIMIT}`,
  });
  return Array.isArray(rows) ? rows : [];
}

async function readRawBody(req, limit = MAX_BODY) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw { code: 413, msg: 'payload too large' };
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const s = (await readRawBody(req)).toString('utf8');
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw { code: 400, msg: 'invalid json body' }; }
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function safeEnabledValue(v) {
  if (typeof v !== 'boolean') return null;
  return v;
}

function isRoleAllowed(code) {
  return CONSOLE_ROLE_GROUPS.has(code);
}

async function getOperatorById(userId) {
  const rows = await restRequest('operator', { query: `select=user_id,display_name,status,disabled_at,credential_revision&user_id=eq.${userId}` });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function getOperatorRolesByUser(userId) {
  const rows = await restRequest('operator_role', {
    query: `select=role_id,expires_at&user_id=eq.${userId}`,
  });
  const now = Date.now();
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => !row.expires_at || Date.parse(row.expires_at) > now);
}

async function getAuthUser(userId) {
  try {
    const user = await authAdminRequest(`/admin/users/${userId}`, { method: 'GET' });
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

async function createAuthUser(email, displayName, options = {}) {
  const emailOnly = String(email || '').trim().toLowerCase();
  if (!emailOnly || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailOnly)) {
    throw { code: 400, msg: 'invalid email' };
  }
  const password = options.password || `T${randomBytes(24).toString('base64url')}`;
  const created = await authAdminRequest('/admin/users', {
    method: 'POST',
    body: {
      email: emailOnly,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: displayName || emailOnly.split('@')[0],
        ...(options.username ? { preferred_username: options.username } : {}),
      },
    },
  });
  if (!created?.id) throw { code: 503, msg: 'auth user creation response missing id' };
  return created;
}

async function upsertOperator(userId, displayName, active = true) {
  const now = new Date().toISOString();
  await restRequest('operator', {
    method: 'POST',
    query: 'on_conflict=user_id',
    body: [{
      user_id: userId,
      display_name: displayName || '',
      status: active ? 'active' : 'suspended',
      disabled_at: active ? null : now,
    }],
    prefer: 'resolution=merge-duplicates',
  });
}

function bootstrapInput(body) {
  const username = String(body?.username || '').trim().toLowerCase();
  const displayName = String(body?.displayName || '').trim();
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const passwordConfirm = String(body?.passwordConfirm || '');
  if (!/^[a-z][a-z0-9._-]{1,31}$/.test(username)) throw { code: 400, msg: 'invalid username' };
  if (!displayName || displayName.length > 128) throw { code: 400, msg: 'invalid display name' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw { code: 400, msg: 'invalid email' };
  if (password.length < 12) throw { code: 400, msg: 'password policy requires 12 characters' };
  if (password !== passwordConfirm) throw { code: 400, msg: 'password mismatch' };
  return { username, displayName, email, password };
}

async function bootstrapStatus() {
  const operators = await listOperators();
  return { state: operators.length ? 'complete' : 'required' };
}

async function bootstrapInitialOperator(body) {
  if ((await listOperators()).length) throw { code: 409, msg: 'setup complete' };
  const input = bootstrapInput(body);
  const created = await createAuthUser(input.email, input.displayName, input);
  try {
    // Recheck after the auth write: a second bootstrapper must never gain a role.
    if ((await listOperators()).length) throw { code: 409, msg: 'setup complete' };
    await upsertOperator(created.id, input.displayName, true);
    const adminRole = (await listRoles()).find((role) => role.code === SUPABASE_BACKEND_ROLE);
    if (!adminRole?.id) throw { code: 503, msg: `canonical role missing: ${SUPABASE_BACKEND_ROLE}` };
    await restRequest('operator_role', {
      method: 'POST',
      query: 'on_conflict=user_id,role_id',
      body: [{ user_id: created.id, role_id: adminRole.id, granted_by: null, reason: 'initial Supabase Console bootstrap' }],
      prefer: 'return=minimal,resolution=merge-duplicates',
    });
    return { state: 'complete', userId: created.id };
  } catch (error) {
    await authAdminRequest(`/admin/users/${created.id}`, { method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
}

async function createRecoveryLink(email) {
  if (!email) throw { code: 400, msg: 'email missing' };
  const result = await authAdminRequest('/admin/generate_link', {
    method: 'POST',
    body: { type: 'recovery', email },
  });
  return result?.action_link || result?.properties?.action_link || null;
}

function roleByIdMap(roles) {
  const map = new Map();
  for (const r of roles) map.set(r.id, r.code);
  return map;
}

async function roleByCodeToId(roles) {
  const map = new Map();
  for (const r of roles) map.set(r.code, r.id);
  return map;
}

async function identityPayload() {
  const [operators, roles, assignments] = await Promise.all([
    listOperators(),
    listRoles(),
    listOperatorRoles(),
  ]);
  const activeRoles = roles.filter((r) => !isRoleAllowed(r.code) || r.system_managed === false ? true : true); // keep canonical role set
  const roleIdToCode = roleByIdMap(activeRoles);
  const authUsers = await listAuthUsersByIds(operators.map((r) => r.user_id));

  const userGroups = new Map();
  const now = Date.now();
  for (const row of assignments) {
    if (!row?.user_id || !row.role_id) continue;
    if (row.expires_at && Date.parse(row.expires_at) <= now) continue;
    if (!userGroups.has(row.user_id)) userGroups.set(row.user_id, []);
    userGroups.get(row.user_id).push({ id: row.role_id, name: roleIdToCode.get(row.role_id) || row.role_id });
  }

  const users = operators.map((o) => {
    const authUser = authUsers.get(o.user_id) || {};
    const base = userFromAuthRow(authUser, o.display_name || o.user_id);
    const groups = userGroups.get(o.user_id) || [];
    const displayName = o.display_name || base.displayName || base.username;
    const first = String(displayName || '').split(' ')[0] || '';
    const last = String(displayName || '').split(' ').slice(1).join(' ');
    return {
      id: o.user_id,
      username: base.username,
      email: base.email || '',
      displayName: displayName || '',
      firstName: first,
      lastName: last,
      enabled: String(o.status || 'active') === 'active',
      groups: groups.map((g) => ({ id: g.id, name: g.name, path: `/${g.name}` })),
    };
  });

  const groupRows = activeRoles
    .filter((r) => isRoleAllowed(r.code))
    .map((r) => ({ id: r.id, name: r.code, description: r.description || '', path: `/${r.code}` }));

  return {
    meta: {
      service: 'opensphere-identity',
      version: VERSION,
      servedBy: process.env.HOSTNAME || 'unknown',
      time: new Date().toISOString(),
      idp: 'supabase',
      writeEnabled: true,
    },
    users,
    groups: groupRows,
  };
}

// ── catalog route helpers (unchanged behavior) ──
const COMP_NS = (process.env.COMPONENT_NAMESPACES || 'opensphere-console,opensphere-console-data,opensphere-console-change').split(',');
function k8sAuth() {
  return { method: 'GET', headers: { Authorization: `Bearer ${fs.readFileSync(`${SA}/token`, 'utf8').trim()}` } };
}
function k8sGet(p2) {
  return fetch(`${'https://kubernetes.default.svc'}${p2}`, {
    ...k8sAuth(),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`${p2} HTTP ${r.status}`);
    return r.json();
  });
}

async function k8sRequest(method, apiPath, body = undefined, contentType = 'application/json') {
  const response = await fetch(`${K8S_API}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${fs.readFileSync(`${SA}/token`, 'utf8').trim()}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': contentType }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { message: text }; }
  return { ok: response.ok, status: response.status, body: parsed };
}

function oaaKeySecretName(id) {
  return `oaa-llm-${id}`;
}

function oaaKeyMeta(secret) {
  const annotations = secret?.metadata?.annotations || {};
  return {
    id: annotations['opensphere.io/oaa-key-id'] || String(secret?.metadata?.name || '').replace(/^oaa-llm-/, ''),
    provider: annotations['opensphere.io/oaa-provider'] || '',
    displayName: annotations['opensphere.io/oaa-display-name'] || '',
    baseUrl: annotations['opensphere.io/oaa-base-url'] || '',
    defaultModel: annotations['opensphere.io/oaa-default-model'] || '',
    embeddingModel: annotations['opensphere.io/oaa-embedding-model'] || '',
    enabled: annotations['opensphere.io/oaa-enabled'] !== 'false',
    keyFingerprint: annotations['opensphere.io/oaa-key-fingerprint'] || '',
    secretRef: secret?.metadata?.name || '',
    updatedAt: annotations['opensphere.io/oaa-updated-at'] || secret?.metadata?.creationTimestamp || '',
    updatedBy: annotations['opensphere.io/oaa-updated-by'] || '',
    validationStatus: annotations['opensphere.io/oaa-validation-status'] || 'untested',
    validationMessage: annotations['opensphere.io/oaa-validation-message'] || 'Provider connection has not been tested.',
    validatedAt: annotations['opensphere.io/oaa-validated-at'] || '',
    validationLatencyMs: Number(annotations['opensphere.io/oaa-validation-latency-ms'] || 0) || 0,
  };
}

function safeOaaValidationMessage(value) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 240);
}

async function probeOaaProviderCredential(meta, apiKey) {
  const validatedAt = new Date().toISOString();
  if (!meta.enabled) return { status: 'disabled', message: 'Key is disabled.', validatedAt, latencyMs: 0 };
  if (!apiKey) return { status: 'invalid', message: 'Secret has no API key material.', validatedAt, latencyMs: 0 };
  if (!['openai', 'deepseek', 'custom'].includes(meta.provider)) {
    return {
      status: 'unsupported',
      message: `Gateway connector validation is not implemented for ${meta.provider}.`,
      validatedAt,
      latencyMs: 0,
    };
  }
  const defaultBaseUrl = meta.provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.deepseek.com';
  let modelsUrl;
  let embeddingsUrl;
  try {
    const providerBaseUrl = String(meta.baseUrl || defaultBaseUrl).replace(/\/+$/, '');
    const parsed = new URL(`${providerBaseUrl}/models`);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported URL scheme');
    modelsUrl = parsed.toString();
    embeddingsUrl = new URL(`${providerBaseUrl}/embeddings`).toString();
  } catch {
    return { status: 'invalid-config', message: 'Base URL is invalid.', validatedAt, latencyMs: 0 };
  }
  const started = Date.now();
  try {
    const response = await fetch(modelsUrl, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const latencyMs = Date.now() - started;
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      return { status: 'invalid', message: 'Provider rejected the credential.', validatedAt, latencyMs };
    }
    if (!response.ok) {
      const detail = safeOaaValidationMessage(body?.error?.message || body?.message || `Provider HTTP ${response.status}`);
      return { status: response.status === 429 ? 'degraded' : 'provider-error', message: detail, validatedAt, latencyMs };
    }
    const modelIds = Array.isArray(body?.data) ? body.data.map((item) => String(item?.id || '')).filter(Boolean) : [];
    if (meta.defaultModel && modelIds.length && !modelIds.includes(meta.defaultModel)) {
      return {
        status: 'model-missing',
        message: `Credential is valid, but model ${meta.defaultModel} was not advertised by the provider.`,
        validatedAt,
        latencyMs,
      };
    }
    if (meta.embeddingModel) {
      const embeddingRequest = { model: meta.embeddingModel, input: 'OpenSphere embedding readiness probe' };
      if (meta.provider === 'openai' || /text-embedding-3/i.test(meta.embeddingModel)) embeddingRequest.dimensions = OAA_EMBED_DIM;
      const embeddingResponse = await fetch(embeddingsUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(embeddingRequest),
        signal: AbortSignal.timeout(15000),
      });
      const embeddingBody = await embeddingResponse.json().catch(() => ({}));
      const embeddingLatencyMs = Date.now() - started;
      if (!embeddingResponse.ok) {
        const detail = safeOaaValidationMessage(embeddingBody?.error?.message || embeddingBody?.message || `HTTP ${embeddingResponse.status}`);
        return {
          status: 'embedding-unavailable',
          message: `Chat credential is valid, but embedding model ${meta.embeddingModel} is unavailable (${detail}).`,
          validatedAt,
          latencyMs: embeddingLatencyMs,
        };
      }
      const vector = embeddingBody?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== OAA_EMBED_DIM || vector.some((value) => !Number.isFinite(Number(value)))) {
        return {
          status: 'embedding-invalid',
          message: `Embedding model ${meta.embeddingModel} returned an invalid vector dimension; expected ${OAA_EMBED_DIM}.`,
          validatedAt,
          latencyMs: embeddingLatencyMs,
        };
      }
      return {
        status: 'ready',
        message: `Chat and embedding access verified (${vector.length} dimensions).`,
        validatedAt,
        latencyMs: embeddingLatencyMs,
      };
    }
    return { status: 'ready', message: 'Provider credential and chat model access verified; no embedding model is configured.', validatedAt, latencyMs };
  } catch (error) {
    return {
      status: 'unreachable',
      message: safeOaaValidationMessage(error?.name === 'TimeoutError' ? 'Provider validation timed out.' : 'Provider could not be reached.'),
      validatedAt,
      latencyMs: Date.now() - started,
    };
  }
}

function oaaValidationAnnotations(validation) {
  return {
    'opensphere.io/oaa-validation-status': validation.status,
    'opensphere.io/oaa-validation-message': safeOaaValidationMessage(validation.message),
    'opensphere.io/oaa-validated-at': validation.validatedAt,
    'opensphere.io/oaa-validation-latency-ms': String(validation.latencyMs || 0),
  };
}

async function validateOaaKeySecret(actor, secret, reason = 'Operator requested provider credential validation') {
  const meta = oaaKeyMeta(secret);
  if (!OAA_KEY_ID_RE.test(meta.id)) throw { code: 400, msg: 'invalid LLM key id' };
  const apiKey = Buffer.from(String(secret?.data?.api_key || ''), 'base64').toString('utf8');
  const validation = await probeOaaProviderCredential(meta, apiKey);
  const itemPath = `/api/v1/namespaces/${encodeURIComponent(OAA_KEY_NAMESPACE)}/secrets/${encodeURIComponent(oaaKeySecretName(meta.id))}`;
  const annotations = { ...(secret?.metadata?.annotations || {}), ...oaaValidationAnnotations(validation) };
  const patched = await k8sRequest('PATCH', itemPath, { metadata: { annotations } }, 'application/merge-patch+json');
  if (!patched.ok) throw { code: 502, msg: `OAA credential validation state write failed (Kubernetes HTTP ${patched.status})` };
  let auditRecorded = true;
  try {
    await logAudit(actor, 'oaa-llm-key-validate', meta.id, validation.status, reason, {
      requestId: newOpId(),
      phase: 'observed',
      targetType: 'oaa-llm-credential',
      payloadDigest: toHashHex(canonicalJson({ id: meta.id, status: validation.status, validatedAt: validation.validatedAt })),
    });
  } catch (error) {
    auditRecorded = false;
    console.error('[oaa-validation-audit] validation state persisted but audit write failed:', error?.message || error);
  }
  return { validation, item: oaaKeyMeta({ ...secret, metadata: { ...secret.metadata, annotations } }), auditRecorded };
}

async function validateStoredOaaKey(actor, id) {
  const keyId = String(id || '').trim();
  if (!OAA_KEY_ID_RE.test(keyId)) throw { code: 400, msg: 'invalid LLM key id' };
  const itemPath = `/api/v1/namespaces/${encodeURIComponent(OAA_KEY_NAMESPACE)}/secrets/${encodeURIComponent(oaaKeySecretName(keyId))}`;
  const response = await k8sRequest('GET', itemPath);
  if (response.status === 404) throw { code: 404, msg: 'LLM key not found' };
  if (!response.ok) throw { code: 502, msg: `OAA credential lookup failed (Kubernetes HTTP ${response.status})` };
  return validateOaaKeySecret(actor, response.body);
}

function oaaKeyInput(body, existing = null) {
  const id = String(body?.id || '').trim();
  const provider = String(body?.provider || '').trim().toLowerCase();
  const displayName = String(body?.displayName || id || provider).trim();
  const apiKey = String(body?.apiKey || '');
  const baseUrl = String(body?.baseUrl || '').trim();
  const defaultModel = String(body?.defaultModel || '').trim();
  const embeddingModel = String(body?.embeddingModel || '').trim();
  const reason = managementReason(body?.reason);
  if (!OAA_KEY_ID_RE.test(id)) throw { code: 400, msg: 'invalid LLM key id' };
  if (!OAA_PROVIDER_RE.test(provider)) throw { code: 400, msg: 'invalid LLM provider' };
  if ((!existing || apiKey) && apiKey.length < 8) throw { code: 400, msg: 'API key must be at least 8 characters' };
  if (displayName.length > 120) throw { code: 400, msg: 'displayName exceeds 120 characters' };
  if (baseUrl.length > 400) throw { code: 400, msg: 'baseUrl exceeds 400 characters' };
  if (defaultModel && !OAA_MODEL_RE.test(defaultModel)) throw { code: 400, msg: 'invalid defaultModel' };
  if (embeddingModel && !OAA_MODEL_RE.test(embeddingModel)) throw { code: 400, msg: 'invalid embeddingModel' };
  if (!reason) throw { code: 400, msg: 'management reason must be at least 8 characters' };
  return { id, provider, displayName, apiKey, baseUrl, defaultModel, embeddingModel, enabled: body?.enabled !== false, reason };
}

async function listOaaKeys(actor) {
  const path = `/api/v1/namespaces/${encodeURIComponent(OAA_KEY_NAMESPACE)}/secrets?labelSelector=${encodeURIComponent(`${OAA_KEY_LABEL}=true`)}`;
  const response = await k8sRequest('GET', path);
  if (!response.ok) throw { code: 502, msg: `OAA credential inventory unavailable (Kubernetes HTTP ${response.status})` };
  return { items: (response.body?.items || []).map(oaaKeyMeta).sort((left, right) => left.id.localeCompare(right.id)) };
}

async function upsertOaaKey(actor, body) {
  const requestedId = String(body?.id || '').trim();
  if (!OAA_KEY_ID_RE.test(requestedId)) throw { code: 400, msg: 'invalid LLM key id' };
  const name = oaaKeySecretName(requestedId);
  const itemPath = `/api/v1/namespaces/${encodeURIComponent(OAA_KEY_NAMESPACE)}/secrets/${encodeURIComponent(name)}`;
  const current = await k8sRequest('GET', itemPath);
  if (!current.ok && current.status !== 404) throw { code: 502, msg: `OAA credential lookup failed (Kubernetes HTTP ${current.status})` };
  const existing = current.ok ? current.body : null;
  const input = oaaKeyInput(body, existing);
  const requestId = newOpId();
  const fingerprint = input.apiKey
    ? toHashHex(input.apiKey).slice(0, 16)
    : String(existing?.metadata?.annotations?.['opensphere.io/oaa-key-fingerprint'] || '');
  const payloadDigest = toHashHex(canonicalJson({
    id: input.id,
    provider: input.provider,
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    defaultModel: input.defaultModel,
    embeddingModel: input.embeddingModel,
    enabled: input.enabled,
    credentialChanged: Boolean(input.apiKey),
  }));
  const action = existing ? 'oaa-llm-key-rotate' : 'oaa-llm-key-create';
  await logAudit(actor, action, input.id, 'attempt', input.reason, { requestId, phase: 'intent', targetType: 'oaa-llm-credential', payloadDigest });
  const now = new Date().toISOString();
  const annotations = {
    'opensphere.io/oaa-key-id': input.id,
    'opensphere.io/oaa-provider': input.provider,
    'opensphere.io/oaa-display-name': input.displayName,
    'opensphere.io/oaa-base-url': input.baseUrl,
    'opensphere.io/oaa-default-model': input.defaultModel,
    'opensphere.io/oaa-embedding-model': input.embeddingModel,
    'opensphere.io/oaa-enabled': String(input.enabled),
    'opensphere.io/oaa-key-fingerprint': fingerprint,
    'opensphere.io/oaa-updated-at': now,
    'opensphere.io/oaa-updated-by': String(actor.username || actor.sub).slice(0, 200),
    'opensphere.io/oaa-change-reason': input.reason.slice(0, 500),
    'opensphere.io/oaa-request-id': requestId,
  };
  const metadata = {
    name,
    namespace: OAA_KEY_NAMESPACE,
    labels: { [OAA_PART_LABEL]: 'opensphere-oaa', [OAA_KEY_LABEL]: 'true' },
    annotations,
  };
  let applied;
  try {
    if (!existing) {
      applied = await k8sRequest('POST', `/api/v1/namespaces/${encodeURIComponent(OAA_KEY_NAMESPACE)}/secrets`, {
        apiVersion: 'v1', kind: 'Secret', metadata, type: 'Opaque', stringData: { api_key: input.apiKey },
      });
      if (applied.status === 409) {
        applied = await k8sRequest('PATCH', itemPath, { metadata, ...(input.apiKey ? { stringData: { api_key: input.apiKey } } : {}) }, 'application/merge-patch+json');
      }
    } else {
      applied = await k8sRequest('PATCH', itemPath, { metadata, ...(input.apiKey ? { stringData: { api_key: input.apiKey } } : {}) }, 'application/merge-patch+json');
    }
    if (!applied.ok) throw { code: 502, msg: `OAA credential apply failed (Kubernetes HTTP ${applied.status})` };
    await logAudit(actor, action, input.id, 'ok', input.reason, { requestId, phase: 'applied', targetType: 'oaa-llm-credential', payloadDigest });
    const secretForValidation = {
      metadata: { ...metadata, creationTimestamp: existing?.metadata?.creationTimestamp || now },
      data: { api_key: input.apiKey ? Buffer.from(input.apiKey, 'utf8').toString('base64') : existing?.data?.api_key || '' },
    };
    const validationResult = await validateOaaKeySecret(actor, secretForValidation, 'Automatic validation after credential save');
    return { created: !existing, item: validationResult.item, validation: validationResult.validation, auditRecorded: validationResult.auditRecorded, requestId };
  } catch (error) {
    await logAudit(actor, action, input.id, 'failed', input.reason, { requestId, phase: 'failed', targetType: 'oaa-llm-credential', payloadDigest }).catch(() => undefined);
    throw error;
  }
}

async function deleteOaaKey(actor, id, reasonValue) {
  const keyId = String(id || '').trim();
  const reason = managementReason(reasonValue);
  if (!OAA_KEY_ID_RE.test(keyId)) throw { code: 400, msg: 'invalid LLM key id' };
  if (!reason) throw { code: 400, msg: 'management reason must be at least 8 characters' };
  const requestId = newOpId();
  const payloadDigest = toHashHex(canonicalJson({ id: keyId, action: 'delete' }));
  await logAudit(actor, 'oaa-llm-key-delete', keyId, 'attempt', reason, { requestId, phase: 'intent', targetType: 'oaa-llm-credential', payloadDigest });
  const response = await k8sRequest('DELETE', `/api/v1/namespaces/${encodeURIComponent(OAA_KEY_NAMESPACE)}/secrets/${encodeURIComponent(oaaKeySecretName(keyId))}`);
  if (!response.ok && response.status !== 404) {
    await logAudit(actor, 'oaa-llm-key-delete', keyId, 'failed', reason, { requestId, phase: 'failed', targetType: 'oaa-llm-credential', payloadDigest }).catch(() => undefined);
    throw { code: 502, msg: `OAA credential delete failed (Kubernetes HTTP ${response.status})` };
  }
  await logAudit(actor, 'oaa-llm-key-delete', keyId, response.status === 404 ? 'ok-noop' : 'ok', reason, { requestId, phase: 'applied', targetType: 'oaa-llm-credential', payloadDigest });
  return { deleted: response.status !== 404, requestId };
}
async function apiEntities() {
  const out = [];
  const crds = await k8sGet('/apis/apiextensions.k8s.io/v1/customresourcedefinitions');
  for (const crd of crds.items || []) {
    const g = crd.spec.group || '';
    if (!/(^|\\.)opensphere\\.io$/.test(g)) continue;
    const v = (crd.spec.versions || []).find((x) => x.served) || crd.spec.versions?.[0] || {};
    const kind = crd.spec.names.kind;
    out.push({
      kind: 'API',
      metadata: { name: kind, namespace: 'default', uid: crd.metadata.uid, description: `${kind} — ${g}/${v.name} (OpenSphere CRD, scope=${crd.spec.scope})` },
      spec: { type: 'kubernetes-crd', owner: g.split('.')[0], lifecycle: 'production', system: g, definition: v.schema?.openAPIV3Schema ? JSON.stringify(v.schema.openAPIV3Schema, null, 2) : '' },
    });
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}
async function componentEntities() {
  const out = [];
  for (const ns of COMP_NS) {
    let deps;
    try {
      deps = await k8sGet(`/apis/apps/v1/namespaces/${ns}/deployments`);
    } catch {
      continue;
    }
    for (const d of deps.items || []) {
      out.push({
        kind: 'Component',
        metadata: { name: d.metadata.name, namespace: ns, uid: d.metadata.uid, description: `Deployment · ${ns} (replicas ${d.status?.availableReplicas ?? 0}/${d.spec?.replicas ?? 0})` },
        spec: { type: 'service', owner: 'platform', lifecycle: 'production', system: ns },
      });
    }
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}
async function catalogEntities(filter) {
  if (/kind=api/i.test(filter || '')) return apiEntities();
  const [a, c] = await Promise.all([apiEntities(), componentEntities()]);
  return [...a, ...c];
}

let _httpReqs = 0;
function metricsText() {
  return [
    '# HELP os_build_info Build info (constant 1).',
    '# TYPE os_build_info gauge',
    `os_build_info{service="opensphere-console-backend",version="${VERSION}"} 1`,
    '# HELP os_http_requests_total HTTP requests handled.',
    '# TYPE os_http_requests_total counter',
    `os_http_requests_total ${_httpReqs}`,
    '# HELP os_audit_events Current in-memory audit ring size.',
    '# TYPE os_audit_events gauge',
    `os_audit_events ${audit.length}`,
    '# HELP process_uptime_seconds Process uptime in seconds.',
    '# TYPE process_uptime_seconds gauge',
    `process_uptime_seconds ${Math.round(process.uptime())}`,
  ].join('\n') + '\n';
}

async function mutateEnabled({ actor, userId, enabled, reason }) {
  const opId = newOpId();
  await logAudit(actor, 'iga-users-enabled-mutation', userId, 'attempt', reason, { requestId: opId, phase: 'intent' });
  const operator = await getOperatorById(userId);
  if (!operator) throw { code: 404, msg: 'operator not found' };
  if (!enabled && actor.sub === userId) throw { code: 403, msg: 'administrator self-disable is blocked' };
  if (!enabled) await requireAdminContinuity(userId);
  const status = enabled ? 'active' : 'suspended';
  await restRequest('operator', {
    method: 'PATCH',
    query: `user_id=eq.${userId}`,
    body: {
      status,
      disabled_at: enabled ? null : new Date().toISOString(),
    },
    prefer: 'return=minimal',
  });
  return logAudit(actor, enabled ? 'enable-user' : 'disable-user', userId, 'ok', reason, { requestId: opId, phase: 'applied' });
}

async function mutateGroup({ actor, userId, op, roleId, roleName, reason }) {
  const opId = newOpId();
  await logAudit(actor, `group-${op}`, `${userId}:${roleId || roleName}`, 'attempt', reason, { requestId: opId, phase: 'intent' });
  const operator = await getOperatorById(userId);
  if (!operator) throw { code: 404, msg: 'operator not found' };

  if (!roleId && !roleName) throw { code: 400, msg: 'group or groupId required' };
  const roles = await listRoles();
  const roleMap = await roleByCodeToId(roles);
  const finalRoleId = roleId || roleMap.get(roleName);
  if (!finalRoleId) throw { code: 400, msg: 'role not found' };
  const roleRow = roles.find((r) => r.id === finalRoleId) || {};
  const roleCode = roleRow.code || '';
  if (!isRoleAllowed(roleCode)) {
    throw { code: 403, msg: 'role assignment is restricted to console roles' };
  }

  const targetRoles = new Set((await getOperatorRolesByUser(operator.user_id).then((rows) => rows.map((r) => r.role_id))));
  if (op === 'add') {
    if (targetRoles.has(finalRoleId)) {
      return logAudit(actor, `group-${op}`, `${userId}:${finalRoleId}`, 'ok-noop', reason, { requestId: opId, phase: 'applied' });
    }
    await restRequest('operator_role', {
      method: 'POST',
      query: 'select=user_id,role_id',
      body: [{
        user_id: operator.user_id,
        role_id: finalRoleId,
        granted_by: actor.sub,
        reason,
      }],
      prefer: 'return=minimal,resolution=ignore-duplicates',
    });
    return logAudit(actor, `group-${op}`, `${userId}:${finalRoleId}`, 'ok', reason, { requestId: opId, phase: 'applied', targetType: 'console-identity-role' });
  }
  if (op === 'remove') {
    if (actor.sub === operator.user_id && roleCode === SUPABASE_BACKEND_ROLE) {
      throw { code: 403, msg: 'admin self-removal is blocked' };
    }
    if (roleCode === SUPABASE_BACKEND_ROLE) await requireAdminContinuity(userId);
    await restRequest('operator_role', {
      method: 'DELETE',
      query: `user_id=eq.${userId}&role_id=eq.${finalRoleId}`,
      prefer: 'return=minimal',
    });
    return logAudit(actor, `group-${op}`, `${userId}:${finalRoleId}`, 'ok', reason, { requestId: opId, phase: 'applied', targetType: 'console-identity-role' });
  }
  throw { code: 400, msg: 'unsupported operation (add|remove)' };
}

async function requireAdminContinuity(targetUserId) {
  const [operators, roles, assignments] = await Promise.all([listOperators(), listRoles(), listOperatorRoles()]);
  const adminRole = roles.find((role) => role.code === SUPABASE_BACKEND_ROLE);
  if (!adminRole?.id) throw { code: 503, msg: 'canonical Console administrator role is unavailable' };
  const activeUsers = new Set(operators.filter((operator) => operator.status === 'active').map((operator) => operator.user_id));
  const adminUsers = new Set(assignments
    .filter((row) => row.role_id === adminRole.id && (!row.expires_at || Date.parse(row.expires_at) > Date.now()))
    .map((row) => row.user_id)
    .filter((userId) => activeUsers.has(userId)));
  if (adminUsers.has(targetUserId) && adminUsers.size <= 1) {
    throw { code: 409, msg: 'last active Console administrator cannot be disabled or demoted' };
  }
}

function requireClosedOaaIdentityBody(body, allowed) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw { code: 400, msg: 'OAA identity owner body must be an object' };
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length) throw { code: 400, msg: `OAA identity owner action contains unsupported inputs: ${extra.join(', ')}` };
}

async function oaaIdentityStatus() {
  const value = await identityPayload();
  return {
    schema: 'oaa-identity-owner-status.opensphere.io/v1alpha1',
    owner: 'Console Data & Identity / Supabase',
    observedAt: value.meta?.time || new Date().toISOString(),
    // Email and recovery links are intentionally excluded from LLM-facing
    // inventory. A user ID or username is sufficient for governed actions.
    users: (value.users || []).map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      enabled: user.enabled,
      roles: (user.groups || []).map((group) => group.name).filter((role) => isRoleAllowed(role)),
    })),
    roles: (value.groups || []).map((role) => ({ code: role.name, description: role.description || '' })),
  };
}

async function oaaIdentityOwnerAction(actor, rawBody) {
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {};
  const action = String(body.action || '').trim().toLowerCase();
  const reason = requireOaaText(body.reason, 'management reason');
  if (action === 'create') {
    requireClosedOaaIdentityBody(body, ['action', 'email', 'username', 'displayName', 'roles', 'confirm', 'reason']);
    const email = String(body.email || '').trim().toLowerCase();
    const username = String(body.username || '').trim().toLowerCase();
    const displayName = String(body.displayName || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw { code: 400, msg: 'invalid Console user email' };
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(username)) throw { code: 400, msg: 'invalid Console username' };
    if (!displayName || displayName.length > 120) throw { code: 400, msg: 'displayName must be 1-120 characters' };
    const roleCodes = [...new Set((Array.isArray(body.roles) ? body.roles : []).map((role) => String(role || '').trim()).filter(Boolean))];
    if (roleCodes.length > 3 || roleCodes.some((role) => !isRoleAllowed(role))) throw { code: 400, msg: 'roles must be a subset of the canonical Console role catalog' };
    requireExactOaaConfirmation(body.confirm, `create Console user ${username}`);
    const roles = await listRoles();
    const roleIds = await roleByCodeToId(roles);
    if (roleCodes.some((role) => !roleIds.has(role))) throw { code: 503, msg: 'canonical Console role catalog is incomplete' };
    const opId = newOpId();
    await logAudit(actor, 'oaa-identity-user-create', username, 'attempt', reason, { requestId: opId, phase: 'intent', targetType: 'console-identity-user' });
    let created;
    try {
      created = await createAuthUser(email, displayName, { username });
      if (!created?.id) throw { code: 503, msg: 'auth user id not found' };
      await upsertOperator(created.id, displayName, true);
      for (const role of roleCodes) {
        await restRequest('operator_role', {
          method: 'POST', query: 'select=user_id,role_id',
          body: [{ user_id: created.id, role_id: roleIds.get(role), granted_by: actor.sub, reason }],
          prefer: 'return=minimal,resolution=ignore-duplicates',
        });
      }
    } catch (error) {
      if (created?.id) {
        await restRequest('operator_role', { method: 'DELETE', query: `user_id=eq.${created.id}`, prefer: 'return=minimal' }).catch(() => undefined);
        await restRequest('operator', { method: 'DELETE', query: `user_id=eq.${created.id}`, prefer: 'return=minimal' }).catch(() => undefined);
        await authAdminRequest(`/admin/users/${created.id}`, { method: 'DELETE' }).catch(() => undefined);
      }
      await logAudit(actor, 'oaa-identity-user-create', username, 'failed', reason, { requestId: opId, phase: 'applied', targetType: 'console-identity-user' }).catch(() => undefined);
      if (error?.code === 422) throw { code: 409, msg: 'Console user already exists' };
      throw error;
    }
    await logAudit(actor, 'oaa-identity-user-create', created.id, 'ok', reason, { requestId: opId, phase: 'applied', targetType: 'console-identity-user' });
    return { accepted: true, owner: 'Console Data & Identity / Supabase', target: `ConsoleUser/${created.id}`, user: { id: created.id, username, displayName, enabled: true, roles: roleCodes } };
  }
  if (action === 'set-enabled') {
    requireClosedOaaIdentityBody(body, ['action', 'userId', 'enabled', 'confirm', 'reason']);
    const userId = uuid(body.userId, 'Console user id');
    if (typeof body.enabled !== 'boolean') throw { code: 400, msg: 'enabled must be boolean' };
    const verb = body.enabled ? 'enable' : 'disable';
    requireExactOaaConfirmation(body.confirm, `${verb} Console user ${userId}`);
    await mutateEnabled({ actor, userId, enabled: body.enabled, reason });
    return { accepted: true, owner: 'Console Data & Identity / Supabase', target: `ConsoleUser/${userId}`, enabled: body.enabled };
  }
  if (action === 'role') {
    requireClosedOaaIdentityBody(body, ['action', 'userId', 'role', 'operation', 'confirm', 'reason']);
    const userId = uuid(body.userId, 'Console user id');
    const role = String(body.role || '').trim();
    const operation = String(body.operation || '').trim().toLowerCase();
    if (!isRoleAllowed(role)) throw { code: 400, msg: 'role is outside the canonical Console role catalog' };
    if (!['add', 'remove'].includes(operation)) throw { code: 400, msg: 'role operation must be add or remove' };
    requireExactOaaConfirmation(body.confirm, `${operation} Console role ${role} for user ${userId}`);
    await mutateGroup({ actor, userId, op: operation, roleName: role, reason });
    return { accepted: true, owner: 'Console Data & Identity / Supabase', target: `ConsoleUser/${userId}/Role/${role}`, operation };
  }
  throw { code: 400, msg: 'OAA identity action must be create, set-enabled, or role' };
}

async function cliEnrollmentCreate(body) {
  const label = cliLabel(body?.label);
  const publicJwk = cliPublicJwk(body?.publicJwk);
  const userCode = randomBytes(5).toString('hex').slice(0, 8).toUpperCase();
  const pollToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CLI_ENROLLMENT_TTL_SEC * 1000).toISOString();
  const rows = await restRequest('cli_enrollment', {
    method: 'POST', query: 'select=id', body: [{ label, public_jwk: publicJwk, fingerprint: cliFingerprint(publicJwk), user_code_hash: toHashHex(userCode), poll_token_hash: toHashHex(pollToken), expires_at: expiresAt }],
  });
  const id = rows?.[0]?.id;
  if (!id) throw { code: 503, msg: 'CLI enrollment creation failed' };
  return { enrollmentId: id, pollToken, userCode, verificationUriComplete: `${CONSOLE_PUBLIC_URL}/me?tab=credentials&cli_enrollment=${encodeURIComponent(id)}&code=${encodeURIComponent(userCode)}`, expiresAt, pollInterval: 2 };
}

async function cliEnrollmentRead(id, code) {
  const enrollmentId = cliId(id, 'enrollment id');
  const rows = await restRequest('cli_enrollment', { query: `select=id,label,fingerprint,status,expires_at,user_code_hash&id=eq.${enrollmentId}` });
  const enrollment = rows?.[0];
  if (!enrollment || !code || !safeEqual(enrollment.user_code_hash, toHashHex(String(code).trim().toUpperCase())) || enrollment.status !== 'pending' || Date.parse(enrollment.expires_at) <= Date.now()) throw { code: 404, msg: 'CLI enrollment not found or expired' };
  return { enrollmentId: enrollment.id, label: enrollment.label, fingerprint: enrollment.fingerprint, expiresAt: enrollment.expires_at };
}

async function cliEnrollmentApprove(actor, id, userCode) {
  const enrollmentId = cliId(id, 'enrollment id');
  const code = String(userCode || '').trim().toUpperCase();
  if (!/^[A-F0-9]{8}$/.test(code)) throw { code: 400, msg: 'invalid CLI user code' };
  const rows = await restRequest('rpc/approve_cli_enrollment', { method: 'POST', body: { p_enrollment_id: enrollmentId, p_actor_id: actor.sub, p_user_code_hash: toHashHex(code) } });
  const device = rows?.[0];
  if (!device?.device_id) throw { code: 409, msg: 'CLI enrollment was already consumed or expired' };
  await logAudit(actor, 'cli-device-approve', device.device_id, 'ok', 'Supabase browser approved CLI enrollment', { targetType: 'console-cli-device' });
  return { deviceId: device.device_id, label: device.label, fingerprint: device.fingerprint };
}

async function cliEnrollmentPoll(id, pollToken) {
  const enrollmentId = cliId(id, 'enrollment id');
  const rows = await restRequest('cli_enrollment', { query: `select=status,expires_at,poll_token_hash,device_id,label,fingerprint&id=eq.${enrollmentId}` });
  const enrollment = rows?.[0];
  if (!enrollment || !safeEqual(enrollment.poll_token_hash, toHashHex(pollToken))) throw { code: 404, msg: 'CLI enrollment not found' };
  if (Date.parse(enrollment.expires_at) <= Date.now()) throw { code: 410, msg: 'CLI enrollment expired' };
  if (enrollment.status === 'pending') return null;
  if (enrollment.status !== 'approved' || !enrollment.device_id) throw { code: 409, msg: 'CLI enrollment unavailable' };
  return { deviceId: enrollment.device_id, label: enrollment.label, fingerprint: enrollment.fingerprint };
}

async function cliDevices(actor) {
  const rows = await restRequest('cli_device', { query: `select=id,label,fingerprint,status,created_at,last_used_at,revoked_at&owner_id=eq.${encodeURIComponent(actor.sub)}&order=created_at.desc` });
  return { devices: Array.isArray(rows) ? rows.map((row) => ({ id: row.id, label: row.label, fingerprint: row.fingerprint, status: row.status, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at })) : [] };
}

async function revokeCliDevice(actor, id, reason) {
  const deviceId = cliId(id, 'device id');
  if (!managementReason(reason)) throw { code: 400, msg: 'reason must be at least 8 characters' };
  const now = new Date().toISOString();
  const rows = await restRequest('cli_device', { method: 'PATCH', query: `id=eq.${deviceId}&owner_id=eq.${encodeURIComponent(actor.sub)}&status=eq.active&select=id`, body: { status: 'revoked', revoked_at: now, revoked_by: actor.sub, revoke_reason: reason }, prefer: 'return=representation' });
  if (!rows?.[0]) throw { code: 404, msg: 'active CLI device not found' };
  await restRequest('cli_session', { method: 'PATCH', query: `device_id=eq.${deviceId}&status=eq.active`, body: { status: 'revoked', revoked_at: now }, prefer: 'return=minimal' });
  await logAudit(actor, 'cli-device-revoke', deviceId, 'ok', reason, { targetType: 'console-cli-device' });
}

async function cliChallenge(deviceId) {
  const id = cliId(deviceId, 'device id');
  const rows = await restRequest('cli_device', { query: `select=id& id=eq.${id}&status=eq.active`.replace('& ', '&') });
  if (!rows?.[0]) throw { code: 401, msg: 'CLI device inactive or unknown' };
  const nonce = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CLI_CHALLENGE_TTL_SEC * 1000).toISOString();
  const created = await restRequest('cli_challenge', { method: 'POST', query: 'select=id', body: [{ device_id: id, nonce_hash: toHashHex(nonce), expires_at: expiresAt }] });
  return { challengeId: created?.[0]?.id, nonce, expiresAt };
}

async function cliSession(body) {
  const deviceId = cliId(body?.deviceId, 'device id');
  const challengeId = cliId(body?.challengeId, 'challenge id');
  const rows = await restRequest('cli_challenge', { query: `select=id,nonce_hash,expires_at,used_at,device:cli_device(id,owner_id,public_jwk,status)&id=eq.${challengeId}&device_id=eq.${deviceId}` });
  const challenge = rows?.[0];
  const device = challenge?.device;
  if (!challenge || challenge.used_at || Date.parse(challenge.expires_at) <= Date.now() || !device || device.status !== 'active') throw { code: 401, msg: 'CLI challenge unavailable' };
  const message = `opensphere-cli-session-v2\n${deviceId}\n${challengeId}\n${body?.nonce || ''}`;
  // The nonce is never sent back by the client as a trusted value: recover it
  // from the signed message only after comparing its digest to the challenge.
  if (!body?.nonce || !safeEqual(challenge.nonce_hash, toHashHex(body.nonce))) throw { code: 401, msg: 'CLI challenge nonce mismatch' };
  let verified = false;
  try { verified = verifySignature('sha256', Buffer.from(message), createPublicKey({ key: device.public_jwk, format: 'jwk' }), Buffer.from(String(body.signature || ''), 'base64url')); } catch { verified = false; }
  if (!verified) throw { code: 401, msg: 'CLI device signature rejected' };
  const used = await restRequest('cli_challenge', { method: 'PATCH', query: `id=eq.${challengeId}&used_at=is.null&select=id`, body: { used_at: new Date().toISOString() }, prefer: 'return=representation' });
  if (!used?.[0]) throw { code: 409, msg: 'CLI challenge already used' };
  const operator = await getOperatorById(device.owner_id);
  if (!operator || operator.status !== 'active') throw { code: 401, msg: 'CLI device owner inactive' };
  const expiresAt = new Date(Date.now() + CLI_SESSION_TTL_SEC * 1000).toISOString();
  const sessions = await restRequest('cli_session', { method: 'POST', query: 'select=id', body: [{ owner_id: device.owner_id, device_id: device.id, credential_revision: operator.credential_revision, expires_at: expiresAt }] });
  const sessionId = sessions?.[0]?.id;
  if (!sessionId) throw { code: 503, msg: 'CLI session creation failed' };
  const accessToken = cliToken({ sub: device.owner_id, jti: sessionId, typ: 'cli_session', device_id: device.id, credential_revision: operator.credential_revision, exp: Math.floor(Date.parse(expiresAt) / 1000) });
  return { accessToken, expiresIn: CLI_SESSION_TTL_SEC };
}

async function cliTokens(actor) {
  const rows = await restRequest('api_token', { query: `select=id,label,status,scope,expires_at,created_at,last_used_at,revoked_at&owner_id=eq.${encodeURIComponent(actor.sub)}&order=created_at.desc` });
  return { pats: Array.isArray(rows) ? rows.map((row) => ({ jti: row.id, label: row.label, status: row.status, expiresAt: row.expires_at, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at, scope: row.scope || 'console-admin' })) : [] };
}

async function cliTokenCreate(actor, body) {
  const label = cliLabel(body?.label);
  const reason = managementReason(body?.reason);
  if (!reason) throw { code: 400, msg: 'reason must be at least 8 characters' };
  const scope = normalizePatScope(body?.scope);
  const ttlSeconds = validatePatTTL(body?.ttlSeconds, CLI_PAT_TTL_SEC);
  const operator = await getOperatorById(actor.sub);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const id = randomUUID();
  const token = cliToken({ sub: actor.sub, jti: id, typ: 'pat', scope, credential_revision: operator.credential_revision, exp: Math.floor(Date.parse(expiresAt) / 1000) });
  await restRequest('api_token', { method: 'POST', body: [{ id, owner_id: actor.sub, label, scope, token_hash: toHashHex(token), credential_revision: operator.credential_revision, expires_at: expiresAt }] });
  await logAudit(actor, 'cli-token-create', id, 'ok', reason, { targetType: 'console-cli-token' });
  return { token, jti: id, label, expiresAt, ttlSeconds, scope };
}

async function revokeCliToken(actor, id, reason) {
  const tokenId = cliId(id, 'token id');
  if (!managementReason(reason)) throw { code: 400, msg: 'reason must be at least 8 characters' };
  const rows = await restRequest('api_token', { method: 'PATCH', query: `id=eq.${tokenId}&owner_id=eq.${encodeURIComponent(actor.sub)}&status=eq.active&select=id`, body: { status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: actor.sub, revoke_reason: reason }, prefer: 'return=representation' });
  if (!rows?.[0]) throw { code: 404, msg: 'active CLI token not found' };
  await logAudit(actor, 'cli-token-revoke', tokenId, 'ok', reason, { targetType: 'console-cli-token' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  _httpReqs++;
  try {
    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (p === '/readyz') {
      try { return json(res, 200, await requireSupabase()); }
      catch {
        return json(res, 503, { ready: false, required: true, error: 'Supabase data and identity authority unavailable' });
      }
    }
    if (p === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      return res.end(metricsText());
    }
    if (p === '/api/identity/bootstrap/status' && req.method === 'GET') {
      return json(res, 200, await bootstrapStatus());
    }
    if (p === '/api/identity/bootstrap' && req.method === 'POST') {
      return json(res, 201, await bootstrapInitialOperator(await readBody(req)));
    }
    // Supabase-owned OS CLI device flow.  The create/poll pair carries no
    // browser credential; browser approval always re-verifies the Supabase
    // session and atomically binds the device to that Console subject.
    if (p === '/api/identity/cli/enrollments' && req.method === 'POST') {
      try { return json(res, 201, await cliEnrollmentCreate(await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'CLI enrollment creation failed' }); }
    }
    const cliEnrollmentPath = p.match(/^\/api\/identity\/cli\/enrollments\/([0-9a-fA-F-]+)$/);
    const cliEnrollmentPollPath = p.match(/^\/api\/identity\/cli\/enrollments\/([0-9a-fA-F-]+)\/poll$/);
    const cliEnrollmentApprovePath = p.match(/^\/api\/identity\/cli\/enrollments\/([0-9a-fA-F-]+)\/approve$/);
    if (cliEnrollmentPath && req.method === 'GET') {
      try { await verifyConsoleAdmin(req); return json(res, 200, await cliEnrollmentRead(cliEnrollmentPath[1], url.searchParams.get('code'))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'CLI enrollment unavailable' }); }
    }
    if (cliEnrollmentPollPath && req.method === 'POST') {
      try {
        const approved = await cliEnrollmentPoll(cliEnrollmentPollPath[1], (await readBody(req)).pollToken);
        return approved ? json(res, 200, approved) : json(res, 202, { status: 'pending' });
      } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'CLI enrollment unavailable' }); }
    }
    if (cliEnrollmentApprovePath && req.method === 'POST') {
      try { const actor = await verifyConsoleAdmin(req); return json(res, 200, await cliEnrollmentApprove(actor, cliEnrollmentApprovePath[1], (await readBody(req)).userCode)); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'CLI enrollment approval failed' }); }
    }
    if (p === '/api/identity/cli/challenge' && req.method === 'POST') {
      try { return json(res, 200, await cliChallenge((await readBody(req)).deviceId)); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'CLI challenge unavailable' }); }
    }
    if (p === '/api/identity/cli/session' && req.method === 'POST') {
      try { return json(res, 200, await cliSession(await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'CLI session unavailable' }); }
    }
    if (p === '/api/identity/cli/introspect' && req.method === 'GET') {
      try {
        const actor = await verifyAuthed(req);
        const identity = userFromAuthRow(await getAuthUser(actor.sub), actor.displayName || actor.username || actor.sub);
        return json(res, 200, {
          active: true,
          userId: actor.sub,
          subject: actor.sub,
          email: identity.email,
          username: identity.username,
          displayName: actor.displayName || identity.displayName || identity.username,
          deviceId: actor.deviceId || null,
          groups: actor.groups,
          type: actor.provider === 'supabase-cli' ? 'cli' : 'browser',
        });
      }
      catch (e) { return json(res, authErrorStatus(e), { active: false, error: e.msg || 'CLI credential unavailable' }); }
    }
    if (p === '/api/identity/cli/devices' && req.method === 'GET') {
      try { return json(res, 200, await cliDevices(await verifyConsoleAdmin(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'CLI devices unavailable' }); }
    }
    const cliDevicePath = p.match(/^\/api\/identity\/cli\/devices\/([0-9a-fA-F-]+)$/);
    if (cliDevicePath && req.method === 'DELETE') {
      try { const actor = await verifyConsoleAdmin(req); await revokeCliDevice(actor, cliDevicePath[1], (await readBody(req)).reason); return json(res, 204, null); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'CLI device revocation failed' }); }
    }
    if (p === '/api/identity/cli/tokens' && req.method === 'GET') {
      try { return json(res, 200, await cliTokens(await verifyConsoleAdmin(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'CLI tokens unavailable' }); }
    }
    if (p === '/api/identity/cli/tokens' && req.method === 'POST') {
      try { const actor = await verifyConsoleAdmin(req); return json(res, 201, await cliTokenCreate(actor, await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'CLI token creation failed' }); }
    }
    const cliTokenPath = p.match(/^\/api\/identity\/cli\/tokens\/([0-9a-fA-F-]+)$/);
    if (cliTokenPath && req.method === 'DELETE') {
      try { const actor = await verifyConsoleAdmin(req); await revokeCliToken(actor, cliTokenPath[1], (await readBody(req)).reason); return json(res, 204, null); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'CLI token revocation failed' }); }
    }
    // The Auth JWT identifies the person, while Console roles live in the
    // canonical `console.operator_role` projection.  Expose only the
    // caller's evaluated roles so the shell can render its native management
    // entry point from the same authority that protects management APIs.
    if (p === '/api/identity/session' && req.method === 'GET') {
      try {
        const actor = await verifyAuthed(req);
        return json(res, 200, {
          subject: actor.sub,
          username: actor.username,
          groups: projectedSessionGroups(actor),
          permissions: actor.permissions || [],
          assurance: actor.assurance,
        });
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' });
      }
    }
    // OAA provider credentials are a Console management write, not a Gateway
    // mutation.  The Backend is the policy/audit enforcement point and writes
    // only the OAA-labelled Kubernetes Secret; the Gateway remains read-only.
    if (p === '/api/oaa/admin/llm-keys' && req.method === 'GET') {
      try { const actor = await verifyConsoleAdmin(req); return json(res, 200, await listOaaKeys(actor)); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'OAA credential inventory unavailable' }); }
    }
    if (p === '/api/oaa/admin/llm-keys' && req.method === 'POST') {
      try {
        const actor = await verifyConsoleAdmin(req);
        const out = await upsertOaaKey(actor, await readBody(req));
        return json(res, out.created ? 201 : 200, out);
      } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'OAA credential save failed' }); }
    }
    const oaaKeyTestPath = p.match(/^\/api\/oaa\/admin\/llm-keys\/([a-z0-9-]+)\/test$/);
    if (oaaKeyTestPath && req.method === 'POST') {
      try {
        const actor = await verifyConsoleAdmin(req);
        return json(res, 200, await validateStoredOaaKey(actor, oaaKeyTestPath[1]));
      } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'OAA credential validation failed' }); }
    }
    const oaaKeyPath = p.match(/^\/api\/oaa\/admin\/llm-keys\/([a-z0-9-]+)$/);
    if (oaaKeyPath && req.method === 'DELETE') {
      try {
        const actor = await verifyConsoleAdmin(req);
        return json(res, 200, await deleteOaaKey(actor, oaaKeyPath[1], url.searchParams.get('reason')));
      } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'OAA credential delete failed' }); }
    }
    // OAA is not an audit authority.  It forwards evidence through this
    // Console Backend endpoint so every tool/retrieval event is persisted in
    // the canonical append-only audit.event chain under the verified caller.
    if (p === '/api/oaa/audit' && req.method === 'POST') {
      try {
        const actor = await verifyAuthed(req);
        const body = await readBody(req);
        const action = String(body.action || '').trim();
        const target = String(body.target || '').trim();
        const result = String(body.result || '').trim();
        const reason = String(body.reason || '').trim() || 'OAA read/planning operation';
        if (!action || !target || !result) throw { code: 400, msg: 'action, target and result are required' };
        const requestId = body.requestId && /^[0-9a-f-]{36}$/i.test(String(body.requestId)) ? body.requestId : newOpId();
        return json(res, 201, await logAudit(actor, action.slice(0, 160), target.slice(0, 300), result.slice(0, 64), reason.slice(0, 1000), {
          requestId,
          phase: body.phase || 'applied',
          targetType: String(body.targetType || 'oaa').slice(0, 120),
          payloadDigest: body.payloadDigest ? String(body.payloadDigest).replace(/^sha256:/, '') : undefined,
        }));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'OAA audit unavailable' });
      }
    }
    if (p === '/api/oaa/actions/submit' && req.method === 'POST') {
      try {
        const actor = await verifyAuthed(req);
        return json(res, 202, await submitOaaAction(actor, await readBody(req), req.headers.authorization));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'OAA action submission failed' });
      }
    }
    if (p === '/api/oaa/owner/identity/status' && req.method === 'GET') {
      try {
        await verifyOaaIdentityOwner(req);
        return json(res, 200, await oaaIdentityStatus());
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'OAA identity owner status unavailable' });
      }
    }
    if (p === '/api/oaa/owner/identity/actions' && req.method === 'POST') {
      try {
        const actor = await verifyOaaIdentityOwner(req, { requireAal2: true });
        return json(res, 202, await oaaIdentityOwnerAction(actor, await readBody(req)));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'OAA identity owner action failed' });
      }
    }
    if (p === '/api/oaa/owner/notifications/status' && req.method === 'GET') {
      try {
        await verifyOaaNotificationOwner(req);
        return json(res, 200, await oaaNotificationStatus(url.searchParams.get('limit')));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'OAA notification owner status unavailable' });
      }
    }
    if (p === '/api/oaa/owner/notifications/actions' && req.method === 'POST') {
      try {
        const actor = await verifyOaaNotificationOwner(req, { mutation: true });
        return json(res, 202, await oaaNotificationOwnerAction(actor, await readBody(req)));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'OAA notification owner action failed' });
      }
    }
    if (p === '/api/oaa/owner/recovery/capabilities' && req.method === 'GET') {
      try {
        await verifyOaaRecoveryOwner(req);
        return json(res, 200, await oaaRecoveryCapabilities());
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'OAA recovery owner capabilities unavailable' });
      }
    }
    if (p === '/api/oaa/owner/recovery/status' && req.method === 'GET') {
      try {
        const actor = await verifyOaaRecoveryOwner(req);
        const result = await oaaRecoveryStatus();
        await logAudit(actor, 'oaa-recovery-status', 'PlatformRecovery/all', 'ok', 'OAA recovery status read', { targetType: 'platform-recovery' });
        return json(res, 200, result);
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'OAA recovery owner status unavailable' });
      }
    }
    if (p === '/api/oaa/owner/recovery/plan' && req.method === 'POST') {
      try {
        const actor = await verifyOaaRecoveryOwner(req);
        const body = await readBody(req);
        const result = await oaaRecoveryPlan(body);
        await logAudit(actor, 'oaa-recovery-plan', `PlatformRecovery/${result.component}`, 'ok', 'OAA non-destructive recovery plan read', { targetType: 'platform-recovery' });
        return json(res, 200, result);
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'OAA recovery owner plan unavailable' });
      }
    }
    // Notification events are server-to-server only. Browser and plugin UI
    // signals never enter the outbound delivery queue directly.
    if (p === '/api/internal/notifications/events' && req.method === 'POST') {
      try { return json(res, 202, await publishNotificationEvent(req, await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'notification event rejected' }); }
    }
    if (p === '/api/notifications/summary' && req.method === 'GET') {
      try { await verifyNotificationAdmin(req); return json(res, 200, await notificationApi.summary()); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'notification summary unavailable' }); }
    }
    if (p === '/api/notifications/channels' && req.method === 'GET') {
      try { await verifyNotificationAdmin(req); return json(res, 200, { items: await notificationApi.channels() }); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'notification channels unavailable' }); }
    }
    if (p === '/api/notifications/channels' && req.method === 'POST') {
      try { const actor = await verifyNotificationAdmin(req); return json(res, 201, await notificationApi.createChannel(actor, await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'notification channel creation failed' }); }
    }
    const notificationChannelConfiguration = p.match(/^\/api\/notifications\/channels\/([0-9a-fA-F-]+)$/);
    if (notificationChannelConfiguration) {
      try {
        const actor = await verifyNotificationAdmin(req);
        const id = notificationChannelConfiguration[1];
        if (req.method === 'GET') return json(res, 200, await notificationApi.smtpChannelConfiguration(id));
        if (req.method === 'PUT') return json(res, 200, await notificationApi.updateSmtpChannel(actor, id, await readBody(req)));
        return json(res, 405, { error: 'method not allowed' });
      } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'notification channel configuration failed' }); }
    }
    const notificationChannelAction = p.match(/^\/api\/notifications\/channels\/([0-9a-fA-F-]+)\/(enable|disable|test)$/);
    if (notificationChannelAction && req.method === 'POST') {
      try {
        const actor = await verifyNotificationAdmin(req);
        const [, id, action] = notificationChannelAction;
        const body = await readBody(req);
        if (action === 'test') return json(res, 200, await notificationApi.testChannel(actor, id, body));
        return json(res, 200, await notificationApi.setChannelEnabled(actor, id, action === 'enable', body));
      } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'notification channel action failed' }); }
    }
    if (p === '/api/notifications/rules' && req.method === 'GET') {
      try { await verifyNotificationAdmin(req); return json(res, 200, { items: await notificationApi.rules() }); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'notification rules unavailable' }); }
    }
    if (p === '/api/notifications/rules' && req.method === 'POST') {
      try { const actor = await verifyNotificationAdmin(req); return json(res, 201, await notificationApi.createRule(actor, await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'notification rule creation failed' }); }
    }
    if (p === '/api/notifications/deliveries' && req.method === 'GET') {
      try { await verifyNotificationAdmin(req); return json(res, 200, { items: await notificationApi.deliveries({ limit: url.searchParams.get('limit') }) }); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'notification deliveries unavailable' }); }
    }
    const notificationDeliveryRetry = p.match(/^\/api\/notifications\/deliveries\/([0-9a-fA-F-]+)\/retry$/);
    if (notificationDeliveryRetry && req.method === 'POST') {
      try { const actor = await verifyNotificationAdmin(req); return json(res, 202, await notificationApi.retryDelivery(actor, notificationDeliveryRetry[1], await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'notification delivery retry failed' }); }
    }
    if (p === '/api/external-channels/summary' && req.method === 'GET') {
      try { await verifyExternalChannelAdmin(req); return json(res, 200, await externalChannelApi.summary()); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'external channel summary unavailable' }); }
    }
    if (p === '/api/external-channels/backup-targets' && req.method === 'GET') {
      try { await verifyExternalChannelAdmin(req); return json(res, 200, { items: await externalChannelApi.targets() }); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'external backup targets unavailable' }); }
    }
    if (p === '/api/external-channels/backup-targets' && req.method === 'POST') {
      try {
        const actor = await verifyExternalChannelAdmin(req);
        return json(res, 201, await externalChannelApi.createTarget(actor, await readBody(req)));
      } catch (e) {
        return json(res, authErrorStatus(e), {
          error: e.msg || 'external backup target creation failed',
          ...(e.field ? { field: e.field } : {}),
        });
      }
    }
    const externalBackupTargetAction = p.match(/^\/api\/external-channels\/backup-targets\/([0-9a-fA-F-]+)\/(test|backup)$/);
    if (externalBackupTargetAction && req.method === 'POST') {
      try {
        const actor = await verifyExternalChannelAdmin(req);
        const [, id, action] = externalBackupTargetAction;
        const body = await readBody(req);
        return json(res, action === 'test' ? 200 : 201,
          action === 'test'
            ? await externalChannelApi.test(actor, id, body)
            : await externalChannelApi.backupNow(actor, id, body));
      } catch (e) {
        return json(res, authErrorStatus(e), {
          error: e.msg || 'external backup target action failed',
          ...(e.field ? { field: e.field } : {}),
        });
      }
    }
    if (p === '/api/external-channels/backups' && req.method === 'GET') {
      try { await verifyExternalChannelAdmin(req); return json(res, 200, { items: await externalChannelApi.backups() }); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'configuration backups unavailable' }); }
    }
    const externalBackupPreview = p.match(/^\/api\/external-channels\/backups\/([0-9a-fA-F-]+)\/restore-preview$/);
    if (externalBackupPreview && req.method === 'POST') {
      try {
        const actor = await verifyExternalChannelAdmin(req);
        return json(res, 201, await externalChannelApi.previewRestore(actor, externalBackupPreview[1], await readBody(req)));
      } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'configuration restore preview failed' }); }
    }
    const externalRestoreApply = p.match(/^\/api\/external-channels\/restores\/([0-9a-fA-F-]+)\/apply$/);
    if (externalRestoreApply && req.method === 'POST') {
      try {
        const actor = await verifyExternalChannelAdmin(req);
        return json(res, 200, await externalChannelApi.applyRestore(actor, externalRestoreApply[1], await readBody(req)));
      } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'configuration restore failed' }); }
    }
    // Gitea deliveries are authenticated by their HMAC signature, not by a
    // browser session. The payload is persisted only as a digest and receipt
    // metadata before it can advance a Console change state.
    if (p === '/api/platform/gitea/webhook' && req.method === 'POST') {
      try { return json(res, 202, await processGiteaWebhook(req)); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'Gitea webhook rejected' }); }
    }
    // An approved reconciler reports an observed result with a dedicated
    // server-to-server credential. Browsers and OAA cannot call this path.
    if (p === '/api/platform/reconcile/next' && req.method === 'POST') {
      try { return json(res, 200, await claimReconcileWork(req, await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'reconcile work claim rejected' }); }
    }
    if (p === '/api/platform/reconcile/receipt' && req.method === 'POST') {
      try { return json(res, 202, await recordReconcileReceipt(req, await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'reconcile receipt rejected' }); }
    }
    if (p === '/api/identity/supabase/status' && req.method === 'GET') {
      try {
        await verifyConsoleAdmin(req);
        return json(res, 200, await supabaseStatus());
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Supabase status unavailable' });
      }
    }
    if (p === '/api/platform/gitea/status' && req.method === 'GET') {
      try {
        await verifyConsoleAdmin(req);
        return json(res, 200, await giteaStatus());
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Gitea Change Control status unavailable' });
      }
    }
    if (p === '/api/platform/contracts' && req.method === 'GET') {
      try { await verifyConsoleAdmin(req); return json(res, 200, { items: await consumerContracts(), checkedAt: new Date().toISOString() }); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'consumer contracts unavailable' }); }
    }
    const changeTemplatePath = p.match(/^\/api\/platform\/change-templates\/([a-z0-9-]+)$/);
    if (changeTemplatePath && req.method === 'GET') {
      try { await verifyConsoleAdmin(req); return json(res, 200, changeTemplate(changeTemplatePath[1])); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'change template unavailable' }); }
    }
    if (p === '/api/platform/changes' && req.method === 'POST') {
      try { const actor = await verifyConsoleAdmin(req); return json(res, 202, await governedChange(actor, await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'governed change proposal failed' }); }
    }
    const changeApprovalPath = p.match(/^\/api\/platform\/changes\/([0-9a-fA-F-]+)\/approve$/);
    if (changeApprovalPath && req.method === 'POST') {
      try { const actor = await verifyConsoleAdmin(req); return json(res, 202, await approveGovernedChange(actor, changeApprovalPath[1], await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'governed change approval failed' }); }
    }
    if (p === '/api/catalog/entities' && req.method === 'GET') {
      try {
        await verifyAuthed(req);
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' });
      }
      const list = await catalogEntities(url.searchParams.get('filter'));
      const limit = Number(url.searchParams.get('limit') || 0);
      return json(res, 200, limit ? list.slice(0, limit) : list);
    }
    if (p.startsWith('/api/kubernetes/services/')) {
      try { await verifyAuthed(req); } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' }); }
      return json(res, 200, { items: [] });
    }
    if (p === '/api/identity' && req.method === 'GET') {
      try { await verifyAuthed(req); } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' }); }
      return json(res, 200, await identityPayload());
    }
    if (p === '/api/identity/audit' && req.method === 'GET') {
      try { await verifyConsoleAdmin(req); } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' }); }
      const rows = await listAuditEvents();
      return json(res, 200, { items: rows.map((row) => ({
        time: row.occurred_at,
        actor: row.actor_id,
        action: row.action,
        target: row.target_id,
        result: row.result,
        reason: row.reason || '',
        requestId: row.request_id,
        correlationId: row.correlation_id,
      })) });
    }
    if (p === '/api/identity/me/password' && req.method === 'POST') {
      const me = await verifyAuthed(req);
      const reason = managementReason((await readBody(req)).reason || 'password-reset');
      if (!reason) return json(res, 400, { error: 'reason은 8자 이상 필수 (IGA)', minimumLength: 8 });
      try {
        await requireSupabase();
        await logAudit(me, 'self-password-change', me.username || me.sub, 'attempt', reason, { phase: 'intent' });
        const user = await getAuthUser(me.sub);
        const actionLink = await createRecoveryLink(user?.email);
        await logAudit(me, 'self-password-change', me.username || me.sub, 'ok', reason, { phase: 'applied' });
        return json(res, 200, { ok: !!actionLink, resetUrl: actionLink, note: actionLink ? 'Supabase recovery link issued.' : 'password reset link unavailable in runtime auth profile' });
      } catch (error) {
        return json(res, authErrorStatus(error), { error: error?.msg || 'Supabase data and identity unavailable' });
      }
    }

    if (p === '/api/identity/users' && req.method === 'POST') {
      const actor = await verifyActor(req);
      const body = await readBody(req).catch(() => ({}));
      const email = String(body.email || '').trim().toLowerCase();
      const username = String(body.username || '').trim().toLowerCase();
      const displayName = String(body.displayName || '').trim();
      const reason = managementReason(body.reason);
      if (!reason) return json(res, 400, { error: 'reason은 8자 이상 필수 (IGA)', minimumLength: 8 });
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'email 형식 오류' });
      if (!displayName) return json(res, 400, { error: 'displayName은 비어 있을 수 없습니다' });

      const rolesInput = Array.isArray(body.roles) ? [...new Set(body.roles.map((r) => String(r).trim()).filter(Boolean))] : [];
      const availableRoles = await listRoles();
      const roleCodeToId = await roleByCodeToId(availableRoles);
      for (const role of rolesInput) {
        const code = roleCodeToId.has(role) ? role : (roleCodeToId.get(role) ? role : null);
        if (!isRoleAllowed(role) || (code && !roleCodeToId.has(role))) {
          return json(res, 400, { error: `허용되지 않은 역할 그룹: ${role}` });
        }
      }

      const opId = newOpId();
      await logAudit(actor, 'iga-create-user', username || email, 'attempt', `${reason}${rolesInput.length ? ` · roles=${rolesInput.join(',')}` : ''}`, { requestId: opId, phase: 'intent' });
      let created;
      try {
        const createdUser = await createAuthUser(email, displayName || username, { username });
        created = createdUser;
      } catch (error) {
        if (error?.code === 422) {
          return json(res, 409, { error: '이미 존재하는 사용자입니다' });
        }
        throw error;
      }
      if (!created?.id) throw { code: 503, msg: 'auth user id not found' };
      await upsertOperator(created.id, displayName || username, true);
      for (const role of rolesInput) {
        const roleId = roleCodeToId.get(role);
        if (!roleId) continue;
      await restRequest('operator_role', {
          method: 'POST',
          query: 'select=user_id,role_id',
          body: [{
            user_id: created.id,
            role_id: roleId,
            granted_by: actor.sub,
            reason,
          }],
          prefer: 'return=minimal,resolution=ignore-duplicates',
        });
      }
      const onboardingPath = await createRecoveryLink(email).catch(() => null);
      await logAudit(actor, 'create-user', created.id, 'ok', reason, { requestId: opId, phase: 'applied', targetType: 'console-identity-user' });
      return json(res, 201, { ok: true, id: created.id, username, roles: rolesInput, onboardingPath, note: onboardingPath ? '계정 생성 후 임시 패스워드/회복 링크가 발급되었습니다.' : '' });
    }

    const mOnboard = p.match(/^\/api\/identity\/users\/([0-9a-fA-F-]+)\/onboarding$/);
    if (mOnboard && req.method === 'POST') {
      const actor = await verifyActor(req);
      const body = await readBody(req).catch(() => ({}));
      const reason = managementReason(body.reason);
      if (!reason) return json(res, 400, { error: 'reason은 8자 이상 필수 (IGA)', minimumLength: 8 });
      const userId = mOnboard[1];
      const opId = newOpId();
      await logAudit(actor, 'iga-onboarding-link', userId, 'attempt', reason, { requestId: opId, phase: 'intent' });
      const target = await getOperatorById(userId);
      if (!target) return json(res, 404, { error: 'person not found' });
      const roles = await getOperatorRolesByUser(userId);
      const rolesMap = roleByIdMap(await listRoles());
      const targetRoles = roles.map((r) => rolesMap.get(r.role_id)).filter(Boolean);
      if (targetRoles.includes(SUPABASE_BACKEND_ROLE) && target.user_id === actor.sub) {
        await logAudit(actor, 'onboarding-link', userId, 'denied', 'administrator target requires a separate recovery approval', { requestId: opId, phase: 'applied' });
        return json(res, 403, { error: '관리자 계정의 온보딩 링크는 별도 승인 절차가 필요합니다' });
      }

      const authUser = await getAuthUser(userId);
      const link = await createRecoveryLink(authUser?.email);
      await logAudit(actor, 'onboarding-link', userId, link ? 'ok' : 'error', reason, { requestId: opId, phase: 'applied', targetType: 'console-identity-user' });
      return json(res, 200, { ok: true, username: userFromAuthRow(authUser, userId).username, onboardingPath: link });
    }

    const mAttrs = p.match(/^\/api\/identity\/users\/([0-9a-fA-F-]+)\/attrs$/);
    if (mAttrs && req.method === 'POST') {
      const actor = await verifyActor(req);
      const body = await readBody(req).catch(() => ({}));
      const reason = managementReason(body.reason);
      if (!reason) return json(res, 400, { error: 'reason은 8자 이상 필수 (IGA)', minimumLength: 8 });
      const userId = mAttrs[1];
      const opId = newOpId();
      await logAudit(actor, 'iga-update-attrs', userId, 'attempt', reason, { requestId: opId, phase: 'intent' });

      const displayName = body.displayName !== undefined ? String(body.displayName).trim() : undefined;
      const email = body.email !== undefined ? String(body.email).trim() : undefined;
      if (displayName === undefined && email === undefined) return json(res, 400, { error: '변경할 속성이 없습니다' });
      if (displayName !== undefined && !displayName) return json(res, 400, { error: 'displayName은 비울 수 없습니다' });
      if (email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'email 형식 오류' });

      const op = await getOperatorById(userId);
      if (!op) return json(res, 404, { error: 'person not found' });
      if (displayName !== undefined) await restRequest('operator', {
        method: 'PATCH',
        query: `user_id=eq.${userId}`,
        body: { display_name: displayName },
        prefer: 'return=minimal',
      });
      if (email !== undefined) await authAdminRequest(`/admin/users/${userId}`, { method: 'PUT', body: { email } });
      await logAudit(actor, 'update-attrs', userId, 'ok', reason, { requestId: opId, phase: 'applied' });
      return json(res, 200, { ok: true, username: userFromAuthRow(await getAuthUser(userId), displayName || op.display_name).username });
    }

    const mEnable = p.match(/^\/api\/identity\/users\/([0-9a-fA-F-]+)\/enabled$/);
    const mGroup = p.match(/^\/api\/identity\/users\/([0-9a-fA-F-]+)\/group$/);
    if ((mEnable || mGroup) && req.method === 'POST') {
      const actor = await verifyActor(req);
      const userId = mEnable ? mEnable[1] : mGroup[1];
      const body = await readBody(req).catch(() => ({}));
      const reason = managementReason(body.reason);
      if (!reason) return json(res, 400, { error: 'reason은 8자 이상 필수 (IGA)', minimumLength: 8 });
      try {
        if (mEnable) {
          const enabled = safeEnabledValue(body.enabled);
          if (enabled === null) return json(res, 400, { error: 'enabled(Boolean) required' });
          await mutateEnabled({ actor, userId, enabled, reason });
          return json(res, 200, { ok: true });
        }
        const groupName = body.group ? String(body.group).trim() : undefined;
        const groupId = body.groupId ? String(body.groupId) : undefined;
        const op = (body.op || '').toLowerCase();
        await mutateGroup({ actor, userId, op, groupId, roleName: groupName, reason });
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, error?.code || 500, { error: error?.msg || 'operation failed' });
      }
    }

    if (p === '/plugins' || p === '/plugins/') {
      const files = fs.existsSync(PLUGIN_DIR) ? fs.readdirSync(PLUGIN_DIR).filter((f) => !f.startsWith('.')) : [];
      return json(res, 200, { plugins: files });
    }
    if (p.startsWith('/plugins/')) {
      const file = path.basename(p);
      const fp = path.join(PLUGIN_DIR, file);
      if (file && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        const mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
        const stream = fs.createReadStream(fp);
        stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end('read error'); });
        stream.once('open', () => res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' }));
        return stream.pipe(res, { end: true });
      }
      res.writeHead(404); return res.end('plugin not found');
    }

    res.writeHead(404); return res.end('not found');
  } catch (e) {
    console.error('[err]', e);
    if (!res.headersSent) json(res, e && e.code === 413 ? 413 : 500, { error: e && e.code === 413 ? 'payload too large' : (e?.msg || 'internal error') });
  }
});

server.listen(PORT, () => console.log(`opensphere-console-backend v${VERSION} listening :${PORT} (Supabase identity/data + catalog + Kubernetes passthrough)`));

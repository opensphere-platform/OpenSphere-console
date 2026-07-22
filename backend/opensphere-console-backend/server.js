// Console Backend — Supabase-backed identity/catalo​g/kubernetes proxy core.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual, createPublicKey, verify: verifySignature } = require('crypto');
const { createSupabaseVerifier } = require('./supabase-auth');

const MAX_BODY = 256 * 1024; // prevent unbounded in-memory request buffering
const newOpId = () => randomUUID();

const PORT = process.env.PORT || 8080;
const PLUGIN_DIR = process.env.PLUGIN_DIR || '/plugins';
const VERSION = process.env.APP_VERSION || '0.5.1-supabase-cli';
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
const GITEA_CHANGE_REQUIRE_AAL2 = String(process.env.GITEA_CHANGE_REQUIRE_AAL2 || 'true').toLowerCase() !== 'false';
const RECONCILER_RECEIPT_TOKEN = process.env.RECONCILER_RECEIPT_TOKEN || '';
const GITEA_TIMEOUT_MS = Number(process.env.GITEA_TIMEOUT_MS || 3000);
const SUPABASE_BACKEND_ROLE = process.env.SUPABASE_BACKEND_ROLE || 'console-admins';
const SUPABASE_BACKEND_DB_ROLE = process.env.SUPABASE_BACKEND_DB_ROLE || 'opensphere_console_backend';
const SUPABASE_BACKEND_TOKEN_TTL_SEC = Number(process.env.SUPABASE_BACKEND_TOKEN_TTL_SEC || (24 * 60 * 60 * 30));
const SUPABASE_BACKEND_TOKEN = process.env.SUPABASE_BACKEND_TOKEN || '';
const AUDIT_READ_LIMIT = Number(process.env.SUPABASE_AUDIT_READ_LIMIT || 200);
const SUPABASE_REQUIRE_AAL2 = String(process.env.SUPABASE_REQUIRE_AAL2 || 'false').toLowerCase() === 'true';
const OAA_ACTION_REQUIRE_AAL2 = String(process.env.OAA_ACTION_REQUIRE_AAL2 || 'true').toLowerCase() !== 'false';
const CONSOLE_PUBLIC_URL = (process.env.CONSOLE_PUBLIC_URL || 'https://localhost:8090').replace(/\/$/, '');
const CLI_TOKEN_ISSUER = 'opensphere-cli';
const CLI_TOKEN_AUDIENCE = 'opensphere-cli';
const CLI_JWT_SECRET = process.env.CLI_JWT_SECRET || '';
const CLI_SESSION_TTL_SEC = Number(process.env.CLI_SESSION_TTL_SEC || 900);
const CLI_PAT_TTL_SEC = Number(process.env.CLI_PAT_TTL_SEC || (30 * 24 * 60 * 60));
const CLI_ENROLLMENT_TTL_SEC = Number(process.env.CLI_ENROLLMENT_TTL_SEC || 300);
const CLI_CHALLENGE_TTL_SEC = Number(process.env.CLI_CHALLENGE_TTL_SEC || 60);

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

const authErrorStatus = (error) => (typeof error?.code === 'number' ? error.code : 502);
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
  try {
    const claims = b64urlParsePayload(match[1]);
    if (claims?.iss === CLI_TOKEN_ISSUER) return verifyManagedCliToken(match[1]);
  } catch { /* the Supabase verifier returns the canonical malformed-token error */ }
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
    restRequest('operator', { query: `select=status,credential_revision&user_id=eq.${encoded}` }),
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
  return { sub: subject, username: claims.email || subject, groups, assurance: 'aal2', authSessionId: claims.jti || null, provider: 'supabase-cli', credentialRevision: operator.credential_revision };
}

async function verifyManagedCliToken(token) {
  const claims = verifyCliToken(token);
  const resource = claims.typ === 'pat' ? 'api_token' : 'cli_session';
  const fields = claims.typ === 'pat'
    ? 'id,owner_id,credential_revision,status,expires_at,token_hash'
    : 'id,owner_id,device_id,credential_revision,status,expires_at';
  const rows = await restRequest(resource, { query: `select=${fields}&id=eq.${encodeURIComponent(claims.jti)}` });
  const record = Array.isArray(rows) ? rows[0] : null;
  if (!record || record.status !== 'active' || Date.parse(record.expires_at) <= Date.now() || record.owner_id !== claims.sub) {
    throw { code: 401, msg: 'CLI credential inactive or revoked' };
  }
  if (claims.typ === 'pat' && !safeEqual(record.token_hash, toHashHex(token))) throw { code: 401, msg: 'CLI token binding mismatch' };
  if (claims.typ === 'cli_session' && (!claims.device_id || record.device_id !== claims.device_id)) throw { code: 401, msg: 'CLI session device mismatch' };
  if (Number(record.credential_revision) !== Number(claims.credential_revision)) throw { code: 401, msg: 'CLI credential revision revoked' };
  await restRequest(resource, { method: 'PATCH', query: `id=eq.${encodeURIComponent(claims.jti)}`, body: { last_used_at: new Date().toISOString() }, prefer: 'return=minimal' }).catch(() => undefined);
  return resolveConsoleActor(claims.sub, claims);
}

async function verifyActor(req) {
  const actor = await verifyAuthed(req);
  if (!actor.groups || !actor.groups.includes(SUPABASE_BACKEND_ROLE)) throw { code: 403, msg: `requires ${SUPABASE_BACKEND_ROLE}` };
  // Production can require Supabase MFA explicitly.  Do not make a Console
  // with no enrolled MFA factor permanently unmanageable during bootstrap.
  if (SUPABASE_REQUIRE_AAL2 && actor.provider === 'supabase' && actor.assurance !== 'aal2') {
    throw { code: 403, msg: 'admin action requires MFA assurance aal2' };
  }
  return actor;
}

async function verifyConsoleAdmin(req) {
  const actor = await verifyAuthed(req);
  if (!actor.groups || !actor.groups.includes(SUPABASE_BACKEND_ROLE)) {
    throw { code: 403, msg: `requires ${SUPABASE_BACKEND_ROLE}` };
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

const OAA_ACTION_POLICY = Object.freeze({
  'oaa.knowledge.ingest-manual': { permission: 'oaa.knowledge.manage', risk: 'high', targetType: 'oaa-knowledge' },
  'oaa.k8s.deployment.restart': { permission: 'oaa.action.execute.high', risk: 'high', targetType: 'kubernetes-deployment' },
  'oaa.k8s.deployment.scale': { permission: 'oaa.action.execute.high', risk: 'high', targetType: 'kubernetes-deployment' },
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

// OAA never receives Kubernetes write credentials. A non-read OAA request is
// materialized as a governed Gitea proposal through the same adapter used by
// the native Change Control screen.
async function submitOaaAction(actor, body = {}) {
  const toolId = String(body.toolId || '').trim();
  const policy = OAA_ACTION_POLICY[toolId];
  if (!policy) throw { code: 403, msg: 'OAA tool is not an approved Console control-plane action' };
  requireActorPermission(actor, policy.permission);
  if (OAA_ACTION_REQUIRE_AAL2 && policy.risk === 'high' && actor.assurance !== 'aal2') {
    throw { code: 403, msg: 'high-risk OAA action requires MFA assurance aal2' };
  }
  const reason = managementReason(body.reason);
  if (!reason) throw { code: 400, msg: 'management reason must be at least 8 characters' };
  const target = oaaTarget(body.target);
  const inputs = body.inputs && typeof body.inputs === 'object' ? body.inputs : {};
  const payloadDigest = toHashHex(canonicalJson({ toolId, target, inputs, bindingId: body.bindingId || '' }));
  const proposal = await governedChange(actor, {
    consumerId: 'oaa-gateway', action: 'apply', target, reason,
    desiredState: { toolId, target, inputs, bindingId: body.bindingId || '', requiredPermission: policy.permission },
    idempotencyKey: `oaa:${payloadDigest}:${actor.sub}`.slice(0, 200),
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

function recoveryUnit(value) {
  const row = value && typeof value === 'object' ? value : {};
  const assertions = Array.isArray(row.assertions) ? row.assertions.map((item) => String(item).slice(0, 240)).slice(0, 20) : [];
  const declaredChecks = Array.isArray(row.checks) ? row.checks : [];
  const checks = declaredChecks.slice(0, 20).map((item) => ({
    assertion: String(item?.assertion || 'unnamed assertion').slice(0, 120),
    expected: String(item?.expected ?? 'recorded').slice(0, 120),
    observed: String(item?.observed ?? 'unknown').slice(0, 120),
    verdict: ['Verified', 'InsufficientEvidence', 'Failed'].includes(String(item?.verdict)) ? String(item.verdict) : 'InsufficientEvidence',
  }));
  const attention = checks.some((item) => item.verdict !== 'Verified');
  return {
    // A declaration cannot overrule its own failed or incomplete checks.  This
    // prevents an empty restore (for example `restored object files=0`) from
    // being surfaced to operators as Verified.
    state: attention ? 'AttentionRequired' : String(row.state || 'Unknown'),
    declaredState: String(row.state || 'Unknown'),
    verifiedAt: row.verifiedAt || null,
    assertions,
    checks,
    evidenceQuality: attention ? 'insufficient' : (checks.length ? 'verified' : 'unstructured'),
  };
}

// Recovery evidence is intentionally narrow: it gives operators verified
// state and assertions, never vault locations, key material or checksums.
// The ServiceAccount has a resource-name-scoped read permission only.
async function recoveryEvidence() {
  try {
    const configMap = await k8sGet('/api/v1/namespaces/opensphere-console/configmaps/opensphere-platform-recovery-evidence');
    const raw = String(configMap?.data?.['recovery-evidence.json'] || '');
    if (!raw) return { available: false, reason: 'recovery evidence is empty' };
    const evidence = JSON.parse(raw);
    return {
      available: true,
      generatedAt: evidence.generatedAt || null,
      supabase: recoveryUnit(evidence?.restore?.supabase),
      storage: recoveryUnit(evidence?.restore?.storage),
      gitea: recoveryUnit(evidence?.restore?.gitea),
      legacyDecommission: {
        approved: evidence?.decommission?.approved === true,
        completedAt: evidence?.decommission?.completedAt || null,
      },
    };
  } catch (error) {
    return { available: false, reason: String(error?.message || 'recovery evidence unavailable').slice(0, 240) };
  }
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
      if (/(password|token|credential|private.?key|secret(?!ref$|name$))/i.test(key)) {
        throw { code: 400, msg: `${at}.${key} may not contain secret material; use a named Secret reference` };
      }
      visit(child, `${at}.${key}`);
    }
  };
  visit(value, pathName);
  return { value, canonical: encoded, digest: toHashHex(encoded) };
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
  if (!/^(apply|rollback|configure)$/i.test(action)) throw { code: 400, msg: 'action must be apply, configure, or rollback' };
  const target = String(body.target || consumerId).trim();
  if (!target || target.length > 300 || /[\r\n]/.test(target)) throw { code: 400, msg: 'invalid governed change target' };
  const declaration = validateDeclaration(body.desiredState);
  const contractRows = await restRequest('consumer_contract', { query: `select=consumer_id,gitea_repository,gitea_path,reconciler&consumer_id=eq.${encodeURIComponent(consumerId)}` });
  const contract = Array.isArray(contractRows) ? contractRows[0] : null;
  if (!contract) throw { code: 404, msg: 'consumer contract not found' };
  if (contract.gitea_repository !== giteaRepoName()) throw { code: 409, msg: 'consumer contract is not bound to the configured Gitea repository' };
  const requestId = randomUUID();
  const suppliedKey = String(body.idempotencyKey || '').trim();
  const idempotencyKey = suppliedKey || `gitea:${actor.sub}:${toHashHex(canonicalJson({ consumerId, action, target, declaration: declaration.value }))}`;
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
    metadata: { requestId, consumerId, submittedAt: new Date().toISOString(), payloadDigest: `sha256:${declaration.digest}` },
    spec: { action: action.toLowerCase(), target, reason, desiredState: declaration.value },
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
    return {
      accepted: true, requestId, status: 'authorized', branch,
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
  await restRequest('rpc/record_change_commit', { method: 'POST', body: { p_request_id: execution.request_id, p_git_repo: repository, p_git_ref: GITEA_DEFAULT_BRANCH, p_git_commit_sha: mergeRevision } });
  await restRequest('change_execution', { method: 'PATCH', query: `request_id=eq.${encodeURIComponent(execution.request_id)}`, body: { merge_revision: mergeRevision, updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
  await restRequest('rpc/queue_change_reconcile', { method: 'POST', body: { p_request_id: execution.request_id, p_reconciler: execution.reconciler || GITEA_RECONCILER_NAME } });
  await patchWebhookReceipt(deliveryId, { request_id: execution.request_id, disposition: 'accepted', error_code: null });
  return { duplicate: false, accepted: true, requestId: execution.request_id, status: 'committed' };
}

async function recordReconcileReceipt(req, body) {
  if (!RECONCILER_RECEIPT_TOKEN || !safeEqual(req.headers['x-opensphere-reconciler-token'], RECONCILER_RECEIPT_TOKEN)) throw { code: 401, msg: 'invalid reconciler credential' };
  const requestId = uuid(body.requestId);
  const operationId = String(body.operationId || '').trim();
  const reconciler = String(body.reconciler || GITEA_RECONCILER_NAME).trim();
  const result = String(body.result || '').trim();
  if (!operationId || operationId.length > 255 || !reconciler || reconciler.length > 255 || !result || result.length > 2000 || typeof body.succeeded !== 'boolean') throw { code: 400, msg: 'invalid reconcile receipt' };
  const evidence = body.evidence && typeof body.evidence === 'object' && !Array.isArray(body.evidence) ? validateDeclaration(body.evidence, 'evidence').value : {};
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

  const actorRoles = new Set((await getOperatorRolesByUser(operator.user_id).then((rows) => rows.map((r) => r.role_id))));
  if (op === 'add') {
    if (actorRoles.has(finalRoleId) && op !== 'remove') {
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
    if (actor.user_id === operator.user_id && roleCode === SUPABASE_BACKEND_ROLE) {
      throw { code: 403, msg: 'admin self-removal is blocked' };
    }
    await restRequest('operator_role', {
      method: 'DELETE',
      query: `user_id=eq.${userId}&role_id=eq.${finalRoleId}`,
      prefer: 'return=minimal',
    });
    return logAudit(actor, `group-${op}`, `${userId}:${finalRoleId}`, 'ok', reason, { requestId: opId, phase: 'applied', targetType: 'console-identity-role' });
  }
  throw { code: 400, msg: 'unsupported operation (add|remove)' };
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
  const rows = await restRequest('api_token', { query: `select=id,label,status,expires_at,created_at,last_used_at,revoked_at&owner_id=eq.${encodeURIComponent(actor.sub)}&order=created_at.desc` });
  return { pats: Array.isArray(rows) ? rows.map((row) => ({ jti: row.id, label: row.label, status: row.status, expiresAt: row.expires_at, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at, scope: 'console-admin' })) : [] };
}

async function cliTokenCreate(actor, body) {
  const label = cliLabel(body?.label);
  const reason = managementReason(body?.reason);
  if (!reason) throw { code: 400, msg: 'reason must be at least 8 characters' };
  const operator = await getOperatorById(actor.sub);
  const expiresAt = new Date(Date.now() + CLI_PAT_TTL_SEC * 1000).toISOString();
  const id = randomUUID();
  const token = cliToken({ sub: actor.sub, jti: id, typ: 'pat', credential_revision: operator.credential_revision, exp: Math.floor(Date.parse(expiresAt) / 1000) });
  await restRequest('api_token', { method: 'POST', body: [{ id, owner_id: actor.sub, label, token_hash: toHashHex(token), credential_revision: operator.credential_revision, expires_at: expiresAt }] });
  await logAudit(actor, 'cli-token-create', id, 'ok', reason, { targetType: 'console-cli-token' });
  return { token, jti: id, label, expiresAt, scope: 'console-admin' };
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
      try { const actor = await verifyAuthed(req); return json(res, 200, { active: true, subject: actor.sub, username: actor.username, groups: actor.groups, type: actor.provider === 'supabase-cli' ? 'cli' : 'browser' }); }
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
          groups: actor.groups || [],
          permissions: actor.permissions || [],
          assurance: actor.assurance,
        });
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' });
      }
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
        return json(res, 202, await submitOaaAction(actor, await readBody(req)));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'OAA action submission failed' });
      }
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

// Console Backend — Supabase-backed identity/catalo​g/kubernetes proxy core.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual, createPublicKey, verify: verifySignature } = require('crypto');
const { createSupabaseVerifier } = require('./supabase-auth');
const { enforcePatRequestScope, normalizePatScope, validatePatTTL } = require('./cli-token-policy');
const { createNotificationApi } = require('./notification-api');
const { createExternalChannelApi } = require('./external-channel-api');
const { buildRecoveryOwnerStatus, buildRecoveryPlan, normalizedRecoveryEvidence } = require('./recovery-owner');
const { normalizedEvent } = require('../notification-dispatcher/contract');
const {
  DEFAULT_DURATION: DEFAULT_SESSION_PERSISTENCE,
  SESSION_PERSISTENCE_METADATA_KEY,
  createBrowserSessionManager,
  normalizeSessionPersistence,
  sessionPersistenceFromUser,
} = require('./browser-session');
const {
  AVATAR_BUCKET,
  AVATAR_MAX_BYTES,
  AVATAR_METADATA_KEY,
  avatarObjectPath,
  avatarProjection,
  validateAvatarSelection,
  validateAvatarUpload,
} = require('./profile-avatar');
const { authorizePluginProxyRequest } = require('./plugin-proxy-auth');
const { authorizeR2d2ProxyRequest } = require('./r2d2-proxy-auth');
const { createOsShellAdmissionIssuer } = require('./os-shell-admission');
const { createOsShellCredentialExchange } = require('./os-shell-delegation');
const { validateLocalEdgeAutomationTokenClaims } = require('./local-edge-automation-token');
const { createBaselineMonitoring } = require('./baseline-monitoring');
const { createModuleOperationApi } = require('./module-operation-api');
const { createR2d2OperationApi, createRestOperationStore, createRestWorkerStore } = require('./r2d2-operation-api');
const { DurableOperationWorker } = require('./r2d2-durable-operation');
const { createR2d2RemediationApi, createRestRemediationStore } = require('./r2d2-remediation-api');
const {
  DEFAULT_INSTALLATION_CONFIG_FILE,
  moduleLifecycleRequiresRecentAal2,
  readInstallationPolicy,
} = require('./module-lifecycle-policy');
const { evaluateDataIdentityReadiness } = require('./data-identity-readiness');
const {
  FOUNDATION_BOOTSTRAP_RECONCILER,
  FOUNDATION_BOOTSTRAP_TEMPLATE_ID,
  cloneFoundationBootstrapTemplate,
} = require('./foundation-bootstrap-contract');
const {
  PLATFORM_RELEASE_CONSUMER,
  PLATFORM_RELEASE_RECONCILER,
  PLATFORM_RELEASE_TARGET,
  buildComponentReleaseLock,
  platformReleaseApprovalPolicy,
  validatePfssPublicationSubmission,
  validatePlatformReleaseDesiredState,
  validateReleaseTransition,
  releaseSummary,
} = require('./platform-release-contract');

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
const BROWSER_SESSION_ENCRYPTION_KEY = process.env.BROWSER_SESSION_ENCRYPTION_KEY || '';
const BESZEL_URL = process.env.BESZEL_URL || '';
const BESZEL_READER_EMAIL = process.env.BESZEL_READER_EMAIL || '';
const BESZEL_READER_PASSWORD = process.env.BESZEL_READER_PASSWORD || '';
const BESZEL_WEBHOOK_TOKEN = process.env.BESZEL_WEBHOOK_TOKEN || '';
const GITEA_URL = (process.env.GITEA_URL || '').replace(/\/$/, '');
const GITEA_TOKEN = process.env.GITEA_TOKEN || '';
const GITEA_REVIEW_TOKEN = process.env.GITEA_REVIEW_TOKEN || '';
const GITEA_ORGANIZATION = process.env.GITEA_ORGANIZATION || 'opensphere';
const GITEA_REPOSITORY = process.env.GITEA_REPOSITORY || 'platform-declarations';
const GITEA_DEFAULT_BRANCH = process.env.GITEA_DEFAULT_BRANCH || 'main';
const GITEA_WEBHOOK_SECRET = process.env.GITEA_WEBHOOK_SECRET || '';
const GITEA_RECONCILER_NAME = process.env.GITEA_RECONCILER_NAME || 'opensphere-declaration-reconciler';
const GITEA_RECONCILER_NAMES = new Set((process.env.GITEA_RECONCILER_NAMES
  || `${GITEA_RECONCILER_NAME},ceph-prerequisite-reconciler,${FOUNDATION_BOOTSTRAP_RECONCILER},platform-release-reconciler`)
  .split(',').map((value) => value.trim()).filter(Boolean));
const GITEA_CHANGE_REQUIRE_AAL2 = String(process.env.GITEA_CHANGE_REQUIRE_AAL2 || 'true').toLowerCase() !== 'false';
const GITEA_REQUIRE_VERIFIED_MERGE = String(process.env.GITEA_REQUIRE_VERIFIED_MERGE || 'true').toLowerCase() !== 'false';
const ARGOCD_VERIFICATION_PATH = 'platform-delivery/verification/opensphere-platform-delivery-verification.json';
const ARGOCD_VERIFICATION_CONFIRMATION = 'bootstrap argocd verification';
const RECONCILER_RECEIPT_TOKEN = process.env.RECONCILER_RECEIPT_TOKEN || '';
const GITEA_TIMEOUT_MS = Number(process.env.GITEA_TIMEOUT_MS || 3000);
const LOCAL_EDGE_AUTOMATION_SERVICE_ACCOUNT = process.env.LOCAL_EDGE_AUTOMATION_SERVICE_ACCOUNT
  || 'system:serviceaccount:opensphere-console:opensphere-local-edge-release';
const LOCAL_EDGE_AUTOMATION_AUDIENCE = process.env.LOCAL_EDGE_AUTOMATION_AUDIENCE
  || 'opensphere-local-edge-release';
const LOCAL_EDGE_AUTOMATION_ACTOR_ID = '00000000-0000-4000-8000-000000000005';
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
const R2D2_DURABLE_OPERATION_ENABLED = process.env.R2D2_DURABLE_OPERATION_ENABLED === 'true';
const R2D2_ENGINEERING_PROPOSAL_ENABLED = process.env.R2D2_ENGINEERING_PROPOSAL_ENABLED === 'true';
const R2D2_ENGINEERING_PROPOSAL_REPOSITORIES = String(process.env.R2D2_ENGINEERING_PROPOSAL_REPOSITORIES || '')
  .split(',').map((value) => value.trim()).filter(Boolean);
const R2D2_ENGINEERING_EXECUTION_ENABLED = process.env.R2D2_ENGINEERING_EXECUTION_ENABLED === 'true';
const OS_SHELL_ADMISSION_ENABLED = process.env.OS_SHELL_ADMISSION_ENABLED === 'true';
const OS_SHELL_ADMISSION_SECRET = process.env.OS_SHELL_ADMISSION_SECRET || '';
const OS_SHELL_DELEGATION_SECRET = process.env.OS_SHELL_DELEGATION_SECRET || '';
const OS_SHELL_CREDENTIAL_AUTHORITY_ENABLED = process.env.OS_SHELL_CREDENTIAL_AUTHORITY_ENABLED === 'true';
const OS_SHELL_CREDENTIAL_AUTHORITY_CERT_FILE = process.env.OS_SHELL_CREDENTIAL_AUTHORITY_CERT_FILE || '';
const OS_SHELL_CREDENTIAL_AUTHORITY_KEY_FILE = process.env.OS_SHELL_CREDENTIAL_AUTHORITY_KEY_FILE || '';
const R2D2_OPERATION_WORKER_ID = String(process.env.R2D2_OPERATION_WORKER_ID || process.env.HOSTNAME || `backend-${process.pid}`).slice(0, 128);
const R2D2_OPERATION_POLL_MS = Math.max(1000, Math.min(30000, Number(process.env.R2D2_OPERATION_POLL_MS || 3000) || 3000));
const DUPA_CONTROL_URL = (process.env.DUPA_CONTROL_URL || 'http://opensphere-console-dupa-controller.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const CLUSTER_MANAGER_URL = (process.env.CLUSTER_MANAGER_URL || 'http://cluster-manager.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const OAA_GATEWAY_URL = (process.env.OAA_GATEWAY_URL || 'http://opensphere-console-oaa-gateway.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const FOUNDATION_CONTROL_URL = (process.env.FOUNDATION_CONTROL_URL || 'http://foundation-oaa-owner.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const CONSOLE_PUBLIC_URL = (process.env.CONSOLE_PUBLIC_URL || 'https://localhost:8090').replace(/\/$/, '');
const INSTALLATION_CONFIG_FILE = process.env.INSTALLATION_CONFIG_FILE || DEFAULT_INSTALLATION_CONFIG_FILE;
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
let browserSessions = null;
let issueOsShellAdmission = null;
let exchangeOsShellCredential = null;
let baselineMonitoring = null;
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
  if (!['cli_session', 'pat', 'web_shell'].includes(claims.typ)) throw { code: 401, msg: 'unsupported CLI token type' };
  if (claims.typ === 'web_shell' && claims.exp - claims.iat > 300) throw { code: 401, msg: 'web shell credential lifetime is invalid' };
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

async function authUserRequest(pathName, {
  method = 'GET',
  body = undefined,
  token = '',
  timeoutMs = SUPABASE_TIMEOUT_MS,
  query = '',
} = {}) {
  if (!SUPABASE_AUTH_URL) throw { code: 503, msg: 'SUPABASE_AUTH_URL is required' };
  const base = SUPABASE_AUTH_URL.replace(/\/$/, '');
  const url = new URL(`${base}${pathName}`);
  if (query && typeof query === 'string' && query.trim()) {
    url.search = query.startsWith('?') ? query.slice(1) : query;
  }
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  if (!response.ok) {
    throw {
      code: response.status,
      msg: parsed.error_description || parsed.msg || parsed.message || parsed.error || `Supabase Auth ${pathName} failed`,
    };
  }
  return parsed;
}

try {
  if (verifySupabaseToken && BROWSER_SESSION_ENCRYPTION_KEY) {
    browserSessions = createBrowserSessionManager({
      restRequest,
      verifyToken: verifySupabaseToken,
      authRequest: authUserRequest,
      encryptionKey: BROWSER_SESSION_ENCRYPTION_KEY,
      publicOrigin: new URL(CONSOLE_PUBLIC_URL).origin,
    });
  } else {
    console.warn('[auth] Browser session broker is disabled: verifier or encryption key unavailable');
  }
} catch (error) {
  console.error('[auth] Browser session broker initialization failed:', error?.message || error);
}

async function ensureInfrastructureNodeBinding(candidate) {
  const rows = await restRequest('infrastructure_node_binding', {
    query: 'select=kubernetes_node_uid,kubernetes_node_name,beszel_system_id,beszel_machine_fingerprint,binding_state,first_observed_at,last_observed_at',
  });
  const byNode = (Array.isArray(rows) ? rows : []).find((row) => row.kubernetes_node_uid === candidate.kubernetesNodeUid);
  const bySystem = (Array.isArray(rows) ? rows : []).find((row) => row.beszel_system_id === candidate.beszelSystemId);
  const existing = byNode || bySystem || null;
  const exact = existing
    && existing.kubernetes_node_uid === candidate.kubernetesNodeUid
    && existing.beszel_system_id === candidate.beszelSystemId
    && existing.beszel_machine_fingerprint === candidate.beszelMachineFingerprint
    && existing.binding_state === 'verified';
  if (existing && !exact) {
    return {
      state: 'rejected',
      mode: 'durable',
      reason: byNode && bySystem && byNode !== bySystem
        ? 'node UID and monitoring system are already bound to different identities'
        : 'stored Node UID, system ID, or machine fingerprint does not match',
      kubernetesNodeUid: candidate.kubernetesNodeUid,
      beszelSystemId: candidate.beszelSystemId,
      fingerprintDigest: `sha256:${toHashHex(candidate.beszelMachineFingerprint)}`,
    };
  }
  if (exact) {
    await restRequest('infrastructure_node_binding', {
      method: 'PATCH',
      query: `kubernetes_node_uid=eq.${encodeURIComponent(candidate.kubernetesNodeUid)}`,
      body: {
        kubernetes_node_name: candidate.kubernetesNodeName,
        last_observed_at: candidate.observedAt,
      },
      prefer: 'return=minimal',
    });
  } else {
    try {
      await restRequest('infrastructure_node_binding', {
        method: 'POST',
        body: [{
          kubernetes_node_uid: candidate.kubernetesNodeUid,
          kubernetes_node_name: candidate.kubernetesNodeName,
          beszel_system_id: candidate.beszelSystemId,
          beszel_machine_fingerprint: candidate.beszelMachineFingerprint,
          binding_state: 'verified',
          first_observed_at: candidate.observedAt,
          last_observed_at: candidate.observedAt,
          metadata: { establishedBy: 'baseline-monitoring-adapter-v1', hostnameRole: 'discovery-hint-only' },
        }],
        prefer: 'return=minimal',
      });
    } catch (error) {
      // A concurrent observation may have established the same unique binding.
      // Re-evaluate once; never overwrite a conflicting identity.
      const after = await restRequest('infrastructure_node_binding', {
        query: 'select=kubernetes_node_uid,beszel_system_id,beszel_machine_fingerprint,binding_state',
      });
      const match = (Array.isArray(after) ? after : []).find((row) =>
        row.kubernetes_node_uid === candidate.kubernetesNodeUid
        && row.beszel_system_id === candidate.beszelSystemId
        && row.beszel_machine_fingerprint === candidate.beszelMachineFingerprint
        && row.binding_state === 'verified');
      if (!match) throw error;
    }
  }
  return {
    state: 'verified',
    mode: 'durable',
    kubernetesNodeUid: candidate.kubernetesNodeUid,
    beszelSystemId: candidate.beszelSystemId,
    fingerprintDigest: `sha256:${toHashHex(candidate.beszelMachineFingerprint)}`,
  };
}

baselineMonitoring = createBaselineMonitoring({
  baseUrl: BESZEL_URL,
  email: BESZEL_READER_EMAIL,
  password: BESZEL_READER_PASSWORD,
  kubernetesGet: k8sGet,
  bindingStore: { ensure: ensureInfrastructureNodeBinding },
});

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

function totpFactorsFromAuthRow(row) {
  return (Array.isArray(row?.factors) ? row.factors : [])
    .filter((factor) => factor?.id && factor.factor_type === 'totp');
}

function mfaProjectionFromAuthRow(row) {
  const totp = totpFactorsFromAuthRow(row);
  const verified = totp.filter((factor) => factor.status === 'verified');
  return {
    totpCount: totp.length,
    verifiedTotpCount: verified.length,
    status: verified.length ? 'registered' : 'enrollment-required',
  };
}

async function verifyAuthed(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
    return (await browserSessions.authenticate(req)).actor;
  }
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
    const actor = await verifySupabaseToken(match[1]);
    const delegated = browserSessions
      ? await browserSessions.actorForForwardedAccessToken(match[1], actor)
      : null;
    return delegated || actor;
  }
  const actor = await verifySupabaseToken(match[1]);
  const delegated = browserSessions
    ? await browserSessions.actorForForwardedAccessToken(match[1], actor)
    : null;
  return delegated || actor;
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
  if (claims.typ === 'web_shell') {
    const rows = await restRequest('rpc/resolve_shell_delegation', { method: 'POST', body: {
      p_session_id: claims.session_id, p_actor_id: claims.sub, p_generation: claims.generation,
      p_fencing_epoch: claims.fencing_epoch, p_permission_revision: claims.permission_revision, p_aal: claims.aal,
    } });
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].session_id !== claims.jti) throw { code: 401, msg: 'web shell session authority revoked' };
    const actor = await resolveConsoleActor(claims.sub, claims);
    return { ...actor, assurance: claims.aal, provider: 'opensphere-web-shell', browserSessionId: rows[0].browser_session_id,
      permissionRevision: claims.permission_revision, shellSessionId: claims.session_id };
  }
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

function requireRecentAal2(actor, operation = 'admin mutation') {
  const reauthenticatedAt = Date.parse(actor?.lastReauthenticatedAt || '');
  const recent = actor?.assurance === 'aal2'
    && Number.isFinite(reauthenticatedAt)
    && Date.now() - reauthenticatedAt <= 5 * 60 * 1000;
  if (!recent) {
    throw {
      code: 428,
      errorCode: 'recent_aal2_required',
      msg: `${operation} requires MFA assurance aal2 verified within the last 5 minutes`,
    };
  }
}

function assertConsoleAdminActor(actor, options = {}) {
  if (!actor.groups || !actor.groups.includes(SUPABASE_BACKEND_ROLE)) {
    throw { code: 403, msg: `requires ${SUPABASE_BACKEND_ROLE}` };
  }
  if (options.requireAal2 === true) requireRecentAal2(actor, 'admin mutation');
  return actor;
}

async function verifyConsoleAdmin(req, options = {}) {
  const requireAal2 = options.requireAal2 === true
    || (options.requireAal2 !== false && SUPABASE_REQUIRE_AAL2 && isMutationRequest(req));
  return assertConsoleAdminActor(await verifyAuthed(req), { ...options, requireAal2 });
}

async function verifyOaaIdentityOwner(req, options = {}) {
  const actor = await verifyAuthed(req);
  if (!actor.groups?.includes(SUPABASE_BACKEND_ROLE)) throw { code: 403, msg: `requires ${SUPABASE_BACKEND_ROLE}` };
  requireActorPermission(actor, 'console.identity.manage');
  // Inventory reads are permission-gated and PII-minimized. Mutations never
  // receive the optional non-MFA bootstrap exception used by the interactive
  // Console during first-install recovery.
  if (options.requireAal2 === true) requireRecentAal2(actor, 'OAA identity owner action');
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

function moduleLifecycleNeedsRecentAal2(action) {
  return moduleLifecycleRequiresRecentAal2(
    action,
    readInstallationPolicy(INSTALLATION_CONFIG_FILE),
    CONSOLE_PUBLIC_URL,
  );
}

async function authenticateModuleRequest(req, { mutation = false, action = '' } = {}) {
  let actor;
  let authorization = String(req.headers.authorization || '');
  if (authorization) {
    actor = await verifyAuthed(req);
  } else {
    if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
    const session = await browserSessions.authenticate(req);
    actor = session.actor;
    authorization = `Bearer ${session.accessToken}`;
  }
  if (!actor.groups?.includes(SUPABASE_BACKEND_ROLE)) {
    throw { code: 403, msg: `requires ${SUPABASE_BACKEND_ROLE}` };
  }
  if (mutation && moduleLifecycleNeedsRecentAal2(action)) {
    requireRecentAal2(actor, 'module lifecycle mutation');
  }
  return { actor, authorization };
}

async function clusterManagerOwnerRequest(pathName, {
  method = 'GET',
  authorization,
  body,
} = {}) {
  let response;
  try {
    response = await fetch(`${CLUSTER_MANAGER_URL}${pathName}`, {
      method,
      headers: {
        authorization,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'GET' ? 8000 : 15000),
    });
  } catch {
    throw { code: 503, errorCode: 'owner_unavailable', msg: 'Shared Observability owner unavailable' };
  }
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  if (!response.ok) {
    throw {
      code: response.status,
      errorCode: `owner_http_${response.status}`,
      msg: parsed.error || `Shared Observability owner HTTP ${response.status}`,
    };
  }
  return parsed;
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

const moduleOperationApi = createModuleOperationApi({
  restRequest,
  authenticate: authenticateModuleRequest,
  readBody,
  ownerRequest: clusterManagerOwnerRequest,
  logAudit,
});

const r2d2OperationApi = createR2d2OperationApi({
  enabled: R2D2_DURABLE_OPERATION_ENABLED,
  authenticate: async (req) => {
    let session;
    const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
    if (bearer) session = { actor: await verifyAuthed(req), accessToken: bearer };
    else {
      if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
      session = await browserSessions.authenticate(req);
    }
    const groups = new Set(session.actor?.groups || []);
    if (!groups.has(SUPABASE_BACKEND_ROLE) && !groups.has('console-admins') && !groups.has('console-operators')) {
      throw { code: 403, msg: 'R2D2 operations require Console operator permission' };
    }
    return session;
  },
  store: createRestOperationStore(restRequest),
  resolveTarget: async (action, requested, auth) => {
    if (action === 'create-postgres-cluster') {
      let response;
      try {
        response = await fetch(`${FOUNDATION_CONTROL_URL}/api/foundation/oaa/postgres/plan`, {
          method: 'POST', headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(requested || {}), signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw { code: 503, msg: 'PFSS PostgreSQL plan authority unavailable' };
      }
      const ownerPlan = await response.json().catch(() => ({}));
      if (!response.ok) throw { code: response.status, msg: ownerPlan.error || 'PFSS PostgreSQL plan rejected' };
      const namespace = String(requested?.namespace || '');
      const name = String(requested?.name || '');
      const targetRevision = String(ownerPlan.targetRevision || '');
      const prospectiveUid = `pending:${createHash('sha256').update(`${namespace}/${name}:${targetRevision}`).digest('hex')}`;
      return {
        kind: 'FoundationClaim', namespace, name,
        uid: String(ownerPlan.resource?.uid || prospectiveUid), generation: Number(ownerPlan.resource?.generation || 0),
        resourceVersion: targetRevision, request: JSON.parse(JSON.stringify(requested || {})),
      };
    }
    const targetByAction = {
      'restart-workload': { kind: 'Deployment', namespace: requested.namespace, name: requested.name },
      'scale-workload': { kind: 'Deployment', namespace: requested.namespace, name: requested.name, replicas: requested.replicas },
      'rollback-image': { kind: 'Deployment', namespace: requested.namespace, name: requested.name,
        container: requested.container, image: requested.image,
        digest: String(requested.image || '').match(/@(sha256:[0-9a-f]{64})$/)?.[1] || requested.digest },
      'run-cronjob': { kind: 'CronJob', namespace: requested.namespace, name: requested.name },
      'owner-recover': { kind: 'Capability', namespace: '', name: requested.name || requested.id },
      'retry-delivery': { kind: 'NotificationDelivery', namespace: '', name: requested.name || requested.deliveryId },
    };
    const candidate = targetByAction[action];
    if (!candidate) throw { code: 400, msg: 'unsupported durable operation action' };
    const live = await durableAuthorityRead(candidate, auth.accessToken);
    if (!live?.fresh || !live?.snapshotComplete || !live?.uid) throw { code: 409, msg: 'exact live target could not be resolved' };
    return {
      ...candidate,
      uid: live.uid,
      generation: live.generation ?? null,
      resourceVersion: live.resourceVersion ?? null,
      desiredRevision: live.desiredRevision ?? null,
    };
  },
});

const r2d2RemediationApi = createR2d2RemediationApi({
  proposalEnabled: R2D2_ENGINEERING_PROPOSAL_ENABLED,
  proposalRepositories: R2D2_ENGINEERING_PROPOSAL_REPOSITORIES,
  executionEnabled: R2D2_ENGINEERING_EXECUTION_ENABLED,
  authenticate: async (req) => {
    if (!browserSessions) throw { code: 503, msg: 'managed browser session broker unavailable' };
    const session = await browserSessions.authenticate(req);
    assertConsoleAdminActor(session.actor, { requireAal2: true });
    return session;
  },
  store: createRestRemediationStore(restRequest),
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

async function insertNotificationEvent(req, body) {
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

async function publishNotificationEvent(req, body) {
  const supplied = String(req.headers['x-opensphere-notification-token'] || '');
  if (!NOTIFICATION_EVENT_TOKEN || !safeEqual(supplied, NOTIFICATION_EVENT_TOKEN)) throw { code: 401, msg: 'notification producer authentication failed' };
  return insertNotificationEvent(req, body);
}

async function publishBeszelNotificationEvent(req, body) {
  const supplied = String(req.headers['x-opensphere-beszel-token'] || '');
  if (!BESZEL_WEBHOOK_TOKEN || !safeEqual(supplied, BESZEL_WEBHOOK_TOKEN)) {
    throw { code: 401, msg: 'Beszel alert producer authentication failed' };
  }
  const title = String(body?.title || 'Infrastructure monitoring alert').trim().slice(0, 240);
  const message = String(body?.message || '').trim().slice(0, 4000);
  const transition = /\b(resolved|recovered|recovery|restored|up)\b/i.test(`${title} ${message}`)
    ? 'resolved'
    : 'triggered';
  const observedAt = new Date().toISOString();
  const minuteBucket = observedAt.slice(0, 16);
  const sourceId = toHashHex(`${title}\n${message}\n${transition}\n${minuteBucket}`);
  return insertNotificationEvent(req, {
    sourceType: 'baseline-monitoring',
    sourceId: `beszel:${sourceId}`,
    source: 'Infrastructure Monitoring',
    category: 'node',
    severity: transition === 'resolved' ? 'success' : 'warning',
    title,
    body: message,
    route: '/manage/infrastructure-monitoring?tab=alerts',
    labels: {
      provider: 'beszel',
      transition,
      contract: 'generic-webhook-v1',
    },
    occurredAt: observedAt,
  });
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
  const hisPreflight = prerequisites.find((item) => item.key === 'his-preflight');
  if (!clusterManager?.ready || !hisPreflight?.ready) throw { code: 409, msg: 'OAA mutations require Cluster Manager Activated and HIS Preflight Ready' };
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

async function resolveDurableExecutionSession(sessionId, actorId) {
  const browser = browserSessions
    ? await browserSessions.resolveForDurableExecution(sessionId, actorId)
    : { active: false, code: 'BrowserSessionUnavailable' };
  if (browser.active) {
    if (!browser.permissions?.includes('oaa.action.execute.high')) {
      try {
        const actor = await resolveConsoleActor(actorId, { credential_revision: browser.authzRevision });
        if (actor.groups.includes(SUPABASE_BACKEND_ROLE) || actor.groups.includes('console-admins')) {
          browser.permissions = [...new Set([...(browser.permissions || []), 'oaa.action.execute.high', 'console.notification.manage'])];
        }
      } catch { return { active: false, actorId, code: 'AuthorizationAuthorityUnavailable' }; }
    }
    return browser;
  }
  const rows = await restRequest('cli_session', {
    query: `select=id,owner_id,device_id,credential_revision,status,expires_at&id=eq.${encodeURIComponent(sessionId)}&owner_id=eq.${encodeURIComponent(actorId)}&limit=1`,
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || row.status !== 'active' || Date.parse(row.expires_at) <= Date.now()) {
    return { active: false, actorId, code: 'SessionInactive' };
  }
  let actor;
  try {
    actor = await resolveConsoleActor(actorId, { jti: row.id, typ: 'cli_session', device_id: row.device_id,
      credential_revision: row.credential_revision });
  } catch {
    return { active: false, actorId, code: 'AuthorizationAuthorityUnavailable' };
  }
  const expiry = Math.min(Math.floor(Date.parse(row.expires_at) / 1000), Math.floor(Date.now() / 1000) + 300);
  const accessToken = cliToken({ sub: actorId, jti: row.id, typ: 'cli_session', device_id: row.device_id,
    credential_revision: row.credential_revision, exp: expiry });
  const permissions = actor.groups.includes(SUPABASE_BACKEND_ROLE) || actor.groups.includes('console-admins')
    ? ['oaa.action.execute.high', 'console.notification.manage'] : [];
  return { active: true, actorId, assurance: 'aal1', permissions,
    authzRevision: String(row.credential_revision), accessToken, lastReauthenticatedAt: null };
}

async function durableAuthorityRead(target, accessToken) {
  if (target.kind === 'FoundationClaim' && target.request) {
    try {
      const response = await fetch(`${FOUNDATION_CONTROL_URL}/api/foundation/oaa/postgres/plan`, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(target.request), signal: AbortSignal.timeout(15000),
      });
      const ownerPlan = await response.json().catch(() => ({}));
      if (!response.ok) return { fresh: false, snapshotComplete: false };
      const targetRevision = String(ownerPlan.targetRevision || '');
      const prospectiveUid = `pending:${createHash('sha256').update(`${target.namespace}/${target.name}:${targetRevision}`).digest('hex')}`;
      return { ...target, fresh: true, snapshotComplete: true,
        uid: String(ownerPlan.resource?.uid || prospectiveUid), generation: Number(ownerPlan.resource?.generation || 0),
        resourceVersion: targetRevision, _resource: ownerPlan.resource || null };
    } catch { return { fresh: false, snapshotComplete: false }; }
  }
  if (target.kind === 'NotificationDelivery') {
    const rows = await restRequest('notification_delivery', { query: `select=id,status,attempt_count,updated_at&id=eq.${encodeURIComponent(target.name)}&limit=1` });
    const row = rows?.[0];
    return row ? { ...target, fresh: true, snapshotComplete: true, uid: row.id, resourceVersion: row.updated_at, _resource: row } : { fresh: true, snapshotComplete: true, uid: '' };
  }
  if (target.kind === 'Capability') {
    try {
      const response = await fetch(`${OAA_GATEWAY_URL}/api/oaa/durable/owner/status`, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: target.name }), signal: AbortSignal.timeout(8000),
      });
      const status = await response.json().catch(() => ({}));
      if (!response.ok) return { fresh: false, snapshotComplete: false };
      return { ...target, fresh: true, snapshotComplete: true, uid: status.uid,
        desiredRevision: status.desiredRevision, _resource: status };
    } catch { return { fresh: false, snapshotComplete: false }; }
  }
  let response;
  try {
    response = await fetch(`${OAA_GATEWAY_URL}/api/oaa/tools/k8s/resource`, {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: String(target.kind || '').toLowerCase(), namespace: target.namespace, name: target.name }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { return { fresh: false, snapshotComplete: false }; }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.resource) return { fresh: false, snapshotComplete: false };
  const resource = body.resource;
  return {
    uid: resource.metadata?.uid || '', generation: resource.metadata?.generation ?? null,
    resourceVersion: resource.metadata?.resourceVersion || null, desiredRevision: target.desiredRevision || null,
    fresh: true, snapshotComplete: true, _resource: resource,
  };
}

const DURABLE_TOOL_MAP = Object.freeze({
  'owner.workload.restart': { toolId: 'oaa.k8s.workload.restart', action: 'apply' },
  'owner.workload.scale': { toolId: 'oaa.k8s.workload.scale', action: 'apply' },
  'owner.release.rollback': { toolId: 'oaa.k8s.workload.rollback-image', action: 'rollback' },
  'owner.cronjob.run-once': { toolId: 'oaa.k8s.cronjob.run', action: 'apply' },
});

async function durableOwnerInvoke(_route, payload, accessToken) {
  const actor = await verifyAuthed({ method: 'POST', headers: { authorization: `Bearer ${accessToken}` } });
  if (payload.toolId === 'owner.foundation.postgres.create') {
    requireActorPermission(actor, 'oaa.action.execute.high');
    let response;
    try {
      response = await fetch(`${FOUNDATION_CONTROL_URL}/api/foundation/oaa/postgres/apply`, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
          'x-idempotency-key': payload.idempotencyKey },
        body: JSON.stringify({ ...(payload.target.request || {}), reason: payload.reason, confirm: payload.confirmation }),
        signal: AbortSignal.timeout(120000),
      });
    } catch (cause) {
      throw Object.assign(new Error('PFSS PostgreSQL owner outcome is ambiguous'), { code: 'OwnerOutcomeAmbiguous', ambiguous: true, cause });
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || 'PFSS PostgreSQL owner rejected execution'), { code: result.code || `OwnerHttp${response.status}` });
    return { ...result, idempotencyKey: payload.idempotencyKey };
  }
  if (payload.toolId === 'owner.notification.retry') {
    requireActorPermission(actor, 'console.notification.manage');
    try {
      await notificationApi.retryDelivery(actor, payload.target.name, { reason: payload.reason });
      return { operationId: payload.idempotencyKey, idempotencyKey: payload.idempotencyKey, status: 'queued', owner: 'console-notification' };
    } catch (error) {
      if (Number(error?.code) >= 500) error.ambiguous = true;
      throw error;
    }
  }
  if (payload.toolId === 'owner.recovery.execute') {
    let response;
    try {
      response = await fetch(`${OAA_GATEWAY_URL}/api/oaa/durable/owner/recover`, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: payload.target.name, reason: payload.reason, confirmation: payload.confirmation, idempotencyKey: payload.idempotencyKey }),
        signal: AbortSignal.timeout(120000),
      });
    } catch (cause) {
      throw Object.assign(new Error('owner recovery outcome is ambiguous'), { code: 'OwnerOutcomeAmbiguous', ambiguous: true, cause });
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || result.message || 'owner recovery failed'), { code: result.code || `OwnerHttp${response.status}` });
    return { ...result, idempotencyKey: payload.idempotencyKey };
  }
  const mapping = DURABLE_TOOL_MAP[payload.toolId];
  if (!mapping) throw Object.assign(new Error('owner tool is not registered'), { code: 'OwnerToolNotRegistered' });
  requireActorPermission(actor, 'oaa.action.execute.high');
  await requireOaaLifecycleGate(`Bearer ${accessToken}`);
  const target = payload.target;
  const inputs = { kind: String(target.kind).toLowerCase(), namespace: target.namespace, name: target.name,
    targetUid: target.uid, targetGeneration: target.generation, targetResourceVersion: target.resourceVersion,
    confirm: payload.confirmation };
  if (payload.toolId === 'owner.workload.scale') inputs.replicas = target.replicas;
  if (payload.toolId === 'owner.release.rollback') { inputs.container = target.container; inputs.image = target.image; }
  let proposal;
  try {
    proposal = await governedChange(actor, {
      consumerId: 'oaa-gateway', action: mapping.action, target: `${inputs.kind}:${target.namespace}/${target.name}`,
      reason: payload.reason, desiredState: { toolId: mapping.toolId, target: `${inputs.kind}:${target.namespace}/${target.name}`,
        inputs, durableOperationId: payload.operationId, requiredPermission: 'oaa.action.execute.high' },
      idempotencyKey: payload.idempotencyKey,
    });
  } catch (error) {
    if (Number(error?.code) >= 500) error.ambiguous = true;
    throw error;
  }
  return { operationId: proposal.requestId, status: proposal.status, duplicate: proposal.duplicate === true,
    pullRequest: proposal.pullRequest || null, desiredRevision: proposal.desiredRevision || null,
    idempotencyKey: payload.idempotencyKey };
}

async function durableOwnerReconcile(route, downstreamKey, target = {}, accessToken = '') {
  if (route === 'foundation/postgres') {
    try {
      const response = await fetch(`${FOUNDATION_CONTROL_URL}/api/foundation/oaa/postgres/claims/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.name)}`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(10000),
      });
      const status = await response.json().catch(() => ({}));
      return response.ok ? { operationId: downstreamKey, status: status.stage || 'observed', evidence: status, idempotencyKey: downstreamKey } : null;
    } catch { return null; }
  }
  if (route === 'owner/notifications') {
    const rows = await restRequest('notification_delivery', { query: `select=id,status,attempt_count,updated_at&id=eq.${encodeURIComponent(target.name)}&limit=1` });
    return rows?.[0] ? { operationId: downstreamKey, status: rows[0].status, evidence: rows[0], idempotencyKey: downstreamKey } : null;
  }
  if (route === 'cluster-manager/his') {
    try {
      const response = await fetch(`${OAA_GATEWAY_URL}/api/oaa/durable/owner/status`, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: target.name }), signal: AbortSignal.timeout(8000),
      });
      const status = await response.json().catch(() => ({}));
      return response.ok ? { operationId: downstreamKey, status: status.state || 'observed', evidence: status, idempotencyKey: downstreamKey } : null;
    } catch { return null; }
  }
  const rows = await restRequest('change_request', { query: `select=request_id,status,k8s_operation_id,completed_at&idempotency_key=eq.${encodeURIComponent(downstreamKey)}&limit=1` });
  if (!rows?.[0]) return null;
  const receipts = await restRequest('reconcile_receipt', { query: `select=operation_id,request_id,succeeded,result,evidence,received_at&request_id=eq.${encodeURIComponent(rows[0].request_id)}&order=received_at.desc&limit=1` });
  return { operationId: rows[0].request_id, status: rows[0].status, downstreamOperationId: rows[0].k8s_operation_id,
    receipt: receipts?.[0] || null, evidence: receipts?.[0]?.evidence || null, idempotencyKey: downstreamKey };
}

const durableDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function durableGatewayPost(path, payload, accessToken, timeoutMs = 8000) {
  try {
    const response = await fetch(`${OAA_GATEWAY_URL}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    return response.ok ? body : null;
  } catch { return null; }
}

async function durableVerify(verifierId, target, receipt, accessToken) {
  const deadline = Date.now() + 90000;
  if (verifierId === 'owner.foundation.postgres.ready') {
    const postgresDeadline = Date.now() + 9 * 60 * 1000;
    let last = null;
    while (Date.now() < postgresDeadline) {
      last = await durableOwnerReconcile('foundation/postgres', receipt?.idempotencyKey || '', target, accessToken);
      const evidence = last?.evidence || {};
      if (evidence.ready === true && evidence.stage === 'Ready'
          && evidence.foundationClaim?.observedGeneration === evidence.foundationClaim?.generation
          && evidence.postgresClaim?.observedGeneration === evidence.postgresClaim?.generation) {
        return { status: 'succeeded', observed: { stage: 'Ready', foundationClaim: evidence.foundationClaim,
          postgresClaim: evidence.postgresClaim, credentialProjection: 'secretRef-only' } };
      }
      if (evidence.foundationClaim?.phase === 'Failed' || evidence.postgresClaim?.phase === 'Failed') {
        return { status: 'failed', observed: { code: 'PFSSPostgresProvisioningFailed', stage: evidence.stage,
          owner: 'PFSS', foundationClaim: evidence.foundationClaim, postgresClaim: evidence.postgresClaim } };
      }
      await durableDelay(3000);
    }
    return { status: 'inconclusive', observed: { code: 'PFSSPostgresStillProvisioning', owner: 'PFSS',
      stage: last?.evidence?.stage || 'Unknown' } };
  }
  if (['authority.workload.rollout','authority.release.exact-digest','authority.job.completed'].includes(verifierId) && receipt?.idempotencyKey) {
    let reconciled = receipt;
    while (Date.now() < deadline) {
      reconciled = await durableOwnerReconcile('cluster-manager/workloads', receipt.idempotencyKey, target, accessToken) || reconciled;
      if (reconciled?.receipt) break;
      await durableDelay(1500);
    }
    if (!reconciled?.receipt) return { status: 'inconclusive', observed: { code: 'OwnerReceiptPending' } };
    if (reconciled.receipt.succeeded !== true) return { status: 'failed', observed: { code: 'OwnerReconcileFailed', result: reconciled.receipt.result } };
    receipt = reconciled;
  }
  if (verifierId === 'authority.release.exact-digest') {
    while (Date.now() < deadline) {
      const rollout = await durableGatewayPost('/api/oaa/tools/k8s/rollout', { namespace: target.namespace, name: target.name }, accessToken);
      const imageIds = (rollout?.pods || []).flatMap((pod) => pod.containers || [])
        .filter((container) => container.name === target.container).map((container) => container.imageID || '');
      const exactIds = imageIds.length > 0 && imageIds.every((imageId) => imageId.endsWith(`@${target.digest}`) || imageId.endsWith(target.digest));
      if (rollout?.complete && exactIds) return { status: 'succeeded', observed: { complete: true, imageIds: imageIds.map((value) => value.slice(-80)) } };
      await durableDelay(1500);
    }
    return { status: 'failed', observed: { code: 'ExactDigestRolloutNotConverged' } };
  }
  if (verifierId === 'authority.job.completed') {
    const jobName = receipt?.evidence?.name;
    if (!jobName) return { status: 'inconclusive', observed: { code: 'JobReceiptMissing' } };
    while (Date.now() < deadline) {
      const body = await durableGatewayPost('/api/oaa/tools/k8s/resource', { kind: 'job', namespace: target.namespace, name: jobName }, accessToken);
      const job = body?.resource;
      if (Number(job?.succeeded || 0) >= Number(job?.completions || 1)) return { status: 'succeeded', observed: { job: jobName, completionTime: job.completionTime || null } };
      if (Number(job?.failed || 0) > 0) return { status: 'failed', observed: { job: jobName, failed: job.failed } };
      await durableDelay(1500);
    }
    return { status: 'failed', observed: { code: 'JobCompletionTimeout', job: jobName } };
  }
  const live = await durableAuthorityRead(target, accessToken);
  if (!live.fresh) return { status: 'inconclusive', observed: { code: 'AuthorityUnavailable' } };
  const resource = live._resource || {};
  if (verifierId === 'authority.workload.rollout') {
    const desired = Number(resource.desired || 0); const ready = Number(resource.ready || 0);
    const observed = Number(resource.observedGeneration || 0);
    return { status: live.generation > Number(target.generation || 0) && observed >= Number(live.generation || 0) && ready >= desired ? 'succeeded' : 'failed', observed: { generation: live.generation, observedGeneration: observed, desired, ready } };
  }
  if (verifierId === 'authority.workload.replicas') {
    const desired = Number(resource.desired); const ready = Number(resource.ready || 0);
    const observed = Number(resource.observedGeneration || 0);
    return { status: desired === Number(target.replicas) && ready === desired && observed >= Number(live.generation || 0) ? 'succeeded' : 'failed', observed: { desired, ready, observedGeneration: observed } };
  }
  if (verifierId === 'owner.notification.delivery') {
    let current = resource;
    while (Date.now() < deadline) {
      if (['accepted','delivered'].includes(current.status)) return { status: 'succeeded', observed: { status: current.status, attempts: current.attempt_count || 0 } };
      if (['failed','dead-letter','suppressed'].includes(current.status)) return { status: 'failed', observed: { status: current.status, attempts: current.attempt_count || 0 } };
      await durableDelay(1500);
      current = (await durableAuthorityRead(target, accessToken))._resource || {};
    }
    return { status: 'inconclusive', observed: { code: 'DeliveryStillPending', status: current.status || null, attempts: current.attempt_count || 0 } };
  }
  if (verifierId === 'owner.recovery.postcondition') {
    let current = resource;
    while (Date.now() < deadline) {
      const state = String(current.state || '').toLowerCase();
      if (['ready','deployed','healthy'].includes(state)) return { status: 'succeeded', observed: { state: current.state } };
      if (['failed','blocked','degraded'].includes(state)) return { status: 'failed', observed: { state: current.state } };
      await durableDelay(1500);
      current = (await durableAuthorityRead(target, accessToken))._resource || {};
    }
    return { status: 'inconclusive', observed: { code: 'OwnerRecoveryStillPending', state: current.state || 'Unknown' } };
  }
  return { status: 'inconclusive', observed: { code: 'VerifierNotRegistered', receipt: Boolean(receipt) } };
}

let r2d2OperationTimer = null;
let r2d2OperationLoopBusy = false;
function startR2d2OperationWorker() {
  if (!R2D2_DURABLE_OPERATION_ENABLED || r2d2OperationTimer) return;
  const claimEpoch = Date.now();
  const store = createRestWorkerStore(restRequest, R2D2_OPERATION_WORKER_ID, claimEpoch);
  const worker = new DurableOperationWorker({
    workerId: R2D2_OPERATION_WORKER_ID, store,
    sessions: { resolve: resolveDurableExecutionSession },
    authority: { read: durableAuthorityRead },
    owners: { invoke: durableOwnerInvoke, reconcile: durableOwnerReconcile },
    verifiers: { verify: durableVerify },
  });
  const poll = async () => {
    if (r2d2OperationLoopBusy) return; r2d2OperationLoopBusy = true;
    try { for (const operation of await store.claim(5)) await worker.process(operation); }
    catch (error) { console.warn('[r2d2-operation-worker]', error.message || error); }
    finally { r2d2OperationLoopBusy = false; }
  };
  r2d2OperationTimer = setInterval(() => { void poll(); }, R2D2_OPERATION_POLL_MS);
  r2d2OperationTimer.unref(); void poll();
}

async function requireSupabase() {
  const readiness = await evaluateDataIdentityReadiness({
    readDataAuthority: () => restRequest('operator', {
      query: 'select=user_id&limit=1',
      prefer: 'count=exact',
    }),
    authUrl: SUPABASE_AUTH_URL,
    storageUrl: SUPABASE_STORAGE_URL,
    timeoutMs: SUPABASE_TIMEOUT_MS,
  });
  if (!readiness.ready) {
    throw { code: 503, msg: 'Supabase data and identity authority unavailable', readiness };
  }
  return { ...readiness, service: 'supabase-data-identity', source: 'supabase', version: VERSION };
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
  const [rows, executionRows, outboxRows, approvalRows, operatorRows] = await Promise.all([
    restRequest('change_request', {
    query: 'select=request_id,actor_id,actor_type,action,target,reason,status,git_repo,git_ref,git_commit_sha,k8s_operation_id,created_at,completed_at&order=created_at.desc&limit=50',
    }),
    restRequest('change_execution', { query: 'select=request_id,branch,pull_number,pull_url,desired_revision,merge_revision,reconciler,reconciler_status,drift_status,attempt_count,last_error,updated_at' }),
    restRequest('change_outbox', { query: 'select=request_id,status,attempts,next_attempt_at,last_error,updated_at' }),
    restRequest('change_approval', { query: 'select=request_id,approver_id,status,gitea_review_id,created_at,completed_at,error_code&order=created_at.asc' }),
    restRequest('operator', { query: 'select=user_id,display_name' }),
  ]);
  const execution = new Map((Array.isArray(executionRows) ? executionRows : []).map((row) => [row.request_id, row]));
  const outbox = new Map((Array.isArray(outboxRows) ? outboxRows : []).map((row) => [row.request_id, row]));
  const operators = new Map((Array.isArray(operatorRows) ? operatorRows : []).map((row) => [row.user_id, row.display_name || row.user_id]));
  const approvals = new Map();
  for (const approval of (Array.isArray(approvalRows) ? approvalRows : [])) {
    const list = approvals.get(approval.request_id) || [];
    list.push({ ...approval, approver_display_name: operators.get(approval.approver_id) || approval.approver_id }); approvals.set(approval.request_id, list);
  }
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const requestApprovals = approvals.get(row.request_id) || [];
    const ownerMfaAuthorized = row.target === PLATFORM_RELEASE_TARGET
      && requestApprovals.some((approval) => approval.approver_id === row.actor_id);
    return {
      ...row,
      approvalPolicy: ownerMfaAuthorized ? 'owner-mfa' : 'cross-operator',
      requester: { id: row.actor_id, type: row.actor_type, displayName: operators.get(row.actor_id) || row.actor_id },
      execution: execution.get(row.request_id) || null,
      outbox: outbox.get(row.request_id) || null,
      approvals: requestApprovals,
    };
  });
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
      repositories: [], contracts, receipts, changes, byStatus, recovery, supplyChain: null, reason: 'GITEA_URL is not configured for State Change Authority',
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

function argocdVerificationManifest() {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'opensphere-platform-delivery-verification',
      namespace: 'opensphere-platform-delivery',
      labels: {
        'app.kubernetes.io/name': 'opensphere-platform-delivery-verification',
        'app.kubernetes.io/part-of': 'opensphere-platform-delivery',
        'app.kubernetes.io/managed-by': 'argocd',
        'opensphere.io/capability': 'delivery.gitops',
      },
      annotations: {
        'opensphere.io/contract': 'delivery.gitops/v1',
        'opensphere.io/verification-purpose': 'argocd-repository-sync',
      },
    },
    data: {
      contract: 'delivery.gitops/v1',
      repository: 'opensphere/platform-declarations',
      path: 'platform-delivery/verification',
    },
  };
}

async function bootstrapArgocdVerification(actor, input = {}) {
  requireActorPermission(actor, 'console.git.change');
  if (GITEA_CHANGE_REQUIRE_AAL2 && actor.assurance !== 'aal2') throw { code: 403, msg: 'Argo CD verification bootstrap requires MFA assurance aal2' };
  if (!GITEA_TOKEN || !GITEA_REVIEW_TOKEN) throw { code: 503, msg: 'Gitea control and review credentials are not configured' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw { code: 400, msg: 'JSON object required' };
  const extra = Object.keys(input).filter((key) => !['reason', 'confirm'].includes(key));
  if (extra.length) throw { code: 400, msg: `unsupported Argo CD verification inputs: ${extra.join(', ')}` };
  const reason = managementReason(input.reason);
  if (!reason) throw { code: 400, msg: 'management reason must be at least 8 characters' };
  if (String(input.confirm || '').trim() !== ARGOCD_VERIFICATION_CONFIRMATION) {
    throw { code: 409, msg: `confirmation must exactly equal: ${ARGOCD_VERIFICATION_CONFIRMATION}` };
  }
  const manifest = argocdVerificationManifest();
  const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
  const contentsPath = `/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/contents/${giteaEncodedPath(ARGOCD_VERIFICATION_PATH)}`;
  let existing = null;
  try {
    existing = await giteaRequest(`${contentsPath}?ref=${encodeURIComponent(GITEA_DEFAULT_BRANCH)}`);
  } catch (error) {
    if (error?.code !== 404) throw error;
  }
  if (existing?.body?.content) {
    let current = '';
    try { current = Buffer.from(String(existing.body.content).replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { current = ''; }
    try {
      if (canonicalJson(JSON.parse(current)) === canonicalJson(manifest)) {
        const branch = await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/branches/${encodeURIComponent(GITEA_DEFAULT_BRANCH)}`);
        const revision = String(branch.body?.commit?.id || branch.body?.commit?.sha || '').toLowerCase();
        await logAudit(actor, 'argocd-verification-bootstrap', ARGOCD_VERIFICATION_PATH, 'ok-noop', reason, {
          requestId: randomUUID(),
          phase: 'applied',
          targetType: 'gitea-fixed-declaration',
          payloadDigest: toHashHex(rendered),
        });
        return { ready: true, changed: false, path: ARGOCD_VERIFICATION_PATH, mergeRevision: revision || null };
      }
    } catch {
      // A malformed or drifted fixed declaration is replaced only through the
      // same reviewed branch path below; it is never patched directly on main.
    }
  }

  const requestId = randomUUID();
  const branch = `bootstrap/argocd-verification-${requestId.slice(0, 8)}`;
  const title = '[Console] Bootstrap Argo CD verification declaration';
  await logAudit(actor, 'argocd-verification-bootstrap', ARGOCD_VERIFICATION_PATH, 'attempt', reason, {
    requestId,
    phase: 'intent',
    targetType: 'gitea-fixed-declaration',
    payloadDigest: toHashHex(rendered),
  });
  try {
    const file = await giteaRequest(contentsPath, {
      method: existing ? 'PUT' : 'POST',
      body: {
        branch: GITEA_DEFAULT_BRANCH,
        new_branch: branch,
        message: `${title} (${requestId})`,
        content: Buffer.from(rendered).toString('base64'),
        ...(existing?.body?.sha ? { sha: existing.body.sha } : {}),
      },
    });
    const desiredRevision = String(file.body?.commit?.sha || '').toLowerCase();
    const pull = await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/pulls`, {
      method: 'POST',
      body: {
        title,
        head: branch,
        base: GITEA_DEFAULT_BRANCH,
        body: `Fixed Console bootstrap contract ${requestId}.\n\nReason: ${reason}`,
      },
    });
    const pullNumber = Number(pull.body?.number || 0);
    if (!Number.isInteger(pullNumber) || pullNumber < 1) throw { code: 502, msg: 'Gitea did not return a pull request number' };
    await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/pulls/${pullNumber}/reviews`, {
      method: 'POST',
      authToken: GITEA_REVIEW_TOKEN,
      body: {
        event: 'APPROVED',
        body: `Approved fixed OpenSphere bootstrap contract ${requestId}; no operator-supplied manifest or path is accepted.`,
      },
    });
    await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/pulls/${pullNumber}/merge`, {
      method: 'POST',
      body: { Do: 'merge', delete_branch_after_merge: false },
    });
    const mergedPull = await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/pulls/${pullNumber}`);
    const merged = mergedPull.body?.state === 'closed' && mergedPull.body?.merged === true;
    const mergeRevision = String(mergedPull.body?.merge_commit_sha || '').toLowerCase();
    if (!merged || !/^[0-9a-f]{40,64}$/.test(mergeRevision)) {
      throw { code: 502, msg: 'fixed Argo CD verification pull request was not merged' };
    }
    const verification = await assertVerifiedGovernedMerge(mergeRevision);
    await logAudit(actor, 'argocd-verification-bootstrap', ARGOCD_VERIFICATION_PATH, 'ok', reason, {
      requestId,
      phase: 'applied',
      targetType: 'gitea-fixed-declaration',
      payloadDigest: toHashHex(rendered),
    });
    return {
      ready: true,
      changed: true,
      path: ARGOCD_VERIFICATION_PATH,
      pullNumber,
      desiredRevision: desiredRevision || null,
      mergeRevision,
      verification,
    };
  } catch (error) {
    await logAudit(actor, 'argocd-verification-bootstrap', ARGOCD_VERIFICATION_PATH, 'failed', reason, {
      requestId,
      phase: 'failed',
      targetType: 'gitea-fixed-declaration',
      payloadDigest: toHashHex(rendered),
    }).catch(() => undefined);
    throw error;
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
      if (key === 'registryCredentialsRequired' && typeof child === 'boolean') {
        continue;
      }
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
    contract: 'opensphere.ceph.rook-prerequisite/v3',
    release: Object.freeze({
      name: 'rook-ceph',
      namespace: 'rook-ceph',
      chart: 'rook-ceph',
      version: 'v1.20.2',
      sha256: '6e0f10f5ca54e618fb90dd149dc9dfbc8a4932955bff2227b692fb32069daf52',
    }),
    runtime: Object.freeze({
      name: 'opensphere-ceph-runtime',
      namespace: 'rook-ceph',
      chart: 'opensphere-ceph-runtime',
      version: '1.4.0',
    }),
    components: Object.freeze(['crds', 'operator', 'csi', 'runtime-rbac', 'data-path-verification-runtime']),
    verification: Object.freeze([
      'cephclusters.ceph.rook.io Established',
      'all ceph-csi-operator CRDs Established',
      'deployment/rook-ceph-operator Ready',
      'deployment/ceph-csi-controller-manager Ready',
      'drivers.csi.ceph.io/rook-ceph.rbd.csi.ceph.com configured',
      'namespace/opensphere-ceph-verification Pod Security restricted',
      'role/opensphere-ceph-verification-runner installed',
      'networkpolicy/opensphere-ceph-verification-default-deny installed',
    ]),
    elevatedPrivileges: Object.freeze([]),
  }),
});

function changeTemplate(templateId) {
  if (templateId === CEPH_PREREQUISITE_TEMPLATE.id) {
    return JSON.parse(JSON.stringify(CEPH_PREREQUISITE_TEMPLATE));
  }
  if (templateId === FOUNDATION_BOOTSTRAP_TEMPLATE_ID) {
    return cloneFoundationBootstrapTemplate();
  }
  throw { code: 404, msg: 'change template not found' };
}

function changeTemplateRequestPhase(change, execution, outbox) {
  if (change?.status === 'applied' || execution?.reconciler_status === 'Applied') return 'Completed';
  if (change?.status === 'failed' || execution?.reconciler_status === 'Failed'
    || ['failed', 'dead-letter'].includes(String(outbox?.status || ''))) return 'Failed';
  if (change?.status === 'unknown' || ['Unknown', 'Drifted'].includes(String(execution?.reconciler_status || ''))) return 'NeedsAttention';
  if (execution?.reconciler_status === 'Reconciling' || outbox?.status === 'dispatching') return 'Applying';
  if (change?.status === 'committed' || execution?.reconciler_status === 'Queued' || outbox?.status === 'queued') return 'Queued';
  if (change?.status === 'authorized') return 'AwaitingApproval';
  return 'Creating';
}

function changeTemplateRequestMessage(phase) {
  return {
    Creating: '변경 요청을 기록하고 서명된 상태 선언을 준비하고 있습니다.',
    AwaitingApproval: '설치 요청이 접수되어 두 번째 운영자의 승인을 기다리고 있습니다.',
    Queued: '승인이 완료되어 전용 적용기의 작업 대기열에 등록되었습니다.',
    Applying: '전용 적용기가 Consumer Kubernetes에 선행요소를 설치하고 검증하고 있습니다.',
    Completed: '설치와 실측 검증이 완료되었습니다. Ceph 화면에서 준비상태를 다시 확인하십시오.',
    Failed: '설치 또는 검증에 실패했습니다. 오류를 확인한 후 새 변경 요청으로 재시도하십시오.',
    NeedsAttention: '변경 결과를 확정할 수 없거나 선언과 실측 상태가 일치하지 않습니다.',
  }[phase] || '변경 요청 상태를 확인하고 있습니다.';
}

async function changeTemplateRequestStatus(templateId) {
  const template = changeTemplate(templateId);
  const action = `gitea:${template.action}`;
  const payloadDigest = `sha256:${toHashHex(canonicalJson(template.desiredState))}`;
  const rows = await restRequest('change_request', {
    query: `select=request_id,action,target,reason,status,payload_digest,git_repo,git_ref,git_commit_sha,k8s_operation_id,created_at,completed_at&target=eq.${encodeURIComponent(template.target)}&action=eq.${encodeURIComponent(action)}&payload_digest=eq.${encodeURIComponent(payloadDigest)}&order=created_at.desc&limit=1`,
  });
  const change = Array.isArray(rows) ? rows[0] : null;
  if (!change) return { templateId: template.id, current: null, checkedAt: new Date().toISOString() };

  const requestId = change.request_id;
  const [executionRows, outboxRows, approvalRows] = await Promise.all([
    restRequest('change_execution', {
      query: `select=request_id,branch,pull_number,pull_url,desired_revision,merge_revision,reconciler,reconciler_status,drift_status,attempt_count,last_error,updated_at&request_id=eq.${encodeURIComponent(requestId)}`,
    }),
    restRequest('change_outbox', {
      query: `select=request_id,status,attempts,next_attempt_at,last_error,updated_at&request_id=eq.${encodeURIComponent(requestId)}`,
    }),
    restRequest('change_approval', {
      query: `select=request_id,status,created_at,completed_at,error_code&request_id=eq.${encodeURIComponent(requestId)}&order=created_at.asc`,
    }),
  ]);
  const execution = Array.isArray(executionRows) ? executionRows[0] : null;
  const outbox = Array.isArray(outboxRows) ? outboxRows[0] : null;
  const approvals = Array.isArray(approvalRows) ? approvalRows : [];
  const phase = changeTemplateRequestPhase(change, execution, outbox);
  const sourceMatch = String(change.reason || '').match(/\s\[source:([a-z0-9-]+)\]$/);
  const reason = sourceMatch ? String(change.reason).slice(0, sourceMatch.index).trim() : String(change.reason || '');
  return {
    templateId: template.id,
    current: {
      trackingAvailable: true,
      requestId,
      phase,
      status: change.status,
      message: changeTemplateRequestMessage(phase),
      reason,
      source: sourceMatch?.[1] || '',
      requestedAt: change.created_at,
      completedAt: change.completed_at,
      pullRequest: execution?.pull_number ? { number: execution.pull_number, url: execution.pull_url || null } : null,
      reconciler: execution?.reconciler || null,
      reconcilerStatus: execution?.reconciler_status || 'NotScheduled',
      outboxStatus: outbox?.status || null,
      attemptCount: Number(execution?.attempt_count || outbox?.attempts || 0),
      approvalCount: approvals.filter((approval) => approval.status === 'applied').length,
      lastError: String(execution?.last_error || outbox?.last_error || '').slice(0, 500) || null,
      checkedAt: new Date().toISOString(),
    },
    checkedAt: new Date().toISOString(),
  };
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

function parseInstalledPlatformRelease(configMap) {
  const raw = String(configMap?.data?.['release.json'] || '').trim();
  if (!raw) throw { code: 503, msg: 'managed installation lock has no release.json' };
  let lock;
  try { lock = JSON.parse(raw); }
  catch { throw { code: 503, msg: 'managed installation lock is invalid JSON' }; }
  try { return { lock, summary: releaseSummary(lock) }; }
  catch (error) { throw { code: 503, msg: `managed installation lock is invalid: ${error.message}` }; }
}

async function installedPlatformRelease() {
  const configMap = await k8sGet('/api/v1/namespaces/opensphere-console/configmaps/opensphere-installation-lock')
    .catch((error) => { throw { code: 503, msg: `managed installation lock unavailable: ${error.message}` }; });
  return parseInstalledPlatformRelease(configMap);
}

async function platformReleaseRuntimeStatus() {
  try {
    const deployment = await k8sGet(
      '/apis/apps/v1/namespaces/opensphere-console/deployments/platform-release-reconciler',
    );
    const desired = Number(deployment?.spec?.replicas ?? 1);
    const observed = Number(deployment?.status?.observedGeneration ?? 0);
    const generation = Number(deployment?.metadata?.generation ?? 0);
    const updated = Number(deployment?.status?.updatedReplicas ?? 0);
    const available = Number(deployment?.status?.availableReplicas ?? 0);
    const rolloutReady = observed >= generation && updated === desired && available === desired;
    const env = deployment?.spec?.template?.spec?.containers?.[0]?.env || [];
    const executorImage = String(env.find((entry) => entry.name === 'EXECUTOR_IMAGE')?.value || '');
    const exactExecutor = /^ghcr\.io\/opensphere-platform\/opensphere-console-backend@sha256:[a-f0-9]{64}$/
      .test(executorImage);
    return {
      ready: rolloutReady && exactExecutor,
      state: rolloutReady && exactExecutor ? 'Ready' : 'Unavailable',
      blocker: !rolloutReady
        ? 'platform_release_reconciler_rollout_incomplete'
        : (!exactExecutor ? 'platform_release_executor_image_not_exact_digest' : null),
      generation,
      observedGeneration: observed,
      desiredReplicas: desired,
      updatedReplicas: updated,
      availableReplicas: available,
      executorImage: exactExecutor ? executorImage : null,
    };
  } catch (error) {
    return {
      ready: false,
      state: 'Unavailable',
      blocker: `platform_release_reconciler_unavailable:${String(error?.message || error).slice(0, 300)}`,
      generation: null,
      observedGeneration: null,
      desiredReplicas: null,
      updatedReplicas: null,
      availableReplicas: null,
      executorImage: null,
    };
  }
}

async function platformReleaseStatus() {
  const installed = await installedPlatformRelease();
  const [contracts, changes, executions, receipts, runtime] = await Promise.all([
    restRequest('consumer_contract', {
      query: `select=consumer_id,display_name,reconciler,status,metadata,updated_at&consumer_id=eq.${encodeURIComponent(PLATFORM_RELEASE_CONSUMER)}`,
    }),
    restRequest('change_request', {
      query: `select=request_id,action,target,reason,status,git_commit_sha,k8s_operation_id,created_at,completed_at&target=eq.${encodeURIComponent(PLATFORM_RELEASE_TARGET)}&order=created_at.desc&limit=20`,
    }),
    restRequest('change_execution', {
      query: 'select=request_id,pull_number,pull_url,merge_revision,reconciler,reconciler_status,drift_status,attempt_count,last_error,updated_at',
    }),
    restRequest('reconcile_receipt', {
      query: `select=operation_id,request_id,reconciler,desired_revision,applied_revision,succeeded,result,evidence,received_at&reconciler=eq.${encodeURIComponent(PLATFORM_RELEASE_RECONCILER)}&order=received_at.desc&limit=20`,
    }),
    platformReleaseRuntimeStatus(),
  ]);
  const executionByRequest = new Map((Array.isArray(executions) ? executions : [])
    .map((entry) => [entry.request_id, entry]));
  const receiptByRequest = new Map((Array.isArray(receipts) ? receipts : [])
    .map((entry) => [entry.request_id, entry]));
  return {
    authority: {
      declaration: 'Gitea reviewed GovernedChange',
      execution: PLATFORM_RELEASE_RECONCILER,
      observed: 'opensphere-installation-lock + reconcile receipt',
      localKubeconfigExecution: false,
      supportedChannels: ['edge'],
      approvalPolicy: {
        localEdgeComponentApply: 'owner-mfa',
        integratedRollbackAndPromotion: 'cross-operator',
      },
      blockedChannels: {
        candidate: 'integrated recovery drill required by Setup',
        stable: 'integrated recovery drill required by Setup',
        ga: 'signed GA lock installation is not implemented by Setup',
      },
    },
    execution: runtime,
    current: { ...installed.summary, components: installed.lock.components },
    contract: Array.isArray(contracts) ? contracts[0] || null : null,
    changes: (Array.isArray(changes) ? changes : []).map((change) => ({
      ...change,
      execution: executionByRequest.get(change.request_id) || null,
      receipt: receiptByRequest.get(change.request_id) || null,
    })),
    checkedAt: new Date().toISOString(),
  };
}

if (OS_SHELL_ADMISSION_ENABLED) {
  issueOsShellAdmission = createOsShellAdmissionIssuer({
    secret: OS_SHELL_ADMISSION_SECRET,
    ttlSeconds: Math.min(15, Math.max(1, Number(process.env.OS_SHELL_ADMISSION_TTL_SEC || 12))),
    allowLoopbackHttp: process.env.OS_SHELL_DEV_HTTP_LOOPBACK === 'true',
  });
}

if (OS_SHELL_DELEGATION_SECRET) {
  exchangeOsShellCredential = createOsShellCredentialExchange({
    secret: OS_SHELL_DELEGATION_SECRET,
    resolveShellSession: async (binding) => {
      const rows = await restRequest('rpc/resolve_shell_delegation', { method: 'POST', body: {
        p_session_id: binding.sessionId, p_actor_id: binding.actorId, p_generation: binding.generation,
        p_fencing_epoch: binding.fencingEpoch, p_permission_revision: binding.permissionRevision, p_aal: binding.aal,
      } });
      return Array.isArray(rows) ? rows[0] || null : null;
    },
    resolveBrowserSession: (sessionId, actorId) => {
      if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
      return browserSessions.resolveForDurableExecution(sessionId, actorId);
    },
    issueToken: cliToken,
  });
}
async function osShellFeatureState() {
  const rows = await restRequest('rpc/get_shell_feature_state', { method: 'POST', body: {} });
  const state = Array.isArray(rows) ? rows[0] : null;
  if (!state) throw { code: 503, msg: 'OS Shell feature authority unavailable' };
  return {
    enabled: state.enabled === true,
    revision: Number(state.revision),
    actorActiveLimit: Number(state.actor_active_limit),
    globalActiveLimit: Number(state.global_active_limit),
    reason: state.reason,
    changedBy: state.changed_by,
    changedAt: state.changed_at,
    drainCompletedAt: state.drain_completed_at,
    activeSessions: Number(state.active_sessions),
    activeTickets: Number(state.active_tickets),
    scaleDownAllowed: state.scale_down_allowed === true,
    operationId: state.operation_id || null,
    operationKind: state.operation_kind || null,
    operationPhase: state.operation_phase || null,
    operationIdentity: state.operation_identity || null,
    operationStartedAt: state.operation_started_at || null,
    operationCompletedAt: state.operation_completed_at || null,
    scaleClaimExpiresAt: state.scale_claim_expires_at || null,
  };
}

async function setOsShellFeatureState(actor, body) {
  const keys = Object.keys(body || {}).sort();
  if (keys.join(',') !== 'enabled,expectedRevision,reason' || typeof body.enabled !== 'boolean'
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1
    || String(body.reason || '').trim().length < 8 || String(body.reason).length > 512) {
    throw { code: 400, msg: 'closed OS Shell feature operation requires enabled, expectedRevision, and reason' };
  }
  requireActorPermission(actor, 'console.identity.manage');
  if (body.enabled) {
    throw { code: 409, msg: 'ShellFeatureBrowserEnableRequiresVerifiedRelease',
      nextAction: 'Run the signed local-edge release owner after exact migration, component, and readiness verification.' };
  }
  try {
    await restRequest('rpc/set_shell_feature_state', { method: 'POST', body: {
      p_enabled: body.enabled, p_expected_revision: body.expectedRevision,
      p_reason: String(body.reason).trim(), p_actor_id: actor.sub,
    } });
  } catch (error) {
    if (/ShellFeatureRevisionConflict/.test(String(error?.msg || error?.message || ''))) {
      throw { code: 409, msg: 'ShellFeatureRevisionConflict' };
    }
    throw error;
  }
  return osShellFeatureState();
}

async function setOsShellFeatureStateLocalEdge(req, body) {
  const actor = await verifyLocalEdgeAutomation(req);
  const keys = Object.keys(body || {}).sort();
  if (keys.join(',') !== 'enabled,evidence,expectedRevision,operationId,reason' || typeof body.enabled !== 'boolean'
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(body.operationId || ''))
    || String(body.reason || '').trim().length < 8 || String(body.reason).length > 512
    || !body.evidence || typeof body.evidence !== 'object' || Array.isArray(body.evidence)) {
    throw { code: 400, msg: 'closed local edge OS Shell feature operation requires enabled, expectedRevision, reason, and evidence' };
  }
  const evidenceKeys = Object.keys(body.evidence).sort();
  if (evidenceKeys.join(',') !== 'authority,channel,componentSetDigest,gaEligible,latestMigrationId,migrationSetDigest,publicationSha256,releaseIntentKeyId,releaseIntentSha256,releaseIntentSignatureSha256,sourceRevision'
    || body.evidence.authority !== 'kubernetes-workload' || body.evidence.channel !== 'edge'
    || body.evidence.gaEligible !== false || body.evidence.latestMigrationId !== '0062'
    || !/^sha256:[a-f0-9]{64}$/.test(String(body.evidence.componentSetDigest || ''))
    || !/^sha256:[a-f0-9]{64}$/.test(String(body.evidence.publicationSha256 || ''))
    || !/^sha256:[a-f0-9]{64}$/.test(String(body.evidence.migrationSetDigest || ''))
    || body.evidence.releaseIntentKeyId !== 'opensphere-edge-local-v1'
    || !/^sha256:[a-f0-9]{64}$/.test(String(body.evidence.releaseIntentSha256 || ''))
    || !/^sha256:[a-f0-9]{64}$/.test(String(body.evidence.releaseIntentSignatureSha256 || ''))
    || !/^[a-f0-9]{40}$/.test(String(body.evidence.sourceRevision || ''))) {
    throw { code: 400, msg: 'local edge OS Shell feature evidence is outside the closed component release contract' };
  }
  try {
    await restRequest('rpc/set_shell_feature_state_local_edge', { method: 'POST', body: {
      p_enabled: body.enabled, p_expected_revision: body.expectedRevision,
      p_reason: String(body.reason).trim(), p_actor_identity: actor.username,
      p_operation_evidence: body.evidence, p_operation_id: body.operationId,
    } });
  } catch (error) {
    if (/ShellFeatureRevisionConflict/.test(String(error?.msg || error?.message || ''))) {
      throw { code: 409, msg: 'ShellFeatureRevisionConflict' };
    }
    throw error;
  }
  const state = await osShellFeatureState();
  return { contract: 'opensphere-shell-feature-operation/v1', authority: actor.username,
    operation: body.enabled ? 'Enable' : 'Disable', state,
    evidenceSha256: `sha256:${toHashHex(canonicalJson(body.evidence))}` };
}

async function advanceOsShellScaleDownLocalEdge(req, body, action) {
  const actor = await verifyLocalEdgeAutomation(req);
  const expectedKeys = action === 'claim'
    ? 'expectedRevision,operationId,scaleClaimToken'
    : 'expectedRevision,operationId,scaleClaimToken';
  if (Object.keys(body || {}).sort().join(',') !== expectedKeys
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(body.operationId || ''))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(body.scaleClaimToken || ''))) {
    throw { code: 400, msg: 'closed scale-down fence requires expectedRevision, operationId, and scaleClaimToken' };
  }
  const rpc = action === 'claim' ? 'claim_shell_feature_scale_down' : 'complete_shell_feature_scale_down';
  const rpcBody = {
    p_operation_id: body.operationId,
    p_expected_revision: body.expectedRevision,
    p_actor_identity: actor.username,
    p_scale_claim_token: body.scaleClaimToken,
  };
  if (action === 'claim') rpcBody.p_lease_seconds = 120;
  try {
    await restRequest(`rpc/${rpc}`, { method: 'POST', body: rpcBody });
  } catch (error) {
    if (/ShellFeature.*(?:Conflict|FenceLost|ClaimHeld|DrainIncomplete)/.test(String(error?.msg || error?.message || ''))) {
      throw { code: 409, msg: String(error?.msg || error?.message).match(/ShellFeature[A-Za-z]+/)?.[0] || 'ShellFeatureOperationConflict' };
    }
    throw error;
  }
  return { contract: 'opensphere-shell-feature-operation/v1', authority: actor.username,
    action: action === 'claim' ? 'ScaleDownClaim' : 'ScaleDownComplete', state: await osShellFeatureState() };
}

async function verifyLocalEdgeAutomation(req) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) throw { code: 401, msg: 'local edge automation ServiceAccount token is required' };
  const reviewed = await k8sRequest('POST', '/apis/authentication.k8s.io/v1/tokenreviews', {
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenReview',
    spec: { token: match[1], audiences: [LOCAL_EDGE_AUTOMATION_AUDIENCE] },
  });
  const username = String(reviewed.body?.status?.user?.username || '');
  const audiences = Array.isArray(reviewed.body?.status?.audiences)
    ? reviewed.body.status.audiences.map(String) : [];
  if (!reviewed.ok || reviewed.body?.status?.authenticated !== true
    || username !== LOCAL_EDGE_AUTOMATION_SERVICE_ACCOUNT
    || !audiences.includes(LOCAL_EDGE_AUTOMATION_AUDIENCE)) {
    throw { code: 403, msg: 'local edge automation identity or audience is not authorized' };
  }
  validateLocalEdgeAutomationTokenClaims(match[1], {
    username: LOCAL_EDGE_AUTOMATION_SERVICE_ACCOUNT,
    audience: LOCAL_EDGE_AUTOMATION_AUDIENCE,
  });
  return {
    sub: LOCAL_EDGE_AUTOMATION_ACTOR_ID,
    username,
    displayName: 'Docker Desktop local edge automation',
    actorType: 'service',
    assurance: 'kubernetes-workload',
    authSessionId: null,
    groups: [],
    permissions: ['console.git.change'],
  };
}

async function executeLocalEdgePlatformRelease(req, body = {}) {
  const actor = await verifyLocalEdgeAutomation(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['reason', 'sourceRevision', 'components'].includes(key))) {
    throw { code: 400, msg: 'local edge automation body contains unsupported fields' };
  }
  const reason = managementReason(body.reason);
  if (!reason) throw { code: 400, msg: 'management reason must be at least 8 characters' };
  const generated = await generatePlatformComponentTarget(actor, {
    reason,
    sourceRevision: body.sourceRevision,
    components: body.components,
  }, { localEdgeAutomation: true });
  const proposal = await governedChange(actor, {
    consumerId: PLATFORM_RELEASE_CONSUMER,
    action: 'apply',
    target: PLATFORM_RELEASE_TARGET,
    reason,
    desiredState: {
      contract: 'opensphere.platform.release/v1',
      previousReleaseDigest: generated.baseReleaseDigest,
      targetLock: generated.targetLock,
    },
    idempotencyKey: `local-edge:${generated.targetLock.releaseDigest}`,
  }, { localEdgeAutomation: true });
  return {
    ...proposal,
    targetReleaseDigest: generated.targetLock.releaseDigest,
    changedComponents: generated.targetLock.changedComponents,
  };
}

async function executePfssLocalEdgePlatformRelease(req, body = {}) {
  const actor = await verifyLocalEdgeAutomation(req);
  const expected = [
    'operationId', 'reason', 'sourceRevision', 'components', 'componentPublication',
    'publicationDocument', 'publicationSignature',
  ];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== expected.length
    || Object.keys(body).some((key) => !expected.includes(key))) {
    throw { code: 400, msg: 'PFSS local edge automation body contains unsupported fields' };
  }
  const reason = managementReason(body.reason);
  if (!reason) throw { code: 400, msg: 'management reason must be at least 8 characters' };
  const trustedSpki = String(process.env.PFSS_COMPONENT_PUBLIC_KEY_SPKI_BASE64 || '').trim();
  if (!trustedSpki) throw { code: 503, msg: 'PFSS trusted P-256 SPKI is not configured' };
  let publication;
  try {
    publication = validatePfssPublicationSubmission({
      sourceRevision: body.sourceRevision,
      components: body.components,
      componentPublication: body.componentPublication,
      publicationDocument: body.publicationDocument,
      publicationSignature: body.publicationSignature,
    }, trustedSpki);
  } catch (error) {
    throw { code: 400, msg: error.message };
  }
  if (body.operationId !== publication.operationId) {
    throw { code: 400, msg: 'PFSS operationId does not bind the signed publication document' };
  }
  // This admission precedes target generation and governedChange. Invalid
  // evidence therefore has zero durable write effects.
  const generated = await generatePlatformComponentTarget(actor, {
    reason,
    sourceRevision: body.sourceRevision,
    components: body.components,
    componentPublication: publication.binding,
  }, { localEdgeAutomation: true });
  const proposal = await governedChange(actor, {
    consumerId: PLATFORM_RELEASE_CONSUMER,
    action: 'apply',
    target: PLATFORM_RELEASE_TARGET,
    reason,
    desiredState: {
      contract: 'opensphere.platform.release/v1',
      previousReleaseDigest: generated.baseReleaseDigest,
      targetLock: generated.targetLock,
    },
    // Document-derived before POST: response loss resumes through GET only.
    idempotencyKey: publication.operationId,
  }, { localEdgeAutomation: true });
  return {
    ...proposal,
    operationId: publication.operationId,
    targetReleaseDigest: generated.targetLock.releaseDigest,
    changedComponents: generated.targetLock.changedComponents,
    componentPublication: {
      documentSha256: publication.documentSha256,
      signatureSha256: publication.signatureSha256,
      publisher: publication.binding.publisher,
    },
  };
}

async function localEdgePlatformReleaseReceipt(req, requestId) {
  await verifyLocalEdgeAutomation(req);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(requestId || ''))) {
    throw { code: 400, msg: 'local edge release requestId is invalid' };
  }
  const status = await platformReleaseStatus();
  const change = status.changes.find((entry) => entry.request_id === requestId);
  if (!change) throw { code: 404, msg: 'local edge release request is unavailable' };
  const receipt = change.receipt || null;
  return {
    contract: 'opensphere.platform.release.local-edge-receipt/v1',
    requestId,
    status: change.status,
    execution: change.execution || null,
    receipt: receipt ? {
      operationId: receipt.operation_id,
      succeeded: receipt.succeeded,
      result: receipt.result,
      evidence: receipt.evidence || {},
      receivedAt: receipt.received_at,
    } : null,
  };
}

async function pfssLocalEdgePlatformReleaseResume(req, identifier) {
  await verifyLocalEdgeAutomation(req);
  const value = String(identifier || '');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return { operationId: null, ...(await localEdgePlatformReleaseReceipt(req, value)) };
  }
  if (!/^pfss:[a-f0-9]{64}$/.test(value)) {
    throw { code: 400, msg: 'PFSS operationId or requestId is invalid' };
  }
  const rows = await restRequest('change_request', {
    query: `select=request_id,status,target&idempotency_key=eq.${encodeURIComponent(value)}&limit=1`,
  });
  const change = Array.isArray(rows) ? rows[0] : null;
  if (!change || change.target !== PLATFORM_RELEASE_TARGET) {
    throw { code: 404, msg: 'PFSS governed Platform request is unavailable' };
  }
  const receipt = await localEdgePlatformReleaseReceipt(req, change.request_id);
  return {
    operationId: value,
    ...receipt,
    targetReleaseDigest: receipt.receipt?.evidence?.installedReleaseDigest || null,
  };
}

async function generatePlatformComponentTarget(actor, body = {}, options = {}) {
  requireActorPermission(actor, 'console.git.change');
  if (options.localEdgeAutomation !== true) {
    requireRecentAal2(actor, 'Platform Release component target generation');
  }
  const reason = managementReason(body.reason);
  if (!reason) throw { code: 400, msg: 'management reason must be at least 8 characters' };
  const installed = await installedPlatformRelease();
  let targetLock;
  try {
    targetLock = buildComponentReleaseLock(installed.lock, {
    sourceRevision: body.sourceRevision,
    components: body.components,
    componentPublication: body.componentPublication,
    });
  } catch (error) {
    throw { code: 400, msg: error.message };
  }
  await logAudit(
    actor,
    'platform-release-component-target-generate',
    targetLock.releaseDigest,
    'ok',
    reason,
    {
      requestId: newOpId(),
      // audit.event deliberately uses a closed lifecycle vocabulary. Target
      // generation records the operator's reviewed intent; `planned` is not a
      // schema phase and would make PostgREST reject the entire operation.
      phase: 'intent',
      targetType: 'platform-release-lock',
      payloadDigest: toHashHex(canonicalJson({
        baseReleaseDigest: targetLock.baseReleaseDigest,
        changedComponents: targetLock.changedComponents,
        releaseDigest: targetLock.releaseDigest,
      })),
    },
  );
  return {
    targetLock,
    baseReleaseDigest: installed.summary.releaseDigest,
    changedComponents: targetLock.changedComponents,
    generatedAt: new Date().toISOString(),
  };
}

async function governedChange(actor, body = {}, options = {}) {
  requireActorPermission(actor, 'console.git.change');
  const localEdgeAutomationRequest = options.localEdgeAutomation === true
    && actor?.actorType === 'service';
  if (!localEdgeAutomationRequest && GITEA_CHANGE_REQUIRE_AAL2 && actor.assurance !== 'aal2') {
    throw { code: 403, msg: 'governed Gitea change requires MFA assurance aal2' };
  }
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
  let declaration = validateDeclaration(body.desiredState);
  let releaseApprovalPolicy = null;
  let releaseDesiredState = null;
  if (consumerId === PLATFORM_RELEASE_CONSUMER) {
    if (!['apply', 'rollback'].includes(action.toLowerCase()) || target !== PLATFORM_RELEASE_TARGET) {
      throw { code: 400, msg: 'Platform Release permits only apply or rollback for opensphere-platform' };
    }
    let desiredState;
    try { desiredState = validatePlatformReleaseDesiredState(declaration.value); }
    catch (error) { throw { code: 400, msg: error.message }; }
    const installed = await installedPlatformRelease();
    if (desiredState.previousReleaseDigest !== installed.summary.releaseDigest) {
      throw { code: 409, msg: 'Platform Release request is stale; current installation lock changed' };
    }
    try { validateReleaseTransition(installed.lock, desiredState.targetLock); }
    catch (error) { throw { code: 409, msg: error.message }; }
    if (action.toLowerCase() === 'apply'
      && desiredState.targetLock.releaseDigest === installed.summary.releaseDigest) {
      throw { code: 409, msg: 'requested Platform Release is already installed' };
    }
    releaseApprovalPolicy = platformReleaseApprovalPolicy(action, desiredState);
    if (localEdgeAutomationRequest && releaseApprovalPolicy.mode !== 'local-edge-automation') {
      throw { code: 403, msg: 'local edge automation can apply only a localhost edge component transition' };
    }
    if (!localEdgeAutomationRequest) requireRecentAal2(actor, 'Platform Release request');
    releaseDesiredState = desiredState;
    declaration = validateDeclaration(desiredState);
  }
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
      p_actor_type: actor?.actorType === 'service' ? 'service' : 'human',
      p_actor_id: actor.sub,
      p_action: `gitea:${action.toLowerCase()}`,
      p_target: target,
      p_reason: reason,
      p_payload_digest: `sha256:${declaration.digest}`,
    },
  });
  const change = Array.isArray(started) ? started[0] : started;
  if (!change?.request_id) throw { code: 503, msg: 'governed change intent was not persisted' };
  if (change.request_id !== requestId) return {
    accepted: true,
    duplicate: true,
    requestId: change.request_id,
    status: change.status,
    approvalPolicy: releaseApprovalPolicy,
  };

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
    const proposal = {
      accepted: true, requestId, status: 'authorized', branch, rollbackOf,
      pullRequest: { number: pull.body?.number || null, url: pull.body?.html_url || null },
      desiredRevision: desiredRevision || null,
      approvalPolicy: releaseApprovalPolicy,
    };
    if (releaseApprovalPolicy?.mode === 'local-edge-automation') {
      try {
        proposal.autoAuthorization = await authorizeLocalEdgeComponentRelease(actor, {
          requestId,
          action,
          reason,
          desiredState: releaseDesiredState,
          branch,
          pullNumber: Number(pull.body?.number || 0),
          reconciler: contract.reconciler || GITEA_RECONCILER_NAME,
        });
        proposal.status = proposal.autoAuthorization.merged ? 'committed' : 'authorized';
      } catch (error) {
        proposal.autoAuthorization = {
          attempted: true,
          succeeded: false,
          error: String(error?.msg || error).slice(0, 300),
        };
      }
    }
    return proposal;
  } catch (error) {
    await restRequest('rpc/record_change_failure', { method: 'POST', body: { p_request_id: requestId, p_result: 'gitea-proposal-failed', p_error: String(error?.msg || 'Gitea proposal failed').slice(0, 1800) } }).catch(() => undefined);
    throw error;
  }
}

async function authorizeLocalEdgeComponentRelease(actor, {
  requestId, action, reason, desiredState, branch, pullNumber, reconciler,
}) {
  const policy = platformReleaseApprovalPolicy(action, desiredState);
  if (policy.mode !== 'local-edge-automation' || policy.autoMerge !== true) {
    throw { code: 409, msg: 'release is not eligible for local edge automation' };
  }
  const humanAuthorization = actor?.actorType !== 'service';
  if (humanAuthorization) requireRecentAal2(actor, 'local edge component release authorization');
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    throw { code: 502, msg: 'Gitea did not return a pull request number' };
  }
  if (humanAuthorization) {
    await restRequest('change_approval', {
      method: 'POST',
      body: {
        request_id: requestId,
        approver_id: actor.sub,
        reason,
        status: 'intent',
      },
      prefer: 'return=minimal',
    });
  }
  let reviewId = null;
  try {
    const review = await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/pulls/${pullNumber}/reviews`, {
      method: 'POST',
      authToken: GITEA_REVIEW_TOKEN,
      body: {
        event: 'APPROVED',
        body: `Local edge component release authorized by ${humanAuthorization ? `Console owner ${actor.sub}` : LOCAL_EDGE_AUTOMATION_SERVICE_ACCOUNT}; correlation ${requestId}. Reason: ${reason}`,
      },
    });
    reviewId = Number.isInteger(review.body?.id) ? review.body.id : null;
    await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/pulls/${pullNumber}/merge`, {
      method: 'POST',
      body: { Do: 'merge', delete_branch_after_merge: false },
    });
    const pull = await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/pulls/${pullNumber}`);
    const merged = pull.body?.state === 'closed' && pull.body?.merged === true;
    const mergeRevision = String(pull.body?.merge_commit_sha || '').toLowerCase();
    if (!merged || !/^[0-9a-f]{40,64}$/.test(mergeRevision)) {
      throw { code: 502, msg: 'authorized local edge pull request was not merged' };
    }
    await assertVerifiedGovernedMerge(mergeRevision);
    if (humanAuthorization) {
      await restRequest('change_approval', {
        method: 'PATCH',
        query: `request_id=eq.${encodeURIComponent(requestId)}&approver_id=eq.${encodeURIComponent(actor.sub)}`,
        body: {
          status: 'applied',
          gitea_review_id: reviewId,
          error_code: null,
          completed_at: new Date().toISOString(),
        },
        prefer: 'return=minimal',
      });
    }
    await logAudit(actor, 'platform-release-edge-automation', requestId, 'local-edge-authorized', reason, {
      requestId,
      phase: 'authorized',
      targetType: 'platform-release',
      payloadDigest: toHashHex(canonicalJson({ requestId, pullNumber, mergeRevision, mode: policy.mode })),
    });
    let reconciliationError = null;
    try {
      await convergeGovernedMerge({
        requestId,
        branch,
        mergeRevision,
        repository: giteaRepoName(),
        reconciler: reconciler || PLATFORM_RELEASE_RECONCILER,
      });
    } catch (error) {
      reconciliationError = String(error?.msg || error).slice(0, 300);
      await logAudit(actor, 'platform-release-edge-automation', requestId, 'reconciliation-queue-failed', reason, {
        requestId,
        phase: 'authorized',
        targetType: 'platform-release',
        payloadDigest: toHashHex(canonicalJson({ requestId, pullNumber, mergeRevision, reconciliationError })),
      }).catch(() => undefined);
    }
    return {
      attempted: true,
      succeeded: true,
      mode: policy.mode,
      merged: true,
      mergeRevision,
      pullNumber,
      reconciliationQueued: !reconciliationError,
      reconciliationError,
    };
  } catch (error) {
    if (humanAuthorization) {
      await restRequest('change_approval', {
        method: 'PATCH',
        query: `request_id=eq.${encodeURIComponent(requestId)}&approver_id=eq.${encodeURIComponent(actor.sub)}`,
        body: {
          status: 'failed',
          gitea_review_id: reviewId,
          error_code: String(error?.msg || 'local-edge-authorization-failed').slice(0, 180),
          completed_at: new Date().toISOString(),
        },
        prefer: 'return=minimal',
      }).catch(() => undefined);
    }
    await logAudit(actor, 'platform-release-edge-automation', requestId, 'failed', reason, {
      requestId,
      phase: 'failed',
      targetType: 'platform-release',
      payloadDigest: toHashHex(canonicalJson({ requestId, pullNumber, error: error?.msg || 'local-edge-authorization-failed' })),
    }).catch(() => undefined);
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
    restRequest('change_execution', { query: `select=request_id,pull_number,branch,reconciler&request_id=eq.${encodeURIComponent(requestId)}` }),
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
    const pull = await giteaRequest(`/api/v1/repos/${encodeURIComponent(GITEA_ORGANIZATION)}/${encodeURIComponent(GITEA_REPOSITORY)}/pulls/${execution.pull_number}`);
    const merged = pull.body?.state === 'closed' && pull.body?.merged === true;
    const mergeRevision = String(pull.body?.merge_commit_sha || '').toLowerCase();
    if (merged && /^[0-9a-f]{40,64}$/.test(mergeRevision)) {
      await convergeGovernedMerge({
        requestId,
        branch: execution.branch,
        mergeRevision,
        repository: giteaRepoName(),
        reconciler: execution.reconciler || GITEA_RECONCILER_NAME,
      });
    }
    return { requestId, approved: true, merged, mergeRevision: merged ? mergeRevision : null, mergeMessage: String(merge.body?.message || '') || null, pullNumber: execution.pull_number };
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
  await convergeGovernedMerge({ requestId: execution.request_id, branch, mergeRevision, repository, reconciler: execution.reconciler || GITEA_RECONCILER_NAME, signatureVerified: true });
  await patchWebhookReceipt(deliveryId, { request_id: execution.request_id, disposition: 'accepted', error_code: null });
  return { duplicate: false, accepted: true, requestId: execution.request_id, status: 'committed' };
}

async function convergeGovernedMerge({ requestId, branch, mergeRevision, repository, reconciler, signatureVerified = false }) {
  if (!signatureVerified) await assertVerifiedGovernedMerge(mergeRevision);
  const [changeRows, executionRows] = await Promise.all([
    restRequest('change_request', { query: `select=request_id,status,git_commit_sha&request_id=eq.${encodeURIComponent(requestId)}` }),
    restRequest('change_execution', { query: `select=request_id,branch,merge_revision,reconciler&request_id=eq.${encodeURIComponent(requestId)}` }),
  ]);
  const change = Array.isArray(changeRows) ? changeRows[0] : null;
  const execution = Array.isArray(executionRows) ? executionRows[0] : null;
  if (!change || !execution || execution.branch !== branch) throw { code: 409, msg: 'governed merge does not match its recorded change execution' };
  if (change.status === 'authorized' || change.status === 'intent' || change.status === 'unknown') {
    await restRequest('rpc/record_change_commit', { method: 'POST', body: { p_request_id: requestId, p_git_repo: repository, p_git_ref: GITEA_DEFAULT_BRANCH, p_git_commit_sha: mergeRevision } });
  } else if (!['committed', 'applied', 'failed'].includes(change.status) || change.git_commit_sha !== mergeRevision) {
    throw { code: 409, msg: 'governed merge conflicts with the recorded change state' };
  }
  await restRequest('change_execution', { method: 'PATCH', query: `request_id=eq.${encodeURIComponent(requestId)}`, body: { merge_revision: mergeRevision, updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
  if (!['applied', 'failed'].includes(change.status)) {
    await restRequest('rpc/queue_change_reconcile', { method: 'POST', body: { p_request_id: requestId, p_reconciler: reconciler || execution.reconciler || GITEA_RECONCILER_NAME } });
  }
  return { requestId, status: change.status === 'authorized' ? 'committed' : change.status, mergeRevision };
}

async function retryGovernedChange(actor, requestIdValue, body = {}) {
  requireActorPermission(actor, 'console.git.change');
  if (GITEA_CHANGE_REQUIRE_AAL2 && actor.assurance !== 'aal2') throw { code: 403, msg: 'governed reconcile retry requires MFA assurance aal2' };
  const requestId = uuid(requestIdValue);
  const reason = managementReason(body.reason);
  if (!reason) throw { code: 400, msg: 'retry reason must be at least 8 characters' };
  const rows = await restRequest('rpc/retry_change_reconcile', {
    method: 'POST',
    body: { p_request_id: requestId, p_actor_id: actor.sub, p_reason: reason },
  });
  const queued = Array.isArray(rows) ? rows[0] : rows;
  await logAudit(actor, 'gitea-change-reconcile-retry', requestId, 'ok', reason, {
    requestId,
    phase: 'committed',
    targetType: 'declarative-change',
    payloadDigest: toHashHex(canonicalJson({ requestId, outboxId: queued?.id || null, attempts: queued?.attempts || 0 })),
  });
  return { requestId, requeued: true, outboxStatus: queued?.status || 'queued', attempts: Number(queued?.attempts || 0) };
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

async function proxyAdminControlRequest(req, res, url) {
  let authorization = String(req.headers.authorization || '');
  const method = String(req.method || 'GET').toUpperCase();
  const registrationLifecycle = url.pathname.match(
    /^\/api\/admin\/plugins\/registrations\/[a-z0-9-]+\/(install|enable|disable|uninstall|rollback)$/,
  );
  const lifecycleAction = url.pathname === '/api/admin/extensions/install'
    ? 'install'
    : registrationLifecycle?.[1] || '';
  const requireAal2 = isMutationRequest(req)
    && (!lifecycleAction || moduleLifecycleNeedsRecentAal2(lifecycleAction));
  if (authorization) {
    // CLI/PAT requests retain their bearer credential, but are verified at the
    // Console enforcement point before the request reaches DUPA. A bearer
    // string never substitutes for the current admin role or recent AAL2 proof.
    await verifyConsoleAdmin(req, { requireAal2 });
  } else {
    // Browser credentials never return to JavaScript. Resolve the opaque
    // HttpOnly cookie server-side and forward only the short-lived Supabase
    // access token. authenticate(req) also enforces Origin + CSRF on mutations.
    if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
    const session = await browserSessions.authenticate(req);
    assertConsoleAdminActor(session.actor, { requireAal2 });
    authorization = `Bearer ${session.accessToken}`;
  }

  const hasBody = !['GET', 'HEAD'].includes(method);
  const body = hasBody ? await readRawBody(req) : undefined;
  const headers = {
    authorization,
    accept: String(req.headers.accept || 'application/json'),
    'x-os-correlation-id': String(req.headers['x-os-correlation-id'] || newOpId()),
  };
  if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
  if (req.headers['x-os-idempotency-key']) headers['x-os-idempotency-key'] = String(req.headers['x-os-idempotency-key']);

  let response;
  try {
    response = await fetch(`${DUPA_CONTROL_URL}${url.pathname}${url.search}`, {
      method,
      headers,
      body: hasBody && body.length ? body : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw { code: 503, msg: 'DUPA control service unavailable' };
  }

  const payload = Buffer.from(await response.arrayBuffer());
  const responseHeaders = {};
  for (const name of ['content-type', 'cache-control', 'content-disposition', 'etag', 'retry-after', 'x-os-correlation-id']) {
    const value = response.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  res.writeHead(response.status, responseHeaders);
  if (method === 'HEAD') return res.end();
  return res.end(payload);
}

async function pluginProxyReleaseAllowed(pluginId, correlationId) {
  let response;
  try {
    response = await fetch(`${DUPA_CONTROL_URL}/api/internal/proxy-authz`, {
      method: 'GET',
      headers: {
        'x-plugin-id': pluginId,
        'x-os-correlation-id': correlationId || newOpId(),
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw { code: 503, msg: 'extension release authorization service unavailable' };
  }
  if (response.status === 204) return true;
  if (response.status === 403) return false;
  throw { code: 503, msg: `extension release authorization failed (HTTP ${response.status})` };
}

function json(res, code, obj, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
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

function sessionPreferenceProjection(user) {
  return {
    duration: sessionPersistenceFromUser(user),
    defaultDuration: DEFAULT_SESSION_PERSISTENCE,
    idleTimeoutHours: 12,
    appliesTo: 'next-login',
  };
}

async function readSessionPreference(actor) {
  const user = await getAuthUser(actor.sub);
  if (!user) throw { code: 503, msg: 'Supabase account preference is unavailable' };
  return sessionPreferenceProjection(user);
}

async function updateSessionPreference(actor, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'duration')) {
    throw { code: 400, msg: 'session preference requires exactly duration' };
  }
  const selected = normalizeSessionPersistence(body.duration);
  const current = await getAuthUser(actor.sub);
  if (!current) throw { code: 503, msg: 'Supabase account preference is unavailable' };
  const existingMetadata = current.user_metadata && typeof current.user_metadata === 'object'
    && !Array.isArray(current.user_metadata) ? current.user_metadata : {};
  const updated = await authAdminRequest(`/admin/users/${actor.sub}`, {
    method: 'PUT',
    body: {
      user_metadata: {
        ...existingMetadata,
        [SESSION_PERSISTENCE_METADATA_KEY]: selected,
      },
    },
  });
  if (!updated?.id || updated.id !== actor.sub) {
    throw { code: 503, msg: 'Supabase account preference update was not confirmed' };
  }
  return sessionPreferenceProjection(updated);
}

function avatarStorageUrl(subject) {
  const encodedPath = avatarObjectPath(subject).split('/').map((value) => encodeURIComponent(value)).join('/');
  return `${SUPABASE_STORAGE_URL.replace(/\/$/, '')}/object/${AVATAR_BUCKET}/${encodedPath}`;
}

function avatarStorageHeaders(contentType = '') {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    accept: 'application/json',
    ...(contentType ? { 'content-type': contentType } : {}),
  };
}

async function avatarStorageRequest(subject, { method = 'GET', bytes = undefined, contentType = '' } = {}) {
  if (!SUPABASE_SERVICE_ROLE_KEY) throw { code: 503, msg: 'avatar storage credential is unavailable' };
  let response;
  try {
    response = await fetch(avatarStorageUrl(subject), {
      method,
      headers: {
        ...avatarStorageHeaders(contentType),
        ...(method === 'POST' ? { 'x-upsert': 'true' } : {}),
      },
      body: bytes,
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });
  } catch {
    throw { code: 503, msg: 'avatar storage is unavailable' };
  }
  if (method === 'DELETE' && response.status === 404) return null;
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw { code: response.status >= 500 ? 503 : response.status, msg: 'avatar storage request failed' };
  }
  return response;
}

async function updateAvatarMetadata(subject, current, avatarMetadata) {
  const existingMetadata = current.user_metadata && typeof current.user_metadata === 'object'
    && !Array.isArray(current.user_metadata) ? current.user_metadata : {};
  const nextMetadata = { ...existingMetadata };
  if (avatarMetadata) nextMetadata[AVATAR_METADATA_KEY] = avatarMetadata;
  else delete nextMetadata[AVATAR_METADATA_KEY];
  const updated = await authAdminRequest(`/admin/users/${subject}`, {
    method: 'PUT',
    body: { user_metadata: nextMetadata },
  });
  if (!updated?.id || updated.id !== subject) throw { code: 503, msg: 'avatar preference update was not confirmed' };
  return updated;
}

async function readProfileAvatar(actor) {
  const user = await getAuthUser(actor.sub);
  if (!user) throw { code: 503, msg: 'Supabase account avatar is unavailable' };
  return avatarProjection(user);
}

async function updateProfileAvatar(actor, body) {
  const current = await getAuthUser(actor.sub);
  if (!current) throw { code: 503, msg: 'Supabase account avatar is unavailable' };
  const before = avatarProjection(current);
  const selected = validateAvatarSelection(body, before.linkedAccounts);
  const updated = await updateAvatarMetadata(actor.sub, current, selected);
  if (before.current.source === 'upload') {
    await avatarStorageRequest(actor.sub, { method: 'DELETE' }).catch(() => undefined);
  }
  return avatarProjection(updated);
}

async function uploadProfileAvatar(actor, body) {
  const current = await getAuthUser(actor.sub);
  if (!current) throw { code: 503, msg: 'Supabase account avatar is unavailable' };
  const upload = validateAvatarUpload(body);
  await avatarStorageRequest(actor.sub, { method: 'POST', bytes: upload.bytes, contentType: upload.contentType });
  try {
    const updated = await updateAvatarMetadata(actor.sub, current, {
      source: 'upload',
      digest: upload.digest,
      contentType: upload.contentType,
    });
    return avatarProjection(updated);
  } catch (error) {
    await avatarStorageRequest(actor.sub, { method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
}

async function readProfileAvatarContent(actor) {
  const user = await getAuthUser(actor.sub);
  if (!user) throw { code: 503, msg: 'Supabase account avatar is unavailable' };
  const profile = avatarProjection(user);
  if (profile.current.source !== 'upload') throw { code: 404, msg: 'uploaded avatar is not selected' };
  const response = await avatarStorageRequest(actor.sub);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > AVATAR_MAX_BYTES) throw { code: 502, msg: 'stored avatar size is invalid' };
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== profile.current.digest) throw { code: 502, msg: 'stored avatar digest is invalid' };
  return { bytes, ...profile.current };
}

function writeProfileAvatarContent(res, content) {
  const etag = `\"${String(content.digest).slice('sha256:'.length)}\"`;
  res.writeHead(200, {
    'content-type': content.contentType,
    'content-length': String(content.bytes.length),
    'cache-control': 'private, max-age=300, must-revalidate',
    'x-content-type-options': 'nosniff',
    etag,
  });
  res.end(content.bytes);
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
    body: {
      type: 'recovery',
      email,
      redirect_to: `${CONSOLE_PUBLIC_URL}/auth/recovery`,
    },
  });
  const raw = result?.action_link || result?.properties?.action_link || null;
  if (!raw) return null;
  const publicBase = new URL(CONSOLE_PUBLIC_URL);
  const action = new URL(String(raw), `${publicBase.origin}/auth/v1/`);
  if (action.pathname === '/verify') action.pathname = '/auth/v1/verify';
  if (action.pathname !== '/auth/v1/verify') throw { code: 502, msg: 'unexpected Supabase recovery action path' };
  action.protocol = publicBase.protocol;
  action.host = publicBase.host;
  return action.toString();
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
      mfa: mfaProjectionFromAuthRow(authUser),
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
    signal: AbortSignal.timeout(5000),
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
    if (p === '/serving-readyz') {
      return json(res, 200, {
        ready: true,
        service: 'opensphere-console-backend',
        mode: 'read-only-management-surface',
        version: VERSION,
      });
    }
    if (p === '/readyz') {
      try { return json(res, 200, await requireSupabase()); }
      catch (error) {
        return json(res, 503, {
          ready: false,
          required: true,
          error: 'Supabase data and identity authority unavailable',
          components: error?.readiness?.components || [],
          checkedAt: error?.readiness?.checkedAt || new Date().toISOString(),
        });
      }
    }
    if (p === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      return res.end(metricsText());
    }
    if (p === '/api/internal/plugin-proxy-authz' && req.method === 'GET') {
      try {
        const result = await authorizePluginProxyRequest(req, {
          allowPlugin: (pluginId) => pluginProxyReleaseAllowed(pluginId, req.headers['x-os-correlation-id']),
          authenticateBrowser: (forwarded) => {
            if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
            return browserSessions.authenticate(forwarded);
          },
          verifyBearer: (forwarded) => verifyAuthed(forwarded),
        });
        res.writeHead(204, {
          'cache-control': 'no-store',
          'x-os-plugin-authorization': result.authorization,
        });
        return res.end();
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'plugin proxy authorization failed' }, {
          'cache-control': 'no-store',
        });
      }
    }
    if (p === '/api/internal/r2d2-proxy-authn' && req.method === 'GET') {
      try {
        const result = await authorizeR2d2ProxyRequest(req, {
          authenticateBrowser: (forwarded) => {
            if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
            return browserSessions.authenticate(forwarded);
          },
          verifyBearer: (forwarded) => verifyAuthed(forwarded),
        });
        res.writeHead(204, {
          'cache-control': 'no-store',
          'x-os-r2d2-authorization': result.authorization,
        });
        return res.end();
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'R2D2 proxy authentication failed' }, {
          'cache-control': 'no-store',
        });
      }
    }
    if (p.startsWith('/api/oaa/remediations/')) {
      try {
        const handled = await r2d2RemediationApi.handle(req, res, p, readBody, json);
        if (handled !== false) return;
      } catch (e) {
        const status = Number.isInteger(Number(e?.code)) && Number(e.code) >= 400 && Number(e.code) <= 599 ? Number(e.code) : 500;
        return json(res, status, { error: e?.msg || e?.message || 'R2D2 Engineering Remediation request failed' }, { 'cache-control': 'no-store' });
      }
    }
    if (p.startsWith('/api/oaa/operations')) {
      try {
        const handled = await r2d2OperationApi.handle(req, res, p, readBody, json);
        if (handled !== false) return;
      } catch (e) {
        const status = Number.isInteger(Number(e?.code)) && Number(e.code) >= 400 && Number(e.code) <= 599 ? Number(e.code) : 500;
        return json(res, status, { error: e?.msg || e?.message || 'R2D2 durable operation request failed' }, { 'cache-control': 'no-store' });
      }
    }
    if (p.startsWith('/api/modules') || p.startsWith('/api/module-operations')) {
      const handled = await moduleOperationApi.handle(req, res, p, json);
      if (handled) return;
    }
    if (p.startsWith('/api/admin/') && p !== '/api/admin/events') {
      try {
        return await proxyAdminControlRequest(req, res, url);
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Console admin control request failed' });
      }
    }
    if (p === '/api/identity/bootstrap/status' && req.method === 'GET') {
      return json(res, 200, await bootstrapStatus());
    }
    if (p === '/api/identity/bootstrap' && req.method === 'POST') {
      return json(res, 201, await bootstrapInitialOperator(await readBody(req)));
    }
    if (p === '/api/identity/session/adopt' && req.method === 'POST') {
      try {
        if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
        const body = await readBody(req);
        const adopted = await browserSessions.adoptLegacy(req, {
          refreshToken: body.refreshToken,
        });
        return json(res, 200, {
          mfaRequired: adopted.mfaRequired,
          session: adopted.session,
        }, { 'set-cookie': adopted.cookies });
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Legacy browser session adoption failed' });
      }
    }
    if (p === '/api/monitoring/baseline/v1/overview' && req.method === 'GET') {
      try {
        const actor = await verifyAuthed(req);
        requireActorPermission(actor, 'console.infrastructure.read');
        return json(res, 200, await baselineMonitoring.overview());
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Baseline monitoring overview unavailable' });
      }
    }
    if (p === '/api/monitoring/baseline/v1/nodes' && req.method === 'GET') {
      try {
        const actor = await verifyAuthed(req);
        requireActorPermission(actor, 'console.infrastructure.read');
        return json(res, 200, await baselineMonitoring.nodes());
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Baseline monitoring nodes unavailable' });
      }
    }
    const baselineSeriesPath = p.match(/^\/api\/monitoring\/baseline\/v1\/nodes\/([a-z0-9]{15})\/series$/);
    if (baselineSeriesPath && req.method === 'GET') {
      try {
        const actor = await verifyAuthed(req);
        requireActorPermission(actor, 'console.infrastructure.read');
        return json(res, 200, await baselineMonitoring.series(baselineSeriesPath[1], url.searchParams.get('range') || '24h'));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Baseline monitoring series unavailable' });
      }
    }
    if (p === '/api/monitoring/baseline/v1/alerts' && req.method === 'GET') {
      try {
        const actor = await verifyAuthed(req);
        requireActorPermission(actor, 'console.infrastructure.read');
        return json(res, 200, await baselineMonitoring.alerts());
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Baseline monitoring alerts unavailable' });
      }
    }
    if (p === '/api/monitoring/baseline/v1/data-health' && req.method === 'GET') {
      try {
        const actor = await verifyAuthed(req);
        requireActorPermission(actor, 'console.infrastructure.read');
        return json(res, 200, await baselineMonitoring.dataHealth());
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Baseline monitoring data health unavailable' });
      }
    }
    if (p === '/api/identity/session/preference' && req.method === 'GET') {
      try {
        return json(res, 200, await readSessionPreference(await verifyAuthed(req)));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Session preference unavailable' });
      }
    }
    if (p === '/api/identity/session/preference' && req.method === 'PUT') {
      try {
        return json(res, 200, await updateSessionPreference(await verifyAuthed(req), await readBody(req)));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Session preference update failed' });
      }
    }
    if (p === '/api/identity/profile/avatar' && req.method === 'GET') {
      try {
        return json(res, 200, await readProfileAvatar(await verifyAuthed(req)));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Profile avatar unavailable' });
      }
    }
    if (p === '/api/identity/profile/avatar' && req.method === 'PUT') {
      try {
        return json(res, 200, await updateProfileAvatar(await verifyAuthed(req), await readBody(req)));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Profile avatar update failed' });
      }
    }
    if (p === '/api/identity/profile/avatar/upload' && req.method === 'POST') {
      try {
        return json(res, 200, await uploadProfileAvatar(await verifyAuthed(req), await readBody(req)));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Profile avatar upload failed' });
      }
    }
    if (p === '/api/identity/profile/avatar/content' && req.method === 'GET') {
      try {
        return writeProfileAvatarContent(res, await readProfileAvatarContent(await verifyAuthed(req)));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Profile avatar content unavailable' });
      }
    }
    if (p === '/api/identity/session/login' && req.method === 'POST') {
      try {
        if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
        const created = await browserSessions.create(req, await readBody(req));
        return json(res, 200, {
          csrfToken: created.csrfToken,
          mfaRequired: created.mfaRequired,
          mfaEnrollmentRequired: created.mfaEnrollmentRequired,
          session: created.session,
        }, { 'set-cookie': created.cookies });
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Console login failed' });
      }
    }
    if (p === '/api/identity/session/mfa' && req.method === 'POST') {
      try {
        if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
        return json(res, 200, await browserSessions.completeMfa(req, (await readBody(req)).code));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Console MFA verification failed' });
      }
    }
    if (p === '/api/identity/session/touch' && req.method === 'POST') {
      try {
        if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
        const result = await browserSessions.touch(req);
        return json(res, 200, { session: result.session });
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Browser session activity update failed' });
      }
    }
    if (p === '/api/identity/session/step-up' && req.method === 'POST') {
      try {
        if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
        return json(res, 200, await browserSessions.stepUp(req, (await readBody(req)).code));
      } catch (e) {
        return json(res, authErrorStatus(e), {
          error: e.msg || 'Console MFA step-up failed',
          code: e.errorCode || undefined,
        });
      }
    }
    if (p === '/api/identity/session/totp/enrollment' && req.method === 'POST') {
      try {
        if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
        return json(res, 201, await browserSessions.beginTotp(req, (await readBody(req)).friendlyName));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'TOTP enrollment failed' });
      }
    }
    if (p === '/api/identity/session/totp/verification' && req.method === 'POST') {
      try {
        if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
        const body = await readBody(req);
        return json(res, 200, await browserSessions.verifyTotp(req, body.factorId, body.code));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'TOTP verification failed' });
      }
    }
    if (p === '/api/identity/session' && req.method === 'DELETE') {
      try {
        if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
        await browserSessions.revoke(req, null, 'user logout');
        return json(res, 200, { ok: true }, { 'set-cookie': browserSessions.clearCookies() });
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Console logout failed' }, {
          'set-cookie': browserSessions ? browserSessions.clearCookies() : [],
        });
      }
    }
    if (p === '/api/identity/sessions' && req.method === 'GET') {
      try {
        if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
        const result = await browserSessions.list(req);
        return json(res, 200, { items: result.items });
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Browser session inventory unavailable' });
      }
    }
    if (p === '/api/identity/session/events' && req.method === 'GET') {
      try {
        if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
        const result = await browserSessions.events(req, url.searchParams.get('limit'));
        return json(res, 200, { items: result.items });
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Browser session history unavailable' });
      }
    }
    if (p === '/api/identity/sessions' && req.method === 'DELETE') {
      try {
        if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
        await browserSessions.revokeAll(req);
        return json(res, 200, { ok: true }, { 'set-cookie': browserSessions.clearCookies() });
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Browser session revocation failed' });
      }
    }
    const browserSessionPath = p.match(/^\/api\/identity\/sessions\/([0-9a-fA-F-]+)$/);
    if (browserSessionPath && req.method === 'DELETE') {
      try {
        if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
        const revoked = await browserSessions.revoke(req, browserSessionPath[1], 'user revoked session');
        return json(res, 200, { ok: true }, revoked.current ? { 'set-cookie': browserSessions.clearCookies() } : {});
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Browser session revocation failed' });
      }
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
        let actor;
        let currentSession = null;
        if (!req.headers.authorization && browserSessions) {
          const result = await browserSessions.list(req);
          actor = result.auth.actor;
          if (result.auth.authorityDegraded) actor = { ...actor, authorityDegraded: true };
          currentSession = result.items.find((item) => item.current) || null;
        } else {
          try {
            actor = await verifyAuthed(req);
          } catch (error) {
            const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
            const cached = error?.code === 503 && match && browserSessions
              ? browserSessions.cachedActorForAccessToken(match[1]) : null;
            if (!cached) throw error;
            actor = cached;
          }
        }
        let identity;
        try {
          identity = userFromAuthRow(await getAuthUser(actor.sub), actor.displayName || actor.username || actor.sub);
        } catch (error) {
          if (!actor.authorityDegraded) throw error;
          identity = {
            username: actor.username || actor.sub,
            email: actor.username?.includes('@') ? actor.username : '',
            displayName: actor.displayName || actor.username || actor.sub,
          };
        }
        return json(res, 200, {
          subject: actor.sub,
          username: identity.username || actor.username,
          email: identity.email,
          displayName: actor.displayName || identity.displayName,
          groups: projectedSessionGroups(actor),
          permissions: actor.permissions || [],
          assurance: actor.assurance,
          lastReauthenticatedAt: actor.lastReauthenticatedAt || null,
          authorityDegraded: actor.authorityDegraded === true,
          session: currentSession,
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
    if (p === '/api/internal/monitoring/beszel/events' && req.method === 'POST') {
      try { return json(res, 202, await publishBeszelNotificationEvent(req, await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'Beszel monitoring event rejected' }); }
    }
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
    const externalBackupTargetItem = p.match(/^\/api\/external-channels\/backup-targets\/([0-9a-fA-F-]+)$/);
    if (externalBackupTargetItem && ['PUT', 'DELETE'].includes(req.method)) {
      try {
        const actor = await verifyExternalChannelAdmin(req);
        const body = await readBody(req);
        return json(res, 200, req.method === 'PUT'
          ? await externalChannelApi.updateTarget(actor, externalBackupTargetItem[1], body)
          : await externalChannelApi.removeTarget(actor, externalBackupTargetItem[1], body));
      } catch (e) {
        return json(res, authErrorStatus(e), {
          error: e.msg || 'external backup target mutation failed',
          ...(e.field ? { field: e.field } : {}),
        });
      }
    }
    const externalBackupTargetAction = p.match(/^\/api\/external-channels\/backup-targets\/([0-9a-fA-F-]+)\/(test|backup|enable|disable)$/);
    if (externalBackupTargetAction && req.method === 'POST') {
      try {
        const actor = await verifyExternalChannelAdmin(req);
        const [, id, action] = externalBackupTargetAction;
        const body = await readBody(req);
        if (action === 'enable' || action === 'disable') {
          return json(res, 200, await externalChannelApi.setTargetEnabled(actor, id, action === 'enable', body));
        }
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
        return json(res, authErrorStatus(e), { error: e.msg || 'State Change Authority status unavailable' });
      }
    }
    if (p === '/api/platform/gitea/bootstrap/argocd-verification' && req.method === 'POST') {
      try {
        const actor = await verifyConsoleAdmin(req);
        return json(res, 200, await bootstrapArgocdVerification(actor, await readBody(req)));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Argo CD verification bootstrap failed' });
      }
    }
    if (p === '/api/platform/contracts' && req.method === 'GET') {
      try { await verifyConsoleAdmin(req); return json(res, 200, { items: await consumerContracts(), checkedAt: new Date().toISOString() }); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'consumer contracts unavailable' }); }
    }
    if (p === '/api/platform/releases/status' && req.method === 'GET') {
      try { await verifyConsoleAdmin(req); return json(res, 200, await platformReleaseStatus()); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'Platform Release status unavailable' }); }
    }
    if (p === '/api/platform/releases/component-target' && req.method === 'POST') {
      try {
        const actor = await verifyConsoleAdmin(req, { requireAal2: true });
        return json(res, 200, await generatePlatformComponentTarget(actor, await readBody(req)));
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'Platform component release target generation failed' });
      }
    }
    if (p === '/api/platform/releases/local-edge-automation' && req.method === 'POST') {
      try { return json(res, 202, await executeLocalEdgePlatformRelease(req, await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'local edge Platform Release automation failed' }); }
    }
    if (p === '/api/platform/releases/local-edge-automation/pfss' && req.method === 'POST') {
      try { return json(res, 202, await executePfssLocalEdgePlatformRelease(req, await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'PFSS local edge Platform Release automation failed' }); }
    }
    const pfssLocalEdgeResume = p.match(/^\/api\/platform\/releases\/local-edge-automation\/pfss\/([^/]+)$/);
    if (pfssLocalEdgeResume && req.method === 'GET') {
      try { return json(res, 200, await pfssLocalEdgePlatformReleaseResume(req, decodeURIComponent(pfssLocalEdgeResume[1]))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'PFSS local edge Platform Release resume unavailable' }); }
    }
    const localEdgeReceipt = p.match(/^\/api\/platform\/releases\/local-edge-automation\/([0-9a-f-]+)$/i);
    if (localEdgeReceipt && req.method === 'GET') {
      try { return json(res, 200, await localEdgePlatformReleaseReceipt(req, localEdgeReceipt[1])); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'local edge Platform Release receipt unavailable' }); }
    }
    if (p === '/api/platform/os-shell/feature-state' && req.method === 'GET') {
      try { const actor = await verifyConsoleAdmin(req); requireActorPermission(actor, 'console.identity.manage'); return json(res, 200, await osShellFeatureState()); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'OS Shell feature state unavailable' }); }
    }
    if (p === '/api/platform/os-shell/feature-state' && req.method === 'PUT') {
      try { const actor = await verifyConsoleAdmin(req); return json(res, 200, await setOsShellFeatureState(actor, await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), {
        error: e.msg || 'OS Shell feature operation failed', ...(e.nextAction ? { nextAction: e.nextAction } : {}),
      }); }
    }
    if (p === '/api/platform/os-shell/feature-state/local-edge-automation' && req.method === 'GET') {
      try { const actor = await verifyLocalEdgeAutomation(req); return json(res, 200, {
        contract: 'opensphere-shell-feature-operation/v1', authority: actor.username, state: await osShellFeatureState(),
      }); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'local edge OS Shell feature status failed' }); }
    }
    if (p === '/api/platform/os-shell/feature-state/local-edge-automation' && req.method === 'PUT') {
      try { return json(res, 200, await setOsShellFeatureStateLocalEdge(req, await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'local edge OS Shell feature operation failed' }); }
    }
    if (p === '/api/platform/os-shell/feature-state/local-edge-automation/scale-down-claim' && req.method === 'POST') {
      try { return json(res, 200, await advanceOsShellScaleDownLocalEdge(req, await readBody(req), 'claim')); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'local edge OS Shell scale-down claim failed' }); }
    }
    if (p === '/api/platform/os-shell/feature-state/local-edge-automation/scale-down-complete' && req.method === 'POST') {
      try { return json(res, 200, await advanceOsShellScaleDownLocalEdge(req, await readBody(req), 'complete')); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'local edge OS Shell scale-down completion failed' }); }
    }
    if (p === '/api/internal/os-shell-authn' && req.method === 'GET' && issueOsShellAdmission) {
      try {
        const result = await issueOsShellAdmission(req, (forwarded) => {
          if (!browserSessions) throw { code: 503, msg: 'browser session broker unavailable' };
          return browserSessions.authenticate(forwarded);
        });
        res.writeHead(204, {
          'cache-control': 'no-store',
          'x-os-shell-admission': result.assertion,
          'x-os-shell-permission-revision': result.permissionRevision,
        });
        return res.end();
      } catch (e) {
        return json(res, authErrorStatus(e), { error: e.msg || 'OS Shell admission failed' }, { 'cache-control': 'no-store' });
      }
    }
    const changeTemplateStatusPath = p.match(/^\/api\/platform\/change-templates\/([a-z0-9-]+)\/status$/);
    if (changeTemplateStatusPath && req.method === 'GET') {
      try { await verifyConsoleAdmin(req); return json(res, 200, await changeTemplateRequestStatus(changeTemplateStatusPath[1])); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'change template request status unavailable' }); }
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
    const changeRetryPath = p.match(/^\/api\/platform\/changes\/([0-9a-fA-F-]+)\/retry$/);
    if (changeRetryPath && req.method === 'POST') {
      try { const actor = await verifyConsoleAdmin(req); return json(res, 202, await retryGovernedChange(actor, changeRetryPath[1], await readBody(req))); }
      catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'governed change retry failed' }); }
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

    const mMfaReset = p.match(/^\/api\/identity\/users\/([0-9a-fA-F-]+)\/mfa\/reset$/);
    if (mMfaReset && req.method === 'POST') {
      let actor;
      let reason;
      const userId = mMfaReset[1];
      const opId = newOpId();
      try {
        actor = await verifyActor(req);
        reason = managementReason((await readBody(req).catch(() => ({}))).reason);
        if (!reason) return json(res, 400, { error: 'reason은 8자 이상 필수 (IGA)', minimumLength: 8 });
        await logAudit(actor, 'iga-mfa-reset', userId, 'attempt', reason, { requestId: opId, phase: 'intent', targetType: 'console-identity-user' });
        if (actor.sub === userId) {
          await logAudit(actor, 'mfa-reset', userId, 'denied', 'administrator cannot reset their own MFA factor', { requestId: opId, phase: 'applied', targetType: 'console-identity-user' });
          return json(res, 403, { error: '본인 OTP는 다른 관리자가 연결 해제해야 합니다' });
        }
        if (!await getOperatorById(userId)) return json(res, 404, { error: 'person not found' });
        const authUser = await getAuthUser(userId);
        if (!authUser) return json(res, 404, { error: 'Supabase Auth user not found' });
        const factors = totpFactorsFromAuthRow(authUser);
        for (const factor of factors) {
          await authAdminRequest(`/admin/users/${userId}/factors/${encodeURIComponent(factor.id)}`, { method: 'DELETE' });
        }
        await logAudit(actor, 'mfa-reset', userId, factors.length ? 'ok' : 'ok-noop', reason, {
          requestId: opId,
          phase: 'applied',
          targetType: 'console-identity-user',
          payloadDigest: toHashHex(canonicalJson({ userId, removedFactorCount: factors.length })),
        });
        return json(res, 200, {
          ok: true,
          removedFactorCount: factors.length,
          reloginRequired: factors.length > 0,
          enrollmentPath: '/me?tab=security&enroll=totp',
          note: factors.length ? 'TOTP factors removed; active sessions are revoked by Supabase Auth.' : 'No TOTP factor was registered.',
        });
      } catch (error) {
        if (actor && reason) {
          await logAudit(actor, 'mfa-reset', userId, 'failed', reason, { requestId: opId, phase: 'failed', targetType: 'console-identity-user' }).catch(() => undefined);
        }
        return json(res, error?.code || 500, { error: error?.msg || 'OTP 연결 해제 실패' });
      }
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

server.listen(PORT, () => {
  console.log(`opensphere-console-backend v${VERSION} listening :${PORT} (Supabase identity/data + catalog + Kubernetes passthrough)`);
  startR2d2OperationWorker();
});

let credentialAuthorityServer = null;
if (OS_SHELL_CREDENTIAL_AUTHORITY_ENABLED) {
  if (!exchangeOsShellCredential || !OS_SHELL_CREDENTIAL_AUTHORITY_CERT_FILE || !OS_SHELL_CREDENTIAL_AUTHORITY_KEY_FILE) {
    throw new Error('OS Shell credential authority requires delegation secret and exact TLS keypair');
  }
  credentialAuthorityServer = https.createServer({
    cert: fs.readFileSync(OS_SHELL_CREDENTIAL_AUTHORITY_CERT_FILE),
    key: fs.readFileSync(OS_SHELL_CREDENTIAL_AUTHORITY_KEY_FILE),
    minVersion: 'TLSv1.3',
  }, async (req, res) => {
    if (req.method === 'GET' && req.url === '/readyz') {
      try {
        const authority = await requireSupabase();
        return json(res, 200, { ...authority, ready: true, service: 'opensphere-shell-credential-authority' }, { 'cache-control': 'no-store' });
      } catch (e) {
        return json(res, 503, { ready: false, service: 'opensphere-shell-credential-authority', error: e.msg || e.message || 'authority unavailable' }, { 'cache-control': 'no-store' });
      }
    }
    if (req.method !== 'POST' || req.url !== '/api/internal/os-shell/credential') {
      res.writeHead(404, { 'cache-control': 'no-store' }); return res.end();
    }
    try { return json(res, 200, await exchangeOsShellCredential(req, await readBody(req)), { 'cache-control': 'no-store' }); }
    catch (e) { return json(res, authErrorStatus(e), { error: e.msg || e.message || 'OS Shell delegated credential exchange failed' }, { 'cache-control': 'no-store' }); }
  });
  credentialAuthorityServer.listen(8444, '0.0.0.0', () => console.log('OS Shell credential authority listening with TLS 1.3 on :8444'));
}

function stopR2d2Worker() { if (r2d2OperationTimer) clearInterval(r2d2OperationTimer); if (credentialAuthorityServer) credentialAuthorityServer.close(); }
process.on('SIGTERM', stopR2d2Worker);
process.on('SIGINT', stopR2d2Worker);

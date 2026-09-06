'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { createHash, createHmac, createPublicKey, timingSafeEqual } = require('node:crypto');
const { Pool } = require('pg');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { createOsShellDatabase } = require('./authority/os-shell-database');
const { createAttachTicket, hashAttachTicket, normalizeSessionIntent } = require('./authority/os-shell-contract');
const { verifyOsShellAdmission } = require('./authority/os-shell-admission');
const { createOsShellConsoleOwnerAdmission } = require('./authority/console-owner-admission');
const { verifyOsShellContextJws } = require('./authority/os-shell-context');
const { loadConfig } = require('./config');
const { createCommandService } = require('./commands');
const { createRegistryCommandProviders } = require('./command-providers');
const { createCommandLedger } = require('./command-ledger');
const { createKubernetesClient, validatedRuntimeIdentity } = require('./kubernetes');
const { buildRuntimePod, shellPodName, USER_NAMESPACE_POLICY } = require('./runtime-template');

const RUNTIME_CONTRACT = 'opensphere-shell-runtime/v1';
const CONTROL_CONTRACT = 'opensphere-shell-control/v1';
const PTY_PROTOCOL = 'opensphere.pty.v1';
const MAX_BODY = 64 << 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hash(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function runtimeCertificatePinned(raw, expected) { return Buffer.isBuffer(raw) && FINGERPRINT.test(String(expected || '')) && exactEqual(hash(raw), expected); }
function status(error) { return Number(error?.status || error?.code) >= 400 && Number(error?.status || error?.code) <= 599 ? Number(error.status || error.code) : 500; }
function json(res, code, body) { const data = Buffer.from(JSON.stringify(body)); res.writeHead(code, { 'content-type': 'application/json', 'content-length': data.length, 'cache-control': 'no-store' }); res.end(data); }
function readBody(req) { return new Promise((resolve, reject) => { const chunks = []; let size = 0; req.on('data', (chunk) => { size += chunk.length; if (size > MAX_BODY) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); } else chunks.push(chunk); }); req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } }); req.on('error', reject); }); }
function close(ws, code, reason) { try { ws.close(code, reason); } catch { ws.terminate(); } }
function exactEqual(left, right) { const a = Buffer.from(String(left || '')); const b = Buffer.from(String(right || '')); return a.length === b.length && timingSafeEqual(a, b); }

function idempotentSessionId(secret, actorId, browserSessionId, idempotencyKey) {
  if (!IDEMPOTENCY_KEY.test(String(idempotencyKey || ''))) {
    const error = new Error('IdempotencyKeyRequired'); error.code = 'IdempotencyKeyRequired'; error.status = 400; throw error;
  }
  const bytes = createHmac('sha256', secret).update('opensphere-shell-idempotency/v1\0')
    .update(String(actorId)).update('\0').update(String(browserSessionId)).update('\0').update(String(idempotencyKey).toLowerCase()).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function releaseReadiness(config) { return { runtimeImageDigest: config.runtimeImageDigest, osArtifactDigest: config.osArtifactDigest,
  manifestSha256: config.manifestSha256, releaseEvidenceRef: config.releaseEvidenceRef,
  sessionPolicyRevision: config.sessionPolicyRevision, runtimeTemplateRevision: config.runtimeTemplateRevision,
  runtimeMaxProcesses: config.runtimeMaxProcesses, runtimeGlobalPodLimit: config.runtimeGlobalPodLimit,
  userNamespacePolicy: USER_NAMESPACE_POLICY }; }

function probeComponentReadiness(target, expectedMode, config, { request = http.request } = {}) {
  const url = new URL(target); if (url.protocol !== 'http:' || url.pathname !== '/readyz' || url.search || url.hash) return Promise.resolve(false);
  return new Promise((resolve) => {
    const probe = request(url, { method: 'GET', headers: { accept: 'application/json' } }, (response) => {
      const chunks = []; let size = 0; response.on('data', (chunk) => { size += chunk.length; if (size <= 16 << 10) chunks.push(chunk); });
      response.on('end', () => { let body; try { body = size <= 16 << 10 ? JSON.parse(Buffer.concat(chunks)) : null; } catch { body = null; }
        const expectedRelease = releaseReadiness(config); const observedRelease = body?.release;
        resolve(response.statusCode === 200 && body?.ready === true && body?.mode === expectedMode
          && observedRelease && Object.keys(expectedRelease).every((key) => observedRelease[key] === expectedRelease[key])); });
    });
    probe.setTimeout(1500, () => probe.destroy(new Error('readiness timeout'))); probe.on('error', () => resolve(false)); probe.end();
  });
}

function probeTlsDependencyReadiness(target, expectedService, config,
  { request = https.request, readCA = (file) => fs.readFileSync(file) } = {}) {
  const url = new URL(target);
  if (url.protocol !== 'https:' || url.pathname !== '/readyz' || url.search || url.hash) return Promise.resolve(false);
  return new Promise((resolve) => {
    let ca; try { ca = readCA(config.internalCAFile); } catch { return resolve(false); }
    const probe = request(url, { method: 'GET', ca, rejectUnauthorized: true, minVersion: 'TLSv1.3', servername: url.hostname,
      headers: { accept: 'application/json' } }, (response) => {
      const chunks = []; let size = 0; response.on('data', (chunk) => { size += chunk.length; if (size <= 16 << 10) chunks.push(chunk); });
      response.on('end', () => { let body; try { body = size <= 16 << 10 ? JSON.parse(Buffer.concat(chunks)) : null; } catch { body = null; }
        resolve(response.statusCode === 200 && body?.ready === true && body?.service === expectedService); });
    });
    probe.setTimeout(1500, () => probe.destroy(new Error('readiness timeout'))); probe.on('error', () => resolve(false)); probe.end();
  });
}

function publicSession(row) {
  return { sessionId: row.session_id, sessionClass: row.session_class, runtimeAdapterId: row.runtime_adapter_id,
    generation: Number(row.generation), fencingEpoch: Number(row.fencing_epoch), desiredState: row.desired_state,
    observedState: row.observed_state, expiresAt: row.absolute_expires_at, idleExpiresAt: row.idle_expires_at,
    createdAt: row.created_at, updatedAt: row.updated_at, release: { runtimeImageDigest: row.runtime_image_digest,
      osArtifactDigest: row.os_artifact_digest, releaseEvidenceRef: row.release_evidence_ref,
      sessionPolicyRevision: row.session_policy_revision } };
}

async function admission(req, config, targetAdmission) {
  if (config.targetOwnerAdmission) return targetAdmission(req);
  if (req.headers.cookie || req.headers.authorization) throw Object.assign(new Error('browser credentials reached OS Shell control'), { status: 403 });
  return verifyOsShellAdmission(req.headers['x-os-shell-admission'], { secret: config.admissionSecret,
    method: req.method, path: new URL(req.url, 'http://control').pathname,
    origin: req.headers['x-os-original-origin'] || req.headers.origin, allowLoopbackHttp: config.allowLoopbackHttp });
}

function bindingFrom(row) { return { sessionId: row.session_id, actorId: row.actor_id, origin: row.origin,
  sessionClass: row.session_class, runtimeAdapterId: row.runtime_adapter_id, networkProfile: row.network_profile,
  runtimeUid: row.runtime_uid, permissionRevision: row.permission_revision, aal: row.aal,
  releaseEvidenceRef: row.release_evidence_ref, generation: Number(row.generation), fencingEpoch: Number(row.fencing_epoch) }; }

function exactBinding(row, candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const expected = bindingFrom(row); const expectedKeys = Object.keys(expected).sort(); const actualKeys = Object.keys(candidate).sort();
  return expectedKeys.length === actualKeys.length && expectedKeys.every((key, index) => key === actualKeys[index])
    && expectedKeys.every((key) => candidate[key] === expected[key]);
}

function claimsBinding(claims) { return { sessionId: claims.sessionId, actorId: claims.actorId, runtimeUid: claims.runtimeUid,
  generation: claims.generation, fencingEpoch: claims.fencingEpoch, permissionRevision: claims.permissionRevision, aal: claims.aal }; }

function unverifiedContext(compact) { try { const parts = String(compact).split('.'); return parts.length === 3 ? JSON.parse(Buffer.from(parts[1], 'base64url')) : null; } catch { return null; } }

function browserFrame(value, previous, rate) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.sequence) || value.sequence <= previous) throw new Error('non-monotonic browser frame');
  const now = Date.now(); if (now - rate.started >= 1000) { rate.started = now; rate.frames = 0; rate.bytes = 0; }
  rate.frames += 1;
  const output = { type: value.type, seq: value.sequence };
  if (value.type === 'stdin' && typeof value.data === 'string' && Buffer.byteLength(value.data) <= 8192) {
    rate.bytes += Buffer.byteLength(value.data); output.data = Buffer.from(value.data).toString('base64').replace(/=+$/, '');
  } else if (value.type === 'resize' && Number.isInteger(value.cols) && value.cols >= 2 && value.cols <= 500
      && Number.isInteger(value.rows) && value.rows >= 2 && value.rows <= 200) { output.columns = value.cols; output.rows = value.rows; }
  else if (value.type !== 'ping' && value.type !== 'detach') throw new Error('browser frame contract rejected');
  if (rate.frames > 60 || rate.bytes > 64 << 10) throw new Error('browser frame rate exceeded');
  return output;
}

function runtimeFrame(value, previous, sessionId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.seq) || value.seq <= previous) throw new Error('non-monotonic runtime frame');
  const output = { type: value.type, sequence: value.seq };
  if (value.type === 'attached') output.sessionId = sessionId;
  else if ((value.type === 'stdout' || value.type === 'stderr') && typeof value.data === 'string') {
    const decoded = Buffer.from(value.data, 'base64'); if (decoded.length > 64 << 10) throw new Error('runtime output too large'); output.data = decoded.toString('utf8');
  } else if (value.type === 'exit' && Number.isInteger(value.code)) output.code = value.code;
  else if (value.type === 'pong') { /* closed frame */ }
  else if ((value.type === 'error' || value.type === 'revoked') && typeof value.message === 'string' && value.message.length <= 1024) {
    output.code = typeof value.code === 'string' && value.code.length <= 128 ? value.code : 'RuntimeRejected'; output.message = value.message;
  } else throw new Error('runtime frame contract rejected');
  return output;
}

function validatedRuntimePublicKey(publicKeyPem, submittedKeyId) {
  const pem = String(publicKeyPem || '');
  if (Buffer.byteLength(pem) < 64 || Buffer.byteLength(pem) > 4096
      || (pem.match(/-----BEGIN PUBLIC KEY-----/g) || []).length !== 1
      || (pem.match(/-----END PUBLIC KEY-----/g) || []).length !== 1
      || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(pem)) throw Object.assign(new Error('runtime public key PEM rejected'), { status: 400 });
  let key; try { key = createPublicKey(pem); } catch { throw Object.assign(new Error('runtime public key PEM rejected'), { status: 400 }); }
  if (key.asymmetricKeyType !== 'ed25519') throw Object.assign(new Error('runtime public key must be Ed25519'), { status: 400 });
  const jwk = key.export({ format: 'jwk' }); const keyId = createHash('sha256').update(Buffer.from(jwk.x, 'base64url')).digest('base64url');
  if (!exactEqual(keyId, submittedKeyId)) throw Object.assign(new Error('runtime key ID binding rejected'), { status: 400 });
  return keyId;
}

async function delegatedCredential(config, binding, contextJws, { request = https.request, readCA = (file) => fs.readFileSync(file) } = {}) {
  const target = new URL('/api/internal/os-shell/credential', config.consoleBackendURL);
  const payload = Buffer.from(JSON.stringify({ binding, contextJws }));
  return new Promise((resolve, reject) => {
    const exchange = request(target, { method: 'POST', ca: readCA(config.internalCAFile), rejectUnauthorized: true,
      minVersion: 'TLSv1.3', servername: target.hostname, headers: { 'content-type': 'application/json',
        'content-length': payload.length, 'x-os-shell-delegation-secret': config.delegationSecret } }, (response) => {
      const chunks = []; let size = 0; response.on('data', (chunk) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk); });
      response.on('end', () => { let body = {}; try { body = size <= MAX_BODY ? JSON.parse(Buffer.concat(chunks)) : {}; } catch { body = {}; }
        if (response.statusCode < 200 || response.statusCode >= 300 || !body.accessToken || !body.tokenExpiresAt) return reject(Object.assign(new Error('delegated credential exchange rejected'), { status: 502 })); resolve(body); });
    });
    exchange.setTimeout(4000, () => exchange.destroy(new Error('credential authority timeout'))); exchange.on('error', reject); exchange.end(payload);
  });
}

function createControl({ config = loadConfig(), database, kubernetes,
  componentReadinessProbe = probeComponentReadiness,
  dependencyReadinessProbe = probeTlsDependencyReadiness,
  internalServerFactory = (files, handler) => https.createServer({ cert: fs.readFileSync(files.certFile),
    key: fs.readFileSync(files.keyFile), minVersion: 'TLSv1.3' }, handler) } = {}) {
  const pool = database ? null : (config.enabled ? new Pool(config.database) : null);
  const db = database || (pool && createOsShellDatabase({ query: (text, values) => pool.query(text, values), allowLoopbackHttp: config.allowLoopbackHttp }));
  const targetAdmission = config.targetOwnerAdmission ? createOsShellConsoleOwnerAdmission({
    baseUrl: config.consoleOwnerAuthorityURL,
    publicOrigin: config.publicOrigin,
    allowLoopbackHttp: config.allowLoopbackHttp,
    resolvePermissionRevision: (subjectId) => db.currentPermissionRevision(subjectId),
  }) : null;
  const kube = kubernetes || (config.enabled && config.mode === 'reconciler' ? createKubernetesClient() : null);
  const active = new Map();
  const commands = config.targetOwnerAdmission ? createCommandService({identityUrl:config.consoleOwnerAuthorityURL,
    clusterManagerUrl:config.clusterManagerURL,loadProviders:config.commandRegistryURL?createRegistryCommandProviders({registryUrl:config.commandRegistryURL}):undefined,ledger:pool?createCommandLedger((sql,values)=>pool.query(sql,values)):null}) : null;
  let lastReconcileSuccess = 0;

  async function componentReadiness() {
    if (config.mode !== 'api') return { gateway: true, reconciler: true, credentialAuthority: true, consoleApi: true };
    const [gateway, reconciler, credentialAuthority, consoleApi] = await Promise.all([
      componentReadinessProbe(config.gatewayReadinessURL, 'gateway', config),
      componentReadinessProbe(config.reconcilerReadinessURL, 'reconciler', config),
      dependencyReadinessProbe(config.credentialAuthorityReadinessURL, 'opensphere-shell-credential-authority', config),
      dependencyReadinessProbe(config.consoleAPIReadinessURL, 'supabase-data-identity', config),
    ]);
    return { gateway, reconciler, credentialAuthority, consoleApi };
  }

  async function browserApi(req, res, path, claims) {
    if (path === '/api/os-shell/readiness' && req.method === 'GET') { await db.currentPermissionRevision(claims.sub, claims.permissionRevision);
      const feature = await db.featureState(); const components = await componentReadiness();
      const policyExact = Number(feature.global_active_limit) === config.runtimeGlobalPodLimit;
      const ready = config.enabled && feature.enabled === true && policyExact && config.mode === 'api' && Object.values(components).every(Boolean);
      return json(res, 200, { readiness: {
      authorized: true, enabled: config.enabled && feature.enabled === true, ready, components,
      feature: { revision: Number(feature.revision), activeSessions: Number(feature.active_sessions), scaleDownAllowed: feature.scale_down_allowed === true },
      blocker: ready ? null : { code: feature.enabled !== true ? 'ShellFeatureDisabled' : !policyExact ? 'ShellQuotaPolicyDrift' : !components.gateway ? 'ShellGatewayUnavailable' : !components.reconciler ? 'ShellReconcilerUnavailable'
        : !components.credentialAuthority ? 'ShellCredentialAuthorityUnavailable' : 'ShellConsoleApiUnavailable',
        nextAction: 'Restore the exact-digest CBSS components, credential authority, and canonical Console API frontdoor.' },
      observedAt: new Date().toISOString(), sessionClass: 'operator-interactive', runtimeAdapterId: 'cbss.kubernetes-pod', networkProfile: 'console-only',
      release: releaseReadiness(config) } }); }
    if (config.mode !== 'api') throw Object.assign(new Error('browser API is not served by this mode'), { status: 404 });
    if (path === '/api/os-shell/sessions' && req.method === 'GET') {
      const items = await db.listSessions({ browserSessionId: claims.browserSessionId, actorId: claims.sub, permissionRevision: claims.permissionRevision });
      return json(res, 200, { items: items.map(publicSession) });
    }
    if (path === '/api/os-shell/sessions' && req.method === 'POST') {
      normalizeSessionIntent(await readBody(req));
      const now = Date.now(); const absolute = Math.min(Date.parse(claims.browserAbsoluteExpiresAt), now + 60 * 60_000);
      const idle = Math.min(Date.parse(claims.browserIdleExpiresAt), absolute, now + 15 * 60_000);
      if (!Number.isFinite(idle) || idle <= now + 5000 || absolute < idle) throw Object.assign(new Error('browser session lifetime is insufficient'), { status: 409 });
      const row = await db.createSession({ sessionId: idempotentSessionId(config.admissionSecret, claims.sub, claims.browserSessionId,
        req.headers['x-os-idempotency-key']), browserSessionId: claims.browserSessionId, actorId: claims.sub,
        origin: claims.origin, aal: claims.aal, permissionRevision: claims.permissionRevision,
        runtimeTemplateRevision: config.runtimeTemplateRevision, idleExpiresAt: new Date(idle).toISOString(), absoluteExpiresAt: new Date(absolute).toISOString(),
        releaseEvidence: { releaseEvidenceRef: config.releaseEvidenceRef, manifestSha256: config.manifestSha256,
          keyId: config.releaseKeyId, runtimeImageDigest: config.runtimeImageDigest, osArtifactDigest: config.osArtifactDigest,
          sessionPolicyRevision: config.sessionPolicyRevision } });
      return json(res, 201, { session: publicSession(row) });
    }
    const match = path.match(/^\/api\/os-shell\/sessions\/([0-9a-f-]{36})(?:\/(attach-ticket))?$/i);
    if (!match || !UUID.test(match[1])) throw Object.assign(new Error('OS Shell API route not found'), { status: 404 });
    const base = { sessionId: match[1], browserSessionId: claims.browserSessionId, actorId: claims.sub,
      origin: claims.origin, permissionRevision: claims.permissionRevision };
    if (!match[2] && req.method === 'GET') { const row = await db.getSession(base); if (!row) throw Object.assign(new Error('session not found'), { status: 404 }); return json(res, 200, { session: publicSession(row) }); }
    if (!match[2] && req.method === 'DELETE') { const row = await db.requestTeardown({ ...base, reasonCode: 'OperatorRequested' }); if (!row) throw Object.assign(new Error('session not found'), { status: 404 }); return json(res, 202, { session: publicSession(row) }); }
    if (match[2] && req.method === 'POST') {
      const row = await db.getSession(base); if (!row) throw Object.assign(new Error('session not found'), { status: 404 });
      const ticket = createAttachTicket(); const expiresAt = new Date(Date.now() + 25_000).toISOString();
      await db.issueAttachTicket({ ...base, aal: claims.aal, generation: row.generation, fencingEpoch: row.fencing_epoch,
        ticketHash: ticket.ticketHash, expiresAt });
      return json(res, 201, { attachTicket: { ticket: ticket.ticket, expiresAt, protocol: PTY_PROTOCOL,
        sessionId: row.session_id, generation: Number(row.generation), fencingEpoch: Number(row.fencing_epoch) } });
    }
    throw Object.assign(new Error('method not allowed'), { status: 405 });
  }

  async function runtimeApi(req, res, path) {
    if (config.mode !== 'api' || !config.runtimeControlEnabled) throw Object.assign(new Error('runtime control disabled'), { status: 404 });
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/); if (!match) throw Object.assign(new Error('runtime credential required'), { status: 401 });
    const credentialHash = hash(match[1]); const body = await readBody(req);
    if (body.contract !== CONTROL_CONTRACT) throw Object.assign(new Error('runtime control contract mismatch'), { status: 400 });
    if (path.endsWith('/credential')) {
      const claims = unverifiedContext(body.contextJws); if (!claims) throw Object.assign(new Error('context JWS required'), { status: 400 });
      const row = await db.revalidateRuntime({ runtimeCredentialHash: credentialHash, sessionId: claims.sessionId,
        runtimeUid: claims.runtimeUid, generation: claims.generation, fencingEpoch: claims.fencingEpoch });
      if (!row) throw Object.assign(new Error('runtime credential revoked'), { status: 403 });
      verifyOsShellContextJws(body.contextJws, row);
      const delegated = await delegatedCredential(config, bindingFrom(row), body.contextJws);
      return json(res, 200, { contract: CONTROL_CONTRACT, ...delegated });
    }
    const binding = body.binding || {};
    if (path.endsWith('/attach-authorize')) {
      const attach = body.attach || {}; const row = await db.authorizeRuntimeAttach({ runtimeCredentialHash: credentialHash,
        ticket: attach.ticket, sessionId: binding.sessionId, runtimeUid: binding.runtimeUid,
        generation: binding.generation, fencingEpoch: binding.fencingEpoch });
      if (!row || !exactBinding(row, binding)) throw Object.assign(new Error('runtime attach rejected'), { status: 403 });
      return json(res, 200, { contract: CONTROL_CONTRACT, authorized: true, state: 'Active' });
    }
    if (path.endsWith('/revalidate')) {
      const row = await db.revalidateRuntime({ runtimeCredentialHash: credentialHash, sessionId: binding.sessionId,
        runtimeUid: binding.runtimeUid, generation: binding.generation, fencingEpoch: binding.fencingEpoch });
      if (!row || !exactBinding(row, binding)) throw Object.assign(new Error('runtime authorization revoked'), { status: 403 });
      return json(res, 200, { contract: CONTROL_CONTRACT, authorized: true, state: 'Active' });
    }
    throw Object.assign(new Error('runtime control route not found'), { status: 404 });
  }

  async function registerRuntime(req, res) {
    if (config.mode !== 'reconciler' || !config.registrationEnabled) throw Object.assign(new Error('runtime registration disabled'), { status: 404 });
    const token = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/)?.[1]; if (!token) throw Object.assign(new Error('projected bootstrap token required'), { status: 401 });
    const body = await readBody(req); if (body.contract !== RUNTIME_CONTRACT || !FINGERPRINT.test(body.tlsCertificateSha256)
      || !/^sha256:[a-f0-9]{64}$/.test(String(body.runtimeCredentialHash || ''))) throw Object.assign(new Error('runtime registration contract rejected'), { status: 400 });
    validatedRuntimePublicKey(body.publicKeyPem, body.keyId);
    const identity = validatedRuntimeIdentity(await kube.tokenReview(token), { namespace: config.namespace, serviceAccount: config.runtimeServiceAccount });
    const pod = await kube.getPod(config.namespace, identity.podName); const labels = pod.metadata?.labels || {}; const binding = body.binding || {};
    if (pod.metadata?.uid !== identity.podUid || binding.runtimeUid !== identity.podUid
      || labels['opensphere.io/session-id'] !== binding.sessionId || Number(labels['opensphere.io/generation']) !== Number(binding.generation)
      || Number(labels['opensphere.io/fencing-epoch']) !== Number(binding.fencingEpoch) || !pod.status?.podIP) throw Object.assign(new Error('bound runtime Pod identity changed'), { status: 403 });
    const row = await db.classifyRuntimeRegistration({ sessionId: binding.sessionId,
      generation: binding.generation, fencingEpoch: binding.fencingEpoch });
    if (row?.observed_state === 'Pending') throw Object.assign(new Error('RuntimeRegistrationNotReady'), {
      status: 409, code: 'RuntimeRegistrationNotReady',
    });
    if (!row || !exactBinding(row, binding)) throw Object.assign(new Error('runtime registration fence rejected'), { status: 403 });
    const host = pod.status.podIP.includes(':') ? `[${pod.status.podIP}]` : pod.status.podIP;
    const expiry = new Date(Math.min(Date.now() + 60 * 60_000, Date.parse(row.absolute_expires_at))).toISOString();
    let registered;
    try { registered = await db.registerRuntime({ sessionId: row.session_id, actorId: row.actor_id, worker: row.lease_owner,
      generation: row.generation, fencingEpoch: row.fencing_epoch, permissionRevision: row.permission_revision,
      runtimeUid: pod.metadata.uid, runtimeResourceVersion: pod.metadata.resourceVersion, runtimeKeyId: body.keyId,
      runtimePublicKeyPem: body.publicKeyPem, runtimeTlsCertificateSha256: body.tlsCertificateSha256,
      runtimeAttachEndpoint: `wss://${host}:8443/v1/runtime/attach`, runtimeCredentialHash: body.runtimeCredentialHash, runtimeCredentialExpiresAt: expiry }); }
    catch (error) { if (error.code === '40001') error.status = 403; throw error; }
    return json(res, 200, { contract: RUNTIME_CONTRACT, binding, runtimeCredentialHash: body.runtimeCredentialHash,
      runtimeCredentialExpiresAt: registered.runtime_credential_expires_at });
  }

  async function handler(req, res) {
    const path = new URL(req.url, 'http://control').pathname;
    try {
      if (path === '/healthz') { res.writeHead(204); return res.end(); }
      if (path === '/readyz') {
        let dbReady = false;
        try { dbReady = config.enabled && await db.health(config.mode); } catch { dbReady = false; }
        const reconcilerFresh = config.mode !== 'reconciler' || !config.reconcilerEnabled || Date.now() - lastReconcileSuccess < 10_000;
        const components = dbReady ? await componentReadiness() : { gateway: false, reconciler: false, credentialAuthority: false, consoleApi: false };
        const componentsReady = Object.values(components).every(Boolean);
        return dbReady && reconcilerFresh && componentsReady ? json(res, 200, { ready: true, mode: config.mode, database: 'ready',
          reconciler: reconcilerFresh ? 'fresh' : 'stale', components, release: releaseReadiness(config) })
          : json(res, 503, { ready: false, mode: config.mode, database: dbReady ? 'ready' : 'unavailable', components,
            blocker: { code: !dbReady ? 'ShellDatabaseUnavailable' : !reconcilerFresh ? 'ShellReconcilerStale'
              : !components.gateway ? 'ShellGatewayUnavailable' : !components.reconciler ? 'ShellReconcilerUnavailable'
                : !components.credentialAuthority ? 'ShellCredentialAuthorityUnavailable' : 'ShellConsoleApiUnavailable',
            nextAction: 'Restore CBSS database/RPC, exact release projection, and reconciler authority.' } });
      }
      if (!config.enabled) throw Object.assign(new Error('OS Shell control disabled'), { status: 503 });
      if (path === '/api/os-shell/commands' && ['GET','POST'].includes(req.method)) {
        if (!commands || config.mode !== 'api') throw Object.assign(new Error('OS Shell command service unavailable'), {status:503});
        if (new URL(req.url,'http://control').search) throw Object.assign(new Error('command query is not supported'), {status:400});
        if (req.method === 'GET') return json(res,200,await commands.catalog(req));
        const result = await commands.execute(req,await readBody(req));
        return json(res,result.status,result.body);
      }
      const internalPath = path === '/internal/runtime/register' || path.startsWith('/api/os-shell/runtime/');
      if (internalPath && !req.socket.encrypted) throw Object.assign(new Error('internal runtime routes require TLS'), { status: 404 });
      if (!internalPath && req.socket.encrypted) throw Object.assign(new Error('browser routes are not served on the internal listener'), { status: 404 });
      if (path === '/internal/runtime/register' && req.method === 'POST') return await registerRuntime(req, res);
      if (path.startsWith('/api/os-shell/runtime/') && req.method === 'POST') return await runtimeApi(req, res, path);
      const claims = await admission(req, config, targetAdmission); return await browserApi(req, res, path, claims);
    } catch (error) { return json(res, status(error), { error: error.code || 'ShellControlFailed', message: error.message || 'OS Shell control failed', ...(path === '/api/os-shell/commands' ? {controlPlane:'OS-Shell',sideEffect:error.sideEffect||'none'} : {}) }); }
  }

  async function reprojectStaleRuntime(row) {
    const name = shellPodName(row.session_id);
    try {
      const pod = await kube.getPod(config.namespace, name);
      if (pod.metadata?.uid !== row.runtime_uid || pod.metadata?.labels?.['opensphere.io/session-id'] !== row.session_id) {
        throw new Error('stale runtime Pod UID cannot be safely deleted');
      }
      await kube.deletePod(config.namespace, name, pod.metadata.uid);
    } catch (error) { if (error.status !== 404) throw error; }
    return db.reprojectRuntime({ sessionId: row.session_id, actorId: row.actor_id, worker: config.worker,
      generation: row.generation, fencingEpoch: row.fencing_epoch, expectedRuntimeUid: row.runtime_uid, reasonCode: 'LeaseFenceRecovered' });
  }

  async function reconcile(row, reclaimed = false) {
    const base = { sessionId: row.session_id, actorId: row.actor_id, worker: config.worker,
      generation: row.generation, fencingEpoch: row.fencing_epoch, permissionRevision: row.permission_revision };
    if (row.desired_state === 'Running' && (Date.parse(row.idle_expires_at) <= Date.now() || Date.parse(row.absolute_expires_at) <= Date.now())) {
      row = await db.revokeSessionAuthority({ ...base, reasonCode: 'SessionExpired' });
    }
    if (row.desired_state === 'Terminated') {
      if (row.observed_state !== 'Terminating') row = await db.transitionSession({ ...base, expectedState: row.observed_state, nextState: 'Terminating', runtimeUid: row.runtime_uid, reasonCode: 'TeardownReconciled' });
      if (row.runtime_uid) await kube.deletePod(config.namespace, shellPodName(row.session_id), row.runtime_uid);
      await db.transitionSession({ ...base, expectedState: 'Terminating', nextState: 'Terminated', runtimeUid: row.runtime_uid, reasonCode: 'RuntimeDeleted' }); active.delete(row.session_id); return;
    }
    if (reclaimed && ['Provisioning', 'Ready', 'Failed'].includes(row.observed_state)) {
      row = await reprojectStaleRuntime(row);
      return reconcile(row, false);
    }
    if (row.observed_state === 'Pending') {
      let pod;
      try { pod = await kube.createPod(config.namespace, buildRuntimePod(row, config)); }
      catch (error) {
        if (error.status !== 409) throw error;
        const stale = await kube.getPod(config.namespace, shellPodName(row.session_id));
        if (stale.metadata?.labels?.['opensphere.io/session-id'] !== row.session_id) throw new Error('colliding runtime Pod is not owned by the session');
        await kube.deletePod(config.namespace, stale.metadata.name, stale.metadata.uid);
        pod = await kube.createPod(config.namespace, buildRuntimePod(row, config));
      }
      row = await db.transitionSession({ ...base, expectedState: 'Pending', nextState: 'Provisioning', runtimeUid: pod.metadata.uid,
        runtimeResourceVersion: pod.metadata.resourceVersion, reasonCode: 'RuntimePodCreated' });
    } else if (row.observed_state === 'Provisioning' && row.runtime_registered_at) {
      row = await db.transitionSession({ ...base, expectedState: 'Provisioning', nextState: 'Ready', runtimeUid: row.runtime_uid,
        runtimeResourceVersion: row.runtime_resource_version, reasonCode: 'RuntimeRegistered' });
    } else if (row.observed_state === 'Provisioning' && Date.parse(row.runtime_projection_started_at) + 45_000 <= Date.now()) {
      row = await reprojectStaleRuntime(row);
      return reconcile(row, false);
    }
    active.set(row.session_id, row);
  }

  async function tick() {
    if (!config.enabled || config.mode !== 'reconciler' || !config.reconcilerEnabled) return;
    await kube.listPods(config.namespace, 1);
    for (const row of [...active.values()]) {
      try { if (!await db.heartbeatSession({ sessionId: row.session_id, actorId: row.actor_id, worker: config.worker,
        generation: row.generation, fencingEpoch: row.fencing_epoch, permissionRevision: row.permission_revision })) active.delete(row.session_id);
      else { const fresh = await db.inspectClaim({ sessionId: row.session_id, worker: config.worker, generation: row.generation, fencingEpoch: row.fencing_epoch });
        if (fresh) await reconcile(fresh, false); else active.delete(row.session_id); } }
      catch { try { const revoked = await db.revokeSessionAuthority({ sessionId: row.session_id, worker: config.worker,
        generation: row.generation, fencingEpoch: row.fencing_epoch, reasonCode: 'PermissionRevisionChanged' }); if (revoked) await reconcile(revoked); } catch { active.delete(row.session_id); } }
    }
    const claimed = await db.claimSessions({ worker: config.worker, limit: 5 });
    for (const row of claimed) { try { await reconcile(row, true); } catch (error) { console.error(JSON.stringify({ event: 'ShellReconcileFailed', sessionId: row.session_id, error: error.message })); } }
    lastReconcileSuccess = Date.now();
  }

  async function attach(req, socket, head) {
    try {
      if (!config.enabled || config.mode !== 'gateway' || !config.attachEnabled) throw new Error('gateway disabled');
      const claims = await admission(req, config, targetAdmission); const path = new URL(req.url, 'http://gateway').pathname;
      const match = path.match(/^\/api\/os-shell\/sessions\/([0-9a-f-]{36})\/attach$/i);
      if (!match || !UUID.test(match[1]) || req.headers['sec-websocket-protocol'] !== PTY_PROTOCOL) throw new Error('attach request rejected');
      wss.handleUpgrade(req, socket, head, (browser) => {
        let attached = false;
        browser.once('message', async (data, binary) => {
          try {
            if (binary || data.length > 4096) throw new Error('attach frame rejected'); const frame = JSON.parse(data);
            if (frame.type !== 'attach' || frame.sessionId !== match[1] || !frame.ticket) throw new Error('attach binding rejected');
            const common = { ticket: frame.ticket, sessionId: match[1], browserSessionId: claims.browserSessionId,
              actorId: claims.sub, origin: claims.origin, aal: claims.aal, permissionRevision: claims.permissionRevision };
            const row = await db.resolveAttachBinding(common);
            if (!row || Number(frame.generation) !== Number(row.generation) || Number(frame.fencingEpoch) !== Number(row.fencing_epoch)) throw new Error('attach ticket unavailable');
            const consumed = await db.consumeAttachTicket({ ...common, generation: row.generation, fencingEpoch: row.fencing_epoch, consumer: config.worker });
            if (!consumed) throw new Error('attach ticket already consumed');
            const activityBinding = { ...common, generation: row.generation, fencingEpoch: row.fencing_epoch };
            if (!await db.touchSessionActivity(activityBinding)) throw new Error('session activity authority rejected attach');
            const runtime = new WebSocket(row.runtime_attach_endpoint, PTY_PROTOCOL, { rejectUnauthorized: false, perMessageDeflate: false, followRedirects: false }); let pinned = false;
            runtime.once('upgrade', (response) => { const raw = response.socket.getPeerCertificate(true)?.raw;
              pinned = runtimeCertificatePinned(raw, row.runtime_tls_certificate_sha256); if (!pinned) runtime.terminate(); });
            runtime.once('open', () => {
              if (!pinned) return runtime.terminate();
              attached = true;
              runtime.send(JSON.stringify({ type: 'attach', seq: 1, sessionId: row.session_id, runtimeUid: row.runtime_uid,
                generation: Number(row.generation), fencingEpoch: Number(row.fencing_epoch), ticket: frame.ticket }));
              let browserSequence = 0; let runtimeSequence = 0; let lastActivityTouch = Date.now(); const rate = { started: Date.now(), frames: 0, bytes: 0 };
              browser.on('message', (payload, isBinary) => { if (isBinary || payload.length > 72 << 10 || runtime.bufferedAmount > 1 << 20) return close(browser, 1013, 'Backpressure');
                try { const out = browserFrame(JSON.parse(payload), browserSequence, rate); browserSequence = out.seq; out.seq += 1; runtime.send(JSON.stringify(out));
                  if ((out.type === 'stdin' || out.type === 'resize') && Date.now() - lastActivityTouch >= 30_000) {
                    lastActivityTouch = Date.now(); void db.touchSessionActivity(activityBinding).then((fresh) => {
                      if (!fresh) close(browser, 1008, 'SessionRevoked');
                    }).catch(() => close(browser, 1008, 'SessionRevoked'));
                  }
                } catch { close(browser, 1003, 'FrameContractInvalid'); } });
              runtime.on('message', (payload, isBinary) => { if (isBinary || payload.length > 72 << 10 || browser.bufferedAmount > 1 << 20) return close(browser, 1013, 'Backpressure');
                try { const out = runtimeFrame(JSON.parse(payload), runtimeSequence, row.session_id); runtimeSequence = out.sequence; browser.send(JSON.stringify(out)); } catch { close(browser, 1003, 'FrameContractInvalid'); } });
              browser.once('close', () => runtime.close()); runtime.once('close', () => browser.close());
            });
            runtime.once('error', () => close(browser, 1011, 'RuntimeUnavailable'));
          } catch { close(browser, 1008, 'AttachRejected'); }
        });
        setTimeout(() => { if (!attached && browser.readyState === WebSocket.OPEN) close(browser, 1008, 'AttachTimeout'); }, 3000).unref();
      });
    } catch { socket.destroy(); }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 72 << 10, perMessageDeflate: false, clientTracking: false, handleProtocols: (protocols) => protocols.has(PTY_PROTOCOL) ? PTY_PROTOCOL : false });
  const browserServer = http.createServer(handler); browserServer.on('upgrade', attach);
  const internalServer = config.enabled && ((config.mode === 'api' && config.runtimeControlEnabled) || (config.mode === 'reconciler' && config.registrationEnabled))
    ? internalServerFactory({ certFile: config.tlsCertFile, keyFile: config.tlsKeyFile }, handler) : null;
  let timer;
  return Object.freeze({ browserServer, internalServer, tick,
    testContract: Object.freeze({ browserApi, componentReadiness, handler, reconcile, registerRuntime, runtimeApi }),
    start() { browserServer.listen(config.mode === 'reconciler' ? 8080 : config.port);
    if (internalServer) internalServer.listen(8443); if (config.mode === 'reconciler') { timer = setInterval(() => tick().catch((e) => console.error(e.message)), 3000); timer.unref(); void tick(); } },
  async close() { if (timer) clearInterval(timer); await Promise.all([new Promise((r) => browserServer.close(r)), internalServer ? new Promise((r) => internalServer.close(r)) : Promise.resolve()]); if (pool) await pool.end(); } });
}

if (require.main === module) createControl().start();
module.exports = { bindingFrom, browserFrame, createControl, delegatedCredential, exactBinding, idempotentSessionId, publicSession,
  probeComponentReadiness, probeTlsDependencyReadiness, releaseReadiness, runtimeCertificatePinned, runtimeFrame, validatedRuntimePublicKey };

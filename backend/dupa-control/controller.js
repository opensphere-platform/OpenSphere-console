// opensphere-console-dupa-controller (DUPA Admin Control PoC, 계획서 §9 + 검토 §B.1/§B.5)
// 한 Node.js 서비스가 3역할:
//   ① reconcile : UIPluginRegistration desiredState → workload apply/delete + 검증 + registry 생성
//   ② Control API: /api/admin/plugins/* (Admin UI가 호출, kubectl 없이 상태 전이)
//   ③ proxy authorization projection (public Registry는 opensphere-registry 단일 권위)
// 신뢰 루트는 UIPluginPackage(관리자 승인값). controller는 digest를 '계산해 비교'만 하고
// registry에는 승인값을 '전사'한다(§B.5). 이중 검증: 여기(설치 시점) + 셸(로드 시점).
// 의존성 0 (node 내장 http/crypto/fs).
const http = require('http');
const fs = require('fs');
const { execFile } = require('child_process');
const { createHash, createPublicKey, verify, randomBytes, randomUUID } = require('crypto');

const PORT = process.env.PORT || 8080;
const NS = process.env.NAMESPACE || 'opensphere-console';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const API = 'https://kubernetes.default.svc';
const GROUP = 'plugins.opensphere.io';
const V = 'v1alpha1';
const PLATFORM_GROUP = 'platform.opensphere.io';
const PLATFORM_PROFILE_NAME = 'default';
const PLATFORM_PROFILE_PATH = `/apis/${PLATFORM_GROUP}/${V}/namespaces/${NS}/platformsupportprofiles/${PLATFORM_PROFILE_NAME}`;
function foundationDevOverrideEnabled(env = process.env) {
  return env.OPENSPHERE_RUNTIME_MODE === 'development'
    && String(env.FOUNDATION_ACTIVATION_DEV_OVERRIDE || '').toLowerCase() === 'true';
}
// 기본값은 운영 fail-closed. 개발 예외는 두 개의 명시적 플래그가 모두 일치할 때만 열린다.
const FOUNDATION_ACTIVATION_DEV_OVERRIDE = foundationDevOverrideEnabled();
// 셸(브라우저)이 플러그인 manifest/번들에 접근하는 경로 prefix (nginx 프록시 기준)
const SHELL_API_PREFIX = '/api/plugins';
const MAX_BODY = 256 * 1024; // 요청 본문 상한(무제한 버퍼링 차단, 감사 H)
const MODULE_DESCRIPTOR_LABEL = 'io.opensphere.module.descriptor';
const MODULE_SIGNATURE_LABEL = 'io.opensphere.module.descriptor.signature';
const MODULE_KEY_ID_LABEL = 'io.opensphere.module.descriptor.key-id';
const APPROVED_PERMISSION_PROFILES = new Set(['none', 'cluster-observer-v1', 'cluster-infrastructure-manager-v1']);
const ALLOWED_IMAGE = /^ghcr\.io\/opensphere-platform\/(opensphere-[a-z0-9._-]+)(?:@sha256:([a-f0-9]{64})|:(edge|candidate|stable))$/;
const OCI_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const ATTESTATION_PREDICATES = Object.freeze({
  provenance: 'https://slsa.dev/provenance/v1',
  sbom: 'https://spdx.dev/Document/v2.3',
});
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GHCR_PULL_SECRET = process.env.GHCR_PULL_SECRET || 'opensphere-ghcr-pull';
// /api/admin/events는 workload의 projected ServiceAccount token을 TokenReview로 검증한다.
// 모든 plugin에 같은 공유 secret을 배포하지 않아 한 workload 침해가 다른 source 위장으로 번지지 않는다.
const token = () => fs.readFileSync(`${SA}/token`, 'utf8').trim();
// NODE_EXTRA_CA_CERTS는 deployment env로 주입 (Node fetch는 시작 시점에 읽음)

// Console auth is centralized in the Supabase-backed Console identity service.
// Control-plane consumers never verify a parallel IdP token or import an IdP secret.
const CONSOLE_IDENTITY_URL = (process.env.CONSOLE_IDENTITY_URL || 'http://opensphere-console-backend.opensphere-console.svc.cluster.local:8080').replace(/\/$/, '');
const CONSOLE_ADMIN_GROUP = process.env.CONSOLE_ADMIN_GROUP || 'console-admins';
const SUPABASE_REST_URL = (process.env.SUPABASE_REST_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
async function verifyAuthed(req) {
  const authorization = String(req.headers.authorization || '');
  if (!/^Bearer\s+\S+$/i.test(authorization)) throw { code: 401, msg: 'no bearer token' };
  let response;
  try {
    response = await fetch(`${CONSOLE_IDENTITY_URL}/api/identity/session`, {
      headers: { authorization, accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw { code: 503, msg: 'Supabase identity authority unavailable' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw { code: response.status === 403 ? 403 : 401, msg: body.error || 'invalid Supabase session' };
  return { username: body.username || body.subject || 'unknown', subject: body.subject || '', groups: Array.isArray(body.groups) ? body.groups : [], provider: 'supabase' };
}
const isAdminGroups = (groups) => (groups || []).includes(CONSOLE_ADMIN_GROUP);
async function verifyActor(req) {
  const actor = await verifyAuthed(req);
  if (!isAdminGroups(actor.groups)) throw { code: 403, msg: `requires ${CONSOLE_ADMIN_GROUP}` };
  return actor;
}

// ── audit (Supabase audit.event is the durable authority) ──────────────────
// The in-memory ring is only a read cache. Management mutations fail closed
// when the Supabase audit projection is unavailable.
const AUDIT_CAP = 500;
const audit = [];
const auditActorLabel = (actor) => typeof actor === 'object' ? (actor.username || actor.subject || 'system') : (actor || 'system');
const auditActorId = (actor) => typeof actor === 'object' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(actor.subject || '')) ? actor.subject : null;
function logAudit(actor, action, target, result, reason, opId, options = {}) {
  const e = { time: new Date().toISOString(), opId: opId || newOpId(), source: options.source || 'dupa-controller', actor: auditActorLabel(actor), actorId: auditActorId(actor), action, target, result, reason: reason || '' };
  audit.unshift(e);
  if (audit.length > AUDIT_CAP) audit.pop();
  console.log('[audit] ' + JSON.stringify(e));
  if (options.deferPersistence) {
    return e;
  }
  persistAuditNow(e).catch((err) => console.error('[audit] Supabase event insert failed:', String(err).slice(0, 120)));
  return e;
}
async function persistAuditNow(event) {
  if (!SUPABASE_REST_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase audit authority is not configured');
  const requestId = randomUUID();
  const eventHash = createHash('sha256').update(JSON.stringify({ requestId, ...event })).digest('hex');
  const response = await fetch(`${SUPABASE_REST_URL}/event`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      'content-profile': 'audit',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify([{
      request_id: requestId,
      correlation_id: String(event.opId || requestId).slice(0, 128),
      actor_type: event.actorId ? 'human' : 'system', actor_id: event.actorId,
      action: String(event.action).slice(0, 160), target_type: 'console-control', target_id: String(event.target).slice(0, 300),
      reason: String(event.reason || 'Console control operation').slice(0, 1000),
      phase: ['intent', 'authorized', 'committed', 'applied', 'failed', 'reverted'].includes(event.result) ? event.result : 'applied',
      result: String(event.result || 'accepted').slice(0, 64), payload_digest: null,
      event_hash: `sha256:${eventHash}`,
    }]),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Supabase audit HTTP ${response.status}`);
}
async function durableAudit(actor, action, target, result, reason, opId, source = 'dupa-controller') {
  const event = logAudit(actor, action, target, result, reason, opId, { deferPersistence: true, source });
  await persistAuditNow(event);
  return event;
}
function supabaseHeaders(profile) {
  if (!SUPABASE_REST_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw Object.assign(new Error('Supabase Console data authority is not configured'), { code: 503, reason: 'SupabaseUnavailable' });
  }
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'accept-profile': profile,
    'content-profile': profile,
  };
}
async function supabaseRequest(method, resource, { profile = 'console', query = '', body, prefer = 'return=representation' } = {}) {
  const suffix = query ? `?${query}` : '';
  let response;
  try {
    response = await fetch(`${SUPABASE_REST_URL}/${resource}${suffix}`, {
      method,
      headers: { ...supabaseHeaders(profile), Prefer: prefer },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  } catch (error) {
    throw Object.assign(new Error('Supabase Console data authority is unavailable'), { code: 503, reason: 'SupabaseUnavailable', cause: error });
  }
  const text = await response.text();
  let jsonBody = null;
  try { jsonBody = text ? JSON.parse(text) : null; } catch { jsonBody = { message: text.slice(0, 300) }; }
  if (!response.ok) {
    const error = Object.assign(new Error(jsonBody?.message || `Supabase HTTP ${response.status}`), {
      code: response.status === 409 ? 409 : (response.status >= 500 ? 503 : response.status),
      reason: response.status === 409 ? 'ImageAlreadyRevoked' : 'SupabaseRequestFailed',
      detail: jsonBody,
    });
    throw error;
  }
  return jsonBody;
}
async function findImageRevocation(repository, digest) {
  const query = new URLSearchParams({
    select: 'repository,digest,replacement_digest,actor_label,reason,operation_id,revoked_at',
    repository: `eq.${repository}`,
    digest: `eq.${digest}`,
    limit: '1',
  }).toString();
  const rows = await supabaseRequest('GET', 'image_revocation', { query });
  return Array.isArray(rows) ? (rows[0] || null) : null;
}
async function listImageRevocations() {
  const query = new URLSearchParams({
    select: 'repository,digest,replacement_digest,actor_label,reason,operation_id,revoked_at',
    order: 'revoked_at.desc',
    limit: '500',
  }).toString();
  const rows = await supabaseRequest('GET', 'image_revocation', { query });
  return Array.isArray(rows) ? rows : [];
}
async function revokeImage({ repository, digest, replacementDigest, actor, reason, opId }) {
  const requestId = randomUUID();
  const eventHash = createHash('sha256').update(`${requestId}|${repository}|${digest}|${replacementDigest || ''}|${reason}`).digest('hex');
  const body = await supabaseRequest('POST', 'rpc/revoke_image', {
    body: {
      p_repository: repository,
      p_digest: digest,
      p_replacement_digest: replacementDigest || '',
      p_actor_id: auditActorId(actor),
      p_actor_label: auditActorLabel(actor),
      p_reason: reason,
      p_operation_id: opId,
      p_request_id: requestId,
      p_event_hash: eventHash,
    },
  });
  return Array.isArray(body) ? body[0] : body;
}
async function listConsoleAuditEvents() {
  const query = new URLSearchParams({
    select: 'occurred_at,correlation_id,actor_type,action,target_id,result,reason',
    order: 'occurred_at.desc',
    limit: String(AUDIT_CAP),
  }).toString();
  const rows = await supabaseRequest('GET', 'event', { profile: 'audit', query });
  return (Array.isArray(rows) ? rows : []).map((event) => ({
    time: event.occurred_at,
    opId: event.correlation_id || '',
    source: 'supabase-audit',
    actor: event.actor_type || 'system',
    action: event.action || '',
    target: event.target_id || '',
    result: event.result || '',
    reason: event.reason || '',
  }));
}
const newOpId = () => randomBytes(8).toString('hex');
async function hydrateAudit() {
  // The canonical audit viewer reads Supabase through Console Backend. Keeping
  // this process-local cache empty at restart avoids a second audit authority.
  audit.length = 0;
}
// ── K8s REST 헬퍼 ─────────────────────────────────────────────
async function k8s(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Optional API groups (for example ServiceMonitor before its CRD is
      // installed) can return a text/plain 404. Treat that as an ordinary
      // capability absence instead of crashing the entire admin surface.
      parsed = { message: text.trim() };
    }
  }
  return { ok: res.ok, status: res.status, json: parsed };
}
// 비-JSON(파드 로그 등 text/plain) 응답용 — k8s()는 항상 JSON.parse라 로그에 못 씀.
async function k8sText(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token()}` } });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}
const crd = (plural) => `/apis/${GROUP}/${V}/namespaces/${NS}/${plural}`;
const listPackages = () => k8s('GET', crd('uipluginpackages'));
const listRegs = () => k8s('GET', crd('uipluginregistrations'));
// ADR-UI-003 §3.1: scope=main-shell-* 라벨 = shell-pinned core 표면(패키징은 plugin이나 분류는 core) → 제거/비활성 불가.
const isCorePkg = (pkg) => (pkg?.metadata?.labels?.['opensphere.io/scope'] || '').startsWith('main-shell');
const getPackage = (n) => k8s('GET', `${crd('uipluginpackages')}/${n}`);
const getReg = (n) => k8s('GET', `${crd('uipluginregistrations')}/${n}`);
function verifiedActivatedRegistration(reg) {
  const status = reg?.status || {};
  return reg?.spec?.desiredState === 'Enabled'
    && status.phase === 'Activated'
    && status.workload?.phase === 'Ready'
    && status.verification?.manifest === 'Verified'
    && status.verification?.signature === 'Verified'
    && status.verification?.entryDigest === 'Verified'
    && status.verification?.permissions === 'Approved'
    && /^sha256:[a-f0-9]{64}$/.test(String(status.currentDigest || ''));
}
function verifiedStagedUpdate(reg) {
  const status = reg?.status || {};
  const currentDigest = String(status.currentDigest || '');
  const previousDigest = String(status.previousDigest || '');
  return reg?.spec?.desiredState === 'Installed'
    && status.phase === 'Ready'
    && status.workload?.phase === 'Ready'
    && status.verification?.manifest === 'Verified'
    && status.verification?.signature === 'Verified'
    && status.verification?.entryDigest === 'Verified'
    && status.verification?.permissions === 'Approved'
    && /^sha256:[a-f0-9]{64}$/.test(currentDigest)
    && /^sha256:[a-f0-9]{64}$/.test(previousDigest)
    && currentDigest !== previousDigest;
}
// CLIDownload (console.opensphere.io, cluster-scoped) — headless 비-UI 콘솔 바인딩. UIPluginPackage(UI 게스트)와 별개 kind.
// 컨트롤러는 plugins를 reconcile(워크로드+서명)하지만, binding은 '선언'이라 reconcile 없이 admin에 '인식'시키기 위해 list만.
const CONSOLE_GROUP = 'console.opensphere.io';
const listCliDownloads = () => k8s('GET', `/apis/${CONSOLE_GROUP}/${V}/clidownloads`);
const NATIVE_BINDING_NAMES = new Set(['os']); // Main Shell core: Binding 이름으로 재등록 금지.
// F-3(감사 시정): 재도입 가드가 Binding '이름'(os)만 막으면, 임의 이름의 CLIDownload가
// href=/api/plugins/os-cli/... 를 선언해 native 서비스 id(os-cli)를 proxy allowlist에 태울 수 있다.
// 그래서 native 워크로드의 '서비스 id'를 별도 예약집합으로 둔다. 이 id는 어떤 Binding·plugin으로도
// /api/plugins/<id> allowlist에 진입할 수 없다(고정 /api/cli 경로만 native CLI를 제공).
const RESERVED_PROXY_SERVICE_IDS = new Set(['os-cli']);
const CLI_RESOURCE_PATHS = [
  /^\/apis\/config\.opensphere\.io\/v1alpha1\/platformconfigs(?:\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)?$/,
  /^\/apis\/platform\.opensphere\.io\/v1alpha1\/platformversions(?:\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)?$/,
  /^\/apis\/plugins\.opensphere\.io\/v1alpha1\/namespaces\/opensphere-console\/uiplugin(?:packages|registrations)(?:\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)?$/,
];
const allowedCLIResourcePath = (path) => CLI_RESOURCE_PATHS.some((pattern) => pattern.test(path));
function integrationStatuses(pkg, phase, retryable, now) {
  if (!pkg?.spec?.contributions) return {};
  const c = pkg.spec.contributions;
  const declarations = {
    page: c.page,
    navigation: c.navigation,
    api: c.api,
    cli: c.cli,
    manual: c.manual,
    search: c.search,
    notification: c.notification,
    logs: { enabled: c.observability?.enabled && c.observability?.logs, reason: c.observability?.reason },
    metrics: { enabled: c.observability?.enabled && c.observability?.metrics, reason: c.observability?.reason },
    traces: { enabled: c.observability?.enabled && c.observability?.traces, reason: c.observability?.reason },
  };
  return Object.fromEntries(Object.entries(declarations).map(([name, declaration]) => {
    const enabled = declaration?.enabled === true;
    const integrationPhase = !enabled ? 'Disabled'
      : ['Ready', 'Activated'].includes(phase) ? 'Ready'
        : phase === 'Failed' ? 'Failed'
          : phase === 'Degraded' ? 'Degraded' : 'DependencyPending';
    return [name, {
      phase: integrationPhase,
      reason: enabled ? '' : String(declaration?.reason || 'not supported'),
      message: enabled ? `integration ${integrationPhase.toLowerCase()}` : 'integration disabled by contract',
      retryable: enabled && Boolean(retryable),
      nextRetryAt: enabled && retryable ? new Date(Date.now() + 15000).toISOString() : '',
      lastTransitionTime: now,
      observedVersion: String(pkg.spec.version || ''),
    }];
  }));
}
async function setStatus(name, status, reg, pkg) {
  const now = new Date().toISOString();
  const phase = status.phase || 'Declared';
  const retryable = Boolean(status.retryable);
  const verified = ['Ready', 'Activated', 'Degraded'].includes(phase);
  const failed = phase === 'Failed';
  const hostPending = phase === 'DependencyPending' && status.reason === 'HostPending';
  const currentDigest = String(pkg?.spec?.image?.digest || '');
  const currentManifestSha256 = String(pkg?.spec?.manifest?.sha256 || '');
  const currentVersion = String(pkg?.spec?.version || '');
  const resolution = pkg?.spec?.resolution || {};
  const releaseChanged = Boolean(reg?.status?.currentDigest && reg.status.currentDigest !== currentDigest);
  return k8s('PATCH', `${crd('uipluginregistrations')}/${name}/status`, { status: {
    ...status,
    observedGeneration: Number(reg?.metadata?.generation || 0),
    observedVersion: currentVersion,
    currentDigest,
    currentManifestSha256,
    currentVersion,
    currentRequestedRef: String(resolution.requestedRef || ''),
    currentRequestedChannel: String(resolution.requestedChannel || ''),
    currentResolvedAt: String(resolution.resolvedAt || ''),
    currentSource: String(resolution.source || ''),
    currentRevision: String(resolution.revision || ''),
    currentSignatureIdentity: String(resolution.signatureIdentity || ''),
    currentEvidenceRefs: Array.isArray(resolution.evidenceRefs) ? resolution.evidenceRefs.map(String) : [],
    currentRegistryCredentialsRequired: resolution.registryCredentialsRequired === true,
    previousDigest: releaseChanged ? String(reg.status.currentDigest) : String(reg?.status?.previousDigest || ''),
    previousManifestSha256: releaseChanged ? String(reg.status.currentManifestSha256 || '') : String(reg?.status?.previousManifestSha256 || ''),
    previousVersion: releaseChanged ? String(reg.status.currentVersion || reg.status.observedVersion || '') : String(reg?.status?.previousVersion || ''),
    previousRequestedRef: releaseChanged ? String(reg.status.currentRequestedRef || '') : String(reg?.status?.previousRequestedRef || ''),
    previousRequestedChannel: releaseChanged ? String(reg.status.currentRequestedChannel || '') : String(reg?.status?.previousRequestedChannel || ''),
    previousResolvedAt: releaseChanged ? String(reg.status.currentResolvedAt || '') : String(reg?.status?.previousResolvedAt || ''),
    previousSource: releaseChanged ? String(reg.status.currentSource || '') : String(reg?.status?.previousSource || ''),
    previousRevision: releaseChanged ? String(reg.status.currentRevision || '') : String(reg?.status?.previousRevision || ''),
    previousSignatureIdentity: releaseChanged ? String(reg.status.currentSignatureIdentity || '') : String(reg?.status?.previousSignatureIdentity || ''),
    previousEvidenceRefs: releaseChanged ? (Array.isArray(reg.status.currentEvidenceRefs) ? reg.status.currentEvidenceRefs.map(String) : []) : (Array.isArray(reg?.status?.previousEvidenceRefs) ? reg.status.previousEvidenceRefs.map(String) : []),
    previousRegistryCredentialsRequired: releaseChanged ? reg.status.currentRegistryCredentialsRequired === true : reg?.status?.previousRegistryCredentialsRequired === true,
    retryable,
    nextRetryAt: retryable ? new Date(Date.now() + 15000).toISOString() : '',
    host: {
      ref: String(pkg?.spec?.hostRef || 'main'),
      observedApiVersion: String(pkg?.spec?.hostApiVersion || ''),
      phase: hostPending ? 'DependencyPending' : failed && /Host/.test(String(status.reason || '')) ? 'Incompatible' : 'Compatible',
    },
    workload: { phase: ['Ready', 'Activated', 'Degraded', 'Disabled'].includes(phase) ? 'Ready' : phase === 'Uninstalling' ? 'Removed' : failed ? 'Degraded' : 'Pending' },
    verification: {
      manifest: verified ? 'Verified' : failed ? 'Failed' : 'Pending',
      signature: verified ? 'Verified' : failed ? 'Failed' : 'Pending',
      entryDigest: verified ? 'Verified' : failed ? 'Failed' : 'Pending',
      permissions: verified ? 'Approved' : failed ? 'Failed' : 'Pending',
    },
    integrations: integrationStatuses(pkg, phase, retryable, now),
    lastTransitionTime: now,
  } });
}
const retryableReason = (reason) => new Set([
  'PackageNotFound', 'HostPending', 'ManifestUnreachable', 'SignatureUnreachable',
  'EntryUnreachable', 'WorkloadNotReady', 'ServiceAccountNotFound',
  'HorizontalPodAutoscalerApplyFailed', 'NetworkPolicyApplyFailed',
]).has(reason);

async function verifyWorkloadToken(req, pluginId, { allowVerifiedInstalled = false } = {}) {
  const firstParty = new Map([
    ['opensphere-console-backend', `system:serviceaccount:${NS}:opensphere-console-backend`],
  ]);
  if (!safeName(pluginId)) throw { code: 403, msg: 'invalid workload source' };
  let stagedReg = null;
  if (!firstParty.has(pluginId) && !proxyAllow.has(pluginId)) {
    if (!allowVerifiedInstalled) throw { code: 403, msg: 'source is not active' };
    stagedReg = await getReg(pluginId);
    const status = stagedReg.json?.status || {};
    const verifiedInstalled = stagedReg.ok
      && stagedReg.json?.spec?.desiredState === 'Installed'
      && status.phase === 'Ready'
      && status.workload?.phase === 'Ready'
      && status.verification?.manifest === 'Verified'
      && status.verification?.signature === 'Verified'
      && status.verification?.permissions === 'Approved';
    if (!verifiedInstalled) throw { code: 403, msg: 'source is neither active nor verified Installed' };
  }
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) throw { code: 401, msg: 'workload bearer token required' };
  const review = await k8s('POST', '/apis/authentication.k8s.io/v1/tokenreviews', {
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenReview',
    spec: { token: match[1] },
  });
  if (!review.ok || review.json?.status?.authenticated !== true) throw { code: 401, msg: 'workload token rejected' };
  let expected = firstParty.get(pluginId);
  if (!expected) {
    const pkg = await getPackage(pluginId);
    if (!pkg.ok) throw { code: 403, msg: 'package not found' };
    expected = `system:serviceaccount:${NS}:${pluginServiceAccount(pkg.json).name}`;
  }
  if (review.json?.status?.user?.username !== expected) throw { code: 403, msg: 'workload identity mismatch' };
  return pluginId;
}

// ── 워크로드(기능 컨테이너) apply/delete ──────────────────────
// 워크로드를 UIPluginPackage 소유로 표시 → 패키지 삭제 시 K8s GC가 Deployment/Service를 자동 회수(cascade).
// 이전엔 ownerReference 부재로 workload가 고아가 돼 spine-up이 명시 삭제로 우회했음(감사 후속③ 구조개선).
// owner·dependent 동일 namespace(opensphere-console)라 native GC 적용 — finalizer 불요. controller:true=유일 제어소유자.
function ownerRef(pkg) {
  return {
    apiVersion: `${GROUP}/${V}`, kind: 'UIPluginPackage',
    name: pkg.metadata.name, uid: pkg.metadata.uid,
    controller: true, blockOwnerDeletion: true,
  };
}
function validLabelKey(key) {
  const s = String(key || '');
  if (!s || s.length > 253) return false;
  const parts = s.split('/');
  const name = parts.length === 2 ? parts[1] : parts[0];
  const prefix = parts.length === 2 ? parts[0] : '';
  if (!name || name.length > 63 || !/^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(name)) return false;
  if (!prefix) return true;
  if (prefix.length > 253) return false;
  return prefix.split('.').every((part) => part && part.length <= 63 && /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part));
}
function validLabelValue(value) {
  const s = String(value || '');
  return s.length <= 63 && (!s || /^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(s));
}
function podLabels(pkg) {
  const labels = {};
  for (const [key, value] of Object.entries(pkg.spec?.podLabels || {})) {
    if (validLabelKey(key) && validLabelValue(value)) labels[key] = String(value);
  }
  return labels;
}
function podEnv(pkg) {
  const env = [
    { name: 'NODE_EXTRA_CA_CERTS', value: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt' },
    { name: 'CONSOLE_IDENTITY_URL', value: 'http://opensphere-console-backend.opensphere-console.svc.cluster.local:8080' },
    { name: 'CONSOLE_AUTH_PROVIDER', value: 'supabase' },
    { name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
    { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
    { name: 'OSP_LOG_FORMAT', value: String(pkg.spec.runtime?.observability?.logs?.format || 'json') },
    { name: 'OSP_LOG_SCHEMA', value: String(pkg.spec.runtime?.observability?.logs?.schema || 'opensphere.v1') },
    { name: 'OSP_LOG_STREAM', value: String(pkg.spec.runtime?.observability?.logs?.stream || 'stdout') },
    { name: 'OTEL_SERVICE_NAME', value: String(pkg.metadata?.name || '') },
  ];
  const seen = new Set(env.map((item) => item.name));
  for (const item of pkg.spec?.env || []) {
    const name = String(item?.name || '');
    // Supabase Console Identity is the only authentication authority. Never
    // project a parallel legacy identity endpoint from a signed package.
    if (/^(KANIDM_|TOKEN_INTROSPECTION_)/.test(name)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || seen.has(name)) continue;
    env.push({ name, value: String(item?.value ?? '') });
    seen.add(name);
  }
  return env;
}
function pluginServiceAccount(pkg) {
  const declared = pkg.spec?.serviceAccountName;
  if (declared !== undefined && declared !== null && declared !== '') {
    if (typeof declared !== 'string' || declared === 'default' || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(declared)) {
      throw Object.assign(new Error('invalid or shared serviceAccountName'), { reason: 'InvalidServiceAccount' });
    }
    return { name: declared, managed: Boolean(pkg.spec?.permissionProfile) };
  }
  const name = pkg.metadata.name;
  const candidate = `uip-${name}`;
  const generated = candidate.length <= 63 ? candidate : `uip-${name.slice(0, 50).replace(/-+$/, '')}-${sha256(name).slice(0, 8)}`;
  return { name: generated, managed: true };
}
function serviceAccountManifest(pkg, name) {
  return {
    apiVersion: 'v1', kind: 'ServiceAccount',
    metadata: { name, namespace: NS, labels: { 'opensphere.io/dupa-plugin': pkg.metadata.name }, ownerReferences: [ownerRef(pkg)] },
    automountServiceAccountToken: true,
  };
}
function deploymentManifest(pkg) {
  const name = pkg.metadata.name;
  const _d = pkg.spec.image.digest || '';
  // 감사 시정 S1(2026-07-06): 태그 fallback 제거 — digest는 reconcile에서 sha256: 강제 검증됨(InvalidDigest).
  // 불변 이미지 보증: 항상 repo@sha256 형태로만 조립(태그·latest 금지, CRD pattern과 이중 방어).
  const img = `${pkg.spec.image.repository}@${_d}`;
  const serviceAccountName = pluginServiceAccount(pkg).name;
  const runtime = pkg.spec.runtime || {};
  const port = Number(runtime.port) || 8080;
  const healthPath = String(runtime.healthPath || '/healthz');
  const r = runtime.resources || {};
  const security = runtime.security || {};
  const availability = runtime.availability || {};
  const autoscaling = availability.autoscaling || {};
  const metricsEnabled = pkg.spec.contributions?.observability?.enabled === true
    && pkg.spec.contributions?.observability?.metrics === true
    && Boolean(runtime.observability?.metricsPath);
  const metricsPath = String(runtime.observability?.metricsPath || '/metrics');
  const logsEnabled = pkg.spec.contributions?.observability?.enabled === true
    && pkg.spec.contributions?.observability?.logs === true;
  const logContract = runtime.observability?.logs || {};
  const tracesEnabled = pkg.spec.contributions?.observability?.enabled === true
    && pkg.spec.contributions?.observability?.traces === true;
  const traceContract = runtime.observability?.traces || {};
  const replicas = Number.isInteger(availability.replicas) ? availability.replicas : 2;
  const podSecurityContext = {
    ...(security.runAsNonRoot !== undefined ? { runAsNonRoot: security.runAsNonRoot } : {}),
    ...(Number.isInteger(security.runAsUser) ? { runAsUser: security.runAsUser } : {}),
    ...(Number.isInteger(security.runAsGroup) ? { runAsGroup: security.runAsGroup } : {}),
    ...(security.seccompProfile ? { seccompProfile: { type: security.seccompProfile } } : {}),
  };
  const readOnlyRootFilesystem = security.readOnlyRootFilesystem === true;
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace: NS, labels: { app: name, 'opensphere.io/dupa-plugin': name }, ownerReferences: [ownerRef(pkg)] },
    spec: {
      ...(autoscaling.enabled === true ? {} : { replicas }),
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      selector: { matchLabels: { app: name } },
      template: {
        metadata: {
          labels: { ...podLabels(pkg), app: name },
          annotations: {
            'opensphere.io/log-enabled': String(logsEnabled),
            'opensphere.io/log-format': logsEnabled ? String(logContract.format || 'json') : 'text',
            'opensphere.io/log-schema': logsEnabled ? String(logContract.schema || 'opensphere.v1') : 'none',
            'opensphere.io/log-stream': logsEnabled ? String(logContract.stream || 'stdout') : 'none',
            'opensphere.io/log-service': name,
            'opensphere.io/log-correlation': tracesEnabled ? `${String(traceContract.propagation || 'w3c')}+opensphere` : 'none',
            ...(metricsEnabled ? { 'prometheus.io/scrape': 'true', 'prometheus.io/path': metricsPath, 'prometheus.io/port': String(port) } : {}),
          },
        },
        spec: {
          serviceAccountName,
          automountServiceAccountToken: security.automountServiceAccountToken !== false,
          ...(Object.keys(podSecurityContext).length ? { securityContext: podSecurityContext } : {}),
          ...(availability.topologySpread === true ? { topologySpreadConstraints: [{
            maxSkew: 1,
            topologyKey: 'kubernetes.io/hostname',
            whenUnsatisfiable: 'ScheduleAnyway',
            labelSelector: { matchLabels: { app: name } },
          }] } : {}),
          ...(pkg.spec?.resolution?.registryCredentialsRequired === true
            ? { imagePullSecrets: [{ name: GHCR_PULL_SECRET }] }
            : {}),
          containers: [{
            name: 'plugin', image: img, ports: [{ name: 'http', containerPort: port }],
            // K8s API를 호출하는 기능 컨테이너(예: platform-status)의 TLS 검증용 — 기본 제공
            env: podEnv(pkg),
            volumeMounts: [
              ...(readOnlyRootFilesystem ? [{ name: 'runtime-tmp', mountPath: '/tmp' }] : []),
            ],
            readinessProbe: { httpGet: { path: healthPath, port }, initialDelaySeconds: 1 },
            livenessProbe: { httpGet: { path: healthPath, port }, initialDelaySeconds: 10, periodSeconds: 10 },
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem },
            resources: { requests: { cpu: r.cpuRequest || '20m', memory: r.memoryRequest || '32Mi' }, limits: { cpu: r.cpuLimit || '200m', memory: r.memoryLimit || '128Mi' } },
          }],
          volumes: [
            ...(readOnlyRootFilesystem ? [{ name: 'runtime-tmp', emptyDir: { sizeLimit: '32Mi' } }] : []),
          ],
        },
      },
    },
  };
}
function pdbManifest(pkg) {
  const name = pkg.metadata.name;
  const minAvailable = Number.isInteger(pkg.spec.runtime?.availability?.minAvailable) ? pkg.spec.runtime.availability.minAvailable : 1;
  return {
    apiVersion: 'policy/v1', kind: 'PodDisruptionBudget',
    metadata: { name, namespace: NS, labels: { 'opensphere.io/dupa-plugin': name }, ownerReferences: [ownerRef(pkg)] },
    spec: { minAvailable, selector: { matchLabels: { app: name } } },
  };
}
function serviceManifest(pkg) {
  const name = pkg.metadata.name;
  const port = Number(pkg.spec.runtime?.port) || 8080;
  return {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name, namespace: NS, labels: { app: name, 'opensphere.io/dupa-plugin': name }, ownerReferences: [ownerRef(pkg)] },
    spec: { selector: { app: name }, ports: [{ name: 'http', port, targetPort: 'http' }] },
  };
}

function hpaManifest(pkg) {
  const autoscaling = pkg.spec.runtime?.availability?.autoscaling;
  if (autoscaling?.enabled !== true) return null;
  const name = pkg.metadata.name;
  return {
    apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler',
    metadata: { name, namespace: NS, labels: { 'opensphere.io/dupa-plugin': name }, ownerReferences: [ownerRef(pkg)] },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name },
      minReplicas: Number(autoscaling.minReplicas) || 2,
      maxReplicas: Number(autoscaling.maxReplicas) || 4,
      behavior: {
        scaleUp: { stabilizationWindowSeconds: 30, policies: [{ type: 'Percent', value: 100, periodSeconds: 60 }] },
        scaleDown: { stabilizationWindowSeconds: 300, policies: [{ type: 'Percent', value: 50, periodSeconds: 60 }] },
      },
      metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: Number(autoscaling.targetCPUUtilization) || 70 } } }],
    },
  };
}

function networkPolicyManifest(pkg) {
  const policy = pkg.spec.runtime?.networkPolicy;
  if (policy?.enabled !== true) return null;
  const name = pkg.metadata.name;
  const ingressFrom = [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': NS } } }];
  // A consumer package may opt into an explicit HIS namespace selector issued
  // by platform policy.  It must never assume a namespace named "monitoring".
  const telemetrySelector = policy.telemetryIngress?.namespaceSelector;
  if (telemetrySelector && typeof telemetrySelector === 'object') {
    ingressFrom.push({ namespaceSelector: telemetrySelector });
  }
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name, namespace: NS, labels: { 'opensphere.io/dupa-plugin': name }, ownerReferences: [ownerRef(pkg)] },
    spec: {
      podSelector: { matchLabels: { app: name } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: ingressFrom, ports: [{ protocol: 'TCP', port: Number(pkg.spec.runtime?.port) || 8080 }] }],
      egress: [
        { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': NS } } }] },
        { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
      ],
    },
  };
}

// HIS owns scrape configuration.  DUPA publishes this descriptor as part of the
// package contract, but never materializes a ServiceMonitor (or any other HIS
// resource) on the Console's behalf.
function telemetryDescriptor(pkg) {
  const obs = pkg.spec.contributions?.observability;
  if (obs?.enabled !== true || obs.metrics !== true || !pkg.spec.runtime?.observability?.metricsPath) return null;
  return {
    consumer: 'opensphere-console',
    workload: pkg.metadata.name,
    namespace: NS,
    metricsPath: String(pkg.spec.runtime?.observability?.metricsPath || '/metrics'),
    scrapeInterval: String(pkg.spec.runtime?.observability?.scrapeInterval || '30s'),
    capabilities: ['metrics'],
  };
}

function observerClusterRoleManifest() {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole',
    metadata: { name: 'opensphere-module-cluster-observer-v1', labels: { 'opensphere.io/managed-by': 'dupa' } },
    rules: [
      { apiGroups: [''], resources: ['namespaces', 'nodes', 'pods', 'pods/log', 'services', 'endpoints', 'persistentvolumeclaims', 'persistentvolumes', 'events', 'configmaps', 'limitranges', 'resourcequotas', 'serviceaccounts', 'replicationcontrollers'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['apps'], resources: ['deployments', 'daemonsets', 'statefulsets', 'replicasets', 'controllerrevisions'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['batch'], resources: ['jobs', 'cronjobs'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['storage.k8s.io'], resources: ['storageclasses', 'csidrivers', 'csinodes', 'volumeattachments'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'networkpolicies', 'ingressclasses'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['autoscaling.k8s.io'], resources: ['verticalpodautoscalers'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['policy'], resources: ['poddisruptionbudgets'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['scheduling.k8s.io'], resources: ['priorityclasses'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['node.k8s.io'], resources: ['runtimeclasses'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['coordination.k8s.io'], resources: ['leases'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['rbac.authorization.k8s.io'], resources: ['roles', 'rolebindings', 'clusterroles', 'clusterrolebindings'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['apiextensions.k8s.io'], resources: ['customresourcedefinitions'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['metrics.k8s.io'], resources: ['nodes', 'pods'], verbs: ['get', 'list'] },
      { apiGroups: ['jobset.x-k8s.io'], resources: ['jobsets'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['cert-manager.io'], resources: ['issuers', 'clusterissuers', 'certificates', 'certificaterequests'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['acme.cert-manager.io'], resources: ['challenges', 'orders'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['kubevirt.io', 'subresources.kubevirt.io', 'cdi.kubevirt.io', 'instancetype.kubevirt.io', 'migrations.kubevirt.io', 'snapshot.storage.k8s.io', 'forklift.konveyor.io', 'ceph.rook.io', 'template.openshift.io', 'fleet.opensphere.io', 'cluster.open-cluster-management.io'], resources: ['*'], verbs: ['get', 'list', 'watch'] },
    ],
  };
}
function infrastructureManagerClusterRoleManifest() {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole',
    metadata: { name: 'opensphere-module-cluster-infrastructure-manager-v1', labels: { 'opensphere.io/managed-by': 'dupa' } },
    rules: [
      ...observerClusterRoleManifest().rules,
      { apiGroups: ['storage.k8s.io'], resources: ['storageclasses'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['snapshot.storage.k8s.io'], resources: ['volumesnapshotclasses'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['snapshot.storage.k8s.io'], resources: ['volumesnapshots'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['ceph.rook.io', 'csi.ceph.io'], resources: ['*'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
    ],
  };
}
function permissionBindingManifest(pkg, saName, profile) {
  const suffix = profile === 'cluster-observer-v1' ? 'observer-v1' : profile;
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding',
    metadata: { name: `opensphere-module-${pkg.metadata.name}-${suffix}`, labels: { 'opensphere.io/dupa-plugin': pkg.metadata.name, 'opensphere.io/managed-by': 'dupa' } },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: `opensphere-module-${profile}` },
    subjects: [{ kind: 'ServiceAccount', name: saName, namespace: NS }],
  };
}
async function applyPermissionProfile(pkg, saName) {
  const profile = pkg.spec.permissionProfile || 'none';
  if (!APPROVED_PERMISSION_PROFILES.has(profile)) throw Object.assign(new Error('unapproved permission profile'), { reason: 'UnknownPermissionProfile' });
  if (profile === 'none') return;
  const rolePath = '/apis/rbac.authorization.k8s.io/v1/clusterroles';
  const expectedRole = profile === 'cluster-infrastructure-manager-v1'
    ? infrastructureManagerClusterRoleManifest()
    : observerClusterRoleManifest();
  const existingRole = await k8s('GET', `${rolePath}/${expectedRole.metadata.name}`);
  if (!existingRole.ok) throw Object.assign(new Error('pre-provisioned permission profile is missing'), { reason: 'PermissionProfileMissing' });
  if (JSON.stringify(canonical(existingRole.json?.rules || [])) !== JSON.stringify(canonical(expectedRole.rules))) {
    throw Object.assign(new Error('pre-provisioned permission profile drifted'), { reason: 'PermissionProfileDrift' });
  }
  const binding = permissionBindingManifest(pkg, saName, profile);
  const bindingPath = '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings';
  const existingBinding = await k8s('GET', `${bindingPath}/${binding.metadata.name}`);
  const bindingResult = existingBinding.ok ? await k8s('PATCH', `${bindingPath}/${binding.metadata.name}`, binding) : await k8s('POST', bindingPath, binding);
  if (!bindingResult.ok) throw Object.assign(new Error(`permission profile binding apply failed (HTTP ${bindingResult.status})`), { reason: 'PermissionProfileApplyFailed' });
}
async function applyWorkload(pkg) {
  const name = pkg.metadata.name;
  const sa = pluginServiceAccount(pkg);
  const saPath = `/api/v1/namespaces/${NS}/serviceaccounts`;
  const existingSa = await k8s('GET', `${saPath}/${sa.name}`);
  if (sa.managed) {
    const manifest = serviceAccountManifest(pkg, sa.name);
    if (existingSa.ok) await k8s('PATCH', `${saPath}/${sa.name}`, manifest);
    else await k8s('POST', saPath, manifest);
  } else if (!existingSa.ok) {
    throw Object.assign(new Error(`declared ServiceAccount '${sa.name}' does not exist`), { reason: 'ServiceAccountNotFound' });
  }
  await applyPermissionProfile(pkg, sa.name);
  for (const [plural, man] of [['deployments', deploymentManifest(pkg)], ['services', serviceManifest(pkg)]]) {
    const base = `/apis/apps/v1/namespaces/${NS}/deployments`;
    const path = plural === 'deployments' ? base : `/api/v1/namespaces/${NS}/services`;
    const exists = await k8s('GET', `${path}/${name}`);
    if (exists.ok) await k8s('PATCH', `${path}/${name}`, man);
    else await k8s('POST', path, man);
  }
  const pdbPath = `/apis/policy/v1/namespaces/${NS}/poddisruptionbudgets`;
  const pdb = pdbManifest(pkg);
  const existingPdb = await k8s('GET', `${pdbPath}/${name}`);
  if (existingPdb.ok) await k8s('PATCH', `${pdbPath}/${name}`, pdb);
  else await k8s('POST', pdbPath, pdb);
  const optionalResources = [
    ['/apis/autoscaling/v2/namespaces/' + NS + '/horizontalpodautoscalers', hpaManifest(pkg), 'HorizontalPodAutoscaler'],
    ['/apis/networking.k8s.io/v1/namespaces/' + NS + '/networkpolicies', networkPolicyManifest(pkg), 'NetworkPolicy'],
  ];
  for (const [basePath, manifest, label] of optionalResources) {
    if (!manifest) continue;
    const existing = await k8s('GET', `${basePath}/${name}`);
    const result = existing.ok ? await k8s('PATCH', `${basePath}/${name}`, manifest) : await k8s('POST', basePath, manifest);
    if (!result.ok) throw Object.assign(new Error(`${label} apply failed (HTTP ${result.status})`), { reason: `${label}ApplyFailed` });
  }
}
async function deleteManagedResource(path, label) {
  const result = await k8s('DELETE', path);
  // DELETE is idempotent for the reconciliation state machine: a previously
  // removed resource is already converged, but an authorization/API failure
  // must retain the registration so a later reconcile can safely retry.
  if (result.ok || result.status === 404) return;
  throw Object.assign(new Error(`${label} delete failed (HTTP ${result.status})`), {
    reason: 'UninstallDeleteFailed'
  });
}

async function deleteWorkload(pkg) {
  const name = pkg.metadata.name;
  await deleteManagedResource(`/apis/apps/v1/namespaces/${NS}/deployments/${name}`, `Deployment/${name}`);
  await deleteManagedResource(`/api/v1/namespaces/${NS}/services/${name}`, `Service/${name}`);
  await deleteManagedResource(`/apis/policy/v1/namespaces/${NS}/poddisruptionbudgets/${name}`, `PodDisruptionBudget/${name}`);
  await deleteManagedResource(`/apis/autoscaling/v2/namespaces/${NS}/horizontalpodautoscalers/${name}`, `HorizontalPodAutoscaler/${name}`);
  await deleteManagedResource(`/apis/networking.k8s.io/v1/namespaces/${NS}/networkpolicies/${name}`, `NetworkPolicy/${name}`);
  const sa = pluginServiceAccount(pkg);
  await deleteManagedResource(`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/opensphere-module-${pkg.metadata.name}-observer-v1`, `ClusterRoleBinding/${name}`);
  if (sa.managed) await deleteManagedResource(`/api/v1/namespaces/${NS}/serviceaccounts/${sa.name}`, `ServiceAccount/${sa.name}`);
}
async function workloadReady(name) {
  const d = await k8s('GET', `/apis/apps/v1/namespaces/${NS}/deployments/${name}`);
  return d.ok && (d.json.status?.availableReplicas ?? 0) >= 1;
}

// ── 검증 (controller 설치 시점 — 셸 로드 시점과 동일 규칙, 이중 검증 §B.1) ──
// 플러그인 이름은 in-cluster svc 호스트로 조립되므로 엄격 검증(감사 누락 A: 백엔드 SSRF 가드).
// RFC1123 라벨만 허용 — CR이 임의 호스트명을 주입해 controller가 엉뚱한 svc로 fetch하는 것 차단.
const SAFE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
function safeName(n) { return typeof n === 'string' && SAFE_NAME.test(n); }
async function verifyPlugin(pkg) {
  const name = pkg.metadata.name;
  if (!safeName(name)) return { ok: false, reason: 'InvalidPluginName' };
  const svc = `http://${name}.${NS}.svc.cluster.local:8080`;
  // manifest reachable
  const manifestPath = String(pkg.spec.manifest.path || '/plugins/ui-shell.manifest.json');
  let mRes;
  try { mRes = await fetch(`${svc}${manifestPath}`, { signal: AbortSignal.timeout(10000) }); }
  catch { return { ok: false, reason: 'ManifestUnreachable' }; }
  if (!mRes.ok) return { ok: false, reason: 'ManifestUnreachable' };
  const mText = await mRes.text();
  // ① manifest digest: 계산해서 승인값(CR)과 '비교' (§B.5)
  if (sha256(mText) !== pkg.spec.manifest.sha256) return { ok: false, reason: 'DigestMismatch' };
  const manifest = JSON.parse(mText);
  // ② 서명: trustedKeys[keyId]로 검증 (TrustedKeys CM에서 SPKI 조회)
  const spki = (await loadTrustedKeys())[pkg.spec.trust.keyId];
  if (!spki) return { ok: false, reason: 'UntrustedKey' };
  let sRes;
  try {
    sRes = await fetch(`${svc}${'/plugins/' + (pkg.spec.manifest.signaturePath || '/plugins/ui-shell.manifest.json.sig').split('/').pop()}`, { signal: AbortSignal.timeout(10000) });
  } catch { return { ok: false, reason: 'SignatureUnreachable' }; }
  if (!sRes.ok) return { ok: false, reason: 'SignatureUnreachable' };
  if (!verifyP256(spki, (await sRes.text()).trim(), mText)) return { ok: false, reason: 'SignatureInvalid' };
  // ③ 공식 Host Contract — CR 승인값과 signed manifest를 동일하게 유지한다.
  if (manifest.manifestVersion !== 3 || !manifest.id || !manifest.sdkVersion || !manifest.kind || !manifest.hostRef || !manifest.hostCompat || !manifest.contributions) return { ok: false, reason: 'HostContractMissing' };
  if (!validContributions(manifest.contributions) || !validContributions(pkg.spec.contributions)) return { ok: false, reason: 'ContributionContractInvalid' };
  if (!validCapabilities(manifest)) return { ok: false, reason: 'CapabilityContractInvalid' };
  if (manifest.id !== pkg.metadata.name) return { ok: false, reason: 'IdDrift' };
  if (manifest.kind !== pkg.spec.kind) return { ok: false, reason: 'KindDrift' };
  if (manifest.hostRef !== pkg.spec.hostRef) return { ok: false, reason: 'HostRefDrift' };
  if (manifest.hostCompat !== pkg.spec.hostCompat) return { ok: false, reason: 'HostCompatDrift' };
  if ((manifest.hostApiVersion || '') !== (pkg.spec.hostApiVersion || '')) return { ok: false, reason: 'HostApiVersionDrift' };
  if (JSON.stringify(canonical(manifest.contributions)) !== JSON.stringify(canonical(pkg.spec.contributions))) return { ok: false, reason: 'ContributionDrift' };
  if (manifest.kind === 'subShell' && !manifest.hostApiVersion) return { ok: false, reason: 'HostApiVersionMissing' };
  // ④ shellCompat / permissions (정적 검사)
  if (manifest.shellCompat !== pkg.spec.shellCompat) return { ok: false, reason: 'ShellCompatDrift' };
  if (JSON.stringify([...(manifest.permissions || [])].sort()) !== JSON.stringify([...(pkg.spec.permissions || [])].sort())) return { ok: false, reason: 'PermissionDrift' };
  if ((manifest.apiBase || '') !== (pkg.spec.api?.basePath || '')) return { ok: false, reason: 'ApiBaseDrift' };
  if (!/^[A-Za-z0-9._-]+\.js$/.test(String(manifest.entry || ''))) return { ok: false, reason: 'InvalidEntryPath' };
  // ⑤ entry digest
  let eRes;
  try { eRes = await fetch(`${svc}/plugins/${manifest.entry}`, { signal: AbortSignal.timeout(10000) }); }
  catch { return { ok: false, reason: 'EntryUnreachable' }; }
  if (!eRes.ok) return { ok: false, reason: 'EntryUnreachable' };
  if (sha256(await eRes.text()) !== manifest.entrySha256) return { ok: false, reason: 'EntryDigestMismatch' };
  return { ok: true, manifest };
}

let _trustedKeys = null;
async function loadTrustedKeys() {
  if (_trustedKeys) return _trustedKeys;
  const cm = await k8s('GET', `/api/v1/namespaces/${NS}/configmaps/dupa-trusted-keys`);
  _trustedKeys = cm.ok ? JSON.parse(cm.json.data['trusted-keys.json']).trustedKeys : {};
  return _trustedKeys;
}
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
function verifyP256(spkiB64, sigB64, text) {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' });
    return verify('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function moduleDescriptorIssues(value) {
  const issues = [];
  const add = (code, path, message) => issues.push({ code, path, message });
  if (!value || typeof value !== 'object' || Array.isArray(value)) { add('InvalidDescriptor', '$', 'descriptor must be an object'); return issues; }
  if (value.schemaVersion !== 1) add('UnsupportedSchema', 'schemaVersion', 'schemaVersion must be 1');
  if (!safeName(value.id)) add('InvalidId', 'id', 'id must be an RFC1123 DNS label');
  if (!['subShell', 'plugin'].includes(value.kind)) add('InvalidKind', 'kind', 'kind must be subShell or plugin');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value.version || ''))) add('InvalidVersion', 'version', 'semantic version required');
  for (const key of ['displayName', 'owner', 'description', 'hostRef', 'hostCompat', 'shellCompat', 'sdkVersion']) if (!String(value[key] || '').trim()) add('Required', key, `${key} is required`);
  if (!safeName(value.hostRef)) add('InvalidHostRef', 'hostRef', 'hostRef must be an RFC1123 DNS label');
  if (!Array.isArray(value.permissions) || value.permissions.some((p) => !KNOWN_CAPABILITIES.has(p))) add('UnknownCapability', 'permissions', 'permissions must use the closed host capability set');
  if (!APPROVED_PERMISSION_PROFILES.has(value.permissionProfile)) add('UnknownPermissionProfile', 'permissionProfile', 'permission profile is not approved by the host');
  if (!value.runtime || !Number.isInteger(value.runtime.port) || value.runtime.port < 1024 || value.runtime.port > 65535) add('InvalidRuntime', 'runtime.port', 'port must be 1024..65535');
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(String(value.runtime?.healthPath || ''))) add('InvalidRuntime', 'runtime.healthPath', 'absolute health path required');
  if (value.runtime?.serviceAccountName && !safeName(value.runtime.serviceAccountName)) add('InvalidRuntime', 'runtime.serviceAccountName', 'invalid service account');
  for (const key of ['cpuRequest', 'memoryRequest', 'cpuLimit', 'memoryLimit']) if (!/^\d+(?:m|Mi|Gi)$/.test(String(value.runtime?.resources?.[key] || ''))) add('InvalidRuntime', `runtime.resources.${key}`, 'invalid resource quantity');
  const security = value.runtime?.security;
  if (security) {
    for (const key of ['automountServiceAccountToken', 'runAsNonRoot', 'readOnlyRootFilesystem']) if (security[key] !== undefined && typeof security[key] !== 'boolean') add('InvalidRuntimeSecurity', `runtime.security.${key}`, 'boolean required');
    for (const key of ['runAsUser', 'runAsGroup']) if (security[key] !== undefined && (!Number.isInteger(security[key]) || security[key] < 1)) add('InvalidRuntimeSecurity', `runtime.security.${key}`, 'positive integer required');
    if (security.seccompProfile && !['RuntimeDefault', 'Localhost'].includes(security.seccompProfile)) add('InvalidRuntimeSecurity', 'runtime.security.seccompProfile', 'unsupported seccomp profile');
  }
  const availability = value.runtime?.availability;
  if (availability) {
    const replicas = availability.replicas ?? 2;
    if (!Number.isInteger(replicas) || replicas < 1 || replicas > 20) add('InvalidRuntimeAvailability', 'runtime.availability.replicas', 'replicas must be 1..20');
    if (availability.minAvailable !== undefined && (!Number.isInteger(availability.minAvailable) || availability.minAvailable < 0 || availability.minAvailable > replicas)) add('InvalidRuntimeAvailability', 'runtime.availability.minAvailable', 'minAvailable must be 0..replicas');
    const autoscaling = availability.autoscaling;
    if (autoscaling?.enabled === true) {
      const min = autoscaling.minReplicas ?? replicas;
      const max = autoscaling.maxReplicas ?? min;
      if (!Number.isInteger(min) || min < 1 || !Number.isInteger(max) || max < min || max > 50) add('InvalidRuntimeAutoscaling', 'runtime.availability.autoscaling', 'invalid autoscaling range');
    }
  }
  if (value.runtime?.networkPolicy && typeof value.runtime.networkPolicy.enabled !== 'boolean') add('InvalidRuntimeNetworkPolicy', 'runtime.networkPolicy.enabled', 'boolean required');
  if (value.runtime?.observability?.metricsPath && !String(value.runtime.observability.metricsPath).startsWith('/')) add('InvalidRuntimeObservability', 'runtime.observability.metricsPath', 'absolute path required');
  const logContract = value.runtime?.observability?.logs;
  if (logContract) {
    if (logContract.format !== 'json') add('InvalidRuntimeObservability', 'runtime.observability.logs.format', 'json required');
    if (logContract.schema !== 'opensphere.v1') add('InvalidRuntimeObservability', 'runtime.observability.logs.schema', 'opensphere.v1 required');
    if (!['stdout', 'stderr'].includes(logContract.stream)) add('InvalidRuntimeObservability', 'runtime.observability.logs.stream', 'stdout or stderr required');
  }
  const traceContract = value.runtime?.observability?.traces;
  if (traceContract) {
    if (traceContract.propagation !== 'w3c') add('InvalidRuntimeObservability', 'runtime.observability.traces.propagation', 'w3c required');
    if (traceContract.responseHeaders !== undefined && typeof traceContract.responseHeaders !== 'boolean') add('InvalidRuntimeObservability', 'runtime.observability.traces.responseHeaders', 'boolean required');
  }
  if (!String(value.manifest?.path || '').startsWith('/plugins/')) add('InvalidManifest', 'manifest.path', 'manifest must be below /plugins/');
  if (!/^[a-f0-9]{64}$/.test(String(value.manifest?.sha256 || ''))) add('InvalidManifest', 'manifest.sha256', 'lowercase sha256 required');
  if (!String(value.manifest?.signaturePath || '').startsWith('/plugins/')) add('InvalidManifest', 'manifest.signaturePath', 'signature must be below /plugins/');
  if (!String(value.trust?.keyId || '').trim()) add('Required', 'trust.keyId', 'trusted key id required');
  if (value.api?.basePath && value.api.basePath !== `/api/plugins/${value.id}`) add('InvalidApiBase', 'api.basePath', 'api base must match module id');
  if (!validContributions(value.contributions)) add('InvalidContribution', 'contributions', 'closed contribution declaration is invalid');
  return issues;
}
function readOptionalFile(path) {
  try { return fs.readFileSync(path, 'utf8').trim(); } catch { return ''; }
}
let runtimeGhcrCredentials = null;
function ghcrCredentials() {
  // Registry credentials are file-only so the token is not exposed through Pod env inspection.
  // The optional mount is a standard kubernetes.io/dockerconfigjson imagePullSecret, so the
  // resolver and Kubernetes pull path share one narrowly scoped read credential.
  const configPath = process.env.GHCR_DOCKER_CONFIG_FILE || '/var/run/secrets/opensphere-ghcr/config.json';
  if (runtimeGhcrCredentials) return runtimeGhcrCredentials;
  const raw = readOptionalFile(configPath);
  if (!raw) return null;
  try {
    const config = JSON.parse(raw);
    const entry = config?.auths?.['ghcr.io'] || config?.auths?.['https://ghcr.io'];
    if (!entry) return null;
    if (entry.username && entry.password) return { username: String(entry.username), password: String(entry.password) };
    const decoded = Buffer.from(String(entry.auth || ''), 'base64').toString('utf8');
    const split = decoded.indexOf(':');
    return split > 0 ? { username: decoded.slice(0, split), password: decoded.slice(split + 1) } : null;
  } catch { return null; }
}
function registryDockerConfig(username, password) {
  return JSON.stringify({
    auths: {
      'ghcr.io': {
        username,
        password,
        auth: Buffer.from(`${username}:${password}`).toString('base64'),
      },
    },
  });
}
function dockerConfigUsername(encoded) {
  try {
    const config = JSON.parse(Buffer.from(String(encoded || ''), 'base64').toString('utf8'));
    const entry = config?.auths?.['ghcr.io'] || config?.auths?.['https://ghcr.io'];
    if (entry?.username) return String(entry.username);
    const decoded = Buffer.from(String(entry?.auth || ''), 'base64').toString('utf8');
    return decoded.includes(':') ? decoded.slice(0, decoded.indexOf(':')) : '';
  } catch { return ''; }
}
async function registryCredentialStatus() {
  const result = await k8s('GET', `/api/v1/namespaces/${NS}/secrets/${GHCR_PULL_SECRET}`);
  if (result.status === 404) return { registry: 'ghcr.io', configured: false, secretName: GHCR_PULL_SECRET };
  if (!result.ok) throw Object.assign(new Error(`registry credential status HTTP ${result.status}`), { code: 503, reason: 'RegistryCredentialStoreUnavailable' });
  const encoded = result.json?.data?.['.dockerconfigjson'];
  return {
    registry: 'ghcr.io',
    configured: result.json?.type === 'kubernetes.io/dockerconfigjson' && Boolean(encoded),
    username: dockerConfigUsername(encoded),
    secretName: GHCR_PULL_SECRET,
    updatedAt: result.json?.metadata?.creationTimestamp || '',
  };
}
async function storeRegistryCredentials(username, password) {
  const document = registryDockerConfig(username, password);
  const path = `/api/v1/namespaces/${NS}/secrets/${GHCR_PULL_SECRET}`;
  const existing = await k8s('GET', path);
  const body = {
    apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/dockerconfigjson',
    metadata: {
      name: GHCR_PULL_SECRET, namespace: NS,
      labels: { 'app.kubernetes.io/managed-by': 'opensphere-console', 'opensphere.io/purpose': 'registry-read' },
    },
    data: { '.dockerconfigjson': Buffer.from(document).toString('base64') },
  };
  const result = existing.ok
    ? await k8s('PATCH', path, { type: body.type, metadata: { labels: body.metadata.labels }, data: body.data })
    : await k8s('POST', `/api/v1/namespaces/${NS}/secrets`, body);
  if (!result.ok) throw Object.assign(new Error(`registry credential store HTTP ${result.status}`), { code: 503, reason: 'RegistryCredentialStoreUnavailable' });
  runtimeGhcrCredentials = { username, password };
  return { registry: 'ghcr.io', configured: true, username, secretName: GHCR_PULL_SECRET };
}
async function deleteRegistryCredentials() {
  const result = await k8s('DELETE', `/api/v1/namespaces/${NS}/secrets/${GHCR_PULL_SECRET}`);
  if (!result.ok && result.status !== 404) throw Object.assign(new Error(`registry credential delete HTTP ${result.status}`), { code: 503, reason: 'RegistryCredentialStoreUnavailable' });
  runtimeGhcrCredentials = null;
  return { registry: 'ghcr.io', configured: false, secretName: GHCR_PULL_SECRET };
}
function parseModuleImageReference(image) {
  const match = ALLOWED_IMAGE.exec(String(image || '').trim());
  if (!match) throw Object.assign(new Error('image must be an opensphere-platform GHCR digest or channel reference'), { code: 400, reason: 'InvalidImageReference' });
  return {
    repositoryPath: `opensphere-platform/${match[1]}`,
    repository: `ghcr.io/opensphere-platform/${match[1]}`,
    reference: match[2] ? `sha256:${match[2]}` : match[3],
    channel: match[3] || null,
  };
}
function runnablePlatformManifests(manifest) {
  if (!Array.isArray(manifest?.manifests)) return [];
  return manifest.manifests.filter((entry) =>
    entry?.platform?.os === 'linux'
    && ['amd64', 'arm64'].includes(entry?.platform?.architecture)
    && /^sha256:[a-f0-9]{64}$/.test(String(entry?.digest || ''))
  ).sort((a, b) => String(a.platform.architecture).localeCompare(String(b.platform.architecture)));
}
async function ghcrFetch(path, accept) {
  const headers = { Accept: accept || 'application/json' };
  let response = await fetch(`https://ghcr.io${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (response.status !== 401) return { response, authenticated: false };
  const challenge = response.headers.get('www-authenticate') || '';
  const service = /service="([^"]+)"/.exec(challenge)?.[1];
  const scope = /scope="([^"]+)"/.exec(challenge)?.[1];
  if (service !== 'ghcr.io' || !scope?.startsWith('repository:opensphere-platform/')) throw Object.assign(new Error('registry challenge rejected'), { code: 401, reason: 'RegistryAuthRejected' });
  const tokenUrl = `https://ghcr.io/token?service=${encodeURIComponent(service)}&scope=${encodeURIComponent(scope)}`;
  const requestToken = async (credentials = null) => {
    const tokenHeaders = credentials
      ? { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` }
      : {};
    const tokenResponse = await fetch(tokenUrl, { headers: tokenHeaders, signal: AbortSignal.timeout(15000) });
    if (!tokenResponse.ok) return '';
    return String((await tokenResponse.json()).token || '');
  };
  const fetchWithToken = (registryToken) => fetch(`https://ghcr.io${path}`, {
    headers: { ...headers, Authorization: `Bearer ${registryToken}` }, signal: AbortSignal.timeout(15000),
  });

  // 공개 패키지는 익명 토큰으로 먼저 확인한다. 자격증명이 등록되어 있어도 공개
  // 패키지를 불필요하게 private dependency로 기록하지 않는다.
  const anonymousToken = await requestToken();
  if (anonymousToken) {
    response = await fetchWithToken(anonymousToken);
    if (response.ok) return { response, authenticated: false };
  }
  const credentials = ghcrCredentials();
  if (!credentials) throw Object.assign(new Error('private GHCR package requires configured registry credentials'), { code: 401, reason: 'RegistryCredentialsRequired' });
  const authenticatedToken = await requestToken(credentials);
  if (!authenticatedToken) throw Object.assign(new Error('configured GHCR credentials were rejected'), { code: 401, reason: 'RegistryAuthFailed' });
  response = await fetchWithToken(authenticatedToken);
  if (!response.ok && [401, 403].includes(response.status)) throw Object.assign(new Error('configured GHCR credentials cannot read this package'), { code: 401, reason: 'RegistryAuthFailed' });
  return { response, authenticated: true };
}
async function fetchImageManifest(repositoryPath, reference) {
  const fetched = await ghcrFetch(`/v2/${repositoryPath}/manifests/${reference}`, OCI_ACCEPT);
  const { response } = fetched;
  if (!response.ok) throw Object.assign(new Error(`registry manifest HTTP ${response.status}`), { code: 422, reason: 'ImageManifestUnreachable' });
  const text = await response.text();
  const digest = response.headers.get('docker-content-digest') || `sha256:${sha256(text)}`;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw Object.assign(new Error('registry returned an invalid content digest'), { code: 422, reason: 'InvalidImageDigest' });
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw Object.assign(new Error('invalid registry manifest'), { code: 422, reason: 'InvalidImageManifest' }); }
  return { digest, manifest, authenticated: fetched.authenticated };
}
async function readModuleLabels(repositoryPath, manifest, expectedManifestDigest = '') {
  if (expectedManifestDigest && !/^sha256:[a-f0-9]{64}$/.test(expectedManifestDigest)) throw Object.assign(new Error('invalid platform manifest digest'), { code: 422, reason: 'InvalidImageManifest' });
  if (!/^sha256:[a-f0-9]{64}$/.test(String(manifest?.config?.digest || ''))) throw Object.assign(new Error('image config digest missing'), { code: 422, reason: 'InvalidImageManifest' });
  const configFetched = await ghcrFetch(
    `/v2/${repositoryPath}/blobs/${manifest.config.digest}`,
    'application/vnd.oci.image.config.v1+json, application/vnd.docker.container.image.v1+json',
  );
  const { response: configResponse } = configFetched;
  if (!configResponse.ok) throw Object.assign(new Error(`image config HTTP ${configResponse.status}`), { code: 422, reason: 'ImageConfigUnreachable' });
  const config = await configResponse.json();
  const labels = config?.config?.Labels || {};
  return {
    descriptorText: labels[MODULE_DESCRIPTOR_LABEL],
    signature: labels[MODULE_SIGNATURE_LABEL],
    keyId: labels[MODULE_KEY_ID_LABEL],
    source: labels['org.opencontainers.image.source'],
    revision: labels['org.opencontainers.image.revision'] || labels['io.opensphere.source-revision'],
    authenticated: configFetched.authenticated,
  };
}
function governedSourceRepository(source) {
  const match = /^https:\/\/github\.com\/(opensphere-platform\/[A-Za-z0-9._-]+)$/.exec(String(source || ''));
  return match?.[1] || '';
}
function attestationArguments(image, repository, predicateType) {
  return [
    'attestation', 'verify', `oci://${image}`, '--bundle-from-oci',
    '--repo', repository,
    '--signer-workflow', `${repository}/.github/workflows/publish-image.yml`,
    '--cert-oidc-issuer', GITHUB_OIDC_ISSUER,
    '--source-ref', 'refs/heads/main',
    '--deny-self-hosted-runners',
    '--predicate-type', predicateType,
  ];
}
function verifyAttestation(image, repository, predicateType, reason) {
  const dockerConfigFile = process.env.GHCR_DOCKER_CONFIG_FILE || '/var/run/secrets/opensphere-ghcr/config.json';
  const dockerConfigDir = dockerConfigFile.replace(/[\\/][^\\/]+$/, '') || '.';
  return new Promise((resolve, reject) => {
    const credentials = ghcrCredentials();
    execFile('gh', attestationArguments(image, repository, predicateType), {
      // gh currently insists that GH_TOKEN is present even with --bundle-from-oci.
      // The sentinel is never sent to GitHub because this path reads the bundle and
      // Sigstore trust root from OCI; private packages reuse the same read-only PAT.
      env: { ...process.env, DOCKER_CONFIG: dockerConfigDir, GH_TOKEN: credentials?.password || 'anonymous-bundle-verification' },
      timeout: 45_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ verified: true });
      const detail = String(stderr || stdout || error.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const unavailable = error.code === 'ENOENT' || error.killed || /\bHTTP\s+(?:408|425|429|500|502|503|504)\b/i.test(detail);
      reject(Object.assign(new Error(`supply-chain attestation verification failed${detail ? `: ${detail}` : ''}`), {
        code: unavailable ? 503 : 422,
        reason: unavailable ? 'AttestationVerifierUnavailable' : reason,
      }));
    });
  });
}
async function verifySupplyChainAttestations(image, repository) {
  await verifyAttestation(image, repository, ATTESTATION_PREDICATES.provenance, 'ImageProvenanceInvalid');
  await verifyAttestation(image, repository, ATTESTATION_PREDICATES.sbom, 'ImageSbomInvalid');
  return { provenance: 'Verified', sbom: 'Verified' };
}
async function assertImageNotRevoked(repository, digest) {
  const revocation = await findImageRevocation(repository, digest);
  if (revocation) throw Object.assign(new Error(`image digest was revoked: ${revocation.reason}`), { code: 409, reason: 'ImageRevoked', revocation });
}
async function installedChannelStatus(pkg) {
  const installedDigest = String(pkg?.spec?.image?.digest || '');
  const channel = String(pkg?.spec?.resolution?.requestedChannel || '');
  const repository = String(pkg?.spec?.image?.repository || '');
  const checkedAt = new Date().toISOString();
  try {
    const installedRevocation = await findImageRevocation(repository, installedDigest);
    if (installedRevocation) return {
      channelState: 'SecurityActionRequired', currentChannelDigest: channel ? '' : installedDigest,
      channelCheckedAt: checkedAt, channelReason: installedRevocation.reason,
    };
    if (!channel) return { channelState: 'Current', currentChannelDigest: installedDigest, channelCheckedAt: checkedAt, channelReason: '' };
    const parsed = parseModuleImageReference(`${repository}:${channel}`);
    const current = await fetchImageManifest(parsed.repositoryPath, channel);
    const channelPlatforms = runnablePlatformManifests(current.manifest).map((entry) => entry.platform.architecture);
    if (!Array.isArray(current.manifest?.manifests) || !['amd64', 'arm64'].every((architecture) => channelPlatforms.includes(architecture))) {
      throw Object.assign(new Error('channel image is not a complete amd64/arm64 index'), { reason: 'IncompleteChannelPlatforms' });
    }
    const channelRevocation = await findImageRevocation(repository, current.digest);
    if (channelRevocation) return {
      channelState: 'SecurityActionRequired', currentChannelDigest: current.digest, channelCheckedAt: checkedAt,
      channelReason: channelRevocation.reason,
    };
    return {
      channelState: current.digest === installedDigest ? 'Current' : 'UpdateAvailable',
      currentChannelDigest: current.digest,
      channelCheckedAt: checkedAt,
      channelReason: '',
    };
  } catch (error) {
    return { channelState: 'ChannelUnavailable', currentChannelDigest: '', channelCheckedAt: checkedAt, channelReason: error?.reason || 'ChannelResolveFailed' };
  }
}
async function inspectModuleImage(image) {
  const parsed = parseModuleImageReference(image);
  const resolved = await fetchImageManifest(parsed.repositoryPath, parsed.reference);
  if (!parsed.channel && resolved.digest !== parsed.reference) throw Object.assign(new Error('registry digest mismatch'), { code: 422, reason: 'ImageDigestMismatch' });
  const children = runnablePlatformManifests(resolved.manifest);
  const platformLabels = [];
  let registryCredentialsRequired = resolved.authenticated === true;
  if (Array.isArray(resolved.manifest?.manifests)) {
    if (!children.length) throw Object.assign(new Error('multi-platform image has no supported linux/amd64 or linux/arm64 manifest'), { code: 422, reason: 'UnsupportedImagePlatforms' });
    const architectures = children.map((entry) => entry.platform.architecture);
    if (new Set(architectures).size !== architectures.length) throw Object.assign(new Error('multi-platform image contains duplicate runnable platform manifests'), { code: 422, reason: 'AmbiguousImagePlatforms' });
    if (parsed.channel && !['amd64', 'arm64'].every((architecture) => architectures.includes(architecture))) {
      throw Object.assign(new Error('channel image must publish both linux/amd64 and linux/arm64'), { code: 422, reason: 'IncompleteChannelPlatforms' });
    }
    for (const child of children) {
      const childManifest = await fetchImageManifest(parsed.repositoryPath, child.digest);
      registryCredentialsRequired ||= childManifest.authenticated === true;
      if (childManifest.digest !== child.digest) throw Object.assign(new Error('platform manifest digest mismatch'), { code: 422, reason: 'ImageDigestMismatch' });
      const labels = await readModuleLabels(parsed.repositoryPath, childManifest.manifest, child.digest);
      registryCredentialsRequired ||= labels.authenticated === true;
      platformLabels.push({
        platform: `${child.platform.os}/${child.platform.architecture}`,
        ...labels,
      });
    }
  } else {
    if (parsed.channel) throw Object.assign(new Error('channel image must be a linux/amd64 and linux/arm64 OCI index'), { code: 422, reason: 'IncompleteChannelPlatforms' });
    const labels = await readModuleLabels(parsed.repositoryPath, resolved.manifest, resolved.digest);
    registryCredentialsRequired ||= labels.authenticated === true;
    platformLabels.push({ platform: 'single', ...labels });
  }
  const [{ descriptorText, signature, keyId }] = platformLabels;
  if (!descriptorText || !signature || !keyId) throw Object.assign(new Error('required OpenSphere OCI labels are missing'), { code: 422, reason: 'ModuleLabelsMissing' });
  if (platformLabels.some((entry) => entry.descriptorText !== descriptorText || entry.signature !== signature || entry.keyId !== keyId || entry.source !== platformLabels[0].source || entry.revision !== platformLabels[0].revision)) {
    throw Object.assign(new Error('OpenSphere module labels differ across supported platforms'), { code: 422, reason: 'PlatformModuleMetadataDrift' });
  }
  let descriptor;
  try { descriptor = JSON.parse(descriptorText); } catch { throw Object.assign(new Error('module descriptor is not JSON'), { code: 422, reason: 'InvalidDescriptor' }); }
  const issues = moduleDescriptorIssues(descriptor);
  if (issues.length) throw Object.assign(new Error('module descriptor validation failed'), { code: 422, reason: 'DescriptorRejected', issues });
  if (keyId !== descriptor.trust.keyId) throw Object.assign(new Error('descriptor key id drift'), { code: 422, reason: 'KeyIdDrift' });
  const trustedKey = (await loadTrustedKeys())[keyId];
  if (!trustedKey) throw Object.assign(new Error('module signing key is not trusted'), { code: 422, reason: 'UntrustedKey' });
  if (!verifyP256(trustedKey, signature, descriptorText)) throw Object.assign(new Error('module descriptor signature invalid'), { code: 422, reason: 'DescriptorSignatureInvalid' });
  const sourceRepository = governedSourceRepository(platformLabels[0].source);
  if (!sourceRepository || !/^[a-f0-9]{40}$/.test(String(platformLabels[0].revision || ''))) {
    throw Object.assign(new Error('governed source repository or full source revision is missing'), { code: 422, reason: 'ImageSourceInvalid' });
  }
  const resolvedImage = `${parsed.repository}@${resolved.digest}`;
  await assertImageNotRevoked(parsed.repository, resolved.digest);
  const supplyChain = await verifySupplyChainAttestations(resolvedImage, sourceRepository);
  const resolvedAt = new Date().toISOString();
  return {
    image: resolvedImage,
    requestedImage: String(image || '').trim(),
    channel: parsed.channel,
    repository: parsed.repository,
    digest: resolved.digest,
    resolvedAt,
    source: platformLabels[0].source,
    revision: platformLabels[0].revision,
    registryCredentialsRequired,
    descriptor,
    verification: { registry: 'ghcr.io', digest: 'Verified', descriptor: 'Verified', signature: 'Verified', ...supplyChain, permissionProfile: descriptor.permissionProfile, platforms: platformLabels.map((entry) => entry.platform) },
  };
}
function packageFromInspection(inspection) {
  const d = inspection.descriptor;
  return {
    apiVersion: `${GROUP}/${V}`, kind: 'UIPluginPackage',
    metadata: { name: d.id, namespace: NS, labels: { 'opensphere.io/source': 'oci', 'opensphere.io/sdk-version': d.sdkVersion } },
    spec: {
      kind: d.kind, hostRef: d.hostRef, hostApiVersion: d.hostApiVersion || '', hostCompat: d.hostCompat,
      serviceAccountName: d.runtime.serviceAccountName || `uip-${d.id}`, displayName: d.displayName, owner: d.owner,
      version: d.version, description: d.description, image: { repository: inspection.repository, digest: inspection.digest },
      resolution: {
        requestedRef: inspection.requestedImage,
        requestedChannel: inspection.channel || '',
        resolvedDigest: inspection.digest,
        resolvedAt: inspection.resolvedAt,
        artifactVersion: d.version,
        source: inspection.source,
        revision: inspection.revision,
        signatureIdentity: d.trust.keyId,
        registryCredentialsRequired: inspection.registryCredentialsRequired === true,
        evidenceRefs: [`oci:${inspection.image}#slsa-provenance`, `oci:${inspection.image}#spdx-sbom`],
      },
      nav: d.nav || { band: d.kind === 'subShell' ? '구축 Build' : 'Extensions', label: d.displayName },
      manifest: d.manifest, trust: d.trust, shellCompat: d.shellCompat, permissions: d.permissions,
      permissionProfile: d.permissionProfile, runtime: d.runtime, api: d.api,
      ...(d.contributions?.cli?.enabled ? { cli: { namespace: d.contributions.cli.namespace, manifestPath: d.contributions.cli.manifestPath } } : {}),
      contributions: d.contributions,
    },
  };
}
async function upsertPackage(pkg) {
  const existing = await getPackage(pkg.metadata.name);
  return existing.ok ? k8s('PATCH', `${crd('uipluginpackages')}/${pkg.metadata.name}`, { metadata: { labels: pkg.metadata.labels }, spec: pkg.spec }) : k8s('POST', crd('uipluginpackages'), pkg);
}
function validContributions(contributions) {
  const required = ['page', 'navigation', 'api', 'cli', 'manual', 'search', 'notification', 'observability'];
  if (!contributions || required.some((key) => !contributions[key] || typeof contributions[key].enabled !== 'boolean')) return false;
  if (required.some((key) => contributions[key].enabled === false && !String(contributions[key].reason || '').trim())) return false;
  if (contributions.api.enabled && !String(contributions.api.basePath || '').startsWith('/api/')) return false;
  if (contributions.cli.enabled && (!contributions.cli.namespace || !contributions.cli.manifestPath)) return false;
  if (contributions.manual.enabled && (!contributions.manual.sourceId || contributions.manual.mode === 'none')) return false;
  if (contributions.search.enabled && contributions.search.mode === 'none') return false;
  return true;
}
const KNOWN_CAPABILITIES = new Set([
  'page:register', 'api:proxy', 'nav:contribute', 'search:contribute', 'manual:contribute',
  'notify:publish', 'identity:read', 'theme:read', 'storage:read', 'storage:write',
]);
function validCapabilities(manifest) {
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (permissions.some((permission) => !KNOWN_CAPABILITIES.has(permission))) return false;
  const c = manifest.contributions || {};
  if (c.page?.enabled && !permissions.includes('page:register')) return false;
  if (c.api?.enabled && !permissions.includes('api:proxy')) return false;
  if (c.navigation?.enabled && c.navigation?.mode === 'runtime' && !permissions.includes('nav:contribute')) return false;
  if (c.search?.enabled && c.search?.mode === 'runtime' && !permissions.includes('search:contribute')) return false;
  if (c.manual?.enabled && c.manual?.mode === 'runtime' && !permissions.includes('manual:contribute')) return false;
  if (c.notification?.frontend && !permissions.includes('notify:publish')) return false;
  return true;
}

// ── reconcile: registration desiredState → 실제 상태 ──────────
let publishedPluginCount = 0;
let publishedPlugins = [];
// P0-2/재감사 P1-2 allowlist: /api/plugins/<id> 프록시 허용 id 집합 = (a) 검증 성공+활성(published) plugin id
// + (b) enabled workforce CLIDownload 바인딩 서비스 id. Main Shell native os-cli는 고정 /api/cli 경로를 사용한다.
// reconcile 끝에서 published로 계산(루프 뒤). 전이 실패 시 직전 allowlist 유지(가용성).
let proxyAllow = new Set();
function publishedPluginEntry(pkg, manifestUrl, sigUrl, reg = {}, channel = {}) {
  const cli = pkg.spec.contributions?.cli?.enabled === true ? {
    namespace: pkg.spec.cli?.namespace || pkg.spec.contributions.cli.namespace,
    manifestPath: pkg.spec.cli?.manifestPath || pkg.spec.contributions.cli.manifestPath,
    apiBase: pkg.spec.api?.basePath || pkg.spec.contributions.api?.basePath || '',
  } : undefined;
  return {
    id: pkg.metadata.name,
    name: pkg.spec.displayName || pkg.metadata.name,
    manifest: manifestUrl,
    manifestSha256: pkg.spec.manifest.sha256,
    signature: sigUrl,
    keyId: pkg.spec.trust.keyId,
    kind: pkg.spec.kind,
    hostRef: pkg.spec.hostRef,
    hostApiVersion: pkg.spec.hostApiVersion || '',
    hostCompat: pkg.spec.hostCompat,
    contributions: pkg.spec.contributions,
    telemetryDescriptor: telemetryDescriptor(pkg),
    ...(cli ? { cli } : {}),
    requestedRef: pkg.spec.resolution?.requestedRef || '',
    requestedChannel: pkg.spec.resolution?.requestedChannel || '',
    installedDigest: pkg.spec.image?.digest || '',
    resolvedAt: pkg.spec.resolution?.resolvedAt || '',
    artifactVersion: pkg.spec.resolution?.artifactVersion || pkg.spec.version || '',
    sourceRevision: pkg.spec.resolution?.revision || '',
    evidenceRefs: pkg.spec.resolution?.evidenceRefs || [],
    currentChannelDigest: channel.currentChannelDigest || reg.status?.currentChannelDigest || '',
    updateState: channel.channelState || reg.status?.channelState || 'ChannelUnavailable',
    channelCheckedAt: channel.channelCheckedAt || reg.status?.channelCheckedAt || '',
    channelReason: channel.channelReason || reg.status?.channelReason || '',
    approval: {
      actor: reg.spec?.approval?.requestedBy || '',
      reason: reg.spec?.approval?.reason || '',
      time: reg.metadata?.creationTimestamp || '',
    },
    // 관리자 지정 1단 아이콘(Carbon 토큰명). 서명 무관 오버라이드(CR spec.nav.icon) — 셸이 토큰→아이콘 매핑.
    icon: pkg.spec.nav?.icon || '',
  };
}
async function reconcile() {
  const [pkgs, regs] = await Promise.all([listPackages(), listRegs()]);
  if (!pkgs.ok || !regs.ok) return;
  const pkgByName = Object.fromEntries(pkgs.json.items.map((p) => [p.metadata.name, p]));
  _trustedKeys = null; // 매 reconcile마다 신뢰키 재로드
  await loadTrustedKeys();
  const published = [];
  const regByName = Object.fromEntries(regs.json.items.map((reg) => [reg.metadata.name, reg]));

  for (const reg of regs.json.items) {
    const name = reg.metadata.name;
    const pkg = pkgByName[reg.spec.packageRef.name];
    const desired = reg.spec.desiredState;
    const channelEvidence = await installedChannelStatus(pkg);
    const updateStatus = (status) => setStatus(name, { ...channelEvidence, ...status }, reg, pkg);
    if (!pkg) { await updateStatus({ phase: 'DependencyPending', reason: 'PackageNotFound', retryable: true }); continue; }
    const stableRelease = ['Ready', 'Activated'].includes(reg.status?.phase)
      && reg.status?.currentDigest === pkg.spec.image?.digest
      && reg.status?.currentManifestSha256 === pkg.spec.manifest?.sha256;

    try {
      if (desired === 'Uninstalled') {
        // 워크로드 회수 + registration CR도 삭제 → Installed 탭에서 사라짐(계획서 §10.4).
        // 이력은 audit에 남으므로 정보 손실 없음. (CR을 Removed로 남기면 목록에 잔류해
        // "uninstall이 안 된 것처럼" 보이는 UX 문제가 있었음)
        await updateStatus({ phase: 'Uninstalling', reason: '', retryable: false });
        await deleteWorkload(pkg);
        await k8s('DELETE', `${crd('uipluginregistrations')}/${name}`);
        continue;
      }
      if (desired === 'Disabled') {
        // workload 유지, registry에서만 제외 (메뉴/route 소멸)
        await updateStatus({ phase: 'Disabled', reason: '' });
        continue;
      }
      if (channelEvidence.channelState === 'SecurityActionRequired') {
        await updateStatus({ phase: 'Failed', reason: 'ImageRevoked', retryable: false });
        continue;
      }
      // Installed/Enabled: 설치는 워크로드 검증까지만, Enabled는 검증된 릴리스를 Registry에 활성화한다.
      // 감사 시정 S1(2026-07-06): 이미지 불변성 강제 — spec.image.digest는 sha256: 필수.
      // 태그/빈 값이면 워크로드 생성 전에 Failed/InvalidDigest로 거부(fail-closed). CRD pattern과 이중 방어
      // (pattern은 신규 write만 막고, 기존 저장된 CR은 여기서 걸러진다).
      if (!String(pkg.spec.image?.digest || '').startsWith('sha256:')) {
        await updateStatus({ phase: 'Failed', reason: 'InvalidDigest', retryable: false });
        continue;
      }
      const hostRef = pkg.spec.hostRef || 'main';
      if (hostRef !== 'main') {
        const hostPkg = pkgByName[hostRef];
        const hostReg = regByName[hostRef];
        const hostReady = hostPkg?.spec.kind === 'subShell' && hostReg?.spec.desiredState === 'Enabled'
          && ['Ready', 'Activated', 'Enabled'].includes(hostReg.status?.phase);
        if (!hostReady) {
          await updateStatus({ phase: 'DependencyPending', reason: 'HostPending', retryable: true });
          continue;
        }
      }
      if (!stableRelease) await updateStatus({ phase: 'Installing', reason: '' });
      await applyWorkload(pkg);
      // ready 대기 (짧게)
      let ready = false;
      for (let i = 0; i < 30 && !ready; i++) { ready = await workloadReady(pkg.metadata.name); if (!ready) await sleep(2000); }
      if (!ready) { await updateStatus({ phase: 'Failed', reason: 'WorkloadNotReady', retryable: true }); continue; }

      if (!stableRelease) await updateStatus({ phase: 'Verifying', reason: '', retryable: false });
      const v = await verifyPlugin(pkg);
      if (!v.ok) { await updateStatus({ phase: 'Failed', reason: v.reason, retryable: retryableReason(v.reason) }); continue; }

      if (desired === 'Installed') {
        await updateStatus({ phase: 'Ready', reason: '', retryable: false });
        continue;
      }

      // 통과 — registry에 '승인값 전사'(§B.5): manifestSha256/keyId는 controller 계산값이 아니라 CR값
      const manifestUrl = `${SHELL_API_PREFIX}/${pkg.metadata.name}/plugins/ui-shell.manifest.json`;
      const sigUrl = `${SHELL_API_PREFIX}/${pkg.metadata.name}/plugins/${(pkg.spec.manifest.signaturePath || 'ui-shell.manifest.json.sig').split('/').pop()}`;
      published.push(publishedPluginEntry(pkg, manifestUrl, sigUrl, reg, channelEvidence));
      if (!stableRelease) await updateStatus({ phase: 'Ready', reason: '', manifestUrl, retryable: false });
      await updateStatus({ phase: 'Activated', reason: '', manifestUrl, retryable: false });
    } catch (e) {
      const reason = e?.reason || String(e).slice(0, 120);
      await updateStatus({ phase: 'Failed', reason, retryable: retryableReason(reason) });
    }
  }
  publishedPlugins = published.map((plugin) => ({ ...plugin, available: true }));
  publishedPluginCount = publishedPlugins.length;
  // 재감사 P1-2: proxy allowlist = '검증 성공 + 활성(published)' id + enabled CLIDownload 서비스 id만.
  //   (모든 UIPluginPackage 이름이 아니라) → Failed/Disabled/미검증 package는 자동 제외(403).
  //   reconcile 성공분으로만 교체(전이 실패 시 직전 allowlist 유지 → 가용성).
  // F-3: published plugin id 중 예약된 native 서비스 id(os-cli)와 충돌하는 것도 방어적으로 제외.
  const allow = new Set(published.map((p) => p.id).filter((id) => !RESERVED_PROXY_SERVICE_IDS.has(id)));
  try {
    const cds = await listCliDownloads();
    for (const cd of cds.json?.items || []) {
      if (NATIVE_BINDING_NAMES.has(cd.metadata?.name)) continue;
      if (cd.spec?.enabled === false) continue; // enabled 바인딩만 허용
      for (const l of (cd.spec?.links || [])) {
        const mm = String(l.href || '').match(/^\/api\/plugins\/([a-z0-9-]+)\//);
        if (!mm) continue;
        if (RESERVED_PROXY_SERVICE_IDS.has(mm[1])) { // native 서비스 재도입 시도 — allowlist 진입 거부.
          console.warn(`[proxy-authz] reserved native service id '${mm[1]}' rejected from binding '${cd.metadata?.name}'`);
          continue;
        }
        allow.add(mm[1]);
      }
    }
  } catch { /* binding scan best-effort */ }
  proxyAllow = allow;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── K8s Warning 이벤트를 콘솔 알림 소스로 (ADR-UI-002 §D2 — 클러스터 event 평면, OKD 렌즈) ──
// 플랫폼 ns(opensphere-*)의 Warning만 audit bus에 합류. dedup(uid). observability operand 불요(K8s 네이티브).
const seenEvents = new Set();
async function pollK8sEvents() {
  const r = await k8s('GET', '/api/v1/events?fieldSelector=type=Warning&limit=100');
  if (!r.ok) return;
  for (const ev of r.json.items || []) {
    const ns = ev.metadata?.namespace || '';
    if (!ns.startsWith('opensphere')) continue; // 플랫폼 ns만(노이즈 억제)
    const uid = ev.metadata?.uid;
    if (!uid || seenEvents.has(uid)) continue;
    seenEvents.add(uid);
    const o = ev.involvedObject || {};
    logAudit('k8s', ev.reason || 'Event', `${o.kind || '?'}/${o.name || '?'}`, 'warning', (ev.message || '').slice(0, 160));
  }
  if (seenEvents.size > 2000) seenEvents.clear(); // 메모리 가드
}

// ── Control API + registry 서빙 ───────────────────────────────
async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw { code: 413, msg: 'payload too large' }; chunks.push(c); }
  const s = Buffer.concat(chunks).toString(); return s ? JSON.parse(s) : {};
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

async function ensureRegistration(pkgName, desiredState, actor, reason) {
  const existing = await getReg(pkgName);
  const approvalReason = String(reason || existing.json?.spec?.approval?.reason || '');
  const body = {
    apiVersion: `${GROUP}/${V}`, kind: 'UIPluginRegistration',
    metadata: { name: pkgName, namespace: NS },
    spec: { packageRef: { name: pkgName }, desiredState,
      installPolicy: { createWorkload: true, createProxyRoute: true, exposeInNavigation: true },
      approval: { requestedBy: actor || 'unknown', reason: approvalReason } },
  };
  if (existing.ok) return k8s('PATCH', `${crd('uipluginregistrations')}/${pkgName}`, { spec: { desiredState, approval: body.spec.approval } });
  return k8s('POST', crd('uipluginregistrations'), body);
}

// ── Console Gitea declarative-change authority health ──────────────────────
const GITEA_URL = process.env.GITEA_URL || 'http://opensphere-gitea.opensphere-console-change.svc.cluster.local:3000';
async function giteaHealth() {
  try {
    const r = await fetch(`${GITEA_URL}/api/healthz`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}
// OAA is a native Console capability. The controller observes its readiness but
// does not own it or grant it a direct Kubernetes mutation path.
const OAA_GATEWAY_URL = process.env.OAA_GATEWAY_URL || 'http://opensphere-console-oaa-gateway.opensphere-console.svc.cluster.local:8080';
async function oaaGatewayReadiness() {
  try {
    const r = await fetch(`${OAA_GATEWAY_URL}/readyz`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    return { ready: r.ok === true, components: body?.components || null, reason: body?.reason || (r.ok ? null : 'oaa_gateway_not_ready') };
  } catch {
    return { ready: false, components: null, reason: 'oaa_gateway_unreachable' };
  }
}
// ── Observability: HIS Binding consumer only ───────────────────────────────
// Prometheus/Grafana/Alertmanager are HIS-owned.  The Console may read an
// HIS-issued ObservabilityBinding and relay only contract-approved templates;
// it never discovers a monitoring namespace, writes ServiceMonitor resources,
// or accepts arbitrary PromQL from a browser.
const OBSERVABILITY_GROUP = 'observability.opensphere.io';
const OBSERVABILITY_BINDINGS_PATH = `/apis/${OBSERVABILITY_GROUP}/${V}/observabilitybindings`;
const OBSERVABILITY_CONSUMERS = new Set(['console', 'opensphere-console']);

function bindingCapabilities(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).toLowerCase());
  if (value && typeof value === 'object') return Object.entries(value)
    .filter(([, enabled]) => enabled === true || String(enabled).toLowerCase() === 'ready')
    .map(([name]) => String(name).toLowerCase());
  return [];
}
async function platformControlReadiness() {
  const supabase = await fetch(`${CONSOLE_IDENTITY_URL}/readyz`, { signal: AbortSignal.timeout(3000) })
    .then((response) => ({ ready: response.ok, reason: response.ok ? '' : `Console Backend HTTP ${response.status}` }))
    .catch(() => ({ ready: false, reason: 'Console Backend Supabase readiness unavailable' }));
  const [gitea, oaa] = await Promise.all([giteaHealth(), oaaGatewayReadiness()]);
  const ready = supabase.ready && gitea && oaa.ready;
  return {
    ready, required: true,
    supabase, gitea: { ready: gitea }, oaa,
    reason: ready ? '' : 'Supabase Data & Identity, Gitea Change Control, and OAA readiness are required',
  };
}
function bindingConsumer(binding) {
  const labels = binding.metadata?.labels || {};
  return String(labels['opensphere.io/consumer'] || labels['observability.opensphere.io/consumer']
    || binding.spec?.consumerRef?.name || binding.spec?.consumer || '').toLowerCase();
}
function consoleBinding(items) {
  return (items || []).find((binding) => OBSERVABILITY_CONSUMERS.has(bindingConsumer(binding))) || null;
}
function bindingContract(binding) {
  const status = binding.status || {};
  const contract = status.contract || status.binding || binding.spec?.contract || binding.spec?.binding || {};
  const endpoints = contract.endpoints || status.endpoints || {};
  const endpoint = contract.queryEndpoint || contract.metricsEndpoint || contract.endpoint
    || endpoints.query?.url || endpoints.metrics?.url || endpoints.query || endpoints.metrics || '';
  const capabilities = [...new Set([
    ...bindingCapabilities(contract.capabilities),
    ...bindingCapabilities(status.capabilities),
    ...bindingCapabilities(binding.spec?.capabilities),
  ])];
  const templates = contract.queryTemplates || status.queryTemplates || endpoints.query?.templates || {};
  return {
    endpoint: typeof endpoint === 'string' ? endpoint : '',
    capabilities,
    templates: templates && typeof templates === 'object' ? templates : {},
    observedAt: status.observedAt || status.lastUpdatedAt || status.updatedAt || binding.metadata?.creationTimestamp || '',
  };
}
function bindingPhase(binding) {
  const status = binding.status || {};
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  const ready = conditions.some((item) => ['Ready', 'Connected'].includes(item.type) && item.status === 'True');
  const failed = conditions.find((item) => ['Ready', 'Connected'].includes(item.type) && item.status === 'False');
  const phase = String(status.phase || status.state || status.binding?.phase || '').trim();
  if (ready || ['Connected', 'Ready'].includes(phase)) return 'Connected';
  if (['Degraded', 'Stale', 'Lost', 'Failed', 'Error'].includes(phase) || failed) return 'Degraded';
  return 'Pending';
}
function safeBindingEndpoint(value) {
  try {
    const endpoint = new URL(value);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return '';
    endpoint.hash = '';
    return endpoint.toString().replace(/\/$/, '');
  } catch { return ''; }
}
function boundQueryUrl(endpoint, range) {
  const base = safeBindingEndpoint(endpoint);
  if (!base) return '';
  const apiRoot = /\/api\/v1$/.test(base) ? base : `${base}/api/v1`;
  const url = new URL(`${apiRoot}/${range ? 'query_range' : 'query'}`);
  return url;
}
async function observabilityBinding() {
  const result = await k8s('GET', OBSERVABILITY_BINDINGS_PATH);
  if (result.status === 404) return {
    mode: 'NotConfigured', ready: false, owner: 'HIS', bindingApi: 'Unavailable', capabilities: [],
    reason: 'HIS ObservabilityBinding API is not configured for this cluster', binding: null,
  };
  if (!result.ok) return {
    mode: 'Degraded', ready: false, owner: 'HIS', bindingApi: `HTTP ${result.status}`, capabilities: [],
    reason: `ObservabilityBinding read failed (HTTP ${result.status})`, binding: null,
  };
  const binding = consoleBinding(result.json?.items);
  if (!binding) return {
    mode: 'NotConfigured', ready: false, owner: 'HIS', bindingApi: 'Available', capabilities: [],
    reason: 'No HIS ObservabilityBinding has been issued to opensphere-console', binding: null,
  };
  const contract = bindingContract(binding);
  const phase = bindingPhase(binding);
  const metrics = contract.capabilities.includes('metrics');
  const endpoint = safeBindingEndpoint(contract.endpoint);
  const connected = phase === 'Connected' && metrics && Boolean(endpoint);
  const mode = connected ? 'Connected' : phase === 'Degraded' ? 'Degraded' : 'Pending';
  const missing = [!metrics && 'metrics capability', !endpoint && 'query endpoint'].filter(Boolean).join(', ');
  return {
    mode, ready: connected, owner: 'HIS', bindingApi: 'Available', capabilities: contract.capabilities,
    reason: connected ? '' : (phase === 'Degraded'
      ? String(binding.status?.message || binding.status?.reason || 'HIS Binding is degraded')
      : `HIS Binding is not usable: ${missing || 'connection is pending'}`),
    binding: {
      name: binding.metadata?.name || '', namespace: binding.metadata?.namespace || '', phase,
      observedAt: contract.observedAt, templates: Object.keys(contract.templates),
    },
    _contract: { endpoint, templates: contract.templates },
  };
}
async function consoleDirectEvidence() {
  const targets = [
    ['opensphere-console-backend', 'Console Backend'],
    ['opensphere-console-dupa-controller', 'Console Control API'],
  ];
  const results = await Promise.all(targets.map(async ([name, label]) => {
    const resource = await k8s('GET', `/apis/apps/v1/namespaces/${NS}/deployments/${name}`);
    return { key: name, label, ...deploymentReadyResult(NS, name, resource) };
  }));
  return results;
}
async function observabilityStatus() {
  const [binding, directEvidence] = await Promise.all([observabilityBinding(), consoleDirectEvidence()]);
  // The Binding endpoint is intentionally never sent to the browser.
  const { _contract, ...publicBinding } = binding;
  return {
    owner: 'HIS', mode: publicBinding.mode, ready: publicBinding.ready,
    binding: publicBinding.binding, bindingApi: publicBinding.bindingApi,
    capabilities: publicBinding.capabilities, reason: publicBinding.reason,
    directEvidence, telemetry: publicBinding.ready
      ? { enabled: true, source: 'HIS ObservabilityBinding' }
      : { enabled: false, source: 'direct Console evidence only' },
  };
}
async function observabilityTargets() {
  const binding = await observabilityBinding();
  return {
    owner: 'HIS', mode: binding.mode, reachable: binding.ready,
    active: [],
    reason: binding.ready
      ? 'Target inventory is not exposed unless HIS publishes an approved target template'
      : binding.reason,
  };
}
async function observabilityTemplateQuery(template, range) {
  const binding = await observabilityBinding();
  if (!binding.ready) return { ok: false, code: 'ObservabilityBindingUnavailable', hint: binding.reason };
  const expr = binding._contract.templates[String(template || '')];
  if (typeof expr !== 'string' || !expr.trim()) return { ok: false, code: 'TemplateUnavailable', hint: 'The requested query is not approved by HIS Binding' };
  const url = boundQueryUrl(binding._contract.endpoint, range);
  if (!url) return { ok: false, code: 'InvalidBindingEndpoint', hint: 'HIS Binding query endpoint is invalid' };
  url.searchParams.set('query', expr);
  if (range) {
    const end = Math.floor(Date.now() / 1000);
    const minutes = Math.max(1, Math.min(Number(range.minutes) || 60, 1440));
    url.searchParams.set('start', String(end - minutes * 60));
    url.searchParams.set('end', String(end));
    url.searchParams.set('step', String(Math.max(15, Math.min(Number(range.step) || 60, 3600))));
  }
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token()}`, accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return { ok: false, code: 'HISQueryFailed', hint: `HIS query endpoint HTTP ${response.status}` };
    const body = await response.json();
    return { ok: true, resultType: body.data?.resultType || '', result: body.data?.result || [] };
  } catch (error) {
    return { ok: false, code: 'HISQueryFailed', hint: String(error?.message || error).slice(0, 120) };
  }
}

// ── Platform Readiness (CONSTITUTION-0004 §7~§8) ───────────────────────────
// PlatformSupportProfile is a Main Shell-owned, machine-readable admission gate. It is not a
// fourth service stack and it does not install or administer HIS. HIS capability
// is evidenced exclusively by the HIS-issued ObservabilityBinding consumed above.
const FOUNDATION_ID = 'foundation';
const requiredProfileSpec = Object.freeze({
  hostRequirements: { clusterManager: true, his: true },
  delivery: { required: true },
  observability: { required: true },
  backupRestore: { required: true },
  securityPolicy: { required: true },
  optionalCapabilities: [],
});

function condition(type, ready, reason, message, evidence = []) {
  return { type, status: ready ? 'True' : 'False', ready, reason, message, evidence };
}
function deploymentReadyResult(ns, name, resource) {
  if (!resource?.ok) return { name, namespace: ns, ready: false, reason: `Deployment HTTP ${resource?.status || 0}` };
  const d = resource.json || {};
  const desired = Number(d.spec?.replicas ?? 1);
  const ready = Number(d.status?.readyReplicas || 0);
  return { name, namespace: ns, ready: desired > 0 && ready >= desired, detail: `${ready}/${desired} ready` };
}
async function mainShellBaselineStatus() {
  const targets = [
    [NS, 'opensphere-console'],
    [NS, 'opensphere-console-backend'],
    [NS, 'opensphere-console-dupa-controller'],
    [NS, 'opensphere-console-oaa-gateway'],
  ];
  const results = await Promise.all(targets.map(([ns, name]) =>
    k8s('GET', `/apis/apps/v1/namespaces/${ns}/deployments/${name}`).then((r) => deploymentReadyResult(ns, name, r))));
  return { ready: results.every((x) => x.ready), components: results };
}
async function clusterManagerActivationStatus() {
  const [pkg, reg] = await Promise.all([getPackage('cluster-manager'), getReg('cluster-manager')]);
  const s = reg.json?.status || {};
  const ready = pkg.ok && reg.ok && reg.json?.spec?.desiredState === 'Enabled'
    && s.phase === 'Activated' && s.workload?.phase === 'Ready'
    && s.integrations?.api?.phase === 'Ready' && s.integrations?.page?.phase === 'Ready';
  return {
    ready, installed: pkg.ok && reg.ok, phase: s.phase || (reg.ok ? 'Pending' : 'Missing'),
    workload: s.workload?.phase || 'Unknown', api: s.integrations?.api?.phase || 'Unknown',
    page: s.integrations?.page?.phase || 'Unknown', version: pkg.json?.spec?.version || '',
  };
}
async function backupRestoreEvidence() {
  const evidence = await k8s('GET', `/api/v1/namespaces/${NS}/configmaps/opensphere-platform-recovery-evidence`);
  if (!evidence.ok) return {
    ready: false, source: 'RecoveryEvidenceUnavailable', targetConfigured: false,
    scheduled: false, lastBackupAt: '', lastRestoreDrillAt: '', decommissionApproved: false,
    reason: 'current Supabase/Gitea recovery evidence has not been published',
  };
  let value;
  try { value = JSON.parse(evidence.json?.data?.['recovery-evidence.json'] || '{}'); }
  catch { value = {}; }
  const backup = value.backup || {};
  const restore = value.restore || {};
  const archiveVerified = [backup.supabase?.database, backup.supabase?.storage, backup.gitea]
    .every((item) => item?.verified === true && /^[a-f0-9]{64}$/i.test(String(item.sha256 || '')));
  const restored = [restore.supabase, restore.storage, restore.gitea]
    .every((item) => item?.state === 'Verified');
  const ready = archiveVerified && restored;
  return {
    ready, source: 'Supabase+Gitea recovery evidence', targetConfigured: archiveVerified,
    scheduled: false, lastBackupAt: value.generatedAt || '',
    lastRestoreDrillAt: restore.supabase?.verifiedAt || '',
    decommissionApproved: value.decommission?.approved === true,
    reason: ready ? '' : 'verified Supabase, Storage, and Gitea restore drills are required',
  };
}
async function securityPolicyEvidence() {
  const [policies, webhooks, admins] = await Promise.all([
    k8s('GET', `/apis/networking.k8s.io/v1/networkpolicies`),
    k8s('GET', `/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations`),
    k8s('GET', `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings`),
  ]);
  const np = policies.json?.items || [];
  const wh = webhooks.json?.items || [];
  const rb = admins.json?.items || [];
  // HIS has an independent boundary; the Console proves only its own isolation.
  const isolation = np.some((x) => x.metadata?.namespace === NS);
  const admission = wh.length > 0;
  const leastPrivilege = rb.some((x) => x.metadata?.name === 'dupa-module-profile-installer');
  // Presence alone is not a constitutional red-test. Keep the gate false until a signed, recent
  // negative admission test is recorded by the future policy evidence controller.
  const redTest = false;
  return {
    ready: isolation && admission && leastPrivilege && redTest,
    isolation, admission, leastPrivilege, redTest,
    reason: redTest ? '' : 'signed admission-policy red-test evidence is missing',
  };
}
async function deliveryEvidence() {
  const [gitea, packages, regs] = await Promise.all([giteaHealth(), listPackages(), listRegs()]);
  const pkgs = packages.json?.items || [];
  const registrations = regs.json?.items || [];
  const immutable = pkgs.every((p) => /^sha256:[a-f0-9]{64}$/.test(p.spec?.image?.digest || ''));
  const verified = registrations.every((r) => !['Installed', 'Enabled'].includes(r.spec?.desiredState)
    || (['Ready', 'Activated', 'Disabled'].includes(r.status?.phase)
      && r.status?.verification?.signature === 'Verified'
      && r.status?.verification?.manifest === 'Verified'));
  const failed = registrations.filter((r) => ['Failed', 'Degraded'].includes(r.status?.phase)).map((r) => r.metadata?.name);
  const ready = gitea && packages.ok && regs.ok && immutable && verified && failed.length === 0;
  return { ready, gitea, immutable, verified, failed, packageCount: pkgs.length, reason: ready ? '' : 'GitOps, immutable digest, signature, and drift evidence are required' };
}
async function observabilityProfileEvidence() {
  const binding = await observabilityBinding();
  const capabilities = new Set(binding.capabilities || []);
  const telemetry = {
    metrics: binding.ready && capabilities.has('metrics'),
    logs: binding.ready && capabilities.has('logs'),
    traces: binding.ready && capabilities.has('traces'),
    otlp: binding.ready && (capabilities.has('otlp') || capabilities.has('traces')),
    connectedBinding: binding.ready,
  };
  const ready = Object.values(telemetry).every(Boolean);
  return {
    ready, stackReady: binding.ready, telemetry,
    mode: binding.mode, binding: binding.binding,
    reason: ready ? '' : (binding.reason || 'A Connected HIS ObservabilityBinding with metrics, logs, traces, and OTLP is required'),
  };
}
async function readPlatformProfile() {
  const r = await k8s('GET', PLATFORM_PROFILE_PATH);
  if (r.status === 404) return { declared: false, crdReady: true, resource: null };
  if (!r.ok) return { declared: false, crdReady: false, resource: null, reason: `PlatformSupportProfile HTTP ${r.status}` };
  return { declared: true, crdReady: true, resource: r.json };
}
async function platformReadinessStatus() {
  const [platformControl, mainShell, clusterManager, profile, delivery, observability, backupRestore, securityPolicy, regs] = await Promise.all([
    platformControlReadiness(), mainShellBaselineStatus(), clusterManagerActivationStatus(),
    readPlatformProfile(), deliveryEvidence(),
    observabilityProfileEvidence(), backupRestoreEvidence(), securityPolicyEvidence(), listRegs(),
  ]);
  const his = {
    ready: observability.stackReady,
    state: observability.mode,
    reason: observability.reason,
  };
  const capabilities = [
    condition('Delivery', delivery.ready, delivery.ready ? 'Verified' : 'DeliveryEvidenceMissing', delivery.reason || 'GitOps delivery evidence verified', [delivery]),
    condition('Observability', observability.ready, observability.ready ? 'Verified' : 'TelemetryEvidenceMissing', observability.reason || 'Live telemetry verified', [observability]),
    condition('BackupRestore', backupRestore.ready, backupRestore.ready ? 'Verified' : 'RestoreEvidenceMissing', backupRestore.reason || 'Backup and restore drill verified', [backupRestore]),
    condition('SecurityPolicy', securityPolicy.ready, securityPolicy.ready ? 'Verified' : 'PolicyEvidenceMissing', securityPolicy.reason || 'Security and policy evidence verified', [securityPolicy]),
  ];
  const prerequisites = [
    { key: 'platform-control', label: 'Platform Control Ready', ready: platformControl.ready, detail: platformControl.ready ? 'Supabase · Gitea · OAA ready' : platformControl.reason, route: '/manage/platform-control' },
    { key: 'main-shell', label: 'Main Shell Baseline Ready', ready: mainShell.ready, detail: mainShell.ready ? 'Console native baseline ready' : 'Console/Auth/Backend/DUPA/OAA workload incomplete', route: '/manage/observability' },
    { key: 'cluster-manager', label: 'Cluster Manager Activated', ready: clusterManager.ready, detail: `${clusterManager.phase} · workload ${clusterManager.workload}`, route: '/manage/extensions' },
    { key: 'his-binding', label: 'HIS Observability Binding Connected', ready: his.ready, detail: his.ready ? 'HIS issued a live Console binding' : (his.reason || his.state), route: '/manage/observability' },
  ];
  const prerequisitesReady = prerequisites.every((x) => x.ready);
  const supportReady = profile.declared && prerequisitesReady && capabilities.every((x) => x.ready);
  const foundationActivationOverride = !supportReady && FOUNDATION_ACTIVATION_DEV_OVERRIDE;
  const foundationActivationAllowed = supportReady || foundationActivationOverride;
  const foundationReg = (regs.json?.items || []).find((x) => x.metadata?.name === FOUNDATION_ID);
  const pfsEstablished = foundationReg?.status?.phase === 'Activated';
  const domainAdmissionReady = pfsEstablished && supportReady;
  const profilePhase = !profile.crdReady ? 'Blocked' : !profile.declared ? 'NotDeclared'
    : !prerequisitesReady ? 'Blocked' : supportReady ? 'Ready' : 'Degraded';
  const lifecycle = [
    ...prerequisites.map((x) => ({ ...x, state: x.ready ? 'Ready' : 'Blocked' })),
    { key: 'support-profile', label: 'Platform Support Profile Ready', ready: supportReady, state: profilePhase, detail: profile.declared ? `${capabilities.filter((x) => x.ready).length}/4 capability evidence verified` : 'Profile preflight has not been declared', route: '/manage/platform-control' },
    { key: 'pfs', label: 'PFS Established', ready: pfsEstablished, state: pfsEstablished ? 'Ready' : (foundationActivationAllowed ? 'Available' : (foundationReg?.status?.phase === 'Ready' ? 'Staged' : 'Locked')), detail: pfsEstablished ? (supportReady ? 'Foundation activated' : 'Foundation activated by development override; PFS plugins remain locked') : (supportReady ? 'Foundation activation is unlocked' : (foundationActivationOverride ? 'Development override permits Foundation subShell activation only' : (foundationReg?.status?.phase === 'Ready' ? 'Foundation is staged; activation waits for Platform Support Profile Ready' : 'Foundation may be staged, but activation waits for Platform Support Profile Ready'))), route: foundationActivationAllowed ? '/manage/extensions' : '/manage/platform-control' },
    { key: 'domain', label: 'Domain subShell Admission', ready: domainAdmissionReady, state: domainAdmissionReady ? 'Available' : 'Locked', detail: domainAdmissionReady ? 'Domain subShell admission available' : (pfsEstablished ? 'Development override does not unlock Domain subShell admission' : 'PFS must be established first'), route: domainAdmissionReady ? '/manage/extensions' : '/manage/platform-control' },
  ];
  return {
    apiVersion: `${PLATFORM_GROUP}/${V}`, kind: 'PlatformReadinessStatus', observedAt: new Date().toISOString(),
    phase: profilePhase, ready: supportReady, profile: { declared: profile.declared, crdReady: profile.crdReady, name: PLATFORM_PROFILE_NAME, generation: profile.resource?.metadata?.generation || 0, lastVerifiedAt: profile.resource?.status?.lastVerifiedAt || '', status: profile.resource?.status || null },
    prerequisites, capabilities, lifecycle, evidence: { platformControl, mainShell, clusterManager, his },
    admission: {
      foundationStageAllowed: true,
      foundationActivationAllowed,
      foundationActivationOverride,
      mode: foundationActivationOverride ? 'DevelopmentOverride' : (supportReady ? 'PlatformSupportProfile' : 'Blocked'),
      // Compatibility alias for older clients. This gate now means activation,
      // because an immutable, verified workload may be staged before PFS admission.
      foundationInstallAllowed: foundationActivationAllowed,
      pfsPluginInstallAllowed: supportReady,
      reason: supportReady ? '' : (foundationActivationOverride ? 'DevelopmentOverride' : 'PlatformSupportProfileRequired'),
    },
    pfs: { established: pfsEstablished, phase: foundationReg?.status?.phase || 'NotInstalled' },
  };
}
async function declarePlatformProfile(actor, reason) {
  const current = await readPlatformProfile();
  const body = {
    apiVersion: `${PLATFORM_GROUP}/${V}`, kind: 'PlatformSupportProfile',
    metadata: { name: PLATFORM_PROFILE_NAME, namespace: NS },
    spec: { ...requiredProfileSpec, approval: { requestedBy: actor, reason, requestedAt: new Date().toISOString() } },
  };
  if (!current.crdReady) return { ok: false, status: 503, json: { message: current.reason || 'PlatformSupportProfile CRD unavailable' } };
  if (!current.declared) return k8s('POST', `/apis/${PLATFORM_GROUP}/${V}/namespaces/${NS}/platformsupportprofiles`, body);
  return k8s('PATCH', PLATFORM_PROFILE_PATH, { spec: body.spec });
}
async function writePlatformVerification(actor, status) {
  if (!status.profile.declared) return { ok: false, status: 409, json: { message: 'PlatformSupportProfile must be preflighted first' } };
  const conditions = status.capabilities.map((x) => ({
    type: x.type, status: x.status, reason: x.reason, message: x.message,
    lastTransitionTime: status.observedAt,
  }));
  return k8s('PATCH', `${PLATFORM_PROFILE_PATH}/status`, { status: {
    phase: status.phase, observedGeneration: status.profile.generation,
    lastVerifiedAt: status.observedAt, verifiedBy: actor, conditions,
    evidenceRefs: status.capabilities.flatMap((x) => x.evidence.map((_, i) => ({ type: x.type, ref: `live:${x.type.toLowerCase()}:${i}` }))),
  } });
}

// ── /metrics (Prometheus exposition, dependency-free; never browser-routed) ──
// HIS may scrape this only after accepting the Console telemetry descriptor and
// issuing an ObservabilityBinding. Console code does not create the scrape rule.
let _httpReqs = 0;
function metricsText() {
  const mu = process.memoryUsage();
  const plugins = publishedPluginCount;
  return [
    '# HELP os_build_info Build info (constant 1).',
    '# TYPE os_build_info gauge',
    `os_build_info{service="opensphere-console-dupa-controller",version="${process.env.APP_VERSION || 'dev'}"} 1`,
    '# HELP os_http_requests_total HTTP requests handled.',
    '# TYPE os_http_requests_total counter',
    `os_http_requests_total ${_httpReqs}`,
    '# HELP dupa_registry_plugins Published plugins in runtime registry.',
    '# TYPE dupa_registry_plugins gauge',
    `dupa_registry_plugins ${plugins}`,
    '# HELP dupa_proxy_allow Allowlisted plugin ids for /api/plugins proxy.',
    '# TYPE dupa_proxy_allow gauge',
    `dupa_proxy_allow ${proxyAllow ? proxyAllow.size : 0}`,
    '# HELP dupa_audit_events Current in-memory audit ring size.',
    '# TYPE dupa_audit_events gauge',
    `dupa_audit_events ${audit.length}`,
    '# HELP process_resident_memory_bytes Resident memory size in bytes.',
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${mu.rss}`,
    '# HELP process_uptime_seconds Process uptime in seconds.',
    '# TYPE process_uptime_seconds gauge',
    `process_uptime_seconds ${Math.round(process.uptime())}`,
  ].join('\n') + '\n';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const opId = typeof req.headers['x-os-correlation-id'] === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(req.headers['x-os-correlation-id'])
    ? req.headers['x-os-correlation-id']
    : newOpId();
  _httpReqs++;
  try {
    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (p === '/readyz') {
      const state = await platformControlReadiness();
      return json(res, state.ready ? 200 : 503, state);
    }
    if (p === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); return res.end(metricsText()); }
    // Main Shell native Registry. The controller already owns the verified, activated
    // projection, so a separate registry workload would duplicate authority.
    if (p === '/api/v1/registry' && req.method === 'GET') {
      return json(res, 200, {
        version: 3,
        trustedKeys: await loadTrustedKeys(),
        capabilities: [],
        plugins: publishedPlugins,
        templates: []
      });
    }
    // Console-native os CLI resource plane. It is deliberately read-only and
    // closed to four product CRD families; this is not a general Kubernetes proxy.
    if (p.startsWith('/api/proxy/')) {
      if (req.method !== 'GET') return json(res, 405, { error: 'read_only_resource_proxy', opId });
      let authenticated;
      try { authenticated = await verifyActor(req); }
      catch (e) {
        const numeric = e && typeof e.code === 'number';
        return json(res, numeric ? e.code : 502, { error: numeric ? (e.msg || 'unauthorized') : 'auth backend error', opId });
      }
      const upstreamPath = '/' + p.slice('/api/proxy/'.length);
      if (!allowedCLIResourcePath(upstreamPath)) {
        return json(res, 403, { error: 'resource_not_allowlisted', actor: authenticated.username, opId });
      }
      // The current CLI performs point/list reads only. Do not forward arbitrary
      // Kubernetes query options such as watch=true through this bounded plane.
      const upstream = await k8s('GET', upstreamPath);
      return json(res, upstream.status, upstream.json);
    }
    // P0-2: nginx auth_request 대상 — /api/plugins/<id> 프록시 허용 여부(registry allowlist).
    // 등록·검증돼 단일 Registry에 투영 가능한 plugin id만 통과 → opensphere-console 내 임의 service 프록시 차단.
    if (p === '/api/internal/proxy-authz') {
      const id = req.headers['x-plugin-id'] || '';
      // F-3: 예약된 native 서비스 id는 allowlist 상태와 무관하게 항상 403(이중 방어).
      const permitted = proxyAllow.has(id) && !RESERVED_PROXY_SERVICE_IDS.has(id);
      res.writeHead(permitted ? 204 : 403); return res.end();
    }

    // ── 인증 게이트(감사 P0-1/P1-3): /api/admin/* 는 검증된 admin id_token 필수.
    // actor는 '검증된 토큰 claim'에서만 도출 → X-OpenSphere-User 헤더 스푸핑 무력화.
    // 예외: /api/admin/events(subShell 백엔드 server-to-server 발행)는 아래에서 별도 처리.
    let actor = { username: 'system', subject: '' };
    if (p.startsWith('/api/admin/') && p !== '/api/admin/events') {
      let a;
      try { a = await verifyActor(req); }
      catch (e) {
        // {code:401/403} = 우리 검증 거부 / 문자열 code(예: ECONNREFUSED) = auth 백엔드(JWKS) 장애.
        const numeric = e && typeof e.code === 'number';
        if (!numeric) console.error(`[auth] op=${opId} verify backend error:`, e && (e.code || e.message));
        return json(res, numeric ? e.code : 502, { error: numeric ? (e.msg || 'unauthorized') : 'auth backend error', opId });
      }
      actor = a;
    }

    // Retired CBS administrative surface. Keep a machine-readable rejection
    // for old clients/bookmarks, but never expose or execute its handlers.
    if (p.startsWith('/api/admin/backbone/')) {
      return json(res, 410, { error: 'RetiredControlSurface', replacement: '/manage/platform-control', opId });
    }

    // Console mutations require the three explicit authorities (Supabase,
    // Gitea, OAA). Read-only surfaces remain available while this gate is closed.
    if (p.startsWith('/api/admin/') && p !== '/api/admin/events' && p !== '/api/admin/extensions/inspect' && req.method !== 'GET') {
      const state = await platformControlReadiness();
      if (!state.ready) return json(res, 503, { error: 'Platform Control authorities unavailable', platformControl: state, opId });
      await durableAudit(actor, 'mutation-request', p, 'attempt', req.method, opId);
    }

    // Platform Readiness — Console native lifecycle gate. HIS is an external
    // authority; this API consumes Binding evidence and never calls a Cluster
    // Manager HIS control surface.
    if (p === '/api/admin/platform-readiness/status' && req.method === 'GET') {
      return json(res, 200, await platformReadinessStatus(req));
    }
    if (p === '/api/admin/platform-readiness/preflight' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const reason = String(body.reason || '').trim();
      if (reason.length < 8) return json(res, 400, { error: 'ApprovalReasonRequired', message: 'preflight reason must be at least 8 characters', opId });
      const declared = await declarePlatformProfile(actor, reason);
      if (!declared.ok) return json(res, declared.status >= 500 ? 503 : declared.status, { error: 'PlatformSupportProfileWriteFailed', message: declared.json?.message || `HTTP ${declared.status}`, opId });
      const state = await platformReadinessStatus(req);
      await durableAudit(actor, 'platform-readiness-preflight', PLATFORM_PROFILE_NAME, 'accepted', reason, opId);
      return json(res, 200, state);
    }
    if (p === '/api/admin/platform-readiness/verify' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const reason = String(body.reason || '').trim();
      if (reason.length < 8) return json(res, 400, { error: 'ApprovalReasonRequired', message: 'verification reason must be at least 8 characters', opId });
      const state = await platformReadinessStatus(req);
      const written = await writePlatformVerification(actor, state);
      if (!written.ok) return json(res, written.status >= 500 ? 503 : written.status, { error: 'PlatformSupportProfileStatusWriteFailed', message: written.json?.message || `HTTP ${written.status}`, opId });
      await durableAudit(actor, 'platform-readiness-verify', PLATFORM_PROFILE_NAME, state.ready ? 'accepted' : 'degraded', reason, opId);
      return json(res, 200, await platformReadinessStatus(req));
    }

    // Observability is HIS-owned. The Console consumes only a read-only Binding;
    // arbitrary PromQL and target discovery are intentionally not exposed.
    if (p === '/api/admin/observability/status' && req.method === 'GET') return json(res, 200, await observabilityStatus());
    if (p === '/api/admin/observability/targets' && req.method === 'GET') return json(res, 200, await observabilityTargets());
    if (p === '/api/admin/observability/query' && req.method === 'GET') {
      const template = url.searchParams.get('template') || '';
      if (!template || template.length > 120) return json(res, 400, { error: 'HIS query template required', opId });
      return json(res, 200, await observabilityTemplateQuery(template, null));
    }
    if (p === '/api/admin/observability/query_range' && req.method === 'GET') {
      const template = url.searchParams.get('template') || '';
      if (!template || template.length > 120) return json(res, 400, { error: 'HIS query template required', opId });
      return json(res, 200, await observabilityTemplateQuery(template, { minutes: Number(url.searchParams.get('minutes')) || 60, step: Number(url.searchParams.get('step')) || 60 }));
    }
    if (p === '/api/admin/extensions/revocations' && req.method === 'GET') {
      try { return json(res, 200, { items: await listImageRevocations() }); }
      catch (e) { return json(res, Number(e?.code) || 503, { error: e?.reason || 'SupabaseUnavailable', message: e?.message, opId }); }
    }
    if (p === '/api/admin/extensions/revocations' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const reason = String(body.reason || '').trim();
      if (reason.length < 8) return json(res, 400, { error: 'ApprovalReasonRequired', message: 'revocation reason must be at least 8 characters', opId });
      try {
        const parsed = parseModuleImageReference(body.image);
        if (parsed.channel) return json(res, 400, { error: 'ExactDigestRequired', message: 'revocation requires repository@sha256:digest', opId });
        let replacementDigest = '';
        if (body.replacementImage) {
          const replacement = parseModuleImageReference(body.replacementImage);
          if (replacement.channel || replacement.repository !== parsed.repository) return json(res, 400, { error: 'InvalidReplacementDigest', opId });
          replacementDigest = replacement.reference;
        }
        const item = await revokeImage({ repository: parsed.repository, digest: parsed.reference, replacementDigest, actor, reason, opId });
        reconcile().catch((e) => console.error('reconcile error', e));
        return json(res, 201, { item });
      } catch (e) {
        const duplicate = /already revoked/i.test(String(e?.message || ''));
        return json(res, duplicate ? 409 : Number(e?.code) || 503, { error: duplicate ? 'ImageAlreadyRevoked' : e?.reason || 'RevocationFailed', message: e?.message, opId });
      }
    }
    if (p === '/api/admin/extensions/inspect' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      try { return json(res, 200, await inspectModuleImage(body.image)); }
      catch (e) { return json(res, Number(e?.code) || 422, { error: e?.reason || 'InspectionFailed', message: e?.message || 'image inspection failed', issues: e?.issues || [], revocation: e?.revocation || null, opId }); }
    }
    if (p === '/api/admin/extensions/registry-credentials' && req.method === 'GET') {
      try { return json(res, 200, await registryCredentialStatus()); }
      catch (e) { return json(res, Number(e?.code) || 503, { error: e?.reason || 'RegistryCredentialStoreUnavailable', message: e?.message, opId }); }
    }
    if (p === '/api/admin/extensions/registry-credentials' && req.method === 'PUT') {
      const body = await readBody(req).catch(() => ({}));
      const username = String(body.username || '').trim();
      const registryToken = String(body.token || '').trim();
      const reason = String(body.reason || '').trim();
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(username)) return json(res, 400, { error: 'InvalidRegistryUsername', opId });
      if (registryToken.length < 20 || registryToken.length > 1024 || /\s/.test(registryToken)) return json(res, 400, { error: 'InvalidRegistryToken', opId });
      if (reason.length < 8) return json(res, 400, { error: 'ApprovalReasonRequired', message: 'registry credential change reason must be at least 8 characters', opId });
      try {
        const stored = await storeRegistryCredentials(username, registryToken);
        await durableAudit(actor, 'registry-credentials-configure', 'ghcr.io', 'accepted', reason, opId);
        return json(res, 200, stored);
      } catch (e) {
        await durableAudit(actor, 'registry-credentials-configure', 'ghcr.io', 'error', e?.reason || 'store failed', opId);
        return json(res, Number(e?.code) || 503, { error: e?.reason || 'RegistryCredentialStoreUnavailable', message: e?.message, opId });
      }
    }
    if (p === '/api/admin/extensions/registry-credentials' && req.method === 'DELETE') {
      const body = await readBody(req).catch(() => ({}));
      const reason = String(body.reason || '').trim();
      if (reason.length < 8) return json(res, 400, { error: 'ApprovalReasonRequired', message: 'registry credential removal reason must be at least 8 characters', opId });
      try {
        const removed = await deleteRegistryCredentials();
        await durableAudit(actor, 'registry-credentials-remove', 'ghcr.io', 'accepted', reason, opId);
        return json(res, 200, removed);
      } catch (e) {
        await durableAudit(actor, 'registry-credentials-remove', 'ghcr.io', 'error', e?.reason || 'delete failed', opId);
        return json(res, Number(e?.code) || 503, { error: e?.reason || 'RegistryCredentialStoreUnavailable', message: e?.message, opId });
      }
    }
    if (p === '/api/admin/extensions/install' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const reason = String(body.reason || '').trim();
      if (reason.length < 8) return json(res, 400, { error: 'ApprovalReasonRequired', message: 'installation reason must be at least 8 characters', opId });
      try {
        const inspection = await inspectModuleImage(body.image);
        const pkg = packageFromInspection(inspection);
        if (pkg.spec.hostRef === FOUNDATION_ID) {
          const readiness = await platformReadinessStatus(req);
          const currentReg = await getReg(pkg.metadata.name);
          const verifiedUpdate = currentReg.ok && verifiedActivatedRegistration(currentReg.json);
          if (!readiness.ready && !verifiedUpdate) {
            await durableAudit(actor, 'extension-install', pkg.metadata.name, 'denied', 'PlatformSupportProfileRequiredForPfsPlugin', opId);
            return json(res, 409, {
              error: 'PlatformSupportProfileRequiredForPfsPlugin',
              message: 'A new PFS plugin installation requires Platform Support Profile Ready. A verified update is allowed only for an already Activated and Ready plugin.',
              opId,
            });
          }
          if (!readiness.ready && verifiedUpdate) {
            await durableAudit(actor, 'pfs-plugin-update-stage', pkg.metadata.name, 'accepted', 'verified Activated release update; new installation gate remains closed', opId);
          }
        }
        const stored = await upsertPackage(pkg);
        if (!stored.ok) return json(res, stored.status >= 500 ? 502 : stored.status, { error: 'PackageStoreFailed', status: stored.status, opId });
        const registered = await ensureRegistration(pkg.metadata.name, 'Installed', actor, reason);
        if (!registered.ok) return json(res, registered.status >= 500 ? 502 : registered.status, { error: 'RegistrationFailed', status: registered.status, opId });
        await durableAudit(actor, 'extension-install', pkg.metadata.name, 'accepted', inspection.image, opId);
        reconcile().catch((e) => console.error('reconcile error', e));
        return json(res, 202, { accepted: true, id: pkg.metadata.name, desiredState: 'Installed', image: inspection.image, verification: inspection.verification });
      } catch (e) {
        await durableAudit(actor, 'extension-install', String(body.image || '').slice(0, 160), 'denied', e?.reason || 'InspectionFailed', opId);
        return json(res, Number(e?.code) || 422, { error: e?.reason || 'InspectionFailed', message: e?.message || 'image inspection failed', issues: e?.issues || [], revocation: e?.revocation || null, opId });
      }
    }

    if (p === '/api/admin/plugins/catalog') {
      const pkgs = await listPackages();
      return json(res, 200, { items: (pkgs.json?.items || []).map((x) => ({ name: x.metadata.name, core: isCorePkg(x), scope: x.metadata.labels?.['opensphere.io/scope'] || null, ...x.spec })) });
    }
    if (p === '/api/admin/plugins/registrations') {
      const regs = await listRegs();
      // P2-2 증분: 활성 플러그인의 워크로드 health를 함께 노출(Admin UI lifecycle 가시성).
      const items = await Promise.all((regs.json?.items || []).map(async (x) => {
        const nm = x.metadata.name;
        const health = ['Installed', 'Enabled'].includes(x.spec.desiredState) ? (await workloadReady(nm) ? 'Ready' : 'NotReady') : 'N/A';
        return { name: nm, desiredState: x.spec.desiredState, status: x.status || {}, approval: x.spec.approval, health };
      }));
      return json(res, 200, { items });
    }
    if (p === '/api/admin/plugins/events') {
      // Supabase audit.event is the one durable notification source.  The
      // process-local ring never substitutes for this append-only authority.
      try {
        return json(res, 200, { items: await listConsoleAuditEvents() });
      } catch (e) {
        console.error('[audit] authoritative query failed:', String(e).slice(0, 160));
        return json(res, Number(e?.code) || 503, { error: e?.reason || 'SupabaseUnavailable', opId });
      }
    }

    // ── Bindings (headless 비-UI 확장): CLIDownload 등. UI plugins와 분리된 관리 채널(binding≠plugin) ──
    if (p === '/api/admin/bindings') {
      const cds = await listCliDownloads();
      const items = (cds.json?.items || [])
        .filter((x) => !NATIVE_BINDING_NAMES.has(x.metadata?.name))
        .map((x) => ({ kind: 'CLIDownload', name: x.metadata.name, ...x.spec, enabled: x.spec.enabled !== false }));
      return json(res, 200, { items });
    }
    // binding enable/disable = spec.enabled 소프트 토글(선언·서빙 유지, 콘솔 노출만). plugin Disable과 동형.
    const bm = p.match(/^\/api\/admin\/bindings\/([a-z0-9-]+)\/(enable|disable)$/);
    if (bm && req.method === 'POST') {
      const [, name, action] = bm;
      if (NATIVE_BINDING_NAMES.has(name)) return json(res, 409, { error: 'native_console_capability', name, opId });
      const r = await k8s('PATCH', `/apis/${CONSOLE_GROUP}/${V}/clidownloads/${name}`, { spec: { enabled: action === 'enable' } });
      if (!r.ok) { console.error(`[err] op=${opId} binding ${action} ${name} k8s ${r.status}:`, JSON.stringify(r.json).slice(0, 200)); await durableAudit(actor, action, 'binding/' + name, 'error', `HTTP ${r.status}`, opId); return json(res, r.status >= 500 ? 502 : r.status, { error: 'upstream error', status: r.status, opId }); }
      await durableAudit(actor, action, 'binding/' + name, 'accepted', '', opId);
      return json(res, 202, { accepted: true, name, enabled: action === 'enable' });
    }

    // ── P1 발행 백본(ADR-UI-003/UI-002 §D3): subShell 백엔드 → 콘솔 알림 소스(audit bus) 발행.
    // 콘솔 알림 NotificationService가 /api/admin/plugins/events 폴링으로 수집. source는 attribution.
    // 활성 확장뿐 아니라 서명·권한·워크로드 검증을 마친 Installed(stage) 확장도 수명주기 이벤트는
    // 발행할 수 있다. 이 예외는 이벤트 단일 경로에만 적용하며 proxyAllow/Registry/nav는 열지 않는다.
    if (p === '/api/admin/events' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
      const pluginId = clip(b.source || req.headers['x-opensphere-source'] || '', 60);
      try { await verifyWorkloadToken(req, pluginId, { allowVerifiedInstalled: true }); }
      catch (e) { return json(res, typeof e?.code === 'number' ? e.code : 502, { error: e?.msg || 'workload authentication failed', opId }); }
      const source = pluginId === 'opensphere-console-backend'
        ? `core:${pluginId}/${clip(b.userActor || 'system', 60)}`
        : 'ext:' + pluginId;
      const event = logAudit(clip(b.userActor || 'system', 60), clip(b.action || 'event', 60), clip(b.target || b.title || '', 120), clip(b.result || b.severity || 'info', 30), clip(b.reason || b.detail || '', 200), opId, { deferPersistence: true, source });
      try { await persistAuditNow(event); }
      catch (e) { console.error(`[audit] durable event persist failed op=${opId}:`, e); return json(res, 503, { error: 'event persistence unavailable', opId }); }
      return json(res, 202, { accepted: true, source });
    }

    const m = p.match(/^\/api\/admin\/plugins\/registrations\/([a-z0-9-]+)\/(install|enable|disable|uninstall|rollback)$/);
    if (m && req.method === 'POST') {
      const [, id, action] = m;
      if (id === FOUNDATION_ID && action === 'enable') {
        const readiness = await platformReadinessStatus(req);
        if (!readiness.admission.foundationActivationAllowed) {
          await durableAudit(actor, action, id, 'denied', 'PlatformSupportProfileRequired', opId);
          return json(res, 409, {
            error: 'PlatformSupportProfileRequired',
            message: 'Foundation activation requires Platform Support Profile Ready; staging as Installed/Ready is allowed',
            readiness: { phase: readiness.phase, prerequisites: readiness.prerequisites, capabilities: readiness.capabilities }, opId,
          });
        }
        if (readiness.admission.foundationActivationOverride) {
          await durableAudit(actor, 'foundation-development-override', id, 'accepted', 'Foundation subShell activation only; PFS plugins remain gated', opId);
        }
      }
      if (id !== FOUNDATION_ID && ['install', 'enable', 'rollback'].includes(action)) {
        const targetPkg = await getPackage(id);
        if (targetPkg.ok && targetPkg.json?.spec?.hostRef === FOUNDATION_ID) {
          const readiness = await platformReadinessStatus(req);
          const targetReg = await getReg(id);
          const verifiedUpdate = action === 'enable' && targetReg.ok && verifiedStagedUpdate(targetReg.json);
          if (!readiness.ready && !verifiedUpdate) {
            await durableAudit(actor, action, id, 'denied', 'PlatformSupportProfileRequiredForPfsPlugin', opId);
            return json(res, 409, {
              error: 'PlatformSupportProfileRequiredForPfsPlugin',
              message: 'PFS plugin lifecycle requires Platform Support Profile Ready. Only activation of a fully verified staged update to an existing plugin is permitted while the gate is closed.',
              opId,
            });
          }
          if (!readiness.ready && verifiedUpdate) {
            await durableAudit(actor, 'pfs-plugin-update-activate', id, 'accepted', 'verified staged update; new installation gate remains closed', opId);
          }
        }
      }
      // §3.1 강제: shell-pinned core 표면은 제거/비활성 불가(보안 경계 — UI 억제보다 본질).
      if (action === 'disable' || action === 'uninstall') {
        const pkgC = await k8s('GET', `${crd('uipluginpackages')}/${id}`);
        if (pkgC.ok && isCorePkg(pkgC.json)) {
          await durableAudit(actor, action, id, 'denied', 'core surface(shell-pinned) 제거/비활성 불가 (ADR-UI-003 §3.1)', opId);
          return json(res, 409, { error: 'core surface — not removable', core: true });
        }
      }
      if (action === 'rollback') {
        const rr = await k8s('GET', `${crd('uipluginregistrations')}/${id}`);
        if (!rr.ok) return json(res, rr.status === 404 ? 404 : 502, { error: 'registration not found', opId });
        const previousDigest = String(rr.json?.status?.previousDigest || '');
        const previousManifestSha256 = String(rr.json?.status?.previousManifestSha256 || '');
        const previousVersion = String(rr.json?.status?.previousVersion || '');
        const previousRequestedRef = String(rr.json?.status?.previousRequestedRef || '');
        const previousRequestedChannel = String(rr.json?.status?.previousRequestedChannel || '');
        const previousSource = String(rr.json?.status?.previousSource || '');
        const previousRevision = String(rr.json?.status?.previousRevision || '');
        const previousSignatureIdentity = String(rr.json?.status?.previousSignatureIdentity || '');
        const previousEvidenceRefs = Array.isArray(rr.json?.status?.previousEvidenceRefs) ? rr.json.status.previousEvidenceRefs.map(String) : [];
        const previousRegistryCredentialsRequired = rr.json?.status?.previousRegistryCredentialsRequired === true;
        if (!/^sha256:[a-f0-9]{64}$/.test(previousDigest) || !/^[a-f0-9]{64}$/.test(previousManifestSha256) || !previousVersion
          || !previousRequestedRef || !governedSourceRepository(previousSource) || !/^[a-f0-9]{40}$/.test(previousRevision)
          || !previousSignatureIdentity || previousEvidenceRefs.length < 2) {
          await durableAudit(actor, action, id, 'denied', 'verified previous release evidence is unavailable', opId);
          return json(res, 409, { error: 'verified previous release evidence is unavailable', opId });
        }
        const pr = await k8s('PATCH', `${crd('uipluginpackages')}/${id}`, { spec: {
          version: previousVersion,
          image: { digest: previousDigest },
          manifest: { sha256: previousManifestSha256 },
          resolution: {
            requestedRef: previousRequestedRef || previousDigest,
            requestedChannel: previousRequestedChannel,
            resolvedDigest: previousDigest,
            resolvedAt: new Date().toISOString(),
            artifactVersion: previousVersion,
            source: previousSource,
            revision: previousRevision,
            signatureIdentity: previousSignatureIdentity,
            registryCredentialsRequired: previousRegistryCredentialsRequired,
            evidenceRefs: previousEvidenceRefs,
          },
        } });
        if (!pr.ok) {
          await durableAudit(actor, action, id, 'error', `HTTP ${pr.status}`, opId);
          return json(res, pr.status >= 500 ? 502 : pr.status, { error: 'rollback patch failed', status: pr.status, opId });
        }
        await ensureRegistration(id, 'Enabled', actor, 'rollback to previous verified release');
        await durableAudit(actor, action, id, 'accepted', previousDigest, opId);
        reconcile().catch((e) => console.error('reconcile error', e));
        return json(res, 202, { accepted: true, id, desiredState: 'Enabled', digest: previousDigest, version: previousVersion });
      }
      const body = await readBody(req).catch(() => ({}));
      const desired = action === 'install' ? 'Installed' : action === 'enable' ? 'Enabled' : action === 'disable' ? 'Disabled' : 'Uninstalled';
      const r = await ensureRegistration(id, desired, actor, body.reason);
      if (!r.ok) { console.error(`[err] op=${opId} ${action} ${id} k8s ${r.status}:`, JSON.stringify(r.json).slice(0, 200)); await durableAudit(actor, action, id, 'error', `HTTP ${r.status}`, opId); return json(res, r.status >= 500 ? 502 : r.status, { error: 'upstream error', status: r.status, opId }); }
      await durableAudit(actor, action, id, 'accepted', '', opId);
      reconcile().catch((e) => console.error('reconcile error', e)); // 비동기 조정
      return json(res, 202, { accepted: true, id, desiredState: desired });
    }

    // 1단 아이콘 지정 — UIPluginPackage spec.nav.icon 패치(서명 무관 오버라이드). 패치 후 reconcile로 registry 즉시 반영.
    const im = p.match(/^\/api\/admin\/plugins\/packages\/([a-z0-9-]+)\/icon$/);
    if (im && req.method === 'POST') {
      const [, id] = im;
      const body = await readBody(req).catch(() => ({}));
      const icon = String(body.icon || '').slice(0, 64);
      const r = await k8s('PATCH', `${crd('uipluginpackages')}/${id}`, { spec: { nav: { icon } } });
      if (!r.ok) { console.error(`[err] op=${opId} set-icon ${id} k8s ${r.status}:`, JSON.stringify(r.json).slice(0, 200)); await durableAudit(actor, 'set-icon', id, 'error', `HTTP ${r.status}`, opId); return json(res, r.status >= 500 ? 502 : r.status, { error: 'upstream error', status: r.status, opId }); }
      await durableAudit(actor, 'set-icon', id, 'accepted', icon, opId);
      reconcile().catch((e) => console.error('reconcile error', e));
      return json(res, 202, { accepted: true, id, icon });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    // 감사 F: raw 예외 문자열을 클라이언트로 누출하지 않는다(내부 호스트/스택 노출 차단). 상세는 서버 로그.
    console.error(`[err] op=${opId} ${p}:`, e);
    if (!res.headersSent) json(res, e && e.code === 413 ? 413 : 500, { error: e && e.code === 413 ? 'payload too large' : 'internal error', opId });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`opensphere-console-dupa-controller listening :${PORT} (ns=${NS})`);
    // Supabase is the durable Data & Identity authority.  DUPA retains only
    // its plugin reconciliation/event loop and does not bootstrap CBS claims.
    hydrateAudit().finally(() => {
      const loop = () => Promise.all([reconcile(), pollK8sEvents()])
        .catch((e) => console.error('loop error', e))
        .finally(() => setTimeout(loop, 15000));
      loop();
    });
  });
} else {
  // 테스트로 require될 때는 서버 미기동 — 순수 보안 검증 로직만 노출(P2-4 회귀 테스트).
  module.exports = { isAdminGroups, safeName, validContributions, validCapabilities, integrationStatuses, moduleDescriptorIssues, packageFromInspection, deploymentManifest, pdbManifest, serviceManifest, hpaManifest, networkPolicyManifest, telemetryDescriptor, observerClusterRoleManifest, infrastructureManagerClusterRoleManifest, publishedPluginEntry, allowedCLIResourcePath, condition, deploymentReadyResult, foundationDevOverrideEnabled, parseModuleImageReference, runnablePlatformManifests, governedSourceRepository, attestationArguments, verifiedActivatedRegistration, verifiedStagedUpdate, bindingCapabilities, bindingConsumer, bindingContract, bindingPhase, safeBindingEndpoint };
}

// opensphere-console-dupa-controller (DUPA Admin Control PoC, 계획서 §9 + 검토 §B.1/§B.5)
// 한 Node.js 서비스가 3역할:
//   ① reconcile : UIPluginRegistration desiredState → workload apply/delete + 검증 + registry 생성
//   ② Control API: /api/admin/plugins/* (Admin UI가 호출, kubectl 없이 상태 전이)
//   ③ proxy authorization projection (public Registry는 opensphere-registry 단일 권위)
// 신뢰 루트는 UIPluginPackage(관리자 승인값). controller는 digest를 '계산해 비교'만 하고
// registry에는 승인값을 '전사'한다(§B.5). 이중 검증: 여기(설치 시점) + 셸(로드 시점).
// 의존성 0 (node 내장 http/crypto/fs).
const http = require('http');
const https = require('https');
const fs = require('fs');
const { execFile } = require('child_process');
const { createHash, createPublicKey, verify, randomBytes } = require('crypto');
const db = require('./db'); // Backbone PostgreSQL(감사로그 영속). 미연결 시 관리 쓰기 fail-closed.
const storage = require('./storage'); // Backbone RustFS(S3). BackboneClaim objectStore 할당. 미연결 시 관리 쓰기 fail-closed.
const { createSupabaseVerifier } = require('./supabase-auth');

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
const AI_DOMAIN_NAMESPACE = process.env.AI_DOMAIN_NAMESPACE || 'opensphere-system';
const APPROVED_PERMISSION_PROFILES = new Set(['none', 'cluster-observer-v1', 'cluster-his-manager-v1', 'cluster-infrastructure-manager-v1', 'ai-domain-operator-v1']);
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
// Backbone PostgreSQL(감사로그 영속) — 기본값=이 클러스터 service DNS. 비번은 env 아닌 Secret에서 런타임 로드.
const BACKBONE_PG = {
  host: process.env.BACKBONE_PG_HOST || 'backbone-postgres.opensphere-backbone.svc.cluster.local',
  port: process.env.BACKBONE_PG_PORT || '5432',
  database: process.env.BACKBONE_PG_DB || 'console',
  user: process.env.BACKBONE_PG_USER || 'console',
  secretNs: process.env.BACKBONE_PG_SECRET_NS || 'opensphere-backbone',
  secretName: process.env.BACKBONE_PG_SECRET || 'backbone-postgres',
  secretKey: process.env.BACKBONE_PG_SECRET_KEY || 'password',
};

const token = () => fs.readFileSync(`${SA}/token`, 'utf8').trim();
// NODE_EXTRA_CA_CERTS는 deployment env로 주입 (Node fetch는 시작 시점에 읽음)

// ── 호출자 검증(Kanidm 콘솔 id_token, ES256) — 감사 P0-1/P1-3 차단 ──────────
// opensphere-console-backend(opensphere-identity)의 governance gate와 동일 규칙: JWKS(ES256) 서명검증 +
// iss/azp/aud/exp/nbf 검증 → opensphere-console-admins 그룹만 변경 허용. actor는 헤더가 아니라
// '검증된 토큰 claim'에서 도출(X-OpenSphere-User 스푸핑 무력화).
const DEFAULT_KANIDM_ISSUERS = [
  'https://auth.console.opensphere.dev/oauth2/openid/opensphere-console',
  'https://localhost:8444/oauth2/openid/opensphere-console',
];
const KANIDM_ISSUERS = (process.env.KANIDM_ISSUERS || process.env.KANIDM_ISS || DEFAULT_KANIDM_ISSUERS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Console 브라우저 id_token의 최종 발급자는 opensphere-console-auth BFF다. Kanidm core는
// upstream identity만 제공하므로 core JWKS로 검증하면 BFF kid가 없어 관리 API가 401이 된다.
const KANIDM_JWKS_URL = process.env.KANIDM_JWKS_URL || 'https://opensphere-console-auth.opensphere-console.svc:8443/oauth2/openid/opensphere-console/public_key.jwk';
const KANIDM_TLS_SERVERNAME = process.env.KANIDM_TLS_SERVERNAME || 'kanidm.opensphere-console-auth.svc';
const KANIDM_AZP = process.env.KANIDM_AZP || 'opensphere-console';
const KANIDM_ADMIN_GROUP = process.env.KANIDM_ADMIN_GROUP || 'opensphere-console-admins';
const KANIDM_CA_PATH = process.env.KANIDM_CA_PATH || '/etc/kanidm-ca/ca.crt';
// BFF가 발급한 모든 콘솔 자격(브라우저 OIDC 세션·PAT·CLI 세션)은 서명만으로 충분하지 않다.
// 단일 권위는 auth BFF의 서버측 상태와 현재 Kanidm 역할이므로 모든 DUPA 요청마다 확인한다.
// 이 검사는 캐시하지 않는다. 계정 비활성화·역할 회수·자격 폐기는 다음 요청부터 즉시 거부돼야 한다.
const TOKEN_INTROSPECTION_URL = process.env.TOKEN_INTROSPECTION_URL
  || 'https://opensphere-console-auth.opensphere-console.svc:8443/bff/token/introspect';
const TOKEN_INTROSPECTION_SERVERNAME = process.env.TOKEN_INTROSPECTION_SERVERNAME || KANIDM_TLS_SERVERNAME;
// Console auth is in Supabase cutover.  Keep Kanidm support only for an
// explicit dual-read migration; production Supabase tokens are verified against
// the live operator and role records, never JWT claims alone.
const AUTH_PROVIDER = process.env.AUTH_PROVIDER || 'kanidm';
const SUPABASE_AUTH_ISSUER = process.env.SUPABASE_AUTH_ISSUER || '';
const SUPABASE_AUTH_AUDIENCE = process.env.SUPABASE_AUTH_AUDIENCE || 'authenticated';
const SUPABASE_REST_URL = (process.env.SUPABASE_REST_URL || '').replace(/\/$/, '');
const SUPABASE_RUNTIME_SECRET_NS = process.env.SUPABASE_RUNTIME_SECRET_NS || NS;
const SUPABASE_RUNTIME_SECRET = process.env.SUPABASE_RUNTIME_SECRET || 'opensphere-supabase-runtime';
const SUPABASE_ADMIN_GROUP = process.env.SUPABASE_ADMIN_GROUP || 'console-admins';
let _supabaseVerifier = null;
let _kanidmCa;
function kanidmCa() { if (_kanidmCa === undefined) { try { _kanidmCa = fs.readFileSync(KANIDM_CA_PATH); } catch (e) { console.error('[auth] kanidm CA read failed: ' + e); _kanidmCa = null; } } return _kanidmCa; }
function b64urlToBuf(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
const shortName = (spn) => String(spn).split('@')[0];
let _kjwks = null, _kjwksAt = 0; const KJWKS_TTL = 5 * 60 * 1000;
function kanidmGetJwks(force) {
  return new Promise((resolve, reject) => {
    if (!force && _kjwks && (Date.now() - _kjwksAt) < KJWKS_TTL) return resolve(_kjwks);
    const u = new URL(KANIDM_JWKS_URL);
    const rq = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', ca: kanidmCa(), servername: KANIDM_TLS_SERVERNAME }, (resp) => {
      const ch = []; resp.on('data', (c) => ch.push(c));
      resp.on('end', () => { try { const j = JSON.parse(Buffer.concat(ch).toString('utf8')); _kjwks = j.keys || (j.kty ? [j] : []); _kjwksAt = Date.now(); resolve(_kjwks); } catch (e) { reject(e); } });
    });
    rq.on('error', reject); rq.end();
  });
}
// 순수 claim 검증(alg/iss/azp/aud/exp/nbf) — 서명 검증과 분리해 단위 테스트 가능(P2-4). now는 주입 가능.
// 재감사 P2-2: 필수 claim(exp·sub·iat) 부재를 거부 — exp 없는 토큰이 통과하던 갭 차단.
function assertClaims(header, claims, now = Date.now()) {
  const aud = Array.isArray(claims.aud) ? claims.aud : (claims.aud ? [claims.aud] : []);
  if (header.alg !== 'ES256') throw { code: 401, msg: 'unexpected alg' };
  if (!KANIDM_ISSUERS.includes(claims.iss)) throw { code: 401, msg: 'bad iss' };
  if (claims.azp !== KANIDM_AZP && !aud.includes(KANIDM_AZP)) throw { code: 401, msg: 'bad azp/aud' };
  if (!claims.exp) throw { code: 401, msg: 'missing exp' };
  if (!claims.sub) throw { code: 401, msg: 'missing sub' };
  if (!claims.iat) throw { code: 401, msg: 'missing iat' };
  if (claims.exp * 1000 < now) throw { code: 401, msg: 'token expired' };
  if (claims.nbf && claims.nbf * 1000 > now + 30000) throw { code: 401, msg: 'token not yet valid' };
}
function assertManagedTokenActive(claims, state) {
  if (claims.typ !== undefined && claims.typ !== 'pat' && claims.typ !== 'cli_session') {
    throw { code: 401, msg: 'unsupported token type' };
  }
  if (!state || state.active !== true) throw { code: 401, msg: 'credential inactive or revoked' };
  if (state.sub !== claims.sub || state.username !== claims.preferred_username || state.exp !== claims.exp) {
    throw { code: 401, msg: 'credential state mismatch' };
  }
  // Browser id_token도 live Kanidm 계정/역할에 bind된다. 서명 당시 claim만 믿지 않는다.
  if (claims.typ === undefined) {
    if (state.type !== 'browser_session') throw { code: 401, msg: 'browser session state mismatch' };
    return;
  }
  if (!claims.jti || state.jti !== claims.jti) throw { code: 401, msg: 'credential state mismatch' };
  if (claims.typ === 'cli_session' && (!claims.device_id || state.deviceId !== claims.device_id)) {
    throw { code: 401, msg: 'device state mismatch' };
  }
}
function introspectManagedToken(jwt) {
  return new Promise((resolve, reject) => {
    const u = new URL(TOKEN_INTROSPECTION_URL);
    const body = Buffer.from(new URLSearchParams({ token: jwt }).toString());
    const rq = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      ca: kanidmCa(),
      servername: TOKEN_INTROSPECTION_SERVERNAME,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': body.length,
        accept: 'application/json',
      },
    }, (resp) => {
      const chunks = [];
      let size = 0;
      resp.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 64 * 1024) chunks.push(chunk);
      });
      resp.on('end', () => {
        if (size > 64 * 1024) return reject(new Error('token introspection response too large'));
        if (resp.statusCode !== 200) return reject(new Error(`token introspection HTTP ${resp.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('token introspection returned invalid JSON')); }
      });
    });
    rq.setTimeout(3000, () => rq.destroy(new Error('token introspection timeout')));
    rq.on('error', reject);
    rq.write(body);
    rq.end();
  });
}
const SUPABASE_ROLE_COMPAT = Object.freeze({
  'console-admins': 'opensphere-console-admins',
  'console-operators': 'opensphere-console-operators',
  'console-viewers': 'opensphere-console-viewers',
});
function canonicalConsoleGroups(groups) {
  const out = [];
  for (const item of groups || []) {
    const group = String(item || '').trim();
    if (!group || out.includes(group)) continue;
    out.push(group);
    const compat = SUPABASE_ROLE_COMPAT[group];
    if (compat && !out.includes(compat)) out.push(compat);
  }
  return out;
}
async function loadSupabaseVerifier() {
  if (_supabaseVerifier) return _supabaseVerifier;
  if (!SUPABASE_AUTH_ISSUER || !SUPABASE_REST_URL) {
    throw { code: 503, msg: 'Supabase auth configuration is incomplete' };
  }
  const secret = await k8s('GET', `/api/v1/namespaces/${SUPABASE_RUNTIME_SECRET_NS}/secrets/${SUPABASE_RUNTIME_SECRET}`);
  if (!secret.ok) throw { code: 503, msg: `Supabase runtime secret HTTP ${secret.status}` };
  const jwtSecret = Buffer.from(String(secret.json?.data?.['jwt-secret'] || ''), 'base64').toString('utf8');
  const serviceRoleKey = Buffer.from(String(secret.json?.data?.['service-role-key'] || ''), 'base64').toString('utf8');
  if (!jwtSecret || !serviceRoleKey) throw { code: 503, msg: 'Supabase runtime secret is incomplete' };
  _supabaseVerifier = createSupabaseVerifier({
    issuer: SUPABASE_AUTH_ISSUER,
    audience: SUPABASE_AUTH_AUDIENCE,
    restUrl: SUPABASE_REST_URL,
    jwtSecret,
    serviceRoleKey,
  });
  return _supabaseVerifier;
}
const isAdminGroups = (groups) => (groups || []).includes(KANIDM_ADMIN_GROUP) || (groups || []).includes(SUPABASE_ADMIN_GROUP);
async function verifyKanidmAuthed(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw { code: 401, msg: 'no bearer token' };
  const [h, pp, s] = m[1].split('.');
  if (!h || !pp || !s) throw { code: 401, msg: 'malformed token' };
  const header = JSON.parse(b64urlToBuf(h).toString());
  const claims = JSON.parse(b64urlToBuf(pp).toString());
  if (header.alg !== 'ES256') throw { code: 401, msg: 'unexpected alg' };
  let jwk = (await kanidmGetJwks()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await kanidmGetJwks(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw { code: 401, msg: 'unknown kid (kanidm)' };
  const pub = createPublicKey({ key: jwk, format: 'jwk' });
  if (!verify('SHA256', Buffer.from(`${h}.${pp}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64urlToBuf(s))) throw { code: 401, msg: 'bad signature' };
  assertClaims(header, claims);
  // 브라우저 세션까지 포함한 모든 token은 BFF의 live identity state로 검증한다.
  // BFF/identity 경로가 불능이면 fail-closed로 관리 API를 열지 않는다.
  const managedState = await introspectManagedToken(m[1]);
  assertManagedTokenActive(claims, managedState);
  // 관리 자격은 서명 당시 group claim이 아니라 introspection이 조회한 현재 Kanidm 역할을 사용한다.
  const groups = (managedState.groups || []).map((g) => shortName(g).replace(/^\//, ''));
  return { username: claims.preferred_username || 'unknown', groups };
}
async function verifyAuthed(req) {
  if (AUTH_PROVIDER === 'kanidm') return verifyKanidmAuthed(req);
  const auth = req.headers['authorization'] || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) throw { code: 401, msg: 'no bearer token' };
  if (AUTH_PROVIDER === 'supabase') {
    const actor = await (await loadSupabaseVerifier())(match[1]);
    actor.groups = canonicalConsoleGroups(actor.groups);
    return actor;
  }
  if (AUTH_PROVIDER !== 'dual') throw { code: 503, msg: 'unknown authentication provider' };
  let issuer = '';
  try { issuer = JSON.parse(b64urlToBuf(match[1].split('.')[1]).toString()).iss || ''; }
  catch { throw { code: 401, msg: 'malformed token' }; }
  if (issuer === SUPABASE_AUTH_ISSUER) {
    const actor = await (await loadSupabaseVerifier())(match[1]);
    actor.groups = canonicalConsoleGroups(actor.groups);
    return actor;
  }
  return verifyKanidmAuthed(req);
}
async function verifyActor(req) {
  const a = await verifyAuthed(req);
  if (!isAdminGroups(a.groups)) throw { code: 403, msg: `not in ${KANIDM_ADMIN_GROUP}` };
  if (a.provider === 'supabase' && a.assurance !== 'aal2') throw { code: 403, msg: 'admin action requires MFA assurance aal2' };
  return a;
}

// ── audit (감사 P1-4: 영속화 + operationId) ──────────────────────────────
// 인메모리 링버퍼는 조회 캐시일 뿐이다. 영구 정본은 Backbone PostgreSQL append-only audit_log이며,
// Backbone 부재 시 관리 쓰기를 503으로 막는다(ConfigMap/메모리 폴백은 보안 게이트가 될 수 없음).
const AUDIT_CAP = 500;
const audit = [];
function logAudit(actor, action, target, result, reason, opId, options = {}) {
  const e = { time: new Date().toISOString(), opId: opId || newOpId(), source: options.source || 'dupa-controller', actor: actor || 'system', action, target, result, reason: reason || '' };
  audit.unshift(e);
  if (audit.length > AUDIT_CAP) audit.pop();
  console.log('[audit] ' + JSON.stringify(e)); // 구조화 1줄 → 로그 수집기 영속(휘발 대비)
  if (options.deferPersistence) {
    return e;
  }
  if (db.isEnabled()) {
    // 읽기성/비동기 이벤트용 best-effort. 관리 쓰기 경로는 durableAudit()로 완료를 기다린다.
    db.insertAudit(e).catch((err) => console.error('[audit] pg insert 실패:', String(err).slice(0, 120)));
  } else {
    console.error('[audit] Backbone PostgreSQL unavailable; event is not durable');
  }
  return e;
}
async function persistAuditNow(event) {
  if (!db.isEnabled()) throw new Error('Backbone PostgreSQL unavailable');
  await db.insertAudit(event);
}
async function durableAudit(actor, action, target, result, reason, opId, source = 'dupa-controller') {
  const event = logAudit(actor, action, target, result, reason, opId, { deferPersistence: true, source });
  await persistAuditNow(event);
  return event;
}
const newOpId = () => randomBytes(8).toString('hex');
async function hydrateAudit() {
  if (db.isEnabled()) {
    // PG 우선 — recentAudit는 newest-first → ring(unshift 규약상 [0]=최신)에 그대로 push.
    try {
      const rows = await db.recentAudit(AUDIT_CAP);
      rows.forEach((e) => audit.push(e));
      console.log(`[audit] hydrated ${audit.length} entries from PostgreSQL`);
      return;
    } catch (e) { console.error('[audit] pg hydrate 실패:', String(e).slice(0, 120)); }
  }
  console.warn('[audit] Backbone PostgreSQL unavailable; no non-durable fallback loaded');
}
// Backbone PostgreSQL 연결 초기화 — Secret(opensphere-backbone/backbone-postgres)에서 비번 로드 후 pool 기동.
// 실패(미설치·연결불가) 시 읽기 전용 표면만 유지하고 관리 쓰기는 fail-closed 한다.
async function initBackboneDb(quiet = false) {
  try {
    const r = await k8s('GET', `/api/v1/namespaces/${BACKBONE_PG.secretNs}/secrets/${BACKBONE_PG.secretName}`);
    if (!r.ok) { if (!quiet) console.warn(`[db] secret ${BACKBONE_PG.secretNs}/${BACKBONE_PG.secretName} 없음(HTTP ${r.status})`); return; }
    const enc = r.json?.data?.[BACKBONE_PG.secretKey];
    if (!enc) { if (!quiet) console.warn('[db] secret에 password 키 없음'); return; }
    const password = Buffer.from(enc, 'base64').toString('utf8');
    const ca = r.json?.data?.['ca.crt'];
    if (!ca) { if (!quiet) console.warn('[db] secret에 ca.crt 키 없음'); return; }
    const sslCa = Buffer.from(ca, 'base64').toString('utf8');
    await db.init({ host: BACKBONE_PG.host, port: BACKBONE_PG.port, database: BACKBONE_PG.database, user: BACKBONE_PG.user, password, sslCa });
  } catch (e) {
    if (!quiet) console.warn('[db] init 실패:', String(e).slice(0, 160));
  }
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
  /^\/apis\/backbone\.opensphere\.io\/v1alpha1\/backboneclaims(?:\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)?$/,
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
  'HorizontalPodAutoscalerApplyFailed', 'NetworkPolicyApplyFailed', 'ServiceMonitorApplyFailed',
]).has(reason);

async function verifyWorkloadToken(req, pluginId, { allowVerifiedInstalled = false } = {}) {
  const firstParty = new Map([
    ['opensphere-console-backend', `system:serviceaccount:${NS}:opensphere-console-backend`],
    ['opensphere-console-auth', `system:serviceaccount:${NS}:opensphere-console-auth`],
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
    { name: 'KANIDM_CA_PATH', value: '/etc/opensphere/auth-ca/ca.crt' },
    { name: 'KANIDM_ISSUERS', value: 'https://localhost:8090/oauth2/openid/opensphere-console' },
    { name: 'KANIDM_JWKS_URL', value: 'https://opensphere-console-auth.opensphere-console.svc:8443/oauth2/openid/opensphere-console/public_key.jwk' },
    { name: 'KANIDM_TLS_SERVERNAME', value: 'kanidm.opensphere-console-auth.svc' },
    { name: 'TOKEN_INTROSPECTION_URL', value: 'https://opensphere-console-auth.opensphere-console.svc:8443/bff/token/introspect' },
    { name: 'TOKEN_INTROSPECTION_SERVERNAME', value: 'kanidm.opensphere-console-auth.svc' },
    { name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
    { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
    { name: 'OSP_LOG_FORMAT', value: String(pkg.spec.runtime?.observability?.logs?.format || 'json') },
    { name: 'OSP_LOG_SCHEMA', value: String(pkg.spec.runtime?.observability?.logs?.schema || 'opensphere.v1') },
    { name: 'OSP_LOG_STREAM', value: String(pkg.spec.runtime?.observability?.logs?.stream || 'stdout') },
    { name: 'OTEL_SERVICE_NAME', value: String(pkg.metadata?.name || '') },
  ];
  const seen = new Set(env.map((item) => item.name));
  if (pkg.spec?.permissionProfile === 'ai-domain-operator-v1') {
    env.push(
      { name: 'AI_DOMAIN_NAMESPACE', value: AI_DOMAIN_NAMESPACE },
      { name: 'OSP_AI_RUNTIME_MODE', value: 'managed' },
      { name: 'OSP_CONTROLLER', value: `http://opensphere-console-dupa-controller.${NS}.svc.cluster.local:8080` },
      // The platform release must provide an immutable, approved workbench
      // image.  Deliberately do not fall back to a localhost development tag.
      { name: 'WORKBENCH_IMAGE', value: process.env.AI_WORKBENCH_IMAGE || '' },
    );
    for (const item of env.slice(-4)) seen.add(item.name);
  }
  for (const item of pkg.spec?.env || []) {
    const name = String(item?.name || '');
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
            // Console 인증 CA는 공개 신뢰 앵커이며 비밀키가 아니다. 플러그인이 Kanidm JWT의
            // JWKS를 TLS 검증 후 조회할 수 있도록 모든 관리 워크로드에 read-only로 제공한다.
            volumeMounts: [
              { name: 'opensphere-console-auth-ca', mountPath: '/etc/opensphere/auth-ca', readOnly: true },
              ...(readOnlyRootFilesystem ? [{ name: 'runtime-tmp', mountPath: '/tmp' }] : []),
            ],
            readinessProbe: { httpGet: { path: healthPath, port }, initialDelaySeconds: 1 },
            livenessProbe: { httpGet: { path: healthPath, port }, initialDelaySeconds: 10, periodSeconds: 10 },
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem },
            resources: { requests: { cpu: r.cpuRequest || '20m', memory: r.memoryRequest || '32Mi' }, limits: { cpu: r.cpuLimit || '200m', memory: r.memoryLimit || '128Mi' } },
          }],
          volumes: [
            { name: 'opensphere-console-auth-ca', secret: { secretName: 'opensphere-console-auth-ca', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
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
  if (policy.allowMonitoring === true) ingressFrom.push({ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'monitoring' } } });
  const egress = [
    { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': NS } } }] },
    { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
  ];
  // AI runs in the Console namespace but its declared operands live in the AI,
  // Backbone and identity namespaces.  Keep this fixed in the host profile;
  // arbitrary egress selectors must never come from an OCI descriptor.
  if (pkg.spec?.permissionProfile === 'ai-domain-operator-v1') {
    for (const namespace of [AI_DOMAIN_NAMESPACE, 'opensphere-backbone', 'opensphere-console-auth', 'opendatahub', 'default']) {
      egress.push({ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } } }] });
    }
  }
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name, namespace: NS, labels: { 'opensphere.io/dupa-plugin': name }, ownerReferences: [ownerRef(pkg)] },
    spec: {
      podSelector: { matchLabels: { app: name } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: ingressFrom, ports: [{ protocol: 'TCP', port: Number(pkg.spec.runtime?.port) || 8080 }] }],
      egress,
    },
  };
}

function serviceMonitorManifest(pkg) {
  const obs = pkg.spec.contributions?.observability;
  if (obs?.enabled !== true || obs.metrics !== true || !pkg.spec.runtime?.observability?.metricsPath) return null;
  const name = pkg.metadata.name;
  return {
    apiVersion: 'monitoring.coreos.com/v1', kind: 'ServiceMonitor',
    metadata: { name, namespace: NS, labels: { app: name, release: 'kube-prometheus-stack', 'opensphere.io/dupa-plugin': name }, ownerReferences: [ownerRef(pkg)] },
    spec: {
      namespaceSelector: { matchNames: [NS] },
      selector: { matchLabels: { app: name } },
      endpoints: [{ port: 'http', path: String(pkg.spec.runtime?.observability?.metricsPath || '/metrics'), interval: String(pkg.spec.runtime?.observability?.scrapeInterval || '30s') }],
    },
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
      { apiGroups: ['kubevirt.io', 'subresources.kubevirt.io', 'cdi.kubevirt.io', 'instancetype.kubevirt.io', 'migrations.kubevirt.io', 'snapshot.storage.k8s.io', 'forklift.konveyor.io', 'monitoring.coreos.com', 'ceph.rook.io', 'template.openshift.io', 'fleet.opensphere.io', 'cluster.open-cluster-management.io'], resources: ['*'], verbs: ['get', 'list', 'watch'] },
    ],
  };
}
function hisManagerClusterRoleManifest() {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole',
    metadata: { name: 'opensphere-module-cluster-his-manager-v1', labels: { 'opensphere.io/managed-by': 'dupa' } },
    rules: [
      ...observerClusterRoleManifest().rules,
      { apiGroups: [''], resources: ['namespaces', 'serviceaccounts', 'services', 'configmaps', 'secrets', 'pods', 'persistentvolumeclaims', 'endpoints', 'events'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['apps'], resources: ['deployments', 'daemonsets', 'statefulsets', 'replicasets'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['batch'], resources: ['jobs'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['policy'], resources: ['poddisruptionbudgets'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'ingressclasses', 'networkpolicies'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['coordination.k8s.io'], resources: ['leases'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['apiextensions.k8s.io'], resources: ['customresourcedefinitions'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['admissionregistration.k8s.io'], resources: ['validatingwebhookconfigurations', 'mutatingwebhookconfigurations'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['apiregistration.k8s.io'], resources: ['apiservices'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['cert-manager.io'], resources: ['issuers', 'clusterissuers', 'certificates', 'certificaterequests'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['acme.cert-manager.io'], resources: ['challenges', 'orders'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['monitoring.coreos.com'], resources: ['prometheuses', 'alertmanagers', 'prometheusrules', 'servicemonitors', 'podmonitors', 'probes', 'thanosrulers', 'scrapeconfigs', 'alertmanagerconfigs'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['rbac.authorization.k8s.io'], resources: ['roles', 'clusterroles'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'bind', 'escalate'] },
      { apiGroups: ['rbac.authorization.k8s.io'], resources: ['rolebindings', 'clusterrolebindings'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
    ],
  };
}
function infrastructureManagerClusterRoleManifest() {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole',
    metadata: { name: 'opensphere-module-cluster-infrastructure-manager-v1', labels: { 'opensphere.io/managed-by': 'dupa' } },
    rules: [
      ...hisManagerClusterRoleManifest().rules,
      { apiGroups: ['storage.k8s.io'], resources: ['storageclasses'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['snapshot.storage.k8s.io'], resources: ['volumesnapshotclasses'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['snapshot.storage.k8s.io'], resources: ['volumesnapshots'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['ceph.rook.io', 'csi.ceph.io'], resources: ['*'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
    ],
  };
}
function requiresDomainSubShellAdmission(pkg) {
  // Bootstrap/reference shells use the existing lifecycle gates.  AI is the
  // first domain subShell and must not bypass the PFS admission boundary.
  return pkg?.spec?.kind === 'subShell'
    && pkg?.spec?.hostRef === 'main'
    && pkg?.spec?.permissionProfile === 'ai-domain-operator-v1';
}
function aiDomainOperatorClusterRoleManifest() {
  const read = ['get', 'list', 'watch'];
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole',
    metadata: { name: 'opensphere-module-ai-domain-operator-v1', labels: { 'opensphere.io/managed-by': 'dupa' } },
    rules: [
      { apiGroups: [''], resources: ['nodes', 'namespaces', 'pods', 'pods/log', 'services', 'configmaps', 'events'], verbs: read },
      { apiGroups: ['apps'], resources: ['deployments', 'replicasets', 'statefulsets'], verbs: read },
      { apiGroups: ['batch'], resources: ['jobs'], verbs: read },
      { apiGroups: ['storage.k8s.io'], resources: ['storageclasses'], verbs: read },
      { apiGroups: ['apiextensions.k8s.io'], resources: ['customresourcedefinitions'], verbs: read },
      { apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectaccessreviews'], verbs: ['create'] },
      { apiGroups: [''], resources: ['users'], verbs: ['impersonate'] },
      { apiGroups: ['operators.coreos.com'], resources: ['operatorgroups', 'subscriptions', 'installplans', 'clusterserviceversions'], verbs: read },
      { apiGroups: ['kubeflow.org'], resources: ['notebooks'], verbs: read },
      { apiGroups: ['serving.kserve.io'], resources: ['servingruntimes', 'clusterservingruntimes', 'inferenceservices'], verbs: read },
      { apiGroups: ['modelregistry.opendatahub.io'], resources: ['modelregistries'], verbs: read },
      { apiGroups: ['trustyai.opendatahub.io'], resources: ['trustyaiservices'], verbs: read },
      { apiGroups: ['kueue.x-k8s.io'], resources: ['workloads', 'clusterqueues', 'localqueues', 'resourceflavors'], verbs: read },
      { apiGroups: ['ray.io'], resources: ['rayclusters', 'rayjobs', 'rayservices'], verbs: read },
      { apiGroups: ['tekton.dev'], resources: ['pipelines', 'pipelineruns'], verbs: read },
      { apiGroups: ['datasciencepipelinesapplications.opendatahub.io'], resources: ['datasciencepipelinesapplications', 'datasciencepipelinesapplications/api'], verbs: read },
      { apiGroups: ['datasciencecluster.opendatahub.io'], resources: ['datascienceclusters'], verbs: read },
      { apiGroups: ['backbone.opensphere.io'], resources: ['backboneclaims'], verbs: read },
      { apiGroups: ['orchestrator.ai.opensphere.io'], resources: ['aiagents', 'promptlibraries', 'toolclaims', 'agenttracepolicies'], verbs: read },
      { apiGroups: ['ai.foundation.opensphere.io'], resources: ['llmrouteclaims', 'vectorretrievalclaims'], verbs: read },
      { apiGroups: ['ai.opensphere.io'], resources: ['aitrainingstacks', 'workbenchclaims', 'dataconnectionclaims', 'computebackendclaims', 'datasetclaims', 'trainingjobclaims', 'modelpromotionclaims', 'inferenceclaims', 'pipelineclaims', 'pipelinerunclaims', 'experimentclaims', 'executionclaims', 'artifactclaims', 'monitoringtargets', 'distributedworkloadclaims', 'openspherecomponentcatalogs', 'openspherecomponentversions', 'openspheresubscriptions', 'opensphereinstallplans', 'openspheredatascienceclusters'], verbs: read },
      { apiGroups: ['eval.ai.opensphere.io'], resources: ['evaluationpolicies', 'evaluationjobs'], verbs: read },
    ],
  };
}
function aiDomainScopedRoleManifest() {
  const mutate = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'];
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role',
    metadata: { name: 'opensphere-module-ai-domain-operator-v1', namespace: AI_DOMAIN_NAMESPACE, labels: { 'opensphere.io/managed-by': 'dupa' } },
    rules: [
      { apiGroups: [''], resources: ['services', 'persistentvolumeclaims', 'configmaps', 'events'], verbs: mutate },
      { apiGroups: [''], resources: ['secrets'], resourceNames: ['oah-external-gpu-credentials', 'ai-hub-backbone-postgres', 'ai-hub-backbone-postgres-app', 'oah-dspa-postgres', 'ai-hub-backbone-rustfs', 'ai-hub-kserve-s3', 'ds-pipelines-proxy-tls-oah-dspa', 'ds-pipelines-envoy-proxy-tls-oah-dspa', 'opensphere-wildcard-tls', 'shell-service-token'], verbs: ['get', 'update', 'patch'] },
      { apiGroups: [''], resources: ['secrets'], verbs: ['create'] },
      { apiGroups: [''], resources: ['serviceaccounts'], resourceNames: ['ai-runtime'], verbs: ['get', 'update', 'patch'] },
      { apiGroups: ['apps'], resources: ['deployments'], verbs: mutate },
      { apiGroups: ['batch'], resources: ['jobs'], verbs: mutate },
      { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], verbs: mutate },
      { apiGroups: ['kubeflow.org'], resources: ['notebooks'], verbs: ['update', 'patch'] },
      { apiGroups: ['serving.kserve.io'], resources: ['inferenceservices'], verbs: mutate },
      { apiGroups: ['ray.io'], resources: ['rayjobs'], verbs: mutate },
      { apiGroups: ['tekton.dev'], resources: ['pipelineruns'], verbs: mutate },
      { apiGroups: ['datasciencepipelinesapplications.opendatahub.io'], resources: ['datasciencepipelinesapplications'], verbs: mutate },
      { apiGroups: ['orchestrator.ai.opensphere.io'], resources: ['aiagents', 'promptlibraries', 'toolclaims', 'agenttracepolicies', 'aiagents/status', 'promptlibraries/status', 'toolclaims/status', 'agenttracepolicies/status'], verbs: mutate },
      { apiGroups: ['ai.foundation.opensphere.io'], resources: ['llmrouteclaims', 'vectorretrievalclaims', 'llmrouteclaims/status', 'vectorretrievalclaims/status'], verbs: mutate },
      { apiGroups: ['ai.opensphere.io'], resources: ['aitrainingstacks', 'workbenchclaims', 'dataconnectionclaims', 'computebackendclaims', 'datasetclaims', 'trainingjobclaims', 'modelpromotionclaims', 'inferenceclaims', 'pipelineclaims', 'pipelinerunclaims', 'experimentclaims', 'executionclaims', 'artifactclaims', 'monitoringtargets', 'distributedworkloadclaims', 'openspheresubscriptions', 'opensphereinstallplans', 'openspheredatascienceclusters', 'workbenchclaims/status', 'dataconnectionclaims/status', 'computebackendclaims/status', 'datasetclaims/status', 'trainingjobclaims/status', 'pipelineclaims/status', 'pipelinerunclaims/status', 'experimentclaims/status', 'executionclaims/status', 'artifactclaims/status', 'inferenceclaims/status', 'modelpromotionclaims/status', 'monitoringtargets/status', 'distributedworkloadclaims/status', 'openspheresubscriptions/status', 'opensphereinstallplans/status', 'openspheredatascienceclusters/status'], verbs: mutate },
      { apiGroups: ['backbone.opensphere.io'], resources: ['backboneclaims'], verbs: ['create', 'update', 'patch'] },
      { apiGroups: ['eval.ai.opensphere.io'], resources: ['evaluationpolicies', 'evaluationjobs', 'evaluationpolicies/status', 'evaluationjobs/status'], verbs: mutate },
    ],
  };
}
function aiDomainScopedRoleBindingManifest(pkg, saName) {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
    metadata: { name: `opensphere-module-${pkg.metadata.name}-ai-domain-operator-v1`, namespace: AI_DOMAIN_NAMESPACE, labels: { 'opensphere.io/dupa-plugin': pkg.metadata.name, 'opensphere.io/managed-by': 'dupa' } },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'opensphere-module-ai-domain-operator-v1' },
    subjects: [{ kind: 'ServiceAccount', name: saName, namespace: NS }],
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
    : profile === 'cluster-his-manager-v1' ? hisManagerClusterRoleManifest()
      : profile === 'ai-domain-operator-v1' ? aiDomainOperatorClusterRoleManifest() : observerClusterRoleManifest();
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
  if (profile === 'ai-domain-operator-v1') {
    const role = aiDomainScopedRoleManifest();
    const rolePath = `/apis/rbac.authorization.k8s.io/v1/namespaces/${AI_DOMAIN_NAMESPACE}/roles/${role.metadata.name}`;
    const existingScopedRole = await k8s('GET', rolePath);
    if (!existingScopedRole.ok) throw Object.assign(new Error('pre-provisioned AI scoped permission profile is missing'), { reason: 'PermissionProfileMissing' });
    if (JSON.stringify(canonical(existingScopedRole.json?.rules || [])) !== JSON.stringify(canonical(role.rules))) {
      throw Object.assign(new Error('pre-provisioned AI scoped permission profile drifted'), { reason: 'PermissionProfileDrift' });
    }
    const scopedBinding = aiDomainScopedRoleBindingManifest(pkg, saName);
    const scopedBindingPath = `/apis/rbac.authorization.k8s.io/v1/namespaces/${AI_DOMAIN_NAMESPACE}/rolebindings`;
    const existingScopedBinding = await k8s('GET', `${scopedBindingPath}/${scopedBinding.metadata.name}`);
    const scopedBindingResult = existingScopedBinding.ok ? await k8s('PATCH', `${scopedBindingPath}/${scopedBinding.metadata.name}`, scopedBinding) : await k8s('POST', scopedBindingPath, scopedBinding);
    if (!scopedBindingResult.ok) throw Object.assign(new Error(`AI scoped permission binding apply failed (HTTP ${scopedBindingResult.status})`), { reason: 'PermissionProfileApplyFailed' });
  }
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
    ['/apis/monitoring.coreos.com/v1/namespaces/' + NS + '/servicemonitors', serviceMonitorManifest(pkg), 'ServiceMonitor'],
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
  await deleteManagedResource(`/apis/monitoring.coreos.com/v1/namespaces/${NS}/servicemonitors/${name}`, `ServiceMonitor/${name}`);
  const sa = pluginServiceAccount(pkg);
  const profile = pkg.spec?.permissionProfile || 'none';
  if (profile !== 'none') {
    const suffix = profile === 'cluster-observer-v1' ? 'observer-v1' : profile;
    await deleteManagedResource(`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/opensphere-module-${pkg.metadata.name}-${suffix}`, `ClusterRoleBinding/${name}`);
    if (profile === 'ai-domain-operator-v1') {
      await deleteManagedResource(`/apis/rbac.authorization.k8s.io/v1/namespaces/${AI_DOMAIN_NAMESPACE}/rolebindings/opensphere-module-${pkg.metadata.name}-ai-domain-operator-v1`, `RoleBinding/${name}`);
    }
  }
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
  if (!db.isEnabled()) throw Object.assign(new Error('Backbone revocation ledger is unavailable'), { code: 503, reason: 'RevocationLedgerUnavailable' });
  const revocation = await db.isImageRevoked(repository, digest);
  if (revocation) throw Object.assign(new Error(`image digest was revoked: ${revocation.reason}`), { code: 409, reason: 'ImageRevoked', revocation });
}
async function installedChannelStatus(pkg) {
  const installedDigest = String(pkg?.spec?.image?.digest || '');
  const channel = String(pkg?.spec?.resolution?.requestedChannel || '');
  const repository = String(pkg?.spec?.image?.repository || '');
  const checkedAt = new Date().toISOString();
  if (!db.isEnabled()) return { channelState: 'ChannelUnavailable', currentChannelDigest: '', channelCheckedAt: checkedAt, channelReason: 'RevocationLedgerUnavailable' };
  try {
    const installedRevocation = await db.isImageRevoked(repository, installedDigest);
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
    const channelRevocation = await db.isImageRevoked(repository, current.digest);
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

// ── Backbone(콘솔 데이터 티어) 설치/상태 — opensphere-backbone ns. docs/BACKBONE-ARCHITECTURE.md ──
// 멱등 설치(POST 409=ok → 시크릿/리소스 보존). 상태=컴포넌트 readiness. 권한=ClusterRole dupa-backbone-installer.
// 워크로드는 검증된 선례 미러(PostgreSQL=keycloak-db, RustFS=foundation rustfs-dev). admin 게이트 뒤에서만 호출.
const BACKBONE_NS = process.env.BACKBONE_NS || 'opensphere-backbone';
const BB_LABELS = { 'opensphere.io/part-of': 'opensphere-backbone' };
// Gitea Git 코드 뷰 — in-cluster HTTP. 공개 레포는 익명 read 가능(토큰 불요). 쓰기/비공개는 토큰 필요(다음 차수).
const GITEA_URL = process.env.GITEA_URL || `http://backbone-gitea.${BACKBONE_NS}.svc.cluster.local:3000`;
const BB_COMPONENTS = [
  { key: 'postgres', name: 'PostgreSQL', role: '앱 DB(감사로그·설정) + Gitea DB', kind: 'Deployment', workload: 'backbone-postgres' },
  { key: 'rustfs', name: 'RustFS', role: 'S3 오브젝트 스토리지', kind: 'StatefulSet', workload: 'backbone-rustfs' },
  { key: 'gitea', name: 'Gitea', role: '설정 GitOps(config-as-code)', kind: 'Deployment', workload: 'backbone-gitea' },
];
// 컴포넌트별 접근(접근 탭) 메타 — 자격 Secret명·프로토콜·연결 힌트. Secret '값'은 절대 노출 안 함(키 이름만 마스킹 반환).
const BB_ACCESS = {
  postgres: { secret: 'backbone-postgres', proto: 'TCP(libpq) · 5432', connect: 'psql -h backbone-postgres.opensphere-backbone.svc.cluster.local -U console -d console', note: 'console DB(감사로그·설정) + gitea DB. 비번 = Secret backbone-postgres/password.' },
  rustfs: { secret: 'backbone-rustfs', proto: 'HTTPS(S3) · 9000 / 콘솔 9001', connect: 'S3 endpoint: https://backbone-rustfs.opensphere-backbone.svc.cluster.local:9000 (CA 검증, forcePathStyle=true, region=us-east-1)', note: 'access_key/secret_key 및 ca.crt = Secret backbone-rustfs.' },
  gitea: { secret: 'backbone-gitea', proto: 'HTTP · 3000', connect: 'http://backbone-gitea.opensphere-backbone.svc.cluster.local:3000/', note: '전용 DB role과 관리자 자격은 Secret backbone-gitea에 있으며 값은 API에 노출하지 않는다.' },
};
// Backbone resources are installed only from the governed Setup release manifest.
// Keeping a second in-controller manifest caused deployment drift and, critically,
// could recreate the historic console-as-PostgreSQL-superuser topology.
async function backboneStatus() {
  const nsr = await k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}`);
  const components = [];
  for (const c of BB_COMPONENTS) {
    const plural = c.kind === 'StatefulSet' ? 'statefulsets' : 'deployments';
    const r = await k8s('GET', `/apis/apps/v1/namespaces/${BACKBONE_NS}/${plural}/${c.workload}`);
    let installed = false, ready = false, detail = '미설치';
    if (r.ok && r.json) {
      installed = true;
      const want = (r.json.spec && r.json.spec.replicas) || 1;
      const have = c.kind === 'StatefulSet' ? ((r.json.status && r.json.status.readyReplicas) || 0) : ((r.json.status && r.json.status.availableReplicas) || 0);
      ready = have >= want && want > 0; detail = `${have}/${want} ready`;
    }
    components.push({ key: c.key, name: c.name, role: c.role, kind: c.kind, installed, ready, detail });
  }
  return { namespace: BACKBONE_NS, nsExists: nsr.ok, installed: components.every((c) => c.installed), ready: components.every((c) => c.ready), components };
}
async function backboneInstall() {
  throw Object.assign(new Error('Backbone is a required bootstrap layer; use install-backbone before Console'), { code: 409 });
}
// 단일 구성요소 드릴다운 — workload/service/pvc/pods/events/log tail. admin 게이트 뒤(읽기 전용).
async function backboneDetail(key) {
  const c = BB_COMPONENTS.find((x) => x.key === key);
  if (!c) return null;
  const plural = c.kind === 'StatefulSet' ? 'statefulsets' : 'deployments';
  const sel = encodeURIComponent(`app=${c.workload}`);
  const [wl, svc, pvcAll, podAll, evAll] = await Promise.all([
    k8s('GET', `/apis/apps/v1/namespaces/${BACKBONE_NS}/${plural}/${c.workload}`),
    k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/services/${c.workload}`),
    k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/persistentvolumeclaims`),
    k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/pods?labelSelector=${sel}`),
    k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/events?limit=200`),
  ]);
  const w = wl.ok ? wl.json : null;
  const container = w?.spec?.template?.spec?.containers?.[0] || null;
  const want = (w?.spec?.replicas) || 0;
  const have = c.kind === 'StatefulSet' ? (w?.status?.readyReplicas || 0) : (w?.status?.availableReplicas || 0);
  const workload = w ? {
    name: w.metadata.name, kind: c.kind, image: container?.image || '', replicas: want, ready: have,
    strategy: w.spec?.strategy?.type || w.spec?.updateStrategy?.type || '',
    conditions: (w.status?.conditions || []).map((x) => ({ type: x.type, status: x.status, reason: x.reason || '', message: (x.message || '').slice(0, 200) })),
  } : null;
  const s = svc.ok ? svc.json : null;
  const service = s ? {
    name: s.metadata.name, type: s.spec?.type || 'ClusterIP', clusterIP: s.spec?.clusterIP || '',
    ports: (s.spec?.ports || []).map((x) => ({ name: x.name || '', port: x.port, targetPort: x.targetPort })),
    dns: `${s.metadata.name}.${BACKBONE_NS}.svc.cluster.local`,
  } : null;
  const pvcs = (pvcAll.json?.items || []).filter((x) => (x.metadata.name || '').includes(c.workload)).map((x) => ({
    name: x.metadata.name, status: x.status?.phase || '', capacity: x.status?.capacity?.storage || x.spec?.resources?.requests?.storage || '',
    storageClass: x.spec?.storageClassName || '', volumeName: x.spec?.volumeName || '',
  }));
  const pods = (podAll.json?.items || []).map((x) => {
    const cs = x.status?.containerStatuses || [];
    return {
      name: x.metadata.name, phase: x.status?.phase || '', node: x.spec?.nodeName || '', startTime: x.status?.startTime || '',
      ready: cs.length > 0 && cs.every((y) => y.ready), restarts: cs.reduce((n, y) => n + (y.restartCount || 0), 0),
      containers: cs.map((y) => ({ name: y.name, image: y.image, ready: y.ready, restarts: y.restartCount || 0, state: Object.keys(y.state || {})[0] || '' })),
    };
  });
  const events = (evAll.json?.items || [])
    .filter((x) => (x.involvedObject?.name || '').startsWith(c.workload))
    .map((x) => ({ type: x.type || '', reason: x.reason || '', message: (x.message || '').slice(0, 240), count: x.count || 1, time: x.lastTimestamp || x.eventTime || x.firstTimestamp || '', object: `${x.involvedObject?.kind}/${x.involvedObject?.name}` }))
    .sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 25);
  let log = null;
  const podName = pods[0]?.name;
  const cont = pods[0]?.containers?.[0]?.name || container?.name;
  if (podName && cont) {
    try {
      const lr = await k8sText(`/api/v1/namespaces/${BACKBONE_NS}/pods/${podName}/log?container=${encodeURIComponent(cont)}&tailLines=80`);
      if (lr.ok) log = { pod: podName, container: cont, tail: lr.text.slice(-8000) };
    } catch { /* 로그 조회 실패는 무시(상세 패널은 나머지로 충분) */ }
  }
  // 일반정보 메타(labels/annotations/created) + 접근(접근 탭): Secret 키 이름만 마스킹(값 미노출).
  const meta = w ? {
    created: w.metadata?.creationTimestamp || '',
    labels: w.metadata?.labels || {},
    annotations: Object.keys(w.metadata?.annotations || {}),
  } : null;
  const acc = BB_ACCESS[c.key] || {};
  let secretKeys = [], secretReadable = false;
  if (acc.secret) {
    const sr = await k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/secrets/${acc.secret}`);
    if (sr.ok && sr.json?.data) { secretKeys = Object.keys(sr.json.data); secretReadable = true; }
  }
  const access = { secret: acc.secret || '', secretKeys, secretReadable, proto: acc.proto || '', connect: acc.connect || '', note: acc.note || '' };
  return { component: { key: c.key, name: c.name, role: c.role, kind: c.kind }, namespace: BACKBONE_NS, meta, workload, service, pvcs, pods, events, log, access };
}
// 네임스페이스 전체 이벤트(설치 진행 로그 피드용) — backboneDetail보다 가벼움(pod/PVC/시크릿 조회 없음).
async function backboneEvents() {
  const r = await k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/events?limit=50`);
  const items = (r.json && r.json.items) || [];
  return {
    items: items
      .map((x) => ({
        uid: x.metadata && x.metadata.uid, type: x.type || '', reason: x.reason || '',
        message: (x.message || '').slice(0, 240),
        object: x.involvedObject ? `${x.involvedObject.kind}/${x.involvedObject.name}` : '',
        time: x.lastTimestamp || x.eventTime || x.firstTimestamp || '',
      }))
      .sort((a, b) => String(a.time).localeCompare(String(b.time))),
  };
}
// K8s 설정(데이터 탭의 'K8s YAML') — raw 워크로드/서비스/PVC 객체(managedFields 제거). 프런트가 js-yaml로 렌더. 읽기 전용.
async function backboneYaml(key) {
  const c = BB_COMPONENTS.find((x) => x.key === key);
  if (!c) return null;
  const plural = c.kind === 'StatefulSet' ? 'statefulsets' : 'deployments';
  const [wl, svc, pvcAll] = await Promise.all([
    k8s('GET', `/apis/apps/v1/namespaces/${BACKBONE_NS}/${plural}/${c.workload}`),
    k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/services/${c.workload}`),
    k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/persistentvolumeclaims`),
  ]);
  const strip = (o) => { if (o && o.metadata) delete o.metadata.managedFields; return o; };
  const pvcs = (pvcAll.json?.items || []).filter((x) => (x.metadata.name || '').includes(c.workload)).map(strip);
  return { workload: wl.ok ? strip(wl.json) : null, service: svc.ok ? strip(svc.json) : null, pvcs };
}

// ── Gitea Git 코드 뷰(읽기) — 익명 public 레포 조회. 토큰 미사용(쓰기/private는 다음 차수). ──
async function giteaApi(path) {
  const r = await fetch(GITEA_URL + path, { headers: { accept: 'application/json' } });
  const text = await r.text();
  return { ok: r.ok, status: r.status, json: text ? JSON.parse(text) : null };
}
async function giteaRepos() {
  try {
    const r = await giteaApi('/api/v1/repos/search?limit=50');
    if (!r.ok) return { reachable: false, repos: [], hint: `Gitea HTTP ${r.status}` };
    const repos = (r.json?.data || []).map((x) => ({
      owner: x.owner?.login || x.owner?.username || '', name: x.name, fullName: x.full_name,
      branch: x.default_branch || 'main', private: !!x.private, empty: !!x.empty, updated: x.updated_at || '',
    }));
    return { reachable: true, repos };
  } catch (e) { return { reachable: false, repos: [], hint: String(e).slice(0, 120) }; }
}
// 레포 파일 트리(재귀) — 브랜치→commit sha→git/trees recursive. flat path 목록(프런트가 중첩 구성).
async function giteaTree(owner, repo, ref) {
  try {
    const o = encodeURIComponent(owner), r = encodeURIComponent(repo);
    let branch = ref;
    if (!branch) { const meta = await giteaApi(`/api/v1/repos/${o}/${r}`); branch = meta.json?.default_branch || 'main'; }
    const br = await giteaApi(`/api/v1/repos/${o}/${r}/branches/${encodeURIComponent(branch)}`);
    const sha = br.json?.commit?.id;
    if (!sha) return { tree: [], hint: '브랜치/커밋 없음(빈 레포)' };
    const tr = await giteaApi(`/api/v1/repos/${o}/${r}/git/trees/${sha}?recursive=true&per_page=1000`);
    if (!tr.ok) return { tree: [], hint: `tree HTTP ${tr.status}` };
    const tree = (tr.json?.tree || []).map((x) => ({ path: x.path, type: x.type === 'tree' ? 'dir' : 'file', size: x.size || 0 }));
    return { tree, branch };
  } catch (e) { return { tree: [], hint: String(e).slice(0, 120) }; }
}
async function giteaFile(owner, repo, ref, path) {
  try {
    const o = encodeURIComponent(owner), r = encodeURIComponent(repo);
    const ep = path.split('/').map(encodeURIComponent).join('/');
    const refQ = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const f = await giteaApi(`/api/v1/repos/${o}/${r}/contents/${ep}${refQ}`);
    if (!f.ok) return { content: '', hint: `file HTTP ${f.status}` };
    const c = f.json || {};
    let content = '';
    if (c.encoding === 'base64' && c.content) content = Buffer.from(c.content, 'base64').toString('utf8');
    return { name: c.name || '', path: c.path || path, size: c.size || 0, content: content.slice(0, 200000) };
  } catch (e) { return { content: '', hint: String(e).slice(0, 120) }; }
}

// ── BackboneClaim 할당 컨트롤러(reconciler) — 소비자의 선언적 자원 요청을 프로비저닝. docs/BACKBONE-ARCHITECTURE.md §1. ──
// claim watch → PG db/role + objectStore(S3) 버킷 생성 + claim NS에 Secret 발급 + status 바인딩 + finalizer GC.
const CLAIM_GROUP = 'backbone.opensphere.io';
const CLAIM_V = 'v1alpha1';
const CLAIM_FINALIZER = 'backbone.opensphere.io/finalizer';
const PG_DNS = `backbone-postgres.${BACKBONE_NS}.svc.cluster.local`;
const S3_DNS = `backbone-rustfs.${BACKBONE_NS}.svc.cluster.local`;
const S3_ENDPOINT = process.env.BACKBONE_S3_ENDPOINT || `https://${S3_DNS}:9000`;
const S3_REGION = process.env.BACKBONE_S3_REGION || 'us-east-1';
const BACKBONE_S3_CA_PATH = process.env.BACKBONE_S3_CA_PATH || KANIDM_CA_PATH;
function backboneS3Ca() {
  try { return fs.readFileSync(BACKBONE_S3_CA_PATH, 'utf8'); }
  catch (error) { throw new Error(`RustFS CA read failed: ${error.message}`); }
}
// 컨트롤러 상태(콘솔 '컨트롤러' 탭 노출용) — 인메모리.
const claimController = { crdReady: false, lastRun: '', lastError: '', runs: 0, total: 0, bound: 0 };

// RustFS(S3) 접근 초기화 — backbone-rustfs Secret(access_key/secret_key)에서 인스턴스 키 로드.
// 실패(미설치·키 없음)해도 throw 안 함 → objectStore 할당만 비활성(Pending), PG/감사로그는 무관(§3.5).
async function initBackboneStorage(quiet = false) {
  try {
    const r = await k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/secrets/backbone-rustfs`);
    if (!r.ok) { if (!quiet) console.warn(`[s3] secret ${BACKBONE_NS}/backbone-rustfs 없음(HTTP ${r.status}) → objectStore 할당 비활성`); return; }
    const dec = (k) => Buffer.from(r.json?.data?.[k] || '', 'base64').toString('utf8');
    const ak = dec('access_key'), sk = dec('secret_key');
    if (!ak || !sk) { if (!quiet) console.warn('[s3] backbone-rustfs Secret에 access_key/secret_key 없음 → 비활성'); return; }
    storage.init({ endpoint: S3_ENDPOINT, region: S3_REGION, accessKey: ak, secretKey: sk, caPath: BACKBONE_S3_CA_PATH });
    if (!await storage.healthCheck()) throw new Error('RustFS S3 health check failed');
    console.log(`[s3] connected ${S3_ENDPOINT} (objectStore 할당 활성)`);
  } catch (e) {
    if (!quiet) console.warn('[s3] init 실패 → objectStore 할당 비활성:', String(e).slice(0, 160));
  }
}

// 재연결 게이트 — db/storage가 disabled면 reconcile 루프마다 재시도(startup 1회 실패·의존성 늦은 준비·순간 끊김 자동 복구).
// 연결되면 isEnabled 가드로 더 시도 안 함. 로그 스팸 방지: 첫 시도 + 매 20회(≈5분)만 경고 출력.
let _bbReconnectTry = 0;
async function ensureBackboneConnections() {
  if (db.isEnabled() && storage.isEnabled()) return;
  const quiet = _bbReconnectTry++ % 20 !== 0;
  if (!db.isEnabled()) await initBackboneDb(quiet);
  if (!storage.isEnabled()) await initBackboneStorage(quiet);
}

async function giteaHealth() {
  try {
    const r = await fetch(`${GITEA_URL}/api/healthz`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}
// OAA-Gateway is Main Shell native (CONSTITUTION-0004 §4.2), not a CBS pillar and not owned or
// reconciled by this controller — the controller only probes its unauthenticated, in-cluster-only
// /readyz the same way it probes Gitea's /api/healthz. Main Shell Baseline Ready requires this to
// be true alongside the CBS three pillars (§4.5); this function never creates, patches, or deletes
// the OAA-Gateway workload.
const OAA_GATEWAY_URL = process.env.OAA_GATEWAY_URL || `http://opensphere-console-oaa-gateway.${BACKBONE_NS}.svc.cluster.local:8080`;
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
async function backboneReadiness() {
  await ensureBackboneConnections();
  const [postgres, rustfs, gitea, workloads, oaa] = await Promise.all([
    db.healthCheck(),
    storage.isEnabled() ? storage.healthCheck() : Promise.resolve(false),
    giteaHealth(),
    backboneStatus(),
    oaaGatewayReadiness(),
  ]);
  const ready = postgres && rustfs && gitea && workloads.ready && oaa.ready;
  return { ready, required: true, postgres, rustfs, gitea, workloads, oaa };
}

async function upsertSecret(ns, name, stringData) {
  const body = { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: ns, labels: BB_LABELS }, type: 'Opaque', stringData };
  const r = await k8s('POST', `/api/v1/namespaces/${ns}/secrets`, body);
  if (r.status === 409) await k8s('PATCH', `/api/v1/namespaces/${ns}/secrets/${name}`, { stringData });
  else if (!r.ok) throw new Error(`secret upsert HTTP ${r.status}`);
}
function postgresAppRoleName(dbName, cr, existingSecret) {
  const fromSecret = existingSecret?.ok ? Buffer.from(existingSecret.json?.data?.username || '', 'base64').toString('utf8') : '';
  return cr.spec?.postgres?.appRole?.username || fromSecret || `${dbName}_app`;
}
async function gcClaim(cr) {
  const ns = cr.metadata.namespace, name = cr.metadata.name;
  if (cr.spec?.postgres?.enabled && db.isEnabled()) {
    const dbName = cr.spec.postgres.database || name.replace(/-/g, '_');
    const appSecretName = `${name}-backbone-postgres-app`;
    const appSec = await k8s('GET', `/api/v1/namespaces/${ns}/secrets/${appSecretName}`);
    const appRole = appSec.ok ? Buffer.from(appSec.json?.data?.username || '', 'base64').toString('utf8') : `${dbName}_app`;
    await db.dropTenant(dbName, appRole);
  }
  await k8s('DELETE', `/api/v1/namespaces/${ns}/secrets/${name}-backbone-postgres`);
  await k8s('DELETE', `/api/v1/namespaces/${ns}/secrets/${name}-backbone-postgres-app`);
  // objectStore — 버킷 비우고 삭제(PG dropTenant 대칭) + 테넌트 자격 Secret 회수.
  if (cr.spec?.objectStore?.enabled && storage.isEnabled()) {
    await storage.emptyAndDeleteBucket(cr.spec.objectStore.bucket || name);
  }
  await k8s('DELETE', `/api/v1/namespaces/${ns}/secrets/${name}-backbone-rustfs`);
}
async function reconcileOneClaim(cr) {
  const ns = cr.metadata.namespace, name = cr.metadata.name;
  const base = `/apis/${CLAIM_GROUP}/${CLAIM_V}/namespaces/${ns}/backboneclaims/${name}`;
  const fins = cr.metadata.finalizers || [];
  // 삭제 중 → GC 후 finalizer 제거
  if (cr.metadata.deletionTimestamp) {
    try { await gcClaim(cr); } catch (e) { console.error('[claim] gc', name, String(e).slice(0, 100)); }
    await k8s('PATCH', base, { metadata: { finalizers: fins.filter((f) => f !== CLAIM_FINALIZER) } });
    return false;
  }
  // finalizer 보장
  if (!fins.includes(CLAIM_FINALIZER)) {
    await k8s('PATCH', base, { metadata: { finalizers: [...fins, CLAIM_FINALIZER] } });
  }
  const status = { phase: 'Bound', observedGeneration: cr.metadata.generation || 0, message: '', postgres: null, objectStore: null };
  // PostgreSQL — sealed NOLOGIN owner + 기능 가능한 app role 하나만 claim NS에 발급한다.
  // 소비자에게 database owner credential을 배포하는 fallback은 금지한다.
  if (cr.spec?.postgres?.enabled) {
    const dbName = cr.spec.postgres.database || name.replace(/-/g, '_');
    const legacySecretName = `${name}-backbone-postgres`;
    const appSecretName = `${name}-backbone-postgres-app`;
    if (cr.spec?.postgres?.appRole?.enabled === false) {
      status.phase = 'Error';
      status.message = 'BackboneClaim은 owner credential을 발급하지 않으며 appRole을 비활성화할 수 없습니다';
    } else if (!db.isEnabled()) { status.phase = 'Pending'; status.message = 'PostgreSQL 미연결'; }
    else {
      await db.provisionTenant(dbName);
      // Remove the legacy owner Secret only after the sealed owner exists. The app
      // secret remains stable across reconcile, so a consumer need not restart.
      await k8s('DELETE', `/api/v1/namespaces/${ns}/secrets/${legacySecretName}`);
      const appSec = await k8s('GET', `/api/v1/namespaces/${ns}/secrets/${appSecretName}`);
      let appPw = appSec.ok ? Buffer.from(appSec.json?.data?.password || '', 'base64').toString('utf8') : '';
      if (!appPw) appPw = randomBytes(24).toString('hex');
      const appUser = postgresAppRoleName(dbName, cr, appSec);
      await db.provisionTenantAppRole(dbName, appUser, appPw);
      await upsertSecret(ns, appSecretName, { host: PG_DNS, port: '5432', database: dbName, username: appUser, password: appPw, role: 'app', schema: 'public' });
      status.postgres = { secretRef: appSecretName, appSecretRef: appSecretName, appUsername: appUser, host: PG_DNS, database: dbName, ownerCredential: 'sealed-nologin' };
    }
  }
  // objectStore — 전용 버킷 + Secret(claim NS). dev는 인스턴스 키 재사용 + 버킷 격리(provision-backbone-tenant.sh 모델).
  if (cr.spec?.objectStore?.enabled) {
    const bucket = cr.spec.objectStore.bucket || name;
    const s3secret = `${name}-backbone-rustfs`;
    if (!storage.isEnabled()) {
      status.objectStore = { bucket, state: 'Pending', message: 'RustFS 미연결 — backbone-rustfs Secret/Service 확인' };
      if (status.phase === 'Bound') status.phase = 'PartiallyBound';
    } else {
      try {
        await storage.ensureBucket(bucket);
        await upsertSecret(ns, s3secret, { endpoint: S3_ENDPOINT, region: S3_REGION, bucket, access_key: storage.accessKey(), secret_key: storage.secretKey(), 'ca.crt': backboneS3Ca() });
        // message: '' 명시 — merge-patch는 키를 지우지 않으므로 이전 stub의 message를 덮어써 stale 표기 제거.
        status.objectStore = { secretRef: s3secret, endpoint: S3_ENDPOINT, bucket, state: 'Bound', message: '' };
      } catch (e) {
        status.objectStore = { bucket, state: 'Error', message: String(e).slice(0, 160) };
        if (status.phase === 'Bound') status.phase = 'PartiallyBound';
      }
    }
  }
  await k8s('PATCH', `${base}/status`, { status });
  return status.phase === 'Bound';
}
async function reconcileBackboneClaims() {
  const r = await k8s('GET', `/apis/${CLAIM_GROUP}/${CLAIM_V}/backboneclaims`);
  if (!r.ok) { claimController.crdReady = false; claimController.lastError = `list HTTP ${r.status}(CRD 미설치?)`; return; }
  claimController.crdReady = true;
  const items = r.json?.items || [];
  let bound = 0;
  for (const cr of items) {
    try { if (await reconcileOneClaim(cr)) bound++; }
    catch (e) { console.error('[claim] reconcile', cr.metadata?.name, String(e).slice(0, 120)); claimController.lastError = String(e).slice(0, 120); }
  }
  claimController.total = items.length; claimController.bound = bound;
  claimController.runs++; claimController.lastRun = new Date().toISOString();
  if (claimController.total === claimController.bound) claimController.lastError = '';
}

// ── Observability(공유 관측 스택) 정보 뷰 — 콘솔은 소유 아닌 '대상/소비자'. read-only. docs/OBSERVABILITY-ARCHITECTURE.md ──
const MON_NS = process.env.MONITORING_NS || 'monitoring';
const SM_GROUP = 'monitoring.coreos.com';
// kps 컴포넌트 — app.kubernetes.io/name 라벨로 식별(릴리스명 무관).
const MON_COMPONENTS = [
  { key: 'prometheus', name: 'Prometheus', role: '메트릭 수집/저장', label: 'prometheus' },
  { key: 'grafana', name: 'Grafana', role: '대시보드/뷰', label: 'grafana' },
  { key: 'alertmanager', name: 'Alertmanager', role: '알림 라우팅', label: 'alertmanager' },
  { key: 'kube-state-metrics', name: 'kube-state-metrics', role: 'K8s 오브젝트 메트릭', label: 'kube-state-metrics' },
  { key: 'node-exporter', name: 'Node Exporter', role: '노드 메트릭', label: 'prometheus-node-exporter' },
];
// 콘솔/Backbone 계측 대상 — coverage 매트릭스(노출/계측층은 각 컴포넌트 소유).
function obsTargets() {
  return [
    { key: 'opensphere-console-backend', name: 'opensphere-console-backend', app: 'opensphere-console-backend', ns: NS },
    { key: 'dupa', name: 'opensphere-console-dupa-controller', app: 'opensphere-console-dupa-controller', ns: NS },
    { key: 'backbone-postgres', name: 'Backbone PostgreSQL', app: 'backbone-postgres', ns: BACKBONE_NS },
    { key: 'backbone-rustfs', name: 'Backbone RustFS', app: 'backbone-rustfs', ns: BACKBONE_NS, gap: 'rustfs beta — Prometheus endpoint 미제공(upstream 대기)' },
    { key: 'backbone-gitea', name: 'Backbone Gitea', app: 'backbone-gitea', ns: BACKBONE_NS },
    { key: 'opensphere-console-oaa-gateway', name: 'OAA-Gateway', app: 'opensphere-console-oaa-gateway', ns: BACKBONE_NS },
  ];
}
// monitoring ns에서 이름 정규식 + 포트로 Service 탐색 → DNS:port. kps prometheus svc는 app.kubernetes.io/name 라벨이
// 없어(app=kube-prometheus-stack-prometheus) 라벨 셀렉터로는 못 찾음 → 이름+포트 매칭이 견고. headless(clusterIP None) 후순위.
async function findMonSvc(nameRe, port) {
  const r = await k8s('GET', `/api/v1/namespaces/${MON_NS}/services`);
  const cands = (r.json?.items || []).filter((s) => nameRe.test(s.metadata?.name || '') && (s.spec?.ports || []).some((p) => p.port === port));
  cands.sort((a, b) => (a.spec?.clusterIP === 'None' ? 1 : 0) - (b.spec?.clusterIP === 'None' ? 1 : 0));
  const svc = cands[0];
  return svc ? `${svc.metadata.name}.${MON_NS}.svc.cluster.local:${port}` : '';
}
async function observabilityStatus() {
  const nsr = await k8s('GET', `/api/v1/namespaces/${MON_NS}`);
  const nsExists = nsr.ok;
  const pods = nsExists ? await k8s('GET', `/api/v1/namespaces/${MON_NS}/pods`) : { json: { items: [] } };
  const items = pods.json?.items || [];
  const components = MON_COMPONENTS.map((c) => {
    const mine = items.filter((p) => (p.metadata?.labels?.['app.kubernetes.io/name'] || '') === c.label);
    const ready = mine.filter((p) => { const cs = p.status?.containerStatuses || []; return cs.length > 0 && cs.every((x) => x.ready); }).length;
    return { key: c.key, name: c.name, role: c.role, installed: mine.length > 0, ready: mine.length > 0 && ready === mine.length, detail: mine.length ? `${ready}/${mine.length} ready` : '미설치' };
  });
  const smr = await k8s('GET', `/apis/${SM_GROUP}/v1/servicemonitors`);
  const crdReady = smr.ok;
  const sms = (smr.json?.items || []).map((x) => ({ namespace: x.metadata?.namespace || '', name: x.metadata?.name || '', app: x.spec?.selector?.matchLabels?.app || '' }));
  const coverage = obsTargets().map((t) => {
    const sm = sms.some((s) => s.namespace === t.ns && (s.app === t.app || s.name === t.app));
    return { key: t.key, name: t.name, namespace: t.ns, serviceMonitor: sm, metrics: sm, note: sm ? 'scrape 대상' : (t.gap || '계측 없음(노출/ServiceMonitor 부재)') };
  });
  const [grafana, prometheus] = await Promise.all([findMonSvc(/grafana/i, 80), findMonSvc(/prometheus/i, 9090)]);
  return { namespace: MON_NS, nsExists, installed: components.some((c) => c.installed), ready: components.every((c) => c.ready), components, crdReady, serviceMonitors: sms, coverage, links: { grafana, prometheus } };
}
// Prometheus active targets 프록시(up/down) — best-effort. in-cluster svc 직결.
async function observabilityTargets() {
  const prom = await findMonSvc(/prometheus/i, 9090);
  if (!prom) return { reachable: false, hint: 'prometheus svc 미발견' };
  try {
    const r = await fetch(`http://${prom}/api/v1/targets?state=active`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { reachable: false, hint: `HTTP ${r.status}` };
    const j = await r.json();
    const active = (j.data?.activeTargets || []).map((t) => ({ job: t.labels?.job || '', instance: t.labels?.instance || t.discoveredLabels?.__address__ || '', health: t.health || '', lastError: (t.lastError || '').slice(0, 140), scrapeUrl: t.scrapeUrl || '' }));
    return { reachable: true, active };
  } catch (e) { return { reachable: false, hint: String((e && e.message) || e).slice(0, 120) }; }
}
// Prometheus 쿼리 프록시(instant/range) — 콘솔이 직접 값/그래프 렌더(외부 Grafana 비의존). admin 게이트 뒤·읽기 전용.
// PromQL은 임의(admin은 Prometheus 직접 조회 가능한 신뢰 주체) — 쓰기 불가, 길이 bound + 타임아웃으로 보호.
async function promQuery(expr, range) {
  const prom = await findMonSvc(/prometheus/i, 9090);
  if (!prom) return { ok: false, hint: 'prometheus svc 미발견' };
  try {
    let url;
    if (range) {
      const end = Math.floor(Date.now() / 1000);
      const start = end - Math.max(1, Math.min(range.minutes || 60, 1440)) * 60;
      const step = Math.max(15, Math.min(range.step || 60, 3600));
      url = `http://${prom}/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${start}&end=${end}&step=${step}`;
    } else {
      url = `http://${prom}/api/v1/query?query=${encodeURIComponent(expr)}`;
    }
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { ok: false, hint: `HTTP ${r.status}` };
    const j = await r.json();
    return { ok: true, resultType: j.data?.resultType || '', result: j.data?.result || [] };
  } catch (e) { return { ok: false, hint: String((e && e.message) || e).slice(0, 120) }; }
}

// ── Platform Readiness (CONSTITUTION-0004 §7~§8) ───────────────────────────
// PlatformSupportProfile is a Main Shell-owned, machine-readable admission gate. It is not a
// fourth service stack and it does not install HIS. HIS mutation remains owned by Cluster Manager;
// this controller only reads its authenticated status and points the administrator to that surface.
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
    [NS, 'opensphere-console-auth'],
    [NS, 'opensphere-console-backend'],
    [NS, 'opensphere-console-dupa-controller'],
    [BACKBONE_NS, 'opensphere-console-oaa-gateway'],
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
async function clusterManagerAdminGet(req, path) {
  try {
    const r = await fetch(`http://cluster-manager.${NS}.svc.cluster.local:8080${path}`, {
      headers: { authorization: req.headers.authorization || '', accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: String(e?.message || e).slice(0, 120) };
  }
}
function normalizeHisStatus(result) {
  const body = result.body || {};
  const state = body.state || body.phase || body.status?.phase || 'Unavailable';
  const ready = result.ok && (state === 'Ready' || body.ready === true || body.status?.ready === true);
  return {
    ready, reachable: result.ok, state, summary: body.summary || body.message || '',
    items: body.items || body.components || body.status?.items || [],
    reason: result.ok ? (ready ? '' : (body.reason || 'HIS requirements are not Ready'))
      : `Cluster Manager HIS API HTTP ${result.status || 'unreachable'}`,
  };
}
async function backupRestoreEvidence() {
  const [cronjobs, jobs, target] = await Promise.all([
    k8s('GET', `/apis/batch/v1/namespaces/${BACKBONE_NS}/cronjobs`),
    k8s('GET', `/apis/batch/v1/namespaces/${BACKBONE_NS}/jobs`),
    k8s('GET', `/api/v1/namespaces/${BACKBONE_NS}/secrets/backbone-postgres-backup-target`),
  ]);
  const all = jobs.json?.items || [];
  const complete = (prefix) => all.filter((j) => j.metadata?.name?.startsWith(prefix)
    && (j.status?.conditions || []).some((c) => c.type === 'Complete' && c.status === 'True'))
    .sort((a, b) => String(b.status?.completionTime || '').localeCompare(String(a.status?.completionTime || '')))[0];
  const backup = complete('backbone-postgres-backup-');
  const restore = complete('backbone-postgres-restore-drill-');
  const schedules = cronjobs.json?.items || [];
  const scheduled = schedules.some((x) => x.metadata?.name === 'backbone-postgres-backup' && x.spec?.suspend !== true);
  const ready = target.ok && scheduled && !!backup && !!restore;
  return {
    ready, targetConfigured: target.ok, scheduled,
    lastBackupAt: backup?.status?.completionTime || '', lastRestoreDrillAt: restore?.status?.completionTime || '',
    reason: ready ? '' : 'backup target, completed backup, and completed restore drill are all required',
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
  const isolation = [BACKBONE_NS, NS, MON_NS].every((ns) => np.some((x) => x.metadata?.namespace === ns));
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
  const [status, targets, claims] = await Promise.all([
    observabilityStatus(), observabilityTargets(),
    k8s('GET', `/apis/observability.opensphere.io/${V}/observabilityclaims`),
  ]);
  const active = targets.active || [];
  const liveMetrics = targets.reachable === true && active.some((t) => t.health === 'up');
  const claimItems = claims.json?.items || [];
  const connectedClaim = claims.ok && claimItems.some((x) => x.status?.phase === 'Connected' || x.status?.binding?.phase === 'Connected');
  const telemetry = { metrics: liveMetrics, logs: false, traces: false, otlp: false, connectedClaim };
  const ready = status.ready && Object.values(telemetry).every(Boolean);
  return {
    ready, stackReady: status.ready, activeTargets: active.length, telemetry,
    reason: ready ? '' : 'live metrics, structured logs, OTLP traces, and a Connected ObservabilityClaim are required',
  };
}
async function readPlatformProfile() {
  const r = await k8s('GET', PLATFORM_PROFILE_PATH);
  if (r.status === 404) return { declared: false, crdReady: true, resource: null };
  if (!r.ok) return { declared: false, crdReady: false, resource: null, reason: `PlatformSupportProfile HTTP ${r.status}` };
  return { declared: true, crdReady: true, resource: r.json };
}
async function platformReadinessStatus(req) {
  const [cbs, mainShell, clusterManager, hisRaw, profile, delivery, observability, backupRestore, securityPolicy, regs] = await Promise.all([
    backboneReadiness(), mainShellBaselineStatus(), clusterManagerActivationStatus(),
    clusterManagerAdminGet(req, '/api/his/status'), readPlatformProfile(), deliveryEvidence(),
    observabilityProfileEvidence(), backupRestoreEvidence(), securityPolicyEvidence(), listRegs(),
  ]);
  const his = normalizeHisStatus(hisRaw);
  const capabilities = [
    condition('Delivery', delivery.ready, delivery.ready ? 'Verified' : 'DeliveryEvidenceMissing', delivery.reason || 'GitOps delivery evidence verified', [delivery]),
    condition('Observability', observability.ready, observability.ready ? 'Verified' : 'TelemetryEvidenceMissing', observability.reason || 'Live telemetry verified', [observability]),
    condition('BackupRestore', backupRestore.ready, backupRestore.ready ? 'Verified' : 'RestoreEvidenceMissing', backupRestore.reason || 'Backup and restore drill verified', [backupRestore]),
    condition('SecurityPolicy', securityPolicy.ready, securityPolicy.ready ? 'Verified' : 'PolicyEvidenceMissing', securityPolicy.reason || 'Security and policy evidence verified', [securityPolicy]),
  ];
  const prerequisites = [
    { key: 'cbs', label: 'CBS Ready', ready: cbs.ready, detail: cbs.ready ? 'PostgreSQL · RustFS · Gitea ready' : 'Backbone required capabilities unavailable', route: '/manage/backbone' },
    { key: 'main-shell', label: 'Main Shell Baseline Ready', ready: mainShell.ready, detail: mainShell.ready ? 'Console native baseline ready' : 'Console/Auth/Backend/DUPA/OAA workload incomplete', route: '/manage/observability' },
    { key: 'cluster-manager', label: 'Cluster Manager Activated', ready: clusterManager.ready, detail: `${clusterManager.phase} · workload ${clusterManager.workload}`, route: '/manage/extensions' },
    { key: 'his', label: 'HIS Ready', ready: his.ready, detail: his.ready ? 'Host Infrastructure Service Stack ready' : (his.reason || his.state), route: '/p/cluster-manager/his/his' },
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
    { key: 'support-profile', label: 'Platform Support Profile Ready', ready: supportReady, state: profilePhase, detail: profile.declared ? `${capabilities.filter((x) => x.ready).length}/4 capability evidence verified` : 'Profile preflight has not been declared', route: '/manage/platform-readiness' },
    { key: 'pfs', label: 'PFS Established', ready: pfsEstablished, state: pfsEstablished ? 'Ready' : (foundationActivationAllowed ? 'Available' : (foundationReg?.status?.phase === 'Ready' ? 'Staged' : 'Locked')), detail: pfsEstablished ? (supportReady ? 'Foundation activated' : 'Foundation activated by development override; PFS plugins remain locked') : (supportReady ? 'Foundation activation is unlocked' : (foundationActivationOverride ? 'Development override permits Foundation subShell activation only' : (foundationReg?.status?.phase === 'Ready' ? 'Foundation is staged; activation waits for Platform Support Profile Ready' : 'Foundation may be staged, but activation waits for Platform Support Profile Ready'))), route: foundationActivationAllowed ? '/manage/extensions' : '/manage/platform-readiness' },
    { key: 'domain', label: 'Domain subShell Admission', ready: domainAdmissionReady, state: domainAdmissionReady ? 'Available' : 'Locked', detail: domainAdmissionReady ? 'Domain subShell admission available' : (pfsEstablished ? 'Development override does not unlock Domain subShell admission' : 'PFS must be established first'), route: domainAdmissionReady ? '/manage/extensions' : '/manage/platform-readiness' },
  ];
  return {
    apiVersion: `${PLATFORM_GROUP}/${V}`, kind: 'PlatformReadinessStatus', observedAt: new Date().toISOString(),
    phase: profilePhase, ready: supportReady, profile: { declared: profile.declared, crdReady: profile.crdReady, name: PLATFORM_PROFILE_NAME, generation: profile.resource?.metadata?.generation || 0, lastVerifiedAt: profile.resource?.status?.lastVerifiedAt || '', status: profile.resource?.status || null },
    prerequisites, capabilities, lifecycle, evidence: { cbs, mainShell, clusterManager, his },
    admission: {
      foundationStageAllowed: true,
      foundationActivationAllowed,
      foundationActivationOverride,
      mode: foundationActivationOverride ? 'DevelopmentOverride' : (supportReady ? 'PlatformSupportProfile' : 'Blocked'),
      // Compatibility alias for older clients. This gate now means activation,
      // because an immutable, verified workload may be staged before PFS admission.
      foundationInstallAllowed: foundationActivationAllowed,
      pfsPluginInstallAllowed: supportReady,
      domainSubShellAdmissionAllowed: domainAdmissionReady,
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

// ── /metrics (Prometheus exposition, 의존성 0; 클러스터 내부 전용 — nginx 미라우팅) ──
// 공유 관측 계층(k8s basic stack / prometheus-stack)이 ServiceMonitor로 scrape. docs/OBSERVABILITY-ARCHITECTURE.md.
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
      const state = await backboneReadiness();
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

    // Auth BFF 전용 내구 자격 저장소. PAT allowlist, CLI device 공개키와 브라우저
    // session epoch를 Backbone PostgreSQL에 보관하며, 상태 변경과 감사 INSERT는
    // db의 단일 트랜잭션이다.
    // 브라우저/관리자 bearer가 아니라 정확한 opensphere-console-auth SA만 허용한다.
    const credentialState = p.match(/^\/api\/internal\/credential-state\/(pat|device|session)(?:\/([a-f0-9]{32})(?:\/(touch))?)?$/);
    if (credentialState) {
      try { await verifyWorkloadToken(req, 'opensphere-console-auth'); }
      catch (e) { return json(res, typeof e?.code === 'number' ? e.code : 502, { error: e?.msg || 'workload authentication failed', opId }); }
      if (!db.isEnabled()) return json(res, 503, { error: 'Backbone PostgreSQL unavailable', opId });
      const [, kind, id, operation] = credentialState;
      if (req.method === 'GET' && !id) {
        try { return json(res, 200, { items: await db.listManagedCredentials(kind) }); }
        catch (e) { return json(res, 503, { error: 'credential state unavailable', opId }); }
      }
      if (req.method === 'GET' && id && !operation) {
        try {
          const item = await db.getManagedCredential(kind, id);
          return item ? json(res, 200, { item }) : json(res, 404, { error: 'not_found', opId });
        } catch (e) {
          return json(res, 503, { error: 'credential state unavailable', opId });
        }
      }
      if (req.method === 'POST' && id && operation === 'touch') {
        try {
          await db.touchManagedCredential(kind, id);
          res.writeHead(204); return res.end();
        } catch (e) {
          return json(res, 503, { error: 'credential state unavailable', opId });
        }
      }
      if ((req.method === 'PUT' || req.method === 'DELETE') && id && !operation) {
        const body = await readBody(req).catch(() => req.method === 'DELETE' ? {} : null);
        if (req.method === 'PUT' && (!body || typeof body.record !== 'object' || Array.isArray(body.record))) {
          return json(res, 400, { error: 'record object required', opId });
        }
        const record = req.method === 'DELETE' ? null : body.record;
        const owner = String(body?.owner || record?.user || '').trim().slice(0, 128);
        if (req.method === 'PUT' && !owner) return json(res, 400, { error: 'owner required', opId });
        try {
          await db.mutateManagedCredential({
            kind, id, owner: owner || 'unknown', record,
            audit: {
              time: new Date().toISOString(), opId,
              source: 'opensphere-console-auth',
              actor: String(body?.actor || owner || 'opensphere-console-auth').slice(0, 128),
              action: String(body?.action || `${kind}-${req.method === 'DELETE' ? 'revoke' : 'upsert'}`).slice(0, 80),
              result: 'accepted', reason: String(body?.reason || '').slice(0, 240),
            },
          });
          return json(res, req.method === 'PUT' ? 200 : 204, req.method === 'PUT' ? { stored: id } : null);
        } catch (e) {
          console.error(`[credential-state] op=${opId}:`, String(e).slice(0, 160));
          return json(res, 503, { error: 'credential state unavailable', opId });
        }
      }
      return json(res, 405, { error: 'method not allowed', opId });
    }

    // ── 인증 게이트(감사 P0-1/P1-3): /api/admin/* 는 검증된 admin id_token 필수.
    // actor는 '검증된 토큰 claim'에서만 도출 → X-OpenSphere-User 헤더 스푸핑 무력화.
    // 예외: /api/admin/events(subShell 백엔드 server-to-server 발행)는 아래에서 별도 처리.
    let actor = 'system';
    if (p.startsWith('/api/admin/') && p !== '/api/admin/events') {
      let a;
      try { a = await verifyActor(req); }
      catch (e) {
        // {code:401/403} = 우리 검증 거부 / 문자열 code(예: ECONNREFUSED) = auth 백엔드(JWKS) 장애.
        const numeric = e && typeof e.code === 'number';
        if (!numeric) console.error(`[auth] op=${opId} verify backend error:`, e && (e.code || e.message));
        return json(res, numeric ? e.code : 502, { error: numeric ? (e.msg || 'unauthorized') : 'auth backend error', opId });
      }
      actor = a.username;
    }

    // Console 관리 변경은 세 Backbone 기둥(PostgreSQL/RustFS/Gitea)이 모두 준비된 경우에만 허용한다.
    // 읽기 전용 표면은 유지하되, 내구 감사/오브젝트/Git 이력이 빠진 상태에서 성공으로 보이지 않게 한다.
    if (p.startsWith('/api/admin/') && p !== '/api/admin/events' && p !== '/api/admin/extensions/inspect' && req.method !== 'GET') {
      const state = await backboneReadiness();
      if (!state.ready) return json(res, 503, { error: 'Backbone required capabilities unavailable', backbone: state, opId });
      await durableAudit(actor, 'mutation-request', p, 'attempt', req.method, opId);
    }

    // Backbone(콘솔 데이터 티어) 설치/상태 — admin 게이트 뒤. docs/BACKBONE-ARCHITECTURE.md
    if (p === '/api/admin/backbone/status' && req.method === 'GET') return json(res, 200, await backboneStatus());
    if (p === '/api/admin/backbone/detail' && req.method === 'GET') {
      const d = await backboneDetail(url.searchParams.get('component') || '');
      return d ? json(res, 200, d) : json(res, 404, { error: 'unknown component', opId });
    }
    if (p === '/api/admin/backbone/yaml' && req.method === 'GET') {
      const y = await backboneYaml(url.searchParams.get('component') || '');
      return y ? json(res, 200, y) : json(res, 404, { error: 'unknown component', opId });
    }
    if (p === '/api/admin/backbone/events' && req.method === 'GET') return json(res, 200, await backboneEvents());
    if (p === '/api/admin/backbone/pg' && req.method === 'GET') {
      // 데이터 탭 — PostgreSQL DATABASE→TABLE→COLUMN 트리 + 최근 audit_log. 미연결이면 enabled=false.
      if (!db.isEnabled()) return json(res, 200, { enabled: false, databases: [], audit: [] });
      try { return json(res, 200, { enabled: true, databases: await db.listTree(), audit: await db.recentAudit(20) }); }
      catch (e) { console.error(`[err] op=${opId} pg tree:`, e); return json(res, 200, { enabled: false, databases: [], audit: [], error: String(e).slice(0, 120) }); }
    }
    if (p === '/api/admin/backbone/pg/rows' && req.method === 'GET') {
      // 테이블 행 미리보기(읽기) — SELECT * LIMIT n. 식별자 검증/인용으로 인젝션 차단.
      if (!db.isEnabled()) return json(res, 200, { columns: [], rows: [] });
      try {
        const out = await db.previewRows(url.searchParams.get('database'), url.searchParams.get('schema'), url.searchParams.get('table'), url.searchParams.get('limit'));
        return out ? json(res, 200, out) : json(res, 404, { error: 'not found', opId });
      } catch (e) { return json(res, 400, { error: String((e && e.message) || e).slice(0, 120), opId }); }
    }
    if (p === '/api/admin/backbone/pg/function' && req.method === 'POST') {
      // 함수 생성(가이드 폼) — admin 게이트 뒤 첫 DDL 쓰기. 식별자 검증은 db.createFunction. 모든 시도 감사.
      if (!db.isEnabled()) return json(res, 503, { error: 'PostgreSQL 미연결', opId });
      const b = await readBody(req).catch(() => ({}));
      const tgt = `${b.database}.${b.schema || 'public'}.${b.name}`;
      try {
        await db.createFunction(b);
        await durableAudit(actor, 'pg-create-function', tgt, 'accepted', `lang=${b.language || 'plpgsql'}${b.replace ? ' replace' : ''}`, opId);
        return json(res, 201, { created: true, target: tgt });
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 200);
        await durableAudit(actor, 'pg-create-function', tgt, 'error', msg, opId);
        return json(res, 400, { error: msg, opId });
      }
    }
    if (p === '/api/admin/backbone/pg/function/source' && req.method === 'GET') {
      // 편집용 함수 소스 로드(읽기) — identity args로 오버로드 식별.
      if (!db.isEnabled()) return json(res, 503, { error: 'PostgreSQL 미연결', opId });
      try {
        const out = await db.functionSource({ database: url.searchParams.get('database'), schema: url.searchParams.get('schema'), name: url.searchParams.get('name'), args: url.searchParams.get('args') || '' });
        return json(res, 200, out);
      } catch (e) { return json(res, 400, { error: String((e && e.message) || e).slice(0, 200), opId }); }
    }
    if (p === '/api/admin/backbone/pg/function/drop' && req.method === 'POST') {
      // 함수 삭제(DROP) — admin 게이트·감사.
      if (!db.isEnabled()) return json(res, 503, { error: 'PostgreSQL 미연결', opId });
      const b = await readBody(req).catch(() => ({}));
      const tgt = `${b.database}.${b.schema || 'public'}.${b.name}(${b.args || ''})`;
      try {
        await db.dropFunction(b);
        await durableAudit(actor, 'pg-drop-function', tgt, 'accepted', '', opId);
        return json(res, 200, { dropped: true, target: tgt });
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 200);
        await durableAudit(actor, 'pg-drop-function', tgt, 'error', msg, opId);
        return json(res, 400, { error: msg, opId });
      }
    }
    if (p === '/api/admin/backbone/controller' && req.method === 'GET') {
      // 할당 컨트롤러(BackboneClaim reconciler) 상태 — 콘솔 '컨트롤러' 탭.
      return json(res, 200, { ...claimController, dbConnected: db.isEnabled(), intervalSec: 15, finalizer: CLAIM_FINALIZER });
    }
    if (p === '/api/admin/backbone/claims' && req.method === 'GET') {
      const r = await k8s('GET', `/apis/${CLAIM_GROUP}/${CLAIM_V}/backboneclaims`);
      if (!r.ok) return json(res, 200, { crdReady: false, items: [], hint: `HTTP ${r.status}` });
      const items = (r.json?.items || []).map((x) => ({
        namespace: x.metadata.namespace, name: x.metadata.name, created: x.metadata.creationTimestamp,
        deleting: !!x.metadata.deletionTimestamp,
        spec: { postgres: !!x.spec?.postgres?.enabled, objectStore: !!x.spec?.objectStore?.enabled, gitOps: !!x.spec?.gitOps?.enabled },
        phase: x.status?.phase || 'Pending', message: x.status?.message || '',
        postgres: x.status?.postgres || null, objectStore: x.status?.objectStore || null,
      }));
      return json(res, 200, { crdReady: true, items });
    }
    // Platform Readiness — Console native lifecycle gate. HIS 변경은 Cluster Manager 소유이며
    // 이 API는 live evidence를 집계하고 PlatformSupportProfile의 선언/검증 이력만 관리한다.
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

    // Observability(공유 관측 스택) 정보 뷰 — 읽기 전용. 콘솔은 소유 아닌 대상/소비자.
    if (p === '/api/admin/observability/status' && req.method === 'GET') return json(res, 200, await observabilityStatus());
    if (p === '/api/admin/observability/targets' && req.method === 'GET') return json(res, 200, await observabilityTargets());
    if (p === '/api/admin/observability/query' && req.method === 'GET') {
      const expr = url.searchParams.get('expr') || '';
      if (!expr || expr.length > 2000) return json(res, 400, { error: 'expr required (≤2000)', opId });
      return json(res, 200, await promQuery(expr, null));
    }
    if (p === '/api/admin/observability/query_range' && req.method === 'GET') {
      const expr = url.searchParams.get('expr') || '';
      if (!expr || expr.length > 2000) return json(res, 400, { error: 'expr required (≤2000)', opId });
      return json(res, 200, await promQuery(expr, { minutes: Number(url.searchParams.get('minutes')) || 60, step: Number(url.searchParams.get('step')) || 60 }));
    }
    if (p === '/api/admin/backbone/gitea' && req.method === 'GET') return json(res, 200, await giteaRepos());
    if (p === '/api/admin/backbone/gitea/tree' && req.method === 'GET') {
      return json(res, 200, await giteaTree(url.searchParams.get('owner') || '', url.searchParams.get('repo') || '', url.searchParams.get('ref') || ''));
    }
    if (p === '/api/admin/backbone/gitea/file' && req.method === 'GET') {
      return json(res, 200, await giteaFile(url.searchParams.get('owner') || '', url.searchParams.get('repo') || '', url.searchParams.get('ref') || '', url.searchParams.get('path') || ''));
    }
    if (p === '/api/admin/backbone/install' && req.method === 'POST') {
      try { const out = await backboneInstall(); await durableAudit(actor, 'backbone-install', BACKBONE_NS, 'accepted', '', opId); return json(res, 202, out); }
      catch (e) { console.error(`[err] op=${opId} backbone install:`, e); await durableAudit(actor, 'backbone-install', BACKBONE_NS, 'error', String(e).slice(0, 120), opId); return json(res, 502, { error: 'install failed', opId }); }
    }

    if (p === '/api/admin/extensions/revocations' && req.method === 'GET') {
      if (!db.isEnabled()) return json(res, 503, { error: 'RevocationLedgerUnavailable', opId });
      try { return json(res, 200, { items: await db.listImageRevocations() }); }
      catch (e) { return json(res, 503, { error: 'RevocationLedgerUnavailable', message: e?.message, opId }); }
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
        if (!db.isEnabled()) return json(res, 503, { error: 'RevocationLedgerUnavailable', opId });
        const item = await db.revokeImage({
          repository: parsed.repository, digest: parsed.reference, replacementDigest, actor, reason,
          audit: { time: new Date().toISOString(), opId, source: 'dupa-controller' },
        });
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
        if (requiresDomainSubShellAdmission(pkg)) {
          const readiness = await platformReadinessStatus(req);
          if (!readiness.admission.domainSubShellAdmissionAllowed) {
            await durableAudit(actor, 'extension-install', pkg.metadata.name, 'denied', 'DomainSubShellAdmissionRequired', opId);
            return json(res, 409, {
              error: 'DomainSubShellAdmissionRequired',
              message: 'AI domain subShell installation requires Platform Support Profile Ready and PFS Established.',
              readiness: { phase: readiness.phase, pfs: readiness.pfs, admission: readiness.admission }, opId,
            });
          }
        }
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
      // PostgreSQL audit_log가 유일한 정본이다. 기동 시 hydrate한 메모리 링은
      // 알림 보조 캐시일 뿐 조회 권위로 사용하지 않는다. 영구 저장소가 없을 때
      // 빈 목록으로 정상처럼 보이면 보안 이벤트 유실을 은폐하므로 fail-closed 한다.
      if (!db.isEnabled()) {
        return json(res, 503, { error: 'Backbone PostgreSQL audit unavailable', opId });
      }
      try {
        return json(res, 200, { items: await db.recentAudit(AUDIT_CAP) });
      } catch (e) {
        console.error('[audit] authoritative query failed:', String(e).slice(0, 160));
        return json(res, 503, { error: 'Backbone PostgreSQL audit unavailable', opId });
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
      const source = pluginId === 'opensphere-console-backend' || pluginId === 'opensphere-console-auth'
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
      const candidatePkg = await getPackage(id);
      if (candidatePkg.ok && requiresDomainSubShellAdmission(candidatePkg.json) && ['install', 'enable', 'rollback'].includes(action)) {
        const readiness = await platformReadinessStatus(req);
        if (!readiness.admission.domainSubShellAdmissionAllowed) {
          await durableAudit(actor, action, id, 'denied', 'DomainSubShellAdmissionRequired', opId);
          return json(res, 409, {
            error: 'DomainSubShellAdmissionRequired',
            message: 'AI domain subShell lifecycle requires Platform Support Profile Ready and PFS Established.',
            readiness: { phase: readiness.phase, pfs: readiness.pfs, admission: readiness.admission }, opId,
          });
        }
      }
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
    // Backbone PG·S3 연결 시도 → 감사로그 hydrate(PG 우선, 실패 시 ConfigMap) → reconcile/event 루프.
    // 연결은 루프의 ensureBackboneConnections가 disabled인 동안 계속 재시도 → startup 1회 실패해도 자동 복구.
    Promise.allSettled([initBackboneDb(), initBackboneStorage()]).finally(() => hydrateAudit().finally(() => {
      const loop = () => ensureBackboneConnections()
        .then(() => Promise.all([reconcile(), pollK8sEvents(), reconcileBackboneClaims()]))
        .catch((e) => console.error('loop error', e))
        .finally(() => setTimeout(loop, 15000));
      loop();
    }));
  });
} else {
  // 테스트로 require될 때는 서버 미기동 — 순수 보안 검증 로직만 노출(P2-4 회귀 테스트).
  module.exports = { assertClaims, assertManagedTokenActive, isAdminGroups, safeName, b64urlToBuf, validContributions, validCapabilities, integrationStatuses, moduleDescriptorIssues, packageFromInspection, deploymentManifest, pdbManifest, serviceManifest, hpaManifest, networkPolicyManifest, serviceMonitorManifest, observerClusterRoleManifest, hisManagerClusterRoleManifest, infrastructureManagerClusterRoleManifest, aiDomainOperatorClusterRoleManifest, aiDomainScopedRoleManifest, aiDomainScopedRoleBindingManifest, requiresDomainSubShellAdmission, publishedPluginEntry, allowedCLIResourcePath, condition, deploymentReadyResult, normalizeHisStatus, foundationDevOverrideEnabled, parseModuleImageReference, runnablePlatformManifests, governedSourceRepository, attestationArguments, verifiedActivatedRegistration, verifiedStagedUpdate };
}

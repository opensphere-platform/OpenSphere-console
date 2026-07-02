// dupa-registry-controller (DUPA Admin Control PoC, 계획서 §9 + 검토 §B.1/§B.5)
// 한 Node.js 서비스가 3역할:
//   ① reconcile : UIPluginRegistration desiredState → workload apply/delete + 검증 + registry 생성
//   ② Control API: /api/admin/plugins/* (Admin UI가 호출, kubectl 없이 상태 전이)
//   ③ registry  : /registry/plugins.json (셸 Extension Host가 읽는 산출물, 즉시 반영)
// 신뢰 루트는 UIPluginPackage(관리자 승인값). controller는 digest를 '계산해 비교'만 하고
// registry에는 승인값을 '전사'한다(§B.5). 이중 검증: 여기(설치 시점) + 셸(로드 시점).
// 의존성 0 (node 내장 http/crypto/fs).
const http = require('http');
const https = require('https');
const fs = require('fs');
const { createHash, createPublicKey, verify, randomBytes } = require('crypto');
const db = require('./db'); // Backbone PostgreSQL(감사로그 영속). 미연결 시 ConfigMap 폴백.
const storage = require('./storage'); // Backbone RustFS(S3). BackboneClaim objectStore 할당. 미연결 시 objectStore Pending.

const PORT = process.env.PORT || 8080;
const NS = process.env.NAMESPACE || 'opensphere-system';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const API = 'https://kubernetes.default.svc';
const GROUP = 'plugins.opensphere.io';
const V = 'v1alpha1';
// 셸(브라우저)이 플러그인 manifest/번들에 접근하는 경로 prefix (nginx 프록시 기준)
const SHELL_API_PREFIX = '/api/plugins';
const MAX_BODY = 256 * 1024; // 요청 본문 상한(무제한 버퍼링 차단, 감사 H)
// 재감사 P1-1: /api/admin/events(subShell server-to-server 발행)는 사용자 토큰이 없으므로 서비스 토큰으로 보호.
// 미설정이면 events 발행은 fail-closed(401). subShell 백엔드는 X-Shell-Token 헤더로 이 값을 전송해야 한다.
const SHELL_SERVICE_TOKEN = process.env.SHELL_SERVICE_TOKEN || '';
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
// console-backend(opensphere-identity)의 governance gate와 동일 규칙: JWKS(ES256) 서명검증 +
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
// 콘솔 로그인 id_token 발급자 = kanidm-core(app=kanidm). svc/kanidm은 opensphere-auth BFF(PAT 발급자, 다른 키)라
// 거기 JWKS로 검증하면 kid 불일치 401. → kanidm-core svc에서 JWKS를 받되, cert SAN이 kanidm.svc라
// servername으로 SNI/검증 호스트를 맞춘다(동일 kanidm-tls 인증서).
const KANIDM_JWKS_URL = process.env.KANIDM_JWKS_URL || 'https://kanidm-core.opensphere-console-auth.svc:8443/oauth2/openid/opensphere-console/public_key.jwk';
const KANIDM_TLS_SERVERNAME = process.env.KANIDM_TLS_SERVERNAME || 'kanidm.opensphere-console-auth.svc';
const KANIDM_AZP = process.env.KANIDM_AZP || 'opensphere-console';
const KANIDM_ADMIN_GROUP = process.env.KANIDM_ADMIN_GROUP || 'opensphere-console-admins';
const KANIDM_CA_PATH = process.env.KANIDM_CA_PATH || '/etc/kanidm-ca/ca.crt';
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
const isAdminGroups = (groups) => (groups || []).includes(KANIDM_ADMIN_GROUP);
async function verifyAuthed(req) {
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
  const groups = (claims.groups || []).map((g) => shortName(g).replace(/^\//, ''));
  return { username: claims.preferred_username || 'unknown', groups };
}
async function verifyActor(req) {
  const a = await verifyAuthed(req);
  if (!isAdminGroups(a.groups)) throw { code: 403, msg: `not in ${KANIDM_ADMIN_GROUP}` };
  return a;
}

// ── audit (감사 P1-4: 영속화 + operationId) ──────────────────────────────
// 인메모리 링버퍼(빠른 /events 응답) + ConfigMap(dupa-audit-log) 영속(재시작 생존, append-only JSONL).
// 컨트롤러 Role은 configmaps create/update/patch 보유 → 새 RBAC 불요. stdout JSON은 클러스터 로그 수집기용.
const AUDIT_CM = 'dupa-audit-log';
const AUDIT_CAP = 500;
const audit = [];
let _flushT = null;
function logAudit(actor, action, target, result, reason, opId) {
  const e = { time: new Date().toISOString(), opId: opId || newOpId(), actor: actor || 'system', action, target, result, reason: reason || '' };
  audit.unshift(e);
  if (audit.length > AUDIT_CAP) audit.pop();
  console.log('[audit] ' + JSON.stringify(e)); // 구조화 1줄 → 로그 수집기 영속(휘발 대비)
  if (db.isEnabled()) {
    // ④ PostgreSQL(audit_log) append-only INSERT. 비동기 — 실패해도 인메모리 링/stdout은 보존.
    db.insertAudit(e).catch((err) => console.error('[audit] pg insert 실패:', String(err).slice(0, 120)));
  } else if (!_flushT) {
    _flushT = setTimeout(flushAudit, 2000); // PG 미연결(Backbone 미설치 등) 시 ConfigMap 폴백
  }
  return e;
}
const newOpId = () => randomBytes(8).toString('hex');
async function flushAudit() {
  _flushT = null;
  const jsonl = audit.slice().reverse().map((x) => JSON.stringify(x)).join('\n');
  const cmPath = `/api/v1/namespaces/${NS}/configmaps/${AUDIT_CM}`;
  try {
    const r = await k8s('PATCH', cmPath, { data: { 'audit.jsonl': jsonl } });
    if (r.status === 404) await k8s('POST', `/api/v1/namespaces/${NS}/configmaps`, { metadata: { name: AUDIT_CM, namespace: NS }, data: { 'audit.jsonl': jsonl } });
  } catch (e) { console.error('[audit] flush failed:', String(e).slice(0, 120)); }
}
async function hydrateAudit() {
  if (db.isEnabled()) {
    // PG 우선 — recentAudit는 newest-first → ring(unshift 규약상 [0]=최신)에 그대로 push.
    try {
      const rows = await db.recentAudit(AUDIT_CAP);
      rows.forEach((e) => audit.push(e));
      console.log(`[audit] hydrated ${audit.length} entries from PostgreSQL`);
      return;
    } catch (e) { console.error('[audit] pg hydrate 실패, ConfigMap 시도:', String(e).slice(0, 120)); }
  }
  try {
    const r = await k8s('GET', `/api/v1/namespaces/${NS}/configmaps/${AUDIT_CM}`);
    if (!r.ok) return;
    const lines = String(r.json?.data?.['audit.jsonl'] || '').split('\n').filter(Boolean);
    for (const ln of lines.slice(-AUDIT_CAP)) { try { audit.unshift(JSON.parse(ln)); } catch { /* skip */ } }
    if (audit.length > AUDIT_CAP) audit.length = AUDIT_CAP;
    console.log(`[audit] hydrated ${audit.length} entries from ${AUDIT_CM}`);
  } catch (e) { console.error('[audit] hydrate failed:', String(e).slice(0, 120)); }
}
// Backbone PostgreSQL 연결 초기화 — Secret(opensphere-backbone/backbone-postgres)에서 비번 로드 후 pool 기동.
// 실패(미설치·연결불가)해도 throw 안 함 → 감사로그는 ConfigMap 폴백으로 계속 동작(graceful degradation, §3.5).
async function initBackboneDb(quiet = false) {
  try {
    const r = await k8s('GET', `/api/v1/namespaces/${BACKBONE_PG.secretNs}/secrets/${BACKBONE_PG.secretName}`);
    if (!r.ok) { if (!quiet) console.warn(`[db] secret ${BACKBONE_PG.secretNs}/${BACKBONE_PG.secretName} 없음(HTTP ${r.status}) → 감사로그 ConfigMap 폴백`); return; }
    const enc = r.json?.data?.[BACKBONE_PG.secretKey];
    if (!enc) { if (!quiet) console.warn('[db] secret에 password 키 없음 → ConfigMap 폴백'); return; }
    const password = Buffer.from(enc, 'base64').toString('utf8');
    await db.init({ host: BACKBONE_PG.host, port: BACKBONE_PG.port, database: BACKBONE_PG.database, user: BACKBONE_PG.user, password });
  } catch (e) {
    if (!quiet) console.warn('[db] init 실패 → 감사로그 ConfigMap 폴백:', String(e).slice(0, 160));
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
  return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : null };
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
// CLIDownload (console.opensphere.io, cluster-scoped) — headless 비-UI 콘솔 바인딩. UIPluginPackage(UI 게스트)와 별개 kind.
// 컨트롤러는 plugins를 reconcile(워크로드+서명)하지만, binding은 '선언'이라 reconcile 없이 admin에 '인식'시키기 위해 list만.
const CONSOLE_GROUP = 'console.opensphere.io';
const listCliDownloads = () => k8s('GET', `/apis/${CONSOLE_GROUP}/${V}/clidownloads`);
async function setStatus(name, status) {
  return k8s('PATCH', `${crd('uipluginregistrations')}/${name}/status`,
    { status: { ...status, lastTransitionTime: new Date().toISOString() } });
}

// ── 워크로드(기능 컨테이너) apply/delete ──────────────────────
// 워크로드를 UIPluginPackage 소유로 표시 → 패키지 삭제 시 K8s GC가 Deployment/Service를 자동 회수(cascade).
// 이전엔 ownerReference 부재로 workload가 고아가 돼 spine-up이 명시 삭제로 우회했음(감사 후속③ 구조개선).
// owner·dependent 동일 namespace(opensphere-system)라 native GC 적용 — finalizer 불요. controller:true=유일 제어소유자.
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
  const env = [{ name: 'NODE_EXTRA_CA_CERTS', value: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt' }];
  const seen = new Set(env.map((item) => item.name));
  for (const item of pkg.spec?.env || []) {
    const name = String(item?.name || '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || seen.has(name)) continue;
    env.push({ name, value: String(item?.value ?? '') });
    seen.add(name);
  }
  return env;
}
function deploymentManifest(pkg) {
  const name = pkg.metadata.name;
  const _d = pkg.spec.image.digest || '';
  const img = _d.startsWith('sha256:') ? `${pkg.spec.image.repository}@${_d}` : `${pkg.spec.image.repository}:${_d || 'latest'}`;
  const serviceAccountName = typeof pkg.spec.serviceAccountName === 'string' && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(pkg.spec.serviceAccountName)
    ? pkg.spec.serviceAccountName
    : undefined;
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace: NS, labels: { app: name, 'opensphere.io/dupa-plugin': name }, ownerReferences: [ownerRef(pkg)] },
    spec: {
      replicas: 1, selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { ...podLabels(pkg), app: name } },
        spec: {
          ...(serviceAccountName ? { serviceAccountName } : {}),
          imagePullSecrets: [{ name: 'ghcr-pull' }],
          containers: [{
            name: 'plugin', image: img, ports: [{ containerPort: 8080 }],
            // K8s API를 호출하는 기능 컨테이너(예: platform-status)의 TLS 검증용 — 기본 제공
            env: podEnv(pkg),
            readinessProbe: { httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 1 },
            resources: { requests: { cpu: '20m', memory: '32Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
          }],
        },
      },
    },
  };
}
function serviceManifest(pkg) {
  const name = pkg.metadata.name;
  return {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name, namespace: NS, labels: { 'opensphere.io/dupa-plugin': name }, ownerReferences: [ownerRef(pkg)] },
    spec: { selector: { app: name }, ports: [{ port: 8080, targetPort: 8080 }] },
  };
}
async function applyWorkload(pkg) {
  const name = pkg.metadata.name;
  for (const [plural, man] of [['deployments', deploymentManifest(pkg)], ['services', serviceManifest(pkg)]]) {
    const base = `/apis/apps/v1/namespaces/${NS}/deployments`;
    const path = plural === 'deployments' ? base : `/api/v1/namespaces/${NS}/services`;
    const exists = await k8s('GET', `${path}/${name}`);
    if (exists.ok) await k8s('PATCH', `${path}/${name}`, man);
    else await k8s('POST', path, man);
  }
}
async function deleteWorkload(name) {
  await k8s('DELETE', `/apis/apps/v1/namespaces/${NS}/deployments/${name}`);
  await k8s('DELETE', `/api/v1/namespaces/${NS}/services/${name}`);
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
  const mRes = await fetch(`${svc}/plugins/ui-shell.manifest.json`);
  if (!mRes.ok) return { ok: false, reason: 'ManifestUnreachable' };
  const mText = await mRes.text();
  // ① manifest digest: 계산해서 승인값(CR)과 '비교' (§B.5)
  if (sha256(mText) !== pkg.spec.manifest.sha256) return { ok: false, reason: 'DigestMismatch' };
  const manifest = JSON.parse(mText);
  // ② 서명: trustedKeys[keyId]로 검증 (TrustedKeys CM에서 SPKI 조회)
  const spki = (await loadTrustedKeys())[pkg.spec.trust.keyId];
  if (!spki) return { ok: false, reason: 'UntrustedKey' };
  const sRes = await fetch(`${svc}${'/plugins/' + (pkg.spec.manifest.signaturePath || '/plugins/ui-shell.manifest.json.sig').split('/').pop()}`);
  if (!sRes.ok) return { ok: false, reason: 'SignatureUnreachable' };
  if (!verifyP256(spki, (await sRes.text()).trim(), mText)) return { ok: false, reason: 'SignatureInvalid' };
  // ③ shellCompat / ④ permissions (정적 검사)
  if (manifest.shellCompat !== pkg.spec.shellCompat) return { ok: false, reason: 'ShellCompatDrift' };
  // ⑤ entry digest
  const eRes = await fetch(`${svc}/plugins/${manifest.entry}`);
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

// ── reconcile: registration desiredState → 실제 상태 ──────────
let runtimeRegistry = { version: 2, trustedKeys: {}, plugins: [] };
// P0-2/재감사 P1-2 allowlist: /api/plugins/<id> 프록시 허용 id 집합 = (a) 검증 성공+활성(published) plugin id
// + (b) enabled CLIDownload 바인딩 서비스 id(os-cli 등). 미등록 id는 nginx auth_request에서 403.
// reconcile 끝에서 published로 계산(루프 뒤). 전이 실패 시 직전 allowlist 유지(가용성).
let proxyAllow = new Set();
async function reconcile() {
  const [pkgs, regs] = await Promise.all([listPackages(), listRegs()]);
  if (!pkgs.ok || !regs.ok) return;
  const pkgByName = Object.fromEntries(pkgs.json.items.map((p) => [p.metadata.name, p]));
  _trustedKeys = null; // 매 reconcile마다 신뢰키 재로드
  const trustedKeys = await loadTrustedKeys();
  const published = [];

  for (const reg of regs.json.items) {
    const name = reg.metadata.name;
    const pkg = pkgByName[reg.spec.packageRef.name];
    const desired = reg.spec.desiredState;
    if (!pkg) { await setStatus(name, { phase: 'Failed', reason: 'PackageNotFound' }); continue; }

    try {
      if (desired === 'Uninstalled') {
        // 워크로드 회수 + registration CR도 삭제 → Installed 탭에서 사라짐(계획서 §10.4).
        // 이력은 audit에 남으므로 정보 손실 없음. (CR을 Removed로 남기면 목록에 잔류해
        // "uninstall이 안 된 것처럼" 보이는 UX 문제가 있었음)
        await deleteWorkload(pkg.metadata.name);
        await k8s('DELETE', `${crd('uipluginregistrations')}/${name}`);
        continue;
      }
      if (desired === 'Disabled') {
        // workload 유지, registry에서만 제외 (메뉴/route 소멸)
        await setStatus(name, { phase: 'Disabled', reason: '' });
        continue;
      }
      // Enabled
      await setStatus(name, { phase: 'Installing', reason: '' });
      await applyWorkload(pkg);
      // ready 대기 (짧게)
      let ready = false;
      for (let i = 0; i < 30 && !ready; i++) { ready = await workloadReady(pkg.metadata.name); if (!ready) await sleep(2000); }
      if (!ready) { await setStatus(name, { phase: 'Failed', reason: 'WorkloadNotReady' }); continue; }

      const v = await verifyPlugin(pkg);
      if (!v.ok) { await setStatus(name, { phase: 'Failed', reason: v.reason }); continue; }

      // 통과 — registry에 '승인값 전사'(§B.5): manifestSha256/keyId는 controller 계산값이 아니라 CR값
      const manifestUrl = `${SHELL_API_PREFIX}/${pkg.metadata.name}/plugins/ui-shell.manifest.json`;
      const sigUrl = `${SHELL_API_PREFIX}/${pkg.metadata.name}/plugins/${(pkg.spec.manifest.signaturePath || 'ui-shell.manifest.json.sig').split('/').pop()}`;
      published.push({
        id: pkg.metadata.name,
        manifest: manifestUrl,
        manifestSha256: pkg.spec.manifest.sha256,
        signature: sigUrl,
        keyId: pkg.spec.trust.keyId,
        // 관리자 지정 1단 아이콘(Carbon 토큰명). 서명 무관 오버라이드(CR spec.nav.icon) — 셸이 토큰→아이콘 매핑.
        icon: pkg.spec.nav?.icon || '',
      });
      await setStatus(name, { phase: 'Enabled', reason: '', manifestUrl });
    } catch (e) {
      await setStatus(name, { phase: 'Failed', reason: String(e).slice(0, 120) });
    }
  }
  runtimeRegistry = { version: 2, trustedKeys, plugins: published };
  // 재감사 P1-2: proxy allowlist = '검증 성공 + 활성(published)' id + enabled CLIDownload 서비스 id만.
  //   (모든 UIPluginPackage 이름이 아니라) → Failed/Disabled/미검증 package는 자동 제외(403).
  //   reconcile 성공분으로만 교체(전이 실패 시 직전 allowlist 유지 → 가용성).
  const allow = new Set(published.map((p) => p.id));
  try {
    const cds = await listCliDownloads();
    for (const cd of cds.json?.items || []) {
      if (cd.spec?.enabled === false) continue; // enabled 바인딩만 허용
      for (const l of (cd.spec?.links || [])) {
        const mm = String(l.href || '').match(/^\/api\/plugins\/([a-z0-9-]+)\//);
        if (mm) allow.add(mm[1]);
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
  const body = {
    apiVersion: `${GROUP}/${V}`, kind: 'UIPluginRegistration',
    metadata: { name: pkgName, namespace: NS },
    spec: { packageRef: { name: pkgName }, desiredState,
      installPolicy: { createWorkload: true, createProxyRoute: true, exposeInNavigation: true },
      approval: { requestedBy: actor || 'unknown', reason: reason || '' } },
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
  rustfs: { secret: 'backbone-rustfs', proto: 'HTTP(S3) · 9000 / 콘솔 9001', connect: 'S3 endpoint: backbone-rustfs.opensphere-backbone.svc.cluster.local:9000 (forcePathStyle=true, region=us-east-1)', note: 'access_key/secret_key = Secret backbone-rustfs.' },
  gitea: { secret: 'backbone-postgres', proto: 'HTTP · 3000', connect: 'http://backbone-gitea.opensphere-backbone.svc.cluster.local:3000/', note: 'DB는 backbone-postgres 공유. Gitea 관리자 토큰 Secret은 아직 미프로비저닝(reconciler 단계).' },
};
function bbSecret(name, data) { return { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: BACKBONE_NS, labels: BB_LABELS }, type: 'Opaque', stringData: data }; }
function bbPath(o) {
  if (o.kind === 'Deployment') return `/apis/apps/v1/namespaces/${BACKBONE_NS}/deployments`;
  if (o.kind === 'StatefulSet') return `/apis/apps/v1/namespaces/${BACKBONE_NS}/statefulsets`;
  const core = { Service: 'services', PersistentVolumeClaim: 'persistentvolumeclaims', ConfigMap: 'configmaps', Secret: 'secrets' }[o.kind];
  return `/api/v1/namespaces/${BACKBONE_NS}/${core}`;
}
async function bbApply(o) { const r = await k8s('POST', bbPath(o), o); if (r.ok || r.status === 409) return; throw new Error(`apply ${o.kind}/${o.metadata && o.metadata.name} HTTP ${r.status}`); }
function bbWorkloads() {
  const lab = (app) => Object.assign({ app }, BB_LABELS);
  return [
    // init-00-pgvector.sh가 먼저(알파벳순) template1+console에 vector 확장 생성 → 이후 생성되는 gitea/ai_hub(템플릿 상속)도 vector 보유.
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'backbone-postgres-init', namespace: BACKBONE_NS, labels: BB_LABELS }, data: {
      'init-00-pgvector.sh': '#!/bin/bash\nset -e\nfor d in template1 "$POSTGRES_DB"; do\n  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$d" -c "CREATE EXTENSION IF NOT EXISTS vector;"\ndone\n',
      'init-gitea-db.sql': 'CREATE DATABASE gitea OWNER console;',
    } },
    { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'backbone-postgres-data', namespace: BACKBONE_NS, labels: BB_LABELS }, spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'standard', resources: { requests: { storage: '8Gi' } } } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'backbone-postgres', namespace: BACKBONE_NS, labels: lab('backbone-postgres') }, spec: {
      replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: { app: 'backbone-postgres' } },
      template: { metadata: { labels: { app: 'backbone-postgres' } }, spec: { containers: [{
        name: 'postgresql', image: 'pgvector/pgvector:pg18',
        env: [
          { name: 'POSTGRES_DB', value: 'console' }, { name: 'POSTGRES_USER', value: 'console' },
          { name: 'POSTGRES_PASSWORD', valueFrom: { secretKeyRef: { name: 'backbone-postgres', key: 'password' } } },
          { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
        ],
        ports: [{ containerPort: 5432 }],
        readinessProbe: { exec: { command: ['/bin/sh', '-c', 'pg_isready -U console -d console'] }, initialDelaySeconds: 10, periodSeconds: 5 },
        resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
        volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }, { name: 'init', mountPath: '/docker-entrypoint-initdb.d' }],
      }], volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'backbone-postgres-data' } }, { name: 'init', configMap: { name: 'backbone-postgres-init' } }] } },
    } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'backbone-postgres', namespace: BACKBONE_NS, labels: lab('backbone-postgres') }, spec: { selector: { app: 'backbone-postgres' }, ports: [{ name: 'pg', port: 5432, targetPort: 5432 }] } },
    { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'backbone-rustfs', namespace: BACKBONE_NS, labels: lab('backbone-rustfs') }, spec: {
      serviceName: 'backbone-rustfs', replicas: 1, selector: { matchLabels: { app: 'backbone-rustfs' } },
      template: { metadata: { labels: { app: 'backbone-rustfs' } }, spec: {
        securityContext: { runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, runAsNonRoot: true },
        containers: [{ name: 'rustfs', image: 'rustfs/rustfs:1.0.0-beta.8', imagePullPolicy: 'IfNotPresent',
          env: [
            { name: 'RUSTFS_VOLUMES', value: '/data' }, { name: 'RUSTFS_ADDRESS', value: '0.0.0.0:9000' },
            { name: 'RUSTFS_CONSOLE_ADDRESS', value: '0.0.0.0:9001' }, { name: 'RUSTFS_CONSOLE_ENABLE', value: 'true' },
            { name: 'RUSTFS_ACCESS_KEY', valueFrom: { secretKeyRef: { name: 'backbone-rustfs', key: 'access_key' } } },
            { name: 'RUSTFS_SECRET_KEY', valueFrom: { secretKeyRef: { name: 'backbone-rustfs', key: 'secret_key' } } },
          ],
          ports: [{ name: 's3', containerPort: 9000 }, { name: 'console', containerPort: 9001 }],
          resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '1Gi' } },
          readinessProbe: { tcpSocket: { port: 's3' }, initialDelaySeconds: 8, periodSeconds: 8, failureThreshold: 12 },
          volumeMounts: [{ name: 'data', mountPath: '/data' }] }] } },
      volumeClaimTemplates: [{ metadata: { name: 'data' }, spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'standard', resources: { requests: { storage: '20Gi' } } } }],
    } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'backbone-rustfs', namespace: BACKBONE_NS, labels: lab('backbone-rustfs') }, spec: { selector: { app: 'backbone-rustfs' }, ports: [{ name: 's3', port: 9000, targetPort: 9000 }, { name: 'console', port: 9001, targetPort: 9001 }] } },
    { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'backbone-gitea-data', namespace: BACKBONE_NS, labels: BB_LABELS }, spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'standard', resources: { requests: { storage: '10Gi' } } } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'backbone-gitea', namespace: BACKBONE_NS, labels: lab('backbone-gitea') }, spec: {
      replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: { app: 'backbone-gitea' } },
      template: { metadata: { labels: { app: 'backbone-gitea' } }, spec: { containers: [{
        name: 'gitea', image: 'docker.io/gitea/gitea:1.22',
        env: [
          { name: 'GITEA__database__DB_TYPE', value: 'postgres' },
          { name: 'GITEA__database__HOST', value: `backbone-postgres.${BACKBONE_NS}.svc.cluster.local:5432` },
          { name: 'GITEA__database__NAME', value: 'gitea' }, { name: 'GITEA__database__USER', value: 'console' },
          { name: 'GITEA__database__PASSWD', valueFrom: { secretKeyRef: { name: 'backbone-postgres', key: 'password' } } },
          { name: 'GITEA__security__INSTALL_LOCK', value: 'true' }, { name: 'GITEA__server__OFFLINE_MODE', value: 'true' },
          { name: 'GITEA__metrics__ENABLED', value: 'true' }, // 내장 /metrics(:3000) — backbone-instrumentation.yaml ServiceMonitor가 scrape.
          { name: 'GITEA__server__ROOT_URL', value: `http://backbone-gitea.${BACKBONE_NS}.svc.cluster.local:3000/` },
        ],
        ports: [{ containerPort: 3000 }],
        readinessProbe: { tcpSocket: { port: 3000 }, initialDelaySeconds: 15, periodSeconds: 10, failureThreshold: 18 },
        resources: { requests: { cpu: '50m', memory: '192Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
        volumeMounts: [{ name: 'data', mountPath: '/data' }] }], volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'backbone-gitea-data' } }] } },
    } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'backbone-gitea', namespace: BACKBONE_NS, labels: lab('backbone-gitea') }, spec: { selector: { app: 'backbone-gitea' }, ports: [{ name: 'http', port: 3000, targetPort: 3000 }] } },
  ];
}
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
  const ns = await k8s('POST', '/api/v1/namespaces', { apiVersion: 'v1', kind: 'Namespace', metadata: { name: BACKBONE_NS, labels: BB_LABELS } });
  if (!ns.ok && ns.status !== 409) throw new Error(`namespace HTTP ${ns.status}`);
  await bbApply(bbSecret('backbone-postgres', { password: randomBytes(24).toString('hex') }));
  await bbApply(bbSecret('backbone-rustfs', { access_key: 'rustfsadmin', secret_key: 'rustfsadmin', endpoint: `backbone-rustfs.${BACKBONE_NS}.svc:9000` }));
  for (const o of bbWorkloads()) await bbApply(o);
  return backboneStatus();
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
const S3_ENDPOINT = process.env.BACKBONE_S3_ENDPOINT || `http://${S3_DNS}:9000`;
const S3_REGION = process.env.BACKBONE_S3_REGION || 'us-east-1';
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
    storage.init({ endpoint: S3_ENDPOINT, region: S3_REGION, accessKey: ak, secretKey: sk });
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
  // PostgreSQL — 전용 db/role + Secret(claim NS). 기존 Secret 비번 재사용(드리프트 방지).
  if (cr.spec?.postgres?.enabled) {
    const dbName = cr.spec.postgres.database || name.replace(/-/g, '_');
    const secretName = `${name}-backbone-postgres`;
    if (!db.isEnabled()) { status.phase = 'Pending'; status.message = 'PostgreSQL 미연결'; }
    else {
      const sec = await k8s('GET', `/api/v1/namespaces/${ns}/secrets/${secretName}`);
      let pw = sec.ok ? Buffer.from(sec.json?.data?.password || '', 'base64').toString('utf8') : '';
      if (!pw) pw = randomBytes(24).toString('hex');
      await db.provisionTenant(dbName, pw);
      await upsertSecret(ns, secretName, { host: PG_DNS, port: '5432', database: dbName, username: dbName, password: pw });
      const appSecretName = `${name}-backbone-postgres-app`;
      status.postgres = { secretRef: secretName, host: PG_DNS, database: dbName };
      if (cr.spec?.postgres?.appRole?.enabled === false) {
        await k8s('DELETE', `/api/v1/namespaces/${ns}/secrets/${appSecretName}`);
      } else {
        const appSec = await k8s('GET', `/api/v1/namespaces/${ns}/secrets/${appSecretName}`);
        let appPw = appSec.ok ? Buffer.from(appSec.json?.data?.password || '', 'base64').toString('utf8') : '';
        if (!appPw) appPw = randomBytes(24).toString('hex');
        const appUser = postgresAppRoleName(dbName, cr, appSec);
        await db.provisionTenantAppRole(dbName, appUser, appPw);
        await upsertSecret(ns, appSecretName, { host: PG_DNS, port: '5432', database: dbName, username: appUser, password: appPw, role: 'app' });
        status.postgres.appSecretRef = appSecretName;
        status.postgres.appUsername = appUser;
      }
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
        await upsertSecret(ns, s3secret, { endpoint: S3_ENDPOINT, region: S3_REGION, bucket, access_key: storage.accessKey(), secret_key: storage.secretKey() });
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
    { key: 'console-backend', name: 'console-backend', app: 'console-backend', ns: NS },
    { key: 'dupa', name: 'dupa-registry-controller', app: 'dupa-registry-controller', ns: NS },
    { key: 'backbone-postgres', name: 'Backbone PostgreSQL', app: 'backbone-postgres', ns: BACKBONE_NS },
    { key: 'backbone-rustfs', name: 'Backbone RustFS', app: 'backbone-rustfs', ns: BACKBONE_NS, gap: 'rustfs beta — Prometheus endpoint 미제공(upstream 대기)' },
    { key: 'backbone-gitea', name: 'Backbone Gitea', app: 'backbone-gitea', ns: BACKBONE_NS },
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

// ── /metrics (Prometheus exposition, 의존성 0; 클러스터 내부 전용 — nginx 미라우팅) ──
// 공유 관측 계층(k8s basic stack / prometheus-stack)이 ServiceMonitor로 scrape. docs/OBSERVABILITY-ARCHITECTURE.md.
let _httpReqs = 0;
function metricsText() {
  const mu = process.memoryUsage();
  const plugins = runtimeRegistry && Array.isArray(runtimeRegistry.plugins) ? runtimeRegistry.plugins.length : 0;
  return [
    '# HELP os_build_info Build info (constant 1).',
    '# TYPE os_build_info gauge',
    `os_build_info{service="dupa-registry-controller",version="${process.env.APP_VERSION || 'dev'}"} 1`,
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
  const opId = newOpId();
  _httpReqs++;
  try {
    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (p === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); return res.end(metricsText()); }
    if (p === '/registry/plugins.json') return json(res, 200, runtimeRegistry);

    // P0-2: nginx auth_request 대상 — /api/plugins/<id> 프록시 허용 여부(registry allowlist).
    // 등록·검증돼 runtimeRegistry에 게시된 plugin id만 통과 → opensphere-system 내 임의 service 프록시 차단.
    if (p === '/api/internal/proxy-authz') {
      const id = req.headers['x-plugin-id'] || '';
      res.writeHead(proxyAllow.has(id) ? 204 : 403); return res.end();
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
        logAudit(actor, 'pg-create-function', tgt, 'accepted', `lang=${b.language || 'plpgsql'}${b.replace ? ' replace' : ''}`, opId);
        return json(res, 201, { created: true, target: tgt });
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 200);
        logAudit(actor, 'pg-create-function', tgt, 'error', msg, opId);
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
        logAudit(actor, 'pg-drop-function', tgt, 'accepted', '', opId);
        return json(res, 200, { dropped: true, target: tgt });
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 200);
        logAudit(actor, 'pg-drop-function', tgt, 'error', msg, opId);
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
      try { const out = await backboneInstall(); logAudit(actor, 'backbone-install', BACKBONE_NS, 'accepted', '', opId); return json(res, 202, out); }
      catch (e) { console.error(`[err] op=${opId} backbone install:`, e); logAudit(actor, 'backbone-install', BACKBONE_NS, 'error', String(e).slice(0, 120), opId); return json(res, 502, { error: 'install failed', opId }); }
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
        const health = x.spec.desiredState === 'Enabled' ? (await workloadReady(nm) ? 'Ready' : 'NotReady') : 'N/A';
        return { name: nm, desiredState: x.spec.desiredState, status: x.status || {}, approval: x.spec.approval, health };
      }));
      return json(res, 200, { items });
    }
    if (p === '/api/admin/plugins/events') return json(res, 200, { items: audit });

    // ── Bindings (headless 비-UI 확장): CLIDownload 등. UI plugins와 분리된 관리 채널(binding≠plugin) ──
    if (p === '/api/admin/bindings') {
      const cds = await listCliDownloads();
      const items = (cds.json?.items || []).map((x) => ({ kind: 'CLIDownload', name: x.metadata.name, ...x.spec, enabled: x.spec.enabled !== false }));
      return json(res, 200, { items });
    }
    // binding enable/disable = spec.enabled 소프트 토글(선언·서빙 유지, 콘솔 노출만). plugin Disable과 동형.
    const bm = p.match(/^\/api\/admin\/bindings\/([a-z0-9-]+)\/(enable|disable)$/);
    if (bm && req.method === 'POST') {
      const [, name, action] = bm;
      const r = await k8s('PATCH', `/apis/${CONSOLE_GROUP}/${V}/clidownloads/${name}`, { spec: { enabled: action === 'enable' } });
      if (!r.ok) { console.error(`[err] op=${opId} binding ${action} ${name} k8s ${r.status}:`, JSON.stringify(r.json).slice(0, 200)); logAudit(actor, action, 'binding/' + name, 'error', `HTTP ${r.status}`, opId); return json(res, r.status >= 500 ? 502 : r.status, { error: 'upstream error', status: r.status, opId }); }
      logAudit(actor, action, 'binding/' + name, 'accepted', '', opId);
      return json(res, 202, { accepted: true, name, enabled: action === 'enable' });
    }

    // ── P1 발행 백본(ADR-UI-003/UI-002 §D3): subShell 백엔드 → 콘솔 알림 소스(audit bus) 발행.
    // 콘솔 알림 NotificationService가 /api/admin/plugins/events 폴링으로 수집. source는 attribution.
    // ⚠️ 인증은 컨트롤 API 전체와 동급(X-OpenSphere-* 헤더) — 강화(SA TokenReview/NetworkPolicy)는 후속.
    if (p === '/api/admin/events' && req.method === 'POST') {
      // 재감사 P1-1: 무인증 쓰기 차단 — 서비스 토큰(X-Shell-Token == SHELL_SERVICE_TOKEN) 필수(fail-closed).
      // 사용자 토큰이 없는 subShell server-to-server 발행구라 사용자 Bearer 대신 서비스 토큰으로 보호.
      if (!SHELL_SERVICE_TOKEN || req.headers['x-shell-token'] !== SHELL_SERVICE_TOKEN) {
        return json(res, 401, { error: 'service token required', opId });
      }
      // source는 'ext:'로 네임스페이스(사용자 actor 위장 불가) + 필드 길이 bound.
      const b = await readBody(req).catch(() => ({}));
      const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
      const source = 'ext:' + clip(b.source || req.headers['x-opensphere-source'] || 'subshell', 60);
      logAudit(source, clip(b.action || 'event', 60), clip(b.target || b.title || '', 120), clip(b.result || b.severity || 'info', 30), clip(b.reason || b.detail || '', 200), opId);
      return json(res, 202, { accepted: true, source });
    }

    const m = p.match(/^\/api\/admin\/plugins\/registrations\/([a-z0-9-]+)\/(install|enable|disable|uninstall)$/);
    if (m && req.method === 'POST') {
      const [, id, action] = m;
      // §3.1 강제: shell-pinned core 표면은 제거/비활성 불가(보안 경계 — UI 억제보다 본질).
      if (action === 'disable' || action === 'uninstall') {
        const pkgC = await k8s('GET', `${crd('uipluginpackages')}/${id}`);
        if (pkgC.ok && isCorePkg(pkgC.json)) {
          logAudit(actor, action, id, 'denied', 'core surface(shell-pinned) 제거/비활성 불가 (ADR-UI-003 §3.1)', opId);
          return json(res, 409, { error: 'core surface — not removable', core: true });
        }
      }
      const body = await readBody(req).catch(() => ({}));
      const desired = action === 'install' || action === 'enable' ? 'Enabled' : action === 'disable' ? 'Disabled' : 'Uninstalled';
      const r = await ensureRegistration(id, desired, actor, body.reason);
      if (!r.ok) { console.error(`[err] op=${opId} ${action} ${id} k8s ${r.status}:`, JSON.stringify(r.json).slice(0, 200)); logAudit(actor, action, id, 'error', `HTTP ${r.status}`, opId); return json(res, r.status >= 500 ? 502 : r.status, { error: 'upstream error', status: r.status, opId }); }
      logAudit(actor, action, id, 'accepted', '', opId);
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
      if (!r.ok) { console.error(`[err] op=${opId} set-icon ${id} k8s ${r.status}:`, JSON.stringify(r.json).slice(0, 200)); logAudit(actor, 'set-icon', id, 'error', `HTTP ${r.status}`, opId); return json(res, r.status >= 500 ? 502 : r.status, { error: 'upstream error', status: r.status, opId }); }
      logAudit(actor, 'set-icon', id, 'accepted', icon, opId);
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
    console.log(`dupa-registry-controller listening :${PORT} (ns=${NS})`);
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
  module.exports = { assertClaims, isAdminGroups, safeName, b64urlToBuf };
}

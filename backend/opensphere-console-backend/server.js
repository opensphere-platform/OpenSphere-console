// opensphere-identity — Identity perspective(#3) — Kanidm 사용자 관리(IGA).
// ADR-FND-003 새 인증 시스템 정합: 콘솔 IdP=Kanidm. 이 플러그인은 Kanidm의 person/group을 관리한다.
//   ① governance gate: 호출자 토큰을 Kanidm JWKS(ES256)로 검증 → opensphere-console-admins만 쓰기.
//   ② reason 필수 + ③ audit + ④ JIT 금지.
// Kanidm admin 자격 = k8s Secret(opensphere-identity-kanidm: url, token=service-account API token)에서 런타임 조회.
//   (구 Keycloak admin 연동은 새 인증 시스템(Kanidm)으로 대체됨.)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createPublicKey, verify, randomBytes } = require('crypto');
const MAX_BODY = 256 * 1024; // 요청 본문 상한(무제한 버퍼링 차단, 감사 H)
const newOpId = () => randomBytes(8).toString('hex');

const PORT = process.env.PORT || 8080;
const PLUGIN_DIR = process.env.PLUGIN_DIR || '/plugins';
const VERSION = process.env.APP_VERSION || '0.3.0-kanidm';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const APISERVER = 'https://kubernetes.default.svc';
// Kanidm admin(service-account API token) 자격 Secret
const KSVC_SECRET_NS = process.env.KSVC_SECRET_NS || 'opensphere-console';
const KSVC_SECRET_NAME = process.env.KSVC_SECRET_NAME || 'opensphere-identity-kanidm';
const DUPA_URL = process.env.DUPA_URL || 'http://opensphere-console-dupa-controller.opensphere-console.svc.cluster.local:8080';

// ── 호출자 검증(Kanidm 콘솔 id_token, ES256) — ADR-FND-003 ──
const DEFAULT_KANIDM_ISSUERS = [
  'https://localhost:8444/oauth2/openid/opensphere-console',
  'https://auth.console.opensphere.dev/oauth2/openid/opensphere-console',
];
const KANIDM_ISSUERS = (process.env.KANIDM_ISSUERS || process.env.KANIDM_ISS || DEFAULT_KANIDM_ISSUERS.join(','))
  .split(',').map((value) => value.trim()).filter(Boolean);
// Console id_token은 opensphere-console-auth BFF가 발급·서명한다. Kanidm core는 upstream identity만 제공한다.
const KANIDM_JWKS_URL = process.env.KANIDM_JWKS_URL || 'https://opensphere-console-auth.opensphere-console.svc:8443/oauth2/openid/opensphere-console/public_key.jwk';
const KANIDM_TLS_SERVERNAME = process.env.KANIDM_TLS_SERVERNAME || 'kanidm.opensphere-console-auth.svc';
const KANIDM_AZP = process.env.KANIDM_AZP || 'opensphere-console';
const KANIDM_CA_PATH = process.env.KANIDM_CA_PATH || '/etc/kanidm-ca/ca.crt';
const KANIDM_ADMIN_GROUP = process.env.KANIDM_ADMIN_GROUP || 'opensphere-console-admins';
const KANIDM_SELFSERVICE_URL = process.env.KANIDM_SELFSERVICE_URL || 'https://localhost:8444/ui';
// Every Console management surface asks the BFF for the live identity state.
// Signature verification is still local, but group claims alone may be stale
// after a user is disabled or demoted.
const TOKEN_INTROSPECTION_URL = process.env.TOKEN_INTROSPECTION_URL
  || 'https://opensphere-console-auth.opensphere-console.svc:8443/bff/token/introspect';
const TOKEN_INTROSPECTION_SERVERNAME = process.env.TOKEN_INTROSPECTION_SERVERNAME || KANIDM_TLS_SERVERNAME;
// AG-1(감사 시정): group 매핑은 '콘솔 역할 그룹'으로만 제한한다. 이 allowlist가 없으면 임의 그룹(UUID)에
// 멤버를 넣을 수 있어, 콘솔 관리자가 Kanidm 시스템 그룹(idm_admins 등)에 자신/타인을 추가해 IdP 슈퍼관리자로
// 상승할 수 있었다. BFF /bff/roles의 isConsoleRole()과 동일 경계를 이 경로에도 강제한다.
const CONSOLE_ROLE_GROUPS = new Set(
  (process.env.CONSOLE_ROLE_GROUPS || 'opensphere-console-admins,opensphere-console-operators,opensphere-console-viewers')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

function saToken() { return fs.readFileSync(`${SA}/token`, 'utf8').trim(); }
function b64d(s) { return Buffer.from(s, 'base64').toString('utf8'); }
function b64urlToBuf(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
let _kanidmCa;
function kanidmCa() {
  if (_kanidmCa === undefined) { try { _kanidmCa = fs.readFileSync(KANIDM_CA_PATH); } catch (e) { console.error('[kanidm] CA read failed: ' + e); _kanidmCa = null; } }
  return _kanidmCa;
}

// ── Kanidm admin 자격(서비스계정 API 토큰) — k8s Secret에서 런타임 조회(이미지에 비밀 없음) ──
let _kc = null;
async function loadKanidmConf() {
  const res = await fetch(`${APISERVER}/api/v1/namespaces/${KSVC_SECRET_NS}/secrets/${KSVC_SECRET_NAME}`, {
    headers: { Authorization: `Bearer ${saToken()}` },
  });
  if (!res.ok) throw new Error(`kanidm secret read HTTP ${res.status}`);
  const d = (await res.json()).data;
  return { url: b64d(d.url).replace(/\/$/, ''), token: b64d(d.token) };
}
async function kconf() { return (_kc ??= await loadKanidmConf()); }

// ── Kanidm REST 호출(https + EXPLICIT CA; undici fetch는 NODE_EXTRA_CA_CERTS=k8s CA라 self-signed Kanidm 불가) ──
function kreq(method, p, body) {
  return new Promise((resolve, reject) => {
    kconf().then((c) => {
      const u = new URL(c.url + p);
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
      const opts = {
        method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
        headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json',
          ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
        ca: kanidmCa(),
      };
      const rq = https.request(opts, (resp) => {
        const ch = []; resp.on('data', (x) => ch.push(x));
        resp.on('end', () => {
          const t = Buffer.concat(ch).toString('utf8');
          if (resp.statusCode >= 200 && resp.statusCode < 300) { try { resolve(t ? JSON.parse(t) : null); } catch { resolve(t); } }
          else reject(new Error(`kanidm ${method} ${p} HTTP ${resp.statusCode}: ${t.slice(0, 180)}`));
        });
      });
      rq.on('error', reject); if (data) rq.write(data); rq.end();
    }).catch(reject);
  });
}
const a1 = (at, k) => (at && at[k] && at[k][0]) || '';
const aN = (at, k) => (at && at[k]) || [];
const shortName = (spn) => String(spn).split('@')[0]; // name@domain -> name
const authErrorStatus = (error) => typeof error?.code === 'number' ? error.code : 502;

// ── governance gate: 호출자 토큰을 Kanidm JWKS(ES256)로 검증 (변경 없음) ──
let _kjwks = null, _kjwksAt = 0;
const KJWKS_TTL = 5 * 60 * 1000;
function _kanidmGetJwks(force) {
  return new Promise((resolve, reject) => {
    if (!force && _kjwks && (Date.now() - _kjwksAt) < KJWKS_TTL) return resolve(_kjwks);
    const u = new URL(KANIDM_JWKS_URL);
    const opts = { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', ca: kanidmCa(), servername: KANIDM_TLS_SERVERNAME };
    const rq = https.request(opts, (resp) => {
      const ch = []; resp.on('data', (c) => ch.push(c));
      resp.on('end', () => { try { const j = JSON.parse(Buffer.concat(ch).toString('utf8')); _kjwks = j.keys || (j.kty ? [j] : []); _kjwksAt = Date.now(); resolve(_kjwks); } catch (e) { reject(e); } });
    });
    rq.on('error', reject); rq.end();
  });
}

function introspectConsoleToken(jwt) {
  return new Promise((resolve, reject) => {
    const u = new URL(TOKEN_INTROSPECTION_URL);
    const body = Buffer.from(new URLSearchParams({ token: jwt }).toString());
    const request = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      ca: kanidmCa(),
      servername: TOKEN_INTROSPECTION_SERVERNAME,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': body.length,
        accept: 'application/json'
      }
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 64 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        if (size > 64 * 1024) return reject(new Error('token introspection response too large'));
        if (response.statusCode !== 200) return reject(new Error(`token introspection HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('token introspection returned invalid JSON')); }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error('token introspection timeout')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function assertLiveTokenState(claims, state) {
  if (!state || state.active !== true) throw { code: 401, msg: 'credential inactive or revoked' };
  if (state.sub !== claims.sub || state.username !== claims.preferred_username || state.exp !== claims.exp) {
    throw { code: 401, msg: 'credential state mismatch' };
  }
  if (claims.typ !== undefined) {
    if (!claims.jti || state.jti !== claims.jti || state.type !== claims.typ) {
      throw { code: 401, msg: 'managed credential state mismatch' };
    }
    if (claims.typ === 'cli_session' && state.deviceId !== claims.device_id) {
      throw { code: 401, msg: 'device state mismatch' };
    }
  }
}
async function verifyAuthed(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw { code: 401, msg: 'no bearer token' };
  const [h, p, s] = m[1].split('.');
  if (!h || !p || !s) throw { code: 401, msg: 'malformed token' };
  const header = JSON.parse(b64urlToBuf(h).toString());
  const claims = JSON.parse(b64urlToBuf(p).toString());
  const aud = Array.isArray(claims.aud) ? claims.aud : (claims.aud ? [claims.aud] : []);
  if (header.alg !== 'ES256') throw { code: 401, msg: 'unexpected alg' };
  let jwk = (await _kanidmGetJwks()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await _kanidmGetJwks(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw { code: 401, msg: 'unknown kid (kanidm)' };
  const pub = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = verify('SHA256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64urlToBuf(s));
  if (!ok) throw { code: 401, msg: 'bad signature' };
  if (!KANIDM_ISSUERS.includes(claims.iss)) throw { code: 401, msg: 'bad iss' };
  if (claims.azp !== KANIDM_AZP && !aud.includes(KANIDM_AZP)) throw { code: 401, msg: 'bad azp/aud' };
  // 재감사 P2-2: 필수 claim(exp·sub·iat) 부재 거부.
  if (!claims.exp) throw { code: 401, msg: 'missing exp' };
  if (!claims.sub) throw { code: 401, msg: 'missing sub' };
  if (!claims.iat) throw { code: 401, msg: 'missing iat' };
  const now = Date.now();
  if (claims.exp * 1000 < now) throw { code: 401, msg: 'token expired' };
  if (claims.nbf && claims.nbf * 1000 > now + 30000) throw { code: 401, msg: 'token not yet valid' };
  let state;
  try { state = await introspectConsoleToken(m[1]); }
  catch (error) { throw { code: 503, msg: `token introspection unavailable: ${error.message}` }; }
  assertLiveTokenState(claims, state);
  const groups = (state.groups || []).map((g) => shortName(g).replace(/^\//, ''));
  return { username: claims.preferred_username || 'unknown', groups };
}
async function verifyActor(req) {
  const a = await verifyAuthed(req);
  if (!a.groups.includes(KANIDM_ADMIN_GROUP)) throw { code: 403, msg: `not in ${KANIDM_ADMIN_GROUP}` };
  return a;
}

// ── audit (Backbone PostgreSQL 정본) ──
// 로컬 링은 화면 캐시일 뿐이다. 모든 IGA 쓰기는 DUPA의 TokenReview 게이트를 거쳐
// Backbone PostgreSQL append-only audit_log에 먼저 attempt를 기록한 뒤 실행한다.
const audit = [];
async function dupaRequest(pathname, options = {}) {
  const r = await fetch(DUPA_URL + pathname, { ...options, signal: AbortSignal.timeout(5000) });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}
async function requireBackbone() {
  const r = await dupaRequest('/readyz');
  if (!r.ok || r.body?.ready !== true) throw Object.assign(new Error('Backbone unavailable'), { code: 503 });
  return r.body;
}
async function publishAudit(e) {
  const r = await dupaRequest('/api/admin/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken()}`, 'content-type': 'application/json', 'x-os-correlation-id': e.opId },
    body: JSON.stringify({ source: 'opensphere-console-backend', userActor: e.actor, action: e.action, target: e.target, result: e.result, reason: e.reason }),
  });
  if (!r.ok) throw Object.assign(new Error('durable audit unavailable'), { code: r.status === 503 ? 503 : 502 });
}
async function logAudit(actor, action, target, result, reason, opId) {
  const e = { time: new Date().toISOString(), opId: opId || newOpId(), actor, action, target, result, reason: reason || '' };
  await publishAudit(e);
  audit.unshift(e);
  if (audit.length > 200) audit.pop();
  console.log('[audit] ' + JSON.stringify(e));
  return e;
}

// ── 읽기 집계 (Kanidm person/group) ──
async function identityPayload() {
  const [persons, groups] = await Promise.all([kreq('GET', '/v1/person'), kreq('GET', '/v1/group')]);
  const now = Date.now();
  const users = (persons || []).map((e) => {
    const at = e.attrs || {};
    const exp = a1(at, 'account_expire');
    const enabled = !exp || (Date.parse(exp) > now);
    const dn = a1(at, 'displayname'); const sp = dn.split(' ');
    return {
      id: a1(at, 'uuid'), username: a1(at, 'name'), email: a1(at, 'mail'), enabled,
      firstName: sp[0] || '', lastName: sp.slice(1).join(' ') || '', displayName: dn,
      groups: aN(at, 'memberof').map((g) => shortName(g).replace(/^\//, '')),
    };
  });
  const grps = (groups || []).map((e) => { const at = e.attrs || {}; const n = a1(at, 'name'); return { id: a1(at, 'uuid'), name: n, path: '/' + n }; });
  return {
    meta: { service: 'opensphere-identity', version: VERSION, servedBy: process.env.HOSTNAME || 'unknown', time: new Date().toISOString(), realm: 'kanidm:localhost', idp: 'kanidm', writeEnabled: true },
    users, groups: grps,
  };
}
// 쓰기용 uuid→name 해석(프론트는 uuid를 보냄; Kanidm _attr API는 name 사용)
async function personNameByUuid(uuid) { const ps = await kreq('GET', '/v1/person'); const e = (ps || []).find((x) => a1(x.attrs, 'uuid') === uuid); return e ? a1(e.attrs, 'name') : null; }
async function groupNameByUuid(uuid) { const gs = await kreq('GET', '/v1/group'); const e = (gs || []).find((x) => a1(x.attrs, 'uuid') === uuid); return e ? a1(e.attrs, 'name') : null; }
// Credential-reset links are high-impact secrets. They are short-lived and are
// never issued for a current Console administrator from the ordinary IGA flow.
const ONBOARDING_TTL_SECONDS = 3600;
async function onboardingLink(uname, ttl = ONBOARDING_TTL_SECONDS) {
  try {
    const intent = await kreq('GET', `/v1/person/${uname}/_credential/_update_intent/${ttl}`);
    const token = (typeof intent === 'string' ? intent : (intent && (intent.token || intent.intent_token)) || (Array.isArray(intent) ? intent[0] : '')) || '';
    return token ? `/ui/reset?token=${encodeURIComponent(token)}` : '';
  } catch (e) { console.error('[onboarding intent]', String(e).slice(0, 160)); return ''; }
}
async function isConsoleAdministrator(uname) {
  const person = await kreq('GET', `/v1/person/${uname}`);
  if (!person?.attrs) throw new Error('live administrator membership lookup failed');
  return aN(person?.attrs, 'memberof').map((group) => shortName(group).replace(/^\//, ''))
    .includes(KANIDM_ADMIN_GROUP);
}

async function readBody(req) { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > MAX_BODY) throw { code: 413, msg: 'payload too large' }; chunks.push(c); } const s = Buffer.concat(chunks).toString(); return s ? JSON.parse(s) : {}; }
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

// ── 흡수: catalog 엔진 (구 opensphere-catalog-api) — nginx /api/rhdh→/api/catalog. OpenSphere CRD→kind=API, Deployment→kind=Component ──
const COMP_NS = (process.env.COMPONENT_NAMESPACES || 'opensphere-console,opensphere-console,opensphere-console-auth').split(',');
async function kget(p2) { // kube API GET (SA token; NODE_EXTRA_CA_CERTS가 kube CA 신뢰)
  const r = await fetch(`${APISERVER}${p2}`, { headers: { Authorization: `Bearer ${saToken()}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${p2} HTTP ${r.status}`);
  return r.json();
}
async function apiEntities() {
  const out = []; const crds = await kget('/apis/apiextensions.k8s.io/v1/customresourcedefinitions');
  for (const crd of crds.items || []) {
    const g = crd.spec.group || ''; if (!/(^|\.)opensphere\.io$/.test(g)) continue;
    const v = (crd.spec.versions || []).find((x) => x.served) || crd.spec.versions?.[0] || {}; const kind = crd.spec.names.kind;
    out.push({ kind: 'API', metadata: { name: kind, namespace: 'default', uid: crd.metadata.uid, description: `${kind} — ${g}/${v.name} (OpenSphere CRD, scope=${crd.spec.scope})` },
      spec: { type: 'kubernetes-crd', owner: g.split('.')[0], lifecycle: 'production', system: g, definition: v.schema?.openAPIV3Schema ? JSON.stringify(v.schema.openAPIV3Schema, null, 2) : '' } });
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}
async function componentEntities() {
  const out = [];
  for (const ns of COMP_NS) { let deps; try { deps = await kget(`/apis/apps/v1/namespaces/${ns}/deployments`); } catch { continue; }
    for (const d of deps.items || []) out.push({ kind: 'Component', metadata: { name: d.metadata.name, namespace: ns, uid: d.metadata.uid, description: `Deployment · ${ns} (replicas ${d.status?.availableReplicas ?? 0}/${d.spec?.replicas ?? 0})` }, spec: { type: 'service', owner: 'platform', lifecycle: 'production', system: ns } });
  }
  return out.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}
async function catalogEntities(filter) {
  if (/kind=api/i.test(filter || '')) return apiEntities();
  const [a, c] = await Promise.all([apiEntities(), componentEntities()]); return [...a, ...c];
}

// ── /metrics (Prometheus exposition, 의존성 0; 클러스터 내부 전용 — nginx 미라우팅) ──
// 공유 관측 계층(k8s basic stack / prometheus-stack)이 ServiceMonitor로 scrape. docs/OBSERVABILITY-ARCHITECTURE.md.
let _httpReqs = 0;
function metricsText() {
  const mu = process.memoryUsage();
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
    '# HELP process_resident_memory_bytes Resident memory size in bytes.',
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${mu.rss}`,
    '# HELP nodejs_heap_used_bytes Node.js heap used in bytes.',
    '# TYPE nodejs_heap_used_bytes gauge',
    `nodejs_heap_used_bytes ${mu.heapUsed}`,
    '# HELP process_uptime_seconds Process uptime in seconds.',
    '# TYPE process_uptime_seconds gauge',
    `process_uptime_seconds ${Math.round(process.uptime())}`,
  ].join('\n') + '\n';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  _httpReqs++;
  try {
    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (p === '/readyz') {
      try { return json(res, 200, await requireBackbone()); }
      catch { return json(res, 503, { ready: false, required: true, error: 'Backbone unavailable' }); }
    }
    if (p === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); return res.end(metricsText()); }
    // ── 흡수: catalog 라우트 ──
    // 감사 누락(B): 읽기도 인증 필수(무인증 PII/토폴로지 노출 차단). 콘솔 전 사용자는 로그인되어
    // id_token 보유 → verifyAuthed(인증)면 충분(admin 불요). 비로그인 curl 등은 401.
    if (p === '/api/catalog/entities' && req.method === 'GET') {
      try { await verifyAuthed(req); } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' }); }
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
      try { await verifyActor(req); } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' }); }
      const r = await dupaRequest('/api/admin/plugins/events', { headers: { Authorization: req.headers.authorization || '' } });
      return r.ok ? json(res, 200, r.body) : json(res, r.status || 502, { error: 'durable audit unavailable' });
    }

    // 본인 비밀번호: Kanidm은 셀프서비스 UI(credential update session)에서 변경 — 관리 API 단순 reset 없음.
    if (p === '/api/identity/me/password' && req.method === 'POST') {
      let me; try { me = await verifyAuthed(req); } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' }); }
      try { await requireBackbone(); await logAudit(me.username, 'self-password-change', me.username, 'redirected', 'kanidm self-service'); }
      catch { return json(res, 503, { error: 'Backbone audit unavailable' }); }
      return json(res, 200, { ok: false, selfServiceUrl: KANIDM_SELFSERVICE_URL, note: `Kanidm 셀프서비스(${KANIDM_SELFSERVICE_URL})에서 비밀번호/패스키를 변경하세요.` });
    }

    // ── 계정 생성(IGA): governance gate + reason + audit. 신규 계정은 어떤 그룹에도 속하지 않는다(권한 상승 없음). ──
    // 온보딩 = Kanidm credential update intent 토큰 → 콘솔 same-origin /ui/reset 링크로 사용자가 직접 비번/패스키 설정.
    if (p === '/api/identity/users' && req.method === 'POST') {
      let actor; try { actor = await verifyActor(req); } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' }); }
      const body = await readBody(req).catch(() => ({}));
      const username = String(body.username || '').trim().toLowerCase();
      const displayName = String(body.displayName || '').trim();
      const email = String(body.email || '').trim();
      const reason = String(body.reason || '').trim();
      if (!reason) return json(res, 400, { error: 'reason 필수 (IGA)' });
      // AG-6: 입력 검증 — Kanidm name 규칙(소문자 시작), displayName 필수, email 형식.
      if (!/^[a-z][a-z0-9._-]{1,62}$/.test(username)) return json(res, 400, { error: 'username 형식 오류 (소문자로 시작, a-z0-9._- 2~63자)' });
      if (!displayName) return json(res, 400, { error: 'displayName 필수' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'email 형식 오류' });
      // AG-1: 생성 시 역할 부여는 콘솔 역할 그룹으로만 제한(임의/시스템 그룹 차단).
      const roles = Array.isArray(body.roles) ? [...new Set(body.roles.map((r) => String(r).trim()).filter(Boolean))] : [];
      for (const g of roles) { if (!CONSOLE_ROLE_GROUPS.has(g)) return json(res, 400, { error: `허용되지 않은 역할 그룹: ${g}` }); }
      // An administrator must first finish an ordinary user enrollment and then
      // be promoted by another administrator. An admin reset link is an account
      // takeover primitive and cannot be produced by this self-service path.
      if (roles.includes(KANIDM_ADMIN_GROUP)) {
        return json(res, 409, { error: '관리자 역할은 일반 사용자 온보딩 완료 후 별도 권한 부여로 처리하세요' });
      }
      try { await requireBackbone(); await logAudit(actor.username, 'iga-create-user', username, 'attempt', `${reason}${roles.length ? ' · roles=' + roles.join(',') : ''}`); }
      catch { return json(res, 503, { error: 'Backbone audit unavailable' }); }
      try {
        const existing = await kreq('GET', `/v1/person/${username}`).catch(() => null);
        if (existing) { await logAudit(actor.username, 'create-user', username, 'denied', 'already exists'); return json(res, 409, { error: '이미 존재하는 사용자명입니다' }); }
        const attrs = { name: [username], displayname: [displayName] };
        if (email) attrs.mail = [email];
        await kreq('POST', '/v1/person', { attrs });
        // AG-1/AG-2: 선택 역할을 allowlist·감사 경유로 부여. admin 역할은 강조 감사(ok-admin-change).
        const assigned = [];
        for (const g of roles) {
          try {
            await kreq('POST', `/v1/group/${g}/_attr/member`, [username]);
            await logAudit(actor.username, 'group-add', `${username}:${g}`, g === KANIDM_ADMIN_GROUP ? 'ok-admin-change' : 'ok', reason);
            assigned.push(g);
          } catch (e) { console.error('[role assign]', g, String(e).slice(0, 160)); await logAudit(actor.username, 'group-add', `${username}:${g}`, 'error', reason); }
        }
        const onboardingPath = await onboardingLink(username);
        await logAudit(actor.username, 'create-user', username, 'ok', `${reason}${assigned.length ? ' · roles=' + assigned.join(',') : ''}`);
        const note = assigned.length
          ? `계정을 생성하고 역할(${assigned.join(', ')})을 부여했습니다. 온보딩 링크를 전달해 비밀번호/패스키를 설정하게 하세요.`
          : '신규 계정은 어떤 그룹에도 속하지 않습니다. 온보딩 링크를 전달하고, 필요한 역할은 역할 화면에서 부여하세요.';
        return json(res, 201, { ok: true, username, roles: assigned, onboardingPath, note });
      } catch (e) {
        console.error('[err] create user:', e);
        try { await logAudit(actor.username, 'create-user', username, 'error', reason); } catch { /* attempt는 이미 기록됨 */ }
        return json(res, 502, { error: 'upstream error (Kanidm 쓰기 권한/연결 확인)' });
      }
    }

    // 온보딩 링크 재발급 — 기존 사용자에게 새 credential update intent를 발급(비번 분실·재온보딩).
    const mOnboard = p.match(/^\/api\/identity\/users\/([0-9a-fA-F-]+)\/onboarding$/);
    if (mOnboard && req.method === 'POST') {
      let actor; try { actor = await verifyActor(req); } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' }); }
      const body = await readBody(req).catch(() => ({}));
      if (!body.reason || !String(body.reason).trim()) return json(res, 400, { error: 'reason 필수 (IGA)' });
      try { await requireBackbone(); await logAudit(actor.username, 'iga-onboarding-link', p, 'attempt', body.reason); }
      catch { return json(res, 503, { error: 'Backbone audit unavailable' }); }
      try {
        const uname = await personNameByUuid(mOnboard[1]);
        if (!uname) return json(res, 404, { error: 'person not found' });
        if (await isConsoleAdministrator(uname)) {
          await logAudit(actor.username, 'onboarding-link', uname, 'denied', 'administrator target requires a separate recovery approval');
          return json(res, 403, { error: '관리자 계정의 credential reset은 별도 복구 승인 절차를 사용해야 합니다' });
        }
        const onboardingPath = await onboardingLink(uname);
        await logAudit(actor.username, 'onboarding-link', uname, onboardingPath ? 'ok' : 'error', body.reason);
        return json(res, 200, { ok: true, username: uname, onboardingPath });
      } catch (e) {
        console.error('[err] onboarding link:', e);
        try { await logAudit(actor.username, 'onboarding-link', mOnboard[1], 'error', body.reason); } catch { /* attempt 기록됨 */ }
        return json(res, 502, { error: 'upstream error' });
      }
    }

    // 속성 편집(IGA) — 표시이름/이메일 갱신. displayname은 비울 수 없고, email은 비우면 제거.
    const mAttrs = p.match(/^\/api\/identity\/users\/([0-9a-fA-F-]+)\/attrs$/);
    if (mAttrs && req.method === 'POST') {
      let actor; try { actor = await verifyActor(req); } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' }); }
      const body = await readBody(req).catch(() => ({}));
      if (!body.reason || !String(body.reason).trim()) return json(res, 400, { error: 'reason 필수 (IGA)' });
      const displayName = body.displayName !== undefined ? String(body.displayName).trim() : undefined;
      const email = body.email !== undefined ? String(body.email).trim() : undefined;
      if (displayName === undefined && email === undefined) return json(res, 400, { error: '변경할 속성이 없습니다' });
      if (displayName !== undefined && !displayName) return json(res, 400, { error: 'displayName은 비울 수 없습니다' });
      if (email) { if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'email 형식 오류' }); }
      try { await requireBackbone(); await logAudit(actor.username, 'iga-update-attrs', p, 'attempt', body.reason); }
      catch { return json(res, 503, { error: 'Backbone audit unavailable' }); }
      try {
        const uname = await personNameByUuid(mAttrs[1]);
        if (!uname) return json(res, 404, { error: 'person not found' });
        if (displayName !== undefined) await kreq('PUT', `/v1/person/${uname}/_attr/displayname`, [displayName]);
        if (email !== undefined) {
          if (email) await kreq('PUT', `/v1/person/${uname}/_attr/mail`, [email]);
          else await kreq('DELETE', `/v1/person/${uname}/_attr/mail`);
        }
        await logAudit(actor.username, 'update-attrs', uname, 'ok', body.reason);
        return json(res, 200, { ok: true, username: uname });
      } catch (e) {
        console.error('[err] update attrs:', e);
        try { await logAudit(actor.username, 'update-attrs', mAttrs[1], 'error', body.reason); } catch { /* attempt 기록됨 */ }
        return json(res, 502, { error: 'upstream error' });
      }
    }

    // ── 쓰기(IGA): governance gate + reason + audit ──
    const mEnable = p.match(/^\/api\/identity\/users\/([0-9a-fA-F-]+)\/enabled$/);
    const mGroup = p.match(/^\/api\/identity\/users\/([0-9a-fA-F-]+)\/group$/);
    if ((mEnable || mGroup) && req.method === 'POST') {
      let actor; try { actor = await verifyActor(req); } catch (e) { return json(res, authErrorStatus(e), { error: e.msg || 'auth backend unavailable' }); }
      const body = await readBody(req).catch(() => ({}));
      if (!body.reason || !String(body.reason).trim()) return json(res, 400, { error: 'reason 필수 (IGA)' });
      try {
        await requireBackbone();
        await logAudit(actor.username, 'iga-mutation', p, 'attempt', body.reason);
      } catch { return json(res, 503, { error: 'Backbone audit unavailable' }); }
      try {
        if (mEnable) {
          const uname = await personNameByUuid(mEnable[1]);
          if (!uname) return json(res, 404, { error: 'person not found' });
          const enabled = !!body.enabled;
          if (enabled) await kreq('DELETE', `/v1/person/${uname}/_attr/account_expire`);
          else await kreq('PUT', `/v1/person/${uname}/_attr/account_expire`, ['1970-01-01T00:00:00+00:00']);
          await logAudit(actor.username, enabled ? 'enable-user' : 'disable-user', uname, 'ok', body.reason);
          return json(res, 200, { ok: true });
        } else {
          const uname = await personNameByUuid(mGroup[1]);
          // 콘솔 역할은 이름(body.group)으로 직접 지정 가능 — 아래 allowlist가 검증하므로 안전. 그 외는 groupId(uuid) 해석.
          const gname = body.group ? String(body.group).trim() : await groupNameByUuid(body.groupId);
          const op = body.op;
          if (!uname || !gname || !['add', 'remove'].includes(op)) return json(res, 400, { error: 'group/op 또는 대상 해석 실패' });
          // AG-1: 콘솔 역할 그룹만 매핑 허용 — 임의/시스템 그룹(idm_admins 등)으로의 escalation 차단.
          if (!CONSOLE_ROLE_GROUPS.has(gname)) {
            await logAudit(actor.username, `group-${op}`, `${uname}:${gname}`, 'denied', 'not a console role group (AG-1)');
            return json(res, 403, { error: '콘솔 역할 그룹만 매핑할 수 있습니다', group: gname });
          }
          // AG-2: admin 그룹은 본인이 본인에게 직접 부여/회수할 수 없다(자가 상승·자가 잠금 방지, 직무분리 최소통제).
          if (gname === KANIDM_ADMIN_GROUP && uname === actor.username) {
            await logAudit(actor.username, `group-${op}`, `${uname}:${gname}`, 'denied', 'self admin change blocked (AG-2)');
            return json(res, 403, { error: 'admin 권한은 본인에게 직접 변경할 수 없습니다(직무분리)' });
          }
          await kreq(op === 'add' ? 'POST' : 'DELETE', `/v1/group/${gname}/_attr/member`, [uname]);
          await logAudit(actor.username, `group-${op}`, `${uname}:${gname}`, gname === KANIDM_ADMIN_GROUP ? 'ok-admin-change' : 'ok', body.reason);
          return json(res, 200, { ok: true });
        }
      } catch (e) {
        console.error('[err] iga write:', e); // 감사 F: 상세는 서버 로그, 클라이언트엔 일반 메시지.
        try { await logAudit(actor.username, mEnable ? 'enable-toggle' : 'group-change', (mEnable || mGroup)[1], 'error', body.reason); } catch { /* attempt는 이미 내구 기록됨 */ }
        return json(res, 502, { error: 'upstream error' });
      }
    }

    // ── 플러그인 정적 서빙 ──
    if (p === '/plugins' || p === '/plugins/') {
      const files = fs.existsSync(PLUGIN_DIR) ? fs.readdirSync(PLUGIN_DIR).filter((f) => !f.startsWith('.')) : [];
      return json(res, 200, { plugins: files });
    }
    if (p.startsWith('/plugins/')) {
      const file = path.basename(p); const fp = path.join(PLUGIN_DIR, file);
      if (file && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        const mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
        const stream = fs.createReadStream(fp);
        stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end('read error'); });
        stream.once('open', () => res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' }));
        return stream.pipe(res, { end: true });
      }
      res.writeHead(404); return res.end('plugin not found');
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { console.error('[err]', e); if (!res.headersSent) json(res, e && e.code === 413 ? 413 : 500, { error: e && e.code === 413 ? 'payload too large' : 'internal error' }); }
});

server.listen(PORT, () => console.log(`opensphere-console-backend v${VERSION} listening :${PORT} (identity IGA + catalog 흡수)`));

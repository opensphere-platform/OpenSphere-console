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
const { createPublicKey, verify } = require('crypto');

const PORT = process.env.PORT || 8080;
const PLUGIN_DIR = process.env.PLUGIN_DIR || '/plugins';
const VERSION = process.env.APP_VERSION || '0.3.0-kanidm';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const APISERVER = 'https://kubernetes.default.svc';
// Kanidm admin(service-account API token) 자격 Secret
const KSVC_SECRET_NS = process.env.KSVC_SECRET_NS || 'opensphere-system';
const KSVC_SECRET_NAME = process.env.KSVC_SECRET_NAME || 'opensphere-identity-kanidm';

// ── 호출자 검증(Kanidm 콘솔 id_token, ES256) — ADR-FND-003 ──
const KANIDM_ISS = process.env.KANIDM_ISS || 'https://localhost:8444/oauth2/openid/opensphere-console';
const KANIDM_JWKS_URL = process.env.KANIDM_JWKS_URL || 'https://opensphere-console-auth.opensphere-console-auth.svc:8443/oauth2/openid/opensphere-console/public_key.jwk';
const KANIDM_AZP = process.env.KANIDM_AZP || 'opensphere-console';
const KANIDM_CA_PATH = process.env.KANIDM_CA_PATH || '/etc/kanidm-ca/ca.crt';
const KANIDM_ADMIN_GROUP = process.env.KANIDM_ADMIN_GROUP || 'opensphere-console-admins';
const KANIDM_SELFSERVICE_URL = process.env.KANIDM_SELFSERVICE_URL || 'https://localhost:8444/ui';

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

// ── governance gate: 호출자 토큰을 Kanidm JWKS(ES256)로 검증 (변경 없음) ──
let _kjwks = null, _kjwksAt = 0;
const KJWKS_TTL = 5 * 60 * 1000;
function _kanidmGetJwks(force) {
  return new Promise((resolve, reject) => {
    if (!force && _kjwks && (Date.now() - _kjwksAt) < KJWKS_TTL) return resolve(_kjwks);
    const u = new URL(KANIDM_JWKS_URL);
    const opts = { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', ca: kanidmCa() };
    const rq = https.request(opts, (resp) => {
      const ch = []; resp.on('data', (c) => ch.push(c));
      resp.on('end', () => { try { const j = JSON.parse(Buffer.concat(ch).toString('utf8')); _kjwks = j.keys || (j.kty ? [j] : []); _kjwksAt = Date.now(); resolve(_kjwks); } catch (e) { reject(e); } });
    });
    rq.on('error', reject); rq.end();
  });
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
  if (claims.iss !== KANIDM_ISS) throw { code: 401, msg: 'bad iss' };
  if (claims.azp !== KANIDM_AZP && !aud.includes(KANIDM_AZP)) throw { code: 401, msg: 'bad azp/aud' };
  const now = Date.now();
  if (claims.exp && claims.exp * 1000 < now) throw { code: 401, msg: 'token expired' };
  if (claims.nbf && claims.nbf * 1000 > now + 30000) throw { code: 401, msg: 'token not yet valid' };
  const groups = (claims.groups || []).map((g) => shortName(g).replace(/^\//, ''));
  return { username: claims.preferred_username || 'unknown', groups };
}
async function verifyActor(req) {
  const a = await verifyAuthed(req);
  if (!a.groups.includes(KANIDM_ADMIN_GROUP)) throw { code: 403, msg: `not in ${KANIDM_ADMIN_GROUP}` };
  return a;
}

// ── audit (PoC: 메모리) ──
const audit = [];
function logAudit(actor, action, target, result, reason) {
  audit.unshift({ time: new Date().toISOString(), actor, action, target, result, reason: reason || '' });
  if (audit.length > 200) audit.pop();
  console.log(`[audit] ${actor} ${action} ${target} -> ${result}${reason ? ' (' + reason + ')' : ''}`);
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

async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); const s = Buffer.concat(chunks).toString(); return s ? JSON.parse(s) : {}; }
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (p === '/api/identity' && req.method === 'GET') return json(res, 200, await identityPayload());
    if (p === '/api/identity/audit' && req.method === 'GET') {
      try { await verifyActor(req); } catch (e) { return json(res, e.code || 401, { error: e.msg || String(e) }); }
      return json(res, 200, { items: audit });
    }

    // 본인 비밀번호: Kanidm은 셀프서비스 UI(credential update session)에서 변경 — 관리 API 단순 reset 없음.
    if (p === '/api/identity/me/password' && req.method === 'POST') {
      let me; try { me = await verifyAuthed(req); } catch (e) { return json(res, e.code || 401, { error: e.msg || String(e) }); }
      logAudit(me.username, 'self-password-change', me.username, 'redirected', 'kanidm self-service');
      return json(res, 200, { ok: false, selfServiceUrl: KANIDM_SELFSERVICE_URL, note: `Kanidm 셀프서비스(${KANIDM_SELFSERVICE_URL})에서 비밀번호/패스키를 변경하세요.` });
    }

    // ── 쓰기(IGA): governance gate + reason + audit ──
    const mEnable = p.match(/^\/api\/identity\/users\/([0-9a-fA-F-]+)\/enabled$/);
    const mGroup = p.match(/^\/api\/identity\/users\/([0-9a-fA-F-]+)\/group$/);
    if ((mEnable || mGroup) && req.method === 'POST') {
      let actor; try { actor = await verifyActor(req); } catch (e) { return json(res, e.code || 401, { error: e.msg || String(e) }); }
      const body = await readBody(req).catch(() => ({}));
      if (!body.reason || !String(body.reason).trim()) return json(res, 400, { error: 'reason 필수 (IGA)' });
      try {
        if (mEnable) {
          const uname = await personNameByUuid(mEnable[1]);
          if (!uname) return json(res, 404, { error: 'person not found' });
          const enabled = !!body.enabled;
          if (enabled) await kreq('DELETE', `/v1/person/${uname}/_attr/account_expire`);
          else await kreq('PUT', `/v1/person/${uname}/_attr/account_expire`, ['1970-01-01T00:00:00+00:00']);
          logAudit(actor.username, enabled ? 'enable-user' : 'disable-user', uname, 'ok', body.reason);
          return json(res, 200, { ok: true });
        } else {
          const uname = await personNameByUuid(mGroup[1]);
          const gname = await groupNameByUuid(body.groupId);
          const op = body.op;
          if (!uname || !gname || !['add', 'remove'].includes(op)) return json(res, 400, { error: 'groupId/op 또는 대상 해석 실패' });
          await kreq(op === 'add' ? 'POST' : 'DELETE', `/v1/group/${gname}/_attr/member`, [uname]);
          logAudit(actor.username, `group-${op}`, `${uname}:${gname}`, 'ok', body.reason);
          return json(res, 200, { ok: true });
        }
      } catch (e) {
        logAudit(actor.username, mEnable ? 'enable-toggle' : 'group-change', (mEnable || mGroup)[1], 'error', body.reason);
        return json(res, 500, { error: String(e) });
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
  } catch (e) { json(res, 500, { error: String(e) }); }
});

server.listen(PORT, () => console.log(`opensphere-identity v${VERSION} listening :${PORT} (Kanidm IGA)`));

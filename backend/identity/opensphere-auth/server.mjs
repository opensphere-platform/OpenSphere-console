// opensphere-auth — a Kanidm-backed OIDC issuer (BFF) that makes the console and Kanidm
// look and behave as one product. It owns the browser-facing OIDC endpoints AND the whole
// human surface (login, logout, account onboarding / credential setup) in the console's own
// Carbon design, authenticating against the internal Kanidm via REST. Kanidm's native /ui
// (the crab portal) is hidden — every /ui/* path is redirected to the console or handled here.
// All other paths (/v1/*, /status …) are reverse-proxied to Kanidm so existing flows keep working.
//
// The id_token it mints is byte-compatible with what the console plugins verify (ES256,
// iss=https://localhost:8444/oauth2/openid/opensphere-console, aud/azp=opensphere-console,
// groups) so neither the shell nor the plugins need changes.
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { URL, URLSearchParams } from 'node:url';
import QRCode from 'qrcode';
import { DEFAULT_TOTP_ENABLED, authPolicyFromConfigMap, authPolicyPatch } from './auth-policy.mjs';
import { isActivePat, verifyEs256Jwt } from './token-verifier.mjs';

// ---- config ----
const PORT = parseInt(process.env.PORT || '8443', 10);
const ISSUER = process.env.OIDC_ISSUER || 'https://localhost:8444/oauth2/openid/opensphere-console';
const ORIGIN = new URL(ISSUER).origin;
const CLIENT_ID = process.env.OIDC_CLIENT_ID || 'opensphere-console';
const CONSOLE_URL = process.env.CONSOLE_URL || 'https://localhost:8090/';
const REDIRECT_ALLOW = (process.env.OIDC_REDIRECT_URIS || 'https://localhost:8090/').split(',').map((value) => value.trim()).filter(Boolean);
const CORS_ORIGINS = new Set(REDIRECT_ALLOW.map((value) => new URL(value).origin));
const ADMIN_GROUP = process.env.KANIDM_ADMIN_GROUP || 'opensphere-console-admins';
// 콘솔 접근 = 어떤 콘솔 역할이든(admins/operators/viewers…). 역할별 가시성은 셸이 그룹으로 판단(Phase 3b).
const CONSOLE_GROUP_PREFIX = process.env.CONSOLE_GROUP_PREFIX || 'opensphere-console-';
const KANIDM_CORE_URL = (process.env.KANIDM_CORE_URL || 'https://kanidm-core.opensphere-console-auth.svc:8443').replace(/\/$/, '');
const KANIDM_SNI = process.env.KANIDM_SNI || 'kanidm.opensphere-console-auth.svc';
const KANIDM_CA_PATH = process.env.KANIDM_CA_PATH || '/certs/tls.crt';
const TLS_CERT = process.env.TLS_CERT_PATH || '/certs/tls.crt';
const TLS_KEY = process.env.TLS_KEY_PATH || '/certs/tls.key';
const SIG_KEY_PATH = process.env.SIG_KEY_PATH || '/keys/sig.key';
const APISERVER = process.env.APISERVER || 'https://kubernetes.default.svc';
const KSVC_SECRET_NS = process.env.KSVC_SECRET_NS || 'opensphere-system';
const KSVC_SECRET_NAME = process.env.KSVC_SECRET_NAME || 'opensphere-identity-kanidm';
const AUTH_CODE_SECRET_NAME = process.env.AUTH_CODE_SECRET_NAME || 'opensphere-auth-codes';

const PATH_BASE = '/oauth2/openid/opensphere-console';
const EP = {
  discovery: `${PATH_BASE}/.well-known/openid-configuration`,
  jwks: `${PATH_BASE}/public_key.jwk`,
  authorize: `${PATH_BASE}/authorize`,
  token: `${PATH_BASE}/token`,
};

let _kanidmCa;
function kanidmCa() {
  if (_kanidmCa === undefined) { try { _kanidmCa = fs.readFileSync(KANIDM_CA_PATH); } catch (e) { console.error('[bff] CA read failed:', e.message); _kanidmCa = null; } }
  return _kanidmCa;
}

// ---- ES256 signing key: a persisted Secret is mandatory. Never mint sessions with an ephemeral key. ----
let privateKey, publicKey;
try {
  privateKey = crypto.createPrivateKey(fs.readFileSync(SIG_KEY_PATH));
  publicKey = crypto.createPublicKey(privateKey);
  console.log('[bff] loaded persisted signing key from', SIG_KEY_PATH);
} catch (error) {
  throw new Error(`[bff] persisted signing key is required at ${SIG_KEY_PATH}`, { cause: error });
}
const jwkPub = publicKey.export({ format: 'jwk' });
const KID = crypto.createHash('sha256').update(jwkPub.x + jwkPub.y).digest('hex').slice(0, 12);
jwkPub.alg = 'ES256'; jwkPub.use = 'sig'; jwkPub.kid = KID;
const JWKS = { keys: [jwkPub] };

const b64url = (input) => Buffer.from(input).toString('base64url');
function signJWT(payload) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: KID, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = crypto.sign('SHA256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64url(sig)}`;
}
function base32(bytes) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0, out = '';
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}

// ---- Kanidm REST helpers (internal Kanidm core) ----
function kanidmReq(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(KANIDM_CORE_URL + path);
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const opts = { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, servername: KANIDM_SNI, ca: kanidmCa(),
      headers: { accept: 'application/json', ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } };
    const rq = https.request(opts, (resp) => {
      const ch = []; resp.on('data', (c) => ch.push(c));
      resp.on('end', () => { const txt = Buffer.concat(ch).toString('utf8'); let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {} resolve({ status: resp.statusCode, sid: resp.headers['x-kanidm-auth-session-id'], json, txt }); });
    });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
}
// credential-update (CU) helpers — exchange/update/commit need no admin token (CU session is the auth)
const cuExchange = (token) => kanidmReq('POST', '/v1/credential/_exchange_intent', token);   // token=string -> quoted JSON body
const cuUpdate = (request, session) => kanidmReq('POST', '/v1/credential/_update', [request, session]);
const cuCommit = (session) => kanidmReq('POST', '/v1/credential/_commit', session);

// Password login is the development default. When the managed policy is enabled,
// password-only accounts must enroll TOTP before they can enter the Console.
async function kanidmAuthenticate(username, password, totp, totpPolicyEnabled) {
  let r = await kanidmReq('POST', '/v1/auth', { step: { init: username } });
  if (r.status !== 200 || !r.sid) throw { reason: 'Unknown user or auth unavailable.' };
  const H = { 'x-kanidm-auth-session-id': r.sid };
  const mechs = r.json?.state?.choose || [];
  // dev: password-only 계정(mech 'password')도 수용 — TOTP 비활성 계정 로그인 허용. TOTP 있으면 아래 cont에서 요구.
  const mech = mechs.includes('passwordmfa') ? 'passwordmfa' : mechs.includes('password') ? 'password' : null;
  if (!mech) throw { reason: `Unsupported auth mechanism (${mechs.join(',') || 'none'}).` };
  if (totpPolicyEnabled && mech !== 'passwordmfa') {
    throw { reason: 'TOTP is enabled for Console login. Re-enroll this account from a credential-reset token.' };
  }
  r = await kanidmReq('POST', '/v1/auth', { step: { begin: mech } }, H);
  let cont = r.json?.state?.continue || [];
  if (cont.includes('totp')) {
    const code = parseInt(String(totp).replace(/\s+/g, ''), 10);
    if (!Number.isInteger(code)) throw { reason: 'Enter your 6-digit authenticator code.', requiresTotp: true };
    r = await kanidmReq('POST', '/v1/auth', { step: { cred: { totp: code } } }, H);
    if (r.json?.state?.denied) throw { reason: 'Invalid authenticator code.', requiresTotp: true };
  }
  r = await kanidmReq('POST', '/v1/auth', { step: { cred: { password } } }, H);
  if (!r.json?.state?.success) throw { reason: 'Invalid credentials.' };
  return JSON.parse(Buffer.from(r.json.state.success.split('.')[1], 'base64url').toString('utf8'));
}

// ---- admin SA token + group lookup ----
const saToken = () => fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
let _adminTok = null;
async function adminToken() {
  if (_adminTok) return _adminTok;
  const u = new URL(`${APISERVER}/api/v1/namespaces/${KSVC_SECRET_NS}/secrets/${KSVC_SECRET_NAME}`);
  const out = await new Promise((resolve, reject) => {
    const rq = https.request({ method: 'GET', hostname: u.hostname, port: u.port || 443, path: u.pathname,
      ca: (() => { try { return fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'); } catch { return undefined; } })(),
      headers: { authorization: `Bearer ${saToken()}` } }, (resp) => { const ch = []; resp.on('data', (c) => ch.push(c)); resp.on('end', () => resolve({ status: resp.statusCode, txt: Buffer.concat(ch).toString('utf8') })); });
    rq.on('error', reject); rq.end();
  });
  if (out.status !== 200) throw new Error(`secret read HTTP ${out.status}`);
  _adminTok = Buffer.from(JSON.parse(out.txt).data.token, 'base64').toString('utf8');
  return _adminTok;
}
async function lookupGroups(username) {
  const tok = await adminToken();
  const r = await kanidmReq('GET', `/v1/person/${encodeURIComponent(username)}`, undefined, { authorization: `Bearer ${tok}` });
  return (r.json?.attrs?.memberof || []).map((g) => String(g).split('@')[0]).filter((g) => !g.startsWith('idm_'));
}

// Authorization codes are stored in a shared Secret below. A pod-local Map breaks
// whenever authorize and token requests are balanced to different BFF replicas.

// ---- login surface: self-contained 2-panel composition (DESIGN-console-template layout,
// OpenSphere palette, zero design-system dependency — a branded standalone page). ----
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CSS = `:root{--blue:#4c6fff;--blue-h:#3a5af0;--ink:#1b2438;--muted:#667193;--surface:#f6f7fb;--layer:#fff;--line:#e0e3ea;--field:#8a93ab;--accent:#00bfa5}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font-family:"IBM Plex Sans","Avenir Next",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:var(--layer);-webkit-font-smoothing:antialiased}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
.hd{display:flex;align-items:center;gap:1.8rem;height:3rem;padding:0 1.5rem;background:var(--layer);border-bottom:1px solid var(--line)}
.hd .brand{font-size:.95rem;color:var(--ink)}.hd .brand b{font-weight:600}
.hd nav{display:flex;gap:1.4rem;font-size:.82rem}.hd nav a{color:var(--muted)}.hd nav a:hover{color:var(--ink);text-decoration:none}
.app{display:flex;min-height:calc(100vh - 3rem)}
.col{flex:0 0 33rem;max-width:100%;display:flex;flex-direction:column;justify-content:space-between;padding:4.5rem 4rem 1.5rem;background:var(--layer)}
.col .area{flex:1 1 auto;width:100%;max-width:23rem}
.logo{width:42px;height:42px;border-radius:10px;background:linear-gradient(135deg,var(--blue),var(--accent));margin-bottom:1.1rem}
h1{font-size:2rem;font-weight:400;line-height:1.25;margin:0 0 .3rem}
.create{color:var(--muted);font-size:.875rem;margin:0 0 1.8rem}
.pill{display:flex;flex-direction:column;justify-content:flex-end;min-height:3.1rem;padding-bottom:.4rem;border-bottom:1px solid var(--field);margin-bottom:.4rem}
.pill .lbl{color:var(--muted);font-size:.72rem}.pill b{font-size:.95rem;color:var(--ink)}
label{display:block;font-size:.72rem;letter-spacing:.02em;color:var(--muted);margin:1rem 0 .35rem}
input.f{width:100%;height:2.7rem;padding:0 .9rem;font-size:.9rem;color:var(--ink);background:var(--surface);border:0;border-bottom:1px solid var(--field);border-radius:3px 3px 0 0}
input.f:focus{outline:2px solid var(--blue);outline-offset:-2px;border-bottom-color:var(--blue)}
.btn{display:block;width:100%;border:0;border-radius:5px;background:var(--blue);color:#fff;font-size:.9rem;font-weight:500;padding:.8rem 1rem;cursor:pointer;margin-top:1.4rem;text-align:center;text-decoration:none}
.btn:hover{background:var(--blue-h);text-decoration:none}
.btn.sec{background:#fff;color:var(--ink);border:1px solid var(--field)}.btn.sec:hover{background:#f3f4f7}
.btn.link{background:transparent;color:var(--blue);padding:.5rem 0;font-weight:400;margin-top:.3rem}
.or{display:flex;align-items:center;color:var(--muted);font-size:.8rem;margin:1.3rem 0}.or::before,.or::after{content:'';flex:1;border-bottom:1px solid var(--line)}.or::before{margin-right:1rem}.or::after{margin-left:1rem}
.copyright{color:var(--muted);font-size:.68rem;display:flex;gap:.9rem;flex-wrap:wrap;padding-top:1.5rem}
.note{border-left:3px solid #e1483a;background:#fef0ef;color:#80251d;padding:.6rem .8rem;font-size:.78rem;border-radius:0 3px 3px 0;margin:.6rem 0}
.ok{border-left:3px solid var(--accent);background:#e6faf6;color:#0a5b50;padding:.6rem .8rem;font-size:.82rem;border-radius:0 3px 3px 0;margin:.6rem 0}
.hint{font-size:.74rem;color:var(--muted);line-height:1.5;margin:.3rem 0}
.key{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.85rem;letter-spacing:2px;background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:.7rem .8rem;word-break:break-all;user-select:all;margin-top:.4rem}
.qr{display:inline-block;padding:10px;background:#fff;border:1px solid var(--line);border-radius:8px;line-height:0;margin:.4rem 0}.qr svg{width:164px;height:164px;display:block}
details.man{margin:.4rem 0}details.man summary{cursor:pointer;color:var(--blue);font-size:.74rem}
.splash{position:relative;flex:1 1 50%;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;background:radial-gradient(circle at 18% 20%,#cdd9ff 0 12%,transparent 28%),radial-gradient(circle at 70% 24%,#d6f3ee 0 12%,transparent 30%),radial-gradient(circle at 58% 82%,#e7ddff 0 14%,transparent 34%),linear-gradient(135deg,#eef1f8 0%,#fff 42%,#e9f0ff 100%)}
.splash::after{content:'';position:absolute;inset:auto -10% -20% 35%;width:42rem;height:42rem;border-radius:50%;opacity:.16;background:conic-gradient(from 180deg,#4c6fff,#00bfa5,#8fa6ff,#c7d0e8,#4c6fff)}
.splash .panel{z-index:1;max-width:34rem;margin:5rem}
.splash .pre{font-size:2rem;font-weight:300;margin:0;color:var(--ink)}
.splash .big{font-size:clamp(3rem,7vw,5.2rem);font-weight:300;line-height:1;margin:.2rem 0;color:var(--ink)}
.splash .sub{max-width:26rem;font-size:1.15rem;line-height:1.45;color:var(--muted);margin:1.4rem 0}
.splash .foot{z-index:1;display:flex;gap:1.2rem;flex-wrap:wrap;margin:0 5rem 2.5rem;font-size:.82rem;color:var(--muted)}
@media(max-width:1160px){.splash{display:none}.col{flex:1 1 auto;padding:3rem clamp(1.5rem,8%,5rem)}}`;
function shell(title, area) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head>
<body><header class="hd"><div class="brand"><b>OpenSphere</b> Console</div><nav><a href="${CONSOLE_URL}">Console</a><a href="#catalog">Catalog</a><a href="#docs">Docs</a></nav></header>
<div class="app"><main class="col"><div class="area">${area}</div><div class="copyright"><span>© OpenSphere Platform 2026</span><a href="#privacy">Privacy</a><a href="#terms">Terms of use</a></div></main>
<aside class="splash"><div class="panel"><p class="pre">Welcome to</p><h2 class="big">OpenSphere</h2><p class="sub">Sign in with an OpenSphere account after your Kanidm credentials have been enrolled.</p></div><div class="foot"><span>Learn more:</span><a href="#catalog">Catalog</a><a href="#docs">Docs</a><a href="#status">Status</a></div></aside></div></body></html>`;
}
function loginPage(params, error, showTotp = false, totpPolicyEnabled = false) {
  const hidden = ['client_id', 'redirect_uri', 'state', 'scope', 'code_challenge', 'code_challenge_method', 'nonce', 'response_type']
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params[k] || '')}">`).join('');
  return shell('Log in to OpenSphere', `<div class="logo"></div><h1>Log in to OpenSphere</h1>
<p class="create">Don't have an account? <a href="/ui/reset">Account onboarding</a></p>
<form method="POST" action="${EP.authorize}">
${error ? `<div class="note">${escapeHtml(error)}</div>` : ''}
<div class="pill"><span class="lbl">Sign in with</span><b>Kanidm</b></div>
<label for="u">Username</label><input class="f" id="u" name="username" autocomplete="username" autofocus value="${escapeHtml(params.username || '')}">
<label for="p">Password</label><input class="f" id="p" name="password" type="password" autocomplete="current-password">
${showTotp ? '<label for="t">Authenticator code</label><input class="f" id="t" name="totp" inputmode="numeric" autocomplete="one-time-code" placeholder="123456">' : '<input type="hidden" name="totp" value="">'}
<p class="hint">TOTP policy: <strong>${totpPolicyEnabled ? 'enabled' : 'disabled for development'}</strong>${!totpPolicyEnabled && showTotp ? ' · this account still has an existing authenticator enrollment.' : ''}</p>
${hidden}<button class="btn" type="submit">Log in</button>
<div class="or">or</div><a class="btn sec" href="/ui/reset">Set up account with a reset token</a>
</form>`);
}
function deniedPage(user) {
  return shell('Access Denied', `<div class="logo"></div><h1>Access Denied</h1><p class="create">This account can't access the console.</p>
<div class="note">The account <strong>${escapeHtml(user)}</strong> has no console role — it needs an <code>${escapeHtml(CONSOLE_GROUP_PREFIX)}*</code> group.</div>
<a class="btn" href="${CONSOLE_URL}">Try a different account</a>`);
}
function onboardTokenPage(error) {
  return shell('Set up your account', `<div class="logo"></div><h1>Set up your account</h1>
<p class="create">Enter the credential-reset token an OpenSphere administrator gave you.</p>
<form method="GET" action="/ui/reset">${error ? `<div class="note">${escapeHtml(error)}</div>` : ''}
<label for="tok">Reset token</label><input class="f" id="tok" name="token" autofocus placeholder="xxxxx-xxxxx-xxxxx-xxxxx">
<button class="btn" type="submit">Continue</button></form>
<a class="btn link" href="${CONSOLE_URL}">Back to sign in</a>`);
}
function onboardSetupPage({ session, secretB32, otpauth, account, error, qr, totpEnabled }) {
  const grouped = secretB32.replace(/(.{4})/g, '$1 ').trim();
  return shell('Set your credentials', `<div class="logo"></div><h1>Set your credentials</h1>
<p class="create">Account <strong>${escapeHtml(account)}</strong></p>
<form method="POST" action="/ui/reset">${error ? `<div class="note">${escapeHtml(error)}</div>` : ''}
<label for="p">New password</label><input class="f" id="p" name="password" type="password" autocomplete="new-password" autofocus>
${totpEnabled ? `
<label>Authenticator</label>
<p class="hint">Scan this QR with your authenticator app (Google Authenticator, Aegis, 1Password…), then enter the 6-digit code it shows.</p>
${qr ? `<div class="qr">${qr}</div>` : ''}
<details class="man"><summary>Can't scan? Enter the key manually</summary><div class="key">${grouped}</div><p class="hint">Algorithm SHA-256 · 6 digits · 30s.${otpauth ? ` On a phone? <a href="${escapeHtml(otpauth)}">open in app</a>.` : ''}</p></details>
<label for="t">Authenticator code</label><input class="f" id="t" name="totp" inputmode="numeric" autocomplete="one-time-code" placeholder="123456">
` : '<div class="ok">Development policy: password-only enrollment. TOTP can be enabled later by a Console administrator.</div><input type="hidden" name="totp" value="">'}
<input type="hidden" name="session" value="${escapeHtml(JSON.stringify(session))}"><input type="hidden" name="secret" value="${escapeHtml(secretB32)}"><input type="hidden" name="account" value="${escapeHtml(account)}"><input type="hidden" name="otpauth" value="${escapeHtml(otpauth)}">
<button class="btn" type="submit">Finish setup</button></form>`);
}
async function sendSetup(res, fields) {
  let qr = '';
  try { if (fields.otpauth) qr = await QRCode.toString(fields.otpauth, { type: 'svg', margin: 1, width: 164 }); }
  catch (e) { console.error('[bff] QR generation failed:', e.message); }
  send(res, 200, 'text/html', onboardSetupPage({ ...fields, qr }));
}
function onboardDonePage(totpEnabled) {
  return shell('Account ready', `<div class="logo"></div><h1>You're all set</h1><div class="ok">${totpEnabled ? 'Your password and authenticator are enrolled.' : 'Your password is enrolled. TOTP is disabled by the development policy.'}</div><a class="btn" href="${CONSOLE_URL}">Continue to the OpenSphere Console</a>`);
}

const readBody = (req) => new Promise((resolve, reject) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => resolve(Buffer.concat(ch))); req.on('error', reject); });
function send(res, code, type, body) { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); }
function redirect(res, location) { res.writeHead(302, { location, 'cache-control': 'no-store' }); res.end(); }

// ---- PAT (Personal Access Token): 관리자 발급 장수 토큰(osph CLI/자동화 인증) ----
// 발급/폐기 권위 = BFF. allowlist(jti)는 ConfigMap에 영속 → 재시작·폐기에도 정확.
// (안정 서명키 /keys/sig.key 전제 — ephemeral이면 재시작 시 PAT 무효.)
const PAT_CM_NS = process.env.PAT_CM_NS || 'opensphere-console-auth';
const PAT_CM_NAME = process.env.PAT_CM_NAME || 'opensphere-auth-pats';
const AUTH_POLICY_CM_NAME = process.env.AUTH_POLICY_CM_NAME || 'opensphere-auth-policy';
const PAT_TTL_DAYS = parseInt(process.env.PAT_TTL_DAYS || '365', 10);
const OIDC_TOKEN_TTL = parseInt(process.env.OIDC_TOKEN_TTL || '3600', 10); // console session (id_token) lifetime in seconds; default 1h, set 86400 for 24h
const PAT_CM_PATH = `/api/v1/namespaces/${PAT_CM_NS}/configmaps/${PAT_CM_NAME}`;
const AUTH_POLICY_CM_PATH = `/api/v1/namespaces/${PAT_CM_NS}/configmaps/${AUTH_POLICY_CM_NAME}`;
const AUTH_CODE_SECRET_PATH = `/api/v1/namespaces/${PAT_CM_NS}/secrets/${AUTH_CODE_SECRET_NAME}`;

function k8sApi(method, path, body, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${APISERVER}${path}`);
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const rq = https.request({ method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      ca: (() => { try { return fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'); } catch { return undefined; } })(),
      headers: { authorization: `Bearer ${saToken()}`, accept: 'application/json',
        ...(data ? { 'content-type': contentType || 'application/json', 'content-length': data.length } : {}) } },
      (resp) => { const ch = []; resp.on('data', (c) => ch.push(c)); resp.on('end', () => { const txt = Buffer.concat(ch).toString('utf8'); let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {} resolve({ status: resp.statusCode, json, txt }); }); });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
}
const readPats = async () => { const r = await k8sApi('GET', PAT_CM_PATH); return (r.status === 200 && r.json?.data) ? r.json.data : {}; };
// merge-patch: data[jti]=string(추가) 또는 null(폐기)
const patchPat = (jti, valueOrNull) => k8sApi('PATCH', PAT_CM_PATH, { data: { [jti]: valueOrNull } }, 'application/merge-patch+json');

async function storeAuthorizationCode(code, entry) {
  const encoded = Buffer.from(JSON.stringify(entry)).toString('base64');
  const r = await k8sApi('PATCH', AUTH_CODE_SECRET_PATH, { data: { [code]: encoded } }, 'application/merge-patch+json');
  if (r.status >= 300) throw new Error(`authorization code store HTTP ${r.status}`);
}

// GET + resourceVersion PUT makes consumption one-time across both replicas.
// A concurrent exchange or code issuance produces 409 and is retried with fresh state.
async function takeAuthorizationCode(code) {
  if (!code) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await k8sApi('GET', AUTH_CODE_SECRET_PATH);
    if (r.status !== 200) throw new Error(`authorization code read HTTP ${r.status}`);
    const encoded = r.json?.data?.[code];
    if (!encoded) return null;
    const data = { ...(r.json.data || {}) };
    delete data[code];
    const consumed = await k8sApi('PUT', AUTH_CODE_SECRET_PATH, {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: AUTH_CODE_SECRET_NAME, namespace: PAT_CM_NS, resourceVersion: r.json.metadata?.resourceVersion },
      type: 'Opaque',
      data,
    });
    if (consumed.status === 409) continue;
    if (consumed.status >= 300) throw new Error(`authorization code consume HTTP ${consumed.status}`);
    try { return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
    catch { return null; }
  }
  throw new Error('authorization code consume conflict');
}

async function cleanupAuthorizationCodes() {
  const r = await k8sApi('GET', AUTH_CODE_SECRET_PATH);
  if (r.status !== 200) return;
  const data = { ...(r.json?.data || {}) };
  let changed = false;
  for (const [code, encoded] of Object.entries(data)) {
    try {
      const entry = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (!entry.exp || entry.exp < Date.now()) { delete data[code]; changed = true; }
    } catch { delete data[code]; changed = true; }
  }
  if (!changed) return;
  await k8sApi('PUT', AUTH_CODE_SECRET_PATH, {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: AUTH_CODE_SECRET_NAME, namespace: PAT_CM_NS, resourceVersion: r.json.metadata?.resourceVersion },
    type: 'Opaque', data,
  });
}
setInterval(() => cleanupAuthorizationCodes().catch((e) => console.error('[auth-code] cleanup:', e.message)), 30000).unref?.();

async function readAuthPolicy() {
  const r = await k8sApi('GET', AUTH_POLICY_CM_PATH);
  if (r.status === 200) return authPolicyFromConfigMap(r.json, DEFAULT_TOTP_ENABLED);
  console.error(`[auth-policy] ConfigMap read HTTP ${r.status}; using development default`);
  return authPolicyFromConfigMap(null, DEFAULT_TOTP_ENABLED);
}

async function handleAuthPolicyGet(res) {
  patJson(res, 200, await readAuthPolicy());
}

async function handleAuthPolicyPatch(req, res, admin) {
  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
  catch { return patJson(res, 400, { error: 'invalid_json' }); }
  if (typeof body.totpEnabled !== 'boolean') return patJson(res, 400, { error: 'totpEnabled_boolean_required' });
  const actor = admin.preferred_username || admin.sub || 'unknown';
  const patch = authPolicyPatch(body.totpEnabled, actor);
  const result = await k8sApi('PATCH', AUTH_POLICY_CM_PATH, patch, 'application/merge-patch+json');
  if (result.status >= 300) return patJson(res, 500, { error: 'policy_store_failed', status: result.status });
  const policy = authPolicyFromConfigMap(result.json, DEFAULT_TOTP_ENABLED);
  console.log(JSON.stringify({ event: 'auth_policy_changed', actor, totpEnabled: policy.totpEnabled, time: patch.data.updatedAt }));
  patJson(res, 200, policy);
}

// 우리가 발급한 ES256 토큰 검증 → payload 또는 null (서명+OIDC 표준 claim)
function verifyToken(jwt) {
  return verifyEs256Jwt(jwt, { key: publicKey, issuer: ISSUER, audience: CLIENT_ID, expectedKid: KID });
}
const bearer = (req) => { const a = req.headers.authorization || ''; return a.startsWith('Bearer ') ? a.slice(7) : null; };
// Kanidm id_token 검증 — 콘솔 Kanidm 직결 로그인 토큰(swap-less §3.2 배포). BFF 자체 발급(PAT)과 dual-accept.
// (swap 아키텍처에선 BFF가 발급자라 verifyToken만으로 충분했으나, 콘솔이 Kanidm 직결이면 토큰이 Kanidm 서명임.)
let _kjwks = null, _kjwksAt = 0;
async function kanidmJwks(force) {
  if (!force && _kjwks && Date.now() - _kjwksAt < 300000) return _kjwks;
  const r = await kanidmReq('GET', `/oauth2/openid/${CLIENT_ID}/public_key.jwk`);
  if (r.status !== 200 || !r.json) throw new Error(`kanidm jwk HTTP ${r.status}`);
  _kjwks = r.json.keys || (r.json.kty ? [r.json] : []);
  _kjwksAt = Date.now();
  return _kjwks;
}
async function verifyKanidmToken(jwt) {
  try {
    const [h, pl, s] = String(jwt).split('.');
    if (!h || !pl || !s) return null;
    const hdr = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    if (hdr.alg !== 'ES256') { console.log(`[verifyKanidm] alg=${hdr.alg} (not ES256)`); return null; }
    let jwk = (await kanidmJwks()).find((k) => k.kid === hdr.kid);          // kid 매칭(키 로테이션 대응 — console-identity와 동일)
    if (!jwk) jwk = (await kanidmJwks(true)).find((k) => k.kid === hdr.kid); // 미스 시 강제 refresh + 재시도
    if (!jwk) { console.log(`[verifyKanidm] no jwk for tokKid=${hdr.kid} (have ${(await kanidmJwks()).map((k) => k.kid).join(',')})`); return null; }
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return verifyEs256Jwt(jwt, { key, issuer: ISSUER, audience: CLIENT_ID, expectedKid: hdr.kid });
  } catch (e) { console.log(`[verifyKanidm] error ${e.message}`); return null; }
}
// 관리자 id_token(또는 PAT) 제시 필요 (콘솔 admin 그룹). BFF 토큰 또는 Kanidm id_token 수용. 그룹은 SPN(name@domain) strip.
async function requireAdmin(req) {
  const t = bearer(req);
  let pl = verifyToken(t);
  const via = pl ? 'bff' : 'kanidm';
  if (pl?.typ === 'pat') {
    if (!isActivePat(pl, await readPats())) pl = null;
  } else if (pl?.typ !== undefined) {
    pl = null;
  }
  if (!pl) pl = await verifyKanidmToken(t);
  if (!pl) { console.log(`[requireAdmin] DENY no-valid-token hasBearer=${!!t} len=${t ? t.length : 0}`); return null; }
  const groups = (pl.groups || []).map((g) => String(g).split('@')[0]);
  const ok = groups.includes(ADMIN_GROUP);
  console.log(`[requireAdmin] ${ok ? 'ALLOW' : 'DENY-not-admin'} via=${via} user=${pl.preferred_username} groups=${JSON.stringify(groups)}`);
  return ok ? pl : null;
}
const patJson = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));

async function handlePatMint(req, res, admin) {
  const form = Object.fromEntries(new URLSearchParams((await readBody(req)).toString('utf8')));
  const label = (form.label || 'osph-cli').slice(0, 64);
  const jti = crypto.randomBytes(16).toString('hex');
  const now = Math.floor(Date.now() / 1000), exp = now + PAT_TTL_DAYS * 86400;
  const token = signJWT({ iss: ISSUER, sub: admin.sub, aud: CLIENT_ID, azp: CLIENT_ID,
    preferred_username: admin.preferred_username, name: admin.name, ...(admin.email ? { email: admin.email } : {}),
    groups: admin.groups, typ: 'pat', jti, iat: now, nbf: now, exp });
  const pr = await patchPat(jti, JSON.stringify({ user: admin.preferred_username, label, iat: now, exp }));
  if (pr.status >= 300) return patJson(res, 500, { error: 'store_failed', status: pr.status });
  patJson(res, 200, { token, jti, label, expiresAt: new Date(exp * 1000).toISOString() });
}
async function handlePatList(req, res, admin) {
  const all = await readPats();
  const pats = Object.entries(all).map(([jti, v]) => { let r = {}; try { r = JSON.parse(v); } catch {} return { jti, label: r.label, createdAt: r.iat ? new Date(r.iat * 1000).toISOString() : null, expiresAt: r.exp ? new Date(r.exp * 1000).toISOString() : null, user: r.user }; })
    .filter((x) => x.user === admin.preferred_username);
  patJson(res, 200, { pats });
}
async function handlePatRevoke(req, res, admin, jti) {
  const all = await readPats();
  if (!all[jti]) return patJson(res, 404, { error: 'not_found' });
  let rec = {}; try { rec = JSON.parse(all[jti]); } catch {}
  if (rec.user !== admin.preferred_username) return patJson(res, 403, { error: 'not_owner' });
  const pr = await patchPat(jti, null);
  if (pr.status >= 300) return patJson(res, 500, { error: 'store_failed' });
  patJson(res, 200, { revoked: jti });
}
// resource-server가 PAT 유효성 확인(폐기 반영). RFC7662 풍 introspection.
async function handlePatIntrospect(req, res) {
  const form = Object.fromEntries(new URLSearchParams((await readBody(req)).toString('utf8')));
  const pl = verifyToken(form.token || '');
  if (!pl || pl.typ !== 'pat' || !pl.jti) return patJson(res, 200, { active: false });
  const all = await readPats();
  if (!all[pl.jti]) return patJson(res, 200, { active: false }); // 폐기됨
  patJson(res, 200, { active: true, sub: pl.sub, username: pl.preferred_username, groups: pl.groups, exp: pl.exp, jti: pl.jti });
}

// ---- 콘솔 역할(Console Role) 관리 — 역할 정의·부여 UI 백엔드(Phase 3) ----
// 역할 = Kanidm 그룹(opensphere-console-*). grant/revoke = scoped write SA(console-rolemgr-svc).
// 그 SA는 entry-managed-by로 콘솔 역할 그룹만 쓰기 가능(시스템 그룹 불가 — least-privilege).
const RM_SECRET_NAME = process.env.RM_SECRET_NAME || 'opensphere-rolemgr-kanidm';
const CONSOLE_ROLES = [
  { group: 'opensphere-console-admins', label: '관리자 (Admin)', desc: '전 워크스페이스 · spine 관리' },
  { group: 'opensphere-console-operators', label: '운영자 (Operator)', desc: '협업·업무 (운영 제외)' },
  { group: 'opensphere-console-viewers', label: '뷰어 (Viewer)', desc: '읽기 전용' },
];
const isConsoleRole = (g) => CONSOLE_ROLES.some((r) => r.group === g);

let _rmTok = null;
async function rolemgrToken() {
  if (_rmTok) return _rmTok;
  const u = new URL(`${APISERVER}/api/v1/namespaces/${KSVC_SECRET_NS}/secrets/${RM_SECRET_NAME}`);
  const out = await new Promise((resolve, reject) => {
    const rq = https.request({ method: 'GET', hostname: u.hostname, port: u.port || 443, path: u.pathname,
      ca: (() => { try { return fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'); } catch { return undefined; } })(),
      headers: { authorization: `Bearer ${saToken()}` } }, (resp) => { const ch = []; resp.on('data', (c) => ch.push(c)); resp.on('end', () => resolve({ status: resp.statusCode, txt: Buffer.concat(ch).toString('utf8') })); });
    rq.on('error', reject); rq.end();
  });
  if (out.status !== 200) throw new Error(`rolemgr secret HTTP ${out.status}`);
  _rmTok = Buffer.from(JSON.parse(out.txt).data.token, 'base64').toString('utf8');
  return _rmTok;
}
const rmReq = async (method, path, body) => kanidmReq(method, path, body, { authorization: `Bearer ${await rolemgrToken()}` });

async function handleRolesList(req, res) {
  const roles = [];
  for (const r of CONSOLE_ROLES) {
    const g = await rmReq('GET', `/v1/group/${encodeURIComponent(r.group)}`);
    const members = (g.json?.attrs?.member || []).map((m) => String(m).split('@')[0]).sort();
    roles.push({ ...r, members });
  }
  patJson(res, 200, { roles });
}
async function handleRoleGrant(req, res) {
  const form = Object.fromEntries(new URLSearchParams((await readBody(req)).toString('utf8')));
  const user = (form.user || '').trim().split('@')[0];
  if (!isConsoleRole(form.role)) return patJson(res, 400, { error: 'unknown_role' });
  if (!user) return patJson(res, 400, { error: 'user_required' });
  const r = await rmReq('POST', `/v1/group/${encodeURIComponent(form.role)}/_attr/member`, [user]);
  if (r.status >= 300) return patJson(res, 502, { error: 'grant_failed', status: r.status, detail: (r.txt || '').slice(0, 160) });
  patJson(res, 200, { granted: { user, role: form.role } });
}
async function handleRoleRevoke(req, res) {
  const form = Object.fromEntries(new URLSearchParams((await readBody(req)).toString('utf8')));
  const user = (form.user || '').trim().split('@')[0];
  if (!isConsoleRole(form.role)) return patJson(res, 400, { error: 'unknown_role' });
  const g = await rmReq('GET', `/v1/group/${encodeURIComponent(form.role)}`);
  const kept = (g.json?.attrs?.member || []).filter((m) => String(m).split('@')[0] !== user);
  const r = await rmReq('PUT', `/v1/group/${encodeURIComponent(form.role)}/_attr/member`, kept);
  if (r.status >= 300) return patJson(res, 502, { error: 'revoke_failed', status: r.status, detail: (r.txt || '').slice(0, 160) });
  patJson(res, 200, { revoked: { user, role: form.role } });
}

// ---- reverse proxy to internal Kanidm for all non-OIDC, non-/ui paths ----
function proxyToKanidm(req, res) {
  const u = new URL(KANIDM_CORE_URL + req.url);
  const up = https.request({ method: req.method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, servername: KANIDM_SNI, ca: kanidmCa(), headers: { ...req.headers } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('upstream error: ' + e.message); });
  req.pipe(up);
}

// ---- OIDC handlers ----
async function handleAuthorizeGet(reqUrl, res) {
  const q = Object.fromEntries(reqUrl.searchParams);
  if (q.client_id !== CLIENT_ID) return send(res, 400, 'text/plain', 'unknown client_id');
  if (!REDIRECT_ALLOW.includes(q.redirect_uri)) return send(res, 400, 'text/plain', 'redirect_uri not allowed');
  const policy = await readAuthPolicy();
  send(res, 200, 'text/html', loginPage(q, null, policy.totpEnabled, policy.totpEnabled));
}
async function handleAuthorizePost(req, res) {
  const form = Object.fromEntries(new URLSearchParams((await readBody(req)).toString('utf8')));
  const params = { client_id: form.client_id, redirect_uri: form.redirect_uri, state: form.state, scope: form.scope, code_challenge: form.code_challenge, code_challenge_method: form.code_challenge_method, nonce: form.nonce, response_type: form.response_type, username: form.username };
  if (params.client_id !== CLIENT_ID || !REDIRECT_ALLOW.includes(params.redirect_uri)) return send(res, 400, 'text/plain', 'bad client/redirect');
  const policy = await readAuthPolicy();
  let user;
  try { user = await kanidmAuthenticate(form.username?.trim(), form.password || '', form.totp || '', policy.totpEnabled); }
  catch (e) { return send(res, 200, 'text/html', loginPage(params, e.reason || 'Sign-in failed.', policy.totpEnabled || e.requiresTotp, policy.totpEnabled)); }
  const username = String(user.spn || form.username).split('@')[0];
  let groups = [];
  try { groups = await lookupGroups(username); } catch (e) { console.error('[bff] group lookup failed:', e.message); }
  if (!groups.some((g) => g.startsWith(CONSOLE_GROUP_PREFIX))) return send(res, 403, 'text/html', deniedPage(username));
  const code = crypto.randomBytes(24).toString('base64url');
  const payloadBase = { iss: ISSUER, sub: user.uuid, aud: CLIENT_ID, azp: CLIENT_ID, preferred_username: username, name: user.displayname || username, ...(user.mail_primary ? { email: user.mail_primary } : {}), groups };
  await storeAuthorizationCode(code, { payloadBase, code_challenge: params.code_challenge, redirect_uri: params.redirect_uri, nonce: params.nonce, exp: Date.now() + 60000 });
  redirect(res, `${params.redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(params.state || '')}`);
}
async function handleToken(req, res) {
  const form = Object.fromEntries(new URLSearchParams((await readBody(req)).toString('utf8')));
  if (form.grant_type !== 'authorization_code') return send(res, 400, 'application/json', JSON.stringify({ error: 'unsupported_grant_type' }));
  const entry = await takeAuthorizationCode(form.code);
  if (!entry) return send(res, 400, 'application/json', JSON.stringify({ error: 'invalid_grant' }));
  if (entry.redirect_uri !== form.redirect_uri) return send(res, 400, 'application/json', JSON.stringify({ error: 'invalid_grant', error_description: 'redirect mismatch' }));
  const challenge = crypto.createHash('sha256').update(form.code_verifier || '').digest('base64url');
  if (challenge !== entry.code_challenge) return send(res, 400, 'application/json', JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE failed' }));
  const now = Math.floor(Date.now() / 1000);
  const idToken = signJWT({ ...entry.payloadBase, iat: now, nbf: now, exp: now + OIDC_TOKEN_TTL, auth_time: now, ...(entry.nonce ? { nonce: entry.nonce } : {}) });
  send(res, 200, 'application/json', JSON.stringify({ access_token: crypto.randomBytes(32).toString('base64url'), token_type: 'Bearer', expires_in: OIDC_TOKEN_TTL, id_token: idToken, scope: 'openid profile email groups_name' }));
}

// ---- onboarding / credential setup (replaces Kanidm /ui/reset) ----
async function handleOnboardGet(reqUrl, res) {
  const token = reqUrl.searchParams.get('token');
  if (!token) return send(res, 200, 'text/html', onboardTokenPage(null));
  let session, totp;
  const policy = await readAuthPolicy();
  try {
    const ex = await cuExchange(token.trim());
    if (ex.status !== 200 || !Array.isArray(ex.json)) throw new Error('That reset token is invalid or has expired.');
    session = ex.json[0];
    // re-onboarding: drop any existing TOTP named "app" first, otherwise totpverify returns
    // TotpNameTryAgain and the freshly scanned secret is silently NOT stored (old one kept).
    await cuUpdate({ totpremove: 'app' }, session);
    if (policy.totpEnabled) {
      const g = await cuUpdate('totpgenerate', session);
      totp = g.json?.mfaregstate?.TotpCheck;
      if (!totp || !Array.isArray(totp.secret)) throw new Error('Could not start authenticator setup.');
    }
  } catch (e) { return send(res, 200, 'text/html', onboardTokenPage(String(e.message || e))); }
  const secretB32 = totp ? base32(totp.secret) : '';
  const account = String(totp?.accountname || '').split('@')[0] || 'account';
  const otpauth = totp ? `otpauth://totp/OpenSphere:${encodeURIComponent(account)}?secret=${secretB32}&issuer=OpenSphere&algorithm=SHA256&digits=${totp.digits || 6}&period=${totp.step || 30}` : '';
  await sendSetup(res, { session, secretB32, otpauth, account, totpEnabled: policy.totpEnabled });
}
async function handleOnboardPost(req, res) {
  const form = Object.fromEntries(new URLSearchParams((await readBody(req)).toString('utf8')));
  const policy = await readAuthPolicy();
  let session; try { session = JSON.parse(form.session); } catch { return send(res, 200, 'text/html', onboardTokenPage('Your setup session expired. Re-enter your reset token.')); }
  const reshow = (msg) => sendSetup(res, { session, secretB32: form.secret || '', otpauth: form.otpauth || '', account: form.account || 'account', error: msg, totpEnabled: policy.totpEnabled });
  try {
    if (!form.password || form.password.length < 8) return reshow('Choose a password of at least 8 characters.');
    let r = await cuUpdate({ password: form.password }, session);
    if (r.status !== 200) return reshow('Password was rejected by policy. Try a stronger one.');
    if (policy.totpEnabled) {
      const code = parseInt(String(form.totp || '').replace(/\s+/g, ''), 10);
      if (!Number.isInteger(code)) return reshow('Enter the 6-digit code from your authenticator.');
      r = await cuUpdate({ totpverify: [code, 'app'] }, session);
      // Some apps (Okta Verify, older Google Authenticator) ignore the SHA-256 algorithm and
      // compute the code with SHA-1. Kanidm flags that as TotpInvalidSha1 — accept the SHA-1
      // variant so those apps enroll cleanly instead of looping on "code did not match".
      if (r.json?.mfaregstate === 'TotpInvalidSha1') r = await cuUpdate('totpacceptsha1', session);
      if (r.json?.can_commit !== true) return reshow('That authenticator code did not match. Enter the current 6-digit code and try again.');
    } else if (r.json?.can_commit !== true) {
      return reshow('The password is not ready to commit. Try a stronger password or request a new reset token.');
    }
    r = await cuCommit(session);
    if (r.status !== 200) return reshow('Could not finalize setup. Please retry.');
  } catch (e) { return reshow('Setup failed: ' + (e.message || e)); }
  send(res, 200, 'text/html', onboardDonePage(policy.totpEnabled));
}

// ---- discovery ----
const discoveryDoc = {
  issuer: ISSUER,
  authorization_endpoint: `${ORIGIN}${EP.authorize}`,
  token_endpoint: `${ORIGIN}${EP.token}`,
  jwks_uri: `${ORIGIN}${EP.jwks}`,
  end_session_endpoint: `${ORIGIN}/ui/logout`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code'], subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['ES256'], scopes_supported: ['openid', 'profile', 'email', 'groups_name'],
  token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
  claims_supported: ['sub', 'name', 'preferred_username', 'email', 'groups', 'iss', 'aud', 'azp', 'exp', 'iat', 'nonce'],
};

const server = https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, (req, res) => {
  const reqUrl = new URL(req.url, ORIGIN);
  const p = reqUrl.pathname;
  const isOidcEp = [EP.discovery, EP.jwks, EP.token, EP.authorize].includes(p);
  const isPatEp = p.startsWith('/bff/pat') || p.startsWith('/bff/roles') || p === '/bff/auth-policy';
  const corsAllowed = Boolean(req.headers.origin && CORS_ORIGINS.has(req.headers.origin));
  if ((isOidcEp || isPatEp) && corsAllowed) {
    res.setHeader('access-control-allow-origin', req.headers.origin); res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS'); res.setHeader('access-control-allow-headers', 'content-type, authorization');
  }
  if (req.method === 'OPTIONS' && (isOidcEp || isPatEp)) { res.writeHead(corsAllowed ? 204 : 403); return res.end(); }
  (async () => {
    try {
      if (req.method === 'GET' && p === EP.discovery) return send(res, 200, 'application/json', JSON.stringify(discoveryDoc));
      if (req.method === 'GET' && p === EP.jwks) return send(res, 200, 'application/json', JSON.stringify(JWKS));
      if (req.method === 'GET' && p === EP.authorize) return await handleAuthorizeGet(reqUrl, res);
      if (req.method === 'POST' && p === EP.authorize) return await handleAuthorizePost(req, res);
      if (req.method === 'POST' && p === EP.token) return await handleToken(req, res);
      if (p === '/bff/healthz') return send(res, 200, 'text/plain', 'ok');
      // PAT — 관리자 발급 장수 토큰(osph CLI/자동화). 발급/목록/폐기는 admin 그룹 필요, introspect는 공개.
      if (p === '/bff/pat/introspect' && req.method === 'POST') return await handlePatIntrospect(req, res);
      if (p === '/bff/pat' && req.method === 'POST') { const a = await requireAdmin(req); return a ? await handlePatMint(req, res, a) : patJson(res, 401, { error: 'unauthorized' }); }
      if (p === '/bff/pat' && req.method === 'GET') { const a = await requireAdmin(req); return a ? await handlePatList(req, res, a) : patJson(res, 401, { error: 'unauthorized' }); }
      if (p.startsWith('/bff/pat/') && req.method === 'DELETE') { const a = await requireAdmin(req); return a ? await handlePatRevoke(req, res, a, decodeURIComponent(p.slice('/bff/pat/'.length))) : patJson(res, 401, { error: 'unauthorized' }); }
      // Console authentication policy — shared ConfigMap, admin-only read/write.
      if (p === '/bff/auth-policy' && req.method === 'GET') { const a = await requireAdmin(req); return a ? await handleAuthPolicyGet(res) : patJson(res, 401, { error: 'unauthorized' }); }
      if (p === '/bff/auth-policy' && req.method === 'PATCH') { const a = await requireAdmin(req); return a ? await handleAuthPolicyPatch(req, res, a) : patJson(res, 401, { error: 'unauthorized' }); }
      // 콘솔 역할 관리(admin 전용) — 역할 정의·부여 UI 백엔드
      if (p === '/bff/roles' && req.method === 'GET') { const a = await requireAdmin(req); return a ? await handleRolesList(req, res) : patJson(res, 401, { error: 'unauthorized' }); }
      if (p === '/bff/roles/grant' && req.method === 'POST') { const a = await requireAdmin(req); return a ? await handleRoleGrant(req, res) : patJson(res, 401, { error: 'unauthorized' }); }
      if (p === '/bff/roles/revoke' && req.method === 'POST') { const a = await requireAdmin(req); return a ? await handleRoleRevoke(req, res) : patJson(res, 401, { error: 'unauthorized' }); }
      // our own account-onboarding surface (replaces Kanidm /ui/reset)
      if (p === '/ui/reset' && req.method === 'GET') return await handleOnboardGet(reqUrl, res);
      if (p === '/ui/reset' && req.method === 'POST') return await handleOnboardPost(req, res);
      // logout: clear console-side (shell already does) and bounce to the console (no crab)
      if (p === '/ui/logout') return redirect(res, CONSOLE_URL);
      // hide every other Kanidm /ui/* (apps portal, native login, oauth2, profile) behind the console
      if (p === '/ui' || p.startsWith('/ui/')) return redirect(res, CONSOLE_URL);
      return proxyToKanidm(req, res); // /v1/*, /status, … -> internal Kanidm
    } catch (e) { console.error('[bff] handler error:', e); if (!res.headersSent) send(res, 500, 'text/plain', 'internal error'); }
  })();
});
server.listen(PORT, () => console.log(`[bff] opensphere-auth listening :${PORT} (kid=${KID}, core=${KANIDM_CORE_URL})`));

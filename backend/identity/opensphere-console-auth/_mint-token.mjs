// 로컬 검증 전용: tester로 BFF OIDC 전체 플로우(authorize→token) 실행해 id_token 출력.
import https from 'node:https';
import crypto from 'node:crypto';

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for this local-only token check`);
  return value;
}

// Test credentials are intentionally never embedded in source, Docker images,
// command arguments, or output. Inject them only in the local test process.
const SECRET = requiredEnvironment('OPENSPHERE_TEST_TOTP_SECRET');
const USER = requiredEnvironment('OPENSPHERE_TEST_USERNAME');
const PW = requiredEnvironment('OPENSPHERE_TEST_PASSWORD');
const b32d = (s) => { const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0, out = []; for (const c of s.replace(/[^A-Z2-7]/gi, '').toUpperCase()) { val = (val << 5) | AL.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const sec = b32d(SECRET);
const totp = () => { const t = Math.floor(Date.now() / 1000 / 30); const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(t)); const h = crypto.createHmac('sha1', sec).update(b).digest(); const o = h[h.length - 1] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0'); };
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

function req(method, path, body, headers) {
  return new Promise((res, rej) => { const data = body ? Buffer.from(body) : null; const r = https.request({ method, hostname: 'localhost', port: 8444, path, rejectUnauthorized: false, headers: { ...headers, ...(data ? { 'content-length': data.length } : {}) } }, (resp) => { let c = []; resp.on('data', (d) => c.push(d)); resp.on('end', () => res({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(c).toString() })); }); r.on('error', rej); if (data) r.write(data); r.end(); });
}
(async () => {
  const state = 's' + crypto.randomBytes(4).toString('hex');
  const aform = new URLSearchParams({ client_id: 'opensphere-console', redirect_uri: 'http://localhost:8090/', response_type: 'code', scope: 'openid profile email groups_name', state, code_challenge: challenge, code_challenge_method: 'S256', username: USER, password: PW, totp: totp() }).toString();
  let r = await req('POST', '/oauth2/openid/opensphere-console/authorize', aform, { 'content-type': 'application/x-www-form-urlencoded' });
  const code = new URL(r.headers.location || '', 'http://x').searchParams.get('code');
  if (!code) { console.error('NO CODE', r.status, r.body.slice(0, 200)); process.exit(1); }
  const tform = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:8090/', client_id: 'opensphere-console', code_verifier: verifier }).toString();
  r = await req('POST', '/oauth2/openid/opensphere-console/token', tform, { 'content-type': 'application/x-www-form-urlencoded' });
  const j = JSON.parse(r.body);
  if (!j.id_token) { console.error('NO ID TOKEN', r.status, r.body.slice(0, 200)); process.exit(1); }
  console.log(j.id_token);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

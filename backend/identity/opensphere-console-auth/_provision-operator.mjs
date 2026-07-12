// 로컬 dev 전용: 콘솔 사용자(person) 프로비저닝 — password + SHA-1 TOTP 설정 후 전체 OIDC
// 로그인으로 id_token 발급해 groups 확인. args: <user> <pw>  env: KANIDM_ADMIN_JWT(write-admin).
// (provision-tester.mjs의 파라미터화 버전 — operator1 등 임의 콘솔 역할 사용자 데모용.)
import https from 'node:https';
import crypto from 'node:crypto';

const BASE = 'https://localhost:8444';
const USER = process.argv[2];
const PW = process.argv[3];
const ADMIN = process.env.KANIDM_ADMIN_JWT;
if (!USER || !PW || !ADMIN) {
  console.error('usage: KANIDM_ADMIN_JWT=<jwt> node _provision-operator.mjs <user> <pw>');
  process.exit(1);
}
const A = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', accept: 'application/json' };

function req(method, path, body, headers = {}, raw = false) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(raw ? body : JSON.stringify(body)) : null;
    const u = new URL(BASE + path);
    const r = https.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, rejectUnauthorized: false, headers: { ...headers, ...(data ? { 'content-length': data.length } : {}) } },
      (resp) => { const ch = []; resp.on('data', (d) => ch.push(d)); resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, txt: Buffer.concat(ch).toString('utf8') })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const J = (m, p, b) => req(m, p, b, A);
const totp = (sec, algo) => { const t = Math.floor(Date.now() / 1000 / 30); const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(t)); const h = crypto.createHmac(algo, Buffer.from(sec)).update(b).digest(); const o = h[h.length - 1] & 15; return (h.readUInt32BE(o) & 0x7fffffff) % 1000000; };
const b32 = (bytes) => { const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0, out = ''; for (const x of bytes) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += AL[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += AL[(val << (5 - bits)) & 31]; return out; };

(async () => {
  let r = await J('GET', `/v1/person/${USER}/_credential/_update_intent/600`);
  if (r.status !== 200) throw new Error(`update_intent ${r.status}: ${r.txt.slice(0, 140)}`);
  const token = JSON.parse(r.txt).token;
  r = await J('POST', '/v1/credential/_exchange_intent', token);
  const session = JSON.parse(r.txt)[0];
  await J('POST', '/v1/credential/_update', [{ password: PW }, session]);
  await J('POST', '/v1/credential/_update', [{ totpremove: 'app' }, session]);
  r = await J('POST', '/v1/credential/_update', ['totpgenerate', session]);
  const secret = JSON.parse(r.txt).mfaregstate.TotpCheck.secret;
  r = await J('POST', '/v1/credential/_update', [{ totpverify: [totp(secret, 'sha1'), 'app'] }, session]);
  if (JSON.parse(r.txt).mfaregstate === 'TotpInvalidSha1') r = await J('POST', '/v1/credential/_update', ['totpacceptsha1', session]);
  if (JSON.parse(r.txt).can_commit !== true) throw new Error('cannot commit: ' + r.txt.slice(0, 160));
  r = await J('POST', '/v1/credential/_commit', session);
  if (r.status !== 200) throw new Error('commit failed ' + r.status);

  // 전체 OIDC 로그인(BFF) → id_token → groups
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const code6 = String(totp(secret, 'sha1')).padStart(6, '0');
  const aform = new URLSearchParams({ client_id: 'opensphere-console', redirect_uri: 'http://localhost:8090/', response_type: 'code', scope: 'openid profile email groups_name', state: 's', code_challenge: challenge, code_challenge_method: 'S256', username: USER, password: PW, totp: code6 }).toString();
  r = await req('POST', '/oauth2/openid/opensphere-console/authorize', aform, { 'content-type': 'application/x-www-form-urlencoded' }, true);
  const codeParam = new URL(r.headers.location || '', 'http://x').searchParams.get('code');
  let groups = null;
  if (codeParam) {
    const tform = new URLSearchParams({ grant_type: 'authorization_code', code: codeParam, redirect_uri: 'http://localhost:8090/', client_id: 'opensphere-console', code_verifier: verifier }).toString();
    r = await req('POST', '/oauth2/openid/opensphere-console/token', tform, { 'content-type': 'application/x-www-form-urlencoded' }, true);
    const idToken = JSON.parse(r.txt).id_token;
    if (idToken) groups = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')).groups;
  }
  console.log(JSON.stringify({ user: USER, totpSecret: b32(secret), loginOk: !!codeParam, groups }));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

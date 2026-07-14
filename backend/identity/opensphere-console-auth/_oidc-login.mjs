// 로컬 검증 전용: 셸의 실제 PKCE 챌린지로 OIDC 인가를 서버사이드 완료 → 302 코드 획득.
// (브라우저 폼 필드 입력이 아니라 provision-tester와 동일한 HTTP 호출.) args: state, challenge.
import https from 'node:https';
import crypto from 'node:crypto';

const STATE = process.argv[2];
const CHALLENGE = process.argv[3];
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for this local-only OIDC check`);
  return value;
}

if (!STATE || !CHALLENGE) throw new Error('usage: node _oidc-login.mjs <state> <pkce-challenge>');
// Test credentials are intentionally never embedded in source, Docker images,
// command arguments, or output. Inject them only in the local test process.
const SECRET = requiredEnvironment('OPENSPHERE_TEST_TOTP_SECRET');
const USER = requiredEnvironment('OPENSPHERE_TEST_USERNAME');
const PW = requiredEnvironment('OPENSPHERE_TEST_PASSWORD');

const b32d = (s) => { const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0, out = []; for (const c of s.replace(/[^A-Z2-7]/gi, '').toUpperCase()) { val = (val << 5) | AL.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const sec = b32d(SECRET);
const t = Math.floor(Date.now() / 1000 / 30); const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(t));
const hm = crypto.createHmac('sha1', sec).update(b).digest(); const o = hm[hm.length - 1] & 15;
const code = String((hm.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');

const form = new URLSearchParams({ client_id: 'opensphere-console', redirect_uri: 'http://localhost:8090/', response_type: 'code', scope: 'openid profile email groups_name', state: STATE, code_challenge: CHALLENGE, code_challenge_method: 'S256', username: USER, password: PW, totp: code }).toString();
const data = Buffer.from(form);
const req = https.request({ method: 'POST', hostname: 'localhost', port: 8444, path: '/oauth2/openid/opensphere-console/authorize', rejectUnauthorized: false, headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': data.length } }, (r) => {
  console.log('STATUS', r.statusCode);
  console.log('LOCATION', r.headers.location || '(none)');
  let c = []; r.on('data', (d) => c.push(d)); r.on('end', () => { if (!r.headers.location) console.log('BODY', Buffer.concat(c).toString().slice(0, 400)); });
});
req.on('error', (e) => console.log('ERR', e.message));
req.write(data); req.end();

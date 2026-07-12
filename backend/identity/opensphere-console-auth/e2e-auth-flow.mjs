#!/usr/bin/env node
// Ephemeral positive-path OIDC/PKCE/TOTP test. It never prints credentials or
// tokens and always removes the temporary Kanidm person.
import crypto from 'node:crypto';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const BASE = process.env.AUTH_BASE || 'https://localhost:8444';
const REDIRECT_URI = process.env.CONSOLE_URL || 'https://localhost:8090/';
const USER = `os-e2e-${crypto.randomBytes(5).toString('hex')}`;
const PASSWORD = `${crypto.randomBytes(18).toString('base64url')}Aa9!`;
const adminB64 = execFileSync('kubectl', [
  '-n', 'opensphere-system', 'get', 'secret', 'opensphere-identity-kanidm',
  '-o', 'jsonpath={.data.token}',
], { encoding: 'utf8' }).trim();
const adminToken = Buffer.from(adminB64, 'base64').toString('utf8').trim();
const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', accept: 'application/json' };

function request(method, path, body, headers = {}, raw = false) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(raw ? body : JSON.stringify(body));
    const url = new URL(path, BASE);
    const req = https.request({
      method, hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search,
      rejectUnauthorized: false,
      headers: { ...headers, ...(data ? { 'content-length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const adminRequest = (method, path, body) => request(method, path, body, adminHeaders);
const expectStatus = (response, expected, step) => {
  if (response.status !== expected) throw new Error(`${step}: expected ${expected}, got ${response.status}`);
  return response;
};
function totp(secret) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac('sha1', Buffer.from(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
}

let created = false;
try {
  expectStatus(await adminRequest('POST', '/v1/person', { attrs: { name: [USER], displayname: ['OpenSphere E2E'] } }), 200, 'create person');
  created = true;
  expectStatus(await adminRequest('POST', '/v1/group/opensphere-console-viewers/_attr/member', [USER]), 200, 'grant console role');
  let response = expectStatus(await adminRequest('GET', `/v1/person/${USER}/_credential/_update_intent/600`), 200, 'credential intent');
  const intent = JSON.parse(response.text).token;
  response = expectStatus(await adminRequest('POST', '/v1/credential/_exchange_intent', intent), 200, 'credential exchange');
  const session = JSON.parse(response.text)[0];
  expectStatus(await adminRequest('POST', '/v1/credential/_update', [{ password: PASSWORD }, session]), 200, 'set password');
  response = expectStatus(await adminRequest('POST', '/v1/credential/_update', ['totpgenerate', session]), 200, 'generate totp');
  const secret = JSON.parse(response.text).mfaregstate.TotpCheck.secret;
  response = expectStatus(await adminRequest('POST', '/v1/credential/_update', [{ totpverify: [totp(secret), 'e2e'] }, session]), 200, 'verify totp');
  if (JSON.parse(response.text).mfaregstate === 'TotpInvalidSha1') {
    response = expectStatus(await adminRequest('POST', '/v1/credential/_update', ['totpacceptsha1', session]), 200, 'accept sha1 totp');
  }
  if (JSON.parse(response.text).can_commit !== true) throw new Error('credential session cannot commit');
  expectStatus(await adminRequest('POST', '/v1/credential/_commit', session), 200, 'commit credentials');

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URLSearchParams({
    client_id: 'opensphere-console', redirect_uri: REDIRECT_URI, response_type: 'code',
    scope: 'openid profile email groups_name groups', state: 'e2e-state', nonce: 'e2e-nonce',
    code_challenge: challenge, code_challenge_method: 'S256',
    username: USER, password: PASSWORD, totp: String(totp(secret)).padStart(6, '0'),
  }).toString();
  response = await request('POST', '/oauth2/openid/opensphere-console/authorize', authorize, { 'content-type': 'application/x-www-form-urlencoded' }, true);
  if (response.status !== 302) throw new Error(`authorize: expected 302, got ${response.status}`);
  const redirect = new URL(response.headers.location, REDIRECT_URI);
  const code = redirect.searchParams.get('code');
  if (!code || redirect.origin !== new URL(REDIRECT_URI).origin) throw new Error('authorize redirect contract failed');
  const tokenForm = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
    client_id: 'opensphere-console', code_verifier: verifier,
  }).toString();
  response = expectStatus(await request('POST', '/oauth2/openid/opensphere-console/token', tokenForm, { 'content-type': 'application/x-www-form-urlencoded' }, true), 200, 'token exchange');
  const idToken = JSON.parse(response.text).id_token;
  const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  if (claims.preferred_username !== USER || !claims.groups?.includes('opensphere-console-viewers')) throw new Error('verified identity claims mismatch');
  if (claims.iss !== 'https://localhost:8444/oauth2/openid/opensphere-console' || claims.aud !== 'opensphere-console') throw new Error('issuer/audience claims mismatch');
  console.log('OIDC E2E passed: PKCE + TOTP + role claims verified');
} finally {
  if (created) {
    const cleanup = await adminRequest('DELETE', `/v1/person/${USER}`);
    if (![200, 204, 404].includes(cleanup.status)) throw new Error(`cleanup failed: ${cleanup.status}`);
  }
}

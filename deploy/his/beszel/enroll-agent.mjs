#!/usr/bin/env node
/**
 * Create a temporary permanent universal token for first agent registration.
 *
 * Credentials are read from files and the generated Hub public key and token
 * are written to <secret-directory>/agent with mode 0600. No secret is printed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const fail = (message) => {
  process.stderr.write(`beszel enroll: ${message}\n`);
  process.exit(1);
};
const secretDir = process.argv[2] || '';
if (!path.isAbsolute(secretDir)) fail('pass the absolute Beszel secret directory');

const readSecret = (name) => {
  const value = fs.readFileSync(path.join(secretDir, name), 'utf8');
  if (!value || /[\r\n]/.test(value)) fail(`${name} must be non-empty and contain no newline`);
  return value;
};

const email = readSecret('user-email');
const password = readSecret('user-password');
const base = 'https://beszel.cc2.opl.io.kr';

async function json(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!response.ok) fail(`${new URL(url).pathname} returned HTTP ${response.status}`);
  return parsed;
}

const auth = await json(`${base}/api/collections/users/auth-with-password`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ identity: email, password }),
});
if (!auth?.token) fail('the regular Beszel user did not return an auth token');
const headers = { authorization: auth.token, accept: 'application/json' };
const info = await json(`${base}/api/beszel/info`, { headers });
if (!info?.key) fail('the Hub did not return its public agent key');

const universalToken = crypto.randomUUID();
const tokenResponse = await json(
  `${base}/api/beszel/universal-token?enable=1&permanent=1&token=${encodeURIComponent(universalToken)}`,
  { headers },
);
if (tokenResponse?.token !== universalToken
    || tokenResponse?.active !== true
    || tokenResponse?.permanent !== true) {
  fail('the Hub did not persist the first-registration token');
}

const agentDir = path.join(secretDir, 'agent');
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.chmodSync(agentDir, 0o700);
fs.writeFileSync(path.join(agentDir, 'key'), String(info.key), { mode: 0o600, flag: 'w' });
fs.writeFileSync(path.join(agentDir, 'token'), universalToken, { mode: 0o600, flag: 'w' });
fs.chmodSync(path.join(agentDir, 'key'), 0o600);
fs.chmodSync(path.join(agentDir, 'token'), 0o600);

process.stdout.write(`Agent enrollment files are ready in ${agentDir}; no secret was printed.\n`);

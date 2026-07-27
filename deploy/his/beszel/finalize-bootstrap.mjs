#!/usr/bin/env node
/**
 * After the first agent is connected, disable the universal registration token.
 * The agent's fingerprint record retains its system-specific binding.
 */
import fs from 'node:fs';
import path from 'node:path';

const fail = (message) => {
  process.stderr.write(`beszel finalize: ${message}\n`);
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
const token = readSecret('agent/token');
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
const filter = encodeURIComponent('name="CMARS-OCI-CC-02-4X24"');
const systems = await json(`${base}/api/collections/systems/records?perPage=10&filter=${filter}`, { headers });
if (!Array.isArray(systems?.items) || systems.items.length !== 1) {
  fail('the CC2 system has not registered exactly once; universal enrollment remains enabled');
}
if (systems.items[0].status !== 'up') {
  fail(`the CC2 system is ${systems.items[0].status || 'not connected'}; universal enrollment remains enabled`);
}

const disabled = await json(
  `${base}/api/beszel/universal-token?enable=0&token=${encodeURIComponent(token)}`,
  { headers },
);
if (disabled?.active !== false) fail('the universal registration token was not disabled');
process.stdout.write('CC2 is connected and universal agent registration is disabled.\n');

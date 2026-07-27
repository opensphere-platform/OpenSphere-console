#!/usr/bin/env node
/**
 * Provision the dedicated Beszel `readonly` identity used by RCC metrics.
 *
 * The existing Beszel superuser credential is read from <admin-secret-dir>.
 * A new random reader password is never printed or passed on argv. The final
 * backend Secret document is written as <output-dir>/config.json with mode
 * 0600, after the reader can authenticate and list the explicitly shared
 * system and its metrics.
 *
 * Usage:
 *   node provision-rcc-reader.mjs \
 *     /absolute/beszel-admin-secret-dir \
 *     /absolute/rcc-reader-output-dir
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const base = 'https://beszel.cc2.opl.io.kr';
const readerEmail = 'rcc-metrics-reader@cc2.opl.io.kr';
const binding = 'cc2/cmars-oci-cc-02-4x24';
const systemName = 'CMARS-OCI-CC-02-4X24';
const adminDir = process.argv[2] || '';
const outputDir = process.argv[3] || '';

function fail(message) {
  process.stderr.write(`beszel RCC reader: ${message}\n`);
  process.exit(1);
}

for (const [label, value] of [['admin secret directory', adminDir], ['output directory', outputDir]]) {
  if (!path.isAbsolute(value)) fail(`${label} must be absolute`);
}

function readSecret(name) {
  let value;
  try {
    value = fs.readFileSync(path.join(adminDir, name), 'utf8');
  } catch {
    fail(`cannot read ${name}`);
  }
  if (!value || /[\r\n]/.test(value)) fail(`${name} must be non-empty and contain no newline`);
  return value;
}

async function json(url, init = {}) {
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    fail(`${new URL(url).pathname} is unreachable`);
  }
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!response.ok) fail(`${new URL(url).pathname} returned HTTP ${response.status}`);
  return parsed;
}

function filter(value) {
  return String(value).replace(/(["\\])/g, '\\$1');
}

const identity = readSecret('user-email');
const adminPassword = readSecret('user-password');
const adminAuth = await json(`${base}/api/collections/_superusers/auth-with-password`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ identity, password: adminPassword }),
});
if (!adminAuth?.token) fail('the Beszel superuser did not return an auth token');
const adminHeaders = {
  authorization: adminAuth.token,
  accept: 'application/json',
  'content-type': 'application/json',
};

const readerPassword = crypto.randomBytes(48).toString('base64url');
const users = await json(
  `${base}/api/collections/users/records?perPage=2&fields=id,email,role,verified`
  + `&filter=${encodeURIComponent(`email="${filter(readerEmail)}"`)}`,
  { headers: adminHeaders },
);
if (!Array.isArray(users?.items) || users.items.length > 1) {
  fail('the RCC reader identity did not resolve uniquely');
}

const readerBody = {
  email: readerEmail,
  password: readerPassword,
  passwordConfirm: readerPassword,
  role: 'readonly',
  verified: true,
};
let reader;
if (users.items.length === 0) {
  reader = await json(`${base}/api/collections/users/records`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(readerBody),
  });
} else {
  reader = await json(`${base}/api/collections/users/records/${users.items[0].id}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify(readerBody),
  });
}
if (!reader?.id || reader.role !== 'readonly' || reader.verified !== true) {
  fail('the RCC reader was not persisted as a verified readonly identity');
}

const systems = await json(
  `${base}/api/collections/systems/records?perPage=2&fields=id,name,status,users`
  + `&filter=${encodeURIComponent(`name="${filter(systemName)}"`)}`,
  { headers: adminHeaders },
);
if (!Array.isArray(systems?.items) || systems.items.length !== 1) {
  fail('the CC2 Beszel system did not resolve exactly once');
}
const system = systems.items[0];
const assignedUsers = [...new Set([
  ...(Array.isArray(system.users) ? system.users : []),
  reader.id,
])];
await json(`${base}/api/collections/systems/records/${system.id}`, {
  method: 'PATCH',
  headers: adminHeaders,
  body: JSON.stringify({ users: assignedUsers }),
});

// Prove the exact credential RCC will mount can authenticate, is still
// readonly, sees one bound system and can read at least the collection shape.
const readerAuth = await json(`${base}/api/collections/users/auth-with-password`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ identity: readerEmail, password: readerPassword }),
});
if (!readerAuth?.token || readerAuth.record?.role !== 'readonly'
    || readerAuth.record?.verified !== true) {
  fail('the final RCC reader credential is not verified readonly');
}
const readerHeaders = { authorization: readerAuth.token, accept: 'application/json' };
const visibleSystems = await json(
  `${base}/api/collections/systems/records?perPage=2&fields=id,name,status`
  + `&filter=${encodeURIComponent(`name="${filter(systemName)}"`)}`,
  { headers: readerHeaders },
);
if (!Array.isArray(visibleSystems?.items) || visibleSystems.items.length !== 1
    || visibleSystems.items[0].id !== system.id) {
  fail('the RCC reader cannot see exactly its configured CC2 system');
}
const stats = await json(
  `${base}/api/collections/system_stats/records?perPage=1&sort=-created`
  + `&fields=created,stats&filter=${encodeURIComponent(`system="${system.id}"`)}`,
  { headers: readerHeaders },
);
if (!Array.isArray(stats?.items)) fail('the RCC reader cannot read system metrics');

fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
fs.chmodSync(outputDir, 0o700);
const configPath = path.join(outputDir, 'config.json');
const temporaryPath = path.join(outputDir, `.config.json.${process.pid}.tmp`);
const config = {
  email: readerEmail,
  password: readerPassword,
  systems: { [binding]: systemName },
};
fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
  flag: 'wx',
});
fs.chmodSync(temporaryPath, 0o600);
fs.renameSync(temporaryPath, configPath);
fs.chmodSync(configPath, 0o600);

process.stdout.write(
  `Beszel RCC readonly reader is provisioned for ${binding}; `
  + `server-only config written to ${configPath}.\n`,
);

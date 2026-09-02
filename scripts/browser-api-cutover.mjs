import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetConsoleApi = 'opensphere-console-api.opensphere-console.svc.cluster.local';
const allowedCapabilityStatuses = new Set(['missing', 'direct-test', 'implemented-and-verified']);
const allowedSessionPolicies = new Set(['browser-session', 'owner-admission', 'public-read', 'public-static']);
const allowedFamilyStatuses = new Set(['legacy-session-authority', 'target-routed']);

async function sourceFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await sourceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !/\.(?:spec|test)\.ts$/u.test(entry.name)) output.push(absolute);
  }
  return output;
}

function normalizePattern(value) {
  const path = value.split('?')[0]
    .replace(/\$\{[^}]+\}/gu, ':param')
    .replace(/\/{2,}/gu, '/')
    .replace(/\/$/u, '');
  return path || '/api';
}

function digest(records) {
  return 'sha256:' + createHash('sha256').update(records.map((record) => `${record.pattern}|${record.familyId}\n`).join('')).digest('hex');
}

function familyFor(pattern, families) {
  const matches = families.filter(({ prefix }) => pattern === prefix || pattern.startsWith(prefix + '/'));
  assert.equal(matches.length, 1, `browser API pattern must have exactly one target owner: ${pattern}`);
  return matches[0];
}

export async function inventoryBrowserApi({ root = repositoryRoot, contract } = {}) {
  const sourceRoot = resolve(root, contract.sourceRoot);
  assert(sourceRoot.startsWith(resolve(root) + sep), 'browser API source root escapes the repository');
  const patterns = new Set();
  for (const file of await sourceFiles(sourceRoot)) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/([`'"])(\/api(?:\/[^`'"\r\n]*)?)\1/gu)) {
      patterns.add(normalizePattern(match[2]));
    }
  }
  const records = [...patterns].sort().map((pattern) => {
    const family = familyFor(pattern, contract.families);
    return Object.freeze({ pattern, familyId: family.id, targetOwner: family.targetOwner, sessionPolicy: family.sessionPolicy });
  });
  return Object.freeze({
    sourceRoot: relative(root, sourceRoot).split(sep).join('/'),
    routePatternCount: records.length,
    setDigest: digest(records),
    records: Object.freeze(records),
  });
}

export async function verifyBrowserApiCutover({ root = repositoryRoot } = {}) {
  const contractPath = resolve(root, 'packages', 'contracts', 'browser-api-cutover.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  assert.equal(contract.schemaVersion, '1.0');
  assert(['target-migration', 'release-ready'].includes(contract.status), 'invalid browser API cutover status');
  assert.equal(contract.cutoverPolicy, 'atomic-authenticated-browser-session-authority');
  assert(
    ['legacy-browser-session-broker', contract.targetSessionAuthority].includes(contract.currentSessionAuthority),
    'invalid current browser session authority',
  );
  assert.equal(contract.targetSessionAuthority, 'console_identity.browser_session');
  assert(Array.isArray(contract.targetSessionCapabilities) && contract.targetSessionCapabilities.length > 0);
  assert.equal(new Set(contract.targetSessionCapabilities.map(({ id }) => id)).size, contract.targetSessionCapabilities.length);
  for (const capability of contract.targetSessionCapabilities) {
    assert(/^[a-z][a-z0-9-]+$/u.test(capability.id), `invalid target session capability: ${capability.id}`);
    assert(allowedCapabilityStatuses.has(capability.status), `invalid target session capability status: ${capability.id}`);
  }
  assert(Array.isArray(contract.families) && contract.families.length > 0);
  assert.equal(new Set(contract.families.map(({ id }) => id)).size, contract.families.length);
  assert.equal(new Set(contract.families.map(({ prefix }) => prefix)).size, contract.families.length);
  for (const family of contract.families) {
    assert(/^[a-z][a-z0-9-]+$/u.test(family.id), `invalid browser API family: ${family.id}`);
    assert(/^\/api(?:\/[a-z0-9-]+)+$/u.test(family.prefix), `invalid browser API prefix: ${family.id}`);
    assert(/^C_[A-Z]+$/u.test(family.targetOwner), `invalid browser API owner: ${family.id}`);
    assert(allowedSessionPolicies.has(family.sessionPolicy), `invalid browser API session policy: ${family.id}`);
    assert(allowedFamilyStatuses.has(family.status), `invalid browser API family status: ${family.id}`);
    if (family.status === 'target-routed') assert(['public-read', 'public-static'].includes(family.sessionPolicy));
  }

  const inventory = await inventoryBrowserApi({ root, contract });
  assert.equal(contract.inventory.routePatternCount, inventory.routePatternCount, 'browser API route-pattern count drifted');
  assert.equal(contract.inventory.setDigest, inventory.setDigest, 'browser API route-pattern set digest drifted');

  const nginxSource = await readFile(resolve(root, 'apps', 'console-web', 'nginx', 'default.conf.template'), 'utf8');
  const targetSessionReady = contract.targetSessionCapabilities.every(({ status }) => status === 'implemented-and-verified');
  const authenticatedFamilies = contract.families.filter(({ sessionPolicy }) => !['public-read', 'public-static'].includes(sessionPolicy));
  const authenticatedFamilyStatuses = new Set(authenticatedFamilies.map(({ status }) => status));
  assert.equal(authenticatedFamilyStatuses.size, 1, 'partial authenticated browser-family cutover is forbidden');
  const authenticatedFamiliesTargetRouted = authenticatedFamilies.every(({ status }) => status === 'target-routed');
  if (authenticatedFamiliesTargetRouted) {
    assert(targetSessionReady, 'authenticated browser families require the complete target session authority');
  }
  const authenticatedCutoverReady = targetSessionReady && authenticatedFamiliesTargetRouted;
  if (contract.status === 'release-ready') {
    assert(authenticatedCutoverReady, 'release-ready browser API contract requires atomic authenticated cutover');
    assert.equal(contract.currentSessionAuthority, contract.targetSessionAuthority, 'release-ready browser API contract must name the target session authority');
  }
  if (!authenticatedCutoverReady) {
    assert(!nginxSource.includes(targetConsoleApi), 'partial authenticated Web cutover is forbidden before target session authority completion');
  } else {
    assert(nginxSource.includes(targetConsoleApi), 'completed authenticated Web cutover is absent from Nginx');
  }
  assert(nginxSource.includes('location = /api/v1/registry'), 'public Registry route is missing');
  assert(nginxSource.includes('opensphere-registry.opensphere-console.svc.cluster.local'), 'public Registry route lost C_REG authority');

  const familyCounts = Object.fromEntries(contract.families.map(({ id }) => [id, inventory.records.filter((record) => record.familyId === id).length]));
  return Object.freeze({
    status: 'passed',
    contractStatus: contract.status,
    currentSessionAuthority: contract.currentSessionAuthority,
    routePatternCount: inventory.routePatternCount,
    setDigest: inventory.setDigest,
    familyCount: contract.families.length,
    targetSessionCapabilities: contract.targetSessionCapabilities.length,
    targetSessionReady,
    authenticatedCutoverReady,
    familyCounts: Object.freeze(familyCounts),
  });
}

async function main() {
  const contract = JSON.parse(await readFile(resolve(repositoryRoot, 'packages', 'contracts', 'browser-api-cutover.json'), 'utf8'));
  if (process.argv[2] === 'inventory') {
    process.stdout.write(JSON.stringify(await inventoryBrowserApi({ root: repositoryRoot, contract }), null, 2) + '\n');
    return;
  }
  if (!process.argv[2] || process.argv[2] === 'verify') {
    process.stdout.write(JSON.stringify(await verifyBrowserApiCutover(), null, 2) + '\n');
    return;
  }
  throw new Error('usage: node scripts/browser-api-cutover.mjs [inventory|verify]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Browser API cutover verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
/**
 * Builds the release-pinned Registry v3 document and signed plugin assets that
 * the Main Shell loads in the RCC minimal environment.
 *
 * RCC does not run the DUPA control plane, so nothing here can invent trust.
 * This script only *packages*; the shell still performs the full verification
 * chain at runtime: registry digest pin -> ECDSA P-256 detached signature ->
 * shellCompat -> capability allowlist -> entry digest -> Blob import.
 *
 * It therefore fails closed rather than emitting anything unverifiable:
 *   - the descriptor must satisfy the real `moduleDescriptorIssues` contract
 *   - checked-in digests must match the bytes on disk
 *   - a signing key is mandatory, and must match the expected public-key
 *     fingerprint; without both, no registry is written at all
 *
 * Usage:
 *   RCC_PLUGIN_SIGNING_KEY=/path/to/p256-private.pem \
 *   RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256=<sha256 of the DER SPKI public key> \
 *   RCC_PLUGIN_SIGNING_KEY_ID=opensphere-plugins-v1 \
 *   node scripts/build-plugin-registry.mjs [--out dist-plugins]
 *
 * The private key is never read from, or written to, this repository.
 */

import { createHash, sign as signOneShot } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadSigningKey, SigningKeyError } from './plugin-signing-key.mjs';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { moduleDescriptorIssues } = require(join(repoRoot, 'backend/dupa-control/controller.js'));

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = resolve(repoRoot, outIndex >= 0 ? args[outIndex + 1] : 'dist-plugins');
const packagesDir = resolve(repoRoot, 'deploy/rcc/subshells');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function fail(message) {
  console.error(`[plugin-registry] ${message}`);
  process.exit(1);
}

function loadKeyOrFail() {
  // Shared with the deploy preflight so a key rejected there cannot be
  // accepted here. It requires an externally supplied public-key fingerprint,
  // because trust.keyId is only a label.
  try {
    const { privateKey, publicKey } = loadSigningKey({ subShellDir: packagesDir });
    return {
      privateKey,
      spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      keyId: process.env.RCC_PLUGIN_SIGNING_KEY_ID || '',
    };
  } catch (error) {
    fail(error instanceof SigningKeyError ? error.message : String(error?.message || error));
  }
  return null;
}

/** Detached signature over the exact manifest bytes, IEEE-P1363 as the shell expects. */
function signManifest(privateKey, manifestText) {
  return signOneShot('sha256', Buffer.from(manifestText), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64');
}

function readPackage(packageDir) {
  const id = basename(packageDir);
  const descriptorPath = join(packageDir, 'package.descriptor.json');
  const manifestPath = join(packageDir, 'ui-shell.manifest.json');
  if (!existsSync(descriptorPath) || !existsSync(manifestPath)) {
    fail(`${id}: package must contain package.descriptor.json and ui-shell.manifest.json`);
  }

  const manifestText = readFileSync(manifestPath, 'utf8');
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  const manifest = JSON.parse(manifestText);

  const issues = moduleDescriptorIssues(descriptor);
  if (issues.length) {
    fail(`${id}: descriptor violates the DUPA module contract: ${JSON.stringify(issues)}`);
  }
  if (descriptor.id !== id) fail(`${id}: descriptor id '${descriptor.id}' does not match its directory`);

  // Cross-checks the control plane performs before publishing. Doing them here
  // keeps a drifted package out of the registry instead of shipping a package
  // the shell will silently refuse.
  for (const key of ['id', 'kind', 'hostRef', 'hostCompat', 'hostApiVersion', 'shellCompat']) {
    if (manifest[key] !== descriptor[key]) fail(`${id}: ${key} differs between manifest and descriptor`);
  }
  if ((manifest.apiBase || '') !== (descriptor.api?.basePath || '')) {
    fail(`${id}: manifest apiBase does not match descriptor api.basePath`);
  }
  if (JSON.stringify(manifest.contributions) !== JSON.stringify(descriptor.contributions)) {
    fail(`${id}: contributions differ between manifest and descriptor`);
  }
  if (!/^[A-Za-z0-9._-]+\.js$/.test(String(manifest.entry || ''))) {
    fail(`${id}: entry must be a bare .js filename, got '${manifest.entry}'`);
  }

  const entryPath = join(packageDir, manifest.entry);
  if (!existsSync(entryPath)) fail(`${id}: entry bundle ${manifest.entry} is missing`);
  const entryBytes = readFileSync(entryPath);
  if (sha256(entryBytes) !== manifest.entrySha256) {
    fail(`${id}: entrySha256 does not match ${manifest.entry}. Run scripts/build-subshell-manifest.mjs.`);
  }
  const manifestSha256 = sha256(manifestText);
  if (descriptor.manifest?.sha256 !== manifestSha256) {
    fail(`${id}: descriptor manifest.sha256 is stale. Run scripts/build-subshell-manifest.mjs.`);
  }

  return { id, descriptor, manifest, manifestText, manifestSha256, entryBytes };
}

const signing = loadKeyOrFail();

if (!existsSync(packagesDir)) fail(`no packages directory at ${packagesDir}`);
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesDir, entry.name))
  .sort();
if (!packageDirs.length) fail('no subShell packages found');

const plugins = [];
const trustedKeys = {};
const staged = [];

for (const packageDir of packageDirs) {
  const pkg = readPackage(packageDir);
  const keyId = signing.keyId || pkg.descriptor.trust.keyId;
  if (signing.keyId && signing.keyId !== pkg.descriptor.trust.keyId) {
    fail(`${pkg.id}: descriptor trust.keyId '${pkg.descriptor.trust.keyId}' does not match `
      + `RCC_PLUGIN_SIGNING_KEY_ID '${signing.keyId}'`);
  }
  if (trustedKeys[keyId] && trustedKeys[keyId] !== signing.spki) {
    fail(`${pkg.id}: conflicting public key for trust key id '${keyId}'`);
  }
  trustedKeys[keyId] = signing.spki;

  // Output mirrors the served layout exactly: this directory is copied to
  // <nginx root>/plugins, so registry URLs are stable between build and serve.
  const base = `/plugins/${pkg.id}`;
  staged.push({
    dir: join(outDir, pkg.id),
    files: [
      ['ui-shell.manifest.json', pkg.manifestText],
      ['ui-shell.manifest.json.sig', `${signManifest(signing.privateKey, pkg.manifestText)}\n`],
      [pkg.manifest.entry, pkg.entryBytes],
    ],
  });

  plugins.push({
    id: pkg.id,
    name: pkg.descriptor.displayName,
    manifest: `${base}/ui-shell.manifest.json`,
    manifestSha256: pkg.manifestSha256,
    signature: `${base}/ui-shell.manifest.json.sig`,
    keyId,
    kind: pkg.descriptor.kind,
    componentKind: pkg.descriptor.kind,
    available: true,
    hostRef: pkg.descriptor.hostRef,
    hostApiVersion: pkg.descriptor.hostApiVersion || '',
    hostCompat: pkg.descriptor.hostCompat,
    contributions: pkg.descriptor.contributions,
    artifactVersion: pkg.descriptor.version,
    icon: pkg.descriptor.nav?.icon || '',
  });
}

rmSync(outDir, { recursive: true, force: true });
for (const entry of staged) {
  mkdirSync(entry.dir, { recursive: true });
  for (const [name, content] of entry.files) writeFileSync(join(entry.dir, name), content);
}

const registry = { version: 3, trustedKeys, capabilities: [], plugins, templates: [] };
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`);

console.log(`[plugin-registry] wrote ${plugins.length} signed package(s) to ${outDir}`);
for (const plugin of plugins) console.log(`  ${plugin.id}@${plugin.artifactVersion} keyId=${plugin.keyId}`);

#!/usr/bin/env node
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const excluded = new Set(['.git', '.angular', 'dist', 'node_modules', '_skeleton', '_upstream', 'OpenSphere-design-kit']);
const axes = ['page', 'navigation', 'api', 'cli', 'manual', 'search', 'notification', 'observability'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (file, message) => { throw new Error(`${file}: ${message}`); };

function findPackages(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !excluded.has(entry.name)) findPackages(join(dir, entry.name), found);
    else if (entry.isFile() && entry.name === 'uipluginpackage.yaml') found.push(join(dir, entry.name));
  }
  return found;
}

const trustDoc = yaml.load(readFileSync(join(here, 'dupa-trusted-keys.yaml'), 'utf8'));
const trust = JSON.parse(trustDoc.data['trusted-keys.json']).trustedKeys;
const packages = findPackages(root).sort();
if (packages.length < 18) fail(root, `expected at least 18 product packages, found ${packages.length}`);

for (const packagePath of packages) {
  const docs = [];
  yaml.loadAll(readFileSync(packagePath, 'utf8'), (doc) => docs.push(doc));
  const pkg = docs.find((doc) => doc?.kind === 'UIPluginPackage');
  if (!pkg) fail(packagePath, 'UIPluginPackage document missing');
  const spec = pkg.spec || {};
  const id = pkg.metadata?.name;
  if (!['subShell', 'plugin'].includes(spec.kind)) fail(packagePath, 'invalid spec.kind');
  if (!spec.hostRef || !spec.hostApiVersion || !spec.hostCompat) fail(packagePath, 'Host relationship is incomplete');
  if (!/^sha256:[a-f0-9]{64}$/.test(spec.image?.digest || '')) fail(packagePath, 'image is not pinned by digest');
  for (const axis of axes) {
    const declaration = spec.contributions?.[axis];
    if (!declaration || typeof declaration.enabled !== 'boolean') fail(packagePath, `contribution ${axis} is not explicit`);
    if (!declaration.enabled && !String(declaration.reason || '').trim()) fail(packagePath, `disabled contribution ${axis} has no reason`);
  }

  const pluginDir = join(dirname(packagePath), 'ui-shell');
  const manifestPath = join(pluginDir, 'ui-shell.manifest.json');
  const signaturePath = join(pluginDir, 'ui-shell.manifest.json.sig');
  if (!existsSync(manifestPath) || !existsSync(signaturePath)) fail(packagePath, 'signed manifest artifacts are missing');
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const expectedManifest = String(spec.manifest?.sha256 || '').replace(/^sha256:/, '');
  if (sha256(manifestBytes) !== expectedManifest) fail(packagePath, 'manifest digest does not match Package');
  if (manifest.manifestVersion !== 3 || manifest.id !== id || manifest.kind !== spec.kind) fail(packagePath, 'Manifest v3 identity mismatch');
  for (const field of ['hostRef', 'hostApiVersion', 'hostCompat']) {
    if (manifest[field] !== spec[field]) fail(packagePath, `manifest ${field} does not match Package`);
  }
  if (JSON.stringify(manifest.contributions) !== JSON.stringify(spec.contributions)) fail(packagePath, 'contributions differ between Package and signed manifest');
  const entryPath = join(pluginDir, String(manifest.entry || '').split('/').pop());
  if (!existsSync(entryPath) || sha256(readFileSync(entryPath)) !== manifest.entrySha256) fail(packagePath, 'entry digest mismatch');
  const spki = trust[spec.trust?.keyId];
  if (!spki) fail(packagePath, `unknown trust key ${spec.trust?.keyId}`);
  const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
  const signature = Buffer.from(readFileSync(signaturePath, 'utf8').trim(), 'base64');
  if (!verify('sha256', manifestBytes, { key, dsaEncoding: 'ieee-p1363' }, signature)) fail(packagePath, 'signature verification failed');
}

console.log(`Host Contract conformance passed: ${packages.length} signed packages`);

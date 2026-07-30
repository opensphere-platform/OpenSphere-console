#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const consoleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(
  consoleRoot,
  'backend',
  'opensphere-console-backend',
  'foundation-bootstrap-bundle.js',
);
const contractPath = join(
  consoleRoot,
  'backend',
  'opensphere-console-backend',
  'foundation-bootstrap-contract.js',
);
const sourceFiles = Object.freeze([
  'foundation-contracts.yaml',
  'identity-directory-contracts.yaml',
  'control-plane-rbac.yaml',
  'control-plane.yaml',
  'foundationmodels.yaml',
]);
const otelUpstreamReference =
  'docker.io/otel/opentelemetry-collector-contrib@sha256:a2a52e43c1a80aa94120ad78c2db68780eb90e6d11c8db5b3ce2f6a0cc6b5029';
const otelOfficialMirrorReference =
  'ghcr.io/opensphere-platform/mirror/opentelemetry-collector-contrib@sha256:a2a52e43c1a80aa94120ad78c2db68780eb90e6d11c8db5b3ce2f6a0cc6b5029';

function usage() {
  return [
    'Usage:',
    '  node scripts/update-foundation-bootstrap-catalog.mjs <foundation-root> --version <yyyyMMdd.n>',
    '  node scripts/update-foundation-bootstrap-catalog.mjs <foundation-root> --check',
  ].join('\n');
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

function closedCatalogSource(fileName, text) {
  const normalized = normalize(text);
  if (fileName !== 'foundationmodels.yaml') return normalized;

  const documents = normalized.split(/\n---\n/).map(normalize);
  const excludedRbac = documents.filter(
    (document) =>
      /^kind:\s*ClusterRole(?:Binding)?\s*$/m.test(document)
      && /metadata:\s*\{\s*name:\s*foundation-models-manage(?:-admins)?\s*\}/m.test(document),
  );
  if (excludedRbac.length !== 2) {
    throw new Error(
      `foundationmodels.yaml: expected two operator-facing RBAC documents, found ${excludedRbac.length}`,
    );
  }
  return documents
    .filter((document) => !excludedRbac.includes(document))
    .join('\n---\n');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function replaceExactlyOnce(text, pattern, replacement, label) {
  const matches = text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));
  if (!matches || matches.length !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${matches?.length ?? 0}`);
  }
  return text.replace(pattern, replacement);
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const versionIndex = args.indexOf('--version');
const foundationRoot = args.find(
  (arg, index) => !arg.startsWith('--') && !(versionIndex >= 0 && index === versionIndex + 1),
);
const requestedVersion = versionIndex >= 0 ? args[versionIndex + 1] : '';

if (!foundationRoot || (!checkOnly && !/^\d{8}\.\d+$/.test(requestedVersion))) {
  throw new Error(usage());
}

const bundleSource = readFileSync(bundlePath, 'utf8');
const contractSource = readFileSync(contractPath, 'utf8');
const canaryMatch = bundleSource.match(
  /const FOUNDATION_BOOTSTRAP_CANARY_YAML = `([\s\S]*?)`;/,
);
if (!canaryMatch) {
  throw new Error('Foundation bootstrap canary source was not found');
}

const sourceCatalog = sourceFiles
  .map((fileName) => closedCatalogSource(
    fileName,
    readFileSync(join(resolve(foundationRoot), 'deploy', fileName), 'utf8'),
  ))
  .join('\n\n---\n');
const effectiveCatalog = sourceCatalog
  .replaceAll(otelUpstreamReference, otelOfficialMirrorReference);
const catalogYaml = `${effectiveCatalog}\n---\n${normalize(canaryMatch[1])}\n`;
const catalogSha256 = sha256(catalogYaml);
const compressedBase64 = gzipSync(Buffer.from(sourceCatalog, 'utf8'), {
  level: 9,
  mtime: 0,
}).toString('base64');

const currentBase64Match = bundleSource.match(
  /const FOUNDATION_BOOTSTRAP_BUNDLE_GZIP_BASE64 =\s*\r?\n\s*'([^']+)';/,
);
const currentVersionMatch = contractSource.match(
  /const FOUNDATION_BOOTSTRAP_CATALOG_VERSION = '([^']+)';/,
);
const currentShaMatch = contractSource.match(
  /const FOUNDATION_BOOTSTRAP_CATALOG_SHA256 = '([a-f0-9]{64})';/,
);
if (!currentBase64Match || !currentVersionMatch || !currentShaMatch) {
  throw new Error('Foundation bootstrap catalog constants were not found');
}

if (checkOnly) {
  const problems = [];
  if (currentBase64Match[1] !== compressedBase64) problems.push('compressed catalog');
  if (currentShaMatch[1] !== catalogSha256) problems.push('catalog sha256');
  if (problems.length > 0) {
    throw new Error(`Foundation bootstrap catalog is stale: ${problems.join(', ')}`);
  }
  process.stdout.write(
    `[verified] Foundation bootstrap catalog ${currentVersionMatch[1]} sha256:${catalogSha256}\n`,
  );
  process.exit(0);
}

const updatedBundle = replaceExactlyOnce(
  bundleSource,
  /const FOUNDATION_BOOTSTRAP_BUNDLE_GZIP_BASE64 =\s*\r?\n\s*'[^']+';/,
  `const FOUNDATION_BOOTSTRAP_BUNDLE_GZIP_BASE64 =\n  '${compressedBase64}';`,
  'compressed catalog',
);
let updatedContract = replaceExactlyOnce(
  contractSource,
  /const FOUNDATION_BOOTSTRAP_CATALOG_VERSION = '[^']+';/,
  `const FOUNDATION_BOOTSTRAP_CATALOG_VERSION = '${requestedVersion}';`,
  'catalog version',
);
updatedContract = replaceExactlyOnce(
  updatedContract,
  /const FOUNDATION_BOOTSTRAP_CATALOG_SHA256 = '[a-f0-9]{64}';/,
  `const FOUNDATION_BOOTSTRAP_CATALOG_SHA256 = '${catalogSha256}';`,
  'catalog sha256',
);

writeFileSync(bundlePath, updatedBundle, 'utf8');
writeFileSync(contractPath, updatedContract, 'utf8');
process.stdout.write(
  `[updated] Foundation bootstrap catalog ${requestedVersion} sha256:${catalogSha256}\n`,
);

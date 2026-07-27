#!/usr/bin/env node
/**
 * Repins a subShell package to the bytes actually on disk.
 *
 * The Main Shell refuses any bundle whose sha256 differs from `entrySha256`,
 * and the DUPA control plane refuses any manifest whose sha256 differs from
 * `manifest.sha256` in the descriptor. Both digests are therefore generated
 * here rather than hand-maintained.
 *
 * Usage:
 *   node scripts/build-subshell-manifest.mjs [package-dir] [--check]
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const packageDir = args.find((arg) => !arg.startsWith('--'))
  || 'deploy/rcc/subshells/linux-host-manager';

const manifestPath = join(packageDir, 'ui-shell.manifest.json');
const descriptorPath = join(packageDir, 'package.descriptor.json');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entryPath = join(packageDir, manifest.entry);
const entrySha256 = sha256(readFileSync(entryPath));

const drift = [];
if (manifest.entrySha256 !== entrySha256) {
  drift.push(`entrySha256: ${manifest.entrySha256} -> ${entrySha256}`);
  manifest.entrySha256 = entrySha256;
}

// The manifest digest must cover the exact bytes the shell will fetch, so it is
// computed after entrySha256 is settled and from the serialized form written.
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestSha256 = sha256(manifestText);

const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
if (descriptor.manifest?.sha256 !== manifestSha256) {
  drift.push(`manifest.sha256: ${descriptor.manifest?.sha256} -> ${manifestSha256}`);
  descriptor.manifest.sha256 = manifestSha256;
}

if (checkOnly) {
  if (drift.length) {
    console.error(`subshell package is out of date:\n  ${drift.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`subshell package digests are current (${packageDir})`);
  process.exit(0);
}

writeFileSync(manifestPath, manifestText);
writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
console.log(drift.length
  ? `repinned ${packageDir}:\n  ${drift.join('\n  ')}`
  : `no change (${packageDir})`);

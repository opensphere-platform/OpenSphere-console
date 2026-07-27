#!/usr/bin/env node
/**
 * Loads and validates the subShell signing key.
 *
 * Shared by the deploy preflight and the registry builder so both enforce the
 * same rules, and so a key rejected at deploy time cannot be accepted at build
 * time.
 *
 * Why a fingerprint is required: `trust.keyId` in the descriptor is only a
 * *label*. Any P-256 key can be presented under any label, so matching the
 * label proves nothing about which private key was supplied. The expected
 * public-key fingerprint must therefore come from outside the key file:
 *
 *   RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256  sha256 of the DER SPKI public key (hex)
 *
 * Derive it from the intended key with:
 *
 *   openssl pkey -in key.pem -pubout -outform DER | openssl dgst -sha256
 *
 * There is no production bypass. Tests supply the fingerprint they expect,
 * which is the same path an operator uses.
 *
 * Usage as a CLI (used by the deploy preflight):
 *   node scripts/plugin-signing-key.mjs --verify
 */

import { createHash, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FINGERPRINT_ENV = 'RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256';
export const KEY_ENV = 'RCC_PLUGIN_SIGNING_KEY';
export const KEY_ID_ENV = 'RCC_PLUGIN_SIGNING_KEY_ID';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEX64 = /^[0-9a-f]{64}$/;

export class SigningKeyError extends Error {}

const fail = (message) => { throw new SigningKeyError(message); };

/** sha256 of the DER SubjectPublicKeyInfo, the stable identity of a keypair. */
export function spkiFingerprint(publicKey) {
  return createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
}

/**
 * @param env             environment to read (defaults to process.env)
 * @param subShellDir     directory of subShell packages, for key-id cross-check
 */
export function loadSigningKey({ env = process.env, subShellDir = join(repoRoot, 'deploy/rcc/subshells') } = {}) {
  const keyPath = env[KEY_ENV];
  if (!keyPath) fail(`${KEY_ENV} is required`);
  if (!existsSync(keyPath) || !statSync(keyPath).isFile()) fail(`${KEY_ENV} '${keyPath}' is not a file`);

  let privateKey;
  try {
    privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
  } catch (error) {
    fail(`signing key is not a readable private key: ${error.message}`);
  }
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    fail('signing key must be ECDSA P-256 (prime256v1); the shell verifies P-256 only');
  }

  const publicKey = createPublicKey(privateKey);
  const fingerprint = spkiFingerprint(publicKey);

  // Identity check. Without this the preflight only proves "some P-256 key".
  const expected = String(env[FINGERPRINT_ENV] || '').trim().toLowerCase();
  if (!expected) {
    fail(`${FINGERPRINT_ENV} is required so the supplied key can be identified.\n`
      + `  The descriptor trust.keyId is only a label and proves nothing about the key.\n`
      + `  Derive the expected value from the intended key:\n`
      + `    openssl pkey -in <key.pem> -pubout -outform DER | openssl dgst -sha256\n`
      + `  This key's fingerprint is: ${fingerprint}`);
  }
  if (!HEX64.test(expected)) fail(`${FINGERPRINT_ENV} must be 64 lowercase hex characters`);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(fingerprint, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    fail(`signing key does not match ${FINGERPRINT_ENV}.\n`
      + `  expected ${expected}\n`
      + `  supplied ${fingerprint}`);
  }

  // keyId is a label, cross-checked only for internal consistency.
  const wantedKeyId = String(env[KEY_ID_ENV] || '').trim();
  const packages = [];
  let entries;
  try {
    entries = readdirSync(subShellDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (error) {
    fail(`cannot read subShell packages at ${subShellDir}: ${error.message}`);
  }
  if (!entries.length) fail(`no subShell packages found in ${subShellDir}`);
  for (const entry of entries) {
    let descriptor;
    try {
      descriptor = JSON.parse(readFileSync(join(subShellDir, entry.name, 'package.descriptor.json'), 'utf8'));
    } catch (error) {
      fail(`${entry.name}: unreadable descriptor: ${error.message}`);
    }
    const keyId = descriptor.trust?.keyId;
    if (wantedKeyId && keyId !== wantedKeyId) {
      fail(`${KEY_ID_ENV} '${wantedKeyId}' does not match ${entry.name} trust.keyId '${keyId}'`);
    }
    packages.push({ id: entry.name, keyId });
  }

  return { privateKey, publicKey, fingerprint, keyId: wantedKeyId || packages[0].keyId, packages };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = loadSigningKey();
    console.log(`signing key verified (ECDSA P-256, spki sha256 ${result.fingerprint.slice(0, 16)}…, `
      + `${result.packages.length} package(s))`);
  } catch (error) {
    console.error(error instanceof SigningKeyError ? error.message : String(error?.stack || error));
    process.exit(1);
  }
}

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputDirectory = process.argv[2] ? resolve(process.argv[2]) : '';
if (!outputDirectory) {
  throw new Error('usage: node scripts/initialize-local-cli-signing-trust.mjs <outside-repository-directory>');
}

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const privateKeyPath = resolve(outputDirectory, 'cli-update-ed25519.pem');
const metadataPath = resolve(outputDirectory, 'cli-update-trust.json');
const pair = generateKeyPairSync('ed25519');
const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyBase64 = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const metadata = {
  schemaVersion: '1.0',
  keyId: 'opensphere-cli-local-dev-v1',
  algorithm: 'Ed25519',
  publicKeyBase64,
};

await writeFile(privateKeyPath, privateKeyPem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
try {
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
} catch (error) {
  throw new Error('private key was created but trust metadata was not; remove the new key before retrying', { cause: error });
}

process.stdout.write(JSON.stringify({ privateKeyPath, metadataPath, keyId: metadata.keyId }, null, 2) + '\n');

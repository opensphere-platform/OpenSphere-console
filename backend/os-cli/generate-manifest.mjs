import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

export const localDevelopmentKeyId = 'opensphere-cli-local-dev-v1';
const localDevelopmentPrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIPKEGYePJEuX0e4DDJ+Gqkb0t9BYrRcGIoiBOSKAztNC
-----END PRIVATE KEY-----
`;

export function canonicalUpdatePayload(manifest) {
  const clean = (value, field) => {
    const text = String(value);
    if (/[\r\n\t]/.test(text)) throw new Error(`${field} contains a forbidden control character`);
    return text;
  };
  const links = [...manifest.links].sort((left, right) => {
    const leftKey = `${left.os}\0${left.arch}\0${left.href}`;
    const rightKey = `${right.os}\0${right.arch}\0${right.href}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const lines = [
    'opensphere-cli-update-v1',
    `name=${clean(manifest.name, 'name')}`,
    `version=${clean(manifest.version, 'version')}`,
  ];
  for (const link of links) {
    lines.push(`link=${clean(link.os, 'link.os')}\t${clean(link.arch, 'link.arch')}\t${clean(link.href, 'link.href')}\t${link.size}\t${clean(String(link.sha256).toLowerCase(), 'link.sha256')}`);
  }
  return `${lines.join('\n')}\n`;
}

async function signingMaterial(options) {
  const profile = options.profile || 'local';
  if (profile === 'local') {
    return { keyId: localDevelopmentKeyId, privateKey: createPrivateKey(localDevelopmentPrivateKey) };
  }
  if (profile !== 'production') throw new Error(`unsupported CLI signing profile: ${profile}`);
  if (!options.keyId || !options.privateKeyPath || !options.publicKeyBase64) {
    throw new Error('production CLI signing requires key id, private-key secret path, and pinned public key');
  }
  const privateKey = createPrivateKey(await readFile(options.privateKeyPath, 'utf8'));
  const derivedPublic = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  if (derivedPublic !== options.publicKeyBase64) {
    throw new Error('production CLI signing private key does not match the public key pinned into the CLI');
  }
  return { keyId: options.keyId, privateKey };
}

export async function generateManifest(manifestPath, artifactsDir, outputPath, options = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.links) || manifest.links.length === 0) {
    throw new Error('CLI manifest must declare at least one download link');
  }

  for (const link of manifest.links) {
    if (typeof link.href !== 'string' || !link.href.startsWith('/api/cli/')) {
      throw new Error(`invalid CLI artifact href: ${String(link.href)}`);
    }
    const filename = basename(link.href);
    const bytes = await readFile(resolve(artifactsDir, filename));
    link.size = bytes.byteLength;
    link.sha256 = createHash('sha256').update(bytes).digest('hex');
  }

  const material = await signingMaterial(options);
  manifest.signature = {
    algorithm: 'Ed25519',
    keyId: material.keyId,
    value: sign(null, Buffer.from(canonicalUpdatePayload(manifest), 'utf8'), material.privateKey).toString('base64url'),
  };

  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , manifestPath, artifactsDir, outputPath, profile = 'local', keyId = '', privateKeyPath = '', publicKeyBase64 = ''] = process.argv;
  if (!manifestPath || !artifactsDir || !outputPath) {
    throw new Error('usage: generate-manifest.mjs <manifest> <artifacts-dir> <output>');
  }
  await generateManifest(resolve(manifestPath), resolve(artifactsDir), resolve(outputPath), {
    profile, keyId, privateKeyPath, publicKeyBase64,
  });
}

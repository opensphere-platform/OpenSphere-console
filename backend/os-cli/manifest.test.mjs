import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalUpdatePayload, generateManifest, localDevelopmentKeyId } from './generate-manifest.mjs';

const localPublicKey = createPublicKey({
  key: Buffer.from('MCowBQYDK2VwAyEAq5OF9nQUWzq/tgc4cThcXpb0cjvKWiwFrmsqa36ArqI=', 'base64'),
  type: 'spki',
  format: 'der',
});
const localPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIPKEGYePJEuX0e4DDJ+Gqkb0t9BYrRcGIoiBOSKAztNC
-----END PRIVATE KEY-----
`;

test('release manifest is hydrated from the exact compiled CLI artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opensphere-cli-manifest-'));
  try {
    const artifacts = join(dir, 'artifacts');
    await mkdir(artifacts);
    const bytes = Buffer.from('compiled-cli-artifact');
    await writeFile(join(artifacts, 'os-test'), bytes);
    const input = join(dir, 'index.json');
    const output = join(artifacts, 'index.json');
    await writeFile(input, JSON.stringify({ version: '0.4.0', links: [{ href: '/api/cli/os-test', size: 1, sha256: '0'.repeat(64) }] }));

    const manifest = await generateManifest(input, artifacts, output);
    assert.equal(manifest.links[0].size, bytes.byteLength);
    assert.equal(manifest.links[0].sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(manifest.signature.algorithm, 'Ed25519');
    assert.equal(manifest.signature.keyId, localDevelopmentKeyId);
    assert.equal(verify(null, Buffer.from(canonicalUpdatePayload(manifest)), localPublicKey, Buffer.from(manifest.signature.value, 'base64url')), true);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Console and diagnostic CLI images compile the manifest version', async () => {
  const rootDockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
  const diagnosticDockerfile = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8');
  const releaseManifest = JSON.parse(await readFile(new URL('./index.json', import.meta.url), 'utf8'));
  const escapedVersion = releaseManifest.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionPattern = new RegExp(`main\\.version=${escapedVersion}`);
  assert.match(rootDockerfile, versionPattern);
  assert.match(diagnosticDockerfile, versionPattern);
  assert.match(rootDockerfile, /CLI_UPDATE_SIGNING_PROFILE/);
  assert.match(rootDockerfile, /cli_update_signing_key/);
  assert.match(rootDockerfile, /COPY --from=macos-cli \/opensphere-cli-darwin-arm64/);
  assert.match(rootDockerfile, /COPY --from=macos-cli \/opensphere-cli-darwin-amd64/);
  assert.deepEqual(
    releaseManifest.links.map(({ os, arch }) => `${os}/${arch}`),
    ['linux/amd64', 'darwin/arm64', 'darwin/amd64', 'windows/amd64']
  );
});

test('production manifest signing fails closed without release key material', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opensphere-cli-manifest-'));
  try {
    const artifact = join(dir, 'os-test');
    await writeFile(artifact, 'binary');
    const input = join(dir, 'index.json');
    await writeFile(input, JSON.stringify({ name: 'os', version: '1.0.0', links: [{ os: 'linux', arch: 'amd64', href: '/api/cli/os-test' }] }));
    await assert.rejects(
      () => generateManifest(input, dir, join(dir, 'output.json'), { profile: 'production' }),
      /production CLI signing requires/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('production manifest signing binds the secret private key to the pinned public key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opensphere-cli-manifest-'));
  try {
    await writeFile(join(dir, 'os-test'), 'binary');
    const input = join(dir, 'index.json');
    const privateKeyPath = join(dir, 'release-key.pem');
    await writeFile(input, JSON.stringify({ name: 'os', version: '1.0.0', links: [{ os: 'linux', arch: 'amd64', href: '/api/cli/os-test' }] }));
    await writeFile(privateKeyPath, localPrivateKeyPem, { mode: 0o600 });
    const options = {
      profile: 'production',
      keyId: 'opensphere-cli-production-test',
      privateKeyPath,
      publicKeyBase64: 'MCowBQYDK2VwAyEAq5OF9nQUWzq/tgc4cThcXpb0cjvKWiwFrmsqa36ArqI=',
    };
    const manifest = await generateManifest(input, dir, join(dir, 'output.json'), options);
    assert.equal(manifest.signature.keyId, options.keyId);
    assert.equal(verify(null, Buffer.from(canonicalUpdatePayload(manifest)), localPublicKey, Buffer.from(manifest.signature.value, 'base64url')), true);
    await assert.rejects(
      () => generateManifest(input, dir, join(dir, 'bad.json'), { ...options, publicKeyBase64: Buffer.alloc(44).toString('base64') }),
      /does not match the public key/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('release manifest generation fails when a declared artifact is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opensphere-cli-manifest-'));
  try {
    const input = join(dir, 'index.json');
    await writeFile(input, JSON.stringify({ links: [{ href: '/api/cli/missing' }] }));
    await assert.rejects(() => generateManifest(input, dir, join(dir, 'output.json')), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test('the independent CLI artifact image compiles the manifest version', async () => {
  const rootDockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
  const cliDockerfile = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8');
  const releaseManifest = JSON.parse(await readFile(new URL('./index.json', import.meta.url), 'utf8'));
  const escapedVersion = releaseManifest.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionPattern = new RegExp(`main\\.version=${escapedVersion}`);
  assert.match(cliDockerfile, versionPattern);
  assert.match(cliDockerfile, /CLI_UPDATE_SIGNING_PROFILE/);
  assert.match(cliDockerfile, /cli_update_signing_key/);
  assert.doesNotMatch(rootDockerfile, /backend\/os-cli|cli-manifest|cli-build|CLI_UPDATE_/);
  assert.deepEqual(
    releaseManifest.links.map(({ os, arch }) => `${os}/${arch}`),
    ['linux/amd64', 'darwin/arm64', 'darwin/amd64', 'windows/amd64']
  );
});

test('the macOS CLI is an optional build input that a release turns back into a requirement', async () => {
  const rootDockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
  const cliDockerfile = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../../.github/workflows/publish-ga-images.yml', import.meta.url), 'utf8');
  const publisher = await readFile(new URL('../../scripts/Publish-LocalEdge.ps1', import.meta.url), 'utf8');

  // Defaulting to an empty context is what lets a Windows host build the Console
  // at all; darwin needs cgo against Security.framework and cannot be produced
  // here. The copy must therefore be conditional, never a hard COPY --from.
  assert.match(cliDockerfile, /ARG CLI_DARWIN_CONTEXT=cli-darwin-absent/);
  assert.match(cliDockerfile, /ARG CLI_REQUIRE_DARWIN=false/);
  assert.match(cliDockerfile, /FROM scratch AS cli-darwin-absent/);
  assert.doesNotMatch(cliDockerfile, /COPY --from=macos-cli/, 'the macOS context must not be mandatory');
  assert.match(
    cliDockerfile,
    /LABEL org\.opencontainers\.image\.source="https:\/\/github\.com\/opensphere-platform\/OpenSphere-console"/,
    'the CLI package must be linked to its canonical GitHub source instead of inheriting the nginx base-image source',
  );
  assert.match(cliDockerfile, /if \[ "\$\{CLI_REQUIRE_DARWIN\}" = "true" \]/, 'a release must still fail without darwin');
  assert.doesNotMatch(rootDockerfile, /CLI_DARWIN_CONTEXT|CLI_REQUIRE_DARWIN/);

  // GA re-arms the requirement, so a release can never ship the reduced set.
  assert.match(workflow, /CLI_DARWIN_CONTEXT=macos-cli/);
  assert.match(workflow, /CLI_REQUIRE_DARWIN=true/);

  // The local edge publisher no longer recycles darwin binaries out of the
  // previous image, so an unrelated backend/os-cli commit cannot block it.
  // The only named context it may add is the clean, revision-recorded Setup
  // checkout consumed by the backend Platform Release executor.
  assert.doesNotMatch(publisher, /--build-context[^\r\n]*darwin/i);
  assert.match(publisher, /git clone --depth 1 --branch main \$SetupRepository \$setupCheckout/);
  assert.match(publisher, /'--build-context', "setup-cli=\$\(\$item\.SetupContext\)"/);
  assert.match(publisher, /'--build-arg', "SETUP_SOURCE_REVISION=\$setupSourceRevision"/);
  assert.doesNotMatch(publisher, /setup-cli=https?:\/\//i);
  assert.doesNotMatch(publisher, /opensphere-cli-darwin/);
  assert.doesNotMatch(publisher, /backend\/os-cli changed/);
  assert.match(publisher, /Key = 'cliArtifacts'; Image = 'opensphere-os-cli'/);
});

test('the shell proxies downloads to the independently ready CLI artifact service', async () => {
  const nginx = await readFile(new URL('../../nginx/default.conf.template', import.meta.url), 'utf8');
  const shellManifest = await readFile(new URL('../../deploy/opensphere-console.yaml', import.meta.url), 'utf8');
  const cliManifest = await readFile(new URL('./deploy.yaml', import.meta.url), 'utf8');
  const deployer = await readFile(new URL('../../scripts/Deploy-LocalEdgeCliArtifacts.ps1', import.meta.url), 'utf8');
  const cliLocation = nginx.match(/location \/api\/cli\/ \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.match(cliLocation, /set \$cli_artifact_upstream os-cli\.opensphere-console\.svc\.cluster\.local;/);
  assert.match(cliLocation, /rewrite \^\/api\/cli\/\(\.\*\)\$ \/\$1 break;/);
  assert.match(cliLocation, /proxy_pass http:\/\/\$cli_artifact_upstream:8080;/);
  assert.doesNotMatch(cliLocation, /proxy_pass http:\/\/os-cli\.opensphere-console\.svc\.cluster\.local/);
  assert.match(nginx, /cli_artifact_service_unavailable/);
  assert.match(nginx, /Console UI remains available/);
  assert.doesNotMatch(nginx, /location \/api\/cli\/[\s\S]{0,500}try_files \$uri/);
  assert.doesNotMatch(shellManifest, /\/usr\/share\/nginx\/html\/api\/cli/);
  assert.match(cliManifest, /image: __OPENSPHERE_OS_CLI_IMAGE__/);
  assert.match(cliManifest, /readinessProbe: \{ httpGet: \{ path: \/index\.json/);
  assert.match(deployer, /opensphere-os-cli@sha256:\[a-f0-9\]\{64\}/);
  assert.match(deployer, /docker buildx imagetools inspect \$Image/);
  assert.match(deployer, /deployment\/os-cli --timeout=600s/);
  assert.match(deployer, /if \(\$ready -ne '2\/2'\)/);
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

test('a build without the macOS toolchain publishes what it produced and names what it omitted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opensphere-cli-manifest-'));
  try {
    const input = join(dir, 'index.json');
    await writeFile(join(dir, 'opensphere-cli-linux-amd64'), 'linux');
    await writeFile(input, JSON.stringify({
      name: 'os', version: '1.0.0', links: [
        { os: 'linux', arch: 'amd64', href: '/api/cli/opensphere-cli-linux-amd64' },
        { os: 'darwin', arch: 'arm64', href: '/api/cli/opensphere-cli-darwin-arm64' },
      ],
    }));

    // The default stays fail-closed so a release cannot lose a platform silently.
    await assert.rejects(() => generateManifest(input, dir, join(dir, 'strict.json')), /ENOENT/);

    const manifest = await generateManifest(input, dir, join(dir, 'edge.json'), { omitMissing: true });
    assert.deepEqual(manifest.links.map((l) => `${l.os}/${l.arch}`), ['linux/amd64']);
    assert.deepEqual(manifest.omittedPlatforms, ['darwin/arm64']);
    // The signature must cover the reduced set, not the declared catalogue.
    assert.equal(manifest.signature.algorithm, 'Ed25519');
    assert.doesNotMatch(canonicalUpdatePayload(manifest), /darwin/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a build that produced no declared artifact fails even when omission is allowed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opensphere-cli-manifest-'));
  try {
    const input = join(dir, 'index.json');
    await writeFile(input, JSON.stringify({ links: [{ os: 'linux', arch: 'amd64', href: '/api/cli/absent' }] }));
    await assert.rejects(
      () => generateManifest(input, dir, join(dir, 'output.json'), { omitMissing: true }),
      /no declared CLI artifact was produced/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

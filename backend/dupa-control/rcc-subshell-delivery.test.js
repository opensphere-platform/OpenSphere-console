'use strict';

/**
 * Delivery contract for the RCC minimal environment.
 *
 * A package that satisfies the DUPA module contract is still dead weight if the
 * running deployment never serves the registry, the signed assets or the plugin
 * API namespace. These tests assert the whole delivery path end to end:
 * signing, the Registry v3 document, nginx routing and the image packaging.
 *
 * The signing key used here is generated per run and never leaves the process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const nginxConf = fs.readFileSync(path.join(repoRoot, 'nginx/rcc.conf.template'), 'utf8');
const dockerfile = fs.readFileSync(path.join(repoRoot, 'deploy/rcc/Dockerfile.web'), 'utf8');
const deployScript = fs.readFileSync(path.join(repoRoot, 'deploy/rcc/deploy-cc2.sh'), 'utf8');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** sha256 of the DER SPKI public key — the identity the preflight pins. */
function fingerprintOf(pem) {
  const spki = crypto.createPublicKey(pem).export({ format: 'der', type: 'spki' });
  return crypto.createHash('sha256').update(spki).digest('hex');
}

function buildRegistry({ keyId = 'opensphere-plugins-v1', key, fingerprint } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-registry-'));
  const outDir = path.join(workDir, 'out');
  const env = { ...process.env, RCC_PLUGIN_SIGNING_KEY_ID: keyId };
  delete env.RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256;
  if (key) {
    const keyPath = path.join(workDir, 'signing.pem');
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    env.RCC_PLUGIN_SIGNING_KEY = keyPath;
    // The expected fingerprint is supplied externally, exactly as an operator
    // must. `fingerprint: null` models an operator who omitted it.
    if (fingerprint !== null) env.RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256 = fingerprint ?? fingerprintOf(key);
  } else {
    delete env.RCC_PLUGIN_SIGNING_KEY;
  }
  let status = 0;
  let output = '';
  try {
    output = execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts/build-plugin-registry.mjs'), '--out', outDir],
      { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  return { workDir, outDir, status, output };
}

function p256Pem() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

test('a signed registry passes the exact verification chain the shell runs', () => {
  const { workDir, outDir, status } = buildRegistry({ key: p256Pem() });
  try {
    assert.equal(status, 0, 'registry build must succeed with a P-256 key');
    const registry = JSON.parse(fs.readFileSync(path.join(outDir, 'registry.json'), 'utf8'));
    assert.equal(registry.version, 3, 'the shell rejects anything but Registry contract v3');

    const entry = registry.plugins.find((plugin) => plugin.id === 'linux-host-manager');
    assert.ok(entry, 'linux-host-manager must be published');
    assert.equal(entry.available, true, 'the shell only loads entries marked available');

    const rel = (url) => path.join(outDir, url.replace('/plugins/', ''));
    const manifestText = fs.readFileSync(rel(entry.manifest), 'utf8');
    const signature = fs.readFileSync(rel(entry.signature), 'utf8').trim();

    // (1) registry digest pin
    assert.equal(sha256(manifestText), entry.manifestSha256);

    // (2) detached ECDSA P-256 signature over the manifest bytes
    const spki = registry.trustedKeys[entry.keyId];
    assert.ok(spki, 'the registry must publish the trusted public key');
    const publicKey = crypto.createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
    const verifyText = (text) => crypto.verify(
      'sha256', Buffer.from(text), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64'),
    );
    assert.equal(verifyText(manifestText), true, 'signature must verify');
    assert.equal(verifyText(`${manifestText} `), false, 'a modified manifest must fail verification');

    // (5) entry bundle digest pin
    const manifest = JSON.parse(manifestText);
    const entryBytes = fs.readFileSync(path.join(outDir, entry.id, manifest.entry));
    assert.equal(sha256(entryBytes), manifest.entrySha256);

    // Registry and manifest must agree on everything loadOne() cross-checks.
    assert.equal(manifest.id, entry.id);
    assert.equal(manifest.hostRef, entry.hostRef);
    assert.equal(manifest.kind, entry.componentKind);
    assert.equal(manifest.hostCompat, entry.hostCompat);
    assert.equal(manifest.hostApiVersion, entry.hostApiVersion);
    assert.deepEqual(manifest.contributions, entry.contributions);

    // No private key material may reach the published artifacts.
    const published = fs.readFileSync(path.join(outDir, 'registry.json'), 'utf8') + manifestText;
    assert.doesNotMatch(published, /PRIVATE KEY/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('the registry build fails closed without a signing key', () => {
  const { workDir, outDir, status, output } = buildRegistry({ key: null });
  try {
    assert.notEqual(status, 0, 'an unsigned build must not succeed');
    assert.match(output, /RCC_PLUGIN_SIGNING_KEY is required/);
    assert.equal(fs.existsSync(outDir), false, 'no registry may be emitted without a signature');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('the registry build refuses a non P-256 key', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { workDir, status, output } = buildRegistry({ key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() });
  try {
    assert.notEqual(status, 0);
    assert.match(output, /ECDSA P-256/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('the registry build refuses a key whose fingerprint was never pinned', () => {
  // A P-256 key alone proves nothing about *which* key was supplied.
  const { workDir, outDir, status, output } = buildRegistry({ key: p256Pem(), fingerprint: null });
  try {
    assert.notEqual(status, 0, 'an unpinned key must not produce a registry');
    assert.match(output, /RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256 is required/);
    assert.equal(fs.existsSync(outDir), false);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('the registry build refuses a key that does not match the pinned fingerprint', () => {
  // Substituting a different valid P-256 key must be detected.
  const impostor = p256Pem();
  const expected = fingerprintOf(p256Pem());
  const { workDir, outDir, status, output } = buildRegistry({ key: impostor, fingerprint: expected });
  try {
    assert.notEqual(status, 0, 'a substituted key must be rejected');
    assert.match(output, /does not match RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256/);
    assert.equal(fs.existsSync(outDir), false);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('the registry build refuses a malformed fingerprint rather than ignoring it', () => {
  for (const bad of ['not-hex', 'ABCDEF', 'a'.repeat(63), `${'a'.repeat(64)}0`]) {
    const { workDir, status, output } = buildRegistry({ key: p256Pem(), fingerprint: bad });
    try {
      assert.notEqual(status, 0, `fingerprint '${bad}' must be rejected`);
      assert.match(output, /must be 64 lowercase hex characters|does not match/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
});

test('the registry build refuses a key id that disagrees with the descriptor', () => {
  const { workDir, status, output } = buildRegistry({ key: p256Pem(), keyId: 'some-other-key' });
  try {
    assert.notEqual(status, 0);
    assert.match(output, /does not match/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('the registry build refuses a package whose entry digest drifted', () => {
  const entryPath = path.join(repoRoot, 'deploy/rcc/subshells/linux-host-manager/entry.js');
  const original = fs.readFileSync(entryPath);
  try {
    fs.writeFileSync(entryPath, `${original.toString()}\n// drift\n`);
    const { workDir, status, output } = buildRegistry({ key: p256Pem() });
    try {
      assert.notEqual(status, 0, 'a drifted bundle must not be published');
      assert.match(output, /entrySha256 does not match/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } finally {
    fs.writeFileSync(entryPath, original);
  }
});

test('nginx serves the registry, the signed assets and the plugin API namespace', () => {
  // Without these three routes the subShell can never load in a live RCC.
  assert.match(nginxConf, /location = \/api\/v1\/registry \{/, 'Registry v3 endpoint must be served');
  assert.match(nginxConf, /alias \/usr\/share\/nginx\/html\/plugins\/registry\.json;/);
  assert.match(nginxConf, /location \^~ \/plugins\/ \{/, 'signed plugin assets must be served');
  assert.match(nginxConf, /location \^~ \/api\/plugins\/ \{/, 'plugin API namespace must reach the backend');
  assert.match(
    nginxConf,
    /location \^~ \/api\/plugins\/ \{[\s\S]*?proxy_pass http:\/\/\$backend:8080\$request_uri;/,
    'the plugin API namespace must be proxied to the backend, not served statically',
  );
  // A cached bundle would fail its digest pin and disable the feature.
  assert.match(nginxConf, /location \^~ \/plugins\/ \{[\s\S]*?Cache-Control "no-store"/);
  assert.match(nginxConf, /location = \/api\/v1\/registry \{[\s\S]*?Cache-Control "no-store"/);
});

test('nginx routes the manual API to the backend instead of the SPA fallback', () => {
  // Without an explicit prefix these paths hit `location /` and return
  // index.html, so the Manual UI parses HTML as JSON and every document fails.
  assert.match(nginxConf, /location \^~ \/api\/manual\/ \{/, 'manual API must be routed');
  assert.match(
    nginxConf,
    /location \^~ \/api\/manual\/ \{[\s\S]*?proxy_pass http:\/\/\$backend:8080\$request_uri;/,
    'the manual API must be proxied to the backend',
  );
  assert.match(
    nginxConf,
    /location \^~ \/api\/manual\/ \{[\s\S]*?proxy_set_header Authorization \$http_authorization;/,
    'the manual API is authenticated, so the bearer token must be forwarded',
  );
  // The SPA catch-all must be the last resort, never ahead of an API prefix.
  const manualAt = nginxConf.indexOf('location ^~ /api/manual/');
  const fallbackAt = nginxConf.indexOf('location / {');
  assert.ok(manualAt >= 0 && fallbackAt >= 0 && manualAt < fallbackAt,
    'the manual prefix must be declared before the SPA fallback');
});

test('every API prefix the UI calls is routed to the backend', () => {
  // A route the SPA fallback swallows returns HTTP 200 text/html, which is far
  // harder to diagnose than a 404.
  for (const prefix of ['/api/manual/', '/api/plugins/', '/api/control-centers/']) {
    assert.ok(
      nginxConf.includes(`location ^~ ${prefix}`),
      `${prefix} has no nginx location and would fall through to index.html`,
    );
  }
});

test('the shell Content-Security-Policy still permits blob module import', () => {
  // loadOne() imports the verified bundle from a Blob URL; without blob: in
  // script-src every plugin fails to load no matter how well it is signed.
  assert.match(nginxConf, /script-src 'self' blob:/);
  assert.match(nginxConf, /connect-src 'self'/);
});

test('the web image packages signed plugins without embedding the key', () => {
  assert.match(dockerfile, /--mount=type=secret,id=rcc_plugin_signing_key/);
  assert.match(dockerfile, /scripts\/build-plugin-registry\.mjs/);
  assert.match(dockerfile, /dist-plugins \/usr\/share\/nginx\/html\/plugins/);
  // The key must only ever appear as a build secret mount.
  assert.doesNotMatch(dockerfile, /COPY[^\n]*signing[^\n]*key/i);
  assert.doesNotMatch(dockerfile, /ENV[^\n]*RCC_PLUGIN_SIGNING_KEY=/);
  assert.match(deployScript, /--secret "id=rcc_plugin_signing_key,src=\$plugin_signing_key"/);
});

test('no signing key material is checked into the package directory', () => {
  const packageDir = path.join(repoRoot, 'deploy/rcc/subshells/linux-host-manager');
  for (const name of fs.readdirSync(packageDir)) {
    assert.doesNotMatch(name, /\.pem$|\.key$/, `${name} looks like key material`);
    const content = fs.readFileSync(path.join(packageDir, name), 'utf8');
    assert.doesNotMatch(content, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, `${name} contains a private key`);
  }
  const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /dist-plugins/);
});

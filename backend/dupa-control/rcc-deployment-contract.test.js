'use strict';

/**
 * Deployment contract for the RCC workloads.
 *
 * These assertions cover the things that are only wrong at runtime: a Secret
 * the process cannot read, a security context that contradicts the volume
 * permissions, or a manifest that embeds credential material.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const repoRoot = path.resolve(__dirname, '..', '..');
const manifestPath = path.join(repoRoot, 'deploy/rcc/rcc.yaml');
const manifestText = fs.readFileSync(manifestPath, 'utf8');
const documents = yaml.loadAll(manifestText).filter(Boolean);

const backend = documents.find((doc) => doc.kind === 'Deployment' && doc.metadata.name === 'polyon-rcc-backend');
const podSpec = backend.spec.template.spec;
const container = podSpec.containers[0];

const AGENT_KEY_VOLUME = 'rcc-agent-keys';
const agentKeyMount = container.volumeMounts.find((mount) => mount.name === AGENT_KEY_VOLUME);
const agentKeyVolume = podSpec.volumes.find((volume) => volume.name === AGENT_KEY_VOLUME);
const BESZEL_READER_VOLUME = 'rcc-beszel-reader';
const beszelReaderMount = container.volumeMounts.find((mount) => mount.name === BESZEL_READER_VOLUME);
const beszelReaderVolume = podSpec.volumes.find((volume) => volume.name === BESZEL_READER_VOLUME);

test('the agent key document is actually readable by the process that needs it', () => {
  const runAsUser = podSpec.securityContext.runAsUser;
  const runAsGroup = podSpec.securityContext.runAsGroup;
  const fsGroup = podSpec.securityContext.fsGroup;
  const mode = agentKeyVolume.secret.defaultMode;

  assert.ok(Number.isInteger(runAsUser) && runAsUser > 0, 'backend must run as a non-root uid');
  // Secret volumes are owned by root:fsGroup. Without fsGroup the files stay
  // root:root and a 0400/0440 mode makes them unreadable by the container.
  assert.equal(fsGroup, runAsGroup, 'fsGroup must match runAsGroup or the Secret is unreadable');

  const ownerRead = (mode & 0o400) !== 0;
  const groupRead = (mode & 0o040) !== 0;
  const otherAny = (mode & 0o007) !== 0;
  const anyWrite = (mode & 0o222) !== 0;
  const anyExec = (mode & 0o111) !== 0;

  assert.ok(groupRead, `mode ${mode.toString(8)} does not grant group read; the fsGroup process cannot read it`);
  assert.ok(ownerRead, `mode ${mode.toString(8)} does not grant owner read`);
  assert.ok(!otherAny, `mode ${mode.toString(8)} grants world access to agent key material`);
  assert.ok(!anyWrite, `mode ${mode.toString(8)} grants write access to a read-only credential`);
  assert.ok(!anyExec, `mode ${mode.toString(8)} marks credential material executable`);
});

test('the agent key mount stays read-only and optional', () => {
  assert.equal(agentKeyMount.readOnly, true, 'credential mounts must be read-only');
  assert.equal(
    agentKeyVolume.secret.optional,
    true,
    'the control center must start before any host is enrolled; the backend fails the heartbeat closed instead',
  );
  const env = container.env.find((entry) => entry.name === 'RCC_AGENT_KEYS_FILE');
  assert.ok(env, 'RCC_AGENT_KEYS_FILE must be set');
  assert.ok(
    env.value.startsWith(`${agentKeyMount.mountPath}/`),
    `RCC_AGENT_KEYS_FILE ${env.value} is not inside the mounted path ${agentKeyMount.mountPath}`,
  );
});

test('the Beszel reader credential is server-only, read-only and safely mounted', () => {
  assert.ok(beszelReaderMount, 'the backend must mount the Beszel reader Secret');
  assert.ok(beszelReaderVolume?.secret, 'the Beszel reader must come from a Secret volume');
  assert.equal(beszelReaderMount.readOnly, true);
  assert.equal(beszelReaderVolume.secret.secretName, 'polyon-rcc-beszel-reader');
  assert.equal(beszelReaderVolume.secret.optional, true,
    'a missing optional source must degrade the metrics endpoint, not crash the RCC');
  assert.equal(beszelReaderVolume.secret.defaultMode, 0o440);

  const config = container.env.find((entry) => entry.name === 'RCC_BESZEL_CONFIG_FILE');
  const source = container.env.find((entry) => entry.name === 'RCC_BESZEL_URL');
  assert.ok(config?.value.startsWith(`${beszelReaderMount.mountPath}/`));
  assert.equal(source?.value, 'https://beszel.cc2.opl.io.kr',
    'CC2 must authenticate over the reviewed TLS origin, not cleartext or an arbitrary URL');

  // The credential belongs only to the browser-facing backend. The web and
  // maintenance workloads neither mount it nor receive its location.
  for (const deployment of documents.filter((doc) => doc.kind === 'Deployment'
      && doc.metadata.name !== 'polyon-rcc-backend')) {
    const serialized = JSON.stringify(deployment);
    assert.doesNotMatch(serialized, /rcc-beszel-reader|RCC_BESZEL_/);
  }
});

test('the restricted security posture is preserved', () => {
  assert.equal(podSpec.securityContext.runAsNonRoot, true);
  assert.equal(podSpec.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
});

test('file modes are written unambiguously across YAML versions', () => {
  // A leading-zero literal is octal under YAML 1.1 (kubectl) and decimal under
  // YAML 1.2, so the same manifest would mean two different permission sets.
  assert.doesNotMatch(
    manifestText,
    /(defaultMode|mode):\s*0\d+/,
    'write file modes in decimal; a leading-zero literal is parser-dependent',
  );
});

test('the deploy script refuses to mutate anything without a signing key', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'deploy/rcc/deploy-cc2.sh'), 'utf8');

  assert.match(script, /preflight_signing_key\(\)/, 'a signing preflight must exist');
  assert.match(script, /^preflight_signing_key$/m, 'the preflight must actually be invoked');
  assert.match(script, /scripts\/plugin-signing-key\.mjs/, 'the preflight must use the shared key validator');

  // The preflight must precede EVERY mutation, including local temp state and
  // the trap that assumes it. A trap installed earlier would fire on a rejected
  // key and act on an unset variable.
  const preflightAt = script.search(/^preflight_signing_key$/m);
  assert.ok(preflightAt > 0);
  for (const mutation of [
    'mktemp', 'trap cleanup EXIT', 'docker buildx build', 'docker build',
    'docker save', 'scp ', 'ssh -o', 'k apply',
  ]) {
    const at = script.indexOf(mutation);
    if (at < 0) continue;
    assert.ok(at > preflightAt, `'${mutation}' runs before the signing preflight`);
  }

  // The opt-out must be explicit, default off, and loudly warned.
  assert.match(script, /RCC_DISABLE_LINUX_HOST_MANAGER:-0/, 'the opt-out must default to off');
  assert.match(script, /WARNING: RCC_DISABLE_LINUX_HOST_MANAGER=1/, 'the opt-out must warn');
  assert.doesNotMatch(
    script,
    /RCC_PLUGIN_SIGNING_KEY:-\/dev\/null/,
    'a missing key must never silently default to a build without the feature',
  );
});

test('the CC2 deploy validates and streams a provisioned Beszel readonly credential', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'deploy/rcc/deploy-cc2.sh'), 'utf8');
  assert.match(script, /preflight_beszel_reader\(\)/);
  const preflightAt = script.search(/^preflight_beszel_reader$/m);
  const mutationAt = script.indexOf('mktemp');
  assert.ok(preflightAt > 0 && preflightAt < mutationAt,
    'Beszel reader validation must complete before the first mutation');
  assert.match(script, /loadBeszelReaderConfig/);
  assert.match(script, /RCC_BESZEL_READER_CONFIG/);
  assert.match(script, /create secret generic polyon-rcc-beszel-reader/);
  assert.match(script, /--from-file=config\.json="\$beszel_reader_config"/);
  assert.doesNotMatch(script, /--from-literal[^\n]*beszel/i,
    'Beszel credentials must not be exposed in command arguments');
});

test('the opt-out is named for what it does, not for relaxing signature checks', () => {
  // The old name claimed unsigned code could load, which was never true: the
  // branch omits the feature entirely. A misleading name invites misuse.
  // Assembled at runtime so this assertion does not itself contain the token
  // it forbids.
  const retired = ['RCC', 'ALLOW', 'UNSIGNED', 'SUBSHELLS'].join('_');
  const files = [
    'deploy/rcc/deploy-cc2.sh',
    'deploy/rcc/README.md',
    'docs/manual/OS-LEVEL-LINUX-HOST-CONTROL.md',
    'backend/dupa-control/rcc-subshell-delivery.test.js',
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.ok(!text.includes(retired), `${rel} still references the retired flag name`);
  }
  const script = fs.readFileSync(path.join(repoRoot, 'deploy/rcc/deploy-cc2.sh'), 'utf8');
  assert.match(script, /does not relax any signature check/, 'the opt-out must state that nothing unsigned loads');
});

test('the signing preflight identifies the key, not just its curve', () => {
  const validator = fs.readFileSync(path.join(repoRoot, 'scripts/plugin-signing-key.mjs'), 'utf8');
  assert.match(validator, /RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256/, 'an expected public-key fingerprint must be required');
  assert.match(validator, /timingSafeEqual/, 'the fingerprint comparison must be constant time');
  assert.match(validator, /prime256v1/, 'the curve must still be checked');
  // keyId must be described as a label, never as proof of key identity.
  assert.match(validator, /only a label/, 'keyId must be documented as a label');
  // No production bypass may exist.
  assert.doesNotMatch(validator, /SKIP_FINGERPRINT|UNCHECKED|allowUnpinned/i, 'there must be no fingerprint bypass');
});

test('the deploy script never creates or stores a signing key', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'deploy/rcc/deploy-cc2.sh'), 'utf8');
  assert.doesNotMatch(script, /genpkey|ecparam[^\n]*-genkey|openssl\s+genrsa/, 'the deploy must not generate key material');
  assert.doesNotMatch(script, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  // The private key may only reach the build as a BuildKit secret. The expected
  // public-key fingerprint is deliberately a build arg: it is public data, and
  // recording it in image history is useful provenance.
  assert.match(script, /--secret "id=rcc_plugin_signing_key,src=\$plugin_signing_key"/);
  const buildArgs = [...script.matchAll(/--build-arg "([A-Z0-9_]+)=/g)].map((m) => m[1]);
  for (const name of buildArgs) {
    assert.ok(
      !/SIGNING_KEY$/.test(name),
      `${name} passes private key material through image history; use a BuildKit secret`,
    );
  }
  assert.ok(
    buildArgs.includes('RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256'),
    'the expected public-key fingerprint must reach the image build',
  );

  const dockerfile = fs.readFileSync(path.join(repoRoot, 'deploy/rcc/Dockerfile.web'), 'utf8');
  // Anchored to the exact name so the public fingerprint ARG is not mistaken
  // for the private key.
  assert.doesNotMatch(dockerfile, /^ARG\s+RCC_PLUGIN_SIGNING_KEY(\s|=|$)/m, 'the private key must not be a build ARG');
  assert.match(dockerfile, /^ARG RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256/m, 'the fingerprint must be declared as an ARG');
  assert.match(
    dockerfile,
    /RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256="\$RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256"/,
    'the fingerprint must be forwarded to the registry build, or the build cannot verify the key',
  );
});

test('no credential material is embedded in the deployment manifest', () => {
  assert.equal(documents.filter((doc) => doc.kind === 'Secret').length, 0, 'secrets must be created out of band');
  assert.doesNotMatch(manifestText, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  for (const entry of container.env) {
    if (typeof entry.value !== 'string') continue;
    assert.doesNotMatch(entry.value, /^[A-Fa-f0-9]{32,}$/, `${entry.name} looks like inline key material`);
    assert.doesNotMatch(entry.value, /^eyJ[A-Za-z0-9_-]{10,}\./, `${entry.name} looks like an inline token`);
  }
});

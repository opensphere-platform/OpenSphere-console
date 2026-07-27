'use strict';

/**
 * Deployment contract for the HIS-owned Beszel supplemental host dashboard.
 *
 * The assertions intentionally defend the architectural boundary, not only
 * YAML syntax. Beszel is RCC's bounded Linux-host time-series source, but must
 * never become an RCC control path, Kubernetes authority, containerd observer
 * or inbound host service.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const repoRoot = path.resolve(__dirname, '..', '..');
const packageDir = path.join(repoRoot, 'deploy', 'his', 'beszel');
const oldPackageDir = path.join(repoRoot, 'deploy', 'rcc', 'beszel');
const read = (name) => fs.readFileSync(path.join(packageDir, name), 'utf8');
const manifests = ['00-namespace-storage.yaml', '10-hub.yaml', '20-network-ingress.yaml']
  .flatMap((name) => yaml.loadAll(read(name)).filter(Boolean));
const byKind = (kind) => manifests.filter((object) => object.kind === kind);
const named = (kind, name) => manifests.find((object) =>
  object.kind === kind && object.metadata?.name === name);
const hub = named('Deployment', 'beszel-hub');
const container = hub.spec.template.spec.containers[0];
const podSpec = hub.spec.template.spec;
const env = Object.fromEntries(container.env.map((item) => [item.name, item]));
const serviceUnit = read('agent/beszel-agent.service');
const agentEnv = read('agent/agent.env.example');
const installer = read('agent/install.sh');
const readme = read('README.md');
const release = read('release.env');
const readerProvision = read('provision-rcc-reader.mjs');
const rccYaml = fs.readFileSync(path.join(repoRoot, 'deploy', 'rcc', 'rcc.yaml'), 'utf8');
const rccDeploy = fs.readFileSync(path.join(repoRoot, 'deploy', 'rcc', 'deploy-cc2.sh'), 'utf8');
const metricsAdapter = fs.readFileSync(
  path.join(repoRoot, 'backend', 'opensphere-console-backend', 'beszel-metrics-api.js'),
  'utf8',
);

test('the package is HIS-owned and no obsolete RCC Beszel package remains', () => {
  assert.equal(fs.existsSync(oldPackageDir), false,
    'Beszel must not live under deploy/rcc or enter the RCC deployment lifecycle');
  assert.ok(fs.existsSync(packageDir));
  const namespace = named('Namespace', 'beszel-system');
  assert.equal(namespace.metadata.labels['polyon.io/authority-owner'], 'his');
  assert.equal(namespace.metadata.labels['polyon.io/signal-role'],
    'supplemental-host-diagnostics');
  assert.equal(namespace.metadata.labels['pod-security.kubernetes.io/enforce'], 'restricted');
});

test('the verified release, image digest and ARM64 archive checksum are fixed', () => {
  assert.match(release, /^BESZEL_VERSION=0\.18\.7$/m);
  assert.match(release,
    /^BESZEL_HUB_IMAGE=docker\.io\/henrygd\/beszel@sha256:a849ad80814b6a1a3be665304dcace5d4854b3bed7bde4dd1227e8ce1b82d477$/m);
  assert.match(release,
    /^BESZEL_AGENT_ARCHIVE_SHA256=0134256068937cab74b7f26e37007a4b5bf3d52cd40496a8b8b0ebbbb1a6f02f$/m);
  assert.equal(container.image,
    'docker.io/henrygd/beszel@sha256:a849ad80814b6a1a3be665304dcace5d4854b3bed7bde4dd1227e8ce1b82d477');
  assert.doesNotMatch(container.image, /:latest\b/);
});

test('storage survives ordinary deletion and the Hub has one SQLite writer', () => {
  const storage = named('StorageClass', 'beszel-local-retain');
  const claim = named('PersistentVolumeClaim', 'beszel-hub-data');
  assert.equal(storage.provisioner, 'rancher.io/local-path');
  assert.equal(storage.reclaimPolicy, 'Retain');
  assert.equal(storage.volumeBindingMode, 'WaitForFirstConsumer');
  assert.equal(claim.spec.storageClassName, storage.metadata.name);
  assert.deepEqual(claim.spec.accessModes, ['ReadWriteOnce']);
  assert.equal(claim.spec.resources.requests.storage, '5Gi');
  assert.equal(hub.spec.replicas, 1);
  assert.equal(hub.spec.strategy.type, 'Recreate');
});

test('the Hub has no Kubernetes authority or projected API credential', () => {
  const account = named('ServiceAccount', 'beszel-hub');
  assert.equal(account.automountServiceAccountToken, false);
  assert.equal(podSpec.automountServiceAccountToken, false);
  assert.equal(podSpec.serviceAccountName, account.metadata.name);
  assert.equal(byKind('Role').length, 0);
  assert.equal(byKind('RoleBinding').length, 0);
  assert.equal(byKind('ClusterRole').length, 0);
  assert.equal(byKind('ClusterRoleBinding').length, 0);
});

test('the Hub pod satisfies the restricted security boundary', () => {
  assert.equal(podSpec.securityContext.runAsNonRoot, true);
  assert.equal(podSpec.securityContext.runAsUser, 1000);
  assert.equal(podSpec.securityContext.runAsGroup, 1000);
  assert.equal(podSpec.securityContext.fsGroup, 1000);
  assert.equal(podSpec.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  for (const field of ['hostNetwork', 'hostPID', 'hostIPC']) {
    assert.notEqual(podSpec[field], true, `Hub requests ${field}`);
  }
  assert.equal((container.ports || []).some((port) => port.hostPort), false);
});

test('the Hub has only durable data and bounded temporary writable paths', () => {
  assert.deepEqual(
    container.volumeMounts.map((mount) => [mount.name, mount.mountPath]).sort(),
    [['data', '/beszel_data'], ['tmp', '/tmp']],
  );
  assert.equal(podSpec.volumes.some((volume) => volume.hostPath), false);
  const tmp = podSpec.volumes.find((volume) => volume.name === 'tmp');
  assert.equal(tmp.emptyDir.sizeLimit, '128Mi');
});

test('health, resources and immutable operating mode are explicit', () => {
  for (const probe of [container.startupProbe, container.readinessProbe, container.livenessProbe]) {
    assert.equal(probe.httpGet.path, '/api/health');
    assert.equal(probe.httpGet.port, 'http');
  }
  assert.deepEqual(container.resources.requests, { cpu: '25m', memory: '64Mi' });
  assert.deepEqual(container.resources.limits, { cpu: '500m', memory: '512Mi' });
  assert.deepEqual(container.args, [
    'serve',
    '--http=0.0.0.0:8090',
    '--encryptionEnv=BESZEL_PB_ENCRYPTION_KEY',
  ]);
  assert.equal(env.BESZEL_HUB_CHECK_UPDATES.value, 'false');
  assert.equal(env.BESZEL_HUB_CONTAINER_DETAILS.value, 'false');
  assert.equal(env.BESZEL_HUB_SHARE_ALL_SYSTEMS.value, 'false');
  assert.equal(env.BESZEL_HUB_USER_CREATION.value, 'false');
  assert.equal(env.AUTO_LOGIN, undefined);
  assert.equal(env.TRUSTED_AUTH_HEADER, undefined);
});

test('secrets arrive by reference and no Kubernetes Secret is committed', () => {
  assert.equal(byKind('Secret').length, 0);
  const encryption = env.BESZEL_PB_ENCRYPTION_KEY.valueFrom.secretKeyRef;
  assert.deepEqual(encryption, {
    name: 'beszel-hub-encryption',
    key: 'pb-encryption-key',
    optional: false,
  });
  for (const name of ['BESZEL_HUB_USER_EMAIL', 'BESZEL_HUB_USER_PASSWORD']) {
    assert.equal(env[name].valueFrom.secretKeyRef.name, 'beszel-hub-bootstrap');
    assert.equal(env[name].valueFrom.secretKeyRef.optional, true);
  }
  for (const name of ['00-namespace-storage.yaml', '10-hub.yaml', '20-network-ingress.yaml']) {
    assert.doesNotMatch(read(name), /^\s*(data|stringData):/m);
  }
});

test('the only public route is the dedicated TLS origin through Traefik', () => {
  const ingress = named('Ingress', 'beszel-hub');
  assert.equal(ingress.spec.ingressClassName, 'traefik');
  assert.deepEqual(ingress.spec.tls[0].hosts, ['beszel.cc2.opl.io.kr']);
  assert.equal(ingress.spec.rules[0].host, 'beszel.cc2.opl.io.kr');
  assert.equal(ingress.spec.rules[0].http.paths[0].path, '/');
  assert.equal(ingress.metadata.annotations[
    'traefik.ingress.kubernetes.io/router.tls.certresolver'], 'letsencrypt');
  const service = named('Service', 'beszel-hub');
  assert.equal(service.spec.type, 'ClusterIP');
  assert.equal(service.spec.ports[0].port, 8090);
});

test('network policy defaults closed and admits only Traefik to the Hub', () => {
  const deny = named('NetworkPolicy', 'beszel-default-deny');
  assert.deepEqual(deny.spec.podSelector, {});
  assert.deepEqual(deny.spec.policyTypes, ['Ingress', 'Egress']);
  const ingress = named('NetworkPolicy', 'beszel-hub-ingress-from-traefik');
  assert.equal(ingress.spec.ingress.length, 1);
  const peer = ingress.spec.ingress[0].from[0];
  assert.equal(peer.namespaceSelector.matchLabels['kubernetes.io/metadata.name'], 'kube-system');
  assert.equal(peer.podSelector.matchLabels['app.kubernetes.io/name'], 'traefik');
  assert.deepEqual(ingress.spec.ingress[0].ports, [{ protocol: 'TCP', port: 8090 }]);
  assert.equal(ingress.spec.egress, undefined);
});

test('there is no Kubernetes agent, host mount, runtime socket or inbound host port', () => {
  assert.equal(byKind('DaemonSet').length, 0);
  const allYaml = ['00-namespace-storage.yaml', '10-hub.yaml', '20-network-ingress.yaml']
    .map(read).join('\n');
  assert.doesNotMatch(allYaml, /\bhostPath\b|\bhostPort\b|\bhostNetwork\b/);
  assert.doesNotMatch(allYaml, /docker\.sock|containerd\.sock|k3s\/containerd/);
  assert.doesNotMatch(agentEnv, /^BESZEL_AGENT_LISTEN=/m);
  assert.match(agentEnv, /^BESZEL_AGENT_DISABLE_SSH=true$/m);
  assert.match(agentEnv, /^BESZEL_AGENT_DOCKER_HOST=$/m);
});

test('the host agent is non-root, outbound-only and systemd-sandboxed', () => {
  assert.match(serviceUnit, /^User=beszel$/m);
  assert.match(serviceUnit, /^Group=beszel$/m);
  assert.match(serviceUnit, /^NoNewPrivileges=yes$/m);
  assert.match(serviceUnit, /^ProtectSystem=strict$/m);
  assert.match(serviceUnit, /^ProtectHome=yes$/m);
  assert.match(serviceUnit, /^CapabilityBoundingSet=$/m);
  assert.match(serviceUnit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
  assert.match(agentEnv, /^BESZEL_AGENT_HUB_URL=https:\/\/beszel\.cc2\.opl\.io\.kr$/m);
  assert.match(agentEnv, /^BESZEL_AGENT_KEY_FILE=\/etc\/beszel-agent\/key$/m);
  assert.match(agentEnv, /^BESZEL_AGENT_TOKEN_FILE=\/etc\/beszel-agent\/token$/m);
  assert.doesNotMatch(serviceUnit, /User=root|AmbientCapabilities=\S|PrivateDevices=yes|ProcSubset=/);
});

test('the installer verifies the exact archive before extracting or installing', () => {
  const digestCheck = installer.indexOf('actual="$(sha256sum');
  const extract = installer.indexOf('tar -xzf');
  const installBinary = installer.indexOf('install -o root -g root -m 0755 "$tmp/beszel-agent"');
  assert.ok(digestCheck >= 0 && extract > digestCheck && installBinary > extract);
  assert.match(installer,
    /archive_sha256="0134256068937cab74b7f26e37007a4b5bf3d52cd40496a8b8b0ebbbb1a6f02f"/);
  assert.match(installer, /systemctl enable --now beszel-agent\.service/);
  assert.match(installer, /port 45876 is listening/);
  assert.doesNotMatch(installer, /releases\/latest|beszel-agent update/);
});

test('bootstrap refuses missing DNS and never puts secret values on argv', () => {
  const bootstrap = read('bootstrap.sh');
  assert.match(bootstrap, /must resolve to \$expected_ip before Ingress and ACME are created/);
  assert.match(bootstrap, /--from-file=pb-encryption-key=/);
  assert.match(bootstrap, /--from-file=user-password=/);
  assert.doesNotMatch(bootstrap, /--from-literal/);
  assert.doesNotMatch(bootstrap, /\bset -x\b|\bcat "\$secret_dir/);
});

test('first-registration authority is closed after one connected CC2 system', () => {
  const enroll = read('enroll-agent.mjs');
  const finalize = read('finalize-bootstrap.mjs');
  const finalizeShell = read('finalize-bootstrap.sh');
  assert.match(enroll, /universal-token\?enable=1&permanent=1/);
  assert.match(enroll, /mode: 0o600/);
  assert.match(finalize, /CMARS-OCI-CC-02-4X24/);
  assert.match(finalize, /systems\.items\[0\]\.status !== 'up'/);
  assert.match(finalize, /universal-token\?enable=0/);
  assert.match(finalizeShell, /delete secret beszel-hub-bootstrap/);
  assert.match(finalizeShell, /rollout restart deployment\/beszel-hub/);
});

test('RCC consumes Beszel only through a dedicated bounded readonly adapter', () => {
  assert.match(readerProvision, /role: 'readonly'/);
  assert.match(readerProvision, /crypto\.randomBytes\(48\)/);
  assert.match(readerProvision, /mode: 0o600/);
  assert.match(readerProvision, /cc2\/cmars-oci-cc-02-4x24/);
  assert.doesNotMatch(readerProvision, /console\.log\([^)]*(password|token)/i);

  assert.match(rccYaml, /RCC_BESZEL_URL, value: "https:\/\/beszel\.cc2\.opl\.io\.kr"/);
  assert.match(rccYaml, /secretName: polyon-rcc-beszel-reader/);
  assert.match(rccYaml, /mountPath: \/etc\/rcc\/beszel/);
  assert.doesNotMatch(rccYaml, /^kind:\s*Secret$/m);
  assert.match(rccDeploy, /RCC_BESZEL_READER_CONFIG/);
  assert.match(rccDeploy, /--from-file=config\.json=/);
  assert.doesNotMatch(rccDeploy, /--from-literal=.*beszel/i);

  assert.match(metricsAdapter, /record\?\.role !== 'readonly'/);
  assert.match(metricsAdapter, /schemaVersion: 'rcc\.host\.metrics\/v1'/);
  assert.match(metricsAdapter, /String\(req\.method \|\| ''\)\.toUpperCase\(\) !== 'GET'/);
  assert.match(metricsAdapter, /action: 'rcc\.host\.metrics\.read'/);
  assert.doesNotMatch(metricsAdapter, /PATCH|DELETE|PUT/);

  assert.match(readme, /not an RCC control API, operation audit trail or host authority/);
  assert.match(readme, /not monitor K3s containers/);
  assert.match(readme, /outage\s+degrades only the Metrics tab/);
  assert.match(readme, /not the RCC readiness gate/);
});

test('RCC deployment never installs or upgrades the HIS-owned Beszel service', () => {
  assert.doesNotMatch(rccDeploy, /deploy\/his\/beszel|beszel-hub|bootstrap\.sh|enroll-agent/);
  assert.doesNotMatch(rccYaml, /kind:\s*(Deployment|Service)[\s\S]{0,200}name:\s*beszel-hub/);
  assert.match(readme, /installed and upgraded only as an explicit HIS-owned/);
  assert.match(readme, /never installs or upgrades Beszel/);
});

test('backup limits and a restore drill are explicit acceptance gates', () => {
  assert.match(readme, /S3-compatible bucket/);
  assert.match(readme, /retain at least 14 generations/);
  assert.match(readme, /restore into an isolated namespace\/PVC/);
  assert.match(readme, /Until an off-node restore succeeds, Beszel history is best-effort only/);
});

test('the operational package contains no unresolved template marker', () => {
  const files = fs.readdirSync(packageDir, { recursive: true })
    .filter((name) => fs.statSync(path.join(packageDir, name)).isFile());
  for (const name of files) {
    assert.doesNotMatch(read(name), /__PLACEHOLDER__|TODO_REPLACE|CHANGE_ME/,
      `${name} contains an unresolved deployment marker`);
  }
});

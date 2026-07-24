const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { moduleDescriptorIssues, packageFromInspection, deploymentManifest, hpaManifest, networkPolicyManifest, telemetryDescriptor, observerClusterRoleManifest, infrastructureManagerClusterRoleManifest, publishedPluginEntry, parseModuleImageReference, runnablePlatformManifests, governedSourceRepository, attestationArguments } = require('./controller');

const off = { enabled: false, reason: 'not published' };
const descriptor = {
  schemaVersion: 1, id: 'cluster-manager', kind: 'subShell', displayName: 'Cluster Manager', version: '1.0.0', owner: 'opensphere-platform', description: 'Cluster operations',
  hostRef: 'main', hostApiVersion: '1.0.0', hostCompat: '>=1.0.0 <2.0.0', shellCompat: '>=0.2.0 <0.9.0', sdkVersion: '0.2.0', permissions: ['page:register', 'api:proxy'], permissionProfile: 'cluster-observer-v1',
  runtime: { port: 8080, healthPath: '/healthz', serviceAccountName: 'opensphere-cluster-manager', resources: { cpuRequest: '50m', memoryRequest: '128Mi', cpuLimit: '500m', memoryLimit: '512Mi' } },
  manifest: { path: '/plugins/ui-shell.manifest.json', sha256: 'a'.repeat(64), signaturePath: '/plugins/ui-shell.manifest.json.sig' }, trust: { keyId: 'opensphere-plugins-v1' }, api: { basePath: '/api/plugins/cluster-manager' },
  contributions: { page: { enabled: true }, navigation: { ...off, mode: 'none' }, api: { enabled: true, basePath: '/api/plugins/cluster-manager' }, cli: off, manual: { ...off, mode: 'none' }, search: { ...off, mode: 'none' }, notification: { ...off, frontend: false, backend: false }, observability: { ...off, logs: false, metrics: false, traces: false } },
};

test('accepts SDK module package and materializes digest-pinned package', () => {
  assert.deepEqual(moduleDescriptorIssues(descriptor), []);
  const digest = `sha256:${'b'.repeat(64)}`;
  const pkg = packageFromInspection({
    descriptor,
    repository: 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager',
    digest,
    requestedImage: 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager:edge',
    channel: 'edge', resolvedAt: '2026-07-19T00:00:00.000Z',
    source: 'https://github.com/opensphere-platform/OpenSphere-shell-clusterManager',
    revision: 'c'.repeat(40),
    registryCredentialsRequired: true,
    image: `ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@${digest}`,
  });
  assert.equal(pkg.spec.permissionProfile, 'cluster-observer-v1');
  assert.equal(pkg.spec.image.repository, 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager');
  assert.equal(pkg.spec.resolution.requestedChannel, 'edge');
  assert.equal(pkg.spec.resolution.resolvedDigest, digest);
  assert.equal(pkg.spec.resolution.registryCredentialsRequired, true);
  assert.equal(pkg.spec.resolution.evidenceRefs.length, 2);
});

test('binds attestations to an OpenSphere repository main-branch workflow', () => {
  const repository = governedSourceRepository('https://github.com/opensphere-platform/OpenSphere-shell-foundation');
  assert.equal(repository, 'opensphere-platform/OpenSphere-shell-foundation');
  assert.equal(governedSourceRepository('https://github.com/other/repository'), '');
  const image = `ghcr.io/opensphere-platform/opensphere-shell-foundation@sha256:${'d'.repeat(64)}`;
  const args = attestationArguments(image, repository, 'https://slsa.dev/provenance/v1');
  assert.deepEqual(args.slice(0, 4), ['attestation', 'verify', `oci://${image}`, '--bundle-from-oci']);
  assert.ok(args.includes('opensphere-platform/OpenSphere-shell-foundation/.github/workflows/publish-image.yml'));
  assert.ok(args.includes('refs/heads/main'));
  assert.ok(args.includes('--deny-self-hosted-runners'));
});

test('accepts only OpenSphere digest or governed channel image references', () => {
  const digest = 'a'.repeat(64);
  assert.deepEqual(parseModuleImageReference(`ghcr.io/opensphere-platform/opensphere-shell-foundation@sha256:${digest}`), {
    repositoryPath: 'opensphere-platform/opensphere-shell-foundation',
    repository: 'ghcr.io/opensphere-platform/opensphere-shell-foundation',
    reference: `sha256:${digest}`,
    channel: null,
  });
  for (const channel of ['edge', 'candidate', 'stable']) {
    assert.equal(parseModuleImageReference(`ghcr.io/opensphere-platform/opensphere-shell-foundation:${channel}`).channel, channel);
  }
  for (const invalid of [
    'ghcr.io/opensphere-platform/opensphere-shell-foundation:latest',
    'ghcr.io/other/opensphere-shell-foundation:edge',
    'ghcr.io/opensphere-platform/mirror/postgresql:edge',
    'docker.io/opensphere-platform/opensphere-shell-foundation:edge',
  ]) assert.throws(() => parseModuleImageReference(invalid), (error) => error.reason === 'InvalidImageReference');
});

test('selects runnable multi-architecture manifests and ignores attestations', () => {
  const sha = (char) => `sha256:${char.repeat(64)}`;
  const selected = runnablePlatformManifests({ manifests: [
    { digest: sha('c'), platform: { os: 'unknown', architecture: 'unknown' } },
    { digest: sha('b'), platform: { os: 'linux', architecture: 'arm64' } },
    { digest: sha('a'), platform: { os: 'linux', architecture: 'amd64' } },
    { digest: sha('d'), platform: { os: 'windows', architecture: 'amd64' } },
  ] });
  assert.deepEqual(selected.map((entry) => `${entry.platform.os}/${entry.platform.architecture}`), ['linux/amd64', 'linux/arm64']);
});

test('rejects unapproved permission profile and observer role is read-only', () => {
  const bad = structuredClone(descriptor); bad.permissionProfile = 'cluster-admin';
  assert.ok(moduleDescriptorIssues(bad).some((issue) => issue.code === 'UnknownPermissionProfile'));
  const rules = observerClusterRoleManifest().rules;
  const verbs = rules.flatMap((rule) => rule.verbs);
  assert.deepEqual([...new Set(verbs)].sort(), ['get', 'list', 'watch']);
  assert.ok(rules.some((rule) => rule.apiGroups.includes('networking.k8s.io') && rule.resources.includes('ingressclasses')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('cert-manager.io') && rule.resources.includes('clusterissuers')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('acme.cert-manager.io') && rule.resources.includes('challenges')));
  assert.ok(!rules.some((rule) => rule.resources.includes('secrets')));
  assert.ok(!rules.some((rule) => rule.resources.includes('users') || rule.verbs.includes('impersonate')));
});

test('HIS manager profile is rejected: Console modules cannot own HIS lifecycle', () => {
  const his = structuredClone(descriptor);
  his.permissionProfile = 'cluster-his-manager-v1';
  assert.ok(moduleDescriptorIssues(his).some((issue) => issue.code === 'UnknownPermissionProfile'));
});

test('infrastructure manager adds only consumer-side storage integration writes', () => {
  const infrastructure = structuredClone(descriptor);
  infrastructure.permissionProfile = 'cluster-infrastructure-manager-v1';
  assert.deepEqual(moduleDescriptorIssues(infrastructure), []);
  const rules = infrastructureManagerClusterRoleManifest().rules;
  assert.ok(rules.some((rule) => rule.apiGroups.includes('storage.k8s.io') && rule.resources.includes('storageclasses') && rule.verbs.includes('create')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('snapshot.storage.k8s.io') && rule.resources.includes('volumesnapshotclasses') && rule.verbs.includes('delete')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('snapshot.storage.k8s.io') && rule.resources.includes('volumesnapshots') && rule.verbs.includes('create')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('ceph.rook.io') && rule.verbs.includes('create')));
  assert.ok(!rules.some((rule) => rule.apiGroups.includes('monitoring.coreos.com')));
  assert.ok(!rules.some((rule) => rule.resources.includes('clusterroles') && rule.verbs.includes('escalate')));
  assert.ok(!rules.some((rule) => rule.verbs.includes('impersonate')));
  assert.ok(!rules.some((rule) => rule.resources.includes('users')));
});

test('managed plugin workload receives only the Supabase-backed Console identity contract', () => {
  const pkg = packageFromInspection({ descriptor, repository: 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager', digest: `sha256:${'b'.repeat(64)}` });
  pkg.metadata = { ...pkg.metadata, uid: '00000000-0000-0000-0000-000000000000' };
  const deployment = deploymentManifest(pkg);
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.ok(container.env.some((item) => item.name === 'CONSOLE_IDENTITY_URL' && item.value.includes('opensphere-console-backend.opensphere-console.svc')));
  assert.ok(container.env.some((item) => item.name === 'CONSOLE_AUTH_PROVIDER' && item.value === 'supabase'));
  assert.ok(!container.env.some((item) => /^(KANIDM_|TOKEN_INTROSPECTION_)/.test(item.name)));
  assert.deepEqual(container.volumeMounts, []);
  assert.deepEqual(pod.volumes, []);
});

test('private package workload uses the managed GHCR imagePullSecret', () => {
  const pkg = packageFromInspection({
    descriptor,
    repository: 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager',
    digest: `sha256:${'b'.repeat(64)}`,
    registryCredentialsRequired: true,
  });
  pkg.metadata = { ...pkg.metadata, uid: '00000000-0000-0000-0000-000000000000' };
  assert.deepEqual(deploymentManifest(pkg).spec.template.spec.imagePullSecrets, [{ name: 'opensphere-ghcr-pull' }]);
});

test('runtime Registry projection satisfies native CLI identity fields', () => {
  const pkg = packageFromInspection({ descriptor, repository: 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager', digest: `sha256:${'b'.repeat(64)}` });
  pkg.metadata = { ...pkg.metadata, name: 'cluster-manager' };
  const entry = publishedPluginEntry(pkg, '/api/plugins/cluster-manager/plugins/ui-shell.manifest.json', '/api/plugins/cluster-manager/plugins/ui-shell.manifest.json.sig');
  assert.equal(entry.id, 'cluster-manager');
  assert.equal(entry.name, 'Cluster Manager');
  assert.equal(entry.manifestSha256, 'a'.repeat(64));
  assert.equal(entry.updateState, 'ChannelUnavailable');
});

test('runtime Registry projects the signed CLI contribution for dynamic os dispatch', () => {
  const cliDescriptor = structuredClone(descriptor);
  cliDescriptor.nav = { band: '구축 Build', label: 'Cluster Manager' };
  cliDescriptor.contributions.cli = { enabled: true, namespace: 'cluster', manifestPath: '/cli/manifest' };
  const pkg = packageFromInspection({ cli: true, descriptor: cliDescriptor, repository: 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager', digest: `sha256:${'b'.repeat(64)}` });
  pkg.metadata = { ...pkg.metadata, name: 'cluster-manager' };
  assert.deepEqual(pkg.spec.nav, cliDescriptor.nav);
  assert.deepEqual(pkg.spec.cli, { namespace: 'cluster', manifestPath: '/cli/manifest' });
  const entry = publishedPluginEntry(pkg, '/manifest', '/signature');
  assert.deepEqual(entry.cli, { namespace: 'cluster', manifestPath: '/cli/manifest', apiBase: '/api/plugins/cluster-manager' });
});

test('hardened runtime materializes Pod security, availability, network and scrape policy', () => {
  const hardened = structuredClone(descriptor);
  hardened.runtime.security = { automountServiceAccountToken: false, runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, readOnlyRootFilesystem: true, seccompProfile: 'RuntimeDefault' };
  hardened.runtime.availability = { replicas: 2, minAvailable: 1, topologySpread: true, autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 4, targetCPUUtilization: 70 } };
  hardened.runtime.networkPolicy = { enabled: true, allowMonitoring: true };
  hardened.runtime.observability = {
    metricsPath: '/metrics', scrapeInterval: '30s',
    logs: { format: 'json', schema: 'opensphere.v1', stream: 'stdout' },
    traces: { propagation: 'w3c', responseHeaders: true },
  };
  hardened.contributions.observability = { enabled: true, logs: true, metrics: true, traces: true };
  assert.deepEqual(moduleDescriptorIssues(hardened), []);
  const pkg = packageFromInspection({ descriptor: hardened, repository: 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager', digest: `sha256:${'b'.repeat(64)}` });
  pkg.metadata = { ...pkg.metadata, uid: '00000000-0000-0000-0000-000000000000' };
  const deployment = deploymentManifest(pkg);
  const pod = deployment.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.securityContext, { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } });
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(pod.topologySpreadConstraints[0].topologyKey, 'kubernetes.io/hostname');
  assert.equal(deployment.spec.template.metadata.annotations['opensphere.io/log-format'], 'json');
  assert.equal(deployment.spec.template.metadata.annotations['opensphere.io/log-enabled'], 'true');
  assert.equal(deployment.spec.template.metadata.annotations['opensphere.io/log-schema'], 'opensphere.v1');
  assert.equal(deployment.spec.template.metadata.annotations['opensphere.io/log-stream'], 'stdout');
  assert.equal(deployment.spec.template.metadata.annotations['opensphere.io/log-correlation'], 'w3c+opensphere');
  assert.deepEqual(pod.containers[0].env.find((item) => item.name === 'POD_NAMESPACE').valueFrom, { fieldRef: { fieldPath: 'metadata.namespace' } });
  assert.equal(pod.containers[0].env.find((item) => item.name === 'OSP_LOG_SCHEMA').value, 'opensphere.v1');
  assert.equal(hpaManifest(pkg).spec.maxReplicas, 4);
  assert.equal(networkPolicyManifest(pkg).spec.policyTypes.includes('Egress'), true);
  assert.deepEqual(telemetryDescriptor(pkg), {
    consumer: 'opensphere-console', workload: 'cluster-manager', namespace: 'opensphere-console',
    metricsPath: '/metrics', scrapeInterval: '30s', capabilities: ['metrics'],
  });
});

test('runtime Registry projects channel status and immutable approval evidence', () => {
  const pkg = packageFromInspection({
    descriptor,
    repository: 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager',
    digest: `sha256:${'b'.repeat(64)}`,
    requestedImage: 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager:edge',
    channel: 'edge',
  });
  pkg.metadata = { ...pkg.metadata, name: 'cluster-manager' };
  const reg = {
    metadata: { creationTimestamp: '2026-07-19T00:00:00.000Z' },
    spec: { approval: { requestedBy: 'cmars', reason: 'approved development install' } },
  };
  const current = `sha256:${'c'.repeat(64)}`;
  const entry = publishedPluginEntry(pkg, '/manifest', '/signature', reg, {
    channelState: 'UpdateAvailable', currentChannelDigest: current,
    channelCheckedAt: '2026-07-20T00:00:00.000Z', channelReason: '',
  });
  assert.equal(entry.requestedChannel, 'edge');
  assert.equal(entry.currentChannelDigest, current);
  assert.equal(entry.updateState, 'UpdateAvailable');
  assert.deepEqual(entry.approval, {
    actor: 'cmars', reason: 'approved development install', time: '2026-07-19T00:00:00.000Z',
  });
});

test('extension installation is native CLI-only and preserves immutable installation provenance', () => {
  const controller = fs.readFileSync(path.join(__dirname, 'controller.js'), 'utf8');
  const crd = fs.readFileSync(path.join(__dirname, 'ui-plugin-crds.yaml'), 'utf8');
  assert.match(controller, /body\.client !== 'cli:os'/);
  assert.match(controller, /cliInstallationProvenance\(actor, opId\)/);
  assert.match(controller, /installation: x\.spec\.installation/);
  assert.match(crd, /installation:\s*\n\s*type: object/);
  assert.match(crd, /client: \{ type: string, enum: \['cli:os'\] \}/);
});

test('OAA Extension security facade is exact-digest, permission-gated, AAL2, and credential-free', () => {
  const source = fs.readFileSync(path.join(__dirname, 'controller.js'), 'utf8');
  const owner = source.slice(source.indexOf("if (p.startsWith('/api/oaa/owner/extensions/'))"), source.indexOf('// ── 인증 게이트'));
  assert.match(owner, /console\.extension\.security\.read/);
  assert.match(owner, /console\.extension\.security\.manage/);
  assert.match(owner, /oaaActor\.assurance !== 'aal2'/);
  assert.match(owner, /requireClosedOaaExtensionBody/);
  assert.match(owner, /if \(parsed\.channel\)/);
  assert.match(owner, /revoke extension image \$\{image\}/);
  assert.doesNotMatch(owner, /registryToken|password|apiKey|credential\s*:/i);
  assert.match(source, /permissions: Array\.isArray\(body\.permissions\)/);
  assert.match(source, /assurance: String\(body\.assurance/);
});

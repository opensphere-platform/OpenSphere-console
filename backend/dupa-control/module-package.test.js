const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { moduleDescriptorIssues, packageFromInspection, deploymentManifest, hpaManifest, networkPolicyManifest, serviceMonitorManifest, observerClusterRoleManifest, hisManagerClusterRoleManifest, infrastructureManagerClusterRoleManifest, aiDomainOperatorClusterRoleManifest, aiDomainScopedRoleManifest, requiresDomainSubShellAdmission, publishedPluginEntry, parseModuleImageReference, runnablePlatformManifests, governedSourceRepository, attestationArguments } = require('./controller');

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

test('HIS manager profile is fixed to Helm prerequisites and never grants impersonation', () => {
  const his = structuredClone(descriptor);
  his.permissionProfile = 'cluster-his-manager-v1';
  assert.deepEqual(moduleDescriptorIssues(his), []);
  const rules = hisManagerClusterRoleManifest().rules;
  assert.ok(rules.some((rule) => rule.resources.includes('secrets') && rule.verbs.includes('create')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('') && rule.resources.includes('persistentvolumeclaims') && rule.verbs.includes('create')));
  assert.ok(rules.some((rule) => rule.resources.includes('customresourcedefinitions') && rule.verbs.includes('create')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('cert-manager.io') && rule.resources.includes('clusterissuers') && rule.verbs.includes('create')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('cert-manager.io') && rule.resources.includes('certificates') && rule.verbs.includes('delete')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('acme.cert-manager.io') && rule.resources.includes('orders') && rule.verbs.includes('create')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('monitoring.coreos.com') && rule.resources.includes('prometheuses') && rule.verbs.includes('create')));
  assert.ok(rules.some((rule) => rule.resources.includes('clusterroles') && rule.verbs.includes('escalate')));
  assert.ok(!rules.some((rule) => rule.verbs.includes('impersonate')));
  assert.ok(!rules.some((rule) => rule.resources.includes('users')));
});

test('infrastructure manager adds only consumer-side storage integration writes', () => {
  const infrastructure = structuredClone(descriptor);
  infrastructure.permissionProfile = 'cluster-infrastructure-manager-v1';
  assert.deepEqual(moduleDescriptorIssues(infrastructure), []);
  const rules = infrastructureManagerClusterRoleManifest().rules;
  assert.ok(rules.some((rule) => rule.apiGroups.includes('storage.k8s.io') && rule.resources.includes('storageclasses') && rule.verbs.includes('create')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('snapshot.storage.k8s.io') && rule.resources.includes('volumesnapshotclasses') && rule.verbs.includes('delete')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('snapshot.storage.k8s.io') && rule.resources.includes('volumesnapshots') && rule.verbs.includes('create') && rule.verbs.includes('delete')));
  assert.ok(rules.some((rule) => rule.apiGroups.includes('ceph.rook.io') && rule.verbs.includes('create')));
  assert.ok(!rules.some((rule) => rule.verbs.includes('impersonate')));
  assert.ok(!rules.some((rule) => rule.resources.includes('users')));
});

test('deployed infrastructure manager ClusterRole exactly matches the controller permission profile', () => {
  const manifestPath = path.join(__dirname, 'opensphere-console-dupa-controller.yaml');
  const documents = [];
  yaml.loadAll(fs.readFileSync(manifestPath, 'utf8'), (document) => documents.push(document));
  const deployedRole = documents.find((document) => document?.kind === 'ClusterRole'
    && document?.metadata?.name === 'opensphere-module-cluster-infrastructure-manager-v1');
  assert.ok(deployedRole, 'infrastructure manager ClusterRole manifest must exist');
  assert.deepEqual(deployedRole.rules, infrastructureManagerClusterRoleManifest().rules);
});

test('AI domain operator is a fixed, scoped profile and is present in the deployment contract', () => {
  const ai = structuredClone(descriptor);
  ai.id = 'ai';
  ai.api.basePath = '/api/plugins/ai';
  ai.contributions.api.basePath = '/api/plugins/ai';
  ai.permissionProfile = 'ai-domain-operator-v1';
  ai.runtime.serviceAccountName = 'ai-runtime';
  assert.deepEqual(moduleDescriptorIssues(ai), []);
  assert.equal(requiresDomainSubShellAdmission({ spec: ai }), true);
  assert.equal(requiresDomainSubShellAdmission({ spec: descriptor }), false);
  const clusterRules = aiDomainOperatorClusterRoleManifest().rules;
  assert.ok(clusterRules.some((rule) => rule.resources.includes('users') && rule.verbs.includes('impersonate')));
  assert.ok(!clusterRules.some((rule) => rule.resources.includes('secrets')));
  const scopedRules = aiDomainScopedRoleManifest().rules;
  assert.ok(scopedRules.some((rule) => rule.resources.includes('secrets') && Array.isArray(rule.resourceNames)));

  const documents = [];
  yaml.loadAll(fs.readFileSync(path.join(__dirname, 'opensphere-console-dupa-controller.yaml'), 'utf8'), (document) => documents.push(document));
  const deployedClusterRole = documents.find((document) => document?.kind === 'ClusterRole' && document?.metadata?.name === 'opensphere-module-ai-domain-operator-v1');
  const deployedScopedRole = documents.find((document) => document?.kind === 'Role' && document?.metadata?.name === 'opensphere-module-ai-domain-operator-v1');
  assert.deepEqual(deployedClusterRole.rules, clusterRules);
  assert.deepEqual(deployedScopedRole.rules, scopedRules);
});

test('managed plugin workload receives the Console authentication CA read-only', () => {
  const pkg = packageFromInspection({ descriptor, repository: 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager', digest: `sha256:${'b'.repeat(64)}` });
  pkg.metadata = { ...pkg.metadata, uid: '00000000-0000-0000-0000-000000000000' };
  const deployment = deploymentManifest(pkg);
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.ok(container.env.some((item) => item.name === 'KANIDM_CA_PATH' && item.value === '/etc/opensphere/auth-ca/ca.crt'));
  assert.ok(container.env.some((item) => item.name === 'KANIDM_ISSUERS' && item.value === 'https://localhost:8090/oauth2/openid/opensphere-console'));
  assert.ok(container.env.some((item) => item.name === 'KANIDM_JWKS_URL' && item.value.includes('opensphere-console-auth.opensphere-console.svc')));
  assert.ok(container.env.some((item) => item.name === 'TOKEN_INTROSPECTION_URL' && item.value.endsWith('/bff/token/introspect')));
  assert.ok(container.env.some((item) => item.name === 'TOKEN_INTROSPECTION_SERVERNAME' && item.value === 'kanidm.opensphere-console-auth.svc'));
  assert.deepEqual(container.volumeMounts, [{ name: 'opensphere-console-auth-ca', mountPath: '/etc/opensphere/auth-ca', readOnly: true }]);
  assert.deepEqual(pod.volumes, [{
    name: 'opensphere-console-auth-ca',
    secret: { secretName: 'opensphere-console-auth-ca', items: [{ key: 'ca.crt', path: 'ca.crt' }] },
  }]);
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
  assert.equal(serviceMonitorManifest(pkg).spec.endpoints[0].path, '/metrics');
});

test('AI network policy permits only its fixed platform dependencies in addition to DNS', () => {
  const ai = structuredClone(descriptor);
  ai.id = 'ai';
  ai.api.basePath = '/api/plugins/ai';
  ai.contributions.api.basePath = '/api/plugins/ai';
  ai.permissionProfile = 'ai-domain-operator-v1';
  ai.runtime.networkPolicy = { enabled: true, allowMonitoring: true };
  const pkg = packageFromInspection({ descriptor: ai, repository: 'ghcr.io/opensphere-platform/opensphere-shell-ai-workbench', digest: `sha256:${'b'.repeat(64)}` });
  pkg.metadata = { ...pkg.metadata, uid: '00000000-0000-0000-0000-000000000000' };
  const egressNamespaces = networkPolicyManifest(pkg).spec.egress.flatMap((entry) => entry.to || []).map((entry) => entry.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name']).filter(Boolean);
  for (const namespace of ['opensphere-system', 'opensphere-backbone', 'opensphere-console-auth', 'opendatahub', 'default']) assert.ok(egressNamespaces.includes(namespace));
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

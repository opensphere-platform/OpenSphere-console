const test = require('node:test');
const assert = require('node:assert/strict');
const { moduleDescriptorIssues, packageFromInspection, observerClusterRoleManifest } = require('./controller');

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
  const pkg = packageFromInspection({ descriptor, repository: 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager', digest: `sha256:${'b'.repeat(64)}` });
  assert.equal(pkg.spec.permissionProfile, 'cluster-observer-v1');
  assert.equal(pkg.spec.image.repository, 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager');
});

test('rejects unapproved permission profile and observer role is read-only', () => {
  const bad = structuredClone(descriptor); bad.permissionProfile = 'cluster-admin';
  assert.ok(moduleDescriptorIssues(bad).some((issue) => issue.code === 'UnknownPermissionProfile'));
  const rules = observerClusterRoleManifest().rules;
  const verbs = rules.flatMap((rule) => rule.verbs);
  assert.deepEqual([...new Set(verbs)].sort(), ['get', 'list', 'watch']);
  assert.ok(rules.some((rule) => rule.apiGroups.includes('networking.k8s.io') && rule.resources.includes('ingressclasses')));
  assert.ok(!rules.some((rule) => rule.resources.includes('secrets')));
  assert.ok(!rules.some((rule) => rule.resources.includes('users') || rule.verbs.includes('impersonate')));
});

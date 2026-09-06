import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { installationProfile, verifyInstallationProfile } from '../src/installation-profile.mjs';
import { createKubernetesExtensionLifecycle } from '../src/kubernetes-extension-lifecycle.mjs';
import { makeReleaseFixture, json } from './extension-release-fixture.mjs';
import { moduleFixture } from './module-release-fixture.mjs';

const name = installationProfile.name;
const namespace = 'opensphere-console';
const plan = { contract: { namespace, permissionProfile: installationProfile.profile } };
function resources() {
  return [
    { kind: 'ServiceAccount', metadata: { name, namespace }, automountServiceAccountToken: false },
    { kind: 'ClusterRole', metadata: { name }, rules: structuredClone(installationProfile.rules) },
    { kind: 'ClusterRoleBinding', metadata: { name },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name },
      subjects: [{ kind: 'ServiceAccount', name, namespace }] },
  ];
}
function reader(values) {
  const kinds = ['serviceaccounts', 'clusterroles', 'clusterrolebindings'];
  return async (method, path) => {
    assert.equal(method, 'GET');
    assert.ok(path.endsWith('/' + name));
    const index = kinds.findIndex((kind) => path.includes('/' + kind + '/'));
    assert.notEqual(index, -1);
    return { status: values[index] ? 200 : 404, value: values[index] };
  };
}
test('Setup manifest reproduces the inventory contract and grants the controller only the two named RBAC reads', async () => {
  const documents = yaml.loadAll(readFileSync(new URL('../deploy.yaml', import.meta.url), 'utf8'));
  const find = (kind, resourceName) => {
    const matches = documents.filter((document) => document?.kind === kind && document.metadata?.name === resourceName);
    assert.equal(matches.length, 1, `${kind}/${resourceName} must have exactly one definition`);
    return matches[0];
  };
  const values = ['ServiceAccount', 'ClusterRole', 'ClusterRoleBinding'].map((kind) => find(kind, name));
  await verifyInstallationProfile(plan, reader(values));
  const readerName = 'opensphere-extension-installation-profile-reader';
  assert.deepEqual(find('ClusterRole', readerName).rules, [{
    apiGroups: ['rbac.authorization.k8s.io'], resources: ['clusterroles', 'clusterrolebindings'],
    resourceNames: [name], verbs: ['get'],
  }]);
  const binding = find('ClusterRoleBinding', readerName);
  assert.deepEqual(binding.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: readerName });
  assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: 'opensphere-extension-controller', namespace }]);
  for (const rule of values[1].rules) {
    assert.ok(!rule.resources?.includes('secrets'), 'No Secret access');
    if (rule.resources?.includes('selfsubjectaccessreviews')) {
      assert.deepEqual(rule, { apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectaccessreviews'], verbs: ['create'] });
    } else {
      assert.ok(rule.verbs.every((verb) => ['get', 'list', 'watch'].includes(verb)), 'Inventory must not mutate resources');
    }
  }
});
test('inventory profile is verified with read-only requests, independent of rule ordering', async () => {
  const values = resources();
  values[1].rules.reverse();
  values[1].rules.forEach((rule) => Object.values(rule).forEach((entry) => entry.reverse()));
  await verifyInstallationProfile(plan, reader(values));
  await verifyInstallationProfile({ contract: { permissionProfile: 'none' } }, () => assert.fail('not needed'));
});
for (const index of [0, 1, 2]) test(`missing prerequisite ${index} blocks before workload creation`, async () => {
  const values = resources(); values[index] = null;
  await assert.rejects(verifyInstallationProfile(plan, reader(values)), { code: 'InstallationProfileMissing' });
});
for (const [label, mutate] of [
  ['wrong service account', (v) => { v[0].metadata.namespace = 'other'; }],
  ['automatic token mount', (v) => { v[0].automountServiceAccountToken = true; }],
  ['missing rule', (v) => { v[1].rules.pop(); }],
  ['added Secret access', (v) => { v[1].rules[0].resources.push('secrets'); }],
  ['escalation', (v) => { v[1].rules[0].verbs.push('escalate'); }],
  ['aggregation', (v) => { v[1].aggregationRule = { clusterRoleSelectors: [] }; }],
  ['wrong bound role', (v) => { v[2].roleRef.name = 'cluster-admin'; }],
  ['additional subject', (v) => { v[2].subjects.push({ kind: 'Group', name: 'system:authenticated' }); }],
]) test(`${label} is a mismatch, never Approved`, async () => {
  const values = resources(); mutate(values);
  await assert.rejects(verifyInstallationProfile(plan, reader(values)), { code: 'InstallationProfileMismatch' });
});
test('API denial and invalid responses are not inferred as a missing optional profile', async () => {
  await assert.rejects(verifyInstallationProfile(plan, async () => { throw new Error('403'); }), { code: 'InstallationProfileUnavailable' });
  await assert.rejects(verifyInstallationProfile(plan, async () => ({ status: 200, value: null })), { code: 'InstallationProfileMismatch' });
});
test('real lifecycle leaves existing workloads untouched and reports a retryable bootstrap dependency', async () => {
  const signed = moduleFixture();
  const pkg = makeReleaseFixture().pkg;
  pkg.metadata.name = 'cluster-manager';
  Object.assign(pkg.spec, signed.release.spec);
  pkg.spec.resolution = { ...makeReleaseFixture().pkg.spec.resolution, ...signed.release.spec.resolution };
  pkg.spec.permissionProfile = installationProfile.profile;
  signed.release.spec = pkg.spec;
  pkg.metadata.annotations = { 'opensphere.io/module-release': signed.seal() };
  const registration = {
    apiVersion: 'plugins.opensphere.io/v1alpha1', kind: 'UIPluginRegistration',
    metadata: { name: 'cluster-manager', namespace, uid: 'registration-id', resourceVersion: '1', generation: 1 },
    spec: { packageRef: { name: 'cluster-manager' }, desiredState: 'Enabled' },
  };
  const mutations = [];
  const lifecycle = createKubernetesExtensionLifecycle({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token-value',
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (options.method === 'PATCH' && path.endsWith('/cluster-manager/status')) {
        const body = JSON.parse(options.body); mutations.push(body);
        return json(200, { ...registration, metadata: { ...registration.metadata, resourceVersion: '2' }, status: body.status });
      }
      assert.equal(options.method || 'GET', 'GET', 'No workload or RBAC mutation is permitted');
      if (path.endsWith('/uipluginregistrations')) return json(200, { items: [registration] });
      if (path.endsWith('/uipluginpackages/cluster-manager')) return json(200, pkg);
      if (path.endsWith('/configmaps/opensphere-extension-trusted-keys')) return json(200, {
        data: { 'trusted-keys.json': JSON.stringify({ trustedKeys: signed.trustedKeys }) },
      });
      if (path.endsWith('/' + name)) return json(404, { reason: 'NotFound' });
      assert.fail('Unexpected request: ' + path);
    },
  });
  const result = await lifecycle.reconcileOnce();
  assert.equal(result.state, 'Pending');
  assert.equal(result.reason, 'InstallationProfileMissing');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].status.verification.permissions, 'Pending');
  assert.equal(mutations[0].status.verification.signature, 'Pending', 'Missing bootstrap RBAC is not a bad signature');
  assert.equal(mutations[0].status.retryable, true);
});

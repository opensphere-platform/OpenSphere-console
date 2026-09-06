// Console bootstrap owns these inventory prerequisites. HISS/Ceph mutation
// authority is a separate product owner contract; it is never implied here.
import { readFileSync } from 'node:fs';

export const installationProfile = Object.freeze(JSON.parse(readFileSync(
  new URL('./installation-profile.json', import.meta.url), 'utf8',
)));

function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort());
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  ));
  return JSON.stringify(value);
}

function failure(code) {
  return Object.assign(new Error(code === 'InstallationProfileUnavailable'
    ? 'Cannot verify Cluster Manager inventory prerequisites; check the Console controller access.'
    : 'Cluster Manager inventory prerequisites are missing or differ from this Console release; run the verified Setup upgrade.'),
  { code, retryable: true });
}

export async function verifyInstallationProfile(plan, request) {
  if (plan.contract.permissionProfile !== 'cluster-infrastructure-manager-v1') return;
  const name = installationProfile.name;
  const paths = [
    `/api/v1/namespaces/${plan.contract.namespace}/serviceaccounts/${name}`,
    `/apis/rbac.authorization.k8s.io/v1/clusterroles/${name}`,
    `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${name}`,
  ];
  let observed;
  try { observed = await Promise.all(paths.map((path) => request('GET', path, undefined, [200, 404]))); }
  catch { throw failure('InstallationProfileUnavailable'); }
  if (observed.some((item) => item.status === 404)) throw failure('InstallationProfileMissing');
  const [account, role, binding] = observed.map((item) => item.value);
  if (account?.kind !== 'ServiceAccount' || account?.metadata?.name !== name
      || account?.metadata?.namespace !== plan.contract.namespace || account.automountServiceAccountToken !== false
      || role?.kind !== 'ClusterRole' || role?.metadata?.name !== name || role.aggregationRule
      || canonical(role.rules) !== canonical(installationProfile.rules)
      || binding?.kind !== 'ClusterRoleBinding' || binding?.metadata?.name !== name
      || canonical(binding.roleRef) !== canonical({ apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name })
      || canonical(binding.subjects) !== canonical([{ kind: 'ServiceAccount', name, namespace: plan.contract.namespace }])) {
    throw failure('InstallationProfileMismatch');
  }
}

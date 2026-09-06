import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import installationProfile from '../apps/extension-controller/src/installation-profile.json' with { type: 'json' };
import { verifyBrowserApiCutover } from './browser-api-cutover.mjs';
import { verifyLegacyApiDisposition } from './legacy-api-disposition.mjs';

const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const BOOTSTRAP_CORE_RELEASE_PROFILE = Object.freeze({
  requiredComponentIds: Object.freeze(['C_WEB', 'C_API', 'C_EXT', 'C_REG', 'C_CLI']),
  inactiveComponentIds: Object.freeze(['C_AI', 'C_DST', 'C_SCTL', 'C_BAK', 'C_NOTIFY']),
  bootstrapCore: Object.freeze([
    'console', 'consoleApi', 'extensionController', 'registry', 'gitea', 'giteaPostgres',
    'supabasePostgres', 'supabaseAuth', 'supabaseRest', 'supabaseStorage',
    'beszelHub', 'beszelAgent', 'beszelBootstrap',
  ]),
  availableModules: Object.freeze([
    'osaaGateway', 'osdst', 'osaaGovernedAdapter', 'notificationDispatcher', 'recovery',
  ]),
  bootstrapAuxiliaryArtifacts: Object.freeze(['cliArtifacts', 'consoleIndexContent']),
  availableAuxiliaryArtifacts: Object.freeze(['osShellControl', 'osShellRuntime']),
  inactiveBrowserFamilies: Object.freeze([
    ['notifications', 'C_NOTIFY'],
    ['external-channels', 'C_BAK'],
    ['osaa', 'C_AI'],
    ['manual', 'C_AI'],
    ['os-shell', 'C_SCTL'],
  ]),
  inactiveRouteLocations: Object.freeze([
    'location /api/notifications/ {',
    'location /api/external-channels/ {',
    'location = /api/osaa/incidents/stream {',
    'location /api/osaa/ {',
    'location = /api/manual {',
    'location /api/manual/ {',
    'location ~ "^/api/os-shell/sessions/',
    'location /api/os-shell/ {',
  ]),
});

function assertExactList(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

async function verifyComponentDirectories({ root, boundary, componentIds }) {
  const byId = new Map(boundary.components.map((component) => [component.id, component]));
  for (const componentId of componentIds) {
    const component = byId.get(componentId);
    assert(component, `${componentId} is absent from the component boundary`);
    assert(Array.isArray(component.legacySources) && component.legacySources.length === 0,
      `${component.id} still depends on legacy source paths`);
    const targetPath = resolve(root, component.path);
    assert(targetPath.startsWith(resolve(root)), `${component.id} target path escapes the repository`);
    const target = await stat(targetPath).catch(() => null);
    assert(target?.isDirectory(), `${component.id} target path is absent: ${component.path}`);
  }
}

async function verifyBootstrapCoreReleaseReadiness({
  root,
  boundary,
  denominator,
  browserApiCutover,
  legacyApiDisposition,
}) {
  const boundaryProfile = boundary.releaseProfiles?.['bootstrap-core'];
  const denominatorProfile = denominator.releaseProfiles?.['bootstrap-core'];
  assert(boundaryProfile?.status === 'release-ready',
    'Bootstrap-core publication requires a release-ready bootstrap runtime boundary');
  assert(boundaryProfile.scope === 'bootstrap-runtime',
    'Bootstrap-core runtime boundary has an invalid scope');
  assertExactList(boundaryProfile.requiredComponentIds, BOOTSTRAP_CORE_RELEASE_PROFILE.requiredComponentIds,
    'Bootstrap-core required C4 component set differs from Setup responsibility');
  assertExactList(boundaryProfile.inactiveComponentIds, BOOTSTRAP_CORE_RELEASE_PROFILE.inactiveComponentIds,
    'Bootstrap-core inactive C4 component set differs from Setup responsibility');
  assertExactList(
    [...boundaryProfile.requiredComponentIds, ...boundaryProfile.inactiveComponentIds].sort(),
    boundary.components.map(({ id }) => id).sort(),
    'Bootstrap-core C4 partition does not cover the complete Console boundary',
  );
  assertExactList(boundaryProfile.artifactActivation?.bootstrapCore, BOOTSTRAP_CORE_RELEASE_PROFILE.bootstrapCore,
    'Bootstrap-core release component set differs from Setup responsibility');
  assertExactList(boundaryProfile.artifactActivation?.availableModules, BOOTSTRAP_CORE_RELEASE_PROFILE.availableModules,
    'Bootstrap-core available module set differs from Setup responsibility');
  assertExactList(boundaryProfile.artifactActivation?.bootstrapAuxiliaryArtifacts,
    BOOTSTRAP_CORE_RELEASE_PROFILE.bootstrapAuxiliaryArtifacts,
    'Bootstrap-core auxiliary artifact set differs from Setup responsibility');
  assertExactList(boundaryProfile.artifactActivation?.availableAuxiliaryArtifacts,
    BOOTSTRAP_CORE_RELEASE_PROFILE.availableAuxiliaryArtifacts,
    'Bootstrap-core inactive auxiliary artifact set differs from Setup responsibility');

  assert(denominatorProfile?.status === denominatorProfile?.targetStatus,
    'Bootstrap-core publication requires its complete scoped API contract denominator');
  assert(denominatorProfile.scope === 'bootstrap-contract-and-routing',
    'Bootstrap-core API denominator has an invalid scope');
  assert(denominatorProfile.remaining?.legacyProductionApiLiterals === 0,
    'Bootstrap-core publication requires every legacy API literal to be dispositioned');
  assert(legacyApiDisposition?.status === 'passed'
    && legacyApiDisposition.decisions === denominator.remaining?.legacyProductionApiLiterals,
  'Bootstrap-core publication requires the complete reviewed legacy API disposition ledger');
  assertExactList(
    denominatorProfile.inactiveBrowserFamilies,
    BOOTSTRAP_CORE_RELEASE_PROFILE.inactiveBrowserFamilies.map(([family]) => family),
    'Bootstrap-core inactive browser-family set differs from Setup responsibility',
  );

  assert(browserApiCutover.targetSessionReady && browserApiCutover.authenticatedCutoverReady,
    'Bootstrap-core publication requires atomic target browser-session routing');
  assert(browserApiCutover.currentSessionAuthority === 'console_identity.browser_session',
    'Bootstrap-core publication retained a legacy browser-session authority');
  const browserContract = await json(resolve(root, 'packages', 'contracts', 'browser-api-cutover.json'));
  for (const [familyId, targetOwner] of BOOTSTRAP_CORE_RELEASE_PROFILE.inactiveBrowserFamilies) {
    const family = browserContract.families.find(({ id }) => id === familyId);
    assert(family?.status === 'target-routed' && family.targetOwner === targetOwner,
      `Inactive browser family ${familyId} is not routed to its target owner`);
  }

  const targetRoutes = await readFile(resolve(root, 'apps', 'console-web', 'nginx', 'target-api-routes.conf'), 'utf8');
  assert(targetRoutes.includes('location @optional_owner_unavailable')
    && targetRoutes.includes('"code":"AuthorityUnavailable"')
    && targetRoutes.includes('return 503'),
  'Bootstrap-core routing has no stable AuthorityUnavailable response for inactive owners');
  for (const location of BOOTSTRAP_CORE_RELEASE_PROFILE.inactiveRouteLocations) {
    const start = targetRoutes.indexOf(location);
    const end = start < 0 ? -1 : targetRoutes.indexOf(String.fromCharCode(10) + '    }', start);
    const block = start < 0 || end < 0 ? '' : targetRoutes.slice(start, end);
    assert(block.includes('error_page 502 504 = @optional_owner_unavailable;'),
      `Inactive owner route lacks a stable 503 fallback: ${location}`);
    assert(!block.includes('proxy_intercept_errors on;'),
      `Inactive owner route masks the owner's typed response: ${location}`);
  }
  assert(targetRoutes.includes('"reasonCode":"TargetPlatformCapabilityInactive"')
    && targetRoutes.includes('"code":"RouteRetired"'),
  'Bootstrap-core Platform routing can fall through to a silent 404');

  await verifyComponentDirectories({
    root,
    boundary,
    componentIds: boundaryProfile.requiredComponentIds,
  });
}

export async function verifyReleaseReadiness({
  root,
  boundary,
  denominator,
  browserApiCutover,
  legacyApiDisposition,
  releaseProfile = 'full',
}) {
  assert(['full', 'bootstrap-core'].includes(releaseProfile),
    `Unknown Console release readiness profile: ${releaseProfile}`);
  if (releaseProfile === 'bootstrap-core') {
    await verifyBootstrapCoreReleaseReadiness({
      root,
      boundary,
      denominator,
      browserApiCutover,
      legacyApiDisposition,
    });
    return;
  }

  assert(boundary.status === 'release-ready', 'Official publication is blocked while component boundaries remain target-migration');
  assert(denominator.status === denominator.targetStatus, 'Official publication requires the complete API contract denominator');
  assert(denominator.remaining?.legacyProductionApiLiterals === 0, 'Official publication requires disposition of every legacy production API literal');
  assert(browserApiCutover.contractStatus === 'release-ready', 'Official publication requires a release-ready browser API cutover contract');
  assert(browserApiCutover.authenticatedCutoverReady, 'Official publication requires atomic authenticated browser API cutover');
  await verifyComponentDirectories({
    root,
    boundary,
    componentIds: boundary.components.map(({ id }) => id),
  });
}
const CONSOLE_API_DATABASE_FUNCTIONS = Object.freeze([
  'console_audit.list_events',
  'console_extension.assert_registry_credential_authority',
  'console_extension.get_registry_connection',
  'console_extension.list_revocations',
  'console_extension.record_registry_credential_result',
  'console_identity.activate_browser_session_mfa',
  'console_identity.approve_cli_device_enrollment',
  'console_identity.change_managed_identity_role',
  'console_identity.claim_initial_administrator',
  'console_identity.complete_browser_session_step_up',
  'console_identity.complete_browser_session_totp_enrollment',
  'console_identity.complete_cli_device_session',
  'console_identity.complete_managed_identity_lifecycle',
  'console_identity.create_cli_device_challenge',
  'console_identity.create_cli_device_enrollment',
  'console_identity.get_browser_session_preference_credentials',
  'console_identity.get_browser_session_refresh_credentials',
  'console_identity.get_browser_session_step_up_credentials',
  'console_identity.get_browser_session_totp_enrollment_credentials',
  'console_identity.get_cli_device_challenge',
  'console_identity.get_cli_device_enrollment',
  'console_identity.get_initial_administrator_bootstrap_status',
  'console_identity.get_pending_browser_session_mfa',
  'console_identity.get_supabase_status',
  'console_identity.issue_browser_session',
  'console_identity.list_managed_identities',
  'console_identity.list_owned_browser_session_events',
  'console_identity.list_owned_browser_sessions',
  'console_identity.list_owned_cli_devices',
  'console_identity.list_owned_cli_devices_with_cli_session',
  'console_identity.poll_cli_device_enrollment',
  'console_identity.prepare_browser_session_preference_update',
  'console_identity.prepare_managed_identity_lifecycle',
  'console_identity.prepare_owned_password_recovery_link',
  'console_identity.prepare_owned_profile_avatar_access',
  'console_identity.prepare_owner_access_credential',
  'console_identity.reject_browser_session_refresh',
  'console_identity.resolve_browser_session',
  'console_identity.resolve_cli_session',
  'console_identity.resolve_owner_access_authority',
  'console_identity.revoke_all_owned_browser_sessions',
  'console_identity.revoke_browser_session',
  'console_identity.revoke_browser_sessions_after_password_recovery',
  'console_identity.revoke_owned_browser_session',
  'console_identity.revoke_owned_cli_device',
  'console_identity.revoke_owned_cli_device_with_cli_session',
  'console_identity.rotate_browser_session_credentials',
  'console_identity.touch_browser_session_activity',
  'console_operation.accept_development_module_install',
  'console_operation.accept_gitea_module',
  'console_operation.accept_operation',
  'console_operation.approve_development_module_install',
  'console_operation.approve_operation',
  'console_operation.get_gitea_bound_operation_for_approval',
  'console_operation.get_operation',
  'console_operation.get_operation_by_request',
  'console_operation.list_gitea_changes',
  'console_operation.record_gitea_merge',
  'console_operation.record_gitea_proposal',
  'console_operation.verify_extension_operation',
]);

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function operationEntries(openapi) {
  const entries = [];
  for (const [path, pathItem] of Object.entries(openapi.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (HTTP_METHODS.has(method)) entries.push({ path, method, operation });
    }
  }
  return entries;
}

export function verifyConsoleApiAuthority({ storeSource, baselineSource }) {
  assert(
    !/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+console_(?:audit|extension|identity|operation)\./i.test(storeSource),
    'Console API store must use granted functions instead of direct authority-table mutation',
  );
  const databaseFunctions = [...new Set(
    [...storeSource.matchAll(/console_(?:audit|extension|identity|operation)\.[a-z_]+/g)].map((match) => match[0]),
  )].sort();
  assert(
    JSON.stringify(databaseFunctions) === JSON.stringify(CONSOLE_API_DATABASE_FUNCTIONS),
    'Console API database function set differs from the closed target contract',
  );
  const statements = baselineSource.split(';').map((statement) => statement.trim()).filter(Boolean);
  for (const name of databaseFunctions) {
    assert(baselineSource.includes(`CREATE OR REPLACE FUNCTION ${name}(`), `${name} is absent from the verified migration set`);
    assert(
      statements.some((statement) => statement.includes(`GRANT EXECUTE ON FUNCTION ${name}(`)
        && /\)\s+TO\s+console_api$/s.test(statement)),
      `${name} is not granted exactly to the Console API runtime role`,
    );
  }
  return databaseFunctions;
}

function documentByKind(documents, kind) {
  return documents.filter((document) => document?.kind === kind);
}

function verifyRegistryCredentialDeployment(documents) {
  const namespaces = ['opensphere-console-data', 'opensphere-console-change', 'opensphere-monitoring', 'opensphere-console', 'opensphere-system', 'opensphere-shell-sessions'];
  const roleName = 'opensphere-registry-credential-broker';
  const roles = documentByKind(documents, 'Role');
  const bindings = documentByKind(documents, 'RoleBinding');
  assert(roles.length === 6 && bindings.length === 6
    && documentByKind(documents, 'ClusterRole').length === 0
    && documentByKind(documents, 'ClusterRoleBinding').length === 0,
    'C_API registry authority requires exactly six namespace Roles and bindings, no cluster authority');
  for (const namespace of namespaces) {
    const scopedRoles = roles.filter(role => role.metadata?.namespace === namespace && role.metadata?.name === roleName);
    const scopedBindings = bindings.filter(binding => binding.metadata?.namespace === namespace && binding.metadata?.name === roleName);
    assert(scopedRoles.length === 1 && scopedBindings.length === 1, 'C_API registry RBAC escaped its exact namespaces');
    const names = namespace === 'opensphere-console' ? ['opensphere-ghcr-pull', 'opensphere-registry-auth'] : ['opensphere-ghcr-pull'];
    assert(JSON.stringify(scopedRoles[0].rules) === JSON.stringify([{
      apiGroups: [''], resources: ['secrets'], resourceNames: names, verbs: ['get', 'update'],
    }]), 'C_API registry RBAC must grant only get/update on the six named Secret instances');
    const binding = scopedBindings[0];
    assert(JSON.stringify(binding.roleRef) === JSON.stringify({apiGroup:'rbac.authorization.k8s.io',kind:'Role',name:roleName})
      && JSON.stringify(binding.subjects) === JSON.stringify([{kind:'ServiceAccount',name:'opensphere-console-api',namespace:'opensphere-console'}]),
      'C_API registry RoleBinding must bind only the dedicated Console API identity');
  }
  const [account] = documentByKind(documents, 'ServiceAccount');
  const [deployment] = documentByKind(documents, 'Deployment');
  const pod = deployment?.spec?.template?.spec;
  assert(account?.metadata?.namespace === 'opensphere-console' && account?.metadata?.name === 'opensphere-console-api'
    && deployment?.metadata?.namespace === 'opensphere-console'
    && pod?.serviceAccountName === 'opensphere-console-api'
    && pod?.containers?.length === 1 && !pod?.initContainers?.length && !pod?.ephemeralContainers?.length,
    'C_API registry identity must belong only to the API container');
  const container = pod.containers[0];
  const identityVolumes = (pod.volumes || []).filter(volume => volume.name === 'registry-kubernetes-identity');
  const expectedProjection = {defaultMode:292,sources:[
    {serviceAccountToken:{path:'token',expirationSeconds:600}},
    {configMap:{name:'kube-root-ca.crt',items:[{key:'ca.crt',path:'ca.crt'}]}},
  ]};
  const tlsVolumes = (pod.volumes || []).filter(volume => [
    'opensphere-shell-credential-authority-tls',
    'opensphere-shell-console-api-tls',
  ].includes(volume.name));
  assert(identityVolumes.length === 1 && JSON.stringify(identityVolumes[0].projected) === JSON.stringify(expectedProjection)
    && pod.volumes.length === 5 && pod.volumes.every(volume => !volume.hostPath)
    && JSON.stringify(tlsVolumes) === JSON.stringify([
      {name:'opensphere-shell-credential-authority-tls',secret:{secretName:'opensphere-shell-credential-authority-tls',optional:true}},
      {name:'opensphere-shell-console-api-tls',secret:{secretName:'opensphere-shell-console-api-tls',optional:true}},
    ]),
    'C_API requires one projected Kubernetes identity and only the exact optional OS Shell TLS credentials');
  assert(JSON.stringify(pod.volumes.filter(volume => volume.name === 'recovery-evidence')) === JSON.stringify([
    {name:'recovery-evidence',configMap:{name:'opensphere-platform-recovery-evidence',optional:true,items:[{key:'recovery-evidence.json',path:'recovery-evidence.json'}]}},
  ]) && JSON.stringify(container.volumeMounts.filter(mount => mount.name === 'recovery-evidence')) === JSON.stringify([
    {name:'recovery-evidence',mountPath:'/var/run/opensphere/recovery',readOnly:true},
  ]), 'C_API recovery evidence must be exactly one optional read-only ConfigMap projection without subPath');
  assert((container.volumeMounts || []).filter(mount => mount.name === 'registry-kubernetes-identity').length === 1
    && JSON.stringify(container.volumeMounts.find(mount => mount.name === 'registry-kubernetes-identity'))
      === JSON.stringify({name:'registry-kubernetes-identity',mountPath:'/var/run/secrets/kubernetes.io/serviceaccount',readOnly:true}),
    'C_API projected identity must be read-only and must rotate without subPath');
  assert(JSON.stringify((container.volumeMounts || []).filter(mount => tlsVolumes.some(volume => volume.name === mount.name)))
    === JSON.stringify([
      {name:'opensphere-shell-credential-authority-tls',mountPath:'/var/run/opensphere-shell-credential-authority-tls',readOnly:true},
      {name:'opensphere-shell-console-api-tls',mountPath:'/var/run/opensphere-shell-console-api-tls',readOnly:true},
    ]), 'C_API OS Shell TLS credentials must use only their exact read-only paths');
  assert(container.env?.find(entry => entry.name === 'CONSOLE_REGISTRY_AUTH_CONTRACT')?.value === 'registry-auth/v1',
    'C_API registry lifecycle activation must declare registry-auth/v1');
  const oauth = container.env?.find(entry => entry.name === 'OPENSPHERE_GITHUB_OAUTH_CLIENT_ID');
  assert(oauth?.value === undefined && JSON.stringify(oauth?.valueFrom?.secretKeyRef)
    === JSON.stringify({name:'opensphere-registry-auth',key:'oauth-client-id',optional:true}),
    'C_API OAuth app ID must come from the Setup owner Secret public configuration');
}

export function verifyConsoleApiDeployment({ documents, nginxSource, targetRouteSource = '' }) {
  assert(documentByKind(documents, 'Secret').length === 0, 'C_API manifest must consume, not create, its database Secret');
  verifyRegistryCredentialDeployment(documents);

  const [serviceAccount] = documentByKind(documents, 'ServiceAccount');
  const [deployment] = documentByKind(documents, 'Deployment');
  const [service] = documentByKind(documents, 'Service');
  const networkPolicies = documentByKind(documents, 'NetworkPolicy');
  const networkPolicy = networkPolicies.find(({ metadata }) => metadata?.name === 'opensphere-console-api');
  const kubernetesEgressPolicy = networkPolicies.find(
    ({ metadata }) => metadata?.name === 'opensphere-console-api-kubernetes-egress',
  );
  assert(documentByKind(documents, 'ServiceAccount').length === 1, 'C_API must have one dedicated ServiceAccount');
  assert(documentByKind(documents, 'Deployment').length === 1, 'C_API must have one component-owned Deployment');
  assert(documentByKind(documents, 'Service').length === 1, 'C_API must have one internal Service');
  assert(networkPolicies.length === 2 && networkPolicy && kubernetesEgressPolicy,
    'C_API must have exactly the closed base and Kubernetes API egress policies');
  assert(serviceAccount.automountServiceAccountToken === false, 'C_API ServiceAccount token automount must be disabled');
  assert(deployment.spec?.template?.spec?.automountServiceAccountToken === false, 'C_API Pod token automount must be disabled');
  assert(deployment.spec?.replicas === 1, 'C_API foundational deployment must not claim unverified HA');

  const container = deployment.spec?.template?.spec?.containers?.[0];
  assert(container?.image === '__OPENSPHERE_CONSOLE_API_IMAGE__', 'C_API image must remain an exact-digest render input');
  assert(container?.securityContext?.readOnlyRootFilesystem === true, 'C_API root filesystem must be read-only');
  assert(container?.securityContext?.allowPrivilegeEscalation === false, 'C_API privilege escalation must be disabled');
  assert(container?.securityContext?.capabilities?.drop?.includes('ALL'), 'C_API Linux capabilities must be dropped');
  assert(container?.readinessProbe?.httpGet?.path === '/healthz', 'C_API readiness must check its PostgreSQL authority');
  assert(container?.livenessProbe?.httpGet?.path === '/livez', 'C_API liveness must not restart the process for an authority outage');
  const databaseEnv = container?.env?.find((entry) => entry.name === 'CONSOLE_DATABASE_URL');
  assert(databaseEnv?.value === undefined, 'C_API database credential must not be a literal value');
  assert(databaseEnv?.valueFrom?.secretKeyRef?.name === 'opensphere-console-api-runtime', 'C_API database Secret name differs from the install contract');
  assert(databaseEnv?.valueFrom?.secretKeyRef?.key === 'database-url', 'C_API database Secret key differs from the install contract');
  const sessionKeyEnv = container?.env?.find((entry) => entry.name === 'CONSOLE_SESSION_ENCRYPTION_KEY');
  assert(sessionKeyEnv?.value === undefined, 'C_API session encryption key must not be a literal value');
  assert(sessionKeyEnv?.valueFrom?.secretKeyRef?.name === 'opensphere-console-api-runtime', 'C_API session encryption Secret name differs from the install contract');
  assert(sessionKeyEnv?.valueFrom?.secretKeyRef?.key === 'session-encryption-key', 'C_API session encryption Secret key differs from the install contract');
  const serviceRoleEnv = container?.env?.find((entry) => entry.name === 'CONSOLE_SUPABASE_SERVICE_ROLE_KEY');
  assert(serviceRoleEnv?.value === undefined, 'C_API Supabase administrator credential must not be a literal value');
  assert(serviceRoleEnv?.valueFrom?.secretKeyRef?.name === 'opensphere-console-api-runtime', 'C_API Supabase administrator Secret name differs from the install contract');
  assert(serviceRoleEnv?.valueFrom?.secretKeyRef?.key === 'supabase-service-role-key', 'C_API Supabase administrator Secret key differs from the install contract');
  const publicOriginEnv = container?.env?.find((entry) => entry.name === 'CONSOLE_PUBLIC_ORIGIN');
  assert(publicOriginEnv?.value === '__OPENSPHERE_CONSOLE_URL__', 'C_API public origin must remain an installer-validated render input');
  const beszelUrlEnv = container?.env?.find((entry) => entry.name === 'CONSOLE_BESZEL_URL');
  assert(beszelUrlEnv?.value === 'http://beszel-hub.opensphere-monitoring.svc.cluster.local:8090', 'C_API Beszel origin differs from the private governed Hub');
  for (const [name, key] of [['CONSOLE_BESZEL_READER_EMAIL', 'email'], ['CONSOLE_BESZEL_READER_PASSWORD', 'password']]) {
    const entry = container?.env?.find((candidate) => candidate.name === name);
    assert(entry?.value === undefined, name + ' must not be a literal value');
    assert(entry?.valueFrom?.secretKeyRef?.name === 'opensphere-baseline-monitoring-reader', name + ' uses the wrong projected Secret');
    assert(entry?.valueFrom?.secretKeyRef?.key === key, name + ' uses the wrong projected Secret key');
  }
  assert(service.spec?.type === 'ClusterIP', 'C_API Service must remain cluster-internal');
  const installationConfig = deployment.spec.template.spec.volumes?.find(volume => volume.name === 'installation-release')?.configMap;
  assert(installationConfig?.name === 'opensphere-installation-lock'
    && installationConfig.items?.some(item => item.key === 'config.json' && item.path === 'config.json'),
    'C_API module installation policy requires the operator-controlled installation config projection');

  assert(JSON.stringify(networkPolicy.spec?.policyTypes) === JSON.stringify(['Ingress', 'Egress']), 'C_API NetworkPolicy must select both directions');
  const ingressRules = networkPolicy.spec?.ingress || [];
  const ingress = JSON.stringify(ingressRules);
  const egress = JSON.stringify(networkPolicy.spec?.egress || []);
  const ingressApps = ingressRules.flatMap((rule) => rule.from || [])
    .map((peer) => peer?.podSelector?.matchLabels?.app ?? peer?.podSelector?.matchLabels?.['app.kubernetes.io/name'])
    .filter(Boolean).sort();
  const expectedIngressApps = [
    'opensphere-console',
    'opensphere-console-osaa-gateway',
    'opensphere-osdst',
    'opensphere-extension-controller',
    'opensphere-notification-dispatcher',
    'opensphere-external-channel-executor',
    'opensphere-shell-api',
    'opensphere-shell-gateway',
  ].sort();
  assert(
    JSON.stringify(ingressApps) === JSON.stringify(expectedIngressApps)
      && !ingress.includes('namespaceSelector')
      && ingressRules.every((rule) => JSON.stringify(rule.ports) === JSON.stringify([{ protocol: 'TCP', port: 8080 }])),
    'C_API ingress must be limited to same-namespace Console Web and exact target Owner callbacks on TCP/8080',
  );
  for (const destination of ['kube-system', 'opensphere-console-data', 'opensphere-supabase-postgres', 'opensphere-supabase-auth', 'opensphere-supabase-rest', 'opensphere-supabase-storage', 'opensphere-registry']) {
    assert(egress.includes(destination), `C_API NetworkPolicy omits required destination ${destination}`);
  }
  assert(
    (networkPolicy.spec?.egress || []).some((rule) => JSON.stringify(rule.to) === JSON.stringify([{
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'opensphere-monitoring' } },
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'beszel-hub' } },
    }]) && JSON.stringify(rule.ports) === JSON.stringify([{ protocol: 'TCP', port: 8090 }])),
    'C_API egress to Beszel must be limited to the private Hub pod on TCP/8090',
  );
  const egressRules = networkPolicy.spec?.egress || [];
  const providerRule = { ports: [{ protocol: 'TCP', port: 443 }] };
  assert(egressRules.filter(rule => JSON.stringify(rule) === JSON.stringify(providerRule)).length === 1,
    'C_API provider egress must be limited to TCP/443');
  const internalRules = egressRules.filter(rule => JSON.stringify(rule) !== JSON.stringify(providerRule));
  const ownerStatusRule = { to: [
    { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'opensphere-registry' } } },
    { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'opensphere-extension-controller' } } },
  ], ports: [{ protocol: 'TCP', port: 8080 }] };
  assert(internalRules.filter(rule => JSON.stringify(rule) === JSON.stringify(ownerStatusRule)).length === 1,
    'C_API owner status requires exactly Registry and C_EXT in the same namespace on TCP/8080');
  assert(internalRules.length === 6 && internalRules.every(rule =>
    Array.isArray(rule.to) && (rule.to.length === 1 || JSON.stringify(rule) === JSON.stringify(ownerStatusRule)) && rule.to.every(peer =>
      peer.ipBlock === undefined && peer.podSelector && Object.keys(peer.podSelector).length > 0)
    && Array.isArray(rule.ports) && rule.ports.length > 0
    && rule.ports.every(port => Number.isInteger(port.port) && !port.endPort)),
    'C_API must not add an unbounded IP, port or namespace egress escape');

  const apiSlot = '__OPENSPHERE_REGISTRY_KUBERNETES_EGRESS__';
  assert(JSON.stringify(kubernetesEgressPolicy.metadata?.labels) === JSON.stringify({
    'app.kubernetes.io/managed-by': 'opensphere-extension-controller',
    'app.kubernetes.io/part-of': 'opensphere-console',
    'opensphere.io/contract': 'registry-kubernetes-egress-v1',
  }), 'C_API Kubernetes egress policy must remain inside the C_EXT ownership contract');
  assert(JSON.stringify(kubernetesEgressPolicy.spec?.podSelector) === JSON.stringify({
    matchLabels: { 'app.kubernetes.io/name': 'opensphere-console-api' },
  }) && JSON.stringify(kubernetesEgressPolicy.spec?.policyTypes) === JSON.stringify(['Egress']),
  'C_API Kubernetes egress policy must select only C_API egress');
  assert(JSON.stringify(kubernetesEgressPolicy.spec?.egress) === JSON.stringify([apiSlot]),
    'C_API must require exactly one Setup-discovered Kubernetes API egress slot');

  const routedNginxSource = nginxSource + '\n' + targetRouteSource;
  assert(nginxSource.includes('include /etc/nginx/target-api-routes.conf;'),
    'Console Web must activate the target route table atomically');
  assert(targetRouteSource.includes('opensphere-console-api.opensphere-console.svc.cluster.local'),
    'Target route table omits C_API');
  assert(!/opensphere-console-(?:backend|dupa-controller)/u.test(routedNginxSource),
    'Target Console Web routing retained a legacy Backend or DUPA dependency');
  assert(targetRouteSource.includes('TargetPlatformCapabilityInactive')
    && targetRouteSource.includes('RouteRetired')
    && targetRouteSource.includes('sideEffect'),
    'Inactive or retired Platform routes must be explicit and fail closed');
}

export function verifyExtensionControllerDeployment({ documents }) {
  const one = (kind, name) => {
    const matches = documents.filter((document) => document?.kind === kind && document.metadata?.name === name);
    assert(matches.length === 1, 'C_EXT requires exactly one ' + kind + '/' + name);
    return matches[0];
  };
  const serviceAccount = one('ServiceAccount', 'opensphere-extension-controller');
  const role = one('Role', 'opensphere-extension-controller');
  const roleBinding = one('RoleBinding', 'opensphere-extension-controller');
  const egressDiscoveryRole = one('Role', 'opensphere-extension-controller-kubernetes-egress-discovery');
  const egressDiscoveryRoleBinding = one('RoleBinding', 'opensphere-extension-controller-kubernetes-egress-discovery');
  const cliRole = one('ClusterRole', 'opensphere-extension-controller-cli-downloads');
  const cliRoleBinding = one('ClusterRoleBinding', 'opensphere-extension-controller-cli-downloads');
  const deployment = one('Deployment', 'opensphere-extension-controller');
  for (const resource of [serviceAccount, role, roleBinding, deployment]) {
    assert(resource.metadata?.namespace === 'opensphere-console', 'C_EXT ' + resource.kind + ' escaped its namespace');
  }
  assert(egressDiscoveryRole.metadata?.namespace === 'default'
    && egressDiscoveryRoleBinding.metadata?.namespace === 'default',
  'C_EXT Kubernetes endpoint discovery must be scoped to the default namespace');
  assert(cliRole.metadata?.namespace == null && cliRoleBinding.metadata?.namespace == null,
    'C_EXT CLIDownload authority must be explicitly cluster scoped');
  assert(serviceAccount.automountServiceAccountToken === true, 'C_EXT requires its scoped Kubernetes service-account token');
  assert(roleBinding.roleRef?.apiGroup === 'rbac.authorization.k8s.io'
    && roleBinding.roleRef?.kind === 'Role'
    && roleBinding.roleRef?.name === 'opensphere-extension-controller', 'C_EXT RoleBinding has the wrong role');
  assert(roleBinding.subjects?.length === 1
    && roleBinding.subjects[0]?.kind === 'ServiceAccount'
    && roleBinding.subjects[0]?.name === 'opensphere-extension-controller'
    && roleBinding.subjects[0]?.namespace === 'opensphere-console', 'C_EXT RoleBinding has an unexpected subject');
  assert(cliRoleBinding.roleRef?.apiGroup === 'rbac.authorization.k8s.io'
    && cliRoleBinding.roleRef?.kind === 'ClusterRole'
    && cliRoleBinding.roleRef?.name === 'opensphere-extension-controller-cli-downloads',
  'C_EXT CLIDownload ClusterRoleBinding has the wrong role');
  assert(cliRoleBinding.subjects?.length === 1
    && cliRoleBinding.subjects[0]?.kind === 'ServiceAccount'
    && cliRoleBinding.subjects[0]?.name === 'opensphere-extension-controller'
    && cliRoleBinding.subjects[0]?.namespace === 'opensphere-console',
  'C_EXT CLIDownload ClusterRoleBinding has an unexpected subject');

  const normalizeRules = (rules) => (rules || []).map((rule) => ({
    apiGroups: [...(rule.apiGroups || [])].sort(),
    resources: [...(rule.resources || [])].sort(),
    resourceNames: [...(rule.resourceNames || [])].sort(),
    nonResourceURLs: [...(rule.nonResourceURLs || [])].sort(),
    verbs: [...(rule.verbs || [])].sort(),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const namespacedRules = normalizeRules([
    { apiGroups: ['plugins.opensphere.io'], resources: ['uipluginpackages'], verbs: ['get', 'list', 'create', 'update', 'patch'] },
    { apiGroups: ['plugins.opensphere.io'], resources: ['uipluginregistrations'], verbs: ['get', 'list', 'create', 'patch', 'delete'] },
    { apiGroups: ['plugins.opensphere.io'], resources: ['uipluginregistrations/status'], verbs: ['patch'] },
    { apiGroups: [''], resources: ['configmaps'], resourceNames: ['opensphere-extension-trusted-keys'], verbs: ['get'] },
    { apiGroups: [''], resources: ['serviceaccounts', 'services'], verbs: ['get', 'list', 'create', 'patch', 'delete'] },
    { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list', 'create', 'patch', 'delete'] },
    { apiGroups: ['policy'], resources: ['poddisruptionbudgets'], verbs: ['get', 'list', 'create', 'patch', 'delete'] },
    { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], resourceNames: ['opensphere-console-api-kubernetes-egress'], verbs: ['get', 'patch'] },
  ]);
  assert(JSON.stringify(normalizeRules(role.rules)) === JSON.stringify(namespacedRules),
    'C_EXT namespaced RBAC differs from its exact lifecycle and management contract');
  assert(JSON.stringify(normalizeRules(cliRole.rules)) === JSON.stringify(normalizeRules([
    { apiGroups: ['console.opensphere.io'], resources: ['clidownloads'], verbs: ['get', 'list', 'patch'] },
  ])), 'C_EXT cluster RBAC must contain only CLIDownload get/list/patch');
  assert(JSON.stringify(normalizeRules(egressDiscoveryRole.rules)) === JSON.stringify(normalizeRules([
    { apiGroups: [''], resources: ['services'], resourceNames: ['kubernetes'], verbs: ['get'] },
    { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['get', 'list'] },
  ])), 'C_EXT endpoint discovery RBAC must read only the default Kubernetes Service and EndpointSlices');
  assert(egressDiscoveryRoleBinding.roleRef?.apiGroup === 'rbac.authorization.k8s.io'
    && egressDiscoveryRoleBinding.roleRef?.kind === 'Role'
    && egressDiscoveryRoleBinding.roleRef?.name === 'opensphere-extension-controller-kubernetes-egress-discovery'
    && egressDiscoveryRoleBinding.subjects?.length === 1
    && egressDiscoveryRoleBinding.subjects[0]?.kind === 'ServiceAccount'
    && egressDiscoveryRoleBinding.subjects[0]?.name === 'opensphere-extension-controller'
    && egressDiscoveryRoleBinding.subjects[0]?.namespace === 'opensphere-console',
  'C_EXT endpoint discovery RoleBinding has an unexpected authority');
  const serializedRules = JSON.stringify([role.rules, egressDiscoveryRole.rules, cliRole.rules]);
  assert(!serializedRules.includes('"*"'), 'C_EXT RBAC must not contain wildcards');
  assert(!serializedRules.includes('"secrets"'), 'C_EXT runtime must not receive Secret API authority');

  const moduleAccount = one('ServiceAccount', 'opensphere-cluster-manager');
  const moduleRole = one('ClusterRole', 'opensphere-cluster-manager-read');
  const moduleBinding = one('ClusterRoleBinding', 'opensphere-cluster-manager-read');
  assert(moduleAccount.metadata?.namespace === 'opensphere-console' && moduleAccount.automountServiceAccountToken === false,
    'Cluster Manager requires one static account without automatic token mount');
  assert(JSON.stringify(normalizeRules(moduleRole.rules)) === JSON.stringify(normalizeRules([
    {apiGroups:[''],resources:['nodes','namespaces','pods','persistentvolumes','persistentvolumeclaims'],verbs:['get','list']},
    {apiGroups:['storage.k8s.io'],resources:['storageclasses'],verbs:['get','list']},
    {apiGroups:['ceph.rook.io'],resources:['cephclusters'],verbs:['get','list']},
    {nonResourceURLs:['/version'],verbs:['get']},
  ])), 'Cluster Manager RBAC must match the approved read-only inventory');
  assert(moduleBinding.roleRef?.apiGroup === 'rbac.authorization.k8s.io'
    && moduleBinding.roleRef?.kind === 'ClusterRole' && moduleBinding.roleRef?.name === 'opensphere-cluster-manager-read'
    && moduleBinding.subjects?.length === 1 && moduleBinding.subjects[0]?.kind === 'ServiceAccount'
    && moduleBinding.subjects[0]?.name === 'opensphere-cluster-manager'
    && moduleBinding.subjects[0]?.namespace === 'opensphere-console', 'Cluster Manager binding escaped its approved identity');
  const inventoryName = installationProfile.name;
  const inventoryAccount = one('ServiceAccount', inventoryName);
  const inventoryRole = one('ClusterRole', inventoryName);
  const inventoryBinding = one('ClusterRoleBinding', inventoryName);
  assert(inventoryAccount.metadata.namespace === 'opensphere-console' && inventoryAccount.automountServiceAccountToken === false,
    'C_EXT installation profile requires the approved static inventory account');
  assert(!inventoryRole.aggregationRule
    && JSON.stringify(normalizeRules(inventoryRole.rules)) === JSON.stringify(normalizeRules(installationProfile.rules)),
    'C_EXT installation profile escaped its approved inventory rules');
  for (const rule of inventoryRole.rules) {
    assert(!rule.resources?.includes('secrets') && (rule.verbs.every(verb => ['get','list','watch'].includes(verb))
      || JSON.stringify(normalizeRules([rule])) === JSON.stringify(normalizeRules([
        {apiGroups:['authorization.k8s.io'],resources:['selfsubjectaccessreviews'],verbs:['create']},
      ]))), 'C_EXT installation inventory must not grant Secret access or resource mutation');
  }
  const profileReaderName = 'opensphere-extension-installation-profile-reader';
  const profileReader = one('ClusterRole', profileReaderName);
  assert(!profileReader.aggregationRule && JSON.stringify(normalizeRules(profileReader.rules)) === JSON.stringify(normalizeRules([
    {apiGroups:['rbac.authorization.k8s.io'],resources:['clusterroles','clusterrolebindings'],resourceNames:[inventoryName],verbs:['get']},
  ])), 'C_EXT installation profile reader must get only its two named RBAC prerequisites');
  for (const [binding, roleName, accountName] of [
    [inventoryBinding, inventoryName, inventoryName],
    [one('ClusterRoleBinding', profileReaderName), profileReaderName, 'opensphere-extension-controller'],
  ]) {
    assert(binding.roleRef?.apiGroup === 'rbac.authorization.k8s.io' && binding.roleRef?.kind === 'ClusterRole'
      && binding.roleRef?.name === roleName && binding.subjects?.length === 1
      && binding.subjects[0]?.kind === 'ServiceAccount' && binding.subjects[0]?.name === accountName
      && binding.subjects[0]?.namespace === 'opensphere-console', 'C_EXT installation profile binding escaped its approved identity');
  }
  assert(documents.filter(document => document?.kind === 'ClusterRole').length === 4
    && documents.filter(document => document?.kind === 'ClusterRoleBinding').length === 4,
  'C_EXT deployment contains an unreviewed cluster authority');

  const pod = deployment.spec?.template?.spec;
  const container = pod?.containers?.find(({ name }) => name === 'controller');
  assert(pod?.serviceAccountName === 'opensphere-extension-controller' && pod?.automountServiceAccountToken === true, 'C_EXT pod lost its scoped Kubernetes identity');
  assert(container?.image === '__OPENSPHERE_EXTENSION_CONTROLLER_IMAGE__', 'C_EXT image must remain an exact-digest installer render input');
  assert(container?.securityContext?.allowPrivilegeEscalation === false, 'C_EXT must disable privilege escalation');
  assert(container?.securityContext?.readOnlyRootFilesystem === true, 'C_EXT must use a read-only root filesystem');
  assert(JSON.stringify(container?.securityContext?.capabilities?.drop) === JSON.stringify(['ALL']), 'C_EXT must drop all Linux capabilities');
  assert(container?.readinessProbe?.httpGet?.path === '/healthz', 'C_EXT readiness must verify PostgreSQL and lifecycle authority');
  assert(container?.livenessProbe?.httpGet?.path === '/livez', 'C_EXT liveness must remain independent of external authority availability');
  const lifecycleEnv = container?.env?.find((entry) => entry.name === 'CONSOLE_EXTENSION_LIFECYCLE_ENABLED');
  assert(lifecycleEnv?.value === 'true', 'C_EXT target lifecycle must be enabled for Setup core');
  const databaseEnv = container?.env?.find((entry) => entry.name === 'CONSOLE_EXTENSION_DATABASE_URL');
  assert(databaseEnv?.value === undefined, 'C_EXT database credential must not be a literal value');
  assert(databaseEnv?.valueFrom?.secretKeyRef?.name === 'opensphere-extension-controller-runtime', 'C_EXT database Secret name differs from the install contract');
  assert(databaseEnv?.valueFrom?.secretKeyRef?.key === 'database-url', 'C_EXT database Secret key differs from the install contract');
}

export async function verifyContracts(repoRoot = process.cwd(), { requireReleaseReady = false, releaseProfile = 'full' } = {}) {
  const root = resolve(repoRoot);
  const contractRoot = resolve(root, 'packages', 'contracts');
  const denominator = await json(resolve(contractRoot, 'contract-denominator.json'));
  const actionCatalog = await json(resolve(contractRoot, 'action-policies.json'));
  const boundary = await json(resolve(root, 'apps', 'component-boundaries.json'));
  const openapi = yaml.load(await readFile(resolve(contractRoot, 'openapi', 'console-v1.yaml'), 'utf8'));
  const schemas = await readdir(resolve(contractRoot, 'schemas'));
  const browserApiCutover = await verifyBrowserApiCutover({ root });
  const legacyApiDisposition = await verifyLegacyApiDisposition({ root });

  assert(openapi.openapi === '3.1.0', 'Console OpenAPI must use 3.1.0');
  assert(openapi.info?.['x-opensphere-status'] === denominator.status, 'OpenAPI and denominator status differ');
  assert(openapi.components?.parameters?.CsrfToken?.name === 'X-OS-CSRF-Token', 'OpenAPI CSRF header differs from the Console Web contract');
  assert(openapi.components?.parameters?.IdempotencyKey?.name === 'X-OS-Idempotency-Key', 'OpenAPI idempotency header differs from the Console Web contract');

  const sessionResolverSource = await readFile(resolve(root, 'apps', 'console-api', 'src', 'session-resolver.mjs'), 'utf8');
  const httpHandlerSource = await readFile(resolve(root, 'apps', 'console-api', 'src', 'http-handler.mjs'), 'utf8');
  const webHttpSource = await readFile(resolve(root, 'apps', 'console-web', 'src', 'app', 'core', 'http.service.ts'), 'utf8');
  const webAuthSource = await readFile(resolve(root, 'apps', 'console-web', 'src', 'app', 'core', 'auth.service.ts'), 'utf8');
  assert(/request\?*[.]headers\?*[.]\['x-os-csrf-token'\]/.test(sessionResolverSource), 'C_API does not consume the Console Web CSRF header');
  assert(webHttpSource.includes("headers.set('X-OS-CSRF-Token'"), 'Console Web shared HTTP client lost the canonical CSRF header');
  assert(webAuthSource.includes("headers.set('X-OS-CSRF-Token'"), 'Console Web identity client lost the canonical CSRF header');
  assert(httpHandlerSource.includes("request.headers['x-os-correlation-id']"), 'C_API does not consume the Console Web correlation header');
  assert(httpHandlerSource.includes("header(request, 'x-os-idempotency-key'"), 'C_API does not consume the Console Web idempotency header');
  assert(!httpHandlerSource.includes("request.headers['x-correlation-id']")
    && !httpHandlerSource.includes("header(request, 'idempotency-key'"), 'C_API retained a conflicting legacy header alias');
  assert(webHttpSource.includes("headers.set('X-OS-Correlation-ID'"), 'Console Web shared HTTP client lost the canonical correlation header');
  assert(webHttpSource.includes("headers.set('X-OS-Idempotency-Key'"), 'Console Web shared HTTP client lost the canonical idempotency header');

  const entries = operationEntries(openapi);
  const operationIds = entries.map(({ operation }) => operation.operationId);
  assert(new Set(operationIds).size === operationIds.length, 'operationId values must be unique');
  assert(
    JSON.stringify([...operationIds].sort()) === JSON.stringify([...denominator.operations].sort()),
    'OpenAPI operations differ from contract-denominator.json',
  );

  assert(actionCatalog.schemaVersion === '1.0', 'action policy catalog schemaVersion must be 1.0');
  assert(actionCatalog.policyRevision, 'action policy catalog has no policyRevision');
  const actionPolicies = actionCatalog.actions || [];
  const actionPolicyIds = actionPolicies.map((policy) => `${policy.actionId}@${policy.actionVersion}`);
  assert(new Set(actionPolicyIds).size === actionPolicyIds.length, 'action policy identities must be unique');
  assert(
    JSON.stringify([...actionPolicyIds].sort()) === JSON.stringify([...(denominator.requiredActionPolicies || [])].sort()),
    'action policies differ from contract-denominator.json',
  );
  for (const policy of actionPolicies) {
    assert(policy.requirement?.startsWith('CON-FR-'), `${policy.actionId} has no CON-FR trace`);
    assert(policy.permission, `${policy.actionId} has no permission`);
    assert(['R0', 'R1', 'R2', 'R3'].includes(policy.risk), `${policy.actionId} has invalid risk`);
    assert(typeof policy.approvalRequired === 'boolean', `${policy.actionId} has no approval rule`);
    assert(
      ['fenced-outbox', 'credential-broker-required', 'credential-broker', 'gitea-reviewed-declaration'].includes(policy.dispatchMode),
      `${policy.actionId} has no closed dispatch mode`,
    );
    assert(policy.ownerRef, `${policy.actionId} has no owner`);
    assert(policy.targetPattern, `${policy.actionId} has no target boundary`);
  }

  for (const { path, method, operation } of entries) {
    assert(operation.operationId, method.toUpperCase() + ' ' + path + ' has no operationId');
    assert(operation['x-opensphere-requirement'], operation.operationId + ' has no CON-FR trace');
    assert(operation.responses && Object.keys(operation.responses).length > 0, operation.operationId + ' has no responses');
    if (MUTATING_METHODS.has(method)) {
      assert(operation['x-opensphere-idempotency'], operation.operationId + ' has no idempotency policy');
      const parameters = operation.parameters || [];
      if (operation.operationId === 'loginSession') {
        assert(Array.isArray(operation.security) && operation.security.length === 0, 'loginSession must be the explicit unauthenticated bootstrap');
        assert(parameters.some((entry) => entry.$ref === '#/components/parameters/LoginOrigin'), 'loginSession has no exact-origin contract');
      } else if (operation.operationId === 'completePasswordRecovery') {
        assert(Array.isArray(operation.security) && operation.security.length === 0, 'completePasswordRecovery must use only the one-time recovery proof');
        assert(parameters.some((entry) => entry.$ref === '#/components/parameters/LoginOrigin'), 'completePasswordRecovery has no exact-origin contract');
        assert(
          operation.requestBody?.content?.['application/json']?.schema?.$ref === '../schemas/password-recovery-request.schema.json',
          'completePasswordRecovery must use the closed recovery-proof schema',
        );
      } else if (operation.operationId === 'bootstrapInitialAdministrator') {
        assert(Array.isArray(operation.security) && operation.security.length === 0, 'bootstrapInitialAdministrator must be explicitly unauthenticated');
        assert(parameters.some((entry) => entry.$ref === '#/components/parameters/LoginOrigin'), 'bootstrapInitialAdministrator has no exact-origin contract');
        assert(
          operation.requestBody?.content?.['application/json']?.schema?.$ref === '../schemas/initial-administrator-bootstrap-request.schema.json',
          'bootstrapInitialAdministrator must use the closed bootstrap schema',
        );
      } else if (['createCliDeviceEnrollment', 'pollCliDeviceEnrollment', 'createCliDeviceChallenge', 'createCliDeviceSession'].includes(operation.operationId)) {
        assert(Array.isArray(operation.security) && operation.security.length === 0,
          operation.operationId + ' must be explicitly unauthenticated and prove its own bounded secret');
      } else if (['inspectHissLifecycle','installHissModule','uninstallHissModule'].includes(operation.operationId)) {
        const route = {inspectHissLifecycle:'inspect',installHissModule:'install',uninstallHissModule:'uninstall'}[operation.operationId];
        assert(path === `/api/hiss/${route}` && method === 'post', 'HISS owner route changed');
        assert(operation.servers?.[0]?.url === 'http://cluster-manager.opensphere-console.svc.cluster.local:8080', 'HISS must name its actual owner server');
        assert(JSON.stringify(operation.security) === JSON.stringify([{OwnerAccess: []}]), 'HISS requires current user bearer, never browser-cookie-only mutation');
        assert(operation.requestBody?.content?.['application/json']?.schema?.$ref === `../schemas/hiss-${route==='inspect'?'inspect':'lifecycle'}-request.schema.json`, 'HISS closed input schema missing');
        assert(operation.responses?.['200']?.content?.['application/json']?.schema?.$ref === '../schemas/hiss-lifecycle-response.schema.json', 'HISS typed receipt schema missing');
      } else if (operation.operationId === 'appendClusterManagerOwnerAudit') {
        assert(path === '/api/internal/cluster-manager/events' && method === 'post', 'Cluster Manager audit owner path changed');
        assert(JSON.stringify(operation.security) === JSON.stringify([{OwnerAccess: []}]), 'Cluster Manager audit must accept only owner Bearer credentials');
        assert(parameters.some(entry => entry.name === 'x-os-owner-admission' && entry.required && entry.schema?.const === 'extension-controller-v1'), 'Cluster Manager audit owner marker missing');
        assert(operation.requestBody?.content?.['application/json']?.schema?.$ref === '../schemas/cluster-manager-audit.schema.json', 'Cluster Manager audit must use the closed no-secret event schema');
      } else if (['revokeCliDevice','executeShellCommand'].includes(operation.operationId)) {
        assert(JSON.stringify(operation.security) === JSON.stringify([{ BrowserSession: [] }, { CliBearer: [] }]),
          'revokeCliDevice must allow only browser or short CLI bearer authority');
        assert(parameters.some((entry) => entry.name === 'X-OS-CSRF-Token' && entry.required === false),
          'revokeCliDevice must declare conditional browser CSRF semantics');
      } else {
        assert(
          parameters.some((entry) => entry.$ref === '#/components/parameters/CsrfToken'),
          operation.operationId + ' has no CSRF contract',
        );
      }
    }
    if (operation['x-opensphere-action']) {
      assert(actionPolicyIds.includes(operation['x-opensphere-action']), operation.operationId + ' references an unknown action policy');
    }
  }

  const approvalOperation = entries.find(({ operation }) => operation.operationId === 'approveOperation')?.operation;
  const approvalSchema = approvalOperation?.requestBody?.content?.['application/json']?.schema;
  assert(approvalSchema?.required?.includes('expectedStateVersion'), 'approveOperation must require compare-and-set state version');
  assert(approvalSchema?.required?.includes('approvalRevision'), 'approveOperation must bind approval policy revision');

  const verificationOperation = entries.find(({ operation }) => operation.operationId === 'verifyOperation')?.operation;
  const verificationSchema = verificationOperation?.requestBody?.content?.['application/json']?.schema;
  assert(verificationSchema?.required?.includes('expectedStateVersion'), 'verifyOperation must require compare-and-set state version');

  const registryConnectionRead = entries.find(({ operation }) => operation.operationId === 'getRegistryConnection')?.operation;
  assert(
    registryConnectionRead?.['x-opensphere-authority'] === 'ConsoleRegistryConnectionMetadata',
    'getRegistryConnection must declare its no-secret metadata authority',
  );
  const registryVerification = entries.find(({ operation }) => operation.operationId === 'verifyRegistryConnection')?.operation;
  assert(registryVerification?.responses?.['200']?.content?.['application/json']?.schema?.$ref
    === '../schemas/registry-connection-verification-response.schema.json',
  'verifyRegistryConnection must use the closed live verification response schema');
  assert(registryVerification?.['x-opensphere-rate-limit'] === 'required',
    'verifyRegistryConnection must retain the bounded provider rate-limit contract');
  assert(httpHandlerSource.includes("/api/admin/extensions/registry-connections/opensphere-ghcr/verify")
    && httpHandlerSource.includes('registryOperations.verifyRegistryConnection'),
  'verifyRegistryConnection is declared but missing from the C_API runtime route');
  const auditRead = entries.find(({ operation }) => operation.operationId === 'listAuditEvents')?.operation;
  assert(auditRead?.['x-opensphere-authority'] === 'SupabaseAuditLedger', 'listAuditEvents must declare audit ledger authority');
  assert(
    auditRead?.parameters?.find((parameter) => parameter.name === 'limit')?.schema?.maximum === 200,
    'listAuditEvents must keep a bounded page size',
  );
  const sessionEventRead = entries.find(({ operation }) => operation.operationId === 'listOwnedSessionEvents')?.operation;
  assert(sessionEventRead?.['x-opensphere-authority'] === 'SupabaseAuditLedger', 'listOwnedSessionEvents must declare audit ledger authority');
  assert(
    sessionEventRead?.parameters?.find((parameter) => parameter.name === 'limit')?.schema?.maximum === 100,
    'listOwnedSessionEvents must keep a bounded self-service page size',
  );
  const recoveryLink = entries.find(({ operation }) => operation.operationId === 'requestOwnedPasswordRecoveryLink')?.operation;
  assert(recoveryLink?.['x-opensphere-authority'] === 'SupabaseAuth',
    'requestOwnedPasswordRecoveryLink must declare Supabase Auth authority');
  assert(recoveryLink?.parameters?.some((entry) => entry.$ref === '#/components/parameters/IdempotencyKey'),
    'requestOwnedPasswordRecoveryLink must require the canonical idempotency key');
  assert(recoveryLink?.requestBody?.content?.['application/json']?.schema?.$ref
    === '../schemas/owned-password-recovery-link-request.schema.json',
  'requestOwnedPasswordRecoveryLink must use the closed reason schema');
  assert(recoveryLink?.responses?.['200']?.content?.['application/json']?.schema?.$ref
    === '../schemas/owned-password-recovery-link-response.schema.json',
  'requestOwnedPasswordRecoveryLink must use the closed same-origin response schema');
  const avatarOperations = ['getProfileAvatar', 'selectProfileAvatar', 'uploadProfileAvatar', 'getProfileAvatarContent']
    .map((operationId) => entries.find(({ operation }) => operation.operationId === operationId)?.operation);
  assert(avatarOperations.every(Boolean), 'profile avatar route family is incomplete');
  assert(avatarOperations[0]['x-opensphere-authority'] === 'SupabaseAuth', 'profile avatar projection must use Auth authority');
  assert(avatarOperations[2]['x-opensphere-authority'] === 'SupabaseAuthAndPrivateStorage'
    && avatarOperations[3]['x-opensphere-authority'] === 'SupabaseAuthAndPrivateStorage',
  'profile avatar bytes must use Auth and private Storage authority');
  assert(avatarOperations[1].requestBody?.content?.['application/json']?.schema?.$ref
    === '../schemas/profile-avatar-selection-request.schema.json', 'profile avatar selection schema is not closed');
  assert(avatarOperations[2].requestBody?.content?.['application/json']?.schema?.$ref
    === '../schemas/profile-avatar-upload-request.schema.json', 'profile avatar upload schema is not closed');
  for (const operationId of ['completeSessionMfa', 'getSession', 'deleteSession', 'getMe', 'requestOwnedPasswordRecoveryLink', 'getProfileAvatar', 'selectProfileAvatar']) {
    const identityRead = entries.find(({ operation }) => operation.operationId === operationId)?.operation;
    assert(identityRead?.['x-opensphere-authority'] === 'SupabaseAuth', operationId + ' must declare Supabase Auth authority');
  }
  const currentSessionRead = entries.find(({ operation }) => operation.operationId === 'getSession')?.operation;
  assert(currentSessionRead?.responses?.['200']?.content?.['application/json']?.schema?.$ref
    === '../schemas/current-session-response.schema.json', 'getSession must use the closed current-session projection schema');
  assert(currentSessionRead?.responses?.['503']?.$ref === '#/components/responses/AuthorityUnavailable',
    'getSession must fail closed when a current identity authority is unavailable');
  const platformStatusRead = entries.find(({ operation }) => operation.operationId === 'getPlatformStatus')?.operation;
  assert(platformStatusRead?.['x-opensphere-authority'] === 'PlatformStatusObservation',
    'getPlatformStatus must name its missing observation authority');
  assert(platformStatusRead?.responses?.['200'] === undefined
    && platformStatusRead?.responses?.['503']?.content?.['application/json']?.schema?.$ref === '#/components/schemas/ErrorEnvelope',
  'getPlatformStatus must not claim platform state before an observation owner exists');
  const catalogRead = entries.find(({ operation }) => operation.operationId === 'listCatalogEntities')?.operation;
  assert(catalogRead?.['x-opensphere-authority'] === 'OpenSphereRegistry',
    'listCatalogEntities must declare C_REG read authority');
  assert(catalogRead?.responses?.['200']?.content?.['application/json']?.schema?.$ref
    === '../schemas/catalog-entities-response.schema.json',
  'listCatalogEntities must use the closed revision-bound projection schema');
  assert(catalogRead?.parameters?.find(({ name }) => name === 'limit')?.schema?.maximum === 200,
    'listCatalogEntities must keep a bounded page size');
  const runtimeObservation = entries.find(({ operation }) => operation.operationId === 'getCatalogRuntimeResources')?.operation;
  assert(runtimeObservation?.['x-opensphere-authority'] === 'KubernetesRuntimeObservation',
    'getCatalogRuntimeResources must name its missing runtime observation authority');
  assert(runtimeObservation?.requestBody?.content?.['application/json']?.schema?.$ref
    === '../schemas/catalog-runtime-resource-request.schema.json',
  'getCatalogRuntimeResources must accept only the bounded entity identity');
  assert(runtimeObservation?.responses?.['200'] === undefined
    && runtimeObservation?.responses?.['503']?.content?.['application/json']?.schema?.$ref === '#/components/schemas/ErrorEnvelope',
  'getCatalogRuntimeResources must not claim live data before an observation owner exists');
  const supabaseStatus = entries.find(({ operation }) => operation.operationId === 'getSupabaseStatus')?.operation;
  assert(supabaseStatus?.['x-opensphere-authority'] === 'Supabase', 'getSupabaseStatus must declare Supabase authority');
  assert(supabaseStatus?.['x-opensphere-permission'] === 'console.data_identity.read', 'getSupabaseStatus must declare its read permission');
  const giteaStatus = entries.find(({ operation }) => operation.operationId === 'getGiteaStatus')?.operation;
  assert(giteaStatus?.['x-opensphere-authority'] === 'Gitea', 'getGiteaStatus must declare Gitea authority');
  assert(giteaStatus?.['x-opensphere-permission'] === 'console.git.change', 'getGiteaStatus must declare its read permission');
  assert(giteaStatus?.responses?.['200']?.content?.['application/json']?.schema?.$ref
    === '../schemas/gitea-status-response.schema.json', 'getGiteaStatus must use the closed status schema');
  const argocdBootstrap = entries.find(({ operation }) => operation.operationId === 'bootstrapArgocdVerification')?.operation;
  assert(argocdBootstrap?.['x-opensphere-action'] === 'console.platform.change.propose@1.0',
    'bootstrapArgocdVerification must reuse the governed Gitea proposal action');
  assert(argocdBootstrap?.requestBody?.content?.['application/json']?.schema?.$ref
    === '../schemas/argocd-verification-bootstrap-request.schema.json',
  'bootstrapArgocdVerification must use the fixed closed input schema');
  assert(argocdBootstrap?.responses?.['201']?.content?.['application/json']?.schema?.$ref
    === '../schemas/argocd-verification-bootstrap-response.schema.json',
  'bootstrapArgocdVerification must expose the bounded proposal response');
  const installOperation = entries.find(({ operation }) => operation.operationId === 'installExtensionCandidate')?.operation;
  assert(
    installOperation?.requestBody?.content?.['application/json']?.schema?.$ref === '../schemas/extension-install-request.schema.json',
    'installExtensionCandidate must require the exact catalog-binding install schema',
  );
  const inspectOperation = entries.find(({ operation }) => operation.operationId === 'inspectExtensionCandidate')?.operation;
  assert(inspectOperation?.['x-opensphere-authority'] === 'OpenSphereRegistry', 'inspectExtensionCandidate must declare C_REG authority');
  assert(inspectOperation?.['x-opensphere-permission'] === 'console.extension.install', 'inspectExtensionCandidate must require install visibility');
  const removeOperation = entries.find(({ operation }) => operation.operationId === 'removeExtension')?.operation;
  assert(
    removeOperation?.requestBody?.content?.['application/json']?.schema?.$ref === '../schemas/extension-remove-request.schema.json',
    'removeExtension must require the canonical descriptor and confirmation schema',
  );
  assert(removeOperation?.['x-opensphere-action'] === 'console.extension.remove@1.0', 'removeExtension must use the typed removal action');

  const referencedActions = entries.map(({ operation }) => operation['x-opensphere-action']).filter(Boolean);
  for (const actionPolicyId of actionPolicyIds) {
    assert(referencedActions.includes(actionPolicyId), actionPolicyId + ' is not referenced by OpenAPI');
  }

  for (const schema of denominator.requiredSchemas) {
    assert(schemas.includes(schema), 'Required schema missing: ' + schema);
    const document = await json(resolve(contractRoot, 'schemas', schema));
    assert(document.$schema?.includes('2020-12'), schema + ' must use JSON Schema 2020-12');
    const closedVariants = Array.isArray(document.oneOf) && document.oneOf.length > 0
      && document.oneOf.every(variant => variant.type === 'object' && variant.additionalProperties === false);
    assert(document.additionalProperties === false || closedVariants, schema + ' must fail closed on unknown properties');
  }

  const componentIds = boundary.components.map((component) => component.id);
  const componentPaths = boundary.components.map((component) => component.path);
  assert(new Set(componentIds).size === componentIds.length, 'component boundary IDs must be unique');
  assert(new Set(componentPaths).size === componentPaths.length, 'component paths must be unique');

  const consoleApiBoundary = boundary.components.find((component) => component.id === 'C_API');
  assert(consoleApiBoundary?.path === 'apps/console-api', 'C_API path differs from the target component boundary');
  assert(consoleApiBoundary?.artifact === 'opensphere-console-api', 'C_API artifact differs from the target component boundary');
  assert(JSON.stringify(consoleApiBoundary?.auxiliaryArtifacts) === JSON.stringify([
    'opensphere-console-beszel-hub',
    'opensphere-console-beszel-agent',
    'opensphere-console-beszel-bootstrap',
  ]), 'C_API boundary omits its governed Beszel runtime artifacts');
  if (requireReleaseReady) {
    await verifyReleaseReadiness({ root, boundary, denominator, browserApiCutover, legacyApiDisposition, releaseProfile });
  }

  const consoleApiStore = await readFile(resolve(root, 'apps', 'console-api', 'src', 'postgres-operation-store.mjs'), 'utf8');
  const migrationManifest = await json(resolve(root, 'migrations', 'manifest.json'));
  const verifiedMigrationSet = (await Promise.all(
    migrationManifest.migrations.map((migration) => readFile(resolve(root, migration.path), 'utf8')),
  )).join('\n');
  const consoleApiDatabaseFunctions = verifyConsoleApiAuthority({ storeSource: consoleApiStore, baselineSource: verifiedMigrationSet });
  const consoleApiDockerfile = await readFile(resolve(root, 'apps', 'console-api', 'Dockerfile'), 'utf8');
  assert(consoleApiDockerfile.includes('COPY apps/console-api/src ./src'), 'C_API image does not copy the target runtime source');
  assert(consoleApiDockerfile.includes('USER 1001'), 'C_API image must run as the declared non-root identity');
  const consoleApiDeployment = [];
  yaml.loadAll(await readFile(resolve(root, 'apps', 'console-api', 'deploy.yaml'), 'utf8'), (document) => consoleApiDeployment.push(document));
  const consoleWebProxy = await readFile(resolve(root, 'apps', 'console-web', 'nginx', 'default.conf.template'), 'utf8');
  const consoleWebTargetRoutes = await readFile(resolve(root, 'apps', 'console-web', 'nginx', 'target-api-routes.conf'), 'utf8');
  verifyConsoleApiDeployment({ documents: consoleApiDeployment, nginxSource: consoleWebProxy, targetRouteSource: consoleWebTargetRoutes });
  const extensionControllerDeployment = [];
  yaml.loadAll(await readFile(resolve(root, 'apps', 'extension-controller', 'deploy.yaml'), 'utf8'), (document) => extensionControllerDeployment.push(document));
  verifyExtensionControllerDeployment({ documents: extensionControllerDeployment });

  const candidateWorkflow = await readFile(resolve(root, '.github', 'workflows', 'publish-candidate-images.yml'), 'utf8');
  const promotionWorkflow = await readFile(resolve(root, '.github', 'workflows', 'promote-release.yml'), 'utf8');
  const candidateReleaseArtifacts = new Set(
    (yaml.load(candidateWorkflow)?.jobs?.publish?.strategy?.matrix?.include || []).map(({ image }) => image),
  );
  const boundaryReleaseArtifacts = boundary.components.flatMap((component) => [
    component.artifact,
    ...(component.auxiliaryArtifacts || []),
  ]);
  assert(new Set(boundaryReleaseArtifacts).size === boundaryReleaseArtifacts.length,
    'component boundaries contain duplicate release artifact names');
  for (const artifact of boundaryReleaseArtifacts) {
    assert(candidateReleaseArtifacts.has(artifact),
      `component boundary artifact differs from the candidate release matrix: ${artifact}`);
  }
  const beszelReleaseContract = await json(resolve(root, 'deploy', 'baseline-monitoring', 'release-contract.json'));
  assert(beszelReleaseContract.ownerComponent === 'C_API' && beszelReleaseContract.authoritySystem === 'S_HOBS'
    && beszelReleaseContract.adapterComponent === 'API_HOBS' && beszelReleaseContract.requirement === 'CON-FR-011',
  'Beszel release contract differs from the Console host-observation authority boundary');
  assert(beszelReleaseContract.bootstrapCore === true, 'Beszel must remain a Console Backbone bootstrap component');
  const beszelArtifacts = Object.fromEntries((beszelReleaseContract.artifacts || []).map((artifact) => [artifact.key, artifact]));
  for (const [key, image, dockerfile] of [
    ['beszelHub', 'opensphere-console-beszel-hub', 'deploy/baseline-monitoring/images/hub/Dockerfile'],
    ['beszelAgent', 'opensphere-console-beszel-agent', 'deploy/baseline-monitoring/images/agent/Dockerfile'],
    ['beszelBootstrap', 'opensphere-console-beszel-bootstrap', 'deploy/baseline-monitoring/images/bootstrap/Dockerfile'],
  ]) {
    assert(beszelArtifacts[key]?.artifact === image && beszelArtifacts[key]?.dockerfile === dockerfile,
      `Beszel release artifact ${key} differs from the closed release contract`);
    assert(candidateWorkflow.includes(`- image: ${image}`) && candidateWorkflow.includes(`file: OpenSphere-console/${dockerfile}`),
      `Candidate workflow omits governed Beszel artifact ${key}`);
    assert(promotionWorkflow.includes(image), `Promotion workflow omits governed Beszel artifact ${key}`);
  }
  assert(candidateWorkflow.includes('node scripts/verify-console-contracts.mjs --release-ready'), 'Candidate workflow has no target-migration publication gate');
  assert(candidateWorkflow.includes('file: OpenSphere-console/apps/console-web/Dockerfile'), 'Candidate workflow does not build the C_WEB target Dockerfile');
  assert(candidateWorkflow.includes('- image: opensphere-console-api'), 'Candidate workflow does not publish the C_API target artifact');
  assert(candidateWorkflow.includes('file: OpenSphere-console/apps/console-api/Dockerfile'), 'Candidate workflow does not build the C_API target Dockerfile');
  assert(candidateWorkflow.includes('consoleApi'), 'Candidate BOM has no consoleApi component identity');
  assert(candidateWorkflow.includes('- image: opensphere-extension-controller'), 'Candidate workflow does not publish the C_EXT target artifact');
  assert(candidateWorkflow.includes('file: OpenSphere-console/apps/extension-controller/Dockerfile'), 'Candidate workflow does not build the C_EXT target Dockerfile');
  assert(candidateWorkflow.includes('extensionController'), 'Candidate BOM has no extensionController component identity');
  assert(!candidateWorkflow.includes('opensphere-console-backend'), 'Candidate workflow still publishes the legacy Backend artifact');
  assert(promotionWorkflow.includes('opensphere-console-api'), 'Promotion workflow omits the C_API target artifact');
  assert(promotionWorkflow.includes('opensphere-extension-controller'), 'Promotion workflow omits the C_EXT target artifact');
  assert(!promotionWorkflow.includes('opensphere-console-backend'), 'Promotion workflow still promotes the legacy Backend artifact');

  const publishedDockerfiles = [...candidateWorkflow.matchAll(/^\s*file:\s+OpenSphere-console\/(Dockerfile|[^\r\n]+\/Dockerfile)\s*$/gmu)]
    .map((match) => match[1]);
  assert(publishedDockerfiles.length > 0, 'Candidate workflow has no Dockerfile inputs');
  for (const dockerfilePath of publishedDockerfiles) {
    const dockerfile = await readFile(resolve(root, dockerfilePath), 'utf8');
    for (const line of dockerfile.split(/\r?\n/u).filter((value) => value.startsWith('FROM '))) {
      const image = line.slice('FROM '.length).split(/\s+/u)[0];
      if (image === 'scratch' || image.startsWith('${')) continue;
      assert(image.includes('@sha256:'), `${dockerfilePath} has an unpinned published base image: ${image}`);
    }
  }

  const packageJson = await readFile(resolve(root, 'package.json'), 'utf8');
  const sourceFiles = [
    resolve(root, 'apps', 'console-web', 'src', 'app', 'core', 'extension-host.service.ts'),
    resolve(root, 'apps', 'console-web', 'src', 'app', 'core', 'search.types.ts'),
  ];
  assert(!packageJson.includes('file:../OpenSphere-SDK'), 'root package must not depend on sibling SDK source');
  for (const sourceFile of sourceFiles) {
    assert(!(await readFile(sourceFile, 'utf8')).includes('@opensphere/sdk'), 'legacy SDK import remains: ' + sourceFile);
  }

  return {
    status: 'passed',
    contractStatus: denominator.status,
    operations: entries.length,
    actionPolicies: actionPolicies.length,
    schemas: denominator.requiredSchemas.length,
    components: boundary.components.length,
    releaseBoundaryStatus: boundary.status,
    consoleApiDatabaseFunctions: consoleApiDatabaseFunctions.length,
    browserApiPatterns: browserApiCutover.routePatternCount,
    browserApiFamilies: browserApiCutover.familyCount,
    targetBrowserSessionReady: browserApiCutover.targetSessionReady,
    authenticatedBrowserCutoverReady: browserApiCutover.authenticatedCutoverReady,
    legacyApiDispositions: legacyApiDisposition.decisions,
    legacyApiDispositionCounts: legacyApiDisposition.byDisposition,
    ...(requireReleaseReady ? { releaseReadinessProfile: releaseProfile } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const requireReleaseReady = process.argv.includes('--release-ready');
  const releaseProfileArguments = process.argv.filter((argument) => argument.startsWith('--release-profile='));
  assert(releaseProfileArguments.length <= 1, 'Only one Console release readiness profile may be selected');
  assert(requireReleaseReady || releaseProfileArguments.length === 0,
    '--release-profile requires --release-ready');
  const releaseProfile = releaseProfileArguments[0]?.slice('--release-profile='.length) || 'full';
  const result = await verifyContracts(process.cwd(), { requireReleaseReady, releaseProfile });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

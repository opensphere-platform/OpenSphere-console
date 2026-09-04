import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { verifyConsoleApiAuthority, verifyConsoleApiDeployment, verifyContracts, verifyExtensionControllerDeployment, verifyReleaseReadiness } from './verify-console-contracts.mjs';

test('foundational Console contracts are internally complete and self-contained', async () => {
  const result = await verifyContracts();
  assert.deepEqual(result, {
    status: 'passed',
    contractStatus: 'foundational-slice',
    operations: 66,
    actionPolicies: 6,
    schemas: 77,
    components: 10,
    releaseBoundaryStatus: 'target-migration',
    consoleApiDatabaseFunctions: 56,
    browserApiPatterns: 118,
    browserApiFamilies: 15,
    targetBrowserSessionReady: true,
    authenticatedBrowserCutoverReady: true,
    legacyApiDispositions: 277,
    legacyApiDispositionCounts: {
      adopted: 9,
      reworked: 236,
      rejected: 32,
    },
  });
});

test('Console Web exposes only the implemented interactive CLI credential surface', async () => {
  const profileSource = await readFile(new URL('../apps/console-web/src/app/pages/my-info.ts', import.meta.url), 'utf8');
  assert(profileSource.includes("'/api/identity/cli/devices'"));
  assert(profileSource.includes('/api/identity/cli/enrollments/'));
  assert(!profileSource.includes('/api/identity/cli/tokens'));
});

test('Console Web and CLI use only the bounded Beszel baseline monitoring authority', async () => {
  const source = await readFile(new URL('../apps/console-web/src/app/pages/admin-infrastructure-monitoring.ts', import.meta.url), 'utf8');
  const routes = await readFile(new URL('../apps/console-web/src/app/app.routes.ts', import.meta.url), 'utf8');
  const handler = await readFile(new URL('../apps/console-api/src/http-handler.mjs', import.meta.url), 'utf8');
  const cli = await readFile(new URL('../cmd/os-cli/cmd/os/main.go', import.meta.url), 'utf8');
  assert(source.includes('Baseline observation · Beszel v0.18.7'));
  assert(source.includes('관측 owner 미구성'));
  assert(source.includes("binding: 'beszel-authoritative'"));
  assert(source.includes("identity: 'beszel-system'"));
  assert(!source.includes('Kubernetes API의 현재 상태를 결합합니다'));
  assert(routes.includes("{ path: 'observability', redirectTo: 'infrastructure-monitoring', pathMatch: 'full' }"));
  assert(cli.includes('/api/monitoring/baseline/v1/data-health'));
  assert(cli.includes('/api/monitoring/baseline/v1/nodes'));
  assert(!cli.includes('/api/admin/observability') && !cli.includes('PromQL'));
  assert(!handler.includes('/api/admin/observability'));
});

test('Console Backbone readiness composes target authorities without a mutating HISS profile', async () => {
  const source = await readFile(new URL('../apps/console-web/src/app/core/platform-readiness.service.ts', import.meta.url), 'utf8');
  for (const endpoint of [
    '/api/identity/supabase/status',
    '/api/platform/gitea/status',
    '/api/platform/releases/status',
    '/api/monitoring/baseline/v1/data-health',
  ]) {
    assert(source.includes(endpoint), 'Backbone readiness is missing ' + endpoint);
  }
  assert(!source.includes('/api/admin/platform-readiness'));
  assert(!source.includes('preflight') && !source.includes('verify('));
});
test('Console Web exposes only target-governed platform changes', async () => {
  const source = await readFile(new URL('../apps/console-web/src/app/pages/admin-change-control.ts', import.meta.url), 'utf8');
  assert(source.includes("'/api/platform/changes'"));
  assert(source.includes('/api/platform/changes/${encodeURIComponent(change.request_id)}/approve'));
  assert(!source.includes('/api/platform/changes/${encodeURIComponent(change.request_id)}/retry'));
  assert(!source.includes('retrySelected'));
});

test('Console Web extension actions use the target authority contracts', async () => {
  const clientSource = await readFile(new URL('../apps/console-web/src/app/core/plugin-control-client.service.ts', import.meta.url), 'utf8');
  const pageSource = await readFile(new URL('../apps/console-web/src/app/pages/admin-plugins.ts', import.meta.url), 'utf8');
  assert(clientSource.includes('/api/admin/extensions/registry-connections/opensphere-ghcr'));
  assert(clientSource.includes('JSON.stringify({ username, credential, reason })'));
  assert(clientSource.includes("'X-OpenSphere-Confirmation': confirmation"));
  assert(clientSource.includes('reason, confirmation }'));
  assert(clientSource.includes('JSON.stringify({ descriptorId: descriptorId.trim(), catalogRevision: catalogRevision.trim(), reason: reason.trim() })'));
  assert(!clientSource.includes('/api/admin/extensions/registry-credentials'));
  assert(clientSource.includes('/api/admin/extensions/registry-connections/opensphere-ghcr/verify'));
  assert(clientSource.includes('...(replacementImage ? { replacementImage } : {})'));
  assert(pageSource.includes('revokeExpectedConfirmation(image: string)'));
  assert(!clientSource.includes('executionRevision'));
  assert(pageSource.includes('installableExtensionDescriptors'));
  assert(pageSource.includes('snapshot.revision'));
  assert(!pageSource.includes('extensionInstallImage'));
});

test('official publication remains blocked until every target component boundary is release-ready', async () => {
  await assert.rejects(
    verifyContracts(process.cwd(), { requireReleaseReady: true }),
    /Official publication is blocked while component boundaries remain target-migration/,
  );
});

test('bootstrap-core release readiness proves the installable routing scope without claiming global feature readiness', async () => {
  const result = await verifyContracts(process.cwd(), {
    requireReleaseReady: true,
    releaseProfile: 'bootstrap-core',
  });
  assert.equal(result.releaseReadinessProfile, 'bootstrap-core');
  assert.equal(result.releaseBoundaryStatus, 'target-migration');
  assert.equal(result.contractStatus, 'foundational-slice');
  assert.equal(result.authenticatedBrowserCutoverReady, true);
});

test('bootstrap-core release readiness rejects a reduced Setup responsibility partition', async () => {
  const boundary = JSON.parse(await readFile(new URL('../apps/component-boundaries.json', import.meta.url), 'utf8'));
  const denominator = JSON.parse(await readFile(new URL('../packages/contracts/contract-denominator.json', import.meta.url), 'utf8'));
  boundary.releaseProfiles['bootstrap-core'].artifactActivation.bootstrapCore.pop();
  await assert.rejects(
    verifyReleaseReadiness({
      root: process.cwd(),
      boundary,
      denominator,
      browserApiCutover: {
        targetSessionReady: true,
        authenticatedCutoverReady: true,
        currentSessionAuthority: 'console_identity.browser_session',
      },
      legacyApiDisposition: { status: 'passed', decisions: 277 },
      releaseProfile: 'bootstrap-core',
    }),
    /release component set differs from Setup responsibility/,
  );
});

test('release readiness rejects unknown profiles instead of silently falling back to full', async () => {
  await assert.rejects(
    verifyContracts(process.cwd(), { requireReleaseReady: true, releaseProfile: 'core' }),
    /Unknown Console release readiness profile/,
  );
});

test('a release-ready label cannot bypass incomplete API and browser cutover evidence', async () => {
  const boundary = {
    status: 'release-ready',
    components: [{ id: 'C_API', path: 'apps/console-api', legacySources: [] }],
  };
  await assert.rejects(
    verifyReleaseReadiness({
      root: process.cwd(),
      boundary,
      denominator: { status: 'foundational-slice', targetStatus: 'complete', remaining: { legacyProductionApiLiterals: 277 } },
      browserApiCutover: { contractStatus: 'target-migration', authenticatedCutoverReady: false },
    }),
    /complete API contract denominator/,
  );
});

test('Extension Controller deployment keeps its exact image, database secret, probes, and scoped RBAC', async () => {
  const documents = [];
  yaml.loadAll(await readFile(new URL('../apps/extension-controller/deploy.yaml', import.meta.url), 'utf8'), (document) => documents.push(document));
  assert.doesNotThrow(() => verifyExtensionControllerDeployment({ documents }));

  const withSecretRead = structuredClone(documents);
  withSecretRead.find((document) => document?.kind === 'Role'
    && document.metadata?.name === 'opensphere-extension-controller').rules.push({
    apiGroups: [''], resources: ['secrets'], verbs: ['get'],
  });
  assert.throws(() => verifyExtensionControllerDeployment({ documents: withSecretRead }),
    /namespaced RBAC differs|Secret API authority/);

  const withBroadCli = structuredClone(documents);
  withBroadCli.find((document) => document?.kind === 'ClusterRole'
    && document.metadata?.name === 'opensphere-extension-controller-cli-downloads').rules[0].verbs.push('watch');
  assert.throws(() => verifyExtensionControllerDeployment({ documents: withBroadCli }),
    /cluster RBAC must contain only CLIDownload/);

  const withBroadDiscovery = structuredClone(documents);
  withBroadDiscovery.find((document) => document?.kind === 'Role'
    && document.metadata?.name === 'opensphere-extension-controller-kubernetes-egress-discovery').rules[1].verbs.push('watch');
  assert.throws(() => verifyExtensionControllerDeployment({ documents: withBroadDiscovery }),
    /endpoint discovery RBAC/);

  const withoutTrustBinding = structuredClone(documents);
  delete withoutTrustBinding.find((document) => document?.kind === 'Role'
    && document.metadata?.name === 'opensphere-extension-controller').rules
    .find((rule) => rule.resources?.includes('configmaps')).resourceNames;
  assert.throws(() => verifyExtensionControllerDeployment({ documents: withoutTrustBinding }),
    /namespaced RBAC differs/);

  const disabled = structuredClone(documents);
  disabled.find((document) => document?.kind === 'Deployment'
    && document.metadata?.name === 'opensphere-extension-controller').spec.template.spec.containers[0].env
    .find((entry) => entry.name === 'CONSOLE_EXTENSION_LIFECYCLE_ENABLED').value = 'false';
  assert.throws(() => verifyExtensionControllerDeployment({ documents: disabled }),
    /target lifecycle must be enabled/);
});

test('Console API authority verification rejects missing grants and direct table mutation', async () => {
  const storeSource = await readFile(new URL('../apps/console-api/src/postgres-operation-store.mjs', import.meta.url), 'utf8');
  const baselineSource = await readFile(new URL('../migrations/baseline/0001_console_authority.sql', import.meta.url), 'utf8');
  const credentialSource = await readFile(new URL('../migrations/versions/0002_browser_session_credential_envelope.sql', import.meta.url), 'utf8');
  const mfaSource = await readFile(new URL('../migrations/versions/0003_browser_session_mfa_activation.sql', import.meta.url), 'utf8');
  const refreshSource = await readFile(new URL('../migrations/versions/0004_browser_session_refresh_rotation.sql', import.meta.url), 'utf8');
  const activitySource = await readFile(new URL('../migrations/versions/0005_browser_session_activity_expiry.sql', import.meta.url), 'utf8');
  const inventorySource = await readFile(new URL('../migrations/versions/0006_browser_session_inventory_revocation.sql', import.meta.url), 'utf8');
  const enrollmentSource = await readFile(new URL('../migrations/versions/0007_browser_session_totp_enrollment.sql', import.meta.url), 'utf8');
  const stepUpSource = await readFile(new URL('../migrations/versions/0008_browser_session_step_up.sql', import.meta.url), 'utf8');
  const recentAal2Source = await readFile(new URL('../migrations/versions/0009_recent_aal2_enforcement.sql', import.meta.url), 'utf8');
  const passwordRecoverySource = await readFile(new URL('../migrations/versions/0010_password_recovery_session_revocation.sql', import.meta.url), 'utf8');
  const bootstrapSource = await readFile(new URL('../migrations/versions/0011_initial_administrator_bootstrap.sql', import.meta.url), 'utf8');
  const preferenceSource = await readFile(new URL('../migrations/versions/0012_browser_session_preference.sql', import.meta.url), 'utf8');
  const eventSource = await readFile(new URL('../migrations/versions/0013_owned_browser_session_events.sql', import.meta.url), 'utf8');
  const recoveryLinkSource = await readFile(new URL('../migrations/versions/0014_owned_password_recovery_link.sql', import.meta.url), 'utf8');
  const avatarSource = await readFile(new URL('../migrations/versions/0015_owned_profile_avatar.sql', import.meta.url), 'utf8');
  const managedIdentitySource = await readFile(new URL('../migrations/versions/0016_managed_identity_roles.sql', import.meta.url), 'utf8');
  const managedIdentityLifecycleSource = await readFile(new URL('../migrations/versions/0017_managed_identity_lifecycle.sql', import.meta.url), 'utf8');
  const cliIdentitySource = await readFile(new URL('../migrations/versions/0018_cli_device_identity.sql', import.meta.url), 'utf8');
  const cliBearerManagementSource = await readFile(new URL('../migrations/versions/0019_cli_bearer_device_management.sql', import.meta.url), 'utf8');
  const verifiedMigrationSet = [baselineSource, credentialSource, mfaSource, refreshSource, activitySource, inventorySource, enrollmentSource, stepUpSource, recentAal2Source, passwordRecoverySource, bootstrapSource, preferenceSource, eventSource, recoveryLinkSource, avatarSource, managedIdentitySource, managedIdentityLifecycleSource, cliIdentitySource, cliBearerManagementSource].join('\n');
  const missingGrant = verifiedMigrationSet.replace(
    /GRANT EXECUTE ON FUNCTION console_audit[.]list_events\((?:.|\n)*?\) TO console_api;/,
    'GRANT EXECUTE ON FUNCTION console_audit.list_events(uuid) TO authenticated;',
  );
  assert.throws(
    () => verifyConsoleApiAuthority({ storeSource, baselineSource: missingGrant }),
    /console_audit[.]list_events is not granted exactly to the Console API runtime role/,
  );
  assert.throws(
    () => verifyConsoleApiAuthority({
      storeSource: `${storeSource}\nconst forbidden = 'DELETE FROM console_operation.operation';`,
      baselineSource: verifiedMigrationSet,
    }),
    /must use granted functions instead of direct authority-table mutation/,
  );
});

test('Console API deployment verification rejects credential ownership and legacy target routing', async () => {
  const deploymentSource = await readFile(new URL('../apps/console-api/deploy.yaml', import.meta.url), 'utf8');
  const nginxSource = await readFile(new URL('../apps/console-web/nginx/default.conf.template', import.meta.url), 'utf8');
  const targetRouteSource = await readFile(new URL('../apps/console-web/nginx/target-api-routes.conf', import.meta.url), 'utf8');
  const documents = [];
  yaml.loadAll(deploymentSource, (document) => documents.push(document));
  assert.throws(
    () => verifyConsoleApiDeployment({
      documents: [...documents, { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'forbidden' } }],
      nginxSource,
      targetRouteSource,
    }),
    /must consume, not create, its database Secret/,
  );
  assert.throws(
    () => verifyConsoleApiDeployment({
      documents,
      nginxSource,
      targetRouteSource: targetRouteSource.replace(
        'opensphere-console-api.opensphere-console.svc.cluster.local',
        'opensphere-console-backend.opensphere-console.svc.cluster.local',
      ),
    }),
    /omits C_API|retained a legacy Backend/,
  );
});

test('Console API registry activation rejects every expansion of the approved six-Secret authority', async () => {
  const deploymentSource = await readFile(new URL('../apps/console-api/deploy.yaml', import.meta.url), 'utf8');
  const nginxSource = await readFile(new URL('../apps/console-web/nginx/default.conf.template', import.meta.url), 'utf8');
  const targetRouteSource = await readFile(new URL('../apps/console-web/nginx/target-api-routes.conf', import.meta.url), 'utf8');
  const documents = yaml.loadAll(deploymentSource);
  const verify = docs => verifyConsoleApiDeployment({documents:docs,nginxSource,targetRouteSource});
  verify(documents);
  const mutations = [
    docs => docs.find(d=>d.kind==='Role').rules[0].verbs.push('list'),
    docs => docs.find(d=>d.kind==='Role').rules[0].verbs.push('patch'),
    docs => delete docs.find(d=>d.kind==='Role').rules[0].resourceNames,
    docs => docs.find(d=>d.kind==='Role').rules[0].resourceNames.push('unrelated-secret'),
    docs => docs.find(d=>d.kind==='Role').metadata.namespace='default',
    docs => docs.find(d=>d.kind==='RoleBinding').subjects.push({kind:'ServiceAccount',name:'other',namespace:'opensphere-console'}),
    docs => {docs.find(d=>d.kind==='RoleBinding').roleRef.kind='ClusterRole';},
    docs => docs.push({kind:'ClusterRole',metadata:{name:'unapproved'},rules:[]}),
    docs => {docs.find(d=>d.kind==='Deployment').spec.template.spec.automountServiceAccountToken=true;},
    docs => {docs.find(d=>d.kind==='Deployment').spec.template.spec.volumes[0].projected.sources[0].serviceAccountToken.expirationSeconds=86400;},
    docs => {docs.find(d=>d.kind==='Deployment').spec.template.spec.containers[0].volumeMounts[0].subPath='token';},
    docs => {docs.find(d=>d.kind==='NetworkPolicy').spec.egress[0].ports[0].port=6443;},
    docs => docs.find(d=>d.kind==='NetworkPolicy').spec.egress.push({ports:[{protocol:'TCP',port:6443}]}),
    docs => {docs.find(d=>d.kind==='NetworkPolicy').spec.egress[1]={to:[{ipBlock:{cidr:'0.0.0.0/0'}}],ports:[{protocol:'TCP',port:6443}]};},
    docs => {docs.find(d=>d.metadata?.name==='opensphere-console-api-kubernetes-egress').metadata.labels['opensphere.io/contract']='unowned/v1';},
    docs => docs.find(d=>d.metadata?.name==='opensphere-console-api-kubernetes-egress').spec.egress.push({to:[{ipBlock:{cidr:'0.0.0.0/0'}}]}),
    docs => {docs.find(d=>d.metadata?.name==='opensphere-console-api-kubernetes-egress').spec.podSelector={};},
  ];
  for (const mutate of mutations) {
    const changed=structuredClone(documents); mutate(changed);
    assert.throws(()=>verify(changed),/C_API/);
  }
});

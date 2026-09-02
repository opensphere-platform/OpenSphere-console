import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { verifyConsoleApiAuthority, verifyConsoleApiDeployment, verifyContracts } from './verify-console-contracts.mjs';

test('foundational Console contracts are internally complete and self-contained', async () => {
  const result = await verifyContracts();
  assert.deepEqual(result, {
    status: 'passed',
    contractStatus: 'foundational-slice',
    operations: 45,
    actionPolicies: 5,
    schemas: 43,
    components: 10,
    releaseBoundaryStatus: 'target-migration',
    consoleApiDatabaseFunctions: 36,
    browserApiPatterns: 122,
    browserApiFamilies: 15,
    targetBrowserSessionReady: true,
    authenticatedBrowserCutoverReady: false,
  });
});

test('official publication remains blocked until every target component boundary is release-ready', async () => {
  await assert.rejects(
    verifyContracts(process.cwd(), { requireReleaseReady: true }),
    /Official publication is blocked while component boundaries remain target-migration/,
  );
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
  const verifiedMigrationSet = [baselineSource, credentialSource, mfaSource, refreshSource, activitySource, inventorySource, enrollmentSource, stepUpSource, recentAal2Source, passwordRecoverySource, bootstrapSource, preferenceSource, eventSource, recoveryLinkSource, avatarSource, managedIdentitySource, managedIdentityLifecycleSource].join('\n');
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

test('Console API deployment verification rejects credential ownership and premature browser cutover', async () => {
  const deploymentSource = await readFile(new URL('../apps/console-api/deploy.yaml', import.meta.url), 'utf8');
  const nginxSource = await readFile(new URL('../nginx/default.conf.template', import.meta.url), 'utf8');
  const documents = [];
  yaml.loadAll(deploymentSource, (document) => documents.push(document));
  assert.throws(
    () => verifyConsoleApiDeployment({
      documents: [...documents, { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'forbidden' } }],
      nginxSource,
    }),
    /must consume, not create, its database Secret/,
  );
  assert.throws(
    () => verifyConsoleApiDeployment({
      documents,
      nginxSource: nginxSource.replaceAll(
        'opensphere-console-backend.opensphere-console.svc.cluster.local',
        'opensphere-console-api.opensphere-console.svc.cluster.local',
      ),
    }),
    /Authenticated Web routes must not cut over before the all-family routing gate is complete/,
  );
});

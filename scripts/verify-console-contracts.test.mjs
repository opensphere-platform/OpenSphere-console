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
    operations: 18,
    actionPolicies: 5,
    schemas: 9,
    components: 10,
    releaseBoundaryStatus: 'target-migration',
    consoleApiDatabaseFunctions: 10,
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
  const missingGrant = baselineSource.replace(
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
      baselineSource,
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
    /Authenticated Web routes must not cut over before the target browser-session authority is complete/,
  );
});

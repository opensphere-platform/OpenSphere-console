import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Install-ConsoleApiRuntime.ps1', import.meta.url), 'utf8');
const dataManifest = await readFile(new URL('../backend/supabase/target/deploy.yaml', import.meta.url), 'utf8');

test('Console target installer accepts only the six exact release images', () => {
  assert.match(source, /\[Parameter\(Mandatory = \$true\)\][\s\S]*\[string\]\$ConsoleApiImage/);
  for (const parameter of [
    'ConsoleApiImage',
    'ExtensionControllerImage',
    'SupabasePostgresImage',
    'SupabaseAuthImage',
    'SupabaseRestImage',
    'SupabaseStorageImage',
    'ConsoleUrl',
  ]) assert.match(source, new RegExp(`\\[string\\]\\$${parameter}`));
  for (const artifact of [
    'opensphere-console-api',
    'opensphere-extension-controller',
    'opensphere-console-supabase-postgres',
    'opensphere-console-supabase-auth',
    'opensphere-console-supabase-rest',
    'opensphere-console-supabase-storage',
  ]) assert.match(source, new RegExp(`Artifact = '${artifact}'`));
  assert.match(source, /@sha256:\[a-f0-9\]\{64\}/);
  assert.match(source, /ConsoleUrl must be an HTTPS origin/);
});

test('target Supabase manifest is the closed four-workload data backbone', () => {
  assert.doesNotMatch(dataManifest, /^kind:\s*(?:Namespace|Secret)\s*$/m);
  assert.doesNotMatch(dataManifest, /docker[.]io\//);
  const imageValues = [...dataManifest.matchAll(/^\s*image:\s*(\S+)/gm)].map((match) => match[1]);
  assert.equal(imageValues.length, 6);
  assert.ok(imageValues.every((image) => image.startsWith('__OPENSPHERE_')));
  assert.equal((dataManifest.match(/^kind: ServiceAccount$/gm) || []).length, 4);
  assert.equal((dataManifest.match(/^kind: PersistentVolumeClaim$/gm) || []).length, 2);
  assert.equal((dataManifest.match(/^kind: StatefulSet$/gm) || []).length, 1);
  assert.equal((dataManifest.match(/^kind: Deployment$/gm) || []).length, 3);
  assert.equal((dataManifest.match(/^kind: Service$/gm) || []).length, 4);
  assert.equal((dataManifest.match(/^kind: NetworkPolicy$/gm) || []).length, 4);
  assert.equal((dataManifest.match(/automountServiceAccountToken: false/g) || []).length, 8);
  assert.equal((dataManifest.match(/__OPENSPHERE_SUPABASE_POSTGRES_IMAGE__/g) || []).length, 3);
  assert.equal((dataManifest.match(/__OPENSPHERE_SUPABASE_AUTH_IMAGE__/g) || []).length, 1);
  assert.equal((dataManifest.match(/__OPENSPHERE_SUPABASE_REST_IMAGE__/g) || []).length, 1);
  assert.equal((dataManifest.match(/__OPENSPHERE_SUPABASE_STORAGE_IMAGE__/g) || []).length, 1);
  const secretKeys = [...dataManifest.matchAll(/secretKeyRef:\s*\{\s*name:\s*opensphere-supabase-secrets,\s*key:\s*([a-z0-9-]+)/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(secretKeys)].sort(), [
    'anon-key',
    'jwt-secret',
    'postgres-password',
    's3-access-key-id',
    's3-access-key-secret',
    'service-role-key',
  ]);
  assert.match(dataManifest, /opensphere-supabase-default-deny[\s\S]*policyTypes: \[Ingress, Egress\]/);
  assert.match(dataManifest, /opensphere-supabase-internal-egress/);
  const postgresPolicy = dataManifest.slice(
    dataManifest.indexOf('metadata: { name: opensphere-supabase-postgres-ingress'),
    dataManifest.indexOf('metadata: { name: opensphere-supabase-internal-egress'),
  );
  assert.ok(postgresPolicy.length > 0);
  for (const selector of [
    'app.kubernetes.io/name: opensphere-osdst',
    'app.kubernetes.io/name: opensphere-console-osaa-gateway',
    'app: opensphere-shell-api',
    'app: opensphere-shell-gateway',
    'app: opensphere-shell-reconciler',
  ]) {
    assert.match(postgresPolicy, new RegExp(selector.replaceAll('.', '[.]')));
  }
});

test('C_API runtime login remains a one-role one-secret fresh-lineage boundary', () => {
  assert.match(source, /migrations\\manifest[.]json/);
  assert.match(source, /migrationCount -lt 1/);
  assert.match(source, /migrations\)[.]Count -ne \[int\]\$migrationManifest[.]migrationCount/);
  assert.match(source, /requires the exact fresh migration prefix/);
  assert.match(source, /VerifiedMaterializedRelease requires the signed BOM migration manifest digest/);
  assert.match(source, /Materialized migration evidence differs from the verified signed Release BOM/);
  assert.match(source, /Get-FileHash -LiteralPath \$manifestPath -Algorithm SHA256/);
  assert.match(source, /--verified-materialized-release/);
  assert.match(source, /\$roleName = 'opensphere_console_api_runtime'/);
  assert.match(source, /CREATE ROLE \$roleName LOGIN PASSWORD/);
  assert.match(source, /NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20/);
  assert.match(source, /\$authorityRole = 'console_api'/);
  assert.match(source, /GRANT \$authorityRole TO \$roleName/);
  assert.match(source, /\$secretName = 'opensphere-console-api-runtime'/);
  assert.match(source, /\$secretKey = 'database-url'/);
  assert.match(source, /\$sessionEncryptionSecretKey = 'session-encryption-key'/);
  assert.match(source, /\$supabaseServiceRoleSecretKey = 'supabase-service-role-key'/);
  assert.match(source, /session encryption key must be canonical base64 for exactly 32 bytes/);
  assert.match(source, /'opensphere[.]io\/secret-scope' = 'console-api-only'/);
  assert.match(source, /\$secretKey = \$databaseUrl/);
  assert.match(source, /\$sessionEncryptionSecretKey = \$sessionEncryptionKey/);
  assert.match(source, /\$supabaseServiceRoleSecretKey = \$serviceRoleCredential/);
  assert.match(source, /Supabase Auth administrator credential differs from the fresh server authority/);
  assert.match(source, /Write-Output -NoEnumerate \$rows/);
  assert.doesNotMatch(source, /New-ServiceJwt|backend-password|osaa-gateway-password/);
  assert.doesNotMatch(source, /kind\s*=\s*'?(?:Deployment|StatefulSet|Role|ClusterRole)'?/);
});

test('C_EXT runtime has one least-privilege database login, one Secret, and one exact deployment', () => {
  assert.match(source, /\$extensionRoleName = 'opensphere_console_extension_runtime'/);
  assert.match(source, /\$extensionAuthorityRole = 'console_extension_controller'/);
  assert.match(source, /CREATE ROLE \$extensionRoleName LOGIN PASSWORD/);
  assert.match(source, /GRANT \$extensionAuthorityRole TO \$extensionRoleName/);
  assert.match(source, /CONNECTION LIMIT 8/);
  assert.match(source, /\$extensionSecretName = 'opensphere-extension-controller-runtime'/);
  assert.match(source, /'opensphere[.]io\/secret-scope' = 'extension-controller-only'/);
  assert.match(source, /Runtime Secret must match the exact C_EXT credential contract/);
  assert.match(source, /__OPENSPHERE_EXTENSION_CONTROLLER_IMAGE__/);
  assert.match(source, /deployment\/opensphere-extension-controller/);
  assert.match(source, /Installed C_EXT image differs from the requested exact digest/);
  assert.match(source, /delete', 'secret', \$extensionSecretName, '--wait=true'/);
  assert.match(source, /DROP ROLE IF EXISTS \$extensionRoleName/);
});

test('C_API runtime installer refuses implicit repair and keeps credentials off argv', () => {
  assert.match(source, /split provisioning state; no implicit repair or rotation was attempted/);
  assert.match(source, /IFS= read -r PGPASSWORD/);
  assert.match(source, /Credentials are sent|create', '-f', '-'/);
  assert.doesNotMatch(source, /kubectl[^\n]*(?:databaseUrl|runtimePassword)/i);
  assert.match(source, /delete', 'secret', \$secretName, '--wait=true'/);
  assert.match(source, /DROP ROLE IF EXISTS \$roleName/);
});

test('single target installer closes data bootstrap before fresh C_API runtime', () => {
  assert.match(source, /exact six-key fresh server Secret/);
  assert.match(source, /Test-SupabaseServiceJwt[\s\S]*'anon'/);
  assert.match(source, /Test-SupabaseServiceJwt[\s\S]*'service_role'/);
  assert.match(source, /HMACSHA256/);
  assert.match(source, /FixedTimeEquals/);
  assert.match(source, /Target Supabase resources are in a partial state; no implicit repair was attempted/);
  assert.match(source, /Legacy Supabase migration lineage cannot be reconciled/);
  assert.match(source, /ALTER ROLE authenticator LOGIN PASSWORD/);
  assert.match(source, /ALTER ROLE supabase_auth_admin LOGIN PASSWORD/);
  assert.match(source, /ALTER ROLE supabase_storage_admin LOGIN PASSWORD/);
  assert.match(source, /\/app\/dist\/scripts\/migrate-call[.]js/);
  assert.match(source, /console-migrations[.]mjs/);
  assert.match(source, /Get-AppliedMigrationCount/);
  assert.match(source, /for \(\$migrationIndex = \$appliedMigrationCount; \$migrationIndex -lt \[int\]\$migrationManifest[.]migrationCount; \$migrationIndex\+\+\)/);
  assert.match(source, /\$migrationRenderArguments = @\('render', \[string\]\$migration[.]globalId\)/);
  assert.match(source, /--single-transaction/);
  assert.match(source, /deployment\/opensphere-console-api/);
  assert.match(source, /Installed C_API image differs from the requested exact digest/);
  assert.doesNotMatch(source, /backend\\supabase\\install[.]ps1|backend\\supabase\\migrations/);
  assert.doesNotMatch(source, /create', 'namespace|kind\s*=\s*'Namespace'/);

  const preflight = source.indexOf('$existingDataResources = @(');
  const legacyLedger = source.indexOf('$legacyLedger = Invoke-OwnerSql');
  const dataApply = source.indexOf("Invoke-Kubectl @('apply', '-f', '-') $renderedDataDeployment");
  const serviceRoles = source.indexOf('Invoke-OwnerMigrationSql $serviceRoleSql');
  const auth = source.indexOf("'rollout', 'status', 'deployment/opensphere-supabase-auth'");
  const storageMigration = source.indexOf("'/app/dist/scripts/migrate-call.js'");
  const migration = source.indexOf('Invoke-OwnerMigrationSql $migrationSql');
  const dataReady = source.indexOf("'rollout', 'status', 'deployment/opensphere-supabase-storage'");
  const role = source.indexOf('Invoke-OwnerSql $createRoleSql');
  const deployment = source.indexOf("Invoke-Kubectl @('apply', '-f', '-') $renderedDeployment");
  const extensionDeployment = source.indexOf("Invoke-Kubectl @('apply', '-f', '-') $renderedExtensionDeployment");
  assert.ok(preflight >= 0 && legacyLedger > preflight && dataApply > legacyLedger);
  assert.ok(serviceRoles > dataApply && auth > serviceRoles && storageMigration > auth);
  assert.ok(migration > storageMigration && dataReady > migration && role > dataReady && deployment > role && extensionDeployment > deployment);
});

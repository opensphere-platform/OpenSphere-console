import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const installer = readFileSync(join(root, 'scripts', 'Install-ConsoleNativeRuntime.ps1'), 'utf8');
const apiManifest = readFileSync(join(root, 'apps', 'console-api', 'deploy.yaml'), 'utf8');
const shellManifest = readFileSync(join(root, 'apps', 'os-shell-control', 'deploy.yaml'), 'utf8');
const osdstManifest = readFileSync(join(root, 'apps', 'osdst', 'deploy.yaml'), 'utf8');
const migration = readFileSync(join(root, 'migrations', 'versions', '0035_setup_native_runtime_activation.sql'), 'utf8');

test('native runtime installer owns the full credential, trust, rollout, and activation sequence', () => {
  for (const role of [
    'opensphere_osaa_gateway_runtime', 'opensphere_osdst_runtime', 'opensphere_osdst_maintenance_runtime',
    'opensphere_shell_api_runtime', 'opensphere_shell_gateway_runtime', 'opensphere_shell_reconciler_runtime',
  ]) assert.match(installer, new RegExp(role));
  for (const secret of [
    'opensphere-osaa-gateway-db', 'opensphere-osdst-db', 'opensphere-osdst-maintenance-db',
    'opensphere-shell-api-db', 'opensphere-shell-gateway-db', 'opensphere-shell-reconciler-db',
    'opensphere-shell-control-runtime',
  ]) assert.match(installer, new RegExp(secret));
  assert.match(installer, /OS Shell TLS trust set is partial/u);
  assert.match(installer, /delegation-signing-key/u);
  assert.match(installer, /rollout','restart','deployment\/opensphere-console-api/u);
  assert.match(installer, /activate_native_runtime_from_setup/u);
  assert.ok(installer.indexOf("rollout','status'") < installer.indexOf('activate_native_runtime_from_setup'));
});

test('target manifests route OSDST and OS Shell through C_API with no copied Console frontdoor', () => {
  assert.match(osdstManifest, /image: __OPENSPHERE_OSDST_IMAGE__/u);
  assert.match(osdstManifest, /CONSOLE_IDENTITY_URL, value: "http:\/\/opensphere-console-api[.]/u);
  assert.match(osdstManifest, /name: opensphere-osdst-db, key: username/u);
  assert.match(osdstManifest, /name: opensphere-osdst-maintenance-db, key: username/u);
  assert.doesNotMatch(osdstManifest, /opensphere-console-backend|opensphere-osaa-runtime/u);
  assert.doesNotMatch(shellManifest, /kind: Deployment[\s\S]{0,180}name: opensphere-shell-console-api/u);
  assert.match(shellManifest, /name: opensphere-shell-console-api[\s\S]{0,180}app[.]kubernetes[.]io\/name: opensphere-console-api/u);
  assert.match(apiManifest, /name: OS_SHELL_DELEGATION_SIGNING_KEY/u);
  assert.match(apiManifest, /containerPort: 8444[\s\S]*containerPort: 8445/u);
});

test('setup activation is owner-only and verifies current release and migration evidence', () => {
  assert.match(migration, /activate_native_runtime_from_setup/u);
  assert.match(migration, /authority' <> 'opensphere-setup-cli'/u);
  assert.match(migration, /latestGlobalId/u);
  assert.match(migration, /migrationSetDigest/u);
  assert.match(migration, /workloadSet/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION console_shell[.]activate_native_runtime_from_setup\(bigint,jsonb\) FROM PUBLIC/u);
  assert.doesNotMatch(migration, /GRANT EXECUTE/u);
});

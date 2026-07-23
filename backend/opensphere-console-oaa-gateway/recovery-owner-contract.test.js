const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const gateway = fs.readFileSync(path.join(here, 'server.js'), 'utf8');
const backend = fs.readFileSync(path.join(here, '..', 'opensphere-console-backend', 'server.js'), 'utf8');
const readiness = fs.readFileSync(path.join(here, 'agent-control-readiness.js'), 'utf8');
const migration = fs.readFileSync(path.join(here, '..', 'supabase', 'migrations', '0022_oaa_recovery_owner_permissions.sql'), 'utf8');

test('recovery tools are closed-schema owner reads and are available to the provider loop', () => {
  for (const id of ['oaa.recovery.status', 'oaa.recovery.plan']) assert.ok(gateway.includes(id), `missing ${id}`);
  assert.match(gateway, /\/api\/oaa\/tools\/recovery\/status/);
  assert.match(gateway, /\/api\/oaa\/tools\/recovery\/plan/);
  assert.match(gateway, /get_platform_recovery_status/);
  assert.match(gateway, /plan_platform_recovery_drill/);
  assert.match(gateway, /requireClosedOwnerInputs\(inputs, \['component'\]\)/);
  assert.match(gateway, /OAA_RECOVERY_COMPONENTS/);
  assert.match(gateway, /console\.recovery\.read/);
});

test('recovery mutations fail closed until a signed executor advertises them', () => {
  assert.match(backend, /capabilities: \['status-read', 'plan-read'\]/);
  assert.match(backend, /executionAvailable: false/);
  assert.match(readiness, /recovery_owner_capability_incomplete/);
  assert.doesNotMatch(gateway, /'oaa\.recovery\.(drill|evidence)[^']*'\s*:\s*'console\.backup\.restore'/);
  assert.match(migration, /console\.backup\.restore permission remains reserved/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const gateway = fs.readFileSync(path.join(here, 'server.js'), 'utf8');
const backend = fs.readFileSync(path.join(here, '..', '..', 'apps', 'console-api', 'runtime', 'server.js'), 'utf8');
const backendDeploy = fs.readFileSync(path.join(here, '..', '..', 'apps', 'console-api', 'runtime', 'deploy.yaml'), 'utf8');
const readiness = fs.readFileSync(path.join(here, 'agent-control-readiness.js'), 'utf8');
const migration = fs.readFileSync(path.join(here, '..', '..', 'backend', 'supabase', 'migrations', '0022_oaa_recovery_owner_permissions.sql'), 'utf8');
const adapter = fs.readFileSync(path.join(here, '..', '..', 'backend', 'osaa-governed-adapter', 'server.js'), 'utf8');
const adapterDeploy = fs.readFileSync(path.join(here, '..', '..', 'backend', 'osaa-governed-adapter', 'deploy.yaml'), 'utf8');
const recovery = fs.readFileSync(path.join(here, '..', 'recovery-owner', 'recovery-jobs.yaml'), 'utf8');

test('recovery tools are closed-schema owner reads and are available to the provider loop', () => {
  for (const id of ['osaa.recovery.status', 'osaa.recovery.plan']) assert.ok(gateway.includes(id), `missing ${id}`);
  assert.match(gateway, /\/api\/osaa\/tools\/recovery\/status/);
  assert.match(gateway, /\/api\/osaa\/tools\/recovery\/plan/);
  assert.match(gateway, /get_platform_recovery_status/);
  assert.match(gateway, /plan_platform_recovery_drill/);
  assert.match(gateway, /requireClosedOwnerInputs\(inputs, \['component'\]\)/);
  assert.match(gateway, /OSAA_RECOVERY_COMPONENTS/);
  assert.match(gateway, /console\.recovery\.read/);
});

test('recovery drill execution is capability-gated and bound to the durable operation ledger', () => {
  assert.match(backend, /capabilities: \['status-read', 'plan-read', 'drill-request', 'evidence-promote'\]/);
  assert.match(backend, /executionAvailable: executorAvailable/);
  assert.match(backend, /async function recoveryExecutorAvailable/);
  assert.match(backend, /opensphere-console-recovery@sha256:\[a-f0-9\]\{64\}/);
  assert.match(backendDeploy, /opensphere-console-backend-recovery-template-reader[\s\S]*resources: \[cronjobs\][\s\S]*verbs: \[get\]/);
  assert.match(readiness, /recovery_owner_capability_incomplete/);
  assert.match(gateway, /'osaa\.recovery\.drill\.run': 'console\.backup\.restore'/);
  assert.match(gateway, /run-recovery-drill/);
  assert.match(gateway, /Never request archive bytes, credentials, URLs, commands, or an arbitrary manifest/);
  assert.match(migration, /console\.backup\.restore permission remains reserved/);
  assert.match(backend, /RECOVERY_DRILL_TARGETS/);
  assert.match(adapter, /recovery drill target is outside the fixed template contract/);
  assert.match(adapter, /RECOVERY_OPERATION_ID/);
  assert.match(adapterDeploy, /resources: \[cronjobs\][\s\S]*resourceNames: \[opensphere-supabase-recovery-drill, opensphere-gitea-recovery-drill\]/);
  assert.match(recovery, /opensphere-recovery-drill-job-boundary/);
  assert.match(recovery, /opensphere-console-recovery@sha256:\[a-f0-9\]\{64\}/);
});

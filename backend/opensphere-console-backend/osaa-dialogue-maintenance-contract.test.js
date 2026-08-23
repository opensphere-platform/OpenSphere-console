'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const backendSource = readFileSync(join(__dirname, 'server.js'), 'utf8');
const gatewaySource = readFileSync(join(__dirname, '..', 'opensphere-console-osaa-gateway', 'server.js'), 'utf8');
const conversationStore = readFileSync(join(__dirname, '..', 'opensphere-console-osaa-gateway', 'conversation-store.js'), 'utf8');
const migration = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '0071_osaa_dialogue_state_transition.sql'), 'utf8');
const backendDeploy = readFileSync(join(__dirname, 'deploy.yaml'), 'utf8');

test('CBSS Backend owns dialogue recovery through one scoped NOLOGIN role', () => {
  assert.match(migration, /CREATE ROLE opensphere_osaa_dialogue_maintenance NOLOGIN NOINHERIT NOBYPASSRLS/);
  assert.match(migration, /GRANT opensphere_osaa_dialogue_maintenance TO authenticator/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION osaa\.reap_expired_dialogue_turns\(integer\)[\s\S]*?TO opensphere_osaa_dialogue_maintenance/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION osaa\.recover_dialogue_turn\(uuid, uuid, text\)[\s\S]*?TO opensphere_osaa_dialogue_maintenance/);
  assert.match(backendSource, /serviceRole: OSAA_DIALOGUE_MAINTENANCE_DB_ROLE/);
  assert.match(backendSource, /startOsaaDialogueMaintenanceWorker/);
  assert.match(backendSource, /OSAA dialogue maintenance capability unavailable/);
  assert.match(backendDeploy, /OSAA_DIALOGUE_MAINTENANCE_REQUIRED, value: "true"/);
});

test('serving Gateway has no dialogue maintenance execution path', () => {
  assert.doesNotMatch(conversationStore, /reap_expired_dialogue_turns|recover_dialogue_turn|maintenancePoolProvider/);
  assert.doesNotMatch(gatewaySource, /initializeConversationLeaseReaper|conversationRecoveryMatch|\.recoverTurn\(/);
});

test('manual recovery stays behind AAL2, exact confirmation, and audit', () => {
  assert.match(backendSource, /verifyConsoleAdmin\(req, \{ requireAal2: true \}\)/);
  assert.match(backendSource, /recover dialogue turn \$\{conversationId\}\/\$\{turnRequestId\}/);
  assert.match(backendSource, /conversation-turn-recovery/);
});

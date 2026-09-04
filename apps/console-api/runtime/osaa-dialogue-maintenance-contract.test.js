'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const backendSource = readFileSync(join(__dirname, 'server.js'), 'utf8');
const gatewaySource = readFileSync(join(__dirname, '..', '..', 'osaa-gateway', 'server.js'), 'utf8');
const conversationStore = readFileSync(join(__dirname, '..', '..', 'osdst', 'conversation-store.js'), 'utf8');
const osdstSource = readFileSync(join(__dirname, '..', '..', 'osdst', 'server.js'), 'utf8');
const osdstDeploy = readFileSync(join(__dirname, '..', '..', 'osdst', 'deploy.yaml'), 'utf8');
const migration = readFileSync(join(__dirname, '..', '..', '..', 'backend', 'supabase', 'migrations', '0072_osaa_dialogue_maintenance_identity.sql'), 'utf8');
const installer = readFileSync(join(__dirname, '..', '..', '..', 'backend', 'supabase', 'install.ps1'), 'utf8');
const backendDockerfile = readFileSync(join(__dirname, 'Dockerfile'), 'utf8');
const backendDeploy = readFileSync(join(__dirname, 'deploy.yaml'), 'utf8');
const gatewayDeploy = readFileSync(join(__dirname, '..', '..', 'osaa-gateway', 'deploy.yaml'), 'utf8');

test('OSDST owns dialogue recovery through one direct scoped database login', () => {
  assert.match(installer, /CREATE ROLE opensphere_osaa_dialogue_maintenance LOGIN PASSWORD/);
  assert.match(migration, /REVOKE opensphere_osaa_dialogue_maintenance FROM authenticator/);
  assert.match(migration, /session_user <> 'opensphere_osaa_dialogue_maintenance'/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION osaa\.reap_expired_dialogue_turns\(integer\)[\s\S]*?TO opensphere_osaa_dialogue_maintenance/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION osaa\.recover_dialogue_turn\(uuid, uuid, text, text\)[\s\S]*?TO opensphere_osaa_dialogue_maintenance/);
  assert.match(migration, /AND c\.owner_id=expected_owner_id/);
  assert.match(osdstSource, /getMaintenancePool/);
  assert.match(osdstSource, /maintenance: maintenanceState/);
  assert.doesNotMatch(backendSource, /OSAA_DIALOGUE_MAINTENANCE_PG_PASSWORD/);
  assert.match(osdstSource, /reapExpiredTurns/);
  assert.match(backendSource, /OSDST capability unavailable/);
  assert.match(osdstDeploy, /opensphere-osaa-maintenance-runtime, key: dialogue-pg-password/);
  assert.match(backendSource, /osaa_dialogue_maintenance_ready/);
  assert.match(gatewaySource, /await requireDialogueMaintenanceCapability\(actor\);[\s\S]*?store[.]beginTurn/);
  assert.match(gatewaySource, /const dialogueMaintenance = readiness[?][.]maintenance/);
  assert.match(gatewaySource, /conversation_turn_maintenance_unavailable/);
  assert.match(backendDeploy, /readinessProbe: \{ httpGet: \{ path: \/serving-readyz/);
});

test('serving Gateway and Backend have no dialogue maintenance credential or writer path', () => {
  assert.doesNotMatch(conversationStore, /reap_expired_dialogue_turns|recover_dialogue_turn|maintenancePoolProvider/);
  assert.doesNotMatch(gatewaySource, /initializeConversationLeaseReaper|conversationRecoveryMatch|\.recoverTurn\(/);
  assert.doesNotMatch(gatewaySource, /R2D2_MAINTENANCE|r2d2MaintenancePool/);
  assert.doesNotMatch(gatewayDeploy, /maintenance-pg-user|maintenance-pg-password/);
  assert.doesNotMatch(backendDeploy, /dialogue-pg-user|dialogue-pg-password/);
  assert.match(osdstDeploy, /dialogue-pg-user/);
  assert.match(backendSource, /startR2d2MaintenanceWorker/);
});

test('Backend installs production dependencies before removing npm from the runtime image', () => {
  const installOffset = backendDockerfile.indexOf('RUN npm ci --omit=dev');
  const removalOffset = backendDockerfile.indexOf('/usr/local/lib/node_modules/npm');
  assert.ok(installOffset >= 0);
  assert.ok(removalOffset > installOffset);
});

test('manual recovery stays behind AAL2, exact confirmation, and audit', () => {
  assert.match(backendSource, /verifyConsoleAdmin\(req, \{ requireAal2: true \}\)/);
  assert.match(backendSource, /recover dialogue turn \$\{conversationId\}\/\$\{turnRequestId\}/);
  assert.match(backendSource, /conversation-turn-recovery/);
});

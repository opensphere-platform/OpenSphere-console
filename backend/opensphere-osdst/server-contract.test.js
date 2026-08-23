'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const server = readFileSync(join(__dirname, 'server.js'), 'utf8');
const deploy = readFileSync(join(__dirname, 'deploy.yaml'), 'utf8');
const dockerfile = readFileSync(join(__dirname, 'Dockerfile'), 'utf8');
const gateway = readFileSync(join(__dirname, '..', 'opensphere-console-osaa-gateway', 'server.js'), 'utf8');
const backend = readFileSync(join(__dirname, '..', 'opensphere-console-backend', 'server.js'), 'utf8');
const operationApi = readFileSync(join(__dirname, '..', 'opensphere-console-backend', 'r2d2-operation-api.js'), 'utf8');

test('OSDST is an independently observable CBSS Core Service', () => {
  assert.match(server, /service: 'opensphere-osdst'/);
  assert.match(server, /classification: 'CBSS Core Service'/);
  for (const route of ['/healthz', '/readyz', '/metrics', '/v1/status', '/v1/turns/begin', '/v1/turns/complete']) {
    assert.ok(server.includes(route), `missing ${route}`);
  }
  assert.match(deploy, /name: opensphere-osdst/);
  assert.match(deploy, /app\.kubernetes\.io\/component: cbss-core-service/);
  assert.match(deploy, /opensphere\.io\/osdst-mode: mutation-enforce/);
  assert.match(deploy, /name: OSDST_MODE/);
  assert.doesNotMatch(deploy, /name: APP_VERSION/);
  assert.match(dockerfile, /ARG APP_VERSION=development/);
  assert.match(dockerfile, /ENV PORT=8080 APP_VERSION=\$\{APP_VERSION\}/);
  assert.match(server, /state\.ready === true && maintenanceState\.ready === true/);
  assert.match(server, /requires osaa\.chat\.use/);
});

test('Gateway and Backend consume OSDST instead of owning Dialogue State writes', () => {
  assert.match(gateway, /createOsdstClient/);
  assert.doesNotMatch(gateway, /createConversationStore/);
  assert.doesNotMatch(gateway, /OSAA_DIALOGUE_STATE_MODE/);
  assert.match(backend, /const OSDST_URL/);
  assert.match(backend, /const OSAA_DIALOGUE_STATE_DEPLOYMENT = 'opensphere-osdst'/);
  assert.doesNotMatch(backend, /OSAA_DIALOGUE_MAINTENANCE_PG_PASSWORD/);
  assert.doesNotMatch(backend, /purgeExpiredOsaaDialogueState/);
  assert.match(backend, /resolveDialogueState:[\s\S]*osdstRequest/);
  assert.doesNotMatch(operationApi, /rpc\/resolve_dialogue_operation_context/);
});

test('OSDST derives transitions from tool results and rejects client transition authority', () => {
  assert.match(server, /dialogueTransitionForToolResult\(body\.response\?\.toolResult, body\.turn\?\.dialogueContext \|\| null\)/);
  assert.match(server, /dialogueTransition: MODE\.recordTransitions/);
  assert.doesNotMatch(server, /dialogueTransition: body\.response\?\.dialogueTransition/);
  assert.doesNotMatch(gateway, /dialogueTransitionForToolResult/);
});

test('OSDST reuses CBSS Supabase and adds no broker or application database', () => {
  assert.match(deploy, /opensphere-supabase-postgres\.opensphere-console-data/);
  assert.doesNotMatch(deploy, /kind: (StatefulSet|PersistentVolumeClaim|CustomResourceDefinition)/);
  assert.doesNotMatch(server, /kafka|rabbit|nats|redis|bullmq|temporal/i);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('R2D2 exposes PFSS PostgreSQL status, Admission plan, and owner create capability', () => {
  assert.match(source, /id: 'oaa\.foundation\.postgres\.status'/);
  assert.match(source, /id: 'oaa\.foundation\.postgres\.plan'/);
  assert.match(source, /id: 'oaa\.foundation\.postgres\.claim\.create'/);
  assert.match(source, /get_foundation_postgres_status/);
  assert.match(source, /plan_foundation_postgres_cluster/);
  assert.match(source, /\/api\/foundation\/oaa\/postgres\/status/);
  assert.match(source, /\/api\/oaa\/operations\/plan/);
  assert.match(source, /action: 'create-postgres-cluster'/);
  assert.doesNotMatch(source, /fixedOwnerPost\(FOUNDATION_CONTROL_URL, '\/api\/foundation\/postgres\/claims'/);
});

test('R2D2 binds the four authoritative PostgreSQL read contracts directly', () => {
  for (const id of ['capabilities', 'readiness', 'catalog', 'operation.watch']) {
    assert.match(source, new RegExp(`id: 'oaa\\.foundation\\.postgres\\.${id.replace('.', '\\.')}'`));
  }
  assert.match(source, /\/api\/foundation\/oaa\/postgres\/capabilities\?capability=data\.sql\.postgres/);
  assert.match(source, /\/api\/foundation\/oaa\/postgres\/readiness\?capability=data\.sql\.postgres/);
  assert.match(source, /\/api\/foundation\/oaa\/postgres\/catalog/);
  assert.match(source, /`\/api\/foundation\/oaa\/operations\/\$\{operationId\}`/);
  assert.match(source, /fixedOwnerGet\(FOUNDATION_CONTROL_URL/);
});

test('PostgreSQL create uses an expiring durable plan, exact confirmation, closed inputs, and owner postcondition', () => {
  assert.match(source, /create PostgreSQL cluster \$\{request\.namespace\}\/\$\{request\.name\} plan \$\{request\.plan\} version \$\{request\.postgresVersion\}/);
  assert.match(source, /requireConfirm\(inputs\.confirm, expected\)/);
  assert.match(source, /normalizeFoundationPostgresRequest\(inputs\)/);
  assert.match(source, /planId: plan\.planId, planDigest: plan\.planDigest, expiresAt: plan\.expiresAt/);
  assert.match(source, /FoundationClaim Bound with observedGeneration current/);
  assert.match(source, /verificationTool: 'get_foundation_postgres_status'/);
});

test('R2D2 does not mistake the postgres UI plugin for the owner cluster contract', () => {
  assert.match(source, /do not confuse the postgres UI plugin Deployment with a database cluster/);
  assert.match(source, /owner = 'PFSS PostgreSQL owner'/);
  assert.doesNotMatch(source, /oaa\.foundation\.postgres\.claim\.create'[\s\S]{0,1200}kubectl/);
});

test('vague PFSS PostgreSQL requests enter deterministic intake instead of fabricated defaults', () => {
  assert.match(source, /r2d2\.foundation-postgres-intake\/v1/);
  assert.match(source, /R2D2는 임의 기본값을 선택하지 않습니다/);
  assert.match(source, /FOUNDATION_POSTGRES_CONVERSATION_FIELDS = Object\.freeze/);
  for (const field of ['name', 'namespace', 'alias', 'database', 'owner', 'plan', 'postgresVersion', 'deletionPolicy']) {
    assert.match(source, new RegExp(`'${field}'`));
  }
  assert.match(source, /const foundationPostgresOut = await foundationPostgresConversation\(baseMessages, actor\)/);
  assert.match(source, /if \(foundationPostgresOut\) return foundationPostgresOut/);
  for (const phase of ['NeedsReadiness', 'NeedsInput', 'Planned', 'AwaitingApproval']) {
    assert.match(source, new RegExp(`['"]${phase}['"]`));
  }
  assert.match(source, /assertFoundationPostgresReadyToPlan\(readiness\)/);
  assert.match(source, /POSTGRES_OWNER_QUERY_UNAVAILABLE/);
  assert.match(source, /phase: operation\.workflow\.phase/);
});

test('PostgreSQL mutation planning fails closed before the durable planner when readiness is untrusted', () => {
  const actionStart = source.indexOf("} else if (toolId === 'oaa.foundation.postgres.claim.create')");
  const actionEnd = source.indexOf('\n  }\n\n  const result =', actionStart);
  const action = source.slice(actionStart, actionEnd);
  assert.ok(action.indexOf('foundationPostgresReadinessRead(actor)') < action.indexOf("'/api/oaa/operations/plan'"));
  assert.ok(action.indexOf('assertFoundationPostgresReadyToPlan(readiness)') < action.indexOf("'/api/oaa/operations/plan'"));
  assert.doesNotMatch(action, /\bkubectl\b|\bos-cli\b|execFile|spawn\(/);
});

test('every direct plan tool call checks authoritative readiness before planning', () => {
  const start = source.indexOf('async function foundationPostgresPlanRead');
  const end = source.indexOf('\n}\n\nasync function executeAgentTool', start);
  const plan = source.slice(start, end);
  assert.ok(plan.indexOf('foundationPostgresReadinessRead(actor)') < plan.indexOf("'/api/oaa/operations/plan'"));
  assert.ok(plan.indexOf('assertFoundationPostgresReadyToPlan(readiness)') < plan.indexOf("'/api/oaa/operations/plan'"));
});

test('accepted PostgreSQL work is reported through operation workflow and never as an unverified success', () => {
  assert.match(source, /ownerResult\.workflow = operationWorkflow\(receipt\)/);
  assert.match(source, /status: binding\.toolId === 'oaa\.foundation\.postgres\.claim\.create' \? 'accepted' : 'applied'/);
  assert.match(source, /foundationPostgresOperationMessage/);
  assert.match(source, /operationId must be a UUID/);
});

test('PFSS PostgreSQL confirmation is sourced from the owner plan and fully bound', () => {
  assert.match(source, /const expected = String\(plan\?\.expectedConfirmation \|\| ''\)/);
  assert.match(source, /확인 문구는 owner plan이 반환한 값/);
  assert.match(source, /replace\(\/<plan>\/g, String\(inputs\.plan \|\| ''\)\)/);
  assert.match(source, /replace\(\/<postgresVersion>\/g, String\(inputs\.postgresVersion \|\| ''\)\)/);
  assert.doesNotMatch(source, /key === 'his-binding'/);
  assert.match(source, /key === 'his-preflight'/);
});

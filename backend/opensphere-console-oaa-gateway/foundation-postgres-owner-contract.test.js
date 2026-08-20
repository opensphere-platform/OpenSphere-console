'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const postgresCreateBranch = () => source.slice(
  source.indexOf("} else if (toolId === 'oaa.foundation.postgres.claim.create')"),
  source.indexOf('\n  const result = { action: \'owner-control-action\'', source.indexOf("} else if (toolId === 'oaa.foundation.postgres.claim.create')")),
);

test('R2D2 exposes PFSS PostgreSQL status, Admission plan, and owner create capability', () => {
  assert.match(source, /id: 'oaa\.foundation\.postgres\.status'/);
  assert.match(source, /id: 'oaa\.foundation\.postgres\.plan'/);
  assert.match(source, /id: 'oaa\.foundation\.postgres\.claim\.create'/);
  assert.match(source, /get_foundation_postgres_status/);
  assert.match(source, /plan_foundation_postgres_cluster/);
  assert.match(source, /\/api\/foundation\/oaa\/postgres\/status/);
  assert.match(source, /\/api\/foundation\/oaa\/postgres\/durable-plan/);
  assert.match(source, /PFSS PostgreSQL owner durable planner/);
  assert.match(source, /assertFoundationPostgresPlanResponse\(await fixedOwnerPost\(/);
  assert.doesNotMatch(source, /fixedOwnerPost\(FOUNDATION_CONTROL_URL, '\/api\/foundation\/postgres\/claims'/);
});

test('PostgreSQL create consumes one owner plan with closed plan bindings and owner-provided confirmation', () => {
  assert.match(source, /planId: String\(plan\?\.planId \|\| ''\), planDigest: String\(plan\?\.planDigest \|\| ''\)/);
  assert.match(source, /confirm: 'exact owner plan expectedConfirmation'/);
  assert.match(source, /requireClosedOwnerInputs\(inputs, \['planId', 'planDigest', 'confirm', 'reason'\]\)/);
  assert.match(source, /planId must be the exact durable Owner plan ID/);
  assert.match(source, /planDigest must be the exact durable Owner digest/);
  assert.match(source, /FoundationClaim Bound with observedGeneration current/);
  assert.match(source, /verificationTool: 'get_foundation_postgres_status'/);
});

test('PostgreSQL plan message carries the exact Owner plan ID and digest into the action input', () => {
  assert.match(source, /planId: String\(plan\?\.planId \|\| ''\), planDigest: String\(plan\?\.planDigest \|\| ''\)/);
  assert.match(source, /Durable plan ID: \$\{actionInputs\.planId\}/);
  assert.match(source, /Durable plan digest: \$\{actionInputs\.planDigest\}/);
});

test('PostgreSQL apply input registries accept only plan bindings, owner confirmation, and audit reason', () => {
  assert.match(source, /requiredInputs: bindingInput\(\{[\s\S]{0,1200}planId:[\s\S]{0,1200}planDigest:[\s\S]{0,1200}reason:[\s\S]{0,1200}confirm:/);
  assert.match(source, /inputSchema: schemaObject\(\{[\s\S]{0,1200}planId:[\s\S]{0,1200}planDigest:[\s\S]{0,1200}confirm:[\s\S]{0,1200}reason:/);
});

test('PostgreSQL apply invokes the public durable Owner facade once', () => {
  const branch = postgresCreateBranch();
  assert.match(branch, /fixedOwnerPost\(FOUNDATION_CONTROL_URL,/);
  assert.match(branch, /\/api\/foundation\/oaa\/postgres\/durable-apply\/\$\{encodeURIComponent\(binding\.planId\)\}/);
  assert.equal((branch.match(/fixedOwnerPost\(/g) || []).length, 1);
  assert.doesNotMatch(branch, /retry/);
});

test('PostgreSQL apply forwards only the plan digest, owner confirmation, and audit reason', () => {
  const branch = postgresCreateBranch();
  assert.match(branch, /\{ planDigest: binding\.planDigest, confirmation: binding\.confirmation, reason \}/);
  assert.doesNotMatch(branch, /normalizeFoundationPostgresRequest\(inputs\)/);
});

test('PostgreSQL apply never replans or uses Console operations in the apply path', () => {
  const branch = postgresCreateBranch();
  assert.match(branch, /assertFoundationPostgresApplyResponse\(response, binding\)/);
  assert.doesNotMatch(branch, /CONSOLE_IDENTITY_URL/);
  assert.doesNotMatch(branch, /\/api\/foundation\/oaa\/postgres\/apply/);
  assert.doesNotMatch(branch, /\/api\/oaa\/operations/);
});

test('PostgreSQL apply rejects substituted plan ID and digest in the Owner response', () => {
  assert.match(source, /String\(response\?\.planId \|\| ''\) !== binding\.planId/);
  assert.match(source, /String\(response\?\.planDigest \|\| ''\) !== binding\.planDigest/);
});

test('PostgreSQL apply rejects a non-canonical public semantic identity', () => {
  assert.match(source, /response\?\.toolId !== 'foundation\.postgres\.apply'/);
  assert.match(source, /identity\?\.requestType === 'Instance'/);
  assert.match(source, /identity\?\.actionId === 'cluster\.create'/);
  assert.match(source, /identity\?\.toolId === 'foundation\.postgres\.apply'/);
});

test('PostgreSQL apply rejects a non-canonical action binding', () => {
  assert.match(source, /actionBinding\?\.path === '\/api\/foundation\/oaa\/postgres\/durable-apply\/\{planId\}'/);
  assert.match(source, /actionBinding\.pathParams\.length === 1/);
  assert.match(source, /actionBinding\?\.approval === 'exact-confirmation'/);
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
});

test('PFSS PostgreSQL confirmation is sourced from the owner plan and fully bound', () => {
  assert.match(source, /const expected = String\(plan\?\.expectedConfirmation \|\| ''\)/);
  assert.match(source, /확인 문구는 owner plan이 반환한 값/);
  assert.match(source, /exact owner plan confirmation is required/);
  assert.doesNotMatch(postgresCreateBranch(), /foundationPostgresConfirmation/);
  assert.doesNotMatch(source, /key === 'his-binding'/);
  assert.match(source, /key === 'his-preflight'/);
});

test('PFSS PostgreSQL remains v1-only and has no cancel/v2 owner facade code', () => {
  assert.doesNotMatch(source, /foundation\.operation\.cancel/);
  assert.doesNotMatch(source, /oaa\.foundation\.postgres\.operation\.cancel/);
  assert.doesNotMatch(source, /operation\.cancel/);
});

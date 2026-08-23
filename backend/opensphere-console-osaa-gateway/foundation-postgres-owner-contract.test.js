'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const transitionSource = fs.readFileSync(path.join(__dirname, 'dialogue-transition.js'), 'utf8');

test('R2D2 exposes PFSS PostgreSQL status, Admission plan, and owner create capability', () => {
  assert.match(source, /id: 'osaa\.foundation\.postgres\.status'/);
  assert.match(source, /id: 'osaa\.foundation\.postgres\.capabilities'/);
  assert.match(source, /id: 'osaa\.foundation\.postgres\.plan'/);
  assert.match(source, /id: 'osaa\.foundation\.postgres\.claim\.create'/);
  assert.match(source, /id: 'osaa\.foundation\.postgres\.operation\.watch'/);
  assert.match(source, /get_foundation_postgres_status/);
  assert.match(source, /plan_foundation_postgres_cluster/);
  assert.match(source, /\/api\/foundation\/osaa\/postgres\/status/);
  assert.match(source, /\/api\/osaa\/operations\/plan/);
  assert.match(source, /action: 'create-postgres-cluster'/);
  assert.doesNotMatch(source, /fixedOwnerPost\(FOUNDATION_CONTROL_URL, '\/api\/foundation\/postgres\/claims'/);
});

test('PostgreSQL create uses an expiring durable plan, exact confirmation, closed inputs, and owner postcondition', () => {
  assert.match(source, /create PostgreSQL cluster \$\{request\.namespace\}\/\$\{request\.name\} binding \$\{binding\} version \$\{request\.postgresVersion\} storage-profile \$\{request\.plan\}/);
  assert.match(source, /requireConfirm\(inputs\.confirm, expected\)/);
  assert.match(source, /normalizeFoundationPostgresApplyInputs\(inputs\)/);
  assert.match(source, /planId: plan\.planId, planDigest: plan\.planDigest/);
  assert.match(source, /`Plan expiry: \$\{plan\.expiresAt\}`/);
  assert.match(source, /storedPlan\.planDigest !== planDigest/);
  assert.match(source, /dialogueStateDigest: dialogue\.stateDigest/);
  assert.match(source, /FoundationClaim Bound with observedGeneration current/);
  assert.match(source, /verificationTool: 'get_foundation_postgres_status'/);
});

test('R2D2 does not mistake the postgres UI plugin for the owner cluster contract', () => {
  assert.match(source, /do not confuse the postgres UI plugin Deployment with a database cluster/);
  assert.match(source, /owner = 'PFSS PostgreSQL owner'/);
  assert.doesNotMatch(source, /osaa\.foundation\.postgres\.claim\.create'[\s\S]{0,1200}kubectl/);
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

test('PFSS PostgreSQL confirmation is bound to the stored plan digest and server-owned dialogue state', () => {
  assert.match(source, /const expected = foundationPostgresConfirmation\(request, planDigest\)/);
  assert.match(source, /storedPlan\.expectedConfirmation !== expected/);
  assert.match(source, /PFSS apply requires the server-owned Dialogue State/);
  assert.match(source, /dialogue\?\.intent !== 'create\.plan'/);
  assert.match(source, /dialogue\?\.phase !== 'plan_ready'/);
  assert.match(source, /String\(dialogueTarget\.namespace \|\| ''\) !== request\.namespace/);
  assert.match(source, /String\(dialogueTarget\.name \|\| ''\) !== request\.name/);
  assert.match(source, /Apply는 이 planId와 digest만 사용하며 재계획하지 않습니다/);
});

test('PFSS status and operation watch become typed deterministic claims in read-enforce', () => {
  assert.match(source, /foundationPostgresOperationConversation/);
  assert.match(source, /buildPfssPostgresOperationClaim/);
  assert.match(source, /renderPfssPostgresOperationClaim/);
  assert.match(source, /OSAA_DIALOGUE_POLICY\.enforceCurrentFacts/);
  assert.match(source, /body\?\._dialogueContext \|\| null/);
  assert.match(transitionSource, /operationRef: persistedOperationRef/);
  assert.match(source, /foundationPostgresContextualCapabilityConversation/);
  assert.match(source, /PFSS Owner 계약에는 PostgreSQL 클러스터 삭제 기능/);
  assert.match(source, /foundationPostgresReadinessRead/);
  assert.match(source, /persistedPfssContext/);
  assert.match(source, /!OSAA_DIALOGUE_POLICY\.recordTransitions && !UUID_RE\.test\(String\(dialogueContext\?\.operationRef/);
});

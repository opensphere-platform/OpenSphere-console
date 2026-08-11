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
  assert.match(source, /\/api\/foundation\/oaa\/postgres\/plan/);
  assert.match(source, /\/api\/foundation\/postgres\/claims/);
});

test('PostgreSQL create stays behind AAL2, exact confirmation, closed inputs, and owner postcondition', () => {
  assert.match(source, /PFSS PostgreSQL planning requires MFA assurance aal2/);
  assert.match(source, /create PostgreSQL cluster \$\{request\.namespace\}\/\$\{request\.name\} plan \$\{request\.plan\} version \$\{request\.postgresVersion\}/);
  assert.match(source, /requireConfirm\(inputs\.confirm, expected\)/);
  assert.match(source, /normalizeFoundationPostgresRequest\(inputs\)/);
  assert.match(source, /PostgresClaim Ready=True and observedGeneration equals metadata\.generation/);
  assert.match(source, /verificationTool: 'get_foundation_postgres_status'/);
});

test('R2D2 does not mistake the postgres UI plugin for the owner cluster contract', () => {
  assert.match(source, /do not confuse the postgres UI plugin Deployment with a database cluster/);
  assert.match(source, /owner = 'PFSS PostgreSQL owner'/);
  assert.doesNotMatch(source, /oaa\.foundation\.postgres\.claim\.create'[\s\S]{0,1200}kubectl/);
});

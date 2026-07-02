// BackboneClaim provider contract regression tests.
// Keeps consumer app-role issuance from regressing to owner-only Secret delivery.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const controller = fs.readFileSync(path.join(root, 'controller.js'), 'utf8');
const db = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
const crd = fs.readFileSync(path.join(root, 'backboneclaim-crd.yaml'), 'utf8');

test('BackboneClaim CRD exposes postgres appRole contract', () => {
  assert.match(crd, /appRole:/);
  assert.match(crd, /username:\s*\{\s*type:\s*string,\s*pattern:\s*'\^\[a-z_\]/);
});

test('BackboneClaim reconciler issues runtime app-role Secret', () => {
  assert.match(controller, /const appSecretName = `\$\{name\}-backbone-postgres-app`/);
  assert.match(controller, /cr\.spec\?\.postgres\?\.appRole\?\.enabled === false/);
  assert.match(controller, /postgresAppRoleName\(dbName, cr, appSec\)/);
  assert.match(controller, /db\.provisionTenantAppRole\(dbName, appUser, appPw\)/);
  assert.match(controller, /role:\s*'app'/);
  assert.match(controller, /status\.postgres\.appSecretRef = appSecretName/);
});

test('BackboneClaim GC removes app role and app Secret', () => {
  assert.match(controller, /db\.dropTenant\(dbName, appRole\)/);
  assert.match(controller, /k8s\('DELETE', `\/api\/v1\/namespaces\/\$\{ns\}\/secrets\/\$\{name\}-backbone-postgres-app`\)/);
});

test('Backbone PostgreSQL helper creates least-privilege app role', () => {
  assert.match(db, /async function provisionTenantAppRole\(database, username, password\)/);
  assert.match(db, /const qLiteral = \(s\) =>/);
  assert.match(db, /CREATE ROLE \$\{qIdent\(username\)\} LOGIN PASSWORD \$\{qLiteral\(password\)\}/);
  assert.doesNotMatch(db, /function provisionTenantAppRole[\s\S]*password must be alnum \(hex\)/);
  assert.match(db, /GRANT CONNECT ON DATABASE/);
  assert.match(db, /GRANT USAGE ON SCHEMA public/);
  assert.match(db, /module\.exports = \{[\s\S]*provisionTenantAppRole/);
});

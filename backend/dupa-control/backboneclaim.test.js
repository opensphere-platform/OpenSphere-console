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

test('BackboneClaim reconciler issues only a runtime app-role Secret', () => {
  assert.match(controller, /const appSecretName = `\$\{name\}-backbone-postgres-app`/);
  assert.match(controller, /cr\.spec\?\.postgres\?\.appRole\?\.enabled === false/);
  assert.match(controller, /owner credential을 발급하지 않으며 appRole을 비활성화할 수 없습니다/);
  assert.match(controller, /postgresAppRoleName\(dbName, cr, appSec\)/);
  assert.match(controller, /db\.provisionTenantAppRole\(dbName, appUser, appPw\)/);
  assert.match(controller, /role:\s*'app'/);
  assert.match(controller, /secretRef: appSecretName/);
  assert.match(controller, /ownerCredential: 'sealed-nologin'/);
  assert.match(controller, /secrets\/\$\{legacySecretName\}`\)/);
});

test('BackboneClaim GC removes app role and app Secret', () => {
  assert.match(controller, /db\.dropTenant\(dbName, appRole\)/);
  assert.match(controller, /k8s\('DELETE', `\/api\/v1\/namespaces\/\$\{ns\}\/secrets\/\$\{name\}-backbone-postgres-app`\)/);
});

test('Backbone PostgreSQL helper creates least-privilege app role', () => {
  assert.match(db, /async function provisionTenantAppRole\(database, username, password\)/);
  assert.match(db, /const qLiteral = \(s\) =>/);
  assert.match(db, /CREATE ROLE \$\{qIdent\(username\)\} LOGIN PASSWORD \$\{qLiteral\(password\)\}/);
  assert.match(db, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(db, /GRANT CONNECT ON DATABASE/);
  assert.match(db, /GRANT USAGE, CREATE ON SCHEMA public/);
  assert.match(db, /const tenantOwnerName/);
  assert.match(db, /NOLOGIN NOSUPERUSER/);
  assert.match(db, /module\.exports = \{[\s\S]*provisionTenantAppRole/);
});

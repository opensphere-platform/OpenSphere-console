const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const consoleRoot = path.resolve(__dirname, '..', '..');
const controller = fs.readFileSync(path.join(__dirname, 'controller.js'), 'utf8');
const db = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
const identity = fs.readFileSync(path.join(consoleRoot, 'backend', 'opensphere-console-backend', 'server.js'), 'utf8');
const nginx = fs.readFileSync(path.join(consoleRoot, 'nginx', 'default.conf.template'), 'utf8');
const consoleDeploy = fs.readFileSync(path.join(consoleRoot, 'deploy', 'opensphere-console.yaml'), 'utf8');
const backbone = fs.readFileSync(path.join(consoleRoot, 'backend', 'backbone', 'bootstrap', 'backbone.yaml'), 'utf8');
const architecture = fs.readFileSync(path.join(consoleRoot, 'docs', 'BACKBONE-ARCHITECTURE.md'), 'utf8');

test('Backbone is the mandatory readiness base for the Main Shell', () => {
  assert.match(controller, /p === '\/readyz'/);
  assert.match(controller, /postgres && rustfs && gitea && workloads\.ready/);
  assert.match(nginx, /location = \/readyz/);
  assert.match(consoleDeploy, /httpGet: \{ path: \/readyz, port: 8080 \}/);
  assert.match(architecture, /CBS → Main Shell\/Console 기능 → subShell → plugin/);
});

test('durable audit is fail-closed with no ConfigMap fallback', () => {
  assert.doesNotMatch(controller, /dupa-audit-log|AUDIT_CM|flushAudit/);
  assert.match(controller, /Backbone PostgreSQL unavailable/);
  assert.match(controller, /await durableAudit\(actor, 'mutation-request'/);
  assert.match(db, /throw new Error\('Backbone PostgreSQL unavailable'\)/);
  assert.match(db, /CREATE TRIGGER audit_log_append_only/);
  assert.match(db, /BEFORE UPDATE OR DELETE ON audit_log/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS managed_credential/);
  assert.match(db, /async function mutateManagedCredential/);
  assert.match(db, /BEGIN/);
  assert.match(db, /INSERT INTO audit_log/);
  assert.match(identity, /await requireBackbone\(\)/);
  assert.match(identity, /source: 'opensphere-console-backend'/);
});

test('Backbone bootstrap pins and isolates all three pillars', () => {
  for (const name of ['opensphere-backbone-postgres', 'opensphere-backbone-rustfs', 'opensphere-backbone-gitea']) {
    assert.match(backbone, new RegExp(`${name}@sha256:[a-f0-9]{64}`));
  }
  assert.match(backbone, /name: backbone-default-deny-ingress/);
  assert.match(backbone, /runAsNonRoot: true/);
  assert.match(backbone, /kind: PodDisruptionBudget/);
  assert.doesNotMatch(backbone, /:latest\b/);
});

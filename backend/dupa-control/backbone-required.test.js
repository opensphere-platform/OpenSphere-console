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
  // The user-owned architecture edit may already use the formal CBS acronym,
  // while the published baseline still spells out Backbone. Both express the
  // same mandatory ordering and the runtime contract below is authoritative.
  assert.match(architecture, /(?:CBS|Backbone) → Main Shell\/Console 기능 → subShell → plugin/);
});

test('durable audit is fail-closed with no ConfigMap fallback', () => {
  assert.doesNotMatch(controller, /dupa-audit-log|AUDIT_CM|flushAudit/);
  assert.match(controller, /Backbone PostgreSQL unavailable/);
  assert.match(controller, /await durableAudit\(actor, 'mutation-request'/);
  assert.match(db, /throw new Error\('Backbone PostgreSQL unavailable'\)/);
  assert.match(db, /Backbone PostgreSQL audit security schema is not ready/);
  assert.match(db, /audit_trigger_always/);
  assert.match(db, /audit_no_update/);
  assert.match(db, /audit_no_delete/);
  assert.match(db, /audit_no_truncate/);
  assert.match(db, /source, actor, action, target, result, reason/);
  assert.match(db, /Backbone PostgreSQL CA is required/);
  assert.match(db, /rejectUnauthorized: true/);
  assert.doesNotMatch(db, /CREATE TRIGGER audit_log_append_only/);
  assert.doesNotMatch(db, /CREATE TABLE IF NOT EXISTS audit_log/);
  assert.match(db, /async function mutateManagedCredential/);
  assert.match(db, /BEGIN/);
  assert.match(db, /INSERT INTO audit_log/);
  assert.match(identity, /await requireBackbone\(\)/);
  assert.match(identity, /source: 'opensphere-console-backend'/);
});

test('audit reads use PostgreSQL as the authority and fail closed', () => {
  assert.match(controller, /p === '\/api\/admin\/plugins\/events'/);
  assert.match(controller, /items: await db\.recentAudit\(AUDIT_CAP\)/);
  assert.match(controller, /Backbone PostgreSQL audit unavailable/);
  assert.doesNotMatch(controller, /plugins\/events'\) return json\(res, 200, \{ items: audit \}\)/);
});

test('Backbone bootstrap pins and isolates all three pillars', () => {
  for (const name of ['opensphere-backbone-postgres', 'opensphere-backbone-rustfs', 'opensphere-backbone-gitea']) {
    assert.match(backbone, new RegExp(`${name}@sha256:[a-f0-9]{64}`));
  }
  assert.match(backbone, /name: backbone-default-deny-ingress/);
  assert.match(backbone, /runAsNonRoot: true/);
  assert.match(backbone, /kind: PodDisruptionBudget/);
  assert.match(backbone, /00-console-runtime-boundary\.sh/);
  assert.match(backbone, /POSTGRES_USER, value: opensphere_db_bootstrap/);
  assert.match(backbone, /OPENSPHERE_CONSOLE_PASSWORD/);
  assert.match(backbone, /opensphere_audit_owner/);
  assert.match(backbone, /CREATE ROLE console LOGIN PASSWORD/);
  assert.match(backbone, /NOCREATEROLE NOCREATEDB/);
  assert.match(backbone, /ENABLE ALWAYS TRIGGER audit_log_append_only/);
  assert.match(backbone, /source\s+text NOT NULL DEFAULT 'dupa-controller'/);
  assert.match(backbone, /ssl=on/);
  assert.match(backbone, /ssl_cert_file=\/var\/run\/postgres-tls\/tls\.crt/);
  assert.match(backbone, /PGSSLMODE, value: verify-full/);
  assert.match(backbone, /GITEA__database__SSL_MODE, value: require/);
  assert.match(backbone, /RUSTFS_TLS_PATH, value: \/var\/run\/rustfs-tls/);
  assert.match(backbone, /rustfs_cert\.pem/);
  assert.match(backbone, /RUSTFS_ENDPOINT, value: https:\/\/backbone-rustfs/);
  assert.match(backbone, /GITEA__lfs__MINIO_USE_SSL, value: "true"/);
  assert.match(backbone, /backbone-postgres-boundary-reconcile/);
  assert.match(backbone, /name: bb-audit-boundary-__OPENSPHERE_RELEASE_REVISION__/);
  assert.doesNotMatch(backbone, /generateName: backbone-postgres-boundary-reconcile-/);
  assert.match(backbone, /ttlSecondsAfterFinished: 1800/);
  assert.ok('bb-audit-boundary-'.length + 40 <= 63, 'revision Job name must fit Kubernetes controller-label limit');
  assert.match(backbone, /ALTER ROLE console NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB/);
  assert.match(backbone, /name: PGPASSWORD, valueFrom: \{ secretKeyRef: \{ name: backbone-postgres, key: bootstrap_password \} \}/);
  assert.match(backbone, /pg_isready -h backbone-postgres -U opensphere_db_bootstrap -d postgres/);
  assert.match(backbone, /ALTER TABLE public\.audit_log ADD COLUMN IF NOT EXISTS source text/);
  assert.doesNotMatch(backbone, /:latest\b/);
});

test('audit evidence has a retained RustFS backup and a non-destructive restore drill', () => {
  assert.match(backbone, /kind: CronJob\nmetadata:\n  name: backbone-postgres-backup/);
  assert.match(backbone, /pg_dump -h backbone-postgres/);
  assert.match(backbone, /--format=custom --no-owner --no-privileges/);
  assert.match(backbone, /--aws-sigv4 "aws:amz:us-east-1:s3"/);
  assert.match(backbone, /--cacert \/tls\/ca\.crt/);
  assert.match(backbone, /BACKUP_RETENTION_DAYS/);
  assert.ok(backbone.includes('cutoff_epoch="$(( $(date -u +%s) - retention_days * 86400 ))"'));
  assert.ok(backbone.includes('date -u -d "@${cutoff_epoch}"'));
  assert.doesNotMatch(backbone, /date -u -d "\$\{retention_days\} days ago"/);
  assert.ok(backbone.includes("sed -n 's#.*<Key>\\(postgres/console-[0-9TZ]*\\.dump\\)</Key>.*#\\1#p'"));
  assert.doesNotMatch(backbone, /<Key>\\\\\(postgres\/console-\[0-9TZ\]\*\\\\\.dump\\\\\)<\/Key>/);
  assert.match(backbone, /kind: CronJob\nmetadata:\n  name: backbone-postgres-restore-drill/);
  assert.match(backbone, /suspend: true/);
  assert.match(backbone, /pg_restore -h backbone-postgres/);
  assert.match(backbone, /console_restore_drill_/);
});

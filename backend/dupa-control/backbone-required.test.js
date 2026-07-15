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

test('Console reverse proxy verifies Kanidm against the installation CA', () => {
  const authLocations = nginx.match(/location \^~ \/(?:oauth2\/openid\/opensphere-console|ui)\/|location \/bff\//g) ?? [];
  assert.equal(authLocations.length, 3);
  const installationCaReferences = nginx.match(/proxy_ssl_trusted_certificate \/etc\/nginx\/upstream-ca\/ca\.crt/g) ?? [];
  assert.equal(installationCaReferences.length, 3);
  assert.doesNotMatch(nginx, /proxy_ssl_trusted_certificate \/etc\/nginx\/upstream-ca\/tls\.crt/);
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
  assert.match(backbone, /BACKUP_S3_ENDPOINT, valueFrom: \{ secretKeyRef: \{ name: backbone-postgres-backup-target, key: endpoint \} \}/);
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

test('audit evidence has a retained S3-compatible backup target and a non-destructive restore drill', () => {
  assert.match(backbone, /kind: CronJob\nmetadata:\n  name: backbone-postgres-backup/);
  assert.match(backbone, /pg_dump -h backbone-postgres/);
  assert.match(backbone, /--format=custom --no-owner --no-privileges/);
  assert.match(backbone, /BACKUP_S3_ENDPOINT/);
  assert.match(backbone, /BACKUP_S3_BUCKET/);
  assert.match(backbone, /--aws-sigv4 "aws:amz:\$\{BACKUP_S3_REGION:-us-east-1\}:s3"/);
  assert.match(backbone, /--cacert \/backup-tls\/ca\.crt/);
  assert.match(backbone, /secretName: backbone-postgres-backup-target/);
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

test('the scheduled backup runs as a dedicated least-privilege opensphere_backup role, not console or the bootstrap superuser', () => {
  // The Setup-created backup Job failed because pg_dump ran as the console
  // runtime role, which has no access to schema oaa. The dump now authenticates
  // as an independent, read-only opensphere_backup role.
  assert.match(backbone, /pg_dump -h backbone-postgres\.opensphere-backbone\.svc\.cluster\.local -U opensphere_backup -d console/);
  // The console runtime role must never be the backup principal again.
  assert.doesNotMatch(backbone, /pg_dump[^\n]*-U console\b/);
  // The scheduled backup never uses the sealed bootstrap superuser.
  assert.doesNotMatch(backbone, /pg_dump[^\n]*-U opensphere_db_bootstrap\b/);
});

test('opensphere_backup is provisioned identically in both the empty-PVC init and the idempotent reconcile paths', () => {
  const initBlock = backbone.slice(
    backbone.indexOf('00-console-runtime-boundary.sh'),
    backbone.indexOf('backbone-postgres-boundary-reconcile')
  );
  const reconcileBlock = backbone.slice(backbone.indexOf('reconcile.sql:'));
  for (const block of [initBlock, reconcileBlock]) {
    // Created idempotently and always with the full least-privilege attribute set.
    assert.match(block, /CREATE ROLE opensphere_backup LOGIN PASSWORD %L NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS/);
    assert.match(block, /ALTER ROLE opensphere_backup LOGIN PASSWORD %L NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS/);
    // CONNECT to console + read-only membership via the PostgreSQL predefined role.
    assert.match(block, /GRANT CONNECT ON DATABASE console TO opensphere_backup;/);
    assert.match(block, /GRANT pg_read_all_data TO opensphere_backup;/);
  }
});

test('opensphere_backup receives no write grants and never the console/OAA credentials or superuser powers', () => {
  // Only CONNECT and the predefined read-only role may target opensphere_backup;
  // no INSERT/UPDATE/DELETE/CREATE/USAGE-on-schema write path is ever granted.
  assert.doesNotMatch(backbone, /GRANT[^\n]*(INSERT|UPDATE|DELETE|CREATE|TEMP)[^\n]*TO opensphere_backup/);
  assert.doesNotMatch(backbone, /GRANT[^\n]*ON SCHEMA[^\n]*TO opensphere_backup/);
  // The backup role is a plain login: the enabling attributes only ever appear in
  // their negated NO* form (a leading space would signal an un-negated grant).
  assert.doesNotMatch(backbone, /opensphere_backup[^\n]* (SUPERUSER|CREATEROLE|CREATEDB|REPLICATION|BYPASSRLS)\b/);
  // It never inherits the console/OAA/audit-owner/bootstrap roles' privileges.
  assert.doesNotMatch(backbone, /GRANT (console|opensphere_oaa|opensphere_audit_owner|opensphere_db_bootstrap) TO opensphere_backup/);
});

test('the backup_password credential is wired from backbone-postgres and carried only via Secret references', () => {
  // Empty-PVC init: required and imported inside psql from the Secret-backed
  // environment, never serialized into the psql process argv.
  assert.match(backbone, /OPENSPHERE_BACKUP_PASSWORD:\?OPENSPHERE_BACKUP_PASSWORD is required/);
  assert.match(backbone, /\\getenv backup_password OPENSPHERE_BACKUP_PASSWORD/);
  assert.doesNotMatch(backbone, /--set=(?:console|oaa|backup)_password=/);
  assert.match(backbone, /OPENSPHERE_BACKUP_PASSWORD, valueFrom: \{ secretKeyRef: \{ name: backbone-postgres, key: backup_password \} \}/);
  // Reconcile Job: injected via \getenv from the BACKUP_PASSWORD env, itself a secretKeyRef.
  assert.match(backbone, /\\getenv backup_password BACKUP_PASSWORD/);
  assert.match(backbone, /BACKUP_PASSWORD, valueFrom: \{ secretKeyRef: \{ name: backbone-postgres, key: backup_password \} \}/);
});

test('the backup CronJob authenticates with backup_password, distinct from the console runtime password', () => {
  assert.match(
    backbone,
    /command: \[sh, \/scripts\/backup\.sh\]\n\s*env:\n\s*- \{ name: PGPASSWORD, valueFrom: \{ secretKeyRef: \{ name: backbone-postgres, key: backup_password \} \} \}/
  );
  // The backup job must not fall back to the console runtime `password` key.
  assert.doesNotMatch(
    backbone,
    /command: \[sh, \/scripts\/backup\.sh\]\n\s*env:\n\s*- \{ name: PGPASSWORD, valueFrom: \{ secretKeyRef: \{ name: backbone-postgres, key: password \} \} \}/
  );
});

test('the restore drill keeps the sealed bootstrap operator and drops its unused console-password dependency', () => {
  const drillScript = backbone.slice(backbone.indexOf('restore-drill.sh: |'), backbone.indexOf('backbone-postgres-init'));
  // The drill still creates/drops an ephemeral database as the bootstrap operator.
  assert.match(drillScript, /POSTGRES_PASSWORD:\?POSTGRES_PASSWORD is required/);
  assert.match(drillScript, /createdb -h backbone-postgres[^\n]*\\\n\s*-U opensphere_db_bootstrap/);
  // The unused console-password PGPASSWORD requirement is gone from the script...
  assert.doesNotMatch(drillScript, /PGPASSWORD:\?PGPASSWORD is required/);
  // ...and from the restore-drill Job's env (no PGPASSWORD secretKeyRef there).
  const drillJob = backbone.slice(backbone.indexOf('command: [sh, /scripts/restore-drill.sh]'));
  const drillEnv = drillJob.slice(0, drillJob.indexOf('resources:'));
  assert.doesNotMatch(drillEnv, /name: PGPASSWORD/);
  assert.match(drillEnv, /POSTGRES_PASSWORD, valueFrom: \{ secretKeyRef: \{ name: backbone-postgres, key: bootstrap_password \} \}/);
});

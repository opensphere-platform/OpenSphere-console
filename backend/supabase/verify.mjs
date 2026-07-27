import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts) => fs.readFileSync(path.join(here, ...parts), 'utf8');
const manifest = read('bootstrap', 'supabase.yaml');
const schema = read('migrations', '0001_console_backbone.sql');
const boundary = read('migrations', '0002_backend_boundary.sql');
const correlation = read('migrations', '0003_change_correlation.sql');
const oaa = read('migrations', '0005_oaa_governed_agent.sql');
const cliIdentity = read('migrations', '0006_cli_identity.sql');
const extensionRevocation = read('migrations', '0007_extension_revocation.sql');
const backendServiceRole = read('migrations', '0008_backend_service_role.sql');
const governance = read('migrations', '0009_platform_control_governance.sql');
const approval = read('migrations', '0010_change_approval.sql');
const notification = read('migrations', '0011_notification_delivery.sql');
const llmUsage = read('migrations', '0012_oaa_llm_usage_ledger.sql');
const agentControlPlane = read('migrations', '0013_oaa_agent_control_plane.sql');
const cliTokenScope = read('migrations', '0014_cli_token_scope.sql');
const knowledgeRevisions = read('migrations', '0015_oaa_knowledge_revisions.sql');
const runtimeWatch = read('migrations', '0016_oaa_runtime_watch.sql');
const watchObserver = read('migrations', '0017_oaa_watch_observer.sql');
const ownerApiProjection = read('migrations', '0018_oaa_owner_api_projection.sql');
const evidenceCorrelation = read('migrations', '0019_oaa_evidence_correlation_retention.sql');
const ownerControlPermissions = read('migrations', '0020_oaa_owner_control_permissions.sql');
const infrastructureOwnerPermissions = read('migrations', '0021_oaa_infrastructure_owner_permissions.sql');
const recoveryOwnerPermissions = read('migrations', '0022_oaa_recovery_owner_permissions.sql');
const cephPrerequisiteConsumer = read('migrations', '0023_ceph_prerequisite_consumer.sql');
const aiConsumerContract = read('migrations', '0024_ai_consumer_contract.sql');
const externalChannelsBackup = read('migrations', '0025_external_channels_backup.sql');
const migrationLedger = read('migrations', '0026_schema_migration_ledger.sql');
const linuxHostAuthority = read('migrations', '0027_linux_host_authority.sql');
const rccBaseline = fs.readFileSync(path.join(here, '..', '..', 'deploy', 'rcc', 'supabase-baseline.sql'), 'utf8');
const installer = read('install.ps1');
const nginx = fs.readFileSync(path.join(here, '..', '..', 'nginx', 'default.conf.template'), 'utf8');

assert.match(installer, /\[string\]\$Namespace = "opensphere-console-data"/);
assert.match(installer, /\.Replace\("__OPENSPHERE_SUPABASE_NAMESPACE__", \$Namespace\)/);
assert.match(installer, /Get-ChildItem[\s\S]+-Filter '\*\.sql'[\s\S]+Sort-Object Name/);
assert.match(installer, /function Invoke-SupabaseMigrationPsql/);
assert.match(installer, /supabase_admin -d postgres -v ON_ERROR_STOP=1/);
assert.match(installer, /\[string\]\$SourceRevision/);
assert.match(installer, /SourceRevision must be the immutable 40-character release commit SHA/);
assert.match(installer, /function Get-SupabaseMigrationChecksum/);
assert.match(installer, /Migration checksum drift/);
assert.match(installer, /Supabase migration \$migrationId already attested/);
assert.match(installer, /foreach \(\$migration in \$migrations\)/);
assert.match(installer, /Invoke-SupabaseMigrationPsql \(Get-Content -Raw -LiteralPath \$migration\.FullName\)/);
assert.match(installer, /foreach \(\$workload in @\('opensphere-supabase-auth', 'opensphere-supabase-storage'\)\)[\s\S]+foreach \(\$migration in \$migrations\)/);
assert.match(installer, /foreach \(\$migration in \$migrations\)[\s\S]+foreach \(\$workload in @\('opensphere-supabase-rest', 'opensphere-supabase-storage'\)\)/);
assert.doesNotMatch(installer, /--from-literal/);
assert.match(manifest, /supabase\/postgres:17\.6\.1\.136/);
assert.match(manifest, /supabase\/gotrue:v2\.189\.0/);
assert.match(manifest, /supabase\/storage-api:v1\.60\.4/);
assert.match(manifest, /postgrest\/postgrest:v14\.12/);
assert.doesNotMatch(manifest, /image:\s+[^\n]+:latest\b/);
assert.doesNotMatch(manifest, /service-role-key[^\n]*value:/);
assert.doesNotMatch(manifest, /postgres-password[^\n]*value:/);
assert.match(manifest, /opensphere-supabase-default-deny/);

assert.match(schema, /user_id uuid PRIMARY KEY REFERENCES auth\.users\(id\)/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS console\.change_request/);
assert.match(schema, /git_commit_sha text CHECK/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS audit\.event/);
assert.match(schema, /CREATE TRIGGER audit_event_append_only/);
assert.match(schema, /ALTER TABLE audit\.event ENABLE ROW LEVEL SECURITY/);
assert.match(schema, /REVOKE INSERT, UPDATE, DELETE[\s\S]+audit\.event FROM anon, authenticated/);
assert.match(schema, /owner_id = auth\.uid\(\)/);
assert.match(boundary, /NOBYPASSRLS|NO-BYPASSRLS/);
assert.match(boundary, /REVOKE UPDATE, DELETE, TRUNCATE ON audit\.event/);
assert.match(correlation, /FUNCTION console\.begin_change/);
assert.match(correlation, /FUNCTION console\.record_change_commit/);
assert.match(correlation, /FUNCTION console\.record_reconcile_result/);
assert.match(correlation, /ON CONFLICT \(idempotency_key\)/);
assert.match(correlation, /GRANT EXECUTE[\s\S]+opensphere_console_backend/);
assert.match(oaa, /CREATE SCHEMA IF NOT EXISTS oaa/);
assert.match(oaa, /CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions/);
assert.match(oaa, /CREATE TABLE IF NOT EXISTS oaa\.document_version/);
assert.match(oaa, /CREATE TABLE IF NOT EXISTS oaa\.embedding/);
assert.match(oaa, /search_vector tsvector GENERATED ALWAYS/);
assert.match(oaa, /oaa\.knowledge\.read/);
assert.match(oaa, /ALTER TABLE oaa\.oaa_knowledge_documents ENABLE ROW LEVEL SECURITY/);
assert.match(oaa, /opensphere_oaa_gateway/);
assert.match(cliIdentity, /CREATE TABLE IF NOT EXISTS console\.cli_device/);
assert.match(cliIdentity, /CREATE TABLE IF NOT EXISTS console\.api_token/);
assert.match(cliIdentity, /FUNCTION console\.approve_cli_enrollment/);
assert.match(cliIdentity, /poll_token_hash text NOT NULL/);
assert.match(cliIdentity, /opensphere_console_backend/);
assert.match(cliIdentity, /DROP POLICY IF EXISTS console_backend_cli_device/);
assert.match(extensionRevocation, /CREATE TABLE IF NOT EXISTS console\.image_revocation/);
assert.match(extensionRevocation, /CREATE TRIGGER image_revocation_append_only/);
assert.match(extensionRevocation, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE[\s\S]+anon, authenticated/);
assert.match(extensionRevocation, /FUNCTION console\.revoke_image/);
assert.match(extensionRevocation, /INSERT INTO audit\.event/);
assert.match(extensionRevocation, /GRANT USAGE ON SCHEMA console, audit TO service_role/);
assert.match(extensionRevocation, /GRANT SELECT, INSERT ON audit\.event TO service_role/);
assert.match(backendServiceRole, /GRANT opensphere_console_backend TO authenticator/);
assert.match(backendServiceRole, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA console FROM service_role/);
assert.match(backendServiceRole, /GRANT SELECT ON console\.image_revocation TO service_role/);
assert.match(backendServiceRole, /GRANT SELECT, INSERT ON audit\.event TO service_role/);
assert.match(backendServiceRole, /GRANT EXECUTE ON FUNCTION console\.revoke_image/);
assert.match(governance, /CREATE TABLE IF NOT EXISTS console\.consumer_contract/);
assert.match(governance, /CREATE TABLE IF NOT EXISTS console\.gitea_webhook_receipt/);
assert.match(governance, /CREATE TABLE IF NOT EXISTS console\.change_outbox/);
assert.match(governance, /FUNCTION console\.record_change_proposal/);
assert.match(governance, /FUNCTION console\.queue_change_reconcile/);
assert.match(governance, /REVOKE ALL ON FUNCTION console\.record_change_proposal[\s\S]+anon, authenticated/);
assert.match(approval, /CREATE TABLE IF NOT EXISTS console\.change_approval/);
assert.match(approval, /FUNCTION console\.begin_change_approval/);
assert.match(approval, /change creator cannot approve their own request/);
assert.match(notification, /CREATE TABLE IF NOT EXISTS console\.notification_channel/);
assert.match(notification, /CREATE TABLE IF NOT EXISTS console\.notification_delivery/);
assert.match(notification, /opensphere_notification_dispatcher/);
assert.match(notification, /ENABLE ROW LEVEL SECURITY/);
assert.match(notification, /DROP POLICY IF EXISTS console_backend_notification_channel/);
assert.match(notification, /DROP POLICY IF EXISTS dispatcher_notification_control/);
assert.match(llmUsage, /CREATE TABLE IF NOT EXISTS oaa\.llm_usage_event/);
assert.match(llmUsage, /request_id uuid NOT NULL UNIQUE/);
assert.match(llmUsage, /input_tokens bigint NOT NULL DEFAULT 0/);
assert.match(llmUsage, /output_tokens bigint NOT NULL DEFAULT 0/);
assert.match(llmUsage, /cached_input_tokens bigint NOT NULL DEFAULT 0/);
assert.match(llmUsage, /reasoning_tokens bigint NOT NULL DEFAULT 0/);
assert.match(llmUsage, /CREATE TRIGGER llm_usage_event_append_only/);
assert.match(llmUsage, /ENABLE ALWAYS TRIGGER llm_usage_event_append_only/);
assert.match(llmUsage, /REVOKE ALL ON oaa\.llm_usage_event FROM PUBLIC, anon, authenticated/);
assert.match(llmUsage, /GRANT SELECT, INSERT ON oaa\.llm_usage_event TO opensphere_oaa_gateway/);
assert.match(llmUsage, /oaa\.usage\.read/);
assert.match(llmUsage, /never stores API keys, prompts, responses, or bearer tokens/i);
assert.match(agentControlPlane, /CREATE TABLE IF NOT EXISTS oaa\.runtime_resource/);
assert.match(agentControlPlane, /CREATE TABLE IF NOT EXISTS oaa\.agent_run/);
assert.match(agentControlPlane, /CREATE TABLE IF NOT EXISTS oaa\.agent_step/);
assert.match(agentControlPlane, /FUNCTION console\.claim_change_reconcile/);
assert.match(agentControlPlane, /FOR UPDATE OF o SKIP LOCKED/);
assert.match(agentControlPlane, /retrieval_trace_append_only/);
assert.match(agentControlPlane, /tool_run_append_only/);
assert.match(agentControlPlane, /REVOKE UPDATE, DELETE, TRUNCATE ON oaa\.retrieval_trace, oaa\.tool_run, oaa\.agent_step/);
assert.match(cliTokenScope, /scope IN \('console-read', 'console-change', 'console-admin'\)/);
assert.match(knowledgeRevisions, /ADD COLUMN IF NOT EXISTS document_revision/);
assert.match(knowledgeRevisions, /UNIQUE \(document_id, document_revision, chunk_index\)/);
assert.match(knowledgeRevisions, /ON DELETE RESTRICT/);
assert.match(runtimeWatch, /CREATE TABLE IF NOT EXISTS oaa\.runtime_event/);
assert.match(runtimeWatch, /CREATE TABLE IF NOT EXISTS oaa\.watch_cursor/);
assert.match(runtimeWatch, /CREATE TRIGGER runtime_event_append_only/);
assert.match(runtimeWatch, /payload_digest text NOT NULL/);
assert.match(runtimeWatch, /REVOKE UPDATE, DELETE, TRUNCATE ON oaa\.runtime_event/);
assert.match(watchObserver, /ADD COLUMN IF NOT EXISTS observer_id/);
assert.match(watchObserver, /PRIMARY KEY \(source, observer_id, kind, namespace\)/);
assert.match(ownerApiProjection, /runtime_resource_source_freshness_idx/);
assert.match(ownerApiProjection, /runtime_event_source_observed_idx/);
assert.match(ownerApiProjection, /owner-API state changes/);
assert.match(evidenceCorrelation, /ADD COLUMN IF NOT EXISTS agent_run_id/);
assert.match(evidenceCorrelation, /CREATE TABLE IF NOT EXISTS oaa\.evidence_retention_policy/);
assert.match(evidenceCorrelation, /CREATE TABLE IF NOT EXISTS oaa\.evidence_export_receipt/);
assert.match(evidenceCorrelation, /FUNCTION oaa\.set_evidence_retention_policy/);
assert.match(evidenceCorrelation, /No purge API is exposed/);
assert.match(ownerControlPermissions, /console\.extension\.security\.read/);
assert.match(ownerControlPermissions, /console\.extension\.security\.manage/);
assert.match(ownerControlPermissions, /console\.notification\.read/);
assert.match(ownerControlPermissions, /console\.notification\.manage/);
assert.match(ownerControlPermissions, /role\.code = 'console-operators'/);
assert.match(infrastructureOwnerPermissions, /console\.his\.read/);
assert.match(infrastructureOwnerPermissions, /console\.his\.manage/);
assert.match(infrastructureOwnerPermissions, /console\.ceph\.read/);
assert.match(infrastructureOwnerPermissions, /console\.ceph\.manage/);
assert.match(infrastructureOwnerPermissions, /role\.code = 'console-operators'/);
assert.match(recoveryOwnerPermissions, /console\.recovery\.read/);
assert.match(recoveryOwnerPermissions, /role\.code IN \('console-admins', 'console-operators'\)/);
assert.match(cephPrerequisiteConsumer, /'ceph-prerequisites'/);
assert.match(cephPrerequisiteConsumer, /opensphere\.ceph\.rook-prerequisite\/v1/);
assert.match(aiConsumerContract, /opensphere_ai_runtime/);
assert.match(aiConsumerContract, /ai-artifacts/);
assert.match(externalChannelsBackup, /opensphere_external_channel_executor/);
assert.match(externalChannelsBackup, /external_backup_secret/);
assert.match(externalChannelsBackup, /restore_configuration_snapshot/);
assert.match(externalChannelsBackup, /configuration-backup\.opensphere\.io\/v1/);
assert.match(migrationLedger, /CREATE TABLE IF NOT EXISTS console\.schema_migration/);
assert.match(migrationLedger, /sha256 text NOT NULL/);
assert.match(migrationLedger, /source_revision text NOT NULL/);
assert.match(migrationLedger, /schema_migration_append_only/);
assert.match(migrationLedger, /REVOKE ALL ON TABLE console\.schema_migration FROM PUBLIC/);

// Linux host authority: the host surface must stay read-only and secret-free.
for (const [label, sql] of [['0027 migration', linuxHostAuthority], ['rcc baseline', rccBaseline]]) {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS console\.host \(/, label);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS console\.host_snapshot \(/, label);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS console\.host_operation \(/, label);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS console\.host_operation_event \(/, label);
  assert.match(sql, /agent_key_id text NOT NULL CHECK \(agent_key_id ~/, label);
  // Agent signing material must never gain a column.
  assert.doesNotMatch(sql, /console\.host[\s\S]*?\n\s+agent_secret\b/, label);
  assert.doesNotMatch(sql, /\n\s+(agent_secret|shared_secret|hmac_secret|secret)\s+(text|bytea)/, label);
  assert.match(sql, /host_control_mode text NOT NULL DEFAULT 'read-only'/, label);
  assert.match(sql, /host_control_mode IN \('read-only', 'governed-write'\)/, label);
  assert.match(sql, /FUNCTION console\.host_operation_transition_allowed/, label);
  assert.match(sql, /host_operation_state_machine/, label);
  assert.match(sql, /ENABLE ALWAYS TRIGGER host_operation_state_machine/, label);
  assert.match(sql, /read-only host_control_mode; dispatch is refused/, label);
  assert.match(sql, /host operation identity is immutable/, label);
  // A host operation must not be able to name one control center while its host
  // belongs to another; the composite foreign key is what forbids it.
  assert.match(sql, /ADD CONSTRAINT host_id_control_center_key UNIQUE \(id, control_center_id\)/, label);
  assert.match(
    sql,
    /FOREIGN KEY \(host_uuid, control_center_id\)\s*\n\s*REFERENCES console\.host \(id, control_center_id\)/,
    label,
  );
  // A standalone host reference on host_operation would re-open the divergence.
  assert.doesNotMatch(
    sql,
    /host_uuid uuid NOT NULL REFERENCES console\.host\(id\)/,
    `${label}: host_operation must bind host and control center together, not separately`,
  );
  // Reviewed content must be frozen so approve-then-edit cannot change what runs.
  assert.match(sql, /reviewed host operation content is immutable/, label);
  assert.match(
    sql,
    /\(OLD\.status <> 'requested' OR NEW\.status <> 'requested'\)\s*\n\s*AND \(NEW\.parameters IS DISTINCT FROM OLD\.parameters/,
    label,
  );
  assert.match(sql, /console\.host_operation_event is append-only/, label);
  assert.match(sql, /ENABLE ALWAYS TRIGGER host_operation_event_append_only/, label);
  assert.match(sql, /ALTER TABLE console\.host ENABLE ROW LEVEL SECURITY/, label);
  assert.match(sql, /ALTER TABLE console\.host_snapshot ENABLE ROW LEVEL SECURITY/, label);
  assert.match(sql, /ALTER TABLE console\.host_operation ENABLE ROW LEVEL SECURITY/, label);
  assert.match(sql, /ALTER TABLE console\.host_operation_event ENABLE ROW LEVEL SECURITY/, label);
  assert.match(sql, /CREATE POLICY host_read_assigned ON console\.host FOR SELECT TO authenticated/, label);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON console\.host, console\.host_snapshot, console\.host_operation,\s*\n\s*console\.host_operation_event FROM anon, authenticated/, label);
  assert.match(sql, /REVOKE UPDATE, DELETE, TRUNCATE ON console\.host_operation_event FROM opensphere_console_backend/, label);
  assert.match(sql, /'console\.hosts\.read', 'low'/, label);
  assert.match(sql, /'console\.hosts\.operate', 'high'/, label);
  assert.match(sql, /r\.code IN \('console-operators', 'console-viewers'\)/, label);
}
// Stage 1: only administrators hold the operate permission.
assert.doesNotMatch(
  linuxHostAuthority,
  /ON p\.code = 'console\.hosts\.operate'\s*\nWHERE r\.code IN \('console-operators'/,
);

assert.match(nginx, /location \^~ \/auth\/v1\//);
assert.match(nginx, /opensphere-supabase-auth\.opensphere-console-data\.svc\.cluster\.local/);
assert.match(nginx, /location \^~ \/storage\/v1\//);
assert.match(nginx, /rewrite \^\/storage\/v1\/\(\.\*\)\$ \/\$1 break/);
assert.match(nginx, /proxy_request_buffering off/);

console.log('Supabase backbone static contract: PASS');

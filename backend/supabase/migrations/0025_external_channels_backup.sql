\set ON_ERROR_STOP on

-- External Channels expands outbound notification delivery with independently
-- privileged off-cluster configuration backup targets. Credentials and backup
-- object keys never cross into browser-readable tables.
DO $$ BEGIN
  CREATE ROLE opensphere_external_channel_executor NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT opensphere_external_channel_executor TO authenticator;

CREATE TABLE IF NOT EXISTS console.external_backup_target (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  provider text NOT NULL DEFAULT 's3' CHECK (provider = 's3'),
  vendor text NOT NULL DEFAULT 'backblaze-b2' CHECK (vendor = 'backblaze-b2'),
  endpoint text NOT NULL CHECK (endpoint ~ '^https://[A-Za-z0-9.-]+/?$'),
  region text NOT NULL CHECK (region ~ '^[a-z0-9-]{3,32}$'),
  bucket_name text NOT NULL CHECK (length(btrim(bucket_name)) BETWEEN 3 AND 63),
  bucket_id text,
  path_prefix text NOT NULL DEFAULT 'opensphere-console'
    CHECK (path_prefix ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' AND path_prefix !~ '(^|/)\.\.?(/|$)'),
  bucket_private boolean NOT NULL DEFAULT true,
  lifecycle_mode text NOT NULL DEFAULT 'keep-all-versions',
  server_side_encryption text NOT NULL DEFAULT 'unknown'
    CHECK (server_side_encryption IN ('enabled', 'disabled', 'unknown')),
  client_side_encryption text NOT NULL DEFAULT 'aes-256-gcm'
    CHECK (client_side_encryption = 'aes-256-gcm'),
  enabled boolean NOT NULL DEFAULT true,
  health_state text NOT NULL DEFAULT 'NotConfigured'
    CHECK (health_state IN ('NotConfigured', 'Ready', 'Degraded', 'Misconfigured', 'Disabled')),
  credential_configured boolean NOT NULL DEFAULT false,
  secret_version integer NOT NULL DEFAULT 0 CHECK (secret_version >= 0),
  last_test_status text CHECK (last_test_status IN ('succeeded', 'failed')),
  last_test_at timestamptz,
  last_error_code text,
  last_backup_at timestamptz,
  last_restore_at timestamptz,
  created_by uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS external_backup_target_name_live_idx
  ON console.external_backup_target(name) WHERE deleted_at IS NULL;

-- Ciphertext only. The Console Backend and browser receive no SELECT grant.
CREATE TABLE IF NOT EXISTS console.external_backup_secret (
  target_id uuid PRIMARY KEY REFERENCES console.external_backup_target(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  algorithm text NOT NULL CHECK (algorithm = 'aes-256-gcm'),
  iv text NOT NULL,
  auth_tag text NOT NULL,
  ciphertext text NOT NULL,
  plaintext_digest text NOT NULL CHECK (plaintext_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rotated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS console.configuration_backup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES console.external_backup_target(id) ON DELETE RESTRICT,
  object_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'uploading', 'ready', 'failed')),
  format_version text NOT NULL DEFAULT 'configuration-backup.opensphere.io/v1',
  encryption text NOT NULL DEFAULT 'aes-256-gcm' CHECK (encryption = 'aes-256-gcm'),
  plaintext_digest text CHECK (plaintext_digest IS NULL OR plaintext_digest ~ '^sha256:[0-9a-f]{64}$'),
  object_digest text CHECK (object_digest IS NULL OR object_digest ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  entry_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  error_code text,
  UNIQUE(target_id, object_key)
);
CREATE INDEX IF NOT EXISTS configuration_backup_target_idx
  ON console.configuration_backup(target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS console.configuration_restore (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id uuid NOT NULL REFERENCES console.configuration_backup(id) ON DELETE RESTRICT,
  requested_by uuid NOT NULL REFERENCES console.operator(user_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'previewed'
    CHECK (status IN ('previewed', 'applying', 'restored', 'failed')),
  preview_digest text NOT NULL CHECK (preview_digest ~ '^sha256:[0-9a-f]{64}$'),
  preview jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  error_code text
);
CREATE INDEX IF NOT EXISTS configuration_restore_backup_idx
  ON console.configuration_restore(backup_id, created_at DESC);

ALTER TABLE console.external_backup_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.external_backup_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.configuration_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE console.configuration_restore ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS console_backend_external_backup_target ON console.external_backup_target;
CREATE POLICY console_backend_external_backup_target ON console.external_backup_target
  FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_configuration_backup ON console.configuration_backup;
CREATE POLICY console_backend_configuration_backup ON console.configuration_backup
  FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS console_backend_configuration_restore ON console.configuration_restore;
CREATE POLICY console_backend_configuration_restore ON console.configuration_restore
  FOR ALL TO opensphere_console_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS external_executor_target ON console.external_backup_target;
CREATE POLICY external_executor_target ON console.external_backup_target
  FOR SELECT TO opensphere_external_channel_executor USING (true);
DROP POLICY IF EXISTS external_executor_target_update ON console.external_backup_target;
CREATE POLICY external_executor_target_update ON console.external_backup_target
  FOR UPDATE TO opensphere_external_channel_executor USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS external_executor_backup ON console.configuration_backup;
CREATE POLICY external_executor_backup ON console.configuration_backup
  FOR SELECT TO opensphere_external_channel_executor USING (true);
DROP POLICY IF EXISTS external_executor_backup_update ON console.configuration_backup;
CREATE POLICY external_executor_backup_update ON console.configuration_backup
  FOR UPDATE TO opensphere_external_channel_executor USING (true) WITH CHECK (true);

GRANT USAGE ON SCHEMA console TO opensphere_external_channel_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON console.external_backup_target,
  console.configuration_backup, console.configuration_restore TO opensphere_console_backend;
GRANT SELECT, UPDATE ON console.external_backup_target,
  console.configuration_backup TO opensphere_external_channel_executor;

CREATE OR REPLACE FUNCTION console.external_backup_store_secret(
  p_target_id uuid, p_version integer, p_iv text, p_auth_tag text,
  p_ciphertext text, p_plaintext_digest text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, console AS $$
BEGIN
  IF p_version < 1 OR p_plaintext_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid external backup secret payload';
  END IF;
  INSERT INTO console.external_backup_secret(
    target_id, version, algorithm, iv, auth_tag, ciphertext, plaintext_digest
  ) VALUES (
    p_target_id, p_version, 'aes-256-gcm', p_iv, p_auth_tag, p_ciphertext, p_plaintext_digest
  )
  ON CONFLICT (target_id) DO UPDATE SET
    version = EXCLUDED.version, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
    ciphertext = EXCLUDED.ciphertext, plaintext_digest = EXCLUDED.plaintext_digest,
    rotated_at = clock_timestamp(), revoked_at = NULL;
END;
$$;

CREATE OR REPLACE FUNCTION console.external_backup_read_secret(p_target_id uuid)
RETURNS TABLE(version integer, algorithm text, iv text, auth_tag text, ciphertext text, plaintext_digest text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, console AS $$
  SELECT version, algorithm, iv, auth_tag, ciphertext, plaintext_digest
  FROM console.external_backup_secret
  WHERE target_id = p_target_id AND revoked_at IS NULL;
$$;

REVOKE ALL ON FUNCTION console.external_backup_store_secret(uuid, integer, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console.external_backup_read_secret(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console.external_backup_store_secret(uuid, integer, text, text, text, text)
  TO opensphere_external_channel_executor;
GRANT EXECUTE ON FUNCTION console.external_backup_read_secret(uuid)
  TO opensphere_external_channel_executor;

-- Transactional, allowlisted merge restore. Secrets, people, sessions, audit,
-- delivery history and desired-state Git documents are intentionally excluded.
CREATE OR REPLACE FUNCTION console.restore_configuration_snapshot(
  p_snapshot jsonb, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, console
AS $$
DECLARE
  item jsonb;
  restored jsonb := '{}'::jsonb;
  restored_count integer;
  role_row record;
  permission_row record;
BEGIN
  IF p_snapshot->>'apiVersion' <> 'configuration-backup.opensphere.io/v1' THEN
    RAISE EXCEPTION 'unsupported configuration backup format';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM console.operator WHERE user_id = p_actor AND status = 'active'
  ) THEN RAISE EXCEPTION 'active restore actor is required'; END IF;

  restored_count := 0;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(p_snapshot#>'{configuration,roles}', '[]'::jsonb))
  LOOP
    INSERT INTO console.role(code, description, system_managed)
    VALUES (item->>'code', coalesce(item->>'description', ''), coalesce((item->>'systemManaged')::boolean, false))
    ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description,
      system_managed = EXCLUDED.system_managed;
    restored_count := restored_count + 1;
  END LOOP;
  restored := restored || jsonb_build_object('roles', restored_count);

  restored_count := 0;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(p_snapshot#>'{configuration,permissions}', '[]'::jsonb))
  LOOP
    INSERT INTO console.permission(code, risk_level)
    VALUES (item->>'code', item->>'riskLevel')
    ON CONFLICT (code) DO UPDATE SET risk_level = EXCLUDED.risk_level;
    restored_count := restored_count + 1;
  END LOOP;
  restored := restored || jsonb_build_object('permissions', restored_count);

  restored_count := 0;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(p_snapshot#>'{configuration,rolePermissions}', '[]'::jsonb))
  LOOP
    SELECT id INTO role_row FROM console.role WHERE code = item->>'roleCode';
    SELECT id INTO permission_row FROM console.permission WHERE code = item->>'permissionCode';
    IF role_row.id IS NOT NULL AND permission_row.id IS NOT NULL THEN
      INSERT INTO console.role_permission(role_id, permission_id)
      VALUES (role_row.id, permission_row.id) ON CONFLICT DO NOTHING;
      restored_count := restored_count + 1;
    END IF;
  END LOOP;
  restored := restored || jsonb_build_object('rolePermissions', restored_count);

  restored_count := 0;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(p_snapshot#>'{configuration,pluginMeta}', '[]'::jsonb))
  LOOP
    INSERT INTO console.plugin_meta(plugin_id, record, updated_by, updated_at)
    VALUES (item->>'pluginId', coalesce(item->'record', '{}'::jsonb), p_actor, clock_timestamp())
    ON CONFLICT (plugin_id) DO UPDATE SET record = EXCLUDED.record,
      updated_by = p_actor, updated_at = clock_timestamp();
    restored_count := restored_count + 1;
  END LOOP;
  restored := restored || jsonb_build_object('pluginMeta', restored_count);

  restored_count := 0;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(p_snapshot#>'{configuration,consumerContracts}', '[]'::jsonb))
  LOOP
    INSERT INTO console.consumer_contract(
      consumer_id, display_name, owner_kind, supabase_schemas, storage_buckets,
      gitea_repository, gitea_path, reconciler, observability_claim,
      desired_revision, metadata, updated_at
    ) VALUES (
      item->>'consumerId', item->>'displayName', item->>'ownerKind',
      ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'supabaseSchemas', '[]'::jsonb))),
      ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'storageBuckets', '[]'::jsonb))),
      nullif(item->>'giteaRepository', ''), nullif(item->>'giteaPath', ''),
      nullif(item->>'reconciler', ''), nullif(item->>'observabilityClaim', ''),
      nullif(item->>'desiredRevision', ''), coalesce(item->'metadata', '{}'::jsonb),
      clock_timestamp()
    )
    ON CONFLICT (consumer_id) DO UPDATE SET
      display_name = EXCLUDED.display_name, owner_kind = EXCLUDED.owner_kind,
      supabase_schemas = EXCLUDED.supabase_schemas, storage_buckets = EXCLUDED.storage_buckets,
      gitea_repository = EXCLUDED.gitea_repository, gitea_path = EXCLUDED.gitea_path,
      reconciler = EXCLUDED.reconciler, observability_claim = EXCLUDED.observability_claim,
      desired_revision = EXCLUDED.desired_revision, metadata = EXCLUDED.metadata,
      updated_at = clock_timestamp();
    restored_count := restored_count + 1;
  END LOOP;
  restored := restored || jsonb_build_object('consumerContracts', restored_count);

  restored_count := 0;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(p_snapshot#>'{configuration,observabilityClaims}', '[]'::jsonb))
  LOOP
    INSERT INTO console.observability_claim(
      consumer_id, requested_capabilities, binding_name, binding_namespace, phase,
      updated_at
    ) VALUES (
      item->>'consumerId',
      ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'requestedCapabilities', '[]'::jsonb))),
      nullif(item->>'bindingName', ''), nullif(item->>'bindingNamespace', ''),
      coalesce(nullif(item->>'phase', ''), 'NotConfigured'), clock_timestamp()
    )
    ON CONFLICT (consumer_id) DO UPDATE SET
      requested_capabilities = EXCLUDED.requested_capabilities,
      binding_name = EXCLUDED.binding_name, binding_namespace = EXCLUDED.binding_namespace,
      phase = EXCLUDED.phase, updated_at = clock_timestamp();
    restored_count := restored_count + 1;
  END LOOP;
  restored := restored || jsonb_build_object('observabilityClaims', restored_count);

  restored_count := 0;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(p_snapshot#>'{configuration,notificationChannels}', '[]'::jsonb))
  LOOP
    INSERT INTO console.notification_channel(
      id, name, provider, channel_type, enabled, health_state, config,
      credential_configured, secret_version, created_by, updated_by
    ) VALUES (
      (item->>'id')::uuid, item->>'name', item->>'provider', item->>'channelType',
      false, 'Draft', coalesce(item->'config', '{}'::jsonb), false, 0, p_actor, p_actor
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, provider = EXCLUDED.provider, channel_type = EXCLUDED.channel_type,
      config = EXCLUDED.config,
      enabled = coalesce((item->>'enabled')::boolean, false)
        AND console.notification_channel.credential_configured,
      health_state = CASE
        WHEN coalesce((item->>'enabled')::boolean, false)
          AND console.notification_channel.credential_configured THEN 'Degraded'
        ELSE 'Disabled'
      END,
      updated_by = p_actor, updated_at = clock_timestamp(), deleted_at = NULL;
    restored_count := restored_count + 1;
  END LOOP;
  restored := restored || jsonb_build_object('notificationChannels', restored_count);

  restored_count := 0;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(p_snapshot#>'{configuration,notificationRules}', '[]'::jsonb))
  LOOP
    INSERT INTO console.notification_rule(
      id, name, description, enabled, priority, version, min_severity, sources,
      categories, label_match, quiet_hours, dedup_window_seconds, throttle,
      message_policy, created_by, updated_by
    ) VALUES (
      (item->>'id')::uuid, item->>'name', coalesce(item->>'description', ''),
      coalesce((item->>'enabled')::boolean, true), coalesce((item->>'priority')::integer, 100),
      coalesce((item->>'version')::integer, 1), coalesce(item->>'minSeverity', 'error'),
      ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'sources', '[]'::jsonb))),
      ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'categories', '[]'::jsonb))),
      coalesce(item->'labelMatch', '{}'::jsonb), coalesce(item->'quietHours', '{}'::jsonb),
      coalesce((item->>'dedupWindowSeconds')::integer, 0),
      coalesce(item->'throttle', '{}'::jsonb), coalesce(item->'messagePolicy', '{}'::jsonb),
      p_actor, p_actor
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, description = EXCLUDED.description, enabled = EXCLUDED.enabled,
      priority = EXCLUDED.priority, version = EXCLUDED.version,
      min_severity = EXCLUDED.min_severity, sources = EXCLUDED.sources,
      categories = EXCLUDED.categories, label_match = EXCLUDED.label_match,
      quiet_hours = EXCLUDED.quiet_hours,
      dedup_window_seconds = EXCLUDED.dedup_window_seconds,
      throttle = EXCLUDED.throttle, message_policy = EXCLUDED.message_policy,
      updated_by = p_actor, updated_at = clock_timestamp(), deleted_at = NULL;
    restored_count := restored_count + 1;
  END LOOP;
  restored := restored || jsonb_build_object('notificationRules', restored_count);

  restored_count := 0;
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(p_snapshot#>'{configuration,notificationRuleChannels}', '[]'::jsonb))
  LOOP
    INSERT INTO console.notification_rule_channel(rule_id, channel_id)
    VALUES ((item->>'ruleId')::uuid, (item->>'channelId')::uuid)
    ON CONFLICT DO NOTHING;
    restored_count := restored_count + 1;
  END LOOP;
  restored := restored || jsonb_build_object('notificationRuleChannels', restored_count);

  IF p_snapshot#>'{configuration,notificationDeliveryControl}' IS NOT NULL THEN
    UPDATE console.notification_delivery_control
      SET paused = coalesce((p_snapshot#>>'{configuration,notificationDeliveryControl,paused}')::boolean, false),
          reason = nullif(p_snapshot#>>'{configuration,notificationDeliveryControl,reason}', ''),
          changed_by = p_actor, changed_at = clock_timestamp()
      WHERE singleton = true;
    restored := restored || jsonb_build_object('notificationDeliveryControl', 1);
  END IF;

  RETURN restored;
END;
$$;

REVOKE ALL ON FUNCTION console.restore_configuration_snapshot(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console.restore_configuration_snapshot(jsonb, uuid)
  TO opensphere_console_backend;

COMMENT ON TABLE console.external_backup_target IS
  'External Channels backup target metadata; credentials remain in external_backup_secret ciphertext.';
COMMENT ON TABLE console.configuration_backup IS
  'Encrypted off-cluster Console configuration snapshot evidence; not a full Supabase/Gitea disaster-recovery archive.';

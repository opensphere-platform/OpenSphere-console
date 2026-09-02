CREATE TABLE console_extension.presentation_preference (
  extension_id text PRIMARY KEY CHECK (
    extension_id ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  navigation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(navigation) = 'object'),
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

ALTER TABLE console_extension.presentation_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_extension.presentation_preference FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION console_extension.list_presentation_preferences()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, console_extension
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'extensionId', extension_id,
        'navigation', navigation,
        'updatedAt', updated_at
      )
      ORDER BY extension_id
    ),
    '[]'::jsonb
  )
  FROM console_extension.presentation_preference;
$$;

CREATE OR REPLACE FUNCTION console_extension.write_presentation_preferences(
  p_actor_ref uuid,
  p_correlation_id text,
  p_updates jsonb,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_extension, console_audit
AS $$
DECLARE
  v_update jsonb;
  v_navigation jsonb;
  v_extension_id text;
  v_seen text[] := ARRAY[]::text[];
  v_updated_at timestamptz := statement_timestamp();
  v_items jsonb;
BEGIN
  IF p_actor_ref IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM console_identity.subject_authority
        WHERE subject_id = p_actor_ref
      )
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]'
      OR length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 8 AND 500
      OR jsonb_typeof(p_updates) <> 'array'
      OR jsonb_array_length(p_updates) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid Extension presentation update'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;

  FOR v_update IN SELECT value FROM jsonb_array_elements(p_updates)
  LOOP
    IF jsonb_typeof(v_update) <> 'object'
        OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(v_update) AS key
          WHERE key NOT IN ('extensionId', 'navigation')
        )
        OR NOT (v_update ? 'extensionId')
        OR NOT (v_update ? 'navigation') THEN
      RAISE EXCEPTION 'invalid Extension presentation item'
        USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
    END IF;
    v_extension_id := v_update->>'extensionId';
    v_navigation := v_update->'navigation';
    IF COALESCE(v_extension_id, '') !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
        OR v_extension_id = ANY(v_seen)
        OR jsonb_typeof(v_navigation) <> 'object'
        OR v_navigation = '{}'::jsonb
        OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(v_navigation) AS key
          WHERE key NOT IN ('icon', 'labelOverride', 'order')
        )
        OR (
          v_navigation ? 'icon'
          AND (
            jsonb_typeof(v_navigation->'icon') <> 'string'
            OR (v_navigation->>'icon') !~ '^(|[a-z0-9][a-z0-9-]{0,95})$'
          )
        )
        OR (
          v_navigation ? 'labelOverride'
          AND (
            jsonb_typeof(v_navigation->'labelOverride') NOT IN ('string', 'null')
            OR length(COALESCE(v_navigation->>'labelOverride', '')) > 80
            OR COALESCE(v_navigation->>'labelOverride', '') ~ '[[:cntrl:]]'
          )
        )
        OR (
          v_navigation ? 'order'
          AND (
            jsonb_typeof(v_navigation->'order') <> 'number'
            OR (v_navigation->>'order') !~ '^[0-9]+$'
            OR (v_navigation->>'order')::integer NOT BETWEEN 0 AND 63
          )
        ) THEN
      RAISE EXCEPTION 'invalid Extension navigation preference'
        USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
    END IF;
    v_seen := array_append(v_seen, v_extension_id);
  END LOOP;

  FOR v_update IN SELECT value FROM jsonb_array_elements(p_updates)
  LOOP
    v_extension_id := v_update->>'extensionId';
    v_navigation := v_update->'navigation';
    INSERT INTO console_extension.presentation_preference(
      extension_id, navigation, updated_by, updated_at
    ) VALUES (
      v_extension_id, v_navigation, p_actor_ref, v_updated_at
    )
    ON CONFLICT (extension_id) DO UPDATE
      SET navigation = console_extension.presentation_preference.navigation || EXCLUDED.navigation,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at;
  END LOOP;

  PERFORM console_audit.append_event_internal(
    NULL,
    p_correlation_id,
    p_actor_ref::text,
    'console.extension.presentation.update',
    CASE WHEN cardinality(v_seen) = 1
      THEN 'extension:' || v_seen[1]
      ELSE 'extension-navigation'
    END,
    'succeeded',
    btrim(p_reason),
    jsonb_build_object('extensionIds', to_jsonb(v_seen), 'count', cardinality(v_seen))
  );

  SELECT console_extension.list_presentation_preferences() INTO v_items;
  RETURN jsonb_build_object(
    'items', v_items,
    'observedAt', v_updated_at,
    'authority', 'ConsoleExtensionPresentation'
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_extension.record_management_event(
  p_actor_ref uuid,
  p_correlation_id text,
  p_action text,
  p_target_ref text,
  p_outcome text,
  p_reason text,
  p_evidence jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, console_identity, console_audit
AS $$
DECLARE
  v_event console_audit.event;
BEGIN
  IF p_actor_ref IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM console_identity.subject_authority
        WHERE subject_id = p_actor_ref
      )
      OR length(COALESCE(p_correlation_id, '')) NOT BETWEEN 8 AND 128
      OR p_correlation_id ~ '[\r\n]'
      OR p_action NOT IN (
        'console.extension.enable',
        'console.extension.disable',
        'console.extension.uninstall',
        'console.extension.rollback',
        'console.extension.binding.enable',
        'console.extension.binding.disable'
      )
      OR COALESCE(p_target_ref, '') !~ '^(extension|binding):[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
      OR p_outcome NOT IN ('accepted', 'succeeded', 'failed', 'unknown')
      OR length(COALESCE(p_reason, '')) > 500
      OR p_reason ~ '[[:cntrl:]]'
      OR jsonb_typeof(COALESCE(p_evidence, '{}'::jsonb)) <> 'object'
      OR octet_length(COALESCE(p_evidence, '{}'::jsonb)::text) > 8192 THEN
    RAISE EXCEPTION 'invalid Extension management event'
      USING ERRCODE = '22023', DETAIL = 'ValidationFailed';
  END IF;
  v_event := console_audit.append_event_internal(
    NULL,
    p_correlation_id,
    p_actor_ref::text,
    p_action,
    p_target_ref,
    p_outcome,
    COALESCE(p_reason, ''),
    COALESCE(p_evidence, '{}'::jsonb)
  );
  RETURN jsonb_build_object(
    'eventId', v_event.event_id,
    'sequenceId', v_event.sequence_id,
    'eventHash', v_event.event_hash,
    'occurredAt', v_event.occurred_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION console_extension.list_management_events(
  p_limit integer
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, console_audit
AS $$
  SELECT CASE
    WHEN p_limit NOT BETWEEN 1 AND 200 THEN
      jsonb_build_object('error', 'ValidationFailed')
    ELSE jsonb_build_object(
      'items',
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'time', occurred_at,
            'actor', actor_ref,
            'actorId', CASE
              WHEN actor_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              THEN actor_ref
              ELSE NULL
            END,
            'action', action,
            'target', target_ref,
            'result', outcome,
            'reason', reason,
            'opId', COALESCE(operation_id::text, event_id::text),
            'source', 'C_EXT'
          )
          ORDER BY sequence_id DESC
        )
        FROM (
          SELECT * FROM console_audit.event
          WHERE action LIKE 'console.extension.%'
          ORDER BY sequence_id DESC
          LIMIT p_limit
        ) AS recent
      ), '[]'::jsonb),
      'observedAt', statement_timestamp(),
      'authority', 'ConsoleAuditLedger'
    )
  END;
$$;

REVOKE ALL ON TABLE console_extension.presentation_preference FROM PUBLIC;
REVOKE ALL ON FUNCTION console_extension.list_presentation_preferences() FROM PUBLIC;
REVOKE ALL ON FUNCTION console_extension.write_presentation_preferences(uuid, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_extension.record_management_event(uuid, text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_extension.list_management_events(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION console_extension.list_presentation_preferences()
  TO console_extension_controller;
GRANT EXECUTE ON FUNCTION console_extension.write_presentation_preferences(uuid, text, jsonb, text)
  TO console_extension_controller;
GRANT EXECUTE ON FUNCTION console_extension.record_management_event(uuid, text, text, text, text, text, jsonb)
  TO console_extension_controller;
GRANT EXECUTE ON FUNCTION console_extension.list_management_events(integer)
  TO console_extension_controller;

COMMENT ON TABLE console_extension.presentation_preference
  IS 'Target C_EXT-owned operator presentation overrides; signed Package defaults remain immutable.';
COMMENT ON FUNCTION console_extension.write_presentation_preferences(uuid, text, jsonb, text)
  IS 'Validates and atomically stores a bounded navigation preference set with target audit evidence.';
COMMENT ON FUNCTION console_extension.record_management_event(uuid, text, text, text, text, text, jsonb)
  IS 'C_EXT-only append boundary for the closed Extension management action vocabulary.';
COMMENT ON FUNCTION console_extension.list_management_events(integer)
  IS 'C_EXT-only bounded projection of Extension events from the target append-only audit ledger.';

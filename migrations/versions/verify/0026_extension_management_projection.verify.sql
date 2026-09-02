\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('console_extension.presentation_preference') IS NULL
      OR to_regprocedure('console_extension.list_presentation_preferences()') IS NULL
      OR to_regprocedure('console_extension.write_presentation_preferences(uuid,text,jsonb,text)') IS NULL
      OR to_regprocedure('console_extension.record_management_event(uuid,text,text,text,text,text,jsonb)') IS NULL
      OR to_regprocedure('console_extension.list_management_events(integer)') IS NULL THEN
    RAISE EXCEPTION 'Extension management projection authority is missing';
  END IF;
  IF has_table_privilege('console_extension_controller', 'console_extension.presentation_preference', 'SELECT')
      OR has_table_privilege('console_extension_controller', 'console_extension.presentation_preference', 'INSERT')
      OR has_function_privilege('public', 'console_extension.list_presentation_preferences()', 'EXECUTE')
      OR has_function_privilege('public', 'console_extension.write_presentation_preferences(uuid,text,jsonb,text)', 'EXECUTE')
      OR has_function_privilege('public', 'console_extension.record_management_event(uuid,text,text,text,text,text,jsonb)', 'EXECUTE')
      OR has_function_privilege('public', 'console_extension.list_management_events(integer)', 'EXECUTE')
      OR NOT has_function_privilege('console_extension_controller', 'console_extension.list_presentation_preferences()', 'EXECUTE')
      OR NOT has_function_privilege('console_extension_controller', 'console_extension.write_presentation_preferences(uuid,text,jsonb,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_extension_controller', 'console_extension.record_management_event(uuid,text,text,text,text,text,jsonb)', 'EXECUTE')
      OR NOT has_function_privilege('console_extension_controller', 'console_extension.list_management_events(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Extension management role boundary is invalid';
  END IF;
END;
$$;

DO $$
DECLARE
  v_subject uuid := '70260000-0000-4000-8000-000000000001';
  v_preferences jsonb;
  v_event jsonb;
  v_events jsonb;
  v_failed boolean := false;
BEGIN
  INSERT INTO auth.users(id) VALUES (v_subject) ON CONFLICT DO NOTHING;
  INSERT INTO console_identity.subject_authority(subject_id, person_ref, permission_revision, revoke_epoch)
  VALUES (v_subject, '70260000-0000-4000-8000-000000000002', 1, 0)
  ON CONFLICT (subject_id) DO NOTHING;

  SET LOCAL ROLE console_extension_controller;
  v_preferences := console_extension.write_presentation_preferences(
    v_subject,
    'extension-management-correlation-0001',
    '[{"extensionId":"metrics","navigation":{"icon":"dashboard","labelOverride":"Live metrics","order":0}}]'::jsonb,
    'configure verified extension navigation'
  );
  IF v_preferences->>'authority' <> 'ConsoleExtensionPresentation'
      OR jsonb_array_length(v_preferences->'items') <> 1
      OR v_preferences#>>'{items,0,extensionId}' <> 'metrics'
      OR v_preferences#>>'{items,0,navigation,icon}' <> 'dashboard' THEN
    RAISE EXCEPTION 'Extension presentation projection is invalid: %', v_preferences;
  END IF;

  v_event := console_extension.record_management_event(
    v_subject,
    'extension-management-correlation-0002',
    'console.extension.enable',
    'extension:metrics',
    'succeeded',
    'activate verified extension',
    '{"resourceVersionBefore":"10","resourceVersion":"11"}'::jsonb
  );
  IF COALESCE(v_event->>'eventHash', '') !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Extension management audit receipt is invalid: %', v_event;
  END IF;
  v_events := console_extension.list_management_events(100);
  IF v_events->>'authority' <> 'ConsoleAuditLedger'
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_events->'items') AS item
        WHERE item->>'action' = 'console.extension.enable'
          AND item->>'target' = 'extension:metrics'
          AND item->>'result' = 'succeeded'
      ) THEN
    RAISE EXCEPTION 'Extension management event projection is invalid: %', v_events;
  END IF;

  BEGIN
    PERFORM console_extension.write_presentation_preferences(
      v_subject,
      'extension-management-correlation-0003',
      '[{"extensionId":"metrics","navigation":{"icon":"../../secret"}}]'::jsonb,
      'invalid navigation must be rejected'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM NOT LIKE '%invalid Extension navigation preference%' THEN RAISE; END IF;
    v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'unsafe Extension navigation preference was accepted'; END IF;
END;
$$;

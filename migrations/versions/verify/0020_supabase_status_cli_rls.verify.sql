\set ON_ERROR_STOP on

DO $$
DECLARE
  v_status jsonb;
BEGIN
  IF to_regprocedure('console_identity.get_supabase_status(uuid,uuid,bigint,bigint,text)') IS NULL
      OR NOT has_function_privilege('console_api', 'console_identity.get_supabase_status(uuid,uuid,bigint,bigint,text)', 'EXECUTE')
      OR has_function_privilege('public', 'console_identity.get_supabase_status(uuid,uuid,bigint,bigint,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Supabase status authority function grant is invalid';
  END IF;
  v_status := console_identity.get_supabase_status(
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    7, 2, 'verify-cli-rls-status-0020'
  );
  IF v_status->'data'->'components'->5->>'state' <> 'Ready'
      OR v_status->'data'->'components'->5->>'authorityTables' <> '16'
      OR v_status->'data'->'components'->5->>'protectedTables' <> '16' THEN
    RAISE EXCEPTION 'CLI identity RLS tables are not reported ready: %', v_status->'data'->'components'->5;
  END IF;
END;
$$;
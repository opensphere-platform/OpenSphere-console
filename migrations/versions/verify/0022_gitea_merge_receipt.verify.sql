\set ON_ERROR_STOP on

DO $$
DECLARE
  v_function text;
BEGIN
  IF to_regprocedure('console_operation.record_gitea_merge(uuid,text,text,integer,text)') IS NULL
      OR to_regprocedure('console_operation.get_gitea_operation_for_approval(uuid,uuid,bigint,bigint,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Gitea merge receipt function is missing';
  END IF;
  IF has_function_privilege('public', 'console_operation.record_gitea_merge(uuid,text,text,integer,text)', 'EXECUTE')
      OR has_function_privilege('public', 'console_operation.get_gitea_operation_for_approval(uuid,uuid,bigint,bigint,uuid)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_operation.record_gitea_merge(uuid,text,text,integer,text)', 'EXECUTE')
      OR NOT has_function_privilege('console_api', 'console_operation.get_gitea_operation_for_approval(uuid,uuid,bigint,bigint,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Gitea merge receipt grant boundary is invalid';
  END IF;
  v_function := pg_get_functiondef(
    'console_operation.record_gitea_merge(uuid,text,text,integer,text)'::regprocedure
  );
  IF position('FOR UPDATE' IN v_function) = 0
      OR position('console.platform.change.propose' IN v_function) = 0
      OR position('API_GIT' IN v_function) = 0
      OR position('state = ''Submitted''' IN v_function) = 0
      OR position('source_revision = p_source_revision' IN v_function) = 0 THEN
    RAISE EXCEPTION 'Gitea merge receipt does not bind operation, revision and state atomically';
  END IF;
END;
$$;

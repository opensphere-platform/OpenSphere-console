DO $$
DECLARE actor uuid:='10000000-0000-4000-8000-000000000044'; s uuid; req uuid; r jsonb; cmd text;
BEGIN
 SELECT session_id INTO STRICT s FROM console_identity.browser_session WHERE subject_id=actor;
 IF NOT EXISTS (SELECT 1 FROM console_shell.command_request WHERE actor_id=actor AND command='hiss.install'
  AND phase='Recorded' AND result='{"status":"Accepted","historical":true}'::jsonb) THEN RAISE EXCEPTION 'historical receipt lost'; END IF;
 IF has_table_privilege('opensphere_shell_api','console_shell.command_request','INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'raw ledger write granted'; END IF;
 IF NOT has_function_privilege('opensphere_shell_api','console_shell.claim_command(uuid,uuid,uuid,text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'closed RPC lost'; END IF;
 FOREACH cmd IN ARRAY ARRAY['console.modules.install','cluster-manager.hiss.install','platform-support.argocd.sync'] LOOP
  req:=gen_random_uuid();
  r:=console_shell.claim_command(actor,s,req,cmd,'sha256:'||repeat('b',64),'aal1');
  IF r->>'claimed'<>'true' THEN RAISE EXCEPTION 'owner claim failed'; END IF;
  r:=console_shell.claim_command(actor,s,req,cmd,'sha256:'||repeat('b',64),'aal1');
  IF r->>'claimed'<>'false' OR r->>'phase'<>'Dispatching' THEN RAISE EXCEPTION 'uncertain execution would redispatch'; END IF;
  r:=console_shell.claim_command(actor,s,req,cmd,'sha256:'||repeat('c',64),'aal1');
  IF r->>'conflict'<>'true' THEN RAISE EXCEPTION 'conflicting retry accepted'; END IF;
  PERFORM console_shell.finish_command(actor,req,'sha256:'||repeat('b',64),'{"status":"Accepted","operationId":"test"}');
  r:=console_shell.claim_command(actor,s,req,cmd,'sha256:'||repeat('b',64),'aal1');
  IF r->>'claimed'<>'false' OR r->'result'->>'status'<>'Accepted' THEN RAISE EXCEPTION 'receipt replay failed'; END IF;
 END LOOP;
 FOREACH cmd IN ARRAY ARRAY['x','x..y','x;drop.table',repeat('a',128)||'.b'] LOOP
  BEGIN
   PERFORM console_shell.claim_command(actor,s,gen_random_uuid(),cmd,'sha256:'||repeat('d',64),'aal1');
   RAISE EXCEPTION 'invalid syntax accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
 END LOOP;
 BEGIN
  PERFORM console_shell.claim_command(actor,s,gen_random_uuid(),'console.modules.install','sha256:'||repeat('b',64),'aal2');
  RAISE EXCEPTION 'fabricated AAL2 accepted';
 EXCEPTION WHEN invalid_authorization_specification THEN NULL; END;
 DELETE FROM console_operation.module_installation_environment;
 BEGIN
  PERFORM console_shell.claim_command(actor,s,gen_random_uuid(),'console.modules.install','sha256:'||repeat('b',64),'aal1');
  RAISE EXCEPTION 'production AAL1 admitted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 INSERT INTO console_operation.module_installation_environment(singleton,channel,auth_environment,kube_context,console_origin)
  VALUES(true,'edge','development','docker-desktop','https://localhost:1114');
 UPDATE console_identity.subject_authority SET permission_revision=2 WHERE subject_id=actor;
 BEGIN
  PERFORM console_shell.claim_command(actor,s,gen_random_uuid(),'console.modules.install','sha256:'||repeat('b',64),'aal1');
  RAISE EXCEPTION 'stale session accepted';
 EXCEPTION WHEN invalid_authorization_specification THEN NULL; END;
END $$;

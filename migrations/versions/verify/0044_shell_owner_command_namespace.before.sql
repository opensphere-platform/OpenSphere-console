INSERT INTO auth.users(id) VALUES ('10000000-0000-4000-8000-000000000044');
-- Test setup owns this disposable database, like the real verified installer.
UPDATE console_shell.shell_control_state SET enabled=true WHERE singleton;
INSERT INTO console_identity.subject_authority(subject_id,person_ref,permission_revision,revoke_epoch)
 VALUES('10000000-0000-4000-8000-000000000044',gen_random_uuid(),1,0);
INSERT INTO console_identity.permission_grant(subject_id,permission,grant_revision,granted_by)
 VALUES('10000000-0000-4000-8000-000000000044','console.role.admin',1,'10000000-0000-4000-8000-000000000044');
SELECT console_identity.issue_browser_session('10000000-0000-4000-8000-000000000044',sha256('shell-ledger-test-handle'::bytea),sha256('shell-ledger-test-csrf'::bytea),
 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA','v1.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB',
 'shell-ledger-test-auth','aal1',now()+interval '1 hour',now()+interval '1 day','24h',false,'shell-ledger-session');
INSERT INTO console_operation.module_installation_environment(singleton,channel,auth_environment,kube_context,console_origin)
 VALUES(true,'edge','development','docker-desktop','https://localhost:1114');
DO $$
DECLARE actor uuid:='10000000-0000-4000-8000-000000000044'; s uuid; r jsonb;
BEGIN
 SELECT session_id INTO STRICT s FROM console_identity.browser_session WHERE subject_id=actor;
 r:=console_shell.claim_command(actor,s,'20000000-0000-4000-8000-000000000044','hiss.install','sha256:'||repeat('a',64),'aal1');
 IF r->>'claimed'<>'true' THEN RAISE EXCEPTION 'historical claim failed'; END IF;
 PERFORM console_shell.finish_command(actor,'20000000-0000-4000-8000-000000000044','sha256:'||repeat('a',64),'{"status":"Accepted","historical":true}');
 BEGIN
  PERFORM console_shell.claim_command(actor,s,gen_random_uuid(),'cluster-manager.hiss.install','sha256:'||repeat('b',64),'aal1');
  RAISE EXCEPTION 'old namespace defect was not reproduced';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

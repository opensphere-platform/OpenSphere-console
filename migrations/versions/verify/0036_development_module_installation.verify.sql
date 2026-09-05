DO $$
DECLARE
 actor uuid := '10000000-0000-4000-8000-000000000361';
 approver uuid := '10000000-0000-4000-8000-000000000362';
 actor_session uuid;
 approver_session uuid;
 image text := 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:' || repeat('a',64);
 operation jsonb;
 approved jsonb;
BEGIN
 IF has_table_privilege('console_api','console_operation.module_installation_environment','INSERT,UPDATE,DELETE') THEN
   RAISE EXCEPTION 'runtime can enable its own development exception';
 END IF;
 INSERT INTO auth.users(id) VALUES(actor),(approver);
 INSERT INTO console_identity.subject_authority(subject_id,person_ref,permission_revision,revoke_epoch)
   VALUES(actor,gen_random_uuid(),1,0),(approver,gen_random_uuid(),1,0);
 INSERT INTO console_identity.permission_grant(subject_id,permission,grant_revision,granted_by)
   VALUES(actor,'console.extension.install',1,actor),(actor,'console.operation.approve',1,actor),(approver,'console.operation.approve',1,approver);
 actor_session := (console_identity.issue_browser_session(actor,sha256('module-test-actor'::bytea),sha256('module-test-csrf1'::bytea),
   'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA','v1.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB',
   'module-test-auth-actor','aal1',now()+interval '1 hour',now()+interval '1 day','24h',false,'module-actor-session')->>'sessionId')::uuid;
 approver_session := (console_identity.issue_browser_session(approver,sha256('module-test-approver'::bytea),sha256('module-test-csrf2'::bytea),
   'v1.CCCCCCCCCCCCCCCC.CCCCCCCCCCCCCCCCCCCCCC.CCCCCCCCCCCCCCCCCCCCCC','v1.DDDDDDDDDDDDDDDD.DDDDDDDDDDDDDDDDDDDDDD.DDDDDDDDDDDDDDDDDDDDDD',
   'module-test-auth-approver','aal1',now()+interval '1 hour',now()+interval '1 day','24h',false,'module-approver-session')->>'sessionId')::uuid;
 BEGIN
   PERFORM * FROM console_operation.accept_development_module_install(actor_session,actor,1,0,'console.extension.install','console.extension.install','1.0',image,'sha256:'||repeat('b',64),'R2','test local module install','module-policy',true,'module-test-accept','module-test-correlation',NULL,'C_EXT');
   RAISE EXCEPTION 'exception enabled without installation environment';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 INSERT INTO console_operation.module_installation_environment(singleton,channel,auth_environment,kube_context,console_origin)
   VALUES(true,'edge','development','docker-desktop','https://localhost:1114');
 BEGIN
   UPDATE console_operation.module_installation_environment SET console_origin='https://production.example';
   RAISE EXCEPTION 'production environment admitted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   PERFORM * FROM console_operation.accept_operation(actor_session,actor,1,0,'console.extension.install','console.extension.install','1.0',image,'sha256:'||repeat('b',64),'R2','strict path test','module-policy',true,'module-test-strict','module-test-correlation',NULL,'C_EXT');
   RAISE EXCEPTION 'strict RPC lost AAL2 requirement';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
   PERFORM * FROM console_operation.accept_development_module_install(actor_session,actor,1,0,'console.extension.install','console.extension.install','1.0',replace(image,'cluster-manager','other'),'sha256:'||repeat('b',64),'R2','wrong module test','module-policy',true,'module-test-other','module-test-correlation',NULL,'C_EXT');
   RAISE EXCEPTION 'another module admitted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 SELECT operation_record INTO operation FROM console_operation.accept_development_module_install(actor_session,actor,1,0,'console.extension.install','console.extension.install','1.0',image,'sha256:'||repeat('b',64),'R2','test local module install','module-policy',true,'module-test-accept','module-test-correlation',NULL,'C_EXT');
 IF operation->>'aal' <> 'aal1' OR operation->>'state' <> 'Planned' OR NOT (operation->>'approval_required')::boolean THEN RAISE EXCEPTION 'assurance or approval truth lost'; END IF;
 BEGIN
   PERFORM * FROM console_operation.approve_development_module_install(actor_session,actor,1,0,(operation->>'operation_id')::uuid,0,'self approval test','module-policy',NULL,'module-self-approval','module-test-correlation');
   RAISE EXCEPTION 'initiator approved own operation';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 UPDATE console_identity.subject_authority SET person_ref=(SELECT person_ref FROM console_identity.subject_authority WHERE subject_id=actor) WHERE subject_id=approver;
 BEGIN
   PERFORM * FROM console_operation.approve_development_module_install(approver_session,approver,1,0,(operation->>'operation_id')::uuid,0,'same person test','module-policy',NULL,'module-person-approval','module-test-correlation');
   RAISE EXCEPTION 'same person approved through second account';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 UPDATE console_identity.subject_authority SET person_ref=gen_random_uuid() WHERE subject_id=approver;
 SELECT operation_record INTO approved FROM console_operation.approve_development_module_install(approver_session,approver,1,0,(operation->>'operation_id')::uuid,0,'independent approval test','module-policy',NULL,'module-approved-test','module-test-correlation');
 IF approved->>'state' <> 'Authorized' OR approved->>'aal' <> 'aal1' THEN RAISE EXCEPTION 'independent approval failed'; END IF;
 IF EXISTS(SELECT 1 FROM console_identity.browser_session WHERE session_id IN(actor_session,approver_session) AND aal <> 'aal1') THEN RAISE EXCEPTION 'session assurance was falsified'; END IF;
END;
$$;

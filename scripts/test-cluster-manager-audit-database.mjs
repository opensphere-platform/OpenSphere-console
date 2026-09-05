import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {migrationTransactionSql} from './console-migrations.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const docker=process.env.OPHERE_TEST_DOCKER || 'docker';
const container='opensphere-cluster-audit-test-'+process.pid+'-'+Date.now();
let created=false;
process.on('exit',()=>{
 if(!created)return;
 const metadata=JSON.parse(execFileSync(docker,['inspect',container],{encoding:'utf8'}))[0];
 assert.equal(metadata.HostConfig.NetworkMode,'none');
 assert.equal(metadata.Config.Labels['opensphere.task'],'cluster-manager-audit-20260906');
 execFileSync(docker,['rm','-f','-v',container],{stdio:'pipe'});
});
execFileSync(docker,['run','-d','--name',container,'--label','opensphere.task=cluster-manager-audit-20260906','--network','none','--tmpfs','/var/lib/postgresql/data:rw','--tmpfs','/work:rw,mode=1777','-e','POSTGRES_HOST_AUTH_METHOD=trust','pgvector/pgvector:0.8.2-pg17','-c','unix_socket_directories=/var/run/postgresql,/work'],{stdio:'pipe'});
created=true;
for(let attempt=0;attempt<40;attempt++){
 try{execFileSync(docker,['exec',container,'pg_isready','-h','/work','-U','postgres'],{stdio:'pipe'});break;}
 catch{if(attempt===39)throw new Error('isolated database did not start');await new Promise(r=>setTimeout(r,250));}
}
const database='flow_test_'+Date.now();
function sql(text,db=database){try{return execFileSync(docker,['exec','-i',container,'psql','-X','-h','/work','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-Atq'],{input:text,encoding:'utf8',maxBuffer:8e6,stdio:['pipe','pipe','pipe']}).trim();}catch(e){throw new Error(e.stderr||e.message);}}
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
if(process.argv[2]!=='reuse') {
 sql('CREATE DATABASE '+database+';','postgres');
 sql("DO $$DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['authenticated','authenticator','supabase_auth_admin','supabase_storage_admin','supabase_admin','anon','service_role'] LOOP IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=n) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',n);END IF;END LOOP;END$$;"+readFileSync(root+'migrations/baseline/verify/supabase-test-prerequisites.sql','utf8').replace('CREATE ROLE authenticated NOLOGIN;','')+'CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;');
 const manifest=JSON.parse(readFileSync(root+'migrations/manifest.json','utf8'));
 for(const entry of manifest.migrations)sql('BEGIN;'+migrationTransactionSql(root,entry)+'COMMIT;');
 if(manifest.migrationCount===38)sql(readFileSync(root+'migrations/versions/0039_gitea_module_dispatch.sql','utf8'));
 sql(readFileSync(root+'migrations/baseline/verify/0001_console_authority.verify.sql','utf8').split('SET ROLE console_api;')[0]);
 sql("INSERT INTO console_identity.permission_grant(subject_id,permission,grant_revision,granted_by) VALUES('11111111-1111-4111-8111-111111111111','console.git.change',7,'11111111-1111-4111-8111-111111111111');");
}


if(JSON.parse(readFileSync(root+'migrations/manifest.json','utf8')).migrationCount===40) sql(readFileSync(root+'migrations/versions/0041_cluster_manager_owner_audit.sql','utf8'));
const actor='11111111-1111-4111-8111-111111111111',aal1='44444444-4444-4444-8444-444444444444',aal2='22222222-2222-4222-8222-222222222222';
sql(`INSERT INTO console_identity.permission_grant(subject_id,permission,grant_revision,granted_by) VALUES('${actor}','console.role.admin',7,'${actor}') ON CONFLICT DO NOTHING;`);
const call=(session=aal1,revision=7)=>`SET ROLE console_api; SELECT console_audit.append_cluster_manager_event('${session}','${actor}',${revision},2,'HISInstallRequested','HISS/metrics-server','accepted','Original Cluster Manager audit contract validation','cluster-restore-test','sha256:${'a'.repeat(64)}');`;
let checks=0;
function rejects(name,text,pattern){assert.throws(()=>sql('BEGIN;'+text+'ROLLBACK;'),pattern,name);checks++;console.log('PASS '+name);}
rejects('AAL1 blocked without local policy',call(),/MFA required/);
const strict=JSON.parse(sql(call(aal2)));assert.ok(strict.eventId&&strict.eventHash);checks++;
sql("INSERT INTO console_operation.module_installation_environment VALUES(true,'edge','development','docker-desktop','https://localhost:1114',now());");
const local=JSON.parse(sql(call()));assert.ok(local.eventId);checks++;
assert.equal(sql(`SELECT evidence->>'aal' FROM console_audit.event WHERE event_id='${local.eventId}';`),'aal1');checks++;
rejects('stale permission revision',call(aal1,8),/Stale Console authority/);
rejects('revoked live session',`UPDATE console_identity.browser_session SET revoked_at=now() WHERE session_id='${aal1}';`+call(),/Active Console session/);
rejects('no admin permission',`UPDATE console_identity.permission_grant SET revoked_at=now() WHERE subject_id='${actor}' AND permission='console.role.admin';`+call(),/administrator required/);
rejects('invalid target',call().replace('HISS/metrics-server','Secret/credentials'),/Invalid Cluster Manager/);
rejects('API cannot change policy','SET ROLE console_api; DELETE FROM console_operation.module_installation_environment;',/permission denied/);
assert.equal(sql("SELECT has_function_privilege('authenticated','console_audit.append_cluster_manager_event(uuid,uuid,bigint,bigint,text,text,text,text,text,text)','EXECUTE');"),'f');checks++;
console.log(JSON.stringify({status:'passed',checks,isolated:true,network:'none',actualAalPreserved:true}));

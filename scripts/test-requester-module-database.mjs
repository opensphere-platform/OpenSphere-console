import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {migrationTransactionSql} from './console-migrations.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const docker=process.env.OPHERE_TEST_DOCKER || 'docker';
const container='opensphere-requester-test-'+process.pid+'-'+Date.now();
let created=false;
process.on('exit',()=>{
 if(!created)return;
 const metadata=JSON.parse(execFileSync(docker,['inspect',container],{encoding:'utf8'}))[0];
 assert.equal(metadata.HostConfig.NetworkMode,'none');
 assert.equal(metadata.Config.Labels['opensphere.task'],'requester-install-20260905');
 execFileSync(docker,['rm','-f','-v',container],{stdio:'pipe'});
});
execFileSync(docker,['run','-d','--name',container,'--label','opensphere.task=requester-install-20260905','--network','none','--tmpfs','/var/lib/postgresql/data:rw','--tmpfs','/work:rw,mode=1777','-e','POSTGRES_HOST_AUTH_METHOD=trust','pgvector/pgvector:0.8.2-pg17','-c','unix_socket_directories=/var/run/postgresql,/work'],{stdio:'pipe'});
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

if (JSON.parse(readFileSync(root+'migrations/manifest.json','utf8')).migrationCount === 39) sql(readFileSync(root+'migrations/versions/0040_requester_confirmed_module_install.sql','utf8'));
const actor='11111111-1111-4111-8111-111111111111',aal1='44444444-4444-4444-8444-444444444444',aal2='22222222-2222-4222-8222-222222222222';
const image='ghcr.io/opensphere-platform/opensphere-shell-cluster-manager@sha256:'+'a'.repeat(64);
const plan={schemaVersion:'1.0',authority:'OpenSphereRegistry',descriptorId:'extension.cluster-manager',catalogRevision:'sha256:'+'b'.repeat(64),image};
const payload='sha256:'+'c'.repeat(64);
function accept({session=aal1,local=true,target=image,key='requester-install-test',revision=7,approval=false}={}) {
 return `SET ROLE console_api; SELECT operation_record FROM console_operation.${local?'accept_development_module_install':'accept_operation'}(${q(session)},${q(actor)},${revision},2,'console.extension.install','console.extension.install','1.0',${q(target)},${q(payload)},'R2','Console Drawer installation confirmation','requester-install-policy',${approval},${q(key)},'requester-install-correlation',NULL,'C_EXT',NULL,${q(JSON.stringify(plan))}::jsonb);`;
}
let checks=0;
function rejects(name,text,pattern){assert.throws(()=>sql('BEGIN;'+text+'ROLLBACK;'),pattern,name);checks++;console.log('PASS '+name);}
rejects('AAL1 cannot install without localhost edge marker',accept(),/StepUpRequired/);
rejects('strict installation still requires MFA',accept({local:false}),/StepUpRequired/);
rejects('stale MFA is rejected',`UPDATE console_identity.browser_session SET last_reauthenticated_at=now()-interval '1 day' WHERE session_id=${q(aal2)};`+accept({session:aal2,local:false}),/StepUpRequired/);
sql("INSERT INTO console_operation.module_installation_environment VALUES(true,'edge','production','other-context','https://localhost:1114',now());");
rejects('non-local edge cannot enable DB exception',"UPDATE console_operation.module_installation_environment SET console_origin='https://remote.example';",/check constraint/);
rejects('localhost stable cannot enable DB exception',"UPDATE console_operation.module_installation_environment SET channel='stable';",/check constraint/);
rejects('API cannot write exception configuration',"SET ROLE console_api; DELETE FROM console_operation.module_installation_environment;",/permission denied/);
rejects('wrong module cannot use AAL1',accept({target:image.replace('cluster-manager','other')}),/PolicyRejected/);
rejects('stale authority fails',accept({revision:8}),/StaleAuthorityRevision/);
rejects('revoked permission fails',"UPDATE console_identity.permission_grant SET revoked_at=now() WHERE permission='console.extension.install';"+accept(),/PermissionDenied/);
const accepted=JSON.parse(sql(accept()));
assert.equal(accepted.state,'Authorized');assert.equal(accepted.aal,'aal1');assert.equal(accepted.approval_required,false);assert.equal(accepted.declaration_binding,null);checks++;
assert.equal(JSON.parse(sql(accept())).operation_id,accepted.operation_id);checks++;
rejects('idempotency prevents replacement',accept({target:image.replace('a'.repeat(64),'d'.repeat(64))}),/IdempotencyMismatch/);
assert.equal(sql(`SELECT count(*) FROM console_operation.approval WHERE operation_id=${q(accepted.operation_id)};`),'0');checks++;
const worker='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const claim=()=>JSON.parse(sql(`SET ROLE console_extension_controller; SELECT console_operation.claim_owner_operation(${q(worker)},'C_EXT',ARRAY['console.extension.install','console.extension.remove','console.extension.revocation.create'],60);`));
const picked=claim();assert.equal(picked.operationId,accepted.operation_id);assert.equal(picked.dispatchPhase,'apply');checks++;
const applied=JSON.parse(sql(`SET ROLE console_extension_controller; SELECT console_extension.apply_install_registration(${q(worker)},${picked.outboxId},${picked.claimEpoch},${q(picked.operationId)},${q(image)},${q(payload)},${q(JSON.stringify(plan))}::jsonb,'cluster-manager','registration-uid-test','18','17',2,true,${q('sha256:'+'d'.repeat(64))},${q('e'.repeat(40))},'1.0.0','test-key');`));
assert.equal(sql(`SELECT state FROM console_operation.operation WHERE operation_id=${q(picked.operationId)};`),'Applied');checks++;
const observationClaim=claim();assert.equal(observationClaim.dispatchPhase,'observe');
const observation={package:{name:'cluster-manager',resourceVersion:'17',generation:2,digest:'sha256:'+'a'.repeat(64),manifestDigest:'sha256:'+'d'.repeat(64),sourceRevision:'e'.repeat(40),compatibilityVersion:'1.0.0',keyId:'test-key'},registration:{name:'cluster-manager',uid:'registration-uid-test',resourceVersion:'19',generation:3,observedGeneration:3,desiredState:'Enabled',phase:'Activated'},workload:{phase:'Ready'},verification:{manifest:'Verified',signature:'Verified',entryDigest:'Verified',permissions:'Approved'},serving:{phase:'Current',digest:'sha256:'+'a'.repeat(64),manifestDigest:'sha256:'+'d'.repeat(64)},revalidation:{phase:'Passed'}};
const observe=o=>`SET ROLE console_extension_controller; SELECT console_extension.record_install_observation(${q(worker)},${observationClaim.outboxId},${observationClaim.claimEpoch},${q(picked.operationId)},${q(image)},${q(payload)},${q(applied.evidenceDigest)},${q(JSON.stringify(o))}::jsonb);`;
rejects('unready workload never completes',observe({...observation,workload:{phase:'NotReady'}}),/ValidationFailed/);
rejects('different serving image never completes',observe({...observation,serving:{...observation.serving,digest:'sha256:'+'f'.repeat(64)}}),/ObservationMismatch/);
rejects('revoked image never completes',`INSERT INTO console_extension.revocation(image_ref,operation_id,payload_digest,action_version,claim_epoch) VALUES(${q(image)},${q(picked.operationId)},${q(payload)},'1.0',1);`+observe(observation),/ImageRevoked/);
const verified=JSON.parse(sql(observe(observation)));
assert.equal(verified.operationRecord.state,'Verified');assert.equal(verified.operationRecord.observed_postcondition.postcondition,'InstallReady');checks++;
assert.equal(sql(`SELECT count(*) FROM console_operation.approval WHERE operation_id=${q(picked.operationId)};`),'0');checks++;
assert.equal(sql(`SELECT count(*) FROM console_operation.execution_receipt WHERE operation_id=${q(picked.operationId)} AND phase='Verified';`),'1');checks++;
rejects('completed observation cannot replay a stale lease',observe(observation),/StaleClaim/);
const strict=JSON.parse(sql(accept({session:aal2,local:false,key:'strict-mfa-confirmed-install'})));
assert.equal(strict.state,'Authorized');assert.equal(strict.aal,'aal2');assert.equal(strict.approval_required,false);checks++;
console.log(JSON.stringify({status:'passed',checks,isolated:true,network:'none',noHumanApproval:true,actualAalPreserved:true}));

import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {migrationTransactionSql,verifyMigrationManifest} from './console-migrations.mjs';
const root=new URL('../',import.meta.url).pathname.replace(/^\/(\w:)/,'$1');
const docker='C:/Users/cmars/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const container='opensphere-data-identity-db-test';
const metadata=JSON.parse(execFileSync(docker,['inspect',container],{encoding:'utf8'}))[0];
assert.equal(metadata.HostConfig.NetworkMode,'none');
assert.equal(metadata.Config.Labels['opensphere.task'],'data-identity-20260905');
function sql(text,db='postgres'){return execFileSync(docker,['exec','-i',container,'psql','-X','-h','/work','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-Atq'],{input:text,encoding:'utf8',maxBuffer:8e6,stdio:['pipe','pipe','pipe']}).trim();}
const manifest=verifyMigrationManifest({root,manifestPath:root+'migrations/manifest.json'});
sql('DROP DATABASE IF EXISTS identity_test; CREATE DATABASE identity_test;');
// This process is restricted above to the dedicated, network-none disposable test container.
sql("DO $$DECLARE role_name text; BEGIN FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname<>'postgres' AND rolname NOT LIKE 'pg_%' LOOP EXECUTE format('DROP ROLE %I',role_name); END LOOP; END$$;");
const prereq=readFileSync(root+'migrations/baseline/verify/supabase-test-prerequisites.sql','utf8').replace('CREATE ROLE authenticated NOLOGIN;','');
sql("DO $$DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY['authenticator','supabase_auth_admin','supabase_storage_admin','supabase_admin'] LOOP IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',role_name); END IF; END LOOP; END$$;");
sql("DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END$$;"+prereq+'CREATE SCHEMA extensions;', 'identity_test');
sql('CREATE EXTENSION pgcrypto WITH SCHEMA extensions;', 'identity_test');
for(const entry of manifest.migrations){
 const file=readFileSync(root+entry.path,'utf8').replaceAll('\r\n','\n');
 assert.equal(createHash('sha256').update(file).digest('hex'),entry.sha256);
 try{sql('BEGIN;'+migrationTransactionSql(root,entry)+'COMMIT;','identity_test');}catch(e){throw new Error(entry.globalId+' '+e.stderr);}
}
const fixture=readFileSync(root+'migrations/baseline/verify/0001_console_authority.verify.sql','utf8').split('SET ROLE console_api;')[0];
sql(fixture,'identity_test');
const statusSql="SELECT console_identity.get_supabase_status('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',7,2,'identity-regression-test');";
const baseline=JSON.parse(sql('SET ROLE console_api;'+statusSql,'identity_test'));
const rls=baseline.data.components.find(c=>c.component==='rls');
assert.equal(rls.state,'Ready');assert.equal(rls.authorityTables,17);assert.equal(rls.protectedTables,16);assert.equal(rls.checks.filter(c=>c.protection==='OwnerOnly').length,1);
assert.equal(baseline.data.inventory.operators,3);assert.equal(baseline.data.inventory.activeSessions,5);
const scenarios=[
 ['missing RLS','ALTER TABLE console_identity.cli_device DISABLE ROW LEVEL SECURITY;', 'RlsCoverageIncomplete'],
 ['missing FORCE','ALTER TABLE console_identity.cli_device NO FORCE ROW LEVEL SECURITY;', 'RlsCoverageIncomplete'],
 ['unclassified table','CREATE TABLE console_operation.unclassified_test(id int);','TableUnclassified'],
 ['runtime grant','GRANT SELECT ON console_operation.module_installation_environment TO console_api;','RuntimeGrantPresent'],
 ['public grant','GRANT SELECT ON console_operation.module_installation_environment TO PUBLIC;','RuntimeGrantPresent'],
 ['missing table','ALTER TABLE console_identity.cli_device RENAME TO missing_device_test;','TableMissing'],
];
for(const [name,change,reason] of scenarios){
 const value=JSON.parse(sql('BEGIN;'+change+'SET ROLE console_api;'+statusSql+'ROLLBACK;','identity_test'));
 const c=value.data.components.find(c=>c.component==='rls');assert.equal(c.state,'Blocked',name);assert.ok(c.checks.some(x=>x.reasonCode===reason),name);console.log('PASS '+name);
}
for(const [name,change] of [ ['revoked session',"UPDATE console_identity.browser_session SET revoked_at=now();"], ['revoked authority',"UPDATE console_identity.subject_authority SET revoke_epoch=revoke_epoch+1;"], ['missing permission',"UPDATE console_identity.permission_grant SET revoked_at=now() WHERE permission='console.data_identity.read';"] ]){
 try {sql('BEGIN;'+change+'SET ROLE console_api;'+statusSql,'identity_test');throw new Error('authorization accepted '+name);}catch(e){assert.match(String(e.stderr),/SessionInvalid|StaleAuthorityRevision|PermissionDenied/,name);}console.log('PASS '+name);
}
if(process.argv.includes('--update-fixture'))writeFileSync(root+'apps/console-api/test/fixtures/data-identity-sql.json',JSON.stringify(baseline,null,2)+'\n');
console.log(JSON.stringify({status:'passed',migrations:manifest.migrationCount,checks:9,inventory:rls.checks.length}));

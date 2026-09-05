import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const name='os-module-db-'+randomUUID();
const image='postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
const password=randomBytes(32).toString('hex');
const docker=(args,input)=>{
 const r=spawnSync('docker',args,{encoding:'utf8',input,windowsHide:true,env:{...process.env,POSTGRES_PASSWORD:password},maxBuffer:4*1024*1024});
 if(r.status!==0)throw Error(String(r.stderr||r.error).split(password).join('[REDACTED]')); return r.stdout;
};
try {
 docker(['run','-d','--name',name,'--network','none','--memory','512m','--env','POSTGRES_PASSWORD','--env','PGDATA=/tmp/pg','--tmpfs','/tmp:rw,size=384m',image]);
 let ready=false;
 for(let i=0;i<80;i++){try{docker(['exec',name,'pg_isready','-U','postgres']);ready=true;break;}catch{await delay(250);}}
 assert.ok(ready,'isolated PostgreSQL must become ready');
 docker(['exec','-i',name,'psql','-X','-U','postgres','-v','ON_ERROR_STOP=1'],'CREATE ROLE anon NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE ROLE authenticator NOLOGIN;');
 const root=new URL('../',import.meta.url);
 const manifest=JSON.parse(readFileSync(new URL('migrations/manifest.json',root),'utf8'));
 // The operation/session lineage is defined by 0001..0009. Later unrelated
 // OSAA/vector migrations are outside this focused database contract test.
 const files=['migrations/baseline/verify/supabase-test-prerequisites.sql',...manifest.migrations.filter(m=>m.setSize<=9).map(m=>m.path)];
 if(!files.some(p=>p.includes('0036_')))files.push('migrations/versions/0036_development_module_installation.sql');
 for(const file of files)docker(['exec','-i',name,'psql','-X','-U','postgres','-v','ON_ERROR_STOP=1','--single-transaction'],readFileSync(new URL(file,root),'utf8'));
 const checks=readFileSync(new URL('migrations/versions/verify/0036_development_module_installation.verify.sql',root),'utf8');
 docker(['exec','-i',name,'psql','-X','-U','postgres','-v','ON_ERROR_STOP=1'],'BEGIN;\n'+checks+'\nROLLBACK;');
 console.log(JSON.stringify({status:'passed',isolatedDatabase:true,disabledByDefault:true,productionGuard:true,trueAal1:true,strictRpcPreserved:true,otherModuleDenied:true,selfApprovalDenied:true,samePersonDenied:true,independentApproval:true}));
}finally{
 docker(['rm','-f',name]);
}

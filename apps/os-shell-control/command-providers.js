'use strict';
// Owner contracts are data from signed, activated modules. They cannot select
// arbitrary URLs, permissions, methods or shell programs.
const {createHash,createPublicKey,verify}=require('node:crypto');
const {validateSchema,validateValue}=require('./command-schema');
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=()=>{throw Object.assign(Error('Activated owner command contract could not be verified'),{status:503,code:'CommandProviderUnavailable',sideEffect:'none'});};
async function bytes(fetchImpl,url,max=1024*1024){
 const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)fail();
 const reader=response.body.getReader(),chunks=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();fail();}chunks.push(Buffer.from(value));}
 return Buffer.concat(chunks);
}
function parseContract(value,owner){
 if(value?.schema!=='opensphere.owner-commands/v2'||value.owner!==owner||!/^\d+\.\d+\.\d+$/.test(value.version||'')||!Array.isArray(value.commands)||value.commands.length>64||Object.keys(value).some(k=>!['schema','owner','version','tier','commands'].includes(k)))fail();
 const seen=new Set();
 const definitions=value.commands.map(c=>{
  if(!c||!c.id?.startsWith(owner+'.')||!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(c.id)||c.id.length>128||seen.has(c.id)||typeof c.description!=='string'||c.description.length<1||c.description.length>500||typeof c.mutation!=='boolean'||Object.keys(c).some(k=>!['id','description','mutation','arguments','statusCommand'].includes(k)))fail();
  seen.add(c.id);
  validateSchema(c.arguments);if(c.arguments.type!=='object')fail();
  const reason=c.arguments.properties.reason;
  if(c.mutation&&(!c.arguments.required.includes('reason')||reason?.type!=='string'||!Number.isInteger(reason.minLength)||reason.minLength<8||reason.maxLength>500||typeof c.statusCommand!=='string'))fail();
  return {id:c.id,owner,description:c.description,read:!c.mutation,fields:Object.keys(c.arguments.properties),argumentSchema:c.arguments,statusCommand:c.statusCommand,provider:true};
 });
 for(const d of definitions)if(d.statusCommand&&!definitions.some(s=>s.id===d.statusCommand&&s.read))fail();
 return definitions;
}
function validateProviderArguments(def,args){
 validateValue(def.argumentSchema,args);
}
function createRegistryCommandProviders({registryUrl,fetchImpl=fetch,now=Date.now}){
 const registry=new URL(registryUrl);if(!['http:','https:'].includes(registry.protocol)||registry.username||registry.password||registry.pathname!=='/'||registry.search||registry.hash)throw Error('Registry origin required');
 return async()=>{
  const snapshot=JSON.parse(await bytes(fetchImpl,registry.origin+'/api/v1/registry',4*1024*1024));
  const age=now()-Date.parse(snapshot.observedAt);
  if(snapshot.stale!==false||!Number.isFinite(age)||age>30000||age< -30000||!Array.isArray(snapshot.plugins))fail();
  const result=[],owners=new Set();
  for(const p of snapshot.plugins){
   if(!p.available||p.contributions?.cli?.enabled!==true||p.contributions?.cli?.manifestPath!=='/contracts/owner-commands.json')continue;
   if(owners.has(p.id))fail();owners.add(p.id);
   if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(p.id)||p.hostRef!=='main'||p.contributions.cli.namespace!==p.id||!new RegExp('^'+p.id+'-r-[a-f0-9]{20}$').test(p.artifactServiceId)||!/^sha256:[a-f0-9]{64}$/.test(p.installedDigest)||!/^[a-f0-9]{64}$/.test(p.manifestSha256))fail();
   const origin='http://'+p.artifactServiceId+'.opensphere-console.svc.cluster.local:8080';
   const manifestBytes=await bytes(fetchImpl,origin+'/plugins/ui-shell.manifest.json',128*1024);
   if(hash(manifestBytes)!==p.manifestSha256)fail();
   const signature=(await bytes(fetchImpl,origin+'/plugins/ui-shell.manifest.json.sig',4096)).toString('utf8').trim();
   const key=createPublicKey({key:Buffer.from(snapshot.trustedKeys?.[p.keyId]||'','base64'),format:'der',type:'spki'});
   if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||!verify('sha256',manifestBytes,{key,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64')))fail();
   const manifest=JSON.parse(manifestBytes),asset=manifest.assets?.find(a=>a.id==='owner-commands');
   if(manifest.id!==p.id||manifest.contributions?.cli?.enabled!==true||manifest.contributions?.cli?.namespace!==p.id||manifest.contributions?.cli?.manifestPath!=='/contracts/owner-commands.json'||(asset?.type!=='data'||asset.path!=='/contracts/owner-commands.json')||!/^[a-f0-9]{64}$/.test(asset.sha256||''))fail();
   const contract=await bytes(fetchImpl,origin+'/contracts/owner-commands.json',64*1024);if(hash(contract)!==asset.sha256)fail();
   result.push(...parseContract(JSON.parse(contract),p.id).map(d=>({...d,origin,contractSha256:'sha256:'+hash(contract)})));
   if(result.length>256)fail();
  }
  return result;
 };
}
module.exports={createRegistryCommandProviders,parseContract,validateProviderArguments};

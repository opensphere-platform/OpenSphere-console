import {isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {readFile} from 'node:fs/promises';
import {REGISTRY_AUTH_SECRET,REGISTRY_PULL_SECRET,REGISTRY_NAMESPACES,parseRegistryState,pullSecretData,GENERATION_ANNOTATION} from './registry-lifecycle-contract.mjs';

function fault(code) { return Object.assign(new Error('Registry credential authority: '+code),{code,status:code==='CredentialConflict'?409:503}); }
export function registryKubernetesOrigin(env=process.env) {
  const host=env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
  const port=env.KUBERNETES_SERVICE_PORT_HTTPS || '443';
  const family=isIP(host);
  if ((!family && host!=='kubernetes.default.svc') || !/^[1-9][0-9]{0,4}$/u.test(port) || Number(port)>65535) {
    throw new Error('Invalid Kubernetes registry authority address');
  }
  return 'https://'+(family===6?'['+host+']':host)+':'+port;
}

export function createRegistrySecretStore({baseUrl='https://kubernetes.default.svc',serviceAccountDirectory='/var/run/secrets/kubernetes.io/serviceaccount',requestImpl}={}) {
  const origin=new URL(baseUrl);
  if(origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) throw new Error('Kubernetes credential authority requires an HTTPS origin');
  async function transport(method,path,body) {
    const [token,ca]=await Promise.all([readFile(serviceAccountDirectory+'/token','utf8'),readFile(serviceAccountDirectory+'/ca.crt')]);
    return new Promise((resolve,reject)=>{
      const encoded=body?Buffer.from(JSON.stringify(body)):null;
      const request=httpsRequest(new URL(path,origin),{method,ca,headers:{authorization:'Bearer '+token.trim(),accept:'application/json',...(encoded?{'content-type':'application/json','content-length':encoded.length}:{})}},response=>{
        let size=0;const chunks=[];
        response.on('data',chunk=>{size+=chunk.length;if(size>262144){request.destroy();reject(fault('CredentialAuthorityUnavailable'));}else chunks.push(chunk);});
        response.on('error',()=>reject(fault('CredentialAuthorityUnavailable')));
        response.on('end',()=>{
          if(response.statusCode===409)return reject(fault('CredentialConflict'));
          if(response.statusCode===404)return resolve(null);
          if(response.statusCode<200 || response.statusCode>=300)return reject(fault('CredentialAuthorityUnavailable'));
          try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(fault('CredentialAuthorityUnavailable'));}
        });
      });
      request.setTimeout(10000,()=>request.destroy());
      request.on('error',()=>reject(fault('CredentialAuthorityUnavailable')));
      if(encoded)request.write(encoded);request.end();
    });
  }
  const send=requestImpl || transport;
  const path=(namespace,name)=>'/api/v1/namespaces/'+namespace+'/secrets/'+name;
  return Object.freeze({
    async read(){const secret=await send('GET',path('opensphere-console',REGISTRY_AUTH_SECRET));if(!secret)throw fault('RegistryHandoffRequired');return {secret,state:parseRegistryState(secret)};},
    async write(snapshot,state){
      const next={...snapshot.secret,data:{...snapshot.secret.data,'state.json':Buffer.from(JSON.stringify(state)).toString('base64')}};
      const secret=await send('PUT',path('opensphere-console',REGISTRY_AUTH_SECRET),next);
      if(!secret || !secret.metadata?.resourceVersion)throw fault('RegistryHandoffRequired');
      return {secret,state:parseRegistryState(secret)};
    },
    async synchronize(credentials,generation,fence){
      async function assertFence(){
        if(!fence)return;
        const current=await send('GET',path('opensphere-console',REGISTRY_AUTH_SECRET));
        if(current?.metadata?.resourceVersion!==fence.secret.metadata.resourceVersion)throw fault('CredentialConflict');
      }
      const expected=pullSecretData(credentials,generation);
      for(const namespace of REGISTRY_NAMESPACES){
        const p=path(namespace,REGISTRY_PULL_SECRET);const old=await send('GET',p);
        if(!old || old.type!=='kubernetes.io/dockerconfigjson')throw fault('RegistryPullSecretMissing');
        if(old.data?.['.dockerconfigjson']===expected['.dockerconfigjson'] && old.metadata?.annotations?.[GENERATION_ANNOTATION]===generation)continue;
        await assertFence();
        const value=await send('PUT',p,{...old,metadata:{...old.metadata,annotations:{...old.metadata.annotations,[GENERATION_ANNOTATION]:generation}},data:expected});
        if(!value)throw fault('RegistryPullSecretMissing');
      }
      for(const namespace of REGISTRY_NAMESPACES){
        const value=await send('GET',path(namespace,REGISTRY_PULL_SECRET));
        if(value?.data?.['.dockerconfigjson']!==expected['.dockerconfigjson'] || value?.metadata?.annotations?.[GENERATION_ANNOTATION]!==generation)throw fault('CredentialPropagationPending');
      }
      await assertFence();
      return [...REGISTRY_NAMESPACES];
    }
  });
}
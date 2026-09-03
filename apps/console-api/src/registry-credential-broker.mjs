import {randomUUID} from 'node:crypto';
import {publicRegistryState,validateCredential,initialRegistryState} from './registry-lifecycle-contract.mjs';
const PERMANENT=new Set(['PermissionDenied','RegistryPullDenied','ReadOnlyPackagesScopeRequired','IdentityMismatch','ReauthorizationRequired','CredentialExpired']);
const SAFE_ERRORS=new Set([...PERMANENT,'ProviderUnavailable','RegistryImageUnavailable','RegistryDigestMismatch','CredentialPropagationPending','RegistryPullSecretMissing','CredentialAuthorityUnavailable']);
const fault=(code)=>Object.assign(new Error('Registry credential lifecycle: '+code),{code,status:code==='CredentialConflict'?409:503});

// Runs inside C_API. Kubernetes resourceVersion is the cross-replica fence.
export function createRegistryCredentialBroker({store,provider,clientId='',assertAuthority,recordResult,installationImages,now=Date.now,newId=randomUUID}) {
  const stamp=()=>new Date(now()).toISOString();
  async function change(snapshot,patch){return store.write(snapshot,{...snapshot.state,...patch,updatedAt:stamp()});}
  async function available(){
    const snapshot=await store.read();
    if(snapshot.state.work || snapshot.state.pending || snapshot.state.operation)throw fault('CredentialConflict');
    return snapshot;
  }
  async function result(state,outcome,code){
    if(!recordResult)throw fault('CredentialAuditUnavailable');
    await recordResult({operationId:state.operation?.operationId || null,eventId:state.rotation?.eventId || state.work?.id || state.generation,
      outcome,generation:state.generation,code,actorRef:state.operation?.actorRef || 'system:registry-credential-broker'});
  }
  return Object.freeze({
    async status(actorRef){return publicRegistryState((await store.read()).state,{clientId,actorRef,now:now()});},
    async verify(){
      const snapshot=await available();
      const state=snapshot.state;
      if(!state.credentials)throw fault('ReauthorizationRequired');
      validateCredential(state.credentials);
      const life=state.credentials.lifecycle || {};
      if(life.expiresAt && Date.parse(life.expiresAt)<=now())throw fault('CredentialExpired');
      await provider.inspect(state.credentials.token,{username:state.credentials.username,userId:life.userId});
      const verification=state.images.length
        ? await provider.verifyImages(state.credentials,state.images)
        : {verifiedAt:stamp(),imageCount:0};
      const current=await store.read();
      if(current.version!==snapshot.version || current.state.generation!==state.generation)throw fault('CredentialConflict');
      return Object.freeze({
        connectionId:'opensphere-ghcr',
        result:'Verified',
        credentialVersion:state.generation,
        authenticationMode:life.mode,
        expiresAt:life.expiresAt || null,
        verifiedAt:String(verification?.verifiedAt || stamp()),
        imageCount:Number(verification?.imageCount ?? state.images.length),
      });
    },
    async checkAvailable(){await available();},
    async rejectIntent({operationId,session}){
      const snapshot=await store.read();
      await result({...snapshot.state,operation:{operationId,actorRef:session.subjectId},work:{id:newId()}},'unknown','CredentialOperationFailed');
    },
    async beginOAuth({operationId,session}){
      if(!clientId)throw fault('OpenSphereOAuthClientIdRequired');
      let snapshot=await available();
      const operation={operationId,actorRef:session.subjectId,sessionId:session.sessionId};
      snapshot=await change(snapshot,{operation,work:{id:newId(),kind:'device-start',startedAt:now()},errorCode:null});
      try{
        await assertAuthority(operation);
        const flow=await provider.start(clientId);
        snapshot=await change(snapshot,{work:null,pending:{...operation,flow},phase:'AwaitingAuthorization'});
        return publicRegistryState(snapshot.state,{clientId,actorRef:session.subjectId,now:now()});
      }catch(error){
        await result(snapshot.state,'failed','AuthorizationStartFailed');
        await change(snapshot,{work:null,pending:null,operation:null,phase:snapshot.state.credentials?'Degraded':'ReauthorizationRequired',errorCode:'AuthorizationStartFailed'});
        throw fault('AuthorizationStartFailed');
      }
    },
    async replace({operationId,session,credentials}){
      let snapshot=await available();
      const operation={operationId,actorRef:session.subjectId,sessionId:session.sessionId};
      // Verify before replacing a still-working credential. Never hand over a broad gh token.
      const checked=await provider.pat(credentials);
      if(snapshot.state.images.length)await provider.verifyImages(checked,snapshot.state.images);
      validateCredential(checked);await assertAuthority(operation);
      await change(snapshot,{credentials:checked,generation:newId(),operation,phase:'Pending',observation:null,errorCode:null});
    },
    async remove({operationId,session}){
      const snapshot=await available();const operation={operationId,actorRef:session.subjectId,sessionId:session.sessionId};
      await assertAuthority(operation);
      await change(snapshot,{credentials:null,generation:newId(),operation,phase:'Removing',observation:null,errorCode:null});
    },
    async tick(){
      let snapshot=await store.read();
      if(installationImages && !snapshot.state.work && !snapshot.state.pending){
        const images=await installationImages();
        initialRegistryState(snapshot.state.credentials,images,{generation:snapshot.state.generation});
        if(JSON.stringify([...images].sort())!==JSON.stringify([...snapshot.state.images].sort())){
          snapshot=await change(snapshot,{images,observation:null,phase:snapshot.state.phase==='ReauthorizationRequired'?'ReauthorizationRequired':snapshot.state.credentials?'Pending':'Anonymous'});
        }
      }
      const before=snapshot.state;
      if(before.work){
        if(now()-before.work.startedAt<120000)return;
        // A refresh may have consumed the old pair. Never retry it after a crash/unknown result.
        await result(before,'unknown','InterruptedCredentialOperation');
        await change(snapshot,{phase:'ReauthorizationRequired',work:null,pending:null,operation:null,errorCode:'InterruptedCredentialOperation'});
        return;
      }
      if(before.phase==='ReauthorizationRequired')return;
      if(before.retryAt && before.retryAt>now())return;
      const life=before.credentials?.lifecycle;
      const refreshDue=Boolean(life?.refreshToken && life.expiresAt && Date.parse(life.expiresAt)-now()<=15*60*1000);
      const checkDue=!before.observation || now()-Date.parse(before.observation.verifiedAt)>=15*60*1000;
      if(before.phase==='Anonymous' && !before.operation)return;
      if(before.phase==='Ready' && !before.pending && !refreshDue && !checkDue)return;
      if(before.pending && before.pending.flow.nextPollAt>now())return;
      const kind=before.pending?'device-poll':refreshDue?'refresh':'propagate';
      snapshot=await change(snapshot,{work:{id:newId(),kind,startedAt:now()},retryAt:null});
      try{
        if(kind==='device-poll'){
          await assertAuthority(before.pending);
          const response=await provider.poll(before.pending.flow);
          if(response.pending){await change(snapshot,{work:null,pending:{...before.pending,flow:response.flow}});return;}
          const credentials=response.credentials;validateCredential(credentials);
          if(before.images.length)await provider.verifyImages(credentials,before.images);
          await assertAuthority(before.pending);
          await change(snapshot,{work:null,pending:null,credentials,generation:newId(),phase:'Pending',observation:null,errorCode:null});
          return;
        }
        if(kind==='refresh'){
          // Audit before an irreversible provider rotation. New pair is persisted before pull-secret fan-out.
          await result(snapshot.state,'accepted','RefreshStarted');
          const credentials=await provider.refresh(before.credentials);
          validateCredential(credentials);
          await change(snapshot,{work:null,credentials,generation:newId(),rotation:{eventId:snapshot.state.work.id,previousGeneration:before.generation},phase:'Pending',observation:null,errorCode:null});
          return;
        }
        if(before.credentials){
          await provider.inspect(before.credentials.token,{username:before.credentials.username,userId:life.userId});
          if(life.expiresAt && Date.parse(life.expiresAt)<=now())throw fault('CredentialExpired');
          if(before.images.length)await provider.verifyImages(before.credentials,before.images);
        }
        const namespaces=await store.synchronize(before.credentials,before.generation,snapshot);
        await result(snapshot.state,'succeeded',before.credentials?'PullSecretsVerified':'PullSecretsCleared');
        await change(snapshot,{phase:before.credentials?'Ready':'Anonymous',work:null,pending:null,operation:null,rotation:null,errorCode:null,
          observation:{verifiedAt:stamp(),namespaces,generation:before.generation}});
      }catch(error){
        if(error?.code==='CredentialConflict')throw error; // stale process must never overwrite its successor
        const code=SAFE_ERRORS.has(error?.code)?error.code:'CredentialOperationFailed';
        const reauthorize=kind==='refresh' || kind==='device-poll' || PERMANENT.has(code);
        // Keep an unresolved work marker if result auditing itself fails; restart reports Unknown.
        await result(snapshot.state,reauthorize?'unknown':'failed',code);
        await change(snapshot,{phase:reauthorize?'ReauthorizationRequired':'Degraded',work:null,pending:null,
          operation:reauthorize?null:before.operation,errorCode:code,retryAt:now()+60000});
      }
    }
  });
}
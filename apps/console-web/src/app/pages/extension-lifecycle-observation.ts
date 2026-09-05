export interface LifecycleRegistration {
  name: string; desiredState: string; identity?: {uid: string; generation: number; resourceVersion: string};
  health?: string;
  status: {phase?: string; reason?: string; observedGeneration?: number; currentDigest?: string; serving?: {phase?: string}; verification?: {manifest?: string; signature?: string; entryDigest?: string}};
}
export interface LifecycleReceipt {registrationUid?: string; registrationGeneration?: number; digest?: string;}
export function lifecycleOutcome(action: string, id: string, receipt: LifecycleReceipt, items: LifecycleRegistration[]): 'pending'|'complete'|'failed' {
  if (!receipt.registrationUid || !Number.isSafeInteger(receipt.registrationGeneration)) return 'pending';
  const row=items.find(r=>r.name===id);
  if(!row) return action==='uninstall'?'complete':'pending';
  if(row.identity?.uid!==receipt.registrationUid) return 'failed';
  if(row.identity.generation<(receipt.registrationGeneration || 0) || (row.status.observedGeneration ?? -1)<row.identity.generation) return 'pending';
  if(row.status.phase==='Failed') return 'failed';
  if(action==='disable') return row.desiredState==='Disabled' && row.status.phase==='Disabled'?'complete':'pending';
  if(action==='uninstall') return 'pending';
  const verified=row.status.verification;
  return row.desiredState==='Enabled' && row.status.phase==='Activated' && row.health==='Ready'
    && row.status.serving?.phase==='Current' && verified?.manifest==='Verified' && verified.signature==='Verified'
    && verified.entryDigest==='Verified' && (action!=='rollback' || row.status.currentDigest===receipt.digest) ? 'complete':'pending';
}
export async function observeLifecycle({action,id,receipt,read,wait,attempts=40,stopped=()=>false}: {
  action:string;id:string;receipt:LifecycleReceipt;read:()=>Promise<{items:LifecycleRegistration[];projection:{state:string;ready:boolean}}>;
  wait:()=>Promise<void>;attempts?:number;stopped?:()=>boolean;
}):Promise<void> {
  for(let n=0;n<attempts;n++){
    if(stopped()) throw new Error('화면을 떠나 관측을 중지했습니다. 작업 상태를 다시 확인하세요.');
    const snapshot=await read();
    if(snapshot.projection?.state!=='live'||snapshot.projection.ready!==true) throw new Error('최신 실행 상태를 확인할 수 없습니다. 완료 여부는 미확정입니다.');
    const result=lifecycleOutcome(action,id,receipt,snapshot.items);
    if(result==='complete')return;
    if(result==='failed')throw new Error(snapshot.items.find(x=>x.name===id)?.status.reason || '실행 실패 또는 대상 교체: 완료되지 않았습니다.');
    if(n+1<attempts)await wait();
  }
  throw new Error('관측 대기 시간이 지났습니다. 완료 여부는 미확정이며 상태를 다시 확인해야 합니다.');
}

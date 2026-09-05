import test from 'node:test';
import assert from 'node:assert/strict';
import {observeLifecycle,lifecycleOutcome} from './extension-lifecycle-observation.ts';
const receipt={registrationUid:'one',registrationGeneration:2};
const row={name:'test',desiredState:'Disabled',identity:{uid:'one',generation:2,resourceVersion:'10'},status:{phase:'Disabled',observedGeneration:2}};
test('failure, timeout, stale observations never resolve as success',async()=>{
 for(const [items,projection] of [[[{...row,status:{phase:'Failed',observedGeneration:2}}],{state:'live',ready:true}],[[{...row,status:{phase:'Installing',observedGeneration:2}}],{state:'live',ready:true}],[[],{state:'stale',ready:true}]] as const){
  await assert.rejects(observeLifecycle({action:'disable',id:'test',receipt,read:async()=>({items:[...items],projection}),wait:async()=>{},attempts:2}));
 }
});
test('only current generation/identity can complete a lifecycle observation',()=>{
 assert.equal(lifecycleOutcome('disable','test',receipt,[row]),'complete');
 assert.equal(lifecycleOutcome('disable','test',receipt,[{...row,status:{phase:'Disabled',observedGeneration:1}}]),'pending');
 assert.equal(lifecycleOutcome('disable','test',receipt,[{...row,identity:{...row.identity,uid:'another'}}]),'failed');
 assert.equal(lifecycleOutcome('uninstall','test',{},[]),'pending');
 assert.equal(lifecycleOutcome('uninstall','test',receipt,[]),'complete');
});

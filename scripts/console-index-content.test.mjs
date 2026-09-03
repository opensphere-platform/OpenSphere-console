import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import yaml from 'js-yaml';
import {buildConsoleIndexContent} from './build-console-index-content.mjs';
import {withConsoleIndexContent} from './render-console-index-content.mjs';
import {validateConsoleIndexEnvelope} from '../packages/contracts/src/console-index-content.ts';
const root=new URL('../',import.meta.url);
fs.mkdirSync(new URL('../.release/',import.meta.url),{recursive:true});
const scratch=fs.mkdtempSync(fileURLToPath(new URL('../.release/index-content-tests-',import.meta.url)));
const base={sourceRevision:'a'.repeat(40),version:'202609040100'};
const sha=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const resign=v=>({...v,sha256:sha(v.data)});
async function fixture(){const out=fs.mkdtempSync(path.join(scratch,'output-'));await buildConsoleIndexContent({...base,outputDirectory:out});return JSON.parse(fs.readFileSync(path.join(out,'content.json'),'utf8'));}

test('content-only build preserves web sources and produces all ten tabs without an Angular build',async()=>{
  const webFile=new URL('../apps/console-web/src/app/pages/landing.ts',import.meta.url);
  const before=sha(fs.readFileSync(webFile,'utf8'));
  const original=await fixture();await validateConsoleIndexEnvelope(original);
  assert.equal(Object.keys(original.data.copy).length,6);
  assert.equal(Object.values(original.data.copy).reduce((n,d)=>n+Object.keys(d).length,0),1301);
  assert.equal(Object.keys(original.data.models).length,21);
  const source=path.join(scratch,'changed','content');fs.cpSync(new URL('../apps/console-index-content/content',import.meta.url),source,{recursive:true});fs.cpSync(new URL('../apps/console-index-content/documents',import.meta.url),path.join(scratch,'changed','documents'),{recursive:true});
  const file=path.join(source,'architecture.copy.json'),copy=JSON.parse(fs.readFileSync(file,'utf8')),key=Object.keys(copy)[0];copy[key]='Independent content update';fs.writeFileSync(file,JSON.stringify(copy));
  const out=path.join(scratch,'changed-output');await buildConsoleIndexContent({...base,version:'202609040101',sourceDirectory:source,outputDirectory:out});
  const changed=JSON.parse(fs.readFileSync(path.join(out,'content.json'),'utf8'));
  assert.equal(changed.data.copy.architecture[key],'Independent content update');assert.notEqual(original.sha256,changed.sha256);assert.equal(before,sha(fs.readFileSync(webFile,'utf8')));
});
test('missing/extra renderer text and wrong contract are rejected before rendering',async()=>{
  const original=await fixture();
  for(const mutate of [v=>delete v.data.copy.architecture[Object.keys(v.data.copy.architecture)[0]],v=>v.data.copy.architecture['new-uncompiled-slot']='x',v=>v.data.rendererContract='console-index-renderer/v9']){
    const v=structuredClone(original);mutate(v);await assert.rejects(validateConsoleIndexEnvelope(resign(v)),/incompatible/);
  }
});
test('content tampering, malformed data and unsafe links fail closed',async()=>{
  const original=await fixture();let v=structuredClone(original);v.data.version='202609040101';await assert.rejects(validateConsoleIndexEnvelope(v),/digest_mismatch/);
  for(const mutate of [v=>v.data.models.UPSTREAM_REFERENCES[0].href='javascript:alert(1)',v=>v.data.models.PERSPECTIVES[0].pluginId='unregistered',v=>v.data.models.FOUNDATION_CONCEPT_TABS.pop(),v=>v.data.models.SERVICE_REALIZATION_LAYERS[0].ordinal=5,v=>v.data.models.AI_LIFECYCLE='wrong type']) {
    v=structuredClone(original);mutate(v);await assert.rejects(validateConsoleIndexEnvelope(resign(v)));
  }
});
test('markup remains inert text: content contract carries no HTML/template or execute surface',async()=>{
 const v=await fixture(),key=Object.keys(v.data.copy.architecture)[0];v.data.copy.architecture[key]='<script>throw Error("must not execute")</script>';await validateConsoleIndexEnvelope(resign(v));
 const sources=['landing','landing-foundations','landing-registry-catalog','landing-pfss-delivery','landing-osaa-dialogue-state','landing-installation-milestones'].map(n=>fs.readFileSync(new URL('../apps/console-web/src/app/pages/'+n+'.ts',import.meta.url),'utf8')).join('\n');
 assert.doesNotMatch(sources,/innerHTML|bypassSecurityTrust|new Function|eval\(/);assert.match(sources,/\{\{ copy\('/);
});
test('same-Pod rendering preserves existing web/API routing and pins only the owned content boundary',()=>{
 const deployment=yaml.loadAll(fs.readFileSync(new URL('../deploy/opensphere-console.yaml',import.meta.url),'utf8')).find(d=>d.kind==='Deployment');
 const original=structuredClone(deployment),image='ghcr.io/opensphere-platform/opensphere-console-index-content@sha256:'+'a'.repeat(64);
 const updated=withConsoleIndexContent(deployment,image),pod=updated.spec.template.spec;
 assert.deepEqual(deployment,original);assert.equal(pod.containers.length,1);assert.equal(pod.initContainers.length,1);assert.equal(pod.initContainers[0].image,image);
 assert.equal(pod.containers[0].image,original.spec.template.spec.containers[0].image);assert.deepEqual(pod.containers[0].env,original.spec.template.spec.containers[0].env);
 assert.equal(pod.containers[0].volumeMounts.find(v=>v.name==='console-index-content').readOnly,true);
 assert.equal(pod.initContainers[0].securityContext.runAsNonRoot,true);assert.deepEqual(withConsoleIndexContent(updated,image),updated);
 assert.throws(()=>withConsoleIndexContent(deployment,image.replace(/@sha256:.*/,':edge')),/immutable/);
 const foreign=structuredClone(deployment);foreign.metadata.name='opensphere-www';assert.throws(()=>withConsoleIndexContent(foreign,image),/Not the Console/);
});

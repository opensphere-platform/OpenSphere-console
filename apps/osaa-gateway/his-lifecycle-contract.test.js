'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const yaml=require('js-yaml');
const Ajv=require('ajv/dist/2020');
const root=path.resolve(__dirname,'../..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
test('typed HISS response schema accepts a real-shaped owner receipt and rejects malformed authority data',()=>{
 const ajv=new Ajv({strict:false,validateFormats:false});
 const validate=ajv.compile(read('packages/contracts/schemas/hiss-lifecycle-response.schema.json'));
 const value={schema:'opensphere.hiss-lifecycle/v1',id:'cert-manager',displayName:'Certificate Management',chartVersion:'v1.20.0',namespace:'cert-manager',releaseName:'cert-manager',
 observedAt:new Date().toISOString(),revision:'sha256:'+'a'.repeat(64),ownership:'ClusterManager',state:'Ready',reason:'CertManagerReady',message:'Ready',installed:true,releaseStatus:'deployed',releaseRevision:1,
 operation:{id:'m1-abc',action:'install',phase:'Ready',progress:100,startedAt:'2026-09-06T00:00:00Z',updatedAt:'2026-09-06T00:01:00Z',finishedAt:'2026-09-06T00:01:00Z',error:'',noChange:false},retainedOnDelete:['CRD','Namespace']};
 assert.equal(validate(value),true,JSON.stringify(validate.errors));
 for(const bad of [{...value,id:'arbitrary-chart'},{...value,token:'unexpected-secret'},{...value,installed:'yes'},{...value,operation:{...value.operation,progress:200}}]) assert.equal(validate(bad),false);
});
test('reviewed cert-manager profile preserves the inventory role and excludes unrelated runtime powers',()=>{
 const docs=yaml.loadAll(fs.readFileSync(path.join(root,'apps/extension-controller/hiss-cert-manager-execution.yaml'),'utf8')).filter(Boolean);
 assert.equal(docs.length,9);
 for(const b of docs.filter(d=>d.kind.endsWith('Binding'))) assert.deepEqual(b.subjects,[{kind:'ServiceAccount',name:'opensphere-cluster-manager-runtime',namespace:'opensphere-console'}]);
 const roles=docs.filter(d=>['Role','ClusterRole'].includes(d.kind));
 const allowed=(ns,group,resource,verb,name)=>roles.some(role=>(role.kind==='ClusterRole'||role.metadata.namespace===ns)&&role.rules.some(r=>r.apiGroups.includes(group)&&r.resources.includes(resource)&&r.verbs.includes(verb)&&(!r.resourceNames||r.resourceNames.includes(name))));
 assert.equal(allowed('cert-manager','','secrets','list'),true);
 for(const ns of ['opensphere-console','kube-system','opensphere-console-data','default']) assert.equal(allowed(ns,'','secrets','list'),false,ns);
 assert.equal(allowed(null,'','namespaces','delete','cert-manager'),false);
 assert.equal(allowed(null,'','nodes','patch','any-node'),false);
 assert.equal(allowed(null,'rbac.authorization.k8s.io','clusterroles','bind','cluster-admin'),false);
 assert.equal(allowed(null,'rbac.authorization.k8s.io','clusterroles','escalate','cert-manager-cainjector'),true);
 // RBAC cannot constrain create by name. Preserve this visible risk in the
 // approval contract; do not describe this executor as a complete sandbox.
 assert.equal(allowed(null,'rbac.authorization.k8s.io','clusterroles','create','arbitrary-name'),true);
 assert.ok(!roles.some(r=>r.metadata.name==='opensphere-cluster-manager-runtime'));
});

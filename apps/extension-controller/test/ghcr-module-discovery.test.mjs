import test from 'node:test';
import assert from 'node:assert/strict';
import {createGhcrModuleDiscovery} from '../src/ghcr-module-discovery.mjs';
import {moduleFixture} from './module-release-fixture.mjs';
function harness({existing=null,alterIndex, registryStatus=200}={}) {
  const fixture=moduleFixture(), calls=[]; let saved=existing, now=fixture.now;
  if(alterIndex)alterIndex(fixture.index);
  const discovery=createGhcrModuleDiscovery({kubernetesBaseUrl:'https://kubernetes.default.svc',namespace:'opensphere-console',
    loadKubernetesToken:async()=> 'test-kubernetes-token',loadDockerConfig:async()=>({auths:{'ghcr.io':{auth:Buffer.from('test-user:test-registry-token').toString('base64')}}}),
    loadTrustedKeys:async()=>fixture.trustedKeys,now:()=>now,fetchImpl:async(url,init)=>{
      calls.push({url,init});
      if(url.startsWith('https://ghcr.io/token'))return Response.json({token:'test-scoped-token'});
      if(url.startsWith('https://ghcr.io/v2/'))return Response.json(fixture.index,{status:registryStatus});
      assert.ok(url.startsWith('https://kubernetes.default.svc/apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-console/uipluginpackages'));
      if(init.method==='GET')return Response.json(saved||{}, {status:saved?200:404});
      saved=JSON.parse(init.body);return Response.json(saved);
    }});
  return {discovery,calls,get saved(){return saved;},tick(){now+=61_000;}};
}
test('verified GHCR catalog imports package metadata only, never a registration or workload',async()=>{
  const h=harness();const result=await h.discovery.reconcileOnce();
  assert.equal(result.results[0].state,'Discovered');assert.equal(h.saved.kind,'UIPluginPackage');
  assert.equal(h.saved.metadata.annotations['opensphere.io/discovery-state'],'Verified');
  assert.ok(h.calls.every(call=>!/(deployments|registrations|secrets|serviceaccounts)/.test(call.url)));
  assert.ok(!JSON.stringify(h.saved).includes('test-registry-token'));
  assert.equal(h.calls.filter(call=>call.url.startsWith('https://ghcr.io')&&call.init.headers.authorization==='Bearer test-kubernetes-token').length,0);
  assert.ok(h.calls.every(call=>call.init.redirect==='error'));
  const count=h.calls.length;assert.equal((await h.discovery.reconcileOnce()).state,'Idle');assert.equal(h.calls.length,count);
});
test('tampered executable or signing failure never imports an eligible package',async()=>{
  const h=harness({alterIndex:index=>{index.manifests[0].digest='sha256:'+'b'.repeat(64);}});
  assert.equal((await h.discovery.reconcileOnce()).results[0].code,'ModuleReleaseInvalid');assert.equal(h.saved,null);
  assert.ok(h.calls.every(call=>!['POST','PUT'].includes(call.init.method)));
});
test('discovery cannot take over a manually owned existing package',async()=>{
  const current={metadata:{name:'cluster-manager',labels:{'app.kubernetes.io/managed-by':'another-owner'}},spec:{unchanged:true}};
  const h=harness({existing:current});assert.equal((await h.discovery.reconcileOnce()).results[0].code,'ModuleCatalogOwnershipConflict');
  assert.equal(h.saved,current);assert.ok(h.calls.every(call=>!['POST','PUT'].includes(call.init.method)));
});
test('registry outages retain existing package bytes and mark only the discovery state unavailable',async()=>{
  const h=harness();await h.discovery.reconcileOnce();const original=structuredClone(h.saved.spec);
  const other=harness({existing:h.saved,registryStatus:401});
  assert.equal((await other.discovery.reconcileOnce()).results[0].code,'ModuleCatalogHttp401');
  assert.deepEqual(other.saved.spec,original);assert.equal(other.saved.metadata.annotations['opensphere.io/discovery-state'],'ModuleCatalogHttp401');
});

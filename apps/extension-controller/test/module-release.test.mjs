import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyModuleRelease, verifyModulePackage, moduleReleaseFromIndex} from '../src/module-release.mjs';
import {moduleFixture} from './module-release-fixture.mjs';
test('original infrastructure profile is signed and remains restricted to the official Cluster Manager', () => {
  const f=moduleFixture();
  const release={...f.release,spec:{...f.release.spec,permissionProfile:'cluster-infrastructure-manager-v1'}};
  assert.equal(verifyModuleRelease(f.seal(release),f.trustedKeys,{now:f.now}).spec.permissionProfile,'cluster-infrastructure-manager-v1');
  for(const update of [{id:'other'},{spec:{...release.spec,image:{...release.spec.image,repository:'ghcr.io/opensphere-platform/other'}}},{spec:{...release.spec,permissionProfile:'cluster-admin'}}]) {
    assert.throws(()=>verifyModuleRelease(f.seal({...release,...update}),f.trustedKeys,{now:f.now}),{code:'ModuleReleaseInvalid'});
  }
});
test('signed official package binds executable, identity, privileges and channel', () => {
  const f=moduleFixture();
  assert.deepEqual(verifyModuleRelease(f.envelope,f.trustedKeys,{now:f.now}),f.release);
  assert.deepEqual(moduleReleaseFromIndex(f.index,f.trustedKeys,{now:f.now}).release,f.release);
  const pkg={metadata:{name:f.release.id,annotations:{'opensphere.io/module-release':f.envelope}},spec:f.release.spec};
  assert.deepEqual(verifyModulePackage(pkg,f.trustedKeys,{now:f.now}),f.release);
  assert.throws(()=>verifyModulePackage({...pkg,spec:{...pkg.spec,env:[{name:'EXFILTRATE',value:'true'}]}},f.trustedKeys,{now:f.now}),{code:'ModuleReleaseInvalid'});
});
test('valid UI/signature copied onto an unrelated executable index fails closed', () => {
  const f=moduleFixture(); f.index.manifests[0].digest='sha256:'+'b'.repeat(64);
  assert.throws(()=>moduleReleaseFromIndex(f.index,f.trustedKeys,{now:f.now}),{code:'ModuleReleaseInvalid'});
});
test('unknown key, changed signed bytes, malformed signature and excessive catalog fail', () => {
  const f=moduleFixture();
  assert.throws(()=>verifyModuleRelease(f.envelope,{}, {now:f.now}),{code:'ModuleReleaseInvalid'});
  const signed=JSON.parse(f.envelope); signed.payload=Buffer.from(JSON.stringify({...f.release,channel:'stable'})).toString('base64');
  assert.throws(()=>verifyModuleRelease(JSON.stringify(signed),f.trustedKeys,{now:f.now}),{code:'ModuleReleaseInvalid'});
  assert.throws(()=>verifyModuleRelease('x'.repeat(100_000),f.trustedKeys,{now:f.now}),{code:'ModuleReleaseInvalid'});
});
test('expired catalogs block new candidates while retained installed evidence can still verify', () => {
  const f=moduleFixture();
  assert.throws(()=>verifyModuleRelease(f.envelope,f.trustedKeys,{now:f.now+2*86400_000}),{code:'ModuleReleaseInvalid'});
  assert.equal(verifyModuleRelease(f.envelope,f.trustedKeys,{now:f.now+2*86400_000,requireFresh:false}).id,'cluster-manager');
  for(const update of [{channel:'stable'},{id:'workspace'},{expiresAt:new Date(f.now+91*86400_000).toISOString()}]) assert.throws(()=>verifyModuleRelease(f.seal({...f.release,...update}),f.trustedKeys,{now:f.now}),{code:'ModuleReleaseInvalid'});
});

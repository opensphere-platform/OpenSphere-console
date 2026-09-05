import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionArtifactUrl } from './extension-artifact-url.ts';
const origin='https://localhost:1114',base='/api/plugins/cluster-manager-r-0123456789abcdef0123',manifest=base+'/plugins/ui-shell.manifest.json';
test('owner absolute and original relative assets resolve to the same verified proxy revision',()=>{
  for(const path of ['/app/main.js','../app/main.js']) assert.equal(extensionArtifactUrl(path,base,manifest,origin).href,origin+base+'/app/main.js');
});
test('signed assets cannot escape to another origin, owner, root API or traversal target',()=>{
  for(const path of ['https://evil.example/app/main.js','//evil.example/app/main.js','/api/identity/me','/api/plugins/other/app/main.js','/app/../../../api/identity/me','/app/main.js?x=1','/app/main.js#fragment']) assert.throws(()=>extensionArtifactUrl(path,base,manifest,origin));
});

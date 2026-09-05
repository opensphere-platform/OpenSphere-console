import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseLabel} from './release-display.ts';
test('human release labels preserve versions and never substitute hashes or compatibility versions',()=>{
 assert.equal(releaseLabel({artifactVersion:'202609051810',channel:'edge'}),'edge · 빌드 2026.09.05-1810');
 assert.equal(releaseLabel({version:'2.1.0',channel:'stable'}),'2.1.0 · stable');
 assert.equal(releaseLabel({version:'a'.repeat(40),imageDigest:'sha256:'+'b'.repeat(64),channel:'edge'}),'edge · 버전 정보 없음');
 assert.equal(releaseLabel({compatibilityVersion:'1.0.0'}),'버전 정보 없음');
});

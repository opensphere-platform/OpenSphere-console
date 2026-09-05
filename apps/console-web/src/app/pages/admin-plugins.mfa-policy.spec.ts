import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=(name:string)=>readFileSync(new URL(name,import.meta.url),'utf8');
test('module discovery states the narrow development policy without waiving independent approval',()=>{
 const html=read('./admin-modules.html');
 for(const phrase of ['HTTPS localhost · edge · development','다른 lifecycle 작업은 MFA','요청자와 다른 운영자의 승인','8자 이상'])assert.ok(html.includes(phrase));
});
test('Cluster Manager installation enters the protected change request workflow, not the old duplicate form',()=>{
 const modules=read('./admin-modules.ts');const changes=read('./admin-change-control.ts');const plugins=read('./admin-plugins.ts');
 assert.ok(modules.includes('console-cluster-manager-install'));
 assert.ok(modules.includes('/manage/extensions/audit'));
 assert.ok(changes.includes('draft().reason.trim().length < 8'));
 assert.ok(changes.includes('!current.managementReady'));
 assert.ok(changes.includes('templateId: this.requestedTemplate()!.id'));
 assert.ok(!plugins.includes('async installModule('));
});

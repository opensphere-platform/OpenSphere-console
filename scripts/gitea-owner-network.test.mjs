import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import yaml from 'js-yaml';

test('Git owner health uses an exact same-namespace API-to-C_EXT TCP/8080 path in both directions', () => {
 const docs = p => yaml.loadAll(readFileSync(new URL(p,import.meta.url),'utf8'));
 const api = docs('../apps/console-api/deploy.yaml').find(d=>d.kind==='NetworkPolicy'&&d.metadata.name==='opensphere-console-api');
 const owner = docs('../apps/extension-controller/deploy.yaml').find(d=>d.kind==='NetworkPolicy'&&d.metadata.name==='opensphere-extension-controller-ingress');
 const selector = name => ({podSelector:{matchLabels:{'app.kubernetes.io/name':name}}});
 const permits = (rules,key,peer) => rules.some(r=>JSON.stringify(r.ports)===JSON.stringify([{protocol:'TCP',port:8080}])&&r[key].some(p=>JSON.stringify(p)===JSON.stringify(peer)));
 assert(permits(api.spec.egress,'to',selector('opensphere-extension-controller')));
 assert(permits(owner.spec.ingress,'from',selector('opensphere-console-api')));
 const egress=api.spec.egress.find(r=>r.to?.some(p=>p.podSelector?.matchLabels?.['app.kubernetes.io/name']==='opensphere-extension-controller'));
 assert.deepEqual(egress.to,[selector('opensphere-registry'),selector('opensphere-extension-controller')]);
});

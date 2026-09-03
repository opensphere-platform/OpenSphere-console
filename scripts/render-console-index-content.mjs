import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
const imagePattern=/^ghcr\.io\/opensphere-platform\/opensphere-console-index-content@sha256:[a-f0-9]{64}$/;
export function withConsoleIndexContent(deployment,image) {
  if(!imagePattern.test(image))throw Error('Console index content requires a canonical immutable image digest.');
  const result=structuredClone(deployment);
  if(result.kind!=='Deployment'||result.metadata?.namespace!=='opensphere-console'||result.metadata?.name!=='opensphere-console')throw Error('Not the Console web Deployment.');
  const pod=result.spec.template.spec,web=pod.containers.find(c=>c.name==='shell');
  if(!web)throw Error('Console shell container missing.');
  if(pod.securityContext?.fsGroup && pod.securityContext.fsGroup!==101)throw Error('Existing fsGroup requires compatibility review.');
  pod.securityContext={...pod.securityContext,fsGroup:101};
  const init={name:'console-index-content',image,imagePullPolicy:'IfNotPresent',
    resources:{requests:{cpu:'10m',memory:'8Mi'},limits:{cpu:'100m',memory:'32Mi'}},
    securityContext:{runAsNonRoot:true,runAsUser:101,runAsGroup:101,readOnlyRootFilesystem:true,allowPrivilegeEscalation:false,capabilities:{drop:['ALL']}},
    volumeMounts:[{name:'console-index-content',mountPath:'/output'}]};
  const volume={name:'console-index-content',emptyDir:{sizeLimit:'4Mi'}};
  const mount={name:'console-index-content',mountPath:'/usr/share/nginx/html/console-index',readOnly:true};
  for(const [collection,value]of [[pod.initContainers??=[],init],[pod.volumes??=[],volume],[web.volumeMounts??=[],mount]]) {
    const old=collection.findIndex(v=>v.name===value.name);
    if(old<0) collection.push(value);
    else {
      const existing=collection[old];
      const comparable=value===init ? {...existing,image:value.image} : existing;
      if(!isDeepStrictEqual(comparable,value)) throw Error('Conflicting existing Console content resource; explicit review required.');
      collection[old]=value;
    }
  }
  const command=web.readinessProbe?.exec?.command;
  if(!command||command.length!==3||command[0]!=='/bin/sh'||command[1]!=='-ec')throw Error('Unexpected web readiness contract.');
  const guard='test "$(cat /usr/share/nginx/html/console-index/renderer-contract.txt)" = "console-index-renderer/v1" && cmp /usr/share/nginx/html/console-index-renderer-signature.txt /usr/share/nginx/html/console-index/renderer-signature.txt && (cd /usr/share/nginx/html/console-index && sha256sum -c SHA256SUMS >/dev/null) && ';
  if(!command[2].startsWith(guard))command[2]=guard+command[2];
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [input,image,output]=process.argv.slice(2);
  if(!input||!image||!output)throw Error('Usage: node scripts/render-console-index-content.mjs deployment.json image@sha256:... output.json');
  fs.writeFileSync(output,JSON.stringify(withConsoleIndexContent(JSON.parse(fs.readFileSync(input,'utf8')),image),null,2)+'\n');
}

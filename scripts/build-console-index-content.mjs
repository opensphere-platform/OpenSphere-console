import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {INDEX_RENDERER_CONTRACT,INDEX_MAX_BYTES,indexRendererSignature,validateConsoleIndexEnvelope} from '../packages/contracts/src/console-index-content.ts';

const repository=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function buildConsoleIndexContent({sourceDirectory=path.join(repository,'apps/console-index-content/content'),outputDirectory=path.join(repository,'apps/console-index-content/dist'),version,sourceRevision}={}) {
  if(!/^[a-f0-9]{40}$/.test(sourceRevision??'')) throw Error('A 40-character source revision is required.');
  if(!/^\d{12}$/.test(version??'')) throw Error('KST yyyyMMddHHmm version is required.');
  const copy={},models={};
  for(const file of fs.readdirSync(sourceDirectory).sort()) {
    if(!file.endsWith('.copy.json')&&!file.endsWith('.models.json')) throw Error('Unexpected content source: '+file);
    const parsed=JSON.parse(fs.readFileSync(path.join(sourceDirectory,file),'utf8'));
    if(file.endsWith('.copy.json')) copy[file.slice(0,-10)]=parsed;
    else for(const [key,value]of Object.entries(parsed)) {
      if(Object.hasOwn(models,key)) throw Error('Duplicate model: '+key);
      models[key]=value;
    }
  }
  const data={schemaVersion:1,rendererContract:INDEX_RENDERER_CONTRACT,version,sourceRevision,copy,models};
  const envelope={sha256:sha(JSON.stringify(data)),data};
  await validateConsoleIndexEnvelope(envelope);
  const bytes=Buffer.from(JSON.stringify(envelope)+'\n');
  if(bytes.length>INDEX_MAX_BYTES)throw Error('Content exceeds the renderer byte limit.');
  fs.mkdirSync(outputDirectory,{recursive:true});
  fs.writeFileSync(path.join(outputDirectory,'content.json'),bytes);
  fs.writeFileSync(path.join(outputDirectory,'renderer-contract.txt'),INDEX_RENDERER_CONTRACT+'\n');
  fs.writeFileSync(path.join(outputDirectory,'renderer-signature.txt'),await indexRendererSignature()+'\n');
  const files=['content.json','renderer-contract.txt','renderer-signature.txt'];
  const documents=path.join(sourceDirectory,'../documents');
  for(const file of ['installation-milestones.json','installation-milestones.md']) {
    fs.mkdirSync(path.join(outputDirectory,'installation'),{recursive:true});
    fs.copyFileSync(path.join(documents,file),path.join(outputDirectory,'installation',file));
    files.push('installation/'+file);
  }
  fs.writeFileSync(path.join(outputDirectory,'SHA256SUMS'),files.map(file=>sha(fs.readFileSync(path.join(outputDirectory,file)))+'  '+file).join('\n')+'\n');
  return {version,sourceRevision,rendererContract:INDEX_RENDERER_CONTRACT,contentSha256:sha(bytes),payloadSha256:envelope.sha256,bytes:bytes.length,groups:Object.keys(copy).length,models:Object.keys(models).length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), arg=name=>args[args.indexOf(name)+1];
  const revision=args.includes('--source-revision')?arg('--source-revision'):execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
  const epoch=Number(execFileSync('git',['show','-s','--format=%ct',revision],{cwd:repository,encoding:'utf8'}).trim());
  const version=args.includes('--version')?arg('--version'):new Date((epoch+9*3600)*1000).toISOString().replace(/[-:T]/g,'').slice(0,12);
  const changed=execFileSync('git',['status','--porcelain','--','apps/console-index-content','scripts/build-console-index-content.mjs','packages/contracts/src/console-index-content.ts'],{cwd:repository,encoding:'utf8'}).trim();
  if(changed&&!args.includes('--allow-dirty')) throw Error('Content inputs must be committed; --allow-dirty is local verification only.');
  const result=await buildConsoleIndexContent({sourceRevision:revision,version,...(args.includes('--out')?{outputDirectory:path.resolve(arg('--out'))}:{})});
  console.log(JSON.stringify({...result,verificationOnly:!!changed}));
}

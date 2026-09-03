import fs from 'node:fs';import {indexRendererSignature} from '../packages/contracts/src/console-index-content.ts';
const file=new URL('../apps/console-web/public/console-index-renderer-signature.txt',import.meta.url);
const expected=await indexRendererSignature()+'\n';
if(process.argv.includes('--write'))fs.writeFileSync(file,expected);
if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==expected)throw Error('Renderer signature changed: review/bump the contract and run --write before building the web image.');
console.log('[console-index] renderer compatibility signature verified');

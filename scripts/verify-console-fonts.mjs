import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = process.argv.includes('--dist');
const base = path.join(repo, built ? 'dist/opensphere-console/browser' : 'apps/console-web/public');
const dir = path.join(base, 'assets/fonts');
const read = file => readFileSync(file, 'utf8');
const manifest = JSON.parse(read(path.join(dir, 'manifest.json')));
assert.equal(manifest.schema, 'opensphere.font-assets/v1');
assert.equal(manifest.license, 'OFL-1.1');
assert.match(read(path.join(dir, 'OFL-LICENSE.txt')), /SIL OPEN FONT LICENSE Version 1\.1/);
const notice = read(path.join(dir, 'NOTICE.md'));
const faces = read(path.join(repo, 'apps/console-web/src/_fonts.scss'));
assert.deepEqual(readdirSync(dir).filter(n => n.endsWith('.woff2')).sort(), manifest.files.map(f => f.file).sort());
assert.equal(new Set(manifest.files.map(f => f.file)).size, manifest.files.length);
for (const [family, weights] of Object.entries({ 'IBM Plex Sans': [300,400,500,600,700], 'IBM Plex Sans KR': [300,400,500,600,700], 'IBM Plex Mono': [400,600] })) {
  assert.deepEqual(manifest.files.filter(f => f.family === family).map(f => f.weight).sort(), weights);
}
for (const font of manifest.files) {
  assert.equal(path.basename(font.file), font.file);
  const bytes = readFileSync(path.join(dir, font.file));
  assert.equal(bytes.subarray(0,4).toString(), 'wOF2', font.file);
  assert.equal(bytes.length, font.bytes, font.file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), font.sha256, font.file);
  assert(notice.includes(font.sha256) && notice.includes(font.package) && notice.includes(font.path), `Missing provenance: ${font.file}`);
  const rule = faces.match(new RegExp(`@font-face\\s*\\{[^}]*${font.file.replaceAll('.', '\\.')}[^}]*\\}`))?.[0];
  assert(rule?.includes(`font-family: "${font.family}"`) && rule.includes(`font-weight: ${font.weight};`) && rule.includes('font-display: swap;'), `Missing face: ${font.file}`);
}
const externalFonts = /fonts\.(googleapis|gstatic)\.com/i;
const source = read(path.join(repo, 'apps/console-web/src/styles.scss'));
assert(!externalFonts.test(source), 'Runtime Google Fonts dependency');
assert(!/body\s+\*\s*\{[^}]*font-family/s.test(source), 'Blanket font override breaks code and terminal typography');
assert(source.includes("@use './fonts'"), 'Font face definitions are not imported');
if (built) {
  const files = readdirSync(base).filter(n => /\.(css|html)$/.test(n));
  const styles = files.filter(n => n.endsWith('.css')).map(n => read(path.join(base,n))).join('\n');
  for (const file of files) assert(!externalFonts.test(read(path.join(base,file))), `External font dependency in ${file}`);
  for (const font of manifest.files) assert(styles.includes(`/assets/fonts/${font.file}`), `Built stylesheet does not request ${font.file}`);
  const frameCss = read(path.join(base, 'os-shell-frame/os-shell-fonts.css'));
  assert(read(path.join(base, 'os-shell-frame/index.html')).includes('/os-shell-frame/os-shell-fonts.css'));
  for (const font of manifest.files.filter(f => f.family === 'IBM Plex Mono')) {
    assert(frameCss.includes(readFileSync(path.join(dir,font.file)).toString('base64')), `Isolated frame font differs: ${font.file}`);
  }
}
console.log(`[console-fonts] ${built ? 'dist' : 'source'} verified: ${manifest.files.length} pinned OFL fonts, ${manifest.files.reduce((n,f) => n+f.bytes,0)} bytes, no external font CDN`);

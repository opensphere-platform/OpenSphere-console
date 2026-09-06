import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(repo, 'apps', 'console-web', 'public', 'os-shell-frame');
const entry = path.join(repo, 'apps', 'console-web', 'src', 'app', 'system-plugins', 'os-shell', 'frame', 'os-shell-terminal-frame.ts');
const outfile = path.join(output, 'os-shell-terminal-frame.js');

await mkdir(output, { recursive: true });
await Promise.all([
  rm(outfile, { force: true }),
  rm(path.join(output, 'os-shell-terminal-frame.css'), { force: true }),
]);

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  metafile: true,
  legalComments: 'eof',
  logLevel: 'info',
});

const xtermInputs = Object.keys(result.metafile.inputs)
  .filter((input) => input.includes('node_modules/@xterm/'));
const forbidden = xtermInputs.filter((input) => !input.includes('@xterm/xterm/') && !input.includes('@xterm/addon-fit/'));
if (forbidden.length) throw new Error(`forbidden xterm addon in isolated frame: ${forbidden.join(', ')}`);

console.log(`[os-shell-frame] built ${path.relative(repo, outfile)} with xterm + addon-fit only`);

// Data URLs preserve the terminal frame's opaque origin and existing CSP/COEP isolation.
const fonts = path.join(repo, 'apps', 'console-web', 'public', 'assets', 'fonts');
const monoFaces = [['Regular', 400], ['SemiBold', 600]];
const fontCss = await Promise.all(monoFaces.map(async ([style, weight]) => {
  const bytes = await readFile(path.join(fonts, `IBMPlexMono-${style}.woff2`));
  return `@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:${weight};font-display:swap;src:url("data:font/woff2;base64,${bytes.toString('base64')}") format("woff2");}`;
}));
await writeFile(path.join(output, 'os-shell-fonts.css'), fontCss.join('\n') + '\n');

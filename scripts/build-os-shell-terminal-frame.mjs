import { mkdir, rm } from 'node:fs/promises';
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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACT = 'console-help-center-v2';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || '--source';
const distArg = process.argv[3];

const fail = (message) => {
  console.error(`[manual-ui-contract] ${message}`);
  process.exit(1);
};

const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const requireText = (content, token, label) => {
  if (!content.includes(token)) fail(`${label} is missing required token: ${token}`);
};
const forbidText = (content, token, label) => {
  if (content.includes(token)) fail(`${label} contains retired Manual UI token: ${token}`);
};

const contractPath = path.join(root, 'public', 'manual-contract.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
if (contract.schema !== 'manual-ui.opensphere.io/v1' || contract.contract !== CONTRACT || contract.route !== '/manual') {
  fail('public/manual-contract.json does not declare the canonical Console Help Center contract');
}

const forbidden = [
  'os-source-chips',
  'OAA Manual Registry 소스/문서 탐색 및 검색',
  "redirectTo: 'p/manual'",
];

if (mode === '--source') {
  const manual = read('src', 'app', 'pages', 'manual.ts');
  const routes = read('src', 'app', 'app.routes.ts');
  for (const token of [
    `data-manual-contract="${CONTRACT}"`,
    'manual-local-header',
    'manual-primary-grid',
    'manual-reader manual-shell-width',
  ]) requireText(manual, token, 'src/app/pages/manual.ts');
  requireText(routes, "path: 'manual', component: ManualPage", 'src/app/app.routes.ts');
  for (const token of forbidden) {
    forbidText(manual, token, 'src/app/pages/manual.ts');
    forbidText(routes, token, 'src/app/app.routes.ts');
  }
  console.log(`[manual-ui-contract] source verified: ${CONTRACT}`);
  process.exit(0);
}

if (mode === '--dist') {
  const dist = path.resolve(root, distArg || 'dist/opensphere-console/browser');
  const builtContract = JSON.parse(fs.readFileSync(path.join(dist, 'manual-contract.json'), 'utf8'));
  if (builtContract.contract !== CONTRACT) fail(`built manual-contract.json is not ${CONTRACT}`);
  const bundles = fs.readdirSync(dist).filter((name) => /^main-.*\.js$/.test(name));
  if (bundles.length !== 1) fail(`expected exactly one main bundle, found ${bundles.length}`);
  const bundle = fs.readFileSync(path.join(dist, bundles[0]), 'utf8');
  for (const token of [CONTRACT, 'manual-local-header', 'manual-primary-grid']) {
    requireText(bundle, token, bundles[0]);
  }
  for (const token of forbidden) forbidText(bundle, token, bundles[0]);
  console.log(`[manual-ui-contract] dist verified: ${CONTRACT} (${bundles[0]})`);
  process.exit(0);
}

fail(`unknown mode: ${mode}`);

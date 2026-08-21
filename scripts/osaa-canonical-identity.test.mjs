import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const historical = (file) =>
  file.startsWith('backend/supabase/migrations/') ||
  file === 'backend/supabase/migration-history-lock.json' ||
  file === 'backend/supabase/verify.mjs' ||
  file === 'backend/opensphere-console-backend/foundation-bootstrap-bundle.js' ||
  /(?:^|\/)(?:test\/.*|[^/]+\.(?:test|spec)\.(?:js|mjs|ts))$/i.test(file) ||
  file === 'scripts/osaa-canonical-identity.test.mjs';
const textExtension = /\.(?:cjs|go|html|js|json|md|mjs|ps1|scss|ts|txt|yaml|yml)$/i;

function repositoryFiles() {
  return execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((file) => file.trim().replaceAll('\\', '/'))
    .filter(Boolean);
}

test('OSAA is the only current agent identity and no OAA alias remains', () => {
  const violations = [];
  for (const file of repositoryFiles()) {
    if (historical(file) || !textExtension.test(file)) continue;
    const content = readFileSync(path.join(root, file), 'utf8');
    if (/oaa/i.test(file) || /oaa/i.test(content)) {
      violations.push(file);
    }
  }
  assert.deepEqual(violations, [], `current OAA residue: ${violations.join(', ')}`);
});

test('current HTTP and deployment contracts expose OSAA only', () => {
  const activeFiles = [
    'nginx/default.conf.template',
    'backend/opensphere-console-backend/deploy.yaml',
    'backend/opensphere-console-osaa-gateway/deploy.yaml',
    'backend/opensphere-console-osaa-gateway/server.js',
    'src/app/os/os-osaa-agent.ts',
  ];
  const current = activeFiles.map((file) => readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.match(current, /\/api\/osaa/);
  assert.match(current, /opensphere-console-osaa-gateway/);
  assert.doesNotMatch(current, /\/api\/oaa|opensphere-console-oaa-gateway|opensphere_oaa_/i);
});

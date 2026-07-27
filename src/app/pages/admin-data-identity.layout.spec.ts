import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./admin-data-identity.ts', import.meta.url), 'utf8');

test('Security & DR uses one dense recovery evidence table', () => {
  assert.match(source, /class="recovery-evidence"/);
  assert.match(source, /class="evidence-table"[\s\S]*?role="table"/);
  assert.match(source, /recoveryEvidenceRows\(current\)/);
  assert.doesNotMatch(source, /class="os-card recovery-detail"/);
  assert.doesNotMatch(source, /class="check-table"/);
});

test('recovery evidence table keeps compact fixed tracks and horizontal overflow', () => {
  assert.match(source, /\.evidence-scroll\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(source, /\.evidence-table\s*\{[^}]*min-width:\s*62rem/);
  assert.match(
    source,
    /grid-template-columns:\s*minmax\(11rem,\s*1\.05fr\)\s+minmax\(14rem,\s*1\.45fr\)/,
  );
  assert.match(source, /\.evidence-row\s*\{[^}]*min-height:\s*2\.3rem/);
  assert.match(source, /\.recovery-evidence-header strong\s*\{[^}]*color:\s*var\(--os-ink\)/);
  assert.doesNotMatch(source, /<header(?:\s|>)/);
});

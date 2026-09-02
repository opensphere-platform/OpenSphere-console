import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./admin-data-identity.ts', import.meta.url), 'utf8');

test('Security & DR uses one dense recovery evidence table', () => {
  assert.match(source, /class="recovery-evidence"/);
  assert.match(source, /class="evidence-table" role="table"/);
  assert.match(source, /recoveryEvidenceRows\(current\)/);
  assert.doesNotMatch(source, /class="os-card recovery-detail"/);
  assert.doesNotMatch(source, /class="check-table"/);
});

test('recovery evidence table keeps compact fixed tracks and horizontal overflow', () => {
  assert.match(source, /\.evidence-scroll\{overflow-x:auto\}/);
  assert.match(source, /\.evidence-table\{min-width:62rem\}/);
  assert.match(source, /grid-template-columns:minmax\(11rem,1\.05fr\) minmax\(14rem,1\.45fr\)/);
  assert.match(source, /\.evidence-row\{min-height:2\.3rem/);
  assert.match(source, /\.recovery-evidence>header strong\{color:var\(--os-ink\)/);
});

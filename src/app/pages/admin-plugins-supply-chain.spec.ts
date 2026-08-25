import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('./admin-plugins.ts', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../core/plugin-control-client.service.ts', import.meta.url), 'utf8');

test('Catalog, Registry Connections, and Trust are separate management surfaces', () => {
  for (const view of ['catalog', 'registry-connections', 'trust']) {
    assert.match(page, new RegExp(`activeView\\(\\) === '${view}'`));
    assert.match(page, new RegExp(`routerLink="/manage/extensions/${view}"`));
  }
  assert.match(page, /Registry Connections/);
  assert.match(page, /Trust &amp; Revocation/);
  assert.doesNotMatch(page, /clrAccordionTitle>관리 작업/);
});

test('Catalog presentation accepts only the normalized navigation icon token', () => {
  assert.match(page, /<os-nav-icon \[token\]="descriptor\.presentation\?\.iconRef \|\| 'application'"/);
  assert.doesNotMatch(page, /descriptor\.presentation\?\.(?:iconUrl|svg|html)/);
});

test('Catalog selection never sends an Owner-managed artifact to the DUPA installer', () => {
  assert.match(page, /descriptor\.installation\.mode === 'dupa'/);
  assert.match(page, /설치 실행: \{\{ descriptor\.owner\.id \}\} Owner 경로 준비 필요/);
  assert.match(client, /x-os-idempotency-key/);
  assert.match(client, /crypto\.randomUUID\(\)/);
});

test('Registry connection and revocation destructive actions require exact confirmation', () => {
  assert.match(page, /REMOVE opensphere-ghcr/);
  assert.match(page, /REVOKE \$\{digest\}/);
  assert.match(client, /JSON\.stringify\(\{ reason, confirmation \}\)/);
  assert.match(client, /JSON\.stringify\(\{ image, replacementImage, reason, confirmation \}\)/);
  assert.match(client, /registry-connections\/opensphere-ghcr\/verify/);
  assert.doesNotMatch(client, /\/api\/admin\/extensions\/registry-credentials/);
});

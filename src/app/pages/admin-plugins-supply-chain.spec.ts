import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('./admin-plugins.ts', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../core/plugin-control-client.service.ts', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../../styles.scss', import.meta.url), 'utf8');

test('Catalog, Registry Connections, and Trust are separate management surfaces', () => {
  for (const view of ['catalog', 'registry-connections', 'trust']) {
    assert.match(page, new RegExp(`activeView\\(\\) === '${view}'`));
    assert.match(page, new RegExp(`id: '${view}'`));
  }
  assert.match(page, /\[routerLink\]="'\/manage\/extensions\/' \+ view\.id"/);
  assert.match(page, /class="extension-view-navigation"/);
  assert.match(page, /\[attr\.aria-current\]="activeView\(\) === view\.id \? 'page' : null"/);
  assert.match(page, /Registry Connections/);
  assert.match(page, /Trust & Revocation/);
  assert.match(
    page,
    /@if \(activeView\(\) !== 'registry-connections' && activeView\(\) !== 'trust'\) \{\s*<clr-tabs class="extension-content-tabs">/,
    'Registry Connections와 Trust 경로에서는 이전 Clarity tab 본문을 제거해야 한다',
  );
  assert.doesNotMatch(page, /<nav class="btn-group"/);
  assert.doesNotMatch(page, /clrAccordionTitle>관리 작업/);
});

test('all Extension management views share one route navigation and readable page heading', () => {
  for (const view of ['subshells', 'plugins', 'topology', 'catalog', 'registry-connections', 'trust', 'audit', 'bindings']) {
    assert.match(page, new RegExp(`id: '${view}'`));
  }
  assert.match(page, /class="extension-view-heading"/);
  assert.match(page, /activeViewDefinition\(\)\.title/);
  assert.match(styles, /\.extension-content-tabs > \.nav \{ display: none; \}/);
  assert.match(page, /class="extension-empty-state"/);
});

test('Catalog presentation accepts only the normalized navigation icon token', () => {
  assert.match(page, /<os-nav-icon \[token\]="descriptor\.presentation\?\.iconRef \|\| 'application'"/);
  assert.doesNotMatch(page, /descriptor\.presentation\?\.(?:iconUrl|svg|html)/);
  assert.doesNotMatch(page, /<os-raw-icon[^>]*descriptor|descriptor[^\n]*bypassSecurityTrust|\[innerHTML\][^\n]*descriptor/);
});

test('Catalog selection never sends an Owner-managed artifact to the DUPA installer', () => {
  assert.match(page, /descriptor\.installation\.mode === 'dupa'/);
  assert.match(page, /설치 실행: \{\{ descriptor\.owner\.id \}\} Owner 경로 준비 필요/);
  assert.match(client, /x-os-idempotency-key/);
  assert.match(client, /crypto\.randomUUID\(\)/);
});

test('Registry connection and revocation destructive actions require exact confirmation', () => {
  assert.match(page, /REMOVE opensphere-ghcr/);
  assert.match(page, /REVOKE \$\{reference\}/);
  assert.match(client, /JSON\.stringify\(\{ reason, confirmation \}\)/);
  assert.match(client, /JSON\.stringify\(\{ image, replacementImage, reason, confirmation \}\)/);
  assert.match(client, /registry-connections\/opensphere-ghcr\/verify/);
  assert.doesNotMatch(client, /\/api\/admin\/extensions\/registry-credentials/);
});

test('Catalog does not expose the raw OCI installation escape hatch', () => {
  assert.doesNotMatch(page, /고급 OCI 설치|직접 참조 설치|advanced-install/);
});

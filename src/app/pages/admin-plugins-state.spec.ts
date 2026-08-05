import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./admin-plugins.ts', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../core/plugin-control-client.service.ts', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../app.routes.ts', import.meta.url), 'utf8');
const extensionHost = fs.readFileSync(new URL('../core/extension-host.service.ts', import.meta.url), 'utf8');
const shell = fs.readFileSync(new URL('../os/os-shell.ts', import.meta.url), 'utf8');

test('Extension operations separate user intent, serving state, and verification', () => {
  assert.match(source, /<span>서비스 중<\/span>/);
  assert.match(source, /<span>사용자 비활성<\/span>/);
  assert.match(source, /desiredStateLabel\(r\)/);
  assert.match(source, /verificationGate\(r\)/);
  assert.match(source, /label: phase === 'Failed' \? '서비스 차단'/);
  assert.match(source, /this\.menuState\(r\)\.visible/);
  assert.match(source, /this\.effectiveState\(registration\)\.tone === 'danger'/);
});

test('Enabled registrations never present Enable as their primary lifecycle action', () => {
  assert.match(source, /@if \(r\.desiredState === 'Enabled'\)/);
  assert.match(source, /검증 다시 시도/);
  assert.match(source, /명시적 비활성 요청 없음/);
});

test('an unavailable control projection is unknown or stale, never a false zero', () => {
  assert.match(source, /return '—'/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /마지막 정상 값을 유지합니다/);
  assert.match(client, /ExtensionProjectionStatus/);
  assert.match(client, /catalogSnapshot/);
  assert.match(client, /registrationsSnapshot/);
});

test('PFSS child plugins keep their host ownership across routes and navigation', () => {
  assert.match(routes, /path: 'p\/opensearch', redirectTo: 'pfss\/opensearch'/);
  assert.match(routes, /path: 'p\/foundation\/opensearch', redirectTo: 'pfss\/opensearch'/);
  assert.match(routes, /matcher: pfssHostMatcher, component: PluginHost, data: \{ pluginId: 'foundation' \}/);
  assert.match(extensionHost, /hostRef: String\(item\['hostRef'\] \|\| 'main'\)/);
  assert.match(shell, /if \(\(item\.hostRef \|\| 'main'\) !== 'main'\) continue/);
  assert.match(source, /if \(hostRef === 'foundation'\) return `\/pfss\/\$\{r\.name\}`/);
});

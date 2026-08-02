import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./admin-plugins.ts', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../core/plugin-control-client.service.ts', import.meta.url), 'utf8');

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

test('Extension management separates first-level subShells from host-owned plugins', () => {
  assert.match(source, /SubShell 관리/);
  assert.match(source, /Plugin 관리/);
  assert.match(source, /subShellRegistrations\(\)/);
  assert.match(source, /pluginHostGroups\(\)/);
  assert.match(source, /group\.hostRef/);
  assert.match(source, /plugin은 1단 메뉴 객체가 아닙니다/);
  assert.doesNotMatch(source, /@for \(r of registrations\(\); track r\.name\)/);
});

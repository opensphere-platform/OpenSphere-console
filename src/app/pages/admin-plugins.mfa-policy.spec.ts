import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'admin-plugins.ts'), 'utf8');

test('Extension 설치 안내는 개발 local edge MFA 예외의 좁은 범위를 설명한다', () => {
  assert.ok(source.includes('개발용 local edge의 설치·업데이트는 MFA를 생략'));
  assert.ok(source.includes('다른 환경과 다른 lifecycle 작업은 최근 MFA를 요구'));
  assert.ok(source.includes('사유는 항상 8자 이상 필요'));
});
test('Extension 설치 버튼은 입력 signal과 요청 진행 상태에 반응한다', () => {
  assert.ok(source.includes("readonly extensionInstallImage = signal('')"));
  assert.ok(source.includes("readonly extensionInstallReason = signal('')"));
  assert.ok(source.includes('(input)="extensionInstallImage.set($any($event.target).value)"'));
  assert.ok(source.includes('(input)="extensionInstallReason.set($any($event.target).value)"'));
  assert.ok(source.includes('[disabled]="installing() || !extensionInstallImage().trim()'));
});

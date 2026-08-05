import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'admin-plugins.ts'), 'utf8');

test('Extension 설치 안내가 개발 local edge MFA 예외의 좁은 범위를 설명한다', () => {
  assert.ok(source.includes('개발용 local edge에서는 설치·업데이트 MFA를 생략'));
  assert.ok(source.includes('그 외 환경과 다른 lifecycle 작업에는 MFA를 적용'));
  assert.ok(source.includes('사유는 항상 8자 이상 필요'));
});

test('Extension 설치 폼은 signal 기반 상태로 입력과 버튼 활성화를 연결한다', () => {
  assert.ok(source.includes("readonly extensionInstallImage = signal('')"));
  assert.ok(source.includes("readonly extensionInstallReason = signal('')"));
  assert.ok(source.includes('(input)="extensionInstallImage.set($any($event.target).value)"'));
  assert.ok(source.includes('(input)="extensionInstallReason.set($any($event.target).value)"'));
  assert.ok(source.includes('[disabled]="!extensionInstallImage().trim() || extensionInstallReason().trim().length < 8"'));
});

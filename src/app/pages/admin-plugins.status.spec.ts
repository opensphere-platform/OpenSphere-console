import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 회귀 계약: Registration phase=Activated를 페이지 서비스 완료로 오인시키지 않는다.
// Admin은 desired state/artifact/workload/page service와 integration을 독립적으로 확인해야 한다.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'admin-plugins.ts'), 'utf8');

test('Extension 상세가 네 진실 계층과 integration matrix를 제공한다', () => {
  for (const label of ['사용자 설정', 'Artifact 검증', '워크로드', '페이지 서비스']) {
    assert.ok(source.includes(label), `${label} 계층이 필요하다`);
  }
  assert.ok(source.includes('Console 연동 상태'));
  assert.ok(source.includes('integrationRows(r)'));
});

test('Activated와 메뉴 미노출을 동시에 명시할 수 있다', () => {
  assert.ok(source.includes("return { visible: false, label: '메뉴 미노출'"));
  assert.ok(source.includes("label: 'UI 활성화 실패'"));
  assert.ok(source.includes('메뉴 미노출'));
  assert.ok(source.includes('menuState(r)'));
});

test('Artifact 검증 단계가 navigation 노출을 성공으로 단정하지 않는다', () => {
  assert.ok(source.includes("{ label: 'Console 레지스트리 등록' }"));
  assert.ok(!source.includes('레지스트리 등록 · nav 노출'));
});

test('고위험 관리 폼과 대형 아이콘 선택기는 기본 정보 흐름에서 접힌다', () => {
  assert.ok(source.includes('<clr-accordion-title>관리 작업</clr-accordion-title>'));
  assert.ok(source.includes('<clr-accordion-title>메뉴 아이콘</clr-accordion-title>'));
});

test('상세 패널 제목이 Extension 이름·종류·ID·버전을 명시한다', () => {
  assert.ok(source.includes('[title]="selectedPanelTitle()"'));
  assert.ok(source.includes('[subtitle]="selectedPanelSubtitle()"'));
  assert.ok(source.includes('`${this.selectedLabel()} — Extension 상세`'));
  assert.ok(source.includes("item?.kind || 'Extension'"));
});

test('Installed 목록과 상세 패널이 artifact 및 Console API 설치 provenance를 함께 제공한다', () => {
  for (const text of ['Artifact · 설치', 'currentDigest', 'installationTime(r)', 'installationActor(r)', '설치 경로', '작업 ID']) {
    assert.ok(source.includes(text), `${text} 설치 근거가 필요하다`);
  }
  assert.ok(source.includes('Extension 설치'));
  assert.ok(source.includes('installExtension('));
  assert.ok(source.includes('검사 후 설치'));
  assert.ok(source.includes('os extensions install'));
});

test('권한 프로파일 드리프트를 관리자가 이해할 수 있는 문장으로 설명한다', () => {
  assert.ok(source.includes("PermissionProfileDrift: 'DUPA가 요구하는 고정 RBAC 권한 프로파일과 설치된 ClusterRole 규칙이 다름'"));
});

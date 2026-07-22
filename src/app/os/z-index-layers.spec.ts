import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 회귀 계약: 검색 드롭다운이 열렸을 때 datagrid 헤더(예: '설명 / 멤버' 그레이 행)가 그 위로
// 새어나오는 레이어링 버그(§console-search-layering) 재발 방지.
//
// 이 스펙은 실제 렌더 트리 대신 소스(styles.scss + os-shell/os-search/os-panel/
// os-notifications/os-oaa-agent)를 정적으로 검사한다 — 이 저장소의 테스트 러너(node --test)에는
// Angular TestBed/브라우저 레이아웃 엔진이 없기 때문. 계약이 검증하는 불변식:
//   1) 전역 z-index 레이어 스케일 토큰(--os-z-*)이 styles.scss :root에 오름차순으로 존재한다.
//   2) os-shell.ts .header가 position:relative + z-index:var(--os-z-header)로
//      자체 stacking context를 형성한다(수정 전에는 z-index가 아예 없었다 — 버그의 근본 원인).
//   3) 헤더 레이어가 OAA·패널그립·알림 위, skip-link 아래에 위치한다.
//   4) 각 전역 오버레이 컴포넌트가 매직넘버가 아니라 공유 토큰을 참조한다.
//
// 수정 전 상태에서는 (2)가 거짓이라 이 스펙은 실패했다.

const here = path.dirname(fileURLToPath(import.meta.url));
const consoleRoot = path.resolve(here, '../../..'); // src/app/os -> console root

function read(rel: string): string {
  return readFileSync(path.join(consoleRoot, rel), 'utf8');
}

const stylesScss = read('src/styles.scss');
const osShellTs = read('src/app/os/os-shell.ts');
const osSearchTs = read('src/app/os/os-search.ts');
const osPanelTs = read('src/app/os/os-panel.ts');
const osNotificationsTs = read('src/app/os/os-notifications.ts');
const osOaaAgentTs = read('src/app/os/os-oaa-agent.ts');

function tokenValue(css: string, name: string): number {
  const m = css.match(new RegExp(`--${name}:\\s*(\\d+);`));
  assert.ok(m, `styles.scss :root must define --${name} as a plain numeric z-index token`);
  return Number(m![1]);
}

test('z-index 레이어 스케일 토큰이 :root에 정의되어 있다', () => {
  const rootBlock = stylesScss.slice(stylesScss.indexOf(':root'), stylesScss.indexOf('\n}\n', stylesScss.indexOf(':root')));
  for (const name of ['os-z-oaa', 'os-z-panel-grip', 'os-z-notifications', 'os-z-header', 'os-z-skip-link']) {
    assert.ok(rootBlock.includes(`--${name}:`), `:root must declare --${name}`);
  }
});

test('레이어 순서 불변식: OAA < 패널그립 < 알림 < 헤더 < skip-link', () => {
  const oaa = tokenValue(stylesScss, 'os-z-oaa');
  const grip = tokenValue(stylesScss, 'os-z-panel-grip');
  const notif = tokenValue(stylesScss, 'os-z-notifications');
  const header = tokenValue(stylesScss, 'os-z-header');
  const skip = tokenValue(stylesScss, 'os-z-skip-link');

  assert.ok(oaa < grip, `OAA(${oaa}) < 패널그립(${grip})`);
  assert.ok(grip < notif, `패널그립(${grip}) < 알림(${notif})`);
  assert.ok(notif < header, `알림(${notif}) < 헤더(${header}) — 헤더/검색이 알림 토스트 위에 있어야 한다`);
  assert.ok(header < skip, `헤더(${header}) < skip-link(${skip}) — 접근성 skip-link는 항상 최상위`);
});

test('os-shell .header가 position:relative + z-index:var(--os-z-header)로 자체 stacking context를 형성한다', () => {
  const headerRule = osShellTs.slice(osShellTs.indexOf('.header {'), osShellTs.indexOf('.header {') + 400);
  assert.match(
    headerRule,
    /position:\s*relative;/,
    '.header는 position:relative여야 한다(절대중앙 검색의 containing block)',
  );
  assert.match(
    headerRule,
    /z-index:\s*var\(--os-z-header\);/,
    '.header에 z-index:var(--os-z-header)가 없으면 헤더가 stacking context를 형성하지 못해 ' +
      'datagrid sticky 헤더 등 콘텐츠 요소가 검색 드롭다운 위로 새어나올 수 있다(레이어링 회귀).',
  );
});

test('os-shell .os-skip-link는 공유 skip-link 토큰을 쓰고, 여전히 헤더보다 위다', () => {
  assert.match(osShellTs, /\.os-skip-link\s*\{[^}]*z-index:\s*var\(--os-z-skip-link\);/s);
});

test('전역 오버레이 컴포넌트(패널그립·알림·OAA)가 공유 레이어 토큰을 참조한다(매직넘버 금지)', () => {
  assert.match(
    osPanelTs,
    /\.os-panel-grip\s*\{[^}]*z-index:\s*var\(--os-z-panel-grip/s,
    'os-panel 그립은 var(--os-z-panel-grip)을 참조해야 한다',
  );
  assert.match(
    osNotificationsTs,
    /\.os-toast-stack\s*\{[^}]*z-index:\s*var\(--os-z-notifications/s,
    'os-notifications 토스트는 var(--os-z-notifications)를 참조해야 한다',
  );
  assert.match(
    osOaaAgentTs,
    /\.oaa-panel\s*\{[^}]*z-index:\s*var\(--os-z-oaa/s,
    'os-oaa-agent 도킹 패널은 var(--os-z-oaa)를 참조해야 한다',
  );
});

test('os-search 드롭다운은 헤더 stacking context에 포함되어 있고, 자체 z-index가 헤더보다 낮은 값으로도 안전하다', () => {
  // 드롭다운의 로컬 z-index(1001)는 문서 전체가 아니라 .header가 형성한 stacking context 내부
  // 순서일 뿐임을 문서화한다 — 이 계약이 os-shell의 .header z-index 존재에 의존함을 명시.
  assert.match(osSearchTs, /\.os-search-drop\s*\{[^}]*z-index:\s*1001;/s);
  assert.match(
    osSearchTs,
    /header가 var\(--os-z-header\)로 자체 stacking context를 형성/,
    '드롭다운 로컬 z-index가 안전한 이유(헤더가 stacking context를 형성해 캡핑됨)가 주석으로 설명되어 있어야 한다',
  );
});

test('Clarity side panel 제목은 전역 헤더 아래에서 시작해 가려지지 않는다', () => {
  assert.match(stylesScss, /--os-header-height:\s*3rem;/);
  assert.match(osShellTs, /height:\s*var\(--os-header-height\);/);
  assert.match(
    osPanelTs,
    /clr-side-panel\.side-panel \.modal:not\(\.modal-full-screen\)[\s\S]*top:\s*var\(--os-header-height,\s*3rem\);[\s\S]*height:\s*calc\(100vh\s*-\s*var\(--os-header-height,\s*3rem\)\)\s*!important;/,
    '내부 dialog가 아니라 Clarity의 fixed modal 레이어 전체가 헤더 아래에서 시작해야 한다',
  );
  assert.match(
    osPanelTs,
    /\.os-panel-grip\s*\{[\s\S]*top:\s*var\(--os-header-height,\s*3rem\);/,
    '폭 조절 그립도 패널과 같은 상단 경계를 사용해야 한다',
  );
  assert.doesNotMatch(
    osPanelTs,
    /clr-side-panel\.side-panel \.modal-dialog\s*\{[\s\S]{0,180}top:\s*var\(--os-header-height/,
    '내부 dialog의 상대 위치 보정으로 회귀하면 Clarity flex 레이아웃에서 제목이 다시 가려질 수 있다',
  );
});

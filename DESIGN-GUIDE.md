# OpenSphere UI System Design Guide

Status: **최상위 디자인 정책 · 필수 준수**  
Applies to: Main Shell(Console), Angular subShell, vanilla-JS plugin, 공통 UI SDK  
Authority: 이 문서는 OpenSphere UI 시스템의 단일 디자인 정본(SSOT)이다.

이 문서는 과거의 `DESIGN-RULES.md`, `docs/DESIGN-TOKENS.md`,
`docs/dupa-nav-contribution-contract.md`를 전부 흡수하고 대체한다. 다른 문서나 코드 주석이
충돌하면 이 문서가 우선한다.

## 1. 목적과 불변 원칙

1. Main Shell과 Angular subShell의 상호작용 컴포넌트는 **Clarity Design System v18**을 사용한다.
2. Clarity가 제공하는 컴포넌트를 임의 HTML, 자작 CSS, 다른 UI 프레임워크로 다시 만들지 않는다.
3. `os-*` 퍼사드는 Clarity를 감싸 API를 안정화할 수 있지만 Clarity의 구조·접근성·동작을 대체할 수 없다.
4. Clarity에 기능이 없을 때만 예외를 제안할 수 있다. 예외는 구현 전에 사용자 승인을 받고 §8에 등록한다.
5. **Carbon 아이콘은 승인된 요소**다. 아이콘 이외의 Carbon UI 컴포넌트 사용을 의미하지 않는다.
6. 제품·서비스 로고는 **OpenSphere Logos**(`https://logos.opl.io.kr/`)를 정본으로 사용한다.
7. 색, 타이포, 간격, 기하는 토큰으로만 바꾼다. Clarity 컴포넌트 DOM 구조를 스타일로 재구축하지 않는다.
8. 새 UI 컴포넌트, 외부 시각 라이브러리, 로고 fallback, 예외는 사용자가 선택할 수 있도록 구현 전에
   후보·근거·영향을 보고하고 승인을 받는다.

`MUST`, `MUST NOT`, `SHOULD`, `MAY`는 각각 필수, 금지, 강한 권고, 선택을 의미한다.

## 2. 정책 계층과 적용 단위

| 계층 | 허용 구현 | 의무 |
|---|---|---|
| Main Shell(Console) | Angular + `@clr/angular` v18 | Clarity Angular 컴포넌트 직접 사용 또는 Clarity 기반 `os-*` 퍼사드 |
| Angular subShell | Angular + `@clr/angular` v18 | Clarity 컴포넌트 직접 사용, Shell 토큰 상속 |
| vanilla-JS plugin | ESM Custom Element(light DOM) | Shell이 제공하는 Clarity v18 CSS 클래스와 `--os-*` 토큰 사용 |
| 도메인 페이지 | Angular 조합 컴포넌트 | 도메인 데이터·레이아웃만 소유하고 UI primitive는 Clarity에 위임 |
| 공통 퍼사드 | `os-*` | Clarity API 절연·공통 정책 적용만 담당; 자작 대체물 금지 |

동적 plugin은 Angular 런타임 결합을 피하므로 “모든 element가 Angular Clarity 컴포넌트”라는 문장을
그대로 적용하지 않는다. 대신 Clarity가 정의한 구조·클래스·토큰·접근성 규칙을 준수해야 한다.

## 3. 승인된 기술 스택

| 영역 | 정책 |
|---|---|
| Framework | Angular 22 |
| UI components | `@clr/angular` major 18 |
| UI CSS | `@clr/ui` major 18, Angular 패키지와 같은 release line |
| Icons | Carbon Icons 승인. Shell과 Consumer가 동일한 token 계약 사용 |
| Typography | IBM Plex Sans, IBM Plex Sans KR, IBM Plex Mono |
| Logos | `logos.opl.io.kr` resolver/shortcut이 반환하는 SVG |

- `package.json`과 lockfile은 Clarity major 18을 벗어나면 안 된다.
- Clarity major 변경은 별도 아키텍처 검토와 사용자 승인이 필요하다.
- `@cds/core`는 Clarity v18의 자동 허용 항목이 아니다. 기존 의존성의 유지·제거는 별도 승인 대상으로
  두며, 새 컴포넌트가 이를 직접 소비하려면 예외 승인을 받아야 한다.
- 승인된 Carbon 사용 범위는 아이콘과 시각 규율이다. Carbon Button, Modal, Datagrid 등 UI 컴포넌트는
  Clarity 대체물이 있으므로 사용할 수 없다.

## 4. 컴포넌트 선택 정책

UI 요구가 생기면 다음 순서를 지킨다.

1. Clarity v18 컴포넌트 목록에서 동일 기능을 찾는다.
2. 있으면 Clarity Angular 컴포넌트를 사용한다.
3. 반복 사용이 필요하면 Clarity 골격을 보존한 `os-*` 퍼사드를 만든다.
4. Clarity에 기능이 없으면 요구·조사 결과·대안·접근성·번들 영향을 사용자에게 보고한다.
5. 승인을 받은 뒤에만 §8 예외 등록과 `[예외 등록 #n]` 코드 주석을 추가하고 구현한다.

### 4.1 필수 매핑

| UI 요구 | 필수 Clarity 구현 |
|---|---|
| 알림·오류·상태 메시지 | `clr-alert`, `clr-alerts` |
| 메뉴·팝오버 액션 | `clr-dropdown` |
| 상세 우측 슬라이딩 화면 | `clr-side-panel` 또는 이를 감싼 `os-panel` |
| 표·정렬·필터·페이지네이션 | `clr-datagrid` |
| 입력·검증 | `clrForm`, `clr-*-container`, 해당 Clarity directive |
| 모달 확인·편집 | `clr-modal` |
| 계층 내비게이션 | `clr-vertical-nav` 및 §7 표준 |
| 탭·스텝·접기 | 해당 Clarity Tabs, Stepper, Accordion |
| 버튼·버튼 그룹 | Clarity button class/component |
| 카드·레이블·배지 | Clarity Card, Label, Badge |
| 도움말·문맥 정보 | Clarity Tooltip 또는 Signpost |
| 로딩 | Clarity Spinner 또는 Progress |

Clarity가 제공하는 기능에 자작 backdrop, focus trap, ESC 처리, popup positioning, close button을 추가로
구현하지 않는다. Clarity 컴포넌트가 그 동작을 소유해야 한다.

### 4.2 퍼사드 규칙

- 페이지는 공통 `os-*` 퍼사드와 필요한 Clarity 컴포넌트를 사용할 수 있다.
- 퍼사드는 입력·출력 정규화, 공통 문구, 로깅, 권한 게이트, 프로젝트 토큰 적용을 담당한다.
- 퍼사드 내부의 골격은 Clarity여야 한다.
- Clarity component DOM을 `::ng-deep`로 재배치하거나 접근성 속성을 약화하지 않는다.
- 동적 값 바인딩(`[style.*]`)은 기능상 불가피하고 등록된 예외일 때만 허용한다.

## 5. Brand, Logo, Icon 정책

### 5.1 로고

모든 제품·서비스 로고는 OpenSphere Logos의 기계용 API를 먼저 사용한다.

```text
GET https://logos.opl.io.kr/api/resolve?q={query}&variant={default|icon|wordmark}
GET https://logos.opl.io.kr/i/{shortname}
```

- 기본 화면은 `https://logos.opl.io.kr/i/{shortname}` shortcut을 사용한다.
- 검색·선정 도구는 `/api/resolve`의 `match.confidence`, `file.role`, `url`을 사용한다.
- 아이콘형 공간에는 `variant=icon`, 브랜드 타이틀에는 `variant=wordmark`를 우선한다.
- 로고 크기는 CSS width/height로 정하고 CDN URL에 크기를 인코딩하지 않는다.
- 임의 검색 결과, 비공식 CDN, 저장소 복사본, base64 로고를 새로 추가하지 않는다.
- 일치하는 로고가 없으면 유사한 다른 제품 로고를 쓰지 않는다. 카탈로그 등록을 요청하거나 사용자의
  명시적 승인을 받아 프로젝트 고유 fallback을 예외로 등록한다.
- 일러스트레이션, 데이터 시각화, 사용자 업로드 이미지는 이 로고 정책의 대상이 아니다.

승인된 현재 shortname:

| 대상 | shortname |
|---|---|
| OpenSphere/Triangles | `triangles` |
| PostgreSQL | `postgresql` |
| RustFS | `rustfs` |
| Gitea | `gitea` |

### 5.2 Carbon 아이콘

- Carbon 아이콘은 메뉴, 액션, 상태 보조 표현에 사용할 수 있다.
- 아이콘만으로 의미를 전달하는 버튼에는 접근 가능한 이름을 제공한다.
- plugin의 `spec.nav.icon`은 Shell이 승인한 Carbon token 계약을 따른다.
- 제품 로고를 Carbon 아이콘으로 대체하지 않는다.
- Carbon 아이콘 사용은 Carbon UI 컴포넌트 사용 권한으로 확장되지 않는다.

## 6. 토큰과 시각 규율

### 6.1 색상

| 토큰 | 값 | 용도 |
|---|---|---|
| `--os-accent` | `#4c6fff` | 링크, primary action, focus, 선택 강조 |
| `--os-accent-hover` | `#3a5af0` | hover |
| `--os-accent-pressed` | `#2f49c8` | pressed |
| `--os-accent-subtle` | `rgba(76,111,255,.12)` | 선택·hover 배경 |
| `--os-canvas` | `#ffffff` | 기본 페이지 |
| `--os-surface-1` | `#f4f4f4` | 입력·교차행·옅은 섹션 |
| `--os-surface-2` | `#e0e0e0` | disabled·구분 fill |
| `--os-hairline` | `#e0e0e0` | 1px 구분선 |
| `--os-header-bg` | `#161616` | 상단 헤더 |
| `--os-header-ink` | `#c6c6c6` | 헤더 텍스트 |
| `--os-nav-bg` | `#ffffff` | 좌측 내비 |
| `--os-nav-hover` | `#e8e8e8` | 내비 hover/active |
| `--os-ink` | `#161616` | 제목·본문 강조 |
| `--os-ink-muted` | `#525252` | 2차 텍스트 |
| `--os-ink-subtle` | `#8c8c8c` | caption·helper |
| `--os-success` | `#24a148` | 성공 |
| `--os-warning` | `#f1c21b` | 경고 |
| `--os-error` | `#da1e28` | 오류 |
| `--os-info` | `#4c6fff` | 정보 |

액센트는 희소하게 사용한다. 카드 배경과 장식용 제목에는 쓰지 않는다. 색은 상태의 유일한 전달 수단이
되어서는 안 된다. 커스텀 클래스는 하드코딩 색 대신 `--clr-*` 또는 `--os-*` 토큰을 참조한다.

### 6.2 타이포그래피

| 토큰 | size / weight / line-height / tracking | 용도 |
|---|---|---|
| `--os-type-display` | 42px / 300 / 1.2 / 0 | 히어로 제목 |
| `--os-type-headline` | 32px / 400 / 1.25 / 0 | 섹션 제목 |
| `--os-type-title` | 20px / 600 / 1.4 / 0 | 카드·패널 제목 |
| `--os-type-body` | 14px / 400 / 1.43 / 0.16px | 본문 |
| `--os-type-body-strong` | 14px / 600 / 1.43 / 0.16px | 강조·선택 탭 |
| `--os-type-caption` | 12px / 400 / 1.33 / 0.32px | 메타·유틸 |

폰트는 IBM Plex Sans, IBM Plex Sans KR, IBM Plex Mono로 통일한다. display는 weight 300, body는
weight 400과 0.16px tracking을 기본으로 한다.

### 6.3 간격·기하·계층

- 4px grid: `--os-2`=4, `--os-3`=8, `--os-4`=12, `--os-5`=16,
  `--os-6`=24, `--os-7`=32, `--os-8`=48.
- 기본 radius는 `--os-radius`=4px, 작은 요소는 2px, pill은 상태 칩에만 허용한다.
- 평면 표면은 그림자를 사용하지 않는다. hairline과 surface 차이로 계층을 만든다.
- 그림자는 modal, menu, dropdown, side panel 같은 실제 overlay에만 허용한다.
- Clarity 변수는 `styles.scss`에서 `--os-*` 토큰으로 매핑한다. 개별 페이지에서 테마를 재정의하지 않는다.

## 7. Shell, subShell, plugin 내비게이션 계약

### 7.1 Outer Perspective Rail

plugin은 `page:register` 권한으로 Shell의 외부 Perspective Rail에 진입점을 기여한다.

```ts
interface PluginPage {
  id: string;
  title: string;
  navBand: 'operations' | 'build' | 'delivery';
  elementTag: string;
}
```

```js
export function activate(ctx) {
  customElements.define('osp-my-perspective', MyPerspectiveElement);
  ctx.extensions.registerPage({
    id: ctx.pluginId,
    title: 'My Perspective',
    navBand: 'operations',
    elementTag: 'osp-my-perspective',
  });
}
```

Shell은 등록된 `elementTag`를 host하고 plugin이 해당 view를 소유한다. 미등록 Consumer의 메뉴를
Main Shell에 미리 만들지 않는다.

### 7.2 Inner Tree Nav

- Angular subShell은 `<clr-vertical-nav>`를 직접 사용한다.
- vanilla-JS plugin은 표준 `<osp-tree-nav>`만 사용한다.
- 동적 다단계 메뉴를 Shell에 기여할 때만 `nav:contribute` 권한을 추가한다.

```ts
interface NavNode {
  id: string;
  label: string;
  route?: string;
  children?: NavNode[];
}

ctx.extensions.nav.contribute(tree);
ctx.extensions.nav.clear();
```

`<osp-tree-nav>` API:

```js
const nav = document.querySelector('osp-tree-nav');
nav.items = [
  { id: 'overview', label: '개요' },
  {
    id: 'workloads',
    label: 'Workloads',
    children: [
      { id: 'pods', label: 'Pods' },
      { id: 'deployments', label: 'Deployments' },
    ],
  },
];
nav.activeId = 'pods';
nav.addEventListener('osp-nav-select', (event) => select(event.detail.id));
```

표준 component는 Clarity vertical-nav light DOM 구조를 출력하고 Shell의 `@clr/ui` CSS를 사용한다.
그룹은 최초 설정 시 펼쳐지며, 구현은 `customElements.get('osp-tree-nav')` 중복 정의 가드를 둔다.

금지 패턴:

- `osp-nav-child`, `osp-nav-caret`, `osp-nav-group`, `osp-nav-indent`, `class="osp-nav"`
- `os-tree`, `os-tnode`, `os-tcaret`, `os-sidebar`, `os-navlink`, `fnode`
- plugin 전용 navigation 색·구조를 복제하는 style
- plugin 소스의 하드코딩 hex 색상

## 8. 승인된 예외 등록부

| # | 위치·범위 | 승인 내용 | Clarity 부재 또는 제한 |
|---|---|---|---|
| 1 | `os-panel.ts` resize grip | Side Panel 연속 폭 조절과 session 폭 기억 | `clr-side-panel`은 preset size만 제공. dialog, ESC, backdrop, close는 Clarity에 위임 |
| 2 | `apis.ts` code block | OpenAPI 원문 표시 | Clarity에 syntax/code viewer 없음 |
| 3 | `styles.scss` `.os-band-label` | 비접이식 Perspective band label | 접이식 `clr-vertical-nav-group`과 의미가 다름 |
| 4 | `.os-sub`, `.os-kv`, `.os-mono`, `.os-dim` 등 | 보조 문구·식별자·열폭용 token utility | Clarity에 해당 의미 utility 없음; 구조 컴포넌트로 사용 금지 |
| 5 | Shell branding typography | 브랜드 wordmark 조합 | Clarity Header 골격은 유지하고 브랜드 표현만 보강 |
| 6 | Carbon Icons | 메뉴·액션·상태 아이콘 | 사용자 승인 요소. Carbon UI component는 제외 |
| 7 | `CodeEditorComponent` | CodeMirror 기반 YAML/code 편집·표시 | Clarity에 code editor 없음 |
| 8 | `BackboneGraph` | Foblex 기반 topology graph, drag, zoom | Clarity에 topology canvas 없음 |

도메인 데이터 변환, API adapter, Extension Host, router page는 시각 primitive가 아니므로 예외 등록 대상이
아니다. 반대로 자작 dropdown, alert/toast, modal, datagrid, form, side panel, tooltip은 Clarity 대체물이
있으므로 예외가 될 수 없다.

## 9. 접근성·반응형·상태 정책

- Clarity가 제공하는 keyboard navigation, focus management, ESC, ARIA를 제거하거나 복제하지 않는다.
- icon-only action은 `aria-label` 또는 동등한 접근 가능한 이름을 가져야 한다.
- 색상과 아이콘만으로 상태를 전달하지 않고 텍스트를 함께 제공한다.
- 200% zoom과 keyboard-only 경로에서 핵심 기능이 유지되어야 한다.
- loading, empty, error, forbidden, degraded 상태를 각각 구분한다.
- Backbone이나 감사 저장소의 비정상 상태를 단순 empty state로 숨기지 않는다.
- 작은 viewport에서도 Main Shell navigation, dialog close, primary action에 접근할 수 있어야 한다.

## 10. 변경 승인과 검증 게이트

### 10.1 사전 승인

다음 변경은 구현 전에 사용자 승인이 필요하다.

- 새 UI component 또는 외부 UI dependency
- Clarity component 대신 자작 구현
- Carbon Icons 이외의 icon system
- OpenSphere Logos 이외의 제품 로고 공급원 또는 fallback
- token 값, font, navigation 구조, 예외 등록 변경
- Clarity major 또는 Angular major 변경

승인 요청에는 요구 기능, Clarity 후보, 선택 이유, 대안, 접근성, 번들·운영 영향이 포함되어야 한다.

### 10.2 자동·수동 검증

필수 검증:

1. unit 및 contract test
2. production build
3. Clarity major·peer dependency 검사
4. 금지된 자작 primitive와 inline style 검사
5. 접근성 이름·keyboard·focus 검증
6. 실제 브라우저 시각 검증
7. 배포 후 readiness, console error, network error 확인

기본 정적 검사 예시:

```powershell
rg -n 'style="' src/app
rg -n '#[0-9a-fA-F]{3,8}' src/app
rg -n 'os-(notif-panel|toast|modal|dropdown|table)' src/app
rg -n 'DESIGN-RULES\.md|DESIGN-TOKENS\.md|dupa-nav-contribution-contract\.md' .
```

검출 결과는 Clarity 구현, token 정의, 또는 §8 예외 중 하나로 설명되어야 한다. 검사가 통과해도 실제
브라우저에서 레이아웃, focus, overlay, deep-link를 확인하지 않으면 완료로 판정하지 않는다.

## 11. 유지관리

- 이 문서만 디자인 정책의 정본으로 유지한다. 별도의 하위 디자인 규칙·토큰·내비 계약 문서를 만들지 않는다.
- 세부 예시도 이 문서의 해당 절에 추가한다.
- Clarity release나 Logo API가 바뀌면 먼저 영향 분석과 승인 후 이 문서를 갱신한다.
- 예외는 영구 권리가 아니다. Clarity가 대응 기능을 제공하면 재검토하여 제거한다.
- 구현과 문서가 다르면 구현을 정당화하지 않고 위반 또는 문서 변경 승인 대상으로 보고한다.

## 12. 공식 참조

- Clarity Design System: https://clarity.design/
- OpenSphere Logos agent guide: https://logos.opl.io.kr/llms.txt
- OpenSphere Logos OpenAPI: https://logos.opl.io.kr/openapi.json
- Shell hosting integration constitution:
  `../_DOCS_/01-CONSTITUTION/CONSTITUTION-0003-SHELL-HOSTING-INTEGRATION.md`


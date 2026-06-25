# DUPA Nav Contribution Contract

> 참조: `opensphere-console/src/app/core/extension-host.service.ts` — `ExtensionHostService`, `NavNode`, `PluginPage`.
> 디자인 규칙: [`opensphere-console/DESIGN-RULES.md §14`](../DESIGN-RULES.md#14-트리-메뉴-표준-tree-nav-standard).

플러그인이 셸 내비게이션에 기여하는 두 계층을 이 문서가 정의한다.

---

## 계층 1 — Outer Perspective-Rail (외부 메뉴)

좌측 세로 밴드(Perspective Rail)에 플러그인의 진입점을 등록한다.

### 권한

```json
{ "permissions": ["page:register"] }
```

매니페스트에 `page:register` 선언이 필수다. `nav:contribute`가 없어도 `page:register`만으로 Perspective Rail 진입점을 등록할 수 있다.

### API — `ctx.extensions.registerPage(p: PluginPage)`

```ts
interface PluginPage {
  id: string;       // 플러그인 고유 ID (registry entry id와 일치)
  title: string;    // Perspective Rail에 표시할 이름
  navBand: string;  // Rail 섹션 — 'operations' | 'build' | 'delivery' (os-band-label 클래스와 매핑)
  elementTag: string; // 커스텀 엘리먼트 태그명 (HTML Custom Element)
}
```

예시:

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

셸은 Perspective Rail 항목을 클릭하면 해당 `elementTag`를 DOM에 삽입한다. 플러그인은 뷰 전체를 소유한다.

---

## 계층 2 — Inner Tree-Nav (내부 트리 메뉴)

플러그인 뷰 내부의 좌측 트리 메뉴. 두 구현이 허용된다.

### 2-A. Angular subShell — `<clr-vertical-nav>` 컴포넌트

Angular 기반 subShell(foundation-shell, ai-shell, k8s-console-angular 등)은 `ng-clarity`의 `<clr-vertical-nav>` 컴포넌트를 직접 사용한다. Angular DI·변경 감지가 작동하는 컨텍스트이므로 컴포넌트 계층을 그대로 쓴다.

### 2-B. Vanilla-JS 플러그인 — `<osp-tree-nav>` 웹 컴포넌트

프레임워크 무의존 ESM 플러그인(Blob URL import)은 `deploy/perspectives/_osp-tree-nav.js`를 번들에 인라인해 `<osp-tree-nav>`를 사용한다. `generate.mjs`가 템플릿(`_plugin-template.js`)을 처리할 때 자동으로 인라인한다.

#### `nav:contribute` 권한 (선택)

동적·다단계 메뉴 트리를 셸 레이어에 기여해야 할 때(예: 런타임에 메뉴가 추가/삭제되고 셸이 그것을 알아야 할 때) `nav:contribute` 권한을 추가로 선언한다.

```json
{ "permissions": ["page:register", "nav:contribute"] }
```

이 권한이 있을 때 `ctx.extensions.nav`가 노출된다:

```ts
/** 재귀 내비 노드 — 임의 깊이 트리 */
interface NavNode {
  id: string;
  label: string;
  route?: string;   // 셸 라우트 또는 #해시 deep-link (예: /p/k8s-console#/c/main/nodes)
  children?: NavNode[];
}

// 기여 — 플러그인이 메뉴 트리를 셸에 등록
ctx.extensions.nav.contribute(tree: NavNode[]);

// 해제 — 플러그인이 deactivate() 시 정리
ctx.extensions.nav.clear();
```

`NavNode` 구조는 1:1 메뉴(children 없는 노드 1개)부터 다단계 트리까지 동일한 인터페이스로 표현한다.

---

## `<osp-tree-nav>` 상세 API

소스: `deploy/perspectives/_osp-tree-nav.js` (단일 구현 — 직접 수정 금지).

```js
// 항목 배열 세팅 (최초 1회 또는 데이터 갱신 시)
el.items = [
  { id: 'overview', label: '개요' },
  { id: 'workloads', label: 'Workloads',
    children: [
      { id: 'pods',        label: 'Pods' },
      { id: 'deployments', label: 'Deployments' },
    ]
  },
];

// 활성 항목 지정 (네비게이션 상태 동기화)
el.activeId = 'pods';

// 선택 이벤트
el.addEventListener('osp-nav-select', (e) => {
  const { id } = e.detail;
  // 해당 id에 맞는 콘텐츠를 렌더
});
```

**마크업**: 실제 Clarity vertical-nav HTML을 light DOM으로 방출한다 —
`.clr-vertical-nav` > `.nav-content` > (`.nav-group` | `.nav-link.nav-text`).
셸 전역 `@clr/ui/clr-ui.min.css`가 스타일링을 담당. 컴포넌트 자체에 색·hex 없음.

**초기 상태**: 최초 `items` 세팅 시 모든 그룹이 자동으로 펼쳐진다(Foundation 기본 동작과 동일).

**중복 정의 가드**: `customElements.get('osp-tree-nav')` 체크 포함 — 여러 플러그인이 같은 페이지에 로드되어도 안전하다.

---

## 금지 패턴

CI lint(`deploy/perspectives/lint-nav.mjs`)가 자동 검출.

- **수작업 nav 클래스**: `osp-nav-child`, `osp-nav-caret`, `osp-nav-group`, `osp-nav-indent`, `class="osp-nav"`, `os-tree`, `os-tnode`, `os-tcaret`, `os-sidebar`, `os-navlink`, `fnode`
- **하드코딩 hex 색**: `#rrggbb` / `#rgb` — 색은 반드시 Clarity 토큰(`--clr-*`, `--os-*`)으로

## 관련 파일

| 파일 | 역할 |
|---|---|
| `opensphere-console/DESIGN-RULES.md §14` | 디자인 규칙 원문 |
| `deploy/perspectives/_osp-tree-nav.js` | `<osp-tree-nav>` 표준 구현 (단일 소스) |
| `deploy/perspectives/_plugin-template.js` | vanilla 플러그인 소비 예시 (전체 패턴) |
| `opensphere-console/src/app/core/extension-host.service.ts` | `NavNode`, `PluginPage`, `nav:contribute` 런타임 구현 |
| `deploy/perspectives/lint-nav.mjs` | CI lint — 금지 패턴 자동 검출 |

# OpenSphere Console 디자인 규칙 (의무)

> 지시(보스, 2026-06-13): "반드시 Clarity 규칙 사용, component 사용해야 한다."
> 이 문서는 그 지시의 성문화이며, 모든 PR/페이지 추가의 게이트다.

## 규칙

1. **화면(pages/*)은 os-* 퍼사드와 Clarity만 사용한다.**
   `@clr/*` 직접 import는 퍼사드(os-*)와 페이지의 Clarity 컴포넌트 사용에만 허용,
   임의 HTML+자작 CSS로 UI를 만드는 것은 금지.
2. **퍼사드 내부 구현은 Clarity 우선.** 새 UI 요구가 오면 먼저
   [Clarity Design System](https://clarity.design) / ng-clarity 컴포넌트 목록에서 찾는다.
   레이아웃은 `clr-row`/`clr-col-*`, 카드는 `.card`, 알림은 `clr-alert`,
   폼은 `clr-*-container` + 디렉티브, 표는 `clr-datagrid`/`.table`.
3. **자작은 'Clarity 부재 증명' 후 예외 등록.** Clarity에 대응물이 없음을 확인한
   경우에만 자작하고, 아래 예외 등록부에 사유와 함께 기록한다.
   코드에는 `[예외 등록 #n]` 주석을 단다.
4. **인라인 스타일(`style="..."`) 금지.** 동적 값 바인딩(`[style.x]`)은 기능상
   불가피한 경우(예: 드래그 리사이즈)만 예외 등록부를 거친다.
5. **정체성은 토큰으로만.** 색·라운드·타이포 변경은 styles.scss의 CSS 변수
   재정의(Clarity 공식 테마 메커니즘)로 한다. 컴포넌트 구조를 덮어쓰지 않는다.
6. **동적 플러그인의 준수 단위는 컴포넌트가 아니라 클래스/토큰이다.**
   (정확한 표현 — 팀장 검토 ③ 반영) 셸 본체는 ng-clarity Angular 컴포넌트를
   의무 사용하지만, 런타임 플러그인은 Angular 결합을 피하기 위해 프레임워크
   무의존 ESM(light DOM)으로 만들고 **셸이 전역 제공하는 Clarity CSS 클래스와
   os-* 토큰 유틸을 준수**한다. "모든 element가 Clarity 컴포넌트"라는 표현은
   셸 본체에만 사용한다. 플러그인의 API 경로는 하드코딩 금지 —
   manifest의 `apiBase`를 셸이 `ctx.api.baseUrl`로 주입한 값만 사용한다.

## 예외 등록부

| # | 위치 | 내용 | Clarity 부재 증명 |
|---|---|---|---|
| 1 | `os-panel.ts` 그립 + `[style.--os-panel-w]` | 퀵뷰 폭 마우스 드래그 조절 + 폭 기억 (요구 R2·R7) | `clr-side-panel`의 size는 sm~full-screen 프리셋뿐, 연속 폭 조절 없음. 골격(ESC·backdrop·X·dialog 접근성)은 clr-side-panel에 위임하고 폭 변수 1개만 오버라이드 |
| 2 | `apis.ts` `.os-code` | OpenAPI definition 원문 코드 블록 | Clarity에 코드 블록/신택스 표시 컴포넌트 부재 |
| 3 | `styles.scss` `.os-band-label` | 내비 3밴드(운영/구축/전달) 비접이식 섹션 라벨 | `clr-vertical-nav-group`은 접이식 메뉴 그룹이라 용도 불일치 |
| 4 | 각 페이지 `.os-sub` `.os-engine` `.os-kv` `.os-mono` `.os-dim` 등 | 보조 텍스트 톤·표 열폭·식별자 모노스페이스·'예정' 흐림 — 토큰 레벨 표현 유틸 | Clarity는 muted 텍스트/모노 유틸 클래스를 제공하지 않음(타이포 자체는 Clarity 상속) |
| 5 | `os-shell.ts` `.os-logo` `.os-thin` `.os-user` | 헤더 브랜딩 글리프·워드마크 굵기·사용자 표시 | 브랜드 아이덴티티 영역 — Clarity 헤더 구조(.header/.branding) 위에 토큰만 적용 |

## §14 트리 메뉴 표준 (Tree-Nav Standard)

> 근거: 보스 지시 + 플랫폼 일관성 — 모든 Perspective 좌측 내비가 동일 Clarity vertical-nav 구조·토큰을 사용해야 한다.

### 두 가지 허용 구현

| 컨텍스트 | 구현 | 비고 |
|---|---|---|
| **Angular subShell** (foundation-shell, ai-shell, k8s-console-angular 등) | `<clr-vertical-nav>` Angular 컴포넌트 (`ng-clarity`) | Angular DI·스타일 캡슐화 있음 — 컴포넌트 직접 사용 |
| **vanilla-JS 플러그인** (ESM, light DOM) | `<osp-tree-nav>` 표준 웹 컴포넌트 | `deploy/perspectives/_osp-tree-nav.js` 를 플러그인 번들에 인라인 |

### `<osp-tree-nav>` API (vanilla 플러그인용)

```js
// 소스: deploy/perspectives/_osp-tree-nav.js (단일 구현 — 직접 수정 금지)
// 각 vanilla 플러그인은 이 파일을 번들에 인라인(generate.mjs가 자동 처리).

// 항목 세팅 — 최초 1회 또는 데이터 갱신 시
el.items = [
  { id: 'overview', label: '개요' },                          // 리프
  { id: 'workloads', label: 'Workloads',                     // 그룹
    children: [{ id: 'pods', label: 'Pods' }, ...] },
];

// 현재 활성 항목 지정
el.activeId = 'pods';

// 항목 선택 이벤트
el.addEventListener('osp-nav-select', (e) => {
  const { id } = e.detail; // 선택된 항목 id
});
```

**동작**: `<osp-tree-nav>`는 실제 Clarity vertical-nav 마크업(`.clr-vertical-nav` / `.nav-group` / `.nav-group-content` / `.nav-group-children` / `.nav-link` / `.nav-text`)을 light DOM으로 방출한다. 셸이 전역 로드한 `@clr/ui/clr-ui.min.css`가 스타일링을 담당하므로 Angular `<clr-vertical-nav>`와 시각·구조가 동일하다. 컴포넌트 자체는 색·hex·사설 클래스가 전혀 없으며, 동작 글루(그룹 펼침/접힘, 캐럿 회전)만 최소 CSS로 보강한다. 중복 정의 가드(`customElements.get('osp-tree-nav')`) 포함 — 여러 플러그인이 같은 페이지에 로드되어도 안전하다.

사용 예시 전체: `deploy/perspectives/_plugin-template.js`.

### 금지 패턴

아래 패턴은 CI lint(`deploy/perspectives/lint-nav.mjs`)가 자동 검출하며 PR 게이트를 막는다.

| 금지 | 이유 |
|---|---|
| `osp-nav-child`, `osp-nav-caret`, `osp-nav-group`, `osp-nav-indent`, `class="osp-nav"` | 구 수작업 nav 클래스 패밀리 |
| `os-tree`, `os-tnode`, `os-tcaret`, `os-sidebar`, `os-navlink`, `\bfnode\b` | 구 수작업 nav 클래스 패밀리 |
| 플러그인 소스 내 하드코딩 hex 색 (`#rrggbb`, `#rgb`) | 색은 Clarity 토큰(`--clr-*`, `--os-*`)으로만 |
| 플러그인별 인라인 `<style>` 블록 내 nav 전용 색·구조 | 전역 Clarity CSS가 처리 — 중복 정의 금지 |

**예외**: `deploy/perspectives/_osp-tree-nav.js` 자체는 lint 대상 제외(표준 구현이므로 Clarity 클래스 이름을 합법적으로 포함). 같은 디렉터리의 다른 `_*.js` 헬퍼도 제외하나, `_plugin-template.js`는 포함(실제 플러그인 템플릿으로서 표준 준수를 검증).

계약 전체: `opensphere-console/docs/dupa-nav-contribution-contract.md`.

## 점검 방법 (리뷰 시)

```bash
# 인라인 스타일 검출 (0건이어야 함)
grep -rn 'style="' src/app/
# 미등록 자작 클래스 검출 — 결과는 전부 예외 등록부에 있어야 함
grep -rohE '\.os-[a-z-]+' src/ | sort -u
```

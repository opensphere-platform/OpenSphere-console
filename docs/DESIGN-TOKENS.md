# OpenSphere Console — Design Tokens (v0)

> **위상**: L/F 개선의 **1단계 = 토큰 기반(SSOT)**. 모든 색·타이포·간격·기하·계층의 단일 원천.
> **방향(확정)**: **Carbon 규율 + OpenSphere 정체성** — ACC(IBM Carbon)의 *규율*(타입 스케일·4px 그리드·hairline·무그림자·단일 액센트·플랫에 가까운 기하)을 채택하되, *브랜드*는 OpenSphere(sphere-blue·다크 네이비 헤더) 유지. IBM Blue/Plex로 가지 않는다.
> **스택 불변**: Angular 22 + Clarity 18. 토큰은 Clarity의 `--clr-*` CSS 변수 재정의 + 보조 `--os-*` 변수로 주입(컴포넌트 교체 없이 전 화면 일괄 반영). 레퍼런스 메커니즘 = 현 `styles.scss`가 이미 하는 방식.

---

## 1. Color

### 1.1 Brand & Accent (OpenSphere 정체성 — 단일 액센트 규율)
| 토큰 | 값 | 용도 |
|---|---|---|
| `--os-accent` | `#4c6fff` | **단일 액센트** — 링크·primary 버튼·focus·선택 강조 (sphere-blue) |
| `--os-accent-hover` | `#3a5af0` | hover |
| `--os-accent-pressed` | `#2f49c8` | pressed |
| `--os-accent-subtle` | `rgba(76,111,255,.12)` | 선택 행/hover 배경 |
> 규율: 액센트는 **희소하게**. 카드 배경·eyebrow에 쓰지 않는다(ACC Don't 준수). 2차 브랜드색 도입 금지.

### 1.2 Surface (Carbon 3단 규율)
| 토큰 | 값 | 용도 |
|---|---|---|
| `--os-canvas` | `#ffffff` | 기본 페이지 배경 |
| `--os-surface-1` | `#f4f4f4` | 입력 필드·교차행·옅은 섹션 밴드·hover 카드 |
| `--os-surface-2` | `#e0e0e0` | disabled·구분 fill |
| `--os-hairline` | `#e0e0e0` | 1px 보더(카드·입력·구분선) — **계층은 hairline+surface로만, 그림자 X** |

### 1.3 Header(ACC 정렬: 차콜+블루 라인) · Nav(ACC 정렬: 화이트)
| 토큰 | 값 | 용도 |
|---|---|---|
| `--os-header-bg` | `#161616` | 상단 헤더 차콜(ACC식) — 하단에 `--os-accent` 2px 블루 라인 |
| `--os-header-ink` | `#c6c6c6` | 헤더 텍스트(차콜 위 라이트그레이) |
| `--os-nav-bg` | `#ffffff` | 좌측 내비 **화이트**(ACC식 라이트 nav) |
| `--os-nav-hover` | `#e8e8e8` | nav 항목 hover/active 옅은 회색 |
> **방향 갱신(사용자 지시 "ACC에 더 접근")**: 초기엔 다크 네이비 헤더/nav를 정체성으로 유지하려 했으나, ACC(IBM Cloud) 실물 비교 후 **ACC 정렬로 전환** — 차콜 헤더 + 헤더 내 다크 검색창 + **화이트 nav**(활성=블루 좌측 바 `inset 3px var(--os-accent)`, 그룹 사이 회색 구분선). OpenSphere 정체성은 **sphere-blue 액센트**(헤더 하단 라인·활성 바·링크)로 유지.

### 1.4 Ink (텍스트)
| 토큰 | 값 | 용도 |
|---|---|---|
| `--os-ink` | `#161616` | 제목·강조 본문(차콜) |
| `--os-ink-muted` | `#525252` | 2차 텍스트·메타 |
| `--os-ink-subtle` | `#8c8c8c` | 3차·helper·caption |

### 1.5 Semantic
| 토큰 | 값 |
|---|---|
| `--os-success` | `#24a148` |
| `--os-warning` | `#f1c21b` |
| `--os-error` | `#da1e28` |
| `--os-info` | `#4c6fff` (=accent) |

## 2. Typography (Carbon 스케일·규율 채택)

- **폰트(사용자 확정: IBM 통일)**: 한·영 **IBM Plex** — 라틴 `"IBM Plex Sans"`, 한글 `"IBM Plex Sans KR"`, 모노 `"IBM Plex Mono"`(토큰 `--os-font`/`--os-font-mono`). 빌드 시 CSS에 base64 번들(외부 의존 없음). Clarity 기본 Metropolis를 `body *`로 덮음.
- **규율(ACC 핵심)**: display는 **weight 300**(라이트), body는 400 + **`letter-spacing: 0.16px`**(제거 금지), 크기로 위계.

| 토큰 | size / weight / line-height / tracking | 용도 |
|---|---|---|
| `--os-type-display` | 42px / 300 / 1.2 / 0 | 페이지 히어로 제목 |
| `--os-type-headline` | 32px / 400 / 1.25 / 0 | 섹션 제목 |
| `--os-type-title` | 20px / 600 / 1.4 / 0 | 카드/패널 제목 |
| `--os-type-body` | 14px / 400 / 1.43 / 0.16px | 기본 본문 |
| `--os-type-body-strong` | 14px / 600 / 1.43 / 0.16px | 강조/선택 탭 |
| `--os-type-caption` | 12px / 400 / 1.33 / 0.32px | 메타·카테고리·유틸 |

## 3. Spacing (Carbon 4px 그리드)
`--os-2`=4 · `--os-3`=8 · `--os-4`=12 · `--os-5`=16 · `--os-6`=24 · `--os-7`=32 · `--os-8`=48.
- 카드 패딩 16~24, 섹션 간격은 큰 여백보다 **얇은 회색 행/구분선**으로(밀도 우선 — ACC 철학).

## 4. Geometry / Radius (플랫에 가깝게)
`--os-radius`=**4px** (기본) · `--os-radius-sm`=2px · `--os-radius-pill`=9999(상태칩만).
> Carbon은 0px이나, OpenSphere는 **4px를 "플랫 표준"**으로(이미 배포한 OCI풍 검색·Clarity 기본과 정합). 8px+ 둥근 모서리·pill 버튼 금지.

## 5. Elevation (hairline + surface, 그림자 최소)
| 레벨 | 처리 | 용도 |
|---|---|---|
| 0 평면 | 보더·그림자 없음 | 본문·헤더 텍스트 |
| 1 hairline | 1px `--os-hairline` on canvas | 카드·입력·리스트 |
| 2 surface | `--os-surface-1` 배경 | 교차행·hover |
| 3 overlay | `0 12px 40px rgba(29,39,51,.25)` | **오버레이만**(검색 드롭다운·모달·메뉴) |
> 평면 표면엔 그림자 금지. 그림자는 **떠 있는 오버레이에만**(이미 검색 드롭다운에 적용).

## 6. Clarity 매핑 (styles.scss 적용 지점)
Clarity 변수 재정의로 전 컴포넌트 일괄 반영:
```scss
:root {
  --clr-global-app-background: var(--os-canvas);
  --clr-btn-primary-bg-color: var(--os-accent);
  --clr-btn-primary-hover-bg-color: var(--os-accent-hover);
  --clr-link-color: var(--os-accent);
  --clr-link-hover-color: var(--os-accent-hover);
  --clr-header-bg-color: var(--os-header-bg);
  --clr-vertical-nav-bg-color: var(--os-nav-bg);
  --clr-card-border-radius: var(--os-radius);
  /* + 타이포 base: body font/size/tracking, display weight 300 유틸 */
}
```
- 커스텀 클래스(`.os-*`)는 토큰만 참조(하드코딩 색·px 금지).
- ⚠️ Clarity가 `header` 요소를 다크로 스타일 → 컴포넌트에서 시맨틱 `<header>/<h3>` 금지(div 사용). (기록: console-clarity-semantic-tag-trap)

## 7. 적용 순서 (1단계 내부)
1. 본 토큰을 `styles.scss` `:root`에 `--os-*` 정의 + `--clr-*` 매핑 추가.
2. 타이포 base(body font·size 14·tracking 0.16, display weight 300) 전역 적용.
3. 기존 하드코딩 색/px를 토큰 참조로 점진 치환(landing·os-shell·os-search부터).
4. 빌드→배포→**브라우저 시각 검증**(화면 깨짐 확인 — 토큰만 바뀌므로 위험 낮음).

## 부록 — 출처
ACC `web/DESIGN.md`(IBM Carbon 토큰 스펙)에서 *규율*을 차용, 브랜드는 OpenSphere로 번역. ACC 라이브: https://acc.cc-1.oci.cmars.kr/ · 검색 패턴 레퍼런스는 OCI 콘솔.

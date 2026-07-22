# OpenSphere Console `manage/*` 디자인 전수 평가 및 업데이트 보고서

- 기준일: 2026-07-22 (KST)
- 대상: `https://localhost:8090/manage/*`의 13개 최상위 화면과 핵심 심층 탭
- 목표: Supabase + Gitea 기반 Console 관리 구조를 같은 정보 위계, 상태 표현, 작업 흐름으로 통합하고 기존 CBS/Backbone 경로의 회귀를 차단한다.
- 접근성 목표: WCAG 2.2 AA에 맞는 제목 구조, 명시적 레이블, 텍스트를 동반한 상태, 키보드 접근 가능한 기본 컨트롤을 유지한다.

## 결론

13개 최상위 관리 화면을 현재 로그인 세션에서 전수 확인했으며 모두 정상 진입했다. 자동 로그아웃, 로그인 벽, HTTP 4xx/5xx 오류 문구는 재현되지 않았다. 기존에 강점이 있던 Control Plane/Data & Identity/Change Control의 다면 탭 구조는 유지하고, 상대적으로 약했던 Catalog/APIs/CLI/Extensions/관리자/역할/OAA/Observability/알림/감사 화면에는 공통 상태 레일과 작업 도구를 적용했다.

페이지의 역할은 다음처럼 분리된다.

- Supabase: 인증, 역할 계약, Console 운영 데이터, 감사·객체 저장의 권위 원천
- Gitea: 선언형 변경, 보호 브랜치, 서명 커밋, 승인·조정 이력의 권위 원천
- Kubernetes: 실제 반영 결과와 런타임 증거
- HIS: 관측성 소유자. Console은 `ObservabilityBinding`의 읽기 전용 소비자이며 Prometheus/Grafana를 직접 소유하거나 구성하지 않는다.

## 공통 디자인 기준과 반영 내용

1. **한눈에 상태 파악** — 제목과 설명 다음에 5~6개의 동일한 상태 레일을 배치했다. 숫자뿐 아니라 소유권, 준비 상태, 경계 상태를 텍스트로 표시한다.
2. **업무 중심 도구** — 섹션 제목, 보조 설명, 검색·필터·새로고침을 같은 툴바 문법으로 정리했다.
3. **상태와 조치의 분리** — 녹색/황색 색상만으로 판단하지 않고 `Ready`, `Attention required`, `NotConfigured` 같은 텍스트와 다음 조치를 함께 둔다.
4. **각 페이지의 강점 보존** — Control Plane의 Operations/Evidence/Change Journey, Data & Identity의 영역별 탭, Change Control의 변경 수명주기 탭, Extensions의 Topology/Installed/Catalog/Audit/Bindings를 유지했다.
5. **명칭과 정보 구조 정리** — 좌측 메뉴 그룹을 `플랫폼 제어`, `운영 및 증거`로 정리하고 폐기된 `/manage/platform-readiness`는 `/manage/platform-control`로 호환 리디렉션한다.
6. **빈 상태의 의미 명확화** — API 없음, HIS Binding 없음, 실패 감사 없음 같은 상태를 오류처럼 보이지 않게 명시적 빈 상태로 표시한다.

## 화면별 결과

| # | 화면 | 상태 | 확인 내용 | 최종 근거 |
|---:|---|---|---|---|
| 1 | Developer Catalog | 정상 | 13개 자산 상태 레일, 이름·종류·소유자·설명 검색, 새로고침 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-01-catalog.png) |
| 2 | APIs | 정상 | API/System/Owner/Lifecycle 요약, 검색과 구조 필터, 명시적 빈 상태 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-02-apis.png) |
| 3 | Console CLI | 정상 | 릴리스·소유권·프로필·플랫폼·자격 증명 상태, 다운로드, 로그인 명령 복사 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-03-cli.png) |
| 4 | Extensions | 정상 | 4개 패키지, Topology/Installed/Catalog/Audit/Bindings 보존, 잘못된 readiness 링크 수정 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-04-extensions.png) |
| 5 | 콘솔 관리자 | 정상 | Supabase Auth 소유권, 활성/비활성/관리자/역할 계약 요약, 사용자 작업 툴바 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-05-console-admins.png) |
| 6 | 역할 | 정상 | 3개 역할 계약, 할당 역할·멤버십·관리자·감사 권위 요약 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-06-roles.png) |
| 7 | Platform Control Plane | 정상·주의 1건 | Supabase/Gitea 연결 정상, 4/4 Console probe, 복구 증거 3건 검토 필요, HIS 미구성 상태를 사실대로 표시 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-07-platform-control.png) |
| 8 | Data & Identity | 정상·주의 1건 | Supabase 3/3 준비, Auth/Database/API/Storage/Security & DR/Integrations 탭, 복구 증거 주의 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-08-data-identity.png) |
| 9 | Change Control | 정상 | Gitea 연결, 보호 브랜치·서명 커밋·직접 push 차단, 변경 여정과 공급망/DR 탭 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-09-change-control.png) |
| 10 | OAA Gateway | 정상·Degraded | Gateway reachable, 지식 48/281, 도구 12, 바인딩 8, LLM key 0을 기능 장애와 구분 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-10-oaa.png) |
| 11 | HIS Observability | 조건부 정상 | HIS 소유권, Binding `NotConfigured`, telemetry 미활성, Console 직접 증거 2/2를 분리 표시 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-11-observability.png) |
| 12 | 알림 | 정상 | 500건 상태 레일, 전체/안읽음/주의 이상 필터, 검색, 읽음 처리 작업 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-12-notifications.png) |
| 13 | 감사 로그 | 정상 | 최근 200건, 승인 성공/실패 거부 필터, 행위자·동작·대상·사유 검색, 읽기 쉬운 시각 | [화면](audit-evidence/2026-07-22-manage-full-audit/final-13-audit.png) |

`주의`와 `Degraded`는 화면 결함이 아니다. 현재 증거가 말하는 운영 상태를 숨기지 않고 표시한 결과다.

## 기능 검증

- Catalog 검색에 `supabase`를 입력했을 때 13건에서 3건으로 필터링되었다.
- 알림의 `주의 이상` 필터는 현재 경고·오류가 없으므로 0건 빈 상태를 표시했다.
- 감사의 `실패·거부` 필터는 최근 200건이 모두 승인되어 0건 빈 상태를 표시했다.
- Extensions `Installed`, Data & Identity `Security & DR`, Change Control `Supply Chain`, OAA `LLM Keys` 심층 탭이 정상 전환되었다.
- `/manage/platform-readiness` 접근은 `/manage/platform-control`로 이동했으며 로그인 벽 없이 Control Plane을 표시했다.
- 13개 화면 순회 중 인증 세션 이탈과 사용자 노출 HTTP 4xx/5xx 오류는 없었다.

## 강점

- Supabase/Gitea/Kubernetes/HIS의 권위 경계가 제목, 설명, 상태, 탭에 반복적으로 드러난다.
- Control Plane은 전체 상황, Data & Identity와 Change Control은 전문 영역, Observability는 외부 조건을 다루어 중복 없이 역할이 선명하다.
- 상태 레일 → 작업 탭/필터 → 상세 표의 정보 위계가 모든 관리 화면에서 예측 가능해졌다.
- 실패나 미구성 상태를 녹색으로 포장하지 않고, 필요한 증거와 다음 행동을 함께 보여 준다.

## 남은 UX·접근성 위험

- 알림과 감사 표는 데이터 밀도가 높다. 긴 제목·대상 값은 향후 행 상세 패널 또는 확장 행을 도입하면 탐색 부담을 더 줄일 수 있다.
- 한국어와 영문 운영 용어가 혼재한다. 제품 고유명과 계약 필드는 영문을 유지하되 일반 동작 용어의 번역 사전을 별도로 고정할 필요가 있다.
- API 목록 0건, 복구 증거 검토 필요, OAA provider key 0건, HIS Binding 미구성은 실제 운영 데이터/조건의 후속 과제다.
- 스크린샷과 DOM 검증으로 제목 구조, 레이블, 텍스트 상태, 컨트롤 노출은 확인했지만 스크린리더 실제 낭독 순서, 전 구간 키보드 탭 순서, 확대 400%, 자동 색 대비는 별도 전문 접근성 시험 범위다.

## 검증 및 배포 결과

- 단위/계약 테스트: 71 passed
- 보안 테스트: 34 passed
- Angular production build: 성공
- 배포 이미지:
  - `opensphere-console:manage-audit-v11` — 2/2 Ready
  - `opensphere-console-backend:manage-audit-v6` — 2/2 Ready
  - `opensphere-console-dupa:manage-audit-v9` — 2/2 Ready
- 비차단 빌드 경고: 초기 bundle이 3 MB 예산을 438.09 kB 초과하고 일부 기존 component style budget 경고가 남아 있다.

## 판정

이번 범위의 일관성·기능 개선은 완료되었다. 화면별 특화 정보와 탭은 유지하면서 공통 상태·작업 문법을 흡수했고, Supabase + Gitea 기반의 소유권과 HIS 관측성 경계를 모든 핵심 관리 흐름에서 확인할 수 있다. 남은 항목은 디자인 회귀가 아니라 운영 데이터와 별도 접근성 전문 시험, 번들 최적화 과제다.

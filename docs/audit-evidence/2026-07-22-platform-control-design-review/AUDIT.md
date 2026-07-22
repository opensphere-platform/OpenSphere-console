# Platform Control Plane 디자인 재감사

- 일자: 2026-07-22
- 범위: `/manage/data-identity`, `/manage/change-control`
- 사용자 목표: Console 운영자가 Supabase와 Gitea의 현재 상태, 위험, 변경, 복구 증거와 다음 조치를 한 흐름에서 판단
- 접근성 목표: 키보드와 보조기술에서도 상태·탭·표·조치 관계가 분명하며 색상만으로 상태를 전달하지 않음

## 총평

현재 구현은 API 계약과 보안 경계를 노출하는 기능적 골격이다. 그러나 상용 관리
화면에 필요한 시각적 계층, 기간·추세, 위험 우선순위, drill-down, 증거 freshness,
조치 연결이 부족하다. Gitea와 Supabase 모두 "현재 무엇이 문제이고 무엇을 해야
하는가"보다 "어떤 구성요소가 존재하는가"를 보여주는 수준이다.

판정:

- Supabase 가시성: **불충분**
- Gitea 관리 감독: **불충분**
- Supply-chain 정책 표시: **부분 충족**
- 복구 증거 의미: **수정 필수**
- 전반적 시각 완성도: **재설계 필요**

## 감사 단계

### 1. Data & Identity Overview — 미흡

![Data & Identity Overview](01-data-identity.png)

- 장점: Supabase와 Gitea의 권위 경계를 설명하고, 상태에 텍스트 레이블을 사용한다.
- 문제: 3개 HTTP probe를 전체 Supabase 준비 상태처럼 강조한다. DB·Auth·Storage의
  용량, 오류, 변경, 위험, 백업 freshness가 없다.
- 개선: 상태를 `서비스 가용성`, `운영 건전성`, `보안`, `복구 가능성`으로 분리하고
  위험·변화·조치 카드와 기간 필터를 우선 배치한다.

### 2. Database — 심각

![Database](02-database.png)

- RLS `Enforced` 한 줄과 설명만 있어 Database 탭이라는 이름에 맞지 않는다.
- 연결 수, DB 크기, schema/table, migration revision/drift, slow query, lock, WAL,
  backup age, RLS coverage/advisor 결과가 없다.
- `Enforced`가 어떤 schema와 정책 집합을 근거로 하는지 증거 링크가 없다.

### 3. Auth & Access — 미흡

![Auth & Access](03-auth-access.png)

- 역할 3개 정적 목록 외에 운영자·세션·MFA·로그인 실패·provider·revoke 상태가 없다.
- 상단의 운영자 수와 이 탭의 역할 표가 연결되지 않는다.
- 역할별 permission matrix와 만료 grant, 고위험 권한을 별도 위험 영역으로 제공해야 한다.

### 4. Storage — 미흡

![Storage](04-storage.png)

- bucket 이름·공개 여부·파일 한도만 보인다.
- object/byte 사용량, 증가율, 사용률, 최근 업로드 실패, MIME 정책, orphan,
  retention, backup/restore 상태가 없다.
- 1행 단위 상세 drawer 또는 bucket drill-down이 필요하다.

### 5. Security & DR — 심각

![Security & DR](05-security-dr.png)

- restore drill과 현재 production inventory의 의미가 구분되지 않는다.
- `restored object files=0`, Gitea `users=0`, `repositories=0`인데도 `Verified`를
  크게 표시해 운영자에게 잘못된 확신을 준다.
- `검증 실행`, `검증 대상`, `예상값`, `실제값`, `checksum`, `RPO/RTO`,
  `evidence source`, `freshness`, `다음 drill`을 분리해야 한다.
- 데이터가 0인 검증은 명시적 기대값과 비교하지 못하면 `Unknown` 또는 `Warning`이어야 한다.

### 6. Integrations — 심각

![Integrations](06-integrations.png)

- consumer id, schema, bucket 문자열이 붙어서 읽힌다(`Extensionsextensions`,
  `oaaoperation-artifacts`).
- `Unknown`과 `NotConfigured`가 반복되지만 영향·소유자·마지막 성공·remediation이 없다.
- consumer별 상세 화면에서 declared/observed revision, Supabase scope, Gitea path,
  reconciler, HIS Binding과 최근 operation을 연결해야 한다.

### 7. Change Control Overview — 미흡

![Change Control Overview](07-change-control-overview.png)

- 권위와 변경 체인은 명확하지만 상태 0건일 때 운영 가능한 정보가 거의 없다.
- open PR, pending approval, unsigned commit, failed delivery, outbox lag, drift,
  last applied change와 repository health가 없다.
- 단계 도식은 실제 건수와 상태를 포함하는 interactive pipeline으로 바꿔야 한다.

### 8. Repositories — 미흡

![Repositories](08-repositories.png)

- repository, visibility, branch, 크기만 제공한다.
- branch protection, last commit/signature, open PR, consumer, desired/applied SHA,
  drift, backup age, last webhook을 한 행에서 판단할 수 없다.
- repository row에서 Gitea 원본, 관련 consumer, 변경 내역으로 이동하는 조치가 없다.

### 9. Changes — 미흡

![Changes](09-changes.png)

- JSON textarea는 schema 도움, validation, diff preview, risk summary가 없는 원시 입력이다.
- 빈 목록이 사용자가 첫 변경을 안전하게 만드는 방법을 안내하지 않는다.
- 2단 구조가 필요하다: schema-driven change builder와 review 가능한 diff/impact preview.

### 10. Approval & Reconciliation — 심각

![Approval & Reconciliation](10-approval-reconciliation.png)

- 선택한 요청이 없는데 approval reason이 먼저 노출되어 조치 맥락이 없다.
- 빈 표에는 pending 조건, reconciler 미등록 영향, retry/remediation이 없다.
- 요청 상세에 actor, reason, PR diff, reviewer, signature, outbox, desired/applied SHA,
  operation timeline을 한 묶음으로 제공해야 한다.

### 11. Supply Chain — 부분 충족

![Supply Chain](11-supply-chain.png)

- branch protection, direct push, 승인 수, signed commit 정책이 명확해 현재 화면 중 가장 낫다.
- 다만 정책 선언만 있고 최근 commit verification, signer fingerprint metadata,
  key rotation age, unsigned exception, failed verification, policy drift가 없다.
- 상단 5개 텍스트를 compliance checklist 카드와 최근 검증 표로 확장해야 한다.

### 12. DR & Contracts — 심각

![DR & Contracts](12-dr-contracts.png)

- DR과 consumer contract는 다른 사용자 과업인데 한 탭에 혼합됐다.
- Gitea recovery가 `repositories=0`인데 `Verified`로 표시되는 의미 오류가 반복된다.
- `Disaster Recovery`와 `Consumer Contracts`를 분리하고, 복구는 현재 inventory가
  아니라 drill 단위 evidence로 표시해야 한다.

## 공통 UX·시각 문제

1. 넓은 화면에서 정보가 가로로 흩어지고 하단은 빈 공간으로 남는다. 12-column
   dashboard grid와 카드 계층이 필요하다.
2. 정상·경고·미구성·미확인을 구분하는 상태 문법이 없다. 색, 아이콘, 레이블,
   영향 문장을 함께 사용해야 한다.
3. raw ISO timestamp, 한국어/영어 혼용, 기술 설명이 그대로 노출된다.
4. 표는 대부분 0~4행인데 전체 폭을 사용해 정보 밀도와 관계 파악이 모두 낮다.
5. `새로고침` 외에 조사·수정·원본 증거로 가는 contextual action이 없다.
6. empty state가 다음 행동이나 미구성 원인을 설명하지 않는다.

## 접근성 위험

- 페이지 제목의 접근 가능한 이름이 `Data & IdentitySupabase · Console authority`,
  `Change ControlGitea · ...`로 붙어 읽힌다. badge 앞뒤의 의미 있는 구분이 필요하다.
- 작은 회색 설명문과 timestamp는 대비·확대 시 가독성 위험이 있다.
- 모든 표에 반복되는 column resize handle이 보조기술 reading order를 과도하게 늘린다.
- tab 수가 많아 작은 viewport/200% zoom에서 overflow와 focus visibility를 실제로
  검증해야 한다.
- 상태는 텍스트도 포함하므로 색상 단독 전달 문제는 확인되지 않았다.

스크린샷만으로 keyboard traversal, screen reader announcement, 200% reflow,
실제 contrast ratio와 async 상태 알림은 확정할 수 없다.

## 2차 디자인 개편 우선순위

### P0 — 상태 의미 교정

- restore drill evidence와 production current state 분리
- 0건 evidence를 조건 없이 `Verified`로 표시하지 않기
- `Ready`, `Connected`, `Verified`, `Unknown`, `NotConfigured`의 판정식과 freshness 표시

### P1 — Supabase 운영 가시성

- Overview: availability/health/security/recovery 네 영역, incident·risk·recent change
- Database: size/connection/migration/RLS/advisor/backup evidence
- Auth: active user/session/MFA/sign-in failure/provider/revoke/role matrix
- API: traffic/error/latency/schema/RLS/rate-limit inventory
- Storage: objects/bytes/growth/policy/failure/retention/backup
- Integrations: consumer별 declared/observed state와 상세 drill-down

HIS Binding이 없으면 시계열은 `NotConfigured`로 유지하되, Supabase/Kubernetes에서
확인 가능한 현재 inventory와 policy evidence는 충분히 제공한다.

### P1 — Gitea 운영 감독

- Overview: open PR/pending approval/webhook failure/outbox lag/drift/last applied
- Repositories: protection/signature/consumer/desired-applied SHA/backup/last activity
- Change builder: schema form + JSON editor + validation + diff + risk/impact preview
- Request detail: intent부터 applied까지 timeline과 증거 deep link
- Webhooks: delivery/signature/replay/retry/failure 탐색
- Supply Chain: 최근 commit verification, signer/key age, exception, policy drift
- DR과 Contracts 분리

### P2 — 시각 체계와 접근성

- 기존 Clarity 기반을 유지하면서 공통 status card, evidence row, timeline, empty state,
  split detail panel을 재사용 컴포넌트로 만든다.
- compact/default density, 기간 필터, 검색·상태 filter, 증거 deep link를 공통 제공한다.
- heading/badge accessible name, keyboard tabs, 200% reflow, contrast를 검증한다.

## 결론

현재 페이지는 2차 계획의 메뉴·탭·보안 경계를 반영했지만, 상용 수준 관리 콘솔의
가시성과 시각 완성도에는 도달하지 못했다. 부분 보강이 아니라 공통 dashboard
shell, 상태 의미, evidence model, drill-down을 기준으로 두 화면을 함께 재설계해야 한다.

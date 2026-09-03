# 2026-09-03 Console 초기 설치 SQL 오류

상태: 원인 수정·실제 PostgreSQL 회귀 통과 / 수정 릴리스 발행과 기존 Failed 설치 복구 진행 중.

## 원인과 검증 공백

Console `202609031353`의 `scripts/Install-ConsoleApiRuntime.ps1`가 Supabase 서비스 역할을 검사하면서 PostgreSQL 예약어 `current_role`을 테이블 별칭으로 사용했다. psql 구문 오류 42601로 역할 암호 설정·Console migration 단계 전에 종료됐다. 사용자가 실행한 설치에서 확인했으며 Kubernetes 구조 또는 OAuth/GHCR 인증 문제가 아니다.

공개 Setup edge.21 doctor는 이미지·설치 파일·클러스터 사전 조건을 검증하지만 해당 PowerShell 내부 SQL을 실행하지 않는다. 기존 PostgreSQL CI도 migration 및 HTTP E2E만 실행했으므로 이 구문이 빠져 있었다. 사전진단 성공을 실제 설치 가능성의 충분한 증거로 안내한 판단을 정정한다.

## 최소 변경과 수용 근거

- `current_role` 별칭을 `existing_role`로 바꾼다. DB schema/migration ledger, 권한, 비밀번호 정책은 변경하지 않는다.
- `verify-console-installer-postgres.mjs`가 실제 installer의 SQL 블록을 읽어 격리 PostgreSQL에서 실행한다. 잘못된 예약어 별칭은 42601로 검출하며, 정상 SQL 반복 실행, 따옴표 포함 암호 escaping, 세 필수 역할 각각의 누락 거부와 권한 속성 보존을 검사한다. 모든 시험 변경은 rollback한다.
- 같은 검증을 main CI의 PostgreSQL 단계에 연결한다. 기존 28개 migration·28개 SQL 검증 및 초기 관리자/API/Controller DB HTTP E2E도 다시 통과했다.
- 관련 요구: CON-FR-014/017 설치·운영 및 복구, C_API/Supabase owner boundary. 신규 repository/process/datastore/framework/dependency: 0.

## 현재 설치와 복구 원칙

`docker-desktop`의 설치 상태는 Failed, release digest는 `sha256:e81c1359442f87597b9e3a2ed71c626fd6e9b58a33ccf6958b7aab530b923533`다. Gitea 및 Gitea PostgreSQL은 Ready이며 데이터 PVC는 Bound다. Supabase PostgreSQL도 Ready다. Console API는 아직 생성되지 않았다.

기존 PVC·Gitea repository·암호·TLS 및 운영 registry owner Secret을 삭제하거나 임의로 교체하지 않는다. 설치 lock이 이전 소스를 고정하므로 edge 이동 후 동일 bootstrap만 재실행하면 이전 오류를 반복한다. 정식 수정 릴리스의 명시적 upgrade를 사용한다. Setup의 임시 OAuth credential은 target/rollback 공급망 검증에만 사용하고 기존 runtime credential에는 전달하지 않도록 검증한다. 기존 runtime pull Secrets가 없거나 불완전하면 복구를 중단한다.

기존 immutable image tag, migration 원본 및 release source는 덮어쓰지 않는다. 다른 Developer/WWW workload는 수정하지 않는다. 실제 새 릴리스·upgrade·Ready 검증은 완료 후 별도 기록한다.

## 근거

- [PostgreSQL SQL 예약어 표](https://www.postgresql.org/docs/17/sql-keywords-appendix.html): CURRENT_ROLE은 reserved.
- 로컬 증거: `.release/registry-auth-verification/console-installer-postgres.log`, `console-installer-repair-db-full.log`.

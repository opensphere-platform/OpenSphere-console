# Console 설치 오류 수정 및 단계별 진행 표시

2026-09-03. 사용자 지시: “업데이트, 기존 설치 삭제 후 보고. 클린 설치는 사용자가 다시 진행.” 상태: **로컬 수정·회귀 통과 / 새 발행 준비 / 두 번째 설치 데이터 삭제 전**.

## 변경

- fresh PostgREST 노출을 실제 존재하는 `storage`로 한정했다. Console authority는 C_API의 기존 직접 DB 경로를 유지하며 레거시 빈 schema나 새 권한을 추가하지 않는다.
- 기존 C_API Secret의 Kubernetes outer base64와 애플리케이션 canonical base64를 각각 해석해 32-byte 키를 검증한다. 정상 키를 교체하지 않으며 비정상 길이/인코딩은 계속 거부한다.
- Setup은 검증한 API egress를 실제 PowerShell installer에 전달하는 template에도 반영한다. image/origin 치환은 기존 installer가 수행한다. Endpoint discovery 실패·넓은 CIDR은 fail closed.
- installer는 12개 실제 단계의 시작/완료/실패와 경과 시간을 출력한다. Console migration은 기존 적용 건수와 각 migration의 적용 시작/반영을 표시한다.
- rollout/wait는 기존 kubectl 명령과 Ready/timeout 판정을 유지하면서 native 진행 내용을 즉시 표시하고 15초 간격으로 마지막 준비 상태와 경과 시간을 다시 알린다. 멈춘 단계가 뒤의 API/Controller 설치로 보이지 않는다.
- 진행 표시는 stderr에 쓰며 최종 stdout JSON 계약을 보존한다. SQL/Secret/manifest 출력 경로는 열지 않는다. 준비 확인 명령의 임의 provider stderr도 그대로 재출력하지 않는다.
- 새로운 framework, dependency, repository, 장기 실행 process, 데이터 저장소, DB schema, 권한 확대: 없음.

관련 요구: CON-FR-014/017 설치·운영/복구, C_API 및 Supabase owner boundary. API egress는 이미 승인된 CON-FR-007 Registry credential lifecycle 범위만 사용한다.

## 세부 단계

| 번호 | 실제 작업 |
|---|---|
| 01 | 설치 입력·기존 상태 검증 |
| 02 | Supabase 선언 적용·PostgreSQL 준비 |
| 03 | Supabase 서비스 DB 역할 동기화 |
| 04 | Supabase Auth 준비 |
| 05 | Storage Pod 실행·자체 schema 초기화 |
| 06 | Console DB migration |
| 07 | Supabase REST 준비 |
| 08 | Supabase Storage 준비 |
| 09 | Console API 최소권한 계정·전용 Secret 확인 |
| 10 | Extension Controller 최소권한 계정·전용 Secret 확인 |
| 11 | Console API 배포·준비 |
| 12 | Extension Controller 배포·준비 |

예시 형식이며 아래 시간은 실측 성공 증거가 아니다.

```text
[시작 06/12] Console DB 마이그레이션 (0.0s)
[진행 06/12] Console DB 마이그레이션 — 기존 적용 0/28, 나머지 순차 적용 (0.1s)
[반영 06/12] Console DB 마이그레이션 — 28/28 opensphere-console/20260903/0028 (8.1s)
[시작 07/12] Supabase REST 준비 (최대 10분) (0.0s)
[대기 07/12] Supabase REST 준비 (최대 10분) — Waiting for deployment ... 0 of 1 updated replicas are available... (15.0s)
```

## 검증

- Setup 전체 테스트 302개 통과. 실제 materialization 함수가 installer에 쓰는 내용과 최종 render 검증 내용을 비교하는 positive/negative 회귀 포함.
- 실제 PowerShell 함수 검증: 정상 기존 Secret 반복 재사용, 잘못된 키 5종 거부, live output/heartbeat/elapsed, nonzero readiness 실패, stdout 보존, provider stderr 미노출.
- installer 기존 계약 6개 통과.
- 격리 PostgreSQL: 실제 installer 서비스-role SQL, fresh target manifest, 28개 migration/28개 SQL 검증, 초기 관리자 및 API/Controller DB HTTP E2E 통과.
- 위 검증을 CI에 연결한다. 기존 migration 원본/manifest digest는 변경하지 않는다.
- 이것만으로 실제 클린 bootstrap 완료, 전체 기능 완성 또는 GA를 주장하지 않는다.

## 현재 설치 상태와 다음 작업

사용자가 다시 실행한 공개 edge.22 설치는 2026-09-03T06:54:20Z에 REST readiness timeout으로 Failed가 됐다. PostgreSQL/Auth는 정상이고 28개 migration은 적용됐으나 REST/Storage 준비가 실패해 API/Controller 단계에 도달하지 못했다.

이번 요청에서는 새 수정판 발행 후 이 설치를 명시적으로 purge하고, 대상 namespace/볼륨/설치 lock 잔여 0건과 다른 서비스 보존을 확인한다. 새 설치 자체는 시작하지 않는다. 소스/문서 및 portable 실행 파일·다운로드 cache는 삭제 대상 데이터에 포함하지 않는다.

이전 보존형 upgrade 및 첫 purge 기록은 과거 증거다. 이전 auto-review 차단 이후 사용자가 이번 업데이트를 명시적으로 다시 지시했고, 좁은 수정이 승인되어 반영됐다. 정책 파일을 수정하거나 차단을 우회하지 않았다.

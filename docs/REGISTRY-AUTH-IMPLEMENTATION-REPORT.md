# Registry OAuth 및 Console 설치 준비 현황

2026-09-03. 지정된 여섯 Secret 권한은 사용자 승인 후 소스에 반영했다. 승인 대기가 아니다. 이 문서는 과거의 미등록/edge.20 상태를 대체한다.

**현재: Console `202609031353` edge 발행 및 공개 Setup edge.21의 OAuth 설치 doctor 통과 / Kubernetes 미설치.** [최종 발행·진단 결과](CONSOLE-INSTALL-RELEASE-202609031353.md).

## 구현 및 책임

- 공개 Setup CLI **setup-v0.5.0-edge.21**을 발행했다. Windows portable 실행이며 설치/PATH/service 변경과 credential cache가 없다.
- 등록된 OpenSphere GitHub OAuth App의 공개 Client ID를 Setup과 Console에 연결했다. Client Secret 또는 publisher PAT를 내장하지 않는다.
- Setup은 최소 read:packages OAuth 접근 권한을 검사한다. registry-auth/v1 owner Secret 한 곳에 갱신 정보를 인계하고, 다섯 imagePullSecret에는 접근 토큰만 보관한다.
- C_API 안에서 갱신·재인증·회수·실패 복구·resourceVersion fencing을 수행한다. 별도 서비스/저장소/프로세스를 추가하지 않았다.
- C_API의 지정된 여섯 Secret get/update만 허용한다. list/watch/create/delete, 다른 Secret, ClusterRole 및 관리자 PAT 인계는 허용하지 않는다.
- 새 HTTP 경로의 OpenAPI/JSON Schema, MFA·CSRF·권한·idempotency·감사 선행 검증을 구현했다. 토큰 원문은 응답/로그에 포함하지 않는다.

## 로컬 실행 검증

| 검증 | 결과 |
|---|---|
| Setup 테스트 | 298개 통과, 공개 EXE/ZIP checksum 및 portable cache 재사용 검증 |
| Console 전체 회귀 | 785개 통과; 별도 pretest 포함 |
| Console API | 188개 통과 |
| Console 계약 | 30개 통과, bootstrap-core release gate 통과 |
| 웹 production build | 통과; 기존 stylesheet budget/CommonJS 경고 있음 |
| OS CLI / Registry Go | 통과 |
| DB migration | 28개 실제 PostgreSQL 적용 및 28개 SQL 검증 통과 |
| SQL 보안 경계 | 최근 MFA 없음/만료, 다른 사용자, 권한 회수, 알 수 없는 작업, 임의 오류코드 거부 및 감사 replay 검증 |
| RLS | 16개 전체 보호 시 Ready; FORCE 해제 또는 RLS 비활성화 시 Blocked |
| 초기 관리자 HTTP | 최신 11개 권한, 동시 요청 단일 승자, 패자 Auth 사용자 정리 검증 통과 |

0028 순방향 migration은 0026에서 추가한 presentation_preference까지 RLS 상태가 반영하도록 한다. 기존 SQL/ledger 이력을 바꾸지 않았다. 초기 관리자 API의 이전 권한 개수 검사(10)를 현재 DB 계약(11)에 맞췄다. 관련 E2E의 이전 기대값도 갱신했다.

실제 OAuth 로그인과 refresh 회전은 통과했다. 당시 GHCR Console manifest 404는 이후 publisher 권한으로 조회해 Console package 자체가 없음을 확인했다. publisher credential은 Docker 발행에만 사용하며 Kubernetes에 인계하지 않는다.

## 완료로 주장하지 않는 범위

Console 이미지/BOM 발행, 최소 OAuth 권한의 실제 digest 접근, 공개 EXE의 localhost CLI doctor는 통과했다. Kubernetes bootstrap, Pod cold-pull/rollout, 설치된 Console의 credential 인계·자동 갱신·전파·복구는 미실행이다. candidate/stable/GA 승인을 의미하지 않는다.

최종 DB HTTP E2E와 수정된 Console을 대상으로 한 Setup 298개 conformance도 통과했다. 과거 자동 보안 검토의 main commit/push 차단은 사용자의 해당 범위 재승인 후 해소됐고 두 저장소 main push 및 CI 성공, GHCR 발행·edge 이동까지 완료했다. Kubernetes는 변경하지 않았다. 승인·차단 이력은 [설치 준비 기록](CONSOLE-CLI-INSTALL-READINESS.md)에 보존한다.

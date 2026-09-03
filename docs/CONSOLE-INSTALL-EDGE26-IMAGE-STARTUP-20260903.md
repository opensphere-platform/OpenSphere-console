# Console edge.26 — 실제 API 이미지 기동 검증과 패키징 수정

2026-09-03. 상태: 수정·기존 이미지 실패 재현·수정 이미지 실제 Ready 검증 완료. 공개 발행 및 실패 설치 삭제 준비. 사용자는 문제 해결 후 클린 설치 준비를 지시했다. 새 Kubernetes bootstrap은 실행하지 않는다.

## 원인 및 검증 공백

edge.25 API는 필수 Secret 누락이 아니라 Node ESM/CommonJS 해석 오류로 시작 직후 종료했다. Dockerfile이 CommonJS contract JS는 복사하면서 그 package boundary인 runtime/package.json을 빠뜨려 상위 type:module을 상속했다. 호스트 소스 E2E에는 해당 파일이 있어 통과했다. OCI labels/platform/digest 검증은 실제 실행 검증이 아니었다. 상세 실측은 [실패 진단](CONSOLE-API-IMAGE-PACKAGING-FAILURE-20260903.md)을 따른다.

## 수정 및 발행 조건

- API 이미지에 runtime/package.json을 포함하고 해당 package의 type을 commonjs로 명시한다. 의존성, DB schema, credential, RBAC, NetworkPolicy, API Ready 기준은 바꾸지 않는다.
- `scripts/verify-console-api-image.mjs`는 완성된 이미지의 기본 `node src/server.mjs` 명령과 UID 1001을 그대로 사용한다. 호스트 source bind mount·실행 명령 override 없이 임시 PostgreSQL에 연결한다.
- 정상 전용 runtime DB role에서 HTTP 200/Ready 및 pg_stat_activity의 실제 연결을 확인한다. 동일 이미지에 잘못된 임시 DB credential을 주면 HTTP 503이고 Ready가 아님을 확인한다. API 재시작은 성공으로 인정하지 않는다.
- 별도 internal Docker network, 임시 DB data(tmpfs), 임의 생성한 시험 credential만 사용한다. 운영 Kubernetes/Secret/DB에 접근하지 않고 호스트 포트도 열지 않는다. 종료 시 실행별 label이 일치하는 시험 컨테이너·볼륨·네트워크만 제거한다.
- Validate CI에서 API docker build 직후 이 검증을 실행한다. 현재 사용하는 Publish-LocalEdge는 정확한 API digest를 실행·검증한 뒤에만 date/edge tag를 전환한다. 이미지를 재사용하는 경로에도 적용한다. immutable source tag는 검증 전에 빌드될 수 있지만 채널로 승격하지 않는다. candidate/stable은 기존 HOLD를 유지한다.
- OCI 사전 검사 메시지는 실제 기동을 오인하지 않도록 `OCI metadata and ... platform verified (not a startup probe)`로 바꾼다.
- 요구 추적: CON-FR-014/017, C_API의 패키지/프로세스/배포 경계 및 DB-backed Ready. 새 서비스·영구 데이터 저장소·프레임워크 없음.

## 실제 검증

정확한 기존 edge.25 이미지(local-4a35cf46d5bc)가 새 image gate에서 알려진 모듈 오류로 실패했다. 수정한 `opensphere-console-api:edge26-verification`은 실제 기본 entrypoint, UID 1001, HTTP 200/Ready, 실제 제한된 DB role 연결, 잘못된 DB 인증의 HTTP 503, 재시작 0을 통과했다. 임시 자원 제거도 확인했다.

로컬 근거: `.release/registry-auth-verification/edge26-old-image-startup-regression.log`, `edge26-api-image-build.log`, `edge26-fixed-image-startup.log`. 이 검증은 API 이미지의 실제 기동/DB Ready 검증이며 Console 전체 Kubernetes clean bootstrap이나 전체 비즈니스 기능 검증은 아니다. 공개 image digest 검증·Setup 공개 실행 및 현재 실패 설치 삭제 결과는 완료 뒤 추가한다.

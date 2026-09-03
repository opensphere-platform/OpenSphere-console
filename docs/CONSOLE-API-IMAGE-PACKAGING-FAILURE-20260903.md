# Console API edge.25 이미지 패키징 실패 진단

2026-09-03. 상태: 읽기 전용 진단 완료. 사용자 질문은 앞선 API Ready timeout과 같은 원인인지다. 이 조사에서 소스 수정·재발행·설치 변경·삭제를 수행하지 않았다.

현재 Pod `opensphere-console-api-67dff879fb-9rl6z`는 CrashLoopBackOff, 재시작 6회, 직전 종료 코드 1이다. 이미지 `ghcr.io/opensphere-platform/opensphere-console-api@sha256:9abab0eabbf1f4017b8185dc3c3178c2d1c781147d42bacd863c0bfe09181e3f`를 사용한다. 로그는 `../runtime/platform-release-contract.js does not provide an export named default`이며 Node v24.18.1에서 모듈 연결 중 종료한다.

앞선 edge.23의 Secret 누락/CreateContainerConfigError와 증상(300초 API Ready timeout)은 같지만 직접 원인은 다르다. 이번에는 monitoring reader Secret이 존재하고 Beszel Hub 1/1, Agent 6/6, bootstrap Job Complete, Supabase 4/4 Ready·재시작 0이다. Beszel null 후처리 오류도 통과했다.

`apps/console-api/Dockerfile`이 runtime의 CommonJS contract JS 세 개만 복사하고 `runtime/package.json`을 누락한다. 소스 트리에는 해당 package boundary가 있어 CommonJS로 해석되지만 이미지에서는 상위 `apps/console-api/package.json`의 `type: module`을 상속한다. `module.exports` 기반 파일을 ESM default import로 연결할 수 없어 API가 시작 직후 종료한다. 단순 대기 시간 연장으로 고칠 수 없다.

검증 누락도 확인했다. validate.yml의 PostgreSQL E2E는 호스트 소스의 `apps/console-api/src/server.mjs`를 Node로 spawn한다. 뒤의 Docker 단계는 이미지를 build만 한다. Publish-LocalEdge의 `metadata and ... runtime verified` 메시지도 실제 실행이 아니라 OCI platform/labels/digest 검사다. 기존 테스트·CI·63개 이미지 태그 검증의 성공은 이미지 내부 API 기동 성공이 아니었다.

후속 수정에는 이미지 안의 명시적 CommonJS package boundary 복구와, 빌드된 실제 이미지의 entrypoint·HTTP readiness 검증을 CI/발행 조건으로 포함하는 작업이 필요하다. 현재 설치를 먼저 지우지 말고 진단 상태를 보존한다. 이 기록은 실제 수정 완료나 설치 성공을 주장하지 않는다.

# OpenSphere Console operating memory

빌드·공식 버전·채널·GHCR 게시·배포의 유일한 권위는 다음 문서다.

`../_DOCS_/01-CONSTITUTION/CONSTITUTION-0005-OCI-IMAGE-CHANNEL-PROMOTION-INSTALLATION-POLICY.md`

상세 Edge·GA 실행 절차:

`../_DOCS_/01-CONSTITUTION/RUNBOOK-0005-EDGE-GA-BUILD-PUBLISH-DEPLOY.md`

작업 전에 이 문서를 읽고 그대로 적용한다. 하위 README, workflow 또는 과거 runbook의 중복 규칙을 우선하지 않는다.

현재 Windows 개발 호스트에서 별도 채널 없이 “빌드해서 배포”를 요청받으면:

1. `docker-desktop`과 전체 node `amd64`를 확인한다.
2. 변경 component를 로컬에서 `linux/amd64` 하나로 build한다.
3. GHCR에 KST `yyyyMMddHHmm` 공식 version과 immutable digest를 push한다.
4. 검증한 digest에 canonical `edge` tag를 부여한다.
5. manifest를 exact digest로 갱신하고 `docker-desktop`에 배포한다.
6. rollout, API, Registry와 실제 UI를 확인한다.

Edge에 GitHub Actions를 사용하지 않는다. subShell/plugin Edge는 Docker Desktop 전용
`opensphere-edge-local-v1` P-256 trust를 사용하며 GA 승인키가 없다는 이유로 중단하지 않는다.
이 산출물은 GA로 승격하지 않는다. GA는 승인된 GitHub Workflow만 사용하고 clean
`linux/amd64,linux/arm64` rebuild와 공급망 증거를 요구한다.

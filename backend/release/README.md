# Console release policy implementation

이 디렉터리는 OpenSphere release 정책의 machine-readable projection과 검증 코드를 보관한다. 규칙을 독립적으로 정의하지 않는다.

최상위 단일 권위:

`../../../_DOCS_/01-CONSTITUTION/CONSTITUTION-0005-OCI-IMAGE-CHANNEL-PROMOTION-INSTALLATION-POLICY.md`

상세 실행 매뉴얼:

`../../../_DOCS_/01-CONSTITUTION/RUNBOOK-0005-EDGE-GA-BUILD-PUBLISH-DEPLOY.md`

구현 projection:

`policies/build-authority-policy.json`

실행 entry:

| 목적 | 정본 entry |
|---|---|
| Console 전체 Edge build·GHCR 게시 | `../../scripts/Publish-LocalEdge.ps1` |
| Edge 설치·검증 | `opensphere-setup upgrade --release edge --context docker-desktop`와 `opensphere-setup verify` |
| Console GA clean multi-arch build·게시 | `../../.github/workflows/publish-ga-images.yml` |
| 정책 conformance | workspace `tools/release/verify-build-authority.mjs` |

주의:

- `Publish-LocalEdge.ps1` 성공은 GHCR publication 완료다. Setup upgrade, rollout, installation lock,
  API와 실제 Chrome 확인까지 끝나야 배포 완료다.
- subShell/plugin Edge는 workspace `tools/release/Publish-LocalEdgeModule.ps1`을 사용한다. Docker
  Desktop 전용 edge-local P-256 key와 GA 승인키를 분리하며 무서명 우회는 허용하지 않는다.
- GA workflow 성공은 GA publication 완료다. Setup이 signed `ga` lock을 지원하지 않으면 production
  배포 완료가 아니며 mutable tag 직접 적용으로 우회하지 않는다.

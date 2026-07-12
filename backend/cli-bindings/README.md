# CLI Bindings

이 영역은 Main Shell core 밖에서 향후 추가될 CLI 확장을 위한 계약이다. 예: workforce Keycloak/AD
인증 프로파일, Workspace 사용자 명령, 별도 배포되는 CLI 도구.

Main Shell이 직접 소유하는 `os`는 Binding이 아니며 이 CRD로 선언할 수 없다. `os`의 소스, manifest,
artifact server와 Deployment는 `backend/os-cli/`에 있다.

workforce Binding은 admin PAT와 다른 issuer, audience, token storage, scope, command visibility와 audit
attribution을 가져야 한다. 실제 workforce Binding 인스턴스는 별도 승인 전에는 생성하지 않는다.

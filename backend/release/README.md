# opensphere-release

OpenSphere-Platform 컴포넌트 — **Plane P1 · kind spine**

Release Authority — 버전당 단일 권위 페이로드(불변): /manifests + image-references@sha256 + supportedHostK8s.

- pre-GA 채널: `edge`, `candidate`, `stable` — localhost 또는 GitHub Actions 빌드 허용
- 공식 GA 채널: `ga` — GitHub Actions 빌드와 공급망 증거 필수
- pre-GA 산출물의 GA 재태깅 금지. 동일 소스는 GA workflow에서 다시 빌드
- `edge`는 개발 호스트용 단일 플랫폼, `candidate`·`stable`·`ga`는 `linux/amd64` + `linux/arm64`
- 선언적 정책: `policies/build-authority-policy.json`
- 결정 문서: `../../docs/RELEASE-BUILD-AUTHORITY-POLICY.md`

업그레이드=핀 1줄 교체

> arch-001(OKD 렌즈 재설계 v1.2) 기준 스캐폴드. 구현 예정.
> 설계 권위: `opensphere-docs/20-아키텍처/arch-001-opensphere-okd-재설계.md`

# os — OpenSphere Console native CLI

`os`는 Main Shell이 직접 소유하는 관리자 제어 표면이다. UIPluginPackage, UIPluginRegistration,
CLIDownload 또는 다른 Binding으로 설치·활성화하지 않는다.

## 고정 경계

- 다운로드와 manifest: `/api/cli/*`
- 인증: Supabase Console Identity 장치 승인(P-256) + 15분 CLI 세션. 자동화 API 토큰은 비대화형 작업 전용
- 권한과 감사: Console과 동일한 Registry, API, RBAC, audit path
- core 프로파일: `admin`
- 소스·테스트·cross-build·배포 manifest: 이 디렉터리가 단일 원천

향후 workforce 인증·권한·명령은 별도의 승인된 CLI Binding과 `workforce` 프로파일로 추가한다.
workforce token을 `admin` PAT 필드에 저장하거나 admin 명령에 전달해서는 안 된다.

## 빌드

```bash
docker build --build-context macos-cli=/absolute/path/to/opensphere-cli-macos -t os-cli:console-native-v0.5.0 backend/os-cli
```

Multi-stage build는 Go 테스트와 Linux amd64·Windows amd64 빌드를 수행한다. macOS arm64
바이너리는 GitHub Actions의 **native `macos-14` runner**가 Security.framework를 링크해
Keychain round-trip까지 검사한 뒤 artifact로 전달한다. Linux 컨테이너가 macOS 보안 API를
흉내 내어 cross-build하지 않으며, 해당 artifact가 없으면 Docker build는 의도적으로 실패한다.

이 경계는 macOS 개인키가 `/usr/bin/security ... -w <secret>`의 argv에 노출되지 않도록
보장한다. native macOS 빌드 산출물은 Buildx의 `macos-cli` named context로만 전달되며
Git 작업 트리나 이미지의 source context에 포함되지 않는다.
최종 이미지는 non-root nginx가 검증된 정적 artifact만 제공한다.

# os — OpenSphere Console native CLI

`os`는 Main Shell이 직접 소유하는 관리자 제어 표면이다. UIPluginPackage, UIPluginRegistration,
CLIDownload 또는 다른 Binding으로 설치·활성화하지 않는다.

## 고정 경계

- 다운로드와 manifest: `/api/cli/*`
- 인증: Kanidm/BFF admin PAT
- 권한과 감사: Console과 동일한 Registry, API, RBAC, audit path
- core 프로파일: `admin`
- 소스·테스트·cross-build·배포 manifest: 이 디렉터리가 단일 원천

향후 workforce 인증·권한·명령은 별도의 승인된 CLI Binding과 `workforce` 프로파일로 추가한다.
workforce token을 `admin` PAT 필드에 저장하거나 admin 명령에 전달해서는 안 된다.

## 빌드

```bash
docker build -t os-cli:console-native-v0.2.0 backend/os-cli
```

Multi-stage build가 Go 테스트를 실행하고 Linux amd64, macOS arm64, Windows amd64 바이너리를 만든다.
최종 이미지는 non-root nginx가 정적 artifact만 제공한다.

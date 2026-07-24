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
docker build \
  --build-context macos-cli=/path/to/native-macos-cli-artifacts \
  -t os-cli:console-native-v0.8.1 \
  backend/os-cli
```

Multi-stage build는 Go 테스트와 현재 `index.json`에 공개된 Linux amd64·Windows amd64
바이너리를 빌드한다. macOS arm64·amd64는 GitHub Actions의 **native `macos-14` runner**가
Security.framework와 Keychain round-trip을 검사한 뒤 named BuildKit context로 전달한다.
Console 이미지는 선언된 네 플랫폼 artifact가 모두 없으면 manifest 생성 단계에서 fail-closed한다.

이 경계는 macOS 개인키가 `/usr/bin/security ... -w <secret>`의 argv에 노출되지 않도록
보장한다. manifest에 없는 과거 macOS 바이너리를 암묵적으로 다시 배포하지 않으며, macOS
artifact도 동일 버전·크기·SHA-256 링크를 `index.json`에 선언한다.
최종 이미지는 non-root nginx가 manifest와 일치하는 검증된 정적 artifact만 제공한다.

## 운영 명령

```text
os status
os doctor [-o table|json|yaml] [--strict]
os describe platform|supabase|storage|gitea|observability|contracts|extensions
os events [--limit 100]
os get consumercontracts
os token create --label ci-reader --scope read --ttl 24h --reason "read-only CI inventory"
os context save local-admin        # 현재 context의 비활성 사본 생성
os context use local-admin         # 명시적으로 전환
os context list
os support-bundle --file support.json
os update --check
os update
os platform update check --channel edge
os platform update plan --channel edge
os platform update apply <plan-id>
```

목록형 `catalog`, `events`, `operation list`는 공통으로 `--filter key=value`,
`--sort-by key`, `--desc`, `--limit 1..1000`을 지원한다. 모든 JSON 명령은 전역
`-o table|json|yaml`을 사용할 수 있다. Native 명령은 중앙 command contract에 선언된
옵션과 인자 수만 허용하며, 알 수 없는 옵션과 사용법 오류는 항상 exit code 2를 반환한다.
`os <command> --help`와 shell completion도 같은 contract에서 생성하므로 서로 드리프트하지 않는다.

`os backbone`은 기존 스크립트를 위한 경고형 alias일 뿐이며 폐기된
`/api/admin/backbone/*`를 호출하지 않는다. `BackboneClaim`도 복원하지 않고 현행
`Consumer Contract` 권위로 안내한다.

## 승인형 변경

```text
os plan --consumer manual --action configure --target manual \
  --file desired.json --reason "manual registry configuration update"
os plan list
os plan show <plan-id>
os plan delete <plan-id> --yes
os apply <plan-id>
os operation list
os operation get <request-id>
os operation watch <request-id> --timeout 10m
os operation approve <request-id> --reason "reviewed by second operator"
os rollback <request-id> --consumer manual --target manual \
  --file previous.json --reason "restore last verified declaration"
```

`plan`은 기본적으로 등록된 Consumer Contract를 사전 확인하고, 64 KiB 이하 JSON object만
허용하며 secret/token/password/private key 원문을 거부한다. 연결할 수 없는 환경에서 plan만
준비할 때는 `--offline`을 명시하며 apply 시 서버가 다시 검증한다. 파일은 SHA-256 digest로
봉인되며, `apply`는 Console Backend의 Supabase 감사 →
Gitea PR → 2인 승인 → reconciler receipt 경로에만 제출한다. `rollback`도 즉시 변경하지 않고
원본 request ID를 연결한 새 plan을 만든다.

Context 파일은 URL·profile·device ID만 저장하고 `OS_PAT`는 절대로 기록하지 않는다.
`context save`는 현재 설정의 사본만 만들고 활성 context를 바꾸지 않으며, 전환은 `context use`로만 한다.
Context 삭제는 로컬 별칭만 제거하며 서버 장치 신뢰는 변경하지 않으므로 `--yes`를 요구한다.
Support bundle은 credential-like 필드를 재귀적으로 `[REDACTED]` 처리하고 기존 파일을
기본적으로 덮어쓰지 않는다.

## Self-update

`os update --check`는 현재 Console의 `/api/cli/index.json`과 설치 바이너리를 비교만 한다.
`os update`는 새 안정 버전이 있을 때 동일 Console origin의 `/api/cli/*` artifact만 받고,
Ed25519로 서명된 manifest와 정확한 size·SHA-256을 모두 검증한 뒤 교체한다. downgrade는 허용하지 않는다.
동일 버전인데 digest가 달라진 재게시는 기본 차단하며 운영자가 원인을 확인한 경우에만
`--force`를 사용할 수 있다.

로컬 개발 서명 키는 `localhost`, `127.0.0.1`, `::1` Console에서만 인정된다. Edge/운영
이미지는 `CLI_UPDATE_SIGNING_PROFILE=production`으로 빌드하며 GitHub Actions의
`CLI_UPDATE_SIGNING_PRIVATE_KEY` secret, `CLI_UPDATE_SIGNING_KEY_ID`와
`CLI_UPDATE_SIGNING_PUBLIC_KEY` repository variable이 모두 없으면 빌드가 실패한다.
개인키는 BuildKit secret mount로 manifest 생성 단계에만 전달되며 이미지 layer나 CLI에
복사하지 않는다. CLI에는 대응하는 공개 키와 key ID만 고정된다.

Windows에서는 현재 프로세스가 종료된 뒤 숨김 helper가 교체하고 `<os.exe>.previous`에
직전 바이너리를 보관한다. 비동기 교체 결과는 `os update --status`로 확인한다.
Linux/macOS는 같은 디렉터리에서 atomic rename으로 교체하며,
실패하면 기존 바이너리 복원을 시도한다. `OS_INSECURE_SKIP_TLS_VERIFY=1`은 로컬 개발용이며
운영 self-update에서는 사용하지 않는다.

## Platform update

`os update`와 Platform update는 기준과 범위가 다르다. `os update`는 현재 Console이
제공하는 CLI manifest만 확인하고 `os.exe` 하나를 갱신한다. 반면 아래 명령은
`edge|candidate|stable` GHCR 채널의 서명된 Release BOM을 Setup CLI의 기존
provenance·SBOM 검증 경로로 해석하고, 클러스터의
`opensphere-installation-lock/release.json`과 release digest를 비교한다.

```powershell
os platform update check --channel edge -o json
os platform update plan --channel edge -o json
os platform update apply <plan-id> -o json
```

`check`는 읽기 전용이다. `plan`은 확인된 target release lock과 현재 cluster digest를
`~/.os/platform-update-plans` 아래의 SHA-256 봉인 plan으로 저장한다. `apply`는 plan 생성
이후 cluster digest가 바뀌지 않았는지 다시 확인한 뒤 `opensphere-setup upgrade`의
검증·prefetch·rollback 트랜잭션을 실행하고, 완료 후 설치 잠금이 target digest와 같은지
재검증한다. Setup CLI와 `kubectl`이 PATH에 있어야 한다. Kubernetes context를 고정하려면
세 명령 모두 같은 `--context <name>`을 사용한다.

비공개 GHCR package에 명시적 read-only credential이 필요한 경우 token을 인자나 파일에
기록하지 않고 stdin으로만 전달한다.

```powershell
$githubUser = gh api user --jq .login
gh auth token |
  os platform update check --channel edge `
    --registry-username $githubUser `
    --registry-token-stdin
```

`plan`과 `apply`에도 같은 두 registry 옵션을 사용할 수 있다. Release 검증은 구성요소별
attestation과 SBOM을 확인하므로 단순 tag 조회보다 오래 걸릴 수 있다. Platform 적용이
끝나면 Setup CLI가 새 Console-native `os`도 설치하므로 새 PowerShell에서
`os version`과 `os update --check`로 최종 상태를 확인한다.

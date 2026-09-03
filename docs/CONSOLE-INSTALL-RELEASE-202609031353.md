# Console 설치용 edge 발행 결과

2026-09-03. **main 반영·GHCR 발행·edge 갱신 완료 / 공개 EXE의 OAuth doctor 통과 / Kubernetes 미설치.**

- Console 버전: `202609031353`
- 채널: `edge` (localhost, linux/amd64, pre-ga, GA 대상 아님)
- 불변 소스: `fd802071b1adabed309c2932a43ca5598b5f1cb2`
- 불변 source tag: `local-fd802071b1ad`
- 공개 Setup: `setup-v0.5.0-edge.21` (Windows 설치 없이 휴대형 실행, 검증된 runtime cache 재사용)
- Console anchor: `ghcr.io/opensphere-platform/opensphere-console@sha256:5c570f6d9aeb1f6059eaddbf803c9cdd6c5034ccf05b117c4cde5f2e0b4b365e`

## 검증

Console main CI: https://github.com/opensphere-platform/OpenSphere-console/actions/runs/33716840400 (success). 발행 source 이후 차이는 CI workflow뿐이며 runtime source는 같다.

Setup main CI: https://github.com/opensphere-platform/OpenSphere-Setup-CLI/actions/runs/33716808966 (success). Setup pin은 위 Console 불변 소스를 가리킨다. 공개 EXE는 다시 덮어쓰지 않았다.

로컬 Console 회귀 785개, API 188개, Setup 298개, 실제 PostgreSQL migration 28개·SQL 검증 28개, 초기 관리자·API/Controller DB HTTP E2E, 웹 production build, Go CLI/Registry, Manual/발행 회귀 17개가 통과했다.

21개 image의 metadata·source·platform·version을 검증하고 불변 날짜 tag를 연결했다. non-Console edge 갱신 후 Console anchor를 마지막으로 갱신했으며 최종 tag digest 전수 확인이 통과했다.

## 공급 artifact

| 역할 | 이미지 |
|---|---|
| console | `ghcr.io/opensphere-platform/opensphere-console@sha256:5c570f6d9aeb1f6059eaddbf803c9cdd6c5034ccf05b117c4cde5f2e0b4b365e` |
| consoleApi | `ghcr.io/opensphere-platform/opensphere-console-api@sha256:053e55e2a4e2b56e95748274afb9c70e19a95873d16c7320e7ba35eecd279512` |
| extensionController | `ghcr.io/opensphere-platform/opensphere-extension-controller@sha256:cb44b8e8083810632305abd20b19b3306bea850d16148f99ef8333ce1071fdad` |
| registry | `ghcr.io/opensphere-platform/opensphere-registry@sha256:c9042dc7d1e4e6dcec0017e27919deea7108fb6f73e92c1fedfd17e32890aa4e` |
| osaaGateway | `ghcr.io/opensphere-platform/opensphere-console-osaa-gateway@sha256:ba60fa57a90345b742b5fe570eace1768c1e35d5c18d217b7938a42ca0291c2c` |
| osdst | `ghcr.io/opensphere-platform/opensphere-osdst@sha256:896016978fc4e9871ec6771ffa24ce177aae8fd67ec28826975fd4116de41092` |
| osaaGovernedAdapter | `ghcr.io/opensphere-platform/opensphere-osaa-governed-adapter@sha256:236231433db53d214a491417055084ed2661d2ba2ef10ab91d2d4dc2edef8c3c` |
| notificationDispatcher | `ghcr.io/opensphere-platform/opensphere-console-notification-dispatcher@sha256:f39638e7ea731b09a74226df75876ce55096b635043f7f05a347fbc400d3cd22` |
| gitea | `ghcr.io/opensphere-platform/opensphere-console-gitea@sha256:adb9d5de557cdf02895de151adb6a610213f82b49a983a8654f48b4dd5068a17` |
| supabasePostgres | `ghcr.io/opensphere-platform/opensphere-console-supabase-postgres@sha256:818a94ca1b44761e8ff7725966d93522c09bba6a0ddc7ee558369c609e15df20` |
| supabaseAuth | `ghcr.io/opensphere-platform/opensphere-console-supabase-auth@sha256:4b5e30794dc4a07ab8692553a095921cd09981d8c88cc4554c49366080458522` |
| supabaseRest | `ghcr.io/opensphere-platform/opensphere-console-supabase-rest@sha256:d5b477abdbbc26503f55301e6d9c981f094a29c0a08cf094a583da7071c0c884` |
| supabaseStorage | `ghcr.io/opensphere-platform/opensphere-console-supabase-storage@sha256:9f36d24d8143c10a0bb75fb8b67bba068a2a55a4b67b7db255a370f9e3ba1a42` |
| giteaPostgres | `ghcr.io/opensphere-platform/opensphere-console-gitea-postgres@sha256:7ed169da588ff342862c2900d39bef150285b6f8c7a1f56691cd4ce413a7d7e3` |
| recovery | `ghcr.io/opensphere-platform/opensphere-console-recovery@sha256:f0dd1f87496fd6eb43db4155a5db9c225cb5a4c620345b9c93ad8b5fb2e9a1fb` |
| beszelHub | `ghcr.io/opensphere-platform/opensphere-console-beszel-hub@sha256:0f831d88ce9b8d36dda9d765dc7eb96f9a8c7ae602b4797b1e742f8817f596fe` |
| beszelAgent | `ghcr.io/opensphere-platform/opensphere-console-beszel-agent@sha256:99237634d6f442b78d6cdabe02311cb507e5e832488171be42c7374dc18d468e` |
| beszelBootstrap | `ghcr.io/opensphere-platform/opensphere-console-beszel-bootstrap@sha256:9f00219ba406cca148ce7143a4c2c824855fe5843b0c306230dc48e2e9a94de1` |
| cliArtifacts | `ghcr.io/opensphere-platform/opensphere-os-cli@sha256:ab0c329574ad2a1f707ef9debb30c075e1a6cc18a50e567b855bf02954258f98` |
| osShellControl | `ghcr.io/opensphere-platform/opensphere-console-os-shell-control@sha256:84ee89a908686aaef7bc87d3c9758c9baa4ce34a21ca7a6929d303111252fb4a` |
| osShellRuntime | `ghcr.io/opensphere-platform/opensphere-os-shell-runtime@sha256:ebc63c82ab4959195e81cd5ab743a05d8e45193f7157facceae69766ebea0087` |

## 아직 수행하지 않은 작업

공개 EXE의 실제 read:packages OAuth 설치 doctor는 사용자 승인 후 종료 코드 0으로 통과했다. Kubernetes bootstrap, Pod cold-pull/rollout, Console의 credential 갱신·전파 실검증은 아직 수행하지 않았다. 발행 성공을 설치 성공으로 표시하지 않는다.

Publisher 관리자 credential은 Docker 발행에만 사용하며 Setup/Console runtime에 인계하지 않는다. Windows 상주 설치/PATH/CA 신뢰 변경, 기존 Developer/WWW workload 변경, 기존 릴리스 삭제 또는 package 공개 전환은 수행하지 않았다.

## 공개 EXE 설치 사전진단 결과

2026-09-03 14:38 KST 확인. 공개 `setup-v0.5.0-edge.21` EXE를 사용했고, Device Flow 승인 이후 아래 진단이 종료 코드 0으로 통과했다. publisher credential 환경 변수를 비우고 `--registry-auth oauth`를 명시했다. access/refresh token은 실행 메모리에만 있었으며 파일·보고서에 저장하지 않았다.

```powershell
.\opensphere-setup.exe --channel edge doctor --release edge --context docker-desktop --registry-auth oauth
```

| 실제 확인 | 결과 |
|---|---|
| 공개 EXE SHA-256 | `116b704771003405e31daaf33ad9c5ecd038c58139a700d1b7692c4c9fcebf66` |
| 휴대형 runtime | 저장된 runtime 검증 후 재사용; runtime 다운로드·Windows 설치 없음 |
| OAuth | 전용 OpenSphere 앱 승인, identity 및 최소 `read:packages` scope 검사 통과 |
| 로컬 도구 | win32/x64, bundled Node v26.5.0, kubectl/pwsh 확인 |
| Kubernetes | docker-desktop v1.36.1, 6/6 Ready schedulable linux/amd64, StorageClass `standard`, 설치 사전 권한 검사 통과 |
| Console 포트 | `127.0.0.1:1114` 사용 가능 |
| GHCR | canonical 18개 + auxiliary 3개 실제 접근, digest·불변 tag·source/metadata/platform·edge 일치 검증 통과 |
| 릴리스 lock digest | `sha256:e81c1359442f87597b9e3a2ed71c626fd6e9b58a33ccf6958b7aab530b923533` |
| 설치 자료 | 원격 불변 source의 47 artifacts, 12 manifest groups 다운로드·검증 통과 |
| 최종 CLI 결과 | `[성공] 설치 전 진단 통과 — 클러스터 변경 없음 (총 263.5s)`; 총 시간에 사용자 인증 대기 포함 |

Beszel은 root 및 read-only hostPath 요구를 기록했다. Setup이 host 또는 Pod Security 정책을 완화하지 않았다. PVC 요청 합계는 98Gi이며 이는 실제 잔여 용량의 보증이 아니다. `https://localhost:1114` 인증서 신뢰는 설치 호스트에서 확인해야 한다. 위 판정은 현재 localhost edge의 설치 사전 조건이며 GA 또는 운영 보증이 아니다.

## 실제 설치 명령과 남은 검증

[공개 휴대형 EXE](https://github.com/opensphere-platform/OpenSphere-Setup-CLI/releases/download/setup-v0.5.0-edge.21/opensphere-setup.exe)를 받은 폴더에서 실행한다.

```powershell
.\opensphere-setup.exe --channel edge bootstrap --release edge --context docker-desktop --registry-auth oauth
```

`--channel edge`는 실행할 Setup 채널, `--release edge`는 설치할 Console 채널이다. edge는 이동할 수 있으므로 bootstrap은 실행 시점의 anchor를 다시 고정·검증한다. 이 명령은 위 날짜 버전을 고정 지정하는 명령이 아니다. doctor의 토큰을 보관하지 않으므로 새 bootstrap 실행에서는 새 OAuth 승인이 필요하다.

Kubernetes bootstrap, Pod cold-pull/rollout, Console의 credential 갱신·전파 실검증은 아직 수행하지 않았다. 종료 후 namespace 목록에 Console 관리 namespace가 없고 기존 Developer/WWW namespace가 유지됨을 확인했다. 설치 사전진단 성공을 실제 설치 성공으로 표시하지 않는다.

로컬 세부 증거: `.release/registry-auth-verification/console-install-published-bom.json`, `console-install-ci-evidence.json`, `console-install-doctor-evidence.json`, `console-install-doctor-completion.log`. credential과 일회용 인증 코드는 증거 파일에서 제외한다.

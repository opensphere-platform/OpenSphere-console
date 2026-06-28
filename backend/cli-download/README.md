# console/cli-download — `os` CLI 콘솔 바인딩 (**headless binding**)

콘솔 확장의 **두 번째 타입**. UIPluginPackage(UI 게스트 — 콘솔이 마운트·렌더)와 대(對)되는 **비-UI `binding`**: 콘솔이 호스팅하지 않고 **선언을 참조**해 다운로드를 노출.

> 분류: `Console(mainShell)` 확장 = ① UI 게스트(`subShell`·`plugin`) + ② **headless binding(`CLIDownload` …)**. OKD `ConsoleCLIDownload` 어댑트(Console 접두 제거).

## 명령 vs 다운로드 파일명
- **명령(typed)** = `os` (짧음).
- **다운로드 아티팩트(파일명)** = `opensphere-cli-<os>-<arch>` (풀네임, 자가설명적). oc ↔ `openshift-client-*` 패턴. 받은 뒤 `os`로 rename(또는 설치 시).

## 구성
| 파일 | 정체 |
|---|---|
| `crd.yaml` | **`CLIDownload`** CRD (`console.opensphere.io/v1alpha1`, cluster-scoped) — binding 오브젝트 정의 |
| `clidownload-os.yaml` | `os` CR — OS별 다운로드 링크 **선언**(콘솔 "Command Line Tools" 표면이 읽음) |
| `nginx.conf` + `Dockerfile` | `os-cli` 서빙 컨테이너 (nginx-unprivileged, nonroot). 바이너리=`Content-Disposition: attachment`+octet-stream(다운로드 강제), index.json=JSON |
| `deploy.yaml` | os-cli Deployment+Service (`opensphere-system`) |
| `dist/index.json` | 다운로드 매니페스트 (바이너리 `dist/opensphere-cli-*`는 gitignore — 크로스컴파일 산출) |

## 빌드·배포
```bash
# 1) os 크로스컴파일 → dist/ (다운로드 파일명=opensphere-cli-*)
cd ../../opensphere-cli
GOOS=linux   GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../console/cli-download/dist/opensphere-cli-linux-amd64       ./cmd/os
GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o ../console/cli-download/dist/opensphere-cli-darwin-arm64      ./cmd/os
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../console/cli-download/dist/opensphere-cli-windows-amd64.exe ./cmd/os
# 2) 서빙 컨테이너
cd ../console/cli-download && docker build -t localhost:5000/os-cli:v3 . && docker push localhost:5000/os-cli:v3
# 3) 바인딩
kubectl apply -f crd.yaml && kubectl apply -f clidownload-os.yaml && kubectl apply -f deploy.yaml
```

## 콘솔 바인딩 (셸 무수정)
셸 generic proxy 재사용: `/api/plugins/os-cli/<file>` → `os-cli.opensphere-system.svc:8080/<file>`.
- 다운로드 URL 예: `http://localhost:8090/api/plugins/os-cli/opensphere-cli-windows-amd64.exe` (브라우저가 **다운로드** — 인라인 렌더 아님)
- 콘솔 **"Console Extensions" admin → Bindings 탭**(셸 v7)이 `CLIDownload` CR을 읽어 OS별 다운로드 링크 렌더.

## 검증
콘솔 경유 다운로드(`opensphere-cli-windows-amd64.exe`, PE32+) → 실행 **`os 0.1.0`** ✓. `kubectl get clidownload os` → 선언 가시. `/api/admin/bindings` → os 인식.

# OpenSphere Console native CLI 통합 감사결과보고서

- 보고일: 2026-07-12
- 감사 대상: OpenSphere Console Main Shell 및 `os — OpenSphere CLI` v0.2.0
- 감사 기준 커밋: `c368012` (`feat: make os CLI a Console-native capability`), branch `main`
- 감사 성격: 형식 검증이 아닌 전문 개발자 관점의 product-level 독립 감사. "CLI를 허용하는 서비스"의 보안 기준과 기능 완결성을 함께 판정한다.
- 감사 방식: 소스 정독 + 배포된 HTTPS 엔드포인트(`https://localhost:8090`) 직접 호출 + 실제 아티팩트 다운로드·해시 대조·실행 + 클러스터 상태 확인 + Go/Node 테스트 재실행

---

## 0. 최종 판정 (요청 형식)

```text
Console-native CLI integration:  ACCEPT WITH CONDITIONS
Console production completeness:  ACCEPT WITH CONDITIONS
```

두 판정 모두 경계·소유권·배포 골격은 견고하나, **관리 제어 표면을 가진 CLI의 보안 기준**과 **운영 내구성 증거**에서 조건부 항목이 남는다. 아래 §9의 조건이 해소되면 무조건 ACCEPT로 승격 가능하다.

---

## 1. 감사 요청 항목별 판정 요약

| # | 요청 항목 | 판정 | 근거 |
|---|---|---|---|
| 1 | `os` Main Shell 소유권 일관성(코드·route·API·배포) | PASS | §2 |
| 2 | Binding/generic proxy 되돌림 우회 경로 부재 | PASS(경계 유효) / **조건부**(가드 키 오류) | §3, F-3 |
| 3 | admin PAT ↔ 향후 workforce 신원 분리 | PASS | §4 |
| 4 | Console과 동일 Registry·인가·감사 의미론 소비 | PASS(대체로) / **조건부**(감사 누락) | §5, F-5 |
| 5 | URL 검증·credential URL 거부·config 0600·TLS opt-in | **조건부** | §6, F-1·F-2 |
| 6 | 동적 namespace 명령이 Registry `Available` closed-set 준수 | PASS | §7 |
| 7 | cross-build·checksum 재현성/provenance | PASS(무결성) / **조건부**(서명 부재) | §8, F-4 |
| 8 | Deployment non-root·RO root·drop ALL·resource·probe | PASS / **조건부**(seccomp/PDB) | §2.4, F-6 |
| 9 | `/manage/cli` Clarity v18·관리 tree 정보구조 | PASS | §2.5 |
| 10 | Backbone 미연결 시 완결/안전 오인 표시 부재 | PASS | §2.6 |

---

## 2. 확인된 사실 (PASS 근거)

### 2.1 소유권 일관성 — 코드·route·API·배포 전 구간

- **소스**: `backend/os-cli/cmd/os/main.go`(550줄)가 login/whoami/registry/get/role 및 Registry-discovered namespace 명령을 구현. `go.mod` module `opensphere.io/console/os-cli`.
- **route/menu**: `src/app/app.routes.ts:50` `{ path: 'cli', component: AdminCli }`, `src/app/pages/admin-layout.ts:64` `자산 및 확장 > Console CLI → /manage/cli`, Carbon `Terminal16` 아이콘.
- **native API**: `nginx/default.conf.template:156` `location /api/cli/` → `os-cli.opensphere-system.svc:8080`, `rewrite`로 upstream 루트 매핑, `limit_except GET { deny all; }`.
- **배포**: `backend/os-cli/deploy.yaml` Deployment/Service `os-cli` (ns `opensphere-system`, label `opensphere.io/scope: main-shell-core`).
- **manifest**: `backend/os-cli/index.json` `ownership: console-native`, `profile: admin`.

라이브 확인:
```
GET  /api/cli/index.json           → 200
POST /api/cli/index.json           → 403   (비-GET 차단)
kubectl: deploy/os-cli 2/2 Ready, svc/os-cli ClusterIP:8080
running image = deploy.yaml digest = a2edd2ee...  (일치)
```

### 2.2 native API 읽기 전용 / 비-GET 차단
`limit_except GET { deny all; }` + nginx.conf가 `/index.json`(no-store)과 바이너리(`attachment`, `nosniff`)만 서빙. 라이브 POST 403 확인.

### 2.3 cross-build·checksum 재현성 (§8 상세)
세 아티팩트를 배포 엔드포인트에서 실제 다운로드 → manifest와 **바이트 크기·SHA-256 전부 일치**:

| 아티팩트 | manifest size / sha256(앞) | 실측 |
|---|---|---|
| linux-amd64 | 5,996,728 / `98f139da` | 일치 |
| darwin-arm64 | 5,694,578 / `fcc4cd02` | 일치 |
| windows-amd64 | 6,155,776 / `86b9c901` | 일치 |

Windows 바이너리 실행: `os 0.2.0` 출력, help가 admin/workforce 경계 문구 출력. `go test ./...` (digest-pinned golang 컨테이너) PASS.

### 2.4 Deployment 하드닝
`securityContext`: `allowPrivilegeEscalation:false`, `readOnlyRootFilesystem:true`, `runAsNonRoot:true`, `capabilities.drop:[ALL]` — 라이브 검증 일치. 이미지 digest 고정, replicas 2, CPU/mem requests·limits, readiness/liveness probe, RO root + `/tmp` emptyDir(sizeLimit 16Mi)로 CrashLoop 교정 확인.

### 2.5 `/manage/cli` UI
`src/app/pages/admin-cli.ts`가 `clr-datagrid`/`clr-alert`/`btn`과 공용 `os-page-header`만 사용. manifest 로드 시 `ownership==='console-native' && profile==='admin'` 계약을 UI에서 재검증(불일치 시 에러). 3 플랫폼·checksum(앞 12자리)·다운로드 링크 렌더.

### 2.6 Backbone 완결/오인 표시 부재
`nginx` `/readyz`가 controller readiness에 위임. controller의 모든 `/api/admin/*` 쓰기는 `backboneReadiness()` 미충족 시 **503**(`Backbone required capabilities unavailable`) 반환(`controller.js:1294`). 라이브: Backbone 3기둥(postgres/rustfs/gitea) 1/1 Ready, PVC 3건 Bound, `CLIDownload` 0건.

### 2.7 워크포스 경계 (§4 상세)
`saveConfig`가 `profile != "admin"`를 에러로 거부(`main.go:121`). `index.json`의 `extensionBoundary: { workforce: "future-binding", adminTokenReuse: false }`. `crd.yaml`의 audience enum `[workforce, external]` — admin은 native 전용으로 명시적 예약. 테스트 `TestConfigIsAdminOnlyAndPrivate`가 workforce 저장 거부를 검증.

---

## 3. 되돌림(reintroduction) 경계 검증

라이브·소스 모두 경계는 유효:
```
GET /api/plugins/os-cli/index.json → 403   (구 Binding 경로)
controller: NATIVE_BINDING_NAMES={'os'} → 바인딩 목록에서 os 제외(1424),
            enable/disable os 요청 → 409 native_console_capability(1432),
            proxy allowlist 스캔 시 name 'os' skip(665)
backend/cli-download 디렉터리 삭제됨, clidownload-os.yaml 부재(테스트로 회귀 방지)
```

**그러나 F-3(§F)**: 이 안티-재도입 가드는 CLIDownload의 `metadata.name === 'os'`를 키로 삼는데, native 워크로드의 **서비스명은 `os-cli`**다. `proxyAllow` 엔트리는 링크 `href`의 정규식 `/api/plugins/([a-z0-9-]+)/`에서 도출되므로, 이름이 `os`가 아닌 임의의 CLIDownload가 `href: /api/plugins/os-cli/...`를 선언하면 `os-cli`가 allowlist에 추가되어 `/api/plugins/os-cli/*`가 native 서비스로 프록시된다(가드 우회). 실제 영향은 낮다(대상이 read-only 공개 아티팩트 서버로 동일 콘텐츠, admin 권한 필요). 그러나 감사요청서가 선언한 불변식("os-cli는 plugin/Binding allowlist로 절대 진입 불가")은 **가드가 잘못된 식별자에 걸려 있어** 문자 그대로는 성립하지 않는다.

---

## 4. admin PAT ↔ workforce 신원 분리

- native 프로파일은 admin 단일. PAT는 opensphere-auth BFF가 발급한 ES256 JWT(`typ: pat`, `jti`), `requireAdmin`이 서명+`opensphere-console-admins` 그룹 확인 후 발급(`server.mjs:413`).
- CLI는 PAT를 `Authorization: Bearer`로만 전달, `whoami`가 `/bff/pat/introspect`로 활성 여부 검증(폐기 반영).
- workforce 토큰 재사용 금지가 config·manifest·CRD·help·테스트 4중으로 선언됨.

판정: **분리 계약은 명확**. 단, PAT 자체의 위험 프로파일은 §6/F-2 참조.

---

## 5. 동일 Registry·인가·감사 의미론

- **Registry**: CLI `registry`/`dynamic`이 `/api/v1/registry`(opensphere-registry, read-only, byte-identical) 소비. 콘솔과 동일 권위 응답. 라이브 200.
- **인가**: `get`은 `/api/proxy`(콘솔과 동일 K8s 프록시), `role`은 `/bff/roles/*`(콘솔 admin-roles.ts와 동일 엔드포인트, `requireAdmin` 게이트). 별도 권한 체계 없음.
- **감사**: CLI가 매 요청에 `X-OS-Correlation-ID`(암호학적 난수) 부착 → nginx `opensphere_json` 로그 상관관계 확보.

**F-5(조건부)**: 그러나 `os role grant/revoke`(권한 상승 쓰기)가 경유하는 `opensphere-auth`의 `handleRoleGrant/Revoke`는 **내구 감사(audit_log) 이벤트를 남기지 않는다**(`server.mjs:486-504`). 이는 콘솔 UI와 공유하는 갭이므로 CLI 고유 결함은 아니나, "동일 감사 의미론" 요건 관점에서 CLI는 콘솔의 감사 공백까지 그대로 계승한다. admin 역할 부여가 내구 감사 없이 수행되는 점은 CLI를 통해 확대된다.

---

## 6. CLI 보안 표면 (요청 #5 정밀 검토)

**PASS 항목**
- `validateURL`: `http/https` 외 스킴 거부, `u.User != nil`(credential-bearing URL) 거부, 원격 평문(HTTP non-localhost) 거부. 테스트로 `file://`·`https://user:pass@`·`javascript:`·원격 http 거부, localhost http·https 허용 검증. 모든 요청 경로(`request`)가 재검증.
- 응답 `io.LimitReader(8MB)` + 30s timeout — DoS/자원 가드.
- write 명령(dynamic, 비-GET)은 `--preview`/`--apply` 명시 강제(`main.go:462`).
- `OS_INSECURE_SKIP_TLS_VERIFY=1`은 명시적 opt-in, `#nosec` 주석, 로컬 개발 한정.
- login이 저장 **전** `whoami` introspect로 PAT 유효성 검증(잘못된 자격증명 저장 방지).

**조건부 항목 (전문/제품 관점 지적)**
- **F-1 (Windows에서 0600 무효)**: `saveConfig`가 `os.WriteFile(…, 0o600)` + `os.Chmod(0o600)`로 PAT를 저장하지만, Go의 `Chmod`는 **Windows에서 사실상 no-op**(읽기전용 비트만 매핑, ACL 무관)이다. 즉 배포된 Windows 바이너리는 `%USERPROFILE%\.os\config.json`에 admin PAT를 **동등한 ACL 보호 없이** 저장한다. 테스트(`TestConfigIsAdminOnlyAndPrivate`)는 Linux tmpdir에서만 0600을 확인하므로 이 갭을 잡지 못한다. "config mode 0600"을 세 플랫폼 공통 보안 통제로 제시한 것은 Windows에서 성립하지 않는다.
- **F-2 (PAT 자격증명 취급이 CLI 서비스 보안 기준 미달)**:
  - `os login --pat <TOKEN>`은 토큰을 **argv로 전달** → 프로세스 목록(`ps`)·셸 히스토리에 노출. stdin/프롬프트/파일 입력 경로가 없다.
  - PAT TTL 기본 **365일**(`PAT_TTL_DAYS=365`)의 full-admin bearer 토큰. 만료·회전 부담이 크다.
  - PAT는 발급 시 admin의 **전체 그룹을 그대로 상속**(`server.mjs:418` `groups: admin.groups`) — CLI 전용 스코프 축소가 불가. 유출 시 = 콘솔 admin 전권.
  - 성숙한 CLI 서비스(클라우드 CLI 급) 기준으로는 (a) argv 노출 회피, (b) 단기 토큰+회전, (c) 최소권한 스코프가 요구된다. 현재는 미충족.

---

## 7. 동적 namespace closed-set 준수

`dynamic`(`main.go:399`)은 `/api/v1/registry`를 조회해 `item.Available && item.CLI != nil && item.CLI.Namespace == ns`인 항목만 채택한다. Registry의 `Available`은 `desired=="Enabled" && phase∈{Ready,Activated} && observedGeneration>=generation`(`registry.go:118`)로 계산 — **비활성·미검증·Failed plugin은 자동 제외**. 미등록 ns는 명시적 에러. write는 manifest의 tool `method`가 GET이 아니면 `--apply`/`--preview` 강제. closed-set 계약 준수 확인.

---

## 8. 재현성·provenance

- Dockerfile이 golang을 **digest로 고정**, 빌드 단계에서 `go test ./...` 선행, `-trimpath -ldflags="-s -w -X main.version=0.2.0"`로 결정적 3-플랫폼 빌드.
- 세 아티팩트의 size·SHA-256이 manifest 및 라이브 다운로드와 완전 일치(§2.3).

**F-4(조건부)**: manifest(`index.json`)는 SHA-256을 제공하나 **detached 서명이 없다**. 플랫폼의 plugin 표준은 `sha256 + ECDSA` 이중 검증(controller `verifyPlugin`)을 요구하는데, native CLI 아티팩트는 SHA-256만으로 제공된다. manifest와 바이너리가 **동일 origin(동일 TLS 채널)**으로 배포되므로, origin이 침해되면 공격자가 manifest와 매칭 바이너리를 동시에 교체할 수 있다. 즉 현재 통제는 **전송 오류에 대한 무결성**이지 **침해 origin에 대한 진정성(authenticity)**을 보장하지 못한다. 플랫폼 자체 기준(plugin=서명 필수) 대비 native CLI가 낮은 provenance 등급이다.

---

## 9. 완결성(production completeness) 게이트

감사요청서가 명시한 Backbone 게이트에 더해 감사 중 확인된 사항:

- Backbone 3기둥 Ready·PVC Bound이나, storage class RWO(local-path 계열)로 **노드 소실 HA 없음**, 오프노드 백업 반출·restore 훈련 미재검증(요청서 자인). — 전체 Console 운영 승인 시 별도 증거 필요.
- Angular initial bundle 4.22MB(3MB budget 초과), `admin-plugins` style 4KB+597B 초과 — 성능 부채(빌드 실패 아님).
- **F-7(증거 불일치)**: 감사요청서 §4는 "Node test 53/53 fail 0"을 제시하나, 현재 트리에서 `node --test backend/dupa-control/`를 실행하면 `oaa-gateway-tier.test.js`가 **실패**한다(누락 파일 `src/app/os/os-oaa-agent.ts` 참조). CLI 관련 스위트(`main-shell-base` 7/7, `security` 12/12)는 전부 통과하므로 **CLI 통합 자체는 무결**하나, "fail 0" 증거 라인은 전체 디렉터리 기준으로는 현재 성립하지 않는다(무관 OAA 기능의 미완결).

---

## F. 발견사항 (심각도순)

| ID | 심각도 | 요약 | 위치 |
|---|---|---|---|
| F-1 | Medium | Windows에서 `Chmod(0600)`가 no-op — admin PAT가 ACL 보호 없이 저장. 테스트는 Linux만 커버 | `main.go:143`, `main_test.go:36` |
| F-2 | Medium | PAT 취급이 CLI 서비스 보안 기준 미달: argv 노출·365일 TTL·full-admin 스코프 상속·회전/최소권한 부재 | `main.go:270`, `server.mjs:417-420` |
| F-3 | Medium→Low | 재도입 가드가 바인딩 name `os`에 걸림. 서비스 `os-cli`는 다른 이름의 CLIDownload href로 allowlist 진입 가능(불변식 문자적 위반, 영향 낮음) | `controller.js:665` |
| F-4 | Low | native CLI 아티팩트에 detached 서명 없음(SHA-256만). plugin 표준(sha256+ECDSA) 대비 낮은 provenance | `index.json`, `nginx.conf` |
| F-5 | Low | `role grant/revoke`가 내구 감사 미기록(콘솔과 공유 갭). CLI가 감사 공백을 계승·확대 | `server.mjs:486-504` |
| F-6 | Low | Deployment에 `seccompProfile: RuntimeDefault` 미지정, PDB/NetworkPolicy/topologySpread 부재(2 replica 동일 노드 가능) | `deploy.yaml` |
| F-7 | Info | 요청서의 "Node 53/53 fail 0"이 현재 트리에서 미성립(무관 oaa 테스트 실패). CLI 스위트는 전부 통과 | `oaa-gateway-tier.test.js` |
| F-8 | Nit | `registry()`의 `*kind=="" \|\| *output=="json" && *kind==""` 조건 중복(dead logic) | `main.go:322` |

---

## 10. 판정 근거 및 조건

### Console-native CLI integration: ACCEPT WITH CONDITIONS
소유권·되돌림 경계·읽기전용 native API·배포 하드닝·UI 계약·closed-set·checksum 재현성이 모두 독립 검증으로 성립한다. 조건은 **관리 제어 표면 CLI의 보안 등급**에 있다. 다음 해소 시 무조건 ACCEPT:
1. (F-1) Windows PAT 저장에 ACL 하드닝 적용 또는 OS 자격증명 저장소 사용, 그리고 Windows 경로를 커버하는 테스트/문서 정정.
2. (F-2) PAT를 argv 대신 stdin/파일로 받는 경로 제공, 단기 토큰+회전 또는 CLI 스코프 축소 도입(로드맵 명시 시 조건 완화).
3. (F-3) 재도입 가드를 서비스명(`os-cli`) 기준으로 이동해 불변식을 문자적으로 성립.

### Console production completeness: ACCEPT WITH CONDITIONS
Backbone 3기둥이 Ready이고 읽기전용 표면과 쓰기 503 게이트가 정확히 동작하나, 완결 승인에는:
1. Backbone 오프노드 백업 반출 + 실제 restore 훈련 증거(요청서 자인 잔여 위험).
2. (F-7) 전체 테스트 스위트 green 복구(oaa-gateway-tier 미완결 해소) 또는 감사 증거의 범위 정정.
3. bundle budget 부채의 감사 기록/개선 계획.

이들은 CLI 범위 밖 잔여 항목으로, native CLI 통합의 무결성과는 독립적이다.

---

## 부록 A. 감사 재현 명령

```bash
# 라이브 경계
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:8090/api/cli/index.json           # 200
curl -sk -o /dev/null -w "%{http_code}\n" -X POST https://localhost:8090/api/cli/index.json     # 403
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:8090/api/plugins/os-cli/index.json  # 403

# 아티팩트 provenance (세 플랫폼 size·sha256 = index.json)
curl -sk https://localhost:8090/api/cli/opensphere-cli-windows-amd64.exe | sha256sum
#   86b9c901f23c64adbd8ddc52b8a4ca74566a8ae96de7cad5cf33be865a114797  size 6,155,776  ✓

# 클러스터
kubectl get deploy -n opensphere-system os-cli            # 2/2
kubectl get pods -n opensphere-backbone                   # postgres/rustfs/gitea 1/1
kubectl get clidownloads -A                               # No resources found

# 테스트
docker run --rm -v "$PWD:/src" -w /src golang@sha256:523c3e… go test ./...   # ok (os-cli)
node --test backend/dupa-control/main-shell-base.test.js   # 7/7
node --test backend/dupa-control/security.test.js          # 12/12
```

# RCC Linux Host Control (Stage 1–5 + 운영 기능 단위)

Status: Stage 1 (읽기 전용 보고), Stage 2 (통제된 타입 작업), Stage 3 (패키지·커널 정비와 정비 창), Stage 4 (네트워크·스토리지 변경과 이미지 기반 OS) 구현 완료. Stage 5 (배포 전 적대적 감사) 수행 완료 — 14장. 배포 후 기능 단위 1(호스트 등록·읽기 전용 상태 조회) 감사 — 15장, 기능 단위 2(Cockpit형 패키지·커널 정비 화면) 감사 — 16장, 기능 단위 3(SSH 보호 운영) 구현 — 17장.

Region Control Center(RCC)는 Kubernetes와 그 아래 Linux 호스트를 하나의 제어면에서 확인합니다. 이 문서는 그 Linux 호스트 계층의 설계, API, 보안 경계, 설치 절차, 운영 절차, 현재 구현 상태와 한계를 규정하는 정본입니다.

Stage 1은 **읽기 전용 보고**입니다. Stage 2는 **선언된 세 가지 타입 작업**을 추가합니다: `journal.query`, `service.restart`, `host.reboot`. Stage 3은 다시 세 가지를 추가합니다: `package.refresh`, `package.update`, `kernel.update`. Stage 4는 다섯 개를 더합니다: `network.configure`, `mount.configure`, `filesystem.grow`, `osimage.stage`, `osimage.rollback`. 운영 기능 단위 3은 고정 Fail2ban `sshd` 기준선의 설치·검증·활성화를 요청하는 `ssh.protection.enable`과 정확한 단일 IP만 다루는 `ssh.ban`, `ssh.unban`을 추가합니다. 모두 합쳐 **열네 개**이며, 이 목록은 코드가 아니라 데이터베이스의 작업 카탈로그입니다.

**원격 셸과 임의 명령 실행은 어느 단계에도 없으며 이후에도 도입하지 않습니다.** 호스트는 여전히 인바운드 포트를 열지 않고, 에이전트가 아웃바운드로만 작업을 가져갑니다. Stage 4에서 추가된 작업들도 예외가 아닙니다: 원시 `nmcli`/`ip` 인자, 임의 파일 내용, 마운트 옵션 문자열, 장치 경로, 레지스트리 URL을 받는 필드는 **존재하지 않습니다.** SSH 보호도 jail·명령·기간·재시도 횟수·임의 설정을 받지 않습니다. 설치 후보 버전과 보호 관리 주소는 노드가 보고한 상태에서 서버가 파생하고, 에이전트는 코드에 고정된 `rcc-ssh-baseline-v1` 설정과 `fail2ban-client` 명령만 사용합니다. 거부되는 것이 아니라 표현할 수 없습니다.

**Stage 4의 어떤 작업도 재부팅하지 않습니다.** 실행 중인 시스템을 바꾸는 것은 여전히 `host.reboot`이며, 그것은 별도로 승인되고 Kubernetes cordon/drain/PDB/etcd/단일 컨트롤플레인 검사를 모두 유지합니다.

## 1. 설계 개요

| 구성 요소 | 위치 | 역할 |
|---|---|---|
| `rcc-node-agent` | 각 Linux 호스트, Kubernetes **바깥**의 systemd 서비스 | 경계가 정해진 타입 스냅샷을 수집해 outbound HTTPS로만 보고 |
| Host API | `backend/opensphere-console-backend/host-api.js` | 서명된 heartbeat 수집 + 운영자 조회 |
| Host authority | Supabase `console.host`, `console.host_snapshot` | 등록 상태와 최신 스냅샷의 정본 |
| Beszel | HIS 소유 Hub와 호스트 에이전트 | CPU·메모리·디스크·네트워크·부하 시계열의 읽기 전용 원천 |
| Metrics API | `backend/opensphere-console-backend/beszel-metrics-api.js` | RCC 호스트 권한을 재확인하고 Beszel 데이터를 경계가 정해진 스키마로 투영 |
| `linux-host-manager` | DUPA subShell (`deploy/rcc/subshells/linux-host-manager`) | 유일한 사용자 화면 |

설계 원칙은 다음과 같습니다.

- **호스트는 인바운드 포트를 열지 않습니다.** 에이전트가 RCC로 나가는 연결만 만듭니다. 방화벽에 노드용 인바운드 규칙을 추가하지 않습니다.
- **OKD, MCO, Cockpit, Rancher, Fleet, Elemental, Salt, Perses, Thanos를 설치하거나 내장하지 않습니다.** RCC 안에 두 번째 제어면·데이터베이스·메트릭 서버를 만들지 않고, HIS가 운영하는 Beszel의 호스트 시계열을 읽기 전용으로 소비합니다.
- **권한과 감사의 정본은 기존 Supabase입니다.** 선언적 변경 권위는 기존 Gitea 체계를 그대로 따릅니다.
- **기능 UI는 등록된 실행 표면에만 존재합니다.** `/cc/:ccId/hosts`는 얇은 별칭이며 화면은 subShell이 그립니다.
- `backend/os-cli`는 Console 관리 CLI로 남으며 호스트 제어와 분리됩니다.

## 2. 에이전트

`backend/rcc-node-agent`는 독립 Go 모듈이고 단일 정적 바이너리입니다.

- 설정 파일: `/etc/rcc-node-agent/agent.json` (root 소유)
- 키 파일: `/etc/rcc-node-agent/agent.key` (out-of-band 배치)
- 실행 파일: `/usr/local/bin/rcc-node-agent`
- systemd 유닛: `rcc-node-agent.service`
- 수집 주기: `agent.json`의 `intervalSeconds` (기본 60초, 15초~1시간으로 clamp). **호스트 로컬 설정이며 RCC가 지시하지 않습니다.** 제어센터가 에이전트 주기를 바꿀 수 있다면 그것이 호스트로 들어가는 제어 채널이 되기 때문입니다.
- 요청 타임아웃, 지수 백오프 재시도, `SIGINT`/`SIGTERM` 시 graceful shutdown을 구현합니다.
- 로컬 점검: `rcc-node-agent --check`는 설정을 검증하고 스냅샷 1건을 출력한 뒤 종료합니다(전송하지 않음). `rcc-node-agent --version`은 버전만 출력합니다.

에이전트는 리스너를 열지 않으므로 별도의 health 포트가 없습니다. 상태 확인은 `systemctl status rcc-node-agent`와 RCC 화면의 신선도 표시로 수행합니다.

아래 표는 **Stage 1/2 기본 수집 항목**입니다. Stage 4에서 추가된 `packages`, `kernel`, `networkState`, `storage`, `boot` 그룹은 13.1에 별도로 기술되어 있으며, 각각 설정으로 꺼둘 수 있습니다. 이 두 목록에 없는 값은 수집하지 않습니다.

스키마는 `rcc.host.snapshot/v1`입니다.

| 그룹 | 필드 | 상한 |
|---|---|---|
| identity | `hostname`, `osName`, `osId`, `osVersionId`, `kernelVersion`, `architecture`, `machineIdHash`, `bootIdHash`, `uptimeSeconds` | — |
| resources | `cpuCount`, `load1`, `load5`, `load15`, `memTotalBytes`, `memAvailableBytes`, `memFreeBytes`, `swapTotalBytes`, `swapFreeBytes`, `processCount`, `runningProcesses`, `blockedOnIoCount`, `contextSwitchCount` | — |
| filesystems | `device`, `mountPoint`, `fsType`, `readOnly`, `totalBytes`, `usedBytes`, `availableBytes`, `inodesTotal`, `inodesUsed` | 32개 |
| network | `name`, `rxBytes`, `txBytes`, `rxPackets`, `txPackets`, `rxErrors`, `txErrors`, `rxDropped`, `txDropped` | 16개 |
| systemd | `available`, `failedUnitCount`, `failedUnits`, `truncated` | 이름 25개 |
| degraded | 수집 실패를 나타내는 진단 키 문자열 배열 | 32개 |
| sshBan | 고정 `fail2ban`/`sshd` 상태, 설치·후보 버전, RCC 보호 프로필, 실패·차단 수, 차단된 정확한 IP 주소, `bantime`·`findtime`·`maxretry`, 정규화된 최근 탐지·차단·해제 사건, 수집 시각 | 주소 128개, 사건 100개 |
| operations | `enabled`, `restartAllowlist`, `packageAllowlist`, `networkAllowlist`, `mountRoots`, `growAllowlist`, `imageAllowlist`, `sshBanEnabled`, `sshProtectedAddresses`와 각 권한의 on/off — 이 에이전트가 받아들일 작업의 선언 | 목록 64개, Stage 4 목록은 각 32개, 보호 주소 64개 |

주의할 점:

- **`network` 그룹은 인터페이스 카운터만 담습니다.** 여기에는 MAC 주소도 IP 주소도 없습니다. 가상 인터페이스(`veth`, `cali` 등)는 제외됩니다. 주소·MTU·링크 상태는 Stage 4의 별도 그룹 `networkState`에서 수집하며(13.1), MAC 주소는 그쪽에서도 수집하지 않습니다.
- `machineIdHash`와 `bootIdHash`는 원본이 아니라 SHA-256 접두 해시입니다.
- `failedUnitCount`는 **경계 내 출력에 존재하는 전체 실패 유닛 수**이며, `failedUnits`는 그중 앞 25개만 담습니다. 목록이 잘렸거나 출력이 읽기 상한에서 끊긴 경우 `truncated`가 `true`가 됩니다. 따라서 실패가 200건이면 `failedUnitCount`는 200이고 `failedUnits`는 25개, `truncated`는 `true`입니다.
- `degraded`는 키/값 쌍이 아니라 문자열 배열입니다.
- `operations`는 **선언**입니다. 실제 강제는 계획이 도착했을 때 에이전트가 독립적으로 수행하므로, 스냅샷이 오래되었거나 변조되어도 allowlist가 넓어지지 않습니다. 반대 방향으로는 사용됩니다: 백엔드는 요청 시점에 이 목록과 교집합을 취해, 이 호스트의 에이전트가 어차피 거절할 대상은 승인 절차에 올리지 않고 그 자리에서 거절합니다(13.2).

스냅샷에는 자격 증명, 토큰, 사용자 데이터, 프로세스 목록, 명령 이력, 저널 내용이 포함되지 않습니다.

## 3. 인증과 보안 경계

에이전트는 브라우저 세션을 갖지 않습니다. heartbeat는 `RCC-AGENT-V1` HMAC-SHA256 서명만 받아들이며, 다음이 모두 검증되어야 합니다.

- 키 ID, 타임스탬프, 논스, HTTP 메서드, 요청 경로, 본문 다이제스트, 제어센터·호스트 바인딩
- 서명 비교는 상수 시간(`timingSafeEqual`)으로 수행합니다.
- 재생 방지 윈도우를 벗어난 타임스탬프와 재사용된 논스는 거부합니다.
- 본문 크기 상한을 초과하면 파싱 전에 거부합니다.

fail-closed 규칙:

| 상황 | 결과 |
|---|---|
| 브라우저 Bearer 토큰으로 heartbeat 시도 | 401. 세션 인증으로 대체되지 않습니다. |
| 알 수 없는 키 ID | 401. 키 회전 중이라도 미등록 키를 조용히 수용하지 않습니다. |
| 서명 키가 등록된 호스트와 다름 | 401 |
| 재사용된 논스 | 409, 중복 기록 없음 |
| 다른 키의 트래픽으로 논스 캐시를 밀어내려는 시도 | 무효. 재생 방지 캐시는 키 ID별로 분할되어 있어 한 키의 폭주가 다른 키의 논스를 축출하지 못합니다 |
| 스키마 불일치·시계 오차 초과 | 422 |
| 데이터베이스 없음 | 503. 수집 성공으로 응답하지 않습니다. |
| 알 수 없는 제어센터 | 404 |

추가 규칙:

- 에이전트 비밀은 쿼리 문자열, 로그, 스냅샷, 응답 본문, 생성된 manual JSON 어디에도 남기지 않습니다.
- `console.host.agent_key_id`는 **식별자**이며 키 자료가 아닙니다. 서버 측에서만 읽고 응답에 투영하지 않습니다.
- 키 자료는 PostgREST로 노출하지 않습니다.
- 키 문서는 `RCC_AGENT_KEYS_FILE` 환경변수로 주입하며, 문서가 거부되면 heartbeat 경로는 503으로 닫힙니다.
- 스냅샷은 에이전트가 보낸 JSON을 그대로 저장하지 않고 허용 목록 기준으로 필드마다 재구성합니다. 알 수 없는 키, 상한 초과 배열, 제어 문자는 저장 전에 제거됩니다.

## 4. API

### 4.1 에이전트 수집

```
POST /api/control-centers/{ccId}/hosts/{hostId}/heartbeat
```

서명 헤더가 필요하며 **`POST`만 허용됩니다**(다른 메서드는 `405`). 성공 시 `202`와 `{ accepted, hostId, controlCenterId, receivedAt }`를 반환합니다. 응답에 주기 지시는 없습니다. 최초 보고가 검증되면 등록 상태가 `pending`에서 `active`로 승격됩니다.

### 4.2 운영자 조회

```
GET /api/control-centers/{ccId}/hosts
GET /api/control-centers/{ccId}/hosts/{hostId}
```

`linux-host-manager` subShell은 자신의 정규 네임스페이스를 통해 같은 내용을 읽습니다.

```
GET /api/plugins/linux-host-manager/control-centers/{ccId}/hosts
GET /api/plugins/linux-host-manager/control-centers/{ccId}/hosts/{hostId}
GET /api/plugins/linux-host-manager/control-centers/{ccId}/hosts/{hostId}/metrics?range=1h
```

세 경로 모두 Supabase 세션 인증, `console.hosts.read` 권한, 그리고 해당 제어센터에 대한 유효한 운영자 배정을 요구합니다. 호스트 목록·상세 조회는 append-only 감사(`rcc.host.list`, `rcc.host.read`)에 기록됩니다. heartbeat는 plugin 네임스페이스에서 **제공되지 않습니다** — 브라우저가 도달할 수 있는 경로가 서명 수집 경로가 되지 않도록 404로 닫습니다.

메트릭 경로의 `range`는 `1h`, `12h`, `24h`, `1w`, `30d` 중 하나입니다. 백엔드는 RCC 운영자 권한과 활성 호스트를 먼저 확인한 뒤, 서버에만 마운트된 별도 Beszel `readonly` 계정으로 명시된 호스트 매핑 하나를 조회합니다. 브라우저에는 Beszel 토큰·자격증명·PocketBase 식별자를 내보내지 않고 `rcc.host.metrics/v1` 스키마의 최대 100개 점만 반환합니다. 조회는 `rcc.host.metrics.read` 감사에 기록됩니다.

4.2의 **조회 경로**는 `GET` 외 모든 메서드를 `405`로 거부합니다. 상태를 바꾸는 경로는 11.4의 작업 API뿐이며 모두 `POST`입니다. 4.1의 heartbeat와 11.4의 에이전트 경로는 사람이 아닌 에이전트 전용이고 브라우저 자격 증명을 절대 받지 않습니다. Beszel이 중단되거나 독자 계정이 잘못되면 메트릭 경로만 `503` 또는 `502`로 실패하며 호스트 상태·작업 API와 RCC 준비 상태는 유지됩니다.

### 4.3 신선도

응답의 `reportState`는 에이전트의 수집 시각을 기준으로 계산합니다.

| 상태 | 의미 |
|---|---|
| `fresh` | 180초 이내 보고 |
| `stale` | 180초 초과 |
| `offline` | 600초 초과 |
| `never-reported` | 등록되었으나 보고 이력 없음 |
| `unknown` | 수집 시각을 해석할 수 없음 |

`never-reported`는 "데이터 없음"과 구분됩니다. systemd를 사용할 수 없는 호스트는 `failedUnitCount`가 `0`이 아니라 `null`입니다.

## 5. 사용자 화면

화면은 `linux-host-manager` subShell이 전적으로 소유합니다.

- 사용자 메뉴와 검색의 진입 경로: `/cc/:ccId/hosts`. 지역 문맥이 없는 `/p/linux-host-manager`는 오래된 호환 경로이며 호스트를 임의 선택하지 않습니다.
- 별칭은 얇은 위임입니다. subShell이 Registry에 없거나 DUPA 검증에 실패하면 "등록되지 않음"으로 표시됩니다. **URL이 존재한다는 사실이 기능이 설치되었다는 뜻이 아닙니다.**
- 목록에는 신선도, 저하/오프라인 상태, 실패한 유닛 수가 표시됩니다.
- 화면은 60초마다 스스로 갱신합니다. 신선도는 수집 시각을 기준으로 계산되므로, 갱신하지 않으면 정지된 화면이 시간이 지나면서 잘못된 답으로 변합니다. 배경 갱신은 화면을 비우지 않으며, 화면에서 벗어나면 타이머가 정리됩니다.
- 상세 기능은 동등한 버튼 11개로 늘어놓지 않고 **요약·관측·보안·유지보수·구성·이력의 여섯 운영 도메인**으로 묶습니다. 도메인 안에는 호스트 개요, 메트릭·서비스·시스템 로그, SSH 보호, 업데이트·재부팅·OS 이미지, 네트워크·스토리지, 작업 이력의 하위 화면이 있습니다. 읽기 상태와 해당 작업의 요청·승인·결과는 같은 도메인 화면에 둡니다. **메트릭은 Beszel의 CPU·메모리·루트 디스크·네트워크·디스크 입출력·부하 시계열을 표시합니다(5.0 참조). 시스템 로그는 제한된 로그 조회, 서비스는 허용된 서비스 재시작, 재부팅은 안전 사전검사와 단일 노드 거부 증거, 네트워크·스토리지·OS 이미지는 각각의 Stage 4 작업을 관리합니다.** **업데이트는 패키지·커널 정비를 요청하고 그 결과까지 확인하는 화면입니다(5.1 참조).** **SSH 보호는 Fail2ban `sshd` 기준선의 준비 상태·활성화·최근 보안 사건·차단·해제를 하나의 운영 흐름으로 관리합니다(5.2 참조).** 작업 이력은 도메인별 요청 폼을 중복하지 않고 호스트의 모든 작업을 한 줄로 모아 보는 승인·감사 화면입니다(11.4 참조).
- 지원하지 않는 구획은 "사용 불가"로 명시합니다. 동작하지 않는 버튼을 그리지 않으며, 권한이나 배포 상태 때문에 쓸 수 없는 컨트롤은 **숨기지 않고 비활성화한 뒤 이유를 표시**합니다.
- 터미널이나 자유 입력 명령 필드는 어느 화면에도 없습니다.
- API가 `404`이면 "설치되지 않음"으로 표시하며 빈 목록으로 오해되지 않게 합니다.

subShell은 `page:register`와 `api:proxy` 두 권한만 요청하며 쓰기 권한을 선언하지 않습니다. 권한 프로필은 `none`입니다.

### 5.0 Metrics 화면 — Beszel 호스트 시계열

Metrics 탭은 RCC가 선택한 호스트와 서버에 등록된 정확한 Beszel 시스템 매핑을 사용합니다. 별도 Beszel 화면을 iframe으로 삽입하거나 브라우저가 Beszel API를 직접 호출하지 않습니다.

| 구획 | 내용 |
|---|---|
| 범위 | 최근 1시간·12시간·24시간·7일·30일 |
| 요약 | 최신 CPU, 메모리, 루트 디스크, 네트워크 송수신, 수집 시각 |
| 차트 | CPU, 메모리, 디스크, 네트워크 송수신, 디스크 읽기·쓰기, 1·5·15분 부하 |
| 출처 | Beszel 시스템 상태, 에이전트 버전, 원천 해상도, 최신 점 나이 |
| 품질 | 누락 구간은 선을 잇지 않고 끊어 표시하며, 잘림·폐기된 점·오프라인 상태를 경고 |

화면의 60초 배경 갱신은 현재 선택 범위를 보존합니다. Beszel 장애는 Metrics 탭 안에서만 명시하고 Overview와 작업 탭의 RCC 데이터는 지우지 않습니다. 반대로 RCC 호스트 권한이 없거나 호스트가 비활성이면 Beszel에 질의하기 전에 거부합니다.

### 5.1 Updates 화면 — 터미널 없이 패키지·커널을 정비하는 곳

관리자는 SSH 없이 이 화면 하나에서 **요청·검토·확인·제출·진행 상황·증거**를 모두 처리합니다. 화면은 위에서 아래로 여섯 부분입니다.

| 구획 | 내용 |
|---|---|
| 상태 | 패키지 관리자 지원 여부, **인덱스 마지막 갱신 시각과 나이**(7일 초과 시 경고), 대기 업데이트 수와 그중 보안 건수, 커널 현재/후보 릴리스, 재부팅 필요 여부 |
| 인덱스 갱신 | `package.refresh` 요청 (1인 승인) |
| 패키지 업데이트 | 대기 목록에서 **개별 선택**, `Select security updates` / `Select all eligible`, 사유 입력, 확인 체크, `Request package update` |
| 커널 업데이트 | 후보 릴리스 고정, **재부팅하지 않는다는 진술**, 사유, 확인 체크, `Request kernel update` |
| Update requests for this host | 이 호스트의 `package.*`·`kernel.update` 요청만 골라 상태·승인 대기 주체·요청 시각·결과를 표로 보여주고, `Details`로 감사 이력을 **같은 화면에서** 엽니다 |
| Maintenance policy | 이 작업들을 지배하는 정책·창·현재 창 개방 여부 |

규율은 다음과 같습니다.

- **선택한 것이 곧 요청되는 것입니다.** 각 행은 `현재 버전 → 후보 버전`을 적고, 제출되는 요청은 **화면에서 검토한 바로 그 후보 버전에 고정**됩니다. 이름만 보내고 버전은 실행 시점에 정하는 형태가 아닙니다.
- **"전부 업데이트"는 없습니다.** 선택은 관리자가 만든 집합이고, 60초 배경 갱신이 그것을 지우지 않습니다. 갱신 결과 후보 버전이 움직이거나 패키지가 목록에서 사라지면 **확인 체크가 해제되고 무엇이 바뀌었는지 화면에 표시**됩니다. 바뀐 사실을 모르는 채로 제출되는 경로가 없습니다.
- **보안 전용 주장은 관리자가 체크했고 선택 집합이 실제로 전부 보안 업데이트일 때만** 요청에 실립니다.
- **커널은 별도이며 재부팅하지 않습니다.** 화면이 그 사실을 문장으로 적고, 요청에 재부팅 파라미터를 싣지 않습니다(12.2).
- **2인 승인은 화면에서 약해지지 않습니다.** `package.update`와 `kernel.update`는 요청 **시점에** "다른 관리자가 승인해야 하며 본인은 자기 요청을 승인할 수 없다"고 명시하고, 이력의 Approval 열도 "you requested it"까지 구분해 적습니다. 읽는 사람이 누구인지 화면이 확신할 수 없으면 승인 컨트롤은 **열리지 않고 닫힙니다.**
- **막힐 때는 이유가 보입니다.** 읽기 전용 제어센터, 지원하지 않는 패키지 관리자, 오래되었거나 보고가 끊긴 스냅샷, 빈 허용 목록, 정책·정비 창 없음, 권한/AAL2 부족, 이미 진행 중인 패키지 작업 — 각각 **버튼을 숨기는 대신 비활성화하고 그 이유를 그대로 적습니다.** 인덱스 갱신만은 예외적으로 "오래됨"을 이유로 막지 않습니다. 그것이 오래됨을 고치는 작업이기 때문입니다.
- **자유 입력은 사유뿐입니다.** 이 화면의 입력 요소는 체크박스와 최대 500자 사유 필드뿐이고, 패키지 이름·버전·명령·플래그를 사람이 타이핑해 넣는 필드는 존재하지 않습니다.

### 5.2 SSH 보호 화면 — 준비·활성화·탐지·대응의 한 운영 흐름

관리자는 Linux 호스트 상세의 **보안 → SSH 보호** 화면에서 다음을 한 흐름으로 확인하고 요청합니다.

| 구획 | 내용 |
|---|---|
| 상태 요약 | 보호 활성 여부, 고정 jail `sshd`, 현재·누적 실패 수, 현재·누적 차단 수, 수집 시각 |
| 준비 점검 | 패키지 설치/정확한 후보 버전, 보호 관리 주소, 로컬 변경 권위, 정비 정책·정비 창, `sshd` jail 검증 상태, RCC 프로필의 정확한 다이제스트 |
| 보호 활성화·재조정 | 미설치·비활성 상태의 고정 `rcc-ssh-baseline-v1` 설치·검증·활성화 또는 RCC 소유 프로필의 보호 주소 드리프트 재조정 요청, 사유, 검토 확인 |
| 정책 | 설치 버전·후보 버전·적용 프로필·다이제스트, `bantime`·`findtime`·`maxretry` |
| 최근 사건 | 최대 100개의 정규화된 탐지(found)·차단(ban)·해제(unban) 시각과 IP 주소. 원시 로그·사용자명·메시지는 표시하지 않음 |
| 차단 목록 | 에이전트가 보고한 정규화된 정확한 IP 주소. 최대 128개이며 잘리면 전체가 아님을 경고 |
| 보호 주소 | 이 호스트에서 절대로 차단할 수 없는 관리 접속 IP 주소. 에이전트 로컬 설정이 정본 |
| 차단 요청 | 정확한 단일 IP 주소, 사유, 검토 확인. CIDR·범위·hostname·jail·기간·명령 입력은 없음 |
| 해제 요청 | 현재 차단 목록에서 하나를 선택하고 사유·검토 확인 |
| SSH 보호 이력 | `ssh.protection.enable`·`ssh.ban`·`ssh.unban` 요청 상태, 다른 관리자 승인 대기, 실행 결과, 감사 이력 |

보안 규율은 다음과 같습니다.

- **설치되지 않았다는 경고에서 끝나지 않습니다.** 화면은 패키지 후보·보호 주소·로컬 권위·정비 정책·정비 창을 각각 점검하고, 모든 게이트가 열렸을 때만 고정 기준선 활성화 요청을 받습니다. 닫힌 게이트는 버튼을 숨기지 않고 정확한 이유를 표시합니다.
- **고정된 것만 표현합니다.** provider는 Fail2ban, jail은 `sshd`, 보호 프로필은 `rcc-ssh-baseline-v1`, 실행 파일과 argv도 코드에 고정됩니다. 셸, 임의 명령, 임의 jail, 기간·옵션·설정 파일 입력 표면이 없습니다.
- **활성화도 검토한 내용에 고정합니다.** 에이전트가 보고한 정확한 패키지 버전, 정렬된 보호 주소, 설치·활성 상태, 기존 RCC 프로필 다이제스트가 승인 내용에 들어갑니다. 실행 직전에 하나라도 달라졌으면 중단합니다. 패키지는 정확한 버전으로 비대화형 모의 실행한 뒤 설치하며, 제거·핵심 패키지 변경·32개를 넘는 트랜잭션을 거부합니다.
- **RCC 소유 설정만 재조정합니다.** 경로가 비어 있거나 정확한 RCC 헤더를 가진 프로필만 만들거나 바꿉니다. RCC 기준선과 다른 보호 주소를 가진 RCC 프로필은 드리프트로 표시하고 같은 승인 절차로 재조정할 수 있지만, 다른 도구나 사람이 만든 외부 내용·심볼릭 링크·비정규 파일은 덮어쓰지 않습니다.
- **설정은 원자적으로 만들고 검증합니다.** 임시 파일 쓰기·파일 동기화·이름 바꾸기·디렉터리 동기화 후 `fail2ban-client -t`로 전체 설정을 검증합니다. 서비스가 이미 동작 중이면 정지하지 않고 `reload`, 아니면 `start`하며, enable 상태가 아니면 별도로 enable합니다. 마지막에 `fail2ban-client status sshd`로 증명합니다. 실패하면 취소된 작업 문맥과 분리된 제한 시간 안에서 정확한 이전 프로필과 서비스 active/enabled 상태를 복원합니다. 작업 전부터 동작하던 다른 jail까지 정지시키지 않으며, 설치된 패키지를 파괴적으로 제거하지는 않습니다.
- **정확한 단일 IP만 받습니다.** CIDR 범위, hostname, 비정규 주소, unspecified·loopback·multicast·link-local 주소는 거부합니다.
- **보호 관리 주소는 이중으로 막습니다.** 요청 API와 노드 에이전트가 각각 `sshBanProtectedAddresses`를 확인하고 차단을 거부합니다. 보호 주소가 하나도 선언되지 않으면 `sshBanEnabled` 설정 자체가 기동 단계에서 거부됩니다.
- **검토한 상태와 실행 상태를 묶습니다.** 차단 요청은 검토 시점에 해당 주소가 차단되지 않았다는 사실, 해제 요청은 차단되어 있었다는 사실을 계획에 고정합니다. 에이전트는 실행 직전에 실제 `sshd` jail을 다시 읽고 상태가 움직였으면 아무것도 바꾸지 않습니다.
- **성공 응답을 그대로 믿지 않습니다.** 고정 명령 뒤에 상태를 다시 읽어 목표 상태에 도달했음을 증명한 뒤에만 성공 수령증을 보냅니다. 상태 출력이 누락되거나 이해할 수 없으면 fail-closed로 중단합니다.
- **고위험 작업입니다.** 세 작업 모두 요청자와 다른 관리자의 2인 승인, AAL2, `console.hosts.ssh-ban` 권한이 필요합니다. 활성화는 패키지·서비스·설정을 바꾸므로 정비 정책과 열린 정비 창까지 요구합니다. 차단·해제는 사고 대응이므로 정비 창을 요구하지 않습니다. 모두 기존 append-only 감사 경로를 사용합니다.
- **기본은 읽기 전용입니다.** `collectSSHBan`은 기본 true이고 `sshBanEnabled`는 기본 false입니다. 화면과 바이너리를 배포하는 것만으로 기존 차단 목록이나 Fail2ban 설정이 바뀌지 않습니다.

## 6. 설치

### 6.1 데이터베이스

RCC 호스트 제어는 마이그레이션 일곱 개로 이루어집니다. **순서대로 전부** 적용해야 하며, 어느 하나를 건너뛰면 다음 것이 실패합니다.

| 마이그레이션 | 추가하는 것 |
|---|---|
| `0027_linux_host_authority.sql` | 등록·스냅샷·작업 테이블, Stage 1/2 권한 |
| `0028_host_operation_governance.sql` | 작업 카탈로그, 전체 상태 기계, 승인·lease·수령증 |
| `0029_host_maintenance_recovery.sql` | 정비 저하 기록, 검토 내용 불변식 |
| `0030_host_maintenance_policy.sql` | 정비 창 정책, 정책 변경 기록 |
| `0031_host_network_storage_image.sql` | Stage 4 작업·권한·롤백 상태 |
| `0032_host_ssh_ban.sql` | 고정 Fail2ban `sshd` jail의 차단·해제 작업과 전용 고위험 권한 |
| `0033_host_ssh_protection.sql` | 고정 Fail2ban 기준선의 설치·검증·활성화 작업 |

CC2에 실제로 적용되는 것은 이 일곱 개를 접어 넣은 **`deploy/rcc/supabase-baseline.sql`**입니다(`deploy-cc2.sh`가 적용합니다). 마이그레이션은 리뷰의 정본이고 baseline은 배포되는 것이며, 둘은 같은 데이터베이스를 만들어야 합니다 — `npm run test:db`가 두 경로를 각각 세우고 결과를 비교합니다.

아래가 생성됩니다.

| 객체 | 역할 |
|---|---|
| `console.host` | 등록 정본. 상태 `pending` → `active` → `retired` |
| `console.host_snapshot` | 호스트당 최신 스냅샷 1건, `received_at`과 `payload_digest` 포함 |
| `console.host_operation` | Stage 2 작업 권위. 상태 전이는 데이터베이스 트리거가 강제 |
| `console.host_operation_event` | 추가 전용 작업 이력 |
| `console.hosts.read` | Stage 1 조회 권한 |
| `console.hosts.operate` | `service.restart`와 `host.reboot` 요청 권한 (Stage 2) |
| `console.hosts.journal` | `journal.query` 요청 권한 (Stage 2, migration 0028) |
| `console.hosts.approve` | 고위험 작업 승인 권한 (Stage 2, migration 0028) |
| `console.host_operation_type` | 실행 가능한 작업 카탈로그 (Stage 2, migration 0028) |
| `console.host_policy` / `console.host_maintenance_window` | 정비 창 정책 (Stage 3, migration 0030) |
| `console.host_policy_change` | 정책 편집의 추가 전용 기록 (migration 0030, 12.8 참조) |
| `console.hosts.packages` | 패키지·커널 작업 요청 권한 (Stage 3, migration 0030) |
| `console.hosts.network` / `.storage` / `.osimage` | Stage 4 작업 요청 권한 (migration 0031) |
| `console.hosts.ssh-ban` | SSH 보호 활성화·차단·해제 요청 권한 (운영 기능 단위 3, migrations 0032–0033) |

`console.host_operation`의 전이 규칙은 `console.host_operation_transition_allowed()`가 판정하며, 완료 상태와 `completed_at`의 일관성은 테이블 제약이 강제합니다. 추가로 두 가지가 데이터베이스 수준에서 강제됩니다.

- **제어센터 일치**: `host_uuid`와 `control_center_id`는 복합 외래키 `(host_uuid, control_center_id) → console.host (id, control_center_id)`로 묶입니다. 한 제어센터에서 승인된 작업이 다른 제어센터의 호스트를 가리키는 상태 자체가 표현 불가능합니다.
- **검토 내용 불변**: 요청이 `requested`를 벗어나는 순간부터 `parameters`와 `reason`은 변경할 수 없습니다. 승인과 동시에 내용을 바꾸는 단일 UPDATE도 거부되므로, 승인된 것과 실행되는 것이 달라질 수 없습니다.

Stage 2 스키마는 `backend/supabase/migrations/0028_host_operation_governance.sql`이 추가합니다. 승인·lease·수령증·정비 증거 컬럼, 전체 상태 기계, 호스트당 동시 실행 1건을 강제하는 부분 유니크 인덱스가 여기에 있습니다.

### 6.2 백엔드

Console 백엔드는 `RCC_AGENT_KEYS_FILE` 경로에서 에이전트 키 문서를 읽습니다. CC2 배포에서는 Secret `polyon-rcc-agent-keys`를 읽기 전용으로 마운트한 경로입니다.

```
RCC_AGENT_KEYS_FILE=/etc/rcc/agent-keys/agent-keys.json
```

```sh
kubectl -n polyon-rcc create secret generic polyon-rcc-agent-keys \
  --from-file=agent-keys.json=<키 문서 경로>
```

문서 형식은 `{"version":1,"keys":[…]}`이고 각 항목은 다음을 갖습니다.

| 필드 | 의미 |
|---|---|
| `keyId` | 키 식별자 |
| `secret` | 공유 비밀 (최소 32바이트) |
| `controlCenterId` | 바인딩된 제어센터 |
| `hostId` | 바인딩된 호스트 |
| `status` | `active` 또는 `revoked` (생략 시 `active`) |

`active`가 아닌 키는 거부되며, 알 수 없는 키와 폐기된 키는 호출자에게 구분되지 않습니다(둘 다 401). 파일이 없거나 형식이 잘못되면 백엔드는 heartbeat 경로를 열지 않고 `503`으로 닫습니다. Secret은 선택 사항이므로 호스트를 등록하기 전에도 제어센터는 기동합니다.

Secret 볼륨은 root 소유이므로 백엔드 Pod은 `fsGroup`을 설정하고 파일 모드는 소유자·그룹 읽기 전용(`0440`)입니다. `fsGroup` 없이 `0400`으로 두면 비root 프로세스가 키 문서를 아예 읽지 못합니다.

### 6.3 호스트

1. 호스트를 `pending` 상태로 등록하고 키 ID를 발급합니다.
2. 바이너리와 유닛 파일을 설치합니다: `sudo backend/rcc-node-agent/packaging/install.sh`
3. `/etc/rcc-node-agent/agent.json`에 제어센터, 호스트 ID, 엔드포인트, 키 ID를 채우고 `/etc/rcc-node-agent/agent.key`에 공유 비밀을 배치합니다. 두 파일 모두 root 소유입니다.
4. `sudo rcc-node-agent --check`로 설정과 수집 결과를 확인합니다.
5. `sudo systemctl enable --now rcc-node-agent`
6. RCC 화면에서 해당 호스트가 `fresh`로 바뀌는지 확인합니다.

제거는 `sudo backend/rcc-node-agent/packaging/uninstall.sh`입니다.

### 6.4 subShell

RCC는 DUPA 제어면을 실행하지 않으므로, Registry v3 문서와 서명된 자산은 이미지 빌드 시점에 생성해 정적으로 제공합니다. 검증은 하나도 생략되지 않습니다 — Main Shell은 여전히 registry 다이제스트 핀, 분리된 ECDSA P-256 서명, `shellCompat`, capability 허용목록, entry 번들 다이제스트를 모두 확인한 뒤에야 코드를 실행합니다.

1. 다이제스트 재고정: `node scripts/build-subshell-manifest.mjs`
2. 서명 키와 **예상 공개키 지문**을 외부에서 주입해 이미지 빌드:

   ```sh
   openssl pkey -in /secure/path/rcc-plugins-p256.pem -pubout -outform DER \
     | openssl dgst -sha256

   RCC_PLUGIN_SIGNING_KEY=/secure/path/rcc-plugins-p256.pem \
   RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256=<위에서 얻은 지문> \
   ./deploy/rcc/deploy-cc2.sh
   ```

키는 BuildKit secret으로만 전달되며 저장소·이미지·레이어에 남지 않습니다. 두 변수 모두 필수입니다.

descriptor의 `trust.keyId`는 **라벨일 뿐**입니다. 어떤 P-256 키든 임의의 라벨로 제시할 수 있으므로 라벨이 일치한다는 사실은 어떤 개인키가 제공되었는지 증명하지 못합니다. 실제로 키를 식별하는 검사는 지문 대조뿐이며, 지문은 키 파일 바깥에서 와야 합니다. 우회 경로는 없습니다.

이 기능을 의도적으로 빼고 배포하려면 `RCC_DISABLE_LINUX_HOST_MANAGER=1`을 설정합니다. 이 플래그는 서명 검사를 완화하지 않으며 — 서명되지 않은 코드는 어떤 경우에도 로드되지 않습니다 — 단지 기능을 포함하지 않을 뿐입니다. 기본값은 꺼짐이고 정상 CC2 경로가 아닙니다.

제공되는 경로는 다음과 같습니다.

| 경로 | 제공 주체 | 내용 |
|---|---|---|
| `/api/v1/registry` | web (정적) | Registry v3 문서: 다이제스트 핀과 신뢰 공개키 |
| `/plugins/<id>/…` | web (정적) | 서명된 manifest, 분리 서명, entry 번들 |
| `/api/plugins/linux-host-manager/…` | backend | subShell의 정규 API 네임스페이스 |

**서명 키 없이 빌드하면 registry 자체가 이미지에 포함되지 않습니다.** `/api/v1/registry`가 404가 되고 셸은 플러그인 0개로 기동하며 `/cc/:ccId/hosts`는 "등록되지 않음"을 표시합니다. 서명되지 않은 로드 경로는 존재하지 않습니다.

## 7. 운영 절차

- **호스트가 `offline`으로 보일 때**: 호스트에서 `systemctl status rcc-node-agent`와 아웃바운드 HTTPS 도달성을 확인합니다. RCC에서 호스트로 접속하지 않습니다.
- **`never-reported`가 계속될 때**: 키 ID 바인딩이 등록된 호스트와 일치하는지 확인합니다. 불일치는 401로 거부되며 스냅샷이 저장되지 않습니다.
- **키 회전**: 새 키 ID를 문서에 `status: "active"`로 추가 → Secret 갱신 → 백엔드 재시작(키 문서는 기동 시 1회 읽습니다) → 호스트의 `agent.json`·`agent.key`와 `console.host.agent_key_id`를 새 키로 갱신 → 보고가 `fresh`로 돌아오는지 확인 → 이전 항목을 `status: "revoked"`로 바꾸거나 삭제. 키 문서는 두 키를 동시에 `active`로 둘 수 있으므로 백엔드는 재시작 한 번으로 양쪽을 받아들입니다. 다만 **호스트 바인딩은 `console.host.agent_key_id` 한 개**이므로 회전은 무중단이 아닙니다: 호스트의 `agent.key`와 이 열을 갱신하는 사이에 보고가 401로 거부되고 그 스냅샷은 저장되지 않습니다. 간격은 보통 한 주기(약 60초) 안이며 다음 보고가 그대로 복구합니다. 미등록 키는 어느 단계에서도 수용되지 않습니다.
- **호스트 폐기**: 등록을 `retired`로 바꾸면 조회에서 제외되고 heartbeat는 404로 거부됩니다.
- **감사 확인**: 운영자 조회 이력은 Console 감사에서 `rcc.host.*`로 조회합니다. 에이전트 수집은 사람 행위가 아니므로 운영자 감사에 기록하지 않고 `console.host_snapshot`의 `received_at`과 `payload_digest`가 내구 기록입니다.

## 8. 현재 구현 상태

| 항목 | 상태 |
|---|---|
| 에이전트 스냅샷 수집·보고 | 구현 |
| 서명 검증·재생 방지·바인딩 검사 | 구현 |
| Supabase 호스트 권위와 스냅샷 저장 | 구현 |
| 운영자 목록·상세 조회 | 구현 |
| subShell 화면과 `/cc/:ccId/hosts` 별칭 | 구현 |
| 패키지 인벤토리·커널 상태 보고 | 구현 (Stage 3) |
| 패키지 인덱스 갱신(`package.refresh`) | 구현 (Stage 3) |
| 허용 목록 기반 패키지 업데이트(`package.update`) | 구현 (Stage 3) |
| 커널 설치(`kernel.update`, 재부팅 없음) | 구현 (Stage 3) |
| 정비 창 정책(HostPolicy, DST 안전) | 구현 (Stage 3) |
| 저널 조회(`journal.query`) | 구현 (Stage 2) |
| 서비스 재시작(`service.restart`, allowlist) | 구현 (Stage 2) |
| 호스트 재부팅(`host.reboot`, cordon/drain 포함) | 구현 (Stage 2) |
| 2인 승인·AAL2·내용 digest 고정 | 구현 (Stage 2) |
| 정확히 한 번 실행·크래시 복구·수령증 재전송 | 구현 (Stage 2) |
| 패키지·커널 업데이트 | 구현 (Stage 3, 12장) |
| 네트워크·스토리지 변경, 이미지 기반 OS 업데이트 | 구현 (Stage 4, 13장) |
| 고정 Fail2ban 기준선의 설치·검증·활성화 | 구현 (운영 기능 단위 3, 17장) |
| 고정 Fail2ban `sshd` jail의 SSH 차단·해제 | 구현 (운영 기능 단위 3, 17장) |
| 임의 유닛 제어(start/stop/enable), 파일시스템 포맷·파티션·축소 | 구현하지 않음. 표현 자체가 불가능합니다 |
| 원격 셸·터미널·임의 명령 실행 | 구현하지 않음. 이후 단계에서도 도입하지 않습니다 |

## 9. 한계

- 호스트를 바꾸는 수단은 카탈로그에 있는 14개 타입 작업뿐입니다(11장·12장·13장·17장). 그 밖의 모든 구획은 읽기 전용이며, 지원하지 않는 대상에는 자리 표시가 아니라 명시적 "사용 불가"와 그 이유가 표시됩니다.
- 스냅샷은 주기 보고이므로 실시간 스트림이 아닙니다. 신선도 표시를 근거로 판단해야 합니다.
- 저널과 원시 로그 본문은 스냅샷에 수집하지 않습니다. 유일한 예외는 Fail2ban 로그에서 고정 `sshd` jail의 시각·동작(found/ban/unban)·정확한 IP 주소만 파싱한 최근 사건 최대 100개이며, 원문·사용자명·자유 메시지는 버립니다.
- 호스트당 스냅샷은 최신 1건만 유지하며 시계열 저장소가 아닙니다.
- `linux-host-manager`가 등록·검증되지 않은 환경에서는 별칭 URL이 열려도 기능이 제공되지 않습니다.
- 백엔드는 키 문서를 기동 시 1회만 읽습니다. 키를 회전하면 백엔드 재시작이 필요합니다.
- **정적 registry의 신뢰 경계**: RCC는 DUPA 제어면을 실행하지 않습니다. 셸의 로드 시점 검증(다이제스트 핀, P-256 분리 서명, `shellCompat`, capability 허용목록, entry 다이제스트, Blob 실행, 최소 권한 ctx)은 그대로 수행됩니다. 다만 **공개키와 서명된 번들이 같은 이미지에 함께 실립니다.** 따라서 런타임이 보장하는 것은 *그 이미지에 내장된 신뢰 문서를 기준으로 한 내부 정합성과 무결성*입니다 — 손상, 잘림, 의도치 않은 drift, 빌드 이후 단일 아티팩트 변조는 탐지됩니다.

  그러나 이것이 출처(provenance)나 진정성을 독립적으로 증명하지는 **않습니다.** 이미지를 만들 수 있는 주체는 다른 키와 그 키로 서명한 번들을 함께 넣을 수 있고, 런타임 검증은 통과합니다. 따라서 진정성은 ① 배포되는 이미지 digest의 불변성과 승인 체계, ② 통제된 빌드 과정, ③ 서명 키와 빌드 시점에 고정한 지문의 관리에 의존합니다. **신뢰 앵커는 웹 이미지입니다.** 서명은 주어진 이미지 안에서 무엇이 바뀔 수 있는지를 좁혀줄 뿐, 그 이미지가 어디서 왔는지를 증명하지 않습니다.

  OCI digest 해석, cosign attestation, SLSA provenance, permission profile admission, 런타임 설치/제거, 키 회전·폐기 체계는 없습니다. 플러그인 집합은 이미지 수명 동안 고정되며 키 폐기는 이미지 재빌드·재배포로만 가능합니다.
- Network 구획은 주소·MTU·링크 상태·드라이버까지 보여주지만(13.1), MAC 주소는 어느 단계에서도 수집하지 않으며 무선·VPN·802.1X 설정 필드는 요청조차 하지 않습니다.

## 10. 다음 단계 경계

Stage 2는 아래 11장에, Stage 3은 12장에, Stage 4는 13장에, SSH 보호 운영은 17장에 구현되어 있습니다. 모두 같은 승인·감사·수령증 구조를 따릅니다. 일반 유닛의 start/stop/enable은 Stage 4에 포함되지 않았고, `ssh.protection.enable`만 코드에 고정된 `fail2ban.service`를 고정 기준선의 일부로 활성화합니다. 원격 셸과 임의 명령 실행은 어느 단계에서도 도입하지 않습니다.

OCI 전달과 cosign/SLSA attestation으로의 승격은 Stage 2가 아니라 선택적인 향후 거버넌스 강화 항목입니다.

## 11. Stage 2 — 통제된 타입 작업

### 11.1 작업 카탈로그

실행 가능한 작업 집합은 코드가 아니라 데이터(`console.host_operation_type`)이며, 목록에 없는 작업은 데이터베이스가 외래키로 거부합니다.

| 작업 | 위험도 | 2인 승인 | Kubernetes 정비 | 필요 권한 | 최대 lease |
|---|---|---|---|---|---|
| `journal.query` | low | 불필요 | 불필요 | `console.hosts.journal` | 120초 |
| `service.restart` | high | **필요** | 불필요 | `console.hosts.operate` | 300초 |
| `host.reboot` | high | **필요** | **필요** | `console.hosts.operate` | 900초 |

Stage 3/4 작업은 12장·13장에 있으며 카탈로그의 다음 8개 행입니다. SSH 보호 작업 3개는 17장에 있습니다. 전체 목록은 배포된 데이터베이스에서 직접 확인할 수 있습니다.

```sql
SELECT operation, risk_level, requires_second_person, requires_maintenance,
       requires_policy, requires_rollback, required_permission, max_lease_seconds
  FROM console.host_operation_type ORDER BY operation;
```

승인 권한은 별도입니다: `console.hosts.approve`.

**기본 권한 부여.** 마이그레이션이 부여하는 것은 다음이 전부입니다.

| 역할 | 기본으로 갖는 권한 |
|---|---|
| `console-admins` | `console.hosts.read`, `.journal`, `.approve`, `.packages`, `.network`, `.storage`, `.osimage`, `.ssh-ban` |
| `console-operators` | `console.hosts.read`, `console.hosts.journal` |

즉 **`console.hosts.operate`는 어떤 역할에도 기본 부여되지 않습니다.** `service.restart`와 `host.reboot`을 요청하려면 의도적으로 부여해야 합니다.

```sql
-- 예: console-operators에게 서비스 재시작 요청 권한을 부여
INSERT INTO console.role_permission (role_id, permission_id)
SELECT r.id, p.id FROM console.role r CROSS JOIN console.permission p
 WHERE r.code = 'console-operators' AND p.code = 'console.hosts.operate'
ON CONFLICT DO NOTHING;
```

2인 승인이 의미를 가지려면 요청 권한과 `console.hosts.approve`를 **서로 다른 사람**이 가져야 합니다. 한 사람이 둘 다 가지면 데이터베이스는 여전히 "요청자와 승인자가 같을 수 없다"를 강제하지만, 그 사람이 두 계정을 쓰는 것까지 막지는 못합니다.

### 11.2 상태 기계

```
requested ─┬─> awaiting_approval ─┬─> approved ─┬─> preparing ─> dispatchable ─> leased ─> running ─┬─> succeeded
           │                      │             │                      │                            └─> failed
           │                      │             └─> dispatchable ──────┘
           ├─> approved (low risk, 단일 승인)
           ├─> rejected
           ├─> cancelled
           └─> expired
```

데이터베이스 트리거가 강제하는 불변식:

- **종료 상태는 불변**입니다. `completed_at`이 설정된 행은 어떤 컬럼도 바꿀 수 없습니다.
- **시작된 작업은 절대 다시 큐에 들어가지 않습니다.** `running -> dispatchable` 전이는 금지되고, `leased`에서도 `started_at`이 있으면 금지됩니다. **lease 만료가 이미 시작된 작업을 다시 실행 가능하게 만들 수 없습니다.**
- **승인 없이는 에이전트에 도달할 수 없습니다.** `preparing`/`dispatchable`/`leased`/`running`은 `approved_digest = content_digest`를 요구합니다.
- **각 lease는 새 attempt 번호를 써야 하고** 타입별 최대치를 넘을 수 없습니다.
- **결과 없이는 종료할 수 없고**, 저장된 결과는 불변입니다.
- 호스트당 동시 실행은 1건입니다(부분 유니크 인덱스).
- 제어센터가 `read-only` 모드면 dispatch 자체가 거부됩니다.

### 11.3 2인 승인과 내용 고정

고위험 작업은 **요청자와 승인자가 서로 달라야 하고**, 두 사람 모두 해당 제어센터에 현재 배정되어 있어야 하며, 둘 다 AAL2가 필요합니다.

승인은 `content_digest`(작업 종류 + 파라미터의 정규 JSON sha256)를 고정합니다. 승인 후 파라미터나 사유를 바꾸려 하면 트리거가 거부하고, 승인 전 편집은 digest를 바꾸므로 기존 승인이 무효가 됩니다. **승인된 것과 실행되는 것이 달라질 수 없습니다.**

### 11.4 API

**운영자 (Supabase 세션 + 권한 + 제어센터 배정)**

```
GET  /api/control-centers/{ccId}/hosts/{hostId}/operations      작업 이력
POST /api/control-centers/{ccId}/hosts/{hostId}/operations      작업 요청
GET  /api/control-centers/{ccId}/operations/{id}                상세 + 타임라인
POST /api/control-centers/{ccId}/operations/{id}/approve        승인
POST /api/control-centers/{ccId}/operations/{id}/reject         거부
POST /api/control-centers/{ccId}/operations/{id}/cancel         취소(시작 전까지)
```

subShell은 `/api/plugins/linux-host-manager/…` 접두사로 같은 경로를 읽습니다.

요청 본문의 `status`, `requested_by`, `approved_by`, `content_digest`는 **무시됩니다.** 요청자 신원은 세션에서, 상태는 서버에서, digest는 정규화된 파라미터에서 다시 계산합니다.

**에이전트 (HMAC 서명 전용, 아웃바운드)**

```
POST /api/control-centers/{ccId}/hosts/{hostId}/operations/poll     다음 작업 수령
POST /api/control-centers/{ccId}/hosts/{hostId}/operations/start    실행 시작 보고
POST /api/control-centers/{ccId}/hosts/{hostId}/operations/receipt  결과 제출
```

세 경로는 서명 채널의 허용 목록에 **정확히** 등재되어 있습니다. 브라우저 네임스페이스(`/api/plugins/…`)에서는 404이며, 브라우저 Bearer 토큰은 어떤 경우에도 수락되지 않습니다.

`poll`은 작업이 없으면 `204`, 있으면 `200`과 plan을 반환합니다.

`receipt`의 `409`는 **그 자체로는 성공이 아닙니다.** 제어센터가 (1) 이미 기록되었음을 명시하고, (2) 같은 operation id와 attempt를 되돌려주며, (3) 보관 중인 receipt의 digest가 에이전트가 방금 보낸 바이트의 digest와 **정확히 일치**할 때만 멱등 응답으로 받아들입니다. 하나라도 어긋나면 에이전트는 이를 불일치로 보고 실패시킵니다. 제어센터와 호스트가 서로 다른 결과를 들고 있으면서 아무도 모르는 상태가 생기지 않도록 하기 위해서입니다.

`start` 역시 operation id만이 아니라 제어센터·호스트·작업 종류·승인된 content digest·attempt를 **전부 다시 진술**하며, 하나라도 어긋나면 거부됩니다.

### 11.5 Plan과 Receipt

plan은 요청뿐 아니라 **응답도 서명됩니다**(`RCC-PLAN-V1`). 서명은 본문·key id·제어센터·호스트·operation id·attempt·발급 시각·nonce를 함께 묶으므로, HTTPS를 종단한 무언가가 plan을 바꿔치기하거나 예전 plan을 재생할 수 없습니다. 에이전트는 상수 시간으로 검증하고, 서명이 없거나 다른 키로 서명되었거나 nonce가 재사용되면 거부합니다. HTTPS 요구는 그대로 유지됩니다.

에이전트는 plan이 주장하는 `contentDigest`를 믿지 않고 **plan이 실제로 담고 있는 파라미터로부터 다시 계산**해 정확히 일치할 때만 실행합니다. 정규화 규칙은 백엔드와 바이트 단위로 같습니다. 따라서 제어센터가 잘 만들어진 digest 아래에 다른 파라미터를 넣어 보내는 것이 불가능합니다.

plan(`rcc.host.plan/v1`)은 호스트·작업·attempt에 묶이고 유효 창이 제한됩니다. 에이전트는 다음을 모두 거부합니다.

| 거부 사유 | 설명 |
|---|---|
| 스키마 버전 불일치 | 정확히 일치해야 합니다 |
| 알 수 없는 필드 | `DisallowUnknownFields` — 이해하지 못하는 필드는 무시가 아니라 거부 |
| 다른 호스트/제어센터 | 서명이 유효해도 자기 것이 아니면 거부 |
| 만료·미도래·lease 만료 | ±5분 시계 오차만 허용 |
| 유효 기간 60분 초과 | 상한은 가장 긴 임대(`osimage.stage`, 3600초)를 담을 수 있어야 하므로 60분입니다. 임대가 자기 계획보다 오래 살 수는 없습니다 |
| 알 수 없는 작업 타입 | |
| 인자 블록이 0개 또는 2개 이상 | |
| 32 KiB 초과 | |

receipt(`rcc.host.receipt/v1`)는 서명 채널 본문 한도(64 KiB) 안에 들어가야 하며, 저널 출력은 48 KiB로 제한됩니다.

### 11.6 정확히 한 번 실행(exactly-once)

에이전트는 `/var/lib/rcc-node-agent`에 작업별 JSON 파일 1개를 둡니다. 쓰기는 임시 파일 → fsync → rename → 디렉터리 fsync 순서로 원자적이며, 파일 모드는 `0600`, 디렉터리는 `0700`입니다.

```
claim(op)     의도를 디스크에 기록  ← 이 이후에만 부수효과가 허용됩니다
<실행>
complete(op)  receipt를 디스크에 기록 ← 이후 무한히 재전송 가능
```

- **재전달**: 이미 알고 있는 작업이면 재실행하지 않고 저장된 receipt를 그대로 재전송합니다.
- **네트워크 실패**: receipt는 이미 durable하므로 다음 poll에서 동일 바이트로 재전송됩니다.
- **크래시**: intent만 있고 receipt가 없는 기록은 **재시도하지 않고** "결과 불명, 재시도하지 않음"으로 종료합니다. 부수효과가 어디까지 갔는지 알 수 없기 때문입니다. **한 가지 예외가 Stage 4에 있습니다**: `network.configure`는 변경 *이전에* 되돌리기 기록을 디스크에 남기므로, 다음 기동에서 작업을 재시도하는 대신 네트워크를 원래대로 되돌립니다(13.9). 재시도가 아니라 복구이며, 이 방향은 결과가 불명이어도 안전한 유일한 경우입니다.
- **보존**: 완료 기록은 최대 200건 / 30일이며, 미완료 기록은 절대 정리되지 않습니다.

### 11.7 세 가지 작업

**journal.query** — `journalctl` argv를 셸 없이 실행합니다. 유닛(최대 8개), 우선순위, since/until, 커서, 줄 수(최대 2000), 바이트(최대 48 KiB)가 모두 제한됩니다. `--follow`나 페이저는 사용하지 않습니다. 출력에서 제어문자를 제거하고 잘림 여부를 함께 보고합니다. 호스트를 변경하지 않습니다.

**service.restart** — `systemctl restart <unit>` argv를 셸 없이 실행합니다. **두 관문을 모두 통과해야 합니다.**

1. 코드에 내장된 거부 목록 — 설정으로 되돌릴 수 없습니다: `rcc-node-agent`, `k3s`/`k3s-agent`/`kubelet`/`containerd`/`crio`/`docker`, `sshd`/`ssh`, `systemd-networkd`/`NetworkManager`/`network`/`systemd-resolved`, `firewalld`/`nftables`/`iptables`/`ufw`, `systemd-udevd`/`systemd-journald`/`systemd-logind`/`dbus`, `lvm2-*`/`multipathd`/`iscsid`/`rbdmap`/`ceph-*`, `etcd`/`kube-apiserver`/`kube-scheduler`/`kube-controller-manager`, `init`/`systemd`.
2. **제어센터가 부여한 허용 목록**(`console.host.restart_allowlist`)과 **에이전트가 자기 설정에서 받아들이는 목록**(`restartAllowlist`)의 **교집합**. 양쪽 모두 허용해야 재시작할 수 있습니다.
   - 둘 다 **기본값이 빈 목록**이므로, 새로 등록한 호스트는 아무것도 재시작하지 않습니다.
   - 콘솔이 버튼을 만들 때 쓰는 것은 **제어센터가 부여한 목록**입니다. 에이전트가 보고한 목록만으로는 아무 권한도 생기지 않습니다. 잘못 설정되었거나 침해된 에이전트가 "나는 이 유닛들을 재시작한다"고 보고해서 콘솔에 그럴듯한 버튼을 만들어내는 일을 막기 위해서입니다.
   - 양쪽이 어긋나면 UI가 그 차이를 명시적으로 표시하고, 교집합만 제공합니다.

재시작 전후의 `systemctl is-active` 결과를 증거로 기록합니다.

**host.reboot** — Kubernetes 정비를 통과한 뒤에만 실행됩니다. 재부팅 직전에 boot id와 마감 시각을 디스크에 기록하고, `systemctl reboot`만 호출합니다(`shutdown`/`poweroff`/`halt`/`kexec`는 구현되어 있지 않습니다). 재기동 후 **boot id가 실제로 바뀐 것을 확인**해야 성공으로 보고하며, 마감 시각이 지나도 바뀌지 않으면 실패로 보고합니다.

### 11.8 Kubernetes 정비 조정

재부팅이 dispatchable이 되기 전에 조정기가 실제 클러스터를 확인합니다.

조정기의 원칙은 하나입니다: **계산할 수 없는 것은 통과시키지 않습니다.** 읽지 못한 값, 이해하지 못한 필드, 판단할 수 없는 제약은 모두 차단 사유입니다. 재부팅을 거부하는 비용은 재시도이지만, 불완전한 정보로 진행하는 비용은 장애입니다.

| 검사 | 차단 조건 |
|---|---|
| Host → Node 해석 | 매칭 0개 또는 2개 이상이면 거부(추측하지 않음) |
| Node Ready | NotReady면 차단 |
| 리소스 압력 | 경고(차단 아님) |
| 단일 노드 클러스터 | **차단**(어떤 설정으로도 해제 불가) |
| 마지막 Ready control-plane | **차단** |
| etcd 토폴로지 미선언 | control-plane 노드면 **차단** — 아래 참조 |
| etcd 정족수 | 재부팅 후 Ready 멤버가 정족수 미만이면 차단 |
| 실제 여유 용량 | 축출될 Pod가 갈 곳이 없으면 차단 — 아래 참조 |
| PodDisruptionBudget | **축출 대상 Pod를 실제로 선택하는** 예산이 여유 0이면 차단 |
| 평가 불가능한 PDB selector | 차단(무시하지 않음) |
| 컨트롤러 없는 Pod | 재스케줄되지 않으므로 차단(정책으로도 해제 불가) |
| hostPath 볼륨 | 데이터가 노드에 고정되어 있으므로 차단(정책으로도 해제 불가) |
| Pod 500개 초과 | 차단 |
| DaemonSet/static Pod, emptyDir 데이터 | **선언된 정책이 없으면 차단** — 아래 참조 |
| 시뮬레이션 불가능한 스케줄링 제약 | 차단(required affinity, DoNotSchedule spread, 커스텀 스케줄러) |

**etcd 토폴로지는 선언되어야 합니다.** control-plane 레이블은 etcd 멤버십의 증거가 아닙니다 — 외부 etcd를 쓰는 kubeadm 클러스터는 etcd가 클러스터 밖에 있는데도 API 서버에 control-plane 레이블을 붙입니다. 레이블을 세면 실제 멤버십과 무관한 정족수 숫자가 자신 있게 나옵니다. 그래서 `RCC_ETCD_TOPOLOGY`를 `stacked` 또는 `external`로 선언해야 하며, 선언하지 않으면 control-plane 노드 재부팅은 거부됩니다. 선언 후에는 실제 증거(`node-role.kubernetes.io/etcd` 레이블, `etcd.k3s.cattle.io/*` 어노테이션, kube-system의 static `etcd-<node>` Pod)와 대조하여 **선언이 클러스터와 모순되면 그것도 차단**합니다.

**용량은 시뮬레이션합니다.** "다른 Ready 노드가 있다"는 답이 아닙니다. cordon되어 있거나, 해당 Pod가 tolerate하지 않는 taint가 있거나, allocatable에서 이미 예약된 request를 뺀 여유가 부족한 노드는 그 Pod를 받지 않습니다. 조정기는 축출될 Pod마다 요청량(sidecar init container 포함)을 계산하고, 큰 것부터 실제로 배치해 봅니다. 읽을 수 없는 수량이나 계산할 수 없는 제약이 하나라도 있으면 차단합니다.

**옮길 수 없는 Pod는 선언된 결정을 요구합니다.** DaemonSet Pod와 static Pod는 축출되지 않고 노드와 함께 재시작하며, emptyDir 내용은 이동 과정에서 사라집니다. 이것들을 조용히 건너뛰면 "drain 성공"이라고 보고하면서 실제로는 워크로드가 그대로 남습니다. 그래서 각각을 배포 매니페스트에서 명시적으로 선언해야 하고, 선언하지 않으면 재부팅이 거부됩니다.

| 환경 변수 | 값 | 기본 동작 |
|---|---|---|
| `RCC_DRAIN_DAEMONSET_PODS` | `leave-in-place` | 미선언 시 **거부** |
| `RCC_DRAIN_STATIC_PODS` | `leave-in-place` | 미선언 시 **거부** |
| `RCC_DRAIN_EMPTYDIR_DATA` | `accept-data-loss` | 미선언 시 **거부** (배포 기본값도 `refuse`) |

**축출은 완료를 확인합니다.** eviction API의 201은 요청이 접수되었다는 뜻이지 워크로드가 옮겨갔다는 뜻이 아닙니다. 조정기는 각 Pod가 실제로 노드를 떠날 때까지, 그리고 그 컨트롤러가 **다른 노드에 Ready 대체 Pod를 띄울 때까지** 제한 시간 안에서 확인합니다(`RCC_DRAIN_TIMEOUT_MS`, 기본 120초). 시간이 지나도 확인되지 않으면 부분 성공이 아니라 **실패**입니다.

통과하면 **cordon → eviction API로 drain**을 수행합니다. Pod를 직접 삭제하지 않습니다 — eviction만이 PodDisruptionBudget을 존중합니다. drain이 거부되거나 오류가 나면 자동으로 uncordon합니다.

**그 uncordon이 실패하면 노드는 cordon된 채로 남습니다.** 이것은 눈에 보이지 않는 저하입니다: 스케줄러가 멀쩡한 기계를 조용히 쓰지 않게 되고, 아무 데도 그 사실이 적히지 않습니다. 그래서 실패는 `console.host_maintenance_degradation`에 기록되고, 다음과 같이 처리됩니다.

- 이후 poll마다 자동으로 uncordon을 재시도합니다(최대 10회). uncordon은 멱등이고 플랫폼 자신이 만든 상태를 되돌리는 것뿐이므로 자동화해도 안전한 유일한 조치입니다.
- 성공하면 `resolution = automatic`으로 닫히고 타임라인에 남습니다.
- 10회로 해결되지 않으면 **escalate**되어 사람이 처리해야 함을 명시합니다. 그 이상 조용히 재시도하지 않습니다.
- 해결될 때까지 **그 호스트에 대한 새 고위험/정비 작업은 거부**됩니다. 실제보다 용량이 적은 클러스터에서 또 drain을 시작하는 것을 막기 위해서입니다. 조회 작업은 영향받지 않습니다.

모든 판단 근거는 작업의 `maintenance` 증거로 저장되어 UI에서 확인할 수 있습니다.

**단일 노드 클러스터에서는 정상 재부팅 준비를 항상 거부합니다. CC2도 여기에 해당합니다.** 워크로드를 옮길 곳이 없기 때문입니다. 이 거부를 해제하는 설정·환경 변수·플래그는 존재하지 않으며, **관리자 1인용 break-glass 경로는 없습니다.** 단일 노드 호스트의 재부팅은 이 플랫폼 밖에서, 콘솔이 관여하지 않는 별도의 운영 절차로 수행해야 합니다.

### 11.9 Kubernetes 자격증명 경계

cordon과 drain에는 Kubernetes 쓰기 동사가 필요합니다. **Console 백엔드는 그 동사를 갖지 않습니다.**

별도의 ClusterRole을 만들어 백엔드 ServiceAccount에 묶는 것은 자격증명 분리가 아닙니다. 그렇게 하면 브라우저 세션을 종료하고, Kubernetes 읽기를 프록시하고, 에이전트 페이로드를 파싱하는 바로 그 프로세스 안에 클러스터의 모든 노드를 cordon할 수 있는 토큰이 놓입니다. 그 프로세스의 결함 하나가 클러스터 전체에 닿습니다.

그래서 쓰기 권한은 **별도의 워크로드**에 있습니다.

| | Console 백엔드 | 정비 서비스 |
|---|---|---|
| Deployment | `polyon-rcc-backend` | `polyon-rcc-maintenance` |
| ServiceAccount | `polyon-rcc-backend` | `polyon-rcc-maintenance` |
| Kubernetes 쓰기 동사 | **없음** | `nodes: patch`, `pods/eviction: create` |
| 브라우저 표면 | 있음 | 없음 |
| 에이전트 표면 | 있음 | 없음 |
| Supabase 접근 | 있음 | 없음 |
| Ingress 노출 | 있음 | **없음**(클러스터 내부 전용) |

정비 서비스가 여는 경로는 넷뿐입니다: `preflight`, `prepare`, `uncordon`, `healthz`. 그 밖의 모든 경로는 404이며 Kubernetes에 닿지 않습니다.

백엔드는 이 서비스를 **서명된 내부 호출**로만 부릅니다.

- `RCC-MAINT-V1` HMAC 서명이 method·path·타임스탬프·nonce·**본문 sha256**을 묶습니다.
- 검증은 상수 시간이며, nonce 재사용은 거부됩니다(재생 방지).
- `Authorization`이나 `Cookie` 헤더가 붙은 요청은 **즉시 거부**됩니다. 브라우저 자격증명은 여기서 어떤 의미도 갖지 않으며 대체 수단이 될 수 없습니다.
- NetworkPolicy가 백엔드 Pod 외의 모든 출발지를 막습니다.
- 내부 키가 없으면 정비 서비스는 **기동을 거부합니다**(`exit 2`). 인증 없는 정비 API는 대체하려던 구성보다 나쁘기 때문입니다.

정비 ClusterRole(`polyon-rcc-cc2-maintenance`)의 전체 범위:

| 리소스 | 동사 | 이유 |
|---|---|---|
| `nodes` | get, list, **patch** | cordon/uncordon |
| `pods` | get, list | 축출 대상 판단, 축출 완료 확인, 용량 계산 |
| `pods/eviction` | **create** | PDB를 존중하는 drain |
| `poddisruptionbudgets` | get, list | preflight |
| `endpointslices` | get, list | control-plane 상태 |

Secret 읽기, 워크로드 편집, Pod 생성, exec/attach/portforward, 일반 Kubernetes 프록시는 **양쪽 모두에 없습니다.** 기존 viewer 제한은 그대로입니다.

이 경계는 문서가 아니라 테스트로 고정되어 있습니다(`backend/dupa-control/maintenance-credential-boundary.test.js`): 백엔드가 어떤 쓰기 동사도 갖지 않는다는 것, 쓰기 role이 정비 ServiceAccount에만 묶인다는 것, 두 Deployment가 서로 다른 ServiceAccount를 쓴다는 것, 정비 서비스가 알 수 없는 경로에 404를 반환하고 서명 없는 호출을 거부한다는 것을 실제로 확인합니다.

### 11.10 에이전트 권한 경계

에이전트는 root로 실행됩니다. 세 작업이 실제로 root를 필요로 하기 때문입니다(전체 저널 읽기, systemctl restart, systemctl reboot). 대신 systemd 샌드박스가 그 root를 좁힙니다.

- `ProtectSystem=strict` + `ReadWritePaths=/var/lib/rcc-node-agent` — 상태 디렉터리 외에는 쓰기 불가
- `CapabilityBoundingSet=CAP_SYS_BOOT` — 재부팅에 필요한 단 하나의 capability만
- `SystemCallFilter=~@privileged @resources @mount @swap @module @obsolete` — `@reboot`은 선언된 작업이므로 유지
- `RestrictAddressFamilies`, `NoNewPrivileges`, `MemoryDenyWriteExecute`, `PrivateDevices` 등 유지
- 리스닝 소켓 없음

### 11.11 에이전트 설정

```json
{
  "operationsEnabled": true,
  "stateDir": "/var/lib/rcc-node-agent",
  "pollIntervalSeconds": 20,
  "restartAllowlist": ["chronyd.service"]
}
```

위 예시는 Stage 2가 **추가하는** 필드만 보여줍니다. 필수 필드(`controlCenterUrl`, `controlCenterId`, `hostId`, `keyId`, `secretFile`)는 4장에서 이미 설정한 것들이며, 그것들 없이는 설정이 로드되지 않습니다.

`operationsEnabled`는 **기본 false**입니다. Stage 2 바이너리를 설치하는 것만으로는 호스트가 실행 가능해지지 않으며, 명시적으로 켜야 합니다. `restartAllowlist` 항목은 평범한 `.service` 이름이어야 하고, 형식이 틀리면 무시가 아니라 기동 거부입니다.

`pollIntervalSeconds`는 작업 큐를 확인하는 주기이며 **5초에서 300초 사이로 강제**됩니다(범위 밖 값은 잘립니다). 스냅샷 보고 주기(`intervalSeconds`)는 별개이고 기본 60초, 15초에서 1시간 사이입니다.

### 11.12 운영 절차

- **작업 요청**: UI에서 작업을 고르고 사유(8자 이상)를 적습니다. 고위험 작업은 `awaiting_approval`로 들어갑니다.
- **승인**: 다른 관리자가 `console.hosts.approve`와 AAL2로 승인합니다. 승인 화면에는 파라미터, 위험도, 재부팅이면 Kubernetes preflight 증거가 함께 표시됩니다.
- **취소**: 에이전트가 실제로 시작하기 전(`running` 이전)까지 가능합니다.
- **결과 확인**: 상세 화면의 타임라인과 receipt를 봅니다. 저널 출력은 잘림 여부와 함께 표시됩니다.
- **감사**: 운영자 행위는 Console 감사에 `rcc.host.operation.*`로 남고, 상태 전이·정비 단계는 `console.host_operation_event`에 추가 전용으로 남습니다.

### 11.13 장애 복구

| 증상 | 원인과 처리 |
|---|---|
| 작업이 `awaiting_approval`에서 멈춤 | 승인자가 없거나 `console.hosts.approve`가 없습니다. 요청자 본인은 승인할 수 없습니다. |
| 작업이 `approved`에서 멈춤 | 에이전트가 poll하지 않습니다. `operationsEnabled`와 `systemctl status rcc-node-agent`를 확인하세요. |
| 재부팅이 `failed`, 사유가 preflight | `maintenance.blocking`을 보세요. 단일 노드·정족수·PDB·컨트롤러 없는 Pod가 흔한 원인입니다. |
| 재시작이 allowlist 오류로 실패 | 해당 유닛이 호스트 allowlist에 없거나 내장 거부 목록에 있습니다. 거부 목록은 설정으로 우회할 수 없습니다. |
| receipt가 "재시도하지 않음"으로 실패 | 에이전트가 실행 중 재시작되었습니다. 부수효과 여부가 불명확하므로 자동 재시도하지 않습니다. 상태를 직접 확인한 뒤 새로 요청하세요. |
| 노드가 cordon된 채 남음 | 재부팅 receipt가 도착하면 자동 uncordon됩니다. 실패하면 `console.host_maintenance_degradation`에 기록되고 poll마다 최대 10회 자동 재시도합니다. 타임라인의 `maintenance.degraded` 항목에서 원인을 확인하세요. |
| 그 호스트에 새 작업이 409로 거부됨 | 위 저하 상태가 아직 열려 있습니다. 오류 메시지에 어떤 노드가 cordon되어 있는지 나옵니다. 자동 복구가 소진(`escalated`)되었다면 원인을 고친 뒤 `kubectl uncordon <node>`하고, 해당 행을 `resolution = 'manual'`로 닫으세요. 조회 작업은 계속 가능합니다. |
| 재부팅이 `etcd-topology-unknown`으로 거부됨 | 이 클러스터의 etcd 위치가 선언되지 않았습니다. 정비 Deployment의 `RCC_ETCD_TOPOLOGY`를 `stacked` 또는 `external`로 설정하세요. 추측하지 않는 것이 의도된 동작입니다. |
| 재부팅이 `etcd-topology-contradiction`으로 거부됨 | 선언과 클러스터가 어긋납니다(예: `external`이라 했는데 노드에 etcd 멤버 증거가 있음). 선언이 틀렸거나 클러스터가 바뀐 것이므로 확인 후 정정하세요. |
| 재부팅이 `daemonset-pod`/`static-pod`/`local-storage-data`로 거부됨 | 옮길 수 없는 Pod에 대한 정책이 선언되지 않았습니다. §11.8의 `RCC_DRAIN_*` 표를 보고 명시적으로 선언하세요. 조용히 건너뛰지 않는 것이 의도된 동작입니다. |
| 재부팅이 `insufficient-capacity`로 거부됨 | 남은 노드가 실제로 이 워크로드를 받을 수 없습니다. 메시지에 어떤 Pod가 어느 노드에서 왜 거부되었는지(용량 부족·taint·nodeSelector) 나옵니다. |
| 재부팅이 `capacity-unknown`/`schedulability-unknown`으로 거부됨 | 계산에 필요한 값을 읽지 못했거나 시뮬레이션할 수 없는 제약이 있습니다. 모르는 상태로 진행하지 않습니다. |
| drain이 "대체 Pod가 Ready가 되지 않음"으로 실패 | 축출은 접수되었지만 컨트롤러가 다른 노드에 대체 Pod를 띄우지 못했습니다. 노드는 자동으로 uncordon됩니다. 워크로드 쪽 문제를 먼저 확인하세요. |
| 작업이 `preparing`에서 멈춤 | 준비를 맡은 프로세스가 중간에 사라졌습니다. 15분 뒤 다음 poll이 자동으로 이어받아 다시 준비합니다(`preparing`/`resumed` 이벤트). 진행 중인 drain을 끊지 않기 위한 대기 시간입니다. |
| lease가 만료되었는데 다시 실행되지 않음 | **에이전트가 이미 시작한 작업은 절대 재큐되지 않습니다.** 부수효과가 어디까지 갔는지 알 수 없기 때문입니다. 시작 전에 만료된 lease만 자동으로 다시 큐에 들어갑니다. |

### 11.14 롤백

- **작업 단위**: 시작 전이면 취소, 시작 후면 결과를 확인하고 필요한 보정 작업을 새로 요청합니다. 실행된 작업 자체는 되돌릴 수 없습니다.
- **호스트 단위**: `agent.json`의 `operationsEnabled`를 false로 되돌리고 재시작하면 그 호스트는 Stage 1 동작(스냅샷 보고만)으로 돌아갑니다.
- **제어센터 단위**: `console.control_center.host_control_mode`를 `read-only`로 되돌리면 dispatch가 데이터베이스 수준에서 거부됩니다. 이미 실행 중인 작업은 완료되고, 새 작업은 나가지 않습니다.
- **스키마**: 0028은 컬럼·제약·카탈로그 추가, 0029는 정비 저하 상태 테이블·검토 후 불변성 트리거·`restart_allowlist` 컬럼 추가이며, 둘 다 기존 Stage 1 데이터를 변경하지 않습니다. 실제 배포는 `deploy/rcc/supabase-baseline.sql`이 적용하며, 이 파일에 두 migration의 내용이 모두 반영되어 있어야 합니다(`npm run test:db`가 확인합니다).

### 11.15 Stage 2에 포함되지 않는 것

| 항목 | 상태 |
|---|---|
| 원격 셸·터미널·임의 명령 | **구현하지 않음. 이후 단계에서도 도입하지 않습니다.** |
| 임의 systemd 유닛 제어(start/stop/enable/mask) | Stage 3 후보 |
| 패키지 업데이트 적용 | Stage 3 후보 |
| 네트워크·스토리지 변경 | Stage 4 후보 |
| 파일 배포·설정 관리 | Stage 4 후보 |
| 단일 노드 재부팅(모든 경로) | **구현하지 않음.** 해제 설정도, 관리자 1인 break-glass도 없습니다. |
| 저하 상태의 자동 복구 범위 | uncordon 재시도만. 그 외 어떤 복구도 자동으로 하지 않습니다. |
| OCI 전달·cosign attestation | 선택적 거버넌스 강화 항목(Stage 2 아님) |

## 12. Stage 3 — 패키지·커널 정비와 정비 창

Stage 3은 두 가지를 함께 들여옵니다: **패키지·커널 유지보수**와 **언제 그것을 해도 되는지에 대한 정책**입니다. 둘을 함께 넣는 이유는 하나만으로는 각각보다 나쁘기 때문입니다. 정책 없는 패키지 업데이트는 아무 때나 노드를 흔들 수 있고, 대상 없는 정책은 아무것도 지키지 않습니다.

패키지·커널 작업은 **내용만큼 시점이 중요한 첫 작업**입니다. 허용된 서비스를 03시에 재시작하는 것과 15시에 재시작하는 것은 같은 행위이지만, 커널을 설치하는 것은 다릅니다. 그 뒤에 오는 것이 누군가 깨어 있어야 하는 재부팅이기 때문입니다.

### 12.1 인벤토리 (읽기 전용)

에이전트는 스냅샷에 패키지·커널 상태를 함께 보고합니다. **이 수집은 아무것도 바꾸지 않습니다.**

| 항목 | 내용 |
|---|---|
| `packages.manager` | `apt` / `dnf` / `zypper` / `pacman` / `unknown` |
| `packages.supported` | 이 에이전트 빌드가 실제로 운용할 수 있는가 |
| `packages.unsupportedReason` | 운용할 수 없다면 그 이유 |
| `packages.metadataAgeSeconds` | 패키지 인덱스를 마지막으로 갱신한 뒤 경과 시간. 알 수 없으면 `-1` |
| `packages.pendingTotal` / `pendingSecurity` | 대기 중 업데이트 수, 그중 보안 업데이트 수 |
| `packages.pending[]` | 패키지별 현재/후보 버전, 보안 여부, 출처 (최대 100개, 잘리면 `truncated`) |
| `kernel.running` | 지금 돌고 있는 커널 |
| `kernel.installedLatest` | 디스크에 설치된 가장 최신 커널 |
| `kernel.candidate` | apt가 제공하는 커널 |
| `kernel.rebootRequired` | `/var/run/reboot-required` 존재 여부 |
| `kernel.rebootRequiredPackages[]` | 재시작을 기다리는 패키지 |

수집 방식은 Stage 1과 같은 규율을 따릅니다.

- 바이너리 경로는 **컴파일 시점에 고정**되어 있습니다(`/usr/bin/apt-get`, `/usr/bin/dpkg-query`, `/usr/bin/uname`). PATH를 조회하지 않고, 설정이나 제어센터에서 경로를 받지 않습니다.
- argv도 고정입니다. `apt-get -s -q -o Debug::NoLocking=true dist-upgrade` — **`-s`는 시뮬레이션**이므로 아무것도 내려받거나 설치하지 않고, `Debug::NoLocking=true`이므로 **dpkg 잠금을 잡지 않습니다.** 읽기 전용 스냅샷이 관리자의 실제 apt 작업을 막는 일은 없습니다.
- 셸이 없고, stdin이 없고, 출력은 512 KiB에서 잘립니다. 제어문자는 제거됩니다.

**증거 신선도는 숫자와 함께 이동합니다.** 한 달 된 인덱스로 계산한 "대기 업데이트 0건"은 패치된 호스트라는 증거가 아니며, 그 차이가 바로 아무도 보지 못한 보안 업데이트입니다. 그래서 UI는 항상 인덱스 나이를 함께 보여주고, 7일이 넘으면 명시적으로 경고합니다.

**지원하지 않는 관리자는 "보이게" 지원하지 않습니다.** dnf/zypper/pacman이 감지되면 그 사실과 이유를 보고하고, **대기 업데이트 수는 0이 아니라 아예 표시하지 않습니다.** "읽을 수 없었다"와 "업데이트가 없다"는 같은 숫자이지만 전혀 다른 사실입니다.

### 12.2 세 가지 작업

| 작업 | 위험도 | 2인 승인 | 정책 필요 | 필요 권한 | 최대 lease |
|---|---|---|---|---|---|
| `package.refresh` | low | 불필요 | **필요** | `console.hosts.packages` | 300초 |
| `package.update` | high | **필요** | **필요** | `console.hosts.packages` | 1800초 |
| `kernel.update` | high | **필요** | **필요** | `console.hosts.packages` | 1800초 |

`console.hosts.packages`는 **요청** 권한입니다. 승인은 여전히 `console.hosts.approve`를 가진 다른 사람이 해야 합니다.

세 작업 모두 호스트 상세의 **Updates 화면에서 요청하고, 같은 화면에서 상태와 결과를 확인합니다**(5.1). 아래는 그 요청이 백엔드와 에이전트에서 어떻게 취급되는지에 대한 규정이며, 화면은 이 규정을 완화하지 않습니다 — 화면의 검사는 **같은 거절을 더 일찍, 사람이 읽을 수 있는 문장으로** 보여줄 뿐이고, 최종 판정은 언제나 데이터베이스 제약·백엔드·에이전트에 있습니다.

**package.refresh** — `apt-get update`를 실행합니다. 설치하는 것은 없습니다. 부분적으로 실패하면(일부 미러 도달 실패) 성공으로 보고하지 않습니다. 부분 갱신에서 나온 대기 업데이트 수는 중요한 방향으로 틀리기 때문입니다.

**package.update** — 명시적으로 열거된 패키지 집합만 업그레이드합니다.

- **"전부 업데이트" 형태는 없습니다.** 아무도 열거하지 않은 집합은 아무도 검토하지 않은 집합이고, 그 내용은 실행 시점의 미러 상태에 따라 달라집니다. 한 작업에 최대 **32개**까지이며, 이 한도가 집합을 검토 가능하게 만듭니다.
- 패키지 이름은 닫힌 문법(`^[a-z0-9][a-z0-9+.-]{1,127}$`)을 통과해야 합니다. 공백, 셸 메타문자, 슬래시, 등호, 선행 대시, 아키텍처 한정자(`:amd64`)는 모두 문자 집합 밖에 있어 **표현 자체가 불가능**합니다. 버전 핀도 마찬가지입니다.
- **저장소 URL, 원시 플래그, 임의 실행 파일을 받는 필드는 존재하지 않습니다.** plan에 그런 필드를 넣으면 에이전트가 `unknown field`로 거부합니다.
- argv는 `apt-get -y -q -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef --no-install-recommends install --only-upgrade -- <이름 또는 이름=버전>`입니다. `--only-upgrade`가 이것을 설치가 아닌 업데이트로 만듭니다. `--`가 피연산자와 옵션을 분리합니다. `--force-yes`나 `--allow-downgrades` 같은 강제 플래그는 어디에도 없습니다.
- **두 관문을 모두 통과해야 합니다.** 코드에 내장된 거부 목록(설정으로 되돌릴 수 없음)과 호스트별 `packageAllowlist`. 거부 목록: `k3s`, `kubelet`/`kubeadm`/`kubectl`/`kube-*`, `containerd`/`containerd.io`/`runc`/`cri-o`/`docker*`, `etcd`, `openssh-server`/`openssh-client`, `systemd`/`init`/`udev`/`dbus`, `ceph-*`, `lvm2`/`multipath-tools`/`open-iscsi`, `network-manager`/`systemd-resolved`/`netplan.io`, `rcc-node-agent`.
- **실행 전에 반드시 시뮬레이션합니다.** `apt-get -s`로 실제 트랜잭션을 확인하고, **무언가를 제거하려 하면 거부**하며, 요청하지 않은 패키지라도 **의존성 그래프가 클러스터 핵심 패키지에 닿으면 거부**합니다. 이것이 허용 목록만으로는 잡을 수 없는 경우입니다: 요청한 패키지는 무해한데 그 의존성이 containerd를 건드리는 상황.
- 이미 최신이면 설치를 실행하지 않고 `already-current`로 보고합니다.

**kernel.update** — 커널 이미지를 설치하고 **거기서 멈춥니다.**

- **절대 재부팅하지 않습니다.** plan에 `rebootAfter`를 설정하면 에이전트가 거부하고, 실행기에도 같은 거부가 한 번 더 있습니다. 백엔드는 그 파라미터 자체를 받지 않습니다.
- 설치 후 `/var/run/reboot-required`를 확인해 **재부팅 필요 증거**를 수령증에 남깁니다: `rebootRequired`, `rebootRequiredPackages`, 그리고 "실행 중인 커널은 host.reboot이 별도로 요청·승인될 때까지 바뀌지 않는다"는 문장.
- 실행 중인 커널을 바꾸는 것은 **기존 `host.reboot`**이며, 여기에는 Stage 2의 Kubernetes cordon/drain 안전장치가 전부 그대로 붙어 있습니다. 단일 노드 클러스터에서 재부팅이 거부된다는 사실도 그대로입니다 — **CC2에서 커널을 설치할 수는 있지만, 그것을 적용하는 재부팅은 이 플랫폼이 수행하지 않습니다.**

### 12.3 정비 창 정책 (HostPolicy)

정책은 **명시적이고, 버전이 있고, 감사되며, 기본이 거부**입니다.

```
console.host_policy
  control_center_id, host_uuid(NULL이면 제어센터 전체), scope(생성 컬럼)
  version              ← 데이터베이스가 세는 값. 애플리케이션이 설정할 수 없습니다.
  timezone             ← IANA 이름. 존재하지 않으면 제약이 거부합니다.
  allowed_operations[] ← 카탈로그에 없는 작업은 제약이 거부합니다.
  emergency_allowed, emergency_requires_second_person
  enabled, created_by, reason

console.host_maintenance_window
  policy_id, day_of_week(0=일), start_time(현지 벽시계), duration_minutes(15..1440), enabled
```

**정책을 만드는 방법.** 정책에는 쓰기 API가 없습니다(12.8). 데이터베이스 관리자가 직접 씁니다.

```sql
-- 1) 제어센터 전체에 적용되는 기본 정책. created_by는 실재하는 console.operator여야 합니다.
INSERT INTO console.host_policy
  (control_center_id, name, timezone, allowed_operations,
   allowed_mount_roots, allowed_images, created_by, reason)
VALUES ('cc2', 'cc2 default', 'Asia/Seoul',
        ARRAY['package.refresh', 'package.update'],
        ARRAY['/srv', '/mnt'],
        ARRAY[]::text[],
        (SELECT user_id FROM console.operator WHERE display_name = '<운영자>' LIMIT 1),
        'initial maintenance policy for cc2');

-- 2) 창이 없으면 긴급 요청 외에는 아무것도 실행되지 않습니다.
INSERT INTO console.host_maintenance_window
  (policy_id, day_of_week, start_time, duration_minutes)
SELECT id, 0, '02:00', 120 FROM console.host_policy
 WHERE control_center_id = 'cc2' AND host_uuid IS NULL;

-- 3) 확인: 지금이 창 안인지 데이터베이스에게 물어봅니다.
SELECT * FROM console.host_policy_window_at(
  (SELECT id FROM console.host_policy WHERE control_center_id = 'cc2' AND host_uuid IS NULL),
  now());
```

`allowed_mount_roots`와 `allowed_images`는 제약이 검증합니다: 보호된 경로를 마운트 루트로 쓰거나 digest 고정이 아닌 이미지를 넣으면 INSERT 자체가 거부됩니다. 모든 편집은 `console.host_policy_change`에 남습니다.

**기본 거부.** 정책이 없는 호스트는 패키지·커널 작업을 **전부 거부**합니다. "아직 정책을 안 썼다"의 실패 모드는 아무 일도 일어나지 않는 것이어야지, 아무 일이나 일어날 수 있는 것이어서는 안 됩니다.

**우선순위는 모호할 수 없습니다.** 호스트 범위 정책이 제어센터 범위 정책을 이깁니다. 각 범위마다 정책은 하나뿐이라는 것을 UNIQUE 제약과 부분 유니크 인덱스가 강제하므로, 우선순위가 행 순서에 좌우되는 일이 없습니다. 순서에 좌우되는 우선순위는 거부가 허용으로 바뀌는 방식입니다.

**창은 "언제"이지 "무엇"이 아닙니다.** 정책이 명시하지 않은 작업은 창 한가운데에서도 거부됩니다.

**DST 안전.** 창은 정책의 타임존에서 **현지 벽시계 시각**으로 저장되고, 평가는 PostgreSQL이 그 타임존에서 수행합니다. "매주 일요일 02:00부터 2시간"은 3월에도 11월에도 현지 02:00입니다. 한 번 고정 UTC 오프셋으로 변환해 두면 1년의 절반 동안 한 시간씩 밀립니다. 자정을 넘기는 창(예: 토요일 23:00부터 4시간)도 전날 현지 날짜까지 되짚어 찾으므로 일요일 01:00을 정확히 포함합니다.

**정책 버전이 승인을 무효화합니다.** 승인은 `content_digest`를 고정하고, Stage 3부터 그 digest에는 **지배 정책의 버전이 포함**됩니다. 정책의 실질적 내용(타임존, 허용 작업, 긴급 설정, 활성 여부)이나 창이 바뀌면 데이터베이스 트리거가 버전을 올리고, 이전 버전으로 승인된 작업은 dispatch 시점에 거부됩니다. **새 규칙이 그 작업을 여전히 허용하는지는 요점이 아닙니다 — 아무도 새 규칙 아래에서 그것을 검토하지 않았습니다.**

버전은 데이터베이스가 셉니다. 애플리케이션이 `version = 99`를 써 보내도 트리거가 덮어씁니다.

**정책은 세 지점에서 평가됩니다.**

1. **요청 시** — 거부되면 아무것도 기록되지 않습니다. 허용된 적 없는 요청의 흔적을 남기지 않기 위해서입니다.
2. **dispatch 시** — 승인은 사람이 보고 있을 때 일어나고 dispatch는 에이전트가 다음에 poll할 때 일어납니다. 그 사이에 창이 닫히거나 정책이 바뀌는 것은 드문 일이 아닙니다.
3. **에이전트에서** — plan은 자신이 속한 창의 UTC 인스턴트를 싣고 오며, 에이전트가 자기 시계로 다시 확인합니다. 큐에서 기다리다 창이 닫힌 뒤 실행되는 plan은 거부됩니다. 에이전트는 타임존 데이터베이스를 들고 다니지 않습니다 — 제어센터가 이미 해결한 UTC 인스턴트만 비교합니다.

### 12.4 긴급 (emergency)

긴급 요청은 **창만 건너뜁니다.**

- 승인, 2인 원칙, AAL2, Kubernetes 안전장치는 **하나도 완화되지 않습니다.** 이것들을 완화하는 컬럼도, 분기도 존재하지 않습니다.
- 오히려 **AAL2를 추가로 요구합니다.** `package.refresh`는 low risk라 위험도 기준으로는 AAL2가 붙지 않지만, 긴급 분기가 별도로 요구합니다. 즉 긴급은 요건을 빼는 것이 아니라 더하는 경로입니다.
- 정책이 `emergency_allowed = false`면 긴급 요청 자체가 거부됩니다.
- 긴급 plan은 창을 싣지 않으며, 창을 싣고 있다고 주장하면 에이전트가 거부합니다. 긴급은 창이 아니고, 창의 보호를 참칭해서는 안 됩니다.
- **단일 control-plane 보호와 단일 노드 재부팅 거부는 긴급으로도 우회할 수 없습니다.** 애초에 별개의 작업(`host.reboot`)에 붙어 있고, 그 작업에는 긴급 경로가 없습니다.

### 12.5 에이전트 설정 (Stage 3 추가분)

```json
{
  "operationsEnabled": true,
  "packagesEnabled": true,
  "packageAllowlist": ["curl", "openssl"],
  "collectPackages": true,
  "restartAllowlist": ["chronyd.service"],
  "stateDir": "/var/lib/rcc-node-agent"
}
```

- `packagesEnabled`는 **기본 false**입니다. Stage 3 바이너리를 설치하는 것만으로 호스트가 업데이트 가능해지지 않습니다.
- `packagesEnabled`는 `operationsEnabled` 없이는 기동을 거부합니다. 아무 일도 하지 않는 설정이 켜져 있는 것처럼 보이지 않게 하기 위해서입니다.
- `packageAllowlist`는 **기본 빈 목록**이며, 항목이 Debian 패키지 이름 문법에 맞지 않으면 무시가 아니라 **기동 거부**입니다. 조용히 무시된 항목은 그것을 쓴 사람에게 "허용됨"으로 읽힙니다. `linux-image-*` 항목도 거부됩니다 — 커널은 별도 작업입니다.
- `collectPackages`는 **기본 true**입니다. 보고는 아무것도 바꾸지 않으므로, 관리되지 않는 호스트도 상태는 보고할 수 있습니다.

콘솔이 제공하는 목록은 **제어센터가 부여한 목록과 에이전트가 보고한 목록의 교집합에 더해 실제로 업데이트가 대기 중인 것**입니다. 어느 한쪽만으로는 아무 권한도 생기지 않습니다.

### 12.6 실패와 복구

| 증상 | 원인과 처리 |
|---|---|
| 요청이 409, "no maintenance policy" | 이 호스트를 지배하는 정책이 없습니다. 기본 거부이므로 정책과 창을 먼저 선언하세요. |
| 요청이 409, "outside every maintenance window" | 지금은 창 밖입니다. 메시지에 정책 타임존이 함께 나옵니다. 창이 열릴 때까지 기다리거나, 정책이 허용한다면 긴급으로 요청하세요. |
| 요청이 409, "does not permit …" | 창 안이지만 정책이 그 작업을 명시하지 않았습니다. 창은 "언제"이지 "무엇"이 아닙니다. |
| 승인 후 dispatch에서 `policy.superseded` | 승인 이후 정책이나 창이 편집되었습니다. 현재 정책 아래에서 다시 요청하세요. |
| 에이전트가 "window has closed"로 거부 | plan이 큐에서 기다리는 동안 창이 닫혔습니다. 의도된 동작입니다. |
| `package.update`가 "would remove …"로 실패 | 제안된 트랜잭션이 패키지를 제거하려 했습니다. 업데이트는 절대 제거하지 않습니다. |
| `package.update`가 "would change containerd" 등으로 실패 | 요청한 패키지는 무해하지만 의존성이 클러스터 핵심 패키지에 닿습니다. 허용 목록으로는 잡을 수 없는 경우이며, 시뮬레이션 관문이 잡은 것입니다. |
| `package.update`가 "no longer be available"로 실패 | 고정한 버전이 인덱스에서 사라졌습니다. 먼저 `package.refresh`를 하고 현재 후보 버전으로 다시 요청하세요. |
| apt 잠금 대기 | apt에 `DPkg::Lock::Timeout=120`을 주므로 즉시 실패하지 않고 최대 2분 기다립니다. unattended-upgrades가 잠금을 자주 잡기 때문입니다. 그래도 못 잡으면 실패로 보고됩니다. |
| 커널 설치 후에도 `kernel.running`이 그대로 | **정상입니다.** 커널 업데이트는 재부팅하지 않습니다. `host.reboot`을 별도로 요청·승인해야 하며, 단일 노드 클러스터에서는 그것이 거부됩니다. |
| 관리자가 "unsupported"로 표시 | 이 에이전트 빌드는 apt만 운용합니다. dnf/zypper/pacman은 감지는 하지만 운용하지 않으며, 추측해서 다루지 않습니다. |
| 인덱스 나이가 매우 오래됨 | 대기 업데이트 수를 신뢰하지 마세요. `package.refresh`를 먼저 하세요. |

### 12.7 롤백

- **작업 단위**: 시작 전이면 취소. 시작 후에는 되돌릴 수 없습니다. apt 업그레이드의 역작업은 이 플랫폼이 수행하지 않습니다(다운그레이드는 거부 플래그에 걸립니다). 필요하면 호스트에서 직접 처리해야 합니다.
- **호스트 단위**: `packagesEnabled`를 false로 되돌리고 에이전트를 재시작하면 그 호스트는 패키지 작업을 전혀 받지 않습니다. 인벤토리 보고는 `collectPackages`로 따로 끕니다.
- **정책 단위**: `enabled = false`로 두면 그 정책은 아무것도 지배하지 않고, 지배 정책이 사라진 호스트는 기본 거부로 돌아갑니다.
- **제어센터 단위**: `host_control_mode`를 `read-only`로 되돌리면 dispatch가 데이터베이스 수준에서 거부됩니다.
- **스키마**: 0030은 컬럼·테이블·카탈로그 추가이며 Stage 1/2 데이터를 변경하지 않습니다.

### 12.8 정책은 누가 바꾸는가 — 경계에 대한 정직한 진술

정책 권위는 **Supabase(`console.host_policy`)에 있습니다.** 그리고 이 플랫폼에는 **정책을 쓰는 API가 없습니다.** 라우트도, 화면도, 버튼도 없습니다. 백엔드는 작업을 판단하기 위해 정책을 *읽기만* 하며, 데이터베이스 권한이 그것을 강제합니다: `opensphere_console_backend` 역할은 `console.host_policy`와 `console.host_maintenance_window`에 `SELECT` 외에는 아무 권한도 갖지 않습니다. 백엔드가 장악되어도 자신을 심판하는 규칙을 넓힐 수 없다는 뜻입니다.

정책은 데이터베이스 관리자가 직접 SQL로 씁니다(12.3의 예시가 그것입니다). 이것은 사고가 아니라 경계이며, 그래서 다음 두 문장이 함께 참입니다.

**정책 변경에는 2인 승인이 없습니다.** 작업(operation)에는 있습니다 — `requires_second_person`, `console.hosts.approve`, 요청자와 승인자가 같으면 거부하는 트리거까지 전부 있습니다. 정책 변경에는 그 경로가 없습니다. 정책을 바꿀 수 있는 사람은 데이터베이스에 직접 접근할 수 있는 사람뿐이고, 그 사람은 이미 다른 방법으로도 같은 일을 할 수 있습니다. 이 문서는 그것을 통제라고 부르지 않습니다.

**Gitea 기반 선언적 정책 조정(reconciliation)은 구현되어 있지 않습니다.** 정책을 Git 저장소에 선언하고 그것을 데이터베이스로 조정하는 컨트롤러는 존재하지 않습니다. 플랫폼에는 실제로 동작하는 Gitea 선언·승인·조정 파이프라인이 있지만(`console.consumer_contract`, `console.change_request`, `console.change_approval`, 그리고 pull 방식 reconciler), 그 범위는 Manual 원문·OAA 선언·subShell descriptor 같은 *소비자 계약*이며 호스트 정책은 거기에 등록되어 있지 않습니다. 상위 설계 문서의 "모든 선언형 변경은 Gitea를 통과한다"는 원칙과 이 경계 사이에는 긴장이 있고, 이 절이 그 긴장을 해소하는 명시적 예외입니다.

**그 대신 남는 것은 증거입니다.** 정책 편집은 `console.host_policy_change`에 추가 전용(append-only)으로 기록됩니다 — 무엇이 무엇으로 바뀌었는지(`before`/`after`), 언제, 어떤 데이터베이스 세션이 했는지. 이 테이블은 소유자조차 UPDATE·DELETE 할 수 없고, 백엔드 역할은 읽기만 합니다. 규칙을 바꾸지 않는 편집(예: `reason` 문구 수정)은 기록되지 않습니다 — 버전 트리거가 "실질적 변경"의 기준이고, 기록은 그 기준을 따릅니다.

정리하면 완화 요소는 넷입니다: (1) 정책 편집은 데이터베이스 직접 접근을 요구하며 백엔드 역할로는 불가능합니다, (2) 모든 실질적 편집이 추가 전용으로 기록되어 사후 귀속이 가능합니다, (3) 데이터베이스가 버전을 세므로 편집이 기존 승인을 자동으로 무효화합니다, (4) 기본이 거부이므로 정책이 사라지거나 손상되면 작업이 멈춥니다. 여기에 더해 정책은 에이전트 자신의 허용 목록을 **넓힐 수 없습니다** — 두 목록의 교집합만 실행됩니다(13.2). Git 기반 정책 선언은 여전히 향후 후보이며, 구현되어 있지 않습니다.

### 12.9 Stage 3에 포함되지 않는 것

| 항목 | 상태 |
|---|---|
| 커널 업데이트 후 자동 재부팅 | **구현하지 않음.** 필드 자체를 거부합니다. |
| apt 이외의 패키지 관리자 | 감지만 하고 운용하지 않음. 추측해서 다루지 않습니다. |
| "전부 업데이트" / 미지정 집합 | **구현하지 않음.** 검토 불가능한 요청입니다. |
| 저장소 추가·변경, 임의 apt 플래그 | **구현하지 않음.** 받는 필드가 없습니다. |
| 패키지 제거·다운그레이드 | **구현하지 않음.** 시뮬레이션이 제거를 발견하면 거부합니다. |
| Git 선언 기반 정책 조정 | 미구현 (12.8 참조) |
| 정책 변경의 2인 승인 | **미구현** (12.8). 정책에는 쓰기 API가 없고, 편집은 데이터베이스 직접 접근으로만 가능하며 `console.host_policy_change`에 기록됩니다. |
| 창 밖 자동 스케줄링 | 미구현. 창 안이라도 사람이 요청해야 합니다. |

## 13. Stage 4 — 네트워크·스토리지 변경과 이미지 기반 OS

Stage 4는 **보수적인 네트워크·스토리지 변경**과 **불변(immutable) OS 인식·지원**을 추가합니다. 새 런타임(OKD/MCO, Cockpit, Rancher/Fleet, Elemental, Perses)은 도입하지 않으며, 일반 셸·원시 명령·별도 컨트롤러도 추가하지 않습니다. 기존 `HostOperation` 파이프라인을 그대로 확장합니다.

Stage 4가 다른 단계와 구조적으로 다른 점은 두 가지입니다.

**첫째, 사전 상태(pre-state)가 승인 대상에 포함됩니다.** 요청 시점에 호스트가 보고한 상태를 백엔드가 서버 측에서 파라미터에 넣고, 그 파라미터가 content digest에 들어갑니다. 에이전트는 실행 직전에 살아 있는 호스트와 이것을 다시 대조합니다. 그래서 "검토 이후 호스트가 손으로 바뀌었다"가 **탐지 가능한 조건**이 됩니다. 사람이 본 적 없는 출발점 위에 검토된 변경을 얹지 않습니다.

**둘째, 네트워크 변경에는 자동 롤백이 있습니다.** 네트워크 변경은 "변경이 성공했는지 확인하는 경로" 자체를 끊을 수 있는 유일한 작업입니다. 그래서 에이전트는 변경 후 **자기 제어센터에 실제로 도달할 수 있는지** 증명하고, 못 하면 이전 설정을 되돌립니다. 되돌리기 기록은 변경 **이전에** 내구적 저장소에 기록되므로, 에이전트가 그 사이에 죽어도 다음 기동에서 복구합니다.

### 13.1 인벤토리 (읽기 전용)

에이전트는 스냅샷마다 세 블록을 추가로 보고합니다. 전부 읽기 전용이며, 고정 argv로만 수집하고, 자격증명이나 비밀 접속 정보는 어떤 경로로도 수집하지 않습니다.

**네트워크 (`networkState`)**

| 항목 | 출처 |
|---|---|
| 링크 이름/종류/상태/MTU | `ip -json -details addr show` |
| 주소 (IPv4/IPv6, link-local 제외) | 같음 |
| 드라이버 | `/sys/class/net/<이름>/device/driver` 심볼릭 링크 |
| 기본 경로(default route)와 게이트웨이 | `ip -json route show default` (metric이 가장 낮은 것) |
| NM 관리 여부, 프로파일 이름, `ipv4.method` | `nmcli -t ... device status` / `connection show` |
| NM 프로파일의 정적 주소·게이트웨이 | `nmcli -t -f ipv4.addresses,ipv4.gateway ...` |
| DNS 서버·검색 도메인 | `/run/systemd/resolve/resolv.conf` → `/etc/resolv.conf` |

- **MAC 주소는 수집하지 않습니다.** 운영자가 판단에 쓰지 않는 식별자이며, 호스트를 떠날 이유가 없습니다.
- **무선·VPN·802.1X 설정은 어떤 필드도 조회하지 않습니다.** `nmcli`에 넘기는 필드 목록이 닫혀 있으므로 비밀이 반환될 여지 자체가 없습니다.
- `staticAddresses`는 커널이 보는 주소 목록과 **다릅니다.** DHCP 리스는 `addresses`에는 나타나고 `staticAddresses`에는 나타나지 않습니다. 에이전트가 실제로 대조하는 값이 후자이므로 사전 상태는 후자로 만듭니다.
- 기본 경로가 나가는 링크는 `managementLink`로 **명시**되며, 이 플랫폼은 그것을 절대 재구성하지 않습니다.

**스토리지 (`storage`)**

| 항목 | 출처 |
|---|---|
| 블록 장치 이름/종류/크기/부모 | `lsblk --json --bytes --paths -o ...` |
| 파일시스템 종류·UUID·마운트 지점 | 같음 |
| 회전/제거 가능/읽기 전용 | 같음 |
| 파일시스템 크기 대비 장치 크기(headroom) | `/proc/1/mounts` + statfs + lsblk |
| 성장 가능 여부와 **그 이유** | 파생 |

"성장 불가"에는 서로 매우 다른 이유가 있습니다 — 파일시스템 종류가 ext4/xfs가 아님, 여유 공간(headroom)이 없음, 보호 경로임, 읽기 전용 마운트임 — 그중 하나만 실수입니다. 그래서 이유가 항상 함께 보고됩니다.

SMART 등 장치 건강 지표는 `smartctl`이 없는 호스트가 많아 **수집하지 않습니다.** 없는 것을 있는 척하지 않습니다.

**부팅/업데이트 모델 (`boot`)**

| 모델 | 감지 | 지원 |
|---|---|---|
| `bootc` | `/usr/bin/bootc` + ostree 부팅 | 상태 + 스테이징 + 롤백 |
| `rpm-ostree` | `/usr/bin/rpm-ostree` + ostree 부팅 | 상태 + 스테이징 + 롤백 |
| `snap` (Ubuntu Core) | `os-release`의 `ID=ubuntu-core` | **상태만.** 변경은 미지원 |
| `mutable` | 그 외 전부 (CC2 포함) | **이미지 작업 미지원.** `package.update`/`kernel.update`를 쓰십시오 |

- **바이너리가 있다는 것만으로 이미지 시스템으로 판정하지 않습니다.** `/run/ostree-booted`(또는 `/ostree`)가 있어야 합니다. 패키지 관리 호스트에 rpm-ostree가 설치되어 있는 경우를 이미지 시스템으로 오독하지 않기 위함입니다.
- **하위 명령 지원 여부는 가정하지 않고 탐지합니다.** 설치된 어댑터가 `rollback`을 노출하지 않으면 `canRollback=false`로 보고하고 작업은 거부됩니다. 시도했다가 중간에 실패하지 않습니다.
- snap은 감지·보고만 합니다. Ubuntu Core의 갱신·롤백은 snapd 자신의 refresh 모델이 지배하며, 두 스케줄러가 경합하는 것은 스케줄러가 없는 것보다 나쁩니다. 이것은 **정직한 미지원**이며 흉내 내지 않습니다.

지원되지 않는 하위 시스템은 **행동 가능해 보이지 않도록** 정규화됩니다. 지원되지 않는 네트워크 스택은 링크 목록이 비고, 지원되지 않는 블록 계층은 장치 목록이 비며, mutable 호스트는 staged 배포와 롤백 대상이 비어 보고됩니다. "읽을 수 없었다"와 "없다"는 같은 숫자이지만 완전히 다른 사실입니다.

### 13.2 다섯 가지 작업

| 작업 | 위험 | 2인 승인 | 권한 | 정책 필요 | 재부팅 |
|---|---|---|---|---|---|
| `network.configure` | high | 필요 | `console.hosts.network` | 필요 | **안 함** |
| `mount.configure` | high | 필요 | `console.hosts.storage` | 필요 | **안 함** |
| `filesystem.grow` | high | 필요 | `console.hosts.storage` | 필요 | **안 함** |
| `osimage.stage` | high | 필요 | `console.hosts.osimage` | 필요 | **안 함** |
| `osimage.rollback` | high | 필요 | `console.hosts.osimage` | 필요 | **안 함** |

세 권한은 **분리되어 있습니다.** 세 권위가 각각 다른 systemd 샌드박스 완화를 요구하고, 어느 것도 다른 것을 함의하지 않기 때문입니다. 파일시스템을 늘려도 되는 운영자가 네트워크를 재구성해도 되는 것은 아닙니다.

#### `network.configure` — NetworkManager 전용

받는 것: 프로파일 이름, 인터페이스 이름, `auto`/`manual`, IPv4 주소(CIDR, 최대 4), 게이트웨이, DNS(최대 4), 검색 도메인(최대 8), MTU(0 또는 1280–9216), 롤백 시간(30–600초).

받지 않는 것: 원시 `nmcli`/`ip` 인자, 명령 문자열, 키파일 경로, 인터페이스 삭제, `ipv4.method=disabled`, "롤백 없음".

**보호 규칙 (세 겹)**

1. **문법**: 요청 문법이 관리 인터페이스를 지목하는 plan을 거부합니다.
2. **백엔드**: 호스트가 보고한 기본 경로 인터페이스를 지목하면 409로 거부합니다.
3. **에이전트**: 실행 직전에 `/proc/net/route`를 직접 읽어 다시 확인합니다. 검토 이후 기본 경로가 **이동했다면** 그것도 거부합니다 — 새 배치가 안전했을지는 논점이 아니며, 아무도 그것을 보지 않았습니다.

**적용 절차**

```
1. 허용 목록 확인 (호스트의 networkAllowlist)
2. 살아 있는 기본 경로 확인 → 대상이면 거부
3. 현재 프로파일 읽기 → 사전 상태와 대조 → 다르면 거부
4. 되돌리기 기록을 내구적 상태 저장소에 기록      ← 변경 이전
5. nmcli connection modify (고정 argv, 각 값은 독립 인자, `--` 뒤)
6. nmcli connection up
7. 제어센터에 HEAD 요청 (TLS 검증 포함) — 롤백 기한까지 5초 간격 재시도
8a. 성공 → rollbackState=confirmed, 변경 유지
8b. 실패 → 이전 설정 복원 + 재활성화 → rollbackState=rolled-back, 작업은 실패로 보고
```

7단계가 **긍정적 확인(positive confirmation)** 입니다. `nmcli`가 0으로 끝났다는 것은 호스트가 여전히 도달 가능하다는 증명이 아닙니다. 제어센터에 실제로 닿는 것만이 증명입니다. TLS 인증서 검증을 거치므로 캡티브 포털이나 가로채기 프록시가 그 답을 위조할 수 없습니다. 401/404도 성공으로 칩니다 — 인증 거부도 "제어센터가 응답했다"의 증명이며, 5xx만 증명으로 치지 않습니다.

#### `mount.configure` — 생성된 systemd 마운트 유닛

`/etc/fstab`을 **쓰지 않습니다.** fstab의 잘못된 줄은 호스트를 부팅 불가로 만들 수 있고, 루트 파일시스템은 마운트 유닛에서 마운트되지 않으므로 잘못된 마운트 유닛은 그렇게 되지 않습니다. 생성되는 유닛은 **항상 `nofail`** 이므로 장치가 없어도 부팅을 붙잡지 않습니다.

- 파일시스템은 **자기 UUID로** 지목합니다. `/dev` 이름은 부팅 사이에 이동하므로, 운영자가 승인한 것은 슬롯이 아니라 파일시스템입니다.
- 마운트 지점은 정책이 선언한 루트 **아래**여야 하며, 루트 자체는 대상이 될 수 없습니다(그 아래 있던 것을 가려버립니다).
- 옵션은 불리언 네 개뿐입니다. `noexec`, `nosuid`, `nodev`는 **기본 켜짐**입니다.
- 이미 다른 곳에 마운트된 파일시스템은 거부합니다. 이 작업은 마운트된 파일시스템을 옮기지 않습니다.
- 이 에이전트가 쓰지 않은 동명 유닛이 이미 있으면 **건드리지 않고** 거부합니다.

순서가 안전의 핵심입니다: 유닛 쓰기 → `daemon-reload` → **`start`** → 실제로 마운트되었는지 확인 → 그다음에야 `enable`. 지금 마운트되지 않는 유닛은 매 부팅마다 실패했을 유닛이므로, 그 자리에서 제거됩니다.

#### `filesystem.grow` — 늘리기 전용

**크기 인자가 없습니다.** `resize2fs <마운트지점>`과 `xfs_growfs -d <마운트지점>`은 둘 다 "장치 전체를 쓰라"는 뜻이며, 이 에이전트가 구성할 수 있는 어떤 호출로도 마운트된 파일시스템을 줄일 수 없습니다. 줄이기가 "거부"되는 것이 아니라 **표현 불가능**합니다. ext4와 xfs만 대상인 이유가 이것입니다.

파티션 테이블은 쓰지 않습니다. `growpart`/`parted`는 호출하지 않습니다. 이 작업은 **이미 더 커진 블록 장치** 안으로 파일시스템을 확장할 뿐이며, 장치를 키우는 것은 스토리지 쪽에서 별도로 수행한 의도적 행위입니다. 여유 공간이 없으면 dispatch 전에 거부됩니다.

#### `osimage.stage` / `osimage.rollback`

- 이미지는 **digest 고정**입니다. `@sha256:<64 hex>`로 끝나지 않으면 문법이 거부합니다. 태그는 레지스트리를 통제하는 쪽이 옮길 수 있으므로 검토 가능한 대상이 아닙니다.
- 이미지는 **정책 허용 목록과 호스트 허용 목록 양쪽**에 있어야 합니다.
- 레지스트리, 태그, 전송 방식(transport), URL을 받는 필드는 없습니다. transport 접두사는 에이전트가 고정합니다.
- `rebootAfter`는 선언되어 있고 **항상 false**이며, 요청 문법·plan 검증·실행기 세 곳에서 거부됩니다. `kernel.update`와 같은 이유로, 나중 빌드가 조용히 존중하기 시작할 수 없게 하기 위함입니다.
- 롤백은 이미지를 지목하지 않습니다. 이미 디스크에 있는 배포로 돌아갑니다.

### 13.3 정책 확장 — 대상까지 지배

Stage 3의 `allowed_operations`는 **동사** 목록입니다. Stage 4 작업은 대상을 지목하므로 대상도 지배해야 합니다: `osimage.stage`를 허용하면서 어떤 이미지인지 말하지 않는 것은 **아무 이미지나** 허용하는 것입니다.

```sql
UPDATE console.host_policy
   SET allowed_operations = ARRAY[
         'package.refresh','package.update','kernel.update',
         'filesystem.grow','mount.configure','network.configure'
       ],
       allowed_mount_roots = ARRAY['/srv','/mnt'],
       allowed_images      = ARRAY[
         'registry.example.com/polyon/os@sha256:0123...cdef'
       ]
 WHERE control_center_id = 'cc2' AND host_uuid IS NULL;
```

- `allowed_images`는 데이터베이스 CHECK 제약으로 digest 고정을 강제합니다.
- `allowed_mount_roots`는 절대 경로여야 하고 `/`, `/boot`, `/usr`, `/etc`, `/var`, `/proc`, `/sys`, `/dev`, `/run` 아래일 수 없습니다. **정책이 호스트가 거부할 것을 기록할 수 없게** 하기 위함입니다 — 그런 불일치는 새벽 3시에만 드러납니다.
- 두 목록의 편집은 **실질적 변경**이므로 정책 버전을 올리고, 따라서 기존 승인을 무효화합니다.
- 대상 검사는 요청 시점과 dispatch 시점 **양쪽**에서 다시 수행됩니다.

### 13.4 롤백 상태 (`rollback_state`)

`console.host_operation`에 세 컬럼이 추가됩니다: `adapter`, `rollback_deadline_at`, `rollback_state`.

| 상태 | 뜻 |
|---|---|
| `none` | 이 작업에는 자동 롤백이 없습니다 |
| `armed` | 되돌리기 기록이 내구적이고 변경이 진행 중입니다 |
| `confirmed` | 변경 후 제어센터에 도달했으므로 유지되었습니다 |
| `rolled-back` | 도달하지 못해 이전 설정으로 복원되었습니다 |
| `rollback-failed` | 복원이 완전히 성공하지 못했습니다. **사람이 직접 봐야 합니다** |
| `not-recorded` | 에이전트가 결과를 보고하지 못했습니다. 네트워크 상태를 **미상으로 취급하십시오** |

`armed`로 끝난 영수증은 `not-recorded`로 기록됩니다. 변경을 적용하고 죽은 에이전트야말로 "armed"가 안심으로 읽히면 안 되는 경우이기 때문입니다.

데이터베이스 트리거(`host_operation_rollback_guard`)가 이를 강제합니다: `requires_rollback`인 작업은 기한과 armed 상태 없이는 `leased`/`running`으로 갈 수 없습니다. 애플리케이션 버그가 되돌릴 수 없는 변경을 내보내지 못하게 하기 위함입니다.

### 13.5 에이전트 설정 (Stage 4 추가분)

```json
{
  "operationsEnabled": true,

  "collectNetworkState": true,
  "collectStorage": true,
  "collectBoot": true,

  "networkEnabled": false,
  "networkAllowlist": [],

  "storageEnabled": false,
  "storageMountRoots": [],
  "storageGrowAllowlist": [],

  "osImageEnabled": false,
  "osImageAllowlist": []
}
```

위 블록은 Stage 4가 **추가하는** 필드만 보여줍니다. 4장의 필수 필드(`controlCenterUrl`, `controlCenterId`, `hostId`, `keyId`, `secretFile`)와 11.11의 Stage 2 필드는 그대로 필요하며, 이 예시만 그대로 옮겨 적으면 설정이 로드되지 않습니다.

- 세 권위 모두 **기본 꺼짐**입니다. 네트워크를 재구성할 수 있는 빌드를 설치한 것만으로 호스트가 재구성 가능해지지 않습니다.
- 셋 다 `operationsEnabled`를 요구합니다. 없으면 **기동을 거부**합니다(조용히 아무것도 안 하는 설정이 되지 않도록).
- 허용 목록이 빈 채로 권위만 켜면 **기동을 거부**합니다. 아무것도 할 수 없는 권위는 승인된 작업이 호스트에서 거부될 때에야 드러납니다.
- 잘못된 형식의 항목은 **무시가 아니라 기동 거부**입니다. 조용히 버려진 항목은 그것을 적은 사람에게 "허용됨"으로 읽힙니다.
- 수집(`collect*`)은 기본 켜짐입니다. 보고는 아무것도 바꾸지 않습니다.
- 이 허용 목록들은 **콘솔에도 영향을 줍니다**: 백엔드는 요청 시점에 정책의 허용 목록과 이 목록의 교집합만 받아들입니다. 여기에 없는 대상은 승인 절차에 오르기 전에 거절되므로, 승인까지 다 받고 호스트에서 실패하는 일이 생기지 않습니다(13.2).

### 13.6 systemd 샌드박스 — 네 개의 별도 드롭인

기본 유닛은 **그대로 유지됩니다**: `ProtectSystem=strict`, `CapabilityBoundingSet=CAP_SYS_BOOT`, 쓰기 가능 경로는 에이전트 자신의 상태 디렉터리뿐, 인바운드 소켓 없음. **어떤 드롭인도 `ProtectSystem`을 완화하지 않습니다.** 각 드롭인은 열어야 할 경로를 하나씩 나열할 뿐이며, 그 목록 밖은 계속 읽기 전용입니다.

권위는 넷입니다. Stage 3의 패키지 권위도 같은 방식으로 동작하며, **이것 없이는 `package.*`와 `kernel.update`가 전부 실패합니다.**

| 권위 | 드롭인 | 추가 capability | 추가 쓰기 경로 |
|---|---|---|---|
| 패키지 (Stage 3) | `package-maintenance.conf` | `CAP_CHOWN`, `CAP_DAC_OVERRIDE`, `CAP_FOWNER`, `CAP_FSETID`, `CAP_SETUID`, `CAP_SETGID`, `CAP_MKNOD`, `CAP_AUDIT_WRITE` | `/var/lib/dpkg`, `/var/lib/apt`, `/var/cache/apt`, `/var/lib/systemd`, `/var/log`, `/var/run`, `/etc`, `/usr`, `/boot` |
| 네트워크 | `network-maintenance.conf` | `CAP_NET_ADMIN` | `/etc/NetworkManager` |
| 스토리지 | `storage-maintenance.conf` | `CAP_SYS_ADMIN`, `CAP_SYS_RESOURCE`, `CAP_DAC_OVERRIDE` | `/etc/systemd/system`, `/srv`, `/mnt`, `/data` |
| 이미지 | `osimage-maintenance.conf` | `CAP_SYS_ADMIN`, `CAP_CHOWN`, `CAP_DAC_OVERRIDE`, `CAP_FOWNER`, `CAP_FSETID`, `CAP_MKNOD`, `CAP_SETUID`, `CAP_SETGID` | `/sysroot`, `/ostree`, `/boot`, `/var/lib/containers`, `/var/cache` |

```bash
install -D -m 0644 packaging/network-maintenance.conf \
  /etc/systemd/system/rcc-node-agent.service.d/network-maintenance.conf
systemctl daemon-reload && systemctl restart rcc-node-agent
```

**드롭인이 없으면 도구가 실패하고 작업은 fail-closed 됩니다** — 영수증에 권한 오류가 남습니다. 조용히 약한 샌드박스로 도는 것보다 낫습니다. 각 권위는 두 가지 의도적 행위를 요구합니다: 설정과 드롭인.

`CAP_SYS_BOOT`은 네 드롭인 모두에서 유지됩니다. `host.reboot`이 여전히 선언된 작업이기 때문입니다. `CAP_NET_RAW`는 **주지 않습니다** — 원시 패킷을 보내는 코드가 없습니다.

스토리지 권위가 요구하는 것은 마운트가 아니라 확장입니다. 에이전트는 `mount(2)`를 직접 호출하지 않고 유닛을 쓴 뒤 PID 1에게 시작을 요청하므로, 마운트에 필요한 capability는 여기 없습니다. `CAP_SYS_RESOURCE`는 ext4 온라인 확장이, `CAP_SYS_ADMIN`은 xfs 확장이 검사하는 것입니다. `CAP_SYS_ADMIN`은 Stage 4가 부여하는 가장 넓은 capability이고, 스토리지 드롭인을 설치하기 전에 가장 오래 생각해야 하는 이유이며, 그래서 별도 파일입니다.

**syscall 필터에 대해 알아야 할 것.** systemd는 드롭인의 `SystemCallFilter=`를 기본 유닛의 것과 *병합*하며, `~`로 시작하는 거부 목록은 이미 허용된 것에서 빼기만 합니다. 즉 드롭인의 거부 목록은 기본 유닛이 이미 막아둔 그룹을 되살릴 수 없습니다 — 무언가를 허용하는 것처럼 읽히지만 아무 일도 하지 않습니다. 되살리려면 양의 항목이 필요합니다. 그래서 패키지 드롭인은 `SystemCallFilter=@privileged @module`을, 이미지 드롭인은 `SystemCallFilter=@mount @privileged`를 명시적으로 씁니다. 네트워크와 스토리지 드롭인에는 `SystemCallFilter` 줄이 아예 없습니다: 둘 다 특권 syscall을 직접 발행하지 않기 때문입니다.

**드롭인은 서로를 격리하지 않습니다.** systemd는 드롭인들을 하나의 유닛으로 병합하고, `CapabilityBoundingSet`·`ReadWritePaths`·`SystemCallFilter`는 목록 값이라 설치된 모든 드롭인의 **합집합**이 됩니다. 스토리지와 이미지 드롭인을 함께 설치한 호스트의 에이전트는 두 집합을 모두 가집니다. 분리되어 있는 것은 *권위*입니다 — 에이전트가 어떤 작업을 받아들일지는 설정 플래그, 콘솔 권한, 허용 목록이 결정하며, 다른 드롭인이 설치되어도 그 셋은 바뀌지 않습니다. 필요한 권위만 설치하십시오.

### 13.7 운영 절차

**네트워크 변경**

1. Network 탭에서 대상 링크가 `Changeable = yes`인지 확인합니다. 제어 경로를 나르는 링크는 절대 제시되지 않습니다.
2. Network 탭 → "Reconfigure a network interface". 폼은 **요청이 묶일 현재 상태**와 같은 화면의 요청·승인·결과 이력을 함께 보여줍니다.
3. 롤백 시간을 정합니다. 기본 120초. "없음"은 선택지가 아닙니다.
4. 요청 → 다른 사람이 승인(AAL2) → 정비 창 안에서 dispatch.
5. 실행 중에는 화면에 **남은 롤백 시간**이 표시됩니다.
6. 영수증에 `rollbackState`가 남습니다. `confirmed`가 아니면 그 뜻을 13.4에서 확인하십시오.

**파일시스템 늘리기**

1. 스토리지 쪽에서 블록 장치를 먼저 키웁니다(이 플랫폼이 하지 않습니다).
2. 에이전트가 다음 스냅샷을 보내면 Storage 탭에 headroom이 나타납니다.
3. Storage 탭 → "Grow a filesystem". 크기를 입력하지 않으며, 같은 화면에서 요청·승인·결과 이력을 확인합니다.

**이미지 스테이징**

1. 정책 `allowed_images`에 digest를 추가합니다(버전이 올라가고 기존 승인이 무효화됩니다).
2. 호스트 `osImageAllowlist`에도 같은 digest를 넣고 에이전트를 재시작합니다.
3. OS image 탭 → "Stage an operating system image". 같은 화면에서 배포·롤백 요청과 결과 이력을 확인합니다.
4. 스테이징은 **재부팅하지 않습니다.** 적용은 별도의 `host.reboot`이며 Kubernetes 검사를 모두 거칩니다.

### 13.8 장애 대응

| 증상 | 뜻과 대응 |
|---|---|
| 요청이 409, "carries the default route" | 제어 경로를 나르는 인터페이스입니다. 이 플랫폼은 그것을 재구성하지 않습니다. 콘솔에서 직접 하십시오. |
| 요청이 409, "has not reported a snapshot yet" | Stage 4 요청은 사전 상태를 필요로 합니다. 에이전트가 보고할 때까지 기다리십시오. |
| 에이전트가 "changed since it was reviewed"로 거부 | 검토 이후 호스트가 손으로 바뀌었습니다. **의도된 동작입니다.** 다시 요청하십시오. |
| 에이전트가 "the default route has moved" | 검토 이후 기본 경로가 이동했습니다. 새 배치를 아무도 보지 않았으므로 거부합니다. |
| `rollbackState = rolled-back` | 변경 후 제어센터에 닿지 못해 되돌렸습니다. 호스트는 이전 상태입니다. 설정을 다시 검토하십시오. |
| `rollbackState = rollback-failed` | **직접 개입이 필요합니다.** 호스트 콘솔에서 네트워크를 확인하십시오. |
| `rollbackState = not-recorded` | 에이전트가 결과를 보고하지 못했습니다. 네트워크 상태를 미상으로 취급하고 직접 확인하십시오. |
| 마운트가 "would hide what is there"로 실패 | 그 경로에 이미 마운트가 있습니다. 가리지 않습니다. |
| 마운트가 "not written by this agent"로 실패 | 동명 유닛이 이미 있고 이 에이전트가 쓴 것이 아닙니다. 남의 설정을 덮어쓰지 않습니다. |
| 늘리기가 "nothing to grow into"로 실패 | 블록 장치가 파일시스템보다 크지 않습니다. 스토리지 쪽에서 먼저 키우십시오. |
| 이미지 스테이징이 "does not expose" | 설치된 어댑터가 그 하위 명령을 노출하지 않습니다. 시도하지 않고 거부합니다. |
| 부팅 모델이 `mutable`인데 이미지 작업을 원함 | CC2를 포함한 패키지 관리 배포판입니다. `package.update`/`kernel.update`를 쓰십시오. |
| 드롭인 없이 작업 요청 | 도구가 권한 오류로 실패하고 작업은 fail-closed 됩니다. 13.6을 보십시오. |

### 13.9 롤백 (되돌리기)

- **작업 단위**: 네트워크 변경은 자동으로 되돌아갑니다(확인 실패 시, 그리고 에이전트가 죽은 경우 다음 기동에서). 마운트는 `start` 실패 시 유닛이 제거됩니다. **파일시스템 늘리기는 되돌릴 수 없습니다** — 줄이기가 없기 때문입니다. 이미지 스테이징은 `osimage.rollback`으로 되돌립니다.
- **호스트 단위**: `networkEnabled`/`storageEnabled`/`osImageEnabled`를 false로 되돌리고 재시작하면 그 호스트는 해당 작업을 전혀 받지 않습니다. 드롭인을 제거하면 도구 수준에서도 막힙니다.
- **정책 단위**: `allowed_operations`에서 제거하거나 `enabled=false`로 두면 기본 거부로 돌아갑니다.
- **제어센터 단위**: `host_control_mode`를 `read-only`로 되돌리면 dispatch가 데이터베이스 수준에서 거부됩니다.
- **스키마**: 0031은 컬럼·제약·카탈로그 추가이며 Stage 1–3 데이터를 변경하지 않습니다. 전진 전용(forward-only)입니다.

### 13.10 이 구현에서 실제로 수행하지 않은 것 (정직한 진술)

**CC2에 배포하지 않았습니다. 클러스터에 접근하지 않았습니다. 실제 호스트에서 네트워크·스토리지·이미지 변경을 수행하지 않았고, 재부팅하지 않았으며, 실제 자격증명을 만들지 않았습니다.**

구체적으로:

- **CC2에서 살아 있는 네트워크 변경을 실행한 적이 없습니다.** nmcli 호출 경로는 고정 argv 구성과 실패·롤백 분기까지 단위 테스트로 검증했지만, 실제 NetworkManager 데몬을 상대로 실행한 검증은 이 구현 과정에 포함되지 않았습니다.
- **CC2에서 살아 있는 마운트나 파일시스템 확장을 실행한 적이 없습니다.**
- **rpm-ostree/bootc 호스트에서 스테이징이나 롤백을 실행한 적이 없습니다.** 어댑터 명령줄은 각 도구의 문서화된 하위 명령에 따라 구성했고, 설치된 어댑터가 그 하위 명령을 노출하는지 실행 시점에 탐지하지만, **살아 있는 불변 OS 호스트를 상대로 검증하지는 않았습니다.** CC2는 Ubuntu 24.04이므로 `mutable`로 보고되고 두 작업 모두 미지원으로 표시됩니다.
- **재부팅을 수행하지 않았습니다.**

이 문서는 mTLS, Gitea 조정, Prometheus/Perses 설치, 라이브 검증을 **주장하지 않습니다.** Gitea 선언적 정책 조정은 Stage 3에서와 마찬가지로 **여전히 구현되어 있지 않습니다**(12.8 참조). 정책 권위는 Supabase에 있으며, 정책 변경의 Git 리뷰는 없습니다.

### 13.11 Stage 4에 포함되지 않는 것

| 항목 | 상태 |
|---|---|
| 원격 셸, 임의 명령 실행 | **구현하지 않음.** 받는 필드가 없습니다. |
| 원시 `nmcli`/`ip`/`mount` 인자 | **구현하지 않음.** 표현 불가능합니다. |
| 인터페이스 삭제, 인터페이스 비활성화 | **구현하지 않음.** |
| 관리 인터페이스(기본 경로) 재구성 | **구현하지 않음.** 세 겹으로 거부됩니다. |
| IPv6 정적 구성, 본딩/브리지/VLAN 생성 | 미구현. 읽기만 합니다. |
| systemd-networkd / netplan 변경 | 감지만 하고 운용하지 않음. NetworkManager 전용입니다. |
| 포맷, 파티션 테이블 쓰기, 줄이기 | **구현하지 않음.** 표현 불가능합니다. |
| `/etc/fstab` 편집 | **구현하지 않음.** 생성된 마운트 유닛만 씁니다. |
| 임의 마운트 옵션 문자열 | **구현하지 않음.** 불리언 네 개뿐입니다. |
| LVM/RAID/암호화 볼륨 조작 | 미구현. |
| 마운트된 파일시스템 이동 | **구현하지 않음.** |
| snap/Ubuntu Core 갱신·롤백 | **구현하지 않음.** snapd가 지배합니다. 감지만 합니다. |
| 태그 기반 이미지 참조 | **구현하지 않음.** digest 고정만 받습니다. |
| 이미지 스테이징 후 자동 재부팅 | **구현하지 않음.** 필드 자체를 거부합니다. |
| Git 선언 기반 정책 조정 | **미구현** (12.8, 13.10 참조) |
| 정책 변경의 2인 승인 | **미구현** (12.8). 정책에는 쓰기 API가 없고, 편집은 데이터베이스 직접 접근으로만 가능하며 `console.host_policy_change`에 기록됩니다. |
| 창 밖 자동 스케줄링 | 미구현. 창 안이라도 사람이 요청해야 합니다. |

### 13.12 남는 위험 (residual risk)

1. **스테이징된 이미지는 남의 운영체제입니다.** 이 플랫폼은 그것이 승인된 digest임을 검증하지, 그 digest의 내용이 안전한지는 검증하지 않습니다. 이미지 기반 시스템의 신뢰 경계 그 자체입니다.
2. **`CAP_SYS_ADMIN`은 넓습니다.** 스토리지·이미지 드롭인이 부여합니다. 스토리지 쪽은 xfs 온라인 확장 ioctl 때문이며(마운트 자체는 PID 1이 수행하므로 이 capability를 쓰지 않습니다), 이미지 쪽은 배포 트리 구성 때문입니다. 별도 파일로 분리되어 있고 기본은 미설치이지만, **드롭인은 서로를 격리하지 않습니다**: 여러 개를 설치하면 capability와 쓰기 경로는 합집합이 됩니다(13.6).
3. **에이전트가 죽은 뒤의 네트워크 복구는 다음 기동에 일어납니다.** 커널 패닉이나 전원 상실은 이 메커니즘이 다루지 못합니다. 되돌리기 기록은 디스크에 있으므로 재기동하면 복구되지만, 재기동하지 못하는 호스트는 콘솔이 필요합니다.
4. **파일시스템 확장은 되돌릴 수 없습니다.** 줄이기가 없기 때문이며, 이것이 이 작업이 비파괴적인 이유이기도 합니다.
5. **불변 OS 경로는 살아 있는 호스트에서 검증되지 않았습니다** (13.10).
6. **정책 변경에는 2인 승인도 Git 리뷰도 없습니다.** 정책에는 쓰기 API가 없고 백엔드 역할은 읽기 권한만 가지므로 편집에는 데이터베이스 직접 접근이 필요하지만, 그 접근을 가진 사람을 막는 것은 아무것도 없습니다. 남는 것은 사후 증거입니다: 모든 실질적 편집이 `console.host_policy_change`에 추가 전용으로 기록되고, 버전이 올라가 기존 승인이 무효화됩니다(12.8).
7. **에이전트 허용 목록은 스냅샷을 통해 옵니다.** 백엔드는 요청 시점에 그것과 교집합을 취하지만, 스냅샷이 오래되었다면 교집합도 오래된 것입니다. 이것은 넓히는 방향으로는 위험하지 않습니다 — 에이전트가 실행 시점에 자기 설정으로 다시 검사하므로 최종 판단은 항상 호스트의 현재 설정입니다. 좁히는 방향, 즉 방금 허용된 대상이 잠시 거절되는 일은 있을 수 있습니다.
8. **불변 OS 어댑터의 syscall·capability 요구사항은 문서화된 계약에서 도출한 것이며 실제 호스트에서 확인되지 않았습니다.** 부족하면 작업은 fail-closed로 실패하고 영수증에 권한 오류가 남습니다. 첫 활성화 시 반드시 확인해야 하는 부분입니다.

## 14. Stage 5 — 배포 전 감사에서 바뀐 것

Stage 5는 새 기능이 아니라 **Stage 1–4 전체에 대한 적대적 감사**입니다. 여기 적힌 것은 전부 감사에서 발견된 실제 결함이며, 전부 수정되었고 각각에 회귀를 막는 테스트가 붙어 있습니다. 이 절을 남기는 이유는 두 가지입니다: 같은 종류의 결함을 다시 만들지 않기 위해서, 그리고 "감사했다"가 무엇을 뜻하는지가 구체적이기 위해서.

### 14.1 계층 경계에서 발견된 결함

가장 많이 나온 결함은 **한 계층이 만든 값을 다음 계층이 조용히 버리거나 다르게 읽는 것**이었습니다. 각 계층의 단위 테스트는 손으로 만든 픽스처를 쓰기 때문에 전부 통과하고, 실제로 이어 붙였을 때만 드러납니다.

| 결함 | 결과 | 수정 |
|---|---|---|
| nmcli는 값이 없는 속성을 `--`로 출력합니다. 실행기는 이것을 빈 문자열로 바꿨지만 **수집기는 그대로 실어 보냈습니다.** | 그 `--`가 사전 상태에 실려 승인된 digest에 들어가고, 에이전트는 그것을 실제 설정과 비교합니다. 절대 같을 수 없으므로 **게이트웨이가 없는 프로파일에 대한 모든 `network.configure`가 영구히 거부**됩니다. 게이트웨이가 없는 링크는 이 플랫폼이 건드릴 수 있는 유일한 종류이므로 사실상 전부입니다. | 센티널을 nmcli terse 파서 한 곳에서 제거합니다. 필드마다 처리하면 다음에 추가되는 필드가 또 빠집니다. |
| 에이전트가 보고하는 Stage 4 허용 목록(`networkAllowlist`, `mountRoots`, `growAllowlist`, `imageAllowlist`)을 **백엔드가 한 번도 읽지 않았습니다.** | 요청이 권한·AAL2·2인 승인·정책·정비 창을 전부 통과하고 dispatch된 뒤 호스트에서 거부됩니다. 관련된 모두가 "승인되었다"고 들은 다음에. | 요청 시점에 교집합을 취합니다. `service.restart`가 이미 하던 것과 같습니다. |
| `OPERATION_SELECT`가 스냅샷을 가져오지 않아, `host.reboot`의 노드 이름 대체 경로가 항상 빈 문자열이었습니다. | 호스트 id가 Kubernetes 노드 이름과 다른 호스트에서는 **모든 재부팅이 준비 단계에서 실패**하고, 오류 메시지는 노드 매핑을 탓합니다. | 스냅샷을 함께 조회하고, PostgREST가 객체와 배열 중 무엇을 돌려주든 같은 정규화기를 거칩니다. |
| 유닛 이름 문법이 백엔드와 에이전트에서 달랐습니다(주석은 "byte for byte 일치"라고 적혀 있었습니다). | 백엔드는 `foo..service`를 받아들이고 에이전트는 거부합니다 — 승인되었지만 실행될 수 없는 작업. 반대로 `getty@tty1.service`는 에이전트가 받는데 백엔드가 막습니다. | 에이전트의 문법을 그대로 옮기고, `.service` 제한은 `service.restart`에만 따로 적용합니다. |
| 사전 상태의 주소 상한이 수집(8)과 계획(4)에서 달랐습니다. | 정적 주소가 5개 이상인 프로파일은 사전 상태가 잘려서 실행 시점 비교가 절대 일치하지 않습니다. | 자르지 않고 요청 시점에 이유를 붙여 거절합니다. |
| 백엔드가 영수증의 시각을 검증하지 않았습니다. | 에이전트가 서명할 수 없는 문서(시작보다 먼저 끝난 실행)를 저장할 수 있었습니다. | 두 시각의 존재와 순서를 검증합니다. |

### 14.2 보안에서 발견된 결함

| 결함 | 수정 |
|---|---|
| 마운트 지점 검사가 전부 **문자열 비교**였습니다. `/srv/data`가 `/etc`를 가리키는 심볼릭 링크면, 승인된 경로와 커널이 실제로 마운트하는 디렉터리가 다릅니다. `mount(2)`는 마지막 구성요소를 따라가고, `findmnt`는 정규화된 경로를 돌려주므로 점유 검사도 이것을 잡지 못합니다. | 마운트와 확장 모두 경로를 해석한 뒤 다시 검사합니다. 링크를 통해 도달하는 경로는 거부합니다. |
| 드롭인의 `SystemCallFilter=~...` 거부 목록은 기본 유닛이 막아둔 그룹을 **되살릴 수 없습니다.** systemd는 필터를 병합하고 거부 목록은 빼기만 하기 때문입니다. 즉 패키지·이미지 드롭인은 필요한 syscall을 실제로는 허용하지 않고 있었습니다. | 양의 항목으로 바꿨습니다. 필요 없는 두 드롭인에서는 아예 제거했습니다(13.6). |
| 스토리지·이미지·패키지 드롭인이 `ProtectSystem=full`로 낮췄습니다. 매뉴얼은 `strict`가 유지된다고 적혀 있었습니다. | `strict`를 유지하고 필요한 경로만 나열합니다. 패키지 드롭인의 경우 자기 `ReadWritePaths`와 합쳐 `ProtectSystem=full`은 아무것도 보호하지 않고 있었습니다. |
| `securityOnly`가 digest와 영수증에 실리지만 **아무것도 강제하지 않았습니다.** | apt 시뮬레이션 결과의 출처(origin)를 검사해, 보안 저장소가 아닌 후보가 하나라도 있으면 거부합니다. 의존성으로 끌려오는 것도 포함됩니다. |
| `new URL(req.url, \`http://${req.headers.host}\`)`이 try 밖에 있었습니다. 빈 `Host` 헤더 하나로 프로세스가 죽습니다. | 고정 base를 쓰고 try 안으로 옮겼습니다. Host 헤더는 라우팅에 쓰이지 않으므로 신뢰할 이유가 없습니다. |
| 내부 서비스 응답을 `response.text()`로 전부 버퍼링한 **뒤에** 크기를 검사했습니다. | 스트림을 바이트 단위로 세면서 읽습니다. 수집기의 자식 프로세스 출력도 같은 문제여서 같이 고쳤습니다. |
| `resize2fs`/`xfs_growfs` 호출에만 `--` 구분자가 없었습니다. `resolveUUID`는 경로를 조립하면서 UUID 형식을 다시 확인하지 않았습니다. | 둘 다 추가했습니다. 상위에서 이미 막고 있지만, 문자열을 장치 경로로 바꾸는 함수가 호출자를 믿을 이유는 없습니다. |

### 14.3 데이터베이스에서 발견된 결함

**두 설치 경로가 서로 다른 데이터베이스를 만들고 있었습니다.** 마이그레이션 0002는 `ALTER DEFAULT PRIVILEGES`로 이후 생성되는 모든 테이블에 백엔드 역할의 전체 DML을 부여합니다. 통합 baseline에는 그 선언이 없었습니다. 결과적으로 **업그레이드된 리전에서는 백엔드가 작업 카탈로그를 다시 쓸 수 있었고**(lease 상한을 늘리거나 2인 승인 요구를 끄거나 없는 작업을 만들 수 있었다는 뜻입니다), 새로 설치한 리전에서는 그럴 수 없었습니다. 한쪽 경로만 시험하는 테스트로는 절대 보이지 않는 종류의 차이입니다.

수정은 두 갈래입니다: 좁아야 하는 테이블에는 명시적 `REVOKE`를 붙여 양쪽 경로가 같은 곳에 도달하게 하고, baseline에는 0002/0008의 기본 권한 선언을 그대로 옮겨 이후 생성되는 테이블도 같게 만들었습니다. 그리고 `npm run test:db`가 이제 **두 경로를 각각 세우고 결과를 비교**합니다.

나머지:

| 결함 | 수정 |
|---|---|
| lease 검사가 **진입 경계에서만** 이루어졌습니다(`status='leased' AND OLD.status<>'leased'`). 이미 leased인 행을 UPDATE하면 소유자를 바꾸거나 만료를 10년 뒤로 밀 수 있었습니다. | 보유 중인 lease의 소유자·만료·시도 번호를 전부 고정합니다. |
| 영수증이 어느 시도(attempt)의 것인지 데이터베이스가 확인하지 않았습니다. `result_digest`는 불변 규칙에서 빠져 있었습니다. | 영수증이 `attempt`를 실으면 leased attempt와 일치해야 하고, 저장된 digest는 다시 쓸 수 없습니다. |
| 완료된 작업은 UPDATE로는 불변이지만 **DELETE로는 사라질 수 있었습니다.** | 백엔드 역할에서 DELETE 권한을 회수했습니다. 저하 기록과 정책도 같습니다. |
| `policy_id`/`policy_version`이 불변이 아니었습니다. dispatch 직전에 새 버전으로 다시 가리키면 "정책이 바뀌면 승인이 무효화된다"는 규칙 전체가 무력화됩니다. | 승인 이후 재지정을 거부합니다. `policy_window_id`는 dispatch마다 다시 평가되는 값이므로 의도적으로 제외했습니다. |
| 가드 트리거 여섯 개가 기본값(ORIGIN)이었습니다. `SET session_replication_role = replica` 한 줄이면 조용히 꺼집니다. | 전부 `ENABLE ALWAYS`입니다. 두 설치 경로에서 모두 그런지도 검사합니다. |
| 정책·창·저하 기록의 RLS가 `USING (true)`였습니다. 인증된 운영자라면 배정되지 않은 리전의 정책, 허용 이미지, 마운트 루트, cordon된 노드 이름을 전부 읽을 수 있었습니다. | `console.host`와 같은 규칙으로 배정 범위를 검사합니다. |
| 0028이 상태 집합을 좁히고 카탈로그 외래키를 추가하지만, 기존 행에 대한 처리가 없었습니다. | `dispatched` 행을 `expired`로 정리하고, 카탈로그에 없는 작업이 있으면 이름을 대며 거부합니다. 이력을 지워서 마이그레이션을 통과시키지는 않습니다. |
| 동시 실행 방지 인덱스를 매번 DROP 후 재생성했습니다. 재실행하면 그 사이 동안 보장이 없습니다. | `IF NOT EXISTS`로 바꿨습니다. |
| baseline에 마이그레이션 원장(`console.schema_migration`)이 없었습니다. | 추가했습니다. 없으면 새로 설치한 리전은 이후 증분 마이그레이션을 받을 수 없습니다. |

### 14.4 문서에서 발견된 결함

이 매뉴얼 자체가 감사 대상이었고, 사실이 아닌 문장이 여럿 있었습니다. 가장 중요한 것: **"정책 편집이 `console.hosts.approve`를 요구하고 감사에 남는다"는 문장은 사실이 아니었습니다.** 정책에는 쓰기 API가 아예 없고, 편집은 직접 SQL이며, 감사 행은 남지 않았습니다. 그 문장은 Git 리뷰가 없다는 사실의 *완화 근거*로 쓰이고 있었으므로, 틀린 완화를 근거로 남는 위험을 축소해 적고 있었던 셈입니다. 12.8을 다시 썼고, 백엔드 역할의 쓰기 권한을 회수했으며, 추가 전용 기록 테이블을 만들었습니다.

그 밖에 수정한 것: 계획 유효 기간(30분 → 60분), 상세 구획 수(7 → 8), Stage 1 시절의 "네트워크·스토리지 변경 미구현" 표 행, "수집하지 않는다"고 적혀 있던 주소·MTU·링크 상태, 드롭인 개수(3 → 4, Stage 3의 패키지 드롭인이 문서에 아예 없었습니다), 그리고 정책 생성·권한 부여·설정 필수 항목처럼 **없으면 첫 사용이 막히는 절차들**.

### 14.5 감사 도구 자체에서 발견된 결함

감사가 "가드마다 그것을 지켜보는 테스트가 있다"를 확인하는 방법은 **변이 테스트**입니다. 가드를 하나씩 실제로 망가뜨린 뒤, 지켜본다고 주장하는 테스트가 정말 빨간불이 되는지 봅니다. 죽지 않고 살아남은 변이는 곧 아무도 보고 있지 않은 가드입니다.

이 도구 자체에 결함이 있었습니다. 그리고 결함은 **서로 반대되는 두 방향**으로 나뉘며, 읽을 때 구별해야 합니다.

- **거짓 "잡음"(false killed)** — 아무도 지켜보지 않는 가드를 지켜본다고 기록합니다. 감사 결과를 실제보다 좋게 보이게 만들고, 없는 보호를 있다고 믿게 하므로 **위험한 방향**입니다. 아래 표의 대부분이 여기에 속합니다.
- **거짓 "살아남음"(false survived)** — 실제로는 잡히는 가드를 놓쳤다고 기록합니다. 결과를 실제보다 나쁘게 보이게 하므로 배포 위험은 없지만, 존재하지 않는 결함을 쫓게 만들고 sweep 결과 전체의 신뢰를 떨어뜨립니다.

두 번째 방향은 원인도 다릅니다. 대상 코드의 결함이 아니라 **관측 행위가 대상을 바꾼 것**이었습니다. 표의 마지막 두 행이 각각의 예이고, 서로 다른 고장입니다.

그리고 이 규칙들 자체가 한동안 **손으로만 확인된 상태**였습니다. 감사가 다른 모든 곳에서 거부하는 기준입니다. 지금은 저널 규칙이 `scripts/lib/sweep-journal.mjs`로 분리되어 임시 파일을 상대로 직접 시험되고, 변이 여섯 건이 그 시험을 지켜봅니다. 분리한 이유는 하나 더 있습니다 — sweep이 자기 자신을 변이시키려면 anchor가 코드에 한 번만 나타나야 하는데, sweep 스크립트 안에 두면 **그 변이를 정의하는 표에도 같은 문자열이 있어 두 번 일치**합니다.

그 시험을 쓰다가 같은 함정에 다시 빠졌습니다. 처음 쓴 pid 확인 테스트는 sweep 스크립트의 소스에서 `pid: process.pid`를 찾았는데, 실제로 찾아낸 것은 **그 가드를 지목하는 변이 표의 문자열**이었습니다. 가드를 지워도 초록불이었고, 변이 하나가 살아남아 그것을 드러냈습니다. 지금은 모듈을 실제로 불러 저널을 쓰고, 살아 있는 소유자가 거부되는지를 확인합니다.

| 결함 | 결과 | 수정 |
|---|---|---|
| 변이 지점(anchor)이 소스와 더 이상 일치하지 않아도 "통과"로 셌습니다. Stage 5가 `resize2fs` 호출에 `--` 구분자를 추가하면서 실제로 한 건이 그렇게 됐습니다. | 아무것도 망가뜨리지 않은 변이가 "테스트가 잡았다"로 기록됩니다. 그 가드는 사실 한 번도 검증되지 않았습니다. | anchor 검사를 변이에서 분리해 `--check-anchors`로 1초 만에 확인하고, 일치하지 않으면 실패로 셉니다. 이미 변이된 텍스트가 디스크에 남아 있는 경우도 잡습니다. |
| 중단 시 소스 복원이 `finally`와 `process.on('SIGTERM')`에 의존했습니다. 그러나 테스트 실행은 `spawnSync`였고, **이것이 이벤트 루프를 막기 때문에 신호 처리기는 자식이 끝날 때까지 실행되지 않습니다.** 자식이 멈춰 있으면 영원히 실행되지 않습니다. | 실제로 이 감사 중에 sweep을 죽였고, 마이그레이션 파일에 `IF false THEN`이 남았습니다. 그대로 커밋됐다면 가드 하나가 조용히 없는 채로 배포됩니다. | 비동기 `spawn`으로 바꿔 루프를 비워 두고, 자식을 먼저 죽인 뒤 복원합니다. `SIGKILL`은 어떤 처리기로도 잡을 수 없으므로, 변이 전 원본을 적어 두는 저널 파일을 함께 둡니다. 다음 실행이 스스로 복구합니다. |
| SQL 변이 여섯 건이 살아남았습니다. 원인은 테스트 부재가 아니라 **구조**였습니다. 동작을 확인하는 데이터베이스 테스트는 전부 통합 baseline으로 세운 DB에서 돌고, 변이는 마이그레이션을 고칩니다. 두 경로를 비교하던 검사는 열·제약·정책 *이름*만 봤는데, 가드가 속을 잃어도 이름과 모양은 그대로입니다. | 마이그레이션에서 가드를 들어내도 전체 스위트가 초록불입니다. 업그레이드된 리전에서만 가드가 없습니다. | 이제 `prosrc`(함수 본문), `tgenabled`(트리거가 replication 세션에서 꺼지는지), `qual`/`with_check`(RLS 술어)를 두 설치 경로에서 각각 뽑아 비교합니다. 모양이 아니라 **하는 일**이 같아야 합니다. |
| 변이 세 건이 "테스트는 있는데 살아남는" 경우였습니다. 그 테스트들이 `err != nil` 또는 `statusCode === 409`만 확인했기 때문입니다. | 가드를 지우면 **다른** 게이트가 같은 모양의 실패를 내고, 테스트는 그것을 자기가 지목한 가드의 증거로 받아들입니다. | 거절 사유를 문장으로 확인합니다. 백엔드 쪽 한 건은 정책을 일부러 넓혀서, 에이전트 허용 목록 말고는 거절할 수 있는 게이트가 남지 않게 만들었습니다. |
| **[거짓 잡음을 만드는 결함]** 데이터베이스 계약 테스트의 준비 대기가 **초기화용 임시 서버에 응답받고 통과했습니다.** 이 이미지는 `initdb` 동안 유닉스 소켓에만 듣는 임시 서버를 돌리는데, 그 서버도 `auth`·`extensions`·`storage`를 이미 만들어 둔 뒤라 스키마 검사가 통과합니다. 실측하면 소켓 검사는 t=2초에 준비되었다고 답하고, 살아남는 서버는 t=3초에야 연결을 받습니다. | 대상 코드가 아니라 **테스트 하네스 자체의 결함**입니다. 그 1초 안에 진짜 준비가 끝났는지는 순전히 운이고, 실패하면 계약 스위트가 도중에 `the database system is shutting down`으로 죽습니다. SQL 변이는 이 스위트가 실패하는 것으로 채점되므로 **컨테이너가 혼자 죽은 것이 "가드를 잡았다"로 기록됩니다** — 위험한 방향입니다. 다만 이 감사에서 실제로 오채점된 변이가 있었다고 단정하지는 않습니다. 아래처럼 다시 확인했기 때문입니다. | 임시 서버는 소켓만, 진짜 서버는 TCP를 먼저 엽니다. 그래서 `-h 127.0.0.1`로 검사합니다 — 부트스트랩이 끝났고, **최종 서버만 받을 수 있는 연결로** 확인합니다. 고친 뒤 무변이 스위트를 세 번 연속 66/66으로 확인하고, SQL 변이 여덟 건을 다시 돌려 전부 죽는 것을 확인했습니다. 두 컨테이너 부트스트랩 각각에 변이를 하나씩 붙였고, Docker 없이도 도는 테스트가 이 불변식을 지킵니다. |
| **[거짓 살아남음을 만드는 관측 간섭]** 복구 저널에 **소유자가 없었습니다.** 어떤 실행이든 시작할 때 저널이 있으면 무조건 복원했고, `--check-anchors`처럼 읽기만 하는 명령도 그랬습니다. | 위와 달리 이것은 하네스의 결함이 아니라 **관측 행위가 대상을 바꾼 것**입니다. 감사 중에 실제로 일어났습니다: sweep이 돌고 있는 동안 `--check-anchors`를 실행하자 **지금 변이 중인 파일을 원본으로 되돌려 놓았습니다.** 그 변이는 멀쩡한 소스를 상대로 채점되므로 "살아남음"이 됩니다. 방향이 반대라 배포 위험은 없지만, 그 sweep 실행 결과는 폐기하고 다시 돌려야 했습니다. | 저널에 소유 프로세스의 pid를 적습니다. 살아 있으면 두 번째 sweep은 돕지 않고 **거부**하고, 죽었을 때만 복구합니다. `--check-anchors`는 이제 아무것도 쓰지 않습니다. 생존 판정은 `ESRCH`만 "없음"으로 봅니다 — `EPERM`은 다른 사용자가 돌리고 있다는 뜻이라 오히려 살아 있다는 증거입니다. 세 경로(거부·복구·읽기 전용)를 손으로 각각 확인했습니다. |
| 콘솔 폼의 숫자 상한과 백엔드가 실제로 받는 범위를 **아무것도 묶어두지 않았습니다.** 지금은 우연히 일치합니다. | 한쪽만 넓히면 운영자가 폼을 다 채우고 사유를 쓴 뒤 400을 받고, 한쪽만 좁히면 콘솔이 플랫폼에 있는 범위를 숨깁니다. | 폼의 `min`/`max`를 소스에서 읽어 실제 정규화기에 통과시킵니다. MTU는 0과 1280 사이가 비어 있어 `min`/`max`로 표현할 수 없으므로, **도움말 문구에 적힌 숫자**를 백엔드와 대조합니다. 운영자가 읽는 것이 그 문구이기 때문입니다. |

### 14.6 매뉴얼 시드는 재현 가능합니다

`/manual`이 실제로 서빙하는 것은 저장소에 커밋된 시드 파일입니다. 그 시드의 `version`이 **생성 시각**이었습니다. 결과적으로 내용이 하나도 바뀌지 않아도 다시 만들 때마다 파일이 달라졌고, **진짜 편집과 그냥 다시 돌린 것을 diff로 구별할 수 없었습니다.** 리뷰어에게는 매번 "무언가 바뀌었다"고 말하면서 정작 무엇이 바뀌었는지는 말해주지 않는 상태입니다.

이제 `version`은 시드가 담고 있는 것의 **내용 해시**입니다:

- `sha256:<hex>` 형태이며, `documents`·`concepts`·`relations`를 직렬화해 해싱합니다. 내용이 바뀌면 바뀌고, 바뀌지 않으면 바뀌지 않습니다.
- **`source`를 포함해 파일 전체를 해싱합니다.** 처음에는 제외했습니다. `source.basePath`가 빌드를 돌린 기계의 플랫폼 체크아웃 **절대 경로**였기 때문입니다. 그것까지 해싱하면 같은 내용을 가진 두 사람이 서로 다른 version을 만들어내므로, 같은 결함을 옷만 갈아입혀 되살리는 셈이었습니다.
- 그래서 **provenance를 위치가 아니라 이름으로 바꿨습니다**: `basePath`는 이제 `opensphere-platform-root`입니다. 문서마다 실린 `sourcePath`가 이미 체크아웃 기준 상대 경로(`_DOCS_/…`, `OpenSphere-console/…`)이므로 절대 경로는 읽는 사람에게 아무것도 더 알려주지 않았고, **공유 산출물에 특정 개발자의 홈 디렉터리를 박아 넣고 있었을 뿐**입니다. 위치가 사라지자 제외할 이유도 사라져서 digest가 파일 전체를 덮습니다.
- 따라서 **동일한 입력에 대해 `npm run manual:seed:console`을 몇 번 돌려도 결과 파일은 바이트 단위로 같고, 다른 기계에서도 같습니다.**

`version`이 날짜가 아니게 되면서 갈 곳을 잃은 의미가 하나 있습니다. 매뉴얼 API는 자체 날짜가 없는 문서에 시드의 `version`을 `updatedAt`으로 물려주고 있었고, 콘솔은 그것을 `new Date(...)`로 파싱해 "업데이트" 칸에 찍으며, 출처 목록은 그 값의 사전순 최댓값을 취합니다. 해시는 이 셋 중 어느 것도 만족하지 못하고, 콘솔의 `dateOf`는 파싱에 실패하면 **원본 문자열을 그대로 보여주므로** 운영자 화면에 해시가 찍혔을 것입니다 — 오류가 아니라 조용한 오표시로.

그래서 시드는 이제 `updatedAt`을 따로 싣습니다. 시드 안의 문서들이 선언한 날짜 중 **가장 최근 것**이며, 추론이 아니라 명시입니다.

회귀는 네 갈래로 막습니다: 시드의 `version`이 자기 내용의 해시와 정확히 같은지 테스트가 독립적으로 다시 계산해 확인하고, 타임스탬프 모양이면 별도로 실패하며, 서빙되는 모든 문서가 읽을 수 있는 날짜를 갖는지 실제 API 인덱스를 세워 확인하고, `source`의 어떤 값도 절대 경로나 홈 디렉터리가 아님을 확인합니다. 마지막 항목은 단정함의 문제가 아닙니다 — 이제 `source`가 digest 안에 있으므로, 절대 경로가 다시 들어오면 **version이 기계마다 달라져 위의 멱등성이 조용히 무너집니다.** 변이 네 건이 이 넷을 각각 지켜봅니다.

#### 두 생성 경로가 같은 산출물을 만듭니다

시드를 만드는 길은 둘입니다. `--console-only`는 Console 문서만 다시 읽고 플랫폼 문서는 기존 시드에서 이월하며, 전체 모드는 `OPENSPHERE_PLATFORM_ROOT` 아래에서 **13개 플랫폼 문서를 전부 다시 읽습니다.** 그동안 이 감사는 앞의 것만 돌려 왔고, 뒤의 것은 확인되지 않은 채였습니다. 데이터베이스에서 baseline만 시험하고 마이그레이션 경로를 시험하지 않았던 것과 같은 모양의 빈틈입니다.

실제로 돌려 확인했습니다. 결과:

- 전체 모드를 두 번 돌린 결과가 서로 **바이트 단위로 같습니다.**
- 전체 모드의 결과가 `--console-only`의 결과와도 **바이트 단위로 같습니다.** 두 경로는 같은 파일을 만듭니다.
- 플랫폼 루트를 `/tmp` 아래 임시 경로로 두고 돌려도 **그 경로가 산출물 어디에도 나타나지 않습니다.** provenance를 이름으로 바꾼 것이 실제로 성립함을 보여줍니다.
- 로컬 체크아웃에 실제로 존재하는 플랫폼 문서 11건은 시드에 실린 체크섬과 **전부 일치합니다.** 시드는 최신입니다.

### 14.7 남아 있는 위험

**통합 baseline이 마이그레이션 0025를 아직 흡수하지 않았습니다.** 새로 설치한 리전에는 `external_backup_target`, `configuration_backup`, `configuration_restore` 테이블과 관련 함수 세 개가 없고, 업그레이드된 리전에는 있습니다.

이것은 이번 작업이 만든 것이 아닙니다. 분기 시점의 baseline도 같은 상태였고, 0025는 이 브랜치에서 건드리지 않았습니다. 그래서 여기서 고치지 않았습니다 — 관련 없는 마이그레이션을 배포 baseline에 접어 넣는 것은 이 변경이 결정할 일이 아닙니다.

대신 **이름을 붙여 범위를 고정했습니다.** 두 경로 비교 테스트는 이 여섯 개를 명시적 예외로 들고 있고, 차이가 그보다 넓어지면 실패합니다. 0025가 baseline에 반영되어 차이가 사라져도 실패합니다. 즉 이 예외는 조용히 자라지도, 조용히 남아 있지도 않습니다.

**상위 헌법 문서 두 건이 이 기계의 어느 플랫폼 체크아웃에도 없습니다.** `CONSTITUTION-0003-SHELL-HOSTING-INTEGRATION.md`와 `CONSTITUTION-0004-PLATFORM-BOOTSTRAP-SUPPORT-FOUNDATION-LIFECYCLE.md`입니다. 나머지 11건은 있고 시드와 체크섬이 일치합니다.

그래서 `npm run manual:seed`를 그대로 돌리면 **생성기가 두 문서를 이름으로 지목하며 거부합니다.** 이것은 고장이 아니라 설계대로 동작하는 fail-closed입니다 — 권위 문서를 조용히 뺀 시드는 무엇이 빠졌는지 이미 아는 사람만 알아챌 수 있기 때문입니다.

전체 경로를 실제로 시험하기 위해, 이 두 문서를 시드에 실려 있던 내용으로 임시 디렉터리에 복원해 완전한 플랫폼 루트를 만들고 그것을 대상으로 돌렸습니다. 위에 적은 동등성·결정성 결과는 그렇게 얻은 것입니다. **다만 그 두 문서에 대해서는 이것이 상위 저장소와의 최신성을 증명하지 않습니다** — 내용의 출처가 시드 자신이므로 순환입니다. 증명된 것은 생성기의 전체 경로가 동작하고 두 경로가 같은 산출물을 낸다는 것이며, 두 문서의 최신 여부는 상위 저장소를 가진 곳에서 다시 확인해야 합니다.

### 14.8 CC2 실배포와 라이브 검증

Stage 5까지는 배포하지 않은 상태의 감사였습니다. Stage 6에서 실제로 CC2에 배포하고 단일 호스트를 **읽기 전용으로** 등록했습니다. 아래는 관측된 증거이며, **브라우저에서 본 것과 서버에서 확인한 것을 구분해서** 적습니다. 둘은 증명하는 범위가 다릅니다.

#### 배포 전 노출된 Secret 회전

감사 도중 조사 명령 하나가 Secret의 **값**을 출력했습니다(키 이름만 나열하려던 명령이 `.data`를 함께 찍었습니다). 배포보다 먼저 회전했습니다.

회전 대상은 `jwt-secret`·`anon-key`·`service-role-key`, Gitea `reconciler-token`, Gitea `db-password`입니다. **통합 Secret을 지워 재생성하는 방법은 쓰지 않았습니다.** 그 경로는 `postgres-password`까지 새로 만드는데, 이미 초기화된 PGDATA에서는 그 값이 반영될 수 없어 데이터베이스가 끊깁니다. 대신 노출된 키만 골라 patch했고, 값은 프로세스 인자가 아니라 stdin으로 전달했습니다. Gitea는 Secret만으로는 부족해 `ALTER ROLE gitea PASSWORD`를 함께 수행했습니다 — 컨테이너의 `POSTGRES_PASSWORD` 계열 환경변수는 최초 초기화에만 쓰이기 때문입니다.

회전 후: 사용자 1명·검증된 TOTP 1건 그대로, PostgreSQL Pod 재시작 0회, PVC 5개 Bound 유지.

#### 서명 체인 (서버에서 확인)

배포된 산출물을 실제로 내려받아 검증했습니다.

| 항목 | 결과 |
|---|---|
| Registry `trustedKeys` 지문 | `f547dc4b…9777e1` — 서명 키와 일치 |
| manifest digest pin | 일치 |
| 분리형 P-256 서명 | 검증 성공 |
| 변조된 manifest | 거부됨 |
| entry 번들 digest pin | 일치 (95,187바이트) |

#### 공개 프로필 브라우저 E2E (브라우저에서 본 것)

격리된 managed Chrome으로 `https://rcc.cc2.opl.io.kr/`를 실제 렌더링했습니다. `title=PolyON Region Control Center`, 로그인 폼 정상, 접근성 트리 정상입니다. 전체 페이지 스크린샷을 증거로 보관합니다.

콘솔 상태는 **최종 재배포 이후 재검사(2026-07-26 01:44:43Z, navigate 후 networkidle)** 기준으로 적습니다: **page error 0건, Google Fonts stylesheet가 self-only CSP에 차단되는 메시지 2건, 그 외 console error 0건.** 그 2건은 외부 폰트를 받아오지 못했다는 뜻이고 기능 경로와는 무관하지만, 콘솔이 완전히 비어 있는 것은 아니므로 "console error 0"이라고 적지 않습니다. 초기 관측에서는 이 2건이 집계되지 않았는데, 지금 유효한 것은 최종 재검사 쪽입니다.

기존 Chrome 프로필로도 재확인했습니다. 원본은 건드리지 않고 0700 임시 복사본을 사용했으며, Secret 회전 직후이므로 세션이 로그인 화면으로 돌아왔습니다(saved login 0, cookie 0, 1Password 계정 미등록). 이 복사본에서는 Google Fonts 외부 stylesheet가 self-only CSP에 막히는 **cosmetic console message 2건**만 있었고 page error는 0건입니다. 외부 폰트 차단은 결함이 아니라 `style-src 'self' 'unsafe-inline'`이 의도대로 동작한 결과입니다.

별도의 헤드리스 Chrome 세션에서는 Main Shell이 `/api/v1/registry`를 가져온 뒤 manifest·`.sig`·`entry.js`를 차례로 요청하는 것을 확인했습니다. **`entry.js`까지 요청했다는 사실 자체가** manifest digest와 서명 검증을 통과했다는 뜻입니다. CSP 위반 0건, 플러그인 검증 오류 0건.

#### 인증 구간은 미검증 (credentials pending)

로그인 이후의 화면 — `/cc/cc2/hosts`에서 subShell이 등록된 호스트를 그리는 경로 — 은 **검증하지 않았습니다.** 운영자 자격증명이 없고, 계정 생성·비밀번호 초기화·service-role 가장은 모두 승인 범위 밖이므로 하지 않았습니다. 브라우저 증거는 여기까지입니다.

같은 사실을 **서버 측에서** 확인한 것은 따로 적습니다: 호스트 상태 `active`, 스냅샷 1건 수신, 쓰기 권한 전부 `false`, `/manage/*`와 `/cc/cc2/kubernetes` 각각 200. 이것은 화면이 그렇게 그려진다는 증명이 아니라 데이터와 라우트가 그렇다는 증명입니다.

#### 읽기 전용 에이전트

`rcc-node-agent`가 `cmars-oci-cc-02-4x24`에서 active·enabled 상태이며 기동 로그에 `typed operations disabled; host reports snapshots only`를 남깁니다. heartbeat는 202로 수용되고 등록 상태가 `pending`에서 `active`로 승격되었습니다. 모든 권한이 `false`, 모든 허용 목록이 비어 있고, **package·network·storage·image 샌드박스 드롭인은 아예 설치하지 않았습니다.**

스냅샷은 부분 degraded로 보고됩니다. CC2는 `systemd-networkd`를 쓰고 `nmcli`가 없어서 링크 인벤토리를 읽지 못하며, 에이전트는 이를 **추측하지 않고 자기 사유와 함께 unsupported로 보고**합니다. `boot`도 unsupported입니다 — 이 호스트는 이미지가 아니라 패키지 관리자로 갱신되기 때문이며 정확한 판정입니다. `storage`는 정상입니다. 13.x에서 설명한 실패 폐쇄 경로가 실제 호스트에서 그대로 동작한 것입니다.

#### 배포로 고쳐진 것 하나

배포 전 `/api/health`가 200을 반환했는데, 이는 정상이 아니라 결함이었습니다. nginx에 `/api/` 규칙이 없어 알 수 없는 API 경로가 SPA로 흘러 HTML을 200으로 돌려주고 있었습니다. 새 빌드는 `location ^~ /api/`로 백엔드에 넘기고, 백엔드가 JSON 404를 반환합니다. 200에서 404로 바뀐 것이 회귀가 아니라 수정입니다.

### 14.9 그래도 수행하지 않은 것

- **CC2 노드를 재부팅하지 않았습니다.** 배포 전후 uptime이 연속 45일입니다.
- `service.restart`, `host.reboot`, package·kernel, network, storage, filesystem, OS-image **작업을 한 건도 실행하지 않았습니다.** 워크로드 rollout과 새 에이전트 서비스 기동만 수행했습니다.
- 운영자 자격증명을 만들거나 초기화하지 않았고, service-role 키로 사람을 가장하지 않았습니다.
- **커밋하거나 푸시하지 않았습니다.** 그 결과 이미지 태그의 커밋 접두사(`914a52b661da`)는 실제로 담긴 작업 트리 내용과 일치하지 않습니다. 커밋 전까지 이 태그의 출처 표시는 신뢰할 수 없습니다.
- 웹 이미지의 플러그인 서명 키는 저장소 밖(0600)에 보관된 기존 키를 사용했고, 새로 만들지 않았습니다.
- Headlamp, `/manage/*`, `/cc/cc2/kubernetes`, 무관 워크로드는 변경하지 않았습니다.

## 15. 배포 후 감사 — 기능 단위 1(호스트 등록과 읽기 전용 상태 조회)

Stage 5 감사는 배포 **전**에 수행했습니다. 이 절은 배포된 시스템을 사용자 기능 단위로 다시 감사하면서 발견한 것입니다. 단위 1의 범위는 등록·heartbeat·HMAC 바인딩·재생 방지·`pending`→`active` 승격·호스트 목록/상세 API·신선도 판정·subShell의 목록과 Overview 표시입니다.

### 15.1 운영에서 재현된 결함: 에이전트가 자기 마운트 네임스페이스를 호스트의 것으로 보고했습니다

수집기는 `/proc/self/mounts`를 읽었습니다. 그런데 에이전트 유닛은 `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`로 기동하므로, **그 프로세스가 보는 마운트 표는 호스트의 것이 아니라 systemd가 만들어 준 사설 뷰**입니다. `ProtectSystem=strict`는 계층 전체를 읽기 전용으로 다시 마운트합니다.

CC2에서 확인된 실제 저장 payload는 다음과 같았습니다. `filesystems` 1건, `/dev/sda1`, mountPoint `/`, ext4, **`readOnly=true`**. 호스트의 루트 파일시스템은 쓰기 가능합니다. 즉 화면의 Storage 탭 "Mode" 열은 `read-only`라고 적고 있었고, 그것은 사실이 아니었습니다.

이 결함의 성격이 중요합니다. 값이 비거나 오류가 난 것이 아니라, **그럴듯하고 확신에 찬 거짓**이 표시되었습니다. 운영자가 "루트가 읽기 전용이다"를 보면 그것은 장애 상황이며, 실제로는 아무 일도 없었습니다.

수정: 마운트 표는 **PID 1의 것**(`/proc/1/mounts`)을 읽습니다. 그것이 호스트 자신의 네임스페이스이고, 운영자가 묻고 있는 대상입니다.

- PID 1의 표를 읽을 수 없으면 자기 뷰로 되돌아가되, `degraded`에 `mountNamespace`를 남깁니다. 읽을 수 있는 것을 보고하는 것은 옳지만, **그것이 호스트의 뷰인 척하지는 않습니다.**
- 사용량(statfs)은 여전히 이 프로세스의 네임스페이스에서 측정되므로, **두 뷰가 같은 파일시스템을 가리킬 때만** 측정합니다. `ProtectHome`이 `/home`을 다른 것으로 덮어쓴 호스트에서 그대로 측정했다면, 이번에는 *다른 파일시스템의 숫자를 진짜 `/home`의 것으로* 게시하게 됩니다. 하나의 거짓을 고치면서 다른 거짓을 만들지 않기 위한 조건입니다. 측정하지 못한 항목은 `degraded`의 `filesystemUsage`로 보고됩니다.
- **쓰기 권한은 넓어지지 않았습니다.** `/`는 `guard.ProtectedMountPoint`의 보호 경로이고 그 판정이 `readOnly`보다 먼저 적용되므로, `readOnly`가 바로잡혀도 `/`가 `filesystem.grow` 대상이 되지는 않습니다. 제어센터는 여전히 `read-only` 모드입니다.

### 15.2 조용히 잘리던 목록들

- `degraded` 상한이 16이었고, 키는 상한 적용 **전에** 정렬됩니다. 수집기가 낼 수 있는 키는 18개 이상이므로, 잘리는 것은 임의의 키가 아니라 **언제나 같은 두 개**(`systemd`, `uptime`)였습니다. 가장 많이 망가진 호스트에서 가장 신뢰할 수 없는 목록이 되는 구조입니다. 상한을 32로 올렸고 백엔드 수용 상한도 같이 올렸습니다. 백엔드가 더 좁으면 에이전트가 애써 보고한 실패를 게이트웨이에서 버리게 됩니다.
- 마운트 목록과 인터페이스 목록은 상한에서 잘리면서 **아무 표시도 남기지 않았습니다.** 잘린 목록은 완전한 목록으로 읽힙니다. 각각 `mountsTruncated`, `netDevTruncated`를 남기도록 했습니다. 실패 유닛 목록이 이미 따르던 규칙과 같습니다. 정확히 상한만큼인 목록은 잘린 것이 아니므로 표시하지 않습니다.
- `kernel` 키 하나가 서로 다른 두 실패를 가리키고 있었습니다. 커널 **버전 문자열**을 못 읽은 것과 커널 **업데이트 확인**이 실패한 것입니다. 앞의 것을 `kernelVersion`으로 분리했습니다.

### 15.3 화면이 API가 보내지 않는 필드를 읽고 있었습니다

subShell의 호스트 헤더는 `host.degradedKeys`를 읽어 "Collector degraded: …"를 렌더링합니다. API 투영은 `degradedCount`(개수)만 내보냈고 키 배열은 스냅샷 깊은 곳에만 있었습니다. 그래서 **그 줄은 한 번도 렌더링된 적이 없습니다.** 수집이 실패한 호스트가 정상 호스트와 화면상 구별되지 않았습니다.

투영에 `degradedKeys`를 추가했습니다. 서명된 번들을 건드리지 않는 쪽이 더 작은 수정이기 때문입니다. 회귀 테스트는 손으로 만든 fixture가 아니라 **실제 `toHostDetail` 투영**을 DOM에 통과시킵니다. 손으로 만든 fixture는 화면과 항상 일치했고, 그래서 이 결함을 하나도 잡지 못했습니다.

### 15.4 폐기한 호스트가 상세 조회로는 계속 읽혔습니다

7절은 "등록을 `retired`로 바꾸면 조회에서 제외된다"고 적습니다. 목록은 실제로 제외했고 heartbeat도 404로 거부했지만, **상세 라우트는 그러지 않았습니다.** id를 아는 사람에게는 폐기된 호스트의 마지막 스냅샷이 계속 현재 상태처럼 제공되었습니다. plugin 네임스페이스 경유 경로도 같습니다. 상세도 404로 맞췄습니다.

### 15.5 시계가 빠른 호스트는 죽은 뒤에도 초록색이었습니다

신선도는 에이전트의 `collectedAt`으로 판정하고, 미래 시각은 나이 0으로 클램프됩니다. `collectedAt`은 ±900초까지 수용되므로, **시계가 300초 빠른 호스트는 보고를 멈춘 뒤에도 그 편차가 소진될 때까지 `fresh`로 표시**되었습니다. 화면에는 "Last snapshot 0m ago"가 미래 타임스탬프와 함께 찍힙니다.

서버가 스냅샷을 받은 시각(`received_at`)은 우리 자신의 시계이므로 앞서 갈 수 없습니다. 두 나이 중 **더 오래된 쪽**으로 판정합니다. 느린 호스트를 실제보다 신선하게 만들지 않으면서 — 그쪽은 여전히 `collectedAt`이 이깁니다 — 미래 시각 구멍만 닫습니다.

### 15.6 검증했고 결함이 없던 것

- 서명 정본 문자열, 필드 정규식, 스킴, 필드 순서가 Go와 Node 양쪽에서 바이트 단위로 같습니다. 32바이트 미만 키 거부, 상수 시간 비교, 리다이렉트 거부, TLS 1.2 하한, 브라우저 자격증명 거부, 서명 검증 **후에만** nonce 소비.
- 키 A로 호스트 B의 스냅샷을 쓸 수 없습니다. 키 문서 바인딩, payload와 서명된 경로의 동일성, 호스트 행 바인딩 세 곳이 각각 막습니다.
- heartbeat는 plugin 네임스페이스로 도달할 수 없고, plugin 경유 조회는 정규 경로와 **같은** 권한 검사를 받습니다.
- `host_snapshot`은 `host_uuid`가 기본 키이고 `resolution=merge-duplicates`로 갱신되므로 호스트마다 현재 스냅샷 1건입니다.
- statfs 실패는 0을 만들어내지 않고, 화면은 그 값을 `—`(알 수 없음)로 그립니다. 0으로 읽히지 않습니다.
- 에이전트는 어떤 리스너도 열지 않습니다.
- `/proc/meminfo`의 `kB` 처리, `/proc/loadavg`, `/proc/uptime`, `/proc/net/dev` 필드 오프셋, `os-release` 인용부호 처리는 모두 정확합니다.

### 15.7 독립 재검토에서 나온 네 건과 한 건의 판단

**서명된 경로와 실제 요청 경로가 달라질 수 있었습니다.** `controlCenterUrl`은 경로를 허용했지만, 서명 대상 경로는 `agent.HeartbeatPath`가 `/api`부터 새로 만듭니다. `https://host/base`로 설정하면 에이전트는 `/base/api/...`를 요청하면서 서명은 `/api/...`에 묶습니다. 백엔드가 접두사 붙은 경로를 거부하므로 오늘은 fail-closed이지만, **상대가 거부해 주기 때문에만 성립하는 바인딩은 바인딩이 아닙니다.** 이제 경로가 있는 엔드포인트는 설정 검증에서 거부합니다. 허용되는 형태는 호스트만 있는 URL(끝 슬래시 유무 무관)뿐입니다.

**겹쳐 마운트된 지점에서 가려진 파일시스템을 보고했습니다.** 같은 마운트 지점이 두 번 나오면 커널이 쓰는 것은 **마지막** 것이고 앞의 것은 도달할 수 없습니다. 첫 항목을 유지하고 있었으므로, 종류·장치·읽기 전용 플래그 모두 *덮여서 아무도 접근할 수 없는* 파일시스템의 것이었습니다. 이제 마지막 항목이 이깁니다.

- 겹침은 슬롯을 쓰지 않으므로 상한을 소모하지도, 잘림으로 보고되지도 않습니다.
- 상한에 도달한 뒤에도 스캔을 계속합니다. 겹침은 어느 줄에서든 나올 수 있고, 상한에서 멈추면 **오래된 쪽을 고정**하게 됩니다. 슬라이스와 인덱스는 상한에서 성장을 멈추므로 작업량은 호출자가 이미 적용한 512 KiB 읽기 한도 안에 머뭅니다.
- 첫 등장 순서를 유지해 수집 간 보고가 안정적입니다.

**호스트 목록이 200개에서 조용히 완전해 보였습니다.** 정확히 페이지 크기만큼 질의했으므로, 호스트가 더 많은 지역도 꽉 찬 한 페이지를 돌려주었고 그것은 전체 함대로 읽혔습니다. 이제 **201건을 요청해** 페이지가 꽉 찬 것과 지역이 마침 그만큼인 것을 구별하고, 응답은 최대 200건을 유지하면서 `truncated`와 `limit`을 명시합니다. 감사 기록에도 `truncated`가 남습니다.

**화면도 같이 말합니다.** API만 고치면 잘림은 아무도 보지 않는 필드에 머무르고, 운영자가 보는 것은 여전히 `Fleet (200)`입니다. subShell은 이제 이렇게 그립니다.

| 상태 | 제목 | 함께 나오는 것 |
|---|---|---|
| 잘림(`truncated: true`) | `Fleet (first 200)` | 경고: 앞의 200대만 표시되며 이 목록은 **잘린 것이지 전부가 아니라는 것**, 찾는 호스트가 등록되어 정상 보고 중인데도 여기 없을 수 있다는 것 |
| 정확히 한 페이지 | `Fleet (200)` | 없음 — 마침 200대인 지역은 온전한 지역이고, 여기에 경고를 붙이면 경고를 무시하도록 가르치게 됩니다 |
| 비어 있음 | `Fleet (0)` | "No hosts are enrolled in this control center." |
| 두 필드가 없는 응답 | `Fleet (N)` | 없음 — 필드를 보내지 않는 구버전 백엔드를 "잘림"으로 기본값 처리하면 모든 지역에 영구적인 거짓 경고가 붙습니다 |

제목이 개수를 그대로 적는 것은 **화면에 있는 것의 개수**일 때뿐입니다. 지역의 호스트 수로 읽힐 수 있는 자리에서는 `first`가 붙습니다.

**응답 머리말이 자기 본문과 어긋났습니다.** 목록과 상세의 최상위 `hostControlMode`는 `read-only` 리터럴이었는데, 같은 응답 안의 capability는 제어센터의 실제 모드에서 파생됩니다. 지역을 `governed-write`로 옮기는 순간 머리말은 "쓰기 불가"라고 적고 그 옆의 작업들은 스스로를 supported라고 보고합니다. 이제 양쪽 모두 같은 사실에서 파생됩니다.

- **어떤 작업도 활성화되지 않았고 권한도 바뀌지 않았습니다.** capability는 이전에도 실제 모드에서 파생되고 있었고, 바뀐 것은 최상위 필드가 그 사실을 그대로 반영한다는 점뿐입니다.
- 값은 fail-closed로 정규화합니다. `governed-write`가 **정확히** 아닌 모든 값 — 없음, 빈 값, 대문자, 미지의 문자열 — 은 `read-only`로 보고합니다. 데이터베이스가 제약하는 열이지만, 받은 것을 그대로 되뇌는 투영은 스키마 드리프트를 "이 지역은 쓰기를 받는다"는 주장으로 바꿔 놓습니다.

#### `ProtectHostname` — 고치지 않고 한계로 남깁니다

`ProtectHostname=yes`는 유닛에 자기 UTS 네임스페이스를 줍니다. 따라서 `os.Hostname()`은 **서비스가 기동한 시점의** 이름을 돌려주고, `hostnamectl set-hostname`으로 호스트 이름을 바꿔도 에이전트가 재시작할 때까지 보고되는 값은 옛 이름 그대로입니다.

읽기 전용 대안을 모두 검토했고, 전부 더 나빴습니다.

- `/proc/sys/kernel/hostname`은 **같은** 네임스페이스입니다. 아무것도 달라지지 않습니다.
- `/etc/hostname`은 *설정된* 이름이지 *실행 중인* 이름이 아닙니다. DHCP나 cloud-init이 transient hostname을 정하는 호스트에서는 둘이 정당하게 다릅니다. 둘을 비교해 불일치를 `degraded`로 올리면 **아무 문제 없는 호스트에 거짓 항목**이 생깁니다. `degraded` 목록은 그 안의 모든 것이 진짜일 때만 값이 있습니다 — 15.2에서 그 목록을 신뢰할 수 있게 만든 작업을 스스로 되돌리는 셈입니다.
- 지시어를 빼는 것은 표시 정확도와 샌드박스를 맞바꾸는 일입니다.

노출은 한정적입니다. 호스트는 등록 시의 `hostId`로 식별하며 이 문자열로 식별하지 않으므로, 값이 낡으면 **라벨 하나가 틀릴 뿐** 그 이상은 없습니다. 이름을 바꾼 뒤에는 `systemctl restart rcc-node-agent`로 즉시 최신화됩니다. 이 판단은 `backend/dupa-control/agent-sandbox.test.js`가 고정하고 있어, 지시어를 빼면 테스트가 실패합니다.

### 15.8 이 단위에 남은 것

- **인증 후 UI walkthrough는 여전히 막혀 있습니다.** 운영자 자격증명이 없고, 계정 생성·비밀번호 초기화·service-role 가장은 승인 범위 밖입니다. 15.1과 15.3의 수정은 서버 측 투영과 DOM 계약으로 검증했으며, 로그인한 브라우저에서 눈으로 본 것이 아닙니다.
- **운영 배포는 하지 않았습니다.** CC2의 에이전트는 여전히 이전 바이너리이므로, `readOnly=true`는 재배포 전까지 화면에 그대로 남습니다.
- **subShell 번들은 저장소에서만 바뀌었습니다.** `entry.js`와 그 다이제스트 핀(`ui-shell.manifest.json`의 `entrySha256`, `package.descriptor.json`의 `manifest.sha256`)은 갱신했지만, manifest에 대한 분리 서명은 **승인된 이미지 빌드·배포 경계에서** 서명 키로 생성됩니다. 이번 작업에서는 서명 키를 열지 않았고, 신뢰 체인 검증은 테스트가 임시로 만든 키쌍으로만 수행했습니다.

## 16. 배포 후 감사 — 기능 단위 2(터미널 없는 패키지·커널 정비)

단위 2의 범위는 **관리자가 RCC 화면에서 Linux 패키지와 커널 업데이트를 관리할 수 있는가**입니다. 백엔드·스키마·에이전트는 Stage 3에서 이미 완성되어 있었습니다 — 작업 카탈로그, 상태 기계, 2인 승인 트리거, 정비 창, 허용 목록, 시뮬레이션, lease, 수령증이 전부 자리에 있었고 **이 단위에서 스키마도 Go 코드도 바꾸지 않았습니다.**

빠져 있던 것은 그 능력에 도달할 수 있는 화면이었습니다. 그리고 화면을 실제로 만들어 보니, 빠져 있던 것은 화면만이 아니었습니다.

### 16.1 Updates 화면은 볼 수만 있고 할 수는 없었습니다

`renderUpdates()`는 숫자를 그리는 읽기 전용 화면이었고, 패키지·커널 작업 요청 컨트롤은 **Operations 탭에만** 있었습니다. Operations는 호스트의 모든 작업이 섞여 있는 일반 큐이므로, "어떤 패키지가 몇 개 밀려 있는가"를 본 화면과 "그중 무엇을 올릴 것인가"를 정하는 화면이 서로 달랐습니다. 운영자는 대기 목록을 한쪽에서 읽고 다른 쪽에서 기억으로 요청해야 했습니다.

Cockpit이 이 일을 한 화면에서 하는 이유가 정확히 이것입니다. 이제 상태·갱신·패키지 업데이트·커널 업데이트·요청 이력·정책이 **Updates 한 화면**에 있습니다(5.1). Operations는 그대로 남아 있고, 호스트의 전체 작업을 보는 자리라는 역할도 그대로입니다.

### 16.2 승인은 패키지 이름에만 묶여 있었고 버전에는 묶여 있지 않았습니다

이 단위에서 가장 무거운 결함입니다. 기존 요청 코드는 `{ name, version: '' }`을 보냈습니다. 화면은 `curl 8.5.0-1 → 8.5.0-2`를 보여 주지만, 승인 다이제스트에 들어가는 것은 **이름뿐**이었습니다.

결과를 정확히 적으면 이렇습니다. 두 번째 관리자가 승인한 문장은 "curl을 올린다"였고, 실행 시점에 설치되는 것은 **그때 미러가 제공하는 무엇이든**이었습니다. 검토와 실행 사이에 저장소가 움직이면 아무도 그 차이를 보지 못합니다. 정확한 내용 다이제스트라는 장치 전체가 — 그 아래 계층은 모두 정상이었는데 — 화면이 내용을 비워 보냈기 때문에 이름 수준의 승인으로 무너져 있었습니다.

이제 요청은 **화면에 표시된 바로 그 후보 버전**을 싣습니다. 그리고 60초 배경 갱신에서 후보 버전이 움직이면 확인 체크가 해제되고 `curl 8.5.0-2 to 8.5.0-3`처럼 **무엇이 어떻게 움직였는지**가 화면에 남습니다. 재확인하면 새 버전으로 요청됩니다. 옛 버전이 몰래 제출되는 경로도, 바뀐 사실을 모른 채 제출하는 경로도 없습니다.

### 16.3 보안 전용 요청을 할 방법이 없었습니다

`securityOnly`는 코드에 `false`로 박혀 있었고, 보안 업데이트만 고르는 방법도 없었습니다. 보안 업데이트만 올리려는 관리자는 목록을 눈으로 훑어 하나씩 체크하는 수밖에 없었고, 그렇게 해도 요청은 스스로를 보안 전용이라고 말하지 않았습니다.

`Select security updates`와 `Select all eligible`을 추가했고, `securityOnly`는 **관리자가 체크했고 그리고 선택된 집합이 실제로 전부 보안 업데이트일 때만** `true`가 됩니다. 둘 중 하나라도 아니면 `false`입니다. 화면이 사실이 아닌 주장을 감사 기록에 남기지 않게 하는 조건입니다.

### 16.4 60초마다 돌아오는 갱신이 선택을 조용히 지웠습니다

선택 집합은 렌더 함수 안의 지역 `Set`이었습니다. `render()`는 배경 갱신마다 다시 실행되므로, **12개를 검토해 고르는 도중 폴링이 한 번 돌면 선택이 사라졌습니다.** 화면은 아무 말도 하지 않았습니다.

선택은 이제 요소에 사는 `Map`이고, 조정은 렌더가 아니라 데이터 적재(`loadDetail`)에서 한 번만 일어납니다. 조정 규칙은 세 가지입니다 — 그대로면 유지, 후보 버전이 움직였으면 유지하되 확인 해제 + 표시, 목록에서 사라졌으면 제거 + 표시. 폴링은 검토 중인 작업을 지우지 않고, 대신 **검토가 더 이상 유효하지 않게 된 순간을 보이게** 만듭니다.

### 16.5 승인 컨트롤이 "읽는 사람이 누구인지 모를 때" 열려 있었습니다

자기 요청 자기 승인을 막는 화면 측 판정이 `operation.viewer.isRequester === true`였습니다. `viewer`가 없는 응답에서는 이 식이 거짓이 되어 **승인 컨트롤이 열렸습니다.** 즉 판정 근거가 없을 때 열리는 fail-open이었습니다.

데이터베이스 트리거(0028)와 API가 여전히 거부하므로 실제로 자기 승인이 성사되지는 않았습니다. 그러나 15.7에 적은 원칙이 여기서도 같습니다 — **상대가 거부해 주기 때문에만 성립하는 게이트는 게이트가 아닙니다.** 게다가 이 형태는 운영자에게 누를 수 있는 것처럼 보이는 버튼을 주고 서버에서 거절하는, 최악의 사용자 경험이기도 합니다.

이제 `viewer`를 확인할 수 없으면 **닫힙니다**, 그리고 왜 닫혔는지 적습니다. 요청 이력의 Approval 열도 "다른 관리자를 기다리는 중"과 "다른 관리자를 기다리는 중 — 요청한 사람이 당신"을 구분합니다.

### 16.6 2인 승인이 필요하다는 사실이 요청하는 순간에는 보이지 않았습니다

높은 위험 작업이라는 것도, 다른 관리자가 필요하다는 것도, 제출이 실행의 시작이 아니라는 것도 요청 화면에 없었습니다. 요청한 사람은 자기 요청이 왜 아무 일도 일으키지 않는지 이력 화면까지 가서야 알 수 있었습니다.

`package.update`와 `kernel.update` 두 카드 모두 요청 지점에 그 문장을 답니다. **"직접 화면에서"가 2인 승인을 약화한다는 뜻이 아니라는 것**이 이 단위의 전제였고, 화면은 그 요구를 감추는 대신 명시하는 쪽으로 만들었습니다.

같은 자리에서 마크다운 누출도 고쳤습니다. 커널 카드의 문장이 `**It never reboots the host.**`로 되어 있었는데, 이 화면은 `textContent`로만 그리므로 별표가 **화면에 그대로 찍혔습니다.** 강조하려고 넣은 표시가 문장을 덜 읽히게 만들고 있었습니다.

### 16.7 "아무것도 실행할 수 없다"는 Stage 1 시절 문장이 남아 있었습니다

작업이 불가능할 때 뜨는 안내가 Stage 1 문구를 그대로 들고 있어서, **백엔드가 보내 준 실제 이유를 버리고** 일반적인 "이 플랫폼은 실행하지 않습니다"를 표시했습니다. 정책이 없어서 막힌 것인지, 창이 닫혀서인지, 권한이 없어서인지, AAL2가 아니어서인지 구별되지 않았습니다. 이제 백엔드의 이유를 그대로 렌더링합니다. 요구사항 6의 "각각 정확한 이유와 함께 닫힌다"가 성립하려면 화면이 이유를 버리지 않아야 합니다.

### 16.8 거절이 요청한 화면에서는 보이지 않았습니다

제출 오류 배너는 Operations 탭에만 있었습니다. Updates 화면에서 요청하고 서버가 거절하면, 운영자에게는 **아무 일도 일어나지 않은 것처럼** 보였습니다. 같은 요청을 다시 누르게 만드는 형태입니다. Updates 화면에도 배너를 두었고, 거절되면 검토한 선택은 지우지 않고 유지합니다 — 고칠 것은 사유나 시점이지, 다시 고르라고 할 이유가 없습니다.

### 16.9 아무도 도달할 수 없는 게이트가 하나 있었습니다

`_updateFreshnessProblem`에 `package.refresh`면 통과시키는 분기가 있었습니다. 취지는 옳습니다 — 오래된 인덱스를 고치는 작업 자체를 "인덱스가 오래되었다"는 이유로 막으면 그 호스트는 빠져나올 방법이 없습니다. 그런데 호출자는 `package.update`와 `kernel.update` 둘뿐이었습니다. **그 분기는 한 번도 실행된 적이 없는 죽은 코드**였고, 읽는 사람에게는 "이 규칙이 여기서 강제되고 있다"는 잘못된 확신을 주고 있었습니다.

돌연변이 스윕이 이것을 찾았습니다. 그 분기를 부수는 돌연변이가 죽지 않았기 때문입니다. 분기와 매개변수를 지우고, 규칙이 실제로 강제되는 자리(`renderRefreshCard`가 신선도를 아예 묻지 않는다는 사실)를 **반대 방향 돌연변이**로 고정했습니다 — 갱신 카드에 신선도 게이트를 *추가하는* 돌연변이가 테스트를 실패시킵니다. 누락으로 성립하는 보장은 그것을 되돌리는 방향으로만 증명할 수 있습니다.

### 16.10 화면에 새로 들어오지 않은 것

요구사항 7이 금지한 것들이 실제로 들어오지 않았음을 테스트가 고정합니다.

- **임의 명령·셸 입력 없음.** Updates 화면의 입력 요소는 체크박스와 사유 텍스트 필드뿐입니다. 텍스트 입력은 세 개의 사유 필드가 전부이고 각각 `maxlength=500`이며, `textarea`도 `select`도 없습니다. 테스트가 화면의 모든 `input`을 열거해 이 사실을 검사합니다.
- **암묵적 전체 업데이트 없음.** 요청은 언제나 열거된 집합이며 최대 32개입니다. 대기 40건에서 `Select all eligible`을 누르면 32개만 선택하고 **"40건 중 앞의 32건만 선택되었다"고 적습니다.** 조용히 자르지 않습니다(15.2와 같은 규율).
- **제거·다운그레이드 없음.** 화면은 업그레이드 대상만 만들 수 있고, 제거를 요청하는 표현 자체가 없습니다.
- **무한한 패키지 이름 없음.** 이름은 `^[a-z0-9][a-z0-9+.-]{1,127}$`, 버전 핀도 닫힌 문법입니다. 통과하지 못하는 항목은 선택 자체가 되지 않고, 어떤 경로로도 마크업이 되지 않습니다.
- **재부팅 부작용 없음.** 커널 요청의 파라미터는 `{ manager, targetRelease }`뿐입니다. `rebootAfter`를 싣는 돌연변이가 테스트를 실패시킵니다.
- **CC2의 권한이나 허용 목록은 이 단위에서 켜지 않았습니다.**

### 16.11 이것을 어떻게 증명했는가

- **DOM 계약 테스트 87건**(`backend/dupa-control/rcc-subshell-dom.test.js`). 손으로 만든 fixture가 아니라 **실제 `toHostDetail` 투영**을 통과한 데이터를 씁니다 — 15.3에서 배운 것과 같습니다. 손으로 만든 fixture는 화면과 언제나 일치하므로 아무것도 잡지 못합니다.
- **화면과 백엔드가 같은 것을 말하는지** 직접 검사합니다. 화면이 만든 요청 본문을 백엔드의 실제 `normalizeParameters()`에 그대로 넣고 **바뀌지 않고 통과하는지** 확인합니다. 정렬 순서가 어긋나는 돌연변이가 이 테스트를 죽입니다.
- **적대적 시나리오**: 검토 중 후보 버전 이동, 목록에서 사라진 패키지, 오래된 인덱스, 나이를 보고하지 않은 인덱스, 보고가 끊긴 호스트, 빈/부분 허용 목록, 자기 승인 거절, 읽기 전용·권한 거절, 같은 틱에 두 번 누르기, 진행 중 작업과의 충돌, 커널 이미지를 패키지 업데이트로 넣기, 적대적 패키지 이름, 확인 없이 제출.
- **돌연변이 증명 42건, 전부 죽었습니다**(`node scripts/stage4-mutation-sweep.mjs --only 'ui: '`). 새로 만든 모든 게이트에 대해 그것을 되돌리는 돌연변이를 실제로 적용하고, 관련 테스트가 실패하는 것을 확인한 뒤 복원했습니다. 앵커는 총 140개이며 모두 유일하게 해석됩니다.

### 16.12 이 단위에 남은 것

- **인증 후 브라우저 walkthrough는 여전히 막혀 있습니다**(15.8과 같음). 화면 동작은 DOM 계약으로 검증했고, 로그인한 브라우저에서 눈으로 본 것이 아닙니다.
- **CC2에 아무것도 배포하지 않았고, 권한도 허용 목록도 켜지 않았습니다.** 요구사항 10에 따라 이 단위의 산출물은 저장소에만 있습니다. CC2에서 이 화면이 실제로 작업을 요청하려면 `console.hosts.packages` 부여, `host_policy.allowed_operations`, 정비 창, 호스트별 `packageAllowlist`가 **별도의 승인된 변경**으로 설정되어야 합니다.
- **subShell 번들의 분리 서명은 만들지 않았습니다.** `entry.js`와 결정적 SHA-256 핀은 갱신했지만, 서명 키는 열지 않았습니다(15.8과 같은 경계).
- **이 단위는 백엔드·스키마·에이전트를 바꾸지 않았습니다.** 따라서 Stage 3의 실행 경로에 대한 판단(12.6, 12.9)은 그대로 유효합니다.

## 17. 운영 기능 단위 3 — SSH 보호 운영

이 단위의 완료 기준은 상태 필드 몇 개를 표시하는 것이 아닙니다. **준비 상태 확인 → 통제된 보호 기준선 활성화 → 탐지 사건 확인 → 단일 주소 차단·해제 → 승인·실행·수령증 감사**가 RCC 안에서 하나의 닫힌 운영 흐름으로 이어져야 합니다.

범위는 고정 Fail2ban `sshd` 기준선입니다. 임의 설정 편집, 임의 jail 생성, 방화벽 규칙 직접 편집, 차단 기간 변경, 대역 차단, 임의 공격 판정 규칙, 임의 서비스 제어, 임의 명령 실행은 여전히 범위가 아닙니다.

### 17.1 메뉴와 화면

메뉴 경로는 다음과 같습니다.

`운영 → Linux 호스트 → 호스트 선택 → 보안 → SSH 보호`

동등한 기능 버튼 11개를 한 줄에 늘어놓던 구조는 요약·관측·보안·유지보수·구성·이력의 여섯 도메인으로 재구성했습니다. SSH 보호 화면은 5.2의 준비 점검·활성화·상태·정책·최근 사건·차단 목록·보호 주소·차단/해제·작업 이력을 한 구획에 표시합니다.

상태 수집이 지원되지 않거나 오래되었거나, 제어센터가 읽기 전용이거나, 권한·AAL2·에이전트 권위가 부족하거나, 정책·정비 창이 없거나, 같은 호스트에서 충돌하는 작업이 진행 중이면 버튼을 숨기지 않고 비활성화한 뒤 **게이트별 이유를 표시**합니다. Fail2ban이 설치되지 않았다는 한 줄 경고로 끝내지 않습니다.

### 17.2 작업 계약

| 작업 | 위험 | 2인 승인 | 정비 정책·창 | 필요 권한 | 최대 lease |
|---|---|---|---|---|---|
| `ssh.protection.enable` | high | **필요** | **필요** | `console.hosts.ssh-ban` | 1800초 |
| `ssh.ban` | high | **필요** | 불필요 | `console.hosts.ssh-ban` | 120초 |
| `ssh.unban` | high | **필요** | 불필요 | `console.hosts.ssh-ban` | 120초 |

활성화·재조정 요청에서 브라우저가 보내는 운영 값은 없습니다. 빈 parameters와 사유만 제출하며, 백엔드는 검토 시점의 스냅샷과 정책에서 provider·jail·프로필·정확한 패키지 버전·설치/활성 예상 상태·기존 프로필 다이제스트·정렬된 보호 주소를 파생합니다.

```json
{
  "sshProtection": {
    "provider": "fail2ban",
    "jail": "sshd",
    "profile": "rcc-ssh-baseline-v1",
    "packageVersion": "1.0.2-3",
    "expectedInstalled": false,
    "expectedActive": false,
    "expectedProfileDigest": "",
    "protectedAddresses": ["198.51.100.10"]
  }
}
```

차단·해제에서 브라우저가 보내는 것은 `{ address }`뿐이며, 계획은 다음 닫힌 구조만 가집니다.

```json
{
  "sshBan": {
    "jail": "sshd",
    "address": "203.0.113.24",
    "expectedBanned": false
  }
}
```

`expectedBanned`는 브라우저 입력이 아니라 서버가 검토 시점의 스냅샷에서 파생합니다. `ssh.ban`이면 false, `ssh.unban`이면 true여야 하며, 이 관계가 깨진 계획은 에이전트의 plan 검증과 executor에서 각각 거부됩니다.

### 17.3 고정 보호 기준선

`rcc-ssh-baseline-v1`은 다음 값으로 고정됩니다.

```ini
[sshd]
enabled = true
backend = systemd
bantime = 3600
findtime = 600
maxretry = 5
ignoreip = 127.0.0.1/8 ::1 <검토된 관리 접속 IP 주소들>
```

이 내용을 브라우저나 작업 parameters가 편집할 수 없습니다. 수집기는 이 정확한 바이트의 SHA-256과 현재 파일의 SHA-256을 함께 사용해 `current`, `rcc-ssh-baseline-v1-drift`, `external`을 구분합니다. 현재 프로필이 이미 정확하면 활성화 버튼 대신 정렬 상태를 표시하고, RCC 소유 드리프트면 재조정 요청을 열며, 외부 내용이면 소유권을 빼앗지 않고 사람에게 이관합니다. 에이전트는 다음 순서만 수행합니다.

1. 로컬 `operationsEnabled`, `collectSSHBan`, `sshBanEnabled`, 보호 주소를 다시 확인하고 승인 계획의 보호 주소와 정확히 비교합니다.
2. 설치 버전, `sshd` 활성 상태, 기존 프로필 다이제스트가 검토 시점의 값과 같은지 다시 확인합니다. 고정 경로의 외부 내용·심볼릭 링크·비정규 파일은 이 단계에서 거부합니다.
3. Fail2ban이 없으면 에이전트가 보고했던 정확한 후보 버전으로 `apt-get --simulate install fail2ban=<version>`을 비대화형 고정 환경에서 실행합니다. 제거·핵심 패키지 변경·Fail2ban이 빠진 트랜잭션·32개 초과 변경을 거부한 뒤 같은 핀으로 설치하고 설치 버전을 다시 증명합니다.
4. `/etc/fail2ban/jail.d/rcc-sshd.local`에만 고정 설정을 원자적으로 기록하고 파일과 디렉터리를 동기화합니다. 외부 내용은 덮어쓰지 않습니다.
5. `fail2ban-client -t`로 전체 설정을 검증합니다.
6. 서비스를 enable하고, 이미 active면 `fail2ban-client reload`, 아니면 `systemctl start fail2ban.service`를 실행합니다.
7. `fail2ban-client status sshd`로 jail 활성 상태를 다시 증명합니다.
8. 프로필 변경 여부·다이제스트·보호 주소 수·고정 패키지 버전·검증 상태를 수령증 증거에 기록합니다.

설정 기록 이후 검증·재적재·활성화·사후 증명이 실패하면 원 작업의 취소 여부와 무관한 새 2분 제한 문맥에서 **정확한 이전 프로필과 이전 서비스 active/enabled 상태**를 복원합니다. 작업 전부터 Fail2ban이 active였다면 다른 jail을 지키기 위해 서비스를 멈추지 않고 이전 프로필을 복원한 뒤 reload합니다. 배포 패키지를 자동 제거하면 의존성 상태를 더 크게 바꿀 수 있으므로 설치된 패키지는 파괴적으로 제거하지 않고 실패·롤백 증거를 남깁니다.

### 17.4 노드 에이전트 설정과 샌드박스

```json
{
  "operationsEnabled": true,
  "collectSSHBan": true,
  "sshBanEnabled": false,
  "sshBanProtectedAddresses": [
    "198.51.100.10"
  ]
}
```

- `collectSSHBan`은 기본 true입니다. 고정 상태·패키지 버전·후보 버전과 제한된 최근 사건만 읽고 아무것도 바꾸지 않습니다.
- `sshBanEnabled`는 기본 false입니다. true로 바꾸려면 `operationsEnabled`와 `collectSSHBan`이 모두 true이고, `sshBanProtectedAddresses`에 정규화된 정확한 IP 주소가 하나 이상 있어야 합니다. 어느 조건이든 없으면 에이전트가 기동을 거부합니다.
- 보호 주소는 최대 64개이고 CIDR·hostname은 받지 않습니다. 중복은 정규화 후 제거됩니다.
- `ssh.ban`·`ssh.unban`만 사용하는 이미 설치된 호스트는 기존 Fail2ban AF_UNIX 소켓만 사용하므로 추가 샌드박스 확장이 필요 없습니다.
- `ssh.protection.enable`은 패키지·설정·서비스를 변경하므로 `package-maintenance.conf` drop-in을 명시적으로 설치해야 합니다. 이 drop-in은 `sshBanEnabled` 자체를 켜지 않으며, 반대로 `sshBanEnabled`도 파일시스템 권한을 넓히지 않습니다. 둘 중 하나가 빠지면 작업은 실패합니다.
- 차단·해제 실행은 `fail2ban-client status sshd`로 사전 상태를 다시 확인하고, 고정 banip/unbanip 명령 중 하나만 실행한 다음 상태를 다시 확인합니다. 셸은 사용하지 않습니다.
- Fail2ban의 상태 출력에 `sshd` jail 식별자나 `Banned IP list`가 없으면 빈 목록으로 추측하지 않고 거부합니다. 성공 exit code 뒤에도 목표 상태가 증명되지 않으면 작업은 실패입니다.

### 17.5 배포와 활성화 경계

기능 코드를 배포하는 것과 실제 호스트의 보호 설정을 바꾸는 것은 별개입니다.

1. 마이그레이션 `0032_host_ssh_ban.sql`과 `0033_host_ssh_protection.sql`, 백엔드, web, subShell, 노드 에이전트를 배포합니다.
2. `collectSSHBan=true`, `sshBanEnabled=false`로 준비 점검과 읽기 전용 상태를 먼저 확인합니다.
3. 운영자가 실제 관리 접속에 사용하는 모든 IP 주소를 직접 확인해 `sshBanProtectedAddresses`에 선언합니다. 추측한 주소를 넣지 않습니다.
4. 패키지·설정 변경용 `package-maintenance.conf`를 별도 승인으로 설치합니다.
5. `sshBanEnabled=true`로 바꾸고 에이전트를 재시작한 뒤, `host_policy.allowed_operations`에 `ssh.protection.enable`과 정비 창을 별도 승인으로 설정합니다.
6. 서로 다른 두 관리자의 AAL2 세션으로 화면에서 보호 활성화를 요청·승인하고, 고정 기준선·jail·수령증을 확인합니다.
7. 비관리용 시험 IP 하나를 차단·확인·해제하여 전체 감사·수령증 경로를 검증합니다.

2단계까지는 기존 Fail2ban 규칙과 차단 목록을 변경하지 않습니다. 3~7단계는 실제 SSH 접근을 끊거나 호스트 패키지·설정을 바꿀 수 있는 운영 변경이므로 **확인된 보호 주소와 별도의 명시적 승인 없이 수행하지 않습니다.**

### 17.6 현재 상태

- 메뉴 도메인 재구성과 SSH 보호 운영 화면: 저장소 구현 완료
- 읽기 전용 설치·후보 버전·프로필·최근 사건 수집: 저장소 구현 완료
- 서버 측 활성화 parameters 파생·capability·정비 정책·dispatch 재검증: 저장소 구현 완료
- 노드의 버전 고정 비대화형 설치·원자적 설정·RCC 소유 드리프트 재조정·외부 설정 거부·설정 검증·서비스 활성화/재적재·사후 증명·정확한 사전 상태 롤백: 저장소 구현 완료
- 차단·해제의 실행 전 재검증·실행 후 상태 증명: 저장소 구현 완료
- 데이터베이스 카탈로그와 전용 고위험 권한: migrations 0032–0033에 구현
- CC2 코드 배포: 이 장의 검증·배포 기록에서 별도로 갱신
- CC2 `sshBanEnabled`: 명시적 활성화 전까지 false 유지
- 실제 보호 활성화·IP 차단·해제: 보호 관리 주소 확인과 명시적 승인 전에는 미실시

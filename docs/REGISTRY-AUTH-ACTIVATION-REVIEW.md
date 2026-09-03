# Registry credential broker 활성화 검토 요청

2026-09-03 · 상태: **사용자 승인 및 소스 반영 완료. 아래 최초 요청 내용은 승인 범위의 기록이다.**

현재 App 등록·Setup edge.21 발행 및 검증 상태는 [구현 결과](REGISTRY-AUTH-IMPLEMENTATION-REPORT.md)를 따른다. 추가 권한 승인 대기 상태가 아니다.

요청된 OAuth 및 설치 이후 권한 유지 기능의 로컬 코드·계약·테스트를 작성했다. 자동 보안 검토는 배포 변경을 거부했다. 이유는 현재 C_API의 Kubernetes API 접근 금지 경계를 바꾸고 여러 namespace의 Secret에 접근 권한을 추가하기 때문이다. 이번 파일은 거부된 변경을 우회하는 실행 manifest가 아니다. 현재 배포 manifest와 이를 보호하는 검증 규칙은 유지했다.

## 검토할 정확한 범위

| 항목 | 현재 | 활성화 제안 |
|---|---|---|
| 소유 ServiceAccount | opensphere-console/opensphere-console-api | 동일 계정 |
| Kubernetes API token | automount false | 해당 Pod만 projected/rotating token으로 API 인증 |
| owner state | 없음 | opensphere-console/opensphere-registry-auth, get/update |
| 이미지 pull state | Setup이 초기 생성 | 아래 5개 namespace의 opensphere-ghcr-pull, get/update |
| 이름/범위 제한 | API 권한 없음 | 각 namespace의 Role + resourceNames 명시, ClusterRole 없음 |
| 금지 권한 | 모든 Kubernetes API 접근 | secret list/watch/create/delete, 다른 Secret, wildcard namespace, workload/role 수정 금지 |
| 외부 통신 | 현재 API egress 목록 | GitHub device/token/user 및 GHCR token/manifest HTTPS, Kubernetes HTTPS |
| 활성화 신호 | 없음 | CONSOLE_REGISTRY_AUTH_CONTRACT=registry-auth/v1 |
| OAuth 앱 | 미등록/ID 미확인 | OpenSphere 소유 Client ID, Device Flow 활성화, client_secret 불필요 |

정확한 pull Secret 대상:

1. opensphere-console-data/opensphere-ghcr-pull
2. opensphere-console-change/opensphere-ghcr-pull
3. opensphere-monitoring/opensphere-ghcr-pull
4. opensphere-console/opensphere-ghcr-pull
5. opensphere-system/opensphere-ghcr-pull

총 여섯 Secret 인스턴스다. 신규 namespace, process, repository, database table, queue, 외부 broker를 추가하지 않는다. Setup의 Windows 실행 파일에 사용자 토큰을 남기지 않는다.

## 위험과 보호

C_API가 침해되면 이 여섯 Secret의 읽기·교체 권한이 노출된다. refresh token은 owner Secret 한 곳에만 두지만 해당 프로세스가 이를 읽는 권한 자체는 필요하다. user repo/write/admin 권한은 넘기지 않으며 scope 검사와 고정 GHCR namespace로 제한한다. Secret base64는 암호화가 아니므로 클러스터의 저장·backup 보호도 필요하다.

기본 Kubernetes NetworkPolicy는 도메인별 allowlist를 지원하지 않는다. HTTPS 443 egress를 열면 네트워크 계층에서는 GitHub 이외의 443 목적지도 열릴 수 있다. 애플리케이션은 고정된 HTTPS origin과 redirect 금지로 제한하지만, 침해된 프로세스까지 막는 네트워크 도메인 제한은 별도 egress 통제가 필요하다. Kubernetes API 포트는 실제 클러스터의 DNAT 경로를 읽기 전용 확인한 뒤 필요한 주소/포트로 정해야 한다.

자동 갱신은 8시간짜리 토큰을 무한 보증하는 것이 아니다. 사용자/조직이 권한을 철회하거나 refresh 결과가 불명확하면 재인증이 필요하다. 오래된 작업자가 새 generation을 덮어쓰지 않도록 owner 및 pull Secret resourceVersion을 검사한다.

## 승인 기록

2026-09-03 사용자가 “승인한다”라고 답하여 위 여섯 Secret get/update 예외를 승인했다. 아래 순서 중 1~2는 로컬 설계·배포 manifest·gate 및 회귀 검증까지 완료했다. 이후 전용 OAuth 앱 등록, 로그인·refresh 실시험, 격리 PostgreSQL 검증, 별도 승인한 main push·Console GHCR edge 발행 및 공개 Setup edge.21 OAuth doctor가 완료됐다. 실제 Kubernetes 적용·운영 갱신·cold-pull 검증은 미실행이다. [최종 실행 증거](CONSOLE-INSTALL-RELEASE-202609031353.md)를 따른다.

## 승인 이후 순서

1. C_API의 좁은 credential broker 권한 예외를 설계 trust boundary와 배포 gate에 함께 명시한다.
2. 실제 manifest·RBAC·네트워크 설정을 위 범위로 구현하고 별도 검증한다. 배포 원본에는 반영했으며 실제 클러스터에는 적용하지 않았다.
3. OpenSphere 전용 OAuth App 등록 정보를 연결한다. 공개 Client ID만 필요하고 client secret을 EXE 또는 Console에 내장하지 않는다.
4. 격리 DB migration, 실제 GHCR pull/refresh, Kubernetes handoff/cold-pull/재시작/만료/철회 테스트를 실행한다.
5. 모든 gate 통과 후 Console 및 Setup을 정상 버전·채널·GHCR 정책으로 빌드·발행한다.

이 검토 요청의 승인은 위의 좁은 권한 변경 범위에 대한 것이다. 모든 Kubernetes Secret 접근, 관리자 PAT 저장, 공개 이미지 전환, 기존 릴리스 삭제, 현재 사용자의 GitHub 권한 전체 이관을 승인하는 것이 아니다.
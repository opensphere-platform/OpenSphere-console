# Console 클린 재설치를 위한 기존 설치 데이터 삭제

2026-09-03 첫 삭제 기록(15:37 KST경). 이후 사용자가 다시 설치했고, 두 번째 삭제는 아래 추가 기록을 따른다. 사용자의 “기존 설치 하던 데이터 모두 지우고 보고” 지시에 따른 작업이다.

## 수행

검증된 공개 Setup `setup-v0.5.0-edge.22` 실행 파일로 아래 명령을 실행했고 종료 코드는 0이었다.

```powershell
.\opensphere-setup.exe --channel edge uninstall --purge-data --confirm DELETE-OPENSPHERE --context docker-desktop
```

삭제 대상은 이 실패한 Console 설치의 소유 범위로 한정했다.

- 네임스페이스 5개: `opensphere-console-data`, `opensphere-console-change`, `opensphere-monitoring`, `opensphere-console`, `opensphere-system`.
- PVC/PV 4개: Console Supabase PostgreSQL, Supabase Storage, Gitea repository, Gitea PostgreSQL.
- 이 범위의 workload, Service, NetworkPolicy, RBAC, ConfigMap 및 Secret. 설치 lock, DB 사용자/마이그레이션/내용, Gitea 저장소/서명키/토큰, TLS, Registry OAuth owner/pull 정보 및 API/Controller 전용 credential 포함.
- 소유 대상으로 선언된 CRD 2개, cluster RBAC 4개, admission policy/binding 6개의 잔여 없음 확인. 이 클러스터에서는 설치가 해당 단계 전에 실패해 원래부터 이 cluster-scoped 리소스가 생성되지 않았다. CLI의 “2 CRDs” 출력은 관리 목록 수이며 실제 존재했던 두 CRD를 삭제했다는 뜻은 아니다.

## 확인한 결과

- 대상 namespace 0개, 대상 PV 0개, 관리 대상 cluster-scoped 리소스 0개.
- local-path provisioner 로그에서 네 개 volume 경로의 `has been deleted` 완료 기록 확인. PVC/PV 객체 제거뿐 아니라 저장 경로 정리 완료도 확인했다. 암호학적 저장장치 완전 삭제를 수행한 것은 아니다.
- 비대상 namespace 9개는 기존 UID 동일. Developer·Developer standalone·WWW 및 Kubernetes 기반 서비스 포함.
- 비대상 PV 8개는 기존 UID/claim 동일, 전부 Bound.
- 실행 중인 Console 설치 프로세스와 Console port-forward 없음. 관찰된 Developer port-forward는 종료하지 않았다.
- 새 Console 설치는 실행하지 않았다.

## 유지한 항목

프로젝트 소스·설계 문서·실행 로그, 비밀 원문을 포함하지 않는 검증 기록, Setup 실행 파일과 검증된 다운로드 runtime cache는 유지했다. 이 binary cache는 설치 DB나 설치 lock이 아니다. 이미지 cache도 제거하지 않았다.

Kubernetes context/노드, ingress, StorageClass, 다른 서비스, GitHub 저장소/GHCR 릴리스, 외부 OAuth 앱 승인 및 게시자용 로컬 credential은 변경하지 않았다. 공유 자원이나 외부 credential을 “Console 설치 데이터”에 포함해 삭제하지 않았다.

## 다음 설치 전 유의점

이전 보존형 upgrade 요청은 사용자 지시로 종료됐으며 이제 managed installation lock이 없다. 다음 설치는 수정된 릴리스를 사용한 신규 bootstrap이어야 한다.

**데이터 삭제는 설치 프로그램 결함을 수정하지 않는다.** 기존 공개 버전에는 fresh REST schema 설정과 installer에 전달되는 API egress template 오류가 남아 있고, 기존 키 재사용 검증 오류도 미반영이다. [추가 결함 변경 명세](CONSOLE-INSTALL-RECOVERY-PATCH-REVIEW-20260903.md)의 수정·검증·발행을 마친 뒤 클린 설치해야 한다. 이번 삭제 완료를 현 배포본의 설치 가능성 검증으로 표시하지 않는다.

## 근거

비밀 원문 없이 다음 로컬 파일에 남겼다.

- `.release/registry-auth-verification/console-clean-purge-before.json`: 삭제 대상과 비대상 UID/볼륨 기준선.
- `.release/registry-auth-verification/console-clean-purge-edge22.log`: 실제 공개 CLI 삭제 및 성공 종료.
- `.release/registry-auth-verification/console-clean-purge-after.json`: 잔여 0건, 외부 리소스 보존, 실제 볼륨 경로 삭제 기록.

기존 복구 실패 보고서는 과거 실행 기록으로 보존한다. 첫 삭제 당시의 관찰 기록이며 현재 상태는 아래 두 번째 삭제 기록을 따른다.

## 두 번째 실패 설치 삭제 — 16:10 KST경

사용자가 다시 시도한 edge.22 설치는 15:54 KST경 REST schema 오류로 Failed 상태가 됐다. 16:10 KST경 사용자 “업데이트, 기존 설치 삭제 후 보고” 지시에 따라 공개 실행 파일을 명시적으로 버전 고정하여 다시 삭제했다.

```powershell
.\opensphere-setup.exe --version 0.5.0-edge.22 uninstall --purge-data --confirm DELETE-OPENSPHERE --context docker-desktop
```

- 실행 파일 SHA-256: `481858ec0fe30e9a2e5baea022edde05a338238397b8e5ffb19e17fd5acaa79f`.
- 삭제한 실패 release: `sha256:a1eef0bbe196b02fe312d8cb861f5e8792ddf0e669db62534d5b2febf3626cce`.
- CLI 종료 0. 전용 namespace 5개, PV 4개 및 고정 관리 cluster resource 12종의 잔여 없음.
- local-path provisioner의 07:09:57~07:10:30 UTC 로그로 실제 볼륨 저장 경로 4개 삭제 확인.
- 비대상 namespace 9개는 기존 UID 동일. 비대상 PV 8개는 기존 UID/claim 동일, 전부 Bound.
- Console 포트 1114 listener 없음. 새로운 Console 설치는 실행하지 않았다.
- source, 문서, GitHub/GHCR, 다운로드 runtime cache, 외부 OAuth 앱/승인, Developer/WWW 및 공용 Kubernetes 기반 자원은 purge 대상에 포함하지 않았다.

비밀 원문 없는 근거:

- Console `.release/registry-auth-verification/console-edge23-purge-before.json`
- Setup `.release/registry-auth-verification/console-edge23-second-purge.log`
- Console `.release/registry-auth-verification/console-edge23-purge-after.json`

수정판의 코드·진행 표시·공개 버전은 [edge.23 업데이트 결과](CONSOLE-INSTALL-EDGE23-UPDATE-20260903.md)에서 관리한다. 실제 새 클린 설치의 성공 여부는 다음 사용자 실행에서 확인해야 한다.
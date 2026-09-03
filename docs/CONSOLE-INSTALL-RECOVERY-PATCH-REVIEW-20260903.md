# Console 설치 복구 추가 결함 — 적용 승인용 변경 명세

> **후속 업데이트:** 사용자의 명시적 업데이트 지시 후 세 수정과 단계별 진행 표시를 반영하고 회귀 검증을 통과했다. 현재 상태는 [업데이트 기록](CONSOLE-INSTALL-EDGE23-UPDATE-20260903.md)을 따른다. 아래는 당시 제안·차단 기록이다.

> **2026-09-03 후속 상태:** 사용자의 클린 재설치 지시에 따라 기존 Console 설치 namespace 5개와 영구 데이터 4개를 모두 삭제했다. 아래 실패/보존형 upgrade 내용은 과거 기록이며 현재는 설치 lock도 없다. 새 설치는 아직 실행하지 않았다. [삭제 완료 보고서](CONSOLE-INSTALL-CLEAN-PURGE-20260903.md).

2026-09-03 15:34 KST. 상태: **설치 미완료 / 추가 코드 수정은 auto-review 차단 / 본 문서는 적용되지 않은 변경 명세**.

이 문서는 실행 스크립트가 아니다. 아래 코드 예시는 검토 대상이며, 차단된 코드 수정을 우회해 적용하지 않는다. AGENTS.md도 변경하지 않는다.

## 실제 실행 결과

사용자가 승인한 OAuth로 공개 Setup `setup-v0.5.0-edge.22` upgrade를 실행했다. Console target은 `202609031456`, source `3d50f630a6273085e66b6a76fcd5cc8889f9ca40`, release digest `sha256:a1eef0bbe196b02fe312d8cb861f5e8792ddf0e669db62534d5b2febf3626cce`다.

1. Gitea bootstrap 및 서비스 역할 SQL은 통과했다. 최초 `current_role` 예약어 오류는 재발하지 않았다.
2. Console 28개 migration이 실제 Supabase PostgreSQL에 적용됐다. 최신 ID는 `opensphere-console/20260903/0028`이다.
3. 새 데이터 구조에 없는 legacy PostgREST 스키마 때문에 REST readiness가 실패했다.
4. REST 노출 스키마를 `storage`로 좁힌 뒤 Supabase Auth/PostgreSQL/REST/Storage가 모두 1/1 Ready가 됐다.
5. API와 Extension Controller의 최소권한 DB 역할 및 전용 Secret까지 생성됐다. 두 역할은 LOGIN 가능, SUPERUSER false다.
6. C_API manifest의 Kubernetes egress placeholder가 남아 API Deployment 적용 전에 중단됐다.
7. 자동 rollback도 기존 runtime Secret의 암호화 키 표현을 잘못 검사해 실패했다. 업그레이드 또는 rollback 성공을 주장하지 않는다.

Console namespace에는 아직 Pod가 없으며 localhost:1114 TCP 접속도 실패한다. Gitea는 rollback 과정에서 이전 이미지로 돌아갔고 Supabase는 target 이미지에 남았다. 기존 release lock과 실제 workload가 혼합된 실패 상태이므로 그대로 정상 운영할 수 없다.

## 수정 1 — fresh PostgREST 스키마 (로컬 및 클러스터 적용, 미발행)

파일: `backend/supabase/target/deploy.yaml`.

```diff
-            - { name: PGRST_DB_SCHEMAS, value: "console,audit,storage,osaa" }
+            # Fresh Console authority uses C_API direct SQL; only Storage is exposed here.
+            - { name: PGRST_DB_SCHEMAS, value: "storage" }
```

새 authority는 `console_identity/console_operation/console_audit/console_extension/console_migration`이다. 레거시 빈 스키마를 새로 만들거나 Console authority를 PostgREST에 추가 노출하지 않는다.

이 한 환경변수의 live 수정 뒤 REST와 Storage가 정상화됐다. 이는 현재 공개 릴리스 외 설정 변경이므로 새 immutable 릴리스에 포함하고 정식 upgrade로 선언을 일치시켜야 한다. 기존 edge 릴리스를 완전 수정판으로 안내하지 않는다.

추가한 `scripts/verify-console-data-manifest-postgres.mjs`는 실제 target manifest의 노출 스키마가 fresh migration 후 DB에 존재하는지, legacy 스키마가 없는지 확인한다. 격리 PostgreSQL에서 이 검사와 28개 migration/28개 SQL 검증, 초기 관리자 및 API/Controller HTTP E2E를 통과했다. 새 검증 및 CI 연결은 로컬 미커밋 상태다.

## 수정 2 — Kubernetes Secret 포장 해석 (미적용)

파일: `scripts/Install-ConsoleApiRuntime.ps1`, `Get-RuntimePasswordFromSecret`.

현재 production Secret을 값 노출 없이 확인했다. Kubernetes `data`를 한 번 해석하면 길이 44의 canonical base64 텍스트이며, 이를 해석한 실제 애플리케이션 키는 정상 32 bytes다. 기존 코드는 첫 번째 결과 44 bytes를 32 bytes와 비교해 정상 Secret을 거부한다.

현재 해당 부분:

```powershell
try { $sessionKeyBytes = [Convert]::FromBase64String([string]$secret.data.$sessionEncryptionSecretKey) }
catch { throw 'Runtime Secret session encryption key is not valid base64' }
try {
  if ($sessionKeyBytes.Length -ne 32 -or [Convert]::ToBase64String($sessionKeyBytes) -ne [string]$secret.data.$sessionEncryptionSecretKey) {
    throw 'Runtime Secret session encryption key must be canonical base64 for exactly 32 bytes'
  }
} finally {
  [Array]::Clear($sessionKeyBytes, 0, $sessionKeyBytes.Length)
}
```

제안하는 교체 부분:

```powershell
try {
  $sessionKeyText = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String([string]$secret.data.$sessionEncryptionSecretKey)
  )
  $sessionKeyBytes = [Convert]::FromBase64String($sessionKeyText)
} catch { throw 'Runtime Secret session encryption key is not valid base64' }
try {
  if ($sessionKeyBytes.Length -ne 32 -or
      [Convert]::ToBase64String($sessionKeyBytes) -cne $sessionKeyText) {
    throw 'Runtime Secret session encryption key must be canonical base64 for exactly 32 bytes'
  }
} finally {
  [Array]::Clear($sessionKeyBytes, 0, $sessionKeyBytes.Length)
  $sessionKeyText = $null
}
```

Secret 원문, key generation, AES key 크기, API 환경변수 형식, RBAC, 계정, 비밀번호는 변경하지 않는다. 정상 기존 Secret을 읽는 검증만 교정한다.

추가할 검증은 PowerShell AST에서 실제 production 함수를 읽어 실행한다. 무작위 fixture의 Kubernetes outer base64 + canonical application base64를 두 번 재사용해 같은 DB credential을 반환하는지 확인한다. 31/33-byte, 비정상 base64, 공백이 붙은 noncanonical 값, base64 텍스트가 아닌 raw bytes를 모두 거부해야 한다. 운영 Secret을 테스트 fixture로 저장하지 않는다. 이 새 PowerShell 회귀는 아직 작성·실행되지 않았다.

## 수정 3 — Setup이 installer에 전달하는 egress (미적용)

저장소/파일: `OpenSphere-Setup-CLI/src/bootstrap.mjs`, `materializeFoundationInstallers`.

현재 함수는 실제 API Service/EndpointSlice로 렌더링한 manifest를 검사하지만, target PowerShell installer에는 `artifact.raw`를 저장한다. 따라서 검사한 내용과 실행한 파일이 다르다. target PowerShell은 image/origin은 렌더링하지만 `__OPENSPHERE_REGISTRY_KUBERNETES_EGRESS__`는 렌더링하지 않아 실패한다.

제안: 기존 discovery를 한 번 수행한 결과를 `renderManifest`와 installer용 template에 함께 사용한다. installer template에서는 Kubernetes egress만 해석하고 image/origin placeholder는 기존 PowerShell 소유로 남긴다.

```javascript
const kubernetesApiEgress = raw.includes(KUBERNETES_EGRESS_SLOT)
  ? discoverRegistryKubernetesEgress(kubectl) : undefined;
const rendered = renderManifest(
  lock, spec, raw, storageClass, consoleUrl, authEnvironment,
  { kubernetesApiEgress }
);
const installerTemplate = renderRegistryKubernetesEgress(raw, kubernetesApiEgress);
return { spec, installerTemplate, rendered };
// 실제 파일 저장:
target ? artifact.installerTemplate : artifact.rendered
```

이미 존재하는 discovery/render 함수를 재사용한다. 현재 cluster의 정확한 대상은 Service `10.96.0.1/32:443`, ready endpoint `172.18.0.3/32:6443`이다. 이 주소를 source에 하드코딩하지 않는다. Endpoint 부재 시 fail closed하며 wildcard, 전체 포트, 새 RBAC를 허용하지 않는다. 기존 공급망 검증·migration digest 검증도 유지한다.

검증은 최종 installer 전달 파일에서 egress placeholder가 없어졌고 image/origin placeholder는 보존됐는지 확인한다. 이후 PowerShell의 정상 렌더링을 거치면 모든 placeholder가 제거되어야 한다. 잘못된 endpoint·중복 slot·넓어진 CIDR은 기존 negative gate로 거부한다.

## 보존 증거와 한계

2026-09-03T15:32:34+09:00 비교 결과:

- 기존 PVC 4/4: UID, 연결 PV 동일, Bound.
- 기존 Secret 13/13: UID 및 모든 기존 key의 SHA-256 동일. Gitea, DB, TLS, Registry owner 및 5개 pull Secret 포함.
- 신규 Console API/Extension Controller 전용 Secret은 이번 정상 provisioning 단계에서 생성됐으며 기존 13개 기준선에는 포함되지 않는다.
- 28개 migration 적용은 의도한 데이터 구조 변경이다. PVC 보존 검증은 전체 데이터 내용 비교나 backup/restore drill을 뜻하지 않는다.
- 다른 Developer/WWW workload는 이 작업에서 변경하지 않았다.
- Windows 설치, PATH 변경, 서비스 등록, CA 설치는 하지 않았다.

비밀 없는 로컬 근거:
- `.release/registry-auth-verification/console-repair-preservation-before.json`
- `.release/registry-auth-verification/console-repair-preservation-after-failed-upgrade.json`
- `.release/registry-auth-verification/console-data-manifest-postgres.log`
- `.release/registry-auth-verification/console-install-db-evidence.json`
- Setup `.release/registry-auth-verification/console-repair-upgrade-edge22.log`

## 중단 이유와 요청 범위

자동 승인 검토가 최상위 `O:\OpenSphere\AGENTS.md`의 documentation-only 범위를 근거로 credential parsing source 변경을 거부했다. 실제 키가 정상이고 값/권한을 변경하지 않는다는 읽기 전용 증거를 추가해 재검토했지만, 해당 source 변경에 대한 명시적 재승인이 필요하다는 이유로 다시 거부됐다. 이를 다른 도구·임시 실행·정책 파일 수정으로 우회하지 않았다.

필요한 승인은 이 문서의 세 수정과 회귀/CI 반영, Console/Setup main push, 새 immutable Console GHCR edge 및 Setup edge 발행, 기존 데이터/Secret을 보존하는 localhost Console CLI 복구 설치·검증이다. runtime credential 교체, 새 권한 확대, PVC 삭제는 범위 밖이다.

다음 작업은 수정·회귀 → 새 source pin/불변 버전 발행 → 정식 CLI 복구 → live 이미지/설치 lock/health/URL 및 기존 값 보존 확인 순서다. 임시 OAuth는 공급망 검증에만 사용한다. 인증 자체가 새로 필요하면 별도 device authorization을 요청한다.

Gitea webhook/post-merge owner 미구현은 별도 잔여 기능 제한으로 남는다. 이 설치 복구를 그 기능의 완성이나 GA 승인으로 표시하지 않는다.

# DUPA Controller GHCR HA 수정 릴리스 노트 — 2026-07-24

대상: `opensphere-console-dupa-controller` 0.1.1 및 OpenSphere `os` CLI 0.8.1.

## 수정 내용

- GHCR 토큰의 replica-local 메모리 캐시를 제거했다. 자격증명 바이트는 기존대로 Kubernetes Secret projected file에서만 읽으며 환경변수·API 응답·로그에 기록하지 않는다.
- `opensphere-ghcr-credential-state` ConfigMap에 credential generation·상태·실제 갱신 시각만 기록한다. 토큰이나 Docker auth 값은 이 ConfigMap에 포함하지 않는다.
- 각 serving DUPA replica는 자기 Secret mount와 state mount의 generation 일치 여부를 `opensphere-ghcr-credential-observations`에 관측한다.
- login은 모든 Ready serving replica가 새 generation을 관측할 때까지 성공을 반환하지 않는다. 전파 중 install/inspect는 `503 RegistryCredentialsPropagating`, `Retry-After: 1`로 닫힌다.
- logout은 먼저 shared state를 `revoking`으로 전환해 모든 replica의 기존 토큰 사용을 즉시 차단하고, Secret 삭제 및 모든 serving replica의 `revoked` 관측 수렴 후 성공을 반환한다.
- `registry status.updatedAt`은 Secret 생성 시각이 아니라 credential generation의 실제 변경 시각을 표시한다.
- `os extensions inspect|install`은 위 503 계약에 대해서만 최대 5회, `Retry-After`를 존중해 재시도한다. 인증 실패·권한 거부는 재시도하지 않는다.

## 배포 순서

1. Console edge 이미지 빌드/서명 후 Controller 0.1.1과 `os` CLI 0.8.1 artifact를 함께 배포한다.
2. Controller Deployment를 rolling update한다. 새 manifest는 `POD_NAME` downward API 및 lifecycle state ConfigMap mount를 포함한다.
3. 기존 GHCR Secret은 generation이 없으므로, 새 Controller가 Ready가 된 뒤 `os extensions registry login`을 한 번 수행해 generation을 발급한다.
4. edge에서 2 replica login → inspect → install 및 logout 직후 install 거부를 확인한 뒤 candidate/stable 승격을 진행한다.

## 회귀 검증

- A login 후 B 즉시 사용
- stale B가 401 대신 retryable 503 반환
- A logout 후 B의 이전 token 사용 차단
- rolling update 중 새 Ready replica 미관측 시 수렴 성공 금지
- CLI bounded retry 및 `Retry-After` 적용

# OpenSphere Console Native CLI 구현 완료 보고서

- 작성일: 2026-07-14
- 대상 채널: `edge`
- Console 소스: `47b9497194656f2cb0bcd8d8b1c1e93cd9afd59b`
- Setup 소스: `52deaf99f47f6142884b4203eecce18744ecb71b`
- 설치 릴리스 잠금: `sha256:5a1cf7008d30e785a1f7764993255b52f13c709609f2396464f4fcec1c1d756c`

## 1. 완료 판정

Console과 `os` CLI가 동일한 Kanidm 신원, Console RBAC, 관리 API, CBS PostgreSQL 감사 경로를 사용하는 Console-native 관리 표면으로 구현되었다. 사람의 반복 PAT 발급에 의존하던 방식은 장치 신뢰 방식으로 교체되었고, 자동화용 API 토큰은 사람의 로그인 자격과 분리되었다.

Setup CLI가 서명·다이제스트 고정 릴리스를 해석하고 9개 제품 이미지를 트랜잭션으로 업그레이드했으며, 롤아웃 검증과 실패 시 이전 릴리스 복원 계약을 갖는다. 현재 edge 릴리스는 Setup 외의 사후 수동 패치 없이 정상 동작한다.

## 2. 구현 범위

### 2.1 My Profile 자격 증명 관리

- OCI My Profile 수준의 탭 구조: 상세, 그룹·역할, 내 요청, 내 리소스, 자격 증명, 보안, 활동
- `자격 증명`에서 CLI 신뢰 장치 목록·마지막 사용·신뢰 해제 제공
- 자동화 API 토큰 생성·목록·폐기 제공
- 토큰 원문은 생성 직후 한 번만 표시하고 서버에는 해시와 상태만 저장
- 관리 변경은 8자 이상의 사유를 요구하고 영구 감사에 기록

### 2.2 사람용 `os` 로그인

- 최초 `os login`에서 P-256 장치 키를 만들고 브라우저 승인으로 공개키를 등록
- 개인키는 Windows DPAPI, macOS Keychain, Linux Secret Service에 저장하며 `~/.os/config.json`에는 비밀을 저장하지 않음
- 이후 명령마다 장치 서명 challenge를 검증해 15분 단기 세션을 발급
- Console 업그레이드 후에도 장치 신뢰와 로컬 키가 유지되어 새 PAT 없이 계속 제어 가능
- 서버에서 장치 신뢰를 해제하면 이후 세션 발급을 차단

### 2.3 자동화 토큰

- 비대화형 CI·자동화 전용 PAT를 사람용 장치 로그인과 분리
- 발급·폐기·만료·서버 상태 검증 제공
- 발급과 폐기 이벤트를 CBS PostgreSQL 감사 로그에 기록

### 2.4 Console-native 관리 명령

- 신원·정책: `whoami`, 장치, 토큰, TOTP 정책, 관리자, 역할
- Console 자산: Registry, Developer Catalog, APIs
- 플랫폼 기반: Backbone 상태·상세, Observability 상태·대상·질의
- 운영: 영구 감사 로그
- 확장: OCI digest 검사·설치·활성·비활성·제거·롤백, Binding 관리
- Catalog는 Console UI와 CLI 모두 정본 `/api/catalog` 경로를 사용하며 HTML SPA fallback을 JSON으로 오인하지 않음

### 2.5 영구 감사 정본

- 관리 쓰기는 CBS PostgreSQL `audit_log`에 동기 기록되어야 성공
- 감사 조회도 PostgreSQL을 직접 사용하며 메모리 복사본을 정본으로 사용하지 않음
- PostgreSQL을 사용할 수 없으면 빈 목록으로 위장하지 않고 `503`으로 실패
- `audit_log`는 append-only trigger로 UPDATE·DELETE를 차단

### 2.6 Setup 기반 업그레이드

- `edge`, `candidate`, `stable` 채널을 설치 시점에 서명된 릴리스 잠금으로 해석
- 9개 제품 이미지 모두 digest 고정
- 대상과 이전 릴리스 manifest를 사전 검증
- 대상 적용, rollout·서비스·이미지 잠금 검증, 실패 시 이전 릴리스 자동 복원
- Console 이미지에서 검증된 `os 0.4.0` 산출물을 설치하고 Windows 실행 파일 교체를 원자적으로 처리

## 3. 검증 결과

| 검증 | 결과 |
|---|---|
| Console 계약 테스트 | 81/81 통과 |
| Production UI build | 통과 |
| Edge 이미지 게시 | 9/9 성공, GitHub Actions run `29272954410` |
| Setup 업그레이드 | 이전 잠금에서 `sha256:5a1cf7...`로 성공 |
| Setup verify | 14 Pods / 12 Services / runtime images locked |
| Kubernetes runtime | 14/14 containers Ready, restart 0 |
| Backbone | PostgreSQL, RustFS, Gitea 모두 Ready |
| 장치 신뢰 지속성 | 업그레이드 후 기존 장치 1개로 `whoami` 성공 |
| 자동화 토큰 | 생성·폐기 성공, 활성 토큰 0건 |
| Catalog CLI | Catalog 11건, API 3건 JSON 조회 성공 |
| 영구 감사 | PostgreSQL 31건 이상, 장치·토큰 이벤트 조회 성공 |
| Browser E2E | Extensions, My Profile 자격 증명, 감사 로그 정상 렌더링 |
| Browser errors/console | 0건 |

## 4. 현재 기본 설치의 의도된 상태

- subShell과 plugin은 0건이다. 기본 Main Shell을 먼저 세운다는 제품 원칙에 따른 정상 상태다.
- Observability Service Stack은 아직 설치하지 않은 선택 확장 상태다. Console은 이를 설치된 것으로 위장하지 않는다.
- 개발 환경의 TOTP 정책은 합의대로 비활성이다. production 환경에서는 정책 강제가 적용된다.
- 로컬 환경은 자체 서명 인증서를 사용하므로 CLI E2E에서만 개발용 TLS 예외를 사용했다. 운영 환경은 신뢰 CA를 배포해야 한다.

## 5. 최종 결론

현재 edge Console은 Backbone을 필수 기반으로 기동하며, 웹 Console과 `os`가 하나의 신원·권한·API·감사 체계를 공유한다. 사람은 최초 장치 승인 이후 반복 토큰 발급 없이 CLI를 계속 사용할 수 있고, 자동화 토큰은 My Profile에서 별도로 통제할 수 있다. Setup이 릴리스 선택부터 digest 고정 설치·검증·롤백·CLI 설치까지 책임지므로 현재 배포는 사후 수동 수정이 아닌 재현 가능한 제품 설치 결과다.

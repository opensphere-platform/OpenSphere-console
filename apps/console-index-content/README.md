# Console main index 콘텐츠

Console의 로그인·권한·Registry 기반 메뉴와 Angular/Clarity 화면 구조는 `apps/console-web`이 소유한다. 이 폴더는 main index의 설명문과 모델 데이터, 이정표 다운로드 문서를 독립적으로 패키징한다. 별도 제품, repo, Service, Deployment, 상시 서버를 만들지 않는다.

## 수정 위치와 경계

| 파일 | 내용 |
|---|---|
| `content/architecture.copy.json` | Architecture 탭·공통 설명·접근성 문구 |
| `content/architecture.copy.json`의 `module-*`, `feature-*`, `naming-*` | 모듈·기능·내장 기능 정의, 7개 제품 설명, 10P·6L과의 관계. `landing-module-overview.ts`에서 기존 Web 이미지 안에 표시 |
| `content/architecture.models.json` | 10P·6L 설명 모델; 좌표 ID는 고정 |
| `content/foundations.copy.json`, `foundations.models.json` | Service Stacks·DUPA·Control Pillars·OSCE·AI Lifecycle |
| `content/registry-catalog.copy.json` | Registry & Catalog 설명 |
| `content/pfss-delivery.copy.json` | PFSS Delivery 설명 |
| `content/osaa-dialogue-state.copy.json`, `dialogue-state.models.json` | OSDST 설명·필드·참고 자료 |
| `content/installation-milestones.copy.json` | 설치 이정표 화면 문구 |
| `documents/installation-milestones.json`, `.md` | 다운로드용 이정표 근거 스냅샷 |

기존 key는 렌더러 계약이므로 이름을 바꾸지 않고 value를 편집한다. `*.models.json`의 설명·기존 구조의 목록은 수정할 수 있다. 의미가 바뀌면 연결된 설계와 다운로드 문서도 함께 갱신한다. HTML은 허용된 렌더링 언어가 아니라 일반 텍스트로 표시된다.

**독립 변경 범위:** 문구, 접근성 문구, 모델의 데이터와 기존 반복 목록, 다운로드 자료. **웹 빌드가 필요한 범위:** 새 탭·새 구조·CSS·동작·렌더러 key 추가/삭제, 고정 이정표 박스 수 변경. v1은 10개 탭과 기존 이정표 구조를 보존하며 범용 페이지 제작기나 microfrontend framework를 도입하지 않는다.

## 빌드

저장소 루트에서 콘텐츠 입력을 commit한 뒤 실행한다.

```powershell
npm run test:index-content
npm run build:index-content
$revision = (git rev-parse HEAD).Trim()
$epoch = [long](git show -s --format=%ct HEAD)
$version = [DateTimeOffset]::FromUnixTimeSeconds($epoch).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyyMMddHHmm')
docker build --platform linux/amd64 --build-arg "VERSION=$version" --build-arg "SOURCE_REVISION=$revision" -t "opensphere-console-index-content:$version" apps/console-index-content
```

`build:index-content`는 Node 표준 라이브러리와 공유 계약 검사만 사용한다. npm install, Angular compile, Console 웹 Docker build, network/cluster write는 하지 않는다. `--allow-dirty`는 로컬 검증 전용이며 공식 source provenance가 아니다. Docker에는 고정 BusyBox와 JSON/문서·복사 스크립트만 들어간다. CI는 두 지원 아키텍처와 기존 SBOM·provenance gate를 사용한다.

`Publish-LocalEdge.ps1 -Components consoleIndexContent`는 이 산출물만 선택한다. 통합 gate와 공식 배포 승인, source·version·digest 충돌 검사를 우회하지 않는다. `edge/candidate/stable`은 pointer이며 Pod는 exact digest만 사용한다. 개별 콘텐츠 발행으로 Console anchor나 전체 설치 Ready를 변경하지 않는다.

## 같은 Pod에서 제공

1. `console-index-content` init container가 자신의 파일 checksum을 검증한다.
2. `emptyDir` 4 MiB에 콘텐츠만 복사하고 종료한다. 사용자 101, read-only root, 모든 capability 제거; 네트워크/API/credential 사용 없음.
3. 기존 `shell` nginx가 이 볼륨을 read-only로 마운트하여 `/console-index/content.json`을 제공한다.
4. web readiness는 콘텐츠 checksum과 웹/콘텐츠 렌더러 signature 일치를 확인한다. 일치하지 않는 조합은 Ready가 되지 않는다.
5. Angular는 한 HTTP 응답을 크기·형태·key·좌표·digest 검증 후 텍스트로 표시한다. 두 번의 manifest/payload 요청을 피하여 rolling update 중 서로 다른 Pod 버전이 섞이지 않는다.

다운로드 URL `/assets/installation/installation-milestones.{json,md}`는 유지한다. 제품 주소는 `https://localhost:1114/`다. 별도 www/local-dev 페이지와 무관하다. 인증된 사용자 여정은 기존 Console 인증을 따르며 콘텐츠를 위해 권한을 복제하지 않는다. 콘텐츠는 기존 공개 웹 자료와 같은 공개 설명 데이터이고 실시간 상태·자격 증명이 아니다.

## 실패·rollback·재현

- 내용 누락/변조/호환성 오류: Pod readiness 또는 해당 index의 명시적 오류. 묵시적 구버전 fallback 없음.
- 브라우저는 실패 시 재시도 버튼을 제공한다. 정상 로딩 후에는 페이지를 새로고침하여 새 배포 콘텐츠를 받는다.
- 콘텐츠 이미지 변경도 같은 Pod 전체 rolling update를 일으킨다. 웹 이미지는 다시 빌드하지 않지만 웹 컨테이너는 새 Pod에서 시작한다.
- immutable web/content 이미지 두 개와 source revision, version, renderer signature를 한 배포 receipt에 기록한다. 최초 구조 전환의 rollback은 원래 웹 이미지와 원래 Pod template 전체를 복원한다. 이후 content-only rollback은 호환되는 이전 콘텐츠 digest로 되돌린다.
- Setup의 `auxiliaryArtifacts.consoleIndexContent`가 이 digest를 소비한다. 새 웹은 `io.opensphere.console-index-content=console-index-renderer/v1`을 광고하며 새 manifest는 이 artifact가 없으면 거부된다. 이전 anchor/manifest는 기존 세 auxiliary artifact 경로를 유지한다.
- 공개 Setup 새 릴리스 발행·전체 native 기능 수용·클린 재현은 별도의 설치 완료 gate다. 이 페이지 분리를 그 완료로 간주하지 않는다.

## 렌더러 계약 변경

`packages/contracts/schemas/console-index-content.schema.json`과 공유 검사 `packages/contracts/src/console-index-content.ts`를 같은 변경에서 검토한다. key/모델 구조 변경에는 웹 빌드가 필요하다. `node scripts/verify-console-index-renderer.mjs --write`로 승인된 signature를 웹에 기록한 후 웹/콘텐츠를 함께 검사한다. 콘텐츠 전용 빌드는 이 웹 파일을 생성하거나 변경하지 않는다.

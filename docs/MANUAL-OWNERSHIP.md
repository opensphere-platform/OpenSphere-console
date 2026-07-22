# OpenSphere Manual Ownership

Status: normative

OpenSphere Manual의 유일한 제품 소유자는 Main Shell인 `OpenSphere-console`이다. Manual은 subShell, plugin, Binding 또는 독립 제품이 아니며 Console의 인증·권한·감사·검색·배포 lifecycle 안에서만 제공한다.

## Console 소유 범위

| 책임 | Console 정본 |
|---|---|
| 사용자 화면과 문서 리더 | `src/app/pages/manual.ts`, route `/manual` |
| 전역 진입점과 통합 검색 | Main Shell header, `src/app/core/search.service.ts` |
| 정본 Help Center 문서 | `docs/manual/*.md` |
| 릴리스 seed 생성 | `backend/opensphere-console-oaa-gateway/scripts/build-manual-seed.js` |
| 검색·문서 API 소비 계약 | `src/app/core/manual.service.ts` |
| 내구 저장·검색 실행 | Console-owned OAA Gateway와 CBS PostgreSQL Manual Registry |
| 회귀 방지 | `backend/dupa-control/manual-native.test.js` |

OAA Gateway가 별도 workload로 실행되는 것은 보안·서버 실행 격리를 위한 구현 경계다. Manual의 제품 소유권을 OAA, CBS 또는 별도 Extension으로 이전하지 않는다.

## Lifecycle 불변식

- Manual UI는 `opensphere-console` 이미지에 컴파일한다.
- Manual Registry seed는 Console release와 함께 생성·배포한다.
- `/manual`은 인증된 Console-native route다.
- 별도 Manual image, Pod, Service, ServiceAccount, RBAC, `UIPluginPackage`, `UIPluginRegistration` 또는 Registry extension entry를 만들지 않는다.
- 폐기된 `/p/menual` 및 `/p/manual` route나 호환 redirect를 만들지 않는다.
- 외부 subShell은 Manual에 문서를 기여할 수 있지만, 표시·검색·권한·감사와 최종 lifecycle은 Console이 소유한다.

## Legacy 프로젝트 처분

기존 독립 프로젝트 `OpenSphere-shell-menual`은 오기된 식별자와 subShell 모델을 사용한 폐기 대상이다. 해당 프로젝트의 내용을 다음과 같이 처분했다.

| Legacy 자산 | 처분 |
|---|---|
| `src/app/docs.ts`의 Perspective 개요와 10개 문서 | `docs/manual/00-10-PERSPECTIVES.md` 및 `01`~`10` 정본 문서로 이관 |
| Angular Help Center 화면 | Console-native `ManualPage`로 대체 |
| `server.js` Kubernetes proxy | 폐기. Manual은 Console의 `ManualService`와 인증된 Manual Registry API만 소비 |
| `ui-shell`, `uipluginpackage.yaml`, RBAC, 별도 Docker image | 폐기. Manual은 Extension이 아님 |
| `/p/menual` route | 폐기. redirect 없음 |
| `OAH agent CLI` 초안 | 폐기. 현재 OAA action binding·Console-native `os` 계약은 `OAA-MANUAL-KNOWLEDGE-DATA-MODEL.md`와 CLI 정본이 소유 |

따라서 독립 `OpenSphere-shell-menual` 저장소는 보존·빌드·배포 대상이 아니며 workspace에서 삭제한다. 같은 기능을 다른 이름의 Manual subShell로 다시 만들지 않는다.

## 변경 절차

### 역진 방지 계약

`console-help-center-v2`는 Console-native Help Center의 배포 계약이다. 소스와 빌드 산출물은
`scripts/verify-manual-ui.mjs`로 검사하고, Console 이미지는 동일 계약 파일과 번들 표식을 포함해야 한다.
Kubernetes Deployment readiness는 이 계약을 직접 검사하며, `ValidatingAdmissionPolicy`는 계약 annotation과
readiness가 없는 구형 매니페스트의 재적용을 거부한다. 계약 버전 변경은 새 Manual 설계의 명시적 마이그레이션으로만
상향하며, 구형 Registry 표/패널 구현으로 낮추지 않는다.


1. `docs/manual/*.md` 또는 상위 권위 문서를 수정한다.
2. `npm run manual:seed`로 릴리스 seed를 재생성한다.
3. Manual 회귀 테스트와 Console production build를 통과시킨다.
4. Console 및 Console-owned OAA Gateway 이미지를 동일 release 단위로 배포한다.
5. 브라우저에서 `/manual`, 검색, 문서 리더와 OAA citation을 검증한다.

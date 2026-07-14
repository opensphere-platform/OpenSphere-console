# My Profile 자격 증명 화면 디자인 QA

- 판정: **passed**
- 검증일: 2026-07-14
- 구현 경로: `https://localhost:8090/me?tab=credentials`
- 기준 이미지: `C:\Users\cmars\AppData\Local\Temp\codex-clipboard-5cc533f3-7289-4fdb-ad75-09645c80905a.png`
- 최종 데스크톱: `C:\Users\cmars\.codex\visualizations\2026\07\10\019f4b93-e2d1-7653-96a2-5dffe43b2a35\my-profile-credentials-final-2032x1608.png`
- 기준/구현 병렬 비교: `C:\Users\cmars\.codex\visualizations\2026\07\10\019f4b93-e2d1-7653-96a2-5dffe43b2a35\my-profile-credentials-comparison.png`
- 태블릿: `C:\Users\cmars\.codex\visualizations\2026\07\10\019f4b93-e2d1-7653-96a2-5dffe43b2a35\my-profile-credentials-tablet-final.png`
- 모바일: `C:\Users\cmars\.codex\visualizations\2026\07\10\019f4b93-e2d1-7653-96a2-5dffe43b2a35\my-profile-credentials-mobile-final.png`

## 기준 일치와 의도된 차이

- OCI 기준의 프로필 헤더, 탭, 검색 도구막대, 조밀한 데이터 그리드, 생성·폐기 동작 밀도를 Clarity v18 구성요소로 재현했다.
- OpenSphere Main Shell의 상단 헤더와 좌측 관리 레일은 제품 고유 호스팅 계약이므로 유지했다.
- OCI의 API key·customer secret을 그대로 흉내 내지 않고 실제 OpenSphere 권한 모델에 맞춰 CLI 신뢰 장치, 자동화 API 토큰, 현재 Console 세션, Extension 제공 자격으로 구성했다.
- 실제 OpenSphere 로고와 승인된 Carbon 아이콘만 사용했다. 새 래스터 자산, CSS 도형, 수제 SVG는 추가하지 않았다.

## 반응형·접근성 검증

| Viewport | 결과 |
|---|---|
| 2032×1608 | 전체 표와 동작이 한 화면 흐름에 정렬되고 body 가로 넘침 없음 |
| 1024×900 | 240px 레일과 784px 본문 확보, 넓은 표는 자체 가로 스크롤 |
| 390×844 | 50px 축소 레일, 본문 전체 폭 확보, 긴 사용자명 정상 줄바꿈, 헤더·탭·본문 충돌 없음 |

- 각 자격 증명 영역은 `article`과 제목 연결을 갖는다.
- 넓은 데이터 그리드는 키보드 포커스 가능한 스크롤 컨테이너이며 페이지 전체 overflow를 만들지 않는다.
- 프로필 탭은 모바일에서 자체 가로 스크롤하며 탭 의미와 선택 상태를 유지한다.
- 검색 입력은 명시적 label을 갖고 버튼은 키보드로 접근 가능하다.

## 핵심 흐름 검증

- 토큰 검색: 정확 일치 1건, 불일치 empty state, 초기화 후 전체 복원 통과.
- API 토큰 생성: 라벨·8자 이상 사유, 원문 1회 표시, JTI·만료 메타데이터 표시 통과.
- API 토큰 폐기: 사유 입력, 즉시 목록 제거, 이후 서버 상태 거부 계약 통과.
- 브라우저 Console 오류와 페이지 오류: 0건.
- QA 토큰은 검증 후 모두 폐기했으며 최종 PAT 목록은 0건이다.

## 결함 발견과 종결

- 1차 모바일 QA에서 확장된 좌측 레일이 본문을 압축하는 P1을 발견해 축소 레일·오버레이 계약으로 수정했다.
- 2차 QA에서 Clarity 전역 header 고정 높이가 프로필 동작을 본문과 겹치게 하는 P1을 발견해 프로필 헤더의 display·height 소유권을 고정했다.
- 3차 QA에서 긴 관리자명 `nowrap` 잘림을 발견해 모바일 정상 줄바꿈을 적용했다.
- 최종 재검증 결과 P0/P1/P2 잔여 결함은 없다.

## 비차단 빌드 부채

- 프로덕션 빌드는 성공했으나 초기 bundle 및 일부 component style budget 경고가 남아 있다. 기능·런타임·반응형 수용을 차단하지 않으며 별도 성능 최적화 대상으로 관리한다.

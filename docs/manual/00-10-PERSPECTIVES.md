# OpenSphere 10 Perspectives

OpenSphere는 하나의 Kubernetes 기반 운영 환경을 열 개의 관점으로 재구성합니다. 각 Perspective는 별도 제품이 아니라 동일한 플랫폼 실체를 역할과 목적에 맞게 읽는 운영 렌즈입니다.

## 세 개의 운영 밴드

- **Operate** — 1 OS Level, 2 K8s Cluster + Ceph, 3 User & Auth. 플랫폼의 실행 기반과 접근 통제를 운영합니다.
- **Build** — 4 Developer, 5 AI Level, 6 API. 서비스와 자동화, 정보 흐름을 구축합니다.
- **Deliver** — 7 Workspace, 8 Customer, 9 Edge, 10 WebSite. 내부 업무부터 외부 고객 경험까지 가치를 전달합니다.

## Perspective 사용 원칙

Perspective는 데이터의 복제본이 아닙니다. 동일한 리소스를 각 역할에 필요한 문맥으로 투영하며, 제어 작업은 공통 Registry, 권한, 감사 경로를 사용합니다. 어떤 Perspective에서도 Main Shell의 인증·권한·감사 경계를 우회할 수 없습니다.

## 탐색 방법

Help Center 첫 화면에서 운영 밴드를 선택한 뒤 Perspective 문서를 엽니다. 각 문서에는 목적, 주요 대상, 시작 지점과 운영 체크가 정리되어 있습니다. 통합 검색은 Perspective 문서뿐 아니라 Constitution과 구현 플레이북도 함께 조회합니다.

# 1. OS Level

운영체제, 호스트 네트워크, 스토리지와 기본 시스템 서비스를 하나의 호스트 운영 관점에서 확인합니다.

## 이 Perspective가 답하는 질문

- OpenSphere가 올라선 노드와 운영체제는 정상인가?
- 시간, DNS, 인증서, 네트워크와 로컬 스토리지 전제는 충족됐는가?
- 호스트 수준의 장애가 Kubernetes 증상으로 나타나고 있지는 않은가?

## 주요 대상

- 노드 운영체제, 커널과 런타임
- CPU, 메모리, 디스크와 파일시스템
- 호스트 네트워크, DNS, NTP와 인증서
- 컨테이너 런타임과 kubelet 전제

## 관련 문서

- RCC Linux Host Control (Stage 1–4 + 운영 기능 단위) — Region Control Center에서 Linux 호스트 상태를 읽는 에이전트, API(Application Programming Interface), 보안 경계와 설치·운영 절차. Beszel 시계열 관측, 서비스 재시작·재부팅(Stage 2), 패키지·커널 업데이트(Stage 3), 네트워크·스토리지 변경과 이미지 기반 OS 업데이트(Stage 4), Fail2ban SSH 보호의 준비·활성화·탐지·차단·해제를 포함합니다. 화면은 요약·관측·보안·유지보수·구성·이력의 운영 도메인으로 구성되고, 터미널 없이 요청·검토·확인·추적합니다. 높은 위험 작업의 2인 승인은 화면에서도 그대로 요구됩니다.

## 운영 시작

먼저 호스트의 준비 상태를 확인한 뒤 Cluster Perspective로 이동합니다. OpenSphere는 기존 Kubernetes 위에 설치되므로 호스트 자체를 임의 변경하지 않고, HIS 계약으로 확인 가능한 상태와 필요한 조치만 제시합니다.

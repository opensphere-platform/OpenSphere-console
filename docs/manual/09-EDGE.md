# 9. Edge

외부 진입점, 도메인, TLS와 엣지 노드를 통해 서비스가 사용자에게 도달하는 경로를 운영합니다.

## 이 Perspective가 답하는 질문

- 외부 사용자가 어떤 주소와 경로로 서비스에 도달하는가?
- DNS, 인증서, Ingress와 backend endpoint가 모두 정상인가?
- 엣지 장비와 원격 사이트는 중앙 정책을 따르고 있는가?

## 주요 대상

- Domain, DNS, certificate와 TLS
- Gateway, Ingress, Route와 load balancer
- probe, endpoint와 외부 가용성
- Edge node, remote site와 연결 상태

## 운영 시작

외부 주소부터 backend endpoint까지 종단 간 경로를 확인합니다. 인증서 교체와 노출 정책 변경은 영향 범위를 preview하고 승인된 변경 창에서 수행합니다.

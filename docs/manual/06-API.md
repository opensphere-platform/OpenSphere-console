# 6. API

서비스 간 연결을 단순 네트워크 목록이 아니라 provider와 consumer 사이의 정보 계약으로 운영합니다.

## 이 Perspective가 답하는 질문

- 누가 어떤 API와 이벤트를 제공하고 소비하는가?
- 계약, 엔드포인트와 실제 도달 상태가 일치하는가?
- 인증, 버전과 변경 영향은 어디까지 전파되는가?

## 주요 대상

- OpenAPI, AsyncAPI와 Registry 계약
- Service, EndpointSlice, Route와 Ingress
- 인증 범위, rate limit과 정책
- provider–consumer 관계와 상태 증거

## 운영 시작

계약을 Registry에 등록한 뒤 실제 endpoint와 연결합니다. Console과 `os` CLI는 같은 API 계약을 사용하며, 우회 endpoint나 화면 전용 백엔드를 만들지 않습니다.

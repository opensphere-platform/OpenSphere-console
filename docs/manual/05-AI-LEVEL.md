# 5. AI Level

모델, 추론, 파이프라인, 지식과 Agent 작업을 OpenSphere의 AI 운영 관점으로 구성합니다.

## 이 Perspective가 답하는 질문

- 어떤 모델과 provider가 사용 가능한가?
- 지식 검색과 도구 실행은 어떤 권한과 근거를 사용하는가?
- AI 작업의 비용, 결과와 감사를 어떻게 추적하는가?

## 주요 대상

- OAA Gateway와 provider key custody
- 모델, inference endpoint와 promotion
- Pipeline, experiment와 artifact
- Manual Registry, pgvector 지식과 action binding

## 운영 시작

OAA는 provider 모델의 기억에 의존하지 않고 Manual Registry와 실제 환경 증거를 사용합니다. 쓰기 작업은 preview, idempotency, 사용자 확인과 correlation audit를 필수로 거칩니다.

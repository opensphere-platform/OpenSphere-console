# 4. Developer

서비스 카탈로그, 소스, 빌드, 배포와 확장 SDK를 개발자 작업 흐름으로 연결합니다.

## 이 Perspective가 답하는 질문

- 새 서비스나 OpenSphere Extension을 어떻게 시작하는가?
- 빌드 산출물과 배포 상태를 어디서 추적하는가?
- 표준 템플릿과 플랫폼 계약을 어떻게 재사용하는가?

## 주요 대상

- Developer Catalog와 템플릿
- Git 저장소, CI/CD와 이미지 채널
- API 정의, 배포 리소스와 환경
- OpenSphere SDK, subShell, plugin과 Binding

## 개발 시작

정식 SDK 계약으로 모듈을 작성하고, 서명·권한·호스트 계약을 검증한 이미지 digest를 Extensions에 등록합니다. UI와 CLI는 동일한 API 및 감사 경로를 소비해야 합니다.

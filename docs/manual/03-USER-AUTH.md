# 3. User & Auth

관리자와 사용자, 그룹, 역할, 인증 수단과 세션을 하나의 신원·접근 관점에서 관리합니다.

## 이 Perspective가 답하는 질문

- 누가 Console과 API에 접근할 수 있는가?
- 사용자와 그룹에 어떤 역할과 범위가 부여됐는가?
- 비밀번호, 토큰과 세션이 정책에 맞게 관리되는가?

## 주요 대상

- Console 사용자와 관리자
- 그룹, 역할, 권한과 범위
- 비밀번호, MFA 정책, 세션과 복구 수단
- CLI device login, PAT와 API credential

## 운영 시작

최초 관리자 Wizard에서 root administrator를 구성합니다. 이후 모든 사용자·세션·토큰 관리는 프로필 또는 Console 관리 화면에서 수행하며, Supabase Auth와 Console 역할 모델을 단일 경로로 사용합니다.

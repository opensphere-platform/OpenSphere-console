# opensphere-platformconfig

OpenSphere-Platform 컴포넌트 — **Plane P1 · kind spine**

PlatformConfig Authority(원칙0) — CRD + admission webhook(singleton·organization.code 불변, 신규구현) + CRD 정확히1개·1storage version 검증게이트. 검증정정: Controller는 별도 repo가 아니라 opensphere-operator에 동거(공유 namespace 상수). PolyONInstall.spec.platform 제거로 권위역전

> arch-001(OKD 렌즈 재설계 v1.2) 기준 스캐폴드. 구현 예정.
> 설계 권위: `opensphere-docs/20-아키텍처/arch-001-opensphere-okd-재설계.md`

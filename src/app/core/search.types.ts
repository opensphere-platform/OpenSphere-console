/**
 * 검색 계약의 SSOT = @opensphere/sdk (C2 context). 셸은 SDK에서 재export만 한다(로컬 중복 제거).
 *
 * Phase B Slice 2 — 셸이 SDK를 정식 의존성(@opensphere/sdk, file: 로컬 → 발행 후 ^0.1.0)으로
 * 소비하는 첫 증명. 이후 PluginPage·NavNode·NotifyInput·OpenSpherePluginContext·ManifestV3도
 * 동일하게 SDK로 이관(extension-host 인라인 제거).
 */
export type { SearchResult, SearchProvider } from '@opensphere/sdk';

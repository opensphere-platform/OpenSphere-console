/**
 * C5 — Bindings (선언형 비-UI 기여). ADR-UI-003 §D3.
 *
 * UI 게스트(plugin)와 달리 JS 런타임 없이 '선언'으로 콘솔 core surface에 기여한다.
 * 콘솔이 호스팅·렌더하지 않고 데이터를 참조해 노출한다(host가 렌더, binding은 데이터).
 * subShell/plugin(UI 게스트, host가 마운트)과 대(對).
 *
 * 첫 사례 = CLIDownload(OKD ConsoleCLIDownload 어댑트). 콘솔 "Command Line Tools" surface가 렌더.
 */

/** binding 종류 (확장 가능 — 향후 ConsoleNotification 배너 등). */
export type BindingKind = 'CLIDownload';

/** OS별 다운로드 링크 (콘솔 상대 경로 — 셸이 서빙 컨테이너로 프록시). */
export interface CLIDownloadLink {
  os?: 'linux' | 'darwin' | 'windows';
  arch?: string;
  text: string;
  href: string;
}

/** CLIDownload.spec — CLI 다운로드 선언. */
export interface CLIDownloadSpec {
  displayName: string;
  description?: string;
  /** 소프트 토글(콘솔 노출). false=숨김(선언·서빙은 유지). 기본 true. */
  enabled?: boolean;
  links: CLIDownloadLink[];
}

/** 콘솔이 admin/CLI로 인식하는 binding의 정규화 형태(/api/admin/bindings 응답). */
export interface BindingInfo extends CLIDownloadSpec {
  kind: BindingKind;
  name: string;
  enabled: boolean;
}

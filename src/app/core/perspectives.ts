export const DEFAULT_CONTROL_CENTER_ID = 'cc2';

const CONTROL_CENTER_ID_RE = /^[a-z0-9-]+$/;

const BAND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '운영': '운영',
  '운영 operate': '운영',
  'operate': '운영',
  'infrastructure': '운영',
  '구축': '구축',
  '구축 build': '구축',
  'build': '구축',
  '전달': '전달',
  '전달 deliver': '전달',
  'deliver': '전달',
  '지능': '지능',
  '지능 intelligence': '지능',
  'intelligence': '지능',
});

export interface PluginNavigationPage {
  id: string;
  title: string;
  navBand: string;
}

export interface PluginNavigationTarget {
  pluginId: string;
  path: string;
  label: string;
  band: string;
}

/** URL 안의 `/cc/<id>/...` 문맥만 허용한다. 임의 문자열은 제어센터 ID가 될 수 없다. */
export function controlCenterIdFromUrl(url: string): string | null {
  const pathname = String(url || '').split(/[?#]/, 1)[0];
  const match = /(?:^|\/)cc\/([a-z0-9-]+)(?:\/|$)/.exec(pathname);
  return match && CONTROL_CENTER_ID_RE.test(match[1]) ? match[1] : null;
}

/** 기존 혼용 밴드를 사용자에게 보이는 네 개의 일관된 분류로 정규화한다. */
export function canonicalNavBand(navBand: string): string {
  const cleaned = String(navBand || '').trim();
  return BAND_ALIASES[cleaned.toLowerCase()] ?? cleaned;
}

/** 현재 설치된 1급 지역 기능의 사용자 표시명을 구현 ID와 분리한다. */
export function navigationTitleForPlugin(id: string, title: string): string {
  if (id === 'linux-host-manager') return 'Linux 호스트';
  return title;
}

/**
 * 플러그인 사용자 진입 경로 계약.
 *
 * 대부분의 확장은 `/p/<id>` 동적 호스트로 진입한다. 지역 자원을 다루는
 * linux-host-manager는 제어센터 문맥이 없으면 올바른 데이터를 선택할 수 없으므로,
 * Main Shell이 소유하는 안정 별칭 `/cc/<ccId>/hosts`로만 메뉴를 만든다.
 */
export function routeForPlugin(id: string, controlCenterId = DEFAULT_CONTROL_CENTER_ID): string {
  if (id === 'linux-host-manager') {
    const ccId = CONTROL_CENTER_ID_RE.test(controlCenterId)
      ? controlCenterId
      : DEFAULT_CONTROL_CENTER_ID;
    return `/cc/${ccId}/hosts`;
  }
  return `/p/${id}`;
}

/** 메뉴·검색·홈 카드가 반드시 같은 경로·이름·분류를 사용하도록 하는 단일 투영 함수. */
export function navigationForPlugin(
  page: PluginNavigationPage,
  controlCenterId = DEFAULT_CONTROL_CENTER_ID,
): PluginNavigationTarget {
  return {
    pluginId: page.id,
    path: routeForPlugin(page.id, controlCenterId),
    label: navigationTitleForPlugin(page.id, page.title),
    band: canonicalNavBand(page.navBand),
  };
}

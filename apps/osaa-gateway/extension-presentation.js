'use strict';

function registryEntries(registry) {
  if (Array.isArray(registry?.plugins)) return registry.plugins;
  if (Array.isArray(registry?.items)) return registry.items;
  if (Array.isArray(registry?.registrations)) return registry.registrations;
  return [];
}

function ownsChildNavigation(contribution) {
  const reason = String(contribution?.reason || '');
  return contribution?.enabled === false && /owns (?:the )?child navigation/i.test(reason);
}

function mountsInsideHost(contribution) {
  const reason = String(contribution?.reason || '');
  return contribution?.enabled === false && /mounted inside (?:the )?.+subshell/i.test(reason);
}

function expectedRoute(hostRef, childId) {
  if (hostRef === 'foundation') return `/pfss/${childId}`;
  return `/p/${hostRef}/${childId}`;
}

/**
 * Project the owner Registry into presentation-lifecycle evidence.
 *
 * This deliberately does not claim browser DOM visibility. Registry can prove
 * that a host owns a child's menu and that the child UI is route-scoped; only
 * a browser can prove that CSS/rendering currently makes that menu visible.
 */
function projectExtensionPresentation(registry) {
  const entries = registryEntries(registry);
  const byId = new Map(entries.map((entry) => [String(entry?.id || ''), entry]));
  const items = entries
    .filter((entry) => entry?.kind === 'plugin' && String(entry?.hostRef || 'main') !== 'main')
    .map((entry) => {
      const id = String(entry.id || '');
      const hostRef = String(entry.hostRef || '');
      const host = byId.get(hostRef);
      const available = entry.available === true;
      const hostAvailable = host?.available === true;
      const hostOwnsNavigation = ownsChildNavigation(entry?.contributions?.navigation);
      const hostMountsPage = mountsInsideHost(entry?.contributions?.page);
      const blockers = [];
      if (!available) blockers.push('Registry marks the plugin unavailable');
      if (!host) blockers.push(`Owning subShell '${hostRef}' is missing from Registry`);
      else if (!hostAvailable) blockers.push(`Owning subShell '${hostRef}' is unavailable`);
      if (!hostOwnsNavigation) blockers.push('Host-owned child navigation contract is missing');
      if (!hostMountsPage) blockers.push('Host-mounted child page contract is missing');
      const eligible = blockers.length === 0;
      return {
        id,
        name: String(entry.name || id),
        hostRef,
        expectedRoute: expectedRoute(hostRef, id),
        available,
        hostAvailable,
        navigationOwner: hostOwnsNavigation ? hostRef : 'unresolved',
        menuEligibility: eligible ? 'Eligible' : 'Blocked',
        uiActivation: eligible ? 'OnDemand' : 'Blocked',
        browserVisibilityVerified: false,
        lifecycleMutationRequired: false,
        blockers,
      };
    });
  const menuEligible = items.filter((item) => item.menuEligibility === 'Eligible').length;
  const onDemandUi = items.filter((item) => item.uiActivation === 'OnDemand').length;
  const blocked = items.length - menuEligible;
  const healthySeparation = items.length > 0 && blocked === 0;
  return {
    schema: 'opensphere.extension-presentation-status/v1',
    authority: 'Main Shell DUPA Registry owner API',
    diagnosis: healthySeparation ? 'HOST_NAVIGATION_LAZY_UI_SEPARATION' : 'EXTENSION_PRESENTATION_BLOCKED',
    summary: { total: items.length, menuEligible, onDemandUi, blocked },
    interpretation: healthySeparation
      ? 'Registry의 요청 시 적재는 child UI 실행 시점이며 메뉴 미노출을 뜻하지 않습니다. Host 메뉴는 즉시 제공하고 child UI만 선택한 경로에서 적재해야 합니다.'
      : 'Registry 또는 Host 소유 계약에 실제 차단 항목이 있습니다. blockers를 먼저 해결해야 합니다.',
    recommendedAction: healthySeparation
      ? 'PRESENT_HOST_NAVIGATION_KEEP_UI_ROUTE_SCOPED'
      : 'REPAIR_REPORTED_OWNER_CONTRACT_BLOCKERS',
    mutationSafety: healthySeparation
      ? 'Enable, restart, reinstall 같은 수명주기 변경은 필요하지 않습니다.'
      : '원인 확인 전 일괄 enable/restart/reinstall을 실행하지 마십시오.',
    items,
  };
}

function renderExtensionPresentation(projection) {
  const summary = projection?.summary || {};
  const items = Array.isArray(projection?.items) ? projection.items : [];
  const lines = [
    `Registry Plugin ${Number(summary.total || 0)}개 중 메뉴 표시 가능 ${Number(summary.menuEligible || 0)}개, 차단 ${Number(summary.blocked || 0)}개입니다.`,
    String(projection?.interpretation || ''),
  ];
  for (const item of items) {
    lines.push(`- ${item.name} (${item.id}): 메뉴 ${item.menuEligibility}, UI ${item.uiActivation}, 경로 ${item.expectedRoute}`);
    if (item.blockers?.length) lines.push(`  차단 사유: ${item.blockers.join('; ')}`);
  }
  lines.push(String(projection?.mutationSafety || ''));
  lines.push('브라우저 실제 표시 여부는 이 Registry projection만으로 검증하지 않았습니다.');
  return lines.filter(Boolean).join('\n');
}

module.exports = { projectExtensionPresentation, renderExtensionPresentation };

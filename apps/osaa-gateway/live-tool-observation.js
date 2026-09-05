'use strict';

const { renderConsoleInstallationObservation } = require('./console-installation-observation');

const NON_RUNTIME_TOOLS = new Set([
  'search_opensphere_knowledge',
  'get_opensphere_source_catalog',
  'resolve_opensphere_source_revision',
  'read_opensphere_source',
  'search_opensphere_source',
  'list_governed_actions',
  'plan_durable_operation',
  'plan_foundation_postgres_cluster',
  'plan_platform_recovery_drill',
  'plan_his_observability_config',
  'plan_ceph_connection',
]);

function projectVerifiedLiveToolObservation(evidence = []) {
  const items = (Array.isArray(evidence) ? evidence : [])
    .filter((entry) => entry && typeof entry === 'object')
    .filter((entry) => !NON_RUNTIME_TOOLS.has(String(entry.tool || '')))
    .map((entry) => ({
      tool: String(entry.tool || 'unknown'),
      arguments: entry.arguments && typeof entry.arguments === 'object' ? entry.arguments : {},
      status: entry.result?.ok === false ? 'unavailable' : 'observed',
      result: entry.result ?? null,
    }));
  return {
    schema: 'osaa.verified-live-tool-observation/v1',
    epistemicState: items.length ? 'known' : 'unobservable',
    items,
  };
}

function renderVerifiedLiveToolObservation(observation, options = {}) {
  if (observation?.schema !== 'osaa.verified-live-tool-observation/v1'
      || !Array.isArray(observation.items) || observation.items.length === 0) return '';
  const redactText = typeof options.redactText === 'function' ? options.redactText : String;
  const sections = observation.items.map((item) => {
    if (item.tool === 'get_console_installation_status') {
      const summary = renderConsoleInstallationObservation(item.result);
      if (summary) return summary;
    }
    const target = [item.arguments?.namespace, item.arguments?.name || item.arguments?.pod]
      .filter(Boolean).join('/') || 'OpenSphere';
    const body = redactText(JSON.stringify(item.result, null, 2)).slice(0, 12000);
    return [`### ${item.tool}`, `- 대상: ${target}`, `- 관측 상태: ${item.status}`, '```json', body, '```'].join('\n');
  });
  return ['실제 Owner/API 도구가 반환한 현재 관측 결과입니다.', ...sections].join('\n\n');
}

module.exports = {
  projectVerifiedLiveToolObservation,
  renderVerifiedLiveToolObservation,
};

'use strict';

// CON-FR-007/013/017/018 · C_AI · CON-RT-08: fixed read-only bootstrap view.
// No new owner, endpoint, credential or resource. Never send inventory payloads
// or upstream errors to the provider; only the explicitly projected fields leave C_AI.
function requiresConsoleInstallationSummary(query) {
  const text = String(query || '');
  return /console|콘솔/iu.test(text) && /cluster[ -]manager|클러스터\s*매니저/iu.test(text)
    && /상태|점검|준비|status|readiness|check/iu.test(text);
}

async function consoleInstallationObservation({ listResources, now = () => new Date() }) {
  const result = { schema: 'osaa.console-installation-observation/v1', observedAt: now().toISOString(), readOnly: true };
  const reads = await Promise.allSettled([
    listResources({ kind: 'node', limit: 500 }),
    listResources({ kind: 'deployment', namespace: 'opensphere-console', limit: 500 }),
    listResources({ kind: 'uipluginregistration', namespace: 'opensphere-console', limit: 500 }),
  ]);
  const completeResources = (read, kind, namespace) => read.status === 'fulfilled'
    && read.value?.kind === kind && read.value.namespace === namespace
    && Array.isArray(read.value.resources) && !read.value.continue;
  result.nodes = { state: 'Unknown', source: 'Kubernetes: /api/v1/nodes' };
  if (completeResources(reads[0], 'Node', null)) {
    const nodes = reads[0].value.resources;
    result.nodes = { ...result.nodes, state: 'Observed', total: nodes.length,
      ready: nodes.filter(n => !n.metadata?.deletionTimestamp && n.conditions?.some(c => c.type === 'Ready' && c.status === 'True')).length };
  }
  result.console = { state: 'Unknown', namespace: 'opensphere-console', source: 'Kubernetes: /apis/apps/v1/namespaces/opensphere-console/deployments' };
  if (completeResources(reads[1], 'Deployment', 'opensphere-console')) {
    const deployments = reads[1].value.resources.map(d => ({
      name: d.metadata.name, desired: d.desired, ready: d.ready, updated: d.updated, available: d.available,
      rolloutReady: !d.metadata.deletionTimestamp && Number.isInteger(d.desired) && d.desired > 0
        && Number.isInteger(d.metadata.generation) && d.observedGeneration >= d.metadata.generation
        && d.ready === d.desired && d.updated === d.desired && d.available === d.desired,
    }));
    result.console = { ...result.console, state: 'Observed', total: deployments.length,
      ready: deployments.filter(d => d.rolloutReady).length, deployments };
  }
  result.clusterManager = { state: 'Unknown', source: 'C_EXT via Kubernetes: /apis/plugins.opensphere.io/v1alpha1/namespaces/opensphere-console/uipluginregistrations', operationState: 'NotQueried' };
  const registrationRead = reads[2];
  if (completeResources(registrationRead, 'UIPluginRegistration', 'opensphere-console')) {
    const matches = registrationRead.value.resources.filter(r => r.metadata?.name === 'cluster-manager');
    if (matches.length === 0) result.clusterManager.state = 'NotRegistered';
    if (matches.length === 1) {
      const r = matches[0], v = r.verification || {};
      const ready = !r.metadata.deletionTimestamp && Number.isInteger(r.metadata.generation) && r.observedGeneration >= r.metadata.generation
        && r.desiredState === 'Enabled' && r.phase === 'Activated' && r.servingPhase === 'Current'
        && r.workloadPhase === 'Ready' && v.manifest === 'Verified' && v.signature === 'Verified' && v.entryDigest === 'Verified'
        && v.permissions === 'Approved' && /^sha256:[a-f0-9]{64}$/.test(r.currentDigest || '');
      result.clusterManager.state = ready ? 'Ready' : 'RegisteredNotReady';
    }
  }
  return result;
}

function renderConsoleInstallationObservation(value) {
  if (value?.schema !== 'osaa.console-installation-observation/v1') return '';
  const nodes = value.nodes, consoleState = value.console, cm = value.clusterManager;
  const cmState = { Unknown: '미확인', NotRegistered: '아직 등록되지 않음 — 설치 완료 아님', Ready: '등록·서명·워크로드 준비 확인', RegisteredNotReady: '등록되었으나 준비 미완료' };
  return [
    `조회 시각: ${value.observedAt} (UTC) · 읽기 전용`,
    `- Kubernetes 노드: ${nodes.state === 'Observed' ? `${nodes.ready}/${nodes.total} Ready` : '미확인 (조회 실패 또는 목록 불완전)'}`,
    `- Console 배포: ${consoleState.state === 'Observed' ? `${consoleState.ready}/${consoleState.total} 준비됨` : '미확인 (조회 실패 또는 목록 불완전)'}`,
    ...(consoleState.deployments || []).map(d => `  - ${d.name}: ${d.ready}/${d.desired} Ready, rollout ${d.rolloutReady ? '준비됨' : '미완료'}`),
    `- Cluster Manager: ${cmState[cm.state] || '미확인'}`,
    '- 설치 승인 작업 상태는 이 조회에 포함되지 않습니다. 배포 Ready만으로 전체 기능·설치 재현 완료를 뜻하지 않습니다.',
    `조회 근거: ${nodes.source}; ${consoleState.source}; ${cm.source}`,
  ].join('\n');
}

module.exports = { requiresConsoleInstallationSummary, consoleInstallationObservation, renderConsoleInstallationObservation };

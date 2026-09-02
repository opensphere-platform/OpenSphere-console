'use strict';

const OS_SHELL_DEPLOYMENTS = Object.freeze([
  'opensphere-shell-api',
  'opensphere-shell-gateway',
  'opensphere-shell-reconciler',
  'opensphere-shell-console-api',
]);

const OS_SHELL_SERVICES = Object.freeze([
  ...OS_SHELL_DEPLOYMENTS,
  'opensphere-shell-credential-authority',
]);

function step(id, state, evidence, nextAction = null) {
  return { id, state, evidence: String(evidence || ''), nextAction };
}

function errorText(value) {
  return String(value?.message || value?.msg || value?.error || value || 'unknown').slice(0, 500);
}

function buildManualAccessDiagnosis(input = {}) {
  const authenticated = input.authenticated === true;
  const permission = input.permission === true;
  const probe = input.registryProbe || {};
  const steps = [
    step('browser-route', 'known', '/manual is owned by Main Shell and consumes /api/manual/*.'),
    step('authentication', authenticated ? 'verified' : 'failed', authenticated
      ? 'The current R2D2 request has a verified Console identity.'
      : 'No verified Console identity reached the Gateway.', 'Sign in again and retry the same route.'),
    step('authorization', permission ? 'verified' : (authenticated ? 'failed' : 'blocked'), permission
      ? 'The actor has osaa.knowledge.read.'
      : 'The actor does not have osaa.knowledge.read.', 'Correct the Console role/permission binding; do not change Manual data.'),
  ];

  if (!authenticated || !permission) {
    const rootCause = authenticated ? 'ManualPermissionDenied' : 'ManualAuthenticationRequired';
    return {
      schema: 'opensphere.osaa.surface-diagnosis/v1',
      surface: 'manual',
      state: 'known',
      ready: false,
      rootCause,
      failureStage: authenticated ? 'authorization' : 'authentication',
      steps,
      mutationRequired: authenticated,
      recommendedAction: authenticated ? 'REPAIR_IDENTITY_PERMISSION_BINDING' : 'REAUTHENTICATE',
      browserVisibilityVerified: false,
    };
  }

  if (probe.ok !== true) {
    steps.push(step('manual-registry', 'failed', `Manual Registry probe failed: ${errorText(probe.error)}`,
      'Inspect the OSAA Gateway database/seed readiness before changing frontend guards.'));
    return {
      schema: 'opensphere.osaa.surface-diagnosis/v1',
      surface: 'manual',
      state: 'known',
      ready: false,
      rootCause: 'ManualRegistryUnavailable',
      failureStage: 'manual-registry',
      steps,
      mutationRequired: true,
      recommendedAction: 'REPAIR_MANUAL_REGISTRY_OWNER',
      browserVisibilityVerified: false,
    };
  }

  const sourceCount = Number(probe.sourceCount || 0);
  steps.push(step('manual-registry', sourceCount > 0 ? 'verified' : 'failed',
    `${sourceCount} authorized Manual source(s) are visible to the current actor.`,
    sourceCount > 0 ? null : 'Reconcile the bundled Manual seed and verify the actor ACL projection.'));
  return {
    schema: 'opensphere.osaa.surface-diagnosis/v1',
    surface: 'manual',
    state: sourceCount > 0 ? 'known' : 'known',
    ready: sourceCount > 0,
    rootCause: sourceCount > 0 ? null : 'ManualRegistryEmpty',
    failureStage: sourceCount > 0 ? null : 'manual-registry',
    steps,
    mutationRequired: sourceCount === 0,
    recommendedAction: sourceCount > 0 ? 'VERIFY_BROWSER_ROUTE_AND_NETWORK' : 'RECONCILE_MANUAL_SEED',
    browserVisibilityVerified: false,
  };
}

function workloadState(value) {
  const desired = Number(value?.desired || 0);
  const ready = Number(value?.ready || 0);
  const available = Number(value?.available || 0);
  return { desired, ready, available, healthy: desired > 0 && ready === desired && available === desired };
}

function buildOsShellDiagnosis(input = {}) {
  const feature = input.featureState || {};
  const gates = input.gates || {};
  const deployments = new Map((input.deployments || []).map((item) => [String(item.name || ''), item]));
  const services = new Set((input.services || []).map((item) => String(item.name || item)));
  const steps = [];

  if (feature.ok !== true) {
    steps.push(step('feature-authority', 'failed', `OS Shell feature authority is unavailable: ${errorText(feature.error)}`,
      'Restore the Console-owned feature authority before restarting OS Shell workloads.'));
    return terminalOsShellDiagnosis('OsShellFeatureAuthorityUnavailable', 'feature-authority', steps,
      'REPAIR_OS_SHELL_FEATURE_AUTHORITY');
  }
  const enabled = feature.value?.enabled === true;
  steps.push(step('feature-authority', enabled ? 'verified' : 'failed',
    `Durable feature state is ${enabled ? 'enabled' : 'disabled'} at revision ${Number(feature.value?.revision || 0)}.`,
    enabled ? null : 'Use the signed local-edge feature owner to enable the already verified OS Shell release.'));
  if (!enabled) return terminalOsShellDiagnosis('OsShellDisabled', 'feature-authority', steps, 'ENABLE_VERIFIED_OS_SHELL_RELEASE');

  const admissionEnabled = gates.available === true && gates.admissionEnabled === true;
  const credentialEnabled = gates.available === true && gates.credentialAuthorityEnabled === true;
  const gateHealthy = admissionEnabled && credentialEnabled;
  steps.push(step('control-gates', gateHealthy ? 'verified' : 'failed', gates.available === true
    ? `admission=${admissionEnabled}; credentialAuthority=${credentialEnabled}`
    : `OS Shell control gate ConfigMap is unavailable: ${errorText(gates.error)}`,
  'Reconcile the signed OS Shell control release; do not patch Deployment env values by hand.'));
  if (!gateHealthy) return terminalOsShellDiagnosis('OsShellControlGateDisabled', 'control-gates', steps, 'RECONCILE_OS_SHELL_CONTROL_GATES');

  const unhealthyDeployments = [];
  for (const name of OS_SHELL_DEPLOYMENTS) {
    const observed = workloadState(deployments.get(name));
    if (!observed.healthy) unhealthyDeployments.push(name);
  }
  steps.push(step('workloads', unhealthyDeployments.length ? 'failed' : 'verified', unhealthyDeployments.length
    ? `Unready deployment(s): ${unhealthyDeployments.join(', ')}.`
    : `${OS_SHELL_DEPLOYMENTS.length} required deployments are fully ready.`,
  'Inspect only the reported deployment(s), their events, and current image digest.'));
  if (unhealthyDeployments.length) return terminalOsShellDiagnosis('OsShellWorkloadUnavailable', 'workloads', steps, 'REPAIR_REPORTED_OS_SHELL_WORKLOADS');

  const missingServices = OS_SHELL_SERVICES.filter((name) => !services.has(name));
  steps.push(step('services', missingServices.length ? 'failed' : 'verified', missingServices.length
    ? `Missing Service(s): ${missingServices.join(', ')}.`
    : `${OS_SHELL_SERVICES.length} required Services are present.`,
  'Reconcile only the missing OS Shell Service contract.'));
  if (missingServices.length) return terminalOsShellDiagnosis('OsShellServiceUnavailable', 'services', steps, 'REPAIR_REPORTED_OS_SHELL_SERVICES');

  const browserStatus = Number(input.browserStatus || 0);
  if (browserStatus >= 400) {
    steps.push(step('browser-readiness', 'failed', `/api/os-shell/readiness returned HTTP ${browserStatus} while feature, gates, workloads, and Services are healthy.`,
      'Inspect front-door admission, permission revision, and dependency readiness response for this exact request.'));
    return terminalOsShellDiagnosis('OsShellFrontDoorOrAdmissionFailure', 'browser-readiness', steps, 'TRACE_OS_SHELL_FRONT_DOOR_REQUEST');
  }
  if (browserStatus >= 200 && browserStatus < 300) {
    steps.push(step('browser-readiness', 'verified', `/api/os-shell/readiness returned HTTP ${browserStatus}.`));
    return {
      schema: 'opensphere.osaa.surface-diagnosis/v1', surface: 'os-shell', state: 'known', ready: true,
      rootCause: null, failureStage: null, steps, mutationRequired: false,
      recommendedAction: 'VERIFY_SESSION_ATTACH_AND_TERMINAL_IO', browserVisibilityVerified: false,
    };
  }

  steps.push(step('browser-readiness', 'unobservable', 'No same-session browser readiness response was supplied to this diagnostic run.',
    'Verify /api/os-shell/readiness, session creation, attach ticket, WebSocket, and terminal I/O in the current browser session.'));
  return {
    schema: 'opensphere.osaa.surface-diagnosis/v1', surface: 'os-shell', state: 'unobservable', ready: false,
    rootCause: null, failureStage: 'browser-readiness', steps, mutationRequired: false,
    recommendedAction: 'VERIFY_BROWSER_SESSION_PATH', browserVisibilityVerified: false,
  };
}

function terminalOsShellDiagnosis(rootCause, failureStage, steps, recommendedAction) {
  return {
    schema: 'opensphere.osaa.surface-diagnosis/v1',
    surface: 'os-shell',
    state: 'known',
    ready: false,
    rootCause,
    failureStage,
    steps,
    mutationRequired: true,
    recommendedAction,
    browserVisibilityVerified: false,
  };
}

function renderSurfaceDiagnosis(diagnosis) {
  const title = diagnosis.surface === 'manual' ? 'Manual 접근 진단' : 'OS Shell 진단';
  const verdict = diagnosis.ready ? '현재 수집한 제어면 근거는 정상입니다.'
    : diagnosis.rootCause ? `직접 원인은 **${diagnosis.rootCause}** 입니다.`
      : '제어면은 정상이나 브라우저 구간을 아직 관측하지 못했습니다.';
  const lines = [`## ${title}`, '', verdict, '', '### 확인한 단계', ''];
  for (const item of diagnosis.steps || []) {
    lines.push(`- **${item.id} · ${item.state}** — ${item.evidence}`);
  }
  lines.push('', `다음 작업: **${diagnosis.recommendedAction}**`);
  if (diagnosis.browserVisibilityVerified !== true) {
    lines.push('', '> 실제 브라우저 화면·세션 연결은 아직 검증 증거가 아니므로 완료로 판정하지 않습니다.');
  }
  return lines.join('\n');
}

module.exports = {
  OS_SHELL_DEPLOYMENTS,
  OS_SHELL_SERVICES,
  buildManualAccessDiagnosis,
  buildOsShellDiagnosis,
  renderSurfaceDiagnosis,
};

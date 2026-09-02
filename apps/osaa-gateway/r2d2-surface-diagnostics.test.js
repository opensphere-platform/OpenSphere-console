'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OS_SHELL_DEPLOYMENTS,
  OS_SHELL_SERVICES,
  buildManualAccessDiagnosis,
  buildOsShellDiagnosis,
  renderSurfaceDiagnosis,
} = require('./r2d2-surface-diagnostics');

test('Manual diagnosis separates authentication, authorization, and registry failure', () => {
  assert.equal(buildManualAccessDiagnosis({ authenticated: false }).rootCause, 'ManualAuthenticationRequired');
  assert.equal(buildManualAccessDiagnosis({ authenticated: true, permission: false }).rootCause, 'ManualPermissionDenied');
  const unavailable = buildManualAccessDiagnosis({ authenticated: true, permission: true, registryProbe: { ok: false, error: 'database timeout' } });
  assert.equal(unavailable.rootCause, 'ManualRegistryUnavailable');
  assert.equal(unavailable.failureStage, 'manual-registry');
  const ready = buildManualAccessDiagnosis({ authenticated: true, permission: true, registryProbe: { ok: true, sourceCount: 4 } });
  assert.equal(ready.ready, true);
  assert.equal(ready.recommendedAction, 'VERIFY_BROWSER_ROUTE_AND_NETWORK');
});

function healthyOsShellInput() {
  return {
    featureState: { ok: true, value: { enabled: true, revision: 8 } },
    gates: { available: true, admissionEnabled: true, credentialAuthorityEnabled: true },
    deployments: OS_SHELL_DEPLOYMENTS.map((name) => ({ name, desired: 1, ready: 1, available: 1 })),
    services: OS_SHELL_SERVICES.map((name) => ({ name })),
  };
}

test('OS Shell diagnosis identifies durable feature disable before workload noise', () => {
  const diagnosis = buildOsShellDiagnosis({ ...healthyOsShellInput(), featureState: { ok: true, value: { enabled: false, revision: 9 } } });
  assert.equal(diagnosis.rootCause, 'OsShellDisabled');
  assert.equal(diagnosis.failureStage, 'feature-authority');
  assert.equal(diagnosis.steps.length, 1);
});

test('OS Shell diagnosis isolates gate, workload, service, and front-door failures', () => {
  const gate = buildOsShellDiagnosis({ ...healthyOsShellInput(), gates: { available: true, admissionEnabled: false, credentialAuthorityEnabled: true } });
  assert.equal(gate.rootCause, 'OsShellControlGateDisabled');

  const workloadInput = healthyOsShellInput();
  workloadInput.deployments[1] = { name: OS_SHELL_DEPLOYMENTS[1], desired: 2, ready: 1, available: 1 };
  assert.equal(buildOsShellDiagnosis(workloadInput).rootCause, 'OsShellWorkloadUnavailable');

  const serviceInput = healthyOsShellInput();
  serviceInput.services = serviceInput.services.filter((item) => item.name !== 'opensphere-shell-console-api');
  assert.equal(buildOsShellDiagnosis(serviceInput).rootCause, 'OsShellServiceUnavailable');

  const frontDoor = buildOsShellDiagnosis({ ...healthyOsShellInput(), browserStatus: 500 });
  assert.equal(frontDoor.rootCause, 'OsShellFrontDoorOrAdmissionFailure');
  assert.equal(frontDoor.failureStage, 'browser-readiness');
});

test('healthy OS Shell control plane remains unobservable until browser session postcondition', () => {
  const diagnosis = buildOsShellDiagnosis(healthyOsShellInput());
  assert.equal(diagnosis.state, 'unobservable');
  assert.equal(diagnosis.ready, false);
  assert.equal(diagnosis.mutationRequired, false);
  assert.match(renderSurfaceDiagnosis(diagnosis), /완료로 판정하지 않습니다/);
});

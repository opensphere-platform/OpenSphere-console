'use strict';

const { createHash } = require('crypto');
const path = require('path');
const { normalizedRelativePath } = require('./r2d2-engineering-remediation');

const CONSOLE_REPOSITORY = 'https://github.com/opensphere-platform/OpenSphere-console.git';
const SUPPORTED_TESTS = Object.freeze(new Set(['unit', 'contract', 'integration', 'security']));
const COMPONENT_RULES = Object.freeze([
  Object.freeze({
    sourceComponent: 'consoleBackend', releaseComponent: 'backend', image: 'opensphere-console-backend',
    prefixes: Object.freeze(['apps/console-api/runtime/']),
    publisher: 'scripts/Publish-LocalEdgeBackendBridge.ps1',
    workload: Object.freeze({ namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-console-backend', container: 'api' }),
  }),
  Object.freeze({
    sourceComponent: 'osaaGateway', releaseComponent: 'osaaGateway', image: 'opensphere-console-osaa-gateway',
    prefixes: Object.freeze(['apps/osaa-gateway/']),
    publisher: 'scripts/Publish-LocalEdgeOsaaGateway.ps1',
    workload: Object.freeze({ namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-console-osaa-gateway', container: 'gateway' }),
  }),
  Object.freeze({
    sourceComponent: 'console', releaseComponent: 'console', image: 'opensphere-console',
    prefixes: Object.freeze(['src/', 'nginx/']),
    publisher: 'scripts/Publish-LocalEdgeConsole.ps1',
    workload: Object.freeze({ namespace: 'opensphere-console', kind: 'deployment', name: 'opensphere-console', container: 'console' }),
  }),
]);

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function sameSet(left, right) {
  return JSON.stringify([...new Set(left || [])].sort()) === JSON.stringify([...new Set(right || [])].sort());
}

function deriveRepairScope(changedPaths) {
  const paths = [...new Set((changedPaths || []).map((value) => normalizedRelativePath(value)))];
  if (!paths.length) throw new Error('Repair Runner requires at least one changed path');
  const rules = [];
  for (const candidate of paths) {
    const matches = COMPONENT_RULES.filter((rule) => rule.prefixes.some((prefix) => candidate.startsWith(prefix)));
    if (matches.length !== 1) throw new Error(`Repair Runner does not own changed path: ${candidate}`);
    if (!rules.includes(matches[0])) rules.push(matches[0]);
  }
  return Object.freeze({
    changedPaths: paths.sort(),
    sourceComponents: rules.map((item) => item.sourceComponent).sort(),
    releaseComponents: rules.map((item) => item.releaseComponent).sort(),
    images: rules.map((item) => item.image).sort(),
    publishers: rules.map((item) => item.publisher),
    workloads: rules.map((item) => item.workload),
  });
}

function validateLocalEdgeRepair(request) {
  if (request.repository !== CONSOLE_REPOSITORY) throw new Error('Repair Runner supports only canonical OpenSphere-console');
  if (request.targetChannel !== 'edge' || request.buildAuthority !== 'localhost' || request.releaseScope !== 'component') {
    throw new Error('Repair Runner supports only localhost edge component releases');
  }
  if (request.approvalMode !== 'local-edge-supervised') throw new Error('Repair Runner requires one supervised local-edge work-unit approval');
  if (request.riskLevel !== 'R2') throw new Error('Repair Runner MVP supports only reversible R2 work');
  const tests = [...new Set(request.requiredTests || [])];
  if (!tests.length || tests.some((item) => !SUPPORTED_TESTS.has(item))) {
    throw new Error('Repair Runner test profile is not supported');
  }
  const scope = deriveRepairScope(request.patchArtifact?.changedFiles || []);
  if (scope.sourceComponents.length !== 1) throw new Error('Repair Runner MVP changes exactly one component per work unit');
  if (!sameSet(scope.sourceComponents, request.affectedComponents)) throw new Error('declared affected components differ from changed paths');
  if (!sameSet(scope.images, request.affectedImages)) throw new Error('declared affected images differ from changed paths');
  return Object.freeze({ ...scope, requiredTests: tests.sort() });
}

function safeSandboxRoot(root, requestId) {
  const id = String(requestId || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Repair Runner request id is invalid');
  const base = path.resolve(String(root || ''));
  const target = path.resolve(base, id);
  if (!base || target === base || !target.startsWith(`${base}${path.sep}`)) throw new Error('Repair Runner sandbox escaped its root');
  return target;
}

module.exports = {
  COMPONENT_RULES, CONSOLE_REPOSITORY, SUPPORTED_TESTS, deriveRepairScope,
  safeSandboxRoot, sameSet, sha256, validateLocalEdgeRepair,
};

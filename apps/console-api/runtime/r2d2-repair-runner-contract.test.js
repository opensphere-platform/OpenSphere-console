'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONSOLE_REPOSITORY, deriveRepairScope, safeSandboxRoot, validateLocalEdgeRepair,
} = require('./r2d2-repair-runner-contract');

function request(overrides = {}) {
  return {
    repository: CONSOLE_REPOSITORY, targetChannel: 'edge', buildAuthority: 'localhost',
    releaseScope: 'component', approvalMode: 'local-edge-supervised', riskLevel: 'R2',
    requiredTests: ['unit', 'contract', 'integration', 'security'],
    affectedComponents: ['osaaGateway'], affectedImages: ['opensphere-console-osaa-gateway'],
    patchArtifact: { changedFiles: ['apps/osaa-gateway/server.js'] },
    ...overrides,
  };
}

test('repair scope derives the exact component, publisher and workload from paths', () => {
  const scope = deriveRepairScope([
    'apps/console-api/runtime/server.js',
    'apps/osaa-gateway/server.js',
  ]);
  assert.deepEqual(scope.sourceComponents, ['consoleBackend', 'osaaGateway']);
  assert.deepEqual(scope.releaseComponents, ['backend', 'osaaGateway']);
  assert.deepEqual(scope.images, ['opensphere-console-backend', 'opensphere-console-osaa-gateway']);
  assert.equal(scope.publishers.length, 2);
});

test('repair scope rejects docs, scripts, migrations and path escape instead of widening release scope', () => {
  for (const candidate of ['docs/readme.md', 'scripts/Publish-LocalEdge.ps1', 'backend/supabase/migrations/9999.sql', '../../secret']) {
    assert.throws(() => deriveRepairScope([candidate]), /does not own|escapes/u);
  }
});

test('local edge repair requires exact derived components and a bounded R2 profile', () => {
  assert.equal(validateLocalEdgeRepair(request()).releaseComponents[0], 'osaaGateway');
  assert.throws(() => validateLocalEdgeRepair(request({ affectedImages: ['opensphere-console'] })), /images differ/u);
  assert.throws(() => validateLocalEdgeRepair(request({ riskLevel: 'R3' })), /only reversible R2/u);
  assert.throws(() => validateLocalEdgeRepair(request({ requiredTests: ['supply-chain'] })), /not supported/u);
  assert.throws(() => validateLocalEdgeRepair(request({ releaseScope: 'integrated' })), /only localhost edge component/u);
  assert.throws(() => validateLocalEdgeRepair(request({
    affectedComponents: ['consoleBackend','osaaGateway'],
    affectedImages: ['opensphere-console-backend','opensphere-console-osaa-gateway'],
    patchArtifact: { changedFiles: ['apps/console-api/runtime/server.js','apps/osaa-gateway/server.js'] },
  })), /exactly one component/u);
});

test('sandbox root is request-scoped and cannot collapse to its parent', () => {
  const target = safeSandboxRoot('C:/temp/opensphere-repair', '11111111-1111-4111-8111-111111111111');
  assert.match(target.replace(/\\/g, '/'), /opensphere-repair\/11111111-1111-4111-8111-111111111111$/u);
  assert.throws(() => safeSandboxRoot('C:/temp/opensphere-repair', '..'), /request id/u);
});

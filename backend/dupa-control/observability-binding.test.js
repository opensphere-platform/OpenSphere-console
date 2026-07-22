const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bindingCapabilities, bindingConsumer, bindingContract, bindingPhase, safeBindingEndpoint } = require('./controller');

test('HIS Binding contract classifies the Console consumer without direct Prometheus discovery', () => {
  const binding = {
    metadata: { name: 'console', namespace: 'his', labels: { 'opensphere.io/consumer': 'opensphere-console' } },
    status: {
      phase: 'Connected', observedAt: '2026-07-22T00:00:00Z', capabilities: ['metrics', 'logs'],
      contract: { queryEndpoint: 'https://his-observability.example/api/v1', queryTemplates: { console_up: 'up{job="console"}' } },
    },
  };
  assert.deepEqual(bindingCapabilities(binding.status.capabilities), ['metrics', 'logs']);
  assert.equal(bindingConsumer(binding), 'opensphere-console');
  assert.equal(bindingPhase(binding), 'Connected');
  assert.equal(bindingContract(binding).endpoint, 'https://his-observability.example/api/v1');
  assert.equal(safeBindingEndpoint(bindingContract(binding).endpoint), 'https://his-observability.example/api/v1');
});

test('Console controller has no ServiceMonitor writer or direct Prometheus target/query path', () => {
  const source = fs.readFileSync(path.join(__dirname, 'controller.js'), 'utf8');
  const rbac = fs.readFileSync(path.join(__dirname, 'opensphere-console-dupa-controller.yaml'), 'utf8');
  assert.doesNotMatch(source, /function serviceMonitorManifest/);
  assert.doesNotMatch(source, /\/api\/v1\/targets/);
  assert.doesNotMatch(source, /function findMonSvc/);
  assert.doesNotMatch(rbac, /monitoring\.coreos\.com/);
  assert.doesNotMatch(rbac, /cluster-his-manager-v1/);
  assert.match(rbac, /resources: \[observabilitybindings\]/);
});

test('active Console sources do not retain CBS telemetry installers or namespace dependencies', () => {
  const platformRoot = path.resolve(__dirname, '..', '..');
  const activeRoots = ['deploy', 'backend', 'nginx', 'src', '.github'];
  const legacy = /opensphere-backbone|opensphere-cbs|BACKBONE_NS|backbone-rustfs|backbone-postgres|kind:\s*ServiceMonitor/i;
  const ignoredSegments = new Set(['archive', 'manual-seeds', 'node_modules', 'dist', '.git']);

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignoredSegments.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      } else if (entry.isFile() && !/\.test\.[cm]?[jt]s$/i.test(entry.name)) {
        assert.doesNotMatch(
          fs.readFileSync(target, 'utf8'),
          legacy,
          `legacy telemetry or CBS dependency remains in ${path.relative(platformRoot, target)}`,
        );
      }
    }
  }

  for (const root of activeRoots) visit(path.join(platformRoot, root));
});

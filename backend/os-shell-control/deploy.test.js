'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const source = fs.readFileSync(path.join(__dirname, 'deploy.yaml'), 'utf8');
const deployScript = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'Deploy-LocalEdgeOsShell.ps1'), 'utf8');
const backendServer = fs.readFileSync(path.join(__dirname, '..', 'opensphere-console-backend', 'server.js'), 'utf8');
const backendDeploy = fs.readFileSync(path.join(__dirname, '..', 'opensphere-console-backend', 'deploy.yaml'), 'utf8');
const canonicalConsoleNginx = fs.readFileSync(path.join(__dirname, '..', '..', 'nginx', 'default.conf.template'), 'utf8');
const docs = []; yaml.loadAll(source, (doc) => { if (doc) docs.push(doc); });
const find = (kind, name, namespace) => docs.find((doc) => doc.kind === kind && doc.metadata?.name === name && (!namespace || doc.metadata?.namespace === namespace));

test('local-edge deploy joins completed kubectl output instead of binding -join as a parameter', () => {
  assert.doesNotMatch(deployScript, /= \(Invoke-Kubectl[^\r\n]+ -join [^\r\n]+\) \| ConvertFrom-Json/);
  assert.doesNotMatch(deployScript, /"\$repository@\*"/);
  assert.equal((deployScript.match(/"\$\{repository\}@\*"/g) || []).length, 1);
  assert.match(deployScript, /containerStatuses \| Where-Object \{ \[string\]\$_[.]name -eq \$boundContainerName \}/);
  assert.doesNotMatch(deployScript, /\$statuses\[0\][.]image -ne \$Image/);
  assert.match(deployScript, /merge-base --is-ancestor/);
  assert.match(deployScript, /deploymentToolingAllowlist = @\(/);
  assert.match(deployScript, /deploymentToolingSourceRevision = \$deploymentToolingSourceRevision/g);
});

test('control workloads are distinct, exact-rendered, and default-off without Kubernetes token leakage', () => {
  for (const mode of ['api', 'gateway', 'reconciler']) {
    const deployment = find('Deployment', `opensphere-shell-${mode}`, 'opensphere-console');
    assert.equal(deployment.spec.replicas, 0); const spec = deployment.spec.template.spec;
    assert.equal(spec.serviceAccountName, `opensphere-shell-${mode}`);
    assert.equal(spec.automountServiceAccountToken, mode === 'reconciler');
    const env = Object.fromEntries(spec.containers[0].env.filter((entry) => 'value' in entry).map((entry) => [entry.name, entry.value]));
    assert.equal(env.OS_SHELL_CONTROL_ENABLED, 'false'); assert.equal(env.OS_SHELL_MODE, mode);
    assert.equal(spec.containers[0].image, '__OPENSPHERE_OS_SHELL_CONTROL_IMAGE__');
    assert.equal(env.OS_SHELL_RUNTIME_IMAGE, '__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__');
  }
  assert.equal((source.match(/__OPENSPHERE_OS_SHELL_CONTROL_IMAGE__/g) || []).length, 3);
  assert.equal((source.match(/__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__/g) || []).length, 3);
  const consoleApi = find('Deployment', 'opensphere-shell-console-api', 'opensphere-console');
  assert.equal(consoleApi.spec.replicas, 0);
  assert.equal(consoleApi.spec.template.spec.automountServiceAccountToken, false);
  const consoleContainer = consoleApi.spec.template.spec.containers[0];
  assert.equal(consoleContainer.image, '__OPENSPHERE_CONSOLE_IMAGE__');
  assert.equal(consoleContainer.securityContext.readOnlyRootFilesystem, true);
  assert.ok(consoleContainer.volumeMounts.some((mount) => mount.name === 'nginx-conf' && mount.mountPath === '/etc/nginx/conf.d'));
  assert.ok(consoleContainer.volumeMounts.some((mount) => mount.name === 'nginx-tmp' && mount.mountPath === '/tmp'));
  assert.equal((source.match(/__OPENSPHERE_CONSOLE_IMAGE__/g) || []).length, 1);
});

test('reconciler RBAC is Pod lifecycle plus TokenReview only and runtime has zero bindings', () => {
  const role = find('Role', 'opensphere-shell-reconciler', 'opensphere-shell-sessions');
  assert.deepEqual(role.rules, [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch', 'create', 'delete'] }]);
  const clusterRole = find('ClusterRole', 'opensphere-shell-runtime-token-reviewer');
  assert.deepEqual(clusterRole.rules, [{ apiGroups: ['authentication.k8s.io'], resources: ['tokenreviews'], verbs: ['create'] }]);
  assert.equal(source.includes('pods/exec'), false); assert.equal(source.includes('secrets"]'), false);
  const runtimeSubjects = docs.filter((doc) => /RoleBinding$/.test(doc.kind || '')).flatMap((doc) => doc.subjects || [])
    .filter((subject) => subject.name === 'opensphere-shell-runtime');
  assert.equal(runtimeSubjects.length, 0);
});

test('TLS services and leaves are separated across API, registration, credential mint and canonical Console frontdoor', () => {
  assert.ok(find('Service', 'opensphere-shell-api', 'opensphere-console').spec.ports.some((port) => port.port === 8443));
  assert.ok(find('Service', 'opensphere-shell-reconciler', 'opensphere-console').spec.ports.some((port) => port.port === 8443));
  assert.ok(find('Service', 'opensphere-shell-reconciler', 'opensphere-console').spec.ports.some((port) => port.port === 8080));
  assert.equal(find('Service', 'opensphere-shell-gateway', 'opensphere-console').spec.ports[0].port, 8080);
  assert.equal(find('Service', 'opensphere-shell-credential-authority', 'opensphere-console').spec.ports[0].port, 8444);
  const consoleApi = find('Service', 'opensphere-shell-console-api', 'opensphere-console');
  assert.equal(consoleApi.spec.ports[0].port, 8445);
  assert.equal(consoleApi.spec.ports[0].targetPort, 'console-api-tls');
  assert.deepEqual(consoleApi.spec.selector, { app: 'opensphere-shell-console-api' });
  assert.match(source, /opensphere-shell-api-tls/); assert.match(source, /opensphere-shell-reconciler-tls/);
  assert.match(source, /opensphere-shell-credential-authority-tls/);
  assert.match(source, /opensphere-shell-console-api-tls/);
  assert.match(source, /opensphere-shell-control-ca/);
});

test('local-edge activation patches and verifies the Setup-owned Backend credential authority before control rollout', () => {
  assert.match(deployScript, /function Set-BackendOsShellActivation/);
  assert.match(deployScript, /Set-BackendOsShellActivation -Image \$backend[.]image/);
  assert.match(deployScript, /OS_SHELL_CREDENTIAL_AUTHORITY_ENABLED'; value = 'true'/);
  assert.match(deployScript, /OS_SHELL_ADMISSION_ENABLED'; value = 'true'/);
  assert.match(deployScript, /shell-cred-tls'; containerPort = 8444/);
  assert.match(backendDeploy, /name: shell-cred-tls, containerPort: 8444/);
  assert.ok('shell-cred-tls'.length <= 15, 'Kubernetes container port names are limited to 15 characters');
  assert.match(deployScript, /secretName = 'opensphere-shell-credential-authority-tls'; optional = \$false/);
  assert.match(backendServer, /req[.]method === 'GET' && req[.]url === '\/readyz'/);
  assert.match(backendServer, /service: 'opensphere-shell-credential-authority'/);
});

test('NetworkPolicy peers are exact and runtime egress uses post-DNAT target ports', () => {
  const runtime = find('NetworkPolicy', 'opensphere-shell-runtime-closed-network', 'opensphere-shell-sessions');
  assert.deepEqual(runtime.spec.egress[0], {
    to: [{
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'opensphere-console' } },
      podSelector: { matchExpressions: [{ key: 'app', operator: 'In', values: ['opensphere-shell-api', 'opensphere-shell-reconciler'] }] },
    }],
    ports: [{ protocol: 'TCP', port: 8443 }],
  });
  assert.deepEqual(runtime.spec.egress[1], {
    to: [{
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'opensphere-console' } },
      podSelector: { matchLabels: { app: 'opensphere-shell-console-api' } },
    }],
    ports: [{ protocol: 'TCP', port: 8443 }],
  });
  const consoleIngress = find('NetworkPolicy', 'opensphere-shell-console-api-ingress', 'opensphere-console');
  assert.deepEqual(consoleIngress.spec.ingress[0], {
    from: [{
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'opensphere-shell-sessions' } },
      podSelector: { matchLabels: { app: 'opensphere-os-shell-runtime' } },
    }],
    ports: [{ protocol: 'TCP', port: 8443 }],
  });
  assert.deepEqual(consoleIngress.spec.ingress[1], {
    from: [{ podSelector: { matchLabels: { app: 'opensphere-shell-api' } } }],
    ports: [{ protocol: 'TCP', port: 8443 }],
  });
  const consoleEgress = find('NetworkPolicy', 'opensphere-shell-console-api-egress', 'opensphere-console');
  assert.deepEqual(consoleEgress.spec.egress[0], {
    to: [{ podSelector: {} }], ports: [{ protocol: 'TCP', port: 8080 }],
  });
  const apiEgress = find('NetworkPolicy', 'opensphere-shell-api-egress', 'opensphere-console');
  assert.deepEqual(apiEgress.spec.egress[0], {
    to: [{ podSelector: { matchLabels: { app: 'opensphere-console-backend' } } }],
    ports: [{ protocol: 'TCP', port: 8444 }],
  });
  assert.deepEqual(apiEgress.spec.egress[1], {
    to: [{ podSelector: { matchExpressions: [{ key: 'app', operator: 'In', values: ['opensphere-shell-gateway', 'opensphere-shell-reconciler'] }] } }],
    ports: [{ protocol: 'TCP', port: 8080 }],
  });
  assert.deepEqual(apiEgress.spec.egress[2], {
    to: [{ podSelector: { matchLabels: { app: 'opensphere-shell-console-api' } } }],
    ports: [{ protocol: 'TCP', port: 8443 }],
  });
  const gatewayIngress = find('NetworkPolicy', 'opensphere-shell-gateway-ingress', 'opensphere-console');
  assert.deepEqual(gatewayIngress.spec.ingress[1], {
    from: [{ podSelector: { matchLabels: { app: 'opensphere-shell-api' } } }],
    ports: [{ protocol: 'TCP', port: 8080 }],
  });
  const reconcilerIngress = find('NetworkPolicy', 'opensphere-shell-reconciler-ingress', 'opensphere-console');
  assert.deepEqual(reconcilerIngress.spec.ingress[1], {
    from: [{ podSelector: { matchLabels: { app: 'opensphere-shell-api' } } }],
    ports: [{ protocol: 'TCP', port: 8080 }],
  });
  const gatewayEgress = find('NetworkPolicy', 'opensphere-shell-gateway-egress', 'opensphere-console');
  assert.deepEqual(gatewayEgress.spec.egress[0], {
    to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'opensphere-shell-sessions' } },
      podSelector: { matchLabels: { app: 'opensphere-os-shell-runtime' } } }],
    ports: [{ protocol: 'TCP', port: 8443 }],
  });
});

test('internal Console API uses the canonical data-driven Registry and plugin/PFSS frontdoor instead of a copied router', () => {
  const deployment = find('Deployment', 'opensphere-shell-console-api', 'opensphere-console');
  assert.equal(deployment.spec.template.spec.containers[0].name, 'console-frontdoor');
  assert.equal(deployment.spec.template.spec.containers[0].image, '__OPENSPHERE_CONSOLE_IMAGE__');
  assert.match(canonicalConsoleNginx, /location \/api\/v1\/registry/);
  assert.match(canonicalConsoleNginx, /location \/api\/proxy\//);
  assert.match(canonicalConsoleNginx, /location \/api\/identity/);
  assert.match(canonicalConsoleNginx, /location ~ \^\/api\/plugins\/\(\[a-z0-9-\]\+\)\/\(\.\*\)\$/);
  assert.match(canonicalConsoleNginx, /auth_request \/_plugin_authz/);
  assert.match(canonicalConsoleNginx, /proxy_set_header Authorization \$plugin_authorization/);
  assert.equal(source.includes('DUPA_CONTROL_URL'), false);
});

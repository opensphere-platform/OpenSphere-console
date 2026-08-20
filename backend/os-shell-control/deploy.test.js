'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const yaml = require('js-yaml');

const source = fs.readFileSync(path.join(__dirname, 'deploy.yaml'), 'utf8');
const deployScript = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'Deploy-LocalEdgeOsShell.ps1'), 'utf8');
const featureOperationScript = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'Invoke-OsShellFeatureOperation.ps1'), 'utf8');
const edgeSigning = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'os-shell-edge-signing.ps1'), 'utf8');
const publisher = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'Publish-LocalEdge.ps1'), 'utf8');
const admissionHarness = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'Test-OsShellRuntimeAdmission.ps1'), 'utf8');
const backendServer = fs.readFileSync(path.join(__dirname, '..', 'opensphere-console-backend', 'server.js'), 'utf8');
const backendDeploy = fs.readFileSync(path.join(__dirname, '..', 'opensphere-console-backend', 'deploy.yaml'), 'utf8');
const canonicalConsoleNginx = fs.readFileSync(path.join(__dirname, '..', '..', 'nginx', 'default.conf.template'), 'utf8');
const runtimeDockerfile = fs.readFileSync(path.join(__dirname, '..', 'os-cli', 'Dockerfile.runtime'), 'utf8');
const cliDockerfile = fs.readFileSync(path.join(__dirname, '..', 'os-cli', 'Dockerfile'), 'utf8');
const docs = []; yaml.loadAll(source, (doc) => { if (doc) docs.push(doc); });
const find = (kind, name, namespace) => docs.find((doc) => doc.kind === kind && doc.metadata?.name === name && (!namespace || doc.metadata?.namespace === namespace));

test('edge signing fails at the declared pwsh 7.2 boundary before Windows PowerShell crypto APIs run', { skip: process.platform !== 'win32' }, () => {
  const script = path.join(__dirname, '..', '..', 'scripts', 'Test-OsShellEdgeSigning.ps1');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /7[.]2/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ExportPkcs8PrivateKeyPem|ECDsaCng/);
});

test('local-edge deploy joins completed kubectl output instead of binding -join as a parameter', () => {
  assert.doesNotMatch(deployScript, /= \(Invoke-Kubectl[^\r\n]+ -join [^\r\n]+\) \| ConvertFrom-Json/);
  assert.doesNotMatch(deployScript, /"\$repository@\*"/);
  assert.equal((deployScript.match(/"\$\{repository\}@\*"/g) || []).length, 1);
  assert.match(deployScript, /containerStatuses \| Where-Object \{ \[string\]\$_[.]name -eq \$boundContainerName \}/);
  assert.doesNotMatch(deployScript, /\$statuses\[0\][.]image -ne \$Image/);
  assert.match(deployScript, /PSObject[.]Properties\['serviceAccountName'\]/);
  assert.equal((deployScript.match(/PSObject[.]Properties\['deletionTimestamp'\]/g) || []).length, 2);
  assert.match(deployScript, /\$sarExitCode -notin @\(0, 1\)/);
  assert.match(deployScript, /answer=\$answer exit=\$sarExitCode/);
  assert.match(deployScript, /\$arguments \+= @\('--subresource', \[string\]\$resourceParts\[1\]\)/);
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
    assert.equal(env.OS_SHELL_RUNTIME_MAX_PROCESSES, '256');
    assert.equal(env.OS_SHELL_RUNTIME_GLOBAL_POD_LIMIT, '8');
  }
  assert.equal((source.match(/__OPENSPHERE_OS_SHELL_CONTROL_IMAGE__/g) || []).length, 3);
  assert.equal((source.match(/__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__/g) || []).length, 4);
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

test('session namespace has a global resource budget and exact runtime template admission boundary', () => {
  const quota = find('ResourceQuota', 'opensphere-shell-runtime-budget', 'opensphere-shell-sessions');
  assert.deepEqual(quota.spec.hard, {
    pods: '8', 'requests.cpu': '400m', 'requests.memory': '512Mi', 'requests.ephemeral-storage': '256Mi',
    'limits.cpu': '8', 'limits.memory': '3Gi', 'limits.ephemeral-storage': '1536Mi',
  });
  const range = find('LimitRange', 'opensphere-shell-runtime-container-limits', 'opensphere-shell-sessions');
  assert.equal(range.spec.limits[0].max['ephemeral-storage'], '128Mi');
  const policy = find('ValidatingAdmissionPolicy', 'opensphere-shell-runtime-template-v1');
  const binding = find('ValidatingAdmissionPolicyBinding', 'opensphere-shell-runtime-template-v1');
  assert.equal(policy.spec.failurePolicy, 'Fail');
  assert.equal(policy.metadata.annotations['opensphere.io/admission-contract'], 'opensphere-shell-runtime-template-v1');
  const expressionSet = policy.spec.validations.map((entry) => entry.expression).join('\n\x1e\n');
  assert.equal(`sha256:${require('node:crypto').createHash('sha256').update(expressionSet).digest('hex')}`,
    policy.metadata.annotations['opensphere.io/expression-set-sha256']);
  assert.deepEqual(policy.spec.matchConstraints.resourceRules[0].operations, ['CREATE', 'UPDATE']);
  assert.deepEqual(policy.spec.matchConstraints.resourceRules[0].resources, ['pods']);
  assert.deepEqual(policy.spec.matchConstraints.resourceRules[1], {
    apiGroups: [''], apiVersions: ['v1'], operations: ['UPDATE'],
    resources: ['pods/ephemeralcontainers', 'pods/resize'], scope: 'Namespaced',
  });
  assert.deepEqual(binding.spec.validationActions, ['Deny']);
  assert.deepEqual(binding.spec.matchResources.namespaceSelector.matchLabels, { 'opensphere.io/scope': 'ephemeral-shell-runtime' });
  const expressions = policy.spec.validations.map((entry) => entry.expression).join('\n');
  for (const required of ['opensphere-shell-reconciler', 'opensphere-shell-runtime', '__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__',
    "containers.size() == 2", "c.args[0] == 'pty'", "c.args[0] == 'agent'", "object.spec.volumes.size() == 5",
    "OPENSPHERE_SHELL_NETWORK_PROFILE", "OPENSPHERE_SHELL_MAX_PROCESSES", "runtimeClassName", "nodeSelector",
    "metadata.name == 'os-shell-'", 'metadata.generateName']) {
    assert.match(expressions, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const scheduling = policy.spec.validations.find((entry) =>
    entry.message === 'runtime Pod scheduling, service account, and host boundary are immutable').expression;
  for (const required of [
    'object.spec.tolerations.size() == 2',
    "t.key == 'node.kubernetes.io/not-ready'",
    "t.key == 'node.kubernetes.io/unreachable'",
    "t.operator == 'Exists'",
    "t.effect == 'NoExecute'",
    't.tolerationSeconds == 300',
    "(!has(t.value) || t.value == '')",
    'has(object.spec.hostUsers)',
    'object.spec.hostUsers == false',
  ]) assert.match(scheduling, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(scheduling, /tolerations[.]size[(][)] == 0/);

  const exactDefaultTolerations = [
    { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 },
    { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 },
  ];
  const accepted = (items) => items.length === 2 && items.every((item) =>
    ['node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable'].includes(item.key)
      && item.operator === 'Exists' && item.effect === 'NoExecute' && item.tolerationSeconds === 300
      && (!Object.hasOwn(item, 'value') || item.value === ''))
    && exactDefaultTolerations.every((expected) => items.some((item) => item.key === expected.key));
  assert.equal(accepted(exactDefaultTolerations), true);
  for (const mutated of [
    [],
    [exactDefaultTolerations[0], exactDefaultTolerations[0]],
    [...exactDefaultTolerations, { key: 'attacker', operator: 'Exists', effect: 'NoSchedule' }],
    [{ ...exactDefaultTolerations[0], operator: 'Equal' }, exactDefaultTolerations[1]],
    [{ ...exactDefaultTolerations[0], effect: 'NoSchedule' }, exactDefaultTolerations[1]],
    [{ ...exactDefaultTolerations[0], tolerationSeconds: 301 }, exactDefaultTolerations[1]],
    [{ ...exactDefaultTolerations[0], value: 'attacker' }, exactDefaultTolerations[1]],
  ]) assert.equal(accepted(mutated), false);
  assert.match(admissionHarness, /\$runtimeClassName = 'opensphere-shell-admission-' \+ \(\[guid\]::NewGuid\(\)/);
  assert.match(admissionHarness, /get runtimeclass \$runtimeClassName --ignore-not-found -o name/);
  assert.match(admissionHarness, /apiVersion = 'node[.]k8s[.]io\/v1'/);
  assert.match(admissionHarness, /handler = 'runc'/);
  assert.match(admissionHarness, /runtimeClassName -NotePropertyValue \$runtimeClassName/);
  assert.match(admissionHarness, /finally \{[\s\S]*metadata[.]uid -ne \$runtimeClassCreatedUid[\s\S]*delete runtimeclass \$runtimeClassName --wait=true[\s\S]*cleanup did not converge to zero/);
  assert.doesNotMatch(admissionHarness, /NotePropertyValue 'attacker-runtime'/);
  assert.match(admissionHarness, /PSObject[.]Properties\['ephemeralContainers'\]/);
  assert.match(admissionHarness, /Name = 'host-users-absent'/);
  assert.match(admissionHarness, /Name = 'host-users-true'/);
  assert.match(admissionHarness, /HostUsersFalsePtyStarted/);
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
  const runtimeServiceAccount = find('ServiceAccount', 'opensphere-shell-runtime', 'opensphere-shell-sessions');
  assert.equal(runtimeServiceAccount.automountServiceAccountToken, false);
  assert.deepEqual(runtimeServiceAccount.imagePullSecrets, [{ name: 'opensphere-ghcr-pull' }]);
  assert.match(deployScript, /function Ensure-SessionRegistryPullSecret/);
  assert.match(deployScript, /kubernetes[.]io\/dockerconfigjson/);
  assert.match(deployScript, /registryPullSecret = "\$SessionNamespace\/\$registryPullSecret"/);
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

test('local-edge deploy binds every component-only override through exact source closures', async () => {
  assert.match(deployScript, /\[string\]\$RuntimePublicationEvidence = ''/);
  assert.match(deployScript, /\[string\]\$BackendPublicationEvidence = ''/);
  assert.match(deployScript, /\[string\]\$ConsolePublicationEvidence = ''/);
  assert.match(deployScript, /\[string\]\$ControlPublicationEvidence = ''/);
  assert.match(deployScript, /Runtime override requires exactly osShellRuntime/);
  assert.match(deployScript, /Backend override requires exactly backend/);
  assert.match(deployScript, /Console override requires exactly console/);
  assert.match(deployScript, /Control override requires exactly osShellControl/);
  assert.match(deployScript, /Runtime override changes the base Supabase migration lineage/);
  assert.match(deployScript, /Backend override changes the base Supabase migration lineage/);
  assert.match(deployScript, /Console override changes the base Supabase migration lineage/);
  assert.match(deployScript, /Control override changes the base Supabase migration lineage/);
  assert.match(deployScript, /os-shell-runtime-override-boundary[.]mjs/);
  assert.match(deployScript, /'--base',\s*\r?\n?\s*\(\[string\]\$evidence[.]sourceRevision\)/);
  assert.match(deployScript, /@\('--runtime', \(\[string\]\$runtimeEvidence[.]sourceRevision\)\)/);
  assert.match(deployScript, /@\('--backend', \(\[string\]\$backendEvidence[.]sourceRevision\)\)/);
  assert.match(deployScript, /@\('--console', \(\[string\]\$consoleEvidence[.]sourceRevision\)\)/);
  assert.match(deployScript, /@\('--control', \(\[string\]\$controlEvidence[.]sourceRevision\)\)/);
  assert.match(deployScript, /https:\/\/github[.]com\/opensphere-platform\/OpenSphere-console[.]git/);
  assert.match(deployScript, /fetch --quiet --prune origin/);
  assert.match(deployScript, /deploymentToolingSha256 = \$deploymentToolingEvidence/);
  assert.match(deployScript, /release:\/\/edge-composite\//);
  assert.match(deployScript, /runtimePublicationEvidence = \$runtimePublicationPath/);
  assert.match(deployScript, /backendPublicationEvidence = \$backendPublicationPath/);
  assert.match(deployScript, /consolePublicationEvidence = \$consolePublicationPath/);
  assert.match(deployScript, /controlPublicationEvidence = \$controlPublicationPath/);
  assert.match(deployScript, /backend = \[string\]\$backendEvidence[.]sourceRevision/);
  assert.match(deployScript, /console = \[string\]\$consoleEvidence[.]sourceRevision/);
  assert.match(deployScript, /osShellControl = \[string\]\$controlEvidence[.]sourceRevision/);
  assert.match(deployScript, /\$effectiveRuntimeSourceRevision = if \(\$CliRuntimePublicationEvidence\)/);
  assert.match(deployScript, /osShellRuntime = \$effectiveRuntimeSourceRevision/);
  assert.match(deployScript, /CLI\/runtime override session policy revision differs from the canonical base publication/);
  assert.match(deployScript, /cliRuntimePublicationEvidence = \$cliRuntimePublicationPath/);
  assert.match(deployScript, /Set-BackendOsShellActivation -Image \$backend[.]image -SourceRevision \(\[string\]\$backendEvidence[.]sourceRevision\)/);
  assert.match(deployScript, /Assert-PrerequisiteDeployment -Deployment 'opensphere-console-backend'[\s\S]*?-SourceRevision \(\[string\]\$backendEvidence[.]sourceRevision\)/);
  assert.match(deployScript, /Assert-ImageMetadata -Repository \$consoleRepository[\s\S]*?-SourceRevision \$consoleEvidence[.]sourceRevision/);
  assert.match(deployScript, /Assert-PrerequisiteDeployment -Deployment 'opensphere-console'[\s\S]*?-SourceRevision \(\[string\]\$consoleEvidence[.]sourceRevision\)/);
  assert.match(deployScript, /Set-ConsoleApiActivation -SourceRevision \(\[string\]\$consoleEvidence[.]sourceRevision\)/);
  assert.match(deployScript, /consoleSha256 = if \(\$consolePublicationPath\)/);
  const featureEvidenceBlock = /\$featureOperationEvidence = \[ordered\]@\{([\s\S]*?)\r?\n\}/.exec(deployScript)?.[1] || '';
  assert.doesNotMatch(featureEvidenceBlock, /consolePublicationSha256|backendPublicationSha256/);
  assert.match(featureEvidenceBlock, /publicationSha256 = Get-FileSha256 -Path \$publicationPath/);
  assert.match(deployScript, /backendOverrideBoundary = \$backendBoundaryEvidence/);
  assert.match(deployScript, /consoleOverrideBoundary = \$consoleBoundaryEvidence/);
  assert.match(deployScript, /controlOverrideBoundary = \$controlBoundaryEvidence/);
  assert.match(deployScript, /\$controlEvidence[.]artifacts[.]osShellControlRelease/);
  assert.match(deployScript, /userNamespacePolicy -ne \$runtimeUserNamespacePolicy/);
  const toolingBlock = /\$deploymentToolingAllowlist = @\(([\s\S]*?)\r?\n\)/.exec(deployScript)?.[1] || '';
  assert.doesNotMatch(toolingBlock, /backend[\\/]opensphere-console-backend[\\/](Dockerfile|local-edge-automation-token[.]test[.]js)/);
  const boundary = await import(pathToFileURL(path.join(__dirname, '..', '..', 'scripts', 'os-shell-runtime-override-boundary.mjs')).href);
  const declaredToolingPaths = [...toolingBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(declaredToolingPaths, [...boundary.deploymentToolingPaths,
    'scripts/Publish-LocalEdgeOsShellArtifacts.ps1', 'scripts/local-edge-publication-core.psm1'].sort());
  assert.ok(declaredToolingPaths.includes('scripts/Invoke-OsShellFeatureOperation.ps1'));
  const runtimePaths = ['backend/os-cli/cmd/os-shell-runtime/agent.go', 'backend/os-cli/Dockerfile.runtime'];
  const backendPaths = [
    'backend/opensphere-console-backend/Dockerfile',
    'backend/opensphere-console-backend/local-edge-automation-token.test.js',
  ];
  const consolePaths = ['nginx/default.conf.template', 'scripts/os-shell-frontend-contract.test.mjs'];
  const controlPaths = [
    'backend/os-shell-control/runtime-template.js', 'backend/os-shell-control/runtime-template.test.js',
    'backend/os-shell-control/server.js', 'backend/os-shell-control/server.test.js',
  ];
  assert.doesNotThrow(() => boundary.assertRuntimeOverridePaths(runtimePaths));
  assert.doesNotThrow(() => boundary.assertBackendOverridePaths(backendPaths));
  assert.doesNotThrow(() => boundary.assertConsoleOverridePaths(consolePaths));
  assert.doesNotThrow(() => boundary.assertControlOverridePaths(controlPaths));
  for (const privilegedPath of ['backend/supabase/migrate-only.ps1', 'backend/os-shell-control/deploy.yaml', 'backend/os-cli/cmd/os/operator.go', 'backend/os-cli/cmd/os/web_shell_agent.go']) {
    assert.throws(() => boundary.assertRuntimeOverridePaths([...runtimePaths, privilegedPath]), /non-runtime authority/);
    assert.throws(() => boundary.assertBackendOverridePaths([...backendPaths, privilegedPath]), /exact closed set/);
    assert.throws(() => boundary.assertConsoleOverridePaths([...consolePaths, privilegedPath]), /exact closed set/);
    assert.throws(() => boundary.assertControlOverridePaths([...controlPaths, privilegedPath]), /exact closed set/);
  }
  assert.throws(() => boundary.assertHeadPaths([...runtimePaths, 'backend/supabase/migrate-only.ps1'], runtimePaths), /unbound source/);
  assert.throws(() => boundary.assertHeadPaths([...backendPaths, ...consolePaths], backendPaths), /unbound source/);
  for (const escape of ['../Dockerfile', '/tmp/Dockerfile', 'C:/tmp/Dockerfile', 'backend\\opensphere-console-backend\\Dockerfile']) {
    assert.throws(() => boundary.assertBackendOverridePaths([escape, backendPaths[1]]), /canonical repository|exact closed set/);
  }
  assert.match(featureOperationScript, /\[string\]\$ConsolePublicationEvidence = ''/);
  assert.match(featureOperationScript, /'-ConsolePublicationEvidence',\$ConsolePublicationEvidence/);
  assert.match(featureOperationScript, /'-ControlPublicationEvidence',\$ControlPublicationEvidence/);
  assert.match(publisher, /\$releaseArtifacts\['osShellControlRelease'\]/);
  assert.match(publisher, /userNamespacePolicy = 'required-hostUsers-false'/);
  assert.match(publisher, /linux-userns\+rlimit-nproc\+namespace-resourcequota/);
  assert.match(deployScript, /userNamespacePolicy = \$runtimeUserNamespacePolicy/);
  assert.match(deployScript, /linux-userns\+rlimit-nproc\+namespace-resourcequota/);
  assert.doesNotMatch(publisher, /linux-rlimit-nproc-fixed-uid\+namespace-resourcequota/);
  assert.doesNotMatch(deployScript, /linux-rlimit-nproc-fixed-uid\+namespace-resourcequota/);
  const cliBuildProjection = (source, output) => {
    const match = source.match(/CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="([^"]+)" -o \/out\/[^ ]+ \.\/cmd\/os(?=\s|$)/);
    assert.ok(match, `missing canonical linux/amd64 CLI build projection for ${output}`);
    return `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="${match[1]}" -o ${output} ./cmd/os`;
  };
  const canonicalCliBuild = cliBuildProjection(cliDockerfile, '<cli-output>');
  const assertExactCliBuildProjection = (source) => assert.equal(cliBuildProjection(source, '<cli-output>'), canonicalCliBuild);
  assertExactCliBuildProjection(runtimeDockerfile);
  const runtimeCliBuild = cliBuildProjection(runtimeDockerfile, '<cli-output>');
  assert.doesNotMatch(runtimeCliBuild, /webShellAgent(Socket|PublicKey)Path/);
  assert.throws(() => assertExactCliBuildProjection(runtimeDockerfile.replace(
    'main.version=0.8.2', 'main.version=0.8.2 -X main.webShellAgentSocketPath=/tmp/forged.sock',
  )), assert.AssertionError);
});

test('0062 owner operation is projected-SA, bidirectional, signed-intent-first and has no argv browser credential', () => {
  assert.doesNotMatch(featureOperationScript, /BrowserCookie|CsrfToken|Cookie\s*=/i);
  assert.match(featureOperationScript, /create','token','opensphere-local-edge-release'/);
  assert.match(featureOperationScript, /--audience','opensphere-local-edge-release','--duration','10m'/);
  assert.match(featureOperationScript, /Test-OsShellEdgeSignedDocument/);
  assert.match(featureOperationScript, /activeTickets/);
  assert.match(featureOperationScript, /runtimePods=0/);
  assert.match(featureOperationScript, /'app=opensphere-os-shell-runtime'/);
  assert.ok(featureOperationScript.indexOf("'app=opensphere-os-shell-runtime'") < featureOperationScript.indexOf("'scale',\"deployment/$deployment\""));
  assert.match(featureOperationScript, /Deploy-LocalEdgeOsShell[.]ps1/);
  assert.match(featureOperationScript, /'scale',"deployment\/\$deployment",'--replicas=0'/);
  assert.match(featureOperationScript, /#requires -Version 7[.]2/);
  assert.match(deployScript, /#requires -Version 7[.]2/);
  assert.match(edgeSigning, /#requires -Version 7[.]2/);
  assert.match(featureOperationScript, /Invoke-ScaleDownFence -Action Claim/);
  assert.match(featureOperationScript, /Invoke-ScaleDownFence -Action Complete/);
  assert.match(featureOperationScript, /\$alreadyCompleted = \[string\]\$operationResult[.]state[.]operationPhase -eq 'Completed'/);
  assert.match(featureOperationScript, /if \(-not \$alreadyCompleted\) \{[\s\S]*Invoke-ScaleDownFence -Action Claim/);
  assert.match(featureOperationScript, /completedAt=\[string\]\$operationResult[.]state[.]operationCompletedAt/);
  assert.match(featureOperationScript, /RecoverySignedProfile/);
  assert.match(featureOperationScript, /RecoverySignature/);
  assert.ok(featureOperationScript.indexOf('Invoke-ScaleDownFence -Action Claim')
    < featureOperationScript.indexOf("'scale',\"deployment/$deployment\""));
  assert.match(featureOperationScript, /operationPhase='Completed'/);
  assert.match(deployScript, /0062_shell_session_quota_and_kill_switch[.]sql/);
  assert.match(deployScript, /latestMigrationId -ne '0062'/);
  assert.ok(deployScript.indexOf('New-OsShellEdgeSignedDocument') < deployScript.indexOf('Invoke-LocalEdgeShellFeatureOperation -Enabled $true'));
  assert.match(deployScript, /Invoke-OsShellFeatureOperation[.]ps1'\) -Operation Disable/);
  assert.match(deployScript, /-RecoverySignedProfile \$profilePath -RecoverySignature \$signaturePath/);
  assert.match(deployScript, /activation-failure-disable[.]json/);
  assert.match(deployScript, /releaseIntentSignatureSha256/);
  assert.match(deployScript, /publicationEvidence = \[ordered\]@\{/);
  assert.match(featureOperationScript, /Disable publication evidence is not bound by the trusted signed ReleaseIntent/);
  assert.match(deployScript, /profileId = 'os-shell-full-page-operator-local-edge\/v1'/);
  assert.match(deployScript, /result = 'NOT_EXECUTED'/);
  assert.match(deployScript, /manifestDigest = \$applicableEvidenceSetDigest/);
  assert.match(deployScript, /plan011CompletionClaim = \$false/);
  assert.match(edgeSigning, /IeeeP1363FixedFieldConcatenation/);
  assert.match(edgeSigning, /ACL inheritance must be disabled/);
  assert.match(edgeSigning, /single unencrypted PKCS8 P-256 key/);
  assert.match(publisher, /maxProcesses\s*=\s*256/);
  assert.match(publisher, /globalPodLimit\s*=\s*8/);
  assert.match(admissionHarness, /--subresource=ephemeralcontainers/);
  assert.match(admissionHarness, /--subresource=resize/);
  assert.match(admissionHarness, /--as-group system:masters/);
  assert.match(admissionHarness, /^#requires -Version 7[.]2/);
  assert.match(admissionHarness, /opensphere-shell-runtime-template-v1/);
  assert.match(backendServer, /validateLocalEdgeAutomationTokenClaims/);
  assert.match(backendServer, /ShellFeatureBrowserEnableRequiresVerifiedRelease/);
  assert.match(backendServer, /signed local-edge release owner after exact migration, component, and readiness verification/);
  assert.match(backendServer, /scale-down-claim/);
  assert.match(backendServer, /scale-down-complete/);
});

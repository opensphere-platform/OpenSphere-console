'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const here = __dirname;
const deploySource = fs.readFileSync(path.join(here, 'deploy.yaml'), 'utf8');
const serverSource = fs.readFileSync(path.join(here, 'server.js'), 'utf8');
const documents = [];
yaml.loadAll(deploySource, (document) => { if (document) documents.push(document); });
const find = (kind, name) => documents.find((item) => item.kind === kind && item.metadata?.name === name);
const policyExpression = (name) => find('ValidatingAdmissionPolicy', name)
  .spec.validations.map((entry) => entry.expression).join('\n');

test('cluster-admin executor image and Pod identity are bound to the exact reconciler Deployment', () => {
  const deployment = find('Deployment', 'platform-release-reconciler');
  const image = deployment.spec.template.spec.containers[0].image;
  assert.match(image,
    /^ghcr\.io\/opensphere-platform\/opensphere-console-backend@sha256:[a-f0-9]{64}$/);
  assert.equal(deployment.spec.template.spec.containers[0].env
    .find((entry) => entry.name === 'EXECUTOR_IMAGE').value, image);

  for (const kind of ['job', 'pod']) {
    const name = `platform-release-executor-${kind}-boundary`;
    const policy = find('ValidatingAdmissionPolicy', name);
    const binding = find('ValidatingAdmissionPolicyBinding', name);
    assert.deepEqual(policy.spec.paramKind, { apiVersion: 'apps/v1', kind: 'Deployment' });
    assert.equal(binding.spec.paramRef.name, 'platform-release-reconciler');
    assert.equal(binding.spec.paramRef.namespace, 'opensphere-console');
    assert.equal(binding.spec.paramRef.parameterNotFoundAction, 'Deny');
    const expression = policyExpression(name);
    assert.match(expression, /params\.metadata\.name == 'platform-release-reconciler'/);
    assert.match(expression,
      /containers\[0\]\.image(?:\s+)?== params\.spec\.template\.spec\.containers\[0\]\.image/);
    assert.match(expression, /automountServiceAccountToken == false/);
    assert.match(expression, /initContainers/);
    assert.match(expression, /ephemeralContainers/);
    assert.match(expression, /hostNetwork/);
    assert.match(expression, /hostPID/);
    assert.match(expression, /hostIPC/);
    assert.match(expression, /env\.map\(e, e\.name\) ==/);
    assert.match(expression, /size\(object\.spec(?:\.template\.spec)?\.volumes\) == 5/);
    assert.match(expression, /opensphere-platform-release-control-ca/);
    assert.doesNotMatch(expression, /GITEA_TOKEN|CONSOLE_BACKEND_URL|GITEA_URL/);
    assert.match(expression, /opensphere-console-platform-release/);
    assert.match(expression, /EXPECTED_PREVIOUS_RELEASE_DIGEST/);
    assert.match(expression, /resources\.limits == \{'cpu':'2','memory':'1Gi'\}/);
  }
});

test('reserved Job and Pod names, labels and service accounts cannot bypass the exact branch', () => {
  const job = policyExpression('platform-release-executor-job-boundary');
  const pod = policyExpression('platform-release-executor-pod-boundary');
  const exact = (expression) => expression.slice(expression.indexOf(') || ('));
  const reservation = (expression) => expression.slice(0, expression.indexOf(') || ('));

  for (const expression of [job, pod]) {
    assert.match(reservation(expression), /serviceAccountName == 'platform-release-executor'/);
    assert.match(reservation(expression), /metadata\.name\.startsWith\('platform-release-'\)/);
    assert.match(reservation(expression), /metadata\.labels\['app'\] == 'platform-release-executor'/);
    assert.match(exact(expression), /serviceAccountName == 'platform-release-executor'/);
    assert.match(exact(expression), /opensphere\.io\/request-id/);
  }
  assert.match(reservation(job), /request\.userInfo\.username == 'system:serviceaccount:opensphere-console:platform-release-reconciler'/);
  assert.match(exact(job), /request\.operation == 'UPDATE'/);
  assert.match(exact(job), /oldObject\.spec\.template\.spec\.containers\[0\]\.image/);
  assert.match(exact(job), /object\.spec\.parallelism == 1/);
  assert.match(exact(job), /object\.spec\.completions == 1/);
  assert.match(exact(job), /object\.spec\.completionMode == 'NonIndexed'/);
  assert.match(exact(job), /object\.spec\.podReplacementPolicy == 'TerminatingOrFailed'/);
  assert.match(exact(job), /object\.metadata\.name == 'platform-release-'/);
  assert.match(exact(pod), /system:serviceaccount:kube-system:job-controller/);
  assert.match(exact(pod), /ownerReferences\[0\]\.kind == 'Job'/);
  assert.match(exact(pod), /size\(object\.spec\.tolerations\) == 2/);
});

test('long-lived reconciler Deployment and ReplicaSet Pod identities are exact and unspoofable', () => {
  const deployment = find('Deployment', 'platform-release-reconciler');
  assert.equal(find('ServiceAccount', 'platform-release-reconciler').automountServiceAccountToken, false);
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.deepEqual(deployment.spec.template.spec.volumes.map((entry) => entry.name),
    ['kube-api-access', 'receipt-identity', 'release-control-ca']);
  for (const suffix of ['deployment', 'pod']) {
    const expression = policyExpression(`platform-release-reconciler-${suffix}-boundary`);
    assert.match(expression, /serviceAccountName == 'platform-release-reconciler'/);
    assert.match(expression, /metadata\.labels\['app'\] == 'platform-release-reconciler'/);
    assert.match(expression, /automountServiceAccountToken == false/);
    assert.match(expression, /initContainers/);
    assert.match(expression, /ephemeralContainers/);
    assert.match(expression, /env\.map\(e, e\.name\) ==/);
    assert.match(expression, /opensphere-console-platform-release/);
    assert.match(expression, /opensphere-platform-release-identity/);
  }
  assert.match(policyExpression('platform-release-reconciler-deployment-boundary'),
    /image\s*== 'ghcr\.io\/opensphere-platform\/opensphere-console-backend@sha256:[a-f0-9]{64}'/);
  const pod = policyExpression('platform-release-reconciler-pod-boundary');
  assert.match(pod, /system:serviceaccount:kube-system:replicaset-controller/);
  assert.match(pod, /ownerReferences\[0\]\.kind == 'ReplicaSet'/);
  assert.match(pod, /pod-template-hash/);
  assert.doesNotMatch(pod,
    /system:serviceaccount:opensphere-console:platform-release-reconciler/);
});

test('claim and receipt identities use purpose-bound projected TokenReview credentials', () => {
  assert.match(serverSource,
    /reconciler === FOUNDATION_OWNER_RELEASE_RECONCILER[\s\S]+?reconciler === PLATFORM_RELEASE_RECONCILER/);
  assert.match(serverSource, /'opensphere-console-platform-release'/);
  assert.match(serverSource, /validateLocalEdgeAutomationTokenClaims\(match\[1\]/);
  assert.match(serverSource, /requirePodBound: true/);
  assert.match(serverSource, /serviceAccountPrefix}-reconciler/);
  assert.match(serverSource, /serviceAccountPrefix}-executor/);
});

test('TLS leaf and public CA are immutable create-only executor custody objects', () => {
  const service = find('Service', 'opensphere-platform-release-authority');
  assert.deepEqual(service.spec.selector, { app: 'opensphere-console-backend' });
  assert.deepEqual(service.spec.ports, [{ name: 'https', port: 8446, targetPort: 'release-tls' }]);
  const policy = find('ValidatingAdmissionPolicy', 'opensphere-platform-release-authority-tls-writer');
  assert.deepEqual(policy.spec.matchConstraints.resourceRules[0].operations,
    ['CREATE', 'UPDATE', 'DELETE']);
  const expression = policy.spec.validations[0].expression;
  assert.match(expression, /request\.operation == 'CREATE'/);
  assert.match(expression,
    /system:serviceaccount:opensphere-console:platform-release-executor/);
  assert.match(expression, /opensphere-platform-release-authority-tls/);
  assert.match(expression, /opensphere-platform-release-control-ca/);
  assert.match(expression, /object\.immutable == true/);
  assert.match(expression, /'ca\.crt','tls\.crt','tls\.key'/);
  assert.doesNotMatch(expression, /request\.operation == '(?:UPDATE|DELETE)'/);
  const backend = find('Deployment', 'opensphere-console-backend');
  const container = backend.spec.template.spec.containers[0];
  assert.equal(container.env.find((entry) => entry.name === 'PLATFORM_RELEASE_AUTHORITY_ENABLED').value,
    'true');
  assert.ok(container.volumeMounts.some((entry) => entry.name === 'platform-release-authority-tls'));
  assert.equal(backend.spec.template.spec.volumes
    .find((entry) => entry.name === 'platform-release-authority-tls').secret.optional, false);
});

test('Bootstrap A TLS initializer is one-shot, projected-identity and direct-Pod closed', () => {
  const job = find('Job', 'opensphere-tls-init-__OPENSPHERE_RELEASE_REVISION__');
  assert.equal(job.spec.parallelism, 1);
  assert.equal(job.spec.completions, 1);
  assert.equal(job.spec.completionMode, 'NonIndexed');
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.template.spec.restartPolicy, 'Never');
  assert.equal(job.spec.template.spec.serviceAccountName, 'platform-release-tls-initializer');
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.deepEqual(job.spec.template.metadata.labels, {
    app: 'platform-release-tls-initializer',
    'opensphere.io/source-revision': '__OPENSPHERE_RELEASE_REVISION__',
  });
  assert.deepEqual(job.spec.template.spec.volumes.map((entry) => entry.name),
    ['kube-api-access', 'tmp']);
  assert.deepEqual(job.spec.template.spec.securityContext,
    { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } });
  assert.equal(job.spec.template.spec.containers[0].command[1],
    '/app/opensphere-console-backend/platform-release-tls-initializer.mjs');
  assert.equal(job.spec.template.spec.containers[0].env[2].value,
    'opensphere-platform-release-tls-initializer/v1');
  const role = find('Role', 'platform-release-tls-initializer');
  assert.deepEqual(role.rules[1].resourceNames, ['opensphere-platform-release-authority-tls']);
  const custody = policyExpression('platform-release-tls-initializer-custody');
  assert.match(custody, /object\.spec\.type == 'ClusterIP'/);
  assert.match(custody, /!has\(object\.spec\.loadBalancerClass\)/);
  assert.match(custody, /object\.spec\.ports\[0\]\.protocol == 'TCP'/);
  assert.doesNotMatch(custody,
    /system:serviceaccount:opensphere-console:platform-release-executor/);
  const custodyPolicy = find('ValidatingAdmissionPolicy', 'platform-release-tls-initializer-custody');
  assert.deepEqual(custodyPolicy.spec.matchConstraints.resourceRules[0].operations,
    ['CREATE', 'UPDATE', 'DELETE']);
  assert.equal(custodyPolicy.spec.validations.length, 1);
  const serviceCustodyName = 'opensphere-platform-release-authority-service-custody';
  const serviceCustody = policyExpression(serviceCustodyName);
  const serviceCustodyPolicy = find('ValidatingAdmissionPolicy', serviceCustodyName);
  const serviceCustodyBinding = find('ValidatingAdmissionPolicyBinding', serviceCustodyName);
  assert.deepEqual(serviceCustodyPolicy.spec.matchConstraints.resourceRules[0], {
    apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE', 'DELETE'],
    resources: ['services'],
  });
  assert.equal(serviceCustodyBinding.spec.policyName, serviceCustodyName);
  assert.match(serviceCustody, /request\.name == 'opensphere-platform-release-authority'/);
  assert.match(serviceCustody,
    /system:serviceaccount:opensphere-console:platform-release-executor/);
  assert.match(serviceCustody, /request\.operation == 'UPDATE'/);
  assert.match(serviceCustody, /object\.spec\.clusterIPs\[0\] == object\.spec\.clusterIP/);
  assert.match(serviceCustody, /object\.spec\.ipFamilyPolicy == 'SingleStack'/);
  assert.match(serviceCustody, /object\.spec\.internalTrafficPolicy == 'Cluster'/);
  assert.doesNotMatch(serviceCustody,
    /request\.operation == 'DELETE'/);
  const journalCustodyName = 'opensphere-bootstrap-a-initializer-cleanup-journal-custody';
  const journalCustodyPolicy = find('ValidatingAdmissionPolicy', journalCustodyName);
  const journalCustodyBinding = find('ValidatingAdmissionPolicyBinding', journalCustodyName);
  const journalCustody = policyExpression(journalCustodyName);
  assert.deepEqual(journalCustodyPolicy.spec.matchConstraints.resourceRules[0], {
    apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE', 'DELETE'],
    resources: ['configmaps'],
  });
  assert.equal(journalCustodyBinding.spec.policyName, journalCustodyName);
  assert.match(journalCustody,
    /request\.name == 'opensphere-bootstrap-a-initializer-cleanup-journal'/);
  assert.match(journalCustody, /request\.operation == 'CREATE'/);
  assert.match(journalCustody, /object\.immutable == true/);
  assert.match(journalCustody, /opensphere-bootstrap-a-initializer-cleanup-journal\/v1/);
  assert.doesNotMatch(journalCustody, /request\.operation == '(?:UPDATE|DELETE)'/);
  for (const suffix of ['job', 'pod']) {
    const name = `platform-release-tls-initializer-${suffix}-boundary`;
    const policy = find('ValidatingAdmissionPolicy', name);
    const binding = find('ValidatingAdmissionPolicyBinding', name);
    assert.deepEqual(policy.spec.paramKind, { apiVersion: 'apps/v1', kind: 'Deployment' });
    assert.deepEqual(binding.spec.paramRef, {
      name: 'opensphere-console-backend',
      namespace: 'opensphere-console',
      parameterNotFoundAction: 'Deny',
    });
    const expression = policyExpression(name);
    assert.match(expression, /serviceAccountName == 'platform-release-tls-initializer'/);
    assert.match(expression, /platform-release-tls-initializer\.mjs/);
    assert.match(expression, /automountServiceAccountToken == false/);
    assert.match(expression, /params\.metadata\.name == 'opensphere-console-backend'/);
    assert.match(expression,
      /containers\[0\]\.image(?:\s+)?== params\.spec\.template\.spec\.containers\[0\]\.image/);
    assert.match(expression, /initContainers/);
    assert.match(expression, /ephemeralContainers/);
    assert.match(expression, /envFrom/);
    assert.match(expression, /env\[0\]\.value == '\/tmp\/home'/);
    assert.match(expression, /size\(object\.spec(?:\.template\.spec)?\.volumes\) == 2/);
    assert.match(expression, /size\(object\.spec(?:\.template\.spec)?\.containers\[0\]\.volumeMounts\) == 2/);
    assert.match(expression, /resources\.requests(?:\s+)?== \{'cpu':'20m','memory':'64Mi'\}/);
    assert.match(expression, /resources\.limits(?:\s+)?== \{'cpu':'500m','memory':'256Mi'\}/);
    for (const field of [
      'hostNetwork', 'hostPID', 'hostIPC', 'nodeName', 'nodeSelector', 'affinity',
      'topologySpreadConstraints', 'schedulingGates', 'runtimeClassName',
    ]) assert.match(expression, new RegExp(field));
  }
  const jobPolicy = policyExpression('platform-release-tls-initializer-job-boundary');
  assert.match(jobPolicy, /object\.spec\.parallelism == 1/);
  assert.match(jobPolicy, /object\.spec\.completions == 1/);
  assert.match(jobPolicy, /object\.spec\.backoffLimit == 0/);
  assert.match(jobPolicy, /object\.spec\.template\.spec\.restartPolicy == 'Never'/);
  const podPolicy = policyExpression('platform-release-tls-initializer-pod-boundary');
  assert.match(podPolicy, /system:serviceaccount:kube-system:job-controller/);
  assert.match(podPolicy, /metadata\.name\.startsWith\('opensphere-tls-init-'\)/);
  assert.match(podPolicy, /ownerReferences\[0\]\.blockOwnerDeletion/);
  assert.match(podPolicy, /controller-uid.*ownerReferences\[0\]\.uid/s);
  assert.match(podPolicy, /size\(object\.spec\.tolerations\) == 2/);
  assert.match(podPolicy, /object\.spec\.priority == 0/);
  assert.match(podPolicy, /object\.spec\.preemptionPolicy == 'PreemptLowerPriority'/);
  const network = find('NetworkPolicy', 'platform-release-tls-initializer');
  assert.deepEqual(network.spec.ingress, []);
  assert.equal(network.spec.egress.length, 2);
});

test('privileged release workers are selector-isolated to their required network paths', () => {
  for (const [name, egressCount] of [
    ['platform-release-reconciler', 3],
    ['platform-release-executor', 4],
  ]) {
    const policy = find('NetworkPolicy', name);
    assert.deepEqual(policy.spec.podSelector.matchLabels, { app: name });
    assert.deepEqual(policy.spec.policyTypes, ['Ingress', 'Egress']);
    assert.deepEqual(policy.spec.ingress, []);
    assert.equal(policy.spec.egress.length, egressCount);
    assert.ok(policy.spec.egress.some((rule) => rule.ports?.some((port) => port.port === 53)));
    assert.ok(policy.spec.egress.some((rule) => rule.to?.[0]?.ipBlock?.cidr === '10.96.0.1/32'));
    assert.ok(policy.spec.egress.some((rule) =>
      rule.to?.[0]?.podSelector?.matchLabels?.app === 'opensphere-console-backend'));
    assert.equal(policy.spec.egress.some((rule) =>
      rule.to?.[0]?.podSelector?.matchLabels?.app === 'opensphere-gitea'), false);
  }
  const executor = find('NetworkPolicy', 'platform-release-executor');
  const publicHttps = executor.spec.egress.find((rule) => rule.to?.[0]?.ipBlock?.cidr === '0.0.0.0/0');
  assert.deepEqual(publicHttps.ports, [{ protocol: 'TCP', port: 443 }]);
  assert.deepEqual(publicHttps.to[0].ipBlock.except,
    ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']);
});

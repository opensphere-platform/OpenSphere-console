import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path) => readFile(resolve(root, path), 'utf8');
const documents = [];
yaml.loadAll(await read('deploy/baseline-monitoring/beszel-release.yaml'), (document) => {
  if (document) documents.push(document);
});
const releaseContract = JSON.parse(await read('deploy/baseline-monitoring/release-contract.json'));

function one(kind, name) {
  const matches = documents.filter(
    (document) => document.kind === kind && document.metadata?.name === name,
  );
  assert.equal(matches.length, 1, `${kind}/${name} must occur exactly once`);
  return matches[0];
}

function container(kind, name) {
  const workload = one(kind, name);
  const containers = workload.spec?.template?.spec?.containers || [];
  assert.equal(containers.length, 1, `${kind}/${name} must have one container`);
  return containers[0];
}

test('release contract exposes the complete Beszel bootstrapCore artifact set', async () => {
  assert.equal(releaseContract.releaseFamily, 'OpenSphere-Console');
  assert.equal(releaseContract.ownerComponent, 'C_API');
  assert.equal(releaseContract.authoritySystem, 'S_HOBS');
  assert.equal(releaseContract.adapterComponent, 'API_HOBS');
  assert.equal(releaseContract.requirement, 'CON-FR-011');
  assert.equal(releaseContract.bootstrapCore, true);

  assert.deepEqual(
    releaseContract.artifacts.map(({ key, artifact, manifestPlaceholder }) => ({
      key,
      artifact,
      manifestPlaceholder,
    })),
    [
      {
        key: 'beszelHub',
        artifact: 'opensphere-console-beszel-hub',
        manifestPlaceholder: '__OPENSPHERE_BESZEL_HUB_IMAGE__',
      },
      {
        key: 'beszelAgent',
        artifact: 'opensphere-console-beszel-agent',
        manifestPlaceholder: '__OPENSPHERE_BESZEL_AGENT_IMAGE__',
      },
      {
        key: 'beszelBootstrap',
        artifact: 'opensphere-console-beszel-bootstrap',
        manifestPlaceholder: '__OPENSPHERE_BESZEL_BOOTSTRAP_IMAGE__',
      },
    ],
  );

  for (const artifact of releaseContract.artifacts) {
    assert.match(
      artifact.repository,
      new RegExp(`^ghcr\\.io/opensphere-platform/${artifact.artifact}$`),
    );
    const dockerfile = await read(artifact.dockerfile);
    assert.match(dockerfile, /^FROM docker\.io\/.+@sha256:[0-9a-f]{64}$/m);
    assert.match(dockerfile, new RegExp(`io\\.opensphere\\.release-component="${artifact.key}"`));
  }
});

test('manifest is a signed-BOM render template with no direct upstream image', async () => {
  const source = await read('deploy/baseline-monitoring/beszel-release.yaml');
  const expected = new Map([
    ['StatefulSet/beszel-hub', '__OPENSPHERE_BESZEL_HUB_IMAGE__'],
    ['DaemonSet/beszel-agent', '__OPENSPHERE_BESZEL_AGENT_IMAGE__'],
    ['Job/beszel-bootstrap-v0187', '__OPENSPHERE_BESZEL_BOOTSTRAP_IMAGE__'],
  ]);
  for (const [identity, image] of expected) {
    const [kind, name] = identity.split('/');
    assert.equal(container(kind, name).image, image);
    assert.equal((source.match(new RegExp(image, 'g')) || []).length, 1);
  }
  assert.doesNotMatch(source, /^\s*image:\s*(?:henrygd|curlimages)\//m);
  assert.doesNotMatch(source, /^\s*image:\s*\S+:(?:latest|edge|candidate|stable|ga)\s*$/m);

  for (const [kind, name] of [
    ['StatefulSet', 'beszel-hub'],
    ['DaemonSet', 'beszel-agent'],
    ['Job', 'beszel-bootstrap-v0187'],
  ]) {
    assert.deepEqual(
      one(kind, name).spec.template.spec.imagePullSecrets,
      [{ name: 'opensphere-ghcr-pull' }],
    );
  }
});

test('Hub is private and exposes explicit startup, readiness and liveness health', () => {
  const service = one('Service', 'beszel-hub');
  assert.equal(service.spec.type, 'ClusterIP');
  assert.notEqual(service.spec.clusterIP, 'None');
  assert.equal(service.spec.ports[0].port, 8090);
  assert.equal(documents.filter(({ kind }) => kind === 'Ingress').length, 0);
  assert.equal(documents.filter(({ kind }) => kind === 'HTTPRoute').length, 0);
  assert.equal(documents.filter(({ kind }) => kind === 'Gateway').length, 0);

  const hub = container('StatefulSet', 'beszel-hub');
  for (const probeName of ['startupProbe', 'readinessProbe', 'livenessProbe']) {
    assert.equal(hub[probeName].httpGet.path, '/api/health');
    assert.equal(hub[probeName].httpGet.port, 'http');
    assert.ok(hub[probeName].timeoutSeconds > 0);
  }
  assert.equal(hub.securityContext.runAsNonRoot, true);
  assert.equal(hub.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(hub.securityContext.capabilities.drop, ['ALL']);
});

test('Agent accepts no inbound traffic and can egress only to DNS and the Hub', () => {
  const agent = container('DaemonSet', 'beszel-agent');
  assert.equal(agent.env.find(({ name }) => name === 'BESZEL_AGENT_DISABLE_SSH').value, 'true');
  assert.deepEqual(agent.readinessProbe.exec.command, ['/agent', 'health']);
  assert.deepEqual(agent.livenessProbe.exec.command, ['/agent', 'health']);

  const daemon = one('DaemonSet', 'beszel-agent');
  assert.equal(daemon.spec.template.spec.hostNetwork, undefined);
  assert.equal(agent.ports, undefined);
  assert.equal(agent.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(agent.securityContext.capabilities.drop, ['ALL']);
  for (const mount of daemon.spec.template.spec.volumes.filter(({ hostPath }) => hostPath)) {
    const volumeMount = agent.volumeMounts.find(({ name }) => name === mount.name);
    if (mount.name !== 'agent-state') assert.equal(volumeMount.readOnly, true);
  }

  const policy = one('NetworkPolicy', 'beszel-agent');
  assert.deepEqual(policy.spec.policyTypes, ['Ingress', 'Egress']);
  assert.deepEqual(policy.spec.ingress, []);
  assert.equal(policy.spec.egress.length, 2);
  assert.deepEqual(policy.spec.egress[1].to[0].podSelector.matchLabels, {
    'app.kubernetes.io/name': 'beszel-hub',
  });
  assert.deepEqual(policy.spec.egress[1].ports, [{ protocol: 'TCP', port: 8090 }]);
});

test('Hub network admits only target Console API reads and claims no alert ingest', async () => {
  const source = await read('deploy/baseline-monitoring/beszel-release.yaml');
  assert.doesNotMatch(source, /WEBHOOK_TOKEN|webhook-token|generic\+http:|opensphere-console-backend/);

  const policy = one('NetworkPolicy', 'beszel-hub');
  const targetIngress = policy.spec.ingress[0].from.find(({ namespaceSelector }) => namespaceSelector);
  assert.deepEqual(targetIngress.namespaceSelector.matchLabels, {
    'kubernetes.io/metadata.name': 'opensphere-console',
  });
  assert.deepEqual(targetIngress.podSelector.matchLabels, {
    'app.kubernetes.io/name': 'opensphere-console-api',
  });
  assert.equal(policy.spec.egress.length, 1);
  assert.deepEqual(policy.spec.egress[0].ports, [
    { protocol: 'UDP', port: 53 },
    { protocol: 'TCP', port: 53 },
  ]);
});

test('installer rejects non-BOM images and verifies the installed runtime identity', async () => {
  const installer = await read('deploy/baseline-monitoring/install.ps1');
  for (const name of ['hub', 'agent', 'bootstrap']) {
    assert.match(
      installer,
      new RegExp(
        `ghcr\\\\.io/opensphere-platform/opensphere-console-beszel-${name}@sha256:\\[a-f0-9\\]\\{64\\}`,
      ),
    );
  }
  for (const placeholder of releaseContract.artifacts.map(({ manifestPlaceholder }) => manifestPlaceholder)) {
    assert.match(installer, new RegExp(placeholder));
  }
  assert.match(installer, /differs from the signed release BOM digest/);
  assert.match(installer, /Beszel Hub must remain reachable only through a private ClusterIP Service/);
  assert.match(installer, /Beszel Hub must not be referenced by an Ingress/);
  assert.doesNotMatch(installer, /deployment\/opensphere-console-backend/);
  assert.match(installer, /deployment\/opensphere-console-api/);
});

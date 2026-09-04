import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KUBERNETES_API_EGRESS_CONTRACT,
  KUBERNETES_API_EGRESS_POLICY,
  createKubernetesApiEgressPolicyReconciler,
  kubernetesApiEgressPolicy,
  kubernetesApiEgressRules,
} from '../src/kubernetes-api-egress-policy.mjs';

const service = () => ({
  metadata: { name: 'kubernetes', namespace: 'default' },
  spec: { clusterIPs: ['10.96.0.1'], ports: [{ name: 'https', protocol: 'TCP', port: 443 }] },
});
const slices = (address = '192.168.65.4') => ({
  items: [{
    metadata: { namespace: 'default', labels: { 'kubernetes.io/service-name': 'kubernetes' } },
    addressType: 'IPv4',
    ports: [{ name: 'https', protocol: 'TCP', port: 6443 }],
    endpoints: [{ addresses: [address], conditions: { ready: true } }],
  }],
});

test('registry Kubernetes egress remains exact across Docker Desktop endpoint rotation', () => {
  assert.deepEqual(
    kubernetesApiEgressRules(service(), slices()).map((rule) => [rule.to[0].ipBlock.cidr, rule.ports[0].port]),
    [['10.96.0.1/32', 443], ['192.168.65.4/32', 6443]],
  );
  assert.deepEqual(
    kubernetesApiEgressRules(service(), slices('192.168.65.5')).map((rule) => rule.to[0].ipBlock.cidr),
    ['10.96.0.1/32', '192.168.65.5/32'],
  );
  assert.throws(() => kubernetesApiEgressRules(service(), slices('127.0.0.1')), /egress discovery/u);
});

test('reconciler patches only the pre-owned policy and preserves exact addresses', async () => {
  const calls = [];
  const policy = kubernetesApiEgressPolicy('opensphere-console', kubernetesApiEgressRules(service(), slices('192.168.65.3')));
  policy.metadata.resourceVersion = '17';
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/services/kubernetes')) return Response.json(service());
    if (String(url).includes('/endpointslices?')) return Response.json(slices('192.168.65.4'));
    if (options.method === 'PATCH') return Response.json({ metadata: { resourceVersion: '18' } });
    return Response.json(policy);
  };
  const result = await createKubernetesApiEgressPolicyReconciler({
    baseUrl: 'https://kubernetes.test', token: 'service-account-token', namespace: 'opensphere-console', fetchImpl,
  }).reconcileOnce();
  assert.deepEqual(result, { state: 'Updated', endpointCount: 2 });
  const patch = calls.find((call) => call.options.method === 'PATCH');
  assert.ok(patch);
  const body = JSON.parse(patch.options.body);
  assert.equal(body.metadata.resourceVersion, '17');
  assert.equal(body.metadata.labels['opensphere.io/contract'], KUBERNETES_API_EGRESS_CONTRACT);
  assert.deepEqual(body.spec.egress.map((rule) => rule.to[0].ipBlock.cidr), ['10.96.0.1/32', '192.168.65.4/32']);
  assert.equal(patch.url.endsWith(`/networkpolicies/${KUBERNETES_API_EGRESS_POLICY}`), true);
});

test('reconciler refuses a policy outside its closed ownership label', async () => {
  const current = kubernetesApiEgressPolicy('opensphere-console', kubernetesApiEgressRules(service(), slices()));
  current.metadata.resourceVersion = '3';
  delete current.metadata.labels['app.kubernetes.io/managed-by'];
  const fetchImpl = async (url) => {
    if (String(url).includes('/services/kubernetes')) return Response.json(service());
    if (String(url).includes('/endpointslices?')) return Response.json(slices());
    return Response.json(current);
  };
  await assert.rejects(
    createKubernetesApiEgressPolicyReconciler({
      baseUrl: 'https://kubernetes.test', token: 'service-account-token', namespace: 'opensphere-console', fetchImpl,
    }).reconcileOnce(),
    /outside the controller ownership contract/u,
  );
});

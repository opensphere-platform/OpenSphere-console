import { BlockList, isIP } from 'node:net';

export const KUBERNETES_API_EGRESS_POLICY = 'opensphere-console-api-kubernetes-egress';
export const KUBERNETES_API_EGRESS_CONTRACT = 'registry-kubernetes-egress/v1';

const invalidTargets = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  invalidTargets.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fe80::', 10], ['ff00::', 8]]) {
  invalidTargets.addSubnet(address, prefix, 'ipv6');
}

function fail(message = 'Kubernetes API egress discovery is invalid') {
  throw Object.assign(new Error(message), { code: 'KubernetesEgressAuthorityUnavailable' });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function kubernetesApiEgressRules(service, endpointSlices) {
  if (service?.metadata?.name !== 'kubernetes' || service?.metadata?.namespace !== 'default') fail();
  const servicePorts = (service.spec?.ports ?? [])
    .filter((port) => port.name === 'https' && (port.protocol ?? 'TCP') === 'TCP');
  if (servicePorts.length !== 1) fail();
  const rules = new Map();
  const add = (address, port) => {
    const family = isIP(address ?? '');
    if (!family || !Number.isInteger(port) || port < 1 || port > 65535) fail();
    if (invalidTargets.check(address, family === 4 ? 'ipv4' : 'ipv6')) fail();
    const cidr = `${address}/${family === 4 ? 32 : 128}`;
    rules.set(`${cidr}:${port}`, { to: [{ ipBlock: { cidr } }], ports: [{ protocol: 'TCP', port }] });
  };
  const serviceAddresses = service.spec?.clusterIPs ?? [service.spec?.clusterIP];
  if (serviceAddresses.length === 0) fail();
  for (const address of serviceAddresses) add(address, servicePorts[0].port);
  let readyEndpoints = 0;
  for (const slice of endpointSlices?.items ?? []) {
    if (slice?.metadata?.namespace !== 'default'
      || slice?.metadata?.labels?.['kubernetes.io/service-name'] !== 'kubernetes'
      || !['IPv4', 'IPv6'].includes(slice.addressType)) fail();
    const ports = (slice.ports ?? [])
      .filter((port) => port.name === 'https' && (port.protocol ?? 'TCP') === 'TCP');
    if (ports.length !== 1) fail();
    for (const endpoint of slice.endpoints ?? []) {
      if (endpoint.conditions?.ready === false || endpoint.conditions?.terminating === true) continue;
      if (!Array.isArray(endpoint.addresses) || endpoint.addresses.length === 0) fail();
      for (const address of endpoint.addresses) {
        if (isIP(address) !== (slice.addressType === 'IPv4' ? 4 : 6)) fail();
        add(address, ports[0].port);
        readyEndpoints += 1;
      }
    }
  }
  if (readyEndpoints === 0 || rules.size > 128) fail();
  return [...rules.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, rule]) => rule);
}

export function kubernetesApiEgressPolicy(namespace, egress) {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(namespace ?? '')
    || !Array.isArray(egress) || egress.length === 0 || egress.length > 128) fail();
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: KUBERNETES_API_EGRESS_POLICY,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'opensphere-extension-controller',
        'app.kubernetes.io/part-of': 'opensphere-console',
        'opensphere.io/contract': KUBERNETES_API_EGRESS_CONTRACT,
      },
    },
    spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'opensphere-console-api' } },
      policyTypes: ['Egress'],
      egress,
    },
  };
}

export function createKubernetesApiEgressPolicyReconciler({
  baseUrl,
  token,
  namespace,
  fetchImpl = fetch,
  timeoutMs = 8000,
  maximumResponseBytes = 131072,
} = {}) {
  if (!baseUrl || !token || !namespace || typeof fetchImpl !== 'function') fail('Kubernetes API egress reconciler configuration is invalid');
  const request = async (path, { method = 'GET', body } = {}) => {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/merge-patch+json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumResponseBytes) fail('Kubernetes API egress response exceeds the configured limit');
    const payload = bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
    if (!response.ok) fail(`Kubernetes API egress request failed with HTTP ${response.status}`);
    return payload;
  };
  return Object.freeze({
    async reconcileOnce() {
      const [service, endpointSlices, current] = await Promise.all([
        request('/api/v1/namespaces/default/services/kubernetes'),
        request('/apis/discovery.k8s.io/v1/namespaces/default/endpointslices?labelSelector=kubernetes.io%2Fservice-name%3Dkubernetes'),
        request(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/networkpolicies/${KUBERNETES_API_EGRESS_POLICY}`),
      ]);
      if (current.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'opensphere-extension-controller'
        || current.metadata?.labels?.['opensphere.io/contract'] !== KUBERNETES_API_EGRESS_CONTRACT
        || !current.metadata?.resourceVersion) {
        fail('Kubernetes API egress policy is outside the controller ownership contract');
      }
      const desired = kubernetesApiEgressPolicy(namespace, kubernetesApiEgressRules(service, endpointSlices));
      if (canonical(current.spec) === canonical(desired.spec)) return { state: 'Current', endpointCount: desired.spec.egress.length };
      await request(
        `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/networkpolicies/${KUBERNETES_API_EGRESS_POLICY}`,
        {
          method: 'PATCH',
          body: {
            metadata: { resourceVersion: current.metadata.resourceVersion, labels: desired.metadata.labels },
            spec: desired.spec,
          },
        },
      );
      return { state: 'Updated', endpointCount: desired.spec.egress.length };
    },
  });
}

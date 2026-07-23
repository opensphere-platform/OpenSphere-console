const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const RESOURCE_CATALOG = Object.freeze({
  pod: resource('', 'v1', 'pods', 'Pod', true),
  service: resource('', 'v1', 'services', 'Service', true),
  endpoints: resource('', 'v1', 'endpoints', 'Endpoints', true),
  endpointslice: resource('discovery.k8s.io', 'v1', 'endpointslices', 'EndpointSlice', true),
  configmap: resource('', 'v1', 'configmaps', 'ConfigMap', true),
  persistentvolumeclaim: resource('', 'v1', 'persistentvolumeclaims', 'PersistentVolumeClaim', true),
  deployment: resource('apps', 'v1', 'deployments', 'Deployment', true),
  statefulset: resource('apps', 'v1', 'statefulsets', 'StatefulSet', true),
  daemonset: resource('apps', 'v1', 'daemonsets', 'DaemonSet', true),
  replicaset: resource('apps', 'v1', 'replicasets', 'ReplicaSet', true),
  job: resource('batch', 'v1', 'jobs', 'Job', true),
  cronjob: resource('batch', 'v1', 'cronjobs', 'CronJob', true),
  ingress: resource('networking.k8s.io', 'v1', 'ingresses', 'Ingress', true),
  networkpolicy: resource('networking.k8s.io', 'v1', 'networkpolicies', 'NetworkPolicy', true),
  horizontalpodautoscaler: resource('autoscaling', 'v2', 'horizontalpodautoscalers', 'HorizontalPodAutoscaler', true),
  poddisruptionbudget: resource('policy', 'v1', 'poddisruptionbudgets', 'PodDisruptionBudget', true),
  node: resource('', 'v1', 'nodes', 'Node', false),
  namespace: resource('', 'v1', 'namespaces', 'Namespace', false),
  persistentvolume: resource('', 'v1', 'persistentvolumes', 'PersistentVolume', false),
  storageclass: resource('storage.k8s.io', 'v1', 'storageclasses', 'StorageClass', false),
  customresourcedefinition: resource('apiextensions.k8s.io', 'v1', 'customresourcedefinitions', 'CustomResourceDefinition', false),
  apiservice: resource('apiregistration.k8s.io', 'v1', 'apiservices', 'APIService', false),
  observabilitybinding: resource('observability.opensphere.io', 'v1alpha1', 'observabilitybindings', 'ObservabilityBinding', false),
  platformsupportprofile: resource('platform.opensphere.io', 'v1alpha1', 'platformsupportprofiles', 'PlatformSupportProfile', true),
  uipluginpackage: resource('plugins.opensphere.io', 'v1alpha1', 'uipluginpackages', 'UIPluginPackage', true),
  uipluginregistration: resource('plugins.opensphere.io', 'v1alpha1', 'uipluginregistrations', 'UIPluginRegistration', true),
  foundationmodel: resource('foundation.opensphere.io', 'v1alpha1', 'foundationmodels', 'FoundationModel', false),
  foundationmoduledescriptor: resource('foundation.opensphere.io', 'v1alpha1', 'foundationmoduledescriptors', 'FoundationModuleDescriptor', false),
  foundationclaim: resource('foundation.opensphere.io', 'v1alpha1', 'foundationclaims', 'FoundationClaim', true),
  foundationbinding: resource('foundation.opensphere.io', 'v1alpha1', 'foundationbindings', 'FoundationBinding', true),
  identitydirectoryclaim: resource('foundation.opensphere.io', 'v1alpha1', 'identitydirectoryclaims', 'IdentityDirectoryClaim', true),
  identitydirectorybinding: resource('foundation.opensphere.io', 'v1alpha1', 'identitydirectorybindings', 'IdentityDirectoryBinding', true),
});

const RUNTIME_RESOURCE_KINDS = Object.freeze(Object.keys(RESOURCE_CATALOG));
const WATCH_RESOURCE_KINDS = RUNTIME_RESOURCE_KINDS;

function resource(group, version, plural, kind, namespaced) {
  return Object.freeze({ group, version, plural, kind, namespaced });
}

function resourceDefinition(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[._-]/g, '');
  const aliases = {
    pods: 'pod', services: 'service', endpoint: 'endpoints', endpointslices: 'endpointslice',
    configmaps: 'configmap', pvc: 'persistentvolumeclaim', persistentvolumeclaims: 'persistentvolumeclaim',
    deployments: 'deployment', deploy: 'deployment', statefulsets: 'statefulset', daemonsets: 'daemonset',
    replicasets: 'replicaset', jobs: 'job', cronjobs: 'cronjob', ingresses: 'ingress',
    networkpolicies: 'networkpolicy', hpa: 'horizontalpodautoscaler', horizontalpodautoscalers: 'horizontalpodautoscaler',
    pdb: 'poddisruptionbudget', poddisruptionbudgets: 'poddisruptionbudget', nodes: 'node', namespaces: 'namespace',
    pv: 'persistentvolume', persistentvolumes: 'persistentvolume', storageclasses: 'storageclass',
    crd: 'customresourcedefinition', customresourcedefinitions: 'customresourcedefinition', apiservices: 'apiservice',
    observabilitybindings: 'observabilitybinding', platformsupportprofiles: 'platformsupportprofile', uipluginpackages: 'uipluginpackage',
    uipluginregistrations: 'uipluginregistration', foundationmodels: 'foundationmodel',
    foundationmoduledescriptors: 'foundationmoduledescriptor', foundationclaims: 'foundationclaim',
    foundationbindings: 'foundationbinding', identitydirectoryclaims: 'identitydirectoryclaim',
    identitydirectorybindings: 'identitydirectorybinding',
  };
  const canonical = RESOURCE_CATALOG[key] ? key : aliases[key];
  if (!canonical || !RESOURCE_CATALOG[canonical]) throw Object.assign(new Error('Kubernetes resource kind is not allowlisted'), { code: 400 });
  return { key: canonical, ...RESOURCE_CATALOG[canonical] };
}

function apiPrefix(definition) {
  return definition.group ? `/apis/${definition.group}/${definition.version}` : `/api/${definition.version}`;
}

function kubernetesResourcePath(kind, namespace = '', name = '', query = {}) {
  const definition = resourceDefinition(kind);
  const ns = String(namespace || '').trim();
  const resourceName = String(name || '').trim();
  if (ns && !NAME_RE.test(ns)) throw Object.assign(new Error('invalid namespace'), { code: 400 });
  if (resourceName && !NAME_RE.test(resourceName)) throw Object.assign(new Error('invalid resource name'), { code: 400 });
  if (!definition.namespaced && ns) throw Object.assign(new Error(`${definition.kind} is cluster scoped`), { code: 400 });
  let path = apiPrefix(definition);
  if (definition.namespaced && ns) path += `/namespaces/${encodeURIComponent(ns)}`;
  path += `/${definition.plural}`;
  if (resourceName) path += `/${encodeURIComponent(resourceName)}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return `${path}${params.size ? `?${params.toString()}` : ''}`;
}

function metadataSummary(object = {}) {
  const metadata = object.metadata || {};
  const annotations = {};
  const safeAnnotationKeys = new Set([
    'deployment.kubernetes.io/revision', 'kubectl.kubernetes.io/restartedAt',
    'opensphere.io/oaa-restarted-at', 'opensphere.io/change-request-id',
    'opensphere.io/correlation-id', 'opensphere.io/request-id', 'opensphere.io/source',
    'opensphere.io/managed-by', 'opensphere.io/layer', 'opensphere.io/scope',
    'opensphere.io/host-ref', 'opensphere.io/sdk-version',
  ]);
  for (const [key, value] of Object.entries(metadata.annotations || {})) {
    if (safeAnnotationKeys.has(key)) {
      annotations[key] = String(value).slice(0, 500);
    }
  }
  return {
    name: metadata.name || '',
    namespace: metadata.namespace || '',
    generation: metadata.generation ?? null,
    resourceVersion: metadata.resourceVersion || '',
    creationTimestamp: metadata.creationTimestamp || '',
    deletionTimestamp: metadata.deletionTimestamp || null,
    labels: metadata.labels || {},
    annotations,
    ownerReferences: (metadata.ownerReferences || []).map((owner) => ({ kind: owner.kind || '', name: owner.name || '', controller: Boolean(owner.controller) })),
  };
}

function conditionsSummary(conditions = []) {
  return (conditions || []).slice(0, 24).map((condition) => ({
    type: condition.type || '', status: condition.status || '', reason: condition.reason || '',
    message: String(condition.message || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    lastTransitionTime: condition.lastTransitionTime || '',
  }));
}

function stateMap(value = {}) {
  const allowed = new Set(['enabled', 'disabled', 'installed', 'uninstalled', 'requested', 'ready', 'blocked']);
  return Object.fromEntries(Object.entries(value || {})
    .filter(([key, state]) => /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(key) && allowed.has(String(state || '').toLowerCase()))
    .map(([key, state]) => [key, String(state)]));
}

function containerSummary(container = {}) {
  return {
    name: container.name || '', image: container.image || '', imagePullPolicy: container.imagePullPolicy || '',
    ports: (container.ports || []).map((port) => ({ name: port.name || '', containerPort: port.containerPort, protocol: port.protocol || 'TCP' })),
    resources: container.resources || {},
  };
}

function podSummary(object) {
  const statuses = object.status?.containerStatuses || [];
  return {
    phase: object.status?.phase || '', reason: object.status?.reason || '', node: object.spec?.nodeName || '',
    qosClass: object.status?.qosClass || '', startTime: object.status?.startTime || '',
    ready: `${statuses.filter((status) => status.ready).length}/${statuses.length}`,
    restarts: statuses.reduce((count, status) => count + Number(status.restartCount || 0), 0),
    containers: (object.spec?.containers || []).map(containerSummary),
    containerStates: statuses.map((status) => ({
      name: status.name || '', ready: Boolean(status.ready), restartCount: Number(status.restartCount || 0), image: status.image || '',
      state: status.state?.waiting?.reason || status.state?.terminated?.reason || (status.state?.running ? 'Running' : ''),
    })),
    conditions: conditionsSummary(object.status?.conditions),
  };
}

function workloadSummary(object) {
  const spec = object.spec || {};
  const status = object.status || {};
  return {
    desired: Number(spec.replicas ?? spec.desiredNumberScheduled ?? 0),
    ready: Number(status.readyReplicas ?? status.numberReady ?? 0),
    available: Number(status.availableReplicas ?? status.numberAvailable ?? 0),
    updated: Number(status.updatedReplicas ?? status.updatedNumberScheduled ?? 0),
    current: Number(status.currentReplicas ?? status.currentNumberScheduled ?? 0),
    observedGeneration: status.observedGeneration ?? null,
    strategy: spec.strategy?.type || spec.updateStrategy?.type || '',
    selector: spec.selector || {},
    containers: (spec.template?.spec?.containers || []).map(containerSummary),
    conditions: conditionsSummary(status.conditions),
  };
}

function sanitizeKubernetesObject(kind, object = {}) {
  const definition = resourceDefinition(kind);
  const metadata = metadataSummary(object);
  const spec = object.spec || {};
  const status = object.status || {};
  let payload;
  switch (definition.key) {
    case 'pod': payload = podSummary(object); break;
    case 'deployment': case 'statefulset': case 'daemonset': case 'replicaset': payload = workloadSummary(object); break;
    case 'service': payload = {
      type: spec.type || '', clusterIP: spec.clusterIP || '', externalName: spec.externalName || '', selector: spec.selector || {},
      ports: (spec.ports || []).map((port) => ({ name: port.name || '', port: port.port, targetPort: port.targetPort, nodePort: port.nodePort, protocol: port.protocol || 'TCP' })),
      loadBalancer: status.loadBalancer || {},
    }; break;
    case 'endpoints': payload = {
      subsets: (object.subsets || []).map((subset) => ({ readyAddresses: (subset.addresses || []).length, notReadyAddresses: (subset.notReadyAddresses || []).length, ports: subset.ports || [] })),
    }; break;
    case 'endpointslice': payload = {
      addressType: object.addressType || '', serviceName: metadata.labels['kubernetes.io/service-name'] || '',
      endpointCount: (object.endpoints || []).length, readyEndpointCount: (object.endpoints || []).filter((endpoint) => endpoint.conditions?.ready !== false).length,
      ports: object.ports || [],
    }; break;
    case 'configmap': payload = { immutable: Boolean(object.immutable), keys: Object.keys(object.data || {}).sort(), binaryKeys: Object.keys(object.binaryData || {}).sort() }; break;
    case 'persistentvolumeclaim': payload = {
      phase: status.phase || '', storageClassName: spec.storageClassName || '', volumeName: spec.volumeName || '', accessModes: spec.accessModes || [],
      requested: spec.resources?.requests?.storage || '', capacity: status.capacity?.storage || '', conditions: conditionsSummary(status.conditions),
    }; break;
    case 'persistentvolume': payload = {
      phase: status.phase || '', storageClassName: spec.storageClassName || '', capacity: spec.capacity?.storage || '', accessModes: spec.accessModes || [],
      reclaimPolicy: spec.persistentVolumeReclaimPolicy || '', volumeMode: spec.volumeMode || '', claimRef: spec.claimRef ? { namespace: spec.claimRef.namespace || '', name: spec.claimRef.name || '' } : null,
      reason: status.reason || '',
    }; break;
    case 'job': payload = {
      completions: spec.completions ?? null, parallelism: spec.parallelism ?? null, suspend: Boolean(spec.suspend), active: Number(status.active || 0),
      succeeded: Number(status.succeeded || 0), failed: Number(status.failed || 0), startTime: status.startTime || '', completionTime: status.completionTime || '',
      containers: (spec.template?.spec?.containers || []).map(containerSummary), conditions: conditionsSummary(status.conditions),
    }; break;
    case 'cronjob': payload = {
      schedule: spec.schedule || '', suspend: Boolean(spec.suspend), concurrencyPolicy: spec.concurrencyPolicy || '',
      lastScheduleTime: status.lastScheduleTime || '', lastSuccessfulTime: status.lastSuccessfulTime || '', activeJobs: (status.active || []).map((ref) => ref.name || ''),
      containers: (spec.jobTemplate?.spec?.template?.spec?.containers || []).map(containerSummary),
    }; break;
    case 'ingress': payload = {
      ingressClassName: spec.ingressClassName || '', hosts: (spec.rules || []).map((rule) => rule.host || '').filter(Boolean),
      tlsHosts: (spec.tls || []).flatMap((tls) => tls.hosts || []), loadBalancer: status.loadBalancer || {},
    }; break;
    case 'networkpolicy': payload = { podSelector: spec.podSelector || {}, policyTypes: spec.policyTypes || [], ingressRules: (spec.ingress || []).length, egressRules: (spec.egress || []).length }; break;
    case 'horizontalpodautoscaler': payload = {
      targetRef: spec.scaleTargetRef || {}, minReplicas: spec.minReplicas ?? 1, maxReplicas: spec.maxReplicas ?? null,
      currentReplicas: status.currentReplicas ?? null, desiredReplicas: status.desiredReplicas ?? null, currentMetrics: status.currentMetrics || [],
      conditions: conditionsSummary(status.conditions),
    }; break;
    case 'poddisruptionbudget': payload = {
      minAvailable: spec.minAvailable ?? null, maxUnavailable: spec.maxUnavailable ?? null, currentHealthy: status.currentHealthy ?? null,
      desiredHealthy: status.desiredHealthy ?? null, disruptionsAllowed: status.disruptionsAllowed ?? null, expectedPods: status.expectedPods ?? null,
      conditions: conditionsSummary(status.conditions),
    }; break;
    case 'node': payload = {
      unschedulable: Boolean(spec.unschedulable), podCIDRs: (spec.podCIDRs || []).length, capacity: status.capacity || {}, allocatable: status.allocatable || {},
      nodeInfo: status.nodeInfo ? { kubeletVersion: status.nodeInfo.kubeletVersion || '', containerRuntimeVersion: status.nodeInfo.containerRuntimeVersion || '', operatingSystem: status.nodeInfo.operatingSystem || '', osImage: status.nodeInfo.osImage || '', architecture: status.nodeInfo.architecture || '' } : {},
      conditions: conditionsSummary(status.conditions),
    }; break;
    case 'namespace': payload = { phase: status.phase || '', conditions: conditionsSummary(status.conditions) }; break;
    case 'storageclass': payload = { provisioner: object.provisioner || '', reclaimPolicy: object.reclaimPolicy || '', volumeBindingMode: object.volumeBindingMode || '', allowVolumeExpansion: Boolean(object.allowVolumeExpansion), mountOptions: object.mountOptions || [] }; break;
    case 'customresourcedefinition': payload = {
      group: spec.group || '', scope: spec.scope || '', names: spec.names || {},
      versions: (spec.versions || []).map((version) => ({ name: version.name || '', served: Boolean(version.served), storage: Boolean(version.storage) })),
      storedVersions: status.storedVersions || [], conditions: conditionsSummary(status.conditions),
    }; break;
    case 'apiservice': payload = { group: spec.group || '', version: spec.version || '', groupPriorityMinimum: spec.groupPriorityMinimum ?? null, versionPriority: spec.versionPriority ?? null, service: spec.service ? { namespace: spec.service.namespace || '', name: spec.service.name || '', port: spec.service.port || 443 } : null, conditions: conditionsSummary(status.conditions) }; break;
    case 'observabilitybinding': payload = {
      owner: spec.owner || '',
      consumerRef: spec.consumerRef ? { kind: spec.consumerRef.kind || '', namespace: spec.consumerRef.namespace || '', name: spec.consumerRef.name || '' } : null,
      requestedCapabilities: spec.requestedCapabilities || [], phase: status.phase || '', observedAt: status.observedAt || '',
      capabilities: status.capabilities || [], queryTemplates: Object.keys(status.contract?.queryTemplates || {}).sort(),
      evidence: status.evidence ? {
        stack: status.evidence.stack || '', prometheusReady: Boolean(status.evidence.prometheusReady),
        prometheusQueryReady: Boolean(status.evidence.prometheusQueryReady), alertmanagerReady: Boolean(status.evidence.alertmanagerReady),
        grafanaReady: Boolean(status.evidence.grafanaReady), syntheticCanary: status.evidence.syntheticCanary || '',
        syntheticCanaryAt: status.evidence.syntheticCanaryAt || '', unavailableCapabilities: status.evidence.unavailableCapabilities || [],
        digest: status.evidence.digest || '',
      } : null,
      conditions: conditionsSummary(status.conditions),
    }; break;
    case 'platformsupportprofile': payload = {
      phase: status.phase || '', observedGeneration: status.observedGeneration ?? null, lastVerifiedAt: status.lastVerifiedAt || '',
      requiredCapabilities: ['delivery', 'observability', 'backupRestore', 'securityPolicy'].filter((key) => spec[key]?.required !== false),
      evidenceRefs: (status.evidenceRefs || []).slice(0, 24).map((item) => ({ type: item.type || '', ref: String(item.ref || '').slice(0, 240) })),
      conditions: conditionsSummary(status.conditions),
    }; break;
    case 'uipluginpackage': payload = {
      displayName: spec.displayName || '', packageKind: spec.kind || '', owner: spec.owner || '', version: spec.version || '',
      hostRef: spec.hostRef || '', permissionProfile: spec.permissionProfile || '', permissions: spec.permissions || [],
      apiBasePath: spec.api?.basePath || '', image: spec.image ? { repository: spec.image.repository || '', digest: spec.image.digest || '' } : null,
      contributions: Object.fromEntries(Object.entries(spec.contributions || {}).map(([key, value]) => [key, { enabled: Boolean(value?.enabled), mode: value?.mode || '' }])),
      conditions: conditionsSummary(status.conditions),
    }; break;
    case 'uipluginregistration': payload = {
      desiredState: spec.desiredState || '', packageRef: spec.packageRef?.name || '', exposeInNavigation: Boolean(spec.exposeInNavigation),
      phase: status.phase || '', reason: status.reason || '', observedGeneration: status.observedGeneration ?? null,
      observedVersion: status.observedVersion || status.currentVersion || '', workloadPhase: status.workload?.phase || '',
      channelState: status.channelState || '', currentDigest: status.currentDigest || '', currentRevision: status.currentRevision || '',
      verification: Object.fromEntries(Object.entries(status.verification || {}).map(([key, value]) => [key, String(value || '').slice(0, 80)])),
      integrations: Object.fromEntries(Object.entries(status.integrations || {}).map(([key, value]) => [key, { phase: value?.phase || '', reason: value?.reason || '', retryable: Boolean(value?.retryable) }])),
      conditions: conditionsSummary(status.conditions),
    }; break;
    case 'foundationmodel': payload = {
      model: spec.model || '', desiredState: spec.desiredState || '', phase: status.phase || '', observedAt: status.observedAt || '',
      engines: stateMap(spec.parameters?.engines), operator: status.operator ? { deployed: Boolean(status.operator.deployed), version: status.operator.version || '' } : null,
      observed: (status.observed || []).slice(0, 48).map((item) => ({ id: item.id || '', value: String(item.value ?? '').slice(0, 160), unit: item.unit || '', healthy: Boolean(item.healthy), source: String(item.source || '').slice(0, 160) })),
      conditions: conditionsSummary(status.conditions),
    }; break;
    case 'foundationmoduledescriptor': payload = {
      model: spec.model || '', summary: String(spec.description?.summary || '').slice(0, 500),
      catalog: spec.catalog ? { authority: spec.catalog.authority || '', fixed: Boolean(spec.catalog.fixed), install: spec.catalog.install || '' } : null,
      capabilities: spec.operator?.capability || [], conditions: conditionsSummary(status.conditions),
    }; break;
    case 'foundationclaim': case 'identitydirectoryclaim': payload = {
      desiredState: spec.desiredState || '', model: spec.model || '',
      capability: typeof spec.capability === 'string' ? spec.capability : (spec.capability?.name || spec.capabilityRef?.name || ''),
      providerRef: spec.providerRef ? { name: spec.providerRef.name || '', kind: spec.providerRef.kind || '' } : null,
      phase: status.phase || '', reason: status.reason || '', observedGeneration: status.observedGeneration ?? null,
      conditions: conditionsSummary(status.conditions),
    }; break;
    case 'foundationbinding': case 'identitydirectorybinding': payload = {
      claimRef: spec.claimRef ? { namespace: spec.claimRef.namespace || metadata.namespace || '', name: spec.claimRef.name || '' } : null,
      providerRef: spec.providerRef ? { name: spec.providerRef.name || '', kind: spec.providerRef.kind || '' } : null,
      phase: status.phase || '', reason: status.reason || '', observedGeneration: status.observedGeneration ?? null,
      endpointReady: Boolean(status.endpointReady), conditions: conditionsSummary(status.conditions),
    }; break;
    default: payload = { conditions: conditionsSummary(status.conditions) };
  }
  return { kind: definition.kind, apiVersion: definition.group ? `${definition.group}/${definition.version}` : definition.version, metadata, ...payload };
}

function projectedResourceHealth(item = {}) {
  const kind = String(item.kind || '');
  if (item.metadata?.deletionTimestamp) return 'NotReady';
  if (kind === 'Pod') return item.phase === 'Running' && String(item.ready || '').split('/')[0] === String(item.ready || '').split('/')[1] && !item.reason ? 'Ready' : 'NotReady';
  if (['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(kind)) return Number(item.ready || 0) >= Number(item.desired || 0) ? 'Ready' : 'Degraded';
  if (kind === 'Job') return Number(item.failed || 0) > 0 ? 'NotReady' : (Number(item.succeeded || 0) >= Number(item.completions || 1) ? 'Ready' : 'Unknown');
  if (kind === 'PersistentVolumeClaim' || kind === 'PersistentVolume') return item.phase === 'Bound' ? 'Ready' : (item.phase === 'Failed' || item.phase === 'Lost' ? 'NotReady' : 'Degraded');
  if (item.phase) {
    if (['Ready', 'Connected', 'Activated', 'Installed', 'Established', 'Compatible'].includes(item.phase)) return 'Ready';
    if (['Failed', 'Blocked', 'Denied', 'NotReady'].includes(item.phase)) return 'NotReady';
    if (['Degraded', 'Stale'].includes(item.phase)) return 'Degraded';
  }
  const conditions = Array.isArray(item.conditions) ? item.conditions : [];
  const ready = conditions.find((condition) => ['Ready', 'Available', 'Established'].includes(condition.type));
  if (ready) return ready.status === 'True' ? 'Ready' : (ready.status === 'False' ? 'NotReady' : 'Degraded');
  return 'Unknown';
}

module.exports = {
  RESOURCE_CATALOG, RUNTIME_RESOURCE_KINDS, WATCH_RESOURCE_KINDS,
  resourceDefinition, kubernetesResourcePath, sanitizeKubernetesObject, projectedResourceHealth,
};

'use strict';

/**
 * BBSS (Backbone Service Stack) status projection.
 *
 * This module is deliberately pure. The Console Backend owns authentication
 * and performs the read-only Kubernetes/owner API calls, then passes their
 * bounded results here. Keeping the projection separate makes the fail-closed
 * state model testable without a Kubernetes cluster or production secrets.
 */

const STATE_RANK = Object.freeze({
  Healthy: 0,
  NotConfigured: 1,
  Stale: 2,
  Degraded: 3,
  Unavailable: 4,
});

const BINARY_BYTES = Object.freeze({
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
});

const DECIMAL_BYTES = Object.freeze({
  k: 1000,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  E: 1000 ** 6,
});

function safeText(value, max = 240) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseCpuMillicores(value) {
  const raw = String(value || '').trim();
  const match = /^([0-9]+(?:\.[0-9]+)?)(n|u|m)?$/.exec(raw);
  if (!match) return null;
  const number = Number(match[1]);
  const suffix = match[2] || '';
  if (suffix === 'n') return Math.round(number / 1_000_000);
  if (suffix === 'u') return Math.round(number / 1_000);
  if (suffix === 'm') return Math.round(number);
  return Math.round(number * 1000);
}

function parseBytes(value) {
  const raw = String(value || '').trim();
  const match = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|Pi|Ei|[kKMGTPE])?$/.exec(raw);
  if (!match) return null;
  const number = Number(match[1]);
  const suffix = match[2] || '';
  const multiplier = BINARY_BYTES[suffix] || DECIMAL_BYTES[suffix] || 1;
  const bytes = number * multiplier;
  return Number.isFinite(bytes) && bytes >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(bytes))
    : null;
}

function worstState(states, fallback = 'NotConfigured') {
  const normalized = (Array.isArray(states) ? states : [])
    .filter((state) => Object.hasOwn(STATE_RANK, state));
  if (!normalized.length) return fallback;
  return normalized.reduce((worst, state) =>
    STATE_RANK[state] > STATE_RANK[worst] ? state : worst, normalized[0]);
}

function workloadPods(workload, pods) {
  const name = String(workload?.metadata?.name || '');
  return (Array.isArray(pods) ? pods : []).filter((pod) => {
    const podName = String(pod?.metadata?.name || '');
    const generated = String(pod?.metadata?.generateName || '');
    return podName === name || podName.startsWith(`${name}-`) || generated.startsWith(`${name}-`);
  });
}

function workloadView(workload, kind, pods) {
  const desired = Math.max(0, finiteNumber(workload?.spec?.replicas, 0));
  const ready = Math.max(0, finiteNumber(workload?.status?.readyReplicas, 0));
  const available = kind === 'Deployment'
    ? Math.max(0, finiteNumber(workload?.status?.availableReplicas, 0))
    : ready;
  const matchedPods = workloadPods(workload, pods);
  const restarts = matchedPods.reduce((total, pod) =>
    total + (Array.isArray(pod?.status?.containerStatuses)
      ? pod.status.containerStatuses.reduce((sum, container) =>
        sum + Math.max(0, finiteNumber(container?.restartCount, 0)), 0)
      : 0), 0);
  const state = desired > 0 && ready >= desired && available >= desired
    ? 'Healthy'
    : (ready > 0 ? 'Degraded' : 'Unavailable');
  const containers = Array.isArray(workload?.spec?.template?.spec?.containers)
    ? workload.spec.template.spec.containers : [];
  const images = containers
    .map((container) => safeText(container?.image, 320))
    .filter(Boolean);
  const version = safeText(
    workload?.metadata?.labels?.['app.kubernetes.io/version']
      || workload?.spec?.template?.metadata?.labels?.['app.kubernetes.io/version'],
    64,
  );
  return {
    id: safeText(workload?.metadata?.name, 128),
    name: safeText(workload?.metadata?.name, 128),
    kind,
    state,
    desired,
    ready,
    available,
    restarts,
    version: version || null,
    images: images.slice(0, 8),
  };
}

function sumPodMetrics(podMetrics) {
  let cpuMillicores = 0;
  let memoryBytes = 0;
  let cpuAvailable = false;
  let memoryAvailable = false;
  for (const pod of (Array.isArray(podMetrics) ? podMetrics : [])) {
    for (const container of (Array.isArray(pod?.containers) ? pod.containers : [])) {
      const cpu = parseCpuMillicores(container?.usage?.cpu);
      const memory = parseBytes(container?.usage?.memory);
      if (cpu !== null) {
        cpuAvailable = true;
        cpuMillicores += cpu;
      }
      if (memory !== null) {
        memoryAvailable = true;
        memoryBytes += memory;
      }
    }
  }
  return {
    cpuMillicores: cpuAvailable ? cpuMillicores : null,
    memoryBytes: memoryAvailable ? memoryBytes : null,
  };
}

function summarizeNamespace({
  namespace,
  deployments = [],
  statefulsets = [],
  pods = [],
  pvcs = [],
  pdbs = [],
  podMetrics = [],
  errors = [],
  observedAt,
}) {
  const components = [
    ...(Array.isArray(deployments) ? deployments : [])
      .map((workload) => workloadView(workload, 'Deployment', pods)),
    ...(Array.isArray(statefulsets) ? statefulsets : [])
      .map((workload) => workloadView(workload, 'StatefulSet', pods)),
  ].sort((left, right) => left.name.localeCompare(right.name));

  const claims = (Array.isArray(pvcs) ? pvcs : []).map((claim) => {
    const requested = parseBytes(claim?.spec?.resources?.requests?.storage);
    const capacity = parseBytes(claim?.status?.capacity?.storage);
    return {
      name: safeText(claim?.metadata?.name, 128),
      state: safeText(claim?.status?.phase, 32) || 'Unknown',
      storageClass: safeText(claim?.spec?.storageClassName, 128) || null,
      requestedBytes: requested,
      capacityBytes: capacity,
    };
  });
  const requestedBytes = claims.reduce((sum, claim) => sum + (claim.requestedBytes || 0), 0);
  const capacityBytes = claims.reduce((sum, claim) => sum + (claim.capacityBytes || 0), 0);
  const nodes = [...new Set((Array.isArray(pods) ? pods : [])
    .map((pod) => safeText(pod?.spec?.nodeName, 128))
    .filter(Boolean))].sort();
  const metrics = sumPodMetrics(podMetrics);
  const normalizedErrors = (Array.isArray(errors) ? errors : []).map((error) => safeText(error)).filter(Boolean);

  let state = components.length
    ? worstState(components.map((component) => component.state))
    : 'NotConfigured';
  if (normalizedErrors.length && state === 'Healthy') state = 'Degraded';

  return {
    namespace: safeText(namespace, 128),
    state,
    observedAt,
    components,
    nodes,
    podCount: Array.isArray(pods) ? pods.length : 0,
    pdbCount: Array.isArray(pdbs) ? pdbs.length : 0,
    capacity: {
      cpuMillicores: metrics.cpuMillicores,
      memoryBytes: metrics.memoryBytes,
      pvcCount: claims.length,
      requestedBytes,
      capacityBytes,
      actualUsedBytes: null,
      claims,
    },
    errors: normalizedErrors.slice(0, 8),
  };
}

function resultValue(result) {
  return result?.ok === true ? result.value : null;
}

function resultError(result, fallback) {
  return result?.ok === true ? '' : safeText(result?.error || fallback);
}

function ownerProbeState(components) {
  const probes = Array.isArray(components) ? components : [];
  if (!probes.length) return 'Degraded';
  const ready = probes.filter((component) => component?.ready === true).length;
  if (ready === probes.length) return 'Healthy';
  return ready > 0 ? 'Degraded' : 'Unavailable';
}

function serviceCapacity(runtime) {
  return runtime?.capacity || {
    cpuMillicores: null,
    memoryBytes: null,
    pvcCount: 0,
    requestedBytes: 0,
    capacityBytes: 0,
    actualUsedBytes: null,
    claims: [],
  };
}

function projectSupabase(result, runtime) {
  const owner = resultValue(result);
  const ownerState = owner ? ownerProbeState(owner.components) : 'Unavailable';
  const state = worstState([runtime?.state || 'Unavailable', ownerState]);
  const warnings = [
    ...(runtime?.errors || []),
    ...(resultError(result, 'Supabase owner API unavailable') ? [resultError(result)] : []),
    'Application throughput history is NotConfigured.',
    'PVC capacity is provisioned capacity; filesystem usage is not yet exported.',
  ];
  return {
    id: 'supabase',
    name: 'Supabase Core',
    role: 'RCC data and identity authority',
    state,
    observedAt: owner?.meta?.checkedAt || runtime?.observedAt || null,
    // Supabase owner meta.version is the RCC backend contract version, not a
    // Supabase release. Only surface a workload-owned version label.
    version: runtime?.components?.find((component) => component.version)?.version || null,
    route: '/manage/data-identity',
    checks: (owner?.components || []).map((component) => ({
      id: safeText(component?.key, 64),
      name: safeText(component?.name, 128),
      state: component?.ready === true ? 'Healthy' : 'Unavailable',
      detail: safeText(component?.detail, 160),
    })),
    components: runtime?.components || [],
    capacity: serviceCapacity(runtime),
    activity: [
      { label: 'Operators', value: owner ? finiteNumber(owner.operators, 0) : null, kind: 'inventory' },
      { label: 'Roles', value: owner && Array.isArray(owner.roles) ? owner.roles.length : null, kind: 'inventory' },
      { label: 'Audit events', value: owner ? finiteNumber(owner.auditEvents, 0) : null, kind: 'bounded-current' },
      { label: 'Storage buckets', value: owner && Array.isArray(owner.buckets) ? owner.buckets.length : null, kind: 'inventory' },
    ],
    warnings: warnings.filter(Boolean).slice(0, 8),
  };
}

function projectGitea(result, runtime) {
  const owner = resultValue(result);
  const ownerState = !owner
    ? 'Unavailable'
    : (Object.hasOwn(STATE_RANK, owner.state)
      ? owner.state
      : (!owner.configured ? 'NotConfigured' : (owner.ready ? 'Healthy' : 'Unavailable')));
  const state = worstState([runtime?.state || 'Unavailable', ownerState]);
  const repoBytes = Array.isArray(owner?.repositories)
    ? owner.repositories.reduce((sum, repository) => sum + Math.max(0, finiteNumber(repository?.sizeKiB, 0)) * 1024, 0)
    : null;
  const pendingChanges = owner?.byStatus
    ? ['intent', 'authorized', 'committed'].reduce((sum, key) => sum + finiteNumber(owner.byStatus[key], 0), 0)
    : null;
  return {
    id: 'gitea',
    name: 'Gitea',
    role: 'Declarative change and history authority',
    state,
    observedAt: owner?.meta?.checkedAt || runtime?.observedAt || null,
    version: safeText(owner?.version, 64) || null,
    route: '/manage/change-control',
    checks: Array.isArray(owner?.checks) && owner.checks.length
      ? owner.checks.map((check) => ({
        id: safeText(check?.id, 64),
        name: safeText(check?.name, 128),
        state: Object.hasOwn(STATE_RANK, check?.state) ? check.state : 'Degraded',
        detail: safeText(check?.detail, 180),
      }))
      : [{
        id: 'gitea-api',
        name: 'Gitea API',
        state: ownerState,
        detail: safeText(owner?.reason || (owner?.ready ? 'API and repository contract ready' : 'not ready'), 160),
      }],
    components: runtime?.components || [],
    capacity: { ...serviceCapacity(runtime), logicalUsedBytes: repoBytes },
    activity: [
      { label: 'Repositories', value: owner?.repositoryCount, kind: 'inventory' },
      { label: 'Pending changes', value: pendingChanges, kind: 'current' },
      { label: 'Webhook receipts', value: Array.isArray(owner?.receipts) ? owner.receipts.length : null, kind: 'bounded-current' },
      { label: 'Failed changes', value: owner?.byStatus ? finiteNumber(owner.byStatus.failed, 0) : null, kind: 'current' },
    ],
    warnings: [
      ...(runtime?.errors || []),
      ...(resultError(result, 'Gitea owner API unavailable') ? [resultError(result)] : []),
      ...(Array.isArray(owner?.warnings) ? owner.warnings.map((warning) => safeText(warning, 180)) : []),
      'HTTP, Git and webhook throughput history is NotConfigured.',
      'Repository size is logical inventory, not PVC filesystem usage.',
    ].filter(Boolean).slice(0, 8),
  };
}

function projectBeszel(result, runtime) {
  const owner = resultValue(result);
  let ownerState = 'Unavailable';
  if (owner && owner.configured === false) ownerState = 'NotConfigured';
  else if (owner) ownerState = worstState((owner.systems || []).map((system) => {
    if (system?.status !== 'up') return 'Unavailable';
    return system?.freshness === 'fresh' ? 'Healthy' : 'Stale';
  }), 'Degraded');
  const state = worstState([runtime?.state || 'Unavailable', ownerState]);
  const systems = Array.isArray(owner?.systems) ? owner.systems : [];
  const hasSystemEvidence = owner?.configured === true;
  const latest = systems.find((system) => system?.latest)?.latest || null;
  return {
    id: 'beszel',
    name: 'Beszel',
    role: 'Host time-series and supplemental diagnostics',
    state,
    observedAt: owner?.observedAt || runtime?.observedAt || null,
    version: runtime?.components?.find((component) => component.version)?.version || null,
    route: '/cc/cc2/hosts',
    checks: systems.map((system) => ({
      id: safeText(system?.binding, 128),
      name: safeText(system?.name, 128),
      state: system?.status !== 'up'
        ? 'Unavailable' : (system?.freshness === 'fresh' ? 'Healthy' : 'Stale'),
      detail: `${safeText(system?.status, 32)} · ${safeText(system?.freshness, 32)} · age ${system?.latestAgeSeconds ?? 'unknown'}s`,
    })),
    components: runtime?.components || [],
    capacity: serviceCapacity(runtime),
    latest: latest ? {
      cpuPercent: latest.cpuPercent,
      memoryPercent: latest.memoryPercent,
      diskPercent: latest.diskPercent,
    } : null,
    activity: [
      { label: 'Bound systems', value: hasSystemEvidence ? systems.length : null, kind: 'inventory' },
      { label: 'Fresh systems', value: hasSystemEvidence ? systems.filter((system) => system.freshness === 'fresh').length : null, kind: 'current' },
      { label: 'Collection gaps', value: hasSystemEvidence ? systems.reduce((sum, system) => sum + finiteNumber(system.gapCount, 0), 0) : null, kind: 'range-1h' },
      { label: 'Latest sample age', value: hasSystemEvidence && systems.length ? Math.max(...systems.map((system) => finiteNumber(system.latestAgeSeconds, 0))) : null, unit: 's', kind: 'current' },
    ],
    warnings: [
      ...(runtime?.errors || []),
      ...(resultError(result, 'Beszel readonly path unavailable') ? [resultError(result)] : []),
      'Beszel stores host metrics only; application throughput is outside this source.',
    ].filter(Boolean).slice(0, 8),
  };
}

function recoveryState(recovery) {
  if (!recovery?.available) return 'NotConfigured';
  const units = [recovery.supabase, recovery.storage, recovery.gitea, recovery.beszel];
  if (units.some((unit) => !unit)) return 'Degraded';
  return units.every((unit) =>
    unit?.state === 'Verified'
      && (!Array.isArray(unit?.checks) || unit.checks.every((check) => check?.verdict === 'Verified')))
    ? 'Healthy' : 'Degraded';
}

function buildBbssStatus({
  supabase,
  gitea,
  beszel,
  namespaces,
  telemetry,
  recovery,
  generatedAt = new Date().toISOString(),
}) {
  const runtime = namespaces || {};
  const services = [
    projectSupabase(supabase, runtime.supabase),
    projectGitea(gitea, runtime.gitea),
    projectBeszel(beszel, runtime.beszel),
  ];
  const runtimeState = worstState(services.map((service) => service.state), 'Unavailable');
  const allNodes = [...new Set(Object.values(runtime)
    .flatMap((item) => Array.isArray(item?.nodes) ? item.nodes : []))].sort();
  const claims = Object.values(runtime).flatMap((item) =>
    Array.isArray(item?.capacity?.claims) ? item.capacity.claims : []);
  const localClaims = claims.filter((claim) => /local/i.test(String(claim?.storageClass || '')));
  const pdbCount = Object.values(runtime).reduce((sum, item) => sum + finiteNumber(item?.pdbCount, 0), 0);
  const restoreState = recoveryState(recovery);
  const resilienceStates = [
    allNodes.length >= 2 ? 'Healthy' : 'Degraded',
    localClaims.length ? 'Degraded' : 'Healthy',
    pdbCount > 0 ? 'Healthy' : 'Degraded',
    restoreState,
  ];
  const resilienceState = worstState(resilienceStates) === 'NotConfigured'
    ? 'Degraded' : worstState(resilienceStates);
  const telemetryState = Object.hasOwn(STATE_RANK, telemetry?.state)
    ? telemetry.state : 'NotConfigured';

  let overallState = 'Healthy';
  if (runtimeState === 'Unavailable') overallState = 'Unavailable';
  else if (runtimeState !== 'Healthy' || resilienceState !== 'Healthy' || telemetryState !== 'Healthy') {
    overallState = 'Degraded';
  }

  const dependencies = [
    {
      id: 'failure-domain',
      name: 'Node failure domain',
      state: allNodes.length >= 2 ? 'Healthy' : 'Degraded',
      detail: allNodes.length
        ? `${allNodes.length} node(s): ${allNodes.join(', ')}`
        : 'No scheduled BBSS pod evidence',
    },
    {
      id: 'persistent-storage',
      name: 'Persistent storage',
      state: localClaims.length ? 'Degraded' : 'Healthy',
      detail: localClaims.length
        ? `${localClaims.length}/${claims.length} claim(s) use node-local storage`
        : `${claims.length} claim(s); no local class detected`,
    },
    {
      id: 'disruption-budget',
      name: 'Disruption protection',
      state: pdbCount > 0 ? 'Healthy' : 'Degraded',
      detail: `${pdbCount} PDB(s) across BBSS namespaces`,
    },
    {
      id: 'recovery',
      name: 'Backup and restore evidence',
      state: restoreState,
      detail: recovery?.available
        ? 'Supabase DB/Storage, Gitea and Beszel restore evidence must all be verified'
        : 'No verified BBSS backup and restore evidence is published',
    },
    {
      id: 'application-timeseries',
      name: 'Application time-series',
      state: telemetryState,
      detail: safeText(telemetry?.reason || 'Prometheus-compatible HIS source is not configured', 180),
    },
  ];

  return {
    schemaVersion: 'rcc.bbss.status/v1',
    generatedAt,
    overall: {
      state: overallState,
      runtimeAvailability: runtimeState,
      resilience: resilienceState,
      applicationTelemetry: telemetryState,
      reason: overallState === 'Healthy'
        ? 'All mandatory services, resilience gates and telemetry evidence are healthy.'
        : (overallState === 'Unavailable'
          ? 'At least one mandatory BBSS service is unavailable.'
          : 'Services are reachable, but one or more resilience or observability gates are incomplete.'),
    },
    summary: {
      services: services.length,
      healthy: services.filter((service) => service.state === 'Healthy').length,
      attention: services.filter((service) => ['Degraded', 'Stale', 'NotConfigured'].includes(service.state)).length,
      unavailable: services.filter((service) => service.state === 'Unavailable').length,
    },
    services,
    dependencies,
    sourcePolicy: {
      currentState: 'Kubernetes + owner health/API evidence',
      hostTimeSeries: 'Beszel readonly API',
      applicationTimeSeries: telemetryState === 'Healthy'
        ? 'HIS Prometheus-compatible binding'
        : 'NotConfigured',
      auditAuthority: 'Supabase',
    },
  };
}

module.exports = {
  STATE_RANK,
  safeText,
  parseCpuMillicores,
  parseBytes,
  worstState,
  summarizeNamespace,
  buildBbssStatus,
};

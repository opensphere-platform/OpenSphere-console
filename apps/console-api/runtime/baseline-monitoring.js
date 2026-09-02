'use strict';

const RANGE = Object.freeze({
  '1h': { type: '1m', seconds: 60 * 60 },
  '12h': { type: '10m', seconds: 12 * 60 * 60 },
  '24h': { type: '20m', seconds: 24 * 60 * 60 },
  '7d': { type: '120m', seconds: 7 * 24 * 60 * 60 },
  '30d': { type: '480m', seconds: 30 * 24 * 60 * 60 },
});

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nodeReady(node) {
  return (node?.status?.conditions || []).some((condition) => condition.type === 'Ready' && condition.status === 'True');
}

function normalizeSystem(row) {
  const info = row?.info && typeof row.info === 'object' ? row.info : {};
  return {
    id: String(row?.id || ''),
    name: String(row?.name || info.h || ''),
    hostname: String(info.h || row?.name || ''),
    status: ['up', 'down', 'paused', 'pending'].includes(row?.status) ? row.status : 'unknown',
    observedAt: row?.updated || null,
    agentVersion: String(info.v || row?.v || ''),
    os: String(info.o || info.os?.name || ''),
    kernel: String(info.k || ''),
    cpuModel: String(info.m || ''),
    cpuThreads: number(info.t),
    cpuCores: number(info.c),
    cpuPercent: number(info.cpu),
    memoryPercent: number(info.mp),
    diskPercent: number(info.dp),
    loadAverage: Array.isArray(info.la) ? info.la.slice(0, 3).map(number) : [],
    uptimeSeconds: number(info.u),
    temperatureCelsius: number(info.dt),
    bandwidthMegabytes: number(info.b),
    connectionType: info.ct || null,
  };
}

function normalizeStats(record) {
  const stats = record?.stats && typeof record.stats === 'object' ? record.stats : {};
  const diskIo = Array.isArray(stats.dio)
    ? [number(stats.dio[0]), number(stats.dio[1])]
    : [number(stats.dr), number(stats.dw)].map((value) => value === null ? null : value * 1024 * 1024);
  const network = Array.isArray(stats.b)
    ? [number(stats.b[0]), number(stats.b[1])]
    : [number(stats.ns), number(stats.nr)].map((value) => value === null ? null : value * 1024 * 1024);
  return {
    at: record?.created || null,
    cpuPercent: number(stats.cpu),
    memoryPercent: number(stats.mp),
    memoryUsedGb: number(stats.mu),
    memoryTotalGb: number(stats.m),
    diskPercent: number(stats.dp),
    diskUsedGb: number(stats.du),
    diskTotalGb: number(stats.d),
    diskReadMb: number(stats.dr),
    diskWriteMb: number(stats.dw),
    networkSentMb: number(stats.ns),
    networkReceivedMb: number(stats.nr),
    diskReadBytesPerSecond: diskIo[0],
    diskWriteBytesPerSecond: diskIo[1],
    networkSentBytesPerSecond: network[0],
    networkReceivedBytesPerSecond: network[1],
    loadAverage: Array.isArray(stats.la) ? stats.la.slice(0, 3).map(number) : [],
  };
}

function createBaselineMonitoring({
  baseUrl,
  email,
  password,
  fetchImpl = globalThis.fetch,
  kubernetesGet,
  bindingStore,
  timeoutMs = 5000,
  clock = () => Date.now(),
}) {
  const url = String(baseUrl || '').replace(/\/$/, '');
  let authToken = '';
  let authAt = 0;
  const cache = new Map();

  function configured() {
    return Boolean(url && email && password);
  }

  async function raw(path, options = {}, retry = true) {
    if (!configured()) throw { code: 503, msg: 'baseline monitoring reader is not configured' };
    if (!authToken || clock() - authAt > 10 * 60 * 1000) await login();
    const response = await fetchImpl(`${url}${path}`, {
      ...options,
      headers: {
        accept: 'application/json',
        Authorization: authToken,
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 && retry) {
      authToken = '';
      await login();
      return raw(path, options, false);
    }
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    if (!response.ok) throw { code: response.status >= 500 ? 503 : response.status, msg: `Beszel adapter upstream HTTP ${response.status}` };
    return body;
  }

  async function login() {
    if (!configured()) throw { code: 503, msg: 'baseline monitoring reader is not configured' };
    const response = await fetchImpl(`${url}/api/collections/users/auth-with-password`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ identity: email, password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.token) throw { code: 503, msg: 'baseline monitoring reader authentication failed' };
    authToken = body.token;
    authAt = clock();
  }

  async function records(collection, parameters = {}) {
    const query = new URLSearchParams({
      page: '1',
      perPage: String(parameters.perPage || 500),
      skipTotal: '0',
    });
    for (const [key, value] of Object.entries(parameters)) {
      if (value === undefined || value === null || key === 'perPage') continue;
      query.set(key, String(value));
    }
    const result = await raw(`/api/collections/${encodeURIComponent(collection)}/records?${query}`);
    return Array.isArray(result.items) ? result.items : [];
  }

  async function cached(key, producer, maxAgeMs = 30_000) {
    const previous = cache.get(key);
    if (previous && clock() - previous.fetchedAt <= maxAgeMs) {
      return { ...previous.value, freshness: 'fresh', observedAt: new Date(previous.fetchedAt).toISOString() };
    }
    try {
      const value = await producer();
      const entry = { value, fetchedAt: clock() };
      cache.set(key, entry);
      return { ...value, freshness: 'fresh', observedAt: new Date(entry.fetchedAt).toISOString() };
    } catch (error) {
      if (previous && clock() - previous.fetchedAt <= 24 * 60 * 60 * 1000) {
        return {
          ...previous.value,
          freshness: 'stale',
          observedAt: new Date(previous.fetchedAt).toISOString(),
          upstreamError: error?.msg || error?.message || 'baseline monitoring unavailable',
        };
      }
      throw error;
    }
  }

  async function systems() {
    const items = await records('systems', {
      sort: '+name',
      fields: 'id,name,host,port,info,status,updated',
    });
    return items.map(normalizeSystem).filter((item) => item.id && item.name);
  }

  async function fingerprints() {
    const items = await records('fingerprints', {
      sort: '+system',
      fields: 'system,fingerprint,updated',
    });
    return new Map(items
      .filter((item) => item?.system && item?.fingerprint)
      .map((item) => [String(item.system), {
        value: String(item.fingerprint),
        observedAt: item.updated || null,
      }]));
  }

  async function kubernetes() {
    if (typeof kubernetesGet !== 'function') return { nodes: [], pods: [], namespaces: [], available: false };
    const [nodes, pods, namespaces] = await Promise.all([
      kubernetesGet('/api/v1/nodes'),
      kubernetesGet('/api/v1/pods'),
      kubernetesGet('/api/v1/namespaces'),
    ]);
    return {
      available: true,
      nodes: (nodes.items || []).map((node) => ({
        uid: node.metadata?.uid || '',
        name: node.metadata?.name || '',
        ready: nodeReady(node),
        roles: Object.keys(node.metadata?.labels || {})
          .filter((key) => key.startsWith('node-role.kubernetes.io/'))
          .map((key) => key.slice('node-role.kubernetes.io/'.length) || 'worker'),
        kubeletVersion: node.status?.nodeInfo?.kubeletVersion || '',
        osImage: node.status?.nodeInfo?.osImage || '',
        architecture: node.status?.nodeInfo?.architecture || '',
        internalIp: (node.status?.addresses || []).find((address) => address.type === 'InternalIP')?.address || '',
        createdAt: node.metadata?.creationTimestamp || null,
      })),
      pods: (pods.items || []).map((pod) => ({
        namespace: pod.metadata?.namespace || '',
        phase: pod.status?.phase || 'Unknown',
        nodeName: pod.spec?.nodeName || '',
      })),
      namespaces: (namespaces.items || []).map((namespace) => ({
        name: namespace.metadata?.name || '',
        phase: namespace.status?.phase || 'Unknown',
      })),
    };
  }

  async function correlate(systemItems, k8s, fingerprintItems) {
    const nodeIndex = new Map(k8s.nodes.map((node) => [node.name.toLocaleLowerCase(), node]));
    const systemNameCount = systemItems.reduce((counts, system) => {
      for (const name of new Set([system.name, system.hostname].filter(Boolean).map((value) => value.toLocaleLowerCase()))) {
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      return counts;
    }, new Map());
    const correlated = [];
    for (const system of systemItems) {
      const node = nodeIndex.get(system.name.toLocaleLowerCase())
        || nodeIndex.get(system.hostname.toLocaleLowerCase())
        || null;
      const exactName = node && [system.name, system.hostname]
        .filter(Boolean)
        .some((value) => value.toLocaleLowerCase() === node.name.toLocaleLowerCase());
      const uniqueName = node && systemNameCount.get(node.name.toLocaleLowerCase()) === 1;
      const fingerprint = fingerprintItems.get(system.id)?.value || '';
      let identity = node ? 'candidate' : 'unmatched';
      let evidence = null;
      if (node && exactName && uniqueName && fingerprint) {
        if (typeof bindingStore?.ensure === 'function') {
          evidence = await bindingStore.ensure({
            kubernetesNodeUid: node.uid,
            kubernetesNodeName: node.name,
            beszelSystemId: system.id,
            beszelMachineFingerprint: fingerprint,
            observedAt: new Date(clock()).toISOString(),
          });
          identity = evidence?.state === 'verified' ? 'verified' : 'rejected';
        } else {
          identity = 'verified';
          evidence = {
            state: 'verified',
            mode: 'ephemeral-test-adapter',
            kubernetesNodeUid: node.uid,
            beszelSystemId: system.id,
          };
        }
      } else if (node && (!uniqueName || !fingerprint)) {
        identity = !uniqueName ? 'ambiguous' : 'fingerprint-pending';
      }
      correlated.push({
        ...system,
        kubernetes: node,
        binding: identity === 'verified' ? 'matched' : identity,
        identity,
        bindingEvidence: evidence,
        stateAgreement: node ? ((system.status === 'up') === node.ready ? 'agree' : 'disagree') : 'unknown',
      });
    }
    return correlated;
  }

  async function overview() {
    return cached('overview', async () => {
      const [systemItems, k8s, alerts, fingerprintItems] = await Promise.all([
        systems(),
        kubernetes(),
        records('alerts', { sort: '-updated', fields: 'id,system,name,triggered,value,min,updated' }),
        fingerprints(),
      ]);
      const nodes = await correlate(systemItems, k8s, fingerprintItems);
      const podCounts = k8s.pods.reduce((counts, pod) => {
        counts.total += 1;
        counts[pod.phase] = (counts[pod.phase] || 0) + 1;
        return counts;
      }, { total: 0 });
      return {
        provider: { id: 'beszel', versionContract: '0.18.7', mode: 'read-only-adapter' },
        systems: {
          total: nodes.length,
          up: nodes.filter((item) => item.status === 'up').length,
          down: nodes.filter((item) => item.status === 'down').length,
          unmatched: nodes.filter((item) => item.binding !== 'matched').length,
          identityRejected: nodes.filter((item) => item.identity === 'rejected').length,
          disagreement: nodes.filter((item) => item.stateAgreement === 'disagree').length,
        },
        kubernetes: {
          available: k8s.available,
          nodes: k8s.nodes.length,
          nodesReady: k8s.nodes.filter((node) => node.ready).length,
          namespaces: k8s.namespaces.length,
          pods: podCounts,
        },
        alerts: {
          total: alerts.length,
          triggered: alerts.filter((alert) => alert.triggered).length,
        },
        retention: { maximumDays: 30, authority: 'Beszel hierarchical retention' },
      };
    });
  }

  async function nodes() {
    return cached('nodes', async () => {
      const [systemItems, k8s, fingerprintItems] = await Promise.all([systems(), kubernetes(), fingerprints()]);
      return { items: await correlate(systemItems, k8s, fingerprintItems), kubernetesAvailable: k8s.available };
    });
  }

  async function series(systemId, requestedRange) {
    const selected = Object.hasOwn(RANGE, requestedRange) ? requestedRange : '24h';
    const contract = RANGE[selected];
    const since = new Date(clock() - contract.seconds * 1000).toISOString().replace('T', ' ');
    const filter = `system="${String(systemId || '').replace(/"/g, '')}" && created>"${since}" && type="${contract.type}"`;
    const items = await records('system_stats', {
      perPage: 1000,
      sort: '+created',
      fields: 'created,stats,type',
      filter,
    });
    return {
      systemId,
      range: selected,
      resolution: contract.type,
      points: items.map(normalizeStats),
      observedAt: new Date(clock()).toISOString(),
    };
  }

  async function alerts() {
    return cached('alerts', async () => {
      const [active, history] = await Promise.all([
        records('alerts', { sort: '-updated', fields: 'id,system,name,triggered,value,min,updated' }),
        records('alerts_history', { perPage: 200, sort: '-created', fields: 'id,system,name,val,created,resolved' }),
      ]);
      return {
        active: active.map((item) => ({
          id: item.id,
          systemId: item.system,
          metric: item.name,
          triggered: Boolean(item.triggered),
          threshold: number(item.value),
          durationMinutes: number(item.min),
          updatedAt: item.updated || null,
        })),
        history: history.map((item) => ({
          id: item.id,
          systemId: item.system,
          metric: item.name,
          value: number(item.val),
          triggeredAt: item.created || null,
          resolvedAt: item.resolved || null,
        })),
      };
    });
  }

  async function dataHealth() {
    const checkedAt = new Date(clock()).toISOString();
    if (!configured()) {
      return { status: 'unconfigured', checkedAt, provider: 'beszel', adapter: 'v1', reasons: ['reader credential not configured'] };
    }
    try {
      const response = await fetchImpl(`${url}/api/health`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nodeResult = await nodes();
      return {
        status: nodeResult.freshness === 'fresh' ? 'healthy' : 'degraded',
        checkedAt,
        provider: 'beszel',
        adapter: 'v1',
        freshness: nodeResult.freshness,
        observedAt: nodeResult.observedAt,
        systemCount: nodeResult.items.length,
        staleAfterSeconds: 120,
        reasons: nodeResult.upstreamError ? [nodeResult.upstreamError] : [],
      };
    } catch (error) {
      return {
        status: 'unavailable',
        checkedAt,
        provider: 'beszel',
        adapter: 'v1',
        reasons: [error?.msg || error?.message || 'health check failed'],
      };
    }
  }

  return { overview, nodes, series, alerts, dataHealth, normalizeSystem, normalizeStats };
}

module.exports = { createBaselineMonitoring, normalizeSystem, normalizeStats };

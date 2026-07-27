'use strict';

/**
 * `/manage` live fleet overview projection.
 *
 * Supabase host authority owns enrolment and the latest signed agent snapshot.
 * Beszel owns host resource time-series. This module joins those read-only
 * sources without turning either source into a substitute for the other:
 *
 * - agent freshness is the node availability signal;
 * - Beszel supplies CPU/memory/disk point values and the 24-hour trend;
 * - missing or stale evidence is surfaced as attention, never as a measured 0.
 */

const { toHostSummary } = require('./host-api');

const SCHEMA_VERSION = 'rcc.admin.overview/v1';
const HOST_LIMIT = 200;
const METRIC_BINDING_LIMIT = 20;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
const THRESHOLDS = Object.freeze({
  cpuPercent: 80,
  memoryPercent: 85,
  diskPercent: 85,
});

function safeText(value, max = 240) {
  return String(value || '')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function finite(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedPercent(value) {
  const number = finite(value);
  if (number === null) return null;
  return Math.round(Math.min(100, Math.max(0, number)) * 100) / 100;
}

function ratioPercent(used, total) {
  const usedNumber = finite(used);
  const totalNumber = finite(total);
  if (usedNumber === null || totalNumber === null || totalNumber <= 0) return null;
  return boundedPercent((usedNumber / totalNumber) * 100);
}

function snapshotOf(row) {
  const snapshot = Array.isArray(row?.host_snapshot) ? row.host_snapshot[0] : row?.host_snapshot;
  return snapshot && typeof snapshot === 'object' ? snapshot : null;
}

function snapshotMemoryPercent(payload) {
  const total = finite(payload?.resources?.memTotalBytes);
  const available = finite(payload?.resources?.memAvailableBytes);
  if (total === null || available === null || total <= 0) return null;
  return boundedPercent(((total - Math.min(total, Math.max(0, available))) / total) * 100);
}

function snapshotDiskPercent(payload) {
  const filesystems = Array.isArray(payload?.filesystems) ? payload.filesystems : [];
  const root = filesystems.find((filesystem) => filesystem?.mountPoint === '/');
  return root ? ratioPercent(root.usedBytes, root.totalBytes) : null;
}

function metricMap(metrics) {
  return new Map((Array.isArray(metrics) ? metrics : [])
    .filter((result) => result && typeof result.binding === 'string')
    .map((result) => [result.binding, result]));
}

function thresholdReason(label, value, threshold) {
  return value !== null && value >= threshold
    ? `${label} ${value.toFixed(1)}% · 주의 기준 ${threshold}% 이상`
    : '';
}

function projectHost(row, {
  nowMs,
  metricsByBinding,
  metricsConfigured,
  boundHosts,
}) {
  const summary = toHostSummary(row, nowMs);
  const snapshot = snapshotOf(row);
  const payload = snapshot?.payload || {};
  const binding = `${safeText(summary.controlCenterId, 63)}/${safeText(summary.hostId, 63)}`;
  const metric = metricsByBinding.get(binding);
  const metricValue = metric?.ok === true ? metric.value : null;
  const latest = metricValue?.latest || null;
  const cpuPercent = boundedPercent(latest?.cpuPercent);
  const memoryPercent = boundedPercent(latest?.memoryPercent) ?? snapshotMemoryPercent(payload);
  const diskPercent = boundedPercent(latest?.diskPercent) ?? snapshotDiskPercent(payload);
  const reasons = [];
  let state = 'Healthy';

  if (summary.reportState === 'never-reported') {
    state = 'Unavailable';
    reasons.push('등록 후 상태 보고가 한 번도 수신되지 않았습니다.');
  } else if (summary.reportState === 'offline') {
    state = 'Unavailable';
    reasons.push(`마지막 서명 스냅샷이 ${summary.snapshotAgeSeconds}초 전에 수신됐습니다.`);
  } else if (summary.reportState === 'stale') {
    state = 'Degraded';
    reasons.push(`서명 스냅샷 수집이 ${summary.snapshotAgeSeconds}초 지연됐습니다.`);
  }

  if (state !== 'Unavailable' && summary.status !== 'active') {
    state = 'Degraded';
    reasons.push(`호스트 등록 상태가 ${safeText(summary.status, 32)}입니다.`);
  }

  if (state !== 'Unavailable' && Number(summary.failedUnitCount || 0) > 0) {
    state = 'Degraded';
    reasons.push(`실패한 systemd unit ${Number(summary.failedUnitCount)}개`);
  }

  const degradedKeys = (Array.isArray(summary.degradedKeys) ? summary.degradedKeys : [])
    .map((key) => safeText(key, 48))
    .filter(Boolean);
  if (state !== 'Unavailable' && degradedKeys.length) {
    state = 'Degraded';
    reasons.push(`수집 저하: ${degradedKeys.join(', ')}`);
  }

  if (state !== 'Unavailable') {
    for (const reason of [
      thresholdReason('CPU', cpuPercent, THRESHOLDS.cpuPercent),
      thresholdReason('메모리', memoryPercent, THRESHOLDS.memoryPercent),
      thresholdReason('루트 디스크', diskPercent, THRESHOLDS.diskPercent),
    ].filter(Boolean)) {
      state = 'Degraded';
      reasons.push(reason);
    }
  }

  if (state !== 'Unavailable' && boundHosts.has(binding)) {
    if (metric?.ok !== true) {
      state = 'Degraded';
      reasons.push('Beszel 24시간 시계열을 조회하지 못했습니다.');
    } else if (metricValue?.system?.freshness !== 'fresh') {
      state = 'Degraded';
      reasons.push('Beszel 최신 표본이 지연됐습니다.');
    } else if (String(metricValue?.system?.status || '').toLowerCase() !== 'up') {
      state = 'Degraded';
      reasons.push(`Beszel 시스템 상태가 ${safeText(metricValue?.system?.status || 'unknown', 32)}입니다.`);
    }
  } else if (state !== 'Unavailable' && metricsConfigured && !boundHosts.has(binding)) {
    state = 'Degraded';
    reasons.push('Beszel 시계열 바인딩이 없습니다.');
  } else if (state !== 'Unavailable' && !metricsConfigured) {
    state = 'Degraded';
    reasons.push('Beszel 시계열 원천이 구성되지 않았습니다.');
  }

  return {
    controlCenterId: safeText(summary.controlCenterId, 63) || null,
    hostId: safeText(summary.hostId, 63) || null,
    displayName: safeText(summary.displayName || summary.hostname || summary.hostId, 128) || null,
    hostname: safeText(summary.hostname, 253) || null,
    state,
    reasons: reasons.slice(0, 8),
    reportState: safeText(summary.reportState, 32),
    snapshotAgeSeconds: finite(summary.snapshotAgeSeconds),
    collectedAt: summary.collectedAt || null,
    cpuPercent,
    memoryPercent,
    diskPercent,
    failedUnitCount: finite(summary.failedUnitCount),
    degradedKeys,
    metric: {
      configured: metricsConfigured,
      bound: boundHosts.has(binding),
      state: metric?.ok === true
        ? safeText(metricValue?.system?.freshness || 'unknown', 32)
        : (boundHosts.has(binding) ? 'unavailable' : 'not-configured'),
      latestAgeSeconds: metric?.ok === true ? finite(metricValue?.system?.latestAgeSeconds) : null,
    },
  };
}

function successfulMetricResults(metrics) {
  return (Array.isArray(metrics) ? metrics : [])
    .filter((result) => result?.ok === true && result.value && Array.isArray(result.value.points));
}

function aggregateTrend(metrics) {
  const successful = successfulMetricResults(metrics);
  const resolutions = successful
    .map((result) => finite(result.value.resolutionSeconds))
    .filter((value) => value !== null && value > 0);
  const resolutionSeconds = resolutions.length ? Math.max(...resolutions) : null;
  if (!resolutionSeconds) return { resolutionSeconds: null, gapCount: 0, points: [] };

  const bucketMs = resolutionSeconds * 1000;
  const buckets = new Map();
  for (const result of successful) {
    for (const point of result.value.points) {
      const timestampMs = Date.parse(String(point?.timestamp || ''));
      if (!Number.isFinite(timestampMs)) continue;
      const timestamp = Math.floor(timestampMs / bucketMs) * bucketMs;
      const bucket = buckets.get(timestamp) || {
        timestamp,
        cpuSum: 0,
        cpuCount: 0,
        memorySum: 0,
        memoryCount: 0,
        gapBefore: false,
        hosts: new Set(),
      };
      const cpu = boundedPercent(point?.cpuPercent);
      const memory = boundedPercent(point?.memoryPercent);
      if (cpu !== null) {
        bucket.cpuSum += cpu;
        bucket.cpuCount += 1;
      }
      if (memory !== null) {
        bucket.memorySum += memory;
        bucket.memoryCount += 1;
      }
      bucket.gapBefore ||= point?.gapBefore === true;
      bucket.hosts.add(result.binding);
      buckets.set(timestamp, bucket);
    }
  }

  const ordered = [...buckets.values()].sort((left, right) => left.timestamp - right.timestamp);
  const points = ordered.map((bucket, index) => {
    const previous = ordered[index - 1];
    const gapBefore = bucket.gapBefore
      || Boolean(previous && bucket.timestamp - previous.timestamp > bucketMs * 1.5);
    return {
      timestamp: new Date(bucket.timestamp).toISOString(),
      cpuPercent: bucket.cpuCount
        ? Math.round((bucket.cpuSum / bucket.cpuCount) * 100) / 100 : null,
      memoryPercent: bucket.memoryCount
        ? Math.round((bucket.memorySum / bucket.memoryCount) * 100) / 100 : null,
      contributingHosts: bucket.hosts.size,
      gapBefore,
    };
  });
  return {
    resolutionSeconds,
    gapCount: points.filter((point) => point.gapBefore).length,
    points,
  };
}

function beszelSource({
  metricsConfigured,
  metrics,
  boundHostCount,
  fleetHostCount,
  metricBindingsTruncated,
  trend,
}) {
  if (!metricsConfigured) {
    return {
      state: 'NotConfigured',
      detail: 'Beszel readonly 시계열 원천이 구성되지 않았습니다.',
    };
  }
  if (boundHostCount === 0) {
    return {
      state: 'NotConfigured',
      detail: '등록 호스트와 일치하는 Beszel 바인딩이 없습니다.',
    };
  }
  const successful = successfulMetricResults(metrics);
  if (!successful.length) {
    return {
      state: 'Unavailable',
      detail: `Beszel 바인딩 ${boundHostCount}개를 조회하지 못했습니다.`,
    };
  }
  const stale = successful.filter((result) =>
    result.value?.system?.freshness !== 'fresh'
    || String(result.value?.system?.status || '').toLowerCase() !== 'up').length;
  const incomplete = successful.length < boundHostCount
    || boundHostCount < fleetHostCount
    || metricBindingsTruncated
    || stale > 0
    || trend.gapCount > 0
    || trend.points.length === 0;
  return {
    state: incomplete ? 'Degraded' : 'Healthy',
    detail: [
      `24시간 시계열 ${successful.length}/${boundHostCount} 바인딩 조회`,
      `전체 호스트 coverage ${successful.length}/${fleetHostCount}`,
      `${trend.points.length}개 집계점`,
      trend.gapCount ? `gap ${trend.gapCount}` : 'gap 0',
    ].join(' · '),
  };
}

function buildAdminOverview({
  hostRows = [],
  hostTruncated = false,
  metrics = [],
  metricsConfigured = false,
  metricBindings = [],
  metricBindingsTruncated = false,
  generatedAt = new Date().toISOString(),
}) {
  const nowMs = Date.parse(generatedAt);
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const rows = (Array.isArray(hostRows) ? hostRows : []).slice(0, HOST_LIMIT);
  const bindings = (Array.isArray(metricBindings) ? metricBindings : [])
    .map((binding) => safeText(binding, 127))
    .filter(Boolean);
  const boundHosts = new Set(bindings);
  const metricsByBinding = metricMap(metrics);
  const nodes = rows.map((row) => projectHost(row, {
    nowMs: safeNowMs,
    metricsByBinding,
    metricsConfigured,
    boundHosts,
  })).sort((left, right) => {
    const rank = { Unavailable: 0, Degraded: 1, Healthy: 2 };
    return rank[left.state] - rank[right.state]
      || String(left.controlCenterId).localeCompare(String(right.controlCenterId))
      || String(left.hostId).localeCompare(String(right.hostId));
  });
  const trend = aggregateTrend(metrics);
  const successfulHostCount = new Set(successfulMetricResults(metrics).map((result) => result.binding)).size;
  const source = beszelSource({
    metricsConfigured,
    metrics,
    boundHostCount: boundHosts.size,
    fleetHostCount: nodes.length,
    metricBindingsTruncated,
    trend,
  });
  const healthy = nodes.filter((node) => node.state === 'Healthy').length;
  const attention = nodes.filter((node) => node.state === 'Degraded').length;
  const offline = nodes.filter((node) => node.state === 'Unavailable').length;

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(safeNowMs).toISOString(),
    thresholds: THRESHOLDS,
    fleet: {
      observed: nodes.length,
      healthy,
      attention,
      offline,
      healthyPercent: nodes.length ? Math.round((healthy / nodes.length) * 10_000) / 100 : null,
      truncated: hostTruncated === true,
      limit: HOST_LIMIT,
    },
    nodes,
    trend: {
      source: 'Beszel readonly API',
      range: '24h',
      state: source.state,
      detail: source.detail,
      resolutionSeconds: trend.resolutionSeconds,
      gapCount: trend.gapCount,
      boundHostCount: boundHosts.size,
      observedHostCount: successfulHostCount,
      fleetHostCount: nodes.length,
      truncated: metricBindingsTruncated === true,
      points: trend.points,
    },
    sources: {
      hostAuthority: {
        state: 'Healthy',
        detail: `Supabase host authority에서 ${nodes.length}${hostTruncated ? '+' : ''}개 등록 호스트의 최신 서명 스냅샷을 조회했습니다.`,
      },
      beszel: source,
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  HOST_LIMIT,
  METRIC_BINDING_LIMIT,
  THRESHOLDS,
  buildAdminOverview,
  aggregateTrend,
  projectHost,
};

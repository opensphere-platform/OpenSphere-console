'use strict';

const DEFAULT_RUNNING_LEASE_MS = 2 * 60 * 1000;

function classifyInstallReplay(existing, now = Date.now(), leaseMs = DEFAULT_RUNNING_LEASE_MS) {
  if (!existing) return { state: 'new' };
  if (existing.phase !== 'Running') return { state: 'completed' };
  const updatedAt = Date.parse(existing.updated_at || existing.created_at || '');
  if (Number.isFinite(updatedAt) && now - updatedAt < leaseMs) {
    return { state: 'in-flight', retryAfter: Math.max(1, Math.ceil((leaseMs - (now - updatedAt)) / 1000)) };
  }
  return { state: 'recoverable' };
}

module.exports = { DEFAULT_RUNNING_LEASE_MS, classifyInstallReplay };

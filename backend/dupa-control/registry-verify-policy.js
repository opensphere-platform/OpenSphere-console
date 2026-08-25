'use strict';

function createRegistryVerifyRateLimiter({ limit = 6, windowMs = 60_000, now = Date.now, maxKeys = 1_000 } = {}) {
  const buckets = new Map();
  return function check(keyValue) {
    const key = String(keyValue || 'unknown').slice(0, 160);
    const currentTime = now();
    let bucket = buckets.get(key);
    if (!bucket || currentTime - bucket.startedAt >= windowMs) {
      bucket = { startedAt: currentTime, attempts: 0 };
      buckets.set(key, bucket);
    }
    if (bucket.attempts >= limit) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((windowMs - (currentTime - bucket.startedAt)) / 1000)) };
    }
    bucket.attempts += 1;
    if (buckets.size > maxKeys) {
      for (const [candidate, value] of buckets) {
        if (currentTime - value.startedAt >= windowMs) buckets.delete(candidate);
        if (buckets.size <= maxKeys) break;
      }
    }
    return { allowed: true, remaining: Math.max(0, limit - bucket.attempts) };
  };
}

module.exports = { createRegistryVerifyRateLimiter };

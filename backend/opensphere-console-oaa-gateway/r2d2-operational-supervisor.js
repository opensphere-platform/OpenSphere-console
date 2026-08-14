'use strict';

function boundedDelay(attempt, options, random = Math.random) {
  const base = Math.max(1, Number(options.baseDelayMs || 1000));
  const maximum = Math.max(base, Number(options.maxDelayMs || 30000));
  const ratio = Math.max(0, Math.min(1, Number(options.jitterRatio ?? 0.2)));
  const exponential = Math.min(maximum, base * (2 ** Math.max(0, attempt - 1)));
  const jitter = exponential * ratio * ((Number(random()) * 2) - 1);
  return Math.min(maximum, Math.max(0, Math.round(exponential + jitter)));
}

function publicState(state) {
  return JSON.parse(JSON.stringify(state));
}

class OperationalIntelligenceSupervisor {
  constructor(options = {}) {
    for (const dependency of ['initialize', 'check']) {
      if (typeof options[dependency] !== 'function') throw new Error(`${dependency} dependency is required`);
    }
    this.initialize = options.initialize;
    this.check = options.check;
    this.dispose = options.dispose || (async () => undefined);
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.random = options.random || Math.random;
    this.now = options.now || (() => new Date());
    this.onState = options.onState || (() => undefined);
    this.retry = {
      maxAttempts: Math.max(1, Math.min(20, Number(options.maxAttempts || 5))),
      baseDelayMs: Math.max(1, Number(options.baseDelayMs || 1000)),
      maxDelayMs: Math.max(1, Number(options.maxDelayMs || 30000)),
      jitterRatio: Math.max(0, Math.min(1, Number(options.jitterRatio ?? 0.2))),
    };
    this.healthPollMs = Math.max(1000, Number(options.healthPollMs || 15000));
    this.reconnectDelayMs = Math.max(1000, Number(options.reconnectDelayMs || 30000));
    this.resource = null;
    this.inFlight = null;
    this.timer = null;
    this.stopped = true;
    this.state = {
      phase: 'stopped', ready: false, schema: false, readable: false, fresh: false,
      reason: 'operational_supervisor_stopped', attempts: 0, retryExhausted: false,
      observedAt: null, checkedAt: null, lastConnectedAt: null, lastError: null,
    };
  }

  snapshot() { return publicState(this.state); }

  update(patch) {
    this.state = { ...this.state, ...patch, checkedAt: this.now().toISOString() };
    this.onState(this.snapshot());
  }

  schedule(delayMs) {
    if (this.stopped) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.refresh().catch(() => undefined);
    }, delayMs);
    this.timer?.unref?.();
  }

  async start() {
    if (!this.stopped) return this.refresh();
    this.stopped = false;
    this.update({ phase: 'connecting', reason: 'operational_connecting', retryExhausted: false });
    return this.refresh();
  }

  async refresh() {
    if (this.stopped) return this.snapshot();
    if (this.inFlight) return this.inFlight;
    this.inFlight = (this.resource ? this.poll() : this.connect())
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async connect() {
    let lastError = null;
    for (let attempt = 1; attempt <= this.retry.maxAttempts && !this.stopped; attempt += 1) {
      this.update({ phase: 'connecting', attempts: attempt, retryExhausted: false, reason: 'operational_connecting' });
      let candidate = null;
      try {
        candidate = await this.initialize();
        if (!candidate) throw new Error('operational initializer returned no query service');
        const health = await this.check(candidate);
        if (!health?.schema) throw Object.assign(new Error('operational schema is unavailable'), { code: 'operational_schema_not_ready' });
        if (!health?.readable) throw Object.assign(new Error('operational query service is unreadable'), { code: 'operational_query_unavailable' });
        this.resource = candidate;
        this.update({
          phase: health.fresh ? 'ready' : 'degraded', ready: Boolean(health.ready), schema: true,
          readable: true, fresh: Boolean(health.fresh), reason: health.reason || null,
          observedAt: health.observedAt || null, lastConnectedAt: this.now().toISOString(), lastError: null,
        });
        this.schedule(this.healthPollMs);
        return this.snapshot();
      } catch (error) {
        lastError = error;
        if (candidate) await this.dispose(candidate).catch(() => undefined);
        this.resource = null;
        this.update({
          phase: 'connecting', ready: false, schema: false, readable: false, fresh: false,
          reason: String(error?.code || 'operational_initialization_failed'),
          lastError: String(error?.message || error).slice(0, 240),
        });
        if (attempt < this.retry.maxAttempts && !this.stopped) {
          await this.sleep(boundedDelay(attempt, this.retry, this.random));
        }
      }
    }
    if (!this.stopped) {
      this.update({
        phase: 'retry_exhausted', ready: false, schema: false, readable: false, fresh: false,
        reason: String(lastError?.code || 'operational_retry_exhausted'), retryExhausted: true,
        lastError: String(lastError?.message || lastError || 'operational initialization failed').slice(0, 240),
      });
      this.schedule(this.reconnectDelayMs);
    }
    return this.snapshot();
  }

  async poll() {
    try {
      const health = await this.check(this.resource);
      if (!health?.schema || !health?.readable) {
        const code = !health?.schema ? 'operational_schema_not_ready' : 'operational_query_unavailable';
        throw Object.assign(new Error(code), { code });
      }
      this.update({
        phase: health.fresh ? 'ready' : 'degraded', ready: Boolean(health.ready), schema: true,
        readable: true, fresh: Boolean(health.fresh), reason: health.reason || null,
        observedAt: health.observedAt || null, retryExhausted: false, lastError: null,
      });
      this.schedule(this.healthPollMs);
      return this.snapshot();
    } catch (error) {
      const failed = this.resource;
      this.resource = null;
      if (failed) await this.dispose(failed).catch(() => undefined);
      this.update({
        phase: 'reconnecting', ready: false, schema: false, readable: false, fresh: false,
        reason: String(error?.code || 'operational_query_unavailable'),
        lastError: String(error?.message || error).slice(0, 240),
      });
      return this.connect();
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    const current = this.resource;
    this.resource = null;
    if (current) await this.dispose(current).catch(() => undefined);
    this.update({
      phase: 'stopped', ready: false, schema: false, readable: false, fresh: false,
      reason: 'operational_supervisor_stopped', retryExhausted: false,
    });
    return this.snapshot();
  }
}

module.exports = { boundedDelay, OperationalIntelligenceSupervisor };

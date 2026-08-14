'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boundedDelay, OperationalIntelligenceSupervisor } = require('./r2d2-operational-supervisor');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'app', 'pages', 'admin-oaa.ts'), 'utf8');

function supervisorFixture(overrides = {}) {
  const scheduled = [];
  const disposed = [];
  let now = 0;
  const supervisor = new OperationalIntelligenceSupervisor({
    initialize: overrides.initialize || (async () => ({ id: 'query' })),
    check: overrides.check || (async () => ({ ready: true, schema: true, readable: true, fresh: true, observedAt: '2026-08-14T00:00:00Z' })),
    dispose: async (resource) => { disposed.push(resource); },
    sleep: overrides.sleep || (async () => undefined), random: () => 0.5,
    now: () => new Date(now += 1000), maxAttempts: overrides.maxAttempts || 3,
    baseDelayMs: 10, maxDelayMs: 40, healthPollMs: 1000, reconnectDelayMs: 1000,
    setTimer: (callback, delay) => { const timer = { callback, delay, unref() {} }; scheduled.push(timer); return timer; },
    clearTimer: () => undefined,
  });
  return { supervisor, scheduled, disposed };
}

test('bounded exponential backoff is capped and jitter remains bounded', () => {
  assert.equal(boundedDelay(1, { baseDelayMs: 100, maxDelayMs: 250, jitterRatio: 0.2 }, () => 0.5), 100);
  assert.equal(boundedDelay(5, { baseDelayMs: 100, maxDelayMs: 250, jitterRatio: 0.2 }, () => 1), 250);
  assert.equal(boundedDelay(5, { baseDelayMs: 100, maxDelayMs: 250, jitterRatio: 0.2 }, () => 0), 200);
  for (const random of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(boundedDelay(20, { baseDelayMs: 100, maxDelayMs: 250, jitterRatio: 1 }, () => random) <= 250);
  }
});

test('startup database outage recovers with bounded retry and one shared in-flight start', async () => {
  let calls = 0;
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const fixture = supervisorFixture({ initialize: async () => {
    calls += 1;
    if (calls === 1) { await first; throw Object.assign(new Error('db unavailable'), { code: 'postgres_unreachable' }); }
    return { id: 'recovered' };
  } });
  const one = fixture.supervisor.start();
  const two = fixture.supervisor.start();
  release();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(calls, 2);
  assert.equal(a.ready, true); assert.equal(b.ready, true);
  assert.equal(fixture.scheduled.at(-1).delay, 1000);
});

test('retry exhaustion is explicit and schedules a later reconnect cycle', async () => {
  const fixture = supervisorFixture({ initialize: async () => { throw Object.assign(new Error('dns'), { code: 'postgres_unreachable' }); }, maxAttempts: 2 });
  const state = await fixture.supervisor.start();
  assert.equal(state.phase, 'retry_exhausted'); assert.equal(state.retryExhausted, true);
  assert.equal(state.reason, 'postgres_unreachable');
  assert.equal(fixture.scheduled.at(-1).delay, 1000);
});

test('health poll reconnects an unreadable query service without overlapping resources', async () => {
  let generations = 0; let checks = 0;
  const fixture = supervisorFixture({
    initialize: async () => ({ id: ++generations }),
    check: async () => {
      checks += 1;
      if (checks === 2) return { ready: false, schema: true, readable: false, fresh: false, reason: 'operational_query_unavailable' };
      return { ready: true, schema: true, readable: true, fresh: true };
    },
  });
  await fixture.supervisor.start();
  const state = await fixture.supervisor.refresh();
  assert.equal(generations, 2); assert.equal(state.ready, true);
  assert.deepEqual(fixture.disposed.map((item) => item.id), [1]);
});

test('fresh runtime projection cannot make a stale operational graph ready', async () => {
  const fixture = supervisorFixture({ check: async () => ({ ready: false, schema: true, readable: true, fresh: false, reason: 'operational_graph_stale' }) });
  const state = await fixture.supervisor.start();
  assert.equal(state.phase, 'degraded'); assert.equal(state.ready, false);
  assert.equal(state.schema, true); assert.equal(state.readable, true); assert.equal(state.fresh, false);
});

test('shutdown clears polling and disposes the active query service', async () => {
  const fixture = supervisorFixture();
  await fixture.supervisor.start();
  const state = await fixture.supervisor.stop();
  assert.equal(state.phase, 'stopped'); assert.equal(state.ready, false);
  assert.equal(fixture.disposed.length, 1);
});

test('gateway readiness separates core health from required operational truth', () => {
  for (const component of ['operationalQueryService', 'operationalSchema', 'operationalReadable', 'operationalFresh']) {
    assert.match(serverSource, new RegExp(`${component}:`));
  }
  assert.match(serverSource, /coreReady: true,\s+operationalReady/);
  assert.match(serverSource, /ready: operationalReady/);
  assert.match(serverSource, /const status = !readiness\.ready \? 'not_ready'/);
  assert.match(serverSource, /ok: readiness\.ready/);
  assert.match(serverSource, /const degraded = !readiness\.ready/);
});

test('operational queries use a dedicated bounded pool instead of the watch projection pool', () => {
  assert.match(serverSource, /function getR2d2QueryPool\(\)[\s\S]*max: 4[\s\S]*\[r2d2-query-db\]/);
  assert.match(serverSource, /initializeOperationalIntelligence\(\)[\s\S]*const queryPool = getR2d2QueryPool\(\)/);
  assert.match(serverSource, /if \(r2d2QueryPool\) void r2d2QueryPool\.end\(\)/);
});

test('admin OAA derives the operational badge from the server health projection', () => {
  assert.doesNotMatch(adminSource, /Operational runtime ON/);
  assert.match(adminSource, /Operational runtime \{\{ operationalRuntimeLabel\(\) \}\}/);
  assert.match(adminSource, /const operational = this\.health\(\)\?\.operational/);
  assert.match(adminSource, /if \(operational\.ready\) return 'READY'/);
});

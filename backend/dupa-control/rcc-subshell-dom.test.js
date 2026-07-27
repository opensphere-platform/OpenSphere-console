'use strict';

/**
 * DOM contract for the linux-host-manager subShell.
 *
 * The subShell renders control-center data and host-reported strings into the
 * operator's console. Two things have to hold no matter what a host reports:
 * nothing it sends can become markup, and no control appears enabled that the
 * operator is not actually permitted to use — a button that fails on click
 * teaches people to ignore the interface.
 *
 * The shell runs the real module against a minimal DOM built here rather than a
 * browser engine, because the platform carries no test-only runtime
 * dependencies. The stub implements only what the module uses, and records
 * enough structure for the assertions below to be meaningful.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const entryPath = path.join(repoRoot, 'deploy/rcc/subshells/linux-host-manager/entry.js');

// ── a small DOM ──────────────────────────────────────────────────────────────

class StubNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.classList = { add: (c) => { this.className = `${this.className || ''} ${c}`.trim(); } };
    this._text = '';
    this.disabled = false;
    this.parentNode = null;
  }

  set textContent(value) {
    // Setting textContent replaces children, exactly as the DOM does. Crucially
    // it never parses markup: that is the property under test.
    this.children = [];
    this._text = String(value ?? '');
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    for (const node of nodes) this.appendChild(node);
  }

  removeChild(child) {
    this.children = this.children.filter((node) => node !== child);
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  dispatch(type, event = { preventDefault() {} }) {
    for (const handler of this.listeners[type] || []) handler(event);
  }

  querySelectorAll(selector) {
    const tag = String(selector).toUpperCase();
    return this.descendants().filter((node) => node.tagName === tag);
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

function installDom() {
  const head = new StubNode('head');
  const registry = new Map();
  const previous = {
    document: globalThis.document,
    customElements: globalThis.customElements,
    HTMLElement: globalThis.HTMLElement,
    window: globalThis.window,
    location: globalThis.location,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };

  // The element refreshes on a timer. Letting a real timer run would hold the
  // process open for a minute per test and would make rendering depend on the
  // clock, so the timer is recorded rather than scheduled and the tests drive
  // rendering directly.
  const timers = { started: [], cleared: [] };
  globalThis.setInterval = (fn, ms) => {
    timers.started.push({ fn, ms });
    return timers.started.length;
  };
  globalThis.clearInterval = (token) => { timers.cleared.push(token); };

  globalThis.HTMLElement = StubNode;
  globalThis.document = {
    head,
    createElement: (tag) => new StubNode(tag),
    createElementNS: (_namespace, tag) => new StubNode(tag),
    createTextNode: (value) => {
      const node = new StubNode('#text');
      node.textContent = value;
      return node;
    },
    querySelectorAll: (selector) => head.querySelectorAll(selector),
  };
  globalThis.customElements = {
    define: (name, klass) => registry.set(name, klass),
    get: (name) => registry.get(name),
  };
  globalThis.window = globalThis;
  globalThis.location = { pathname: '/cc/cc2/plugins/linux-host-manager' };

  return {
    registry,
    timers,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

/** Loads the real subShell against the stub DOM and mounts one element. */
async function mount(fixtures = {}) {
  const dom = installDom();
  const calls = [];
  const responses = {
    host: fixtures.host ?? hostDetail(),
    operations: fixtures.operations ?? { items: [] },
    metrics: fixtures.metrics ?? metricsFixture(),
    ...fixtures.responses,
  };

  // A response the module can actually consume: submits read the body as text
  // and parse it themselves, so a stub that only answers json() would make
  // every submission look like a transport fault rather than a request.
  const reply = (ok, status, payload) => ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });

  const ctx = {
    api: {
      fetch: async (route, init = {}) => {
        const method = init.method || 'GET';
        // Recorded parsed, so a test can assert the exact operation, packages
        // and versions that would reach the server.
        let body = null;
        try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
        calls.push({ route, method, body });
        const fail = fixtures.failRoutes?.[routeKind(route)];  // mutable: a fault can clear
        if (fail) return reply(false, fail, { error: `HTTP ${fail}` });
        if (method === 'POST') {
          if (fixtures.failPost) {
            const { status = 403, error = 'the request was refused' } = fixtures.failPost;
            return reply(false, status, { error });
          }
          return reply(true, 202, fixtures.acceptPost
            ?? { id: 'a0000000-0000-0000-0000-00000000000f', status: 'awaiting_approval' });
        }
        return reply(true, 200, payloadFor(routeKind(route), responses));
      },
    },
    extensions: { registerPage: () => {} },
  };

  const module = await import(`${entryPath}?dom=${Math.random().toString(36).slice(2)}`);
  module.activate(ctx);
  const Element = dom.registry.get('os-linux-host-manager');
  assert.ok(Element, 'the subShell must define its custom element');
  const node = new Element();
  // `responses` is handed back so a test can change what the host reports
  // between one poll and the next, which is how drift is exercised.
  return { dom, node, calls, module, responses };
}

/**
 * Lets every already-queued promise settle, without touching the clock.
 *
 * A submission is a chain of awaits — POST, then a re-read of the operation
 * list, then the page clearing itself. Two hops drain all of it.
 */
function settle() {
  return new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });
}

function routeKind(route) {
  if (/\/metrics(?:\?|$)/.test(route)) return 'metrics';
  if (/\/operations\/[0-9a-f-]{36}$/.test(route)) return 'operationDetail';
  if (route.endsWith('/operations')) return 'operations';
  if (/\/hosts\/[^/]+$/.test(route)) return 'host';
  if (route.endsWith('/hosts')) return 'hosts';
  return 'other';
}

function payloadFor(kind, responses) {
  switch (kind) {
    // A whole list response can be supplied when the fleet projection itself is
    // under test; otherwise the single detail fixture stands in for the list.
    case 'hosts': return responses.hosts
      ?? { items: [responses.host], generatedAt: '2026-08-01T12:00:00.000Z' };
    case 'host': return { host: responses.host };
    case 'metrics': return responses.metrics;
    case 'operations': return responses.operations;
    case 'operationDetail': return responses.operationDetail ?? { operation: null, events: [] };
    default: return {};
  }
}

function capability(overrides = {}) {
  const on = { supported: true, reason: '', permitted: true };
  return {
    'journal.query': { ...on },
    'service.restart': { ...on, allowlist: ['chronyd.service'], granted: ['chronyd.service'], reported: ['chronyd.service'], drift: { onlyGranted: [], onlyReported: [] } },
    'host.reboot': { ...on },
    'package.refresh': { ...on, operation: 'package.refresh' },
    'package.update': { ...on, operation: 'package.update' },
    'kernel.update': { ...on, operation: 'kernel.update' },
    'ssh.protection.enable': { ...on, operation: 'ssh.protection.enable' },
    'ssh.ban': { ...on, operation: 'ssh.ban' },
    'ssh.unban': { ...on, operation: 'ssh.unban' },
    approve: { ...on },
    reject: { ...on },
    cancel: { ...on },
    ...overrides,
  };
}

/** The package projection as host-api emits it, so tests share one shape. */
function packagesFixture(overrides = {}) {
  return {
    manager: 'apt', supported: true, unsupportedReason: '', metadataAgeSeconds: 3600,
    pendingTotal: 2, pendingSecurity: 1, truncated: false,
    collectedAt: '2026-08-01T11:59:00.000Z',
    pending: [
      { name: 'openssl', currentVersion: '3.0.13-1', candidateVersion: '3.0.13-2', security: true, origin: 'Ubuntu:24.04/noble-security' },
      { name: 'curl', currentVersion: '8.5.0-1', candidateVersion: '8.5.0-2', security: false, origin: 'Ubuntu:24.04/noble-updates' },
    ],
    ...overrides,
  };
}

function metricsFixture(overrides = {}) {
  const points = [
    {
      timestamp: '2026-08-01T11:57:00.000Z',
      cpuPercent: 12.5,
      memoryTotalBytes: 24 * 1024 ** 3,
      memoryUsedBytes: 8 * 1024 ** 3,
      memoryPercent: 33.3,
      diskTotalBytes: 200 * 1024 ** 3,
      diskUsedBytes: 50 * 1024 ** 3,
      diskPercent: 25,
      diskReadBytesPerSecond: 1024,
      diskWriteBytesPerSecond: 2048,
      networkSendBytesPerSecond: 4096,
      networkReceiveBytesPerSecond: 8192,
      load1: 0.3,
      load5: 0.2,
      load15: 0.1,
      gapBefore: false,
    },
    {
      timestamp: '2026-08-01T11:58:00.000Z',
      cpuPercent: 20,
      memoryTotalBytes: 24 * 1024 ** 3,
      memoryUsedBytes: 9 * 1024 ** 3,
      memoryPercent: 37.5,
      diskTotalBytes: 200 * 1024 ** 3,
      diskUsedBytes: 51 * 1024 ** 3,
      diskPercent: 25.5,
      diskReadBytesPerSecond: 4096,
      diskWriteBytesPerSecond: 1024,
      networkSendBytesPerSecond: 2048,
      networkReceiveBytesPerSecond: 16384,
      load1: 0.5,
      load5: 0.3,
      load15: 0.2,
      gapBefore: false,
    },
  ];
  return {
    schemaVersion: 'rcc.host.metrics/v1',
    source: { name: 'Beszel', agentVersion: '0.18.7', mode: 'readonly-api' },
    controlCenterId: 'cc2',
    hostId: 'node-a',
    range: '1h',
    sourceResolution: '1m',
    resolutionSeconds: 60,
    generatedAt: '2026-08-01T11:59:00.000Z',
    system: {
      name: 'NODE-A',
      status: 'up',
      freshness: 'fresh',
      latestAgeSeconds: 60,
    },
    points,
    latest: points.at(-1),
    warnings: [],
    ...overrides,
  };
}

function hostDetail(overrides = {}) {
  return {
    hostId: 'node-a',
    displayName: 'node-a',
    status: 'active',
    // The names the host API actually projects. Whether a request may bind
    // itself to the versions below is decided from reportState and the package
    // index age, so a fixture that omits them exercises a shape the backend
    // never sends.
    reportState: overrides.reportState ?? 'fresh',
    snapshotAgeSeconds: overrides.snapshotAgeSeconds ?? 60,
    collectedAt: '2026-08-01T11:59:00.000Z',
    enrolledAt: '2026-07-01T00:00:00.000Z',
    receivedAt: '2026-08-01T11:59:00.000Z',
    schemaVersion: 'rcc.host.snapshot/v1',
    capabilities: {
      readSnapshot: true,
      services: { supported: true, reason: '' },
      journal: { supported: true, reason: '' },
      network: { supported: false, reason: 'network mutation is not implemented' },
      storage: { supported: false, reason: 'storage mutation is not implemented' },
      sshBan: { supported: true, reason: '' },
      // host-api derives this one from package.update and kernel.update, so it
      // follows those rather than standing on its own.
      updates: overrides.updates === undefined
        ? { supported: true, reason: '' } : overrides.updates,
      operations: capability(overrides.operations),
    },
    packages: overrides.packages === undefined ? packagesFixture() : overrides.packages,
    kernel: overrides.kernel === undefined ? {
      running: '6.8.0-45-generic', installedLatest: '6.8.0-51-generic',
      candidate: '6.8.0-51-generic', updateAvailable: true, rebootRequired: true,
      rebootRequiredPackages: ['linux-image-6.8.0-51-generic'],
      collectedAt: '2026-08-01T11:59:00.000Z',
    } : overrides.kernel,
    sshBan: overrides.sshBan === undefined ? {
      provider: 'fail2ban', jail: 'sshd', installed: true, active: true, supported: true,
      currentlyFailed: 1, totalFailed: 12, currentlyBanned: 1, totalBanned: 4,
      bannedAddresses: ['198.51.100.9'], banTimeSeconds: 600, findTimeSeconds: 600,
      maxRetry: 5, truncated: false, collectedAt: '2026-08-01T11:59:00.000Z',
    } : overrides.sshBan,
    policy: overrides.policy === undefined ? {
      id: 'c0000000-0000-0000-0000-000000000001', name: 'CC2 nightly',
      scope: 'control-center', version: 3, timezone: 'Europe/Berlin',
      allowedOperations: [
        'package.refresh', 'package.update', 'kernel.update', 'ssh.protection.enable',
      ],
      emergencyAllowed: false, enabled: true, inWindow: true,
      windowEndsAt: '2026-08-01T13:00:00.000Z',
      windows: [{ id: 'd1', dayOfWeek: 0, startTime: '02:00:00', durationMinutes: 120, enabled: true }],
    } : overrides.policy,
    snapshot: overrides.snapshot === undefined
      ? {
        identity: { hostname: 'node-a' },
        operations: {
          packageAllowlist: ['curl', 'openssl'],
          sshBanEnabled: true,
          sshProtectedAddresses: ['203.0.113.10'],
        },
      }
      : overrides.snapshot,
    ...overrides.host,
  };
}

function operation(overrides = {}) {
  return {
    id: 'a0000000-0000-0000-0000-000000000003',
    hostId: 'node-a',
    controlCenterId: 'cc2',
    operation: 'service.restart',
    parameters: { unit: 'chronyd.service' },
    reason: 'restart chronyd after clock drift',
    status: 'awaiting_approval',
    riskLevel: 'high',
    requiresSecondPerson: true,
    requestedBy: '11111111-1111-1111-1111-111111111111',
    approvedBy: null,
    createdAt: '2026-08-01T11:00:00.000Z',
    attempt: 0,
    viewer: { isRequester: false, isApprover: false },
    ...overrides,
  };
}

function buttons(node) {
  return node.querySelectorAll('button');
}

function findButton(node, label) {
  return buttons(node).find((button) => button.textContent === label);
}

// ── the module loads at all ──────────────────────────────────────────────────

test('the subShell defines its element and registers exactly one page', async () => {
  const dom = installDom();
  try {
    const pages = [];
    const module = await import(`${entryPath}?reg=${Math.random().toString(36).slice(2)}`);
    module.activate({
      api: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
      extensions: { registerPage: (page) => pages.push(page) },
    });
    assert.equal(pages.length, 1);
    assert.equal(pages[0].id, 'linux-host-manager');
    assert.ok(dom.registry.get('os-linux-host-manager'));
  } finally {
    dom.restore();
  }
});

test('the subShell refuses to activate without the capabilities it needs', async () => {
  const dom = installDom();
  try {
    const module = await import(`${entryPath}?caps=${Math.random().toString(36).slice(2)}`);
    assert.throws(() => module.activate({ extensions: { registerPage: () => {} } }), /api:proxy/);
    assert.throws(() => module.activate({ api: { fetch: async () => {} } }), /page:register/);
  } finally {
    dom.restore();
  }
});

// ── untrusted text never becomes markup ─────────────────────────────────────

test('host-reported text is rendered as text, never as markup', async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const { dom, node } = await mount({
    host: hostDetail({
      host: { displayName: hostile },
      snapshot: { identity: { hostname: hostile } },
    }),
  });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');

    const rendered = node.textContent;
    assert.ok(rendered.includes(hostile), 'the value must be shown, escaped, not dropped');
    // Nothing anywhere created an element from it.
    const tags = node.descendants().map((child) => child.tagName);
    assert.ok(!tags.includes('IMG'), 'a reported string must not become an element');
    assert.ok(!tags.includes('SCRIPT'));
    for (const child of node.descendants()) {
      assert.equal(child.attributes.onerror, undefined);
      assert.equal(child.attributes.src, undefined);
    }
  } finally {
    dom.restore();
  }
});

// ── the fleet list says how much of the fleet it is ─────────────────────────

function fleetOf(count) {
  return Array.from({ length: count }, (_, i) => ({
    hostId: `node-${String(i).padStart(3, '0')}`,
    displayName: `node-${String(i).padStart(3, '0')}`,
    hostname: `node-${String(i).padStart(3, '0')}.cc2.opl.io.kr`,
    reportState: 'fresh',
    snapshotAgeSeconds: 12,
    degradedKeys: [],
  }));
}

async function renderFleetList(list) {
  const { dom, node } = await mount({ responses: { hosts: list } });
  try {
    node.connectedCallback();
    await node.refresh();
    return node.textContent;
  } finally {
    dom.restore();
  }
}

test('a fleet cut off at the page bound says so instead of counting up to it', async () => {
  // The API stops at 200 and reports truncated. Rendering a bare "Fleet (200)"
  // makes a cut-off page indistinguishable from a region that has exactly 200
  // hosts, and an operator looking for a host that is enrolled and reporting
  // would conclude it is not there.
  const rendered = await renderFleetList({
    items: fleetOf(200), truncated: true, limit: 200, generatedAt: '2026-08-01T12:00:00.000Z',
  });
  assert.match(rendered, /Fleet \(first 200\)/, 'the heading must not read as a count of the region');
  assert.doesNotMatch(rendered, /Fleet \(200\)/, 'the bare count is the claim being corrected');
  assert.match(rendered, /Only the first 200 hosts are shown/);
  assert.match(rendered, /cut off, not complete/);
});

test('a fleet that exactly fills the page is shown as complete', async () => {
  // Same 200 rows, truncated false. This is the case the fix must not spoil:
  // a region with exactly a page of hosts is whole, and warning about it would
  // teach operators to ignore the warning.
  const rendered = await renderFleetList({
    items: fleetOf(200), truncated: false, limit: 200, generatedAt: '2026-08-01T12:00:00.000Z',
  });
  assert.match(rendered, /Fleet \(200\)/);
  assert.doesNotMatch(rendered, /Only the first/);
  assert.doesNotMatch(rendered, /cut off/);
});

test('an empty fleet still says it is empty rather than cut off', async () => {
  const rendered = await renderFleetList({
    items: [], truncated: false, limit: 200, generatedAt: '2026-08-01T12:00:00.000Z',
  });
  assert.match(rendered, /Fleet \(0\)/);
  assert.match(rendered, /No hosts are enrolled in this control center/);
  assert.doesNotMatch(rendered, /Only the first/);
});

test('a list response that omits the truncation fields is treated as complete', async () => {
  // An older backend sends neither field. Defaulting to "cut off" would put a
  // permanent false warning on every region.
  const rendered = await renderFleetList({
    items: fleetOf(3), generatedAt: '2026-08-01T12:00:00.000Z',
  });
  assert.match(rendered, /Fleet \(3\)/);
  assert.doesNotMatch(rendered, /Only the first/);
});

test('the collectors that failed are named on the screen, through the real projection', async () => {
  // Driven through toHostDetail rather than a hand-built fixture, because the
  // defect this pins was a field the screen read and the API never sent: the
  // host header asked for degradedKeys, the projection published degradedCount
  // and the key list only deep inside the snapshot. Every hand-written fixture
  // agreed with the screen, so nothing failed while a host whose root
  // filesystem could not be read rendered exactly like a healthy one.
  const { toHostDetail } = require('../opensphere-console-backend/host-api');
  const collectedAt = new Date(Date.now() - 30_000).toISOString();
  const detail = toHostDetail({
    id: '2b0f3f6c-9f3a-4d1e-8a55-1d2c3b4a5e6f',
    host_id: 'node-a',
    display_name: 'node-a',
    control_center_id: 'cc2',
    status: 'active',
    enrolled_at: '2026-07-01T00:00:00.000Z',
    host_snapshot: {
      schema_version: 'rcc.host.snapshot/v1',
      agent_version: '0.1.0-cc2',
      collected_at: collectedAt,
      received_at: collectedAt,
      payload: {
        identity: { hostname: 'node-a.cc2.opl.io.kr' },
        resources: {},
        filesystems: [],
        network: [],
        systemd: { available: false },
        degraded: ['mountNamespace', 'systemd'],
      },
    },
  });

  const { dom, node } = await mount({ host: detail });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    const rendered = node.textContent;
    assert.match(rendered, /Collector degraded/,
      'a host with failed collectors must say so where its status is shown');
    assert.match(rendered, /mountNamespace/);
    assert.match(rendered, /systemd/);
  } finally {
    dom.restore();
  }
});

test('the module never uses an HTML-parsing sink', () => {
  const source = fs.readFileSync(entryPath, 'utf8');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) {
    // The one permitted mention is the comment that explains the rule.
    const uses = source.split('\n').filter((line) => {
      const trimmed = line.trim();
      const isComment = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
      return line.includes(sink) && !isComment;
    });
    assert.deepEqual(uses, [], `${sink} must not be used: ${uses.join(' | ')}`);
  }
});

test('long untrusted output is bounded before it reaches the DOM', async () => {
  const enormous = 'x'.repeat(400_000);
  const { dom, node } = await mount({
    host: hostDetail({ snapshot: { identity: { hostname: 'node-a' }, journal: { text: enormous } } }),
    operations: { items: [operation({ status: 'succeeded', result: { output: enormous } })] },
  });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'operations';
    node.render();
    assert.ok(node.textContent.length < 200_000,
      `a host must not be able to render an unbounded document (${node.textContent.length} chars)`);
  } finally {
    dom.restore();
  }
});

// ── Beszel metrics are expressed inside RCC without exposing its credential ─

test('the Metrics tab renders Beszel summaries and bounded time-series charts', async () => {
  const { dom, node, calls } = await mount();
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'metrics';
    node.render();

    const rendered = node.textContent;
    assert.match(rendered, /Beszel host metrics/);
    assert.match(rendered, /Beszel agent 0\.18\.7/);
    assert.match(rendered, /CPU.*20%/s);
    assert.match(rendered, /Memory.*37\.5%/s);
    assert.match(rendered, /Root disk.*25\.5%/s);
    assert.match(rendered, /Network throughput/);
    assert.match(rendered, /Disk throughput/);
    assert.match(rendered, /Load average/);
    assert.ok(node.querySelectorAll('svg').length >= 6, 'each metric group should have a chart');
    assert.ok(node.querySelectorAll('polyline').length >= 8, 'charts must contain real time-series lines');
    assert.ok(calls.some((call) => call.route.endsWith('/hosts/node-a/metrics?range=1h')),
      'the tab data must come from the RCC Beszel adapter');
    assert.doesNotMatch(rendered, /password|PocketBase token/i,
      'the screen must describe the boundary without rendering credential material');
  } finally {
    dom.restore();
  }
});

test('changing the Metrics range requests the reviewed Beszel resolution through RCC', async () => {
  const { dom, node, calls } = await mount();
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'metrics';
    node.render();

    const range = node.descendants().find((item) => item.tagName === 'SELECT'
      && item.getAttribute('aria-label') === 'Metrics time range');
    assert.ok(range);
    range.value = '24h';
    range.dispatch('change');
    await settle();

    assert.ok(calls.some((call) => call.route.endsWith('/hosts/node-a/metrics?range=24h')));
    assert.equal(node._metricsRange, '24h');
  } finally {
    dom.restore();
  }
});

test('a Beszel outage degrades only Metrics and does not erase RCC host state', async () => {
  const { dom, node } = await mount({ failRoutes: { metrics: 503 } });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    assert.equal(node._detail?.hostId, 'node-a', 'the RCC host detail remains available');

    node._section = 'metrics';
    node.render();
    assert.match(node.textContent, /HTTP 503|metrics are unavailable/i);
    assert.match(node.textContent, /Host inventory and governed operations remain independent/);

    node._section = 'overview';
    node.render();
    assert.match(node.textContent, /Hostname/);
  } finally {
    dom.restore();
  }
});

// ── controls match the operator's real authority ────────────────────────────

test('a control the operator may not use is shown, disabled, with the reason', async () => {
  const { dom, node } = await mount({
    host: hostDetail({
      operations: {
        'journal.query': { supported: true, reason: 'requires console.hosts.journal', permitted: false },
      },
    }),
  });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'journal';
    node.render();

    const run = findButton(node, 'Run journal query');
    assert.ok(run, 'the control must still be visible, not hidden');
    assert.equal(run.disabled, true);
    assert.equal(run.getAttribute('aria-disabled'), 'true', 'assistive technology must be told');
    assert.match(run.title, /console\.hosts\.journal/, 'the reason must say what is missing');
    // A disabled control must have no way to fire.
    assert.deepEqual(run.listeners.click, undefined);
  } finally {
    dom.restore();
  }
});

test('a viewer is offered no decision at all', async () => {
  const denied = { supported: true, reason: 'requires console.hosts.approve', permitted: false };
  const { dom, node } = await mount({
    host: hostDetail({ operations: { approve: denied, reject: denied, cancel: { ...denied, reason: 'requires console.hosts.operate' } } }),
    operations: { items: [operation()] },
    responses: { operationDetail: { operation: operation(), events: [] } },
  });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'operations';
    await node.openOperation(operation().id);

    for (const label of ['Approve', 'Reject', 'Cancel']) {
      const button = findButton(node, label);
      assert.ok(button, `${label} must remain visible`);
      assert.equal(button.disabled, true, `${label} must be disabled for a viewer`);
      assert.equal(button.getAttribute('aria-disabled'), 'true');
      assert.match(button.title, /requires console\.hosts\./, `${label} must say which permission is missing`);
    }
  } finally {
    dom.restore();
  }
});

test('the requester is told why they cannot approve their own request', async () => {
  const own = operation({ viewer: { isRequester: true, isApprover: false } });
  const { dom, node } = await mount({
    operations: { items: [own] },
    responses: { operationDetail: { operation: own, events: [] } },
  });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'operations';
    await node.openOperation(own.id);

    const approve = findButton(node, 'Approve');
    assert.equal(approve.disabled, true, 'two-person review must be enforced in the interface too');
    assert.match(approve.title, /different administrator/i);
    assert.match(approve.title, /you requested this operation/i);

    // Rejecting and cancelling your own request are still legitimate.
    assert.equal(findButton(node, 'Cancel').disabled, false);
  } finally {
    dom.restore();
  }
});

test('approval is withheld when the server did not say who the reader is', async () => {
  // `viewer` is the server's statement about this reader. Without it the
  // console cannot tell the requester from a second person, and a console that
  // guesses "not the requester" is a console that offers to break the rule.
  for (const viewer of [null, undefined]) {
    const anonymous = operation({ viewer });
    const { dom, node } = await mount({
      operations: { items: [anonymous] },
      responses: { operationDetail: { operation: anonymous, events: [] } },
    });
    try {
      node.connectedCallback();
      await node.refresh();
      await node.select('node-a');
      node._section = 'operations';
      await node.openOperation(anonymous.id);

      const approve = findButton(node, 'Approve');
      assert.equal(approve.disabled, true,
        `an unknown viewer must not be offered Approve (viewer=${String(viewer)})`);
      assert.match(approve.title, /did not say who you are/i);
      // Rejecting is not the thing two-person review protects.
      assert.equal(findButton(node, 'Reject').disabled, false);
    } finally {
      dom.restore();
    }
  }
});

test('a low-risk operation is still approvable by its own requester', async () => {
  // The fail-closed rule above must not spread to operations the platform
  // accepts from one administrator: package.refresh changes nothing.
  const own = operation({
    operation: 'package.refresh', riskLevel: 'low', requiresSecondPerson: false,
    parameters: { manager: 'apt' }, viewer: { isRequester: true, isApprover: false },
  });
  const { dom, node } = await mount({
    operations: { items: [own] },
    responses: { operationDetail: { operation: own, events: [] } },
  });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'operations';
    await node.openOperation(own.id);
    assert.equal(findButton(node, 'Approve').disabled, false);
  } finally {
    dom.restore();
  }
});

test('a decided operation offers no further decision', async () => {
  const done = operation({ status: 'succeeded' });
  const { dom, node } = await mount({
    operations: { items: [done] },
    responses: { operationDetail: { operation: done, events: [] } },
  });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'operations';
    await node.openOperation(done.id);

    for (const label of ['Approve', 'Reject', 'Cancel']) {
      const button = findButton(node, label);
      assert.equal(button.disabled, true, `${label} must be closed on a finished operation`);
      assert.match(button.title, /no longer awaiting|already started or finished/);
    }
  } finally {
    dom.restore();
  }
});

// ── the interface tells the truth about state ───────────────────────────────

test('operation history stays readable when the host has stopped reporting', async () => {
  const { dom, node } = await mount({
    host: hostDetail({ snapshot: null }),
    operations: { items: [operation({ status: 'succeeded' })] },
  });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'operations';
    node.render();

    const rendered = node.textContent;
    assert.match(rendered, /chronyd/, 'the record of what was done must survive a silent host');
    assert.match(rendered, /has not reported a snapshot/, 'and the reason must be stated');
    // But no new work may be requested against a host nobody can hear.
    assert.equal(findButton(node, 'Run journal query'), undefined);
  } finally {
    dom.restore();
  }
});

test('a failure that has cleared stops being reported', async () => {
  const failRoutes = { operations: 500 };
  const { dom, node } = await mount({ failRoutes });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'operations';
    node.render();
    assert.match(node.textContent, /HTTP 500|unavailable/, 'the failure must be visible');

    // The backend recovers. The next successful load must clear the banner:
    // leaving it up has an operator debugging a fault that no longer exists.
    delete failRoutes.operations;
    await node.loadOperations('node-a');
    node.render();
    assert.doesNotMatch(node.textContent, /HTTP 500/, 'a stale error must not survive a good load');
  } finally {
    dom.restore();
  }
});

test('a missing operations API is distinguished from an empty history', async () => {
  const { dom, node } = await mount({ failRoutes: { operations: 404 } });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'operations';
    node.render();
    assert.match(node.textContent, /not installed/i);
    assert.doesNotMatch(node.textContent, /No operations have been requested/i);
  } finally {
    dom.restore();
  }
});

test('a slow response for a host the operator has left is discarded', async () => {
  const { dom, node } = await mount();
  try {
    node.connectedCallback();
    await node.refresh();

    // The operator has moved to another host. A response for the previous one
    // is still in flight; landing it would show one host's data under another
    // host's name, which is how the wrong machine gets rebooted.
    node._detail = { hostId: 'node-b', capabilities: { operations: {} }, snapshot: null };
    const inFlight = node.loadDetail('node-a', node._generation);
    node._generation += 1;
    node._selected = 'node-b';
    await inFlight;

    assert.equal(node._detail?.hostId, 'node-b',
      'a superseded response must not overwrite the host now selected');
  } finally {
    dom.restore();
  }
});

test('polling stops when the element is removed', async () => {
  const { dom, node } = await mount();
  try {
    node.connectedCallback();
    await node.refresh();
    assert.equal(dom.timers.started.length, 1, 'the element refreshes on a timer');
    node.disconnectedCallback();
    assert.equal(dom.timers.cleared.length, 1, 'a removed element must cancel its timer');
    assert.equal(node._disposed, true, 'and must refuse to render again');
  } finally {
    dom.restore();
  }
});

// ── keyboard and assistive technology ───────────────────────────────────────

test('every control is a real button with an explicit type', async () => {
  const { dom, node } = await mount({ operations: { items: [operation()] } });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    for (const section of ['overview', 'services', 'journal', 'operations']) {
      node._section = section;
      node.render();
      for (const button of buttons(node)) {
        // A div with a click handler is not reachable by keyboard and is not
        // announced as actionable. Every control here must be a button.
        assert.equal(button.tagName, 'BUTTON');
        assert.equal(button.type, 'button',
          'an implicit submit button inside a form navigates away on Enter');
      }
    }
  } finally {
    dom.restore();
  }
});

test('domain navigation keeps one small, navigable tab strip current', async () => {
  const { dom, node } = await mount();
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    const domains = buttons(node).filter((button) =>
      ['요약', '관측', '보안', '유지보수', '구성', '이력'].includes(button.textContent));
    assert.equal(domains.length, 6, 'the host workflows must be grouped into six stable domains');
    assert.equal(domains.filter((button) => button.getAttribute('aria-current') === 'page').length, 1);

    node._section = 'metrics';
    node.render();
    const tabs = buttons(node).filter((button) => button.attributes.role === 'tab');
    assert.equal(tabs.length, 3, 'the observation domain contains only its three related workflows');
    const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true');
    assert.equal(selected.length, 1, 'exactly one tab is current');
    assert.equal(selected[0].textContent, '메트릭');
  } finally {
    dom.restore();
  }
});

// ── Stage 3: update inventory and maintenance policy ────────────────────────

async function updatesTab(fixtures = {}) {
  const mounted = await mount(fixtures);
  mounted.node.connectedCallback();
  await mounted.node.refresh();
  await mounted.node.select('node-a');
  mounted.node._section = 'updates';
  mounted.node.render();
  return mounted;
}

test('the updates tab reports counts alongside how old the evidence is', async () => {
  const { dom, node } = await updatesTab();
  try {
    const rendered = node.textContent;
    assert.match(rendered, /Package index last refreshed 1 hour ago/);
    assert.match(rendered, /openssl/);
    assert.match(rendered, /6\.8\.0-45-generic/, 'the running kernel must be shown');
    assert.match(rendered, /6\.8\.0-51-generic/, 'and the one installed but not running');
  } finally {
    dom.restore();
  }
});

test('a stale package index is called out rather than presented as fact', async () => {
  const { dom, node } = await updatesTab({
    host: hostDetail({ packages: {
      manager: 'apt', supported: true, unsupportedReason: '',
      metadataAgeSeconds: 30 * 24 * 3600, pendingTotal: 0, pendingSecurity: 0,
      pending: [], truncated: false, collectedAt: '2026-07-02T00:00:00.000Z',
    } }),
  });
  try {
    assert.match(node.textContent, /30 days ago/);
    assert.match(node.textContent, /may be well out of date/,
      'zero pending updates from a month-old index is not evidence of a patched host');
  } finally {
    dom.restore();
  }
});

test('an unsupported package manager shows no counts at all', async () => {
  const { dom, node } = await updatesTab({
    host: hostDetail({ packages: {
      manager: 'dnf', supported: false,
      unsupportedReason: 'this agent build drives apt only; dnf is detected but not operated',
      metadataAgeSeconds: -1, pendingTotal: 0, pendingSecurity: 0, pending: [], truncated: false,
    } }),
  });
  try {
    const rendered = node.textContent;
    assert.match(rendered, /drives apt only/);
    assert.match(rendered, /not the same as "no updates pending"/,
      'silence about an unreadable manager must not read as a clean bill of health');
    assert.doesNotMatch(rendered, /Pending updates/);
  } finally {
    dom.restore();
  }
});

test('a kernel installed but not running says what actually changes it', async () => {
  const { dom, node } = await updatesTab();
  try {
    const rendered = node.textContent;
    assert.match(rendered, /Installing a kernel never reboots the host/);
    assert.match(rendered, /host\.reboot/);
    assert.match(rendered, /Kubernetes drain checks/);
  } finally {
    dom.restore();
  }
});

test('the policy summary states the timezone and DST behaviour', async () => {
  const { dom, node } = await updatesTab();
  try {
    const rendered = node.textContent;
    assert.match(rendered, /Europe\/Berlin/);
    assert.match(rendered, /02:00 window stays at 02:00 all year/);
    assert.match(rendered, /Window open now/);
  } finally {
    dom.restore();
  }
});

test('a host with no policy is told that this is the default, not a fault', async () => {
  const { dom, node } = await updatesTab({ host: hostDetail({ policy: null }) });
  try {
    assert.match(node.textContent, /no maintenance policy/);
    assert.match(node.textContent, /That is the default/);
  } finally {
    dom.restore();
  }
});

async function operationsTab(fixtures = {}) {
  const mounted = await mount(fixtures);
  mounted.node.connectedCallback();
  await mounted.node.refresh();
  await mounted.node.select('node-a');
  mounted.node._section = 'operations';
  mounted.node.render();
  return mounted;
}

async function servicesTab(fixtures = {}) {
  const mounted = await mount(fixtures);
  mounted.node.connectedCallback();
  await mounted.node.refresh();
  await mounted.node.select('node-a');
  mounted.node._section = 'services';
  mounted.node.render();
  return mounted;
}

async function rebootTab(fixtures = {}) {
  const mounted = await mount(fixtures);
  mounted.node.connectedCallback();
  await mounted.node.refresh();
  await mounted.node.select('node-a');
  mounted.node._section = 'reboot';
  mounted.node.render();
  return mounted;
}

test('the Services tab submits only an effectively allowlisted unit and Operations has no duplicate', async () => {
  const { dom, node, calls } = await servicesTab();
  try {
    fieldControl(node, 'Service').value = 'chronyd.service';
    fieldControl(node, 'Reason').value = 'restart chronyd after clock drift';
    findButton(node, 'Request restart').dispatch('click');
    await settle();

    const request = calls.find((call) => call.method === 'POST'
      && call.route.endsWith('/hosts/node-a/operations'));
    assert.deepEqual(request?.body, {
      operation: 'service.restart',
      parameters: { unit: 'chronyd.service' },
      reason: 'restart chronyd after clock drift',
    });

    node._section = 'operations';
    node.render();
    assert.equal(findButton(node, 'Request restart'), undefined,
      'a service restart must have one submitter in its domain tab');
    assert.match(node.textContent, /requested from the Services tab/);
  } finally {
    dom.restore();
  }
});

test('the Services tab exposes allowlist drift and disables restart without the permission', async () => {
  const denied = {
    supported: true,
    permitted: false,
    reason: 'requires console.hosts.service-restart with AAL2',
    allowlist: ['chronyd.service'],
    granted: ['chronyd.service', 'nginx.service'],
    reported: ['chronyd.service', 'sshd.service'],
    drift: { onlyGranted: ['nginx.service'], onlyReported: ['sshd.service'] },
  };
  const { dom, node } = await servicesTab({
    host: hostDetail({ operations: { 'service.restart': denied } }),
  });
  try {
    assert.match(node.textContent, /granted but not reported.*nginx\.service/);
    assert.match(node.textContent, /reported by the agent but not granted.*sshd\.service/);
    const restart = findButton(node, 'Request restart');
    assert.ok(restart);
    assert.equal(restart.disabled, true);
    assert.match(restart.title, /console\.hosts\.service-restart.*AAL2/);
    assert.deepEqual(restart.listeners.click, undefined);
  } finally {
    dom.restore();
  }
});

test('the Services tab keeps restart result and audit trail beside current systemd state', async () => {
  const completed = operation({
    status: 'succeeded',
    result: {
      outcome: 'succeeded',
      exitCode: 0,
      message: 'service restart completed',
      output: 'chronyd.service is active',
      truncated: false,
    },
    completedAt: '2026-08-01T11:01:00.000Z',
  });
  const { dom, node } = await servicesTab({
    operations: { items: [completed] },
    responses: {
      operationDetail: {
        operation: completed,
        events: [{
          occurred_at: '2026-08-01T11:01:00.000Z',
          phase: 'receipt',
          actor_type: 'agent',
          result: 'succeeded',
        }],
      },
    },
  });
  try {
    assert.match(node.textContent, /Service restart activity/);
    assert.match(node.textContent, /Succeeded/);
    findButton(node, 'Details').dispatch('click');
    await settle();
    assert.match(node.textContent, /service restart completed/);
    assert.match(node.textContent, /chronyd\.service is active/);
    assert.match(node.textContent, /receipt · agent · succeeded/);
  } finally {
    dom.restore();
  }
});

test('the Services tab keeps restart history but withholds new work from a silent host', async () => {
  const completed = operation({ status: 'succeeded' });
  const { dom, node } = await servicesTab({
    host: hostDetail({ snapshot: null }),
    operations: { items: [completed] },
  });
  try {
    assert.match(node.textContent, /has not reported a snapshot/);
    assert.match(node.textContent, /restart chronyd after clock drift/);
    assert.equal(findButton(node, 'Request restart'), undefined);
  } finally {
    dom.restore();
  }
});

test('the Reboot tab submits one bounded request and Operations has no duplicate', async () => {
  const { dom, node, calls } = await rebootTab({
    host: hostDetail({
      snapshot: {
        identity: {
          hostname: 'node-a',
          bootIdHash: 'sha256:1111222233334444',
          uptimeSeconds: 3600,
        },
        operations: {},
      },
    }),
  });
  try {
    fieldControl(node, 'Return deadline (seconds)').value = '900';
    fieldControl(node, 'Reason').value = 'activate the newly installed kernel';
    findButton(node, 'Request safe reboot').dispatch('click');
    await settle();

    const request = calls.find((call) => call.method === 'POST'
      && call.route.endsWith('/hosts/node-a/operations'));
    assert.deepEqual(request?.body, {
      operation: 'host.reboot',
      parameters: { deadlineSeconds: 900 },
      reason: 'activate the newly installed kernel',
    });
    assert.match(node.textContent, /sha256:1111222233334444/);
    assert.match(node.textContent, /does not reboot the host/);

    node._section = 'operations';
    node.render();
    assert.equal(findButton(node, 'Request safe reboot'), undefined,
      'a reboot must have one submitter beside its preflight and proof');
    assert.match(node.textContent, /requested from the Reboot tab/);
  } finally {
    dom.restore();
  }
});

test('the Reboot tab fails closed with the backend refusal reason', async () => {
  const denied = {
    supported: true,
    permitted: false,
    reason: 'single-node control center reboots are hard-disabled',
  };
  const { dom, node } = await rebootTab({
    host: hostDetail({ operations: { 'host.reboot': denied } }),
  });
  try {
    assert.match(node.textContent, /single-node control center reboots are hard-disabled/);
    assert.match(node.textContent, /refuses a single-node cluster/);
    const request = findButton(node, 'Request safe reboot');
    assert.ok(request);
    assert.equal(request.disabled, true);
    assert.match(request.title, /single-node control center/);
    assert.deepEqual(request.listeners.click, undefined);
  } finally {
    dom.restore();
  }
});

test('the Reboot tab shows preflight refusal, drain timeline and hashed reboot proof in place', async () => {
  const refused = operation({
    operation: 'host.reboot',
    parameters: { deadlineSeconds: 600 },
    status: 'failed',
    maintenance: {
      prepared: false,
      node: 'node-a',
      cordon: { cordoned: false },
      drain: { drained: false, evicted: [] },
      blocking: [{
        code: 'single-node',
        detail: 'the only schedulable node cannot be drained safely',
      }],
      warnings: [],
    },
    result: {
      outcome: 'failed',
      exitCode: -1,
      message: 'Kubernetes preflight refused this reboot',
    },
  });
  const succeeded = operation({
    id: 'a0000000-0000-0000-0000-0000000000b2',
    operation: 'host.reboot',
    parameters: { deadlineSeconds: 600 },
    status: 'succeeded',
    maintenance: {
      prepared: true,
      node: 'node-a',
      cordon: { cordoned: true },
      drain: { drained: true, evicted: ['pod-a'] },
    },
    result: {
      outcome: 'succeeded',
      exitCode: 0,
      message: 'boot id changed',
      evidence: {
        bootIdBeforeHash: 'sha256:1111222233334444',
        bootIdAfterHash: 'sha256:aaaabbbbccccdddd',
        deadline: '2026-08-01T11:10:00Z',
        conclusion: 'boot id changed',
        bootIdBefore: 'raw-secret-must-not-render',
      },
    },
  });
  const { dom, node, responses } = await rebootTab({
    operations: { items: [refused, succeeded] },
  });
  try {
    responses.operationDetail = {
      operation: refused,
      events: [{
        occurred_at: '2026-08-01T11:01:00.000Z',
        phase: 'maintenance.refused',
        actor_type: 'system',
        result: 'blocked',
      }],
    };
    findButton(node, 'Details').dispatch('click');
    await settle();
    assert.match(node.textContent, /single-node: the only schedulable node/);
    assert.match(node.textContent, /maintenance\.refused · system · blocked/);

    responses.operationDetail = { operation: succeeded, events: [] };
    await node.openOperation(succeeded.id);
    assert.match(node.textContent, /Boot identity before.*sha256:1111222233334444/);
    assert.match(node.textContent, /Boot identity after.*sha256:aaaabbbbccccdddd/);
    assert.match(node.textContent, /Pods evicted.*1/);
    assert.doesNotMatch(node.textContent, /raw-secret-must-not-render/);
  } finally {
    dom.restore();
  }
});

test('the Reboot tab keeps refusal history but withholds new work from a silent host', async () => {
  const refused = operation({ operation: 'host.reboot', status: 'failed' });
  const { dom, node } = await rebootTab({
    host: hostDetail({ snapshot: null }),
    operations: { items: [refused] },
  });
  try {
    assert.match(node.textContent, /has not reported a snapshot/);
    assert.match(node.textContent, /restart chronyd after clock drift/);
    assert.equal(findButton(node, 'Request safe reboot'), undefined);
  } finally {
    dom.restore();
  }
});

async function journalTab(fixtures = {}) {
  const mounted = await mount(fixtures);
  mounted.node.connectedCallback();
  await mounted.node.refresh();
  await mounted.node.select('node-a');
  mounted.node._section = 'journal';
  mounted.node.render();
  return mounted;
}

test('the Journal tab submits one bounded typed query and Operations has no duplicate submitter', async () => {
  const { dom, node, calls } = await journalTab();
  try {
    fieldControl(node, 'Units (comma separated)').value = 'sshd.service, kubelet.service';
    fieldControl(node, 'Priority').value = 'warning';
    fieldControl(node, 'Since').value = '-2 hours ago';
    fieldControl(node, 'Lines').value = '300';
    fieldControl(node, 'Reason').value = 'investigate repeated SSH failures';

    findButton(node, 'Run journal query').dispatch('click');
    await settle();

    const request = calls.find((call) => call.method === 'POST'
      && call.route.endsWith('/hosts/node-a/operations'));
    assert.deepEqual(request?.body, {
      operation: 'journal.query',
      parameters: {
        units: ['sshd.service', 'kubelet.service'],
        priority: 'warning',
        since: '-2 hours ago',
        lines: 300,
      },
      reason: 'investigate repeated SSH failures',
    });

    node._section = 'operations';
    node.render();
    assert.equal(findButton(node, 'Run journal query'), undefined,
      'one operation must not have two submitters on different tabs');
    assert.match(node.textContent, /requested from the Journal tab/);
  } finally {
    dom.restore();
  }
});

test('the Journal tab keeps bounded output, truncation and audit evidence beside the request', async () => {
  const completed = operation({
    operation: 'journal.query',
    parameters: { units: ['sshd.service'], priority: 'warning', since: '-1 hour ago', lines: 200 },
    reason: 'investigate repeated SSH failures',
    status: 'succeeded',
    riskLevel: 'low',
    requiresSecondPerson: false,
    result: {
      outcome: 'succeeded',
      exitCode: 0,
      message: 'journal query completed',
      output: '<img src=x onerror=\"alert(1)\"> journal text',
      truncated: true,
    },
    completedAt: '2026-08-01T11:01:00.000Z',
  });
  const { dom, node } = await journalTab({
    operations: { items: [completed] },
    responses: {
      operationDetail: {
        operation: completed,
        events: [{
          occurred_at: '2026-08-01T11:01:00.000Z',
          phase: 'receipt',
          actor_type: 'agent',
          result: 'succeeded',
        }],
      },
    },
  });
  try {
    assert.match(node.textContent, /Journal query activity/);
    assert.match(node.textContent, /Succeeded/);
    findButton(node, 'Details').dispatch('click');
    await settle();

    assert.match(node.textContent, /journal query completed/);
    assert.match(node.textContent, /Output was truncated by the agent/);
    assert.match(node.textContent, /<img src=x onerror=/,
      'journal text must stay visible as text rather than becoming markup');
    assert.equal(node.querySelectorAll('img').length, 0);
    assert.match(node.textContent, /receipt · agent · succeeded/,
      'the same tab must show the operation audit timeline');
  } finally {
    dom.restore();
  }
});

test('the Journal tab keeps old query evidence when the host has no snapshot', async () => {
  const completed = operation({
    operation: 'journal.query',
    reason: 'investigate a completed incident',
    status: 'succeeded',
    riskLevel: 'low',
    requiresSecondPerson: false,
  });
  const { dom, node } = await journalTab({
    host: hostDetail({ snapshot: null }),
    operations: { items: [completed] },
  });
  try {
    assert.match(node.textContent, /has not reported a snapshot/);
    assert.match(node.textContent, /investigate a completed incident/);
    assert.equal(findButton(node, 'Run journal query'), undefined,
      'a silent host must not accept new journal work');
  } finally {
    dom.restore();
  }
});

// ── driving the Updates page the way an operator does ───────────────────────
//
// Every helper below re-queries the DOM. Selecting a package re-renders the
// page, so a node captured before a tick is a node that is no longer on screen;
// a test holding one would be asserting against a view the operator cannot see.

/** The row checkbox for a package, found by the label a screen reader reads. */
function packageBox(node, name) {
  return node.descendants().find((n) => n.tagName === 'INPUT'
    && (n.getAttribute('aria-label') || '').startsWith(`Select ${name} `));
}

/** A text field, found by the placeholder the operator sees in it. */
function inputByPlaceholder(node, placeholder) {
  return node.descendants().find((n) => n.tagName === 'INPUT'
    && n.getAttribute('placeholder') === placeholder);
}

/** The control belonging to a labelled form field. */
function fieldControl(node, labelText) {
  const wrapper = node.descendants().find((n) => n.tagName === 'DIV'
    && n.children[0]?.tagName === 'LABEL' && n.children[0].textContent === labelText);
  return wrapper?.children[1];
}

const CONFIRM_PACKAGES = 'I have reviewed the exact packages and versions above';
const CONFIRM_KERNEL = 'I have reviewed the target release above';

function tick(control) {
  assert.ok(control, 'the control being ticked must exist');
  control.checked = true;
  control.dispatch('change');
}

/**
 * Fills the update card in and hands back the submitter, unpressed.
 *
 * Selecting a package re-renders; ticking security-only or the confirmation
 * does not. The order here is the order an operator can actually achieve, and
 * every node is re-queried after the last thing that redrew the page.
 */
function prepareUpdate(node, options = {}) {
  const {
    names = [], reason = 'apply the pending security fixes', confirm = true,
    securityOnly = false,
  } = options;
  for (const name of names) tick(packageBox(node, name));
  if (securityOnly) tick(fieldControl(node, 'Security updates only'));
  if (confirm) tick(fieldControl(node, CONFIRM_PACKAGES));
  const reasonField = inputByPlaceholder(node, 'why this update is needed');
  if (reasonField) reasonField.value = reason;
  return findButton(node, 'Request package update');
}

/** Selects packages, fills the card in, and presses Request package update. */
async function requestUpdate(node, options = {}) {
  const button = prepareUpdate(node, options);
  assert.ok(button, 'the update submitter must be on the page');
  button.dispatch('click');
  await settle();
}

/** Fills the kernel card in and presses Request kernel update. */
async function requestKernel(node, options = {}) {
  const { reason = 'install the newer kernel image', confirm = true } = options;
  if (confirm) tick(fieldControl(node, CONFIRM_KERNEL));
  const reasonField = inputByPlaceholder(node, 'why this kernel update is needed');
  if (reasonField) reasonField.value = reason;
  const button = findButton(node, 'Request kernel update');
  assert.ok(button, 'the kernel submitter must be on the page');
  button.dispatch('click');
  await settle();
}

/**
 * What the page shows as selected, read back off the screen.
 *
 * Read from the rendered checkboxes rather than from the element's own state,
 * so a test cannot pass on a selection the operator was never shown.
 */
function selectedNames(node) {
  return node.descendants()
    .filter((n) => n.tagName === 'INPUT' && n.checked === true
      && (n.getAttribute('aria-label') || '').startsWith('Select '))
    .map((n) => n.getAttribute('aria-label').split(' ')[1]);
}

test('the SSH ban tab submits one exact address and exposes no jail or command field', async () => {
  const { dom, node, calls } = await mount();
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'sshban';
    node.render();

    assert.match(node.textContent, /Fail2ban|fail2ban/);
    assert.match(node.textContent, /203\.0\.113\.10/, 'protected management addresses must be visible');
    assert.equal(
      node.descendants().some((item) => item.tagName === 'INPUT'
        && /jail|command|shell/i.test(item.getAttribute('placeholder') || '')),
      false,
      'there must be no arbitrary jail or command input',
    );

    inputByPlaceholder(node, '203.0.113.24 or 2001:db8::24').value = '203.0.113.24';
    inputByPlaceholder(node, '이 주소를 차단해야 하는 사유').value = 'repeated credential attacks';
    tick(fieldControl(node, '관리자 또는 관리 접속 주소가 아님을 확인했습니다'));
    findButton(node, '차단 요청').dispatch('click');
    await settle();

    const post = calls.find((call) => call.method === 'POST' && call.body?.operation === 'ssh.ban');
    assert.ok(post, 'the ban request must be sent');
    assert.deepEqual(post.body.parameters, { address: '203.0.113.24' });
    assert.equal(post.body.reason, 'repeated credential attacks');
  } finally {
    dom.restore();
  }
});

test('the SSH protection page turns an uninstalled provider into a governed setup workflow', async () => {
  const { dom, node, calls } = await mount({
    host: hostDetail({
      sshBan: {
        provider: 'fail2ban', jail: 'sshd', installed: false, active: false, supported: false,
        packageVersion: '', candidateVersion: '1.0.2-3ubuntu0.1', protectionProfile: '',
        unsupportedReason: 'fail2ban-client is not installed on this host',
        currentlyFailed: 0, totalFailed: 0, currentlyBanned: 0, totalBanned: 0,
        bannedAddresses: [], recentEvents: [], banTimeSeconds: 0, findTimeSeconds: 0,
        maxRetry: 0, truncated: false, collectedAt: '2026-08-01T11:59:00.000Z',
      },
    }),
  });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'sshban';
    node.render();

    assert.match(node.textContent, /미설치/);
    assert.match(node.textContent, /1\.0\.2-3ubuntu0\.1/);
    assert.match(node.textContent, /관리 접속 보호 주소/);
    inputByPlaceholder(node, 'SSH 보호 활성화 또는 재조정 사유').value =
      'protect SSH before exposing the host';
    tick(fieldControl(
      node,
      '보호 관리 주소와 5회·10분 탐지·1시간 차단의 고정 정책을 검토했습니다',
    ));
    findButton(node, 'SSH 보호 활성화 요청').dispatch('click');
    await settle();

    const post = calls.find((call) =>
      call.method === 'POST' && call.body?.operation === 'ssh.protection.enable');
    assert.ok(post, 'the setup request must be sent through the governed operation API');
    assert.deepEqual(post.body.parameters, {});
    assert.equal(post.body.reason, 'protect SSH before exposing the host');
  } finally {
    dom.restore();
  }
});

test('an active RCC profile with protected-address drift offers reconciliation without hiding response controls', async () => {
  const { dom, node, calls } = await mount({
    host: hostDetail({
      sshBan: {
        provider: 'fail2ban', jail: 'sshd', installed: true, active: true, supported: true,
        packageVersion: '1.0.2-3ubuntu0.1', candidateVersion: '1.0.2-3ubuntu0.1',
        protectionProfile: 'rcc-ssh-baseline-v1-drift',
        profileDigest: `sha256:${'a'.repeat(64)}`,
        currentlyFailed: 2, totalFailed: 20, currentlyBanned: 1, totalBanned: 5,
        bannedAddresses: ['198.51.100.9'], recentEvents: [],
        banTimeSeconds: 3600, findTimeSeconds: 600, maxRetry: 5,
        truncated: false, collectedAt: '2026-08-01T11:59:00.000Z',
      },
    }),
  });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'sshban';
    node.render();

    assert.match(node.textContent, /기준선 불일치/);
    assert.ok(findButton(node, '차단 요청'), 'incident-response controls must remain available');
    inputByPlaceholder(node, 'SSH 보호 활성화 또는 재조정 사유').value =
      'align protected management addresses';
    tick(fieldControl(
      node,
      '보호 관리 주소와 5회·10분 탐지·1시간 차단의 고정 정책을 검토했습니다',
    ));
    findButton(node, 'SSH 보호 기준선 재조정 요청').dispatch('click');
    await settle();

    const post = calls.find((call) =>
      call.method === 'POST' && call.body?.operation === 'ssh.protection.enable');
    assert.ok(post, 'the reconciliation must use the governed setup operation');
    assert.deepEqual(post.body.parameters, {});
  } finally {
    dom.restore();
  }
});

/** Every POST the page made, in order, with the body it would have sent. */
function submissions(calls) {
  return calls.filter((call) => call.method === 'POST');
}

test('package controls are offered on the Updates page when policy and host permit', async () => {
  const { dom, node } = await updatesTab();
  try {
    for (const label of ['Refresh index', 'Request package update', 'Request kernel update']) {
      const button = findButton(node, label);
      assert.ok(button, `${label} must be present`);
      assert.equal(button.disabled, false, `${label} must be enabled`);
    }
    assert.match(node.textContent, /A maintenance window is open until/);
  } finally {
    dom.restore();
  }
});

test('the Operations tab no longer carries a second package submitter', async () => {
  // One implementation, one place. Two submitters for the same operation drift,
  // and the one an operator happens to find would decide whether their request
  // was pinned to a version at all.
  const { dom, node } = await operationsTab();
  try {
    for (const label of ['Refresh index', 'Request package update', 'Request kernel update']) {
      assert.equal(findButton(node, label), undefined,
        `${label} must exist only on the Updates page`);
    }
    assert.match(node.textContent, /requested from the Updates tab/);
  } finally {
    dom.restore();
  }
});

test('outside a window the controls say a request would be refused', async () => {
  const { dom, node } = await updatesTab({
    host: hostDetail({
      policy: {
        id: 'c1', name: 'CC2 nightly', scope: 'control-center', version: 3,
        timezone: 'Europe/Berlin',
        allowedOperations: ['package.refresh', 'package.update', 'kernel.update'],
        emergencyAllowed: false, enabled: true, inWindow: false, windowEndsAt: null, windows: [],
      },
    }),
  });
  try {
    assert.match(node.textContent, /No maintenance window is open/);
    assert.match(node.textContent, /refused until one opens/);
  } finally {
    dom.restore();
  }
});

test('the emergency control appears only where the policy allows it', async () => {
  const without = await updatesTab();
  try {
    assert.doesNotMatch(without.node.textContent, /Emergency \(run outside a window\)/);
  } finally {
    without.dom.restore();
  }

  const withEmergency = await updatesTab({
    host: hostDetail({
      policy: {
        id: 'c1', name: 'CC2 nightly', scope: 'control-center', version: 3,
        timezone: 'Europe/Berlin',
        allowedOperations: ['package.refresh', 'package.update', 'kernel.update'],
        emergencyAllowed: true, enabled: true, inWindow: false, windowEndsAt: null, windows: [],
      },
    }),
  });
  try {
    const rendered = withEmergency.node.textContent;
    assert.match(rendered, /Emergency \(run outside a window\)/);
    assert.match(rendered, /Approval, second person and assurance level are unchanged/,
      'the console must not suggest an emergency lowers any other bar');
  } finally {
    withEmergency.dom.restore();
  }
});

test('a package the host does not allowlist is listed as ineligible, with the reason', async () => {
  const { dom, node } = await updatesTab({
    host: hostDetail({
      snapshot: { identity: { hostname: 'node-a' }, operations: { packageAllowlist: ['curl'] } },
    }),
  });
  try {
    assert.equal(findButton(node, 'Request package update').disabled, false,
      'curl is allowlisted and pending');
    assert.ok(packageBox(node, 'curl'), 'curl must be selectable');
    assert.equal(packageBox(node, 'openssl'), undefined,
      'a package the agent would refuse must not be selectable');
    // Silently dropping it is indistinguishable from it having no update, and
    // openssl here is the security one.
    assert.match(node.textContent, /Pending but not selectable/);
    assert.match(node.textContent, /does not allowlist it for updates/);
  } finally {
    dom.restore();
  }
});

test('an empty agent allowlist closes the control and says it is not "no updates"', async () => {
  const { dom, node, calls } = await updatesTab({
    host: hostDetail({
      snapshot: { identity: { hostname: 'node-a' }, operations: { packageAllowlist: [] } },
    }),
  });
  try {
    const update = findButton(node, 'Request package update');
    assert.equal(update.disabled, true);
    assert.match(update.title, /No package on this host is selectable/);
    assert.match(node.textContent, /allowlists no package for updates/);
    assert.match(node.textContent, /not the same as having no updates/);
    update.dispatch('click');
    await settle();
    assert.equal(submissions(calls).length, 0, 'a disabled control must submit nothing');
  } finally {
    dom.restore();
  }
});

test('a capability the operator lacks is disabled with the permission named', async () => {
  const denied = { supported: true, reason: 'requires console.hosts.packages', permitted: false };
  const { dom, node, calls } = await updatesTab({
    host: hostDetail({
      operations: {
        'package.refresh': denied, 'package.update': denied, 'kernel.update': denied,
      },
    }),
  });
  try {
    const rendered = node.textContent;
    assert.match(rendered, /console\.hosts\.packages/);
    // Denied means no submitter at all, not a submitter that fails on click.
    for (const label of ['Refresh index', 'Request package update', 'Request kernel update']) {
      assert.equal(findButton(node, label), undefined, `${label} must not be offered`);
    }
    assert.equal(packageBox(node, 'curl'), undefined, 'nothing may be selected either');
    assert.equal(submissions(calls).length, 0);
  } finally {
    dom.restore();
  }
});

test('read-only host control offers no update submitter and states the mode', async () => {
  const readOnly = {
    supported: false,
    reason: 'this control center is in read-only host_control_mode',
    permitted: true,
  };
  const { dom, node, calls } = await updatesTab({
    host: hostDetail({
      operations: {
        'package.refresh': readOnly, 'package.update': readOnly, 'kernel.update': readOnly,
      },
    }),
  });
  try {
    assert.match(node.textContent, /read-only host_control_mode/);
    for (const label of ['Refresh index', 'Request package update', 'Request kernel update']) {
      assert.equal(findButton(node, label), undefined, `${label} must not be offered`);
    }
    // The reported state is still worth reading; only the controls are withheld.
    assert.match(node.textContent, /Pending updates/);
    assert.equal(submissions(calls).length, 0);
  } finally {
    dom.restore();
  }
});

test('an unsupported package manager offers no update controls and shows no counts', async () => {
  const { dom, node } = await updatesTab({
    host: hostDetail({
      packages: {
        manager: 'dnf', supported: false,
        unsupportedReason: 'this agent build drives apt only; dnf is detected but not operated',
        metadataAgeSeconds: -1, pendingTotal: 0, pendingSecurity: 0, pending: [], truncated: false,
      },
    }),
  });
  try {
    for (const label of ['Refresh index', 'Request package update', 'Request kernel update']) {
      assert.equal(findButton(node, label), undefined, `${label} must not be offered`);
    }
    const matches = node.textContent.match(/drives apt only/g) || [];
    assert.equal(matches.length, 1, 'the reason belongs once, not once per control');
  } finally {
    dom.restore();
  }
});

// ── what an update request is actually bound to ─────────────────────────────

test('the request is pinned to the exact versions the operator reviewed', async () => {
  // The approval digest covers these parameters. A request that named packages
  // without versions would be approved as "upgrade curl", and the host would
  // install whatever its mirror offered whenever it got round to running it —
  // which is not the thing anybody read.
  const { dom, node, calls } = await updatesTab();
  try {
    await requestUpdate(node, { names: ['curl', 'openssl'] });

    const posts = submissions(calls);
    assert.equal(posts.length, 1, 'exactly one request');
    assert.equal(posts[0].body.operation, 'package.update');
    assert.deepEqual(posts[0].body.parameters, {
      manager: 'apt',
      packages: [
        { name: 'curl', version: '8.5.0-2' },
        { name: 'openssl', version: '3.0.13-2' },
      ],
      securityOnly: false,
    });
    assert.equal(posts[0].body.reason, 'apply the pending security fixes');
    assert.equal(posts[0].body.emergency, undefined,
      'emergency is never sent unless it was asked for');
  } finally {
    dom.restore();
  }
});

test('what the page submits is what the backend normaliser accepts, unchanged', async () => {
  // The two are written in different languages in different directories and
  // only meet in production. Driving the page's own output through the real
  // normaliser catches both halves of the disagreement: a shape the backend
  // would reject outright, and a shape it silently rewrites — the latter being
  // worse, because the digest an approver binds is then not the digest the
  // console showed them.
  const { normalizeParameters } = require('../opensphere-console-backend/operation-api');
  const { dom, node, calls } = await updatesTab();
  try {
    await requestUpdate(node, { names: ['openssl'], securityOnly: true });
    await requestKernel(node);

    const posts = submissions(calls);
    assert.equal(posts.length, 2);
    for (const post of posts) {
      const normalised = normalizeParameters(post.body.operation, post.body.parameters);
      assert.deepEqual(normalised, post.body.parameters,
        `${post.body.operation} must reach the backend needing no correction`);
    }
    assert.equal(posts[0].body.parameters.securityOnly, true);
  } finally {
    dom.restore();
  }
});

test('a security-only claim is made only when the operator ticked it', async () => {
  for (const [securityOnly, expected] of [[true, true], [false, false]]) {
    const { dom, node, calls } = await updatesTab();
    try {
      await requestUpdate(node, { names: ['openssl'], securityOnly });
      assert.equal(submissions(calls)[0].body.parameters.securityOnly, expected);
    } finally {
      dom.restore();
    }
  }
});

test('security-only cannot be claimed for a set that is not all security', async () => {
  // The agent re-checks every package against its security origin and refuses
  // the whole request if one is not. Offering the claim here would produce a
  // request that is guaranteed to fail after it was approved.
  const { dom, node, calls } = await updatesTab();
  try {
    tick(packageBox(node, 'curl'));
    tick(packageBox(node, 'openssl'));

    const box = fieldControl(node, 'Security updates only');
    assert.equal(box.disabled, true, 'a mixed set may not claim security-only');
    assert.match(node.textContent, /a selected package is not a security update/);
    // Forcing the box has no listener behind it, so it changes nothing.
    box.checked = true;
    box.dispatch('change');

    tick(fieldControl(node, CONFIRM_PACKAGES));
    inputByPlaceholder(node, 'why this update is needed').value = 'apply both pending updates';
    findButton(node, 'Request package update').dispatch('click');
    await settle();

    assert.equal(submissions(calls)[0].body.parameters.securityOnly, false);
  } finally {
    dom.restore();
  }
});

// ── a selection is a thing the operator built, not a thing render rebuilds ──

test('a selection survives the poll that re-renders the page', async () => {
  // The page re-reads the host every minute. A selection held in a render
  // closure is discarded by that poll, and an operator who ticked twelve
  // packages, wrote a reason and looked away loses all of it silently.
  const { dom, node } = await updatesTab();
  try {
    tick(packageBox(node, 'curl'));
    tick(packageBox(node, 'openssl'));
    tick(fieldControl(node, CONFIRM_PACKAGES));
    assert.deepEqual(selectedNames(node), ['curl', 'openssl']);

    await node.refresh({ silent: true });

    assert.deepEqual(selectedNames(node), ['curl', 'openssl'],
      'a poll that changed nothing must not discard a reviewed selection');
    assert.equal(fieldControl(node, CONFIRM_PACKAGES).checked, true);
  } finally {
    dom.restore();
  }
});

test('a candidate version that moves under the operator withdraws the confirmation', async () => {
  const { dom, node, calls, responses } = await updatesTab();
  try {
    tick(packageBox(node, 'curl'));
    tick(fieldControl(node, CONFIRM_PACKAGES));

    responses.host = hostDetail({
      packages: packagesFixture({
        pending: [
          { name: 'openssl', currentVersion: '3.0.13-1', candidateVersion: '3.0.13-2', security: true, origin: 'Ubuntu:24.04/noble-security' },
          { name: 'curl', currentVersion: '8.5.0-1', candidateVersion: '8.5.0-3', security: false, origin: 'Ubuntu:24.04/noble-updates' },
        ],
      }),
    });
    await node.refresh({ silent: true });

    assert.match(node.textContent, /candidate version changed while you were choosing/);
    assert.match(node.textContent, /curl 8\.5\.0-2 to 8\.5\.0-3/,
      'the operator must be told which version moved, and to what');
    assert.equal(fieldControl(node, CONFIRM_PACKAGES).checked, false);

    inputByPlaceholder(node, 'why this update is needed').value = 'apply the pending fixes';
    findButton(node, 'Request package update').dispatch('click');
    await settle();
    assert.equal(submissions(calls).length, 0,
      'a confirmation given against an older version must not carry over');
    assert.match(node.textContent, /Confirm that you have reviewed the exact packages/);

    tick(fieldControl(node, CONFIRM_PACKAGES));
    inputByPlaceholder(node, 'why this update is needed').value = 'apply the pending fixes';
    findButton(node, 'Request package update').dispatch('click');
    await settle();
    assert.deepEqual(submissions(calls)[0].body.parameters.packages,
      [{ name: 'curl', version: '8.5.0-3' }],
      're-confirming binds the version now on screen, not the one first ticked');
  } finally {
    dom.restore();
  }
});

test('a package that stops being offered is dropped from the selection, visibly', async () => {
  const { dom, node, responses } = await updatesTab();
  try {
    tick(packageBox(node, 'curl'));
    tick(packageBox(node, 'openssl'));
    tick(fieldControl(node, CONFIRM_PACKAGES));

    responses.host = hostDetail({
      packages: packagesFixture({
        pendingTotal: 1,
        pending: [
          { name: 'openssl', currentVersion: '3.0.13-1', candidateVersion: '3.0.13-2', security: true, origin: 'Ubuntu:24.04/noble-security' },
        ],
      }),
    });
    await node.refresh({ silent: true });

    assert.deepEqual(selectedNames(node), ['openssl']);
    assert.match(node.textContent, /no longer offers them: curl/);
    assert.match(node.textContent, /confirmation was withdrawn/);
    assert.equal(fieldControl(node, CONFIRM_PACKAGES).checked, false);
  } finally {
    dom.restore();
  }
});

test('the pickers move exactly the set they name', async () => {
  const { dom, node } = await updatesTab();
  try {
    findButton(node, 'Select security updates').dispatch('click');
    assert.deepEqual(selectedNames(node), ['openssl'],
      'only the security update, not everything pending');

    findButton(node, 'Select all eligible').dispatch('click');
    assert.deepEqual(selectedNames(node), ['curl', 'openssl']);

    findButton(node, 'Clear selection').dispatch('click');
    assert.deepEqual(selectedNames(node), []);
    assert.equal(findButton(node, 'Clear selection').disabled, true,
      'with nothing selected there is nothing to clear');
  } finally {
    dom.restore();
  }
});

test('a request is capped at the size the backend accepts, and says so', async () => {
  const { normalizeParameters } = require('../opensphere-console-backend/operation-api');
  const many = Array.from({ length: 40 }, (unused, index) => ({
    name: `pkg-${String(index).padStart(2, '0')}`,
    currentVersion: '1.0-1', candidateVersion: '1.0-2', security: false,
  }));
  const { dom, node, calls } = await updatesTab({
    host: hostDetail({
      packages: packagesFixture({ pending: many, pendingTotal: 40, pendingSecurity: 0 }),
      snapshot: {
        identity: { hostname: 'node-a' },
        operations: { packageAllowlist: many.map((entry) => entry.name) },
      },
    }),
  });
  try {
    findButton(node, 'Select all eligible').dispatch('click');
    assert.equal(selectedNames(node).length, 32);
    // Silently taking 32 of 40 would leave eight unpatched packages that the
    // operator believes they just requested.
    assert.match(node.textContent, /Only the first 32 of 40 packages were selected/);

    tick(packageBox(node, 'pkg-35'));
    assert.equal(selectedNames(node).length, 32, 'the bound holds against a hand-picked add');
    assert.match(node.textContent, /Deselect one before adding pkg-35/);

    tick(fieldControl(node, CONFIRM_PACKAGES));
    inputByPlaceholder(node, 'why this update is needed').value = 'apply the pending updates';
    findButton(node, 'Request package update').dispatch('click');
    await settle();

    const sent = submissions(calls)[0].body.parameters;
    assert.equal(sent.packages.length, 32);
    assert.deepEqual(normalizeParameters('package.update', sent), sent,
      'the capped set must be one the backend takes as-is');
  } finally {
    dom.restore();
  }
});

// ── data too old, or too absent, to bind a request to ───────────────────────

test('a stale package index withholds update work but never the refresh that fixes it', async () => {
  const { dom, node, calls } = await updatesTab({
    host: hostDetail({ packages: packagesFixture({ metadataAgeSeconds: 30 * 24 * 3600 }) }),
  });
  try {
    for (const label of ['Request package update', 'Request kernel update']) {
      const button = findButton(node, label);
      assert.equal(button.disabled, true, `${label} must be withheld`);
      assert.match(button.title, /Refresh the index first/);
      assert.match(button.title, /30 days ago/);
    }
    // Withholding the remedy too would leave a stale host with no way back.
    const refresh = findButton(node, 'Refresh index');
    assert.equal(refresh.disabled, false);
    inputByPlaceholder(node, 'why this refresh is needed').value = 'the index is a month old';
    refresh.dispatch('click');
    await settle();

    const posts = submissions(calls);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.operation, 'package.refresh');
    assert.deepEqual(posts[0].body.parameters, { manager: 'apt' });
  } finally {
    dom.restore();
  }
});

test('an index whose age the host never reported is treated as stale', async () => {
  // host-api projects -1 when the host did not say. Reading that as "fresh" is
  // how a month-old candidate version gets approved as if it were today's.
  const { dom, node, calls } = await updatesTab({
    host: hostDetail({ packages: packagesFixture({ metadataAgeSeconds: -1 }) }),
  });
  try {
    const button = findButton(node, 'Request package update');
    assert.equal(button.disabled, true);
    assert.match(button.title, /did not report when its package index was last refreshed/);
    button.dispatch('click');
    await settle();
    assert.equal(submissions(calls).length, 0);
  } finally {
    dom.restore();
  }
});

test('a host that has stopped reporting cannot have versions bound to it', async () => {
  const { dom, node, calls } = await updatesTab({
    host: hostDetail({ reportState: 'offline', snapshotAgeSeconds: 90000 }),
  });
  try {
    assert.match(node.textContent, /This host has stopped reporting/);
    for (const label of ['Request package update', 'Request kernel update']) {
      const button = findButton(node, label);
      assert.equal(button.disabled, true, `${label} must be withheld`);
      assert.match(button.title, /stopped reporting/);
      button.dispatch('click');
    }
    await settle();
    assert.equal(submissions(calls).length, 0);
    // The refresh is what makes it current again once it reports, so it stays.
    assert.equal(findButton(node, 'Refresh index').disabled, false);
  } finally {
    dom.restore();
  }
});

// ── one request at a time, and exactly once ─────────────────────────────────

test('one package operation in flight excludes the others', async () => {
  // All three contend for the same dpkg lock. Two approved operations racing
  // for it is a state nobody reviewed.
  const { dom, node, calls } = await updatesTab({
    operations: {
      items: [operation({
        id: 'a0000000-0000-0000-0000-0000000000b1',
        operation: 'package.update', status: 'approved',
        parameters: { manager: 'apt', packages: [{ name: 'curl', version: '8.5.0-2' }], securityOnly: false },
      })],
    },
  });
  try {
    for (const label of ['Refresh index', 'Request package update', 'Request kernel update']) {
      const button = findButton(node, label);
      assert.equal(button.disabled, true, `${label} must wait`);
      assert.match(button.title, /package\.update request on this host is already approved/);
      assert.match(button.title, /Package operations run one at a time/);
      button.dispatch('click');
    }
    await settle();
    assert.equal(submissions(calls).length, 0);
  } finally {
    dom.restore();
  }
});

test('a package operation that has finished does not block the next one', async () => {
  const { dom, node } = await updatesTab({
    operations: {
      items: [operation({
        operation: 'package.update', status: 'succeeded',
        parameters: { manager: 'apt', packages: [{ name: 'curl', version: '8.5.0-2' }], securityOnly: false },
        result: { outcome: 'succeeded', message: 'curl 8.5.0-1 to 8.5.0-2' },
      })],
    },
  });
  try {
    for (const label of ['Refresh index', 'Request package update', 'Request kernel update']) {
      assert.equal(findButton(node, label).disabled, false, `${label} must be available again`);
    }
  } finally {
    dom.restore();
  }
});

test('an accepted request clears the page so it cannot be sent twice', async () => {
  const { dom, node, calls } = await updatesTab();
  try {
    await requestUpdate(node, { names: ['curl'] });
    assert.equal(submissions(calls).length, 1);

    assert.deepEqual(selectedNames(node), [], 'the submitted set must not still be loaded');
    assert.equal(fieldControl(node, CONFIRM_PACKAGES).checked, false);
    assert.equal(inputByPlaceholder(node, 'why this update is needed').value, '');

    findButton(node, 'Request package update').dispatch('click');
    await settle();
    assert.equal(submissions(calls).length, 1, 'a second press must not resend it');
    assert.match(node.textContent, /Select at least one package to update/);
  } finally {
    dom.restore();
  }
});

test('two presses in the same tick make one request, not two', async () => {
  const { dom, node, calls } = await updatesTab();
  try {
    const button = prepareUpdate(node, { names: ['curl', 'openssl'] });
    button.dispatch('click');
    button.dispatch('click');
    await settle();

    assert.equal(submissions(calls).length, 1,
      'a double press must not create two approvals for the same work');
  } finally {
    dom.restore();
  }
});

test('a refusal is shown on the page and the reviewed selection is kept', async () => {
  // Discarding the selection on a refusal makes the operator rebuild the same
  // set by hand to retry something that never ran.
  const { dom, node, calls } = await updatesTab({
    failPost: { status: 403, error: 'this operation requires a different person to approve it' },
  });
  try {
    await requestUpdate(node, { names: ['curl', 'openssl'] });

    assert.equal(submissions(calls).length, 1);
    assert.match(node.textContent, /requires a different person to approve it/);
    assert.deepEqual(selectedNames(node), ['curl', 'openssl']);
    assert.equal(inputByPlaceholder(node, 'why this update is needed').value,
      'apply the pending security fixes');
  } finally {
    dom.restore();
  }
});

// ── the reason is bounded before it leaves the page ─────────────────────────

test('a reason the backend would refuse is refused here first', async () => {
  for (const [reason, expected] of [
    ['short', /at least 8 characters/],
    ['   ', /at least 8 characters/],
    ['x'.repeat(501), /at most 500 characters/],
    // Written as a code point rather than an escape, so the literal control
    // byte is what is under test rather than a two-character sequence.
    [`apply the fixes${String.fromCharCode(10)}and something else`, /control characters/],
  ]) {
    const { dom, node, calls } = await updatesTab();
    try {
      await requestUpdate(node, { names: ['curl'], reason });
      assert.equal(submissions(calls).length, 0, `"${reason.slice(0, 20)}" must not be sent`);
      assert.match(node.textContent, expected);
      // The work the operator did is still there to correct.
      assert.deepEqual(selectedNames(node), ['curl']);
    } finally {
      dom.restore();
    }
  }
});

test('an unconfirmed request is refused with the reason, not sent', async () => {
  const { dom, node, calls } = await updatesTab();
  try {
    await requestUpdate(node, { names: ['curl'], confirm: false });
    assert.equal(submissions(calls).length, 0);
    assert.match(node.textContent, /Confirm that you have reviewed the exact packages and versions/);
  } finally {
    dom.restore();
  }
});

test('an unconfirmed kernel update is refused with the reason, not sent', async () => {
  const { dom, node, calls } = await updatesTab();
  try {
    await requestKernel(node, { confirm: false });
    assert.equal(submissions(calls).length, 0);
    assert.match(node.textContent, /Confirm that you have reviewed the target release/);
  } finally {
    dom.restore();
  }
});

// ── nothing on this page becomes a command ──────────────────────────────────

test('a hostile package name is refused as ineligible and never becomes markup', async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const injected = 'curl; rm -rf /';
  const { dom, node } = await updatesTab({
    host: hostDetail({
      packages: packagesFixture({
        pendingTotal: 2,
        pending: [
          { name: hostile, currentVersion: '1.0-1', candidateVersion: '1.0-2', security: false },
          { name: injected, currentVersion: '8.5.0-1', candidateVersion: '8.5.0-2', security: true },
        ],
      }),
      snapshot: {
        identity: { hostname: 'node-a' },
        operations: { packageAllowlist: [hostile, injected] },
      },
    }),
  });
  try {
    // Allowlisted by the agent and still refused: the name itself is not one.
    assert.equal(packageBox(node, hostile), undefined);
    assert.equal(packageBox(node, injected), undefined);
    assert.match(node.textContent, /not a valid Debian package name/);
    assert.ok(node.textContent.includes(hostile), 'it must be shown, escaped, not dropped');
    assert.ok(node.textContent.includes(injected));

    const tags = node.descendants().map((child) => child.tagName);
    assert.ok(!tags.includes('IMG'));
    assert.ok(!tags.includes('SCRIPT'));
    for (const child of node.descendants()) assert.equal(child.attributes.onerror, undefined);

    const update = findButton(node, 'Request package update');
    assert.equal(update.disabled, true);
    assert.match(update.title, /No package on this host is selectable/);
  } finally {
    dom.restore();
  }
});

test('a pending package with no candidate version cannot be requested', async () => {
  // Without a version there is nothing for the approval to bind to, so the
  // host would install whatever its mirror offered when it got round to it.
  const { dom, node } = await updatesTab({
    host: hostDetail({
      packages: packagesFixture({
        pendingTotal: 1, pendingSecurity: 1,
        pending: [
          { name: 'curl', currentVersion: '8.5.0-1', candidateVersion: '', security: true },
        ],
      }),
    }),
  });
  try {
    assert.equal(packageBox(node, 'curl'), undefined);
    assert.match(node.textContent, /no usable candidate version to bind this request to/);
    const update = findButton(node, 'Request package update');
    assert.equal(update.disabled, true);
    assert.match(update.title, /No package on this host is selectable/);
  } finally {
    dom.restore();
  }
});

test('no field on the Updates page can become a package name or a command', async () => {
  const { dom, node } = await updatesTab();
  try {
    const reasons = [
      'why this kernel update is needed',
      'why this refresh is needed',
      'why this update is needed',
    ];
    const inputs = node.querySelectorAll('input');
    assert.ok(inputs.length > 0);
    for (const control of inputs) {
      assert.ok(['checkbox', 'text'].includes(control.type),
        `an update control may only be a checkbox or a reason, not ${control.type}`);
      if (control.type !== 'text') continue;
      // Every free-text field on this page is a reason. None of them names a
      // package, a version, a path, a unit or a flag.
      assert.ok(reasons.includes(control.getAttribute('placeholder')),
        `unexpected free-text field: ${control.getAttribute('placeholder')}`);
      assert.equal(control.getAttribute('maxlength'), '500');
    }
    assert.deepEqual(
      node.querySelectorAll('input').filter((c) => c.type === 'text')
        .map((c) => c.getAttribute('placeholder')).sort(),
      reasons);
    assert.equal(node.querySelectorAll('textarea').length, 0);
    assert.equal(node.querySelectorAll('select').length, 0);
  } finally {
    dom.restore();
  }
});

// ── the second person stays a second person ─────────────────────────────────

test('the page says a different administrator is needed before the request is made', async () => {
  // Learning this only after submitting, from a row that says "awaiting
  // approval", is how an operator sits waiting for a button that will never
  // enable for them.
  const { dom, node } = await updatesTab();
  try {
    const rendered = node.textContent;
    const notices = rendered.match(/A different administrator has to approve it before it runs/g) || [];
    assert.equal(notices.length, 2, 'both high-risk cards must say so, not one');
    assert.match(rendered, /you cannot approve your own request/);
    assert.match(rendered, /submitting it here does not start it/);
    // And the low-risk one must not claim a bar it does not have.
    assert.match(rendered, /one administrator may request it and it is accepted without a second/);
  } finally {
    dom.restore();
  }
});

// ── the kernel is separate, and never reboots ───────────────────────────────

test('the kernel request pins the release, states no reboot, and sends no reboot flag', async () => {
  const { dom, node, calls } = await updatesTab();
  try {
    assert.match(node.textContent, /It never reboots the host/);
    assert.doesNotMatch(node.textContent, /\*\*/,
      'emphasis markers reach a textContent sink as literal asterisks');

    await requestKernel(node);

    const posts = submissions(calls);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.operation, 'kernel.update');
    assert.deepEqual(posts[0].body.parameters,
      { manager: 'apt', targetRelease: '6.8.0-51-generic' });
    assert.equal('rebootAfter' in posts[0].body.parameters, false);
    // Accepted, so the card is cleared rather than left primed to resend.
    assert.equal(fieldControl(node, CONFIRM_KERNEL).checked, false);
    assert.equal(inputByPlaceholder(node, 'why this kernel update is needed').value, '');
  } finally {
    dom.restore();
  }
});

test('a host with no candidate kernel cannot request one', async () => {
  for (const candidate of ['', '6.8.0-51-generic; reboot']) {
    const { dom, node, calls } = await updatesTab({
      host: hostDetail({
        kernel: {
          running: '6.8.0-45-generic', installedLatest: '6.8.0-45-generic',
          candidate, updateAvailable: false, rebootRequired: false,
          rebootRequiredPackages: [], collectedAt: '2026-08-01T11:59:00.000Z',
        },
      }),
    });
    try {
      const button = findButton(node, 'Request kernel update');
      assert.equal(button.disabled, true, `candidate "${candidate}" must not be requestable`);
      assert.match(button.title, /no candidate kernel to request/);
      assert.match(node.textContent, /nothing to pin a request to/);
      button.dispatch('click');
      await settle();
      assert.equal(submissions(calls).length, 0);
    } finally {
      dom.restore();
    }
  }
});

test('a kernel image is never part of a package update', async () => {
  // Its own operation, its own risk statement, its own reboot answer. Slipping
  // one into a package set would install a kernel under a request that said it
  // was upgrading userland.
  const { normalizeParameters } = require('../opensphere-console-backend/operation-api');
  const image = 'linux-image-6.8.0-51-generic';
  const { dom, node, calls } = await updatesTab({
    host: hostDetail({
      packages: packagesFixture({
        pendingTotal: 3,
        pending: [
          ...packagesFixture().pending,
          { name: image, currentVersion: '', candidateVersion: '6.8.0-51.51', security: true },
        ],
      }),
      snapshot: {
        identity: { hostname: 'node-a' },
        operations: { packageAllowlist: ['curl', 'openssl', image] },
      },
    }),
  });
  try {
    assert.equal(packageBox(node, image), undefined, 'even allowlisted, it is not selectable');
    assert.match(node.textContent, /kernel image, which is requested as a kernel update instead/);

    findButton(node, 'Select all eligible').dispatch('click');
    assert.deepEqual(selectedNames(node), ['curl', 'openssl']);

    tick(fieldControl(node, CONFIRM_PACKAGES));
    inputByPlaceholder(node, 'why this update is needed').value = 'apply the pending updates';
    findButton(node, 'Request package update').dispatch('click');
    await settle();

    const names = submissions(calls)[0].body.parameters.packages.map((entry) => entry.name);
    assert.deepEqual(names, ['curl', 'openssl']);
    // And the backend refuses it independently, so the two agree.
    assert.throws(
      () => normalizeParameters('package.update', {
        manager: 'apt', packages: [{ name: image, version: '6.8.0-51.51' }],
      }),
      (error) => error.code === 400 && /kernel image/.test(error.msg));
  } finally {
    dom.restore();
  }
});

// ── the request stays visible after it is made ──────────────────────────────

test('a submitted request is visible on the same page with its state and result', async () => {
  // A request that vanishes after submission is indistinguishable from one that
  // was never accepted, and the terminal is the only place left to look.
  const { dom, node } = await updatesTab({
    operations: {
      items: [
        operation({
          id: 'a0000000-0000-0000-0000-0000000000c1',
          operation: 'package.update', status: 'succeeded',
          parameters: { manager: 'apt', packages: [{ name: 'curl', version: '8.5.0-2' }], securityOnly: false },
          approvedBy: '22222222-2222-2222-2222-222222222222',
          result: { outcome: 'succeeded', exitCode: 0, message: 'curl 8.5.0-1 to 8.5.0-2' },
        }),
        // A service restart on the same host belongs to the Operations tab.
        operation({ id: 'a0000000-0000-0000-0000-0000000000c2' }),
      ],
    },
  });
  try {
    const rendered = node.textContent;
    assert.match(rendered, /Update requests for this host/);
    assert.match(rendered, /package\.update/);
    assert.match(rendered, /Succeeded/);
    assert.match(rendered, /approved by a second person/);
    assert.match(rendered, /succeeded: curl 8\.5\.0-1 to 8\.5\.0-2/);
    // The Request column carries the operation name, so a restart leaking into
    // this table is visible as its own name rather than as its parameters.
    assert.doesNotMatch(rendered, /service\.restart/,
      'this list is update requests, not every operation on the host');
  } finally {
    dom.restore();
  }
});

test('a request awaiting a second person says so, and opens its audit trail in place', async () => {
  const pending = operation({
    id: 'a0000000-0000-0000-0000-0000000000d1',
    operation: 'kernel.update', status: 'awaiting_approval',
    parameters: { manager: 'apt', targetRelease: '6.8.0-51-generic' },
    viewer: { isRequester: true, isApprover: false },
  });
  const { dom, node, responses } = await updatesTab({ operations: { items: [pending] } });
  try {
    assert.match(node.textContent, /waiting for a different administrator; you requested it/);
    assert.match(node.textContent, /not run yet/);

    responses.operationDetail = {
      operation: pending,
      events: [{
        occurred_at: '2026-08-01T11:00:00.000Z', phase: 'requested',
        actor_type: 'operator', result: 'accepted',
      }],
    };
    findButton(node, 'Details').dispatch('click');
    await settle();

    assert.match(node.textContent, /Timeline/, 'the audit trail must open on this page');
    assert.match(node.textContent, /requested · operator · accepted/);

    const approve = findButton(node, 'Approve');
    assert.equal(approve.disabled, true, 'the requester may not approve their own request');
    assert.match(approve.title, /A different administrator has to approve it/);
    assert.equal(findButton(node, 'Reject').disabled, false,
      'rejecting your own request is not the thing being withheld');
  } finally {
    dom.restore();
  }
});

test('an operation opened elsewhere is not shown under the update heading', async () => {
  const { dom, node, responses } = await updatesTab({
    operations: { items: [operation({ operation: 'package.refresh', status: 'succeeded' })] },
  });
  try {
    responses.operationDetail = { operation: operation({ operation: 'service.restart' }), events: [] };
    await node.openOperation('a0000000-0000-0000-0000-000000000003');

    assert.doesNotMatch(node.textContent, /Operation service\.restart/,
      'a service restart is not an update request, whatever the panel was told to show');
  } finally {
    dom.restore();
  }
});

// ── Stage 4: network, storage and image surfaces ────────────────────────────

const STAGE4_IMAGE = `registry.example.com/polyon/os@sha256:${'b'.repeat(64)}`;

function stage4Capabilities(overrides = {}) {
  const on = { supported: true, reason: '', permitted: true };
  return capability({
    'network.configure': { ...on, operation: 'network.configure' },
    'mount.configure': { ...on, operation: 'mount.configure' },
    'filesystem.grow': { ...on, operation: 'filesystem.grow' },
    'osimage.stage': { ...on, operation: 'osimage.stage' },
    'osimage.rollback': { ...on, operation: 'osimage.rollback' },
    ...overrides,
  });
}

function stage4Host(overrides = {}) {
  return hostDetail({
    operations: stage4Capabilities(overrides.operations),
    policy: overrides.policy === undefined ? {
      id: 'c0000000-0000-0000-0000-000000000001', name: 'CC2 nightly',
      scope: 'control-center', version: 3, timezone: 'Europe/Berlin',
      allowedOperations: ['network.configure', 'mount.configure', 'filesystem.grow',
        'osimage.stage', 'osimage.rollback'],
      allowedImages: [STAGE4_IMAGE],
      allowedMountRoots: ['/srv'],
      emergencyAllowed: false, enabled: true, inWindow: true,
      windowEndsAt: '2026-08-01T13:00:00.000Z', windows: [],
    } : overrides.policy,
    snapshot: {
      identity: { hostname: 'node-a' },
      network: [],
      filesystems: [{ mountPoint: '/srv/data', device: '/dev/sdb1', fsType: 'ext4', usedBytes: 100, totalBytes: 800 }],
      operations: {
        packageAllowlist: [],
        networkAllowlist: ['lab-data'],
        mountRoots: ['/srv'],
        growAllowlist: ['/srv/data'],
        imageAllowlist: [STAGE4_IMAGE],
      },
    },
    host: {
      networkState: overrides.networkState === undefined ? {
        supported: true, manager: 'NetworkManager', unsupportedReason: '',
        links: [
          { name: 'eth0', type: 'ether', state: 'up', mtu: 1500, managed: true, connection: 'primary', method: 'manual', addresses: ['10.0.0.5/24'], staticAddresses: ['10.0.0.5/24'], gateway: '10.0.0.1', carriesRcc: true },
          { name: 'eth1', type: 'ether', state: 'up', mtu: 1500, managed: true, connection: 'lab-data', method: 'auto', addresses: [], staticAddresses: [], gateway: '', carriesRcc: false },
        ],
        defaultRoute: { present: true, interface: 'eth0', gateway: '10.0.0.1' },
        dns: { source: '/etc/resolv.conf', servers: ['10.0.0.1'], search: ['cc2.local'] },
        managementLink: 'eth0',
      } : overrides.networkState,
      storage: overrides.storage === undefined ? {
        supported: true, unsupportedReason: '',
        devices: [{ name: '/dev/sdc1', kind: 'part', sizeBytes: 2000, fsType: 'ext4', uuid: '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c', mountPoint: '', protected: false }],
        capacity: [{ mountPoint: '/srv/data', device: '/dev/sdb1', fsType: 'ext4', growable: true, protected: false, sizeBytes: 800, deviceBytes: 1000, headroomBytes: 200, reason: '' }],
      } : overrides.storage,
      boot: overrides.boot === undefined ? {
        supported: true, adapter: 'bootc', model: 'bootc',
        canStage: true, canRollback: true, rollbackAvailable: true,
        booted: { digest: `sha256:${'a'.repeat(64)}`, version: '9.4', origin: 'registry.example.com/polyon/os', booted: true },
        staged: null, deployments: [{ digest: `sha256:${'a'.repeat(64)}`, version: '9.4', booted: true }],
      } : overrides.boot,
      ...overrides.host,
    },
  });
}

async function stage4Tab(section, hostOverrides = {}, fixtures = {}) {
  const mounted = await mount({ ...fixtures, host: stage4Host(hostOverrides) });
  mounted.node.connectedCallback();
  await mounted.node.refresh();
  await mounted.node.select('node-a');
  mounted.node._section = section;
  mounted.node.render();
  return mounted;
}

async function stage4Section(section, hostOverrides = {}) {
  return (await stage4Tab(section, hostOverrides)).node;
}

test('the network tab names the management interface as never changeable', async () => {
  const node = await stage4Section('network');
  const text = node.textContent;
  assert.match(text, /Management interface/);
  assert.match(text, /never reconfigured by this platform/);
  // Both links are listed, and the one carrying the control path says so.
  assert.match(text, /eth0/);
  assert.match(text, /eth1/);
  assert.match(text, /carries the control path/);
});

test('an unsupported network stack is read-only, not blank', async () => {
  const node = await stage4Section('network', {
    networkState: {
      supported: false, manager: 'systemd-networkd',
      unsupportedReason: 'this agent build drives NetworkManager only',
      links: [{ name: 'eth0', state: 'up', managed: false, connection: '', addresses: [] }],
      defaultRoute: { present: true, interface: 'eth0' },
      dns: { servers: [], search: [] },
    },
  });
  const text = node.textContent;
  assert.match(text, /NetworkManager only/);
  // Read-only and unsupported are different things: the links are still shown.
  assert.match(text, /eth0/);
  assert.match(text, /this host is readable and not changeable/);
});

test('the storage tab explains why each filesystem cannot grow', async () => {
  const node = await stage4Section('storage', {
    storage: {
      supported: true,
      devices: [],
      capacity: [
        { mountPoint: '/srv/data', fsType: 'ext4', growable: true, sizeBytes: 800, deviceBytes: 1000, headroomBytes: 200, reason: '' },
        { mountPoint: '/', fsType: 'ext4', growable: false, protected: true, sizeBytes: 500, deviceBytes: 500, headroomBytes: 0, reason: 'protected: the root filesystem' },
      ],
    },
  });
  const text = node.textContent;
  assert.match(text, /protected: the root filesystem/);
  assert.match(text, /never moves data and never changes a partition table/);
  assert.match(text, /There is no shrink operation/);
});

test('an unreadable block layer says so rather than showing no disks', async () => {
  const node = await stage4Section('storage', {
    storage: { supported: false, unsupportedReason: 'lsblk is not present', devices: [], capacity: [] },
  });
  const text = node.textContent;
  assert.match(text, /lsblk is not present/);
  assert.match(text, /not the same as "this host has no disks"/);
});

test('a mutable host is told which operations do work on it', async () => {
  const node = await stage4Section('osimage', {
    boot: {
      supported: false, model: 'mutable', adapter: 'none',
      unsupportedReason: 'this host takes updates through its package manager, not as an image',
      deployments: [],
    },
  });
  const text = node.textContent;
  assert.match(text, /package manager/);
  assert.match(text, /mutable/);
});

test('the image tab states that staging never reboots', async () => {
  const node = await stage4Section('osimage');
  const text = node.textContent;
  assert.match(text, /Staging an image writes a new deployment and stops/);
  assert.match(text, /host\.reboot/);
});

test('every Stage 4 control is offered in its domain tab when policy and host both permit', async () => {
  for (const [section, labels] of [
    ['network', ['Request network change']],
    ['storage', ['Request filesystem growth', 'Request mount']],
    ['osimage', ['Request image staging', 'Request rollback']],
  ]) {
    const node = await stage4Section(section);
    for (const label of labels) {
      const button = findButton(node, label);
      assert.ok(button, `${label} must be rendered in ${section}`);
      assert.equal(button.disabled, false, `${label} must be enabled in ${section}`);
    }
  }
});

test('the Network tab submits one reviewed profile change and keeps Operations read-only', async () => {
  const { dom, node, calls } = await stage4Tab('network');
  try {
    fieldControl(node, 'Method').value = 'auto';
    inputByPlaceholder(node, 'why this change is needed').value = 'move the lab link back to DHCP';
    findButton(node, 'Request network change').dispatch('click');
    await settle();

    const post = submissions(calls).find((call) => call.body?.operation === 'network.configure');
    assert.deepEqual(post?.body, {
      operation: 'network.configure',
      parameters: {
        connection: 'lab-data',
        interface: 'eth1',
        method: 'auto',
        addresses: [],
        gateway: '',
        dns: [],
        searchDomains: [],
        mtu: 0,
        rollbackSeconds: 120,
      },
      reason: 'move the lab link back to DHCP',
    });
    node._section = 'operations';
    node.render();
    assert.equal(findButton(node, 'Request network change'), undefined);
  } finally {
    dom.restore();
  }
});

test('the Storage tab submits only reported growth and mount candidates', async () => {
  const { dom, node, calls } = await stage4Tab('storage');
  try {
    node.querySelectorAll('select')[0].value = '/srv/data';
    inputByPlaceholder(node, 'why this filesystem needs to grow').value =
      'consume the already enlarged block device';
    findButton(node, 'Request filesystem growth').dispatch('click');
    await settle();

    node.querySelectorAll('select')[1].value =
      '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c';
    node.querySelectorAll('select')[2].value = '/srv';
    inputByPlaceholder(node, 'data').value = 'archive';
    fieldControl(node, 'Read-only').checked = false;
    inputByPlaceholder(node, 'why this mount is needed').value =
      'attach the existing archive filesystem';
    findButton(node, 'Request mount').dispatch('click');
    await settle();

    const posts = submissions(calls).filter((call) =>
      ['mount.configure', 'filesystem.grow'].includes(call.body?.operation));
    assert.deepEqual(posts.map((post) => post.body), [
      {
        operation: 'filesystem.grow',
        parameters: { mountPoint: '/srv/data' },
        reason: 'consume the already enlarged block device',
      },
      {
        operation: 'mount.configure',
        parameters: {
          filesystemUuid: '2f1c8b0a-3d4e-4f5a-9b6c-7d8e9f0a1b2c',
          mountPoint: '/srv/archive',
          fsType: 'ext4',
          readOnly: false,
        },
        reason: 'attach the existing archive filesystem',
      },
    ]);
  } finally {
    dom.restore();
  }
});

test('the OS image tab stages or rolls back without carrying a reboot flag', async () => {
  const { dom, node, calls } = await stage4Tab('osimage');
  try {
    node.querySelectorAll('select')[0].value = STAGE4_IMAGE;
    inputByPlaceholder(node, 'why this image is being staged').value =
      'prepare the approved immutable release';
    findButton(node, 'Request image staging').dispatch('click');
    await settle();

    inputByPlaceholder(node, 'why this rollback is needed').value =
      'return to the last known deployment';
    findButton(node, 'Request rollback').dispatch('click');
    await settle();

    const posts = submissions(calls).filter((call) =>
      ['osimage.stage', 'osimage.rollback'].includes(call.body?.operation));
    assert.deepEqual(posts.map((post) => post.body), [
      {
        operation: 'osimage.stage',
        parameters: { adapter: 'bootc', image: STAGE4_IMAGE },
        reason: 'prepare the approved immutable release',
      },
      {
        operation: 'osimage.rollback',
        parameters: { adapter: 'bootc' },
        reason: 'return to the last known deployment',
      },
    ]);
    for (const post of posts) assert.equal('rebootAfter' in post.body.parameters, false);
  } finally {
    dom.restore();
  }
});

test('Operations links to Stage 4 domain workflows without duplicate submitters', async () => {
  const node = await stage4Section('operations');
  for (const label of ['Request network change', 'Request filesystem growth',
    'Request mount', 'Request image staging', 'Request rollback']) {
    assert.equal(findButton(node, label), undefined,
      `${label} must not be duplicated under Operations`);
  }
  assert.match(node.textContent, /requested from the Network tab/);
  assert.match(node.textContent, /live on the Storage tab/);
  assert.match(node.textContent, /live on the OS image tab/);
});

test('the management interface is never offered as a target', async () => {
  const node = await stage4Section('network');
  const options = node.querySelectorAll('option').map((o) => o.textContent);
  assert.ok(options.some((label) => label.includes('eth1')), 'a changeable link must be offered');
  assert.ok(!options.some((label) => label.includes('eth0')),
    'the link carrying the control path must never be offered');
});

test('a link the host does not allowlist is not offered', async () => {
  const host = stage4Host();
  host.snapshot.operations.networkAllowlist = [];
  const { node } = await mount({ host });
  node.connectedCallback();
  await node.refresh();
  await node.select('node-a');
  node._section = 'network';
  node.render();
  assert.equal(findButton(node, 'Request network change'), undefined);
  assert.match(node.textContent, /No interface on this host is both allowlisted/);
});

test('a capability the operator lacks is disabled with the permission named', async () => {
  const node = await stage4Section('network', {
    operations: {
      'network.configure': { supported: true, permitted: false, reason: 'requires console.hosts.network', operation: 'network.configure' },
    },
  });
  assert.match(node.textContent, /console\.hosts\.network/);
});

test('a policy allowlisting no image offers no staging control', async () => {
  const host = stage4Host();
  host.policy.allowedImages = [];
  const { node } = await mount({ host });
  node.connectedCallback();
  await node.refresh();
  await node.select('node-a');
  node._section = 'osimage';
  node.render();
  assert.equal(findButton(node, 'Request image staging'), undefined);
  assert.match(node.textContent, /no image in common/);
});

test('storage targets must be permitted by both policy and the agent', async () => {
  const host = stage4Host();
  host.snapshot.operations.growAllowlist = [];
  host.snapshot.operations.mountRoots = [];
  const { dom, node } = await mount({ host });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'storage';
    node.render();
    assert.equal(findButton(node, 'Request filesystem growth'), undefined);
    assert.equal(findButton(node, 'Request mount'), undefined);
    assert.match(node.textContent, /agent’s local growth allowlist/);
    assert.match(node.textContent, /no mount root in common/);
  } finally {
    dom.restore();
  }
});

test('an image allowed only by policy is not offered when the agent refuses it', async () => {
  const host = stage4Host();
  host.snapshot.operations.imageAllowlist = [];
  const { dom, node } = await mount({ host });
  try {
    node.connectedCallback();
    await node.refresh();
    await node.select('node-a');
    node._section = 'osimage';
    node.render();
    assert.equal(findButton(node, 'Request image staging'), undefined);
    assert.match(node.textContent, /no image in common/);
  } finally {
    dom.restore();
  }
});

test('the network form shows the state the request will be bound to', async () => {
  const node = await stage4Section('network');
  const text = node.textContent;
  assert.match(text, /Current state this request will be bound to/);
  assert.match(text, /refuses the operation rather than applying a reviewed change/);
  // And there is no "no rollback" option anywhere.
  assert.match(text, /There is no "never" value/);
});

test('nothing on the Stage 4 forms accepts a free-form command', async () => {
  let selectCount = 0;
  for (const section of ['network', 'storage', 'osimage']) {
    const node = await stage4Section(section);
    const inputs = node.querySelectorAll('input');
    for (const input of inputs) {
      const placeholder = input.getAttribute('placeholder') || '';
      assert.ok(!/command|shell|script|argument|flag/i.test(placeholder),
        `an input in ${section} invites a command: ${placeholder}`);
    }
    selectCount += node.querySelectorAll('select').length;
  }
  // Device paths and images are chosen from a list, never typed.
  assert.ok(selectCount >= 4, 'targets must be selected from what the host reports');
});

test('a rollback in flight shows the countdown and the state', async () => {
  const inFlight = operation({
    operation: 'network.configure',
    status: 'running',
    requiresRollback: true,
    rollbackState: 'armed',
    rollbackDeadlineAt: new Date(Date.now() + 90_000).toISOString(),
    parameters: { connection: 'lab-data', preState: { method: 'auto', addresses: [] } },
  });
  const { node } = await mount({
    host: stage4Host(),
    operations: { items: [inFlight] },
    responses: { operationDetail: { operation: inFlight, events: [] } },
  });
  node.connectedCallback();
  await node.refresh();
  await node.select('node-a');
  node._section = 'network';
  await node.openOperation(inFlight.id);
  const text = node.textContent;
  assert.match(text, /Automatic rollback/);
  assert.match(text, /seconds left to prove this control center is still reachable/);
  assert.match(text, /State when this was requested/);
});

test('a rollback that could not be completed demands a person', async () => {
  const failed = operation({
    operation: 'network.configure',
    status: 'failed',
    requiresRollback: true,
    rollbackState: 'rollback-failed',
    rollbackDeadlineAt: '2026-08-01T12:02:00.000Z',
    parameters: {},
  });
  const { node } = await mount({
    host: stage4Host(),
    operations: { items: [failed] },
    responses: { operationDetail: { operation: failed, events: [] } },
  });
  node.connectedCallback();
  await node.refresh();
  await node.select('node-a');
  node._section = 'network';
  await node.openOperation(failed.id);
  assert.match(node.textContent, /needs an operator to look at it directly/);
});

test('an unreported rollback outcome is shown as unknown, not as success', async () => {
  const unknown = operation({
    operation: 'network.configure',
    status: 'failed',
    requiresRollback: true,
    rollbackState: 'not-recorded',
    parameters: {},
  });
  const { node } = await mount({
    host: stage4Host(),
    operations: { items: [unknown] },
    responses: { operationDetail: { operation: unknown, events: [] } },
  });
  node.connectedCallback();
  await node.refresh();
  await node.select('node-a');
  node._section = 'network';
  await node.openOperation(unknown.id);
  assert.match(node.textContent, /unknown network state until it reports again/);
});

test('host-reported network and storage strings never become markup', async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const node = await stage4Section('network', {
    networkState: {
      supported: false,
      manager: hostile,
      unsupportedReason: hostile,
      links: [{ name: hostile, state: hostile, type: hostile, addresses: [hostile], connection: hostile }],
      defaultRoute: { present: true, interface: hostile },
      dns: { source: hostile, servers: [hostile], search: [hostile] },
    },
  });
  // The stub never parses markup, so the assertion is that the value arrived as
  // text at all — and that no element was created from it.
  assert.match(node.textContent, /<img src=x onerror=/);
  assert.equal(node.querySelectorAll('img').length, 0);
});

test('every bound the forms offer is a bound the backend actually accepts', () => {
  // A number control is a promise: everything between min and max will be
  // taken. Nothing enforced that promise, and the two sides are edited in
  // different languages in different directories — so a range widened in the
  // API leaves the console quietly hiding capability, and one narrowed in the
  // API leaves an operator filling in a whole form, writing a reason and
  // clicking through to a 400. Both bounds are driven through the real
  // normaliser here rather than compared as text, because it is the accepted
  // value that matters, not the constant it was written as.
  const entrySource = fs.readFileSync(entryPath, 'utf8');
  const { normalizeParameters } = require('../opensphere-console-backend/operation-api');

  const bounds = (control) => {
    const declaration = new RegExp(
      `const ${control} = input\\('number',[^)]*?min: '(\\d+)'[^)]*?max: '(\\d+)'`).exec(entrySource);
    assert.ok(declaration, `${control} must be a bounded number control`);
    return { min: Number(declaration[1]), max: Number(declaration[2]) };
  };

  const snapshot = {
    networkState: {
      supported: true, manager: 'NetworkManager',
      links: [{ name: 'eth1', managed: true, connection: 'lab-data', method: 'auto', staticAddresses: [], gateway: '', mtu: 1500 }],
      defaultRoute: { present: true, interface: 'eth0', gateway: '10.0.0.1' },
    },
    operations: { enabled: true, networkEnabled: true, networkAllowlist: ['lab-data'] },
  };
  const accepts = (operation, parameters) => {
    try {
      normalizeParameters(operation, parameters, { snapshot });
      return true;
    } catch {
      return false;
    }
  };

  const cases = [
    { control: 'lines', operation: 'journal.query', at: (lines) => ({ units: [], priority: '', lines }) },
    { control: 'deadline', operation: 'host.reboot', at: (deadlineSeconds) => ({ deadlineSeconds }) },
    {
      control: 'rollback',
      operation: 'network.configure',
      at: (rollbackSeconds) => ({ connection: 'lab-data', interface: 'eth1', method: 'auto', rollbackSeconds }),
    },
  ];
  for (const { control, operation, at } of cases) {
    const { min, max } = bounds(control);
    assert.ok(accepts(operation, at(min)),
      `${control}: the form offers ${min} but ${operation} refuses it`);
    assert.ok(accepts(operation, at(max)),
      `${control}: the form offers ${max} but ${operation} refuses it`);
    assert.ok(!accepts(operation, at(max + 1)),
      `${control}: ${operation} accepts ${max + 1}, so the form is hiding range the platform has`);
    assert.ok(!accepts(operation, at(min - 1)),
      `${control}: ${operation} accepts ${min - 1}, so the form is hiding range the platform has`);
  }

  // MTU is the one control whose domain has a hole in it — zero means
  // "unchanged", and the next legal value is far above it — which min/max
  // cannot express. The help text is what carries that to the operator, so the
  // help text is what has to agree with the backend.
  const mtu = bounds('mtu');
  const advertised = /0 leaves the MTU unchanged\. Otherwise (\d+) to (\d+)\./.exec(entrySource);
  assert.ok(advertised, 'the MTU field must state the range it really accepts');
  const [lowest, highest] = [Number(advertised[1]), Number(advertised[2])];
  assert.equal(mtu.max, highest, 'the MTU control and its own help text must agree');
  const withMtu = (value) => ({ connection: 'lab-data', interface: 'eth1', method: 'auto', rollbackSeconds: 120, mtu: value });
  assert.ok(accepts('network.configure', withMtu(0)), 'zero must still mean unchanged');
  assert.ok(accepts('network.configure', withMtu(lowest)), `the advertised floor ${lowest} must be accepted`);
  assert.ok(accepts('network.configure', withMtu(highest)), `the advertised ceiling ${highest} must be accepted`);
  assert.ok(!accepts('network.configure', withMtu(lowest - 1)),
    'the advertised floor must be the real floor');
  assert.ok(!accepts('network.configure', withMtu(highest + 1)),
    'the advertised ceiling must be the real ceiling');
});

test('the region is taken from the URL and never guessed', () => {
  const entrySource = fs.readFileSync(entryPath, 'utf8');
  // A hardcoded region in a shipped bundle is silently the wrong answer on any
  // deployment that has more than one, and every request on the page inherits
  // it. The deep-link route is what says which region is meant.
  assert.ok(!/'cc2'/.test(entrySource),
    'the bundle must not carry a hardcoded control center id');
  const resolver = entrySource.slice(entrySource.indexOf('_resolveControlCenterId'));
  assert.match(resolver, /\^\\\/cc\\\//,
    'the path match must be anchored so a /cc/ segment elsewhere cannot be read as the region');
  assert.match(entrySource, /Open this view from a region/,
    'an unknown region must be stated, not substituted');
});

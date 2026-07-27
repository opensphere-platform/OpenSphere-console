/**
 * linux-host-manager — RCC Linux host subShell entry bundle.
 *
 * Self-contained ESM. The Main Shell verifies this file's sha256 against
 * `entrySha256` in ui-shell.manifest.json before importing it from a Blob URL,
 * so it must have no import statements and no external runtime dependencies.
 *
 * Reporting is read-only. Every change is a typed operation: the console
 * requests it, the platform reviews and audits it, and the host's own agent
 * carries it out. Nothing here executes anything, and no field on this page
 * becomes a command, a path, a device or a flag.
 */

const PLUGIN_ID = 'linux-host-manager';
const ELEMENT_TAG = 'os-linux-host-manager';
// Matches the agent's nominal reporting cadence, so a host that stops reporting
// is shown as stale within one interval instead of staying green indefinitely.
const REFRESH_INTERVAL_MS = 60_000;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// These mirror the backend's grammar and bounds byte for byte. The console uses
// them to decide what it is willing to offer, never to decide what is allowed:
// the server re-validates everything. Offering a value the backend refuses
// wastes a review cycle; refusing one it accepts silently hides platform range.
const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9+.-]{1,127}$/;
const PACKAGE_VERSION_RE = /^([0-9]{1,4}:)?[0-9][A-Za-z0-9.+~-]{0,127}$/;
const KERNEL_RELEASE_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?(-[a-z0-9]{1,32})*$/;
const SYSTEMD_UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(\.[A-Za-z0-9][A-Za-z0-9_-]{0,63})*(@[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?\.(service|socket|timer|target|path|mount)$/;
const JOURNAL_TIME_SPEC_RE = /^(\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?|-?\d{1,4} (second|minute|hour|day)s? ago|now|today|yesterday)$/;
const IPV4_RE = /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const IPV4_CIDR_RE = /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\/([0-9]|[12][0-9]|3[0-2])$/;
const JOURNAL_PRIORITIES = ['', 'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const KERNEL_IMAGE_PREFIX = 'linux-image-';
const SUPPORTED_PACKAGE_MANAGER = 'apt';
const SSH_PROTECTION_PROFILE = 'rcc-ssh-baseline-v1';
const SSH_PROTECTION_DRIFT = `${SSH_PROTECTION_PROFILE}-drift`;
const MAX_UPDATE_PACKAGES = 32;
const MAX_JOURNAL_UNITS = 8;
const MAX_JOURNAL_LINES = 2000;
const MIN_REASON = 8;
const MAX_REASON = 500;
// Expressed as code points rather than a character class, so this bundle never
// has to carry a literal control byte in order to reject one.
function hasControlCharacter(value) {
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// A package index older than this describes the world as it was. The counts
// derived from it, and the candidate versions a request would be bound to, are
// both suspect, so update work is withheld until the index is refreshed.
const STALE_INDEX_SECONDS = 7 * 24 * 3600;

// The operations that contend for the host's package manager. Any one of them
// in flight excludes the others: apt takes a single lock, and two approved
// requests racing for it is a failure nobody reviewed.
const PACKAGE_OPERATIONS = [
  'package.refresh', 'package.update', 'kernel.update', 'ssh.protection.enable',
];
const JOURNAL_OPERATIONS = ['journal.query'];
const SERVICE_OPERATIONS = ['service.restart'];
const REBOOT_OPERATIONS = ['host.reboot'];
const NETWORK_OPERATIONS = ['network.configure'];
const STORAGE_OPERATIONS = ['mount.configure', 'filesystem.grow'];
const OS_IMAGE_OPERATIONS = ['osimage.stage', 'osimage.rollback'];
const TERMINAL_OPERATION_STATES = new Set(
  ['succeeded', 'failed', 'rejected', 'cancelled', 'expired'],
);
// A host that has stopped reporting cannot be the source of the versions a
// request binds itself to. Refreshing the index is how it starts reporting
// again, so that one stays available; the two that bind versions do not.
const NON_REPORTING_STATES = new Set(['offline', 'never-reported']);

/** Mirrors the backend's boundedReason, so the refusal is shown before submit. */
function reasonProblem(value) {
  const reason = String(value ?? '').trim();
  if (hasControlCharacter(reason)) return 'The reason must not contain control characters.';
  if (reason.length < MIN_REASON) {
    return `The reason must be at least ${MIN_REASON} characters; it has ${reason.length}.`;
  }
  if (reason.length > MAX_REASON) {
    return `The reason must be at most ${MAX_REASON} characters; it has ${reason.length}.`;
  }
  return '';
}

/** The backend sorts a package set before digesting it; this agrees with it. */
function byName(left, right) {
  if (left.name < right.name) return -1;
  return left.name > right.name ? 1 : 0;
}

/** Renders an age in whole units an operator reads at a glance. */
function describeAge(seconds) {
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** One exact IP address, canonicalised for the backend/agent digest. */
function canonicalIPAddress(value) {
  const address = String(value ?? '').trim();
  if (!address || /[\s/]/.test(address)) return '';
  if (address.includes(':')) {
    try {
      const host = new URL(`http://[${address}]/`).hostname;
      if (!host.startsWith('[') || !host.endsWith(']')) return '';
      const canonical = host.slice(1, -1).toLowerCase();
      const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
      if (!mapped) return canonical;
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    } catch {
      return '';
    }
  }
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return '';
  const numbers = parts.map(Number);
  if (numbers.some((part) => part < 0 || part > 255)) return '';
  return numbers.join('.');
}

const SECTION_GROUPS = [
  {
    id: 'summary',
    label: '요약',
    sections: [{ id: 'overview', label: '호스트 개요' }],
  },
  {
    id: 'observe',
    label: '관측',
    sections: [
      { id: 'metrics', label: '메트릭' },
      { id: 'services', label: '서비스' },
      { id: 'journal', label: '시스템 로그' },
    ],
  },
  {
    id: 'security',
    label: '보안',
    sections: [{ id: 'sshban', label: 'SSH 보호' }],
  },
  {
    id: 'maintenance',
    label: '유지보수',
    sections: [
      { id: 'updates', label: '업데이트' },
      { id: 'reboot', label: '재부팅' },
      { id: 'osimage', label: 'OS 이미지' },
    ],
  },
  {
    id: 'configuration',
    label: '구성',
    sections: [
      { id: 'network', label: '네트워크' },
      { id: 'storage', label: '스토리지' },
    ],
  },
  {
    id: 'activity',
    label: '이력',
    sections: [{ id: 'operations', label: '작업 이력' }],
  },
];
const SECTIONS = SECTION_GROUPS.flatMap((group) =>
  group.sections.map((section) => ({ ...section, groupId: group.id })));

function groupForSection(sectionId) {
  return SECTION_GROUPS.find((group) =>
    group.sections.some((section) => section.id === sectionId)) || SECTION_GROUPS[0];
}

// Stage 4 rollback states, as the agent reports them.
const ROLLBACK_STATE_LABEL = {
  none: { text: 'Not applicable', cls: 'label' },
  armed: { text: 'Armed', cls: 'label-warning' },
  confirmed: { text: 'Confirmed', cls: 'label-success' },
  'rolled-back': { text: 'Rolled back', cls: 'label-warning' },
  'rollback-failed': { text: 'Rollback failed', cls: 'label-danger' },
  'not-recorded': { text: 'Unknown', cls: 'label-danger' },
};

// Stage 2 states, in the order a request moves through them.
const OPERATION_STATE_LABEL = {
  requested: { text: 'Requested', cls: 'label-info' },
  awaiting_approval: { text: 'Awaiting approval', cls: 'label-warning' },
  approved: { text: 'Approved', cls: 'label-info' },
  preparing: { text: 'Preparing', cls: 'label-info' },
  dispatchable: { text: 'Ready to run', cls: 'label-info' },
  leased: { text: 'Collected', cls: 'label-info' },
  running: { text: 'Running', cls: 'label-warning' },
  succeeded: { text: 'Succeeded', cls: 'label-success' },
  failed: { text: 'Failed', cls: 'label-danger' },
  rejected: { text: 'Rejected', cls: 'label-danger' },
  cancelled: { text: 'Cancelled', cls: 'label' },
  expired: { text: 'Expired', cls: 'label' },
};

const REPORT_STATE_LABEL = {
  fresh: { text: 'Reporting', cls: 'label-success' },
  stale: { text: 'Stale', cls: 'label-warning' },
  offline: { text: 'Offline', cls: 'label-danger' },
  'never-reported': { text: 'Never reported', cls: 'label-info' },
  unknown: { text: 'Unknown', cls: 'label-warning' },
};

function text(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function bytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function duration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function percentUsed(used, total) {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

function decimal(value, suffix = '', digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const rendered = value.toFixed(digits).replace(/\.0+$/, '');
  return `${rendered}${suffix}`;
}

function bytesPerSecond(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 B/s';
  return `${bytes(value)}/s`;
}

function metricTimestamp(value) {
  const time = Date.parse(String(value || ''));
  if (!Number.isFinite(time)) return '—';
  return new Date(time).toLocaleString();
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

/**
 * Small dependency-free line chart for bounded, server-projected metrics.
 *
 * Every coordinate is derived from finite numbers. A source collection gap
 * starts a new polyline instead of drawing a reassuring line across missing
 * telemetry.
 */
function metricChart(title, points, series, options = {}) {
  const panel = el('section', 'os-metric-chart');
  const header = el('div', 'os-metric-chart-header');
  header.appendChild(el('strong', null, title));
  const legend = el('div', 'os-metric-legend');
  for (const item of series) {
    const label = el('span');
    const swatch = el('i');
    swatch.setAttribute('style', `background:${item.color}`);
    label.appendChild(swatch);
    label.appendChild(document.createTextNode(item.label));
    legend.appendChild(label);
  }
  header.appendChild(legend);
  panel.appendChild(header);

  if (!Array.isArray(points) || points.length < 2) {
    panel.appendChild(el('p', 'os-host-empty', 'Not enough points to draw this range.'));
    return panel;
  }

  const width = 640;
  const height = 180;
  const padding = { left: 42, right: 12, top: 14, bottom: 24 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const values = points.flatMap((point) => series.map((item) => Number(point?.[item.key])))
    .filter(Number.isFinite);
  const floor = Number.isFinite(options.min) ? options.min : Math.min(0, ...values);
  const ceilingCandidate = Number.isFinite(options.max) ? options.max : Math.max(...values, 1);
  const ceiling = ceilingCandidate > floor ? ceilingCandidate : floor + 1;
  const svg = svgElement('svg', {
    class: 'os-metric-svg',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `${title}, ${points.length} points from ${
      metricTimestamp(points[0]?.timestamp)
    } to ${metricTimestamp(points.at(-1)?.timestamp)}`,
  });

  for (let line = 0; line <= 4; line += 1) {
    const y = padding.top + (chartHeight * line) / 4;
    svg.appendChild(svgElement('line', {
      x1: padding.left, y1: y, x2: width - padding.right, y2: y,
      class: 'os-metric-grid-line',
    }));
  }

  const yFor = (value) => padding.top
    + chartHeight - ((Math.min(ceiling, Math.max(floor, value)) - floor) / (ceiling - floor)) * chartHeight;
  const xFor = (index) => padding.left + (chartWidth * index) / Math.max(1, points.length - 1);
  for (const item of series) {
    let segment = [];
    const flush = () => {
      if (segment.length > 1) {
        svg.appendChild(svgElement('polyline', {
          points: segment.join(' '),
          fill: 'none',
          stroke: item.color,
          'stroke-width': 2.5,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
          'vector-effect': 'non-scaling-stroke',
        }));
      }
      segment = [];
    };
    points.forEach((point, index) => {
      const value = Number(point?.[item.key]);
      if (point?.gapBefore === true) flush();
      if (!Number.isFinite(value)) {
        flush();
        return;
      }
      segment.push(`${xFor(index).toFixed(2)},${yFor(value).toFixed(2)}`);
    });
    flush();
  }

  const topLabel = svgElement('text', {
    x: 4, y: padding.top + 5, class: 'os-metric-axis-label',
  });
  topLabel.textContent = options.formatAxis ? options.formatAxis(ceiling) : decimal(ceiling);
  svg.appendChild(topLabel);
  const bottomLabel = svgElement('text', {
    x: 4, y: padding.top + chartHeight, class: 'os-metric-axis-label',
  });
  bottomLabel.textContent = options.formatAxis ? options.formatAxis(floor) : decimal(floor);
  svg.appendChild(bottomLabel);
  panel.appendChild(svg);

  const timeLabels = el('div', 'os-metric-time-labels');
  timeLabels.appendChild(el('span', null, metricTimestamp(points[0]?.timestamp)));
  timeLabels.appendChild(el('span', null, metricTimestamp(points.at(-1)?.timestamp)));
  panel.appendChild(timeLabels);
  return panel;
}

/** Every value that reaches the DOM goes through textContent, never innerHTML. */
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
}

/**
 * A section whose controls this deployment does not offer, with the reason.
 *
 * The reason is the backend's own, not a stage number: whether a control can be
 * used depends on this control center's mode, this host's agent and this
 * operator's permissions, and every one of those produces a different answer
 * that the operator can act on. "Not available in this stage" is true of none
 * of them and actionable for none of them.
 */
function unavailableNotice(sectionLabel, reason) {
  const alert = el('div', 'alert alert-info');
  const item = el('div', 'alert-item static');
  item.appendChild(el('span', 'alert-text',
    `${sectionLabel} controls are not available on this host: ${
      reason || 'this control center did not say why'}. `
    + 'Reported state below is unaffected and is still what the host last said.'));
  alert.appendChild(item);
  return alert;
}

/**
 * A control the operator is not permitted to use is shown, disabled, with the
 * reason. Hiding it would leave someone guessing why the feature seems absent.
 */
function gatedButton(label, className, allowed, reason, onClick) {
  const button = el('button', className, label);
  button.type = 'button';
  if (allowed) {
    button.addEventListener('click', onClick);
  } else {
    button.disabled = true;
    button.title = reason;
    button.setAttribute('aria-disabled', 'true');
  }
  return button;
}

function labelFor(map, key) {
  return map[key] || { text: String(key || 'unknown'), cls: 'label' };
}

function badge(map, key) {
  const spec = labelFor(map, key);
  return el('span', `label ${spec.cls}`, spec.text);
}

function field(labelText, control, hint) {
  const wrapper = el('div', 'clr-form-control os-op-field');
  wrapper.appendChild(el('label', 'clr-control-label', labelText));
  wrapper.appendChild(control);
  if (hint) wrapper.appendChild(el('span', 'clr-subtext', hint));
  return wrapper;
}

function input(type, value, attrs = {}) {
  const node = document.createElement('input');
  node.type = type;
  node.className = 'clr-input';
  if (value !== undefined) node.value = String(value);
  for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, String(val));
  return node;
}

function select(options, value) {
  const node = document.createElement('select');
  node.className = 'clr-select';
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    if (option.value === value) item.selected = true;
    node.appendChild(item);
  }
  return node;
}

/** Renders remote text safely: pre-wrapped, textContent only, never HTML. */
function outputBlock(text, truncated) {
  const wrapper = el('div', 'os-op-output');
  const pre = document.createElement('pre');
  pre.className = 'os-op-pre';
  pre.textContent = String(text || '');
  wrapper.appendChild(pre);
  if (truncated) {
    wrapper.appendChild(el('p', 'os-host-empty', 'Output was truncated by the agent before it left the host.'));
  }
  return wrapper;
}

function definitionList(pairs) {
  const list = el('dl', 'os-host-dl');
  for (const [term, value] of pairs) {
    list.appendChild(el('dt', null, term));
    list.appendChild(el('dd', null, value));
  }
  return list;
}

function table(headers, rows, emptyMessage) {
  if (!rows.length) return el('p', 'os-host-empty', emptyMessage);
  const wrapper = el('div', 'table-wrapper');
  const t = el('table', 'table table-compact');
  const thead = el('thead');
  const headRow = el('tr');
  for (const h of headers) headRow.appendChild(el('th', null, h));
  thead.appendChild(headRow);
  t.appendChild(thead);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) tr.appendChild(el('td', null, cell));
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  wrapper.appendChild(t);
  return wrapper;
}

function styleText() {
  return `
    ${ELEMENT_TAG} { display: block; }
    ${ELEMENT_TAG} .os-host-layout { display: grid; grid-template-columns: minmax(18rem, 24rem) 1fr; gap: 1rem; align-items: start; }
    ${ELEMENT_TAG} .os-host-card { border: 1px solid var(--clr-color-neutral-400, #cccccc); border-radius: 0.15rem; padding: 0.75rem; background: var(--clr-global-app-background, #fafafa); }
    ${ELEMENT_TAG} .os-host-row { display: flex; justify-content: space-between; gap: 0.5rem; padding: 0.4rem 0.25rem; border-bottom: 1px solid var(--clr-color-neutral-300, #e8e8e8); cursor: pointer; }
    ${ELEMENT_TAG} .os-host-row:last-child { border-bottom: none; }
    ${ELEMENT_TAG} .os-host-row[aria-selected='true'] { background: var(--clr-color-action-100, #e1f1f6); }
    ${ELEMENT_TAG} .os-host-dl { display: grid; grid-template-columns: minmax(9rem, 14rem) 1fr; gap: 0.2rem 1rem; margin: 0; }
    ${ELEMENT_TAG} .os-host-dl dt { font-weight: 600; }
    ${ELEMENT_TAG} .os-host-dl dd { margin: 0; }
    ${ELEMENT_TAG} .os-host-empty { color: var(--clr-color-neutral-600, #666666); }
    ${ELEMENT_TAG} .os-host-domains { display: flex; flex-wrap: wrap; gap: 0.25rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--clr-color-neutral-300, #e8e8e8); }
    ${ELEMENT_TAG} .os-host-domains button { border: 0; border-radius: 1rem; padding: 0.3rem 0.75rem; background: transparent; color: var(--clr-color-neutral-700, #565656); cursor: pointer; font-weight: 600; }
    ${ELEMENT_TAG} .os-host-domains button[aria-current='page'] { background: var(--clr-color-action-100, #e1f1f6); color: var(--clr-color-action-700, #006080); }
    ${ELEMENT_TAG} .os-host-sections { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0.55rem 0 0.9rem; }
    ${ELEMENT_TAG} .os-security-summary { display: grid; grid-template-columns: repeat(4, minmax(9rem, 1fr)); gap: 0.5rem; margin: 0.75rem 0; }
    ${ELEMENT_TAG} .os-security-card { border: 1px solid var(--clr-color-neutral-300, #e8e8e8); border-radius: 0.2rem; padding: 0.7rem; background: var(--clr-color-neutral-0, #ffffff); }
    ${ELEMENT_TAG} .os-security-card span, ${ELEMENT_TAG} .os-security-card small { display: block; color: var(--clr-color-neutral-600, #666666); }
    ${ELEMENT_TAG} .os-security-card strong { display: block; margin: 0.25rem 0; font-size: 1rem; }
    ${ELEMENT_TAG} .os-readiness { list-style: none; padding: 0; margin: 0.5rem 0 1rem; border: 1px solid var(--clr-color-neutral-300, #e8e8e8); border-radius: 0.2rem; }
    ${ELEMENT_TAG} .os-readiness li { display: grid; grid-template-columns: 7rem 1fr; gap: 0.6rem; padding: 0.45rem 0.65rem; border-bottom: 1px solid var(--clr-color-neutral-300, #e8e8e8); }
    ${ELEMENT_TAG} .os-readiness li:last-child { border-bottom: 0; }
    ${ELEMENT_TAG} .os-security-actions { display: grid; grid-template-columns: repeat(2, minmax(18rem, 1fr)); gap: 0.75rem; }
    ${ELEMENT_TAG} .os-metrics-toolbar { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.75rem; }
    ${ELEMENT_TAG} .os-metrics-source { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; }
    ${ELEMENT_TAG} .os-metric-summary { display: grid; grid-template-columns: repeat(5, minmax(8rem, 1fr)); gap: 0.5rem; margin: 0.75rem 0; }
    ${ELEMENT_TAG} .os-metric-card { border: 1px solid var(--clr-color-neutral-300, #e8e8e8); border-radius: 0.15rem; padding: 0.65rem; background: var(--clr-color-neutral-0, #ffffff); }
    ${ELEMENT_TAG} .os-metric-card span, ${ELEMENT_TAG} .os-metric-card small { display: block; color: var(--clr-color-neutral-600, #666666); }
    ${ELEMENT_TAG} .os-metric-card strong { display: block; margin: 0.2rem 0; font-size: 1.15rem; font-variant-numeric: tabular-nums; }
    ${ELEMENT_TAG} .os-metric-chart-grid { display: grid; grid-template-columns: repeat(2, minmax(18rem, 1fr)); gap: 0.75rem; }
    ${ELEMENT_TAG} .os-metric-chart { min-width: 0; border: 1px solid var(--clr-color-neutral-300, #e8e8e8); border-radius: 0.15rem; padding: 0.55rem; background: var(--clr-color-neutral-0, #ffffff); }
    ${ELEMENT_TAG} .os-metric-chart-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.4rem; }
    ${ELEMENT_TAG} .os-metric-legend { display: flex; flex-wrap: wrap; gap: 0.5rem; color: var(--clr-color-neutral-600, #666666); font-size: 0.65rem; }
    ${ELEMENT_TAG} .os-metric-legend span { display: inline-flex; align-items: center; gap: 0.2rem; }
    ${ELEMENT_TAG} .os-metric-legend i { display: inline-block; width: 0.65rem; height: 0.18rem; }
    ${ELEMENT_TAG} .os-metric-svg { display: block; width: 100%; min-height: 10rem; margin-top: 0.35rem; overflow: visible; }
    ${ELEMENT_TAG} .os-metric-grid-line { stroke: var(--clr-color-neutral-300, #e8e8e8); stroke-width: 1; vector-effect: non-scaling-stroke; }
    ${ELEMENT_TAG} .os-metric-axis-label { fill: var(--clr-color-neutral-600, #666666); font-size: 10px; }
    ${ELEMENT_TAG} .os-metric-time-labels { display: flex; justify-content: space-between; gap: 1rem; color: var(--clr-color-neutral-600, #666666); font-size: 0.6rem; }
    ${ELEMENT_TAG} .os-metrics-warnings { margin: 0.5rem 0; padding-left: 1.25rem; color: var(--clr-color-neutral-700, #565656); }
    ${ELEMENT_TAG} .os-op-field { margin-bottom: 0.5rem; display: block; }
    ${ELEMENT_TAG} .os-op-form { border: 1px solid var(--clr-color-neutral-400, #cccccc); border-radius: 0.15rem; padding: 0.75rem; margin-bottom: 1rem; }
    ${ELEMENT_TAG} .os-op-pre { white-space: pre-wrap; word-break: break-word; max-height: 24rem; overflow: auto; background: var(--clr-color-neutral-100, #f3f3f3); padding: 0.5rem; margin: 0.25rem 0; font-size: 0.65rem; }
    ${ELEMENT_TAG} .os-op-actions { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.5rem 0; }
    ${ELEMENT_TAG} .os-op-timeline { list-style: none; padding-left: 0; margin: 0.5rem 0; }
    ${ELEMENT_TAG} .os-op-timeline li { padding: 0.2rem 0; border-bottom: 1px solid var(--clr-color-neutral-300, #e8e8e8); }
    @media (max-width: 48rem) {
      ${ELEMENT_TAG} .os-op-form { padding: 0.5rem; }
      ${ELEMENT_TAG} .os-op-actions button { flex: 1 1 auto; }
      ${ELEMENT_TAG} .os-host-layout { grid-template-columns: 1fr; }
      ${ELEMENT_TAG} .os-security-summary { grid-template-columns: repeat(2, minmax(8rem, 1fr)); }
      ${ELEMENT_TAG} .os-security-actions { grid-template-columns: 1fr; }
      ${ELEMENT_TAG} .os-metric-summary { grid-template-columns: repeat(2, minmax(8rem, 1fr)); }
      ${ELEMENT_TAG} .os-metric-chart-grid { grid-template-columns: 1fr; }
    }
  `;
}

function createElementClass(ctx) {
  return class LinuxHostManagerElement extends HTMLElement {
    constructor() {
      super();
      this._hosts = [];
      this._selected = null;
      this._detail = null;
      this._section = 'overview';
      this._metrics = null;
      this._metricsRange = '1h';
      this._metricsLoading = false;
      this._metricsError = '';
      this._metricsRequest = 0;
      this._error = '';
      this._featureMissing = false;
      this._loading = true;
      this._generatedAt = '';
      // Whether the fleet list stopped at the API's page bound. A cut-off list
      // that says nothing reads as the whole fleet, and the count beside it
      // reads as the number of hosts in the region.
      this._fleetTruncated = false;
      this._fleetLimit = 0;
      this._disposed = false;
      this._timer = null;
      // Bumped on every disconnect and every user-initiated load. A response
      // that resolves against a stale generation is discarded instead of
      // overwriting newer state.
      this._generation = 0;
      this._refreshing = false;
      this._operations = [];
      this._operationDetail = null;
      this._operationError = '';
      this._operationBusy = false;
      this._journalForm = { units: '', priority: '', since: '', lines: 200, reason: '' };
      this._restartForm = { unit: '', reason: '' };
      this._rebootForm = { deadlineSeconds: 600, reason: '' };
      this._networkEmergency = false;
      this._filesystemGrowEmergency = false;
      this._mountEmergency = false;
      this._imageStageEmergency = false;
      this._imageRollbackEmergency = false;
      // The Updates workflow. Selection lives on the element, not in a closure
      // inside the render, because the view re-renders on a timer: a selection
      // held in the DOM would be silently discarded every time the host
      // reported, and the operator would submit a set they no longer chose.
      // Each entry records the exact versions the operator reviewed, so the
      // request can be bound to them and a version that moved underneath is
      // detectable rather than invisible.
      this._updateSelection = new Map();
      this._updateSecurityOnly = false;
      this._updateConfirmed = false;
      this._updateReason = '';
      this._kernelReason = '';
      this._kernelConfirmed = false;
      this._refreshReason = '';
      this._sshProtectionReason = '';
      this._sshProtectionConfirmed = false;
      this._sshBanAddress = '';
      this._sshBanReason = '';
      this._sshBanConfirmed = false;
      this._sshUnbanAddress = '';
      this._sshUnbanReason = '';
      this._sshUnbanConfirmed = false;
      // What changed under the operator between one report and the next. Held
      // on the element so the notice survives the render that follows.
      this._updateDrift = { dropped: [], moved: [] };
    }

    /**
     * Re-binds the selection to the versions the host now reports.
     *
     * A package that stopped being eligible is dropped, and one whose candidate
     * version moved is re-bound to the new version. Either way the operator's
     * confirmation is withdrawn: they confirmed a specific set at specific
     * versions, and this is no longer that set.
     */
    _reconcileSelection(eligible) {
      const live = new Map(eligible.map((entry) => [entry.name, entry]));
      const dropped = [];
      const moved = [];
      for (const [name, chosen] of [...this._updateSelection]) {
        const current = live.get(name);
        if (!current) {
          this._updateSelection.delete(name);
          dropped.push(name);
          continue;
        }
        if (current.candidateVersion !== chosen.candidateVersion) {
          this._updateSelection.set(name, { ...current });
          moved.push(`${name} ${chosen.candidateVersion} to ${current.candidateVersion}`);
        }
      }
      if (dropped.length || moved.length) this._updateConfirmed = false;
      this._updateDrift = { dropped, moved };
    }

    /** Any selection change invalidates a confirmation given before it. */
    _mutateSelection(change) {
      change();
      this._updateConfirmed = false;
      this._updateDrift = { dropped: [], moved: [] };
      this.render();
    }

    connectedCallback() {
      // The same element instance can be detached and reattached; without
      // clearing this the view would stay permanently frozen after remount.
      this._disposed = false;
      this._controlCenterId = this._resolveControlCenterId();
      this.render();
      void this.refresh();
      this._startPolling();
    }

    disconnectedCallback() {
      this._disposed = true;
      this._generation += 1;
      this._metricsRequest += 1;
      this._stopPolling();
    }

    _startPolling() {
      this._stopPolling();
      // Freshness is computed from the agent's collection time, so a static
      // view silently ages into a wrong answer. Re-read on a fixed interval.
      this._timer = setInterval(() => {
        if (this._disposed || this._refreshing) return;
        void this.refresh({ silent: true });
      }, REFRESH_INTERVAL_MS);
    }

    _stopPolling() {
      if (this._timer !== null) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }

    _resolveControlCenterId() {
      // Main Shell의 사용자 메뉴는 /cc/<region>/hosts 안정 별칭을 사용한다.
      // 오래된 /p/linux-host-manager 북마크처럼 지역이 없는 경로에서는
      // 권한이 있는 지역을 추측하지 않는다.
      const match = /^\/cc\/([a-z0-9-]+)(?:\/|$)/.exec(window.location.pathname);
      if (match) return match[1];
      const declared = this.getAttribute('control-center');
      if (declared) return declared;
      // Falling back to a hardcoded region would silently point every request
      // at the wrong one. The host asks the platform which region it is in.
      return ctx.controlCenterId || '';
    }

    async _get(path) {
      const response = await ctx.api.fetch(path, { headers: { accept: 'application/json' } });
      if (response.status === 404) {
        // A missing API is materially different from an empty fleet.
        const missing = new Error('not-installed');
        missing.code = 404;
        throw missing;
      }
      if (!response.ok) {
        let body = null;
        try { body = await response.json(); } catch { body = null; }
        const failure = new Error(body?.error || `request failed with HTTP ${response.status}`);
        failure.code = response.status;
        throw failure;
      }
      return response.json();
    }

    async refresh({ silent = false } = {}) {
      if (this._disposed) return;
      if (!this._controlCenterId) {
        // Guessing one would point every request on this page at a region
        // nobody chose. On a deployment with more than one that is silently the
        // wrong answer, and there is a URL that says which region is meant.
        this._loading = false;
        this._error = 'Open this view from a region: /cc/<region>/hosts';
        this._hosts = [];
        this._detail = null;
        this._metrics = null;
        this._metricsError = '';
        this.render();
        return;
      }
      this._refreshing = true;
      const generation = this._generation;
      // A background poll must not blank the screen the operator is reading.
      if (!silent) {
        this._loading = true;
        this._error = '';
        this._featureMissing = false;
        this.render();
      }
      try {
        const payload = await this._get(`control-centers/${this._controlCenterId}/hosts`);
        if (this._isStale(generation)) return;
        this._error = '';
        this._featureMissing = false;
        this._hosts = Array.isArray(payload.items) ? payload.items : [];
        this._generatedAt = payload.generatedAt || '';
        this._fleetTruncated = payload.truncated === true;
        this._fleetLimit = Number.isFinite(payload.limit) ? payload.limit : this._hosts.length;
        if (this._selected && !this._hosts.some((h) => h.hostId === this._selected)) this._selected = null;
        if (!this._selected && this._hosts.length) this._selected = this._hosts[0].hostId;
        if (this._selected) await this.loadDetail(this._selected, generation);
      } catch (error) {
        if (this._isStale(generation)) return;
        if (error?.code === 404) this._featureMissing = true;
        else this._error = error?.message || 'host inventory is unavailable';
        this._hosts = [];
        this._detail = null;
        this._metrics = null;
        this._metricsError = '';
        // A failed load has no fleet, so it cannot have a partial one either.
        this._fleetTruncated = false;
        this._fleetLimit = 0;
      } finally {
        this._refreshing = false;
        if (!this._isStale(generation)) {
          this._loading = false;
          this.render();
        }
      }
    }

    /** True once the element was detached or a newer load superseded this one. */
    _isStale(generation) {
      return this._disposed || generation !== this._generation;
    }

    async loadOperations(hostId, generation = this._generation) {
      try {
        const payload = await this._get(`control-centers/${this._controlCenterId}/hosts/${hostId}/operations`);
        if (this._isStale(generation)) return;
        this._operations = Array.isArray(payload.items) ? payload.items : [];
        // The load succeeded, so whatever failed last time is no longer true.
        // Leaving the banner up would have an operator debugging a fault that
        // has already cleared.
        this._operationError = '';
      } catch (error) {
        if (this._isStale(generation)) return;
        // A missing operations API means Stage 2 is not installed here; that is
        // materially different from "no operations have been requested".
        this._operations = [];
        this._operationError = error?.code === 404
          ? 'not-installed'
          : (error?.message || 'operation history is unavailable');
      }
    }

    async loadMetrics(hostId, generation = this._generation) {
      const range = this._metricsRange;
      const request = ++this._metricsRequest;
      this._metricsLoading = true;
      try {
        const payload = await this._get(
          `control-centers/${this._controlCenterId}/hosts/${hostId}/metrics?range=${
            encodeURIComponent(range)
          }`,
        );
        if (this._isStale(generation) || request !== this._metricsRequest
            || hostId !== this._selected || range !== this._metricsRange) return;
        this._metrics = payload;
        this._metricsError = '';
      } catch (error) {
        if (this._isStale(generation) || request !== this._metricsRequest
            || hostId !== this._selected || range !== this._metricsRange) return;
        this._metrics = null;
        this._metricsError = error?.code === 404
          ? 'The Beszel metrics adapter is not installed on this control center.'
          : (error?.message || 'Beszel metrics are unavailable');
      } finally {
        if (!this._isStale(generation) && request === this._metricsRequest) {
          this._metricsLoading = false;
        }
      }
    }

    async _send(path, body) {
      const response = await ctx.api.fetch(path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      if (!response.ok) {
        const failure = new Error(parsed?.error || `request failed with HTTP ${response.status}`);
        failure.code = response.status;
        throw failure;
      }
      return parsed;
    }

    /**
     * Submits a request, then refreshes so the operator sees the real state.
     *
     * Returns whether the server accepted it. A caller that holds a reviewed
     * selection must not discard it on a refusal: the operator would have to
     * rebuild the same set from scratch to retry something that never ran.
     */
    async submitOperation(operation, parameters, reason, options = {}) {
      if (this._operationBusy) return false;
      this._operationBusy = true;
      this._operationError = '';
      this.render();
      let accepted = false;
      try {
        await this._send(
          `control-centers/${this._controlCenterId}/hosts/${this._selected}/operations`,
          // `emergency` is only ever sent when the operator ticked the box. The
          // server decides whether the policy allows it; the console never
          // assumes it does.
          { operation, parameters, reason, ...(options.emergency ? { emergency: true } : {}) },
        );
        accepted = true;
        await this.loadOperations(this._selected);
      } catch (error) {
        this._operationError = error?.message || 'the request was refused';
      } finally {
        this._operationBusy = false;
        this.render();
      }
      return accepted;
    }

    async decideOperation(operationId, decision, reason) {
      if (this._operationBusy) return;
      this._operationBusy = true;
      this._operationError = '';
      this.render();
      try {
        await this._send(
          `control-centers/${this._controlCenterId}/operations/${operationId}/${decision}`,
          { reason },
        );
        await this.loadOperations(this._selected);
        if (this._operationDetail?.operation?.id === operationId) {
          await this.openOperation(operationId);
        }
      } catch (error) {
        this._operationError = error?.message || 'the decision was refused';
      } finally {
        this._operationBusy = false;
        this.render();
      }
    }

    async openOperation(operationId) {
      try {
        this._operationDetail = await this._get(
          `control-centers/${this._controlCenterId}/operations/${operationId}`,
        );
      } catch (error) {
        this._operationDetail = null;
        this._operationError = error?.message || 'operation detail is unavailable';
      }
      this.render();
    }

    async loadDetail(hostId, generation = this._generation) {
      try {
        const payload = await this._get(`control-centers/${this._controlCenterId}/hosts/${hostId}`);
        if (this._isStale(generation)) return;
        this._detail = payload.host || null;
        // The host has just told us what it now offers. Re-bind the selection
        // to it here, once, rather than during render: a render must be able to
        // run twice without changing what would be submitted.
        this._reconcileSelection(this._eligibleUpdates(this._detail).eligible);
        await Promise.all([
          this.loadOperations(hostId, generation),
          this.loadMetrics(hostId, generation),
        ]);
      } catch (error) {
        if (this._isStale(generation)) return;
        this._detail = null;
        this._metrics = null;
        this._error = error?.code === 404
          ? `host ${hostId} is no longer enrolled`
          : (error?.message || 'host detail is unavailable');
      }
    }

    async select(hostId) {
      // Supersede any in-flight load so a slow earlier response cannot land on
      // top of the host the operator just picked.
      this._generation += 1;
      const generation = this._generation;
      this._selected = hostId;
      this._error = '';
      this._detail = null;
      this._metricsRequest += 1;
      this._metrics = null;
      this._metricsError = '';
      this._metricsLoading = false;
      this.render();
      await this.loadDetail(hostId, generation);
      if (this._isStale(generation)) return;
      this.render();
    }

    render() {
      if (this._disposed) return;
      this.replaceChildren();

      const header = el('div', 'clr-row');
      const headerCol = el('div', 'clr-col-12');
      headerCol.appendChild(el('h2', null, 'Linux 호스트'));
      headerCol.appendChild(el('p', 'os-host-empty',
        `Host state, Beszel time-series metrics and governed operations for control center ${
          this._controlCenterId
        }. `
        + 'Observation is read-only; every change is a reviewed request carried out by the RCC host agent.'
        + (this._generatedAt ? ` Generated ${this._generatedAt}.` : '')));
      header.appendChild(headerCol);
      this.appendChild(header);

      if (this._featureMissing) {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          'The Linux host authority API is not installed on this control center. '
          + 'This is not an empty fleet — the backend did not answer the host route for '
          + `${this._controlCenterId}.`));
        alert.appendChild(item);
        this.appendChild(alert);
        return;
      }

      if (this._error) {
        const alert = el('div', 'alert alert-danger');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text', this._error));
        alert.appendChild(item);
        this.appendChild(alert);
      }

      if (this._loading) {
        const loading = el('div', 'clr-row');
        loading.appendChild(el('span', 'spinner spinner-inline'));
        loading.appendChild(el('span', null, ' Loading host inventory…'));
        this.appendChild(loading);
        return;
      }

      const layout = el('div', 'os-host-layout');
      layout.appendChild(this.renderFleet());
      layout.appendChild(this.renderDetail());
      this.appendChild(layout);
    }

    renderFleet() {
      const card = el('div', 'os-host-card');
      const shown = this._hosts.length;
      // The heading is a count of what is on screen, and it must not be read as
      // a count of the region. When the list stopped at the API's page bound it
      // says "first N" and the notice below says the rest exist, because a bare
      // "Fleet (200)" is indistinguishable from a region that has exactly 200.
      card.appendChild(el('h3', null, this._fleetTruncated ? `Fleet (first ${shown})` : `Fleet (${shown})`));
      if (this._fleetTruncated) {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          `Only the first ${this._fleetLimit || shown} hosts are shown. This control center has more `
          + 'enrolled than one page holds, so this list is cut off, not complete. A host you are '
          + 'looking for may be enrolled and reporting without appearing here.'));
        alert.appendChild(item);
        card.appendChild(alert);
      }
      if (!shown) {
        card.appendChild(el('p', 'os-host-empty', 'No hosts are enrolled in this control center.'));
        return card;
      }
      for (const host of this._hosts) {
        const row = el('div', 'os-host-row');
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.setAttribute('aria-selected', String(host.hostId === this._selected));
        const left = el('div');
        left.appendChild(el('div', null, text(host.displayName || host.hostId)));
        left.appendChild(el('div', 'os-host-empty', text(host.hostname, host.hostId)));
        row.appendChild(left);
        const badge = REPORT_STATE_LABEL[host.reportState] || REPORT_STATE_LABEL.unknown;
        row.appendChild(el('span', `label ${badge.cls}`, badge.text));
        const activate = () => { void this.select(host.hostId); };
        row.addEventListener('click', activate);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
        });
        card.appendChild(row);
      }
      return card;
    }

    renderDetail() {
      const card = el('div', 'os-host-card');
      if (!this._detail) {
        card.appendChild(el('p', 'os-host-empty', 'Select a host to inspect its reported state.'));
        return card;
      }
      const host = this._detail;
      card.appendChild(el('h3', null, text(host.displayName || host.hostId)));

      const badge = REPORT_STATE_LABEL[host.reportState] || REPORT_STATE_LABEL.unknown;
      const status = el('p');
      status.appendChild(el('span', `label ${badge.cls}`, badge.text));
      status.appendChild(el('span', null,
        host.snapshotAgeSeconds === null || host.snapshotAgeSeconds === undefined
          ? ' No snapshot has ever been received from this host.'
          : ` Last snapshot ${duration(host.snapshotAgeSeconds)} ago (${text(host.collectedAt)}).`));
      card.appendChild(status);

      if (Array.isArray(host.degradedKeys) && host.degradedKeys.length) {
        card.appendChild(el('p', 'os-host-empty', `Collector degraded: ${host.degradedKeys.join(', ')}`));
      }

      // Two-level navigation keeps feature growth from becoming one horizontal
      // strip of unrelated buttons. Domains are stable; the smaller tablist
      // beneath a domain contains only the workflows that belong together.
      const activeGroup = groupForSection(this._section);
      const domains = el('nav', 'os-host-domains');
      domains.setAttribute('aria-label', '호스트 기능 영역');
      for (const group of SECTION_GROUPS) {
        const current = group.id === activeGroup.id;
        const button = el('button', null, group.label);
        button.type = 'button';
        if (current) button.setAttribute('aria-current', 'page');
        button.addEventListener('click', () => {
          this._section = group.sections[0].id;
          this.render();
        });
        domains.appendChild(button);
      }
      card.appendChild(domains);

      const nav = el('div', 'os-host-sections');
      nav.setAttribute('role', 'tablist');
      nav.setAttribute('aria-label', `${activeGroup.label} 기능`);
      for (const section of activeGroup.sections) {
        const current = section.id === this._section;
        const button = el('button', `btn btn-sm ${current ? 'btn-primary' : 'btn-outline'}`, section.label);
        button.type = 'button';
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(current));
        button.setAttribute('id', `os-host-tab-${section.id}`);
        // Only the current tab is a tab stop; arrow keys move between them,
        // which is what a tablist is expected to do.
        button.setAttribute('tabindex', current ? '0' : '-1');
        button.addEventListener('click', () => { this._section = section.id; this.render(); });
        button.addEventListener('keydown', (event) => {
          const index = activeGroup.sections.findIndex((entry) => entry.id === this._section);
          let next = null;
          if (event.key === 'ArrowRight') {
            next = activeGroup.sections[(index + 1) % activeGroup.sections.length];
          } else if (event.key === 'ArrowLeft') {
            next = activeGroup.sections[
              (index - 1 + activeGroup.sections.length) % activeGroup.sections.length
            ];
          } else if (event.key === 'Home') next = activeGroup.sections[0];
          else if (event.key === 'End') next = activeGroup.sections[activeGroup.sections.length - 1];
          if (!next) return;
          event.preventDefault?.();
          this._section = next.id;
          this.render();
        });
        nav.appendChild(button);
      }
      card.appendChild(nav);
      const panel = this.renderSection(host);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `os-host-tab-${this._section}`);
      card.appendChild(panel);
      return card;
    }

    /** Capability gate: the backend states which operations this host allows. */
    _capability(name) {
      const capability = this._detail?.capabilities?.operations?.[name];
      if (!capability) return { allowed: false, reason: 'This control center has not enabled host operations.' };
      if (capability.supported === false) {
        return { allowed: false, reason: capability.reason || 'This operation is not available on this host.' };
      }
      if (capability.permitted === false) {
        return { allowed: false, reason: capability.reason || 'You do not hold the permission this operation requires.' };
      }
      return { allowed: true, reason: '' };
    }

    /**
     * Which pending packages this console is willing to put in a request.
     *
     * A package is eligible only when every part of the request can be built
     * from what the host reported: a name both this console and the backend
     * will accept, an allowlist entry on the host's own agent, and a candidate
     * version to bind the request to. Anything else is listed as ineligible
     * with its reason, because a package silently missing from the list is
     * indistinguishable from a package that has no update.
     */
    _eligibleUpdates(host) {
      const packages = host?.packages || null;
      const allowlist = Array.isArray(host?.snapshot?.operations?.packageAllowlist)
        ? host.snapshot.operations.packageAllowlist : [];
      const pending = Array.isArray(packages?.pending) ? packages.pending : [];
      const eligible = [];
      const ineligible = [];
      for (const entry of pending) {
        const name = String(entry?.name ?? '');
        const currentVersion = String(entry?.currentVersion ?? '');
        const candidateVersion = String(entry?.candidateVersion ?? '');
        const security = entry?.security === true;
        const note = (reason) => ineligible.push({ name, reason, security });
        if (!PACKAGE_NAME_RE.test(name)) {
          note('the host reported a name that is not a valid Debian package name');
        } else if (name.startsWith(KERNEL_IMAGE_PREFIX)) {
          // A kernel image is never part of a package update. It has its own
          // operation, its own risk and its own reboot statement.
          note('this is a kernel image, which is requested as a kernel update instead');
        } else if (!allowlist.includes(name)) {
          note('the agent on this host does not allowlist it for updates');
        } else if (!PACKAGE_VERSION_RE.test(candidateVersion)) {
          // Without a version there is nothing to bind the approval to, and the
          // host would install whatever the mirror offers at execution time.
          note('the host reported no usable candidate version to bind this request to');
        } else {
          eligible.push({ name, currentVersion, candidateVersion, security });
        }
      }
      eligible.sort(byName);
      ineligible.sort(byName);
      return { eligible, ineligible, allowlist, truncated: packages?.truncated === true };
    }

    /**
     * A package operation that has not finished yet.
     *
     * All three contend for the same dpkg lock, so one in flight excludes the
     * others. Letting a second be requested would put two approved operations
     * in a race nobody reviewed.
     */
    _inFlightPackageOperation() {
      return this._operations.find((entry) => PACKAGE_OPERATIONS.includes(entry?.operation)
        && !TERMINAL_OPERATION_STATES.has(entry?.status)) || null;
    }

    /**
     * Why update work cannot be requested from data this old.
     *
     * Only package.update and kernel.update consult this. package.refresh
     * deliberately does not, and must not: it is the operation that makes the
     * data current, so gating it on the data being current would leave a stale
     * host with no way back.
     */
    _updateFreshnessProblem(host) {
      if (NON_REPORTING_STATES.has(host?.reportState)) {
        return 'This host has stopped reporting, so the versions above are not known to be what it '
          + 'would install. Refresh the package index once it reports again.';
      }
      const age = Number(host?.packages?.metadataAgeSeconds);
      if (!Number.isFinite(age) || age < 0) {
        // The projection reports -1 when the host did not say. An unprovable
        // age is treated as a stale one: the remedy is the same refresh, and
        // assuming freshness nobody reported is how a month-old candidate
        // version gets approved as if it were today's.
        return 'This host did not report when its package index was last refreshed, so the versions '
          + 'above cannot be shown to be current. Refresh the index first.';
      }
      if (age >= STALE_INDEX_SECONDS) {
        return `The package index on this host was last refreshed ${describeAge(age)} ago, so these `
          + 'versions may no longer be the ones it would install. Refresh the index first.';
      }
      return '';
    }

    renderOperations(host) {
      const container = el('div');

      if (this._operationError === 'not-installed') {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          'Governed host operations are not installed on this control center. This is not an empty '
          + 'history — the backend did not answer the operations route.'));
        alert.appendChild(item);
        container.appendChild(alert);
        return container;
      }

      if (this._operationError) {
        const alert = el('div', 'alert alert-danger');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text', this._operationError));
        alert.appendChild(item);
        container.appendChild(alert);
      }

      container.appendChild(this.renderRequestForms(host));
      container.appendChild(el('h4', null, 'History'));
      container.appendChild(this.renderOperationList());
      if (this._operationDetail) container.appendChild(this.renderOperationDetail());
      return container;
    }

    renderRequestForms(host) {
      const wrapper = el('div');

      // Without a snapshot the console cannot say what is running on the host,
      // which units exist, or whether the agent is alive to receive the work.
      if (!host?.snapshot) {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          'This host has not reported a snapshot, so no new operation can be requested for it. '
          + 'The history below is unaffected.'));
        alert.appendChild(item);
        wrapper.appendChild(alert);
        return wrapper;
      }

      // Journal queries live on the Journal tab and only there. Keeping a
      // second submitter here would split the request from the bounded output
      // and audit trail an operator needs to verify it.
      const journalNote = el('form', 'os-op-form');
      journalNote.appendChild(el('h4', null, 'Journal queries'));
      journalNote.appendChild(el('p', 'os-host-empty',
        'These are requested from the Journal tab, where the bounded result, truncation state '
        + 'and full audit trail remain beside the request.'));
      wrapper.appendChild(journalNote);

      // Service restarts live on the Services tab and only there. That keeps
      // the allowlist, current failed-unit state, approval status and execution
      // evidence in one operator workflow.
      const serviceNote = el('form', 'os-op-form');
      serviceNote.appendChild(el('h4', null, 'Service restarts'));
      serviceNote.appendChild(el('p', 'os-host-empty',
        'These are requested from the Services tab, where the effective allowlist, current '
        + 'systemd state and full request activity are shown together.'));
      wrapper.appendChild(serviceNote);

      // Host reboots live on the Reboot tab and only there. The preflight,
      // refusal reasons, drain evidence and boot-identity proof are one
      // workflow; a second submitter here would separate the irreversible
      // request from the evidence that makes it reviewable.
      const rebootNote = el('form', 'os-op-form');
      rebootNote.appendChild(el('h4', null, 'Host reboots'));
      rebootNote.appendChild(el('p', 'os-host-empty',
        'These are requested from the Reboot tab, where the current boot identity, Kubernetes '
        + 'preflight, cordon and drain evidence, return deadline and full audit trail stay together.'));
      wrapper.appendChild(rebootNote);

      // Package and kernel work lives on the Updates tab and only there. Two
      // submitters for the same operation drift apart, and the one an operator
      // happens to find decides whether their request was pinned to a version.
      const packageNote = el('form', 'os-op-form');
      packageNote.appendChild(el('h4', null, 'Package and kernel updates'));
      packageNote.appendChild(el('p', 'os-host-empty',
        'These are requested from the Updates tab, where the exact pending packages, their '
        + 'current and candidate versions, and the state of every request are shown together.'));
      wrapper.appendChild(packageNote);

      for (const [title, message] of [
        ['Network changes',
          'These are requested from the Network tab, where the reviewed pre-state, automatic '
            + 'rollback countdown, link inventory and full request activity remain together.'],
        ['Storage changes',
          'Mount and filesystem growth requests live on the Storage tab beside the exact device, '
            + 'growth headroom, irreversible-growth warning and full audit trail.'],
        ['Operating system images',
          'Image staging and rollback requests live on the OS image tab beside the current and '
            + 'previous deployments. Neither operation reboots the host.'],
      ]) {
        const note = el('form', 'os-op-form');
        note.appendChild(el('h4', null, title));
        note.appendChild(el('p', 'os-host-empty', message));
        wrapper.appendChild(note);
      }

      return wrapper;
    }

    renderNetworkForm(host) {
      const gate = this._capability('network.configure');
      const form = el('form', 'os-op-form');
      form.appendChild(el('h4', null, 'Reconfigure a network interface'));

      const state = host.networkState || {};
      const granted = Array.isArray(host?.snapshot?.operations?.networkAllowlist)
        ? host.snapshot.operations.networkAllowlist : [];
      // Both sides must permit the profile: the host's own allowlist, and the
      // rule that the interface carrying the control path is never touched.
      const candidates = (state.links || []).filter((link) => link.managed && !link.carriesRcc
        && link.connection && granted.includes(link.connection));

      if (!gate.allowed || candidates.length === 0) {
        form.appendChild(el('p', 'os-host-empty', gate.allowed
          ? 'No interface on this host is both allowlisted by its agent and safe to reconfigure. '
            + 'The interface carrying the default route to this control center is never offered.'
          : `Network changes are unavailable on this host: ${gate.reason}`));
        return form;
      }

      form.appendChild(el('p', 'os-host-empty',
        'Changes one NetworkManager profile. The agent proves this control center is still reachable '
        + 'afterwards and puts the previous settings back if it is not — including after a crash, '
        + 'because the undo record is written before the change. ' + this._windowNote(host)));
      form.appendChild(this._secondPersonNotice());

      const target = select(candidates.map((link) => ({
        value: link.name, label: `${link.name} — ${link.connection}`,
      })), candidates[0].name);
      const method = select([
        { value: 'auto', label: 'auto (DHCP)' },
        { value: 'manual', label: 'manual (static)' },
      ], 'manual');
      const addresses = input('text', '', { placeholder: '10.20.0.5/24', maxlength: '64' });
      const gateway = input('text', '', { placeholder: '10.20.0.1', maxlength: '32' });
      const dns = input('text', '', { placeholder: '10.20.0.1', maxlength: '32' });
      const mtu = input('number', '0', { min: '0', max: '9216', step: '1' });
      const rollback = input('number', '120', { min: '30', max: '600', step: '10' });
      const reason = input('text', '', { placeholder: 'why this change is needed', maxlength: '500' });

      form.appendChild(field('Interface', target, 'Only allowlisted, managed links that do not carry the control path.'));
      form.appendChild(field('Method', method, 'A manual configuration needs at least one address.'));
      form.appendChild(field('Address (CIDR)', addresses, 'One IPv4 address with a prefix length, for example 10.20.0.5/24.'));
      form.appendChild(field('Gateway', gateway, 'Optional. Leave empty to keep the interface off-route.'));
      form.appendChild(field('DNS server', dns, 'Optional. One IPv4 address.'));
      form.appendChild(field('MTU', mtu, '0 leaves the MTU unchanged. Otherwise 1280 to 9216.'));
      form.appendChild(field('Automatic rollback after', rollback,
        'Seconds. If this control center is not reachable within that time, the change is undone. There is no "never" value.'));
      form.appendChild(field('Reason', reason, 'At least 8 characters.'));
      const emergency = this._emergencyControl(host, form, '_networkEmergency');

      // What the operator is changing *from*. This is the state the request will
      // be bound to, and the agent refuses if the host has moved on since.
      const chosen = () => candidates.find((link) => link.name === target.value) || candidates[0];
      const preflight = el('div');
      const renderPreflight = () => {
        preflight.replaceChildren();
        const link = chosen();
        preflight.appendChild(el('h4', null, 'Current state this request will be bound to'));
        preflight.appendChild(definitionList([
          ['Profile', text(link.connection)],
          ['Method', text(link.method)],
          ['Static addresses', (link.staticAddresses || []).join(', ') || 'none'],
          ['Gateway', text(link.gateway, 'none')],
          ['MTU', text(link.mtu)],
        ]));
        preflight.appendChild(el('p', 'os-host-empty',
          'If the host has changed since this was reviewed, the agent refuses the operation rather '
          + 'than applying a reviewed change on top of an unknown starting point.'));
      };
      renderPreflight();
      target.addEventListener('change', renderPreflight);
      form.appendChild(preflight);

      const actions = el('div', 'os-op-actions');
      actions.appendChild(gatedButton('Request network change', 'btn btn-sm btn-danger-outline',
        gate.allowed && !this._operationBusy,
        gate.reason || 'A request is already in flight.',
        () => {
          const link = chosen();
          const requestedMethod = String(method.value || '');
          const requestedAddress = String(addresses.value || '').trim();
          const requestedGateway = String(gateway.value || '').trim();
          const requestedDNS = String(dns.value || '').trim();
          const requestedMTU = Number(mtu.value);
          const rollbackSeconds = Number(rollback.value);
          if (!['auto', 'manual'].includes(requestedMethod)) {
            this._refuseSubmit('Select automatic or manual IPv4 configuration.');
            return;
          }
          if (requestedMethod === 'manual' && !IPV4_CIDR_RE.test(requestedAddress)) {
            this._refuseSubmit('A manual configuration needs one valid IPv4 address with a prefix length.');
            return;
          }
          if (requestedMethod === 'manual' && requestedGateway && !IPV4_RE.test(requestedGateway)) {
            this._refuseSubmit('The gateway must be one valid IPv4 address.');
            return;
          }
          if (requestedDNS && !IPV4_RE.test(requestedDNS)) {
            this._refuseSubmit('The DNS server must be one valid IPv4 address.');
            return;
          }
          if (!Number.isInteger(requestedMTU)
              || (requestedMTU !== 0 && (requestedMTU < 1280 || requestedMTU > 9216))) {
            this._refuseSubmit('MTU must be 0 (unchanged) or an integer from 1,280 to 9,216.');
            return;
          }
          if (!Number.isInteger(rollbackSeconds)
              || rollbackSeconds < 30 || rollbackSeconds > 600) {
            this._refuseSubmit('Automatic rollback must be an integer from 30 to 600 seconds.');
            return;
          }
          const requestedReason = String(reason.value || '').trim();
          const problem = reasonProblem(requestedReason);
          if (problem) {
            this._refuseSubmit(problem);
            return;
          }
          const parameters = {
            connection: link.connection,
            interface: link.name,
            method: requestedMethod,
            addresses: requestedMethod === 'manual' ? [requestedAddress] : [],
            gateway: requestedMethod === 'manual' ? requestedGateway : '',
            dns: requestedDNS ? [requestedDNS] : [],
            searchDomains: [],
            mtu: requestedMTU,
            rollbackSeconds,
          };
          void this.submitOperation('network.configure', parameters, requestedReason,
            { emergency: emergency.checked });
        }));
      form.appendChild(actions);
      form.addEventListener('submit', (event) => event.preventDefault());
      return form;
    }

    renderStorageForms(host) {
      const wrapper = el('div');
      const storage = host.storage || {};
      const policy = host.policy || {};

      // filesystem.grow
      const growGate = this._capability('filesystem.grow');
      const growAllowlist = Array.isArray(host?.snapshot?.operations?.growAllowlist)
        ? host.snapshot.operations.growAllowlist : [];
      const normalizeMountPoint = (value) => String(value || '').replace(/\/+$/, '');
      const growable = (storage.capacity || []).filter((entry) => entry.growable === true
        && growAllowlist.some((allowed) =>
          normalizeMountPoint(allowed) === normalizeMountPoint(entry.mountPoint)));
      const grow = el('form', 'os-op-form');
      grow.appendChild(el('h4', null, 'Grow a filesystem'));
      if (!growGate.allowed || growable.length === 0) {
        grow.appendChild(el('p', 'os-host-empty', growGate.allowed
          ? 'No filesystem is both reported growable and present in the agent’s local growth '
            + 'allowlist. A candidate must be ext4 or xfs, be outside protected paths, and sit on '
            + 'a block device that is already larger than it.'
          : `Growing a filesystem is unavailable on this host: ${growGate.reason}`));
      } else {
        grow.appendChild(el('p', 'os-host-empty',
          'Expands a filesystem into the block device it already sits on. There is no size to enter: '
          + 'it grows to the device and no further, so it cannot shrink and cannot move data. '
          + this._windowNote(host)));
        grow.appendChild(this._secondPersonNotice());
        const target = select(growable.map((entry) => ({
          value: entry.mountPoint,
          label: `${entry.mountPoint} — ${bytes(entry.headroomBytes)} of headroom`,
        })), growable[0].mountPoint);
        const reason = input('text', '', { placeholder: 'why this filesystem needs to grow', maxlength: '500' });
        grow.appendChild(field('Filesystem', target, 'Only filesystems this host reports as growable.'));
        grow.appendChild(field('Reason', reason, 'At least 8 characters.'));
        const emergency = this._emergencyControl(host, grow, '_filesystemGrowEmergency');
        const actions = el('div', 'os-op-actions');
        actions.appendChild(gatedButton('Request filesystem growth', 'btn btn-sm',
          growGate.allowed && !this._operationBusy,
          growGate.reason || 'A request is already in flight.',
          () => {
            const requestedReason = String(reason.value || '').trim();
            const problem = reasonProblem(requestedReason);
            if (problem) {
              this._refuseSubmit(problem);
              return;
            }
            void this.submitOperation('filesystem.grow', { mountPoint: target.value },
              requestedReason, { emergency: emergency.checked });
          }));
        grow.appendChild(actions);
      }
      grow.addEventListener('submit', (event) => event.preventDefault());
      wrapper.appendChild(grow);

      // mount.configure
      const mountGate = this._capability('mount.configure');
      const policyRoots = Array.isArray(policy.allowedMountRoots) ? policy.allowedMountRoots : [];
      const agentRoots = Array.isArray(host?.snapshot?.operations?.mountRoots)
        ? host.snapshot.operations.mountRoots : [];
      const roots = policyRoots.filter((root) => agentRoots.some((allowed) =>
        normalizeMountPoint(allowed) === normalizeMountPoint(root)));
      // Only an unmounted, unprotected filesystem with a UUID is a candidate:
      // this operation does not move a mounted filesystem and does not format.
      const mountable = (storage.devices || []).filter((device) => device.uuid
        && !device.protected && !device.mountPoint
        && (device.fsType === 'ext4' || device.fsType === 'xfs'));
      const mount = el('form', 'os-op-form');
      mount.appendChild(el('h4', null, 'Mount a filesystem persistently'));
      if (!mountGate.allowed || mountable.length === 0 || roots.length === 0) {
        mount.appendChild(el('p', 'os-host-empty', mountGate.allowed
          ? (roots.length === 0
            ? 'The maintenance policy and the agent have no mount root in common, so no mount '
              + 'point may be created.'
            : 'No filesystem on this host is available to mount. A candidate must be ext4 or xfs, carry a '
              + 'filesystem UUID, be unmounted, and not be a protected device.')
          : `Mounting a filesystem is unavailable on this host: ${mountGate.reason}`));
      } else {
        mount.appendChild(el('p', 'os-host-empty',
          'Generates a systemd mount unit for an existing filesystem, named by its own UUID. It never '
          + 'formats, never writes a partition table and never edits /etc/fstab, and the unit is always '
          + 'nofail so a missing device cannot keep the host from booting. '
          + this._windowNote(host)));
        mount.appendChild(this._secondPersonNotice());
        const target = select(mountable.map((device) => ({
          value: device.uuid,
          label: `${device.name} — ${device.fsType}, ${bytes(device.sizeBytes)}`,
        })), mountable[0].uuid);
        const root = select(roots.map((entry) => ({ value: entry, label: entry })), roots[0]);
        const leaf = input('text', '', { placeholder: 'data', maxlength: '63' });
        const readOnly = input('checkbox', '', {});
        const reason = input('text', '', { placeholder: 'why this mount is needed', maxlength: '500' });
        mount.appendChild(field('Filesystem', target, 'Identified by its filesystem UUID, which does not move between boots.'));
        mount.appendChild(field('Mount root', root, 'Only roots the maintenance policy declares.'));
        mount.appendChild(field('Directory', leaf, 'One path segment beneath the root. The root itself is never a target.'));
        mount.appendChild(field('Read-only', readOnly,
          'This console requests the restrictive noexec, nosuid and nodev defaults.'));
        mount.appendChild(field('Reason', reason, 'At least 8 characters.'));
        const emergency = this._emergencyControl(host, mount, '_mountEmergency');
        const actions = el('div', 'os-op-actions');
        actions.appendChild(gatedButton('Request mount', 'btn btn-sm',
          mountGate.allowed && !this._operationBusy,
          mountGate.reason || 'A request is already in flight.',
          () => {
            const segment = leaf.value.trim();
            if (!segment) {
              this._operationError = 'Enter a directory name beneath the mount root.';
              this.render();
              return;
            }
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(segment)) {
              this._refuseSubmit('The directory must be one safe path segment of at most 63 characters.');
              return;
            }
            const requestedReason = String(reason.value || '').trim();
            const problem = reasonProblem(requestedReason);
            if (problem) {
              this._refuseSubmit(problem);
              return;
            }
            const device = mountable.find((entry) => entry.uuid === target.value) || mountable[0];
            void this.submitOperation('mount.configure', {
              filesystemUuid: device.uuid,
              mountPoint: `${String(root.value).replace(/\/+$/, '')}/${segment}`,
              fsType: device.fsType,
              readOnly: readOnly.checked,
            }, requestedReason, { emergency: emergency.checked });
          }));
        mount.appendChild(actions);
      }
      mount.addEventListener('submit', (event) => event.preventDefault());
      wrapper.appendChild(mount);
      return wrapper;
    }

    renderImageForms(host) {
      const wrapper = el('div');
      const boot = host.boot || {};
      const policy = host.policy || {};
      const stageGate = this._capability('osimage.stage');
      const rollbackGate = this._capability('osimage.rollback');

      if (!stageGate.allowed && !rollbackGate.allowed) {
        const form = el('form', 'os-op-form');
        form.appendChild(el('h4', null, 'Operating system image'));
        form.appendChild(el('p', 'os-host-empty',
          `Image operations are unavailable on this host: ${stageGate.reason || rollbackGate.reason}`));
        wrapper.appendChild(form);
        return wrapper;
      }

      // osimage.stage
      const policyImages = Array.isArray(policy.allowedImages) ? policy.allowedImages : [];
      const agentImages = Array.isArray(host?.snapshot?.operations?.imageAllowlist)
        ? host.snapshot.operations.imageAllowlist : [];
      const images = policyImages.filter((image) => agentImages.includes(image));
      const stage = el('form', 'os-op-form');
      stage.appendChild(el('h4', null, 'Stage an operating system image'));
      if (!stageGate.allowed || images.length === 0) {
        stage.appendChild(el('p', 'os-host-empty', stageGate.allowed
          ? 'The maintenance policy and the agent allowlist no image in common, so nothing may '
            + 'be staged. An image is named by digest, never by tag: a tag can be moved by whoever '
            + 'controls the registry.'
          : `Staging an image is unavailable on this host: ${stageGate.reason}`));
      } else {
        stage.appendChild(el('p', 'os-host-empty',
          'Writes a new deployment and stops. It never reboots: the running system is unchanged until '
          + 'host.reboot is separately requested and approved, and that carries the Kubernetes checks. '
          + this._windowNote(host)));
        stage.appendChild(this._secondPersonNotice());
        const target = select(images.map((image) => ({ value: image, label: image })), images[0]);
        const reason = input('text', '', { placeholder: 'why this image is being staged', maxlength: '500' });
        stage.appendChild(field('Image', target, 'Digest-pinned references the maintenance policy allowlists.'));
        stage.appendChild(field('Currently booted', el('p', null,
          `${text(boot.booted?.version, 'unknown')} (${text(boot.booted?.digest, 'no digest reported')})`),
        'The deployment this request will be bound to.'));
        stage.appendChild(field('Reason', reason, 'At least 8 characters.'));
        const emergency = this._emergencyControl(host, stage, '_imageStageEmergency');
        const actions = el('div', 'os-op-actions');
        actions.appendChild(gatedButton('Request image staging', 'btn btn-sm btn-danger-outline',
          stageGate.allowed && !this._operationBusy,
          stageGate.reason || 'A request is already in flight.',
          () => {
            const requestedReason = String(reason.value || '').trim();
            const problem = reasonProblem(requestedReason);
            if (problem) {
              this._refuseSubmit(problem);
              return;
            }
            void this.submitOperation('osimage.stage',
              { adapter: boot.adapter, image: target.value },
              requestedReason, { emergency: emergency.checked });
          }));
        stage.appendChild(actions);
      }
      stage.addEventListener('submit', (event) => event.preventDefault());
      wrapper.appendChild(stage);

      // osimage.rollback
      const rollback = el('form', 'os-op-form');
      rollback.appendChild(el('h4', null, 'Roll back to the previous deployment'));
      if (!rollbackGate.allowed) {
        rollback.appendChild(el('p', 'os-host-empty',
          `Rolling back is unavailable on this host: ${rollbackGate.reason}`));
      } else {
        rollback.appendChild(el('p', 'os-host-empty',
          'Selects the previous deployment for the next boot. It names no image and it never reboots: '
          + 'the running system is unchanged until host.reboot is separately requested and approved. '
          + this._windowNote(host)));
        rollback.appendChild(this._secondPersonNotice());
        const reason = input('text', '', { placeholder: 'why this rollback is needed', maxlength: '500' });
        rollback.appendChild(field('Reason', reason, 'At least 8 characters.'));
        const emergency = this._emergencyControl(host, rollback, '_imageRollbackEmergency');
        const actions = el('div', 'os-op-actions');
        actions.appendChild(gatedButton('Request rollback', 'btn btn-sm btn-danger-outline',
          rollbackGate.allowed && !this._operationBusy,
          rollbackGate.reason || 'A request is already in flight.',
          () => {
            const requestedReason = String(reason.value || '').trim();
            const problem = reasonProblem(requestedReason);
            if (problem) {
              this._refuseSubmit(problem);
              return;
            }
            void this.submitOperation('osimage.rollback', { adapter: boot.adapter },
              requestedReason, { emergency: emergency.checked });
          }));
        rollback.appendChild(actions);
      }
      rollback.addEventListener('submit', (event) => event.preventDefault());
      wrapper.appendChild(rollback);
      return wrapper;
    }

    renderOperationList(operations = this._operations,
      emptyMessage = 'No operations have been requested for this host.') {
      if (!operations.length) {
        return el('p', 'os-host-empty', emptyMessage);
      }
      const wrapper = el('div', 'table-wrapper');
      const t = el('table', 'table table-compact');
      const thead = el('thead');
      const headRow = el('tr');
      for (const header of ['Operation', 'State', 'Risk', 'Requested', 'Reason', '']) {
        headRow.appendChild(el('th', null, header));
      }
      thead.appendChild(headRow);
      t.appendChild(thead);
      const tbody = el('tbody');
      for (const operation of operations) {
        const tr = el('tr');
        tr.appendChild(el('td', null, operation.operation));
        const stateCell = el('td');
        stateCell.appendChild(badge(OPERATION_STATE_LABEL, operation.status));
        tr.appendChild(stateCell);
        tr.appendChild(el('td', null, operation.riskLevel || '—'));
        tr.appendChild(el('td', null, operation.createdAt || '—'));
        tr.appendChild(el('td', null, operation.reason || '—'));
        const actions = el('td');
        const open = el('button', 'btn btn-sm btn-link', 'Details');
        open.type = 'button';
        open.addEventListener('click', () => void this.openOperation(operation.id));
        actions.appendChild(open);
        tr.appendChild(actions);
        tbody.appendChild(tr);
      }
      t.appendChild(tbody);
      wrapper.appendChild(t);
      return wrapper;
    }

    /**
     * The automatic rollback, as the host reported it.
     *
     * While the operation is in flight this is a countdown: how long the agent
     * will keep trying to reach this control center before it puts the previous
     * settings back. Afterwards it is the host's own account of what happened,
     * which is the only account worth showing — the platform's expectation of a
     * change it may have been cut off from is not evidence.
     */
    renderRollback(operation) {
      const wrapper = el('div');
      wrapper.appendChild(el('h4', null, 'Automatic rollback'));
      const state = operation.rollbackState || 'none';
      const row = el('p');
      row.appendChild(badge(ROLLBACK_STATE_LABEL, state));
      wrapper.appendChild(row);

      const deadline = Date.parse(operation.rollbackDeadlineAt || '');
      const inFlight = ['leased', 'running'].includes(operation.status);
      if (inFlight && Number.isFinite(deadline)) {
        const remaining = Math.round((deadline - Date.now()) / 1000);
        wrapper.appendChild(el('p', remaining > 0 ? 'alert-text' : 'os-host-empty', remaining > 0
          ? `The agent has ${remaining} second${remaining === 1 ? '' : 's'} left to prove this control `
            + 'center is still reachable. If it cannot, it restores the previous settings by itself.'
          : 'The rollback deadline has passed. The agent restores the previous settings and reports '
            + 'the outcome; this page updates when it does.'));
      }

      const explanation = {
        armed: 'The undo record is durable and the change is in flight.',
        confirmed: 'The change was applied and this control center was reachable afterwards, so it was kept.',
        'rolled-back': 'This control center was not reachable after the change, so the previous settings were restored.',
        'rollback-failed': 'The change was undone but restoring the previous settings did not fully succeed. '
          + 'This host needs an operator to look at it directly.',
        'not-recorded': 'The agent did not report a rollback outcome. Treat this host as being in an '
          + 'unknown network state until it reports again.',
        none: 'This operation does not carry an automatic rollback.',
      };
      wrapper.appendChild(el('p', state === 'rollback-failed' || state === 'not-recorded'
        ? 'alert-text' : 'os-host-empty', explanation[state] || explanation.none));
      if (operation.rollbackDeadlineAt) {
        wrapper.appendChild(el('p', 'os-host-empty', `Deadline: ${operation.rollbackDeadlineAt}`));
      }
      return wrapper;
    }

    renderOperationDetail() {
      const detail = this._operationDetail;
      const operation = detail.operation || {};
      const wrapper = el('div', 'os-op-form');
      wrapper.appendChild(el('h4', null, `Operation ${operation.operation || ''}`));

      const pairs = [
        ['State', labelFor(OPERATION_STATE_LABEL, operation.status).text],
        ['Risk', operation.riskLevel || '—'],
        ['Requires a second person', operation.requiresSecondPerson ? 'yes' : 'no'],
        ['Reason', operation.reason || '—'],
        ['Parameters', JSON.stringify(operation.parameters || {})],
        ['Approval binds current content', operation.approvalBindsCurrentContent ? 'yes' : 'no'],
        ['Attempt', String(operation.attempt ?? 0)],
        ['Created', operation.createdAt || '—'],
        ['Completed', operation.completedAt || '—'],
      ];
      if (operation.adapter) pairs.push(['Adapter', operation.adapter]);
      if (operation.policy) {
        pairs.push(['Governing policy version', String(operation.policy.version ?? '—')
          + (operation.policy.emergency ? ' (emergency, outside a window)' : '')]);
      }
      if (operation.decidedReason) pairs.push(['Decision reason', operation.decidedReason]);
      wrapper.appendChild(definitionList(pairs));

      if (operation.requiresRollback) {
        wrapper.appendChild(this.renderRollback(operation));
      }

      // The pre-state the request was bound to. This is what makes "the host
      // changed since you reviewed this" visible to the person reviewing it.
      const preState = operation.parameters?.preState;
      if (preState && typeof preState === 'object') {
        wrapper.appendChild(el('h4', null, 'State when this was requested'));
        wrapper.appendChild(definitionList(Object.entries(preState).map(([key, value]) => [
          key,
          Array.isArray(value) ? (value.join(', ') || 'none') : String(value === '' ? '—' : value),
        ])));
        wrapper.appendChild(el('p', 'os-host-empty',
          'The agent re-checks this against the live host before it acts. If it has changed, the '
          + 'operation is refused rather than applied on top of a state nobody reviewed.'));
      }

      // Maintenance evidence, when the operation needed a cordon and drain.
      const maintenance = operation.maintenance || {};
      const hasMaintenanceEvidence = Boolean(
        maintenance.node
        || maintenance.error
        || maintenance.degraded
        || Array.isArray(maintenance.blocking)
        || Array.isArray(maintenance.warnings)
        || Object.hasOwn(maintenance, 'prepared'),
      );
      if (hasMaintenanceEvidence) {
        wrapper.appendChild(el('h4', null, 'Kubernetes maintenance'));
        const evidence = [
          ['Node', maintenance.node || 'not resolved'],
          ['Prepared', maintenance.prepared ? 'yes' : 'no'],
          ['Cordoned', maintenance.cordon?.cordoned ? 'yes' : 'no'],
          ['Drained', maintenance.drain?.drained ? 'yes' : 'no'],
          ['Pods evicted', String(maintenance.drain?.evicted?.length ?? 0)],
        ];
        if (maintenance.error) evidence.push(['Preparation error', text(maintenance.error)]);
        if (maintenance.degraded?.code) {
          evidence.push(['Degraded state', `${text(maintenance.degraded.code)}: ${
            text(maintenance.degraded.detail)
          }`]);
        }
        wrapper.appendChild(definitionList(evidence));
        for (const [title, items] of [['Blocking findings', maintenance.blocking], ['Warnings', maintenance.warnings]]) {
          if (!Array.isArray(items) || !items.length) continue;
          wrapper.appendChild(el('h4', null, title));
          const list = el('ul', 'os-op-timeline');
          for (const finding of items) {
            list.appendChild(el('li', null, `${finding.code}: ${finding.detail}`));
          }
          wrapper.appendChild(list);
        }
      }

      // Result.
      if (operation.result) {
        wrapper.appendChild(el('h4', null, 'Result'));
        wrapper.appendChild(definitionList([
          ['Outcome', operation.result.outcome || '—'],
          ['Exit code', String(operation.result.exitCode ?? '—')],
          ['Message', operation.result.message || '—'],
        ]));
        if (operation.result.output) {
          wrapper.appendChild(outputBlock(operation.result.output, operation.result.truncated));
        }
        // Raw machine and boot identifiers are sensitive host-local values. Reboot receipts
        // expose only the short hashes created by the agent, plus the deadline
        // and its bounded conclusion; unknown evidence keys stay out of the
        // operator surface instead of being dumped as arbitrary JSON.
        if (operation.operation === 'host.reboot') {
          const rebootEvidence = operation.result.evidence || {};
          const acceptedEvidence = [
            ['Boot identity before', rebootEvidence.bootIdBeforeHash],
            ['Boot identity after', rebootEvidence.bootIdAfterHash],
            ['Return deadline', rebootEvidence.deadline],
            ['Conclusion', rebootEvidence.conclusion],
          ].filter(([, value]) => value);
          if (acceptedEvidence.length) {
            wrapper.appendChild(el('h4', null, 'Reboot proof'));
            wrapper.appendChild(definitionList(acceptedEvidence));
          }
        }
      }

      // Timeline.
      const events = Array.isArray(detail.events) ? detail.events : [];
      if (events.length) {
        wrapper.appendChild(el('h4', null, 'Timeline'));
        const list = el('ul', 'os-op-timeline');
        for (const event of events) {
          list.appendChild(el('li', null,
            `${event.occurred_at} · ${event.phase} · ${event.actor_type} · ${event.result}`));
        }
        wrapper.appendChild(list);
      }

      // Decisions. Each is a separate authority: approving is not rejecting,
      // and neither is withdrawing your own request.
      const approveGate = this._capability('approve');
      const rejectGate = this._capability('reject');
      const cancelGate = this._capability('cancel');
      const pending = ['requested', 'awaiting_approval'].includes(operation.status);
      const cancellable = ['requested', 'awaiting_approval', 'approved', 'preparing', 'dispatchable', 'leased']
        .includes(operation.status);
      // Two-person review: the person who asked for the work cannot also be the
      // person who authorises it. The server and the database trigger both
      // enforce it; the console explains it, and must never be the reason it
      // looks available.
      //
      // `viewer` is the server's statement about who is reading this. When it
      // is absent — an unauthenticated read, an older backend, a projection
      // that dropped it — the console cannot tell whether this reader is the
      // requester, so it withholds Approve rather than offering a button whose
      // answer would be a 403. Fail-closed here costs a refresh; fail-open
      // costs the second person.
      const viewerKnown = operation.viewer !== null && typeof operation.viewer === 'object';
      const selfApproval = operation.requiresSecondPerson === true
        && (!viewerKnown || operation.viewer.isRequester === true);
      const approveReason = !pending
        ? 'This operation is no longer awaiting a decision.'
        : (selfApproval
          ? (viewerKnown
            ? 'You requested this operation. A different administrator has to approve it.'
            : 'This operation requires a different administrator to approve it, and this control '
              + 'center did not say who you are, so approving from here is withheld.')
          : approveGate.reason);
      const rejectReason = !pending
        ? 'This operation is no longer awaiting a decision.'
        : rejectGate.reason;

      const decisionReason = input('text', '', { placeholder: 'reason for this decision', maxlength: '500' });
      wrapper.appendChild(field('Decision reason', decisionReason, 'At least 8 characters.'));
      const actions = el('div', 'os-op-actions');
      actions.appendChild(gatedButton('Approve', 'btn btn-sm btn-success-outline',
        pending && approveGate.allowed && !selfApproval && !this._operationBusy,
        approveReason,
        () => void this.decideOperation(operation.id, 'approve', decisionReason.value)));
      actions.appendChild(gatedButton('Reject', 'btn btn-sm btn-danger-outline',
        pending && rejectGate.allowed && !this._operationBusy,
        rejectReason,
        () => void this.decideOperation(operation.id, 'reject', decisionReason.value)));
      actions.appendChild(gatedButton('Cancel', 'btn btn-sm',
        cancellable && cancelGate.allowed && !this._operationBusy,
        cancellable ? cancelGate.reason : 'This operation has already started or finished.',
        () => void this.decideOperation(operation.id, 'cancel', decisionReason.value)));
      const close = el('button', 'btn btn-sm btn-link', 'Close');
      close.type = 'button';
      close.addEventListener('click', () => { this._operationDetail = null; this.render(); });
      actions.appendChild(close);
      wrapper.appendChild(actions);
      return wrapper;
    }

    /**
     * A governed host reboot with the evidence needed to tell one apart from a
     * request that never reached the machine.
     *
     * The console only creates the typed request. After a different
     * administrator approves it, the backend performs the Kubernetes
     * preflight, refuses a single-node cluster, cordons and drains through the
     * eviction API, and only then releases a plan. The agent persists its raw
     * boot id locally before invoking systemd and reports only bounded hashes
     * after it comes back.
     */
    renderReboot(host) {
      const container = el('div');
      const snapshot = host?.snapshot;

      if (snapshot) {
        container.appendChild(el('h4', null, 'Current boot'));
        container.appendChild(definitionList([
          ['Hostname', text(snapshot.identity?.hostname)],
          ['Boot identity', text(snapshot.identity?.bootIdHash)],
          ['Uptime', duration(snapshot.identity?.uptimeSeconds)],
          ['Host report', text(host.reportState)],
          ['Snapshot collected', text(host.collectedAt)],
        ]));
      } else {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          'This host has not reported a snapshot, so no new reboot can be requested. Existing '
          + 'reboot requests, refusals and audit evidence remain below.'));
        alert.appendChild(item);
        container.appendChild(alert);
      }

      const process = el('div', 'os-op-form');
      process.appendChild(el('h4', null, 'Safety sequence'));
      process.appendChild(el('p', 'os-host-empty',
        'A request needs AAL2 and approval by a different administrator. At execution time RCC '
        + 'rechecks the maintenance policy and Kubernetes node, refuses a single-node cluster, '
        + 'cordons the node and drains workloads through the eviction API. The agent records the '
        + 'pre-reboot boot identity durably, invokes only systemctl reboot, and succeeds only when '
        + 'the boot identity changes before the deadline. The node is then uncordoned.'));
      container.appendChild(process);

      if (this._operationError === 'not-installed') {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          'Governed host operations are not installed on this control center. Reboot history '
          + 'cannot be read and no reboot can be requested.'));
        alert.appendChild(item);
        container.appendChild(alert);
        return container;
      }
      if (this._operationError) {
        const alert = el('div', 'alert alert-danger');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text', this._operationError));
        alert.appendChild(item);
        container.appendChild(alert);
      }

      if (snapshot) {
        const reboot = el('form', 'os-op-form');
        reboot.addEventListener('submit', (event) => event.preventDefault());
        reboot.appendChild(el('h4', null, 'Request a safe reboot'));
        reboot.appendChild(el('p', 'os-host-empty',
          'Submitting this form does not reboot the host. It creates the review record that the '
          + 'backend may still refuse during its execution-time Kubernetes preflight.'));
        reboot.appendChild(this._secondPersonNotice());

        const deadline = input('number', this._rebootForm.deadlineSeconds, {
          min: '60',
          max: '1800',
          step: '1',
        });
        const rebootReason = input('text', this._rebootForm.reason, {
          placeholder: 'why this reboot is needed',
          maxlength: String(MAX_REASON),
        });
        reboot.appendChild(field('Return deadline (seconds)', deadline,
          'An integer from 60 to 1,800. If the agent returns with the same boot identity after '
          + 'this deadline, the operation fails instead of remaining in progress.'));
        reboot.appendChild(field('Reason', rebootReason,
          `At least ${MIN_REASON} characters. Recorded in the audit trail and read by the approver.`));

        const rebootGate = this._capability('host.reboot');
        if (!rebootGate.allowed) {
          const notice = el('div', 'alert alert-warning');
          const item = el('div', 'alert-item static');
          item.appendChild(el('span', 'alert-text',
            `Reboot requests are disabled here: ${rebootGate.reason}`));
          notice.appendChild(item);
          reboot.appendChild(notice);
        }
        const actions = el('div', 'os-op-actions');
        actions.appendChild(gatedButton('Request safe reboot', 'btn btn-sm btn-danger-outline',
          rebootGate.allowed && !this._operationBusy,
          rebootGate.reason || 'A request is already in flight.',
          () => {
            const deadlineSeconds = Number(deadline.value);
            const reason = String(rebootReason.value || '').trim();
            this._rebootForm = { deadlineSeconds, reason };
            if (!Number.isInteger(deadlineSeconds)
                || deadlineSeconds < 60 || deadlineSeconds > 1800) {
              this._refuseSubmit('The return deadline must be an integer from 60 to 1,800 seconds.');
              return;
            }
            const problem = reasonProblem(reason);
            if (problem) {
              this._refuseSubmit(problem);
              return;
            }
            void this.submitOperation('host.reboot', { deadlineSeconds }, reason).then((accepted) => {
              if (!accepted) return;
              this._rebootForm.reason = '';
              this.render();
            });
          }));
        reboot.appendChild(actions);
        container.appendChild(reboot);
      }

      container.appendChild(el('h4', null, 'Reboot activity'));
      const history = this._operations.filter((entry) =>
        REBOOT_OPERATIONS.includes(entry?.operation));
      container.appendChild(this.renderOperationList(
        history,
        'No reboot request or preflight refusal has been recorded for this host.',
      ));
      if (this._operationDetail
          && REBOOT_OPERATIONS.includes(this._operationDetail.operation?.operation)) {
        container.appendChild(this.renderOperationDetail());
      }
      return container;
    }

    /**
     * Current systemd state, an allowlisted restart request and its evidence.
     *
     * The offered units are the backend's intersection of platform policy and
     * the agent's local allowlist. The browser never accepts a free unit name,
     * and the server and agent independently enforce the same closed set.
     */
    renderServices(host) {
      const container = el('div');
      const snapshot = host?.snapshot;

      if (snapshot) {
        const systemd = snapshot.systemd || {};
        if (!systemd.available) {
          container.appendChild(el('p', 'os-host-empty',
            'systemd is not available on this host, or the agent could not read init state.'));
        } else {
          container.appendChild(el('p', null,
            `${text(systemd.failedUnitCount, '0')} failed unit(s) reported.`));
          container.appendChild(table(
            ['Failed unit'],
            (systemd.failedUnits || []).map((unit) => [unit]),
            'No failed units were reported.',
          ));
          if (systemd.truncated) {
            container.appendChild(el('p', 'os-host-empty',
              'The failed-unit list was truncated by the agent bound.'));
          }
        }
      } else {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          'This host has not reported a snapshot, so no new service restart can be requested. '
          + 'Existing restart requests and their audit trails remain below.'));
        alert.appendChild(item);
        container.appendChild(alert);
      }

      if (this._operationError === 'not-installed') {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          'Governed host operations are not installed on this control center. Restart history '
          + 'cannot be read and no restart can be requested.'));
        alert.appendChild(item);
        container.appendChild(alert);
        return container;
      }
      if (this._operationError) {
        const alert = el('div', 'alert alert-danger');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text', this._operationError));
        alert.appendChild(item);
        container.appendChild(alert);
      }

      if (snapshot) {
        const restart = el('form', 'os-op-form');
        restart.addEventListener('submit', (event) => event.preventDefault());
        restart.appendChild(el('h4', null, 'Restart one allowlisted service'));
        const restartCapability = host?.capabilities?.operations?.['service.restart'] || {};
        // The API already intersects what the platform granted with what the
        // host reported. Showing the disagreement keeps stale or divergent
        // configuration visible instead of silently narrowing the list.
        const allowlist = Array.isArray(restartCapability.allowlist)
          ? restartCapability.allowlist : [];
        restart.appendChild(el('p', 'os-host-empty',
          allowlist.length
            ? 'Only a service this control center granted and the agent will honour is offered. '
              + 'Submitting creates a request; it does not restart the unit.'
            : (restartCapability.reason || 'No service is allowlisted for restart on this host.')));
        restart.appendChild(this._secondPersonNotice());

        const drift = restartCapability.drift || {};
        if (drift.onlyGranted?.length || drift.onlyReported?.length) {
          const notice = el('div', 'alert alert-warning');
          const item = el('div', 'alert-item static');
          const parts = [];
          if (drift.onlyGranted?.length) {
            parts.push(`granted but not reported by the agent: ${drift.onlyGranted.join(', ')}`);
          }
          if (drift.onlyReported?.length) {
            parts.push(`reported by the agent but not granted here: ${drift.onlyReported.join(', ')}`);
          }
          item.appendChild(el('span', 'alert-text',
            `The control center and the agent disagree about the restart allowlist — ${parts.join('; ')}. `
            + 'Only units both sides permit are offered.'));
          notice.appendChild(item);
          restart.appendChild(notice);
        }

        const selected = allowlist.includes(this._restartForm.unit)
          ? this._restartForm.unit : (allowlist[0] || '');
        const unitControl = allowlist.length
          ? select(allowlist.map((unit) => ({ value: unit, label: unit })), selected)
          : input('text', '', { disabled: 'disabled', placeholder: 'no allowlisted services' });
        const restartReason = input('text', this._restartForm.reason, {
          placeholder: 'why this restart is needed',
          maxlength: String(MAX_REASON),
        });
        restart.appendChild(field('Service', unitControl,
          'This value comes only from the effective platform-and-agent allowlist.'));
        restart.appendChild(field('Reason', restartReason,
          `At least ${MIN_REASON} characters. Recorded in the audit trail and read by the approver.`));

        const restartGate = this._capability('service.restart');
        const actions = el('div', 'os-op-actions');
        actions.appendChild(gatedButton('Request restart', 'btn btn-sm btn-danger-outline',
          restartGate.allowed && allowlist.length > 0 && !this._operationBusy,
          restartGate.reason || (allowlist.length
            ? 'A request is already in flight.'
            : 'This host has no service in the effective restart allowlist.'),
          () => {
            const unit = String(unitControl.value || selected);
            const reason = String(restartReason.value || '').trim();
            this._restartForm = { unit, reason };
            if (!allowlist.includes(unit)) {
              this._refuseSubmit('Select a service from the effective restart allowlist.');
              return;
            }
            const problem = reasonProblem(reason);
            if (problem) {
              this._refuseSubmit(problem);
              return;
            }
            void this.submitOperation('service.restart', { unit }, reason).then((accepted) => {
              if (!accepted) return;
              this._restartForm.reason = '';
              this.render();
            });
          }));
        restart.appendChild(actions);
        container.appendChild(restart);
      }

      container.appendChild(el('h4', null, 'Service restart activity'));
      const history = this._operations.filter((entry) =>
        SERVICE_OPERATIONS.includes(entry?.operation));
      container.appendChild(this.renderOperationList(
        history,
        'No service restart has been recorded for this host.',
      ));
      if (this._operationDetail
          && SERVICE_OPERATIONS.includes(this._operationDetail.operation?.operation)) {
        container.appendChild(this.renderOperationDetail());
      }
      return container;
    }

    /**
     * A bounded, audited journal query in the domain tab where its result is read.
     *
     * Journal content is never part of a periodic snapshot. It is fetched only
     * through a typed read-only operation, limited to eight systemd units,
     * 2,000 lines and the agent's 48 KiB receipt bound. The list and detail
     * below stay available when the host stops reporting, because the audit
     * record is platform state rather than host inventory.
     */
    renderJournal(host) {
      const container = el('div');

      if (this._operationError === 'not-installed') {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          'Governed host operations are not installed on this control center. Journal history '
          + 'cannot be read and a new bounded query cannot be requested.'));
        alert.appendChild(item);
        container.appendChild(alert);
        return container;
      }

      if (this._operationError) {
        const alert = el('div', 'alert alert-danger');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text', this._operationError));
        alert.appendChild(item);
        container.appendChild(alert);
      }

      const form = el('form', 'os-op-form');
      form.addEventListener('submit', (event) => event.preventDefault());
      form.appendChild(el('h4', null, 'Query the system journal'));
      form.appendChild(el('p', 'os-host-empty',
        `Reads a bounded slice without following the journal or changing the host. A query names `
        + `at most ${MAX_JOURNAL_UNITS} systemd units and returns at most ${MAX_JOURNAL_LINES} `
        + 'lines; the agent also caps the receipt at 48 KiB and reports when it was truncated.'));

      if (!host?.snapshot) {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          'This host has not reported a snapshot, so no new journal query can be requested. '
          + 'Existing query results and their audit trails remain below.'));
        alert.appendChild(item);
        form.appendChild(alert);
      } else {
        const units = input('text', this._journalForm.units, {
          placeholder: 'sshd.service, kubelet.service',
          maxlength: '1031',
        });
        const priority = select([
          { value: '', label: 'Any priority' },
          ...JOURNAL_PRIORITIES.slice(1).map((value) => ({ value, label: value })),
        ], this._journalForm.priority);
        const since = input('text', this._journalForm.since, {
          placeholder: '-1 hour ago',
          maxlength: '32',
        });
        const lines = input('number', this._journalForm.lines, { min: '1', max: '2000' });
        const reason = input('text', this._journalForm.reason, {
          placeholder: 'why these journal records are needed',
          maxlength: String(MAX_REASON),
        });

        form.appendChild(field('Units (comma separated)', units,
          `Optional. At most ${MAX_JOURNAL_UNITS} complete systemd unit names; no wildcard or free command.`));
        form.appendChild(field('Priority', priority,
          'Optional journald priority. “Any priority” applies no priority filter.'));
        form.appendChild(field('Since', since,
          'Optional: now, today, yesterday, an absolute date, or a bounded form such as -1 hour ago.'));
        form.appendChild(field('Lines', lines,
          `The newest 1 to ${MAX_JOURNAL_LINES} matching lines. The 48 KiB output bound still applies.`));
        form.appendChild(field('Reason', reason,
          `At least ${MIN_REASON} characters. Recorded with the query and its result.`));

        const gate = this._capability('journal.query');
        const actions = el('div', 'os-op-actions');
        actions.appendChild(gatedButton('Run journal query', 'btn btn-sm btn-primary',
          gate.allowed && !this._operationBusy,
          gate.reason || 'A request is already in flight.',
          () => {
            const rawUnits = String(units.value || '').trim();
            const requestedUnits = rawUnits ? rawUnits.split(',').map((unit) => unit.trim()) : [];
            const requestedPriority = String(priority.value || '');
            const requestedSince = String(since.value || '').trim();
            const requestedLines = Number(lines.value);
            const requestedReason = String(reason.value || '').trim();
            this._journalForm = {
              units: rawUnits,
              priority: requestedPriority,
              since: requestedSince,
              lines: requestedLines,
              reason: requestedReason,
            };

            if (requestedUnits.some((unit) => !unit)) {
              this._refuseSubmit('Separate complete systemd unit names with one comma; an empty unit is not accepted.');
              return;
            }
            if (requestedUnits.length > MAX_JOURNAL_UNITS) {
              this._refuseSubmit(`One journal query names at most ${MAX_JOURNAL_UNITS} systemd units.`);
              return;
            }
            const invalidUnit = requestedUnits.find((unit) => !SYSTEMD_UNIT_RE.test(unit));
            if (invalidUnit) {
              this._refuseSubmit(`${invalidUnit.slice(0, 64)} is not a complete systemd unit name.`);
              return;
            }
            if (!JOURNAL_PRIORITIES.includes(requestedPriority)) {
              this._refuseSubmit('Select a journald priority from the list.');
              return;
            }
            if (requestedSince && !JOURNAL_TIME_SPEC_RE.test(requestedSince)) {
              this._refuseSubmit('Since must be now, today, yesterday, an absolute date, or a form such as -1 hour ago.');
              return;
            }
            if (!Number.isInteger(requestedLines)
                || requestedLines < 1 || requestedLines > MAX_JOURNAL_LINES) {
              this._refuseSubmit(`Lines must be an integer from 1 to ${MAX_JOURNAL_LINES}.`);
              return;
            }
            const problem = reasonProblem(requestedReason);
            if (problem) {
              this._refuseSubmit(problem);
              return;
            }

            void this.submitOperation('journal.query', {
              units: requestedUnits,
              priority: requestedPriority,
              since: requestedSince,
              lines: requestedLines,
            }, requestedReason).then((accepted) => {
              if (!accepted) return;
              this._journalForm.reason = '';
              this.render();
            });
          }));
        form.appendChild(actions);
      }
      container.appendChild(form);

      container.appendChild(el('h4', null, 'Journal query activity'));
      const history = this._operations.filter((entry) =>
        JOURNAL_OPERATIONS.includes(entry?.operation));
      container.appendChild(this.renderOperationList(
        history,
        'No journal query has been recorded for this host.',
      ));
      if (this._operationDetail
          && JOURNAL_OPERATIONS.includes(this._operationDetail.operation?.operation)) {
        container.appendChild(this.renderOperationDetail());
      }
      return container;
    }

    renderMetrics() {
      const container = el('div');
      const toolbar = el('div', 'os-metrics-toolbar');
      const source = el('div', 'os-metrics-source');
      source.appendChild(el('h4', null, 'Beszel host metrics'));
      const freshness = this._metrics?.system?.freshness;
      const sourceBadge = freshness === 'fresh'
        ? { label: 'Fresh', cls: 'label-success' }
        : (freshness === 'stale'
          ? { label: 'Stale', cls: 'label-warning' }
          : { label: freshness === 'offline' ? 'Offline' : 'Unavailable', cls: 'label-danger' });
      source.appendChild(el('span', `label ${sourceBadge.cls}`, sourceBadge.label));
      if (this._metrics?.source?.agentVersion) {
        source.appendChild(el('span', 'os-host-empty',
          `Beszel agent ${text(this._metrics.source.agentVersion)}`));
      }
      toolbar.appendChild(source);

      const range = select([
        { value: '1h', label: 'Last hour' },
        { value: '12h', label: 'Last 12 hours' },
        { value: '24h', label: 'Last 24 hours' },
        { value: '1w', label: 'Last 7 days' },
        { value: '30d', label: 'Last 30 days' },
      ], this._metricsRange);
      range.setAttribute('aria-label', 'Metrics time range');
      range.addEventListener('change', () => {
        if (range.value === this._metricsRange) return;
        this._metricsRange = range.value;
        this._metrics = null;
        this._metricsError = '';
        this._metricsLoading = true;
        this.render();
        void this.loadMetrics(this._selected).then(() => this.render());
      });
      toolbar.appendChild(field(
        'Range',
        range,
        'RCC selects Beszel’s matching retained resolution; it does not resample in the browser.',
      ));
      container.appendChild(toolbar);

      if (this._metricsError) {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          `${this._metricsError} Host inventory and governed operations remain independent.`));
        alert.appendChild(item);
        container.appendChild(alert);
      }
      if (this._metricsLoading) {
        const loading = el('p', 'os-host-empty');
        loading.appendChild(el('span', 'spinner spinner-inline'));
        loading.appendChild(document.createTextNode(
          this._metrics ? ' Refreshing Beszel metrics…' : ' Loading Beszel metrics…',
        ));
        container.appendChild(loading);
      }
      if (!this._metrics) return container;

      if (this._metrics.schemaVersion !== 'rcc.host.metrics/v1') {
        container.appendChild(el('p', 'os-host-empty',
          'The metrics adapter returned an unsupported schema, so RCC will not render it.'));
        return container;
      }
      const points = Array.isArray(this._metrics.points)
        ? this._metrics.points.slice(-100) : [];
      const latest = this._metrics.latest && typeof this._metrics.latest === 'object'
        ? this._metrics.latest : points.at(-1);
      if (!latest) {
        container.appendChild(el('p', 'os-host-empty',
          'Beszel has no metrics points for this host in the selected range.'));
      } else {
        const summary = el('div', 'os-metric-summary');
        const card = (label, value, detail) => {
          const node = el('div', 'os-metric-card');
          node.appendChild(el('span', null, label));
          node.appendChild(el('strong', null, value));
          node.appendChild(el('small', null, detail));
          summary.appendChild(node);
        };
        card(
          'CPU',
          decimal(latest.cpuPercent, '%'),
          `load ${decimal(latest.load1)} / ${decimal(latest.load5)} / ${decimal(latest.load15)}`,
        );
        card(
          'Memory',
          decimal(latest.memoryPercent, '%'),
          `${bytes(latest.memoryUsedBytes)} used of ${bytes(latest.memoryTotalBytes)}`,
        );
        card(
          'Root disk',
          decimal(latest.diskPercent, '%'),
          `${bytes(latest.diskUsedBytes)} used of ${bytes(latest.diskTotalBytes)}`,
        );
        card(
          'Network',
          `↓ ${bytesPerSecond(latest.networkReceiveBytesPerSecond)}`,
          `↑ ${bytesPerSecond(latest.networkSendBytesPerSecond)}`,
        );
        card(
          'Latest sample',
          metricTimestamp(latest.timestamp),
          `${points.length} point${points.length === 1 ? '' : 's'} · ${
            text(this._metrics.sourceResolution)
          } source resolution`,
        );
        container.appendChild(summary);
      }

      if (Array.isArray(this._metrics.warnings) && this._metrics.warnings.length) {
        const warnings = el('ul', 'os-metrics-warnings');
        for (const warning of this._metrics.warnings.slice(0, 8)) {
          warnings.appendChild(el('li', null, text(warning)));
        }
        container.appendChild(warnings);
      }

      const charts = el('div', 'os-metric-chart-grid');
      charts.appendChild(metricChart('CPU utilization', points, [
        { key: 'cpuPercent', label: 'CPU', color: '#0072a3' },
      ], { min: 0, max: 100, formatAxis: (value) => decimal(value, '%', 0) }));
      charts.appendChild(metricChart('Memory utilization', points, [
        { key: 'memoryPercent', label: 'Memory', color: '#6b4fbb' },
      ], { min: 0, max: 100, formatAxis: (value) => decimal(value, '%', 0) }));
      charts.appendChild(metricChart('Root disk utilization', points, [
        { key: 'diskPercent', label: 'Disk', color: '#a65f00' },
      ], { min: 0, max: 100, formatAxis: (value) => decimal(value, '%', 0) }));
      charts.appendChild(metricChart('Network throughput', points, [
        { key: 'networkReceiveBytesPerSecond', label: 'Receive', color: '#00875a' },
        { key: 'networkSendBytesPerSecond', label: 'Send', color: '#d1495b' },
      ], { min: 0, formatAxis: bytesPerSecond }));
      charts.appendChild(metricChart('Disk throughput', points, [
        { key: 'diskReadBytesPerSecond', label: 'Read', color: '#146c94' },
        { key: 'diskWriteBytesPerSecond', label: 'Write', color: '#c05a13' },
      ], { min: 0, formatAxis: bytesPerSecond }));
      charts.appendChild(metricChart('Load average', points, [
        { key: 'load1', label: '1 min', color: '#0072a3' },
        { key: 'load5', label: '5 min', color: '#6b4fbb' },
        { key: 'load15', label: '15 min', color: '#a65f00' },
      ], { min: 0, formatAxis: (value) => decimal(value) }));
      container.appendChild(charts);

      container.appendChild(el('p', 'os-host-empty',
        `Source: Beszel read-only API · system ${text(this._metrics.system?.name)} · `
        + `latest age ${duration(this._metrics.system?.latestAgeSeconds)} · `
        + 'credentials and PocketBase records remain server-side.'));
      return container;
    }

    renderSection(host) {
      const snapshot = host.snapshot;
      const container = el('div');

      // Operations do not depend on the snapshot. What was requested, approved
      // and carried out is the record of what this platform did, and it is
      // most needed precisely when a host has stopped reporting. Only new
      // requests are withheld.
      if (this._section === 'operations') {
        container.appendChild(this.renderOperations(host));
        return container;
      }
      if (this._section === 'services') {
        container.appendChild(this.renderServices(host));
        return container;
      }
      if (this._section === 'journal') {
        container.appendChild(this.renderJournal(host));
        return container;
      }
      if (this._section === 'reboot') {
        container.appendChild(this.renderReboot(host));
        return container;
      }
      if (this._section === 'network') {
        container.appendChild(this.renderNetwork(host));
        return container;
      }
      if (this._section === 'storage') {
        container.appendChild(this.renderStorage(host));
        return container;
      }
      if (this._section === 'osimage') {
        container.appendChild(this.renderOSImage(host));
        return container;
      }
      if (this._section === 'metrics') {
        container.appendChild(this.renderMetrics());
        return container;
      }

      if (!snapshot) {
        container.appendChild(el('p', 'os-host-empty',
          'This host has not reported a snapshot yet, so no state can be shown. '
          + 'Verify that rcc-node-agent is installed and running on the host. '
          + 'The Operations tab still shows the full history for this host.'));
        return container;
      }
      const capability = host.capabilities?.[this._section];
      if (capability && capability.supported === false) {
        container.appendChild(unavailableNotice(
          SECTIONS.find((s) => s.id === this._section)?.label || this._section,
          capability.reason));
      }

      if (this._section === 'overview') {
        container.appendChild(definitionList([
          ['Hostname', text(snapshot.identity?.hostname)],
          ['Operating system', text(snapshot.identity?.osName)],
          ['Kernel', text(snapshot.identity?.kernelVersion)],
          ['Architecture', text(snapshot.identity?.architecture)],
          ['Boot identity', text(snapshot.identity?.bootIdHash)],
          ['Uptime', duration(snapshot.identity?.uptimeSeconds)],
          ['CPU count', text(snapshot.resources?.cpuCount)],
          ['Load (1/5/15)', `${text(snapshot.resources?.load1)} / ${text(snapshot.resources?.load5)} / ${text(snapshot.resources?.load15)}`],
          ['Memory total', bytes(snapshot.resources?.memTotalBytes)],
          ['Memory available', bytes(snapshot.resources?.memAvailableBytes)],
          ['Swap total', bytes(snapshot.resources?.swapTotalBytes)],
          ['Agent version', text(host.agentVersion)],
          ['Snapshot schema', text(host.schemaVersion)],
        ]));
        if (Array.isArray(snapshot.degraded) && snapshot.degraded.length) {
          container.appendChild(el('p', 'os-host-empty',
            `The agent could not collect: ${snapshot.degraded.join(', ')}. These values are reported as unknown, not as zero.`));
        }
        return container;
      }

      if (this._section === 'sshban') {
        container.appendChild(this.renderSSHBan(host));
        return container;
      }

      container.appendChild(this.renderUpdates(host));
      return container;
    }

    _sshBanContentionReason() {
      const inFlight = this._operations.find((operation) =>
        ['ssh.protection.enable', 'ssh.ban', 'ssh.unban'].includes(operation.operation)
        && !TERMINAL_OPERATION_STATES.has(operation.status));
      if (inFlight) {
        return `${inFlight.operation} 요청이 이미 ${
          labelFor(OPERATION_STATE_LABEL, inFlight.status).text.toLowerCase()
        } 상태입니다. 완료되고 호스트가 새 jail 상태를 보고할 때까지 기다리십시오.`;
      }
      if (this._operationBusy) return '다른 요청을 전송 중입니다.';
      return '';
    }

    renderSSHBan(host) {
      const container = el('div');
      const state = host.sshBan;
      if (this._operationError && this._operationError !== 'not-installed') {
        const alert = el('div', 'alert alert-danger');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text', this._operationError));
        alert.appendChild(item);
        container.appendChild(alert);
      }
      if (!state) {
        container.appendChild(el('p', 'os-host-empty',
          '이 호스트가 SSH 보호 상태를 보고하지 않았습니다. 최신 RCC 노드 에이전트를 확인한 뒤 '
          + '다음 스냅샷을 기다리십시오.'));
        return container;
      }

      const protectedAddresses = Array.isArray(host.snapshot?.operations?.sshProtectedAddresses)
        ? host.snapshot.operations.sshProtectedAddresses : [];
      const authorityEnabled = host.snapshot?.operations?.sshBanEnabled === true;
      const profileDrift = state.protectionProfile === SSH_PROTECTION_DRIFT;
      const externalProfile = state.protectionProfile === 'external';
      const protectionStatus = state.active && state.supported
        ? (profileDrift
          ? '보호 중 · 기준선 불일치'
          : (authorityEnabled ? '보호 중 · 관리 가능' : '보호 중 · 조회 전용'))
        : (state.installed ? '설치됨 · 비활성' : '미설치');
      const summary = el('div', 'os-security-summary');
      const addSummary = (label, value, detail) => {
        const card = el('section', 'os-security-card');
        card.appendChild(el('span', null, label));
        card.appendChild(el('strong', null, value));
        if (detail) card.appendChild(el('small', null, detail));
        summary.appendChild(card);
      };
      addSummary('보호 상태', protectionStatus,
        `${text(state.provider)} · ${text(state.jail)}`);
      addSummary('현재 공격 시도', text(state.currentlyFailed, '0'),
        `누적 ${text(state.totalFailed, '0')}회 탐지`);
      addSummary('현재 차단', text(state.currentlyBanned, '0'),
        `누적 ${text(state.totalBanned, '0')}회 차단`);
      addSummary('정책', state.active
        ? `${text(state.maxRetry, '—')}회 / ${duration(state.findTimeSeconds)}`
        : 'RCC 기준 정책',
      state.active
        ? `차단 ${state.banTimeSeconds === -1 ? '영구' : duration(state.banTimeSeconds)}`
        : '5회·10분 탐지, 1시간 차단');
      container.appendChild(summary);

      if (externalProfile) {
        const external = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          '고정 RCC 프로필 경로에 외부 정책이 있습니다. 현재 상태와 차단 대응은 계속 표시하지만, '
          + 'RCC는 이 파일을 덮어쓰거나 자동 인수하지 않습니다.'));
        external.appendChild(item);
        container.appendChild(external);
      }

      if (!state.supported || !state.active || profileDrift) {
        container.appendChild(el('h4', null,
          profileDrift ? '보호 기준선 재조정 준비 상태' : '활성화 준비 상태'));
        const readiness = el('ul', 'os-readiness');
        const readinessItem = (ready, label, detail) => {
          const item = el('li');
          item.appendChild(el('strong', null, `${ready ? '✓' : '–'} ${label}`));
          item.appendChild(el('span', null, detail));
          readiness.appendChild(item);
        };
        readinessItem(state.installed === true, 'Fail2ban 패키지',
          state.installed
            ? `설치 버전 ${text(state.packageVersion)}`
            : `설치 후보 ${text(state.candidateVersion, '없음')}`);
        readinessItem(protectedAddresses.length > 0, '관리 접속 보호 주소',
          protectedAddresses.length
            ? protectedAddresses.join(', ')
            : '로컬 에이전트 설정에 최소 1개를 지정해야 합니다.');
        readinessItem(authorityEnabled, '호스트 로컬 실행 권한',
          authorityEnabled
            ? '설치·활성화와 차단 작업이 로컬에서 허용되어 있습니다.'
            : 'sshBanEnabled가 꺼져 있어 RCC가 스스로 권한을 넓힐 수 없습니다.');
        const setupPolicyReady = host.policy?.enabled === true
          && host.policy?.inWindow === true
          && Array.isArray(host.policy?.allowedOperations)
          && host.policy.allowedOperations.includes('ssh.protection.enable');
        readinessItem(setupPolicyReady, '유지보수 정책',
          setupPolicyReady
            ? `${text(host.policy.name)} 정책의 유지보수 창이 열려 있습니다.`
            : '설치·설정 변경을 허용하는 정책과 열린 유지보수 창이 필요합니다.');
        readinessItem(state.active === true && state.supported === true, 'sshd 보호 jail',
          state.active && state.supported
            ? '고정 sshd jail이 활성 상태입니다.'
            : (state.unsupportedReason || 'Fail2ban sshd jail이 아직 활성화되지 않았습니다.'));
        readinessItem(state.protectionProfile === SSH_PROTECTION_PROFILE, 'RCC 보호 기준선',
          profileDrift
            ? '로컬 보호 주소와 적용된 ignoreip가 달라 재조정이 필요합니다.'
            : state.protectionProfile === SSH_PROTECTION_PROFILE
              ? '고정 rcc-ssh-baseline-v1과 로컬 보호 주소가 일치합니다.'
              : externalProfile
                ? '외부 정책은 자동으로 덮어쓰지 않습니다.'
                : '아직 RCC 보호 기준선이 적용되지 않았습니다.');
        container.appendChild(readiness);

        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          profileDrift
            ? 'SSH 보호는 동작 중이지만 관리 접속 보호 주소와 적용 기준선이 다릅니다. '
              + '자동 차단에서 새 관리 주소를 보호하려면 승인된 재조정이 필요합니다.'
            : `현재 SSH 보호가 동작하지 않습니다: ${state.unsupportedReason
              || 'Fail2ban sshd jail이 활성화되지 않았습니다'}.`));
        alert.appendChild(item);
        container.appendChild(alert);

        const blocked = this._sshBanContentionReason();
        const enableGate = this._capability('ssh.protection.enable');
        const setup = el('form', 'os-op-form');
        setup.appendChild(el('h4', null,
          profileDrift
            ? 'RCC SSH 보호 기준선 재조정'
            : state.installed ? 'RCC 기준 SSH 보호 활성화' : 'Fail2ban 설치 및 SSH 보호 활성화'));
        setup.appendChild(el('p', 'os-host-empty',
          `고정 프로필 ${SSH_PROTECTION_PROFILE}을 적용합니다. 패키지는 ${
            state.installed ? '기존 설치본을 사용하며' : `검토된 정확한 버전 ${text(state.candidateVersion)}만 설치하며`
          }, sshd 외 jail·임의 설정·셸 명령은 받지 않습니다. ${
            profileDrift ? '현재 RCC 소유 프로필은 검토된 관리 주소로 원자적으로 갱신됩니다. ' : ''
          }다른 관리자의 승인과 유지보수 정책이 필요합니다.`));
        const setupReason = input('text', this._sshProtectionReason, {
          placeholder: 'SSH 보호 활성화 또는 재조정 사유',
          maxlength: String(MAX_REASON),
        });
        setupReason.addEventListener('change', () => {
          this._sshProtectionReason = setupReason.value;
        });
        const setupConfirmed = input('checkbox', '');
        setupConfirmed.checked = this._sshProtectionConfirmed;
        setupConfirmed.addEventListener('change', () => {
          this._sshProtectionConfirmed = setupConfirmed.checked;
        });
        setup.appendChild(field('사유', setupReason,
          `최소 ${MIN_REASON}자이며 감사 이력에 기록됩니다.`));
        setup.appendChild(field(
          '보호 관리 주소와 5회·10분 탐지·1시간 차단의 고정 정책을 검토했습니다',
          setupConfirmed,
        ));
        const setupActions = el('div', 'os-op-actions');
        setupActions.appendChild(gatedButton(
          profileDrift ? 'SSH 보호 기준선 재조정 요청' : 'SSH 보호 활성화 요청',
          'btn btn-sm btn-primary',
          enableGate.allowed && !blocked,
          blocked || enableGate.reason,
          () => {
            const reason = setupReason.value.trim();
            if (!setupConfirmed.checked) {
              return this._refuseSubmit(
                '보호 관리 주소와 고정 보호 정책을 확인한 뒤 요청하십시오.',
              );
            }
            const problem = reasonProblem(reason);
            if (problem) return this._refuseSubmit(problem);
            this._sshProtectionReason = reason;
            void (async () => {
              const accepted = await this.submitOperation(
                'ssh.protection.enable',
                {},
                reason,
              );
              if (accepted) {
                this._sshProtectionReason = '';
                this._sshProtectionConfirmed = false;
                this.render();
              }
            })();
            return undefined;
          },
        ));
        setup.appendChild(setupActions);
        setup.addEventListener('submit', (event) => event.preventDefault());
        container.appendChild(setup);

        if (!state.supported || !state.active) {
          container.appendChild(el('h4', null, 'SSH 보호 작업 이력'));
          const setupActivity = this._operations.filter((operation) =>
            ['ssh.protection.enable', 'ssh.ban', 'ssh.unban'].includes(operation.operation));
          container.appendChild(this.renderOperationList(
            setupActivity,
            '이 호스트에는 아직 SSH 보호 작업 요청이 없습니다.',
          ));
          if (this._operationDetail
              && ['ssh.protection.enable', 'ssh.ban', 'ssh.unban']
                .includes(this._operationDetail.operation?.operation)) {
            container.appendChild(this.renderOperationDetail());
          }
          return container;
        }
      }

      const banned = Array.isArray(state.bannedAddresses) ? state.bannedAddresses : [];
      container.appendChild(el('h4', null, '현재 차단 주소'));
      container.appendChild(table(
        ['IP 주소', '보호 jail'],
        banned.map((address) => [address, 'sshd']),
        '현재 sshd jail에서 차단 중인 IP 주소가 없습니다.',
      ));
      if (state.truncated) {
        container.appendChild(el('p', 'alert-text',
          `호스트는 현재 차단 ${state.currentlyBanned}건을 보고했지만 위 제한 목록은 완전하지 않습니다. `
          + '목록에 없는 주소를 선택하려면 jail 항목을 줄인 뒤 다시 조회하십시오.'));
      }

      container.appendChild(el('p', 'os-host-empty',
        protectedAddresses.length
          ? `차단할 수 없는 관리 접속 보호 주소: ${protectedAddresses.join(', ')}.`
          : '호스트가 관리 접속 보호 주소를 보고하지 않았습니다. 최소 1개가 설정될 때까지 변경은 닫힙니다.'));
      container.appendChild(definitionList([
        ['설치 버전', text(state.packageVersion)],
        ['보호 프로필', text(state.protectionProfile, '외부 또는 알 수 없음')],
        ['프로필 다이제스트', text(state.profileDigest, '없음')],
        ['탐지 구간', duration(state.findTimeSeconds)],
        ['최대 실패 횟수', text(state.maxRetry)],
        ['차단 시간', state.banTimeSeconds === -1 ? '영구' : duration(state.banTimeSeconds)],
        ['최종 보고', text(state.collectedAt, '알 수 없음')],
      ]));

      const events = Array.isArray(state.recentEvents) ? state.recentEvents : [];
      container.appendChild(el('h4', null, '최근 SSH 탐지·차단 이벤트'));
      container.appendChild(table(
        ['시각', '이벤트', 'IP 주소'],
        events.map((event) => [
          metricTimestamp(event.occurredAt),
          event.action === 'found' ? '탐지' : event.action === 'ban' ? '차단' : '해제',
          event.address,
        ]),
        '최근 Fail2ban 이벤트가 없습니다.',
      ));

      const blocked = this._sshBanContentionReason();
      if (blocked) container.appendChild(el('p', 'os-host-empty', blocked));

      const securityActions = el('div', 'os-security-actions');
      const banGate = this._capability('ssh.ban');
      const ban = el('form', 'os-op-form');
      ban.appendChild(el('h4', null, 'IP 주소 차단'));
      ban.appendChild(el('p', 'os-host-empty',
        '정확한 IP 주소 하나를 Fail2ban의 고정 sshd jail에 추가합니다. CIDR 범위·임의 jail·'
        + '보호 관리 주소는 거부되며, 다른 관리자의 승인이 필요합니다.'));
      const banAddress = input('text', this._sshBanAddress,
        { placeholder: '203.0.113.24 or 2001:db8::24', maxlength: '64', autocomplete: 'off' });
      banAddress.addEventListener('change', () => { this._sshBanAddress = banAddress.value; });
      const banReason = input('text', this._sshBanReason,
        { placeholder: '이 주소를 차단해야 하는 사유', maxlength: String(MAX_REASON) });
      banReason.addEventListener('change', () => { this._sshBanReason = banReason.value; });
      const banConfirmed = input('checkbox', '');
      banConfirmed.checked = this._sshBanConfirmed;
      banConfirmed.addEventListener('change', () => { this._sshBanConfirmed = banConfirmed.checked; });
      ban.appendChild(field('IP 주소', banAddress, '범위나 CIDR이 아닌 정확한 IPv4 또는 IPv6 주소 하나입니다.'));
      ban.appendChild(field('사유', banReason, `최소 ${MIN_REASON}자이며 감사 이력에 기록됩니다.`));
      ban.appendChild(field('관리자 또는 관리 접속 주소가 아님을 확인했습니다', banConfirmed));
      const banActions = el('div', 'os-op-actions');
      banActions.appendChild(gatedButton('차단 요청', 'btn btn-sm btn-danger-outline',
        banGate.allowed && !blocked,
        blocked || banGate.reason,
        () => {
          const address = canonicalIPAddress(banAddress.value);
          const reason = banReason.value.trim();
          if (!address) return this._refuseSubmit('CIDR 범위가 아닌 정확한 IP 주소 하나를 입력하십시오.');
          if (!banConfirmed.checked) return this._refuseSubmit('대상이 관리자 또는 관리 접속 주소가 아님을 확인하십시오.');
          const problem = reasonProblem(reason);
          if (problem) return this._refuseSubmit(problem);
          this._sshBanAddress = address;
          this._sshBanReason = reason;
          void (async () => {
            const accepted = await this.submitOperation('ssh.ban', { address }, reason);
            if (accepted) {
              this._sshBanAddress = '';
              this._sshBanReason = '';
              this._sshBanConfirmed = false;
              this.render();
            }
          })();
          return undefined;
        }));
      ban.appendChild(banActions);
      ban.addEventListener('submit', (event) => event.preventDefault());
      securityActions.appendChild(ban);

      const unbanGate = this._capability('ssh.unban');
      const unban = el('form', 'os-op-form');
      unban.appendChild(el('h4', null, 'IP 주소 차단 해제'));
      const unbanTarget = select(
        [{ value: '', label: '현재 차단 주소 선택' },
          ...banned.map((address) => ({ value: address, label: address }))],
        this._sshUnbanAddress,
      );
      unbanTarget.addEventListener('change', () => { this._sshUnbanAddress = unbanTarget.value; });
      const unbanReason = input('text', this._sshUnbanReason,
        { placeholder: '이 주소의 접속을 복원하는 사유', maxlength: String(MAX_REASON) });
      unbanReason.addEventListener('change', () => { this._sshUnbanReason = unbanReason.value; });
      const unbanConfirmed = input('checkbox', '');
      unbanConfirmed.checked = this._sshUnbanConfirmed;
      unbanConfirmed.addEventListener('change', () => { this._sshUnbanConfirmed = unbanConfirmed.checked; });
      unban.appendChild(field('차단된 IP 주소', unbanTarget));
      unban.appendChild(field('사유', unbanReason, `최소 ${MIN_REASON}자이며 감사 이력에 기록됩니다.`));
      unban.appendChild(field('이 주소의 SSH 접속을 복원해도 됨을 확인했습니다', unbanConfirmed));
      const unbanActions = el('div', 'os-op-actions');
      unbanActions.appendChild(gatedButton('차단 해제 요청', 'btn btn-sm btn-primary',
        unbanGate.allowed && !blocked && banned.length > 0,
        blocked || unbanGate.reason || (banned.length ? '' : '선택할 수 있는 현재 차단 주소가 없습니다.'),
        () => {
          const address = canonicalIPAddress(unbanTarget.value);
          const reason = unbanReason.value.trim();
          if (!address || !banned.includes(address)) return this._refuseSubmit('현재 차단 목록에서 주소를 선택하십시오.');
          if (!unbanConfirmed.checked) return this._refuseSubmit('이 주소의 SSH 접속을 복원해도 됨을 확인하십시오.');
          const problem = reasonProblem(reason);
          if (problem) return this._refuseSubmit(problem);
          this._sshUnbanAddress = address;
          this._sshUnbanReason = reason;
          void (async () => {
            const accepted = await this.submitOperation('ssh.unban', { address }, reason);
            if (accepted) {
              this._sshUnbanAddress = '';
              this._sshUnbanReason = '';
              this._sshUnbanConfirmed = false;
              this.render();
            }
          })();
          return undefined;
        }));
      unban.appendChild(unbanActions);
      unban.addEventListener('submit', (event) => event.preventDefault());
      securityActions.appendChild(unban);
      container.appendChild(securityActions);

      container.appendChild(el('h4', null, 'SSH 보호 작업 이력'));
      const activity = this._operations.filter((operation) =>
        ['ssh.protection.enable', 'ssh.ban', 'ssh.unban'].includes(operation.operation));
      container.appendChild(this.renderOperationList(
        activity,
        '이 호스트에는 아직 SSH 보호·차단·해제 요청이 없습니다.',
      ));
      if (this._operationDetail
          && ['ssh.protection.enable', 'ssh.ban', 'ssh.unban']
            .includes(this._operationDetail.operation?.operation)) {
        container.appendChild(this.renderOperationDetail());
      }
      return container;
    }

    /**
     * Adds the state of the governed-operation API to a domain page.
     *
     * A missing route is not an empty history. It also withholds the request
     * form: creating high-risk work without being able to show its record on
     * the same page would make an accepted request look as if nothing happened.
     */
    renderDomainOperationError(container, unavailableMessage) {
      if (!this._operationError) return true;
      const missing = this._operationError === 'not-installed';
      const alert = el('div', `alert ${missing ? 'alert-warning' : 'alert-danger'}`);
      const item = el('div', 'alert-item static');
      item.appendChild(el('span', 'alert-text',
        missing ? unavailableMessage : this._operationError));
      alert.appendChild(item);
      container.appendChild(alert);
      return !missing;
    }

    /**
     * Network state, one reviewed NetworkManager request, rollback evidence and
     * its audit trail in the same domain page.
     */
    renderNetwork(host) {
      const container = el('div');
      container.appendChild(this.renderNetworkInventory(host));
      const operationsAvailable = this.renderDomainOperationError(
        container,
        'Governed host operations are not installed on this control center. Network change '
          + 'history cannot be read and no network change can be requested.',
      );
      if (host?.snapshot && operationsAvailable) {
        container.appendChild(this.renderNetworkForm(host));
      } else if (!host?.snapshot) {
        container.appendChild(el('p', 'os-host-empty',
          'This host has not reported a snapshot, so no new network change can be requested. '
            + 'Existing rollback and audit evidence remains below.'));
      }
      container.appendChild(el('h4', null, 'Network change activity'));
      const history = this._operations.filter((entry) =>
        NETWORK_OPERATIONS.includes(entry?.operation));
      container.appendChild(this.renderOperationList(
        history,
        'No network change or automatic rollback has been recorded for this host.',
      ));
      if (this._operationDetail
          && NETWORK_OPERATIONS.includes(this._operationDetail.operation?.operation)) {
        container.appendChild(this.renderOperationDetail());
      }
      return container;
    }

    /**
     * Storage inventory, governed mount/grow requests and their evidence in the
     * same page. A filesystem grow has no shrink path, so its target and
     * headroom stay visible beside the request and result.
     */
    renderStorage(host) {
      const container = el('div');
      container.appendChild(this.renderStorageInventory(host));
      const operationsAvailable = this.renderDomainOperationError(
        container,
        'Governed host operations are not installed on this control center. Storage change '
          + 'history cannot be read and no mount or filesystem growth can be requested.',
      );
      if (host?.snapshot && operationsAvailable) {
        container.appendChild(this.renderStorageForms(host));
      } else if (!host?.snapshot) {
        container.appendChild(el('p', 'os-host-empty',
          'This host has not reported a snapshot, so no new storage change can be requested. '
            + 'Existing storage request evidence remains below.'));
      }
      container.appendChild(el('h4', null, 'Storage change activity'));
      const history = this._operations.filter((entry) =>
        STORAGE_OPERATIONS.includes(entry?.operation));
      container.appendChild(this.renderOperationList(
        history,
        'No mount or filesystem growth has been recorded for this host.',
      ));
      if (this._operationDetail
          && STORAGE_OPERATIONS.includes(this._operationDetail.operation?.operation)) {
        container.appendChild(this.renderOperationDetail());
      }
      return container;
    }

    /**
     * Immutable-image inventory, stage/rollback requests and deployment
     * evidence. These operations deliberately never invoke a reboot.
     */
    renderOSImage(host) {
      const container = el('div');
      container.appendChild(this.renderBootInventory(host));
      const operationsAvailable = this.renderDomainOperationError(
        container,
        'Governed host operations are not installed on this control center. OS image activity '
          + 'cannot be read and no image stage or rollback can be requested.',
      );
      if (host?.snapshot && operationsAvailable) {
        container.appendChild(this.renderImageForms(host));
      } else if (!host?.snapshot) {
        container.appendChild(el('p', 'os-host-empty',
          'This host has not reported a snapshot, so no new image operation can be requested. '
            + 'Existing deployment activity remains below.'));
      }
      container.appendChild(el('h4', null, 'OS image activity'));
      const history = this._operations.filter((entry) =>
        OS_IMAGE_OPERATIONS.includes(entry?.operation));
      container.appendChild(this.renderOperationList(
        history,
        'No operating system image stage or rollback has been recorded for this host.',
      ));
      if (this._operationDetail
          && OS_IMAGE_OPERATIONS.includes(this._operationDetail.operation?.operation)) {
        container.appendChild(this.renderOperationDetail());
      }
      return container;
    }

    /**
     * What the host reports about its own network.
     *
     * The interface carrying the default route is called out explicitly,
     * because it is the one thing on this screen the platform will never
     * change, and leaving an operator to infer that from the routing table is
     * how someone ends up requesting a change that is refused.
     */
    renderNetworkInventory(host) {
      const container = el('div');
      const snapshot = host.snapshot || {};
      const state = host.networkState;

      if (!state) {
        container.appendChild(el('p', 'os-host-empty',
          'This host has not reported network state. Either it has not sent a snapshot yet, or '
          + 'network inventory is switched off in its agent configuration.'));
      } else {
        if (!state.supported) {
          const alert = el('div', 'alert alert-warning');
          const item = el('div', 'alert-item static');
          item.appendChild(el('span', 'alert-text',
            `Network changes are not available on this host: ${state.unsupportedReason
              || `the reported network manager (${state.manager || 'unknown'}) is not one this platform drives`}.`));
          alert.appendChild(item);
          container.appendChild(alert);
          container.appendChild(el('p', 'os-host-empty',
            'Link state below is still reported. Read-only and unsupported are different things: '
            + 'this host is readable and not changeable.'));
        }

        const route = state.defaultRoute || {};
        container.appendChild(definitionList([
          ['Network manager', text(state.manager)],
          ['Default route', route.present
            ? `via ${text(route.gateway, 'unknown')} on ${text(route.interface, 'unknown')}`
            : 'none reported'],
          ['Management interface', route.present
            ? `${text(route.interface)} — never reconfigured by this platform`
            : 'unknown'],
          ['DNS servers', (state.dns?.servers || []).join(', ') || '—'],
          ['DNS search', (state.dns?.search || []).join(', ') || '—'],
          ['DNS source', text(state.dns?.source)],
        ]));

        container.appendChild(el('h4', null, 'Links'));
        container.appendChild(table(
          ['Interface', 'State', 'Type', 'MTU', 'Addresses', 'Method', 'Profile', 'Changeable'],
          (state.links || []).map((link) => [
            text(link.name),
            text(link.state),
            text(link.type),
            text(link.mtu),
            (link.addresses || []).join(', ') || '—',
            text(link.method, link.managed ? 'unknown' : 'unmanaged'),
            text(link.connection),
            link.carriesRcc ? 'no — carries the control path'
              : (link.managed ? (link.connection ? 'yes' : 'no — no profile') : 'no — unmanaged'),
          ]),
          'No links were reported.',
        ));
        if (state.truncated) {
          container.appendChild(el('p', 'os-host-empty',
            'The link list was truncated by the agent bound.'));
        }
      }

      container.appendChild(el('h4', null, 'Counters'));
      container.appendChild(table(
        ['Interface', 'RX', 'TX', 'RX errors', 'TX errors', 'RX dropped', 'TX dropped'],
        (snapshot.network || []).map((nic) => [
          text(nic.name), bytes(nic.rxBytes), bytes(nic.txBytes),
          text(nic.rxErrors, '0'), text(nic.txErrors, '0'), text(nic.rxDropped, '0'), text(nic.txDropped, '0'),
        ]),
        'No interface counters were reported.',
      ));
      return container;
    }

    /**
     * What the host reports about its own storage.
     *
     * Growability is shown with its reason. "Cannot be grown" has several very
     * different causes — wrong filesystem type, no headroom, a protected path —
     * and only one of them means somebody made a mistake.
     */
    renderStorageInventory(host) {
      const container = el('div');
      const snapshot = host.snapshot || {};
      const storage = host.storage;

      container.appendChild(el('h4', null, 'Filesystems'));
      container.appendChild(table(
        ['Mount point', 'Device', 'Type', 'Used', 'Total', 'Use %', 'Mode'],
        (snapshot.filesystems || []).map((fs) => {
          const pct = percentUsed(fs.usedBytes, fs.totalBytes);
          return [
            text(fs.mountPoint), text(fs.device), text(fs.fsType),
            bytes(fs.usedBytes), bytes(fs.totalBytes),
            pct === null ? '—' : `${pct}%`,
            fs.readOnly ? 'read-only' : 'read-write',
          ];
        }),
        'No block-backed filesystems were reported.',
      ));

      if (!storage) {
        container.appendChild(el('p', 'os-host-empty',
          'This host has not reported block-device state. Either it has not sent a snapshot yet, or '
          + 'storage inventory is switched off in its agent configuration.'));
        return container;
      }
      if (!storage.supported) {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          `The block layer could not be enumerated on this host: ${storage.unsupportedReason || 'no reason was reported'}.`));
        alert.appendChild(item);
        container.appendChild(alert);
        container.appendChild(el('p', 'os-host-empty',
          'No devices are listed, because an unreadable block layer cannot be reported reliably. '
          + 'This is not the same as "this host has no disks".'));
        return container;
      }

      container.appendChild(el('h4', null, 'Growth headroom'));
      container.appendChild(table(
        ['Mount point', 'Type', 'Filesystem', 'Device', 'Headroom', 'Can grow'],
        (storage.capacity || []).map((entry) => [
          text(entry.mountPoint),
          text(entry.fsType),
          bytes(entry.sizeBytes),
          bytes(entry.deviceBytes),
          entry.headroomBytes > 0 ? bytes(entry.headroomBytes) : 'none',
          entry.growable ? 'yes' : `no — ${text(entry.reason, 'no reason reported')}`,
        ]),
        'No filesystem growth information was reported.',
      ));
      container.appendChild(el('p', 'os-host-empty',
        'Growing a filesystem never moves data and never changes a partition table. It expands the '
        + 'filesystem into a block device that is already larger than it, which somebody enlarged on '
        + 'the storage side first. There is no shrink operation.'));

      container.appendChild(el('h4', null, 'Block devices'));
      container.appendChild(table(
        ['Device', 'Kind', 'Size', 'Type', 'Mounted at', 'Media', 'Protected'],
        (storage.devices || []).map((device) => [
          text(device.name),
          text(device.kind),
          bytes(device.sizeBytes),
          text(device.fsType, 'none'),
          text(device.mountPoint, 'not mounted'),
          `${device.rotational ? 'rotational' : 'solid state'}${device.removable ? ', removable' : ''}${device.readOnly ? ', read-only' : ''}`,
          device.protected ? 'yes' : 'no',
        ]),
        'No block devices were reported.',
      ));
      if (storage.truncated) {
        container.appendChild(el('p', 'os-host-empty', 'The device list was truncated by the agent bound.'));
      }
      return container;
    }

    /** How this host takes an operating system update. */
    renderBootInventory(host) {
      const container = el('div');
      const boot = host.boot;
      if (!boot) {
        container.appendChild(el('p', 'os-host-empty',
          'This host has not reported a boot model. Either it has not sent a snapshot yet, or '
          + 'boot inventory is switched off in its agent configuration.'));
        return container;
      }

      container.appendChild(definitionList([
        ['Update model', text(boot.model)],
        ['Adapter', text(boot.adapter, 'none')],
        ['Can stage an image', boot.canStage ? 'yes' : 'no'],
        ['Can roll back', boot.canRollback ? 'yes' : 'no'],
        ['A previous deployment exists', boot.rollbackAvailable ? 'yes' : 'no'],
      ]));

      if (!boot.supported) {
        const alert = el('div', 'alert alert-info');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          `Image operations are not available on this host: ${boot.unsupportedReason
            || 'this host does not take operating system updates as an image'}.`));
        alert.appendChild(item);
        container.appendChild(alert);
        return container;
      }

      container.appendChild(el('h4', null, 'Deployments'));
      container.appendChild(table(
        ['Role', 'Version', 'Digest', 'Origin', 'Pinned'],
        (boot.deployments || []).map((deployment) => [
          deployment.booted ? 'booted' : (deployment.staged ? 'staged' : (deployment.rollback ? 'rollback' : 'other')),
          text(deployment.version),
          text(deployment.digest),
          text(deployment.origin),
          deployment.pinned ? 'yes' : 'no',
        ]),
        'No deployments were reported.',
      ));
      container.appendChild(el('p', 'os-host-empty',
        'Staging an image writes a new deployment and stops. The running system does not change '
        + 'until host.reboot is separately requested and approved, and that carries the Kubernetes '
        + 'cordon, drain and control-plane checks.'));
      return container;
    }

    /**
     * The Updates page.
     *
     * What this host has pending, and the controls to act on it, in one place:
     * an operator should never have to reconstruct which packages they meant on
     * a second screen, and should never have to leave the console to find out
     * whether the work ran.
     *
     * Everything here submits a typed operation with an enumerated package set
     * bound to exact versions. There is no free-text field that becomes a
     * command, no "update everything" form, no removal or downgrade, and
     * nothing on this page reboots the host.
     */
    renderUpdates(host) {
      const container = el('div');
      const packages = host.packages;

      if (!packages) {
        container.appendChild(el('p', 'os-host-empty',
          'This host has not reported package state. Either it has not sent a snapshot yet, or '
          + 'package inventory is switched off in its agent configuration.'));
        return container;
      }

      if (!packages.supported) {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          `Package maintenance is not available on this host: ${packages.unsupportedReason
            || `the reported package manager (${packages.manager || 'unknown'}) is not one this agent drives`}.`));
        alert.appendChild(item);
        container.appendChild(alert);
        container.appendChild(el('p', 'os-host-empty',
          'No update counts are shown, because an unsupported manager cannot be read reliably. '
          + 'This is not the same as "no updates pending". No update control is offered, because '
          + 'there is no manager here for one to drive.'));
        return container;
      }

      // A refusal has to be readable where the request was made. Without this
      // the operator presses a button, nothing appears to happen, and the
      // server's reason is only visible on a different tab.
      if (this._operationError && this._operationError !== 'not-installed') {
        const alert = el('div', 'alert alert-danger');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text', this._operationError));
        alert.appendChild(item);
        container.appendChild(alert);
      }

      container.appendChild(this.renderUpdateStatus(host));
      container.appendChild(this.renderRefreshCard(host));
      container.appendChild(this.renderPackageUpdateCard(host));
      container.appendChild(this.renderKernelCard(host));
      container.appendChild(this.renderUpdateActivity(host));
      container.appendChild(this.renderPolicySummary(host));
      return container;
    }

    /** What the host reports about its own update state, with its age. */
    renderUpdateStatus(host) {
      const container = el('div');
      const packages = host.packages || {};
      const kernel = host.kernel;

      // Freshness travels with the counts. A pending-update total computed from
      // a month-old index describes the world as it was, and the difference is
      // precisely the security update nobody has seen yet.
      const age = Number(packages.metadataAgeSeconds);
      const known = Number.isFinite(age) && age >= 0;
      const stale = known && age >= STALE_INDEX_SECONDS;
      container.appendChild(el('p', stale ? 'alert-text' : 'os-host-empty',
        (known ? `Package index last refreshed ${describeAge(age)} ago.`
          : 'The age of the package index is unknown.')
        + (stale ? ' These counts may be well out of date. Refresh the index before acting on them; '
          + 'requesting an update is withheld until you do.' : '')));

      if (NON_REPORTING_STATES.has(host?.reportState)) {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          'This host has stopped reporting. Everything below is the last thing it said, not what '
          + 'is true now, so requesting a package or kernel update is withheld.'));
        alert.appendChild(item);
        container.appendChild(alert);
      }

      container.appendChild(table(
        ['Package manager', 'Pending updates', 'Security updates', 'Reported at'],
        [[
          text(packages.manager),
          text(packages.pendingTotal, '0'),
          text(packages.pendingSecurity, '0'),
          text(packages.collectedAt, 'unknown'),
        ]],
        'No package summary was reported.'));

      if (kernel) {
        const drift = kernel.installedLatest && kernel.running
          && kernel.installedLatest !== kernel.running;
        container.appendChild(el('h4', null, 'Kernel'));
        container.appendChild(table(
          ['Running', 'Newest installed', 'Available', 'Reboot required'],
          [[
            text(kernel.running, 'unknown'),
            text(kernel.installedLatest, 'unknown'),
            text(kernel.candidate, 'none offered'),
            kernel.rebootRequired ? 'yes' : 'no',
          ]],
          'No kernel state was reported.'));
        if (drift || kernel.rebootRequired) {
          // This is the whole point of the kernel report: something is on disk
          // that is not running, and only a reboot changes that.
          container.appendChild(el('p', 'os-host-empty',
            'A newer kernel is installed but not running. Installing a kernel never reboots the '
            + 'host; the running kernel changes only when a host.reboot operation is separately '
            + 'requested and approved, and that carries the Kubernetes drain checks.'));
        }
        if (Array.isArray(kernel.rebootRequiredPackages) && kernel.rebootRequiredPackages.length) {
          container.appendChild(el('p', 'os-host-empty',
            `Awaiting a restart: ${kernel.rebootRequiredPackages.join(', ')}`));
        }
      }
      return container;
    }

    /** How this host's maintenance policy currently constrains a request. */
    _windowNote(host) {
      const policy = host?.policy;
      if (!policy) return 'This host has no maintenance policy, so this will be refused.';
      if (policy.inWindow) {
        return `A maintenance window is open until ${policy.windowEndsAt || 'an unknown time'}.`;
      }
      return policy.emergencyAllowed
        ? 'No maintenance window is open. Only an emergency request will be accepted, and it still needs the same approval.'
        : 'No maintenance window is open, so a request will be refused until one opens.';
    }

    /**
     * The emergency control, when the policy allows one.
     *
     * It skips the window and nothing else. Saying so on the control itself
     * matters: "emergency" reads like an override, and this one is not.
     */
    _emergencyControl(host, form, key) {
      const checkbox = input('checkbox', '', {});
      checkbox.checked = this[key] === true;
      checkbox.addEventListener('change', () => { this[key] = checkbox.checked === true; });
      if (host?.policy?.emergencyAllowed) {
        form.appendChild(field('Emergency (run outside a window)', checkbox,
          'Skips the window only. Approval, second person and assurance level are unchanged.'));
      }
      return checkbox;
    }

    /**
     * Why no package operation may be submitted right now.
     *
     * All three contend for the same lock on the host, and the console holds
     * one request at a time, so both are reported as the same kind of "not yet"
     * rather than as a failure.
     */
    _packageContentionReason() {
      const inFlight = this._inFlightPackageOperation();
      if (inFlight) {
        return `A ${inFlight.operation} request on this host is already `
          + `${labelFor(OPERATION_STATE_LABEL, inFlight.status).text.toLowerCase()}. `
          + 'Package operations run one at a time, so this is unavailable until that one finishes.';
      }
      if (this._operationBusy) return 'A request is already in flight.';
      return '';
    }

    /** A one-line notice that this operation cannot be self-approved. */
    _secondPersonNotice() {
      return el('p', 'alert-text',
        'This is high-risk work. A different administrator has to approve it before it runs: '
        + 'you cannot approve your own request, and submitting it here does not start it.');
    }

    /**
     * Refresh the package index.
     *
     * The one low-risk operation on this page. It reads metadata, installs
     * nothing and changes no installed package, so the platform accepts it from
     * a single administrator rather than holding it for a second one.
     */
    renderRefreshCard(host) {
      const gate = this._capability('package.refresh');
      const form = el('form', 'os-op-form');
      form.appendChild(el('h4', null, 'Refresh the package index'));

      if (!gate.allowed) {
        form.appendChild(el('p', 'os-host-empty',
          `Refreshing the package index is unavailable on this host: ${gate.reason}`));
        form.addEventListener('submit', (event) => event.preventDefault());
        return form;
      }

      form.appendChild(el('p', 'os-host-empty',
        'Re-reads the package index so the counts and versions above are current. It installs '
        + 'nothing, changes no installed package and never reboots. Because it changes nothing, '
        + 'one administrator may request it and it is accepted without a second. '
        + this._windowNote(host)));

      const reason = input('text', this._refreshReason,
        { placeholder: 'why this refresh is needed', maxlength: String(MAX_REASON) });
      reason.addEventListener('change', () => { this._refreshReason = reason.value; });
      form.appendChild(field('Reason', reason, `At least ${MIN_REASON} characters. Recorded in the audit trail.`));
      const emergency = this._emergencyControl(host, form, '_refreshEmergency');

      // The reason is checked when the button is pressed rather than while it is
      // typed: re-rendering on each keystroke would take the caret out of the
      // field the operator is still filling in.
      const blocked = this._packageContentionReason();
      if (blocked) form.appendChild(el('p', 'os-host-empty', blocked));
      const actions = el('div', 'os-op-actions');
      actions.appendChild(gatedButton('Refresh index', 'btn btn-sm btn-primary',
        !blocked, blocked,
        () => {
          this._refreshReason = reason.value;
          const problem = reasonProblem(this._refreshReason);
          if (problem) {
            this._operationError = problem;
            this.render();
            return;
          }
          void this.submitOperation('package.refresh',
            { manager: SUPPORTED_PACKAGE_MANAGER }, this._refreshReason.trim(),
            { emergency: emergency.checked });
        }));
      form.appendChild(actions);
      form.addEventListener('submit', (event) => event.preventDefault());
      return form;
    }

    /** Refuses a submission in the page, with the reason, instead of silently. */
    _refuseSubmit(message) {
      this._operationError = message;
      this.render();
    }

    /** Replaces the selection wholesale, saying so when the bound cut it short. */
    _selectPackages(entries) {
      this._operationError = entries.length > MAX_UPDATE_PACKAGES
        ? `Only the first ${MAX_UPDATE_PACKAGES} of ${entries.length} packages were selected. One `
          + 'request carries no more than that, so the rest need a second request.'
        : '';
      this._mutateSelection(() => {
        this._updateSelection.clear();
        for (const entry of entries.slice(0, MAX_UPDATE_PACKAGES)) {
          this._updateSelection.set(entry.name, { ...entry });
        }
      });
    }

    /** Clears a request that the server accepted, so it cannot be sent twice. */
    _clearUpdateRequest() {
      this._updateSelection.clear();
      this._updateSecurityOnly = false;
      this._updateConfirmed = false;
      this._updateReason = '';
      this._updateDrift = { dropped: [], moved: [] };
      this.render();
    }

    /**
     * The pending packages that may be put in a request, one row each.
     *
     * The candidate version is on the row the operator ticks, not summarised
     * elsewhere, because the version is what the request is pinned to and a
     * selection made against a version shown somewhere else is a selection made
     * against something the operator did not read.
     */
    _renderEligibleTable(eligible) {
      const wrapper = el('div', 'table-wrapper');
      const t = el('table', 'table table-compact');
      const thead = el('thead');
      const headRow = el('tr');
      for (const header of ['Select', 'Package', 'Installed now', 'Candidate', 'Security']) {
        headRow.appendChild(el('th', null, header));
      }
      thead.appendChild(headRow);
      t.appendChild(thead);
      const tbody = el('tbody');
      for (const entry of eligible) {
        const row = el('tr');
        const cell = el('td');
        const box = input('checkbox', '', {});
        box.checked = this._updateSelection.has(entry.name);
        box.setAttribute('aria-label', `Select ${entry.name} ${entry.candidateVersion}`);
        box.addEventListener('change', () => {
          const adding = box.checked === true;
          if (adding && !this._updateSelection.has(entry.name)
            && this._updateSelection.size >= MAX_UPDATE_PACKAGES) {
            this._refuseSubmit(`One request carries at most ${MAX_UPDATE_PACKAGES} packages. `
              + `Deselect one before adding ${entry.name}, or request the rest separately.`);
            return;
          }
          this._operationError = '';
          this._mutateSelection(() => {
            // The row's own reported versions are stored, not just the name, so
            // the request is pinned to what this operator actually read.
            if (adding) this._updateSelection.set(entry.name, { ...entry });
            else this._updateSelection.delete(entry.name);
          });
        });
        cell.appendChild(box);
        row.appendChild(cell);
        row.appendChild(el('td', null, entry.name));
        row.appendChild(el('td', null, text(entry.currentVersion, 'not installed')));
        row.appendChild(el('td', null, entry.candidateVersion));
        row.appendChild(el('td', null, entry.security ? 'security' : 'no'));
        tbody.appendChild(row);
      }
      t.appendChild(tbody);
      wrapper.appendChild(t);
      return wrapper;
    }

    /**
     * Choose the exact packages to upgrade, review them, and request it.
     *
     * The request names every package and pins each one to the candidate
     * version shown on screen, so what an approver reviews is what the host
     * installs. There is no "update everything", no free-text package field, no
     * removal and no downgrade: the set is drawn from what this host reported
     * and what its own agent allowlists, and nothing else can enter it.
     */
    renderPackageUpdateCard(host) {
      const gate = this._capability('package.update');
      const form = el('form', 'os-op-form');
      form.addEventListener('submit', (event) => event.preventDefault());
      form.appendChild(el('h4', null, 'Update packages'));

      if (!gate.allowed) {
        form.appendChild(el('p', 'os-host-empty',
          `Updating packages is unavailable on this host: ${gate.reason}`));
        return form;
      }

      const { eligible, ineligible, allowlist, truncated } = this._eligibleUpdates(host);
      const selected = [...this._updateSelection.values()].sort(byName);

      form.appendChild(el('p', 'os-host-empty',
        'Upgrades exactly the packages you select, each pinned to the candidate version shown '
        + 'here. It installs nothing else, never removes or downgrades a package, and never '
        + 'reboots this host. ' + this._windowNote(host)));
      form.appendChild(this._secondPersonNotice());

      // What moved underneath the operator between one report and the next.
      if (this._updateDrift.dropped.length) {
        form.appendChild(el('p', 'alert-text',
          'Dropped from your selection because this host no longer offers them: '
          + `${this._updateDrift.dropped.join(', ')}. Your confirmation was withdrawn.`));
      }
      if (this._updateDrift.moved.length) {
        form.appendChild(el('p', 'alert-text',
          'The candidate version changed while you were choosing: '
          + `${this._updateDrift.moved.join(', ')}. Your confirmation was withdrawn; read the new `
          + 'versions before confirming again.'));
      }

      if (!allowlist.length) {
        form.appendChild(el('p', 'alert-text',
          'The agent on this host allowlists no package for updates, so nothing here can be '
          + 'selected. This is not the same as having no updates: the host may well have pending '
          + 'updates that the console is not permitted to name in a request.'));
      }
      if (truncated) {
        form.appendChild(el('p', 'alert-text',
          'This host cut its pending-package list off at the agent bound, so what follows is not '
          + 'the whole set of pending updates.'));
      }

      const freshness = this._updateFreshnessProblem(host);
      if (freshness) form.appendChild(el('p', 'alert-text', freshness));

      if (eligible.length) {
        form.appendChild(field('Eligible packages', this._renderEligibleTable(eligible),
          'Every selected package is named in the request and pinned to its candidate version, so '
          + `an approver reviews the exact set. One request carries at most ${MAX_UPDATE_PACKAGES}.`));
        const security = eligible.filter((entry) => entry.security);
        const picker = el('div', 'os-op-actions');
        picker.appendChild(gatedButton('Select security updates', 'btn btn-sm',
          security.length > 0, 'No eligible package on this host is a security update.',
          () => this._selectPackages(security)));
        picker.appendChild(gatedButton('Select all eligible', 'btn btn-sm',
          true, '', () => this._selectPackages(eligible)));
        picker.appendChild(gatedButton('Clear selection', 'btn btn-sm btn-link',
          selected.length > 0, 'Nothing is selected.',
          () => this._mutateSelection(() => this._updateSelection.clear())));
        form.appendChild(picker);
      } else {
        form.appendChild(el('p', 'os-host-empty',
          'No package on this host is both allowlisted by its own agent and currently pending '
          + 'with a candidate version to pin a request to.'));
      }

      // A package that is pending but cannot be requested is listed with the
      // reason. Omitting it would be indistinguishable from it having no update.
      if (ineligible.length) {
        form.appendChild(el('h4', null, 'Pending but not selectable'));
        form.appendChild(table(
          ['Package', 'Security', 'Why it cannot be requested'],
          ineligible.map((entry) => [
            entry.name || 'unnamed',
            entry.security ? 'security' : 'no',
            entry.reason,
          ]),
          'Every pending package on this host is selectable.'));
      }

      form.appendChild(el('h4', null, 'Review this request'));
      form.appendChild(table(
        ['Package', 'Installed now', 'Will install'],
        selected.map((entry) => [
          entry.name,
          text(entry.currentVersion, 'not installed'),
          entry.candidateVersion,
        ]),
        'No package is selected, so there is nothing to request yet.'));

      // securityOnly is a claim the agent re-checks against each package's
      // origin and refuses the whole request over. It is therefore offered only
      // when the selection can actually support it, never as a stated intent
      // that the selection contradicts.
      const allSecurity = selected.length > 0 && selected.every((entry) => entry.security);
      const securityBox = input('checkbox', '', {});
      securityBox.checked = allSecurity && this._updateSecurityOnly === true;
      if (allSecurity) {
        securityBox.addEventListener('change', () => {
          this._updateSecurityOnly = securityBox.checked === true;
        });
      } else {
        securityBox.disabled = true;
        securityBox.setAttribute('aria-disabled', 'true');
      }
      form.appendChild(field('Security updates only', securityBox, allSecurity
        ? 'Declares that this request carries only security updates. The agent re-checks every '
          + 'package against the security origin and refuses the whole request if one is not.'
        : (selected.length
          ? 'Unavailable: a selected package is not a security update, and the agent would refuse '
            + 'a request that claimed otherwise.'
          : 'Unavailable until packages are selected.')));

      const reason = input('text', this._updateReason,
        { placeholder: 'why this update is needed', maxlength: String(MAX_REASON) });
      reason.addEventListener('change', () => { this._updateReason = reason.value; });
      form.appendChild(field('Reason', reason,
        `At least ${MIN_REASON} characters. Recorded in the audit trail and read by the approver.`));
      const emergency = this._emergencyControl(host, form, '_updateEmergency');

      const confirm = input('checkbox', '', {});
      confirm.checked = this._updateConfirmed === true;
      confirm.addEventListener('change', () => { this._updateConfirmed = confirm.checked === true; });
      form.appendChild(field('I have reviewed the exact packages and versions above', confirm,
        'Changing the selection, or this host reporting a different candidate version, withdraws '
        + 'this confirmation.'));

      const blocked = freshness || this._packageContentionReason()
        || (eligible.length ? '' : 'No package on this host is selectable for an update.');
      if (blocked) form.appendChild(el('p', 'os-host-empty', blocked));
      const actions = el('div', 'os-op-actions');
      actions.appendChild(gatedButton('Request package update', 'btn btn-sm', !blocked, blocked,
        () => {
          this._updateReason = reason.value;
          const chosen = [...this._updateSelection.values()].sort(byName);
          if (!chosen.length) {
            this._refuseSubmit('Select at least one package to update.');
            return;
          }
          if (chosen.length > MAX_UPDATE_PACKAGES) {
            this._refuseSubmit(`One request carries at most ${MAX_UPDATE_PACKAGES} packages; `
              + `${chosen.length} are selected.`);
            return;
          }
          const problem = reasonProblem(this._updateReason);
          if (problem) {
            this._refuseSubmit(problem);
            return;
          }
          if (this._updateConfirmed !== true) {
            this._refuseSubmit('Confirm that you have reviewed the exact packages and versions '
              + 'above before requesting this update.');
            return;
          }
          void this.submitOperation('package.update', {
            manager: SUPPORTED_PACKAGE_MANAGER,
            packages: chosen.map((entry) => ({ name: entry.name, version: entry.candidateVersion })),
            securityOnly: chosen.every((entry) => entry.security) && this._updateSecurityOnly === true,
          }, this._updateReason.trim(), { emergency: emergency.checked })
            .then((accepted) => { if (accepted) this._clearUpdateRequest(); });
        }));
      form.appendChild(actions);
      return form;
    }

    /**
     * Install a newer kernel. This never reboots the host.
     *
     * Kept separate from the package set on purpose. The difference that
     * matters to an operator is not the risk label: it is that the kernel it
     * installs does not start running until a host.reboot is separately
     * requested and separately approved, and that one carries the Kubernetes
     * cordon and drain checks this one does not.
     */
    renderKernelCard(host) {
      const gate = this._capability('kernel.update');
      const form = el('form', 'os-op-form');
      form.addEventListener('submit', (event) => event.preventDefault());
      form.appendChild(el('h4', null, 'Update the kernel'));

      if (!gate.allowed) {
        form.appendChild(el('p', 'os-host-empty',
          `Updating the kernel is unavailable on this host: ${gate.reason}`));
        return form;
      }

      const kernel = host.kernel || {};
      const candidate = String(kernel.candidate || '');
      // Without a release this console recognises there is nothing to pin the
      // request to, and an unpinned kernel request installs whatever the mirror
      // offers at execution time rather than what was approved.
      const bindable = KERNEL_RELEASE_RE.test(candidate);

      form.appendChild(el('p', 'os-host-empty',
        'Installs a kernel image on this host. It never reboots the host. The running kernel is '
        + `still ${text(kernel.running, 'the one booted now')} when this finishes, and it changes `
        + 'only when a host.reboot operation is separately requested and approved, which carries '
        + 'its own Kubernetes cordon and drain checks. ' + this._windowNote(host)));
      form.appendChild(this._secondPersonNotice());

      form.appendChild(field('Target release', el('p', null, bindable ? candidate : 'none offered'),
        bindable
          ? 'Reported as available by this host. The request is pinned to it, so an approver reads '
            + 'the exact release before it is installed.'
          : 'This host reports no usable candidate kernel, so there is nothing to pin a request to '
            + 'and no kernel update can be requested from here.'));

      const reason = input('text', this._kernelReason,
        { placeholder: 'why this kernel update is needed', maxlength: String(MAX_REASON) });
      reason.addEventListener('change', () => { this._kernelReason = reason.value; });
      form.appendChild(field('Reason', reason,
        `At least ${MIN_REASON} characters. Recorded in the audit trail and read by the approver.`));
      const emergency = this._emergencyControl(host, form, '_kernelEmergency');

      const confirm = input('checkbox', '', {});
      confirm.checked = this._kernelConfirmed === true;
      confirm.addEventListener('change', () => { this._kernelConfirmed = confirm.checked === true; });
      form.appendChild(field('I have reviewed the target release above', confirm,
        'This installs a kernel image. It does not reboot this host and does not change the '
        + 'kernel that is running.'));

      const blocked = this._updateFreshnessProblem(host)
        || this._packageContentionReason()
        || (bindable ? '' : 'This host reports no candidate kernel to request.');
      if (blocked) form.appendChild(el('p', 'alert-text', blocked));
      const actions = el('div', 'os-op-actions');
      actions.appendChild(gatedButton('Request kernel update', 'btn btn-sm btn-danger-outline',
        !blocked, blocked,
        () => {
          this._kernelReason = reason.value;
          const problem = reasonProblem(this._kernelReason);
          if (problem) {
            this._refuseSubmit(problem);
            return;
          }
          if (this._kernelConfirmed !== true) {
            this._refuseSubmit('Confirm that you have reviewed the target release before '
              + 'requesting this kernel update.');
            return;
          }
          void this.submitOperation('kernel.update',
            { manager: SUPPORTED_PACKAGE_MANAGER, targetRelease: candidate },
            this._kernelReason.trim(), { emergency: emergency.checked })
            .then((accepted) => {
              if (!accepted) return;
              this._kernelReason = '';
              this._kernelConfirmed = false;
              this.render();
            });
        }));
      form.appendChild(actions);
      return form;
    }

    /**
     * What this page has asked of the host, and where each request got to.
     *
     * This is the half of the workflow that keeps an operator off SSH. A
     * request that disappears after submission is indistinguishable from one
     * that was never accepted, so every package and kernel request for this
     * host is listed here with its state, and opening one shows its full audit
     * trail in place rather than on another tab.
     */
    renderUpdateActivity(host) {
      const container = el('div');
      container.appendChild(el('h4', null, 'Update requests for this host'));

      if (this._operationError === 'not-installed') {
        const alert = el('div', 'alert alert-warning');
        const item = el('div', 'alert-item static');
        item.appendChild(el('span', 'alert-text',
          'Governed host operations are not installed on this control center, so no request '
          + 'history can be shown here. This is not an empty history.'));
        alert.appendChild(item);
        container.appendChild(alert);
        return container;
      }

      const history = this._operations
        .filter((entry) => PACKAGE_OPERATIONS.includes(entry?.operation));
      if (!history.length) {
        container.appendChild(el('p', 'os-host-empty',
          'No package or kernel request has been made for this host.'));
        return container;
      }

      const wrapper = el('div', 'table-wrapper');
      const t = el('table', 'table table-compact');
      const thead = el('thead');
      const headRow = el('tr');
      for (const header of ['Request', 'State', 'Approval', 'Requested', 'Result', '']) {
        headRow.appendChild(el('th', null, header));
      }
      thead.appendChild(headRow);
      t.appendChild(thead);
      const tbody = el('tbody');
      for (const entry of history) {
        const row = el('tr');
        row.appendChild(el('td', null, entry.operation));
        const stateCell = el('td');
        stateCell.appendChild(badge(OPERATION_STATE_LABEL, entry.status));
        row.appendChild(stateCell);
        row.appendChild(el('td', null, this._approvalNote(entry)));
        row.appendChild(el('td', null, text(entry.createdAt)));
        row.appendChild(el('td', null, entry.result
          ? `${text(entry.result.outcome)}: ${text(entry.result.message, 'no message')}`
          : (TERMINAL_OPERATION_STATES.has(entry.status) ? 'no result was reported' : 'not run yet')));
        const actions = el('td');
        const open = el('button', 'btn btn-sm btn-link', 'Details');
        open.type = 'button';
        open.addEventListener('click', () => void this.openOperation(entry.id));
        actions.appendChild(open);
        row.appendChild(actions);
        tbody.appendChild(row);
      }
      t.appendChild(tbody);
      wrapper.appendChild(t);
      container.appendChild(wrapper);

      if (this._operationDetail) {
        const shown = this._operationDetail.operation?.operation;
        // The detail panel is shared with the Operations tab. Opening a request
        // from here reveals it here; a request opened elsewhere is not silently
        // re-rendered under a heading that says these are update requests.
        if (PACKAGE_OPERATIONS.includes(shown)) container.appendChild(this.renderOperationDetail());
      }
      return container;
    }

    /**
     * Who still has to act on a request, in the words that matter to the reader.
     *
     * "Awaiting approval" does not say that the person reading it is not
     * allowed to be that approver, and that is exactly the thing they need to
     * know before they wait for a page that will never enable a button.
     */
    _approvalNote(entry) {
      if (!['requested', 'awaiting_approval'].includes(entry.status)) {
        if (entry.approvedBy) return 'approved by a second person';
        return entry.requiresSecondPerson === true ? 'needed a second person' : 'single person';
      }
      if (entry.requiresSecondPerson !== true) return 'accepted from one administrator';
      return entry.viewer?.isRequester === true
        ? 'waiting for a different administrator; you requested it'
        : 'waiting for a different administrator than the requester';
    }

    /** The maintenance rules that govern acting on any of the above. */
    renderPolicySummary(host) {
      const wrapper = el('div');
      wrapper.appendChild(el('h4', null, 'Maintenance policy'));
      const policy = host.policy;
      if (!policy) {
        wrapper.appendChild(el('p', 'os-host-empty',
          'This host has no maintenance policy, so package and kernel work is refused. '
          + 'That is the default: a host nobody has written rules for is not a host anything '
          + 'may happen to.'));
        return wrapper;
      }

      wrapper.appendChild(table(
        ['Policy', 'Scope', 'Version', 'Timezone', 'Window open now'],
        [[
          text(policy.name),
          text(policy.scope),
          text(policy.version),
          text(policy.timezone),
          policy.inWindow ? `yes, until ${text(policy.windowEndsAt, 'unknown')}` : 'no',
        ]],
        'No policy detail was returned.'));

      const permitted = Array.isArray(policy.allowedOperations) ? policy.allowedOperations : [];
      wrapper.appendChild(el('p', 'os-host-empty', permitted.length
        ? `Permitted inside a window: ${permitted.join(', ')}.`
        : 'This policy permits no maintenance operations.'));

      const windows = Array.isArray(policy.windows) ? policy.windows.filter((w) => w.enabled) : [];
      if (windows.length) {
        wrapper.appendChild(table(
          ['Day', 'Starts', 'Duration'],
          windows.map((entry) => [
            DAY_NAMES[entry.dayOfWeek] || String(entry.dayOfWeek),
            text(entry.startTime),
            `${entry.durationMinutes} min`,
          ]),
          'No windows are defined.'));
        wrapper.appendChild(el('p', 'os-host-empty',
          `Times are local to ${text(policy.timezone)} and follow that zone across daylight-saving `
          + 'changes, so a 02:00 window stays at 02:00 all year.'));
      } else {
        wrapper.appendChild(el('p', 'os-host-empty',
          'This policy defines no enabled windows, so nothing may run outside an emergency.'));
      }
      if (policy.emergencyAllowed) {
        wrapper.appendChild(el('p', 'os-host-empty',
          'Emergency requests may run outside a window. They still require the same approval, '
          + 'the same second person and the same assurance level as any other high-risk work.'));
      }
      return wrapper;
    }
  };
}

let styleNode = null;

export function activate(ctx) {
  if (!ctx?.api?.fetch) throw new Error('linux-host-manager requires the api:proxy capability');
  if (!ctx?.extensions?.registerPage) throw new Error('linux-host-manager requires the page:register capability');

  if (!customElements.get(ELEMENT_TAG)) {
    customElements.define(ELEMENT_TAG, createElementClass(ctx));
  }
  if (!styleNode) {
    styleNode = document.createElement('style');
    styleNode.dataset.opensphereSubshell = PLUGIN_ID;
    styleNode.textContent = styleText();
    document.head.appendChild(styleNode);
  }

  ctx.extensions.registerPage({
    id: PLUGIN_ID,
    title: 'Linux 호스트',
    navBand: '운영',
    elementTag: ELEMENT_TAG,
  });
}

export function deactivate() {
  // A custom element definition cannot be withdrawn, so stop the work instead:
  // any element still mounted would otherwise keep polling after teardown.
  for (const node of document.querySelectorAll(ELEMENT_TAG)) {
    node.disconnectedCallback?.();
    node.remove();
  }
  if (styleNode?.parentNode) styleNode.parentNode.removeChild(styleNode);
  styleNode = null;
}

'use strict';

/**
 * Contract test for the checked-in `linux-host-manager` subShell package.
 *
 * The package is the only sanctioned execution surface for Linux host control.
 * If it drifts out of the DUPA contract the shell silently refuses to load it
 * and the `/cc/:ccId/hosts` alias degrades to "not registered", so every rule
 * the loader enforces at runtime is asserted here against the real files.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { moduleDescriptorIssues } = require('./controller');

const PACKAGE_DIR = path.join(__dirname, '..', '..', 'deploy', 'rcc', 'subshells', 'linux-host-manager');
const readText = (name) => fs.readFileSync(path.join(PACKAGE_DIR, name), 'utf8');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const descriptorText = readText('package.descriptor.json');
const manifestText = readText('ui-shell.manifest.json');
const descriptor = JSON.parse(descriptorText);
const manifest = JSON.parse(manifestText);
const entryText = readText(manifest.entry);

test('descriptor satisfies the DUPA module contract', () => {
  assert.deepEqual(moduleDescriptorIssues(descriptor), []);
  assert.equal(descriptor.id, 'linux-host-manager');
  assert.equal(descriptor.kind, 'subShell');
});

test('subShell is anchored to the Main Shell and stays child-plugin ready', () => {
  assert.equal(descriptor.hostRef, 'main');
  assert.equal(manifest.hostRef, 'main');
  // A child plugin declares hostRef: 'linux-host-manager'; the loader only
  // permits that when this module is itself a registered subShell.
  assert.equal(manifest.kind, 'subShell');
  assert.ok(manifest.hostApiVersion, 'subShell manifests must publish hostApiVersion');
});

test('manifest and descriptor agree on every field the control plane cross-checks', () => {
  for (const key of ['id', 'kind', 'hostRef', 'hostCompat', 'hostApiVersion', 'shellCompat']) {
    assert.equal(manifest[key], descriptor[key], `${key} drifted between manifest and descriptor`);
  }
  assert.deepEqual([...manifest.permissions].sort(), [...descriptor.permissions].sort());
  assert.equal(manifest.apiBase, descriptor.api.basePath);
  assert.deepEqual(manifest.contributions, descriptor.contributions);
});

test('entry digest matches the checked-in bundle bytes', () => {
  assert.equal(sha256(entryText), manifest.entrySha256);
  assert.equal(sha256(manifestText), descriptor.manifest.sha256);
  assert.match(manifest.entry, /^[A-Za-z0-9._-]+\.js$/, 'entry must be a bare .js filename');
});

test('api base stays inside the canonical plugin namespace', () => {
  assert.equal(manifest.apiBase, '/api/plugins/linux-host-manager');
  // A relative fetch resolves under apiBase; an absolute /api/control-centers
  // path would be rewritten by the shell rather than escaping the namespace.
  assert.ok(!/ctx\.api\.fetch\(\s*[`'"]\//.test(entryText), 'entry must not fetch absolute paths');
});

test('declares no write or privileged capability in Stage 1', () => {
  const forbidden = ['storage:write', 'notify:publish', 'nav:contribute', 'search:contribute', 'manual:contribute'];
  for (const capability of forbidden) {
    assert.ok(!manifest.permissions.includes(capability), `${capability} must not be requested`);
    assert.ok(!descriptor.permissions.includes(capability), `${capability} must not be requested`);
  }
  assert.equal(descriptor.permissionProfile, 'none', 'host reporting needs no Kubernetes permission profile');
});

test('every disabled contribution states a reason', () => {
  for (const [name, contribution] of Object.entries(manifest.contributions)) {
    if (contribution.enabled === false) {
      assert.ok(String(contribution.reason || '').trim(), `${name} must explain why it is disabled`);
    }
  }
});

test('entry bundle is self-contained and uses no unsafe DOM or eval sink', () => {
  assert.ok(!/^\s*import\s/m.test(entryText), 'entry must have no import statements (Blob URL import)');
  assert.ok(!/require\s*\(/.test(entryText), 'entry must not use CommonJS require');
  assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/.test(entryText), 'entry must not write raw HTML');
  assert.ok(!/\beval\s*\(|new\s+Function\s*\(/.test(entryText), 'entry must not evaluate strings');
  assert.ok(/export\s+function\s+activate/.test(entryText), 'activate() export is required');
  assert.ok(/export\s+function\s+deactivate/.test(entryText), 'manifestVersion 3 requires deactivate()');
});

test('entry refreshes on an interval and tears the timer down on disconnect', () => {
  assert.match(entryText, /const REFRESH_INTERVAL_MS = 60_000;/);
  assert.match(entryText, /setInterval\(/);
  assert.match(entryText, /clearInterval\(/);
  // Reattaching the same element must not leave it permanently frozen.
  assert.match(entryText, /connectedCallback\(\)\s*\{[\s\S]*?this\._disposed = false;/);
  assert.match(entryText, /disconnectedCallback\(\)\s*\{[\s\S]*?this\._disposed = true;[\s\S]*?_stopPolling\(\)/);
  // deactivate() must stop elements that are still mounted, or polling outlives teardown.
  assert.match(entryText, /export function deactivate\(\)[\s\S]*?disconnectedCallback\?\.\(\)/);
});

test('entry discards responses from superseded loads', () => {
  assert.match(entryText, /_isStale\(generation\)/);
  assert.match(entryText, /this\._generation \+= 1;/);
  // Every await of a network result is followed by a staleness check.
  const awaits = entryText.split('\n').filter((line) => /await this\._get\(/.test(line));
  assert.ok(awaits.length >= 2, 'expected both list and detail fetches');
});

test('entry carries no credential material', () => {
  assert.ok(!/agent_key|agentKey|hmac|secret|Bearer\s+[A-Za-z0-9]/i.test(entryText),
    'the UI never sees agent key material');
});

test('every section including Stage 2 operations is present', () => {
  for (const section of ['overview', 'services', 'journal', 'network', 'storage', 'updates', 'operations']) {
    assert.ok(entryText.includes(`id: '${section}'`), `${section} section must be present in the navigation`);
  }
  // Sections the backend reports as unsupported must draw the explicit notice
  // rather than an empty pane that reads as "nothing to report".
  assert.ok(/capability\.supported === false/.test(entryText));
  assert.ok(/unavailableNotice\(/.test(entryText));
});

test('Stage 2 mutations use POST only, and never a mutating verb elsewhere', () => {
  // Operations are requested and decided with POST. There must be no PUT,
  // PATCH or DELETE anywhere: the UI never edits or removes server state.
  assert.ok(/method: 'POST'/.test(entryText), 'operation requests use POST');
  assert.ok(!/'(PUT|PATCH|DELETE)'|"(PUT|PATCH|DELETE)"/.test(entryText),
    'the UI must never issue PUT, PATCH or DELETE');
});

test('the UI exposes no terminal and no free-form command field', () => {
  // The whole point of typed operations is that there is no arbitrary command
  // surface. A text input bound to a command would defeat it entirely.
  for (const forbidden of [
    /xterm/i,
    /novnc/i,
    /\bterminal\b/i,
    /\/bin\/(sh|bash)/,
    /command\s*[:=]\s*['"`]/i,
    /websocket/i,          // a shell would need a stream
    /EventSource/,
  ]) {
    assert.ok(!forbidden.test(entryText), `UI must not contain ${forbidden}`);
  }
  // No input element may be bound to anything resembling a command.
  assert.ok(!/input\([^)]*['"]command['"]/.test(entryText), 'no command input may exist');
  // Every operation the UI can submit must exist in the deployed catalog.
  // Comparing against the catalog rather than a list written here means a new
  // operation is checked automatically, and an invented one fails.
  const baseline = fs.readFileSync(path.join(PACKAGE_DIR, '..', '..', 'supabase-baseline.sql'), 'utf8');
  const catalog = new Set();
  for (const block of baseline.matchAll(
    /INSERT INTO console\.host_operation_type[\s\S]*?VALUES([\s\S]*?)ON CONFLICT/g)) {
    for (const row of block[1].matchAll(/\('([a-z]+(?:\.[a-z]+)+)',/g)) catalog.add(row[1]);
  }
  // Call sites only: the method's own definition names its parameters.
  const callSites = [...entryText.matchAll(/this\.submitOperation\(([^,]+),/g)].map((m) => m[1].trim());
  assert.ok(callSites.length > 0, 'the UI must submit something');
  for (const argument of callSites) {
    // A computed operation name would be a way to ask for something nobody
    // declared, so every call site must pass a string literal.
    assert.match(argument, /^'[a-z]+(?:\.[a-z]+)+'$/,
      `the operation name must be a literal, found ${argument}`);
    const operation = argument.slice(1, -1);
    assert.ok(catalog.has(operation),
      `the UI submits ${operation}, which is not in the operation catalog`);
  }
});

test('every Stage 2 control is capability and permission gated', () => {
  assert.ok(/_capability\(/.test(entryText), 'controls must consult the capability map');
  assert.ok(/gatedButton\(/.test(entryText), 'controls must be rendered through the gate helper');
  // A gated control is disabled with a reason rather than hidden, so an
  // operator can see why it is unavailable.
  assert.ok(/button\.disabled = true/.test(entryText));
  assert.ok(/button\.title = reason/.test(entryText));
  for (const control of ['journal.query', 'service.restart', 'host.reboot', 'approve']) {
    assert.ok(entryText.includes(`_capability('${control}')`), `${control} must be gated`);
  }
});

test('remote text is rendered safely', () => {
  // Journal output is attacker-influenced; it must reach the DOM as text.
  assert.ok(/pre\.textContent = String/.test(entryText), 'output must use textContent');
  assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/.test(entryText));
});

test('the operations view keeps mobile behaviour', () => {
  assert.ok(/@media \(max-width: 48rem\)/.test(entryText));
  assert.ok(/os-op-actions button \{ flex/.test(entryText), 'action buttons must wrap on small screens');
});

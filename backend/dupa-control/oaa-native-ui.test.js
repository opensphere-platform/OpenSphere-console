const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Focused static contract: the OAA (OpenSphere AI Agent) global chat panel is a Console-native
// shell surface — not a route, plugin, subShell, or Registry entry. It is toggled from the
// header alongside Manual and notifications, calls only the same-origin /api/oaa/chat endpoint
// using the AuthService bearer token already used elsewhere in the shell, never stores/displays
// API key material, renders answer/source/concept text safely (no innerHTML), and never offers a
// direct UI path to execute Kubernetes mutations (suggested actions are proposals only).

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('os-oaa-agent.ts exists as a native shell component (not a routed page)', () => {
  const agent = read('src', 'app', 'os', 'os-oaa-agent.ts');

  assert.match(agent, /selector:\s*'os-oaa-agent'/);
  assert.match(agent, /export class OsOaaAgent/);

  const routes = read('src', 'app', 'app.routes.ts');
  assert.doesNotMatch(routes, /os-oaa-agent/i);
  assert.doesNotMatch(routes, /OsOaaAgent/);
});

test('os-shell.ts wires os-oaa-agent into the header next to Manual and notifications', () => {
  const shell = read('src', 'app', 'os', 'os-shell.ts');

  assert.match(shell, /import\s*\{\s*OsOaaAgent\s*\}\s*from\s*'\.\/os-oaa-agent'/);
  assert.match(shell, /imports:\s*\[[^\]]*OsOaaAgent[^\]]*\]/);
  assert.match(shell, /<os-oaa-agent\s*\/>/);
  // Same header-actions block as Manual/notifications — a single occurrence, immediately between
  // the /manual header link and <os-notifications />, not a separate nav item.
  assert.match(shell, /routerLink="\/manual"[\s\S]{0,200}<os-oaa-agent \/>[\s\S]{0,80}<os-notifications \/>/);
  const tagOccurrences = shell.match(/<os-oaa-agent\s*\/>/g) || [];
  assert.equal(tagOccurrences.length, 1);
  // Never rendered inside the dynamically-registered plugin nav tree (os-nav-node loop).
  const navNodeBlock = shell.match(/@for \(node of treesForBand[\s\S]*?<\/os-nav-node>|<os-nav-node[\s\S]{0,40}\/>/)?.[0] || '';
  assert.doesNotMatch(navNodeBlock, /os-oaa-agent/);
});

test('os-oaa-agent.ts calls only the same-origin /api/oaa/chat endpoint with the shared AuthService bearer token', () => {
  const agent = read('src', 'app', 'os', 'os-oaa-agent.ts');
  const auth = read('src', 'app', 'core', 'auth.service.ts');

  assert.match(agent, /import\s*\{\s*AuthService\s*\}\s*from\s*'\.\.\/core\/auth\.service'/);
  assert.match(agent, /private auth = inject\(AuthService\)/);
  assert.match(agent, /fetch\('\/api\/oaa\/chat',/);
  assert.match(agent, /authorization:\s*'Bearer '\s*\+\s*\(this\.auth\.token\(\)\s*\|\|\s*''\)/);
  // Only one fetch()/network call site in the whole component — the chat endpoint.
  const fetchCalls = agent.match(/fetch\(/g) || [];
  assert.equal(fetchCalls.length, 1);
  assert.doesNotMatch(agent, /https?:\/\//);
  assert.match(auth, /token\(\):\s*string/);
});

test('os-oaa-agent.ts never stores or displays raw API key material', () => {
  const agent = read('src', 'app', 'os', 'os-oaa-agent.ts');

  assert.doesNotMatch(agent, /api[_-]?key/i);
  assert.doesNotMatch(agent, /type="password"/);
  assert.doesNotMatch(agent, /apiKey/);
  // Storage boundary: chat transcripts (sessions/messages) live only in sessionStorage under a
  // single fixed key — current tab only, never persisted to localStorage. localStorage is limited
  // to the non-sensitive dock-width UI preference only, and never holds credential material.
  assert.match(agent, /storageKey\s*=\s*'opensphere\.oaa\.sessions'/);
  assert.match(agent, /window\.sessionStorage\.getItem\(this\.storageKey\)/);
  assert.match(agent, /window\.sessionStorage\.setItem\(this\.storageKey,/);
  const localStorageUses = agent.match(/localStorage\.(?:get|set)Item\('([^']+)'/g) || [];
  assert.ok(localStorageUses.length > 0);
  for (const use of localStorageUses) {
    assert.match(use, /'opensphere\.oaa\.dockWidth'/);
    assert.doesNotMatch(use, /key|token|secret|credential/i);
  }
  // No other localStorage key besides the dock-width preference is ever used.
  assert.doesNotMatch(agent, /localStorage\.(?:get|set)Item\('(?!opensphere\.oaa\.dockWidth')/);
  // Chat sessions must never leak into localStorage under any key.
  assert.doesNotMatch(agent, /localStorage\.(?:get|set)Item\('opensphere\.oaa\.sessions'/);
});

test('os-oaa-agent.ts renders message/source/concept content as safe text (no innerHTML)', () => {
  const agent = read('src', 'app', 'os', 'os-oaa-agent.ts');

  assert.doesNotMatch(agent, /\[innerHTML\]|\.innerHTML\s*=|bypassSecurityTrustHtml/);
  assert.match(agent, /\{\{\s*m\.content\s*\}\}/);
  assert.match(agent, /\{\{\s*s\.title\s*\}\}/);
  assert.match(agent, /\{\{\s*c\.name\s*\}\}/);
});

test('os-oaa-agent.ts surfaces Degraded/error state with retry-by-resend, new chat, and history controls', () => {
  const agent = read('src', 'app', 'os', 'os-oaa-agent.ts');

  assert.match(agent, /readonly error = signal\(''\)/);
  assert.match(agent, /@if \(error\(\)\) \{/);
  assert.match(agent, /this\.error\.set\(body\.error \|\| `OAA request failed \(HTTP \$\{r\.status\}\)`\)/);
  assert.match(agent, /newChat\(\):\s*void/);
  assert.match(agent, /toggleHistory\(\):\s*void/);
  assert.match(agent, /loadSession\(s: OaaSession\):\s*void/);
});

test('os-oaa-agent.ts exposes accessible open/close controls and dock resize + full workspace toggle', () => {
  const agent = read('src', 'app', 'os', 'os-oaa-agent.ts');

  assert.match(agent, /aria-label="OpenSphere AI Agent"/);
  assert.match(agent, /\(click\)="close\(\)" title="Close" aria-label="Close"/);
  assert.match(agent, /startResize\(ev: PointerEvent\)/);
  assert.match(agent, /resetDockWidth\(\)/);
  assert.match(agent, /toggleFull\(\):\s*void/);
  assert.match(agent, /Expand to workspace/);
});

test('os-oaa-agent.ts never offers a direct UI path to execute Kubernetes mutations — suggested actions are proposals only', () => {
  const agent = read('src', 'app', 'os', 'os-oaa-agent.ts');

  assert.match(agent, /interface OaaSuggestedAction/);
  assert.match(agent, /useSuggestedAction\(action: OaaSuggestedAction\):\s*void\s*\{/);
  // Using a suggested action only fills the compose draft — it never calls fetch()/exec/apply itself.
  const useFn = agent.match(/useSuggestedAction\(action: OaaSuggestedAction\): void \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(useFn, /this\.draft = action\.command/);
  assert.doesNotMatch(useFn, /fetch\(|kubectl|apply\(|exec\(/);
  assert.doesNotMatch(agent, /\/api\/oaa\/actions\//);
  assert.doesNotMatch(agent, /\/api\/oaa\/tools\//);
});

test('os-oaa-agent is absent from Extension Host / DUPA plugin nav registration paths', () => {
  const extensionHost = read('src', 'app', 'core', 'extension-host.service.ts');
  const controller = read('backend', 'dupa-control', 'controller.js');

  assert.doesNotMatch(extensionHost, /os-oaa-agent/i);
  assert.doesNotMatch(controller, /os-oaa-agent/i);
});

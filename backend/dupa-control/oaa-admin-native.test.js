const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Static contract: /manage/oaa is a Console-native OAA (OpenSphere AI Agent) Gateway administration
// surface (CONSTITUTION-0004 §4.2/§4.4). OAA Core is a Main Shell native capability; the OAA Gateway
// is a separate CBS-consumer server workload. This page owns Gateway health/readiness, LLM provider
// key custody (never raw key material), Knowledge/Manual Registry stats + bundled manual seed +
// re-embed, and read-only Tool Registry / Action Binding inspection with a locally-gated mutation
// executor. It must never be re-absorbed into admin-backbone.ts.

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('admin-oaa.ts exists as a standalone Angular component reusing shell-native UI', () => {
  const page = read('src', 'app', 'pages', 'admin-oaa.ts');

  assert.match(page, /selector:\s*'os-admin-oaa'/);
  assert.match(page, /export class AdminOaa/);
  assert.match(page, /imports:\s*\[[^\]]*ClarityModule[^\]]*OsPageHeader[^\]]*\]/s);
  assert.match(page, /import\s*\{\s*BackendUnavailable\s*\}\s*from\s*'\.\.\/os\/backend-unavailable'/);
  assert.match(page, /import\s*\{\s*OsPageHeader\s*\}\s*from\s*'\.\.\/os\/os-page-header'/);
  assert.match(page, /<os-page-header/);
  assert.match(page, /<os-backend-unavailable/);
  assert.match(page, /<clr-alert/);
  assert.match(page, /<clr-datagrid/);
});

test('/manage/oaa is a registered authenticated child route, separate from admin-backbone.ts', () => {
  const routes = read('src', 'app', 'app.routes.ts');
  const adminBackbone = read('src', 'app', 'pages', 'admin-backbone.ts');

  assert.match(routes, /import\s*\{\s*AdminOaa\s*\}\s*from\s*'\.\/pages\/admin-oaa'/);
  // Nested under the single authenticated 'manage' tree, not a top-level route.
  assert.match(routes, /path:\s*'manage'[\s\S]*path:\s*'oaa',\s*component:\s*AdminOaa[\s\S]*\],\s*\},/);

  // admin-backbone.ts (§8 audit verdict) must never regain OAA/LlmKey/KnowledgeStore content.
  assert.doesNotMatch(adminBackbone, /OAA|oaa|LlmKey|KnowledgeStore/);
});

test('콘솔 관리 tree places OAA Gateway right after Backbone in the 플랫폼 기반 band with an approved Carbon icon', () => {
  const layout = read('src', 'app', 'pages', 'admin-layout.ts');

  assert.match(layout, /import\s+ChatBot16\s+from\s+'@carbon\/icons\/es\/chat-bot\/16'/);
  const band = layout.match(/label:\s*'플랫폼 기반',\s*items:\s*\[([\s\S]*?)\],\s*\},/)?.[1] || '';
  assert.match(band, /label:\s*'Backbone',\s*route:\s*'\/manage\/backbone'/);
  assert.match(band, /label:\s*'OAA Gateway',\s*route:\s*'\/manage\/oaa',\s*icon:\s*ChatBot16/);
  // Backbone must be immediately followed by OAA Gateway (before Observability).
  assert.match(
    band,
    /route:\s*'\/manage\/backbone'[\s\S]*?route:\s*'\/manage\/oaa'[\s\S]*?route:\s*'\/manage\/observability'/,
  );

  const carbonIconPkg = path.join(root, 'node_modules', '@carbon', 'icons', 'es', 'chat-bot', '16.js');
  assert.ok(fs.existsSync(carbonIconPkg), 'chat-bot/16 must be a real published Carbon icon module');
});

test('search.service.ts indexes /manage/oaa for console search', () => {
  const search = read('src', 'app', 'core', 'search.service.ts');
  assert.match(search, /path:\s*'\/manage\/oaa'/);
});

test('admin-oaa.ts calls only same-origin /api/oaa/* through HttpService (no raw fetch, no cross-origin URLs)', () => {
  const page = read('src', 'app', 'pages', 'admin-oaa.ts');

  assert.match(page, /import\s*\{\s*HttpService\s*\}\s*from\s*'\.\.\/core\/http\.service'/);
  assert.match(page, /private http = inject\(HttpService\)/);
  assert.doesNotMatch(page, /\bfetch\(/);

  // Same-origin enforcement must inspect the actual HttpService request *targets* (the URLs this
  // page asks the shared HttpService to call), not the whole file text — a legitimate LLM provider
  // baseUrl form field placeholder/default (e.g. 'https://api.openai.com/v1', purely local UI state
  // the operator can freely edit, never fetched by this page) must not be misread as a same-origin
  // violation.
  const apiCalls = page.match(/this\.http\.request\(\s*(`[^`]*`|'[^']*')/g) || [];
  assert.ok(apiCalls.length >= 8, 'expected multiple /api/oaa/* call sites');
  for (const call of apiCalls) {
    assert.match(call, /\/api\/oaa\//, `call must target /api/oaa/*: ${call}`);
    assert.doesNotMatch(call, /https?:\/\//, `HttpService request target must be same-origin, not absolute: ${call}`);
  }

  // The only legitimate absolute-URL string literals left in the page are the non-executable LLM
  // provider baseUrl placeholder/default (form UI text), never an HttpService/fetch target.
  const absoluteUrlUses = page.match(/https?:\/\/[^\s'"`]+/g) || [];
  for (const use of absoluteUrlUses) {
    assert.match(use, /^https:\/\/api\.openai\.com\/v1$/, `unexpected absolute URL literal outside the LLM provider baseUrl default/placeholder: ${use}`);
  }
});

test('admin-oaa.ts never persists, logs, or displays raw LLM API key material', () => {
  const page = read('src', 'app', 'pages', 'admin-oaa.ts');

  // No key material ever written to localStorage/sessionStorage.
  assert.doesNotMatch(page, /localStorage\.setItem/);
  assert.doesNotMatch(page, /sessionStorage\.setItem/);
  // No console logging of the form at all (would risk leaking apiKey).
  assert.doesNotMatch(page, /console\.(log|debug|info)\(/);
  // Secret input is masked.
  assert.match(page, /type="password"[\s\S]{0,80}\[\(ngModel\)\]="llmForm\.apiKey"/);
  // The registered-keys datagrid only ever binds fingerprint/displayName/id/provider/model — never apiKey.
  const gridSection = page.match(/LLM Keys[\s\S]*?<\/clr-datagrid>/)?.[0] || '';
  assert.doesNotMatch(gridSection, /apiKey/);
  assert.match(gridSection, /keyFingerprint/);
  // apiKey is cleared unconditionally in the save finally-block (success or failure).
  assert.match(page, /finally\s*\{\s*\/\/[^\n]*\n\s*this\.llmForm = \{ \.\.\.this\.llmForm, apiKey: '' \};/);
  // Closing the create/rotate panel always resets the whole form (including apiKey).
  const closeKeyPanel = page.match(/closeKeyPanel\(\):\s*void\s*\{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(closeKeyPanel, /this\.llmForm = this\.emptyLlmForm\(\)/);
});

test('LLM key create/rotate and delete both require an explicit reason before any request is sent', () => {
  const page = read('src', 'app', 'pages', 'admin-oaa.ts');

  assert.match(page, /!this\.llmForm\.reason\.trim\(\)/);
  assert.match(page, /reasonRequired\]="true"/);
  assert.match(page, /confirmDeleteKey\(reason: string\)/);
});

test('mutation binding execution requires an exact confirmation match and a reason, and never fetches otherwise', () => {
  const page = read('src', 'app', 'pages', 'admin-oaa.ts');

  assert.match(page, /canSubmitExecute\(\):\s*boolean\s*\{/);
  const gate = page.match(/canSubmitExecute\(\): boolean \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(gate, /if \(!this\.execReason\.trim\(\)\) return false;/);
  assert.match(gate, /this\.execConfirm\.trim\(\) !== expected\) return false;/);
  assert.match(gate, /if \(b\.riskLevel !== 'read' && !this\.mutationGateOpen\(\)\) return false;/);

  const executeFn = page.match(/async executeBinding\(\): Promise<void> \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(executeFn, /if \(!b \|\| !this\.canSubmitExecute\(\)\) return;/);
  // The guard must appear strictly before the network call in source order.
  const guardIdx = executeFn.indexOf('!this.canSubmitExecute()');
  const fetchIdx = executeFn.indexOf('this.http.request(');
  assert.ok(guardIdx >= 0 && fetchIdx > guardIdx, 'confirmation/reason gate must precede the fetch call');
  assert.match(executeFn, /\/api\/oaa\/actions\/bindings\/execute/);

  // Execute button in the template is bound to the same gate function (defense in depth beyond the guard clause).
  assert.match(page, /\(click\)="executeBinding\(\)"[\s\S]{0,0}|\[disabled\]="!canSubmitExecute\(\)"/);
});

test('pre-HIS/mutation gate derived from health, tool manifest, and action bindings disables execution UI when false', () => {
  const page = read('src', 'app', 'pages', 'admin-oaa.ts');

  assert.match(page, /readonly mutationGateOpen = computed<boolean>\(/);
  const gateDef = page.match(/readonly mutationGateOpen = computed<boolean>\([\s\S]*?\);/)?.[0] || '';
  assert.match(gateDef, /this\.health\(\)/);
  assert.match(gateDef, /this\.toolManifest\(\)/);
  assert.match(gateDef, /this\.actionBindings\(\)/);
  assert.match(page, /Mutation gate closed/);
});

test('Gateway/health tab surfaces Degraded state without blocking console management', () => {
  const page = read('src', 'app', 'pages', 'admin-oaa.ts');
  assert.match(page, /Degraded:/);
  assert.match(page, /콘솔 관리 기능에는 영향이 없습니다/);
});

test('Knowledge tab exposes stats, bundled manual seed, and re-embed with explicit failure/permission states', () => {
  const page = read('src', 'app', 'pages', 'admin-oaa.ts');
  assert.match(page, /\/api\/oaa\/admin\/knowledge\/stats/);
  assert.match(page, /\/api\/oaa\/admin\/knowledge\/manual-seed\/bundled/);
  assert.match(page, /\/api\/oaa\/admin\/knowledge\/reembed/);
  assert.match(page, /OAA Gateway admin permission is required/);
});

test('Tool Registry and Action Bindings are loaded read-only from the gateway', () => {
  const page = read('src', 'app', 'pages', 'admin-oaa.ts');
  assert.match(page, /\/api\/oaa\/tools\/manifest/);
  assert.match(page, /\/api\/oaa\/tools\/action-bindings/);
});

test('package.json test script runs the OAA admin native contract test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.test, /oaa-admin-native\.test\.js/);
});

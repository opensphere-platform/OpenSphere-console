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

test('OAA desktop dock reserves Main Shell workspace instead of overlaying it', () => {
  const styles = read('src', 'styles.scss');
  const agent = read('src', 'app', 'os', 'os-oaa-agent.ts');

  // The agent owns the fixed right panel, while the global shell stylesheet owns
  // the corresponding workspace reservation.  Testing both sides prevents a
  // future component restore from bringing back only the fixed panel.
  assert.match(agent, /document\.body\.classList\.toggle\('oaa-agent-open', this\.open\(\)\)/);
  assert.match(agent, /position:\s*fixed;\s*top:\s*3rem;\s*right:\s*0/);
  assert.match(styles, /body\.oaa-agent-open\s+\.content-container\s*\{[\s\S]*?margin-right:\s*calc\(var\(--oaa-dock-width, 390px\) \+ var\(--oaa-dock-gap, 8px\)\)/);
  assert.match(styles, /body\.oaa-agent-open\.oaa-agent-full\s+\.content-container\s*\{[\s\S]*?margin-right:\s*0/);
  assert.match(styles, /@media \(max-width:\s*720px\)[\s\S]*?body\.oaa-agent-open\s+\.content-container\s*\{[\s\S]*?margin-right:\s*0/);
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

test('OAA admin uses the Supabase console-admins contract and the shared full-width side-panel workflow', () => {
  const admin = read('src', 'app', 'pages', 'admin-oaa.ts');
  const panel = read('src', 'app', 'os', 'os-panel.ts');
  const styles = read('src', 'styles.scss');

  assert.doesNotMatch(admin, /opensphere-console-admins/);
  assert.match(admin, /OAA Gateway 관리자 역할\(console-admins\)이 필요합니다/);
  assert.match(admin, /class="clr-form-full-width oaa-key-form"/);
  assert.match(admin, /설정 ID <small>\(자동 생성 · API key 아님\)<\/small>/);
  assert.doesNotMatch(admin, /name="oaa-key-id"/);
  assert.match(admin, /id: 'openai-main', provider: 'openai'/);
  assert.match(admin, /\(ngModelChange\)="onLlmProviderChange\(\$event\)"/);
  assert.match(admin, /\[type\]="llmSecretVisible\(\) \? 'text' : 'password'"/);
  assert.match(admin, /autocomplete="new-password"/);
  assert.match(admin, /<div osPanelFooter class="panel-actions">/);
  assert.match(panel, /class="side-panel-footer os-panel-footer"/);
  assert.match(panel, /class="os-panel-content clr-form-full-width"/);
  assert.match(panel, /<ng-content select="\[osPanelFooter\]" \/>/);
  assert.match(styles, /os-panel \.side-panel-body form\.clr-form:not\(\.clr-row\)[\s\S]*max-width: var\(--os-panel-form-max, 48rem\)/);
});

test('OAA API key visibility is explicit, accessible, and resets at every secret boundary', () => {
  const admin = read('src', 'app', 'pages', 'admin-oaa.ts');

  assert.match(admin, /readonly llmSecretVisible = signal\(false\)/);
  assert.match(admin, /aria-label]="llmSecretVisible\(\) \? 'API key 숨기기' : 'API key 표시'"/);
  assert.match(admin, /aria-pressed]="llmSecretVisible\(\)"/);
  assert.match(admin, /class="oaa-secret-input-shell"[\s\S]*?id="oaa-key-secret"[\s\S]*?class="oaa-secret-toggle"/);
  assert.match(admin, /눈동자를 누르면 입력값을 확인할 수 있습니다/);
  assert.match(admin, /\.oaa-secret-toggle \{[^}]*top: 50%[^}]*transform: translateY\(-50%\)/);
  assert.match(admin, /toggleLlmSecretVisibility\(\): void/);
  assert.match(admin, /onLlmProviderChange\(provider: string\): void/);
  assert.match(admin, /onLlmApiKeyChange\(value: string\): void/);
  assert.match(admin, /closeKeyPanel\(\): void \{[\s\S]*?this\.llmSecretVisible\.set\(false\)/);
  assert.match(admin, /finally \{[\s\S]*?this\.llmSecretVisible\.set\(false\)[\s\S]*?apiKey: ''/);
});

test('OAA Admin distinguishes reachable Gateway health from complete Agent readiness', () => {
  const admin = read('src', 'app', 'pages', 'admin-oaa.ts');

  assert.match(admin, /interface AgentControlReadiness/);
  assert.match(admin, /Complete Agent readiness/);
  assert.match(admin, /control\.agentControl\.blockers/);
  assert.match(admin, /missingCapabilities\.observability/);
  assert.match(admin, /missingCapabilities\.hisOwner/);
  assert.match(admin, /missingCapabilities\.cephOwner/);
  assert.match(admin, /\/api\/oaa\/tools\/control-plane\/status/);
  assert.match(admin, /method: 'POST'/);
});

test('OAA credential writes enter the Console Backend policy and audit boundary, never the read-only Gateway mutation path', () => {
  const nginx = read('nginx', 'default.conf.template');
  const backend = read('backend', 'opensphere-console-backend', 'server.js');
  const backendDeploy = read('backend', 'opensphere-console-backend', 'deploy.yaml');
  const gateway = read('backend', 'opensphere-console-oaa-gateway', 'server.js');
  const gatewayDeploy = read('backend', 'opensphere-console-oaa-gateway', 'deploy.yaml');
  const admin = read('src', 'app', 'pages', 'admin-oaa.ts');

  assert.match(nginx, /location \^~ \/api\/oaa\/admin\/llm-keys[\s\S]*opensphere-console-backend/);
  assert.match(backend, /verifyConsoleAdmin\(req\)[\s\S]*upsertOaaKey\(actor, await readBody\(req\)\)/);
  assert.match(backend, /logAudit\(actor, action, input\.id, 'attempt'[\s\S]*k8sRequest\('POST'/);
  assert.match(backend, /management reason must be at least 8 characters/);
  assert.match(backend, /probeOaaProviderCredential\(meta, apiKey\)/);
  assert.match(backend, /oaa-validation-status/);
  assert.match(backend, /auditRecorded = false/);
  assert.match(backend, /error\.code >= 400 && error\.code <= 599/);
  assert.match(backend, /const oaaKeyTestPath[\s\S]*validateStoredOaaKey\(actor, oaaKeyTestPath\[1\]\)/);
  assert.match(admin, /Provider 검증/);
  assert.match(admin, /testLlmKey\(k: LlmKey\): Promise<void>/);
  assert.match(admin, /validationStatus === 'ready'/);
  assert.match(backendDeploy, /opensphere-console-backend-oaa-credentials/);
  assert.match(backendDeploy, /resources: \["secrets"\][\s\S]*"create"[\s\S]*"patch"[\s\S]*"delete"/);
  assert.match(backend, /const OAA_KEY_NAMESPACE = process\.env\.OAA_KEY_NAMESPACE \|\| 'opensphere-oaa-credentials'/);
  assert.match(backend, /namespaces\/\$\{encodeURIComponent\(OAA_KEY_NAMESPACE\)\}\/secrets/);
  assert.match(backendDeploy, /name: OAA_KEY_NAMESPACE, value: opensphere-oaa-credentials/);
  assert.match(backendDeploy, /name: opensphere-console-backend-oaa-credentials, namespace: opensphere-console \}\r?\n+rules: \[\]/);
  assert.match(backendDeploy, /name: opensphere-console-backend-oaa-credentials, namespace: opensphere-oaa-credentials/);
  const gatewayConsoleRole = gatewayDeploy.slice(
    gatewayDeploy.indexOf('kind: Role\nmetadata: { name: opensphere-console-oaa-gateway, namespace: opensphere-console }'),
    gatewayDeploy.indexOf('kind: RoleBinding\nmetadata: { name: opensphere-console-oaa-gateway, namespace: opensphere-console }'),
  );
  assert.doesNotMatch(gatewayConsoleRole, /resources: \[secrets\]/);
  assert.match(gatewayDeploy, /name: opensphere-console-oaa-gateway-credentials, namespace: opensphere-oaa-credentials/);
  assert.match(gatewayDeploy, /name: OAA_KEY_NAMESPACE, value: opensphere-oaa-credentials/);
  assert.match(gateway, /const OAA_KEY_NAMESPACE = process\.env\.OAA_KEY_NAMESPACE \|\| 'opensphere-oaa-credentials'/);
  assert.match(gateway, /namespaces\/\$\{OAA_KEY_NAMESPACE\}\/secrets/);
  assert.match(gateway, /oaa_direct_mutation_removed_use_console_backend/);
  assert.match(admin, /llmForm\.reason\.trim\(\)\.length < 8/);
});

test('OAA chat delegates provider key selection to Gateway instead of hard-coding a stale key id', () => {
  const agent = read('src', 'app', 'os', 'os-oaa-agent.ts');

  assert.doesNotMatch(agent, /keyId:\s*['"]deepseek['"]/);
  assert.match(agent, /messages: payloadMessages,[\s\S]*context: this\.pageContext\(\),[\s\S]*includeEnvironment: this\.includeEnvironment\(\),[\s\S]*source: 'console-oaa-agent',[\s\S]*sessionId: this\.currentId\(\)/);
});

test('OAA provider usage is normalized, persisted to the Supabase ledger, and visible per response and key', () => {
  const agent = read('src', 'app', 'os', 'os-oaa-agent.ts');
  const admin = read('src', 'app', 'pages', 'admin-oaa.ts');
  const gateway = read('backend', 'opensphere-console-oaa-gateway', 'server.js');
  const migration = read('backend', 'supabase', 'migrations', '0012_oaa_llm_usage_ledger.sql');

  assert.match(gateway, /function normalizeProviderUsage\(raw\)/);
  assert.match(gateway, /async function recordLlmUsageEvent\(event\)/);
  assert.match(gateway, /function supportsProviderEmbedding\(key\)/);
  assert.match(gateway, /return key\.provider === 'openai' \|\| key\.provider === 'custom'/);
  assert.match(gateway, /INSERT INTO llm_usage_event/);
  assert.match(gateway, /async function llmUsageDashboard\(days = 30\)/);
  assert.match(gateway, /\/api\/oaa\/admin\/usage/);
  assert.match(gateway, /assertPermission\(actor, 'oaa\.usage\.read'\)/);
  assert.match(gateway, /usageRecorded/);
  assert.match(agent, /interface OaaUsage/);
  assert.match(agent, /LLM 토큰 사용량/);
  assert.match(agent, /Supabase 기록됨/);
  assert.match(admin, /button clrTabLink \(click\)="ensureUsageLoaded\(\)"\>Usage/);
  assert.match(admin, /Key별 사용량/);
  assert.match(admin, /Consumer sources/);
  assert.match(admin, /usageKey\(k\.id\)/);
  assert.match(admin, /사용 빈도/);
  assert.match(admin, /usageGrass/);
  assert.match(admin, /day\.requests/);
  assert.match(admin, /data-level/);
  assert.match(admin, /setUsageRange\(365\)/);
  assert.match(gateway, /\[1, 7, 30, 90, 365\]/);
  assert.match(admin, /deepseek:[\s\S]*embeddingModel: ''/);
  assert.match(migration, /append-only/i);
  assert.doesNotMatch(migration, /prompt(?:_text|_content)?\s+text|response(?:_text|_content)?\s+text|api_key\s+text/i);
});

test('OAA Admin correlates agent evidence and governs retention without a purge control', () => {
  const admin = read('src', 'app', 'pages', 'admin-oaa.ts');
  const gateway = read('backend', 'opensphere-console-oaa-gateway', 'server.js');
  const migration = read('backend', 'supabase', 'migrations', '0019_oaa_evidence_correlation_retention.sql');

  assert.match(admin, /Agent Evidence/);
  assert.match(admin, /Run → retrieval \/ tool \/ provider correlation/);
  assert.match(admin, /보존·Legal hold 정책/);
  assert.match(admin, /expectedRetentionConfirm/);
  assert.match(admin, /\/api\/oaa\/admin\/evidence\/retention/);
  assert.doesNotMatch(admin, />\s*(?:Purge|삭제 실행)\s*</i);
  assert.match(gateway, /deletionPerformed: false/);
  assert.match(migration, /export-before-delete/);
  assert.match(migration, /evidence_policy_event_append_only/);
});

test('OAA composer follows the desktop chat interaction contract', () => {
  const agent = read('src', 'app', 'os', 'os-oaa-agent.ts');

  assert.match(agent, /placeholder="무엇이든 요청하세요"/);
  assert.match(agent, /class="oaa-compose-bar"/);
  assert.match(agent, /class="oaa-context-chip"/);
  assert.match(agent, /class="oaa-model-chip"/);
  assert.match(agent, /title="전송 \(Enter\)"/);
  assert.match(agent, /if \(ev\.isComposing \|\| ev\.key !== 'Enter' \|\| ev\.shiftKey\) return/);
  assert.doesNotMatch(agent, /ev\.ctrlKey \|\| ev\.metaKey/);
  assert.match(agent, /private activeRequest: AbortController \| null = null/);
  assert.match(agent, /stopGeneration\(\): void/);
  assert.match(agent, /toggleVoiceInput\(\): void/);
});

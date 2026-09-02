const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Focused static contract: the OSAA (OpenSphere AI Agent) global chat panel is a Console-native
// shell surface — not a route, plugin, subShell, or Registry entry. It is toggled from the
// header alongside Manual and notifications, calls only the same-origin /api/osaa/chat endpoint
// through the shared HttpService opaque-session/CSRF policy, never stores/displays
// API key material, renders answer/source/concept text safely (no innerHTML), and never offers a
// direct UI path to execute Kubernetes mutations (suggested actions are proposals only).

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('os-osaa-agent.ts exists as a native shell component (not a routed page)', () => {
  const agent = read('apps', 'console-web', 'src', 'app', 'os', 'os-osaa-agent.ts');

  assert.match(agent, /selector:\s*'os-osaa-agent'/);
  assert.match(agent, /export class OsOsaaAgent/);

  const routes = read('apps', 'console-web', 'src', 'app', 'app.routes.ts');
  assert.doesNotMatch(routes, /os-osaa-agent/i);
  assert.doesNotMatch(routes, /OsOsaaAgent/);
});

test('os-shell.ts wires os-osaa-agent into the header next to Manual and notifications', () => {
  const shell = read('apps', 'console-web', 'src', 'app', 'os', 'os-shell.ts');

  assert.match(shell, /import\s*\{\s*OsOsaaAgent\s*\}\s*from\s*'\.\/os-osaa-agent'/);
  assert.match(shell, /imports:\s*\[[^\]]*OsOsaaAgent[^\]]*\]/);
  assert.match(shell, /<os-osaa-agent\s*\/>/);
  // Same header-actions block as Manual/notifications — a single occurrence, immediately between
  // the /manual header link and <os-notifications />, not a separate nav item.
  assert.match(shell, /routerLink="\/manual"[\s\S]{0,200}<os-osaa-agent \/>[\s\S]{0,80}<os-notifications \/>/);
  const tagOccurrences = shell.match(/<os-osaa-agent\s*\/>/g) || [];
  assert.equal(tagOccurrences.length, 1);
  // Never rendered inside the dynamically-registered plugin nav tree (os-nav-node loop).
  const navNodeBlock = shell.match(/@for \(node of treesForBand[\s\S]*?<\/os-nav-node>|<os-nav-node[\s\S]{0,40}\/>/)?.[0] || '';
  assert.doesNotMatch(navNodeBlock, /os-osaa-agent/);
});

test('os-osaa-agent.ts calls only the same-origin /api/osaa/chat endpoint through the shared HttpService session policy', () => {
  const agent = read('apps', 'console-web', 'src', 'app', 'os', 'os-osaa-agent.ts');
  const http = read('apps', 'console-web', 'src', 'app', 'core', 'http.service.ts');

  assert.match(agent, /import\s*\{\s*HttpRequestTimeoutError,\s*HttpService\s*\}\s*from\s*'\.\.\/core\/http\.service'/);
  assert.match(agent, /private http = inject\(HttpService\)/);
  assert.match(agent, /this\.http\.request\('\/api\/osaa\/chat',/);
  assert.match(agent, /timeoutMs:\s*R2D2_CHAT_TIMEOUT_MS/);
  assert.doesNotMatch(agent, /authorization:\s*['"`]Bearer/i);
  // The component owns no raw fetch call; the shared policy is the only network boundary.
  const fetchCalls = agent.match(/fetch\(/g) || [];
  assert.equal(fetchCalls.length, 0);
  assert.doesNotMatch(agent, /https?:\/\//);
  assert.match(http, /private sameOrigin\(input: RequestInfo \| URL\)/);
  assert.match(http, /headers\.delete\('Authorization'\)/);
  assert.match(http, /X-OS-CSRF-Token/);
});

test('os-osaa-agent.ts never stores or displays raw API key material', () => {
  const agent = read('apps', 'console-web', 'src', 'app', 'os', 'os-osaa-agent.ts');

  assert.doesNotMatch(agent, /api[_-]?key/i);
  assert.doesNotMatch(agent, /type="password"/);
  assert.doesNotMatch(agent, /apiKey/);
  // Messages are server-owned durable data. The browser does not duplicate transcripts in either
  // storage API; localStorage is limited to the non-sensitive dock-width preference.
  assert.doesNotMatch(agent, /sessionStorage\.(?:get|set)Item/);
  assert.match(agent, /\/api\/osaa\/conversations/);
  assert.match(agent, /private async refreshHistory\(loadNewest: boolean\)/);
  const localStorageUses = agent.match(/localStorage\.(?:get|set)Item\('([^']+)'/g) || [];
  assert.ok(localStorageUses.length > 0);
  for (const use of localStorageUses) {
    assert.match(use, /'opensphere\.osaa\.dockWidth'/);
    assert.doesNotMatch(use, /key|token|secret|credential/i);
  }
  // No other localStorage key besides the dock-width preference is ever used.
  assert.doesNotMatch(agent, /localStorage\.(?:get|set)Item\('(?!opensphere\.osaa\.dockWidth')/);
  assert.doesNotMatch(agent, /localStorage\.(?:get|set)Item\([^)]*(?:conversation|message|session)/i);
});

test('os-osaa-agent.ts renders message/source/concept content as safe text (no innerHTML)', () => {
  const agent = read('apps', 'console-web', 'src', 'app', 'os', 'os-osaa-agent.ts');
  const renderer = read('apps', 'console-web', 'src', 'app', 'os', 'osaa-message-content.ts');

  assert.doesNotMatch(agent, /\[innerHTML\]|\.innerHTML\s*=|bypassSecurityTrustHtml/);
  assert.doesNotMatch(renderer, /\[innerHTML\]|\.innerHTML\s*=|bypassSecurityTrustHtml/);
  assert.match(agent, /<os-osaa-message-content \[content\]="m\.content" \/>/);
  assert.match(agent, /\{\{\s*s\.title\s*\}\}/);
  assert.match(agent, /\{\{\s*c\.name\s*\}\}/);
});

test('os-osaa-agent.ts surfaces Degraded/error state with retry-by-resend, new chat, and history controls', () => {
  const agent = read('apps', 'console-web', 'src', 'app', 'os', 'os-osaa-agent.ts');

  assert.match(agent, /readonly error = signal\(''\)/);
  assert.match(agent, /@if \(error\(\)\) \{/);
  assert.match(agent, /this\.error\.set\(body\.error \|\| `R2D2 request failed \(HTTP \$\{r\.status\}\)`\)/);
  assert.match(agent, /newChat\(\):\s*void/);
  assert.match(agent, /toggleHistory\(\):\s*void/);
  assert.match(agent, /async loadSession\(s: OsaaSession\): Promise<void>/);
});

test('os-osaa-agent.ts exposes accessible open/close controls and dock resize + full workspace toggle', () => {
  const agent = read('apps', 'console-web', 'src', 'app', 'os', 'os-osaa-agent.ts');

  assert.match(agent, /aria-label="R2D2"/);
  assert.match(agent, /\(click\)="close\(\)" title="Close" aria-label="Close"/);
  assert.match(agent, /startResize\(ev: PointerEvent\)/);
  assert.match(agent, /resetDockWidth\(\)/);
  assert.match(agent, /toggleFull\(\):\s*void/);
  assert.match(agent, /Expand to workspace/);
});

test('OSAA desktop dock reserves Main Shell workspace instead of overlaying it', () => {
  const styles = read('apps', 'console-web', 'src', 'styles.scss');
  const agent = read('apps', 'console-web', 'src', 'app', 'os', 'os-osaa-agent.ts');

  // The agent owns the fixed right panel, while the global shell stylesheet owns
  // the corresponding workspace reservation.  Testing both sides prevents a
  // future component restore from bringing back only the fixed panel.
  assert.match(agent, /document\.body\.classList\.toggle\('osaa-agent-open', this\.open\(\)\)/);
  assert.match(agent, /position:\s*fixed;\s*top:\s*3rem;\s*right:\s*0/);
  assert.match(styles, /body\.osaa-agent-open\s+\.content-container\s*\{[\s\S]*?margin-right:\s*calc\(var\(--osaa-dock-width, 390px\) \+ var\(--osaa-dock-gap, 8px\)\)/);
  assert.match(styles, /body\.osaa-agent-open\.osaa-agent-full\s+\.content-container\s*\{[\s\S]*?margin-right:\s*0/);
  assert.match(styles, /@media \(max-width:\s*720px\)[\s\S]*?body\.osaa-agent-open\s+\.content-container\s*\{[\s\S]*?margin-right:\s*0/);
});

test('os-osaa-agent.ts does not render or hydrate automatic suggested actions', () => {
  const agent = read('apps', 'console-web', 'src', 'app', 'os', 'os-osaa-agent.ts');

  assert.doesNotMatch(agent, /Suggested Actions/);
  assert.doesNotMatch(agent, /OsaaSuggestedAction/);
  assert.doesNotMatch(agent, /suggestedActions/);
  assert.doesNotMatch(agent, /useSuggestedAction/);
  assert.doesNotMatch(agent, /\/api\/osaa\/actions\//);
  assert.doesNotMatch(agent, /\/api\/osaa\/tools\//);
});

test('os-osaa-agent is absent from Extension Host / DUPA plugin nav registration paths', () => {
  const extensionHost = read('apps', 'console-web', 'src', 'app', 'core', 'extension-host.service.ts');
  const controller = read('backend', 'dupa-control', 'controller.js');

  assert.doesNotMatch(extensionHost, /os-osaa-agent/i);
  assert.doesNotMatch(controller, /os-osaa-agent/i);
});

test('OSAA admin uses the Supabase console-admins contract and the shared full-width side-panel workflow', () => {
  const admin = read('apps', 'console-web', 'src', 'app', 'pages', 'admin-osaa.ts');
  const panel = read('apps', 'console-web', 'src', 'app', 'os', 'os-panel.ts');
  const styles = read('apps', 'console-web', 'src', 'styles.scss');

  assert.doesNotMatch(admin, /opensphere-console-admins/);
  assert.match(admin, /R2D2 관리자 역할\(console-admins\)이 필요합니다/);
  assert.match(admin, /class="clr-form-full-width osaa-key-form"/);
  assert.match(admin, /설정 ID <small>\(자동 생성 · API key 아님\)<\/small>/);
  assert.doesNotMatch(admin, /name="osaa-key-id"/);
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

test('OSAA API key visibility is explicit, accessible, and resets at every secret boundary', () => {
  const admin = read('apps', 'console-web', 'src', 'app', 'pages', 'admin-osaa.ts');

  assert.match(admin, /readonly llmSecretVisible = signal\(false\)/);
  assert.match(admin, /aria-label]="llmSecretVisible\(\) \? 'API key 숨기기' : 'API key 표시'"/);
  assert.match(admin, /aria-pressed]="llmSecretVisible\(\)"/);
  assert.match(admin, /class="osaa-secret-input-shell"[\s\S]*?id="osaa-key-secret"[\s\S]*?class="osaa-secret-toggle"/);
  assert.match(admin, /눈동자를 누르면 입력값을 확인할 수 있습니다/);
  assert.match(admin, /\.osaa-secret-toggle \{[^}]*top: 50%[^}]*transform: translateY\(-50%\)/);
  assert.match(admin, /toggleLlmSecretVisibility\(\): void/);
  assert.match(admin, /onLlmProviderChange\(provider: string\): void/);
  assert.match(admin, /onLlmApiKeyChange\(value: string\): void/);
  assert.match(admin, /closeKeyPanel\(\): void \{[\s\S]*?this\.llmSecretVisible\.set\(false\)/);
  assert.match(admin, /finally \{[\s\S]*?this\.llmSecretVisible\.set\(false\)[\s\S]*?apiKey: ''/);
});

test('OSAA Admin distinguishes reachable Gateway health from complete Agent readiness', () => {
  const admin = read('apps', 'console-web', 'src', 'app', 'pages', 'admin-osaa.ts');

  assert.match(admin, /<span>Runtime<\/span>/);
  assert.match(admin, /R2D2 runtime · v\{\{ h\.version \}\}/);
  assert.doesNotMatch(admin, /\{\{\s*h\.service/);
  assert.match(admin, /interface AgentControlReadiness/);
  assert.match(admin, /Complete Agent readiness/);
  assert.match(admin, /control\.agentControl\.blockers/);
  assert.match(admin, /missingCapabilities\.observability/);
  assert.match(admin, /missingCapabilities\.hisOwner/);
  assert.match(admin, /missingCapabilities\.cephOwner/);
  assert.match(admin, /\/api\/osaa\/tools\/control-plane\/status/);
  assert.match(admin, /method: 'POST'/);
});

test('OSAA credential writes enter the Console Backend policy and audit boundary, never the read-only Gateway mutation path', () => {
  const nginx = read('apps', 'console-web', 'nginx', 'default.conf.template');
  const backend = read('backend', 'opensphere-console-backend', 'server.js');
  const backendDeploy = read('backend', 'opensphere-console-backend', 'deploy.yaml');
  const gateway = read('apps', 'osaa-gateway', 'server.js');
  const gatewayDeploy = read('apps', 'osaa-gateway', 'deploy.yaml');
  const admin = read('apps', 'console-web', 'src', 'app', 'pages', 'admin-osaa.ts');

  assert.match(nginx, /location \^~ \/api\/osaa\/admin\/llm-keys[\s\S]*opensphere-console-backend/);
  assert.match(backend, /verifyConsoleAdmin\(req\)[\s\S]*upsertOsaaKey\(actor, await readBody\(req\)\)/);
  assert.match(backend, /logAudit\(actor, action, input\.id, 'attempt'[\s\S]*k8sRequest\('POST'/);
  assert.match(backend, /management reason must be at least 8 characters/);
  assert.match(backend, /probeOsaaProviderCredential\(meta, apiKey\)/);
  assert.match(backend, /osaa-validation-status/);
  assert.match(backend, /auditRecorded = false/);
  assert.match(backend, /error\.code >= 400 && error\.code <= 599/);
  assert.match(backend, /const osaaKeyTestPath[\s\S]*validateStoredOsaaKey\(actor, osaaKeyTestPath\[1\]\)/);
  assert.match(admin, /Provider 검증/);
  assert.match(admin, /testLlmKey\(k: LlmKey\): Promise<void>/);
  assert.match(admin, /validationStatus === 'ready'/);
  assert.match(backendDeploy, /opensphere-console-backend-osaa-credentials/);
  assert.match(backendDeploy, /resources: \["secrets"\][\s\S]*"create"[\s\S]*"patch"[\s\S]*"delete"/);
  assert.match(backend, /const OSAA_KEY_NAMESPACE = process\.env\.OSAA_KEY_NAMESPACE \|\| 'opensphere-osaa-credentials'/);
  assert.match(backend, /namespaces\/\$\{encodeURIComponent\(OSAA_KEY_NAMESPACE\)\}\/secrets/);
  assert.match(backendDeploy, /name: OSAA_KEY_NAMESPACE, value: opensphere-osaa-credentials/);
  assert.match(backendDeploy, /name: opensphere-console-backend-osaa-credentials, namespace: opensphere-console \}\r?\n+rules: \[\]/);
  assert.match(backendDeploy, /name: opensphere-console-backend-osaa-credentials, namespace: opensphere-osaa-credentials/);
  const gatewayConsoleRole = gatewayDeploy.slice(
    gatewayDeploy.indexOf('kind: Role\nmetadata: { name: opensphere-console-osaa-gateway, namespace: opensphere-console }'),
    gatewayDeploy.indexOf('kind: RoleBinding\nmetadata: { name: opensphere-console-osaa-gateway, namespace: opensphere-console }'),
  );
  assert.doesNotMatch(gatewayConsoleRole, /resources: \[secrets\]/);
  assert.match(gatewayDeploy, /name: opensphere-console-osaa-gateway-credentials, namespace: opensphere-osaa-credentials/);
  assert.match(gatewayDeploy, /name: OSAA_KEY_NAMESPACE, value: opensphere-osaa-credentials/);
  assert.match(gateway, /const OSAA_KEY_NAMESPACE = process\.env\.OSAA_KEY_NAMESPACE \|\| 'opensphere-osaa-credentials'/);
  assert.match(gateway, /namespaces\/\$\{OSAA_KEY_NAMESPACE\}\/secrets/);
  assert.match(gateway, /osaa_direct_mutation_removed_use_console_backend/);
  assert.match(admin, /llmForm\.reason\.trim\(\)\.length < 8/);
});

test('OSAA chat delegates provider key selection to Gateway instead of hard-coding a stale key id', () => {
  const agent = read('apps', 'console-web', 'src', 'app', 'os', 'os-osaa-agent.ts');

  assert.doesNotMatch(agent, /keyId:\s*['"]deepseek['"]/);
  assert.match(agent, /conversationId: this\.currentId\(\) \|\| undefined,[\s\S]*clientRequestId: crypto\.randomUUID\(\),[\s\S]*message: text,[\s\S]*context: this\.pageContext\(\),[\s\S]*source: 'console-osaa-agent'/);
  assert.doesNotMatch(agent, /model:\s*this\.(?:activeModel|displayModel)\(\)/);
  assert.doesNotMatch(agent, /readonly activeModel\s*=/);
  assert.match(agent, /readonly displayModel = computed\([\s\S]*?osaa-control-tools/);
  assert.doesNotMatch(agent, /messages:\s*payloadMessages|sessionId:\s*this\.currentId\(\)/);
});

test('OSAA provider usage is normalized, persisted to the Supabase ledger, and visible per response and key', () => {
  const agent = read('apps', 'console-web', 'src', 'app', 'os', 'os-osaa-agent.ts');
  const admin = read('apps', 'console-web', 'src', 'app', 'pages', 'admin-osaa.ts');
  const gateway = read('apps', 'osaa-gateway', 'server.js');
  const migration = read('backend', 'supabase', 'migrations', '0012_oaa_llm_usage_ledger.sql');

  assert.match(gateway, /function normalizeProviderUsage\(raw\)/);
  assert.match(gateway, /async function recordLlmUsageEvent\(event\)/);
  assert.match(gateway, /function supportsProviderEmbedding\(key\)/);
  assert.match(gateway, /return key\.provider === 'openai' \|\| key\.provider === 'custom'/);
  assert.match(gateway, /INSERT INTO llm_usage_event/);
  assert.match(gateway, /async function llmUsageDashboard\(days = 30\)/);
  assert.match(gateway, /\/api\/osaa\/admin\/usage/);
  assert.match(gateway, /assertPermission\(actor, 'osaa\.usage\.read'\)/);
  assert.match(gateway, /usageRecorded/);
  assert.match(agent, /interface OsaaUsage/);
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

test('OSAA Admin correlates agent evidence and governs retention without a purge control', () => {
  const admin = read('apps', 'console-web', 'src', 'app', 'pages', 'admin-osaa.ts');
  const gateway = read('apps', 'osaa-gateway', 'server.js');
  const migration = read('backend', 'supabase', 'migrations', '0019_oaa_evidence_correlation_retention.sql');

  assert.match(admin, /Agent Evidence/);
  assert.match(admin, /Run → retrieval \/ tool \/ provider correlation/);
  assert.match(admin, /보존·Legal hold 정책/);
  assert.match(admin, /expectedRetentionConfirm/);
  assert.match(admin, /update R2D2 evidence retention/);
  assert.match(admin, /replace\(\/\^update R2D2 evidence retention \/, 'update OSAA evidence retention '\)/);
  assert.match(admin, /\/api\/osaa\/admin\/evidence\/retention/);
  assert.doesNotMatch(admin, />\s*(?:Purge|삭제 실행)\s*</i);
  assert.match(gateway, /deletionPerformed: false/);
  assert.match(migration, /export-before-delete/);
  assert.match(migration, /evidence_policy_event_append_only/);
});

test('OSAA composer follows the desktop chat interaction contract', () => {
  const agent = read('apps', 'console-web', 'src', 'app', 'os', 'os-osaa-agent.ts');

  assert.match(agent, /placeholder="무엇이든 요청하세요"/);
  assert.match(agent, /class="osaa-compose-bar"/);
  assert.match(agent, /class="osaa-context-chip"/);
  assert.match(agent, /class="osaa-model-chip"/);
  assert.match(agent, /title="전송 \(Enter\)"/);
  assert.match(agent, /if \(ev\.isComposing \|\| ev\.key !== 'Enter' \|\| ev\.shiftKey\) return/);
  assert.doesNotMatch(agent, /ev\.ctrlKey \|\| ev\.metaKey/);
  assert.match(agent, /private activeRequest: AbortController \| null = null/);
  assert.match(agent, /stopGeneration\(\): void/);
  assert.match(agent, /toggleVoiceInput\(\): void/);
});

test('OSAA shows a concise enforced Dialogue State inspector without exposing shadow state', () => {
  const agent = read('apps', 'console-web', 'src', 'app', 'os', 'os-osaa-agent.ts');

  assert.match(agent, /interface OsaaDialogue/);
  assert.match(agent, /class="osaa-context-inspector"/);
  assert.match(agent, /dialogue\.domain.*dialogue\.intent/);
  assert.match(agent, /dialogue\.missingSlots\.join/);
  assert.match(agent, /\['read-enforce', 'mutation-enforce'\]\.includes/);
  assert.match(agent, /dialogue: this\.normalizeDialogue\(body\.dialogue, body\.dialogueMode\)/);
});

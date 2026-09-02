import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');

test('CBSS OS Shell is a default-off built-in docked system plugin with an isolated full-page fallback', () => {
  const descriptor = read('src/app/system-plugins/os-shell/os-shell.descriptor.ts');
  const routes = read('src/app/app.routes.ts');
  assert.match(descriptor, /owner:\s*'cbss-main-shell'/);
  assert.match(descriptor, /defaultEnabled:\s*false/);
  assert.match(descriptor, /grantedCapabilities:\s*\['session:attach'\]/);
  assert.doesNotMatch(routes, /path:\s*'shell'/);
  assert.doesNotMatch(routes, /path:\s*'p\/os-shell'/);
});

test('terminal is opaque and owns neither WebSocket nor credentials', () => {
  const surface = read('src/app/system-plugins/os-shell/os-shell-terminal-surface.ts');
  const frame = read('src/app/system-plugins/os-shell/frame/os-shell-terminal-frame.ts');
  assert.match(surface, /sandbox="allow-scripts"/);
  assert.doesNotMatch(surface, /allow-same-origin/);
  assert.doesNotMatch(frame, /WebSocket|fetch\(|Authorization|Bearer|ticket|localStorage|sessionStorage/);
  assert.match(frame, /MessagePort/);
});

test('attached OS Shell visibly signals input readiness with a focused blinking cursor', () => {
  const frame = read('src/app/system-plugins/os-shell/frame/os-shell-terminal-frame.ts');
  const nginx = read('nginx/default.conf.template');
  const locationStart = nginx.indexOf('location ^~ /os-shell-frame/ {');
  const locationEnd = nginx.indexOf('location = /shell {', locationStart);
  const frameLocation = nginx.slice(locationStart, locationEnd);
  assert.match(frame, /cursorBlink:\s*true/);
  assert.match(frame, /cursorInactiveStyle:\s*'outline'/);
  assert.match(frame, /cursor:\s*'#fdd13a'/);
  assert.match(frame, /cursorAccent:\s*'#101010'/);
  assert.match(frame, /selectionBackground:\s*'#78a9ff'/);
  assert.match(frame, /selectionForeground:\s*'#101010'/);
  assert.match(frame, /selectionInactiveBackground:\s*'#4589ff'/);
  assert.match(frame, /root[.]addEventListener\('pointerdown',[\s\S]*terminal[.]focus\(\)/);
  assert.match(frame, /cursorStyle:\s*'block'/);
  assert.match(frame, /case 'attached':[\s\S]*terminal[.]options[.]disableStdin = false;[\s\S]*terminal[.]focus\(\)/);
  assert.doesNotMatch(frame, /cursorBlink:\s*false/);
  assert.match(frameLocation, /style-src 'self' 'unsafe-inline'/);
  assert.match(frameLocation, /script-src 'self'/);
  assert.match(frameLocation, /connect-src 'none'/);
  assert.doesNotMatch(frameLocation, /script-src[^;]*'unsafe-inline'/);
});

test('terminal preserves upstream selection, copy and paste UX across the isolated frame', () => {
  const frame = read('src/app/system-plugins/os-shell/frame/os-shell-terminal-frame.ts');
  assert.match(frame, /rightClickSelectsWord:\s*true/);
  assert.match(frame, /attachCustomKeyEventHandler/);
  assert.match(frame, /key === 'c' && \(event[.]shiftKey \|\| terminal[.]hasSelection\(\)\)[\s\S]*return false/);
  assert.match(frame, /primaryModifier && key === 'v'[\s\S]*return false/);
  assert.match(frame, /event[.]key === 'Insert' && \(event[.]ctrlKey \|\| event[.]shiftKey\)/);
});

test('long paste is UTF-8 chunked and paced instead of being silently discarded', () => {
  const frame = read('src/app/system-plugins/os-shell/frame/os-shell-terminal-frame.ts');
  assert.match(frame, /const MAX_PENDING_STDIN_BYTES = 256 \* 1024/);
  assert.match(frame, /const STDIN_DRAIN_INTERVAL_MS = 160/);
  assert.match(frame, /function splitInput\(data: string\)/);
  assert.match(frame, /chunkBytes \+ symbolBytes > MAX_STDIN_FRAME_BYTES/);
  assert.match(frame, /pendingInput[.]push\([.][.][.]splitInput\(data\)\)/);
  assert.match(frame, /window[.]setTimeout\([\s\S]*STDIN_DRAIN_INTERVAL_MS/);
  assert.doesNotMatch(frame, /byteLength > MAX_STDIN_FRAME_BYTES\) return/);
});

test('trusted terminal interaction extends the Main Shell browser session without counting output as activity', () => {
  const frame = read('src/app/system-plugins/os-shell/frame/os-shell-terminal-frame.ts');
  const protocol = read('src/app/system-plugins/os-shell/os-shell-protocol.ts');
  const attach = read('src/app/system-plugins/os-shell/os-shell-attach.service.ts');
  const auth = read('src/app/core/auth.service.ts');
  assert.match(frame, /const trustedActivity = \(event: Event\)/);
  assert.match(frame, /!event[.]isTrusted/);
  assert.match(frame, /type: 'activity', sequence: \+\+sequence/);
  assert.match(protocol, /frame[.]type === 'activity'/);
  assert.match(attach, /frame[.]type === 'activity'[\s\S]*this[.]auth[.]recordTrustedActivity\(\)/);
  assert.match(auth, /recordTrustedActivity\(\): void[\s\S]*this[.]queueActivityHeartbeat\(\)/);
  const outputBoundary = frame.slice(frame.indexOf('function acceptHostFrame'), frame.indexOf("window.addEventListener('message'"));
  assert.doesNotMatch(outputBoundary, /type: 'activity'/);
});

test('default Console entry opens an OCI-style docked panel and preserves the isolated full-page fallback', () => {
  const shell = read('src/app/os/os-shell.ts');
  const launcher = read('src/app/system-plugins/os-shell/os-shell-launcher.ts');
  const panel = read('src/app/system-plugins/os-shell/os-shell-panel.ts');
  const state = read('src/app/system-plugins/os-shell/os-shell-panel-state.service.ts');
  assert.match(shell, /<os-shell-panel \/>/);
  assert.match(launcher, /panel[.]toggle\(\)/);
  assert.match(launcher, /aria-expanded/);
  assert.doesNotMatch(launcher, /window[.]location[.]assign|href="\/shell"/);
  assert.match(panel, /position:\s*fixed;[\s\S]*bottom:\s*0;/);
  assert.match(panel, /height:\s*clamp\(20rem, 42vh, 34rem\)/);
  assert.match(panel, /href="\/shell" target="_blank" rel="noopener noreferrer"/);
  assert.match(panel, /panel[.]toggleExpanded\(\)/);
  assert.match(panel, /panel[.]close\(\)/);
  assert.match(state, /readonly open = signal\(false\)/);
});

test('Host sends the one-time ticket as first WSS application frame', () => {
  const attach = read('src/app/system-plugins/os-shell/os-shell-attach.service.ts');
  assert.match(attach, /new WebSocket\(webSocketUrl\(\), \[OS_SHELL_PTY_PROTOCOL\]\)/);
  assert.match(attach, /type:\s*'attach',[\s\S]*sessionId:\s*issued\.sessionId,[\s\S]*generation:\s*issued\.generation,[\s\S]*fencingEpoch:\s*issued\.fencingEpoch,[\s\S]*ticket:\s*attachTicket/);
  assert.match(attach, /attachTicket = ''/);
  assert.doesNotMatch(attach, /searchParams|document\.cookie|localStorage|sessionStorage/);
  assert.match(attach, /!\['Revoked', 'Failed', 'Terminated'\]\.includes\(lastReportedState\)/);
});

test('resize rejects a one-row terminal before the gateway boundary', () => {
  const protocol = read('src/app/system-plugins/os-shell/os-shell-protocol.ts');
  const frame = read('src/app/system-plugins/os-shell/frame/os-shell-terminal-frame.ts');
  assert.match(protocol, /export const MIN_ROWS = 2;/);
  assert.match(protocol, /Number\(frame\.rows\) >= MIN_ROWS/);
  assert.doesNotMatch(protocol, /export const MIN_ROWS = 1;/);
  assert.match(frame, /const MIN_ROWS = 2;/);
  assert.doesNotMatch(frame, /const MIN_ROWS = 1;/);
});

test('Host input throttle is aligned to the gateway and runtime ceiling', () => {
  const attach = read('src/app/system-plugins/os-shell/os-shell-attach.service.ts');
  assert.match(attach, /const MAX_INPUT_MESSAGES_PER_SECOND = 60;/);
  assert.doesNotMatch(attach, /const MAX_INPUT_MESSAGES_PER_SECOND = 120;/);
});

test('only xterm and fit addon enter the renderer dependency surface', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies['@xterm/xterm'], '5.5.0');
  assert.equal(pkg.dependencies['@xterm/addon-fit'], '0.10.0');
  for (const name of Object.keys(pkg.dependencies).filter((name) => name.startsWith('@xterm/'))) {
    assert.ok(['@xterm/xterm', '@xterm/addon-fit'].includes(name), name);
  }
  const frame = read('src/app/system-plugins/os-shell/frame/os-shell-terminal-frame.ts');
  assert.doesNotMatch(frame, /addon-attach|addon-web-links|addon-image|addon-webgl|registerLinkProvider|registerOscHandler/);
});

test('Nginx mediates API/WSS through dedicated admission and control upstreams', () => {
  const nginx = read('nginx/default.conf.template');
  assert.match(nginx, /location ~ "?\^\/api\/os-shell\/sessions\//);
  assert.match(nginx, /location \/api\/os-shell\//);
  assert.match(nginx, /location = \/_os_shell_authn/);
  assert.match(nginx, /auth_request \/_os_shell_authn/);
  assert.match(nginx, /api\/internal\/os-shell-authn/);
  assert.match(nginx, /opensphere-shell-api\.opensphere-console\.svc\.cluster\.local/);
  assert.match(nginx, /opensphere-shell-gateway\.opensphere-console\.svc\.cluster\.local/);
  assert.match(nginx, /X-OS-Shell-Admission/);
  const boundary = nginx.slice(
    nginx.indexOf('# CBSS OS Shell browser attach'),
    nginx.indexOf('# Internal-only browser-session admission'),
  );
  assert.doesNotMatch(boundary, /proxy_set_header Cookie \$http_cookie/);
  assert.match(boundary, /proxy_set_header Cookie ""/);
  assert.match(boundary, /proxy_set_header Authorization ""/);
  assert.match(boundary, /proxy_set_header Upgrade \$http_upgrade/);
  assert.match(boundary, /proxy_set_header Connection \$os_conn_upgrade/);
  const admission = nginx.slice(
    nginx.indexOf('# Internal-only browser-session admission'),
    nginx.indexOf('# 콘솔 네이티브 카탈로그'),
  );
  assert.match(admission, /internal;/);
  assert.match(admission, /proxy_set_header Cookie \$http_cookie/);
  assert.doesNotMatch(nginx, /OS_SHELL_CONTROL_UPSTREAM_PENDING|os_shell_control_plane_pending/);
  assert.match(nginx, /location \^~ \/os-shell-frame\//);
  assert.match(nginx, /connect-src 'none'/);
  assert.match(nginx, /frame-ancestors 'self'/);
  assert.doesNotMatch(nginx, /connect-src[^;]*\bws:/);
  assert.match(nginx, /connect-src 'self' \$\{OS_AUTH_ORIGIN\} wss:/);
});

test('ordinary Extension Host rejects system-only attach before bundle fetch', () => {
  const host = read('src/app/core/extension-host.service.ts');
  const rejection = host.indexOf("perms.includes('session:attach')");
  const entryFetch = host.indexOf('this.fetchVerifiedArtifactText(', rejection);
  assert.ok(rejection > 0 && entryFetch > rejection);
});

test('Console refresh resumes only the current actor session and reconnect always mints a new one-time ticket', () => {
  const page = read('src/app/system-plugins/os-shell/os-shell-page.ts');
  const attach = read('src/app/system-plugins/os-shell/os-shell-attach.service.ts');
  assert.match(page, /const existing = await this[.]sessions[.]list\(\)/);
  assert.match(page, /existing[.]find\(\(item\) => !TERMINAL_STATES[.]has\(item[.]observedState\)\)/);
  assert.match(page, /this[.]session[.]set\(resumable\)/);
  assert.match(attach, /const issued = await this[.]sessions[.]issueAttachTicket\(sessionId\)/);
  assert.match(attach, /candidate[.]onclose[\s\S]*reconnect\(\)/);
  assert.match(attach, /retryCount >= 2/);
  assert.match(attach, /attachTicket = ''/);
  assert.doesNotMatch(attach, /localStorage|sessionStorage|indexedDB/);
});

test('opening OS Shell immediately resumes or creates a session without a second start action', () => {
  const page = read('src/app/system-plugins/os-shell/os-shell-page.ts');
  assert.match(page, /if \(resumable\) \{[\s\S]*this[.]session[.]set\(resumable\);[\s\S]*return;/);
  assert.match(page, /await this[.]createSession\(\);/);
  assert.match(page, /else if \(readiness[.]ready\) resumeOrCreate = true;[\s\S]*if \(resumeOrCreate\) await this[.]resumeOrCreateSession\(\);/);
  assert.match(page, /private async resumeOrCreateSession\(\): Promise<void>/);
  assert.match(page, /호출 즉시 자동 시작 중/);
  assert.doesNotMatch(page, />OS Shell 시작<\/button>/);
  assert.match(page, />다시 시작<\/button>/);
});

test('session create retains one client idempotency key across response loss and relies on DB quotas, not UI clicks', () => {
  const service = read('src/app/system-plugins/os-shell/os-shell-session.service.ts');
  const http = read('src/app/core/http.service.ts');
  assert.match(service, /private pendingCreateKey[?]: string/);
  assert.match(service, /const idempotencyKey = this[.]pendingCreateKey \?\?= crypto[.]randomUUID\(\)/);
  assert.match(service, /'X-OS-Idempotency-Key': idempotencyKey/);
  assert.match(service, /catch \(error\)[\s\S]*Retain the key[\s\S]*throw error/);
  assert.match(service, /if \(!response[.]ok\)[\s\S]*this[.]pendingCreateKey = undefined/);
  assert.match(service, /const session = await this[.]sessionResponse\(response\);[\s\S]*this[.]pendingCreateKey = undefined/);
  assert.match(http, /target[.]origin !== window[.]location[.]origin/);
});

test('the native Shell route and proxy remain disjoint from canonical PFSS routing', () => {
  const routes = read('src/app/app.routes.ts');
  const nginx = read('nginx/default.conf.template');
  assert.doesNotMatch(routes, /path:\s*'shell'|os-shell-page/);
  assert.match(routes, /segments\[0\][.]path !== 'pfss'/);
  assert.match(routes, /matcher:\s*pfssHostMatcher,\s*component:\s*PluginHost/);
  assert.match(nginx, /location \/api\/os-shell\//);
  assert.match(nginx, /location ~ \^\/api\/plugins\/\(\[a-z0-9-\]\+\)\/\([.]\*\)\$/);
  assert.doesNotMatch(nginx, /location \/pfss\/[^\n]*os.shell/i);
});

test('active runtime authorization is revalidated on a two-second cadence within the five-second revoke SLO', () => {
  const agent = read('apps/os-shell-control/runtime/agent.go');
  assert.match(agent, /time[.]NewTicker\(2 \* time[.]Second\)/);
  assert.match(agent, /server[.]control[.]revalidate\(revalidateContext, server[.]binding\)/);
  assert.match(agent, /ptyFrame\{Type: "revoked", Message: "runtime authorization revoked"\}/);
});

test('OS Shell uses an immutable extension-free top-level realm with full-navigation entry and exit', () => {
  const appConfig = read('src/app/app.config.ts');
  const bootMode = read('src/app/core/boot-mode.ts');
  const app = read('src/app/app.ts');
  const host = read('src/app/core/extension-host.service.ts');
  const launcher = read('src/app/system-plugins/os-shell/os-shell-launcher.ts');
  const panel = read('src/app/system-plugins/os-shell/os-shell-panel.ts');
  const page = read('src/app/system-plugins/os-shell/os-shell-page.ts');

  assert.match(bootMode, /window[.]location[.]pathname === '\/shell'/);
  assert.match(appConfig, /OS_SHELL_STANDALONE_BOOT[\s\S]*withDisabledInitialNavigation\(\)/);
  assert.match(app, /OS_SHELL_STANDALONE_BOOT [??] null : inject\(ExtensionHostService\)/);
  const startupGate = app.indexOf('if (OS_SHELL_STANDALONE_BOOT || !this.ext) return;');
  const guestLoad = app.indexOf('void this.ext.load()');
  assert.ok(startupGate > 0 && guestLoad > startupGate, 'external load must be unreachable in the Shell boot realm');
  assert.match(host, /async load\(\)[\s\S]*OS_SHELL_STANDALONE_BOOT[\s\S]*ExternalExtensionsDisabledInStandaloneShell/);
  assert.match(host, /private async loadOne[\s\S]*OS_SHELL_STANDALONE_BOOT[\s\S]*ExternalExtensionsDisabledInStandaloneShell/);
  assert.match(launcher, /panel[.]toggle\(\)/);
  assert.doesNotMatch(launcher, /window[.]location[.]assign\('\/shell'\)/);
  assert.doesNotMatch(launcher, /routerLink/);
  assert.match(panel, /href="\/shell" target="_blank" rel="noopener noreferrer"/);
  assert.match(page, /window[.]location[.]assign\('\/'\)/);
  assert.doesNotMatch(page, /navigateByUrl|routerLink/);
});

test('opaque terminal frame remains isolated and explicitly satisfies parent COEP', () => {
  const nginx = read('nginx/default.conf.template');
  const start = nginx.indexOf('location ^~ /os-shell-frame/ {');
  const end = nginx.indexOf('location = /shell {', start);
  const frameLocation = nginx.slice(start, end);
  const surface = read('src/app/system-plugins/os-shell/os-shell-terminal-surface.ts');
  assert.match(frameLocation, /Cross-Origin-Resource-Policy "cross-origin"/);
  assert.match(frameLocation, /Cross-Origin-Embedder-Policy "require-corp"/);
  assert.match(frameLocation, /frame-ancestors 'self'/);
  assert.match(surface, /sandbox="allow-scripts"/);
  assert.doesNotMatch(surface, /allow-same-origin/);
});

test('standalone Shell response severs opener/embed authority and cannot load guest execution surfaces', () => {
  const nginx = read('nginx/default.conf.template');
  const start = nginx.indexOf('location = /shell {');
  const end = nginx.indexOf('# 해시드 자산', start);
  assert.ok(start > 0 && end > start);
  const shell = nginx.slice(start, end);
  assert.match(shell, /script-src 'self'/);
  assert.match(shell, /worker-src 'none'/);
  assert.match(shell, /connect-src 'self'/);
  assert.match(shell, /frame-src 'self'/);
  assert.match(shell, /frame-ancestors 'none'/);
  assert.match(shell, /Cross-Origin-Opener-Policy "same-origin"/);
  assert.match(shell, /Cross-Origin-Embedder-Policy "require-corp"/);
  assert.match(shell, /Cross-Origin-Resource-Policy "same-origin"/);
  assert.doesNotMatch(shell, /blob:|unsafe-eval|worker-src 'self'|\$\{OS_AUTH_ORIGIN\}|\$http_host|https:\/\/ceph/);

  // A prior same-realm plugin may install MutationObserver/postMessage hooks
  // or open a popup, but real navigation destroys that realm; the response
  // additionally starts a new browsing-context group and rejects embedding.
  const launcher = read('src/app/system-plugins/os-shell/os-shell-launcher.ts');
  const panel = read('src/app/system-plugins/os-shell/os-shell-panel.ts');
  assert.doesNotMatch(launcher, /window[.]open|target="_blank"/);
  assert.match(panel, /target="_blank" rel="noopener noreferrer"/);
  const routes = read('src/app/app.routes.ts');
  assert.doesNotMatch(routes, /path:\s*'shell'|os-shell-page/);
  assert.match(nginx, /location = \/shell\/[\s\S]*absolute_redirect off;[\s\S]*return 308 \/shell;/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');

test('CBSS OS Shell is a default-off built-in full-page system plugin', () => {
  const descriptor = read('src/app/system-plugins/os-shell/os-shell.descriptor.ts');
  const routes = read('src/app/app.routes.ts');
  assert.match(descriptor, /owner:\s*'cbss-main-shell'/);
  assert.match(descriptor, /defaultEnabled:\s*false/);
  assert.match(descriptor, /grantedCapabilities:\s*\['session:attach'\]/);
  assert.match(routes, /path:\s*'shell'/);
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
  const entryFetch = host.indexOf("fetchWithTimeout(entryUrl");
  assert.ok(rejection > 0 && entryFetch > rejection);
});

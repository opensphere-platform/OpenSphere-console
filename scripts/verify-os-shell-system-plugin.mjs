import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const mode = process.argv.includes('--dist') ? 'dist' : 'source';

assert.equal(packageJson.dependencies['@xterm/xterm'], '5.5.0');
assert.equal(packageJson.dependencies['@xterm/addon-fit'], '0.10.0');
for (const forbidden of ['@xterm/addon-attach', '@xterm/addon-web-links', '@xterm/addon-image', '@xterm/addon-webgl']) {
  assert.equal(packageJson.dependencies[forbidden], undefined, `${forbidden} must remain absent`);
}

const descriptor = read('apps/console-web/src/app/system-plugins/os-shell/os-shell.descriptor.ts');
assert.match(descriptor, /kind:\s*'systemPlugin'/);
assert.match(descriptor, /route:\s*'\/shell'/);
assert.match(descriptor, /grantedCapabilities:\s*\['session:attach'\]/);
assert.match(descriptor, /defaultEnabled:\s*false/);
assert.match(descriptor, /releaseAuthority:\s*'opensphere-console-exact-digest'/);

const routes = read('apps/console-web/src/app/app.routes.ts');
assert.doesNotMatch(routes, /path:\s*'shell'|OsShellPage|os-shell-page/);
const mainShell = read('apps/console-web/src/app/os/os-shell.ts');
assert.match(mainShell, /<os-shell-launcher\s*\/>/);
assert.match(mainShell, /<os-shell-panel\s*\/>/);
const launcher = read('apps/console-web/src/app/system-plugins/os-shell/os-shell-launcher.ts');
assert.match(launcher, /panel[.]toggle\(\)/);
assert.doesNotMatch(launcher, /window[.]location[.]assign\('\/shell'\)/);
assert.doesNotMatch(launcher, /routerLink/);
const dockedPanel = read('apps/console-web/src/app/system-plugins/os-shell/os-shell-panel.ts');
assert.match(dockedPanel, /href="\/shell" target="_blank" rel="noopener noreferrer"/);
assert.match(dockedPanel, /position:\s*fixed;[\s\S]*bottom:\s*0;/);

const bootMode = read('apps/console-web/src/app/core/boot-mode.ts');
const app = read('apps/console-web/src/app/app.ts');
assert.match(bootMode, /window[.]location[.]pathname === '\/shell'/);
assert.match(app, /OS_SHELL_STANDALONE_BOOT [??] null : inject\(ExtensionHostService\)/);

const surface = read('apps/console-web/src/app/system-plugins/os-shell/os-shell-terminal-surface.ts');
assert.match(surface, /sandbox="allow-scripts"/);
assert.doesNotMatch(surface, /allow-same-origin/);
assert.match(surface, /new MessageChannel\(\)/);

const attach = read('apps/console-web/src/app/system-plugins/os-shell/os-shell-attach.service.ts');
assert.match(attach, /new WebSocket\(/);
assert.match(attach, /type:\s*'attach',[\s\S]*sessionId:\s*issued\.sessionId,[\s\S]*generation:\s*issued\.generation,[\s\S]*fencingEpoch:\s*issued\.fencingEpoch,[\s\S]*ticket:\s*attachTicket/);
assert.doesNotMatch(attach, /[?&](?:ticket|token)=/i);
assert.match(attach, /!\['Revoked', 'Failed', 'Terminated'\]\.includes\(lastReportedState\)/);
const frame = read('apps/console-web/src/app/system-plugins/os-shell/frame/os-shell-terminal-frame.ts');
assert.doesNotMatch(frame, /new WebSocket|fetch\(|localStorage|sessionStorage|innerHTML/);
assert.match(frame, /@xterm\/xterm/);
assert.match(frame, /@xterm\/addon-fit/);

const nginxBase = read('apps/console-web/nginx/default.conf.template');
const nginxTargetRoutes = read('apps/console-web/nginx/target-api-routes.conf');
const nginx = `${nginxBase}\n${nginxTargetRoutes}`;
assert.match(nginx, /\/api\/os-shell\/sessions\/.*\/attach/);
assert.match(nginx, /location \/api\/os-shell\//);
assert.match(nginx, /location = \/_os_shell_authn/);
assert.match(nginx, /api\/internal\/os-shell-authn/);
assert.match(nginx, /opensphere-shell-api\.opensphere-console\.svc\.cluster\.local/);
assert.match(nginx, /opensphere-shell-gateway\.opensphere-console\.svc\.cluster\.local/);
assert.match(nginx, /proxy_set_header X-OS-Owner-Admission \$owner_admission/);
assert.doesNotMatch(nginx, /OS_SHELL_CONTROL_UPSTREAM_PENDING|os_shell_control_plane_pending/);
assert.match(nginx, /location \^~ \/os-shell-frame\//);
assert.match(nginx, /connect-src 'none'/);
const standalone = nginxBase.slice(nginxBase.indexOf('location = /shell {'), nginxBase.indexOf('# 해시드 자산'));
assert.match(standalone, /worker-src 'none'/);
assert.match(standalone, /Cross-Origin-Opener-Policy "same-origin"/);
assert.match(standalone, /Cross-Origin-Embedder-Policy "require-corp"/);
assert.doesNotMatch(standalone, /blob:/);

if (mode === 'dist') {
  const dist = path.join(repo, 'dist', 'opensphere-console', 'browser', 'os-shell-frame');
  for (const artifact of ['index.html', 'os-shell-terminal-frame.js', 'os-shell-terminal-frame.css']) {
    assert.equal(existsSync(path.join(dist, artifact)), true, `missing built OS Shell frame artifact: ${artifact}`);
  }
}

console.log(`[os-shell-contract] ${mode} verification passed`);

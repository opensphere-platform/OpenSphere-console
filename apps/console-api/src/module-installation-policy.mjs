import { readFile } from 'node:fs/promises';

export function localDevelopmentModuleInstall(config, publicOrigin, action, target) {
  const exactInstall = action === 'console.extension.install'
    && /^ghcr\.io\/opensphere-platform\/opensphere-shell-cluster-manager@sha256:[a-f0-9]{64}$/.test(target || '');
  const intakeOnly = action === 'console.extension.inspect' && target === 'extension.cluster-manager';
  if (!exactInstall && !intakeOnly) return false;
  try {
    const url = new URL(config.consoleUrl);
    // User instruction: MFA is required, except when BOTH localhost AND edge hold.
    // An edge channel on an external host remains false. The installation origin is server-owned.
    return config.channel === 'edge' && url.protocol === 'https:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && url.origin === publicOrigin && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}
export function createModuleInstallationPolicy(publicOrigin) {
  return async (action, target) => {
    try {
      const config = JSON.parse(await readFile('/var/run/opensphere/release/config.json', 'utf8'));
      return localDevelopmentModuleInstall(config, publicOrigin, action, target);
    } catch { return false; }
  };
}

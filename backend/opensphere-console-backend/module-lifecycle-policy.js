'use strict';

const fs = require('fs');

const INSTALL_UPDATE_ACTIONS = new Set(['install', 'reinstall', 'update', 'upgrade']);
const DEFAULT_INSTALLATION_CONFIG_FILE = '/var/run/opensphere-installation/config.json';

function normalizeLocalUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) return null;
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function readInstallationPolicy(filePath = DEFAULT_INSTALLATION_CONFIG_FILE, readFile = fs.readFileSync) {
  try {
    const parsed = JSON.parse(readFile(filePath, 'utf8'));
    return {
      channel: String(parsed?.channel || '').trim().toLowerCase(),
      authEnvironment: String(parsed?.authEnvironment || '').trim().toLowerCase(),
      consoleUrl: String(parsed?.consoleUrl || '').trim(),
    };
  } catch {
    return { channel: '', authEnvironment: '', consoleUrl: '' };
  }
}

function isDevelopmentEdgeRuntime(policy, consolePublicUrl) {
  const installedUrl = normalizeLocalUrl(policy?.consoleUrl);
  const runtimeUrl = normalizeLocalUrl(consolePublicUrl);
  return policy?.channel === 'edge'
    && policy?.authEnvironment === 'development'
    && installedUrl !== null
    && installedUrl === runtimeUrl;
}

function moduleLifecycleRequiresRecentAal2(action, policy, consolePublicUrl) {
  return !(INSTALL_UPDATE_ACTIONS.has(String(action || '').trim().toLowerCase())
    && isDevelopmentEdgeRuntime(policy, consolePublicUrl));
}

module.exports = {
  DEFAULT_INSTALLATION_CONFIG_FILE,
  INSTALL_UPDATE_ACTIONS,
  isDevelopmentEdgeRuntime,
  moduleLifecycleRequiresRecentAal2,
  normalizeLocalUrl,
  readInstallationPolicy,
};

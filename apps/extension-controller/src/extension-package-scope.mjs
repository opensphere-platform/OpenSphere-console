const PACKAGE_SCOPES = new Set([
  'main-shell-core',
  'sub-shell',
  'workspace-extension',
]);

function invalidScope() {
  return Object.assign(new Error('UIPluginPackage scope is missing or unsupported'), {
    code: 'PackageScopeInvalid',
    status: 409,
    sideEffect: 'none',
    retryable: false,
    terminal: true,
  });
}

export function exactExtensionPackageScope(pkg) {
  const scope = pkg?.metadata?.labels?.['opensphere.io/scope'];
  if (typeof scope !== 'string' || !PACKAGE_SCOPES.has(scope)) throw invalidScope();
  return Object.freeze({ scope, core: scope === 'main-shell-core' });
}

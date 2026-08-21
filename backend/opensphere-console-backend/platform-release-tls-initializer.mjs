export const TLS_INITIALIZER_PROFILE = 'opensphere-platform-release-tls-initializer/v1';

export async function initializePlatformReleaseTls({ ensure = null } = {}) {
  if (process.env.PLATFORM_RELEASE_TLS_INITIALIZER_PROFILE !== TLS_INITIALIZER_PROFILE) {
    throw new Error('Platform Release TLS initializer profile is unavailable');
  }
  const ensureAuthority = ensure ?? (await import(
    '/app/opensphere-setup-cli/src/platform-release-authority-tls.mjs'
  )).ensurePlatformReleaseAuthorityTls;
  const authority = await ensureAuthority();
  if (authority?.secret?.metadata?.name !== 'opensphere-platform-release-authority-tls'
    || authority?.configMap?.metadata?.name !== 'opensphere-platform-release-control-ca'
    || authority?.service?.metadata?.name !== 'opensphere-platform-release-authority') {
    throw new Error('Platform Release TLS initializer did not observe the exact durable authority set');
  }
  return {
    contract: TLS_INITIALIZER_PROFILE,
    secret: authority.secret.metadata.name,
    configMap: authority.configMap.metadata.name,
    service: authority.service.metadata.name,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await initializePlatformReleaseTls();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[platform-release-tls-initializer]', error?.stack || error);
    process.exitCode = 1;
  }
}

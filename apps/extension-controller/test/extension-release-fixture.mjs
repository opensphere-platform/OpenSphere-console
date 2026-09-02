import { createHash, generateKeyPairSync, sign } from 'node:crypto';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function makeReleaseFixture({
  extensionId = 'workspace',
  entrySource = 'export const activate = () => true;\n',
  contributions = { api: { enabled: true, basePath: '/api/plugins/workspace' }, navigation: [] },
  permissions = ['console.workspace.read'],
  assetSources = [],
} = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyId = 'release-key';
  const entryBytes = Buffer.from(entrySource, 'utf8');
  const assetBodies = new Map(assetSources.map((asset) => [
    asset.path,
    Buffer.isBuffer(asset.source) ? Buffer.from(asset.source) : Buffer.from(asset.source, 'utf8'),
  ]));
  const assets = assetSources.map((asset) => ({
    id: asset.id,
    type: asset.type,
    path: asset.path,
    sha256: digest(assetBodies.get(asset.path)),
  }));
  const manifest = {
    manifestVersion: 3,
    id: extensionId,
    kind: 'plugin',
    hostRef: 'main',
    hostCompat: '^1.0.0',
    hostApiVersion: '1.0.0',
    shellCompat: '^1.0.0',
    sdkVersion: '1.0.0',
    contributions,
    permissions,
    entry: 'main.js',
    entrySha256: digest(entryBytes),
    apiBase: contributions.api?.enabled === true ? `/api/plugins/${extensionId}` : '',
    assets,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const signatureBytes = Buffer.from(sign('sha256', manifestBytes, {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64'), 'utf8');
  const imageDigest = 'sha256:' + 'a'.repeat(64);
  const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const pkg = {
    apiVersion: 'plugins.opensphere.io/v1alpha1',
    kind: 'UIPluginPackage',
    metadata: {
      name: extensionId,
      namespace: 'opensphere-console',
      uid: 'package-uid',
      resourceVersion: '17',
      generation: 2,
    },
    spec: {
      kind: 'plugin',
      hostRef: 'main',
      hostCompat: '^1.0.0',
      hostApiVersion: '1.0.0',
      shellCompat: '^1.0.0',
      version: '1.2.3',
      image: {
        repository: 'ghcr.io/opensphere-platform/opensphere-plugin-workspace',
        digest: imageDigest,
      },
      resolution: {
        requestedRef: 'edge',
        requestedChannel: 'edge',
        resolvedDigest: imageDigest,
        resolvedAt: '2026-09-02T00:00:00.000Z',
        artifactVersion: '202609020001',
        buildAuthority: 'localhost',
        source: 'gitea',
        revision: 'b'.repeat(40),
        compatibilityVersion: '1.0.0',
        signatureIdentity: keyId,
        registryCredentialsRequired: true,
        evidenceRefs: ['release:test'],
      },
      manifest: {
        path: '/plugins/ui-shell.manifest.json',
        sha256: digest(manifestBytes),
        signaturePath: '/plugins/ui-shell.manifest.json.sig',
      },
      trust: { keyId },
      contributions,
      permissions,
      permissionProfile: 'none',
      env: [{ name: 'PLUGIN_MODE', value: 'production' }],
      runtime: {
        port: 8080,
        healthPath: '/healthz',
        security: {
          runAsNonRoot: true,
          readOnlyRootFilesystem: true,
          automountServiceAccountToken: false,
        },
        availability: { replicas: 2, minAvailable: 1, autoscaling: { enabled: false } },
        resources: {
          cpuRequest: '20m',
          memoryRequest: '32Mi',
          cpuLimit: '200m',
          memoryLimit: '128Mi',
        },
      },
    },
  };
  return {
    pkg,
    manifest,
    manifestBytes,
    signatureBytes,
    entryBytes,
    assetBodies,
    trustedKeys: { [keyId]: publicKeyBase64 },
  };
}

export function artifactFetch(fixture, overrides = {}) {
  const bodies = new Map([
    [fixture.pkg.spec.manifest.path, overrides.manifestBytes || fixture.manifestBytes],
    [fixture.pkg.spec.manifest.signaturePath, overrides.signatureBytes || fixture.signatureBytes],
    [`/plugins/${fixture.manifest.entry}`, overrides.entryBytes || fixture.entryBytes],
  ]);
  for (const [path, bytes] of fixture.assetBodies || []) bodies.set(path, bytes);
  return async (url) => {
    const path = new URL(url).pathname;
    if (!bodies.has(path)) {
      return new Response(JSON.stringify({ reason: 'NotFound' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = Buffer.from(bodies.get(path));
    return new Response(body, {
      status: 200,
      headers: { 'content-length': String(body.length) },
    });
  };
}

export function json(status, value) {
  return new Response(value == null ? null : JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

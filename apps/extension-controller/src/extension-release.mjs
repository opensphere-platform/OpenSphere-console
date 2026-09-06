import { createHash, createPublicKey, verify } from 'node:crypto';
import { MODULE_REPOSITORIES, verifyModulePackage } from './module-release.mjs';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const IMAGE_REPOSITORY = /^ghcr[.]io\/opensphere-platform\/[a-z0-9][a-z0-9._-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const SOURCE_REVISION = /^[a-f0-9]{40}$/u;
const SEMVER = /^[0-9]+[.][0-9]+[.][0-9]+$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PERMISSION = /^[a-z][a-z0-9._:-]{0,127}$/u;
const FILE_PATH = /^\/plugins\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}[.]js$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FORBIDDEN_ENV = /^(?:KANIDM_|TOKEN_INTROSPECTION_|KUBERNETES_|CONSOLE_OWNER_|CONSOLE_SESSION_)/u;
const MANAGED_BY = 'opensphere-extension-controller';
const IMAGE_ANNOTATION = 'opensphere.io/extension-image-digest';
const MANIFEST_ANNOTATION = 'opensphere.io/extension-manifest-sha256';
const REVISION_LABEL = 'opensphere.io/extension-revision';
const EXTENSION_LABEL = 'opensphere.io/extension-id';

function fault(message, code = 'PackageContractViolation') {
  return Object.assign(new Error(message), { code });
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function equalCanonical(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function exactPermissions(value) {
  if (!Array.isArray(value) || value.length > 128
      || value.some((item) => typeof item !== 'string' || !PERMISSION.test(item))) {
    throw fault('Extension permissions are invalid');
  }
  const sorted = [...new Set(value)].sort();
  if (sorted.length !== value.length) throw fault('Extension permissions must be unique');
  return sorted;
}

function boundedText(value, minimum, maximum) {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function exactTimestamp(value) {
  return boundedText(value, 20, 64) && Number.isFinite(Date.parse(value));
}

function exactEvidenceRefs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32
      || value.some((item) => !boundedText(item, 1, 512))) {
    throw fault('Extension release evidence is invalid');
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) throw fault('Extension release evidence must be unique');
  return unique;
}

function safeEnv(pkg) {
  const source = pkg?.spec?.env || [];
  if (!Array.isArray(source) || source.length > 64) throw fault('Extension environment contract is invalid');
  const values = [];
  const seen = new Set();
  for (const entry of source) {
    const name = typeof entry?.name === 'string' ? entry.name : '';
    const value = typeof entry?.value === 'string' ? entry.value : '';
    if (!ENV_NAME.test(name) || FORBIDDEN_ENV.test(name) || ['CONSOLE_IDENTITY_URL', 'CONSOLE_AUTH_PROVIDER'].includes(name)
        || seen.has(name) || value.length > 4096 || /[\u0000\r\n]/u.test(value)) {
      throw fault('Extension environment contract is invalid');
    }
    values.push({ name, value });
    seen.add(name);
  }
  return values;
}

function packageContract(pkg, namespace) {
  const metadata = pkg?.metadata || {};
  const spec = pkg?.spec || {};
  const name = String(metadata.name || '');
  const uid = String(metadata.uid || '');
  const repository = String(spec.image?.repository || '');
  const imageDigest = String(spec.image?.digest || '');
  const manifestSha256 = String(spec.manifest?.sha256 || '');
  const manifestPath = String(spec.manifest?.path || '/plugins/ui-shell.manifest.json');
  const signaturePath = String(spec.manifest?.signaturePath || '/plugins/ui-shell.manifest.json.sig');
  const keyId = String(spec.trust?.keyId || '');
  const resolution = spec.resolution || {};
  const runtime = spec.runtime || {};
  const security = runtime.security || {};
  const availability = runtime.availability || {};
  const permissionProfile = String(spec.permissionProfile || 'none');
  if (keyId === 'opensphere-module-local-v1'
      && (name !== 'cluster-manager' || repository !== MODULE_REPOSITORIES['cluster-manager']
        || spec.kind !== 'subShell' || !['cluster-read', 'cluster-infrastructure-manager-v1'].includes(permissionProfile))) {
    throw fault('Module signing key is restricted to the official Cluster Manager', 'ModuleReleaseInvalid');
  }
  const port = runtime.port == null ? 8080 : Number(runtime.port);
  const replicas = availability.replicas == null ? 2 : Number(availability.replicas);
  const minAvailable = availability.minAvailable == null ? 1 : Number(availability.minAvailable);
  const healthPath = String(runtime.healthPath || '/healthz');
  const contributionsBytes = (() => {
    try { return Buffer.byteLength(JSON.stringify(spec.contributions)); } catch { return Number.POSITIVE_INFINITY; }
  })();

  if (pkg?.apiVersion !== 'plugins.opensphere.io/v1alpha1' || pkg?.kind !== 'UIPluginPackage'
      || !DNS_LABEL.test(name) || uid.length < 1 || uid.length > 128 || /[\u0000-\u001f\u007f]/u.test(uid)
      || metadata.namespace !== namespace || !/^[0-9A-Za-z._:-]{1,128}$/u.test(String(metadata.resourceVersion || ''))
      || !Number.isSafeInteger(Number(metadata.generation)) || Number(metadata.generation) < 1
      || !['plugin', 'subShell'].includes(spec.kind) || !DNS_LABEL.test(String(spec.hostRef || ''))
      || !boundedText(spec.hostCompat, 1, 128) || !boundedText(spec.hostApiVersion, 1, 128)
      || !boundedText(spec.shellCompat, 1, 128) || !SEMVER.test(String(spec.version || ''))
      || !IMAGE_REPOSITORY.test(repository) || !DIGEST.test(imageDigest)
      || resolution.resolvedDigest !== imageDigest || !SOURCE_REVISION.test(String(resolution.revision || ''))
      || !boundedText(resolution.requestedRef, 1, 512)
      || !['', 'edge', 'candidate', 'stable', 'ga'].includes(resolution.requestedChannel)
      || !exactTimestamp(resolution.resolvedAt) || !/^[0-9]{12}$/u.test(String(resolution.artifactVersion || ''))
      || !['localhost', 'github-actions'].includes(resolution.buildAuthority)
      || !boundedText(resolution.source, 1, 256) || typeof resolution.registryCredentialsRequired !== 'boolean'
      || !SEMVER.test(String(resolution.compatibilityVersion || ''))
      || resolution.signatureIdentity !== keyId || !HEX_DIGEST.test(manifestSha256)
      || !FILE_PATH.test(manifestPath) || !manifestPath.endsWith('.json')
      || !FILE_PATH.test(signaturePath) || !signaturePath.endsWith('.sig') || !KEY_ID.test(keyId)
      || !spec.contributions || typeof spec.contributions !== 'object' || Array.isArray(spec.contributions)
      || contributionsBytes > 64 * 1024
      || !Number.isInteger(port) || port < 1024 || port > 65535
      || !Number.isInteger(replicas) || replicas < 1 || replicas > 20
      || !Number.isInteger(minAvailable) || minAvailable < 0 || minAvailable > replicas
      || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(healthPath)) {
    throw fault('UIPluginPackage lacks exact immutable runtime coordinates');
  }
  if (permissionProfile !== 'none' && !(['cluster-read', 'cluster-infrastructure-manager-v1'].includes(permissionProfile)
      && name === 'cluster-manager' && spec.kind === 'subShell' && spec.hostRef === 'main'
      && repository === MODULE_REPOSITORIES['cluster-manager'])) {
    throw fault('Only the signed official Cluster Manager may use its installed infrastructure profile', 'UnsupportedPermissionProfile');
  }
  if (security.runAsNonRoot === false || security.readOnlyRootFilesystem === false
      || security.automountServiceAccountToken === true || availability.autoscaling?.enabled === true
      || spec.serviceAccountName || runtime.serviceAccountName) {
    throw fault('Extension runtime weakens the target security baseline', 'UnsafeRuntimeContract');
  }
  const permissions = exactPermissions(spec.permissions || []);
  const evidenceRefs = exactEvidenceRefs(resolution.evidenceRefs);
  return Object.freeze({
    name, uid, version: String(spec.version), repository, imageDigest,
    manifestSha256, manifestPath, signaturePath, keyId,
    sourceRevision: String(resolution.revision), compatibilityVersion: String(resolution.compatibilityVersion),
    requestedRef: resolution.requestedRef, requestedChannel: resolution.requestedChannel,
    resolvedAt: resolution.resolvedAt, artifactVersion: resolution.artifactVersion,
    buildAuthority: resolution.buildAuthority, source: resolution.source,
    registryCredentialsRequired: resolution.registryCredentialsRequired, evidenceRefs,
    port, replicas, minAvailable, healthPath, permissions, permissionProfile, env: safeEnv(pkg), namespace,
  });
}

function staticContractDigest(pkg, contract) {
  const spec = pkg.spec;
  const resources = spec.runtime?.resources || {};
  const projection = {
    kind: spec.kind,
    hostRef: spec.hostRef,
    hostCompat: spec.hostCompat,
    hostApiVersion: spec.hostApiVersion,
    shellCompat: spec.shellCompat,
    contributions: spec.contributions,
    permissions: contract.permissions,
    permissionProfile: String(spec.permissionProfile || 'none'),
    env: contract.env,
    runtime: {
      port: contract.port,
      replicas: contract.replicas,
      minAvailable: contract.minAvailable,
      healthPath: contract.healthPath,
      resources: {
        cpuRequest: String(resources.cpuRequest || '20m'),
        memoryRequest: String(resources.memoryRequest || '32Mi'),
        cpuLimit: String(resources.cpuLimit || '200m'),
        memoryLimit: String(resources.memoryLimit || '128Mi'),
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(canonical(projection)), 'utf8');
  if (bytes.length > 128 * 1024) throw fault('Extension static contract is too large');
  return hash(bytes);
}

export function extensionStaticContractSha256(pkg, { namespace = 'opensphere-console' } = {}) {
  if (!DNS_LABEL.test(namespace)) throw new TypeError('Extension namespace must be a DNS label');
  return staticContractDigest(pkg, packageContract(pkg, namespace));
}

function revisionName(name, token) {
  const maximumPrefix = 63 - 3 - token.length;
  const prefix = name.slice(0, maximumPrefix).replace(/-+$/u, '');
  return `${prefix}-r-${token}`;
}

export function buildExtensionWorkloadPlan(pkg, { namespace = 'opensphere-console', trustedKeys = {} } = {}) {
  if (!DNS_LABEL.test(namespace)) throw new TypeError('Extension namespace must be a DNS label');
  const contract = packageContract(pkg, namespace);
  const clusterRead = ['cluster-read', 'cluster-infrastructure-manager-v1'].includes(contract.permissionProfile);
  const infrastructure = contract.permissionProfile === 'cluster-infrastructure-manager-v1';
  // The signed envelope binds the executable digest and the complete privilege contract.
  // Expiry blocks new discovery; it must not terminate an already admitted installation.
  if (clusterRead) verifyModulePackage(pkg, trustedKeys, { requireFresh: false });
  const staticContractSha256 = staticContractDigest(pkg, contract);
  const revision = hash(Buffer.from(`${contract.name}\n${contract.imageDigest}\n${contract.manifestSha256}`, 'utf8')).slice(0, 20);
  const revisionResourceName = revisionName(contract.name, revision);
  const serviceAccountName = infrastructure ? 'opensphere-cluster-manager-runtime' : clusterRead ? 'opensphere-cluster-manager' : revisionName(`uip-${contract.name}`, revision.slice(0, 12));
  const labels = {
    'app.kubernetes.io/name': contract.name,
    'app.kubernetes.io/managed-by': MANAGED_BY,
    ...(pkg.spec.contributions?.cli?.enabled === true ? { 'opensphere.io/command-provider': 'true' } : {}),
    [EXTENSION_LABEL]: contract.name,
    [REVISION_LABEL]: revision,
  };
  const annotations = {
    [IMAGE_ANNOTATION]: contract.imageDigest,
    [MANIFEST_ANNOTATION]: contract.manifestSha256,
  };
  const ownerReferences = [{
    apiVersion: 'plugins.opensphere.io/v1alpha1', kind: 'UIPluginPackage',
    name: contract.name, uid: contract.uid, controller: true, blockOwnerDeletion: false,
  }];
  const selector = { [EXTENSION_LABEL]: contract.name, [REVISION_LABEL]: revision };
  const resources = Object.freeze([
    ...(!clusterRead ? [Object.freeze({
      basePath: `/api/v1/namespaces/${namespace}/serviceaccounts`,
      manifest: {
        apiVersion: 'v1', kind: 'ServiceAccount',
        metadata: { name: serviceAccountName, namespace, labels, annotations, ownerReferences },
        automountServiceAccountToken: false,
      },
    })] : []),
    Object.freeze({
      basePath: `/apis/apps/v1/namespaces/${namespace}/deployments`,
      manifest: {
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: revisionResourceName, namespace, labels, annotations, ownerReferences },
        spec: {
          replicas: contract.replicas,
          strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
          selector: { matchLabels: selector },
          template: {
            metadata: { labels: { ...labels, ...selector }, annotations },
            spec: {
              serviceAccountName, automountServiceAccountToken: false,
              // The Console-owned pull credential is rotated by the Registry broker.
              // Packages cannot select another Secret or expose credentials to the container.
              imagePullSecrets: contract.registryCredentialsRequired ? [{ name: 'opensphere-ghcr-pull' }] : [],
              securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
              containers: [{
                name: 'extension', image: `${contract.repository}@${contract.imageDigest}`,
                imagePullPolicy: 'IfNotPresent', ports: [{ name: 'http', containerPort: contract.port }],
                env: [
                  { name: 'CONSOLE_IDENTITY_URL', value: 'http://opensphere-console-api.opensphere-console.svc.cluster.local:8080' },
                  { name: 'CONSOLE_AUTH_PROVIDER', value: 'supabase' },
                  ...contract.env,
                ],
                readinessProbe: { httpGet: { path: contract.healthPath, port: 'http' }, initialDelaySeconds: 2, timeoutSeconds: 3 },
                livenessProbe: { httpGet: { path: contract.healthPath, port: 'http' }, initialDelaySeconds: 10, timeoutSeconds: 3, periodSeconds: 10 },
                resources: {
                  requests: { cpu: String(pkg.spec.runtime?.resources?.cpuRequest || '20m'), memory: String(pkg.spec.runtime?.resources?.memoryRequest || '32Mi') },
                  limits: { cpu: String(pkg.spec.runtime?.resources?.cpuLimit || '200m'), memory: String(pkg.spec.runtime?.resources?.memoryLimit || '128Mi') },
                },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
                volumeMounts: [{ name: 'runtime-tmp', mountPath: '/tmp' },
                  ...(infrastructure ? [{name:'installation-policy',mountPath:'/var/run/opensphere/installation',readOnly:true}] : []),
                  ...(clusterRead ? [{ name: 'cluster-identity', mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', readOnly: true }] : [])],
              }],
              volumes: [{ name: 'runtime-tmp', emptyDir: { sizeLimit: infrastructure ? '256Mi' : '32Mi' } },
                ...(infrastructure ? [{name:'installation-policy',configMap:{name:'opensphere-installation-lock',items:[{key:'config.json',path:'config.json'}]}}] : []),
                ...(clusterRead ? [{ name: 'cluster-identity', projected: { defaultMode: 420, sources: [
                  { serviceAccountToken: { path: 'token', expirationSeconds: 3600 } },
                  { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
                ] } }] : [])],
            },
          },
        },
      },
    }),
    Object.freeze({
      basePath: `/api/v1/namespaces/${namespace}/services`,
      manifest: {
        apiVersion: 'v1', kind: 'Service',
        metadata: { name: revisionResourceName, namespace, labels, annotations, ownerReferences },
        spec: { selector, ports: [{ name: 'http', port: contract.port, targetPort: 'http' }] },
      },
    }),
    Object.freeze({
      basePath: `/apis/policy/v1/namespaces/${namespace}/poddisruptionbudgets`,
      manifest: {
        apiVersion: 'policy/v1', kind: 'PodDisruptionBudget',
        metadata: { name: revisionResourceName, namespace, labels, annotations, ownerReferences },
        spec: { minAvailable: contract.minAvailable, selector: { matchLabels: selector } },
      },
    }),
  ]);
  const activeService = Object.freeze({
    basePath: `/api/v1/namespaces/${namespace}/services`,
    manifest: {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: contract.name, namespace, labels, annotations, ownerReferences },
      spec: { selector, ports: [{ name: 'http', port: contract.port, targetPort: 'http' }] },
    },
  });
  return Object.freeze({ contract, staticContractSha256, revision, revisionResourceName, serviceAccountName, labels, annotations, resources, activeService });
}

export function planInactiveExtensionRevisionCleanup({
  plan,
  inventories,
  retainRevision = plan?.revision,
  maximumDeletes = 8,
} = {}) {
  if (!plan?.contract || !Array.isArray(plan.resources) || !Array.isArray(inventories)
      || !Number.isInteger(maximumDeletes) || maximumDeletes < 1 || maximumDeletes > 8
      || (retainRevision != null && !/^[a-f0-9]{20}$/u.test(String(retainRevision)))) {
    throw new TypeError('Extension revision cleanup planning input is invalid');
  }
  const allowed = new Map(plan.resources.map((item) => [item.basePath, Object.freeze({
    apiVersion: item.manifest.apiVersion,
    kind: item.manifest.kind,
  })]));
  if (inventories.length !== allowed.size) {
    throw fault('Extension revision inventory is incomplete', 'AuthorityContractViolation');
  }
  const seenCollections = new Set();
  const seenResources = new Set();
  const candidates = [];
  const candidateRevisions = new Set();
  let observed = 0;
  for (const inventory of inventories) {
    const basePath = String(inventory?.basePath || '');
    const kind = String(inventory?.kind || '');
    const expected = allowed.get(basePath);
    if (seenCollections.has(basePath) || expected?.kind !== kind || !Array.isArray(inventory?.items)) {
      throw fault('Extension revision inventory is outside the target allowlist', 'AuthorityContractViolation');
    }
    seenCollections.add(basePath);
    for (const resource of inventory.items) {
      observed += 1;
      if (observed > 2048) throw fault('Extension revision inventory is too large', 'AuthorityContractViolation');
      const metadata = resource?.metadata || {};
      const name = metadata.name;
      const uid = metadata.uid;
      const resourceVersion = metadata.resourceVersion;
      const labels = metadata.labels == null ? {} : metadata.labels;
      const annotations = metadata.annotations == null ? {} : metadata.annotations;
      const owners = metadata.ownerReferences == null ? [] : metadata.ownerReferences;
      if (resource?.apiVersion !== expected.apiVersion || resource?.kind !== kind
          || metadata.namespace !== plan.contract.namespace
          || typeof name !== 'string' || name.length < 1 || name.length > 253
          || /[\u0000-\u001f\u007f]/u.test(name)
          || typeof uid !== 'string' || uid.length < 1 || uid.length > 128
          || /[\u0000-\u001f\u007f]/u.test(uid)
          || typeof resourceVersion !== 'string' || !/^[0-9A-Za-z._:-]{1,128}$/u.test(resourceVersion)
          || !labels || typeof labels !== 'object' || Array.isArray(labels)
          || !annotations || typeof annotations !== 'object' || Array.isArray(annotations)
          || !Array.isArray(owners)) {
        throw fault('Extension revision inventory contains malformed Kubernetes authority', 'AuthorityContractViolation');
      }
      const claimsTargetOwner = owners.some((owner) => owner?.apiVersion === 'plugins.opensphere.io/v1alpha1'
        && owner?.kind === 'UIPluginPackage' && owner?.name === plan.contract.name);
      const stableService = kind === 'Service' && name === plan.contract.name;
      const claimsTarget = stableService
        || labels[EXTENSION_LABEL] === plan.contract.name
        || claimsTargetOwner;
      if (!claimsTarget) continue;
      const revision = String(labels[REVISION_LABEL] || '');
      const expectedName = stableService ? plan.contract.name
        : kind === 'ServiceAccount'
          ? revisionName('uip-' + plan.contract.name, revision.slice(0, 12))
          : revisionName(plan.contract.name, revision);
      const coordinate = basePath + '/' + name;
      const exactOwner = owners.some((owner) => owner?.apiVersion === 'plugins.opensphere.io/v1alpha1'
        && owner?.kind === 'UIPluginPackage' && owner?.name === plan.contract.name
        && owner?.uid === plan.contract.uid && owner?.controller === true
        && owner?.blockOwnerDeletion === false);
      const imageDigest = String(annotations[IMAGE_ANNOTATION] || '');
      const manifestSha256 = String(annotations[MANIFEST_ANNOTATION] || '');
      const expectedRevision = DIGEST.test(imageDigest) && HEX_DIGEST.test(manifestSha256)
        ? hash(Buffer.from(plan.contract.name + '\n' + imageDigest + '\n' + manifestSha256, 'utf8')).slice(0, 20)
        : '';
      const owned = labels['app.kubernetes.io/managed-by'] === MANAGED_BY
        && labels[EXTENSION_LABEL] === plan.contract.name
        && exactOwner;
      const currentEvidenceMatches = revision !== plan.revision
        || (imageDigest === plan.contract.imageDigest && manifestSha256 === plan.contract.manifestSha256);
      if (!/^[a-f0-9]{20}$/u.test(revision) || revision !== expectedRevision
          || name !== expectedName || !owned
          || !DIGEST.test(imageDigest) || !HEX_DIGEST.test(manifestSha256)
          || !currentEvidenceMatches || seenResources.has(coordinate)) {
        throw fault('Extension revision inventory contains an unowned or malformed resource', 'ResourceOwnershipMismatch');
      }
      seenResources.add(coordinate);
      if (!stableService && (retainRevision == null || revision !== retainRevision)) {
        candidateRevisions.add(revision);
        if (candidateRevisions.size > 2) {
          throw fault('Extension revision cleanup plan exceeds its revision bound', 'AuthorityContractViolation');
        }
        candidates.push(Object.freeze({
          apiPath: coordinate,
          apiVersion: expected.apiVersion,
          kind,
          name,
          uid,
          resourceVersion,
          revision,
          imageDigest,
          manifestSha256,
        }));
        if (candidates.length > maximumDeletes) {
          throw fault('Extension revision cleanup plan exceeds its deletion bound', 'AuthorityContractViolation');
        }
      }
    }
  }
  return Object.freeze(candidates.sort((left, right) => left.apiPath.localeCompare(right.apiPath)));
}

function moduleDependencySpecifiers(source) {
  const specifiers = new Set();
  const expressions = [
    /(?:^|[;}\r\n])\s*import[ \t]*(['"])([^'"\r\n]+)\1/gu,
    /(?:^|[;}\r\n])\s*(?:import|export)[ \t]+[^;\r\n]*?[ \t]+from[ \t]*(['"])([^'"\r\n]+)\1/gu,
    /\bimport[ \t]*\([ \t]*(['"])([^'"\r\n]+)\1[ \t]*\)/gu,
  ];
  for (const expression of expressions) {
    let match;
    while ((match = expression.exec(source))) specifiers.add(match[2]);
  }
  if (/\bimport[ \t]*\(/u.test(source)) specifiers.add('<dynamic-import>');
  // A member named require is an ordinary method, not the CommonJS loader.
  if (/(?:^|[^\w$.])require[ \t]*\(/u.test(source)) specifiers.add('<commonjs-require>');
  return [...specifiers];
}

async function boundedBytes(response, maximumBytes, unavailableCode) {
  if (!response?.ok) throw fault('Extension artifact is unreachable', unavailableCode);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw fault('Extension artifact exceeds its byte limit', 'ArtifactTooLarge');
  if (!response.body) throw fault('Extension artifact has no body', unavailableCode);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw fault('Extension artifact exceeds its byte limit', 'ArtifactTooLarge');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

function canonicalBase64(value, minimumBytes, maximumBytes) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumBytes * 2
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < minimumBytes || bytes.length > maximumBytes) return null;
  if (bytes.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) return null;
  return bytes;
}

export function parseTrustedExtensionKeys(value) {
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw fault('Trusted key set is invalid', 'TrustedKeysInvalid'); }
  const source = parsed?.trustedKeys;
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length > 32) {
    throw fault('Trusted key set is invalid', 'TrustedKeysInvalid');
  }
  const result = {};
  for (const [keyId, encoded] of Object.entries(source)) {
    const bytes = KEY_ID.test(keyId) ? canonicalBase64(encoded, 64, 512) : null;
    if (!bytes) throw fault('Trusted key set is invalid', 'TrustedKeysInvalid');
    try {
      const publicKey = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
      if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('unsupported Extension signing key');
      }
    } catch { throw fault('Trusted key material is invalid', 'TrustedKeysInvalid'); }
    result[keyId] = encoded;
  }
  return Object.freeze(result);
}

export async function verifyExtensionRelease({
  pkg,
  serviceName,
  namespace = 'opensphere-console',
  trustedKeys,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  manifestMaximumBytes = 256 * 1024,
  entryMaximumBytes = 4 * 1024 * 1024,
  assetMaximumBytes = 8 * 1024 * 1024,
  assetMaximumTotalBytes = 16 * 1024 * 1024,
} = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000
      || !Number.isInteger(manifestMaximumBytes) || manifestMaximumBytes < 1 || manifestMaximumBytes > 1024 * 1024
      || !Number.isInteger(entryMaximumBytes) || entryMaximumBytes < 1 || entryMaximumBytes > 16 * 1024 * 1024
      || !Number.isInteger(assetMaximumBytes) || assetMaximumBytes < 1 || assetMaximumBytes > 16 * 1024 * 1024
      || !Number.isInteger(assetMaximumTotalBytes) || assetMaximumTotalBytes < 1
      || assetMaximumTotalBytes > 64 * 1024 * 1024) {
    throw new TypeError('Extension verifier configuration is invalid');
  }
  const contract = packageContract(pkg, namespace);
  if (!DNS_LABEL.test(String(serviceName || ''))) throw fault('Revision Service name is invalid');
  const origin = `http://${serviceName}.${namespace}.svc.cluster.local:${contract.port}`;
  const fetchBytes = async (path, maximum, code) => {
    let response;
    try {
      response = await fetchImpl(origin + path, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw fault('Extension artifact dependency is unavailable', code); }
    return boundedBytes(response, maximum, code);
  };

  const manifestBytes = await fetchBytes(contract.manifestPath, manifestMaximumBytes, 'ManifestUnreachable');
  if (hash(manifestBytes) !== contract.manifestSha256) throw fault('Manifest bytes differ from the approved digest', 'ManifestDigestMismatch');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw fault('Signed manifest is invalid JSON', 'ManifestInvalid'); }
  const signatureBytes = await fetchBytes(contract.signaturePath, 16 * 1024, 'SignatureUnreachable');
  const signature = canonicalBase64(signatureBytes.toString('utf8').trim(), 64, 64);
  const spki = canonicalBase64(trustedKeys?.[contract.keyId], 64, 512);
  if (!signature || !spki) throw fault('Extension signature identity is unavailable', 'UntrustedKey');
  let verified = false;
  try {
    verified = verify('sha256', manifestBytes, {
      key: createPublicKey({ key: spki, format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363',
    }, signature);
  } catch { verified = false; }
  if (!verified) throw fault('Extension manifest signature is invalid', 'ManifestSignatureInvalid');

  if (manifest?.manifestVersion !== 3 || manifest.id !== contract.name || manifest.kind !== pkg.spec.kind
      || manifest.hostRef !== pkg.spec.hostRef || manifest.hostCompat !== pkg.spec.hostCompat
      || (manifest.hostApiVersion || '') !== (pkg.spec.hostApiVersion || '')
      || manifest.shellCompat !== pkg.spec.shellCompat || !SEMVER.test(String(manifest.sdkVersion || ''))
      || !equalCanonical(manifest.contributions, pkg.spec.contributions)
      || !equalCanonical(exactPermissions(manifest.permissions || []), contract.permissions)
      || !ENTRY.test(String(manifest.entry || '')) || !HEX_DIGEST.test(String(manifest.entrySha256 || ''))) {
    throw fault('Signed manifest differs from UIPluginPackage', 'ManifestContractMismatch');
  }
  const expectedApiBase = pkg.spec.contributions?.api?.enabled === true ? `/api/plugins/${contract.name}` : '';
  if ((manifest.apiBase || '') !== expectedApiBase
      || (pkg.spec.contributions?.api?.enabled === true && pkg.spec.contributions.api.basePath !== expectedApiBase)) {
    throw fault('Extension API namespace is not canonical', 'ApiNamespaceViolation');
  }

  const entryBytes = await fetchBytes(`/plugins/${manifest.entry}`, entryMaximumBytes, 'EntryUnreachable');
  if (hash(entryBytes) !== manifest.entrySha256) throw fault('Entry bytes differ from the signed manifest', 'EntryDigestMismatch');
  if (moduleDependencySpecifiers(entryBytes.toString('utf8')).length) {
    throw fault('Extension entry is not a closed module artifact', 'NonClosedModuleArtifact');
  }
  const manifestAssets = manifest.assets == null ? [] : manifest.assets;
  if (!Array.isArray(manifestAssets) || manifestAssets.length > 64) {
    throw fault('Signed auxiliary asset list is invalid', 'AssetContractInvalid');
  }
  const assets = [];
  const ids = new Set();
  let assetBytesUsed = 0;
  for (const asset of manifestAssets) {
    const commandData = asset?.id === 'owner-commands' && asset.type === 'data'
      && asset.path === '/contracts/owner-commands.json'
      && manifest.contributions?.cli?.enabled === true && manifest.contributions.cli.namespace === contract.name
      && manifest.contributions.cli.manifestPath === asset.path;
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(String(asset?.id || '')) || ids.has(asset.id)
        || (!['module', 'style'].includes(asset.type) && !commandData) || !HEX_DIGEST.test(String(asset.sha256 || ''))
        || (!/^\/app\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(String(asset.path || '')) && !commandData)
        || String(asset.path).includes('..')) {
      throw fault('Signed auxiliary asset contract is invalid', 'AssetContractInvalid');
    }
    ids.add(asset.id);
    const remainingBytes = assetMaximumTotalBytes - assetBytesUsed;
    const bytes = await fetchBytes(asset.path, Math.min(assetMaximumBytes, remainingBytes), 'AssetUnreachable');
    assetBytesUsed += bytes.length;
    if (hash(bytes) !== asset.sha256) throw fault('Auxiliary asset bytes differ from the signed manifest', 'AssetDigestMismatch');
    if (asset.type === 'module' && moduleDependencySpecifiers(bytes.toString('utf8')).length) {
      throw fault('Extension asset is not a closed module artifact', 'NonClosedModuleArtifact');
    }
    assets.push(Object.freeze({ id: asset.id, sha256: asset.sha256 }));
  }
  return Object.freeze({
    manifestSha256: contract.manifestSha256,
    entrySha256: manifest.entrySha256,
    keyId: contract.keyId,
    signature: 'Verified',
    assets: Object.freeze(assets),
  });
}

export const extensionReleaseContract = Object.freeze({
  managedBy: MANAGED_BY,
  imageAnnotation: IMAGE_ANNOTATION,
  manifestAnnotation: MANIFEST_ANNOTATION,
  revisionLabel: REVISION_LABEL,
  extensionLabel: EXTENSION_LABEL,
});

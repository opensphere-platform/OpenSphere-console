import { createHash, createPublicKey, verify } from 'node:crypto';

export const MODULE_RELEASE_ANNOTATION = 'opensphere.io/module-release';
export const MODULE_REPOSITORIES = Object.freeze({
  'cluster-manager': 'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager',
});
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const fault = () => Object.assign(new Error('Official module release signature or immutable package binding is invalid'), {code: 'ModuleReleaseInvalid'});
export const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/** Detached P-256 signature binds executable image, UI manifest and privileges together. */
export function verifyModuleRelease(envelope, trustedKeys, { now = Date.now(), requireFresh = true } = {}) {
  try {
    if (typeof envelope !== 'string' || Buffer.byteLength(envelope) > 96 * 1024) throw fault();
    const signed = JSON.parse(envelope);
    if (signed.schema !== 'opensphere.module-release-envelope/v1' || !/^[A-Za-z0-9._:-]{1,128}$/.test(signed.keyId || '')
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(signed.payload || '') || !/^[A-Za-z0-9+/]+={0,2}$/.test(signed.signature || '')) throw fault();
    const bytes = Buffer.from(signed.payload, 'base64');
    const key = createPublicKey({key: Buffer.from(trustedKeys[signed.keyId], 'base64'), format: 'der', type: 'spki'});
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1'
      || !verify('sha256', bytes, {key, dsaEncoding: 'ieee-p1363'}, Buffer.from(signed.signature, 'base64'))) throw fault();
    const release = JSON.parse(bytes);
    const spec = release.spec;
    if (release.schema !== 'opensphere.module-release/v1' || release.channel !== 'edge'
      || !MODULE_REPOSITORIES[release.id] || spec?.image?.repository !== MODULE_REPOSITORIES[release.id]
      || !/^sha256:[a-f0-9]{64}$/.test(spec.image.digest || '') || spec.kind !== 'subShell' || spec.hostRef !== 'main'
      || spec.trust?.keyId !== signed.keyId || spec.resolution?.requestedChannel !== release.channel
      || spec.resolution?.resolvedDigest !== spec.image.digest || spec.resolution?.buildAuthority !== 'localhost'
      || spec.resolution?.signatureIdentity !== signed.keyId || spec.permissionProfile !== 'cluster-read'
      || release.id !== 'cluster-manager') throw fault();
    const issued = Date.parse(release.issuedAt), expires = Date.parse(release.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 60_000 || expires <= issued
      || expires - issued > 90 * 86400_000 || (requireFresh && expires <= now)) throw fault();
    return Object.freeze(release);
  } catch { throw fault(); }
}

export function verifyModulePackage(pkg, trustedKeys, options = {}) {
  const release = verifyModuleRelease(pkg?.metadata?.annotations?.[MODULE_RELEASE_ANNOTATION], trustedKeys, options);
  if (pkg.metadata.name !== release.id || !equal(pkg.spec, release.spec)) throw fault();
  return release;
}

export function moduleReleaseFromIndex(index, trustedKeys, options = {}) {
  if (index?.schemaVersion !== 2 || index.mediaType !== 'application/vnd.oci.image.index.v1+json'
    || index.manifests?.length !== 1) throw fault();
  const envelope = index.annotations?.[MODULE_RELEASE_ANNOTATION];
  const release = verifyModuleRelease(envelope, trustedKeys, options);
  const child = index.manifests[0];
  if (child.digest !== release.spec.image.digest || child.platform?.os !== 'linux' || child.platform?.architecture !== 'amd64'
    || child.mediaType !== 'application/vnd.oci.image.manifest.v1+json' || !Number.isSafeInteger(child.size) || child.size < 1) throw fault();
  return {release, envelope};
}

const DESCRIPTOR_ID = /^extension\.[a-z0-9][a-z0-9-]{0,62}$/;
const CATALOG_REVISION = /^sha256:[0-9a-f]{64}$/;
const IMAGE = /^ghcr\.io\/opensphere-platform\/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$/;
const SOURCE_REVISION = /^[0-9a-f]{40}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const EVIDENCE_REF = /^[^\u0000-\u001f\u007f]{3,512}$/;

function fault(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fault(label + ' must be an object', 'AuthorityContractViolation', 502);
  }
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length) {
    throw fault(label + ' contains unknown fields: ' + unknown.join(', '), 'AuthorityContractViolation', 502);
  }
}

function configuredOrigin(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError('Registry base URL must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('Registry base URL must be an HTTP(S) origin without credentials, query, or fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

async function boundedJson(response, maximumBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw fault('Registry response exceeds the configured limit', 'AuthorityContractViolation', 502);
  }
  if (!response.body) throw fault('Registry returned no response body', 'AuthorityContractViolation', 502);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw fault('Registry response exceeds the configured limit', 'AuthorityContractViolation', 502);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length).toString('utf8'));
  } catch {
    throw fault('Registry returned invalid JSON', 'AuthorityContractViolation', 502);
  }
}

function validateEligible(document, descriptorId, catalogRevision) {
  exactObject(document, ['result', 'revision', 'candidate'], 'Registry resolution');
  if (document.result !== 'Eligible' || document.revision !== catalogRevision) {
    throw fault('Registry returned an inconsistent eligible resolution', 'AuthorityContractViolation', 502);
  }
  const candidate = document.candidate;
  exactObject(candidate, [
    'kind', 'descriptorId', 'id', 'image', 'digest', 'channel', 'catalogRevision',
    'descriptorRevision', 'executionRevision', 'sourceRevision', 'manifestDigest',
    'compatibilityVersion', 'keyId', 'evidenceRefs', 'packageResourceVersion',
    'packageGeneration', 'verification',
  ], 'Registry candidate');
  const expectedId = descriptorId.slice('extension.'.length);
  if (candidate.kind !== 'extension' || candidate.descriptorId !== descriptorId || candidate.id !== expectedId) {
    throw fault('Registry returned a different extension identity', 'AuthorityContractViolation', 502);
  }
  if (!IMAGE.test(candidate.image) || candidate.image !== candidate.executionRevision) {
    throw fault('Registry candidate lacks an exact execution image', 'AuthorityContractViolation', 502);
  }
  const digest = candidate.image.slice(candidate.image.lastIndexOf('@') + 1);
  if (candidate.digest !== digest || candidate.catalogRevision !== catalogRevision || candidate.descriptorRevision !== catalogRevision) {
    throw fault('Registry candidate revision binding is inconsistent', 'AuthorityContractViolation', 502);
  }
  if (candidate.channel !== 'edge' || !SOURCE_REVISION.test(candidate.sourceRevision)
    || !CATALOG_REVISION.test(candidate.manifestDigest) || !SEMVER.test(candidate.compatibilityVersion)
    || typeof candidate.keyId !== 'string' || candidate.keyId.length < 1 || candidate.keyId.length > 256
    || typeof candidate.packageResourceVersion !== 'string' || candidate.packageResourceVersion.length < 1
    || candidate.packageResourceVersion.length > 128 || !Number.isSafeInteger(candidate.packageGeneration)
    || candidate.packageGeneration < 1) {
    throw fault('Registry candidate supply-chain identity is incomplete', 'AuthorityContractViolation', 502);
  }
  if (!Array.isArray(candidate.evidenceRefs) || candidate.evidenceRefs.length < 2 || candidate.evidenceRefs.length > 16
    || candidate.evidenceRefs.some((ref) => typeof ref !== 'string' || !EVIDENCE_REF.test(ref))) {
    throw fault('Registry candidate evidence references are invalid', 'AuthorityContractViolation', 502);
  }
  exactObject(candidate.verification, ['catalog', 'manifest', 'signature', 'permissions'], 'Registry verification');
  if (candidate.verification.catalog !== 'Verified' || candidate.verification.manifest !== 'Verified'
    || candidate.verification.signature !== 'Verified' || candidate.verification.permissions !== 'Approved') {
    throw fault('Registry candidate is not fully verified', 'AuthorityContractViolation', 502);
  }
  return Object.freeze(structuredClone(candidate));
}

function mapResolution(document) {
  exactObject(document, ['result', 'revision', 'blockerCode', 'message'], 'Registry resolution');
  const message = String(document.message || 'Registry rejected the requested extension candidate').slice(0, 500);
  if (document.result === 'StaleRevision') throw fault(message, 'StaleAuthorityRevision', 409);
  if (document.result === 'Ineligible') throw fault(message, 'PolicyRejected', 422);
  if (document.result === 'Unavailable') throw fault(message, 'AuthorityUnavailable', 503);
  throw fault('Registry returned an unknown resolution result', 'AuthorityContractViolation', 502);
}

export function createRegistryResolver({
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  maximumResponseBytes = 64 * 1024,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('Registry timeout is invalid');
  if (!Number.isInteger(maximumResponseBytes) || maximumResponseBytes < 1024 || maximumResponseBytes > 1024 * 1024) {
    throw new TypeError('Registry response limit is invalid');
  }
  const origin = configuredOrigin(baseUrl);
  return Object.freeze({
    async resolveExtension({ descriptorId, catalogRevision, correlationId }) {
      if (!DESCRIPTOR_ID.test(String(descriptorId || '')) || !CATALOG_REVISION.test(String(catalogRevision || ''))) {
        throw fault('descriptorId and exact catalogRevision are required', 'ValidationFailed', 400);
      }
      let response;
      try {
        response = await fetchImpl(origin + '/api/v1/registry/resolve', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-correlation-id': String(correlationId || '').slice(0, 128),
          },
          body: JSON.stringify({
            kind: 'extension', id: descriptorId, revision: catalogRevision,
            architecture: 'linux/amd64', channel: 'edge',
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw fault('Registry resolution timed out', 'DependencyTimeout', 504);
        }
        throw fault('Registry & Catalog Service is unavailable', 'AuthorityUnavailable', 503);
      }
      if (!response.ok) {
        throw fault(
          response.status >= 500 ? 'Registry & Catalog Service is unavailable' : 'Registry rejected the resolution request',
          response.status >= 500 ? 'AuthorityUnavailable' : 'AuthorityContractViolation',
          response.status >= 500 ? 503 : 502,
        );
      }
      const document = await boundedJson(response, maximumResponseBytes);
      if (document?.result !== 'Eligible') return mapResolution(document);
      return validateEligible(document, descriptorId, catalogRevision);
    },
  });
}

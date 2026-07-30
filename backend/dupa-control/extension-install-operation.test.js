const assert = require('node:assert/strict');
const test = require('node:test');
const {
  evaluateInstallOperation,
  installOperationAnnotations,
  installRequestDigest,
  normalizeInstallOperationKey,
} = require('./extension-install-operation');

const key = '9c487947-148c-49c6-bae8-b9f412bc455c';
const image = `ghcr.io/opensphere-platform/opensphere-shell-foundation@sha256:${'a'.repeat(64)}`;
const requestDigest = installRequestDigest({ image, reason: '관리자 설치 재시도 검증', actor: 'operator-1' });
const annotations = installOperationAnnotations(key, requestDigest);
const pkg = {
  metadata: { name: 'foundation', annotations },
  spec: { resolution: { requestedRef: image } },
};
const registration = {
  metadata: { name: 'foundation', annotations },
  spec: { desiredState: 'Installed' },
};

test('extension install requires a bounded safe idempotency key', () => {
  assert.equal(normalizeInstallOperationKey(key), key);
  assert.throws(() => normalizeInstallOperationKey(''), /Idempotency-Key/);
  assert.throws(() => normalizeInstallOperationKey('unsafe key'), /Idempotency-Key/);
});

test('a completed byte-identical install operation is replayed', () => {
  assert.deepEqual(
    evaluateInstallOperation({ packages: [pkg], registrations: [registration], key, requestDigest, image }),
    { state: 'replay', id: 'foundation' },
  );
});

test('a partial install operation resumes instead of reporting success', () => {
  assert.deepEqual(
    evaluateInstallOperation({ packages: [pkg], registrations: [], key, requestDigest, image }),
    { state: 'resume', id: 'foundation' },
  );
});

test('reuse of an idempotency key for another payload fails closed', () => {
  assert.deepEqual(
    evaluateInstallOperation({
      packages: [pkg],
      registrations: [registration],
      key,
      requestDigest: 'b'.repeat(64),
      image,
    }),
    { state: 'conflict', id: 'foundation' },
  );
});

'use strict';

const { createHash } = require('crypto');

const INSTALL_OPERATION_KEY_ANNOTATION = 'opensphere.io/install-operation-id';
const INSTALL_REQUEST_DIGEST_ANNOTATION = 'opensphere.io/install-request-digest';
const INSTALL_OPERATION_KEY = /^[A-Za-z0-9._:-]{8,200}$/;

function normalizeInstallOperationKey(value) {
  const key = String(value || '').trim();
  if (!INSTALL_OPERATION_KEY.test(key)) {
    throw Object.assign(new Error('X-OS-Idempotency-Key must be 8-200 safe characters'), {
      code: 400,
      reason: 'IdempotencyKeyRequired',
    });
  }
  return key;
}

function installRequestDigest({ image, reason, actor }) {
  return createHash('sha256').update(JSON.stringify([
    'opensphere.extension.install/v1',
    String(image || '').trim(),
    String(reason || '').trim(),
    String(actor || '').trim(),
  ])).digest('hex');
}

function installOperationAnnotations(key, requestDigest) {
  return {
    [INSTALL_OPERATION_KEY_ANNOTATION]: normalizeInstallOperationKey(key),
    [INSTALL_REQUEST_DIGEST_ANNOTATION]: String(requestDigest || ''),
  };
}

function operationRecord(resource) {
  const annotations = resource?.metadata?.annotations || {};
  const key = String(annotations[INSTALL_OPERATION_KEY_ANNOTATION] || '');
  if (!key) return null;
  return {
    key,
    requestDigest: String(annotations[INSTALL_REQUEST_DIGEST_ANNOTATION] || ''),
    id: String(resource?.metadata?.name || ''),
    resource,
  };
}

function evaluateInstallOperation({ packages, registrations, key, requestDigest, image }) {
  const normalizedKey = normalizeInstallOperationKey(key);
  const records = [...(packages || []), ...(registrations || [])]
    .map(operationRecord)
    .filter((record) => record?.key === normalizedKey);
  if (!records.length) return { state: 'new', id: '' };

  const ids = new Set(records.map((record) => record.id));
  if (records.some((record) => record.requestDigest !== requestDigest) || ids.size !== 1) {
    return { state: 'conflict', id: [...ids][0] || '' };
  }

  const id = [...ids][0];
  const pkg = (packages || []).find((item) => item?.metadata?.name === id);
  const registration = (registrations || []).find((item) => item?.metadata?.name === id);
  const packageRecord = operationRecord(pkg);
  const registrationRecord = operationRecord(registration);
  const packageMatches = packageRecord?.key === normalizedKey
    && packageRecord.requestDigest === requestDigest
    && String(pkg?.spec?.resolution?.requestedRef || '') === String(image || '').trim();
  const registrationMatches = registrationRecord?.key === normalizedKey
    && registrationRecord.requestDigest === requestDigest
    && registration?.spec?.desiredState === 'Installed';

  return {
    state: packageMatches && registrationMatches ? 'replay' : 'resume',
    id,
  };
}

module.exports = {
  INSTALL_OPERATION_KEY_ANNOTATION,
  INSTALL_REQUEST_DIGEST_ANNOTATION,
  evaluateInstallOperation,
  installOperationAnnotations,
  installRequestDigest,
  normalizeInstallOperationKey,
  operationRecord,
};

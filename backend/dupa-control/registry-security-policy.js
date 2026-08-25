'use strict';

const REGISTRY_REMOVAL_CONFIRMATION = 'REMOVE opensphere-ghcr';

function registryRemovalConfirmed(value) {
  return String(value || '').trim() === REGISTRY_REMOVAL_CONFIRMATION;
}

function registryRevocationConfirmation(image) {
  return `REVOKE ${String(image || '').trim()}`;
}

module.exports = {
  REGISTRY_REMOVAL_CONFIRMATION,
  registryRemovalConfirmed,
  registryRevocationConfirmation,
};

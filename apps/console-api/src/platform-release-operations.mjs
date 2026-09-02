import { readFile } from 'node:fs/promises';
import platformReleaseContract from '../runtime/platform-release-contract.js';

const {
  buildComponentReleaseLock,
  releaseSummary,
} = platformReleaseContract;

const MAX_LOCK_BYTES = 256 * 1024;

function error(message, code = 'ValidationFailed', status = 400) {
  return Object.assign(new Error(message), { code, status, sideEffect: 'none' });
}

function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length) throw error(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function assertReleaseAuthority(session, { requireAal2 = false } = {}) {
  const permissionRevision = Number(session?.permissionRevision);
  const revokeEpoch = Number(session?.revokeEpoch);
  if (!session?.sessionId || !session?.subjectId || session.authorityFresh !== true
      || !Number.isSafeInteger(permissionRevision) || permissionRevision < 0
      || !Number.isSafeInteger(revokeEpoch) || revokeEpoch < 0) {
    throw error('active current Console session is required', 'AuthenticationRequired', 401);
  }
  if (!Array.isArray(session.permissions) || !session.permissions.includes('console.git.change')) {
    throw error('console.git.change permission is required', 'PermissionDenied', 403);
  }
  if (requireAal2 && session.aal !== 'aal2') {
    throw error('Platform Release component target generation requires MFA assurance aal2', 'StepUpRequired', 428);
  }
}

function releaseAuthority() {
  return Object.freeze({
    declaration: 'Gitea reviewed GovernedChange',
    execution: 'platform-release-owner',
    observed: 'opensphere-installation-lock + owner receipt',
    localKubeconfigExecution: false,
    supportedChannels: Object.freeze(['edge']),
    approvalPolicy: Object.freeze({
      localEdgeComponentApply: 'owner-mfa',
      integratedRollbackAndPromotion: 'cross-operator',
    }),
    blockedChannels: Object.freeze({
      candidate: 'integrated recovery drill is not verified',
      stable: 'integrated recovery drill is not verified',
      ga: 'signed GA lock installation is not verified',
    }),
  });
}

export function createFileInstallationReleaseStore({
  path = '/var/run/opensphere/release/release.json',
  maximumBytes = MAX_LOCK_BYTES,
} = {}) {
  if (!path || typeof path !== 'string') throw new TypeError('installation release path is required');
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1024 || maximumBytes > MAX_LOCK_BYTES) {
    throw new TypeError(`installation release maximumBytes must be between 1024 and ${MAX_LOCK_BYTES}`);
  }
  return Object.freeze({
    async readInstalled() {
      let bytes;
      try {
        bytes = await readFile(path);
      } catch (cause) {
        throw Object.assign(new Error('managed installation lock is unavailable'), {
          code: 'AuthorityUnavailable', status: 503, sideEffect: 'none', cause,
        });
      }
      if (bytes.length < 2 || bytes.length > maximumBytes) {
        throw error('managed installation lock size is invalid', 'AuthorityUnavailable', 503);
      }
      try {
        return JSON.parse(bytes.toString('utf8'));
      } catch (cause) {
        throw Object.assign(error('managed installation lock is invalid JSON', 'AuthorityUnavailable', 503), { cause });
      }
    },
  });
}

export function createPlatformReleaseOperations({ releaseStore, clock = () => new Date() }) {
  if (!releaseStore?.readInstalled) throw new TypeError('installation release store is required');
  return Object.freeze({
    async status({ session }) {
      assertReleaseAuthority(session);
      const installed = await releaseStore.readInstalled();
      let current;
      try {
        current = releaseSummary(installed, { allowInstalledAgentIdentityCutover: true });
      } catch (cause) {
        throw Object.assign(error(`managed installation lock is invalid: ${cause.message}`, 'AuthorityUnavailable', 503), { cause });
      }
      return Object.freeze({
        authority: releaseAuthority(),
        execution: Object.freeze({
          ready: false,
          state: 'Unavailable',
          blocker: 'platform_release_owner_not_target_ready',
          executorImage: null,
          desiredReplicas: null,
          availableReplicas: null,
        }),
        current: Object.freeze({ ...current, components: structuredClone(installed.components) }),
        contract: null,
        changes: Object.freeze([]),
        checkedAt: clock().toISOString(),
      });
    },

    async generateComponentTarget({ session, body }) {
      assertReleaseAuthority(session, { requireAal2: true });
      exact(body, ['sourceRevision', 'components', 'reason'], 'Platform Release component target request');
      const reason = String(body.reason || '').trim();
      if (reason.length < 8 || reason.length > 500 || /[\r\n]/u.test(reason)) {
        throw error('reason must contain 8..500 characters');
      }
      const installed = await releaseStore.readInstalled();
      let targetLock;
      try {
        targetLock = buildComponentReleaseLock(installed, {
          sourceRevision: body.sourceRevision,
          components: body.components,
        }, clock());
      } catch (cause) {
        throw Object.assign(error(cause.message), { cause });
      }
      return Object.freeze({
        targetLock,
        baseReleaseDigest: targetLock.baseReleaseDigest,
        changedComponents: Object.freeze([...targetLock.changedComponents]),
        generatedAt: clock().toISOString(),
      });
    },
  });
}

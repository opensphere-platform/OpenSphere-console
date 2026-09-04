import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionControllerReady } from '../src/readiness.mjs';

test('disabled lifecycle preserves database readiness without a Kubernetes observation', () => {
  assert.equal(extensionControllerReady({
    databaseReady: true,
    lifecycleEnabled: false,
    lifecycleAvailable: false,
    lifecycleObserved: false,
    lifecycleError: null,
  }), true);
});

test('enabled lifecycle requires availability and one successful observation with no current error', () => {
  const base = {
    databaseReady: true,
    lifecycleEnabled: true,
    lifecycleAvailable: true,
    lifecycleObserved: false,
    lifecycleError: null,
  };
  assert.equal(extensionControllerReady(base), false);
  assert.equal(extensionControllerReady({ ...base, lifecycleObserved: true }), true);
  assert.equal(extensionControllerReady({ ...base, lifecycleAvailable: false, lifecycleObserved: true }), false);
  assert.equal(extensionControllerReady({
    ...base,
    lifecycleObserved: true,
    lifecycleError: { code: 'AuthorityUnavailable' },
  }), false);
  assert.equal(extensionControllerReady({
    ...base,
    databaseReady: false,
    lifecycleObserved: true,
  }), false);
});

test('registry Kubernetes egress reconciliation is part of readiness', () => {
  const base = {
    databaseReady: true,
    lifecycleEnabled: true,
    lifecycleAvailable: true,
    lifecycleObserved: true,
    lifecycleError: null,
    egressAvailable: true,
    egressObserved: true,
    egressError: null,
  };
  assert.equal(extensionControllerReady(base), true);
  assert.equal(extensionControllerReady({ ...base, egressObserved: false }), false);
  assert.equal(extensionControllerReady({ ...base, egressError: { code: 'AuthorityUnavailable' } }), false);
});

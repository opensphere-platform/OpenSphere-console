'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const executionContext = new AsyncLocalStorage();

function activeTurnSignal() {
  return executionContext.getStore()?.signal || null;
}

function boundedSignal(timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const leaseSignal = activeTurnSignal();
  return leaseSignal ? AbortSignal.any([leaseSignal, timeoutSignal]) : timeoutSignal;
}

// Audit and post-side-effect receipts must remain writable after a turn lease
// is lost. This signal is time-bounded but deliberately not coupled to the
// active dialogue execution context.
function independentBoundedSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

function assertTurnLeaseActive() {
  const signal = activeTurnSignal();
  if (signal?.aborted) {
    throw signal.reason || {
      code: 409,
      errorCode: 'conversation_turn_lease_lost',
      msg: 'conversation turn lease was lost',
    };
  }
}

function runWithTurnSignal(signal, work) {
  if (!signal || typeof signal.aborted !== 'boolean') throw new TypeError('turn AbortSignal is required');
  if (typeof work !== 'function') throw new TypeError('turn work function is required');
  return executionContext.run({ signal }, work);
}

module.exports = {
  activeTurnSignal,
  assertTurnLeaseActive,
  boundedSignal,
  independentBoundedSignal,
  runWithTurnSignal,
};

export function extensionControllerReady({
  databaseReady,
  lifecycleEnabled,
  lifecycleAvailable,
  lifecycleObserved,
  lifecycleError,
  egressAvailable = true,
  egressObserved = true,
  egressError = null,
} = {}) {
  for (const value of [databaseReady, lifecycleEnabled, lifecycleAvailable, lifecycleObserved, egressAvailable, egressObserved]) {
    if (typeof value !== 'boolean') throw new TypeError('Extension readiness inputs must be boolean');
  }
  return databaseReady && egressAvailable && egressObserved && egressError == null && (
    !lifecycleEnabled
    || (lifecycleAvailable && lifecycleObserved && lifecycleError == null)
  );
}

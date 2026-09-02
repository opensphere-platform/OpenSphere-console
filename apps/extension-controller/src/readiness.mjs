export function extensionControllerReady({
  databaseReady,
  lifecycleEnabled,
  lifecycleAvailable,
  lifecycleObserved,
  lifecycleError,
} = {}) {
  for (const value of [databaseReady, lifecycleEnabled, lifecycleAvailable, lifecycleObserved]) {
    if (typeof value !== 'boolean') throw new TypeError('Extension readiness inputs must be boolean');
  }
  return databaseReady && (
    !lifecycleEnabled
    || (lifecycleAvailable && lifecycleObserved && lifecycleError == null)
  );
}

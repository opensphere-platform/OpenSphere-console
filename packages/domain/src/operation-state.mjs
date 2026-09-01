export const operationStates = Object.freeze([
  'Planned',
  'Authorized',
  'Submitted',
  'Reconciling',
  'Applied',
  'Verified',
  'Failed',
  'Unknown',
  'RolledBack',
]);

const transitions = Object.freeze({
  Planned: new Set(['Authorized', 'Failed']),
  Authorized: new Set(['Submitted', 'Failed']),
  Submitted: new Set(['Reconciling', 'Failed', 'Unknown']),
  Reconciling: new Set(['Applied', 'Failed', 'Unknown']),
  Applied: new Set(['Verified', 'Failed', 'Unknown', 'RolledBack']),
  Verified: new Set(['RolledBack']),
  Failed: new Set(['RolledBack']),
  Unknown: new Set(['Reconciling', 'Applied', 'Verified', 'Failed', 'RolledBack']),
  RolledBack: new Set(),
});

export function requireOperationTransition(current, next) {
  if (!operationStates.includes(current) || !operationStates.includes(next)) {
    throw new TypeError('operation state is outside the closed contract');
  }
  if (!transitions[current].has(next)) {
    throw new Error(`operation transition is not allowed: ${current} -> ${next}`);
  }
  return next;
}

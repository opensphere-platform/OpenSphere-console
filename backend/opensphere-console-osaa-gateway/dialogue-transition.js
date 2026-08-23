'use strict';

function dialogueTransitionForToolResult(result, dialogueContext = null) {
  if (!result || typeof result !== 'object') return null;
  const preservesPreparedPlan = dialogueContext?.domain === 'pfss.postgresql'
    && dialogueContext?.intent === 'create.plan'
    && dialogueContext?.phase === 'plan_ready'
    && ['r2d2.foundation-postgres-status/v1', 'r2d2.foundation-postgres-capability-answer/v1']
      .includes(result.schema);
  if (preservesPreparedPlan) return null;
  if (result.schema === 'r2d2.foundation-postgres-status/v1') {
    const claimSet = result.claimSet || result.shadowEvaluation?.claimSet || null;
    const capabilityBinding = result.capabilityBinding || result.shadowEvaluation?.capabilityBinding || null;
    return {
      domain: 'pfss.postgresql', intent: 'status.read',
      phase: result.phase === 'Observed' ? 'observed' : 'unavailable',
      targetRef: null, slots: {}, missingSlots: [],
      capabilityRef: capabilityBinding?.capabilityRef || null,
      evidenceRefs: claimSet?.evidenceRef ? [claimSet.evidenceRef] : [], operationRef: null,
    };
  }
  if (result.schema === 'r2d2.foundation-postgres-operation/v1') {
    return {
      domain: 'pfss.postgresql', intent: 'operation.watch',
      phase: result.phase === 'Observed'
        ? String(result.operationClaim?.operation?.stage || 'observed').toLowerCase()
        : 'unavailable',
      targetRef: result.operationClaim?.operation?.target || null,
      slots: {}, missingSlots: [],
      capabilityRef: result.capabilityBinding?.capabilityRef || null,
      evidenceRefs: result.operationClaim?.evidenceRef ? [result.operationClaim.evidenceRef] : [],
      operationRef: result.operationId || null,
    };
  }
  if (result.schema === 'r2d2.foundation-postgres-capability-answer/v1') {
    return {
      domain: 'pfss.postgresql', intent: String(result.question || 'capability.read'),
      phase: result.phase === 'Observed' ? 'observed' : 'unavailable',
      targetRef: null, slots: {}, missingSlots: [], capabilityRef: null,
      evidenceRefs: [], operationRef: null,
    };
  }
  if (result.action === 'binding-execute'
      && result.binding?.toolId === 'osaa.foundation.postgres.claim.create') {
    const operation = result.result?.response || result.result || {};
    return {
      domain: 'pfss.postgresql', intent: 'create.apply', phase: 'operation_accepted',
      targetRef: operation.target ? {
        namespace: operation.target.namespace || '', name: operation.target.name || '',
      } : null,
      slots: {}, missingSlots: [],
      capabilityRef: operation.capabilityBinding?.capabilityRef || null,
      evidenceRefs: [], operationRef: operation.operationId || null,
    };
  }
  if (result.schema !== 'r2d2.foundation-postgres-intake/v1') return null;
  const values = result.request || result.values || {};
  const slots = Object.fromEntries(Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => [key, { value, status: 'validated' }]));
  return {
    domain: 'pfss.postgresql', intent: 'create.plan',
    phase: result.phase === 'AwaitingConfirmation' ? 'plan_ready' : 'needs_input',
    targetRef: values.name ? { namespace: values.namespace || 'opensphere-foundation', name: values.name } : null,
    slots, missingSlots: Array.isArray(result.missing) ? result.missing : [],
    capabilityRef: result.plan?.capabilityBinding?.capabilityRef || null,
    evidenceRefs: [], operationRef: null,
  };
}

module.exports = { dialogueTransitionForToolResult };

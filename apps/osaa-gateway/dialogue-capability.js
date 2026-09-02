'use strict';

const { createHash } = require('crypto');

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const RISK_RANK = Object.freeze({ R0: 0, R1: 1, R2: 2, R3: 3 });
const TOOL_RISK = Object.freeze({ read: 'R0', low: 'R0', medium: 'R1', high: 'R2', critical: 'R3' });

const PFSS_DIALOGUE_CAPABILITY_INVENTORY = Object.freeze({
  'status.read': Object.freeze({
    semanticKey: 'pfss.postgresql.status.read', ownerOperation: 'cluster.status',
    toolId: 'osaa.foundation.postgres.status', descriptorId: null, riskClass: 'R0',
  }),
  'create.capability.check': Object.freeze({
    semanticKey: 'pfss.postgresql.create.capability.check', ownerOperation: 'catalog.read',
    toolId: 'osaa.foundation.postgres.capabilities', descriptorId: null, riskClass: 'R0',
  }),
  'create.plan': Object.freeze({
    semanticKey: 'pfss.postgresql.create.plan', ownerOperation: 'cluster.plan',
    toolId: 'osaa.foundation.postgres.plan', descriptorId: 'foundation.postgres.cluster.create', riskClass: 'R2',
  }),
  'create.apply': Object.freeze({
    semanticKey: 'pfss.postgresql.create.apply', ownerOperation: 'cluster.create',
    toolId: 'osaa.foundation.postgres.claim.create', descriptorId: 'foundation.postgres.cluster.create', riskClass: 'R2',
  }),
  'operation.watch': Object.freeze({
    semanticKey: 'pfss.postgresql.operation.watch', ownerOperation: 'operation.watch',
    toolId: 'osaa.foundation.postgres.operation.watch', descriptorId: null, riskClass: 'R0',
  }),
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function riskClass(value) {
  const normalized = String(value || '').toUpperCase();
  if (Object.hasOwn(RISK_RANK, normalized)) return normalized;
  return TOOL_RISK[String(value || '').toLowerCase()] || null;
}

function ownerContracts(owner) {
  const contracts = Array.isArray(owner?.operationContracts) ? owner.operationContracts : [];
  return new Map(contracts.map((item) => [String(item?.operation || ''), item]));
}

function unavailable(intent, reason, details = {}) {
  return {
    schema: 'osaa.dialogue-capability-binding/v1', intent, available: false,
    reason, riskClass: PFSS_DIALOGUE_CAPABILITY_INVENTORY[intent]?.riskClass || null,
    ...details,
  };
}

/**
 * Read-only semantic join. It never creates authority: a missing or divergent
 * Owner, tool, descriptor or ADR inventory member makes the capability unavailable.
 */
function joinPfssDialogueCapability(intent, inputs = {}) {
  const inventory = PFSS_DIALOGUE_CAPABILITY_INVENTORY[intent];
  if (!inventory) return unavailable(intent, 'inventory_not_registered');
  const owner = inputs.ownerCapability;
  if (owner?.schema !== 'foundation.control-capabilities/v1'
      || owner?.capability !== 'data.sql.postgres') {
    return unavailable(intent, 'owner_contract_unavailable');
  }
  if (!SHA256_RE.test(String(owner.contractDigest || '')) || !String(owner.revision || '')) {
    return unavailable(intent, 'owner_contract_not_revision_bound');
  }
  const expectedOwnerDigest = digest({
    capability: owner.capability,
    operationContracts: owner.operationContracts,
    revision: String(owner.revision),
  });
  if (owner.contractDigest !== expectedOwnerDigest) {
    return unavailable(intent, 'owner_contract_digest_mismatch');
  }
  const ownerContract = ownerContracts(owner).get(inventory.ownerOperation);
  if (!ownerContract || ownerContract.semanticKey !== inventory.semanticKey) {
    return unavailable(intent, 'owner_semantic_orphan');
  }
  const tool = (inputs.toolManifest?.tools || []).find((item) => item?.id === inventory.toolId);
  if (!tool) return unavailable(intent, 'tool_semantic_orphan');
  const observedRisks = [inventory.riskClass, riskClass(ownerContract.riskClass), riskClass(tool.riskLevel)];
  let descriptor = null;
  if (inventory.descriptorId) {
    descriptor = inputs.descriptor;
    if (descriptor?.descriptorId !== inventory.descriptorId
        || !String(descriptor?.descriptorRevision || '')
        || !SHA256_RE.test(String(descriptor?.descriptorDigest || ''))) {
      return unavailable(intent, 'descriptor_semantic_orphan');
    }
    observedRisks.push(riskClass(descriptor.riskClass));
  }
  if (observedRisks.some((item) => !item)) return unavailable(intent, 'risk_contract_incomplete');
  const effectiveRisk = observedRisks.reduce((highest, item) => (
    RISK_RANK[item] > RISK_RANK[highest] ? item : highest
  ), 'R0');
  if (RISK_RANK[effectiveRisk] < RISK_RANK[inventory.riskClass]
      || observedRisks.some((item) => RISK_RANK[item] < RISK_RANK[inventory.riskClass])) {
    return unavailable(intent, 'risk_downgrade_detected', { observedRisks });
  }
  const material = {
    semanticKey: inventory.semanticKey,
    intent,
    owner: { revision: String(owner.revision), contractDigest: owner.contractDigest, operation: inventory.ownerOperation },
    tool: { id: tool.id, riskClass: riskClass(tool.riskLevel), readOnly: tool.readOnly === true },
    descriptor: descriptor ? {
      id: descriptor.descriptorId, revision: String(descriptor.descriptorRevision), digest: descriptor.descriptorDigest,
    } : null,
    riskClass: effectiveRisk,
  };
  const bindingDigest = digest(material);
  return {
    schema: 'osaa.dialogue-capability-binding/v1', intent, available: true,
    semanticKey: inventory.semanticKey, riskClass: effectiveRisk,
    bindingDigest, capabilityRef: `${inventory.semanticKey}@${bindingDigest}`, material,
  };
}

module.exports = {
  PFSS_DIALOGUE_CAPABILITY_INVENTORY,
  RISK_RANK,
  digest,
  joinPfssDialogueCapability,
  riskClass,
};

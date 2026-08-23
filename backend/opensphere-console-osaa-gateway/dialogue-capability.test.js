'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { digest, joinPfssDialogueCapability } = require('./dialogue-capability');

function owner() {
  const operationContracts = [
    { operation: 'catalog.read', semanticKey: 'pfss.postgresql.create.capability.check', riskClass: 'R0' },
    { operation: 'cluster.plan', semanticKey: 'pfss.postgresql.create.plan', riskClass: 'R2' },
    { operation: 'cluster.create', semanticKey: 'pfss.postgresql.create.apply', riskClass: 'R2' },
    { operation: 'cluster.status', semanticKey: 'pfss.postgresql.status.read', riskClass: 'R0' },
    { operation: 'operation.watch', semanticKey: 'pfss.postgresql.operation.watch', riskClass: 'R0' },
  ];
  return {
    schema: 'foundation.control-capabilities/v1', capability: 'data.sql.postgres', revision: '2',
    contractDigest: digest({ capability: 'data.sql.postgres', operationContracts, revision: '2' }), operationContracts,
  };
}

const tools = {
  tools: [
    { id: 'osaa.foundation.postgres.status', readOnly: true, riskLevel: 'read' },
    { id: 'osaa.foundation.postgres.capabilities', readOnly: true, riskLevel: 'read' },
    { id: 'osaa.foundation.postgres.plan', readOnly: false, riskLevel: 'high' },
    { id: 'osaa.foundation.postgres.claim.create', readOnly: false, riskLevel: 'high' },
    { id: 'osaa.foundation.postgres.operation.watch', readOnly: true, riskLevel: 'read' },
  ],
};
const descriptor = {
  descriptorId: 'foundation.postgres.cluster.create', descriptorRevision: '2',
  descriptorDigest: `sha256:${'a'.repeat(64)}`, riskClass: 'R2',
};

test('semantic join produces one non-authoritative revision-bound capability reference', () => {
  const result = joinPfssDialogueCapability('create.plan', { ownerCapability: owner(), toolManifest: tools, descriptor });
  assert.equal(result.available, true);
  assert.equal(result.riskClass, 'R2');
  assert.match(result.bindingDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.capabilityRef, /^pfss\.postgresql\.create\.plan@sha256:/);
});

test('semantic join fails closed on owner, tool, or descriptor orphan', () => {
  assert.equal(joinPfssDialogueCapability('status.read', { ownerCapability: {}, toolManifest: tools }).available, false);
  assert.equal(joinPfssDialogueCapability('status.read', { ownerCapability: owner(), toolManifest: { tools: [] } }).reason, 'tool_semantic_orphan');
  assert.equal(joinPfssDialogueCapability('create.plan', { ownerCapability: owner(), toolManifest: tools, descriptor: null }).reason, 'descriptor_semantic_orphan');
});

test('R2 PFSS executable plan cannot be downgraded by owner or tool metadata', () => {
  const downgradedOwner = owner();
  downgradedOwner.operationContracts = downgradedOwner.operationContracts.map((item) => (
    item.operation === 'cluster.plan' ? { ...item, riskClass: 'R0' } : item
  ));
  downgradedOwner.contractDigest = digest({
    capability: downgradedOwner.capability,
    operationContracts: downgradedOwner.operationContracts,
    revision: downgradedOwner.revision,
  });
  assert.equal(joinPfssDialogueCapability('create.plan', {
    ownerCapability: downgradedOwner, toolManifest: tools, descriptor,
  }).reason, 'risk_downgrade_detected');
});

'use strict';

const { createHash } = require('crypto');

const STATE_SCHEMA = 'osaa.dialogue-state/v1';
const DELTA_SCHEMA = 'osaa.dialogue-state-delta/v1';
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex')}`;
}

function boundedString(value, maximum, { optional = true } = {}) {
  const result = String(value || '').trim();
  if (!result && optional) return null;
  if (!result || result.length > maximum) throw new Error(`Dialogue State string must contain 1-${maximum} characters`);
  return result;
}

function jsonObject(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return canonical(value);
}

function jsonArray(value, name, maximum = 64) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${name} must be an array with at most ${maximum} entries`);
  return canonical(value);
}

function stateMaterial(candidate, identity) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('dialogueTransition must be a server-owned object');
  }
  const allowed = new Set([
    'domain', 'intent', 'phase', 'targetRef', 'slots', 'missingSlots',
    'capabilityRef', 'evidenceRefs', 'operationRef',
  ]);
  const extra = Object.keys(candidate).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`unsupported Dialogue State fields: ${extra.join(', ')}`);
  const slots = jsonObject(candidate.slots ?? {}, 'slots') || {};
  if (Object.keys(slots).length > 32 || JSON.stringify(slots).length > 16384) {
    throw new Error('Dialogue State slots exceed the closed server budget');
  }
  return canonical({
    schema: STATE_SCHEMA,
    conversationId: identity.conversationId,
    ownerId: identity.ownerId,
    domain: boundedString(candidate.domain, 120),
    intent: boundedString(candidate.intent, 120),
    phase: boundedString(candidate.phase || 'idle', 80, { optional: false }),
    targetRef: jsonObject(candidate.targetRef, 'targetRef'),
    slots,
    missingSlots: jsonArray(candidate.missingSlots, 'missingSlots', 32).map((item) => boundedString(item, 120, { optional: false })),
    capabilityRef: boundedString(candidate.capabilityRef, 500),
    evidenceRefs: jsonArray(candidate.evidenceRefs, 'evidenceRefs'),
    operationRef: boundedString(candidate.operationRef, 36),
  });
}

function buildTransition(candidate, identity, previous = null) {
  const baseRevision = Number(previous?.revision || 0);
  const previousDigest = previous?.state_digest || digest({ schema: STATE_SCHEMA, conversationId: identity.conversationId, revision: 0 });
  if (!SHA256_RE.test(previousDigest)) throw new Error('previous Dialogue State digest is invalid');
  const material = stateMaterial(candidate, identity);
  const nextRevision = baseRevision + 1;
  const stateDigest = digest({ ...material, revision: nextRevision, prevStateDigest: previousDigest });
  const delta = canonical({
    schema: DELTA_SCHEMA,
    baseRevision,
    nextRevision,
    prevStateDigest: previousDigest,
    stateDigest,
    set: material,
  });
  return { material, baseRevision, nextRevision, previousDigest, stateDigest, delta };
}

module.exports = { DELTA_SCHEMA, SHA256_RE, STATE_SCHEMA, buildTransition, canonical, digest };

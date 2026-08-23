'use strict';

const CLOSED_PROPOSAL_FIELDS = Object.freeze(new Set(['domain', 'intent', 'slots']));

function validateProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !CLOSED_PROPOSAL_FIELDS.has(key))) return null;
  if (typeof value.domain !== 'string' || typeof value.intent !== 'string') return null;
  if (!value.slots || typeof value.slots !== 'object' || Array.isArray(value.slots)) return null;
  if (Object.keys(value.slots).length > 32 || JSON.stringify(value).length > 8192) return null;
  return { domain: value.domain.slice(0, 120), intent: value.intent.slice(0, 120), slots: value.slots };
}

/** Optional one-shot evaluation. Deterministic output always wins and no repair is attempted. */
async function evaluateProposalShadow({ deterministic, propose, enabled = false, budget = {} }) {
  if (!enabled || typeof propose !== 'function') return { deterministic, proposal: null, matched: null, calls: 0 };
  const timeoutMs = Math.max(100, Math.min(5000, Number(budget.timeoutMs || 1500)));
  let proposal = null;
  try {
    proposal = validateProposal(await Promise.race([
      Promise.resolve().then(() => propose()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('proposal_timeout')), timeoutMs)),
    ]));
  } catch { proposal = null; }
  const comparable = proposal && deterministic
    ? { domain: deterministic.domain, intent: deterministic.intent,
      slots: Object.fromEntries(Object.entries(deterministic.slots || {}).map(([key, item]) => [key, item?.value ?? item])) }
    : null;
  return {
    deterministic,
    proposal,
    matched: proposal && comparable ? JSON.stringify(proposal) === JSON.stringify(comparable) : false,
    calls: 1,
  };
}

module.exports = { evaluateProposalShadow, validateProposal };

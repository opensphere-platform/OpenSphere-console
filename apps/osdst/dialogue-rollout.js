'use strict';

const MODES = Object.freeze(['off', 'shadow', 'read-enforce', 'mutation-enforce']);

function dialogueStateMode(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return MODES.includes(candidate) ? candidate : 'off';
}

function dialogueModePolicy(value) {
  const mode = dialogueStateMode(value);
  return Object.freeze({
    mode,
    recordTransitions: mode !== 'off',
    exposeContext: mode === 'read-enforce' || mode === 'mutation-enforce',
    enforceCurrentFacts: mode === 'read-enforce' || mode === 'mutation-enforce',
    enforceMutations: mode === 'mutation-enforce',
  });
}

module.exports = { MODES, dialogueModePolicy, dialogueStateMode };

'use strict';

const SERVER_OWNED_FIELDS = Object.freeze([
  '_dialogueContext', 'dialogueState', 'dialogueTransition', 'projection', 'delta', 'revision',
  'capabilityRef', 'evidenceRefs', 'operationRef', 'stateDigest', 'dialogueMode',
]);

function assertDialogueRequestBoundary(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw { code: 400, msg: 'OSAA chat body must be an object' };
  }
  if (Object.prototype.hasOwnProperty.call(body, 'messages')) {
    throw { code: 400, msg: 'messages is server-owned; send conversationId and the current message only' };
  }
  const forged = SERVER_OWNED_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (forged.length) throw { code: 400, msg: `Dialogue State fields are server-owned: ${forged.join(', ')}` };
}

module.exports = { SERVER_OWNED_FIELDS, assertDialogueRequestBoundary };

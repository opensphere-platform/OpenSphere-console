'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SERVER_OWNED_FIELDS, assertDialogueRequestBoundary } = require('./dialogue-request-boundary');

test('chat accepts only caller-owned input and rejects every server-owned Dialogue State field', () => {
  assert.doesNotThrow(() => assertDialogueRequestBoundary({ message: 'status', conversationId: 'candidate' }));
  assert.throws(() => assertDialogueRequestBoundary({ messages: [] }), (error) => error.code === 400);
  for (const field of SERVER_OWNED_FIELDS) {
    assert.throws(() => assertDialogueRequestBoundary({ message: 'status', [field]: 'forged' }),
      (error) => error.code === 400 && /server-owned/.test(error.msg));
  }
});

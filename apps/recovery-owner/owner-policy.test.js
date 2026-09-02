'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { authorizeExternalChannel } = require('./owner-policy');

const readActor = Object.freeze({ assurance: 'aal1', permissions: ['console.recovery.read'] });
const mutationActor = Object.freeze({
  assurance: 'aal2', permissions: ['console.backup.restore', 'console.role.admin'],
});

test('C_BAK read admits recovery.read without restore, admin or AAL2', () => {
  assert.equal(authorizeExternalChannel(readActor, 'GET'), readActor);
});

test('C_BAK mutation requires backup.restore, explicit admin and AAL2', () => {
  assert.equal(authorizeExternalChannel(mutationActor, 'POST'), mutationActor);
  for (const actor of [
    { ...mutationActor, assurance: 'aal1' },
    { ...mutationActor, permissions: ['console.role.admin'] },
    { ...mutationActor, permissions: ['console.backup.restore'] },
  ]) {
    assert.throws(() => authorizeExternalChannel(actor, 'POST'), (error) => error.code === 403);
  }
});
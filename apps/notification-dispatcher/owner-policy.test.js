'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { authorizeNotification } = require('./owner-policy');

const readActor = Object.freeze({ assurance: 'aal1', permissions: ['console.notification.read'] });
const mutationActor = Object.freeze({ assurance: 'aal2', permissions: ['console.notification.manage'] });

test('C_NOTIFY read admits notification.read without AAL2', () => {
  assert.equal(authorizeNotification(readActor, 'GET'), readActor);
});

test('C_NOTIFY mutation requires notification.manage and AAL2', () => {
  assert.equal(authorizeNotification(mutationActor, 'POST'), mutationActor);
  assert.throws(
    () => authorizeNotification({ ...mutationActor, assurance: 'aal1' }, 'PUT'),
    (error) => error.code === 403 && /aal2/.test(error.msg),
  );
  assert.throws(
    () => authorizeNotification(readActor, 'POST'),
    (error) => error.code === 403 && /console.notification.manage/.test(error.msg),
  );
});
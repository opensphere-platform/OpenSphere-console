'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

test('C_NOTIFY and C_BAK ship the same current-owner admission verifier', () => {
  const notification = readFileSync(join(__dirname, 'owner-admission.js'));
  const recovery = readFileSync(join(__dirname, '..', 'recovery-owner', 'owner-admission.js'));
  assert.deepEqual(notification, recovery,
    'owner admission verifier drifted; update both isolated image contexts atomically');
});
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MODES, dialogueModePolicy, dialogueStateMode } = require('./dialogue-rollout');

test('Dialogue State rollout accepts only four server modes and otherwise fails safe to off', () => {
  assert.deepEqual(MODES, ['off', 'shadow', 'read-enforce', 'mutation-enforce']);
  assert.equal(dialogueStateMode('SHADOW'), 'shadow');
  assert.equal(dialogueStateMode('client-enforce'), 'off');
  assert.equal(dialogueStateMode(''), 'off');
});

test('shadow records without exposing or enforcing and mutation is last-stage only', () => {
  assert.deepEqual(dialogueModePolicy('shadow'), {
    mode: 'shadow', recordTransitions: true, exposeContext: false,
    enforceCurrentFacts: false, enforceMutations: false,
  });
  assert.equal(dialogueModePolicy('read-enforce').enforceMutations, false);
  assert.equal(dialogueModePolicy('mutation-enforce').enforceMutations, true);
  assert.equal(dialogueModePolicy('off').recordTransitions, false);
});

test('deployment reads the admin-owned rollout annotation and health exposes the effective server-owned mode', () => {
  const deploy = fs.readFileSync(path.join(__dirname, 'deploy.yaml'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(deploy, /name: OSAA_DIALOGUE_STATE_MODE[\s\S]*fieldPath: metadata\.annotations\['opensphere\.io\/osaa-dialogue-state-mode'\]/);
  assert.doesNotMatch(deploy, /name: OSAA_DIALOGUE_STATE_MODE, value:/);
  assert.match(server, /dialogueState: \{[\s\S]*mode: OSAA_DIALOGUE_POLICY\.mode/);
  assert.match(server, /assertDialogueRequestBoundary\(body\)/);
});

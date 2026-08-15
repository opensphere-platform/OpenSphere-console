'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildRuntimePod } = require('./runtime-template');

const session = { session_id: '10000000-0000-4000-8000-000000000001', actor_id: '20000000-0000-4000-8000-000000000001',
  origin: 'https://console.test', permission_revision: `sha256:${'1'.repeat(64)}`, aal: 'aal2', release_evidence_ref: 'release://edge', generation: 2, fencing_epoch: 9 };
const config = { namespace: 'opensphere-shell-sessions', runtimeServiceAccount: 'opensphere-shell-runtime',
  runtimeImage: `ghcr.io/opensphere-platform/opensphere-os-shell-runtime@sha256:${'2'.repeat(64)}`,
  registrationURL: 'https://opensphere-shell-reconciler.opensphere-console.svc.cluster.local:8443/internal/runtime/register',
  runtimeControlURL: 'https://opensphere-shell-api.opensphere-console.svc.cluster.local:8443/api/os-shell/runtime',
  consoleAPIURL: 'https://opensphere-shell-console-api.opensphere-console.svc.cluster.local:8445' };
test('runtime Pod separates bootstrap identity while sharing only agent and PTY tmpfs channels', () => {
  const pod = buildRuntimePod(session, config); const [pty, agent] = pod.spec.containers;
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.securityContext.fsGroup, 65532);
  assert.equal(pty.securityContext.readOnlyRootFilesystem, true);
  assert.equal(agent.securityContext.readOnlyRootFilesystem, true);
  assert.equal(pty.volumeMounts.some((m) => m.name === 'bootstrap'), false);
  assert.equal(agent.volumeMounts.some((m) => m.name === 'bootstrap'), true);
  assert.equal(pty.volumeMounts.some((m) => m.name === 'agent-channel'), true);
  assert.equal(agent.volumeMounts.some((m) => m.name === 'agent-channel'), true);
  assert.equal(pty.volumeMounts.find((m) => m.name === 'agent-channel').readOnly, true);
  assert.equal(pty.volumeMounts.some((m) => m.name === 'workspace' && m.mountPath === '/home/opensphere'), true);
  assert.equal(agent.volumeMounts.some((m) => m.name === 'workspace'), false);
  assert.equal(pod.spec.volumes.find((v) => v.name === 'bootstrap').projected.defaultMode, 0o440);
  assert.equal(pod.spec.volumes.find((v) => v.name === 'bootstrap').projected.sources[0].serviceAccountToken.audience, 'opensphere-shell-runtime-bootstrap');
  assert.match(pty.image, /@sha256:/); assert.equal(pty.image, agent.image);
  const env = Object.fromEntries(agent.env.map((entry) => [entry.name, entry.value]));
  assert.match(env.OPENSPHERE_SHELL_REGISTRATION_URL, /opensphere-shell-reconciler/);
  assert.match(env.OPENSPHERE_SHELL_CONTROL_URL, /opensphere-shell-api/);
  assert.equal(env.OPENSPHERE_SHELL_CONSOLE_API_URL, config.consoleAPIURL);
  const ptyEnv = Object.fromEntries(pty.env.map((entry) => [entry.name, entry.value]));
  assert.match(ptyEnv.OPENSPHERE_SHELL_CONSOLE_API_URL, /opensphere-shell-console-api/);
  assert.equal(pty.volumeMounts.some((m) => m.name === 'control-ca' && m.readOnly), true);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  projectVerifiedLiveToolObservation,
  renderVerifiedLiveToolObservation,
} = require('./live-tool-observation');

test('actual runtime tool results become one deterministic typed observation', () => {
  const observation = projectVerifiedLiveToolObservation([{
    tool: 'list_kubernetes_resources',
    arguments: { kind: 'pod', namespace: 'opensphere-foundation' },
    result: { items: [{ name: 'api-0', phase: 'Running' }], count: 1 },
  }]);
  assert.equal(observation.epistemicState, 'known');
  const rendered = renderVerifiedLiveToolObservation(observation);
  assert.match(rendered, /list_kubernetes_resources/);
  assert.match(rendered, /opensphere-foundation/);
  assert.match(rendered, /api-0/);
  assert.match(rendered, /"count": 1/);
});

test('knowledge, source, and planning tools cannot verify a current runtime fact', () => {
  const observation = projectVerifiedLiveToolObservation([
    { tool: 'search_opensphere_knowledge', result: { items: ['manual claim'] } },
    { tool: 'plan_foundation_postgres_cluster', result: { ready: true } },
  ]);
  assert.equal(observation.epistemicState, 'unobservable');
  assert.equal(renderVerifiedLiveToolObservation(observation), '');
});

test('tool failures are rendered as deterministic unavailability, not provider prose', () => {
  const observation = projectVerifiedLiveToolObservation([{
    tool: 'get_cluster_pod_summary',
    arguments: {},
    result: { ok: false, error: 'Kubernetes owner unavailable' },
  }]);
  const rendered = renderVerifiedLiveToolObservation(observation);
  assert.match(rendered, /unavailable/);
  assert.match(rendered, /Kubernetes owner unavailable/);
});

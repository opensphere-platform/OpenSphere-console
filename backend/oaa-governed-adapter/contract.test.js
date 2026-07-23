const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const here = __dirname;
const serverSource = fs.readFileSync(path.join(here, 'server.js'), 'utf8');
const deploy = fs.readFileSync(path.join(here, 'deploy.yaml'), 'utf8');
const migration = fs.readFileSync(path.join(here, '..', 'supabase', 'migrations', '0013_oaa_agent_control_plane.sql'), 'utf8');
const knowledgeRevisionMigration = fs.readFileSync(path.join(here, '..', 'supabase', 'migrations', '0015_oaa_knowledge_revisions.sql'), 'utf8');
const runtimeWatchMigration = fs.readFileSync(path.join(here, '..', 'supabase', 'migrations', '0016_oaa_runtime_watch.sql'), 'utf8');
const watchObserverMigration = fs.readFileSync(path.join(here, '..', 'supabase', 'migrations', '0017_oaa_watch_observer.sql'), 'utf8');
const ownerProjectionMigration = fs.readFileSync(path.join(here, '..', 'supabase', 'migrations', '0018_oaa_owner_api_projection.sql'), 'utf8');
const evidenceCorrelationMigration = fs.readFileSync(path.join(here, '..', 'supabase', 'migrations', '0019_oaa_evidence_correlation_retention.sql'), 'utf8');
const gateway = fs.readFileSync(path.join(here, '..', 'opensphere-console-oaa-gateway', 'server.js'), 'utf8');
const gatewayDeploy = fs.readFileSync(path.join(here, '..', 'opensphere-console-oaa-gateway', 'deploy.yaml'), 'utf8');
const backend = fs.readFileSync(path.join(here, '..', 'opensphere-console-backend', 'server.js'), 'utf8');
const { canonicalJson, deploymentTarget, resourceTarget, resourcePath, rolloutComplete, workloadRolloutComplete, validateManifest, sha256 } = require('./server.js');
const { RUNTIME_RESOURCE_KINDS, sanitizeKubernetesObject } = require('../opensphere-console-oaa-gateway/kubernetes-resource-catalog.js');
const { normalizeProviderToolCalls, parseDsmlToolCalls } = require('../opensphere-console-oaa-gateway/provider-tool-calls.js');

test('canonical declaration digest is deterministic', () => {
  const a = { toolId: 'oaa.k8s.deployment.restart', inputs: { name: 'demo', namespace: 'opensphere-console' } };
  const b = { inputs: { namespace: 'opensphere-console', name: 'demo' }, toolId: 'oaa.k8s.deployment.restart' };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(sha256(canonicalJson(a)), sha256(canonicalJson(b)));
});

test('adapter rejects namespace and resource names outside its contract', () => {
  assert.deepEqual(
    deploymentTarget({ inputs: { namespace: 'opensphere-console', name: 'safe-deployment' } }),
    { inputs: { namespace: 'opensphere-console', name: 'safe-deployment' }, namespace: 'opensphere-console', name: 'safe-deployment' },
  );
  assert.throws(() => deploymentTarget({ inputs: { namespace: 'kube-system', name: 'x' } }), /allowlisted/);
  assert.throws(() => deploymentTarget({ inputs: { namespace: 'opensphere-console', name: '../x' } }), /invalid/);
});

test('rollout completion requires generation, updated, available, and ready observations', () => {
  const complete = { metadata: { generation: 4 }, spec: { replicas: 2 }, status: { observedGeneration: 4, updatedReplicas: 2, availableReplicas: 2, readyReplicas: 2 } };
  assert.equal(rolloutComplete(complete), true);
  assert.equal(rolloutComplete({ ...complete, status: { ...complete.status, observedGeneration: 3 } }), false);
  assert.equal(rolloutComplete({ ...complete, status: { ...complete.status, readyReplicas: 1 } }), false);
});

test('governed resource contract is allowlisted, digest pinned, and secret-free', () => {
  assert.equal(resourceTarget({ inputs: { kind: 'cronjob', namespace: 'opensphere-console', name: 'nightly' } }).kind, 'cronjob');
  assert.throws(() => resourceTarget({ inputs: { kind: 'secret', namespace: 'opensphere-console', name: 'x' } }), /allowlist/);
  assert.match(resourcePath('deployment', 'opensphere-console', 'demo', { fieldManager: 'oaa' }), /fieldManager=oaa/);
  const digest = `example.test/app@sha256:${'a'.repeat(64)}`;
  assert.doesNotThrow(() => validateManifest('deployment', 'opensphere-console', 'demo', {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { namespace: 'opensphere-console', name: 'demo' },
    spec: { template: { spec: { containers: [{ name: 'app', image: digest }] } } },
  }));
  assert.throws(() => validateManifest('deployment', 'opensphere-console', 'demo', {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { namespace: 'opensphere-console', name: 'demo' },
    spec: { template: { spec: { containers: [{ name: 'app', image: 'example.test/app:latest' }] } } },
  }), /digest pinned/);
  assert.throws(() => validateManifest('configmap', 'opensphere-console', 'demo', {
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace: 'opensphere-console', name: 'demo' }, data: { password: 'forbidden' },
  }), /secret material/);
  assert.equal(workloadRolloutComplete({ metadata: { generation: 2 }, status: { observedGeneration: 2, desiredNumberScheduled: 2, updatedNumberScheduled: 2, numberAvailable: 2, numberReady: 2 } }, 'daemonset'), true);
});

test('runtime inventory is broad but sanitizes configuration values', () => {
  for (const kind of ['node', 'persistentvolumeclaim', 'job', 'cronjob', 'ingress', 'horizontalpodautoscaler', 'customresourcedefinition', 'observabilitybinding', 'platformsupportprofile', 'uipluginregistration', 'foundationmodel', 'identitydirectorybinding']) assert.ok(RUNTIME_RESOURCE_KINDS.includes(kind));
  const binding = sanitizeKubernetesObject('observabilitybinding', {
    metadata: { name: 'opensphere-console' },
    spec: { owner: 'HIS', consumerRef: { kind: 'Deployment', namespace: 'opensphere-console', name: 'opensphere-console' }, requestedCapabilities: ['metrics', 'logs', 'traces', 'otlp'] },
    status: { phase: 'Connected', capabilities: ['metrics'], contract: { queryEndpoint: 'http://internal.example', queryTemplates: { up: 'sum(up)' } }, evidence: { unavailableCapabilities: ['logs', 'traces', 'otlp'], digest: `sha256:${'a'.repeat(64)}` } },
  });
  assert.equal(binding.phase, 'Connected');
  assert.deepEqual(binding.queryTemplates, ['up']);
  assert.equal(JSON.stringify(binding).includes('internal.example'), false);
  const configMap = sanitizeKubernetesObject('configmap', { metadata: { name: 'settings', namespace: 'opensphere-console' }, data: { password: 'never-return-this', mode: 'safe' } });
  assert.deepEqual(configMap.keys, ['mode', 'password']);
  assert.doesNotMatch(JSON.stringify(configMap), /never-return-this/);
  const registration = sanitizeKubernetesObject('uipluginregistration', {
    metadata: { name: 'cluster-manager', namespace: 'opensphere-console' },
    spec: { desiredState: 'Enabled', approval: { reason: 'private approval detail', requestedBy: 'operator' }, packageRef: { name: 'cluster-manager' } },
    status: { phase: 'Activated', currentDigest: `sha256:${'a'.repeat(64)}`, integrations: { api: { phase: 'Ready' } } },
  });
  assert.equal(registration.phase, 'Activated');
  assert.doesNotMatch(JSON.stringify(registration), /private approval detail|requestedBy/);
  const annotated = sanitizeKubernetesObject('deployment', {
    metadata: { name: 'demo', namespace: 'opensphere-console', annotations: { 'opensphere.io/source': 'release', 'opensphere.io/private-token': 'never-project-this' } },
    spec: {}, status: {},
  });
  assert.equal(annotated.metadata.annotations['opensphere.io/source'], 'release');
  assert.doesNotMatch(JSON.stringify(annotated), /never-project-this|private-token/);
});

test('agent automatic loop exposes reads while mutations remain governed', () => {
  assert.match(gateway, /AGENT_MAX_TOOL_ROUNDS = 6/);
  assert.match(gateway, /permission-filtered-read-tool-loop/);
  assert.match(gateway, /mutationsRequireExplicitCommand: true/);
  assert.match(gateway, /const OAA_MUTATION_NAMESPACES/);
  assert.match(gateway, /mutationNamespaces: OAA_MUTATION_NAMESPACES/);
  assert.match(gateway, /namespaceScope: OAA_MUTATION_NAMESPACES/);
  assert.match(gateway, /inputs\.namespace = requireMutationNamespace/);
  assert.match(gateway, /get_change_control_status/);
  assert.match(gateway, /INSERT INTO runtime_resource/);
  assert.match(gateway, /startRuntimeWatches\(\)/);
  assert.match(gateway, /persistRuntimeWatchHeartbeat/);
  assert.match(gateway, /currentObserverStreams >= expectedStreams/);
  assert.match(gateway, /watching === states\.length && errors === 0/);
  assert.doesNotMatch(gateway, /resourceVersionMatch:\s*state\.resourceVersion/);
  assert.match(gateway, /list_kubernetes_resources/);
  assert.match(gateway, /oaa\.control-plane\.status/);
  assert.match(gateway, /get_control_plane_status/);
  assert.match(gateway, /oaa\.catalog\.entities\.list/);
  assert.match(gateway, /search_catalog_entities/);
  assert.match(gateway, /get_opensphere_registry/);
  assert.match(gateway, /\/api\/oaa\/tools\/registry/);
  assert.match(gateway, /get_foundation_status/);
  assert.match(gateway, /\/api\/oaa\/tools\/foundation\/status/);
  assert.match(gateway, /query_centralized_logs/);
  assert.match(gateway, /query_distributed_traces/);
  assert.match(gateway, /oaa\.observability\.logs\.query/);
  assert.match(gateway, /oaa\.observability\.traces\.query/);
  assert.match(gateway, /\/api\/his\/observability\/\$\{kind\}/);
  assert.match(gateway, /boundedObservabilityReadInputs/);
  assert.match(gateway, /oaaObservabilityCapabilities/);
  assert.match(gateway, /observabilityCapabilities\.has\('logs'\)/);
  assert.match(gateway, /observabilityCapabilities\.has\('traces'\)/);
  const observabilityRead = gateway.slice(gateway.indexOf('function boundedObservabilityReadInputs'), gateway.indexOf('async function fixedOwnerPost'));
  assert.doesNotMatch(observabilityRead, /inputs\.(?:url|path|endpoint|query)/);
  assert.match(gateway, /source = 'owner-api'/);
  assert.match(gateway, /projectOwnerControlPlaneStatus/);
  assert.match(gateway, /lastKnown: last\.payload/);
  for (const ownerPath of [
    '/api/admin/platform-readiness/status',
    '/api/admin/observability/status',
    '/api/identity/supabase/status',
    '/api/platform/gitea/status',
    '/api/platform/contracts',
    '/api/notifications/summary',
    '/api/admin/plugins/registrations',
    '/api/v1/registry',
    '/api/catalog/entities',
    '/api/his/status',
    '/api/ceph/status',
    '/api/foundation/oaa/status',
  ]) assert.ok(gateway.includes(ownerPath), `missing owner facade ${ownerPath}`);
  assert.match(gateway, /'oaa\.control-plane\.status': 'console\.git\.change'/);
  assert.doesNotMatch(gateway, /search_catalog_entities[^]*properties:\s*\{[^}]*\b(?:url|path|endpoint)\s*:/);
  assert.doesNotMatch(gateway, /function hashEmbedding/);
  assert.match(backend, /\/api\/platform\/reconcile\/next/);
  assert.match(backend, /rpc\/claim_change_reconcile/);
});

test('owner lifecycle actions use fixed typed facades with fail-closed inputs and AAL2', () => {
  for (const toolId of [
    'oaa.platform.readiness.preflight',
    'oaa.platform.readiness.verify',
    'oaa.extension.lifecycle',
    'oaa.his.validate',
    'oaa.his.lifecycle',
    'oaa.his.observability.configure',
    'oaa.ceph.connect',
    'oaa.ceph.disconnect',
    'oaa.foundation.engine.lifecycle',
    'oaa.foundation.claim.create',
    'oaa.foundation.claim.release',
    'oaa.foundation.identity-directory.claim.create',
    'oaa.foundation.identity-directory.claim.release',
    'oaa.identity.user.create',
    'oaa.identity.user.enabled',
    'oaa.identity.role.membership',
  ]) assert.ok(gateway.includes(toolId), `missing owner action ${toolId}`);
  const ownerAction = gateway.slice(gateway.indexOf('async function executeOwnerControlAction'), gateway.indexOf('async function settledControlPlaneComponent'));
  assert.match(ownerAction, /actor\?\.assurance !== 'aal2'/);
  assert.match(ownerAction, /requireClosedOwnerInputs/);
  assert.match(ownerAction, /OAA_HIS_VALIDATION_IDS/);
  assert.match(ownerAction, /OAA_HIS_MANAGED_IDS/);
  assert.match(ownerAction, /OAA_EXTENSION_LIFECYCLE_ACTIONS/);
  assert.match(ownerAction, /\/api\/admin\/platform-readiness\/preflight/);
  assert.match(ownerAction, /\/api\/admin\/platform-readiness\/verify/);
  assert.match(ownerAction, /\/api\/admin\/plugins\/registrations\//);
  assert.match(ownerAction, /\/api\/his\/validate/);
  assert.match(ownerAction, /`\/api\/his\/\$\{action\}`/);
  assert.match(ownerAction, /\/api\/ceph\/oaa\/connect/);
  assert.match(ownerAction, /\/api\/ceph\/oaa\/disconnect/);
  assert.match(ownerAction, /\/api\/foundation\/oaa\/engines\/lifecycle/);
  assert.match(ownerAction, /\/api\/foundation\/oaa\/claims\/create/);
  assert.match(ownerAction, /\/api\/foundation\/oaa\/claims\/release/);
  assert.match(ownerAction, /\/api\/foundation\/oaa\/identity-directory\/claims\/create/);
  assert.match(ownerAction, /\/api\/foundation\/oaa\/identity-directory\/claims\/release/);
  assert.match(ownerAction, /\/api\/oaa\/owner\/identity\/actions/);
  assert.match(ownerAction, /OAA_FOUNDATION_ENGINES/);
  assert.match(ownerAction, /OAA_FOUNDATION_MODELS/);
  assert.match(ownerAction, /OAA_CONSOLE_ROLES/);
  assert.match(ownerAction, /UUID_RE/);
  assert.doesNotMatch(ownerAction, /inputs\.(?:url|path|endpoint|baseUrl)/);
  assert.match(gateway, /OAA_OWNER_ACTION_TOOL_IDS\.has\(binding\.toolId\)/);
  assert.match(gateway, /allowHisRecovery: \['oaa\.his\.validate', 'oaa\.his\.lifecycle', 'oaa\.his\.observability\.configure'\]\.includes\(binding\.toolId\)/);
  assert.match(gateway, /options\.allowHisRecovery === true && lifecycle\.clusterManagerActivated/);
  assert.match(gateway, /allowCephRecovery: \['oaa\.ceph\.connect', 'oaa\.ceph\.disconnect'\]\.includes\(binding\.toolId\)/);
  assert.match(gateway, /options\.allowCephRecovery === true && lifecycle\.clusterManagerActivated/);
  assert.match(gateway, /lifecycle\.clusterManagerActivated && \(hisRecoveryTools\.has\(tool\.id\) \|\| cephRecoveryTools\.has\(tool\.id\)\)/);
  assert.match(gateway, /options\.allowConsoleRecovery === true && OAA_ACTION_SUBMISSION_ENABLED/);
  assert.match(gateway, /consoleRecoveryTools\.has\(tool\.id\)/);
  assert.match(gateway, /status: 'applied'/);
  assert.match(gateway, /sensitiveKey\.test\(key\) \? '\[REDACTED\]'/);
  const backendAdapter = backend.slice(backend.indexOf('const OAA_ACTION_POLICY'), backend.indexOf('async function requireSupabase'));
  assert.doesNotMatch(backendAdapter, /oaa\.(?:his|ceph|extension|platform\.readiness)/);
});

test('Console identity owner tools use a fixed PII-minimized facade and independent recovery gate', () => {
  for (const toolId of [
    'oaa.identity.status',
    'oaa.identity.user.create',
    'oaa.identity.user.enabled',
    'oaa.identity.role.membership',
  ]) assert.ok(gateway.includes(toolId), `missing identity tool ${toolId}`);
  assert.match(gateway, /'oaa\.identity\.status': 'console\.identity\.manage'/);
  assert.match(gateway, /get_console_identity_status/);
  assert.match(gateway, /\/api\/oaa\/tools\/identity\/status/);
  assert.match(gateway, /backendGet\('\/api\/oaa\/owner\/identity\/status', actor\)/);
  assert.match(gateway, /allowConsoleRecovery: \['oaa\.identity\.user\.create', 'oaa\.identity\.user\.enabled', 'oaa\.identity\.role\.membership'\]\.includes\(binding\.toolId\)/);
  const ownerAction = gateway.slice(gateway.indexOf('async function executeOwnerControlAction'), gateway.indexOf('async function settledControlPlaneComponent'));
  assert.doesNotMatch(ownerAction, /inputs\.(?:url|path|endpoint|baseUrl|recoveryLink)/);
  assert.doesNotMatch(ownerAction, /createRecoveryLink|action_link|onboardingPath/);
  assert.match(backend, /Email and recovery links are intentionally excluded/);
  assert.match(backend, /last active Console administrator cannot be disabled or demoted/);
});

test('Extension security and Notification operations use typed owner facades without credential inputs', () => {
  for (const toolId of [
    'oaa.extension.security.status',
    'oaa.extension.image.inspect',
    'oaa.extension.image.revoke',
    'oaa.notification.status',
    'oaa.notification.channel.enabled',
    'oaa.notification.channel.test',
    'oaa.notification.delivery.retry',
  ]) assert.ok(gateway.includes(toolId), `missing owner tool ${toolId}`);
  assert.match(gateway, /OAA_EXTENSION_IMAGE_RE/);
  assert.match(gateway, /get_extension_security_status/);
  assert.match(gateway, /inspect_extension_image/);
  assert.match(gateway, /get_notification_status/);
  assert.match(gateway, /\/api\/oaa\/owner\/extensions\/inspect/);
  assert.match(gateway, /\/api\/oaa\/owner\/extensions\/revoke/);
  assert.match(gateway, /\/api\/oaa\/owner\/notifications\/actions/);
  assert.match(gateway, /allowExtensionSecurity: binding\.toolId === 'oaa\.extension\.image\.revoke'/);
  assert.match(gateway, /allowNotificationControl:/);
  const ownerAction = gateway.slice(gateway.indexOf('async function executeOwnerControlAction'), gateway.indexOf('async function settledControlPlaneComponent'));
  assert.match(ownerAction, /requireExtensionDigestImage/);
  assert.doesNotMatch(ownerAction, /inputs\.(?:token|password|secret|testRecipient|url|path|endpoint)/);
});

test('manual ingestion executes in its Gateway owner boundary and never enters the Kubernetes reconciler', () => {
  const executeBinding = gateway.slice(gateway.indexOf('async function executeActionBinding'), gateway.indexOf('function commandHelp'));
  assert.match(executeBinding, /binding\.toolId === 'oaa\.knowledge\.ingest-manual'/);
  assert.match(executeBinding, /manual knowledge ingestion requires MFA assurance aal2/);
  assert.match(executeBinding, /upsertManualSeedManifest/);
  assert.doesNotMatch(backend.slice(backend.indexOf('const OAA_ACTION_POLICY'), backend.indexOf('async function requireSupabase')), /oaa\.knowledge\.ingest-manual/);
  assert.doesNotMatch(serverSource, /oaa\.knowledge\.ingest-manual/);
});

test('DeepSeek DSML tool calls are normalized into the governed tool loop', () => {
  const dsml = '<｜｜DSML｜｜tool_calls>'
    + '<｜｜DSML｜｜invoke name="search_opensphere_knowledge">'
    + '<｜｜DSML｜｜parameter name="limit" string="false">8</｜｜DSML｜｜parameter>'
    + '<｜｜DSML｜｜parameter name="query" string="true">OAA Core &amp; Gateway</｜｜DSML｜｜parameter>'
    + '</｜｜DSML｜｜invoke>'
    + '</｜｜DSML｜｜tool_calls>';
  const parsed = parseDsmlToolCalls(dsml, 'test');
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'search_opensphere_knowledge');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { limit: 8, query: 'OAA Core & Gateway' });
  assert.equal(normalizeProviderToolCalls({ content: dsml }).encoding, 'deepseek-dsml');
  assert.equal(parseDsmlToolCalls('<｜｜DSML｜｜tool_calls>').malformed, true);
  assert.match(gateway, /const toolResultCache = new Map\(\)/);
  assert.match(gateway, /if \(freshToolCalls === 0\)/);
  assert.match(gateway, /Do not send a tools field on the synthesis request/);
});

test('outbox claiming and evidence ledgers are durable and least privilege', () => {
  assert.match(migration, /FOR UPDATE OF o SKIP LOCKED/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS oaa\.agent_run/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS oaa\.runtime_resource/);
  assert.match(migration, /retrieval_trace_append_only/);
  assert.match(migration, /tool_run_append_only/);
  assert.match(deploy, /resources: \[deployments, statefulsets, daemonsets\], verbs: \[get, create, patch, delete\]/);
  assert.doesNotMatch(deploy, /resources: \[secrets\]/);
  assert.match(serverSource, /confirmation contract mismatch/);
  assert.match(serverSource, /payload digest mismatch/);
  assert.match(serverSource, /application\/apply-patch\+yaml/);
  assert.match(serverSource, /propagationPolicy: 'Foreground'/);
  assert.doesNotMatch(gatewayDeploy, /resources: \[secrets\], verbs: \[[^\]]*(?:create|patch|delete)/);
  assert.match(runtimeWatchMigration, /runtime_event_append_only/);
  assert.match(runtimeWatchMigration, /payload_digest/);
  assert.match(watchObserverMigration, /PRIMARY KEY \(source, observer_id, kind, namespace\)/);
  assert.match(ownerProjectionMigration, /runtime_resource_source_freshness_idx/);
  assert.match(ownerProjectionMigration, /runtime_event_source_observed_idx/);
  assert.match(gateway, /OAA_WATCH_OBSERVER_ID/);
  assert.match(gateway, /ON CONFLICT \(source, observer_id, kind, namespace\)/);
});

test('knowledge refresh preserves historical retrieval evidence by revision', () => {
  assert.match(knowledgeRevisionMigration, /UNIQUE \(document_id, document_revision, chunk_index\)/);
  assert.match(knowledgeRevisionMigration, /ON DELETE RESTRICT/);
  assert.match(gateway, /document_revision AS "documentRevision"/);
  assert.match(gateway, /WHERE c\.active AND d\.status = 'active'/);
  assert.doesNotMatch(gateway, /DELETE FROM oaa_knowledge_chunks/);
});

test('agent runs correlate retrieval, tool, and provider evidence with governed retention', () => {
  assert.match(evidenceCorrelationMigration, /ALTER TABLE oaa\.retrieval_trace[\s\S]*agent_run_id/);
  assert.match(evidenceCorrelationMigration, /ALTER TABLE oaa\.tool_run[\s\S]*agent_run_id/);
  assert.match(evidenceCorrelationMigration, /ALTER TABLE oaa\.llm_usage_event[\s\S]*agent_run_id/);
  assert.match(evidenceCorrelationMigration, /evidence_retention_policy/);
  assert.match(evidenceCorrelationMigration, /evidence_export_receipt/);
  assert.match(evidenceCorrelationMigration, /set_evidence_retention_policy/);
  assert.match(evidenceCorrelationMigration, /No purge API is exposed/);
  assert.doesNotMatch(evidenceCorrelationMigration, /DELETE FROM oaa\.(?:agent_run|agent_step|tool_run|retrieval_trace|llm_usage_event|runtime_event)/);
  assert.match(gateway, /async function agentEvidenceDashboard/);
  assert.match(gateway, /agentRunId: agentRunRecorded \? requestId : null/);
  assert.match(gateway, /recordRetrievalTrace\(actor, query, hits, usageContext\.runId \|\| null\)/);
  assert.match(gateway, /oaa\.evidence\.retention\.update/);
  assert.match(gateway, /evidence retention update requires MFA assurance aal2/);
  assert.match(gateway, /\/api\/oaa\/admin\/evidence/);
});

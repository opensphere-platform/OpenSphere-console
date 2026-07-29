'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FOUNDATION_BOOTSTRAP_RECONCILER,
  FOUNDATION_BOOTSTRAP_CONSUMER,
  FOUNDATION_BOOTSTRAP_TARGET,
  FOUNDATION_BOOTSTRAP_CATALOG_SHA256,
  FOUNDATION_BOOTSTRAP_DESIRED_STATE,
  FOUNDATION_BOOTSTRAP_TEMPLATE,
  desiredStateDigest,
} = require('./foundation-bootstrap-contract');
const {
  FOUNDATION_BOOTSTRAP_CANARY_YAML,
  embeddedCatalogDigest,
  loadFoundationBootstrapCatalog,
} = require('./foundation-bootstrap-bundle');
const {
  supportProfileReady,
  deploymentReady,
  foundationModelInstalled,
  bootstrapCanaryReady,
  validateCatalogDocument,
  catalogSupplyChainStatus,
  assertCatalogSupplyChain,
  validateGovernedManifest,
} = require('./foundation-bootstrap-reconciler');

test('Foundation bootstrap template is a closed reviewed consumer contract', () => {
  assert.equal(FOUNDATION_BOOTSTRAP_TEMPLATE.consumerId, FOUNDATION_BOOTSTRAP_CONSUMER);
  assert.equal(FOUNDATION_BOOTSTRAP_TEMPLATE.target, FOUNDATION_BOOTSTRAP_TARGET);
  assert.equal(FOUNDATION_BOOTSTRAP_TEMPLATE.action, 'apply');
  assert.equal(FOUNDATION_BOOTSTRAP_TEMPLATE.desiredState, FOUNDATION_BOOTSTRAP_DESIRED_STATE);
  assert.match(FOUNDATION_BOOTSTRAP_CATALOG_SHA256, /^[a-f0-9]{64}$/);
  assert.match(desiredStateDigest(), /^[a-f0-9]{64}$/);
  assert.ok(FOUNDATION_BOOTSTRAP_DESIRED_STATE.securityBoundaries.some((item) => /browser/.test(item)));
});

test('embedded Foundation catalog has fixed identities and digest-pinned workload references', () => {
  const catalog = loadFoundationBootstrapCatalog();
  assert.equal(catalog.length, 21);
  assert.equal(catalog.filter((item) => item.kind === 'CustomResourceDefinition').length, 6);
  assert.equal(catalog.filter((item) => item.kind === 'Deployment').length, 1);
  assert.equal(catalog.filter((item) => item.kind === 'FoundationModel').length, 3);
  assert.equal(catalog.filter((item) => item.kind === 'FoundationClaim').length, 1);
  assert.equal(catalog.some((item) => item.name === 'foundation-models-manage'), false);
  assert.equal(embeddedCatalogDigest(), FOUNDATION_BOOTSTRAP_CATALOG_SHA256);
  assert.match(FOUNDATION_BOOTSTRAP_CANARY_YAML, /name: foundation-bootstrap-observability/);
  catalog.forEach(validateCatalogDocument);
  const deployment = catalog.find((item) => item.kind === 'Deployment');
  const images = [...deployment.document.matchAll(/(?:image:\s*|--[a-z-]+-image=)([^\s"']+)/g)]
    .map((match) => match[1]);
  assert.equal(images.length, 8);
  assert.ok(images.every((image) => /@sha256:[a-f0-9]{64}$/.test(image)));
});

test('Foundation supply-chain preflight accepts only official immutable mirrors', () => {
  const catalog = loadFoundationBootstrapCatalog();
  const status = catalogSupplyChainStatus(catalog);
  assert.equal(status.ready, true);
  assert.equal(status.checkedImages, 8);
  assert.equal(status.blockers.length, 0);
  assert.equal(assertCatalogSupplyChain(catalog).ready, true);
  const regressed = catalog.map((resource) => (
    resource.kind === 'Deployment'
      ? {
        ...resource,
        document: resource.document.replace(
          /ghcr\.io\/opensphere-platform\/mirror\/opentelemetry-collector-contrib@sha256:[a-f0-9]{64}/,
          'docker.io/otel/opentelemetry-collector-contrib@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ),
      }
      : resource
  ));
  assert.equal(catalogSupplyChainStatus(regressed).ready, false);
  assert.throws(() => assertCatalogSupplyChain(regressed), /official immutable GHCR mirror/);
});

test('catalog validation rejects identity substitution and mutable images', () => {
  assert.throws(
    () => validateCatalogDocument({
      kind: 'Deployment',
      name: 'foundation-control-plane',
      document: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: other\n',
    }),
    /identity mismatch/,
  );
  assert.throws(
    () => validateCatalogDocument({
      kind: 'Deployment',
      name: 'foundation-control-plane',
      document: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: foundation-control-plane\nspec:\n  image: example.invalid/control-plane:latest\n',
    }),
    /mutable workload or operand image/,
  );
});

test('Foundation bootstrap requires a fully observed Ready PlatformSupportProfile', () => {
  const ready = {
    metadata: { generation: 7 },
    status: {
      phase: 'Ready',
      observedGeneration: 7,
      conditions: [
        { type: 'Delivery', status: 'True' },
        { type: 'Observability', status: 'True' },
        { type: 'BackupRestore', status: 'True' },
        { type: 'SecurityPolicy', status: 'True' },
      ],
    },
  };
  assert.equal(supportProfileReady(ready), true);
  assert.equal(supportProfileReady({ ...ready, status: { ...ready.status, observedGeneration: 6 } }), false);
  assert.equal(supportProfileReady({ ...ready, status: { ...ready.status, conditions: [{ status: 'False' }] } }), false);
  assert.equal(supportProfileReady({ ...ready, status: { ...ready.status, phase: 'Degraded' } }), false);
});

test('Foundation governed manifest cannot alter catalog, target, identity, or payload digest', () => {
  const work = {
    request_id: '9dab8e1a-7432-4e28-a23a-9a8f822f2902',
    target: FOUNDATION_BOOTSTRAP_TARGET,
    reason: 'approved Foundation establishment',
  };
  const manifest = {
    apiVersion: 'platform.opensphere.io/v1alpha1',
    kind: 'GovernedChange',
    metadata: {
      requestId: work.request_id,
      consumerId: FOUNDATION_BOOTSTRAP_CONSUMER,
      payloadDigest: `sha256:${desiredStateDigest()}`,
    },
    spec: {
      action: 'apply',
      target: FOUNDATION_BOOTSTRAP_TARGET,
      reason: work.reason,
      desiredState: JSON.parse(JSON.stringify(FOUNDATION_BOOTSTRAP_DESIRED_STATE)),
    },
  };
  assert.equal(validateGovernedManifest(manifest, work), manifest);
  assert.throws(
    () => validateGovernedManifest({
      ...manifest,
      spec: { ...manifest.spec, desiredState: { ...manifest.spec.desiredState, arbitrary: true } },
    }, work),
    /does not match/,
  );
  assert.throws(
    () => validateGovernedManifest({
      ...manifest,
      metadata: { ...manifest.metadata, consumerId: 'other' },
    }, work),
    /identity mismatch/,
  );
  assert.equal(FOUNDATION_BOOTSTRAP_RECONCILER, 'foundation-bootstrap-reconciler');
});

test('Foundation deployment readiness is generation and replica exact', () => {
  const ready = {
    metadata: { generation: 4 },
    spec: { replicas: 1 },
    status: { observedGeneration: 4, updatedReplicas: 1, availableReplicas: 1, readyReplicas: 1 },
  };
  assert.equal(deploymentReady(ready), true);
  assert.equal(deploymentReady({ ...ready, status: { ...ready.status, observedGeneration: 3 } }), false);
  assert.equal(deploymentReady({ ...ready, status: { ...ready.status, readyReplicas: 0 } }), false);
});

test('PFS bootstrap completion requires Installed models and a protected Connected canary Binding', () => {
  const model = {
    metadata: { name: 'observability' },
    spec: { model: 'observability' },
    status: { phase: 'Installed' },
  };
  assert.equal(foundationModelInstalled(model, 'observability'), true);
  assert.equal(foundationModelInstalled({ ...model, status: { phase: 'Installing' } }, 'observability'), false);
  const claim = {
    metadata: {
      name: 'foundation-bootstrap-observability',
      namespace: 'opensphere-system',
      finalizers: ['foundation.opensphere.io/consumer-protect'],
    },
    spec: { model: 'observability' },
    status: { phase: 'Bound' },
  };
  const binding = {
    metadata: {
      name: 'foundation-bootstrap-observability-binding',
      namespace: 'opensphere-system',
      finalizers: ['foundation.opensphere.io/consumer-protect'],
    },
    spec: {
      claimRef: { name: 'foundation-bootstrap-observability', namespace: 'opensphere-system' },
    },
    status: { phase: 'Connected' },
  };
  assert.equal(bootstrapCanaryReady(claim, binding), true);
  assert.equal(bootstrapCanaryReady(claim, { ...binding, status: { phase: 'Degraded' } }), false);
  assert.equal(bootstrapCanaryReady(claim, {
    ...binding,
    metadata: { ...binding.metadata, finalizers: [] },
  }), false);
});

test('Console release wires the Foundation template, dedicated runtime, least-privilege RBAC and consumer ledger', () => {
  const directory = __dirname;
  const server = fs.readFileSync(path.join(directory, 'server.js'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(directory, 'Dockerfile'), 'utf8');
  const deploy = fs.readFileSync(path.join(directory, 'deploy.yaml'), 'utf8');
  const migration = fs.readFileSync(
    path.join(directory, '..', 'supabase', 'migrations', '0031_foundation_bootstrap_consumer.sql'),
    'utf8',
  );
  assert.match(server, /FOUNDATION_BOOTSTRAP_TEMPLATE_ID/);
  assert.match(server, /cloneFoundationBootstrapTemplate/);
  assert.match(server, /GITEA_RECONCILER_NAME},ceph-prerequisite-reconciler,\$\{FOUNDATION_BOOTSTRAP_RECONCILER\}/);
  assert.match(dockerfile, /foundation-bootstrap-reconciler\.js/);
  assert.match(deploy, /serviceAccountName: foundation-bootstrap-reconciler/);
  assert.match(deploy, /resourceNames: \["default"\][\s\S]*verbs: \["get"\]/);
  const supportReader = deploy.slice(
    deploy.indexOf('kind: Role\nmetadata: { name: foundation-bootstrap-support-profile-reader'),
    deploy.indexOf('\n---', deploy.indexOf('kind: Role\nmetadata: { name: foundation-bootstrap-support-profile-reader')),
  );
  assert.doesNotMatch(supportReader, /verbs: \[[^\]]*(?:create|patch|update|delete)/);
  assert.match(deploy, /command: \["node", "\/app\/opensphere-console-backend\/foundation-bootstrap-reconciler\.js"\]/);
  assert.match(deploy, /name: foundation-bootstrap-closed-catalog/);
  assert.match(deploy, /resources: \["foundationclaims"\][\s\S]{0,80}verbs: \["get", "create", "patch"\]/);
  assert.match(deploy, /resources: \["foundationbindings"\][\s\S]{0,60}verbs: \["get"\]/);
  assert.match(deploy, /FoundationModel' && object\.metadata\.name in \['identity', 'data', 'observability'\]/);
  assert.match(deploy, /FoundationClaim'[\s\S]{0,180}foundation-bootstrap-observability/);
  assert.match(deploy, /foundation-bootstrap-reconciler may mutate only the signed closed Foundation catalog/);
  assert.match(migration, /'foundation-bootstrap-reconciler'/);
  assert.match(migration, /"browserWrite":false/);
});

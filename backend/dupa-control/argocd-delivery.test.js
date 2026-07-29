const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { argocdApplicationEvidence } = require('./controller');

const argocd = (name) => fs.readFileSync(path.join(__dirname, 'argocd', name), 'utf8');

const readyApplication = {
  spec: {
    project: 'opensphere-platform-delivery',
    source: {
      repoURL: 'http://opensphere-gitea.opensphere-console-change.svc.cluster.local:3000/opensphere/platform-declarations.git',
      path: 'platform-delivery/verification', targetRevision: 'main',
    },
    destination: { server: 'https://kubernetes.default.svc', namespace: 'opensphere-platform-delivery' },
    syncPolicy: { automated: { prune: true, selfHeal: true } },
  },
  status: { sync: { status: 'Synced', revision: 'a'.repeat(40) }, health: { status: 'Healthy' } },
};

test('Delivery evidence accepts only an actual Argo CD Git revision that is Synced and Healthy', () => {
  assert.equal(argocdApplicationEvidence(readyApplication).ready, true);
  assert.equal(argocdApplicationEvidence({ ...readyApplication, status: { ...readyApplication.status, sync: { status: 'OutOfSync' } } }).ready, false);
  assert.equal(argocdApplicationEvidence({ ...readyApplication, spec: { ...readyApplication.spec, source: { ...readyApplication.spec.source, repoURL: 'https://example.invalid/other.git' } } }).sourceVerified, false);
  assert.equal(argocdApplicationEvidence({ ...readyApplication, status: { ...readyApplication.status, sync: { status: 'Synced', revision: 'main' } } }).revisionPinned, false);
});

test('Argo CD installation is version- and digest-pinned, and its evidence reader cannot mutate', () => {
  const install = argocd('kustomization.yaml');
  const app = argocd('platform-delivery-application.yaml');
  const rbac = fs.readFileSync(path.join(__dirname, 'opensphere-console-dupa-controller.yaml'), 'utf8');
  assert.match(install, /argoproj\/argo-cd\/v3\.4\.2\/manifests\/install\.yaml/);
  assert.doesNotMatch(install, /\/stable\//);
  assert.match(install, /c612d570cb6d6ff29afb72932c1bfe98a1ecc234df50f8ea4873fb7066e760fc/);
  assert.match(install, /b8469881d3cb3a73001506f0d3aaefecb9c45d2311c1e0f405d8ac538316c59d/);
  assert.match(install, /08ad0b1d280850169a790dba1393ff7a90aef951fc19632cf4d3ce4f78e679ba/);
  assert.match(app, /prune: true/);
  assert.match(app, /selfHeal: true/);
  assert.match(rbac, /name: opensphere-platform-delivery-evidence-reader/);
  assert.match(rbac, /resources: \[applications, appprojects\]/);
  assert.doesNotMatch(rbac, /opensphere-platform-delivery-evidence-reader[\s\S]{0,900}verbs: \[(?:[^\]]*create|[^\]]*update|[^\]]*patch|[^\]]*delete)/);
});

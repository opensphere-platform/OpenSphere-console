'use strict';

const { createHash } = require('crypto');
const { gunzipSync } = require('zlib');
const {
  FOUNDATION_BOOTSTRAP_CATALOG_SHA256,
} = require('./foundation-bootstrap-contract');

const OTEL_UPSTREAM_REFERENCE =
  'docker.io/otel/opentelemetry-collector-contrib@sha256:a2a52e43c1a80aa94120ad78c2db68780eb90e6d11c8db5b3ce2f6a0cc6b5029';
const OTEL_OFFICIAL_MIRROR_REFERENCE =
  'ghcr.io/opensphere-platform/mirror/opentelemetry-collector-contrib@sha256:a2a52e43c1a80aa94120ad78c2db68780eb90e6d11c8db5b3ce2f6a0cc6b5029';

// Gzip-compressed, LF-normalized closed Foundation bootstrap catalog.
// Source: OpenSphere-shell-foundation/deploy/{foundation-contracts,
// identity-directory-contracts,control-plane-rbac,control-plane,
// foundationmodels}.yaml. The operator-facing model RBAC documents are
// deliberately excluded: bootstrap writes belong only to the reconciler.
// Every workload/operand reference in this release catalog is digest pinned.
const FOUNDATION_BOOTSTRAP_BUNDLE_GZIP_BASE64 =
  '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';

// This readable appendix is part of the immutable catalog. It is the actual
// lifecycle proof: Foundation installs its required observability model and
// submits one platform-owned Claim. Only foundation-control-plane may issue
// the Binding and its Connected status.
const FOUNDATION_BOOTSTRAP_CANARY_YAML = `apiVersion: foundation.opensphere.io/v1alpha1
kind: FoundationModel
metadata:
  name: observability
spec:
  model: observability
  desiredState: Installed
  parameters: {}
---
apiVersion: foundation.opensphere.io/v1alpha1
kind: FoundationClaim
metadata:
  name: foundation-bootstrap-observability
  namespace: opensphere-system
  labels:
    opensphere.io/bootstrap-canary: foundation-establishment
spec:
  model: observability
  parameters: {}
`;

const FOUNDATION_BOOTSTRAP_RESOURCES = Object.freeze([
  ['CustomResourceDefinition', 'foundationmodels.foundation.opensphere.io', '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/foundationmodels.foundation.opensphere.io', 'contracts'],
  ['CustomResourceDefinition', 'foundationmoduledescriptors.foundation.opensphere.io', '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/foundationmoduledescriptors.foundation.opensphere.io', 'contracts'],
  ['CustomResourceDefinition', 'foundationclaims.foundation.opensphere.io', '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/foundationclaims.foundation.opensphere.io', 'contracts'],
  ['CustomResourceDefinition', 'foundationbindings.foundation.opensphere.io', '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/foundationbindings.foundation.opensphere.io', 'contracts'],
  ['CustomResourceDefinition', 'identitydirectoryclaims.foundation.opensphere.io', '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/identitydirectoryclaims.foundation.opensphere.io', 'contracts'],
  ['CustomResourceDefinition', 'identitydirectorybindings.foundation.opensphere.io', '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/identitydirectorybindings.foundation.opensphere.io', 'contracts'],
  ['ClusterRole', 'foundation-control-plane-identity-directory', '/apis/rbac.authorization.k8s.io/v1/clusterroles/foundation-control-plane-identity-directory', 'rbac'],
  ['ClusterRoleBinding', 'foundation-control-plane-identity-directory', '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/foundation-control-plane-identity-directory', 'rbac'],
  ['Namespace', 'opensphere-system', '/api/v1/namespaces/opensphere-system', 'namespace'],
  ['Namespace', 'opensphere-foundation', '/api/v1/namespaces/opensphere-foundation', 'namespace'],
  ['ServiceAccount', 'foundation-control-plane', '/api/v1/namespaces/opensphere-system/serviceaccounts/foundation-control-plane', 'rbac'],
  ['ClusterRole', 'foundation-control-plane-core', '/apis/rbac.authorization.k8s.io/v1/clusterroles/foundation-control-plane-core', 'rbac'],
  ['ClusterRoleBinding', 'foundation-control-plane-core', '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/foundation-control-plane-core', 'rbac'],
  ['Role', 'foundation-control-plane-deployer', '/apis/rbac.authorization.k8s.io/v1/namespaces/opensphere-foundation/roles/foundation-control-plane-deployer', 'rbac'],
  ['RoleBinding', 'foundation-control-plane-deployer', '/apis/rbac.authorization.k8s.io/v1/namespaces/opensphere-foundation/rolebindings/foundation-control-plane-deployer', 'rbac'],
  ['Deployment', 'foundation-control-plane', '/apis/apps/v1/namespaces/opensphere-system/deployments/foundation-control-plane', 'control-plane'],
  ['FoundationModel', 'identity', '/apis/foundation.opensphere.io/v1alpha1/foundationmodels/identity', 'models'],
  ['FoundationModel', 'data', '/apis/foundation.opensphere.io/v1alpha1/foundationmodels/data', 'models'],
  ['FoundationModuleDescriptor', 'identity', '/apis/foundation.opensphere.io/v1alpha1/foundationmoduledescriptors/identity', 'models'],
  ['FoundationModel', 'observability', '/apis/foundation.opensphere.io/v1alpha1/foundationmodels/observability', 'models'],
  ['FoundationClaim', 'foundation-bootstrap-observability', '/apis/foundation.opensphere.io/v1alpha1/namespaces/opensphere-system/foundationclaims/foundation-bootstrap-observability', 'canary'],
].map(([kind, name, path, stage]) => Object.freeze({ kind, name, path, stage })));

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function embeddedCatalogYaml() {
  const base = gunzipSync(Buffer.from(FOUNDATION_BOOTSTRAP_BUNDLE_GZIP_BASE64, 'base64'))
    .toString('utf8')
    .trimEnd()
    .replaceAll(OTEL_UPSTREAM_REFERENCE, OTEL_OFFICIAL_MIRROR_REFERENCE);
  return `${base}\n---\n${FOUNDATION_BOOTSTRAP_CANARY_YAML.trim()}\n`;
}

function embeddedCatalogDigest() {
  return sha256(embeddedCatalogYaml());
}

function loadFoundationBootstrapCatalog() {
  const yaml = embeddedCatalogYaml();
  const digest = sha256(yaml);
  if (digest !== FOUNDATION_BOOTSTRAP_CATALOG_SHA256) {
    throw new Error(`embedded Foundation bootstrap catalog digest mismatch (${digest})`);
  }
  const documents = yaml.split(/\n---\n/)
    .map((document) => document.trim())
    .filter((document) => /^apiVersion:/m.test(document));
  if (documents.length !== FOUNDATION_BOOTSTRAP_RESOURCES.length) {
    throw new Error(`embedded Foundation bootstrap catalog document count mismatch (${documents.length})`);
  }
  return FOUNDATION_BOOTSTRAP_RESOURCES.map((resource, index) => ({
    ...resource,
    document: `${documents[index]}\n`,
  }));
}

module.exports = {
  FOUNDATION_BOOTSTRAP_CANARY_YAML,
  FOUNDATION_BOOTSTRAP_RESOURCES,
  embeddedCatalogDigest,
  loadFoundationBootstrapCatalog,
  sha256,
};

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
  ['CustomResourceDefinition', 'foundationrecoveryevidences.foundation.opensphere.io', '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/foundationrecoveryevidences.foundation.opensphere.io', 'contracts'],
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

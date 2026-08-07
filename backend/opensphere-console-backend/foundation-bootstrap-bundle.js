'use strict';

const { createHash } = require('crypto');
const { gunzipSync } = require('zlib');
const {
  FOUNDATION_BOOTSTRAP_CATALOG_SHA256,
} = require('./foundation-bootstrap-contract');

const FOUNDATION_OTEL_SOURCE_IMAGE =
  'docker.io/otel/opentelemetry-collector-contrib@sha256:a2a52e43c1a80aa94120ad78c2db68780eb90e6d11c8db5b3ce2f6a0cc6b5029';
const FOUNDATION_OTEL_MIRROR_IMAGE =
  'ghcr.io/opensphere-platform/mirror-opentelemetry-collector-contrib@sha256:a2a52e43c1a80aa94120ad78c2db68780eb90e6d11c8db5b3ce2f6a0cc6b5029';
const FOUNDATION_CONTROL_PLANE_RELEASE_IMAGE =
  'ghcr.io/opensphere-platform/opensphere-foundation-control-plane@sha256:b4962bfdd15c4f206d33d9d96d99883155be8bfffccf8824c082e60755d25f7f';

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
  const bundledBase = gunzipSync(Buffer.from(FOUNDATION_BOOTSTRAP_BUNDLE_GZIP_BASE64, 'base64')).toString('utf8').trimEnd();
  const mirrorImageCount = bundledBase.split(FOUNDATION_OTEL_MIRROR_IMAGE).length - 1;
  if (mirrorImageCount !== 1) {
    throw new Error(`embedded Foundation bootstrap OTEL mirror image count mismatch (${mirrorImageCount})`);
  }
  const controlPlaneImageCount = bundledBase.split(FOUNDATION_CONTROL_PLANE_RELEASE_IMAGE).length - 1;
  if (controlPlaneImageCount !== 3) {
    throw new Error(`embedded Foundation control-plane source image count mismatch (${controlPlaneImageCount})`);
  }
  return `${bundledBase}\n---\n${FOUNDATION_BOOTSTRAP_CANARY_YAML.trim()}\n`;
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
  FOUNDATION_OTEL_SOURCE_IMAGE,
  FOUNDATION_OTEL_MIRROR_IMAGE,
  embeddedCatalogDigest,
  loadFoundationBootstrapCatalog,
  sha256,
};

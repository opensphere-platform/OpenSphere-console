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
const FOUNDATION_CONTROL_PLANE_SOURCE_IMAGE =
  'ghcr.io/opensphere-platform/foundation-control-plane@sha256:b1275c9315c48580629afe16fad7a81e16e0a666bfc3903f31a865066aa83db4';
const FOUNDATION_CONTROL_PLANE_RELEASE_IMAGE =
  'ghcr.io/opensphere-platform/opensphere-foundation-control-plane@sha256:44a3ee3ae6a1643b389dd315399bd320401d0eab0efa2fa31e9f557edfeaee01';

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
  const sourceImageCount = bundledBase.split(FOUNDATION_OTEL_SOURCE_IMAGE).length - 1;
  if (sourceImageCount !== 1) {
    throw new Error(`embedded Foundation bootstrap OTEL source image count mismatch (${sourceImageCount})`);
  }
  const controlPlaneImageCount = bundledBase.split(FOUNDATION_CONTROL_PLANE_SOURCE_IMAGE).length - 1;
  if (controlPlaneImageCount !== 1) {
    throw new Error(`embedded Foundation control-plane source image count mismatch (${controlPlaneImageCount})`);
  }
  const base = bundledBase
    .replace(FOUNDATION_OTEL_SOURCE_IMAGE, FOUNDATION_OTEL_MIRROR_IMAGE)
    .replace(FOUNDATION_CONTROL_PLANE_SOURCE_IMAGE, FOUNDATION_CONTROL_PLANE_RELEASE_IMAGE);
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
  FOUNDATION_OTEL_SOURCE_IMAGE,
  FOUNDATION_OTEL_MIRROR_IMAGE,
  embeddedCatalogDigest,
  loadFoundationBootstrapCatalog,
  sha256,
};

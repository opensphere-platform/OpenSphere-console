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
  'ghcr.io/opensphere-platform/opensphere-foundation-control-plane@sha256:aa6361275e39e52f43f88089242bc510a1954e90619725ed48ec401816b64937';

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

'use strict';

const { createHash } = require('crypto');

const FOUNDATION_BOOTSTRAP_RECONCILER = 'foundation-bootstrap-reconciler';
const FOUNDATION_BOOTSTRAP_CONSUMER = 'foundation-bootstrap';
const FOUNDATION_BOOTSTRAP_TEMPLATE_ID = 'foundation-control-plane-bootstrap';
const FOUNDATION_BOOTSTRAP_TARGET = 'foundation-control-plane/v1alpha1';
const FOUNDATION_BOOTSTRAP_CATALOG_VERSION = '20260729.1';
const FOUNDATION_BOOTSTRAP_CATALOG_SHA256 = '9dbc0bd1ae6568a89fa4e5d7dc92bf3a98dc28b5dd522cf6be99a777f0888335';

const FOUNDATION_BOOTSTRAP_DESIRED_STATE = Object.freeze({
  contract: 'opensphere.foundation.bootstrap/v1',
  catalog: Object.freeze({
    version: FOUNDATION_BOOTSTRAP_CATALOG_VERSION,
    sha256: FOUNDATION_BOOTSTRAP_CATALOG_SHA256,
    fieldManager: FOUNDATION_BOOTSTRAP_RECONCILER,
  }),
  components: Object.freeze([
    '6 versioned Foundation contract CRDs',
    'foundation-control-plane dedicated ServiceAccount and least-privilege RBAC',
    'foundation-control-plane digest-pinned Deployment',
    'identity and data FoundationModel declarations with every optional engine disabled',
    'required observability FoundationModel declaration',
    'identity FoundationModuleDescriptor',
    'Foundation-owned observability Claim→Binding connectivity canary',
  ]),
  verification: Object.freeze([
    'PlatformSupportProfile Ready at observedGeneration',
    'all 6 Foundation CRDs Established',
    'deployment/opensphere-system/foundation-control-plane rollout Ready',
    'FoundationModel identity, data and observability declarations Installed',
    'FoundationModuleDescriptor identity declaration present',
    'bootstrap observability Claim Bound and Binding Connected with consumer-protect finalizers',
  ]),
  securityBoundaries: Object.freeze([
    'browser and Foundation subShell hold no bootstrap write credential',
    'only the dedicated reconciler ServiceAccount can apply the closed catalog',
    'all workload and operand image references are exact sha256 digests',
    'only the required bootstrap observability engine is installed; optional engines remain disabled',
  ]),
});

const FOUNDATION_BOOTSTRAP_TEMPLATE = Object.freeze({
  id: FOUNDATION_BOOTSTRAP_TEMPLATE_ID,
  displayName: 'Platform Foundation Service Stack Control Plane 설립',
  consumerId: FOUNDATION_BOOTSTRAP_CONSUMER,
  action: 'apply',
  target: FOUNDATION_BOOTSTRAP_TARGET,
  reasonPlaceholder: '검증된 Platform Support Profile 위에 Foundation 계약과 Control Plane을 설립하는 사유',
  returnTo: '/p/foundation',
  desiredState: FOUNDATION_BOOTSTRAP_DESIRED_STATE,
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function desiredStateDigest() {
  return createHash('sha256').update(canonicalJson(FOUNDATION_BOOTSTRAP_DESIRED_STATE)).digest('hex');
}

function cloneFoundationBootstrapTemplate() {
  return JSON.parse(JSON.stringify(FOUNDATION_BOOTSTRAP_TEMPLATE));
}

module.exports = {
  FOUNDATION_BOOTSTRAP_RECONCILER,
  FOUNDATION_BOOTSTRAP_CONSUMER,
  FOUNDATION_BOOTSTRAP_TEMPLATE_ID,
  FOUNDATION_BOOTSTRAP_TARGET,
  FOUNDATION_BOOTSTRAP_CATALOG_VERSION,
  FOUNDATION_BOOTSTRAP_CATALOG_SHA256,
  FOUNDATION_BOOTSTRAP_DESIRED_STATE,
  FOUNDATION_BOOTSTRAP_TEMPLATE,
  canonicalJson,
  desiredStateDigest,
  cloneFoundationBootstrapTemplate,
};

import foundationBootstrapContract from '../runtime/foundation-bootstrap-contract.js';

const { FOUNDATION_BOOTSTRAP_TEMPLATE } = foundationBootstrapContract;

const CEPH_PREREQUISITE_TEMPLATE = Object.freeze({
  id: 'ceph-rook-prerequisite',
  displayName: '외부 Ceph Consumer 선행요소 설치',
  consumerId: 'ceph-prerequisites',
  action: 'apply',
  target: 'rook-ceph/v1.20.2',
  reasonPlaceholder: '외부 Ceph 연결을 위한 Rook CRD·Operator·CSI 설치 사유',
  returnTo: '/p/cluster-manager/ceph/ceph',
  desiredState: Object.freeze({
    contract: 'opensphere.ceph.rook-prerequisite/v3',
    release: Object.freeze({
      name: 'rook-ceph',
      namespace: 'rook-ceph',
      chart: 'rook-ceph',
      version: 'v1.20.2',
      sha256: '6e0f10f5ca54e618fb90dd149dc9dfbc8a4932955bff2227b692fb32069daf52',
    }),
    runtime: Object.freeze({
      name: 'opensphere-ceph-runtime',
      namespace: 'rook-ceph',
      chart: 'opensphere-ceph-runtime',
      version: '1.4.0',
    }),
    components: Object.freeze(['crds', 'operator', 'csi', 'runtime-rbac', 'data-path-verification-runtime']),
    verification: Object.freeze([
      'cephclusters.ceph.rook.io Established',
      'all ceph-csi-operator CRDs Established',
      'deployment/rook-ceph-operator Ready',
      'deployment/ceph-csi-controller-manager Ready',
      'drivers.csi.ceph.io/rook-ceph.rbd.csi.ceph.com configured',
      'namespace/opensphere-ceph-verification Pod Security restricted',
      'role/opensphere-ceph-verification-runner installed',
      'networkpolicy/opensphere-ceph-verification-default-deny installed',
    ]),
    elevatedPrivileges: Object.freeze([]),
  }),
});

const TEMPLATES = new Map([
  [FOUNDATION_BOOTSTRAP_TEMPLATE.id, FOUNDATION_BOOTSTRAP_TEMPLATE],
  [CEPH_PREREQUISITE_TEMPLATE.id, CEPH_PREREQUISITE_TEMPLATE],
]);

function denied(message, code, status) {
  throw Object.assign(new Error(message), { code, status, sideEffect: 'none' });
}

function assertAuthority(session) {
  if (!session?.sessionId || !session?.subjectId || session.authorityFresh !== true
      || !Number.isSafeInteger(Number(session.permissionRevision))
      || !Number.isSafeInteger(Number(session.revokeEpoch))) {
    denied('active current Console session is required', 'AuthenticationRequired', 401);
  }
  if (!Array.isArray(session.permissions) || !session.permissions.includes('console.git.change')) {
    denied('console.git.change permission is required', 'PermissionDenied', 403);
  }
}

export function createPlatformChangeTemplateOperations() {
  return Object.freeze({
    get({ session, templateId }) {
      assertAuthority(session);
      const template = TEMPLATES.get(String(templateId || ''));
      if (!template) denied('change template not found', 'NotFound', 404);
      return structuredClone(template);
    },
  });
}

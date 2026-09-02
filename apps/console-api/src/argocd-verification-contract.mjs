export const ARGOCD_VERIFICATION_TEMPLATE_ID = 'console.gitea.bootstrap.argocd-verification@1';
export const ARGOCD_VERIFICATION_CONFIRMATION = 'bootstrap argocd verification';
export const ARGOCD_VERIFICATION_PATH = 'platform-delivery/verification/opensphere-platform-delivery-verification.json';

export function argocdVerificationDeclaration() {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'opensphere-platform-delivery-verification',
      namespace: 'opensphere-platform-delivery',
      labels: {
        'app.kubernetes.io/name': 'opensphere-platform-delivery-verification',
        'app.kubernetes.io/part-of': 'opensphere-platform-delivery',
        'app.kubernetes.io/managed-by': 'argocd',
        'opensphere.io/capability': 'delivery.gitops',
      },
      annotations: {
        'opensphere.io/contract': 'delivery.gitops/v1',
        'opensphere.io/verification-purpose': 'argocd-repository-sync',
      },
    },
    data: {
      contract: 'delivery.gitops/v1',
      repository: 'opensphere/platform-declarations',
      path: 'platform-delivery/verification',
    },
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function isArgocdVerificationDeclaration(value) {
  return canonical(value) === canonical(argocdVerificationDeclaration());
}

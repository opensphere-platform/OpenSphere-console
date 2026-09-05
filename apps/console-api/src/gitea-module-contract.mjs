// One existing C_EXT installation operation; Git is an additional dispatch gate.
export const MODULE_TEMPLATE = 'console-cluster-manager-install';
export const MODULE_CONSUMER = 'console-modules';
export const MODULE_DESCRIPTOR = 'extension.cluster-manager';
export const MODULE_CONTRACT = 'opensphere.console.git-reviewed-module/v1';
const IMAGE = /^ghcr\.io\/opensphere-platform\/opensphere-shell-cluster-manager@sha256:[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function assertModuleDeclaration(proposal) {
  const desired = proposal?.desiredState;
  if (proposal?.templateId !== MODULE_TEMPLATE || proposal.consumerId !== MODULE_CONSUMER
      || proposal.action !== 'apply' || proposal.target !== MODULE_DESCRIPTOR
      || !desired || Object.keys(desired).sort().join(',') !== 'catalogRevision,contract,descriptorId,image'
      || desired.contract !== MODULE_CONTRACT || desired.descriptorId !== MODULE_DESCRIPTOR
      || !DIGEST.test(desired.catalogRevision) || !IMAGE.test(desired.image)) {
    throw Object.assign(new Error('지원되는 고정 Cluster Manager 설치 선언만 실행할 수 있습니다.'), {
      code: 'PolicyRejected', status: 422, sideEffect: 'none',
    });
  }
  return desired;
}

export function createGiteaModuleOwner({ registryResolver, fetchImpl = globalThis.fetch,
  ownerUrl = 'http://opensphere-extension-controller.opensphere-console.svc.cluster.local:8080' }) {
  async function ready() {
    try {
      const response = await fetchImpl(`${ownerUrl}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return false;
      const bytes = await response.text();
      if (bytes.length > 4096) return false;
      const health = JSON.parse(bytes);
      return health.state === 'Ready' && health.lifecycleEnabled === true && health.lifecycleObserved === true;
    } catch { return false; }
  }
  async function validate(proposal, correlationId) {
    const desired = assertModuleDeclaration(proposal);
    const candidate = await registryResolver.resolveExtension({
      descriptorId: MODULE_DESCRIPTOR, catalogRevision: desired.catalogRevision, correlationId,
    });
    if (candidate.image !== desired.image) throw Object.assign(new Error('승인 대상 이미지와 현재 검증된 이미지가 다릅니다.'), {
      code: 'StaleAuthorityRevision', status: 409, sideEffect: 'none',
    });
    return { schemaVersion: '1.0', authority: 'OpenSphereRegistry', descriptorId: MODULE_DESCRIPTOR,
      catalogRevision: desired.catalogRevision, image: desired.image };
  }
  async function template(correlationId) {
    const snapshot = await registryResolver.readCatalogSnapshot({ correlationId });
    const candidate = await registryResolver.resolveExtension({
      descriptorId: MODULE_DESCRIPTOR, catalogRevision: snapshot.revision, correlationId,
    });
    const result = { id: MODULE_TEMPLATE, displayName: 'Cluster Manager 설치 — Git 검토 후 적용',
      consumerId: MODULE_CONSUMER, action: 'apply', target: MODULE_DESCRIPTOR,
      reasonPlaceholder: '설치 목적과 검토 사유를 입력하세요.', returnTo: '/manage/extensions',
      desiredState: { contract: MODULE_CONTRACT, descriptorId: MODULE_DESCRIPTOR,
        catalogRevision: snapshot.revision, image: candidate.image } };
    assertModuleDeclaration({ ...result, templateId: result.id });
    return result;
  }
  return Object.freeze({ ready, validate, template });
}

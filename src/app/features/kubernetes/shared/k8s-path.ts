// [H] K8s 단일 리소스 경로 — resource-detail.singlePath() 본문 추출(외부 재사용용). 동작 불변.
export function singleResourcePath(listPath: string, namespace: string, name: string, namespaced: boolean): string {
  const i = listPath.lastIndexOf('/');
  const base = listPath.slice(0, i);
  const plural = listPath.slice(i + 1);
  return namespaced ? `${base}/namespaces/${namespace}/${plural}/${name}` : `${listPath}/${name}`;
}

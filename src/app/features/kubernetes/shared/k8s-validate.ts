// [H] RFC1123 라벨(DNS-1123) 검증 — K8s 리소스 이름 규칙. vm-create의 인라인 정규식 추출.
export function isRfc1123(s: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s);
}

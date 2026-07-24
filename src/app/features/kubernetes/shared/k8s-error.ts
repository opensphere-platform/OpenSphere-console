// [H] K8s 에러 → 사람말 추출. resource-detail.errText() 본문 추출(외부 재사용용).
export function errText(e: any): string {
  return e?.error?.message || e?.error?.error || e?.message || String(e);
}

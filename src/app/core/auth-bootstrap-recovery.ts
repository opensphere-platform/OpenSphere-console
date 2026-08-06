export const AUTH_BOOTSTRAP_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000] as const;

export function authBootstrapRetryDelay(attempt: number): number {
  const index = Math.max(0, Math.min(Math.trunc(attempt), AUTH_BOOTSTRAP_RETRY_DELAYS_MS.length - 1));
  return AUTH_BOOTSTRAP_RETRY_DELAYS_MS[index];
}

export function isRetryableAuthBootstrapStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

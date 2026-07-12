export const DEFAULT_TOTP_ENABLED = false;

export function parsePolicyBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'enabled', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'disabled', 'off'].includes(normalized)) return false;
  return fallback;
}

// AG-5: 운영 환경(production)은 TOTP를 강제한다. environment는 배포 env(envOverride)가 우선하며,
// production이면 (a) totpEnabled를 항상 true로 강제하고 (b) enforced=true로 표시해 관리자가 끄지 못하게 한다.
// envOverride가 없으면 ConfigMap의 environment를 쓴다(로컬/개발은 development 기본 → 기존 동작 유지).
export function authPolicyFromConfigMap(configMap, fallback = DEFAULT_TOTP_ENABLED, envOverride) {
  const data = configMap?.data ?? {};
  const environment = (envOverride && String(envOverride).trim()) || data.environment || 'development';
  const production = environment === 'production';
  const configured = parsePolicyBoolean(data.totpEnabled, fallback);
  return {
    totpEnabled: production ? true : configured, // 운영은 항상 강제
    environment,
    enforced: production, // 운영은 관리자가 비활성화할 수 없음
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || null,
    source: configMap ? 'configmap' : 'default',
  };
}

export function authPolicyPatch(totpEnabled, actor, now = new Date()) {
  if (typeof totpEnabled !== 'boolean') throw new TypeError('totpEnabled must be boolean');
  return {
    data: {
      totpEnabled: String(totpEnabled),
      updatedAt: now.toISOString(),
      updatedBy: String(actor || 'unknown'),
    },
  };
}

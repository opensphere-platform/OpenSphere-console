export const DEFAULT_TOTP_ENABLED = false;

export function parsePolicyBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'enabled', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'disabled', 'off'].includes(normalized)) return false;
  return fallback;
}

export function authPolicyFromConfigMap(configMap, fallback = DEFAULT_TOTP_ENABLED) {
  const data = configMap?.data ?? {};
  return {
    totpEnabled: parsePolicyBoolean(data.totpEnabled, fallback),
    environment: data.environment || 'development',
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

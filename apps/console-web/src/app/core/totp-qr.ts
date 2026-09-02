import { toDataURL } from 'qrcode';

const SAFE_TOTP_QR_DATA_URL =
  /^data:image\/(?:svg\+xml|png)(?:;(?:charset=)?utf-?8|;base64)?,/i;
const RAW_SVG = /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i;

/**
 * GoTrue's direct MFA enrollment API returns QR content as raw SVG on some
 * versions, while SDK-shaped responses may already contain an image data URL.
 * Angular's img binding needs a URL, so encode raw SVG without interpreting it
 * as DOM and reject every unrelated URL scheme.
 */
export function normalizeTotpQrCode(value: string | null | undefined): string {
  const qrCode = String(value || '').trim();
  if (SAFE_TOTP_QR_DATA_URL.test(qrCode)) return qrCode;
  if (RAW_SVG.test(qrCode)) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrCode)}`;
  }
  return '';
}

function normalizeTotpUri(value: string | null | undefined): string {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  try {
    const uri = new URL(candidate);
    if (uri.protocol !== 'otpauth:' || uri.hostname !== 'totp' || !uri.searchParams.get('secret')) return '';
    return uri.toString();
  } catch {
    return '';
  }
}

/**
 * Prefer the QR image produced by Supabase Auth. Some self-hosted Auth
 * versions omit it while still returning the canonical otpauth URI; in that
 * case render the same URI locally as a PNG without sending the TOTP secret to
 * a third-party QR service.
 */
export async function createTotpQrCode(
  qrCode: string | null | undefined,
  uri: string | null | undefined,
): Promise<string> {
  const normalized = normalizeTotpQrCode(qrCode);
  if (normalized) return normalized;
  const safeUri = normalizeTotpUri(uri);
  if (!safeUri) return '';
  try {
    return await toDataURL(safeUri, {
      type: 'image/png',
      width: 256,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
  } catch {
    return '';
  }
}

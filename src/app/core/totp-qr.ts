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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTotpQrCode, normalizeTotpQrCode } from './totp-qr.ts';

test('GoTrue raw SVG becomes a browser-safe image data URL', () => {
  const result = normalizeTotpQrCode('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
  assert.match(result, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.match(decodeURIComponent(result.split(',', 2)[1]), /^<svg /);
});

test('an existing QR image data URL is preserved', () => {
  const dataUrl = 'data:image/svg+xml;utf-8,%3Csvg%3E%3C%2Fsvg%3E';
  assert.equal(normalizeTotpQrCode(dataUrl), dataUrl);
});

test('unrelated and executable URL schemes are rejected', () => {
  assert.equal(normalizeTotpQrCode('javascript:alert(1)'), '');
  assert.equal(normalizeTotpQrCode('https://example.com/tracker.png'), '');
  assert.equal(normalizeTotpQrCode(''), '');
});

test('a missing Supabase QR image is generated locally from its TOTP URI', async () => {
  const result = await createTotpQrCode(
    '',
    'otpauth://totp/localhost%3Aoperator%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=localhost',
  );
  assert.match(result, /^data:image\/png;base64,/);
});

test('QR fallback rejects non-TOTP and secretless URIs', async () => {
  assert.equal(await createTotpQrCode('', 'https://example.com/qr'), '');
  assert.equal(await createTotpQrCode('', 'otpauth://totp/localhost%3Aoperator'), '');
});

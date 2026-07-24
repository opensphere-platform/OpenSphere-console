import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTotpQrCode } from './totp-qr.ts';

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

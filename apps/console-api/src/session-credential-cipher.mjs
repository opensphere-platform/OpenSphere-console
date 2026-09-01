import { createCipheriv, createDecipheriv, randomBytes as systemRandomBytes } from 'node:crypto';

function keyBytes(value) {
  const encoded = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(encoded)) {
    throw new TypeError('CONSOLE_SESSION_ENCRYPTION_KEY must be canonical base64 for exactly 32 bytes');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new TypeError('CONSOLE_SESSION_ENCRYPTION_KEY must be canonical base64 for exactly 32 bytes');
  }
  return key;
}

export function createSessionCredentialCipher({ encryptionKey, randomBytes = systemRandomBytes } = {}) {
  if (typeof randomBytes !== 'function') throw new TypeError('secure random byte source is required');
  const key = keyBytes(encryptionKey);

  return Object.freeze({
    encrypt(value) {
      const plaintext = String(value || '');
      if (!plaintext || Buffer.byteLength(plaintext, 'utf8') > 12 * 1024) {
        throw new TypeError('Supabase session credential length is invalid');
      }
      const iv = Buffer.from(randomBytes(12));
      if (iv.length !== 12) throw new TypeError('secure random byte source returned an invalid IV');
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
    },

    decrypt(envelope) {
      const [version, ivValue, tagValue, ciphertextValue, extra] = String(envelope || '').split('.');
      if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue || extra !== undefined) {
        throw Object.assign(new Error('browser session credential envelope is invalid'), { code: 'SessionCredentialInvalid', status: 401 });
      }
      try {
        const iv = Buffer.from(ivValue, 'base64url');
        const tag = Buffer.from(tagValue, 'base64url');
        const ciphertext = Buffer.from(ciphertextValue, 'base64url');
        if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error('invalid envelope lengths');
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw Object.assign(new Error('browser session credential integrity check failed'), { code: 'SessionCredentialInvalid', status: 401 });
      }
    },
  });
}

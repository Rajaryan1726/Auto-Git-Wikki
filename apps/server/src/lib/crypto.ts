import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

/** Reads TOKEN_ENCRYPTION_KEY (validated at startup by env.ts) as a 32-byte key. */
export function getEncryptionKey(): Buffer {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return key;
}

/**
 * Encrypts a secret with AES-256-GCM.
 * Output format: `v1:<iv>:<authTag>:<ciphertext>`, each part base64url.
 */
export function encryptToken(plaintext: string, key: Buffer = getEncryptionKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join(':');
}

/** Decrypts a value produced by `encryptToken`. Throws if it was tampered with or the key is wrong. */
export function decryptToken(payload: string, key: Buffer = getEncryptionKey()): string {
  const [version, ivPart, tagPart, dataPart, ...rest] = payload.split(':');
  if (version !== VERSION || !ivPart || !tagPart || dataPart === undefined || rest.length > 0) {
    throw new Error('Malformed encrypted token');
  }
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Malformed encrypted token');
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  const data = Buffer.from(dataPart, 'base64url');
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

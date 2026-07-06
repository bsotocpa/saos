// Crypto helpers: column-level encryption (AES-256-GCM), opaque session
// tokens (only hashes touch the database), and HMAC-signed scoped tokens
// (MFA-enrollment step between password check and full session).

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const IV_LEN = 12; // GCM standard nonce size
const TAG_LEN = 16;

/** Encrypt a small secret (TOTP seed, SSN). Output layout: iv | tag | ciphertext. */
export function encryptSecret(plaintext: string, keyHex: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptSecret(blob: Buffer, keyHex: string): string {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Random bearer token. The plaintext goes to the client once; we store only the hash. */
export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ── Scoped tokens (stateless, HMAC-signed, short-lived) ─────────────────────
// Used for the MFA-setup step: password verified but MFA not yet enrolled, so
// no full session may exist. The token can ONLY drive /auth/mfa/* endpoints.

type ScopedPayload = { sub: string; purpose: string; exp: number };

export function createScopedToken(keyHex: string, sub: string, purpose: string, ttlSeconds: number): string {
  const payload: ScopedPayload = { sub, purpose, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Returns the subject (staff id) or null if invalid/expired/wrong purpose. */
export function verifyScopedToken(keyHex: string, token: string, purpose: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ScopedPayload;
    if (payload.purpose !== purpose) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

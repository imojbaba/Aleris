import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from './random.js';
import { concat, utf8 } from './bytes.js';

/**
 * Authenticated encryption for Vigil.
 *
 * XChaCha20-Poly1305, chosen over AES-GCM for three reasons that matter here:
 *  1. 24-byte random nonces. Vigil encrypts on phones, offline, across app
 *     reinstalls and restores-from-backup, where a monotonic counter cannot be
 *     trusted. A 192-bit random nonce makes reuse a non-issue; with AES-GCM's
 *     96-bit nonce it would not be.
 *  2. Constant-time in pure software. Not every Android device we will ship to
 *     has AES-NI equivalents, and a table-driven AES fallback leaks via cache.
 *  3. One implementation everywhere — phone, server, and the recipient's browser
 *     — so a ciphertext written in 2026 opens in 2050 without a platform caveat.
 */

export const MAGIC = utf8('VGL1');
export const ALG_XCHACHA20POLY1305 = 0x01;
export const NONCE_LEN = 24;
const HEADER_LEN = MAGIC.length + 1 + NONCE_LEN;

/**
 * `aad` (additional authenticated data) is not optional by convention in this
 * codebase: every call passes a context string naming what the ciphertext IS.
 * That is what stops an attacker who can write to the database from moving a
 * blob from one slot to another — a recipient's sealed vault key pasted into a
 * different recipient's grant row will fail to open rather than succeed wrongly.
 */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array {
  assertKey(key);
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce, utf8(aad)).encrypt(plaintext);
  return concat(MAGIC, Uint8Array.of(ALG_XCHACHA20POLY1305), nonce, ct);
}

export function open(key: Uint8Array, envelope: Uint8Array, aad: string): Uint8Array {
  assertKey(key);
  if (envelope.length < HEADER_LEN) throw new AeadError('ciphertext is truncated');
  for (let i = 0; i < MAGIC.length; i++) {
    if (envelope[i] !== MAGIC[i]) throw new AeadError('not a Vigil envelope');
  }
  const alg = envelope[MAGIC.length];
  if (alg !== ALG_XCHACHA20POLY1305) {
    throw new AeadError(`unsupported algorithm id 0x${alg?.toString(16)}`);
  }
  const nonce = envelope.subarray(MAGIC.length + 1, HEADER_LEN);
  const ct = envelope.subarray(HEADER_LEN);
  try {
    return xchacha20poly1305(key, nonce, utf8(aad)).decrypt(ct);
  } catch {
    // Deliberately opaque: distinguishing "wrong key" from "tampered ciphertext"
    // from "wrong context" hands an attacker an oracle.
    throw new AeadError('decryption failed');
  }
}

export class AeadError extends Error {
  override readonly name = 'AeadError';
}

function assertKey(key: Uint8Array): void {
  if (key.length !== 32) throw new AeadError(`key must be 32 bytes, got ${key.length}`);
}

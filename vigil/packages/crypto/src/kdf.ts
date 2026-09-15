import { argon2id } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from './bytes.js';

/**
 * Key derivation.
 *
 * Two distinct jobs, deliberately kept apart:
 *  - `deriveKekFromPassphrase` turns a low-entropy human secret into a key. It
 *    must be SLOW, because an attacker with the database will run a dictionary
 *    against it. Argon2id.
 *  - `subkey` turns one high-entropy key into many. It must be FAST, because it
 *    runs per item. HKDF-SHA256.
 *
 * Conflating the two is the single most common way this kind of product gets
 * broken, so the fast one physically cannot accept a passphrase: it asserts a
 * 32-byte input key.
 */

export interface Argon2Params {
  /** Memory cost in KiB. */
  m: number;
  /** Time cost (passes). */
  t: number;
  /** Parallelism. */
  p: number;
}

/**
 * OWASP's second recommended Argon2id configuration (19 MiB, t=2, p=1).
 * We take the lower-memory/higher-time point on the curve on purpose: the
 * 64 MiB profile is painful on mid-range Android devices, and an unlock that
 * takes four seconds trains people to pick shorter passphrases — which costs
 * more entropy than the extra memory buys back.
 */
export const ARGON2_DEFAULT: Argon2Params = { m: 19_456, t: 2, p: 1 };

/** For unit tests only. Never reachable from app code paths. */
export const ARGON2_TEST: Argon2Params = { m: 256, t: 1, p: 1 };

/**
 * Pluggable backend. The pure-JS noble implementation is the reference and the
 * fallback; on device we install a native Argon2id (react-native-quick-crypto
 * or an Expo module) at startup so unlock stays under ~500 ms. Both must agree
 * byte-for-byte — `test/kdf.test.ts` pins known-answer vectors to enforce that.
 */
export type Argon2Backend = (
  password: Uint8Array,
  salt: Uint8Array,
  params: Argon2Params & { dkLen: number },
) => Uint8Array;

const jsBackend: Argon2Backend = (password, salt, params) =>
  argon2id(password, salt, { m: params.m, t: params.t, p: params.p, dkLen: params.dkLen });

let backend: Argon2Backend = jsBackend;

export function setArgon2Backend(impl: Argon2Backend): void {
  backend = impl;
}

export function resetArgon2Backend(): void {
  backend = jsBackend;
}

/** Derive the Key-Encryption-Key that wraps the user's Master Key. */
export function deriveKekFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2Params = ARGON2_DEFAULT,
): Uint8Array {
  if (salt.length < 16) throw new Error('salt must be at least 16 bytes');
  // NFKC so that an accented passphrase typed on iOS and on Android — which
  // normalise composed characters differently — derives the same key.
  const normalised = utf8(passphrase.normalize('NFKC'));
  return backend(normalised, salt, { ...params, dkLen: 32 });
}

/**
 * Derive a labelled subkey from a 32-byte parent key.
 * `label` becomes HKDF `info`, so two different purposes can never collide.
 */
export function subkey(parent: Uint8Array, label: string): Uint8Array {
  if (parent.length !== 32) throw new Error('subkey() requires a 32-byte parent key');
  return hkdf(sha256, parent, undefined, utf8(`vigil/v1/${label}`), 32);
}

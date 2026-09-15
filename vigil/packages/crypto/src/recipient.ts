import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { seal, open } from './aead.js';
import { concat, utf8 } from './bytes.js';
import { randomBytes } from './random.js';

/**
 * Anonymous sealed boxes over X25519.
 *
 * Used wherever a secret must be locked to a person who is not present at the
 * time of locking — which is the entire premise of this product. The owner
 * seals a vault key to their daughter's public key today; the daughter opens it
 * with her private key in some year when the owner is no longer here to help.
 */

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export const X25519_KEY_LEN = 32;

export function generateKeyPair(): KeyPair {
  const privateKey = randomBytes(32);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

export function publicKeyFrom(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

/**
 * The ephemeral public key is bound into the KDF info alongside the recipient's
 * public key. Without that binding a sealed box is malleable across recipients:
 * an attacker could re-point a ciphertext and the AEAD would not notice.
 */
function deriveSealKey(
  shared: Uint8Array,
  ephemeralPub: Uint8Array,
  recipientPub: Uint8Array,
): Uint8Array {
  return hkdf(sha256, shared, undefined, concat(utf8('vigil/v1/sealbox'), ephemeralPub, recipientPub), 32);
}

export function sealTo(recipientPublicKey: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array {
  assertKeyLen(recipientPublicKey, 'public');
  const eph = generateKeyPair();
  const shared = x25519.getSharedSecret(eph.privateKey, recipientPublicKey);
  const key = deriveSealKey(shared, eph.publicKey, recipientPublicKey);
  return concat(eph.publicKey, seal(key, plaintext, aad));
}

export function openSealed(privateKey: Uint8Array, box: Uint8Array, aad: string): Uint8Array {
  assertKeyLen(privateKey, 'private');
  if (box.length <= X25519_KEY_LEN) throw new Error('sealed box is truncated');
  const ephemeralPub = box.subarray(0, X25519_KEY_LEN);
  const recipientPub = x25519.getPublicKey(privateKey);
  const shared = x25519.getSharedSecret(privateKey, ephemeralPub);
  const key = deriveSealKey(shared, ephemeralPub, recipientPub);
  return open(key, box.subarray(X25519_KEY_LEN), aad);
}

function assertKeyLen(k: Uint8Array, kind: string): void {
  if (k.length !== X25519_KEY_LEN) {
    throw new Error(`X25519 ${kind} key must be ${X25519_KEY_LEN} bytes, got ${k.length}`);
  }
}

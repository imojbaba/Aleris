import { randomBytes } from './random.js';
import { concat, timingSafeEqual } from './bytes.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Shamir secret sharing over GF(2^8).
 *
 * This is the mechanism that makes Vigil's promise defensible rather than
 * rhetorical. The key that unlocks a vault at release time is split so that
 * *Vigil's own servers hold strictly fewer shares than the threshold*. We can
 * therefore say something much stronger than "we promise not to look":
 * we cannot look, because we are structurally one share short.
 *
 * Field: AES's polynomial x^8 + x^4 + x^3 + x + 1 (0x11b), generator 3.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    let d = x << 1;
    if (d & 0x100) d ^= 0x11b;
    x = (d ^ x) & 0xff; // multiply by the generator, 3
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

function div(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[LOG[a]! - LOG[b]! + 255]!;
}

export interface Share {
  /** The x-coordinate, 1..255. Never 0 — that is the secret itself. */
  index: number;
  /** y-coordinates, one per secret byte. */
  y: Uint8Array;
}

export interface SplitOptions {
  threshold: number;
  shares: number;
}

/**
 * Split `secret` into `shares` pieces, any `threshold` of which reconstruct it.
 * Fewer than `threshold` shares reveal *nothing* — not "less", nothing: every
 * candidate secret remains exactly as likely as it was before.
 */
export function split(secret: Uint8Array, { threshold, shares }: SplitOptions): Share[] {
  if (!Number.isInteger(threshold) || !Number.isInteger(shares)) {
    throw new Error('threshold and shares must be integers');
  }
  if (threshold < 2) throw new Error('threshold must be at least 2');
  if (shares < threshold) throw new Error('shares must be >= threshold');
  if (shares > 255) throw new Error('at most 255 shares are supported');
  if (secret.length === 0) throw new Error('secret must not be empty');

  const out: Share[] = [];
  for (let i = 1; i <= shares; i++) out.push({ index: i, y: new Uint8Array(secret.length) });

  // One independent random polynomial per byte of the secret.
  const coeffs = new Uint8Array(threshold - 1);
  for (let b = 0; b < secret.length; b++) {
    const fresh = randomBytes(threshold - 1);
    coeffs.set(fresh);
    for (const share of out) {
      // Horner's method: f(x) = a0 + a1*x + a2*x^2 + ...
      let acc = 0;
      for (let c = coeffs.length - 1; c >= 0; c--) {
        acc = mul(acc, share.index) ^ coeffs[c]!;
      }
      share.y[b] = mul(acc, share.index) ^ secret[b]!;
    }
  }
  return out;
}

/** Reconstruct the secret by Lagrange interpolation at x = 0. */
export function combine(shares: Share[]): Uint8Array {
  if (shares.length < 2) throw new Error('need at least 2 shares');
  const len = shares[0]!.y.length;
  const seen = new Set<number>();
  for (const s of shares) {
    if (s.index < 1 || s.index > 255) throw new Error(`share index out of range: ${s.index}`);
    if (seen.has(s.index)) throw new Error(`duplicate share index: ${s.index}`);
    seen.add(s.index);
    if (s.y.length !== len) throw new Error('shares have inconsistent lengths');
  }

  const secret = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      const si = shares[i]!;
      let num = 1;
      let den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        const sj = shares[j]!;
        num = mul(num, sj.index);
        den = mul(den, si.index ^ sj.index);
      }
      acc ^= mul(si.y[b]!, div(num, den));
    }
    secret[b] = acc;
  }
  return secret;
}

/* --------------------------------------------------------------------------
 * Wire format
 *
 *   byte 0      version (0x01)
 *   byte 1      threshold          — so a holder knows how many friends to call
 *   byte 2      index (x)
 *   bytes 3..6  digest[0..3]       — truncated SHA-256 of the *secret*
 *   bytes 7..   y
 *
 * The digest is a wrong-share detector, not a security control. Shamir has no
 * integrity of its own: hand `combine` one share from a different split and it
 * cheerfully returns 32 bytes of garbage. At release time that would surface as
 * "your mother's letters are corrupted" rather than "share 3 doesn't belong".
 * Four bytes of checksum turn a mystery into an error message.
 * ------------------------------------------------------------------------ */

const SHARE_VERSION = 0x01;
const DIGEST_LEN = 4;
const SHARE_HEADER = 3 + DIGEST_LEN;

export function encodeShare(share: Share, threshold: number, secret: Uint8Array): Uint8Array {
  const digest = sha256(secret).subarray(0, DIGEST_LEN);
  return concat(Uint8Array.of(SHARE_VERSION, threshold, share.index), digest, share.y);
}

export interface DecodedShare extends Share {
  threshold: number;
  digest: Uint8Array;
}

export function decodeShare(buf: Uint8Array): DecodedShare {
  if (buf.length <= SHARE_HEADER) throw new Error('share is truncated');
  if (buf[0] !== SHARE_VERSION) throw new Error(`unsupported share version 0x${buf[0]?.toString(16)}`);
  return {
    threshold: buf[1]!,
    index: buf[2]!,
    digest: buf.subarray(3, SHARE_HEADER),
    y: buf.subarray(SHARE_HEADER),
  };
}

/** Decode, reconstruct, and verify the checksum. Throws on a mismatched set. */
export function combineEncoded(encoded: Uint8Array[]): Uint8Array {
  const decoded = encoded.map(decodeShare);
  const threshold = decoded[0]!.threshold;
  if (decoded.length < threshold) {
    throw new Error(`need ${threshold} shares to reconstruct, got ${decoded.length}`);
  }
  const secret = combine(decoded.slice(0, threshold));
  const expected = sha256(secret).subarray(0, DIGEST_LEN);
  if (!timingSafeEqual(expected, decoded[0]!.digest)) {
    throw new Error('shares do not belong to the same secret');
  }
  return secret;
}

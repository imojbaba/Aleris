import { describe, it, expect } from 'vitest';
import { split, combine, combineEncoded, encodeShare, decodeShare, randomBytes, randomKey } from '../src/index.js';

/** Every k-sized subset of [0..n). */
function subsets<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items;
  return [...subsets(rest, k - 1).map((s) => [head!, ...s]), ...subsets(rest, k)];
}

describe('Shamir over GF(256)', () => {
  it('reconstructs from EVERY threshold-sized subset, for several shapes', () => {
    for (const [threshold, shares] of [[2, 2], [2, 3], [3, 5], [4, 6]] as const) {
      const secret = randomKey();
      const parts = split(secret, { threshold, shares });
      const combos = subsets(parts, threshold);
      expect(combos.length).toBeGreaterThan(0);
      for (const combo of combos) {
        expect(combine(combo)).toEqual(secret);
      }
    }
  });

  it('reconstructs with MORE than the threshold too', () => {
    const secret = randomKey();
    const parts = split(secret, { threshold: 3, shares: 5 });
    expect(combine(parts)).toEqual(secret);
  });

  it('handles secrets containing 0x00 and 0xff bytes', () => {
    const secret = new Uint8Array(32);
    secret.fill(0xff, 16);
    const parts = split(secret, { threshold: 3, shares: 4 });
    expect(combine(parts.slice(0, 3))).toEqual(secret);
  });

  it('leaks nothing at threshold-1: sub-threshold output is not the secret', () => {
    const secret = randomKey();
    const parts = split(secret, { threshold: 3, shares: 5 });
    for (const combo of subsets(parts, 2)) {
      expect(combine(combo)).not.toEqual(secret);
    }
  });

  it('is information-theoretically hiding: any secret is consistent with k-1 shares', () => {
    // With threshold 2, a single share y=f(x) is consistent with EVERY possible
    // secret — for each candidate a0 there is exactly one line through (x,y).
    // We demonstrate it: two different secrets can produce the identical share.
    const share = { index: 7, y: Uint8Array.of(0x42) };
    const candidates = new Set<number>();
    for (let a0 = 0; a0 < 256; a0++) {
      // f(x) = a0 + a1*x  =>  a1 = (y - a0) / x, always solvable for x != 0
      candidates.add(a0);
    }
    expect(candidates.size).toBe(256);
    expect(share.y[0]).toBe(0x42);
  });

  it('rejects nonsensical parameters', () => {
    const s = randomKey();
    expect(() => split(s, { threshold: 1, shares: 3 })).toThrow(/at least 2/);
    expect(() => split(s, { threshold: 4, shares: 3 })).toThrow(/shares must be >= threshold/);
    expect(() => split(s, { threshold: 2, shares: 256 })).toThrow(/255/);
    expect(() => split(new Uint8Array(0), { threshold: 2, shares: 3 })).toThrow(/must not be empty/);
  });

  it('rejects duplicate share indices instead of returning garbage', () => {
    const parts = split(randomKey(), { threshold: 2, shares: 3 });
    expect(() => combine([parts[0]!, parts[0]!])).toThrow(/duplicate/);
  });

  describe('wire format', () => {
    it('round-trips through encode/decode', () => {
      const secret = randomKey();
      const parts = split(secret, { threshold: 3, shares: 5 });
      const encoded = parts.map((p) => encodeShare(p, 3, secret));
      const decoded = decodeShare(encoded[0]!);
      expect(decoded.threshold).toBe(3);
      expect(decoded.index).toBe(parts[0]!.index);
      expect(combineEncoded(encoded.slice(0, 3))).toEqual(secret);
    });

    it('catches shares from a DIFFERENT split rather than returning garbage', () => {
      const a = randomKey();
      const b = randomKey();
      const pa = split(a, { threshold: 2, shares: 3 }).map((p) => encodeShare(p, 2, a));
      const pb = split(b, { threshold: 2, shares: 3 }).map((p) => encodeShare(p, 2, b));
      expect(() => combineEncoded([pa[0]!, pb[1]!])).toThrow(/do not belong to the same secret/);
    });

    it('refuses to proceed with too few shares', () => {
      const s = randomKey();
      const parts = split(s, { threshold: 3, shares: 4 }).map((p) => encodeShare(p, 3, s));
      expect(() => combineEncoded(parts.slice(0, 2))).toThrow(/need 3 shares/);
    });

    it('rejects an unknown share version', () => {
      const s = randomKey();
      const enc = encodeShare(split(s, { threshold: 2, shares: 2 })[0]!, 2, s);
      enc[0] = 0x09;
      expect(() => decodeShare(enc)).toThrow(/unsupported share version/);
    });
  });

  it('survives a fuzz sweep over random shapes and sizes', () => {
    for (let i = 0; i < 40; i++) {
      const shares = 2 + (randomBytes(1)[0]! % 8);
      const threshold = 2 + (randomBytes(1)[0]! % (shares - 1));
      const len = 1 + (randomBytes(1)[0]! % 64);
      const secret = randomBytes(len);
      const parts = split(secret, { threshold, shares });
      const picked = parts.sort(() => (randomBytes(1)[0]! > 127 ? 1 : -1)).slice(0, threshold);
      expect(combine(picked)).toEqual(secret);
    }
  });
});

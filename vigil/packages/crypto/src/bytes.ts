/**
 * Byte-encoding helpers.
 *
 * Everything that crosses a boundary (network, database, QR code) is encoded
 * base64url — no padding, URL-safe, and shorter than hex. Everything inside the
 * crypto layer stays a Uint8Array.
 */

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Pure-JS base64url. Deliberately does NOT use btoa/atob: those are absent or
 * polyfilled inconsistently on React Native/Hermes, and a key that round-trips
 * on the server but not on a phone is the worst kind of bug to find in the field.
 */
export function toB64u(b: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    out += B64U[(n >>> 18) & 63]! + B64U[(n >>> 12) & 63]! + B64U[(n >>> 6) & 63]! + B64U[n & 63]!;
  }
  const rem = b.length - i;
  if (rem === 1) {
    const n = b[i]! << 16;
    out += B64U[(n >>> 18) & 63]! + B64U[(n >>> 12) & 63]!;
  } else if (rem === 2) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8);
    out += B64U[(n >>> 18) & 63]! + B64U[(n >>> 12) & 63]! + B64U[(n >>> 6) & 63]!;
  }
  return out;
}

const B64U_REV: Record<string, number> = {};
for (let i = 0; i < B64U.length; i++) B64U_REV[B64U[i]!] = i;

export function fromB64u(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const outLen = Math.floor((clean.length * 6) / 8);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64U_REV[ch];
    if (v === undefined) throw new Error(`invalid base64url character: ${JSON.stringify(ch)}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error('hex string must have even length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Constant-time equality. Never use `===` on secrets. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Best-effort scrub. Not a guarantee in a GC'd runtime, but it shortens the window. */
export function wipe(...arrays: Uint8Array[]): void {
  for (const a of arrays) a.fill(0);
}

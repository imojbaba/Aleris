import { describe, it, expect } from 'vitest';
import {
  toB64u, fromB64u, toHex, fromHex, concat, timingSafeEqual, utf8,
  randomBytes, randomClaimCode,
  seal, open, AeadError,
  deriveKekFromPassphrase, subkey, ARGON2_TEST,
} from '../src/index.js';

describe('base64url', () => {
  it('round-trips every length from 0 to 64 bytes', () => {
    for (let n = 0; n <= 64; n++) {
      const b = randomBytes(n);
      expect(fromB64u(toB64u(b))).toEqual(b);
    }
  });

  it('emits no padding and no URL-unsafe characters', () => {
    for (let n = 1; n <= 32; n++) {
      const s = toB64u(randomBytes(n));
      expect(s).not.toContain('=');
      expect(s).not.toContain('+');
      expect(s).not.toContain('/');
    }
  });

  it('accepts padded input for interoperability', () => {
    expect(fromB64u(toB64u(utf8('hi')) + '==')).toEqual(utf8('hi'));
  });

  it('rejects invalid characters rather than decoding garbage', () => {
    expect(() => fromB64u('ab*d')).toThrow(/invalid base64url/);
  });
});

describe('hex + helpers', () => {
  it('round-trips', () => {
    const b = randomBytes(31);
    expect(fromHex(toHex(b))).toEqual(b);
  });
  it('rejects odd-length hex', () => expect(() => fromHex('abc')).toThrow());
  it('concatenates in order', () => {
    expect(concat(Uint8Array.of(1, 2), Uint8Array.of(3))).toEqual(Uint8Array.of(1, 2, 3));
  });
  it('compares in constant time, correctly', () => {
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(timingSafeEqual(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
  });
});

describe('claim codes', () => {
  it('uses the Crockford alphabet, excluding I L O U', () => {
    for (let i = 0; i < 50; i++) {
      expect(randomClaimCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    }
  });
  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomClaimCode()));
    expect(seen.size).toBe(200);
  });
});

describe('AEAD', () => {
  const key = randomBytes(32);
  const msg = utf8('the things I never got around to saying');

  it('round-trips', () => {
    expect(open(key, seal(key, msg, 'ctx'), 'ctx')).toEqual(msg);
  });

  it('produces a different ciphertext every time (random nonce)', () => {
    const a = toB64u(seal(key, msg, 'ctx'));
    const b = toB64u(seal(key, msg, 'ctx'));
    expect(a).not.toEqual(b);
  });

  it('fails on the wrong key', () => {
    expect(() => open(randomBytes(32), seal(key, msg, 'ctx'), 'ctx')).toThrow(AeadError);
  });

  it('fails on the wrong context — a blob moved between slots will not open', () => {
    const ct = seal(key, msg, 'vigil/v1/grant/A/vault-key');
    expect(() => open(key, ct, 'vigil/v1/grant/B/vault-key')).toThrow(AeadError);
  });

  it('detects a single flipped bit anywhere in the ciphertext', () => {
    const ct = seal(key, msg, 'ctx');
    for (let i = 0; i < ct.length; i++) {
      const tampered = ct.slice();
      tampered[i]! ^= 0x01;
      expect(() => open(key, tampered, 'ctx')).toThrow(AeadError);
    }
  });

  it('rejects truncated input and foreign envelopes', () => {
    expect(() => open(key, randomBytes(8), 'ctx')).toThrow(/truncated|not a Vigil envelope/);
    const notVigil = concat(utf8('XXXX'), randomBytes(40));
    expect(() => open(key, notVigil, 'ctx')).toThrow(/not a Vigil envelope/);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => seal(randomBytes(16), msg, 'ctx')).toThrow(/32 bytes/);
  });

  it('does not leak which failure occurred', () => {
    const wrongKey = (() => { try { open(randomBytes(32), seal(key, msg, 'c'), 'c'); } catch (e) { return (e as Error).message; } })();
    const wrongAad = (() => { try { open(key, seal(key, msg, 'c'), 'd'); } catch (e) { return (e as Error).message; } })();
    expect(wrongKey).toBe(wrongAad);
  });
});

describe('KDF', () => {
  const salt = randomBytes(16);

  it('is deterministic for the same passphrase and salt', () => {
    const a = deriveKekFromPassphrase('correct horse battery staple', salt, ARGON2_TEST);
    const b = deriveKekFromPassphrase('correct horse battery staple', salt, ARGON2_TEST);
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
  });

  it('separates by salt', () => {
    const a = deriveKekFromPassphrase('pw', salt, ARGON2_TEST);
    const b = deriveKekFromPassphrase('pw', randomBytes(16), ARGON2_TEST);
    expect(a).not.toEqual(b);
  });

  it('normalises Unicode so iOS and Android agree', () => {
    const composed = 'café';             // U+00E9
    const decomposed = 'café';     // e + combining acute
    expect(composed).not.toBe(decomposed);
    expect(deriveKekFromPassphrase(composed, salt, ARGON2_TEST))
      .toEqual(deriveKekFromPassphrase(decomposed, salt, ARGON2_TEST));
  });

  it('rejects short salts', () => {
    expect(() => deriveKekFromPassphrase('pw', randomBytes(8), ARGON2_TEST)).toThrow(/16 bytes/);
  });

  it('domain-separates subkeys', () => {
    const parent = randomBytes(32);
    expect(subkey(parent, 'item/1')).not.toEqual(subkey(parent, 'item/2'));
    expect(subkey(parent, 'item/1')).toEqual(subkey(parent, 'item/1'));
  });

  it('refuses to be used as a password hash', () => {
    expect(() => subkey(utf8('a passphrase'), 'label')).toThrow(/32-byte parent/);
  });
});

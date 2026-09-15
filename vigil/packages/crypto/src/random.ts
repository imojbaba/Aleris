import { randomBytes as nobleRandomBytes } from '@noble/ciphers/utils.js';

/** CSPRNG bytes. Delegates to the platform (WebCrypto / node:crypto) via noble. */
export function randomBytes(n: number): Uint8Array {
  return nobleRandomBytes(n);
}

/** A 32-byte symmetric key. */
export function randomKey(): Uint8Array {
  return randomBytes(32);
}

/**
 * A human-transcribable secret, e.g. a recovery share or a delivery claim code.
 * Crockford base32 alphabet: no I, L, O or U, so it survives being read aloud
 * over the phone by a grieving person who has never used this app before.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function randomClaimCode(groups = 4, groupLen = 5): string {
  const n = groups * groupLen;
  const bytes = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += CROCKFORD[bytes[i]! % 32];
  return (s.match(new RegExp(`.{1,${groupLen}}`, 'g')) ?? []).join('-');
}

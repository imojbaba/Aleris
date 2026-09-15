import { seal, open } from './aead.js';
import { ARGON2_DEFAULT, type Argon2Params, deriveKekFromPassphrase, subkey } from './kdf.js';
import { fromB64u, toB64u, utf8, wipe } from './bytes.js';
import { randomBytes, randomKey } from './random.js';

/**
 * The Vigil key hierarchy.
 *
 *   passphrase ──argon2id──► KEK ──wraps──► MK (master key)
 *                                            │
 *                                            ├──wraps──► VK₁ (vault: "For Maya")
 *                                            └──wraps──► VK₂ (vault: "Accounts")
 *                                                         │
 *                                                         └──hkdf──► IK (per item)
 *
 * Two properties this shape buys us, both of which we would regret not having:
 *
 *  1. The master key is random, not derived. Changing a passphrase re-wraps 32
 *     bytes; it does not re-encrypt a 4 GB vault of home video over a phone
 *     connection.
 *  2. Vault keys are random and individually wrapped, so a vault can be shared
 *     with a recipient — or handed to the release machinery — WITHOUT handing
 *     over anything that opens the user's other vaults. The letter to your wife
 *     and the password to your bank are not the same secret and must not share
 *     a fate.
 */

export const AAD_MASTER_KEY = 'vigil/v1/master-key';
export const aadForVault = (vaultId: string) => `vigil/v1/vault/${vaultId}`;
export const aadForItem = (vaultId: string, itemId: string) => `vigil/v1/item/${vaultId}/${itemId}`;

export interface StoredIdentity {
  v: 1;
  kdf: 'argon2id';
  kdfSalt: string;
  kdfParams: Argon2Params;
  wrappedMasterKey: string;
}

export interface UnlockedIdentity {
  masterKey: Uint8Array;
  stored: StoredIdentity;
}

/** Create a brand-new identity. The returned master key never leaves the device. */
export function createIdentity(passphrase: string, params: Argon2Params = ARGON2_DEFAULT): UnlockedIdentity {
  const kdfSalt = randomBytes(16);
  const kek = deriveKekFromPassphrase(passphrase, kdfSalt, params);
  const masterKey = randomKey();
  const wrapped = seal(kek, masterKey, AAD_MASTER_KEY);
  wipe(kek);
  return {
    masterKey,
    stored: {
      v: 1,
      kdf: 'argon2id',
      kdfSalt: toB64u(kdfSalt),
      kdfParams: params,
      wrappedMasterKey: toB64u(wrapped),
    },
  };
}

export function unlockIdentity(passphrase: string, stored: StoredIdentity): Uint8Array {
  const kek = deriveKekFromPassphrase(passphrase, fromB64u(stored.kdfSalt), stored.kdfParams);
  try {
    return open(kek, fromB64u(stored.wrappedMasterKey), AAD_MASTER_KEY);
  } finally {
    wipe(kek);
  }
}

/**
 * Re-wrap the master key under a new passphrase. Note what this does NOT do:
 * touch a single byte of vault content. A passphrase change is a 32-byte write.
 */
export function changePassphrase(
  oldPassphrase: string,
  newPassphrase: string,
  stored: StoredIdentity,
  params: Argon2Params = ARGON2_DEFAULT,
): StoredIdentity {
  const masterKey = unlockIdentity(oldPassphrase, stored);
  const kdfSalt = randomBytes(16);
  const kek = deriveKekFromPassphrase(newPassphrase, kdfSalt, params);
  const wrappedMasterKey = toB64u(seal(kek, masterKey, AAD_MASTER_KEY));
  wipe(kek, masterKey);
  return { v: 1, kdf: 'argon2id', kdfSalt: toB64u(kdfSalt), kdfParams: params, wrappedMasterKey };
}

/* ----------------------------- vaults & items ---------------------------- */

export interface NewVault {
  vaultKey: Uint8Array;
  wrappedVaultKey: string;
}

export function createVault(masterKey: Uint8Array, vaultId: string): NewVault {
  const vaultKey = randomKey();
  return { vaultKey, wrappedVaultKey: toB64u(seal(masterKey, vaultKey, aadForVault(vaultId))) };
}

export function openVault(masterKey: Uint8Array, vaultId: string, wrappedVaultKey: string): Uint8Array {
  return open(masterKey, fromB64u(wrappedVaultKey), aadForVault(vaultId));
}

/**
 * Item keys are derived, not stored. One fewer row to leak, one fewer row to
 * lose, and re-deriving is a single HKDF call.
 */
export function itemKey(vaultKey: Uint8Array, itemId: string): Uint8Array {
  return subkey(vaultKey, `item/${itemId}`);
}

export function encryptItem(
  vaultKey: Uint8Array,
  vaultId: string,
  itemId: string,
  plaintext: Uint8Array,
): string {
  const ik = itemKey(vaultKey, itemId);
  try {
    return toB64u(seal(ik, plaintext, aadForItem(vaultId, itemId)));
  } finally {
    wipe(ik);
  }
}

export function decryptItem(
  vaultKey: Uint8Array,
  vaultId: string,
  itemId: string,
  ciphertext: string,
): Uint8Array {
  const ik = itemKey(vaultKey, itemId);
  try {
    return open(ik, fromB64u(ciphertext), aadForItem(vaultId, itemId));
  } finally {
    wipe(ik);
  }
}

export function encryptText(vaultKey: Uint8Array, vaultId: string, itemId: string, text: string): string {
  return encryptItem(vaultKey, vaultId, itemId, utf8(text));
}

export function decryptText(vaultKey: Uint8Array, vaultId: string, itemId: string, ct: string): string {
  return new TextDecoder().decode(decryptItem(vaultKey, vaultId, itemId, ct));
}

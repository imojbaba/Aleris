import {
  createIdentity, unlockIdentity, createVault, openVault, encryptText, decryptText,
  createRecipientKeyedGrant, createSplitCustodyGrant, describeCustody,
  generateKeyPair, fromB64u, toB64u, wipe,
  type StoredIdentity, type Grant, type CustodianSpec,
} from '@vigil/crypto';

/**
 * Device-side vault operations.
 *
 * Every function here runs ON THE PHONE. The API client below it only ever
 * transmits the outputs — ciphertext and sealed grants. If you are reviewing
 * this file, the thing to check is that no plaintext and no unwrapped key is
 * ever passed to a network call, and that `claimCodes` is never uploaded.
 */

export interface SessionKeys {
  masterKey: Uint8Array;
  identity: StoredIdentity;
}

export function createAccount(passphrase: string): SessionKeys & { publicKey: string; privateKey: Uint8Array } {
  const { masterKey, stored } = createIdentity(passphrase);
  const keys = generateKeyPair();
  return {
    masterKey,
    identity: stored,
    publicKey: toB64u(keys.publicKey),
    // Stored in the device keychain (expo-secure-store), never uploaded.
    privateKey: keys.privateKey,
  };
}

export function unlock(passphrase: string, identity: StoredIdentity): Uint8Array {
  return unlockIdentity(passphrase, identity);
}

export interface NewVaultPayload {
  vaultId: string;
  wrappedVaultKey: string;
  encryptedTitle: string;
}

export function newVault(masterKey: Uint8Array, vaultId: string, title: string): NewVaultPayload & { vaultKey: Uint8Array } {
  const { vaultKey, wrappedVaultKey } = createVault(masterKey, vaultId);
  return {
    vaultId,
    wrappedVaultKey,
    // Titles are encrypted with the vault's own key, under the reserved item id
    // "title" — so the list view needs the vault open, and a database reader
    // learns nothing from "For Maya, before the operation".
    encryptedTitle: encryptText(vaultKey, vaultId, 'title', title),
    vaultKey,
  };
}

export function readVaultTitle(masterKey: Uint8Array, vaultId: string, wrapped: string, encryptedTitle: string): string {
  const vaultKey = openVault(masterKey, vaultId, wrapped);
  try {
    return decryptText(vaultKey, vaultId, 'title', encryptedTitle);
  } finally {
    wipe(vaultKey);
  }
}

export function addLetter(vaultKey: Uint8Array, vaultId: string, itemId: string, body: string) {
  return { itemId, ciphertext: encryptText(vaultKey, vaultId, itemId, body) };
}

/* ------------------------------ granting --------------------------------- */

export interface GrantResult {
  grant: Grant;
  /** Human-readable custody statement, generated from the grant itself. */
  custody: string;
  /**
   * Codes for custodians with no enrolled key. Shown to the OWNER once, to pass
   * on as they see fit, and then dropped. Uploading these would collapse split
   * custody back into plain escrow — see the note in @vigil/crypto/release.ts.
   */
  claimCodes: Record<string, string>;
}

/**
 * Seal a vault for one recipient.
 *
 * Prefers RECIPIENT_KEYED whenever the recipient has enrolled a key, because it
 * is the only mode where Vigil genuinely cannot open the vault under any
 * circumstances. Falls back to split custody otherwise, which is the common case
 * at first: most recipients do not know the vault exists, and the owner often
 * prefers it stays that way.
 */
export function grantVaultTo(
  vaultKey: Uint8Array,
  grantId: string,
  recipient: { id: string; publicKey?: string },
  fallbackCustodians: CustodianSpec[],
  threshold = 2,
): GrantResult {
  if (recipient.publicKey) {
    const grant = createRecipientKeyedGrant(vaultKey, grantId, fromB64u(recipient.publicKey));
    return { grant, custody: describeCustody(grant), claimCodes: {} };
  }
  const { grant, claimCodes } = createSplitCustodyGrant(
    vaultKey, grantId, fallbackCustodians, threshold,
  );
  return { grant, custody: describeCustody(grant), claimCodes };
}

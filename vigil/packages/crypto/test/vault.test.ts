import { describe, it, expect } from 'vitest';
import {
  createIdentity, unlockIdentity, changePassphrase,
  createVault, openVault, encryptText, decryptText, encryptItem, decryptItem,
  generateKeyPair, sealTo, openSealed,
  ARGON2_TEST, AeadError, utf8, randomBytes,
} from '../src/index.js';

const PASS = 'a passphrase I will actually remember in ten years';

describe('identity', () => {
  it('creates, locks and unlocks', () => {
    const { masterKey, stored } = createIdentity(PASS, ARGON2_TEST);
    expect(masterKey.length).toBe(32);
    expect(unlockIdentity(PASS, stored)).toEqual(masterKey);
  });

  it('does not store the master key in the clear', () => {
    const { masterKey, stored } = createIdentity(PASS, ARGON2_TEST);
    const blob = JSON.stringify(stored);
    expect(blob).not.toContain(Buffer.from(masterKey).toString('base64'));
    expect(blob).not.toContain(PASS);
  });

  it('refuses the wrong passphrase', () => {
    const { stored } = createIdentity(PASS, ARGON2_TEST);
    expect(() => unlockIdentity('not it', stored)).toThrow(AeadError);
  });

  it('changes passphrase WITHOUT changing the master key', () => {
    const { masterKey, stored } = createIdentity(PASS, ARGON2_TEST);
    const rewrapped = changePassphrase(PASS, 'a new one', stored, ARGON2_TEST);
    // Same master key => vault content never needs re-encrypting.
    expect(unlockIdentity('a new one', rewrapped)).toEqual(masterKey);
    expect(() => unlockIdentity(PASS, rewrapped)).toThrow(AeadError);
    expect(rewrapped.kdfSalt).not.toBe(stored.kdfSalt);
  });
});

describe('vaults and items', () => {
  it('round-trips an item', () => {
    const { masterKey } = createIdentity(PASS, ARGON2_TEST);
    const { vaultKey, wrappedVaultKey } = createVault(masterKey, 'vault-maya');
    expect(openVault(masterKey, 'vault-maya', wrappedVaultKey)).toEqual(vaultKey);

    const letter = 'Maya — if you are reading this, I ran out of tomorrows. Here is what I never said.';
    const ct = encryptText(vaultKey, 'vault-maya', 'item-1', letter);
    expect(ct).not.toContain('Maya');
    expect(decryptText(vaultKey, 'vault-maya', 'item-1', ct)).toBe(letter);
  });

  it('binds ciphertext to its vault AND item id', () => {
    const { masterKey } = createIdentity(PASS, ARGON2_TEST);
    const { vaultKey } = createVault(masterKey, 'vault-a');
    const ct = encryptText(vaultKey, 'vault-a', 'item-1', 'secret');
    // Same key, wrong slot: an attacker with DB write access cannot shuffle rows.
    expect(() => decryptText(vaultKey, 'vault-a', 'item-2', ct)).toThrow(AeadError);
    expect(() => decryptText(vaultKey, 'vault-b', 'item-1', ct)).toThrow(AeadError);
  });

  it('keeps vaults cryptographically independent', () => {
    const { masterKey } = createIdentity(PASS, ARGON2_TEST);
    const a = createVault(masterKey, 'vault-letters');
    const b = createVault(masterKey, 'vault-bank');
    expect(a.vaultKey).not.toEqual(b.vaultKey);
    const ct = encryptText(a.vaultKey, 'vault-letters', 'i', 'a letter');
    // Handing the bank vault key to a recipient must not open the letters vault.
    expect(() => decryptText(b.vaultKey, 'vault-letters', 'i', ct)).toThrow(AeadError);
  });

  it('refuses a vault key wrapped for a different vault id', () => {
    const { masterKey } = createIdentity(PASS, ARGON2_TEST);
    const { wrappedVaultKey } = createVault(masterKey, 'vault-a');
    expect(() => openVault(masterKey, 'vault-b', wrappedVaultKey)).toThrow(AeadError);
  });

  it('handles binary payloads of awkward sizes', () => {
    const { masterKey } = createIdentity(PASS, ARGON2_TEST);
    const { vaultKey } = createVault(masterKey, 'v');
    for (const n of [0, 1, 15, 16, 17, 4096]) {
      const blob = randomBytes(n);
      expect(decryptItem(vaultKey, 'v', `i${n}`, encryptItem(vaultKey, 'v', `i${n}`, blob))).toEqual(blob);
    }
  });
});

describe('sealed boxes', () => {
  it('seals to a public key and opens with the private key', () => {
    const maya = generateKeyPair();
    const msg = utf8('the vault key');
    const box = sealTo(maya.publicKey, msg, 'ctx');
    expect(openSealed(maya.privateKey, box, 'ctx')).toEqual(msg);
  });

  it('cannot be opened by anyone else', () => {
    const maya = generateKeyPair();
    const stranger = generateKeyPair();
    const box = sealTo(maya.publicKey, utf8('x'), 'ctx');
    expect(() => openSealed(stranger.privateKey, box, 'ctx')).toThrow();
  });

  it('is not re-pointable at another recipient', () => {
    const maya = generateKeyPair();
    const box = sealTo(maya.publicKey, utf8('x'), 'ctx');
    expect(() => openSealed(maya.privateKey, box, 'different-ctx')).toThrow();
  });

  it('is non-deterministic (fresh ephemeral key each time)', () => {
    const maya = generateKeyPair();
    const a = sealTo(maya.publicKey, utf8('x'), 'ctx');
    const b = sealTo(maya.publicKey, utf8('x'), 'ctx');
    expect(a).not.toEqual(b);
  });

  it('rejects malformed keys and truncated boxes', () => {
    expect(() => sealTo(randomBytes(16), utf8('x'), 'c')).toThrow(/32 bytes/);
    expect(() => openSealed(generateKeyPair().privateKey, randomBytes(8), 'c')).toThrow(/truncated/);
  });
});

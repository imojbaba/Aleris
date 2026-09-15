import { describe, it, expect } from 'vitest';
import {
  createIdentity, createVault, encryptText, decryptText,
  generateKeyPair,
  createRecipientKeyedGrant, openRecipientKeyedGrant,
  createSplitCustodyGrant, openSplitCustodyGrant,
  unsealShareWithPrivateKey, unsealShareWithClaimCode,
  describeCustody, keyFromClaimCode,
  ARGON2_TEST,
} from '../src/index.js';

const LETTER = 'I kept meaning to tell you that the garden was always yours.';

function ownerWithVault() {
  const { masterKey } = createIdentity('owner passphrase', ARGON2_TEST);
  const { vaultKey } = createVault(masterKey, 'vault-1');
  const ciphertext = encryptText(vaultKey, 'vault-1', 'item-1', LETTER);
  return { vaultKey, ciphertext };
}

describe('RECIPIENT_KEYED release', () => {
  it('delivers the vault to the enrolled recipient', () => {
    const { vaultKey, ciphertext } = ownerWithVault();
    const maya = generateKeyPair();
    const grant = createRecipientKeyedGrant(vaultKey, 'grant-1', maya.publicKey);

    const recovered = openRecipientKeyedGrant(grant, maya.privateKey);
    expect(decryptText(recovered, 'vault-1', 'item-1', ciphertext)).toBe(LETTER);
  });

  it('is opaque to the service: the stored grant is all the server has', () => {
    const { vaultKey } = ownerWithVault();
    const maya = generateKeyPair();
    const grant = createRecipientKeyedGrant(vaultKey, 'grant-1', maya.publicKey);
    // Everything the server persists, serialised. It must contain no vault key.
    const serverState = JSON.stringify(grant);
    expect(serverState).not.toContain(Buffer.from(vaultKey).toString('base64url'));
    // And the server has no private key that opens it.
    expect(() => openRecipientKeyedGrant(grant, generateKeyPair().privateKey)).toThrow();
  });

  it('will not open a grant re-pointed to a different grant id', () => {
    const { vaultKey } = ownerWithVault();
    const maya = generateKeyPair();
    const grant = createRecipientKeyedGrant(vaultKey, 'grant-1', maya.publicKey);
    const forged = { ...grant, grantId: 'grant-2' };
    expect(() => openRecipientKeyedGrant(forged, maya.privateKey)).toThrow();
  });
});

describe('SPLIT_CUSTODY release', () => {
  const custodians = (recipientPub?: Uint8Array) => [
    { id: 'svc', kind: 'SERVICE' as const, publicKey: generateKeyPair().publicKey },
    { id: 'maya', kind: 'RECIPIENT' as const, ...(recipientPub ? { publicKey: recipientPub } : {}) },
    { id: 'uncle-ray', kind: 'VERIFIER' as const },
  ];

  it('opens when the service and one named human combine their shares', () => {
    const { vaultKey, ciphertext } = ownerWithVault();
    const svcKey = generateKeyPair();
    const specs = [
      { id: 'svc', kind: 'SERVICE' as const, publicKey: svcKey.publicKey },
      { id: 'maya', kind: 'RECIPIENT' as const },
      { id: 'uncle-ray', kind: 'VERIFIER' as const },
    ];
    const { grant, claimCodes } = createSplitCustodyGrant(vaultKey, 'g1', specs, 2);

    const svcShare = unsealShareWithPrivateKey(grant, 'svc', svcKey.privateKey);
    const mayaShare = unsealShareWithClaimCode(grant, 'maya', claimCodes.maya!);

    const recovered = openSplitCustodyGrant(grant, [svcShare, mayaShare]);
    expect(decryptText(recovered, 'vault-1', 'item-1', ciphertext)).toBe(LETTER);
  });

  it('opens via the verifier when the recipient has lost their code', () => {
    const { vaultKey } = ownerWithVault();
    const svcKey = generateKeyPair();
    const { grant, claimCodes } = createSplitCustodyGrant(
      vaultKey, 'g1',
      [
        { id: 'svc', kind: 'SERVICE', publicKey: svcKey.publicKey },
        { id: 'maya', kind: 'RECIPIENT' },
        { id: 'uncle-ray', kind: 'VERIFIER' },
      ],
      2,
    );
    const svcShare = unsealShareWithPrivateKey(grant, 'svc', svcKey.privateKey);
    const rayShare = unsealShareWithClaimCode(grant, 'uncle-ray', claimCodes['uncle-ray']!);
    expect(openSplitCustodyGrant(grant, [svcShare, rayShare])).toEqual(vaultKey);
  });

  /**
   * THE LOAD-BEARING TEST.
   *
   * Everything Vigil promises reduces to this: with the entire server-side
   * database in hand, and the service's own custody key, the service still
   * cannot open a user's vault. If this test ever goes green-by-weakening,
   * the product is no longer the thing we told people it was.
   */
  it('CANNOT be opened by the service alone, even holding the whole database', () => {
    const { vaultKey } = ownerWithVault();
    const svcKey = generateKeyPair();
    const { grant } = createSplitCustodyGrant(
      vaultKey, 'g1',
      [
        { id: 'svc', kind: 'SERVICE', publicKey: svcKey.publicKey },
        { id: 'maya', kind: 'RECIPIENT' },
        { id: 'uncle-ray', kind: 'VERIFIER' },
      ],
      2,
    );

    // The service has: the full grant row, and its own custody private key.
    const svcShare = unsealShareWithPrivateKey(grant, 'svc', svcKey.privateKey);

    // One share is one short of the threshold.
    expect(() => openSplitCustodyGrant(grant, [svcShare])).toThrow(/opens with 2 custodians/);

    // Nor can it read the other custodians' shares out of its own database.
    expect(() => unsealShareWithPrivateKey(grant, 'maya', svcKey.privateKey))
      .toThrow(/holds a CLAIM_CODE share/);
    expect(() => unsealShareWithClaimCode(grant, 'maya', 'GUESS-GUESS-GUESS-GUESS'))
      .toThrow();
  });

  it('refuses at construction time to create a grant the service could open alone', () => {
    const { vaultKey } = ownerWithVault();
    expect(() =>
      createSplitCustodyGrant(
        vaultKey, 'g1',
        [
          { id: 'svc1', kind: 'SERVICE', publicKey: generateKeyPair().publicKey },
          { id: 'svc2', kind: 'SERVICE', publicKey: generateKeyPair().publicKey },
          { id: 'maya', kind: 'RECIPIENT' },
        ],
        2,
      ),
    ).toThrow(/release unilaterally/);
  });

  it('refuses a threshold of 1', () => {
    const { vaultKey } = ownerWithVault();
    expect(() => createSplitCustodyGrant(vaultKey, 'g1', custodians(), 1)).toThrow(/at least 2/);
  });

  it('refuses a threshold larger than the custodian count, and duplicate ids', () => {
    const { vaultKey } = ownerWithVault();
    expect(() => createSplitCustodyGrant(vaultKey, 'g1', custodians(), 9)).toThrow(/cannot exceed/);
    expect(() =>
      createSplitCustodyGrant(
        vaultKey, 'g1',
        [
          { id: 'dup', kind: 'SERVICE', publicKey: generateKeyPair().publicKey },
          { id: 'dup', kind: 'RECIPIENT' },
          { id: 'x', kind: 'VERIFIER' },
        ],
        2,
      ),
    ).toThrow(/unique/);
  });

  it('does not persist claim codes anywhere in the grant', () => {
    const { vaultKey } = ownerWithVault();
    const { grant, claimCodes } = createSplitCustodyGrant(
      vaultKey, 'g1',
      [
        { id: 'svc', kind: 'SERVICE', publicKey: generateKeyPair().publicKey },
        { id: 'maya', kind: 'RECIPIENT' },
      ],
      2,
    );
    const serialised = JSON.stringify(grant);
    for (const code of Object.values(claimCodes)) {
      expect(serialised).not.toContain(code);
      expect(serialised).not.toContain(code.replace(/-/g, ''));
    }
  });

  it('accepts a claim code typed back with lowercase and missing dashes', () => {
    const a = keyFromClaimCode('ABCDE-FGHJK-MNPQR-STVWX', 'g1', 'c1');
    const b = keyFromClaimCode('abcdefghjk mnpqr stvwx'.replace(/ /g, ''), 'g1', 'c1');
    expect(a).toEqual(b);
  });

  it('rejects a low-entropy claim code rather than deriving a guessable key', () => {
    expect(() => keyFromClaimCode('SHORT', 'g1', 'c1')).toThrow(/entropy/);
  });

  it('binds each share to its custodian, so shares cannot be swapped between slots', () => {
    const { vaultKey } = ownerWithVault();
    const { grant, claimCodes } = createSplitCustodyGrant(
      vaultKey, 'g1',
      [
        { id: 'svc', kind: 'SERVICE', publicKey: generateKeyPair().publicKey },
        { id: 'maya', kind: 'RECIPIENT' },
        { id: 'uncle-ray', kind: 'VERIFIER' },
      ],
      2,
    );
    // Uncle Ray's code must not open Maya's share.
    expect(() => unsealShareWithClaimCode(grant, 'maya', claimCodes['uncle-ray']!)).toThrow();
  });

  it('supports 3-of-5 for people who want more ceremony', () => {
    const { vaultKey } = ownerWithVault();
    const { grant, claimCodes } = createSplitCustodyGrant(
      vaultKey, 'g1',
      [
        { id: 'svc', kind: 'SERVICE', publicKey: generateKeyPair().publicKey },
        { id: 'maya', kind: 'RECIPIENT' },
        { id: 'ray', kind: 'VERIFIER' },
        { id: 'solicitor', kind: 'VERIFIER' },
        { id: 'recovery', kind: 'OWNER_RECOVERY' },
      ],
      3,
    );
    const shares = ['maya', 'ray', 'solicitor'].map((id) =>
      unsealShareWithClaimCode(grant, id, claimCodes[id]!),
    );
    expect(openSplitCustodyGrant(grant, shares)).toEqual(vaultKey);
    expect(() => openSplitCustodyGrant(grant, shares.slice(0, 2))).toThrow(/opens with 3/);
  });
});

describe('describeCustody', () => {
  it('states the recipient-keyed guarantee without weasel words', () => {
    const { vaultKey } = ownerWithVault();
    const grant = createRecipientKeyedGrant(vaultKey, 'g', generateKeyPair().publicKey);
    expect(describeCustody(grant)).toMatch(/cannot open it/);
  });

  it('counts real shares, and says how far short the service is', () => {
    const { vaultKey } = ownerWithVault();
    const { grant } = createSplitCustodyGrant(
      vaultKey, 'g',
      [
        { id: 'svc', kind: 'SERVICE', publicKey: generateKeyPair().publicKey },
        { id: 'maya', kind: 'RECIPIENT' },
        { id: 'ray', kind: 'VERIFIER' },
      ],
      2,
    );
    const text = describeCustody(grant);
    expect(text).toContain('2-of-3');
    expect(text).toContain('Vigil holds 1 key piece');
    expect(text).toMatch(/we are 1 piece short/);
  });
});

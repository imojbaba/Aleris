import { describe, it, expect } from 'vitest';
import {
  createIdentity, createVault, encryptText, decryptText,
  generateKeyPair, createSplitCustodyGrant, unsealShareWithPrivateKey, unsealShareWithClaimCode,
  beginClaim, releaseShareToClaim, receiveShare, completeClaim,
  reprotectShareWithAnswer, unprotectShareWithAnswer, normaliseAnswer,
  keyFromRelationshipProof, describePosture, posture, questionFingerprint,
  ARGON2_TEST, PROOF_ARGON2_TEST, randomBytes, toB64u,
} from '../src/index.js';

const LETTER = 'The garden was always yours. Your grandmother planted the quince the week you were born.';
const QUESTION = 'What did we call the dog?';
const ANSWER = 'Biscuit';
const DELIVERY = 'delivery-1';

/**
 * The whole journey, as one test.
 *
 * Jo seals a vault for Maya today. Years later Jo stops answering, the workflow
 * runs, and Maya — who has never heard of Vigil — opens a link on her phone.
 * Everything below happens on Maya's device except the relaying.
 */
function setup(threshold = 2) {
  const { masterKey } = createIdentity('owner passphrase', ARGON2_TEST);
  const { vaultKey } = createVault(masterKey, 'vault-1');
  const ciphertext = encryptText(vaultKey, 'vault-1', 'item-1', LETTER);

  const service = generateKeyPair();
  const ray = generateKeyPair();
  const proofSalt = randomBytes(16);

  const built = createSplitCustodyGrant(
    vaultKey, 'g1',
    [
      { id: 'service', kind: 'SERVICE', publicKey: service.publicKey },
      { id: 'maya', kind: 'RECIPIENT' },
      { id: 'ray', kind: 'VERIFIER', publicKey: ray.publicKey },
    ],
    threshold,
  );

  // Maya's share moves from a claim code to the owner's question, on Jo's
  // device, before anything is uploaded. The code is then dropped.
  const grant = reprotectShareWithAnswer(
    built.grant, 'maya', built.claimCodes.maya!, ANSWER, DELIVERY, proofSalt, PROOF_ARGON2_TEST,
  );

  return { vaultKey, ciphertext, grant, service, ray, proofSalt };
}

describe('the redeem flow, end to end', () => {
  it('lets Maya open the vault with her answer and the service’s share', () => {
    const { ciphertext, grant, service, proofSalt } = setup();

    // 1. Maya proves control of her email (server-side OTP — not modelled here;
    //    it gates the flow, it is not what protects the vault).
    // 2. Her browser opens a claim session.
    const session = beginClaim(DELIVERY);

    // 3. The service releases ITS share to that session. It never sees the rest.
    const serviceShare = unsealShareWithPrivateKey(grant, 'service', service.privateKey);
    const relayed = releaseShareToClaim(serviceShare, session.publicKey, DELIVERY, 'service');

    // 4. Maya answers Jo's question. The answer never leaves her device.
    const mayaShare = unprotectShareWithAnswer(
      grant.shares.find((s) => s.custodianId === 'maya')!.sealed,
      ANSWER, DELIVERY, proofSalt, PROOF_ARGON2_TEST,
    );

    // 5. Her device combines and opens the vault.
    const recovered = completeClaim(grant, [receiveShare(session, relayed, 'service'), mayaShare]);
    expect(decryptText(recovered, 'vault-1', 'item-1', ciphertext)).toBe(LETTER);
  });

  it('also opens when Maya has forgotten the answer but Ray confirms', () => {
    const { ciphertext, grant, service, ray } = setup();
    const session = beginClaim(DELIVERY);

    // Ray, having answered the wellbeing check, releases his share to Maya's
    // session. This is the resilience path: the family is not locked out
    // because one person cannot remember a dog's name.
    const relays = [
      releaseShareToClaim(unsealShareWithPrivateKey(grant, 'service', service.privateKey), session.publicKey, DELIVERY, 'service'),
      releaseShareToClaim(unsealShareWithPrivateKey(grant, 'ray', ray.privateKey), session.publicKey, DELIVERY, 'ray'),
    ];
    const shares = [receiveShare(session, relays[0]!, 'service'), receiveShare(session, relays[1]!, 'ray')];
    expect(decryptText(completeClaim(grant, shares), 'vault-1', 'item-1', ciphertext)).toBe(LETTER);
  });

  it('can be set to require BOTH the answer and a confirmer', () => {
    // Threshold 3 of 3: for a vault where the owner wants more ceremony.
    const { ciphertext, grant, service, ray, proofSalt } = setup(3);
    const session = beginClaim(DELIVERY);
    const serviceShare = receiveShare(session, releaseShareToClaim(
      unsealShareWithPrivateKey(grant, 'service', service.privateKey), session.publicKey, DELIVERY, 'service'), 'service');
    const rayShare = receiveShare(session, releaseShareToClaim(
      unsealShareWithPrivateKey(grant, 'ray', ray.privateKey), session.publicKey, DELIVERY, 'ray'), 'ray');

    expect(() => completeClaim(grant, [serviceShare, rayShare])).toThrow(/opens with 3 key pieces/);

    const mayaShare = unprotectShareWithAnswer(
      grant.shares.find((s) => s.custodianId === 'maya')!.sealed,
      ANSWER, DELIVERY, proofSalt, PROOF_ARGON2_TEST,
    );
    expect(decryptText(completeClaim(grant, [serviceShare, rayShare, mayaShare]), 'vault-1', 'item-1', ciphertext))
      .toBe(LETTER);
  });
});

describe('what the service can and cannot do', () => {
  /**
   * THE LOAD-BEARING TEST for the redeem flow.
   *
   * The service holds the full grant, its own custody key, and every blob it
   * relayed. It still cannot open the vault — because the blobs are sealed to a
   * keypair that only ever existed in Maya's browser.
   */
  it('cannot read what it relays, and cannot open the vault with everything it has', () => {
    const { vaultKey, grant, service, ray } = setup();
    const session = beginClaim(DELIVERY);

    const serviceShare = unsealShareWithPrivateKey(grant, 'service', service.privateKey);
    const relayedService = releaseShareToClaim(serviceShare, session.publicKey, DELIVERY, 'service');
    const relayedRay = releaseShareToClaim(
      unsealShareWithPrivateKey(grant, 'ray', ray.privateKey), session.publicKey, DELIVERY, 'ray');

    // Everything the service holds, serialised.
    const held = JSON.stringify({ grant, relayedService, relayedRay, serviceKey: toB64u(service.privateKey) });
    expect(held).not.toContain(toB64u(vaultKey));

    // It has one share, and the threshold is two.
    expect(() => completeClaim(grant, [serviceShare])).toThrow(/opens with 2 key pieces/);

    // The relayed blobs are sealed to a key that exists only in Maya's browser.
    const impostor = beginClaim(DELIVERY);
    expect(() => receiveShare(impostor, relayedRay, 'ray')).toThrow();
    expect(() => receiveShare(impostor, relayedService, 'service')).toThrow();
  });

  it('cannot re-point a relayed share at a different custodian slot', () => {
    const { grant, service } = setup();
    const session = beginClaim(DELIVERY);
    const relayed = releaseShareToClaim(
      unsealShareWithPrivateKey(grant, 'service', service.privateKey), session.publicKey, DELIVERY, 'service');
    expect(() => receiveShare(session, relayed, 'ray')).toThrow();
  });

  it('cannot reuse a relay from one delivery in another', () => {
    const { grant, service } = setup();
    const session = beginClaim('delivery-2');
    const relayed = releaseShareToClaim(
      unsealShareWithPrivateKey(grant, 'service', service.privateKey), session.publicKey, DELIVERY, 'service');
    expect(() => receiveShare(session, relayed, 'service')).toThrow();
  });
});

describe('the relationship proof', () => {
  it('fails closed on a wrong answer — there is no oracle to bypass', () => {
    const { grant, proofSalt } = setup();
    const sealed = grant.shares.find((s) => s.custodianId === 'maya')!.sealed;
    for (const wrong of ['Rover', 'biscuits', 'Bisc', 'the dog']) {
      expect(() => unprotectShareWithAnswer(sealed, wrong, DELIVERY, proofSalt, PROOF_ARGON2_TEST), wrong)
        .toThrow();
    }
  });

  it('forgives capitals, spacing, punctuation and accents', () => {
    const { grant, proofSalt } = setup();
    const sealed = grant.shares.find((s) => s.custodianId === 'maya')!.sealed;
    for (const variant of ['biscuit', '  Biscuit ', 'BISCUIT!', 'Bíscuit']) {
      expect(() => unprotectShareWithAnswer(sealed, variant, DELIVERY, proofSalt, PROOF_ARGON2_TEST), variant)
        .not.toThrow();
    }
  });

  it('normalises the way a grieving person types', () => {
    expect(normaliseAnswer('  St. Mary’s  ')).toBe(normaliseAnswer('st marys'));
    expect(normaliseAnswer('José')).toBe('jose');
    expect(normaliseAnswer('42 Acacia Road')).toBe('42acaciaroad');
  });

  it('refuses an answer too short to be worth anything', () => {
    expect(() => keyFromRelationshipProof('no', DELIVERY, randomBytes(16), PROOF_ARGON2_TEST))
      .toThrow(/at least 3/);
    expect(() => keyFromRelationshipProof('Biscuit', DELIVERY, randomBytes(8), PROOF_ARGON2_TEST))
      .toThrow(/16 bytes/);
  });

  it('is bound to the delivery, so a share cannot be lifted between deliveries', () => {
    const salt = randomBytes(16);
    const a = keyFromRelationshipProof(ANSWER, 'delivery-1', salt, PROOF_ARGON2_TEST);
    const b = keyFromRelationshipProof(ANSWER, 'delivery-2', salt, PROOF_ARGON2_TEST);
    expect(a).not.toEqual(b);
  });

  it('stores nothing that reveals the answer', () => {
    const { grant } = setup();
    const stored = JSON.stringify(grant);
    for (const leak of ['Biscuit', 'biscuit', 'BISCUIT']) {
      expect(stored).not.toContain(leak);
    }
    // The question is safe to show; its fingerprint is stable.
    expect(questionFingerprint(QUESTION)).toBe(questionFingerprint('  what did we call the dog?  '));
  });
});

describe('the posture is stated honestly', () => {
  it('says plainly when Vigil cannot open a vault, and how far short it is', () => {
    const { grant } = setup();
    expect(posture(grant)).toBe('SPLIT');
    const text = describePosture(grant);
    expect(text).toMatch(/Vigil cannot open this one/);
    expect(text).toMatch(/we are 1 short/);
    expect(text).toMatch(/court order/);
  });

  it('admits it just as plainly when the owner chose convenience', () => {
    const { masterKey } = createIdentity('pw', ARGON2_TEST);
    const { vaultKey } = createVault(masterKey, 'v');
    // The owner has accepted that Vigil can open this, to be sure it arrives.
    const { grant } = createSplitCustodyGrant(
      vaultKey, 'g1',
      [
        { id: 'svc-a', kind: 'SERVICE', publicKey: generateKeyPair().publicKey },
        { id: 'maya', kind: 'RECIPIENT' },
      ],
      2,
    );
    const assisted = { ...grant, shares: grant.shares.map((s) => ({ ...s, kind: 'SERVICE' as const })) };
    expect(posture(assisted)).toBe('SERVICE_ASSISTED');
    expect(describePosture(assisted)).toMatch(/Vigil can open this one/);
    expect(describePosture(assisted)).toMatch(/we could be compelled to/);
  });
});

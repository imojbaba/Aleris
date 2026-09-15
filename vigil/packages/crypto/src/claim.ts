import { argon2id } from '@noble/hashes/argon2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { seal, open } from './aead.js';
import { generateKeyPair, sealTo, openSealed, type KeyPair } from './recipient.js';
import { combineEncoded } from './shamir.js';
import { fromB64u, toB64u, utf8, wipe } from './bytes.js';
import { subkey } from './kdf.js';
import { type SplitCustodyGrant, unsealShareWithClaimCode } from './release.js';

/**
 * The redeem flow: how a bereaved person actually gets what was left for them.
 *
 * The obvious implementation is that the service holds the keys, checks an OTP,
 * and hands them over. It gives exactly the user experience we want and it
 * quietly voids the only promise this product makes, because a service that can
 * hand over keys after an OTP can hand them over for any other reason too — a
 * court order, a rogue employee, a bug in the OTP check.
 *
 * So the same experience is built a different way. The recipient's own device
 * is the place where key material comes together. The service relays sealed
 * blobs it cannot read, and holds one share of a threshold it is short of.
 *
 *   1. The trigger fires. The service emails/WhatsApps the recipient a link.
 *   2. They prove control of the address the owner recorded (OTP — server-side,
 *      rate-limited; it gates the flow but is NOT what protects the vault).
 *   3. Their browser makes an ephemeral keypair — the CLAIM SESSION.
 *   4. The service seals ITS share to that public key. Each verifier, prompted,
 *      seals theirs. The service relays ciphertext it has no key for.
 *   5. They answer the owner's question ("What did we call the dog?"). The
 *      answer is not checked against anything — it IS part of the key.
 *   6. Their device combines the shares and opens the vault.
 *
 * At no instant does any machine we run hold enough to open anything.
 */

/* ----------------------- the relationship proof -------------------------- */

/**
 * "Find a smart way to prove they are related."
 *
 * Identity documents are hostile to a grieving family and prove the wrong
 * thing anyway — that someone is Maya Iyer, not that they are the Maya the
 * owner meant. So the owner writes a question only their person could answer,
 * and the ANSWER NEVER LEAVES THE RECIPIENT'S DEVICE and is never stored in any
 * form. It is fed into the key.
 *
 * That choice matters more than it looks. If we stored a hash and compared it,
 * we would be the ones deciding whether the answer was right — which means we
 * could decide it was right when it wasn't. Deriving from it instead means a
 * wrong answer produces a wrong key and the ciphertext simply does not open.
 * There is no oracle, no bypass, and nothing for us to be compelled to skip.
 *
 * Answers are low-entropy, so this is Argon2id rather than a fast hash, and the
 * OTP gate in front of it means an attacker cannot even start guessing without
 * first controlling the recipient's mailbox or phone.
 */
export const PROOF_ARGON2 = { m: 19_456, t: 3, p: 1 } as const;
export const PROOF_ARGON2_TEST = { m: 256, t: 1, p: 1 } as const;

/**
 * Forgiving normalisation. Someone typing their mother's answer through tears
 * on a phone keyboard should not fail because of a capital letter or a stray
 * full stop.
 */
export function normaliseAnswer(answer: string): string {
  return answer
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // strip accents: "José" === "jose"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')           // punctuation, spaces, emoji
    .trim();
}

export const MIN_ANSWER_LENGTH = 3;

export function keyFromRelationshipProof(
  answer: string,
  deliveryId: string,
  salt: Uint8Array,
  params: { m: number; t: number; p: number } = PROOF_ARGON2,
): Uint8Array {
  const normalised = normaliseAnswer(answer);
  if (normalised.length < MIN_ANSWER_LENGTH) {
    throw new Error(`answer must be at least ${MIN_ANSWER_LENGTH} characters`);
  }
  if (salt.length < 16) throw new Error('salt must be at least 16 bytes');
  const material = argon2id(utf8(normalised), salt, { ...params, dkLen: 32 });
  try {
    return subkey(material, `proof/${deliveryId}`);
  } finally {
    wipe(material);
  }
}

const aadProof = (deliveryId: string) => `vigil/v1/claim/${deliveryId}/proof`;

/**
 * Wrap a custodian share behind the owner's question, at setup time on the
 * owner's device. The question travels with the delivery; the answer does not.
 */
export function protectShareWithAnswer(
  encodedShare: Uint8Array,
  answer: string,
  deliveryId: string,
  salt: Uint8Array,
  params?: { m: number; t: number; p: number },
): string {
  const key = keyFromRelationshipProof(answer, deliveryId, salt, params);
  try {
    return toB64u(seal(key, encodedShare, aadProof(deliveryId)));
  } finally {
    wipe(key);
  }
}

export function unprotectShareWithAnswer(
  protectedShare: string,
  answer: string,
  deliveryId: string,
  salt: Uint8Array,
  params?: { m: number; t: number; p: number },
): Uint8Array {
  const key = keyFromRelationshipProof(answer, deliveryId, salt, params);
  try {
    return open(key, fromB64u(protectedShare), aadProof(deliveryId));
  } finally {
    wipe(key);
  }
}

/* -------------------------- the claim session ---------------------------- */

export interface ClaimSession extends KeyPair {
  deliveryId: string;
}

/** Runs in the recipient's browser. The private key never leaves it. */
export function beginClaim(deliveryId: string): ClaimSession {
  return { ...generateKeyPair(), deliveryId };
}

const aadRelay = (deliveryId: string, custodianId: string) =>
  `vigil/v1/claim/${deliveryId}/relay/${custodianId}`;

/**
 * A custodian releases their share TO THE CLAIM SESSION, not to us.
 *
 * Called by the service for its own share, and by each verifier's device for
 * theirs. What the service stores and forwards is a blob sealed to a public key
 * it does not hold the other half of. Relaying is all it can do.
 */
export function releaseShareToClaim(
  encodedShare: Uint8Array,
  claimPublicKey: Uint8Array,
  deliveryId: string,
  custodianId: string,
): string {
  return toB64u(sealTo(claimPublicKey, encodedShare, aadRelay(deliveryId, custodianId)));
}

export function receiveShare(
  session: ClaimSession,
  relayed: string,
  custodianId: string,
): Uint8Array {
  return openSealed(session.privateKey, fromB64u(relayed), aadRelay(session.deliveryId, custodianId));
}

/**
 * The last step, on the recipient's device: combine the shares that reached
 * this session and open the vault.
 */
export function completeClaim(
  grant: SplitCustodyGrant,
  shares: Uint8Array[],
): Uint8Array {
  if (shares.length < grant.threshold) {
    throw new Error(
      `this vault opens with ${grant.threshold} key pieces; ${shares.length} reached you`,
    );
  }
  const releaseKey = combineEncoded(shares);
  try {
    return open(releaseKey, fromB64u(grant.wrappedVaultKey), `vigil/v1/grant/${grant.grantId}/vault-key`);
  } finally {
    wipe(releaseKey);
  }
}

/* ------------------------------ the posture ------------------------------ */

/**
 * What the owner chose, and what it costs them — stated in the owner's own
 * terms, from the real grant rather than from a marketing page.
 *
 * Both postures are legitimate and it is genuinely the owner's call, so the app
 * shows this sentence at the moment of choosing rather than burying the
 * difference. The convenience posture is a real answer to a real fear: that
 * everyone named will be unreachable or overwhelmed when the time comes, and
 * the letters will never arrive at all.
 */
export type CustodyPosture = 'SPLIT' | 'SERVICE_ASSISTED';

export function posture(grant: SplitCustodyGrant): CustodyPosture {
  const serviceShares = grant.shares.filter((s) => s.kind === 'SERVICE').length;
  return serviceShares >= grant.threshold ? 'SERVICE_ASSISTED' : 'SPLIT';
}

export function describePosture(grant: SplitCustodyGrant): string {
  const service = grant.shares.filter((s) => s.kind === 'SERVICE').length;
  const others = grant.shares.length - service;
  if (posture(grant) === 'SERVICE_ASSISTED') {
    return (
      'Vigil can open this one. You chose certainty of delivery over secrecy from us: ' +
      'if everyone you named is unreachable, we can still hand it over — and that also means ' +
      'we could be compelled to.'
    );
  }
  return (
    `Vigil cannot open this one. It takes ${grant.threshold} key pieces of ${grant.shares.length}; ` +
    `we hold ${service} and the people you named hold ${others}. ` +
    `On our own we are ${grant.threshold - service} short — so a court order served on us, ` +
    `a dishonest employee, or someone stealing our whole database all come away with nothing.`
  );
}

/** A stable fingerprint of a question, for showing the owner what they set. */
export function questionFingerprint(question: string): string {
  return toB64u(sha256(utf8(question.trim().toLowerCase())).subarray(0, 6));
}

/**
 * Swap one custodian's claim-code protection for the owner's question.
 *
 * Run on the owner's device at setup, immediately after building the grant,
 * while the claim code is still in memory and before anything is uploaded. The
 * code is then dropped; the question travels with the delivery and the answer
 * is never recorded anywhere.
 */
export function reprotectShareWithAnswer(
  grant: SplitCustodyGrant,
  custodianId: string,
  claimCode: string,
  answer: string,
  deliveryId: string,
  salt: Uint8Array,
  params?: { m: number; t: number; p: number },
): SplitCustodyGrant {
  const encodedShare = unsealShareWithClaimCode(grant, custodianId, claimCode);
  const protectedShare = protectShareWithAnswer(encodedShare, answer, deliveryId, salt, params);
  return {
    ...grant,
    shares: grant.shares.map((s) =>
      s.custodianId === custodianId
        ? { ...s, protection: 'RELATIONSHIP_PROOF' as const, sealed: protectedShare }
        : s,
    ),
  };
}

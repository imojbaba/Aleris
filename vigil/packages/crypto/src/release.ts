import { seal, open } from './aead.js';
import { sealTo, openSealed } from './recipient.js';
import { combineEncoded, encodeShare, split } from './shamir.js';
import { fromB64u, toB64u, utf8, wipe } from './bytes.js';
import { randomClaimCode, randomKey } from './random.js';
import { subkey } from './kdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Release: how a vault key reaches a living person after the owner cannot help.
 *
 * Vigil supports two modes, and the difference between them is a real
 * difference in what we are able to promise. We show the user which one each
 * recipient is on, in plain words, rather than printing "end-to-end encrypted"
 * over both and hoping nobody asks.
 *
 * ── RECIPIENT_KEYED ────────────────────────────────────────────────────────
 * The recipient has installed Vigil and enrolled a key. The vault key is sealed
 * directly to their public key. Our servers hold a ciphertext they cannot open,
 * full stop, forever. This is the mode we push people towards.
 *
 * Cost: the recipient must enrol while the owner is alive, and must not lose
 * their key — which is exactly the failure a grieving family is most likely to
 * hit. That is why it is not the only mode.
 *
 * ── SPLIT_CUSTODY ──────────────────────────────────────────────────────────
 * The recipient has not enrolled — often they do not know the vault exists, and
 * the owner would rather it stayed that way. The vault key is wrapped under a
 * Release Key which is Shamir-split k-of-n across custodians:
 *
 *     • the Vigil service           (1 share, sealed under a KMS/HSM key)
 *     • the recipient               (1 share, sealed under a claim code that
 *                                    exists only in the delivery message)
 *     • each verifier the owner names (1 share each — a sibling, a solicitor)
 *     • the owner's own recovery share
 *
 * with k ≥ 2 enforced below. The service therefore holds strictly fewer shares
 * than the threshold. A rogue employee, a subpoena served on us alone, or a
 * full database exfiltration does not yield a vault key, because the missing
 * share is not ours to hand over. That is a structural claim, not a policy one,
 * and it is the reason this file exists in this shape.
 */

export type CustodianKind = 'SERVICE' | 'RECIPIENT' | 'VERIFIER' | 'OWNER_RECOVERY';

export interface CustodianSpec {
  id: string;
  kind: CustodianKind;
  /** An enrolled X25519 public key, if this custodian has one. */
  publicKey?: Uint8Array;
}

export interface SealedShare {
  custodianId: string;
  kind: CustodianKind;
  index: number;
  /** Sealed to either the custodian's public key or their claim code. */
  protection: 'PUBLIC_KEY' | 'CLAIM_CODE';
  sealed: string;
}

export interface SplitCustodyGrant {
  v: 1;
  mode: 'SPLIT_CUSTODY';
  grantId: string;
  threshold: number;
  wrappedVaultKey: string;
  shares: SealedShare[];
}

export interface RecipientKeyedGrant {
  v: 1;
  mode: 'RECIPIENT_KEYED';
  grantId: string;
  sealedVaultKey: string;
}

export type Grant = SplitCustodyGrant | RecipientKeyedGrant;

const aadVaultKey = (grantId: string) => `vigil/v1/grant/${grantId}/vault-key`;
const aadShare = (grantId: string, custodianId: string) =>
  `vigil/v1/grant/${grantId}/share/${custodianId}`;

/* ---------------------------- recipient-keyed ---------------------------- */

export function createRecipientKeyedGrant(
  vaultKey: Uint8Array,
  grantId: string,
  recipientPublicKey: Uint8Array,
): RecipientKeyedGrant {
  return {
    v: 1,
    mode: 'RECIPIENT_KEYED',
    grantId,
    sealedVaultKey: toB64u(sealTo(recipientPublicKey, vaultKey, aadVaultKey(grantId))),
  };
}

export function openRecipientKeyedGrant(
  grant: RecipientKeyedGrant,
  recipientPrivateKey: Uint8Array,
): Uint8Array {
  return openSealed(recipientPrivateKey, fromB64u(grant.sealedVaultKey), aadVaultKey(grant.grantId));
}

/* ----------------------------- split custody ----------------------------- */

/**
 * Claim codes carry ~100 bits of entropy (20 Crockford base32 characters), so a
 * fast KDF is appropriate and a slow one would only punish the recipient. The
 * assertion below is what keeps that true: shorten the code and this throws
 * rather than silently degrading to a guessable key.
 */
const MIN_CLAIM_CODE_ENTROPY_CHARS = 16;

export function keyFromClaimCode(code: string, grantId: string, custodianId: string): Uint8Array {
  const normalised = code.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (normalised.length < MIN_CLAIM_CODE_ENTROPY_CHARS) {
    throw new Error(
      `claim code must carry at least ${MIN_CLAIM_CODE_ENTROPY_CHARS} characters of entropy`,
    );
  }
  return subkey(sha256(utf8(normalised)), `claim/${grantId}/${custodianId}`);
}

export interface CreatedSplitCustodyGrant {
  grant: SplitCustodyGrant;
  /**
   * Claim codes for custodians without an enrolled key, keyed by custodian id.
   *
   * THESE MUST NOT BE PERSISTED BY THE SERVICE. The caller delivers each code
   * out-of-band (the recipient's code is embedded in the release message; a
   * verifier's is shown to the owner once, to pass on however they choose) and
   * then drops it. Storing them next to the sealed shares would collapse the
   * whole scheme back to single-party custody and make every word of the
   * comment at the top of this file a lie.
   */
  claimCodes: Record<string, string>;
}

export function createSplitCustodyGrant(
  vaultKey: Uint8Array,
  grantId: string,
  custodians: CustodianSpec[],
  threshold: number,
): CreatedSplitCustodyGrant {
  if (custodians.length < 2) throw new Error('split custody needs at least 2 custodians');
  if (threshold < 2) {
    throw new Error('threshold must be at least 2 so that no single custodian can release alone');
  }
  if (threshold > custodians.length) throw new Error('threshold cannot exceed the custodian count');

  const serviceShares = custodians.filter((c) => c.kind === 'SERVICE').length;
  if (serviceShares >= threshold) {
    throw new Error(
      'the service would hold enough shares to release unilaterally; refusing to create this grant',
    );
  }

  const ids = new Set(custodians.map((c) => c.id));
  if (ids.size !== custodians.length) throw new Error('custodian ids must be unique');

  const releaseKey = randomKey();
  const wrappedVaultKey = toB64u(seal(releaseKey, vaultKey, aadVaultKey(grantId)));
  const rawShares = split(releaseKey, { threshold, shares: custodians.length });

  const claimCodes: Record<string, string> = {};
  const shares: SealedShare[] = custodians.map((custodian, i) => {
    const encoded = encodeShare(rawShares[i]!, threshold, releaseKey);
    const aad = aadShare(grantId, custodian.id);

    if (custodian.publicKey) {
      return {
        custodianId: custodian.id,
        kind: custodian.kind,
        index: rawShares[i]!.index,
        protection: 'PUBLIC_KEY',
        sealed: toB64u(sealTo(custodian.publicKey, encoded, aad)),
      };
    }

    const code = randomClaimCode();
    claimCodes[custodian.id] = code;
    const key = keyFromClaimCode(code, grantId, custodian.id);
    try {
      return {
        custodianId: custodian.id,
        kind: custodian.kind,
        index: rawShares[i]!.index,
        protection: 'CLAIM_CODE',
        sealed: toB64u(seal(key, encoded, aad)),
      };
    } finally {
      wipe(key);
    }
  });

  wipe(releaseKey);
  return { grant: { v: 1, mode: 'SPLIT_CUSTODY', grantId, threshold, wrappedVaultKey, shares }, claimCodes };
}

export function unsealShareWithPrivateKey(
  grant: SplitCustodyGrant,
  custodianId: string,
  privateKey: Uint8Array,
): Uint8Array {
  const share = requireShare(grant, custodianId, 'PUBLIC_KEY');
  return openSealed(privateKey, fromB64u(share.sealed), aadShare(grant.grantId, custodianId));
}

export function unsealShareWithClaimCode(
  grant: SplitCustodyGrant,
  custodianId: string,
  code: string,
): Uint8Array {
  const share = requireShare(grant, custodianId, 'CLAIM_CODE');
  const key = keyFromClaimCode(code, grant.grantId, custodianId);
  try {
    return open(key, fromB64u(share.sealed), aadShare(grant.grantId, custodianId));
  } finally {
    wipe(key);
  }
}

/** Combine unsealed shares and unwrap the vault key. */
export function openSplitCustodyGrant(
  grant: SplitCustodyGrant,
  unsealedShares: Uint8Array[],
): Uint8Array {
  if (unsealedShares.length < grant.threshold) {
    throw new Error(
      `this vault opens with ${grant.threshold} custodians; ${unsealedShares.length} presented`,
    );
  }
  const releaseKey = combineEncoded(unsealedShares);
  try {
    return open(releaseKey, fromB64u(grant.wrappedVaultKey), aadVaultKey(grant.grantId));
  } finally {
    wipe(releaseKey);
  }
}

function requireShare(
  grant: SplitCustodyGrant,
  custodianId: string,
  protection: SealedShare['protection'],
): SealedShare {
  const share = grant.shares.find((s) => s.custodianId === custodianId);
  if (!share) throw new Error(`no share for custodian ${custodianId}`);
  if (share.protection !== protection) {
    throw new Error(`custodian ${custodianId} holds a ${share.protection} share, not ${protection}`);
  }
  return share;
}

/* ------------------------------------------------------------------------- *
 * Plain-language custody summary.
 *
 * This feeds the "who can open this" screen. The user is making an irreversible
 * decision about their private life on our word; they are owed a sentence they
 * can actually evaluate, generated from the real grant rather than written by
 * marketing.
 * ------------------------------------------------------------------------- */
export function describeCustody(grant: Grant): string {
  if (grant.mode === 'RECIPIENT_KEYED') {
    return 'Sealed to this person’s own key. Vigil stores it but cannot open it — not for anyone, including a court order or us.';
  }
  const byKind = grant.shares.reduce<Record<string, number>>((acc, s) => {
    acc[s.kind] = (acc[s.kind] ?? 0) + 1;
    return acc;
  }, {});
  const service = byKind.SERVICE ?? 0;
  const others = grant.shares.length - service;
  return (
    `Split ${grant.threshold}-of-${grant.shares.length}. ` +
    `Vigil holds ${service} key piece${service === 1 ? '' : 's'}; ${others} ` +
    `${others === 1 ? 'is' : 'are'} held by the people you named. ` +
    `Vigil needs at least ${grant.threshold - service} of them to agree before anything opens — ` +
    `on our own, we are ${grant.threshold - service} piece${grant.threshold - service === 1 ? '' : 's'} short.`
  );
}

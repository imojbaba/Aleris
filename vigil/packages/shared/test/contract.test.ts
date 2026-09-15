import { describe, it, expect } from 'vitest';
import {
  Base64Url, WorkflowSchema, CreateVaultRequest, CreateVaultItemRequest,
  CreateRecipientRequest, GrantSchema, CreateGrantRequest, RegisterRequest,
  StoredIdentitySchema, WellbeingAnswerRequest, ClaimVerifyRequest, ClaimBundle,
} from '../src/index.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('base64url', () => {
  it('accepts unpadded URL-safe text and rejects the rest', () => {
    expect(Base64Url.safeParse('abcDEF-_123').success).toBe(true);
    for (const bad of ['abc=', 'ab+c', 'ab/c', 'ab c', '']) {
      expect(Base64Url.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('the contract carries no plaintext', () => {
  /**
   * These read like paranoia and are not. The way a product like this leaks is
   * never a broken cipher — it is a `title` field added for a nicer list view,
   * six months later, by someone who did not know. A failing test is a better
   * guard than a comment.
   */
  it('a vault has an ENCRYPTED title and no plaintext one', () => {
    const shape = Object.keys(CreateVaultRequest.shape);
    expect(shape).toContain('encryptedTitle');
    expect(shape).not.toContain('title');
    expect(shape).not.toContain('name');
  });

  it('a vault item has an ENCRYPTED label and ciphertext only', () => {
    const shape = Object.keys(CreateVaultItemRequest.shape);
    expect(shape).toContain('encryptedLabel');
    expect(shape).toContain('ciphertext');
    for (const forbidden of ['label', 'title', 'body', 'content', 'plaintext', 'text']) {
      expect(shape, forbidden).not.toContain(forbidden);
    }
  });

  it('rejects a vault request that smuggles a plaintext title alongside', () => {
    const parsed = CreateVaultRequest.parse({
      encryptedTitle: 'abc', wrappedVaultKey: 'def', title: 'For Maya',
    } as never);
    // zod strips unknown keys: the extra field cannot reach the database.
    expect(parsed).not.toHaveProperty('title');
  });

  it('never accepts a key the server could decrypt with', () => {
    const shape = Object.keys(CreateVaultRequest.shape);
    expect(shape).toContain('wrappedVaultKey');
    for (const forbidden of ['vaultKey', 'masterKey', 'passphrase', 'key']) {
      expect(shape, forbidden).not.toContain(forbidden);
    }
  });

  it('registration carries a wrapped master key and never a passphrase', () => {
    const shape = Object.keys(RegisterRequest.shape);
    expect(shape).toContain('identity');
    expect(shape).not.toContain('password');
    expect(shape).not.toContain('passphrase');
    expect(Object.keys(StoredIdentitySchema.shape)).toContain('wrappedMasterKey');
  });
});

describe('the workflow contract', () => {
  const step = (over: Record<string, unknown>) => ({ id: 'a', ...over });
  const valid = {
    checkInEveryDays: 30,
    steps: [
      step({ kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 3, everyHours: 24 }),
      { id: 'b', kind: 'REMIND_OWNER', channels: ['SMS'], times: 1, everyHours: 24 },
      { id: 'c', kind: 'FIRE' },
    ],
  };

  it('accepts a well-formed workflow', () => {
    expect(WorkflowSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts every step kind the product offers', () => {
    const all = {
      checkInEveryDays: 30,
      steps: [
        { id: 'a', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 2, everyHours: 24, message: 'Hi' },
        { id: 'b', kind: 'WAIT', hours: 24 },
        {
          id: 'c', kind: 'WELLBEING_CHECK', contactIds: [uuid(1)], channels: ['SMS'],
          waitHours: 48, requireOtp: true, script: 'Is he alright?',
        },
        { id: 'd', kind: 'REQUIRE_CONFIRMATION', from: [uuid(1)], count: 1, timeoutHours: 72, onTimeout: 'HOLD' },
        { id: 'e', kind: 'FIRE' },
      ],
    };
    expect(WorkflowSchema.safeParse(all).success).toBe(true);
  });

  it('rejects an unknown step kind rather than silently dropping it', () => {
    const sneaky = { ...valid, steps: [...valid.steps, { id: 'x', kind: 'DELETE_EVERYTHING' }] };
    expect(WorkflowSchema.safeParse(sneaky).success).toBe(false);
  });

  it('rejects a step with no channels, no repeats, or a zero gap', () => {
    for (const bad of [
      { kind: 'REMIND_OWNER', channels: [], times: 1, everyHours: 24 },
      { kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 0, everyHours: 24 },
      { kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 1, everyHours: 0 },
    ]) {
      expect(WorkflowSchema.safeParse({ ...valid, steps: [step(bad), { id: 'z', kind: 'FIRE' }] }).success)
        .toBe(false);
    }
  });

  it('rejects an unknown channel and an out-of-range interval', () => {
    expect(WorkflowSchema.safeParse({
      ...valid, steps: [step({ kind: 'REMIND_OWNER', channels: ['CARRIER_PIGEON'], times: 1, everyHours: 24 }), { id: 'z', kind: 'FIRE' }],
    }).success).toBe(false);
    expect(WorkflowSchema.safeParse({ ...valid, checkInEveryDays: 0 }).success).toBe(false);
    expect(WorkflowSchema.safeParse({ ...valid, checkInEveryDays: 5000 }).success).toBe(false);
  });

  it('caps the owner-written script, which is rendered into a stranger’s inbox', () => {
    const long = 'x'.repeat(1001);
    expect(WorkflowSchema.safeParse({
      ...valid,
      steps: [
        { id: 'c', kind: 'WELLBEING_CHECK', contactIds: [uuid(1)], channels: ['SMS'], waitHours: 1, script: long },
        { id: 'z', kind: 'FIRE' },
      ],
    }).success).toBe(false);
  });

  it('bounds workflow size, so nobody can post a million-step trigger', () => {
    const many = Array.from({ length: 41 }, (_, i) => ({ id: `s${i}`, kind: 'WAIT', hours: 1 }));
    expect(WorkflowSchema.safeParse({ ...valid, steps: many }).success).toBe(false);
  });
});

describe('recipients', () => {
  it('requires at least one way to actually reach the person', () => {
    expect(CreateRecipientRequest.safeParse({ displayName: 'Maya' }).success).toBe(false);
    expect(CreateRecipientRequest.safeParse({ displayName: 'Maya', email: 'm@example.com' }).success).toBe(true);
    expect(CreateRecipientRequest.safeParse({ displayName: 'Maya', phone: '+447700900000' }).success).toBe(true);
  });
});

describe('grants', () => {
  const sealedShare = (id: string, kind: string, index: number) => ({
    custodianId: id, kind, index, protection: 'CLAIM_CODE', sealed: 'aGVsbG8',
  });

  it('accepts a recipient-keyed grant', () => {
    expect(GrantSchema.safeParse({
      v: 1, mode: 'RECIPIENT_KEYED', grantId: 'g1', sealedVaultKey: 'aGVsbG8',
    }).success).toBe(true);
  });

  it('accepts a split-custody grant with at least two shares', () => {
    expect(GrantSchema.safeParse({
      v: 1, mode: 'SPLIT_CUSTODY', grantId: 'g1', threshold: 2, wrappedVaultKey: 'aGVsbG8',
      shares: [sealedShare('svc', 'SERVICE', 1), sealedShare('maya', 'RECIPIENT', 2)],
    }).success).toBe(true);
  });

  it('refuses a threshold of 1 at the wire boundary', () => {
    // Belt and braces with the crypto layer: a threshold of 1 would mean a
    // single custodian — possibly us — could open the vault alone.
    expect(GrantSchema.safeParse({
      v: 1, mode: 'SPLIT_CUSTODY', grantId: 'g1', threshold: 1, wrappedVaultKey: 'aGVsbG8',
      shares: [sealedShare('svc', 'SERVICE', 1), sealedShare('maya', 'RECIPIENT', 2)],
    }).success).toBe(false);
  });

  it('refuses a split grant with a single share', () => {
    expect(GrantSchema.safeParse({
      v: 1, mode: 'SPLIT_CUSTODY', grantId: 'g1', threshold: 2, wrappedVaultKey: 'aGVsbG8',
      shares: [sealedShare('svc', 'SERVICE', 1)],
    }).success).toBe(false);
  });

  it('never carries a claim code', () => {
    const shareKeys = Object.keys(
      (GrantSchema.options[1] as any).shape.shares.element.shape,
    );
    expect(shareKeys).toContain('sealed');
    expect(shareKeys).not.toContain('claimCode');
    expect(shareKeys).not.toContain('code');
    expect(Object.keys(CreateGrantRequest.shape)).not.toContain('claimCodes');
  });

  it('binds a grant to a vault, a recipient and a trigger', () => {
    expect(CreateGrantRequest.safeParse({
      vaultId: uuid(1), recipientId: uuid(2), triggerId: uuid(3),
      grant: { v: 1, mode: 'RECIPIENT_KEYED', grantId: 'g1', sealedVaultKey: 'aGVsbG8' },
    }).success).toBe(true);
  });
});

describe('the wellbeing answer', () => {
  it('takes a token and one of three verdicts', () => {
    expect(WellbeingAnswerRequest.safeParse({ token: 'x'.repeat(20), verdict: 'ALIVE' }).success).toBe(true);
    expect(WellbeingAnswerRequest.safeParse({ token: 'short', verdict: 'ALIVE' }).success).toBe(false);
    expect(WellbeingAnswerRequest.safeParse({ token: 'x'.repeat(20), verdict: 'MAYBE' }).success).toBe(false);
  });

  it('gives the person answering no way to ask about the vault', () => {
    expect(Object.keys(WellbeingAnswerRequest.shape).sort()).toEqual(['note', 'token', 'verdict']);
  });
});

describe('the redeem flow contract', () => {
  it('carries the recipient’s ephemeral public key, never a private one', () => {
    const shape = Object.keys(ClaimVerifyRequest.shape);
    expect(shape).toContain('claimPublicKey');
    for (const forbidden of ['privateKey', 'claimPrivateKey', 'answer', 'vaultKey']) {
      expect(shape, forbidden).not.toContain(forbidden);
    }
  });

  /**
   * The answer to the owner's question must never be transmitted. It is key
   * material derived on the recipient's device — if it appeared in a request
   * body, the server could derive the same key and the guarantee would be gone.
   */
  it('has nowhere to put the answer to the owner’s question', () => {
    const bundle = Object.keys(ClaimBundle.shape);
    expect(bundle).toContain('question');
    expect(bundle).toContain('proofSalt');
    for (const forbidden of ['answer', 'answerHash', 'expectedAnswer']) {
      expect(bundle, forbidden).not.toContain(forbidden);
      expect(Object.keys(ClaimVerifyRequest.shape), forbidden).not.toContain(forbidden);
    }
  });

  it('returns shares as sealed blobs, and says who has not released yet', () => {
    const parsed = ClaimBundle.safeParse({
      deliveryId: uuid(1), ownerName: 'Jo',
      grant: { v: 1, mode: 'RECIPIENT_KEYED', grantId: 'g1', sealedVaultKey: 'aGVsbG8' },
      relayedShares: [{ custodianId: 'service', sealed: 'aGVsbG8' }],
      awaiting: [{ custodianId: 'ray', displayName: 'Ray' }],
    });
    expect(parsed.success).toBe(true);
  });
});

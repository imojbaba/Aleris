import { describe, it, expect } from 'vitest';
import {
  Base64Url, TriggerConfigSchema, CreateVaultRequest, CreateVaultItemRequest,
  CreateRecipientRequest, GrantSchema, CreateGrantRequest, RegisterRequest,
  StoredIdentitySchema, AttestationRequest,
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

describe('trigger config', () => {
  const valid = {
    checkInIntervalDays: 30,
    graceDays: 14,
    escalation: [{ afterDays: 0, channels: ['PUSH', 'EMAIL'] }],
    verification: { verifierIds: [], requiredAttestations: 0, policy: 'SILENCE_CONFIRMS', holdDays: 7 },
  };

  it('accepts a well-formed config', () => {
    expect(TriggerConfigSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an empty escalation ladder at the wire boundary', () => {
    expect(TriggerConfigSchema.safeParse({ ...valid, escalation: [] }).success).toBe(false);
  });

  it('rejects a step with no channels', () => {
    expect(TriggerConfigSchema.safeParse({
      ...valid, escalation: [{ afterDays: 0, channels: [] }],
    }).success).toBe(false);
  });

  it('rejects a non-positive or absurd check-in interval', () => {
    expect(TriggerConfigSchema.safeParse({ ...valid, checkInIntervalDays: 0 }).success).toBe(false);
    expect(TriggerConfigSchema.safeParse({ ...valid, checkInIntervalDays: -5 }).success).toBe(false);
    expect(TriggerConfigSchema.safeParse({ ...valid, checkInIntervalDays: 5000 }).success).toBe(false);
  });

  it('rejects an unknown channel', () => {
    expect(TriggerConfigSchema.safeParse({
      ...valid, escalation: [{ afterDays: 0, channels: ['CARRIER_PIGEON'] }],
    }).success).toBe(false);
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

describe('attestation', () => {
  it('takes a token and one of three verdicts', () => {
    expect(AttestationRequest.safeParse({ token: 'x'.repeat(20), verdict: 'ALIVE' }).success).toBe(true);
    expect(AttestationRequest.safeParse({ token: 'short', verdict: 'ALIVE' }).success).toBe(false);
    expect(AttestationRequest.safeParse({ token: 'x'.repeat(20), verdict: 'MAYBE' }).success).toBe(false);
  });

  it('does not let a verifier send anything about the vault', () => {
    const shape = Object.keys(AttestationRequest.shape);
    expect(shape.sort()).toEqual(['note', 'token', 'verdict']);
  });
});

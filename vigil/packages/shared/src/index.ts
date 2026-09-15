import { z } from 'zod';

/**
 * The wire contract between the app and the server.
 *
 * One rule governs every schema in this file, and it is worth stating plainly
 * because it is easy to erode one convenient field at a time:
 *
 *   THE SERVER NEVER RECEIVES PLAINTEXT VAULT CONTENT, AND NEVER RECEIVES A KEY
 *   THAT COULD DECRYPT IT.
 *
 * Every payload below carries ciphertext, wrapped keys, or metadata the user has
 * knowingly accepted is visible (a recipient's email address, a vault's title).
 * If a future endpoint needs a plaintext body to do something clever —
 * server-side search, previews, virus scanning, an AI summary of someone's last
 * letter — that is not a schema change. That is a different product, and it
 * should be argued on its merits rather than arrive as a field.
 */

export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');
export const Uuid = z.string().uuid();
export const Iso = z.string().datetime();

/* ------------------------------- identity -------------------------------- */

export const Argon2ParamsSchema = z.object({
  m: z.number().int().positive(),
  t: z.number().int().positive(),
  p: z.number().int().positive(),
});

/**
 * The encrypted key blob, stored server-side so a user can restore on a new
 * phone. Useless without the passphrase, which we never see and cannot reset.
 */
export const StoredIdentitySchema = z.object({
  v: z.literal(1),
  kdf: z.literal('argon2id'),
  kdfSalt: Base64Url,
  kdfParams: Argon2ParamsSchema,
  wrappedMasterKey: Base64Url,
});

export const RegisterRequest = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  identity: StoredIdentitySchema,
  /** The user's X25519 public key, so others can seal things to them. */
  publicKey: Base64Url,
});

export const LoginRequest = z.object({ email: z.string().email() });
export const VerifyOtpRequest = z.object({ email: z.string().email(), code: z.string().min(6).max(8) });

/* -------------------------------- channels ------------------------------- */

export const ChannelSchema = z.enum(['PUSH', 'EMAIL', 'SMS', 'WHATSAPP', 'VOICE']);

/* -------------------------------- triggers ------------------------------- */

export const EscalationStepSchema = z.object({
  afterDays: z.number().min(0).max(365),
  channels: z.array(ChannelSchema).min(1),
});

export const VerificationConfigSchema = z.object({
  verifierIds: z.array(Uuid),
  requiredAttestations: z.number().int().min(0),
  policy: z.enum(['REQUIRE_ATTESTATION', 'SILENCE_CONFIRMS']),
  holdDays: z.number().min(0).max(365),
});

export const TriggerConfigSchema = z.object({
  checkInIntervalDays: z.number().positive().max(1095),
  graceDays: z.number().min(0).max(365),
  escalation: z.array(EscalationStepSchema).min(1),
  verification: VerificationConfigSchema,
  acknowledgedRapidRelease: z.boolean().optional(),
});

export const CreateTriggerRequest = z.object({
  name: z.string().min(1).max(120),
  config: TriggerConfigSchema,
});

export const TriggerStatusSchema = z.enum([
  'DRAFT', 'ACTIVE', 'GRACE', 'ESCALATING', 'VERIFICATION_HOLD', 'RELEASING', 'RELEASED', 'PAUSED', 'CANCELLED',
]);

export const TriggerSummary = z.object({
  id: Uuid,
  name: z.string(),
  status: TriggerStatusSchema,
  config: TriggerConfigSchema,
  lastCheckInAt: Iso,
  nextCheckInDueAt: Iso,
  earliestReleaseAt: Iso,
  vaultCount: z.number().int().min(0),
});

/* --------------------------------- vaults -------------------------------- */

export const VaultItemKind = z.enum([
  'LETTER', 'DOCUMENT', 'PHOTO', 'VIDEO', 'AUDIO', 'CREDENTIAL', 'LINK', 'PLAYLIST', 'INSTRUCTION',
]);

export const CreateVaultRequest = z.object({
  /**
   * Titles are stored encrypted too. It is tempting to keep them in the clear
   * for a nicer list view — and then the database says "For Maya, if I don't
   * make it through surgery", which is most of the secret.
   */
  encryptedTitle: Base64Url,
  wrappedVaultKey: Base64Url,
  /** Non-sensitive hint for list rendering before unlock: a colour and an icon. */
  cosmetic: z.object({ accent: z.string().max(16), glyph: z.string().max(16) }).optional(),
});

export const CreateVaultItemRequest = z.object({
  kind: VaultItemKind,
  /** Ciphertext of the item body, or of the file manifest for blob-backed items. */
  ciphertext: Base64Url,
  /** Encrypted display name. */
  encryptedLabel: Base64Url,
  /** Plaintext byte size, for quota and progress UI only. */
  sizeBytes: z.number().int().min(0).optional(),
});

/* ------------------------------- recipients ------------------------------ */

export const CreateRecipientRequest = z.object({
  displayName: z.string().min(1).max(120),
  email: z.string().email().optional(),
  phone: z.string().min(5).max(32).optional(),
  relationship: z.string().max(60).optional(),
}).refine((r) => r.email || r.phone, { message: 'a recipient needs an email address or a phone number' });

export const CustodianKindSchema = z.enum(['SERVICE', 'RECIPIENT', 'VERIFIER', 'OWNER_RECOVERY']);

export const SealedShareSchema = z.object({
  custodianId: z.string(),
  kind: CustodianKindSchema,
  index: z.number().int().min(1).max(255),
  protection: z.enum(['PUBLIC_KEY', 'CLAIM_CODE']),
  sealed: Base64Url,
});

export const GrantSchema = z.discriminatedUnion('mode', [
  z.object({
    v: z.literal(1),
    mode: z.literal('RECIPIENT_KEYED'),
    grantId: z.string(),
    sealedVaultKey: Base64Url,
  }),
  z.object({
    v: z.literal(1),
    mode: z.literal('SPLIT_CUSTODY'),
    grantId: z.string(),
    threshold: z.number().int().min(2),
    wrappedVaultKey: Base64Url,
    shares: z.array(SealedShareSchema).min(2),
  }),
]);

/**
 * Attach a vault to a recipient. The grant is built ON THE DEVICE and uploaded
 * already sealed; the server's job is storage and timing, not key handling.
 */
export const CreateGrantRequest = z.object({
  vaultId: Uuid,
  recipientId: Uuid,
  triggerId: Uuid,
  grant: GrantSchema,
  /** Optional note shown to the recipient in the delivery message, encrypted. */
  encryptedNote: Base64Url.optional(),
});

/* ------------------------------ check-in etc ----------------------------- */

export const CheckInRequest = z.object({
  triggerId: Uuid,
  /** Where the check-in came from, for the audit log the owner can read. */
  source: z.enum(['APP', 'EMAIL_LINK', 'SMS_REPLY', 'PASSIVE']).default('APP'),
});

export const PauseTriggerRequest = z.object({
  triggerId: Uuid,
  untilIso: Iso.nullable(),
  reason: z.string().max(280).optional(),
});

export const AttestationRequest = z.object({
  token: z.string().min(16),
  verdict: z.enum(['ALIVE', 'DECEASED', 'UNSURE']),
  note: z.string().max(500).optional(),
});

export const ClaimRequest = z.object({
  deliveryId: Uuid,
  claimCode: z.string().min(16).max(64),
});

export type StoredIdentity = z.infer<typeof StoredIdentitySchema>;
export type TriggerConfigDto = z.infer<typeof TriggerConfigSchema>;
export type GrantDto = z.infer<typeof GrantSchema>;
export type TriggerSummaryDto = z.infer<typeof TriggerSummary>;
export type Channel = z.infer<typeof ChannelSchema>;

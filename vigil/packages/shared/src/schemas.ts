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

/**
 * The trigger is a workflow the user wrote, not a config object with our
 * opinions baked in. The server validates it with the same @vigil/core rules
 * the app uses — not from distrust of our own client, but because a workflow
 * that could hurt someone should be impossible to STORE, whatever software
 * claims to be talking to us.
 */

const StepBase = { id: z.string().min(1).max(64), label: z.string().max(120).optional() };

export const RemindOwnerStepSchema = z.object({
  ...StepBase,
  kind: z.literal('REMIND_OWNER'),
  channels: z.array(ChannelSchema).min(1),
  times: z.number().int().min(1).max(50),
  everyHours: z.number().positive().max(24 * 90),
  message: z.string().max(1000).optional(),
});

export const WaitStepSchema = z.object({
  ...StepBase,
  kind: z.literal('WAIT'),
  hours: z.number().min(0).max(24 * 365),
});

export const WellbeingCheckStepSchema = z.object({
  ...StepBase,
  kind: z.literal('WELLBEING_CHECK'),
  contactIds: z.array(Uuid),
  channels: z.array(ChannelSchema).min(1),
  /**
   * The owner's own wording for the message sent on their behalf. Capped and
   * treated as untrusted text: it is rendered into an email to a third party,
   * so it is escaped at the template boundary and never interpolated raw.
   */
  script: z.string().max(1000).optional(),
  waitHours: z.number().min(0).max(24 * 365),
  requireOtp: z.boolean().optional(),
});

export const RequireConfirmationStepSchema = z.object({
  ...StepBase,
  kind: z.literal('REQUIRE_CONFIRMATION'),
  from: z.array(Uuid),
  count: z.number().int().min(0).max(50),
  timeoutHours: z.number().min(0).max(24 * 365),
  onTimeout: z.enum(['HOLD', 'PROCEED']),
});

export const FireStepSchema = z.object({ ...StepBase, kind: z.literal('FIRE') });

export const WorkflowStepSchema = z.discriminatedUnion('kind', [
  RemindOwnerStepSchema,
  WaitStepSchema,
  WellbeingCheckStepSchema,
  RequireConfirmationStepSchema,
  FireStepSchema,
]);

export const WorkflowSchema = z.object({
  checkInEveryDays: z.number().positive().max(1095),
  steps: z.array(WorkflowStepSchema).min(2).max(40),
  acknowledgedRapidRelease: z.boolean().optional(),
});

export const CreateTriggerRequest = z.object({
  name: z.string().min(1).max(120),
  workflow: WorkflowSchema,
});

export const TriggerStatusSchema = z.enum([
  'DRAFT', 'ACTIVE', 'REMINDING', 'WELLBEING_CHECK',
  'AWAITING_CONFIRMATION', 'DELIVERING', 'DELIVERED', 'PAUSED', 'CANCELLED',
]);

export const TriggerSummary = z.object({
  id: Uuid,
  name: z.string(),
  status: TriggerStatusSchema,
  workflow: WorkflowSchema,
  lastCheckInAt: Iso,
  nextCheckInDueAt: Iso,
  earliestDeliveryAt: Iso,
  currentStepId: z.string().nullable(),
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
  protection: z.enum(['PUBLIC_KEY', 'CLAIM_CODE', 'RELATIONSHIP_PROOF']),
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
  source: z.enum(['APP', 'EMAIL_LINK', 'SMS_REPLY', 'VOICE_CALL', 'PASSIVE']).default('APP'),
});

export const PauseTriggerRequest = z.object({
  triggerId: Uuid,
  untilIso: Iso.nullable(),
  reason: z.string().max(280).optional(),
});

/**
 * A wellbeing check answer. The person answering is a member of the public
 * holding a one-time link: the token IS the credential, it is single-use, and
 * only its hash is stored. They are never shown, and can never ask for,
 * anything about the vault.
 */
export const WellbeingAnswerRequest = z.object({
  token: z.string().min(16).max(128),
  verdict: z.enum(['ALIVE', 'DECEASED', 'UNSURE']),
  note: z.string().max(500).optional(),
});

/* -------------------------------- redeeming ------------------------------ */

/** Step 1: the recipient asks for a code at the address the owner recorded. */
export const ClaimStartRequest = z.object({
  deliveryId: Uuid,
  /** The opaque token from their delivery link. */
  token: z.string().min(16).max(128),
});

/**
 * Step 2: they prove control of that address, and hand us the public half of a
 * keypair their browser just generated.
 *
 * The OTP gates the flow and rate-limits guessing. It is deliberately NOT what
 * protects the vault — the custody shares are sealed to `claimPublicKey`, whose
 * private half never leaves the recipient's device, so a server that skipped
 * this check entirely would still learn nothing.
 */
export const ClaimVerifyRequest = z.object({
  deliveryId: Uuid,
  token: z.string().min(16).max(128),
  otp: z.string().min(6).max(8),
  claimPublicKey: Base64Url,
});

/**
 * What comes back: the sealed grant, the owner's question, and every custody
 * share that has been released to this session — each one a blob sealed to
 * `claimPublicKey`. The answer to the question is never sent to us in any form.
 */
export const ClaimBundle = z.object({
  deliveryId: Uuid,
  ownerName: z.string(),
  grant: GrantSchema,
  question: z.string().max(200).optional(),
  proofSalt: Base64Url.optional(),
  relayedShares: z.array(z.object({ custodianId: z.string(), sealed: Base64Url })),
  /** Custodians who have not yet released, so the page can say who is missing. */
  awaiting: z.array(z.object({ custodianId: z.string(), displayName: z.string() })),
  encryptedNote: Base64Url.optional(),
});

export type StoredIdentity = z.infer<typeof StoredIdentitySchema>;
export type WorkflowDto = z.infer<typeof WorkflowSchema>;
export type ClaimBundleDto = z.infer<typeof ClaimBundle>;
export type GrantDto = z.infer<typeof GrantSchema>;
export type TriggerSummaryDto = z.infer<typeof TriggerSummary>;
export type Channel = z.infer<typeof ChannelSchema>;

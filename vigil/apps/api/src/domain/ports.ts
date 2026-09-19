import type { Channel, Workflow, TriggerState } from '@vigil/core';

/**
 * Ports. The release engine talks only to these, never to Prisma or a provider
 * SDK, which is what lets the engine's behaviour be tested exhaustively in
 * memory. Given what this engine does when it is wrong, "we ran it against a
 * staging database once" is not an acceptable standard of evidence.
 */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface TriggerRecord {
  id: string;
  userId: string;
  name: string;
  /** The workflow the user wrote. The engine never second-guesses it — it only
   *  refuses to go faster than the floor and never delivers in silence. */
  workflow: Workflow;
  state: TriggerState;
}

export interface GrantRecord {
  id: string;
  triggerId: string;
  vaultId: string;
  recipientId: string;
  mode: 'RECIPIENT_KEYED' | 'SPLIT_CUSTODY';
}

export interface RecipientRecord {
  id: string;
  userId: string;
  displayName: string;
  email?: string;
  phone?: string;
  isVerifier: boolean;
  publicKey?: string;
}

export interface DeliveryRecord {
  id: string;
  triggerId: string;
  grantId: string;
  recipientId: string;
  status: 'PENDING' | 'DISPATCHED' | 'CLAIMED' | 'FAILED';
  claimTokenHash: string;
  dispatchedAt?: number;
}

export interface TriggerRepository {
  /** Triggers whose next evaluation is due, oldest first. */
  dueTriggers(now: number, limit: number): Promise<TriggerRecord[]>;
  saveState(triggerId: string, state: TriggerState, nextEvaluationAt: number | null): Promise<void>;
  grantsFor(triggerId: string): Promise<GrantRecord[]>;
  recipient(recipientId: string): Promise<RecipientRecord | null>;
  owner(userId: string): Promise<{ id: string; email: string; displayName: string } | null>;
  /** Existing deliveries, so a retry never sends someone's legacy twice. */
  deliveriesFor(triggerId: string): Promise<DeliveryRecord[]>;
  createDelivery(d: Omit<DeliveryRecord, 'status'> & { status?: DeliveryRecord['status'] }): Promise<DeliveryRecord>;
  markDeliveryDispatched(deliveryId: string, at: number): Promise<void>;
  recordAnswerToken(triggerId: string, contactId: string, tokenHash: string): Promise<void>;
  recordAttempt(triggerId: string, stepId: string, occurrence: number, channel: Channel, at: number): Promise<void>;
  appendAudit(userId: string, kind: string, summary: string, detail?: unknown): Promise<void>;
}

export interface OutboundMessage {
  channel: Channel;
  to: { email?: string; phone?: string; userId?: string };
  template:
    | 'REMIND_OWNER'
    | 'WELLBEING_CHECK'
    | 'CONFIRMATION_REQUEST'
    | 'DELIVERY';
  variables: Record<string, string>;
}

export interface SendResult {
  ok: boolean;
  detail?: string;
  /**
   * True when retrying is pointless — a dead mailbox, a blocked number, a
   * rejected template.
   *
   * The state machine needs this. A hard bounce is evidence the owner is
   * UNREACHABLE, which is not evidence they are GONE, and the two must not be
   * collapsed: a silently swallowed bounce is a path to someone's letters
   * going out while they are alive and well.
   */
  permanent?: boolean;
}

export interface Notifier {
  send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * A single lock around a trigger's evaluation. Two workers processing the same
 * trigger concurrently could each decide to release and each dispatch, and
 * there is no unsending. Delivery creation is separately idempotent, but
 * defence in depth is cheap here and the failure is not.
 */
export interface Locks {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
}

export interface Tokens {
  /** A high-entropy token to embed in a link, plus its hash for storage. */
  mint(): { token: string; hash: string };
  hash(token: string): string;
}

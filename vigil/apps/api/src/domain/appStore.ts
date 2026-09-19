import type { TriggerState, Workflow } from '@vigil/core';
import type { StoredIdentity } from '@vigil/shared';

/**
 * Everything the HTTP routes need to store.
 *
 * Separate from `TriggerRepository`, which is the worker's view. The worker
 * needs to sweep due triggers fast; the routes need per-user CRUD. Forcing both
 * through one interface would give the worker methods it must never call and
 * the routes a `dueTriggers` it has no business with.
 */

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  identity: StoredIdentity;
  publicKey: string;
}

export interface VaultRecord {
  id: string;
  userId: string;
  encryptedTitle: string;
  wrappedVaultKey: string;
  accent?: string;
  glyph?: string;
}

export interface VaultItemRecord {
  id: string;
  vaultId: string;
  kind: string;
  encryptedLabel: string;
  ciphertext: string;
  sizeBytes: number;
}

export interface StoredTrigger {
  id: string;
  userId: string;
  name: string;
  workflow: Workflow;
  state: TriggerState;
  nextEvaluationAt: number | null;
}

export interface AppStore {
  createUser(u: Omit<UserRecord, 'id'> & { id?: string }): Promise<UserRecord>;
  userByEmail(email: string): Promise<UserRecord | null>;
  userById(id: string): Promise<UserRecord | null>;

  createTrigger(t: Omit<StoredTrigger, 'id'> & { id?: string }): Promise<StoredTrigger>;
  triggersFor(userId: string): Promise<StoredTrigger[]>;
  trigger(id: string): Promise<StoredTrigger | null>;
  updateTriggerState(id: string, state: TriggerState, nextEvaluationAt: number | null): Promise<void>;

  createVault(v: Omit<VaultRecord, 'id'> & { id?: string }): Promise<VaultRecord>;
  vault(id: string): Promise<VaultRecord | null>;
  createVaultItem(i: Omit<VaultItemRecord, 'id'> & { id?: string }): Promise<VaultItemRecord>;

  createRecipient(r: {
    userId: string; displayName: string; email?: string; phone?: string;
    relationship?: string; isVerifier?: boolean;
  }): Promise<{ id: string }>;
  recipientsFor(userId: string): Promise<{ id: string; displayName: string; isVerifier: boolean }[]>;

  createGrant(g: {
    vaultId: string; recipientId: string; triggerId: string;
    mode: 'RECIPIENT_KEYED' | 'SPLIT_CUSTODY'; payload: unknown; encryptedNote?: string;
  }): Promise<{ id: string }>;

  appendAudit(userId: string, kind: string, summary: string, detail?: unknown): Promise<void>;
  auditFor(userId: string): Promise<{ at: string; kind: string; summary: string }[]>;

  /** Answer a wellbeing check. Returns the trigger it belonged to, if the token is real. */
  useAnswerToken(tokenHash: string): Promise<{ triggerId: string; contactId: string } | null>;
  recordAttestation(a: {
    triggerId: string; contactId: string;
    verdict: 'ALIVE' | 'DECEASED' | 'UNSURE'; at: number; otpVerified: boolean;
  }): Promise<void>;
  /** Bring a trigger's next evaluation forward — an ALIVE answer should not wait for the next tick. */
  wakeTrigger(triggerId: string, at: number): Promise<void>;
}

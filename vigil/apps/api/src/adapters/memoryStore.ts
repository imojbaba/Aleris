import { randomUUID } from 'node:crypto';
import type { TriggerState } from '@vigil/core';
import type {
  AppStore, StoredTrigger, UserRecord, VaultItemRecord, VaultRecord,
} from '../domain/appStore.js';

/**
 * The routes' storage, in memory.
 *
 * Used by the test suite and by `pnpm api:dev` with no DATABASE_URL, so the
 * whole service runs on a laptop with nothing installed. `PrismaStore` mirrors
 * it method for method; `test/apiContract.test.ts` runs the same expectations
 * against both, which is what keeps them honest about each other.
 */
export class MemoryStore implements AppStore {
  users = new Map<string, UserRecord>();
  triggers = new Map<string, StoredTrigger>();
  vaults = new Map<string, VaultRecord>();
  items: VaultItemRecord[] = [];
  recipients: { id: string; userId: string; displayName: string; isVerifier: boolean }[] = [];
  grants: { id: string; vaultId: string; recipientId: string; triggerId: string }[] = [];
  audit: { userId: string; at: string; kind: string; summary: string; detail?: unknown }[] = [];
  answerTokens: { tokenHash: string; triggerId: string; contactId: string; usedAt?: number }[] = [];
  attestations: { triggerId: string; contactId: string; verdict: string; at: number }[] = [];

  /**
   * Real UUIDs, like Postgres produces.
   *
   * An earlier version minted readable ids such as `rcpt-a1b2c3`, which the
   * wire schemas then rejected — `contactIds` is `z.array(Uuid)`. The memory
   * store existing to stand in for the real one means matching it where it is
   * observable, not only where it is convenient.
   */
  private id = (_prefix: string) => randomUUID();

  async createUser(u: Omit<UserRecord, 'id'> & { id?: string }) {
    const record: UserRecord = { ...u, id: u.id ?? this.id('user') };
    this.users.set(record.id, record);
    return record;
  }

  async userByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }

  async userById(id: string) {
    return this.users.get(id) ?? null;
  }

  async createTrigger(t: Omit<StoredTrigger, 'id'> & { id?: string }) {
    const record: StoredTrigger = { ...t, id: t.id ?? this.id('trigger') };
    this.triggers.set(record.id, record);
    return record;
  }

  async triggersFor(userId: string) {
    return [...this.triggers.values()].filter((t) => t.userId === userId);
  }

  async trigger(id: string) {
    return this.triggers.get(id) ?? null;
  }

  async updateTriggerState(id: string, state: TriggerState, nextEvaluationAt: number | null) {
    const t = this.triggers.get(id);
    if (!t) return;
    t.state = state;
    t.nextEvaluationAt = nextEvaluationAt;
  }

  async createVault(v: Omit<VaultRecord, 'id'> & { id?: string }) {
    const record: VaultRecord = { ...v, id: v.id ?? this.id('vault') };
    this.vaults.set(record.id, record);
    return record;
  }

  async vault(id: string) {
    return this.vaults.get(id) ?? null;
  }

  async createVaultItem(i: Omit<VaultItemRecord, 'id'> & { id?: string }) {
    const record: VaultItemRecord = { ...i, id: i.id ?? this.id('item') };
    this.items.push(record);
    return record;
  }

  async createRecipient(r: { userId: string; displayName: string; isVerifier?: boolean }) {
    const record = {
      id: this.id('rcpt'), userId: r.userId,
      displayName: r.displayName, isVerifier: r.isVerifier ?? false,
    };
    this.recipients.push(record);
    return { id: record.id };
  }

  async recipientsFor(userId: string) {
    return this.recipients
      .filter((r) => r.userId === userId)
      .map(({ id, displayName, isVerifier }) => ({ id, displayName, isVerifier }));
  }

  async createGrant(g: { vaultId: string; recipientId: string; triggerId: string }) {
    const record = { id: this.id('grant'), ...g };
    this.grants.push(record);
    return { id: record.id };
  }

  async appendAudit(userId: string, kind: string, summary: string, detail?: unknown) {
    this.audit.push({ userId, at: new Date().toISOString(), kind, summary, detail });
  }

  async auditFor(userId: string) {
    return this.audit
      .filter((a) => a.userId === userId)
      .map(({ at, kind, summary }) => ({ at, kind, summary }))
      .reverse();
  }

  async useAnswerToken(tokenHash: string) {
    const row = this.answerTokens.find((t) => t.tokenHash === tokenHash && !t.usedAt);
    if (!row) return null; // Single use: a second click finds nothing.
    row.usedAt = Date.now();
    return { triggerId: row.triggerId, contactId: row.contactId };
  }

  async recordAttestation(a: {
    triggerId: string; contactId: string; verdict: string; at: number;
  }) {
    this.attestations.push(a);
    const t = this.triggers.get(a.triggerId);
    if (t) {
      t.state = {
        ...t.state,
        attestations: [
          ...t.state.attestations,
          { contactId: a.contactId, verdict: a.verdict as never, at: a.at, otpVerified: true },
        ],
      };
    }
  }

  async wakeTrigger(triggerId: string, at: number) {
    const t = this.triggers.get(triggerId);
    if (t) t.nextEvaluationAt = at;
  }
}

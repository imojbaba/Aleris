import { PrismaClient, type Prisma } from '@prisma/client';
import type { TriggerState, TriggerStatus, Workflow } from '@vigil/core';
import type {
  AppStore, StoredTrigger, UserRecord, VaultItemRecord, VaultRecord,
} from '../domain/appStore.js';
import type { StoredIdentity } from '@vigil/shared';

/** The routes' storage, on Postgres. Mirrors MemoryStore exactly. */
export class PrismaStore implements AppStore {
  constructor(private readonly db: PrismaClient) {}

  private toUser(u: {
    id: string; email: string; displayName: string; kdfSalt: string;
    kdfParamsM: number; kdfParamsT: number; kdfParamsP: number;
    wrappedMasterKey: string; publicKey: string;
  }): UserRecord {
    return {
      id: u.id, email: u.email, displayName: u.displayName, publicKey: u.publicKey,
      identity: {
        v: 1, kdf: 'argon2id', kdfSalt: u.kdfSalt,
        kdfParams: { m: u.kdfParamsM, t: u.kdfParamsT, p: u.kdfParamsP },
        wrappedMasterKey: u.wrappedMasterKey,
      } as StoredIdentity,
    };
  }

  async createUser(u: Omit<UserRecord, 'id'> & { id?: string }) {
    const row = await this.db.user.create({
      data: {
        ...(u.id ? { id: u.id } : {}),
        email: u.email, displayName: u.displayName, publicKey: u.publicKey,
        kdfSalt: u.identity.kdfSalt,
        kdfParamsM: u.identity.kdfParams.m,
        kdfParamsT: u.identity.kdfParams.t,
        kdfParamsP: u.identity.kdfParams.p,
        wrappedMasterKey: u.identity.wrappedMasterKey,
      },
    });
    return this.toUser(row);
  }

  async userByEmail(email: string) {
    const u = await this.db.user.findUnique({ where: { email } });
    return u ? this.toUser(u) : null;
  }

  async userById(id: string) {
    const u = await this.db.user.findUnique({ where: { id } });
    return u ? this.toUser(u) : null;
  }

  private toTrigger(t: {
    id: string; userId: string; name: string; workflow: Prisma.JsonValue; status: TriggerStatus;
    lastCheckInAt: Date; statusSince: Date; pausedUntil: Date | null; nextEvaluationAt: Date | null;
  }): StoredTrigger {
    const state: TriggerState = {
      status: t.status,
      lastCheckInAt: t.lastCheckInAt.getTime(),
      statusSince: t.statusSince.getTime(),
      pausedUntil: t.pausedUntil ? t.pausedUntil.getTime() : null,
      performed: [],
      attestations: [],
    };
    return {
      id: t.id, userId: t.userId, name: t.name,
      workflow: t.workflow as unknown as Workflow,
      state,
      nextEvaluationAt: t.nextEvaluationAt ? t.nextEvaluationAt.getTime() : null,
    };
  }

  async createTrigger(t: Omit<StoredTrigger, 'id'> & { id?: string }) {
    const row = await this.db.trigger.create({
      data: {
        ...(t.id ? { id: t.id } : {}),
        userId: t.userId, name: t.name, workflow: t.workflow as never,
        status: t.state.status,
        lastCheckInAt: new Date(t.state.lastCheckInAt),
        statusSince: new Date(t.state.statusSince),
        nextEvaluationAt: t.nextEvaluationAt == null ? null : new Date(t.nextEvaluationAt),
      },
    });
    return this.toTrigger(row);
  }

  async triggersFor(userId: string) {
    const rows = await this.db.trigger.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.toTrigger(r));
  }

  async trigger(id: string) {
    const r = await this.db.trigger.findUnique({ where: { id } });
    return r ? this.toTrigger(r) : null;
  }

  async updateTriggerState(id: string, state: TriggerState, nextEvaluationAt: number | null) {
    await this.db.$transaction(async (tx) => {
      await tx.trigger.update({
        where: { id },
        data: {
          status: state.status,
          lastCheckInAt: new Date(state.lastCheckInAt),
          statusSince: new Date(state.statusSince),
          pausedUntil: state.pausedUntil == null ? null : new Date(state.pausedUntil),
          nextEvaluationAt: nextEvaluationAt == null ? null : new Date(nextEvaluationAt),
        },
      });
      // Same rule as the worker's repo: a moved check-in restarts the ladder,
      // so the record of what was already sent goes with it.
      await tx.attempt.deleteMany({ where: { triggerId: id, at: { lt: new Date(state.lastCheckInAt) } } });
    });
  }

  async createVault(v: Omit<VaultRecord, 'id'> & { id?: string }) {
    const row = await this.db.vault.create({
      data: {
        ...(v.id ? { id: v.id } : {}),
        userId: v.userId, encryptedTitle: v.encryptedTitle, wrappedVaultKey: v.wrappedVaultKey,
        accent: v.accent ?? null, glyph: v.glyph ?? null,
      },
    });
    return {
      id: row.id, userId: row.userId, encryptedTitle: row.encryptedTitle,
      wrappedVaultKey: row.wrappedVaultKey,
      ...(row.accent ? { accent: row.accent } : {}),
      ...(row.glyph ? { glyph: row.glyph } : {}),
    };
  }

  async vault(id: string) {
    const v = await this.db.vault.findUnique({ where: { id } });
    return v
      ? {
          id: v.id, userId: v.userId, encryptedTitle: v.encryptedTitle,
          wrappedVaultKey: v.wrappedVaultKey,
          ...(v.accent ? { accent: v.accent } : {}),
          ...(v.glyph ? { glyph: v.glyph } : {}),
        }
      : null;
  }

  async createVaultItem(i: Omit<VaultItemRecord, 'id'> & { id?: string }) {
    const row = await this.db.vaultItem.create({
      data: {
        ...(i.id ? { id: i.id } : {}),
        vaultId: i.vaultId, kind: i.kind as never,
        encryptedLabel: i.encryptedLabel, ciphertext: i.ciphertext, sizeBytes: i.sizeBytes,
      },
    });
    return {
      id: row.id, vaultId: row.vaultId, kind: row.kind,
      encryptedLabel: row.encryptedLabel, ciphertext: row.ciphertext, sizeBytes: row.sizeBytes,
    };
  }

  async createRecipient(r: {
    userId: string; displayName: string; email?: string; phone?: string;
    relationship?: string; isVerifier?: boolean;
  }) {
    const row = await this.db.recipient.create({
      data: {
        userId: r.userId, displayName: r.displayName,
        email: r.email ?? null, phone: r.phone ?? null,
        relationship: r.relationship ?? null, isVerifier: r.isVerifier ?? false,
      },
    });
    return { id: row.id };
  }

  async recipientsFor(userId: string) {
    const rows = await this.db.recipient.findMany({ where: { userId } });
    return rows.map((r) => ({ id: r.id, displayName: r.displayName, isVerifier: r.isVerifier }));
  }

  async createGrant(g: {
    vaultId: string; recipientId: string; triggerId: string;
    mode: 'RECIPIENT_KEYED' | 'SPLIT_CUSTODY'; payload: unknown; encryptedNote?: string;
  }) {
    const row = await this.db.grant.create({
      data: {
        vaultId: g.vaultId, recipientId: g.recipientId, triggerId: g.triggerId,
        mode: g.mode, grantPayload: g.payload as never,
        encryptedNote: g.encryptedNote ?? null,
      },
    });
    return { id: row.id };
  }

  async appendAudit(userId: string, kind: string, summary: string, detail?: unknown) {
    await this.db.auditEvent.create({
      data: { userId, kind, summary, detail: (detail ?? undefined) as Prisma.InputJsonValue },
    });
  }

  async auditFor(userId: string) {
    const rows = await this.db.auditEvent.findMany({
      where: { userId }, orderBy: { at: 'desc' }, take: 200,
    });
    return rows.map((a) => ({ at: a.at.toISOString(), kind: a.kind, summary: a.summary }));
  }

  /**
   * Single-use by construction: the row is claimed with a conditional update,
   * so two people clicking the same link race in the database rather than both
   * being believed.
   */
  async useAnswerToken(tokenHash: string) {
    const claimed = await this.db.answerToken.updateMany({
      where: { tokenHash, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) return null;
    const row = await this.db.answerToken.findUnique({ where: { tokenHash } });
    return row ? { triggerId: row.triggerId, contactId: row.contactId } : null;
  }

  async recordAttestation(a: {
    triggerId: string; contactId: string;
    verdict: 'ALIVE' | 'DECEASED' | 'UNSURE'; at: number; otpVerified: boolean;
  }) {
    await this.db.attestation.create({
      data: {
        triggerId: a.triggerId, contactId: a.contactId, verdict: a.verdict,
        at: new Date(a.at), otpVerified: a.otpVerified,
      },
    });
  }

  async wakeTrigger(triggerId: string, at: number) {
    await this.db.trigger.update({
      where: { id: triggerId },
      data: { nextEvaluationAt: new Date(at) },
    });
  }
}

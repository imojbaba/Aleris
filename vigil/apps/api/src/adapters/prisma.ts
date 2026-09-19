import { PrismaClient, type Prisma } from '@prisma/client';
import type { TriggerState, TriggerStatus, Workflow, Channel } from '@vigil/core';
import type {
  DeliveryRecord, GrantRecord, Locks, RecipientRecord, TriggerRecord, TriggerRepository,
} from '../domain/ports.js';

/**
 * Postgres, through Prisma.
 *
 * Mirrors `MemoryRepo` exactly — the in-memory twin is the specification, and
 * `test/prismaRepo.test.ts` runs the same expectations against both. Where they
 * differ, the memory one is right, because that is the one the release engine's
 * whole test suite was written against.
 *
 * One rule shapes most of what follows: the trigger's MEMORY of what it has
 * already done lives in the `Attempt` table, not in the state blob. That is
 * what makes "each step fires exactly once" survive a worker restart, a crash
 * mid-tick, or two workers racing — none of which a JSON column would.
 */

export class PrismaRepo implements TriggerRepository {
  constructor(private readonly db: PrismaClient) {}

  private async hydrate(row: {
    id: string; userId: string; name: string; workflow: Prisma.JsonValue;
    status: TriggerStatus; lastCheckInAt: Date; statusSince: Date; pausedUntil: Date | null;
  }): Promise<TriggerRecord> {
    const [attempts, attestations] = await Promise.all([
      this.db.attempt.findMany({
        where: { triggerId: row.id, at: { gte: row.lastCheckInAt } },
        orderBy: { at: 'asc' },
      }),
      this.db.attestation.findMany({
        where: { triggerId: row.id, at: { gte: row.lastCheckInAt } },
        orderBy: { at: 'asc' },
      }),
    ]);

    const state: TriggerState = {
      status: row.status,
      lastCheckInAt: row.lastCheckInAt.getTime(),
      statusSince: row.statusSince.getTime(),
      pausedUntil: row.pausedUntil ? row.pausedUntil.getTime() : null,
      // Attempts and answers from BEFORE the last check-in are excluded above:
      // a person who surfaced and went quiet again starts the ladder from the
      // top, and an eighteen-month-old "he's fine" says nothing about today.
      performed: attempts.map((a) => ({
        stepId: a.stepId,
        occurrence: a.occurrence,
        at: a.at.getTime(),
        ...(a.channel ? { channel: a.channel as Channel } : {}),
      })),
      attestations: attestations.map((a) => ({
        contactId: a.contactId,
        verdict: a.verdict,
        at: a.at.getTime(),
        otpVerified: a.otpVerified,
      })),
    };

    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      workflow: row.workflow as unknown as Workflow,
      state,
    };
  }

  async dueTriggers(now: number, limit: number): Promise<TriggerRecord[]> {
    const rows = await this.db.trigger.findMany({
      where: {
        nextEvaluationAt: { not: null, lte: new Date(now) },
        status: { notIn: ['DELIVERED', 'CANCELLED', 'DRAFT'] },
      },
      orderBy: { nextEvaluationAt: 'asc' },
      take: limit,
    });
    return Promise.all(rows.map((r) => this.hydrate(r)));
  }

  async saveState(triggerId: string, state: TriggerState, nextEvaluationAt: number | null) {
    await this.db.$transaction(async (tx) => {
      const current = await tx.trigger.findUnique({
        where: { id: triggerId },
        select: { lastCheckInAt: true },
      });

      await tx.trigger.update({
        where: { id: triggerId },
        data: {
          status: state.status,
          lastCheckInAt: new Date(state.lastCheckInAt),
          statusSince: new Date(state.statusSince),
          pausedUntil: state.pausedUntil == null ? null : new Date(state.pausedUntil),
          nextEvaluationAt: nextEvaluationAt == null ? null : new Date(nextEvaluationAt),
        },
      });

      /**
       * A moved check-in means the countdown restarted, so the record of what
       * was already sent has to go with it. Without this the ladder would
       * remember rungs from the previous lapse and skip them next time — the
       * owner would go quiet again and get one quiet email instead of the three
       * escalating attempts they asked for.
       *
       * Hydration already filters by date; this keeps the table from growing
       * without bound as well.
       */
      if (current && state.lastCheckInAt > current.lastCheckInAt.getTime()) {
        await tx.attempt.deleteMany({
          where: { triggerId, at: { lt: new Date(state.lastCheckInAt) } },
        });
      }
    });
  }

  async grantsFor(triggerId: string): Promise<GrantRecord[]> {
    const rows = await this.db.grant.findMany({ where: { triggerId } });
    return rows.map((g) => ({
      id: g.id, triggerId: g.triggerId, vaultId: g.vaultId,
      recipientId: g.recipientId, mode: g.mode,
    }));
  }

  async recipient(recipientId: string): Promise<RecipientRecord | null> {
    const r = await this.db.recipient.findUnique({ where: { id: recipientId } });
    return r
      ? {
          id: r.id, userId: r.userId, displayName: r.displayName,
          ...(r.email ? { email: r.email } : {}),
          ...(r.phone ? { phone: r.phone } : {}),
          isVerifier: r.isVerifier,
          ...(r.publicKey ? { publicKey: r.publicKey } : {}),
        }
      : null;
  }

  async owner(userId: string) {
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, displayName: true },
    });
    return u ?? null;
  }

  async deliveriesFor(triggerId: string): Promise<DeliveryRecord[]> {
    const rows = await this.db.delivery.findMany({ where: { triggerId } });
    return rows.map((d) => ({
      id: d.id, triggerId: d.triggerId, grantId: d.grantId, recipientId: d.recipientId,
      status: d.status, claimTokenHash: d.claimTokenHash ?? '',
      ...(d.dispatchedAt ? { dispatchedAt: d.dispatchedAt.getTime() } : {}),
    }));
  }

  /**
   * Idempotent on the id the engine derives from trigger+grant.
   *
   * This is the last line of defence against sending someone's legacy twice: a
   * worker that crashes between creating the row and dispatching will, on
   * retry, find the row rather than make a second one.
   */
  async createDelivery(d: Omit<DeliveryRecord, 'status'> & { status?: DeliveryRecord['status'] }) {
    const row = await this.db.delivery.upsert({
      where: { id: d.id },
      create: {
        id: d.id, triggerId: d.triggerId, grantId: d.grantId, recipientId: d.recipientId,
        claimTokenHash: d.claimTokenHash, status: d.status ?? 'PENDING',
      },
      update: {},
    });
    return {
      id: row.id, triggerId: row.triggerId, grantId: row.grantId, recipientId: row.recipientId,
      status: row.status, claimTokenHash: row.claimTokenHash ?? '',
      ...(row.dispatchedAt ? { dispatchedAt: row.dispatchedAt.getTime() } : {}),
    };
  }

  async markDeliveryDispatched(deliveryId: string, at: number) {
    await this.db.delivery.update({
      where: { id: deliveryId },
      data: { status: 'DISPATCHED', dispatchedAt: new Date(at) },
    });
  }

  async recordAnswerToken(triggerId: string, contactId: string, tokenHash: string) {
    await this.db.answerToken.create({ data: { triggerId, contactId, tokenHash } });
  }

  async recordAttempt(triggerId: string, stepId: string, occurrence: number, channel: Channel, at: number) {
    // Unique on (trigger, step, occurrence, channel): two workers racing the
    // same tick cannot produce two sends of the same rung.
    await this.db.attempt.upsert({
      where: { triggerId_stepId_occurrence_channel: { triggerId, stepId, occurrence, channel } },
      create: { triggerId, stepId, occurrence, channel, at: new Date(at) },
      update: {},
    });
  }

  async appendAudit(userId: string, kind: string, summary: string, detail?: unknown) {
    await this.db.auditEvent.create({
      data: { userId, kind, summary, detail: (detail ?? undefined) as Prisma.InputJsonValue },
    });
  }
}

/**
 * Postgres advisory locks.
 *
 * Two workers deciding to release the same trigger at the same instant would
 * each dispatch, and there is no unsending. `pg_try_advisory_xact_lock` is
 * taken inside a transaction and released when it ends — including when the
 * process dies mid-tick, which a row-flag lock would not survive.
 */
export class PostgresLocks implements Locks {
  constructor(private readonly db: PrismaClient) {}

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    const id = hashKey(key);
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${id}::bigint) AS locked
      `;
      if (!rows[0]?.locked) return null;
      return fn();
    });
  }
}

/** Stable 63-bit key for an advisory lock. */
function hashKey(key: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const ch of key) {
    h ^= BigInt(ch.charCodeAt(0));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return BigInt.asIntN(64, h);
}

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

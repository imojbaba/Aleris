import { createHash, randomBytes } from 'node:crypto';
import type { TriggerState } from '@vigil/core';
import type {
  Clock, DeliveryRecord, GrantRecord, Locks, Notifier, OutboundMessage,
  RecipientRecord, TriggerRecord, TriggerRepository, Tokens,
} from '../domain/ports.js';

/**
 * In-memory adapters.
 *
 * Used by the test suite and by `pnpm dev --offline`. The Prisma adapter mirrors
 * this interface exactly; keeping a memory implementation honest is what lets
 * the release engine's tests run in milliseconds and cover paths (a crash
 * halfway through a release, two workers racing) that are awkward to provoke
 * against a real database and far too important to leave uncovered.
 */

export class MemoryRepo implements TriggerRepository {
  triggers = new Map<string, TriggerRecord & { nextEvaluationAt: number | null }>();
  grants: GrantRecord[] = [];
  recipients = new Map<string, RecipientRecord>();
  owners = new Map<string, { id: string; email: string; displayName: string }>();
  deliveries: DeliveryRecord[] = [];
  attempts: { triggerId: string; stepId: string; occurrence: number; channel: string; at: number }[] = [];
  answerTokens: { triggerId: string; contactId: string; tokenHash: string }[] = [];
  audit: { userId: string; kind: string; summary: string; detail?: unknown }[] = [];

  /**
   * Custody shares released to a recipient's claim session.
   *
   * Each entry is a blob sealed to an ephemeral public key that exists only in
   * the recipient's browser. We hold these, we forward these, and we cannot
   * read a single one of them.
   */
  relayedShares: { deliveryId: string; custodianId: string; sealed: string }[] = [];
  /** Custodians who have not released for a delivery yet, for the "waiting on" UI. */
  custodiansFor = new Map<string, { custodianId: string; displayName: string }[]>();

  awaitingCustodians(deliveryId: string) {
    const released = new Set(
      this.relayedShares.filter((r) => r.deliveryId === deliveryId).map((r) => r.custodianId),
    );
    return (this.custodiansFor.get(deliveryId) ?? []).filter((c) => !released.has(c.custodianId));
  }

  /** Set to make createDelivery throw once, simulating a mid-release crash. */
  failNextDelivery = false;

  async dueTriggers(now: number, limit: number) {
    return [...this.triggers.values()]
      .filter((t) => t.nextEvaluationAt !== null && t.nextEvaluationAt <= now)
      .sort((a, b) => (a.nextEvaluationAt ?? 0) - (b.nextEvaluationAt ?? 0))
      .slice(0, limit)
      .map(({ nextEvaluationAt: _drop, ...rest }) => structuredClone(rest));
  }

  async saveState(triggerId: string, state: TriggerState, nextEvaluationAt: number | null) {
    const t = this.triggers.get(triggerId);
    if (!t) throw new Error(`unknown trigger ${triggerId}`);
    t.state = state;
    t.nextEvaluationAt = nextEvaluationAt;
  }

  async grantsFor(triggerId: string) {
    return this.grants.filter((g) => g.triggerId === triggerId);
  }

  async recipient(id: string) {
    return this.recipients.get(id) ?? null;
  }

  async owner(userId: string) {
    return this.owners.get(userId) ?? null;
  }

  async deliveriesFor(triggerId: string) {
    return this.deliveries.filter((d) => d.triggerId === triggerId);
  }

  async createDelivery(d: Omit<DeliveryRecord, 'status'> & { status?: DeliveryRecord['status'] }) {
    if (this.failNextDelivery) {
      this.failNextDelivery = false;
      throw new Error('simulated database failure mid-release');
    }
    // Idempotent on id: the engine derives it from trigger+grant deliberately.
    const existing = this.deliveries.find((x) => x.id === d.id);
    if (existing) return existing;
    const record: DeliveryRecord = { status: 'PENDING', ...d };
    this.deliveries.push(record);
    return record;
  }

  async markDeliveryDispatched(deliveryId: string, at: number) {
    const d = this.deliveries.find((x) => x.id === deliveryId);
    if (d) {
      d.status = 'DISPATCHED';
      d.dispatchedAt = at;
    }
  }

  async recordAnswerToken(triggerId: string, contactId: string, tokenHash: string) {
    this.answerTokens.push({ triggerId, contactId, tokenHash });
  }

  async recordAttempt(triggerId: string, stepId: string, occurrence: number, channel: string, at: number) {
    this.attempts.push({ triggerId, stepId, occurrence, channel, at });
  }

  async appendAudit(userId: string, kind: string, summary: string, detail?: unknown) {
    this.audit.push({ userId, kind, summary, detail });
  }
}

export class RecordingNotifier implements Notifier {
  sent: OutboundMessage[] = [];
  /** Channels that should report failure, to exercise partial-delivery paths. */
  failing = new Set<string>();

  async send(message: OutboundMessage) {
    this.sent.push(structuredClone(message));
    if (this.failing.has(message.channel)) return { ok: false, detail: 'simulated provider failure' };
    return { ok: true };
  }

  byTemplate(template: OutboundMessage['template']) {
    return this.sent.filter((m) => m.template === template);
  }
}

export class FakeClock implements Clock {
  constructor(private t: number) {}
  now() { return this.t; }
  set(t: number) { this.t = t; }
  advance(ms: number) { this.t += ms; }
}

/** Single-process lock. Production uses a Postgres advisory lock on the same key. */
export class MemoryLocks implements Locks {
  private held = new Set<string>();
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.held.has(key)) return null;
    this.held.add(key);
    try {
      return await fn();
    } finally {
      this.held.delete(key);
    }
  }
}

export const nodeTokens: Tokens = {
  mint() {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: nodeTokens.hash(token) };
  },
  hash(token: string) {
    return createHash('sha256').update(token).digest('base64url');
  },
};

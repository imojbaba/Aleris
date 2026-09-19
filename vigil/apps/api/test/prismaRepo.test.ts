import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { plan, freshState, checkIn, days, hours, type Workflow } from '@vigil/core';
import { PrismaRepo, PostgresLocks } from '../src/adapters/prisma.js';
import { ReleaseEngine } from '../src/domain/releaseEngine.js';
import { RecordingNotifier, FakeClock, nodeTokens } from '../src/adapters/memory.js';

/**
 * The Prisma adapter against a real Postgres.
 *
 * Deliberately exercises the adapter through the RELEASE ENGINE rather than
 * calling its methods one by one. The engine is the only consumer, its
 * behaviour is what matters, and the properties worth proving — exactly-once
 * delivery, the ladder resetting on a check-in, two workers not both releasing
 * — are all emergent from the repository and the engine together. Unit-testing
 * `createDelivery` in isolation would prove nothing about any of them.
 *
 * Skipped when DATABASE_URL is unset, so the suite still runs without a database.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const T0 = Date.UTC(2026, 0, 1);
const USER = 'user-1';
const TRIGGER = 'trigger-1';

const workflow: Workflow = {
  checkInEveryDays: 30,
  steps: [
    { id: 'emails', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 3, everyHours: 24 },
    { id: 'texts', kind: 'REMIND_OWNER', channels: ['SMS'], times: 1, everyHours: 24 },
    { id: 'settle', kind: 'WAIT', hours: 24 },
    {
      id: 'ask', kind: 'WELLBEING_CHECK', contactIds: ['rcpt-ray'],
      channels: ['EMAIL'], waitHours: 24 * 5, requireOtp: true,
    },
    { id: 'quiet', kind: 'WAIT', hours: 24 * 2 },
    { id: 'deliver', kind: 'FIRE' },
  ],
};
const P = plan(workflow, T0);
const stepAt = (id: string) => P.steps.find((s) => s.step.id === id)!.startsAt;

suite('the Prisma adapter, against real Postgres', () => {
  let db: PrismaClient;
  let repo: PrismaRepo;
  let notifier: RecordingNotifier;
  let clock: FakeClock;
  let engine: ReleaseEngine;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$connect();
  });

  afterAll(async () => { await db.$disconnect(); });

  beforeEach(async () => {
    // Cascades handle the children.
    await db.user.deleteMany({});

    await db.user.create({
      data: {
        id: USER, email: 'owner@example.com', displayName: 'Jo',
        kdfSalt: 's', kdfParamsM: 19456, kdfParamsT: 2, kdfParamsP: 1,
        wrappedMasterKey: 'w', publicKey: 'pk',
      },
    });
    await db.recipient.createMany({
      data: [
        { id: 'rcpt-ray', userId: USER, displayName: 'Ray', email: 'ray@example.com', isVerifier: true },
        { id: 'rcpt-maya', userId: USER, displayName: 'Maya', email: 'maya@example.com' },
      ],
    });
    await db.vault.create({
      data: { id: 'vault-1', userId: USER, encryptedTitle: 'ct', wrappedVaultKey: 'wk' },
    });
    await db.trigger.create({
      data: {
        id: TRIGGER, userId: USER, name: 'If I go quiet', status: 'ACTIVE',
        workflow: workflow as never,
        lastCheckInAt: new Date(T0), statusSince: new Date(T0),
        nextEvaluationAt: new Date(P.dueAt),
      },
    });
    await db.grant.create({
      data: {
        id: 'grant-1', vaultId: 'vault-1', recipientId: 'rcpt-maya',
        triggerId: TRIGGER, mode: 'SPLIT_CUSTODY', grantPayload: {} as never,
      },
    });

    repo = new PrismaRepo(db);
    notifier = new RecordingNotifier();
    clock = new FakeClock(T0);
    engine = new ReleaseEngine({
      repo, notifier, clock, locks: new PostgresLocks(db),
      tokens: nodeTokens, appBaseUrl: 'https://vigil.app',
    });
  });

  /** Run the worker on a schedule, as it really runs. */
  async function runTo(t: number, stepMs = hours(6)) {
    while (clock.now() < t) {
      clock.set(Math.min(t, clock.now() + stepMs));
      await engine.tick();
    }
    await engine.tick();
  }

  it('reads a trigger back exactly as the engine expects it', async () => {
    const due = await repo.dueTriggers(P.dueAt + hours(1), 10);
    expect(due).toHaveLength(1);
    expect(due[0]!.workflow.checkInEveryDays).toBe(30);
    expect(due[0]!.state.status).toBe('ACTIVE');
    expect(due[0]!.state.lastCheckInAt).toBe(T0);
    expect(due[0]!.state.performed).toEqual([]);
  });

  it('runs the whole cascade and delivers exactly once', async () => {
    await runTo(P.fireAt + days(1));
    expect(notifier.byTemplate('DELIVERY')).toHaveLength(1);
    expect(notifier.byTemplate('DELIVERY')[0]!.to.email).toBe('maya@example.com');

    const t = await db.trigger.findUniqueOrThrow({ where: { id: TRIGGER } });
    expect(t.status).toBe('DELIVERED');
    expect(await db.delivery.count()).toBe(1);
  });

  it('remembers every attempt across worker restarts, and repeats none', async () => {
    await runTo(stepAt('ask') + hours(1));
    const attempts = await db.attempt.findMany({ orderBy: [{ stepId: 'asc' }, { occurrence: 'asc' }] });
    const keys = attempts.map((a) => `${a.stepId}#${a.occurrence}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('emails#0');
    expect(keys).toContain('emails#2');
    expect(keys).toContain('texts#0');

    // A brand-new engine — as after a deploy — must not resend any of them.
    const fresh = new ReleaseEngine({
      repo, notifier, clock, locks: new PostgresLocks(db),
      tokens: nodeTokens, appBaseUrl: 'https://vigil.app',
    });
    const before = notifier.byTemplate('REMIND_OWNER').length;
    await fresh.tick();
    expect(notifier.byTemplate('REMIND_OWNER')).toHaveLength(before);
  });

  it('forgets the ladder when the owner checks in, so the next lapse starts at the top', async () => {
    await runTo(stepAt('texts') + hours(1));
    expect(await db.attempt.count()).toBeGreaterThan(0);

    const at = stepAt('texts') + hours(2);
    const rec = (await repo.dueTriggers(at, 10))[0] ?? { state: freshState(T0) };
    await repo.saveState(TRIGGER, checkIn(rec.state, at), at + days(30));

    // Stale attempts are gone, so the ladder is whole again.
    expect(await db.attempt.count({ where: { at: { lt: new Date(at) } } })).toBe(0);
    const after = await repo.dueTriggers(at + days(31), 10);
    expect(after[0]!.state.performed).toEqual([]);
    expect(after[0]!.state.status).toBe('ACTIVE');
  });

  it('ignores answers given before the last check-in', async () => {
    await db.attestation.create({
      data: { triggerId: TRIGGER, contactId: 'rcpt-ray', verdict: 'ALIVE', at: new Date(T0 - days(400)) },
    });
    const rec = (await repo.dueTriggers(P.dueAt + hours(1), 10))[0]!;
    expect(rec.state.attestations).toEqual([]);
  });

  it('stores only the hash of a one-time answer token', async () => {
    await runTo(stepAt('ask') + hours(1));
    const asked = notifier.byTemplate('WELLBEING_CHECK')[0]!;
    const token = asked.variables.answerUrl!.split('/').pop()!;
    const rows = await db.answerToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(nodeTokens.hash(token));
    expect(rows[0]!.tokenHash).not.toBe(token);
  });

  /**
   * The property that matters most in a multi-worker deployment: two ticks
   * racing the same trigger must not both release. The advisory lock is taken
   * inside a transaction, so it also survives a process dying mid-tick.
   */
  it('lets only one of two concurrent workers act on a trigger', async () => {
    clock.set(P.fireAt + days(1));
    const second = new ReleaseEngine({
      repo, notifier, clock, locks: new PostgresLocks(db),
      tokens: nodeTokens, appBaseUrl: 'https://vigil.app',
    });
    const [a, b] = await Promise.all([engine.tick(), second.tick()]);
    expect(a.skippedLocked + b.skippedLocked).toBeGreaterThanOrEqual(1);
    expect(a.evaluated + b.evaluated).toBe(1);
    expect(notifier.byTemplate('DELIVERY').length).toBeLessThanOrEqual(1);
  });

  it('writes a readable audit trail the owner can check afterwards', async () => {
    await runTo(P.fireAt + days(1));
    const kinds = (await db.auditEvent.findMany({ where: { userId: USER } })).map((a) => a.kind);
    expect(kinds).toContain('TRIGGER_STATUS_CHANGED');
    expect(kinds).toContain('WELLBEING_CHECK');
    expect(kinds).toContain('DELIVERED');
  });
});

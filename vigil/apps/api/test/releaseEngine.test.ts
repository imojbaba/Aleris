import { describe, it, expect, beforeEach } from 'vitest';
import { plan, days, hours, checkIn, freshState, recordAttestation, type Workflow } from '@vigil/core';
import { ReleaseEngine } from '../src/domain/releaseEngine.js';
import { MemoryRepo, RecordingNotifier, FakeClock, MemoryLocks, nodeTokens } from '../src/adapters/memory.js';

const T0 = Date.UTC(2026, 0, 1);
const USER = 'user-1';
const TRIGGER = 'trigger-1';

/** The workflow this product was asked for, with two people named. */
const workflow: Workflow = {
  checkInEveryDays: 30,
  steps: [
    { id: 'emails', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 3, everyHours: 24 },
    { id: 'whatsapp', kind: 'REMIND_OWNER', channels: ['WHATSAPP'], times: 1, everyHours: 24 },
    { id: 'settle', kind: 'WAIT', hours: 24 },
    { id: 'call', kind: 'REMIND_OWNER', channels: ['VOICE'], times: 1, everyHours: 24 },
    {
      id: 'ask', kind: 'WELLBEING_CHECK', contactIds: ['ray'],
      channels: ['EMAIL'], waitHours: 24 * 7, requireOtp: true,
      script: 'Hi — Jo is a Vigil user and we could not reach her. Is she alright?',
    },
    { id: 'quiet', kind: 'WAIT', hours: 24 * 3 },
    { id: 'deliver', kind: 'FIRE' },
  ],
};
const P = plan(workflow, T0);
const stepAt = (id: string) => P.steps.find((s) => s.step.id === id)!.startsAt;

let repo: MemoryRepo;
let notifier: RecordingNotifier;
let clock: FakeClock;
let engine: ReleaseEngine;

beforeEach(() => {
  repo = new MemoryRepo();
  notifier = new RecordingNotifier();
  clock = new FakeClock(T0);
  engine = new ReleaseEngine({
    repo, notifier, clock, locks: new MemoryLocks(), tokens: nodeTokens,
    appBaseUrl: 'https://vigil.app',
  });

  repo.owners.set(USER, { id: USER, email: 'owner@example.com', displayName: 'Jo' });
  repo.recipients.set('ray', {
    id: 'ray', userId: USER, displayName: 'Ray', email: 'ray@example.com', isVerifier: true,
  });
  repo.recipients.set('maya', {
    id: 'maya', userId: USER, displayName: 'Maya', email: 'maya@example.com', isVerifier: false,
  });
  repo.triggers.set(TRIGGER, {
    id: TRIGGER, userId: USER, name: 'If I go quiet', workflow,
    state: freshState(T0),
    nextEvaluationAt: P.dueAt,
  });
  repo.grants.push({
    id: 'grant-1', triggerId: TRIGGER, vaultId: 'vault-1', recipientId: 'maya', mode: 'SPLIT_CUSTODY',
  });
});

/**
 * Simulate the worker actually running on a schedule between now and `t`,
 * rather than teleporting the clock. The distinction matters: several safety
 * behaviours (one rung per tick, the extra tick before anything irreversible)
 * only exist across repeated runs, and a test that jumps straight to the end
 * would skip exactly the sequencing it is supposed to be checking.
 */
async function runTo(t: number, stepMs = hours(6)) {
  while (clock.now() < t) {
    clock.set(Math.min(t, clock.now() + stepMs));
    await engine.tick();
  }
  await engine.tick();
}

describe('the cascade, end to end', () => {
  it('reminds the owner without contacting anyone else during grace', async () => {
    await runTo(P.dueAt + days(1));
    expect(notifier.byTemplate('WELLBEING_CHECK')).toHaveLength(0);
    expect(notifier.byTemplate('DELIVERY')).toHaveLength(0);
    expect(repo.triggers.get(TRIGGER)!.state.status).toBe('REMINDING');
  });

  it('works through the owner’s ladder before anyone else is contacted', async () => {
    // Through the whole owner ladder first: emails, WhatsApp, the call.
    await runTo(stepAt('call') + hours(1));
    expect(notifier.byTemplate('REMIND_OWNER').length).toBeGreaterThan(0);
    expect(notifier.byTemplate('WELLBEING_CHECK'), 'nobody else yet').toHaveLength(0);

    // Only once every attempt on the owner is exhausted is Ray contacted.
    await runTo(stepAt('ask') + hours(1));
    const asked = notifier.byTemplate('WELLBEING_CHECK');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.to.email).toBe('ray@example.com');
  });

  it('asks the named person ONE question and tells them nothing else', async () => {
    await runTo(stepAt('ask') + hours(1));
    const msg = notifier.byTemplate('WELLBEING_CHECK')[0]!;
    const payload = JSON.stringify(msg);
    // Ray must not learn that a vault exists, who else is involved, or anything
    // about what Jo left behind.
    expect(payload).not.toContain('maya');
    expect(payload).not.toContain('vault');
    expect(payload).not.toContain('grant');
    expect(payload).not.toContain('deliver');
    expect(Object.keys(msg.variables).sort())
      .toEqual(['answerUrl', 'contactName', 'ownerName', 'requiresOtp', 'script']);
    // The owner's own wording is what the person actually reads.
    expect(msg.variables.script).toContain('Is she alright?');
  });

  it('stores only the hash of the one-time answer token, never the token', async () => {
    await runTo(stepAt('ask') + hours(1));
    const token = notifier.byTemplate('WELLBEING_CHECK')[0]!.variables.answerUrl!.split('/').pop()!;
    expect(repo.answerTokens).toHaveLength(1);
    expect(repo.answerTokens[0]!.tokenHash).not.toBe(token);
    expect(repo.answerTokens[0]!.tokenHash).toBe(nodeTokens.hash(token));
  });

  it('warns the owner one final time before the hold', async () => {
    await runTo(stepAt('quiet') + hours(1));
    expect(notifier.byTemplate('DELIVERY')).toHaveLength(0);
  });

  it('delivers after the full cascade, and marks the trigger RELEASED', async () => {
    await runTo(P.fireAt + hours(1));
    const delivered = notifier.byTemplate('DELIVERY');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.to.email).toBe('maya@example.com');
    expect(delivered[0]!.variables.ownerName).toBe('Jo');
    expect(repo.triggers.get(TRIGGER)!.state.status).toBe('DELIVERED');
    expect(repo.deliveries[0]!.status).toBe('DISPATCHED');
  });
});

describe('the server never handles key material', () => {
  it('sends the recipient a claim link and nothing that decrypts anything', async () => {
    await runTo(P.fireAt + hours(1));
    const msg = notifier.byTemplate('DELIVERY')[0]!;
    expect(Object.keys(msg.variables).sort()).toEqual(['claimUrl', 'ownerName', 'recipientName']);
    const payload = JSON.stringify(msg);
    for (const forbidden of ['wrappedVaultKey', 'sealedVaultKey', 'share', 'masterKey', 'releaseKey']) {
      expect(payload).not.toContain(forbidden);
    }
  });

  it('stores only the hash of the delivery claim token', async () => {
    await runTo(P.fireAt + hours(1));
    const url = new URL(notifier.byTemplate('DELIVERY')[0]!.variables.claimUrl!);
    const token = url.searchParams.get('k')!;
    expect(repo.deliveries[0]!.claimTokenHash).toBe(nodeTokens.hash(token));
    expect(JSON.stringify(repo.deliveries)).not.toContain(token);
  });
});

describe('exactly once', () => {
  it('does not deliver twice however many times the worker runs', async () => {
    await runTo(P.fireAt + hours(1));
    expect(notifier.byTemplate('DELIVERY')).toHaveLength(1);

    // Simulate a worker re-running the same trigger: force it back to due.
    // Simulate a worker that lost the status write but kept the delivery rows:
    // the engine must still refuse to send anything a second time.
    const t = repo.triggers.get(TRIGGER)!;
    t.nextEvaluationAt = clock.now();
    t.state = { ...t.state, status: 'REMINDING', performed: t.state.performed.filter((x) => x.stepId !== 'deliver') };
    await engine.tick();
    await engine.tick();

    expect(notifier.byTemplate('DELIVERY')).toHaveLength(1);
    expect(repo.deliveries).toHaveLength(1);
  });

  it('recovers from a crash mid-release without double-sending', async () => {
    repo.grants.push({
      id: 'grant-2', triggerId: TRIGGER, vaultId: 'vault-2', recipientId: 'ray', mode: 'SPLIT_CUSTODY',
    });

    // Let the cascade reach the brink honestly, then fail the database write on
    // the first delivery of the release — the worst moment for a process to die.
    await runTo(stepAt('quiet') + days(1));
    expect(notifier.byTemplate('DELIVERY')).toHaveLength(0);
    repo.failNextDelivery = true;

    await runTo(P.fireAt + days(2));

    // The retry finishes the job, and each person hears exactly once.
    expect(repo.deliveries).toHaveLength(2);
    const sentTo = notifier.byTemplate('DELIVERY').map((m) => m.to.email).sort();
    expect(sentTo).toEqual(['maya@example.com', 'ray@example.com']);
  });

  it('does not send the same escalation rung twice across ticks', async () => {
    await runTo(stepAt('emails') + hours(1));
    const first = notifier.byTemplate('REMIND_OWNER').length;
    await engine.tick();
    await engine.tick();
    expect(notifier.byTemplate('REMIND_OWNER')).toHaveLength(first);
  });
});

describe('the owner can always stop it', () => {
  it('a check-in mid-cascade prevents any delivery, ever', async () => {
    await runTo(stepAt('whatsapp') + hours(1));
    expect(repo.triggers.get(TRIGGER)!.state.status).toBe('REMINDING');

    const t = repo.triggers.get(TRIGGER)!;
    t.state = checkIn(t.state, stepAt('whatsapp') + hours(2));
    t.nextEvaluationAt = clock.now();

    await runTo(P.fireAt + days(1));
    expect(notifier.byTemplate('DELIVERY')).toHaveLength(0);
  });

  it('a named person saying ALIVE halts the cascade at the brink', async () => {
    await runTo(stepAt('quiet') + hours(1));
    const t = repo.triggers.get(TRIGGER)!;
    t.state = recordAttestation(t.state, { contactId: 'ray', verdict: 'ALIVE', at: clock.now() });
    t.nextEvaluationAt = clock.now();

    await runTo(P.fireAt + days(30));
    expect(notifier.byTemplate('DELIVERY')).toHaveLength(0);
    expect(repo.audit.some((a) => a.kind === 'STAND_DOWN')).toBe(true);
  });
});

describe('operational resilience', () => {
  it('skips a trigger another worker holds rather than racing it', async () => {
    const locks = new MemoryLocks();
    const slow = new ReleaseEngine({
      repo, notifier, clock, locks, tokens: nodeTokens, appBaseUrl: 'https://vigil.app',
    });
    clock.set(P.fireAt + hours(1));
    const [a, b] = await Promise.all([slow.tick(), slow.tick()]);
    const totalReleased = a.released + b.released;
    expect(totalReleased).toBeLessThanOrEqual(1);
    expect(a.skippedLocked + b.skippedLocked).toBeGreaterThanOrEqual(1);
    expect(notifier.byTemplate('DELIVERY').length).toBeLessThanOrEqual(1);
  });

  it('one broken trigger does not stop everyone else being reminded', async () => {
    repo.triggers.set('broken', {
      id: 'broken', userId: 'ghost', name: 'orphaned', workflow,
      // No owner row for 'ghost' — and a grant pointing at a missing recipient.
      state: freshState(T0),
      nextEvaluationAt: P.dueAt,
    });
    repo.grants.push({
      id: 'g-broken', triggerId: 'broken', vaultId: 'v', recipientId: 'nobody', mode: 'SPLIT_CUSTODY',
    });
    await runTo(stepAt('emails') + hours(1));
    expect(notifier.byTemplate('REMIND_OWNER').some((m) => m.to.email === 'owner@example.com')).toBe(true);
  });

  it('records a readable audit trail the owner can check afterwards', async () => {
    await runTo(P.fireAt + hours(1));
    const kinds = repo.audit.map((a) => a.kind);
    expect(kinds).toContain('TRIGGER_STATUS_CHANGED');
    expect(kinds).toContain('WELLBEING_CHECK');
    expect(kinds).toContain('DELIVERED');
    expect(repo.audit.find((a) => a.kind === 'DELIVERED')!.summary).toMatch(/released to 1 person/);
  });

  it('counts a provider failure as not-sent, so the rung is retried', async () => {
    notifier.failing.add('EMAIL');
    await runTo(stepAt('emails') + hours(1));
    const report = await engine.tick();
    expect(report.messagesSent).toBe(0);
  });
});

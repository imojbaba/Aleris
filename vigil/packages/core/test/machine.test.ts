import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONFIG, type TriggerConfig, type TriggerState,
  evaluate, milestones, applyDecision, checkIn, pause, resume, cancel, recordAttestation,
  days, hours, HARD_MINIMUM_TOTAL,
} from '../src/index.js';

const T0 = Date.UTC(2026, 0, 1);

const withVerifiers = (over: Partial<TriggerConfig> = {}): TriggerConfig => ({
  ...DEFAULT_CONFIG,
  verification: { ...DEFAULT_CONFIG.verification, verifierIds: ['ray', 'nadia'] },
  ...over,
});

const freshState = (over: Partial<TriggerState> = {}): TriggerState => ({
  status: 'ACTIVE',
  lastCheckInAt: T0,
  statusSince: T0,
  attestations: [],
  nudgesSent: [],
  ...over,
});

/** Run the machine forward, applying each decision, as the worker really does. */
function run(config: TriggerConfig, state: TriggerState, instants: number[]) {
  let s = state;
  const log = [];
  for (const now of instants) {
    const d = evaluate(config, s, now);
    log.push({ now, decision: d });
    s = applyDecision(s, d, now);
  }
  return { state: s, log };
}


/**
 * Evaluate, apply, and evaluate again at the same instant — exactly what the
 * worker does after carrying out a decision's actions. Needed wherever a test
 * asserts on RELEASING, because the machine deliberately spends one tick
 * flushing any unsent escalation attempt before doing anything irreversible.
 */
function settle(config: TriggerConfig, state: TriggerState, now: number, ticks = 3) {
  let s = state;
  let d = evaluate(config, s, now);
  for (let i = 0; i < ticks && d.status !== 'RELEASING'; i++) {
    s = applyDecision(s, d, now);
    d = evaluate(config, s, now);
  }
  return d;
}

describe('the ordinary path', () => {
  const config = withVerifiers();
  const m = milestones(config, T0);

  it('stays quiet while the owner is inside their window', () => {
    const d = evaluate(config, freshState(), T0 + days(10));
    expect(d.status).toBe('ACTIVE');
    expect(d.actions).toEqual([]);
  });

  it('enters grace on a missed check-in and contacts NOBODY else', () => {
    const d = evaluate(config, freshState(), m.dueAt + days(1));
    expect(d.status).toBe('GRACE');
    expect(d.actions).toEqual([]);
    expect(d.reason).toMatch(/nobody else has been contacted/i);
  });

  it('escalates rung by rung once grace ends', () => {
    const { log } = run(config, freshState(), [
      m.graceEndsAt + hours(1),
      m.graceEndsAt + days(5) + hours(1),
      m.graceEndsAt + days(12) + hours(1),
    ]);
    const nudges = log.flatMap((e) => e.decision.actions.filter((a) => a.kind === 'NUDGE_OWNER'));
    // The last rung comes due exactly as the hold opens; it must still be sent.
    expect(nudges.map((n: any) => n.step)).toEqual([0, 1, 2]);
    expect(log.map((e) => e.decision.status)).toEqual(['ESCALATING', 'ESCALATING', 'VERIFICATION_HOLD']);
  });

  it('never releases with an escalation attempt still unsent', () => {
    // Jump straight to the release boundary with nothing yet sent.
    const d = evaluate(config, freshState({ status: 'ESCALATING' }), m.earliestReleaseAt + days(1));
    expect(d.status).toBe('VERIFICATION_HOLD');
    expect(d.actions.map((a) => a.kind)).toContain('NUDGE_OWNER');
    expect(d.actions.map((a) => a.kind)).not.toContain('RELEASE');
  });

  it('never sends the same escalation rung twice', () => {
    const { log } = run(config, freshState(), [
      m.graceEndsAt + hours(1), m.graceEndsAt + hours(2), m.graceEndsAt + hours(3),
    ]);
    const nudges = log.flatMap((e) => e.decision.actions.filter((a) => a.kind === 'NUDGE_OWNER'));
    expect(nudges).toHaveLength(1);
  });

  it('asks the verifiers once, not on every tick', () => {
    let s = freshState();
    const asks = [];
    for (const now of [m.graceEndsAt + hours(1), m.graceEndsAt + days(5) + hours(1)]) {
      const d = evaluate(config, s, now);
      asks.push(...d.actions.filter((a) => a.kind === 'ASK_VERIFIERS'));
      s = applyDecision(s, d, now);
      // The worker records that verifiers were asked by storing their replies;
      // simulate the pending state with an UNSURE placeholder.
      if (d.actions.some((a) => a.kind === 'ASK_VERIFIERS')) {
        s = recordAttestation(s, { verifierId: 'ray', verdict: 'UNSURE', at: now });
      }
    }
    expect(asks).toHaveLength(1);
  });

  it('holds before releasing, warning the owner one last time', () => {
    const d = evaluate(config, freshState({ status: 'ESCALATING' }), m.escalationEndsAt + hours(1));
    expect(d.status).toBe('VERIFICATION_HOLD');
    expect(d.actions.map((a) => a.kind)).toContain('NOTIFY_OWNER_FINAL_WARNING');
  });

  it('releases only after the final hold', () => {
    const before = evaluate(config, freshState({ status: 'VERIFICATION_HOLD' }), m.earliestReleaseAt - hours(1));
    expect(before.status).toBe('VERIFICATION_HOLD');
    const after = settle(config, freshState({ status: 'VERIFICATION_HOLD' }), m.earliestReleaseAt + hours(1));
    expect(after.status).toBe('RELEASING');
    expect(after.actions).toEqual([{ kind: 'RELEASE' }]);
  });
});

describe('stand-down: the owner always wins', () => {
  const config = withVerifiers();
  const m = milestones(config, T0);

  /**
   * Swept across the entire cascade rather than spot-checked, because "it
   * stopped when I said I was alive" is the promise that makes the rest of the
   * product safe to use at all.
   */
  it('a check-in at ANY point before release returns to ACTIVE with nothing sent', () => {
    const points = [
      m.dueAt + days(1), m.graceEndsAt + hours(1), m.graceEndsAt + days(6),
      m.escalationEndsAt + hours(1), m.earliestReleaseAt - hours(1),
    ];
    for (const now of points) {
      let s = freshState({ status: 'ESCALATING' });
      s = checkIn(s, now);
      const d = evaluate(config, s, now + hours(1));
      expect(d.status, `at ${new Date(now).toISOString()}`).toBe('ACTIVE');
      expect(d.actions.filter((a) => a.kind === 'RELEASE')).toHaveLength(0);
    }
  });

  it('a check-in wipes escalation history, so a later lapse starts from rung one', () => {
    let s = freshState();
    s = applyDecision(s, evaluate(config, s, m.graceEndsAt + hours(1)), m.graceEndsAt + hours(1));
    expect(s.nudgesSent.length).toBeGreaterThan(0);
    s = checkIn(s, m.graceEndsAt + days(1));
    expect(s.nudgesSent).toEqual([]);
    expect(s.attestations).toEqual([]);
  });

  it('ONE verifier saying "alive" halts everything, even at the brink', () => {
    let s = freshState({ status: 'VERIFICATION_HOLD' });
    s = recordAttestation(s, { verifierId: 'ray', verdict: 'ALIVE', at: m.earliestReleaseAt - hours(1) });
    const d = evaluate(config, s, m.earliestReleaseAt + days(30));
    expect(d.status).toBe('ACTIVE');
    expect(d.reason).toMatch(/alright/i);
  });

  it('outvotes a DECEASED verdict — life beats death when they disagree', () => {
    let s = freshState({ status: 'VERIFICATION_HOLD' });
    s = recordAttestation(s, { verifierId: 'ray', verdict: 'DECEASED', at: T0 + days(50) });
    s = recordAttestation(s, { verifierId: 'nadia', verdict: 'ALIVE', at: T0 + days(51) });
    expect(evaluate(config, s, m.earliestReleaseAt + days(1)).status).toBe('ACTIVE');
  });

  it('ignores attestations older than the last check-in', () => {
    let s = freshState({ lastCheckInAt: T0 + days(100) });
    s = recordAttestation(s, { verifierId: 'ray', verdict: 'ALIVE', at: T0 });
    const later = milestones(config, T0 + days(100));
    const d = evaluate(config, s, later.graceEndsAt + hours(1));
    // The stale "he's fine" must NOT keep the trigger alive forever.
    expect(d.status).toBe('ESCALATING');
  });

  it('cancelled and released triggers are inert forever', () => {
    for (const status of ['CANCELLED', 'RELEASED'] as const) {
      const d = evaluate(config, freshState({ status }), T0 + days(10_000));
      expect(d.status).toBe(status);
      expect(d.actions).toEqual([]);
      expect(d.nextEvaluationAt).toBeNull();
    }
    expect(cancel(freshState({ status: 'RELEASED' }), T0).status).toBe('RELEASED');
  });
});

describe('verification policy', () => {
  const m = milestones(DEFAULT_CONFIG, T0);

  it('REQUIRE_ATTESTATION never releases on silence, however long', () => {
    const config = withVerifiers({
      verification: {
        verifierIds: ['ray', 'nadia'], requiredAttestations: 1,
        policy: 'REQUIRE_ATTESTATION', holdDays: 7,
      },
    });
    const d = evaluate(config, freshState({ status: 'VERIFICATION_HOLD' }), T0 + days(10_000));
    expect(d.status).toBe('VERIFICATION_HOLD');
    expect(d.actions.map((a) => a.kind)).not.toContain('RELEASE');
  });

  it('REQUIRE_ATTESTATION releases once enough people confirm', () => {
    const config = withVerifiers({
      verification: {
        verifierIds: ['ray', 'nadia'], requiredAttestations: 2,
        policy: 'REQUIRE_ATTESTATION', holdDays: 7,
      },
    });
    let s = freshState({ status: 'VERIFICATION_HOLD' });
    s = recordAttestation(s, { verifierId: 'ray', verdict: 'DECEASED', at: T0 + days(60) });
    expect(evaluate(config, s, T0 + days(70)).status).toBe('VERIFICATION_HOLD');
    s = recordAttestation(s, { verifierId: 'nadia', verdict: 'DECEASED', at: T0 + days(61) });
    expect(settle(config, s, T0 + days(70)).status).toBe('RELEASING');
  });

  it('counts only the latest verdict per verifier, and only known verifiers', () => {
    const config = withVerifiers({
      verification: {
        verifierIds: ['ray'], requiredAttestations: 1,
        policy: 'REQUIRE_ATTESTATION', holdDays: 7,
      },
    });
    let s = freshState({ status: 'VERIFICATION_HOLD' });
    s = recordAttestation(s, { verifierId: 'ray', verdict: 'DECEASED', at: T0 + days(60) });
    s = recordAttestation(s, { verifierId: 'ray', verdict: 'UNSURE', at: T0 + days(61) });
    expect(evaluate(config, s, T0 + days(70)).status).toBe('VERIFICATION_HOLD');

    let t = freshState({ status: 'VERIFICATION_HOLD' });
    t = recordAttestation(t, { verifierId: 'a-stranger', verdict: 'DECEASED', at: T0 + days(60) });
    expect(evaluate(config, t, T0 + days(70)).status).toBe('VERIFICATION_HOLD');
  });

  it('SILENCE_CONFIRMS releases when nobody responds, which is the point', () => {
    expect(settle(withVerifiers(), freshState({ status: 'VERIFICATION_HOLD' }), m.earliestReleaseAt + days(1)).status)
      .toBe('RELEASING');
  });
});

describe('the hard floor', () => {
  it('refuses to release inside 24 hours no matter how the trigger is configured', () => {
    const reckless: TriggerConfig = {
      checkInIntervalDays: 0.01, graceDays: 0,
      escalation: [{ afterDays: 0, channels: ['EMAIL', 'SMS'] }],
      verification: { verifierIds: [], requiredAttestations: 0, policy: 'SILENCE_CONFIRMS', holdDays: 0 },
      acknowledgedRapidRelease: true,
    };
    const m = milestones(reckless, T0);
    expect(m.earliestReleaseAt - T0).toBeGreaterThanOrEqual(HARD_MINIMUM_TOTAL);
    expect(evaluate(reckless, freshState(), T0 + hours(12)).status).not.toBe('RELEASING');
    expect(settle(reckless, freshState({ status: 'VERIFICATION_HOLD' }), T0 + hours(25)).status).toBe('RELEASING');
  });

  it('measures the floor from the last check-in, so editing a live trigger cannot shorten it', () => {
    // Owner goes quiet under a long config, then the config is shortened.
    const shortened: TriggerConfig = {
      ...DEFAULT_CONFIG, checkInIntervalDays: 1, graceDays: 0,
      escalation: [{ afterDays: 0, channels: ['EMAIL', 'SMS'] }],
      verification: { ...DEFAULT_CONFIG.verification, holdDays: 0 },
      acknowledgedRapidRelease: true,
    };
    const m = milestones(shortened, T0);
    expect(m.earliestReleaseAt).toBeGreaterThanOrEqual(T0 + HARD_MINIMUM_TOTAL);
  });
});

describe('pause and resume', () => {
  const config = withVerifiers();

  it('freezes the countdown indefinitely', () => {
    const s = pause(freshState(), T0 + days(5));
    const d = evaluate(config, s, T0 + days(10_000));
    expect(d.status).toBe('PAUSED');
    expect(d.actions).toEqual([]);
  });

  it('restarts the clock on expiry rather than resuming mid-cascade', () => {
    const until = T0 + days(60);
    const s = pause(freshState(), T0 + days(5), until);
    const d = evaluate(config, s, until + hours(1));
    expect(d.status).toBe('ACTIVE');
    const applied = applyDecision(s, d, until + hours(1));
    expect(applied.lastCheckInAt).toBe(until + hours(1));
  });

  it('resume() restarts the clock from now', () => {
    const s = resume(pause(freshState(), T0 + days(5)), T0 + days(400));
    expect(s.status).toBe('ACTIVE');
    expect(s.lastCheckInAt).toBe(T0 + days(400));
    expect(evaluate(config, s, T0 + days(401)).status).toBe('ACTIVE');
  });

  it('cannot be paused once released', () => {
    expect(pause(freshState({ status: 'RELEASED' }), T0).status).toBe('RELEASED');
  });
});

describe('idempotence', () => {
  it('re-evaluating the same instant twice changes nothing', () => {
    const config = withVerifiers();
    const m = milestones(config, T0);
    const now = m.graceEndsAt + days(6);
    let s = freshState();
    const first = evaluate(config, s, now);
    s = applyDecision(s, first, now);
    const second = evaluate(config, s, now);
    expect(second.actions.filter((a) => a.kind === 'NUDGE_OWNER')).toEqual([]);
    expect(second.status).toBe(first.status);
  });

  it('a worker that runs late still fires every rung it owes, exactly once', () => {
    const config = withVerifiers();
    const m = milestones(config, T0);
    // Worker was down for two weeks and catches up in one tick.
    const d = evaluate(config, freshState(), m.escalationEndsAt + hours(1));
    const steps = d.actions.filter((a) => a.kind === 'NUDGE_OWNER').map((a: any) => a.step);
    expect(steps.sort()).toEqual([0, 1, 2]);
  });
});

describe('the unsent-rung guard does not become a deadlock', () => {
  it('delays release by exactly one tick, then proceeds', () => {
    const config = withVerifiers();
    const m = milestones(config, T0);
    const now = m.earliestReleaseAt + days(1);

    let s = freshState({ status: 'VERIFICATION_HOLD' });
    const first = evaluate(config, s, now);
    expect(first.status).toBe('VERIFICATION_HOLD');
    expect(first.actions.map((a) => a.kind)).toContain('NUDGE_OWNER');

    s = applyDecision(s, first, now);
    const second = evaluate(config, s, now);
    expect(second.status).toBe('RELEASING');
  });

  it('cannot loop forever even if every channel is unreachable', () => {
    // The machine records an ATTEMPT, not a delivery. A permanently bounced
    // address must not hold someone's legacy hostage indefinitely.
    const config = withVerifiers();
    const m = milestones(config, T0);
    let s = freshState();
    let status = '';
    for (let i = 0; i < 40; i++) {
      const now = m.earliestReleaseAt + days(i);
      const d = evaluate(config, s, now);
      s = applyDecision(s, d, now);
      status = d.status;
      if (status === 'RELEASING') break;
    }
    expect(status).toBe('RELEASING');
  });
});

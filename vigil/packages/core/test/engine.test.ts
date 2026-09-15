import { describe, it, expect } from 'vitest';
import {
  type Workflow, type TriggerState, type Decision,
  evaluate, applyDecision, plan, freshState,
  checkIn, pause, resume, cancel, recordAttestation,
  withContacts, STEADY, days, hours, HARD_MINIMUM_TOTAL,
} from '../src/index.js';

const T0 = Date.UTC(2026, 0, 1);

/** The workflow the product was asked for, with two people named. */
const WF: Workflow = {
  checkInEveryDays: 30,
  steps: [
    { id: 'emails', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 3, everyHours: 24 },
    { id: 'whatsapp', kind: 'REMIND_OWNER', channels: ['WHATSAPP'], times: 1, everyHours: 24 },
    { id: 'settle', kind: 'WAIT', hours: 24 },
    { id: 'call', kind: 'REMIND_OWNER', channels: ['VOICE'], times: 1, everyHours: 24 },
    {
      id: 'ask', kind: 'WELLBEING_CHECK', contactIds: ['ray', 'nadia'],
      channels: ['SMS', 'EMAIL'], waitHours: 24 * 7, requireOtp: true,
    },
    { id: 'quiet', kind: 'WAIT', hours: 24 * 3 },
    { id: 'deliver', kind: 'FIRE' },
  ],
};

const P = plan(WF, T0);
const at = (id: string) => P.steps.find((s) => s.step.id === id)!.startsAt;

const start = (over: Partial<TriggerState> = {}): TriggerState => ({ ...freshState(T0), ...over });

/** Run the worker on a schedule between now and `t`, as it really runs. */
function runTo(state: TriggerState, t: number, stepMs = hours(6)) {
  let s = state;
  let clock = s.lastCheckInAt;
  const log: { at: number; decision: Decision }[] = [];
  while (clock < t) {
    clock = Math.min(t, clock + stepMs);
    const d = evaluate(WF, s, clock);
    log.push({ at: clock, decision: d });
    s = applyDecision(s, d, clock);
  }
  return { state: s, log };
}

const actionsOf = (log: { decision: Decision }[], kind: string) =>
  log.flatMap((e) => e.decision.actions.filter((a) => a.kind === kind));

describe('walking the workflow the user wrote', () => {
  it('stays quiet inside the check-in window', () => {
    const d = evaluate(WF, start(), T0 + days(10));
    expect(d.status).toBe('ACTIVE');
    expect(d.actions).toEqual([]);
  });

  it('sends the three emails on three consecutive days, and nothing else', () => {
    const { log } = runTo(start(), at('emails') + days(2) + hours(1));
    const reminders = actionsOf(log, 'REMIND_OWNER') as any[];
    expect(reminders.map((r) => `${r.stepId}#${r.occurrence}`)).toEqual([
      'emails#0', 'emails#1', 'emails#2',
    ]);
    expect(actionsOf(log, 'WELLBEING_CHECK')).toHaveLength(0);
    expect(actionsOf(log, 'FIRE')).toHaveLength(0);
  });

  it('moves on to WhatsApp, then the call, in the order written', () => {
    const { log } = runTo(start(), at('call') + hours(1));
    const order = (actionsOf(log, 'REMIND_OWNER') as any[]).map((r) => r.stepId);
    expect(order).toEqual(['emails', 'emails', 'emails', 'whatsapp', 'call']);
  });

  it('asks the named people only after every attempt on the owner', () => {
    const { log } = runTo(start(), at('ask') + hours(1));
    const asks = actionsOf(log, 'WELLBEING_CHECK') as any[];
    expect(asks).toHaveLength(1);
    expect(asks[0].contactIds).toEqual(['ray', 'nadia']);
    expect(asks[0].requireOtp).toBe(true);
    // Everything aimed at the owner happened first.
    const firstAskIndex = log.findIndex((e) => e.decision.actions.some((a) => a.kind === 'WELLBEING_CHECK'));
    const lastRemindIndex = log.map((e) => e.decision.actions.some((a) => a.kind === 'REMIND_OWNER'))
      .lastIndexOf(true);
    expect(lastRemindIndex).toBeLessThan(firstAskIndex);
  });

  it('delivers once every step has run', () => {
    const { state, log } = runTo(start(), P.fireAt + hours(12));
    expect(actionsOf(log, 'FIRE')).toHaveLength(1);
    expect(state.status).toBe('DELIVERED');
  });

  it('never repeats a step occurrence, however often the worker runs', () => {
    const { log } = runTo(start(), P.fireAt + days(1), hours(1));
    const keys = (actionsOf(log, 'REMIND_OWNER') as any[]).map((r) => `${r.stepId}#${r.occurrence}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(actionsOf(log, 'WELLBEING_CHECK')).toHaveLength(1);
    expect(actionsOf(log, 'FIRE')).toHaveLength(1);
  });

  it('a worker down for a fortnight owes every missed attempt, each exactly once', () => {
    const d = evaluate(WF, start(), at('ask') - hours(1));
    const keys = (d.actions.filter((a) => a.kind === 'REMIND_OWNER') as any[])
      .map((r) => `${r.stepId}#${r.occurrence}`);
    expect(keys.sort()).toEqual(['call#0', 'emails#0', 'emails#1', 'emails#2', 'whatsapp#0']);
  });

  it('reports which step it is on, for the owner’s timeline', () => {
    expect(evaluate(WF, start(), at('whatsapp') + hours(1)).currentStepId).toBe('whatsapp');
    expect(evaluate(WF, start(), at('ask') + days(1)).currentStepId).toBe('ask');
  });
});

describe('the owner always wins', () => {
  it('a check-in at ANY point before delivery stands everything down', () => {
    for (const t of [
      at('emails') + hours(1), at('whatsapp') + hours(1), at('call') + hours(1),
      at('ask') + days(2), P.fireAt - hours(1),
    ]) {
      let s = runTo(start(), t).state;
      s = checkIn(s, t);
      const d = evaluate(WF, s, t + hours(1));
      expect(d.status, new Date(t).toISOString()).toBe('ACTIVE');
      const after = runTo(s, t + days(20));
      expect(actionsOf(after.log, 'FIRE')).toHaveLength(0);
    }
  });

  it('a check-in clears the record, so a later lapse starts from the first email', () => {
    let s = runTo(start(), at('call') + hours(1)).state;
    expect(s.performed.length).toBeGreaterThan(0);
    s = checkIn(s, at('call') + hours(2));
    expect(s.performed).toEqual([]);
    expect(s.attestations).toEqual([]);
  });

  it('ONE person saying "alive" halts everything, even at the brink', () => {
    let s = runTo(start(), P.fireAt - hours(2)).state;
    s = recordAttestation(s, { contactId: 'ray', verdict: 'ALIVE', at: P.fireAt - hours(1) });
    const d = evaluate(WF, s, P.fireAt + days(30));
    expect(d.status).toBe('ACTIVE');
    expect(d.reason).toMatch(/alright/i);
  });

  it('life beats death when the named people disagree', () => {
    let s = start();
    s = recordAttestation(s, { contactId: 'ray', verdict: 'DECEASED', at: T0 + days(40) });
    s = recordAttestation(s, { contactId: 'nadia', verdict: 'ALIVE', at: T0 + days(41) });
    expect(evaluate(WF, s, P.fireAt + days(1)).status).toBe('ACTIVE');
  });

  it('ignores answers given before the last check-in', () => {
    let s = start({ lastCheckInAt: T0 + days(100) });
    s = recordAttestation(s, { contactId: 'ray', verdict: 'ALIVE', at: T0 });
    const later = plan(WF, T0 + days(100));
    const d = evaluate(WF, s, later.steps[0]!.startsAt + hours(1));
    expect(d.status).toBe('REMINDING');
  });

  it('cancelled and delivered triggers are inert forever', () => {
    for (const status of ['CANCELLED', 'DELIVERED'] as const) {
      const d = evaluate(WF, start({ status }), T0 + days(10_000));
      expect(d.status).toBe(status);
      expect(d.actions).toEqual([]);
    }
    expect(cancel(start({ status: 'DELIVERED' }), T0).status).toBe('DELIVERED');
  });
});

describe('confirmation gates', () => {
  const gated = (onTimeout: 'HOLD' | 'PROCEED'): Workflow => ({
    checkInEveryDays: 30,
    steps: [
      { id: 'emails', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 2, everyHours: 24 },
      { id: 'texts', kind: 'REMIND_OWNER', channels: ['SMS'], times: 2, everyHours: 24 },
      { id: 'gate', kind: 'REQUIRE_CONFIRMATION', from: ['ray', 'nadia'], count: 2, timeoutHours: 72, onTimeout },
      { id: 'quiet', kind: 'WAIT', hours: 24 },
      { id: 'deliver', kind: 'FIRE' },
    ],
  });

  function run(wf: Workflow, s0: TriggerState, t: number) {
    let s = s0;
    let clock = s.lastCheckInAt;
    const log: Decision[] = [];
    while (clock < t) {
      clock = Math.min(t, clock + hours(6));
      const d = evaluate(wf, s, clock);
      log.push(d);
      s = applyDecision(s, d, clock);
    }
    return { state: s, log };
  }

  it('HOLD never delivers on silence, however long we wait', () => {
    const wf = gated('HOLD');
    const { log } = run(wf, freshState(T0), T0 + days(10_000));
    expect(log.flatMap((d) => d.actions.filter((a) => a.kind === 'FIRE'))).toHaveLength(0);
    expect(log.at(-1)!.status).toBe('AWAITING_CONFIRMATION');
    expect(log.at(-1)!.reason).toMatch(/Nothing will be sent until then/);
  });

  it('HOLD delivers once enough people confirm', () => {
    const wf = gated('HOLD');
    let s = freshState(T0);
    s = recordAttestation(s, { contactId: 'ray', verdict: 'DECEASED', at: T0 + days(35) });
    expect(run(wf, s, T0 + days(60)).log.flatMap((d) => d.actions.filter((a) => a.kind === 'FIRE'))).toHaveLength(0);
    s = recordAttestation(s, { contactId: 'nadia', verdict: 'DECEASED', at: T0 + days(36) });
    expect(run(wf, s, T0 + days(60)).log.flatMap((d) => d.actions.filter((a) => a.kind === 'FIRE'))).toHaveLength(1);
  });

  it('PROCEED treats silence as consent, after the timeout the owner set', () => {
    const wf = gated('PROCEED');
    const { log } = run(wf, freshState(T0), T0 + days(60));
    expect(log.flatMap((d) => d.actions.filter((a) => a.kind === 'FIRE'))).toHaveLength(1);
  });

  it('counts only the latest verdict per person, and only named people', () => {
    const wf = gated('HOLD');
    let s = freshState(T0);
    s = recordAttestation(s, { contactId: 'ray', verdict: 'DECEASED', at: T0 + days(35) });
    s = recordAttestation(s, { contactId: 'ray', verdict: 'UNSURE', at: T0 + days(36) });
    s = recordAttestation(s, { contactId: 'a-stranger', verdict: 'DECEASED', at: T0 + days(36) });
    s = recordAttestation(s, { contactId: 'nadia', verdict: 'DECEASED', at: T0 + days(37) });
    expect(run(wf, s, T0 + days(60)).log.flatMap((d) => d.actions.filter((a) => a.kind === 'FIRE'))).toHaveLength(0);
  });

  it('asks for confirmation exactly once, not on every tick', () => {
    const wf = gated('HOLD');
    const { log } = run(wf, freshState(T0), T0 + days(60));
    expect(log.flatMap((d) => d.actions.filter((a) => a.kind === 'REQUEST_CONFIRMATION'))).toHaveLength(1);
  });
});

describe('the floor and the last-attempt guard hold at runtime', () => {
  it('will not deliver inside 24 hours even if the workflow says so', () => {
    const reckless: Workflow = {
      checkInEveryDays: 0.01,
      acknowledgedRapidRelease: true,
      steps: [
        { id: 'a', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 1, everyHours: 0.25 },
        { id: 'b', kind: 'REMIND_OWNER', channels: ['SMS'], times: 1, everyHours: 0.25 },
        { id: 'f', kind: 'FIRE' },
      ],
    };
    const p = plan(reckless, T0);
    expect(p.fireAt - T0).toBe(HARD_MINIMUM_TOTAL);

    let s = freshState(T0);
    let fired = false;
    for (let h = 1; h <= 23; h++) {
      const d = evaluate(reckless, s, T0 + hours(h));
      if (d.actions.some((a) => a.kind === 'FIRE')) fired = true;
      s = applyDecision(s, d, T0 + hours(h));
    }
    expect(fired).toBe(false);
    const after = evaluate(reckless, s, T0 + hours(25));
    expect(after.actions.some((a) => a.kind === 'FIRE')).toBe(true);
  });

  it('never delivers with an attempt on the owner still unsent', () => {
    // Jump the worker straight past the end with nothing yet performed.
    const d = evaluate(WF, start(), P.fireAt + days(1));
    expect(d.actions.some((a) => a.kind === 'FIRE')).toBe(false);
    expect(d.actions.some((a) => a.kind === 'REMIND_OWNER')).toBe(true);
    expect(d.reason).toMatch(/had not finished trying to reach you/);

    // And it is a one-tick delay, not a deadlock.
    const s = applyDecision(start(), d, P.fireAt + days(1));
    expect(evaluate(WF, s, P.fireAt + days(1)).actions.some((a) => a.kind === 'FIRE')).toBe(true);
  });
});

describe('pause and resume', () => {
  it('freezes the countdown indefinitely', () => {
    const d = evaluate(WF, pause(start(), T0 + days(5)), T0 + days(10_000));
    expect(d.status).toBe('PAUSED');
    expect(d.actions).toEqual([]);
  });

  it('restarts the clock on expiry rather than resuming mid-ladder', () => {
    const until = T0 + days(60);
    const s = pause(start(), T0 + days(5), until);
    const d = evaluate(WF, s, until + hours(1));
    expect(d.status).toBe('ACTIVE');
    expect(applyDecision(s, d, until + hours(1)).lastCheckInAt).toBe(until + hours(1));
  });

  it('resume() starts from today and clears the record', () => {
    let s = runTo(start(), at('call') + hours(1)).state;
    s = pause(s, at('call') + hours(2));
    s = resume(s, T0 + days(400));
    expect(s.performed).toEqual([]);
    expect(evaluate(WF, s, T0 + days(401)).status).toBe('ACTIVE');
  });

  it('cannot be paused once delivered', () => {
    expect(pause(start({ status: 'DELIVERED' }), T0).status).toBe('DELIVERED');
  });
});

describe('the shipped default behaves', () => {
  it('runs end to end and delivers exactly once', () => {
    const wf = withContacts(STEADY, ['ray', 'nadia']);
    const p = plan(wf, T0);
    let s = freshState(T0);
    let clock = T0;
    let fires = 0;
    while (clock < p.fireAt + days(2)) {
      clock += hours(6);
      const d = evaluate(wf, s, clock);
      fires += d.actions.filter((a) => a.kind === 'FIRE').length;
      s = applyDecision(s, d, clock);
    }
    expect(fires).toBe(1);
    expect(s.status).toBe('DELIVERED');
  });
});

describe('delivery happens exactly once, guaranteed by the core', () => {
  it('stops emitting FIRE the moment one has been applied', () => {
    let s = freshState(T0);
    let clock = T0;
    const fires: number[] = [];
    // Run well past the end, ticking hourly — the worst case for a naive evaluator.
    while (clock < P.fireAt + days(30)) {
      clock += hours(1);
      const d = evaluate(WF, s, clock);
      if (d.actions.some((a) => a.kind === 'FIRE')) fires.push(clock);
      s = applyDecision(s, d, clock);
    }
    expect(fires).toHaveLength(1);
    expect(s.status).toBe('DELIVERED');
  });

  it('is inert forever afterwards, even if the workflow is edited', () => {
    let s = freshState(T0);
    let clock = T0;
    while (clock < P.fireAt + days(1)) {
      clock += hours(6);
      s = applyDecision(s, evaluate(WF, s, clock), clock);
    }
    const longer: Workflow = { ...WF, checkInEveryDays: 365 };
    const d = evaluate(longer, s, clock + days(500));
    expect(d.status).toBe('DELIVERED');
    expect(d.actions).toEqual([]);
  });
});

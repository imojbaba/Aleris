import { describe, it, expect } from 'vitest';
import {
  type Workflow, type Step,
  validateWorkflow, isValidWorkflow, plan, totalFuseLength, lastOwnerContactAt,
  HARD_MINIMUM_TOTAL, SAFE_MINIMUM_TOTAL, MINIMUM_SETTLE_BEFORE_FIRE, rawFuseLength,
  TEMPLATES, STEADY, withContacts, days, hours, DAY,
} from '../src/index.js';

const errors = (w: Workflow) => validateWorkflow(w).filter((i) => i.severity === 'error');
const warnings = (w: Workflow) => validateWorkflow(w).filter((i) => i.severity === 'warning');
const messages = (w: Workflow) => errors(w).map((e) => e.message).join(' | ');

/** A minimal valid workflow to mutate in tests. */
const base = (steps: Step[], over: Partial<Workflow> = {}): Workflow => ({
  checkInEveryDays: 30,
  steps,
  ...over,
});

const OK_STEPS: Step[] = [
  { id: 'a', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 3, everyHours: 24 },
  { id: 'b', kind: 'REMIND_OWNER', channels: ['SMS'], times: 2, everyHours: 24 },
  { id: 'c', kind: 'WAIT', hours: 48 },
  { id: 'd', kind: 'FIRE' },
];

describe('the workflow a user actually describes', () => {
  /**
   * The shape this product was asked for, verbatim: "check in every 1 month,
   * remind on failure 3 times through emails on consecutive days, then
   * WhatsApp, wait 24 hours, then call — and if that fails, ask the people I
   * named." It has to be expressible without special-casing, and it has to
   * pass validation.
   */
  const asDescribed: Workflow = {
    checkInEveryDays: 30,
    steps: [
      { id: 'emails', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 3, everyHours: 24 },
      { id: 'whatsapp', kind: 'REMIND_OWNER', channels: ['WHATSAPP'], times: 1, everyHours: 24 },
      { id: 'settle', kind: 'WAIT', hours: 24 },
      { id: 'call', kind: 'REMIND_OWNER', channels: ['VOICE'], times: 1, everyHours: 24 },
      {
        id: 'ask', kind: 'WELLBEING_CHECK', contactIds: ['ray', 'nadia'],
        channels: ['SMS', 'EMAIL'], waitHours: 24 * 7, requireOtp: true,
        script: 'Hi — Ojaswa is a Vigil user and we could not reach him. Is he alright?',
      },
      { id: 'quiet', kind: 'WAIT', hours: 24 * 3 },
      { id: 'deliver', kind: 'FIRE' },
    ],
  };

  it('is valid', () => {
    expect(messages(asDescribed)).toBe('');
    expect(isValidWorkflow(asDescribed)).toBe(true);
  });

  it('schedules the three emails on consecutive days', () => {
    const p = plan(asDescribed, 0);
    const emails = p.steps.find((s) => s.step.id === 'emails')!;
    expect(emails.occurrences).toHaveLength(3);
    expect(emails.occurrences[1]! - emails.occurrences[0]!).toBe(days(1));
    expect(emails.occurrences[2]! - emails.occurrences[1]!).toBe(days(1));
    expect(emails.startsAt).toBe(days(30));
  });

  it('runs WhatsApp after the emails, then waits a day, then calls', () => {
    const p = plan(asDescribed, 0);
    const at = (id: string) => p.steps.find((s) => s.step.id === id)!.startsAt;
    expect(at('whatsapp')).toBe(days(33));
    expect(at('settle')).toBe(days(34));
    expect(at('call')).toBe(days(35));
    expect(at('ask')).toBe(days(36));
  });

  it('carries the owner’s own script through to the wellbeing check', () => {
    const step = asDescribed.steps.find((s) => s.id === 'ask')!;
    expect(step.kind).toBe('WELLBEING_CHECK');
    if (step.kind === 'WELLBEING_CHECK') {
      expect(step.script).toContain('Is he alright?');
      expect(step.requireOtp).toBe(true);
    }
  });
});

describe('safety survives workflows the user wrote', () => {
  /**
   * The fixed cascade got these properties for free. A user-authored workflow
   * gets none of them for free, which is what this whole block is defending.
   */

  it('refuses a workflow that never tries to reach the owner', () => {
    const w = base([
      { id: 'ask', kind: 'WELLBEING_CHECK', contactIds: ['ray'], channels: ['EMAIL'], waitHours: 48 },
      { id: 'f', kind: 'FIRE' },
    ]);
    expect(messages(w)).toMatch(/ever tries to reach you/);
  });

  it('refuses a workflow that never delivers', () => {
    expect(messages(base(OK_STEPS.slice(0, 3)))).toMatch(/never delivers/);
  });

  it('refuses two deliveries, and delivery that is not last', () => {
    expect(messages(base([...OK_STEPS, { id: 'e', kind: 'FIRE' }]))).toMatch(/only deliver once/);
    const notLast = base([
      { id: 'a', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 3, everyHours: 24 },
      { id: 'b', kind: 'REMIND_OWNER', channels: ['SMS'], times: 1, everyHours: 24 },
      { id: 'f', kind: 'FIRE' },
      { id: 'c', kind: 'WAIT', hours: 24 },
    ]);
    expect(messages(notLast)).toMatch(/has to be the last step/);
  });

  /**
   * The subtle one. WhatsApp, SMS and a voice call are three channel names and
   * ONE point of failure: a phone number. A workflow using all three still
   * fires on a lapsed SIM while its owner is perfectly well.
   */
  it('refuses three channels that are really one phone number', () => {
    const w = base([
      { id: 'a', kind: 'REMIND_OWNER', channels: ['SMS'], times: 2, everyHours: 24 },
      { id: 'b', kind: 'REMIND_OWNER', channels: ['WHATSAPP'], times: 2, everyHours: 24 },
      { id: 'c', kind: 'REMIND_OWNER', channels: ['VOICE'], times: 2, everyHours: 24 },
      { id: 'w', kind: 'WAIT', hours: 24 },
      { id: 'f', kind: 'FIRE' },
    ]);
    expect(messages(w)).toMatch(/goes to your phone number.*lost SIM/);
    // Adding email fixes it.
    const fixed: Workflow = {
      ...w,
      steps: [{ id: 'z', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 2, everyHours: 24 }, ...w.steps],
    };
    expect(errors(fixed)).toHaveLength(0);
  });

  it('refuses email-only and push-only ladders too, with the right reason', () => {
    const emailOnly = base([
      { id: 'a', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 5, everyHours: 24 },
      { id: 'w', kind: 'WAIT', hours: 48 }, { id: 'f', kind: 'FIRE' },
    ]);
    expect(messages(emailOnly)).toMatch(/spam filter/);

    const pushOnly = base([
      { id: 'a', kind: 'REMIND_OWNER', channels: ['PUSH'], times: 5, everyHours: 24 },
      { id: 'w', kind: 'WAIT', hours: 48 }, { id: 'f', kind: 'FIRE' },
    ]);
    expect(messages(pushOnly)).toMatch(/lost or reset handset/);
  });

  /**
   * Generalises a real bug the fixed cascade shipped: the loudest last-ditch
   * message landed at the same instant delivery became due, so it was never
   * sent. In a workflow the user assembles, that mistake is one drag away.
   */
  it('refuses delivery hard on the heels of the last attempt to reach the owner', () => {
    const w = base([
      { id: 'a', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 3, everyHours: 24 },
      { id: 'b', kind: 'REMIND_OWNER', channels: ['SMS'], times: 1, everyHours: 1 },
      { id: 'f', kind: 'FIRE' },
    ]);
    expect(messages(w)).toMatch(/between the last attempt to reach you and delivery/);
    expect(lastOwnerContactAt(w)).not.toBeNull();
  });

  it('accepts it once there is a real gap', () => {
    const w = base([
      { id: 'a', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 3, everyHours: 24 },
      { id: 'b', kind: 'REMIND_OWNER', channels: ['SMS'], times: 1, everyHours: 24 },
      { id: 'f', kind: 'FIRE' },
    ]);
    const settle = totalFuseLength(w) - lastOwnerContactAt(w)!;
    expect(settle).toBeGreaterThanOrEqual(MINIMUM_SETTLE_BEFORE_FIRE);
    expect(errors(w)).toHaveLength(0);
  });

  it('will not let anything deliver inside 24 hours, however it is assembled', () => {
    const w = base(
      [
        { id: 'a', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 1, everyHours: 0.25 },
        { id: 'b', kind: 'REMIND_OWNER', channels: ['SMS'], times: 1, everyHours: 0.25 },
        { id: 'f', kind: 'FIRE' },
      ],
      { checkInEveryDays: 0.01, acknowledgedRapidRelease: true },
    );
    expect(messages(w)).toMatch(/within 24 hours/);
    // And the plan's floor holds regardless of what validation says.
    expect(plan(w, 0).fireAt).toBeGreaterThanOrEqual(HARD_MINIMUM_TOTAL);
  });

  it('demands acknowledgement below three weeks, then allows it', () => {
    const rapid = base(
      [
        { id: 'a', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 3, everyHours: 6 },
        { id: 'b', kind: 'REMIND_OWNER', channels: ['SMS'], times: 3, everyHours: 6 },
        { id: 'w', kind: 'WAIT', hours: 24 },
        { id: 'f', kind: 'FIRE' },
      ],
      { checkInEveryDays: 2 },
    );
    expect(totalFuseLength(rapid)).toBeLessThan(SAFE_MINIMUM_TOTAL);
    expect(errors(rapid).map((e) => e.at)).toContain('acknowledgedRapidRelease');
    expect(isValidWorkflow({ ...rapid, acknowledgedRapidRelease: true })).toBe(true);
  });

  it('catches a confirmation gate that could never be satisfied', () => {
    const w = base([
      ...OK_STEPS.slice(0, 3),
      { id: 'g', kind: 'REQUIRE_CONFIRMATION', from: ['ray'], count: 3, timeoutHours: 48, onTimeout: 'HOLD' },
      { id: 'f', kind: 'FIRE' },
    ]);
    expect(messages(w)).toMatch(/needs 3 confirmations but only 1 person is named/);
  });

  it('catches a gate that waits on nobody', () => {
    const w = base([
      ...OK_STEPS.slice(0, 3),
      { id: 'g', kind: 'REQUIRE_CONFIRMATION', from: [], count: 1, timeoutHours: 48, onTimeout: 'HOLD' },
      { id: 'f', kind: 'FIRE' },
    ]);
    expect(messages(w)).toMatch(/confirmation from nobody/);
  });

  it('catches duplicate step ids, empty channel lists and zero repeats', () => {
    expect(messages(base([
      { id: 'dup', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 1, everyHours: 24 },
      { id: 'dup', kind: 'REMIND_OWNER', channels: ['SMS'], times: 1, everyHours: 24 },
      { id: 'w', kind: 'WAIT', hours: 48 }, { id: 'f', kind: 'FIRE' },
    ]))).toMatch(/share an id/);

    expect(messages(base([
      { id: 'a', kind: 'REMIND_OWNER', channels: [], times: 1, everyHours: 24 },
      { id: 'b', kind: 'REMIND_OWNER', channels: ['SMS'], times: 0, everyHours: 24 },
      { id: 'w', kind: 'WAIT', hours: 48 }, { id: 'f', kind: 'FIRE' },
    ]))).toMatch(/no way to reach you.*never actually sends/s);
  });

  it('warns, without blocking, when nobody is ever asked about the owner', () => {
    const w = base(OK_STEPS);
    expect(isValidWorkflow(w)).toBe(true);
    expect(warnings(w).map((x) => x.message).join(' ')).toMatch(/Nobody who knows you is ever asked/);
  });

  it('warns when every confirmer must answer and silence blocks forever', () => {
    const w = base([
      ...OK_STEPS.slice(0, 3),
      { id: 'g', kind: 'REQUIRE_CONFIRMATION', from: ['ray', 'nadia'], count: 2, timeoutHours: 48, onTimeout: 'HOLD' },
      { id: 'f', kind: 'FIRE' },
    ]);
    expect(warnings(w).map((x) => x.message).join(' ')).toMatch(/name a spare/);
  });
});

describe('shipped templates', () => {
  it('are all valid once their contacts are filled in', () => {
    for (const t of TEMPLATES) {
      const w = withContacts(t.workflow, ['ray', 'nadia']);
      expect(messages(w), t.id).toBe('');
    }
  });

  /**
   * A template with nobody named IS invalid — you cannot ask nobody whether
   * someone is alright. What matters is that missing contacts are the ONLY
   * thing wrong with it, so the app can arm it the moment a recipient exists
   * rather than the user hitting a second, unrelated wall.
   */
  it('are invalid before contacts are named, and ONLY for that reason', () => {
    for (const t of TEMPLATES) {
      const unrelated = errors(t.workflow).filter(
        (e) => !/asks nobody|confirmation from nobody/.test(e.message),
      );
      expect(unrelated.map((e) => e.message), t.id).toEqual([]);
    }
  });

  it('are ordered from most to least patient', () => {
    const lengths = TEMPLATES.map((t) => totalFuseLength(t.workflow));
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
  });

  it('the default gives about two months before anything is sent', () => {
    const total = totalFuseLength(STEADY);
    expect(total).toBeGreaterThan(days(50));
    expect(total).toBeLessThan(days(70));
  });

  it('withContacts fills wellbeing checks and clamps gate counts', () => {
    const filled = withContacts(TEMPLATES.find((t) => t.id === 'watched')!.workflow, ['ray']);
    const gate = filled.steps.find((s) => s.kind === 'REQUIRE_CONFIRMATION');
    expect(gate && gate.kind === 'REQUIRE_CONFIRMATION' && gate.count).toBe(1);
    const check = filled.steps.find((s) => s.kind === 'WELLBEING_CHECK');
    expect(check && check.kind === 'WELLBEING_CHECK' && check.contactIds).toEqual(['ray']);
  });
});

describe('fuse length is measured honestly', () => {
  it('reports the floored length for display but validates the raw one', () => {
    const w: Workflow = {
      checkInEveryDays: 0.01,
      acknowledgedRapidRelease: true,
      steps: [
        { id: 'a', kind: 'REMIND_OWNER', channels: ['EMAIL'], times: 1, everyHours: 0.25 },
        { id: 'b', kind: 'REMIND_OWNER', channels: ['SMS'], times: 1, everyHours: 0.25 },
        { id: 'f', kind: 'FIRE' },
      ],
    };
    // Floored for display: the runtime really will not fire before 24h.
    expect(totalFuseLength(w)).toBe(HARD_MINIMUM_TOTAL);
    // Raw for validation: the user is told their workflow does not say what it means.
    expect(rawFuseLength(w)).toBeLessThan(HARD_MINIMUM_TOTAL);
    expect(messages(w)).toMatch(/within 24 hours/);
  });
});

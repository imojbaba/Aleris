import { type Channel, CHANNEL_INDEPENDENCE, listChannels } from './channels.js';
import { type Millis, DAY, HOUR, humaniseDuration } from './time.js';

/**
 * The trigger, as a workflow the user writes.
 *
 * Vigil's first design had a fixed cascade with settings: an interval, a grace
 * period, three escalation rungs. It was safe and it was wrong — it encoded OUR
 * idea of how someone should be checked on. People's lives differ, and so does
 * what they consider proof that something is wrong. Someone who travels for work
 * needs a longer fuse than someone recovering from surgery; someone with no
 * family needs a different ladder from someone with four siblings.
 *
 * So the trigger is now an ordered list of steps the user composes:
 *
 *     check in every 30 days
 *       ├─ email me 3 times, a day apart
 *       ├─ WhatsApp me, then wait 24 hours
 *       ├─ call me (a voice agent, reading a script I wrote)
 *       ├─ ask Ray and Nadia if I'm alright
 *       └─ fire
 *
 * The hard part is not expressing that. The hard part is that EVERY safety
 * property the fixed cascade got for free — two independent channels, a gap
 * between the last attempt and the irreversible act, a floor on total time —
 * now has to be enforced against a workflow the user assembled themselves.
 * `validateWorkflow` is where that lives, and it is the most important function
 * in this package.
 */

export type StepKind =
  | 'REMIND_OWNER'
  | 'WAIT'
  | 'WELLBEING_CHECK'
  | 'REQUIRE_CONFIRMATION'
  | 'FIRE';

interface StepBase {
  /** Stable across edits — performed occurrences are recorded against it. */
  id: string;
  /** The user's own words for this step, shown on their timeline. */
  label?: string;
}

/** Contact the owner. Repeats are how "email me three days running" is said. */
export interface RemindOwnerStep extends StepBase {
  kind: 'REMIND_OWNER';
  channels: Channel[];
  /** How many times this step fires. */
  times: number;
  /** Gap between repeats, and the time allowed after the last one. */
  everyHours: number;
  /** Optional copy the owner wrote for themselves. */
  message?: string;
}

/** Pure delay. "Then wait 24 hours." */
export interface WaitStep extends StepBase {
  kind: 'WAIT';
  hours: number;
}

/**
 * Ask designated people whether the owner is alright.
 *
 * These people are NEVER shown vault contents, told a vault exists, or told who
 * else was contacted. They get one question and a script the owner wrote.
 */
export interface WellbeingCheckStep extends StepBase {
  kind: 'WELLBEING_CHECK';
  contactIds: string[];
  channels: Channel[];
  /** The owner's own wording, so the message sounds like someone they know. */
  script?: string;
  /** How long to wait for answers before moving on. */
  waitHours: number;
  /** Require the contact to prove control of their address before answering. */
  requireOtp?: boolean;
}

/**
 * A gate. The workflow does not advance past this until enough named people
 * have confirmed — or, if the owner chose, until the timeout treats silence as
 * confirmation.
 */
export interface RequireConfirmationStep extends StepBase {
  kind: 'REQUIRE_CONFIRMATION';
  from: string[];
  count: number;
  timeoutHours: number;
  /**
   * What silence means. HOLD is safer and can deadlock; PROCEED delivers and
   * can be wrong. There is no third answer, and it is the owner's to give.
   */
  onTimeout: 'HOLD' | 'PROCEED';
}

/** The irreversible step. Exactly one, always last. */
export interface FireStep extends StepBase {
  kind: 'FIRE';
}

export type Step =
  | RemindOwnerStep
  | WaitStep
  | WellbeingCheckStep
  | RequireConfirmationStep
  | FireStep;

export interface Workflow {
  /** How often the owner promises to check in. */
  checkInEveryDays: number;
  /** Run in order, starting the moment a check-in is missed. */
  steps: Step[];
  /**
   * Explicit acknowledgement for a workflow that fires in under
   * {@link SAFE_MINIMUM_TOTAL}. A short fuse is a legitimate need — a
   * journalist filing from somewhere dangerous, a solo expedition — so we
   * support it. We only refuse to let someone arrive there without noticing.
   */
  acknowledgedRapidRelease?: boolean;
}

/* ------------------------------ step duration ---------------------------- */

export function stepDuration(step: Step): Millis {
  switch (step.kind) {
    case 'REMIND_OWNER':
      // The final send still gets its full window to be answered.
      return step.times * step.everyHours * HOUR;
    case 'WAIT':
      return step.hours * HOUR;
    case 'WELLBEING_CHECK':
      return step.waitHours * HOUR;
    case 'REQUIRE_CONFIRMATION':
      return step.timeoutHours * HOUR;
    case 'FIRE':
      return 0;
  }
}

export interface PlannedStep {
  index: number;
  step: Step;
  startsAt: Millis;
  endsAt: Millis;
  /** Absolute times at which each repeat of a REMIND_OWNER step fires. */
  occurrences: Millis[];
}

export interface Plan {
  dueAt: Millis;
  steps: PlannedStep[];
  /** Earliest instant the workflow can fire, hard floor included. */
  fireAt: Millis;
}

/**
 * Nothing releases within 24 hours of the last check-in, whatever the workflow
 * says — and the floor is measured from when the owner was last SEEN, so
 * editing a live workflow cannot shorten a countdown already running.
 */
export const HARD_MINIMUM_TOTAL: Millis = 24 * HOUR;

/** Below this a workflow is "rapid" and needs explicit acknowledgement. */
export const SAFE_MINIMUM_TOTAL: Millis = 21 * DAY;

/**
 * The minimum gap between the last attempt to reach the owner and FIRE.
 *
 * This generalises a bug the fixed cascade shipped and its tests caught: the
 * loudest, last-ditch message was scheduled for the same instant the release
 * became due, so the message most likely to reach a living person was the one
 * never sent. In a user-authored workflow that mistake is far easier to make,
 * so it is now a validation error rather than a thing we hope people avoid.
 */
export const MINIMUM_SETTLE_BEFORE_FIRE: Millis = 12 * HOUR;

export function plan(workflow: Workflow, lastCheckInAt: Millis): Plan {
  const dueAt = lastCheckInAt + workflow.checkInEveryDays * DAY;
  const steps: PlannedStep[] = [];
  let cursor = dueAt;

  for (const [index, step] of workflow.steps.entries()) {
    const duration = stepDuration(step);
    const occurrences: Millis[] = [];
    if (step.kind === 'REMIND_OWNER') {
      for (let i = 0; i < step.times; i++) occurrences.push(cursor + i * step.everyHours * HOUR);
    } else {
      occurrences.push(cursor);
    }
    steps.push({ index, step, startsAt: cursor, endsAt: cursor + duration, occurrences });
    cursor += duration;
  }

  return { dueAt, steps, fireAt: Math.max(cursor, lastCheckInAt + HARD_MINIMUM_TOTAL) };
}

/** What the workflow will actually do, floor included. For display. */
export function totalFuseLength(workflow: Workflow): Millis {
  return plan(workflow, 0).fireAt;
}

/**
 * The workflow's own length, WITHOUT the hard floor applied.
 *
 * Validation has to measure this rather than {@link totalFuseLength}: the floor
 * is baked into the plan, so a workflow written to fire in forty minutes reads
 * back as exactly 24 hours and sails past a `total < HARD_MINIMUM_TOTAL` check.
 * The floor would still have protected the user at runtime, but they would
 * never have been told their workflow does not do what it says — and a trigger
 * silently behaving differently from its own description is precisely the
 * failure this product cannot afford.
 */
export function rawFuseLength(workflow: Workflow): Millis {
  return (
    workflow.checkInEveryDays * DAY +
    workflow.steps.reduce((total, step) => total + stepDuration(step), 0)
  );
}

/** The last moment the workflow tries to reach the OWNER themselves. */
export function lastOwnerContactAt(workflow: Workflow, lastCheckInAt = 0): Millis | null {
  const p = plan(workflow, lastCheckInAt);
  const reminders = p.steps.filter((s) => s.step.kind === 'REMIND_OWNER');
  if (reminders.length === 0) return null;
  return Math.max(...reminders.flatMap((s) => s.occurrences));
}

/* -------------------------------- validation ----------------------------- */

export interface WorkflowIssue {
  severity: 'error' | 'warning';
  /** Step id, or a workflow-level field. */
  at: string;
  message: string;
}

export function validateWorkflow(workflow: Workflow): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const err = (at: string, message: string) => issues.push({ severity: 'error', at, message });
  const warn = (at: string, message: string) => issues.push({ severity: 'warning', at, message });

  if (workflow.checkInEveryDays <= 0) {
    err('checkInEveryDays', 'The check-in interval must be longer than nothing.');
  }

  const ids = new Set<string>();
  for (const step of workflow.steps) {
    if (ids.has(step.id)) err(step.id, 'Two steps share an id; each step needs its own.');
    ids.add(step.id);
  }

  /* --- the shape of the workflow --- */

  const fireSteps = workflow.steps.filter((s) => s.kind === 'FIRE');
  if (fireSteps.length === 0) {
    err('steps', 'This workflow never delivers anything. Add a final step that sends what you left.');
  } else if (fireSteps.length > 1) {
    err('steps', 'A workflow can only deliver once.');
  } else if (workflow.steps.at(-1)!.kind !== 'FIRE') {
    err('steps', 'Delivering has to be the last step — nothing can run after it.');
  }

  /* --- reaching the owner --- */

  const reminders = workflow.steps.filter((s): s is RemindOwnerStep => s.kind === 'REMIND_OWNER');
  if (reminders.length === 0) {
    err('steps', 'Nothing here ever tries to reach you. Vigil will not deliver in silence.');
  }

  for (const r of reminders) {
    if (r.channels.length === 0) err(r.id, 'This step has no way to reach you.');
    if (r.times < 1) err(r.id, 'This step never actually sends anything.');
    if (r.everyHours <= 0) err(r.id, 'Repeats need a gap between them.');
  }

  /**
   * Two INDEPENDENT channels, not two names. WhatsApp, SMS and a voice call all
   * arrive at one phone number: a workflow using all three is still one lapsed
   * SIM away from concluding its owner has died.
   */
  const reachedBy = new Set(
    reminders.flatMap((r) => r.channels.map((c) => CHANNEL_INDEPENDENCE[c])),
  );
  if (reminders.length > 0 && reachedBy.size < 2) {
    const only = [...reachedBy][0];
    err(
      'steps',
      only === 'PHONE_NUMBER'
        ? 'Every attempt here goes to your phone number. One lost SIM and this fires while you are perfectly well — add an email step.'
        : only === 'MAILBOX'
          ? 'Every attempt here is email. A full mailbox or a spam filter would be enough to fire this — add a text or a call.'
          : 'Every attempt here is a phone notification. A lost or reset handset would be enough to fire this — add email or a text.',
    );
  }

  /* --- the gap before the irreversible step --- */

  const lastContact = lastOwnerContactAt(workflow);
  if (lastContact !== null && fireSteps.length === 1) {
    const fireAt = plan(workflow, 0).fireAt;
    const settle = fireAt - lastContact;
    if (settle < MINIMUM_SETTLE_BEFORE_FIRE) {
      err(
        'steps',
        `Only ${humaniseDuration(settle)} between the last attempt to reach you and delivery. ` +
          `Leave at least ${humaniseDuration(MINIMUM_SETTLE_BEFORE_FIRE)} — someone who picks up the phone ` +
          `needs time to stop this.`,
      );
    }
  }

  /* --- wellbeing checks and confirmation gates --- */

  for (const step of workflow.steps) {
    if (step.kind === 'WELLBEING_CHECK') {
      if (step.contactIds.length === 0) err(step.id, 'This step asks nobody.');
      if (step.channels.length === 0) err(step.id, 'This step has no way to reach anyone.');
      if (step.waitHours <= 0) warn(step.id, 'This asks people and moves on without waiting for an answer.');
    }
    if (step.kind === 'REQUIRE_CONFIRMATION') {
      if (step.from.length === 0) {
        err(step.id, 'This waits for confirmation from nobody, so nothing would ever be delivered.');
      } else if (step.count > step.from.length) {
        err(
          step.id,
          `This needs ${step.count} confirmations but only ${step.from.length} ` +
            `${step.from.length === 1 ? 'person is' : 'people are'} named. It could never complete.`,
        );
      } else if (step.count === step.from.length && step.onTimeout === 'HOLD') {
        warn(
          step.id,
          'Every single person must answer, and silence blocks delivery permanently. One unreachable person stops everything — name a spare.',
        );
      }
      if (step.count < 1) warn(step.id, 'This gate confirms nothing and will always pass.');
    }
    if (step.kind === 'WAIT' && step.hours <= 0) {
      warn(step.id, 'A wait of no time does nothing.');
    }
  }

  /* --- total length --- */

  const total = rawFuseLength(workflow);
  if (total < HARD_MINIMUM_TOTAL) {
    err(
      'steps',
      'Nothing can be set to deliver within 24 hours of your last check-in. Lengthen a step.',
    );
  } else if (total < SAFE_MINIMUM_TOTAL && !workflow.acknowledgedRapidRelease) {
    err(
      'acknowledgedRapidRelease',
      `This delivers after ${humaniseDuration(total)} of silence — shorter than a long holiday. Confirm you meant it.`,
    );
  }

  /* --- the things that are merely unwise --- */

  const hasWellbeing = workflow.steps.some((s) => s.kind === 'WELLBEING_CHECK');
  const hasGate = workflow.steps.some((s) => s.kind === 'REQUIRE_CONFIRMATION');
  if (!hasWellbeing && !hasGate) {
    warn(
      'steps',
      'Nobody who knows you is ever asked whether you are alright. Naming one person — who only ever answers that question — is the single biggest thing you can do to prevent a false alarm.',
    );
  }
  if (total > 2 * 365 * DAY) {
    warn('checkInEveryDays', `Over two years of silence before anything happens. Is that what you want?`);
  }

  return issues;
}

export const isValidWorkflow = (w: Workflow): boolean =>
  !validateWorkflow(w).some((i) => i.severity === 'error');

/* ------------------------------ description ------------------------------ */

/** One line per step, in the owner's terms. Used for the review screen. */
export function describeStep(step: Step): string {
  switch (step.kind) {
    case 'REMIND_OWNER':
      return step.times === 1
        ? `We try you on ${listChannels(step.channels)}.`
        : `We try you on ${listChannels(step.channels)}, ${step.times} times, ${humaniseDuration(step.everyHours * HOUR)} apart.`;
    case 'WAIT':
      return `Nothing happens for ${humaniseDuration(step.hours * HOUR)}.`;
    case 'WELLBEING_CHECK':
      return `We ask ${step.contactIds.length} ${step.contactIds.length === 1 ? 'person' : 'people'} whether you are alright, on ${listChannels(step.channels)}. They are told nothing else.`;
    case 'REQUIRE_CONFIRMATION':
      return step.onTimeout === 'HOLD'
        ? `Nothing is delivered unless ${step.count} of them confirm. Silence stops it permanently.`
        : `We wait ${humaniseDuration(step.timeoutHours * HOUR)} for ${step.count} to confirm. Silence lets it continue.`;
    case 'FIRE':
      return 'What you left is delivered to the people you chose. This cannot be undone.';
  }
}

export function summariseWorkflow(workflow: Workflow): string {
  return `About ${humaniseDuration(totalFuseLength(workflow))} of silence before anything is sent.`;
}

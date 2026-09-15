import type { Channel } from './channels.js';
import { type Millis, DAY, HOUR } from './time.js';
import {
  type Step, type Workflow, type PlannedStep, plan,
} from './workflow.js';
import {
  type TriggerState, type TriggerStatus, TERMINAL, currentVerdicts, someoneSaysAlive,
} from './state.js';

/**
 * The evaluator: a pure function of (workflow, state, now).
 *
 * No database, no clock, no network — which is what lets every path that can
 * end in delivery be tested exhaustively. Given what this decides, "we ran it
 * against staging once" is not an acceptable standard of evidence.
 */

export type Action =
  | { kind: 'REMIND_OWNER'; stepId: string; occurrence: number; channels: Channel[]; message?: string }
  | { kind: 'WELLBEING_CHECK'; stepId: string; contactIds: string[]; channels: Channel[]; script?: string; requireOtp: boolean }
  | { kind: 'REQUEST_CONFIRMATION'; stepId: string; from: string[] }
  | { kind: 'FIRE'; stepId: string }
  | { kind: 'STAND_DOWN'; because: string };

export interface Decision {
  status: TriggerStatus;
  actions: Action[];
  /** Plain language, shown verbatim in the owner's audit log. */
  reason: string;
  nextEvaluationAt: Millis | null;
  /** Which step the workflow is sitting on, for the owner's timeline. */
  currentStepId: string | null;
}

const STATUS_FOR: Record<Step['kind'], TriggerStatus> = {
  REMIND_OWNER: 'REMINDING',
  WAIT: 'REMINDING',
  WELLBEING_CHECK: 'WELLBEING_CHECK',
  REQUIRE_CONFIRMATION: 'AWAITING_CONFIRMATION',
  FIRE: 'DELIVERING',
};

const performedKey = (stepId: string, occurrence: number) => `${stepId}#${occurrence}`;

export function evaluate(workflow: Workflow, state: TriggerState, now: Millis): Decision {
  const inert = (reason: string): Decision => ({
    status: state.status, actions: [], reason, nextEvaluationAt: null, currentStepId: null,
  });

  if (TERMINAL.has(state.status)) return inert('This trigger is finished.');
  if (state.status === 'DRAFT') return inert('Not armed yet.');

  /**
   * Delivery is idempotent HERE, in the pure core, not only in the worker that
   * carries it out. Without this the evaluator happily returns FIRE on every
   * subsequent tick, and the guarantee that a person's private life is sent
   * exactly once rests entirely on a caller remembering to write the status
   * back. That is too important to delegate to a convention.
   */
  const fireStep = workflow.steps.find((s) => s.kind === 'FIRE');
  if (fireStep && state.performed.some((x) => x.stepId === fireStep.id)) {
    return { ...inert('Already delivered.'), status: 'DELIVERED' };
  }

  if (state.status === 'PAUSED') {
    const until = state.pausedUntil;
    if (until == null || now < until) {
      return {
        status: 'PAUSED', actions: [], currentStepId: null,
        reason: 'Paused by the owner. Nothing is counting down.',
        nextEvaluationAt: until ?? null,
      };
    }
    // A pause expiring is a fresh start, not a resumption mid-ladder.
    return {
      status: 'ACTIVE',
      actions: [{ kind: 'STAND_DOWN', because: 'Pause expired; the countdown restarted.' }],
      reason: 'Pause expired. The clock restarts from today, not from where it left off.',
      nextEvaluationAt: now + workflow.checkInEveryDays * DAY,
      currentStepId: null,
    };
  }

  const p = plan(workflow, state.lastCheckInAt);

  /* ---- A living owner outranks everything the workflow says. ------------ */
  if (now < p.dueAt) {
    const wasRunning = state.status !== 'ACTIVE';
    return {
      status: 'ACTIVE',
      actions: wasRunning ? [{ kind: 'STAND_DOWN', because: 'Owner checked in.' }] : [],
      reason: wasRunning
        ? 'The owner checked in. Everything stands down.'
        : 'Owner is within their check-in window.',
      nextEvaluationAt: p.dueAt,
      currentStepId: null,
    };
  }

  /* ---- One person saying "they're alive" outranks the clock. ------------
   * Deliberately asymmetric with DECEASED, which has to satisfy whatever gate
   * the owner wrote. Being wrong about death is unrecoverable; being wrong
   * about life costs a delay.                                               */
  if (someoneSaysAlive(state)) {
    return {
      status: 'ACTIVE',
      actions: [{ kind: 'STAND_DOWN', because: 'Someone confirmed the owner is alive.' }],
      reason: 'Someone you trust told us you are alright. Everything stands down.',
      nextEvaluationAt: now + workflow.checkInEveryDays * DAY,
      currentStepId: null,
    };
  }

  /* ---- Walk the workflow. ---------------------------------------------- */
  const done = new Set(state.performed.map((x) => performedKey(x.stepId, x.occurrence)));
  const actions: Action[] = [];
  let current: PlannedStep | null = null;
  let blockedReason: string | null = null;
  let reachedFire = false;

  for (const planned of p.steps) {
    if (now < planned.startsAt) {
      current ??= planned;
      break;
    }

    const { step } = planned;

    if (step.kind === 'FIRE') {
      current = planned;
      reachedFire = true;
      break;
    }

    // Emit every occurrence that has come due and has not been carried out.
    // A worker that was down for a week owes all of them, each exactly once.
    for (const [occurrence, at] of planned.occurrences.entries()) {
      if (now < at || done.has(performedKey(step.id, occurrence))) continue;
      if (step.kind === 'REMIND_OWNER') {
        actions.push({
          kind: 'REMIND_OWNER', stepId: step.id, occurrence,
          channels: step.channels, message: step.message,
        });
      } else if (step.kind === 'WELLBEING_CHECK') {
        actions.push({
          kind: 'WELLBEING_CHECK', stepId: step.id, contactIds: step.contactIds,
          channels: step.channels, script: step.script, requireOtp: step.requireOtp ?? false,
        });
      } else if (step.kind === 'REQUIRE_CONFIRMATION') {
        actions.push({ kind: 'REQUEST_CONFIRMATION', stepId: step.id, from: step.from });
      }
    }

    // A confirmation gate can stop the workflow indefinitely.
    if (step.kind === 'REQUIRE_CONFIRMATION') {
      const verdicts = currentVerdicts(state, step.from);
      const confirmed = [...verdicts.values()].filter((a) => a.verdict === 'DECEASED').length;
      const satisfied = confirmed >= step.count;
      if (!satisfied) {
        if (now < planned.endsAt) {
          current = planned;
          blockedReason =
            `Waiting for ${step.count} ${step.count === 1 ? 'person' : 'people'} to confirm. ` +
            `${confirmed} so far. Nothing is sent until then.`;
          break;
        }
        if (step.onTimeout === 'HOLD') {
          current = planned;
          blockedReason =
            `Holding. You asked that nothing be delivered unless ${step.count} of the people you named confirm, ` +
            `and ${confirmed} have. Nothing will be sent until then.`;
          break;
        }
      }
    }

    if (now < planned.endsAt) {
      current = planned;
      break;
    }
  }

  if (blockedReason && current) {
    return {
      status: 'AWAITING_CONFIRMATION',
      actions,
      reason: blockedReason,
      nextEvaluationAt: now + 6 * HOUR,
      currentStepId: current.step.id,
    };
  }

  /* ---- Delivery. -------------------------------------------------------- */
  if (reachedFire || now >= p.fireAt) {
    /**
     * Never deliver with an attempt to reach the owner still unsent. If a rung
     * somehow remains unperformed at this point, send it and take one more tick
     * first. A late delivery is recoverable; a premature one is not.
     */
    const unsent = actions.filter((a) => a.kind === 'REMIND_OWNER');
    if (unsent.length > 0) {
      return {
        status: 'REMINDING',
        actions,
        reason: 'Holding: we had not finished trying to reach you. Trying once more before anything is sent.',
        nextEvaluationAt: now + HOUR,
        currentStepId: current?.step.id ?? null,
      };
    }
    if (now < p.fireAt) {
      // The hard 24h floor has not elapsed, whatever the workflow says.
      return {
        status: 'REMINDING', actions,
        reason: 'Every step is done, but nothing is delivered within 24 hours of a check-in.',
        nextEvaluationAt: p.fireAt,
        currentStepId: current?.step.id ?? null,
      };
    }
    return {
      status: 'DELIVERING',
      actions: [...actions, { kind: 'FIRE', stepId: current?.step.id ?? 'deliver' }],
      reason: 'Every step you wrote has run, every deadline has passed, and nobody stopped it.',
      nextEvaluationAt: null,
      currentStepId: current?.step.id ?? null,
    };
  }

  const status = current ? STATUS_FOR[current.step.kind] : 'REMINDING';
  const nextOccurrence = p.steps
    .flatMap((s) => [...s.occurrences, s.endsAt])
    .filter((t) => t > now)
    .sort((a, b) => a - b)[0];

  return {
    status,
    actions,
    reason: describeProgress(current, actions.length),
    nextEvaluationAt: nextOccurrence ?? p.fireAt,
    currentStepId: current?.step.id ?? null,
  };
}

function describeProgress(current: PlannedStep | null, sent: number): string {
  if (!current) return 'Working through the steps you set.';
  switch (current.step.kind) {
    case 'REMIND_OWNER':
      return sent > 0
        ? 'A check-in was missed. Trying to reach you; nobody else has been contacted.'
        : 'Waiting to hear from you. Nobody else has been contacted.';
    case 'WAIT':
      return 'Waiting, as you asked. Nobody else has been contacted.';
    case 'WELLBEING_CHECK':
      return 'Asking the people you named whether you are alright. They are told nothing else.';
    case 'REQUIRE_CONFIRMATION':
      return 'Waiting for the confirmations you required. Nothing has been sent.';
    case 'FIRE':
      return 'Ready to deliver.';
  }
}

/** Fold a decision's effects into the state. Pure; never mutates. */
export function applyDecision(state: TriggerState, decision: Decision, now: Millis): TriggerState {
  if (decision.actions.some((a) => a.kind === 'STAND_DOWN')) {
    return { ...state, status: 'ACTIVE', statusSince: now, lastCheckInAt: now, attestations: [], performed: [] };
  }

  const next: TriggerState =
    decision.status === state.status ? state : { ...state, status: decision.status, statusSince: now };

  const performed = decision.actions.flatMap((a) => {
    if (a.kind === 'REMIND_OWNER') {
      return a.channels.map((channel) => ({ stepId: a.stepId, occurrence: a.occurrence, at: now, channel }));
    }
    if (a.kind === 'WELLBEING_CHECK' || a.kind === 'REQUEST_CONFIRMATION' || a.kind === 'FIRE') {
      return [{ stepId: a.stepId, occurrence: 0, at: now }];
    }
    return [];
  });

  const delivered = decision.actions.some((a) => a.kind === 'FIRE');
  const withPerformed =
    performed.length > 0 ? { ...next, performed: [...next.performed, ...performed] } : next;

  // Applying a FIRE moves the trigger to a TERMINAL status in the same step that
  // records it, so there is no window in which a second tick could deliver again.
  return delivered ? { ...withPerformed, status: 'DELIVERED' as const, statusSince: now } : withPerformed;
}

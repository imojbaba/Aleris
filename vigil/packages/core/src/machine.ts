import { type Channel, type TriggerConfig, HARD_MINIMUM_TOTAL } from './config.js';
import { type Millis, days } from './time.js';

/**
 * The trigger state machine.
 *
 * Written as a PURE function of (config, state, now). No database, no clock, no
 * network. That is not stylistic preference: it is what makes the rules below
 * exhaustively testable, and this is the one piece of Vigil where "we think it
 * works" is not good enough. Every transition that can end in RELEASED is
 * covered by a test that tries to reach it wrongly.
 */

export type TriggerStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'GRACE'
  | 'ESCALATING'
  | 'VERIFICATION_HOLD'
  | 'RELEASING'
  | 'RELEASED'
  | 'PAUSED'
  | 'CANCELLED';

export type AttestationVerdict = 'ALIVE' | 'DECEASED' | 'UNSURE';

export interface Attestation {
  verifierId: string;
  verdict: AttestationVerdict;
  at: Millis;
}

export interface SentNudge {
  step: number;
  channel: Channel;
  at: Millis;
}

export interface TriggerState {
  status: TriggerStatus;
  /** The last time the owner proved they were here. */
  lastCheckInAt: Millis;
  /** When the current status began — drives hold timing. */
  statusSince: Millis;
  attestations: Attestation[];
  nudgesSent: SentNudge[];
  /** Set while PAUSED. `null` means paused indefinitely. */
  pausedUntil?: Millis | null;
}

export type Action =
  | { kind: 'NUDGE_OWNER'; step: number; channels: Channel[] }
  | { kind: 'ASK_VERIFIERS'; verifierIds: string[] }
  | { kind: 'NOTIFY_OWNER_FINAL_WARNING' }
  | { kind: 'RELEASE' }
  | { kind: 'RECORD_STAND_DOWN'; because: string };

export interface Decision {
  status: TriggerStatus;
  actions: Action[];
  /** Plain-language explanation, surfaced in the owner's audit log verbatim. */
  reason: string;
  /** When this trigger next needs looking at. `null` = nothing scheduled. */
  nextEvaluationAt: Millis | null;
}

export interface Milestones {
  dueAt: Millis;
  graceEndsAt: Millis;
  escalationEndsAt: Millis;
  holdEndsAt: Millis;
  /** The earliest instant release is permitted, floor included. */
  earliestReleaseAt: Millis;
}

export function milestones(config: TriggerConfig, lastCheckInAt: Millis): Milestones {
  const dueAt = lastCheckInAt + days(config.checkInIntervalDays);
  const graceEndsAt = dueAt + days(config.graceDays);
  const lastRung = config.escalation.reduce((m, s) => Math.max(m, s.afterDays), 0);
  const escalationEndsAt = graceEndsAt + days(lastRung);
  const holdEndsAt = escalationEndsAt + days(config.verification.holdDays);
  return {
    dueAt,
    graceEndsAt,
    escalationEndsAt,
    holdEndsAt,
    // The floor applies to the ELAPSED time since the owner was last seen, not
    // to the configured total — so a config edited mid-countdown cannot be used
    // to shorten an in-flight fuse below the hard minimum.
    earliestReleaseAt: Math.max(holdEndsAt, lastCheckInAt + HARD_MINIMUM_TOTAL),
  };
}

/** Escalation rungs whose time has come but which we have not yet sent. */
function pendingRungs(config: TriggerConfig, state: TriggerState, m: Milestones, now: Millis) {
  return config.escalation
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => now >= m.graceEndsAt + days(step.afterDays))
    .filter(({ index }) => !state.nudgesSent.some((n) => n.step === index));
}

function tally(state: TriggerState, config: TriggerConfig) {
  const known = new Set(config.verification.verifierIds);
  // Only attestations recorded AFTER the owner last checked in count. A "he's
  // fine" from eighteen months ago says nothing about today.
  const current = state.attestations.filter(
    (a) => known.has(a.verifierId) && a.at >= state.lastCheckInAt,
  );
  const latestByVerifier = new Map<string, Attestation>();
  for (const a of current) {
    const prev = latestByVerifier.get(a.verifierId);
    if (!prev || a.at > prev.at) latestByVerifier.set(a.verifierId, a);
  }
  const verdicts = [...latestByVerifier.values()];
  return {
    alive: verdicts.filter((a) => a.verdict === 'ALIVE').length,
    deceased: verdicts.filter((a) => a.verdict === 'DECEASED').length,
  };
}

const TERMINAL: ReadonlySet<TriggerStatus> = new Set(['RELEASED', 'CANCELLED']);

export function evaluate(config: TriggerConfig, state: TriggerState, now: Millis): Decision {
  const m = milestones(config, state.lastCheckInAt);

  if (TERMINAL.has(state.status)) {
    return { status: state.status, actions: [], reason: 'Trigger is finished.', nextEvaluationAt: null };
  }

  if (state.status === 'DRAFT') {
    return { status: 'DRAFT', actions: [], reason: 'Not armed yet.', nextEvaluationAt: null };
  }

  if (state.status === 'PAUSED') {
    const until = state.pausedUntil;
    if (until == null || now < until) {
      return {
        status: 'PAUSED',
        actions: [],
        reason: 'Paused by the owner. Nothing is counting down.',
        nextEvaluationAt: until ?? null,
      };
    }
    // A pause expiring is a fresh start, not a resumption mid-countdown.
    return {
      status: 'ACTIVE',
      actions: [{ kind: 'RECORD_STAND_DOWN', because: 'Pause expired; countdown restarted.' }],
      reason: 'Pause expired. The clock restarts from today, not from where it left off.',
      nextEvaluationAt: now + days(config.checkInIntervalDays),
    };
  }

  /* ---- Rule 1: a living owner outranks everything. ---------------------- */
  if (now < m.dueAt) {
    const wasEscalating = state.status !== 'ACTIVE';
    return {
      status: 'ACTIVE',
      actions: wasEscalating
        ? [{ kind: 'RECORD_STAND_DOWN', because: 'Owner checked in.' }]
        : [],
      reason: wasEscalating
        ? 'The owner checked in. Everything stands down.'
        : 'Owner is within their check-in window.',
      nextEvaluationAt: m.dueAt,
    };
  }

  /* ---- Rule 2: one person saying "they are fine" outranks the clock. ----
   * A single ALIVE attestation halts the whole cascade. This is deliberately
   * asymmetric with DECEASED, which needs `requiredAttestations`. Being wrong
   * about death is unrecoverable; being wrong about life costs a delay.       */
  const votes = tally(state, config);
  if (votes.alive > 0) {
    return {
      status: 'ACTIVE',
      actions: [{ kind: 'RECORD_STAND_DOWN', because: 'A verifier confirmed the owner is alive.' }],
      reason: 'Someone you trust told us you are alright. Everything stands down.',
      nextEvaluationAt: now + days(config.checkInIntervalDays),
    };
  }

  /* ---- Grace: missed, but we only bother the owner. --------------------- */
  if (now < m.graceEndsAt) {
    return {
      status: 'GRACE',
      actions: [],
      reason: 'A check-in was missed. Reminding the owner; nobody else has been contacted.',
      nextEvaluationAt: m.graceEndsAt,
    };
  }

  /* ---- Escalation: work the ladder, then bring in the verifiers. -------- */
  if (now < m.escalationEndsAt) {
    const due = pendingRungs(config, state, m, now);
    const actions: Action[] = due.map(({ step, index }) => ({
      kind: 'NUDGE_OWNER' as const,
      step: index,
      channels: step.channels,
    }));
    if (due.length > 0 && config.verification.verifierIds.length > 0) {
      const alreadyAsked = state.attestations.length > 0;
      if (!alreadyAsked) actions.push({ kind: 'ASK_VERIFIERS', verifierIds: config.verification.verifierIds });
    }
    const nextRung = config.escalation
      .map((s) => m.graceEndsAt + days(s.afterDays))
      .filter((t) => t > now)
      .sort((a, b) => a - b)[0];
    return {
      status: 'ESCALATING',
      actions,
      reason: 'The owner has not responded. Escalating across every channel they gave us.',
      nextEvaluationAt: nextRung ?? m.escalationEndsAt,
    };
  }

  /* ---- Hold: the last quiet stretch before anything becomes irreversible. */
  if (now < m.earliestReleaseAt) {
    const actions: Action[] = [];

    /**
     * Flush any escalation rung that came due exactly as the hold opened.
     *
     * The final rung is the loudest one — the voice call, the WhatsApp message
     * to the number they actually read. An earlier version of this function
     * moved straight to the hold at `escalationEndsAt` and silently dropped it,
     * meaning the single most likely message to reach a living person was the
     * one we never sent. The hold IS the response window for that last attempt.
     */
    for (const { step, index } of pendingRungs(config, state, m, now)) {
      actions.push({ kind: 'NUDGE_OWNER', step: index, channels: step.channels });
    }

    if (state.status !== 'VERIFICATION_HOLD') {
      actions.push({ kind: 'NOTIFY_OWNER_FINAL_WARNING' });
      if (config.verification.verifierIds.length > 0 && state.attestations.length === 0) {
        actions.push({ kind: 'ASK_VERIFIERS', verifierIds: config.verification.verifierIds });
      }
    }
    return {
      status: 'VERIFICATION_HOLD',
      actions,
      reason: 'Final hold. One check-in, or one person saying you are alright, still stops this.',
      nextEvaluationAt: m.earliestReleaseAt,
    };
  }

  /* ---- Release. ---------------------------------------------------------- */
  const { policy, requiredAttestations } = config.verification;
  const confirmed = votes.deceased >= requiredAttestations;

  if (!confirmed && policy === 'REQUIRE_ATTESTATION') {
    return {
      status: 'VERIFICATION_HOLD',
      actions: [{ kind: 'ASK_VERIFIERS', verifierIds: config.verification.verifierIds }],
      reason:
        `Holding. This trigger releases only when ${requiredAttestations} of the people you named confirm, ` +
        `and ${votes.deceased} have. Nothing will be sent until then.`,
      nextEvaluationAt: now + days(1),
    };
  }

  const unsent = pendingRungs(config, state, m, now);
  if (unsent.length > 0) {
    // Belt and braces: if a rung somehow remains unsent at the release
    // boundary, send it and take one more tick before doing the irreversible
    // thing. A delayed delivery is recoverable; a premature one is not.
    return {
      status: 'VERIFICATION_HOLD',
      actions: unsent.map(({ step, index }) => ({
        kind: 'NUDGE_OWNER' as const,
        step: index,
        channels: step.channels,
      })),
      reason: 'Holding: an escalation attempt had not yet been sent. Trying the owner once more first.',
      nextEvaluationAt: now + days(1),
    };
  }

  return {
    status: 'RELEASING',
    actions: [{ kind: 'RELEASE' }],
    reason: confirmed
      ? 'Confirmed by the people you named, after the full waiting period.'
      : 'Every channel was tried, every deadline passed, and nobody stopped it.',
    nextEvaluationAt: null,
  };
}

/* -------------------------------------------------------------------------- *
 * Owner actions. Each returns a new state; none of them mutate.
 * -------------------------------------------------------------------------- */

export function checkIn(state: TriggerState, now: Millis): TriggerState {
  if (TERMINAL.has(state.status)) return state;
  return { ...state, status: 'ACTIVE', lastCheckInAt: now, statusSince: now, attestations: [], nudgesSent: [] };
}

export function pause(state: TriggerState, now: Millis, until: Millis | null = null): TriggerState {
  if (TERMINAL.has(state.status)) return state;
  return { ...state, status: 'PAUSED', statusSince: now, pausedUntil: until };
}

export function resume(state: TriggerState, now: Millis): TriggerState {
  if (state.status !== 'PAUSED') return state;
  return { ...state, status: 'ACTIVE', lastCheckInAt: now, statusSince: now, pausedUntil: null };
}

export function cancel(state: TriggerState, now: Millis): TriggerState {
  if (state.status === 'RELEASED') return state;
  return { ...state, status: 'CANCELLED', statusSince: now };
}

export function recordAttestation(state: TriggerState, a: Attestation): TriggerState {
  return { ...state, attestations: [...state.attestations, a] };
}

export function recordNudges(state: TriggerState, sent: SentNudge[]): TriggerState {
  return { ...state, nudgesSent: [...state.nudgesSent, ...sent] };
}

export function applyDecision(state: TriggerState, decision: Decision, now: Millis): TriggerState {
  const next: TriggerState =
    decision.status === state.status ? state : { ...state, status: decision.status, statusSince: now };

  // A stand-down resets the countdown, so a recovered owner does not resume
  // three rungs up the ladder the next time they are a day late.
  if (decision.actions.some((a) => a.kind === 'RECORD_STAND_DOWN')) {
    return { ...next, lastCheckInAt: now, attestations: [], nudgesSent: [] };
  }

  const nudges = decision.actions
    .filter((a): a is Extract<Action, { kind: 'NUDGE_OWNER' }> => a.kind === 'NUDGE_OWNER')
    .flatMap((a) => a.channels.map((channel) => ({ step: a.step, channel, at: now })));

  return nudges.length > 0 ? { ...next, nudgesSent: [...next.nudgesSent, ...nudges] } : next;
}

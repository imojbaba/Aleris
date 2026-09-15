import type { Channel } from './channels.js';
import type { Millis } from './time.js';

export type TriggerStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'REMINDING'
  | 'WELLBEING_CHECK'
  | 'AWAITING_CONFIRMATION'
  | 'DELIVERING'
  | 'DELIVERED'
  | 'PAUSED'
  | 'CANCELLED';

export type AttestationVerdict = 'ALIVE' | 'DECEASED' | 'UNSURE';

export interface Attestation {
  contactId: string;
  verdict: AttestationVerdict;
  at: Millis;
  /** Whether this person proved control of the address we wrote to. */
  otpVerified?: boolean;
}

/** One occurrence of one step, actually carried out. */
export interface PerformedStep {
  stepId: string;
  /** Repeat index within the step. 0 for steps that fire once. */
  occurrence: number;
  at: Millis;
  channel?: Channel;
}

export interface TriggerState {
  status: TriggerStatus;
  /** The last time the owner proved they were here. */
  lastCheckInAt: Millis;
  statusSince: Millis;
  attestations: Attestation[];
  performed: PerformedStep[];
  /** Set while PAUSED. `null` means paused indefinitely. */
  pausedUntil?: Millis | null;
}

export const TERMINAL: ReadonlySet<TriggerStatus> = new Set(['DELIVERED', 'CANCELLED']);

export function freshState(now: Millis, status: TriggerStatus = 'ACTIVE'): TriggerState {
  return { status, lastCheckInAt: now, statusSince: now, attestations: [], performed: [] };
}

/* ----------------------------- owner actions ----------------------------- */

/**
 * Checking in resets everything, including the record of what has already been
 * sent. A person who was three steps into the ladder and then surfaced should
 * not resume from step three the next time they are a day late.
 */
export function checkIn(state: TriggerState, now: Millis): TriggerState {
  if (TERMINAL.has(state.status)) return state;
  return { ...state, status: 'ACTIVE', lastCheckInAt: now, statusSince: now, attestations: [], performed: [] };
}

export function pause(state: TriggerState, now: Millis, until: Millis | null = null): TriggerState {
  if (TERMINAL.has(state.status)) return state;
  return { ...state, status: 'PAUSED', statusSince: now, pausedUntil: until };
}

export function resume(state: TriggerState, now: Millis): TriggerState {
  if (state.status !== 'PAUSED') return state;
  return { ...state, status: 'ACTIVE', lastCheckInAt: now, statusSince: now, pausedUntil: null, performed: [], attestations: [] };
}

export function cancel(state: TriggerState, now: Millis): TriggerState {
  if (state.status === 'DELIVERED') return state;
  return { ...state, status: 'CANCELLED', statusSince: now };
}

export function recordAttestation(state: TriggerState, a: Attestation): TriggerState {
  return { ...state, attestations: [...state.attestations, a] };
}

/**
 * Latest verdict per person, counting only answers given since the owner was
 * last seen. A "he's fine" from eighteen months ago says nothing about today.
 */
export function currentVerdicts(state: TriggerState, among?: string[]): Map<string, Attestation> {
  const allowed = among ? new Set(among) : null;
  const latest = new Map<string, Attestation>();
  for (const a of state.attestations) {
    if (a.at < state.lastCheckInAt) continue;
    if (allowed && !allowed.has(a.contactId)) continue;
    const prev = latest.get(a.contactId);
    if (!prev || a.at > prev.at) latest.set(a.contactId, a);
  }
  return latest;
}

export function someoneSaysAlive(state: TriggerState): boolean {
  return [...currentVerdicts(state).values()].some((a) => a.verdict === 'ALIVE');
}

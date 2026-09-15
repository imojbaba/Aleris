import { DAY, HOUR, type Millis, days } from './time.js';

/**
 * Trigger configuration — the user's answer to "how will you know I'm gone?"
 *
 * The defaults and the validation rules in this file are the most consequential
 * product decisions in Vigil. A trigger that fires late is an inconvenience; a
 * trigger that fires EARLY sends a living person's bank credentials, their
 * unsent letters, and possibly a goodbye to their children, to their family.
 * There is no undo. Every rule below exists to make that outcome require a
 * conspiracy of failures rather than a single one.
 */

export type Channel = 'PUSH' | 'EMAIL' | 'SMS' | 'WHATSAPP' | 'VOICE';

export interface EscalationStep {
  /** Days after the grace period ends. */
  afterDays: number;
  /** Every channel tried at this rung. */
  channels: Channel[];
}

export type VerificationPolicy =
  /** Nothing releases unless enough named humans actively confirm. Safest; can deadlock. */
  | 'REQUIRE_ATTESTATION'
  /** If verifiers stay silent through the whole hold, silence is treated as confirmation. */
  | 'SILENCE_CONFIRMS';

export interface VerificationConfig {
  verifierIds: string[];
  /** How many verifiers must confirm before release. */
  requiredAttestations: number;
  policy: VerificationPolicy;
  /** Final quiet period after escalation ends, before anything is sent. */
  holdDays: number;
}

export interface TriggerConfig {
  /** How often the user promises to check in. */
  checkInIntervalDays: number;
  /** Forgiveness window after a missed check-in, before anyone else is contacted. */
  graceDays: number;
  escalation: EscalationStep[];
  verification: VerificationConfig;
  /**
   * Explicit acknowledgement required for fuses shorter than
   * {@link SAFE_MINIMUM_TOTAL}. Not a dark pattern in reverse — a short fuse is
   * a legitimate need (a journalist filing from somewhere dangerous, a solo
   * expedition) and we support it. We just refuse to let someone arrive there
   * by dragging a slider without noticing.
   */
  acknowledgedRapidRelease?: boolean;
}

/**
 * Below this, a trigger is judged "rapid" and needs explicit acknowledgement.
 * Chosen to comfortably clear the things that routinely take people offline
 * without anything being wrong: a long-haul trip, a silent retreat, a hospital
 * stay, a phone in the sea on day one of a fortnight's holiday.
 */
export const SAFE_MINIMUM_TOTAL: Millis = days(21);

/** Absolute floor. Nothing, acknowledged or not, releases faster than this. */
export const HARD_MINIMUM_TOTAL: Millis = 24 * HOUR;

/**
 * The default we ship. Roughly: check in monthly, two weeks of forgiveness,
 * three escalating rungs over a fortnight, then a week of silence before
 * anything moves. Total: about two months from the last "I'm here".
 */
export const DEFAULT_CONFIG: TriggerConfig = {
  checkInIntervalDays: 30,
  graceDays: 14,
  escalation: [
    { afterDays: 0, channels: ['PUSH', 'EMAIL'] },
    { afterDays: 5, channels: ['EMAIL', 'SMS'] },
    { afterDays: 12, channels: ['SMS', 'WHATSAPP', 'VOICE'] },
  ],
  verification: {
    verifierIds: [],
    // Zero, not one: out of the box nobody has been named yet, and a default
    // that demands a confirmation nobody can give is a trigger that never fires.
    // Adding a confirmer in the app raises this.
    requiredAttestations: 0,
    policy: 'SILENCE_CONFIRMS',
    holdDays: 7,
  },
};

export interface ConfigIssue {
  severity: 'error' | 'warning';
  field: string;
  message: string;
}

/** Total time from the last check-in to the earliest possible release. */
export function totalFuseLength(config: TriggerConfig): Millis {
  const lastRung = config.escalation.reduce((max, s) => Math.max(max, s.afterDays), 0);
  return days(
    config.checkInIntervalDays + config.graceDays + lastRung + config.verification.holdDays,
  );
}

export function validateConfig(config: TriggerConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const err = (field: string, message: string) =>
    issues.push({ severity: 'error', field, message });
  const warn = (field: string, message: string) =>
    issues.push({ severity: 'warning', field, message });

  if (config.checkInIntervalDays <= 0) err('checkInIntervalDays', 'Check-in interval must be positive.');
  if (config.graceDays < 0) err('graceDays', 'Grace period cannot be negative.');
  if (config.verification.holdDays < 0) err('verification.holdDays', 'Hold cannot be negative.');

  if (config.escalation.length === 0) {
    err('escalation', 'At least one escalation step is required — we will not release in silence.');
  }

  const steps = [...config.escalation].sort((a, b) => a.afterDays - b.afterDays);
  for (const [i, step] of steps.entries()) {
    if (step.channels.length === 0) err(`escalation[${i}]`, 'An escalation step needs at least one channel.');
    if (step.afterDays < 0) err(`escalation[${i}].afterDays`, 'Escalation offsets cannot be negative.');
  }

  /**
   * Two independent channels, minimum. One channel is one point of failure:
   * a lapsed phone number, a mail provider silently binning us as spam, a lost
   * handset. We will not conclude someone has died from a single unanswered
   * medium.
   */
  const distinctChannels = new Set(config.escalation.flatMap((s) => s.channels));
  if (distinctChannels.size < 2) {
    err(
      'escalation',
      'Use at least two different channels. A trigger that only ever tries email will fire on a bounced mailbox.',
    );
  }

  const total = totalFuseLength(config);
  if (total < HARD_MINIMUM_TOTAL) {
    err('checkInIntervalDays', 'A trigger cannot be set to release in under 24 hours.');
  } else if (total < SAFE_MINIMUM_TOTAL && !config.acknowledgedRapidRelease) {
    err(
      'acknowledgedRapidRelease',
      'This releases in under three weeks of silence. That is shorter than a long holiday — confirm you meant it.',
    );
  }

  const { verifierIds, requiredAttestations, policy } = config.verification;
  if (requiredAttestations < 0) err('verification.requiredAttestations', 'Cannot be negative.');
  if (requiredAttestations > verifierIds.length) {
    const shortfall =
      `You asked for ${requiredAttestations} confirmation${requiredAttestations === 1 ? '' : 's'} ` +
      `but have named ${verifierIds.length} ${verifierIds.length === 1 ? 'person' : 'people'}.`;
    if (policy === 'REQUIRE_ATTESTATION') {
      // Hard error: under this policy the shortfall makes release unreachable.
      err('verification.requiredAttestations', `${shortfall} This trigger could never fire.`);
    } else {
      // Under SILENCE_CONFIRMS the trigger still fires on silence, so this is a
      // mismatch between what the user asked for and what will happen — worth
      // saying out loud, not worth blocking.
      warn(
        'verification.requiredAttestations',
        `${shortfall} It will still release after the waiting period, on silence alone.`,
      );
    }
  }
  if (policy === 'REQUIRE_ATTESTATION' && verifierIds.length === 0) {
    err('verification.verifierIds', 'Requiring confirmation with nobody to confirm means nothing is ever delivered.');
  }

  if (verifierIds.length === 0) {
    warn(
      'verification.verifierIds',
      'Nobody is checking on you. Naming even one person — who only ever confirms whether you are alright — is the single biggest thing you can do to prevent a false alarm.',
    );
  }
  if (policy === 'REQUIRE_ATTESTATION' && verifierIds.length < requiredAttestations + 1) {
    warn(
      'verification.verifierIds',
      'With no spare confirmer, one unreachable person permanently blocks delivery. Name one more than you need.',
    );
  }
  if (total > days(365 * 2)) {
    warn('checkInIntervalDays', 'Over two years of silence before anything happens. Is that what you want?');
  }
  if (config.graceDays === 0) {
    warn('graceDays', 'With no grace period, one missed reminder starts contacting people immediately.');
  }

  return issues;
}

export const isValid = (config: TriggerConfig): boolean =>
  !validateConfig(config).some((i) => i.severity === 'error');

/** Presets offered in onboarding, so nobody has to design a fuse from nothing. */
export const PRESETS: { id: string; name: string; blurb: string; config: TriggerConfig }[] = [
  {
    id: 'unhurried',
    name: 'Unhurried',
    blurb: 'Check in every three months. Nothing moves for the better part of half a year.',
    config: {
      ...DEFAULT_CONFIG,
      checkInIntervalDays: 90,
      graceDays: 30,
      verification: { ...DEFAULT_CONFIG.verification, holdDays: 14 },
    },
  },
  {
    id: 'steady',
    name: 'Steady',
    blurb: 'A monthly check-in. About two months of silence before anything is sent.',
    config: DEFAULT_CONFIG,
  },
  {
    id: 'attentive',
    name: 'Attentive',
    blurb: 'Weekly. For people with a reason to be watched more closely.',
    config: {
      ...DEFAULT_CONFIG,
      checkInIntervalDays: 7,
      graceDays: 7,
      escalation: [
        { afterDays: 0, channels: ['PUSH', 'EMAIL'] },
        { afterDays: 2, channels: ['SMS', 'WHATSAPP'] },
        { afterDays: 5, channels: ['VOICE', 'SMS'] },
      ],
      verification: { ...DEFAULT_CONFIG.verification, holdDays: 5 },
    },
  },
];

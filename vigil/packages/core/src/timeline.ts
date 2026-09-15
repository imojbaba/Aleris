import { type TriggerConfig, totalFuseLength } from './config.js';
import { milestones } from './machine.js';
import { type Millis, days, humaniseDuration } from './time.js';

/**
 * A plain-language forecast of what this trigger will do, and when.
 *
 * This exists because of a specific failure mode. People configure a dead man's
 * switch once, in a reflective mood, and then never think about it again — and
 * the most common way they get hurt is discovering, years later, that it did
 * something other than what they pictured. So before arming, we show the whole
 * cascade as a dated list: who gets contacted, in what order, and the exact day
 * their letters would go out. No sliders-and-hope.
 */

export type TimelineKind =
  | 'CHECK_IN_DUE'
  | 'GRACE_ENDS'
  | 'ESCALATION'
  | 'VERIFIERS_ASKED'
  | 'FINAL_HOLD'
  | 'RELEASE';

export interface TimelineEvent {
  at: Millis;
  kind: TimelineKind;
  /** Short label for the timeline rail. */
  title: string;
  /** The sentence shown under it. Second person, present tense, no jargon. */
  detail: string;
  /** Whether this step is visible to anyone other than the owner. */
  involvesOthers: boolean;
}

export function previewTimeline(config: TriggerConfig, lastCheckInAt: Millis): TimelineEvent[] {
  const m = milestones(config, lastCheckInAt);
  const events: TimelineEvent[] = [
    {
      at: m.dueAt,
      kind: 'CHECK_IN_DUE',
      title: 'Check-in due',
      detail: `We ask if you are there. Opening the app is enough. Nothing has happened yet, and nobody has been told anything.`,
      involvesOthers: false,
    },
    {
      at: m.graceEndsAt,
      kind: 'GRACE_ENDS',
      title: 'Grace period ends',
      detail: `${humaniseDuration(days(config.graceDays))} of quiet reminders, to you alone. Still nobody else involved.`,
      involvesOthers: false,
    },
  ];

  const ordered = [...config.escalation].sort((a, b) => a.afterDays - b.afterDays);
  for (const [i, step] of ordered.entries()) {
    events.push({
      at: m.graceEndsAt + days(step.afterDays),
      kind: 'ESCALATION',
      title: `Escalation ${i + 1} of ${ordered.length}`,
      detail: `We try ${listChannels(step.channels)}.`,
      involvesOthers: false,
    });
  }

  if (config.verification.verifierIds.length > 0) {
    events.push({
      at: m.graceEndsAt,
      kind: 'VERIFIERS_ASKED',
      title: 'Your confirmers are asked',
      detail:
        `${config.verification.verifierIds.length} ${config.verification.verifierIds.length === 1 ? 'person is' : 'people are'} ` +
        `asked one question: is everything alright? They are never shown what is in your vaults. ` +
        `Any one of them saying you are fine stops all of this immediately.`,
      involvesOthers: true,
    });
  }

  events.push({
    at: m.escalationEndsAt,
    kind: 'FINAL_HOLD',
    title: 'Final hold',
    detail: `${humaniseDuration(m.earliestReleaseAt - m.escalationEndsAt)} of nothing. A last chance for you, or anyone who knows you, to stop this.`,
    involvesOthers: true,
  });

  events.push({
    at: m.earliestReleaseAt,
    kind: 'RELEASE',
    title: 'Your vaults are delivered',
    detail: `The people you chose are contacted and given what you left them. This cannot be undone.`,
    involvesOthers: true,
  });

  return events.sort((a, b) => a.at - b.at || rank(a.kind) - rank(b.kind));
}

const ORDER: TimelineKind[] = [
  'CHECK_IN_DUE', 'GRACE_ENDS', 'VERIFIERS_ASKED', 'ESCALATION', 'FINAL_HOLD', 'RELEASE',
];
const rank = (k: TimelineKind) => ORDER.indexOf(k);

const CHANNEL_WORDS: Record<string, string> = {
  PUSH: 'a notification on your phone',
  EMAIL: 'email',
  SMS: 'text message',
  WHATSAPP: 'WhatsApp',
  VOICE: 'an automated phone call',
};

function listChannels(channels: string[]): string {
  const words = channels.map((c) => CHANNEL_WORDS[c] ?? c.toLowerCase());
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** One-line summary for the trigger card: "About 2 months of silence." */
export function summariseFuse(config: TriggerConfig): string {
  return `About ${humaniseDuration(totalFuseLength(config))} of silence before anything is sent.`;
}

import { listChannels } from './channels.js';
import { type Millis, humaniseDuration, HOUR } from './time.js';
import { type Workflow, plan } from './workflow.js';

/**
 * The workflow as a dated forecast.
 *
 * Shown before a trigger can be armed, and never behind a "details" tap. The
 * specific harm this prevents: someone sets this up in one reflective evening,
 * pictures roughly what it does, and discovers years later that it did something
 * else. A list of sliders is bad at conveying consequence. A dated list saying
 * "on this day, this person is contacted" is not.
 *
 * `involvesOthers` is the load-bearing field — it marks the exact point at
 * which this stops being private.
 */

export type TimelineKind =
  | 'CHECK_IN_DUE' | 'REMIND_OWNER' | 'WAIT' | 'WELLBEING_CHECK' | 'CONFIRMATION' | 'DELIVER';

export interface TimelineEvent {
  at: Millis;
  kind: TimelineKind;
  stepId: string;
  title: string;
  detail: string;
  involvesOthers: boolean;
}

export function projectTimeline(
  workflow: Workflow,
  lastCheckInAt: Millis,
  contactNames: Record<string, string> = {},
): TimelineEvent[] {
  const p = plan(workflow, lastCheckInAt);
  const events: TimelineEvent[] = [
    {
      at: p.dueAt,
      kind: 'CHECK_IN_DUE',
      stepId: 'check-in',
      title: 'Check-in due',
      detail:
        'We ask if you are there. Opening the app is enough. Nothing has happened yet, and nobody has been told anything.',
      involvesOthers: false,
    },
  ];

  const name = (id: string) => contactNames[id] ?? 'someone you named';
  const nameList = (ids: string[]) => {
    const names = ids.map(name);
    if (names.length === 0) return 'the people you name';
    if (names.length === 1) return names[0]!;
    return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  };

  for (const planned of p.steps) {
    const { step } = planned;
    switch (step.kind) {
      case 'REMIND_OWNER':
        events.push({
          at: planned.startsAt, kind: 'REMIND_OWNER', stepId: step.id,
          title: step.label ?? `We try you on ${listChannels(step.channels)}`,
          detail:
            step.times === 1
              ? `One attempt, on ${listChannels(step.channels)}. Only you hear from us.`
              : `${step.times} attempts on ${listChannels(step.channels)}, ${humaniseDuration(step.everyHours * HOUR)} apart. Only you hear from us.`,
          involvesOthers: false,
        });
        break;
      case 'WAIT':
        events.push({
          at: planned.startsAt, kind: 'WAIT', stepId: step.id,
          title: step.label ?? 'Nothing happens',
          detail: `${humaniseDuration(step.hours * HOUR)} of quiet. A chance for you to surface.`,
          involvesOthers: false,
        });
        break;
      case 'WELLBEING_CHECK':
        events.push({
          at: planned.startsAt, kind: 'WELLBEING_CHECK', stepId: step.id,
          title: step.label ?? `${nameList(step.contactIds)} ${step.contactIds.length === 1 ? 'is' : 'are'} asked if you're alright`,
          detail:
            `We reach out on ${listChannels(step.channels)} with one question. ` +
            `They are never shown what is in your vaults, told that a vault exists, or told who else was contacted. ` +
            `Any one of them saying you are fine stops all of this immediately.`,
          involvesOthers: true,
        });
        break;
      case 'REQUIRE_CONFIRMATION':
        events.push({
          at: planned.startsAt, kind: 'CONFIRMATION', stepId: step.id,
          title: step.label ?? `${step.count} ${step.count === 1 ? 'person has' : 'people have'} to confirm`,
          detail:
            step.onTimeout === 'HOLD'
              ? `Nothing is delivered unless ${step.count} of ${nameList(step.from)} confirm. If they never answer, nothing is ever sent.`
              : `We wait ${humaniseDuration(step.timeoutHours * HOUR)} for ${step.count} of ${nameList(step.from)} to confirm. If nobody answers, this continues anyway.`,
          involvesOthers: true,
        });
        break;
      case 'FIRE':
        break;
    }
  }

  events.push({
    at: p.fireAt, kind: 'DELIVER', stepId: 'deliver',
    title: 'What you left is delivered',
    detail:
      'The people you chose are contacted and given what you left them. This cannot be undone.',
    involvesOthers: true,
  });

  return events.sort((a, b) => a.at - b.at);
}

import type { Workflow } from './workflow.js';

/**
 * Starting points, not settings.
 *
 * Every one of these is an ordinary workflow the user can then open up and take
 * apart — add a step, change a channel, write their own script for the voice
 * call. Nobody should have to assemble a cascade from an empty screen, and
 * nobody should be stuck with ours.
 */

export interface WorkflowTemplate {
  id: string;
  name: string;
  blurb: string;
  workflow: Workflow;
}

/** The shipped default: monthly, with a layered ladder over about two months. */
export const STEADY: Workflow = {
  checkInEveryDays: 30,
  steps: [
    {
      id: 'email-run',
      kind: 'REMIND_OWNER',
      label: 'Email me three days running',
      channels: ['EMAIL', 'PUSH'],
      times: 3,
      everyHours: 24,
    },
    {
      id: 'whatsapp',
      kind: 'REMIND_OWNER',
      label: 'Then WhatsApp me',
      channels: ['WHATSAPP'],
      times: 1,
      everyHours: 24,
    },
    { id: 'pause-1', kind: 'WAIT', label: 'Give it a day', hours: 24 },
    {
      id: 'call',
      kind: 'REMIND_OWNER',
      label: 'Then actually ring me',
      channels: ['VOICE', 'SMS'],
      times: 2,
      everyHours: 48,
    },
    {
      id: 'ask-people',
      kind: 'WELLBEING_CHECK',
      label: 'Ask the people who would know',
      contactIds: [],
      channels: ['EMAIL', 'WHATSAPP'],
      waitHours: 24 * 7,
      requireOtp: true,
    },
    { id: 'final-quiet', kind: 'WAIT', label: 'A last quiet week', hours: 24 * 7 },
    { id: 'deliver', kind: 'FIRE', label: 'Deliver what I left' },
  ],
};

export const UNHURRIED: Workflow = {
  checkInEveryDays: 90,
  steps: [
    { id: 'email-run', kind: 'REMIND_OWNER', channels: ['EMAIL', 'PUSH'], times: 4, everyHours: 24 * 3 },
    { id: 'texts', kind: 'REMIND_OWNER', channels: ['SMS', 'WHATSAPP'], times: 3, everyHours: 24 * 3 },
    { id: 'call', kind: 'REMIND_OWNER', channels: ['VOICE'], times: 2, everyHours: 24 * 4 },
    {
      id: 'ask-people', kind: 'WELLBEING_CHECK', contactIds: [],
      channels: ['EMAIL', 'SMS'], waitHours: 24 * 14, requireOtp: true,
    },
    { id: 'final-quiet', kind: 'WAIT', hours: 24 * 14 },
    { id: 'deliver', kind: 'FIRE' },
  ],
};

export const ATTENTIVE: Workflow = {
  checkInEveryDays: 7,
  steps: [
    { id: 'push-email', kind: 'REMIND_OWNER', channels: ['PUSH', 'EMAIL'], times: 2, everyHours: 24 },
    { id: 'texts', kind: 'REMIND_OWNER', channels: ['SMS', 'WHATSAPP'], times: 2, everyHours: 24 },
    { id: 'call', kind: 'REMIND_OWNER', channels: ['VOICE'], times: 2, everyHours: 24 },
    {
      id: 'ask-people', kind: 'WELLBEING_CHECK', contactIds: [],
      channels: ['SMS', 'EMAIL'], waitHours: 24 * 4, requireOtp: true,
    },
    // Four days, not three: at three the template totalled 19 days and tripped
    // the three-week acknowledgement. Shipping a template that silently carries
    // `acknowledgedRapidRelease` would defeat the point of asking.
    { id: 'final-quiet', kind: 'WAIT', hours: 24 * 4 },
    { id: 'deliver', kind: 'FIRE' },
  ],
};

/**
 * For someone with a specific, temporary reason to be watched closely — filing
 * from somewhere dangerous, a solo crossing, going in for surgery. Fires in
 * about four days, so it carries the rapid-release acknowledgement and leans
 * hard on a human confirming rather than on the clock.
 */
export const WATCHED: Workflow = {
  checkInEveryDays: 1,
  acknowledgedRapidRelease: true,
  steps: [
    { id: 'push-email', kind: 'REMIND_OWNER', channels: ['PUSH', 'EMAIL'], times: 3, everyHours: 4 },
    { id: 'texts', kind: 'REMIND_OWNER', channels: ['SMS', 'WHATSAPP'], times: 3, everyHours: 6 },
    { id: 'call', kind: 'REMIND_OWNER', channels: ['VOICE'], times: 2, everyHours: 6 },
    {
      id: 'ask-people', kind: 'WELLBEING_CHECK', contactIds: [],
      channels: ['VOICE', 'SMS'], waitHours: 24, requireOtp: true,
    },
    {
      id: 'confirm', kind: 'REQUIRE_CONFIRMATION',
      from: [], count: 1, timeoutHours: 48, onTimeout: 'PROCEED',
    },
    { id: 'final-quiet', kind: 'WAIT', hours: 24 },
    { id: 'deliver', kind: 'FIRE' },
  ],
};

export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'unhurried',
    name: 'Unhurried',
    blurb: 'Check in every three months. Nothing moves for the better part of half a year.',
    workflow: UNHURRIED,
  },
  {
    id: 'steady',
    name: 'Steady',
    blurb: 'Monthly. Emails, then WhatsApp, then an actual phone call, then the people who would know.',
    workflow: STEADY,
  },
  {
    id: 'attentive',
    name: 'Attentive',
    blurb: 'Weekly. For people with a reason to be watched more closely.',
    workflow: ATTENTIVE,
  },
  {
    id: 'watched',
    name: 'Watched',
    blurb: 'Daily, resolving in days rather than months. For a trip, a posting, an operation.',
    workflow: WATCHED,
  },
];

/**
 * Templates ship with empty contact lists — a template cannot know who the
 * user's people are. The app fills them in as recipients are added; this is the
 * helper that does it, kept here so the "a template is just a workflow" story
 * stays true.
 */
export function withContacts(workflow: Workflow, contactIds: string[]): Workflow {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => {
      if (step.kind === 'WELLBEING_CHECK') return { ...step, contactIds };
      if (step.kind === 'REQUIRE_CONFIRMATION') {
        return { ...step, from: contactIds, count: Math.min(step.count, contactIds.length) };
      }
      return step;
    }),
  };
}

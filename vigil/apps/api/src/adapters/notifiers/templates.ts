import type { Channel } from '@vigil/core';
import type { OutboundMessage } from '../../domain/ports.js';

/**
 * Every message Vigil sends, in one place.
 *
 * WhatsApp is the reason this file has the shape it does. WhatsApp splits
 * outbound messages in two:
 *
 *   • SESSION messages — free text, but ONLY within 24 hours of the recipient
 *     last writing to you.
 *   • TEMPLATE messages — pre-approved by Meta, sendable at any time. Required
 *     for anything business-initiated.
 *
 * Every single message Vigil sends is business-initiated after a long silence.
 * There is no 24-hour window, ever, by definition of the product. So on
 * WhatsApp every Vigil message MUST be a registered template, and the owner's
 * own wording can only travel inside a variable slot — it cannot be free text.
 *
 * That is a product constraint, not a plumbing detail: the app must present
 * WhatsApp scripts as "fills a blank in an approved message", not "write
 * whatever you like". Email and SMS have no such limit.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
}

/** What the Cloud API wants: a registered name plus ordered body variables. */
export interface RenderedWhatsApp {
  templateName: string;
  language: string;
  /** Positional — {{1}}, {{2}} … in the approved template body. */
  parameters: string[];
}

export type TemplateKind = OutboundMessage['template'];

/**
 * The approved-template catalogue.
 *
 * `body` is submitted to Meta verbatim for review and must match what is
 * registered, or sends fail with a template-mismatch error that is miserable to
 * debug. Keep this file and the Meta dashboard in lockstep; `pnpm whatsapp:templates`
 * prints them for copy-paste.
 *
 * All four are UTILITY category: they are follow-ups to a relationship the
 * recipient already has. Submitting them as MARKETING would be both wrong and
 * more expensive, and would let recipients mute them — which for a wellbeing
 * check is a safety problem, not a preference.
 */
export const WHATSAPP_TEMPLATES: Record<TemplateKind, { name: string; body: string; category: 'UTILITY' }> = {
  REMIND_OWNER: {
    name: 'vigil_check_in_reminder',
    category: 'UTILITY',
    body: 'Hello {{1}} — we have not heard from you. Opening Vigil is enough to check in. Nothing has been sent and nobody else has been contacted. {{2}}',
  },
  WELLBEING_CHECK: {
    name: 'vigil_wellbeing_check',
    category: 'UTILITY',
    body: 'Hello {{1}}. {{2}} uses Vigil and asked us to check with you if we could not reach them. We have not been able to. Is everything alright? Reply here, or answer at {{3}}',
  },
  CONFIRMATION_REQUEST: {
    name: 'vigil_confirmation_request',
    category: 'UTILITY',
    body: 'Hello {{1}}. {{2}} named you as someone who would know. We have tried to reach them for several weeks with no reply. Nothing is sent to anyone until you confirm: {{3}}',
  },
  DELIVERY: {
    name: 'vigil_delivery',
    category: 'UTILITY',
    body: '{{1}}, {{2}} left something for you and asked us to wait until they had been quiet for a while. There is no rush. Open when you are ready: {{3}}',
  },
};

const v = (m: OutboundMessage, key: string, fallback = '') => m.variables[key] ?? fallback;

export function renderEmail(m: OutboundMessage): RenderedEmail {
  switch (m.template) {
    case 'REMIND_OWNER':
      return {
        subject: 'Are you there?',
        text:
          `${v(m, 'name')} — we haven't heard from you.\n\n` +
          `${v(m, 'message') ? `${v(m, 'message')}\n\n` : ''}` +
          `Opening Vigil is enough. Nothing has been sent and nobody else has been contacted.\n\n` +
          `${v(m, 'checkInUrl')}\n\n— Vigil`,
      };
    case 'WELLBEING_CHECK':
      return {
        subject: `Is ${v(m, 'ownerName')} alright?`,
        text:
          (v(m, 'script').trim()
            ? `${v(m, 'script').trim()}\n\n`
            : `Hello ${v(m, 'contactName')},\n\n${v(m, 'ownerName')} uses Vigil and asked us to check ` +
              `with you if we ever couldn't reach them. We haven't been able to. Is everything alright?\n\n`) +
          `Answer here: ${v(m, 'answerUrl')}\n\n` +
          `That is the only question we are asking. There may be nothing wrong at all.\n— Vigil`,
      };
    case 'CONFIRMATION_REQUEST':
      return {
        subject: `A difficult question about ${v(m, 'ownerName')}`,
        text:
          `Hello ${v(m, 'contactName')},\n\n` +
          `${v(m, 'ownerName')} named you as someone who would know. We have tried to reach them ` +
          `many times over several weeks and have had no reply.\n\n` +
          `Nothing is sent to anyone until you confirm: ${v(m, 'answerUrl')}\n— Vigil`,
      };
    case 'DELIVERY':
      return {
        subject: `${v(m, 'ownerName')} left this for you`,
        text:
          `${v(m, 'recipientName')},\n\n` +
          `${v(m, 'ownerName')} left something for you, and asked us to wait until they had been ` +
          `quiet for a while before passing it on. We waited, and we tried many times to reach them first.\n\n` +
          `There is no rush. It will still be here tomorrow, and next year.\n\n` +
          `Open when you're ready: ${v(m, 'claimUrl')}\n— Vigil`,
      };
  }
}

/** SMS is metered and read on a lock screen. One sentence and a link. */
export function renderSms(m: OutboundMessage): string {
  switch (m.template) {
    case 'REMIND_OWNER':
      return `Vigil: we haven't heard from you. Checking in takes a tap — nothing has been sent. ${v(m, 'checkInUrl')}`;
    case 'WELLBEING_CHECK':
      return `Vigil: ${v(m, 'ownerName')} asked us to check with you if we couldn't reach them. Is everything alright? ${v(m, 'answerUrl')}`;
    case 'CONFIRMATION_REQUEST':
      return `Vigil: we still cannot reach ${v(m, 'ownerName')}. Nothing is sent until you confirm. ${v(m, 'answerUrl')}`;
    case 'DELIVERY':
      return `${v(m, 'ownerName')} left something for you. No rush — open when you're ready. ${v(m, 'claimUrl')}`;
  }
}

export function renderWhatsApp(m: OutboundMessage): RenderedWhatsApp {
  const t = WHATSAPP_TEMPLATES[m.template];
  const parameters =
    m.template === 'REMIND_OWNER'
      ? [v(m, 'name', 'there'), v(m, 'checkInUrl')]
      : m.template === 'DELIVERY'
        ? [v(m, 'recipientName', 'Hello'), v(m, 'ownerName', 'Someone'), v(m, 'claimUrl')]
        : [v(m, 'contactName', 'there'), v(m, 'ownerName', 'Someone'), v(m, 'answerUrl')];

  return {
    templateName: t.name,
    language: 'en',
    // Meta rejects parameters containing newlines or runs of spaces, and the
    // failure reads as a generic 132000 error hours after you sent it.
    parameters: parameters.map((p) => p.replace(/\s+/g, ' ').trim()),
  };
}

export const SUPPORTED_CHANNELS: Channel[] = ['EMAIL', 'SMS', 'WHATSAPP'];

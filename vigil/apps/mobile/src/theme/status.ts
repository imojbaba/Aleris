import { palette, type Palette } from './tokens.js';

/**
 * How each trigger state looks and, more importantly, what it SAYS.
 *
 * The copy here is the most safety-critical text in the product. Someone glances
 * at this screen for two seconds in a supermarket queue; the words have to carry
 * the whole meaning, with no room for a second sentence. Three rules:
 *
 *  1. Never frighten someone who is fine. "ESCALATING" is a system state, not a
 *     thing to put in front of a human being.
 *  2. Never imply something has been sent when it has not. The gap between
 *     "we are trying to reach you" and "your letters have gone out" is the whole
 *     product, and most of a person's anxiety lives in it.
 *  3. Always say who, if anyone, has been contacted. That is the question people
 *     actually want answered.
 */

export type TriggerStatus =
  | 'DRAFT' | 'ACTIVE' | 'REMINDING' | 'WELLBEING_CHECK'
  | 'AWAITING_CONFIRMATION' | 'DELIVERING' | 'DELIVERED' | 'PAUSED' | 'CANCELLED';

export interface StatusPresentation {
  /** Two or three words, shown large. */
  headline: string;
  /** One sentence. Answers "so what?" */
  detail: string;
  tone: 'calm' | 'attention' | 'urgent' | 'resting' | 'done';
  accent: keyof Palette;
  /** How the flame behaves: steady, dimming, pulsing, out. */
  flame: 'steady' | 'dimming' | 'pulsing' | 'low' | 'out';
}

export const STATUS: Record<TriggerStatus, StatusPresentation> = {
  DRAFT: {
    headline: 'Not armed',
    detail: 'Nothing is watching yet. You can change anything without consequence.',
    tone: 'resting', accent: 'inkFaint', flame: 'out',
  },
  ACTIVE: {
    headline: 'All is well',
    detail: 'Nobody has been contacted. Nothing has been sent.',
    tone: 'calm', accent: 'sage', flame: 'steady',
  },
  /**
   * Covers every step of the owner's own ladder — the emails, the WhatsApp, the
   * phone call. One status, because from the owner's side they are one thing:
   * we are trying to reach you, and nobody else knows.
   */
  REMINDING: {
    headline: 'Trying to reach you',
    detail: 'Only you have heard from us. Nobody else knows anything.',
    tone: 'attention', accent: 'amber', flame: 'dimming',
  },
  WELLBEING_CHECK: {
    headline: 'We’ve asked if you’re alright',
    detail:
      'The people you named have been asked one question — whether you are alright. They were told nothing else. Any of them saying you are fine stops this.',
    tone: 'urgent', accent: 'ember', flame: 'pulsing',
  },
  AWAITING_CONFIRMATION: {
    headline: 'Waiting, before anything is sent',
    detail: 'Nothing has gone out. Opening this app right now stops all of it.',
    tone: 'urgent', accent: 'ember', flame: 'pulsing',
  },
  DELIVERING: {
    headline: 'Delivering',
    detail: 'The people you chose are being contacted now.',
    tone: 'done', accent: 'ember', flame: 'low',
  },
  DELIVERED: {
    headline: 'Delivered',
    detail: 'What you left has reached the people you left it for.',
    tone: 'done', accent: 'inkSoft', flame: 'out',
  },
  PAUSED: {
    headline: 'Paused',
    detail: 'Nothing is counting down. Nothing can be sent while this is paused.',
    tone: 'resting', accent: 'inkFaint', flame: 'out',
  },
  CANCELLED: {
    headline: 'Cancelled',
    detail: 'This trigger will never fire. Your vaults are untouched.',
    tone: 'resting', accent: 'inkFaint', flame: 'out',
  },
};

export const accentFor = (status: TriggerStatus, p: Palette = palette) => p[STATUS[status].accent];

/** How Vigil can reach a human being. */
export type Channel = 'PUSH' | 'EMAIL' | 'SMS' | 'WHATSAPP' | 'VOICE';

export const ALL_CHANNELS: Channel[] = ['PUSH', 'EMAIL', 'SMS', 'WHATSAPP', 'VOICE'];

/**
 * How reachable a channel is when someone has genuinely stopped responding.
 *
 * This is not cosmetic. A workflow that only ever tries PUSH is one lost phone
 * away from concluding its owner is dead, and `validateWorkflow` uses these
 * weights to insist on real independence between channels rather than counting
 * two names that happen to arrive on the same handset.
 */
export const CHANNEL_INDEPENDENCE: Record<Channel, 'DEVICE' | 'MAILBOX' | 'PHONE_NUMBER'> = {
  PUSH: 'DEVICE',
  EMAIL: 'MAILBOX',
  SMS: 'PHONE_NUMBER',
  WHATSAPP: 'PHONE_NUMBER',
  VOICE: 'PHONE_NUMBER',
};

export const CHANNEL_WORDS: Record<Channel, string> = {
  PUSH: 'a notification on your phone',
  EMAIL: 'email',
  SMS: 'a text message',
  WHATSAPP: 'WhatsApp',
  VOICE: 'a phone call',
};

export function listChannels(channels: Channel[]): string {
  const words = channels.map((c) => CHANNEL_WORDS[c]);
  if (words.length === 0) return 'nothing';
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

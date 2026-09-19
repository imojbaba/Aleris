import type { Notifier } from '../../domain/ports.js';
import {
  ChannelRouter, DryRunNotifier, ResendNotifier, TwilioSmsNotifier, WhatsAppCloudNotifier,
} from './providers.js';

export * from './providers.js';
export * from './templates.js';

export interface NotifierConfig {
  resendApiKey?: string;
  emailFrom?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioSmsFrom?: string;
  whatsappPhoneNumberId?: string;
  whatsappAccessToken?: string;
}

export interface BuiltNotifier {
  notifier: Notifier;
  /** Channels that will really send. Everything else logs and is not delivered. */
  live: string[];
  dryRun: string[];
}

/**
 * Build the notifier from whatever is configured, and say plainly which
 * channels are live.
 *
 * Deliberately never throws on missing configuration. A half-configured
 * deployment must still run everyone's cascade and log what it could not send;
 * a worker that refuses to start because SMS is unset is a worker that has
 * stopped watching every user it had.
 */
export function buildNotifier(config: NotifierConfig, log = console.log): BuiltNotifier {
  const providers: Record<string, Notifier> = {};
  const live: string[] = [];

  if (config.resendApiKey && config.emailFrom) {
    providers.EMAIL = new ResendNotifier({ apiKey: config.resendApiKey, from: config.emailFrom });
    live.push('EMAIL');
  }
  if (config.twilioAccountSid && config.twilioAuthToken && config.twilioSmsFrom) {
    providers.SMS = new TwilioSmsNotifier({
      accountSid: config.twilioAccountSid,
      authToken: config.twilioAuthToken,
      from: config.twilioSmsFrom,
    });
    live.push('SMS');
  }
  if (config.whatsappPhoneNumberId && config.whatsappAccessToken) {
    providers.WHATSAPP = new WhatsAppCloudNotifier({
      phoneNumberId: config.whatsappPhoneNumberId,
      accessToken: config.whatsappAccessToken,
    });
    live.push('WHATSAPP');
  }

  const dryRun = ['EMAIL', 'SMS', 'WHATSAPP', 'PUSH', 'VOICE'].filter((c) => !live.includes(c));
  return { notifier: new ChannelRouter(providers, new DryRunNotifier(log)), live, dryRun };
}

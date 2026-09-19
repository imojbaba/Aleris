import type { Notifier, OutboundMessage } from '../../domain/ports.js';
import { renderEmail, renderSms, renderWhatsApp } from './templates.js';

/**
 * Real message providers.
 *
 * One rule runs through all of them: a TRANSIENT failure must be retried, and a
 * PERMANENT one must not be — and the difference has to reach the state machine.
 *
 * In most products that distinction is a nicety. Here it is a safety control.
 * If a reminder hard-bounces because the owner's mailbox no longer exists, that
 * is evidence they are UNREACHABLE, which is not the same as evidence they are
 * GONE — and the cascade must not treat it as the latter. A silently swallowed
 * bounce is a false-positive path that ends with someone's letters going out
 * while they are alive and well.
 */

export interface SendResult {
  ok: boolean;
  detail?: string;
  /** True when retrying is pointless: bad address, blocked number, rejected template. */
  permanent?: boolean;
}

const TIMEOUT_MS = 15_000;

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 4xx means we sent something wrong; 5xx and network faults are worth retrying. */
const classify = (status: number, text: string): SendResult =>
  status >= 200 && status < 300
    ? { ok: true }
    : { ok: false, permanent: status >= 400 && status < 500 && status !== 429, detail: `${status} ${text.slice(0, 300)}` };

/* --------------------------------- email --------------------------------- */

export class ResendNotifier implements Notifier {
  constructor(private readonly opts: { apiKey: string; from: string }) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const to = message.to.email;
    if (!to) return { ok: false, permanent: true, detail: 'no email address' };
    const { subject, text } = renderEmail(message);
    try {
      const r = await postJson(
        'https://api.resend.com/emails',
        { authorization: `Bearer ${this.opts.apiKey}` },
        { from: this.opts.from, to: [to], subject, text },
      );
      return classify(r.status, r.text);
    } catch (e) {
      return { ok: false, detail: `network: ${(e as Error).message}` };
    }
  }
}

/* ---------------------------------- sms ---------------------------------- */

export class TwilioSmsNotifier implements Notifier {
  constructor(private readonly opts: { accountSid: string; authToken: string; from: string }) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const to = message.to.phone;
    if (!to) return { ok: false, permanent: true, detail: 'no phone number' };
    const form = new URLSearchParams({ To: to, From: this.opts.from, Body: renderSms(message) });
    const auth = Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.opts.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${auth}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          signal: controller.signal,
        },
      );
      return classify(res.status, await res.text());
    } catch (e) {
      return { ok: false, detail: `network: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* -------------------------------- whatsapp -------------------------------- */

/**
 * WhatsApp via Meta's Cloud API.
 *
 * Works against a TEST phone number from day one: create a Meta app, take the
 * free test number, verify up to five recipient numbers, and send. No business
 * verification, no waiting on Meta to approve a company. That is the whole
 * "workaround" — it is not a workaround at all, it is the supported path, and
 * the code below is identical for the test number and for production. When the
 * real number is verified, two environment variables change and nothing else.
 *
 * Templates still have to be registered and approved even on the test number
 * (usually minutes, not days). See templates.ts for why every Vigil message is
 * a template and none can be free text.
 */
export class WhatsAppCloudNotifier implements Notifier {
  constructor(
    private readonly opts: { phoneNumberId: string; accessToken: string; apiVersion?: string },
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const to = message.to.phone;
    if (!to) return { ok: false, permanent: true, detail: 'no phone number' };

    const { templateName, language, parameters } = renderWhatsApp(message);
    const version = this.opts.apiVersion ?? 'v21.0';
    try {
      const r = await postJson(
        `https://graph.facebook.com/${version}/${this.opts.phoneNumberId}/messages`,
        { authorization: `Bearer ${this.opts.accessToken}` },
        {
          messaging_product: 'whatsapp',
          to: to.replace(/[^\d]/g, ''),
          type: 'template',
          template: {
            name: templateName,
            language: { code: language },
            components: [
              { type: 'body', parameters: parameters.map((text) => ({ type: 'text', text })) },
            ],
          },
        },
      );
      const result = classify(r.status, r.text);
      // 131030: recipient not in the test number's allow-list. Permanent until
      // someone adds them in the Meta dashboard, and the commonest thing to hit
      // while testing — so say so rather than leaving a bare error code.
      if (!result.ok && r.text.includes('131030')) {
        return { ...result, permanent: true, detail: `${result.detail} — add this number to the test allow-list in the Meta dashboard` };
      }
      return result;
    } catch (e) {
      return { ok: false, detail: `network: ${(e as Error).message}` };
    }
  }
}

/* --------------------------------- dry run -------------------------------- */

/**
 * Prints what it WOULD send, in full, and sends nothing.
 *
 * The default everywhere until real credentials are configured. For this
 * product that default is not laziness — a misconfigured staging environment
 * that can actually send is one bad env var away from telling someone's mother
 * they have died.
 */
export class DryRunNotifier implements Notifier {
  sent: OutboundMessage[] = [];

  constructor(private readonly log: (line: string) => void = console.log) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    const to = message.to.email ?? message.to.phone ?? message.to.userId ?? 'unknown';
    if (message.channel === 'WHATSAPP') {
      const w = renderWhatsApp(message);
      this.log(`[dry-run] WHATSAPP -> ${to}  template=${w.templateName}  params=${JSON.stringify(w.parameters)}`);
    } else if (message.channel === 'SMS') {
      this.log(`[dry-run] SMS -> ${to}\n  ${renderSms(message)}`);
    } else {
      const e = renderEmail(message);
      this.log(`[dry-run] ${message.channel} -> ${to}\n  subject: ${e.subject}\n  ${e.text.replace(/\n/g, '\n  ')}`);
    }
    return { ok: true, detail: 'dry-run' };
  }
}

/* ---------------------------------- router -------------------------------- */

/**
 * Routes each message to the provider for its channel.
 *
 * A channel with no provider configured falls back to dry-run rather than
 * throwing: a half-configured deployment should still run its cascade and log
 * what it could not send, because the alternative is a worker that crashes on
 * the first SMS and silently stops evaluating everyone else's triggers.
 */
export class ChannelRouter implements Notifier {
  constructor(
    private readonly providers: Partial<Record<OutboundMessage['channel'], Notifier>>,
    private readonly fallback: Notifier = new DryRunNotifier(),
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const provider = this.providers[message.channel] ?? this.fallback;
    return provider.send(message);
  }

  configured(): OutboundMessage['channel'][] {
    return Object.keys(this.providers) as OutboundMessage['channel'][];
  }
}

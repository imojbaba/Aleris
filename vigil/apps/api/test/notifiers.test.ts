import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildNotifier, ChannelRouter, DryRunNotifier,
  ResendNotifier, TwilioSmsNotifier, WhatsAppCloudNotifier,
  renderEmail, renderSms, renderWhatsApp, WHATSAPP_TEMPLATES,
} from '../src/adapters/notifiers/index.js';
import type { OutboundMessage } from '../src/domain/ports.js';

const msg = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  channel: 'EMAIL',
  to: { email: 'ray@example.com', phone: '+447700900123' },
  template: 'WELLBEING_CHECK',
  variables: {
    contactName: 'Ray', ownerName: 'Ojaswa',
    answerUrl: 'https://vigil.app/wellbeing/abc', script: '',
  },
  ...over,
});

/** Typed so the assertions below can read the request that was actually made. */
const mockFetch = (status: number, body = '{}') => {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
};

afterEach(() => vi.unstubAllGlobals());

describe('what each channel actually says', () => {
  it('asks the wellbeing question and nothing else', () => {
    const e = renderEmail(msg());
    expect(e.subject).toBe('Is Ojaswa alright?');
    expect(e.text).toMatch(/Is everything alright/);
    expect(e.text).toMatch(/There may be nothing wrong at all/);
    // Ray is never told a vault exists, nor who else is involved.
    for (const leak of ['vault', 'letter', 'deliver', 'recipient', 'died']) {
      expect(e.text.toLowerCase(), leak).not.toContain(leak);
    }
  });

  it('uses the owner’s own words when they wrote some', () => {
    const e = renderEmail(msg({ variables: { ...msg().variables, script: 'Ray — is Oj okay? He said you’d know.' } }));
    expect(e.text).toContain('Ray — is Oj okay?');
  });

  it('keeps SMS to one sentence and a link', () => {
    const s = renderSms(msg({ channel: 'SMS' }));
    expect(s.length).toBeLessThan(200);
    expect(s).toContain('https://vigil.app/wellbeing/abc');
  });

  it('never tells a delivery recipient to hurry', () => {
    const e = renderEmail(msg({
      template: 'DELIVERY',
      variables: { recipientName: 'Maya', ownerName: 'Ojaswa', claimUrl: 'https://vigil.app/for-you/x' },
    }));
    expect(e.text).toMatch(/no rush/i);
    expect(e.text).toMatch(/still be here tomorrow/);
  });
});

describe('WhatsApp templates', () => {
  /**
   * Every Vigil message is business-initiated after a long silence, so there is
   * never a 24-hour session window and every one must be a registered template.
   * These tests pin the catalogue to what gets submitted to Meta.
   */
  it('has a registered template for every message kind, all UTILITY', () => {
    for (const kind of ['REMIND_OWNER', 'WELLBEING_CHECK', 'CONFIRMATION_REQUEST', 'DELIVERY'] as const) {
      const t = WHATSAPP_TEMPLATES[kind];
      expect(t.name, kind).toMatch(/^vigil_[a-z_]+$/);
      expect(t.category, kind).toBe('UTILITY');
    }
  });

  it('supplies exactly as many parameters as the template body declares', () => {
    for (const [kind, t] of Object.entries(WHATSAPP_TEMPLATES)) {
      const declared = new Set(t.body.match(/\{\{\d+\}\}/g) ?? []).size;
      const supplied = renderWhatsApp(msg({ template: kind as never, channel: 'WHATSAPP' })).parameters.length;
      expect(supplied, `${kind}: body declares ${declared}`).toBe(declared);
    }
  });

  it('strips newlines and double spaces, which Meta rejects hours later', () => {
    const w = renderWhatsApp(msg({
      channel: 'WHATSAPP',
      variables: { ...msg().variables, contactName: 'Ray\n\n  Patel  ' },
    }));
    for (const p of w.parameters) {
      expect(p).not.toMatch(/[\n\r]/);
      expect(p).not.toMatch(/ {2}/);
    }
    expect(w.parameters[0]).toBe('Ray Patel');
  });

  it('posts a template message, never free text', async () => {
    const spy = mockFetch(200, '{"messages":[{"id":"wamid.x"}]}');
    const n = new WhatsAppCloudNotifier({ phoneNumberId: '123', accessToken: 'tok' });
    expect((await n.send(msg({ channel: 'WHATSAPP' }))).ok).toBe(true);

    const body = JSON.parse(String(spy.mock.calls[0]?.[1]?.body));
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('vigil_wellbeing_check');
    expect(body).not.toHaveProperty('text');
    expect(body.to).toBe('447700900123'); // digits only
  });

  it('explains the test-number allow-list error instead of leaving a bare code', async () => {
    mockFetch(400, '{"error":{"code":131030,"message":"Recipient phone number not in allowed list"}}');
    const n = new WhatsAppCloudNotifier({ phoneNumberId: '123', accessToken: 'tok' });
    const r = await n.send(msg({ channel: 'WHATSAPP' }));
    expect(r.ok).toBe(false);
    expect(r.permanent).toBe(true);
    expect(r.detail).toMatch(/test allow-list in the Meta dashboard/);
  });
});

describe('transient vs permanent — the distinction the cascade depends on', () => {
  it('treats a 4xx as permanent and a 5xx as worth retrying', async () => {
    mockFetch(422, 'invalid to address');
    const bad = await new ResendNotifier({ apiKey: 'k', from: 'a@b.c' }).send(msg());
    expect(bad).toMatchObject({ ok: false, permanent: true });

    mockFetch(503, 'upstream unavailable');
    const flaky = await new ResendNotifier({ apiKey: 'k', from: 'a@b.c' }).send(msg());
    expect(flaky.ok).toBe(false);
    expect(flaky.permanent).toBeFalsy();
  });

  it('treats rate limiting as transient, not as a dead address', async () => {
    mockFetch(429, 'slow down');
    const r = await new TwilioSmsNotifier({ accountSid: 'AC', authToken: 't', from: '+1' })
      .send(msg({ channel: 'SMS' }));
    expect(r.ok).toBe(false);
    expect(r.permanent).toBeFalsy();
  });

  it('treats a network fault as transient', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const r = await new ResendNotifier({ apiKey: 'k', from: 'a@b.c' }).send(msg());
    expect(r.ok).toBe(false);
    expect(r.permanent).toBeFalsy();
    expect(r.detail).toMatch(/ECONNRESET/);
  });

  it('calls a missing address permanent without calling out at all', async () => {
    const spy = mockFetch(200);
    const r = await new ResendNotifier({ apiKey: 'k', from: 'a@b.c' }).send(msg({ to: {} }));
    expect(r).toMatchObject({ ok: false, permanent: true });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('routing and the safe default', () => {
  it('sends nothing at all when nothing is configured', async () => {
    const spy = mockFetch(200);
    const lines: string[] = [];
    const { notifier, live, dryRun } = buildNotifier({}, (l) => lines.push(l));
    await notifier.send(msg({ channel: 'WHATSAPP' }));
    expect(live).toEqual([]);
    expect(dryRun).toContain('WHATSAPP');
    expect(spy).not.toHaveBeenCalled();
    expect(lines[0]).toMatch(/\[dry-run\] WHATSAPP .* template=vigil_wellbeing_check/);
  });

  it('goes live only on the channels that are fully configured', () => {
    const { live, dryRun } = buildNotifier(
      { resendApiKey: 'k', emailFrom: 'vigil@example.com', twilioAccountSid: 'AC' },
      () => {},
    );
    // Twilio is half-configured, so it stays dry — no silent partial sending.
    expect(live).toEqual(['EMAIL']);
    expect(dryRun).toContain('SMS');
  });

  it('falls back per channel rather than failing the whole tick', async () => {
    const dry = new DryRunNotifier(() => {});
    const email = { send: vi.fn(async () => ({ ok: true })) };
    const router = new ChannelRouter({ EMAIL: email }, dry);
    await router.send(msg({ channel: 'EMAIL' }));
    await router.send(msg({ channel: 'SMS' }));
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(dry.sent).toHaveLength(1);
  });
});

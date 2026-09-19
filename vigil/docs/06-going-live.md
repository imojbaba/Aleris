# Going live — what to sign up for, and in what order

Written to be followed, not admired. Everything here gets you to a private beta
your friends can actually use; none of it gets you to strangers (see the bottom).

## Today, before anything else

**WhatsApp does NOT need business verification to start.** Meta gives you a free
test phone number the moment you create an app, and you can send real WhatsApp
messages to up to five verified numbers immediately. The code is identical for
the test number and for production — when your real number is verified later,
two environment variables change and nothing else does.

1. **developers.facebook.com** → Create app → type **Business** → add the
   **WhatsApp** product.
2. Copy the **test phone number ID** and a **temporary access token** (24 h; swap
   for a permanent System User token once it works).
3. Add your own mobile under **To** → *Manage phone number list*. Up to five.
4. Register the templates: `pnpm --filter @vigil/api whatsapp:templates` prints
   all four. Paste each into **WhatsApp Manager → Message templates**, category
   **Utility**, language **English**. Approval is usually minutes.

```bash
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_ACCESS_TOKEN=...
```

That is the whole "workaround", and it is not one — it is the supported path.

### What WhatsApp costs you in product terms

Every Vigil message is business-initiated after a long silence, so there is
never a 24-hour session window, so **every Vigil WhatsApp message must be a
registered template.** The consequence is not technical:

> On email and SMS the owner's own words are sent verbatim.
> On WhatsApp their words can only fill a blank in an approved message.

The app must say so at the point someone writes their script, rather than
letting them compose something heartfelt that WhatsApp will never carry.

**Do not use whatsapp-web.js, Baileys or any of the unofficial libraries.** Not
on principle — on failure mode. They violate WhatsApp's terms and get numbers
banned, and a banned number stops delivering *silently*. In this product,
silence from a channel is indistinguishable from an owner who cannot be
reached, which advances the countdown. An unofficial WhatsApp integration is a
direct path to someone's letters going out while they are alive.

## Email — you already have domains

Deliverability is a **safety** control here, not a growth one. A reminder in a
spam folder does not merely annoy; it advances a countdown toward sending
someone's private letters.

1. **resend.com** → add one of your domains → add the **SPF**, **DKIM** and
   **DMARC** records it gives you. Wait for verification.
2. Use a subdomain you do not send anything else from — `vigil.yourdomain.com` —
   so this reputation is its own.
3. Start `DMARC` at `p=none`, watch the reports, then tighten.

```bash
RESEND_API_KEY=...
EMAIL_FROM="Vigil <hello@vigil.yourdomain.com>"
```

Free to ~3,000 messages a month, which is far more than a beta needs.

## SMS

**twilio.com** → buy a number (~£1/month) → copy the SID and auth token.

```bash
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_SMS_FROM=+44...
```

## The heartbeat — the cheapest important thing here

**healthchecks.io**, free. Make one check, expect a ping every 5 minutes, and
have it email you when one is missed.

```bash
HEARTBEAT_URL=https://hc-ping.com/<uuid>
```

The worker pings it *after* each completed tick, never before. This is the only
thing standing between "the worker died on Tuesday" and finding out months
later, because a stopped worker looks exactly like everybody being fine.

## Host and database

| | |
|---|---|
| **Fly.io** — API + worker as separate processes | ~£5/mo |
| **Neon** — serverless Postgres, free tier is plenty for a beta | £0 |
| **Cloudflare Pages** — the web app | £0 |

Render works too and is simpler to click through, at roughly £21/month.

```bash
DATABASE_URL=postgres://...
JWT_SECRET=<32+ random bytes>
APP_BASE_URL=https://vigil.yourdomain.com
```

With `DATABASE_URL` set the service runs on Postgres; without it, entirely in
memory. Both are exercised by the same test suite, so memory mode is a real
fallback rather than a fiction — `pnpm api:dev` needs nothing installed.

The app stays in **preview** mode until `EXPO_PUBLIC_API_URL` is set, at which
point it registers with the server and pushes recipients and triggers so the
cascade can run while the phone is off. The device still holds every key and
does every encryption; the server is told only what it needs in order to run.

**Run the worker as its own process, not a thread of the API.** It is the only
thing that can cause a delivery, and it should be restartable, observable and
scalable on its own.

## Nothing sends until you say so

Every channel is dry-run by default. An unconfigured channel logs the exact
message it would have sent and delivers nothing, and the boot log prints:

```
channels live: EMAIL | dry-run (logged, NOT sent): SMS, WHATSAPP, PUSH, VOICE
```

Sending is opt-in, per channel, because a staging environment that can really
send is one bad environment variable away from telling someone's mother she has
been bereaved.

## Order of work

1. WhatsApp test number + templates ← **start now, it is the only clock you don't control**
2. DNS on the sending subdomain ← propagation is the second slowest thing
3. Neon + Fly, `DATABASE_URL` set
4. `pnpm --filter @vigil/api prisma:push` — the adapter and schema are written
   and tested against real Postgres
5. Set `EXPO_PUBLIC_API_URL` in the app build — the client is written and tested
   against the real routes
6. Heartbeat, Sentry, first real send to your own number

## Before strangers, not friends

Neither of these blocks a beta among people who know what they are agreeing to.
Both block a public launch.

- **You will hold the email addresses and phone numbers of people who never
  signed up** — the recipients and the confirmers. Under UK GDPR that is
  third-party personal data and needs a lawful basis, a privacy notice, and an
  answer for a recipient who asks to be erased.
- **What happens to everyone's vaults if the company stops.** Still the largest
  unanswered risk in the product. See `04-production-path.md`.

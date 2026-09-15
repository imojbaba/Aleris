# From this MVP to something people can actually trust

Ordered by what blocks what, not by what is fun.

## Where we are

Working, tested, and honest about being an MVP.

| | |
|---|---|
| ✅ Crypto core, split custody, 66 tests | ❌ No third-party audit |
| ✅ Trigger cascade, 49 tests | ❌ Prisma adapter unwritten (memory only) |
| ✅ Release engine, exactly-once, 17 tests | ❌ No real notification providers |
| ✅ Wire contract, 20 tests | ❌ No file/blob storage for large media |
| ✅ Data model | ❌ No auth beyond a dev JWT |
| ✅ App: design system, home, arming flow | ❌ No vault browser or recipient management UI |

---

## Phase 1 — make it real (4–6 weeks)

**Storage and identity.** Write the Prisma adapter against the existing
`TriggerRepository` port — the interface exists and the memory implementation
documents the expected behaviour. Postgres advisory locks for `Locks`.
Passkey/WebAuthn authentication; email OTP as fallback. Note that account auth
and vault encryption are deliberately separate: signing in never unlocks
anything.

**Notification providers.** Email, SMS, WhatsApp Business, APNs/FCM, and voice.
Two requirements that are easy to skip and expensive to retrofit:
- **Per-channel delivery receipts fed back into the state machine.** A hard
  bounce is evidence the owner may be *unreachable* rather than *absent*, and
  should widen the escalation rather than advance it.
- **Provider redundancy on at least two channels.** A single SMS vendor having a
  bad afternoon must not advance anybody's countdown.

**Blob storage.** S3-compatible, per-file keys derived from the vault key,
multipart upload from the device with client-side encryption. The item
`ciphertext` field already anticipates holding an encrypted manifest.

**Worker hardening.** Run as its own deployment. Alert if a tick has not
completed in ten minutes — a worker that silently stops is a product that
silently stops keeping its promise, and nobody outside would notice.

## Phase 2 — earn the trust (6–10 weeks, overlapping)

**Third-party cryptographic audit.** Non-negotiable before real users. Scope:
`packages/crypto`, the grant construction path, and the release flow. Publish
the report, including findings.

**Open-source the crypto package.** The security claim is checkable only if the
code is readable. There is no commercial advantage in `packages/crypto` being
secret and a large trust advantage in it not being.

**Recipient enrolment flow.** This is the highest-leverage *product* work in the
whole plan: every recipient who enrols moves a vault from SPLIT_CUSTODY to
RECIPIENT_KEYED, which is the mode where we genuinely cannot open it. Design it
so enrolment is a warm invitation rather than a security chore, and so the owner
can see at a glance which recipients are on which footing.

**The dead-hand test.** A recurring, automated, end-to-end rehearsal in
production: a synthetic user stops checking in, and we assert that every rung
fires, the verifier is asked, the hold is observed, and delivery completes.
Run it weekly. The failure mode this catches — the cascade quietly breaking and
nobody finding out until someone dies — is otherwise undetectable.

**Reproducible builds and published hashes.** Closes the malicious-build gap.

## Phase 3 — the things that are not engineering

### What happens when the company dies

**This is the hardest problem in the product and it is not technical.** A
service whose promise is measured in decades, sold to people who by definition
will not be around to complain, cannot answer "what if you shut down?" with
optimism. Three answers we consider honest, probably in combination:

1. **A legal successor.** A foundation or trust, funded by an endowment sized to
   run the release infrastructure for *n* years without revenue, whose sole
   obligation is to keep evaluating triggers and delivering.
2. **A published wind-down protocol.** Contractually binding: on shutdown, every
   user gets an extended notice period, their recovery share, and an export of
   their own ciphertext. Verifiers are notified. Nothing silently stops.
3. **A cold-standby escrow of the service's custody shares** with an independent
   third party under a dead man's switch of our own — Vigil's own vigil.

Whatever is chosen has to be written down, legally binding, and on the marketing
site before the first paying customer. A company selling a dead man's switch
that has not built one for itself is not a company anyone should use.

### Legal and regulatory

- **Credentials are not assets.** Sharing account passwords violates most
  providers' terms of service, and "give my daughter my Gmail password" is not
  legally the same as leaving her the contents. The product should nudge people
  towards each platform's own legacy mechanism (Apple Legacy Contact, Google
  Inactive Account Manager) for accounts that have one, and be candid that a
  stored password is a practical workaround with legal edges.
- **Vigil is not a will.** It must say so, clearly, more than once. Anything
  testamentary needs a solicitor and the local formalities. Vigil delivers
  *information*, not *estate*.
- **GDPR/UK DPA.** Right to erasure interacts awkwardly with a recipient's
  delivered copy. Data protection impact assessment required. Article 17 and a
  delivered vault need a documented answer before launch.
- **Jurisdiction of the death determination.** We are asserting, on a schedule,
  that someone is probably dead. Where a death certificate is required for a
  downstream action, Vigil's attestation is not a substitute and must not be
  presented as one.
- **Insurance.** Professional indemnity sized for the premature-release scenario.

### Operations

- Runbooks for the only two incidents that really matter: *a trigger fired that
  should not have*, and *a trigger did not fire that should have*.
- A named human who can be reached by a bereaved family who are not the account
  holder and have no credentials. This will happen in week one and there must be
  a process, not improvisation.
- Support training that starts from "we cannot recover their passphrase, and
  here is how to say that kindly."

### Business model

Subscription, priced so that the endowment in phase 3 is funded from revenue
rather than hoped for. Avoid one-time lifetime pricing: it front-loads revenue
against an obligation with no end date, which is how this product fails in year
seven.

---

## Deliberately not planned

- Cryptocurrency custody. Regulated, different risk profile, would swallow the
  roadmap.
- Anything requiring plaintext server-side: search, previews, AI summaries. Each
  would be a different product wearing this one's trust.
- Social features. No.

## Suggested next commit

Phase 1, in this order: Prisma adapter (the port and its memory twin already
define the contract), then a single real email provider end to end, then the
recipient enrolment flow. That sequence gets to a system a real person can use
for real, with the strong custody mode available, in the shortest path.

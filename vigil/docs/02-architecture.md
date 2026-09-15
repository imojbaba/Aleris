# Architecture

## Shape

```
┌─────────────────────────────┐
│  apps/mobile   (Expo)       │   All encryption happens here.
│  ─────────────────────────  │   Master key, vault keys and grants are
│  @vigil/crypto  @vigil/core │   created on the device and never leave it
└──────────────┬──────────────┘   unwrapped.
               │  ciphertext + sealed grants only
               ▼
┌─────────────────────────────┐
│  apps/api      (Fastify)    │   Stores blobs. Validates shape and safety.
│  ─────────────────────────  │   Cannot read anything it stores.
│  routes/  domain/  adapters/│
└──────────────┬──────────────┘
               │
         ┌─────┴─────┐
         ▼           ▼
   ┌──────────┐  ┌─────────────────┐
   │ Postgres │  │  cadence worker │  The only process that can cause
   └──────────┘  │  ReleaseEngine  │  a release. Watch it accordingly.
                 └─────────────────┘
```

Two packages carry the whole safety argument and are therefore **pure**: no
database, no clock, no network. `@vigil/core` is a function of
`(config, state, now)`. `@vigil/crypto` is a function of its inputs. That is not
stylistic — it is what makes them exhaustively testable, and for the two pieces
that can respectively send someone's private life to the wrong person or fail to
protect it, "we ran it against staging once" is not an acceptable standard of
evidence.

## The key hierarchy

```
passphrase ──argon2id──► KEK ──wraps──► MK (master key, random)
                                         │
                                         ├──wraps──► VK₁  "For Maya"
                                         └──wraps──► VK₂  "Accounts"
                                                      │
                                                      └──hkdf──► IK (per item)
```

Two properties this buys:

1. **The master key is random, not derived.** Changing a passphrase re-wraps 32
   bytes. It does not re-encrypt four gigabytes of home video over a phone
   connection.
2. **Vault keys are individually wrapped.** A vault can be released to one
   recipient without exposing any other. The letter to your wife and the
   password to your bank are not the same secret and must not share a fate.

Primitives: **XChaCha20-Poly1305**, **Argon2id**, **X25519**, **HKDF-SHA256**.

XChaCha20 over AES-GCM for three reasons: 24-byte random nonces (Vigil encrypts
on phones, offline, across reinstalls and restores-from-backup, where no counter
can be trusted); constant-time in pure software on Android devices without
hardware AES; and one implementation everywhere, so a ciphertext written in 2026
opens in 2050 without a platform caveat.

Every AEAD call passes a context string as additional authenticated data —
`vigil/v1/item/{vaultId}/{itemId}`. An attacker with database *write* access
therefore cannot move a blob from one slot to another; the ciphertext fails to
open rather than opening wrongly.

## Release: how a key reaches a living person

Two modes, and Vigil shows the user which one each recipient is on, in plain
words generated from the actual grant by `describeCustody()`.

### RECIPIENT_KEYED — the strong one

The recipient has installed Vigil and enrolled an X25519 key. The vault key is
sealed to their public key. We hold a ciphertext we cannot open, full stop,
forever.

Cost: the recipient must enrol while the owner is alive and must not lose their
key — precisely the failure a grieving family is most likely to hit. That is why
it is not the only mode.

### SPLIT_CUSTODY — the realistic one

The recipient has not enrolled. Often they do not know the vault exists and the
owner would rather it stayed that way.

The vault key is wrapped under a Release Key, which is Shamir-split *k*-of-*n*:

| Custodian | Share protected by |
|---|---|
| The Vigil service | a KMS/HSM key |
| The recipient | a claim code that exists only in the delivery message |
| Each verifier the owner named | a claim code given to them at setup |
| The owner | their own recovery share |

with `k ≥ 2` enforced, and a construction-time check that the service's own
shares never reach `k`.

### What happens at release

This is the part that matters, and the design decision most likely to be got
wrong:

**The server never reconstructs anything.** At release it creates a delivery
record and sends a claim link. The recipient opens the app; the service hands
over *its own single share*; the verifiers — who have already been contacted —
release theirs. The recipient's **device** combines the shares, recovers the
release key, unwraps the vault key, and decrypts locally.

At no instant does any machine we operate hold enough material to open a vault.
An architecture where the server reassembles the key and re-seals it to the
recipient would be far simpler and would quietly void the entire guarantee at
exactly the moment it matters.

`apps/api/test/releaseEngine.test.ts` asserts that the delivery message contains
a claim URL and nothing resembling key material.

## The cascade

`packages/core/src/machine.ts`, as a pure function:

```
ACTIVE ──miss──► GRACE ──► ESCALATING ──► VERIFICATION_HOLD ──► RELEASING ──► RELEASED
   ▲               │            │                 │
   └───────────────┴────────────┴─────────────────┘
        any check-in, or one verifier saying ALIVE
```

Enforced invariants, each with a test:

- A check-in at **any** point before RELEASED returns to ACTIVE and clears
  escalation history, so a recovered owner does not resume three rungs up the
  ladder the next time they are a day late.
- One ALIVE attestation halts everything and outranks any number of DECEASED
  verdicts.
- Attestations older than the last check-in are ignored — a "he's fine" from
  eighteen months ago says nothing about today.
- **Every escalation rung is sent before release.** An earlier version moved to
  the hold at the same instant the final rung came due and silently dropped it,
  meaning the loudest, most likely-to-reach-a-living-person message was the one
  never sent. Caught by a test, fixed, and now guarded at the release boundary
  too.
- Nothing releases within 24 hours of the last check-in, whatever the config.

## Exactly-once delivery

There is no unsending. The engine therefore:

- derives delivery ids deterministically from `trigger + grant`, so a retry is a
  no-op rather than a second message;
- checks existing deliveries before dispatching;
- takes a lock per trigger, so two workers cannot both release;
- creates the delivery row *before* sending, so a crash between the two loses a
  message rather than duplicating one — the recoverable direction;
- treats a provider failure as not-sent, so the rung is retried.

Tested by crashing the database mid-release and asserting each recipient hears
exactly once.

## Storage

`apps/api/prisma/schema.prisma` is written to be read as a statement of what
Vigil knows. Absent by design: plaintext content, plaintext titles or labels,
master keys, passphrases, claim codes, and any password reset path.

`AuditEvent` is append-only and fully readable by the owner. It is the only way
a promise like "we never opened it" can be checked rather than believed.

## Ports and adapters

The release engine talks to `TriggerRepository`, `Notifier`, `Clock`, `Locks`
and `Tokens` — never to Prisma or a provider SDK. The in-memory implementations
in `adapters/memory.ts` let the engine's tests run in milliseconds and cover
paths that are awkward to provoke against a real database and far too important
to leave uncovered: a crash halfway through a release, two workers racing, a
provider returning failure, one poisoned trigger in a sweep of thousands.

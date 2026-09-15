# Vigil

*A dead man's trigger for the things you meant to pass on and never did.*

We live as though there is always a tomorrow. Mostly there is. The intellectual
property, the photographs, the account that everything is registered to, the
playlist you built for someone, the thing you kept meaning to say to your
daughter — all of it assumes one more chance to sort it out.

Vigil is the assumption's backstop. You put things in a vault, you say who they
are for, and you agree how often you will check in. If you stop checking in —
and only after a long, loud, many-channelled attempt to reach you, and after
someone who knows you has had the chance to say "they're fine" — what you left
is delivered to the people you left it for.

**Status:** working MVP. 152 tests, five packages, all typechecked.
`vigil` is a working codename, not a branding decision.

---

## What is actually here

```
vigil/
├── packages/crypto    Key hierarchy, sealed boxes, Shamir split custody   (66 tests)
├── packages/core      The trigger cascade as a pure function              (49 tests)
├── packages/shared    Wire contract — enforces "no plaintext, ever"       (20 tests)
├── apps/api           Fastify service + cadence worker + release engine   (17 tests)
└── apps/mobile        Expo app for iOS and Android
```

```bash
pnpm install
pnpm test          # 152 tests
pnpm typecheck
pnpm api:dev       # runs in memory; no database needed
pnpm mobile:start
```

## The two ideas the product rests on

### 1. We cannot open your vaults, and that is structural

Not a policy, not a promise in a privacy page. Every vault key is either sealed
to a recipient's own public key — in which case we hold a ciphertext we have no
key for — or split with Shamir's secret sharing across the service, the
recipient, and the people you named, with a threshold we hold strictly fewer
shares than.

So the honest sentence is not "we would never look". It is: *on our own, we are
one piece short.* A subpoena served on us alone, a rogue employee, or a complete
database exfiltration does not produce a vault key, because the missing share is
not ours to hand over.

`createSplitCustodyGrant` refuses at construction time to build a grant that
would violate this, and `POST /v1/grants` refuses it again at the edge, so a
modified client cannot talk the service into holding enough.

The test that pins it: *"CANNOT be opened by the service alone, even holding the
whole database"* in `packages/crypto/test/release.test.ts`.

### 2. A false positive is unforgivable, so the cascade is asymmetric

A trigger that fires late is an inconvenience. A trigger that fires early sends a
living person's credentials, their unsent letters, and possibly a goodbye to
their children, to their family. There is no undo.

So the machine is deliberately lopsided:

| To keep you alive | To conclude you are gone |
|---|---|
| One check-in, from anywhere, at any point | The full check-in interval, **and** |
| **or** one person saying "they're alright" | the grace period, **and** |
| **or** a pause, **or** a cancellation | every escalation rung on ≥2 channels, **and** |
| | a final hold with nothing sent, **and** |
| | whatever confirmations you required |

Plus a hard floor: nothing releases within 24 hours of your last check-in,
whatever the configuration says, measured from *when you were last seen* so that
editing a live trigger cannot shorten a countdown already running.

One verifier saying ALIVE outranks any number saying DECEASED. Being wrong about
death is unrecoverable; being wrong about life costs a delay.

## Documentation

| | |
|---|---|
| [Product](docs/01-product.md) | What it is, who it is for, and the design brief |
| [Architecture](docs/02-architecture.md) | How the pieces fit, and the release flow end to end |
| [Threat model](docs/03-threat-model.md) | What we defend against — **and what we do not** |
| [Production path](docs/04-production-path.md) | What stands between this and real users |

## Two things worth reading before building on this

The threat model has a section titled *"What Vigil does not protect you from"*.
It is the most important page in the repository. A product in this category that
does not publish one is asking to be trusted on vibes.

The production path has a section on **what happens when the company dies**. A
service whose entire promise is measured in decades has an existential problem
that no amount of engineering solves, and it should be answered before launch
rather than after.

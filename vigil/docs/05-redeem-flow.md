# The redeem flow — and proving someone is who the owner meant

## The design you'd reach for first, and why it isn't this one

> The trigger fires. We email the recipient. They click a link, we send an OTP,
> they enter it, we check they're related, and then we hand over the keys that
> were protected until now.

Every step of that is right except the last one. "We hand over the keys" means
**we have keys that open vaults** — sitting in our infrastructure, for years,
waiting. And a service that can hand over keys after an OTP can hand them over
for other reasons too: a court order, a compromised admin account, a bug in the
OTP check, an engineer with database access and a bad month.

The good news is that the *experience* above — a link, a code, a question, and
then their letters — does not require that. It requires only that the place
where key material comes together is **the recipient's device** rather than ours.

## What actually happens

```
  TRIGGER FIRES
        │
        ▼
  ① We send Maya a link.          Email / WhatsApp / SMS, on the address the
                                  owner recorded. We know nothing else yet.
        │
        ▼
  ② Maya proves she controls      A 6-digit OTP to that same address.
     that address.                Server-side, rate-limited.
                                  This GATES the flow. It does not protect
                                  the vault — see below.
        │
        ▼
  ③ Her browser makes an          X25519. The private half never leaves her
     ephemeral keypair.           device and dies when she closes the tab.
        │           (public key)
        ▼
  ④ Custodians release their      • Vigil seals ITS ONE share to her public key
     shares TO THAT SESSION.      • Ray — who already answered the wellbeing
                                    check — seals his
                                  We store and forward blobs we cannot open.
        │
        ▼
  ⑤ Maya answers the owner's      "What did we call the dog?"
     question.                    The answer NEVER leaves her device.
        │
        ▼
  ⑥ Her device combines the       Shamir combine → release key → vault key →
     shares and opens the vault.  decrypt. All locally.
```

At no instant does any machine we run hold enough to open anything.
`packages/crypto/test/claim.test.ts` asserts exactly that: given the full grant,
Vigil's own custody key, and every blob it relayed, the service still cannot
open the vault — because those blobs are sealed to a keypair that only ever
existed in Maya's browser.

## Proving the relationship, simply

You asked for something simple and smart. Identity documents are the obvious
answer and they are the wrong one: they are hostile to a grieving family, and
they prove the wrong thing anyway — that someone is *Maya Iyer*, not that they
are *the Maya the owner meant*.

So: **two factors, one of them human.**

**① Control of the address the owner chose.** An OTP to the exact email or phone
number the owner recorded. This is stronger than it looks, precisely because the
owner picked it — an attacker has to already control the inbox of the specific
person the owner had in mind.

**② A question only their person could answer.** The owner writes it at setup:
*"What did we call the dog?" · "Which hospital were you born in?" ·
"What did I always say when you left the house?"*

Here is the part that matters. **We never check the answer.** We do not store
it, not even hashed. The answer is run through Argon2id and *becomes part of
the key* that unwraps Maya's custody share.

The difference is not academic:

|  | Store a hash and compare | Derive the key from it *(what Vigil does)* |
|---|---|---|
| Who decides the answer is right | We do | Nobody — it either decrypts or it doesn't |
| Can we be compelled to skip the check | Yes | There is no check to skip |
| Does a database leak help an attacker | Yes, offline guessing | No, there is nothing to guess against |
| Wrong answer gives an attacker | A "no", i.e. an oracle | 32 bytes of noise |

Normalisation is deliberately forgiving — case, spacing, punctuation and accents
are all stripped, so `Biscuit`, `biscuit ` and `BISCUIT!` are the same answer.
Someone typing their mother's answer through tears on a phone keyboard should
not fail on a capital letter.

**The honest weakness:** answers are low-entropy and a family member might guess
one. That is why Argon2id sits in front of it, why the OTP gate means an
attacker must already control the recipient's mailbox before they can even begin,
and why the app nudges owners away from questions a sibling could answer. A
determined, close relative who has compromised the recipient's email is inside
the threat model's stated limits — see `03-threat-model.md`.

## Nobody gets locked out

The obvious objection to threshold custody is that it fails in exactly the
situation it exists for: everyone is grieving, scattered, and unreachable. So
the default is **2-of-3**, with three independent routes in:

| Maya has | Ray answers | Opens? |
|---|---|---|
| the answer | — | ✅ Vigil's share + Maya's |
| forgot the answer | ✅ | ✅ Vigil's share + Ray's |
| the answer | ✅ | ✅ either way |
| forgot | unreachable | ❌ — and this is what the owner's own recovery share is for |

An owner who wants more ceremony raises the threshold to 3-of-3, and then both
the answer *and* a confirmer are required. That is their call, not ours.

## The one place we let the owner weaken it

Some people's honest fear is not that Vigil reads their letters. It is that the
letters never arrive — that everyone named will be overwhelmed or unreachable
when it matters.

For them there is a second posture, chosen explicitly, in which Vigil holds
enough to deliver alone. `describePosture()` generates the sentence they see at
the moment of choosing, from the real grant:

> **Split** — *"Vigil cannot open this one. It takes 2 key pieces of 3; we hold
> 1 and the people you named hold 2. On our own we are 1 short — so a court
> order served on us, a dishonest employee, or someone stealing our whole
> database all come away with nothing."*

> **Service-assisted** — *"Vigil can open this one. You chose certainty of
> delivery over secrecy from us: if everyone you named is unreachable, we can
> still hand it over — and that also means we could be compelled to."*

Both are legitimate. The user decides — the same principle that made the trigger
a workflow rather than a settings page. What is not negotiable is that they are
told, in those words, at the moment they choose, rather than discovering it in a
privacy policy.

## The wellbeing check itself

The message the designated person receives says as little as possible:

> *Hi Ray — Ojaswa is a Vigil user and we were reaching out for a wellbeing
> check, as we haven't been able to reach them. Is everything alright?*
>
> **Yes, they're fine** · **I'm not sure** · **No** · *What is this?*

They are **never** told that a vault exists, what is in it, who else was
contacted, or who the recipients are. `apps/api/test/releaseEngine.test.ts`
asserts the outbound payload contains none of those words.

The owner writes the script themselves, so it arrives sounding like someone Ray
knows rather than a system. That text is capped and escaped at the template
boundary — it is owner-authored content rendered into a third party's inbox,
which makes it untrusted input by definition.

One answer of **"Yes, they're fine"** halts the entire workflow immediately, from
anyone, at any point, and outranks any number of people saying otherwise.
Being wrong about death is unrecoverable; being wrong about life costs a delay.

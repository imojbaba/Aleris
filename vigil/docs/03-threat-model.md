# Threat model

A product in this category that does not publish one of these is asking to be
trusted on vibes. This page is written to be read by someone deciding whether to
put their life in it.

## Assets, in order of how bad it is to lose them

1. **Vault contents.** Letters, credentials, documents, recordings. Disclosure
   is permanent and, in the case of things written to be read after a death,
   uniquely damaging if read early.
2. **The fact that a vault exists, and for whom.** "Jo has a sealed vault for
   someone who is not Jo's spouse" is itself sensitive, sometimes dangerously so.
3. **Availability at exactly one moment.** The vault must open when the owner is
   gone. A perfectly confidential system that fails to deliver has failed
   completely.
4. **The owner's life.** A trigger that fires early can do real damage to a
   living person.

## Adversaries and what stops them

| Adversary | Stopped by |
|---|---|
| **Network attacker** | TLS; all payloads already encrypted end-to-end, so interception yields ciphertext |
| **Vigil database compromise** | Everything at rest is ciphertext. Vault keys are sealed to recipients or Shamir-split with the service below threshold |
| **Rogue Vigil employee** | Same. Split custody means the service is structurally one share short; a single insider cannot assemble a key |
| **Subpoena served on Vigil alone** | We can be compelled to produce what we have. What we have does not open a vault |
| **Attacker with DB *write* access** | AEAD context binding: a blob moved between slots fails to open rather than opening wrongly. Tested per-slot |
| **Someone who steals the owner's phone** | Vault keys live behind the OS keychain and biometric unlock; the master key requires the passphrase, which is never stored |
| **Someone trying to fire the trigger early** | They would need to suppress every channel simultaneously *and* survive the grace period, the full ladder, the hold, and any verifier saying ALIVE |
| **Someone trying to suppress the trigger forever** | Multi-channel escalation; a single compromised mailbox or SIM is not enough |
| **A malicious verifier** | They can only delay (by answering ALIVE) or contribute one share. One verifier cannot release anything alone |
| **Forged attestation via the database** | Only the hash of each one-time token is stored; the token itself exists solely in the message we sent |

## What Vigil does **not** protect you from

This is the important section.

### A compromised device
If someone has your unlocked phone, they have your vaults. End-to-end encryption
protects data in transit and at rest on our side. It does nothing about an
attacker sitting where the plaintext legitimately is. Same for the recipient's
device after delivery.

### Forgetting your passphrase
There is no recovery. None. We cannot derive your key, there is no reset, and a
support agent who wanted to help could not. **If you forget your passphrase,
everything in your vaults is gone forever** — including from the people you left
it for. This is the direct cost of the guarantee, it will generate furious
reviews, and softening it would mean holding a key that opens your vaults.

Mitigation, and it is a real one: the owner's recovery Shamir share. Print it,
put it with the will. We cannot reconstruct it for you.

### Compulsion at the moment of release
At release, key material converges on the *recipient's* device by design. A
court can compel the recipient. It can compel a verifier to surrender a share.
We have moved the target rather than removed it — deliberately, because a
grieving family being legally compelled is a rarer and more visible harm than a
service silently holding the keys to everyone.

### Metadata
We know a great deal without opening anything: who your recipients are, their
email addresses and phone numbers, how often you check in, how many vaults you
have and roughly how large, when you created each one, and when you last opened
the app. Vault *contents* are private. Your *pattern of care* is not.

Reducing this is real work and is on the roadmap (§ production path, phase 3),
but no honest version of this product claims metadata privacy today.

### Traffic analysis and timing
An observer who can see when messages leave our infrastructure can infer that a
specific user's trigger is escalating. For someone whose safety depends on it
not being known that they have gone quiet, that is a real leak.

### Collusion at or above the threshold
Split custody is *k*-of-*n*. If the service colludes with enough of the people
you named, the vault opens. With the default 2-of-3 that means Vigil plus one
verifier. **Choose verifiers who would not co-operate with us against you**, and
raise the threshold if the contents warrant it — the code supports 3-of-5.

### A recipient who is the problem
Vigil delivers to whoever you named. If that person is hostile, or turns out to
be the wrong person to have trusted, nothing here helps. Review your recipients
periodically; the app will prompt you.

### The service ceasing to exist
If Vigil shuts down, triggers stop being evaluated and nothing is ever
delivered. This is the single largest residual risk in the entire product and no
amount of cryptography addresses it. See the production path for the only
answers we think are honest.

## Residual risks, ranked

| Risk | Likelihood | Impact | Status |
|---|---|---|---|
| Company dies; vaults never deliver | **Medium** | Total | **Unsolved.** Needs a legal and financial answer before launch |
| User forgets passphrase | High | Total for that user | Accepted, by design. Mitigated by the recovery share |
| Metadata exposure | Certain | Moderate | Accepted for MVP; documented, on roadmap |
| Premature release | Very low | Severe | Mitigated by asymmetric cascade + hard floor + verifiers |
| Failure to release when it should | Low | Severe | Mitigated by multi-channel escalation and `SILENCE_CONFIRMS` default |
| Threshold collusion | Low | Total for that vault | Mitigated by user's choice of verifier and threshold |
| Crypto implementation flaw | Low | Total | **Needs third-party audit before real users.** Non-negotiable |

## Cryptographic assumptions

- XChaCha20-Poly1305, Argon2id, X25519 and HKDF-SHA256 are sound, via
  `@noble/*` — audited, pure-JS, no native build step.
- Shamir over GF(2⁸) is implemented in-repo and is information-theoretically
  secure below threshold, with a truncated-SHA-256 checksum to distinguish
  "these shares are from different splits" from "here are 32 bytes of garbage".
- The platform CSPRNG is sound. On a phone this is the OS; a weak RNG breaks
  every key we generate and we cannot detect it.
- Argon2id parameters (19 MiB, t=2, p=1 — OWASP's second profile) will need
  raising over the product's lifetime. Parameters are stored per-user alongside
  the salt so they can be raised without invalidating existing accounts.

## Explicitly out of scope for MVP

Nation-state adversaries with device implants; hardware side channels; coercion
of the owner while alive ("rubber hose"); and malicious app-store builds. The
last one is the most tractable and the one we would address first, via
reproducible builds and published hashes.

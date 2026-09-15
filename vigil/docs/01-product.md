# Vigil — the product

## The problem, stated properly

Every adult is carrying an undocumented, unindexed, encrypted-by-obscurity
archive of their own life. Where the will actually is. Which account the family
photos are on. The password manager's master password. What the business owes
and to whom. The name of the person who should be told first. The things that
were never said because there was going to be time.

When someone dies, that archive does not transfer. It evaporates. The family
gets the estate and loses the person — the specific, textured, irreplaceable
knowledge of what mattered and where it was.

The existing options are all bad in the same way: they require you to decide,
now, that you are going to die. Wills are legal instruments written in a
solicitor's office. "Digital legacy" features are buried five levels into
Google's settings. A sealed envelope requires a person you trust with everything
at once, forever.

Vigil's bet is that the barrier is not technical and not legal. It is emotional.
People will do this if it feels like an act of care rather than an act of
morbidity — if it feels less like writing a will and more like leaving a note on
the kitchen table.

## Who this is for

Three groups, in the order we would build for them:

**1. People with someone who depends on them.** A parent of young children, a
carer, a sole earner. The motivation is not their own death, it is the other
person's confusion. This is the largest group and the one the product's tone is
designed for.

**2. People with unusual key material.** Founders, crypto holders, people with
access that dies with them. Sharpest pain, most willing to pay, least
representative. Useful early revenue, dangerous as a design north star — build
for this group first and you end up with a password manager for the deceased,
which is a smaller and colder product.

**3. People in temporary danger.** A journalist filing from somewhere hostile, a
solo expedition, someone going into surgery. Short fuses, high stakes, episodic
use. Important because it is the case that forces the product to support a
48-hour trigger — and forces us to make that safe rather than forbidding it.

## The design brief

> It should feel like a good notebook and a lit candle. Not a filing cabinet.

Most products adjacent to death adopt the visual language of a solicitor's
office: navy, granite, a lighthouse at dusk. That is honest about mortality and
dishonest about what the user is doing, which is an act of love.

So the concrete decisions:

- **Warm paper, ink, and one ember.** Off-white that reads as paper, near-black
  that reads as ink, and a single warm accent used for the flame and nothing
  else. Nothing in the product is ever red — red means error, and none of this
  is an error.
- **A serif for what people wrote, a sans for the machinery.** The distinction
  is load-bearing: it is how the app signals "this part is you" versus "this
  part is us".
- **The flame is the entire status display.** You should be able to tell that
  you are fine from across a room without reading a word. Steady glow: all is
  well. Dimming: we have missed you. Slow pulse: we are trying to reach you.
  Never flashing, never red — this app must not be capable of frightening
  someone who is simply on holiday.
- **The check-in is a press-and-hold, not a tap.** It cannot be done by a pocket,
  it takes about a second and a half, and it ends with a haptic full stop. It is
  the interaction people will perform most and remember the product by, so it is
  a small ritual — a moment of noticing you are here — rather than dismissing a
  notification.
- **No countdown on the home screen by default.** "37 days until your letters
  are sent" turns a quiet safeguard into a memento mori. The number is there,
  phrased gently, below the fold.

## The copy rules

The text in `src/theme/status.ts` is the most safety-critical writing in the
product: someone glances at it for two seconds in a supermarket queue and the
words carry the whole meaning.

1. **Never frighten someone who is fine.** "ESCALATING" is a system state, not
   something to put in front of a human being. It reads *"Trying to reach you."*
2. **Never imply something has been sent when it has not.** The gap between
   "we are trying to reach you" and "your letters have gone out" is the entire
   product, and most of a person's anxiety lives in it.
3. **Always say who, if anyone, has been contacted.** That is the question
   people actually want answered, and every status answers it explicitly —
   including the ones where the answer is "nobody".

## What we deliberately did not build

- **Server-side search over vault contents.** It would require plaintext. The
  whole product is the promise that we do not have it.
- **A password reset.** There is no path from a forgotten passphrase to a
  recovered vault, by construction. A support agent who wanted to help a
  locked-out user could not. This will generate angry reviews and it is correct.
- **Social proof or gamification.** No streaks, no "you've checked in 40 times!"
  Turning mortality into a habit loop is grotesque.
- **AI summaries of what people left.** Technically easy, and a betrayal of the
  one thing being sold.

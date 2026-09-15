/**
 * Vigil's design language.
 *
 * The brief this palette answers: people arrive here having just thought about
 * their own death, usually at night, usually alone. Most products in this space
 * respond to that with the visual language of a solicitor's office — navy,
 * granite, stock photography of a lighthouse — which is honest about mortality
 * and dishonest about what the user is actually doing, which is an act of love.
 *
 * So: warm paper, ink, and one ember. It should feel like a good notebook and a
 * lit candle, not a filing cabinet. Serif for anything a human wrote or will
 * read as a letter; sans for the machinery. The distinction is load-bearing —
 * it is how the app signals "this part is you" versus "this part is us".
 *
 * Nothing in the product is red. Red means error, and none of this is an error.
 */

export const palette = {
  /** Warm off-white. Paper, not screen. */
  paper: '#FBF7F0',
  paperRaised: '#FFFFFF',
  paperSunken: '#F3EDE3',

  /** Deep warm near-black. Ink, not #000 — pure black on warm paper reads as a hole. */
  ink: '#1F1A15',
  inkSoft: '#4A4239',
  inkFaint: '#8A7F71',
  hairline: '#E4DACA',

  /** The ember. The single accent, used for the flame, the pulse, and nothing else. */
  ember: '#C25A1E',
  emberSoft: '#E8894F',
  emberGlow: '#FBE3D2',

  /** All is well. Never "success green" — a muted, botanical sage. */
  sage: '#5B7A63',
  sageSoft: '#DCE6DD',

  /** Attention, not alarm. Used when a trigger is escalating. */
  amber: '#B8860B',
  amberSoft: '#F6EBCE',

  /** Genuine error states only: a failed upload, a lost connection. */
  alert: '#9B2C2C',
} as const;

export const darkPalette = {
  paper: '#14110D',
  paperRaised: '#1E1A15',
  paperSunken: '#0E0C09',
  ink: '#F5EFE5',
  inkSoft: '#C2B8A8',
  inkFaint: '#8A7F71',
  hairline: '#2E2820',
  ember: '#E8894F',
  emberSoft: '#C25A1E',
  emberGlow: '#3A2418',
  sage: '#8FB098',
  sageSoft: '#23301F',
  amber: '#D9A441',
  amberSoft: '#312713',
  alert: '#E07A7A',
} as const;

export type Palette = typeof palette;

/**
 * A 4pt base scale. The larger steps are deliberately generous: this app asks
 * people to make irreversible decisions, and crowded layouts make people click
 * things faster than they read them.
 */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48, huge: 64 } as const;

export const radius = { sm: 6, md: 12, lg: 20, xl: 28, pill: 999 } as const;

/**
 * The pairing carries the product's central distinction, so it is chosen rather
 * than defaulted. Newsreader is an editorial serif with genuine warmth — it
 * reads like something a person wrote to another person, which is what most of
 * the content in Vigil actually is. IBM Plex Sans is precise and faintly
 * technical, which is right for the machinery: countdowns, statuses, buttons.
 *
 * The contrast is the point. When the type changes, the voice changes, and the
 * user can feel which parts are theirs and which parts are ours.
 */
export const type = {
  /** Anything a person wrote, or will read as if a person wrote it. */
  serif: 'Newsreader',
  /** The machinery: labels, buttons, status, numbers. */
  sans: 'IBM Plex Sans',
  /**
   * Fallbacks with close metrics, so a failed load degrades to something of
   * roughly the right colour and width rather than reflowing every screen.
   * See `theme/fonts.ts` for how the real faces are registered and chosen.
   */
  serifFallback: 'Georgia, "Times New Roman", serif',
  sansFallback: 'system-ui, -apple-system, "Segoe UI", sans-serif',
} as const;

export const scale = {
  display: { size: 34, lineHeight: 42, weight: '600' as const },
  title: { size: 26, lineHeight: 33, weight: '600' as const },
  heading: { size: 20, lineHeight: 27, weight: '600' as const },
  body: { size: 16, lineHeight: 25, weight: '400' as const },
  /** Letters and notes are set slightly larger and looser. People read them slowly. */
  letter: { size: 18, lineHeight: 30, weight: '400' as const },
  label: { size: 13, lineHeight: 18, weight: '600' as const },
  caption: { size: 13, lineHeight: 19, weight: '400' as const },
} as const;

/**
 * Elevation is warm and low-contrast. Hard grey drop-shadows on warm paper look
 * like a bug; these read as the page lifting slightly.
 */
export const elevation = {
  resting: {
    shadowColor: '#3A2A18',
    shadowOpacity: 0.07,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  lifted: {
    shadowColor: '#3A2A18',
    shadowOpacity: 0.12,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
} as const;

export const motion = {
  /** Fast enough to feel responsive, slow enough not to feel flippant. */
  quick: 180,
  settle: 320,
  /** The check-in hold. Long enough to be a deliberate act, short enough not to annoy. */
  pulseHold: 1400,
  /** The breath cycle of the resting flame. */
  breath: 3800,
} as const;

# Aleris Originality

A plagiarism / similarity checker built for the Aleris team: paste or import a
document, screen it against the team's reference library, and get an
evidence-first report — every percentage point traceable to a highlighted
passage and its source. Everything runs client-side in the browser; documents
never touch a server.

> The previous contents of this repository (the Aleris landing page) are
> preserved untouched in [`archive/landing-page/`](archive/landing-page/).

## What it detects

Four layers are combined per word of the checked document, so rewording one
layer can't defeat the whole check:

| Layer | Catches | How |
|---|---|---|
| Normalization | Case/punctuation changes, Cyrillic/Greek **homoglyph substitution**, **zero-width character injection**, diacritic tricks, hyphenation differences | NFKC + casefold + homoglyph folding + invisible-character stripping before any comparison |
| Verbatim spans | Copied passages, even embedded in new text | Word-trigram seeding extended to maximal runs, greedily tiled |
| Sentence alignment | Light edits, word swaps, reordered clauses, loose paraphrase | Stem-sequence LCS + content-word Jaccard/containment per sentence, against the best-matching source sentence |
| Winnowed fingerprints | Document-level reuse that survives reordering | MOSS-style k-gram winnowing, containment scored |

Quoted passages and a trailing References/Bibliography section can be excluded
from the score (on by default) — citing honestly is the opposite of hiding a
source. Every report labels matches as **verbatim / edited / paraphrase-like**
and shows them side-by-side with the source, because the tool's job is to give
a reviewer a precise map of overlap, not to convict anyone.

## Using it

- **Check** — paste/drop a document (`.txt`, `.md`, `.docx`; for PDFs paste the
  text), run against the whole library or a single pasted reference. The report
  gives the similarity index, a composition breakdown, a sentence map, and
  per-source side-by-side views with click-to-jump highlights. Export as a
  standalone HTML report or a Markdown summary.
- **Cross-compare** — every pair in the library screened against each other
  (collusion/reuse check for a batch of submissions), as a heatmap plus ranked
  pairs with side-by-side detail.
- **Library** — the reference set. Stored in the browser (localStorage), plus:
  - **Team library** (claude.ai artifact only): one shared reference set saved
    into the artifact itself — teammates open the artifact and get the same
    library. Explicit save, attributed to whoever saves.
  - **JSON export/import** for moving a library between machines, or commit a
    `data/library.json` to this repo and any static host will serve it as the
    shared starting set.

## Ways to run it

1. **Shared artifact (recommended for the team)** — the app is published as a
   claude.ai Artifact; share that link with the team. Team-library saving works
   there.
2. **Static hosting / GitHub Pages** — serve this repo as-is (`index.html` at
   the root). No build step, no backend.
3. **Single file** — `dist/aleris-originality.html` is the whole app in one
   file; open it from disk or email it.

## Development

```
├── index.html            app shell
├── styles.css            design system (light + dark, brand tokens)
├── js/engine.js          detection engine — pure, DOM-free, Node-testable
├── js/app.js             UI, library storage, team sync, imports/exports
├── test/engine.test.js   accuracy suite (node --test)
└── tools/build-single-file.mjs   builds dist/ from the sources
```

```bash
node --test test/engine.test.js   # 26 accuracy + robustness tests
node tools/build-single-file.mjs  # regenerate dist/ after changing sources
```

The engine has no dependencies. The app's only external code is JSZip (from
cdnjs, for `.docx` import) and Google Fonts — both optional at runtime; the app
degrades gracefully without network access.

## Honest limitations

- It measures **textual overlap against the reference set you give it** — it
  does not search the open web, and it is not an AI-generated-text detector.
- Scoring is tuned for English (stemmer, stopwords); other languages still get
  verbatim and fingerprint layers.
- A high score is a starting point for human review, never a verdict.

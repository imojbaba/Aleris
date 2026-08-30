"use strict";
const test = require("node:test");
const assert = require("node:assert");
const E = require("../js/engine.js");

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const SOURCE = `The measurement of document similarity has a long history in information
retrieval. Early systems relied on exact string matching, which fails as soon as
a single word changes. Modern detectors instead combine several signals: word
n-gram fingerprints survive reordering, sentence-level alignment captures light
edits, and normalized token streams defeat character tricks. A trustworthy
checker must explain its verdict, showing exactly which passages match and where
they came from. Scores without evidence are worse than no scores at all, because
they invite both false confidence and false accusation. The goal is not to
convict anyone but to give reviewers a precise map of overlap.`;

const ORIGINAL = `Our quarterly planning ritual starts with a shared meal. Every
team member brings one dish and one idea worth defending. By the time dessert
arrives we have usually argued our way to three priorities. The kitchen
whiteboard keeps the score, and nobody leaves until the owner of each priority
has written a first step beside it. It is chaotic, warm, and surprisingly
efficient.`;

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

test("normToken folds case, punctuation and diacritics", () => {
  assert.equal(E.normToken("Naïve"), "naive");
  assert.equal(E.normToken("don’t"), "dont");
  assert.equal(E.normToken("co-operate"), "cooperate");
});

test("normToken folds Cyrillic and Greek homoglyphs to Latin", () => {
  // "рlаgіаrіsm" below uses Cyrillic р, а, і
  assert.equal(E.normToken("рлаgіаrіsm".replace("л", "l")), "plagiarism");
  assert.equal(E.normToken("Αlpha"), "alpha"); // Greek capital Alpha
});

test("tokenize strips zero-width characters but keeps original offsets", () => {
  const text = "hidden​ copy‍ here";
  const doc = E.tokenize(text);
  assert.deepEqual(doc.tokens.map(t => t.norm), ["hidden", "copy", "here"]);
  for (const t of doc.tokens) {
    // offsets must slice the ORIGINAL string to the raw token
    assert.equal(text.slice(t.start, t.end).replace(/[​‍]/g, ""), t.raw);
  }
});

test("tokenize offsets always slice back to the raw token", () => {
  const text = "It’s a test — with “quotes” and 3.14 numbers.\nNew line!";
  const doc = E.tokenize(text);
  for (const t of doc.tokens) {
    assert.equal(text.slice(t.start, t.end), t.raw);
  }
});

test("sentence segmentation respects abbreviations and decimals", () => {
  const doc = E.tokenize("Dr. Smith measured 3.14 units. The result held. See Fig. 2 for detail.");
  assert.equal(doc.sentences.length, 3);
});

/* ------------------------------------------------------------------ *
 * Verbatim span detection
 * ------------------------------------------------------------------ */

test("identical documents are one full-length verbatim span", () => {
  const a = E.tokenize(SOURCE), b = E.tokenize(SOURCE);
  const spans = E.findVerbatimSpans(a.tokens, b.tokens, 5);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].length, a.tokens.length);
});

test("a copied paragraph inside an original document is found with exact offsets", () => {
  const stolen = "word n-gram fingerprints survive reordering, sentence-level alignment captures light edits";
  const suspectText = ORIGINAL + "\n\n" + stolen + "\n\nAnd then we all went home.";
  const suspect = E.tokenize(suspectText);
  const source = E.tokenize(SOURCE);
  const spans = E.findVerbatimSpans(suspect.tokens, source.tokens, 5);
  assert.equal(spans.length, 1);
  const sp = spans[0];
  const matched = suspectText.slice(
    suspect.tokens[sp.aStart].start, suspect.tokens[sp.aEnd - 1].end);
  assert.ok(matched.includes("fingerprints survive reordering"));
  assert.ok(!matched.includes("quarterly")); // must not bleed into original text
});

test("case, punctuation and homoglyph changes do not break verbatim detection", () => {
  const disguised = SOURCE
    .replace(/a/g, "а")      // every Latin a -> Cyrillic а
    .replace(/e/g, "е")      // every Latin e -> Cyrillic е
    .toUpperCase();
  const a = E.tokenize(disguised), b = E.tokenize(SOURCE);
  const spans = E.findVerbatimSpans(a.tokens, b.tokens, 5);
  assert.ok(spans.length >= 1);
  const covered = spans.reduce((s, x) => s + x.length, 0);
  assert.ok(covered / a.tokens.length > 0.95,
    `expected >95% covered, got ${covered}/${a.tokens.length}`);
});

test("zero-width character injection does not hide copied text", () => {
  const sabotaged = SOURCE.split("").join("​");
  const a = E.tokenize(sabotaged), b = E.tokenize(SOURCE);
  const spans = E.findVerbatimSpans(a.tokens, b.tokens, 5);
  const covered = spans.reduce((s, x) => s + x.length, 0);
  assert.ok(covered / b.tokens.length > 0.95);
});

test("unrelated documents produce no verbatim spans", () => {
  const a = E.tokenize(ORIGINAL), b = E.tokenize(SOURCE);
  const spans = E.findVerbatimSpans(a.tokens, b.tokens, 5);
  assert.equal(spans.length, 0);
});

/* ------------------------------------------------------------------ *
 * Sentence alignment (edits + paraphrase)
 * ------------------------------------------------------------------ */

test("light word substitutions are classified as near-match", () => {
  const src = E.tokenize("The committee approved the budget after a long debate over infrastructure spending priorities.");
  const sus = E.tokenize("The committee endorsed the budget after a lengthy debate over infrastructure spending priorities.");
  const pairs = E.alignSentences(sus, src, E.DEFAULT_OPTS);
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].cls >= E.CLS.NEAR, `expected NEAR+, got cls=${pairs[0].cls}`);
});

test("reordered clauses with shared vocabulary are flagged as paraphrase or better", () => {
  const src = E.tokenize("Renewable energy adoption accelerated sharply because storage costs collapsed during the decade.");
  const sus = E.tokenize("Because storage costs collapsed during the decade, adoption of renewable energy sharply accelerated.");
  const pairs = E.alignSentences(sus, src, E.DEFAULT_OPTS);
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].cls >= E.CLS.PARAPHRASE);
});

test("hyphenated and open compound spellings align as verbatim", () => {
  const src = E.tokenize("The sentence-level alignment step captures light edits across long-term document sets.");
  const sus = E.tokenize("The sentence level alignment step captures light edits across long term document sets.");
  const spans = E.findVerbatimSpans(sus.tokens, src.tokens, 5);
  const covered = spans.reduce((s, x) => s + x.length, 0);
  assert.ok(covered >= sus.tokens.length - 1, `expected full coverage, got ${covered}/${sus.tokens.length}`);
});

test("a loose paraphrase of a substantial sentence is still flagged", () => {
  const src = E.tokenize("Modern detectors therefore combine several signals: word n-gram fingerprints survive reordering, sentence-level alignment captures light edits, and normalized token streams defeat character tricks.");
  const sus = E.tokenize("We also believe detectors should mix multiple signals, since fingerprints of word n-grams keep working after reordering while alignment at the sentence level picks up light edits.");
  const pairs = E.alignSentences(sus, src, E.DEFAULT_OPTS);
  assert.equal(pairs.length, 1, "paraphrased sentence should match");
  assert.ok(pairs[0].cls >= E.CLS.PARAPHRASE);
});

test("a long topical sentence sharing a few terms is NOT flagged", () => {
  const src = E.tokenize("Modern detectors therefore combine several signals: word n-gram fingerprints survive reordering, sentence-level alignment captures light edits, and normalized token streams defeat character tricks.");
  const sus = E.tokenize("Our detectors dashboard shows weekly signals from customer interviews, and the team reviews every word of feedback before planning the next sprint together.");
  const pairs = E.alignSentences(sus, src, E.DEFAULT_OPTS);
  assert.equal(pairs.length, 0, `should not flag, got ${JSON.stringify(pairs)}`);
});

test("genuinely different sentences on the same topic are NOT flagged", () => {
  const src = E.tokenize("Renewable energy adoption accelerated sharply because storage costs collapsed during the decade.");
  const sus = E.tokenize("Wind turbines require regular gearbox maintenance in coastal climates.");
  const pairs = E.alignSentences(sus, src, E.DEFAULT_OPTS);
  assert.equal(pairs.length, 0);
});

/* ------------------------------------------------------------------ *
 * Fingerprints
 * ------------------------------------------------------------------ */

test("fingerprint containment: high for copies, low for unrelated text", () => {
  const a = E.tokenize(SOURCE);
  const b = E.tokenize(ORIGINAL);
  const fa = E.fingerprints(a.tokens), fa2 = E.fingerprints(E.tokenize(SOURCE).tokens);
  assert.equal(E.containment(fa, fa2), 1);
  assert.ok(E.containment(fa, E.fingerprints(b.tokens)) < 0.05);
});

/* ------------------------------------------------------------------ *
 * analyze() end to end
 * ------------------------------------------------------------------ */

test("analyze: identical document scores ~100%, extensive verdict", () => {
  const r = E.analyze(SOURCE, [{ id: "s1", title: "Source", text: SOURCE }]);
  assert.ok(r.similarityIndex > 0.97, `got ${r.similarityIndex}`);
  assert.equal(r.verdict.level, "severe");
});

test("analyze: unrelated document scores ~0%, low verdict", () => {
  const r = E.analyze(ORIGINAL, [{ id: "s1", title: "Source", text: SOURCE }]);
  assert.ok(r.similarityIndex < 0.05, `got ${r.similarityIndex}`);
  assert.equal(r.verdict.level, "low");
});

test("analyze: mixed document reports the copied share, not more", () => {
  const stolen = "Modern detectors instead combine several signals: word n-gram fingerprints survive reordering, sentence-level alignment captures light edits, and normalized token streams defeat character tricks.";
  const suspect = ORIGINAL + "\n\n" + stolen;
  const r = E.analyze(suspect, [{ id: "s1", title: "Source", text: SOURCE }]);
  const stolenWords = E.tokenize(stolen).tokens.length;
  const totalWords = r.words;
  const expected = stolenWords / totalWords;
  assert.ok(Math.abs(r.similarityIndex - expected) < 0.06,
    `similarity ${r.similarityIndex} should be near ${expected.toFixed(3)}`);
  assert.ok(r.counts.verbatim >= stolenWords - 2);
});

test("analyze: quoted matches are excluded from the score but reported", () => {
  const quoted = `${ORIGINAL}\n\nAs the paper puts it, “Early systems relied on exact string matching, which fails as soon as a single word changes.”`;
  const withQuotes = E.analyze(quoted, [{ id: "s1", title: "Source", text: SOURCE }], { ignoreQuotes: true });
  const withoutQuotes = E.analyze(quoted, [{ id: "s1", title: "Source", text: SOURCE }], { ignoreQuotes: false });
  assert.ok(withQuotes.counts.quoted > 10, "quoted tokens should be counted");
  assert.ok(withQuotes.similarityIndex < 0.02, `quoted-excluded score should be ~0, got ${withQuotes.similarityIndex}`);
  assert.ok(withoutQuotes.similarityIndex > 0.10, "same text must score when quotes are not excluded");
});

test("analyze: references section is excluded when enabled", () => {
  const doc = `${ORIGINAL}\n\nReferences\n\nEarly systems relied on exact string matching, which fails as soon as a single word changes. Modern detectors instead combine several signals: word n-gram fingerprints survive reordering.`;
  const r = E.analyze(doc, [{ id: "s1", title: "Source", text: SOURCE }], { ignoreReferences: true });
  assert.ok(r.counts.refs > 20);
  assert.ok(r.similarityIndex < 0.02, `got ${r.similarityIndex}`);
});

test("analyze: attribution points flagged tokens at the right source", () => {
  const stolen = "A trustworthy checker must explain its verdict, showing exactly which passages match and where they came from.";
  const r = E.analyze(ORIGINAL + " " + stolen, [
    { id: "other", title: "Unrelated", text: "Completely different material about gardening tulips in spring soil." },
    { id: "real", title: "Real source", text: SOURCE }
  ]);
  assert.equal(r.perSource[0].id, "real");
  const flaggedSrc = new Set(r.tokenMeta.filter(t => t.cls === E.CLS.VERBATIM).map(t => t.src));
  assert.deepEqual([...flaggedSrc], [1]); // index 1 = the real source
});

test("analyze: span offsets slice the suspect text to real matched content", () => {
  const stolen = "Scores without evidence are worse than no scores at all, because they invite both false confidence and false accusation.";
  const suspectText = ORIGINAL + "\n\n" + stolen;
  const r = E.analyze(suspectText, [{ id: "s1", title: "Source", text: SOURCE }]);
  const span = r.perSource[0].spans[0];
  const sliced = suspectText.slice(span.suspect.start, span.suspect.end);
  assert.ok(sliced.includes("Scores without evidence"));
  assert.ok(span.sourceText.includes("Scores without evidence"));
});

/* ------------------------------------------------------------------ *
 * Cross-compare
 * ------------------------------------------------------------------ */

test("crossCompare finds the colluding pair in a set", () => {
  const docs = [
    { id: "a", title: "A", text: ORIGINAL },
    { id: "b", title: "B", text: SOURCE },
    { id: "c", title: "C", text: ORIGINAL.replace("shared meal", "communal dinner").replace("three priorities", "three goals") }
  ];
  const m = E.crossCompare(docs);
  assert.equal(m.cells.length, 3);
  const byPair = Object.fromEntries(m.cells.map(c => [`${c.a}${c.b}`, c.max]));
  assert.ok(byPair["02"] > 0.8, `A~C should be high, got ${byPair["02"]}`);
  assert.ok(byPair["01"] < 0.05, `A~B should be low, got ${byPair["01"]}`);
  assert.ok(byPair["12"] < 0.05, `B~C should be low, got ${byPair["12"]}`);
});

/* ------------------------------------------------------------------ *
 * Scale smoke test
 * ------------------------------------------------------------------ */

test("20k-word comparison completes quickly", () => {
  const para = SOURCE + " " + ORIGINAL + " ";
  let big = "";
  for (let i = 0; i < 120; i++) big += para.replace(/similarity/g, "similarity" + i);
  const t0 = Date.now();
  const r = E.analyze(big, [{ id: "s", title: "S", text: para.repeat(45) }]);
  const ms = Date.now() - t0;
  assert.ok(r.tokens > 18000, `expected big doc, got ${r.tokens} tokens`);
  assert.ok(ms < 15000, `analysis took ${ms}ms`);
});

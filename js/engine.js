/*
 * Aleris Originality — detection engine.
 *
 * Pure text analysis, no DOM. Runs in the browser (window.AlerisEngine)
 * and in Node (module.exports) so the same code is unit-tested directly.
 *
 * Detection layers, combined per token of the checked document:
 *   1. Normalization — NFKC, casefold, homoglyph folding (Cyrillic/Greek
 *      look-alikes), zero-width/soft-hyphen stripping, diacritic removal.
 *      Defeats character-substitution and invisible-character evasion.
 *   2. Verbatim spans — word-trigram seeding + greedy extension to maximal
 *      runs. Catches copied passages even when surrounded by new text.
 *   3. Sentence alignment — every sentence scored against its best source
 *      sentence (token-sequence LCS + stemmed content-word Jaccard).
 *      Catches light edits, word swaps, and reordering-style paraphrase.
 *   4. Winnowed fingerprints (MOSS-style) — document-level containment,
 *      robust to reordering and interleaving.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AlerisEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Normalization
   * ------------------------------------------------------------------ */

  // Common Cyrillic/Greek characters that render identically (or nearly so)
  // to Latin letters — a classic way to sneak copied text past a checker.
  var HOMOGLYPHS = {
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c",
    "у": "y", "х": "x", "і": "i", "ј": "j", "һ": "h",
    "ѕ": "s", "ґ": "r", "А": "a", "В": "b", "Е": "e",
    "К": "k", "М": "m", "Н": "h", "О": "o", "Р": "p",
    "С": "c", "Т": "t", "Х": "x", "Ѕ": "s", "І": "i",
    "α": "a", "ο": "o", "ε": "e", "ν": "v", "ρ": "p",
    "τ": "t", "υ": "u", "κ": "k", "Α": "a", "Β": "b",
    "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k",
    "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t",
    "Υ": "y", "Χ": "x", "ℓ": "l", "ǃ": "!"
  };

  var ZERO_WIDTH_RE = /[\u200B-\u200F\u2060\uFEFF\u00AD\u180E]/g;
  var ZERO_WIDTH_ONE = /[\u200B-\u200F\u2060\uFEFF\u00AD\u180E]/;
  var COMBINING_RE = /[\u0300-\u036f]/g;
  var WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’ʼ-]*/gu;

  function foldChar(ch) {
    return HOMOGLYPHS[ch] || ch;
  }

  // Normalize one raw token to its canonical comparison form.
  function normToken(raw) {
    var s = raw.normalize("NFKC").toLowerCase();
    var out = "";
    for (var i = 0; i < s.length; i++) out += foldChar(s[i]);
    out = out.normalize("NFD").replace(COMBINING_RE, "");
    out = out.replace(/['’ʼ-]/g, "");
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Porter stemmer (standard algorithm, compact)
   * ------------------------------------------------------------------ */

  var STEP2 = [["ational","ate"],["tional","tion"],["enci","ence"],["anci","ance"],
    ["izer","ize"],["bli","ble"],["alli","al"],["entli","ent"],["eli","e"],
    ["ousli","ous"],["ization","ize"],["ation","ate"],["ator","ate"],["alism","al"],
    ["iveness","ive"],["fulness","ful"],["ousness","ous"],["aliti","al"],
    ["iviti","ive"],["biliti","ble"],["logi","log"]];
  var STEP3 = [["icate","ic"],["ative",""],["alize","al"],["iciti","ic"],
    ["ical","ic"],["ful",""],["ness",""]];
  var STEP4 = ["al","ance","ence","er","ic","able","ible","ant","ement","ment",
    "ent","ion","ou","ism","ate","iti","ous","ive","ize"];

  function isCons(w, i) {
    var c = w[i];
    if ("aeiou".indexOf(c) >= 0) return false;
    if (c === "y") return i === 0 ? true : !isCons(w, i - 1);
    return true;
  }
  function measure(w) {
    var m = 0, i = 0, n = w.length;
    while (i < n && isCons(w, i)) i++;
    while (i < n) {
      while (i < n && !isCons(w, i)) i++;
      if (i >= n) break;
      m++;
      while (i < n && isCons(w, i)) i++;
    }
    return m;
  }
  function hasVowel(w) {
    for (var i = 0; i < w.length; i++) if (!isCons(w, i)) return true;
    return false;
  }
  function cvc(w) {
    var n = w.length;
    if (n < 3) return false;
    if (!isCons(w, n - 1) || isCons(w, n - 2) || !isCons(w, n - 3)) return false;
    return "wxy".indexOf(w[n - 1]) < 0;
  }
  function stem(word) {
    var w = word;
    if (w.length < 3) return w;
    // 1a
    if (w.endsWith("sses")) w = w.slice(0, -2);
    else if (w.endsWith("ies")) w = w.slice(0, -2);
    else if (!w.endsWith("ss") && w.endsWith("s")) w = w.slice(0, -1);
    // 1b
    var flag = false;
    if (w.endsWith("eed")) {
      if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
    } else if (w.endsWith("ed") && hasVowel(w.slice(0, -2))) {
      w = w.slice(0, -2); flag = true;
    } else if (w.endsWith("ing") && hasVowel(w.slice(0, -3))) {
      w = w.slice(0, -3); flag = true;
    }
    if (flag) {
      if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
      else if (w.length >= 2 && w[w.length - 1] === w[w.length - 2] &&
        isCons(w, w.length - 1) && "lsz".indexOf(w[w.length - 1]) < 0) w = w.slice(0, -1);
      else if (measure(w) === 1 && cvc(w)) w += "e";
    }
    // 1c
    if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + "i";
    // 2
    for (var i = 0; i < STEP2.length; i++) {
      var suf = STEP2[i][0];
      if (w.endsWith(suf)) {
        var base = w.slice(0, -suf.length);
        if (measure(base) > 0) w = base + STEP2[i][1];
        break;
      }
    }
    // 3
    for (i = 0; i < STEP3.length; i++) {
      suf = STEP3[i][0];
      if (w.endsWith(suf)) {
        base = w.slice(0, -suf.length);
        if (measure(base) > 0) w = base + STEP3[i][1];
        break;
      }
    }
    // 4
    for (i = 0; i < STEP4.length; i++) {
      suf = STEP4[i];
      if (w.endsWith(suf)) {
        base = w.slice(0, -suf.length);
        if (suf === "ion") {
          if (measure(base) > 1 && (base.endsWith("s") || base.endsWith("t"))) w = base;
        } else if (measure(base) > 1) w = base;
        break;
      }
    }
    // 5a
    if (w.endsWith("e")) {
      base = w.slice(0, -1);
      if (measure(base) > 1 || (measure(base) === 1 && !cvc(base))) w = base;
    }
    // 5b
    if (measure(w) > 1 && w.endsWith("ll")) w = w.slice(0, -1);
    return w;
  }

  var STOPWORDS = new Set(("a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours").split(" "));

  /* ------------------------------------------------------------------ *
   * Tokenization + sentence segmentation
   * ------------------------------------------------------------------ */

  var ABBREV = new Set(["dr","mr","mrs","ms","prof","sr","jr","st","vs","etc","fig","eg","ie","al","no","vol","pp","cf","approx","dept","est","inc","ltd","co"]);

  // Tokenize `text`, keeping char offsets into the ORIGINAL string so every
  // finding maps back to exact highlight positions.
  function tokenize(text) {
    var clean = text.replace(ZERO_WIDTH_RE, "");
    // Zero-width strip changes offsets; build an offset map only if needed.
    var offsetMap = null;
    if (clean.length !== text.length) {
      offsetMap = new Array(clean.length);
      var j = 0;
      for (var i = 0; i < text.length; i++) {
        if (!ZERO_WIDTH_ONE.test(text[i])) { offsetMap[j] = i; j++; }
      }
    }
    var tokens = [];
    var m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(clean)) !== null) {
      // Split hyphenated compounds ("sentence-level" -> "sentence","level")
      // so hyphenated and open spellings of the same phrase align.
      var parts = m[0].split(/[-‐‑]+/);
      var offset = 0;
      for (var p = 0; p < parts.length; p++) {
        var piece = parts[p];
        var pieceIdx = m[0].indexOf(piece, offset);
        offset = pieceIdx + piece.length;
        var norm = normToken(piece);
        if (!norm) continue;
        var startIdx = m.index + pieceIdx;
        var endIdx = startIdx + piece.length - 1;
        tokens.push({
          raw: piece, norm: norm, stem: stem(norm),
          start: offsetMap ? offsetMap[startIdx] : startIdx,
          end: (offsetMap ? offsetMap[endIdx] : endIdx) + 1,
          sent: 0
        });
      }
    }
    var sentences = segmentSentences(text, tokens);
    return { text: text, tokens: tokens, sentences: sentences };
  }

  // Sentence boundaries: terminal punctuation followed by whitespace + an
  // opener, or any hard line break. Guards against abbreviations and decimals.
  function segmentSentences(text, tokens) {
    var boundaries = [0];
    var re = /[.!?…]+[)"'”’\]]*\s+|\n+/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var end = m.index + m[0].length;
      if (end >= text.length) break;
      if (m[0][0] !== "\n") {
        var next = text[end];
        if (!/[\p{Lu}\p{N}"'“‘(\[••-]/u.test(next)) continue;
        // decimal like 3.14 — no whitespace group would match, safe; abbreviation guard:
        var before = text.slice(Math.max(0, m.index - 12), m.index);
        var wm = before.match(/([\p{L}]+)$/u);
        if (wm && ABBREV.has(wm[1].toLowerCase()) && wm[1].length <= 6) continue;
      }
      if (boundaries[boundaries.length - 1] !== end) boundaries.push(end);
    }
    boundaries.push(text.length + 1);
    var sentences = [];
    var ti = 0;
    for (var b = 0; b < boundaries.length - 1; b++) {
      var s = boundaries[b], e = boundaries[b + 1];
      var first = ti;
      while (ti < tokens.length && tokens[ti].start < e) {
        tokens[ti].sent = sentences.length;
        ti++;
      }
      if (ti > first) {
        sentences.push({
          start: tokens[first].start,
          end: tokens[ti - 1].end,
          tokenStart: first,
          tokenCount: ti - first
        });
      }
      if (ti >= tokens.length) break;
    }
    return sentences;
  }

  /* ------------------------------------------------------------------ *
   * Exclusion zones (quoted passages, reference sections)
   * ------------------------------------------------------------------ */

  var CLS = { NONE: 0, PARAPHRASE: 1, NEAR: 2, VERBATIM: 3, QUOTED: 4, REFS: 5 };

  // Mark tokens inside "..."/“...” pairs (up to maxLen chars) as quoted.
  function markQuoted(doc, excl) {
    var text = doc.text;
    var maxLen = 800;
    var pairs = [["“", "”"], ['"', '"']];
    for (var p = 0; p < pairs.length; p++) {
      var open = pairs[p][0], close = pairs[p][1];
      var i = 0;
      while ((i = text.indexOf(open, i)) !== -1) {
        var j = text.indexOf(close, i + 1);
        if (j === -1) break;
        if (j - i <= maxLen) {
          for (var t = 0; t < doc.tokens.length; t++) {
            if (doc.tokens[t].start > i && doc.tokens[t].end <= j + 1) excl[t] = CLS.QUOTED;
            if (doc.tokens[t].start > j) break;
          }
        }
        i = j + 1;
      }
    }
  }

  // Mark everything from a trailing References/Bibliography heading onward.
  function markReferences(doc, excl) {
    var re = /^[ \t>#*]*(references|bibliography|works cited|sources|citations)[ \t:]*$/gim;
    var m, last = -1;
    while ((m = re.exec(doc.text)) !== null) last = m.index;
    // Only treat it as a section if it sits in the back half of the document.
    if (last === -1 || last < doc.text.length * 0.4) return;
    for (var t = 0; t < doc.tokens.length; t++) {
      if (doc.tokens[t].start >= last) excl[t] = CLS.REFS;
    }
  }

  /* ------------------------------------------------------------------ *
   * Layer 2 — verbatim span detection
   * ------------------------------------------------------------------ */

  var SEED = 3; // trigram seeding

  // All maximal runs of identical normalized tokens between A and B,
  // at least minRun tokens long. Greedy tiling: longest spans claim their
  // A-tokens first so overlapping seeds don't double-report.
  function findVerbatimSpans(tokA, tokB, minRun) {
    if (tokA.length < SEED || tokB.length < SEED) return [];
    var index = new Map();
    for (var j = 0; j + SEED <= tokB.length; j++) {
      var key = tokB[j].norm + "\u0001" + tokB[j + 1].norm + "\u0001" + tokB[j + 2].norm;
      var arr = index.get(key);
      if (arr) arr.push(j); else index.set(key, [j]);
    }
    var raw = [];
    var seen = new Set();
    for (var i = 0; i + SEED <= tokA.length; i++) {
      var k = tokA[i].norm + "\u0001" + tokA[i + 1].norm + "\u0001" + tokA[i + 2].norm;
      var hits = index.get(k);
      if (!hits) continue;
      for (var h = 0; h < hits.length; h++) {
        var b = hits[h];
        // extend left
        var ai = i, bj = b;
        while (ai > 0 && bj > 0 && tokA[ai - 1].norm === tokB[bj - 1].norm) { ai--; bj--; }
        var id = ai + ":" + bj;
        if (seen.has(id)) continue;
        // extend right from the left-anchored start
        var len = 0;
        while (ai + len < tokA.length && bj + len < tokB.length &&
          tokA[ai + len].norm === tokB[bj + len].norm) len++;
        seen.add(id);
        if (len >= minRun) raw.push({ a: ai, b: bj, len: len });
      }
    }
    raw.sort(function (x, y) { return y.len - x.len || x.a - y.a; });
    var claimed = new Uint8Array(tokA.length);
    var spans = [];
    for (var r = 0; r < raw.length; r++) {
      var sp = raw[r];
      var free = 0;
      for (var t = sp.a; t < sp.a + sp.len; t++) if (!claimed[t]) free++;
      if (free < Math.min(minRun, sp.len)) continue; // mostly re-reports a longer span
      for (t = sp.a; t < sp.a + sp.len; t++) claimed[t] = 1;
      spans.push({ aStart: sp.a, aEnd: sp.a + sp.len, bStart: sp.b, bEnd: sp.b + sp.len, length: sp.len });
    }
    spans.sort(function (x, y) { return x.aStart - y.aStart; });
    return spans;
  }

  /* ------------------------------------------------------------------ *
   * Layer 3 — sentence alignment
   * ------------------------------------------------------------------ */

  function lcsLength(a, b) {
    var n = a.length, m = b.length;
    if (!n || !m) return 0;
    var prev = new Uint16Array(m + 1), cur = new Uint16Array(m + 1);
    for (var i = 1; i <= n; i++) {
      for (var j = 1; j <= m; j++) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : (prev[j] > cur[j - 1] ? prev[j] : cur[j - 1]);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[m];
  }

  function sentenceTokens(doc, s) {
    return doc.tokens.slice(s.tokenStart, s.tokenStart + s.tokenCount);
  }
  function contentStems(toks) {
    var set = new Set();
    for (var i = 0; i < toks.length; i++) {
      if (!STOPWORDS.has(toks[i].norm)) set.add(toks[i].stem);
    }
    return set;
  }
  function jaccard(a, b) {
    if (!a.size || !b.size) return { sim: 0, shared: 0 };
    var inter = 0;
    a.forEach(function (v) { if (b.has(v)) inter++; });
    return { sim: inter / (a.size + b.size - inter), shared: inter };
  }

  // Score every suspect sentence against its best source sentence.
  // Candidates come from a stem inverted index, so cost stays near-linear.
  // Excluded tokens (quoted/references) don't participate in scoring, so a
  // sentence that is mostly a quotation isn't flagged for its lead-in words.
  function alignSentences(suspect, source, opts, excl) {
    var inv = new Map();
    var srcMeta = [];
    for (var j = 0; j < source.sentences.length; j++) {
      var st = sentenceTokens(source, source.sentences[j]);
      var stems = contentStems(st);
      srcMeta.push({ toks: st, stems: stems });
      stems.forEach(function (s) {
        var arr = inv.get(s);
        if (arr) arr.push(j); else inv.set(s, [j]);
      });
    }
    var results = [];
    for (var i = 0; i < suspect.sentences.length; i++) {
      var sent = suspect.sentences[i];
      var toks = sentenceTokens(suspect, sent);
      if (excl) {
        toks = toks.filter(function (t, idx) { return !excl[sent.tokenStart + idx]; });
      }
      if (toks.length < 4) continue; // too short to be meaningful
      var stems = contentStems(toks);
      if (stems.size === 0) continue;
      var counts = new Map();
      stems.forEach(function (s) {
        var arr = inv.get(s);
        if (!arr) return;
        for (var x = 0; x < arr.length; x++) counts.set(arr[x], (counts.get(arr[x]) || 0) + 1);
      });
      var cands = Array.from(counts.entries())
        .filter(function (e) { return e[1] >= Math.max(2, stems.size * 0.34); })
        .sort(function (a, b) { return b[1] - a[1]; })
        .slice(0, 8);
      var best = null;
      for (var c = 0; c < cands.length; c++) {
        var meta = srcMeta[cands[c][0]];
        // LCS over stems, so inflection changes (capture/captures/captured)
        // still count toward sequence similarity.
        var seqA = toks.map(function (t) { return t.stem; });
        var seqB = meta.toks.map(function (t) { return t.stem; });
        var lcs = lcsLength(seqA, seqB);
        var seqSim = (2 * lcs) / (seqA.length + seqB.length);
        var jc = jaccard(stems, meta.stems);
        var lenRatio = Math.min(toks.length, meta.toks.length) / Math.max(toks.length, meta.toks.length);
        var score = Math.max(seqSim, jc.sim * 0.92 * Math.min(1, lenRatio + 0.35));
        if (!best || score > best.score) {
          best = { srcSent: cands[c][0], seqSim: seqSim, setSim: jc.sim,
                   shared: jc.shared, contain: jc.shared / stems.size, score: score };
        }
      }
      if (!best) continue;
      var cls = null;
      if (best.seqSim >= 0.95) cls = CLS.VERBATIM;
      else if (best.seqSim >= 0.7 || (best.setSim >= 0.8 && best.seqSim >= 0.45)) cls = CLS.NEAR;
      else if (best.setSim >= opts.paraphraseThreshold ||
               // Containment path: most of this sentence's content vocabulary
               // (with a floor on absolute count, so short sentences can't
               // trip it) comes from one source sentence, partly in order.
               (best.contain >= 0.6 && best.shared >= 6 && best.seqSim >= 0.3)) cls = CLS.PARAPHRASE;
      if (cls) {
        results.push({ suspectSent: i, srcSent: best.srcSent, cls: cls,
          seqSim: round2(best.seqSim), setSim: round2(best.setSim) });
      }
    }
    return results;
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  /* ------------------------------------------------------------------ *
   * Layer 4 — winnowed fingerprints (MOSS-style)
   * ------------------------------------------------------------------ */

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h;
  }

  function fingerprints(tokens, k, w) {
    k = k || 5; w = w || 4;
    var n = tokens.length;
    if (n < k) return new Set();
    var hashes = new Array(n - k + 1);
    for (var i = 0; i + k <= n; i++) {
      var parts = [];
      for (var j = 0; j < k; j++) parts.push(tokens[i + j].norm);
      hashes[i] = fnv1a(parts.join("\u0001"));
    }
    var fp = new Set();
    for (i = 0; i + w <= hashes.length; i++) {
      var min = Infinity, pos = -1;
      for (j = i; j < i + w; j++) {
        if (hashes[j] <= min) { min = hashes[j]; pos = j; }
      }
      fp.add(min);
    }
    if (hashes.length < w) for (i = 0; i < hashes.length; i++) fp.add(hashes[i]);
    return fp;
  }

  function containment(fpA, fpB) {
    if (!fpA.size) return 0;
    var inter = 0;
    fpA.forEach(function (h) { if (fpB.has(h)) inter++; });
    return inter / fpA.size;
  }

  /* ------------------------------------------------------------------ *
   * Document comparison + multi-source analysis
   * ------------------------------------------------------------------ */

  var DEFAULT_OPTS = {
    minRun: 5,               // shortest verbatim run reported, in words
    ignoreQuotes: true,      // exclude quoted passages from the score
    ignoreReferences: true,  // exclude a trailing references section
    paraphraseThreshold: 0.55
  };

  function withDefaults(opts) {
    var o = {};
    for (var k in DEFAULT_OPTS) o[k] = DEFAULT_OPTS[k];
    for (k in (opts || {})) if (opts[k] !== undefined) o[k] = opts[k];
    return o;
  }

  // Compare one suspect doc against one source doc. `excl` is the suspect's
  // exclusion array (quoted/refs), shared across sources.
  function compareDocs(suspect, source, opts, excl) {
    var spans = findVerbatimSpans(suspect.tokens, source.tokens, opts.minRun);
    var cls = new Uint8Array(suspect.tokens.length);
    for (var s = 0; s < spans.length; s++) {
      for (var t = spans[s].aStart; t < spans[s].aEnd; t++) cls[t] = CLS.VERBATIM;
    }
    var sentPairs = alignSentences(suspect, source, opts, excl);
    for (var p = 0; p < sentPairs.length; p++) {
      var sent = suspect.sentences[sentPairs[p].suspectSent];
      for (t = sent.tokenStart; t < sent.tokenStart + sent.tokenCount; t++) {
        if (cls[t] < sentPairs[p].cls) cls[t] = sentPairs[p].cls;
      }
    }
    var flagged = 0, verb = 0, near = 0, para = 0, denom = 0;
    for (t = 0; t < cls.length; t++) {
      if (excl && excl[t]) continue;
      denom++;
      if (cls[t] === CLS.VERBATIM) { verb++; flagged++; }
      else if (cls[t] === CLS.NEAR) { near++; flagged++; }
      else if (cls[t] === CLS.PARAPHRASE) { para++; flagged++; }
    }
    var fpS = fingerprints(suspect.tokens);
    var fpB = fingerprints(source.tokens);
    return {
      spans: spans,
      sentencePairs: sentPairs,
      classByToken: cls,
      containment: round2(containment(fpS, fpB)),
      similarity: denom ? flagged / denom : 0,
      breakdown: { verbatim: verb, near: near, paraphrase: para, denom: denom }
    };
  }

  // Analyze `suspectText` against a list of sources [{id, title, text}].
  // Returns everything the report needs, offsets included.
  function analyze(suspectText, sources, opts) {
    opts = withDefaults(opts);
    var suspect = tokenize(suspectText);
    var excl = new Uint8Array(suspect.tokens.length);
    if (opts.ignoreReferences) markReferences(suspect, excl);
    if (opts.ignoreQuotes) markQuoted(suspect, excl);

    var perSource = [];
    var overall = new Uint8Array(suspect.tokens.length);
    var attribution = new Int16Array(suspect.tokens.length).fill(-1);

    for (var i = 0; i < sources.length; i++) {
      var srcDoc = tokenize(sources[i].text);
      var r = compareDocs(suspect, srcDoc, opts, excl);
      for (var t = 0; t < overall.length; t++) {
        if (r.classByToken[t] > overall[t]) {
          overall[t] = r.classByToken[t];
          attribution[t] = i;
        }
      }
      perSource.push({
        id: sources[i].id,
        title: sources[i].title,
        similarity: round4(r.similarity),
        containment: r.containment,
        breakdown: r.breakdown,
        spans: r.spans.map(function (sp) {
          return {
            length: sp.length,
            suspect: tokenRangeToChars(suspect, sp.aStart, sp.aEnd),
            source: tokenRangeToChars(srcDoc, sp.bStart, sp.bEnd),
            sourceText: srcDoc.text.slice(
              srcDoc.tokens[sp.bStart].start, srcDoc.tokens[sp.bEnd - 1].end)
          };
        }),
        sentencePairs: r.sentencePairs.map(function (pr) {
          var ss = suspect.sentences[pr.suspectSent];
          var bs = srcDoc.sentences[pr.srcSent];
          return {
            cls: pr.cls, seqSim: pr.seqSim, setSim: pr.setSim,
            suspect: { start: ss.start, end: ss.end },
            source: { start: bs.start, end: bs.end },
            sourceText: srcDoc.text.slice(bs.start, bs.end)
          };
        })
      });
    }

    var counts = { verbatim: 0, near: 0, paraphrase: 0, quoted: 0, refs: 0, clear: 0 };
    var denom = 0;
    for (t = 0; t < overall.length; t++) {
      if (excl[t] === CLS.QUOTED) { counts.quoted++; continue; }
      if (excl[t] === CLS.REFS) { counts.refs++; continue; }
      denom++;
      if (overall[t] === CLS.VERBATIM) counts.verbatim++;
      else if (overall[t] === CLS.NEAR) counts.near++;
      else if (overall[t] === CLS.PARAPHRASE) counts.paraphrase++;
      else counts.clear++;
    }
    var flagged = counts.verbatim + counts.near + counts.paraphrase;
    perSource.sort(function (a, b) { return b.similarity - a.similarity; });

    return {
      opts: opts,
      tokens: suspect.tokens.length,
      sentences: suspect.sentences.length,
      words: denom,
      counts: counts,
      similarityIndex: denom ? round4(flagged / denom) : 0,
      verdict: verdictFor(denom ? flagged / denom : 0),
      perSource: perSource,
      // for rendering highlights over the suspect text:
      tokenMeta: suspect.tokens.map(function (tok, idx) {
        return { start: tok.start, end: tok.end,
          cls: excl[idx] || overall[idx], src: attribution[idx] };
      }),
      sentenceMap: suspect.sentences.map(function (s) {
        var worst = 0;
        for (var t2 = s.tokenStart; t2 < s.tokenStart + s.tokenCount; t2++) {
          var c = excl[t2] ? 0 : overall[t2];
          if (c > worst) worst = c;
        }
        return { start: s.start, end: s.end, cls: worst };
      })
    };
  }

  function tokenRangeToChars(doc, a, b) {
    return { start: doc.tokens[a].start, end: doc.tokens[b - 1].end };
  }
  function round4(x) { return Math.round(x * 10000) / 10000; }

  function verdictFor(ratio) {
    var pct = ratio * 100;
    if (pct < 10) return { level: "low", label: "Low overlap" };
    if (pct < 25) return { level: "moderate", label: "Notable overlap" };
    if (pct < 50) return { level: "high", label: "Substantial overlap" };
    return { level: "severe", label: "Extensive overlap" };
  }

  /* ------------------------------------------------------------------ *
   * Cross-compare (every pair in a set — collusion / reuse screening)
   * ------------------------------------------------------------------ */

  function crossCompare(docs, opts) {
    opts = withDefaults(opts);
    var parsed = docs.map(function (d) { return tokenize(d.text); });
    var excls = parsed.map(function (p) { return new Uint8Array(p.tokens.length); });
    if (opts.ignoreQuotes || opts.ignoreReferences) {
      for (var i = 0; i < parsed.length; i++) {
        if (opts.ignoreReferences) markReferences(parsed[i], excls[i]);
        if (opts.ignoreQuotes) markQuoted(parsed[i], excls[i]);
      }
    }
    var n = docs.length;
    var cells = [];
    for (i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var ab = compareDocs(parsed[i], parsed[j], opts, excls[i]);
        var ba = compareDocs(parsed[j], parsed[i], opts, excls[j]);
        cells.push({
          a: i, b: j,
          simAB: round4(ab.similarity), simBA: round4(ba.similarity),
          max: round4(Math.max(ab.similarity, ba.similarity))
        });
      }
    }
    return { docs: docs.map(function (d) { return { id: d.id, title: d.title }; }), cells: cells };
  }

  return {
    tokenize: tokenize,
    normToken: normToken,
    stem: stem,
    findVerbatimSpans: findVerbatimSpans,
    alignSentences: alignSentences,
    fingerprints: fingerprints,
    containment: containment,
    analyze: analyze,
    crossCompare: crossCompare,
    CLS: CLS,
    DEFAULT_OPTS: DEFAULT_OPTS
  };
});

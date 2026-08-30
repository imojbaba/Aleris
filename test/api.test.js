"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const E = require("../js/engine.js");
const lib = require("../api/_lib.js");

const LONG_DOC = `Our quarterly planning ritual starts with a shared meal, and every
member of the team brings one dish plus one idea worth defending in public.
By the time dessert arrives we have usually argued our way down to three
priorities that survive scrutiny. The kitchen whiteboard keeps the running
score of commitments, and nobody leaves the room until the owner of each
priority has written a concrete first step beside it. The whole ceremony is
chaotic, warm, and surprisingly efficient at producing decisions people
actually honor. Documentation happens the next morning, when the facilitator
transcribes the whiteboard into our planning repository verbatim.`;

test("distinctiveQueries returns quoted phrases that appear in the text", () => {
  const qs = E.distinctiveQueries(LONG_DOC, 5);
  assert.ok(qs.length >= 3, `expected >=3 queries, got ${qs.length}`);
  // quoted-search semantics: punctuation between words doesn't matter
  const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const q of qs) {
    assert.match(q, /^".+"$/);
    const phrase = q.slice(1, -1);
    assert.ok(squash(LONG_DOC).includes(squash(phrase)), `phrase not found in doc: ${phrase}`);
    assert.ok(phrase.split(" ").length === 8);
  }
  assert.equal(new Set(qs).size, qs.length, "queries must be unique");
});

test("distinctiveQueries is empty for tiny text", () => {
  assert.deepEqual(E.distinctiveQueries("too short", 5), []);
});

test("topicQueries extracts recurring content terms", () => {
  const qs = E.topicQueries(LONG_DOC + " " + LONG_DOC, 3);
  assert.ok(qs.length >= 1 && qs.length <= 3);
  assert.ok(qs[0].split(" ").length >= 3);
  assert.ok(!/\b(the|and|with|our)\b/.test(qs[0]), `stopwords leaked: ${qs[0]}`);
});

test("extractText drops boilerplate and keeps article text", () => {
  const html = fs.readFileSync(path.join(__dirname, "fixtures/web/source-a.html"), "utf8");
  const out = lib.extractText(html);
  assert.equal(out.title, "Detector design notes — published article");
  assert.ok(out.text.includes("trustworthy similarity checker"));
  assert.ok(!out.text.includes("navigation boilerplate"));
  assert.ok(!out.text.includes("Copyright boilerplate"));
});

test("extractText decodes entities and preserves paragraph breaks", () => {
  const out = lib.extractText("<html><body><p>A &amp; B &ldquo;quoted&rdquo;</p><p>Second&nbsp;para</p></body></html>");
  assert.ok(out.text.includes('A & B “quoted”'));
  assert.ok(/\n/.test(out.text));
});

test("urlAllowed blocks private and non-http targets", () => {
  delete process.env.ALLOW_LOCAL_FETCH;
  for (const bad of ["http://localhost/x", "http://127.0.0.1/x", "http://10.0.0.5/",
    "http://192.168.1.1/", "http://172.20.3.4/", "http://169.254.1.1/",
    "file:///etc/passwd", "ftp://host/x", "http://foo.internal/", "not a url"]) {
    assert.equal(lib.urlAllowed(bad), false, `should block ${bad}`);
  }
  for (const ok of ["https://example.com/page", "http://sub.domain.org/a?b=c"]) {
    assert.equal(lib.urlAllowed(ok), true, `should allow ${ok}`);
  }
  process.env.ALLOW_LOCAL_FETCH = "1";
  assert.equal(lib.urlAllowed("http://127.0.0.1:8124/fixture"), true);
  delete process.env.ALLOW_LOCAL_FETCH;
});

test("mock search merges and ranks results", async () => {
  process.env.SEARCH_PROVIDER = "mock";
  const results = await lib.search(['"phrase one"', '"phrase two"']);
  assert.ok(results.length >= 2);
  assert.ok(results[0].hits >= results[results.length - 1].hits);
  assert.ok(results.every((r) => /^https?:/.test(r.url)));
  delete process.env.SEARCH_PROVIDER;
});

/* Shared code for the Aleris Originality serverless API (Vercel /api).
 * Zero dependencies. CommonJS on purpose — Vercel's Node runtime default.
 *
 * Env vars (set in Vercel → Project → Settings → Environment Variables):
 *   SEARCH_PROVIDER  serper | google | mock   (mock is for local testing)
 *   SERPER_API_KEY   when provider=serper (google.serper.dev)
 *   GOOGLE_CSE_KEY + GOOGLE_CSE_ID   when provider=google (Programmable Search)
 *   APP_PASSWORD     optional — when set, clients must send it as x-app-key
 *   ALLOW_LOCAL_FETCH=1  dev server only: lets fetch reach 127.0.0.1 fixtures
 */
"use strict";
const crypto = require("node:crypto");

function provider() {
  const p = (process.env.SEARCH_PROVIDER || "").toLowerCase();
  if (p === "serper" && process.env.SERPER_API_KEY) return "serper";
  if (p === "google" && process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_ID) return "google";
  if (p === "mock") return "mock";
  // auto-detect by whichever key exists
  if (process.env.SERPER_API_KEY) return "serper";
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_ID) return "google";
  return null;
}

function authRequired() { return Boolean(process.env.APP_PASSWORD); }

function authorized(req) {
  const want = process.env.APP_PASSWORD;
  if (!want) return true;
  const got = String(req.headers["x-app-key"] || "");
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readJSON(req, limit) {
  if (req.body !== undefined && req.body !== null) {
    // Vercel parses JSON bodies; may hand a string for other content types
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }
  limit = limit || 64 * 1024;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

/* ---------------- search ---------------- */

async function searchOne(prov, q) {
  if (prov === "serper") {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": process.env.SERPER_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ q, num: 10 })
    });
    if (!r.ok) throw new Error("serper " + r.status + (r.status === 403 || r.status === 401 ? " (check SERPER_API_KEY)" : ""));
    const j = await r.json();
    return (j.organic || []).map((o, i) => ({ url: o.link, title: o.title || o.link, snippet: o.snippet || "", rank: i }));
  }
  if (prov === "google") {
    const u = new URL("https://www.googleapis.com/customsearch/v1");
    u.searchParams.set("key", process.env.GOOGLE_CSE_KEY);
    u.searchParams.set("cx", process.env.GOOGLE_CSE_ID);
    u.searchParams.set("q", q);
    const r = await fetch(u);
    if (!r.ok) throw new Error("google cse " + r.status + (r.status === 403 ? " (key/quota — check GOOGLE_CSE_KEY / daily limit)" : ""));
    const j = await r.json();
    return (j.items || []).map((o, i) => ({ url: o.link, title: o.title || o.link, snippet: o.snippet || "", rank: i }));
  }
  if (prov === "mock") {
    const base = process.env.MOCK_BASE_URL || "http://127.0.0.1:8124";
    return [
      { url: base + "/test/fixtures/web/source-a.html", title: "Detector design notes — published article", snippet: "A trustworthy similarity checker must explain its verdict…", rank: 0 },
      { url: base + "/test/fixtures/web/source-b.html", title: "Unrelated gardening blog", snippet: "Tulips, soil and spring…", rank: 1 }
    ];
  }
  throw new Error("no search provider configured");
}

// Run all queries, merge and rank: URLs hit by more queries first, then rank.
async function search(queries) {
  const prov = provider();
  if (!prov) throw new Error("no search provider configured");
  const byUrl = new Map();
  for (const q of queries) {
    let results;
    try { results = await searchOne(prov, q); }
    catch (e) { if (byUrl.size) continue; throw e; }
    for (const r of results) {
      if (!/^https?:\/\//i.test(r.url || "")) continue;
      const cur = byUrl.get(r.url);
      if (cur) { cur.hits++; cur.bestRank = Math.min(cur.bestRank, r.rank); }
      else byUrl.set(r.url, { url: r.url, title: r.title, snippet: r.snippet, hits: 1, bestRank: r.rank });
    }
  }
  return Array.from(byUrl.values())
    .sort((a, b) => b.hits - a.hits || a.bestRank - b.bestRank)
    .slice(0, 16)
    .map(({ url, title, snippet, hits }) => ({ url, title, snippet, hits }));
}

/* ---------------- fetch + extraction ---------------- */

function urlAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (process.env.ALLOW_LOCAL_FETCH === "1") return true;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0 || a === 169 && b === 254 ||
        a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31) return false;
  }
  if (h === "::1" || h.startsWith("[")) return false;
  return true;
}

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
    mdash: "—", ndash: "–", hellip: "…" };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return " "; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(+d); } catch { return " "; } })
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

// Boilerplate-light text extraction, no dependencies: drop non-content
// elements, prefer <article>/<main> when substantial, add paragraph breaks.
function extractText(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas)[\s\S]*?<\/\1>/gi, " ");
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  s = s.replace(/<head[\s\S]*?<\/head>/i, " ")
       .replace(/<(nav|footer|header|aside|form|button|select|figure)[\s\S]*?<\/\1>/gi, " ");
  for (const tag of ["article", "main"]) {
    const m = s.match(new RegExp("<" + tag + "[\\s\\S]*?</" + tag + ">", "i"));
    if (m && m[0].replace(/<[^>]+>/g, "").trim().length > 500) { s = m[0]; break; }
  }
  s = s.replace(/<\/(p|div|section|li|h[1-6]|tr|blockquote|pre)>/gi, "\n\n")
       .replace(/<(br|hr)[^>]*>/gi, "\n")
       .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title ? decodeEntities(title.trim()).slice(0, 300) : "", text: s };
}

async function fetchReadable(rawUrl) {
  if (!urlAllowed(rawUrl)) throw new Error("URL not allowed");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(rawUrl, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; AlerisOriginality/1.0)", accept: "text/html,text/plain;q=0.9,*/*;q=0.1" }
    });
    if (!r.ok) throw new Error("fetch failed: HTTP " + r.status);
    if (r.url && !urlAllowed(r.url)) throw new Error("URL not allowed");
    const type = (r.headers.get("content-type") || "").toLowerCase();
    if (type.includes("pdf")) throw new Error("PDF source — open it and paste the text instead");
    if (type && !type.includes("html") && !type.includes("text/plain") && !type.includes("xml")) {
      throw new Error("not a text page (" + type.split(";")[0] + ")");
    }
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    const MAX = 2.5 * 1024 * 1024;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > MAX) { ctrl.abort(); break; }
    }
    const html = Buffer.concat(chunks).toString("utf8");
    const out = type.includes("text/plain")
      ? { title: "", text: html.slice(0, 400000) }
      : extractText(html);
    out.text = out.text.slice(0, 400000);
    if (out.text.length < 200) throw new Error("page had no readable text");
    return { url: rawUrl, finalUrl: r.url || rawUrl, title: out.title, text: out.text };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { provider, authRequired, authorized, readJSON, send, search, fetchReadable, extractText, urlAllowed };

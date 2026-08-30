/* Aleris Originality — application layer.
 * Wires the engine to the UI: library storage, team sync, file import,
 * incremental analysis with progress, report rendering and exports.
 * Everything runs client-side; documents leave the page only when the user
 * saves the team library or exports a file. */
(function () {
  "use strict";
  var E = window.AlerisEngine;

  /* ---------------- tiny helpers ---------------- */
  function $(sel) { return document.querySelector(sel); }
  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (html !== undefined) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pct(x, dp) {
    var v = x * 100;
    return v.toFixed(dp !== undefined ? dp : (v > 0 && v < 10 ? 1 : 0));
  }
  function fmtInt(n) { return n.toLocaleString("en-US"); }
  function yieldUI() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function uid() { return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $(".toast");
    if (t) t.remove();
    t = el("div", { class: "toast", role: "status" });
    t.textContent = msg;
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, ms || 3400);
  }

  /* ---------------- state + persistence ---------------- */
  var LIB_KEY = "alerisOriginality.lib.v1";
  var OPT_KEY = "alerisOriginality.opts.v1";
  var KEY_KEY = "alerisOriginality.appkey";
  var state = {
    library: [],            // {id,title,author,text,words,updatedAt,origin:'local'|'team'|'web',url?}
    mode: "library",        // 'library' | 'adhoc'
    lastReport: null,
    web: { available: false, provider: null, authNeeded: false },
    team: { ns: null, downloads: null, fetched: false, teamCount: 0,
            teamSavedAt: null, readOnly: false, unavailable: false }
  };

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LIB_KEY);
      if (raw) state.library = JSON.parse(raw).docs || [];
    } catch (e) { /* private mode / blocked storage — run stateless */ }
    try {
      var o = localStorage.getItem(OPT_KEY);
      if (o) {
        o = JSON.parse(o);
        if (o.minRun) $("#opt-minrun").value = String(o.minRun);
        $("#opt-quotes").checked = o.ignoreQuotes !== false;
        $("#opt-refs").checked = o.ignoreReferences !== false;
        $("#opt-web").checked = o.webCheck === true;
      }
    } catch (e) { }
  }
  function saveLocal() {
    try {
      localStorage.setItem(LIB_KEY, JSON.stringify({ docs: state.library }));
    } catch (e) {
      toast("Library is too large for this browser's storage — export it as a file to keep it safe.");
    }
    try { localStorage.setItem(OPT_KEY, JSON.stringify(currentOpts())); } catch (e) { }
  }
  function currentOpts() {
    return {
      minRun: parseInt($("#opt-minrun").value, 10) || 5,
      ignoreQuotes: $("#opt-quotes").checked,
      ignoreReferences: $("#opt-refs").checked,
      webCheck: $("#opt-web").checked
    };
  }

  /* ---------------- web backend (Vercel /api) ---------------- */
  function apiKey() {
    try { return localStorage.getItem(KEY_KEY) || ""; } catch (e) { return ""; }
  }
  function apiCall(path, body) {
    var headers = { "content-type": "application/json" };
    var key = apiKey();
    if (key) headers["x-app-key"] = key;
    return fetch(path, { method: "POST", headers: headers, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
          return json;
        });
      });
  }
  function bootBackend() {
    if (window.claude && typeof window.claude.use === "function") return; // artifact view: no backend
    try {
      fetch("api/health", { cache: "no-store" }).then(function (res) {
        if (!res.ok) return null;
        return res.json();
      }).then(function (json) {
        if (!json || !json.ok || !json.search) return;
        state.web.available = true;
        state.web.provider = json.provider;
        state.web.authNeeded = Boolean(json.auth);
        $("#web-row").hidden = false;
        $("#discover-card").hidden = false;
        if (json.auth) {
          $("#web-key-wrap").hidden = false;
          $("#web-key").value = apiKey();
        }
      }).catch(function () { });
    } catch (e) { }
  }

  function webQueriesFor(text) {
    var qs = E.distinctiveQueries(text, 5);
    if (qs.length < 2) qs = qs.concat(E.topicQueries(text, 2));
    return qs.slice(0, 5);
  }

  // Search for the document's phrasing, fetch the top pages, and return them
  // as extra sources for the same analysis pipeline.
  function gatherWebSources(text, status, existing) {
    status("Searching the web…");
    return apiCall("api/search", { queries: webQueriesFor(text) }).then(function (r) {
      var have = new Set(existing.map(function (s) { return s.url; }).filter(Boolean));
      var picks = (r.results || []).filter(function (x) { return !have.has(x.url); }).slice(0, 8);
      if (!picks.length) return { sources: [], failures: 0, searched: r.queriesUsed || 0 };
      var fetched = [], failures = 0, done = 0;
      function next(queue) {
        var item = queue.shift();
        if (!item) return Promise.resolve();
        return apiCall("api/fetch", { url: item.url }).then(function (page) {
          fetched.push({ id: "web:" + item.url, title: page.title || item.title || item.url,
                         text: page.text, url: page.finalUrl || item.url });
        }, function () { failures++; }).then(function () {
          done++;
          status("Fetching web pages… " + done + "/" + picks.length);
          return next(queue);
        });
      }
      var queue = picks.slice();
      var workers = [];
      for (var w = 0; w < 3; w++) workers.push(next(queue));
      return Promise.all(workers).then(function () {
        return { sources: fetched, failures: failures, searched: r.queriesUsed || 0 };
      });
    });
  }

  /* ---------------- team library (artifact capability) ---------------- */
  var TEAM_PATH = "data/library.json";

  function mergeDocs(docs, origin) {
    var byId = {};
    state.library.forEach(function (d) { byId[d.id] = d; });
    var added = 0, updated = 0;
    (docs || []).forEach(function (src) {
      var td = Object.assign({}, src);
      td.origin = origin;
      if (!td.id) td.id = uid();
      if (!td.words) td.words = E.tokenize(td.text || "").tokens.length;
      var mine = byId[td.id];
      if (!mine) { state.library.push(td); added++; }
      else if ((td.updatedAt || 0) > (mine.updatedAt || 0)) {
        Object.assign(mine, td); updated++;
      } else if (origin === "team" && mine.origin !== "team" &&
                 mine.title === td.title && mine.text === td.text) {
        mine.origin = "team";
      }
    });
    return { added: added, updated: updated };
  }

  function bootTeam() {
    // 1) A shared snapshot may be served next to the page (artifact data file,
    //    or a data/library.json committed to the repo on static hosting).
    try {
      fetch(TEAM_PATH, { cache: "no-store" }).then(function (res) {
        if (!res.ok) return null;
        return res.json();
      }).then(function (json) {
        if (!json || !json.docs) return;
        state.team.fetched = true;
        state.team.teamCount = json.docs.length;
        state.team.teamSavedAt = json.savedAt || null;
        var r = mergeDocs(json.docs, "team");
        if (r.added || r.updated) saveLocal();
        renderLibrary(); renderTeamCard(); updateScopeNote();
      }).catch(function () { });
    } catch (e) { }
    // 2) Saving back requires the artifact capability (claude.ai artifact views).
    if (window.claude && typeof window.claude.use === "function") {
      window.claude.use("artifact").then(function (ns) {
        state.team.ns = ns;
        renderTeamCard();
      }).catch(function () { });
      window.claude.use("downloads").then(function (ns) {
        state.team.downloads = ns;
      }).catch(function () { });
    }
  }

  function renderTeamCard() {
    var card = $("#team-card");
    var t = state.team;
    if (!t.ns && !t.fetched) { card.hidden = true; return; }
    card.hidden = false;
    var status;
    if (t.fetched) {
      status = "Shared team library loaded — " + fmtInt(t.teamCount) + " document" +
        (t.teamCount === 1 ? "" : "s") +
        (t.teamSavedAt ? ", saved " + new Date(t.teamSavedAt).toLocaleString() : "") + ".";
    } else {
      status = "No shared team library yet — save one so every teammate opens the same reference set.";
    }
    var html = "<h3 style='font-size:1.02rem'>Team library</h3>" +
      "<p class='hint' style='margin:.35rem 0 .8rem'>" + esc(status) + "</p>";
    if (t.ns && !t.readOnly && !t.unavailable) {
      html += "<div class='row'><button class='btn btn-primary btn-sm' id='team-save'>Save current library for the team</button>" +
        "<span class='hint'>Replaces the shared set with the " + fmtInt(state.library.length) +
        " document" + (state.library.length === 1 ? "" : "s") + " listed below. Teammates get it when they open or reload this artifact.</span></div>";
    } else if (t.readOnly) {
      html += "<p class='note'>Your view of this artifact is read-only, so the shared library can't be changed from here. You can still add local documents and run checks.</p>";
    } else if (t.unavailable) {
      html += "<p class='note'>Saving isn't available in this view (this can happen when the artifact is shared publicly). Local documents and checks still work.</p>";
    } else if (!t.ns) {
      html += "<p class='hint'>This copy was loaded from a shared snapshot. To change the shared set, save from the claude.ai artifact, or commit an updated <code>data/library.json</code> to the repository.</p>";
    }
    card.innerHTML = html;
    var btn = $("#team-save");
    if (btn) btn.addEventListener("click", saveTeamLibrary);
  }

  function saveTeamLibrary() {
    var t = state.team;
    if (!t.ns) return;
    var payload = {
      app: "aleris-originality", version: 1,
      savedAt: new Date().toISOString(),
      docs: state.library.map(function (d) {
        return { id: d.id, title: d.title, author: d.author || "", text: d.text,
                 words: d.words, updatedAt: d.updatedAt };
      })
    };
    var btn = $("#team-save");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    var files = {};
    files[TEAM_PATH] = { content: JSON.stringify(payload), contentType: "application/json" };
    t.ns.publish(files).then(function () {
      state.library.forEach(function (d) { d.origin = "team"; });
      state.team.fetched = true;
      state.team.teamCount = payload.docs.length;
      state.team.teamSavedAt = payload.savedAt;
      saveLocal(); renderLibrary(); renderTeamCard();
      toast("Team library saved — teammates see it when they open or reload the artifact.");
    }).catch(function (err) {
      var code = err && err.code;
      if (code === "conflict") {
        toast("A teammate saved first — reloading to pick up their version.");
      } else if (code === "not_writer" || code === "not_granted") {
        state.team.readOnly = true; renderTeamCard();
      } else if (code === "capability_disabled" || code === "capability_removed" || code === "not_declared") {
        state.team.unavailable = true; renderTeamCard();
      } else if (code === "too_large") {
        toast("The library is too large to save to the artifact — remove some documents or export to JSON instead.");
      } else if (code === "rate_limited") {
        toast("Saving too often — wait a moment and try again.");
      } else {
        toast("Couldn't save the team library (" + (code || "unknown error") + "). Try again in a moment.");
      }
      renderTeamCard();
    });
  }

  /* ---------------- file import ---------------- */
  function baseName(name) { return name.replace(/\.[^.]+$/, ""); }

  function docxToText(buf) {
    if (!window.JSZip) return Promise.reject(new Error("docx support unavailable (JSZip not loaded)"));
    return JSZip.loadAsync(buf).then(function (zip) {
      var f = zip.file("word/document.xml");
      if (!f) throw new Error("not a Word document");
      return f.async("string");
    }).then(function (xml) {
      return xml
        .replace(/<w:tab[^>]*\/>/g, "\t")
        .replace(/<w:br[^>]*\/>/g, "\n")
        .replace(/<\/w:p>/g, "\n\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(+d); })
        .replace(/&amp;/g, "&")
        .replace(/\n{3,}/g, "\n\n").trim();
    });
  }

  function readOneFile(file) {
    var name = file.name || "document";
    if (/\.docx$/i.test(name)) {
      return file.arrayBuffer().then(docxToText).then(function (text) {
        return { title: baseName(name), text: text };
      });
    }
    if (/\.(txt|md|markdown|text)$/i.test(name) || /^text\//.test(file.type) || !file.type) {
      return file.text().then(function (text) { return { title: baseName(name), text: text }; });
    }
    return Promise.reject(new Error(name + ": unsupported type — use .txt, .md or .docx (for PDFs, paste the text)"));
  }

  function wireDrop(zone, onFiles) {
    ["dragenter", "dragover"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("armed"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove("armed"); });
    });
    zone.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
    });
  }

  var filePickTarget = null; // 'check' | 'adhoc' | 'library'
  function pickFiles(target) {
    filePickTarget = target;
    var input = $("#file-input");
    input.multiple = target === "library";
    input.value = "";
    input.click();
  }
  function handleFiles(target, files) {
    var list = Array.prototype.slice.call(files);
    if (target !== "library") list = list.slice(0, 1);
    var jobs = list.map(function (f) {
      return readOneFile(f).then(function (doc) { return doc; }, function (err) {
        toast(err.message); return null;
      });
    });
    Promise.all(jobs).then(function (docs) {
      docs = docs.filter(Boolean);
      if (!docs.length) return;
      if (target === "check") {
        $("#check-text").value = docs[0].text;
        if (!$("#check-title").value) $("#check-title").value = docs[0].title;
        toast("Loaded “" + docs[0].title + "” (" + fmtInt(E.tokenize(docs[0].text).tokens.length) + " words).");
      } else if (target === "adhoc") {
        $("#adhoc-text").value = docs[0].text;
        toast("Loaded reference text from “" + docs[0].title + "”.");
      } else {
        var added = 0;
        docs.forEach(function (d) {
          if (!d.text.trim()) return;
          addDoc(d.title, "", d.text); added++;
        });
        if (added) toast("Added " + added + " document" + (added === 1 ? "" : "s") + " to the library.");
      }
    });
  }

  /* ---------------- library ---------------- */
  function addDoc(title, author, text, extra) {
    var doc = {
      id: uid(),
      title: (title || "Untitled").trim() || "Untitled",
      author: (author || "").trim(),
      text: text,
      words: E.tokenize(text).tokens.length,
      updatedAt: Date.now(),
      origin: (extra && extra.origin) || "local"
    };
    if (extra && extra.url) doc.url = extra.url;
    state.library.push(doc);
    saveLocal(); renderLibrary(); updateScopeNote();
    return doc;
  }
  function badgeFor(d) {
    if (d.origin === "team") return "<span class='badge badge-team'>Team</span>";
    if (d.origin === "web") return "<span class='badge badge-web'>Web</span>";
    return "<span class='badge badge-local'>Local only</span>";
  }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }

  function renderLibrary() {
    var wrap = $("#lib-list");
    $("#lib-count").textContent = state.library.length ? "(" + state.library.length + ")" : "";
    if (!state.library.length) {
      wrap.innerHTML = "<div class='card empty'><div class='big'>No reference documents yet</div>" +
        "Import your team's past work above — every check screens against what lives here.</div>";
      return;
    }
    wrap.innerHTML = "";
    var grid = el("div", { class: "lib-grid" });
    state.library.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; })
      .forEach(function (d) {
        var card = el("article", { class: "card lib-card" });
        card.innerHTML =
          "<div class='row spread'>" + badgeFor(d) + "</div>" +
          "<div class='t'>" + esc(d.title) +
          (d.url ? " <a class='ext' href='" + esc(d.url) + "' target='_blank' rel='noopener noreferrer' title='Open source page'>" + esc(hostOf(d.url)) + " ↗</a>" : "") + "</div>" +
          (d.author ? "<div class='hint'>" + esc(d.author) + "</div>" : "") +
          "<div class='meta'>" + fmtInt(d.words) + " words · " + new Date(d.updatedAt).toLocaleDateString() + "</div>" +
          "<details><summary class='hint' style='cursor:pointer'>Preview</summary>" +
          "<div class='doc-text' style='max-height:200px;font-size:.85rem'>" + esc(d.text.slice(0, 1200)) + (d.text.length > 1200 ? "…" : "") + "</div></details>" +
          "<div class='row'><button class='btn btn-sm' data-act='check'>Check against this</button>" +
          "<button class='btn btn-sm btn-danger' data-act='del'>Remove</button></div>";
        card.querySelector("[data-act='del']").addEventListener("click", function () {
          var inTeam = d.origin === "team";
          if (!confirm("Remove “" + d.title + "” from the library?" +
            (inTeam ? "\n\nIt stays in the shared team library until someone saves the team library again." : ""))) return;
          state.library = state.library.filter(function (x) { return x.id !== d.id; });
          saveLocal(); renderLibrary(); updateScopeNote();
        });
        card.querySelector("[data-act='check']").addEventListener("click", function () {
          setMode("adhoc");
          $("#adhoc-text").value = d.text;
          switchView("check");
          toast("Reference text set to “" + d.title + "” — paste the document to check and run.");
        });
        grid.appendChild(card);
      });
    wrap.appendChild(grid);
  }

  function exportLibrary() {
    var payload = JSON.stringify({
      app: "aleris-originality", version: 1,
      savedAt: new Date().toISOString(), docs: state.library
    }, null, 2);
    deliverFile("aleris-library.json", payload, "application/json");
  }
  function importLibraryFile(file) {
    file.text().then(function (raw) {
      var json = JSON.parse(raw);
      if (!json || !Array.isArray(json.docs)) throw new Error("bad file");
      var r = mergeDocs(json.docs, "local");
      saveLocal(); renderLibrary(); updateScopeNote();
      toast("Imported " + r.added + " new, updated " + r.updated + " existing document" + ((r.added + r.updated) === 1 ? "" : "s") + ".");
    }).catch(function () {
      toast("That file isn't an Aleris library export.");
    });
  }

  /* ---------------- file delivery (downloads capability or <a download>) -- */
  function deliverFile(filename, data, mime) {
    if (state.team.downloads) {
      state.team.downloads.save({ filename: filename, data: data }).then(function () {
        toast("Saved " + filename + ".");
      }).catch(function (err) {
        if (err && err.code === "declined") return;
        copyFallback(filename, data);
      });
      return;
    }
    if (window.claude && typeof window.claude.use === "function") {
      // Sandboxed artifact view without the downloads capability: anchor
      // downloads are inert here, so hand the content over via clipboard.
      copyFallback(filename, data);
      return;
    }
    try {
      var blob = new Blob([data], { type: mime || "text/plain" });
      var url = URL.createObjectURL(blob);
      var a = el("a", { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 400);
      toast("Downloading " + filename + "…");
    } catch (e) { copyFallback(filename, data); }
  }
  function copyFallback(filename, data) {
    navigator.clipboard.writeText(data).then(function () {
      toast("Couldn't save the file here — its contents were copied to your clipboard instead.");
    }, function () { toast("Couldn't save or copy " + filename + " in this view."); });
  }

  /* ---------------- check flow ---------------- */
  function setMode(mode) {
    state.mode = mode;
    $("#mode-library").setAttribute("aria-pressed", String(mode === "library"));
    $("#mode-adhoc").setAttribute("aria-pressed", String(mode === "adhoc"));
    $("#adhoc-wrap").hidden = mode !== "adhoc";
    updateScopeNote();
  }
  function updateScopeNote() {
    var n = $("#scope-note");
    if (state.mode === "library") {
      n.textContent = state.library.length
        ? "Screens against all " + state.library.length + " library document" + (state.library.length === 1 ? "" : "s")
        : "Library is empty — add documents or compare against pasted text";
    } else {
      n.textContent = "Compares the document against the pasted reference text only";
    }
    var cs = $("#cross-scope");
    if (cs) cs.textContent = state.library.length < 2
      ? "Needs at least two library documents"
      : state.library.length + " documents · " + (state.library.length * (state.library.length - 1) / 2) + " pairs";
  }

  function gatherSources(webEnabled) {
    if (state.mode === "adhoc") {
      var t = $("#adhoc-text").value;
      if (!t.trim()) return { error: "Paste the reference text to compare against (or switch to library mode)." };
      return { sources: [{ id: "adhoc", title: "Pasted reference text", text: t }] };
    }
    if (!state.library.length && !webEnabled) {
      return { error: "The library is empty — add reference documents, turn on the web check, or compare against pasted text." };
    }
    return { sources: state.library.map(function (d) {
      return { id: d.id, title: d.title, text: d.text, url: d.url };
    }) };
  }

  // Incremental multi-source analysis: one engine pass per source with UI
  // yields in between, merged exactly as the engine would merge them.
  function analyzeIncremental(text, sources, opts, onProgress) {
    var suspect = E.tokenize(text);
    var merged = null, perSource = [];
    var chain = Promise.resolve();
    sources.forEach(function (src, i) {
      chain = chain.then(function () {
        onProgress(i, sources.length, src.title);
        return yieldUI();
      }).then(function () {
        var r = E.analyze(text, [src], opts);
        if (!merged) {
          // keep only the exclusion classes; match classes are re-applied
          // below for every source (the first one included) with attribution
          merged = r.tokenMeta.map(function (m) {
            return { start: m.start, end: m.end,
                     cls: (m.cls === 4 || m.cls === 5) ? m.cls : 0, src: -1 };
          });
        }
        r.tokenMeta.forEach(function (m, t) {
          if (m.cls >= 1 && m.cls <= 3 && m.cls > merged[t].cls) {
            merged[t].cls = m.cls; merged[t].src = i;
          }
        });
        r.perSource[0].srcIndex = i;
        perSource.push(r.perSource[0]);
        return null;
      });
    });
    return chain.then(function () {
      var counts = { verbatim: 0, near: 0, paraphrase: 0, quoted: 0, refs: 0, clear: 0 };
      var denom = 0;
      merged.forEach(function (m) {
        if (m.cls === 4) { counts.quoted++; return; }
        if (m.cls === 5) { counts.refs++; return; }
        denom++;
        if (m.cls === 3) counts.verbatim++;
        else if (m.cls === 2) counts.near++;
        else if (m.cls === 1) counts.paraphrase++;
        else counts.clear++;
      });
      var flagged = counts.verbatim + counts.near + counts.paraphrase;
      var ratio = denom ? flagged / denom : 0;
      perSource.sort(function (a, b) { return b.similarity - a.similarity; });
      var sentenceMap = suspect.sentences.map(function (s) {
        var worst = 0;
        for (var t = s.tokenStart; t < s.tokenStart + s.tokenCount; t++) {
          var c = merged[t].cls;
          if (c >= 1 && c <= 3 && c > worst) worst = c;
        }
        return { start: s.start, end: s.end, cls: worst };
      });
      return {
        text: text, opts: opts, counts: counts, words: denom,
        similarityIndex: ratio,
        verdict: verdictFor(ratio),
        perSource: perSource, tokenMeta: merged, sentenceMap: sentenceMap
      };
    });
  }
  function verdictFor(ratio) {
    var p = ratio * 100;
    if (p < 10) return { level: "low", label: "Low overlap" };
    if (p < 25) return { level: "moderate", label: "Notable overlap" };
    if (p < 50) return { level: "high", label: "Substantial overlap" };
    return { level: "severe", label: "Extensive overlap" };
  }

  function runCheck() {
    var text = $("#check-text").value;
    if (!text.trim()) { toast("Paste or import the document to check first."); return; }
    var webOn = state.web.available && $("#opt-web").checked;
    var g = gatherSources(webOn);
    if (g.error) { toast(g.error); return; }
    var opts = currentOpts();
    saveLocal();
    var btn = $("#run-check"), status = $("#check-status"), prog = $("#check-progress");
    btn.disabled = true; prog.hidden = false;
    var t0 = Date.now();
    var setStatus = function (msg) { status.textContent = msg; };
    var webInfo = { sources: [], failures: 0 };

    var pre = webOn
      ? gatherWebSources(text, setStatus, g.sources).then(function (w) { webInfo = w; },
          function (err) { toast("Web search failed: " + err.message + " — running the local check only."); })
      : Promise.resolve();

    pre.then(function () {
      var sources = g.sources.concat(webInfo.sources);
      if (!sources.length) throw new Error("no sources to compare against (the web search found no reachable pages)");
      return analyzeIncremental(text, sources, opts, function (i, n, title) {
        setStatus("Comparing against “" + title + "” (" + (i + 1) + "/" + n + ")…");
        prog.firstElementChild.style.width = ((i / n) * 100) + "%";
      }).then(function (report) {
        report.title = $("#check-title").value.trim() || "Untitled document";
        report.sources = sources;
        report.webCount = webInfo.sources.length;
        report.ranAt = new Date();
        state.lastReport = report;
        prog.firstElementChild.style.width = "100%";
        setStatus("Done in " + ((Date.now() - t0) / 1000).toFixed(1) + "s." +
          (webInfo.failures ? " (" + webInfo.failures + " web page" + (webInfo.failures === 1 ? "" : "s") + " couldn't be fetched)" : ""));
        renderReport(report);
      });
    }).catch(function (err) {
      setStatus("");
      toast("Analysis failed: " + (err && err.message || err));
    }).then(function () {
      btn.disabled = false;
      setTimeout(function () { prog.hidden = true; prog.firstElementChild.style.width = "0"; }, 600);
    });
  }

  /* ---------------- highlight rendering ---------------- */
  var CLS_NAME = { 1: "Paraphrase-like", 2: "Edited match", 3: "Verbatim", 4: "Quoted (excluded)", 5: "References (excluded)" };

  // Merge per-token classes into contiguous runs (same cls+src), covering the
  // text between tokens of a run so highlights read as passages, not words.
  function tokenRuns(tokenMeta) {
    var runs = [];
    var cur = null;
    tokenMeta.forEach(function (m) {
      if (!m.cls) { cur = null; return; }
      if (cur && cur.cls === m.cls && cur.src === m.src && m.start - cur.end <= 3) {
        cur.end = m.end;
      } else {
        cur = { start: m.start, end: m.end, cls: m.cls, src: m.src };
        runs.push(cur);
      }
    });
    return runs;
  }

  // ranges: [{start,end,cls,src,jump,title}] possibly overlapping → HTML.
  function highlightHTML(text, ranges) {
    var points = new Set([0, text.length]);
    ranges.forEach(function (r) { points.add(Math.max(0, r.start)); points.add(Math.min(text.length, r.end)); });
    var cuts = Array.from(points).sort(function (a, b) { return a - b; });
    var out = "";
    for (var i = 0; i < cuts.length - 1; i++) {
      var s = cuts[i], e = cuts[i + 1];
      if (s >= e) continue;
      var best = null;
      for (var j = 0; j < ranges.length; j++) {
        var r = ranges[j];
        if (r.start <= s && r.end >= e) {
          if (!best || priority(r.cls) > priority(best.cls)) best = r;
        }
      }
      var chunk = esc(text.slice(s, e));
      if (best) {
        out += "<mark class='m" + best.cls + "'" +
          (best.jump ? " data-jump='" + best.jump + "' tabindex='0' role='button'" : "") +
          (best.id ? " id='" + best.id + "'" : "") +
          (best.title ? " title='" + esc(best.title) + "'" : "") + ">" + chunk + "</mark>";
      } else out += chunk;
    }
    return out;
  }
  function priority(cls) { return cls === 3 ? 5 : cls === 2 ? 4 : cls === 1 ? 3 : cls === 4 ? 2 : 1; }

  function wireJumps(container) {
    container.addEventListener("click", function (e) {
      var m = e.target.closest("mark[data-jump]");
      if (!m) return;
      var target = container.querySelector("#" + CSS.escape(m.getAttribute("data-jump")));
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("flash");
      setTimeout(function () { target.classList.remove("flash"); }, 1600);
    });
    container.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches("mark[data-jump]")) {
        e.preventDefault(); e.target.click();
      }
    });
  }

  /* ---------------- report rendering ---------------- */
  function legendHTML(withQuoted) {
    return "<div class='legend'>" +
      "<span class='key'><span class='swatch' style='background:var(--c-verbatim)'></span>Verbatim (solid underline)</span>" +
      "<span class='key'><span class='swatch' style='background:var(--c-near)'></span>Edited match (dashed)</span>" +
      "<span class='key'><span class='swatch' style='background:var(--c-para)'></span>Paraphrase-like (dotted)</span>" +
      (withQuoted ? "<span class='key'><span class='swatch' style='background:var(--c-quoted)'></span>Excluded (quotes/references)</span>" : "") +
      "</div>";
  }

  function renderReport(rep) {
    var wrap = $("#report");
    wrap.hidden = false;
    wrap.innerHTML = "";
    var total = rep.words + rep.counts.quoted + rep.counts.refs;
    var excluded = rep.counts.quoted + rep.counts.refs;

    /* verdict band */
    var band = el("div", { class: "card" });
    var flaggedPct = pct(rep.similarityIndex, rep.similarityIndex * 100 >= 10 ? 0 : 1);
    band.innerHTML =
      "<div class='verdict-band'>" +
      "<div><div class='hero-score'><span class='num'>" + flaggedPct + "</span><span class='pct'>%</span></div>" +
      "<span class='verdict-label verdict-" + rep.verdict.level + "'>" + rep.verdict.label + "</span>" +
      "<div class='verdict-meta'>of “" + esc(rep.title) + "” matches your reference set</div></div>" +
      "<div><div class='hint' style='margin-bottom:.2rem'>Composition of " + fmtInt(total) + " words</div>" +
      compBarHTML(rep, total) + legendHTML(excluded > 0) +
      "<div class='stat-tiles'>" +
      tile(fmtInt(rep.counts.verbatim), "Verbatim words") +
      tile(fmtInt(rep.counts.near), "Edited match") +
      tile(fmtInt(rep.counts.paraphrase), "Paraphrase-like") +
      (excluded ? tile(fmtInt(excluded), "Excluded (quotes/refs)") : "") +
      tile(String(rep.perSource.filter(function (s) { return s.similarity >= 0.005 || s.spans.length; }).length) + "/" + rep.perSource.length, "Sources with matches") +
      (rep.webCount ? tile(String(rep.webCount), "Web pages checked") : "") +
      tile(pct(rep.perSource.reduce(function (m, s) { return Math.max(m, s.containment); }, 0)) + "%", "Top fingerprint match") +
      "</div></div></div>" +
      "<div class='hint' style='margin-top:1rem'>Sentence map — each cell is a sentence, colored by its strongest match. Click to jump.</div>" +
      "<div class='sent-map' id='sent-map'></div>";
    wrap.appendChild(band);

    var map = band.querySelector("#sent-map");
    var buckets = bucketSentences(rep.sentenceMap, 200);
    buckets.forEach(function (b) {
      var cell = el("i", { class: b.cls ? "c" + b.cls : "", title: "Sentences " + b.label + (b.cls ? " — " + CLS_NAME[b.cls] : " — clear") });
      cell.addEventListener("click", function () {
        var panel = $("#overview-text");
        if (!panel) return;
        var target = findMarkAt(panel, b.start);
        (target || panel).scrollIntoView({ block: "center", behavior: "smooth" });
        if (target) { target.classList.add("flash"); setTimeout(function () { target.classList.remove("flash"); }, 1600); }
      });
      map.appendChild(cell);
    });

    /* full-document overview with combined highlights */
    var over = el("div", { class: "card" });
    over.innerHTML = "<div class='row spread'><h3 style='font-size:1.02rem'>Document with all matches</h3>" +
      "<div class='row no-print'>" +
      "<button class='btn btn-sm' id='exp-copy'>Copy summary</button>" +
      "<button class='btn btn-sm' id='exp-html'>Save report</button>" +
      "<button class='btn btn-sm' id='exp-print'>Print</button></div></div>" +
      "<div class='panel' style='margin-top:.8rem'><div class='doc-text' id='overview-text'>" +
      highlightHTML(rep.text, tokenRuns(rep.tokenMeta).map(function (r) {
        var srcTitle = r.src >= 0 && rep.sources[r.src] ? rep.sources[r.src].title : "";
        return { start: r.start, end: r.end, cls: r.cls,
                 title: CLS_NAME[r.cls] + (srcTitle ? " — " + srcTitle : "") };
      })) + "</div></div>";
    wrap.appendChild(over);
    $("#exp-copy").addEventListener("click", function () {
      navigator.clipboard.writeText(summaryMarkdown(rep)).then(function () {
        toast("Summary copied as Markdown.");
      }, function () { toast("Couldn't reach the clipboard in this view."); });
    });
    $("#exp-html").addEventListener("click", function () {
      deliverFile(slug(rep.title) + "-originality-report.html", exportReportHTML(rep), "text/html");
    });
    $("#exp-print").addEventListener("click", function () { try { window.print(); } catch (e) { toast("Printing isn't available in this view — use Save report instead."); } });

    /* per-source details */
    var srcCard = el("div", { class: "card" });
    srcCard.innerHTML = "<h3 style='font-size:1.02rem;margin-bottom:.4rem'>Match by source</h3>";
    rep.perSource.forEach(function (s) {
      var d = el("details", { class: "src-detail" });
      var simPct = pct(s.similarity);
      var srcUrl = null;
      rep.sources.forEach(function (x) { if (x.id === s.id && x.url) srcUrl = x.url; });
      d.innerHTML = "<summary><div class='src-row'>" +
        "<div class='t'>" + esc(s.title) +
        (srcUrl ? " <a class='ext' href='" + esc(srcUrl) + "' target='_blank' rel='noopener noreferrer'>" + esc(hostOf(srcUrl)) + " ↗</a>" : "") +
        "<div class='sub'>" + s.spans.length + " verbatim passage" + (s.spans.length === 1 ? "" : "s") +
        " · " + s.sentencePairs.length + " matched sentence" + (s.sentencePairs.length === 1 ? "" : "s") +
        " · fingerprint " + pct(s.containment) + "%</div></div>" +
        "<div class='mini-bar'><div style='width:" + Math.min(100, s.similarity * 100) + "%'></div></div>" +
        "<div class='pct'>" + simPct + "%</div>" +
        "<span class='hint no-print'>details ▾</span>" +
        "</div></summary>";
      var body = el("div", { class: "detail-body" });
      d.appendChild(body);
      var built = false;
      d.addEventListener("toggle", function () {
        if (d.open && !built) { built = true; body.innerHTML = duoHTML(rep, s); }
      });
      srcCard.appendChild(d);
    });
    wrap.appendChild(srcCard);
    wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function tile(v, k) { return "<div class='tile'><div class='v'>" + v + "</div><div class='k'>" + k + "</div></div>"; }
  function compBarHTML(rep, total) {
    var c = rep.counts;
    function seg(n, cls, label) {
      if (!n) return "";
      return "<span class='seg-" + cls + "' style='width:" + (n / total * 100) + "%' title='" + label + ": " + fmtInt(n) + " words'></span>";
    }
    return "<div class='comp-bar' role='img' aria-label='Verbatim " + c.verbatim + ", edited " + c.near + ", paraphrase " + c.paraphrase + ", excluded " + (c.quoted + c.refs) + ", clear " + c.clear + " words'>" +
      seg(c.verbatim, "verbatim", "Verbatim") + seg(c.near, "near", "Edited match") +
      seg(c.paraphrase, "para", "Paraphrase-like") + seg(c.quoted + c.refs, "quoted", "Excluded") +
      seg(c.clear, "clear", "No match") + "</div>";
  }
  function bucketSentences(map, maxCells) {
    if (map.length <= maxCells) {
      return map.map(function (s, i) { return { start: s.start, cls: s.cls, label: String(i + 1) }; });
    }
    var per = Math.ceil(map.length / maxCells);
    var out = [];
    for (var i = 0; i < map.length; i += per) {
      var chunk = map.slice(i, i + per);
      out.push({
        start: chunk[0].start,
        cls: Math.max.apply(null, chunk.map(function (s) { return s.cls; })),
        label: (i + 1) + "–" + Math.min(map.length, i + per)
      });
    }
    return out;
  }
  function findMarkAt(panel, charStart) {
    // The overview panel's text nodes correspond linearly to rep.text; walk
    // marks and use their accumulated position via data — simpler: nearest mark
    // by document order fraction. Practical approach: pick the mark whose text
    // occurs at/after the sentence start using a running offset walk.
    var walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    var off = 0, node;
    while ((node = walker.nextNode())) {
      var len = node.textContent.length;
      if (off + len > charStart) {
        return node.parentElement.closest("mark") || nextMark(node);
      }
      off += len;
    }
    return null;
  }
  function nextMark(node) {
    var el2 = node.parentElement;
    var marks = el2 && el2.closest(".doc-text") ? el2.closest(".doc-text").querySelectorAll("mark") : [];
    for (var i = 0; i < marks.length; i++) {
      if (node.compareDocumentPosition(marks[i]) & Node.DOCUMENT_POSITION_FOLLOWING) return marks[i];
    }
    return null;
  }

  // Side-by-side: suspect (this source's matches only) vs the source document.
  function duoHTML(rep, s) {
    var srcDoc = null;
    for (var i = 0; i < rep.sources.length; i++) {
      if (rep.sources[i].id === s.id) { srcDoc = rep.sources[i]; break; }
    }
    var left = [], right = [];
    s.spans.forEach(function (sp, idx) {
      var jl = "L" + s.srcIndex + "x" + idx, jr = "R" + s.srcIndex + "x" + idx;
      left.push({ start: sp.suspect.start, end: sp.suspect.end, cls: 3, id: jl, jump: jr, title: "Verbatim, " + sp.length + " words — click to see it in the source" });
      right.push({ start: sp.source.start, end: sp.source.end, cls: 3, id: jr, jump: jl, title: "Verbatim, " + sp.length + " words — click to jump back" });
    });
    s.sentencePairs.forEach(function (pr, idx) {
      var jl = "Ls" + s.srcIndex + "x" + idx, jr = "Rs" + s.srcIndex + "x" + idx;
      var t = CLS_NAME[pr.cls] + " (sequence " + Math.round(pr.seqSim * 100) + "%, wording " + Math.round(pr.setSim * 100) + "%)";
      left.push({ start: pr.suspect.start, end: pr.suspect.end, cls: pr.cls, id: jl, jump: jr, title: t + " — click to see the source sentence" });
      right.push({ start: pr.source.start, end: pr.source.end, cls: pr.cls, id: jr, jump: jl, title: t });
    });
    return "<div class='duo'>" +
      "<div class='panel'><h4>Checked: " + esc(rep.title) + "</h4><div class='doc-text'>" + highlightHTML(rep.text, left) + "</div></div>" +
      "<div class='panel'><h4>Source: " + esc(s.title) + "</h4><div class='doc-text'>" + (srcDoc ? highlightHTML(srcDoc.text, right) : "<em>source text unavailable</em>") + "</div></div>" +
      "</div>";
  }

  /* ---------------- exports ---------------- */
  function slug(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "document"; }
  function summaryMarkdown(rep) {
    var lines = [
      "# Originality report — " + rep.title,
      "",
      "- **Checked:** " + rep.ranAt.toLocaleString() + " · " + fmtInt(rep.words) + " words scored",
      "- **Similarity index:** " + pct(rep.similarityIndex) + "% (" + rep.verdict.label + ")",
      "- **Verbatim:** " + fmtInt(rep.counts.verbatim) + " words · **Edited:** " + fmtInt(rep.counts.near) + " · **Paraphrase-like:** " + fmtInt(rep.counts.paraphrase),
      "- **Excluded:** " + fmtInt(rep.counts.quoted) + " quoted + " + fmtInt(rep.counts.refs) + " reference words",
      "- **Settings:** min run " + rep.opts.minRun + " words, quotes " + (rep.opts.ignoreQuotes ? "excluded" : "included") + ", references " + (rep.opts.ignoreReferences ? "excluded" : "included"),
      "",
      "| Source | Similarity | Verbatim passages | Matched sentences | Fingerprint |",
      "|---|---:|---:|---:|---:|"
    ];
    rep.perSource.forEach(function (s) {
      lines.push("| " + s.title.replace(/\|/g, "\\|") + " | " + pct(s.similarity) + "% | " + s.spans.length + " | " + s.sentencePairs.length + " | " + pct(s.containment) + "% |");
    });
    lines.push("", "_Generated by Aleris Originality. Scores measure textual overlap; review the highlighted passages before drawing conclusions._");
    return lines.join("\n");
  }

  function exportReportHTML(rep) {
    var srcRows = rep.perSource.map(function (s) {
      return "<tr><td>" + esc(s.title) + "</td><td class='n'>" + pct(s.similarity) + "%</td><td class='n'>" +
        s.spans.length + "</td><td class='n'>" + s.sentencePairs.length + "</td><td class='n'>" + pct(s.containment) + "%</td></tr>";
    }).join("");
    var overview = highlightHTML(rep.text, tokenRuns(rep.tokenMeta).map(function (r) {
      var srcTitle = r.src >= 0 && rep.sources[r.src] ? rep.sources[r.src].title : "";
      return { start: r.start, end: r.end, cls: r.cls, title: CLS_NAME[r.cls] + (srcTitle ? " — " + srcTitle : "") };
    }));
    var duos = rep.perSource.filter(function (s) { return s.spans.length || s.sentencePairs.length; })
      .map(function (s) { return "<h2>" + esc(s.title) + " — " + pct(s.similarity) + "%</h2>" + duoHTML(rep, s); }).join("");
    return "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>" +
      "<meta name='viewport' content='width=device-width, initial-scale=1'>" +
      "<title>Originality report — " + esc(rep.title) + "</title><style>" +
      "body{font:15px/1.6 Georgia,serif;color:#12294a;background:#fdfbf6;max-width:960px;margin:2rem auto;padding:0 1.2rem}" +
      "h1{font-size:1.6rem}h2{font-size:1.1rem;margin-top:2rem}.meta{color:#5a6880}" +
      "table{border-collapse:collapse;width:100%;font-size:.9rem}td,th{border:1px solid #d9cfb5;padding:.4rem .6rem;text-align:left}td.n{text-align:right;font-variant-numeric:tabular-nums}" +
      ".doc-text{white-space:pre-wrap;border:1px solid #d9cfb5;border-radius:8px;padding:1rem;margin:.6rem 0;line-height:1.8}" +
      ".duo{display:grid;grid-template-columns:1fr 1fr;gap:1rem}@media(max-width:800px){.duo{grid-template-columns:1fr}}" +
      ".duo h4{margin:.2rem 0;font-size:.75rem;text-transform:uppercase;letter-spacing:.1em;color:#75809a}" +
      ".panel{min-width:0}" +
      "mark{background:none;text-decoration-line:underline;text-decoration-thickness:2px;text-underline-offset:3px;border-radius:2px;padding:.05em 0}" +
      "mark.m3{background:rgba(179,53,43,.16);text-decoration-color:#b3352b}" +
      "mark.m2{background:rgba(189,128,0,.17);text-decoration-color:#bd8000;text-decoration-style:dashed}" +
      "mark.m1{background:rgba(90,73,200,.13);text-decoration-color:#5a49c8;text-decoration-style:dotted}" +
      "mark.m4,mark.m5{background:rgba(109,118,136,.12);text-decoration-color:#6d7688;text-decoration-style:dotted;text-decoration-thickness:1px}" +
      ".legend{font-size:.8rem;color:#4a5872}.legend b{font-weight:600}" +
      "</style></head><body>" +
      "<h1>Originality report — " + esc(rep.title) + "</h1>" +
      "<p class='meta'>Checked " + rep.ranAt.toLocaleString() + " · " + fmtInt(rep.words) + " words scored · similarity index <b>" +
      pct(rep.similarityIndex) + "%</b> (" + rep.verdict.label + ") · verbatim " + fmtInt(rep.counts.verbatim) +
      " · edited " + fmtInt(rep.counts.near) + " · paraphrase-like " + fmtInt(rep.counts.paraphrase) +
      " · excluded " + fmtInt(rep.counts.quoted + rep.counts.refs) + "</p>" +
      "<p class='legend'>Highlight key: <b>solid underline</b> verbatim · <b>dashed</b> edited match · <b>dotted</b> paraphrase-like · thin dotted gray = excluded quotes/references.</p>" +
      "<table><thead><tr><th>Source</th><th>Similarity</th><th>Verbatim passages</th><th>Matched sentences</th><th>Fingerprint</th></tr></thead><tbody>" +
      srcRows + "</tbody></table>" +
      "<h2>Checked document</h2><div class='doc-text'>" + overview + "</div>" +
      duos +
      "<p class='meta'>Generated by Aleris Originality. Scores measure textual overlap with the chosen reference set; always review highlighted passages before drawing conclusions about intent.</p>" +
      "</body></html>";
  }

  /* ---------------- cross-compare ---------------- */
  function runCross() {
    if (state.library.length < 2) { toast("Add at least two library documents first."); return; }
    var docs = state.library.map(function (d) { return { id: d.id, title: d.title, text: d.text }; });
    var opts = currentOpts();
    var pairs = [];
    for (var i = 0; i < docs.length; i++) for (var j = i + 1; j < docs.length; j++) pairs.push([i, j]);
    var btn = $("#run-cross"), prog = $("#cross-progress");
    btn.disabled = true; prog.hidden = false;
    var cells = [];
    var chain = Promise.resolve();
    pairs.forEach(function (p, idx) {
      chain = chain.then(yieldUI).then(function () {
        prog.firstElementChild.style.width = ((idx / pairs.length) * 100) + "%";
        var ab = E.analyze(docs[p[0]].text, [docs[p[1]]], opts);
        var ba = E.analyze(docs[p[1]].text, [docs[p[0]]], opts);
        cells.push({ a: p[0], b: p[1], simAB: ab.similarityIndex, simBA: ba.similarityIndex,
                     max: Math.max(ab.similarityIndex, ba.similarityIndex) });
      });
    });
    chain.then(function () {
      renderCross(docs, cells, opts);
    }).catch(function (err) {
      toast("Cross-compare failed: " + (err && err.message || err));
    }).then(function () {
      btn.disabled = false; prog.hidden = true; prog.firstElementChild.style.width = "0";
    });
  }

  function heatColor(v) {
    var steps = ["--heat-0", "--heat-1", "--heat-2", "--heat-3", "--heat-4", "--heat-5", "--heat-6"];
    var idx = v <= 0.02 ? 0 : v < 0.08 ? 1 : v < 0.16 ? 2 : v < 0.28 ? 3 : v < 0.45 ? 4 : v < 0.65 ? 5 : 6;
    return { bg: "var(" + steps[idx] + ")", ink: idx >= 4 ? "var(--heat-ink-hi)" : "var(--heat-ink-lo)" };
  }

  function renderCross(docs, cells, opts) {
    var wrap = $("#cross-result");
    var byKey = {};
    cells.forEach(function (c) { byKey[c.a + ":" + c.b] = c; });
    var html = "<div class='heat-scroll'><table class='heat'><thead><tr><th></th>";
    docs.forEach(function (d) { html += "<th title='" + esc(d.title) + "'>" + esc(short(d.title, 16)) + "</th>"; });
    html += "</tr></thead><tbody>";
    docs.forEach(function (dr, r) {
      html += "<tr><th title='" + esc(dr.title) + "'>" + esc(short(dr.title, 22)) + "</th>";
      docs.forEach(function (dc, c) {
        if (r === c) { html += "<td class='cell self' aria-hidden='true'></td>"; return; }
        var cell = byKey[Math.min(r, c) + ":" + Math.max(r, c)];
        var col = heatColor(cell.max);
        html += "<td class='cell' data-a='" + Math.min(r, c) + "' data-b='" + Math.max(r, c) + "'" +
          " style='background:" + col.bg + ";color:" + col.ink + "'" +
          " title='" + esc(dr.title) + " ↔ " + esc(dc.title) + ": " + pct(cell.max) + "%'>" +
          pct(cell.max, 0) + "</td>";
      });
      html += "</tr>";
    });
    html += "</tbody></table></div>";

    var ranked = cells.slice().sort(function (a, b) { return b.max - a.max; }).slice(0, 12)
      .filter(function (c) { return c.max >= 0.02; });
    if (ranked.length) {
      html += "<hr class='rule'><h3 style='font-size:.95rem'>Highest-overlap pairs</h3>";
      ranked.forEach(function (c) {
        html += "<div class='src-row'><div class='t'>" + esc(docs[c.a].title) + " ↔ " + esc(docs[c.b].title) +
          "<div class='sub'>A→B " + pct(c.simAB) + "% · B→A " + pct(c.simBA) + "%</div></div>" +
          "<div class='mini-bar'><div style='width:" + Math.min(100, c.max * 100) + "%'></div></div>" +
          "<div class='pct'>" + pct(c.max) + "%</div>" +
          "<button class='btn btn-sm' data-a='" + c.a + "' data-b='" + c.b + "'>Side by side</button></div>";
      });
    } else {
      html += "<p class='hint' style='margin-top:1rem'>No meaningful overlap between any pair — every document reads as distinct.</p>";
    }
    html += "<div id='cross-duo'></div>";
    wrap.innerHTML = html;

    wrap.querySelectorAll("[data-a]").forEach(function (elBtn) {
      elBtn.addEventListener("click", function () {
        var a = +elBtn.getAttribute("data-a"), b = +elBtn.getAttribute("data-b");
        var r = E.analyze(docs[a].text, [docs[b]], opts);
        var rep = {
          text: docs[a].text, title: docs[a].title, sources: [docs[b]],
          tokenMeta: r.tokenMeta, perSource: r.perSource
        };
        r.perSource[0].srcIndex = 0;
        var duoWrap = $("#cross-duo");
        duoWrap.innerHTML = "<hr class='rule'><h3 style='font-size:.95rem'>" + esc(docs[a].title) +
          " ↔ " + esc(docs[b].title) + " — " + pct(r.similarityIndex) + "%</h3>" +
          duoHTML(rep, r.perSource[0]);
        duoWrap.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }
  function short(t, n) { return t.length > n ? t.slice(0, n - 1) + "…" : t; }

  /* ---------------- source discovery ---------------- */
  function runDiscovery() {
    var text = $("#discover-text").value.trim();
    if (!text) { toast("Describe the topic first (or click “Use my check document”)."); return; }
    var queries = text.split(/\s+/).length <= 12
      ? [text]                                   // short input: search it as-is
      : E.topicQueries(text, 2).concat(E.distinctiveQueries(text, 2));
    if (!queries.length) queries = [text.slice(0, 200)];
    var status = $("#discover-status"), btn = $("#discover-run");
    btn.disabled = true;
    status.textContent = "Searching…";
    apiCall("api/search", { queries: queries.slice(0, 4) }).then(function (r) {
      renderDiscovery(r.results || []);
      status.textContent = (r.results || []).length + " results.";
    }).catch(function (err) {
      status.textContent = "";
      toast("Search failed: " + err.message);
    }).then(function () { btn.disabled = false; });
  }

  function renderDiscovery(results) {
    var wrap = $("#discover-results");
    if (!results.length) { wrap.innerHTML = "<p class='hint'>No results — try broader wording.</p>"; return; }
    var inLib = new Set(state.library.map(function (d) { return d.url; }).filter(Boolean));
    wrap.innerHTML = "<div class='stack' style='gap:.4rem;margin-top:.6rem'>" +
      results.map(function (r, i) {
        var have = inLib.has(r.url);
        return "<label class='disc-row" + (have ? " have" : "") + "'>" +
          "<input type='checkbox' data-i='" + i + "'" + (have ? " disabled" : "") + ">" +
          "<span class='grow'><span class='t'>" + esc(r.title) + "</span> " +
          "<a class='ext' href='" + esc(r.url) + "' target='_blank' rel='noopener noreferrer'>" + esc(hostOf(r.url)) + " ↗</a>" +
          (have ? " <span class='badge badge-web'>In library</span>" : "") +
          "<span class='hint' style='display:block'>" + esc(r.snippet || "") + "</span></span>" +
          "<span class='hint disc-state' data-state='" + i + "'></span>" +
          "</label>";
      }).join("") + "</div>" +
      "<div class='row' style='margin-top:.8rem'><button class='btn btn-primary btn-sm' id='discover-add'>Add selected to library</button></div>";
    $("#discover-add").addEventListener("click", function () {
      var boxes = Array.prototype.slice.call(wrap.querySelectorAll("input[type=checkbox]:checked"));
      if (!boxes.length) { toast("Tick the sources you want first."); return; }
      var addBtn = $("#discover-add");
      addBtn.disabled = true;
      var added = 0, failed = 0;
      var chain = Promise.resolve();
      boxes.forEach(function (box) {
        var r = results[+box.getAttribute("data-i")];
        var stateEl = wrap.querySelector("[data-state='" + box.getAttribute("data-i") + "']");
        chain = chain.then(function () {
          stateEl.textContent = "fetching…";
          return apiCall("api/fetch", { url: r.url }).then(function (page) {
            addDoc(page.title || r.title, hostOf(r.url), page.text, { origin: "web", url: page.finalUrl || r.url });
            stateEl.textContent = "added ✓";
            box.disabled = true; box.checked = false;
            added++;
          }, function (err) {
            stateEl.textContent = "failed: " + err.message;
            failed++;
          });
        });
      });
      chain.then(function () {
        addBtn.disabled = false;
        toast("Added " + added + " source" + (added === 1 ? "" : "s") + " to the library" +
          (failed ? " (" + failed + " failed)" : "") + ".");
      });
    });
  }

  /* ---------------- sample ---------------- */
  var SAMPLE_SOURCE = "Detector design notes (sample)\n\nA trustworthy similarity checker must explain its verdict, showing exactly which passages match and where they came from. Scores without evidence are worse than no scores at all, because they invite both false confidence and false accusation. Modern detectors therefore combine several signals: word n-gram fingerprints survive reordering, sentence-level alignment captures light edits, and normalized token streams defeat character tricks. Finally, the report should separate quotation from appropriation, since citing a source honestly is the opposite of hiding one.";
  var SAMPLE_SUSPECT = "Draft: how our checker should behave (sample)\n\nOur team wants tooling we can defend in front of a client. A trustworthy similarity checker must explain its verdict, showing exactly which passages match and where they came from. We also believe detectors should mix multiple signals, since fingerprints of word n-grams keep working after reordering while alignment at the sentence level picks up light edits. As one of our references puts it, “Scores without evidence are worse than no scores at all, because they invite both false confidence and false accusation.” Beyond that, everything here is our own: we care about warm onboarding, a steady cadence of review rounds, and shipping something the whole team actually opens on Monday mornings.";

  function loadSample() {
    var have = state.library.some(function (d) { return d.title === "Detector design notes (sample)"; });
    if (!have) addDoc("Detector design notes (sample)", "Aleris sample", SAMPLE_SOURCE);
    setMode("library");
    $("#check-title").value = "Draft: how our checker should behave (sample)";
    $("#check-text").value = SAMPLE_SUSPECT;
    toast("Sample loaded — a sample source was added to the library. Hit “Run check”.");
    $("#run-check").focus();
  }

  /* ---------------- views ---------------- */
  function switchView(name) {
    ["check", "cross", "library"].forEach(function (v) {
      $("#view-" + v).hidden = v !== name;
      $("#tab-" + v).setAttribute("aria-selected", String(v === name));
    });
    updateScopeNote();
  }

  /* ---------------- wiring ---------------- */
  function boot() {
    loadLocal();
    renderLibrary();
    updateScopeNote();
    bootTeam();
    bootBackend();
    wireJumps($("#report"));
    wireJumps($("#cross-result"));

    // external links inside <summary> rows must not toggle the accordion
    document.addEventListener("click", function (e) {
      if (e.target.closest("a.ext")) e.stopPropagation();
    }, true);

    $("#discover-run").addEventListener("click", runDiscovery);
    $("#discover-use-doc").addEventListener("click", function () {
      var t = $("#check-text").value.trim();
      if (!t) { toast("Nothing in the Check tab yet — paste the document there first."); return; }
      $("#discover-text").value = t.slice(0, 4000);
      toast("Using the check document — hit “Search the web”.");
    });
    $("#web-key").addEventListener("change", function () {
      try { localStorage.setItem(KEY_KEY, $("#web-key").value.trim()); } catch (e) { }
    });

    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () { switchView(t.getAttribute("data-view")); });
    });
    $("#mode-library").addEventListener("click", function () { setMode("library"); });
    $("#mode-adhoc").addEventListener("click", function () { setMode("adhoc"); });
    $("#run-check").addEventListener("click", runCheck);
    $("#load-sample").addEventListener("click", loadSample);
    $("#run-cross").addEventListener("click", runCross);

    $("#check-browse").addEventListener("click", function () { pickFiles("check"); });
    $("#adhoc-browse").addEventListener("click", function () { pickFiles("adhoc"); });
    $("#lib-browse").addEventListener("click", function () { pickFiles("library"); });
    $("#file-input").addEventListener("change", function (e) {
      if (e.target.files.length) handleFiles(filePickTarget, e.target.files);
    });
    wireDrop($("#check-drop"), function (f) { handleFiles("check", f); });
    wireDrop($("#adhoc-drop"), function (f) { handleFiles("adhoc", f); });
    wireDrop($("#lib-drop"), function (f) { handleFiles("library", f); });

    $("#lib-add").addEventListener("click", function () {
      var text = $("#lib-text").value;
      if (!text.trim()) { toast("Paste the document text first."); return; }
      addDoc($("#lib-title").value, $("#lib-author").value, text);
      $("#lib-title").value = ""; $("#lib-author").value = ""; $("#lib-text").value = "";
      toast("Added to the library.");
    });
    $("#lib-export").addEventListener("click", exportLibrary);
    $("#lib-import").addEventListener("click", function () {
      var input = $("#json-input");
      input.value = ""; input.click();
    });
    $("#json-input").addEventListener("change", function (e) {
      if (e.target.files.length) importLibraryFile(e.target.files[0]);
    });

    ["opt-minrun", "opt-quotes", "opt-refs", "opt-web"].forEach(function (id) {
      $("#" + id).addEventListener("change", saveLocal);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

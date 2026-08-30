"use strict";
const lib = require("./_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return lib.send(res, 405, { error: "POST only" });
  if (!lib.authorized(req)) return lib.send(res, 401, { error: "wrong or missing access key" });
  try {
    const body = await lib.readJSON(req);
    let queries = Array.isArray(body.queries) ? body.queries : [];
    queries = queries
      .filter((q) => typeof q === "string" && q.trim())
      .map((q) => q.trim().slice(0, 220))
      .slice(0, 8);
    if (!queries.length) return lib.send(res, 400, { error: "no queries" });
    const results = await lib.search(queries);
    lib.send(res, 200, { results, queriesUsed: queries.length });
  } catch (e) {
    lib.send(res, 502, { error: String(e.message || e) });
  }
};

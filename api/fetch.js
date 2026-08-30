"use strict";
const lib = require("./_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return lib.send(res, 405, { error: "POST only" });
  if (!lib.authorized(req)) return lib.send(res, 401, { error: "wrong or missing access key" });
  try {
    const body = await lib.readJSON(req);
    if (typeof body.url !== "string") return lib.send(res, 400, { error: "no url" });
    const page = await lib.fetchReadable(body.url.slice(0, 2000));
    lib.send(res, 200, page);
  } catch (e) {
    lib.send(res, 502, { error: String(e.message || e) });
  }
};

"use strict";
const lib = require("./_lib.js");

module.exports = async (req, res) => {
  lib.send(res, 200, {
    ok: true,
    search: Boolean(lib.provider()),
    provider: lib.provider(),
    auth: lib.authRequired()
  });
};

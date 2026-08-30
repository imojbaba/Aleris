/*
 * Local dev server mirroring the Vercel layout: static files from the repo
 * root + the /api/* serverless handlers. Lets you test the web-check and
 * source-discovery features without deploying.
 *
 *   node tools/dev-server.mjs             # real provider from your env vars
 *   SEARCH_PROVIDER=mock node tools/dev-server.mjs   # fixture results
 *
 * The mock provider serves the fixture pages in test/fixtures/web/.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8124);

if (process.env.SEARCH_PROVIDER === "mock") {
  process.env.MOCK_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ALLOW_LOCAL_FETCH = "1";
}

const handlers = {
  "/api/health": require(join(root, "api/health.js")),
  "/api/search": require(join(root, "api/search.js")),
  "/api/fetch": require(join(root, "api/fetch.js"))
};

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const h = handlers[path];
  if (h) {
    try { await h(req, res); }
    catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
    return;
  }
  let file = normalize(path).replace(/^([/\\])+/, "");
  if (file === "" || file === ".") file = "index.html";
  try {
    const data = await readFile(join(root, file));
    res.setHeader("content-type", MIME[extname(file)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}).listen(port, () => console.log(`dev server on http://127.0.0.1:${port} (provider: ${process.env.SEARCH_PROVIDER || "auto"})`));

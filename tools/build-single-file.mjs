/*
 * Builds the deployable single-file versions of Aleris Originality from the
 * multi-file sources (index.html + styles.css + js/engine.js + js/app.js):
 *
 *   dist/aleris-originality.html  — complete standalone document. Open it
 *     from disk, email it, or host it anywhere; no build step needed.
 *   dist/artifact.html            — the same page in claude.ai Artifact form
 *     (no doctype/html/head/body wrapper; <title> + <style> up top), used to
 *     publish/update the team's shared artifact.
 *
 * Usage: node tools/build-single-file.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const html = read("index.html");
const css = read("styles.css");
const engine = read("js/engine.js");
const app = read("js/app.js");

for (const src of [engine, app, css]) {
  if (src.includes("</script")) throw new Error("source contains </script — cannot inline safely");
}

const inlined = html
  .replace(/[ \t]*<link rel="stylesheet" href="styles.css">/, `<style>\n${css}\n</style>`)
  .replace(/[ \t]*<script src="js\/engine.js"><\/script>/, `<script>\n${engine}\n</script>`)
  .replace(/[ \t]*<script src="js\/app.js"><\/script>/, `<script>\n${app}\n</script>`);

if (inlined.includes("styles.css") || inlined.includes("js/engine.js")) {
  throw new Error("inlining failed — a local asset reference survived");
}

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/aleris-originality.html"), inlined);

// Artifact form: body content only, with title + styles hoisted to the top.
const bodyMatch = inlined.match(/<body>([\s\S]*)<\/body>/);
const styleMatch = inlined.match(/<style>[\s\S]*?<\/style>/);
const fontsMatch = inlined.match(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/);
if (!bodyMatch || !styleMatch || !fontsMatch) throw new Error("could not carve artifact form");
const artifact = `<title>Aleris Originality</title>\n${fontsMatch[0]}\n${styleMatch[0]}\n${bodyMatch[1].trim()}\n`;
writeFileSync(join(root, "dist/artifact.html"), artifact);

console.log("built dist/aleris-originality.html (" +
  (inlined.length / 1024).toFixed(0) + " KB) and dist/artifact.html (" +
  (artifact.length / 1024).toFixed(0) + " KB)");

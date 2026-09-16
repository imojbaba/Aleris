/**
 * Package the exported web build as ONE self-contained HTML page.
 *
 * The preview is served from a path we do not control, and Expo emits absolute
 * `/assets/...` URLs baked into the bundle, so every font would 404 under any
 * prefix. Rather than rewrite paths and hope, the fonts this app actually uses
 * are inlined as data URIs and the bundle is inlined with them: one file, no
 * resolution, nothing to get wrong on someone's phone.
 *
 * Only the eight faces registered in theme/fonts.ts are inlined. Expo copies
 * every weight and italic of both families — around 4 MB of type nobody asks
 * for — and inlining all of it would quadruple the page for no benefit.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const buildDir = process.argv[2];
const outFile = process.argv[3];
if (!buildDir || !outFile) {
  console.error('usage: package-preview.mjs <web-build-dir> <out.html>');
  process.exit(1);
}

const USED = [
  'Newsreader_300Light', 'Newsreader_400Regular', 'Newsreader_500Medium', 'Newsreader_600SemiBold',
  'IBMPlexSans_300Light', 'IBMPlexSans_400Regular', 'IBMPlexSans_500Medium', 'IBMPlexSans_600SemiBold',
];

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(buildDir);
const jsPath = files.find((f) => f.includes(`${path.sep}_expo${path.sep}`) && f.endsWith('.js'));
if (!jsPath) throw new Error('no bundle found in ' + buildDir);

let js = readFileSync(jsPath, 'utf8');
const refs = [...new Set(js.match(/\/assets\/[^"']*?\.ttf/g) ?? [])];

let inlined = 0;
let inlinedBytes = 0;
for (const ref of refs) {
  const base = path.basename(ref);
  // "IBMPlexSans_400Regular.<hash>.ttf" — match on the face name, not the hash.
  const face = base.split('.')[0];
  if (!USED.includes(face)) continue;
  const onDisk = path.join(buildDir, ref.replace(/^\//, ''));
  let bytes;
  try {
    bytes = readFileSync(onDisk);
  } catch {
    console.warn('  ! missing on disk, skipped:', ref);
    continue;
  }
  const uri = `data:font/ttf;base64,${bytes.toString('base64')}`;
  js = js.split(ref).join(uri);
  inlined += 1;
  inlinedBytes += bytes.length;
}

// Any face left un-inlined is one the app never registers; it would 404
// silently if requested. Point the leftovers at nothing so a stray fetch
// cannot hang on an origin that will not answer.
js = js.replace(/\/assets\/[^"']*?\.ttf/g, 'data:font/ttf;base64,');

// `</script` anywhere in the bundle would close our inline tag early.
const safeJs = js.split('</script').join('<\\/script');

const page = `<title>Vigil</title>
<style>
  /* react-native-web's recommended reset, plus the bits the artifact shell needs. */
  html, body { height: 100%; margin: 0; background: #FBF7F0; }
  body { overflow: hidden; }
  :root { padding: 0 !important; }
  #root {
    display: flex;
    flex: 1;
    height: 100dvh;
    box-sizing: border-box;
    padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  /* The app is a phone layout; centre it and let it breathe on a desktop. */
  @media (min-width: 620px) {
    body { background: #EFE7DA; }
    #root { max-width: 430px; margin: 0 auto; box-shadow: 0 0 60px rgba(58,42,24,0.13); }
  }
</style>
<div id="root"></div>
<script>${safeJs}</script>
`;

writeFileSync(outFile, page);
console.log(
  `packaged ${outFile} — ${(page.length / 1024 / 1024).toFixed(2)} MB ` +
  `(bundle ${(js.length / 1024).toFixed(0)} KB, ${inlined} fonts inlined, ` +
  `${(inlinedBytes / 1024).toFixed(0)} KB of type)`,
);

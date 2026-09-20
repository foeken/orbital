'use strict';
// Builds build/nucleo-ui.json.gz from the local Nucleo library: every UI icon that has an 18px outline glyph, with
// its label and its search tags. Run: node scripts/build-nucleo.js [<nucleo skills root>]
// The root defaults to $NUCLEO_SKILLS_ROOT, then ~/.nucleo/skills — where the Nucleo MCP server keeps its library.
// The library's own index already carries the markup, so no SVG file is read: `icons.json` holds `svg` as inner
// markup, which is wrapped here in the same 18x18 <svg> the app's own glyphs use. Stroke width is left as the
// library writes it (`var(--nucleo-stroke-width, 1.5)`), so one CSS line matches the whole set to our line weight
// instead of rewriting 3500 glyphs.
// Gzipped because it is 4 MB of JSON and half a megabyte compressed; main gunzips it in about 4 ms, once, on the
// first search (main/icons.js).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = process.argv[2] || process.env.NUCLEO_SKILLS_ROOT || path.join(require('node:os').homedir(), '.nucleo', 'skills');
const SRC = path.join(ROOT, 'ui', 'icons.json');
if (!fs.existsSync(SRC)) { console.error('no Nucleo library at ' + SRC + ' — pass its root: node scripts/build-nucleo.js <root>'); process.exit(2); }
const index = JSON.parse(fs.readFileSync(SRC, 'utf8'));
// One variant per icon: the 18px outline, which is the grid and the weight every glyph in this app is drawn on.
const wanted = (index.icons || []).filter((i) => (i.sizes || []).includes('18px') && (i.fills || []).includes('outline'));
const unsafe = /<script|<foreignObject|\son[a-z]+=/i; // the markup is inlined into the DOM, so nothing executable goes in
const out = [];
const seen = new Set();
for (const icon of wanted) {
  const label = String(icon.label || '').trim();
  const svg = String(icon.svg || '').replace(/>\s+</g, '><').trim();
  if (!label || !svg || seen.has(label)) continue;
  if (unsafe.test(svg)) { console.warn('skipped ' + label + ': markup carries something executable'); continue; }
  seen.add(label);
  out.push({ n: label, t: [...new Set((icon.tags || []).map((t) => String(t).toLowerCase()))].join(','), s: svg });
}
if (!out.length) { console.error('no 18px outline icons found in ' + SRC); process.exit(2); }
const file = path.join(__dirname, '..', 'build', 'nucleo-ui.json.gz');
const json = JSON.stringify(out);
fs.writeFileSync(file, zlib.gzipSync(Buffer.from(json), { level: 9 }));
console.log('wrote ' + path.relative(path.join(__dirname, '..'), file) + ': ' + out.length + ' icons, '
  + (json.length / 1e6).toFixed(2) + ' MB as ' + (fs.statSync(file).size / 1e6).toFixed(2) + ' MB gzipped');

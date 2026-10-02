'use strict';
// The icon a type, a saved search (#521) or one document is drawn with. Tana has nowhere to keep an icon — `appearance` holds an image uri and a hue and
// nothing else (docs/sdk/05-gotchas.md) — and an SVG does not belong in somebody else's CRDT, so the choice is kept
// here, app-local, the way sensitive marks and agent assignments are: one setting, type uri -> Nucleo label. A type's
// field is kept in the same setting under its own key ("<type uri>?attribute=<key>"), since the field belongs to the type.
// What is stored is a name, never markup: the glyph itself comes from the set built into the app.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const settings = require('./settings');

// The Nucleo UI set (build/nucleo-ui.json.gz, scripts/build-nucleo.js): 3.5k 18px outline glyphs with their search
// tags. Half a megabyte on disk, 4 MB parsed, ~4 ms to unpack — so it is read on the first search rather than at
// boot, and kept for the session. A missing file is an empty set: the picker says there is nothing to choose from.
let library = null;
function icons() {
  if (library) return library;
  try { library = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'build', 'nucleo-ui.json.gz')))); }
  catch { library = []; }
  return library;
}
// A name the renderer can also use as a CSS class, and one that cannot collide with the app's own glyph names.
const PREFIX = 'nc-';
const iconName = (label) => PREFIX + label;
const labelOf = (name) => (String(name || '').startsWith(PREFIX) ? name.slice(PREFIX.length) : null);
// Nucleo's index stores inner markup; the app's glyphs are whole 18x18 documents, so it is wrapped to match.
const wrap = (svg) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">' + svg + '</svg>';
const row = (icon) => ({ name: iconName(icon.n), label: icon.n, svg: wrap(icon.s) });

// Label first, then tags, the way the palette ranks its own rows: an exact name, a name that starts with the query,
// a name that contains it, then a tag that matches. Ranked here rather than in the renderer because the set that is
// being ranked is here — the renderer only ever receives a page of results.
function searchIcons(query, limit = 60) {
  const q = String(query || '').trim().toLowerCase();
  const all = icons();
  if (!q) return all.slice(0, limit).map(row); // the library's own order, which groups by subject
  const hits = [];
  for (const icon of all) {
    const name = icon.n.toLowerCase();
    const rank = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2
      : (',' + icon.t + ',').includes(',' + q + ',') ? 3 : icon.t.includes(q) ? 4 : -1;
    if (rank >= 0) hits.push([rank, name.length, icon]);
  }
  return hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, limit).map(([, , icon]) => row(icon));
}

// type uri -> Nucleo label, read once and kept: plainRow asks for every typed row it builds, and a SQLite read per
// row is a read per row.
let chosen = null;
function stored() {
  if (chosen) return chosen;
  const value = settings.get('typeIcons');
  chosen = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  return chosen;
}
const forgetTypeIcons = () => { chosen = null; }; // the settings row changed under us (a restore, a test)
const typeIconName = (typeUri) => { const label = typeUri && stored()[typeUri]; return label ? iconName(label) : null; };
// The glyphs the renderer has to know about right now: one per type that has been given an icon. Sent with the
// roots, so a row is never drawn before the glyph it names exists (renderer/nodes.js loadRoots).
const typeIcons = () => Object.entries(stored())
  .map(([uri, label]) => { const icon = icons().find((i) => i.n === label); return icon ? { uri, ...row(icon) } : null; })
  .filter(Boolean);
// Choosing one: a label from the set, or null to go back to the generic type glyph. Stored under the type, so every
// document of that type follows it. The generic glyph is kept as a null entry rather than no entry: it is a choice
// too, and fillTypeIcons only picks for types nobody has chosen for.
// A document (tana:text:) can take one of its own too, which it wears instead of its type's (main/rows.js plainRow).
function setTypeIcon(typeUri, name) {
  if (typeof typeUri !== 'string' || !/^tana:(type:[0-9a-z]{26}(\?attribute=[0-9a-z]{8})?|(search|text):[0-9a-z]{26})$/.test(typeUri)) throw new Error('Icons are set on a type, a field, a saved search or a document');
  const next = { ...stored() };
  if (name == null) next[typeUri] = null;
  else {
    const label = labelOf(name) || String(name);
    if (!icons().some((i) => i.n === label)) throw new Error('No icon called ' + label);
    next[typeUri] = label;
  }
  settings.set('typeIcons', next);
  chosen = next;
  return name == null ? null : { uri: typeUri, ...row(icons().find((i) => i.n === (labelOf(name) || name))) };
}
// At boot (main.js autoTypeIcons): the types and fields with no choice at all get the one `pick` (main/ai.js pickTypeIcons) names,
// in one write. A name outside the set is dropped, and so is a type chosen for while the model was answering.
async function fillTypeIcons(types, pick) {
  const missing = types.filter((t) => !(t.uri in stored()));
  if (!missing.length) return 0;
  const picks = await pick(missing, icons().map((i) => i.n));
  const next = { ...stored() };
  const known = new Set(icons().map((i) => i.n));
  const fresh = missing.filter((t) => !(t.uri in next) && known.has(picks && picks[t.uri]));
  if (!fresh.length) return 0;
  for (const t of fresh) next[t.uri] = picks[t.uri];
  settings.set('typeIcons', next);
  chosen = next;
  return fresh.length;
}

// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table).
const ipc = {
  // a type's own glyph: the built-in Nucleo set to search, and the glyphs currently chosen (sent with every roots load so
  // no row is drawn before the glyph it names exists); the choice itself is main.js icons:setType, which refreshes the views
  'icons:search': (_e, query) => searchIcons(query),
  'icons:types': () => typeIcons(),
};

module.exports = { searchIcons, typeIcons, typeIconName, setTypeIcon, fillTypeIcons, iconName, labelOf, forgetTypeIcons, ipc };

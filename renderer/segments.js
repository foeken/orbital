'use strict';
// Text segments ([{ text, marks? } | { mention }]) to and from plain text and DOM, plus date helpers.

// ---- segments: [{ text, marks? } | { mention: { label, uri } }] <-> plain text <-> DOM ----
// marks = { bold, italic, strike, code, link: href } on one text run: exactly the shape api.setText takes back.
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const isoDay = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); // a Date's local YYYY-MM-DD: the one way the app writes a day
const localDate = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return isoDay(d); }; // today's, N days on (1 = tomorrow)
// this week's node's title, "Week 38 (2026)" (ISO week), as main/pins.js weekTitle makes it
const weekTitle = () => { const d = new Date(), t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return 'Week ' + Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7) + ' (' + t.getUTCFullYear() + ')'; };
// A date mention (sdk/dates.js): tana:plaindate:YYYY-MM-DD, or tana:zoneddate:… with a time and a zone. dayOfUri is
// its day, the page its chip opens; dayUri and dayLabel are what "@" writes: a plaindate, labelled the way Tana does.
const dayOfUri = (uri) => (/^tana:(?:plaindate|zoneddate):(\d{4}-\d{2}-\d{2})/.exec(uri || '') || [])[1];
const dayUri = (day) => 'tana:plaindate:' + day;
const DAY_LABEL = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const dayLabel = (day) => DAY_LABEL.format(new Date(day + 'T00:00:00'));
// accepts segments, a plain string, or a Node
const segsOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? (v ? [{ text: v }] : []) : v.segments || (v.text ? [{ text: v.text }] : []));
const plainOf = (v) => segsOf(v).map((s) => ('text' in s ? s.text : s.mention.label)).join('');
let demoMode = false; // Cmd+K "Toggle demo mode": made-up names and words on screen, and every Tana write refused (renderer/state.js reads the stored choice)
// Short words stand in for short ones ("to", "the", "Q4"), so a masked title keeps the rhythm of a sentence.
const DEMO_SHORT = ['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'with', 'by', 'at', 'up', 'new', 'our', 'its', 'all', 'one', 'two', 'big', 'odd', 'red', 'sky', 'sun', 'sea', 'owl', 'fox', 'map', 'key', 'ink', 'jam', 'hum', 'zip', 'go', 'we', 'so'];
const DEMO_WORDS = ['velvet', 'comet', 'cobalt', 'orchard', 'signal', 'lantern', 'orbit', 'wildflower', 'copper', 'moonlit', 'ripple', 'midnight',
  'canvas', 'thunder', 'silver', 'afterglow', 'paper', 'starlight', 'glacier', 'daybreak', 'foxglove', 'tideline', 'ember', 'horizon', 'paradox',
  'quietly', 'electric', 'drifting', 'bright', 'gather', 'harbor', 'meadow', 'compass', 'saffron', 'granite', 'marble', 'pepper', 'biscuit',
  'tangerine', 'lagoon', 'cactus', 'pelican', 'walrus', 'otter', 'falcon', 'badger', 'heron', 'dolphin', 'penguin', 'raccoon', 'kettle', 'teapot',
  'blanket', 'pillow', 'ladder', 'bicycle', 'trumpet', 'violin', 'accordion', 'banjo', 'rocket', 'satellite', 'nebula', 'meteor', 'galaxy',
  'volcano', 'canyon', 'island', 'river', 'forest', 'prairie', 'tundra', 'desert', 'waterfall', 'lighthouse', 'windmill', 'bakery', 'library',
  'museum', 'garden', 'balcony', 'attic', 'cellar', 'workshop', 'postcard', 'envelope', 'notebook', 'pencil', 'crayon', 'sketch', 'mosaic',
  'puzzle', 'riddle', 'journey', 'voyage', 'picnic', 'festival', 'parade', 'carnival', 'harvest', 'blossom', 'pebble', 'feather', 'crystal',
  'plan', 'draft', 'review', 'polish', 'launch', 'wander', 'borrow', 'juggle', 'whisper', 'sparkle', 'tumble', 'wobble', 'giggle',
  'shuffle', 'nibble', 'ponder', 'doodle', 'rescue', 'untangle', 'measure', 'balance', 'arrange', 'follow', 'imagine', 'discover', 'collect',
  'curious', 'gentle', 'fuzzy', 'crisp', 'breezy', 'cozy', 'sunny', 'rusty', 'dusty', 'golden', 'hollow', 'humble', 'jolly', 'lucky', 'mellow',
  'nimble', 'plucky', 'quirky', 'rapid', 'sleepy', 'spicy', 'tiny', 'vivid', 'wiggly', 'zesty', 'honest', 'clever', 'patient', 'restless'];
const DEMO_FIRST = ['Avery', 'Jordan', 'Casey', 'Taylor', 'Morgan', 'Riley', 'Alex', 'Jamie', 'Noor', 'Lotte', 'Sven', 'Mila', 'Daan', 'Fleur',
  'Mateo', 'Ines', 'Yusuf', 'Hana', 'Oscar', 'Freya', 'Kofi', 'Amara', 'Luca', 'Elif', 'Ravi', 'Sofia', 'Emeka', 'Greta', 'Tomas', 'Leila'];
const DEMO_MIDDLE = ['Quinn', 'Rowan', 'Sage', 'Ellis', 'River', 'Noel', 'Marie', 'Jan', 'Ann', 'Lee'];
const DEMO_LAST = ['Lee', 'Rivera', 'Brooks', 'Chen', 'Patel', 'Bennett', 'Parker', 'de Wit', 'Jansen', 'Bakker', 'Visser', 'Okafor', 'Nakamura',
  'Moreau', 'Rossi', 'Novak', 'Lindqvist', 'Haddad', 'Kowalski', 'Mendes', 'Osei', 'Fischer', 'Silva', 'Horvath', 'Duarte', 'Ahmadi', 'Keller'];
function demoHash(identity) {
  let hash = 2166136261;
  for (const char of String(identity || '')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}
const demoWordCount = (value) => (String(value || '').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length;
function demoPersonName(identity, count = 2) {
  const pick = (list, part) => list[demoHash(identity + ':' + part) % list.length], words = Math.max(1, count); // each part drawn on its own
  if (words === 1) return pick(DEMO_FIRST, 'first');
  return [pick(DEMO_FIRST, 'first'), ...Array.from({ length: words - 2 }, (_, i) => pick(DEMO_MIDDLE, 'middle' + i)), pick(DEMO_LAST, 'last')].join(' ');
}
function demoWords(value, identity) {
  let index = 0;
  return String(value || '').replace(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu, (word) => {
    if (/^\p{N}+$/u.test(word)) return word; // a number says nothing about whose it is, and a time or date masked into words ("and:for–on:in") reads as broken
    const list = word.length <= 3 ? DEMO_SHORT : DEMO_WORDS;
    const replacement = list[demoHash(identity + ':' + index++) % list.length]; // each word drawn on its own: neighbours no longer walk the list in order
    return /\p{Lu}/u.test(word[0]) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement; // a capital stays a capital, never all caps
  });
}
// Demo mode masks what came from Tana and leaves the app's own words alone: a page or row of the app's own
// (orbital:…) keeps its text, and inside one only the parts marked as a name (person) or as Tana's content are masked.
// A saved search's title is a place in the app ("My Tasks"), so it reads as itself, like the app's own pages.
const appOwned = (identity) => /^(orbital|tana:search):/.test(String(identity || ''));
const demoText = (value, identity) => !demoMode || appOwned(identity) ? value : String(identity || '').startsWith('tana:user-profile:') ? demoPersonName(identity, demoWordCount(value)) : demoWords(value, identity);
// A row's grey meta is a date, "MCP" or, for a type, the space it lives in: only that last one is Tana's words.
const demoMeta = (node, meta) => (demoMode && meta && /^tana:type:/.test((node && node.id) || '') ? demoText(meta, 'space') : meta);
function demoSegments(segs, identity) {
  if (!demoMode) return segs;
  if (String(identity || '').startsWith('tana:user-profile:')) return [{ text: demoPersonName(identity, demoWordCount(plainOf(segs))) }];
  const ownWords = appOwned(identity);
  let index = 0;
  return segs.map((s) => {
    const seed = String(identity || '') + ':' + index++;
    if (s.person) return { ...s, text: s.text.replace(/\S.*\S|\S/, (name) => demoPersonName(name, demoWordCount(name))) };
    if (s.keep || (ownWords && !s.content)) return s; // the app's wording, or Tana's fixed sentence around a notification's names
    if ('text' in s) return { ...s, text: demoWords(s.text, seed) };
    if (dayOfUri(s.mention.uri)) return s; // a date is a date, and says nothing about anyone
    const label = s.mention.uri.startsWith('tana:user-profile:')
      ? demoPersonName(s.mention.uri, demoWordCount(s.mention.label)) : demoWords(s.mention.label, seed);
    return { ...s, mention: { ...s.mention, label } };
  });
}
const MARK_TAGS = { code: 'code', strike: 's', underline: 'u', italic: 'em', bold: 'strong' }; // innermost first: the order a run is wrapped in
// The caret anchor is a placeholder, not content: readSegs strips it and every offset helper counts it as nothing,
// so what is stored and what the caret reports are the same with it as without it.
const CARET_ANCHOR = '\u200b';
const unanchored = (s) => (s && s.includes(CARET_ANCHOR) ? s.split(CARET_ANCHOR).join('') : s);
const hasMarks = (marks) => !!marks && Object.keys(marks).length > 0;
const markKey = (marks) => JSON.stringify(Object.entries(marks || {}).sort()); // two runs merge only when their marks match
function markWrap(nodes, marks) {
  let out = nodes;
  for (const [name, tag] of Object.entries(MARK_TAGS)) if (marks[name]) { const el = document.createElement(tag); el.append(...out); out = [el]; }
  if (marks.link) { const a = document.createElement('a'); a.className = 'link'; a.dataset.href = marks.link; a.append(...out); out = [a]; } // outermost: the whole run is one link
  return out;
}
function renderSegs(el, segs, identity) {
  segs = demoSegments(segs, identity);
  const nodes = segs.flatMap((s, i) => {
    // Chromium needs a placeholder newline after a trailing soft break to put the caret on the empty line; readSegs strips it
    if ('text' in s) {
      const text = s.text + (i === segs.length - 1 && s.text.endsWith('\n') ? '\n' : '');
      const nodes = s.marks && s.marks.link ? [document.createTextNode(text)] : linkify(text); // a link mark is already the link
      return hasMarks(s.marks) ? markWrap(nodes, s.marks) : nodes;
    }
    const a = document.createElement('a'); a.className = 'mention'; a.dataset.uri = s.mention.uri; a.contentEditable = 'false'; a.textContent = s.mention.label;
    // A reference says what it points at: its target's icon, in the link's own colour (main resolves it). The
    // label moves into a span of its own so the underline stays under the words, the way Tana draws it, and
    // textContent still reads back as the label alone — an icon is paths, not text.
    // A mention of a node that is gone keeps its words — that is what was written — but takes the trash glyph, the
    // strike and the plain text colour: it is no longer somewhere to go, and the click is refused as well.
    const gone = markGone(s.mention.uri, s.mention.deleted);
    const icon = gone ? 'trash' : s.mention.icon || (dayOfUri(s.mention.uri) ? 'today' : undefined);
    if (gone) a.classList.add('gone');
    // dataset.icon is what readSegs carries back, so it stays the kind the target is: the trash glyph belongs to the
    // state the app found it in, not to the mention that was written.
    if (s.mention.icon) a.dataset.icon = s.mention.icon;
    // its type's colour, the way its row and chip are; carried on the element like the icon so it survives an edit
    if (!gone && s.mention.hue != null) { a.dataset.hue = String(s.mention.hue); a.classList.add('hue'); a.style.setProperty('--hue', String(s.mention.hue)); }
    if (icon) {
      const label = document.createElement('span'); label.className = 'mlabel'; label.textContent = s.mention.label;
      const svg = iconNode(icon);
      a.replaceChildren(...(svg ? [svg, label] : [label]));
    }
    blurSensitive(a, s.mention.uri); // the node's title, hidden as its own row hides it (docs/UI-PATTERNS.md, Content that is someone's)
    return [a];
  });
  // Same kind of placeholder: Chromium holds no caret before a non-editable inline that starts the field, so a row
  // beginning with a chip — a block whose only content is a reference, which is Tana's full-reference presentation —
  // gets a zero-width space to hold it. Typing there prepends text and the block becomes an inline reference.
  if (segs.length && !('text' in segs[0])) nodes.unshift(document.createTextNode(CARET_ANCHOR));
  // and none after one that ends the field either, which is why the caret showed at the start of such a line but not at its end
  if (segs.length && !('text' in segs.at(-1))) nodes.push(document.createTextNode(CARET_ANCHOR));
  el.replaceChildren(...nodes);
}
// Plain http(s) URLs inside a text run become clickable without leaving the text editable: readSegs reads the
// anchor back as its own characters, so the stored text is unchanged.
const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;
// The node uri behind a link home.tana.inc opens, the reverse of main's doc:link (/o/<org>/<route>/<encoded node uri>),
// or a bare uri. One link and nothing else: prose that merely contains one, another host or an id that is not a
// 26-character ULID all read as "not a node link". The one parser for this, used by the paste handler.
const TANA_URI_RE = /^tana:[a-z-]+:[0-9a-z]{26}$/;
function tanaNodeUri(text) {
  const s = String(text ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  let decoded = s;
  try { decoded = decodeURIComponent(s); } catch { /* a stray % is not a link */ }
  if (TANA_URI_RE.test(decoded)) return decoded;
  const m = /^https:\/\/home\.tana\.inc\/\S*\/(tana:[a-z-]+:[0-9a-z]{26})(?:[/?#]\S*)?$/.exec(decoded);
  return m ? m[1] : null;
}
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.className = 'url'; a.dataset.href = m[0]; a.textContent = m[0];
    out.push(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out.length ? out : [document.createTextNode(text)];
}
// a run's marks are the elements it sits in, so bold inside a link reads back as one run carrying both
function marksOf(el, marks) {
  const name = el.nodeName;
  if (name === 'A') return el.classList.contains('link') ? { ...marks, link: el.dataset.href } : marks; // a.url is the bare-URL linkify, not a mark
  const found = Object.entries(MARK_TAGS).find(([, tag]) => tag === name.toLowerCase())
    || (name === 'B' ? ['bold'] : name === 'I' ? ['italic'] : name === 'STRIKE' || name === 'DEL' ? ['strike'] : null);
  return found ? { ...marks, [found[0]]: true } : marks;
}
function readSegs(el) {
  const segs = [];
  const add = (t, marks) => {
    t = unanchored(t);
    if (!t) return;
    const last = segs.at(-1);
    if (last && 'text' in last && markKey(last.marks) === markKey(marks)) last.text += t;
    else segs.push(hasMarks(marks) ? { text: t, marks } : { text: t });
  };
  const walk = (parent, marks) => {
    for (const n of parent.childNodes) {
      // the icon travels with the mention, so typing beside one does not drop it until the next reload
      if (n.nodeType === 1 && n.classList.contains('mention')) { segs.push({ mention: { label: n.textContent, uri: n.dataset.uri, ...(n.dataset.icon ? { icon: n.dataset.icon } : {}), ...(n.dataset.hue ? { hue: Number(n.dataset.hue) } : {}) } }); continue; }
      if (n.nodeName === 'BR') { add('\n', marks); continue; }
      if (n.nodeType === 1) { walk(n, marksOf(n, marks)); continue; }
      add(n.textContent, marks);
    }
  };
  walk(el, {});
  const last = segs.at(-1);
  if (last && 'text' in last && last.text.endsWith('\n\n')) last.text = last.text.slice(0, -1);
  return segs;
}
// split segments at a plain-text offset; a mention hit by the cut stays whole in the first half
function splitSegs(segs, off) {
  const before = [], after = [];
  for (const s of segs) {
    const len = 'text' in s ? s.text.length : s.mention.label.length;
    if (off >= len) { before.push(s); off -= len; }
    else if (off <= 0) after.push(s);
    else if ('text' in s) { before.push({ ...s, text: s.text.slice(0, off) }); after.push({ ...s, text: s.text.slice(off) }); off = 0; } // marks survive the cut
    else { before.push(s); off = 0; }
  }
  return [before, after];
}
// empty runs go, neighbours with the same marks join: a toggled-off mark leaves one run again, not three
const mergeSegs = (segs) => segs.filter((s) => !('text' in s) || s.text).reduce((out, s) => {
  const last = out.at(-1);
  if (last && 'text' in last && 'text' in s && markKey(last.marks) === markKey(s.marks)) last.text += s.text;
  else out.push({ ...s });
  return out;
}, []);
// one mark set (value) or cleared (null) over [start, end) — the whole block's segments come back, which is what api.setText takes
function markRange(segs, start, end, mark, value) {
  const [before, rest] = splitSegs(segs, start), [middle, after] = splitSegs(rest, end - start);
  return mergeSegs([...before, ...middle.map((s) => {
    if (!('text' in s)) return s;
    const marks = { ...s.marks };
    if (value) marks[mark] = value; else delete marks[mark];
    return hasMarks(marks) ? { text: s.text, marks } : { text: s.text };
  }), ...after]);
}
// the whole selection already carries the mark: that is what makes a toolbar button a toggle
function hasMark(segs, start, end, mark) {
  const runs = splitSegs(splitSegs(segs, start)[1], end - start)[0].filter((s) => 'text' in s && s.text);
  return runs.length > 0 && runs.every((s) => s.marks && s.marks[mark]);
}
const saveValue = (segs) => (segs.some((s) => 'mention' in s || hasMarks(s.marks)) ? segs : plainOf(segs));
// The "- " shortcut: a dash *and the space after it* at the very start of the line, with the caret just past them.
// Asked with the words before the caret. The space is part of the gesture — a lone dash is a word someone may be
// in the middle of typing, and turning it into a bullet the moment it is pressed takes the line away mid-thought.
// A dash further into the line, a pasted list and a sentence containing one all fail it.
// `listRest` is the other half: what the line still holds once the marker is dropped, so no caller decides for
// itself how much to throw away.
const startsList = (before) => before === '- ' || before === '* ';
const listRest = (segs, offset) => splitSegs(segs, offset || 0)[1];
// The rest of markdown's line starts (#598), typed the same way: the marker at the very start of the row, the caret
// just past it. toolbar.js restyle turns the row into that kind.
const LINE_MARKERS = { '# ': 'heading1', '## ': 'heading2', '### ': 'heading3', '1. ': 'numbered', '> ': 'quote', '```': 'code', '[] ': 'todo', '[ ] ': 'todo', '---': 'divider' };
const lineMarker = (before) => (Object.hasOwn(LINE_MARKERS, before) ? LINE_MARKERS[before] : null);
// Inline markdown as it is typed (#598): when the closing delimiter lands, the words it closes take the mark and the
// delimiters go. Only over plain words: a chip or code inside leaves what was typed alone. { segs, caret } or null.
const TYPED_MARKS = [[/\*\*([^*\n]+)\*\*$/, 'bold'], [/~~([^~\n]+)~~$/, 'strike'], [/`([^`\n]+)`$/, 'code'],
  [/(?<![*\w])\*([^*\s][^*\n]*)\*$/, 'italic'], [/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/, 'link']];
function typedMark(segs, off) {
  const before = plainOf(splitSegs(segs, off)[0]);
  for (const [re, mark] of TYPED_MARKS) {
    const m = re.exec(before);
    if (!m) continue;
    const open = m[0].indexOf(m[1]), [head, rest] = splitSegs(segs, m.index), [marked, tail] = splitSegs(rest, m[0].length);
    if (marked.some((s) => !('text' in s) || (s.marks && s.marks.code))) return null;
    const words = mergeSegs([...head, ...splitSegs(splitSegs(marked, open)[1], m[1].length)[0], ...tail]);
    return { segs: markRange(words, m.index, m.index + m[1].length, mark, mark === 'link' ? m[2] : true), caret: m.index + m[1].length };
  }
  return null;
}
// Pasted text read as markdown (#598, edit.js pasteMarkdown): two lines or more, a line starting with a marker, or an
// inline mark or link. A plain line pastes as it is.
const looksMarkdown = (text) => /\S[^\S\n]*\n\s*\S|^\s*(?:[-*+] |\d+[.)] |#{1,6} |> |```|-{3,}\s*$)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]*\]\((?:https?:|tana:)[^)\s]+\)|(?<![*\w])\*[^*\s][^*\n]*\*/m.test(text);
// The iPhone app's demo mode masks with these same words (ios/engine/demo.js); in the window there is no module
if (typeof module === 'object') module.exports = { demoText, demoSegments, demoPersonName, demoWordCount, isoDay, setDemo: (on) => { demoMode = on; } };

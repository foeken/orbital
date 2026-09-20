'use strict';
// Text segments ([{ text, marks? } | { mention }]) to and from plain text and DOM, plus date helpers.

// ---- segments: [{ text, marks? } | { mention: { label, uri } }] <-> plain text <-> DOM ----
// marks = { bold, italic, strike, code, link: href } on one text run: exactly the shape api.setText takes back.
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const localDate = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }; // today, YYYY-MM-DD
// accepts segments, a plain string, or a Node
const segsOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? (v ? [{ text: v }] : []) : v.segments || (v.text ? [{ text: v.text }] : []));
const plainOf = (v) => segsOf(v).map((s) => ('text' in s ? s.text : s.mention.label)).join('');
const MARK_TAGS = { code: 'code', strike: 's', italic: 'em', bold: 'strong' }; // innermost first: the order a run is wrapped in
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
function renderSegs(el, segs) {
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
    const icon = gone ? 'trash' : s.mention.icon;
    if (gone) a.classList.add('gone');
    // dataset.icon is what readSegs carries back, so it stays the kind the target is: the trash glyph belongs to the
    // state the app found it in, not to the mention that was written.
    if (s.mention.icon) a.dataset.icon = s.mention.icon;
    if (icon) {
      const label = document.createElement('span'); label.className = 'mlabel'; label.textContent = s.mention.label;
      const svg = iconNode(icon);
      a.replaceChildren(...(svg ? [svg, label] : [label]));
    }
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
// The node uri behind a link home.tana.inc opens, the reverse of main's doc:link (/o/<org>/l/<encoded node uri>),
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
      if (n.nodeType === 1 && n.classList.contains('mention')) { segs.push({ mention: { label: n.textContent, uri: n.dataset.uri, ...(n.dataset.icon ? { icon: n.dataset.icon } : {}) } }); continue; }
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

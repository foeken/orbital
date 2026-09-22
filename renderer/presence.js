'use strict';
// Presence (issue #14; main/presence.js). Show: everyone else in the document on screen, as avatars beside the title and
// a coloured marker on the row their caret is in; and on a list, small avatars on every document row someone is in.
// Tell: where your caret is while you edit here, as the block and the exact position, so Tana draws it.
let presenceDoc = null;           // the page on screen: it gets the heartbeat and your caret
const presenceRooms = new Set();  // every document whose room is open: the page and the document rows on screen
const presenceByDoc = new Map();  // docId -> [{ peer, userHash, me, name, blockId, editing }] from main (me: your other tab)
let presenceSent = null;          // the caret last told, as JSON
// Rooms follow the scroll: the document rows on screen and one screen above and below, re-checked as you scroll, and
// never more than this many at once however tall the window.
const ROW_ROOMS = 60;
const presenceHue = (p) => Number(BigInt(p.userHash || 0) % 360n); // one colour per person, the same everywhere
const initials = (name) => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

// the documents drawn as rows on screen or within a screen of it, in page order
function presenceRowDocs() {
  const out = [], view = outline.parentElement.getBoundingClientRect(), reach = view.height;
  for (const el of outline.querySelectorAll('.node')) {
    const box = el.getBoundingClientRect();
    if (box.bottom < view.top - reach || box.top > view.bottom + reach) continue;
    const item = items.get(el.dataset.key), node = item && (referenceTarget(item.node) || item.node);
    if (node && node.kind === 'document' && isRealId(node.id) && !out.includes(node.id)) out.push(node.id);
  }
  return out;
}
// After every render: open the rooms of what is on screen now, close the rest, then draw who is where.
function syncPresence() {
  if (!tana.presenceOpen) return;
  const page = zoom ? zoom.docId : null;
  if (page !== presenceDoc) {
    if (presenceDoc) tana.presenceSet(presenceDoc, null);
    presenceDoc = page; presenceSent = null;
    viewPresence();
  }
  syncRooms();
  paintPresence();
}
function syncRooms() {
  const page = presenceDoc;
  const want = new Set([...(page ? [page] : []), ...presenceRowDocs().filter((id) => id !== page).slice(0, ROW_ROOMS)]);
  for (const id of presenceRooms) if (!want.has(id)) { tana.presenceClose(id); presenceRooms.delete(id); presenceByDoc.delete(id); }
  // counted as open only once main says it is: one refused (no connection yet) or failed is asked for again next time
  for (const id of want) if (!presenceRooms.has(id)) {
    presenceRooms.add(id);
    Promise.resolve(tana.presenceOpen(id)).then((ok) => { if (!ok) presenceRooms.delete(id); }, () => presenceRooms.delete(id));
  }
}
// Scrolling brings other rows into reach: their rooms open, the ones scrolled far away close.
let presenceScroll = null;
outline.parentElement.addEventListener('scroll', () => { if (!presenceScroll) presenceScroll = setTimeout(() => { presenceScroll = null; if (tana.presenceOpen) { syncRooms(); paintPresence(); } }, 200); }, { passive: true });
// The viewing heartbeat, as Tana sends it: for the page on screen, only while the window is visible and you were active
// (a key, the mouse, a scroll) in the last minute. Main sends it every 10 s while a page is named, and stops at null.
const ACTIVE_MS = 60000;
let lastActive = Date.now(), presenceViewed;
function viewPresence() {
  if (!tana.presenceView) return;
  const page = document.visibilityState === 'visible' && Date.now() - lastActive < ACTIVE_MS ? presenceDoc : null;
  if (page === presenceViewed) return;
  presenceViewed = page;
  tana.presenceView(page);
}
for (const type of ['keydown', 'mousedown', 'mousemove', 'wheel']) document.addEventListener(type, () => { const idle = Date.now() - lastActive >= ACTIVE_MS; lastActive = Date.now(); if (idle) viewPresence(); }, { passive: true, capture: true });
document.addEventListener('visibilitychange', viewPresence);
setInterval(viewPresence, 10000); // notices the minute of inactivity running out
function avatarEl(p, cls) {
  const a = document.createElement('span');
  a.className = cls + (p.editing ? ' editing' : '') + (p.me ? ' me' : '');
  a.style.setProperty('--hue', String(presenceHue(p)));
  a.textContent = initials(p.name);
  a.title = p.me ? 'You, in another tab' + (p.editing ? ', editing this' : '') : p.name + (p.editing ? ' is editing this' : ' is here');
  return a;
}
function paintPresence() {
  let strip = document.getElementById('presence');
  if (!strip) { strip = document.createElement('div'); strip.id = 'presence'; strip.className = 'presence'; titleEl.parentElement.append(strip); }
  const here = presenceByDoc.get(presenceDoc) || [];
  strip.replaceChildren(...here.map((p) => avatarEl(p, 'pavatar')));
  for (const el of document.querySelectorAll('.pcaret, .prow')) el.remove();
  for (const line of eachRow('.node > .line')) {
    const item = items.get(line.parentElement.dataset.key);
    if (!item) continue;
    // a row of this page's outline that someone's caret is in
    for (const p of here) {
      if (!p.blockId || item.docId !== presenceDoc || item.node.id !== p.blockId) continue;
      const mark = document.createElement('span');
      mark.className = 'pcaret'; mark.style.setProperty('--hue', String(presenceHue(p))); mark.title = p.me ? 'You, in another tab' : p.name; mark.dataset.name = initials(p.name);
      line.append(mark);
    }
    // a document row someone is in: their avatars at the end of it
    const node = referenceTarget(item.node) || item.node;
    const inside = node.kind === 'document' && node.id !== presenceDoc ? presenceByDoc.get(node.id) || [] : [];
    if (!inside.length) continue;
    const row = document.createElement('span'); row.className = 'prow';
    row.append(...inside.slice(0, 3).map((p) => avatarEl(p, 'pmini')));
    if (inside.length > 3) row.append('+' + (inside.length - 3));
    line.append(row);
  }
}
// Tell: the block and the exact caret (or selection) while it is in this page's outline; nothing once it leaves it or
// the window. Offsets count characters as the row shows them; main turns them into Loro cursors.
function caretIn(el) {
  const s = getSelection();
  if (!s.rangeCount || !el.contains(s.anchorNode) || !el.contains(s.focusNode)) return null;
  const at = (node, off) => { const r = document.createRange(); r.selectNodeContents(el); r.setEnd(node, off); return unanchored(r.toString()).length; };
  return { anchor: at(s.anchorNode, s.anchorOffset), focus: at(s.focusNode, s.focusOffset) };
}
let presenceTimer = null;
function tellPresence() {
  if (!presenceDoc || !tana.presenceSet) return;
  const el = document.activeElement, item = el && el.classList && el.classList.contains('text') && document.hasFocus() ? items.get(keyOfEl(el)) : null;
  const caret = item && item.docId === presenceDoc && item.node.kind === 'block' && !item.node.draft ? caretIn(el) : null;
  const at = caret ? { blockId: item.node.id, ...caret } : null, key = JSON.stringify(at);
  if (key === presenceSent) return;
  presenceSent = key;
  tana.presenceSet(presenceDoc, at);
}
// every caret move while typing, at most one message per 150 ms
const tellSoon = () => { if (!presenceTimer) presenceTimer = setTimeout(() => { presenceTimer = null; tellPresence(); }, 150); };
document.addEventListener('selectionchange', tellSoon);
document.addEventListener('focusout', () => queueMicrotask(tellPresence));
window.addEventListener('blur', tellPresence);
window.addEventListener('focus', tellSoon);
// the connection coming up is when a room refused before it can open: follow the page again
if (tana.onStatus) tana.onStatus((s) => { if (s && s.connected) queueMicrotask(syncPresence); });
if (tana.onPresence) tana.onPresence((docId, peers) => { if (presenceRooms.has(docId)) { presenceByDoc.set(docId, Array.isArray(peers) ? peers : []); paintPresence(); } });

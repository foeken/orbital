'use strict';
// Presence (issue #14; main/presence.js), for the page on screen only. Show: everyone else's caret in it, on the row and
// at the character it is on, labelled with their name as Tana labels one. Tell: where your caret is while you edit
// here, as the block and the exact position, so Tana draws it.
let presenceDoc = null;   // the page on screen: its room is open, it gets the heartbeat and your caret
let presenceOpen = false; // main has said the room is open
let presencePeers = [];   // [{ peer, userHash, me, name, blockId, offset, editing }] from main (me: your other tab)
let presenceSent = null;  // the caret last told, as JSON
const presenceHue = (p) => Number(BigInt(p.userHash || 0) % 360n); // one colour per person, the same everywhere

// After every render: follow the page (open its room, close the last one's), then draw the carets.
function syncPresence() {
  if (!tana.presenceOpen) return;
  const page = zoom && isRealId(zoom.docId) ? zoom.docId : null; // a draft or a page of the app's own has no room in Tana
  if (page !== presenceDoc) {
    if (presenceDoc) { tana.presenceSet(presenceDoc, null); if (presenceOpen) tana.presenceClose(presenceDoc); }
    presenceDoc = page; presenceOpen = false; presencePeers = []; presenceSent = null;
    viewPresence();
  }
  // counted as open only once main says it is: refused (no connection yet) or failed, it is asked for again next time
  if (page && !presenceOpen) {
    presenceOpen = true;
    Promise.resolve(tana.presenceOpen(page)).then((ok) => { if (!ok && presenceDoc === page) presenceOpen = false; }, () => { if (presenceDoc === page) presenceOpen = false; });
  }
  paintPresence();
}
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
// Main ran the heartbeat for another page, and that page stopped it (closed, or moved off a document): this one says
// again what it views, since it told main once and would not repeat itself.
if (tana.onPresenceAsk) tana.onPresenceAsk(() => { presenceViewed = undefined; viewPresence(); });
setInterval(viewPresence, 10000); // notices the minute of inactivity running out
// Where a character offset is inside a row's text, as a screen rectangle: the text as the row shows it, mention labels
// included and the caret anchors the editor keeps left out (segments.js CARET_ANCHOR). Past the end: the end.
function caretRect(el, offset) {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = offset, last = null;
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    const s = node.data;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === CARET_ANCHOR) continue;
      if (left === 0) return rangeRect(node, i);
      left--;
    }
    last = node;
  }
  return last ? rangeRect(last, last.data.length) : null;
}
// the first line of a row's text, for a caret with no character to stand on
function textStart(el) {
  const r = el.getBoundingClientRect(), lh = parseFloat(getComputedStyle(el).lineHeight);
  return { left: r.left, top: r.top, height: Number.isFinite(lh) ? Math.min(lh, r.height || lh) : r.height };
}
function rangeRect(node, i) {
  const r = document.createRange(); r.setStart(node, i); r.collapse(true);
  const box = r.getClientRects()[0] || r.getBoundingClientRect();
  return box && (box.height || box.top) ? box : null;
}
// Where each caret was last drawn, against the outline: a caret that moved glides there, one that has just arrived
// pops in (renderer/motion.js). Kept here rather than read off the old marks, since a render rebuilds the rows they sat on.
let caretsAt = new Map();
function paintPresence() {
  for (const el of document.querySelectorAll('.pcaret')) el.remove();
  const was = caretsAt;
  caretsAt = new Map();
  if (!presencePeers.length) return;
  const origin = outline.getBoundingClientRect();
  for (const line of eachRow('.node > .line')) {
    const item = items.get(line.parentElement.dataset.key);
    if (!item || item.docId !== presenceDoc) continue;
    for (const p of presencePeers) {
      // on the row itself, or in one of a table row's cells (their paragraphs are the blocks a caret in a cell names)
      const text = !p.blockId ? null : item.node.id === p.blockId ? line.querySelector('.text')
        : item.node.table ? line.querySelector('.cell[data-para="' + CSS.escape(p.blockId) + '"]') : null;
      if (!text) continue;
      const mark = document.createElement('span');
      const name = demoMode ? demoPersonName(p.userHash || p.name, demoWordCount(p.name)) : p.name;
      mark.className = 'pcaret'; mark.style.setProperty('--hue', String(presenceHue(p))); mark.title = p.me ? 'You, in another tab' : name;
      mark.dataset.name = name; // the full name, yours too, as Tana labels a caret
      line.append(mark);
      // at the character their caret is on, as Tana draws it; in an empty row, or before its position is known, where the
      // row's text begins (never the line's own left edge, which is out over the bullet)
      const box = (p.offset != null && caretRect(text, p.offset)) || textStart(text);
      if (!box) continue;
      const base = line.getBoundingClientRect();
      mark.classList.add('at');
      mark.style.left = (box.left - base.left) + 'px'; mark.style.top = (box.top - base.top) + 'px'; mark.style.height = box.height + 'px';
      // the name sits on top of the caret; on a row too near the top of the scroll area it would be clipped, so below
      if (box.top - outline.parentElement.getBoundingClientRect().top < 22) mark.classList.add('below');
      // per connection: one person in two tabs has two carets, each gliding from its own last place
      const who = (p.me ? 'me:' : '') + (p.userHash || p.name) + '|' + (p.peer || ''), now = mark.getBoundingClientRect(), x = now.left - origin.left, y = now.top - origin.top, old = was.get(who);
      caretsAt.set(who, [x, y]);
      if (!old) playOnce(mark, 'pop');
      else if (Math.abs(old[0] - x) > 1 || Math.abs(old[1] - y) > 1) play(mark, [{ transform: 'translate(' + (old[0] - x) + 'px, ' + (old[1] - y) + 'px)' }, { transform: 'none' }], { duration: MOTION.quick, easing: MOTION.move });
    }
  }
}
// Tell: the block and the exact caret (or selection) while it is in this page's outline; nothing once it leaves it or
// the window. Offsets count characters as the row shows them; main turns them into Loro cursors and Tana's positions.
function caretIn(el) {
  const s = getSelection();
  if (!s.rangeCount || !el.contains(s.anchorNode) || !el.contains(s.focusNode)) return null;
  const at = (node, off) => { const r = document.createRange(); r.selectNodeContents(el); r.setEnd(node, off); return unanchored(r.toString()).length; };
  return { anchor: at(s.anchorNode, s.anchorOffset), focus: at(s.focusNode, s.focusOffset) };
}
let presenceTimer = null;
function tellPresence() {
  if (!presenceDoc || !tana.presenceSet) return;
  // a caret in a table cell is on that cell's paragraph, which is the block Tana names for it
  const el = document.activeElement, cellPara = el && el.classList && el.classList.contains('cell') ? el.dataset.para : '';
  const item = el && el.classList && (el.classList.contains('text') || cellPara) && document.hasFocus() ? items.get(keyOfEl(el)) : null;
  const caret = item && item.docId === presenceDoc && item.node.kind === 'block' && !item.node.draft ? caretIn(el) : null;
  const at = caret ? { blockId: cellPara || item.node.id, ...caret } : null, key = JSON.stringify(at);
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
if (tana.onPresence) tana.onPresence((docId, peers) => { if (docId === presenceDoc) { presencePeers = Array.isArray(peers) ? peers : []; paintPresence(); } });

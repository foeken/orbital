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
  const page = zoom ? zoom.docId : null;
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
function rangeRect(node, i) {
  const r = document.createRange(); r.setStart(node, i); r.collapse(true);
  const box = r.getClientRects()[0] || r.getBoundingClientRect();
  return box && (box.height || box.top) ? box : null;
}
function paintPresence() {
  for (const el of document.querySelectorAll('.pcaret')) el.remove();
  if (!presencePeers.length) return;
  for (const line of eachRow('.node > .line')) {
    const item = items.get(line.parentElement.dataset.key);
    if (!item || item.docId !== presenceDoc) continue;
    for (const p of presencePeers) {
      if (!p.blockId || item.node.id !== p.blockId) continue;
      const mark = document.createElement('span');
      mark.className = 'pcaret'; mark.style.setProperty('--hue', String(presenceHue(p))); mark.title = p.me ? 'You, in another tab' : p.name;
      mark.dataset.name = p.name; // the full name, yours too, as Tana labels a caret
      line.append(mark);
      // at the character their caret is on, as Tana draws it; without an offset (not converted yet) at the row's start
      const text = line.querySelector('.text'), box = text && p.offset != null ? caretRect(text, p.offset) : null;
      if (!box) continue;
      const base = line.getBoundingClientRect();
      mark.classList.add('at');
      mark.style.left = (box.left - base.left) + 'px'; mark.style.top = (box.top - base.top) + 'px'; mark.style.height = box.height + 'px';
      // the name sits on top of the caret; on a row too near the top of the scroll area it would be clipped, so below
      if (box.top - outline.parentElement.getBoundingClientRect().top < 22) mark.classList.add('below');
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
if (tana.onPresence) tana.onPresence((docId, peers) => { if (docId === presenceDoc) { presencePeers = Array.isArray(peers) ? peers : []; paintPresence(); } });

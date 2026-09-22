'use strict';
// Presence (issue #14; main/presence.js): who else is in the document on screen, drawn as avatars beside the title and
// a coloured marker on the row their caret is in; and where your caret is, told to Tana while you edit here.
let presenceDoc = null;   // the document whose room is open: the zoomed one
let presencePeers = [];   // [{ peer, userHash, name, blockId, editing }] from main
let presenceBlock = null; // the block your caret is in, as last told
const presenceHue = (p) => Number(BigInt(p.userHash || 0) % 360n); // one colour per person, the same on every row
const initials = (name) => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

// After every render: follow the zoom (open the new room, close the old), then draw who is here.
function syncPresence() {
  if (!tana.presenceOpen) return;
  const want = zoom ? zoom.docId : null;
  if (want !== presenceDoc) {
    if (presenceDoc) { tana.presenceSet(presenceDoc, null); tana.presenceClose(presenceDoc); }
    presenceDoc = want; presencePeers = []; presenceBlock = null;
    if (want) tana.presenceOpen(want);
  }
  paintPresence();
}
function paintPresence() {
  let strip = document.getElementById('presence');
  if (!strip) { strip = document.createElement('div'); strip.id = 'presence'; strip.className = 'presence'; titleEl.parentElement.append(strip); }
  strip.replaceChildren(...presencePeers.map((p) => {
    const a = document.createElement('span');
    a.className = 'pavatar' + (p.editing ? ' editing' : '');
    a.style.setProperty('--hue', String(presenceHue(p)));
    a.textContent = initials(p.name);
    a.title = p.name + (p.editing ? ' is editing this' : ' is here');
    return a;
  }));
  for (const el of document.querySelectorAll('.pcaret')) el.remove();
  for (const p of presencePeers) {
    if (!p.blockId) continue;
    for (const line of eachRow('.node > .line')) {
      const item = items.get(line.parentElement.dataset.key);
      if (!item || item.docId !== presenceDoc || item.node.id !== p.blockId) continue;
      const mark = document.createElement('span');
      mark.className = 'pcaret'; mark.style.setProperty('--hue', String(presenceHue(p))); mark.title = p.name;
      mark.dataset.name = initials(p.name);
      line.append(mark);
    }
  }
}
// Tell: the block your caret is in, while it is in this document's outline; nothing once you leave it or the window.
function tellPresence() {
  if (!presenceDoc || !tana.presenceSet) return;
  const el = document.activeElement, item = el && el.classList && el.classList.contains('text') && document.hasFocus() ? items.get(keyOfEl(el)) : null;
  const block = item && item.docId === presenceDoc && item.node.kind === 'block' && !item.node.draft ? item.node.id : null;
  if (block === presenceBlock) return;
  presenceBlock = block;
  tana.presenceSet(presenceDoc, block);
}
document.addEventListener('focusin', () => queueMicrotask(tellPresence));
document.addEventListener('focusout', () => queueMicrotask(tellPresence));
window.addEventListener('blur', tellPresence);
window.addEventListener('focus', tellPresence);
if (tana.onPresence) tana.onPresence((docId, peers) => { if (docId === presenceDoc) { presencePeers = Array.isArray(peers) ? peers : []; paintPresence(); } });

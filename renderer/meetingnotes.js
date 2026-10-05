'use strict';
// A meeting's editor is your private notes (main/meeting-notes.js, docs/MEETINGS.md "Private notes", docs/OUTLINER.md).
// The page stays the meeting's — its title, Visible to and attendees, its sidebar, ⌘K, back and forward — and the
// outline under it is the whole outline of a document only you can see, which the meeting does not own (it is out of
// the meeting's graph) and which names the meeting in its first row, a link to the meeting's page in Tana. Every row
// there belongs to that document, so each edit is an edit of it, through the same paths as any page. A line over the
// rows says who sees them, so the meeting's own Visible to, which is about the meeting, is never read as theirs.
// Nothing is made by opening the page: an empty one has a draft row, and its first character asks main to make the
// notes, which writes those words into them once Tana has confirmed they are private. Until then, and when that fails,
// the words stay in the row; typing on, or the page by itself while Tana has not answered, tries again.
const meetingNotes = new Map(); // event id -> main's answer: { id, node, owner } | { id: null, shared } | { failed } | null while asked
const notesDrafts = new Map(); // event id -> the draft row of its empty notes: one object, so the words typed outlive a redraw
const notesWriteUps = new Map(); // event id -> its write-up's uri (main/related.js summaryUri), or null: the link over the notes
let notesAsked = 0; // a generation: an answer asked before a sign-out or a lost connection is not used after it
const notesSeq = new Map(); // event id -> the newest ask: an older answer landing after it is dropped
const notesWaitSaid = new Set(); // event ids whose "what you typed is kept" was said: once, not at every retry

// A meeting whose own outline is empty: every Tana event (its content is empty), never a page the mock gives content
function notesPage(parent) {
  if (!parent || LINKS || (zoom && zoom.nodeId) || parent.node.kind !== 'document' || !tana.meetingNotes) return false;
  if (parent.node.icon !== 'meeting' && !String(parent.docId).startsWith('tana:event:')) return false;
  const own = kids.get(parent.docId);
  return Array.isArray(own) && !own.length;
}
const myUri = () => (me() || {}).id;
function askNotes(eventId) {
  if (!connected) return;
  const asked = notesAsked, who = myUri(), seq = (notesSeq.get(eventId) || 0) + 1;
  notesSeq.set(eventId, seq);
  // asked again, the answer on screen stays until the new one lands: main refuses every write to notes that stopped
  // being private (main/documents.js writeGuards), so nothing is written to them meanwhile
  if (!meetingNotes.get(eventId)) meetingNotes.set(eventId, null);
  if (tana.summaryUri && !notesWriteUps.has(eventId)) tana.summaryUri(eventId).then((uri) => { if (asked === notesAsked) { notesWriteUps.set(eventId, uri || null); renderSoon(); } }, () => {});
  tana.meetingNotes(eventId).then((answer) => {
    if (asked !== notesAsked || notesSeq.get(eventId) !== seq) return; // signed out or disconnected meanwhile, or asked again since
    if (answer && answer.id && who && answer.owner !== who) return meetingNotes.delete(eventId); // another account's
    if (answer && answer.id) extra.set(answer.id, asDoc(answer.node));
    meetingNotes.set(eventId, answer || { id: null });
    renderSoon();
  }, () => { if (asked === notesAsked && notesSeq.get(eventId) === seq) { meetingNotes.set(eventId, { id: null, failed: true }); renderSoon(); } });
}
// Read again: main says the notes changed (made in another pane, or no longer private). Nothing is shown meanwhile, so
// notes that stopped being private are not offered for one more keystroke.
function noteNotesChanged(eventId) { if (meetingNotes.has(eventId)) askNotes(eventId); }
function forgetNotes(signedOutToo) { notesAsked++; meetingNotes.clear(); notesWriteUps.clear(); notesSeq.clear(); if (signedOutToo) notesDrafts.clear(); }

// The item whose rows the page shows: the notes', on a meeting page; the page's own anywhere else.
function notesBody(parent) {
  if (!notesPage(parent)) return parent;
  const eventId = parent.docId;
  if (!meetingNotes.has(eventId)) askNotes(eventId);
  const answer = meetingNotes.get(eventId);
  if (answer && answer.id) return mkItem(answer.id, docOf(answer.id) || asDoc(answer.node), null);
  // none (yet): a stand-in for them, holding the one draft row whose first character makes them
  const open = !!answer && !answer.failed && !demoMode;
  const stand = { id: 'notes:' + eventId, text: '', kind: 'document', hasChildren: false, notesFor: eventId, editable: open };
  if (!notesDrafts.has(eventId)) notesDrafts.set(eventId, { id: 'draft:notes:' + eventId, text: '', kind: 'block', block: 'paragraph', draft: true, notesDraft: true });
  kids.set(stand.id, open ? [notesDrafts.get(eventId)] : []);
  return mkItem(stand.id, stand, null);
}
// Still asking, or the notes' rows still loading: the page says nothing rather than "No content" meanwhile.
const notesWaiting = (parent) => { if (!notesPage(parent)) return false; const a = meetingNotes.get(parent.docId); return !a || (!!a.id && !Array.isArray(kids.get(a.id))); };

// The line over the rows: who sees them, in the words and glyph of Visible to (renderer/tasks.js AUDIENCES).
function notesHeadEl(parent) {
  if (!notesPage(parent)) return null;
  const answer = meetingNotes.get(parent.docId);
  if (!answer) return null;
  const el = document.createElement('div');
  el.className = 'notes-head';
  const words = answer.failed ? 'Your notes could not be checked just now'
    : answer.shared ? 'Your notes here were shared in Tana, so they are left as they are · new notes start private'
      : 'Your notes · only you can see them';
  el.append(iconEl('lock', 'Visible only to you'), Object.assign(document.createElement('span'), { textContent: words }));
  // the meeting's write-up, shared with whoever sees the meeting, opened from here rather than in the notes' place
  const writeUp = notesWriteUps.get(parent.docId);
  if (writeUp) {
    const link = Object.assign(document.createElement('a'), { className: 'notes-writeup', textContent: 'Write-up', title: 'The meeting\u2019s write-up, visible to who sees the meeting' });
    link.onclick = () => goTo(writeUp);
    el.append(link);
  }
  return el;
}

// The draft row's first character (render.js materialise): the notes made with it, and the row becomes their first row.
async function materialiseNotes(item, el) {
  const eventId = item.parent.node.notesFor, text = el.isConnected ? el.textContent : item.node.text, oldKey = item.key, asked = notesAsked;
  let answer;
  try {
    answer = await tana.meetingNotes(eventId, true, text);
    if (asked !== notesAsked || !answer || !answer.id || !answer.blockId || (myUri() && answer.owner !== myUri())) throw new Error('Your notes could not be made private just now; what you typed is kept');
  } catch (e) {
    item.busy = false;
    if (el.isConnected) item.node.text = el.textContent; // kept in the row (events.js keeps it as it is typed): typing on tries again
    // Tana has not answered yet (a meeting's first notes wait for its "no such document", docs/MEETINGS.md): said once,
    // and tried again by itself while the row still holds words, here or on a page opened since
    if (!/what you typed is kept/.test(e && e.message) || !notesWaitSaid.has(eventId)) showError(e);
    if (/what you typed is kept/.test(e && e.message) && asked === notesAsked) {
      notesWaitSaid.add(eventId);
      setTimeout(() => { if (asked === notesAsked && item.node.draft && !item.busy && item.node.text) { item.busy = true; materialise(item, el.isConnected ? el : textEl(item.key) || el); } }, 4000);
    }
    return;
  }
  notesWaitSaid.delete(eventId);
  meetingNotes.set(eventId, answer);
  extra.set(answer.id, asDoc(answer.node));
  notesDrafts.delete(eventId);
  await reload(answer.id);
  const real = locate(kids.get(answer.id) || [], answer.blockId)?.node || { id: answer.blockId, kind: 'block', block: 'paragraph', text, hasChildren: false };
  // typed on while the notes were made: in this row, or in the one drawn for it if the page was left and opened again;
  // its segments, so a mark or an @ mention made meanwhile is saved as any row's is (flush skips them when unchanged)
  const key = answer.id + '/' + answer.blockId, now = el.isConnected ? el : textEl(oldKey), latest = now ? readSegs(now) : [{ text: item.node.text || text }];
  el = now || el;
  item.key = key; item.docId = answer.id; item.node = real; item.parent = mkItem(answer.id, docOf(answer.id), null); delete item.busy;
  items.delete(oldKey); items.set(key, item);
  const host = el.closest('.node');
  if (host) { host.dataset.key = key; host.classList.remove('draft'); }
  renderDeferred = true; // the rest of the page is redrawn once the caret leaves
  scheduleSave(item, latest);
}

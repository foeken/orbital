'use strict';
// A meeting's editor is your notes (main/meeting-notes.js, docs/MEETINGS.md "Private notes", docs/OUTLINER.md). The page
// stays the meeting's — its title, Visible to and attendees, its sidebar, ⌘K, back and forward — and the outline under
// it is the whole outline of a document of yours, made visible to you alone, owned by the meeting (inside it in Tana,
// for you) and naming the meeting in its first row, a link to the meeting's page in Tana. Every row
// there belongs to that document, so each edit is an edit of it, through the same paths as any page. A line over the
// rows says who sees them — only you, or, once you shared them in Tana, "Shared notes" and with whom — so the meeting's
// own Visible to, which is about the meeting, is never read as theirs.
// Nothing is made by opening the page: an empty one has a draft row, and its first character asks main to make the
// notes, which writes those words into them once Tana has confirmed they are private. Until then, and when that fails,
// the words stay in the row; typing on, or the page by itself while Tana has not answered, tries again.
const meetingNotes = new Map(); // event id -> main's answer: { id, node, owner, audience, checking? } | { id: null } | { failed } | null while asked
const notesDrafts = new Map(); // event id -> the draft row of its empty notes: one object, so the words typed outlive a redraw
const notesWriteUps = new Map(); // event id -> its write-up's uri (main/related.js summaryUri), or null: the Summary beside the notes
let notesAsked = 0; // a generation: an answer asked before a sign-out or a lost connection is not used after it
const notesSeq = new Map(); // event id -> the newest ask: an older answer landing after it is dropped
const notesWaitSaid = new Set(); // event ids whose "what you typed is kept" was said: once, not at every retry
const notesHeld = new Map(); // row key -> { item, segs }: a save main refused while who sees the notes changed, saved once the line says so
// Notes / Summary: a meeting with a write-up (summaryUri) and notes of yours shows a switch over its rows; Summary shows
// the write-up's own rows in the notes' place, with its own audience and permissions read from it, never from the
// meeting or the notes. Summary is the default: once Tana has written a meeting up, that is what its page shows, and
// with no notes of yours it is all the page shows.
const notesOn = new Set(); // event ids showing your notes over their write-up, chosen with Notes, kept per meeting for the session
const summaryMeta = new Map(); // write-up id -> its own taskMeta (who sees it), null while asked
const summarySeq = new Map(); // write-up id -> the newest ask: an older answer, landing after a live change asked again, is dropped
const notesCaret = new Map(); // event id -> { key, offset }: where the caret was in the notes when Summary took their place

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
  const writeUp = (uri) => { if (asked === notesAsked) { notesWriteUps.set(eventId, uri || null); renderSoon(); } };
  if (tana.summaryUri && !notesWriteUps.has(eventId)) tana.summaryUri(eventId).then(writeUp, () => writeUp(null));
  tana.meetingNotes(eventId).then((answer) => {
    if (asked !== notesAsked || notesSeq.get(eventId) !== seq) return; // signed out or disconnected meanwhile, or asked again since
    if (answer && answer.id && who && answer.owner !== who) return meetingNotes.delete(eventId); // another account's
    const was = meetingNotes.get(eventId);
    if (answer && answer.id) extra.set(answer.id, asDoc(answer.node));
    meetingNotes.set(eventId, answer || { id: null });
    // the same notes, only who sees them changed: the line is redrawn where it is, so the words and the caret stay
    if (was && answer && was.id && was.id === answer.id && was.node.editable === answer.node.editable) patchNotesHead(eventId);
    else renderSoon();
    if (answer && answer.id) for (const [key, held] of notesHeld) {
      if (held.item.docId !== answer.id) continue;
      notesHeld.delete(key);
      // saved only while the row still shows those words: one typed on since was saved (or held) on its own
      const el = textEl(key);
      if (!pending.has(key) && answer.node.editable !== false && (!el || JSON.stringify(readSegs(el)) === JSON.stringify(held.segs))) scheduleSave(held.item, held.segs);
    }
  }, () => { if (asked === notesAsked && notesSeq.get(eventId) === seq) { meetingNotes.set(eventId, { id: null, failed: true }); renderSoon(); } });
}
// Read again: main says the notes changed (made in another pane, or who sees them changed). Until the answer lands the
// line says it is checking, so "only you" is never left over notes just shared; main refuses their writes meanwhile.
function noteNotesChanged(eventId) {
  if (!meetingNotes.has(eventId)) return;
  const was = meetingNotes.get(eventId);
  if (was && was.id) { meetingNotes.set(eventId, { ...was, checking: true }); patchNotesHead(eventId); }
  askNotes(eventId);
}
function forgetNotes(signedOutToo) { notesAsked++; meetingNotes.clear(); notesWriteUps.clear(); notesSeq.clear(); notesHeld.clear(); summaryMeta.clear(); if (signedOutToo) { notesDrafts.clear(); notesOn.clear(); } }
// Arriving at a meeting whose notes could not be checked asks again (renderer/edit.js noteNavigation, on every arrival).
// Never from the failure itself: a lookup that keeps failing would then ask, fail and draw in a loop.
function notesArrived(eventId) {
  if (!(meetingNotes.get(eventId) || {}).failed) return;
  meetingNotes.delete(eventId);
  renderSoon();
}
// The write-up as its own document: its node (title, whether you may edit it) and who sees it, asked of main for it alone.
// An answer from before a sign-out, or for a write-up the meeting no longer has, is dropped.
function askSummary(eventId, uri) {
  const asked = notesAsked, seq = (summarySeq.get(uri) || 0) + 1, current = () => asked === notesAsked && summarySeq.get(uri) === seq && notesWriteUps.get(eventId) === uri;
  summarySeq.set(uri, seq); summaryMeta.set(uri, null);
  Promise.all([tana.node(uri), tana.taskMeta ? tana.taskMeta(uri) : null]).then(([n, meta]) => {
    if (!current()) return;
    const was = docOf(uri), rows = !was || was.editable !== n.editable; // the rows change only with whether you may edit them
    extra.set(uri, { ...n, text: n.title || '', hasChildren: true });
    summaryMeta.set(uri, meta || { audience: 'unknown' });
    if (rows) renderSoon(); else patchNotesHead(eventId); // the line at once, the words and caret under it left alone
  }, () => { if (current()) { summaryMeta.set(uri, { audience: 'unknown' }); patchNotesHead(eventId); } });
}
// A write-up's metadata changed (renderer/app.js onChanged; info.meta false is its words only): on a meeting showing it,
// the line says it is checking at once, while a row is being typed in too, and asks again; anywhere else it is asked
// when next shown. An answer from before the change is dropped (summarySeq).
function noteSummaryChanged(docId, info) {
  if (!summaryMeta.has(docId) || (info && info.meta === false)) return;
  summarySeq.set(docId, (summarySeq.get(docId) || 0) + 1);
  const shown = [...notesWriteUps].filter(([eventId, uri]) => uri === docId && !notesOn.has(eventId)).map(([eventId]) => eventId);
  if (!shown.length) { summaryMeta.delete(docId); return; }
  for (const eventId of shown) { askSummary(eventId, docId); patchNotesHead(eventId); }
}
// The meeting's write-up, when it is the one on screen
const summaryShown = (eventId) => (!notesOn.has(eventId) && notesWriteUps.get(eventId)) || null;
// What a meeting's page shows, for ⌘C and the tab's Copy link: its write-up, or your notes once they exist; else null
const meetingShown = (eventId) => summaryShown(eventId) || (meetingNotes.get(eventId) || {}).id || null;
// A write-up the sidebar's read found (main/related.js related summaryUri) that the page did not know: Tana writes it
// after the meeting, so it is shown once it is there, without a restart, unless you are typing in your notes right then.
function noteWriteUp(eventId, uri) {
  if (!notesWriteUps.has(eventId) || notesWriteUps.get(eventId) === uri) return;
  if (zoom && zoom.docId === eventId && editingRow()) notesOn.add(eventId);
  notesWriteUps.set(eventId, uri); patchNotesHead(eventId); renderSoon(); // the switch at once, a row being typed in or not
}
// Whether the meeting has a write-up is known: until then neither the notes nor their line are drawn, as it may be the summary
const writeUpKnown = (eventId) => !tana.summaryUri || notesWriteUps.has(eventId);
function showSummary(eventId, on) {
  const el = document.activeElement, key = el && el.closest && el.closest('#outline .node') && keyOfEl(el);
  if (on && key) notesCaret.set(eventId, { key, offset: caretOffset(el) }); // the tabs take no focus on a click: the caret is still in the row
  flushAll(); // what was typed is saved to the document it was typed in, before the other one takes its place
  if (on) notesOn.delete(eventId); else notesOn.add(eventId);
  render(true);
  const back = !on && notesCaret.get(eventId);
  if (back && textEl(back.key)) placeCaret(back.key, back.offset); // back in the notes where you were
  else outline.querySelector(':scope > .notes-head .notes-switch [aria-selected="true"]')?.focus();
}
// A save main refused because who sees the notes changed under it (main/meeting-notes.js AUDIENCE_CHANGED): kept, and
// saved once the line over them says who sees them now (askNotes). edit.js flush asks; true when it is one of those.
function holdNotesSave(item, segs, e) {
  if (!/Who can see these notes just changed/.test(String(e && e.message))) return false;
  notesHeld.set(item.key, { item, segs });
  return true;
}

// The item whose rows the page shows: the notes', on a meeting page; the page's own anywhere else.
function notesBody(parent) {
  if (!notesPage(parent)) return parent;
  const eventId = parent.docId;
  if (!meetingNotes.has(eventId)) askNotes(eventId);
  const wu = summaryShown(eventId);
  if (wu) { // its write-up instead: never the notes, and nothing made for them
    if (!summaryMeta.has(wu)) askSummary(eventId, wu);
    return mkItem(wu, docOf(wu) || { id: wu, text: '', kind: 'document', hasChildren: true, editable: false }, null);
  }
  const answer = meetingNotes.get(eventId);
  const known = writeUpKnown(eventId);
  if (known && answer && answer.id) return mkItem(answer.id, docOf(answer.id) || asDoc(answer.node), null);
  // none (yet): a stand-in for them, holding the one draft row whose first character makes them
  const open = known && !!answer && !answer.failed && !demoMode;
  const stand = { id: 'notes:' + eventId, text: '', kind: 'document', hasChildren: false, notesFor: eventId, editable: open };
  if (!notesDrafts.has(eventId)) notesDrafts.set(eventId, { id: 'draft:notes:' + eventId, text: '', kind: 'block', block: 'paragraph', draft: true, notesDraft: true });
  kids.set(stand.id, open ? [notesDrafts.get(eventId)] : []);
  return mkItem(stand.id, stand, null);
}
// The notes' rows as the meeting's page shows them: without the row their seed wrote to name the meeting (main/meeting-notes.js
// referenceOf), as long as it is still exactly that row — its id, its words, its one link, nothing under it. You are on
// the meeting already; the row is for whoever opens the notes on their own, and there it shows. Changed, it is yours.
function notesRows(parent, list) {
  const ref = (meetingNotes.get(parent.docId) || {}).reference;
  if (!ref || summaryShown(parent.docId)) return list;
  const exact = JSON.stringify([{ text: ref.text, marks: { link: ref.link } }]);
  return list.filter((n) => !(n.id === ref.id && !n.hasChildren && n.text === ref.text && JSON.stringify(segsOf(n)) === exact));
}
// Still asking, or the notes' rows still loading: the page says nothing rather than "No content" meanwhile.
const notesWaiting = (parent) => {
  if (!notesPage(parent)) return false;
  const wu = summaryShown(parent.docId);
  if (wu) return !Array.isArray(kids.get(wu));
  const a = meetingNotes.get(parent.docId); return !writeUpKnown(parent.docId) || !a || (!!a.id && !Array.isArray(kids.get(a.id)));
};

// The line over the rows: who sees them, in the words and glyphs of Visible to (renderer/tasks.js AUDIENCES, facesEls).
// Private: the lock and "only you". Shared in Tana: "Shared notes" and who — the people's faces, everyone, a space —
// and "anyone with the link" when a public link is on, with no lock and no "only you" at all.
function notesHeadEl(parent) { return notesPage(parent) ? notesHeadFor(parent.docId) : null; }
function notesHeadFor(eventId) {
  const answer = meetingNotes.get(eventId), writeUp = notesWriteUps.get(eventId), wu = summaryShown(eventId);
  // nothing until both are known: the switch depends on whether there are notes, so it never shows and then goes
  if (!answer || !writeUpKnown(eventId)) return null;
  const el = document.createElement('div'), a = answer && answer.audience, span = (text) => Object.assign(document.createElement('span'), { textContent: text });
  el.className = 'notes-head';
  // the switch only when there are notes to switch to, or you are in them already (their first words still being made)
  if (writeUp && (answer.id || notesOn.has(eventId))) el.append(notesSwitchEl(eventId, !!wu));
  if (wu) el.append(...summaryAudienceEls(wu, span));
  else if (answer.failed) el.append(iconEl('lock', 'Visible only to you'), span('Your notes could not be checked just now'));
  else if (answer.checking) el.append(iconEl('pending', null), span('Checking who can see your notes…'));
  else if (!answer.id || !a || a.private) el.append(iconEl('lock', 'Visible only to you'), span(writeUp ? 'only you can see them' : 'Your notes · only you can see them'), ...(answer.node && answer.node.editable === false ? [span('· read only')] : []));
  else {
    el.classList.add('shared');
    const scope = AUDIENCES[a.scope] && a.scope !== 'only-me' ? AUDIENCES[a.scope] : null;
    // one phrase: "Shared notes · visible to" [faces] " · anyone with the link · read only"
    let words = 'Shared notes', rest = '', faces = [];
    if (a.scope === 'people' && a.peopleCount) { words += ' · visible to'; faces = facesEls(a.people, a.peopleCount); }
    else if (a.scope === 'everyone') words += ' · visible to everyone in your organization';
    else if (a.scope === 'space') words += ' · visible to space members';
    else if (a.scope !== 'only-me') words += ' · who can see them could not be checked';
    if (a.link) rest += ' · anyone with the link';
    else if (a.scope === 'only-me') words += ' · Tana is confirming they are only yours again';
    if (answer.node && answer.node.editable === false) rest += ' · read only';
    el.append(iconEl(a.link ? 'globe' : scope ? scope.icon : 'users', a.link ? 'Anyone with the link' : scope ? scope.label : 'Shared'), span(words), ...faces, ...(rest ? [span(rest.trim())] : []));
  }
  return el;
}
// Notes | Summary, over the rows of a meeting that has a write-up and your notes: two tabs, the one shown pressed
function notesSwitchEl(eventId, summary) {
  const el = document.createElement('div');
  el.className = 'notes-switch'; el.setAttribute('role', 'tablist'); el.setAttribute('aria-label', 'Your notes or the meeting’s summary');
  for (const [label, on] of [['Notes', !summary], ['Summary', summary]]) {
    // quiet: a click leaves the caret where it is, so Notes can put it back
    const b = quietButton(on ? 'on' : '', null, () => { if (!on) showSummary(eventId, label === 'Summary'); });
    b.textContent = label;
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(on));
    el.append(b);
  }
  return el;
}
// Who sees the write-up, from its own metadata (main's taskMeta for it), and whether you may edit it, from its own node
function summaryAudienceEls(uri, span) {
  const meta = summaryMeta.get(uri), doc = docOf(uri);
  if (!meta) return [iconEl('pending', null), span('Checking who can see it…')];
  const scope = typeof meta.audience === 'string' ? meta.audience : meta.audience && meta.audience.scope, info = audienceInfo(meta.audience, meta.audienceSpace);
  const people = meta.people || [], count = meta.peopleCount || people.length, link = !!meta.linkShared;
  // a public link is anyone's: never the lock or "only you" then, whoever else is granted
  if (link && scope === 'only-me') return [iconEl('globe', 'Anyone with the link'), span('anyone with the link')].concat(doc && doc.editable === false ? [span('· read only')] : []);
  const els = scope === 'only-me' ? [iconEl('lock', 'Visible only to you'), span('only you can see it')]
    : scope === 'people' && count ? [iconEl('userLock', 'Visible to selected people'), span('visible to'), ...facesEls(people, count)]
      : scope === 'everyone' ? [iconEl('users', 'Visible to everyone'), span('visible to everyone in your organization')]
        : scope === 'space' && info ? [iconEl('houseLock', info.label), span(info.label.replace(/^Visible/, 'visible'))]
          : [iconEl('users', null), span('who can see it could not be checked')];
  if (link) els[0] = iconEl('globe', 'Anyone with the link');
  const rest = (link ? ' · anyone with the link' : '') + (doc && doc.editable === false ? ' · read only' : '');
  return rest ? [...els, span(rest.trim())] : els;
}
// The line redrawn in place, the rows under it left alone: who sees the notes changed while you type
function patchNotesHead(eventId) {
  const old = zoom && zoom.docId === eventId && outline.querySelector(':scope > .notes-head');
  if (!old) return;
  const el = notesHeadFor(eventId);
  if (el) old.replaceWith(el); else old.remove();
}

// The meeting's own page in Tana, from its title (option A, chosen 2026-10-05): the Tana glyph alone, "Open in Tana" grown
// out of it on hover and keyboard focus (styles.css .meeting-tana), as the page's ⌘K row Open in Tana does it. On every
// meeting page, notes or none: always the meeting's link, never the notes', and it makes nothing. Called with the title
// (renderer/render.js), and left as it is while the same meeting stays the page, so a redraw keeps its focus and hover.
function meetingTanaButton(parent) {
  const head = titleEl.parentElement;
  if (!head) return;
  const old = head.querySelector(':scope > .meeting-tana-slot'), id = parent && parent.docId;
  const show = !!id && !LINKS && !(zoom && zoom.nodeId) && !parent.node.draft && (String(id).startsWith('tana:event:') || parent.node.icon === 'meeting') && !!tana.nodeLink && !!tana.openExternal;
  if (!show) { if (old) old.remove(); return; }
  if (old && old.dataset.doc === id) return;
  const slot = document.createElement('span'), b = quietButton('meeting-tana', 'Open in Tana', () => openInTana(id)), label = document.createElement('span'); // quiet: a click leaves the caret where it was
  slot.className = 'meeting-tana-slot'; slot.dataset.doc = id; // holds the glyph's width: the words grow over the title's end, which never moves
  label.className = 'meeting-tana-label'; label.textContent = 'Open in Tana'; label.setAttribute('aria-hidden', 'true');
  b.append(iconEl('tana', null), label);
  slot.append(b);
  if (old) old.replaceWith(slot); else head.append(slot);
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

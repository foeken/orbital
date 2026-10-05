'use strict';
// Private notes on a meeting (docs/MEETINGS.md, "Private notes"): what you type under a meeting goes to a document of
// your own, visible to you alone. Tana has no notion of personal notes (its web client, read 2026-10-05, has no key,
// kind or rule for them), so a note is an ordinary text document, restricted, with one grant: you, as admin.
// It is deliberately not owned by the meeting. Ownership (ownerUri) is how Tana links a meeting to its documents, and
// it is what Tana's server-side work on a meeting starts from: the wrap-up that writes the meeting's summary runs on
// Tana's servers from the event alone (its client sends only { eventUri }), and what that job reads, and with whose
// access, is not visible from here. So the note stays out of the meeting's graph — no owner, no edge (verified live) —
// and is linked to it by its id, derived from you and the meeting, and by Orbital's own mark inside it (root
// ext:orbital:notes, key meeting). Tana's web client (every file of its build, read 2026-10-05) never reads that root;
// what Tana's servers do with a private document of yours is not visible from here, as for any other.
//
// Nothing is written until you type. Then the note is created and Tana is asked back, through the graph and the owner
// chain, whether it holds what was sent; only once it answers is a single character written into it. A note found
// later is used only when that same read proves it is yours, private and this meeting's now; one shared since, or
// anyone else's, is left exactly as it is. Every answer that is not proof (no row yet, a failed read) refuses.
const { createHash } = require('node:crypto');
const { LoroDoc, LoroList, LoroMap } = require('loro-crdt');
const { readNode } = require('../sdk/node');
const { deterministicId } = require('../sdk/chat');
const { NOT_CONNECTED, S, sendChanged } = require('./state');
const { readOutline, insertAfter, inlineGroups, styleDoc, writeInline } = require('../sdk/content');
const { info, mut, op, writeGuards } = require('./documents');

const EVENT = /^tana:event:[0-9a-z]{26}$/, USER = /^tana:user-profile:[0-9a-z]{26}$/, TEXT = /^tana:text:[0-9a-z]{26}$/;
// The link to the meeting, in a root container of Orbital's own, as the settings document carries its mark
// (main/settings.js ext:orbital:doc, docs/SETTINGS.md): never one of Tana's keys, and never in the graph.
const MARK = 'ext:orbital:notes';
const markOf = (doc) => doc.loro.getMap(MARK).get('meeting');
const CONFIRM_MS = 20000, POLL_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw Object.assign(new Error('Tana has not answered yet'), { lag: true }); })]);
const notesTitle = (meeting) => 'Private notes' + ((meeting || '').trim() ? ' · ' + meeting.trim() : ''); // found in Tana's search by its meeting

// The one grant a private note carries: you, as admin. Any other key — a person, a group, an owner's uri — is not.
function onlyMe(participants, me) {
  const keys = Object.keys(participants || {}), p = keys.length === 1 && keys[0] === me ? participants[me] : null;
  return USER.test(me) && !!p && p.type === 'user' && p.role === 'admin';
}
// The graph's row: Tana's own record of the note, who made it and who it is for. undefined when it has no row yet.
// No owner: a note owned by anything (the meeting included) is in that owner's graph, so it is not one of these.
function graphPrivate(n, me) {
  if (!n) return undefined;
  return TEXT.test(n.id || '') && !n.ownerUri && n.restricted === true && onlyMe(n.participants, me) && n.createdBy === me
    && !(n.state && n.state.type) && !(n.linkSharing && n.linkSharing.mode) && !n.archivedAt;
}
// The owner chain: the note itself is the boundary, restricted and readable. undefined when Tana has no chain for it yet.
function chainPrivate(chain, id) {
  const [self] = (chain && chain.entries) || [];
  if (!self) return undefined;
  return self.uri === id && self.restricted === true && self.accessible !== false;
}
// The document as it is now, live updates included: still this meeting's, still private, no owner, no public link.
function docPrivate(doc, eventId, me) {
  const n = readNode(doc), mode = doc.loro.getMap('linkSharing').get('mode');
  return n.type === 'text' && !n.ownerUri && markOf(doc) === eventId && n.restricted === true && onlyMe(n.participants, me)
    && !(n.deletedAt > 0) && !(n.archivedAt > 0) && !n.stateType && mode === undefined && !n.writeDenied;
}
// 'ok' | 'lag' (no answer yet: no graph row or chain, a failed read, a document still loading or empty) | 'refused'
// (Tana answered, and the note is not private, yours or this meeting's). Only 'refused' ever lets a note go.
async function verify(client, eventId, me, id) {
  const local = client.sync.getDocument(id);
  if (local && local.writeDenied) return 'refused'; // Tana refused what was sent
  let row, chain;
  try {
    [{ nodes: [row] = [] }, chain] = await Promise.all([client.graph.listNodes({ nodeIds: [id], limit: 1 }), client.graph.getOwnerChain(id)]);
  } catch { return 'lag'; }
  const graph = graphPrivate(row, me), boundary = chainPrivate(chain, id);
  if (graph === false || boundary === false) return 'refused';
  if (graph === undefined || boundary === undefined) return 'lag';
  let doc;
  try { doc = await within(client.sync.subscribe(id), CONFIRM_MS); } catch { return 'lag'; }
  // what this machine holds of it may be part of it: a document still loading, or one seeded by nothing yet, proves nothing
  if ((client.sync.stateOf && client.sync.stateOf(id) !== 'live') || readNode(doc).type === undefined) return 'lag';
  return docPrivate(doc, eventId, me) ? 'ok' : 'refused';
}
// A meeting's notes for one person live at ids derived from the two (Tana's own createDeterministicId, sdk/chat.js), in
// a few slots: the first unless an earlier one is gone or not usable. So every machine, every restart and every pane
// finds the same note without a search, and a rename or a lost cache changes nothing.
//
// Every machine also starts the note from the same seed, byte for byte: written by a peer derived from you and the place,
// with fixed block ids and constant values, no clock and nothing random, and only once Tana answers that it has no such
// document (sdk/sync.js subscribe ifMissing), so a document that was there never gets it. Loro knows an operation by its
// peer and counter, so two machines both told "no such document" write one seed between them: both machines' first words
// land, each as a row of its own after the seed's. What differs per machine — the note's title naming the meeting,
// createdAt — is written after Tana has confirmed the note, as plain values where the last write wins and no words can
// be lost.
const SLOTS = 4, SEED_WAIT_MS = 2500;
const slotName = (me, eventId, k) => 'orbital:meeting-notes:' + me + ':' + eventId + ':' + k;
const slotId = (me, eventId, k) => 'tana:text:' + deterministicId(slotName(me, eventId, k));
const REFERENCE = 'Open the meeting in Tana';
// Its inputs are you (your profile and your login's id), the meeting, the place and your organization's document,
// checked here, and nothing else: no clock, no title, nothing optional, so the same inputs always give the same bytes.
// Its peer is yours as Tana reads peers (sdk/sync.js derivePeerId: your login's hash above, 16 bits below), so the
// note is attributed to you; the 16 bits come from the place and lie in 32768-65535, which derivePeerId's random part
// (0-32767) never uses, so the seed's peer is never one of your machines'.
const ORG = /^tana:org:[0-9a-z]{26}$/;
const LOGIN = /^[0-9A-Za-z_]{10,64}$/;
function seedBytes(me, eventId, k, orgDocUri, login) {
  if (!USER.test(me) || !EVENT.test(eventId) || !(k >= 0 && k < SLOTS) || !ORG.test(orgDocUri || '') || !LOGIN.test(login || '')) throw new Error('Private notes need you, the meeting and your organization');
  const name = slotName(me, eventId, k), h = createHash('sha256').update(name).digest();
  const link = 'https://home.tana.inc/o/' + orgDocUri.split(':')[2] + '/e/' + encodeURIComponent(eventId); // documents.webLink's, for an event
  const loro = new LoroDoc();
  const user = createHash('sha256').update(login.trim().toLowerCase()).digest().readBigUInt64BE(0) >> 16n;
  loro.setPeerId(((user << 16n) | 32768n | BigInt(h.readUInt16BE(0) & 32767)).toString(10)); // used for this seed alone
  const data = loro.getMap('data');
  data.set('type', 'text');
  data.set('title', 'Private notes');
  data.set('restricted', true);
  const grant = data.setContainer('participants', new LoroMap()).setContainer(me, new LoroMap());
  grant.set('type', 'user'); grant.set('role', 'admin');
  data.setContainer('sharedPinDates', new LoroList());
  data.setContainer('attributes', new LoroMap());
  data.setContainer('assignedToUris', new LoroList());
  loro.getMap(MARK).set('meeting', eventId);
  const content = loro.getMap('content');
  content.set('nodeName', 'doc');
  content.setContainer('attributes', new LoroMap());
  // its first row names the meeting, linked to its page in Tana: a reference anyone opening the note in Tana can see and
  // follow. A link, not an @ mention: Tana derives a LINKS_TO edge into the meeting from a mention (and CREATED_IN from
  // createdInUri), and none from a link (platform-cli notesref, live 2026-10-05).
  const children = content.setContainer('children', new LoroList());
  const row = children.pushContainer(new LoroMap());
  row.set('nodeName', 'paragraph');
  row.setContainer('attributes', new LoroMap()).set('blockId', deterministicId(name + ':reference').slice(-8));
  styleDoc({ loro });
  writeInline(row.setContainer('children', new LoroList()), inlineGroups([{ text: REFERENCE, marks: { link } }]).groups, true);
  loro.commit();
  return loro.export({ mode: 'update' });
}
const seed = (me, eventId, k, orgDocUri, login) => { const bytes = seedBytes(me, eventId, k, orgDocUri, login); return (loro) => loro.import(bytes); };
// Ask Tana until it confirms the note, or the time is up ('lag'), or it answers otherwise ('refused').
async function confirm(client, eventId, me, id, { timeout = CONFIRM_MS, poll = POLL_MS, wait = sleep } = {}) {
  for (let left = Math.max(1, Math.ceil(timeout / poll)); ; ) {
    const answer = await verify(client, eventId, me, id);
    if (answer !== 'lag' || --left <= 0) return answer;
    await wait(poll);
  }
}

// One answer at a time per person and meeting, in this process: two panes typing the first word at once, or a
// reload asking while a create is under way, wait for the same note rather than writing its first words twice over.
const queues = new Map(), handed = new Map(); // handed: the note each meeting was last answered with, per person
const lag = (message) => Object.assign(new Error(message), { lag: true });

// The meeting's private notes' id, or null when there are none (yet). create: true makes them.
async function resolveNotes(client, eventId, me, { create = false, org, login, ...timing } = {}) {
  if (create && (!ORG.test(org || '') || !LOGIN.test(login || ''))) throw new Error('Private notes need your organization: sign in again'); // before anything is made
  const ids = Array.from({ length: SLOTS }, (_, k) => slotId(me, eventId, k));
  let rows;
  try { ({ nodes: rows = [] } = await client.graph.listNodes({ nodeIds: ids, limit: SLOTS })); }
  catch { if (!create) return null; throw lag('Tana could not confirm your private notes just now; what you typed is kept'); }
  const row = new Map(rows.map((n) => [n.id, n]));
  // first every place Tana lists: notes of yours there are used, whatever place is free before them
  for (const id of ids.filter((x) => row.has(x))) {
    const answer = await verify(client, eventId, me, id);
    if (answer === 'ok') return id;
    // yours and not checkable just now: no other note is made, since this may be the one
    if (answer === 'lag') { if (!create) return null; throw lag('Tana could not confirm your private notes just now; what you typed is kept'); }
    // otherwise Tana says it is not private, yours or this meeting's: left exactly as it is
  }
  if (!create) return null; // an open reads the graph only, and asks for no document
  let free = null; // then the first place Tana lists nothing at: where new notes go
  for (const id of ids.filter((x) => !row.has(x))) {
    // the seed, written only once Tana answers that it has no such document (sdk/sync.js ifMissing); a document it has is
    // read as it is and judged: anything but these notes (yours in the trash, someone else's, made otherwise) is left alone
    let doc = null;
    try { doc = await within(client.sync.subscribe(id, seed(me, eventId, ids.indexOf(id), org, login), { ifMissing: true }), SEED_WAIT_MS); }
    catch (e) { if (/permission|denied/i.test(String(e && e.message))) continue; } // someone else's: the next place; no answer yet: confirmed below
    if (doc && client.sync.stateOf?.(id) === 'live' && readNode(doc).type !== undefined && !docPrivate(doc, eventId, me)) continue;
    free = id;
    break;
  }
  if (!free) throw new Error('Orbital cannot make private notes for this meeting: every place for them is taken');
  const answer = await confirm(client, eventId, me, free, timing);
  if (answer === 'ok') return free;
  if (answer === 'refused') throw new Error('Tana did not keep these notes private, so nothing was written to them');
  throw lag('Tana has not confirmed your private notes yet; what you typed is kept');
}

// The notes this process has handed out as a meeting's private notes, per document: from then on every write to them
// is checked against their live state (main/documents.js writeGuards), so a participant, a public link or the
// restriction lifted in Tana stops the next keystroke, not the next open. Kept for the session: notes that stopped
// being private are left exactly as they are, written by nobody here.
const served = new Map(); // note id -> { eventId, me, refused }
const watched = new WeakSet(); // the sync clients whose live changes are read for it
function serve(client, eventId, me, id) {
  served.set(id, { eventId, me, refused: false });
  if (watched.has(client.sync)) return;
  watched.add(client.sync);
  client.sync.on('change', (changed) => {
    const s = served.get(changed), doc = s && !s.refused && client.sync.getDocument(changed);
    if (!doc || docPrivate(doc, s.eventId, s.me)) return;
    s.refused = true;
    s.deleted = readNode(doc).deletedAt > 0; // deleted in Tana is not shared: the page says nothing of it
    sendChanged(s.eventId, { notes: true }); // every page on the meeting asks again, and hears they are not private
  });
}
const NOT_PRIVATE = 'These notes are no longer only yours, so Orbital stopped writing to them here';
writeGuards.push((doc) => {
  const s = served.get(doc.id);
  if (!s) return null;
  if (s.refused || !S.me || S.me.userUri !== s.me || !docPrivate(doc, s.eventId, s.me)) { s.refused = true; s.deleted = s.deleted || readNode(doc).deletedAt > 0; return s.deleted ? 'These notes were deleted in Tana' : NOT_PRIVATE; }
  return null;
});

// The first words, written once the notes are confirmed: a row of their own after the last one, so two panes' or two
// machines' first words both land, one after the other.
const firstWords = (doc, text) => { const rows = readOutline(doc); return insertAfter(doc, rows.length ? rows.at(-1).id : null, text); };
// What may differ between machines, written once Tana has confirmed the note: plain values, the last write wins. The
// title only while it is still the seed's: a note you renamed keeps your name.
function settle(doc, meeting) {
  const data = doc.loro.getMap('data'), title = notesTitle(meeting);
  doc.transact(() => { if (data.get('title') === 'Private notes' && title !== 'Private notes') data.set('title', title); if (data.get('createdAt') === undefined) data.set('createdAt', Date.now()); });
}

async function privateNotes(eventId, { create = false, first } = {}) {
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  if (typeof eventId !== 'string' || !EVENT.test(eventId)) throw new Error('Not a meeting');
  const client = S.client, me = S.me.userUri, key = me + '|' + eventId;
  // An answer belongs to the session it was asked in: signed out, or another account, while Tana was asked, and it is dropped.
  const same = () => S.client === client && !!S.me && S.me.userUri === me;
  const run = (queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    if (!same()) throw new Error(NOT_CONNECTED);
    // the meeting itself, before anything is made for it: one that cannot be read, is not a meeting or is deleted gets none
    const ev = create ? await within(client.sync.subscribe(eventId), CONFIRM_MS).catch((e) => { throw e && e.lag ? lag('Tana has not answered about this meeting yet; what you typed is kept') : new Error('This meeting cannot hold notes'); }) : null;
    if (create && (!ev || readNode(ev).type !== 'event' || readNode(ev).deletedAt > 0)) throw new Error('This meeting cannot hold notes');
    if (!same()) throw new Error('The account changed while Tana was asked');
    const id = await resolveNotes(client, eventId, me, { create, org: S.me.orgDocUri, login: S.me.userExternalId });
    if (!same()) throw new Error('The account changed while Tana was asked');
    if (!id) return { id: null, shared: [...served.values()].some((s) => s.refused && !s.deleted && s.eventId === eventId && s.me === me) };
    serve(client, eventId, me, id);
    // made just now, or another than before: every other page on the meeting starts using it
    if (handed.get(key) !== id) { const changed = create || handed.has(key); handed.set(key, id); if (changed) sendChanged(eventId, { notes: true }); }
    // in the same turn as the create: two panes' first words both land, one after the other, and neither replaces the other
    const meeting = ev ? readNode(ev).title : '';
    const blockId = create && typeof first === 'string' && first ? await mut(id, (doc) => { settle(doc, meeting); return firstWords(doc, first); }) : undefined;
    const node = await op(id, info);
    if (!same()) throw new Error('The account changed while Tana was asked');
    return { id, node, owner: me, blockId };
  });
  queues.set(key, run);
  run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => {});
  return run;
}

const ipc = {
  // { id, node, owner, blockId? } | { id: null, shared }: the meeting's notes only you can see; create: true makes them
  // with the first words typed, which are written into them once Tana has confirmed they are private
  'meeting:privateNotes': (_e, id, create, first) => privateNotes(id, { create: create === true, first: typeof first === 'string' ? first : undefined }),
};

module.exports = { MARK, SLOTS, REFERENCE, markOf, slotId, onlyMe, graphPrivate, chainPrivate, docPrivate, verify, confirm, resolveNotes, privateNotes, seed, seedBytes, firstWords, settle, forget: () => handed.clear(), ipc };

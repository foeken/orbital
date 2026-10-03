'use strict';
const db = require('../db');
const access = require('../sdk/access');
const content = require('../sdk/content');
const chat = require('../sdk/chat');
const proposals = require('../sdk/proposals');
const { readNode, editable, setEntityType, contentText, ulid, initDocument, STATE_TYPES, setTitle, setState, taskMeta, audienceMetadata, setAssignees } = require('../sdk/node');
const fields = require('../sdk/fields');
const { DOC_URI, KINDS, LIVE_ROWS, NOT_CONNECTED, PLAIN_KINDS, S, TAG, deletedNodes, docStates, editability, errText, hueLoaded, idKind, isDeleted, metaSigs, nodeCreators, nodeHues, nodeMeta, now, pageOf, reading, redoStack, report, scheduleRefresh, send, sendChanged, subscribed, summaryCache, typeAttrTitles, typeHues, typeTitles, undoStack, visibleGraphNodes } = require('./state');
const { eventMeta, graphRow, hueOf, hueWithType, kindRow, memberRow, members, nodeTag, plainRow, rememberNodeHue, rememberType, resolveHue, resolveTypes, toNode, typeTag, typeUriOf } = require('./rows');
const settings = require('./settings');

// Resolve native embeds without replacing the containing block identity or loading target content recursively.
async function outlineWithReferences(doc) {
  // a block with no id (Tana's agent writes some) gets one first, so the row it becomes can be edited; only where
  // this user may write, since it is an op like any other
  if (editable(readNode(doc), S.me && S.me.userUri) !== false) content.assignBlockIds(doc);
  return resolveReferences(content.readOutline(doc));
}
// The reference rows of any outline (content embeds, chat attachments and proposals) resolved in one place.
// A block whose whole content is one mention is Tana's full-reference presentation: it is resolved like a native
// embed so the row can show the node it points at, while keeping its own identity and its editable text.
// The targets of the references read last, newest at the end: their own small list, apart from the on-demand reads, so
// neither sweep sees them. Past the limit the oldest is let go (unless something else holds it), silently: its copy
// keeps the title it was read with, as a view's rows past LIVE_ROWS do. In the on-demand list a let-go target made the
// page that cites it read itself again and subscribe it again, every refresh; and a shared budget there filled up
// and turned the next page's references away for good.
// ponytail: LIVE_ROWS / 2 targets across every outline on screen; the newest pages win. Hold per page if that matters.
const liveRefs = new Map();
// Documents to let go of once the last read waiting on them is done (document()): subscribed by a change read back, or
// found with nothing else holding them while a read still waited (so a let-go is never lost to a read in flight)
const passingReads = new Set();
let liveRefsClient = null; // the sync client they are live on: a new login starts a new stream, subscribed to none of them
// Let go of a target nothing holds any more: not a live reference, a view (subscribed), a read, a wait, or a watch
// start() subscribes outside those (watched by hand, handed to the agent): letting that go would end its notifications
function dropRef(uri) {
  if (liveRefs.has(uri) || subscribed.has(uri) || onDemand.has(uri) || notifyWatchedIds().has(uri) || agentIds().includes(uri)) return;
  if (reading.has(uri)) { passingReads.add(uri); return; } // tried again when that read is done
  passingReads.delete(uri);
  docStates.delete(uri);
  S.client?.sync?.unsubscribe?.(uri)?.catch(() => {}); // it may settle after a logout, or under the checks' partial clients
}
// Held while it bootstraps (main/state.js reading), as document() holds its read: a sweep must not unsubscribe it; let
// go once it settles if it was pushed out meanwhile; and a bootstrap that failed (deleted, access gone) is no live
// reference, so the next read tries again.
function subscribeRef(uri) {
  const client = S.client; // a login since then answers for its own client, and an old one's answer changes nothing
  reading.set(uri, (reading.get(uri) || 0) + 1);
  subscribe(uri).then((doc) => { if (!doc && S.client === client) liveRefs.delete(uri); }).finally(() => { const left = (reading.get(uri) || 1) - 1; if (left > 0) reading.set(uri, left); else { reading.delete(uri); if (S.client === client) dropRef(uri); } });
}
// A new login's client (main/views.js start): its stream has none of them, and an outline already on screen is not
// read again to ask, so they are all subscribed on it now.
function reliveRefs() {
  liveRefsClient = S.client;
  if (!S.client || !S.client.sync) return liveRefs.clear(); // no stream (logged out, or a check's partial client): nothing is live
  for (const uri of liveRefs.keys()) subscribeRef(uri);
}
function keepLive(uris) {
  if (liveRefsClient !== S.client) reliveRefs();
  for (const uri of uris.slice(0, LIVE_ROWS / 2)) {
    if (liveRefs.delete(uri)) { liveRefs.set(uri, true); continue; } // already live: now the newest
    liveRefs.set(uri, true);
    subscribeRef(uri);
  }
  for (const uri of [...liveRefs.keys()].slice(0, Math.max(0, liveRefs.size - LIVE_ROWS / 2))) { liveRefs.delete(uri); dropRef(uri); }
}
const isLiveRef = (uri) => liveRefs.has(uri); // a view's sweep leaves these alone (main/views.js viewRows)
async function resolveReferences(nodes) {
  const refs = [], mentions = [];
  const lone = n => !n.children?.length && n.segments?.length === 1 && n.segments[0].mention;
  const visit = rows => { for (const n of rows) {
    if (n.type === 'reference') refs.push(n.reference);
    else { const one = lone(n); if (one) refs.push(n.reference = { uri: one.uri, label: one.label }); }
    // every reference written inside a line, so it can show what it points at rather than reading as a bare link;
    // they ride along in the batch the rows above already need, and an unreadable one simply stays a link

    for (const s of n.segments || []) if (s.mention) mentions.push(s.mention);
    visit(n.children || []);
  } };
  visit(nodes);
  const uris = [...new Set([...refs, ...mentions].map(r => r.uri).filter(uri => typeof uri === 'string' && DOC_URI.test(uri)))];
  const targets = new Map();
  for (let i = 0; i < uris.length; i += 200) {
    try {
      const result = await S.client.graph.listNodes({nodeIds: uris.slice(i, i + 200), limit: 200});
      const visible = visibleGraphNodes(result.nodes);
      visible.forEach(rememberNodeHue);
      await resolveTypes(visible.map(n => n.entityType));
      for (const n of visible) targets.set(n.id, toNode(graphRow(n)));
    } catch { /* Keep unresolved reference identity; inaccessible targets must not break the surrounding outline. */ }
  }
  // A deleted target is not the same as an unreadable one, and the renderer draws them differently: a reference to
  // something that is gone reads as its old label, struck through behind a trash glyph, and does not open. Without
  // the mark both look like "Unavailable reference", so a deleted node stayed a live-looking link.
  // The tombstones are what the graph answers taught listFilter (main/views.js), which is also what dropped these
  // targets from the answer above, plus anything deleted from this app.
  const deleted = uri => deletedNodes.has(uri);
  for (const ref of refs) { if (targets.has(ref.uri)) ref.node = targets.get(ref.uri); else if (deleted(ref.uri)) ref.deleted = true; }
  // A reference row draws a copy of its target, which only a live target keeps current: subscribed, its rename reaches
  // the renderer as a change and patches the copy (renderer/app.js patchCopies, #413). Not a chat: one bootstraps to
  // megabytes of messages and tool output (docs/CHATS.md), too much to fetch for a title.
  keepLive([...new Set(refs.map((ref) => ref.uri))].filter((uri) => targets.has(uri) && idKind(uri) !== 'chat'));
  // the icon and the hue: a mention says what kind of thing it points at, and is drawn in its type's colour when
  // the target has one (the link's own blue otherwise)
  for (const m of mentions) {
    const target = targets.get(m.uri);
    if (target && target.icon) m.icon = target.icon; else if (deleted(m.uri)) m.deleted = true;
    if (target && target.hue != null) m.hue = target.hue;
    if (target && typeUriOf(target)) m.type = typeUriOf(target); // a link field says when it points at the wrong type
  }
  return nodes;
}

// A chat has no content outline at all: the conversation is data.messages on the chat document itself
// (docs/CHATS.md). Read only when the chat is opened — a chat document is megabytes of inline tool output.
async function chatOutline(doc) {
  const messages = doc.data.get('messages');
  const names = new Map((await members().catch(() => [])).map((m) => [m.id, m.title]));
  const rows = await resolveReferences(chat.chatRows(messages ? messages.toJSON() : [], { authorName: (uri) => names.get(uri), me: S.me && S.me.userUri, streamingId: doc.data.get('streamingMessageId') }));
  await proposalCards(doc.id, rows);
  return rows;
}
// A proposal in a chat is a card in the answer (renderer/chat.js chatProposalEl): what it is called and its glyph, read
// with includeProposals (a draft is in no other list, so it read "Unavailable reference"), else from the draft itself,
// as an action's is; and whether Orbital may approve it, the same refusal sdk/proposals.js makes when asked to.
async function proposalCards(chatUri, rows) {
  const cards = rows.flatMap((r) => (r.children || []).filter((c) => c.proposal));
  if (!cards.length) return;
  const uris = [...new Set(cards.map((c) => c.proposal.target))];
  const found = new Map(await S.client.graph.listNodes({ nodeIds: uris, includeProposals: true, limit: uris.length }).then((r) => visibleGraphNodes(r.nodes).map((n) => [n.id, toNode(graphRow(n))]), () => []));
  for (const uri of uris.filter((u) => !found.has(u))) {
    const title = await document(uri).then((d) => readNode(d).title, () => null);
    if (title != null) found.set(uri, { title, text: title });
  }
  for (const c of cards) {
    const p = c.proposal, n = found.get(p.target), why = !n ? 'Its document is gone: reject it to clear it' : proposals.refusal(p);
    Object.assign(p, { chatUri, title: n ? n.text || n.title || 'Untitled' : 'Missing document', icon: n && n.icon, approvable: p.state === 'pending' && !why, reason: why });
    // an action names the systems it will write to (its actionDerivation), which its approve says, as Tana's "Send to Slite"
    if (p.metadata.type === 'action' && p.state === 'pending') p.systems = await document(p.target).then((d) => actionSystems(readNode(d)), () => []);
  }
}
// The systems an action will act in, as Tana labels its button: expectedSystems less Tana itself, "microsoft-teams"
// read as "Microsoft Teams".
function actionSystems(n) {
  let d = {};
  try { d = JSON.parse(n.actionDerivation || '{}') || {}; } catch { /* no derivation: a plain Run */ }
  return (Array.isArray(d.expectedSystems) ? d.expectedSystems : []).filter((s) => typeof s === 'string' && s !== 'tana')
    .map((s) => s.split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));
}
// Send a message in a chat, and ask Tana's AI to answer it when the chat answers by itself (sdk/chat.js), as the chat's
// own agent (data.agentId, Tana's assistant when there is none). Not an undo step: a message, once sent, is the
// conversation. The answer arrives as live updates to the chat. A reply that could not be asked for does not undo the
// send: it comes back as replyError beside the saved message, so the renderer does not offer the words again.
// What a chat's data says about sending: only these keys, since its data map carries megabytes of tool output and
// prompt snapshot (docs/CHATS.md §1).
function chatFacts(doc) {
  const get = (k) => { const v = doc.data.get(k); return v && typeof v.toJSON === 'function' ? v.toJSON() : v; };
  return Object.fromEntries(['ownerUri', 'agentId', 'aiAutoResponds', 'participants', 'participantUris'].map((k) => [k, get(k)]));
}
const isChatId = (id) => typeof id === 'string' && DOC_URI.test(id) && idKind(id) === 'chat';
// What the composer needs of a chat (renderer/chat.js): whether Tana answers a message here by itself, where it starts,
// To Tana or To the chat; and whether you may write in it at all, the verified native check (sdk/access.js) and
// nothing guessed, so a chat you can only read gets no composer that would leave a message behind that never arrived.
const chatAnswers = (id) => { if (!isChatId(id)) throw new Error('Not a chat'); return op(id, async (doc) => ({ ai: chat.autoResponds(chatFacts(doc)), canWrite: !doc.writeDenied && await canWriteDoc(doc).catch(() => false) })); };
const CHAT_READ_ONLY = 'You can read this chat but not write in it';
// attachments: documents the message carries, as Tana's own runSkill attaches the skill it runs (docs/CHATS.md §10).
// opts.ai: the composer's mode. true asks Tana to answer; false is a message for the people in the chat, marked
// skipAutoResponse, which Tana still answers when it mentions Tana; absent, the chat's own rule decides.
async function sendChat(id, text, attachments = [], opts = {}) {
  if (!isChatId(id)) throw new Error('Not a chat');
  if (!Array.isArray(attachments) || !attachments.every((uri) => typeof uri === 'string' && DOC_URI.test(uri))) throw new Error('Attachments are Tana documents');
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  const me = S.me.userUri, user = S.me.user || {};
  const name = (await members().catch(() => [])).find((m) => m.id === me)?.title || [user.firstName || user.first_name, user.lastName || user.last_name].filter(Boolean).join(' ') || user.email;
  const sent = await op(id, async (doc) => {
    // refused before anything is written: a denied edit stays in the local document, a message that never reached Tana
    // (writeDenied: Tana has already refused this peer's edits to it, sdk/sync.js)
    if (doc.writeDenied || !(await canWriteDoc(doc).catch(() => false))) throw new Error(CHAT_READ_ONLY);
    let messageId;
    const data = chatFacts(doc), respond = typeof opts.ai === 'boolean' ? opts.ai || chat.mentionsTana(text) : chat.autoResponds(data, text);
    doc.transact((loro) => { messageId = chat.addMessage(loro, { text, byUri: me, senderName: name, attachments, skipAutoResponse: !respond }); });
    return { messageId, ownerUri: data.ownerUri, agentId: data.agentId, respond };
  });
  if (!sent.respond) return { messageId: sent.messageId, responding: false };
  return askReply(id, sent.messageId, sent);
}
// Ask the chat's agent to go on from a message just written (sendChat's trigger, and the one after answering questions)
async function askReply(id, messageId, facts) {
  try { await chat.triggerReply({ chatUri: id, messageId, ownerUri: facts.ownerUri, ...(facts.agentId ? { agentId: facts.agentId } : {}), getAccessToken: (o) => S.session.getAccessToken(o) }); }
  catch (e) { return { messageId, responding: false, replyError: errText(e) }; }
  return { messageId, responding: true };
}
// Answer Tana's questions on a message (answers: { questionId: { selected: [label], custom } }), or skip them with
// null, the way Tana's question panel does (sdk/chat.js answerQuestions), then ask Tana to go on (docs/CHATS.md §11).
async function answerChat(id, messageId, answers) {
  if (!isChatId(id)) throw new Error('Not a chat');
  if (typeof messageId !== 'string' || !messageId) throw new Error('Which questions?');
  if (answers !== null && (typeof answers !== 'object' || Array.isArray(answers))) throw new Error('Answers are per question');
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  const written = await op(id, async (doc) => {
    if (doc.writeDenied || !(await canWriteDoc(doc).catch(() => false))) throw new Error(CHAT_READ_ONLY);
    let relay;
    doc.transact((loro) => { relay = chat.answerQuestions(loro, { messageId, answers, byUri: S.me.userUri }); });
    return { relay, facts: chatFacts(doc) };
  });
  return askReply(id, written.relay, written.facts);
}
// Delete one of your own messages from a chat (sdk/chat.js deleteMessage), for everyone in it. Not an undo step, as
// sending is not: Tana's own Delete message has no undo either.
async function deleteChatMessage(id, messageId) {
  if (!isChatId(id)) throw new Error('Not a chat');
  if (typeof messageId !== 'string' || !messageId) throw new Error('Which message?');
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  await op(id, async (doc) => {
    if (doc.writeDenied || !(await canWriteDoc(doc).catch(() => false))) throw new Error(CHAT_READ_ONLY);
    doc.transact((loro) => chat.deleteMessage(loro, { messageId, byUri: S.me.userUri }));
  });
}
// Invite a workspace member to a chat, as Tana's chat header does: they join its participants as an editor, through
// the verified sharing rules (sdk/access.js setSharing, everyone already in it kept), and the chat says so. Only a chat
// with a participant list of its own: one that takes its audience from where it lives (a meeting's, a space's) would
// be narrowed to these people, so it is shared where it lives instead.
async function inviteToChat(id, userUri) {
  if (!isChatId(id)) throw new Error('Not a chat');
  if (typeof userUri !== 'string' || !/^tana:user-profile:[0-9a-z]{26}$/.test(userUri)) throw new Error('Invite a workspace member');
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  // a member of this workspace, known by name, or nobody: the call is refused before the chat's access is touched
  const member = (await members()).find((m) => m.id === userUri && !m.me);
  if (!member) throw new Error('Invite a member of this workspace');
  const name = member.title || member.text || 'A participant';
  await mut(id, async (doc) => {
    const ctx = await accessContext();
    // read after the last await, so this is the list setSharing's own version check starts from (it refuses when the
    // document moves under it): an invite only ever adds, whatever another client changed meanwhile
    const n = readNode(doc), people = n.participants || {};
    if (n.restricted !== true) throw new Error('This chat is shared through where it lives: share that instead');
    if (people[userUri]) throw new Error(name + ' is already in this chat');
    // a group grant (type 'group') is outside the verified sharing subset: kept through it, it would be dropped, and every
    // member of the group would lose the chat. So such a chat is left to Tana.
    if (Object.values(people).some((p) => !p || p.type !== 'user')) throw new Error('This chat is shared with a group: invite people to it in Tana');
    const kept = Object.entries(people).filter(([uri, p]) => uri !== S.me.userUri && p && p.type === 'user').map(([uri, p]) => ({ uri, role: p.role }));
    await access.setSharing(doc, S.me.userUri, { rule: 'people', participants: [...kept, { uri: userUri, role: 'editor' }] }, ctx);
    // Tana's two lines (its onParticipantAdded and the multiple-participants notice): the first time the chat is shared,
    // Tana stops answering every message, so the chat says how to ask it
    doc.transact((loro) => {
      chat.pushMessage(loro, { sentAt: Date.now(), fromUserUri: userUri, fromUserType: 'ai', isStatusUpdate: true }, name + ' was added to the chat.');
      if (Object.keys(people).length === 1) chat.pushMessage(loro, { sentAt: Date.now(), fromUserType: 'ai', isStatusUpdate: true }, 'This chat now has multiple participants. Mention @Tana to trigger AI.');
    });
  }, true);
  scheduleRefresh(2000);
  return { name };
}
// A new chat with Tana, from ⌘K: yours alone, and untitled the way Tana starts one (no title, titleAutoGenerated) so
// its AI names it after the first answer; until then the page calls it "New chat".
// ownerUri: the node a chat belongs to (an agent's task chat, issue #669), as a meeting's chat belongs to its event; it
// lists under that node rather than among your own chats, inherits its audience, and Tana's reply is given it as context
async function newChat(ownerUri) {
  const node = await createDocument('New chat', { kind: 'chat' });
  // owned, it also drops `restricted`, as Tana's own inherit does (sdk/access.js): who can see it follows the node
  await op(node.id, (doc) => doc.transact((loro) => { const data = loro.getMap('data'); data.delete('title'); data.set('titleAutoGenerated', true); if (ownerUri) { data.set('ownerUri', ownerUri); data.delete('restricted'); } }));
  return node;
}

// New document ('doc' | 'task' | 'meeting'): seeded locally, created on the server by the bootstrap (sdk/sync.js subscribe with init).
async function customCreation(typeUri) {
  if (typeof typeUri !== 'string' || !/^tana:type:[0-9a-z]{26}$/.test(typeUri)) throw new Error('Select a workspace type');
  const type = readNode(await document(typeUri));
  if (type.type !== 'type' || isDeleted(type)) throw new Error('Type is unavailable');
  const appliesTo = type.appliesTo ?? 'docs';
  if (!['docs','events'].includes(appliesTo)) throw new Error('Unsupported type target');
  if (type.ownerUri) {
    if (!/^tana:space:[0-9a-z]{26}$/.test(type.ownerUri)) throw new Error('Unsupported type scope');
    if (!await access.canWrite(readNode(await document(type.ownerUri)), S.me.userUri, await accessContext())) throw new Error('Type home space write permission is unknown or unavailable');
  }
  // A type with a workflow (data.workflowUri) is one whose documents are tasks: made from Create new … it has to be one,
  // open and yours, as Quick Add Task makes it. Answering 'doc' for it made a document with the type and no state,
  // a Project Task that was no task (#534).
  return {kind:appliesTo === 'events' ? 'meeting' : type.workflowUri ? 'task' : 'doc',entityTypeUri:typeUri,ownerUri:type.ownerUri};
}
async function creationOptions() {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const result = await S.client.graph.listNodes({nodeTypes:['type'],limit:1000,mode:'LIST_NODES_MODE_WITH_COUNT'});
  // A saved search is created empty and then narrowed with the pills, unlike the other kinds, which are created from
  // a title alone. writeSearchQuery materialises every key, so the empty query is still a readable one — a search
  // born without it would be refused by searchChildren for the rest of its life.
  const options = [{id:'doc',kind:'doc',title:'Doc',icon:'doc',selectable:true},{id:'task',kind:'task',title:'Task',icon:'task',selectable:true},{id:'meeting',kind:'meeting',title:'Meeting',icon:'meeting',selectable:true},{id:'chat',kind:'chat',title:'Chat',icon:'chat',selectable:true},{id:'search',kind:'search',title:'Search',icon:'search',selectable:true},{id:'canvas',kind:'canvas',title:'Canvas',icon:'canvas',selectable:true}];
  const types = await Promise.all(result.nodes.map(async n => {
    rememberType(n);
    // the chooser shows a type the way its documents render: the type's own hue and its app-local icon
    const look = { hue: hueOf(n) };
    try { const config=await customCreation(n.id); return {id:n.id,kind:'custom',typeUri:n.id,title:n.title || '',...look,icon:config.kind === 'meeting' ? 'meeting' : config.kind === 'task' ? 'task' : require('./icons').typeIconName(n.id) || 'type',ownerUri:config.ownerUri,appliesTo:config.kind === 'meeting' ? 'events' : 'docs',selectable:true}; }
    catch(e) { return {id:n.id,kind:'custom',typeUri:n.id,title:n.title || '',...look,icon:'doc',selectable:false,reason:errText(e)}; }
  }));
  return {options:[...options,...types.sort((a,b)=>a.title.localeCompare(b.title))],complete:result.totalCount !== undefined && result.totalCount === result.nodes.length};
}
// The types Quick Add Task offers (task.html, issue #237): workflow types only — a type with a board of states
// (data.workflowUri) is one whose documents are tasks — that apply to documents and that this user may create in,
// by the same rules as the creation chooser (customCreation). The graph's typeDef carries no workflowUri, so each
// type's own document is read, as the chooser reads it; one that cannot be used is left out rather than offered.
async function taskTypes() {
  if (!S.client) throw new Error(NOT_CONNECTED);
  // ponytail: one page of 200, as typeList; page by createTimeMin if a workspace outgrows it.
  const { nodes = [] } = await S.client.graph.listNodes({ nodeTypes: ['type'], limit: 200 });
  nodes.forEach(rememberType);
  const types = await Promise.all(nodes.map(async (t) => {
    try {
      if (!readNode(await document(t.id)).workflowUri) return null;
      const config = await customCreation(t.id); // a type for meetings, or one in a space this user cannot write, throws
      return config.kind === 'task' ? { uri: t.id, title: t.title || '', hue: hueOf(t) } : null;
    } catch { return null; }
  }));
  return types.filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
}

// ---- a document's type (Cmd+K "Set type") ----
// Two rules decide which types a document can be given, and both are Tana's own (their shared bundle, read 2026-09-20):
//   - a type applies to documents or to meetings (`appliesTo`, 'docs' unless it says otherwise), never to both;
//   - a type that lives in a space keeps its documents there — "Items typed with a space-scoped type cannot move
//     outside that type's home space", and their placement handler redirects a typed item into its type's home space
//     rather than letting it land elsewhere. So a space's type can only be set on a document already in that space,
//     exactly (not a sub-space: their scope check is `!type.ownerUri || type.ownerUri === space`), and a type with no
//     home space — a Library type — goes on anything. It is the same rule sdk/access.js enforces on a move, from the
//     other side: a typed document may not leave its type's home space.
// A type that is out of scope is listed and disabled with the space it belongs to, the way the creation chooser
// lists a type it cannot use: hiding it answers "why is my type not there?" with nothing.
const TYPED_KINDS = new Set(['text', 'event']); // only a document or a meeting carries a type; blocks and the rest do not
const TYPE_URI = /^tana:type:[0-9a-z]{26}$/;
const typeContext = (id) => (idKind(id) === 'event' ? 'events' : 'docs');
async function typeChoices(id) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  if (typeof id !== 'string' || !DOC_URI.test(id) || !TYPED_KINDS.has(idKind(id))) throw new Error('Only documents and meetings carry a type');
  const n = readNode(await document(id));
  const context = typeContext(id), home = n.ownerUri || null;
  // One query, like the creation chooser's: archived types are out of it by default, which is also what Tana refuses
  // to set. The type's own document is read only when one is chosen (setType), so opening the list costs one call.
  const { nodes } = await S.client.graph.listNodes({ nodeTypes: ['type'], limit: 200 });
  nodes.forEach(rememberType);
  const scoped = nodes.filter((t) => ((t.typeDef && t.typeDef.appliesTo) || 'docs') === context);
  await resolveTypes(scoped.map((t) => t.ownerUri)); // the home space titles, for the line that says why a type is out
  const options = scoped.map((t) => ({
    uri: t.id, title: t.title || '', hue: hueOf(t),
    selectable: !t.ownerUri || t.ownerUri === home,
    reason: !t.ownerUri || t.ownerUri === home ? undefined : 'Lives in ' + (typeTitles.get(t.ownerUri) || 'another space'),
  })).sort((a, b) => a.title.localeCompare(b.title));
  return { current: n.entityTypeUri || null, options };
}
// Every type in the workspace, for the types a link field may point at: the Set type list without the scoping.
async function typeList() {
  if (!S.client) throw new Error(NOT_CONNECTED);
  // ponytail: one page of 200 (ListNodes has no paging); a workspace had 10 on 2026-09-26. Page by createTimeMin if one outgrows it.
  const { nodes = [] } = await S.client.graph.listNodes({ nodeTypes: ['type'], limit: 200 });
  nodes.forEach(rememberType);
  const flows = await workflowTypes(nodes.map((t) => t.id)); // the Type pill: a list of these alone is a list of tasks
  return nodes.map((t) => ({ uri: t.id, title: t.title || '', hue: hueOf(t), workflow: flows.has(t.id) })).sort((a, b) => a.title.localeCompare(b.title));
}
// Which of these types have a workflow (data.workflowUri): their documents are tasks, so a list of them alone keeps the
// Status and Assigned to filters (sdk/query.js tasksInScope). The graph's typeDef does not say, so each type is read.
// ponytail: remembered for the session, as the phone does (ios/engine listsTasks); a type given a workflow later counts after a relaunch.
const workflowKnown = new Map(); // type uri -> has a workflow
async function workflowTypes(uris = []) {
  const types = [...new Set(uris)].filter((u) => typeof u === 'string' && TYPE_URI.test(u));
  await Promise.all(types.filter((u) => !workflowKnown.has(u)).map((u) => document(u).then((d) => workflowKnown.set(u, !!readNode(d).workflowUri), () => {}))); // unread: asked again next time
  return new Set(types.filter((u) => workflowKnown.get(u)));
}
async function setType(id, typeUri) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  if (typeof id !== 'string' || !DOC_URI.test(id) || !TYPED_KINDS.has(idKind(id))) throw new Error('Only documents and meetings carry a type');
  const uri = typeUri == null ? null : typeUri;
  let workflow = false;
  if (uri !== null) {
    // The type's own document decides, as it does for creation: the index carries `typeDef` for the list, but what a
    // type applies to and where it lives is read from the type itself before anything is written.
    const type = readNode(await document(uri));
    if (type.type !== 'type' || isDeleted(type)) throw new Error('Type is unavailable');
    const context = typeContext(id);
    if ((type.appliesTo ?? 'docs') !== context) throw new Error(context === 'events' ? 'That type applies to documents, not meetings' : 'That type applies to meetings, not documents');
    const home = readNode(await document(id)).ownerUri || null;
    if (type.ownerUri && type.ownerUri !== home) throw new Error('That type lives in ' + (typeTitles.get(type.ownerUri) || 'another space') + '; move the document there first');
    workflow = !!type.workflowUri;
  }
  await mut(id, (doc) => setEntityType(doc, uri, { workflow, byUri: S.me.userUri }));
  scheduleRefresh(2000); // the row updates from the change event; this is the index catching up for the next list
  return uri;
}
// What Auto-pick type weighs (main/ai.js classifyType): the document's own words, and the types Set type would let it
// have, each with the description and AI instructions kept on the type's document. The graph's typeDef carries
// neither, so every candidate is read; the sync client keeps them, so the next classify costs no more calls.
async function typeCandidates(id) {
  const { current, options } = await typeChoices(id);
  const doc = await document(id), n = readNode(doc);
  const types = await Promise.all(options.filter((t) => t.selectable).map(async (t) => {
    const type = readNode(await document(t.uri));
    return { uri: t.uri, title: t.title, hue: t.hue, description: type.description, instructions: type.instructions };
  }));
  // a meeting's content is empty; what it is about is in the calendar description, when there is one
  const text = [typeof n.description === 'string' ? n.description : '', contentText(doc)].filter((s) => s.trim()).join('\n\n');
  return { title: n.title || '', text, current, types };
}
// A type's colour, as this app draws it: our own hue (0-360) or 'grey', kept in the settings document under the
// type (main/rows.js typeHue), so Tana's own hue on the type is left alone and the choice still follows you between
// machines. null forgets the override and Tana's colour shows again. (Tana's hue itself is written by the CLI's
// set-hue: `appearance.hue`, a root map beside `data`.)
async function setTypeHue(typeUri, hue) {
  if (typeof typeUri !== 'string' || !TYPE_URI.test(typeUri)) throw new Error('Colours are set on a type');
  if (hue !== null && hue !== 'grey' && (!Number.isInteger(hue) || hue < 0 || hue > 360)) throw new Error('A hue is 0-360, or grey');
  const next = { ...(settings.get('typeHues') || {}) };
  if (hue === null) delete next[typeUri]; else next[typeUri] = hue;
  settings.set('typeHues', next);
  if (S.refresh) await S.refresh({ after: true }); // no change event carries a setting: the rows are rebuilt and announced here
  return hue;
}
// ---- "Discuss with …" (Cmd+K): the Discussion Task type, and the name that goes in its one field ----
// The type and its field are matched by title, because a title is all a workspace that has never seen either can be
// matched on: keys are Tana's own eight characters and differ per workspace. A missing type is created in the
// Library (no home space, so it goes on a document wherever it lives) with that one field, cardinality multiple,
// which is how the type this was built from carries it. The field holds plain text rather than member references:
// every instance of the real type (9 read on 2026-09-20) does, and half of them name a team rather than a person.
const DISCUSSION_TYPE = 'Discussion Task', DISCUSS_FIELD = 'Discuss with';
const sameTitle = (a, b) => String(a || '').trim().toLowerCase() === b.toLowerCase();
async function discussionType() {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const { nodes = [] } = await S.client.graph.listNodes({ nodeTypes: ['type'], limit: 200 });
  // A type living in a space only goes on documents in that space, so a Library one is preferred when a workspace
  // has both; among equals the first the index reports wins, which is the oldest.
  const found = nodes.filter((t) => sameTitle(t.title, DISCUSSION_TYPE) && ((t.typeDef && t.typeDef.appliesTo) || 'docs') === 'docs')
    .sort((a, b) => (a.ownerUri ? 1 : 0) - (b.ownerUri ? 1 : 0))[0];
  const uri = found ? found.id : (await createDocument(DISCUSSION_TYPE, { kind: 'type' })).id;
  const type = await document(uri);
  const titles = fields.templateTitles(type);
  let attribute = Object.keys(titles).find((key) => sameTitle(titles[key], DISCUSS_FIELD));
  if (!attribute) { attribute = fields.addField(type, { title: DISCUSS_FIELD, cardinality: 'multiple' }); typeAttrTitles.delete(uri); }
  return { uri, key: uri + '?attribute=' + attribute };
}
// The names in that answer who are people here become inline references to their profiles, and the rest stays
// words: "Stan and Ria", with only Stan in the workspace, is a mention of Stan followed by " and Ria". The words
// are kept as the mention's label rather than replaced with the profile's full title, so the line still reads the
// way it was written; the reference is the id beside it.
//
// Three rules keep a match from being a guess. A name matches on whole words only, counted in letters rather than
// \w, or "Rekké" would never end and "Stan" would match "Standard". The longest name wins, so "Stan Engbers"
// matches as one person rather than as "Stan" plus a surname. A first name shared by two people is not a name at
// all here — with two Stans in the workspace, only "Stan Engbers" matches — and nobody is referenced twice, so a
// name repeated in one answer leaves the second mention as words.
const isWordChar = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);
function findWord(text, needle, taken, firstOnly) {
  const lower = text.toLowerCase(), want = needle.toLowerCase();
  for (let at = lower.indexOf(want); at >= 0; at = lower.indexOf(want, at + 1)) {
    const end = at + want.length;
    if (isWordChar(text[at - 1]) || isWordChar(text[end])) continue; // inside a longer word: not this name
    // A first name must fill a whole entry, never the first word of an unknown full name.
    if (firstOnly && (!/(?:^|[,;&]|\b(?:and|en))\s*$/iu.test(text.slice(0, at)) || !/^\s*(?:$|[,;&]|(?:and|en)\b)/iu.test(text.slice(end)))) continue;
    if (taken.some((hit) => at < hit.end && end > hit.start)) continue; // already part of a longer name
    return at;
  }
  return -1;
}
// segments when anyone matched, the plain string when nobody did — the same write this made before there was any
// matching at all, so a workspace whose members cannot be read still gets its answer.
async function nameSegments(who) {
  const people = await members().catch(() => []);
  const firsts = new Map();
  for (const person of people) { const first = String(person.title || person.text || '').trim().split(/\s+/)[0].toLowerCase(); if (first) firsts.set(first, (firsts.get(first) || 0) + 1); }
  const names = [];
  for (const person of people) {
    const title = String(person.title || person.text || '').trim();
    if (!title) continue;
    names.push({ needle: title, uri: person.id, firstOnly: !/\s/.test(title) });
    const first = title.split(/\s+/)[0];
    if (first && first !== title && firsts.get(first.toLowerCase()) === 1) names.push({ needle: first, uri: person.id, firstOnly: true });
  }
  names.sort((a, b) => b.needle.length - a.needle.length);
  const hits = [];
  for (const name of names) {
    if (hits.some((hit) => hit.uri === name.uri)) continue;
    const at = findWord(who, name.needle, hits, name.firstOnly);
    if (at >= 0) hits.push({ start: at, end: at + name.needle.length, uri: name.uri });
  }
  if (!hits.length) return who;
  hits.sort((a, b) => a.start - b.start);
  const segments = [];
  let at = 0;
  for (const hit of hits) {
    if (hit.start > at) segments.push({ text: who.slice(at, hit.start) });
    segments.push({ mention: { label: who.slice(hit.start, hit.end), uri: hit.uri } });
    at = hit.end;
  }
  if (at < who.length) segments.push({ text: who.slice(at) });
  return segments;
}
// One action: type the document if it is not that type already, then write the name into the field. The two writes
// are separate undo steps, as a retype and a field edit are anywhere else.
async function discussWith(id, who) {
  if (typeof who !== 'string' || !who.trim()) throw new Error('Who should this be discussed with?');
  if (typeof id !== 'string' || !DOC_URI.test(id) || idKind(id) !== 'text') throw new Error('Only a document can be a discussion task');
  const { uri, key } = await discussionType();
  if (readNode(await document(id)).entityTypeUri !== uri) await setType(id, uri);
  const value = await nameSegments(who.trim());
  await mut(id, (doc) => fields.setFieldText(doc, key, value));
  return { typeUri: uri, key, who: who.trim(), mentions: typeof value === 'string' ? [] : value.filter((s) => s.mention).map((s) => s.mention.uri) };
}

// ---- fields that hold choices or links (issue #33) ----
// A field value written the way Tana checks it (sdk/fields.js checkValue): its definition is read off the type, and
// a link field with target types learns each linked document's type from the graph, so a value Tana would refuse
// never reaches the document.
async function setField(id, key, value) {
  const { typeUri, attribute } = fields.parseKey(key);
  const field = TYPE_URI.test(typeUri || '') ? fields.fieldDefinition(await document(typeUri), attribute) : null;
  if (!field) throw new Error('That field is no longer on its type');
  const uris = [...new Set((Array.isArray(value) ? value : []).flatMap((line) => (Array.isArray(line) ? line : (line && line.segments) || []))
    .map((s) => s && s.mention && s.mention.uri).filter((uri) => typeof uri === 'string' && DOC_URI.test(uri)))];
  const types = new Map();
  if (field.type === 'link' && (field.to || []).length && uris.length) {
    const { nodes = [] } = await S.client.graph.listNodes({ nodeIds: uris, limit: uris.length });
    for (const n of nodes) types.set(n.id, n.entityType);
  }
  await mut(id, (doc) => fields.setFieldText(doc, key, value, { field, typeOf: (uri) => types.get(uri) }));
}
// A type's field definitions. editable() answers false for a type document (it is no outline), so the write goes
// through op rather than mut, and onto the undo stack the way mut puts one there.
async function mutType(typeUri, fn) {
  if (typeof typeUri !== 'string' || !TYPE_URI.test(typeUri)) throw new Error('Fields are defined on a type');
  if (S.historyBusy) throw new Error('History operation is still running');
  const result = await op(typeUri, fn);
  undoStack.push(typeUri); redoStack.length = 0;
  typeAttrTitles.delete(typeUri); // the labels every page reads come from this template
  return result;
}
// change: { type?, cardinality?, options?, to? } — what kind of field, how many values, its choices, its target types
function defineField(typeUri, attribute, change = {}) {
  return mutType(typeUri, (doc) => {
    if ('type' in change || 'cardinality' in change) fields.setFieldKind(doc, attribute, { type: change.type, cardinality: change.cardinality });
    if (change.options) fields.setFieldOptions(doc, attribute, change.options);
    if (change.to) fields.setFieldTargets(doc, attribute, change.to);
    return fields.fieldDefinition(doc, attribute);
  });
}
const addTypeField = (typeUri, def) => mutType(typeUri, (doc) => fields.addField(doc, def || {}));

async function createDocument(title, opts = {}) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('Keep an empty draft local until it has a title');
  if (!S.client) throw new Error(NOT_CONNECTED);
  let config = {kind:opts.kind || 'doc'};
  if (config.kind === 'custom') config = await customCreation(opts.typeUri);
  // A task of a type (Quick Add Task's picker): the type's own rules decide, as for a custom document, and it stays a
  // task — open, assigned to its creator — rather than becoming the type's plain document.
  else if (config.kind === 'task' && opts.typeUri !== undefined) {
    config = await customCreation(opts.typeUri);
    if (config.kind === 'meeting') throw new Error('That type applies to meetings, not tasks');
    config = {...config, kind:'task'};
  }
  else if (opts.typeUri !== undefined) throw new Error('Custom type requires kind custom');
  // A saved search is created from a query, never from a bare title: initDocument writes the query container at
  // birth because searchChildren reads an empty one as unreadable and refuses to run it.
  if (config.kind === 'search') {
    if (!opts.query || typeof opts.query !== 'object' || Array.isArray(opts.query)) throw new Error('A saved search needs a query');
    config = {...config, query: opts.query, view: opts.view}; // view: how its rows are arranged (sdk/node.js writeSearchView)
  } else if (opts.query !== undefined) throw new Error('Only a saved search carries a query');
  if (!Object.hasOwn(KINDS, config.kind)) throw new Error('Unsupported creation kind'); // 'constructor' is a truthy lookup, not a kind
  const id = KINDS[config.kind] + ulid();
  const doc = await subscribe(id, loro => initDocument(loro, title, S.me.userUri, config));
  if (!doc) throw new Error(S.status.error || 'could not create ' + id);
  const node = await info(doc); scheduleRefresh(2000); return node; // give GraphService's index time to include the new node
}

// A row's field values, read off the document on every change like its title and state: the cached row carries the
// ones its search saw, which a table cell (renderer/views.js) would otherwise show until the next refresh.
function fieldLines(doc) {
  const values = {};
  for (const f of fields.readFields(doc)) { const lines = f.text.split('\n').filter((l) => l.trim()); if (lines.length) values[f.key] = lines; }
  return Object.keys(values).length ? values : undefined; // undefined too: a cleared field clears the row's
}
async function info(doc) { return { ...(await rowInfo(doc)), fields: fieldLines(doc) }; }
// Node shape for any subscribed document: cached row when listed, else derived from the Loro data map.
async function rowInfo(doc) {
  const n = readNode(doc), row = db.get(doc.id);
  if (isDeleted(n) || deletedNodes.has(doc.id)) throw new Error('Node has been deleted');
  rememberNodeHue(n);
  // A cached row carries the short list form of an event's meta ("Mon 9:00"); a zoomed node shows the full date
  // like search does (#113), so the meta is rebuilt from the event itself when there is one.
  const ev = n.type === 'event' || doc.id.startsWith('tana:event:') ? eventMeta(n.startTime, n.endTime, true) : undefined;
  // The document owns its type, as it owns its title and its state. A cached row still carries the chip the list was
  // built with, so a retype — here or in Tana — would show nothing until a refresh replaced the whole section; a row
  // whose type has moved on is therefore rebuilt from the document below rather than patched.
  if (row && (typeUriOf(row) || null) === (n.entityTypeUri || null)) return toNode({ ...row, title: n.title ?? row.title, done: n.stateType === 'closed' ? 1 : 0, meta: ev || row.meta });
  await resolveHue(doc.id); // cached rows already carry the hue the refresh learned from the graph
  await resolveTypes([n.entityTypeUri]);
  return builtRow(doc, n);
}
// The row a document makes of itself, with what is known now: a type whose name is not read yet has no chip.
function builtRow(doc, n) {
  // No updatedAt of our own: toNode falls back to nodeMeta — the graph's updateTime, or the time onChange saw an edit.
  // A current time here made a row jump to the top of a list sorted by last update whenever it was merely read —
  // expanding it subscribes it, and the bootstrap comes back as a change the renderer patches every copy of the row with.
  if (idKind(doc.id) === 'user-profile') return toNode(memberRow(doc.id, n.title || doc.data.get('name') || doc.data.get('displayName') || '', undefined, hueOf(n)));
  if (PLAIN_KINDS.has(idKind(doc.id))) return toNode(kindRow(doc.id, idKind(doc.id), n.title || '', undefined, hueOf(n)));
  const isEvent = n.type === 'event' || doc.id.startsWith('tana:event:');
  if (!isEvent && !n.stateType) return toNode(plainRow(doc.id, n.title || '', undefined, n.entityTypeUri, hueOf(n)));
  return toNode({
    id: doc.id, title: n.title || '', done: n.stateType === 'closed' ? 1 : 0, icon: isEvent ? 'meeting' : 'task',
    hue: hueWithType(hueOf(n), n.entityTypeUri), meta: isEvent ? eventMeta(n.startTime, n.endTime, true) : null, tags: [nodeTag(isEvent ? TAG.meeting : TAG.task, n), ...typeTag(n.entityTypeUri)],
  });
}

// Waiting (main/settings.js stateName): the workspace's one workflow with the one state, its id computed rather than
// stored, so it only has to exist. The index is asked once a session; when it has none it is made — in the Library, which
// everyone in the workspace reads, written as Tana writes a type's board (sdk/node.js initDocument). Never made blind:
// sync applies an initializer to a document that exists too, which would add a state to it every session. Two made at
// once (or one the index has not caught up with) write the same keys with the same values, so they merge into one.
let waitingKnown = null; // the workflow this session has seen or made
async function waitingState() {
  const workflowUri = settings.waitingWorkflow(), workflowStateId = settings.WAITING_STATE;
  if (!S.client || !workflowUri) throw new Error(NOT_CONNECTED);
  if (waitingKnown !== workflowUri) {
    const { nodes = [] } = await S.client.graph.listNodes({ nodeIds: [workflowUri], limit: 1 });
    if (!nodes.length && !await subscribe(workflowUri, (loro) => initDocument(loro, '', S.me.userUri, { kind: 'workflow', states: [{ id: workflowStateId, name: 'Waiting' }] }))) throw new Error(S.status.error || 'could not create the Waiting workflow');
    waitingKnown = workflowUri;
  }
  return { workflowUri, workflowStateId };
}
// Set status, for one task or a selection: Tana's four, or Waiting, which is In Progress in that workflow.
async function setStates(ids, state) {
  const to = state === 'waiting' ? await waitingState() : state;
  const count = await mutTasks(ids, (doc) => setState(doc, to, S.me.userUri));
  for (const id of ids) docStates.set(id, state);
  scheduleRefresh(2000);
  return count;
}

function setSensitive(id, on) {
  if (typeof id !== 'string' || !DOC_URI.test(id)) throw new Error('Not a Tana document id');
  if (typeof on !== 'boolean') throw new Error('Sensitive state must be true or false');
  // A mark on your own content, so it follows you: the ids are one synced setting rather than a table of this
  // machine's own (main/settings.js). db keeps its table as the migration source, read once below.
  const ids = new Set(sensitiveIds());
  if (on) ids.add(id); else ids.delete(id);
  settings.set('sensitive', [...ids].sort());
  return on;
}
// The marks, from the synced setting — falling back to the SQLite table a build before this one wrote, which is
// also what seeds the setting the first time a machine runs this version.
function sensitiveIds() {
  const stored = settings.get('sensitive');
  if (Array.isArray(stored)) return stored.filter((id) => typeof id === 'string');
  const legacy = db.sensitiveIds();
  if (legacy.length) settings.set('sensitive', legacy);
  return legacy;
}

function subscribe(id, init) {
  return S.client.sync.subscribe(id, init).catch((e) => { subscribed.delete(id); report(e); return null; });
}

// note: false for a document the app made and takes back itself (discard), which is no deletion of yours to restore
function invalidateDeleted(id, note = true) {
  deletedNodes.add(id);
  // What Cmd+K "Recently deleted" offers to restore. The title is taken before the cached row goes, from the
  // document itself while it is still open: a deleted document survives with its title, but nothing lists it.
  const open = S.client && S.client.sync.getDocument(id);
  if (note) db.noteDeleted(id, (open && readNode(open).title) || (db.get(id) || {}).title);
  db.remove(id);
  nodeHues.delete(id); hueLoaded.delete(id); editability.delete(id); nodeMeta.delete(id);
  typeTitles.delete(id); typeHues.delete(id);
  summaryCache.delete(id);
  for (const [event, writeUp] of summaryCache) if (writeUp === id) summaryCache.delete(event); // a deleted write-up is no redirect target
  send('outline:removed', id); // renderer must evict children/search/pin/zoom caches by id
  send('outline:changed', null);
}

// ---- watching a node for changes ----
// On by default for a task you created that is not assigned to you: either nobody has picked it up yet or somebody
// else has, and both are worth hearing about. A task assigned to you is your own work to look at, and a task
// somebody else created is theirs to follow. Everything else — documents, meetings, anything you did not create —
// is off until you ask for it in Cmd+K, and an explicit choice still wins either way.
// A document with no stateType is not a task (docs/sdk/02-data-model.md), which is what keeps notes out of this.
const notifyDefault = (n, creator) => {
  const me = S.me && S.me.userUri;
  if (!me || !n.stateType || creator !== me) return false;
  return !(Array.isArray(n.assignedToUris) && n.assignedToUris.includes(me));
};
// Who made a node is the graph's answer, not the document's: a Loro document carries createdAt but no creator.
// It never changes, so one lookup per node is the whole cost, and every node a view lists has already cached it.
async function creatorOf(id) {
  if (nodeCreators.has(id)) return nodeCreators.get(id);
  try {
    const { nodes } = await S.client.graph.listNodes({ nodeIds: [id], limit: 1 });
    const creator = (nodes && nodes[0] && nodes[0].createdBy) || null;
    nodeCreators.set(id, creator);
    return creator;
  } catch { return null; } // unreadable or gone: not yours, so not watched
}
// An explicit choice wins; absent, the rule above decides. Stored as a map so "off for a node the rule would watch"
// is a real answer and not the same as never having chosen.
const notifyChoices = () => { const stored = settings.get('notify'); return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}; };
const notifyOn = (n, creator) => { const chosen = notifyChoices()[n.id]; return typeof chosen === 'boolean' ? chosen : notifyDefault(n, creator); };
// The nodes you explicitly asked to be told about. A change only reaches onChange while its document is subscribed,
// and the view refresh unsubscribes everything the active view stops listing, so without this "notify me" quietly
// meant "while this view happens to list it". The rule-based defaults cannot be enumerated without reading every
// document, so they stay as they were: watched while something is looking at them.
// a deleted node is watched no more (deletedNodes, seeded at boot from the Recently deleted list): Tana refuses its bootstrap for ever
const notifyWatchedIds = () => { const chosen = notifyChoices(); return new Set(Object.keys(chosen).filter((id) => chosen[id] === true && !deletedNodes.has(id))); };
// The other half of that map: the nodes you silenced. The watch rule (main/views.js refreshWatched) reads graph
// nodes, whose shape notifyDefault cannot take, so it needs the choice as a set rather than as notifyOn.
const notifySilencedIds = () => { const chosen = notifyChoices(); return new Set(Object.keys(chosen).filter((id) => chosen[id] === false)); };
async function notifyState(id) {
  const n = await op(id, (doc) => readNode(doc));
  const creator = await creatorOf(id);
  return { on: notifyOn(n, creator), default: notifyDefault(n, creator), explicit: typeof notifyChoices()[id] === 'boolean' };
}
async function setNotify(id, on) {
  const chosen = notifyChoices();
  if (on === null || on === undefined) delete chosen[id]; else chosen[id] = !!on;
  settings.set('notify', chosen);
  return notifyState(id);
}
const NOTIFY_STATE = { proposed: 'Inbox', open: 'In Progress', closed: 'Completed', not_now: 'Later' };
// ---- handing a node to an agent (main/agent.js, main/agents/) ----
// App-local on purpose: Tana's assignedToUris takes user-profile uris only, so an agent cannot be a native assignee.
// The ids live in the settings table beside the watch choices; two states, so a list rather than a map.
// Assignment only: nothing here dispatches, runs or reports back.
const agentIds = () => { const stored = settings.get('codex'); return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string' && !deletedNodes.has(id)) : []; }; // a deleted node's task is let go, as notifyWatchedIds does
// What the agent was asked to do with the node, by id. A second map rather than a list of pairs: the assignment list
// is what everything else reads, and turning it into objects would rewrite every reader for a field only the prompt
// page writes. A prompt exists only alongside the assignment it was given with, so unassigning drops both.
const codexPrompts = () => { const stored = settings.get('codexPrompt'); return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}; };
// The prompt also goes into the node itself, where a person reading it in Tana can see what the agent was handed:
// one "Agent context" block on the document with the prompt's lines nested under it. Reassigning rewrites that
// block's children rather than adding a second one — the heading is found by its exact title among the document's
// own top-level blocks, the same way anything else here looks a child up. Unassigning takes it out again, with its status
// line (removeAgentContext): the node goes back to what it was before it was handed over, but for what the agent wrote.
const AGENT_HEADING = 'Agent context';
function writeAgentContext(id, prompt) {
  // Blank lines would be empty outline rows, which read as damage rather than as spacing; everything else is kept
  // line for line, in order.
  const lines = prompt.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return Promise.resolve(null);
  return mut(id, (doc) => {
    const heading = content.readOutline(doc).find((n) => (n.text || '').trim() === AGENT_HEADING);
    if (heading) for (const child of heading.children || []) content.remove(doc, child.id); // this prompt replaces the last one
    const headId = heading ? heading.id : content.insertAfter(doc, null, AGENT_HEADING);
    // the block is the last of the node: the agent writes above it, and its status is the block's last line
    const last = content.readOutline(doc).at(-1);
    if (heading && last && last.id !== headId) content.moveTo(doc, headId, { afterId: last.id });
    // insertChild always lands at the top of the child list, so only the first line goes in that way and the rest
    // follow their predecessor — the same pair of operations the day-node rows are written with.
    let prev = content.insertChild(doc, headId, lines[0]);
    for (const line of lines.slice(1)) prev = content.insertAfter(doc, prev, line);
    return headId;
  });
}
// How a handed-over node is going: the last "Agent status: Assigned | Working | Completed | Failed" line in it, which is
// the last line of its Agent context block. Orbital writes Assigned when it hands a node over; the agent, which reports
// nowhere else (your Dot, through orbital.md, whose Tana connector offers only Tana's four statuses), changes it to
// Working as it starts, so its pickup shows, and to Completed or Failed when it is done. Ordinary content,
// so whoever opens the node sees it, in Tana too; the last one wins, so a handoff added after an old Completed is the
// current one.
const AGENT_STATUS = /^\s*Agent status:\s*(Assigned|Working|Completed|Failed)\b/i;
const lastAgentStatus = (text) => { let last = null; for (const line of String(text || '').split('\n')) { const m = line.match(AGENT_STATUS); if (m) last = m[1].toLowerCase(); } return last; };
// The status is one line, the last inside the Agent context block (writeAgentContext keeps that block last): what was
// there is replaced. A node with no block gets it at its end.
const writeAgentStatus = (id, status) => mut(id, (doc) => {
  const line = 'Agent status: ' + status, heading = content.readOutline(doc).find((n) => (n.text || '').trim() === AGENT_HEADING);
  if (!heading) return content.insertAfter(doc, null, line);
  for (const child of heading.children || []) if (AGENT_STATUS.test(child.text || '')) content.remove(doc, child.id);
  const kids = content.readOutline(doc).find((n) => n.id === heading.id).children || [];
  return kids.length ? content.insertAfter(doc, kids.at(-1).id, line) : content.insertChild(doc, heading.id, line);
});
const agentStatus = (id) => op(id, (doc) => lastAgentStatus(contentText(doc)));
// Unassigned: the Agent context block goes, with its status line, and any status line an older build left on its own
const removeAgentContext = (id) => mut(id, (doc) => {
  for (const n of content.readOutline(doc)) if ((n.text || '').trim() === AGENT_HEADING || AGENT_STATUS.test(n.text || '')) content.remove(doc, n.id);
});
async function setAgentMark(id, on, prompt) {
  const next = agentIds().filter((x) => x !== id);
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  // The visible half first. If the document will not take the context there is nothing local to undo, so a badge
  // never claims a handoff the node itself knows nothing about. With no prompt there is nothing to write, and the
  // assignment is simply local.
  if (on && text) await writeAgentContext(id, text);
  if (!on) await removeAgentContext(id).catch(() => {}); // a node that will not take the write still lets go of the assignment
  if (on) next.push(id);
  settings.set('codex', next);
  const prompts = codexPrompts();
  if (on && text) prompts[id] = text; else delete prompts[id];
  settings.set('codexPrompt', prompts);
  // an assigned node stays live wherever you are, the way an explicitly watched one does (main/views.js)
  if (on && S.client) S.client.sync.subscribe(id).catch(() => {});
  return !!on;
}
// docId -> [title, stateType, oplog frontiers] as last seen: what a change has to differ from to be one. The
// frontiers are what makes an ordinary edit count — a body rewritten elsewhere moves neither title nor state, and
// watching a node you never hear from is the same as not watching it. They also absorb a re-import of ops already
// seen (a resync), which a version-free comparison would announce as an edit.
const notifySigs = new Map();
const notifyQuiet = new Map(); // docId -> when a plain edit was last announced
const EDIT_QUIET_MS = 60000; // a remote edit arrives op by op: someone typing is one banner a minute, not fifty
// ...and the banner waits until the typing stops, then says what the burst did from the document itself: the text now
// against the text at the version last seen (Loro keeps the history, forkAt reads it back). Announced at the first op,
// it said "Edited", or a word cut off after two letters.
const EDIT_SETTLE_MS = 4000;
const settling = new Map(); // docId -> { frontiers before the burst, timer }
const clip = (t) => '“' + (t.length > 120 ? t.slice(0, 119) + '…' : t) + '”';
function whatChanged(doc, frontiers) {
  let old;
  try { old = doc.loro.forkAt(frontiers); } catch { return null; } // history it does not have: "Edited" it is
  const was = old.getMap('data').get('title'), now = doc.loro.getMap('data').get('title');
  if (was !== now) return 'Renamed from ' + clip(was || 'Untitled');
  const lines = (c) => contentText({ content: c }).split('\n').map((l) => l.trim()).filter(Boolean);
  const a = lines(old.getMap('content')), b = lines(doc.content);
  const added = b.filter((l) => !a.includes(l)), removed = a.filter((l) => !b.includes(l));
  const more = (list) => (list.length > 1 ? ` and ${list.length - 1} more` : '');
  if (added.length) return (removed.length ? 'Changed to ' : 'Added ') + clip(added[0]) + more(added);
  if (removed.length) return 'Removed ' + clip(removed[0]) + more(removed);
  return null; // a mark, a checkbox, a field: nothing a line of text says
}
function announceEdit(id, doc, frontiers) {
  const p = settling.get(id) || { frontiers };
  clearTimeout(p.timer);
  const timer = setTimeout(() => {
    if (p.timer !== timer) return; // a later op moved the banner on
    settling.delete(id);
    if (!S.notify) return;
    const title = readNode(doc).title || 'Untitled';
    S.notify(id, title, whatChanged(doc, p.frontiers) || 'Edited', 'edit');
    rememberEdit(id, title);
    followSummary(id, title).catch(() => {});
  }, EDIT_SETTLE_MS);
  p.timer = timer;
  settling.set(id, p);
}
// What an edit was, in Tana's own words (issue #131). ChangeSummaryService (sdk/history.js, the sidebar's Changes
// section) writes a sentence about a window of edits only once the edits stop — 3m20s after a one-line edit, measured
// 2026-09-25 — so the banner goes out with what the text says changed (whatChanged) and is replaced by that sentence when it appears: same notification
// id, silently (main.js S.notify). A summary counts when it was not there, or said something else, at the time of the
// edit; its window's own times do not say it covers this edit (the measured one ended before the edit it described).
// A newer edit banner for the node takes the follow-up over. Not imported from main/related.js: that module requires
// this one. ponytail: polls every 30 s for 8 min per edit banner (one a minute per node at most); a live query if
// Tana ever offers one for summaries.
const SUMMARY_POLLS = 16, SUMMARY_EVERY_MS = 30000;
const following = new Map(); // docId -> the follow-up that owns its edit banner
const pause = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t && t.unref) t.unref(); });
async function followSummary(id, title, wait = () => pause(SUMMARY_EVERY_MS)) {
  if (!S.client || !S.client.history) return;
  const token = {}; following.set(id, token);
  const read = async () => (await S.client.history.listChanges({ uri: id, limit: 5 })).summaries || [];
  // A title only repeating the node's ("Orbital banner test" on "Scratch: Orbital banner test") says nothing: the description then.
  const own = (title || '').trim().toLowerCase();
  const repeats = (t) => !!own && (own.includes(t.toLowerCase()) || t.toLowerCase().includes(own));
  const said = (s) => [s.title, s.description].map((t) => (typeof t === 'string' ? t.trim() : '')).find((t) => t && !repeats(t));
  const key = (s) => s.id + '\n' + s.title;
  let seen;
  try { seen = new Set((await read()).map(key)); } catch { return; } // an older server or a refusal: "Edited" stays
  for (let i = 0; i < SUMMARY_POLLS; i++) {
    await wait();
    if (following.get(id) !== token) return;
    let fresh;
    try { fresh = (await read()).filter((s) => !seen.has(key(s)) && said(s)); } catch { continue; }
    if (!fresh.length) continue;
    const at = (s) => Date.parse(s.endTime || s.startTime || '') || 0; // the service's order has gone both ways
    following.delete(id);
    // What changed as the banner's subtitle and Tana's longer words for it as the body ("Added a document link" /
    // "A link to the Risk Register document on Slite was appended"), as the Timeline shows it; the one line alone
    // when the description says nothing more, or when it is all there is.
    const best = fresh.reduce((a, b) => (at(b) >= at(a) ? b : a)), headline = said(best);
    const detail = typeof best.description === 'string' && best.description.trim() && best.description.trim() !== headline ? best.description.trim() : null;
    if (S.notify) S.notify(id, title || 'Untitled', detail || headline, 'summary', detail ? headline : undefined);
    return;
  }
  if (following.get(id) === token) following.delete(id);
}
// The same pair, kept across restarts: id -> [title, stateType] as it was when the app last saw the node.
// notifySigs lives only as long as the process and a bootstrap takes its baseline in silence, so a task completed
// while the app was closed used to be lost outright — which is how a completion at 09:01 goes unmentioned by an app
// started at 09:27. Pruned by the refresh (pruneSeen), so it cannot grow into a history of everything ever opened.
// ponytail: one small write per node whose pair moved, 3-4 ms for 54 under WAL (db.js, measured 2026-09-27); a warm
// start writes one, the settings document that nothing follows. Batch on a timer if the map grows.
let seenPairs = null;
let caughtUp = 0; // catch-up banners spent this launch
const CATCH_UP_MAX = 3; // coming back to a busy week is not a reason to bury the screen
const storedPairs = () => { const stored = db.setting('notifySeen'); return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}; };
function rememberSeen(id, sig) {
  seenPairs ||= storedPairs();
  const pair = [sig[0], sig[1]];
  if (String(seenPairs[id]) === String(pair)) return;
  seenPairs[id] = pair;
  db.setSetting('notifySeen', seenPairs);
}
// Down to what is still followed: subscribed, or found by this refresh (`followed`: the watch rule's set and the rows
// the views keep live), or watched by hand or handed to the agent (start subscribes those outside `subscribed`).
// `followed` counts on its own because a subscribe that fails drops its id from `subscribed` (subscribe above) while
// the rule still follows it; the retry's bootstrap needs the stored pair to announce what moved meanwhile.
// Only the refresh calls it, once those are subscribed: pruning on every write ran at launch before anything was,
// and the settings document's first write cut 42 stored pairs to 1 (#427).
function pruneSeen(followed = new Set()) {
  seenPairs ||= storedPairs();
  const held = new Set([...followed, ...notifyWatchedIds(), ...agentIds()]);
  const next = Object.fromEntries(Object.entries(seenPairs).filter(([id]) => subscribed.has(id) || held.has(id)));
  if (Object.keys(next).length === Object.keys(seenPairs).length) return;
  seenPairs = next;
  db.setSetting('notifySeen', next);
}
// Peer ids keep the user's hash in their top bits, even across that user's tabs and devices. The version vector says
// which peer counters advanced since the last change, so a remote echo of your own edit stays quiet too.
function changedByMe(before, after) {
  const peerId = S.client && S.client.sync && S.client.sync.peerId;
  if (!before || !peerId) return false;
  let me;
  try { me = BigInt(peerId) >> 16n; } catch { return false; }
  for (const [peer, counter] of after) {
    if (counter <= (before.get(peer) || 0)) continue;
    try { if ((BigInt(peer) >> 16n) === me) return true; } catch { /* malformed peer id: it cannot identify me */ }
  }
  return false;
}
async function notifyWatched(id, doc, n, info) {
  const sig = [n.title ?? '', n.stateType ?? '', JSON.stringify(doc.loro.oplogFrontiers())];
  const version = doc.loro.oplogVersion().toJSON();
  const previous = notifySigs.get(id);
  const before = previous && previous.sig;
  const ownEdit = previous && changedByMe(previous.version, version);
  notifySigs.set(id, { sig, version });
  const away = before ? null : (seenPairs ||= storedPairs())[id]; // first sight this launch: what it was last time
  rememberSeen(id, sig);
  if (!info || info.origin !== 'remote' || ownEdit) return;
  if (before && JSON.stringify(before) === JSON.stringify(sig)) return; // nothing worth saying moved
  // First sight is a baseline, except where the stored pair says the status moved while the app was not running.
  // Only the status, and only somebody else's: a title differing after a week is noise, and stateChangedBy is the
  // only thing that can say who moved it, since a bootstrap arrives as 'remote' whoever made the change.
  const catchUp = !before && away && away[1] !== sig[1] && n.stateChangedBy && n.stateChangedBy !== (S.me && S.me.userUri);
  if (!before && !catchUp) return;
  if (catchUp && caughtUp >= CATCH_UP_MAX) return;
  const chosen = notifyChoices()[id];
  if (!(typeof chosen === 'boolean' ? chosen : notifyDefault(n, await creatorOf(id)))) return;
  const was = before || away; // what it is measured against: this launch's last sight, or the stored one
  const moved = was[0] !== sig[0] || was[1] !== sig[1]; // a rename or a status change: rare, and always worth a banner
  // a banner still waiting for the typing to stop takes the op in (announceEdit) however quiet the node has to be
  if (!moved && !settling.has(id)) { const last = notifyQuiet.get(id) || 0; if (Date.now() - last < EDIT_QUIET_MS) return; notifyQuiet.set(id, Date.now()); }
  if (catchUp) caughtUp++;
  // A status move already says the one thing that matters about it; everything else asks what the change was.
  let state = was[1] !== sig[1] ? (NOTIFY_STATE[sig[1]] ? 'Now ' + NOTIFY_STATE[sig[1]] : 'Status changed') : null;
  // ...and who moved it, when that is somebody else and an org member: a guest or a failed lookup keeps the plain wording.
  const who = state && n.stateChangedBy ? (await members().catch(() => [])).find((m) => m.id === n.stateChangedBy) : null;
  if (who && !who.me && who.title) state += ' by ' + who.title;
  if (!S.notify) return;
  if (state) return S.notify(id, n.title || 'Untitled', state);
  announceEdit(id, doc, JSON.parse(was[2]));
}
// The edits a banner announced, kept on this machine for the Timeline (main/timeline.js): Tana writes no summary for many
// of them, or only a week's worth later, and the Timeline had nothing else to show an edit by, so a banner came for a
// change the Timeline never showed (#536). Only somebody else's edit gets a banner, so each one here is news.
const EDITS_KEEP_MS = 30 * 864e5, EDITS_MAX = 300;
function announcedEdits() { const list = db.setting('announcedEdits'); return Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string' && Number.isFinite(e.at)) : []; }
function rememberEdit(id, title, at = Date.now()) {
  db.setSetting('announcedEdits', [...announcedEdits().filter((e) => at - e.at < EDITS_KEEP_MS), { id, title: title || '', at }].slice(-EDITS_MAX));
}
// The oplog version each document's last change left. Its first change is the bootstrap, a read; a later one that moved
// the version is an edit when it was made here, or arrived live from another client, and the row says so until
// the graph's updateTime catches up (rememberMeta). An import while it bootstraps again (a reconnect's catch-up) is
// no news of when: the graph's time for it stands, rather than the moment it happened to arrive.
const versions = new WeakMap();
const stampedOver = new Map(); // docId -> the update time an edit's stamp replaced, put back when a reset discards the edit
function onChange(docId, info) {
  try {
    // The app's own settings document is not content: it is applied and nothing else hears about it.
    if (settings.applyRemote(docId) !== false) return;
    // No row or page is either of these: main/inbox.js tells the renderer about the inbox, and a live query
    // (sdk/livequery.js) answers its own listener. Passed on, every live-query update made the renderer ask doc:info
    // for a tana:liveQuery: id, which fails DOC_URI and logged "not connected to Tana" once per update.
    if (['user-inbox', 'liveQuery'].includes(idKind(docId))) return;
    const doc = S.client.sync.getDocument(docId);
    if (!doc) return;
    const n = readNode(doc), row = db.get(docId);
    if (isDeleted(n)) {
      invalidateDeleted(docId);
      return;
    }
    const restored = deletedNodes.delete(docId);
    if (restored) db.unnoteDeleted(docId); // back from the dead: off the Recently deleted list, wherever the restore came from
    // An emptied document (Document.reset on a discard-local resync) starts over: the import after it is a bootstrap again.
    const version = doc.loro && doc.loro.oplogVersion(), seen = versions.get(doc);
    if (version && !version.length()) {
      versions.delete(doc);
      if (stampedOver.has(docId)) { nodeMeta.set(docId, { ...nodeMeta.get(docId), updatedAt: stampedOver.get(docId) }); stampedOver.delete(docId); }
    } else if (version) {
      versions.set(doc, version);
      const edit = (info && info.origin === 'local') || !S.client.sync.stateOf || S.client.sync.stateOf(docId) === 'live';
      if (edit && seen && seen.compare(version) !== 0) {
        const meta = nodeMeta.get(docId) || {};
        if (!stampedOver.has(docId)) stampedOver.set(docId, meta.updatedAt);
        nodeMeta.set(docId, { ...meta, updatedAt: now() });
      }
    }
    const hueChanged = rememberNodeHue(n);
    const done = n.stateType === 'closed' ? 1 : 0, title = n.title ?? row?.title;
    const rowChanged = row && (title !== row.title || done !== row.done || hueChanged);
    if (rowChanged) db.setRow(docId, { title, done, updatedAt: now() }); // every view's row, not just the one db.get found
    // Collection/profile/date-pin changes do not have cached view rows, but invalidate pins globally.
    const pinsChanged = docId === S.me?.userUri || ['collection', 'pin-map'].includes(idKind(docId));
    // The renderer keeps a document's metadata (assignees, audience, sharing) until one of them moves; a text
    // edit must not cost it the owner-chain and link-sharing lookups, so the event says whether they did.
    const sig = metaSig(n), meta = metaSigs.get(docId) !== sig;
    metaSigs.set(docId, sig);
    // A field's value is not metadata: announced as one, every saved keystroke in a field threw the page's assignees and
    // audience away, and Assigned to and Visible to vanished until the caret left the field. It says fields instead,
    // which re-reads the page's fields and keeps the rest.
    const fsig = JSON.stringify(n.attributes ?? null), fieldsMoved = fieldSigs.get(docId) !== fsig; // unseen: says so, like meta
    fieldSigs.set(docId, fsig);
    // and into every view's cached row: a view grouped by a field is sectioned by it after a reload or a restart too
    if (row && fieldsMoved) db.setFields(docId, fieldLines(doc));
    // A retype leaves the old type's values on the document, and the cached rows' chips say which type counts, so
    // they follow it or a reload would group the row by its former type. The rebuild starts while the cache still
    // holds the former type (rowInfo decides on the cached row before it waits), the row as it can be built now goes
    // in at once, before anyone is told, and the rebuilt one once the type's name is read: only while the document is
    // still that type, as a later retype's may land first.
    if (row && (typeUriOf(row) || null) !== (n.entityTypeUri || null)) {
      rowInfo(doc).then((node) => { if (readNode(doc).entityTypeUri === n.entityTypeUri) db.setTags(docId, node.tags, node.icon); }, report);
      const now = builtRow(doc, n);
      db.setTags(docId, now.tags, now.icon);
    }
    notifyWatched(docId, doc, n, info).catch(report); // the signature is taken here and now; the audience it may need is not
    sendChanged(docId, { meta, fields: fieldsMoved }); // the renderer patches this one row from doc:info; the page that typed it knows it has it
    // an owner an inherited audience was read through: the rows that read it read their metadata again, which lists them again
    const readers = audienceReaders.get(docId), osig = readers && ownerSig(docId, n);
    if (readers && ownerSigs.get(docId) !== osig) {
      ownerSigs.set(docId, osig); audienceReaders.delete(docId);
      for (const id of readers) { rowOwners.get(id)?.delete(docId); if (S.client.sync.getDocument(id)) sendChanged(id, { meta: true }); } // a row let go reads it when it is read again
    }
    if (pinsChanged || restored) send('outline:changed', null);
    if (restored) scheduleRefresh(0);
  } catch (e) {
    report(e);
  }
}
// What doc:taskMeta is built from, as one string per document: seeded when the renderer reads the metadata, compared
// on every change. participants carry roles and restricted the audience rule; assignedToUris the assignees.
// The type is metadata too: it decides which fields the page shows, and those are read with the sidebar (related).
// So are the values in them: a field written anywhere else — "Discuss with …", another machine, Tana itself —
// changes what a zoomed page shows, and without this the page kept the values it opened with until something else
// refreshed it. The page's own field editor already shows what it just typed, so the extra read costs it nothing.
const metaSig = (n) => JSON.stringify([n.assignedToUris, n.restricted, n.participants, n.entityTypeUri]);
const fieldSigs = new Map(); // docId -> its field values as last announced (onChange: fields, apart from meta)
// The owners a row's inherited audience was read through (#477): owner uri -> the rows that read it, and what of it they
// read (the boundary's rule and grants, those of the owners in between, the organization's members, a space's name).
// ponytail: an owner let go (releaseOnDemand) hears no more changes, so its rows keep their audience until read again.
// Each read replaces the row's owners, and a row let go forgets them (views.js refresh), so the index holds live rows only.
const audienceReaders = new Map(), ownerSigs = new Map(), rowOwners = new Map(); // rowOwners: row -> the owners it was read through
// ownerUri: an owner moved elsewhere moves the audience its children inherit
const ownerSig = (uri, n) => JSON.stringify([n.restricted, n.participants, n.ownerUri, uri.startsWith('tana:org:') ? n.memberUserProfileDocUris : null, uri.startsWith('tana:space:') ? n.title : null]);
function forgetOwners(id) {
  for (const uri of rowOwners.get(id) || []) {
    const readers = audienceReaders.get(uri);
    if (readers && readers.delete(id) && !readers.size) { audienceReaders.delete(uri); ownerSigs.delete(uri); }
  }
  rowOwners.delete(id);
}
async function audienceOwner(uri, id) {
  const d = await document(uri);
  if (d) {
    ownerSigs.set(uri, ownerSig(uri, readNode(d)));
    (audienceReaders.get(uri) || audienceReaders.set(uri, new Set()).get(uri)).add(id);
    (rowOwners.get(id) || rowOwners.set(id, new Set()).get(id)).add(uri);
  }
  return d;
}

// A field's value is an outline of its own, addressed as "<document uri>|<type uri>?attribute=<key>". Everything
// that edits an outline — every block: handler, undo, the children read — takes one of these without knowing it:
// document() hands back the field view (sdk/fields.js) instead of the document, and the rest is the same code. It
// is what keeps the page and the field editor from being two editors rather than one.
const { FIELD_ID } = fields; // the format fieldView builds (sdk/fields.js), so it is written in one place
const baseOf = (id) => { const field = typeof id === 'string' ? FIELD_ID.exec(id) : null; return field ? field[1] : id; };
async function document(id, opts = {}) {
  // A read must not create the value: opening a typed page would write an empty tree into every field it has.
  const field = typeof id === 'string' ? FIELD_ID.exec(id) : null;
  if (field) return fields.fieldView(await document(field[1]), field[2], { create: !!opts.create });
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  // A renderer draft carries a local id until it is materialised; subscribing one would create a phantom document
  // whose pending bootstrap then rejects as "unsubscribed <id>" on the next refresh.
  if (!DOC_URI.test(id)) throw new Error(NOT_CONNECTED);
  // Held for the length of the wait (main/state.js reading): the refresh sweep must not unsubscribe a bootstrap
  // somebody is awaiting, which rejected the read as 'unsubscribed <id>' whenever a view change raced a doc:info.
  reading.set(id, (reading.get(id) || 0) + 1);
  // a change read back of a document nobody keeps live (a reference already pushed out) is let go again once the last
  // read of it is done, whichever read that is (two panes may read the same change back at once)
  // (a document being let go counts as not live: this read's subscribe cancels that let-go, so the read owes it again)
  const sync = S.client.sync, live = sync.isLive ? sync.isLive(id) : !!(sync.getDocument && sync.getDocument(id));
  if (opts.patch && !live) passingReads.add(id);
  try {
    const doc = await subscribe(id); // getDocument can expose an empty handle before bootstrap completes
    if (!doc) throw new Error(S.status.error || 'could not subscribe to ' + id);
    // A change read back (renderer/app.js patchDoc) holds nothing: whatever made it live — a view, a live reference, an
    // open page, a watch, the settings or inbox — still does. Counted as a read, a reference's read back kept it in the
    // on-demand list, whose sweep let it go past LIVE_ROWS and had the pages citing it read it back in again; and one
    // already pushed out of the list was subscribed again for good (#438).
    if (!opts.patch) readOnDemand(id);
    return doc;
  } finally {
    const left = (reading.get(id) || 1) - 1;
    // only what a read back subscribed: a live document's other holders are not all dropRef's to see
    if (left > 0) reading.set(id, left); else { reading.delete(id); if (passingReads.delete(id)) dropRef(id); }
  }
}

async function op(id, fn, opts = {}) {
  try {
    const doc = await document(id, opts);
    // Finding it deleted here is news worth telling: a node this app never subscribed before has nothing else to
    // announce it, so the renderer kept the row, went on asking (doc:taskMeta once per backoff, for ever) and would
    // still open the page. invalidateDeleted evicts the caches and sends outline:removed, which is what stops both.
    if (isDeleted(readNode(doc)) && !deletedNodes.has(baseOf(id))) invalidateDeleted(baseOf(id));
    if (deletedNodes.has(baseOf(id))) throw new Error('Node has been deleted');
    return await fn(doc);
  } catch (e) {
    report(e);
    throw e;
  }
}

// Documents a read subscribed rather than a view (a zoom, doc:info, a row's doc:taskMeta as it scrolls into view),
// in order of their last read. The view refresh lets go of what its lists stop showing; these it lets go of oldest
// first once there are more than LIVE_ROWS of them (releaseOnDemand). Kept for the session they undid LIVE_ROWS:
// scrolling a long list subscribed every row for good, and each reconnect bootstrapped them all again (issue #269).
const onDemand = new Map(); // docId -> true
// A read subscribed id: it goes to the end, so the oldest reads are the first let go. A view's own row is its sweep's.
const readOnDemand = (id) => { if (!subscribed.has(id)) { onDemand.delete(id); onDemand.set(id, true); } };
// The system documents a read may reach that the app keeps live for itself: your profile, pins, the inbox, settings.
const SYSTEM_KINDS = new Set(['collection', 'pin-map', 'user-inbox', 'liveQuery']);
function releaseOnDemand(held) { // returns the ids it let go of
  const gone = [];
  let excess = onDemand.size - LIVE_ROWS;
  for (const id of [...onDemand.keys()]) {
    if (excess <= 0) break;
    if (subscribed.has(id)) { onDemand.delete(id); excess--; continue; } // a view has taken it over, and its own sweep decides
    if (held(id) || id === (S.me && S.me.userUri) || id === settings.settingsDocId() || SYSTEM_KINDS.has(idKind(id))) continue;
    onDemand.delete(id); excess--;
    docStates.delete(id);
    S.client.sync.unsubscribe(id).catch(() => {});
    gone.push(id);
  }
  return gone;
}
// Mutations: same as op, plus global undo ordering across documents (each Document keeps its own Loro UndoManager).
// Every document a step can still undo, as one set per sweep: asked once per subscription, a copy of both stacks per
// question cost 10 ms a refresh at 300 subscriptions and 5,000 steps.
function historyIds() {
  const ids = new Set();
  for (const step of [...undoStack, ...redoStack]) for (const id of Array.isArray(step) ? step : [step && typeof step === 'object' ? step.id : step]) ids.add(id);
  return ids;
}
async function mut(id, fn, accessMutation = false, title = false) {
  if (S.historyBusy) throw new Error('History operation is still running');
  // A write into a field needs its value to exist; a read of the same id must not make one.
  const result = await op(id, (doc) => {
    if (!accessMutation && editable(readNode(doc), S.me && S.me.userUri, title) === false) throw new Error('This node is read-only in the outliner');
    return fn(doc);
  }, { create: true });
  // Sharing and moves are gated by an audience disclosure and a preview token; a raw CRDT undo would rewrite
  // participants, restricted or ownerUri without either, so those mutations do not enter the undo stack.
  // The undo stack holds documents: a field's rows are undone on the document that carries them.
  if (!accessMutation) { undoStack.push(baseOf(id)); redoStack.length = 0; }
  return result;
}
// Task metadata lives in separate CRDT documents. Preflight the whole selection, then group those
// per-document transactions into one user-visible history step.
async function mutTasks(ids, fn) {
  if (S.historyBusy) throw new Error('History operation is still running');
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !DOC_URI.test(id))) throw new Error('Select unique task documents');
  const docs = await Promise.all(ids.map((id) => op(id, (doc) => {
    const node = readNode(doc);
    if (!STATE_TYPES.includes(node.stateType)) throw new Error('Task metadata can only be changed on tasks');
    if (editable(node, S.me && S.me.userUri) === false) throw new Error('This node is read-only in the outliner');
    return doc;
  })));
  const changed = [];
  try {
    for (const doc of docs) {
      const before = doc.loro.oplogVersion();
      fn(doc);
      if (before.compare(doc.loro.oplogVersion()) !== 0) changed.push(doc.id);
    }
  } finally {
    if (changed.length) { undoStack.push(changed); redoStack.length = 0; }
  }
  return changed.length;
}
// ponytail: one undo step per mutation call across docs; inside a document the UndoManager keeps one step per
// transact (mergeInterval 0), so a multi-document mutation is as many steps as documents.
// Pasted markdown (#598) as the rows and marks Tana's editor writes: sdk/chat.js reads it, the reader chat messages
// go through, and content.insertBlocks writes it. Every line with words is a row of its own, where markdown would join
// consecutive lines into one paragraph: an outliner reads pasted lines as rows. A blank line only separates, as it
// does in markdown, so it makes no empty row. "- [ ]" and "- [x]" are checkboxes, and nothing else is.
async function pasteMarkdown(id, nodeId, before, after, markdown) {
  if (typeof markdown !== 'string' || !Array.isArray(before) || !Array.isArray(after)) throw new Error('Paste takes markdown and the row around the caret');
  const blocks = chat.blocks(markdown).flatMap((b) => (b.block === 'paragraph' ? b.text.split('\n').map((text) => ({ ...b, text })) : [b])).map((b) => {
    const task = ['bullet', 'numbered'].includes(b.block) && /^\[([ xX])\]\s+/.exec(b.text), text = task ? b.text.slice(task[0].length) : b.text;
    return { block: b.block, depth: b.depth, ...(task ? { checked: task[1] !== ' ' } : {}), segments: b.verbatim ? (text ? [{ text }] : []) : chat.segments(text) };
  });
  return mut(id, (doc) => content.insertBlocks(doc, nodeId, before, after, blocks));
}
// The two ends of a drag (docs/OUTLINER.md): the move is written on the outline the row lands in, and the outline
// it came from is read from the same document — a page and one of its fields are two roots of one Loro document
// (sdk/fields.js), so the whole move is one transaction and one undo step. Across two documents it is refused:
// a block belongs to the node that holds it.
const moveBlock = async (id, nodeId, toId, parentId, afterId) => {
  // Refused before the destination is opened: mut opens it with create, which would leave an empty value behind in
  // the field a refused drop was aimed at.
  if (baseOf(id) !== baseOf(toId)) throw new Error('A block can only move within its own document');
  return mut(toId, async (dest) => {
    content.moveTo(dest, nodeId, { parentId: parentId ?? null, afterId: afterId ?? null, from: id === toId ? dest : await document(id, { create: true }) });
  });
};
// The other half of a drag: a document dropped into an outline leaves a reference where it landed rather than
// moving (a document is not a block, and Alt asks for the same thing on a row that points at one). Written on the
// outline it lands in, which may be one of that document's fields.
const referenceIn = (toId, uri, label, parentId, afterId) => mut(toId, (dest) => {
  if (typeof uri !== 'string' || !DOC_URI.test(uri)) throw new Error('A reference points at a node');
  return content.insertMention(dest, { uri, label }, { parentId: parentId ?? null, afterId: afterId ?? null });
});
// A document action and the one that undoes it. Archive is Tana's for types (sdk/access.js ARCHIVABLE); it goes out as
// the document_action command like a delete, where Tana's client writes the data keys itself when it has the type
// open (node.setArchived) — one path here, the server stamps the rest, and Cmd+Z undoes it like a delete.
const UNDO_ACTION = { softDelete: 'restore', restore: 'softDelete', archive: 'unarchive', unarchive: 'archive' };
async function documentAction(id, action, record = true) {
  if (record && S.historyBusy) throw new Error('History operation is still running');
  if (record) S.historyBusy = true;
  try {
  if (typeof id !== 'string' || !DOC_URI.test(id)) throw new Error('Invalid document URI');
  if (!UNDO_ACTION[action]) throw new Error('Unknown document action');
  const doc = await document(id), ctx = await accessContext();
  const archiving = action === 'archive' || action === 'unarchive';
  if (archiving ? !await access.canArchive(doc, S.me.userUri, ctx) : !await access.canDelete(doc, S.me.userUri, ctx, action === 'restore')) throw new Error(archiving ? 'Archive permission is unknown or unavailable' : 'Delete/restore permission is unknown or unavailable');
  const response = await S.client.sync[action](id);
  if (response.responseUnion?.case !== 'documentActionResponse') throw new Error('Document action was not acknowledged');
  if (action === 'softDelete') invalidateDeleted(id);
  // Restore visibility comes from the server's live update, not a fabricated local snapshot.
  if (record) { undoStack.push({ id, documentAction:action }); redoStack.length = 0; }
  scheduleRefresh(0);
  return id;
  } finally { if (record) S.historyBusy = false; }
}
// A document the app made and takes back itself (an agent's task chat whose handoff failed): deleted on the server
// with no place in Recently deleted and no undo step, since it was never yours to restore.
async function discard(id) {
  if (typeof id !== 'string' || !DOC_URI.test(id)) throw new Error('Invalid document URI');
  await S.client.sync.softDelete(id);
  invalidateDeleted(id, false);
}
// Cmd+K "Archived types". Unlike a deleted document an archived one stays in the graph, behind includeArchived, so
// this is one query rather than a local list; graph times are ISO strings, so newest first is a string compare.
async function archivedTypes() {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const { nodes } = await S.client.graph.listNodes({ nodeTypes: ['type'], includeArchived: true, limit: 200 });
  return nodes.filter((t) => t.archivedAt).map((t) => ({ id: t.id, title: t.title || 'Untitled', archivedAt: t.archivedAt }))
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}
async function history(from, to, action, can) {
  if (S.historyBusy) throw new Error('History operation is still running');
  S.historyBusy = true;
  try {
    while (from.length) {
      const step = from.at(-1);
      if (Array.isArray(step)) {
        let changedId = null;
        for (const id of action === 'undo' ? [...step].reverse() : step) {
          const doc = S.client && S.client.sync.getDocument(id);
          if (!doc || !doc[can]() || isDeleted(readNode(doc)) || editable(readNode(doc), S.me && S.me.userUri) === false) continue;
          if (doc[action]()) changedId ||= id;
        }
        from.pop();
        if (changedId) { to.push(step); scheduleRefresh(2000); return changedId; }
        continue;
      }
      if (typeof step === 'object') {
        const command = action === 'undo' ? UNDO_ACTION[step.documentAction] : step.documentAction;
        await documentAction(step.id, command, false);
        from.pop(); to.push(step); return step.id;
      }
      const id = step, doc = S.client && S.client.sync.getDocument(id);
      if (!doc || !doc[can]() || isDeleted(readNode(doc)) || editable(readNode(doc), S.me && S.me.userUri) === false) { from.pop(); continue; }
      // An undone state change belongs back on its list (unchecking a task returns it to Tasks), which only a refresh knows.
      if (doc[action]()) { from.pop(); to.push(id); scheduleRefresh(2000); return id; }
      from.pop();
    }
    return null;
  } finally { S.historyBusy = false; }
}
// linkSharing lives on the graph node only. Every visible row asks for it as it scrolls in, so the lookups that
// arrive within a few milliseconds of each other go out as one nodeIds query instead of one call per row.
const linkBatch = new Map(); // id -> [resolve]
let linkTimer = null;
function linkShared(id) {
  return new Promise((resolve) => {
    if (!linkBatch.has(id)) linkBatch.set(id, []);
    linkBatch.get(id).push(resolve);
    linkTimer ||= setTimeout(async () => {
      const batch = new Map(linkBatch); linkBatch.clear(); linkTimer = null;
      let shared = new Set();
      try {
        const ids = [...batch.keys()];
        for (let i = 0; i < ids.length; i += 200) {
          const { nodes = [] } = await S.client.graph.listNodes({ nodeIds: ids.slice(i, i + 200), limit: 200 });
          for (const n of nodes) if (n.linkSharing && n.linkSharing.mode) shared.add(n.id);
        }
      } catch { shared = new Set(); }
      for (const [nodeId, resolves] of batch) for (const r of resolves) r(shared.has(nodeId));
    }, 25);
  });
}
async function accessContext() {
  const token = await S.session.getAccessToken();
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  return {sync:S.client.sync, graph:S.client.graph, orgDocUri:S.me.orgDocUri,
    orgAdmin:claims.org_id === S.me.orgId && ['admin','owner'].includes(claims.role)};
}
// Native write access to a document: a participant grant or an inherited owner boundary (sdk/access.js), never the
// outliner's editable-body answer, which is about editing a title or content.
const canWriteDoc = async (doc) => access.canWrite(readNode(doc), S.me.userUri, await accessContext());
async function moveTarget(spaceId) {
  if (spaceId === 'library') return access.LIBRARY;
  if (typeof spaceId !== 'string' || !/^tana:space:[0-9a-z]{26}$/.test(spaceId)) throw new Error('Select a space');
  return document(spaceId);
}

// A page writing text it has just typed says so (typed): while the write is applied it is S.writer, and the change it
// makes reaches that page marked as its own (main/documents.js onChange, sendChanged), so the page is not read again
// and rebuilt under the caret on every save (#265). The write and its announcement are one synchronous call
// (transact → change → onChange), so nothing else can run in between.
const typed = (e, own, fn) => { if (own !== true || !e) return fn(); S.writer = pageOf(e); try { return fn(); } finally { S.writer = null; } };
// The web link for a node, the same url home.tana.inc opens: /o/<org>/<route>/<encoded node uri>. The route is Tana's
// per kind (its link resolver beside JP.type.url, shared bundle of 2026-09-23): a type, a person, a meeting and a space
// have pages of their own, and /l/ — every other document — shows a type as raw JSON (issue #88).
const LINK_ROUTES = { type: 't', 'user-profile': 'u', event: 'e', space: 's' };
function webLink(id) {
  // the path segment is the org *document* ulid (tana:org:01ks7…), not the WorkOS org id in S.me.orgId
  const org = (S.me && S.me.orgDocUri || '').split(':').pop();
  if (!org) throw new Error(NOT_CONNECTED);
  if (!/^tana:[a-z-]+:[0-9a-z]{26}$/.test(id)) throw new Error('Not a Tana document id');
  return 'https://home.tana.inc/o/' + org + '/' + (LINK_ROUTES[id.split(':')[1]] || 'l') + '/' + encodeURIComponent(id);
}
// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table).
const ipc = {
  'doc:info': (_e, id, patch) => op(id, info, { patch: patch === true }),
  'doc:creationOptions': () => creationOptions(),
  'doc:taskTypes': () => taskTypes(), // Quick Add Task's picker: the workflow types a task can be made with
  // A document's type: the choices it can be given (with the ones it cannot, and why), and the change itself.
  'doc:types': (_e, id) => typeChoices(id),
  'doc:setType': (_e, id, typeUri) => setType(id, typeUri ?? null),
  // Fields that hold choices or links (issue #33): a value checked the way Tana checks it, a field's definition on its
  // type, a new field, and every type a link field could point at.
  'field:set': (_e, id, key, value) => setField(id, key, value),
  'field:define': (_e, typeUri, attribute, change) => defineField(typeUri, attribute, change || {}),
  'field:add': (_e, typeUri, def) => addTypeField(typeUri, def),
  'types:list': () => typeList(),
  // A type's colour: the one `appearance` field Tana keeps, written on the type itself, so every document wearing
  // it follows. setTypeHue rebuilds the rows and announces them itself, since no change event carries appearance.
  'doc:setTypeHue': (_e, typeUri, hue) => setTypeHue(typeUri, hue ?? null),
  'doc:create': (_e, title, opts) => createDocument(title, opts || {}),
  'chat:send': (_e, id, text, attachments, opts) => sendChat(id, text, attachments || [], opts || {}),
  'chat:answers': (_e, id) => chatAnswers(id),
  'chat:new': () => newChat(),
  'chat:answer': (_e, id, messageId, answers) => answerChat(id, messageId, answers === undefined ? null : answers),
  'chat:delete': (_e, id, messageId) => deleteChatMessage(id, messageId),
  'chat:invite': (_e, id, userUri) => inviteToChat(id, userUri),
  'history:undo': () => history(undoStack, redoStack, 'undo', 'canUndo'),
  'history:redo': () => history(redoStack, undoStack, 'redo', 'canRedo'),
  'doc:delete': (_e, id) => documentAction(id, 'softDelete'),
  'doc:restore': (_e, id) => documentAction(id, 'restore'),
  'doc:archive': (_e, id) => documentAction(id, 'archive'),
  'doc:unarchive': (_e, id) => documentAction(id, 'unarchive'),
  'types:archived': () => archivedTypes(),
  'deleted:list': () => db.deletedList(), // local: the graph does not list deleted documents
  'doc:setTitle': (e, id, title, own) => mut(id, (doc) => typed(e, own, () => { setTitle(doc, title); }), false, true), // true: the title alone, which a chat, agent, skill or type has too (#540)
  'doc:setDone': (_e, id, done) => mut(id, (doc) => {
    setState(doc, done ? 'closed' : 'open', S.me.userUri);
    docStates.set(id, done ? 'closed' : 'open');
    scheduleRefresh(2000); // a closed task drops off the open list
  }),
  // The state is recorded here, where it is known, rather than left to whatever reads the document next: the refresh
  // two seconds from now asks the search index, which can still be answering with the state from before this write.
  'doc:setState': (_e, id, state) => setStates([id], state),
  'doc:setStateMany': (_e, ids, state) => setStates(ids, state),
  // linkSharing lives on the graph node, never in the document, so public-to-the-internet needs its own lookup
  'doc:taskMeta': (_e, id) => op(id, async doc => {
    const n = readNode(doc);
    metaSigs.set(id, metaSig(n)); // from here on, only a change to these fields invalidates the renderer's copy
    // watched rides along: the creator is a graph fact, already cached for anything a view has listed
    // the owners it reads are reads on demand, let go with the rest (releaseOnDemand); a row draws four people and a
    // count, so the organization's whole membership does not travel with every row
    forgetOwners(id); // this read says which owners the audience comes from now
    const { people, ...audience } = await audienceMetadata(doc, S.me.userUri, S.client.graph, { subscribe: (uri) => audienceOwner(uri, id) });
    return { ...taskMeta(doc), ...audience, ...(people ? { people: people.slice(0, 4), peopleCount: people.length } : {}), linkShared: await linkShared(id), watched: notifyOn(n, await creatorOf(id)) };
  }),
  // Access has native capability checks independent of the outliner's editable-body support.
  // Watching a node for changes: on by default where you were given access to the document itself and are not its
  // assignee. null clears the choice and falls back to that rule, so "default" stays a live answer rather than a copy.
  'notify:state': (_e, id) => notifyState(id),
  'notify:set': (e, id, on) => { const state = setNotify(id, on); settings.tellOthers(pageOf(e), id); return state; }, // the choice is stored before setNotify's first await
  'doc:accessOptions': (_e, id) => op(id, async doc => access.capabilities(doc, S.me.userUri, await accessContext())),
  'doc:setSharing': (_e, id, selection) => mut(id, async doc => {
    await access.setSharing(doc, S.me.userUri, selection, await accessContext()); scheduleRefresh(2000);
  }, true),
  'spaces:search': async (_e, query = '') => {
    if (typeof query !== 'string' || query.length > 500) throw new Error('Invalid space query');
    if (!S.client) throw new Error(NOT_CONNECTED);
    const { nodes } = await S.client.graph.listNodes({ nodeTypes: ['space'], textQuery: query.trim(), limit: 50 });
    const ctx = await accessContext();
    const spaces = await Promise.all(nodes.map(async n => ({ ...toNode(graphRow(n)), selectable: await access.canWrite(n, S.me.userUri, ctx) })));
    // "Library" moves a document out of every space; it is a target, not a space, so it is added here rather than queried.
    const library = { id: 'library', title: 'Library', text: 'Library', kind: 'document', icon: 'library', editable: false, selectable: true };
    return 'library'.startsWith(query.trim().toLowerCase()) || !query.trim() ? [library, ...spaces] : spaces;
  },
  'doc:previewMove': (_e, id, spaceId) => op(id, async doc => access.previewMove(doc, await moveTarget(spaceId), S.me.userUri, await accessContext())),
  'doc:moveToSpace': (_e, id, spaceId, token) => mut(id, async doc => {
    const result = await access.moveToSpace(doc, await moveTarget(spaceId), S.me.userUri, await accessContext(), token);
    send('outline:changed', null); scheduleRefresh(2000); return result;
  }, true),
  'doc:setAssignees': (_e, id, uris) => mut(id, (doc) => {
    setAssignees(doc, uris, S.me.userUri);
    scheduleRefresh(2000); // reassignment may add or remove this task from the active filter
  }),
  'doc:setAssigneesMany': (_e, ids, uris) => mutTasks(ids, (doc) => setAssignees(doc, uris, S.me.userUri)).then((count) => { scheduleRefresh(2000); return count; }),
  'block:setText': (e, id, nodeId, value, own) => mut(id, (doc) => typed(e, own, () => { content.setText(doc, nodeId, value); })), // value: string or segments
  'block:setCell': (e, id, cellId, value, own) => mut(id, (doc) => typed(e, own, () => { content.setCellText(doc, cellId, value); })), // one table cell's text, same value as setText
  'block:tableOp': (_e, id, cellId, op) => mut(id, (doc) => content.tableOp(doc, cellId, op)), // a row or column around a cell (content.TABLE_OPS); returns the cell for the caret
  'block:setBlockType': (_e, id, nodeId, type) => mut(id, (doc) => { content.setBlockType(doc, nodeId, type); }), // type: one of content.BLOCK_TYPES
  'block:insertDivider': (_e, id, nodeId) => mut(id, (doc) => content.insertDivider(doc, nodeId)), // nodeId null appends at the end
  'block:insertTable': (_e, id, nodeId) => mut(id, (doc) => content.insertTable(doc, nodeId)), // "/" Table: 3x3 with a header row after nodeId; returns its first cell
  'block:insertAfter': (_e, id, nodeId, text, block) => mut(id, (doc) => content.insertAfter(doc, nodeId, text, false, block)),
  'block:insertBefore': (_e, id, nodeId, text) => mut(id, (doc) => content.insertBefore(doc, nodeId, text)),
  'block:split': (_e, id, nodeId, before, after, asChild) => mut(id, (doc) => content.split(doc, nodeId, before, after, asChild)), // one undo step for both halves
  'block:join': (_e, id, nodeId, intoId, value) => mut(id, (doc) => content.join(doc, nodeId, intoId, value)), // its reverse: the row above takes the words, one undo step
  'block:insertChild': (_e, id, nodeId, text) => mut(id, (doc) => content.insertChild(doc, nodeId, text)),
  'block:pasteMarkdown': (_e, id, nodeId, before, after, markdown) => pasteMarkdown(id, nodeId, before, after, markdown), // { id, offset } where the caret goes
  'block:removeMany': (_e, id, nodeIds) => mut(id, doc => content.removeMany(doc, nodeIds)),
  'block:moveMany': (_e, id, nodeIds, direction) => mut(id, doc => content.moveMany(doc, nodeIds, direction)),
  'block:indentMany': (_e, id, nodeIds) => mut(id, doc => content.indentMany(doc, nodeIds)),
  'block:outdentMany': (_e, id, nodeIds) => mut(id, doc => content.outdentMany(doc, nodeIds)),
  'block:remove': (_e, id, nodeId) => mut(id, (doc) => { content.remove(doc, nodeId); }),
  'block:indent': (_e, id, nodeId) => mut(id, (doc) => { content.indent(doc, nodeId); }),
  'block:outdent': (_e, id, nodeId) => mut(id, (doc) => { content.outdent(doc, nodeId); }),
  'block:move': (_e, id, nodeId, direction) => mut(id, (doc) => { content.move(doc, nodeId, direction); }),
  // A drag names the place outright: the row lands behind afterId, or at the top of parentId, or at the top of toId's
  // own rows. toId is the outline it lands in, which is the page or one of its fields (main/documents.js moveBlock).
  'block:moveTo': (_e, id, nodeId, toId, parentId, afterId) => moveBlock(id, nodeId, toId, parentId, afterId),
  // The same place, with a link landing in it instead of the row itself (main/documents.js referenceIn).
  'block:insertMention': (_e, toId, uri, label, parentId, afterId) => referenceIn(toId, uri, label, parentId, afterId),
  'block:toggleCheckbox': (_e, id, nodeId) => mut(id, (doc) => { content.toggleCheckbox(doc, nodeId); }),
  'sensitive:list': () => sensitiveIds(), // the synced setting sensitive:set writes; db's table is only its migration source
  // "Discuss with …": one call for the type and the field, because both are the same decision (main/documents.js)
  'doc:discussWith': (_e, id, who) => discussWith(id, who),
  'doc:link': (_e, id) => webLink(id),
};

module.exports = { forgetOwners, webLink, newChat, sendChat, discard, announcedEdits, rememberEdit, actionSystems, isLiveRef, reliveRefs, followSummary, outlineWithReferences, resolveReferences, chatOutline, customCreation, creationOptions, taskTypes, workflowTypes, createDocument, typeChoices, typeCandidates, typeList, setType, setTypeHue, discussWith, setField, defineField, addTypeField, info, setSensitive, sensitiveIds, subscribe, invalidateDeleted, onChange, notifyState, setNotify, notifyDefault, notifyOn, notifyWatchedIds, notifySilencedIds, pruneSeen, agentIds, setAgentMark, lastAgentStatus, writeAgentStatus, agentStatus, creatorOf, document, op, historyIds, readOnDemand, releaseOnDemand, mut, mutTasks, moveBlock, referenceIn, documentAction, archivedTypes, history, linkShared, metaSig, accessContext, canWriteDoc, moveTarget, ipc };

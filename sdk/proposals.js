'use strict';
// AI proposals (issue #19): changes Tana's AI suggests from a chat and holds until someone accepts them. Read from
// Tana's shared bundle of 2026-09-23 (ProposalManager, the chat's proposal mutations, RootProposalsRoute). They are
// kept in two places:
//
//   graph  every chat node carries chat.proposals, the latest proposal per document: { proposedUri, baseUri?,
//          operation: create|update|delete, status: pending|approved|rejected, proposedAt, resolvedAt, kind }.
//          Tana's own Proposals page lists these; pending() reads them in one ListNodes call.
//   chat   data.messages[].proposals[]: { operation, proposedUri, baseUri?, proposedAt, approvedAt?, rejectedAt?,
//          metadata: { type?, ownerUri?, intents? } } (docs/CHATS.md §5). approve and reject write here.
//
// A create proposes a new document, which exists already with data.isProposal set. An update proposes a draft copy
// (proposedUri) of a real document (baseUri).
const { LoroMap, LoroList } = require('loro-crdt');
const { pushMessage } = require('./chat');

// metadata.type → the approver Tana routes a proposal to (its d_). Only 'regular' is plain documents.
const KINDS = { workspace: 'space', instructions: 'instructions', action: 'action' };
const kindOf = (type) => KINDS[type] || 'regular';
// The document a proposal is about: the real one for an update or delete, the new one for a create.
const subjectOf = (p) => ((p.operation === 'update' || p.operation === 'delete') && p.baseUri ? p.baseUri : p.proposedUri);
// Tana matches a proposal by uri and by whether it deletes, never across the two (its Sm).
const sameSide = (a, b) => (a === 'delete') === (b === 'delete');

// ListNodes chat nodes → pending proposals, newest first.
function pendingOf(chats) {
  const out = [];
  for (const chat of chats || []) {
    for (const p of (chat.chat && chat.chat.proposals) || []) {
      if (p.status !== 'pending' || typeof p.proposedUri !== 'string' || !['create', 'update', 'delete'].includes(p.operation)) continue;
      out.push({ chatUri: chat.id, chatTitle: chat.title || '', contextUri: chat.ownerUri || null, operation: p.operation, kind: kindOf(p.kind),
        proposedUri: p.proposedUri, baseUri: p.baseUri || null, subjectUri: subjectOf(p), proposedAt: Number(p.proposedAt) || 0 });
    }
  }
  return out.sort((a, b) => b.proposedAt - a.proposedAt);
}
// Every chat, owned ones and archived ones included, newest activity first.
// ponytail: one page of chats; a proposal in an older chat is not listed. Page on updateTime if that ever matters.
async function pending(graph, { limit = 500 } = {}) {
  const { nodes } = await graph.listNodes({ nodeTypes: ['chat'], includeOwnedChats: true, includeArchived: true, limit,
    sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] });
  return pendingOf(nodes);
}

// The chat's own entries: { list, index, map, p } for every proposal of every message.
function entries(chat) {
  const out = [], messages = chat.data.get('messages');
  if (!(messages instanceof LoroList)) return out;
  for (let i = 0; i < messages.length; i++) {
    const list = messages.get(i) instanceof LoroMap && messages.get(i).get('proposals');
    if (!(list instanceof LoroList)) continue;
    for (let j = 0; j < list.length; j++) if (list.get(j) instanceof LoroMap) out.push({ list, index: j, map: list.get(j), p: list.get(j).toJSON() });
  }
  return out;
}
// The newest still-pending entry for a uri (Tana's g_).
const open = (p) => !p.approvedAt && !p.rejectedAt;
const latest = (chat, uri) => entries(chat).filter((e) => e.p.proposedUri === uri && open(e.p)).sort((a, b) => b.p.proposedAt - a.p.proposedAt)[0];
const intentsOf = (p) => { try { const v = JSON.parse((p.metadata && p.metadata.intents) || '[]'); return Array.isArray(v) ? v : []; } catch { return [null]; } };
// The one intent Orbital runs, and only where it has nothing to do: reown-embedded-media copies every image, video,
// audio or file the document embeds from elsewhere into the document's own ownership (Tana's zwe). Nearly every AI
// proposal carries it; almost none embeds media.
const REOWN = 'reown-embedded-media';
const MEDIA = /^tana:(image|video|audio|asset):/;
// Tana's Nwe: a block anywhere in the outline whose attributes.tanaUri is media.
function embedsMedia(doc) {
  const walk = (list) => {
    for (let i = 0; list && typeof list.get === 'function' && i < list.length; i++) {
      const b = list.get(i);
      if (!(b instanceof LoroMap)) continue;
      const a = b.get('attributes');
      if ((a instanceof LoroMap && MEDIA.test(String(a.get('tanaUri') || ''))) || walk(b.get('children'))) return true;
    }
    return false;
  };
  return walk(doc.content.get('children'));
}

// Why Orbital cannot approve this one, or null when it can: Tana approves the rest itself. An update merges its draft
// into the real document and replays intents; the other kinds make spaces, rewrite instructions or run actions; and any
// other intent runs code on approval that only Tana has.
function refusal(p) {
  if (p.operation !== 'create') return 'Tana merges ' + (p.operation === 'update' ? 'a change' : 'a deletion') + ' itself: approve it in Tana';
  if (!['regular', 'action'].includes(kindOf(p.metadata && p.metadata.type))) return 'Approve this proposal in Tana';
  if (intentsOf(p).some((i) => !i || i.type !== REOWN)) return 'This proposal carries steps only Tana can run: approve it in Tana';
  return null;
}

// Approve a create proposal the way Tana does: stamp approvedAt on the chat's entries for it, take the document out of
// proposal (isProposal false, createdInUri the chat) with the attribution Tana fills in for a task, and say "accepted 1
// change" in the chat as the person who approved. Refused, because Tana would do more than that: a document that embeds
// media while its proposal asks for it to be re-owned, and a document whose type lives in another space, which Tana
// moves into that space on approval (its placement self-heal) — a move this SDK does not make.
// An action (metadata.type 'action', a tana:action: document) is run first: Tana's server carries it out in the systems
// it names (execute below, its startActionExecution), and only once it has taken the action on is the proposal approved
// here, as Tana's ActionProposal approver does (its R_: out of proposal, created in the chat). A refusal writes nothing.
async function approve(sync, { chatUri, proposedUri, byUri, execute }) {
  if (!/^tana:user-profile:/.test(byUri || '')) throw new Error('approve needs the approver\'s tana:user-profile: uri');
  const chat = await sync.subscribe(chatUri);
  const found = latest(chat, proposedUri);
  if (!found) throw new Error('This proposal is no longer pending');
  const why = refusal(found.p);
  if (why) throw new Error(why);
  const doc = await sync.subscribe(proposedUri);
  const action = kindOf(found.p.metadata && found.p.metadata.type) === 'action';
  if (action) {
    if (!execute) throw new Error('Approve this action in Tana');
    await execute({ chatUri, actionUri: proposedUri });
  }
  if (!action && intentsOf(found.p).length && embedsMedia(doc)) throw new Error('Tana copies the images in this document when approved: approve it in Tana');
  const typeUri = doc.data.get('entityTypeUri');
  if (typeUri && !action) {
    const home = (await sync.subscribe(typeUri)).data.get('ownerUri');
    if (home && home !== doc.data.get('ownerUri')) throw new Error('Tana moves this into its type\'s space when approved: approve it in Tana');
  }
  const at = Date.now();
  chat.transact(() => { for (const e of entries(chat)) if (e.p.proposedUri === proposedUri && open(e.p) && sameSide(e.p.operation, 'create')) e.map.set('approvedAt', at); });
  doc.transact((loro) => {
    const data = loro.getMap('data'), assigned = data.get('assignedToUris');
    if (assigned instanceof LoroList && assigned.length && !data.get('assignedToUrisChangedBy')) { data.set('assignedToUrisChangedBy', byUri); data.set('assignedToUrisChangedAt', at); }
    if (data.get('stateType') !== undefined && !data.get('stateChangedBy')) data.set('stateChangedBy', byUri);
    data.set('isProposal', false);
    data.set('createdInUri', chatUri);
  });
  chat.transact((loro) => accepted(loro, byUri, [proposedUri], at, action)); // an action's acceptance stays in the AI's context, as Tana keeps it
  return { uri: proposedUri };
}

// Run an action proposal on Tana's server: POST <POLARIS_SERVICE_API_AI_URL>/actions/execute, the web client's
// executeAction. It answers { success, executorChatUri } once it has taken the action on, or { success: false, error }
// (400, 403, 409) when it will not; the error is Tana's own sentence, thrown as it is.
async function executeAction({ chatUri, actionUri, getAccessToken, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  baseUrl = 'https://home.tana.inc/api/ai', fetch = globalThis.fetch }) {
  const body = JSON.stringify({ chatUri, actionUri, timezone });
  const post = async (refresh) => fetch(baseUrl + '/actions/execute', { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await getAccessToken({ refresh }) } });
  let r = await post(false);
  if (r.status === 401) r = await post(true);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(j.error === 'ai_cap_exceeded' ? 'You have reached your Tana AI limit' : j.error || j.message || 'Tana could not run this action: HTTP ' + r.status);
  return j;
}

// The status message Tana posts after an approval (addAcceptanceStatusMessage): a human message that is a status
// update, kept out of the AI's context, with the approved documents attached.
function accepted(loro, byUri, uris, at, inContext = false) {
  pushMessage(loro, { sentAt: at, fromUserUri: byUri, fromUserType: 'human', isStatusUpdate: true, excludeFromAIContext: !inContext }, 'accepted ' + uris.length + ' change' + (uris.length === 1 ? '' : 's'), uris);
}

// Reject any proposal the way Tana does: its entries leave the chat, and the document it proposed (the new one, or the
// draft copy of an update) is soft-deleted. A space proposal also takes the space an earlier failed approval may have
// made. Returns what could not be cleaned up, which does not undo the rejection.
async function reject(sync, { chatUri, proposedUri }) {
  const chat = await sync.subscribe(chatUri);
  const found = latest(chat, proposedUri);
  if (!found) throw new Error('This proposal is no longer pending');
  const { p } = found, warnings = [];
  chat.transact(() => {
    for (const e of entries(chat).reverse()) if (e.p.proposedUri === proposedUri && sameSide(e.p.operation, p.operation)) e.list.delete(e.index, 1);
  });
  const drop = async (uri) => { try { await sync.softDelete(uri); } catch (e) { warnings.push('Could not delete ' + uri + ': ' + e.message); } };
  if (p.operation === 'create' || p.operation === 'update') await drop(proposedUri);
  if (p.operation === 'create' && kindOf(p.metadata && p.metadata.type) === 'space') await drop('tana:space:' + proposedUri.split(':').pop());
  return { uri: proposedUri, warnings };
}

module.exports = { pending, pendingOf, approve, reject, refusal, entries, kindOf, subjectOf, executeAction };

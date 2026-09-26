'use strict';
// The Proposals page (issue #19) over sdk/proposals.js: what Tana's AI proposed and is waiting on someone to accept.
// Each row is the proposed document itself, the same row a view draws for it (graphRow), so it opens, expands and shows
// its task box, type and assignee as it will once accepted; row.proposal carries what approve and reject need and the
// grey line that says where it was proposed. Like Notifications the page is not a Tana document and has an id of its own.
const proposals = require('../sdk/proposals');
const { DOC_URI, NOT_CONNECTED, S, iso } = require('./state');
const { graphRow, toNode } = require('./rows');

const PAGE = 'orbital:proposals';
// Answered here, and still listed as pending by the graph until its index catches up (seconds): kept off the page
// until the graph agrees, so an approved row does not come back on the next read.
const answered = new Set();
const key = (p) => p.chatUri + ' ' + p.proposedUri;
const VERB = { create: 'Proposed', update: 'Change proposed', delete: 'Deletion proposed' };
// Why a row's Approve is off, when it is: the same refusals sdk/proposals.js makes, known here from the graph alone.
const WHY = {
  merge: ['approve in Tana', 'Tana merges this change itself: approve it in Tana'],
  kind: ['approve in Tana', 'Approve this proposal in Tana'],
  home: ['approve in Tana', 'Tana moves this into its type\'s space when approved: approve it in Tana'],
  gone: ['its document is gone', 'Its document is gone: reject it to clear it'],
};

// A meeting id scopes the same pending rows for that meeting's sidebar; no id lists the whole page.
async function rows(meetingId) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const all = await proposals.pending(S.client.graph);
  const live = new Set(all.map(key));
  for (const k of answered) if (!live.has(k)) answered.delete(k);
  const list = all.filter((p) => !answered.has(key(p)));
  // The documents themselves (a proposed one is only listed with includeProposals) and the meeting or space each chat
  // sits in, for a chat without a title of its own — which is every meeting chat.
  // ponytail: one lookup of up to 500 ids; batch it if a page ever holds more proposals than that
  const doc = (p) => (p.operation === 'delete' ? p.subjectUri : p.proposedUri);
  const lookup = async (ids) => (ids.length ? (await S.client.graph.listNodes({ nodeIds: ids, includeProposals: true, limit: ids.length })).nodes : []);
  const found = new Map((await lookup([...new Set(list.flatMap((p) => [doc(p), p.contextUri]).filter(Boolean))])).map((n) => [n.id, n]));
  // The group a row is filed under (issues #104, #107), by where its chat lives — the chat's owner, or a subagent
  // chat's parent's owner. Yours: a meeting you were in, or a chat owned by you or by nobody. Others': a meeting you
  // only see through its space, a chat a space owns, and another person's chat (a colleague's agent routine). "In it"
  // is what the Meetings view calls your own calendar — you among the event's participants — asked of the graph.
  // ponytail: a meeting shared with you directly, outside any space, also files under others
  const placeOf = (p) => { const c = p.contextUri; return (c && c.startsWith('tana:chat:') ? (found.get(c) || {}).ownerUri : c) || ''; };
  const meetingOf = (p) => { const up = placeOf(p); return up.startsWith('tana:event:') ? up : null; };
  const relevant = meetingId ? list.filter((p) => meetingOf(p) === meetingId) : list;
  // and the space each typed document's type keeps its documents in, which Tana moves the document into on approval
  const homes = new Map((await lookup([...new Set(relevant.map((p) => (found.get(doc(p)) || {}).entityType).filter(Boolean))])).map((t) => [t.id, t.ownerUri]));
  const meetings = [...new Set(relevant.map(meetingOf).filter(Boolean))];
  const mine = new Set(meetingId ? [meetingId] : meetings.length ? (await S.client.graph.listNodes({ nodeIds: meetings, hasParticipantUris: [S.me.userUri], limit: meetings.length })).nodes.map((n) => n.id) : []);
  const groupOf = (p) => {
    const up = placeOf(p);
    const yours = up.startsWith('tana:event:') ? mine.has(up) : !up.startsWith('tana:space:') && !(up.startsWith('tana:user-profile:') && up !== S.me.userUri);
    return yours ? 'mine' : 'others';
  };
  return relevant.map((p) => {
    const n = found.get(doc(p));
    const where = (p.chatTitle || (found.get(p.contextUri) || {}).title || '').trim() || 'a chat';
    const home = n && n.entityType && homes.get(n.entityType);
    // An intent that rules one out is only in the chat, and embedded media only in the document: approve itself refuses
    // those, with its reason. Everything else that would is known here.
    const why = !n ? WHY.gone : p.operation !== 'create' ? WHY.merge : p.kind !== 'regular' ? WHY.kind : home && home !== n.ownerUri ? WHY.home : null;
    const proposal = { chatUri: p.chatUri, proposedUri: p.proposedUri, operation: p.operation, approvable: !why, reason: why ? why[1] : null,
      group: groupOf(p),
      note: VERB[p.operation] + ' in ' + where + (why ? ' · ' + why[0] : ''), proposedAt: iso(p.proposedAt) };
    // A proposal whose document is gone (deleted, or never synced) can still be rejected, which clears it from the chat.
    if (!n) return { id: doc(p), title: 'Missing document', text: 'Missing document', kind: 'document', icon: 'doc', editable: false, hasChildren: false, proposal };
    // Read-only on the page, whoever may edit the document: Enter on an editable row drafts a sibling, and this page
    // has nowhere to put one. Opening the row is where it is edited.
    return { ...toNode(graphRow(n)), editable: false, proposal };
  });
}

// One answer: approve (create proposals only, sdk/proposals.js refuses the rest) or reject. Returns the warnings a
// rejection leaves (a draft that could not be deleted); a refusal throws, and the renderer shows it.
async function answer(chatUri, proposedUri, approve) {
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  if (!/^tana:chat:/.test(chatUri) || !DOC_URI.test(chatUri) || !DOC_URI.test(proposedUri)) throw new Error('Not a proposal');
  const args = { chatUri, proposedUri, byUri: S.me.userUri };
  const result = approve ? await proposals.approve(S.client.sync, args) : await proposals.reject(S.client.sync, args);
  answered.add(key({ chatUri, proposedUri }));
  return result.warnings || [];
}

// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table).
const ipc = {
  // its rows come through outline:children (main.js) too; this is the one write, approve or reject
  'proposals:answer': (_e, chatUri, proposedUri, approve) => answer(chatUri, proposedUri, !!approve),
};

module.exports = { PAGE, rows, answer, ipc };

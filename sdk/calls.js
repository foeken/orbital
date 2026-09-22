'use strict';
// Attendance on a meeting (docs/MEETINGS.md). An event node proves *invited* and *scheduled* and nothing more:
// calendarEvent.roster/attendees read the same an hour before a meeting as an hour after. Being *in* a meeting lives
// on the call document — `tana:call:` with the same ULID as its event and data.ownerUri pointing back at it — whose
// `sessions` root map holds one entry per live session and empties when the last participant leaves, while
// data.sessionLog keeps the join/leave history. Reading a call is read-only; nothing here writes.

// One subscribed call document, flattened. Sessions are oldest join first; a user may hold more than one (one per
// device or tab), which is why they are keyed `<user-profile uri>:<8 hex>` rather than by user.
// A key starting with `federation:` is another organization's capture of the same meeting, not somebody in the call:
// the web client leaves those out of activeParticipantUris (yl), and so does this.
function callSessions(doc) {
  const json = doc.toJSON();
  const data = json.data || {};
  const sessions = Object.entries(json.sessions || {})
    .filter(([key, s]) => !key.startsWith('federation:') && s && typeof s.userUri === 'string')
    .map(([key, s]) => ({ key, userUri: s.userUri, joinedAt: typeof s.joinedAt === 'number' ? s.joinedAt : null }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  const log = (Array.isArray(data.sessionLog) ? data.sessionLog : [])
    .filter((e) => e && typeof e.userUri === 'string' && (e.event === 'join' || e.event === 'leave'));
  return {
    eventUri: data.ownerUri || null,
    sessions,
    userUris: [...new Set(sessions.map((s) => s.userUri))],
    log,
    transcriptUri: data.transcriptUri || null,
    screenShareUri: data.screenShareUri || null,
  };
}

// In the call right now, and since when. joinedAt is null when the user is not in it (an empty `sessions` map is a
// call that ended, however long its sessionLog is).
const inCall = (doc, userUri) => callSessions(doc).sessions.some((s) => s.userUri === userUri);
function joinedAt(doc, userUri) {
  const times = callSessions(doc).sessions.filter((s) => s.userUri === userUri && s.joinedAt != null).map((s) => s.joinedAt);
  return times.length ? Math.min(...times) : null;
}

// Everyone who was ever in this call, from the log rather than from who is still there.
const attended = (doc) => [...new Set(callSessions(doc).log.filter((e) => e.event === 'join').map((e) => e.userUri))];

// The calls this user is in right now, newest-updated first, each with its meeting title.
// ponytail: a live call is touched constantly (joins, leaves, transcript pointers), so the few most recently updated
// call documents are the only candidates and scanning them is the whole search; if Tana ever exposes presence
// directly, replace the scan rather than widening the limit.
async function currentCalls(client, userUri, { limit = 5 } = {}) {
  const { nodes } = await client.graph.listNodes({
    nodeTypes: ['call'], limit,
    sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }],
  });
  const live = [];
  for (const n of nodes) {
    const held = !!client.sync.getDocument(n.id); // somebody else's live subscription is not this scan's to drop
    const doc = await client.sync.subscribe(n.id);
    // A candidate that turns out to be somebody else's call is let go again: this is a read, and the scan would
    // otherwise leave a subscription behind for every recently-touched call in the workspace. Only what this scan
    // opened is closed: unsubscribe has no reference count, so it would take a caller's document down with it.
    if (!inCall(doc, userUri)) { if (!held) await client.sync.unsubscribe(n.id).catch(() => {}); continue; }
    const call = callSessions(doc);
    live.push({
      callUri: n.id, eventUri: call.eventUri, title: null, joinedAt: joinedAt(doc, userUri),
      otherUserUris: call.userUris.filter((u) => u !== userUri),
      transcriptUri: call.transcriptUri, screenShareUri: call.screenShareUri,
    });
  }
  const uris = live.map((c) => c.eventUri).filter(Boolean);
  if (uris.length) { // one query for every title, not one per call
    const { nodes: events } = await client.graph.listNodes({ nodeIds: uris, limit: uris.length });
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const c of live) c.title = (byId.get(c.eventUri) || {}).title || null;
  }
  return live;
}

module.exports = { callSessions, inCall, joinedAt, attended, currentCalls };

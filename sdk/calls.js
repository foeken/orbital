'use strict';
// Attendance on a meeting (docs/MEETINGS.md). An event node proves *invited* and *scheduled* and nothing more:
// calendarEvent.roster/attendees read the same an hour before a meeting as an hour after. Being *in* a meeting lives
// on the call document — `tana:call:` with the same ULID as its event and data.ownerUri pointing back at it — whose
// `sessions` root map holds one entry per live session and empties when the last participant leaves, while
// data.sessionLog keeps the join/leave history. What else the call left behind (callState) and its transcript document
// (readTranscript) are read here too. Reading a call is read-only; nothing here writes.

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

// What a call left behind besides its attendance, in the shape of Tana's call schema (Vue in the bundle of 2026-09-23):
// recordings, presented documents, guests and reactions each have a root of their own, raised hands live in
// data.callParticipantState, the write-up is data.summaryUri with its progress in the wrapUp root, and
// data.transcriptionPaused is what Tana labels "Off the Record". The room secret beside them is never returned.
function callState(doc) {
  const json = doc.toJSON(), data = json.data || {};
  const records = (root, key, by = 'startedAt') => Object.values(json[root] || {})
    .filter((r) => r && typeof r[key] === 'string').sort((a, b) => (a[by] || 0) - (b[by] || 0));
  return {
    summaryUri: data.summaryUri || null,
    wrapUp: json.wrapUp || {},
    offTheRecord: !!data.transcriptionPaused,
    recordings: records('recordings', 'recordingId'), // status recording | processing | ready | failed; videoUri once ready
    presentations: records('documentPresentations', 'documentUri'), // endedAt is absent while it is on screen
    guests: Object.entries(json.guestProfiles || {}).filter(([, g]) => g && typeof g.displayName === 'string').map(([uri, g]) => ({ uri, ...g })),
    // in the order the hands went up: handRaiseSeq comes from the call's own counter, clocks can disagree
    raisedHands: Object.entries(data.callParticipantState || {}).filter(([, s]) => s && typeof s.handRaisedAt === 'number')
      .sort(([, a], [, b]) => (a.handRaiseSeq || 0) - (b.handRaiseSeq || 0)).map(([userUri, s]) => ({ userUri, handRaisedAt: s.handRaisedAt })),
    reactions: records('reactions', 'emoji', 'bucketStart'), // { emoji, senderUri, bucketStart, count }
  };
}

// A call's transcript (`tana:transcript:`, its data.transcriptUri; schema Aue in the bundle of 2026-09-23): data.segments
// in arrival order, data.summary, and the `sections` tree the wrap-up writes. Only those three are read, never the
// whole document: a transcript runs to hundreds of kilobytes. Segments come back as Tana's own `segments` getter gives
// them, the first of each id sorted by start_sec (live, 57 of 578 arrived out of order). A section is
// { title, recap?, recapTitle?, start_sec, end_sec, children } plus the label Tana shows (rLn): the recap's line, else
// recapTitle, else title. recap is stored as JSON { line, start, end } and parsed here; one that does not parse is left out.
const recapOf = (json) => { try { const r = JSON.parse(json); return r && typeof r.line === 'string' && r.line && typeof r.start === 'number' && typeof r.end === 'number' ? r : undefined; } catch { return undefined; } };
function readTranscript(doc) {
  const list = doc.data.get('segments'), seen = new Set();
  const segments = (list ? list.toJSON() : []).filter((s) => s && !seen.has(s.id) && seen.add(s.id)).sort((a, b) => a.start_sec - b.start_sec);
  const section = ({ meta: m = {}, children = [] }) => {
    const recap = recapOf(m.recap);
    return { ...m, recap, label: (recap && recap.line) || m.recapTitle || m.title, children: children.map(section) };
  };
  return { summary: doc.data.get('summary') || '', segments, sections: doc.loro.getTree('sections').toJSON().map(section) };
}

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

module.exports = { callSessions, inCall, joinedAt, attended, callState, readTranscript, currentCalls };

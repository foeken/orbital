'use strict';
// The Timeline page (issue #135): tasks pinned through today, then what happened to the nodes you watch and what landed in
// your Inbox — the same two things the banners announce (main/documents.js notifyWatched, main/views.js
// announceNewInbox), read back from Tana rather than kept here. Nothing is stored but the time of the last visit, and the
// edits a banner announced that Tana wrote no summary for (main/documents.js announcedEdits, #536): the
// page is rebuilt on every arrival, which measured 0.2 s for 53 watched nodes (ListChanges, twelve at a time), so it
// holds what happened before this page existed and while the app was closed, and reads the same on every machine.
// Like Notifications the page is not a Tana document and has an id of its own.
//   watched: a written change summary (the sidebar's Changes, sdk/history.js) somebody other than you had a hand in,
//            or an edit a banner told of that no summary from around then covers ("Someone edited …")
//   inbox:   a task assigned to you that someone else, an MCP client or Tana's AI created (state.js inboxFrom)
//   agent:   a task an MCP client or Tana's AI moved to another state (from the chat it did so in, see below)
//   meeting: a meeting you are in that has started, at its start time (all-day ones mark a day, not a moment)
// A row is one event, not a node: a node changed three times is three rows, so a row's id is its own and the node it
// is about rides along in row.timeline.uri, which is what opening it goes to.
// The page reads as a timeline (renderer/timeline.js, styles.css .tl-*): a time, a marker on a rail, and what happened.
// What happened comes first, because that is the news: an edit's line is Tana's sentence about the change, with who
// and which node small under it; a status move is its verb and the node ("Completed: ~~Plan the offsite~~"), who
// under it. The latest move comes from the node's own state (type, enteredAt, changedBy — exact, and there before
// Tana has written a word about it), older ones from summaries that say which state they went to. New Inbox tasks
// matter less than both, so a run of them from one source on one day is one quiet row with the tasks listed under it
// ("An AI agent added 3 tasks to your Inbox"), each a task row of its own that opens as one. The tasks you added
// yourself for yourself are one such row too ("You added 2 tasks"), never marked new; the ones you added for someone
// else stay out, since only tasks assigned to you are listed as added (#649).
const db = require('../db');
const { STATE_TYPES } = require('../sdk/node');
const { pinnedDates, todayNode } = require('./pins');
const { NOT_CONNECTED, S, handedAt, inboxFrom, iso, isMcp, send } = require('./state');
const { isAllDay } = require('../sdk/dates');
const { graphRow, hm, members, rememberNodeHue, toNode } = require('./rows');
const { announcedEdits, document, notifySilencedIds, notifyWatchedIds } = require('./documents');
const { readOutline } = require('../sdk/content');
const { openLiveQuery } = require('../sdk/livequery');
const { callState, callSessions } = require('../sdk/calls');

const PAGE = 'orbital:timeline';
// Inbox to In Progress is a task being taken on, so it reads as accepted, the way Tana's own box accepts it first
const VERB = { closed: 'completed', open: 'accepted', not_now: 'moved to Later', proposed: 'moved back to Inbox' };
// The marker a row gets on the rail (styles.css .tl-*), each a 20px circle: finished a green one with a white check,
// an edit a grey one with a white pen, the other moves Nucleo's grey solid circles (icons.js tl*), and a new task a
// light dotted ring
const ICON = { closed: 'apply', open: 'tlAccepted', not_now: 'tlLater', proposed: 'tlInbox' };
// A meeting's marker: its calendar, or a route between two pins when its title starts with Travel (travel time blocked
// in the calendar, not a meeting with anyone)
const meetingIcon = (title) => (/^travel/i.test(String(title || '').trim()) ? 'pinRoute' : 'meeting');
const TONE = { closed: 'done', open: 'accepted', not_now: 'quiet', proposed: 'quiet' };
// The state a status summary went to, in the words Tana's AI uses for it ("Task status changed from In Progress to
// Inbox", "Task marked as completed and a note added …"); null for any other summary.
// ponytail: reads English wording; the latest move per node does not depend on it (the node's state does)
function statusOf(text) {
  const t = text.toLowerCase();
  const to = /\bto (completed|done|in progress|inbox|later)\b/.exec(t);
  const word = to ? to[1] : /\b(completed|marked (as )?(done|complete))\b/.test(t) ? 'completed' : null;
  return word && { completed: 'closed', done: 'closed', 'in progress': 'open', inbox: 'proposed', later: 'not_now' }[word];
}
// A status summary's own words, when they say more than the move ("Task completed and assessment details added")
const beyondStatus = (text) => (/ and /i.test(text) ? text : null);
// What an edit put there, in Tana's longer words ("Nadia proposed extending Healthcare's Christmas activities, such as
// karaoke and games, across Nedap …"): the summary's description, when it says more than its title
const detailOf = (s, headline) => { const d = typeof s.description === 'string' ? s.description.trim() : ''; return d && d !== headline ? d : null; };
const andList = (xs) => (xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs.at(-1) : xs[0]);
// Three days a page: the Timeline opens on today and the two days before it, and scrolling to its end reaches three
// days further back (renderer/timeline.js), which sets pages here and reads the page again. What is asked of Tana grows
// with it, so the older days have something to show: more summaries per watched node, more of your newest tasks.
// ponytail: every older page is a full re-read of all the pages before it; fetch only the new days if that gets slow.
const AT_ONCE = 12;
const DAYS = 3, MAX_PAGES = 120;
let pages = 1;
const setPages = (n) => (pages = Math.max(1, Math.min(MAX_PAGES, Math.floor(Number(n)) || 1)));
// whole local days: today and the ones before it, so the oldest section on the page is never half a day
// (by the calendar, not in 24-hour steps: a day across a clock change is 23 or 25 hours)
const sinceOf = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (DAYS * pages - 1)); return d.getTime(); };
let markFrom = null; // the last visit, as read when this one began: an older page keeps the same new marks
// A summary's title only repeating the node's says nothing (followSummary makes the same call): its description then.
function said(s, title) {
  const own = (title || '').trim().toLowerCase();
  const repeats = (t) => !!own && (own.includes(t.toLowerCase()) || t.toLowerCase().includes(own));
  return [s.title, s.description].map((t) => (typeof t === 'string' ? t.trim() : '')).find((t) => t && !repeats(t)) || null;
}
async function pool(list, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, list.length) }, async () => { while (i < list.length) { const x = list[i++]; out.push(await fn(x)); } }));
  return out;
}
// The meetings on the page stay current (#210): a live query over the meetings it lists, to the end of today, and a
// meeting added or gone, renamed or moved, re-reads the page (renderer/app.js). Nothing else about a meeting is news
// here, and Tana touches events often (a reply, a synced calendar), so only what the page shows of one counts.
// Opened by a read, and again when the client, the pages or the day change; a refusal leaves the page as it was.
let live = null, liveClient = null, liveKey = null;
// The next upcoming meeting's start: the page is read again just after it, so the meeting leaves Upcoming meetings for
// the timeline on its own. One timer, set by every read (the read it causes sets the one after it).
let startTimer = null;
// the tagline and summary too: a summary landing is heard, and the entry brightens
const meetingSig = (row) => { const ev = row.calendarEvent || {}; return JSON.stringify([row.title, ev.startTime, ev.endTime, ev.allDay, ev.tagline, ev.summary, attendeesOf(ev).map((a) => [a.displayName, a.email, a.role, a.cutype, a.identityUri])]); }; // all meetingNote and meetingPeople read of them
// Who is on a meeting, as the graph gives it: the roster (calendarEvent.roster), or the calendar's own attendee list
const attendeesOf = (ev) => (Array.isArray(ev.roster) && ev.roster.length ? ev.roster : Array.isArray(ev.attendees) ? ev.attendees : []).filter((a) => a && typeof a === 'object');
const duration = (ms) => { const m = Math.round(ms / 6e4), h = Math.floor(m / 60); return m < 60 ? m + ' min' : h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); };
// A meeting's grey line: how long it is (or, for one still to come, when: "14:00–15:00"), then who else is on it
// (rooms and you left out), four names and an ellipsis
function meetingNote(ev, when = false) {
  const start = Date.parse(ev.startTime || ''), end = Date.parse(ev.endTime || '');
  return !(end > start) ? null : when ? hm(new Date(start)) + '–' + hm(new Date(end)) : duration(end - start);
}
// Who else is in it, drawn as faces after the time (renderer/views.js subtextEl, the bubbles Visible to uses): you,
// rooms and other resources left out. uri keys a person's grey and demo name; name is the calendar's, a member or not.
function meetingPeople(ev, me, myEmail) {
  const seen = new Set();
  return attendeesOf(ev).filter((a) => a.role !== 'resource' && !['room', 'resource'].includes(a.cutype) && a.identityUri !== me && !(myEmail && String(a.email || '').toLowerCase() === myEmail))
    .map((a) => ({ uri: a.identityUri || String(a.email || '').toLowerCase(), name: a.displayName || String(a.email || '').split('@')[0] }))
    .filter((p) => p.name && !seen.has(p.name) && seen.add(p.name));
}
function watchMeetings(me, since) {
  const end = new Date(); end.setHours(24, 0, 0, 0);
  const key = [me, pages, end.getTime()].join(' ');
  if (live && liveClient === S.client && liveKey === key) return;
  if (live) live.then((h) => h && h.close().catch(() => {}));
  liveClient = S.client; liveKey = key;
  const sigs = new Map(); // uri -> what the page shows of it
  const onRows = ({ added, removed, changed, initial }) => {
    const moved = !initial && (added.length > 0 || removed.some((uri) => sigs.has(uri)) || changed.some((row) => sigs.get(row.uri) !== meetingSig(row)));
    for (const row of [...added, ...changed]) sigs.set(row.uri, meetingSig(row));
    for (const uri of removed) sigs.delete(uri);
    if (moved) send('outline:changed', PAGE);
  };
  const opened = live = openLiveQuery(S.client.sync, { types: ['event'], hasParticipantUris: [me], eventStartTimeMin: since, eventStartTimeMax: end.getTime(), orderBy: ['-updatedAt'], limit: 200 },
    { label: 'Orbital timeline meetings', onRows }).then((h) => { h.on('error', () => { if (live === opened) live = null; }); return h; }, () => { if (live === opened) live = null; return null; }); // refused, now or later: the next read asks again
}
// Recording: a meeting under way whose call is on the record now gets a pulsing marker (renderer/render.js, styles.css
// .tl-recording): somebody is in the call and it is being transcribed (not paused off the record), or a video recording
// runs (Tana's activeRecording: an entry in the call's recordings root with status 'recording'). A Tana Meet call is
// transcribed without a video recording, so the recordings root alone never lit a real meeting (live 2026-09-28: two
// transcribed calls, 750 and 353 segments, recordings empty). The call is the tana:call: document the meeting owns, and it only exists once somebody joins, so a
// live query over the calls these meetings own says when one appears; each is kept live, and a recording starting or
// stopping reads the page again. Set by every read, like the meetings' query; the same meetings keep what is open.
const recording = new Set(); // event uris whose call records now
const heldCalls = new Map(); // call uri -> { event, ours }; ours: subscribed here, so let go here
let callQ = null, callKey = null, callClient = null;
function checkCall(uri) {
  const c = heldCalls.get(uri), doc = c && S.client.sync.getDocument(uri);
  if (!doc) return;
  const state = callState(doc), on = state.recordings.some((r) => r.status === 'recording') || (callSessions(doc).sessions.length > 0 && !state.offTheRecord);
  if (on === recording.has(c.event)) return;
  if (on) recording.add(c.event); else recording.delete(c.event);
  send('outline:changed', PAGE);
}
function watchCalls(events) {
  const client = S.client, key = events.join(' ');
  if (callClient === client && callKey === key) return;
  if (callClient !== client) { // a new connection has none of the old one's documents
    heldCalls.clear(); recording.clear(); callQ = null; callClient = client;
    client.sync.on('change', (id) => { if (S.client === client && heldCalls.has(id)) checkCall(id); });
  }
  callKey = key;
  if (callQ) callQ.then((h) => h && h.close().catch(() => {}));
  callQ = null;
  for (const [uri, c] of heldCalls) if (!events.includes(c.event)) { heldCalls.delete(uri); recording.delete(c.event); if (c.ours) client.sync.unsubscribe(uri).catch(() => {}); }
  if (!events.length) return;
  const onRows = ({ added, changed }) => {
    for (const row of [...added, ...changed]) {
      if (heldCalls.has(row.uri) || !events.includes(row.ownerUri)) continue;
      heldCalls.set(row.uri, { event: row.ownerUri, ours: !client.sync.getDocument(row.uri) }); // somebody else's subscription is not ours to drop
      client.sync.subscribe(row.uri).then(() => checkCall(row.uri), () => heldCalls.delete(row.uri));
    }
  };
  const opened = callQ = openLiveQuery(client.sync, { types: ['call'], ownerUris: events, limit: 50 }, { label: 'Orbital timeline calls', onRows })
    .then((h) => { h.on('error', () => { if (callQ === opened) callKey = null; }); return h; }, () => { if (callQ === opened) callKey = null; return null; }); // refused: the next read asks again
}

// The page is five reads that do not wait on each other — what happened to the nodes you watch, what agents moved,
// what landed in your Inbox, your meetings, today's pins — so they run side by side, and the page asking is shown what
// can be drawn top down without anything landing between rows already there (progress, timeline:part; pageOf); the
// answer is the whole page. At a launch
// Tana is answering a thousand other reads, each hop takes a second rather than 40 ms, and one after another they
// kept the page empty for five (live 2026-09-26).
async function rows(progress) {
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  const me = S.me.userUri, since = sinceOf(), graph = S.client.graph;
  const namesP = members().catch(() => []).then((list) => new Map(list.map((m) => [m.id, m.title])));
  const whoOf = (names) => (uris) => andList(uris.map((a) => names.get(a) || 'Someone'));
  const myEmail = String((S.me.user && S.me.user.email) || '').toLowerCase();
  // What is new is what came after your last visit, which this visit then becomes. The first visit marks nothing.
  // Read now, for the marks on the parts; moved on only once the whole page is read, so a failed read loses no marks.
  const fresh = pages === 1 || markFrom === null, seen = fresh ? Number(db.setting('timelineSeen')) || Infinity : markFrom;
  const now = Date.now(), date = new Date(now).toLocaleDateString('sv-SE');
  // Watched: what the watch rule follows (made by you, not assigned to you; closed ones too, since finishing one is
  // news) and what you switched on, less what you switched off. Titles come with the rule's own answer.
  async function watched() {
    const silenced = notifySilencedIds();
    const [names, { nodes: made }] = await Promise.all([namesP, graph.listNodes({ nodeTypes: ['text'], createdBy: [me], stateTypes: ['proposed', 'open', 'closed', 'not_now'], limit: 200,
      sortOptions: [{ field: 'SORT_FIELD_CREATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] })]); // newest first: the ones added in the window are among them
    const who = whoOf(names), events = [];
    const nodes = new Map(made.filter((n) => !(n.assignedTo || []).includes(me)).map((n) => [n.id, n]));
    const chosen = [...notifyWatchedIds()].filter((id) => !nodes.has(id));
    if (chosen.length) for (const n of (await graph.listNodes({ nodeIds: chosen, limit: chosen.length })).nodes) nodes.set(n.id, n);
    for (const id of silenced) nodes.delete(id);
    // a node nobody has touched since the window opened has nothing in it to tell, so its history is not asked for:
    // that is most of them on a short window, and one ListChanges each was most of the page's time
    await pool([...nodes.values()].filter((n) => !n.updateTime || Date.parse(n.updateTime) > since), async (n) => {
      const st = n.state || {}, moved = Date.parse(st.enteredAt || '');
      const latest = st.changedBy && st.changedBy !== me && moved > since && VERB[st.type] ? { state: st.type, at: moved } : null;
      if (latest) events.push({ kind: 'status', uri: n.id, title: n.title, at: moved, actor: who([st.changedBy]), verb: VERB[st.type], icon: ICON[st.type], tone: TONE[st.type] });
      let summaries = [];
      try { summaries = (await S.client.history.listChanges({ uri: n.id, limit: Math.min(50, 10 * pages) })).summaries || []; } catch { return; } // one refusal costs that node only
      for (const s of summaries) {
        const at = Date.parse(s.endTime || s.startTime || ''), others = (s.authors || []).filter((a) => a !== me);
        const text = said(s, n.title);
        if (!(at > since) || !others.length || !text) continue; // yours alone is not news, as with a banner
        const state = statusOf(text);
        if (state && latest && latest.state === state && Math.abs(latest.at - at) < 15 * 6e4) continue; // the same move, already told from the node
        events.push(state
          ? { kind: 'status', uri: n.id, title: n.title, at, actor: who(others), verb: VERB[state], icon: ICON[state], tone: TONE[state], note: beyondStatus(text) }
          : { kind: 'edit', uri: n.id, title: n.title, at, actor: who(others), icon: 'updated', tone: 'edit', change: text, detail: detailOf(s, text) });
      }
    });
    // ...and the edits a banner announced that no summary of that node from around then stands in for (#536): Tana writes
    // none for many edits, or only much later. Nobody but this machine knows who made one, so it says Someone.
    const quiet = new Set(silenced);
    for (const e of announcedEdits()) {
      if (!(e.at > since) || quiet.has(e.id) || events.some((x) => x.uri === e.id && Math.abs(x.at - e.at) < 30 * 6e4)) continue;
      events.push({ kind: 'edit', uri: e.id, title: nodes.get(e.id)?.title || e.title, at: e.at, actor: 'Someone', icon: 'updated', tone: 'edit', change: null });
    }
    return events;
  }
  // Agents: an MCP client writes with your login, so the moves it makes read as yours above (state.changedBy, the
  // summary's authors). The chat it wrote from gives it away: each change is an update proposal there, approved as it
  // is made (chat.proposals, the field the Proposals page reads; live 2026-09-26: proposedAt 1 ms after the task's
  // state.enteredAt). A task whose latest move is yours and came with such a proposal was the agent's. A refusal costs
  // these rows only. Asked past Hide MCP (main/views.js listFilter): that switch hides MCP chats from lists, which are
  // the very agents looked for here.
  async function agents() {
    const silenced = notifySilencedIds(), events = [];
    const { nodes: agentChats = [] } = await (graph.listNodesUnhidden || ((p) => graph.listNodes(p)))({ nodeTypes: ['chat'], includeOwnedChats: true, limit: Math.min(1000, 200 * pages),
      sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] }).catch(() => ({}));
    const proposed = new Map(); // task -> [[proposedAt, chat]]
    for (const c of agentChats) for (const p of (c.chat && c.chat.proposals) || []) {
      if (p.operation === 'update' && p.status === 'approved' && p.baseUri && !silenced.has(p.baseUri) && Number(p.proposedAt) > since) proposed.set(p.baseUri, [...(proposed.get(p.baseUri) || []), [Number(p.proposedAt), c]]);
    }
    const agentIds = [...proposed.keys()];
    const { nodes: agentMoved = [] } = agentIds.length ? await graph.listNodes({ nodeIds: agentIds, nodeTypes: ['text'], stateTypes: STATE_TYPES, limit: agentIds.length }).catch(() => ({})) : {};
    for (const n of agentMoved) {
      const st = n.state || {}, at = Date.parse(st.enteredAt || '');
      const hit = st.changedBy === me && at > since && VERB[st.type] && (proposed.get(n.id) || []).find(([t]) => Math.abs(t - at) < 6e4);
      if (hit) events.push({ kind: 'status', uri: n.id, title: n.title, at, actor: isMcp(hit[1]) ? 'An AI agent' : "Tana's AI", verb: VERB[st.type], icon: ICON[st.type], tone: TONE[st.type] });
    }
    return events;
  }
  // Inbox: the newest tasks assigned to you, whatever state they are in now, and the chat each was created in. Each is
  // dated when it reached you: made then, or handed to you as a task later by someone else (state.js handedAt), so a
  // draft written yesterday and given to you today is today's line. Read by last change, so such a task is in the read.
  async function inbox() {
    const [names, { nodes: tasks }] = await Promise.all([namesP, graph.listNodes({ nodeTypes: ['text'], assignedTo: [me], sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }], limit: Math.min(1000, 100 * pages) })]);
    const who = whoOf(names), events = [];
    const reached = (n) => Math.max(Date.parse(n.createTime || '') || 0, handedAt(n, me));
    const recent = tasks.filter((n) => reached(n) > since);
    const mine = recent.filter((n) => !n.createdBy || n.createdBy === me).map((n) => n.id);
    const createdIn = new Map(mine.length ? ((await graph.listEdges({ fromNodeIds: mine, edgeTypes: ['EDGE_TYPE_CREATED_IN'] }).catch(() => ({}))).edges || []).map((e) => [e.fromNodeId, e.toNodeId]) : []);
    const chatIds = [...new Set(createdIn.values())];
    const chats = new Map(chatIds.length ? (await graph.listNodes({ nodeIds: chatIds, nodeTypes: ['chat'], includeOwnedChats: true, limit: chatIds.length })).nodes.map((c) => [c.id, c]) : []);
    for (const n of recent) {
      const chat = createdIn.has(n.id) ? chats.get(createdIn.get(n.id)) || {} : null;
      const byHand = !inboxFrom(me, n.createdBy, chat, names); // yours, by hand: "You added a task"
      // who put it there: the person, or for a chat the kind of writer (an MCP client is somebody's agent)
      const actor = byHand ? 'You' : n.createdBy && n.createdBy !== me ? who([n.createdBy]) : isMcp(chat) ? 'An AI agent' : "Tana's AI";
      // the marker says who: a robot for an agent, Tana's prism for Tana's own AI, a dotted ring for a person
      const icon = actor === 'An AI agent' ? 'robot' : actor === "Tana's AI" ? 'tana' : 'tlNew';
      events.push({ kind: 'inbox', uri: n.id, title: n.title, at: reached(n), actor, icon, tone: 'new', node: n });
    }
    return events;
  }
  // Meetings: the ones you are in that started in the window, up to now, each opening the meeting (which forwards to
  // its write-up, renderer/edit.js followSummary), and the rest of today's for the Upcoming meetings block. One ask to
  // the end of today; a refusal costs the meetings only.
  async function meetingsPart() {
    const endOfToday = new Date(); endOfToday.setHours(24, 0, 0, 0);
    const { nodes: meetings = [] } = await graph.listNodes({ nodeTypes: ['event'], hasParticipantUris: [me], eventStartTimeMin: new Date(since).toISOString(), eventStartTimeMax: endOfToday.toISOString(),
      sortOptions: [{ field: 'SORT_FIELD_EVENT_START_TIME', direction: 'SORT_DIRECTION_DESCENDING' }], limit: Math.min(1000, 100 * pages) }).catch(() => ({}));
    const shown = meetings.filter((n) => { const ev = n.calendarEvent || {}, at = Date.parse(ev.startTime || ''); return at >= since && at <= Date.now() && !isAllDay(ev.startTime, ev.endTime, ev.allDay); });
    // A meeting that is over and left no summary is drawn quiet, like a new-task line; one with a summary, or still
    // going, as it is. The summary is Tana's own, on the event: calendarEvent.tagline and .summary, written when the
    // write-up is. Not the write-up document itself: that can be moved into a space, and then the meeting no longer
    // owns it (live 2026-09-26, "Datadog & Nedap - executive alignment").
    const events = shown.map((n) => {
      const ev = n.calendarEvent || {}, going = Date.parse(ev.endTime || '') > Date.now(), bare = !going && !String(ev.tagline || ev.summary || '').trim();
      // still under way: joined from Tana (row.join, the meeting's id: renderer/timeline.js opens it there)
      return { kind: 'meeting', uri: n.id, title: n.title, at: Date.parse(ev.startTime), icon: meetingIcon(n.title), tone: bare ? 'faint' : 'meeting', note: meetingNote(ev), people: meetingPeople(ev, me, myEmail),
        join: going ? n.id : undefined, end: going ? Date.parse(ev.endTime) : undefined, recording: going && recording.has(n.id) };
    });
    // Upcoming meetings: today's still to start, earliest first, under Today's Tasks as a block of their own. Each opens
    // the meeting; its grey line says when and who (renderer/views.js subtextOf, node.subtext). No meetings, no block.
    const upcoming = meetings.filter((n) => { const ev = n.calendarEvent || {}; return Date.parse(ev.startTime || '') > Date.now() && !isAllDay(ev.startTime, ev.endTime, ev.allDay); })
      .sort((a, b) => Date.parse(a.calendarEvent.startTime) - Date.parse(b.calendarEvent.startTime))
      .map((n) => ({ id: n.id, text: n.title || 'Untitled', title: n.title || 'Untitled', kind: 'document', icon: meetingIcon(n.title), editable: false, hasChildren: false, start: n.calendarEvent.startTime, join: n.id,
        subtext: meetingNote(n.calendarEvent, true), people: meetingPeople(n.calendarEvent, me, myEmail) }));
    return { events, upcoming };
  }
  // Today's Tasks: the tasks pinned through today, then the ones on today's node (main/pins.js todayNode, found and
  // never made here): whatever its outline references, a full reference (Tana's embed block, or a line that is one
  // mention, as Add to Today writes it) or a mention among words. Reading it keeps it live, so a change to it reads the
  // page again (renderer/app.js). Completed tasks age out after their pinned day; a pin for today, or a place on
  // today's node, still keeps them here. A task you are waiting on (main/settings.js stateName) is not today's to do,
  // so it stays out until it is set back to In Progress.
  async function today() {
    const [pinDates, day] = await Promise.all([pinnedDates(), todayNode(0, true).catch(() => null)]);
    const pinDatesById = new Map(Object.entries(pinDates));
    const pinnedIds = [...pinDatesById].filter(([, dates]) => dates.some((pinnedDate) => pinnedDate <= date)).map(([id]) => id);
    const refs = (rows) => rows.flatMap((n) => [n.reference && n.reference.uri, ...(n.segments || []).map((s) => s.mention && s.mention.uri), ...refs(n.children || [])]);
    const onDay = new Set((day ? await document(day).then((doc) => refs(readOutline(doc)), () => []) : []).filter((id) => /^tana:text:/.test(id || ''))); // the listNodes below keeps the tasks
    const ids = [...new Set([...pinnedIds, ...onDay])];
    const { nodes: pinned = [] } = ids.length ? await graph.listNodes({ nodeIds: ids, nodeTypes: ['text'], stateTypes: STATE_TYPES, limit: ids.length }) : {};
    const byId = new Map(pinned.map((n) => [n.id, n]));
    const rows = ids.map((id) => byId.get(id)).filter(Boolean).map((n) => {
      rememberNodeHue(n); // graphRow drops participants, so seed the verified editability before toNode builds the row
      const row = toNode(graphRow(n));
      if (row.stateType === 'waiting') return null;
      return row.done && !onDay.has(n.id) && !pinDatesById.get(n.id).includes(date) ? null : { ...row, editable: false, checkable: row.editable !== false }; // unknown (null) ticks, as a log row's box and every other row does; Tana refuses what it refuses (#545)
    }).filter(Boolean);
    return { rows, day };
  }
  const got = {};
  const page = () => pageOf(got, seen, now, date);
  // shown: rows the page asking has been sent, so a part that adds none sends nothing; failed: one read refused, the
  // answer is that refusal, and what the others bring after it is not sent as though the page were on its way
  let shown = 0, failed = false;
  await Promise.all([['watched', watched], ['agents', agents], ['inbox', inbox], ['meetings', meetingsPart], ['today', today]].map(([k, read]) => read().then((v) => {
    got[k] = v;
    const p = page();
    if (progress && !failed && p.length > shown) { shown = p.length; progress(p); }
  }, (e) => { failed = true; throw e; })));
  if (fresh) { markFrom = seen; db.setSetting('timelineSeen', now); }
  watchMeetings(me, since);
  watchCalls(got.meetings.events.filter((e) => e.end).map((e) => e.uri));
  // The page is read again at the next moment a meeting moves: one starting (out of Upcoming meetings, into the timeline)
  // or one under way ending (its Join button goes, and without a summary it turns quiet). The read it causes sets the next.
  clearTimeout(startTimer);
  const next = Math.min(...got.meetings.upcoming.map((m) => Date.parse(m.start)), ...got.meetings.events.filter((e) => e.end).map((e) => e.end));
  if (next < Infinity) startTimer = setTimeout(() => send('outline:changed', PAGE), next - Date.now() + 1000); // a second in, so it has happened
  return page();
}
// The page from the parts in so far, in two steps so nothing lands between rows already drawn: Today's Tasks and
// Upcoming meetings once both are read, then every event newest first once all four sources of them are. The events
// interleave by time, so any one source alone would drop rows between the others' as they came in.
function pageOf(got, seen, now, date) {
  const top = !!(got.today && got.meetings), all = top && !!(got.watched && got.agents && got.inbox);
  const upcoming = top ? got.meetings.upcoming : [];
  // Free time: from now (or the end of the meeting under way) to the next meeting's start, between Today's Tasks and
  // Upcoming meetings. The renderer counts it down (renderer/timeline.js timelineFreeSegs); none when they touch or overlap.
  const until = upcoming.length ? Date.parse(upcoming[0].start) : 0;
  const from = Math.max(now, ...(top ? got.meetings.events : []).filter((e) => e.end).map((e) => e.end));
  const freeRow = until > from ? [{ id: PAGE + ':free', text: 'Free', segments: [{ text: 'Free' }], kind: 'block', block: 'bullet', icon: 'free', editable: false, hasChildren: false, children: [],
    createdAt: iso(now), unread: false, timeline: { uri: null, time: '', tone: 'new', free: { from, until } } }] : [];
  const upcomingText = 'Upcoming meetings';
  const upcomingRow = upcoming.length ? [{ id: PAGE + ':upcoming', text: upcomingText, segments: [{ text: upcomingText }], kind: 'block', block: 'bullet', icon: 'meeting',
    editable: false, hasChildren: true, children: upcoming, createdAt: iso(now), unread: false, timeline: { uri: null, time: '', tone: 'new', upcoming: true } }] : []; // no time of its own: it sits under Today's Now
  const todayText = "Today's Tasks";
  const todayRow = top ? [{ id: PAGE + ':today:' + date, text: todayText, segments: [{ text: todayText }], kind: 'block', block: 'bullet', icon: 'todayTasks',
    editable: false, hasChildren: true, children: got.today.rows, createdAt: iso(now), unread: false, timeline: { uri: null, time: 'Now', tone: 'new', today: true, day: got.today.day } }] : []; // day: a change to today's node reads the page again (renderer/app.js)
  const events = all ? [...got.watched, ...got.agents, ...got.inbox, ...got.meetings.events] : [];
  // New tasks in a row from one source on one day are one entry, timed by the newest of them
  const day = (at) => new Date(at).toDateString();
  const merged = [];
  for (const e of events.sort((a, b) => b.at - a.at)) {
    const last = merged.at(-1);
    if (e.kind === 'inbox' && last && last.kind === 'inbox' && last.actor === e.actor && day(last.at) === day(e.at)) last.tasks.push(e);
    else merged.push(e.kind === 'inbox' ? { ...e, tasks: [e] } : e);
  }
  return [...todayRow, ...freeRow, ...upcomingRow, ...merged.map((e) => {
    const title = (e.title || '').trim() || 'Untitled'; // a calendar's titles can end in a space ("Kick-off | My Nedap Pilot "), which pushed the Join glyph out
    let segments, note = null, change = null, detail = null, children = [];
    // who, in plain text, then what they did in bold, then the node: "Kevin Favier **completed** ~~Plan the offsite~~".
    // An edit's what-changed rides in the quote under it: Tana's line for it, then its longer words.
    // person/content: the words demo mode masks in this row of the app's own; the rest is the app's wording (renderer/segments.js)
    const person = !/^(An AI agent|Tana's AI|Someone|You)$/.test(e.actor);
    const who = { text: e.actor + ' ', ...(person ? { person } : {}) }, what = (verb) => ({ text: verb, marks: { bold: true } });
    if (e.kind === 'edit') { segments = [who, what('edited'), { text: ' ' }, { text: title, content: true }]; change = e.change; detail = e.detail || null; }
    else if (e.kind === 'status') { segments = [who, what(e.verb), { text: ' ' }, { text: title, content: true, marks: e.tone === 'done' ? { strike: true } : {} }]; note = e.note || null; }
    else if (e.kind === 'meeting') { segments = [{ text: title, content: true }]; note = e.note; } // the meeting's name is what happened, how long and who under it
    else {
      const n = e.tasks.length;
      // yours: added, not put in your Inbox (a task made by hand is usually In Progress already, or someone else's)
      segments = [{ ...who, text: e.actor }, { text: ' added ' + (n === 1 ? 'a task' : n + ' tasks') + (e.actor === 'You' ? '' : ' to your Inbox') }];
      // each a task row, opening as one: its words read-only here, its box ticking the task where you may tick it anywhere
      children = e.tasks.map((t) => { const row = toNode(graphRow(t.node)); return { ...row, editable: false, checkable: row.editable !== false }; });
    }
    return { id: PAGE + ':' + e.kind + ':' + e.uri + ':' + e.at, text: segments.map((x) => x.text).join(''), segments,
      kind: 'block', block: 'bullet', icon: e.icon, editable: false, hasChildren: children.length > 0, children,
      createdAt: iso(e.at), unread: e.kind !== 'meeting' && e.actor !== 'You' && (e.tasks || [e]).some((t) => t.at > seen), // a meeting is on your calendar, and what you added yourself is no news either
      // an "added to your Inbox" line opens nothing: the rows under it open themselves, one task or six
      join: e.join, people: e.people, timeline: { uri: e.kind === 'inbox' ? null : e.uri, note, change, detail, tone: e.tone, recording: e.recording || undefined } };
  })];
}

// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table).
const ipc = {
  'timeline:pages': (_e, n) => setPages(n), // how many pages of three days back the Timeline reads
};

// One build at a time for every pane and window that asks (#579): each change to a task under Today's Tasks, each pane
// showing the Timeline and each meeting starting asked for a build of its own, a ListEdges and a dozen reads each. A
// request made while one runs is answered by the next build, started when that one ends and shared by all who asked
// meanwhile, so it still sees whatever moved; only the first asker's page hears the parts as they come (progress).
let building = null, rebuild = null;
function sharedRows(progress) {
  if (!building) { building = rows(progress).finally(() => { building = null; }); return building; }
  rebuild ||= building.catch(() => {}).then(() => { rebuild = null; return sharedRows(); });
  return rebuild;
}

module.exports = { PAGE, rows: sharedRows, said, statusOf, setPages, ipc };

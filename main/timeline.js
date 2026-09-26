'use strict';
// The Timeline page (issue #135): tasks pinned through today, then what happened to the nodes you watch and what landed in
// your Inbox — the same two things the banners announce (main/documents.js notifyWatched, main/views.js
// announceNewInbox), read back from Tana rather than kept here. Nothing is stored but the time of the last visit: the
// page is rebuilt on every arrival, which measured 0.2 s for 53 watched nodes (ListChanges, twelve at a time), so it
// holds what happened before this page existed and while the app was closed, and reads the same on every machine.
// Like Notifications the page is not a Tana document and has an id of its own.
//   watched: a written change summary (the sidebar's Changes, sdk/history.js) somebody other than you had a hand in
//   inbox:   a task assigned to you that someone else, an MCP client or Tana's AI created (views.js inboxFrom)
//   meeting: a meeting you are in that has started, at its start time (all-day ones mark a day, not a moment)
// A row is one event, not a node: a node changed three times is three rows, so a row's id is its own and the node it
// is about rides along in row.timeline.uri, which is what opening it goes to.
// The page reads as a timeline (renderer/timeline.js, styles.css .tl-*): a time, a marker on a rail, and what happened.
// What happened comes first, because that is the news: an edit's line is Tana's sentence about the change, with who
// and which node small under it; a status move is its verb and the node ("Completed: ~~Plan the offsite~~"), who
// under it. The latest move comes from the node's own state (type, enteredAt, changedBy — exact, and there before
// Tana has written a word about it), older ones from summaries that say which state they went to. New Inbox tasks
// matter less than both, so a run of them from one source on one day is one quiet row with the tasks listed under it
// ("An AI agent added 3 tasks to your Inbox"), each a task row of its own that opens as one.
const db = require('../db');
const { STATE_TYPES } = require('../sdk/node');
const { pinnedDates } = require('./pins');
const { NOT_CONNECTED, S, iso, isMcp } = require('./state');
const { graphRow, isAllDay, members, rememberNodeHue, toNode } = require('./rows');
const { notifySilencedIds, notifyWatchedIds } = require('./documents');
const { inboxFrom } = require('./views');

const PAGE = 'orbital:timeline';
// Inbox to In Progress is a task being taken on, so it reads as accepted, the way Tana's own box accepts it first
const VERB = { closed: 'completed', open: 'accepted', not_now: 'moved to Later', proposed: 'moved back to Inbox' };
// The marker a row gets on the rail (styles.css .tl-*), each a 20px circle: finished a green one with a white check,
// an edit a grey one with a white pen, the other moves Nucleo's grey solid circles (icons.js tl*), and a new task a
// light dotted ring
const ICON = { closed: 'apply', open: 'tlAccepted', not_now: 'tlLater', proposed: 'tlInbox' };
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
// A week a page: the Timeline opens on the last seven days and reaches one week further back per click on its button
// (renderer/timeline.js), which sets weeks here and reads the page again. What is asked of Tana grows with it, so the
// older weeks have something to show: more summaries per watched node, more of your newest tasks.
// ponytail: every older week is a full re-read of all the weeks before it (about half a second a read); fetch only the
// new week if anyone ever pages far back.
const AT_ONCE = 12;
let weeks = 1;
const setWeeks = (n) => (weeks = Math.max(1, Math.min(52, Math.floor(Number(n)) || 1)));
let markFrom = null; // the last visit, as read when this one began: an older week keeps the same new marks
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

async function rows() {
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  const me = S.me.userUri, since = Date.now() - weeks * 7 * 864e5, graph = S.client.graph;
  const names = new Map((await members().catch(() => [])).map((m) => [m.id, m.title]));
  // Watched: what the watch rule follows (made by you, not assigned to you; closed ones too, since finishing one is
  // news) and what you switched on, less what you switched off. Titles come with the rule's own answer.
  const silenced = notifySilencedIds();
  const { nodes: made } = await graph.listNodes({ nodeTypes: ['text'], createdBy: [me], stateTypes: ['proposed', 'open', 'closed', 'not_now'], limit: 200 });
  const nodes = new Map(made.filter((n) => !(n.assignedTo || []).includes(me)).map((n) => [n.id, n]));
  const chosen = [...notifyWatchedIds()].filter((id) => !nodes.has(id));
  if (chosen.length) for (const n of (await graph.listNodes({ nodeIds: chosen, limit: chosen.length })).nodes) nodes.set(n.id, n);
  for (const id of silenced) nodes.delete(id);
  const events = [];
  const who = (uris) => andList(uris.map((a) => names.get(a) || 'Someone'));
  await pool([...nodes.values()], async (n) => {
    const st = n.state || {}, moved = Date.parse(st.enteredAt || '');
    const latest = st.changedBy && st.changedBy !== me && moved > since && VERB[st.type] ? { state: st.type, at: moved } : null;
    if (latest) events.push({ kind: 'status', uri: n.id, title: n.title, at: moved, actor: who([st.changedBy]), verb: VERB[st.type], icon: ICON[st.type], tone: TONE[st.type] });
    let summaries = [];
    try { summaries = (await S.client.history.listChanges({ uri: n.id, limit: Math.min(50, 10 * weeks) })).summaries || []; } catch { return; } // one refusal costs that node only
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
  // Inbox: the newest tasks assigned to you, whatever state they are in now, and the chat each was created in
  const { nodes: tasks } = await graph.listNodes({ nodeTypes: ['text'], assignedTo: [me], sortOptions: [{ field: 'SORT_FIELD_CREATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }], limit: Math.min(500, 50 * weeks) });
  const recent = tasks.filter((n) => Date.parse(n.createTime || '') > since);
  const mine = recent.filter((n) => !n.createdBy || n.createdBy === me).map((n) => n.id);
  const createdIn = new Map(mine.length ? ((await graph.listEdges({ fromNodeIds: mine, edgeTypes: ['EDGE_TYPE_CREATED_IN'] }).catch(() => ({}))).edges || []).map((e) => [e.fromNodeId, e.toNodeId]) : []);
  const chatIds = [...new Set(createdIn.values())];
  const chats = new Map(chatIds.length ? (await graph.listNodes({ nodeIds: chatIds, nodeTypes: ['chat'], includeOwnedChats: true, limit: chatIds.length })).nodes.map((c) => [c.id, c]) : []);
  for (const n of recent) {
    const chat = createdIn.has(n.id) ? chats.get(createdIn.get(n.id)) || {} : null;
    if (!inboxFrom(me, n.createdBy, chat, names)) continue; // yours, by hand
    // who put it there: the person, or for a chat the kind of writer (an MCP client is somebody's agent)
    const actor = n.createdBy && n.createdBy !== me ? who([n.createdBy]) : isMcp(chat) ? 'An AI agent' : "Tana's AI";
    // the marker says who: a robot for an agent, Tana's prism for Tana's own AI, a dotted ring for a person
    const icon = actor === 'An AI agent' ? 'robot' : actor === "Tana's AI" ? 'tana' : 'tlNew';
    events.push({ kind: 'inbox', uri: n.id, title: n.title, at: Date.parse(n.createTime), actor, icon, tone: 'new', node: n });
  }
  // Meetings: the ones you are in that started in the window, up to now, each opening the meeting (which forwards to
  // its write-up, renderer/edit.js followSummary). A refusal costs the meetings only.
  const { nodes: meetings = [] } = await graph.listNodes({ nodeTypes: ['event'], hasParticipantUris: [me], eventStartTimeMin: new Date(since).toISOString(), eventStartTimeMax: new Date().toISOString(),
    sortOptions: [{ field: 'SORT_FIELD_EVENT_START_TIME', direction: 'SORT_DIRECTION_DESCENDING' }], limit: Math.min(500, 50 * weeks) }).catch(() => ({}));
  for (const n of meetings) {
    const ev = n.calendarEvent || {}, at = Date.parse(ev.startTime || '');
    if (at > since && at <= Date.now() && !isAllDay(ev.startTime, ev.endTime, ev.allDay)) events.push({ kind: 'meeting', uri: n.id, title: n.title, at, icon: 'meeting', tone: 'meeting' });
  }
  const now = Date.now(), date = new Date(now).toLocaleDateString('sv-SE');
  const pinDatesById = new Map(Object.entries(await pinnedDates()));
  const pinnedIds = [...pinDatesById].filter(([, dates]) => dates.some((pinnedDate) => pinnedDate <= date)).map(([id]) => id);
  const { nodes: pinned = [] } = pinnedIds.length ? await graph.listNodes({ nodeIds: pinnedIds, nodeTypes: ['text'], stateTypes: STATE_TYPES, limit: pinnedIds.length }) : {};
  const byId = new Map(pinned.map((n) => [n.id, n]));
  // Completed tasks age out after their pinned day; a pin for today still keeps them here.
  const children = pinnedIds.map((id) => byId.get(id)).filter(Boolean).map((n) => {
    rememberNodeHue(n); // graphRow drops participants, so seed the verified editability before toNode builds the row
    const row = toNode(graphRow(n));
    return row.done && !pinDatesById.get(n.id).includes(date) ? null : { ...row, editable: false, checkable: row.editable === true };
  }).filter(Boolean);
  const todayText = "Today's Tasks";
  const todayRow = { id: PAGE + ':today:' + date, text: todayText, segments: [{ text: todayText }], kind: 'block', block: 'bullet', icon: 'todayTasks',
    editable: false, hasChildren: true, children, createdAt: iso(now), unread: false, timeline: { uri: null, time: 'Now', tone: 'new', today: true } };
  // What is new is what came after your last visit, which this visit then becomes. The first visit marks nothing.
  if (weeks === 1 || markFrom === null) { markFrom = Number(db.setting('timelineSeen')) || Infinity; db.setSetting('timelineSeen', Date.now()); }
  const seen = markFrom;
  // New tasks in a row from one source on one day are one entry, timed by the newest of them
  const day = (at) => new Date(at).toDateString();
  const merged = [];
  for (const e of events.sort((a, b) => b.at - a.at)) {
    const last = merged.at(-1);
    if (e.kind === 'inbox' && last && last.kind === 'inbox' && last.actor === e.actor && day(last.at) === day(e.at)) last.tasks.push(e);
    else merged.push(e.kind === 'inbox' ? { ...e, tasks: [e] } : e);
  }
  return [todayRow, ...merged.map((e) => {
    const title = e.title || 'Untitled';
    let segments, note = null, change = null, detail = null, children = [];
    // who, in plain text, then what they did in bold, then the node: "Kevin Favier **completed** ~~Plan the offsite~~".
    // An edit's what-changed rides in the quote under it: Tana's line for it, then its longer words.
    // person/content: the words demo mode masks in this row of the app's own; the rest is the app's wording (renderer/segments.js)
    const person = !/^(An AI agent|Tana's AI)$/.test(e.actor);
    const who = { text: e.actor + ' ', ...(person ? { person } : {}) }, what = (verb) => ({ text: verb, marks: { bold: true } });
    if (e.kind === 'edit') { segments = [who, what('edited'), { text: ' ' }, { text: title, content: true }]; change = e.change; detail = e.detail || null; }
    else if (e.kind === 'status') { segments = [who, what(e.verb), { text: ' ' }, { text: title, content: true, marks: e.tone === 'done' ? { strike: true } : {} }]; note = e.note || null; }
    else if (e.kind === 'meeting') segments = [{ text: title, content: true }]; // the meeting's name is what happened
    else {
      const n = e.tasks.length;
      segments = [{ ...who, text: e.actor }, { text: ' added ' + (n === 1 ? 'a task' : n + ' tasks') + ' to your Inbox' }];
      // each a task row, opening as one: its words read-only here, its box ticking the task where you may tick it anywhere
      children = e.tasks.map((t) => { const row = toNode(graphRow(t.node)); return { ...row, editable: false, checkable: row.editable !== false }; });
    }
    return { id: PAGE + ':' + e.kind + ':' + e.uri + ':' + e.at, text: segments.map((x) => x.text).join(''), segments,
      kind: 'block', block: 'bullet', icon: e.icon, editable: false, hasChildren: children.length > 0, children,
      createdAt: iso(e.at), unread: e.kind !== 'meeting' && (e.tasks || [e]).some((t) => t.at > seen), // a meeting is on your calendar: not news
      // an "added to your Inbox" line opens nothing: the rows under it open themselves, one task or six
      timeline: { uri: e.kind === 'inbox' ? null : e.uri, note, change, detail, tone: e.tone } };
  })];
}

module.exports = { PAGE, rows, said, statusOf, setWeeks };

'use strict';
// The phone engine's own logic that no other check covers (ios/engine/stand-ins.js): the synchronous sha256 the page
// uses in place of node:crypto, which names Tana's agent (sdk/chat.js deterministicId), against Node's own, across the
// padding edges (55, 56 and 64 bytes) and a multi-block input; and createHash's hex and byte digests.
const assert = require('node:assert');
const crypto = require('node:crypto');
const standIns = require('../ios/engine/stand-ins.js');

for (const text of ['', 'abc', 'system:tana', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'é'.repeat(300)]) {
  const want = crypto.createHash('sha256').update(text).digest('hex');
  assert.strictEqual(Buffer.from(standIns.sha256(new TextEncoder().encode(text))).toString('hex'), want, 'sha256 of ' + text.length + ' chars');
  assert.strictEqual(standIns.createHash('sha256').update(text.slice(0, 7)).update(text.slice(7)).digest('hex'), want, 'createHash in two parts');
}
assert.deepStrictEqual([...standIns.createHash('sha256').update('abc').digest()], [...crypto.createHash('sha256').update('abc').digest()]);
assert.throws(() => standIns.createHash('sha1'), /not on the phone/);

// A saved search's rows in the desktop's order and sections (ios/engine/arrange.js): Responsibility as My Tasks has it,
// Status in workflow order, newest first, and a row you are no part of left out.
{
  const { arrange } = require('../ios/engine/arrange.js');
  const me = 'tana:user-profile:me', other = 'tana:user-profile:sam', now = Date.now(), t = (h) => new Date(now - h * 36e5).toISOString(); // one now: b and d share a time, kept in query order
  const rows = [
    { id: 'a', title: 'B task', state: 'open', updated: t(5), created: t(9), createdBy: me, assignees: [me] },
    { id: 'b', title: 'A task', state: 'proposed', updated: t(1), created: t(2), createdBy: other, assignees: [me] },
    { id: 'c', title: 'Handed over', state: 'open', updated: t(3), created: t(3), createdBy: me, assignees: [other] },
    { id: 'd', title: 'Theirs', state: 'open', updated: t(2), created: t(2), createdBy: other, assignees: [other] },
    { id: 'e', title: 'Pinned one', state: 'open', updated: t(8), created: t(8), createdBy: me, assignees: [me] },
    { id: 'f', title: 'Waiting on Sam', state: 'waiting', updated: t(7), created: t(7), createdBy: me, assignees: [me] },
  ];
  const c = { me, now, names: new Map([[other, 'Sam']]), agent: new Set(['d']), pinned: new Set(['e']), watched: new Set(), silenced: new Set() };
  const shown = (view) => arrange(rows, view, c).map(({ n, group }) => (group ? group + ':' : '') + n.id).join(' ');
  assert.strictEqual(shown({ groupBy: 'responsibility', sortBy: '-updated' }), 'Pinned:e Agent:d Mine:a Waiting:f Tracking:c Assigned by others:b', 'Pinned first, then a Codex task whoever has it, and Waiting after Mine');
  assert.strictEqual(shown({ groupBy: 'status', sortBy: 'title' }), 'Inbox:b In Progress:a In Progress:c In Progress:e In Progress:d Waiting:f');
  assert.strictEqual(shown({ sortBy: '-created' }), 'b d c f e a');
  assert.strictEqual(shown({ groupBy: 'assignee' }), 'Sam:c Sam:d Someone:a Someone:b Someone:e Someone:f', 'named by the member list, unknown as Someone');
  assert.strictEqual(shown({}), 'a b c d e f', 'no sort: the query order');
  assert.strictEqual(arrange([{ ...rows[5], id: 'g' }], { groupBy: 'responsibility' }, { ...c, pinned: new Set(['g']) })[0].group, 'Waiting', 'one you are waiting on leaves Pinned for Waiting');
}

// What the phone holds subscribed (ios/engine/held.js): a page's documents, the newest KEEP; one only looked at (the
// menu reading every saved search's query) let go of once read, and never in a page's place, which had stopped the
// changes to the page on screen; one held meanwhile, and one held for something else (the Timeline's), left alone
{
  const { createHeld, KEEP } = require('../ios/engine/held.js');
  const docs = new Map();
  const sync = { getDocument: (id) => docs.get(id), subscribe: async (id) => { if (!docs.has(id)) docs.set(id, { id }); return docs.get(id); }, unsubscribe: async (id) => { docs.delete(id); } };
  const held = createHeld(() => sync, (_, p) => p);
  (async () => {
    docs.set('tana:text:timeline', { id: 'tana:text:timeline' });
    await held.hold('tana:chat:open');
    for (let i = 0; i < KEEP + 3; i++) assert.strictEqual(await held.peek('tana:search:' + i, (d) => d.id), 'tana:search:' + i);
    await new Promise((r) => setImmediate(r));
    assert.ok(docs.has('tana:chat:open'), 'the menu reading every saved search leaves the page on screen subscribed');
    assert.ok(![...docs.keys()].some((id) => id.startsWith('tana:search:')), 'and lets each search go once read');
    let answer;
    sync.subscribe = (id) => { if (!docs.has(id)) docs.set(id, { id }); return new Promise((r) => { answer = () => r(docs.get(id)); }); };
    const peeked = held.peek('tana:type:t', (d) => d.id), opened = held.hold('tana:type:t');
    answer(); await peeked; await opened; await new Promise((r) => setImmediate(r));
    assert.ok(docs.has('tana:type:t'), 'opened while a peek read it: it stays');
    sync.subscribe = async (id) => { if (!docs.has(id)) docs.set(id, { id }); return docs.get(id); };
    for (let i = 0; i < KEEP + 1; i++) await held.hold('tana:text:' + i);
    await new Promise((r) => setImmediate(r));
    assert.ok(!docs.has('tana:chat:open') && docs.has('tana:text:timeline'), 'past KEEP pages the oldest goes; the Timeline\u2019s never');
  })().catch((e) => { console.error(e); process.exit(1); });
}

// A meeting's page finds your notes by the desktop's own rule (sdk/events.js notesOurs, shared with main/meeting-notes.js):
// yours, owned by the meeting or by nothing, a document, not a task, not archived
{
  const { notesOurs } = require('../sdk/events.js');
  const me = 'tana:user-profile:me', ev = 'tana:event:01aaaaaaaaaaaaaaaaaaaaaaaa', n = { id: 'tana:text:01aaaaaaaaaaaaaaaaaaaaaaaa', createdBy: me, ownerUri: ev };
  assert.deepStrictEqual([n, { ...n, ownerUri: undefined }, { ...n, ownerUri: 'tana:space:x' }, { ...n, createdBy: 'tana:user-profile:sam' }, { ...n, state: { type: 'open' } }, { ...n, archivedAt: 1 }, { ...n, id: 'tana:chat:01aaaaaaaaaaaaaaaaaaaaaaaa' }]
    .map((x) => notesOurs(x, me, ev)), [true, true, false, false, false, false, false]);
  assert.strictEqual(notesOurs(undefined, me, ev), undefined, 'no row yet');
}

// Every list on the phone keeps your hidden titles and Hide MCP out, as the Mac's lists do (ios/engine/listed.js,
// main/views.js listFilter): Block and Lunch never reached the phone's Upcoming meetings before. A lookup by id still
// answers, and listNodesUnhidden is the graph untouched.
{
  const { listFilter } = require('../ios/engine/listed.js');
  const all = [
    { id: 'tana:event:1', title: 'Block' }, { id: 'tana:event:2', title: 'Block (focus)' }, { id: 'tana:event:3', title: 'lunch' },
    { id: 'tana:event:4', title: 'Planning' }, { id: 'tana:chat:5', title: 'MCP: export' }, { id: 'tana:text:6', title: 'Orbital settings' },
    { id: 'tana:text:7', title: 'Gone', deletedAt: 1 },
  ];
  const store = { hiddenTitles: ['Block*', 'Lunch'], hideMcp: true };
  const settings = { get: (k) => store[k], appDocIds: () => ['tana:text:6'] };
  const graph = { listNodes: async (params) => ({ nodes: params.nodeIds ? all.filter((n) => params.nodeIds.includes(n.id)) : all }) };
  listFilter(graph, settings);
  (async () => {
    const ids = (r) => r.nodes.map((n) => n.id).join(' ');
    assert.strictEqual(ids(await graph.listNodes({ nodeTypes: ['event'] })), 'tana:event:4', 'hidden titles, MCP chats, the settings document and deleted nodes stay out of a list');
    assert.strictEqual(ids(await graph.listNodes({ nodeIds: ['tana:event:1', 'tana:text:6'] })), 'tana:event:1 tana:text:6', 'a lookup by id answers past the rules');
    store.hideMcp = false; store.hiddenTitles = [];
    assert.strictEqual(ids(await graph.listNodes({ nodeTypes: ['event'] })), 'tana:event:1 tana:event:2 tana:event:3 tana:event:4 tana:chat:5', 'read on every list: a rule taken out shows them again');
    assert.strictEqual((await graph.listNodesUnhidden({})).nodes.length, all.length, 'listNodesUnhidden is the graph untouched');
  })().catch((e) => { console.error(e); process.exit(1); });
}

// The phone's Timeline reads a task in the workspace's Waiting workflow as waiting too (stand-ins graphRow, main/settings.js
// stateName), which is what keeps it out of Today's Tasks there (main/timeline.js)
{
  const { S } = require('../main/state'), was = S.me;
  S.me = { userUri: 'tana:user-profile:me', orgDocUri: 'tana:org:01aaaaaaaaaaaaaaaaaaaaaaaa' };
  const waiting = 'tana:workflow:' + require('../sdk/chat').deterministicId('orbital:waiting:' + S.me.orgDocUri);
  assert.deepStrictEqual([waiting, 'tana:workflow:other', undefined].map((workflowUri) => standIns.graphRow({ id: 'x', state: { type: 'open', workflowUri } }).stateType), ['waiting', 'open', 'open']);
  S.me = was;
}

// Demo mode (ios/engine/demo.js) masks as the desktop does, with its words: a node's title and an attendee one for one,
// the same each time; the app's own wording in a Timeline row and a saved search's title kept; off, nothing changes
{
  const { demo, demoOn, demoTitle } = require('../ios/engine/demo.js');
  const rows = [
    { id: 'tana:text:a', title: 'Salary review 2026', people: [{ name: 'Kor Odinga' }] },
    { id: 'orbital:timeline:1', segments: [{ text: 'Kor Odinga', person: true }, { text: ' completed ' }, { text: 'Budget', content: true }] },
    { id: 'tana:search:s', title: 'My Tasks' },
  ];
  assert.deepStrictEqual(demo(rows), rows, 'off: as it came');
  demoOn(true);
  const [a, t, q] = demo(rows);
  assert.notStrictEqual(a.title, rows[0].title);
  assert.match(a.title, /^[A-Z][a-z]+ [a-z]+ 2026$/, 'one word for one, the capital and the number kept');
  assert.deepStrictEqual(demo(rows)[0], a, 'the same each time');
  assert.notStrictEqual(a.people[0].name, 'Kor Odinga');
  assert.strictEqual(t.segments[1].text, ' completed ', "the app's own words kept");
  assert.notStrictEqual(t.segments[0].text, 'Kor Odinga');
  assert.notStrictEqual(t.segments[2].text, 'Budget');
  assert.strictEqual(q.title, 'My Tasks', "a saved search's title is the app's");
  assert.notStrictEqual(demoTitle('Salary review', 'tana:text:a'), 'Salary review');
  // Tana's words about a change are masked; a meeting's length is the app's own and stays (renderer/views.js subtextOf)
  const [done, meeting] = demo([{ id: 'e1', timeline: { uri: 'tana:text:a', tone: 'done', note: 'Moved the budget review to Friday' } },
    { id: 'e2', timeline: { uri: 'tana:event:m', tone: 'meeting', note: '45 min' } }]);
  assert.notStrictEqual(done.timeline.note, 'Moved the budget review to Friday', "a status entry's note is masked");
  assert.strictEqual(meeting.timeline.note, '45 min', "a meeting's length stays");
  demoOn(false);
}

// The names Settings gives the models (main/prompts.js modelLabel, which both phones read from the engine) are the
// Mac's: renderer/settings.js keeps a classic script's copy, held to it here
{
  const { modelLabel } = require('../main/prompts');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../renderer/settings.js'), 'utf8');
  const aiModelLabel = new Function(src.match(/^const aiModelLabel = .*$/m)[0] + '\nreturn aiModelLabel;')();
  for (const id of ['gpt-6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-oss-120b']) assert.strictEqual(modelLabel(id), aiModelLabel(id), id);
}

// What is sensitive is marked to be drawn blurred (ios/engine/sensitive.js): the node itself, an entry about it, a task
// under another entry, a row that mentions, links to or refers to it, nested rows; nothing else
{
  const { mark } = require('../ios/engine/sensitive.js');
  const S = 'tana:text:secret', rows = mark([
    { id: S, title: 'Salary review' },
    { id: 'e1', timeline: { uri: S }, segments: [{ text: 'Sam edited Salary review' }] },
    { id: 'e2', timeline: { uri: 'tana:text:open' }, children: [{ id: S }, { id: 'tana:text:ok' }] },
    { id: 'b1', segments: [{ text: 'See ' }, { mention: { uri: S, label: 'Salary review' } }] },
    { id: 'b2', segments: [{ text: 'Salary review', marks: { link: S } }] },
    { id: 'm0.a0', type: 'reference', reference: { uri: S } },
    { id: 'p', children: [{ id: 'q', children: [{ id: S }] }] },
    { id: 'plain', segments: [{ text: 'Book the venue' }] },
  ], new Set([S]));
  assert.deepStrictEqual(rows.map((r) => !!r.sensitive), [true, true, false, true, true, true, false, false]);
  assert.deepStrictEqual(rows[2].children.map((c) => !!c.sensitive), [true, false], 'only the sensitive task under an entry');
  assert.strictEqual(rows[6].children[0].children[0].sensitive, true, 'nested rows too');
  assert.strictEqual(rows[0].title, 'Salary review', 'the words stay: the phone blurs them');
}

// The words for a Timeline row's times (ios/engine/labels.js) are the desktop's own: renderer/timeline.js timelineTime,
// dayKey and timelineDay, sliced out of its source and run beside them. An entry gets its time, its day and that day in
// words; the blocks above the days keep main/timeline.js's 'Now' and ''; a meeting to come with no end is timed by its start.
{
  const labels = require('../ios/engine/labels.js');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../renderer/timeline.js'), 'utf8');
  const slice = (re) => { const m = src.match(re); assert.ok(m, 'renderer/timeline.js still has ' + re); return m[0]; };
  // isoDay given to the slices, so renderer/timeline.js dayKey may be written with it (renderer/segments.js)
  const { isoDay } = require('../renderer/segments.js');
  const desktop = new Function('isoDay', [slice(/^const dayKey = .*$/m), slice(/^function timelineDay\(key\) \{[\s\S]*?\n\}/m), slice(/^const timelineTime = .*$/m),
    'return { dayKey, timelineDay, timelineTime };'].join('\n'))(isoDay);
  const week = Date.now() - 5 * 864e5;
  for (const at of ['2026-10-02T07:05:00Z', '2026-10-02T21:59:00.000Z', new Date(week).toISOString()]) {
    assert.strictEqual(labels.time(at), desktop.timelineTime(at), 'the time of ' + at);
    assert.strictEqual(labels.dayKey(at), desktop.dayKey(at), 'the day of ' + at);
  }
  const old = desktop.dayKey(new Date(week).toISOString());
  assert.strictEqual(labels.dayTitle(old), desktop.timelineDay(old), 'a day before yesterday in the desktop\u2019s words');
  const at = new Date(week).toISOString(), start = new Date(Date.now() + 36e5).toISOString();
  const [today, free, upcoming, entry] = labels.times([
    { id: 't', createdAt: at, timeline: { time: 'Now', today: true } },
    { id: 'f', createdAt: at, timeline: { time: '', free: { from: 0, until: 1 } } },
    { id: 'u', createdAt: at, timeline: { time: '', upcoming: true }, children: [{ id: 'm1', start, subtext: '13:10–13:40' }, { id: 'm2', start, subtext: null }] },
    { id: 'e', createdAt: at, timeline: { uri: 'tana:text:a', tone: 'edit' } },
  ]);
  assert.deepStrictEqual([today.timeline, free.timeline], [{ time: 'Now', today: true }, { time: '', free: { from: 0, until: 1 } }], 'the blocks above the days as they came');
  assert.deepStrictEqual(upcoming.children.map((m) => m.subtext), ['13:10–13:40', desktop.timelineTime(start)], 'a meeting with no end timed by its start');
  assert.deepStrictEqual(entry.timeline, { uri: 'tana:text:a', tone: 'edit', time: desktop.timelineTime(at), day: old, dayTitle: desktop.timelineDay(old) });
}

// The bundle itself, built with Bun: built as the Xcode phase builds it, then run in a vm
// made to look like the session page, with a fake Tana that signs in and answers every call empty. It must say ready,
// connect with a bearer token, and answer the Timeline in the desktop's row shape. Its 8 s give-ups (stand-ins.js within)
// are made immediate, since this fake never opens the sync stream. CI installs Bun; locally it is skipped without it.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const bun = [path.join(os.homedir(), '.bun/bin/bun'), 'bun'].find((b) => spawnSync(b, ['--version']).status === 0);
(async () => {
  // Your Dot from the phone (ios/engine/agents.js): linked with a code as the Mac links it, the key and the agent kept in
  // the synced settings, and a node handed over as the Mac hands it (main/agents/linked.js send): its one last line
  // "Agent status: Assigned", then the event with the node, the request and Orbital's own instructions, then the mark and
  // the link the Mac's badge reads. An event the Dot does not take puts back what an earlier Codex handoff wrote and keeps
  // its mark; a blank request or a read-only node writes nothing; Unassign takes the line and the mark out.
  {
    require('../db').open(':memory:');
    const { S } = require('../main/state'), settings = require('../main/settings'), mcpServer = require('../main/mcp-server');
    const { Document } = require('../sdk/document'), { initDocument, contentText, ulid } = require('../sdk/node'), content = require('../sdk/content');
    const { agents, agentOf } = require('../ios/engine/agents.js');
    const was = { me: S.me, client: S.client, readOnly: S.settingsReadOnly }, ME = 'tana:user-profile:me', AGENT = '0b6f1c3e-5d2a-4c8e-9f10-2a3b4c5d6e7f', ID = 'relay:' + AGENT;
    S.me = { userUri: ME, orgId: 'org' };
    S.settingsReadOnly = true; // the phone's: nothing here finds or makes a settings document, the mirror is enough
    S.client = { sync: { flushed: async () => {}, getDocument: () => null }, graph: { listNodes: async () => ({ nodes: [] }) } };
    let answer = { subscribers: 1, delivered: 1 };
    let unlinked = false;
    const sent = [], json = (o) => new Response(JSON.stringify(o));
    mcpServer.server.fetch = async (url, init = {}) => {
      const p = url.slice(mcpServer.server.base.length);
      assert.match(new Headers(init.headers).get('authorization'), /^Orbital [\w-]{43}$/, 'every call carries your Orbital\'s key');
      if (p === '/orbital/codes') return json({ code: 'ABCD-1234', expiresAt: Date.now() + 9e5 });
      if (p === '/orbital/codes/ABCD-1234') return json({ state: 'linked', agent: { id: AGENT, name: 'Echo', app: 'ChatGPT' } });
      if (p === '/orbital/agents') return json({ agents: unlinked ? [] : [{ id: AGENT, name: 'Echo', app: 'ChatGPT' }] });
      if (p === '/orbital/agents/' + AGENT && init.method === 'DELETE') { unlinked = true; return json({ ok: true }); }
      if (p === '/orbital/agents/' + AGENT + '/events') { sent.push(JSON.parse(init.body)); return json(answer); }
      return new Response('{}', { status: 404 });
    };
    const doc = new Document('tana:text:' + ulid());
    doc.transact((l) => initDocument(l, 'Pilot brief', ME));
    content.insertAfter(doc, null, 'Venue options');
    const api = agents({ hold: async () => doc, settled: async () => {} }), lines = () => content.readOutline(doc).map((n) => n.text).filter(Boolean); // a new note's empty first line left out

    const link = JSON.parse(await api.linkCode());
    assert.strictEqual(link.code, 'ABCD-1234');
    assert.ok(link.prompt.startsWith('Call Orbital\'s link_orbital tool with the code ABCD-1234'), 'the same instructions as the Mac copies');
    assert.deepStrictEqual([link.url, link.tana], ['https://orbital.md/mcp', 'https://home.tana.inc/mcp'], 'and both servers, as ChatGPT\'s form asks for them');
    assert.match(settings.get('relayKey'), /^[\w-]{43}$/, 'your Orbital made from the phone: its key in the synced settings, so the Mac is the same Orbital');
    const linked = JSON.parse(await api.linkStatus('ABCD-1234'));
    assert.deepStrictEqual(linked.agent, { id: ID, name: 'Echo', app: 'ChatGPT' });
    assert.deepStrictEqual([settings.get('agents'), settings.get('defaultAgent')], [['codex', ID], ID], 'linked, it is on and the default, Codex left on as the Mac had it');
    assert.deepStrictEqual(JSON.parse(await api.agents()).agents, [{ id: ID, name: 'Echo', app: 'ChatGPT', seenAt: null, on: true, isDefault: true }]);

    // a node a Mac handed to Codex: its request block, its mark and its link
    mcpServer.writeContext(doc, 'Summarise the venues');
    settings.set('codex', [doc.id]); settings.set('codexPrompt', { [doc.id]: 'Summarise the venues' }); settings.set('codexTask', { [doc.id]: { agent: 'codex', taskId: 't1' } });
    answer = { subscribers: 1, delivered: 0 };
    await assert.rejects(api.handTo(doc.id, ID, 'Book the venue'), /Echo did not take it/);
    assert.deepStrictEqual(lines(), ['Venue options', 'Agent context'], 'not taken: the Codex block is back and no status line stays');
    assert.match(contentText(doc), /Summarise the venues/);
    assert.deepStrictEqual(settings.get('codexTask')[doc.id], { agent: 'codex', taskId: 't1' }, 'and the node is still Codex\'s');

    answer = { subscribers: 1, delivered: 1 };
    const out = JSON.parse(await api.handTo(doc.id, ID, '  Book the venue  '));
    assert.deepStrictEqual(lines(), ['Venue options', 'Agent status: Assigned'], 'handed over: the node ends with the status line, the request block gone');
    const event = sent.at(-1);
    assert.deepStrictEqual([event.name, event.data.node, event.data.request, event.data.instructions], ['task.assigned', doc.id, 'Book the venue', mcpServer.HOW], 'the event the Mac sends: the node, the request, Orbital\'s instructions');
    assert.deepStrictEqual([settings.get('codex'), settings.get('codexPrompt')[doc.id], settings.get('codexTask')[doc.id]], [[doc.id], 'Book the venue', { agent: ID, taskId: event.id }], 'marked and linked as the Mac\'s badge reads it');
    assert.deepStrictEqual(out, { id: ID, name: 'Echo', status: 'assigned' });
    mcpServer.writeStatus(doc, 'Working');
    assert.strictEqual(agentOf(doc.id, doc).status, 'working', 'the Dot\'s Working shows');
    answer = { subscribers: 1, delivered: 0 };
    await assert.rejects(api.handTo(doc.id, ID, 'Book it again'), /Echo did not take it/);
    assert.deepStrictEqual([lines().at(-1), settings.get('codexPrompt')[doc.id]], ['Agent status: Working', 'Book the venue'], 'not taken: the Dot\'s own line is back (main/mcp-server.js handOver), and its request kept');
    answer = { subscribers: 1, delivered: 1 };

    const before = sent.length;
    await assert.rejects(api.handTo(doc.id, ID, '   '), /Say what Echo should do/);
    doc.writeDenied = true;
    await assert.rejects(api.handTo(doc.id, ID, 'Again'), /read-only/);
    doc.writeDenied = false;
    assert.deepStrictEqual([sent.length, lines().at(-1)], [before, 'Agent status: Working'], 'a blank request or a read-only node: nothing sent, nothing written');

    await api.unhand(doc.id);
    assert.deepStrictEqual(lines(), ['Venue options'], 'Unassign takes the status line out');
    assert.deepStrictEqual([settings.get('codex'), settings.get('codexTask')[doc.id], agentOf(doc.id, doc)], [[], undefined, null], 'and the mark and the link');

    // Settings' swipes: Make Default switches an agent that was off on as well; Unlink lets it go at the MCP server, switches it
    // off, makes it no one's default and unassigns its nodes, status line and all
    settings.set('agents', ['codex']); settings.set('defaultAgent', null);
    assert.deepStrictEqual(JSON.parse(await api.setDefault(ID)).map((a) => [a.on, a.isDefault]), [[true, true]], 'made the default, and on');
    await api.handTo(doc.id, ID, 'Book the venue');
    assert.deepStrictEqual(JSON.parse(await api.unlink(ID)), [], 'unlinked: the MCP server no longer lists it');
    assert.ok(unlinked, 'the MCP server was told');
    assert.deepStrictEqual([settings.get('agents'), settings.get('defaultAgent'), settings.get('codex'), settings.get('codexTask')[doc.id], lines()], [['codex'], null, [], undefined, ['Venue options']],
      'off, no longer the default, and its node unassigned with its status line gone');
    Object.assign(S, { me: was.me, client: was.client, settingsReadOnly: was.readOnly });
  }

  // A task's box and a zoomed node's fields on the phone (ios/engine/tasks.js), on a task document of its own: an Inbox
  // task is accepted, an open one completed, a completed one reopened, a state given outright set as given; what is not a
  // task, a read-only task and a state Tana does not have refused with nothing written; Tana's later refusal (its
  // write-denied event) said; and access() names the state, the people and who may see it, as Pages.swift draws them
  {
    const { EventEmitter } = require('node:events');
    const { S } = require('../main/state');
    const { Document } = require('../sdk/document'), { initDocument, readNode, ulid } = require('../sdk/node');
    const { createTasks } = require('../ios/engine/tasks.js');
    const was = { me: S.me, client: S.client }, ME = 'tana:user-profile:01mememememememememememem0', SAM = 'tana:user-profile:01samsamsamsamsamsamsamsam';
    const sync = new EventEmitter();
    S.me = { userUri: ME, orgId: 'org' };
    S.client = { sync, graph: { getOwnerChain: async () => ({ owners: [] }), listNodes: async () => ({ nodes: [] }) } };
    const docs = new Map(), make = (title, config) => { const d = new Document('tana:text:' + ulid()); d.transact((l) => initDocument(l, title, ME, config)); docs.set(d.id, d); return d; };
    const task = make('Plan the offsite', { kind: 'task' }), note = make('Notes', { kind: 'doc' });
    const access = async () => ({ sync: { subscribe: async (uri) => docs.get(uri) }, graph: S.client.graph, orgDocUri: 'tana:org:x', orgAdmin: false });
    const api = createTasks({ hold: async (id) => docs.get(id), access, members: async () => [{ id: SAM, title: 'Sam' }], patience: 20 });
    const state = () => readNode(task).stateType;
    assert.strictEqual(state(), 'open', 'a task of your own starts In Progress');
    assert.strictEqual(JSON.parse(await api.toggle(task.id)), 'closed', 'an open one is completed');
    assert.strictEqual(JSON.parse(await api.toggle(task.id)), 'open', 'a completed one reopened');
    assert.strictEqual(JSON.parse(await api.toggle(task.id, 'proposed')), 'proposed', 'a state given is set as given (Move to Inbox)');
    assert.strictEqual(JSON.parse(await api.toggle(task.id)), 'open', 'an Inbox task is accepted first');
    assert.strictEqual(JSON.parse(await api.toggle(task.id, 'not_now')), 'not_now');
    assert.strictEqual(state(), 'not_now', 'and written to the document');
    await assert.rejects(api.toggle(note.id), /Only a task/, 'a document is no task');
    await assert.rejects(api.toggle(task.id, 'waiting'), /Only a task/, 'nor is a state Tana does not have');
    task.writeDenied = true;
    await assert.rejects(api.toggle(task.id), /read-only/);
    task.writeDenied = false;
    assert.strictEqual(state(), 'not_now', 'refused: nothing written');
    const refusing = api.toggle(task.id);
    setImmediate(() => sync.emit('write-denied', task.id));
    await assert.rejects(refusing, /Tana refused the change/, 'Tana saying no after the write is said');
    assert.strictEqual(sync.listenerCount('write-denied'), 0, 'and nobody is left listening');

    assert.deepStrictEqual(JSON.parse(await api.assign(task.id, [SAM])), [SAM], 'given to Sam, who cannot open it: the app asks to grant access');
    const shown = JSON.parse(await api.access(task.id));
    assert.deepStrictEqual([shown.title, shown.task, shown.state, shown.me], ['Plan the offsite', true, 'closed', ME], 'its title, a task, its state (the refused write left for Tana to undo)');
    assert.deepStrictEqual([shown.assignees, shown.hidden], [[{ id: SAM, name: 'Sam' }], [{ id: SAM, name: 'Sam' }]], 'assigned to Sam and shut out, named from the members');
    assert.ok(shown.rules.includes('people'), 'with the sharing rules to pick from');
    assert.strictEqual(JSON.parse(await api.share(task.id, 'people', [SAM], shown.token)), true, 'Grant access');
    const granted = JSON.parse(await api.access(task.id));
    assert.deepStrictEqual([granted.hidden, granted.participants], [[], [SAM]], 'Sam can see it now');
    assert.strictEqual(JSON.parse(await api.access(note.id)).state, null, 'a document has no Status');
    Object.assign(S, was);
  }

  // The Timeline's read (ios/engine/read.js): the settings and the Timeline side by side, and nothing shown before the
  // settings are read: a part that lands first waits for them and goes marked; a refusal shows nothing; a watch choice
  // the settings moved reads the Timeline again
  {
    const { read } = require('../ios/engine/read.js');
    const later = () => { let done, fail; const p = new Promise((a, b) => { done = a; fail = b; }); return { p, done, fail }; };
    const tick = () => new Promise((r) => setImmediate(r));
    const redact = (rows) => rows.map((r) => ({ ...r, marked: true }));
    let settings = later(), page = later(), told, parts = [];
    const asked = read({ rows: (progress) => { told = progress; return page.p; }, settled: () => settings.p, follows: () => 'same', redact, part: (p) => parts.push(p) });
    told([{ id: 'today' }]);
    await tick();
    assert.deepStrictEqual(parts, [], 'nothing shown before the settings are read');
    settings.done();
    await tick();
    assert.deepStrictEqual(parts, [[{ id: 'today', marked: true }]], 'then the part in so far, marked with them');
    page.done([{ id: 'today' }, { id: 'event' }]);
    assert.deepStrictEqual(await asked, [{ id: 'today', marked: true }, { id: 'event', marked: true }], 'the page, marked');
    told([{ id: 'late' }]);
    assert.strictEqual(parts.length, 1, 'nothing told after the page');

    settings = later(); page = later(); parts = [];
    const refused = read({ rows: (progress) => { told = progress; return page.p; }, settled: () => settings.p, follows: () => 'same', redact, part: (p) => parts.push(p) });
    told([{ id: 'today' }]);
    settings.fail(new Error('no settings'));
    await assert.rejects(refused, /no settings/, 'no settings, no Timeline');
    page.fail(new Error('refused too')); // handled: no unhandled rejection
    told([{ id: 'today' }, { id: 'event' }]);
    await tick();
    assert.deepStrictEqual(parts, [], 'and nothing of it shown');

    settings = later(); parts = [];
    const quick = read({ rows: (progress) => { progress([{ id: 'today' }]); return Promise.resolve([{ id: 'whole' }]); }, settled: () => settings.p, follows: () => 'same', redact: (r) => r, part: (p) => parts.push(p) });
    await tick();
    settings.done();
    assert.deepStrictEqual(await quick, [{ id: 'whole' }]);
    assert.deepStrictEqual(parts, [], 'a page in before the settings goes whole, with no part ahead of it');

    let n = 0, follows = 'watching a';
    const again = await read({ rows: async () => [{ id: 'read ' + ++n }], settled: async () => { follows = 'watching b'; }, follows: () => follows, redact: (r) => r, part: () => {} });
    assert.deepStrictEqual(again, [{ id: 'read 2' }], 'the settings moved a watch choice: the Timeline read again');
  }
  // What the phone keeps live (ios/engine/live.js), over a fake sync stream and fake live queries: a page opened is told
  // to the app as 'changed:<id>' when its document changes, once for a burst; a saved search's list is a live query,
  // opened again only when the saved query changes, and only the newest few stay open; the Timeline is read again for a
  // new Inbox task, a task you made changing state (not its words), a task it shows changing, today's node and the pins
  {
    const { EventEmitter } = require('node:events');
    const { createLive, SETTLE, LISTS } = require('../ios/engine/live.js');
    const tick = () => new Promise((r) => setImmediate(r)), settle = () => new Promise((r) => setTimeout(r, SETTLE + 50));
    const sync = new EventEmitter(), posted = [], opened = [];
    let moved = 0;
    const open = async (_sync, query, { onRows }) => Object.assign(new EventEmitter(), { query, onRows, closed: false, close() { this.closed = true; return Promise.resolve(); } });
    const live = createLive({ sync, me: 'tana:user-profile:me', post: (m) => posted.push(m), moved: () => moved++, open: (...a) => open(...a).then((h) => (opened.push(h), h)) });
    await tick();
    const rows = (o) => ({ added: [], removed: [], changed: [], initial: false, ...o });
    const inbox = opened.find((h) => (h.query.stateTypes || []).join() === 'proposed'), mine = opened.find((h) => h.query.createdBy);
    assert.deepStrictEqual([inbox.query.assignedTo, mine.query.createdBy], [['tana:user-profile:me'], ['tana:user-profile:me']], 'your Inbox and the tasks you made');
    inbox.onRows(rows({ added: [{ uri: 'tana:text:a', title: 'A' }], initial: true }));
    assert.strictEqual(moved, 0, 'the first answer is what was just read');
    inbox.onRows(rows({ added: [{ uri: 'tana:text:b', title: 'B' }] }));
    assert.strictEqual(moved, 1, 'a new Inbox task reads the Timeline again');
    mine.onRows(rows({ added: [{ uri: 'tana:text:t', title: 'T', state: { type: 'open', enteredAt: 1 } }], initial: true }));
    mine.onRows(rows({ changed: [{ uri: 'tana:text:t', title: 'T, renamed', state: { type: 'open', enteredAt: 1 } }] }));
    assert.strictEqual(moved, 1, 'a task you made, renamed: nothing the Timeline shows');
    mine.onRows(rows({ changed: [{ uri: 'tana:text:t', title: 'T, renamed', state: { type: 'closed', enteredAt: 2 } }] }));
    assert.strictEqual(moved, 2, 'and completed by someone: read again');

    live.page('tana:text:p');
    for (const id of ['tana:text:p', 'tana:text:p', 'tana:text:elsewhere', 'tana:liveQuery:q']) sync.emit('change', id);
    await settle();
    assert.deepStrictEqual(posted, ['changed:tana:text:p'], 'a page opened, told once for a burst; nothing else');

    let query = { types: ['text'], limit: 100 };
    live.page('tana:search:s', () => query);
    await tick();
    const first = opened.at(-1);
    assert.deepStrictEqual(first.query, query, "a saved search's list is a live query");
    first.onRows(rows({ changed: [{ uri: 'tana:text:r' }] }));
    sync.emit('change', 'tana:search:s'); // renamed: the same question
    await settle();
    assert.deepStrictEqual(posted.slice(1), ['changed:tana:search:s'], 'a row of it moved: the page read again, once');
    assert.strictEqual(opened.at(-1), first, 'the same query is not opened again');
    query = { types: ['text'], stateTypes: ['open'], limit: 100 };
    sync.emit('change', 'tana:search:s');
    await tick();
    assert.ok(first.closed && opened.at(-1).query === query, 'saved with another query: listened to with that one');
    const second = opened.at(-1);
    query = () => { throw new Error('unreadable'); };
    live.page('tana:search:bad', () => query());
    sync.emit('change', 'tana:search:bad'); // must not throw out of the stream's listener
    for (let i = 0; i < LISTS; i++) live.page('tana:event:' + i, () => ({ ownerUris: ['tana:event:' + i] }));
    await tick();
    assert.ok(second.closed, 'only the newest ' + LISTS + ' pages keep a list live');

    live.timeline([
      { id: 'orbital:timeline:today:x', timeline: { today: true, day: 'tana:text:day' }, children: [{ id: 'tana:text:t1' }] },
      { id: 'orbital:timeline:edit:tana:text:t2:1', timeline: { uri: 'tana:text:t2' } },
      { id: 'orbital:timeline:meeting:tana:event:m:1', timeline: { uri: 'tana:event:m' } },
    ]);
    await tick();
    const shown = opened.at(-1);
    assert.deepStrictEqual(shown.query.uris, ['tana:text:t1', 'tana:text:t2'], "the Timeline's tasks, its meetings left to main/timeline.js");
    shown.onRows(rows({ added: [{ uri: 'tana:text:t1', title: 'One', state: { type: 'open' } }], initial: true }));
    shown.onRows(rows({ changed: [{ uri: 'tana:text:t1', title: 'One', state: { type: 'closed' } }] }));
    assert.strictEqual(moved, 3, 'a task on it ticked elsewhere: read again');
    sync.emit('change', 'tana:text:day');
    sync.emit('change', 'tana:pin-map:x');
    assert.strictEqual(moved, 5, "today's node and the pins: read again");
    live.timeline([{ id: 'orbital:timeline:edit:tana:text:t2:1', timeline: { uri: 'tana:text:t2' } }, { id: 'x', children: [{ id: 'tana:text:t1' }] }]);
    await tick();
    assert.strictEqual(opened.at(-1), shown, 'the same tasks: the same query');
    sync.emit('change', 'tana:text:day');
    assert.strictEqual(moved, 5, 'no Today stop on the page: its node is no longer followed');
  }
  if (!bun && process.env.CI) throw new Error('CI must build the engine: install Bun');
  if (!bun) return console.log('ios engine check ok (the bundle skipped: no Bun)');
  const out = path.join(os.tmpdir(), 'orbital-engine-check.js');
  const built = spawnSync(bun, [path.join(__dirname, '../ios/engine/build.js'), out], { encoding: 'utf8' });
  assert.strictEqual(built.status, 0, 'the engine bundles: ' + built.stderr);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = 'x.' + b64({ exp: Math.floor(Date.now() / 1000) + 300, 'urn:tana:user:id': 'u1', org_id: 'org_1' }) + '.y';
  const source = fs.readFileSync(out, 'utf8');
  assert.ok(source.includes('"' + require('../source').userAgent('orbital-ios') + '"'), 'the phones tell Tana the repo and commit they were built from (x-client-name)');
  // one page: a fresh vm, as a fresh web view, over the given storage
  const session = JSON.stringify({ authenticated: true, accessToken: token, userExternalId: 'u1', orgDocUri: 'tana:org:01aaaaaaaaaaaaaaaaaaaaaaaa', user: { email: 'a@b.c' } });
  // shown: what the page itself says, the session's answer as the app loads it (Engine.swift start); none, no document
  const boot = (store, shown, graphDown) => {
    const calls = [], posted = [];
    const fetch = async (url, init = {}) => {
      calls.push(String(url));
      if (String(url).startsWith('/api/auth/session')) return new Response(session);
      if (graphDown && /GraphService/.test(String(url))) throw new TypeError('Load failed'); // Tana out of reach
      assert.ok(new Headers(init.headers).get('authorization') === 'Bearer ' + token, 'every platform call carries the session token');
      return new Response(new Uint8Array(0), { headers: { 'content-type': 'application/proto' } });
    };
    const ctx = { structuredClone, queueMicrotask, fetch, Response, Headers, Request, URL, AbortController, AbortSignal, TextEncoder, TextDecoder, atob, btoa, crypto, WebAssembly, Blob, DecompressionStream,
      setTimeout: (f, ms, ...a) => setTimeout(f, ms === 8000 ? 1 : ms, ...a), clearTimeout, setInterval, clearInterval, console: { ...console, log() {}, warn() {}, error() {} }, Promise,
      location: { origin: 'https://home.tana.inc', pathname: '/api/auth/session' },
      localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i], get length() { return store.size; } },
      webkit: { messageHandlers: { orbital: { postMessage: (m) => posted.push(m) } } } };
    if (shown !== undefined) ctx.document = { body: { textContent: shown } };
    ctx.window = ctx.globalThis = ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(source, ctx);
    return { orbital: ctx.orbital, calls, posted };
  };
  // fails closed: nothing before this account's settings document has been read once, since what is sensitive is in it
  const first = boot(new Map());
  assert.deepStrictEqual(first.posted, ['ready'], 'the page says ready');
  assert.strictEqual(await first.orbital.connect(), true, 'signed in, it connects');
  // a search that found no settings document at all: this account never used Orbital on a Mac (#751), said in the words
  // both phones draw their Set up Orbital on a Mac first screen for, which must stay word for word in all three places
  const MAC_FIRST = /const MAC_FIRST = ("[^"]+");/.exec(fs.readFileSync(path.join(__dirname, '../ios/engine/index.js'), 'utf8'))[1];
  assert.ok(fs.readFileSync(path.join(__dirname, '../ios/Orbital/Engine.swift'), 'utf8').includes('static let macFirst = ' + MAC_FIRST), 'Engine.swift macFirst is the engine\'s sentence');
  assert.ok(fs.readFileSync(path.join(__dirname, '../android/shared/src/commonMain/kotlin/com/dreetje/orbital/Engine.kt'), 'utf8').includes('const val MAC_FIRST = ' + MAC_FIRST), 'Engine.kt MAC_FIRST is the engine\'s sentence');
  await assert.rejects(first.orbital.timeline(1), (e) => e.message === JSON.parse(MAC_FIRST), 'no settings document anywhere: set up on a Mac first');
  // a search that failed says nothing about the document: the plain refusal, which a pull can clear
  const down = boot(new Map(), undefined, true);
  assert.strictEqual(await down.orbital.connect(), true);
  await assert.rejects(down.orbital.timeline(1), /Could not read your Orbital settings/, 'Tana not answering is not a missing document');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(first.posted, ['ready'], 'and no part of it told to the app');
  // the session page signed in: connected from it, with no second lookup; signed out, Tana is asked again
  const fromPage = boot(new Map(), session);
  assert.strictEqual(await fromPage.orbital.connect(), true);
  assert.ok(!fromPage.calls.some((c) => c.startsWith('/api/auth/session')), 'the page is the session: not asked twice');
  assert.strictEqual(fromPage.orbital.email(), 'a@b.c');
  assert.strictEqual(fromPage.orbital.account(), 'tana:user-profile:u1@org_1', 'who, in which workspace: what the saved Timeline is kept for');
  const signedOutPage = boot(new Map(), JSON.stringify({ authenticated: false, reason: 'no_session_cookie' }));
  assert.strictEqual(await signedOutPage.orbital.connect(), true, 'a signed-out page is asked again');
  assert.ok(signedOutPage.calls.some((c) => c.startsWith('/api/auth/session')));
  // a page whose token is nearly spent (one a cache kept) is asked again too
  const aged = 'x.' + b64({ exp: Math.floor(Date.now() / 1000) + 30, 'urn:tana:user:id': 'u9', org_id: 'org_9' }) + '.y';
  const oldPage = boot(new Map(), JSON.stringify({ ...JSON.parse(session), accessToken: aged, userExternalId: 'u9' }));
  assert.strictEqual(await oldPage.orbital.connect(), true);
  assert.ok(oldPage.calls.some((c) => c.startsWith('/api/auth/session')), 'an aged page is not taken');
  assert.strictEqual(oldPage.orbital.account(), 'tana:user-profile:u1@org_1', 'Tana\'s own answer is');
  // once it has been (the mark is this account's own, in its own mirror), the Timeline answers in the desktop's row shape
  const page = boot(new Map([['orbital:tana:user-profile:u1@org_1:settingsRead', 'true']]));
  assert.strictEqual(await page.orbital.connect(), true);
  const rows = JSON.parse(await page.orbital.timeline(1));
  // what the page tells the app is a string, as both phones' bridges carry it: a first part as 'part:' and its rows
  for (const m of page.posted) assert.ok(typeof m === 'string' && (['ready', 'changed'].includes(m) || /^changed:tana:/.test(m) || (m.startsWith('part:') && Array.isArray(JSON.parse(m.slice(5))))), 'told as a string: ' + String(m).slice(0, 80));
  // the graph answers nothing here, so the page is its Today's Tasks stop alone, in the shape Timeline.swift reads
  const today = rows.find((r) => r.timeline && r.timeline.today);
  assert.ok(today, 'the Timeline answers its Today stop: ' + JSON.stringify(rows).slice(0, 200));
  assert.match(today.id, /^orbital:timeline:today:/);
  assert.strictEqual(today.icon, 'todayTasks');
  assert.ok(Array.isArray(today.children) && typeof today.createdAt === 'string' && today.segments[0].text === "Today's Tasks");
  assert.strictEqual(today.timeline.time, 'Now', 'the Today stop keeps its own time through labels.js');
  assert.ok(page.calls.some((c) => c.includes('GraphService/ListNodes')), 'the Timeline asks the graph');
  assert.strictEqual(page.orbital.email(), 'a@b.c');
  // Siri's List Tasks (Engine.swift keepTasks): the tasks assigned to you, asked of the graph in every state
  const asked = page.calls.length;
  assert.deepStrictEqual(JSON.parse(await page.orbital.tasks()), []);
  assert.ok(page.calls.slice(asked).some((c) => c.includes('GraphService/ListNodes')), 'List Tasks asks the graph');
  // ChatGPT's words, as the Mac asks with them (main/prompts.js, orbital.prompts): Translator.swift and QuickAdd.swift
  // read them from here, and Settings the models' names
  const p = require('../main/prompts');
  assert.deepStrictEqual(JSON.parse(page.orbital.prompts('Dutch', ['gpt-6-sol', 'gpt-5.5', 'gpt-oss-120b'], ['xhigh', 'low'])), {
    translate: { instructions: p.TRANSLATE_INSTRUCTIONS('Dutch'), schema: p.TRANSLATE_SCHEMA }, image: { instructions: p.IMAGE_INSTRUCTIONS('Dutch') },
    models: { 'gpt-6-sol': 'Sol 6', 'gpt-5.5': 'GPT-5.5', 'gpt-oss-120b': 'gpt-oss-120b' }, efforts: { xhigh: 'Extra high', low: 'Low' } });
  assert.deepStrictEqual(JSON.parse(page.orbital.prompts('Klingon')), { translate: null, image: { instructions: p.IMAGE_INSTRUCTIONS(null) }, models: {}, efforts: {} }, 'a language Auto-translate does not offer: none');
  fs.rmSync(out, { force: true });
  console.log('ios engine check ok');
  process.exit(0); // the fake sync stream keeps retrying
})().catch((e) => { console.error(e); process.exit(1); });

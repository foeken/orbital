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
  demoOn(false);
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
  const desktop = new Function([slice(/^const dayKey = .*$/m), slice(/^function timelineDay\(key\) \{[\s\S]*?\n\}/m), slice(/^const timelineTime = .*$/m),
    'return { dayKey, timelineDay, timelineTime };'].join('\n'))();
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
  if (!bun && process.env.CI) throw new Error('CI must build the engine: install Bun (.github/workflows/ci.yml)');
  if (!bun) return console.log('ios engine check ok (the bundle skipped: no Bun)');
  const out = path.join(os.tmpdir(), 'orbital-engine-check.js');
  const built = spawnSync(bun, [path.join(__dirname, '../ios/engine/build.js'), out], { encoding: 'utf8' });
  assert.strictEqual(built.status, 0, 'the engine bundles: ' + built.stderr);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = 'x.' + b64({ exp: Math.floor(Date.now() / 1000) + 300, 'urn:tana:user:id': 'u1', org_id: 'org_1' }) + '.y';
  const source = fs.readFileSync(out, 'utf8');
  // one page: a fresh vm, as a fresh web view, over the given storage
  const session = JSON.stringify({ authenticated: true, accessToken: token, userExternalId: 'u1', orgDocUri: 'tana:org:01aaaaaaaaaaaaaaaaaaaaaaaa', user: { email: 'a@b.c' } });
  // shown: what the page itself says, the session's answer as the app loads it (Engine.swift start); none, no document
  const boot = (store, shown) => {
    const calls = [], posted = [];
    const fetch = async (url, init = {}) => {
      calls.push(String(url));
      if (String(url).startsWith('/api/auth/session')) return new Response(session);
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
  await assert.rejects(first.orbital.timeline(1), /Could not read your Orbital settings/, 'no Timeline without the settings document');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(first.posted, ['ready'], 'and no part of it told to the app');
  // the session page signed in: connected from it, with no second lookup; signed out, Tana is asked again
  const fromPage = boot(new Map(), session);
  assert.strictEqual(await fromPage.orbital.connect(), true);
  assert.ok(!fromPage.calls.some((c) => c.startsWith('/api/auth/session')), 'the page is the session: not asked twice');
  assert.strictEqual(fromPage.orbital.email(), 'a@b.c');
  const signedOutPage = boot(new Map(), JSON.stringify({ authenticated: false, reason: 'no_session_cookie' }));
  assert.strictEqual(await signedOutPage.orbital.connect(), true, 'a signed-out page is asked again');
  assert.ok(signedOutPage.calls.some((c) => c.startsWith('/api/auth/session')));
  // once it has been (the mark is this account's own, in its own mirror), the Timeline answers in the desktop's row shape
  const page = boot(new Map([['orbital:tana:user-profile:u1@org_1:settingsRead', 'true']]));
  assert.strictEqual(await page.orbital.connect(), true);
  const rows = JSON.parse(await page.orbital.timeline(1));
  // the graph answers nothing here, so the page is its Today's Tasks stop alone, in the shape Timeline.swift reads
  const today = rows.find((r) => r.timeline && r.timeline.today);
  assert.ok(today, 'the Timeline answers its Today stop: ' + JSON.stringify(rows).slice(0, 200));
  assert.match(today.id, /^orbital:timeline:today:/);
  assert.strictEqual(today.icon, 'todayTasks');
  assert.ok(Array.isArray(today.children) && typeof today.createdAt === 'string' && today.segments[0].text === "Today's Tasks");
  assert.strictEqual(today.timeline.time, 'Now', 'the Today stop keeps its own time through labels.js');
  assert.ok(page.calls.some((c) => c.includes('GraphService/ListNodes')), 'the Timeline asks the graph');
  assert.strictEqual(page.orbital.email(), 'a@b.c');
  fs.rmSync(out, { force: true });
  console.log('ios engine check ok');
  process.exit(0); // the fake sync stream keeps retrying
})().catch((e) => { console.error(e); process.exit(1); });

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
  const me = 'tana:user-profile:me', other = 'tana:user-profile:sam', t = (h) => new Date(Date.now() - h * 36e5).toISOString();
  const rows = [
    { id: 'a', title: 'B task', state: 'open', updated: t(5), created: t(9), createdBy: me, assignees: [me] },
    { id: 'b', title: 'A task', state: 'proposed', updated: t(1), created: t(2), createdBy: other, assignees: [me] },
    { id: 'c', title: 'Handed over', state: 'open', updated: t(3), created: t(3), createdBy: me, assignees: [other] },
    { id: 'd', title: 'Theirs', state: 'open', updated: t(2), created: t(2), createdBy: other, assignees: [other] },
    { id: 'e', title: 'Pinned one', state: 'open', updated: t(8), created: t(8), createdBy: me, assignees: [me] },
  ];
  const c = { me, now: Date.now(), names: new Map([[other, 'Sam']]), pinned: new Set(['e']), watched: new Set(), silenced: new Set() };
  const shown = (view) => arrange(rows, view, c).map(({ n, group }) => (group ? group + ':' : '') + n.id).join(' ');
  assert.strictEqual(shown({ groupBy: 'responsibility', sortBy: '-updated' }), 'Pinned:e Mine:a Tracking:c Assigned by others:b');
  assert.strictEqual(shown({ groupBy: 'status', sortBy: 'title' }), 'Inbox:b In Progress:a In Progress:c In Progress:e In Progress:d');
  assert.strictEqual(shown({ sortBy: '-created' }), 'b d c e a');
  assert.strictEqual(shown({ groupBy: 'assignee' }), 'Sam:c Sam:d Someone:a Someone:b Someone:e', 'named by the member list, unknown as Someone');
  assert.strictEqual(shown({}), 'a b c d e', 'no sort: the query order');
}

// What is sensitive never crosses the bridge (ios/engine/redact.js): the node's own title, a Timeline entry about it
// (its sentence and Tana's words), a task under another entry, a mention of it, a link to it and a reference to it;
// everything else as it was.
{
  const { redact, PRIVATE } = require('../ios/engine/redact.js');
  const S = 'tana:text:secret', rows = redact([
    { id: S, title: 'Salary review', text: 'Salary review', segments: [{ text: 'Salary review' }] },
    { id: 'e1', timeline: { uri: S, note: 'Raised to 90k', change: 'Edited', detail: 'x' }, segments: [{ text: 'Sam edited Salary review' }], people: [{ name: 'Sam' }] },
    { id: 'e2', timeline: { uri: 'tana:text:open' }, segments: [{ text: 'An AI agent added a task' }], children: [{ id: S, title: 'Salary review' }, { id: 'tana:text:ok', title: 'Book the venue' }] },
    { id: 'b1', segments: [{ text: 'See ' }, { mention: { uri: S, label: 'Salary review' } }, { text: 'Salary review', marks: { link: S } }, { mention: { uri: 'tana:text:ok', label: 'Venue' } }] },
    { id: 'm0.a0', type: 'reference', text: 'Salary review', segments: [], reference: { uri: S, label: 'Salary review' } },
    { id: 'today', timeline: { today: true }, segments: [{ text: "Today's Tasks" }], children: [{ id: 'p', children: [{ id: S, title: 'Salary review' }] }] },
  ], new Set([S]));
  assert.strictEqual(rows[0].title, PRIVATE);
  assert.deepStrictEqual(rows[1].segments, [{ text: 'A private item changed' }]);
  assert.deepStrictEqual([rows[1].timeline.note, rows[1].timeline.change, rows[1].timeline.detail, rows[1].people.length], [null, null, null, 0]);
  assert.deepStrictEqual(rows[2].children.map((c) => c.title), [PRIVATE, 'Book the venue'], 'only the sensitive task under an entry');
  assert.deepStrictEqual(rows[3].segments.map((g) => g.text || g.mention.label), ['See ', PRIVATE, PRIVATE, 'Venue']);
  assert.deepStrictEqual([rows[4].reference.label, rows[4].text], [PRIVATE, PRIVATE]);
  assert.strictEqual(rows[5].children[0].children[0].title, PRIVATE, 'nested rows too');
  assert.ok(!JSON.stringify(rows).includes('Salary') && !JSON.stringify(rows).includes('90k'), 'no word of it anywhere');
}

// The bundle itself, built with Bun: built as the Xcode phase builds it, then run in a vm
// made to look like the session page, with a fake Tana that signs in and answers every call empty. It must say ready,
// connect with a bearer token, and answer the Timeline in the desktop's row shape. Its 8 s give-ups (stand-ins.js within)
// are made immediate, since this fake never opens the sync stream. CI installs Bun; locally it is skipped without it.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const bun = [path.join(os.homedir(), '.bun/bin/bun'), 'bun'].find((b) => spawnSync(b, ['--version']).status === 0);
(async () => {
  if (!bun && process.env.CI) throw new Error('CI must build the engine: install Bun (.github/workflows/ci.yml)');
  if (!bun) return console.log('ios engine check ok (the bundle skipped: no Bun)');
  const out = path.join(os.tmpdir(), 'orbital-engine-check.js');
  const built = spawnSync(bun, [path.join(__dirname, '../ios/engine/build.js'), out], { encoding: 'utf8' });
  assert.strictEqual(built.status, 0, 'the engine bundles: ' + built.stderr);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = 'x.' + b64({ exp: Math.floor(Date.now() / 1000) + 300, 'urn:tana:user:id': 'u1', org_id: 'org_1' }) + '.y';
  const source = fs.readFileSync(out, 'utf8');
  // one page: a fresh vm, as a fresh web view, over the given storage
  const boot = (store) => {
    const calls = [], posted = [];
    const fetch = async (url, init = {}) => {
      calls.push(String(url));
      if (String(url).startsWith('/api/auth/session')) return new Response(JSON.stringify({ authenticated: true, accessToken: token, userExternalId: 'u1', orgDocUri: 'tana:org:01aaaaaaaaaaaaaaaaaaaaaaaa', user: { email: 'a@b.c' } }));
      assert.ok(new Headers(init.headers).get('authorization') === 'Bearer ' + token, 'every platform call carries the session token');
      return new Response(new Uint8Array(0), { headers: { 'content-type': 'application/proto' } });
    };
    const ctx = { structuredClone, queueMicrotask, fetch, Response, Headers, Request, URL, AbortController, AbortSignal, TextEncoder, TextDecoder, atob, btoa, crypto, WebAssembly, Blob, DecompressionStream,
      setTimeout: (f, ms, ...a) => setTimeout(f, ms === 8000 ? 1 : ms, ...a), clearTimeout, setInterval, clearInterval, console: { ...console, log() {}, warn() {}, error() {} }, Promise,
      location: { origin: 'https://home.tana.inc', pathname: '/api/auth/session' },
      localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i], get length() { return store.size; } },
      webkit: { messageHandlers: { orbital: { postMessage: (m) => posted.push(m) } } } };
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
  assert.ok(page.calls.some((c) => c.includes('GraphService/ListNodes')), 'the Timeline asks the graph');
  assert.strictEqual(page.orbital.email(), 'a@b.c');
  // a sensitive node is answered Private without being fetched
  const hidden = boot(new Map([['orbital:tana:user-profile:u1@org_1:settingsRead', 'true'], ['orbital:tana:user-profile:u1@org_1:sensitive', JSON.stringify(['tana:text:secret'])]]));
  await hidden.orbital.connect();
  assert.deepStrictEqual(JSON.parse(await hidden.orbital.open('tana:text:secret')), { title: 'Private', kind: 'text', rows: [], private: true });
  fs.rmSync(out, { force: true });
  console.log('ios engine check ok');
  process.exit(0); // the fake sync stream keeps retrying
})().catch((e) => { console.error(e); process.exit(1); });

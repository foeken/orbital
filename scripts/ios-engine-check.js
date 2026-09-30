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

// The bundle itself, when Bun is here to build it (CI has none): built as the Xcode phase builds it, then run in a vm
// made to look like the session page, with a fake Tana that signs in and answers every call empty. It must say ready,
// connect with a bearer token, and answer the Timeline in the desktop's row shape. Its 8 s give-ups (stand-ins.js within)
// are made immediate, since this fake never opens the sync stream. Locally it is skipped without Bun; CI installs it.
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
  fs.rmSync(out, { force: true });
  console.log('ios engine check ok');
  process.exit(0); // the fake sync stream keeps retrying
})().catch((e) => { console.error(e); process.exit(1); });

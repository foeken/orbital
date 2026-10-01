#!/usr/bin/env node
'use strict';
// Whole user flows in the real outliner page on the mock (renderer/mock.js), in headless Chromium over the DevTools
// protocol: no dependency, the way manual/scenes/run.js plays the manual's scenes. Each flow gets a fresh page and fails
// on any uncaught error, unhandled rejection or console.error, besides its own asserts. What the flows guard and why
// is in docs/TESTING.md.
//   npm run flows [-- --only words]   (only the flows whose name holds those words)
// It opens a loopback port and starts Chromium, which the agent sandbox refuses: run it escalated (docs/ELECTRON-SANDBOX.md).
// Chromium: CHROME, else the chrome-headless-shell Playwright keeps in its cache, else Google Chrome, else google-chrome or
// chromium on PATH (CI's runner image has Chrome).
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), { spawn, execFileSync } = require('child_process');
const assert = require('assert/strict');
const { REAL } = require('../manual/scenes/kit'); // mock ids read as real Tana ids, so id-gated rows and marks are drawn

const root = path.resolve(__dirname, '..');
const only = (() => { const i = process.argv.indexOf('--only'); return i < 0 ? null : process.argv[i + 1]; })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.gz': 'application/gzip' };

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  if (fs.existsSync(cache)) for (const d of fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of fs.readdirSync(path.join(cache, d))) { const f = path.join(cache, d, sub, 'chrome-headless-shell'); if (fs.existsSync(f)) return f; }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) { try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { /* not there */ } }
  return null;
}

// keys as the manual's runner presses them (manual/scenes/run.js parseKey): ⌘ ⇧ ⌥ ⌃ then one key
const NAMED = { '↩': ['Enter', 'Enter', 13, '\r'], '⇥': ['Tab', 'Tab', 9], esc: ['Escape', 'Escape', 27], '⌫': ['Backspace', 'Backspace', 8],
  '↑': ['ArrowUp', 'ArrowUp', 38], '↓': ['ArrowDown', 'ArrowDown', 40], '←': ['ArrowLeft', 'ArrowLeft', 37], '→': ['ArrowRight', 'ArrowRight', 39], Space: [' ', 'Space', 32, ' '],
  '[': ['[', 'BracketLeft', 219, '['], ']': [']', 'BracketRight', 221, ']'], '/': ['/', 'Slash', 191, '/'], '@': ['@', 'Digit2', 50, '@'] };
const MODS = { '⌥': 1, '⌃': 2, '⌘': 4, '⇧': 8 };
function parseKey(combo) {
  let mods = 0, i = 0;
  while (MODS[combo[i]] && combo.length > i + 1) { mods |= MODS[combo[i]]; i++; }
  const k = combo.slice(i);
  let def = NAMED[k];
  if (!def && /^[a-z0-9]$/i.test(k)) { const up = k.toUpperCase(); def = [mods & 8 ? up : k.toLowerCase(), /\d/.test(k) ? 'Digit' + k : 'Key' + up, up.charCodeAt(0), mods & 8 ? up : k.toLowerCase()]; }
  if (!def) throw new Error('unknown key ' + combo);
  return { key: def[0], code: def[1], keyCode: def[2], text: mods & 7 ? undefined : def[3], mods };
}

// What every page gets before its scripts run: errors collected for the flow to fail on
const WATCH = String.raw`(() => {
  window.__errors = [];
  addEventListener('error', (e) => __errors.push('error: ' + (e.error?.stack || e.message)));
  addEventListener('unhandledrejection', (e) => __errors.push('unhandled rejection: ' + (e.reason?.stack || e.reason)));
  const ce = console.error.bind(console); console.error = (...a) => { __errors.push('console.error: ' + a.map(String).join(' ')); ce(...a); };
})()`;

const flows = [];
const flow = (name, run) => flows.push({ name, run });

const J = JSON.stringify;
// In the page, after it loads: what the flows read back
const HELPERS = String.raw`(() => {
  // words of secrets found where someone can read them: text outside a .sensitive element, or any tooltip, label,
  // placeholder or alt (those show on hover whatever the text does), or the window's title
  window.__leaks = (words) => {
    const hit = (s) => !!s && words.some((w) => s.includes(w)), out = [];
    const where = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
    const shown = (el) => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) if (hit(n.data) && !n.parentElement.closest('.sensitive') && shown(n.parentElement)) out.push('text in ' + where(n.parentElement) + ': ' + n.data.trim().slice(0, 90));
    for (const el of document.querySelectorAll('[title], [aria-label], [placeholder], [alt]')) for (const a of ['title', 'aria-label', 'placeholder', 'alt']) if (hit(el.getAttribute(a)) && shown(el)) out.push(a + ' of ' + where(el) + ': ' + el.getAttribute(a).slice(0, 90));
    if (hit(document.title)) out.push('window title: ' + document.title);
    return out;
  };
  // the outline on screen, as text with two spaces per level
  window.__screen = () => [...document.querySelectorAll('#outline .node')].filter((n) => n.querySelector('.text')).map((n) => {
    let d = 0; for (let p = n.parentElement.closest('#outline .node'); p; p = p.parentElement.closest('#outline .node')) d++;
    return '  '.repeat(d) + (n.querySelector('.text')?.textContent || '').replace(/\u200b/g, '');
  }).filter((l) => l.trim());
  // the same document as the mock keeps it
  window.__saved = async (docId) => { const out = [], walk = (rows, d) => { for (const r of rows || []) { if (r.text) out.push('  '.repeat(d) + r.text); walk(r.children, d + 1); } }; walk(await tana.children(docId), 0); return out; };
  window.__caret = () => { const s = getSelection(), el = document.activeElement; return { key: el && el.isContentEditable ? keyOfEl(el) : null, offset: s.rangeCount ? s.getRangeAt(0).startOffset : null, editable: !!(el && el.isContentEditable) }; };
  1;
})()`;
const settle = (p, ms = 350) => p.sleep(ms);
const T = (words) => '[...document.querySelectorAll("#outline .node .text")].find((e) => e.textContent.includes(' + J(words) + '))';
// a click on a row's text, at its end, the way a user puts the caret there
const clickRow = async (p, words) => {
  await p.waitFor(T(words), 'a row with ' + J(words));
  const [x, y] = await p.js('(() => { const r = ' + T(words) + '.getBoundingClientRect(); return [r.right - 2, r.top + r.height / 2]; })()');
  await p.click(x, y);
};

// 1. Sensitive marks (#157, #203, #435, #659): a title marked sensitive is hidden wherever Orbital draws it. A new
// surface that shows a title is covered here without anyone writing a test for it, as long as the mock reaches it.
flow('sensitive titles stay hidden on every surface', async (p) => {
  await p.start({ real: true });
  // mockdoc2 is mentioned in mockdoc0 and finished on the Timeline, mockdoc6 edited there, mockdoc9 embedded in mockdoc0
  const ids = ['tana:text:mockdoc2', 'tana:text:mockdoc6', 'tana:text:mockdoc9'];
  const secrets = await p.js('Promise.all(' + J(ids) + '.map(async (id) => (await tana.node(id)).title))');
  await p.js('Promise.all(' + J(ids) + '.map((id) => tana.setSensitive(id, true))).then(() => { sensitiveLoading = null; return loadSensitive(); }).then(() => { refreshSensitive(); render(true); })');
  const places = [['Library', "setView('library')"], ['Inbox', "setView('inbox')"], ['Timeline', "goTo('orbital:timeline')"], ['a page that mentions and embeds them', "goTo('tana:text:mockdoc0')"],
    ['the page itself', "goTo('tana:text:mockdoc2')"], ['Notifications', "goTo('orbital:notifications')"], ['Proposals', "goTo('orbital:proposals')"]];
  for (const [name, go] of places) {
    await p.js(go); await settle(p, 500);
    // the mock's proposals borrow mockdoc2's title for a new document of their own, which is not marked
    assert.deepEqual(await p.js('__leaks(' + J(name === 'Proposals' ? secrets.slice(1) : secrets) + ')'), [], 'sensitive words readable on ' + name);
  }
  await p.js("goTo('tana:text:mockdoc0')"); await settle(p);
  await p.key('⌘K'); await p.waitFor('!document.getElementById("palette").hidden', 'Cmd+K');
  assert.deepEqual(await p.js('__leaks(' + J(secrets) + ')'), [], 'sensitive words readable in Cmd+K');
  await p.type(secrets[0].split(' ').slice(0, 2).join(' ')); await settle(p, 500);
  assert.deepEqual(await p.js('__leaks(' + J(secrets) + ')'), [], 'sensitive words readable in Cmd+K results');
  await p.key('esc');
});

// 2. Demo mode (#157, #447, #659): made-up words on screen, and nothing saved, whatever a key or a click asks
flow('demo mode shows none of your words and saves nothing', async (p) => {
  await p.start({ real: true });
  await p.js("goTo('tana:text:mockdoc0')"); await settle(p);
  const before = await p.js("__saved('tana:text:mockdoc0')");
  const words = await p.js('allDocs().map((d) => d.text).filter((t) => t.length > 14).slice(0, 12)');
  await p.js('toggleDemoMode()'); await settle(p);
  for (const [name, go] of [['Library', "setView('library')"], ['Timeline', "goTo('orbital:timeline')"], ['a document', "goTo('tana:text:mockdoc0')"]]) {
    await p.js(go); await settle(p, 500);
    assert.deepEqual(await p.js('__leaks(' + J(words) + ')'), [], 'real words on screen in demo mode on ' + name);
  }
  await p.click(...await p.js('(() => { const r = [...document.querySelectorAll("#outline .node .text")][3].getBoundingClientRect(); return [r.right - 2, r.top + r.height / 2]; })()')); await p.type(' typed in demo'); await p.key('↩'); await p.type('new row'); await p.key('⇥'); await p.key('⌘↩');
  await settle(p, 700);
  await p.js('toggleDemoMode()'); await p.js('flushAll()'); await settle(p, 600);
  assert.deepEqual(await p.js("__saved('tana:text:mockdoc0')"), before, 'demo mode saved a change');
  await p.js('window.__errors = window.__errors.filter((e) => !/Demo mode is on/.test(e))'); // a refused write may say so
});

// 3. Read-only (#447, #545, #170, #659): a document Orbital may not write, as main reports one (every row editable:
// false), takes no caret, and no key pressed on it asks for a write
flow('a read-only document takes no edit', async (p) => {
  await p.start();
  const doc = 'mockdoc0';
  await p.js('(() => { const doc = ' + J(doc) + '; window.__writes = [];' +
    ' const lock = (r) => ({ ...r, editable: false, children: (r.children || []).map(lock) }), f = tana.children; tana.children = async (id, ...a) => (id === doc ? (await f(id, ...a)).map(lock) : f(id, ...a));' +
    ' for (const k of DEMO_WRITES) { const w = tana[k]; if (typeof w === "function") tana[k] = (...a) => { if (JSON.stringify(a).includes(doc)) __writes.push(k); return w(...a); }; } })()');
  await p.js('goTo(' + J(doc) + ')'); await p.waitFor(T('Agenda'), 'the Agenda row');
  await clickRow(p, 'Agenda');
  assert.equal(await p.js('!!(document.activeElement.isContentEditable && document.activeElement.closest("#outline"))'), false, 'a read-only row took the caret');
  await p.type('x'); await p.key('↩'); await p.key('⇥'); await p.key('⇧⇥'); await p.key('⌫'); await p.key('⌘↩'); await p.key('⇧⌘↑'); await p.key('⇧⌘⌫');
  await p.js('flushAll()'); await settle(p, 500);
  assert.deepEqual(await p.js('__writes'), [], 'writes asked for on a read-only document');
});

// 4. Editing (#488, #489, #490, #125, #265, #601, #603): after every step the outline on screen is the one saved
flow('editing keeps the screen and the saved outline the same', async (p) => {
  await p.start();
  const id = await p.js("tana.createDocument('Flow test').then((n) => { goTo(n.id); return n.id; })");
  await p.waitFor('document.activeElement && document.activeElement.isContentEditable', 'the caret in the new page');
  const same = async (step) => {
    await p.js('flushAll()'); await settle(p, 450);
    const [screen, saved] = [await p.js('__screen()'), await p.js('__saved(' + J(id) + ')')];
    assert.deepEqual(screen, saved, 'screen and saved outline differ after ' + step);
    return screen;
  };
  await p.type('alpha'); await p.key('↩'); await p.type('beta'); await p.key('↩'); await p.key('⇥'); await p.type('gamma'); await p.key('↩'); await p.key('⇧⇥'); await p.type('delta');
  assert.deepEqual(await same('typing, Enter, Tab and ⇧Tab'), ['alpha', 'beta', '  gamma', 'delta']);
  await p.js('placeCaret(keyOfEl(' + T('delta') + '), 0)'); await p.key('⌫', 2); // the first takes the bullet off, the second joins
  const joined = await same('⌫ at the start of a row');
  assert.equal(joined.length, 3, '⌫ at the start of a row joins it with the one above');
  await p.key('⌘z'); await settle(p, 300);
  assert.deepEqual(await same('⌘Z after the join'), ['alpha', 'beta', '  gamma', 'delta']);
  await p.js('placeCaret(keyOfEl(' + T('beta') + '), 2)'); await p.key('⇧⌘⌫');
  assert.deepEqual(await same('⇧⌘⌫ deleting a branch'), ['alpha', 'delta']);
  await p.key('⌘z'); await settle(p, 300);
  assert.deepEqual(await same('⌘Z after the delete'), ['alpha', 'beta', '  gamma', 'delta']);
});

// 5. Focus (#200, #377, #463, #603): the palette and the menus over a row give the caret back where it was
flow('Cmd+K, / and Escape give the caret back', async (p) => {
  await p.start();
  await p.js("tana.createDocument('Focus test').then((n) => goTo(n.id))");
  await p.waitFor('document.activeElement && document.activeElement.isContentEditable', 'the caret in the new page');
  await p.type('first row'); await p.key('↩'); await p.type('second row');
  await p.js('placeCaret(keyOfEl(' + T('first row') + '), 3)');
  const at = await p.js('__caret()');
  await p.key('⌘K'); await p.waitFor('!document.getElementById("palette").hidden', 'Cmd+K to open');
  await p.key('esc'); await p.waitFor('document.getElementById("palette").hidden', 'Escape to close Cmd+K');
  assert.deepEqual(await p.js('__caret()'), at, 'the caret after Cmd+K and Escape');
  await p.key('⌘K'); await p.waitFor('!document.getElementById("palette").hidden', 'Cmd+K to open');
  await p.click(5, 845); await p.waitFor('document.getElementById("palette").hidden', 'a click outside to close Cmd+K');
  await p.js('placeCaret(keyOfEl(' + T('second row') + '))'); await p.key('↩'); await p.type('/');
  await p.waitFor('!document.getElementById("palette").hidden', 'the / menu');
  await p.key('esc'); await p.waitFor('document.getElementById("palette").hidden', 'Escape to close the / menu');
  assert.equal((await p.js('__caret()')).editable, true, 'the caret is back in the row after the / menu');
});

// 6. Out of order (#399, #406, #404, #463, #640): an answer for a page you already left never replaces the one you are on
flow('a slow answer for a page you left does not replace the one you are on', async (p) => {
  await p.start();
  const slow = 'mockdoc0', fast = 'mockdoc3';
  await p.js('(() => { for (const k of ["children", "node", "related", "docInfo", "taskMeta"]) { const f = tana[k]; if (typeof f !== "function") continue; tana[k] = (id, ...a) => new Promise((r) => setTimeout(r, id === ' + J(slow) + ' ? 900 : 20)).then(() => f(id, ...a)); } })()');
  const title = await p.js('tana.node(' + J(fast) + ').then((n) => n.title)');
  await p.js('goTo(' + J(slow) + ')'); await p.sleep(50); await p.js('goTo(' + J(fast) + ')');
  await p.sleep(1500);
  assert.equal(await p.js('document.getElementById("title").textContent'), title, 'the page title after the slow answer came');
  assert.deepEqual(await p.js('__screen()'), await p.js('__saved(' + J(fast) + ')'), 'the rows after the slow answer came');
});

// 7. Live (#148, #265, #406, #436, #488): a change made elsewhere shows at once, and leaves what you are typing alone
flow('a change from elsewhere shows live and keeps your typing', async (p) => {
  await p.start();
  const doc = 'mockdoc0';
  await p.js('goTo(' + J(doc) + ')'); await p.waitFor(T('Agenda'), 'the Agenda row');
  const other = await p.js('items.get(keyOfEl(' + T('Walk through both') + ')).node.id');
  await clickRow(p, 'Agenda'); await p.type(' still typing');
  await p.js('tana.setText(' + J(doc) + ', ' + J(other) + ', "Changed elsewhere")');
  await p.waitFor(T('Changed elsewhere'), 'the change made elsewhere on screen', 3000);
  assert.ok(await p.js(T('Agenda') + '.textContent.includes(" still typing")'), 'the words being typed were wiped by the live change');
  assert.ok(await p.js(T('Agenda') + ' === document.activeElement'), 'the caret left the row being typed in');
  await p.js('flushAll()'); await settle(p, 500);
  const saved = await p.js('__saved(' + J(doc) + ')');
  assert.ok(saved.some((l) => l.includes('Agenda still typing')) && saved.some((l) => l.includes('Changed elsewhere')), 'both edits saved');
  await p.js('setView("library")'); await p.waitFor(T('Check out the new editor'), 'the Library row');
  await p.js('tana.deleteDocument("mockdoc2")');
  await p.waitFor('!' + T('Check out the new editor'), 'a document deleted elsewhere to leave the Library', 3000);
});

(async () => {
  if (process.env.CODEX_SANDBOX) { console.error('flow-check: the agent sandbox refuses the loopback port and Chromium this needs; run it escalated'); process.exit(3); }
  const chrome = findChrome();
  if (!chrome) { console.error('flow-check: no Chromium (set CHROME, or npx playwright install chromium-headless-shell)'); process.exit(1); }
  const server = http.createServer((q, s) => { const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
    if (!f.startsWith(root)) { s.writeHead(403); return s.end(); }
    fs.readFile(f, (e, d) => { s.writeHead(e ? 404 : 200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); s.end(e ? '' : d); });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const port = 9900 + Math.floor(Math.random() * 90);
  const ch = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--no-first-run', '--no-sandbox', '--window-size=1280,860',
    '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'orbflow-')), 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  try {
    let t; for (let i = 0; i < 60 && !t; i++) { await sleep(200); try { t = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page'); } catch { /* not up yet */ } }
    if (!t) throw new Error('Chromium did not start: ' + chrome);
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
    let id = 0; const waiting = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
    // every command answers within 15 s or fails the flow: a page promise left pending must not hang the run (or CI)
    const send = (method, params = {}) => new Promise((r, j) => {
      const n = ++id, timer = setTimeout(() => { waiting.delete(n); j(new Error(method + ' did not answer within 15 s')); }, 15000);
      waiting.set(n, (d) => { clearTimeout(timer); if (d.error) j(new Error(method + ': ' + d.error.message)); else r(d.result || {}); });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH });
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

    // the page a flow drives
    const js = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('in page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  ' + expression.slice(0, 200));
      return r.result.value;
    };
    const waitFor = async (expression, what, ms = 4000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(40)) if (await js('!!(' + expression + ')')) return;
      throw new Error('timed out waiting for ' + (what || expression));
    };
    const key = async (combo, times = 1) => {
      const k = parseKey(combo), b = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.mods };
      for (let i = 0; i < times; i++) {
        await send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...b, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...b });
      }
      await sleep(60);
    };
    const type = async (words) => {
      for (const c of words) {
        const k = NAMED[c] || [c, /[a-z]/i.test(c) ? 'Key' + c.toUpperCase() : '', c.toUpperCase().charCodeAt(0), c];
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k[0], code: k[1], windowsVirtualKeyCode: k[2], text: c, unmodifiedText: c });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k[0], code: k[1], windowsVirtualKeyCode: k[2] });
      }
      await sleep(60);
    };
    // a fresh page on the mock, signed in.
    // real: mock ids read as tana: ids (manual/scenes/kit.js REAL), for what only a real id draws (sensitive marks); the change
    // listeners registered at load keep the mock's own ids, so a flow that needs live changes leaves it off
    const start = async ({ real = false } = {}) => {
      await send('Storage.clearDataForOrigin', { origin: base, storageTypes: 'local_storage' });
      await send('Page.navigate', { url: base + '/index.html' });
      await waitFor('document.readyState === "complete" && typeof render === "function"', 'the page to load', 8000);
      if (real) await js(REAL);
      await js(HELPERS);
      await js('document.getElementById("login").click()'); await waitFor('document.querySelector("#outline .node")', 'the first rows', 8000);
    };
    const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); await sleep(80); };
    const page = { js, waitFor, key, type, click, start, sleep };

    for (const f of flows) {
      if (only && !f.name.includes(only)) continue;
      const t0 = Date.now();
      try {
        await f.run(page);
        const errors = await js('window.__errors');
        assert.deepEqual(errors, [], 'the page reported errors');
        console.log('ok   ' + f.name + ' (' + (Date.now() - t0) + ' ms)');
      } catch (e) {
        failed++;
        console.log('FAIL ' + f.name + '\n     ' + String(e.stack || e).split('\n').slice(0, 6).join('\n     '));
        try { const errors = await js('window.__errors'); if (errors?.length) console.log('     page errors:\n       ' + errors.join('\n       ').slice(0, 2000)); } catch { /* page gone */ }
      }
    }
    ws.close();
  } finally { ch.kill(); server.close(); }
  if (failed) { console.log(failed + ' flow(s) failed'); process.exit(1); }
  console.log('flow-check passed');
})().catch((e) => { console.error(e.stack || e); process.exit(1); });


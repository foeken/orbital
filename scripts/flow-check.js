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
  // a drag as Chromium delivers one (renderer/drag.js): dragstart on the row's grip, dragover and drop where the
  // pointer is, dragend on the grip. The grip is what the row offers to be picked up by (draggable="true"), none when
  // it offers nothing. line: the drop line was drawn while the row hung over the place
  window.__drag = (row, x, y) => {
    const grip = row.querySelector('.line[draggable="true"], .bullet[draggable="true"]');
    if (!grip) return { grip: false };
    const dt = new DataTransfer(), fire = (type, el) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }));
    fire('dragstart', grip);
    const accepted = !fire('dragover', document.elementFromPoint(x, y)), drop = document.getElementById('dropline'), line = !!drop && !drop.hidden;
    if (accepted) fire('drop', document.elementFromPoint(x, y));
    fire('dragend', grip);
    return { grip: true, accepted, line };
  };
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
// a click on a row's first words, where a click on a Timeline row opens what it is about: the rest of a long row's
// line is blank space, which opens nothing (render.js onRowBlank)
const clickWords = async (p, words) => {
  await p.waitFor(T(words), 'a row with ' + J(words));
  await p.js(T(words) + '.scrollIntoView({ block: "center", behavior: "instant" })'); await settle(p, 150); // measured once the page is still
  const [x, y] = await p.js('(() => { const r = document.createRange(); r.selectNodeContents(' + T(words) + '); const b = r.getClientRects()[0]; return [b.left + Math.min(20, b.width / 2), b.top + b.height / 2]; })()');
  await p.click(x, y);
};
// the row holding words, and the box of its line, scrolled into view so the pointer can reach it
const rowOf = (words) => '(' + T(words) + ').closest(".node")';
const lineOf = async (p, words) => {
  await p.js(rowOf(words) + '.scrollIntoView({ block: "center", behavior: "instant" })'); await settle(p, 150);
  return p.js('(() => { const b = ' + rowOf(words) + '.querySelector(".line").getBoundingClientRect(); return { left: b.left, top: b.top, bottom: b.bottom, mid: b.top + b.height / 2 }; })()');
};
// Cmd+K (or another palette key), the words typed, and Enter once the row it should run is the active one
const command = async (p, words, label, key = '⌘K') => {
  if (key) { await p.key(key); await p.waitFor('!document.getElementById("palette").hidden', 'the palette'); }
  await p.type(words);
  await p.waitFor('palRows[palIndex] && palRows[palIndex].label === ' + J(label), J(label) + ' as the active row');
  await p.key('↩');
};
const at = (p, docId) => p.waitFor('zoom && zoom.docId === ' + J(docId) + ' && document.getElementById("title").textContent', 'the page ' + docId);
// Escape until the palette is closed: on a page of it (Edit pins) the first goes back to Cmd+K
const closePalette = async (p) => { for (let i = 0; i < 3 && !(await p.js('document.getElementById("palette").hidden')); i++) await p.key('esc'); };

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

// 8. Timeline Copy link: a right-click on a meeting that has been is ⌘K on that row, and Copy link copies the meeting's
// link, not the Timeline's (which has none)
flow('Copy link on a Timeline meeting copies the meeting', async (p) => {
  await p.start({ real: true });
  await p.js("goTo('orbital:timeline')");
  const row = '[...document.querySelectorAll("#outline .node.tl-meeting")].find((n) => items.get(n.dataset.key)?.node.timeline?.uri)';
  await p.waitFor(row, 'a meeting on the Timeline');
  const uri = await p.js(row + '.querySelector(".text") && items.get(' + row + '.dataset.key).node.timeline.uri');
  await p.js('(() => { const t = ' + row + '.querySelector(".text"), r = t.getBoundingClientRect(), at = { bubbles: true, cancelable: true, button: 2, clientX: r.left + 4, clientY: r.top + r.height / 2 };' +
    ' t.dispatchEvent(new MouseEvent("mousedown", at)); t.dispatchEvent(new MouseEvent("contextmenu", at)); })()');
  await p.waitFor('!document.getElementById("palette").hidden', 'Cmd+K on the right-clicked row');
  await p.js('window.copyText = (text) => { window.__copied = text; }');
  await p.js('palRows.find((r) => r.id === "copyLink").run()');
  await p.waitFor('window.__copied', 'the link copied');
  assert.equal(await p.js('window.__copied'), await p.js('tana.nodeLink(' + J(uri) + ')'), 'Copy link copied the meeting\u2019s link');
  await p.key('esc');
});
// 9. The Settings window (settings.html): each control makes its call, an answer older than a newer one is dropped
// (#673 review), the keyboard stays on the control that had it, and demo mode masks your email and hidden titles
const SETTINGS_API = String.raw`(() => {
  window.__calls = []; window.__slow = [];
  const call = (name, answer) => (...a) => { __calls.push([name, ...a]); return Promise.resolve(typeof answer === 'function' ? answer(...a) : answer); };
  const AI = { models: ['gpt-6-luna', 'gpt-5.6-terra'], quickModel: 'gpt-6-luna', quickEffort: 'low', quickEfforts: ['low', 'high'], model: 'gpt-5.6-terra', effort: 'low', efforts: ['low', 'high'] };
  let hidden = ['Secret project'], agents = [{ id: 'tana', label: 'Tana', icon: 'tana', installed: true, enabled: true }, { id: 'codex', label: 'Codex', icon: 'robot', installed: true, enabled: true, isDefault: true },
    { id: 'dot', label: 'Dot', icon: 'chatgpt', installed: false, enabled: false, missing: 'Install the ChatGPT app', setup: "Paste your dot's chat link" }];
  start({ prefs: { theme: 'light' }, translate: () => {}, onSettings: (fn) => { window.__settings = fn; },
    aiOptions: () => new Promise((resolve) => __slow.push(() => resolve(AI))), setAiOption: call('setAiOption', (k, v) => ({ ...AI, [k]: v })),
    chatgptStatus: async () => ({ available: true, signedIn: true, email: 'robin@private.example' }), chatgptLogout: call('chatgptLogout', { available: true, signedIn: false }),
    agentList: async () => agents, enableAgent: call('enableAgent', (id, on, setup) => (agents = agents.map((a) => (a.id === id ? { ...a, enabled: on, ...(setup ? { installed: true, setup: '' } : {}) } : a)))),
    setDefaultAgent: call('setDefaultAgent', () => agents), filters: async () => hidden,
    addFilter: call('addFilter', (p) => (hidden = [...hidden, p])), removeFilter: call('removeFilter', (p) => (hidden = hidden.filter((h) => h !== p))),
    mcpHidden: async () => true, setMcpHidden: call('setMcpHidden', (on) => on), setPref: call('setPref'), settingsSize: (h) => { __calls.push(['settingsSize', h]); } });
})()`;
flow('the Settings window writes what you pick and shows what is newest', async (p) => {
  await p.start();
  const open = async (demo) => {
    await p.js('localStorage.setItem("demoMode", ' + J(demo ? '1' : '0') + '); localStorage.removeItem("settingsTab"); location.href = "/settings.html"; 1');
    await p.waitFor('document.readyState === "complete" && typeof start === "function"', 'the Settings window', 8000);
    await p.js(SETTINGS_API);
  };
  const tab = (id) => p.js('document.querySelector(\'[data-key="tab/' + id + '"]\').click(); 1');
  const shown = () => p.js('document.body.innerText');
  await open(false);
  assert.equal(await p.js('document.title'), 'General', 'the window opens on General, titled by its tab');
  await p.js('document.querySelector(\'[data-key="theme/dark"]\').click(); 1');
  assert.deepEqual(await p.js('[document.documentElement.dataset.theme, __calls.find((c) => c[0] === "setPref")]'), ['dark', ['setPref', 'theme', 'dark']], 'Dark is stored and the window follows it');
  // the AI tab: a read still out when a model is picked lands last, and must not put the old model back
  await tab('ai'); await p.js('__slow.shift()(); 1'); await settle(p, 100);
  await p.js('__settings({ theme: "dark" }); 1'); // something changed elsewhere: the window reads again, and that read is slow
  await p.js('(() => { const s = document.querySelector(\'[data-key="quickModel"]\'); s.value = "gpt-5.6-terra"; s.dispatchEvent(new Event("change")); })()'); await settle(p, 100);
  await p.js('__slow.shift()(); 1'); await settle(p, 100);
  assert.equal(await p.js('document.querySelector(\'[data-key="quickModel"]\').value'), 'gpt-5.6-terra', 'the newest answer stands');
  assert.deepEqual(await p.js('__calls.find((c) => c[0] === "setAiOption")'), ['setAiOption', 'quickModel', 'gpt-5.6-terra'], 'the pick is stored as Cmd+K Choose models stores it');
  // the Agents tab, by keyboard: the switch keeps the keyboard through the redraw its answer brings
  await tab('agents');
  await p.js('document.querySelector(\'[data-key="agent/codex"]\').focus(); 1'); await p.key('Space'); await settle(p, 150);
  assert.deepEqual(await p.js('[__calls.find((c) => c[0] === "enableAgent"), document.activeElement.dataset.key, document.activeElement.getAttribute("aria-checked")]'),
    [['enableAgent', 'codex', false], 'agent/codex', 'false'], 'Space switches Codex off, and the keyboard is still on its switch');
  // Dot needs its chat link before it can be on: its switch asks for the link in its row, and only the paste switches it on
  await p.js('document.querySelector(\'[data-key="agent/dot"]\').click(); 1'); await settle(p, 100);
  assert.equal(await p.js('__calls.filter((c) => c[0] === "enableAgent").length'), 1, 'Dot is not switched on without its link');
  await p.type('codex://threads/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'); await p.key('↩'); await settle(p, 150);
  assert.deepEqual(await p.js('[__calls.filter((c) => c[0] === "enableAgent").at(-1), document.querySelector(\'[data-key="agent/dot"]\').getAttribute("aria-checked"), !!document.querySelector("input.link")]'),
    [['enableAgent', 'dot', true, 'codex://threads/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'], 'true', false], 'the pasted link switches Dot on, and the field goes');
  // the Lists tab: + and a title hides it, ⌫ on a selected one unhides it
  await tab('lists');
  await p.js('document.querySelector(\'[data-key="hidden+"]\').click(); 1'); await p.type('Lunch*'); await p.key('↩'); await settle(p, 150);
  await p.js('document.querySelector(\'[data-key="hidden/Secret project"]\').click(); document.querySelector(\'[data-key="hidden/Secret project"]\').focus(); 1'); await p.key('⌫'); await settle(p, 150);
  assert.deepEqual(await p.js('__calls.filter((c) => /Filter$/.test(c[0]))'), [['addFilter', 'Lunch*'], ['removeFilter', 'Secret project']], 'a title hidden and one unhidden');
  assert.deepEqual(await p.js('[...document.querySelectorAll(".item")].map((b) => b.textContent)'), ['Lunch*'], 'the list shows what main answered');
  assert.ok(await p.js('__calls.filter((c) => c[0] === "settingsSize").length >= 3'), 'the window was told each tab\u2019s height');
  // demo mode: the email and the hidden titles are masked
  await open(true);
  await tab('ai'); await p.js('__slow.shift()(); 1'); await settle(p, 100);
  assert.ok(!(await shown()).includes('robin@private'), 'demo mode shows no real email');
  await tab('lists'); await settle(p, 100);
  assert.ok(!(await shown()).includes('Secret project'), 'demo mode shows no real hidden title');
});

// ---- Golden paths: what someone does every day, start to end, by key and by pointer as they would ----
// The flows above guard the kinds of break that came back PR after PR; these guard the paths themselves, so a change
// that breaks opening the Timeline, pinning, getting around or dragging fails here even when it is a new kind of break.

// 10. The Timeline (#135): a first launch opens on it, a row opens what it is about by click or Enter, ⌘[ comes back,
// a task ticked under Today's Tasks is saved as done, and its end reads three more days
flow('golden path: the Timeline opens first and leads to what each row is about', async (p) => {
  await p.start();
  await settle(p, 400); // the first read of the page lands in parts (renderer/timeline.js): clicked once it is whole
  assert.equal(await p.js('zoom && zoom.docId'), 'orbital:timeline', 'a first launch opens on the Timeline');
  const top = await p.js('__screen()');
  assert.equal(top[0], "Today's Tasks", 'Today\u2019s Tasks leads the page');
  assert.ok(top.includes('Upcoming meetings'), 'today\u2019s meetings to come are listed');
  assert.deepEqual(await p.js('[...document.querySelectorAll("#outline .ghead")].map((h) => h.textContent.trim())'), ['Today', 'Yesterday'], 'the history in day sections');
  const back = async () => { await p.key('⌘['); await at(p, 'orbital:timeline'); };
  // a click on an edit opens the task edited
  await clickWords(p, 'Sam Okafor edited');
  await at(p, 'mockdoc0');
  assert.equal(await p.js('document.getElementById("title").textContent'), await p.js('tana.node("mockdoc0").then((n) => n.title)'), 'the edited task opened');
  await back();
  // Enter on a row opens it too
  await p.js('(' + T('Tomas Ilves accepted') + ').focus()'); await p.key('↩');
  await at(p, 'mockdoc5');
  await back();
  // a meeting still to come opens its page
  await clickWords(p, '1-1 with Priya');
  await at(p, 'mockmeeting7');
  await back();
  // ticked under Today's Tasks: saved as done, and ticked again it is open again
  const box = rowOf('Organise working sessions') + '.querySelector(".check")', state = () => p.js('tana.node("mockdoc5").then((n) => n.stateType)');
  await p.js(box + '.click()'); await settle(p, 400);
  assert.deepEqual([await state(), await p.js(box + '.checked')], ['closed', true], 'a task ticked on the Timeline is saved as done');
  await p.js(box + '.click()'); await settle(p, 400);
  assert.deepEqual([await state(), await p.js(box + '.checked')], ['open', false], 'ticked again, it is open again');
  // the end of the page reads three days more. Counted from where it stands: scrolling near the end reads on by
  // itself (timelineEnd), so the rows opened above may already have brought more days in
  await p.waitFor('!timelineLoading', 'any read already under way');
  const pages = await p.js('timelinePages');
  await p.js('document.querySelector(".tl-older").click()');
  await p.waitFor('timelinePages > ' + pages + ' && !timelineLoading && document.querySelector(".tl-older")?.textContent === "Show three more days"', 'three more days read');
});

// 11. Pins (docs/PINNING.md): pinned to today it is on the Timeline's Today's Tasks; pinned to the sidebar and on a
// meeting it is listed in Edit pins, where each ↩ takes one off, until it is pinned nowhere and gone from the Timeline.
// Typed into Edit pins, ↩ runs the row the words found, not the "No pin matches" note above it
flow('golden path: pin to today, the sidebar and a meeting, then unpin each in Edit pins', async (p) => {
  await p.start();
  const doc = 'tana:text:mockpin0', title = 'Prepare the offsite agenda', pins = () => p.js('tana.pinState(' + J(doc) + ')');
  const onToday = async () => { await p.js("goTo('orbital:timeline')"); await at(p, 'orbital:timeline'); await settle(p, 300);
    const s = await p.js('__screen()'); return s.indexOf('  ' + title) > 0 && s.indexOf('  ' + title) < s.indexOf('Upcoming meetings'); };
  await p.js('goTo(' + J(doc) + ')'); await at(p, doc);
  await command(p, 'pin to today', 'Pin to today');
  await p.waitFor('tana.pinState(' + J(doc) + ').then((s) => s.dates.includes(localDate()))', 'the pin for today');
  assert.ok(await onToday(), 'a task pinned to today is under Today\u2019s Tasks');
  await p.js('goTo(' + J(doc) + ')'); await at(p, doc);
  await command(p, 'edit pins', 'Edit pins');
  await p.waitFor('palRows.some((r) => r.label === "Pin to sidebar")', 'Edit pins');
  await command(p, 'sidebar', 'Pin to sidebar', null);
  await p.waitFor('palRows.some((r) => r.group === PIN_GROUP && r.label === "Sidebar")', 'Sidebar listed as pinned');
  await closePalette(p);
  await command(p, 'pin to meeting', 'Pin to meeting \u2026');
  await command(p, 'Leadership', 'Leadership sync', null);
  await p.waitFor('tana.pinState(' + J(doc) + ').then((s) => s.hubs.some((h) => h.id === "mockmeeting2"))', 'the pin on Leadership sync');
  assert.deepEqual(await pins(), { sidebar: true, dates: [await p.js('localDate()')], hubs: [{ id: 'mockmeeting2', title: 'Leadership sync', kind: 'meeting' }] }, 'pinned in all three places');
  // Edit pins lists the three, and ↩ on each takes it off
  await closePalette(p);
  await command(p, 'edit pins', 'Edit pins');
  await p.waitFor('palRows.filter((r) => r.group === PIN_GROUP && r.run).length === 3', 'three pins listed');
  for (let left = 2; left >= 0; left--) {
    await p.key('↩');
    await p.waitFor('palRows.filter((r) => r.group === PIN_GROUP && r.run).length === ' + left, left + ' pins left');
  }
  await closePalette(p);
  assert.deepEqual(await pins(), { sidebar: false, dates: [], hubs: [] }, 'pinned nowhere');
  assert.equal(await onToday(), false, 'unpinned from today, it left Today\u2019s Tasks');
});

// 12. Getting around (#657): ⌘S finds a page, a bullet zooms into its row and a child's bullet into that, ⌘[ walks
// back through each to where it started and ⌘] forward again
flow('golden path: find a page, zoom in twice, and walk back and forward', async (p) => {
  await p.start();
  const where = () => p.js('[zoom.docId, zoom.nodeId ? document.getElementById("title").textContent : null]');
  await command(p, 'Schedule something', 'Schedule something with Sam Okafor and Dana Brooks', '⌘s');
  await at(p, 'mockdoc0');
  await p.js(rowOf('Walk through both') + '.querySelector(".bullet").click()');
  await p.waitFor('zoom.nodeId && document.getElementById("title").textContent === "Walk through both Studio pilots"', 'the zoom into the row');
  assert.deepEqual(await p.js('__screen()'), ['Onboarding buddies', 'Shared cost tracking', '  Finance joins for this part'], 'the zoomed row\u2019s children');
  await p.js(rowOf('Shared cost tracking') + '.querySelector(".bullet").click()');
  await p.waitFor('document.getElementById("title").textContent === "Shared cost tracking"', 'the zoom into the child');
  assert.deepEqual(await p.js('__screen()'), ['Finance joins for this part'], 'a child\u2019s bullet redraws the page on that child (#657)');
  const walk = [['mockdoc0', 'Walk through both Studio pilots'], ['mockdoc0', null], ['orbital:timeline', null]];
  for (const place of walk) { await p.key('⌘['); await settle(p, 300); assert.deepEqual(await where(), place, '⌘[ back to ' + J(place)); }
  await p.key('⌘]'); await settle(p, 300);
  assert.deepEqual(await where(), ['mockdoc0', null], '⌘] forward again');
});

// 13. Dragging a row (renderer/drag.js): the drop line shows where it will land, the row lands there on screen and in
// what is saved alike, one level in when the pointer is a step to the right, and ⌘Z puts it back
flow('golden path: drag a row to reorder it, nest it, and undo', async (p) => {
  await p.start();
  const same = async (docId, step) => {
    await p.js('flushAll()'); await settle(p, 450);
    const [screen, saved] = [await p.js('__screen()'), await p.js('__saved(' + J(docId) + ')')];
    assert.deepEqual(screen, saved, 'screen and saved outline differ after ' + step);
    return saved;
  };
  const id = await p.js("tana.createDocument('Drag test').then((n) => { goTo(n.id); return n.id; })");
  await p.waitFor('document.activeElement && document.activeElement.isContentEditable', 'the caret in the new page');
  await p.type('one'); await p.key('↩'); await p.type('two'); await p.key('↩'); await p.type('three');
  await same(id, 'typing');
  let to = await lineOf(p, 'one');
  assert.deepEqual(await p.js('__drag(' + rowOf('three') + ', ' + (to.left + 30) + ', ' + (to.top + 3) + ')'), { grip: true, accepted: true, line: true }, 'three picked up, the line drawn above one, the drop taken');
  assert.deepEqual(await same(id, 'a drag to the top'), ['three', 'one', 'two']);
  await p.key('⌘z');
  assert.deepEqual(await same(id, '⌘Z after the drag'), ['one', 'two', 'three']);
  // one level in: dropped under a row with children, the pointer a step to the right, it becomes its first child
  await p.js("goTo('mockdoc0')"); await p.waitFor(T('Walk through both'), 'the page with the pilots');
  to = await lineOf(p, 'Walk through both');
  assert.equal((await p.js('__drag(' + rowOf('Book a room on the fourth') + ', ' + (to.left + 33 + 12) + ', ' + (to.bottom - 2) + ')')).accepted, true, 'the drop inside taken');
  await p.js('flushAll()'); await settle(p, 450);
  const from = (lines, first, n) => lines.slice(lines.indexOf(first), lines.indexOf(first) + n);
  const nested = ['Walk through both Studio pilots', '  Book a room on the fourth floor', '  Onboarding buddies', '  Shared cost tracking', '    Finance joins for this part'];
  assert.deepEqual(from(await p.js('__saved("mockdoc0")'), nested[0], 5), nested, 'saved as the first child');
  assert.deepEqual(from(await p.js('__screen()'), nested[0], 5), nested, 'drawn as the first child');
  assert.deepEqual(from(await p.js('__saved("mockdoc0")'), 'Next steps', 3), ['Next steps', '  Send both slots to Sam and Dana'], 'gone from where it was');
});

// 14. Dragging onto a meeting (#520): a task under Today's Tasks dropped on a meeting on the Timeline is pinned to it,
// and the Timeline's own record rows offer nothing to pick up
flow('golden path: a task dragged onto a meeting is pinned there', async (p) => {
  await p.start({ real: true }); // a meeting takes a drop by its tana:event: id, and only a real node can be pinned
  await p.waitFor(T('Leadership sync'), 'the meeting on the Timeline');
  assert.equal((await p.js('__drag(' + rowOf('Sam Okafor edited') + ', 0, 0)')).grip, false, 'a Timeline record row is not something to pick up');
  const to = await lineOf(p, 'Leadership sync');
  assert.deepEqual(await p.js('__drag(' + rowOf('Check out the new editor') + ', ' + (to.left + 120) + ', ' + to.mid + ')'), { grip: true, accepted: true, line: false }, 'the task taken by the meeting, with no outline line');
  await p.waitFor('tana.pinState("tana:text:mockdoc2").then((s) => s.hubs.some((h) => h.id === "tana:event:mockmeeting2"))', 'the task pinned to Leadership sync');
  await p.waitFor('[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("Pinned to Leadership sync"))', 'the note that says so');
});

// 15. A task's life from Cmd+K (docs/OUTLINER.md): its status set by name, handed to someone, completed with ⌘↩ and
// reopened with it, each saved as it is pressed
flow('golden path: set a task\u2019s status, assign it, complete and reopen it', async (p) => {
  await p.start();
  const doc = 'tana:text:mockpin1', task = () => p.js('Promise.all([tana.node(' + J(doc) + '), tana.taskMeta(' + J(doc) + ')]).then(([n, m]) => [n.stateType, m.assignees])');
  await p.js('goTo(' + J(doc) + ')'); await at(p, doc);
  assert.deepEqual(await task(), ['open', ['tana:user-profile:robin']], 'an open task of yours to start with');
  await command(p, 'waiting', 'Set status to Waiting');
  await p.waitFor('tana.node(' + J(doc) + ').then((n) => n.stateType === "waiting")', 'the status Waiting saved');
  await closePalette(p);
  await command(p, 'assign to sam', 'Assign to Sam Okafor');
  await p.waitFor('tana.taskMeta(' + J(doc) + ').then((m) => m.assignees.join() === "tana:user-profile:sam")', 'the task handed to Sam');
  await closePalette(p);
  await p.key('⌘↩');
  await p.waitFor('tana.node(' + J(doc) + ').then((n) => n.stateType === "closed")', '⌘↩ to complete it');
  await p.key('⌘↩');
  await p.waitFor('tana.node(' + J(doc) + ').then((n) => n.stateType === "open")', '⌘↩ again to reopen it');
  assert.deepEqual(await task(), ['open', ['tana:user-profile:sam']], 'reopened, and still Sam\u2019s');
});

// 16. Quick Add Task (task.html, ⇧⌘Space), on a stand-in for main as the Settings flow is: a title, a type with ↓, an
// assignee with ⇥ and a few letters, and ↩ makes the task, hands it over and tells the window what it made
const QUICK_ADD_API = String.raw`if (location.pathname === '/task.html') { window.__calls = [];
  const people = [['robin', 'Robin Vega', true], ['sam', 'Sam Okafor'], ['priya', 'Priya Raman']].map(([k, title, me]) => ({ id: 'tana:user-profile:' + k, title, me: !!me }));
  window.api = { members: async () => people, taskTypes: async () => [{ uri: 'tana:type:bug', title: 'Bug', hue: 10 }, { uri: 'tana:type:decision', title: 'Decision', hue: 150 }], clipboardHasImage: async () => false,
    createDocument: async (title, opts) => { __calls.push(['createDocument', title, opts]); return { id: 'tana:text:quick1', title }; },
    setAssignees: async (id, uris) => { __calls.push(['setAssignees', id, uris]); }, closeOverlay: (result) => { __calls.push(['closeOverlay', result]); } }; }`;
flow('golden path: Quick Add Task makes a typed task for someone', async (p) => {
  await p.beforeLoad(QUICK_ADD_API);
  await p.open('task.html');
  await p.waitFor('document.activeElement && document.activeElement.id === "taskTitle" && document.querySelectorAll("#taskTypes .row").length === 3', 'the card with its title field and three types');
  const picks = () => p.js('document.getElementById("taskPicks").textContent');
  assert.equal(await picks(), 'Task · Assigned to Me⇥', 'a plain task of yours by default');
  await p.type('Fix the login loop'); await p.key('↓');
  assert.equal(await picks(), 'Bug · Assigned to Me⇥', '↓ picks the next type');
  await p.key('⇥'); await p.type('pri');
  assert.deepEqual(await p.js('[...document.querySelectorAll("#taskTypes .row")].map((r) => r.textContent)'), ['Priya Raman↩'], '⇥ and a few letters find the person');
  await p.key('↩');
  assert.deepEqual([await p.js('document.getElementById("taskTitle").value'), await picks()], ['Fix the login loop', 'Bug · Assigned to Priya Raman⇥'], '↩ picks them and the title comes back');
  await p.key('↩');
  await p.waitFor('__calls.some((c) => c[0] === "closeOverlay")', 'the card to close');
  assert.deepEqual(await p.js('__calls'), [['createDocument', 'Fix the login loop', { kind: 'task', typeUri: 'tana:type:bug' }], ['setAssignees', 'tana:text:quick1', ['tana:user-profile:priya']],
    ['closeOverlay', { note: 'Task created: Fix the login loop, assigned to Priya Raman', open: 'tana:text:quick1' }]], 'the task made as a Bug, handed to Priya, and the window told');
});

// 17. Writing on today's page: ⌘K Today opens it, "/" turns a row into a heading or a checklist, "@" links a node or a
// day, and every row is saved as it reads
flow('golden path: write on Today\u2019s page with / blocks, @ links and dates', async (p) => {
  await p.start();
  await command(p, 'today', 'Today');
  await p.waitFor('zoom && document.getElementById("title").textContent === localDate()', 'today\u2019s page');
  const day = await p.js('zoom.docId');
  await p.js('document.querySelector("#outline .node .text").focus(); placeCaret(keyOfEl(document.querySelector("#outline .node .text")), 0)');
  await p.type('/'); await p.waitFor('palMode === "slash"', 'the / menu'); await p.type('heading 2');
  await p.waitFor('palRows[palIndex]?.label === "Heading 2"', 'Heading 2 offered'); await p.key('↩');
  await p.type('Plan'); await p.key('↩');
  await p.type('See '); await p.type('@'); await p.waitFor('palMode === "search"', 'the @ picker'); await p.type('Check out');
  await p.waitFor('palRows[palIndex]?.label === "Check out the new editor"', 'the task found'); await p.key('↩');
  await p.type(' by '); await p.type('@'); await p.type('friday');
  await p.waitFor('palRows[palIndex]?.date', 'Friday offered as a day'); await p.key('↩');
  await p.key('↩'); await p.type('/'); await p.type('checklist'); await p.waitFor('palRows[palIndex]?.label === "Checklist"', 'Checklist offered'); await p.key('↩');
  await p.type('Buy cake');
  await p.js('flushAll()'); await settle(p, 500);
  const friday = await p.js('parseDay("friday")');
  const saved = await p.js('tana.children(' + J(day) + ').then((rows) => rows.map((n) => ({ block: n.block || null, done: n.done ?? null, segments: n.segments })))');
  assert.deepEqual(saved, [
    { block: 'heading2', done: null, segments: [{ text: 'Plan' }] },
    { block: null, done: null, segments: [{ text: 'See ' }, { mention: { label: 'Check out the new editor', uri: 'mockdoc2', icon: 'task' } }, { text: ' by ' }, { mention: { label: await p.js('dayLabel(' + J(friday) + ')'), uri: 'tana:plaindate:' + friday } }] },
    { block: null, done: 0, segments: [{ text: 'Buy cake' }] }], 'a heading, a row linking a task and a day, and a checklist row, saved as they read');
});

// 18. A view (docs/VIEWS.md): the Library grouped, sorted and filtered from Cmd+K and ⌘F, then saved as a search that
// opens on the same rows
flow('golden path: group, sort and filter the Library, then save it as a search', async (p) => {
  await p.start();
  await command(p, 'library', 'Library'); await p.waitFor('viewOf()?.id === "library" && document.querySelector("#outline .node")', 'the Library');
  await command(p, 'group by none', 'Group by None'); await closePalette(p);
  await p.waitFor('groupBy() === "none" && !document.querySelector("#outline .ghead")', 'one list, no sections');
  await command(p, 'sort by title', 'Sort by Title'); await closePalette(p); await settle(p, 300);
  const all = await p.js('__screen()');
  assert.ok(all.length > 10, 'the whole Library listed');
  assert.deepEqual(all, [...all].sort((a, b) => a.localeCompare(b)), 'sorted by title');
  await p.key('⌘f'); await p.waitFor('document.activeElement === filterEl', 'the filter field');
  await p.type('offsite'); await settle(p, 500);
  const offsite = ['Book a room for the offsite', 'Prepare the offsite agenda', 'Terugblik offsite Studio'];
  assert.deepEqual(await p.js('__screen()'), offsite, '⌘F keeps the rows with the words');
  await p.key('esc'); await settle(p, 300);
  assert.deepEqual([await p.js('filterEl.value'), (await p.js('__screen()')).length], ['', all.length], 'Escape clears the filter');
  await p.key('⌘f'); await p.type('offsite'); await settle(p, 400);
  await command(p, 'save as', 'Save as new search');
  await p.waitFor('zoom && String(zoom.docId).startsWith("tana:search:")', 'the saved search to open');
  await settle(p, 400);
  assert.deepEqual([...await p.js('__screen()')].sort(), offsite, 'the saved search lists what the view showed');
});

// 19. Notifications and Proposals (#135 family): a bullet marks one read, Mark all as read the rest, a row opens what
// it is about; a proposal approved from Cmd+K and one rejected with its button both leave the page
flow('golden path: read notifications and settle proposals', async (p) => {
  await p.start();
  await p.js("goTo('orbital:notifications')"); await at(p, 'orbital:notifications');
  const unread = () => p.js('[document.querySelectorAll("#outline .node.unread").length, inboxUnread]');
  await p.waitFor('document.querySelectorAll("#outline .node.unread").length === 2', 'two unread');
  await p.js('document.querySelector("#outline .node.unread .bullet").click()');
  await p.waitFor('document.querySelectorAll("#outline .node.unread").length === 1', 'one read with its bullet');
  await command(p, 'mark all', 'Mark all as read'); await closePalette(p);
  await p.waitFor('document.querySelectorAll("#outline .node.unread").length === 0', 'the rest read');
  assert.deepEqual(await unread(), [0, 0], 'nothing unread, and the count says so');
  await clickWords(p, 'Priya Raman added you');
  await at(p, 'mockmeeting2');
  await p.js("goTo('orbital:proposals')"); await at(p, 'orbital:proposals');
  await p.waitFor(T('Check out the new editor'), 'the proposals');
  const before = await p.js('__screen()');
  await p.js('(' + T('Check out the new editor') + ').focus()');
  await command(p, 'approve', 'Approve proposal'); await closePalette(p);
  await p.waitFor('!' + T('Check out the new editor'), 'the approved one gone');
  await p.js(rowOf('Studio LT charter') + '.querySelector(".pbutton:not(.approve)").click()');
  await p.waitFor('!' + T('Studio LT charter'), 'the rejected one gone');
  assert.deepEqual(await p.js('__screen()'), before.filter((t) => !/^(Check out the new editor|Studio LT charter)$/.test(t)), 'the others stay');
});

// Link to agent (main/agents/linked.js, docs/AGENT-RELAY.md): ⌘K Link to agent shows the prompt that carries a one-time
// code; while the page waits the agent links itself (the mock's GrokBot, on the third time the page asks), the palette
// closes on its name, and from then on it is one of your agents, with a page of its own to rename or unlink it
flow('golden path: link an agent with a code, and it joins your agents', async (p) => {
  await p.start();
  await command(p, 'link to agent', 'Link to agent \u2026');
  await p.waitFor('palMode === "linkAgent" && palRows.length === 4', 'the instructions and the wait');
  assert.deepEqual(await p.js('[palRows[0].label, !!palRows[0].disabled, palIndex]'), ['Copy instructions for your agent', false, 0], 'the first row copies the instructions, and ↩ is on it');
  assert.match(await p.js('relayCtx.prompt'), /^Add two MCP servers to yourself: Orbital at https:\/\/orbital\.md\/mcp and Tana at https:\/\/home\.tana\.inc\/mcp\. Then .* 7KQX-M2PD and a short name for yourself\.$/, 'what it copies: both servers, and the code');
  assert.equal(await p.js('document.querySelector("#palette .list").textContent.includes("7KQX-M2PD")'), false, 'which the card does not show');
  assert.match(await p.js('palRows[1].label'), /^Only ids go through orbital\.md: your words stay in Tana/, 'it says what goes through orbital.md');
  assert.deepEqual(await p.js('[palRows[2].label, !!document.querySelector("#palette .row .label.sweep")]'), ['Waiting for an agent to use the code…', true], 'and waits with a light passing over its words');
  assert.match(await p.js('palRows[2].hint'), /^Works once · \d+:\d\d left$/, 'saying how long the code lasts');
  await p.waitFor('document.getElementById("palette").hidden && document.getElementById("toast").textContent === "Linked GrokBot · Grok"', 'the palette to close on the agent that linked', 10000);
  await command(p, 'choose agents', 'Choose agents \u2026');
  await p.waitFor('palMode === "agents" && palRows.some((r) => r.label === "GrokBot")', 'GrokBot among your agents');
  assert.deepEqual(await p.js('(({ group, hint }) => [group, hint])(palRows.find((r) => r.label === "GrokBot"))'), ['Linked through orbital.md/mcp · ↩ opens one', 'On · Grok · seen just now'], 'linked, on, and where it runs');
  assert.ok(await p.js('palRows.some((r) => r.group === "Default agent · ↩ makes it the default" && r.label === "GrokBot")'), 'and it can be the default');
  await p.type('grokbot');
  await p.waitFor('palRows[palIndex] && palRows[palIndex].label === "GrokBot"', 'its row');
  await p.key('↩');
  await p.waitFor('palMode === "linkedAgent"', 'its page');
  assert.deepEqual(await p.js('palRows.map((r) => r.label)'), ['Rename \u2026', 'Switch off', 'Unlink'], 'rename, switch off, unlink');
  await p.type('unlink'); await p.waitFor('palRows[palIndex] && palRows[palIndex].label === "Unlink"', 'Unlink'); await p.key('↩');
  await p.waitFor('palMode === "agents" && !palRows.some((r) => r.label === "GrokBot")', 'Choose agents without it');
  await closePalette(p);
});

// 20. A chat (docs/CHATS.md): a message typed in the composer is sent with ↩, shows as yours at once, and Tana's answer
// follows below it
flow('golden path: send a chat message and read the answer', async (p) => {
  await p.start();
  await p.js("goTo('tana:chat:mockchat0')"); await p.waitFor('document.getElementById("composerText") && document.querySelector(".chat-msg")', 'the conversation');
  const mine = await p.js('document.querySelectorAll(".chat-msg.mine").length');
  await p.js('document.getElementById("composerText").focus()'); await p.type('Summarise the pilots'); await p.key('↩');
  await p.waitFor('document.querySelectorAll(".chat-msg.mine").length === ' + (mine + 1) + ' && [...document.querySelectorAll(".chat-msg.mine")].at(-1).textContent.includes("Summarise the pilots")', 'the message sent', 2000);
  assert.equal(await p.js('document.getElementById("composerText").textContent'), '', 'the composer emptied');
  await p.waitFor('[...document.querySelectorAll(".chat-msg.theirs")].at(-1)?.textContent.includes("Mock answer to: Summarise the pilots")', 'Tana\u2019s answer', 6000);
});

// 21. Panes and tabs (#138, #435, #463; shell.html): the window's shell on a stand-in for main that opens a page the way
// main.js window:split does. ⌘↩ on a search result opens it in a new tab, ⇧↩ in a pane beside, ⇧⌘N a new pane on the
// Library; the keys stay with the page just opened, and every page keeps its own place.
const TWO_PANES = { schema: 1, root: { kind: 'split', id: 'split-m', axis: 'x', weights: [0.55, 0.45], children: [{ kind: 'panel', id: 'panel-a', views: ['page'], selected: 'page' },
  { kind: 'panel', id: 'panel-b', views: ['page2'], selected: 'page2' }] }, floating: [], hidden: [], views: { page: { type: 'page', params: { side: '' } }, page2: { type: 'page', params: { side: '2' } } } };
// On the mock a page has no preload to give it its id, so every page reads the one 'view' and 'place': the page about
// to open gets them written just before, as manual/scenes/kit.js live() does
const SHELL_API = 'if (window === top) { let seq = 2; window.shell = { state: () => ({ doc: ' + J(TWO_PANES) + ', theme: "light" }), onCommand: (cb) => { window.shellCmd = cb; }, layout() {} };'
  + ' window.orbOpen = (where, start, from) => { const id = String(++seq); localStorage.setItem("view", start.view || "library"); localStorage.setItem("place", start.place || "{}"); window.shellCmd("open", { id, where, from, focus: true }); return id; }; }';
flow('golden path: open pages in tabs and panes, each keeping its own place', async (p) => {
  await p.beforeLoad(SHELL_API);
  await p.open('shell.html');
  const frame = (s) => '[...document.querySelectorAll("iframe")].find((f) => new URL(f.src).searchParams.get("side") === ' + J(s) + ')';
  const sides = () => p.js('[...document.querySelectorAll("iframe")].map((f) => new URL(f.src).searchParams.get("side"))');
  const signed = new Set();
  // the window has n pages: each new one signed in on the mock, its window:split answered by the stand-in, and drawn
  const pages = async (n) => {
    await p.waitFor('document.querySelectorAll("iframe").length === ' + n, n + ' pages', 8000);
    for (const s of await sides()) {
      if (signed.has(s)) continue;
      signed.add(s);
      await p.waitFor(frame(s) + '?.contentDocument?.readyState === "complete" && typeof ' + frame(s) + '.contentWindow.goTo === "function"', 'page ' + s + ' to load', 8000);
      for (let i = 0; ; i++) { try { await p.jsIn(s, 'tana.splitWindow = async (where, start) => parent.orbOpen(where, start || {}, ' + J(s) + '); document.getElementById("login")?.click(); 1'); break; } catch (e) { if (i > 20) throw e; await p.sleep(50); } }
      await p.waitFor(frame(s) + '.contentDocument.querySelector("#outline .node, #outline .empty") && ' + frame(s) + '.contentDocument.getElementById("title").textContent', 'page ' + s + ' drawn', 8000);
    }
  };
  const found = (s, label) => p.waitFor('(' + frame(s) + '.contentDocument.querySelector("#palette .row.active")?.textContent || "").includes(' + J(label) + ')', J(label) + ' found');
  const places = async () => { const out = {}; for (const s of await sides()) out[s] = await p.js(frame(s) + '.contentDocument.getElementById("title").textContent'); return out; };
  const tabs = () => p.js('[...document.querySelectorAll("[data-trellis-part=panel]")].map((pn) => [...pn.querySelectorAll("[data-trellis-part=tab]")].map((t) => t.textContent.trim()))');
  const keysIn = () => p.js('new URL(document.activeElement.src).searchParams.get("side")');
  await pages(2);
  await p.jsIn('', 'goTo("mockdoc0")'); await p.jsIn('2', 'setView("library")');
  await p.waitFor(frame('') + '.contentDocument.getElementById("title").textContent.startsWith("Schedule")', 'the first page on a document');
  const title = await p.js('(() => { const f = ' + frame('') + ', o = f.getBoundingClientRect(), b = f.contentDocument.getElementById("title").getBoundingClientRect(); return [o.left + b.left + 10, o.top + b.top + b.height / 2]; })()');
  await p.click(...title);
  assert.equal(await keysIn(), '', 'the keys are with the first page');
  await p.key('⌘s'); await p.type('offsite agenda'); await found('', 'Prepare the offsite agenda'); await p.key('⌘↩');
  await pages(3);
  assert.deepEqual(await tabs(), [['Schedule something with Sam Okafor and Dana Brooks', 'Prepare the offsite agenda'], ['Library']], '⌘↩ opened it as a tab beside the page');
  assert.equal(await keysIn(), '3', 'the keys went with the new tab');
  await p.key('⌘s'); await p.type('book a room'); await found('3', 'Book a room for the offsite'); await p.key('⇧↩');
  await pages(4);
  await p.key('⇧⌘N');
  await pages(5);
  assert.deepEqual(await tabs(), [['Schedule something with Sam Okafor and Dana Brooks', 'Prepare the offsite agenda'], ['Library'], ['Book a room for the offsite'], ['Library']], '⇧↩ opened a pane beside, ⇧⌘N a new pane on the Library');
  assert.equal(await keysIn(), '5', 'the keys went with the new pane');
  assert.deepEqual(await places(), { '': 'Schedule something with Sam Okafor and Dana Brooks', 2: 'Library', 3: 'Prepare the offsite agenda', 4: 'Book a room for the offsite', 5: 'Library' }, 'every page kept its own place');
  for (const s of await sides()) assert.deepEqual(await p.jsIn(s, 'window.__errors'), [], 'page ' + s + ' reported errors');
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
    // up to 30 s: a CI runner once took longer than 12 to start Chrome; a Chrome that is up answers on the first tries
    let t; for (let i = 0; i < 150 && !t; i++) { await sleep(200); try { t = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page'); } catch { /* not up yet */ } }
    if (!t) throw new Error('Chromium did not start: ' + chrome);
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
    let id = 0; const waiting = new Map();
    // each frame's own scope (a pane's page inside shell.html), for jsIn: the page's CSP refuses eval, and a const in
    // its classic scripts (tana, zoom) is not on its window, so the frame is evaluated in directly
    const scopes = new Map(); // frameId -> its default execution context
    ws.onmessage = (m) => { const d = JSON.parse(m.data);
      if (d.method === 'Runtime.executionContextCreated' && d.params.context.auxData?.isDefault) scopes.set(d.params.context.auxData.frameId, d.params.context.id);
      if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
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
    const js = async (expression, contextId) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
      if (r.exceptionDetails) throw new Error('in page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  ' + expression.slice(0, 200));
      return r.result.value;
    };
    // the same in one pane of the window (shell.html): side is the page's ?side= ('' the first, '2', '3', …)
    const jsIn = async (side, expression) => {
      const { frameTree } = await send('Page.getFrameTree');
      const frame = (frameTree.childFrames || []).map((c) => c.frame).find((f) => new URL(f.url).searchParams.get('side') === side);
      if (!frame || !scopes.has(frame.id)) throw new Error('no pane with side=' + side);
      return js(expression, scopes.get(frame.id));
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
    // another page of the app, fresh (the window's shell.html, an overlay's task.html), loaded with nothing signed in
    const open = async (file) => {
      await send('Storage.clearDataForOrigin', { origin: base, storageTypes: 'local_storage' });
      await send('Page.navigate', { url: base + '/' + file });
      await waitFor('document.readyState === "complete"', file + ' to load', 8000);
    };
    const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); await sleep(80); };
    // a script every page this flow opens runs before its own (what preload gives a page main opens: a stand-in for
    // window.api); taken away when the flow ends, so the next flow's pages are the mock's again
    const loaded = [];
    const beforeLoad = async (source) => { loaded.push((await send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier); };
    const page = { js, jsIn, waitFor, key, type, click, start, open, sleep, beforeLoad };

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
      for (const identifier of loaded.splice(0)) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    }
    ws.close();
  } finally { ch.kill(); server.close(); }
  if (failed) { console.log(failed + ' flow(s) failed'); process.exit(1); }
  console.log('flow-check passed');
})().catch((e) => { console.error(e.stack || e); process.exit(1); });

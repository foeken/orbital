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

// ⌘↩ cycles a row's checkbox, no box → empty → ticked → no box, and on a selection every row takes the same step
// (renderer/edit.js cycleCheckboxes), the boxes drawn as saved and one ⌘Z putting a whole step back
flow('⌘↩ cycles a checkbox on a row and on a selection of rows', async (p) => {
  await p.start();
  const id = await p.js("tana.createDocument('Checkbox test').then((n) => { goTo(n.id); return n.id; })");
  await p.waitFor('document.activeElement && document.activeElement.isContentEditable', 'the caret in the new page');
  await p.type('one'); await p.key('↩'); await p.type('two'); await p.key('↩'); await p.type('three');
  const boxes = async (step) => {
    await p.js('flushAll()'); await settle(p, 450);
    const saved = await p.js('tana.children(' + J(id) + ').then((rows) => rows.map((r) => r.done ?? null))');
    const screen = await p.js('[...document.querySelectorAll("#outline .node")].filter((n) => n.querySelector(".text")).map((n) => { const c = n.querySelector(":scope > .line .check"); return c ? (c.checked ? 1 : 0) : null; })');
    assert.deepEqual(screen, saved, 'the boxes drawn differ from the saved ones after ' + step);
    return saved;
  };
  await p.js('placeCaret(keyOfEl(' + T('two') + '), 1)');
  await p.key('⌘↩'); assert.deepEqual(await boxes('one ⌘↩'), [null, 0, null], 'an empty box first');
  await p.key('⌘↩'); assert.deepEqual(await boxes('a second ⌘↩'), [null, 1, null], 'then ticked');
  await p.key('⌘↩'); assert.deepEqual(await boxes('a third ⌘↩'), [null, null, null], 'then no box');
  await p.key('⌘↩'); await p.key('⌘↩'); assert.deepEqual(await boxes('two more'), [null, 1, null]);
  await p.key('⌘a'); await p.key('⌘a'); // the words, then every row
  await p.waitFor('sel && sel.keys.size === 3', 'the three rows selected');
  assert.equal(await p.js('document.getElementById("toolbar").hidden'), true, 'the toolbar the first ⌘A raised over the words is gone once the rows are selected');
  await p.key('⌘↩'); assert.deepEqual(await boxes('⌘↩ on the selection'), [0, 1, 0], 'the rows without a box get one, the ticked one stays ticked');
  assert.equal(await p.js('sel && sel.keys.size'), 3, 'and the rows stay selected');
  await p.key('⌘↩'); assert.deepEqual(await boxes('a second ⌘↩ on the selection'), [1, 1, 1], 'then all ticked');
  await p.key('⌘↩'); assert.deepEqual(await boxes('a third ⌘↩ on the selection'), [null, null, null], 'then no boxes');
  await p.key('⌘z'); await settle(p, 300);
  assert.deepEqual(await boxes('⌘Z'), [1, 1, 1], 'one ⌘Z puts the whole step back');
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
// 5b. Up from a page's first line (#764): the fields, then the title, by keyboard alone, and down again. A code block's
// padding once held the caret inside it, a title hidden under a tab bar was aimed at and never reached, and a
// read-only title sent ↑ from the top field back to the last one.
flow('↑ from the first line walks the fields to the title, from any row, and ↓ comes back', async (p) => {
  await p.start();
  const where = () => p.js('(() => { const a = document.activeElement; return a === document.getElementById("title") ? "title" : a?.closest?.("#fields") ? "field " + a.textContent.replace(/\\u200b/g, "").slice(0, 12) : a?.closest?.("#outline") ? "row " + a.textContent.slice(0, 12) : "none"; })()');
  const fresh = async (name) => {
    await p.js('tana.createDocument(' + J(name) + ').then((n) => goTo(n.id))');
    await p.waitFor('zoom && document.getElementById("title").textContent === ' + J(name) + ' && document.activeElement?.closest?.("#outline")', 'the caret in ' + name);
  };
  await fresh('Up note');
  await p.key('↑'); assert.equal(await where(), 'title', 'a new note with no fields: up from its empty row is its title');
  await p.key('↓'); assert.equal(await where(), 'row ', 'and down is the row again');
  await fresh('Code first');
  await p.type('```'); await p.waitFor('document.activeElement.closest(".node.t-code")', 'a code block');
  await p.type('let a = 1'); await p.key('⇧↩'); await p.type('let b = 2'); await settle(p, 200);
  await p.key('↑'); assert.deepEqual([await where(), await p.js('__caret().offset < 10')], ['row let a = 1\nle', true], 'up from a code block\u2019s second line is its first');
  await p.key('⌥↑'); assert.equal(await where(), 'row let a = 1\nle', '\u2325\u2191 on its first line is the system\u2019s own move, and stays in the block');
  assert.deepEqual(await p.js('(() => { const a = document.activeElement, kept = a.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", isComposing: true, bubbles: true, cancelable: true })); return [kept, document.activeElement === a]; })()'), [true, true], 'and so is \u2191 while an input method is composing');
  await p.key('↑'); assert.equal(await where(), 'title', 'and up from its first line, inside its padding, is the title');
  await p.key('↓'); await p.key('↓'); assert.deepEqual([await where(), await p.js('__caret().offset >= 10')], ['row let a = 1\nle', true], 'down goes back into it, line by line');
  await fresh('Wrapped code');
  await p.type('```'); await p.waitFor('document.activeElement.closest(".node.t-code")', 'a code block');
  await p.type('token '.repeat(40)); await settle(p, 200);
  const lines = await p.js('(() => { const r = document.createRange(); r.selectNodeContents(document.activeElement); return new Set([...r.getClientRects()].map((b) => Math.round(b.top))).size; })()');
  assert.ok(lines >= 2, 'the code wraps (' + lines + ' lines)');
  for (let i = 1; i < lines; i++) { await p.key('↑'); assert.equal(await where(), 'row token token ', 'a wrapped line moves within the block'); }
  await p.key('↑'); assert.equal(await where(), 'title', 'and its first line up to the title');
  // a page with fields: up through each, from the one nearest the outline, then the title; down the same way back
  await p.js('goTo("mockdoc1")'); await p.waitFor('zoom?.docId === "mockdoc1" && document.querySelector("#outline .node .text")', 'mockdoc1');
  await p.js("tana.related('mockdoc1').then((d) => { relatedBy.set('mockdoc1', d); render(true); return 1; })"); // the mock's ids are not tana: ids, so the page never reads them itself
  await p.waitFor('fieldValues().length === 7', 'its fields');
  const fields = await p.js('fieldValues().map((e) => "field " + e.textContent.replace(/\\u200b/g, "").slice(0, 12))');
  await p.js('setCaret(texts()[0], 0)');
  const up = []; for (let i = 0; i < 8; i++) { await p.key('↑'); up.push(await where()); }
  assert.deepEqual(up, [...fields.slice().reverse(), 'title'], 'up from the first row: every field, nearest first, then the title');
  const down = []; for (let i = 0; i < 8; i++) { await p.key('↓'); down.push(await where()); }
  assert.deepEqual(down, [...fields, 'row ' + (await p.js('texts()[0].textContent.slice(0, 12)'))], 'down: every field again, then the first row');
  // the same page in demo mode: its title cannot be typed in, so up from the top field focuses it, and down leaves it
  await p.js('toggleDemoMode()'); await settle(p, 300);
  await p.js("tana.related('mockdoc1').then((d) => { relatedBy.set('mockdoc1', d); render(true); return 1; })"); await p.waitFor('fieldValues().length === 7', 'its fields in demo mode');
  assert.equal(await p.js('document.getElementById("title").isContentEditable'), false, 'demo mode: a title nobody types in');
  await p.js('setCaret(fieldValues()[0], 0)');
  await p.key('↑'); assert.equal(await where(), 'title', 'up from the top field is the read-only title, not the last field again');
  assert.equal(await p.js('getComputedStyle(document.getElementById("title")).boxShadow !== "none"'), true, 'drawn focused, as a field\u2019s chips are');
  await p.key('↓'); assert.equal(await where(), fields[0], 'down from it is the first field');
  assert.equal(await p.js('document.getElementById("title").hasAttribute("tabindex")'), false, 'and the title is a stop no longer');
  await p.js('toggleDemoMode()'); await settle(p, 300);
  // a saved search under a tab bar names itself on the tab: up shows its title as Rename does, Escape hides it again
  await p.js('tana.myTasks().then((n) => goTo(n.id))'); await p.waitFor('zoom?.docId?.startsWith("tana:search:") && texts().length', 'My Tasks');
  await p.js('document.documentElement.classList.add("tabbed"); 1');
  assert.equal(await p.js('getComputedStyle(document.getElementById("pagehead")).display'), 'none', 'its title is hidden under the tab bar');
  await p.js('setCaret(texts()[0], 0)');
  await p.key('↑'); assert.equal(await where(), 'title', 'up from its first row is its title');
  assert.notEqual(await p.js('getComputedStyle(document.getElementById("pagehead")).display'), 'none', 'shown while the caret is in it');
  await p.key('esc'); assert.equal(await p.js('getComputedStyle(document.getElementById("pagehead")).display'), 'none', 'and hidden again once it is left');
  await p.js('document.documentElement.classList.remove("tabbed"); 1');
});

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
  let hidden = ['Secret project'], agents = [{ id: 'tana', label: 'Tana', icon: 'tana', installed: true, enabled: true }, { id: 'codex', label: 'Codex', icon: 'robot', installed: true, enabled: true, isDefault: true }];
  start({ prefs: { theme: 'light' }, translate: () => {}, onSettings: (fn) => { window.__settings = fn; },
    aiOptions: () => new Promise((resolve) => __slow.push(() => resolve(AI))), setAiOption: call('setAiOption', (k, v) => ({ ...AI, [k]: v })),
    chatgptStatus: async () => ({ available: true, signedIn: true, email: 'robin@private.example' }), chatgptLogout: call('chatgptLogout', { available: true, signedIn: false }),
    agentList: async () => agents, enableAgent: call('enableAgent', (id, on) => (agents = agents.map((a) => (a.id === id ? { ...a, enabled: on } : a)))),
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

// 10. The Timeline (#135): a first launch opens on it, a row is selected by a first click and opens what it is about on
// the next, by Enter or by its bullet at once, ⌘[ comes back, a task ticked under Today's Tasks is saved as done, and
// its end reads three more days
flow('golden path: the Timeline opens first and leads to what each row is about', async (p) => {
  await p.start();
  await settle(p, 400); // the first read of the page lands in parts (renderer/timeline.js): clicked once it is whole
  assert.equal(await p.js('zoom && zoom.docId'), 'orbital:timeline', 'a first launch opens on the Timeline');
  const top = await p.js('__screen()');
  assert.equal(top[0], "Today's Tasks", 'Today\u2019s Tasks leads the page');
  assert.ok(top.includes('Upcoming meetings'), 'today\u2019s meetings to come are listed');
  assert.deepEqual(await p.js('[...document.querySelectorAll("#outline .ghead")].map((h) => h.textContent.trim())'), ['Today', 'Yesterday'], 'the history in day sections');
  const back = async () => { await p.key('⌘['); await at(p, 'orbital:timeline'); };
  // a first click on an edit selects it and opens nothing; the next opens the task edited
  await clickWords(p, 'Sam Okafor edited');
  await settle(p, 200);
  assert.deepEqual(await p.js('[zoom.docId, selKeys().map((k) => items.get(k).node.timeline?.uri)]'), ['orbital:timeline', ['mockdoc0']], 'a first click selects the Timeline row and stays on the Timeline');
  assert.equal(await p.js('getComputedStyle(' + T('Sam Okafor edited') + ').outlineStyle'), 'solid', 'and rings it');
  await clickWords(p, 'Sam Okafor edited');
  await at(p, 'mockdoc0');
  assert.equal(await p.js('document.getElementById("title").textContent'), await p.js('tana.node("mockdoc0").then((n) => n.title)'), 'the edited task opened');
  await back();
  // Enter on a row opens it too
  await p.js('(' + T('Tomas Ilves accepted') + ').focus()'); await p.key('↩');
  await at(p, 'mockdoc5');
  await back();
  // a meeting still to come opens its page, on the second click
  await clickWords(p, '1-1 with Priya');
  await settle(p, 200);
  assert.equal(await p.js('zoom.docId'), 'orbital:timeline', 'a first click on a meeting to come opens nothing');
  await clickWords(p, '1-1 with Priya');
  await at(p, 'mockmeeting7');
  await back();
  // the bullet opens what the row is about at once
  await p.js(rowOf('Sam Okafor edited') + '.querySelector(".bullet").click()');
  await at(p, 'mockdoc0');
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
// picked up by its words as by a hand, and the Timeline's own record rows offer nothing to pick up
flow('golden path: a task dragged onto a meeting is pinned there', async (p) => {
  await p.start({ real: true }); // a meeting takes a drop by its tana:event: id, and only a real node can be pinned
  await p.waitFor(T('Leadership sync'), 'the meeting on the Timeline');
  assert.equal((await p.js('__drag(' + rowOf('Sam Okafor edited') + ', 0, 0)')).grip, false, 'a Timeline record row is not something to pick up');
  const to = await lineOf(p, 'Leadership sync');
  assert.deepEqual(await p.js('__drag(' + rowOf('Check out the new editor') + ', ' + (to.left + 120) + ', ' + to.mid + ')'), { grip: true, accepted: true, line: false }, 'the task taken by the meeting, with no outline line');
  await p.waitFor('tana.pinState("tana:text:mockdoc2").then((s) => s.hubs.some((h) => h.id === "tana:event:mockmeeting2"))', 'the task pinned to Leadership sync');
  await p.waitFor('[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("Pinned to Leadership sync"))', 'the note that says so');
  // and by hand, from its words: a press there picks the row up (render.js .selectfirst) and a meeting to come, a few
  // rows below it, takes it
  await p.js(T('Organise working sessions') + '.scrollIntoView({ block: "start", behavior: "instant" })'); await settle(p, 150); // the task at the top, the meeting below it, both in view
  const meeting = await p.js('(() => { const b = ' + rowOf('1-1 with Priya') + '.querySelector(".line").getBoundingClientRect(); return { left: b.left, mid: b.top + b.height / 2 }; })()');
  const from = await p.js('(() => { const r = document.createRange(); r.selectNodeContents(' + T('Organise working sessions') + '); const b = r.getClientRects()[0]; return [b.left + 30, b.top + b.height / 2]; })()');
  assert.equal(await p.js('document.elementFromPoint(' + from + ')?.closest(".node")?.dataset.key'), 'tana:text:mockdoc5', 'the task\u2019s words in view to press');
  assert.equal(await p.js('document.elementFromPoint(' + (meeting.left + 120) + ', ' + meeting.mid + ')?.closest(".node")?.textContent.includes("1-1 with Priya")'), true, 'and the meeting in view to drop on');
  assert.ok(await p.drag(from[0], from[1], meeting.left + 120, meeting.mid), 'a task under Today\u2019s Tasks is picked up by its words');
  await p.waitFor('tana.pinState("tana:text:mockdoc5").then((s) => s.hubs.some((h) => h.id === "tana:event:mockmeeting7"))', 'the task dragged by its words pinned to 1-1 with Priya');
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

// 16b. Cmd+K Install mobile app (renderer/overlays.js openHelp('mobile'), main.js openOverlay): the Help tour opens on
// its phone page, in either theme, with iPhone chosen: its code drawn and the TestFlight link, which opens in the
// browser through main and leaves the tour where it is. The choice is one radio group over one place: Android shows
// coming soon and no code, link or button; the arrows switch inside the group and do not page or close the tour, and
// the group is one tab stop. Once the latest release has the Android app (updater.js androidRelease; here ?apk), Android
// shows its code and download link in that same place instead, and the card keeps its size. Without the page asked
// for, the tour starts at the beginning
const HELP_API = String.raw`if (location.pathname === '/help.html') { window.__opened = [];
  window.api = { openExternal: async (url) => { __opened.push(url); }, closeOverlay: () => {}, chatgptStatus: async () => ({ signedIn: false }),
    androidRelease: async () => (new URLSearchParams(location.search).has('apk') ? { version: '0.10.0' } : null) }; }`;
flow('Install mobile app opens the Help tour on its phone page: iPhone\u2019s code and link, Android coming soon or its download', async (p) => {
  const link = fs.readFileSync(path.join(root, 'help.html'), 'utf8').match(/id="helpMobileLink" href="([^"]+)"/)[1];
  const apk = fs.readFileSync(path.join(root, 'help.html'), 'utf8').match(/id="helpAndroidLink" href="([^"]+)"/)[1];
  const obtainium = fs.readFileSync(path.join(root, 'help.html'), 'utf8').match(/id="helpObtainiumLink" href="([^"]+)"/)[1];
  // what the page shows: the chosen phone, the radios' state and tab stops, and what can be seen of the code, links and buttons
  const shown = () => p.js(`(() => { const seen = (e) => !!e.offsetParent, page = document.getElementById('help-mobile');
    return { chosen: [...page.querySelectorAll('[role=radio]')].map((b) => [b.textContent, b.getAttribute('aria-checked'), b.tabIndex]),
      code: [...page.querySelectorAll('img')].filter(seen).length, links: [...page.querySelectorAll('a')].filter(seen).map((a) => a.href),
      soon: [...page.querySelectorAll('.hv-soon, p')].filter(seen).map((e) => e.innerText.replace(/\\s+/g, ' ').trim()).filter((t) => /soon/i.test(t)),
      buttons: [...page.querySelectorAll('.hv button')].filter(seen).length, focus: document.activeElement.textContent, page: document.querySelector('.hpage.on').id }; })()`);
  await p.beforeLoad(HELP_API);
  for (const theme of ['light', 'dark']) {
    await p.open('help.html?at=mobile&theme=' + theme);
    await p.waitFor('document.querySelector(".hpage.on")', 'the tour');
    assert.deepEqual(await p.js('[document.querySelector(".hpage.on").id, document.getElementById("helpNext").textContent, document.documentElement.dataset.theme || "light"]'),
      ['help-mobile', 'Get started', theme], 'it opens on its last page, the iPhone app, in the theme asked for');
    await p.waitFor('(() => { const i = document.querySelector("#help-mobile img"); return i.complete && i.naturalWidth > 0; })()', 'the code to be drawn');
    const ios = await shown();
    // layout size: the card opens with a scale-in (styles.css @starting-style), which a bounding box would catch part-way
    const card = () => p.js('(() => { const c = document.querySelector("#help .card"); return [c.offsetWidth, c.offsetHeight]; })()');
    const iosCard = await card();
    assert.deepEqual([ios.chosen, ios.code, ios.links, ios.soon], [[['iPhone', 'true', 0], ['Android', 'false', -1]], 1, [link], []], 'iPhone chosen: one code and its link, one tab stop');
    assert.match(await p.js('document.querySelector("#help-mobile p[data-os=ios]").textContent'), /iOS 26 or later/, 'with the iOS it needs');
    await p.js('document.querySelector("#help-mobile [data-os=android][role=radio]").click(); 1');
    const android = await shown();
    assert.deepEqual([android.chosen, android.code, android.links, android.buttons, android.soon.length > 0], [[['iPhone', 'false', -1], ['Android', 'true', 0]], 0, [], 2, true],
      'Android chosen: coming soon in the same place, and no code, link or button besides the choice');
    assert.deepEqual(await card(), iosCard, 'the card keeps its size from one phone to the other: nothing moves under the pointer');
    // by keyboard: the chosen radio has focus, the arrows switch and keep the tour on this page
    await p.js('document.querySelector("#help-mobile [aria-checked=true]").focus(); 1');
    await p.key('←');
    assert.deepEqual(await shown().then((s) => [s.chosen[0][1], s.focus, s.code, s.page]), ['true', 'iPhone', 1, 'help-mobile'], '\u2190 picks iPhone again, focus with it, and the tour stays');
    await p.key('→');
    assert.deepEqual(await shown().then((s) => [s.chosen[1][1], s.focus, s.code, s.page]), ['true', 'Android', 0, 'help-mobile'], '\u2192 picks Android, and the tour stays on its last page');
    await p.key('→'); await p.key('Space');
    assert.deepEqual(await shown().then((s) => [s.chosen[0][1], s.focus, s.page]), ['true', 'iPhone', 'help-mobile'], '\u2192 wraps round to iPhone, and Space keeps it');
    await p.js('document.getElementById("helpMobileLink").click(); 1'); await settle(p, 100);
    assert.deepEqual(await p.js('[__opened, location.pathname, document.querySelector(".hpage.on").id]'), [[link], '/help.html', 'help-mobile'], 'the link opens in the browser and the tour stays');
  }
  // a latest release with the Android app: its code and download link where coming soon was, the card the same size
  for (const theme of ['light', 'dark']) {
    await p.open('help.html?at=mobile&apk=1&theme=' + theme);
    await p.waitFor('(() => { const i = document.querySelector("#help-mobile img"); return i.complete && i.naturalWidth > 0; })()', 'the iPhone code');
    const size = () => p.js('(() => { const c = document.querySelector("#help .card"); return [c.offsetWidth, c.offsetHeight]; })()');
    const iosCard = await size();
    assert.equal((await shown()).chosen[0][1], 'true', 'iPhone is chosen first, a release for Android or not');
    await p.js('document.querySelector("#help-mobile [data-os=android][role=radio]").click(); 1');
    await p.waitFor('(() => { const i = document.querySelector("#help-mobile img[src=\'help-android.svg\']"); return !!i.offsetParent && i.complete && i.naturalWidth > 0; })()', 'the Android code');
    const android = await shown();
    assert.deepEqual([android.code, android.links, android.soon], [1, [obtainium, apk], []], 'Android with a release: the code that adds it to Obtainium, a link to Obtainium and the download, and nothing says coming soon');
    assert.match(await p.js('document.querySelector("#help-mobile p[data-os=android][data-apk=yes]").textContent'), /Android 10 or later/, 'with the Android it needs');
    assert.deepEqual(await size(), iosCard, 'the card keeps its size from one phone to the other');
    await p.js('document.getElementById("helpAndroidLink").click(); 1'); await settle(p, 100);
    await p.js('document.getElementById("helpObtainiumLink").click(); 1'); await settle(p, 100);
    assert.deepEqual(await p.js('__opened'), [apk, obtainium], 'the download and Obtainium open in the browser');
  }
  await p.open('help.html?theme=light');
  await p.waitFor('document.querySelector(".hpage.on")', 'the tour');
  assert.equal(await p.js('[...document.querySelectorAll(".hpage")].indexOf(document.querySelector(".hpage.on"))'), 0, 'Help: the first page');
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

// 17b. "/" Task and Meeting (#602, #755): each named on a page of its own and referenced in the row the "/" was typed in;
// the meeting's when page shows the exact slot before anything is made, words that read as no time make nothing, Escape
// walks back to the row, and a second ↩ while one is being made makes nothing more
flow('golden path: "/" Task and Meeting, named, the meeting\u2019s time reviewed, each referenced in its row', async (p) => {
  await p.start();
  await command(p, 'today', 'Today');
  await p.waitFor('zoom && document.getElementById("title").textContent === localDate()', 'today\u2019s page');
  const day = await p.js('zoom.docId');
  await p.js('document.querySelector("#outline .node .text").focus(); placeCaret(keyOfEl(document.querySelector("#outline .node .text")), 0)');
  // every create counted, and slowed, so a second ↩ lands while the first is still being made
  await p.js('window.__creates = []; const made = tana.createDocument; tana.createDocument = (title, opts) => { __creates.push([title, opts || null]); return new Promise((r) => setTimeout(r, 400)).then(() => made(title, opts)); }; 1');
  await p.type('/'); await p.waitFor('palMode === "slash"', 'the / menu'); await p.type('task');
  await p.waitFor('palRows[palIndex]?.label === "Task"', 'Task offered'); await p.key('↩');
  await p.waitFor('palMode === "slashTask"', 'the task\u2019s name page'); await p.type('Book the venue'); await p.key('↩'); await p.key('↩');
  await p.waitFor('palette.hidden && document.activeElement?.closest?.("#outline")', 'the task made and the caret back in its row', 6000);
  await p.key('↩'); await p.type('/'); await p.waitFor('palMode === "slash"', 'the / menu'); await p.type('meeting');
  await p.waitFor('palRows[palIndex]?.label === "Meeting"', 'Meeting offered'); await p.key('↩');
  await p.waitFor('palMode === "slashMeeting"', 'the meeting\u2019s name page'); await p.type('Design review'); await p.key('↩');
  await p.waitFor('palMode === "slashMeetingWhen"', 'the when page');
  const slots = await p.js('[0, 1].map((back) => { const s = (Math.floor(Date.now() / 6e4) - back) * 6e4; return meetingSpan(s, s + 18e5); })');
  const offered = await p.js('[palRows[palIndex].label, palRows[palIndex].hint]');
  assert.ok(slots.includes(offered[0]) && offered[1] === 'Now, for 30 minutes', 'with nothing typed, now for half an hour is offered, as it would be made: ' + J(offered));
  await p.type('xyz'); await settle(p, 100);
  assert.deepEqual(await p.js('palRows.filter((r) => !r.disabled).map((r) => r.label)'), ['Read \u201Cxyz\u201D with AI'], 'words this page cannot read can only be handed to the AI');
  await p.js("const slow = tana.readMeetingTime; tana.readMeetingTime = (...a) => new Promise((r) => setTimeout(r, 500)).then(() => slow(...a)); 1"); // the AI takes a moment: the row reading the words thinks meanwhile, as every AI row in the palette does
  await p.key('↩'); await p.waitFor('document.querySelector("#palette .row .ricon.thinking")', 'the reading row\u2019s thinking glyph');
  await p.waitFor('palRows.some((r) => r.label === "No day or time in those words")', 'the AI\u2019s answer that it is no time');
  assert.equal(await p.js('!!document.querySelector("#palette .ricon.thinking")'), false, 'and it stops once the AI has answered');
  assert.deepEqual([await p.js('palMode'), await p.js('__creates.length')], ['slashMeetingWhen', 1], 'and nothing is made');
  await p.key('esc'); await p.waitFor('palMode === "slashMeeting" && palInput.value === "Design review"', 'Escape back to the name, kept');
  await p.key('esc'); await p.waitFor('palMode === "slash"', 'Escape back to the menu');
  await p.key('esc'); await p.waitFor('palette.hidden && document.activeElement?.textContent === "/"', 'Escape back to the row, the caret in it');
  await p.key('⌫'); await p.type('/'); await p.waitFor('palMode === "slash"', 'the / menu again'); await p.type('meeting'); await p.waitFor('palRows[palIndex]?.label === "Meeting"', 'Meeting offered'); await p.key('↩');
  await p.type('Design review'); await p.key('↩'); await p.waitFor('palMode === "slashMeetingWhen"', 'the when page');
  await p.type('tomorrow 14:00-15:00'); await settle(p, 100);
  const typed = await p.js('new Date(parseDay("tomorrow") + "T14:00").getTime()');
  assert.deepEqual(await p.js('[palRows[palIndex].label, palRows[palIndex].hint]'), [await p.js('meetingSpan(' + typed + ', ' + (typed + 36e5) + ')'), '\u21A9 Create'], 'the slot typed, shown before it is made');
  await p.js('palInput.value = ""; palInput.dispatchEvent(new Event("input"))'); await p.type('tomorrow from 3-5');
  await p.key('↩'); await p.waitFor('palRows[palIndex]?.hint === "\u21A9 Create \u00B7 read by AI"', 'the AI\u2019s reading, shown before it is made');
  const start = await p.js('new Date(parseDay("tomorrow") + "T15:00").getTime()');
  assert.equal(await p.js('palRows[palIndex].label'), await p.js('meetingSpan(' + start + ', ' + (start + 72e5) + ')'), 'tomorrow from 3-5 is the afternoon');
  await p.key('↩'); await p.key('↩');
  await p.waitFor('palette.hidden && document.activeElement?.closest?.("#outline")', 'the meeting made and the caret back in its row', 6000);
  await p.js('flushAll()'); await settle(p, 500);
  assert.deepEqual(await p.js('__creates'), [['Book the venue', { kind: 'task' }], ['Design review', { kind: 'meeting', start, end: start + 72e5 }]], 'one task and one meeting, the meeting at the time shown and with nobody on it');
  const saved = await p.js('tana.children(' + J(day) + ').then((rows) => rows.map((n) => n.segments.map((s) => (s.mention ? s.mention.label : s.text))))');
  assert.deepEqual(saved, [['Book the venue'], ['Design review']], 'each row is the reference to what it made, saved');
  assert.equal(await p.js('tana.children(' + J(day) + ').then((rows) => rows[1].segments[0].mention.icon)'), 'meeting', 'the meeting’s with its glyph');
  const meeting = await p.js('tana.children(' + J(day) + ').then((rows) => tana.node(rows[1].segments[0].mention.uri)).then((n) => n.start)');
  assert.equal(meeting, new Date(start).toISOString(), 'and the meeting starts when it said');
  // ⌘K Create new → Meeting (#765): the same When page, then the meeting opens; nothing is written into a row
  await command(p, 'create new', 'Create new \u2026');
  await p.type('meeting'); await p.waitFor('palRows[palIndex]?.label === "Meeting"', 'Meeting among the choices'); await p.key('↩');
  await p.waitFor('palMode === "createName"', 'its name page'); await p.type('Retro'); await p.key('↩');
  await p.waitFor('palMode === "slashMeetingWhen" && palRows[palIndex]?.hint === "Now, for 30 minutes"', 'the same when page, now for half an hour offered');
  assert.equal(await p.js('__creates.length'), 2, 'nothing made by naming it');
  await p.key('esc'); await p.waitFor('palMode === "createName" && palInput.value === "Retro"', 'Escape back to the name, kept');
  await p.key('↩'); await p.waitFor('palMode === "slashMeetingWhen"', 'the when page again');
  await p.type('tomorrow 9:30'); await settle(p, 100);
  const retro = await p.js('new Date(parseDay("tomorrow") + "T09:30").getTime()');
  await p.key('↩'); await p.key('↩');
  await p.waitFor('palette.hidden && zoom && document.getElementById("title").textContent === "Retro"', 'the meeting made and opened', 6000);
  assert.deepEqual((await p.js('__creates')).slice(2), [['Retro', { kind: 'meeting', start: retro, end: retro + 18e5 }]], 'one meeting, at the time shown');
  assert.deepEqual(await p.js('tana.children(' + J(day) + ').then((rows) => rows.length)'), 2, 'and no row anywhere was changed');
});

// 17c. Edit meeting details (#758): ⌘K on a meeting you may change, one field, read by the AI only when ↩ asks (the mock
// stands in for it), its reading shown beside the meeting as it is and written only when pressed; Escape goes back to the
// commands and the caret comes back
flow('golden path: Edit meeting details reads "tomorrow from 3-5" and applies it only when pressed', async (p) => {
  await p.start();
  await p.js("goTo('mockmeeting2')"); await at(p, 'mockmeeting2');
  const was = await p.js('tana.meetingInfo("mockmeeting2").then((m) => [m.start, m.end, m.attendees.length])');
  await command(p, 'edit meeting details', 'Edit meeting details');
  await p.waitFor('palMode === "meetingDetails"', 'its one field');
  await p.type('xyz'); await p.key('↩');
  await p.waitFor('palRows.some((r) => r.label === "No day or time in those words")', 'the AI\u2019s answer that it is no time');
  await p.key('esc'); await p.waitFor('palMode === "cmd"', 'Escape back to the commands');
  await p.key('esc'); await p.waitFor('palette.hidden', 'and closed');
  await command(p, 'edit meeting details', 'Edit meeting details');
  await p.js("const slow = tana.readMeetingTime; tana.readMeetingTime = (...a) => new Promise((r) => setTimeout(r, 500)).then(() => slow(...a)); 1");
  await p.type('tomorrow from 3-5'); await p.key('↩');
  await p.waitFor('document.querySelector("#palette .row .ricon.thinking")', 'the reading row\u2019s thinking glyph');
  await p.waitFor('palRows[palIndex]?.hint === "\u21A9 Apply \u00B7 read by AI"', 'the AI\u2019s reading, to review');
  assert.equal(await p.js('!!document.querySelector("#palette .ricon.thinking")'), false, 'nothing thinks once it has read');
  const start = await p.js('new Date(parseDay("tomorrow") + "T15:00").getTime()');
  assert.equal(await p.js('palRows[palIndex].label'), await p.js('meetingSpan(' + start + ', ' + (start + 72e5) + ')'), 'tomorrow from 3-5 is tomorrow afternoon');
  assert.deepEqual(await p.js('tana.meetingInfo("mockmeeting2").then((m) => [m.start, m.end, m.attendees.length])'), was, 'nothing changes while it is only shown');
  await p.key('↩');
  await p.waitFor('palette.hidden', 'the palette closed on the press');
  await p.waitFor('tana.meetingInfo("mockmeeting2").then((m) => m.start === ' + start + ')', 'the meeting moved');
  assert.deepEqual(await p.js('tana.meetingInfo("mockmeeting2").then((m) => [m.start, m.end, m.attendees.length])'), [start, start + 72e5, was[2]], 'to the time shown, and nobody added');
});

// 17d. A meeting's editor is your private notes (renderer/meetingnotes.js, main/meeting-notes.js, docs/MEETINGS.md
// "Private notes"): the meeting stays the page, write-up or not, and nothing is made by opening it; its first words
// make notes only you can see, and the rest is any outline. Tana slow or refusing keeps each meeting's words in its own
// row, an answer landing after you moved on changes nothing on screen, and notes shared in Tana stop being the editor.
flow('golden path: type under a meeting into notes only you can see', async (p) => {
  await p.start();
  const draft = '#outline .node.draft .text';
  const typeIn = async (words) => {
    await p.waitFor('document.querySelector(' + J(draft) + ')', 'the row to type in');
    await p.js('(() => { const el = document.querySelector(' + J(draft) + '); el.focus(); placeCaret(keyOfEl(el), el.textContent.length); return 1; })()');
    await p.type(words);
  };
  const open = async (id) => { await p.js('goTo(' + J(id) + ')'); await at(p, id); await settle(p, 400); };
  const draftText = () => p.js('document.querySelector(' + J(draft) + ')?.textContent ?? null');
  const notesOf = (ev) => p.js('meetingNotes.get(' + J(ev) + ')?.id || null');
  // 1-1 with Sam: a write-up shared with the meeting, and no notes of yours yet
  await open('mockmeeting4');
  await p.waitFor('document.querySelector(".notes-head .notes-switch")', 'the line over the notes, with Notes | Summary');
  await p.js('[...document.querySelectorAll(".notes-switch [role=tab]")].find((b) => b.textContent === "Notes").click()'); await settle(p, 300); // Summary is the default
  assert.match(await p.js('document.querySelector(".notes-head").textContent'), /only you can see them/, 'the notes say who sees them');
  assert.deepEqual([await p.js('zoom.docId'), await p.js('__notes.made')], ['mockmeeting4', 0], 'the meeting is the page, and opening it made nothing');
  // Open in Tana beside the title (option A): there before any notes, the glyph alone until hovered or focused by keyboard,
  // then its words without the title moving; it opens the meeting's own link, never the notes', and makes nothing
  const btn = '#pagehead .meeting-tana';
  await p.waitFor('document.querySelector(' + J(btn) + ')', 'the Tana button beside the title');
  const labelW = () => p.js('document.querySelector(' + J(btn + ' .meeting-tana-label') + ').getBoundingClientRect().width');
  const titleBox = () => p.js('JSON.stringify(document.getElementById("title").getBoundingClientRect())');
  assert.deepEqual([await p.js('document.querySelector(' + J(btn) + ').getAttribute("aria-label")'), await p.js('document.querySelector(' + J(btn) + ').title'), await labelW()], ['Open in Tana', 'Open in Tana', 0], 'named for screen readers and in its tooltip, the glyph alone');
  const title0 = await titleBox();
  const spot = await p.js('(() => { const r = document.querySelector(' + J(btn) + ').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()');
  await p.hover(spot[0], spot[1]); await settle(p, 400);
  assert.equal(await p.js('document.querySelector(' + J(btn + ' .meeting-tana-label') + ').textContent'), 'Open in Tana');
  assert.ok((await labelW()) > 40, 'hovered: Open in Tana');
  assert.equal(await titleBox(), title0, 'and the title has not moved');
  await p.hover(5, 600); await settle(p, 400);
  assert.equal(await labelW(), 0, 'left: the glyph alone again');
  await p.key('esc'); await p.js('document.querySelector(' + J(btn) + ').focus(); 1'); await settle(p, 400);
  assert.deepEqual([await p.js('document.querySelector(' + J(btn) + ').matches(":focus-visible")'), (await labelW()) > 40], [true, true], 'focused by keyboard: Open in Tana');
  assert.equal(await titleBox(), title0, 'the title still where it was');
  await p.js('window.__opened = []; const opener = tana.openExternal; tana.openExternal = (url) => { __opened.push(url); return opener(url); }; 1');
  await p.click(spot[0], spot[1]); await settle(p, 300);
  assert.deepEqual(await p.js('__opened'), [await p.js('tana.nodeLink("mockmeeting4")')], 'it opens the meeting in Tana');
  assert.deepEqual([await p.js('__notes.made'), await p.js('meetingNotes.get("mockmeeting4")?.id || null')], [0, null], 'and makes no notes');
  // the row the notes start with, naming the meeting, is never drawn on the meeting's own page, not even for a moment
  await p.js('window.__refSeen = false; new MutationObserver(() => { if ([...document.querySelectorAll("#outline .node .text")].some((e) => e.textContent === "Open the meeting in Tana")) window.__refSeen = true; }).observe(outline, { subtree: true, childList: true, characterData: true }); 1');
  await typeIn('Synthetic first thought');
  await p.waitFor('__notes.made === 1 && meetingNotes.get("mockmeeting4")?.id', 'the notes made');
  assert.ok(await p.js('!!document.querySelector(' + J(btn) + ')'), 'the Tana button stays once the notes exist');
  await p.js('flushAll()'); await settle(p, 500);
  const notes = await notesOf('mockmeeting4');
  assert.deepEqual(await p.js('__saved(' + J(notes) + ')'), ['Open the meeting in Tana', 'Synthetic first thought'], 'the meeting, linked, then every word');
  assert.deepEqual(await p.js('tana.children(' + J(notes) + ').then((rows) => rows[0].segments)'), [{ text: 'Open the meeting in Tana', marks: { link: 'https://home.tana.inc/o/mock/e/mockmeeting4' } }], 'the meeting as a link to its page in Tana');
  assert.deepEqual([await p.js('__saved("mockmeeting4")'), await p.js('zoom.docId')], [[], 'mockmeeting4'], 'none in the meeting, which is still the page');
  await p.key('↩'); await p.type('Synthetic second thought'); await p.js('flushAll()'); await settle(p, 500);
  assert.deepEqual(await p.js('__saved(' + J(notes) + ')'), ['Open the meeting in Tana', 'Synthetic first thought', 'Synthetic second thought'], 'Enter makes a row, as anywhere');
  // the write-up opened on its own, and Back is the meeting with its notes
  await p.js('goTo("tana:text:mockwriteup4")'); await at(p, 'tana:text:mockwriteup4');
  await p.key('⌘['); await at(p, 'mockmeeting4'); await settle(p, 500);
  assert.deepEqual(await p.js('__screen()'), ['Synthetic first thought', 'Synthetic second thought'], 'reopened: your words, and no row naming the meeting you are on');
  assert.equal(await p.js('window.__refSeen'), false, 'the meeting’s row never appeared on its page');
  // the notes on their own (as in Tana): the row that names the meeting is there, first
  await open(notes);
  assert.deepEqual(await p.js('__screen()'), ['Open the meeting in Tana', 'Synthetic first thought', 'Synthetic second thought'], 'on their own, the notes name their meeting');
  // that row changed by you is yours: shown on the meeting's page too
  await p.js('tana.setText(' + J(notes) + ', meetingNotes.get("mockmeeting4").reference.id, [{ text: "Open the meeting in Tana" }])');
  await open('mockmeeting4');
  assert.deepEqual(await p.js('__screen()'), ['Open the meeting in Tana', 'Synthetic first thought', 'Synthetic second thought'], 'a row you changed shows');
  await p.js('tana.setText(' + J(notes) + ', meetingNotes.get("mockmeeting4").reference.id, [{ text: "Open the meeting in Tana", marks: { link: meetingNotes.get("mockmeeting4").reference.link } }])');
  await open('mockmeeting4');
  assert.deepEqual(await p.js('__screen()'), ['Synthetic first thought', 'Synthetic second thought'], 'as it was written: hidden again');
  // ↑ from the notes' first row leaves them for the meeting above (#764): its fields or its title, never the row the page
  // does not draw; ↓ comes back to that first row
  await p.js('setCaret(texts()[0], 0)');
  assert.equal(await p.js('texts()[0].textContent'), 'Synthetic first thought', 'the first row the caret can reach is your own');
  await p.key('↑');
  assert.equal(await p.js('(() => { const a = document.activeElement; return a === document.getElementById("title") || !!a?.closest?.("#fields"); })()'), true, 'up from the notes is the meeting');
  await p.key('↓');
  assert.equal(await p.js('document.activeElement === ' + T('Synthetic first thought')), true, 'and down is the notes’ first row again');
  // Offsite: your notes already there are its editor, used as they are
  await open('mockmeeting5');
  await p.waitFor(T('Bring the synthetic agenda'), 'your notes on Offsite');
  assert.equal(await p.js('__notes.made'), 1, 'nothing new made');
  // Tana refusing twice, slowly: each meeting keeps its own words, and typing on tries again
  await p.js('__notes.fail = 2; __notes.delay = 300; 1');
  await open('mockmeeting3'); await typeIn('Alpha');
  await p.waitFor('__notes.fail === 1', 'the first try refused'); await settle(p, 400);
  await open('mockmeeting1'); await typeIn('Beta');
  await p.waitFor('__notes.fail === 0', 'the second refused'); await settle(p, 400);
  await open('mockmeeting3');
  assert.equal(await draftText(), 'Alpha', 'Platform Guild keeps its words');
  await open('mockmeeting1');
  assert.equal(await draftText(), 'Beta', 'and Board prep its own');
  assert.equal(await p.js('__notes.made'), 1, 'nothing was made while Tana refused');
  // typed on, made now, slowly: the answer lands after you moved on and leaves the page you are on alone
  await p.js('__notes.delay = 900; 1');
  await typeIn(' more');
  await open('mockmeeting3');
  await p.waitFor('meetingNotes.get("mockmeeting1")?.id', 'Board prep\u2019s notes made after you left', 5000);
  await settle(p, 700); await p.js('flushAll()'); await settle(p, 300);
  assert.deepEqual([await p.js('zoom.docId'), await draftText()], ['mockmeeting3', 'Alpha'], 'the late answer moved nothing here');
  assert.deepEqual(await p.js('__saved(' + J(await notesOf('mockmeeting1')) + ')'), ['Open the meeting in Tana', 'Beta more'], 'and Board prep\u2019s notes hold all of its words');
  // Tana has not said yet whether they exist: said once, and tried again by itself, no more typing needed
  await p.js('__notes.delay = 0; __notes.failKept = 2; 1');
  await typeIn(' too');
  await p.waitFor('meetingNotes.get("mockmeeting3")?.id', 'Platform Guild\u2019s notes, made by the retries', 15000); await p.js('flushAll()'); await settle(p, 500);
  assert.deepEqual([await p.js('__notes.failKept'), await p.js('__saved(' + J(await notesOf('mockmeeting3')) + ')')], [0, ['Open the meeting in Tana', 'Alpha too']]);
  // Shared by you in Tana: still the editor, the same notes, said so, every word typed meanwhile kept and the caret where it
  // was. This page's answer comes late, as a second pane's might; the line says it is checking — never "only you" — and
  // when another page's ask releases the writes (main holds them per process, not per pane), they go on under "Checking".
  await open('mockmeeting4');
  const head = () => p.js('document.querySelector(".notes-head")?.textContent || ""');
  const typeAtEnd = async (words) => { await p.js('(() => { const el = ' + T('Synthetic second thought') + '; el.focus(); placeCaret(keyOfEl(el), el.textContent.length); return 1; })()'); await p.type(words); };
  const madeBefore = await p.js('__notes.made');
  await typeAtEnd(' and more');
  await p.js('__notes.delay = 1500; __notes.share("mockmeeting4"); 1');
  await p.waitFor('/Checking/.test(document.querySelector(".notes-head")?.textContent || "")', 'the line checking at once');
  assert.doesNotMatch(await head(), /only you/, 'no "only you" while it is checked');
  await p.js('flushAll()'); await settle(p, 200);
  assert.ok(!(await p.js('__saved(' + J(notes) + ')')).includes('Synthetic second thought and more'), 'held: nothing written under the old line');
  await p.js('__notes.release("mockmeeting4"); 1'); // another pane was told who sees them
  await p.type(' still'); await p.js('flushAll()'); await settle(p, 200);
  assert.match(await head(), /Checking/, 'written while this line says checking, never only you');
  await p.waitFor('/Shared notes/.test(document.querySelector(".notes-head")?.textContent || "")', 'the line says shared', 5000);
  await p.js('flushAll()'); await settle(p, 400);
  assert.match(await head(), /Shared notes\s*· visible to/, 'shared, and with whom');
  assert.deepEqual([await p.js('document.querySelectorAll(".notes-head .face").length'), await p.js('!!document.querySelector(".notes-head .ticon[aria-label=\\"Visible only to you\\"]")')], [2, false], 'two faces, and no lock');
  assert.deepEqual([(await p.js('__saved(' + J(notes) + ')')).at(-1), await notesOf('mockmeeting4'), await p.js('__notes.made')], ['Synthetic second thought and more still', notes, madeBefore], 'every word in the same notes, none made');
  assert.equal(await p.js('document.activeElement === ' + T('Synthetic second thought')), true, 'the caret stayed in the row');
  await p.js('__notes.delay = 0; 1');
  // reopened: the same shared notes
  await open('mockmeeting3'); await open('mockmeeting4');
  assert.deepEqual([await notesOf('mockmeeting4'), await p.js('__notes.made')], [notes, madeBefore]);
  assert.match(await head(), /Shared notes/);
  // a public link, then everyone, then read only, then private again
  await p.js('__notes.share("mockmeeting4", { link: true }); 1');
  await p.waitFor('/anyone with the link/.test(document.querySelector(".notes-head")?.textContent || "")', 'the link said');
  await p.js('__notes.share("mockmeeting4", { scope: "everyone", people: [], peopleCount: 0 }); 1');
  await p.waitFor('/everyone in your organization/.test(document.querySelector(".notes-head")?.textContent || "")', 'everyone said');
  await p.js('__notes.readOnly("mockmeeting4"); 1');
  await p.waitFor('/read only/.test(document.querySelector(".notes-head")?.textContent || "")', 'read only said');
  await p.waitFor('!(' + T('Synthetic second thought') + ').isContentEditable', 'and the rows read only');
  await p.js('__notes.unshare("mockmeeting4"); 1');
  await p.waitFor('/only you can see them/.test(document.querySelector(".notes-head")?.textContent || "") && (' + T('Synthetic second thought') + ').isContentEditable', 'only you again, and writable');
});

// 17e. Notes | Summary (#761): a meeting with a write-up switches between your notes and its write-up on the meeting's own
// page. Summary is the default; it shows the write-up's rows and its own audience (three people, not the meeting's
// two) and makes no notes; what was typed is saved to the document it was typed in; a read-only write-up says so; an
// answer for a meeting you left draws nothing; a meeting without a write-up has no switch.
flow('golden path: switch a meeting between your notes and its summary', async (p) => {
  await p.start();
  const open = async (id) => { await p.js('goTo(' + J(id) + ')'); await at(p, id); await settle(p, 400); };
  const tab = (name) => '[...document.querySelectorAll(".notes-switch [role=tab]")].find((b) => b.textContent === ' + J(name) + ')';
  const selected = () => p.js('document.querySelector(".notes-switch [aria-selected=true]")?.textContent || null');
  const wu = 'tana:text:mockwriteup4';
  await open('mockmeeting5');
  assert.equal(await p.js('!!document.querySelector(".notes-switch")'), false, 'no write-up: no switch');
  await open('mockmeeting4');
  await p.waitFor('document.querySelector(".notes-switch")', 'Notes | Summary');
  // Summary by default, with no notes yet: the write-up's rows and who sees it, from the write-up itself; no notes made
  await p.waitFor('/visible to/.test(document.querySelector(".notes-head")?.textContent || "")', 'the summary\u2019s own audience');
  assert.deepEqual(await p.js('__screen()'), ['Agreed to trim the synthetic roadmap to two themes', 'Sam drafts the pilot review by Friday', 'Next check-in in two weeks'], 'the write-up\u2019s rows');
  assert.deepEqual([await selected(), await p.js('document.querySelectorAll(".notes-head .face").length'), await p.js('!!document.querySelector(".notes-head [aria-label=\\"Visible only to you\\"]")')], ['Summary', 3, false], 'three faces, its own, and no lock');
  assert.deepEqual([await p.js('zoom.docId'), await p.js('!!document.querySelector("#pagehead .meeting-tana")'), await p.js('__notes.made')], ['mockmeeting4', true, 0], 'the meeting stays the page, its Tana button too, and no notes are made');
  // typed into the summary: saved to the write-up
  await p.js('(() => { const el = ' + T('Next check-in in two weeks') + '; el.focus(); placeCaret(keyOfEl(el), el.textContent.length); return 1; })()');
  await p.type(' or sooner'); await p.js('flushAll()'); await settle(p, 300);
  assert.equal((await p.js('__saved(' + J(wu) + ')')).at(-1), 'Next check-in in two weeks or sooner', 'saved to the write-up');
  // back to Notes: the empty notes' draft row; the first words make them, private
  await p.js('(' + tab('Notes') + ').click()'); await settle(p, 300);
  assert.equal(await selected(), 'Notes');
  await p.waitFor('document.querySelector("#outline .node.draft .text")', 'the notes\u2019 draft row');
  await p.js('(() => { const el = document.querySelector("#outline .node.draft .text"); el.focus(); placeCaret(keyOfEl(el), 0); return 1; })()');
  // Summary while the notes are still being made by those first words: they are made with them, and Summary stays
  await p.js('__notes.delay = 600; 1');
  await p.type('Private thought'); await p.js('(' + tab('Summary') + ').click()');
  await p.waitFor('__notes.made === 1 && meetingNotes.get("mockmeeting4")?.id', 'the notes made'); await settle(p, 800);
  const notes = await p.js('meetingNotes.get("mockmeeting4").id');
  assert.deepEqual([await selected(), (await p.js('__screen()'))[0], (await p.js('__saved(' + J(notes) + ')')).at(-1)], ['Summary', 'Agreed to trim the synthetic roadmap to two themes', 'Private thought'], 'the words in the notes, the summary still shown');
  await p.js('__notes.delay = 0; (' + tab('Notes') + ').click()'); await settle(p, 300);
  assert.deepEqual(await p.js('__screen()'), ['Private thought'], 'and in the notes when they are shown');
  // typed and not yet saved, then Summary: saved to the notes, not the write-up; back to Notes, the caret where it was
  await p.js('(() => { const el = ' + T('Private thought') + '; el.focus(); placeCaret(keyOfEl(el), el.textContent.length); return 1; })()');
  await p.type(' kept'); await p.js('(' + tab('Summary') + ').click()'); await settle(p, 500);
  assert.deepEqual([(await p.js('__saved(' + J(notes) + ')')).at(-1), (await p.js('__saved(' + J(wu) + ')')).includes('Private thought kept')], ['Private thought kept', false], 'switching saved it where it was typed');
  await p.js('(' + tab('Notes') + ').click()'); await settle(p, 300);
  assert.deepEqual([await p.js('document.activeElement === ' + T('Private thought kept')), await p.js('__caret().offset')], [true, 'Private thought kept'.length], 'the caret back where it was');
  // reopened: the meeting remembers Notes for the session, holding your words
  await open('mockmeeting5'); await open('mockmeeting4');
  assert.equal(await selected(), 'Notes', 'reopened on what you last chose');
  assert.deepEqual(await p.js('__screen()'), ['Private thought kept'], 'your notes, as saved');
  // who sees the write-up changed in Tana while its first answer was still on its way: the newer answer stands
  await p.js('(' + tab('Summary') + ').click()'); await settle(p, 300);
  await p.js('summaryMeta.clear(); let first = true; const own = tana.taskMeta; tana.taskMeta = (id) => { const old = own(id); if (id !== ' + J(wu) + ' || !first) return old; first = false; return new Promise((r) => setTimeout(r, 800)).then(() => old); }; render(true); 1');
  await settle(p, 100);
  await p.js('tana.setSharing(' + J(wu) + ', { rule: "me", participants: [] }); 1');
  await p.waitFor('/only you can see it/.test(document.querySelector(".notes-head")?.textContent || "")', 'the newer answer: only you');
  await settle(p, 1000);
  assert.deepEqual([await p.js('/only you can see it/.test(document.querySelector(".notes-head").textContent)'), await p.js('document.querySelectorAll(".notes-head .face").length')], [true, 0], 'the older answer, landing later, did not replace it');
  // made public while a summary row is being typed in, its answer slow: the line says it is checking at once (no stale
  // lock under the caret), then anyone with the link; the words and the caret stay where they are
  await p.js('(() => { const el = ' + T('Sam drafts the pilot review by Friday') + '; el.focus(); placeCaret(keyOfEl(el), el.textContent.length); return 1; })()');
  await p.type(' or Monday');
  await p.js('const own2 = tana.taskMeta; tana.taskMeta = (id) => new Promise((r) => setTimeout(r, 800)).then(() => own2(id)); __notes.summaryLink(true); 1'); await settle(p, 100);
  assert.deepEqual([await p.js('/Checking/.test(document.querySelector(".notes-head").textContent)'), await p.js('!!document.querySelector(' + J('.notes-head [aria-label="Visible only to you"]') + ')')], [true, false], 'checking at once, no lock');
  await p.waitFor('/anyone with the link/.test(document.querySelector(".notes-head")?.textContent || "")', 'the link said', 3000);
  assert.deepEqual([await p.js('document.activeElement === ' + T('Sam drafts the pilot review by Friday or Monday')), await p.js('__caret().offset'), await p.js('!!document.querySelector(' + J('.notes-head [aria-label="Visible only to you"]') + ')')], [true, 'Sam drafts the pilot review by Friday or Monday'.length, false], 'the words and the caret kept, and no lock');
  await p.js('tana.taskMeta = own2; flushAll(); 1'); await settle(p, 300);
  assert.equal((await p.js('__saved(' + J(wu) + ')'))[1], 'Sam drafts the pilot review by Friday or Monday', 'and saved to the write-up');
  await p.js('__notes.summaryLink(false); 1');
  await p.waitFor('/only you can see it/.test(document.querySelector(".notes-head")?.textContent || "")', 'private again');
  await p.js('__notes.summaryLink(true); 1');
  await p.waitFor('/anyone with the link/.test(document.querySelector(".notes-head")?.textContent || "")', 'the link said');
  assert.deepEqual([await p.js('/only you/.test(document.querySelector(".notes-head").textContent)'), await p.js('!!document.querySelector(' + J('.notes-head [aria-label="Visible only to you"]') + ')'), await p.js('!!document.querySelector(' + J('.notes-head [aria-label="Anyone with the link"]') + ')')], [false, false, true], 'the globe, no lock and no only you');
  await p.js('__notes.summaryLink(false); 1');
  await p.waitFor('/only you can see it/.test(document.querySelector(".notes-head")?.textContent || "") && !!document.querySelector(' + J('.notes-head [aria-label="Visible only to you"]') + ')', 'only you and the lock again');
  // the write-up made read-only in Tana: said, and its rows are read-only
  await p.js('(' + tab('Summary') + ').click()'); await settle(p, 300);
  await p.js('__notes.summaryReadOnly(); 1');
  await p.waitFor('/read only/.test(document.querySelector(".notes-head")?.textContent || "")', 'read only said');
  await p.waitFor('!(' + T('Agreed to trim the synthetic roadmap to two themes') + ').isContentEditable', 'and its rows read-only');
  // an answer asked before the session changed is dropped: the write-up's audience is held back, the connection drops
  // (forgetNotes, as renderer/app.js does), and the late answer leaves nothing behind
  await p.js('(' + tab('Notes') + ').click(); summaryMeta.clear(); const slow = tana.taskMeta; tana.taskMeta = (id) => new Promise((r) => setTimeout(r, 700)).then(() => slow(id)); tana.summaryUri = async () => null; 1'); await settle(p, 200);
  await p.js('(' + tab('Summary') + ').click()'); await settle(p, 50);
  assert.equal(await p.js('summaryMeta.get(' + J(wu) + ')'), null, 'asked, not answered yet');
  await p.js('forgetNotes(false); render(true); 1'); await settle(p, 1000);
  assert.deepEqual([await p.js('summaryMeta.has(' + J(wu) + ')'), await p.js('document.querySelectorAll(".notes-head .face").length'), await p.js('!!document.querySelector(".notes-switch")')], [false, 0, false], 'the late answer is dropped, and nothing of the write-up stays on screen');
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

// Connect your personal agent (main/agents/linked.js, docs/AGENT-RELAY.md): ⌘K Connect your personal agent names both
// plugins, How to add them … opens the steps for your Dot and any other agent and comes back to the same code, then it
// copies the instructions that carry a one-time code; while the page waits the agent links itself
// (the mock's Dot, on the third time the page asks), the palette closes on its name, and from then on it is one of
// your agents, with a page of its own to rename or unlink it
flow('golden path: connect your Dot with a code, and it joins your agents', async (p) => {
  await p.start();
  await command(p, 'connect your personal agent', 'Connect your personal agent \u2026');
  await p.waitFor('palMode === "linkAgent" && palRows.length === 7', 'the plugins, the instructions and the wait');
  assert.deepEqual(await p.js('palRows.slice(0, 3).map((r) => [r.icon, r.label, r.hint])'), [['orbital', 'Orbital', 'https://orbital.md/mcp · ↩ copies'], ['tana', 'Tana', 'https://home.tana.inc/mcp · ↩ copies'], ['help', 'How to add them …', 'Your OpenAI Dot, or any other agent']],
    'both plugins as a custom MCP server form asks for them, a name and a URL, then the steps');
  assert.equal(await p.js('palIndex'), 0, '↩ starts at Orbital');
  await p.js('palRows[2].run()');
  await p.waitFor('palMode === "linkHelp" && palRows[0].label === "Open ChatGPT plugins"', 'the steps, ChatGPT\u2019s plugins first');
  assert.deepEqual(await p.js('palRows.map((r) => r.group)'), ['Your OpenAI Dot', 'Your OpenAI Dot', 'Any other agent'], 'one paragraph for your Dot, one for any other agent');
  assert.match(await p.js('palRows[1].label'), /^In ChatGPT: Add, then Create custom MCP server, once for Orbital \(orbital\.md\/mcp\) and once for Tana/, 'your Dot\u2019s steps in one paragraph');
  assert.match(await p.js('palRows.at(-1).label'), /needs MCP events/, 'any other agent needs MCP events');
  assert.equal(await p.js('palRows.some((r) => /link_orbital/.test(r.label))'), false, 'no tool names in the steps');
  await p.js('backPalette()');
  await p.waitFor('palMode === "linkAgent" && palRows.length === 7 && relayCtx.code === "7KQX-M2PD"', 'back on the page, its code still waiting');
  assert.deepEqual(await p.js('[palRows[3].label, palRows[3].group, !!palRows[3].disabled]'), ['Copy the instructions', 'Then ask your agent to link', false], 'then the instructions');
  assert.match(await p.js('relayCtx.prompt'), /^Call Orbital's link_orbital tool with the code 7KQX-M2PD and your own name \(Dot if you have none\)\. Then subscribe to Orbital's task\.assigned event\. Each time an Orbital event fires, do what its data\.instructions say.*kept nowhere/, 'what it copies: the code, the event that wakes it and carries its instructions, and what goes through orbital.md');
  assert.equal(await p.js('document.querySelector("#palette .list").textContent.includes("7KQX-M2PD")'), false, 'which the card does not show');
  assert.match(await p.js('palRows[4].label'), /^Only the node's id and your request go through orbital\.md, and it keeps neither/, 'it says what goes through orbital.md');
  assert.deepEqual(await p.js('[palRows[5].label, !!palRows[5].icon, palRows[5].group === palRows[3].group, !!document.querySelector("#palette .row .label.sweep")]'), ['Waiting for your agent to use the code…', false, true, true],
    'and waits in the same group, with no glyph, a light passing over its words');
  // where the heading's words start (its box plus its padding), measured once the page has slid in
  const offset = '(() => { const g = document.querySelector("#palette .list .group"); return document.querySelector("#palette .row .label.sweep").getBoundingClientRect().left - g.getBoundingClientRect().left - parseFloat(getComputedStyle(g).paddingLeft); })()';
  await p.waitFor('Math.abs(' + offset + ') <= 1', 'the wait to start where the heading\u2019s words do (' + await p.js(offset) + 'px off at first)');
  assert.match(await p.js('palRows[5].hint'), /^Works once · \d+:\d\d left$/, 'saying how long the code lasts');
  // left and opened again while its code waits: the same page, no new code (the relay holds five at most)
  await p.js('(() => { const f = tana.relayLink; window.__codes = 0; tana.relayLink = (...a) => { window.__codes++; return f(...a); }; return 1; })()');
  await closePalette(p);
  await command(p, 'connect your personal agent', 'Connect your personal agent \u2026');
  await p.waitFor('palMode === "linkAgent" && palRows.length === 7', 'the page left, back');
  assert.deepEqual(await p.js('[window.__codes, relayCtx.code]'), [0, '7KQX-M2PD'], 'reopened while its code waits: that code again, no new one');
  await p.waitFor('document.getElementById("palette").hidden && document.getElementById("toast").textContent === "Linked Dot · ChatGPT"', 'the palette to close on the agent that linked', 10000);
  await command(p, 'set default agent', 'Set default agent \u2026');
  await p.waitFor('palMode === "defaultAgent" && palRows.some((r) => r.label === "Dot")', 'Set default agent');
  assert.deepEqual(await p.js('palRows.filter((r) => r.hint === "✓").map((r) => r.label)'), ['Dot'], 'linking your Dot made it the default');
  await closePalette(p);
  await command(p, 'choose agents', 'Choose agents \u2026');
  await p.waitFor('palMode === "agents" && palRows.some((r) => r.label === "Dot")', 'your Dot among your agents');
  assert.equal(await p.js('palRows.find((r) => r.label === "Dot").icon'), 'robot', 'drawn with the same glyph as the other agents');
  assert.deepEqual(await p.js('(({ group, hint }) => [group, hint])(palRows.find((r) => r.label === "Dot"))'), ['Agents', 'On · ChatGPT · seen just now'], 'among the agents, on, and where it runs');
  assert.equal(await p.js('palRows.some((r) => /default/i.test(r.group))'), false, 'the default is picked elsewhere');
  await p.type('dot');
  await p.waitFor('palRows[palIndex] && palRows[palIndex].label === "Dot"', 'its row');
  await p.key('↩');
  await p.waitFor('palMode === "linkedAgent"', 'its page');
  assert.deepEqual(await p.js('palRows.map((r) => r.label)'), ['Rename \u2026', 'Switch off', 'Unlink'], 'rename, switch off, unlink');
  await p.type('unlink'); await p.waitFor('palRows[palIndex] && palRows[palIndex].label === "Unlink"', 'Unlink'); await p.key('↩');
  await p.waitFor('palMode === "agents" && !palRows.some((r) => r.label === "Dot")', 'Choose agents without it');
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

// 20b. A list's own rows (renderer/nodes.js topListRow): a first click selects the row, a click on it once selected
// goes in — the caret where it was clicked when its title can be typed in, the row's page when it cannot — and the
// bullet zooms in at once. Before, a first click put the caret in an editable row and did nothing on a read-only one.
flow('golden path: a list row is selected by a click, edited or opened by the next, zoomed by its bullet', async (p) => {
  await p.start();
  const locked = 'mockdoc2'; // read-only, as main lists a document you may not write
  await p.js('(() => { const f = tana.viewList; tana.viewList = async (...a) => { const r = await f(...a); return { ...r, nodes: (r.nodes || []).map((n) => (n.id === ' + J(locked) + ' ? { ...n, editable: false } : n)) }; }; 1; })()');
  await p.js('setView("library")'); await p.js('loadView("library")'); await p.waitFor(T('Check out the new editor'), 'the Library row');
  await p.waitFor('!' + T('Check out the new editor') + '.isContentEditable', 'the locked row drawn read-only');
  const row = await p.js('(() => { const it = [...document.querySelectorAll("#outline .node")].map((n) => items.get(n.dataset.key)).find((it) => it && topListRow(it) && typesInto(it) && it.node.id !== ' + J(locked) + ' && (it.node.text || "").length > 8); return it && { id: it.node.id, key: it.key, words: textEl(it.key).textContent.slice(0, 8) }; })()');
  assert.ok(row, 'an editable Library row');
  const selected = () => p.js('selKeys()');
  await clickWords(p, row.words); await settle(p, 150);
  assert.deepEqual(await selected(), [row.key], 'the first click selects the editable row');
  assert.equal((await p.js('__caret()')).editable, false, 'and puts no caret in it');
  const ring = (words) => p.js('getComputedStyle(' + T(words) + ').outlineStyle');
  assert.equal(await ring(row.words), 'solid', 'the selected editable row is ringed in blue, as a focused read-only row is');
  await p.key('⇧↓'); await settle(p, 100);
  assert.equal(await ring(row.words), 'none', 'a range made with ⇧ is a band, not rings');
  await p.key('esc'); await p.js('leaveText(); sel = null; applySel()'); await settle(p, 100);
  await clickWords(p, row.words); await settle(p, 150);
  await clickWords(p, row.words); await settle(p, 150);
  assert.deepEqual(await p.js('[__caret().key, __caret().editable, selKeys().length]'), [row.key, true, 0], 'the second click puts the caret in its title');
  await clickWords(p, 'Check out the new editor'); await settle(p, 150);
  assert.deepEqual(await p.js('[selKeys().map((k) => items.get(k).node.id), zoom && zoom.docId]'), [[locked], null], 'the first click selects the read-only row and opens nothing');
  assert.equal(await ring('Check out the new editor'), 'solid', 'and rings it');
  await clickWords(p, 'Check out the new editor');
  await at(p, locked);
  // an open that leaves this page where it is (the place open in another pane, which comes forward there) lets the
  // selection go and takes its ring off too
  await p.js('setView("library")'); await p.waitFor(T('Check out the new editor'), 'the Library again');
  await clickWords(p, 'Check out the new editor'); await settle(p, 150);
  await p.js('window.__zoomTo = zoomTo; zoomTo = () => {}; 1'); // as zoomTo does when inOtherPane answers
  await clickWords(p, 'Check out the new editor'); await settle(p, 150);
  await p.js('zoomTo = window.__zoomTo; 1');
  assert.deepEqual(await p.js('[zoom, selKeys().length, document.querySelectorAll("#outline .node.selected, #outline .node.picked").length]'), [null, 0, 0], 'an open that stays on the page leaves no ring behind');
  await p.js('setView("library")'); await p.waitFor(T(row.words), 'the Library again');
  await p.js(rowOf(row.words) + '.querySelector(".bullet").click()');
  await at(p, row.id);
});

// 21. Panes and tabs (#138, #435, #463; shell.html): the window's shell on a stand-in for main that opens a page the way
// 20c. Picked up by its words (renderer/render.js .selectfirst): a list row that is not selected yet is one thing to
// press, so a drag from anywhere on it carries the row, as one from its bullet does; selected, its words are words
// again, and a drag across them selects them instead of picking the row up
flow('golden path: a list row is picked up by its words until it is selected', async (p) => {
  await p.start({ real: true }); // only a real node can be picked up (renderer/drag.js canDragItem)
  await p.js('setView("library")'); await p.waitFor(T('Discuss the two open'), 'the Library row'); await settle(p, 600); // its sections and facts land in parts
  const words = 'Discuss the two open', key = await p.js('keyOfEl(' + T(words) + ')');
  const point = () => p.js('(() => { const r = document.createRange(); r.selectNodeContents(' + T(words) + '); const b = r.getClientRects()[0]; return [b.left + 40, b.top + b.height / 2]; })()');
  let [x, y] = await point();
  assert.equal(await p.js('document.elementFromPoint(' + x + ', ' + y + ')?.closest(".node")?.dataset.key'), key, 'the row\u2019s words in view to press');
  const carried = await p.drag(x, y, x + 10, y - 90);
  assert.ok(carried, 'a drag from the words of a row not yet selected picks it up');
  assert.deepEqual(carried.items.filter((i) => i.mimeType === 'application/x-orbital-row').map((i) => i.data), [key], 'and carries that row');
  assert.equal((await p.js('__caret()')).editable, false, 'with no caret left in it');
  await clickWords(p, words); await settle(p, 150);
  assert.deepEqual(await p.js('selKeys()'), [key], 'a click still selects it');
  [x, y] = await point();
  assert.equal(await p.drag(x, y, x + 60, y), null, 'selected, a drag across its words picks nothing up');
  assert.deepEqual(await p.js('[__caret().key, __caret().editable]'), [key, true], 'it goes into the words instead');
});

// main.js window:split does. ⌘↩ on a search result opens it in a new tab, ⇧↩ in a pane beside; ⇧⌘N, ⌘N and ⌥⌘N a pane, a
// tab and a floating pane each on a new note of its own (#756), a held key making one; the keys stay with the page just
// opened, and every page keeps its own place.
const TWO_PANES = { schema: 1, root: { kind: 'split', id: 'split-m', axis: 'x', weights: [0.55, 0.45], children: [{ kind: 'panel', id: 'panel-a', views: ['page'], selected: 'page' },
  { kind: 'panel', id: 'panel-b', views: ['page2'], selected: 'page2' }] }, floating: [], hidden: [], views: { page: { type: 'page', params: { side: '' } }, page2: { type: 'page', params: { side: '2' } } } };
// On the mock a page has no preload to give it its id, so every page reads the one 'view' and 'place': the page about
// to open gets them written just before, as manual/scenes/kit.js live() does
const SHELL_API = 'if (window === top) { let seq = 2; window.shell = { state: () => ({ doc: ' + J(TWO_PANES) + ', theme: "light" }), onCommand: (cb) => { window.shellCmd = cb; }, layout() {} };'
  + ' window.orbOpen = (where, start, from) => { const id = String(++seq); window.lastStart = start; localStorage.setItem("view", start.view || "library"); localStorage.setItem("place", start.place || "{}"); window.shellCmd("open", { id, where, from, focus: true }); return id; }; }';
// Each page runs a mock of its own, so a note one page made is unknown to the page opened on it; main, which both share
// in the app, would have it. The new page is handed that one note's node, as main would answer it.
const NOTE_FROM_OPENER = 'const pl = JSON.parse((parent.lastStart && parent.lastStart.place) || "{}"); if (pl.edit) { const o = tana.node; tana.node = async (id) => (id === pl.docId ? { id, title: pl.title, kind: "document", icon: "doc", editable: true, hasChildren: true } : o(id)); }';
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
      for (let i = 0; ; i++) { try { await p.jsIn(s, 'tana.splitWindow = async (where, start) => parent.orbOpen(where, start || {}, ' + J(s) + '); ' + NOTE_FROM_OPENER + '; document.getElementById("login")?.click(); 1'); break; } catch (e) { if (i > 20) throw e; await p.sleep(50); } }
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
  await p.waitFor(frame('5') + '.contentDocument.getElementById("title").textContent === "New Note"', 'the new pane on its note');
  assert.deepEqual(await tabs(), [['Schedule something with Sam Okafor and Dana Brooks', 'Prepare the offsite agenda'], ['Library'], ['Book a room for the offsite'], ['New Note']], '⇧↩ opened a pane beside, ⇧⌘N a new pane on a new note');
  // the shell gives a new pane the keys once its frame has loaded (shell.js open), a moment after it is drawn
  await p.waitFor('new URL(document.activeElement.src).searchParams.get("side") === "5"', 'the keys to go with the new pane');
  await p.waitFor(frame('5') + '.contentDocument.activeElement?.closest?.("#outline .node")', 'the caret in the new note');
  // the window can lose and regain focus as the shell lays the pane out: coming back with nothing focused, the note
  // it opened on gets the caret back (renderer/edit.js caretBack)
  await p.jsIn('5', 'document.activeElement.blur(); dispatchEvent(new FocusEvent("focus")); 1');
  await p.waitFor(frame('5') + '.contentDocument.activeElement?.closest?.("#outline .node")', 'the caret back in the new note');
  assert.deepEqual(await places(), { '': 'Schedule something with Sam Okafor and Dana Brooks', 2: 'Library', 3: 'Prepare the offsite agenda', 4: 'Book a room for the offsite', 5: 'New Note' }, 'every page kept its own place');
  await p.key('⌘N', 4, true); // held: the first press and three repeats
  await pages(6); await p.sleep(800);
  assert.equal((await sides()).length, 6, 'a held ⌘N opens one tab');
  assert.deepEqual((await tabs()).at(-1), ['New Note', 'New Note'], 'beside the page that asked, on a new note');
  await p.key('⌥⌘N');
  await pages(7);
  await p.waitFor(frame('7') + '.contentDocument.getElementById("title").textContent === "New Note"', 'the floating pane on its note');
  const notes = []; for (const s of ['5', '6', '7']) notes.push(await p.jsIn(s, 'zoom && zoom.docId'));
  assert.equal(new Set(notes).size, 3, 'each key made a note of its own');
  assert.ok(notes.every((id) => /^tana:text:/.test(id)), 'and opened its page on it');
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
    let onEvent = null; // the one Chromium event a step waits for (drag below)
    ws.onmessage = (m) => { const d = JSON.parse(m.data);
      if (d.method && onEvent) onEvent(d);
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
    // held: the first press and then repeats (e.repeat), as a key held down sends them, with one key-up at the end
    const key = async (combo, times = 1, held = false) => {
      const k = parseKey(combo), b = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.mods };
      for (let i = 0; i < times; i++) {
        await send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...b, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}), ...(held && i > 0 ? { autoRepeat: true } : {}) });
        if (!held || i === times - 1) await send('Input.dispatchKeyEvent', { type: 'keyUp', ...b });
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
    const hover = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(80); }; // the pointer over a point, nothing pressed
    // a drag as a hand makes one: pressed at one point, moved, let go at another. Chromium starts the drag itself from
    // the press (so whatever stops a drag from beginning shows here, as __drag cannot), hands it to us instead of the
    // OS, and we drop it through its own drag events. Answers what the drag carried ({ items: [{ mimeType, data }] }),
    // or null when none began.
    const drag = async (x0, y0, x1, y1) => {
      await send('Input.setInterceptDrags', { enabled: true });
      const began = new Promise((r) => { onEvent = (d) => { if (d.method === 'Input.dragIntercepted') r(d.params.data); }; });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 6; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 6, y: y0 + ((y1 - y0) * i) / 6, button: 'left', buttons: 1 });
      const data = await Promise.race([began, sleep(1000).then(() => null)]);
      onEvent = null;
      if (data) for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x: x1, y: y1, data });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
      await send('Input.setInterceptDrags', { enabled: false });
      await sleep(120);
      return data;
    };
    // a script every page this flow opens runs before its own (what preload gives a page main opens: a stand-in for
    // window.api); taken away when the flow ends, so the next flow's pages are the mock's again
    const loaded = [];
    const beforeLoad = async (source) => { loaded.push((await send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier); };
    const page = { js, jsIn, waitFor, key, type, click, hover, drag, start, open, sleep, beforeLoad };

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

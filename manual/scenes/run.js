#!/usr/bin/env node
'use strict';
// The manual's pictures (manual/media): stills (WebP) and looping clips (MP4) of the real window — shell.html with its
// Trellis panes — on the renderer's mock data, in headless Chromium over the DevTools protocol, the way the design
// skill's shoot.js draws it. A scene file exports shots; a shot plays its steps in the window and ends in a still, or,
// with video: true, is recorded while its steps play, with a cursor and the keys pressed drawn over it.
//   node manual/scenes/run.js manual/scenes/<chapter>.js [more.js …] [--only a,b] [--themes light,dark] [--force] [--out dir]
// Incremental: manifest.json (committed) keeps a hash of every shot as it was last recorded, and a shot whose definition
// is unchanged and whose file exists is skipped. --force records them anyway (after a change to how the app looks);
// --adopt records the current definitions as done without drawing anything (after editing a scene's comments, say).
// A still whose bytes come out the same is not rewritten, and every page runs on a fixed clock (--now, local time), so
// recording again changes only what really changed. Pass several scene files to record them in one Chromium.
// A shot with url: 'manual/<chapter>.html' draws that page of the manual instead of the app (to check a chapter):
// full: true takes the whole page, scrolled through once so everything that fades in has.
// Runs outside the sandbox (a loopback port, Chromium); clips need ffmpeg. Not packaged (package.json --ignore).
//
// A shot: { name, size: '1280x800', panes: 1|2, graph, layout, signedOut, clip, video, hold, setup: [steps], steps: [steps] }
//   clip: [x, y, w, h] in CSS px, { page: '2' } (that pane), or { sel, page, pad } (an element, read when the picture is taken)
//   setup runs first and is never recorded; hold is how long a clip rests on its last frame (ms, default 1400)
// A step (page: '' is the first pane, '2' the second, 'shell' the window itself; default ''):
//   { js: 'code', page }            run in that page's global scope (the renderer's functions: goTo, togglePalette, …); awaited
//   { wait: ms }
//   { key: '⌘K' }                   a combo: ⌘ ⇧ ⌥ ⌃ then one key (A, ↩, ⇥, esc, ⌫, ↑ ↓ ← →, Space, [ ] / . , = -), shown as keycaps in a clip
//   { type: 'words', delay: 45 }     typed one key at a time into whatever has focus
//   { click: 'css', text, page, mods: '⌘', at: [fx, fy] }  the cursor travels there and clicks; text narrows to an element containing it
//   { hover: 'css', text, page }     the cursor travels there
//   { move: [x, y] }                 the cursor travels to a point of the window
//   { caption: 'words' }             a line over the bottom of a clip (empty string hides it)
//   { cdp: 'Method', params }        anything else the protocol does
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), { spawn, execFileSync } = require('child_process');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k), v = process.argv[i + 1]; return i < 0 ? d : v === undefined || v.startsWith('--') ? true : v; };
const root = path.resolve(__dirname, '../..'), media = path.resolve(String(arg('out', path.join(root, 'manual/media'))));
const VALUED = /^--(only|themes|out|now)$/;
const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && VALUED.test(all[i - 1])))
  .map((f) => path.resolve(f)).filter((f) => !/[\\/](run|index|kit)\.js$/.test(f));
if (!files.length || files.some((f) => !fs.existsSync(f))) { console.error('usage: node manual/scenes/run.js manual/scenes/<chapter>.js [more.js …] [--only a,b] [--themes light,dark] [--force] [--adopt]'); process.exit(1); }
const only = arg('only', '') ? String(arg('only')).split(',') : null, themes = String(arg('themes', 'light,dark')).split(',');
// a shot with url is a check of a manual page: drawn only when named with --only, and never into media/
const shots = files.flatMap((f) => require(f)).filter((s) => (only ? only.includes(s.name) : !s.url));
// what was recorded, by output: the hash of the shot's definition (RECIPE: bump when the runner changes how pictures look)
const RECIPE = 1, MANIFEST = path.join(__dirname, 'manifest.json'), tracked = media === path.join(root, 'manual/media');
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
const hashOf = (shot) => require('crypto').createHash('sha1').update(RECIPE + JSON.stringify(shot)).digest('hex').slice(0, 12);
const saveManifest = () => fs.writeFileSync(MANIFEST, JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 1) + '\n');
const outOf = (shot, theme) => path.join(shot.url && tracked ? path.join(os.tmpdir(), 'manual-check') : media, shot.name + '-' + theme + (shot.video ? '.mp4' : '.webp'));
const done = (shot, theme) => tracked && !shot.url && manifest[shot.name + '-' + theme] === hashOf(shot) && fs.existsSync(outOf(shot, theme));
if (arg('adopt', false)) {
  let n = 0; for (const shot of shots) for (const theme of themes) if (tracked && !shot.url && fs.existsSync(outOf(shot, theme))) { manifest[shot.name + '-' + theme] = hashOf(shot); n++; }
  saveManifest(); console.log('adopted ' + n + ' pictures as recorded'); process.exit(0);
}
const todo = arg('force', false) ? shots.length * themes.length : shots.reduce((n, s) => n + themes.filter((t) => !done(s, t)).length, 0);
if (!todo) { console.log('nothing to record: every shot is as it was recorded (--force to record anyway)'); process.exit(0); }
// the pages' clock: a fixed moment that runs on from there, so times, "in 45 minutes" and meeting slots do not drift
const NOW = Date.parse(String(arg('now', '2026-09-30T11:40:00')));
const CLOCK = '(() => { const R = Date, off = ' + NOW + ' - R.now(); class D extends R { constructor(...a) { if (a.length) super(...a); else super(R.now() + off); } static now() { return R.now() + off; } } window.Date = D; })()';
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const chrome = process.env.CHROME || (fs.existsSync(cache) && fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()
  .map((d) => path.join(cache, d, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')).find((f) => fs.existsSync(f)));
if (!chrome) { console.error('No chrome-headless-shell: run npx playwright install chromium-headless-shell, or set CHROME'); process.exit(1); }
const DPR = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.gz': 'application/gzip' };
// main.js pair(): the Work View's two pages, as main hands them to the shell
const pair = (graph) => ({ schema: 1, root: { kind: 'split', id: 'split-work', axis: 'x', weights: graph ? [0.72, 0.28] : [0.6, 0.4], children: ['', '2'].map((id) => ({ kind: 'panel', id: 'panel-work' + id, views: ['page' + id], selected: 'page' + id })) },
  floating: [], hidden: [], views: { page: { type: 'page', params: { side: '' } }, page2: { type: 'page', params: { side: '2', ...(graph ? { links: true } : {}) } } } });

// Drawn over the window in a clip: the pointer, a ripple where it clicks, the keys as caps, a caption line
function overlay() {
  if (document.getElementById('mc-cursor')) return;
  const s = document.createElement('style');
  s.textContent = `#mc-cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;opacity:0;transition:transform .55s cubic-bezier(.3,.7,.2,1),opacity .3s;filter:drop-shadow(0 2px 3px rgba(0,0,0,.3))}
  #mc-cursor.on{opacity:1}#mc-cursor.down svg{transform:scale(.86)}#mc-cursor svg{transition:transform .12s;transform-origin:3px 2px}
  .mc-ripple{position:fixed;z-index:2147483646;pointer-events:none;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid #2f7cf6;animation:mc-rip .6s ease-out forwards}
  @keyframes mc-rip{from{transform:scale(.3);opacity:.9}to{transform:scale(1.4);opacity:0}}
  #mc-hud{position:fixed;left:50%;bottom:34px;z-index:2147483647;display:flex;gap:6px;transform:translate(-50%,12px);opacity:0;transition:opacity .18s,transform .25s cubic-bezier(.3,.7,.2,1);pointer-events:none}
  #mc-hud.on{opacity:1;transform:translate(-50%,0)}
  #mc-hud b{font:600 22px/1 -apple-system,system-ui,sans-serif;color:#fff;background:rgba(24,24,27,.9);border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 24px rgba(0,0,0,.25);border-radius:10px;min-width:44px;height:44px;padding:0 12px;display:flex;align-items:center;justify-content:center;animation:mc-press .3s cubic-bezier(.3,.7,.2,1)}
  @keyframes mc-press{0%{transform:translateY(0)}35%{transform:translateY(3px) scale(.96)}100%{transform:none}}
  #mc-cap{position:fixed;left:50%;bottom:96px;z-index:2147483647;transform:translateX(-50%);font:500 15px/1.3 -apple-system,system-ui,sans-serif;color:#fff;background:rgba(24,24,27,.82);padding:8px 14px;border-radius:999px;opacity:0;transition:opacity .25s;pointer-events:none;white-space:nowrap}
  #mc-cap.on{opacity:1}`;
  document.head.append(s);
  const c = document.createElement('div'); c.id = 'mc-cursor';
  c.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 1.5v19.2l5-4.6 3.3 7.4 3.4-1.5-3.2-7.2h6.9z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const h = document.createElement('div'); h.id = 'mc-hud';
  const cap = document.createElement('div'); cap.id = 'mc-cap';
  document.body.append(c, h, cap);
  let t;
  window.mcMove = (x, y) => { c.classList.add('on'); c.style.transform = 'translate(' + (x - 2) + 'px,' + (y - 2) + 'px)'; };
  window.mcDown = (x, y, on) => { c.classList.toggle('down', on); if (on) { const r = document.createElement('div'); r.className = 'mc-ripple'; r.style.left = x + 'px'; r.style.top = y + 'px'; document.body.append(r); setTimeout(() => r.remove(), 700); } };
  window.mcKeys = (caps) => { h.replaceChildren(...caps.map((k) => { const b = document.createElement('b'); b.textContent = k; return b; })); h.classList.add('on'); clearTimeout(t); t = setTimeout(() => h.classList.remove('on'), 1100); };
  window.mcCaption = (words) => { if (words) cap.textContent = words; cap.classList.toggle('on', !!words); };
}
const OVERLAY = '(' + overlay + ')()';

// keys: [key, code, keyCode, text]
const NAMED = { '↩': ['Enter', 'Enter', 13, '\r'], '⇥': ['Tab', 'Tab', 9], esc: ['Escape', 'Escape', 27], '⌫': ['Backspace', 'Backspace', 8], '⌦': ['Delete', 'Delete', 46],
  '↑': ['ArrowUp', 'ArrowUp', 38], '↓': ['ArrowDown', 'ArrowDown', 40], '←': ['ArrowLeft', 'ArrowLeft', 37], '→': ['ArrowRight', 'ArrowRight', 39], Space: [' ', 'Space', 32, ' '],
  '[': ['[', 'BracketLeft', 219, '['], ']': [']', 'BracketRight', 221, ']'], '/': ['/', 'Slash', 191, '/'], '.': ['.', 'Period', 190, '.'], ',': [',', 'Comma', 188, ','],
  '=': ['=', 'Equal', 187, '='], '-': ['-', 'Minus', 189, '-'], '@': ['@', 'Digit2', 50, '@'], '#': ['#', 'Digit3', 51, '#'], '?': ['?', 'Slash', 191, '?'] };
const MODS = { '⌥': 1, '⌃': 2, '⌘': 4, '⇧': 8 };
function parseKey(combo) {
  let mods = 0, i = 0; const caps = [];
  while (MODS[combo[i]] && combo.length > i + 1) { mods |= MODS[combo[i]]; caps.push(combo[i]); i++; }
  const k = combo.slice(i);
  let def = NAMED[k];
  if (!def && /^[a-z0-9]$/i.test(k)) { const up = k.toUpperCase(), digit = /\d/.test(k); def = [mods & 8 ? up : k.toLowerCase(), digit ? 'Digit' + k : 'Key' + up, up.charCodeAt(0), mods & 8 ? up : k.toLowerCase()]; }
  if (!def) throw new Error('unknown key ' + combo);
  caps.push({ esc: 'esc', Space: 'space' }[k] || (k.length === 1 ? k.toUpperCase() : k));
  return { key: def[0], code: def[1], keyCode: def[2], text: mods & 7 ? undefined : def[3], mods, caps };
}

(async () => {
  fs.mkdirSync(media, { recursive: true });
  fs.mkdirSync(path.join(os.tmpdir(), 'manual-check'), { recursive: true });
  const server = http.createServer((q, s) => { const f = decodeURIComponent(q.url.split('?')[0]); fs.readFile(path.join(root, f), (e, d) => {
    s.writeHead(e ? 404 : 200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); s.end(e ? '' : d);
  }); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = 9300 + Math.floor(Math.random() * 600);
  const ch = spawn(chrome, ['--remote-debugging-port=' + port, '--hide-scrollbars', '--force-color-profile=srgb', '--force-device-scale-factor=' + DPR,
    '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'orbscene-')), 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  try {
    let t; for (let i = 0; i < 50 && !t; i++) { await sleep(200); try { t = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page'); } catch { /* not up yet */ } }
    if (!t) throw new Error('Chromium did not start: ' + chrome);
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
    let id = 0; const waiting = new Map(); let onFrame = null;
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.method === 'Page.screencastFrame') { send('Page.screencastFrameAck', { sessionId: d.params.sessionId }); if (onFrame) onFrame(d.params); return; }
      if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
    };
    const raw = (method, params = {}) => new Promise((r) => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
    const send = async (method, params) => { const d = await raw(method, params); if (d.error) throw new Error(method + ': ' + d.error.message); return d.result || {}; };
    const evalTop = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result && r.result.value;
    };
    const FRAME = (page) => '[...document.querySelectorAll("iframe")].find((f) => new URL(f.src, location.href).searchParams.get("side") === ' + JSON.stringify(page) + ')';
    const inPage = (page, src) => evalTop(page === 'shell' ? '(0, eval)(' + JSON.stringify(src) + ')'
      : '(async () => { const f = ' + FRAME(page) + '; if (!f) throw new Error("no page ' + page + '"); const v = await f.contentWindow.eval(' + JSON.stringify(src) + '); try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return null; } })()');
    // an element's box in the window's coordinates
    const box = (page, sel, text) => evalTop('(() => { const f = ' + (page === 'shell' ? 'null' : FRAME(page)) + ', doc = f ? f.contentDocument : document, o = f ? f.getBoundingClientRect() : { left: 0, top: 0 };'
      + 'const e = [...doc.querySelectorAll(' + JSON.stringify(sel) + ')].find((e) => e.getClientRects().length && (!' + JSON.stringify(text || '') + ' || e.textContent.includes(' + JSON.stringify(text || '') + ')));'
      + 'if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return [o.left + r.left, o.top + r.top, r.width, r.height]; })()');
    let cursor = [-40, -40], video = false;
    const travel = async ([x, y], mods = 0) => {
      const [x0, y0] = cursor; cursor = [x, y];
      if (video) await evalTop('mcMove(' + x + ',' + y + ')');
      for (let i = 1; i <= 8; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x - x0) * i / 8, y: y0 + (y - y0) * i / 8, modifiers: mods }); if (video) await sleep(60); }
      if (video) await sleep(120);
    };
    const target = async (s, key) => {
      const b = await box(s.page ?? '', s[key], s.text);
      if (!b) throw new Error('no element ' + s[key] + (s.text ? ' with "' + s.text + '"' : '') + ' in page "' + (s.page ?? '') + '"');
      const [fx, fy] = s.at || [0.5, 0.5]; return [Math.round(b[0] + b[2] * fx), Math.round(b[1] + b[3] * fy)];
    };
    const step = async (s) => {
      if (s.js != null) return inPage(s.page ?? '', s.js);
      if (s.wait != null) return sleep(s.wait);
      if (s.cdp) return send(s.cdp, s.params || {});
      if (s.caption != null) return video && evalTop('mcCaption(' + JSON.stringify(s.caption) + ')');
      if (s.move) return travel(s.move);
      if (s.hover) return travel(await target(s, 'hover'));
      if (s.click) {
        const mods = s.mods ? parseKey(s.mods + 'A').mods : 0, [x, y] = await target(s, 'click');
        await travel([x, y], mods);
        if (video) await evalTop('mcDown(' + x + ',' + y + ', true)');
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: mods });
        if (video) await sleep(90);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: mods });
        if (video) { await evalTop('mcDown(0,0,false)'); await sleep(350); } else await sleep(120);
        return;
      }
      if (s.key) {
        const k = parseKey(s.key);
        if (video && s.hud !== false) await evalTop('mcKeys(' + JSON.stringify(k.caps) + ')');
        const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.mods };
        await send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        return sleep(video ? 420 : 150);
      }
      if (s.type != null) {
        for (const ch of String(s.type)) {
          const k = NAMED[ch] || [ch, /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : '', ch.toUpperCase().charCodeAt(0), ch];
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k[0], code: k[1], windowsVirtualKeyCode: k[2], text: ch, unmodifiedText: ch });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k[0], code: k[1], windowsVirtualKeyCode: k[2] });
          await sleep(video ? (s.delay ?? 55) : 5);
        }
        return sleep(video ? 250 : 120);
      }
      throw new Error('unknown step ' + JSON.stringify(s));
    };
    const region = async (clip, w, h) => {
      if (!clip) return [0, 0, w, h];
      if (Array.isArray(clip)) return clip;
      if (clip.sel) { const b = await box(clip.page ?? '', clip.sel, clip.text); if (!b) throw new Error('no clip element ' + clip.sel); const p = clip.pad ?? 16;
        return [Math.max(0, b[0] - p), Math.max(0, b[1] - p), Math.min(w, b[2] + 2 * p), Math.min(h, b[3] + 2 * p)]; }
      const b = await evalTop('(() => { const r = ' + FRAME(clip.page) + '.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()');
      return b;
    };
    await send('Page.enable');
    await send('Page.setBypassCSP', { enabled: true }); // the pages' CSP forbids the evals the steps run through
    await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK }); // every frame, before its scripts
    let skipped = 0;
    // a still whose bytes are the same as before is left alone, so git sees only what changed
    const writeStill = (out, data) => { const buf = Buffer.from(data, 'base64'); if (!fs.existsSync(out) || !fs.readFileSync(out).equals(buf)) fs.writeFileSync(out, buf); else console.log('unchanged', path.relative(root, out)); };
    for (const shot of shots) for (const theme of themes) {
      const out = outOf(shot, theme);
      if (!arg('force', false) && done(shot, theme)) { skipped++; continue; }
      try {
        const [w, h] = String(shot.size || '1280x800').split('x').map(Number), panes = shot.graph ? 2 : shot.panes || 1;
        await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: DPR, mobile: false });
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
        if (shot.url) {
          await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' + shot.url + (shot.url.includes('?') ? '&' : '?') + 'theme=' + theme });
          await sleep(1200);
          for (const s of shot.steps || []) await step(s);
          const tall = shot.full ? await evalTop('(async () => { document.documentElement.style.scrollBehavior = "auto"; for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight / 3) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 150)); } scrollTo(0, 0); await new Promise((r) => setTimeout(r, 1000)); return document.documentElement.scrollHeight; })()') : h;
          const { data } = await send('Page.captureScreenshot', { format: 'webp', quality: 80, captureBeyondViewport: !!shot.full, clip: { x: 0, y: 0, width: w, height: Math.min(tall, 16000), scale: shot.full ? 0.5 : 1 } });
          fs.writeFileSync(out, Buffer.from(data, 'base64'));
          console.log(path.relative(root, out), Math.round(fs.statSync(out).size / 1024) + ' KB');
          continue;
        }
        const state = { doc: shot.layout || (panes > 1 ? pair(shot.graph) : null), theme };
        // every shot starts from a fresh window: nothing a page stored in an earlier shot (its place, a fold, a pref)
        await send('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:' + server.address().port, storageTypes: 'local_storage,session_storage,indexeddb' });
        const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: 'if (window === top) window.shell = { state: () => (' + JSON.stringify(state) + '), onCommand() {}, layout() {}, onPins() {}, pins: async () => (' + JSON.stringify(require('./kit').SIDEBAR_PINS) + ') };' });
        await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/shell.html' });
        await sleep(1500);
        await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
        const all = (src) => evalTop('(() => { for (const f of document.querySelectorAll("iframe")) f.contentWindow.eval(' + JSON.stringify(src) + '); })()');
        if (!shot.signedOut) { await all('document.getElementById("login")?.click()'); await sleep(1500); }
        if (theme === 'dark') await all('applyTheme("dark")');
        await evalTop(OVERLAY);
        video = false; cursor = [-40, -40];
        for (const s of shot.setup || []) await step(s);
        await sleep(shot.settle ?? 500);
        if (!shot.video) {
          for (const s of shot.steps || []) await step(s);
          await sleep(shot.settle ?? 500);
          const [x, y, cw, chh] = await region(shot.clip, w, h);
          const { data } = await send('Page.captureScreenshot', { format: 'webp', quality: 90, clip: { x, y, width: cw, height: chh, scale: 1 } });
          writeStill(out, data);
        } else {
          video = true;
          const [x, y, cw, chh] = await region(shot.clip, w, h);
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbclip-')), frames = [];
          onFrame = (f) => { const n = path.join(dir, 'f' + String(frames.length).padStart(5, '0') + '.jpg'); fs.writeFileSync(n, Buffer.from(f.data, 'base64')); frames.push([n, f.metadata.timestamp]); };
          await send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: w * DPR, maxHeight: h * DPR, everyNthFrame: 1 });
          await sleep(400);
          for (const s of shot.steps || []) await step(s);
          await sleep(shot.hold ?? 1400);
          await send('Page.stopScreencast'); onFrame = null;
          if (frames.length < 2) throw new Error('no frames recorded');
          const list = frames.map(([n, ts], i) => "file '" + n + "'\nduration " + Math.max(0.001, ((frames[i + 1] || [])[1] ?? ts + 0.04) - ts).toFixed(4)).join('\n') + "\nfile '" + frames.at(-1)[0] + "'\n";
          fs.writeFileSync(path.join(dir, 'list.txt'), list);
          // the frames' own size decides the crop (screencast frames need not be at the device scale)
          const outW = Math.min(2 * Math.floor(cw * DPR / 2), 1600), fx = (v) => 'trunc(iw*' + (v / w).toFixed(5) + '/2)*2', fy = (v) => 'trunc(ih*' + (v / h).toFixed(5) + '/2)*2';
          execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
            '-vf', 'crop=' + fx(cw) + ':' + fy(chh) + ':' + fx(x) + ':' + fy(y) + ',scale=' + outW + ':-2:flags=lanczos,fps=30',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-preset', 'slow', '-tune', 'animation', '-movflags', '+faststart', '-an', out]);
          if (process.env.SCENE_KEEP) console.log('frames in', dir); else fs.rmSync(dir, { recursive: true, force: true });
        }
        console.log(path.relative(root, out), Math.round(fs.statSync(out).size / 1024) + ' KB');
        if (tracked) { manifest[shot.name + '-' + theme] = hashOf(shot); saveManifest(); }
      } catch (e) { failed++; console.error('FAILED ' + shot.name + '-' + theme + ': ' + (e.message || e)); }
    }
    if (skipped) console.log(skipped + ' already recorded, skipped (--force to record them anyway)');
    ws.close();
  } finally { ch.kill(); server.close(); }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });

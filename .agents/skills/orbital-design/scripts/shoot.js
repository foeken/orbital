#!/usr/bin/env node
'use strict';
// Screenshots of the real window (shell.html with its Trellis panes) running the renderer's mock data, in headless
// Chromium over the DevTools protocol: no dependency, only the chrome-headless-shell Playwright keeps in its cache.
// Run from the checkout (it serves the working directory):
//   node .agents/skills/orbital-design/scripts/shoot.js [--name x] [--size 1440x900] [--panes 1|2] [--themes light,dark]
//        [--signed-out] [--eval 'js run in every page after login'] [--wait ms] [--out dir]
// Writes <out>/<name>-<theme>.png (default /tmp/orbital-shots) and prints the paths.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k), v = process.argv[i + 1]; return i < 0 ? d : v === undefined || v.startsWith('--') ? true : v; };
const root = process.cwd();
if (!fs.existsSync(path.join(root, 'shell.html'))) { console.error('Run from the Orbital checkout'); process.exit(1); }
const [w, h] = String(arg('size', '1440x900')).split('x').map(Number);
const name = arg('name', 'shot'), out = arg('out', '/tmp/orbital-shots'), wait = Number(arg('wait', 800));
const themes = String(arg('themes', 'light,dark')).split(','), panes = Number(arg('panes', 1)), code = arg('eval', '');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const chrome = process.env.CHROME || (fs.existsSync(cache) && fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()
  .map((d) => path.join(cache, d, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')).find((f) => fs.existsSync(f)));
if (!chrome) { console.error('No chrome-headless-shell: run npx playwright install chromium-headless-shell, or set CHROME'); process.exit(1); }
// main.js pair(): the Work View's two pages, as main hands them to the shell
const pair = { schema: 1, root: { kind: 'split', id: 'split-work', axis: 'x', weights: [0.6, 0.4], children: ['', '2'].map((id) => ({ kind: 'panel', id: 'panel-work' + id, views: ['page' + id], selected: 'page' + id })) },
  floating: [], hidden: [], views: { page: { type: 'page', params: { side: '' } }, page2: { type: 'page', params: { side: '2' } } } };
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // the shell's iframes and its module script need http, not file://
  const server = http.createServer((q, s) => { const f = decodeURIComponent(q.url.split('?')[0]); fs.readFile(path.join(root, f), (e, d) => {
    s.writeHead(e ? 404 : 200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); s.end(e ? '' : d);
  }); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = 9300 + Math.floor(Math.random() * 500);
  const ch = spawn(chrome, ['--remote-debugging-port=' + port, '--hide-scrollbars', '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'orbshot-')), 'about:blank'], { stdio: 'ignore' });
  try {
    let t; for (let i = 0; i < 50 && !t; i++) { await sleep(200); try { t = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page'); } catch { /* not up yet */ } }
    if (!t) throw new Error('Chromium did not start: ' + chrome);
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
    let id = 0; const waiting = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d.result || {}); waiting.delete(d.id); } };
    const send = (method, params = {}) => new Promise((r) => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
    // run source in every page (the shell's iframes); a throw fails the run
    const inPages = async (src) => {
      const r = await send('Runtime.evaluate', { expression: '(() => { for (const f of document.querySelectorAll("iframe")) f.contentWindow.eval(' + JSON.stringify(src) + '); })()' });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    };
    await send('Page.enable');
    await send('Page.setBypassCSP', { enabled: true }); // the pages' CSP forbids the eval inPages runs them through
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
    fs.mkdirSync(out, { recursive: true });
    let script = null;
    for (const theme of themes) {
      if (script) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script });
      // what preload gives the shell in the app (window.shell): its layout and theme. The pages run the mock.
      const state = { doc: panes > 1 ? pair : null, theme };
      script = (await send('Page.addScriptToEvaluateOnNewDocument', { source: 'if (window === top) window.shell = { state: () => (' + JSON.stringify(state) + '), onCommand() {}, layout() {} };' })).identifier;
      await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/shell.html' });
      await sleep(1500);
      if (arg('signed-out', false) !== true) { await inPages('document.getElementById("login")?.click()'); await sleep(1500); }
      if (theme === 'dark') await inPages('applyTheme("dark")');
      if (code) await inPages(code);
      await sleep(wait);
      const file = path.join(out, name + '-' + theme + '.png');
      fs.writeFileSync(file, Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
      console.log(file);
    }
    ws.close();
  } finally { ch.kill(); server.close(); }
})().catch((e) => { console.error(e.message || e); process.exit(1); });

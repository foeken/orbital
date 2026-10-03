#!/usr/bin/env node
'use strict';
// The web page's capture for the GPUI comparison (compare.sh): shell.html on the renderer's mock in headless Chrome, as
// the Orbital window shows it, at device scale 1 like the GPUI window's capture. Given a script, it evaluates it in the
// page and prints the answer (how the Timeline's offsets in src/timeline.rs were measured).
//   SIZE=1100x1320 THEME=light|dark SHOT=out.png [EVAL='js run first'] node gpui/compare/web-shot.js [measure.js]
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');
const root = path.join(__dirname, '..', '..'), [w, h] = (process.env.SIZE || '1100x760').split('x').map(Number), theme = process.env.THEME || 'light';
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const server = http.createServer((q, s) => { const f = decodeURIComponent(q.url.split('?')[0]); fs.readFile(path.join(root, f), (e, d) => { s.writeHead(e ? 404 : 200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); s.end(e ? '' : d); }); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = 9300 + Math.floor(Math.random() * 500);
  const ch = spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=' + port, '--hide-scrollbars', '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'orbdump-')), 'about:blank'], { stdio: 'ignore' });
  try {
    let t; for (let i = 0; i < 50 && !t; i++) { await sleep(200); try { t = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page'); } catch {} }
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
    let id = 0; const waiting = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d.result || {}); waiting.delete(d.id); } };
    const send = (method, params = {}) => new Promise((r) => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
    const inPage = async (src) => { const r = await send('Runtime.evaluate', { expression: 'document.querySelector("iframe").contentWindow.eval(' + JSON.stringify(src) + ')', returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
    await send('Page.enable'); await send('Page.setBypassCSP', { enabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: Number(process.env.DSF || 1), mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'if (window === top) window.shell = { state: () => (' + JSON.stringify({ doc: null, theme }) + '), onCommand() {}, layout() {} };' });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/shell.html' });
    await sleep(1500);
    await inPage('document.getElementById("login")?.click()'); await sleep(1500);
    if (theme === 'dark') await inPage('applyTheme("dark")');
    if (process.env.EVAL) await inPage(process.env.EVAL);
    await sleep(1000);
    const src = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : 'null';
    const out = { page: await inPage(src) };
    console.log(JSON.stringify(out, null, 1));
    if (process.env.SHOT) fs.writeFileSync(process.env.SHOT, Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
    ws.close();
  } finally { ch.kill(); server.close(); }
})().catch((e) => { console.error(e.message || e); process.exit(1); });

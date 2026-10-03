'use strict';
// The window's side of an engine: window.api's calls over stdio, one JSON object per line each way (src/engine.rs).
//   in:  { "id": 1, "method": "children", "params": ["…"] }
//   out: { "id": 1, "result": … } or { "id": 1, "error": "…" }, and pushes as { "event": "changed", "args": [docId, info] }
// The engine exits once the window has gone and every call it asked has been answered.
const readline = require('node:readline');

function serve(api, { allow = () => true, refuse = 'not available' } = {}) {
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  api.onChanged((docId, info) => write({ event: 'changed', args: [docId ?? null, info ?? null] }));
  api.onRemoved((docId) => write({ event: 'removed', args: [docId] }));
  let inflight = 0;
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    inflight++;
    try {
      if (typeof api[msg.method] !== 'function') throw new Error('no such call: ' + msg.method);
      if (!allow(msg.method)) throw new Error(refuse);
      const result = await api[msg.method](...(msg.params || []));
      write({ id: msg.id, result: result === undefined ? null : result });
    } catch (e) {
      write({ id: msg.id, error: String((e && e.message) || e) });
    } finally { inflight--; }
  }).on('close', function done() { if (inflight) setTimeout(done, 10); else process.exit(0); });
}

module.exports = { serve };

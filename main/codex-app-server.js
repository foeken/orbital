'use strict';
// Codex's app-server, as Orbital talks to it: the binary (on PATH, where its installers put it, or inside the ChatGPT
// app), one JSON-RPC child per use, and a turn run on one. Shared by the ChatGPT agent (main/agents/codex.js), agent
// chats (main/agentchats.js) and the ChatGPT sign-in (main/ai.js), so none of them requires another for it.
const agent = require('./agent');

const TASK = 'codex://threads/';
const codexBin = () => agent.findBin('codex', ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', '/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex']);

// `codex app-server` speaks JSON-RPC on stdio. Read callers stop this child after one call (withAppServer); a turn holds
// it open while it runs (runTurn); ChatGPT auth while a device login or model turn is active. Bounded by a timeout;
// stderr carries unrelated CLI warnings. `exited` settles when the child is gone, however it went.
// `options.bin` names the binary (main/ai.js: the standalone `codex-app-server`, which takes no subcommand).
// `options.decline`: a request from the server (an approval, a question for the user) is answered no at once, for a
// caller with nobody to ask (main/agentchats.js); without it such a request waits for the Codex app to take the thread.
function appServerRpc(timeoutMs = 20000, onNote, options = {}) {
  const { spawn } = require('node:child_process');
  const bin = options.bin || codexBin();
  if (!bin) throw new Error('ChatGPT is not on this Mac: install the ChatGPT app');
  const args = [...(options.codexHome ? ['-c', 'cli_auth_credentials_store="file"'] : []), ...(bin.endsWith('/codex-app-server') ? [] : ['app-server'])];
  const child = spawn(bin, args, { env: options.codexHome ? isolatedCodexEnv(options.codexHome) : process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '', seq = 0, dead = null, gone;
  const exited = new Promise((resolve) => { gone = resolve; });
  const waiting = new Map();
  const stop = () => { try { child.kill(); } catch {} };
  child.on('error', (e) => { dead = e; for (const [, r] of waiting) r.reject(e); waiting.clear(); gone(); });
  child.on('exit', () => { dead = dead || new Error('app-server exited'); for (const [, r] of waiting) r.reject(dead); waiting.clear(); gone(); });
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      // A notification carries a method and no id. It is the only way a caller hears that a turn has ended, which is
      // what decides when this child may let the thread go.
      if (m.method !== undefined && m.id === undefined) { if (onNote) { try { onNote(m); } catch {} } continue; }
      if (m.method !== undefined) { if (options.decline) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Orbital cannot answer this: continue the chat in the ChatGPT app' } }) + '\n'); continue; } // a request of the server's: its id is not one of ours
      const r = waiting.get(m.id);
      if (!r) continue;
      waiting.delete(m.id);
      if (m.error) r.reject(new Error(m.error.message || 'app-server error')); else r.resolve(m.result);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error('app-server timed out')); }, timeoutMs).unref?.();
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  // clientInfo names Orbital to OpenAI: Codex sends its name as the request originator and its name and version in the
  // User-Agent, and enterprise compliance logs show it. It authenticates nothing (docs/CHATGPT-SIGN-IN.md).
  return { call, stop, exited, ready: call('initialize', { clientInfo: { name: 'orbital', title: 'Orbital', version: require('../package.json').version } }) };
}
function isolatedCodexEnv(home) {
  const env = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.CODEX_ACCESS_TOKEN;
  return env;
}
// One read: a child for fn(call), stopped after, whatever fn did
async function withAppServer(fn, timeoutMs = 20000) {
  const rpc = appServerRpc(timeoutMs);
  try { await rpc.ready; return await fn(rpc.call); } finally { rpc.stop(); }
}

// ---- a turn ----
// The child that starts or resumes a thread is its writer for as long as it lives, and Codex will not open a thread
// another writer holds ("This is open in another app"). So it lets go the moment the turn is over: thread/unsubscribe
// first, then the child. Over is turn/completed, the child gone (a crash), end() asked for (stop, quit, unassign), or
// nothing heard from the thread for quietMs: the clock starts again with every notification, so long work is never cut
// off while it is still talking. Nothing here deletes or archives a thread: the work stays the user's.
// threadId resumes that thread (with params), none starts one (params are thread/start's). onThread(id, run) hears the
// thread's id before the turn starts, so a caller can hold it (and let it go: run.end) from then; onNote hears this
// thread's notifications. Answers { id, turnId, rpc, end, ended } once turn/start has.
const QUIET_MS = 15 * 60 * 1000;
async function runTurn({ threadId = null, params = {}, text, onThread, onNote, decline = false, timeoutMs = 30000, quietMs = QUIET_MS }) {
  let id = threadId, done = false, quiet = null, ended;
  const over = new Promise((resolve) => { ended = resolve; });
  const end = async () => {
    if (done) return; done = true;
    clearTimeout(quiet);
    try { if (id) await rpc.call('thread/unsubscribe', { threadId: id }); } catch {} // already gone is already released
    rpc.stop(); ended();
  };
  const hush = () => { if (done) return; clearTimeout(quiet); quiet = setTimeout(end, quietMs); quiet.unref?.(); };
  const rpc = appServerRpc(timeoutMs, (note) => {
    hush(); // this child serves this one turn: anything it hears is the work going on, a sub-agent's thread included
    const p = note.params || {};
    if (!id || p.threadId !== id) return; // another thread's ending says nothing about this one
    if (onNote) onNote(note);
    if (note.method === 'turn/completed') end();
  }, { decline });
  rpc.exited.then(end);
  const run = { rpc, end, ended: over };
  try {
    await rpc.ready;
    if (id) await rpc.call('thread/resume', { threadId: id, ...params });
    else id = (await rpc.call('thread/start', params) || {}).thread?.id;
    if (!id) throw new Error('ChatGPT did not return a task id');
    if (onThread) onThread(id, run);
    const started = await rpc.call('turn/start', { threadId: id, input: [{ type: 'text', text }] });
    hush();
    return { id, turnId: (started && started.turn && started.turn.id) || null, ...run };
  } catch (e) { await end(); throw e; } // no id, or no turn: nothing to link, never a green for work that does not exist
}

module.exports = { TASK, codexBin, appServerRpc, isolatedCodexEnv, withAppServer, runTurn, QUIET_MS };

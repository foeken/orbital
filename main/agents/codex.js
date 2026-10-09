'use strict';
// The Codex agent (main/agent.js): a node handed to a Codex task on this Mac, through Codex's own app-server. Found on
// PATH, where its installers put it, or inside the ChatGPT (Codex) app. main/ai.js signs in with ChatGPT over the same
// app-server, so appServerRpc and codexBin are exported for it.
const agent = require('../agent');

const NEW_TASK = 'https://chatgpt.com/codex/open-app?q='; // the public route for a new composer; codex://threads/new is internal and does nothing from outside
const TASK = 'codex://threads/';
const codexBin = () => agent.findBin('codex', ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', '/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex']);

// `codex app-server` speaks JSON-RPC on stdio. Read callers stop this child after one call; ChatGPT auth holds it
// open while a device login or model turn is active. Bounded by a timeout; stderr carries unrelated CLI warnings.
// `options.bin` names the binary (main/ai.js: the standalone `codex-app-server`, which takes no subcommand).
// `options.decline`: a request from the server (an approval, a question for the user) is answered no at once, for a
// caller with nobody to ask (main/agentchats.js); without it such a request waits for the Codex app to take the thread.
function appServerRpc(timeoutMs = 20000, onNote, options = {}) {
  const { spawn } = require('node:child_process');
  const bin = options.bin || codexBin();
  if (!bin) throw new Error('Codex is not installed on this Mac: install the ChatGPT app or the Codex CLI');
  const args = [...(options.codexHome ? ['-c', 'cli_auth_credentials_store="file"'] : []), ...(bin.endsWith('/codex-app-server') ? [] : ['app-server'])];
  const child = spawn(bin, args, { env: options.codexHome ? isolatedCodexEnv(options.codexHome) : process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '', seq = 0, dead = null;
  const waiting = new Map();
  const stop = () => { try { child.kill(); } catch {} };
  child.on('error', (e) => { dead = e; for (const [, r] of waiting) r.reject(e); waiting.clear(); });
  child.on('exit', () => { dead = dead || new Error('app-server exited'); for (const [, r] of waiting) r.reject(dead); waiting.clear(); });
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
      if (m.method !== undefined) { if (options.decline) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Orbital cannot answer this: continue the chat in Codex' } }) + '\n'); continue; } // a request of the server's: its id is not one of ours
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
  return { call, stop, ready: call('initialize', { clientInfo: { name: 'orbital', title: 'Orbital', version: require('../../package.json').version } }) };
}
function isolatedCodexEnv(home) {
  const env = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.CODEX_ACCESS_TOKEN;
  return env;
}

// ---- what a task is doing ----
// The badge is the task's own status, never elapsed time or a local guess. ThreadStatus is notLoaded | idle |
// systemError | active{activeFlags}; idle cannot tell "finished" from "never ran", so for a quiet thread the last
// turn decides (thread/turns/list defaults to descending, so one turn is the latest one).
// The turns are the authority, not the thread's loaded flag: `notLoaded` only means "this reader has not loaded the
// thread", and asking the thread itself fails with "already has an active writer" whenever the desktop app has it open.
const QUIET = ['idle', 'notLoaded'];
function agentState(thread, lastTurn) {
  if (!thread) return 'broken'; // linked to a task the app cannot account for: stale, and recoverable by retrying
  const type = thread.status && thread.status.type;
  if (type === 'systemError') return 'broken';
  if (type === 'active') return (thread.status.activeFlags || []).length ? 'waiting' : 'working';
  if (!lastTurn) return 'pending'; // a task that exists but has not run: completion is only read off a turn that completed
  if (lastTurn === 'inProgress') return 'working';
  if (lastTurn === 'completed') return 'done';
  // `interrupted` is the ordinary shape here, not a failure: the app's own child starts the bootstrap turn, and when
  // Codex takes the thread over as its writer that turn is recorded interrupted while the work carries on in the app.
  if (lastTurn === 'interrupted') return 'working';
  return 'broken';
}
// One read for every linked node: a single thread/list, then the latest turn only for the threads that are quiet.
// `rpc` is the caller's connection, so this stays testable without spawning anything. A read that fails as a whole
// is red for every linked node rather than a silent green.
async function agentStatuses(links, rpc) {
  const entries = Object.entries(links || {});
  if (!entries.length) return {};
  const out = {};
  let byId;
  try {
    const list = await rpc('thread/list', { limit: 100 }); // the newest hundred (`limit`; the `pageSize` asked before was no parameter)
    byId = new Map((list && list.data || []).map((t) => [t.id, t]));
  } catch {
    for (const [nodeId] of entries) out[nodeId] = 'broken';
    return out;
  }
  // a linked task older than those is read on its own, rather than taken for gone (#671 review); one that cannot be
  // read stays missing, which is the stale link it was before
  for (const [, threadId] of entries) {
    if (byId.has(threadId)) continue;
    const read = await rpc('thread/read', { threadId }).catch(() => null);
    if (read && read.thread) byId.set(threadId, read.thread);
  }
  for (const [nodeId, threadId] of entries) {
    const thread = byId.get(threadId) || null;
    let last = null;
    if (thread && QUIET.includes(thread.status && thread.status.type)) {
      try {
        const turns = await rpc('thread/turns/list', { threadId, limit: 1 });
        last = (turns && turns.data && turns.data[0] && turns.data[0].status) || null;
      } catch { last = null; } // the thread is there but its turns are not readable: pending, not a failure claim
    }
    out[nodeId] = agentState(thread, last);
  }
  return out;
}
async function statuses(links) {
  if (!Object.keys(links || {}).length) return {};
  let rpc = null;
  try { rpc = appServerRpc(20000); await rpc.ready; return await agentStatuses(links, rpc.call); }
  catch { return Object.fromEntries(Object.keys(links).map((id) => [id, 'broken'])); }
  finally { if (rpc) rpc.stop(); }
}

// ---- creating a task ----
// A thread from thread/start is invisible to the app until a turn writes its rollout, so the turn starts here too:
// then it lists, the app reads it, and codex://threads/<id> opens it with no browser hop.
// The child that starts a turn is that thread's writer for as long as it lives, and Codex will not open a thread
// another writer holds ("This is open in another app"). One entry per key while its child owns the thread, so
// finishing, quitting, a failed launch and unassigning all let go through the same release. Nothing here deletes or
// archives the Codex task: the work stays, only the writer is handed back.
const owned = new Map();
const release = (key) => { const e = owned.get(key); return e ? e.release() : Promise.resolve(); };
const stop = () => { for (const e of [...owned.values()]) e.stop(); owned.clear(); }; // on the way out: no time for a round trip
// instructions: developer instructions for the whole thread, for a task that has rules beyond its first message
// (main/chatagents.js). readOnly: Codex's own read-only sandbox with nothing to approve, for a task that only answers
// (a chat question): what it may do is held by Codex, not only asked of it in words. The model is Codex's own default.
async function createTask({ key, prompt, instructions, readOnly = false, userData, timeoutMs = 30000, runMs = 15 * 60 * 1000 }) {
  let id = null, cap = null, gone = false;
  // Let go the moment the turn ends, not on a timer: the thread is handed back through the protocol first
  // (thread/unsubscribe) and the child closed after.
  const letGo = async () => {
    if (gone) return; gone = true;
    if (cap) clearTimeout(cap);
    if (owned.get(key) === entry) owned.delete(key); // a later assignment owns its own child, never this one
    try { if (id) await rpc.call('thread/unsubscribe', { threadId: id }); } catch {} // already gone is already released
    rpc.stop();
  };
  const rpc = appServerRpc(timeoutMs, (note) => {
    if (note.method === 'turn/completed' && note.params && note.params.threadId === id) letGo();
  });
  const entry = { release: letGo, stop: rpc.stop };
  try {
    await rpc.ready;
    const params = { cwd: agent.agentWorkspace(userData), ephemeral: false };
    if (instructions) params.developerInstructions = instructions;
    if (readOnly) Object.assign(params, { sandbox: 'read-only', approvalPolicy: 'never' });
    const started = await rpc.call('thread/start', params);
    id = started && started.thread && started.thread.id;
    if (!id) throw new Error('Codex did not return a task id');
    owned.set(key, entry); // from here something owns the thread, so something must be able to give it back
    await rpc.call('turn/start', { threadId: id, input: [{ type: 'text', text: prompt }] });
  } catch (e) {
    await letGo();
    throw e; // no id, so nothing is linked: never a green for a task that does not exist
  }
  // Only a backstop, for a turn whose ending is never heard.
  if (!gone) { cap = setTimeout(letGo, runMs); cap.unref?.(); }
  return id;
}
const openUrl = (url) => { const { shell } = require('electron'); if (!shell || !shell.openExternal) throw new Error('Cannot open Codex from here'); return shell.openExternal(url); };
// A Codex turn's answer: its final answer, or, once it has completed, what it said last when the model does not mark
// one (while it runs, an unmarked message is progress, not the answer)
function codexAnswer(turn) {
  const said = ((turn && turn.items) || []).filter((i) => i && i.type === 'agentMessage' && i.text);
  const final = said.filter((i) => i.phase === 'final_answer').at(-1) || (turn && turn.status === 'completed' ? said.at(-1) : null);
  return (final && final.text) || '';
}

const codex = agent.register({
  id: 'codex', label: 'Codex', icon: 'robot', missing: 'Install the ChatGPT app or the Codex CLI',
  available: () => !!codexBin(),
  // Assign to Agent opens the new task in Codex, where the work is watched; a chat question stays on its page.
  async start({ key, nodeUri, title, rules, prompt, readOnly, userData }) {
    const id = await createTask({ key, prompt: nodeUri ? agent.agentPrompt(nodeUri, title, prompt) : prompt, instructions: rules, readOnly, userData });
    if (nodeUri) await openUrl(TASK + encodeURIComponent(id));
    return id;
  },
  // A reassignment reopens the task and queues the new request to it. The queue is best effort: the task is open in
  // front of the user either way, and a queue that does not land must not undo an assignment that did.
  async resume(taskId, prompt) {
    await openUrl(TASK + encodeURIComponent(taskId));
    const bin = codexBin();
    try { if (bin && prompt) require('node:child_process').execFile(bin, ['queue', '--thread', taskId, '--message', prompt], { timeout: 20000 }, () => {}); } catch {}
  },
  statuses,
  open: (taskId) => openUrl(TASK + encodeURIComponent(taskId)),
  // Codex's Copy link gives codex://threads/<id>; a bare id works too.
  linkId: (text) => { const m = String(text || '').trim().match(/^(?:codex:\/\/threads\/)?([0-9a-f-]{36})\/?$/i); return m && agent.UUID.test(m[1]) ? m[1] : null; },
  openNew: (link) => openUrl(NEW_TASK + encodeURIComponent(link + '\n')),
  // One app-server child reads the latest turn of each task (itemsView full). Read from a second app-server, a turn
  // still running on the one that started it shows as interrupted, so only an answer or a completed or failed turn
  // ends the wait here.
  async read(taskIds) {
    const out = new Map(), rpc = appServerRpc(20000);
    try {
      await rpc.ready;
      for (const id of taskIds) {
        const turns = await rpc.call('thread/turns/list', { threadId: id, limit: 1, itemsView: 'full' }).catch(() => null);
        const turn = turns && turns.data && turns.data[0], text = codexAnswer(turn);
        out.set(id, { state: text ? 'done' : turn && ['completed', 'failed'].includes(turn.status) ? 'failed' : 'working', text });
      }
    } finally { rpc.stop(); }
    return out;
  },
  release, stop,
});

module.exports = { codex, codexBin, appServerRpc, agentState, agentStatuses, createTask, codexAnswer, release, stop, NEW_TASK, TASK };

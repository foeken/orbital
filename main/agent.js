'use strict';
// Handing a Tana node to a Codex task, and keeping the link between the two.
//
// The link is written from the inside: the deep link cannot tell us which task the app created, but every Codex agent
// shell carries CODEX_THREAD_ID, so the task registers itself through scripts/agent-link.js as its first action.
// That is why the prompt below leads with the callback: until it runs there is no task id, and a node with no id is
// pending rather than delegated.
//
// The supported deep link takes prompt, mode and browserUrl only — there is no workspace or project parameter (read
// out of the app's own https -> codex:// translation), so the task starts wherever the app puts it and the callback
// writes outside that directory. That costs one visible approval on the first run, which is honest: the badge stays
// pending until the write lands.
const settings = require('./settings');

// Opening a *new* task from outside goes through the https form, not codex://threads/new. That codex: route is
// internal: the app produces it itself when it translates this link (hostname chatgpt.com, path /codex/open-app,
// the prompt in `q`), and handing the translated form straight to the OS did nothing at all — the badge went
// pending and Codex never moved, which is how this was found. Opening an existing task by id is unaffected.
const NEW_TASK = 'https://chatgpt.com/codex/open-app?q=';
const TASK = 'codex://threads/';
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// nodeId -> { host, threadId }. Written by the task itself (scripts/agent-link.js) and read here; unassigning leaves
// it alone, so reassigning a node reopens the task it already has. It follows you between machines like the rest of
// the assignment: a thread id is global, and the record names the machine its rollout lives on, which is what lets
// another machine show the badge and say where the work is instead of showing nothing at all.
const codexTasks = () => { const stored = settings.get('codexTask'); return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}; };
const codexTaskFor = (id) => { const link = taskLink(id); return link ? link.threadId : null; };
function setCodexTask(id, threadId, host) {
  const map = codexTasks();
  // host and id together: a thread id is unique, but its rollout only exists on the machine that created it, so a
  // status read sent to the wrong one would look like a task that vanished.
  if (threadId && THREAD_ID.test(String(threadId))) map[id] = { host: hostId(host) || 'local', threadId }; else delete map[id];
  settings.set('codexTask', map);
  return codexTaskFor(id);
}
// A link that no longer answers is not deleted quietly: the badge goes red and the retry replaces the mapping only
// once a new task has registered itself.
const clearCodexTask = (id) => setCodexTask(id, null);
// ---- where a task can run ----
// This machine is the only one built in. Every other is a record the user added, kept in the app's own settings:
// an opaque id, a name, the SSH address and the absolute path to Codex there. No credential is stored — the
// connection is the user's own SSH — and the renderer only ever sees ids and names.
// The path is absolute because a non-interactive SSH login has no PATH, so `ssh host codex` hangs on
// "command not found". Address and path are passed to ssh as separate arguments and never joined into a shell line.
const LOCAL = { id: 'local', title: 'This Mac' };
const HOST_ID = /^[a-z0-9-]{1,40}$/; // opaque, ours: nothing the renderer sends can become an address
// The machines a task can run on: an address and a path on *that* machine, so the list means the same thing
// wherever the app is opened — one of the settings that follows you (main/settings.js).
const remoteHosts = () => { const stored = settings.get('codexHosts'); return Array.isArray(stored) ? stored.filter(validHost) : []; };
const validHost = (h) => !!h && HOST_ID.test(String(h.id)) && h.id !== 'local' && String(h.title || '').trim()
  && /^[A-Za-z0-9._-]{1,253}$/.test(String(h.ssh || '')) // a hostname, never a command or an option
  && /^\/[^\s;|&$`'"<>]{1,255}$/.test(String(h.bin || '')); // one absolute path, nothing a shell could read as more
const hosts = () => [LOCAL, ...remoteHosts().map((h) => ({ id: h.id, title: h.title }))]; // names only: what the choosers see
// The record behind an id, or null when nobody knows it — a host that was removed stays unknown, so tasks on it read
// as unavailable rather than quietly becoming local.
const hostRecord = (id) => (!id || id === 'local' ? LOCAL : remoteHosts().find((h) => h.id === id) || null);
function addHost({ title, ssh, bin }) {
  const record = { id: 'h' + Date.now().toString(36), title: String(title || '').trim(), ssh: String(ssh || '').trim(), bin: String(bin || '').trim() };
  if (!validHost(record)) throw new Error('A host needs a name, an SSH address and the absolute path to codex on it');
  settings.set('codexHosts', [...remoteHosts(), record]);
  return { id: record.id, title: record.title };
}
function removeHost(id) {
  // The tasks on it are left alone: they are the user's, and their links stay pointing at a host nobody knows, which
  // is what makes them read as unavailable instead of being run against the wrong machine.
  settings.set('codexHosts', remoteHosts().filter((h) => h.id !== id));
  return hosts();
}
const hostId = (host) => (hostRecord(host) ? host || 'local' : null); // unknown is unknown, never this machine
// A mapping written before hosts existed is a thread on this machine: that is where it was created, so that is where
// its rollout is and where its status has to be read.
function taskLink(id) {
  const stored = codexTasks()[id];
  if (typeof stored === 'string') return THREAD_ID.test(stored) ? { host: 'local', threadId: stored } : null;
  // The host is kept exactly as stored, even when nobody knows it any more: a removed host must read as unavailable,
  // never be mistaken for this machine.
  if (stored && THREAD_ID.test(String(stored.threadId))) return { host: stored.host || 'local', threadId: stored.threadId };
  return null;
}

// The node's title, made fit for one line. It is text from the graph and is treated as data: newlines, control
// characters and runaway length are taken out rather than trusted to be absent. The cut counts code points, never
// UTF-16 units, so it can never leave half a character behind.
const TITLE_CAP = 80; // long enough to tell two nodes apart at a glance, short enough to stay one readable line
function oneLine(text, cap = TITLE_CAP) {
  const flat = (typeof text === 'string' ? text : '').replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > cap ? chars.slice(0, cap).join('').trimEnd() + '…' : flat;
}
// What the new task is told. The node is the task: the prompt carries its uri and says where the work request lives,
// rather than copying the node's content in and going stale. Nothing else about the graph travels with it.
function agentPrompt(nodeUri, repo, title) {
  const name = oneLine(title);
  return [
    // The first line is the node's own name, because Codex names a task after how its first message opens: every
    // task used to be called after the sentence below and they were indistinguishable in the list. The uri and the
    // instruction to read the node live still follow, so the node remains the source of truth.
    name ? 'Tana: ' + name : 'Tana task',
    '',
    'You are handling a Tana node. The node is the task; this message is only the pointer to it.',
    '',
    'First, register yourself so the app knows which task is handling this node:',
    '',
    '    cd ' + repo,
    '    node scripts/agent-link.js --node ' + nodeUri + ' --thread "$CODEX_THREAD_ID"',
    '',
    'That writes to the app\'s own database outside this directory, so it may ask for approval once. It is safe and',
    'idempotent, and until it succeeds the node shows as pending rather than delegated.',
    '',
    'Then fetch the node itself through your Tana connection, using whichever Tana tool you have for reading a node',
    'by its uri. Read it live: this message is a pointer, not a copy, and anything quoted here may already be stale.',
    '',
    '    node uri: ' + nodeUri,
    '',
    'Its "Agent context" block holds the instructions you are being asked to carry out. Treat that block as the work',
    'request and the rest of the node as the context for it. If the node has no "Agent context" block, say so and stop.',
    'If you have no Tana connection, or it cannot resolve that uri, say so and stop — do not work from this message',
    'alone, and do not guess at the node\'s contents.',
  ].join('\n');
}
// Which url opens the work, and what has to be said to it. A node that already has a task reopens that task and is
// told what changed; a node without one opens a new composer carrying the prompt. The caller opens the url and, for
// an existing task, delivers `queue` through the Codex CLI.
function handoff(nodeUri, context, repo, title) {
  const known = codexTaskFor(nodeUri);
  if (known) return { kind: 'reuse', threadId: known, url: TASK + encodeURIComponent(known), queue: context || null };
  return { kind: 'create', threadId: null, url: NEW_TASK + encodeURIComponent(agentPrompt(nodeUri, repo, title)), queue: null };
}
// ---- what the linked task is doing ----
// The badge is the task's own status, never elapsed time or a local guess. ThreadStatus is notLoaded | idle |
// systemError | active{activeFlags}; idle cannot tell "finished" from "never ran", so for a quiet thread the last
// turn decides (thread/turns/list defaults to descending, so one turn is the latest one).
//   pending  no id yet, or a task that has never run  -> gray, static
//   working  active with no flags, or a turn running  -> blue, the only state that animates
//   waiting  active and waiting on approval or input  -> blue, static
//   done     the last turn completed                  -> green, static
//   broken   system error, failed or interrupted turn, an id the app no longer knows, or no answer at all -> red
// `unavailable` is the machine, not the task: a Donut that is asleep or off the network says nothing about the work
// it holds, so it is neither red nor animated.
const QUIET = ['idle', 'notLoaded'];
// The turns are the authority, not the thread's loaded flag. `notLoaded` only means "this reader has not loaded the
// thread" — every thread reads that way from a short-lived child — so it can neither prove nor disprove anything.
// Asking the thread itself was tried and cannot work: `thread/resume` answers "already has an active writer"
// whenever the desktop app has the thread open, which is exactly when the user is looking at it, and a finished task
// then stayed blue for ever. What a turn records is true in both directions: one still running says so, and one that
// completed is the work having stopped.
function agentState(thread, lastTurn) {
  if (!thread) return 'broken'; // linked to a task the app cannot account for: stale, and recoverable by retrying
  const type = thread.status && thread.status.type;
  if (type === 'systemError') return 'broken';
  if (type === 'active') return (thread.status.activeFlags || []).length ? 'waiting' : 'working';
  // No turn at all is the registration case: a task that exists but has not run. That is pending, never finished —
  // completion is only ever read off a turn that actually completed.
  if (!lastTurn) return 'pending';
  if (lastTurn === 'inProgress') return 'working';
  if (lastTurn === 'completed') return 'done';
  // `failed` is the only terminal one, and the schema says so: a Turn carries an `error` only when it failed.
  // `interrupted` is a run that was cut, not a task that broke — and in this flow it is the ordinary shape. The
  // bootstrap turn is started by the launcher's own app-server child, and when Codex takes the thread over as its
  // writer that turn is recorded interrupted while the work carries on in the app. Reading that as red put a task
  // that was visibly working behind a failure badge.
  if (lastTurn === 'interrupted') return 'working';
  return 'broken';
}
// One read for every linked node: a single thread/list, then the latest turn only for the threads that are quiet.
// `rpc` is the caller's connection, so this stays testable without spawning anything. Any failure of the read as a
// whole is red for every linked node rather than a silent green.
async function agentStatuses(links, rpc) {
  const entries = Object.entries(links || {});
  if (!entries.length) return {};
  const out = {};
  let byId;
  try {
    const list = await rpc('thread/list', { pageSize: 100 });
    byId = new Map((list && list.data || []).map((t) => [t.id, t]));
  } catch {
    for (const [nodeId] of entries) out[nodeId] = 'broken';
    return out;
  }
  for (const [nodeId, threadId] of entries) {
    const thread = byId.get(threadId) || null;
    let last = null;
    if (thread && QUIET.includes(thread.status && thread.status.type)) {
      try {
        const turns = await rpc('thread/turns/list', { threadId, limit: 1 }); // descending by default: the latest turn
        last = (turns && turns.data && turns.data[0] && turns.data[0].status) || null;
      } catch { last = null; } // the thread is there but its turns are not readable: pending, not a failure claim
    }
    out[nodeId] = agentState(thread, last);
  }
  return out;
}
// This Mac's `codex`: on PATH, then where its installers put it, then the copy the ChatGPT (Codex) app carries. An
// app opened from the Finder gets launchd's PATH (/usr/bin:/bin:…), which has none of them. Null: no Codex here.
function codexBin() {
  const fs = require('node:fs'), path = require('node:path'), home = require('node:os').homedir();
  const dirs = [...(process.env.PATH || '').split(':').filter(Boolean), home + '/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'];
  const apps = ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', '/Applications/Codex.app/Contents/Resources/codex'];
  return [...dirs.map((d) => path.join(d, 'codex')), ...apps].find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}
// `codex app-server` speaks JSON-RPC on stdio. Read callers stop this child after one call; ChatGPT auth holds it
// open while a device login or model turn is active. Bounded by a timeout; stderr carries unrelated CLI warnings.
// `options.bin` names the binary (main/ai.js: the standalone `codex-app-server`, which takes no subcommand).
function appServerRpc(timeoutMs = 20000, host, onNote, options = {}) {
  const { spawn } = require('node:child_process');
  const where = hostRecord(host);
  if (!where) throw new Error('That machine is not configured any more'); // a removed host runs nothing
  const bin = where.ssh ? where.bin : options.bin || codexBin();
  if (!bin) throw new Error('Codex is not installed on this Mac: install the ChatGPT app or the Codex CLI');
  const args = [...(options.codexHome ? ['-c', 'cli_auth_credentials_store="file"'] : []), ...(bin.endsWith('/codex-app-server') ? [] : ['app-server'])];
  // Remote: the same app-server, reached over the user's own SSH. No port to open, no token to keep, and the binary
  // is named absolutely because a non-interactive login has no PATH.
  const child = where.ssh
    ? spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', where.ssh, bin, 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    : spawn(bin, args, {
      env: options.codexHome ? isolatedCodexEnv(options.codexHome) : process.env, stdio: ['pipe', 'pipe', 'ignore'],
    });
  // Whose Codex is speaking. Both machines have the same home directory, so a remote error that quotes a path or a
  // config line reads as a local one unless the host says its own name first.
  const from = where.ssh ? (where.title || host) + ': ' : '';
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
      const r = waiting.get(m.id);
      if (!r) continue;
      waiting.delete(m.id);
      if (m.error) r.reject(new Error(from + (m.error.message || 'app-server error'))); else r.resolve(m.result);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error('app-server timed out')); }, timeoutMs).unref?.();
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { call, stop, ready: call('initialize', { clientInfo: { name: 'orbital', title: 'Orbital', version: '1' } }) };
}
function isolatedCodexEnv(home) {
  const env = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.CODEX_ACCESS_TOKEN;
  return env;
}
// The refresh asks this once for every linked node; it is one process, opened and closed around the read.
// One child per machine that holds any of these tasks, not one per task. A machine that cannot be reached leaves its
// own nodes unavailable and says nothing about anyone else's.
async function readAgentStatuses(links) {
  const byHost = new Map();
  for (const [nodeId] of Object.entries(links || {})) {
    const link = taskLink(nodeId);
    if (!link) continue;
    if (!byHost.has(link.host)) byHost.set(link.host, {});
    byHost.get(link.host)[nodeId] = link.threadId;
  }
  const out = {};
  for (const [host, hostLinks] of byHost) {
    let rpc = null;
    try {
      rpc = appServerRpc(20000, host); // a host nobody knows refuses here, and that refusal is this host's alone
      await rpc.ready;
      Object.assign(out, await agentStatuses(hostLinks, rpc.call));
    } catch {
      for (const nodeId of Object.keys(hostLinks)) out[nodeId] = 'unavailable'; // the machine is away, not the task broken
    } finally { if (rpc) rpc.stop(); }
  }
  return out;
}
// ---- creating the task ----
// Verified on 0.154.0: a thread from `thread/start` is invisible to the app until a turn writes its rollout — that is
// the "no rollout found" the earlier attempt hit. Start the turn and it becomes a first-class thread: it lists, the
// app reads it, and `codex://threads/<id>` opens it with no browser hop. That is why creation happens here rather
// than through the public https route, and it is what makes the workspace and the model ours to choose.
// A blank workspace per node, not the last project and not this repo: its own directory under the app's data, made
// on demand. The node's own id keeps it stable across reassignment.
function agentWorkspace(userData, nodeUri) {
  const path = require('node:path'), fs = require('node:fs');
  const dir = path.join(userData, 'agent-workspaces', String(nodeUri).replace(/[^a-z0-9]+/gi, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// The child that starts a turn is that thread's writer for as long as it lives, and Codex will not open a thread
// another writer holds — "This is open in another app". One entry per node while its child owns the thread, so
// finishing, quitting, a failed launch and unassigning all let go through the same release rather than each
// deciding for itself. Nothing here deletes or archives the Codex task: the work stays, only the writer is handed back.
const owned = new Map();
const releaseTask = (nodeUri) => { const e = owned.get(nodeUri); return e ? e.release() : Promise.resolve(); };
// On the way out there is no time to wait for a protocol round trip, so the children are simply closed. Every one of
// them is a child this app spawned and still holds: no search, no matching, nothing else is touched.
const stopOwnedTasks = () => { for (const e of [...owned.values()]) e.stop(); owned.clear(); };
// Creates the task, starts its first turn and answers with the id. The turn runs in this child, which is kept alive
// while the work runs so it is not cut off half way; the user watches it in Codex meanwhile, because both read the
// same store.
// instructions: developer instructions for the whole thread (thread/start developerInstructions), for a task that has
// rules to keep beyond its first message (main/chatagents.js).
async function createTask({ nodeUri, prompt, model, instructions, userData, host, timeoutMs = 30000, runMs = 15 * 60 * 1000 }) {
  let id = null, cap = null, gone = false;
  // Let go the moment the turn ends, not on a timer: the fixed cap left a finished task locked behind this writer
  // for a quarter of an hour, which is the "open in another app" card the user was shown. The thread is handed back
  // through the protocol first (thread/unsubscribe) and the child closed after, so nothing is left to signals.
  const release = async () => {
    if (gone) return; gone = true;
    if (cap) clearTimeout(cap);
    if (owned.get(nodeUri) === entry) owned.delete(nodeUri); // a later assignment owns its own child, never this one
    try { if (id) await rpc.call('thread/unsubscribe', { threadId: id }); } catch {} // already gone is already released
    rpc.stop();
  };
  // One connection, one thread: a turn that ends is this task's turn ending, whichever way it ended — completed,
  // failed or interrupted all arrive as turn/completed, and all of them mean the work here has stopped.
  const rpc = appServerRpc(timeoutMs, host, (note) => {
    if (note.method === 'turn/completed' && note.params && note.params.threadId === id) release();
  });
  const entry = { release, stop: rpc.stop };
  try {
    await rpc.ready;
    const params = { cwd: agentWorkspace(userData, nodeUri), ephemeral: false };
    if (model) params.model = model; // absent means Codex's own default
    if (instructions) params.developerInstructions = instructions;
    const started = await rpc.call('thread/start', params);
    id = started && started.thread && started.thread.id;
    if (!id) throw new Error('Codex did not return a task id');
    owned.set(nodeUri, entry); // from here something owns the thread, so something must be able to give it back
    // The turn is what writes the rollout, so this is also what makes the task openable at all.
    await rpc.call('turn/start', { threadId: id, input: [{ type: 'text', text: prompt }] });
  } catch (e) {
    await release();
    throw e; // no id, so nothing is linked and the badge stays pending: never a green for a task that does not exist
  }
  // Only a backstop now, for a turn whose ending is never heard — a dropped SSH link, a child that dies quietly.
  if (!gone) { cap = setTimeout(release, runMs); cap.unref?.(); }
  return id;
}
// The models Codex itself offers, for the picker. One short-lived child, and an empty list simply means the picker
// shows the default alone rather than a guessed catalogue.
async function listModels(timeoutMs = 15000, host) {
  // models come from wherever the task will run, so the picker cannot offer one the host does not have
  const rpc = appServerRpc(timeoutMs, host);
  try {
    await rpc.ready;
    const res = await rpc.call('model/list', {});
    return (res && res.data || []).map((m) => m && (m.id || m.slug)).filter(Boolean);
  } catch { return []; } finally { rpc.stop(); }
}
// Is that machine there? Asked before an assignment goes to it, so an asleep Donut is a message with the prompt
// still on screen rather than a half-made task. Cheap: connect, say hello, hang up.
async function hostReady(host, timeoutMs = 12000) {
  const rpc = appServerRpc(timeoutMs, host);
  try { await rpc.ready; return true; } catch { return false; } finally { rpc.stop(); }
}
module.exports = { codexTasks, codexTaskFor, taskLink, setCodexTask, clearCodexTask, agentPrompt, handoff, agentState, agentStatuses, readAgentStatuses, codexBin, appServerRpc, createTask, releaseTask, stopOwnedTasks, listModels, hostReady, agentWorkspace, hostId, hosts, hostRecord, addHost, removeHost, validHost, NEW_TASK, TASK, THREAD_ID };

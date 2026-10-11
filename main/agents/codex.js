'use strict';
// The ChatGPT agent (main/agent.js, id codex): a node handed to ChatGPT is a message in the Assignments chat
// (main/agentchats.js assign), and a chat question (main/chatagents.js) a read-only task of its own, both through
// Codex's app-server (main/codex-app-server.js). Its tasks live on the Mac that ran them (local).
const agent = require('../agent');
const { TASK, codexBin, withAppServer, runTurn } = require('../codex-app-server');
const agentChats = require('../agentchats');

// ---- what a task is doing ----
// The badge is the task's own status, never elapsed time or a local guess. ThreadStatus is notLoaded | idle |
// systemError | active{activeFlags}; idle cannot tell "finished" from "never ran", so for a quiet thread the last
// turn decides (thread/turns/list defaults to descending, so one turn is the latest one).
// The turns are the authority, not the thread's loaded flag: `notLoaded` only means "this reader has not loaded the
// thread", and asking the thread itself fails with "already has an active writer" whenever the desktop app has it open.
// A node handed over into the Assignments chat names its own turn there (turnId), and that turn decides its badge, so one
// node finishing or failing says nothing about another in the same chat.
const QUIET = ['idle', 'notLoaded'];
// A turn's status as a badge. `interrupted` is what a turn this Mac is still running looks like from another reader
// (running), and otherwise one that was cut off (Orbital quit, the child gone): no longer working.
function turnState(status, running) {
  if (status === 'inProgress') return 'working';
  if (status === 'completed') return 'done';
  if (status === 'interrupted') return running ? 'working' : 'broken';
  return 'broken';
}
function agentState(thread, lastTurn, running = false) {
  if (!thread) return 'broken'; // linked to a task the app cannot account for: stale, and recoverable by retrying
  const type = thread.status && thread.status.type;
  if (type === 'systemError') return 'broken';
  if (type === 'active') return (thread.status.activeFlags || []).length ? 'waiting' : 'working';
  if (!lastTurn) return 'pending'; // a task that exists but has not run: completion is only read off a turn that completed
  return turnState(lastTurn, running);
}
// One read for every linked node: a single thread/list, then the turns only of the threads that need them. `rpc` is the
// caller's connection, so this stays testable without spawning anything. A read that fails as a whole is red for every
// linked node rather than a silent green. turns: nodeId -> the node's own turn, where it has one; running(threadId,
// turnId): whether this Mac is running that turn now (main/agentchats.js running).
async function agentStatuses(links, rpc, turns = {}, running = () => false) {
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
  const recent = new Map(); // threadId -> its latest turns, read once for every node that names a turn in it
  for (const [nodeId, threadId] of entries) {
    const thread = byId.get(threadId) || null, turnId = turns[nodeId];
    if (thread && turnId) {
      if (!recent.has(threadId)) recent.set(threadId, await rpc('thread/turns/list', { threadId, limit: 100 }).then((r) => new Map(((r && r.data) || []).map((t) => [t.id, t.status])), () => null));
      const seen = recent.get(threadId);
      // shortcut: a turn older than the chat's last hundred is taken as done; read further back if old badges mislead
      out[nodeId] = !seen ? 'pending' : seen.has(turnId) ? turnState(seen.get(turnId), running(threadId, turnId)) : 'done';
      continue;
    }
    let last = null;
    if (thread && QUIET.includes(thread.status && thread.status.type)) {
      try {
        const latest = await rpc('thread/turns/list', { threadId, limit: 1 });
        last = (latest && latest.data && latest.data[0]) || null;
      } catch { last = null; } // the thread is there but its turns are not readable: pending, not a failure claim
    }
    out[nodeId] = agentState(thread, last && last.status, !!last && running(threadId, last.id));
  }
  return out;
}
async function statuses(links, full = {}) {
  if (!Object.keys(links || {}).length) return {};
  const turns = Object.fromEntries(Object.entries(full).filter(([, l]) => l && l.turnId).map(([nodeId, l]) => [nodeId, l.turnId]));
  try { return await withAppServer((call) => agentStatuses(links, call, turns, agentChats.running)); }
  catch { return Object.fromEntries(Object.keys(links).map((id) => [id, 'broken'])); }
}

// ---- a task of its own (a chat question, main/chatagents.js) ----
// One entry per key while its turn's child owns the thread (main/codex-app-server.js runTurn), so finishing, quitting,
// a failed launch and unassigning all let go through the same end.
const owned = new Map();
const release = (key) => { const e = owned.get(key); return e ? e.end() : Promise.resolve(); };
const stop = () => { for (const e of [...owned.values()]) e.rpc.stop(); owned.clear(); }; // on the way out: no time for a round trip
// instructions: developer instructions for the whole thread, for a task that has rules beyond its first message
// (main/chatagents.js). readOnly: Codex's own read-only sandbox with nothing to approve, for a task that only answers
// (a chat question): what it may do is held by Codex, not only asked of it in words. The model is Codex's own default.
async function createTask({ key, prompt, instructions, readOnly = false, userData, timeoutMs = 30000, runMs }) {
  const params = { cwd: agent.agentWorkspace(userData), ephemeral: false, ...(instructions ? { developerInstructions: instructions } : {}),
    ...(readOnly ? { sandbox: 'read-only', approvalPolicy: 'never' } : {}) };
  const onThread = (id, run) => { owned.set(key, run); run.ended.then(() => { if (owned.get(key) === run) owned.delete(key); }); }; // a later task under the key owns its own
  return (await runTurn({ params, text: prompt, onThread, timeoutMs, ...(runMs ? { quietMs: runMs } : {}) })).id;
}
const openUrl = (url) => { const { shell } = require('electron'); if (!shell || !shell.openExternal) throw new Error('Cannot open the ChatGPT app from here'); return shell.openExternal(url); };
// A Codex turn's answer: its final answer, or, once it has completed, what it said last when the model does not mark
// one (while it runs, an unmarked message is progress, not the answer)
function codexAnswer(turn) {
  const said = ((turn && turn.items) || []).filter((i) => i && i.type === 'agentMessage' && i.text);
  const final = said.filter((i) => i.phase === 'final_answer').at(-1) || (turn && turn.status === 'completed' ? said.at(-1) : null);
  return (final && final.text) || '';
}

const codex = agent.register({
  id: 'codex', label: 'ChatGPT', icon: 'chatgpt', missing: 'Install the ChatGPT app', local: true,
  available: () => !!codexBin(),
  // a node: its message in the Assignments chat, the chat's thread its task and its own turn there; a chat question: a task
  async start({ key, nodeUri, title, rules, prompt, readOnly, userData }) {
    if (nodeUri) { const { threadId, turnId } = await agentChats.assign(nodeUri, title, prompt); return { taskId: threadId, turnId }; }
    return createTask({ key, prompt, instructions: rules, readOnly, userData });
  },
  statuses,
  open: (taskId) => openUrl(TASK + encodeURIComponent(taskId)),
  // The latest turn of each task (itemsView full), on one child. Read from a second app-server, a turn still running on
  // the one that started it shows as interrupted, so only an answer or a completed or failed turn ends the wait here.
  read: (taskIds) => withAppServer(async (call) => {
    const out = new Map();
    for (const id of taskIds) {
      const turns = await call('thread/turns/list', { threadId: id, limit: 1, itemsView: 'full' }).catch(() => null);
      const turn = turns && turns.data && turns.data[0], text = codexAnswer(turn);
      out.set(id, { state: text ? 'done' : turn && ['completed', 'failed'].includes(turn.status) ? 'failed' : 'working', text });
    }
    return out;
  }),
  release, stop,
});

module.exports = { codex, agentState, agentStatuses, createTask, codexAnswer, release, stop };

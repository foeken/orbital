'use strict';
// Agent chats (docs/CHATS.md §13): a chat in Orbital that is a Codex thread. The conversation is Codex's: started,
// continued and read back through its app-server (main/agents/codex.js appServerRpc), and listed in the Codex app as
// well, where it can be continued. Orbital keeps only the link, the setting agentChats (threadId -> { agent, title, at,
// device }), which follows you (main/settings.js SYNCED): a thread lives on the Mac that started it, so the link names
// that Mac and another one lists the chat without opening it. Nothing of a chat is written to Tana, and deleting one
// forgets the link only: the thread stays in Codex.
// A chat runs in ~/.orbital/chats, made on first use with its house rules (AGENTS.md), and asks for no approval: what
// Codex would ask is decided by its own reviewer (approvalsReviewer auto_review), and anything that would still come
// to a person is answered no (appServerRpc decline), since there is nobody here to ask.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agent = require('./agent');
const settings = require('./settings');
const { send } = require('./state');
const { chatRows } = require('../sdk/chat');
const { appServerRpc, codexBin, TASK } = require('./agents/codex');

const LIST = 'orbital:agent-chats', PREFIX = 'orbital:agent-chat:', KEY = 'agentChats';
const ME = 'orbital:me'; // the author of your own messages, so sdk/chat.js draws them as yours
const RUN_MS = 15 * 60 * 1000; // a turn quiet for longer is let go (main/agents/codex.js createTask's own cap)
const RULES = [
  '# Orbital chats', '',
  'You are in a chat started from Orbital, a desktop app over Tana. The person you talk to is its user: answer them as you',
  'would in your own app, and use your Tana tools when the question is about their work.', '',
  'This folder holds only these house rules. Do not save files, notes or anything read from Tana here.', '',
].join('\n');
// what a chat may do: Codex's own sandbox, and its reviewer instead of a person for anything beyond it
const RUN = { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' };
const TOOLS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall', 'imageGeneration']);

function workspace() {
  const dir = path.join(os.homedir(), '.orbital', 'chats'), rules = path.join(dir, 'AGENTS.md');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(rules)) fs.writeFileSync(rules, RULES);
  return dir;
}

// ---- the links ----
const links = () => { const v = settings.get(KEY); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
const threadOf = (id) => { const t = String(id || '').startsWith(PREFIX) ? String(id).slice(PREFIX.length) : ''; return agent.UUID.test(t) ? t : null; };
function linkOf(id) {
  const t = threadOf(id), link = t && links()[t];
  if (!link) throw new Error('That chat is not here any more');
  return { threadId: t, ...link };
}
function store(threadId, link) { const all = { ...links() }; if (link) all[threadId] = link; else delete all[threadId]; settings.set(KEY, all); send('agentChat:changed', LIST); }
const away = (link) => agent.elsewhere({ device: link.device });
const title = (text) => agent.oneLine(text, 60) || 'New chat';
// the list page's rows (and what the renderer opens them by), newest first
function list() {
  return Object.entries(links()).sort(([, a], [, b]) => (b.at || 0) - (a.at || 0)).map(([t, l]) => ({
    id: PREFIX + t, text: l.title || 'New chat', title: l.title || 'New chat', kind: 'document', icon: 'robot', editable: false, hasChildren: true, appPage: true,
    meta: away(l) ? 'On another Mac' : 'Codex', agentChat: { agent: l.agent || 'codex', at: l.at || null, elsewhere: away(l) },
  }));
}

// ---- a turn: your message, and Codex's answer as it comes ----
// live: threadId -> { turnId, user, at, said: Map(itemId -> text), tools, stop }: the turn this Mac is running, drawn
// from here until it ends, since a read from another app-server shows a running turn as interrupted.
const live = new Map();
let pending = new Set(), timer = null;
function changed(threadId) { pending.add(PREFIX + threadId); if (!timer) timer = setTimeout(() => { timer = null; const ids = pending; pending = new Set(); for (const id of ids) send('agentChat:changed', id); }, 120); }
async function turn(threadId, text) {
  const state = { turnId: null, user: text, at: Date.now(), said: new Map(), tools: 0 };
  let id = threadId, done = false, cap = null;
  const end = async () => {
    if (done) return; done = true;
    if (cap) clearTimeout(cap);
    if (live.get(id) === state) live.delete(id);
    try { if (id) await rpc.call('thread/unsubscribe', { threadId: id }); } catch {}
    rpc.stop(); changed(id);
  };
  const rpc = appServerRpc(30000, (note) => {
    const p = note.params || {};
    if (!id || p.threadId !== id) return;
    if (note.method === 'item/agentMessage/delta') { state.said.set(p.itemId, (state.said.get(p.itemId) || '') + (p.delta || '')); changed(id); }
    else if (note.method === 'item/completed' && p.item && p.item.type === 'agentMessage' && p.item.text) { state.said.set(p.item.id, p.item.text); changed(id); }
    else if (note.method === 'item/started' && p.item && TOOLS.has(p.item.type)) { state.tools++; changed(id); }
    else if (note.method === 'turn/completed') end();
  }, { decline: true });
  state.stop = end;
  try {
    await rpc.ready;
    if (id) await rpc.call('thread/resume', { threadId: id, ...RUN });
    else id = (await rpc.call('thread/start', { cwd: workspace(), ephemeral: false, ...RUN })).thread.id;
    live.set(id, state);
    const started = await rpc.call('turn/start', { threadId: id, input: [{ type: 'text', text }] });
    state.turnId = started && started.turn && started.turn.id;
  } catch (e) { await end(); throw e; }
  cap = setTimeout(end, RUN_MS); cap.unref?.();
  changed(id);
  return id;
}
async function start(agentId, text) {
  if ((agentId || 'codex') !== 'codex') throw new Error('Only Codex can be chatted with');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Type a message first');
  if (!codexBin()) throw new Error('Codex is not installed on this Mac: install the ChatGPT app or the Codex CLI');
  const threadId = await turn(null, text.trim());
  store(threadId, { agent: 'codex', title: title(text), at: Date.now(), device: agent.deviceId() });
  return list().find((r) => r.id === PREFIX + threadId);
}
// A message to a chat. The Codex app may have the thread open, and it takes only one writer at a time: then the message
// is queued to it there (codex queue), and Codex answers it in the app; this page shows it on the next read.
async function say(id, text) {
  const link = linkOf(id);
  if (away(link)) throw new Error('This chat is on another Mac: continue it there');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Type a message first');
  if (live.has(link.threadId)) throw new Error('Codex is still answering');
  try { await turn(link.threadId, text.trim()); return { queued: false }; }
  catch (e) {
    const bin = codexBin();
    if (!bin) throw e;
    await new Promise((resolve, reject) => require('node:child_process').execFile(bin, ['queue', '--thread', link.threadId, '--message', text.trim()], { timeout: 20000 }, (err) => (err ? reject(e) : resolve())));
    return { queued: true };
  }
}
async function stopTurn(id) { const t = threadOf(id), s = t && live.get(t); if (s) await s.stop(); }

// ---- reading a chat back ----
const userText = (content) => (Array.isArray(content) ? content : []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
// One Codex turn as the messages sdk/chat.js draws: yours, then Codex's, its commands and tool calls as the thought line
function turnMessages(t) {
  const items = (t && t.items) || [], at = (t.startedAt || 0) * 1000, out = [];
  for (const i of items) if (i && i.type === 'userMessage') out.push({ id: i.id, fromUserType: 'human', fromUserUri: ME, sentAt: at, content: { text: userText(i.content) } });
  const said = items.filter((i) => i && i.type === 'agentMessage' && i.text).map((i) => i.text), tools = items.filter((i) => i && TOOLS.has(i.type)).map(() => ({ status: 'completed' }));
  const failed = t.status === 'failed';
  if (said.length || tools.length || failed) out.push({ id: t.id, fromUserType: 'ai', sentAt: at, completedAt: (t.completedAt || 0) * 1000, content: { text: said.join('\n\n') }, toolCalls: tools,
    ...(failed ? { status: 'error', errorMessage: (t.error && t.error.message) || '' } : {}) });
  return out;
}
const liveMessages = (s) => [{ id: 'live:q', fromUserType: 'human', fromUserUri: ME, sentAt: s.at, content: { text: s.user } },
  { id: 'live:a', fromUserType: 'ai', sentAt: s.at, content: { text: [...s.said.values()].join('\n\n') }, toolCalls: Array.from({ length: s.tools }, () => ({ status: 'running' })) }];
async function readTurns(threadId) {
  const rpc = appServerRpc(20000);
  try {
    await rpc.ready;
    const turns = [];
    let cursor = null;
    do {
      const page = await rpc.call('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: 50, ...(cursor ? { cursor } : {}) });
      turns.push(...((page && page.data) || []));
      cursor = page && page.nextCursor;
    } while (cursor && turns.length < 1000);
    return turns;
  } finally { rpc.stop(); }
}
// The rows of a chat's page: its turns, the one running here drawn from what has streamed in so far
async function rows(id, read = readTurns) {
  if (!threadOf(id)) return []; // a new chat, its first message not sent yet
  const link = linkOf(id);
  if (away(link)) return [{ id: 'away', text: 'This chat is on another Mac. Open it there, or in Codex on that Mac.', kind: 'block', editable: false, segments: [{ text: 'This chat is on another Mac. Open it there, or in Codex on that Mac.' }], hasChildren: false, children: [] }];
  const s = live.get(link.threadId), turns = (await read(link.threadId)).filter((t) => !s || t.id !== s.turnId);
  const messages = turns.flatMap(turnMessages).concat(s ? liveMessages(s) : []);
  return chatRows(messages, { aiName: 'Codex', me: ME, streamingId: s ? 'live:a' : undefined });
}

// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table). The
// pages' rows come through outline:children (main.js): the list's, and each chat's.
const ipc = {
  'agentChat:list': () => list(),
  'agentChat:start': (_e, agentId, text) => start(agentId, text),
  'agentChat:send': (_e, id, text) => say(id, text),
  'agentChat:stop': (_e, id) => stopTurn(id),
  'agentChat:open': (_e, id) => { const { shell } = require('electron'); return shell.openExternal(TASK + encodeURIComponent(linkOf(id).threadId)); },
  'agentChat:delete': (_e, id) => { const { threadId } = linkOf(id); store(threadId, null); return list(); },
};
const isChat = (id) => String(id || '').startsWith(PREFIX); // a chat, or a new one (orbital:agent-chat:new)
const stop = () => { for (const s of [...live.values()]) s.stop(); };

module.exports = { LIST, PREFIX, KEY, isChat, list, rows, turnMessages, start, say, workspace, stop, ipc };

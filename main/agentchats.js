'use strict';
// Agent chats (docs/CHATS.md §13): a chat in Orbital that is a Codex thread. Its conversation is Codex's: started,
// continued and read back through its app-server (main/codex-app-server.js), and listed in the Codex app as
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
const icons = require('./icons');
const { modelLabel, effortLabel } = require('./prompts');
const settings = require('./settings');
const { S, send, toShells, OPEN_IN } = require('./state');
const { popupMenu } = require('./pins'); // the sidebar's right-click menus
const { chatRows } = require('../sdk/chat');
const appServer = require('./codex-app-server'); // by property, so a check can stand in for it

const LIST = 'orbital:agent-chats', PREFIX = 'orbital:agent-chat:', KEY = 'agentChats';
const ME = 'orbital:me'; // the author of your own messages, so sdk/chat.js draws them as yours
const RULES = [
  '# Orbital chats', '',
  'You are in a chat started from Orbital, a desktop app over Tana. The person you talk to is its user: answer them as you',
  'would in your own app, and use your Tana tools when the question is about their work.', '',
  'A link written [label](tana:<kind>:<id>) is a Tana node: give your Tana tools its whole id, tana:<kind>: included.', '',
  'This folder holds only these house rules. Do not save files, notes or anything read from Tana here.', '',
].join('\n');
// what a chat may do: Codex's own sandbox, and its reviewer instead of a person for anything beyond it. And when Codex
// compacts it: once the conversation itself passes 40k tokens, not the fixed ~30k of Codex's instructions and tools under
// it (the scope) and not at 90% of the model's window (~855k for a 950k one), Codex's default. Chats mostly ask for
// something to be done, so a summary of the older turns is enough, and every message after stays small and cheap.
// Checked live 2026-10-09 (codex-cli 0.160.0): honoured per thread on thread/start and on thread/resume alike.
const RUN = { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write',
  config: { model_auto_compact_token_limit: 40000, model_auto_compact_token_limit_scope: 'body_after_prefix' } };
const TOOLS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall', 'imageGeneration']);

function workspace() {
  const dir = path.join(os.homedir(), '.orbital', 'chats'), rules = path.join(dir, 'AGENTS.md');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(rules) || fs.readFileSync(rules, 'utf8') !== RULES) fs.writeFileSync(rules, RULES); // ours: kept as this build says them
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
// the list changed (a chat, its name, its icon): the pages read it again, and so does each window's sidebar (shell.js),
// which hears nothing of send
function store(threadId, link) {
  const all = { ...links() }; if (link) all[threadId] = link; else delete all[threadId]; settings.set(KEY, all);
  tellList();
}
function tellList() { send('agentChat:changed', LIST); toShells('agentChat:changed', LIST); }
const away = (link) => agent.elsewhere({ device: link.device });
// a title from the first message: a dropped node's link reads as its name, never as markdown and an id
const title = (text) => agent.oneLine(String(text || '').replace(/\[([^\]]*)\]\(tana:[^)]*\)/g, '$1'), 60) || 'New chat';
// the list page's rows (and what the renderer opens them by): the chats newest first
function list() {
  return Object.entries(links()).sort(([, a], [, b]) => (b.at || 0) - (a.at || 0)).map(([t, l]) => { const chosen = icons.typeIconName(PREFIX + t); return {
    id: PREFIX + t, text: l.title || 'New chat', title: l.title || 'New chat', kind: 'document', icon: chosen || 'chatgpt', editable: false, hasChildren: true, appPage: true,
    ...(chosen ? { svg: icons.svgOf(chosen) } : {}), // a glyph chosen with Set icon: the sidebar has only icons.js
    meta: away(l) ? 'On another Mac' : 'ChatGPT', agentChat: { agent: l.agent || 'codex', at: l.at || null, elsewhere: away(l) },
  }; });
}

// ---- a turn: your message, and Codex's answer as it comes ----
// live: threadId -> { turnId, user, at, said: Map(itemId -> text), tools, started, ended, run, past }: the turn this Mac
// is running (main/codex-app-server.js runTurn), drawn from here until it ends, since a read from another app-server
// shows a running turn as interrupted. past: the chat's earlier turns, read once while it streams (rows).
const live = new Map();
let pending = new Set(), timer = null;
function changed(threadId) { pending.add(PREFIX + threadId); if (!timer) timer = setTimeout(() => { timer = null; const ids = pending; pending = new Set(); for (const id of ids) send('agentChat:changed', id); }, 120); }
// Taken before the first wait, so a second message cannot start a second writer on the thread meanwhile: it joins this
// one (into) once `started` has the turn's id. Answers { threadId, turnId }.
async function turn(threadId, text) {
  const state = { turnId: null, user: text, at: Date.now(), said: new Map(), tools: 0, run: null, past: null, stopped: false };
  let id = threadId, over;
  state.ended = new Promise((resolve) => { over = resolve; });
  const done = () => { if (id && live.get(id) === state) live.delete(id); if (id) changed(id); over(); };
  if (id) live.set(id, state);
  state.started = appServer.runTurn({ threadId: id, params: id ? RUN : { cwd: workspace(), ephemeral: false, ...RUN }, text, decline: true,
    onThread: (t, run) => { id = t; state.run = run; live.set(t, state); run.ended.then(done); if (state.stopped) run.end(); }, // stopped while starting
    onNote: (note) => {
      const p = note.params || {};
      if (note.method === 'item/agentMessage/delta') state.said.set(p.itemId, (state.said.get(p.itemId) || '') + (p.delta || ''));
      else if (note.method === 'item/completed' && p.item && p.item.type === 'agentMessage' && p.item.text) state.said.set(p.item.id, p.item.text);
      else if (note.method === 'item/started' && p.item && TOOLS.has(p.item.type)) state.tools++;
      else return;
      changed(id);
    } }).then((r) => { state.turnId = r.turnId; return r; });
  try { await state.started; } catch (e) { done(); throw e; }
  changed(id);
  return { threadId: id, turnId: state.turnId };
}
// whether this Mac is running that turn of that thread now (main/agents/codex.js statuses): one cut off reads interrupted
const running = (threadId, turnId) => { const s = live.get(threadId); return !!s && (!turnId || s.turnId === turnId); };
// A message to a thread: it joins the turn running there (turn/steer, on this Mac's own connection to it), once that
// turn has started; one that has just ended, or that cannot be joined, is waited out and a new turn taken.
async function into(threadId, text) {
  const s = live.get(threadId);
  if (s) {
    try {
      await s.started;
      if (live.get(threadId) !== s) throw new Error('over');
      await s.run.rpc.call('turn/steer', { threadId, expectedTurnId: s.turnId, input: [{ type: 'text', text }] });
      s.user += '\n\n' + text; changed(threadId);
      return { threadId, turnId: s.turnId };
    } catch { await s.ended; return into(threadId, text); } // through the same way: another message may have taken a new turn meanwhile
  }
  return turn(threadId, text);
}
async function start(agentId, text) {
  if ((agentId || 'codex') !== 'codex') throw new Error('Only ChatGPT can be chatted with');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Type a message first');
  if (!appServer.codexBin()) throw new Error('ChatGPT is not on this Mac: install the ChatGPT app');
  const { threadId } = await turn(null, text.trim());
  store(threadId, { agent: 'codex', title: title(text), at: Date.now(), device: agent.deviceId() });
  return list().find((r) => r.id === PREFIX + threadId);
}
// A message to a chat. The Codex app may have the thread open, and it takes only one writer at a time: then, and only
// then, the message is queued to it there (codex queue), and Codex answers it in the app; this page shows it on the next read.
const WRITER = /active writer|another app|open in another/i;
async function say(id, text) {
  const link = linkOf(id);
  if (away(link)) throw new Error('This chat is on another Mac: continue it there');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Type a message first');
  try {
    await into(link.threadId, text.trim());
    const now = links()[link.threadId]; if (now) store(link.threadId, { ...now, at: Date.now() }); // used last: the latest, which assignments go to
    return { queued: false };
  }
  catch (e) {
    const bin = appServer.codexBin();
    if (!bin || !WRITER.test(String(e && e.message))) throw e;
    await new Promise((resolve, reject) => require('node:child_process').execFile(bin, ['queue', '--thread', link.threadId, '--message', text.trim()], { timeout: 20000 }, (err) => (err ? reject(e) : resolve())));
    return { queued: true };
  }
}
// A new name: kept with the link (the list, the sidebar, every Mac), and given to the thread in Codex too, so the Codex
// app lists it by the same name; a Codex that cannot be reached leaves the name here alone.
async function rename(id, name) {
  const { threadId, ...link } = linkOf(id), named = agent.oneLine(name, 80);
  if (!named) throw new Error('Type a name');
  store(threadId, { ...link, title: named });
  if (!away(link) && appServer.codexBin()) await appServer.withAppServer((call) => call('thread/name/set', { threadId, name: named })).catch(() => {});
  return list().find((r) => r.id === id);
}
// The model and reasoning effort the thread runs with, as Orbital names them (main/prompts.js), for its page
async function info(id) {
  const link = linkOf(id);
  if (away(link)) return {};
  const t = (await appServer.withAppServer((call) => call('thread/read', { threadId: link.threadId }))).thread || {};
  return { model: t.model ? modelLabel(t.model) : '', effort: t.reasoningEffort ? effortLabel(t.reasoningEffort) : '' };
}
// a turn still starting has no run yet: it is marked, and ends the moment it has one (turn's onThread)
const halt = (s) => { if (!s) return; s.stopped = true; if (s.run) return s.run.end(); };
async function stopTurn(id) { const t = threadOf(id); await halt(t && live.get(t)); }
// A node handed to ChatGPT (main/agents/codex.js start): a message in your latest chat on this Mac (the one used last,
// which the assignment keeps at the top), or in a new chat when you ask for one (newChat, the Assign page's choice) or
// have none; answers the thread, which the node's task link names, and the turn the message is in, which its badge reads.
// The message is one line the chat shows, the node and the request, and Orbital's own context for ChatGPT in a tag the
// page leaves out (shown): the node and how to treat it (main/agent.js agentPrompt), and that a sub-agent does the work,
// so the chat holds only the results and stays small.
const CONTEXT = /\s*<orbital-context>[\s\S]*?<\/orbital-context>\s*/g;
const shown = (text) => String(text || '').replace(CONTEXT, '\n').trim();
function assignment(nodeUri, title, request) {
  const name = agent.oneLine(title).replace(/[[\]]/g, ' ').trim() || 'a node', asked = String(request || '').trim();
  return 'Assigned [' + name + '](' + nodeUri + ')' + (asked ? ': ' + asked : '') + '\n\n<orbital-context>\n' + agent.agentPrompt(nodeUri, title, request)
    + '\n\nDo the work in a sub-agent of its own: spawn one with this task and everything above, wait for it, then answer here in a few'
    + ' lines with what it did. This chat holds the results; the work happens in the sub-agent.\n</orbital-context>';
}
let making = null; // a first chat being made for an assignment: a second assignment meanwhile waits for it rather than making two
const fresh = (text) => turn(null, text).then((r) => { store(r.threadId, { agent: 'codex', title: title(shown(text)), at: Date.now(), device: agent.deviceId() }); return r; });
async function assign(nodeUri, nodeTitle, request, { newChat = false } = {}) {
  const text = assignment(nodeUri, nodeTitle, request);
  if (newChat) return fresh(text);
  const latest = Object.entries(links()).filter(([, l]) => !away(l)).sort(([, a], [, b]) => (b.at || 0) - (a.at || 0))[0];
  if (!latest) {
    if (making) { await making.catch(() => {}); return assign(nodeUri, nodeTitle, request); }
    making = fresh(text);
    try { return await making; } finally { making = null; }
  }
  const [t] = latest;
  let r;
  // the ChatGPT app holding that chat (another writer), or the thread gone from Codex: the node still goes, to a chat of its own
  try { r = await into(t, text); } catch (e) { if (!/active writer|another app|open in another|not found|no such thread/i.test(String(e && e.message))) throw e; return fresh(text); }
  const now = links()[t]; if (now) store(t, { ...now, at: Date.now() }); // to the top, as it is now: deleted or renamed meanwhile stays so
  return r;
}

// ---- reading a chat back ----
const userText = (content) => (Array.isArray(content) ? content : []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
// One Codex turn as the messages sdk/chat.js draws: yours, then Codex's, its commands and tool calls as the thought line
function turnMessages(t) {
  const items = (t && t.items) || [], at = (t.startedAt || 0) * 1000, out = [];
  for (const i of items) if (i && i.type === 'userMessage') out.push({ id: i.id, fromUserType: 'human', fromUserUri: ME, sentAt: at, content: { text: shown(userText(i.content)) } });
  const said = items.filter((i) => i && i.type === 'agentMessage' && i.text).map((i) => i.text), tools = items.filter((i) => i && TOOLS.has(i.type)).map(() => ({ status: 'completed' }));
  const failed = t.status === 'failed';
  if (said.length || tools.length || failed) out.push({ id: t.id, fromUserType: 'ai', sentAt: at, completedAt: (t.completedAt || 0) * 1000, content: { text: said.join('\n\n') }, toolCalls: tools,
    ...(failed ? { status: 'error', errorMessage: (t.error && t.error.message) || '' } : {}) });
  return out;
}
const liveMessages = (s) => [{ id: 'live:q', fromUserType: 'human', fromUserUri: ME, sentAt: s.at, content: { text: shown(s.user) } },
  { id: 'live:a', fromUserType: 'ai', sentAt: s.at, content: { text: [...s.said.values()].join('\n\n') }, toolCalls: Array.from({ length: s.tools }, () => ({ status: 'running' })) }];
const readTurns = (threadId) => appServer.withAppServer(async (call) => {
  const turns = [];
  let cursor = null;
  do {
    const page = await call('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: 50, ...(cursor ? { cursor } : {}) });
    turns.push(...((page && page.data) || []));
    cursor = page && page.nextCursor;
  } while (cursor && turns.length < 1000);
  return turns;
});
// The rows of a chat's page: its turns, the one running here drawn from what has streamed in so far. While it streams
// the page is asked again with every piece, so the earlier turns are read once for that turn (past), not each time.
async function rows(id, read = readTurns) {
  if (!threadOf(id)) return []; // a new chat, its first message not sent yet
  const link = linkOf(id);
  if (away(link)) return []; // the page says where it is (renderer/render.js emptyText), and its composer takes nothing
  const s = live.get(link.threadId);
  const all = s && s.turnId ? await (s.past ||= read(link.threadId).catch((e) => { s.past = null; throw e; })) : await read(link.threadId); // a failed read is asked again
  const turns = all.filter((t) => !s || t.id !== s.turnId);
  const messages = turns.flatMap(turnMessages).concat(s ? liveMessages(s) : []);
  return chatRows(messages, { aiName: 'ChatGPT', me: ME, streamingId: s ? 'live:a' : undefined });
}

// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table). The
// pages' rows come through outline:children (main.js): the list's, and each chat's.
const ipc = {
  'agentChat:list': () => list(),
  'agentChat:start': (_e, agentId, text) => start(agentId, text),
  'agentChat:send': (_e, id, text) => say(id, text),
  'agentChat:stop': (_e, id) => stopTurn(id),
  'agentChat:rename': (_e, id, name) => rename(id, name),
  'agentChat:info': (_e, id) => info(id),
  'agentChat:open': (_e, id) => {
    const link = linkOf(id);
    if (away(link)) throw new Error('This chat is on another Mac: open it there');
    return agent.get('codex').open(link.threadId); // the ChatGPT agent's own way into a thread (main/agents/codex.js)
  },
  'agentChat:delete': async (_e, id) => { forget(linkOf(id).threadId); return list(); },
  // a right-click on a chat in the sidebar (shell.js): Open in … (answered: the shell opens it there) and Delete chat,
  // which forgets the link as ⌘K Delete does; one on another Mac has nothing to delete here
  'agentChat:menu': (e, id) => {
    const link = linkOf(id);
    return popupMenu(e, [...OPEN_IN, ...(away(link) ? [] : ['-', { id: 'delete', label: 'Delete chat', enabled: !S.demo, run: () => forget(link.threadId) }])]);
  },
};
// Deleting a chat forgets its link and the icon chosen for it, and lets go of an answer still running: nothing could stop it later
function forget(threadId) {
  halt(live.get(threadId));
  icons.dropTypeIcon(PREFIX + threadId);
  store(threadId, null);
}
const isChat = (id) => String(id || '').startsWith(PREFIX); // a chat, or a new one (orbital:agent-chat:new)
const stop = () => { for (const s of [...live.values()]) if (s.run) s.run.rpc.stop(); }; // on the way out: no time for a round trip

module.exports = { LIST, PREFIX, KEY, RUN, isChat, tellList, list, rows, turnMessages, start, say, assign, assignment, running, workspace, stop, ipc };

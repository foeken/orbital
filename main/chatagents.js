'use strict';
// Asking a local agent from a Tana chat (issue #468, docs/CHATS.md §12): "@Codex …" today, any other agent that joins
// AGENTS below later. The question is written to the chat like any message, for the people in it (Tana is not asked);
// a task of that agent on this Mac gets it with the whole chat. The answer is the agent's own, read back from its task
// and shown only in Orbital: nothing it says is written to Tana unless you share it, which posts it as your message.
// The link from a question to its task is the setting chatAsks, which is not in main/settings.js SYNCED, so it stays
// in this device's database and never reaches Tana either.
const agent = require('./agent');
const settings = require('./settings');
const { members } = require('./rows');
const { op, sendChat } = require('./documents');
const { S, errText } = require('./state');

const KEY = 'chatAsks'; // chatId -> [{ messageId, agent, taskId, at, state?, text? }], a finished answer kept so it is read once
const GIVE_UP = 15 * 60 * 1000; // a task quiet for longer is not coming back (main/agent.js createTask's own cap)
// What every agent's task keeps to for its whole life: the chat may flow in, only the asker sees what comes out.
const RULES = [
  'You were asked from a Tana chat through Orbital. Everything in that chat is yours to use.',
  'Your answer is shown only to the person who asked, on their device. It is never saved to Tana and nobody else in the chat sees it.',
  'Answer what they asked and nothing more: do not repeat anything else you saw or know, such as files, mail, other documents or other chats, unless the answer needs it.',
  'Never write to Tana. Do not use any Tana tool that creates, updates, deletes, shares, pins or moves anything.',
].join('\n');

// ---- the agents ----
// Each one says who it is and how to reach it on this device; everything else here is shared. An adapter:
//   label, icon       how the page names and draws it ("@Codex", the robot glyph)
//   available()       whether this device can run it, so "@" only offers what would work
//   start(ask)        begins a task for { key, prompt, rules } and answers its id
//   read(taskIds)     Map taskId -> { state: working|done|failed, text }, for the tasks still running
//   url(taskId)       where the task opens in the agent's own app
const codex = {
  label: 'Codex', icon: 'robot',
  available: () => !!agent.codexBin(),
  start: ({ key, prompt, rules }) => agent.createTask({ nodeUri: key, prompt, instructions: rules, userData: S.userData, host: 'local' }),
  // One app-server child reads the latest turn of each task (thread/turns/list, itemsView full). Read from a second
  // app-server, a turn still running on the one that started it shows as interrupted (main/agent.js agentState says the
  // same of the Assign to Agent bootstrap turn), so only an answer or a completed or failed turn ends the wait here.
  async read(taskIds) {
    const out = new Map(), rpc = agent.appServerRpc(20000, 'local');
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
  url: (taskId) => agent.TASK + encodeURIComponent(taskId),
};
// A Codex turn's answer: its final answer, or, once it has completed, what it said last when the model does not mark
// one (while it runs, an unmarked message is progress, not the answer)
function codexAnswer(turn) {
  const said = ((turn && turn.items) || []).filter((i) => i && i.type === 'agentMessage' && i.text);
  const final = said.filter((i) => i.phase === 'final_answer').at(-1) || (turn && turn.status === 'completed' ? said.at(-1) : null);
  return (final && final.text) || '';
}
const AGENTS = { codex };

// ---- asking ----
const mentionOf = (label) => new RegExp('(^|\\s)@' + label + '\\b', 'i');
// The chat as the task reads it: who said what, oldest first, from data.messages as plain JSON (docs/CHATS.md §1).
function askPrompt(messages, question, nameOf, label) {
  const said = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.type === 'message' && !m.hiddenFromChat && !m.isStatusUpdate && !m.isAIInterviewRelay)
    .map((m) => [m.fromUserType === 'ai' ? 'Tana' : nameOf(m.fromUserUri) || 'Someone', String((m.content && m.content.text) || '').trim()])
    .filter(([, text]) => text).map(([who, text]) => who + ': ' + text);
  return [question.replace(mentionOf(label), ' ').trim() || question, '',
    'The Tana chat this was asked in, oldest first. Mentions are [label](tana:uri); read them with your Tana tools if you need more.', '',
    ...said].join('\n');
}
const asksIn = (chatId) => (settings.get(KEY) || {})[chatId] || [];
function remember(chatId, asks) { settings.set(KEY, { ...(settings.get(KEY) || {}), [chatId]: asks }); }
const list = () => Object.entries(AGENTS).filter(([, a]) => a.available()).map(([id, a]) => ({ id, label: a.label, icon: a.icon }));

// Write the question, then hand it to a new task of that agent. A task that cannot start does not unsend the question:
// the message is in the chat, so the error comes back beside it, as a failed Tana reply does (documents.js askReply).
async function ask(chatId, agentId, text) {
  const a = Object.hasOwn(AGENTS, agentId) ? AGENTS[agentId] : null;
  if (!a) throw new Error('No such agent');
  if (typeof text !== 'string' || !mentionOf(a.label).test(text)) throw new Error('Mention @' + a.label + ' to ask it');
  const { messageId } = await sendChat(chatId, text, [], { ai: false }); // checks the chat and your write access
  try {
    const messages = await op(chatId, async (doc) => { const all = doc.data.get('messages'); return all ? all.toJSON() : []; });
    const names = new Map((await members().catch(() => [])).map((m) => [m.id, m.title]));
    const taskId = await a.start({ key: chatId, prompt: askPrompt(messages, text, (uri) => names.get(uri), a.label), rules: RULES });
    remember(chatId, [...asksIn(chatId), { messageId, agent: agentId, taskId, at: Date.now() }]);
  } catch (e) { return { messageId, error: errText(e) }; }
  return { messageId };
}
// Every question asked in this chat with its answer so far. Finished ones are kept, so only the ones still running
// cost a read, one read per agent.
async function replies(chatId) {
  const asks = asksIn(chatId);
  const out = () => asks.map(({ messageId, agent: id, state, text }) => ({ messageId, agent: id, label: (AGENTS[id] || {}).label || id, state: state || 'working', text: text || '' }));
  const running = asks.filter((x) => !x.state && AGENTS[x.agent]);
  if (!running.length) return out();
  for (const id of new Set(running.map((x) => x.agent))) {
    const mine = running.filter((x) => x.agent === id), read = await AGENTS[id].read(mine.map((x) => x.taskId)).catch(() => new Map());
    for (const x of mine) {
      const r = read.get(x.taskId) || { state: 'working', text: '' };
      if (r.state !== 'working') Object.assign(x, r);
      else if (Date.now() - (x.at || 0) > GIVE_UP) Object.assign(x, { state: 'failed', text: '' });
    }
  }
  remember(chatId, asks);
  return out();
}
// The task behind a question, opened in its agent's app by id, as the agent badge opens a node's task (main.js
// codex:open). The page names the question, never a url, so there is nothing here to point somewhere else.
async function open(chatId, messageId) {
  const x = asksIn(chatId).find((y) => y.messageId === messageId), a = x && AGENTS[x.agent];
  if (!a || typeof x.taskId !== 'string' || !x.taskId) return false;
  await require('electron').shell.openExternal(a.url(x.taskId));
  return true;
}

const isChat = (id) => typeof id === 'string' && /^tana:chat:[0-9a-z]{26}$/.test(id);
const ipc = {
  'chatAgent:list': () => list(),
  'chatAgent:ask': (_e, chatId, agentId, text) => { if (!isChat(chatId)) throw new Error('Not a chat'); return ask(chatId, agentId, text); },
  'chatAgent:replies': (_e, chatId) => (isChat(chatId) ? replies(chatId) : []),
  'chatAgent:open': (_e, chatId, messageId) => (isChat(chatId) && typeof messageId === 'string' ? open(chatId, messageId) : false),
};
module.exports = { AGENTS, list, ask, replies, open, askPrompt, codexAnswer, RULES, KEY, ipc };

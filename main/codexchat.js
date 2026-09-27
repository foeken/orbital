'use strict';
// @Codex in a Tana chat (issue #468, docs/CHATS.md §12). The question is written to the chat like any message, for
// the people in it (Tana is not asked); a Codex task on this Mac gets it with the whole chat. The answer is Codex's
// own, read back from that task and shown only in Orbital: nothing Codex says is written to Tana unless you share it,
// which posts it as your message. The link from a question to its task is the setting codexAsks, which is not in
// main/settings.js SYNCED, so it stays in this Mac's database and never reaches Tana either.
const agent = require('./agent');
const settings = require('./settings');
const { members } = require('./rows');
const { op, sendChat } = require('./documents');
const { S, errText } = require('./state');

const KEY = 'codexAsks'; // chatId -> [{ messageId, threadId, at, state?, text? }], a finished answer kept so it is read once
const GIVE_UP = 15 * 60 * 1000; // main/agent.js createTask's own cap on a turn: a task quiet for longer is not coming back
const MENTION = /(^|\s)@codex\b/i;
// What the task keeps to for its whole life: Tana's chat may flow in, only the asker sees what comes out.
const RULES = [
  'You were asked from a Tana chat through Orbital. Everything in that chat is yours to use.',
  'Your answer is shown only to the person who asked, on their Mac. It is never saved to Tana and nobody else in the chat sees it.',
  'Answer what they asked and nothing more: do not repeat anything else you saw or know, such as files, mail, other documents or other chats, unless the answer needs it.',
  'Never write to Tana. Do not use any Tana tool that creates, updates, deletes, shares, pins or moves anything.',
].join('\n');

// The chat as the task reads it: who said what, oldest first, from data.messages as plain JSON (docs/CHATS.md §1).
function askPrompt(messages, question, nameOf) {
  const said = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.type === 'message' && !m.hiddenFromChat && !m.isStatusUpdate && !m.isAIInterviewRelay)
    .map((m) => [m.fromUserType === 'ai' ? 'Tana' : nameOf(m.fromUserUri) || 'Someone', String((m.content && m.content.text) || '').trim()])
    .filter(([, text]) => text).map(([who, text]) => who + ': ' + text);
  return [question.replace(MENTION, ' ').trim() || question, '',
    'The Tana chat this was asked in, oldest first. Mentions are [label](tana:uri); read them with your Tana tools if you need more.', '',
    ...said].join('\n');
}
// The answer in a turn: its final answer, or, once the turn has completed, what it said last when the model does not
// mark one (while it runs, an unmarked message is progress, not the answer)
function answerOf(turn) {
  const said = ((turn && turn.items) || []).filter((i) => i && i.type === 'agentMessage' && i.text);
  const final = said.filter((i) => i.phase === 'final_answer').at(-1) || (turn.status === 'completed' ? said.at(-1) : null);
  return (final && final.text) || '';
}
// Read from a second app-server, a turn still running on the one that started it shows as interrupted (main/agent.js
// agentState says the same of the Assign to Agent bootstrap turn), so only an answer, a completed or failed turn, or
// the cap ends the wait.
function stateOf(turn, age) {
  if (turn && answerOf(turn)) return 'done';
  if ((turn && ['completed', 'failed'].includes(turn.status)) || age > GIVE_UP) return 'failed';
  return 'working';
}

const asksIn = (chatId) => (settings.get(KEY) || {})[chatId] || [];
function remember(chatId, asks) { settings.set(KEY, { ...(settings.get(KEY) || {}), [chatId]: asks }); }

// Write the question, then hand it to a new Codex task. A task that cannot start does not unsend the question: the
// message is in the chat, so the error comes back beside it, as a failed Tana reply does (main/documents.js askReply).
async function ask(chatId, text) {
  if (typeof text !== 'string' || !MENTION.test(text)) throw new Error('Mention @Codex to ask it');
  const { messageId } = await sendChat(chatId, text, [], { ai: false }); // checks the chat and your write access
  try {
    const messages = await op(chatId, async (doc) => { const list = doc.data.get('messages'); return list ? list.toJSON() : []; });
    const names = new Map((await members().catch(() => [])).map((m) => [m.id, m.title]));
    const threadId = await agent.createTask({ nodeUri: chatId, prompt: askPrompt(messages, text, (uri) => names.get(uri)), instructions: RULES, userData: S.userData, host: 'local' });
    remember(chatId, [...asksIn(chatId), { messageId, threadId, at: Date.now() }]);
  } catch (e) { return { messageId, codexError: errText(e) }; }
  return { messageId };
}
// Every question asked in this chat with its answer so far. Finished ones are kept, so only the ones still running
// cost a read: one app-server child, the latest turn of each task.
async function replies(chatId) {
  const asks = asksIn(chatId), out = () => asks.map(({ messageId, state, text }) => ({ messageId, state: state || 'working', text: text || '' }));
  if (asks.every((a) => a.state)) return out();
  const rpc = agent.appServerRpc(20000, 'local');
  try {
    await rpc.ready;
    for (const a of asks) {
      if (a.state) continue;
      const turns = await rpc.call('thread/turns/list', { threadId: a.threadId, limit: 1, itemsView: 'full' }).catch(() => null);
      const turn = turns && turns.data && turns.data[0], state = stateOf(turn, Date.now() - (a.at || 0));
      if (state !== 'working') Object.assign(a, { state, text: turn ? answerOf(turn) : '' });
    }
  } finally { rpc.stop(); }
  remember(chatId, asks);
  return out();
}

const isChat = (id) => typeof id === 'string' && /^tana:chat:[0-9a-z]{26}$/.test(id);
// The task behind a question, opened in Codex by its id, the way the agent badge opens a node's task (main.js
// codex:open). The page names the question, never a url, so there is nothing here to point somewhere else.
async function openAsk(chatId, messageId) {
  const a = asksIn(chatId).find((x) => x.messageId === messageId);
  if (!a || !agent.THREAD_ID.test(String(a.threadId))) return false;
  await require('electron').shell.openExternal(agent.TASK + encodeURIComponent(a.threadId));
  return true;
}
const ipc = {
  'codex:ask': (_e, chatId, text) => { if (!isChat(chatId)) throw new Error('Not a chat'); return ask(chatId, text); },
  'codex:replies': (_e, chatId) => (isChat(chatId) ? replies(chatId) : []),
  'codex:openAsk': (_e, chatId, messageId) => (isChat(chatId) && typeof messageId === 'string' ? openAsk(chatId, messageId) : false),
};
module.exports = { ask, replies, openAsk, askPrompt, answerOf, stateOf, RULES, KEY, ipc };

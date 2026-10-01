'use strict';
// The Tana agent (main/agent.js): a node handed to Tana's own AI, which every workspace has and needs nothing installed,
// so it is always on and the default until another is chosen. A task is a new Tana chat with the request and the node
// attached to the message (the way Tana's own runSkill attaches what it works on, docs/CHATS.md §10), answered by Tana
// as any chat is. It lives in Tana like every other chat, and its badge opens it here, in Orbital (opensHere).
const agent = require('../agent');
const chat = require('../../sdk/chat');
const { newChat, sendChat, op, discard } = require('../documents');

// A chat's state from its messages: Tana writing (data.streamingMessageId) or not answered yet is working, a question
// Tana is waiting on is waiting, an error is broken, and an answer is done.
function chatState(streaming, messages) {
  if (streaming) return 'working';
  const said = (Array.isArray(messages) ? messages : []).filter((m) => m && m.type === 'message' && !m.hiddenFromChat && !m.isStatusUpdate);
  const last = said.at(-1);
  if (!last) return 'pending';
  if (last.fromUserType !== 'ai') return 'working';
  if (chat.pendingQuestions(last)) return 'waiting';
  if (typeof last.errorMessage === 'string' && last.errorMessage.trim()) return 'broken';
  return 'done';
}
const label = (title) => agent.oneLine(title).replace(/[[\]]/g, '') || 'This node'; // a mention's label is markdown link text

const tana = agent.register({
  id: 'tana', label: 'Tana', icon: 'tana', opensHere: true,
  available: () => true,
  async start({ nodeUri, title, prompt }) {
    const created = await newChat(nodeUri); // the chat belongs to the node, as #669 asks, and Tana's reply knows it
    // Any failure from here on — the message not sent, or Tana not asked (its AI limit, say) — leaves no badge for an
    // unanswered chat and no chat behind on the node that Orbital no longer links to, one more on every retry (#671
    // review); the removal is no deletion of yours: not in Recently deleted, not an undo step
    try {
      const sent = await sendChat(created.id, (prompt || 'Help me with this.') + '\n\n[' + label(title) + '](' + nodeUri + ')', [nodeUri], { ai: true });
      if (sent.replyError) throw new Error(sent.replyError);
    } catch (error) {
      await discard(created.id).catch(() => {});
      throw error;
    }
    return created.id;
  },
  async resume(chatId, prompt) {
    if (!prompt) return;
    const sent = await sendChat(chatId, prompt, [], { ai: true });
    if (sent && sent.replyError) throw new Error(sent.replyError); // saved but unanswered: say so, as start does, rather than a badge working for ever
  },
  async statuses(links) {
    const out = {};
    for (const [nodeId, chatId] of Object.entries(links || {})) {
      out[nodeId] = await op(chatId, (doc) => { const all = doc.data.get('messages'); return chatState(doc.data.get('streamingMessageId'), all ? all.toJSON() : []); }).catch(() => 'broken');
    }
    return out;
  },
});

module.exports = { tana, chatState };

'use strict';
// Agent chats (main/agentchats.js, docs/CHATS.md §13): a chat in Orbital that is a Codex thread. The Agent chats page
// lists them (an app page, as Notifications is), each opens as a chat page drawn like a Tana chat (renderer/chat.js),
// and ⌘K New chat with Codex opens a new one, which becomes a thread with its first message. The conversation lives in
// Codex: Orbital keeps the link, and Delete chat forgets that link only.
const AGENT_CHATS_PAGE = 'orbital:agent-chats', AGENT_CHAT = 'orbital:agent-chat:', AGENT_CHAT_NEW = AGENT_CHAT + 'new';
extra.set(AGENT_CHATS_PAGE, { id: AGENT_CHATS_PAGE, text: 'Agent chats', title: 'Agent chats', kind: 'document', icon: 'robot', editable: false, hasChildren: true, appPage: true });
extra.set(AGENT_CHAT_NEW, { id: AGENT_CHAT_NEW, text: 'New chat with Codex', title: 'New chat with Codex', kind: 'document', icon: 'robot', editable: false, hasChildren: true, appPage: true });
const isAgentChat = (id) => String(id || '').startsWith(AGENT_CHAT);
// every chat on the list, as a page to open by its id: its title and glyph are known before its messages are read
const knowAgentChats = (list) => { for (const n of list || []) extra.set(n.id, { ...n }); };
if (tana.agentChats) tana.agentChats().then(knowAgentChats, () => {});
// an answer streaming in, or the list changed (here or on another Mac): read again what is on screen
if (tana.onAgentChatChanged) tana.onAgentChatChanged((id) => {
  if (id === AGENT_CHATS_PAGE) { tana.agentChats().then((list) => { knowAgentChats(list); return kids.has(id) ? reload(id).then(() => renderSoon(true)) : null; }).catch(() => {}); return; }
  if (kids.has(id)) reload(id).then(() => renderSoon(true), () => {});
});
const codexHere = () => agentList.some((a) => a.id === 'codex' && a.installed);
// What the composer sends on an agent chat (renderer/chat.js chatSend): a new chat starts its thread with it and the
// page becomes that chat; an open one takes it as the next turn. A message the Codex app had to take is said so.
function agentChatSend(docId, draft, text) {
  run(async () => {
    let sent;
    try {
      if (docId === AGENT_CHAT_NEW) { const n = await tana.startAgentChat('codex', text); extra.set(n.id, n); navReplace = true; openDoc(n.id); return; }
      sent = await tana.sendAgentChat(docId, text);
    } catch (e) { restoreDraft(docId, draft); throw e; }
    if (sent.queued) showNote('Codex has this chat open: your message is queued there, and Codex answers it in the app');
    await reload(docId);
    if (zoom && zoom.docId === docId) { outline.parentElement.scrollTop = outline.parentElement.scrollHeight; renderSoon(true); }
  });
}
const agentChatAnswering = (docId) => (kids.get(docId) || []).some((n) => n.chat && n.chat.streaming);
function deleteAgentChat(docId) {
  run(async () => { knowAgentChats(await tana.deleteAgentChat(docId)); extra.delete(docId); kids.delete(docId); navReplace = true; goTo(AGENT_CHATS_PAGE); showNote('Chat removed from Orbital. It is still in Codex'); });
}
// ⌘K: the page under Views, a new chat under Actions, and on a chat what can be done with it
const agentChatsViewRow = () => ({ id: 'agentChats', group: 'Views', icon: 'robot', label: 'Agent chats', hint: 'Chats with Codex', run: () => goTo(AGENT_CHATS_PAGE) });
function agentChatRows() {
  const rows = [];
  if (tana.startAgentChat && codexHere()) rows.push({ id: 'newAgentChat', group: 'Actions', icon: 'robot', label: 'New chat with Codex', hint: 'Kept in Codex, not in Tana', run: () => openDoc(AGENT_CHAT_NEW) });
  const docId = zoom && !zoom.nodeId && isAgentChat(zoom.docId) && zoom.docId !== AGENT_CHAT_NEW ? zoom.docId : null, here = docId && extra.get(docId);
  if (!docId || !here || (here.agentChat && here.agentChat.elsewhere)) return rows;
  if (agentChatAnswering(docId)) rows.push({ id: 'stopAgentChat', group: 'Current node', icon: 'robot', label: 'Stop Codex', hint: 'The answer being written', run: () => run(() => tana.stopAgentChat(docId)) });
  rows.push({ id: 'openAgentChat', group: 'Current node', icon: 'robot', label: 'Open in Codex', hint: 'This chat, in the Codex app', run: () => run(() => tana.openAgentChat(docId)) });
  rows.push({ id: 'deleteAgentChat', group: 'Current node', icon: 'trash', label: 'Delete chat', hint: 'From Orbital; it stays in Codex', run: () => deleteAgentChat(docId) });
  return rows;
}


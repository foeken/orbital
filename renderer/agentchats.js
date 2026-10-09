'use strict';
// Agent chats (main/agentchats.js, docs/CHATS.md §13): a chat in Orbital that is a Codex thread. The Agent chats page
// lists them (an app page, as Notifications is), each opens as a chat page drawn like a Tana chat (renderer/chat.js),
// and ⌘K New chat with Codex opens a new one, which becomes a thread with its first message. The conversation lives in
// Codex: Orbital keeps the link, and Delete chat forgets that link only.
const AGENT_CHATS_PAGE = 'orbital:agent-chats', AGENT_CHAT = 'orbital:agent-chat:', AGENT_CHAT_NEW = AGENT_CHAT + 'new';
extra.set(AGENT_CHATS_PAGE, { id: AGENT_CHATS_PAGE, text: 'Agent chats', title: 'Agent chats', kind: 'document', icon: 'robot', editable: false, hasChildren: true, appPage: true });
extra.set(AGENT_CHAT_NEW, { id: AGENT_CHAT_NEW, text: 'New chat with Codex', title: 'New chat with Codex', kind: 'document', icon: 'robot', editable: false, hasChildren: true, appPage: true });
const isAgentChat = (id) => String(id || '').startsWith(AGENT_CHAT);
// your Dot's own chat (main/agentchats.js dotList): there for as long as the Dot is linked, so not renamed, deleted or given an icon
const agentChatFixed = (id) => !!(extra.get(id) || {}).agentChat?.fixed;
const agentChatLabel = (id) => (extra.get(id) || {}).agentChat?.label || 'Codex'; // who the chat is with
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
      if (docId === AGENT_CHAT_NEW) { const n = await tana.startAgentChat('codex', text); extra.set(n.id, n); agentChatInfos.delete(n.id); navReplace = true; openDoc(n.id); return; }
      sent = await tana.sendAgentChat(docId, text);
    } catch (e) { restoreDraft(docId, draft); throw e; }
    if (sent.queued) showNote('Codex has this chat open: your message is queued there, and Codex answers it in the app');
    await reload(docId);
    if (zoom && zoom.docId === docId) { outline.parentElement.scrollTop = outline.parentElement.scrollHeight; renderSoon(true); }
  });
}
const agentChatAnswering = (docId) => (kids.get(docId) || []).some((n) => n.chat && n.chat.streaming);
// The line at the top of an agent chat, where a Tana chat says who can see it (renderer/chat.js chatContextEl): a lock and
// that only you see it and Tana does not, then the model and reasoning effort Codex runs it with, asked once per chat
// (main/agentchats.js info)
const agentChatInfos = new Map(); // docId -> { model, effort }, or null while it is asked
function agentChatContextEl(id) {
  if (id !== AGENT_CHAT_NEW && !agentChatInfos.has(id) && tana.agentChatInfo) {
    agentChatInfos.set(id, null);
    tana.agentChatInfo(id).then((i) => { agentChatInfos.set(id, i || {}); if (zoom && zoom.docId === id) renderSoon(true); }, () => agentChatInfos.delete(id));
  }
  const info = agentChatInfos.get(id) || {}, el = document.createElement('div'), words = [info.model, info.effort].filter(Boolean).join(' · ');
  el.className = 'chat-context';
  el.append(addIcon(document.createElement('span'), 'lock'), 'Only you · not shared with Tana', ...(words ? [' · ' + words] : []));
  return el;
}
// Rename chat …: the name on the list and in the sidebar, and the thread's name in Codex (main/agentchats.js rename)
function renameAgentChat(docId) {
  const now = (extra.get(docId) || {}).title || '';
  namePage('renameAgentChat', 'Rename the chat…', { group: 'Rename chat', icon: 'rename', back: BACK_TO_COMMANDS },
    (name) => ({ label: 'Rename to “' + name + '”', run: () => run(async () => { const n = await tana.renameAgentChat(docId, name); if (n) extra.set(n.id, n); renderSoon(true); }) }), now);
}
// a double-click on an agent chat's title renames it, as its read-only title takes no typing
titleEl.addEventListener('dblclick', () => { if (zoom && !zoom.nodeId && isAgentChat(zoom.docId) && zoom.docId !== AGENT_CHAT_NEW && tana.renameAgentChat) renameAgentChat(zoom.docId); });
function deleteAgentChat(docId) {
  run(async () => { knowAgentChats(await tana.deleteAgentChat(docId)); extra.delete(docId); kids.delete(docId); navReplace = true; goTo(AGENT_CHATS_PAGE); showNote('Chat removed from Orbital. It is still in Codex'); });
}
// ⌘K: the page under Views, a new chat under Actions, and on a chat what can be done with it
const agentChatsViewRow = () => ({ id: 'agentChats', group: 'Views', icon: 'robot', label: 'Agent chats', hint: 'Chats with Codex', opens: AGENT_CHATS_PAGE, run: () => goTo(AGENT_CHATS_PAGE) });
function agentChatRows() {
  const rows = [];
  if (tana.startAgentChat && codexHere()) rows.push({ id: 'newAgentChat', group: 'Actions', icon: 'robot', label: 'New chat with Codex', hint: 'Kept in Codex, not in Tana', opens: AGENT_CHAT_NEW, run: () => openDoc(AGENT_CHAT_NEW) });
  const docId = zoom && !zoom.nodeId && isAgentChat(zoom.docId) && zoom.docId !== AGENT_CHAT_NEW ? zoom.docId : null, here = docId && extra.get(docId);
  if (!docId || !here || (here.agentChat && here.agentChat.elsewhere) || agentChatFixed(docId)) return rows; // a Dot's chat: nothing to rename, open or delete
  if (agentChatAnswering(docId)) rows.push({ id: 'stopAgentChat', group: 'Current node', icon: 'robot', label: 'Stop Codex', hint: 'The answer being written', run: () => run(() => tana.stopAgentChat(docId)) });
  if (tana.renameAgentChat) rows.push({ id: 'renameAgentChat', group: 'Current node', icon: 'rename', label: 'Rename chat …', hint: here.title || '', keepOpen: true, run: () => renameAgentChat(docId) });
  rows.push({ id: 'openAgentChat', group: 'Current node', icon: 'robot', label: 'Open in Codex', hint: 'This chat, in the Codex app', run: () => run(() => tana.openAgentChat(docId)) });
  rows.push({ id: 'deleteAgentChat', group: 'Current node', icon: 'trash', label: 'Delete chat', hint: 'From Orbital; it stays in Codex', run: () => deleteAgentChat(docId) });
  return rows;
}

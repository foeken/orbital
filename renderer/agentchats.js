'use strict';
// Agent chats (main/agentchats.js, docs/CHATS.md §13): a chat in Orbital that is a Codex thread. The Agent chats page
// lists them (an app page, as Notifications is), each opens as a chat page drawn like a Tana chat (renderer/chat.js),
// and ⌘K New chat with ChatGPT opens a new one, which becomes a thread with its first message. The conversation lives in
// Codex: Orbital keeps the link, and Delete forgets that link only.
const AGENT_CHATS_PAGE = 'orbital:agent-chats', AGENT_CHAT = 'orbital:agent-chat:', AGENT_CHAT_NEW = AGENT_CHAT + 'new';
extra.set(AGENT_CHATS_PAGE, { id: AGENT_CHATS_PAGE, text: 'Agent chats', title: 'Agent chats', kind: 'document', icon: 'robot', editable: false, hasChildren: true, appPage: true });
extra.set(AGENT_CHAT_NEW, { id: AGENT_CHAT_NEW, text: 'New chat with ChatGPT', title: 'New chat with ChatGPT', kind: 'document', icon: 'chatgpt', editable: false, hasChildren: true, appPage: true });
const isAgentChat = (id) => String(id || '').startsWith(AGENT_CHAT);
// the agent chat on screen, one that exists (not a new one's page), or null
const agentChatOpen = () => (zoom && !zoom.nodeId && isAgentChat(zoom.docId) && zoom.docId !== AGENT_CHAT_NEW ? zoom.docId : null);
const agentChatAway = (id) => !!(extra.get(id) || {}).agentChat?.elsewhere; // started on another Mac, where it lives
// every chat on the list, as a page to open by its id: its title and glyph are known before its messages are read
let agentChatsKnown = []; // the list as main last said it: what ⌘K and ⌘S find, though none of it is in Tana
const knowAgentChats = (list) => { agentChatsKnown = Array.isArray(list) ? list : []; for (const n of agentChatsKnown) extra.set(n.id, { ...n }); };
// ⌘S: the chats whose title holds every word typed, after Tana's own results (renderer/palette.js searchNow);
// none for a #filter, which asks Tana for a kind of node
function agentChatHits(q) {
  const words = String(q || '').split(/\s+/).filter(Boolean);
  if (!words.length || words.some((w) => w.startsWith('#'))) return [];
  return agentChatsKnown.filter((n) => titleHits(n.title || n.text || '', q).hits === words.length);
}
// ⌘K: each chat a place to go (place: after a command that matches as well, and never by scattered letters; renderer/palette.js
// paletteRows), ⌘↩ ⇧↩ ⌥↩ opening it elsewhere. Its title is your own words: masked in demo mode.
const agentChatPlaceRows = () => agentChatsKnown.map((n) => ({ id: 'agentChat:' + n.id, group: 'Agent chats', icon: n.icon, label: demoText(n.title, n.id), place: true, opens: n.id, run: () => goTo(n.id) }));
if (tana.agentChats) tana.agentChats().then(knowAgentChats, () => {});
// an answer streaming in, or the list changed (here or on another Mac): read again what is on screen
if (tana.onAgentChatChanged) tana.onAgentChatChanged((id) => {
  if (id === AGENT_CHATS_PAGE) {
    tana.agentChats().then((list) => {
      knowAgentChats(list);
      // the chat on screen was deleted (the sidebar's Delete chat, or on another Mac): back to the list, as ⌘K Delete goes
      if (agentChatOpen() && !agentChatsKnown.some((n) => n.id === zoom.docId)) { navReplace = true; goTo(AGENT_CHATS_PAGE); return null; }
      return kids.has(id) ? reload(id).then(() => renderSoon(true)) : null;
    }).catch(() => {});
    return;
  }
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
    if (sent.queued) showNote('The ChatGPT app has this chat open: your message is queued there and answered in the app');
    await reload(docId);
    if (zoom && zoom.docId === docId) { outline.parentElement.scrollTop = outline.parentElement.scrollHeight; renderSoon(true); }
  });
}
const agentChatAnswering = (docId) => (kids.get(docId) || []).some((n) => n.chat && n.chat.streaming);
// The line at the top of an agent chat, where a Tana chat says who can see it (renderer/chat.js chatContextEl): a lock and
// that only you see it and the conversation is not in Tana (its title is kept with your settings there), what the
// Assignments chat is for, then the model and reasoning effort Codex runs it with, asked once per chat (main/agentchats.js info)
const agentChatInfos = new Map(); // docId -> { model, effort }, or null while it is asked
function agentChatContextEl(id) {
  if (id !== AGENT_CHAT_NEW && !agentChatAway(id) && !agentChatInfos.has(id) && tana.agentChatInfo) {
    agentChatInfos.set(id, null);
    tana.agentChatInfo(id).then((i) => { agentChatInfos.set(id, i || {}); if (zoom && zoom.docId === id) renderSoon(true); }, () => agentChatInfos.delete(id));
  }
  const info = agentChatInfos.get(id) || {}, el = document.createElement('div'), words = [info.model, info.effort].filter(Boolean).join(' · ');
  const about = (extra.get(id) || {}).assignments ? 'Every node you assign to ChatGPT · ' : '';
  el.className = 'chat-context';
  el.append(addIcon(document.createElement('span'), 'lock'), about + 'Only you · the conversation stays out of Tana', ...(words ? [' · ' + words] : []));
  return el;
}
// ⌘K Rename on an agent chat: the name on the list and in the sidebar, and the thread's name in Codex (main/agentchats.js rename)
function renameAgentChat(docId) {
  const now = (extra.get(docId) || {}).title || '';
  namePage('renameAgentChat', 'Rename the chat…', { group: 'Rename chat', icon: 'rename', back: BACK_TO_COMMANDS },
    (name) => ({ label: 'Rename to “' + name + '”', run: () => run(async () => { const n = await tana.renameAgentChat(docId, name); if (n) extra.set(n.id, n); renderSoon(true); }) }), now);
}
function deleteAgentChat(docId) {
  run(async () => { knowAgentChats(await tana.deleteAgentChat(docId)); extra.delete(docId); kids.delete(docId); navReplace = true; goTo(AGENT_CHATS_PAGE); showNote('Chat removed from Orbital. It is still in the ChatGPT app'); });
}
// ⌘K: the page under Views, a new chat under Actions, and on a chat what can be done with it (beside Rename, which is
// the page's own row: renderer/document.js renameTitle renames an agent chat)
const agentChatsViewRow = () => ({ id: 'agentChats', group: 'Views', icon: 'robot', label: 'Agent chats', hint: 'Chats with ChatGPT, started in Orbital', opens: AGENT_CHATS_PAGE, run: () => goTo(AGENT_CHATS_PAGE) });
const agentChatNewRows = () => (tana.startAgentChat && codexHere() ? [{ id: 'newAgentChat', group: 'Actions', icon: 'chatgpt', label: 'New chat with ChatGPT', hint: 'On this Mac, in the ChatGPT app, not in Tana', opens: AGENT_CHAT_NEW, run: () => openDoc(AGENT_CHAT_NEW) }] : []);
function agentChatOwnRows(group) {
  const docId = agentChatOpen(), here = docId && extra.get(docId);
  if (!here || agentChatAway(docId)) return []; // another Mac's: nothing to stop, open or delete here
  return [
    ...(agentChatAnswering(docId) ? [{ id: 'stopAgentChat', group, icon: 'chatgpt', label: 'Stop ChatGPT', hint: 'The answer being written', run: () => run(() => tana.stopAgentChat(docId)) }] : []),
    { id: 'openAgentChat', group, icon: 'chatgpt', label: 'Open in ChatGPT', hint: 'This chat, in the ChatGPT app', run: () => run(() => tana.openAgentChat(docId)) },
    { id: 'deleteAgentChat', group, icon: 'trash', label: 'Delete', hint: here.assignments ? 'From Orbital; your next assignment starts a new chat' : 'From Orbital; it stays in the ChatGPT app', run: () => deleteAgentChat(docId) },
  ];
}

'use strict';
// A chat drawn as a conversation, in the Codex app's style (docs/CHATS.md §8, §10): the rows main makes from
// data.messages (sdk/chat.js chatRows) become messages, oldest at the top: yours in a light blue bubble on the right,
// Tana's (and anyone else's) as plain text across the page, the thinking line in grey above it. Hovering a message shows
// when it was sent. Under the conversation sits the composer: Enter sends, Shift+Enter starts a new line, and Tana's AI answers by
// itself where the chat lets it (main/documents.js sendChat). While it is thinking three dots stand where its answer
// will be; the answer streams in as live updates to the chat, each one read again like any change to an open page.
const composer = $('composer'), composerText = $('composerText'), composerSend = $('composerSend');
const CHAT_WAIT = 12e4; // how long the dots wait on an answer that has not started to arrive
let chatShown = null; // the chat drawn last: a chat opened anew goes to its end, and its composer takes the caret
const chatDrafts = new Map(); // docId -> what was typed there and not sent
const chatWaiting = new Map(); // docId -> when a message went out that Tana was asked to answer
const isChatPage = (parent) => !!parent && !parent.nodeId && String(parent.docId).startsWith('tana:chat:');

function chatDotsEl() {
  const el = document.createElement('span'); el.className = 'chat-dots'; el.setAttribute('aria-label', 'Tana is writing');
  for (let i = 0; i < 3; i++) el.append(document.createElement('i'));
  return el;
}
// One line of a message: a markdown block (sdk/chat.js blocks), a card for an attachment or proposed document, and
// what a proposal or a question holds under it.
function chatPartEls(n, docId) {
  if (n.type === 'reference') {
    const ref = n.reference || {}, target = ref.node || {}, el = document.createElement('div');
    el.className = 'chat-ref';
    renderSegs(el, [{ mention: { uri: ref.uri, label: target.text || target.title || ref.label || 'Unavailable reference', icon: target.icon, hue: target.hue, deleted: ref.deleted } }], docId);
    return [el];
  }
  const el = document.createElement(n.block === 'code' ? 'pre' : 'div');
  el.className = 'chat-' + (n.block || 'paragraph');
  if (n.block !== 'divider') renderSegs(el, n.segments || [], docId);
  return [el, ...(n.children || []).flatMap((c) => chatPartEls(c, docId))];
}
function chatMessageEl(n, docId) {
  const c = n.chat, el = document.createElement('div'), bubble = document.createElement('div');
  el.className = 'chat-msg ' + (c.mine ? 'mine' : 'theirs');
  bubble.className = 'bubble';
  if (c.sentAt) bubble.title = new Date(c.sentAt).toLocaleString();
  for (const part of n.children || []) {
    if (part.note) { const note = document.createElement('div'); note.className = 'chat-note'; renderSegs(note, part.segments || [], docId); el.append(note); } // "Thought for 12 seconds", an error: above the bubble
    else bubble.append(...chatPartEls(part, docId));
  }
  if (!bubble.childNodes.length && c.streaming) bubble.append(chatDotsEl());
  if (bubble.childNodes.length) el.append(bubble);
  return el;
}
// The rows of an open chat, as the elements the page shows (renderer/render.js renderOutline)
function chatEls(list, docId) {
  const msgs = list.filter((n) => n.chat), out = [];
  const lefts = new Set(msgs.filter((n) => !n.chat.mine).map((n) => n.chat.author)); // more than one: names over their runs
  msgs.forEach((n, i) => {
    const prev = msgs[i - 1];
    if (!n.chat.mine && lefts.size > 1 && (!prev || prev.chat.author !== n.chat.author)) {
      const name = document.createElement('div'); name.className = 'chat-name'; name.textContent = demoText(n.text, n.chat.author); out.push(name);
    }
    out.push(chatMessageEl(n, docId));
  });
  // Asked, and no answer has begun: dots where it will be, until one does or it has been two minutes
  const last = msgs.at(-1), asked = chatWaiting.get(docId);
  if (asked && (Date.now() - asked > CHAT_WAIT || (last && !last.chat.mine))) chatWaiting.delete(docId);
  else if (asked) { const wait = document.createElement('div'); wait.className = 'chat-msg theirs'; const b = document.createElement('div'); b.className = 'bubble'; b.append(chatDotsEl()); wait.append(b); out.push(wait); }
  return out;
}
// Before the page is redrawn: whether it should end at the bottom, which is where a chat opens and where it follows
// new messages for as long as you have not scrolled up to read.
function chatStick(parent) {
  const sc = outline.parentElement;
  return parent.docId !== chatShown || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
}
// After it is drawn: the composer shows under a chat and nowhere else, holding what was typed in each.
function chatAfterRender(parent, stick) {
  const chat = isChatPage(parent), docId = chat ? parent.docId : null, sc = outline.parentElement;
  if (composer.dataset.doc && composer.dataset.doc !== docId) { if (composerText.value.trim()) chatDrafts.set(composer.dataset.doc, composerText.value); else chatDrafts.delete(composer.dataset.doc); }
  const opened = chat && docId !== chatShown;
  if (composer.dataset.doc !== (docId || '')) composerText.value = (docId && chatDrafts.get(docId)) || '';
  composer.dataset.doc = docId || ''; composer.hidden = !chat;
  sc.classList.toggle('chatting', chat);
  chatShown = docId;
  if (!chat) return;
  if (stick) sc.scrollTop = sc.scrollHeight;
  if (opened) requestAnimationFrame(() => { if (palette.hidden && composer.dataset.doc === docId) composerText.focus({ preventScroll: true }); });
}
function chatSend() {
  const docId = composer.dataset.doc, text = composerText.value.trim();
  if (!docId || !text || !tana.sendChat) return;
  composerText.value = ''; chatDrafts.delete(docId);
  chatWaiting.set(docId, Date.now());
  run(async () => {
    try { const sent = await tana.sendChat(docId, text); if (!sent.responding) chatWaiting.delete(docId); }
    catch (e) { chatWaiting.delete(docId); if (!composerText.value && composer.dataset.doc === docId) composerText.value = text; throw e; } // the words come back to be sent again
    finally { await reload(docId); if (zoom && zoom.docId === docId) { outline.parentElement.scrollTop = outline.parentElement.scrollHeight; renderSoon(true); } }
  });
}
composerText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) { e.preventDefault(); chatSend(); return; }
  // the textarea's own keys stay its own: ⌘Z undoes typing here rather than the last change to a node; ⌘K and the rest go on
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || ['z', 'a', 'c', 'x', 'v', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace'].includes(e.key.length === 1 ? e.key.toLowerCase() : e.key)) e.stopPropagation();
  if (e.key === 'Escape') composerText.blur();
});
composerSend.onmousedown = (e) => e.preventDefault(); // the caret stays in the composer
composerSend.onclick = chatSend;
// ⌘K New chat: a chat with Tana, opened with the caret in its composer
function startNewChat() {
  return run(async () => { openResult(await tana.newChat()); });
}


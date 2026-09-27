'use strict';
// A chat drawn as a conversation, in the Codex app's style (docs/CHATS.md §8, §10): the rows main makes from
// data.messages (sdk/chat.js chatRows) become messages, oldest at the top: yours in a light blue bubble on the right,
// Tana's (and anyone else's) as plain text across the page, the thinking line in grey above it. Hovering a message shows
// when it was sent. Under the conversation sits the composer: Enter sends, Shift+Enter starts a new line, "@" links a
// node and "/" first runs a skill, and Tana's AI answers by itself where the chat lets it (main/documents.js sendChat).
// While it is thinking three dots stand where its answer will be; the answer streams in as live updates to the chat,
// each one read again like any change to an open page.
const composer = $('composer'), composerText = $('composerText'), composerSend = $('composerSend');
const CHAT_WAIT = 12e4; // how long the dots wait on an answer that has not started to arrive
let chatShown = null; // the chat drawn last: a chat opened anew goes to its end, and its composer takes the caret
const chatDrafts = new Map(); // docId -> what was typed there and not sent
// docId -> { asked, id }: a message that went out for Tana to answer, when, and its id once main has written it. Each
// send has its own, so the dots follow the newest one and only its own answer, one after that message, ends them.
const chatWaiting = new Map();
const isChatPage = (parent) => !!parent && !parent.nodeId && String(parent.docId).startsWith('tana:chat:');
// @Codex and any other agent on this device (main/chatagents.js, docs/CHATS.md §12): the agents "@" offers, and the
// questions asked in a chat with their answers, which live on this device only and never reach Tana. chatId -> [{ id,
// question, agent, label, at, state: working|done|failed, text }], read when the chat opens and while one runs.
let chatAgents = []; // [{ id, label, icon }] this device can run, from main once at load
if (tana.chatAgents) tana.chatAgents().then((list) => { chatAgents = list; }, () => {});
const agentAnswers = new Map(), agentPolls = new Map(); // agentPolls: docId -> read again once the read out now is back
const AGENT_URI = 'orbital:agent:'; // an "@" chip for an agent, written into the message as plain "@Label"
const AGENT_NOTE = 'Only visible for you, on this device. Never saved to Tana.';
const askedAgent = (text) => chatAgents.find((a) => new RegExp('(^|\\s)@' + a.label + '\\b', 'i').test(text));

function chatDotsEl() {
  const el = document.createElement('span'); el.className = 'chat-dots'; el.setAttribute('aria-label', 'Tana is writing');
  for (let i = 0; i < 3; i++) el.append(document.createElement('i'));
  return el;
}
// One line of a message: a markdown block (sdk/chat.js blocks), a card for an attachment or proposed document, and
// what a proposal or a question holds under it.
function chatPartEls(n, docId) {
  if (n.proposal) return [chatProposalEl(n)];
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
  if (c.id) selectable(el, c.id);
  bubble.className = 'bubble';
  if (c.sentAt) bubble.title = new Date(c.sentAt).toLocaleString();
  const subs = (n.children || []).filter((p) => p.sub); // a subagent's chat: under the thinking line, as in Tana
  for (const part of n.children || []) {
    if (part.sub) continue;
    if (part.thought) el.append(chatThoughtEl(part, subs, c.id, docId));
    else if (part.note) { const note = document.createElement('div'); note.className = 'chat-note'; renderSegs(note, part.segments || [], docId); el.append(note); } // an error: above the bubble
    else bubble.append(...chatPartEls(part, docId));
  }
  if (!bubble.childNodes.length && c.streaming) bubble.append(chatDotsEl());
  if (bubble.childNodes.length) el.append(bubble);
  return el;
}
// "Thought for 12 seconds": what Tana did while thinking (a subagent it asked) folds under it, closed until its chevron
// is pressed, and stays open across renders. With nothing under it, it is a line and has no chevron.
const chatThoughtsOpen = new Set(); // message ids
// What Tana's AI proposed in an answer, as a card in it: the proposed thing's glyph and name, what kind of proposal it is
// and where it stands, and while it waits the Proposals page's approve and reject (renderer/proposals.js). One Orbital
// cannot approve keeps its approve, disabled, with the reason (main/documents.js proposalCards). The answer is a write
// to this chat, whose live update draws the card again as approved or rejected.
const PROPOSAL_KIND = { action: 'Action', workspace: 'Space', instructions: 'Instructions' };
const PROPOSAL_STATE = { pending: 'awaiting your approval', approved: 'approved', rejected: 'rejected' };
function chatProposalEl(n) {
  const p = n.proposal, el = document.createElement('div'), mid = document.createElement('div'), title = document.createElement('div'), sub = document.createElement('div');
  el.className = 'chat-proposal ' + p.state;
  const kind = p.operation === 'update' ? 'Change' : p.operation === 'delete' ? 'Deletion' : PROPOSAL_KIND[p.metadata && p.metadata.type] || 'New document';
  title.className = 'chat-proposal-title'; title.textContent = demoText(p.title || 'Untitled', p.target);
  sub.className = 'chat-proposal-sub'; sub.textContent = kind + ' · ' + (PROPOSAL_STATE[p.state] || p.state);
  mid.className = 'chat-proposal-text'; mid.append(title, sub);
  el.append(addIcon(document.createElement('span'), (p.metadata && p.metadata.type === 'action' && 'sync') || p.icon || 'proposals'), mid); // an action is listed as a plain document: its own glyph
  if (p.state === 'pending') el.append(proposalButtonsEl(n, (node, approve) => answerChatProposal(node, approve, el))); // an action's approve reads "Send to Slite" (renderer/proposals.js)
  // the card opens what was proposed, as its link did: here, ⌘ in a pane beside, ⌥ as a tab (palette.js elsewhere)
  el.title = 'Open';
  el.onclick = (e) => {
    if (e.target.closest('.pbutton')) return;
    const where = elsewhere(e);
    if (where) run(() => openElsewhere(where, p.target)); else goTo(p.target);
  };
  return el;
}
function answerChatProposal(node, approve, el) {
  const p = node.proposal;
  if (!tana.proposalAnswer || (approve && !p.approvable)) return;
  const buttons = [...el.querySelectorAll('.pbutton')];
  buttons.forEach((b) => { b.disabled = true; }); // one answer; the chat's live update redraws the card as it now stands
  run(async () => {
    try {
      const warnings = await tana.proposalAnswer(p.chatUri, p.proposedUri, approve);
      if (warnings && warnings.length) showError(new Error(warnings.join('; ')));
    } catch (e) { buttons.forEach((b) => { b.disabled = b.classList.contains('approve') && !p.approvable; }); throw e; }
  });
}
function chatThoughtEl(part, subs, msgId, docId) {
  const el = document.createElement('div'), head = document.createElement(subs.length ? 'button' : 'div');
  el.className = 'chat-note chat-thought'; head.className = 'chat-thought-head';
  renderSegs(head, part.segments || [], docId);
  el.append(head);
  if (!subs.length) return el;
  const box = document.createElement('div'), open = chatThoughtsOpen.has(msgId);
  box.className = 'chat-sub'; box.hidden = !open;
  box.append(...subs.flatMap((s) => chatPartEls(s, docId)));
  head.type = 'button'; head.tabIndex = -1; head.setAttribute('aria-expanded', String(open));
  head.onclick = () => {
    const on = !chatThoughtsOpen.has(msgId);
    if (on) chatThoughtsOpen.add(msgId); else chatThoughtsOpen.delete(msgId);
    head.setAttribute('aria-expanded', String(on)); box.hidden = !on;
  };
  el.append(box);
  return el;
}
// The rows of an open chat, as the elements the page shows (renderer/render.js renderOutline)
let chatPendingQ = null; // the questions Tana waits on in the chat drawn last: its card replaces the composer
function chatEls(list, docId) {
  const rows = list.filter((n) => n.chat), msgs = rows.filter((n) => !n.chat.status), out = [];
  const lefts = new Set(msgs.filter((n) => !n.chat.mine).map((n) => n.chat.author)); // more than one: names over their runs
  let prev = null;
  // the questions asked of an agent on this device, and their answers, where they were asked among the messages
  const asks = [...(agentAnswers.get(docId) || [])].sort((a, b) => a.at - b.at);
  const asksUntil = (t) => { while (asks.length && !(asks[0].at > t)) { out.push(...agentAskEls(asks.shift(), docId)); prev = null; } };
  for (const n of rows) {
    if (n.chat.sentAt) asksUntil(n.chat.sentAt - 1);
    // a status line ("Sam was added to the chat.") stands on its own between the messages, as Tana shows it
    if (n.chat.status) { const line = document.createElement('div'); line.className = 'chat-status'; line.textContent = demoText(n.text, n.chat.author || docId); out.push(line); prev = null; continue; }
    if (!n.chat.mine && lefts.size > 1 && (!prev || prev.chat.author !== n.chat.author)) {
      const name = document.createElement('div'); name.className = 'chat-name'; name.textContent = demoText(n.text, n.chat.author); out.push(name);
    }
    out.push(chatMessageEl(n, docId));
    prev = n;
  }
  asksUntil(Infinity);
  chatPendingQ = ([...msgs].reverse().find((n) => n.chat.questions) || { chat: {} }).chat.questions || null;
  // Asked, and no answer has begun: dots where it will be, until one does or it has been two minutes
  // Only Tana's message after the one it was asked about ends the wait: not another person's (a group chat), and not
  // Tana's answer to an earlier message still arriving.
  const wait = chatWaiting.get(docId), at = wait && wait.id ? msgs.findIndex((n) => n.chat.id === wait.id) : -1;
  const answered = at >= 0 && msgs.slice(at + 1).some((n) => n.chat.author === 'ai');
  if (wait && (Date.now() - wait.asked > CHAT_WAIT || answered)) chatWaiting.delete(docId);
  else if (wait) { const wait = document.createElement('div'); wait.className = 'chat-msg theirs'; const b = document.createElement('div'); b.className = 'bubble'; b.append(chatDotsEl()); wait.append(b); out.push(wait); }
  return out;
}
// Before the page is redrawn: whether it should end at the bottom, which is where a chat opens and where it follows
// new messages for as long as you have not scrolled up to read.
function chatStick(parent) {
  const sc = outline.parentElement;
  return parent.docId !== chatShown || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
}
// A chat at its bottom stays there when its size changes under it: a part of a message landing late (a reference
// resolving, an image), or the palette lifting the page over the whole window (a "/" in the composer), which lays the
// conversation out again at another width and left it far above its end. Scrolled up to read, it stays where it is.
let chatAtBottom = false;
// A wrapped bubble is as wide as its longest line. A box whose text wraps takes all the width it may (its max-width),
// which left an empty strip down its right side, and no CSS shrinks it to its lines; so it is measured after layout,
// and again when the column's width changes. All reset, then all measured, then all set: three layouts, not one each.
function fitBubbles() {
  const bubbles = [...outline.querySelectorAll('.chat-msg.mine .bubble')];
  for (const b of bubbles) b.style.width = '';
  const widths = bubbles.map((b) => {
    // the words only: a range over the whole bubble also reports each paragraph's own box, the full width again
    const lines = [], walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT), range = document.createRange();
    for (let t = walk.nextNode(); t; t = walk.nextNode()) { range.selectNodeContents(t); lines.push(...range.getClientRects()); }
    const box = b.getBoundingClientRect(), cs = getComputedStyle(b);
    if (!lines.length) return '';
    const right = Math.max(...lines.map((r) => r.right)), left = box.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    return Math.ceil(right - left + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2 * parseFloat(cs.borderLeftWidth)) + 1 + 'px'; // +1: a sub-pixel short would wrap the last word
  });
  bubbles.forEach((b, i) => { b.style.width = widths[i]; });
}
if (typeof ResizeObserver === 'function' && outline.parentElement) {
  let width = 0;
  const sc = outline.parentElement, keep = () => {
    if (chatShown && sc.clientWidth !== width) { width = sc.clientWidth; fitBubbles(); } // the column's width changed: the lines did
    if (chatShown && chatAtBottom) sc.scrollTop = sc.scrollHeight;
  };
  sc.addEventListener('scroll', () => { if (chatShown) chatAtBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80; }, { passive: true });
  const seen = new ResizeObserver(keep); seen.observe(outline); seen.observe(sc);
}
// ---- the agents' questions and answers ----
// Two grey bubbles on your side, neither of them in Tana: the question, then under a line that says they are yours
// alone the dots while the task works and then its answer. The paperclip beside an answer puts it in the message box,
// to send as your own words.
function agentAskEls(a, docId) {
  const q = document.createElement('div'), qb = document.createElement('div');
  q.className = 'chat-msg mine agent-local'; qb.className = 'bubble'; qb.title = AGENT_NOTE;
  selectable(q, 'q:' + a.id);
  const words = document.createElement('div'); words.className = 'chat-paragraph'; words.textContent = demoText(a.question, docId);
  qb.append(words); q.append(qb);
  const el = document.createElement('div'), head = document.createElement('div'), row = document.createElement('div'), bubble = document.createElement('div');
  el.className = 'chat-msg mine agent-local answer'; head.className = 'agent-head'; row.className = 'agent-row'; bubble.className = 'bubble'; bubble.title = AGENT_NOTE;
  selectable(el, 'a:' + a.id);
  // the line over it opens the agent's task that answered, for the work behind the answer
  if (tana.openAgentAsk) { head.classList.add('opens'); head.title = 'Open the ' + a.label + ' task'; head.onclick = () => openAgentAsk(docId, a.id); }
  head.append(...[iconNode('lock')].filter(Boolean), document.createTextNode(a.label + ' · only visible for you, on this device'));
  if (a.state === 'working') bubble.append(chatDotsEl());
  else { const text = document.createElement('div'); text.className = 'chat-paragraph'; text.textContent = a.state === 'done' ? demoText(a.text, docId) : a.label + ' stopped without an answer'; bubble.append(text); }
  if (a.state === 'done') {
    const clip = document.createElement('button');
    clip.type = 'button'; clip.className = 'agent-clip'; clip.tabIndex = -1; clip.title = 'Add to your message'; clip.setAttribute('aria-label', 'Add to your message');
    clip.append(...[iconNode('paperclip')].filter(Boolean));
    clip.onclick = () => answerToComposer(docId, a.text);
    row.append(clip);
  }
  row.append(bubble); el.append(head, row);
  return [q, el];
}
// The one way an answer reaches Tana: added after whatever is in the message box, to be sent as your message (the
// paperclip, or Cmd+K Add …’s answer to message)
function answerToComposer(docId, text) {
  if (composer.dataset.doc !== docId || chatReadOnly.has(docId)) return;
  const had = composer.classList.contains('empty') ? [] : composerSegs();
  setComposer({ segs: [...had, ...(had.length ? [{ text: '\n' }] : []), { text }], skill: chatSkill });
  composerText.focus();
  const end = document.createRange(); end.selectNodeContents(composerText); end.collapse(false);
  getSelection().removeAllRanges(); getSelection().addRange(end);
}
const latestAgentAnswer = (docId) => (agentAnswers.get(docId) || []).filter((a) => a.state === 'done').at(-1);
const latestAgentAsk = (docId) => (agentAnswers.get(docId) || []).at(-1);

// ---- the messages, by keyboard ----
// ↑ at the start of the message box selects the last message; ↑↓ walk the messages, ↓ past the last one or Esc goes
// back to the box. The selected message is the one focused (data-key: Tana's message id, or q:/a: and an ask's id for
// the local ones), and it is what ⌘K's message rows act on: Delete message, and for an agent's answer Add to message
// (also Enter) and Open task. It is kept across a redraw, which replaces every message.
let chatSel = null;
const msgEl = (key) => (key ? outline.querySelector('.chat-msg[data-key="' + CSS.escape(key) + '"]') : null);
const chatMsgs = () => [...outline.querySelectorAll('.chat-msg[data-key]')];
const askOf = (docId, key) => (/^[qa]:/.test(key || '') ? (agentAnswers.get(docId) || []).find((a) => a.id === key.slice(2)) : null);
function chatFocus(key) {
  const el = msgEl(key);
  if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
  return !!el;
}
function toComposer() { chatSel = null; if (!composer.hidden) composerText.focus(); else document.activeElement.blur(); }
// Yours to delete: a local question or answer (both go), or your own message in the chat when you may write in it
function deletableMsg(docId, key) {
  const el = msgEl(key);
  if (!el || chatShown !== docId) return false;
  if (askOf(docId, key)) return !!tana.deleteAgentAsk;
  return el.classList.contains('mine') && !chatReadOnly.has(docId) && !!tana.deleteChatMessage;
}
function deleteChatMsg(docId, key) {
  if (!deletableMsg(docId, key)) return;
  const a = askOf(docId, key), gone = a ? ['q:' + a.id, 'a:' + a.id] : [key];
  const keys = chatMsgs().map((el) => el.dataset.key), at = keys.indexOf(gone[0]), rest = keys.filter((k) => !gone.includes(k));
  chatSel = keys.slice(0, at).filter((k) => !gone.includes(k)).at(-1) || rest[0] || null; // the one above takes the selection
  run(async () => {
    if (a) { await tana.deleteAgentAsk(docId, a.id); agentAnswers.set(docId, (agentAnswers.get(docId) || []).filter((x) => x.id !== a.id)); }
    else { await tana.deleteChatMessage(docId, key); await reload(docId); }
    renderSoon(true);
  });
}
// ⌘K's rows for the message selected, or with none the latest answer and ask (renderer/palette.js)
function chatMessageRows(docId) {
  const rows = [], sel = msgEl(chatSel) ? chatSel : null, picked = askOf(docId, sel);
  const answer = picked && picked.state === 'done' ? picked : latestAgentAnswer(docId), ask = picked || latestAgentAsk(docId);
  if (tana.askAgent && answer) rows.push({ id: 'agentAnswerToMessage', group: 'Actions', icon: 'paperclip', label: 'Add ' + answer.label + '’s answer to message', hint: 'To send as your own words', run: () => answerToComposer(docId, answer.text) });
  if (tana.openAgentAsk && ask) rows.push({ id: 'openAgentAsk', group: 'Actions', icon: 'robot', label: 'Open ' + ask.label + ' task', hint: picked ? 'The one behind this question' : 'The one behind the last @' + ask.label + ' answer', run: () => openAgentAsk(docId, ask.id) });
  if (sel && deletableMsg(docId, sel)) rows.push({ id: 'deleteMessage', group: 'Actions', icon: 'trash', label: 'Delete message', hint: picked ? 'The question and its answer, from this device' : 'From the chat, for everyone in it', kbd: '⇧⌘⌫', run: () => deleteChatMsg(docId, sel) });
  return rows;
}
// a message ↑↓ can land on, with its keys
function selectable(el, key) { el.dataset.key = key; el.tabIndex = -1; el.onfocus = () => { chatSel = key; }; el.onkeydown = chatKey; }
document.addEventListener('mousedown', (e) => { if (!(e.target.closest && e.target.closest('.chat-msg[data-key], #palette'))) chatSel = null; }, true);
function chatKey(e) {
  const m = e.currentTarget;
  if (!chatShown || e.target !== m) return;
  const mod = e.metaKey || e.ctrlKey, key = m.dataset.key, all = chatMsgs(), i = all.indexOf(m);
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod && !e.shiftKey && !e.altKey) {
    const next = all[i + (e.key === 'ArrowUp' ? -1 : 1)];
    if (next) chatFocus(next.dataset.key); else if (e.key === 'ArrowDown') toComposer();
  } else if (e.key === 'Escape') toComposer();
  else if (e.key === 'Enter' && !mod && askOf(chatShown, key) && key.startsWith('a:') && askOf(chatShown, key).state === 'done') answerToComposer(chatShown, askOf(chatShown, key).text);
  else if (e.key === 'Backspace' && mod && e.shiftKey && deletableMsg(chatShown, key)) deleteChatMsg(chatShown, key);
  else return;
  e.preventDefault(); e.stopPropagation();
}
function openAgentAsk(docId, id) { run(async () => { if (!(await tana.openAgentAsk(docId, id))) throw new Error('That task is not on this device'); }); }
// Read the chat's answers, and again every few seconds while one is still being worked on. Asked while a read is out
// (a question just asked), it reads once more when that one is back, which did not know the question yet.
function agentLoad(docId) {
  if (!tana.agentReplies) return;
  if (agentPolls.has(docId)) { agentPolls.set(docId, true); return; }
  agentPolls.set(docId, false);
  tana.agentReplies(docId).then((list) => {
    const again = agentPolls.get(docId);
    agentPolls.delete(docId);
    agentAnswers.set(docId, list);
    if (zoom && zoom.docId === docId) renderSoon(true);
    if (again) agentLoad(docId);
    else if (list.some((a) => a.state === 'working')) setTimeout(() => { if (chatShown === docId) agentLoad(docId); }, 4000);
  }, () => agentPolls.delete(docId));
}

// ---- the composer ----
// A small rich text field (index.html #composerText): typing is plain text, "@" puts a chip for a node in through the
// palette's link search (renderer/toolbar.js linkTo), and "/" as the first thing typed picks a skill for the message to
// run, shown as a pill in front. Sent, the chips become Tana's [label](tana:…) links and the skill rides along as the
// message's attachment, as Tana's own runSkill sends one (docs/CHATS.md §10).
const composerSkill = $('composerSkill');
// The mode the next message is sent in, per chat: true To Tana (it is asked to answer), false To the chat (a message for
// the people in it). It starts at what the chat does by itself (chat:answers: alone, Tana answers) and Tab in an empty
// message switches it; the empty message's placeholder says which it is. Remembered while the window is open.
const chatAi = new Map();
const chatReadOnly = new Set(); // chats you can read and not write in (chat:answers): their composer takes no typing
const chatAsking = new Set(); // chats whose chat:answers is out now (chatAfterRender)
let chatSkill = null; // { uri, label } the message being written runs
let composerAt = null; // where the caret was when "@" opened the search: the chip goes there
let skillList = null; // the workspace's skills for the "/" page, read when it opens
const composerSegs = () => readSegs(composerText);
function composerChanged() {
  const empty = !plainOf(composerSegs()).trim();
  if (empty && !composerText.querySelector('.mention') && composerText.childNodes.length) composerText.replaceChildren(); // :empty shows the placeholder again
  composer.classList.toggle('empty', empty && !chatSkill);
}
function showMode() {
  const docId = composer.dataset.doc, ai = chatAi.get(docId), readOnly = chatReadOnly.has(docId);
  composer.classList.toggle('readonly', readOnly);
  composerText.contentEditable = readOnly ? 'false' : 'plaintext-only';
  composerText.dataset.placeholder = readOnly ? 'You can read this chat but not write in it' : ai === false ? 'Message the chat · @ links · Tab: to Tana' : 'Ask Tana · @ links · / runs a skill' + (ai ? ' · Tab: to the chat' : '');
}
// A skill is for Tana to run, so while one is attached the message goes To Tana and the mode stays put
function switchMode(docId, ai = !chatAi.get(docId)) { if (chatSkill && !ai) return; chatAi.set(docId, ai); showMode(); }
function showSkill() {
  composerSkill.hidden = !chatSkill;
  composerSkill.replaceChildren(...(chatSkill ? [iconNode('skill'), document.createTextNode(demoText(chatSkill.label, chatSkill.uri))].filter(Boolean) : []));
  composerChanged();
}
function setComposer(draft) {
  renderSegs(composerText, (draft && draft.segs) || [], composer.dataset.doc);
  chatSkill = (draft && draft.skill) || null;
  showSkill();
}
// The message as Tana stores it: markdown, a mention as [label](uri), which is also how sdk/chat.js reads one back
const chatMarkdown = (segs) => segs.map((s) => ('mention' in s ? (String(s.mention.uri).startsWith(AGENT_URI) ? '@' + s.mention.label : '[' + String(s.mention.label).replace(/[[\]\n]/g, ' ') + '](' + s.mention.uri + ')') : s.text)).join('').replace(/\u00a0/g, ' ').trim();
// the text before the caret, to tell "/" typed first from one typed later
function beforeCaret() {
  const sel = getSelection();
  if (!sel.rangeCount || !composerText.contains(sel.anchorNode)) return '';
  const r = sel.getRangeAt(0).cloneRange(); r.setStart(composerText, 0);
  return r.toString();
}
function composerLink() {
  document.execCommand('insertText', false, '@'); // typed first, as in a row: a pick replaces it, Escape leaves it (toolbar.js)
  const sel = getSelection();
  composerAt = sel.rangeCount && composerText.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  if (composerAt && composerAt.endContainer.nodeType === 3 && composerAt.endOffset > 0) composerAt.setStart(composerAt.endContainer, composerAt.endOffset - 1); // the range holds the "@", for chatMention to write the chip over
  const box = composerAt && composerAt.getClientRects()[0];
  const rect = box ? { left: box.left, top: box.top, bottom: box.bottom } : composerText.getBoundingClientRect();
  togglePalette('search', { composer: true, text: '', rect });
}
// The node picked in the "@" search, as a chip where the caret was, with a space after it to type on from
function chatMention(mention) {
  const at = composerAt; composerAt = null;
  const tmp = document.createElement('span'); renderSegs(tmp, [{ mention }], composer.dataset.doc);
  const chip = tmp.querySelector('.mention'), space = document.createTextNode(' ');
  composerText.focus();
  const range = at && composerText.contains(at.startContainer) ? at : document.createRange();
  if (range !== at) { range.selectNodeContents(composerText); range.collapse(false); }
  range.deleteContents(); range.insertNode(space); range.insertNode(chip);
  range.setStartAfter(space); range.collapse(true);
  getSelection().removeAllRanges(); getSelection().addRange(range);
  composerChanged();
}
// Tana's own assistant (sdk/chat.js TANA_AGENT): mentioned, it answers in a chat with other people in it, where a
// message is otherwise only for them. Offered first in the composer's "@" search while what is typed fits its name.
const TANA_AGENT_URI = 'tana:agent:2zc7qjfkkengdhfdd846b4qvk2';
const tanaMentionRows = (q, ctx) => (fuzzyMatch('Tana', q.toLowerCase()) ? [{ icon: 'chat', label: 'Tana', hint: 'Ask Tana to answer', run: () => linkTo(ctx, { label: 'Tana', uri: TANA_AGENT_URI }) }] : []);
// and the agents on this device: their answer is shown to you alone and never written to Tana (main/chatagents.js)
const agentMentionRows = (q, ctx) => chatAgents.filter((a) => fuzzyMatch(a.label, q.toLowerCase())).map((a) => ({ icon: a.icon, label: a.label, hint: 'Ask ' + a.label + ' · the answer stays on this device', run: () => linkTo(ctx, { label: a.label, uri: AGENT_URI + a.id, icon: a.icon }) }));
// "/" first: the workspace's skills, in ⌘K's card; Escape goes back to the message with nothing picked
function openSkillPicker() {
  palReturn = { composer: true }; // Escape, or a pick, hands the caret back to the message (palette.js returnFocus)
  togglePalette('cmd');
  loadList('skills', () => tana.searchPreview({ types: ['skills'] }), (list) => { skillList = list; });
  openPage('skills', 'Choose a skill to run', { rows: (q) => listRows('Skills', skillList, q, 'No skills in this workspace',
    (list) => list.filter((n) => fuzzyMatch(n.text || n.title || '', q)).map((n) => ({ group: 'Skills', icon: 'skill', label: n.text || n.title || 'Untitled skill', run: () => pickSkill(n) }))) });
}
function pickSkill(n) {
  chatSkill = { uri: n.id, label: n.text || n.title || 'Skill' };
  switchMode(composer.dataset.doc, true); // a skill is for Tana to run
  showSkill();
  composerText.focus();
}
// A message that was not saved goes back where it was written, in front of anything written there since, whether its
// chat is still on screen (the composer) or not (its draft), so a failed send never loses words.
function restoreDraft(docId, draft) {
  const here = composer.dataset.doc === docId;
  const later = here ? (composer.classList.contains('empty') ? null : { segs: composerSegs(), skill: chatSkill }) : chatDrafts.get(docId);
  // the failed message keeps its own skill (a skill alone was its whole command); a different one written since stays in
  // the newer words as a chip, since a message runs one skill
  const laterSkill = later && later.skill && draft.skill && later.skill.uri !== draft.skill.uri ? [{ mention: { label: later.skill.label, uri: later.skill.uri, icon: 'skill' } }, { text: ' ' }] : [];
  const merged = later ? { segs: [...draft.segs, ...(draft.segs.length ? [{ text: '\n' }] : []), ...laterSkill, ...later.segs], skill: draft.skill || later.skill } : draft;
  if (here) setComposer(merged); else chatDrafts.set(docId, merged);
}
function chatSend() {
  const docId = composer.dataset.doc, draft = { segs: composerSegs(), skill: chatSkill }, skill = chatSkill;
  // a skill on its own asks for it to be run, the way Tana's runSkill words a message with no other words
  const text = chatMarkdown(draft.segs) || (skill ? 'Run [' + skill.label.replace(/[[\]\n]/g, ' ') + '](' + skill.uri + ')' : '');
  if (!docId || !text || !tana.sendChat) return;
  setComposer(null); chatDrafts.delete(docId);
  // @Codex and the like: the question goes to that agent on this device, and stays here with its answer; not to Tana
  const agent = !skill && tana.askAgent && askedAgent(text);
  if (agent) {
    run(async () => {
      try { await tana.askAgent(docId, agent.id, text); } catch (e) { restoreDraft(docId, draft); throw e; }
      agentLoad(docId);
      if (zoom && zoom.docId === docId) { outline.parentElement.scrollTop = outline.parentElement.scrollHeight; renderSoon(true); }
    });
    return;
  }
  const ai = skill ? true : chatAi.get(docId), wait = { asked: Date.now(), id: null };
  // a message to the chat asks nobody to answer, unless it mentions Tana (main asks then too, sdk/chat.js mentionsTana)
  if (ai !== false || text.includes('(' + TANA_AGENT_URI + ')') || /@polaris|@tana\b/i.test(text)) chatWaiting.set(docId, wait);
  // this send's own wait only: a newer message sent meanwhile has its own, which an earlier send settling must not clear
  const stopWaiting = () => { if (chatWaiting.get(docId) !== wait) return false; chatWaiting.delete(docId); return true; };
  // the dots give up after two minutes even when nothing else redraws the page
  setTimeout(() => { if (stopWaiting()) renderSoon(true); }, CHAT_WAIT);
  run(async () => {
    let sent;
    // only a message that was not saved comes back to be sent again
    try { sent = await tana.sendChat(docId, text, skill ? [skill.uri] : [], ai === undefined ? {} : { ai }); }
    catch (e) { stopWaiting(); restoreDraft(docId, draft); throw e; }
    if (!sent.responding) stopWaiting(); else wait.id = sent.messageId; // from here on its answer can be recognised
    await reload(docId);
    if (zoom && zoom.docId === docId) { outline.parentElement.scrollTop = outline.parentElement.scrollHeight; renderSoon(true); }
    // a reply that could not be asked for is said (run shows it), and the message stays sent: nothing is offered twice
    if (sent.replyError) throw new Error('Sent, but Tana was not asked to answer: ' + sent.replyError);
  });
}
composerText.addEventListener('keydown', (e) => {
  // Escape only leaves the composer: taken here, before any page or workspace key (events.js, stepOut in a zoomed pane) sees it
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); composerText.blur(); return; }
  const mod = e.metaKey || e.ctrlKey;
  // ↑ at the very start: up into the messages, the newest first (chatKey walks on from there)
  if (e.key === 'ArrowUp' && !mod && !e.shiftKey && !e.altKey && !beforeCaret() && chatMsgs().length) { e.preventDefault(); e.stopPropagation(); chatFocus(chatMsgs().at(-1).dataset.key); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) { e.preventDefault(); chatSend(); return; }
  if (e.key === 'Tab' && !e.shiftKey && !mod && chatAi.has(composer.dataset.doc) && !plainOf(composerSegs()).trim() && !composerText.querySelector('.mention')) { e.preventDefault(); switchMode(composer.dataset.doc); return; }
  if (e.key === '@' && !mod) { e.preventDefault(); composerLink(); return; }
  if (e.key === '/' && !mod && !chatSkill && !beforeCaret().trim() && tana.searchPreview) { e.preventDefault(); openSkillPicker(); return; }
  if (e.key === 'Backspace' && chatSkill && !beforeCaret()) { e.preventDefault(); chatSkill = null; showSkill(); return; }
  // the field's own keys stay its own: ⌘Z undoes typing here rather than the last change to a node; ⌘K and the rest go on
  if (!mod || ['z', 'a', 'c', 'x', 'v', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace'].includes(e.key.length === 1 ? e.key.toLowerCase() : e.key)) e.stopPropagation();
});
composerText.addEventListener('input', composerChanged);
// A pasted Tana node link becomes a chip for that node where the caret was, as it becomes a reference in a row
// (renderer/events.js paste, the same tanaNodeUri): the title is read first, so a link to something unreadable puts
// nothing in and says why. Anything else pastes as plain text.
composerText.addEventListener('paste', (e) => {
  const uri = e.clipboardData && tana.node && tanaNodeUri(e.clipboardData.getData('text/plain')), sel = getSelection();
  if (!uri || !sel.rangeCount || !composerText.contains(sel.anchorNode)) return;
  e.preventDefault();
  const at = sel.getRangeAt(0).cloneRange();
  tana.node(uri).then((n) => { composerAt = at; chatMention({ label: n.title || uri, uri }); }, showError);
});
composerText.addEventListener('focus', () => { chatSel = null; });
composerSkill.onclick = () => { chatSkill = null; showSkill(); composerText.focus(); };
composerSend.onmousedown = (e) => e.preventDefault(); // the caret stays in the composer
composerSend.onclick = chatSend;
// After the page is drawn: the composer shows under a chat and nowhere else, keeping what was written in each.
function chatAfterRender(parent, stick) {
  const chat = isChatPage(parent), docId = chat ? parent.docId : null, sc = outline.parentElement;
  const was = composer.dataset.doc;
  if (was && was !== docId) { if (!composer.classList.contains('empty')) chatDrafts.set(was, { segs: composerSegs(), skill: chatSkill }); else chatDrafts.delete(was); }
  const opened = chat && docId !== chatShown;
  if (opened) chatSel = null;
  if (was !== (docId || '')) {
    composer.dataset.doc = docId || ''; setComposer(docId && chatDrafts.get(docId)); showMode();
  }
  // Asked once there is a connection: a chat reopened at launch is drawn before there is one, and the render after it
  // comes up asks; a failed ask is asked again on the next render.
  if (docId && connected && !chatAi.has(docId) && !chatAsking.has(docId) && tana.chatAnswers) {
    chatAsking.add(docId);
    tana.chatAnswers(docId).then((r) => { if (!chatAi.has(docId)) chatAi.set(docId, !!r.ai); if (r.canWrite === false) chatReadOnly.add(docId); else chatReadOnly.delete(docId); if (composer.dataset.doc === docId) { showMode(); renderSoon(true); } }, () => {}) // renderSoon: waiting questions show once write access is known
      .finally(() => chatAsking.delete(docId));
  }
  const asking = chat && showQuestions(docId, chatPendingQ); // Tana's questions take the composer's place
  if (opened) agentLoad(docId);
  if (!chat) showQuestions(null, null);
  composer.hidden = !chat || !!asking;
  sc.classList.toggle('chatting', chat);
  chatShown = docId;
  if (!chat) return;
  fitBubbles(); // drawn anew each render, so fitted anew
  if (stick) { sc.scrollTop = sc.scrollHeight; chatAtBottom = true; }
  // the redraw replaced the message that was selected: select it again, unless focus has gone somewhere else meanwhile
  if (chatSel && palette.hidden && (document.activeElement === document.body || outline.contains(document.activeElement)) && document.activeElement.dataset.key !== chatSel) chatFocus(chatSel);
  if (opened || asking === 'new') requestAnimationFrame(() => { if (palette.hidden && composer.dataset.doc === docId) (asking ? qcard : composerText).focus({ preventScroll: true }); });
}
// Access can change while a chat is open (someone shares it with you, or takes it away): a change to its audience or
// participants (main's meta flag) asks again whether you may write, and leaves the mode you chose alone.
if (tana.onChanged && tana.chatAnswers) tana.onChanged((chatId, info) => {
  if (!chatId || !String(chatId).startsWith('tana:chat:') || !info || !info.meta || !chatAi.has(chatId)) return;
  tana.chatAnswers(chatId).then((r) => { if (r.canWrite === false) chatReadOnly.add(chatId); else chatReadOnly.delete(chatId); if (composer.dataset.doc === chatId) { showMode(); renderSoon(true); } }, () => {});
});
// ---- Tana's questions: the Codex question card, in the composer's place ----
// When Tana's AI asks (askUserQuestion, sdk/chat.js pendingQuestions), the chat's composer gives way to a card like
// Codex's: one question at a time with "‹ 2 of 3 ›", its options numbered, the last row a free answer ("No, and tell
// Tana what to do differently"), and Dismiss and Continue. ↑↓ move, 1–9 pick, Space ticks (Select all that apply),
// ↩ continues (picking the highlighted option when nothing is picked yet), ←→ step between questions, Esc dismisses,
// which tells Tana to go on with sensible defaults. The last Continue submits, and Tana carries on from the answers.
const qcard = $('chatQuestion');
let qs = null; // { docId, messageId, items, index, cursor, answers: { questionId: { selected: Set, custom } }, busy }
const qDrafts = new Map(); // messageId -> the card as it was left: picked options and typed words wait, as a draft does
const qEl = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const qAnswer = (q) => (qs.answers[q.id] ||= { selected: new Set(), custom: '' });
// true when a card is up for this chat; 'new' the first time these questions show, so the card takes the caret
// Only for a chat you may write in, known to be (chat:answers): a viewer keeps the read-only composer, which says why.
function showQuestions(docId, pending) {
  if (!pending || !chatAi.has(docId) || chatReadOnly.has(docId)) { if (qs) qDrafts.set(qs.messageId, qs); qs = null; qcard.hidden = true; return false; }
  const fresh = !qs || qs.docId !== docId || qs.messageId !== pending.messageId;
  if (fresh && qs) qDrafts.set(qs.messageId, qs);
  if (fresh) qs = { ...(qDrafts.get(pending.messageId) || { index: 0, cursor: 0, answers: {} }), docId, messageId: pending.messageId, items: pending.items, busy: false };
  // drawn anew only when it is new or was away: a live update redrawing it would take the caret out of the free answer
  if (fresh || qcard.hidden) drawQuestion();
  qcard.hidden = false;
  return fresh ? 'new' : true;
}
function drawQuestion() {
  const q = qs.items[qs.index], a = qAnswer(q), n = qs.items.length, last = qs.index === n - 1;
  const head = qEl('div', 'qhead'), title = qEl('div', 'qtext', demoText(q.question, qs.docId));
  title.id = 'qtext'; head.append(title);
  // for a screen reader: the options are radio buttons (or checkboxes) of the question, the highlighted one the active one
  qcard.setAttribute('role', q.multiSelect ? 'group' : 'radiogroup'); qcard.setAttribute('aria-labelledby', 'qtext');
  qcard.setAttribute('aria-activedescendant', qs.cursor < q.options.length ? 'qopt' + qs.cursor : '');
  if (n > 1) {
    const nav = qEl('div', 'qnav'), step = (label, d, off) => { const b = qEl('button', 'qstep', label); b.type = 'button'; b.tabIndex = -1; b.disabled = off; b.onmousedown = (e) => e.preventDefault(); b.onclick = () => stepQuestion(d); return b; };
    nav.append(step('‹', -1, qs.index === 0), qEl('span', '', (qs.index + 1) + ' of ' + n), step('›', 1, last)); head.append(nav);
  }
  const rows = q.options.map((o, i) => {
    const r = qEl('div', 'qopt' + (qs.cursor === i ? ' active' : '') + (a.selected.has(o.label) ? ' chosen' : ''));
    r.id = 'qopt' + i; r.setAttribute('role', q.multiSelect ? 'checkbox' : 'radio'); r.setAttribute('aria-checked', String(a.selected.has(o.label)));
    r.append(qEl('span', 'qnum', (i + 1) + '.'), qEl('span', 'qlabel', demoText(o.label, qs.docId)));
    if (o.description) r.append(qEl('span', 'qdesc', demoText(o.description, qs.docId)));
    if (q.multiSelect || a.selected.has(o.label)) r.append(qEl('span', 'qcheck', a.selected.has(o.label) ? '✓' : ''));
    if (qs.cursor === i) r.append(qEl('span', 'qarrows', '↑↓'));
    r.onmousedown = (e) => e.preventDefault();
    r.onclick = () => { qs.cursor = i; pickOption(i); };
    return r;
  });
  const foot = qEl('div', 'qfoot'), other = qEl('div', 'qopt qother' + (qs.cursor === q.options.length ? ' active' : ''));
  const input = qEl('input', 'qinput'); input.placeholder = 'No, and tell Tana what to do differently'; input.value = a.custom;
  input.oninput = () => { a.custom = input.value; if (!q.multiSelect && input.value.trim()) { a.selected.clear(); for (const r of qcard.querySelectorAll('.qopt.chosen')) r.classList.remove('chosen'); } };
  input.onfocus = () => { qs.cursor = q.options.length; for (const r of qcard.querySelectorAll('.qopt')) r.classList.toggle('active', r === other); };
  input.onkeydown = (e) => {
    e.stopPropagation(); // the field's own keys: nothing in the page or the card reads them
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); continueQuestion(); }
    else if (e.key === 'Escape') { e.preventDefault(); submitQuestions(true); } // Esc dismisses from here too, as the card says
    else if (e.key === 'ArrowUp' && !input.value) { e.preventDefault(); qs.cursor = Math.max(0, q.options.length - 1); drawQuestion(); qcard.focus(); }
  };
  other.append(qEl('span', 'qnum', (q.options.length + 1) + '.'), input);
  other.onclick = () => input.focus();
  const button = (cls, label, key, fn) => { const b = qEl('button', cls); b.type = 'button'; b.tabIndex = -1; b.disabled = qs.busy; b.append(label + ' ', qEl('kbd', '', key)); b.onmousedown = (e) => e.preventDefault(); b.onclick = fn; return b; };
  foot.append(other, button('qdismiss', 'Dismiss', 'esc', () => submitQuestions(true)), button('qcontinue', qs.busy ? 'Sending' : last ? 'Submit' : 'Continue', '↩', () => continueQuestion()));
  qcard.replaceChildren(head, ...(q.multiSelect ? [qEl('div', 'qhint', 'Select all that apply')] : []), ...rows, foot);
}
function pickOption(i) {
  const q = qs.items[qs.index], a = qAnswer(q), label = q.options[i] && q.options[i].label;
  if (label === undefined) return;
  if (q.multiSelect) { if (!a.selected.delete(label)) a.selected.add(label); drawQuestion(); return; }
  a.selected = new Set([label]); a.custom = '';
  continueQuestion(); // one answer to a single choice: on to the next, as Codex does
}
function stepQuestion(d) {
  const i = Math.min(qs.items.length - 1, Math.max(0, qs.index + d));
  if (i !== qs.index) { qs.index = i; qs.cursor = 0; drawQuestion(); qcard.focus(); }
}
function continueQuestion() {
  if (!qs || qs.busy) return;
  const q = qs.items[qs.index], a = qAnswer(q);
  if (!q.multiSelect && !a.selected.size && !a.custom.trim() && q.options[qs.cursor]) a.selected = new Set([q.options[qs.cursor].label]);
  if (qs.index < qs.items.length - 1) { qs.index++; qs.cursor = 0; drawQuestion(); qcard.focus(); return; }
  submitQuestions(false);
}
function submitQuestions(skip) {
  if (!qs || qs.busy || !tana.answerChat) return;
  const { docId, messageId } = qs;
  const answers = skip ? null : Object.fromEntries(Object.entries(qs.answers).map(([id, a]) => [id, { selected: [...a.selected], custom: a.custom.trim() }]));
  qs.busy = true; drawQuestion();
  const wait = { asked: Date.now(), id: messageId }; // Tana's next message after the one that asked ends the dots
  run(async () => {
    let sent;
    try { sent = await tana.answerChat(docId, messageId, answers); }
    catch (e) { if (qs && qs.messageId === messageId) { qs.busy = false; drawQuestion(); } throw e; }
    qDrafts.delete(messageId); // answered: nothing left to come back to
    if (sent.responding) {
      chatWaiting.set(docId, wait);
      // the dots give up after two minutes even when nothing else redraws the page, as a sent message's do
      setTimeout(() => { if (chatWaiting.get(docId) === wait) { chatWaiting.delete(docId); renderSoon(true); } }, CHAT_WAIT);
    }
    await reload(docId);
    if (zoom && zoom.docId === docId) renderSoon(true);
    if (sent.replyError) throw new Error('Answered, but Tana was not asked to go on: ' + sent.replyError);
  });
}
qcard.addEventListener('keydown', (e) => {
  if (!qs || e.target !== qcard || e.metaKey || e.ctrlKey || e.altKey) return; // ⌘K and the other combos go on to the page
  const q = qs.items[qs.index], count = q.options.length + 1, digit = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { qs.cursor = (qs.cursor + (e.key === 'ArrowDown' ? 1 : count - 1)) % count; drawQuestion(); if (qs.cursor === q.options.length) qcard.querySelector('.qinput').focus(); else qcard.focus(); }
  else if (digit >= 0 && digit < q.options.length) { qs.cursor = digit; pickOption(digit); }
  else if (digit === q.options.length) { qs.cursor = digit; drawQuestion(); qcard.querySelector('.qinput').focus(); }
  else if (e.key === ' ') { if (qs.cursor < q.options.length) pickOption(qs.cursor); }
  else if (e.key === 'Enter') { if (!q.multiSelect && qs.cursor < q.options.length && !qAnswer(q).selected.size) pickOption(qs.cursor); else continueQuestion(); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') stepQuestion(e.key === 'ArrowLeft' ? -1 : 1);
  else if (e.key === 'Escape') submitQuestions(true);
  else return;
  e.preventDefault(); e.stopPropagation();
});

// ---- inviting ----
// ⌘K Invite to chat…: a workspace member joins this chat as an editor (main/documents.js inviteToChat), and the chat
// says so. Once there are two of you Tana answers only when mentioned, so the composer moves to To the chat.
function openInvitePicker(docId) {
  loadMembers();
  openPage('invite', 'Invite someone to this chat', { back: BACK_TO_COMMANDS, rows: (q) => {
    loadMembers();
    if (!members) return [{ group: 'People', label: 'Loading…', disabled: true, note: true }];
    return members.filter((m) => !m.me && fuzzyMatch(memberName(m.id), q)).map((m) => ({ group: 'People', icon: 'member', label: memberName(m.id), run: () => inviteToChat(docId, m.id) }));
  } });
}
function inviteToChat(docId, uri) {
  run(async () => {
    const { name } = await tana.inviteToChat(docId, uri);
    showNote(name + ' can now read and write in this chat');
    await reload(docId);
    if (zoom && zoom.docId === docId) renderSoon(true);
    if (tana.chatAnswers) { const r = await tana.chatAnswers(docId); chatAi.set(docId, !!r.ai); if (composer.dataset.doc === docId) showMode(); }
  });
}
// ⌘K New chat: a chat with Tana, opened with the caret in its composer
function startNewChat() {
  return run(async () => { openResult(await tana.newChat()); });
}

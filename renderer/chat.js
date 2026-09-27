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

// ---- the composer ----
// A small rich text field (index.html #composerText): typing is plain text, "@" puts a chip for a node in through the
// palette's link search (renderer/toolbar.js linkTo), and "/" as the first thing typed picks a skill for the message to
// run, shown as a pill in front. Sent, the chips become Tana's [label](tana:…) links and the skill rides along as the
// message's attachment, as Tana's own runSkill sends one (docs/CHATS.md §10).
const composerSkill = $('composerSkill'), composerMode = $('composerMode');
// The mode the next message is sent in, per chat: true To Tana (it is asked to answer), false To the chat (a message for
// the people in it). It starts at what the chat does by itself (chat:answers: alone, Tana answers) and Tab in an empty
// message, or a click on the label, switches it. Remembered while the window is open.
const chatAi = new Map();
const chatReadOnly = new Set(); // chats you can read and not write in (chat:answers): their composer takes no typing
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
  composerMode.hidden = ai === undefined || readOnly;
  composerMode.classList.toggle('ai', !!ai);
  composerMode.replaceChildren(...[iconNode(ai ? 'chat' : 'member')].filter(Boolean), document.createTextNode(ai ? 'To Tana' : 'To the chat'));
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
const chatMarkdown = (segs) => segs.map((s) => ('mention' in s ? '[' + String(s.mention.label).replace(/[[\]\n]/g, ' ') + '](' + s.mention.uri + ')' : s.text)).join('').replace(/\u00a0/g, ' ').trim();
// the text before the caret, to tell "/" typed first from one typed later
function beforeCaret() {
  const sel = getSelection();
  if (!sel.rangeCount || !composerText.contains(sel.anchorNode)) return '';
  const r = sel.getRangeAt(0).cloneRange(); r.setStart(composerText, 0);
  return r.toString();
}
function composerLink() {
  const sel = getSelection();
  composerAt = sel.rangeCount && composerText.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
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
// "/" first: the workspace's skills, in ⌘K's card; Escape goes back to the message with nothing picked
function openSkillPicker() {
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
  const merged = later ? { segs: [...draft.segs, { text: '\n' }, ...later.segs], skill: later.skill || draft.skill } : draft;
  if (here) setComposer(merged); else chatDrafts.set(docId, merged);
}
function chatSend() {
  const docId = composer.dataset.doc, draft = { segs: composerSegs(), skill: chatSkill }, skill = chatSkill;
  // a skill on its own asks for it to be run, the way Tana's runSkill words a message with no other words
  const text = chatMarkdown(draft.segs) || (skill ? 'Run [' + skill.label.replace(/[[\]\n]/g, ' ') + '](' + skill.uri + ')' : '');
  if (!docId || !text || !tana.sendChat) return;
  setComposer(null); chatDrafts.delete(docId);
  const ai = skill ? true : chatAi.get(docId), asked = Date.now();
  if (ai !== false) chatWaiting.set(docId, asked); // a message to the chat asks nobody to answer
  // the dots give up after two minutes even when nothing else redraws the page
  setTimeout(() => { if (chatWaiting.get(docId) === asked) { chatWaiting.delete(docId); renderSoon(true); } }, CHAT_WAIT);
  run(async () => {
    let sent;
    // only a message that was not saved comes back to be sent again
    try { sent = await tana.sendChat(docId, text, skill ? [skill.uri] : [], ai === undefined ? {} : { ai }); }
    catch (e) { chatWaiting.delete(docId); restoreDraft(docId, draft); throw e; }
    if (!sent.responding) chatWaiting.delete(docId);
    await reload(docId);
    if (zoom && zoom.docId === docId) { outline.parentElement.scrollTop = outline.parentElement.scrollHeight; renderSoon(true); }
    // a reply that could not be asked for is said (run shows it), and the message stays sent: nothing is offered twice
    if (sent.replyError) throw new Error('Sent, but Tana was not asked to answer: ' + sent.replyError);
  });
}
composerText.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) { e.preventDefault(); chatSend(); return; }
  if (e.key === 'Tab' && !e.shiftKey && !mod && chatAi.has(composer.dataset.doc) && !plainOf(composerSegs()).trim() && !composerText.querySelector('.mention')) { e.preventDefault(); switchMode(composer.dataset.doc); return; }
  if (e.key === '@' && !mod) { e.preventDefault(); composerLink(); return; }
  if (e.key === '/' && !mod && !chatSkill && !beforeCaret().trim() && tana.searchPreview) { e.preventDefault(); openSkillPicker(); return; }
  if (e.key === 'Backspace' && chatSkill && !beforeCaret()) { e.preventDefault(); chatSkill = null; showSkill(); return; }
  // the field's own keys stay its own: ⌘Z undoes typing here rather than the last change to a node; ⌘K and the rest go on
  if (!mod || ['z', 'a', 'c', 'x', 'v', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace'].includes(e.key.length === 1 ? e.key.toLowerCase() : e.key)) e.stopPropagation();
  if (e.key === 'Escape') composerText.blur();
});
composerText.addEventListener('input', composerChanged);
composerSkill.onclick = () => { chatSkill = null; showSkill(); composerText.focus(); };
composerMode.onmousedown = (e) => e.preventDefault(); // the caret stays in the composer
composerMode.onclick = () => switchMode(composer.dataset.doc);
composerSend.onmousedown = (e) => e.preventDefault(); // the caret stays in the composer
composerSend.onclick = chatSend;
// After the page is drawn: the composer shows under a chat and nowhere else, keeping what was written in each.
function chatAfterRender(parent, stick) {
  const chat = isChatPage(parent), docId = chat ? parent.docId : null, sc = outline.parentElement;
  const was = composer.dataset.doc;
  if (was && was !== docId) { if (!composer.classList.contains('empty')) chatDrafts.set(was, { segs: composerSegs(), skill: chatSkill }); else chatDrafts.delete(was); }
  const opened = chat && docId !== chatShown;
  if (was !== (docId || '')) {
    composer.dataset.doc = docId || ''; setComposer(docId && chatDrafts.get(docId)); showMode();
    if (docId && !chatAi.has(docId) && tana.chatAnswers) tana.chatAnswers(docId).then((r) => { if (!chatAi.has(docId)) chatAi.set(docId, !!r.ai); if (r.canWrite === false) chatReadOnly.add(docId); else chatReadOnly.delete(docId); if (composer.dataset.doc === docId) showMode(); }, () => {});
  }
  composer.hidden = !chat;
  sc.classList.toggle('chatting', chat);
  chatShown = docId;
  if (!chat) return;
  if (stick) sc.scrollTop = sc.scrollHeight;
  if (opened) requestAnimationFrame(() => { if (palette.hidden && composer.dataset.doc === docId) composerText.focus({ preventScroll: true }); });
}
// ⌘K New chat: a chat with Tana, opened with the caret in its composer
function startNewChat() {
  return run(async () => { openResult(await tana.newChat()); });
}

'use strict';
// A chat document has no content outline: its conversation is data.messages (docs/CHATS.md). This turns that list
// into ordinary read-only outline rows in the vocabulary the renderer already knows (docs/OUTLINER.md §3):
// one author row per message, its markdown blocks as children, mentions as segments, attachments/proposals as
// reference rows. Pure and Electron-free so scripts/sdk-check.js can run it offline.
// Sending (addMessage, triggerReply) is the write half: a message appended the way Tana's addHumanMessageWithTimeContext
// does, then Tana's AI asked to answer it, as its chat panel does (bundle of 2026-09-27, docs/CHATS.md §10).
const crypto = require('crypto');
const { LoroMap, LoroList, LoroText } = require('loro-crdt');
const { newId } = require('./content');

// Inline markdown of one line: a [label](uri) mention or link, **bold**, `code`, *italic*, ~~strike~~. The text is
// plain markdown source (no Loro marks at all), so this regex is the whole inline story.
// A date is mentioned the same way, [Sep 30, 2026](tana:plaindate:2026-09-30) (sdk/dates.js).
const INLINE = /\[([^\]\n]*)\]\((tana:[a-z-]+:[0-9a-z]{26}|tana:plaindate:[\d-]{10}|tana:zoneddate:[\dT:-]+\[[A-Za-z_/]+\]|https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`|\*([^*\s][^*\n]*)\*|~~([^~\n]+)~~/g;

function segments(text) {
  const out = [];
  const push = (t, marks) => { if (t) out.push(marks ? { text: t, marks } : { text: t }); };
  let at = 0;
  for (const m of String(text).matchAll(INLINE)) {
    push(String(text).slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) m[2].startsWith('tana:') ? out.push({ mention: { label: m[1], uri: m[2] } }) : push(m[1] || m[2], { link: m[2] });
    else if (m[3] !== undefined) push(m[3], { bold: true });
    else if (m[4] !== undefined) push(m[4], { code: true });
    else if (m[5] !== undefined) push(m[5], { italic: true });
    else push(m[6], { strike: true });
  }
  push(String(text).slice(at));
  return out;
}
const plain = (segs) => segs.map((s) => ('mention' in s ? s.mention.label : s.text)).join('');

// Markdown source -> outline blocks. Headings, bullets/numbered items, quotes, fenced code and dividers are the
// block types the outliner already has; consecutive plain lines are one paragraph.
// ponytail: indentation is dropped, so nested bullets flatten to one level; build a tree here if it ever matters.
function blocks(text) {
  const out = [];
  let para = null, code = null;
  const flush = () => { if (para) out.push({ block: 'paragraph', text: para.join('\n') }); para = null; };
  for (const line of String(text || '').split('\n')) {
    if (code) { if (/^\s*```/.test(line)) { out.push({ block: 'code', text: code.join('\n'), verbatim: true }); code = null; } else code.push(line); continue; }
    if (/^\s*```/.test(line)) { flush(); code = []; continue; }
    const t = line.trim();
    if (!t) { flush(); continue; }
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(t)) { flush(); out.push({ block: 'divider', text: '' }); continue; }
    const heading = t.match(/^(#{1,6})\s+(.*)$/); // the outliner draws three levels; deeper ones read as the third
    if (heading) { const level = Math.min(heading[1].length, 3); flush(); out.push({ block: 'heading' + level, heading: level, text: heading[2] }); continue; }
    const item = t.match(/^(?:([-*+])|\d+[.)])\s+(.*)$/);
    if (item) { flush(); out.push({ block: item[1] ? 'bullet' : 'numbered', text: item[2] }); continue; }
    const quote = t.match(/^>\s?(.*)$/);
    if (quote) { flush(); out.push({ block: 'quote', text: quote[1] }); continue; }
    (para ||= []).push(t);
  }
  flush();
  if (code) out.push({ block: 'code', text: code.join('\n'), verbatim: true });
  return out;
}

// Every chat row is read-only: the app shows a conversation, it never edits or deletes a message.
// text is the plain rendering of the segments, so the markdown source never leaks into filtering or copy.
const row = (id, source, extra) => {
  const segs = (extra && extra.segments) || segments(source);
  return { id, text: plain(segs), kind: 'block', editable: false, segments: segs, hasChildren: false, children: [], ...extra };
};
const reference = (id, uri, label) => ({ id, text: label || uri, kind: 'block', type: 'reference', editable: false, segments: [], reference: label ? { uri, label } : { uri }, hasChildren: false, children: [] });
const hm = (ms) => { const d = new Date(ms); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); };
// the web client's label, word for word: completedAt - sentAt, not usage.durationMs (docs/CHATS.md §4)
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
const took = (ms) => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return s < 60 ? plural(s, 'second') : s % 60 ? m + 'm ' + (s % 60) + 's' : plural(m, 'minute'); };
// Tana's progress line exists only for a message that called tools: "Thought for …" once the message stopped streaming
// and every call has finished (the web client's own test, docs/CHATS.md §4), "Finished thinking" when there is no
// duration to show, "Thinking..." until then.
// ponytail: a call still running reads "Thinking..." where Tana names the tool's own in-progress label.
const thinking = (m, calls, streaming) => (calls.some((c) => c && c.status === 'awaiting_user_input') ? 'Waiting for your input' : streaming || calls.some((c) => c && c.status === 'running') ? 'Thinking...' : m.completedAt > m.sentAt ? 'Thought for ' + took(m.completedAt - m.sentAt) : 'Finished thinking');
// "accepted N changes" is the one status update the web client shows in a conversation.
const accepted = (m) => !!m.isStatusUpdate && String((m.content && m.content.text) || '').startsWith('accepted ');
const list = (v) => (Array.isArray(v) ? v : []);
const MESSAGE_STATUS = { cancelled: 'Cancelled', error: 'Error', limit_exceeded: 'Limit exceeded' };

// messages: data.messages as plain JSON, in list order (never sorted by sentAt: the preamble shares its millisecond
// with the first user message). authorName(uri) -> display name, aiName: what to call the assistant, me: your
// profile uri, streamingId: data.streamingMessageId. Each message row carries row.chat for the bubbles the renderer
// draws (renderer/chat.js): whose it is, when it was sent, and whether Tana is still writing it.
function chatRows(messages, { authorName = () => undefined, aiName = 'Tana AI', me, streamingId } = {}) {
  const rows = [];
  list(messages).forEach((m, i) => {
    // What the web client's chat panel hides (its br): the synthetic preamble (hiddenFromChat), injected 'context', and
    // a human message relayed for an AI interview, which is how an answer to Tana's questions reaches it.
    if (!m || m.hiddenFromChat || m.type === 'context') return;
    if (m.fromUserType === 'human' && m.isAIInterviewRelay) return;
    // Any other status update ("Sam was added to the chat.", the multiple-participants notice) is one line of its own
    if (m.isStatusUpdate && !accepted(m)) {
      const line = String((m.content && m.content.text) || '').trim();
      if (line) rows.push(row('m' + i, line, { chat: { id: m.id, status: true, author: m.fromUserUri || '', sentAt: typeof m.sentAt === 'number' ? m.sentAt : undefined } }));
      return;
    }
    const ai = m.fromUserType === 'ai', id = 'm' + i, children = [], streaming = !!m.id && m.id === streamingId;
    // keep/person mark the app's own words and a name for demo mode (renderer/segments.js); the conversation is content
    // thinking: still at work, so the line shimmers until it says what it thought (renderer/chat.js chatThoughtEl)
    if (list(m.toolCalls).length) { const line = thinking(m, list(m.toolCalls), streaming); children.push(row(id + '.t', line, { note: true, thought: true, ...(line === 'Thinking...' ? { thinking: true } : {}), segments: [{ text: line, keep: true }] })); }
    const status = Object.hasOwn(MESSAGE_STATUS, m.status) ? MESSAGE_STATUS[m.status] : undefined;
    if (status) {
      const error = typeof m.errorMessage === 'string' && m.errorMessage.trim() ? ': ' + m.errorMessage : '';
      children.push(row(id + '.status', status + error, { note: true, segments: [{ text: status, keep: true }, ...(error ? [{ text: error }] : [])] }));
    }
    for (const [j, b] of blocks(m.content && m.content.text).entries()) {
      // code keeps its markdown characters; every other block renders its inline markdown as segments
      children.push(row(id + '.b' + j, b.text, { block: b.block, ...(b.heading ? { heading: b.heading } : {}), ...(b.verbatim ? { segments: b.text ? [{ text: b.text }] : [] } : {}) }));
    }
    for (const [j, uri] of list(m.attachmentUris).entries()) children.push(reference(id + '.a' + j, uri));
    for (const [j, p] of list(m.proposals).entries()) {
      if (!p || typeof p.proposedUri !== 'string') continue;
      const state = p.approvedAt ? 'approved' : p.rejectedAt ? 'rejected' : 'pending';
      const target = p.operation === 'update' && typeof p.baseUri === 'string' ? p.baseUri : p.proposedUri;
      // a card in the answer (renderer/chat.js): main adds what it is called and whether Orbital may approve it
      // (main/documents.js chatOutline); operation and metadata are what sdk/proposals.js refusal reads
      const label = (p.operation || 'change') + ' · ' + state;
      children.push(row(id + '.p' + j, label, { segments: [{ text: label, keep: true }],
        proposal: { proposedUri: p.proposedUri, target, operation: p.operation || 'create', metadata: p.metadata || {}, state } }));
    }
    // Tana's questions (askUserQuestion) waiting on an answer: handed to the renderer as row.chat.questions, which draws
    // them as the question card in the composer's place (renderer/chat.js) and answers them through answerQuestions
    const questions = pendingQuestions(m);
    for (const [j, call] of list(m.toolCalls).entries()) {
      // sub: drawn under the thinking line, folded as Tana folds it, not with the answer (renderer/chat.js)
      if (call && typeof call.subagentChatUri === 'string') children.push({ ...reference(id + '.s' + j, call.subagentChatUri, call.name), sub: true });
    }
    const author = ai ? aiName : authorName(m.fromUserUri) || 'Someone';
    rows.push(row(id, author, {
      segments: [ai ? { text: author, keep: true } : { text: author, person: true }],
      icon: ai ? 'chat' : 'member', block: 'heading3', heading: 3,
      meta: typeof m.sentAt === 'number' ? hm(m.sentAt) + (m.editedAt !== undefined ? ' (edited)' : '') : undefined,
      chat: { id: m.id, mine: !ai && !!me && m.fromUserUri === me, author: m.fromUserUri || (ai ? 'ai' : ''), sentAt: typeof m.sentAt === 'number' ? m.sentAt : undefined,
        ...(streaming ? { streaming: true } : {}), ...(questions ? { questions } : {}) },
      hasChildren: children.length > 0, children,
    }));
  });
  return rows;
}

// ---- Tana's questions (askUserQuestion) ----
// Its questionsData (docs/CHATS.md §2, §11): { questions: [{ id, question, multiSelect, options: [{ label, description }],
// selectedOptions, customAnswer: LoroText }], answered, skipped, answeredAt, answeredByUri }. Pending while the
// askUserQuestion call waits and nobody has answered or skipped.
function pendingQuestions(m) {
  const waiting = list(m.toolCalls).some((call) => call && call.name === 'askUserQuestion' && call.status === 'awaiting_user_input');
  if (!waiting || !m.questionsData || m.questionsData.answered || m.questionsData.skipped) return null;
  const items = list(m.questionsData.questions).filter((q) => q && typeof q.question === 'string' && typeof q.id === 'string').map((q) => ({
    id: q.id, question: q.question, multiSelect: !!q.multiSelect,
    options: list(q.options).filter((o) => o && typeof o.label === 'string').map((o) => ({ label: o.label, ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}) })),
  }));
  return items.length ? { messageId: m.id, items } : null;
}
// What Tana tells its AI about the answers (its kxt, word for word): the tool call's output and the relay message.
const CUSTOM = '__custom__'; // Tana's marker in selectedOptions for the free-text answer
const oneLine = (s) => String(s).replace(/\s*\r?\n\s*/g, ' ').trim();
function answerSummary(data) {
  if (data.skipped) return '[User skipped AI questions]\nPlease continue with sensible defaults and note assumptions briefly.';
  const out = ['[User answered AI questions]'];
  for (const [n, q] of list(data.questions).entries()) {
    const picked = list(q.selectedOptions).filter((o) => o !== CUSTOM).map(oneLine).filter(Boolean);
    const lines = String(q.question || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const title = lines.length ? lines[0] + (lines.length > 1 ? ' […]' : '') : 'Q' + (n + 1);
    const custom = typeof q.customAnswer === 'string' && q.customAnswer.trim() ? oneLine(q.customAnswer) : '';
    out.push('- ' + title + ': ' + (custom ? (picked.length ? picked.join(', ') + '; Custom: ' + custom : 'Custom: ' + custom) : picked.length ? picked.join(', ') : '(no selection)'));
  }
  return out.join('\n');
}
// Answer (or skip, answers null) the questions on message messageId as Tana's handleQuestionsSubmit does: the choices
// and free text into each question, the set marked answered or skipped by you, the waiting askUserQuestion call
// completed with the summary, and a hidden relay message carrying it, whose id is what Tana is then asked to answer.
// answers: { [questionId]: { selected: [label], custom: string } }. Returns the relay message id.
function answerQuestions(loro, { messageId, answers, byUri, now = Date.now() }) {
  if (!/^tana:user-profile:/.test(byUri || '')) throw new Error('An answer needs who gives it');
  const messages = loro.getMap('data').get('messages');
  let m = null;
  for (let i = 0; messages instanceof LoroList && i < messages.length; i++) { const x = messages.get(i); if (x instanceof LoroMap && x.get('id') === messageId) m = x; }
  const json = m && m.toJSON();
  if (!json || !pendingQuestions(json)) throw new Error('These questions are no longer waiting for an answer');
  const qd = m.get('questionsData'), qs = qd.get('questions');
  if (answers) {
    for (let i = 0; i < qs.length; i++) {
      const q = qs.get(i); if (!(q instanceof LoroMap)) continue;
      const a = answers[q.get('id')] || {}, labels = new Set(list(q.toJSON().options).map((o) => o && o.label));
      const custom = typeof a.custom === 'string' ? a.custom.trim() : '';
      const picked = list(a.selected).filter((l) => labels.has(l));
      const chosen = q.get('multiSelect') ? picked : picked.slice(0, custom ? 0 : 1);
      const sel = q.setContainer('selectedOptions', new LoroList());
      for (const l of [...chosen, ...(custom ? [CUSTOM] : [])]) sel.push(l);
      q.setContainer('customAnswer', new LoroText()).insert(0, custom);
    }
  }
  qd.set('answered', !!answers); qd.set('skipped', !answers); qd.set('answeredAt', now); qd.set('answeredByUri', byUri);
  const summary = answerSummary(qd.toJSON());
  const calls = m.get('toolCalls');
  for (let i = 0; calls instanceof LoroList && i < calls.length; i++) {
    const c = calls.get(i);
    if (c instanceof LoroMap && c.get('name') === 'askUserQuestion' && c.get('status') === 'awaiting_user_input') { c.set('output', summary); c.set('status', 'completed'); c.set('completedAt', now); }
  }
  return pushMessage(loro, { sentAt: now, fromUserUri: byUri, fromUserType: 'human', isAIInterviewRelay: true, excludeFromAIContext: true }, summary);
}

// ---- sending ----
// One message map as Tana's lh() writes it: every list and the zeroed usage present, undefined fields left out.
function pushMessage(loro, fields, text, attachments = []) {
  const data = loro.getMap('data');
  const messages = data.get('messages') instanceof LoroList ? data.get('messages') : data.setContainer('messages', new LoroList());
  const m = messages.insertContainer(messages.length, new LoroMap());
  for (const [k, v] of Object.entries({ type: 'message', id: newId(), ...fields })) if (v !== undefined) m.set(k, v);
  m.setContainer('content', new LoroMap()).setContainer('text', new LoroText()).insert(0, text);
  const list = m.setContainer('attachmentUris', new LoroList());
  for (const uri of attachments) list.push(uri);
  m.setContainer('proposals', new LoroList());
  m.setContainer('toolCalls', new LoroList());
  const usage = m.setContainer('usage', new LoroMap());
  for (const [k, v] of Object.entries({ promptTokens: 0, completionTokens: 0, totalTokens: 0, model: '', cost: 0 })) usage.set(k, v);
  return m.get('id');
}
// "Robin Vega — it is now Sunday, September 27, 2026 at 11:52 AM (Europe/Amsterdam)." Tana's Exe, word for word
const nowLine = (name, now, timezone) => name + ' — it is now ' + new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(now)) + ' (' + timezone + ').';
// A human message. The first one of a day (in the sender's zone) is preceded by the hidden line that tells the AI who
// is speaking and when, recorded in participantTimeContext so the next message that day goes without. Returns its id.
function addMessage(loro, { text, byUri, senderName, attachments = [], skipAutoResponse, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', now = Date.now() }) {
  if (!/^tana:user-profile:/.test(byUri || '')) throw new Error('A message needs its sender');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to send');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const times = loro.getMap('participantTimeContext'), mine = times.get(byUri);
  const known = mine instanceof LoroMap ? mine.toJSON() : mine && typeof mine === 'object' ? mine : {};
  if (known.timezone !== timezone || known.lastLocalDate !== day) {
    pushMessage(loro, { sentAt: now, fromUserType: 'human', isStatusUpdate: true, hiddenFromChat: true }, nowLine(senderName || 'Someone', now, timezone));
    const entry = times.setContainer(byUri, new LoroMap());
    entry.set('timezone', timezone); entry.set('lastLocalDate', day);
  }
  // skipAutoResponse: a message meant for the people in the chat, which no client asks Tana to answer (Tana's own flag)
  return pushMessage(loro, { sentAt: now, fromUserUri: byUri, fromUserType: 'human', ...(skipAutoResponse ? { skipAutoResponse: true } : {}) }, text, attachments);
}
// Whether Tana's AI answers a message in this chat (its VKt, and its v$ for a mention): by itself only while you are
// alone in it and it is not switched off; with others in the chat, or switched off, when the message mentions Tana:
// a link to its own agent, [Tana](tana:agent:…), which the composer's "@" inserts, or "@Tana" / "@polaris" typed out.
const mentionsTana = (text) => String(text).includes('(' + TANA_AGENT + ')') || /@polaris|@tana\b/i.test(text);
function autoResponds(data, text = '') {
  const people = Object.keys((data && data.participants) || {});
  const n = people.length || list(data && data.participantUris).length;
  if (mentionsTana(text)) return true;
  return data.aiAutoResponds === false ? false : data.aiAutoResponds === true ? n < 2 : n === 1;
}
// Tana's createDeterministicId: the first 16 bytes of a name's sha256 as a 26-character ULID (6, 5 and 5 bytes).
const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
function deterministicId(name) {
  const b = crypto.createHash('sha256').update(name).digest();
  const part = (from, bytes, chars) => { let n = 0n; for (let i = from; i < from + bytes; i++) n = n * 256n + BigInt(b[i]); let s = ''; for (let i = chars - 1; i >= 0; i--) s += B32[Number((n >> BigInt(i * 5)) & 31n)]; return s; };
  return part(0, 6, 10) + part(6, 5, 8) + part(11, 5, 8);
}
const TANA_AGENT = 'tana:agent:' + deterministicId('system:tana'); // Tana's own assistant (its xm), what a plain chat talks to
// Ask Tana's AI to answer: POST <POLARIS_SERVICE_API_AI_URL>/chat/trigger with the bearer token, the web client's wJ.
// The server answers 404 or 408 while the chat has not reached it yet, which Tana retries three times, 2 s, 4 s, 8 s.
// The reply itself arrives as live updates to the chat document (data.streamingMessageId, then the AI message).
async function triggerReply({ chatUri, messageId, ownerUri, agentId = TANA_AGENT, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  getAccessToken, baseUrl = 'https://home.tana.inc/api/ai', fetch = globalThis.fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const body = JSON.stringify({ chatUri, ...(ownerUri ? { ownerUri } : {}), agentId, triggerMessageId: messageId, timezone });
  const post = async (refresh) => fetch(baseUrl + '/chat/trigger', { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await getAccessToken({ refresh }) } });
  for (let attempt = 0; ; attempt++) {
    let r = await post(false);
    if (r.status === 401) r = await post(true);
    if ((r.status === 404 || r.status === 408) && attempt < 3) { await wait(2000 * 2 ** attempt); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw new Error(j.error === 'ai_cap_exceeded' ? 'You have reached your Tana AI limit' : j.error || j.message || 'Tana did not answer: HTTP ' + r.status);
    return j; // { success, messageId }: the AI message being written
  }
}

// Delete one of your own messages, as Tana's "Delete message" does (its deleteMessage: the entry spliced out of the
// list). Tana offers it on your own messages only, never on the AI's or anyone else's, and neither does this.
function deleteMessage(loro, { messageId, byUri }) {
  const messages = loro.getMap('data').get('messages');
  for (let i = 0; messages instanceof LoroList && i < messages.length; i++) {
    const m = messages.get(i);
    if (!(m instanceof LoroMap) || m.get('id') !== messageId) continue;
    if (m.get('fromUserType') === 'ai' || m.get('fromUserUri') !== byUri) throw new Error('Only your own messages can be deleted');
    messages.delete(i, 1);
    return;
  }
  throw new Error('That message is not in this chat');
}
module.exports = { chatRows, blocks, segments, plain, hm, pushMessage, addMessage, deleteMessage, autoResponds, mentionsTana, pendingQuestions, answerSummary, answerQuestions, triggerReply, deterministicId, TANA_AGENT };

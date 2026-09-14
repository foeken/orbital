'use strict';
// A chat document has no content outline: its conversation is data.messages (docs/CHATS.md). This turns that list
// into ordinary read-only outline rows in the vocabulary the renderer already knows (docs/OUTLINER.md addendum 1):
// one author row per message, its markdown blocks as children, mentions as segments, attachments/proposals as
// reference rows. Pure and Electron-free so scripts/sdk-check.js can run it offline.

// Inline markdown of one line: a [label](uri) mention or link, **bold**, `code`. The text is plain markdown source
// (no Loro marks at all), so this regex is the whole inline story.
const INLINE = /\[([^\]\n]*)\]\((tana:[a-z-]+:[0-9a-z]{26}|https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;

function segments(text) {
  const out = [];
  const push = (t, marks) => { if (t) out.push(marks ? { text: t, marks } : { text: t }); };
  let at = 0;
  for (const m of String(text).matchAll(INLINE)) {
    push(String(text).slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) m[2].startsWith('tana:') ? out.push({ mention: { label: m[1], uri: m[2] } }) : push(m[1] || m[2], { link: m[2] });
    else if (m[3] !== undefined) push(m[3], { bold: true });
    else push(m[4], { code: true });
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
    const heading = t.match(/^(#{1,3})\s+(.*)$/);
    if (heading) { flush(); out.push({ block: 'heading' + heading[1].length, heading: heading[1].length, text: heading[2] }); continue; }
    const item = t.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (item) { flush(); out.push({ block: 'bullet', text: item[1] }); continue; }
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
// the web client's label: completedAt - sentAt, not usage.durationMs (docs/CHATS.md §4)
const took = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };
const list = (v) => (Array.isArray(v) ? v : []);

// messages: data.messages as plain JSON, in list order (never sorted by sentAt: the preamble shares its millisecond
// with the first user message). authorName(uri) -> display name, aiName: what to call the assistant.
function chatRows(messages, { authorName = () => undefined, aiName = 'Tana AI' } = {}) {
  const rows = [];
  list(messages).forEach((m, i) => {
    // hiddenFromChat is the synthetic preamble the web client hides; a 'context' message is injected context, not speech.
    if (!m || m.hiddenFromChat || m.type === 'context') return;
    const ai = m.fromUserType === 'ai', id = 'm' + i, children = [];
    if (ai && m.completedAt > m.sentAt) children.push(row(id + '.t', 'Thought for ' + took(m.completedAt - m.sentAt)));
    for (const [j, b] of blocks(m.content && m.content.text).entries()) {
      // code keeps its markdown characters; every other block renders its inline markdown as segments
      children.push(row(id + '.b' + j, b.text, { block: b.block, ...(b.heading ? { heading: b.heading } : {}), ...(b.verbatim ? { segments: b.text ? [{ text: b.text }] : [] } : {}) }));
    }
    for (const [j, uri] of list(m.attachmentUris).entries()) children.push(reference(id + '.a' + j, uri));
    for (const [j, p] of list(m.proposals).entries()) {
      if (!p || typeof p.proposedUri !== 'string') continue;
      const state = p.approvedAt ? 'approved' : p.rejectedAt ? 'rejected' : 'awaiting approval';
      const target = p.operation === 'update' && typeof p.baseUri === 'string' ? p.baseUri : p.proposedUri;
      children.push(row(id + '.p' + j, (p.operation || 'change') + ' · ' + state, { hasChildren: true, children: [reference(id + '.p' + j + '.r', target)] }));
    }
    for (const [j, call] of list(m.toolCalls).entries()) {
      if (call && typeof call.subagentChatUri === 'string') children.push(reference(id + '.s' + j, call.subagentChatUri, call.name));
    }
    rows.push(row(id, ai ? aiName : authorName(m.fromUserUri) || 'Someone', {
      icon: ai ? 'chat' : 'member', block: 'heading3', heading: 3,
      meta: typeof m.sentAt === 'number' ? hm(m.sentAt) : undefined,
      hasChildren: children.length > 0, children,
    }));
  });
  return rows;
}

module.exports = { chatRows, blocks, segments, plain };

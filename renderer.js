'use strict';

// ---- shared helper: find a node in a nested Node[] with its ancestry ----
function locate(list, id, trail = []) {
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    if (node.id === id) return { list, index: i, node, trail };
    const found = locate(node.children || [], id, [...trail, { list, index: i, node }]);
    if (found) return found;
  }
  return null;
}

// ---- mock api, used ONLY when preload did not run (no window.api) ----
function mockApi() {
  const titles = ['Schedule something with Lex van Velsen and Roni Wiener', 'Metrics project needs more support and information. Timeline on hold.',
    'Check out OpenUp', 'Should we kickstart a FTE/Employee cost tracking system with Finance/HR', 'Discuss two cross-boarders with Jeroen Oostewechel',
    'Organise working sessions on guardrails for teams with Foundry', 'Contact Mark W for dinner', 'Ask and tell about Tana DPA', 'The blue laptop discussion',
    'Ask Foundry teams for risks (with deadline Sun, Nov 1)', 'Organise session with Arjan Pragt around the role definition', "Create RvC presentation on Nedap's one-year AI vision"];
  let seq = 0;
  const block = (text, children = [], heading) => ({ id: 'b' + (++seq), text: plainOf(text), segments: segsOf(text), kind: 'block', heading, hasChildren: children.length > 0, children });
  const docs = titles.map((text, i) => ({ id: 'mockdoc' + i, text, kind: 'document', done: 0, hasChildren: true, icon: 'task' }));
  const people = { 'tana:user-profile:lex': 'Lex van Velsen' }; // referenced document that is not in roots
  const content = Object.fromEntries(docs.map((d, i) => [d.id, [
    block('Context', [], 2),
    block('First point about task ' + i, [block('Detail A'), block('Detail B', [block('Deeper detail')])]),
    block([{ text: 'Discuss with ' }, { mention: { label: 'Lex van Velsen', uri: 'tana:user-profile:lex' } }, { text: ' and see ' }, { mention: { label: titles[2], uri: 'mockdoc2' } }]),
    block('Second point, a paragraph long enough to wrap onto a second line when the window is narrow so arrow keys can be tested inside a node.'),
    block('Next steps', [block('Call someone'), block('Write the memo')]),
  ]]));
  content['tana:user-profile:lex'] = [block('Lex is a colleague')];
  const changed = [], statusCbs = [];
  let status = { authenticated: false, connected: false, syncing: false, lastSync: null, error: null };
  const emit = (docId) => setTimeout(() => changed.forEach((cb) => cb(docId)), 0);
  const fix = (n) => { n.hasChildren = n.children.length > 0; };
  return {
    roots: async () => docs.map((d) => ({ ...d })),
    children: async (docId) => structuredClone(content[docId] || []),
    node: async (docId) => {
      const d = docs.find((x) => x.id === docId);
      if (d) return { id: d.id, title: d.text, kind: 'document', done: d.done, icon: d.icon };
      if (people[docId]) return { id: docId, title: people[docId], kind: 'document', done: 0 };
      throw new Error('unknown document ' + docId);
    },
    setTitle: async (docId, title) => { docs.find((d) => d.id === docId).text = title; emit(docId); },
    setDone: async (docId, done) => { docs.find((d) => d.id === docId).done = done ? 1 : 0; emit(docId); },
    setText: async (docId, id, text) => { const n = locate(content[docId], id).node; n.text = plainOf(text); n.segments = segsOf(text); emit(docId); },
    insertAfter: async (docId, id, text) => {
      const n = block(text);
      if (id == null) content[docId].push(n); else { const f = locate(content[docId], id); f.list.splice(f.index + 1, 0, n); }
      emit(docId); return n.id;
    },
    insertChild: async (docId, id, text) => { const n = block(text), f = locate(content[docId], id); f.node.children.unshift(n); fix(f.node); emit(docId); return n.id; },
    remove: async (docId, id) => { const f = locate(content[docId], id); f.list.splice(f.index, 1); const p = f.trail.at(-1); if (p) fix(p.node); emit(docId); },
    indent: async (docId, id) => {
      const f = locate(content[docId], id); if (f.index === 0) return;
      const prev = f.list[f.index - 1]; f.list.splice(f.index, 1); prev.children.push(f.node); fix(prev); emit(docId);
    },
    outdent: async (docId, id) => {
      const f = locate(content[docId], id), p = f.trail.at(-1); if (!p) return;
      f.list.splice(f.index, 1); fix(p.node); p.list.splice(p.index + 1, 0, f.node); emit(docId);
    },
    move: async (docId, id, dir) => {
      const f = locate(content[docId], id), j = f.index + (dir === 'up' ? -1 : 1);
      if (j < 0 || j >= f.list.length) return;
      [f.list[f.index], f.list[j]] = [f.list[j], f.list[f.index]]; emit(docId);
    },
    refresh: async () => emit(null),
    login: async () => { status = { ...status, authenticated: true, connected: true, lastSync: new Date().toISOString() }; statusCbs.forEach((cb) => cb(status)); },
    status: async () => status,
    onChanged: (cb) => changed.push(cb),
    onStatus: (cb) => statusCbs.push(cb),
  };
}

// ---- segments: [{ text } | { mention: { label, uri } }] <-> plain text <-> DOM ----
// accepts segments, a plain string, or a Node
const segsOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? (v ? [{ text: v }] : []) : v.segments || (v.text ? [{ text: v.text }] : []));
const plainOf = (v) => segsOf(v).map((s) => ('text' in s ? s.text : s.mention.label)).join('');
function renderSegs(el, segs) {
  el.replaceChildren(...segs.map((s, i) => {
    // Chromium needs a placeholder newline after a trailing soft break to put the caret on the empty line; readSegs strips it
    if ('text' in s) return document.createTextNode(s.text + (i === segs.length - 1 && s.text.endsWith('\n') ? '\n' : ''));
    const a = document.createElement('a'); a.className = 'mention'; a.dataset.uri = s.mention.uri; a.contentEditable = 'false'; a.textContent = s.mention.label;
    return a;
  }));
}
function readSegs(el) {
  const segs = [];
  for (const n of el.childNodes) {
    if (n.nodeType === 1 && n.classList.contains('mention')) { segs.push({ mention: { label: n.textContent, uri: n.dataset.uri } }); continue; }
    const t = n.nodeName === 'BR' ? '\n' : n.textContent;
    if (!t) continue;
    const last = segs.at(-1);
    if (last && 'text' in last) last.text += t; else segs.push({ text: t });
  }
  const last = segs.at(-1);
  if (last && 'text' in last && last.text.endsWith('\n\n')) last.text = last.text.slice(0, -1);
  return segs;
}
// split segments at a plain-text offset; a mention hit by the cut stays whole in the first half
function splitSegs(segs, off) {
  const before = [], after = [];
  for (const s of segs) {
    const len = 'text' in s ? s.text.length : s.mention.label.length;
    if (off >= len) { before.push(s); off -= len; }
    else if (off <= 0) after.push(s);
    else if ('text' in s) { before.push({ text: s.text.slice(0, off) }); after.push({ text: s.text.slice(off) }); off = 0; }
    else { before.push(s); off = 0; }
  }
  return [before, after];
}
const saveValue = (segs) => (segs.some((s) => 'mention' in s) ? segs : plainOf(segs));
const tana = window.api || mockApi();

// ---- state ----
let roots = [];              // document nodes
const extra = new Map();     // docId -> document Node reached through a mention (not in roots)
const kids = new Map();      // docId -> Node[] | null (loading)
const open = new Map();      // key -> bool; default: blocks open, documents closed
let zoom = null;             // { docId, nodeId | null }
const items = new Map();     // key -> { key, node, docId, parent }, rebuilt on render
const pending = new Map();   // key -> { item, segs, timer } debounced edits
let filterShown = false;
let queue = Promise.resolve();

const $ = (id) => document.getElementById(id);
const outline = $('outline'), filterEl = $('filter'), filterRow = $('filterRow');
const keyFor = (docId, node) => (node.kind === 'document' ? docId : docId + '/' + node.id);
const mkItem = (docId, node, parent) => { const item = { key: keyFor(docId, node), node, docId, parent }; items.set(item.key, item); return item; };
const childrenOf = (item) => (item.node.kind === 'document' ? kids.get(item.docId) : item.node.children || []);
const hasKids = (item) => { const c = childrenOf(item); return Array.isArray(c) ? c.length > 0 : !!item.node.hasChildren; };
const isOpen = (item) => (open.has(item.key) ? open.get(item.key) : item.node.kind === 'block');
const showError = (e) => { const el = $('error'); el.textContent = e ? String(e.message || e) : ''; el.hidden = !e; };
const run = (fn) => (queue = queue.then(fn).catch(showError));
const texts = () => [...outline.querySelectorAll('.text')];
const keyOfEl = (el) => el.closest('.node').dataset.key;
const textEl = (key) => outline.querySelector('.node[data-key="' + CSS.escape(key) + '"] > .line > .text');
const ICONS = window.ICONS || {}; // icons.js: Tana line icon set (Nucleo export), greyscale via currentColor
const TASK_ICON = ICONS.task || '';

async function loadRoots() { roots = await tana.roots(); }
async function reload(docId) { kids.set(docId, await tana.children(docId)); }
function ensureLoaded(item) {
  if (item.node.kind !== 'document' || kids.has(item.docId)) return;
  kids.set(item.docId, null);
  reload(item.docId).then(render, showError);
}

// ---- caret helpers (contenteditable: text nodes + non-editable mention anchors) ----
function caretOffset(el) {
  const sel = getSelection();
  if (!sel.rangeCount || !el.contains(sel.focusNode)) return null;
  const r = document.createRange(); r.selectNodeContents(el); r.setEnd(sel.focusNode, sel.focusOffset);
  return r.toString().length;
}
function setCaret(el, offset) {
  el.focus();
  let left = Math.max(0, Math.min(offset, el.textContent.length));
  const r = document.createRange(), walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let t, placed = false;
  while ((t = walker.nextNode())) {
    if (left <= t.data.length) {
      const a = t.parentNode !== el && t.parentNode.closest('.mention');
      if (a) { if (left === 0) r.setStartBefore(a); else r.setStartAfter(a); } else r.setStart(t, left); // never inside a mention
      placed = true; break;
    }
    left -= t.data.length;
  }
  if (!placed) r.setStart(el, el.childNodes.length);
  r.collapse(true);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
function focused() {
  const el = document.activeElement;
  return el && el.classList.contains('text') && outline.contains(el) ? { key: keyOfEl(el), offset: caretOffset(el) } : null;
}
function placeCaret(key, offset) {
  const el = textEl(key);
  if (el) setCaret(el, offset == null ? el.textContent.length : offset);
}
// true when the caret sits on the first (up) / last (down) visual line of el
function atEdge(el, dir) {
  const sel = getSelection();
  if (!sel.rangeCount) return true;
  const rects = sel.getRangeAt(0).getClientRects();
  if (!rects.length) return true;
  const r = rects[0], box = el.getBoundingClientRect(), lh = r.height || 20;
  return dir === 'up' ? r.top - box.top < lh / 2 : box.bottom - r.bottom < lh / 2;
}

// ---- render ----
function render() {
  const saved = focused();
  items.clear();
  let trail = null;
  if (zoom) { trail = resolveZoom(); if (!trail) zoom = null; }
  const parent = trail && trail.at(-1);
  let list, hidden = 0;
  if (parent) {
    ensureLoaded(parent);
    list = childrenOf(parent) || [];
  } else {
    const q = filterEl.value.trim().toLowerCase();
    list = q ? roots.filter((r) => r.text.toLowerCase().includes(q)) : roots;
    hidden = roots.length - list.length;
  }
  outline.replaceChildren(...list.map((n) => nodeEl(n, parent ? parent.docId : n.id, parent)));
  if (parent && !list.length) {
    const note = document.createElement('div');
    note.className = 'empty-note'; note.textContent = kids.get(parent.docId) === null ? 'Loading…' : 'No content';
    outline.append(note);
  }
  $('title').textContent = parent ? parent.node.text : 'Tasks';
  renderCrumbs(trail);
  filterRow.hidden = !!parent || !(filterShown || filterEl.value);
  filterRow.classList.toggle('empty', !filterEl.value);
  $('filtered').textContent = hidden ? hidden + ' items filtered out' : '';
  if (saved) placeCaret(saved.key, saved.offset);
}

function resolveZoom() {
  const doc = roots.find((d) => d.id === zoom.docId) || extra.get(zoom.docId);
  if (!doc) return null;
  let item = mkItem(zoom.docId, doc, null);
  const trail = [item];
  if (zoom.nodeId) {
    const found = locate(kids.get(zoom.docId) || [], zoom.nodeId);
    if (!found) return kids.has(zoom.docId) && kids.get(zoom.docId) !== null ? null : trail;
    for (const t of found.trail) trail.push(item = mkItem(zoom.docId, t.node, item));
    trail.push(item = mkItem(zoom.docId, found.node, item));
  }
  return trail;
}

function renderCrumbs(trail) {
  const nav = $('crumbs');
  nav.hidden = !trail;
  if (!trail) return;
  const home = document.createElement('a'); home.textContent = 'Tasks'; home.onclick = () => { zoom = null; render(); };
  nav.replaceChildren(home);
  trail.forEach((item, i) => {
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›';
    const a = document.createElement(i === trail.length - 1 ? 'span' : 'a');
    a.className = i === trail.length - 1 ? 'current' : ''; a.textContent = item.node.text || 'Untitled';
    if (i < trail.length - 1) a.onclick = () => zoomTo(item);
    nav.append(sep, a);
  });
}

function nodeEl(node, docId, parent) {
  const item = mkItem(docId, node, parent);
  const has = hasKids(item), opened = isOpen(item);
  const el = document.createElement('div');
  el.className = 'node ' + node.kind + (node.heading ? ' h' + node.heading : '') + (node.done ? ' done' : '') + (has ? ' has' : '') + (has && !opened ? ' collapsed' : '');
  el.dataset.key = item.key;
  const line = document.createElement('div'); line.className = 'line';
  const chev = document.createElement('button'); chev.className = 'chev'; chev.tabIndex = -1; chev.title = opened ? 'Collapse' : 'Expand';
  chev.onmousedown = (e) => e.preventDefault();
  chev.onclick = () => setOpen(item, !opened);
  const bullet = document.createElement('span'); bullet.className = 'bullet'; bullet.title = 'Zoom in';
  if (node.icon === 'task') { bullet.classList.add('task'); bullet.innerHTML = TASK_ICON; }
  bullet.onmousedown = (e) => e.preventDefault();
  bullet.onclick = () => zoomTo(item);
  line.append(chev, bullet);
  if (node.kind === 'document') {
    const check = document.createElement('input');
    check.type = 'checkbox'; check.className = 'check'; check.checked = !!node.done; check.tabIndex = -1;
    check.onmousedown = (e) => e.preventDefault();
    check.onclick = () => toggleDone(item);
    line.append(check);
  }
  const text = document.createElement('span');
  text.className = 'text'; text.contentEditable = 'plaintext-only'; text.spellcheck = false;
  renderSegs(text, pending.has(item.key) ? pending.get(item.key).segs : segsOf(node));
  line.append(text);
  line.onclick = (e) => { if (e.target === line) setCaret(text, text.textContent.length); };
  el.append(line);
  if (has && opened) {
    const wrap = document.createElement('div'); wrap.className = 'children';
    const c = childrenOf(item);
    if (c == null) { ensureLoaded(item); wrap.classList.add('loading'); wrap.textContent = 'Loading…'; }
    else wrap.append(...c.map((k) => nodeEl(k, docId, item)));
    el.append(wrap);
  }
  return el;
}

// ---- edits (debounced) ----
function scheduleSave(item, segs) {
  const p = pending.get(item.key);
  if (p) clearTimeout(p.timer);
  pending.set(item.key, { item, segs, timer: setTimeout(() => flush(item.key), 400) });
}
function dropPending(key) { const p = pending.get(key); if (p) { clearTimeout(p.timer); pending.delete(key); } }
function flush(key) {
  const p = pending.get(key);
  if (!p) return;
  dropPending(key);
  const { item, segs } = p, text = plainOf(segs);
  if (text === item.node.text && JSON.stringify(segs) === JSON.stringify(segsOf(item.node))) return;
  item.node.text = text; item.node.segments = segs;
  run(() => (item.node.kind === 'document' ? tana.setTitle(item.docId, text) : tana.setText(item.docId, item.node.id, saveValue(segs))));
}
function insertAtCaret(el, str) {
  if (caretOffset(el) == null) setCaret(el, el.textContent.length);
  document.execCommand('insertText', false, str); // keeps mention anchors intact and fires 'input'
}

// ---- structural operations ----
async function splitNode(item, el, off) {
  const { docId, node } = item;
  const [before, after] = splitSegs(readSegs(el), off);
  let newId;
  if (node.kind === 'document') {
    flush(item.key);
    // ponytail: no prepend op in the contract; a document's new child is appended (first child when the doc is empty)
    await run(async () => { newId = await tana.insertAfter(docId, null, ''); await reload(docId); });
    open.set(item.key, true);
  } else {
    dropPending(item.key);
    const asChild = hasKids(item) && isOpen(item);
    await run(async () => {
      if (JSON.stringify(before) !== JSON.stringify(segsOf(node))) { node.text = plainOf(before); node.segments = before; await tana.setText(docId, node.id, saveValue(before)); }
      newId = asChild ? await tana.insertChild(docId, node.id, plainOf(after)) : await tana.insertAfter(docId, node.id, plainOf(after));
      if (after.some((s) => 'mention' in s)) await tana.setText(docId, newId, after); // insert ops take plain text; restore the mentions
      await reload(docId);
    });
  }
  render();
  if (newId) placeCaret(docId + '/' + newId, 0);
}

async function shiftNode(item, el, op, arg) {
  flush(item.key);
  const off = caretOffset(el);
  if (op === 'indent') {
    const siblings = childrenOf(item.parent) || [], prev = siblings[siblings.indexOf(item.node) - 1];
    if (prev) open.set(keyFor(item.docId, prev), true);
  }
  await run(async () => { await tana[op](item.docId, item.node.id, arg); await reload(item.docId); });
  render();
  placeCaret(item.key, off);
}

async function removeNode(item, el) {
  const all = texts(), prev = all[all.indexOf(el) - 1], prevKey = prev && keyOfEl(prev);
  dropPending(item.key);
  await run(async () => { await tana.remove(item.docId, item.node.id); await reload(item.docId); });
  render();
  if (prevKey) placeCaret(prevKey, null);
}

function setOpen(item, value) { open.set(item.key, value); render(); }
function toggleDone(item) {
  item.node.done = item.node.done ? 0 : 1;
  render();
  run(() => tana.setDone(item.docId, item.node.done));
}
function zoomTo(item) {
  flushAll();
  zoom = { docId: item.docId, nodeId: item.node.kind === 'document' ? null : item.node.id };
  render();
}
async function goTo(uri) {
  flushAll();
  if (!roots.some((d) => d.id === uri) && !extra.has(uri)) {
    try { const n = await tana.node(uri); extra.set(uri, { ...n, text: n.title || '', hasChildren: true }); }
    catch (e) { return showError(e); }
  }
  zoom = { docId: uri, nodeId: null };
  render();
}
function flushAll() { for (const key of [...pending.keys()]) flush(key); }

// ---- navigation ----
function moveTo(el, dir, offset) {
  const all = texts(), target = all[all.indexOf(el) + dir];
  if (!target) return;
  flush(keyOfEl(el));
  setCaret(target, offset);
}

// ---- events ----
outline.addEventListener('keydown', (e) => {
  const el = e.target.closest && e.target.closest('.text');
  if (!el) return;
  const item = items.get(keyOfEl(el)), mod = e.metaKey || e.ctrlKey;
  const off = caretOffset(el), len = el.textContent.length, collapsed = getSelection().isCollapsed;
  const isDoc = item.node.kind === 'document';
  if (e.key === 'Escape') { e.preventDefault(); flush(item.key); el.blur(); }
  else if (e.key === 'Enter' && mod) { e.preventDefault(); if (isDoc) toggleDone(item); }
  else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); insertAtCaret(el, '\n'); }
  else if (e.key === 'Enter') { e.preventDefault(); splitNode(item, el, off ?? len); }
  else if (e.key === 'Tab') { e.preventDefault(); if (!isDoc) shiftNode(item, el, e.shiftKey ? 'outdent' : 'indent'); }
  else if (e.key === 'Backspace' && off === 0 && collapsed) { e.preventDefault(); if (!isDoc && len === 0) removeNode(item, el); }
  else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && mod && e.shiftKey) { e.preventDefault(); if (!isDoc) shiftNode(item, el, 'move', e.key === 'ArrowUp' ? 'up' : 'down'); }
  else if (e.key === 'ArrowUp' && mod && !e.shiftKey) { e.preventDefault(); if (hasKids(item)) setOpen(item, false); }
  else if (e.key === 'ArrowDown' && mod && !e.shiftKey) { e.preventDefault(); if (hasKids(item)) setOpen(item, true); }
  else if (e.key === 'ArrowUp' && !mod && atEdge(el, 'up')) { e.preventDefault(); moveTo(el, -1, off); }
  else if (e.key === 'ArrowDown' && !mod && atEdge(el, 'down')) { e.preventDefault(); moveTo(el, 1, off); }
  else if (e.key === 'ArrowLeft' && off === 0 && collapsed) { e.preventDefault(); moveTo(el, -1, Infinity); }
  else if (e.key === 'ArrowRight' && off === len && collapsed) { e.preventDefault(); moveTo(el, 1, 0); }
});
outline.addEventListener('input', (e) => {
  const el = e.target.closest && e.target.closest('.text');
  if (!el) return;
  scheduleSave(items.get(keyOfEl(el)), readSegs(el));
});
outline.addEventListener('focusout', (e) => { if (e.target.classList && e.target.classList.contains('text')) flush(keyOfEl(e.target)); });
outline.addEventListener('mousedown', (e) => { if (e.target.closest && e.target.closest('.mention')) e.preventDefault(); });
outline.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('.mention'); if (a) { e.preventDefault(); goTo(a.dataset.uri); } });

filterEl.addEventListener('input', render);
filterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { filterEl.value = ''; filterShown = false; render(); filterEl.blur(); }
  else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); const first = texts()[0]; if (first) setCaret(first, 0); }
});
filterEl.addEventListener('blur', () => { if (!filterEl.value) { filterShown = false; render(); } });
$('clear').onclick = () => { filterEl.value = ''; render(); filterEl.focus(); };
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); if (zoom) return; filterShown = true; render(); filterEl.focus(); }
  else if (e.key === 'Escape' && document.activeElement === document.body && filterEl.value) { filterEl.value = ''; filterShown = false; render(); }
});

// ---- status ----
function showStatus(s) {
  $('loginBox').hidden = !!s.authenticated;
  outline.hidden = $('filtered').hidden = !s.authenticated;
  showError(s.error);
}
$('login').onclick = () => tana.login().catch(showError);

// ---- live updates ----
tana.onChanged((docId) => {
  const work = [loadRoots()];
  if (docId && kids.has(docId)) work.push(reload(docId));
  Promise.all(work).then(render, showError);
});
tana.onStatus(showStatus);
loadRoots().then(render, showError);
tana.status().then(showStatus, showError);

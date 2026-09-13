'use strict';

// ---- mock, only when preload didn't run (open index.html in a browser) ----
const tana = window.api || (() => {
  const spaces = ['Nedap Leadership Team', 'Foundry Organisation', null];
  const tasks = Array.from({ length: 12 }, (_, i) => ({
    id: 'tana:text:mock' + i, title: ['Schedule something with Lex', 'Check out OpenUp', 'Contact Mark W for dinner',
      'Ask and tell about Tana DPA', 'The blue laptop discussion', 'Organise session with Arjan'][i % 6] + ' #' + i,
    done: 0, space: spaces[i % 3], content: null, updatedAt: new Date().toISOString(), dirty: 0 }));
  const changed = [], statusCbs = [];
  let status = { authenticated: false, syncing: false, lastSync: null, error: null };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const emitStatus = (s) => { status = { ...status, ...s }; statusCbs.forEach((cb) => cb(status)); };
  return {
    listTasks: async () => tasks.map((t) => ({ ...t })),
    updateTask: async (id, patch) => { const t = tasks.find((t) => t.id === id); Object.assign(t, patch, { dirty: 1 }); return { ...t }; },
    loadContent: async (id) => { await wait(600); return 'Mock content for ' + id + '\n\n- line one\n- line two'; },
    status: async () => status,
    login: async () => { await wait(300); emitStatus({ authenticated: true }); },
    onTasksChanged: (cb) => changed.push(cb),
    onStatus: (cb) => statusCbs.push(cb),
  };
})();

// ---- state ----
let tasks = [];
let selectedId = null;
let editingId = null;
const expanded = new Set();
const contents = new Map(); // id -> string | null (null = loading)

const $ = (id) => document.getElementById(id);
const list = $('list'), filterEl = $('filter'), filterWrap = filterEl.parentElement;

function visible() {
  const q = filterEl.value.trim().toLowerCase();
  return q ? tasks.filter((t) => t.title.toLowerCase().includes(q)) : tasks;
}

// ---- render ----
function render() {
  const shown = visible();
  const editingEl = editingId && list.querySelector('.row[data-id="' + CSS.escape(editingId) + '"] .title');
  const editingText = editingEl ? editingEl.textContent : null;
  if (editingEl) editingEl.onblur = null;
  list.replaceChildren(...shown.map(rowEl));
  $('filtered').textContent = shown.length < tasks.length ? (tasks.length - shown.length) + ' items filtered out' : '';
  filterWrap.classList.toggle('empty', !filterEl.value);
  if (editingId) {
    const el = list.querySelector('.row[data-id="' + CSS.escape(editingId) + '"] .title');
    if (el) startEdit(el, editingText); else editingId = null;
  }
}

function rowEl(t) {
  const li = document.createElement('li');
  li.className = 'row' + (t.id === selectedId ? ' selected' : '') + (t.done ? ' done' : '') + (expanded.has(t.id) ? ' expanded' : '');
  li.dataset.id = t.id;
  const main = document.createElement('div');
  main.className = 'rowmain';

  const chev = document.createElement('button');
  chev.className = 'chev'; chev.textContent = '▶'; chev.tabIndex = -1; chev.title = 'Show content';
  chev.onclick = (e) => { e.stopPropagation(); toggleExpand(t.id); };

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'taskicon'); icon.setAttribute('viewBox', '0 0 16 16');
  icon.innerHTML = '<path d="M2 4.5l1.5 1.5L6 3.5M8 5h6M2 11h2M8 11h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';

  const check = document.createElement('input');
  check.type = 'checkbox'; check.className = 'check'; check.checked = !!t.done; check.tabIndex = -1;
  check.onclick = (e) => e.stopPropagation();
  check.onchange = () => setDone(t.id, check.checked ? 1 : 0);

  const title = document.createElement('span');
  title.className = 'title'; title.textContent = t.title;
  const space = document.createElement('span');
  if (t.space) { space.className = 'space'; space.textContent = t.space; }

  main.append(chev, icon, check, title, space);
  li.append(main);
  main.onclick = () => { if (editingId !== t.id) { select(t.id); list.focus(); } };
  main.ondblclick = (e) => { if (e.target.closest('.check,.chev')) return; select(t.id); beginEdit(t.id); };

  if (expanded.has(t.id)) {
    const c = document.createElement('div');
    const body = contents.get(t.id);
    if (body == null) { c.className = 'content loading'; c.textContent = 'loading…'; }
    else { c.className = 'content'; c.textContent = body || '(no content)'; }
    li.append(c);
  }
  return li;
}

// ---- actions ----
function select(id) {
  selectedId = id;
  list.querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
  const el = list.querySelector('.row[data-id="' + CSS.escape(id) + '"]');
  if (el) { el.classList.add('selected'); el.scrollIntoView({ block: 'nearest' }); }
}

function setDone(id, done) {
  const t = tasks.find((t) => t.id === id);
  if (!t) return;
  t.done = done;
  render();
  tana.updateTask(id, { done }).catch((e) => setStatusText(String(e), true));
}

async function toggleExpand(id) {
  if (expanded.has(id)) { expanded.delete(id); render(); return; }
  expanded.add(id);
  if (!contents.has(id)) {
    contents.set(id, null);
    render();
    try { contents.set(id, await tana.loadContent(id)); }
    catch (e) { contents.set(id, 'Failed to load: ' + e.message); }
  }
  render();
}

function beginEdit(id) {
  editingId = id;
  const el = list.querySelector('.row[data-id="' + CSS.escape(id) + '"] .title');
  if (el) startEdit(el, null);
}

function startEdit(el, text) {
  el.contentEditable = 'true';
  if (text != null) el.textContent = text;
  el.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finishEdit(el, true); }
    else if (e.key === 'Escape') { e.preventDefault(); finishEdit(el, false); }
  };
  el.onblur = () => finishEdit(el, true);
  if (document.activeElement !== el) {
    el.focus();
    const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }
}

function finishEdit(el, save) {
  if (!editingId) return;
  const id = editingId, t = tasks.find((t) => t.id === id);
  editingId = null;
  el.onblur = null; el.onkeydown = null; el.contentEditable = 'false';
  const title = el.textContent.trim();
  if (save && t && title && title !== t.title) {
    t.title = title;
    tana.updateTask(id, { title }).catch((e) => setStatusText(String(e), true));
  }
  render();
  list.focus();
}

// ---- keyboard ----
list.addEventListener('keydown', (e) => {
  if (editingId) return;
  const shown = visible();
  const i = shown.findIndex((t) => t.id === selectedId);
  if (e.key === 'ArrowDown') { e.preventDefault(); if (shown.length) select(shown[Math.min(i + 1, shown.length - 1)].id); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) select(shown[Math.max(i - 1, 0)].id); }
  else if (e.key === ' ' && i >= 0) { e.preventDefault(); setDone(selectedId, shown[i].done ? 0 : 1); }
  else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); beginEdit(selectedId); }
});
filterEl.addEventListener('input', render);
filterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { filterEl.value = ''; render(); }
  else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); const s = visible(); if (s.length) { select(selectedId && s.some((t) => t.id === selectedId) ? selectedId : s[0].id); list.focus(); } }
});
$('clear').onclick = () => { filterEl.value = ''; render(); filterEl.focus(); };

// ---- status ----
function setStatusText(text, isError) {
  const el = $('statusText'); el.textContent = text; el.classList.toggle('error', !!isError);
}
function showStatus(s) {
  $('login').hidden = s.authenticated;
  if (s.error) setStatusText('Error: ' + s.error, true);
  else if (s.syncing) setStatusText('Syncing…');
  else if (!s.authenticated) setStatusText('Not logged in');
  else if (s.lastSync) setStatusText('Last sync ' + new Date(s.lastSync).toLocaleTimeString());
  else setStatusText('Not synced yet');
}
$('login').onclick = () => tana.login().catch((e) => setStatusText(String(e), true));

// ---- data ----
async function refresh() {
  tasks = await tana.listTasks();
  if (selectedId && !tasks.some((t) => t.id === selectedId)) selectedId = null;
  render();
}
tana.onTasksChanged(refresh);
tana.onStatus(showStatus);
refresh().catch((e) => setStatusText(String(e), true));
tana.status().then(showStatus).catch((e) => setStatusText(String(e), true));

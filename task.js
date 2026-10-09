'use strict';
// Quick Add Task (task.html; issues #232, #237, #241): the title, the type the task is made with — plain Task, or one of
// the workflow types main offers (main/documents.js taskTypes) — and who it is for. ↑/↓ choose the type, ⇥ turns the
// field into "Assign to…" over the workspace members (↑/↓, ↩ picks, Esc or ⇥ goes back), ↩ creates the task and goes to
// it, ⌘↩ creates it and stays with a note that opens it, Esc closes, ⌘K
// closes and opens the palette. A page of its own that main lays over the whole window, both halves of a split
// (main.js openOverlay); the page that asked gave its theme in the query and shows the note this sends back.
// The task is open and assigned to you, as a task from a title always is; someone else chosen here is written after
// it exists, through the outliner's own assignee write (doc:setAssignees). A refusal there leaves the task standing
// and says so in the note: a created task is never reported as a failure, which would invite a second one.
const taskApi = window.api;
if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
const taskCard = document.getElementById('task'), taskField = document.getElementById('taskTitle');
const taskList = document.getElementById('taskTypes'), taskError = document.getElementById('taskError'), taskPicks = document.getElementById('taskPicks');
const TASK_GLYPHS = window.ICONS || {}; // icons.js: our own markup
let taskTypes = [{ uri: null, title: 'Task' }], taskAt = 0, taskBusy = false, clipImage = false; // clipImage: the clipboard holds an image (main.js clipboard:hasImage)
let taskMode = 'title', taskTitle = '', people = [], peopleAt = 0, assignee = null; // null: you, the creator
const closeTask = (result = {}) => { if (taskApi && taskApi.closeOverlay) taskApi.closeOverlay(result); };
const errorText = (e) => String((e && e.message) || e); // as main said it: preload.js takes off Electron's wrapper
function rowEl(glyph, label, active, hue, onPick) {
  const row = document.createElement('div');
  row.className = 'row' + (active ? ' active' : '');
  row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(active));
  const icon = document.createElement('span');
  icon.className = 'ricon' + (hue != null ? ' hue' : ''); icon.innerHTML = TASK_GLYPHS[glyph] || '';
  if (hue != null) icon.style.setProperty('--hue', String(hue)); // the type's colour, as its chip has it
  const text = document.createElement('span');
  text.className = 'label'; text.textContent = label;
  row.append(icon, text);
  if (active) { const key = document.createElement('kbd'); key.textContent = '↩'; row.append(key); }
  row.onmousedown = (e) => e.preventDefault(); // the field keeps the caret
  row.onclick = onPick;
  return row;
}
const group = (label) => { const head = document.createElement('div'); head.className = 'group'; head.textContent = label; return head; };
const matches = () => { const q = taskField.value.trim().toLowerCase(); return people.filter((p) => !q || p.title.toLowerCase().includes(q)); };
function draw() {
  const who = assignee ? assignee.title : 'Me';
  taskPicks.hidden = taskMode !== 'title';
  const key = document.createElement('kbd'); key.textContent = '⇥';
  const whoEl = document.createElement('b'); whoEl.textContent = who;
  taskPicks.replaceChildren(document.createTextNode(taskTypes[taskAt].title + ' · Assigned to '), whoEl, key);
  if (taskMode === 'people') {
    const list = matches();
    peopleAt = Math.min(peopleAt, Math.max(0, list.length - 1));
    taskList.hidden = false;
    taskList.replaceChildren(group('Assign to'), ...list.map((p, i) => rowEl('member', p.me ? p.title + ' (me)' : p.title, i === peopleAt, null, () => { peopleAt = i; pickPerson(); })));
    return;
  }
  // an image on the clipboard: its row takes ↩ while no title is typed (the page that opened this processes it, as Cmd+K's row does)
  const image = clipImage && !taskField.value.trim();
  taskList.hidden = taskTypes.length < 2 && !clipImage; // plain Task alone is no choice
  taskList.replaceChildren(...(taskTypes.length > 1 ? [group('Type'), ...taskTypes.map((type, i) => rowEl('task', type.title, i === taskAt && !image, type.hue, () => { taskAt = i; createTask(true); }))] : []),
    ...(clipImage ? [group('Clipboard'), rowEl('imageSparkle', 'Process image from clipboard', image, null, () => closeTask({ image: true }))] : []));
}
// "Assign to…": the field filters the members, and the title waits to come back
function toPeople() {
  if (taskMode === 'people') return;
  taskMode = 'people'; taskTitle = taskField.value; peopleAt = 0;
  taskField.value = ''; taskField.placeholder = 'Assign to…'; taskField.setAttribute('aria-label', 'Assign to');
  draw();
}
function toTitle() {
  taskMode = 'title';
  taskField.value = taskTitle; taskField.placeholder = 'New task'; taskField.setAttribute('aria-label', 'Task title');
  draw();
}
function pickPerson() {
  const person = matches()[peopleAt];
  if (person) assignee = person.me ? null : person;
  toTitle();
}
// go (↩, a click on a type): the window goes to the new task, since a note alone read as nothing happening; ⌘↩ stays
// where you are with the note, which opens the task. A refused assignment is said in the note either way.
function createTask(go = false) {
  const title = taskField.value.trim(), type = taskTypes[taskAt], person = assignee;
  if (!title || taskBusy || !taskApi) return;
  taskBusy = true; taskError.hidden = true;
  taskApi.createDocument(title, type.uri ? { kind: 'task', typeUri: type.uri } : { kind: 'task' }).then(async (node) => {
    let note = 'Task created: ' + title, refused = false;
    if (person) {
      try { await taskApi.setAssignees(node.id, [person.id]); note += ', assigned to ' + person.title; }
      catch (e) { refused = true; note += ' (not assigned to ' + person.title + ': ' + errorText(e) + ')'; }
    }
    closeTask({ ...(go && !refused ? {} : { note }), open: node.id, go }); // the toast opens the task it names
  }, (e) => { // the card stays with what was typed, so the press can simply be repeated
    taskBusy = false;
    taskError.textContent = errorText(e);
    taskError.hidden = false;
  });
}
taskField.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey, people_ = taskMode === 'people';
  const size = people_ ? matches().length : taskTypes.length;
  if (mod && e.key === 'k') closeTask({ palette: true });
  else if (e.key === 'Escape') { if (people_) toTitle(); else closeTask(); }
  else if (e.key === 'Tab') { if (people_) toTitle(); else toPeople(); }
  else if (e.key === 'Enter') { if (people_) pickPerson(); else if (clipImage && !taskField.value.trim()) closeTask({ image: true }); else createTask(!mod); }
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && size > 1) {
    const step = e.key === 'ArrowDown' ? 1 : size - 1;
    if (people_) peopleAt = (peopleAt + step) % size; else taskAt = (taskAt + step) % size;
    draw();
  }
  else return;
  e.preventDefault();
});
taskField.addEventListener('input', () => { if (taskMode === 'people') peopleAt = 0; draw(); }); // in the title: typing moves ↩ from the image row to the type
taskPicks.onmousedown = (e) => e.preventDefault();
taskPicks.onclick = toPeople;
taskCard.addEventListener('mousedown', (e) => { if (e.target === taskCard) closeTask(); }); // the scrim, as with the palette
if (taskApi && taskApi.taskTypes) taskApi.taskTypes().then((list) => { taskTypes = [taskTypes[0], ...(Array.isArray(list) ? list : [])]; draw(); }, () => {}); // no types: plain Task, no list
if (taskApi && taskApi.clipboardHasImage) taskApi.clipboardHasImage().then((has) => { clipImage = has === true; draw(); }, () => {});
// you first, then everyone else by name (main/rows.js members sorts them)
if (taskApi && taskApi.members) taskApi.members().then((list) => { people = (Array.isArray(list) ? list : []).filter((p) => p && p.id).sort((a, b) => (b.me ? 1 : 0) - (a.me ? 1 : 0)); if (taskMode === 'people') draw(); }, () => {});
draw();
taskField.focus();

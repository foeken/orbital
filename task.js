'use strict';
// Create task (task.html; issues #232, #237): one field for the title and, under it, the type the task is made with —
// plain Task, or one of the workflow types main offers (main/documents.js taskTypes). ↑/↓ choose, ↩ creates, Esc
// closes, ⌘K closes and opens the palette. A page of its own that main lays over the whole window, both halves of a
// split (main.js openOverlay); the page that asked gave its theme in the query and shows the note this sends back.
// The task is open and assigned to you, as a task from a title always is; where it goes and who else has it are its
// own rows afterwards.
const taskApi = window.api;
if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
const taskCard = document.getElementById('task'), taskTitle = document.getElementById('taskTitle');
const taskList = document.getElementById('taskTypes'), taskError = document.getElementById('taskError');
const TASK_GLYPH = (window.ICONS && window.ICONS.task) || ''; // icons.js: our own markup
let taskTypes = [{ uri: null, title: 'Task' }], taskAt = 0, taskBusy = false;
const closeTask = (result = {}) => { if (taskApi && taskApi.closeOverlay) taskApi.closeOverlay(result); };
function drawTypes() {
  taskList.hidden = taskTypes.length < 2; // plain Task alone is no choice
  const head = document.createElement('div');
  head.className = 'group'; head.textContent = 'Type';
  taskList.replaceChildren(head, ...taskTypes.map((type, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (i === taskAt ? ' active' : '');
    row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(i === taskAt));
    const icon = document.createElement('span');
    icon.className = 'ricon' + (type.hue != null ? ' hue' : ''); icon.innerHTML = TASK_GLYPH;
    if (type.hue != null) icon.style.setProperty('--hue', String(type.hue)); // the type's colour, as its chip has it
    const label = document.createElement('span');
    label.className = 'label'; label.textContent = type.title;
    row.append(icon, label);
    if (i === taskAt) { const key = document.createElement('kbd'); key.textContent = '↩'; row.append(key); }
    row.onmousedown = (e) => e.preventDefault(); // the field keeps the caret
    row.onclick = () => { taskAt = i; createTask(); };
    return row;
  }));
}
function createTask() {
  const title = taskTitle.value.trim(), type = taskTypes[taskAt];
  if (!title || taskBusy || !taskApi) return;
  taskBusy = true; taskError.hidden = true;
  taskApi.createDocument(title, type.uri ? { kind: 'task', typeUri: type.uri } : { kind: 'task' }).then(
    () => closeTask({ note: 'Task created: ' + title }),
    (e) => { // the card stays with what was typed, so the press can simply be repeated
      taskBusy = false;
      taskError.textContent = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      taskError.hidden = false;
    });
}
taskTitle.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 'k') closeTask({ palette: true });
  else if (e.key === 'Escape') closeTask();
  else if (e.key === 'Enter') createTask();
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && taskTypes.length > 1) { taskAt = (taskAt + (e.key === 'ArrowDown' ? 1 : taskTypes.length - 1)) % taskTypes.length; drawTypes(); }
  else return;
  e.preventDefault();
});
taskCard.addEventListener('mousedown', (e) => { if (e.target === taskCard) closeTask(); }); // the scrim, as with the palette
if (taskApi && taskApi.taskTypes) taskApi.taskTypes().then((list) => { taskTypes = [taskTypes[0], ...(Array.isArray(list) ? list : [])]; drawTypes(); }, () => {}); // no types: plain Task, no list
taskTitle.focus();

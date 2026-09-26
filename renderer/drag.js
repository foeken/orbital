'use strict';
// Dragging a row somewhere else: what can be picked up, the line that says where it will land, and the one write
// behind it (docs/OUTLINER.md). Two rules do the work. A row travels whole — its children come with it, because
// what is dragged is the node and not the line — and the level it lands on is chosen with the pointer's x,
// between the level of the row under the gap and one level inside the row above it, which is the only way one gap
// can mean both "after this row" and "inside that one".
// A page and the fields under its title are two outlines of one document (renderer/render.js renderFields), so a
// row can be dragged from either into the other; two different documents are refused, because a block belongs to
// the node that holds it.

const DRAG_TYPE = 'application/x-orbital-row'; // our own flavour: a drop on a text field elsewhere pastes nothing
const DRAG_STEP = 33;      // .children margin-left: how far one level is (styles.css)
const DRAG_STEP_LIST = 23; // a list row keeps its children 23px in, its own marker hanging left of them
const DRAG_GUTTER = 16;    // the gutter (11px) plus the body's 5px: where the words of a marker-less row start
let dragKey = null;        // the row being dragged, for as long as it is
let dropEl = null;         // the line, made the first time one is drawn

const dragBase = (docId) => String(docId).split('|')[0]; // a field's rows and the page's belong to one document
// Whether a row can be somebody's child: children live in a list, and Tana keeps a list row as a listItem whose
// first block is a paragraph, so a heading, a code block or an image standing on its own cannot be one. Beside a
// list row they are fine — the write splits the list there (sdk/content.js place) — so this rules out one drop,
// not a whole level.
const dragListable = (n) => ['bullet', 'numbered'].includes(n.block) || (!isAtomic(n) && !/^(heading|code)/.test(blockTypeOf(n)));
// An empty line is nothing to pick up: no words, no children, nothing drawn in it. An image and a divider have no
// words either and are very much things you would move, so they are not "empty".
const dragEmpty = (item) => !isAtomic(item.node) && !String(item.node.text || '').trim() && !hasKids(item);
// A document row can be dragged too, but it never moves: what lands is a reference to it (dragRef).
// Not on the Timeline (renderer/timeline.js): a record of what happened, not an outline, so nothing on it is picked up
// except the tasks under Today's Tasks, which can be dragged into My Tasks (dropOnGroup below).
const canDragItem = (item) => !!item && !item.node.draft && !item.node.timeline && (!item.parent?.node?.timeline || !!item.parent.node.timeline.today)
  && (item.node.kind === 'document' ? !!tana.insertMention && isRealId(item.node.id) && !isGone(item.node.id)
    : !!tana.moveTo && item.node.kind === 'block' && canEditStructure(item) && !dragEmpty(item));
// What a drop writes, decided by what was picked up rather than by a modifier: a document cannot move into an
// outline — it lives in Tana, not inside this node — so a reference to it lands where it was dropped, and
// everything else is the row itself, moving. (A block cannot be referenced at all: Tana's references are
// node-level, so there is no uri for a mention to a paragraph to point at.)
const dragRef = (item) => (item.node.kind === 'document' ? { uri: item.node.id, label: item.node.text || '' } : null);
const dragLine = (el) => el.querySelector(':scope > .line');
const rowDepth = (host, el) => { let d = 0; for (let p = el.parentElement; p && p !== host; p = p.parentElement) if (p.classList.contains('node')) d++; return d; };

// Which outline the pointer is asking for: the page's rows, or one field's. Never one list across both — they are
// different outlines, and a row crossing between them still has to land in one of them.
function dropHost(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || !el.closest) return null;
  return el.closest('.fvalues') || (outline.parentElement.contains(el) ? outline : null);
}
// Which level the pointer is asking for at a gap. Counted from the row above it, one step per level, and held
// between the row below it (nothing may sit shallower than the row it lands in front of) and one level inside the
// row above, which is offered only where that row can hold children at all.
function dropDepth(host, above, below, x) {
  const here = rowDepth(host, above);
  const deepest = here + (canInsertChild(items.get(above.dataset.key)) ? 1 : 0);
  const shallowest = below ? rowDepth(host, below) : 0;
  const asked = here + Math.round((x - dragLine(above).getBoundingClientRect().left) / DRAG_STEP);
  return Math.max(shallowest, Math.min(Math.max(shallowest, deepest), asked));
}
// The place a pointer is asking for: the row it lands behind, the row it lands inside, the outline that owns them
// and the line to draw for it. null where nothing can land — the top level of a view (a block is not a document),
// another document, a read-only row, or a list this row cannot join.
// files: image files from the Finder rather than a row (renderer/upload.js). They land behind a row only, since an
// image is never a row's first child and api.insertImage has no "first row" place.
function dropPlan(x, y, files = false) {
  const src = files ? null : items.get(dragKey), host = src || files ? dropHost(x, y) : null;
  if (!host) return null;
  const ref = src && dragRef(src);
  const dragged = nodeElOf(dragKey);
  // A draft row is not in the document yet (nothing can land behind a row the write cannot name), and a row on its
  // way out is not a place either. The gap above a draft tail is the end of the outline, which is where a drop
  // aimed at it belongs anyway.
  const rows = [...host.querySelectorAll('.node')].filter((el) => items.has(el.dataset.key)
    && !el.classList.contains('leaving') && !el.classList.contains('draft') && !(dragged && dragged.contains(el))); // .draft covers an upload's placeholder too
  let above = null;
  for (const el of rows) { const box = dragLine(el).getBoundingClientRect(); if (y < box.top + box.height / 2) break; above = el; }
  const below = rows[above ? rows.indexOf(above) + 1 : 0] || null;
  let after = null, parent = items.get(host.dataset.key || '') || null;
  if (above) {
    const depth = dropDepth(host, above, below, x);
    if (depth > rowDepth(host, above)) parent = items.get(above.dataset.key); // the first row inside the row above
    else { // out to the level it was dropped at, and in behind the row that sits there
      let el = above, d = rowDepth(host, above);
      while (d > depth) { el = el.parentElement.closest('.node'); d--; }
      after = items.get(el.dataset.key);
      parent = after.parent;
    }
  }
  if (after ? after.node.kind !== 'block' || !canEditStructure(after) : !parent || !canEditItem(parent) || (parent.node.kind === 'block' && !canInsertChild(parent))) return null;
  // A saved search lists what its query finds and a space lists the documents in it: neither has rows of its own
  // for something to land among.
  if (!after && (isSearchDoc(parent.node) || isTypeDoc(parent.node) || isSpace(parent.node))) return null;
  if (files && !after) return null;
  const docId = after ? after.docId : parent.docId;
  if (src && !ref && dragBase(docId) !== dragBase(src.docId)) return null; // a block belongs to the node that holds it
  if (src && !ref && !after && parent.node.kind === 'block' && !dragListable(src.node)) return null;
  if (ref && dragBase(docId) === ref.uri) return null; // a document does not hold a reference to itself
  const anchor = after ? nodeElOf(after.key) : above;
  // The line starts where the words of that level start: a row's own box plus the gutter it keeps for its marker,
  // so the top level lines up with an ordinary line rather than with a bullet hanging left of it. One level in is
  // the row's own children box where it has one, and otherwise the indent those children would be given.
  const kidsEl = !after && anchor ? anchor.querySelector(':scope > .children') : null;
  const box = (anchor ? kidsEl || anchor : host).getBoundingClientRect(), edge = host.getBoundingClientRect();
  const step = !anchor || after || kidsEl ? 0 : anchor.classList.contains('t-bullet') || anchor.classList.contains('t-numbered') ? DRAG_STEP_LIST : DRAG_STEP;
  const left = box.left + step + DRAG_GUTTER;
  return { parent, after, ref, docId, parentId: after || parent.node.kind !== 'block' ? null : parent.node.id, afterId: after ? after.node.id : null,
    // the line sits in the gap the pointer is in, at the level it chose: the row it lands behind may be several
    // levels up from the row above the gap, and it is the gap the eye is following
    left, top: above ? dragLine(above).getBoundingClientRect().bottom : edge.top, width: Math.max(40, edge.right - left) };
}
function showDrop(plan) {
  if (!plan) { if (dropEl) dropEl.hidden = true; return; }
  if (!dropEl) { dropEl = document.createElement('div'); dropEl.id = 'dropline'; document.body.append(dropEl); }
  dropEl.hidden = false;
  dropEl.style.left = plan.left + 'px';
  dropEl.style.top = plan.top + 'px';
  dropEl.style.width = plan.width + 'px';
}
// Dropped where it already is: same list, same place. Nothing to write, and no undo step to leave behind.
function sameSpot(src, plan) {
  if (plan.parent !== src.parent) return false;
  const sibs = childrenOf(src.parent) || [], at = sibs.indexOf(src.node);
  return plan.after ? sibs[at - 1] === plan.after.node : at === 0;
}
// The write, and putting the outline back together around it: the row it left may have been its parent's last
// child, and the row it landed in opens, so the node is where it was put rather than hidden inside a closed one.
async function applyDrop(key, plan) {
  const src = items.get(key);
  if (!src || (!plan.ref && sameSpot(src, plan))) return; // a reference is never a no-op: it is a new row either way
  await run(async () => {
    if (plan.ref) await tana.insertMention(plan.docId, plan.ref.uri, plan.ref.label, plan.parentId, plan.afterId);
    else {
      await tana.moveTo(src.docId, src.node.id, plan.docId, plan.parentId, plan.afterId);
      await reload(src.docId);
    }
    if (plan.ref || plan.docId !== src.docId) await reload(plan.docId);
  });
  if (plan.parentId) open.set(plan.parent.key, true);
  if (!plan.ref) closeIfEmpty(src.parent);
  render(true);
}
function endDrag() {
  for (const el of eachRow('.node.dragging')) el.classList.remove('dragging');
  dragKey = null;
  showDrop(null);
  showGroupDrop(null);
}

// ---- a task dropped on a group (#169) ----
// In My Tasks grouped by Responsibility, and on the Timeline's Today's Tasks, a drop between rows is not a place in
// an outline: it is a group, and landing in one means changing what the task is. The writes are read off the task
// as it stands rather than off the group it left, so a drop from the other pane — its own renderer, which only the
// dataTransfer crosses — decides the same way. Each group adds what it needs and takes away what would keep the
// task elsewhere, in the order responsibilityOf reads them: Agent, then a day pin. null: it cannot go there.
const TASK_DRAG_TYPE = 'application/x-orbital-task'; // { id, text, kind, icon, createdBy, stateType }, set for a task
const GROUP_STATES = { 'My inbox': 'proposed', Mine: 'open', 'My completed': 'closed', 'My later': 'not_now' };
function groupDropWrites(target, t, me, today) {
  const mine = !!me && t.createdBy === me, assigned = t.assignees.includes(me);
  const clear = [...(t.agent ? [['agent', false]] : []), ...t.dates.map((date) => ['unpin', date])];
  if (target === 'Today') return t.dates.some((date) => date <= today) ? [] : [['pin', today]];
  if (target === 'Pinned') return [...(t.dates.length ? [] : [['pin', today]]), ...(t.stateType === 'closed' ? [['state', 'open']] : [])];
  if (target === 'Agent') return t.agent ? [] : [['agent', true]];
  if (!mine) return null; // every other group is about tasks you made
  if (target === 'Unassigned') return [...clear, ...(t.assignees.length ? [['assign', []]] : [])];
  if (target === 'Tracking') return t.assignees.length && !assigned ? [...clear, ...(t.watched ? [] : [['watch', true]])] : null;
  const state = GROUP_STATES[target];
  if (!state) return null;
  // taken over: you become its only assignee, and the watch that followed it for somebody else is forgotten
  return [...clear, ...(assigned && t.assignees.length === 1 ? [] : [['assign', [me]]]), ...(t.stateType === state ? [] : [['state', state]]), ...(t.watched && !assigned ? [['watch', null]] : [])];
}
const GROUP_WRITES = {
  agent: (id) => tana.setCodex(id, false), // the Codex task stays; its link goes, as ⌘K Unassign from Agent does
  pin: (id, date) => tana.pin(id, 'today', date),
  unpin: (id, date) => tana.unpin(id, 'today', date),
  assign: (id, uris) => tana.setAssignees(id, uris),
  state: (id, state) => tana.setState(id, state),
  watch: (id, on) => tana.setNotify(id, on),
};
function dropOnGroup(task, target) {
  run(async () => {
    const [meta, pins] = await Promise.all([tana.taskMeta(task.id), tana.pinState(task.id)]);
    const writes = groupDropWrites(target, { ...task, assignees: meta.assignees, watched: meta.watched, dates: pins.dates, agent: codexIds.has(task.id) }, me()?.id, localDate());
    if (!writes) throw new Error('This task can\u2019t go under ' + target);
    if (writes.some(([op, on]) => op === 'agent' && on)) return openAgentPrompt(task); // it needs a prompt: nothing is written until it is sent
    for (const [op, arg] of writes) await GROUP_WRITES[op](task.id, arg);
    if (writes.some(([op]) => op === 'agent')) { codexIds.delete(task.id); agentStates.delete(task.id); patchCodex(task.id); }
    try { taskMetaById.set(task.id, await tana.taskMeta(task.id)); } catch { taskMetaById.delete(task.id); }
    notifyById.delete(task.id);
    if (held) held.groups.delete(task.id); // a row held in place by an earlier click would stay put: this one is meant to move
    loadPinned(true);
    render(true);
  });
}
// The group under the pointer: Today's Tasks on the Timeline, or the section of My Tasks it is in, heading and rows.
function groupAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit || !hit.closest || !outline.parentElement.contains(hit)) return null;
  for (let el = hit.closest('.node'); el; el = el.parentElement.closest('.node')) if (items.get(el.dataset.key)?.node.timeline?.today) return { id: 'Today', el };
  if (groupBy() !== 'responsibility') return null;
  let head = null;
  for (const h of outline.querySelectorAll('.ghead')) { if (h.getBoundingClientRect().top > y) break; head = h; }
  const id = head && head.dataset.group;
  return RESPONSIBILITY.includes(id) && id !== 'Assigned by others' ? { id, el: head } : null;
}
let groupDropEl = null;
function showGroupDrop(target) {
  const el = target ? target.el : null;
  if (el === groupDropEl) return;
  if (groupDropEl) groupDropEl.classList.remove('drop-into');
  groupDropEl = el;
  if (el) el.classList.add('drop-into');
}
document.addEventListener('dragstart', (e) => {
  const grip = e.target && e.target.closest ? e.target.closest('.bullet[draggable="true"], .line[draggable="true"]') : null;
  const row = grip && grip.closest('.node'), item = row && items.get(row.dataset.key);
  if (!item || !canDragItem(item)) return;
  flush(item.key); // what was typed into it is written first: the move carries the row as it stands
  dragKey = item.key;
  e.dataTransfer.effectAllowed = item.node.kind === 'document' ? 'link' : 'move';
  e.dataTransfer.setData(DRAG_TYPE, item.key);
  const n = item.node;
  if (isTask(n) && isRealId(n.id)) e.dataTransfer.setData(TASK_DRAG_TYPE, JSON.stringify({ id: n.id, text: n.text || '', kind: n.kind, icon: n.icon, createdBy: n.createdBy, stateType: stateOf(n) }));
  e.dataTransfer.setDragImage(dragLine(row), 8, 10);
  row.classList.add('dragging');
});
document.addEventListener('dragover', (e) => {
  if (!dragKey && e.dataTransfer.types.includes('Files')) { // files from the Finder: the same line, where an image can land
    const plan = dropPlan(e.clientX, e.clientY, true);
    showDrop(plan);
    if (plan) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
    return;
  }
  const task = e.dataTransfer.types.includes(TASK_DRAG_TYPE); // a task, maybe from the other pane, where dragKey is not set
  if (!dragKey && !task) return; // somebody else's drag — text out of a row, a file onto the window — is left alone
  // ponytail: every dragover measures every row on screen; a page of a few hundred rows is one cheap layout read.
  // If a very long page ever drags heavily, take the rects at dragstart and add the scroll delta.
  const plan = dragKey ? dropPlan(e.clientX, e.clientY) : null, group = !plan && task ? groupAt(e.clientX, e.clientY) : null;
  showDrop(plan);
  showGroupDrop(group);
  if (!plan && !group) return;
  e.preventDefault(); // only a place that can take the row accepts the drop
  e.dataTransfer.dropEffect = plan && !plan.ref ? 'move' : 'link';
});
document.addEventListener('drop', (e) => {
  if (!dragKey && e.dataTransfer.types.includes('Files')) {
    const plan = dropPlan(e.clientX, e.clientY, true), files = imageFiles(e.dataTransfer.files);
    showDrop(null);
    if (!plan) return;
    e.preventDefault(); // anything but an image is ignored here, rather than opened by the window
    if (files.length) uploadImages(plan.docId, plan.afterId, files).catch(showError);
    return;
  }
  const raw = e.dataTransfer.getData(TASK_DRAG_TYPE);
  if (!dragKey && !raw) return;
  e.preventDefault();
  const plan = dragKey ? dropPlan(e.clientX, e.clientY) : null, group = !plan && raw ? groupAt(e.clientX, e.clientY) : null, key = dragKey;
  endDrag();
  if (plan) applyDrop(key, plan);
  else if (group) dropOnGroup(JSON.parse(raw), group.id);
});
document.addEventListener('dragend', endDrag);
document.addEventListener('dragleave', (e) => { if (e.relatedTarget) return; showGroupDrop(null); if (!dragKey) showDrop(null); }); // dragged back out of the window, or into the other pane

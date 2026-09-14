'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
// Enough DOM for the inline renderer: elements with children, classes, dataset and textContent, plus text nodes.
const FAKE_DOM = `
  const textNode = (data) => ({ nodeType: 3, nodeName: '#text', data, get textContent() { return this.data; } });
  const makeEl = (tagName) => {
    const classes = new Set();
    return {
      nodeType: 1, tagName, nodeName: tagName.toUpperCase(), childNodes: [], dataset: {},
      classList: { add: (...names) => names.forEach((name) => classes.add(name)), contains: (name) => classes.has(name), toggle() {} },
      get className() { return [...classes].join(' '); },
      set className(value) { classes.clear(); for (const name of String(value).split(' ')) if (name) classes.add(name); },
      append(...kids) { this.childNodes.push(...kids); },
      replaceChildren(...kids) { this.childNodes = kids; },
      get textContent() { return this.childNodes.map((kid) => kid.textContent).join(''); },
      set textContent(value) { this.childNodes = [textNode(value)]; },
    };
  };
  const document = { createElement: makeEl, createTextNode: textNode };
`;

function functionSource(name) {
  const asyncStart = source.indexOf('async function ' + name + '(');
  const start = asyncStart >= 0 ? asyncStart : source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'renderer function ' + name + ' is present');
  let depth = 0, end = start;
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}' && --depth === 0) return source.slice(start, end + 1);
  }
  assert.fail('renderer function ' + name + ' is complete');
}

function sourceBetween(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.notEqual(from, -1, start + ' is present');
  assert.notEqual(to, -1, end + ' is present');
  return source.slice(from, to);
}

function runPinGrouping() {
  const pinRows = vm.runInNewContext(`
    const asDoc = (node) => ({ ...node, kind: 'document', text: node.title || node.text });
    const docRow = (node, hint, run) => ({ label: node.text, run });
    const openResult = () => {};
    const sectionOf = () => null;
    ${functionSource('pinRows')}
    pinRows;
  `);
  const rows = pinRows([
    { node: { id: 'scratch', title: 'Scratchpad' }, children: [] },
    { label: 'Foundry', children: [
      { node: { id: 'charter', title: 'Charter' }, children: [] },
      { node: { id: 'roadmap', title: 'Roadmap' }, children: [] },
    ] },
    { node: { id: 'test', title: 'Test Pin' }, children: [] },
  ]);
  assert.deepEqual(plain(rows.map((row) => [row.group, row.label])), [
    ['Pinned', 'Scratchpad'],
    ['Pinned', 'Test Pin'],
    ['Foundry', 'Charter'],
    ['Foundry', 'Roadmap'],
  ], 'unsectioned pins share one Pinned group before named folders');
}

function runTypingRenderStabilityCheck() {
  const api = vm.runInNewContext(`
    const row = { isConnected: true }, editor = { isContentEditable: true, closest: () => row };
    const titleEl = {}, outline = { contains: (el) => el === editor };
    const document = { activeElement: editor };
    let rendering = false, renderDeferred = false, renders = 0, caret = 17, scroll = 240;
    const renderOutline = () => { renders++; row.isConnected = false; document.activeElement = {}; caret = 0; scroll = 0; };
    ${functionSource('editingRow')}
    ${functionSource('render')}
    ({ trigger: (result) => render(result), blur: () => { document.activeElement = {}; render(); },
       state: () => ({ renders, deferred: renderDeferred, sameEditor: document.activeElement === editor, rowConnected: row.isConnected, caret, scroll }) });
  `);
  for (const trigger of ['audience metadata', 'sync refresh', 'members loaded', 'active sort/group']) api.trigger(trigger);
  assert.deepEqual(plain(api.state()), { renders: 0, deferred: true, sameEditor: true, rowConnected: true, caret: 17, scroll: 240 },
    'background renders leave the edited DOM row, caret and scroll untouched');
  api.blur();
  assert.deepEqual(plain(api.state()), { renders: 1, deferred: false, sameEditor: false, rowConnected: false, caret: 0, scroll: 0 },
    'the latest deferred state renders once editing ends');
}

async function runSelectionChecks() {
  const selection = sourceBetween('function selKeys()', '// ---- filter pills');
  const canEditStructure = sourceBetween('const canEditStructure =', 'const chatIcon =');
  const rendererHistory = functionSource('history');
  const makeHarness = (readOnly = false) => {
    const value = vm.runInNewContext(`
      const calls = [];
      const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, kind: 'block', editable: ${readOnly ? "id === 'b' ? false : true" : 'true'} }));
      const parentEl = { children: [] };
      const classes = () => ({ add() {}, contains: (name) => name === 'node' });
      const elFor = (node) => ({ dataset: { key: node.id }, parentElement: parentEl, classList: classes() });
      parentEl.children.push(...nodes.map(elFor));
      const items = new Map(nodes.map((node) => [node.id, { key: node.id, docId: 'doc', node, parent: {} }]));
      const undoStack = [], redoStack = [];
      let sel = null, caret, rendered = 0;
      const snapshot = () => nodes.map((node) => ({ ...node }));
      const restore = (saved) => {
        nodes.splice(0, nodes.length, ...saved.map((node) => ({ ...node })));
        parentEl.children.splice(0, parentEl.children.length, ...nodes.map(elFor));
        items.clear(); nodes.forEach((node) => items.set(node.id, { key: node.id, docId: 'doc', node, parent: {} }));
      };
      const mut = (fn) => { undoStack.push(snapshot()); redoStack.length = 0; return fn(); };
      const applyHistory = (from, to) => { const saved = from.pop(); if (!saved) return null; to.push(snapshot()); restore(saved); return 'doc'; };
      const nodeElOf = (key) => parentEl.children.find((el) => el.dataset.key === key);
      const nodeEls = () => parentEl.children;
      const childrenOf = () => nodes;
      const texts = () => parentEl.children;
      const keyOfEl = (el) => el.dataset.key;
      const placeCaret = (key) => { caret = key; };
      const focusAbove = () => { caret = 'above'; };
      const dropPending = () => {};
      const canEditItem = (item) => item.node.editable !== false;
      const isReference = () => false, isDivider = () => false, canEditNode = (node) => node && node.editable !== false;
      ${canEditStructure}
      const render = () => { rendered++; };
      const reload = async () => {};
      const run = async (fn) => fn();
      const flushAll = () => {}, focused = () => null, loadRoots = async () => {}, kids = new Map([['doc', nodes]]), caretNear = () => {};
      const open = new Map(), keyFor = (docId, node) => docId + '/' + node.id;
      let collapseMidway = false;
      const shift = (id, by) => { const node = nodes.find((item) => item.id === id); node.depth = (node.depth || 0) + by; };
      const tana = {
        indentMany: async (_docId, ids) => mut(() => { calls.push(['indentMany', [...ids]]); ids.forEach((id) => shift(id, 1)); }),
        outdentMany: async (_docId, ids) => mut(() => { calls.push(['outdentMany', [...ids]]); ids.forEach((id) => shift(id, -1)); }),
        indent: async (_docId, id) => mut(() => { calls.push(['indent', id]); shift(id, 1); if (collapseMidway) sel = { anchor: sel.focus, focus: sel.focus }; }),
        outdent: async (_docId, id) => mut(() => { calls.push(['outdent', id]); shift(id, -1); }),
        moveMany: async (_docId, ids, direction) => mut(() => {
          calls.push(['moveMany', [...ids], direction]);
          for (const id of direction === 'up' ? ids : [...ids].reverse()) {
            const i = nodes.findIndex((node) => node.id === id), j = i + (direction === 'up' ? -1 : 1);
            [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
            [parentEl.children[i], parentEl.children[j]] = [parentEl.children[j], parentEl.children[i]];
          }
        }),
        removeMany: async (_docId, ids) => mut(() => {
          calls.push(['removeMany', [...ids]]);
          for (const id of [...ids].reverse()) {
            const i = nodes.findIndex((node) => node.id === id);
            nodes.splice(i, 1); parentEl.children.splice(i, 1); items.delete(id);
          }
        }),
        undo: async () => applyHistory(undoStack, redoStack),
        redo: async () => applyHistory(redoStack, undoStack),
      };
      ${selection}
      ${rendererHistory}
      ({ set: (value) => { sel = value; }, keys: () => selKeys(), moveSel, removeSel, selKey,
        undo: () => history('undo'), redo: () => history('redo'),
        depths: () => nodes.map((node) => node.depth || 0), opened: () => [...open.keys()],
        noBatch: () => { delete tana.indentMany; delete tana.outdentMany; },
        collapseMidway: () => { collapseMidway = true; },
        state: () => ({ order: nodes.map((node) => node.id), sel, caret, calls, rendered }) });
    `);
    return value;
  };

  const move = makeHarness();
  move.set({ anchor: 'b', focus: 'c' });
  assert.deepEqual(plain(move.keys()), ['b', 'c'], 'selection spans visible sibling blocks');
  await move.moveSel(move.keys(), 'down');
  assert.deepEqual(plain(move.state()), {
    order: ['a', 'd', 'b', 'c'], sel: { anchor: 'b', focus: 'c' },
    calls: [['moveMany', ['b', 'c'], 'down']], rendered: 1,
  }, 'moving a selection down keeps its blocks adjacent and selected');
  await move.undo();
  assert.deepEqual(plain(move.state().order), ['a', 'b', 'c', 'd'], 'one undo restores the complete moved selection');
  await move.redo();
  assert.deepEqual(plain(move.state().order), ['a', 'd', 'b', 'c'], 'one redo reapplies the complete moved selection');

  const event = (metaKey = false, shiftKey = false) => ({ key: 'Backspace', metaKey, ctrlKey: false, shiftKey });
  const settle = () => new Promise(setImmediate);
  for (const [metaKey, shiftKey, label] of [[false, false, 'plain Backspace'], [true, true, 'Cmd+Shift+Backspace']]) {
    const remove = makeHarness();
    remove.set({ anchor: 'b', focus: 'c' });
    assert.equal(remove.selKey(event(metaKey, shiftKey)), true, label + ' is handled by the active selection');
    await settle();
    assert.deepEqual(plain(remove.state()), {
      order: ['a', 'd'], sel: null, caret: 'a',
      calls: [['removeMany', ['b', 'c']]], rendered: 1,
    }, label + ' removes every selected block and focuses the preceding block');
    await remove.undo();
    assert.deepEqual(plain(remove.state().order), ['a', 'b', 'c', 'd'], label + ' undo restores the complete selected range');
    await remove.redo();
    assert.deepEqual(plain(remove.state().order), ['a', 'd'], label + ' redo removes the complete selected range');
  }

  const readOnly = makeHarness(true);
  readOnly.set({ anchor: 'b', focus: 'c' });
  assert.equal(readOnly.selKey(event()), true, 'read-only selection consumes Backspace');
  await settle();
  assert.deepEqual(plain(readOnly.state()), {
    order: ['a', 'b', 'c', 'd'], sel: { anchor: 'b', focus: 'c' },
    calls: [], rendered: 0,
  }, 'read-only selection is not mutated');
  assert.equal(makeHarness().selKey(event()), false, 'Backspace without a node selection remains ordinary text editing');

  // Tab / Shift+Tab move the whole selection, as one call where the bridge has one, and the rows stay selected.
  const tab = (shiftKey = false) => ({ key: 'Tab', metaKey: false, ctrlKey: false, shiftKey });
  const indent = makeHarness();
  indent.set({ anchor: 'b', focus: 'c' });
  assert.equal(indent.selKey(tab()), true, 'Tab is handled by the active selection');
  await settle();
  assert.deepEqual(plain(indent.state().calls), [['indentMany', ['b', 'c']]], 'the whole range indents in one call, so it is one undo step');
  assert.deepEqual(plain(indent.depths()), [0, 1, 1, 0], 'every selected row moved, and only those');
  assert.deepEqual(plain(indent.state().sel), { anchor: 'b', focus: 'c' }, 'the same rows stay selected afterwards');
  assert.deepEqual(plain(indent.opened()), ['doc/a'], 'the row they indent under is opened so they stay visible');
  indent.selKey(tab(true));
  await settle();
  assert.deepEqual(plain(indent.depths()), [0, 0, 0, 0], 'Shift+Tab outdents the whole range again');

  const perRow = makeHarness();
  perRow.noBatch();
  perRow.set({ anchor: 'b', focus: 'c' });
  perRow.selKey(tab());
  await settle();
  assert.deepEqual(plain(perRow.state().calls), [['indent', 'b'], ['indent', 'c']], 'without a batched call the range still indents, in visual order');
  perRow.selKey(tab(true));
  await settle();
  assert.deepEqual(plain(perRow.state().calls.slice(2)), [['outdent', 'c'], ['outdent', 'b']], 'and outdents last-first, which is what keeps the order');
  const interrupted = makeHarness();
  interrupted.noBatch();
  interrupted.collapseMidway();
  interrupted.set({ anchor: 'b', focus: 'c' });
  interrupted.selKey(tab());
  await settle();
  assert.deepEqual(plain(interrupted.state().sel), { anchor: 'b', focus: 'c' }, 'a refresh landing halfway through does not leave the selection collapsed on one row');

  const top = makeHarness();
  top.set({ anchor: 'a', focus: 'b' });
  top.selKey(tab());
  await settle();
  assert.deepEqual(plain(top.state().calls), [], 'a range at the top has nothing to indent under, so nothing happens');

  const lockedTab = makeHarness(true);
  lockedTab.set({ anchor: 'b', focus: 'c' });
  assert.equal(lockedTab.selKey(tab()), true, 'a read-only selection consumes Tab');
  await settle();
  assert.deepEqual(plain(lockedTab.state().calls), [], 'but a read-only document is never indented');
}

function runAssignedDropdown() {
  const definitions = sourceBetween('const STATES =', 'function renderPills');
  const api = vm.runInNewContext(`
    let view = 'tasks';
    let taskF = { states: ['open'], assignee: 'me' }, libF = {};
    let members = [
      { id: 'me', title: 'André', me: true },
      { id: 'lex', title: 'Lex' },
      { id: 'brage', title: 'Brage' },
    ];
    let saved;
    const tana = {};
    const $ = () => ({ hidden: false });
    const renderPills = () => {};
    const showError = () => {};
    const setTaskF = (patch) => { saved = patch; taskF = { ...taskF, ...patch }; };
    const setLibF = () => {};
    let showMcp = false;
    const setMcp = () => {};
    const groupPref = {}, sortPref = {}, render = () => {};
    ${definitions}
    ({ pillDefs, saved: () => saved });
  `);
  const assigned = api.pillDefs().find((definition) => definition.id === 'assigned');
  assert.equal(assigned.value, 'You (André)');
  const rows = assigned.rows();
  assert.deepEqual(plain(rows.filter((row) => row.label).map((row) => row.label)), ['Anyone', 'You (André)', 'Unassigned', 'Lex', 'Brage']);
  rows.find((row) => row.label === 'Lex').run();
  assert.deepEqual(plain(api.saved()), { assignee: 'lex' }, 'member choice updates the task assignee filter');
}

function runEditabilityCheck() {
  const editability = sourceBetween('const canEditNode =', 'const chatIcon =');
  const api = vm.runInNewContext(`
    const docs = new Map([['member', { editable: false }], ['doc', { editable: true }], ['unknown', { editable: null }]]);
    const docOf = (id) => docs.get(id);
    ${editability}
    ({ canEditNode, canEditItem });
  `);
  assert.equal(api.canEditItem({ docId: 'member', node: { editable: false } }), false, 'member profile is not editable');
  assert.equal(api.canEditItem({ docId: 'doc', node: { editable: true } }), true, 'editable document remains editable');
  assert.equal(api.canEditItem({ docId: 'unknown', node: { editable: null } }), true, 'unknown permissions remain editable');

  const start = source.indexOf("outline.addEventListener('keydown', (e) => {");
  const end = source.indexOf("outline.addEventListener('input'", start);
  assert.notEqual(start, -1, 'outline editing keyboard handler is present');
  const runKey = (editable) => {
    const context = { listener: undefined };
    vm.runInNewContext(`
      let mutation = 0;
      const editable = ${JSON.stringify(editable)};
      const outline = { addEventListener: (_name, fn) => { listener = fn; } };
      const item = { key: 'row', docId: 'row', node: { kind: 'document', editable, text: 'Row' } };
      const items = new Map([['row', item]]);
      const keyOfEl = () => 'row';
      const caretOffset = () => 0, getSelection = () => ({ isCollapsed: true });
      const isImage = () => false, isOpen = () => false, zoom = null;
      const canEditItem = (item) => item.node.editable !== false;
      const isReference = () => false, canEditStructure = (item) => canEditItem(item);
      const flush = () => {}, extendSel = () => {}, startLink = () => {}, toggleDone = () => { mutation++; };
      const insertAtCaret = () => { mutation++; }, draftDoc = () => { mutation++; }, splitNode = () => { mutation++; };
      const shiftNode = () => { mutation++; }, removeNode = () => { mutation++; }, setOpen = () => { mutation++; };
      const atEdge = () => false, moveTo = () => {}, selectionOffsets = () => null;
      const focusAbove = () => {}, texts = () => [], placeCaret = () => {};
      const isAtomic = () => false, MARK_KEYS = { b: 'bold', i: 'italic', e: 'code' };
      const toolbarEl = { hidden: true }, returnToSelection = () => {}, focusToolbar = () => {}, toggleMarkKey = () => {};
      ${source.slice(start, end)}
      Object.assign(globalThis, { mutation: () => mutation });
    `, context);
    const event = { key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, target: { closest: () => ({ textContent: 'Row' }) }, preventDefault: () => {} };
    context.listener(event);
    return context.mutation();
  };
  assert.equal(runKey(false), 0, 'read-only member keyboard input cannot create or mutate a node');
  assert.equal(runKey(true), 1, 'editable document keyboard input still uses the editor');
}

async function runCheckboxCheck() {
  const toggleCheckbox = functionSource('toggleCheckbox');
  const makeHarness = (done, editable = true) => vm.runInNewContext(`
    const editable = ${JSON.stringify(editable)};
    const node = { id: 'block', kind: 'block', editable, done: ${JSON.stringify(done)} };
    const item = { docId: 'doc', node };
    const calls = [];
    const canEditItem = (candidate) => candidate.node.editable !== false;
    const tana = { toggleCheckbox: async (docId, id) => { calls.push([docId, id]); node.done = node.done == null ? 0 : node.done ? 0 : 1; } };
    const reload = async () => {};
    const run = async (fn) => fn();
    ${toggleCheckbox}
    ({ toggle: () => toggleCheckbox(item), state: () => ({ done: node.done, calls }) });
  `);
  const fresh = makeHarness(undefined);
  await fresh.toggle();
  assert.deepEqual(plain(fresh.state()), { done: 0, calls: [['doc', 'block']] }, 'Cmd+Enter can convert an eligible plain block to an unchecked native checkbox');
  const checked = makeHarness(0);
  await checked.toggle();
  assert.deepEqual(plain(checked.state()), { done: 1, calls: [['doc', 'block']] }, 'Cmd+Enter toggles an existing native checkbox');
  const readOnly = makeHarness(undefined, false);
  await readOnly.toggle();
  assert.deepEqual(plain(readOnly.state()), { calls: [] }, 'read-only block cannot become a checkbox');
}

async function runCheckboxInheritanceCheck() {
  const splitNode = functionSource('splitNode');
  const inheritCheckbox = functionSource('inheritCheckbox');
  const draftNode = vm.runInNewContext(functionSource('draftNode') + '; draftNode');
  const makeHarness = (asChild) => vm.runInNewContext(`
    const asChild = ${JSON.stringify(asChild)};
    const calls = [];
    const node = { id: 'checkbox', kind: 'block', text: 'Checkbox', done: 1, children: ${asChild ? "[{ id: 'existing', kind: 'block', text: 'Existing' }]" : '[]'} };
    const nodes = [node];
    const item = { key: 'doc/checkbox', docId: 'doc', node, parent: {} };
    const kids = new Map([['doc', nodes]]), open = new Map();
    const canEditItem = () => true;
    const locate = ${functionSource('locate')};
    const readSegs = () => [{ text: 'Checkbox' }], splitSegs = (segs) => [segs, []], plainOf = (segs) => segs.map((s) => s.text || '').join('');
    const segsOf = (value) => [{ text: value.text }], saveValue = (value) => value;
    const hasKids = () => ${asChild}, isOpen = () => ${asChild};
    const dropPending = () => {}, reload = async () => {}, render = () => {}, placeCaret = () => {};
    const run = async (fn) => fn();
    let seq = 0;
    const tana = {
      setText: async () => { calls.push('setText'); },
      insertAfter: async () => { const child = { id: 'new' + (++seq), kind: 'block', text: '', done: 0 }; nodes.push(child); calls.push('insertAfter'); return child.id; },
      insertChild: async () => { const child = { id: 'new' + (++seq), kind: 'block', text: '', done: 0 }; node.children.push(child); calls.push('insertChild'); return child.id; },
    };
    ${inheritCheckbox}
    ${splitNode}
    ({ split: () => splitNode(item, {}, 'Checkbox'.length), state: () => ({ calls, child: asChild ? node.children.at(-1) : nodes.at(-1) }) });
  `);
  const after = makeHarness(false);
  await after.split();
  assert.deepEqual(plain(after.state()), {
    calls: ['insertAfter'], child: { id: 'new1', kind: 'block', text: '', done: 0 },
  }, 'Enter after a checkbox keeps the new sibling as an unchecked native checkbox');
  const under = makeHarness(true);
  await under.split();
  assert.deepEqual(plain(under.state()), {
    calls: ['insertChild'], child: { id: 'new1', kind: 'block', text: '', done: 0 },
  }, 'Enter under a checkbox converts the new child to an unchecked native checkbox');
  assert.deepEqual(plain(draftNode({ key: 'doc/checkbox', node: { kind: 'block', done: 1 } })), { id: 'draft:doc/checkbox', text: '', kind: 'block', done: 0, draft: true }, 'empty checkbox draft is unchecked and local-only until input materialises it');
}

async function runTaskChildCheckboxScopeCheck() {
  const referenceDisplay = sourceBetween('const isReference =', 'const showError =');
  const canExpand = sourceBetween('const canExpand =', 'function draftNode');
  const api = vm.runInNewContext(`
    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const localDate = () => '2026-09-13';
    const segsOf = (value) => Array.isArray(value) ? value : typeof value === 'string' ? (value ? [{ text: value }] : []) : value.segments || (value.text ? [{ text: value.text }] : []);
    const plainOf = (value) => segsOf(value).map((segment) => 'text' in segment ? segment.text : segment.mention.label).join('');
    ${functionSource('locate')}
    ${functionSource('mockApi')}
    mockApi();
  `, { structuredClone, setTimeout, clearTimeout, Date, Promise });

  const taskId = 'mockdoc0';
  const initial = (await api.children(taskId)).filter((node) => node.type == null); // the fixture also carries image and reference blocks
  assert.ok(initial.length > 0, 'task fixture has ordinary paragraph children');
  assert.ok(initial.every((node) => node.done == null), 'ordinary paragraphs under a task render as plain blocks');

  const renderBlock = vm.runInNewContext(`
    const items = new Map(), open = new Map(), pending = new Map();
    const docOf = () => ({ editable: true });
    const keyFor = (docId, node) => node.kind === 'document' ? docId : docId + '/' + node.id;
    const mkItem = (docId, node, parent) => { const item = { key: keyFor(docId, node), docId, node, parent }; items.set(item.key, item); return item; };
    const hasKids = () => false, isOpen = () => false, setOpen = () => {}, zoomTo = () => {};
    const renderSegs = () => {}, segsOf = () => [], asDoc = (node) => ({ ...node, kind: 'document', text: node.text ?? node.title ?? '' });
    const isImage = () => false, taskSummary = () => null, chipEl = () => ({});
    const isDivider = () => false;
    const documentSummary = () => null, observeMeta = () => {};
    ${sourceBetween('// Block types (api.setBlockType)', 'const images = new Map()')}
    const tana = {};
    const document = { createElement: (tagName) => {
      const classes = new Set();
      return { tagName, children: [], dataset: {}, style: { setProperty() {} }, classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      }, append(...children) { this.children.push(...children); } };
    } };
    ${referenceDisplay}
    ${sourceBetween('const isTask =', 'const chatIcon =')}
    ${canExpand}
    ${functionSource('nodeEl')}
    const count = (el) => (el.tagName === 'input' ? 1 : 0) + el.children.reduce((total, child) => total + count(child), 0);
    (node) => count(nodeEl(node, 'task', { node: { kind: 'document', editable: true } }));
  `);
  assert.equal(renderBlock(initial[0]), 0, 'renderer draws an ordinary task child without a checkbox');

  const taskChild = await api.insertAfter(taskId, null, 'Plain task child');
  const afterTaskChild = await api.children(taskId);
  assert.equal(afterTaskChild.find((node) => node.id === taskChild).done, undefined, 'inserting into a task document creates a plain child');

  const checkbox = initial[0];
  await api.toggleCheckbox(taskId, checkbox.id);
  const sibling = await api.insertAfter(taskId, checkbox.id, 'Checkbox sibling');
  const afterCheckbox = await api.children(taskId);
  assert.equal(afterCheckbox.find((node) => node.id === sibling).done, 0, 'a sibling after an explicit checkbox inherits unchecked formatting');
  assert.equal(renderBlock(afterCheckbox.find((node) => node.id === sibling)), 1, 'renderer draws the explicit checkbox sibling as a checkbox');

  const ordinary = afterCheckbox.find((node) => node.id === taskChild);
  const descendant = await api.insertChild(taskId, ordinary.id, 'Plain descendant');
  const finalChildren = await api.children(taskId);
  const finalOrdinary = finalChildren.find((node) => node.id === ordinary.id);
  assert.equal(finalOrdinary.children.find((node) => node.id === descendant).done, undefined, 'task and checkbox state do not blanket-inherit into descendants of ordinary blocks');
}

async function runStalePaletteInvalidationCheck() {
  const liveUpdates = sourceBetween('tana.onChanged((docId) => {', 'tana.onStatus(showStatus);');
  const recent = sourceBetween('const recent =', 'function recordRecent');
  const helpers = [functionSource('forgetRecent'), functionSource('prunedPins'), functionSource('invalidatePinCaches'), functionSource('invalidateNode')].join('\n');
  const context = {};
  vm.runInNewContext(`
    const goneId = 'tana:text:01j0stale0000000000000000';
    const keptId = 'tana:text:01j0keep00000000000000000';
    let listener, removeListener, unpinListener;
    let pinTree = [
      { node: { id: goneId, title: 'alpha' }, children: [] },
      { node: { id: keptId, title: 'beta' }, children: [] },
    ];
    let remoteTree = [
      { node: { id: goneId, title: 'alpha' }, children: [] },
      { node: { id: keptId, title: 'beta' }, children: [] },
    ];
    const storage = new Map([['recent', JSON.stringify([
      { id: goneId, title: 'alpha' }, { id: keptId, title: 'beta' },
    ])]]);
    const localStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
    const asDoc = (node) => ({ ...node, id: node.id, text: node.text ?? node.title, kind: 'document' });
    const docRow = (node) => ({ node, label: node.text });
    const openResult = () => {}, sectionOf = () => null;
    ${functionSource('pinRows')}
    ${recent}
    let sections = [], libRows = null, chatRows = null, palRows = [], palDoc = null, pinInfo = null, dropDoc = null;
    let zoom = { docId: keptId };
    const taskMetaById = new Map(), kids = new Map(), extra = new Map(), paths = new Map(), fresh = new Map();
    const loadRoots = async () => {};
    const reload = async () => {};
    const loadPins = async () => { pinTree = await tana.pinTree(); };
    const loadChats = () => {};
    const loadView = () => {};
    const render = () => {};
    const showError = (error) => { throw error; };
    const view = 'tasks';
    const tana = {
      pinTree: async () => remoteTree,
      onChanged: (callback) => { listener = callback; },
      onRemoved: (callback) => { removeListener = callback; },
      onUnpinned: (callback) => { unpinListener = callback; },
    };
    ${helpers}
    ${liveUpdates}
    Object.assign(globalThis, {
      update: (id) => listener(id),
      removed: (id) => { remoteTree = [{ node: { id: keptId, title: 'beta' }, children: [] }]; removeListener(id); },
      unpinned: (id) => { remoteTree = [{ node: { id: keptId, title: 'beta' }, children: [] }]; unpinListener(id); },
      state: () => ({ pins: pinRows(pinTree).map((row) => row.node.id), recent: recent().map((node) => node.id), zoom: zoom && zoom.docId }),
    });
  `, context);
  context.update('tana:text:01j0keep00000000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state()), {
    pins: ['tana:text:01j0stale0000000000000000', 'tana:text:01j0keep00000000000000000'],
    recent: ['tana:text:01j0stale0000000000000000', 'tana:text:01j0keep00000000000000000'],
    zoom: 'tana:text:01j0keep00000000000000000',
  }, 'an ordinary string update retains Cmd+K pins, recently viewed rows, and zoom state');

  context.update(null);
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state()), {
    pins: ['tana:text:01j0stale0000000000000000', 'tana:text:01j0keep00000000000000000'],
    recent: ['tana:text:01j0stale0000000000000000', 'tana:text:01j0keep00000000000000000'],
    zoom: 'tana:text:01j0keep00000000000000000',
  }, 'a general null update refreshes data without evicting Cmd+K state');

  context.unpinned('tana:text:01j0stale0000000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state()), {
    pins: ['tana:text:01j0keep00000000000000000'],
    recent: ['tana:text:01j0stale0000000000000000', 'tana:text:01j0keep00000000000000000'],
    zoom: 'tana:text:01j0keep00000000000000000',
  }, 'an explicit unpin event removes only the pinned Cmd+K row');

  context.removed('tana:text:01j0stale0000000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state()), {
    pins: ['tana:text:01j0keep00000000000000000'],
    recent: ['tana:text:01j0keep00000000000000000'],
    zoom: 'tana:text:01j0keep00000000000000000',
  }, 'an explicit removal event evicts only its exact ID from Cmd+K pins and recently viewed rows');
}

function runReferenceEmbedRenderCheck() {
  const presentation = sourceBetween('const isTask =', 'const chatIcon =');
  const referenceDisplay = sourceBetween('const isReference =', 'const showError =');
  const canExpand = sourceBetween('const canExpand =', 'function draftNode');
  const api = vm.runInNewContext(`
    const items = new Map(), open = new Map(), pending = new Map();
    const docOf = () => ({ editable: true });
    const keyFor = (docId, node) => node.kind === 'document' ? docId : docId + '/' + node.id;
    const mkItem = (docId, node, parent) => { const item = { key: keyFor(docId, node), docId, node, parent }; items.set(item.key, item); return item; };
    const hasKids = () => false, isOpen = () => false, setOpen = () => {}, zoomTo = () => {};
    const rendered = new Map();
    const renderSegs = (el, segs) => { rendered.set(el, segs); }, segsOf = (node) => node.segments || (node.text ? [{ text: node.text }] : []);
    const isDivider = () => false;
    ${sourceBetween('// Block types (api.setBlockType)', 'const images = new Map()')}
    const asDoc = (node) => ({ ...node, kind: 'document', text: node.text ?? node.title ?? '' });
    const isImage = () => false, taskSummary = () => null, chipEl = () => ({}), iconSvg = () => '';
    const documentSummary = () => null, observeMeta = () => {};
    const tana = {};
    const document = { createElement: (tagName) => {
      const classes = new Set();
      return { tagName, children: [], dataset: {}, style: { setProperty() {} }, classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      }, append(...children) { this.children.push(...children); } };
    } };
    ${referenceDisplay}
    ${presentation}
    ${canExpand}
    ${functionSource('nodeEl')}
    (targetEditable) => {
      const embedded = {
        id: 'block-identity', kind: 'block', type: 'reference', editable: false,
        text: 'native embed text', segments: [{ text: 'native embed text' }],
        reference: { uri: 'tana:text:01j0target000000000000000', label: 'Fallback label', node: { id: 'tana:text:01j0target000000000000000', text: 'Resolved target', kind: 'document', editable: targetEditable } },
      };
      const el = nodeEl(embedded, 'tana:doc:01j0container000000000000', { node: { kind: 'document', editable: true } });
      const text = el.children[0].children.at(-1).children[0];
      return { key: el.dataset.key, editable: text.contentEditable === 'plaintext-only', rendered: rendered.get(text) };
    };
  `);
  assert.deepEqual(plain(api(true)), {
    key: 'tana:doc:01j0container000000000000/block-identity',
    editable: true,
    rendered: [{ text: 'Resolved target' }],
  }, 'a resolved reference embed displays its target and edits that target, keeping the original block identity');
  assert.deepEqual(plain(api(false)), {
    key: 'tana:doc:01j0container000000000000/block-identity',
    editable: false,
    rendered: [{ text: 'Resolved target' }],
  }, 'a reference to a read-only target stays read-only');
}

async function runVisibilityPickerCheck() {
  const applySharing = functionSource('applySharing');
  const visibilityPeopleRows = functionSource('visibilityPeopleRows');
  const api = vm.runInNewContext(`
    const calls = [];
    let palDoc = { id: 'tana:text:01j0doc000000000000000000', kind: 'document' };
    let visibilityPeople = new Set(), visibilityRoles = new Map();
    const members = [{ id: 'tana:user-profile:01j0person000000000000000', title: 'Member One', me: false }];
    const memberName = (id) => members.find((member) => member.id === id).title;
    const loadMembers = () => {};
    const renderPalette = () => {};
    const accessById = new Map(), taskMetaById = new Map();
    const tana = { setSharing: async (id, selection) => { calls.push([id, selection]); } };
    const run = (fn) => fn();
    const loadRoots = async () => {};
    const render = () => {};
    ${applySharing}
    ${visibilityPeopleRows}
    ({
      rows: () => visibilityPeopleRows(''),
      state: () => ({ calls, selected: [...visibilityPeople] }),
    });
  `);
  const rows = api.rows();
  assert.deepEqual(plain(api.state()), { calls: [], selected: [] }, 'opening the visibility picker does not write sharing');
  rows.find((row) => row.label === 'Member One').run();
  assert.deepEqual(plain(api.state()), { calls: [], selected: ['tana:user-profile:01j0person000000000000000'] }, 'choosing a picker row stages the selection without mutation');
  api.rows().find((row) => row.label === 'Apply selected people').run();
  await Promise.resolve();
  assert.deepEqual(plain(api.state()), {
    calls: [['tana:text:01j0doc000000000000000000', { rule: 'people', participants: [{ uri: 'tana:user-profile:01j0person000000000000000', role: 'editor' }] }]],
    selected: ['tana:user-profile:01j0person000000000000000'],
  }, 'the visibility picker writes only after explicit Apply');
}

async function runLinkPaletteCheck() {
  const resultRows = functionSource('resultRows');
  const searchNow = functionSource('searchNow');
  const start = source.indexOf("palInput.addEventListener('keydown', (e) => {");
  const end = source.indexOf("palette.addEventListener", start);
  assert.notEqual(start, -1, '@ palette keyboard handler is present');
  const context = { resolveSearch: undefined, press: undefined };
  vm.runInNewContext(`
    let linkCtx = { text: 'Roni', item: {}, segs: [], start: 0, end: 4 }, pinCtx = null;
    let palRows = [], palIndex = 0, palBusy = false, palSeq = 0, palTimer = null, palMode = 'search';
    let searchResolve, actions = [];
    const palInput = { value: 'Roni', addEventListener: (_name, fn) => { press = fn; } };
    const tana = { search: () => new Promise((resolve) => { searchResolve = resolve; }) };
    const asDoc = (node) => ({ ...node, text: node.text || node.title, kind: 'document' });
    const docRow = (node, hint, run) => ({ label: node.text, node, hint, run });
    const createAndLink = () => { actions.push('create'); };
    const linkTo = () => { actions.push('link'); };
    const openResult = () => { actions.push('open'); };
    const renderPalette = () => {};
    const showError = (error) => { throw error; };
    const runRow = (row) => row.run();
    ${resultRows}
    ${searchNow}
    ${source.slice(start, end)}
    searchNow();
    Object.assign(globalThis, {
      resolveSearch: (rows) => searchResolve(rows),
      state: () => ({ palIndex, rows: palRows.map((row) => ({ label: row.label, create: !!row.create })), actions }),
    });
  `, context);
  context.resolveSearch([{ id: 'tana:user-profile:roni', title: 'Roni Wiener' }]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(plain(context.state().rows), [
    { label: 'Create “Roni”', create: true },
    { label: 'Roni Wiener', create: false },
  ], 'link search keeps Create available but returns the existing Roni result');
  assert.equal(context.state().palIndex, 1, 'async link search selects the first existing result');
  const event = (metaKey) => ({ key: 'Enter', metaKey, ctrlKey: false, shiftKey: false, preventDefault: () => {}, stopPropagation: () => {} });
  context.press(event(false));
  context.press(event(true));
  assert.deepEqual(plain(context.state().actions), ['link', 'create'], 'Enter links the selected result and Cmd+Enter explicitly creates');
}

function runAuthPaletteCheck() {
  const authView = functionSource('authView');
  const showStatus = functionSource('showStatus');
  const paletteRows = functionSource('paletteRows');
  const api = vm.runInNewContext(`
    let authed, authChecking, connected, signedOut;
    const loginBox = {}, filtered = {};
    const outline = {};
    const $ = (id) => id === 'loginBox' ? loginBox : id === 'filtered' ? filtered : {};
    const showError = () => {};
    const render = () => {};
    const sections = [];
    const pinTree = [];
    const pinRows = () => [];
    const pillCommandRows = () => [];
    const tana = { refresh: async () => {}, login: async () => {} };
    const run = () => {};
    const pinInfo = null, palDoc = null, hotkeys = {}, theme = 'light';
    const localDate = () => '2026-09-13';
    const setIcon = () => {};
    const setTheme = () => {};
    const startDrop = () => {};
    const docRow = () => ({});
    const sectionOf = () => null;
    ${authView}
    ${showStatus}
    ${paletteRows}
    ({ showStatus, paletteRows, state: () => ({ authed, authChecking, signedOut, loginHidden: loginBox.hidden }) });
  `);
  api.showStatus({ authenticated: null, authChecking: false, error: new Error('probe failed') });
  assert.deepEqual(plain(api.state()), { authed: false, authChecking: false, signedOut: false, loginHidden: true }, 'failed session probe keeps the login button hidden');
  assert.equal(api.paletteRows('').some((row) => row.id === 'login'), false, 'failed session probe has no Cmd+K login action');
}

function runSyncShortcutCheck() {
  const anchor = source.indexOf("filterEl.addEventListener('keydown'");
  const start = source.indexOf("document.addEventListener('keydown', (e) => {", anchor);
  const end = source.indexOf('// ---- palette:', start);
  assert.notEqual(start, -1, 'outline keyboard handler is present');
  assert.notEqual(end, -1, 'outline keyboard handler is complete');
  const context = { handler: undefined };
  vm.runInNewContext(`
    const document = { activeElement: {}, addEventListener: (_name, fn) => { handler = fn; } };
    const filterEl = {};
    const dropDoc = null;
    const palette = { hidden: true };
    const tana = { refresh: () => { throw new Error('Sync must not run from Cmd+R'); } };
    const run = (fn) => fn();
    const hotkeys = {};
    const sel = null;
    const comboOf = () => '';
    const setZoom = () => {};
    const togglePalette = () => {};
    ${source.slice(start, end)}
  `, context);
  let prevented = false;
  context.handler({ key: 'r', metaKey: true, ctrlKey: false, shiftKey: false, defaultPrevented: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'Cmd+R remains available to the host instead of invoking Sync');

  const paletteRows = functionSource('paletteRows');
  const rows = vm.runInNewContext(`
    const sections = [], pinTree = [], pinRows = () => [];
    const pillCommandRows = () => [];
    const tana = { refresh: async () => {} }, run = () => {};
    const authed = true, authChecking = false, signedOut = false, pinInfo = null, palDoc = null, hotkeys = {}, theme = 'light';
    const localDate = () => '2026-09-13', setIcon = () => {}, setTheme = () => {}, startDrop = () => {};
    const docRow = () => ({}), sectionOf = () => null;
    ${paletteRows}
    paletteRows('');
  `);
  assert.equal(rows.find((row) => row.id === 'sync').kbd, undefined, 'Sync command has no Cmd+R shortcut label');
}

function runZoomShortcutCheck() {
  const anchor = source.indexOf("filterEl.addEventListener('keydown'");
  const start = source.indexOf("document.addEventListener('keydown', (e) => {", anchor);
  const end = source.indexOf('// ---- palette:', start);
  assert.notEqual(start, -1, 'global keyboard handler is present');
  const context = {};
  vm.runInNewContext(`
    let handler, zoomFactor = 1.21;
    const BASE_ZOOM = 0.91;
    const calls = [];
    const document = { activeElement: {}, addEventListener: (_name, listener) => { handler = listener; } };
    const filterEl = {}, dropDoc = null, palette = { hidden: true }, tana = {}, hotkeys = {}, sel = null, zoom = null;
    const comboOf = () => '', setZoom = (value) => { zoomFactor = value; calls.push(value); };
    const togglePalette = () => {}, runAction = () => {}, history = () => {}, texts = () => [], setCaret = () => {}, viewOf = () => null, draftDoc = () => {}, render = () => {};
    ${source.slice(start, end)}
    Object.assign(globalThis, { press: (event) => handler(event), state: () => ({ zoomFactor, calls }) });
  `, context);
  const event = (key, shiftKey) => ({ key, metaKey: true, ctrlKey: false, shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  context.press(event('0', false));
  context.press(event('+', true));
  context.press(event('-', true));
  assert.deepEqual(plain(context.state()), { zoomFactor: 0.91, calls: [0.91, 0.91 * 1.1, 0.91] }, 'Cmd+0 resets zoom to the default without Shift while Cmd+Shift+/- keep adjusting it');
}

function runZoomDeleteCheck() {
  const anchor = source.indexOf("filterEl.addEventListener('keydown'");
  const start = source.indexOf("document.addEventListener('keydown', (e) => {", anchor);
  const end = source.indexOf('// ---- palette:', start);
  const removeZoomedBlock = source.includes('function removeZoomedBlock(') ? functionSource('removeZoomedBlock') : '';
  assert.notEqual(start, -1, 'global keyboard handler is present');
  const context = {};
  vm.runInNewContext(`
    let handler;
    const removed = [];
    const body = {};
    const document = { body, activeElement: body, addEventListener: (_name, listener) => { handler = listener; } };
    const filterEl = {}, dropDoc = null, palette = { hidden: true }, tana = {}, hotkeys = {}, sel = null;
    const zoom = { docId: 'tana:text:01j0doc000000000000000000', nodeId: 'top-block' };
    const item = { key: 'tana:text:01j0doc000000000000000000/top-block', docId: zoom.docId, node: { id: 'top-block', kind: 'block' } };
    const items = new Map([[item.key, item]]);
    const comboOf = () => '', setZoom = () => {}, togglePalette = () => {}, runAction = () => {}, history = () => {}, texts = () => [], setCaret = () => {}, viewOf = () => null, draftDoc = () => {}, render = () => {};
    const removeNode = (candidate) => { removed.push(candidate.key); };
    const resolveZoom = () => [item];
    ${removeZoomedBlock}
    ${source.slice(start, end)}
    Object.assign(globalThis, { press: (event) => handler(event), state: () => ({ removed }) });
  `, context);
  let prevented = false;
  context.press({ key: 'Backspace', metaKey: true, ctrlKey: false, shiftKey: true, defaultPrevented: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'Cmd+Shift+Backspace is handled while zoomed into a top-level block');
  assert.deepEqual(plain(context.state()), { removed: ['tana:text:01j0doc000000000000000000/top-block'] }, 'Cmd+Shift+Backspace removes the zoomed top-level block');
}

async function runAssigneeCloseCheck() {
  const setTaskAssignees = functionSource('setTaskAssignees');
  const makeHarness = (fails) => {
    const context = {};
    vm.runInNewContext(`
      let closed = 0, error = null, queue = Promise.resolve();
      const calls = [];
      const doc = { id: 'tana:text:01j0task0000000000000000' };
      let palMode = 'assignees', palDoc = doc;
      const palette = { hidden: false };
      const taskMetaById = new Map([[doc.id, { assignees: [] }]]);
      const tana = { setAssignees: async (id, assignees) => { calls.push([id, assignees]); if (${JSON.stringify(fails)}) throw new Error('assignment denied'); } };
      const showError = (value) => { error = value.message; };
      const run = (fn) => Promise.resolve().then(fn).catch(showError);
      const render = () => {}, renderPalette = () => {}, closePalette = () => { closed++; palette.hidden = true; };
      ${setTaskAssignees}
      Object.assign(globalThis, { choose: () => setTaskAssignees(doc, ['tana:user-profile:01j0member0000000000000']), state: () => ({ calls, closed, error }) });
    `, context);
    return context;
  };
  const success = makeHarness(false);
  success.choose();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(plain(success.state()), {
    calls: [['tana:text:01j0task0000000000000000', ['tana:user-profile:01j0member0000000000000']]], closed: 1, error: null,
  }, 'a successful assignee update closes the picker');

  const failure = makeHarness(true);
  failure.choose();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(plain(failure.state()), {
    calls: [['tana:text:01j0task0000000000000000', ['tana:user-profile:01j0member0000000000000']]], closed: 0, error: 'assignment denied',
  }, 'a failed assignee update keeps the picker open and surfaces the error');
}

async function runPendingSplitDraftCheck() {
  const splitNode = functionSource('splitNode');
  const context = {};
  vm.runInNewContext(`
    const source = { id: 'source', kind: 'block', text: 'left-right', segments: [{ text: 'left-right' }], children: [] };
    const item = { key: 'doc/source', docId: 'doc', node: source, parent: { node: { kind: 'document' } } };
    let rows = [source], draftEl, releaseInsert, focus;
    const insertGate = new Promise((resolve) => { releaseInsert = resolve; });
    const kids = new Map([['doc', rows]]), items = new Map();
    const sourceEl = { segs: [{ text: 'left-right' }] };
    const calls = [], saves = [];
    const canEditItem = () => true, hasKids = () => false, isOpen = () => false;
    const readSegs = (el) => el.segs;
    const splitSegs = (segs, offset) => [[{ text: segs[0].text.slice(0, offset) }], [{ text: segs[0].text.slice(offset) }]];
    const plainOf = (segs) => segs.map((segment) => segment.text).join('');
    const dropPending = () => {}, saveValue = (value) => value;
    const render = () => {
      const draft = rows.find((node) => node.pendingSplit);
      if (draft) draftEl ||= { segs: draft.segments, offset: 0 };
      const real = rows.find((node) => node.id === 'inserted');
      if (real) items.set('doc/inserted', { key: 'doc/inserted', docId: 'doc', node: real });
    };
    const textEl = (key) => key.includes('draft:split:') ? draftEl : key === 'doc/inserted' ? { segs: [] } : null;
    const caretOffset = (el) => el.offset;
    const placeCaret = (key, offset) => { focus = { key, offset }; };
    const renderSegs = () => {};
    const scheduleSave = (candidate, segs) => saves.push([candidate.key, segs]);
    const reload = async () => { rows = [source, { id: 'inserted', kind: 'block', text: '-right', segments: [{ text: '-right' }], children: [] }]; kids.set('doc', rows); };
    const run = (fn) => fn();
    const tana = {
      setText: async (_docId, id) => { calls.push(['setText', id]); },
      insertAfter: async () => { calls.push(['insertAfter']); await insertGate; return 'inserted'; },
    };
    ${splitNode}
    Object.assign(globalThis, {
      start: () => splitNode(item, sourceEl, 4),
      type: (text) => { draftEl.segs = [{ text }]; draftEl.offset = text.length; },
      release: () => releaseInsert(),
      state: () => ({ rows: rows.map((node) => ({ id: node.id, draft: !!node.draft, pendingSplit: !!node.pendingSplit, text: node.text })), calls, saves, focus }),
    });
  `, context);
  const split = context.start();
  await Promise.resolve();
  assert.deepEqual(plain(context.state().rows), [
    { id: 'source', draft: false, pendingSplit: false, text: 'left' },
    { id: context.state().rows[1].id, draft: true, pendingSplit: true, text: '-right' },
  ], 'Enter immediately renders a pending draft while the split insertion is in flight');
  context.type('typed during insert');
  context.release();
  await split;
  assert.deepEqual(plain(context.state()), {
    rows: [
      { id: 'source', draft: false, pendingSplit: false, text: 'left' },
      { id: 'inserted', draft: false, pendingSplit: false, text: '-right' },
    ],
    calls: [['setText', 'source'], ['insertAfter']],
    saves: [['doc/inserted', [{ text: 'typed during insert' }]]],
    focus: { key: 'doc/inserted', offset: 19 },
  }, 'typing into the pending draft survives reload and saves to the inserted block');
}

// A row's bullet must sit at the same x in every state, so the chevron gutter can never leave the layout:
// nodeEl must not hide the chevron with the hidden attribute, and no stylesheet rule may take a .chev out of flow.
function runRowAlignmentCheck() {
  const presentation = sourceBetween('const isTask =', 'const chatIcon =');
  const referenceDisplay = sourceBetween('const isReference =', 'const showError =');
  const canExpand = sourceBetween('const canExpand =', 'function draftNode');
  const rowChevron = vm.runInNewContext(`
    const items = new Map(), open = new Map(), pending = new Map();
    const docOf = () => ({ editable: true });
    const keyFor = (docId, node) => node.kind === 'document' ? docId : docId + '/' + node.id;
    const mkItem = (docId, node, parent) => { const item = { key: keyFor(docId, node), docId, node, parent }; items.set(item.key, item); return item; };
    let kids = [];
    const hasKids = (item) => (item.node.hasChildren === true) || kids.length > 0;
    const isOpen = () => true, setOpen = () => {}, zoomTo = () => {}, ensureLoaded = () => {}, childrenOf = () => kids, isSpace = () => false, draftNode = () => ({ id: 'draft', kind: 'block', text: '', draft: true });
    const renderSegs = () => {}, segsOf = () => [], asDoc = (node) => ({ ...node, kind: 'document', text: node.text ?? node.title ?? '' });
    const isImage = () => false, taskSummary = () => null, chipEl = () => ({}), iconSvg = () => '';
    const childEl = () => document.createElement('div');
    const isDivider = () => false;
    const documentSummary = () => null, observeMeta = () => {};
    ${sourceBetween('// Block types (api.setBlockType)', 'const images = new Map()')}
    const tana = {};
    const document = { createElement: (tagName) => {
      const classes = new Set();
      return { tagName, children: [], dataset: {}, classes, style: { setProperty() {} }, classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
        contains: (name) => classes.has(name),
      }, append(...children) { this.children.push(...children); } };
    } };
    ${referenceDisplay}
    ${presentation}
    ${canExpand}
    ${functionSource('nodeEl')}
    (node, children) => { kids = children || []; const el = nodeEl(node, 'doc', { node: { kind: 'document', editable: true } }); const chev = el.children[0].children[0]; return { first: chev.tagName, hidden: chev.hidden === true, off: chev.classList.contains('off') }; };
  `, { structuredClone });
  const states = {
    'collapsed with children': [{ id: 'a', kind: 'document', text: 'a', hasChildren: true, editable: true }, []],
    'expanded with children': [{ id: 'b', kind: 'document', text: 'b', hasChildren: true, editable: true }, [{ id: 'k', kind: 'block', text: 'k', children: [] }]],
    'writable, no children': [{ id: 'c', kind: 'document', text: 'c', hasChildren: false, editable: true }, []],
    'read-only, children resolved empty': [{ id: 'd', kind: 'document', text: 'd', hasChildren: false, editable: false }, []],
    'draft row': [{ id: 'e', kind: 'document', text: '', draft: 'task', editable: true }, []],
    'inline reference': [{ id: 'f', kind: 'block', type: 'reference', editable: false, reference: { uri: 'x', node: { id: 'x', text: 'Target', kind: 'document' } }, children: [] }, []],
  };
  for (const [state, [node, children]] of Object.entries(states)) {
    const row = rowChevron(node, children);
    assert.equal(row.first, 'button', state + ': the row still starts with the chevron button');
    assert.equal(row.hidden, false, state + ': the chevron keeps its gutter instead of being removed from the layout');
  }
  const styles = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
  const chevRules = styles.split('\n').filter((line) => /(^|[\s,>])\.chev\b/.test(line) && !line.trim().startsWith('/*'));
  assert.ok(chevRules.length, 'styles.css styles the chevron');
  for (const rule of chevRules) assert.doesNotMatch(rule, /display:\s*none/, 'no stylesheet rule takes the chevron out of the layout: ' + rule.trim());
  assert.match(styles, /\.chev \{[^}]*width: 24px/, 'the chevron reserves a fixed gutter');
}

// A metadata read that fails while a brand-new document is still settling must be retried, not blacklisted for the session.
async function runTaskMetaRetryCheck() {
  const context = vm.createContext({ setTimeout, clearTimeout, Date, Promise });
  vm.runInContext(`
    const taskMetaById = new Map(), taskMetaLoading = new Set(), taskMetaFailed = new Map();
    ${source.match(/const META_RETRY_MS = \d+, META_RETRY_MAX = \d+;/)[0]}
    const palette = { hidden: true };
    let palDoc = null, connected = true, attempts = 0, renders = 0;
    const renderPalette = () => {};
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
    const render = () => { renders++; loadTaskMeta('tana:text:01j0newtask00000000000000'); }; // a render asks again, the way taskSummary does
    const tana = { taskMeta: async () => { attempts++; if (attempts === 1) throw new Error('document is still settling'); return { assignees: [], audience: 'only-me' }; } };
    ${functionSource('loadTaskMeta')}
    Object.assign(globalThis, {
      start: () => loadTaskMeta('tana:text:01j0newtask00000000000000'),
      state: () => ({ attempts, renders, audience: (taskMetaById.get('tana:text:01j0newtask00000000000000') || {}).audience || null, blocked: taskMetaFailed.has('tana:text:01j0newtask00000000000000') }),
    });
  `, context);
  context.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(plain(context.state()), { attempts: 1, renders: 0, audience: null, blocked: true }, 'the first metadata failure backs off instead of giving up');
  context.start();
  assert.equal(context.state().attempts, 1, 'the id is not hammered while the backoff runs');
  await new Promise((resolve) => setTimeout(resolve, 900));
  const settled = plain(context.state());
  assert.equal(settled.attempts, 2, 'the backoff expires and the metadata is requested again');
  assert.equal(settled.audience, 'only-me', 'the retry resolves the real visibility without a reload');
  assert.equal(settled.blocked, false, 'a successful retry clears the recorded failure');
}

// Palette arrows step over rows that cannot run (info lines, unavailable choices) instead of parking on a dead row.
function runPaletteSkipCheck() {
  const nextPalIndex = vm.runInNewContext(functionSource('nextPalIndex') + '; nextPalIndex;');
  const rows = [{ disabled: true }, { label: 'a' }, { disabled: true }, { label: 'b' }];
  assert.equal(nextPalIndex(rows, 1, 1), 3, 'Down skips a disabled row');
  assert.equal(nextPalIndex(rows, 3, 1), 1, 'Down wraps past a disabled first row');
  assert.equal(nextPalIndex(rows, 1, -1), 3, 'Up wraps backwards to the last runnable row');
  assert.equal(nextPalIndex([{ disabled: true }, { disabled: true }], 0, 1), 0, 'a list with nothing runnable stays put');
  const styles = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
  assert.match(styles, /\.palette \.row\.disabled \{/, 'a palette row that cannot run looks different from a runnable one');
}

// Formatting: marks survive the DOM round trip, and toggling one over a selection rewrites only that range.
// Every edit re-sends the whole block through api.setText, so a lossy read here would silently drop a user's marks.
function runFormattingChecks() {
  const segments = sourceBetween('// accepts segments, a plain string, or a Node', 'const tana = window.api');
  const api = vm.runInNewContext(`
    ${FAKE_DOM}
    ${segments}
    ({ renderSegs, readSegs, markRange, hasMark, saveValue, blank: () => document.createElement('span'),
       tags: (el) => { const out = []; (function walk(n) { for (const kid of n.childNodes) if (kid.nodeType === 1) { out.push(kid.nodeName + (kid.className ? '.' + kid.className : '')); walk(kid); } })(el); return out; } });
  `);
  const segs = [
    { text: 'plain ' },
    { text: 'bold', marks: { bold: true } },
    { text: ' ' },
    { text: 'both', marks: { bold: true, italic: true } },
    { mention: { label: 'Lex', uri: 'tana:user-profile:lex' } },
    { text: ' struck', marks: { strike: true } },
    { text: ' code', marks: { code: true } },
    { text: ' linked', marks: { link: 'https://example.com' } },
    { text: ' and a bare https://tana.inc URL' },
  ];
  const el = api.blank();
  api.renderSegs(el, segs);
  assert.deepEqual(plain(api.tags(el)), ['STRONG', 'STRONG', 'EM', 'A.mention', 'S', 'CODE', 'A.link', 'A.url'],
    'every mark renders as its own element, a link mark as an anchor beside the bare-URL one');
  assert.deepEqual(plain(api.readSegs(el)), segs, 'rendered marks read back as the same segments api.setText takes');

  const base = [{ text: 'hello world' }];
  const bolded = api.markRange(base, 0, 5, 'bold', true);
  assert.deepEqual(plain(bolded), [{ text: 'hello', marks: { bold: true } }, { text: ' world' }], 'a mark splits the run at the selection');
  assert.equal(api.hasMark(bolded, 0, 5, 'bold'), true, 'the marked range reads as marked, so the button is a toggle');
  assert.equal(api.hasMark(bolded, 0, 11, 'bold'), false, 'a partly marked range is not marked');
  assert.deepEqual(plain(api.markRange(bolded, 0, 5, 'bold', null)), base, 'toggling the mark off merges the runs back into one');
  assert.deepEqual(plain(api.markRange(bolded, 0, 5, 'link', 'https://tana.inc')),
    [{ text: 'hello', marks: { bold: true, link: 'https://tana.inc' } }, { text: ' world' }], 'marks stack on the same run');
  const withMention = [{ text: 'see ' }, { mention: { label: 'Lex', uri: 'u' } }, { text: ' now' }];
  assert.deepEqual(plain(api.markRange(withMention, 0, 11, 'bold', true)),
    [{ text: 'see ', marks: { bold: true } }, { mention: { label: 'Lex', uri: 'u' } }, { text: ' now', marks: { bold: true } }],
    'a mention inside the selection is left whole');
  assert.deepEqual(plain(api.saveValue([{ text: 'x', marks: { bold: true } }])), [{ text: 'x', marks: { bold: true } }], 'a marked run is saved as segments, not flattened to a string');
  assert.equal(api.saveValue([{ text: 'plain' }]), 'plain', 'unmarked text still saves as a plain string');
}

// The "/" menu: the block types, a divider, then the create choices; running a row drops the "/" and calls the contract.
function makeSlashHarness() {
  const blockTypes = sourceBetween('// Block types (api.setBlockType)', 'const images = new Map()');
  const context = vm.createContext({});
  vm.runInContext(`
    const calls = [];
    const node = { id: 'block', kind: 'block', text: '/', segments: [{ text: '/' }] };
    const item = { key: 'doc/block', docId: 'doc', node };
    const items = new Map([['doc/block', item]]);
    let slashCtx = { key: 'doc/block' };
    let creationChoices = [
      { id: 'task', kind: 'task', title: 'Task', icon: 'task', selectable: true },
      { id: 'tana:type:project', kind: 'custom', title: 'Project', hue: 268, selectable: true },
    ];
    let palBusy = false;
    ${blockTypes}
    const dropPending = () => {}, render = () => {};
    const iconSvg = () => '<svg></svg>'; // the real icon set is generated; the menu only needs a slot here
    const placeCaret = (key, offset) => calls.push(['caret', key, offset]);
    const reload = async () => { calls.push(['reload']); };
    const run = async (fn) => fn();
    const startCreation = (choice) => calls.push(['startCreation', choice.kind, choice.title]);
    const tana = {
      setText: async (docId, id, value) => calls.push(['setText', docId, id, value]),
      setBlockType: async (docId, id, type) => calls.push(['setBlockType', docId, id, type]),
      insertDivider: async (docId, id) => calls.push(['insertDivider', docId, id]),
    };
    ${functionSource('slashTarget')}
    ${functionSource('slashRows')}
    ${functionSource('runSlashBlock')}
    ${functionSource('createFromSlash')}
    Object.assign(globalThis, { rows: (q) => slashRows(q), calls: () => calls, text: () => node.text });
  `, context);
  return context;
}
async function runSlashMenuCheck() {
  const listing = makeSlashHarness();
  assert.deepEqual(plain(listing.rows('').map((row) => row.label)),
    ['Heading 1', 'Heading 2', 'Heading 3', 'Bullet List', 'Numbered List', 'Code Block', 'Quote', 'Divider', 'Create Doc', 'Create Task', 'Create Project'],
    'the "/" menu offers every block type, a divider, and the create choices');
  assert.deepEqual(plain(listing.rows('head').map((row) => row.label)), ['Heading 1', 'Heading 2', 'Heading 3'], 'typing filters the menu');

  const quote = makeSlashHarness();
  await quote.rows('').find((row) => row.label === 'Quote').run();
  assert.deepEqual(plain(quote.calls()), [['setText', 'doc', 'block', []], ['setBlockType', 'doc', 'block', 'quote'], ['reload'], ['caret', 'doc/block', 0]],
    'a block choice clears the "/" and sets the block type, leaving the caret in the node');
  assert.equal(quote.text(), '', 'the "/" is the command, not text left behind');

  const divider = makeSlashHarness();
  await divider.rows('').find((row) => row.label === 'Divider').run();
  assert.deepEqual(plain(divider.calls()), [['setText', 'doc', 'block', []], ['insertDivider', 'doc', 'block'], ['reload'], ['caret', 'doc/block', 0]],
    'Divider inserts a divider after the node instead of retyping it');

  const create = makeSlashHarness();
  create.rows('').find((row) => row.label === 'Create Project').run();
  assert.deepEqual(plain(create.calls()), [['setText', 'doc', 'block', []], ['startCreation', 'custom', 'Project']],
    'a create choice clears the "/" and starts the ordinary creation flow');
}

// A filter choice must stop covering the list it just filtered: single-choice rows close the menu, multi-select ticks stay.
function runFilterMenuCloseCheck() {
  const definitions = sourceBetween('const STATES =', 'function renderPills');
  const api = vm.runInNewContext(`
    let view = 'library';
    let taskF = { states: ['open'], assignee: 'me' }, libF = { types: ['tasks'], states: ['open'], assignee: 'me' };
    let members = [{ id: 'me', title: 'André', me: true }, { id: 'lex', title: 'Lex' }];
    let menu = null, showMcp = false;
    const tana = {};
    const $ = () => ({ hidden: false });
    const renderPills = () => {};
    const showError = () => {}, setMcp = () => {};
    const setTaskF = (patch) => { taskF = { ...taskF, ...patch }; };
    const setLibF = (patch) => { libF = { ...libF, ...patch }; };
    const groupPref = {}, sortPref = {}, render = () => {}, localStorage = { setItem() {} };
    ${definitions}
    ${functionSource('pickMenuRow')}
    ({ pick: (id, label) => {
        menu = { id, index: 0 };
        const rows = pillDefs().find((d) => d.id === id).rows().filter((r) => r.label);
        pickMenuRow(rows.find((r) => r.label === label), rows);
        return { open: !!menu, taskF, libF };
      },
      reset: () => { libF = { types: ['tasks'], states: ['open'], assignee: 'me' }; taskF = { states: ['open'], assignee: 'me' }; } });
  `);
  const anyType = api.pick('type', 'Any type');
  assert.deepEqual(plain(anyType), { open: false, taskF: { states: ['open'], assignee: 'me' }, libF: { types: null, states: ['open'], assignee: 'me' } },
    '"Any type" is a single choice: it applies and closes');
  api.reset();
  assert.equal(api.pick('type', 'Meetings').open, true, 'a tickable type keeps the multi-select menu open');
  api.reset();
  assert.equal(api.pick('status', 'Completed').open, true, 'a tickable status keeps the multi-select menu open');
  api.reset();
  assert.equal(api.pick('status', 'Any status').open, false, '"Any status" ends the selection and closes');
  api.reset();
  const assigned = api.pick('assigned', 'Lex');
  assert.equal(assigned.open, false, 'choosing an assignee closes the menu');
  assert.equal(assigned.libF.assignee, 'lex', 'and still applies the choice');
  api.reset();
  assert.equal(api.pick('assigned', 'Anyone').open, false, '"Anyone" closes like every other single choice');
}

// The sidebar's own rows: a meeting's call link and the zoomed task's metadata, both above the groups.
async function runSidebarRowsCheck() {
  const api = vm.runInNewContext(`
    const calls = [];
    let summary = null;
    const taskSummary = () => summary;
    const documentSummary = () => null; // covered by its own path; here the task summary is the input
    const isRealId = () => true;
    const canEditNode = (node) => node.editable !== false;
    const openAssigneePalette = (doc) => calls.push(['assignees', doc.id]);
    const openVisibilityPalette = (doc) => { calls.push(['visibility', doc.id]); palDoc = doc; palette.hidden = false; };
    const openVisibilityPeople = (doc) => calls.push(['people', doc.id]);
    const accessById = new Map(), accessLoading = new Set(), taskMetaById = new Map();
    let palDoc = null, palette = { hidden: true };
    const loadAccess = () => {}, loadTaskMeta = () => {};
    const run = (fn) => fn();
    const tana = { taskMeta: async () => ({}), setAssignees: async () => {}, accessOptions: async () => ({}), nodeLink: async (id) => 'https://home.tana.inc/l/' + id, openExternal: async (url) => calls.push(['open', url]) };
    ${functionSource('railCallRow')}
    ${functionSource('railMetaRows')}
    ${functionSource('openVisibility')}
    ${functionSource('banSvg')}
    ${functionSource('visibilityRows')}
    ({ rows: (node, value, accessNode) => { summary = value; return railMetaRows(node, accessNode); }, call: (data) => railCallRow(data), calls: () => calls,
       known: (id, meta, access) => { if (meta) taskMetaById.set(id, meta); else taskMetaById.delete(id); if (access) accessById.set(id, access); else accessById.delete(id); },
       permission: (access, loading) => { palDoc = { id: 'doc' }; accessById.delete('doc'); accessLoading.delete('doc'); if (access) accessById.set('doc', access); if (loading) accessLoading.add('doc'); return visibilityRows(''); },
       opened: () => ({ doc: palDoc && palDoc.id, hidden: palette.hidden }) });
  `);
  assert.deepEqual(plain(api.rows({ id: 'doc' }, null).map((row) => [row.id, row.icon, row.label])),
    [['showInTana', 'tana', 'Show in Tana']], 'the Tana link keeps Details present without task metadata');
  const rows = api.rows({ id: 'doc' }, { assignees: 'Lex van Velsen', audience: { icon: 'lock', label: 'Visible only to you' } });
  assert.deepEqual(plain(rows.map((row) => [row.id, row.icon, row.label, typeof row.run])), [
    ['assignees', 'member', 'Assigned to Lex van Velsen', 'function'],
    ['visibility', 'lock', 'Visible only to you', 'function'],
    ['showInTana', 'tana', 'Show in Tana', 'function'],
  ], 'assignees and visibility read as plain rows and both can be opened');
  rows[0].run(); rows[1].run();
  assert.deepEqual(plain(api.calls()), [['assignees', 'doc'], ['visibility', 'doc']], 'the rows open the pickers the palette already uses');
  api.rows({ id: 'writeup' }, { audience: { icon: 'userLock', label: 'Visible to selected people' }, scope: 'people' }, { id: 'event' })[0].run();
  assert.deepEqual(plain(api.calls().at(-1)), ['visibility', 'event'], 'a followed meeting write-up checks visibility on its event hub');
  assert.deepEqual(plain(api.rows({ id: 'doc' }, { assignees: 'Unassigned', audience: null, unknownAudience: true }).map((row) => row.label)),
    ['Unassigned', 'Show in Tana'], 'an audience that cannot be verified is left out instead of rendering an empty row');
  assert.deepEqual(plain(api.rows({ id: 'doc', editable: false }, { assignees: 'Lex', audience: { icon: 'lock', label: 'Visible only to you' } }).map((row) => row.run === null)),
    [true, false, false], 'read-only body editing does not disable sharing or the Tana link');
  // link sharing is its own fact: a public document says so, even when it is not a task and has no assignee
  assert.deepEqual(plain(api.rows({ id: 'doc' }, { assignees: 'Lex', audience: { icon: 'lock', label: 'Visible only to you' }, linkShared: true }).map((row) => [row.id, row.icon])),
    [['assignees', 'member'], ['visibility', 'lock'], ['linkShared', 'globe'], ['showInTana', 'tana']], 'a link-shared node adds a globe row');
  assert.deepEqual(plain(api.rows({ id: 'doc' }, { assignees: '', audience: null, linkShared: true }).map((row) => [row.id, row.label])),
    [['linkShared', 'Anyone with the link'], ['showInTana', 'Show in Tana']], 'a public document with no assignee still reports that anyone with the link can read it');
  await api.rows({ id: 'doc' }, null)[0].run();
  assert.deepEqual(plain(api.calls().at(-1)), ['open', 'https://home.tana.inc/l/doc'], 'Show in Tana reuses nodeLink and openExternal');
  assert.deepEqual(plain(api.permission(null, true)), [{ group: 'Visibility', label: 'Checking permission…', disabled: true }], 'visibility explains while permission loads');
  const denied = plain(api.permission({ sharing: false, reason: 'Only the event organizer can change access' }));
  assert.match(denied[0].svg, /<line[^>]+><\/line><circle/, 'the attendee reason uses the supplied ban icon');
  delete denied[0].svg;
  assert.deepEqual(denied, [{ group: 'Visibility', label: 'Only the event organizer can change access', disabled: true }], 'an attendee sees the backend reason');

  assert.equal(api.call(null), null, 'no relations, no call row');
  assert.equal(api.call({ pinned: [] }), null, 'a meeting without a call link renders nothing');
  const call = api.call({ call: { url: 'https://meet.google.com/ipt-utoj-srr', label: 'meet.google.com/ipt-utoj-srr' } });
  assert.deepEqual(plain([call.id, call.icon, call.label]), ['call', 'video', 'meet.google.com/ipt-utoj-srr'], 'the call row shows the readable link with the video icon');
  call.run();
  assert.deepEqual(plain(api.calls().at(-1)), ['open', 'https://meet.google.com/ipt-utoj-srr'], 'it joins through api.openExternal');
  assert.ok(/video/.test(fs.readFileSync(require.resolve('../icons.js'), 'utf8')), 'icons.js carries the video icon the call row asks for');
  assert.ok(/tana/.test(fs.readFileSync(require.resolve('../icons.js'), 'utf8')), 'icons.js carries the Tana icon the link row asks for');

  // "Visible to selected people" opens the people list only after permission is known; attendees must see the reason.
  const people = { assignees: 'Lex', scope: 'people', audience: { icon: 'userLock', label: 'Visible to selected people' } };
  const visibility = (node, value) => api.rows(node, value).find((row) => row.id === 'visibility');
  api.known('doc', { participants: [] });
  visibility({ id: 'doc' }, people).run();
  assert.deepEqual(plain(api.calls().at(-1)), ['visibility', 'doc'], 'permission still loading starts at the explanatory visibility level');
  assert.deepEqual(plain(api.opened()), { doc: 'doc', hidden: false }, 'and the palette it opens is the existing visibility flow, on that document');
  api.known('doc', { participants: [] }, { rules: ['me', 'people', 'inherit'] });
  visibility({ id: 'doc' }, people).run();
  assert.deepEqual(plain(api.calls().at(-1)), ['people', 'doc'], 'known sharing rules that allow selected people keep the shortcut');
  api.known('doc', { participants: [] }, { rules: ['me'] });
  visibility({ id: 'doc' }, people).run();
  assert.deepEqual(plain(api.calls().at(-1)), ['visibility', 'doc'], 'sharing rules without selected people start at the mode picker instead');
  api.known('doc', null);
  visibility({ id: 'doc' }, people).run();
  assert.deepEqual(plain(api.calls().at(-1)), ['visibility', 'doc'], 'without the participants the list cannot be shown, so the flow starts where it did');
  api.known('doc', { participants: [] });
  visibility({ id: 'doc' }, { assignees: 'Lex', scope: 'only-me', audience: { icon: 'lock', label: 'Visible only to you' } }).run();
  assert.deepEqual(plain(api.calls().at(-1)), ['visibility', 'doc'], 'every other visibility mode still opens the flow at its first step');
}

async function runRailPinCheck() {
  const groups = vm.runInNewContext(functionSource('railGroups') + '; railGroups;');
  assert.deepEqual(plain(groups({ pinHub: 'event', pinned: [], outcomes: [], notes: [] })),
    [['Pinned', [], 'event']], 'a writable empty pin hub keeps the Pinned section');

  const action = vm.runInNewContext(`
    ${FAKE_DOM}
    const iconSvg = () => '<svg></svg>', railMove = () => false;
    const calls = [], togglePalette = (...args) => calls.push(args);
    ${functionSource('railMetaEl')}
    ${functionSource('railPinAction')}
    const row = railPinAction('event', 'doc'); row.onclick();
    ({ className: row.className, calls });
  `);
  assert.equal(action.className, 'rrow', 'the pin action uses the ordinary sidebar row');
  assert.deepEqual(plain(action.calls), [['search', null, { pinHub: 'event', docId: 'doc' }]], 'the pin action opens the shared search palette with pin context');

  const picker = vm.runInNewContext(`
    const calls = [], asDoc = (node) => node, docRow = (node, hint, run) => ({ node, run });
    let linkCtx = null, pinCtx = { pinHub: 'event', docId: 'doc' };
    const linkTo = () => {}, openResult = () => {}, createAndLink = () => {};
    const pinResult = (ctx, node) => calls.push([ctx.pinHub, ctx.docId, node.id]);
    ${functionSource('resultRows')}
    const row = resultRows([{ id: 'chosen', title: 'Chosen' }], 'Results')[0]; row.run();
    ({ calls });
  `);
  assert.deepEqual(plain(picker.calls), [['event', 'doc', 'chosen']], 'a search result uses the pin context instead of navigating');

  const refresh = vm.runInNewContext(`
    const relatedBy = new Map([['event', {}], ['doc', {}]]), calls = [];
    const tana = { pinTo: async (...args) => calls.push(args) }, run = (fn) => fn();
    let renders = 0; const render = () => { renders++; };
    ${functionSource('pinResult')}
    ({ pin: () => pinResult({ pinHub: 'event', docId: 'doc' }, { id: 'chosen' }), state: () => ({ calls, keys: [...relatedBy.keys()], renders }) });
  `);
  await refresh.pin();
  assert.deepEqual(plain(refresh.state()), { calls: [['event', 'chosen']], keys: [], renders: 1 }, 'pinning invalidates the hub and open-document relation caches before rendering');
  assert.match(functionSource('closePalette'), /pinCtx = null/, 'closing the shared palette clears pin context');
}

// Every sidebar title starts at the same x: an icon takes the same horizontal box as a task row's checkbox.
function runSidebarAlignmentCheck() {
  const styles = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
  const rule = (selector) => {
    const at = styles.indexOf('\n' + selector + ' {');
    assert.notEqual(at, -1, selector + ' is styled');
    return styles.slice(at, styles.indexOf('}', at));
  };
  const box = (css) => {
    const width = Number((css.match(/width:\s*(\d+)px/) || [])[1]);
    const parts = ((css.match(/margin:\s*([^;]+);/) || [])[1] || '0').trim().split(/\s+/).map((value) => parseInt(value, 10) || 0);
    const [, right, , left] = parts.length === 4 ? parts : parts.length === 3 ? [parts[0], parts[1], parts[2], parts[1]]
      : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]] : [parts[0], parts[0], parts[0], parts[0]];
    return { width, inset: left + width + right };
  };
  const icon = box(rule('.rail .rrow .ricon')), check = box(rule('.check'));
  assert.equal(icon.width, check.width, 'a sidebar icon box is as wide as a checkbox');
  assert.equal(icon.inset, check.inset, 'icon rows and checkbox rows take the same horizontal space, so their titles line up');
  assert.match(styles, /\.rail \.rhead \{[^}]*margin-top: 18px/, 'the sidebar groups are separated from each other');
  assert.match(styles, /\.rail \.rhead:first-child \{[^}]*margin-top: 0/, 'the first group still starts at the top');
}

// "Clear filters" belongs on an empty view only when a filter is the reason it is empty.
function runClearFiltersCheck() {
  const api = vm.runInNewContext(`
    let view = 'tasks';
    let taskF = { states: ['proposed', 'open'], assignee: 'me' };
    let libF = { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '' };
    const render = () => {}, loadLibrary = () => {}, run = (fn) => fn();
    const tana = { setTaskFilter: async () => {}, setLibraryFilter: async () => {} };
    ${functionSource('setTaskF')}
    ${functionSource('setLibF')}
    ${sourceBetween('// The filter defaults main persists', 'function ensureLoaded')}
    ({ set: (next, patch) => { view = next; if (patch) Object.assign(view === 'tasks' ? taskF : libF, patch); },
       filtered: () => viewFiltered(), clear: () => clearFilters(), state: () => ({ taskF, libF }) });
  `);
  api.set('tasks');
  assert.equal(api.filtered(), false, 'the default task filter is not "narrowed": an empty view is genuinely empty');
  api.set('tasks', { states: ['open', 'proposed'] });
  assert.equal(api.filtered(), false, 'the same states in another order are still the default');
  api.set('tasks', { states: ['closed'], assignee: 'anyone' });
  assert.equal(api.filtered(), true, 'a changed status or assignee offers the action');
  api.clear();
  assert.deepEqual(plain(api.state().taskF), { states: ['proposed', 'open'], assignee: 'me' }, 'clearing restores the task defaults');
  assert.equal(api.filtered(), false, 'and the action goes away again');
  api.set('library');
  // the Library ships narrowed to your open tasks, so its shipped default is still a filter
  assert.equal(api.filtered(), true, 'the shipped library filter still narrows the view');
  api.set('library', { text: 'memo' });
  assert.equal(api.filtered(), true, 'a search text narrows the Library view');
  api.clear();
  assert.deepEqual(plain(api.state().libF), { types: null, states: null, assignee: 'anyone', text: '' }, 'clearing the Library means anything, not the shipped default');
  assert.equal(api.filtered(), false, 'and with everything set to any, the action goes away');
  api.set('inbox');
  assert.equal(api.filtered(), false, 'a view without filter pills never offers the action');
}

// Sorting and grouping are view preferences over rows already loaded: the order and the headings come from fields the
// rows carry (title, done/stateType, assignees, tags), never from a new query.
function runSortGroupCheck() {
  const definitions = sourceBetween('const STATES =', 'function renderPills');
  const api = vm.runInNewContext(`
    let view = 'tasks', groupPref = {}, sortPref = {};
    let taskF = { states: ['open'], assignee: 'me' }, libF = {};
    let members = [{ id: 'me', title: 'André', me: true }, { id: 'lex', title: 'Lex' }];
    const taskMetaById = new Map([['t1', { assignees: ['lex'] }], ['t2', { assignees: ['me'] }], ['t4', { assignees: ['tana:user-profile:ghost'] }]]);
    const tana = {}, palette = { hidden: true };
    const $ = () => ({ hidden: true });
    const renderPills = () => {}, render = () => {}, showError = () => {}, setMcp = () => {}, showMcp = false;
    const setTaskF = () => {}, setLibF = () => {};
    const localStorage = { setItem() {} };
    const isTask = (n) => n.icon === 'task';
    const visibleTags = (n) => { const tags = n.tags || []; return isTask(n) && tags.some((t) => t.label !== 'task') ? tags.filter((t) => t.label !== 'task') : tags; };
    ${definitions}
    ({ pillDefs, groupRows, groupsOf, sortRows, SORTS, SORT_KEY,
       set: (next, by, order) => { view = next; groupPref[next] = by; sortPref[next] = order; },
       prefs: () => ({ group: groupBy(), sort: sortBy() }) });
  `);
  const rows = [ // updatedAt/createdAt are the ISO strings main.js toNode passes; d1 is an older row that has neither
    { id: 't1', text: 'beta', icon: 'task', done: 0, updatedAt: '2026-09-10T09:00:00Z', createdAt: '2026-01-05T09:00:00Z', tags: [{ label: 'task' }, { label: 'Project' }] },
    { id: 't2', text: 'Alpha', icon: 'task', done: 1, updatedAt: '2026-09-01T09:00:00Z', createdAt: '2026-03-02T09:00:00Z', tags: [{ label: 'task' }] },
    { id: 't3', text: 'delta', icon: 'task', done: 0, stateType: 'proposed', updatedAt: '2026-09-12T09:00:00Z', createdAt: '2026-02-01T09:00:00Z', tags: [{ label: 'task' }] },
    { id: 't4', text: 'Charlie', icon: 'task', done: 0, stateType: 'not_now', updatedAt: '2026-09-05T09:00:00Z', createdAt: '2026-04-09T09:00:00Z', tags: [{ label: 'task' }] },
    { id: 'd1', text: 'echo', icon: 'doc', tags: [{ label: 'doc' }] },
  ];
  const titles = (list, by) => plain(api.groupRows(list, by)).map((g) => [g.title, g.nodes.map((n) => n.id)]);
  assert.deepEqual(titles(rows, 'status'), [['Inbox', ['t3']], ['In Progress', ['t1']], ['Completed', ['t2']], ['Later', ['t4']], ['No status', ['d1']]],
    'status groups follow the Status menu order; a row without a task state sits in No status');
  assert.deepEqual(titles(rows.filter((r) => r.stateType !== 'proposed'), 'status').map(([title]) => title), ['In Progress', 'Completed', 'Later', 'No status'],
    'a group with no rows is left out');
  assert.deepEqual(titles(rows, 'assignee'), [['André', ['t2']], ['Lex', ['t1']], ['tana:user-profile:ghost', ['t4']], ['Unassigned', ['t3', 'd1']]],
    'assignees sort by name, a member without a loaded name keeps its uri, the rest is Unassigned');
  assert.deepEqual(titles(rows, 'type'), [['doc', ['d1']], ['Project', ['t1']], ['task', ['t2', 't3', 't4']]],
    'type groups on the tag the row already shows as its chip');
  assert.deepEqual(titles([{ id: 'x', tags: [] }], 'type'), [['No type', ['x']]], 'a row without tags groups under No type');
  assert.deepEqual(titles([{ id: 'x', icon: 'task', done: 1, stateType: 'proposed', tags: [] }], 'status'), [['Inbox', ['x']]],
    'the row state wins over the done flag, so an Inbox task never reads as Completed');
  const order = (list) => plain(api.sortRows(list)).map((n) => n.id);
  api.set('tasks', 'none', 'title');
  assert.deepEqual(order(rows), ['t2', 't1', 't4', 't3', 'd1'], 'Title sorts the loaded rows by their own title, case-insensitively');
  api.set('tasks', 'none', 'updated');
  assert.deepEqual(order(rows), ['t3', 't1', 't4', 't2', 'd1'], 'Updated reads newest first, and a row without a time sorts last');
  api.set('tasks', 'none', 'created');
  assert.deepEqual(order(rows), ['t4', 't2', 't3', 't1', 'd1'], 'Created reads newest first too');
  api.set('tasks', 'none', 'default');
  assert.deepEqual(order(rows), ['t1', 't2', 't3', 't4', 'd1'], 'Default leaves the order the view produced alone');
  api.set('meetings', 'status', 'title');
  assert.deepEqual(order(rows), ['t1', 't2', 't3', 't4', 'd1'], 'sorting and grouping apply to Tasks and Library only');
  assert.equal(api.groupsOf(rows), null, 'an ungrouped or unsupported view renders the flat list it always did');
  api.set('library', 'type', 'title');
  assert.equal(api.groupsOf(rows).length, 3, 'a grouped view sections its rows');
  assert.deepEqual(plain(api.prefs()), { group: 'type', sort: 'title' }, 'each view remembers its own choice');
  api.set('tasks', undefined, undefined);
  assert.deepEqual(plain(api.prefs()), { group: 'none', sort: 'default' }, 'and an unset view falls back to None / Default');
  // the guard that matters: an option may only sort on a field the row objects really carry
  for (const [id] of plain(api.SORTS).filter(([id]) => id !== 'default')) {
    const key = api.SORT_KEY[id];
    assert.ok(key, id + ' has a sort key');
    assert.notEqual(key(rows[0]), undefined, id + ' reads a field the rows carry');
  }
  api.set('tasks', 'status', 'title');
  const defs = api.pillDefs(), ids = defs.map((d) => d.id);
  assert.deepEqual(plain(ids.slice(-2)), ['sort', 'group'], 'Sort and Group sit at the end of the filter pills, in that order');
  const sort = defs.find((d) => d.id === 'sort'), group = defs.find((d) => d.id === 'group');
  assert.deepEqual(plain([sort.label, sort.value, group.label, group.value]), ['Sort', 'Title', 'Group', 'Status'], 'both pills read their active option');
  assert.deepEqual(plain(sort.rows().map((r) => r.label)), ['Default', 'Updated', 'Created', 'Title'], 'the Sort menu offers only orders backed by row data');
  assert.deepEqual(plain(group.rows().map((r) => r.label)), ['None', 'Status', 'Assignee', 'Type'], 'the Group menu offers the four groupings');
  assert.ok(sort.rows().find((r) => r.label === 'Title').checked && group.rows().find((r) => r.label === 'Status').checked, 'the active option is ticked');
  assert.ok([...sort.rows(), ...group.rows()].every((r) => !r.keepOpen), 'choosing an option closes the popup, like every other single choice');
  assert.match(source, /const groups = groupsOf\(list\);/, 'the view renders its groups');
  assert.match(source, /groups\.flatMap\(\(g\) => \[groupHeadEl\(g\.title\)/, 'each group is introduced by a heading');
  assert.match(source, /list = sortRows\(list\);/, 'the rows are sorted before they are grouped');
}

function runCmdPillsCheck() {
  const definitions = sourceBetween('const STATES =', 'function renderPills');
  const api = vm.runInNewContext(`
    let view = 'tasks', taskF = { states: ['open'], assignee: 'anyone' }, libF = { types: ['tasks'], states: ['open'], assignee: 'anyone', text: '' };
    let members = [{ id: 'me', title: 'André', me: true }], showMcp = false, groupPref = {}, sortPref = {};
    let pillCtx = null, palMode = 'cmd', palRows = [], palIndex = 0, renders = 0;
    const taskMetaById = new Map(), tana = {}, palette = { hidden: false };
    const $ = () => ({ hidden: false }), showError = () => {}, renderPills = () => {};
    const localStorage = { setItem() {} }, render = () => { renders++; };
    const setTaskF = (patch) => { taskF = { ...taskF, ...patch }; render(); };
    const setLibF = (patch) => { libF = { ...libF, ...patch }; render(); };
    const setMcp = (on) => { showMcp = on; render(); };
    const palInput = { value: '', placeholder: '', focus() {} };
    const renderPalette = () => { renders++; };
    ${definitions}
    ${functionSource('pillRows')}
    ${functionSource('openPillPalette')}
    ${functionSource('openCommandPalette')}
    ({
      commands: (next) => { view = next; return pillCommandRows().map((row) => [row.id, row.label]); },
      open: (id) => { openPillPalette(id); return { mode: palMode, rows: pillRows('').map((row) => [row.label, row.hint]) }; },
      pick: (label) => { pillRows('').find((row) => row.label === label).run(); return { mode: palMode, taskF, group: groupPref[view], sort: sortPref[view] }; },
    });
  `);
  assert.deepEqual(plain(api.commands('tasks')), [
    ['pill:status', 'Status In Progress'], ['pill:assigned', 'Assigned to Anyone'],
    ['pill:sort', 'Sort Default'], ['pill:group', 'Group None'],
  ], 'Cmd+K derives the current Tasks pill commands and values from pillDefs');
  assert.deepEqual(plain(api.open('status')), { mode: 'pill', rows: [['Any status', ''], ['Inbox', ''], ['In Progress', '✓'], ['Completed', ''], ['Later', '']] },
    'a command opens the same Status rows and active tick as the pill');
  assert.equal(api.pick('Inbox').mode, 'pill', 'a multi-select filter stays in its pill sublevel');
  api.open('sort');
  assert.deepEqual(plain(api.pick('Title')), { mode: 'cmd', taskF: { states: ['proposed', 'open'], assignee: 'anyone' }, sort: 'title' },
    'a single Sort choice applies the shared row action and returns to commands');
  api.open('group');
  assert.equal(api.pick('Assignee').group, 'assignee', 'Group uses the same shared action too');
  assert.deepEqual(plain(api.commands('library').map(([id]) => id)), ['pill:type', 'pill:status', 'pill:assigned', 'pill:sort', 'pill:group'],
    'Library includes its Type filter plus the other applicable pills');
  assert.deepEqual(plain(api.commands('meetings')), [], 'views without header pills offer no pill commands');
  assert.match(source, /if \(palMode === 'pill'\) openCommandPalette\(\); else closePalette\(\);/, 'Escape from a pill returns one palette level');
}
// Opening a node has to leave a row to type in, without creating anything in Tana until it is typed into.
function runDraftTailCheck() {
  const api = vm.runInNewContext(`
    const isImage = (n) => n.type === 'image', isDivider = (n) => n.type === 'divider', isReference = (n) => n.type === 'reference';
    ${functionSource('draftNode')}
    const segsOf = (v) => Array.isArray(v) ? v : typeof v === 'string' ? (v ? [{ text: v }] : []) : v.segments || (v.text ? [{ text: v.text }] : []);
    const plainOf = (v) => segsOf(v).map((s) => 'text' in s ? s.text : s.mention.label).join('');
    const isAtomic = (n) => isImage(n) || isDivider(n);
    let editable = true, loaded = true;
    const childrenOf = () => (loaded ? [] : null); // only its "are the children loaded" answer matters here
    const canEditItem = () => editable;
    const isSpace = (n) => n.id.startsWith('tana:space:');
    ${sourceBetween('const typableRow =', '// Opening a node leaves a row')}
    ${functionSource('withDraftTail')}
    ({ tail: (list, parent) => withDraftTail(list, parent), set: (e, l) => { editable = e; loaded = l; } });
  `);
  const doc = { key: 'doc', docId: 'doc', node: { id: 'tana:text:doc', kind: 'document' } };
  const ids = (list) => plain(list).map((n) => n.id);
  const row = (id, text) => ({ id, kind: 'block', text });
  assert.deepEqual(ids(api.tail([], doc)), ['draft:doc'], 'an empty document opens on a draft row, as it always did');
  assert.deepEqual(ids(api.tail([row('a', 'written')], doc)), ['a', 'draft:doc'], 'a document with content gets the draft row after it');
  assert.deepEqual(ids(api.tail([row('a', 'written'), row('b', '')], doc)), ['a', 'b'], 'an empty last row is already somewhere to type, so no draft is added');
  assert.deepEqual(ids(api.tail([{ id: 'img', kind: 'block', type: 'image' }], doc)), ['img', 'draft:doc'], 'an image, divider or reference row is not somewhere to type');
  assert.deepEqual(ids(api.tail([], { key: 's', docId: 's', node: { id: 'tana:space:1', kind: 'document' } })), [], 'a space lists documents, so it has no draft child');
  const block = { key: 'doc/b', docId: 'doc', node: { id: 'b', kind: 'block' } };
  assert.deepEqual(ids(api.tail([], block)), ['draft:doc/b'], 'an empty block opens on a draft child');
  assert.deepEqual(ids(api.tail([row('c', 'child')], block)), ['c'], 'a block with children gets none: a draft there would materialise as its first child');
  api.set(false, true);
  assert.deepEqual(ids(api.tail([], doc)), [], 'a read-only document (every chat) never offers a row to type in');
  api.set(true, false);
  assert.deepEqual(ids(api.tail([], doc)), [], 'children that are still loading are not an empty document');
  assert.match(source, /caretOnOpen = false;\n\s+const last = list\.at\(-1\)/, 'the caret lands in that row once per open, not on every render');
  assert.match(source, /flushAll\(\); dropDrafts\(\); caretOnOpen = true;/, 'both routes into a node (zoomTo, openDoc) ask for it');
}

// Every list row says who can see it, not only task rows, and the metadata request waits for the row to be on screen.
function runRowAudienceCheck() {
  const api = vm.runInNewContext(`
    const items = new Map(), open = new Map(), pending = new Map();
    const docOf = () => ({ editable: true });
    const keyFor = (docId, node) => node.kind === 'document' ? docId : docId + '/' + node.id;
    const mkItem = (docId, node, parent) => { const item = { key: keyFor(docId, node), docId, node, parent }; items.set(item.key, item); return item; };
    const hasKids = () => false, isOpen = () => false, setOpen = () => {}, zoomTo = () => {}, ensureLoaded = () => {}, childrenOf = () => [], isSpace = () => false, draftNode = () => ({ id: 'draft', kind: 'block', text: '', draft: true });
    const renderSegs = () => {}, segsOf = () => [], asDoc = (node) => ({ ...node, kind: 'document', text: node.text ?? node.title ?? '' });
    const isImage = () => false, chipEl = () => ({}), iconSvg = (icon) => '<svg data-icon="' + icon + '"></svg>';
    const childEl = () => document.createElement('div');
    const isDivider = () => false;
    const fetched = [], observed = [];
    let watching = null;
    let metaSeen = null;
    class IntersectionObserver { constructor(fn) { watching = fn; } observe(el) { observed.push(el); } unobserve() {} }
    const taskMetaById = new Map(), taskMetaLoading = new Set(), taskMetaFailed = new Map();
    const loadTaskMeta = (id) => { fetched.push(id); };
    const loadMembers = () => {}, memberName = (uri) => uri;
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
    const tana = { taskMeta: () => {} };
    const document = { createElement: (tagName) => {
      const classes = new Set();
      return { tagName, children: [], dataset: {}, attrs: {}, html: '', style: { setProperty() {}, cssText: '' },
        classList: { add: (...names) => names.forEach((name) => classes.add(name)), toggle: (name, on) => on ? classes.add(name) : classes.delete(name), contains: (name) => classes.has(name) },
        get className() { return [...classes].join(' '); },
        set className(value) { classes.clear(); for (const name of String(value).split(' ')) if (name) classes.add(name); },
        setAttribute(key, value) { this.attrs[key] = value; },
        set innerHTML(value) { this.html = value; }, get innerHTML() { return this.html; },
        get firstElementChild() { return null; },
        append(...kids) { this.children.push(...kids); }, prepend(...kids) { this.children.unshift(...kids); },
        set textContent(value) { this.value = value; }, get textContent() { return this.value || ''; } };
    } };
    ${sourceBetween('const isReference =', 'const showError =')}
    ${sourceBetween('const isTask =', 'const chatIcon =')}
    ${sourceBetween('// Block types (api.setBlockType)', 'const images = new Map()')}
    ${sourceBetween('const AUDIENCES = {', 'function loadTaskMeta(')}
    ${functionSource('observeMeta')}
    ${functionSource('taskSummary')}
    ${functionSource('documentSummary')}
    ${functionSource('taskMetaEl')}
    ${sourceBetween('const canExpand =', 'function draftNode')}
    ${functionSource('nodeEl')}
    ({
      row: (node, meta) => {
        fetched.length = 0; observed.length = 0; taskMetaById.clear();
        if (meta) taskMetaById.set(node.id, meta);
        const el = nodeEl(node, node.id, null);
        const body = el.children[0].children.find((child) => child.className === 'body');
        const info = body.children.find((child) => child.className.split(' ')[0] === 'meta');
        return { icons: info ? info.children.map((icon) => icon.attrs['aria-label'] || icon.html.match(/data-icon="([^"]+)"/)[1]) : null, gaps: info ? info.children.map((icon) => (icon.style.cssText.match(/margin-left:([^;]+)/) || [])[1] || null) : null, pending: info ? info.className.includes('pending') : null, sub: (body.children.find((child) => child.className === 'subtext') || {}).value || null, fetched: [...fetched], observed: observed.map((watched) => watched.dataset.metaFor) };
      },
      onScreen: () => { watching(observed.map((target) => ({ isIntersecting: true, target }))); return [...fetched]; },
    });
  `, { structuredClone });
  const doc = { id: 'tana:text:doc1', kind: 'document', text: 'Charter', icon: 'doc', hasChildren: true, editable: true };
  const meeting = { id: 'tana:event:m1', kind: 'document', text: 'Heads of Technology', icon: 'meeting', hasChildren: true, editable: true };
  const task = { id: 'tana:text:t1', kind: 'document', text: 'Renew the DPA', icon: 'task', hasChildren: true, editable: true };
  const spaceMeta = { assignees: [], audience: { scope: 'space' }, audienceSpace: { title: 'Foundry LT' } };
  const row = (node, meta) => plain(api.row(node, meta));
  assert.deepEqual(row(doc, spaceMeta).icons, ['Visible to members of Foundry LT'], 'a doc row carries the audience icon, the way a task row does');
  assert.deepEqual(row(meeting, { assignees: [], audience: 'only-me' }).icons, ['Visible only to you'], 'a meeting row carries it too');
  assert.deepEqual(row(doc, { assignees: [], audience: 'everyone', linkShared: true }).icons, ['Visible to everyone', 'Anyone with the link'], 'link sharing stays a separate icon on a doc row');
  assert.deepEqual(row(task, { assignees: ['tana:user-profile:lex'], audience: 'only-me' }).icons, ['Visible only to you'], 'a task row is unchanged');
  assert.deepEqual(row(task, { assignees: ['tana:user-profile:lex'], audience: 'only-me' }).gaps, ['6px'], 'an icon after an assignee name keeps its 6px');
  assert.deepEqual(row(doc, spaceMeta).gaps, ['0'], 'a row with no name in front of the icon does not add a second gap on top of the one the meta span carries');
  assert.deepEqual(row(doc, { assignees: [], audience: 'everyone', linkShared: true }).gaps, ['0', '6px'], 'the icons still stand apart from each other');
  assert.equal(row(doc, spaceMeta).sub, 'Foundry LT', 'a space audience still names the space under the title');
  assert.equal(row(doc, { assignees: [], audience: 'unknown' }).icons, null, 'a document with nothing shareable shows nothing at all');
  const settledGaps = row(doc, spaceMeta).gaps;
  const pending = row(doc, null);
  assert.deepEqual(pending.icons, ['pending'], 'a row still waiting on its metadata holds the slot with the dashed placeholder');
  assert.equal(pending.pending, true, 'which is marked so it can stay quieter than a real answer');
  assert.deepEqual(pending.gaps, settledGaps, 'in exactly the place the real icon lands, so nothing shifts when it arrives');
  assert.deepEqual(pending.fetched, [], 'and asks for nothing while it renders: one request per visible row, never per listed row');
  assert.deepEqual(pending.observed, ['tana:text:doc1'], 'the row is watched instead, so the request goes out when it scrolls into view');
  assert.deepEqual(plain(api.onScreen()), ['tana:text:doc1'], 'and it does go out once the row is on screen');
  assert.equal(row({ ...doc, id: 'draftdoc:1' }, null).icons, null, 'a draft document has nothing to ask about, so it holds no slot either');
  assert.deepEqual(row({ ...doc, id: 'draftdoc:1' }, null).observed, [], 'and is not watched');
  assert.deepEqual(row(doc, spaceMeta).observed, [], 'metadata already in hand is not asked for again');
}

// Hovering a sidebar row expands its tag, which must not re-wrap the title and jump the row under the pointer.
function runSidebarHoverCheck() {
  const api = vm.runInNewContext(`
    let lineHeight = '19px';
    const getComputedStyle = () => ({ lineHeight });
    const makeEl = () => {
      const classes = new Set();
      return { classes, dataset: {}, children: [], style: { setProperty() {} }, offsetHeight: 19,
        classList: { add: (...names) => names.forEach((name) => classes.add(name)) },
        set className(value) { classes.clear(); for (const name of String(value).split(' ')) if (name) classes.add(name); },
        get className() { return [...classes].join(' '); },
        append(...kids) { this.children.push(...kids); }, querySelectorAll: () => [],
        set textContent(value) { this.value = value; }, get textContent() { return this.value || ''; } };
    };
    const document = { createElement: makeEl };
    const isTask = () => false, canEditNode = () => true, iconSvg = () => '', appendTags = () => {}, goTo = () => {}, railKey = () => {};
    ${functionSource('railRow')}
    (lines) => {
      const row = railRow({ id: 'tana:event:m1', text: 'Heads of Technology', icon: 'meeting' });
      const title = row.children[1];
      title.offsetHeight = 19 * lines;
      row.onmouseenter();
      const held = title.style.webkitLineClamp;
      row.onmouseleave();
      return { held, released: title.style.webkitLineClamp, focus: row.onfocus === row.onmouseenter, blur: row.onblur === row.onmouseleave };
    };
  `);
  assert.equal(plain(api(1)).held, '1', 'a one-line row stays one line while its tag expands: the label truncates instead');
  assert.equal(plain(api(2)).held, '2', 'a row that already wraps keeps both of its lines');
  assert.equal(plain(api(1)).released, '', 'the row goes back to the ordinary two-line clamp when the pointer leaves');
  assert.deepEqual(plain(api(1)), { held: '1', released: '', focus: true, blur: true }, 'keyboard focus expands the tag too, so it holds the row the same way');
}

// The Cmd+K editor for the hidden-items list: the palette's own rows, and every change goes through api.
async function runHiddenItemsCheck() {
  const api = vm.runInNewContext(`
    const calls = [];
    let stored = ['Lunch', 'Block*'];
    const palInput = { value: '', placeholder: '', focus() {} };
    const palette = { hidden: true };
    let palMode = 'cmd', palRows = [], palIndex = 5, rendered = 0;
    const renderPalette = () => { rendered++; };
    const run = (fn) => fn();
    const tana = {
      filters: async () => { calls.push(['filters']); return [...stored]; },
      addFilter: async (pattern) => { calls.push(['addFilter', pattern]); stored = [...stored, pattern]; return [...stored]; },
      removeFilter: async (pattern) => { calls.push(['removeFilter', pattern]); stored = stored.filter((p) => p.toLowerCase() !== pattern.toLowerCase()); return [...stored]; },
    };
    ${sourceBetween('const HIDDEN_GROUP =', 'function openHiddenPalette')}
    ${functionSource('openHiddenPalette')}
    ({
      rows: (list, q) => { hiddenList = list; palInput.value = q; return hiddenRows(q); },
      runRow: async (list, q, index) => { hiddenList = list; stored = [...list]; palInput.value = q; const row = hiddenRows(q)[index]; calls.length = 0; await row.run(); return { calls: [...calls], list: hiddenList, typed: palInput.value }; },
      open: async (list) => { stored = [...list]; calls.length = 0; openHiddenPalette(); await new Promise(setImmediate); return { palMode, placeholder: palInput.placeholder, hidden: palette.hidden, calls: [...calls], list: hiddenList }; },
    });
  `, { setImmediate });

  assert.deepEqual(plain(api.rows(null, '').map((r) => [r.label, !!r.disabled])), [['Loading…', true]], 'the editor says it is loading until api.filters() answers');
  assert.deepEqual(plain(api.rows([], '').map((r) => r.label)), ['Nothing is hidden yet'], 'an empty list says so instead of leaving the palette blank');
  const listed = plain(api.rows(['Lunch', 'Block*'], ''));
  assert.deepEqual(listed.map((r) => [r.label, r.hint]), [['Lunch', 'Exact · ↩ unhides'], ['Block*', 'Prefix · ↩ unhides']], 'each pattern is a row that says how it matches and that Enter removes it');
  assert.equal(listed.every((r) => r.keepOpen && r.group === listed[0].group), true, 'they share one group header and none of them closes the editor');
  assert.match(listed[0].group, /case-insensitive/, 'that header is where the matching rule is explained');
  const typing = plain(api.rows(['Lunch', 'Block*'], 'Blo'));
  assert.deepEqual(typing.map((r) => r.label), ['Hide "Blo"', 'Block*'], 'typing offers to add what you typed, and narrows the list to what matches it');
  assert.deepEqual(plain(api.rows(['Lunch'], 'Block*')).map((r) => r.hint), ['Prefix'], 'a trailing * is offered as a prefix match');

  const added = plain(await api.runRow(['Lunch'], 'Block*', 0));
  assert.deepEqual(added, { calls: [['addFilter', 'Block*']], list: ['Lunch', 'Block*'], typed: '' }, 'adding sends the raw line and clears the input, so the new list is what shows');
  const removed = plain(await api.runRow(['Lunch', 'Block*'], '', 0));
  assert.deepEqual(removed.calls, [['removeFilter', 'Lunch']], 'running a pattern row removes that pattern');
  assert.deepEqual(removed.list, ['Block*'], 'and the editor lists what the call returned, not a guess');

  const opened = plain(await api.open(['Lunch', 'Block*']));
  assert.equal(opened.palMode, 'hidden', 'the command opens the palette in its own mode');
  assert.equal(opened.hidden, false, 'and shows the palette');
  assert.deepEqual(opened.calls, [['filters']], 'it reads the current list once');
  assert.deepEqual(opened.list, ['Lunch', 'Block*'], 'and renders what came back');
  assert.match(source, /id: 'hidden'[^}]*Edit hidden items/, 'Cmd+K carries the command that opens it');
  assert.match(source, /palMode === 'hidden'/, 'and the palette renders, filters and types in that mode like any other');
}

// main answers [] until its sync client is up: keeping that would leave every name as a raw uri all session.
async function runMemberLoadCheck() {
  const api = vm.runInNewContext(`
    const META_RETRY_MS = 500;
    let members = null, renders = 0, attempts = 0, answer = [];
    const render = () => { renders++; };
    const renderPills = () => {}, renderPalette = () => {}, showError = () => {};
    const $ = () => ({ hidden: true });
    const palette = { hidden: true };
    const tana = { members: async () => { attempts++; return answer; } };
    ${sourceBetween('// main answers [] until its sync client is up', 'const me = ()')}
    ${sourceBetween('const me = ()', 'const AUDIENCES')}
    ({
      load: async (next) => { if (next) answer = next; loadMembers(); await new Promise(setImmediate); return { attempts, people: members && members.length }; },
      reset: (asked) => { members = null; membersAsked = asked; },
      name: (uri) => memberName(uri),
    });
  `, { setImmediate, setTimeout });

  const empty = plain(await api.load([]));
  assert.equal(empty.attempts, 1, 'the member list is asked for once');
  assert.equal(api.name('tana:user-profile:andre'), 'tana:user-profile:andre', 'until it answers, a name is still its uri');
  api.reset(0);
  const again = plain(await api.load(null));
  assert.equal(again.attempts, 2, 'an empty answer means "not yet", so it is asked again instead of kept');
  api.reset(0);
  const filled = plain(await api.load([{ id: 'tana:user-profile:andre', title: 'André Foeken' }]));
  assert.equal(filled.attempts, 3, 'it keeps asking until someone is in the list');
  assert.equal(api.name('tana:user-profile:andre'), 'André Foeken', 'and once it answers, names resolve');
  const settled = plain(await api.load(null));
  assert.equal(settled.attempts, 3, 'a list with people in it is loaded for good: no further calls');
  api.reset(Date.now());
  const throttled = plain(await api.load([]));
  assert.equal(throttled.attempts, 3, 'a slow start cannot turn renders into a request loop: a fresh ask is throttled');
}

const checks = [runDraftTailCheck, runPinGrouping, runTypingRenderStabilityCheck, runSelectionChecks, runAssignedDropdown, runEditabilityCheck, runCheckboxCheck, runCheckboxInheritanceCheck, runTaskChildCheckboxScopeCheck, runStalePaletteInvalidationCheck, runReferenceEmbedRenderCheck, runRowAlignmentCheck, runRowAudienceCheck, runHiddenItemsCheck, runMemberLoadCheck, runVisibilityPickerCheck, runLinkPaletteCheck, runAuthPaletteCheck, runSyncShortcutCheck, runZoomShortcutCheck, runZoomDeleteCheck, runAssigneeCloseCheck, runPendingSplitDraftCheck, runTaskMetaRetryCheck, runPaletteSkipCheck, runFormattingChecks, runSlashMenuCheck, runFilterMenuCloseCheck, runSidebarRowsCheck, runRailPinCheck, runSidebarHoverCheck, runSidebarAlignmentCheck, runClearFiltersCheck, runSortGroupCheck, runCmdPillsCheck];
Promise.allSettled(checks.map((check) => Promise.resolve().then(check))).then((results) => {
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map((failure) => failure.message).join('\n'));
  console.log('renderer behavior check passed');
});

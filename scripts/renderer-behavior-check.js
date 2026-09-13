'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

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
      const isReference = () => false, canEditNode = (node) => node && node.editable !== false;
      ${canEditStructure}
      const render = () => { rendered++; };
      const reload = async () => {};
      const run = async (fn) => fn();
      const flushAll = () => {}, focused = () => null, loadRoots = async () => {}, kids = new Map([['doc', nodes]]), caretNear = () => {};
      const tana = {
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
  const initial = await api.children(taskId);
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
    const asDoc = (node) => ({ ...node, kind: 'document', text: node.text ?? node.title ?? '' });
    const isImage = () => false, taskSummary = () => null, chipEl = () => ({}), iconSvg = () => '';
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
    const embedded = {
      id: 'block-identity', kind: 'block', type: 'reference', editable: false,
      text: 'native embed text', segments: [{ text: 'native embed text' }],
      reference: { uri: 'tana:text:01j0target000000000000000', label: 'Fallback label', node: { id: 'tana:text:01j0target000000000000000', text: 'Resolved target', kind: 'document' } },
    };
    const el = nodeEl(embedded, 'tana:doc:01j0container000000000000', { node: { kind: 'document', editable: true } });
    const text = el.children[0].children.at(-1).children[0];
    ({ key: el.dataset.key, editable: text.contentEditable === 'plaintext-only', rendered: rendered.get(text) });
  `);
  assert.deepEqual(plain(api), {
    key: 'tana:doc:01j0container000000000000/block-identity',
    editable: false,
    rendered: [{ text: 'Resolved target' }],
  }, 'a resolved reference embed displays its target while retaining the original read-only block identity');
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
    let linkCtx = { text: 'Roni', item: {}, segs: [], start: 0, end: 4 };
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

const checks = [runPinGrouping, runSelectionChecks, runAssignedDropdown, runEditabilityCheck, runCheckboxCheck, runCheckboxInheritanceCheck, runTaskChildCheckboxScopeCheck, runStalePaletteInvalidationCheck, runReferenceEmbedRenderCheck, runVisibilityPickerCheck, runLinkPaletteCheck, runAuthPaletteCheck, runSyncShortcutCheck, runZoomShortcutCheck, runZoomDeleteCheck, runAssigneeCloseCheck, runPendingSplitDraftCheck];
Promise.allSettled(checks.map((check) => Promise.resolve().then(check))).then((results) => {
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map((failure) => failure.message).join('\n'));
  console.log('renderer behavior check passed');
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const { source } = require('./renderer-source');
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

// The extracted function may call the frame-coalesced render or the row patcher; a harness that stubs render alone
// gets both routed to its stub, a harness that defines them keeps its own (assignment, so no redeclaration).
// The hotkey lookups are the real ones (state.js), over whatever `hotkeys` map the harness declares.
const DEFAULT_HOTKEYS_SRC = source.match(/const DEFAULT_HOTKEYS = (\{[^\n]*\});/)[1];
const RENDER_SHIM = 'globalThis.renderSoon ??= (...a) => render(...a); globalThis.patchMeta ??= () => render(); globalThis.iconNode ??= () => null;\n'
  + `globalThis.DEFAULT_HOTKEYS ??= ${DEFAULT_HOTKEYS_SRC}; globalThis.hk ??= () => (typeof hotkeys === 'object' ? hotkeys : {}); globalThis.hotkeyFor ??= (id) => (Object.hasOwn(hk(), id) ? hk()[id] : DEFAULT_HOTKEYS[id]); globalThis.hotkeyIds ??= () => [...new Set([...Object.keys(DEFAULT_HOTKEYS), ...Object.keys(hk())])]; globalThis.comboOf ??= () => '';\n`;
const withShims = (src) => {
  if (/\bfuzzyMatch\b/.test(src) && !/function fuzzyMatch\(/.test(src)) src = functionSource('fuzzyMatch') + '\n' + src; // the real matcher: a harness that lists palette rows filters through it
  if (/\bchipOnly\(/.test(src) && !/const chipOnly =/.test(src)) src = 'globalThis.chipOnly ??= (el) => !!el.childNodes && el.childNodes.length === 1 && el.firstChild?.nodeType === 1 && !!el.firstChild.classList?.contains(\'mention\');\n' + src; // a harness that renders rows marks the chip-only ones too
  // nodeEl, rowSig and patchMeta all ask what a row should show of itself. That choice lives in views.js and state.js,
  // which most harnesses do not slice in, so they get the shipped default rather than each stubbing it by hand; one
  // that does slice the real definitions declares displayKeys itself and is left alone.
  // The real subtextOf, not a stub: a harness that renders rows is usually testing what ends up under the title, and a
  // stub returning '' would quietly answer for it. The last guard stops the recursion its own source would cause.
  if (/\b(displayOn|displayKeys|subtextOf)\b/.test(src) && !/const displayKeys =/.test(src) && !/function subtextOf\(/.test(src)) {
    src = functionSource('agoText') + '\n' + functionSource('subtextOf') + '\n' + src;
    src = "globalThis.displayKeys ??= () => ['status', 'assigned', 'updated']; globalThis.displayOn ??= (id) => globalThis.displayKeys().includes(id);\n" + src;
  }
  // The watch-state cache lives in state.js, which most slices do not take. A slice that only clears it — a sharing
  // change can flip whether a node is watched — should not fail for want of the map itself.
  if (/\bnotify(ById|Loading)\b/.test(src) && !/const notifyById =/.test(src)) src = 'globalThis.notifyById ??= new Map(); globalThis.notifyLoading ??= new Set();\n' + src;
  return /\b(renderSoon|patchMeta|iconNode|hotkeyFor|hotkeyIds|comboOf|settleEnter)\b/.test(src) ? RENDER_SHIM + 'globalThis.settleEnter ??= () => {};\n' + src : src;
};
function functionSource(name) {
  const asyncStart = source.indexOf('async function ' + name + '(');
  const start = asyncStart >= 0 ? asyncStart : source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'renderer function ' + name + ' is present');
  let depth = 0, end = start;
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}' && --depth === 0) return withShims(source.slice(start, end + 1));
  }
  assert.fail('renderer function ' + name + ' is complete');
}

function sourceBetween(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.notEqual(from, -1, start + ' is present');
  assert.notEqual(to, -1, end + ' is present');
  return withShims(source.slice(from, to));
}

function runTypingRenderStabilityCheck() {
  const api = vm.runInNewContext(`
    const row = { isConnected: true }, editor = { isContentEditable: true, closest: () => row };
    const titleEl = {}, outline = { contains: (el) => el === editor };
    const document = { activeElement: editor };
    let rendering = false, renderDeferred = false, selectionFrozen = false, renders = 0, caret = 17, scroll = 240;
    const renderOutline = () => { renders++; row.isConnected = false; document.activeElement = {}; caret = 0; scroll = 0; };
    const markFalling = () => {}, refreshRowChrome = () => {}, renderPills = () => {}, $ = () => ({ hidden: true });
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

async function runDraftMaterialiseFocusCheck() {
  const context = {};
  vm.runInNewContext(`
    const node = { id: 'draft:doc', kind: 'block', text: '', draft: true };
    const parent = { key: 'doc', docId: 'doc', node: { id: 'doc', kind: 'document' } };
    const item = { key: 'doc/draft:doc', docId: 'doc', node, parent, busy: true };
    const classes = new Set(['node', 'draft']);
    const row = { isConnected: true, dataset: { key: item.key }, classList: { remove: (name) => classes.delete(name) } };
    const el = { isContentEditable: true, textContent: 'H', closest: () => row };
    const document = { activeElement: el };
    const titleEl = {}, items = new Map([[item.key, item]]), kids = new Map([['doc', []]]);
    let release, renders = 0, renderDeferred = false, saved = null, slashCtx = null;
    const gate = new Promise((resolve) => { release = resolve; });
    const tana = { insertAfter: async () => { await gate; return 'real'; } };
    const run = (fn) => fn();
    const reload = async () => kids.set('doc', [{ id: 'real', kind: 'block', text: 'H' }]);
    const childrenOf = (candidate) => candidate.node.kind === 'document' ? kids.get(candidate.docId) : candidate.node.children || [];
    const inheritCheckbox = async () => {};
    const locate = (rows, id) => { const found = rows.find((candidate) => candidate.id === id); return found && { node: found }; };
    const sectionOf = () => null, fresh = new Map(); let zoom = null;
    const scheduleSave = (_item, segs) => { saved = segs; };
    const render = () => { renders++; row.isConnected = false; document.activeElement = {}; };
    ${functionSource('materialise')}
    Object.assign(globalThis, {
      start: () => materialise(item, el), release,
      type: (text) => { if (document.activeElement === el) el.textContent += text; },
      state: () => ({ text: el.textContent, sameEditor: document.activeElement === el, sameRow: row.isConnected,
        key: row.dataset.key, oldGone: !items.has('doc/draft:doc'), newPresent: items.get('doc/real') === item,
        draft: classes.has('draft'), renders, deferred: renderDeferred, saved }),
    });
  `, context);
  const creating = context.start();
  context.type('e');
  context.release();
  await creating;
  context.type('llo');
  assert.deepEqual(plain(context.state()), {
    text: 'Hello', sameEditor: true, sameRow: true, key: 'doc/real', oldGone: true, newPresent: true,
    draft: false, renders: 0, deferred: true, saved: [{ text: 'He' }],
  }, 'a draft promotes the same contenteditable in place, so every character after the first keeps landing');
}

async function runZoomedBlockTitleSaveCheck() {
  const makeHarness = (id, fail = false) => vm.runInNewContext(`
    const calls = [], pending = new Map(), item = { key: 'doc/' + ${JSON.stringify(id)}, docId: 'doc',
      node: { id: ${JSON.stringify(id)}, kind: 'block', text: 'component', segments: [{ text: 'component' }] } };
    pending.set(item.key, { item, segs: [{ text: 'changed' }], timer: null });
    let reloaded = 0, rendered = 0, error = null, queue = Promise.resolve();
    const canEditText = () => true, isReference = () => false;
    const plainOf = (segs) => segs.map((s) => s.text || '').join('');
    const segsOf = (node) => node.segments || [], saveValue = (segs) => segs;
    const dropPending = (key) => pending.delete(key);
    const reload = async () => { reloaded++; };
    const render = () => { rendered++; };
    const showError = (e) => { error = e && e.message; };
    const run = (fn) => (queue = queue.then(fn).then((value) => { showError(null); return value; }, showError));
    const tana = {
      setTitle: async () => {},
      setText: async (docId, nodeId, value) => { calls.push([docId, nodeId, value]); if (${fail}) throw new Error('no outline node ' + nodeId); },
    };
    ${functionSource('flush')}
    ({ save: async () => { flush(item.key); await queue; return { calls, reloaded, rendered, error }; } });
  `, { setTimeout, clearTimeout, Promise });
  assert.deepEqual(plain(await makeHarness(null).save()), {
    calls: [], reloaded: 1, rendered: 1, error: 'This outline row no longer exists',
  }, 'a zoomed block title never sends a null node id and re-reads the outline');
  assert.deepEqual(plain(await makeHarness('gone', true).save()), {
    calls: [['doc', 'gone', [{ text: 'changed' }]]], reloaded: 1, rendered: 1, error: 'no outline node gone',
  }, 'a rejected title save re-reads the outline instead of leaving optimistic text on screen');
}

function runSensitiveBlurCheck() {
  const api = vm.runInNewContext(`
    let sensitiveIds = null, sensitiveVisible = false;
    const sensitiveEls = new Map();
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
    ${functionSource('sensitiveHidden')}
    ${functionSource('blurSensitive')}
    ${functionSource('refreshSensitive')}
    const makeEl = () => { const classes = new Set(); return { isConnected: true, classes, classList: {
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    } }; };
    const secret = makeEl(), ordinary = makeEl();
    ({
      mount: () => { blurSensitive(secret, 'tana:text:secret'); blurSensitive(ordinary, 'library', 'tana:text:public'); },
      blurred: () => ({ secret: secret.classes.has('sensitive'), ordinary: ordinary.classes.has('sensitive') }),
      load: (ids) => { sensitiveIds = new Set(ids); },
      show: (on) => { sensitiveVisible = on; refreshSensitive(); },
      refresh: refreshSensitive,
    });
  `);
  api.mount();
  assert.deepEqual(plain(api.blurred()), { secret: true, ordinary: true }, 'startup fails closed until the local sensitive ids arrive');
  api.load(['tana:text:secret']);
  api.refresh();
  assert.deepEqual(plain(api.blurred()), { secret: true, ordinary: false }, 'the live registry updates marked and ordinary document surfaces immediately');
  api.show(true);
  assert.deepEqual(plain(api.blurred()), { secret: false, ordinary: false }, 'the session toggle reveals every marked document');
  api.show(false);
  assert.deepEqual(plain(api.blurred()), { secret: true, ordinary: false }, 'the session toggle hides them again');

  const styles = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
  const rule = styles.match(/\.sensitive\s*\{([^}]*)\}/);
  assert.ok(rule, 'styles.css has one shared sensitive treatment');
  assert.match(rule[1], /color:\s*transparent\s*!important/, 'the sensitive treatment removes the readable text');
  assert.match(rule[1], /opacity:\s*\.14/, 'the redaction bars stay subdued');
  assert.match(rule[1], /text-decoration:\s*line-through\s+#696d73\s*!important/, 'each text line becomes one redaction bar');
  assert.match(rule[1], /text-decoration-thickness:\s*\.72em\s*!important/, 'the shared redaction bar keeps the thinner treatment');
  assert.doesNotMatch(rule[1], /filter|blur|-webkit-text-security/, 'the redaction bars remain sharp');
  assert.match(styles, /\.sensitive \*\s*\{\s*color:\s*transparent\s*!important;\s*text-decoration:\s*none\s*!important;/,
    'descendants cannot add a second bar or reveal their colour or underline');
  assert.match(styles, /\.sensitive \.chip,\s*\.chip\.sensitive\s*\{\s*display:\s*none;/, 'tags disappear instead of adding masked clutter');
  assert.match(styles, /\.outline \.body\.sensitive\s*\{\s*text-decoration-thickness:\s*12px\s*!important;/,
    'all hidden outline rows use the same thin bar regardless of their text style');
  assert.match(styles, /\.outline \.body\.sensitive \.meta\s*\{\s*font-size:\s*inherit;/, 'hidden assignees use the same font metrics as their row');
  assert.match(styles, /\.pagehead h1\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/, 'a masked zoom title wraps before the details rail');
  assert.match(source, /if \(sensitiveIds\?\.has\(docId\)\) meta\.unshift\(\{ id: 'sensitive', icon: 'hidden', label: 'Sensitive', run: null \}\);/,
    'the zoom Details rail names the local classification Sensitive');
  assert.doesNotMatch(rule[1], /pointer-events|user-select/, 'blur does not block focus, clicks or selection');
  assert.ok(source.indexOf('const selection = selectionRows();') < source.indexOf("id: 'sensitiveVisibility'"),
    'the frequently used Mark/Unmark command (a selection row, current node included) ranks before the visibility toggle');
  assert.doesNotMatch(source, /label: marked \? 'Unmark as sensitive' : 'Mark as sensitive'/, 'the palette has no second, single-document copy of the sensitive row');
  for (const [surface, pattern] of [
    ['outline rows', /blurSensitive\(body, docId, target && target\.id\)/],
    ['zoomed title', /blurSensitive\(titleEl, parent && parent\.docId\)/],
    ['zoomed chips', /blurSensitive\(taskInfoEl, parent && parent\.docId\)/],
    ['zoomed fields', /blurSensitive\(el, parent && parent\.docId\)/],
    ['sidebar titles', /blurSensitive\(title, node\.id\)/],
    ['sidebar chips', /blurSensitive\(chip, node\.id\)/],
    ['owner breadcrumbs', /blurSensitive\(a, p\.id\)/],
    ['zoom breadcrumbs', /blurSensitive\(a, v\.docId\)/],
    ['outline breadcrumbs', /blurSensitive\(a, item\.docId\)/],
    ['palette labels', /blurSensitive\(label, r\.node && r\.node\.id\)/],
    ['palette hints', /blurSensitive\(h, r\.node && r\.node\.id\)/],
  ]) assert.match(source, pattern, surface + ' uses the shared sensitive treatment');
  assert.match(source, /async function loadRoots\(\)\s*\{\s*await loadSensitive\(\)/, 'sensitive ids load before any root node can render');
  assert.doesNotMatch(functionSource('setSensitiveMark') + functionSource('toggleSensitiveVisibility'), /render\(/, 'marking and visibility changes update existing surfaces without rendering');
}

async function runSelectionChecks() {
  // A row that is nothing but a mention chip (or a link) can only be clicked on that chip: Cmd/Shift+click on it
  // selects the row like on any other row, and the click that follows does not open the reference.
  const mouse = vm.runInNewContext(`
    const calls = [], handlers = {};
    const outline = { addEventListener: (name, fn) => { handlers[name] = fn; } };
    const goTo = (uri) => calls.push(['goTo', uri]), toggleSel = (key) => calls.push(['toggle', key]), rangeSelTo = (key) => calls.push(['range', key]);
    const run = (fn) => fn(), tana = { openExternal: () => calls.push(['open']), search: async () => [] };
    const focused = () => null; let sel = null;
    ${sourceBetween("outline.addEventListener('click'", "filterEl.addEventListener('input'")}
    ${sourceBetween("outline.addEventListener('mousedown'", "outline.addEventListener('focusin'")}
    const chip = { className: 'mention', dataset: { uri: 'tana:text:ref' } };
    const line = { parentElement: { dataset: { key: 'row' } } };
    chip.closest = (q) => (q.includes('.mention') ? chip : q === '.line' ? line : q.split(', ').includes('a') ? chip : null);
    ({ click: (mods) => { calls.length = 0; const e = { target: chip, ...mods, preventDefault() {} }; handlers.mousedown(e); handlers.click(e); return calls; } });
  `);
  assert.deepEqual(plain(mouse.click({ metaKey: false, shiftKey: false })), [['goTo', 'tana:text:ref']], 'a plain click on a chip opens the reference');
  assert.deepEqual(plain(mouse.click({ metaKey: true, shiftKey: false })), [['toggle', 'row']], 'Cmd+click on a chip selects its row instead');
  assert.deepEqual(plain(mouse.click({ metaKey: false, shiftKey: true })), [['range', 'row']], 'and Shift+click extends the selection to it');

  const selection = sourceBetween('function rangeKeys(', '// ---- filter pills');
  const canEditStructure = sourceBetween('const canEditStructure =', 'const chatIcon =');
  const rendererHistory = functionSource('history');
  const makeHarness = (readOnly = false) => {
    const value = vm.runInNewContext(`
      const calls = [];
      const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, kind: 'block', editable: ${readOnly ? "id === 'b' ? false : true" : 'true'} }));
      const parentEl = { children: [] };
      const classes = () => { const values = new Set(['node']); return { add: (...names) => names.forEach((name) => values.add(name)), remove: (...names) => names.forEach((name) => values.delete(name)), contains: (name) => values.has(name) }; };
      const elFor = (node) => ({ dataset: { key: node.id }, parentElement: parentEl, classList: classes() });
      parentEl.children.push(...nodes.map(elFor));
      const parent = { id: 'parent' };
      const items = new Map(nodes.map((node) => [node.id, { key: node.id, docId: 'doc', node, parent }]));
      const undoStack = [], redoStack = [];
      let sel = null, caret, rendered = 0, selectionFrozen = false, renderDeferred = false, error = null;
      const snapshot = () => nodes.map((node) => ({ ...node }));
      const restore = (saved) => {
        nodes.splice(0, nodes.length, ...saved.map((node) => ({ ...node })));
        parentEl.children.splice(0, parentEl.children.length, ...nodes.map(elFor));
        items.clear(); nodes.forEach((node) => items.set(node.id, { key: node.id, docId: 'doc', node, parent }));
      };
      const mut = (fn) => { undoStack.push(snapshot()); redoStack.length = 0; return fn(); };
      const applyHistory = (from, to) => { const saved = from.pop(); if (!saved) return null; to.push(snapshot()); restore(saved); return 'doc'; };
      const nodeElOf = (key) => parentEl.children.find((el) => el.dataset.key === key);
      const nodeEls = () => parentEl.children;
      const outline = { contains: () => false, querySelectorAll: () => parentEl.children.filter((el) => el.classList.contains('selected')) };
      const document = { activeElement: null }, titleEl = {};
      const childrenOf = () => nodes;
      const texts = () => parentEl.children;
      const keyOfEl = (el) => el.dataset.key;
      const placeCaret = (key) => { caret = key; };
      const focusAbove = () => { caret = 'above'; };
      const dropPending = () => {};
      const flush = () => {};
      const canEditItem = (item) => item.node.editable !== false;
      const isReference = () => false, isDivider = () => false, canEditNode = (node) => node && node.editable !== false;
      ${canEditStructure}
      const render = () => { rendered++; };
      const showError = (value) => { error = value && value.message; };
      const reload = async () => {};
      const patchDoc = async () => {}; // history() patches the changed row; this harness models the outline, not the row caches
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
      ({ set: (value) => { const i = nodes.findIndex((node) => node.id === value.anchor), j = nodes.findIndex((node) => node.id === value.focus); sel = { keys: new Set(value.keys || nodes.slice(Math.min(i, j), Math.max(i, j) + 1).map((node) => node.id)), anchor: value.anchor, focus: value.focus }; }, keys: () => selKeys(), moveSel, removeSel, selKey, toggleSel, extendSel,
        undo: () => history('undo'), redo: () => history('redo'),
        depths: () => nodes.map((node) => node.depth || 0), opened: () => [...open.keys()],
        noBatch: () => { delete tana.indentMany; delete tana.outdentMany; },
        collapseMidway: () => { collapseMidway = true; },
        error: () => error,
        state: () => ({ order: nodes.map((node) => node.id), sel: sel && { anchor: sel.anchor, focus: sel.focus }, caret, calls, rendered }) });
    `);
    return value;
  };

  const move = makeHarness();
  move.set({ anchor: 'b', focus: 'c' });
  assert.deepEqual(plain(move.keys()), ['b', 'c'], 'selection spans visible sibling blocks');

  const arbitrary = makeHarness();
  arbitrary.toggleSel('b'); arbitrary.toggleSel('d');
  assert.deepEqual(plain(arbitrary.keys()), ['b', 'd'], 'Cmd+click can add a non-contiguous row and keeps visual order');
  assert.deepEqual(plain(arbitrary.state().sel), { anchor: 'd', focus: 'd' }, 'the latest Cmd+click becomes the keyboard range anchor');
  arbitrary.toggleSel('b');
  assert.deepEqual(plain(arbitrary.keys()), ['d'], 'Cmd+click removes one selected row without disturbing the rest');
  arbitrary.set({ keys: ['a', 'c'], anchor: 'c', focus: 'c' });
  arbitrary.extendSel({ key: 'c' }, 1);
  assert.deepEqual(plain(arbitrary.keys()), ['a', 'c', 'd'], 'Shift+Down extends the anchored range and retains an unrelated Cmd-selected row');
  arbitrary.extendSel({ key: 'd' }, -1);
  assert.deepEqual(plain(arbitrary.keys()), ['a', 'c'], 'Shift+Up shrinks only that anchored range');

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

  const sparseRemove = makeHarness();
  sparseRemove.set({ keys: ['b', 'd'], anchor: 'd', focus: 'd' });
  sparseRemove.selKey(event()); await settle();
  assert.deepEqual(plain(sparseRemove.state().order), ['a', 'c'], 'removing scattered sibling rows is complete and unambiguous');
  assert.deepEqual(plain(sparseRemove.state().calls), [['removeMany', ['b', 'd']]], 'scattered removal is still one batch');

  const sparseMove = makeHarness();
  sparseMove.set({ keys: ['b', 'd'], anchor: 'd', focus: 'd' });
  sparseMove.selKey({ key: 'ArrowDown', metaKey: true, ctrlKey: false, shiftKey: true }); await settle();
  assert.deepEqual(plain(sparseMove.state().calls), [], 'scattered rows are not partially moved');
  assert.equal(sparseMove.error(), 'Move requires a contiguous selection of writable sibling blocks', 'a scattered move gives an explicit reason');

  const sparseIndent = makeHarness();
  sparseIndent.set({ keys: ['b', 'd'], anchor: 'd', focus: 'd' });
  sparseIndent.selKey({ key: 'Tab', metaKey: false, ctrlKey: false, shiftKey: false }); await settle();
  assert.deepEqual(plain(sparseIndent.state().calls), [], 'scattered rows are not partially indented');
  assert.equal(sparseIndent.error(), 'Indent requires a contiguous selection of writable sibling blocks', 'a scattered indent gives an explicit reason');

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

async function runMultiTaskPaletteCheck() {
  const contextFns = [functionSource('taskActionContext'), functionSource('taskActionRows'), functionSource('selectionRows'), functionSource('removeSelection'), functionSource('addToDateNode')].join('\n');
  const context = vm.runInNewContext(`
    const task = (id, editable = true) => ({ id, kind: 'document', icon: 'task', editable, stateType: 'open' });
    const rows = [
      { key: 't1', docId: 't1', node: task('t1') },
      { key: 'meeting', docId: 'meeting', node: { id: 'meeting', kind: 'document', icon: 'meeting', editable: true } },
      { key: 'locked', docId: 'locked', node: task('locked', false) },
      { key: 't2', docId: 't2', node: task('t2') },
    ];
    const blocks = [{ key: 'doc/b1', docId: 'doc', node: { id: 'b1', kind: 'block' } }, { key: 'doc/b2', docId: 'doc', node: { id: 'b2', kind: 'block' } }];
    const items = new Map([...rows, ...blocks].map((item) => [item.key, item]));
    let selected = rows.map((item) => item.key), palDoc = task('palette-task');
    const selKeys = () => selected;
    const isTask = (node) => node.kind === 'document' && node.icon === 'task';
    const canEditNode = (node) => node.editable !== false;
    const stateOf = (node) => node.stateType;
    const STATES = [['proposed', 'Inbox'], ['open', 'In Progress'], ['closed', 'Completed'], ['not_now', 'Later']];
    const taskMetaById = new Map(), loadTaskMeta = () => {}, memberName = (id) => id;
    const calls = [];
    const tana = { setState() {}, setStateMany() {}, taskMeta() {}, setAssignees() {}, setAssigneesMany() {}, setSensitive() {},
      deleteDocument: async (id) => { calls.push(['delete', id]); }, accessOptions: async () => ({ deletable: true }),
      todayNode: async () => { calls.push(['todayNode']); return 'day'; }, weekNode: async () => { calls.push(['weekNode']); return 'week'; },
      insertAfter: async (docId, nodeId, text) => { calls.push(['insertAfter', docId, nodeId, text]); return 'block'; },
      setText: async (docId, nodeId, segments) => { calls.push(['setText', docId, nodeId, JSON.stringify(segments)]); } };
    const removeSel = (keys) => { calls.push(['blocks', keys.join(',')]); };
    const run = (fn) => fn(), loadRoots = async () => {}, render = () => {}, invalidateNode = () => {}, showNote = (note) => { calls.push(['note', note]); };
    const canEditItem = (item) => item.node.editable !== false;
    const canEditStructure = (item) => canEditItem(item);
    let sel = null, zoom = null;
    const openDoc = () => {};
    const open = new Map(), CHEV = '<svg/>';
    const canExpand = (item) => item.node.kind === 'document', hasKids = () => true, isOpen = (item) => open.get(item.key) === true;
    let opened = null; const setOpen = (item, value) => { opened = [item.key, value]; open.set(item.key, value); };
    let ticked = null; const toggleDone = (item) => { ticked = [item.key]; item.node.done = item.node.done ? 0 : 1; };
    const openStatusPalette = () => {}, openAssigneePalette = () => {}, openManyAssigneePalette = () => {};
    const sensitiveIds = new Set(['t2']), isRealId = () => true;
    let marked = null;
    const setSensitiveMark = (ids, on) => { marked = [ids, on]; };
    ${contextFns}
    Object.assign(globalThis, {
      labels: () => taskActionRows().map((row) => [row.label, row.hint, !!row.disabled]),
      one: () => { selected = ['t1']; return taskActionRows().map((row) => row.label); },
      locked: () => { selected = ['locked']; return taskActionRows().map((row) => row.label); },
      selection: (keys) => { selected = keys; return selectionRows().map((row) => [row.group, row.label]); },
      markAll: () => { selected = rows.map((item) => item.key); selectionRows().find((row) => row.id === 'sensitive').run(); return marked; },
      remove: async (keys) => { calls.length = 0; selected = keys; try { await removeSelection(keys); } catch (e) { calls.push(['error', e.message]); } return calls; },
      addTo: async (keys, target) => { calls.length = 0; selected = keys; await selectionRows().find((row) => row.label.endsWith(target === 'week' ? 'to This Week' : 'to Today')).run(); return calls; },
      ids: (keys) => { selected = keys; return selectionRows().map((row) => row.id); },
      del: (keys) => { selected = keys; const row = selectionRows().find((r) => r.id === 'delete'); return [row.label, row.hint || '', !!row.disabled]; },
     current: (id) => { selected = []; palDoc = items.get(id).node; return selectionRows().map((row) => [row.group, row.label, row.hint || '', !!row.disabled]); },
      kbd: (id, rowId) => { selected = []; palDoc = items.get(id).node; return selectionRows().find((row) => row.id === rowId).kbd; },
      toggleOpen: (id) => { selected = []; palDoc = items.get(id).node; const before = selectionRows().find((row) => row.id === 'expand' || row.id === 'collapse'); before.run(); const after = selectionRows().find((row) => row.id === 'expand' || row.id === 'collapse'); return [before.label, before.kbd, opened, after.label, after.kbd]; },
      toggleTask: (id) => { selected = []; palDoc = items.get(id).node; const before = selectionRows().find((row) => row.id === 'toggleDone'); before.run(); return [before.label, ticked, selectionRows().find((row) => row.id === 'toggleDone').label]; },
      kbdSelected: (keys, rowId) => { selected = keys; return selectionRows().find((row) => row.id === rowId).kbd; },
      zoomedCurrent: (id) => { selected = []; palDoc = items.get(id).node; zoom = { docId: id }; try { return selectionRows().map((row) => [row.group, row.label]); } finally { zoom = null; } },
    });
  `);
  assert.deepEqual(plain(context.labels()), [
    ['Set status for 2 tasks', '2 skipped', false],
    ['Assign 2 tasks to', '2 skipped', false],
  ], 'palette labels report the eligible and skipped counts from the selected rows');
  assert.deepEqual(plain(context.one()), ['Set status', 'Edit assignees', 'Assign to …'], 'one selected task keeps the single-task actions');
  assert.deepEqual(plain(context.locked()), [], 'one read-only selected task offers no mutation');
  // What acts on the selection comes first, in its own group, and reaches every selected row, not only the tasks.
  assert.deepEqual(plain(context.selection(['t1', 'meeting', 'locked', 't2'])), [
    ['Selection', 'Set status for 2 tasks'],
    ['Selection', 'Assign 2 tasks to'],
    ['Selection', 'Add 4 items to Today'],
    ['Selection', 'Add 4 items to This Week'],
    ['Selection', 'Mark 4 items as sensitive'],
    ['Selection', 'Delete 3 items'],
  ], 'a selection offers sensitivity for everything in it and the task actions for the tasks in it');
  assert.deepEqual(plain(context.selection(['t2'])), [['Selection', 'Set status'], ['Selection', 'Edit assignees'], ['Selection', 'Assign to …'], ['Selection', 'Add 1 item to Today'], ['Selection', 'Add 1 item to This Week'], ['Selection', 'Unmark 1 item as sensitive'], ['Selection', 'Delete 1 item']],
    'one selected row is still a selection, and a marked one offers to unmark');
  // Delete reports what it can remove before it is run, the way the task actions do.
  assert.deepEqual(plain(context.del(['t1', 'meeting', 'locked', 't2'])), ['Delete 3 items', '1 skipped', false], 'a read-only row is counted as skipped, not deleted');
  assert.deepEqual(plain(context.del(['locked'])), ['Delete 0 items', '1 skipped', true], 'and a selection of nothing deletable disables the row');
  assert.deepEqual(plain(context.del(['doc/b1', 'doc/b2'])), ['Delete 2 items', '', false], 'a selection of blocks is deletable in one step');
  assert.deepEqual(plain(context.del(['t1', 'doc/b1'])), ['Delete 1 item', '1 skipped', false], 'and a block beside a document is skipped: the two removals are different operations');
  assert.deepEqual(plain(context.selection([])), [], 'with nothing selected the palette is about the app again');
  // With nothing selected the same rows act on the current node, without counts and under their own heading.
  assert.deepEqual(plain(context.current('t1')), [
    ['Current node', 'Zoom in', '', false],
    ['Current node', 'Expand', '', false],
    ['Current node', 'Complete', '', false],
    ['Current node', 'Set status', 'In Progress', false],
    ['Current node', 'Edit assignees', 'Loading…', false],
    ['Current node', 'Assign to …', '', false],
    ['Current node', 'Add to Today', '', false],
    ['Current node', 'Add to This Week', '', false],
    ['Current node', 'Mark as sensitive', '', false],
    ['Current node', 'Delete', '', false],
  ], 'the current node gets every selection action');
  assert.deepEqual(plain(context.zoomedCurrent('t1')).slice(0, 2).map((row) => row[1]), ['Complete', 'Set status'], 'the zoomed document itself offers no Zoom in but keeps its checkbox');
  assert.deepEqual(plain(context.current('locked')).filter((row) => row[1] === 'Delete'), [['Current node', 'Delete', 'Read-only', true]], 'and a read-only current node cannot be deleted');
  assert.equal(context.kbd('t1', 'delete'), '⇧⌘⌫', 'the Delete row names the shortcut that does the same thing');
  assert.deepEqual(plain(context.toggleOpen('t1')), ['Expand', null, ['t1', true], 'Collapse', null], 'Expand opens the row and becomes Collapse (their keys come from DEFAULT_HOTKEYS in paletteRows)');
  assert.deepEqual(plain(context.toggleTask('t1')), ['Complete', ['t1'], 'Reopen'], 'Complete ticks the task and becomes Reopen');
  assert.deepEqual(plain(context.current('meeting')).filter((row) => ['Complete', 'Reopen'].includes(row[1])), [], 'a meeting has no checkbox row');
  assert.equal(context.kbdSelected(['t1', 't2'], 'delete'), undefined, 'a selection of documents has no such key, so the row shows none');
  assert.deepEqual(plain(context.selection(['t1', 't2'])).map((row) => row[0]), ['Selection', 'Selection', 'Selection', 'Selection', 'Selection', 'Selection'], 'a real selection keeps its own heading');
  assert.deepEqual(plain(context.markAll()), [['t1', 'meeting', 'locked', 't2'], true], 'marking applies to every selected document at once');
  // Adding to the day's or the week's node references the selection there: one appended block per row, its text
  // replaced by a mention of that node, so nothing is copied and nothing is moved.
  assert.deepEqual(plain(await context.addTo(['t1', 'meeting'], 'today')), [
    ['todayNode'],
    ['insertAfter', 'day', null, ''], ['setText', 'day', 'block', JSON.stringify([{ mention: { uri: 't1', label: '' } }])],
    ['insertAfter', 'day', null, ''], ['setText', 'day', 'block', JSON.stringify([{ mention: { uri: 'meeting', label: '' } }])],
    ['note', 'Added 2 items to Today'],
  ], 'every selected row becomes a mention at the end of today\'s node');
  assert.deepEqual(plain(await context.addTo(['t1'], 'week')).map((call) => call[0]), ['weekNode', 'insertAfter', 'setText', 'note'], 'and the week row writes into the week node instead');
  // Cmd+Shift+K records a hotkey per row id and refuses a row without one, so every selection action carries a
  // stable id even though its label counts the selection.
  const selIds = plain(context.ids(['t1', 'meeting', 'locked', 't2']));
  assert.deepEqual(selIds, ['status', 'assign', 'addToday', 'addWeek', 'sensitive', 'delete'], 'every selection action can be given a keyboard shortcut');
  assert.equal(new Set(selIds).size, selIds.length, 'and no two of them share an id, which would share a shortcut');
  // Deleting a selection: documents go one by one through the permission check, blocks reuse the single-step removal.
  assert.deepEqual(plain(await context.remove(['t1', 'meeting'])), [['delete', 't1'], ['delete', 'meeting']], 'every selected document is deleted, in order');
  assert.deepEqual(plain(await context.remove(['doc/b1', 'doc/b2'])), [['blocks', 'doc/b1,doc/b2']], 'a selection of blocks takes the existing one-step path instead');
  assert.deepEqual(plain(await context.remove(['locked', 't1'])), [['error', 'Only writable documents and blocks can be deleted']],
    'a read-only row stops the delete and says so, instead of deleting what it can');

  const applyFns = [functionSource('taskResult'), functionSource('applyTaskChange'), functionSource('statusRows'), functionSource('manyAssigneeRows')].join('\n');
  const apply = vm.runInNewContext(`
    const docs = [{ id: 't1', stateType: 'open' }, { id: 't2', stateType: 'open' }];
    let sel = { keys: new Set(['t1', 'meeting', 't2']), anchor: 't2', focus: 't2' };
    let selectionFrozen = false, renderDeferred = false, closed = 0, note = null;
    const calls = [], renders = [], members = [{ id: 'person', title: 'Person' }];
    let palTaskCtx = { docs, selected: 3, skipped: 1, fromSelection: true, multi: true };
    const STATES = [['proposed', 'Inbox'], ['open', 'In Progress'], ['closed', 'Completed'], ['not_now', 'Later']];
    const stateOf = (node) => node.stateType, memberName = (id) => members.find((member) => member.id === id).title;
    const loadMembers = () => {}, closePalette = () => { closed++; }, holdRow = () => {};
    // chrome = the branch a held render takes: the boxes and the pills catch up, the rows stay where they are
    const render = (force) => { renders.push(force === true ? 'full' : 'chrome'); };
    const showNote = (value) => { note = value; };
    const run = (fn) => Promise.resolve().then(fn).catch((error) => { throw error; });
    const tana = {
      setState: async (id, state) => { calls.push(['state', [id], state]); return 1; }, // the single-task path, for a change with nothing selected
      setStateMany: async (ids, state) => { calls.push(['state', [...ids], state]); return ids.length; },
      setAssigneesMany: async (ids, uris) => { calls.push(['assignees', [...ids], [...uris]]); return ids.length; },
    };
    ${applyFns}
    Object.assign(globalThis, {
      status: () => statusRows('').find((row) => row.label === 'Completed').run(),
      assign: () => manyAssigneeRows('').find((row) => row.label === 'Person').run(),
      typed: () => [statusRows('ipr').map((row) => row.label), statusRows('lat').map((row) => row.label), manyAssigneeRows('pe').map((row) => row.label)],
      typedUnassigned: () => manyAssigneeRows('unas').map((row) => row.label),
      state: () => ({ calls, selected: [...sel.keys], frozen: selectionFrozen, closed, note }),
      rendered: () => [...renders],
      solo: () => { sel = null; palTaskCtx = { docs: [docs[0]], selected: 1, skipped: 0, fromSelection: false, multi: false }; return statusRows('').find((row) => row.label === 'Completed').run(); },
    });
  `, { setTimeout, Promise });
  // Unassigned narrows with every other row: while it ignored the query it stayed first and highlighted, so typing a
  // name and pressing Enter cleared the assignee instead of setting the one that had just been typed.
  assert.deepEqual(plain(apply.typed()), [['In Progress'], ['Later'], ['Person']], 'the status and assignee levels match the way the command palette does: word prefixes in order, Unassigned included');
  assert.deepEqual(plain(apply.typedUnassigned()), ['Unassigned'], 'typing toward Unassigned still reaches it');
  // taskResult reports through a 0 ms timer, which two setImmediates outrun on a loaded machine: wait for a timer
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  apply.status(); await settle();
  assert.deepEqual(plain(apply.state()), {
    calls: [['state', ['t1', 't2'], 'closed']], selected: ['t1', 'meeting', 't2'], frozen: true, closed: 1,
    note: 'Updated 2 tasks; skipped 1 non-task or read-only row',
  }, 'bulk status uses one batch, reports skips, and leaves the complete selection frozen in place');
  // A frozen selection used to take no render at all, so the boxes kept the status they had and Clean up never appeared.
  assert.deepEqual(plain(apply.rendered()), ['chrome'],
    'a frozen selection still renders: chrome only, so the boxes and the Clean up pill catch up while the rows stay put');
  apply.assign(); await settle();
  assert.deepEqual(plain(apply.state().calls.at(-1)), ['assignees', ['t1', 't2'], ['person']], 'bulk assignment uses one batch for the same eligible selection');
  assert.deepEqual(plain(apply.state().selected), ['t1', 'meeting', 't2'], 'bulk assignment also preserves selected rows');
  // Nothing selected: the caret is back in the row that changed, and nothing is being held, so it renders in full.
  apply.solo(); await settle();
  assert.deepEqual(plain(apply.rendered()), ['chrome', 'chrome', 'full'],
    'while an unheld change renders in full, so the row can move to wherever it now belongs');
}

function runAssignedDropdown() {
  // The pills now serve two kinds of page, so pillDefs asks which one it is on. These harnesses are all about views,
// so they answer "a view" — the saved search side gets its own check rather than a share of theirs.
const definitions = 'const onSearchPage = () => false, pillKey = () => view, setSearchF = () => {}, displayPref = {};\n' + sourceBetween('const STATES =', 'function renderPills');
  const api = vm.runInNewContext(`
    let view = 'tasks';
    const filters = new Map([['tasks', { types: ['tasks'], states: ['open'], assignee: 'me' }]]);
    const views = [{ id: 'tasks', kind: true }];
    let members = [
      { id: 'me', title: 'Robin', me: true },
      { id: 'sam', title: 'Sam' },
      { id: 'brage', title: 'Priya' },
    ];
    let saved;
    const tana = {};
    const $ = () => ({ hidden: false });
    const renderPills = () => {};
    const showError = () => {};
    const setViewF = (patch) => { saved = patch; filters.set(view, { ...filters.get(view), ...patch }); };
    const groupPref = {}, sortPref = {}, render = () => {};
    ${definitions}
    ({ pillDefs, saved: () => saved });
  `);
  const assigned = api.pillDefs().find((definition) => definition.id === 'assigned');
  assert.equal(assigned.value, 'You (Robin)');
  const rows = assigned.rows();
  assert.deepEqual(plain(rows.filter((row) => row.label).map((row) => row.label)), ['Anyone', 'You (Robin)', 'Unassigned', 'Sam', 'Priya']);
  rows.find((row) => row.label === 'Sam').run();
  assert.deepEqual(plain(api.saved()), { assignee: 'sam' }, 'member choice updates the task assignee filter');
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
  const runKey = (editable, key = 'Enter', reference = false) => {
    const context = { listener: undefined };
    vm.runInNewContext(`
      let mutation = 0, zoomed = 0, opened = 0, prevented = 0;
      const editable = ${JSON.stringify(editable)};
      const outline = { addEventListener: (_name, fn) => { listener = fn; } };
      const item = { key: 'row', docId: 'row', node: { kind: 'document', editable, text: 'Row' } };
      const items = new Map([['row', item]]);
      const keyOfEl = () => 'row';
      const caretOffset = () => 0, getSelection = () => ({ isCollapsed: true });
      const isImage = () => false, isOpen = () => false, zoom = null;
      const canEditItem = (item) => item.node.editable !== false;
      const isReference = () => ${JSON.stringify(reference)}, canEditStructure = () => ${JSON.stringify(reference)}, canEditText = () => false;
      const zoomTo = () => { zoomed++; }, openReference = () => { opened++; };
      const flush = () => {}, extendSel = () => {}, startLink = () => {}, toggleDone = () => { mutation++; };
      const insertAtCaret = () => { mutation++; }, draftDoc = () => { mutation++; }, splitNode = () => { mutation++; };
      const shiftNode = () => { mutation++; }, removeNode = () => { mutation++; }, setOpen = () => { mutation++; };
      const atEdge = () => false, moveTo = () => {}, selectionOffsets = () => null;
      const focusAbove = () => {}, texts = () => [], placeCaret = () => {};
      const isAtomic = () => false, MARK_KEYS = { b: 'bold', i: 'italic', e: 'code' };
      const toolbarEl = { hidden: true }, returnToSelection = () => {}, focusToolbar = () => {}, toggleMarkKey = () => {};
      ${withShims(source.slice(start, end))}
      Object.assign(globalThis, { mutation: () => mutation, state: () => ({ mutation, zoomed, opened, prevented }) });
    `, context);
    const event = { key, metaKey: false, ctrlKey: false, shiftKey: false, target: { closest: () => ({ textContent: 'Row' }) }, preventDefault: () => { context.prevented = true; } };
    context.listener(event);
    return { ...context.state(), prevented: !!context.prevented };
  };
  assert.equal(runKey(false).mutation, 0, 'read-only member keyboard input cannot create or mutate a node');
  assert.equal(runKey(true).mutation, 1, 'editable document keyboard input still uses the editor');
  // A focused read-only row cannot be typed into, so Space is free to zoom into it; a reference opens its target.
  assert.deepEqual(plain(runKey(false, ' ')), { mutation: 0, zoomed: 1, opened: 0, prevented: true }, 'Space on a focused read-only row zooms into it');
  assert.deepEqual(plain(runKey(false, ' ', true)), { mutation: 0, zoomed: 0, opened: 1, prevented: true }, 'Space on a focused reference opens what it points at');
  assert.deepEqual(plain(runKey(true, ' ')).zoomed, 0, 'and an editable row keeps Space for typing');
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
    const hasKids = () => false, isOpen = () => false, setOpen = () => {}, zoomTo = () => {}, blurSensitive = () => {};
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
  const liveUpdates = sourceBetween('tana.onChanged((docId, info) => {', 'tana.onStatus(showStatus);');
  const recent = sourceBetween('const recent =', 'function recordRecent');
  const helpers = [functionSource('forgetRecent'), functionSource('invalidatePinCaches'), functionSource('invalidateNode')].join('\n');
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
    ${recent}
    let views = [], palRows = [], palDoc = null, pinInfo = null, dropDoc = null;
    let zoom = { docId: keptId };
    const taskMetaById = new Map(), kids = new Map(), extra = new Map(), paths = new Map(), fresh = new Map();
    const loadRoots = async () => {};
    const reload = async () => {};
    const loadPins = async () => { pinInfo = null; };
    const loadView = () => {};
    const render = () => {};
    const renderSoon = () => {};
    const isTask = (node) => node.kind === 'document' && node.icon === 'task', relatedBy = new Map(), railGroups = () => [];
    const tanaNode = { text: 'beta' };
    const showError = (error) => { throw error; };
    const view = 'tasks';
    const tana = {
      onChanged: (callback) => { listener = callback; },
      onRemoved: (callback) => { removeListener = callback; },
      onUnpinned: (callback) => { unpinListener = callback; },
      node: async () => tanaNode,
    };
    ${helpers}
    ${liveUpdates}
    Object.assign(globalThis, {
      update: (id) => listener(id),
      removed: (id) => removeListener(id),
      unpinned: (id) => unpinListener(id),
      state: () => ({ recent: recent().map((node) => node.id), zoom: zoom && zoom.docId }),
    });
  `, context);
  context.update('tana:text:01j0keep00000000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state()), {
    recent: ['tana:text:01j0stale0000000000000000', 'tana:text:01j0keep00000000000000000'],
    zoom: 'tana:text:01j0keep00000000000000000',
  }, 'an ordinary string update retains Cmd+K pins, recently viewed rows, and zoom state');

  context.update(null);
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state()), {
    recent: ['tana:text:01j0stale0000000000000000', 'tana:text:01j0keep00000000000000000'],
    zoom: 'tana:text:01j0keep00000000000000000',
  }, 'a general null update refreshes data without evicting Cmd+K state');

  context.unpinned('tana:text:01j0stale0000000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state()), {
    recent: ['tana:text:01j0stale0000000000000000', 'tana:text:01j0keep00000000000000000'],
    zoom: 'tana:text:01j0keep00000000000000000',
  }, 'an unpin is not a deletion: it evicts nothing');

  context.removed('tana:text:01j0stale0000000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state()), {
    recent: ['tana:text:01j0keep00000000000000000'],
    zoom: 'tana:text:01j0keep00000000000000000',
  }, 'an explicit removal event evicts only its exact ID from the recently viewed rows');
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
    const hasKids = () => false, isOpen = () => false, setOpen = () => {}, zoomTo = () => {}, blurSensitive = () => {};
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
    let palMode = 'visibilityPeople', closed = false;
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
    const openCommandPalette = () => { palMode = 'cmd'; };
    const openVisibilityPalette = () => { palMode = 'visibility'; };
    const closePalette = () => { closed = true; };
    ${functionSource('backPalette')}
    ${applySharing}
    ${visibilityPeopleRows}
    ({
      rows: () => visibilityPeopleRows(''),
      back: () => backPalette(),
      mode: (next) => { palMode = next; closed = false; },
      state: () => ({ calls, selected: [...visibilityPeople], palMode, closed }),
    });
  `);
  const rows = api.rows();
  assert.equal(rows[0].label, 'Back to visibility', 'the people step exposes its parent level as the first visible row');
  assert.deepEqual(plain(api.state()), { calls: [], selected: [], palMode: 'visibilityPeople', closed: false }, 'opening the visibility picker does not write sharing');
  rows.find((row) => row.label === 'Member One').run();
  assert.deepEqual(plain(api.state()), { calls: [], selected: ['tana:user-profile:01j0person000000000000000'], palMode: 'visibilityPeople', closed: false }, 'choosing a picker row stages the selection without mutation');
  api.rows().find((row) => row.label === 'Apply selected people').run();
  await Promise.resolve();
  assert.deepEqual(plain(api.state()), {
    calls: [['tana:text:01j0doc000000000000000000', { rule: 'people', participants: [{ uri: 'tana:user-profile:01j0person000000000000000', role: 'editor' }] }]],
    selected: ['tana:user-profile:01j0person000000000000000'],
    palMode: 'visibilityPeople', closed: true,
  }, 'the visibility picker writes only after explicit Apply');
  api.mode('visibilityPeople');
  api.back();
  assert.equal(api.state().palMode, 'visibility', 'Escape and the visible Back row return the people step to the mode picker');
  api.mode('visibility'); api.back();
  assert.equal(api.state().closed, true, 'Escape from the visibility mode picker closes the palette');
  assert.match(source, /rules\.has\('me'\)[\s\S]*rules\.has\('people'\)[\s\S]*rules\.has\('inherit'\)/, 'the mode picker preserves every sharing rule reported by the backend');
}

async function runLinkPaletteCheck() {
  const resultRows = functionSource('resultRows');
  const searchNow = functionSource('searchNow');
  const start = source.indexOf("palInput.addEventListener('keydown', (e) => {");
  const end = source.indexOf("palette.addEventListener", start);
  assert.notEqual(start, -1, '@ palette keyboard handler is present');
  const context = { resolveSearch: undefined, press: undefined };
  vm.runInNewContext(`
    let linkCtx = { text: 'Dana', item: {}, segs: [], start: 0, end: 4 }, pinCtx = null;
    let palRows = [], palIndex = 0, palBusy = false, palSeq = 0, palTimer = null, palMode = 'search', palEnter = null;
    let searchResolve, actions = [];
    const palInput = { value: 'Dana', addEventListener: (_name, fn) => { press = fn; } };
    const tana = { search: () => new Promise((resolve) => { searchResolve = resolve; }) };
    const asDoc = (node) => ({ ...node, text: node.text || node.title, kind: 'document' });
    const docRow = (node, hint, run) => ({ label: node.text, node, hint, run });
    const createAndLink = () => { actions.push('create'); };
    const linkTo = () => { actions.push('link'); };
    const openResult = () => { actions.push('open'); };
    const renderPalette = () => {};
    const showError = (error) => { throw error; };
    const runRow = (row) => row.run();
    ${functionSource('chooseRow')}
    ${functionSource('settleEnter')}
    ${resultRows}
    ${functionSource('titleHits')}
    ${searchNow}
    ${withShims(source.slice(start, end))}
    searchNow();
    Object.assign(globalThis, {
      resolveSearch: (rows) => searchResolve(rows),
      state: () => ({ palIndex, rows: palRows.map((row) => ({ label: row.label, create: !!row.create })), actions, busy: palBusy }),
      again: () => { actions.length = 0; palInput.value = 'Dan'; searchNow(); },
    });
  `, context);
  context.resolveSearch([{ id: 'tana:user-profile:roni', title: 'Dana Brooks' }]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(plain(context.state().rows), [
    { label: 'Create “Dana”', create: true },
    { label: 'Dana Brooks', create: false },
  ], 'link search keeps Create available but returns the existing Dana result');
  assert.equal(context.state().palIndex, 1, 'async link search selects the first existing result');
  const event = (metaKey) => ({ key: 'Enter', metaKey, ctrlKey: false, shiftKey: false, preventDefault: () => {}, stopPropagation: () => {} });
  context.press(event(false));
  context.press(event(true));
  // "@" at a caret: no selection, so nothing to create until something is typed, and the first result is selected
  const caret = vm.runInNewContext(`
    let linkCtx = { text: '', item: {}, segs: [], start: 3, end: 3 }, pinCtx = null;
    let palRows = [], palIndex = 0, palBusy = false, palSeq = 0, palTimer = null, palMode = 'search';
    let searchResolve, created = null;
    const palInput = { value: '' };
    const tana = { search: () => new Promise((resolve) => { searchResolve = resolve; }) };
    const asDoc = (node) => ({ ...node, text: node.text || node.title, kind: 'document' });
    const docRow = (node, hint, run) => ({ label: node.text, node, hint, run });
    const createAndLink = (ctx, title) => { created = title; }, linkTo = () => {}, openResult = () => {};
    const renderPalette = () => {}, showError = (error) => { throw error; }, recentRows = () => [{ id: 'r', title: 'Recent' }];
    ${resultRows}
    ${functionSource('titleHits')}
    ${searchNow}
    ({ type: (q) => { palInput.value = q; searchNow(); }, resolve: (rows) => searchResolve(rows), state: () => ({ palIndex, rows: palRows.map((row) => row.label) }), bold: () => palRows.map((row) => (row.match ? row.match.map((i) => row.label[i]).join('') : null)), create: () => { palRows[0].run(); return created; } });
  `);
  // Search hits: the titles holding the most typed words lead, whatever order Tana answered in, and only those words are bold
  caret.type('try 1');
  caret.resolve([{ id: 'a', title: 'Finding the Balance' }, { id: 'b', title: 'Test OmniCharge and reply on Tue 1 Sep' }, { id: 'c', title: 'Try the 1-day framework' }, { id: 'd', title: 'Entry 12' }]);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(plain(caret.state().rows), ['Create “try 1”', 'Try the 1-day framework', 'Entry 12', 'Test OmniCharge and reply on Tue 1 Sep', 'Finding the Balance'],
    'both words, both starting a word, first; both words inside words next; one word after; the body-only hit last');
  assert.deepEqual(plain(caret.bold()).slice(1), ['Try1', 'try1', '1', ''], 'the typed words are bold, nothing else');
  caret.type('');
  assert.deepEqual(plain(caret.state()), { palIndex: 0, rows: ['Recent'] }, 'an empty caret palette lists recent nodes with no Create row');
  caret.type('Dan'); caret.resolve([{ id: 'x', title: 'Dana Brooks' }]); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(plain(caret.state()), { palIndex: 1, rows: ['Create “Dan”', 'Dana Brooks'] }, 'typing offers to create what was typed and still selects the matching result');
  assert.equal(caret.create(), 'Dan', 'and Create uses the typed title');
  assert.deepEqual(plain(context.state().actions), ['link', 'create'], 'Enter links the selected result and Cmd+Enter explicitly creates');
  // Enter pressed while the search is still out (the first Enter right after "@") is not dropped: the choice is
  // made the moment the rows land, with the result that matches, or Create when nothing does
  context.again();
  assert.equal(context.state().busy, true, 'a fresh search is busy until it answers');
  context.press(event(false));
  assert.deepEqual(plain(context.state().actions), [], 'Enter during the search runs nothing yet');
  context.resolveSearch([{ id: 'tana:user-profile:roni', title: 'Dana Brooks' }]);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(plain(context.state().actions), ['link'], 'and links the matching result when the rows arrive');
  context.again(); context.press(event(true)); context.resolveSearch([]); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(plain(context.state().actions), ['create'], 'Cmd+Enter during the search creates when the rows arrive');
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
    const views = [], searches = [];
    const pinTree = [];
    const pinRows = () => [], selectionRows = () => [];
    const pillCommandRows = () => [];
    const taskActionRows = () => [];
    const tana = { refresh: async () => {}, login: async () => {} };
    const run = () => {};
    const pinInfo = null, palDoc = null, hotkeys = {}, theme = 'light';
    const localDate = () => '2026-09-13';
    const zoom = null, railEl = { hidden: true }, navBack = [], navForward = [];
    const railToggle = { hidden: false }, railHidden = false; // the sidebar toggle row: available, so paletteRows builds it
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

async function runSyncShortcutCheck() {
  // Matching: a tiered match with the matched positions for the bold letters; "moinb" and "mti" reach "Move to Inbox",
  // "in" reaches Inbox before "Zoom in", but "xove" reaches nothing.
  const match = vm.runInNewContext(`${functionSource('fuzzyMatch')}; ({ m: (l, q) => fuzzyMatch(l, q) });`);
  const marked = (label, q) => { const m = match.m(label, q); return m && [...label].map((c, i) => (m.includes(i) ? c.toUpperCase() : c.toLowerCase())).join(''); };
  assert.equal(marked('Move to Inbox', 'moinb'), 'MOve to INBox', 'word-prefix chunks in order');
  assert.equal(marked('Move to Inbox', 'mti'), 'Move To Inbox', 'the first letters of the words');
  assert.equal(marked('Move to Inbox', 'inbox'), 'move to INBOX', 'a word the query starts wins as it is');
  assert.deepEqual([['Inbox', 'in'], ['Move to Inbox', 'mti'], ['Zoom in', 'in'], ['Move to Inbox', 'moinb'], ['Pin to sidebar', 'in']].map(([l, q]) => match.m(l, q).rank), [0, 1, 2, 3, 4],
    'tiers: a prefix, the first words\' initials, a later word, chunks that skip words, inside a word');
  assert.equal(marked('Set status In Progress', 'sspr'), 'Set Status in PRogress', 'a chunk may skip words');
  assert.equal(marked('Set status In Progress', 'ssp'), 'Set Status in Progress', 'and the shortest chunk that still leads on is taken');
  assert.equal(match.m('Move to Inbox', 'xove'), null, 'a letter that starts no word and no substring is out');
  assert.equal(marked('Inbox', 'inbx'), 'INBoX', 'letters in order, with one left out, still reach the word');
  assert.equal(match.m('Inbox', 'inbx').rank, 5, 'and rank below every other kind of match');
  assert.equal(match.m('Sensitive', 'ntv'), null, 'but the first letter has to start a word');
  assert.deepEqual(plain(match.m('Anything', '')), [], 'no query: everything, nothing bold');
  // The second level of a row is folded into the first once the first two letters reach it (a prefix or the initials):
  // its rows appear as "<subBase> <choice>" right after the row, loaded once, and the same query then filters them.
  const folded = vm.runInNewContext(`
    const views = [], searches = [], pinTree = [], pinRows = () => [], pillCommandRows = () => [], taskActionRows = () => [];
    let loads = 0;
    const selectionRows = () => [{ id: 'status', group: 'Current node', label: 'Set status', subBase: 'Set status to', keepOpen: true, run: () => {}, sub: () => { loads++; return [{ label: 'Inbox', run: () => {} }, { label: 'In Progress', run: () => {} }, { label: 'Later', disabled: true, run: () => {} }]; } }];
    const tana = { refresh: async () => {} }, run = () => {};
    const authed = true, authChecking = false, signedOut = false, theme = 'light', hotkeys = {}, themePref = 'light', pinInfo = null, palDoc = null;
    const localDate = () => '2026-09-13', setTheme = () => {}, docRow = () => ({}), sectionOf = () => null;
    const zoom = null, railEl = { hidden: true }, navBack = [], navForward = [], sensitiveVisible = false;
    const railToggle = { hidden: false }, railHidden = false; // the sidebar toggle row: available, so paletteRows builds it
    const showError = () => {}, palette = { hidden: false }, palMode = 'cmd', renderPalette = () => {};
    const setZoom = () => {}, navigate = () => {}, history = () => {}, togglePalette = () => {}, focusRail = () => {}, setView = () => {}, openDoc = () => {}, filterEl = {}, render = () => {}, zoomFactor = 1, BASE_ZOOM = 1;
    const visibilityRows = () => [], moveTargets = async () => [], previewMoveToSpace = () => {};
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${functionSource('paletteRows')}
    ({ rows: async (q) => { paletteRows(q); await Promise.resolve(); await Promise.resolve(); return paletteRows(q).map((r) => r.label); }, loads: () => loads });
  `);
  assert.deepEqual(plain(await folded.rows('s')), ['Set status', 'Search Tana', 'Sync', 'Smaller text', 'Hide sidebar', 'Reset text size', 'Filter rows by text'],
    'one letter: the first level only, the groups whose best row starts with it first, a letter inside a word last');
  assert.deepEqual(plain(await folded.rows('sesp')), ['Set status to In Progress'], 'two letters in: the level below is folded in and the query reaches into it');
  assert.deepEqual(plain(await folded.rows('seinb')), ['Set status to Inbox'], 'a disabled choice is left out, the others are single rows');
  assert.deepEqual(plain(await folded.rows('ssin')), ['Set status to Inbox', 'Set status to In Progress'], 'the initials of the row open its level too');
  assert.equal(folded.loads(), 1, 'the level is loaded once per palette');

  // Expanding a row loads its children while the caret is still in that row: the render that shows them must be the
  // forced kind (a plain one waits for the caret to leave, and "Loading…" stays). A failed load closes the row and
  // forgets the attempt so the next expand retries.
  const loads = vm.runInNewContext(`
    const kids = new Map(), open = new Map(), renders = [], errors = [];
    let fail = false;
    const render = (force) => renders.push(force === true);
    const showError = (e) => errors.push(e.message);
    const reload = (id) => (fail ? Promise.reject(new Error('bootstrap timeout')) : Promise.resolve().then(() => { kids.set(id, [{ id: 'b' }]); }));
    ${functionSource('ensureLoaded')}
    const item = { key: 'tana:text:01j0doc000000000000000000', docId: 'tana:text:01j0doc000000000000000000', node: { kind: 'document' } };
    ({ expand: async (f) => { fail = f; renders.length = 0; errors.length = 0; ensureLoaded(item); const pending = kids.get(item.docId) === null; await Promise.resolve(); await Promise.resolve(); return { pending, renders: [...renders], errors: [...errors], kids: kids.has(item.docId) ? kids.get(item.docId) : 'gone', open: open.get(item.key) }; } });
  `);
  const bad = await loads.expand(true);
  assert.deepEqual(plain(bad), { pending: true, renders: [true], errors: ['bootstrap timeout'], kids: 'gone', open: false }, 'a failed load closes the row, forgets the attempt and says why');
  const good = await loads.expand(false);
  assert.deepEqual(plain(good), { pending: true, renders: [true], errors: [], kids: [{ id: 'b' }], open: false }, 'the rows that arrive are rendered at once, caret or no caret');

  // The palette's order is one list: node rows from the selection and from the document itself sorted into one
  // sequence (open, task state, where it lives, what it looks like, link, delete last), then Views, view options,
  // and Actions from "get in" to the app's own settings.
  const order = vm.runInNewContext(`
    const views = [{ id: 'library', title: 'Library', icon: 'library', nodes: [] }, { id: 'inbox', title: 'Inbox', icon: 'inbox', nodes: [] }], searches = [], pinTree = [], pinRows = () => [];
    const selectionRows = () => [{ id: 'delete', group: 'Current node', label: 'Delete' }, { id: 'sensitive', group: 'Current node', label: 'Mark as sensitive' }, { id: 'zoomIn', group: 'Current node', label: 'Zoom in' }, { id: 'status', group: 'Current node', label: 'Set status' }];
    const pillCommandRows = () => [{ id: 'pill:type', group: 'View options', label: 'Filter by type' }], taskActionRows = () => [];
    const tana = { refresh: async () => {}, todayNode: async () => {}, weekNode: async () => {}, nodeLink: async () => {}, accessOptions: async () => {}, filters: {}, sensitiveIds: () => {}, creationOptions: async () => {} }, run = () => {};
    const authed = true, authChecking = false, signedOut = true, theme = 'light', hotkeys = {}, themePref = 'light';
    const palDoc = { id: 'tana:text:01j0doc000000000000000000' }, pinInfo = { docId: palDoc.id, sidebar: false, dates: [] };
    const accessById = new Map([[palDoc.id, { sharing: true, move: true, ownerUri: 'tana:space:01j0space00000000000000000' }]]), loadAccess = () => {}, isRealId = () => true;
    const localDate = () => '2026-09-13', setTheme = () => {}, docRow = () => ({}), sectionOf = () => null;
    const palette = { hidden: false }, palMode = 'cmd', renderPalette = () => {}, showError = () => {};
    const zoom = null, railEl = { hidden: false }, navBack = [], navForward = [], sensitiveVisible = false;
    const railToggle = { hidden: false }, railHidden = false; // sidebar visible here, so both the focus row and the toggle row are built
    const openCreationPalette = () => {}, openHiddenPalette = () => {}, toggleSensitiveVisibility = () => {}, followSystem = () => {}, openVisibilityPalette = () => {}, openMovePalette = () => {}, pinAction = () => {}, copyText = () => {}, togglePalette = () => {}, navigate = () => {}, history = () => {}, focusRail = () => {}, setZoom = () => {}, goTo = () => {}, setView = () => {}, openDoc = () => {}, filterEl = {}, render = () => {}, zoomFactor = 1, BASE_ZOOM = 1;
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    const visibilityRows = () => [], moveTargets = async () => [], previewMoveToSpace = () => {};
    ${functionSource('paletteRows')}
    ({ labels: (q) => paletteRows(q).map((row) => row.group + ': ' + row.label) });
  `);
  assert.deepEqual(plain(order.labels('')), [
    'Current node: Zoom in', 'Current node: Set status', 'Current node: Pin to today', 'Current node: Move to …', 'Current node: Move to Library',
    'Current node: Edit visibility', 'Current node: Mark as sensitive', 'Current node: Copy link', 'Current node: Delete',
    'Views: Inbox', 'Views: Today', 'Views: This week', 'Views: Library',
    'View options: Filter by type', 'View options: Filter rows by text',
    'Actions: Log in to Tana', 'Actions: Create new…', 'Actions: Search Tana', 'Actions: Go back', 'Actions: Go forward', 'Actions: Focus the sidebar', 'Actions: Hide sidebar',
    'Actions: Undo', 'Actions: Redo', 'Actions: Sync', 'Actions: Reload', 'Actions: Edit hidden items', 'Actions: Toggle sensitive visibility',
    'Actions: Larger text', 'Actions: Smaller text', 'Actions: Reset text size', 'Actions: Toggle dark mode',
  ], 'the palette lists its rows in one fixed, meaningful order');
  // With a query the best match leads, whichever group it is in: Inbox starts with "in", Zoom in only has it as a word.
  const inRows = plain(order.labels('in'));
  assert.equal(inRows[0], 'Views: Inbox', 'a label that starts with the query comes first');
  assert.ok(inRows.indexOf('Current node: Zoom in') > 0, 'and a later word after it');
  assert.equal(plain(order.labels('mtl'))[0], 'Current node: Move to Library', 'the first letters of the words reach the row');

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
    ${withShims(source.slice(start, end))}
  `, context);
  let prevented = false;
  context.handler({ key: 'r', metaKey: true, ctrlKey: false, shiftKey: false, defaultPrevented: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'Cmd+R remains available to the host instead of invoking Sync');

  // A row that is only a mention chip shows no caret and Chromium will not delete the chip, so the row is marked
  // .chiponly (its focus is drawn around the chip) and Backspace or Delete removes the row, like an image.
  const chip = vm.runInNewContext(`${sourceBetween('const chipOnly', 'function focused')}; ({ chipOnly })`);
  const mention = { nodeType: 1, classList: { contains: (c) => c === 'mention' } }, words = { nodeType: 3 };
  assert.equal(chip.chipOnly({ childNodes: [mention], firstChild: mention }), true, 'one chip and nothing else is a chip-only row');
  assert.equal(chip.chipOnly({ childNodes: [mention, words], firstChild: mention }), false, 'text typed beside it makes it an ordinary row again');
  assert.equal(chip.chipOnly({ childNodes: [words], firstChild: words }), false, 'plain text is not');
  assert.match(source, /\(e\.key === 'Backspace' \|\| e\.key === 'Delete'\) && chipOnly\(el\)\) \{ e\.preventDefault\(\); return removeNode\(item, el\); \}/, 'Backspace on a chip-only row removes it');
  assert.match(source, /text\.classList\.toggle\('chiponly', chipOnly\(text\)\)/, 'a rendered row knows it is chip-only');
  assert.match(source, /el\.classList\.toggle\('chiponly', chipOnly\(el\)\)/, 'and typing beside the chip updates that');

  // Dimming the row a deferred render would drop looks at the top-level row: a caret in a block under an expanded task
  // is not a row leaving the view (every new block, and the block the caret fell back to after a delete, used to dim).
  const falling = vm.runInNewContext(`
    const outline = {};
    const rowOf = (key, parentRow) => { const classes = new Set(); return { dataset: { key }, classes, parentElement: parentRow ? { closest: () => parentRow } : outline, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } }; };
    const task = rowOf('tana:text:task'), block = rowOf('tana:text:task/b1', task), rows = { [task.dataset.key]: task, [block.dataset.key]: block };
    let zoom = null, caret = null, inView = true;
    const focused = () => (caret ? { key: caret, offset: 0 } : null), nodeElOf = (key) => rows[key];
    const viewOf = () => ({ nodes: inView ? [{ id: 'tana:text:task', kind: 'document' }] : [] });
    const keyFor = (docId, node) => (node.kind === 'document' ? docId : docId + '/' + node.id);
    ${functionSource('markFalling')}
    ({ mark: (key, stays) => { caret = key; inView = stays; task.classes.clear(); block.classes.clear(); markFalling(); return { task: task.classes.has('falling'), block: block.classes.has('falling') }; } });
  `);
  assert.deepEqual(plain(falling.mark('tana:text:task/b1', true)), { task: false, block: false }, 'typing in a block under a task that stays in the view dims nothing');
  assert.deepEqual(plain(falling.mark('tana:text:task', false)), { task: true, block: false }, 'a task row that left the view dims while you are still in it');
  assert.deepEqual(plain(falling.mark('tana:text:task/b1', false)), { task: true, block: false }, 'and a block under a task that left dims that task row, the one that will go');

  const paletteRows = functionSource('paletteRows');
  const rows = vm.runInNewContext(`
    const views = [], searches = [], pinTree = [], pinRows = () => [], selectionRows = () => [];
    const pillCommandRows = () => [];
    const taskActionRows = () => [];
    const tana = { refresh: async () => {} }, run = () => {};
    const authed = true, authChecking = false, signedOut = false, pinInfo = null, palDoc = null, hotkeys = {}, theme = 'light';
    const localDate = () => '2026-09-13', setTheme = () => {};
    const docRow = () => ({}), sectionOf = () => null;
    const zoom = null, railEl = { hidden: true }, navBack = [], navForward = [];
    const railToggle = { hidden: false }, railHidden = false; // the sidebar toggle row: available, so paletteRows builds it
    ${paletteRows}
    paletteRows('');
  `);
  assert.equal(rows.find((row) => row.id === 'sync').kbd, undefined, 'Sync command has no Cmd+R shortcut label');
}

// The recorder warns before saving a combo the outline already answers to, or one another row already has, since
// the built-in is checked first and the hotkey would never fire.
async function runReservedComboCheck() {
  // A link mark to a node is a reference: a new id opens directly, an old outliner id is found through the
  // "Outliner ID" line the importer leaves behind, and an unknown one goes to the old Tana in the browser.
  const link = vm.runInNewContext(`
    const calls = [];
    const goTo = (id) => calls.push(['goTo', id]), showNote = (n) => calls.push(['note', n]);
    const tana = { search: async (q) => (q === 'old12chars00' ? [{ id: 'tana:text:01j0found0000000000000000' }] : q === 'two12chars00' ? [{}, {}] : []), openExternal: async (u) => calls.push(['open', u]) };
    ${functionSource('goToLink')}
    ({ go: async (href) => { calls.length = 0; await goToLink(href); return calls; } });
  `);
  assert.deepEqual(plain(await link.go('tana:text:01j0abcdefghijklmnopqrstuv')), [['goTo', 'tana:text:01j0abcdefghijklmnopqrstuv']], 'a new node id opens directly');
  assert.deepEqual(plain(await link.go('tana:old12chars00')), [['goTo', 'tana:text:01j0found0000000000000000']], 'an old id opens the imported node that carries it');
  assert.deepEqual(plain(await link.go('tana:gone12chars0')), [['open', 'https://app.tana.inc?nodeid=gone12chars0']], 'and one nothing carries goes to the old Tana');
  assert.deepEqual(plain(await link.go('tana:two12chars00'))[0][0], 'note', 'an ambiguous one says so instead of guessing');

  // Built-in keys are palette rows with a default combo: the global handler dispatches the default, a recorded
  // combo replaces it (Reset deletes the entry and the default is back), and a key the focused node already
  // answered to arrives defaultPrevented and is not run a second time.
  const anchor = source.indexOf("filterEl.addEventListener('keydown'");
  const start = source.indexOf("document.addEventListener('keydown', (e) => {", anchor);
  const end = source.indexOf('// ---- palette:', start);
  const dispatch = vm.runInNewContext(`
    let handler;
    const ran = [];
    const document = { activeElement: {}, addEventListener: (_name, listener) => { handler = listener; } };
    const filterEl = {}, dropDoc = null, palette = { hidden: true }, tana = {}, sel = null, zoom = null;
    const hotkeys = {};
    const setZoom = () => {}, togglePalette = () => {};
    const runAction = (id) => { ran.push(id); return id !== 'gone'; };
    ${sourceBetween('const DEFAULT_HOTKEYS', 'let pinInfo')}
    ${sourceBetween('const KEYNAMES', 'const validCombo')}
    ${withShims(source.slice(start, end))}
    ({ press: (key, mods = {}) => { const e = { key, code: '', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...mods }; handler(e); return e.defaultPrevented; },
       record: (id, combo) => { hotkeys[id] = combo; }, reset: (id) => { delete hotkeys[id]; }, ran: () => ran.splice(0), chip: (id) => hotkeyFor(id) });
  `);
  assert.equal(dispatch.press('['), true, 'the default combo is handled');
  assert.deepEqual(plain(dispatch.ran()), ['back'], 'and runs its row');
  dispatch.record('back', '⇧⌘B');
  assert.equal(dispatch.chip('back'), '⇧⌘B', 'a recorded combo is what the palette shows');
  dispatch.press('['); dispatch.press('B', { shiftKey: true });
  assert.deepEqual(plain(dispatch.ran()), ['back'], 'and is what fires, the default no longer does');
  dispatch.reset('back');
  dispatch.press('[');
  assert.deepEqual([dispatch.chip('back'), plain(dispatch.ran())], ['⌘[', ['back']], 'Reset restores the default');
  assert.equal(dispatch.press('[', { defaultPrevented: true }), true, 'a key the node handled stays prevented');
  assert.deepEqual(plain(dispatch.ran()), [], 'but is not run again here');
  dispatch.record('gone', '⌘G');
  assert.equal(dispatch.press('G'), false, 'a row that is not there right now leaves the key alone');

  const api = vm.runInNewContext(`
    const hotkeys = { 'view:tasks': '⇧⌘T', 'doc:tana:text:abc': '⌃⌥N' };
    const views = [{ nodes: [{ id: 'tana:text:abc', text: 'Principles' }] }];
    const paletteRows = () => [{ id: 'view:tasks', label: 'Tasks' }, { id: 'addToday', label: 'Add 2 items to Today' }, { id: 'undo', label: 'Undo' }, { id: 'back', label: 'Go back' }];
    ${sourceBetween('const RESERVED', 'function comboTaken')}
    ${functionSource('comboTaken')}
    ({ taken: (combo, rowId) => comboTaken(combo, rowId) });
  `);
  assert.match(api.taken('⌘Z', 'addToday'), /already the shortcut for "Undo"/, 'a built-in key is taken by its row through its default combo');
  assert.match(api.taken('⌘[', 'addToday'), /"Go back"/, 'the history keys the same way');
  assert.match(api.taken('⇧⌘⌫', 'addToday'), /deletes the node/, 'what the handlers keep fixed is still reserved');
  assert.equal(api.taken('⇧⌘Y', 'addToday'), '', 'and ⇧⌘Y, no longer a redo alias, is free');
  assert.match(api.taken('⌃⌥K', 'addToday'), /command palette/, '⌃ counts as ⌘ and ⌥ is ignored, as the handler does');
  assert.match(api.taken('⇧⌘T', 'addToday'), /already the shortcut for "Tasks"/, 'a combo another row has names that row');
  assert.match(api.taken('⌃⌥N', 'addToday'), /"Principles"/, 'and a document binding names the document');
  assert.equal(api.taken('⇧⌘T', 'view:tasks'), '', 'a row may keep its own combo');
  assert.equal(api.taken('⇧⌘U', 'addToday'), '', 'and a free combo passes');
}
// Cmd+[ and Cmd+] walk the places rendered so far: view switches and zooms, recorded by the render itself, so every
// way of navigating counts; going back then somewhere new drops the forward places, like a browser.
function runHistoryCheck() {
  const api = vm.runInNewContext(`
    let view = 'tasks', zoom = null, caretOnOpen = false, rendered = 0;
    const localStorage = { setItem() {}, removeItem() {} };
    ${sourceBetween('const isRealId =', '\n')}
    const flushAll = () => {}, dropDrafts = () => {};
    const render = () => { rendered++; noteNavigation(); }; // what renderOutline does at its end
    ${sourceBetween('const navBack = [], navForward = [];', 'function noteNavigation')}
    ${functionSource('noteNavigation')}
    ${functionSource('navigate')}
    ({
      go: (v, z) => { view = v; zoom = z; render(); },
      hop: (v, z) => { navReplace = true; view = v; zoom = z; render(); }, // a meeting forwarding to its write-up
      back: () => navigate(-1), forward: () => navigate(1),
      where: () => [view, zoom && zoom.docId, navBack.length, navForward.length],
    });
  `);
  api.go('tasks', null); api.go('library', null); api.go('library', { docId: 'tana:text:a' }); api.go('library', { docId: 'tana:text:a' }); // a re-render of the same place is not a step
  assert.deepEqual(plain(api.where()), ['library', 'tana:text:a', 2, 0], 'three places seen, two behind');
  api.back();
  assert.deepEqual(plain(api.where()), ['library', null, 1, 1], 'back leaves the zoom');
  api.back();
  assert.deepEqual(plain(api.where()), ['tasks', null, 0, 2], 'back again returns to the first view');
  api.back();
  assert.deepEqual(plain(api.where()), ['tasks', null, 0, 2], 'and nothing further back is a no-op');
  api.forward();
  assert.deepEqual(plain(api.where()), ['library', null, 1, 1], 'forward retraces');
  api.go('inbox', null);
  assert.deepEqual(plain(api.where()), ['inbox', null, 2, 0], 'a new place after going back drops what was ahead');
  api.go('inbox', { docId: 'tana:event:m' }); api.hop('inbox', { docId: 'tana:text:writeup' });
  assert.deepEqual(plain(api.where()), ['inbox', 'tana:text:writeup', 3, 0], 'a forwarded meeting is one place, not two');
  api.back();
  assert.deepEqual(plain(api.where()), ['inbox', null, 2, 1], 'so back skips the empty event page');
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
    ${withShims(source.slice(start, end))}
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
    ${withShims(source.slice(start, end))}
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
      let palMode = 'assignees', palDoc = doc, palTaskCtx = null, sel = null, selectionFrozen = false, renderDeferred = false;
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
    const blurSensitive = () => {};
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
    { mention: { label: 'Sam', uri: 'tana:user-profile:sam' } },
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
  const withMention = [{ text: 'see ' }, { mention: { label: 'Sam', uri: 'u' } }, { text: ' now' }];
  assert.deepEqual(plain(api.markRange(withMention, 0, 11, 'bold', true)),
    [{ text: 'see ', marks: { bold: true } }, { mention: { label: 'Sam', uri: 'u' } }, { text: ' now', marks: { bold: true } }],
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
  // The pills now serve two kinds of page, so pillDefs asks which one it is on. These harnesses are all about views,
// so they answer "a view" — the saved search side gets its own check rather than a share of theirs.
const definitions = 'const onSearchPage = () => false, pillKey = () => view, setSearchF = () => {}, displayPref = {};\n' + sourceBetween('const STATES =', 'function renderPills');
  const api = vm.runInNewContext(`
    let view = 'library';
    const filters = new Map([['library', { types: ['tasks'], states: ['open'], assignee: 'me' }]]);
    const views = [{ id: 'library' }];
    let members = [{ id: 'me', title: 'Robin', me: true }, { id: 'sam', title: 'Sam' }];
    let menu = null;
    const tana = {};
    const $ = () => ({ hidden: false });
    const renderPills = () => {};
    const showError = () => {};
    const setViewF = (patch) => filters.set(view, { ...filters.get(view), ...patch });
    const groupPref = {}, sortPref = {}, render = () => {}, localStorage = { setItem() {} };
    ${definitions}
    ${functionSource('pickMenuRow')}
    ({ pick: (id, label) => {
        menu = { id, index: 0 };
        const rows = pillDefs().find((d) => d.id === id).rows().filter((r) => r.label);
        pickMenuRow(rows.find((r) => r.label === label), rows);
        return { open: !!menu, filter: filters.get(view) };
      },
      reset: () => filters.set('library', { types: ['tasks'], states: ['open'], assignee: 'me' }) });
  `);
  const anyType = api.pick('type', 'Any type');
  assert.deepEqual(plain(anyType), { open: false, filter: { types: null, states: ['open'], assignee: 'me' } },
    '"Any type" is a single choice: it applies and closes');
  api.reset();
  assert.equal(api.pick('type', 'Meetings').open, true, 'a tickable type keeps the multi-select menu open');
  api.reset();
  assert.equal(api.pick('status', 'Completed').open, true, 'a tickable status keeps the multi-select menu open');
  api.reset();
  assert.equal(api.pick('status', 'Any status').open, false, '"Any status" ends the selection and closes');
  api.reset();
  const assigned = api.pick('assigned', 'Sam');
  assert.equal(assigned.open, false, 'choosing an assignee closes the menu');
  assert.equal(assigned.filter.assignee, 'sam', 'and still applies the choice');
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
  const rows = api.rows({ id: 'doc' }, { assignees: 'Sam Okafor', audience: { icon: 'lock', label: 'Visible only to you' } });
  assert.deepEqual(plain(rows.map((row) => [row.id, row.icon, row.label, typeof row.run])), [
    ['assignees', 'member', 'Assigned to Sam Okafor', 'function'],
    ['visibility', 'lock', 'Visible only to you', 'function'],
    ['showInTana', 'tana', 'Show in Tana', 'function'],
  ], 'assignees and visibility read as plain rows and both can be opened');
  rows[0].run(); rows[1].run();
  assert.deepEqual(plain(api.calls()), [['assignees', 'doc'], ['visibility', 'doc']], 'the rows open the pickers the palette already uses');
  api.rows({ id: 'writeup' }, { audience: { icon: 'userLock', label: 'Visible to selected people' }, scope: 'people' }, { id: 'event' })[0].run();
  assert.deepEqual(plain(api.calls().at(-1)), ['visibility', 'event'], 'a followed meeting write-up checks visibility on its event hub');
  assert.deepEqual(plain(api.rows({ id: 'doc' }, { assignees: 'Unassigned', audience: null, unknownAudience: true }).map((row) => row.label)),
    ['Unassigned', 'Show in Tana'], 'an audience that cannot be verified is left out instead of rendering an empty row');
  assert.deepEqual(plain(api.rows({ id: 'doc', editable: false }, { assignees: 'Sam', audience: { icon: 'lock', label: 'Visible only to you' } }).map((row) => row.run === null)),
    [true, false, false], 'read-only body editing does not disable sharing or the Tana link');
  // link sharing is its own fact: a public document says so, even when it is not a task and has no assignee
  assert.deepEqual(plain(api.rows({ id: 'doc' }, { assignees: 'Sam', audience: { icon: 'lock', label: 'Visible only to you' }, linkShared: true }).map((row) => [row.id, row.icon])),
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
  const call = api.call({ call: { url: 'https://meet.google.com/klm-nopq-rst', label: 'meet.google.com/klm-nopq-rst' } });
  assert.deepEqual(plain([call.id, call.icon, call.label]), ['call', 'video', 'meet.google.com/klm-nopq-rst'], 'the call row shows the readable link with the video icon');
  call.run();
  assert.deepEqual(plain(api.calls().at(-1)), ['open', 'https://meet.google.com/klm-nopq-rst'], 'it joins through api.openExternal');
  assert.ok(/video/.test(fs.readFileSync(require.resolve('../icons.js'), 'utf8')), 'icons.js carries the video icon the call row asks for');
  assert.ok(/tana/.test(fs.readFileSync(require.resolve('../icons.js'), 'utf8')), 'icons.js carries the Tana icon the link row asks for');

  // "Visible to selected people" opens the people list only after permission is known; attendees must see the reason.
  const people = { assignees: 'Sam', scope: 'people', audience: { icon: 'userLock', label: 'Visible to selected people' } };
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
  visibility({ id: 'doc' }, { assignees: 'Sam', scope: 'only-me', audience: { icon: 'lock', label: 'Visible only to you' } }).run();
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
  assert.equal(action.className, 'rrow rmeta', 'the pin action uses the same quiet treatment as Details rows');
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
  assert.match(styles, /\.rail \.rrow \.chip-label \{ display: none; \}/, 'a collapsed sidebar chip cannot reveal any of its label');
  assert.match(styles, /\.rail \.rrow:hover \.chip-label, \.rail \.rrow:focus \.chip-label \{ display: inline; \}/, 'hover and keyboard focus reveal the full sidebar tag again');
}

// "Clear filters" belongs on an empty view only when a filter is the reason it is empty.
function runClearFiltersCheck() {
  const api = vm.runInNewContext(`
    let view = 'tasks';
    const filters = new Map([
      ['tasks', { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '' }],
      // no view ships a calendar scope any more, but a filter can still carry one — a saved search aimed at meetings
      // does — and clearFilter has to preserve it, so the case keeps its coverage under a name that is not a page
      ['scoped', { types: ['meetings'], states: null, assignee: 'anyone', text: '', participant: 'me', window: 'recent' }],
      ['library', { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '' }],
    ]);
    const render = () => {}, loadView = async () => {}, run = (fn) => fn();
    const tana = { setViewFilter: async (_id, filter) => filter };
    ${functionSource('setViewF')}
    ${sourceBetween('const clearFilter =', 'function ensureLoaded')}
    ({ set: (next, patch) => { view = next; if (patch) filters.set(view, { ...filters.get(view), ...patch }); },
       filtered: () => viewFiltered(), clear: () => clearFilters(), state: () => filters.get(view) });
  `);
  api.set('tasks');
  assert.equal(api.filtered(), true, 'the task preset differs from the unfiltered view');
  api.set('tasks', { states: ['open', 'proposed'] });
  assert.equal(api.filtered(), true, 'array order does not change whether the task preset is filtered');
  api.set('tasks', { states: ['closed'], assignee: 'anyone' });
  assert.equal(api.filtered(), true, 'a changed status or assignee offers the action');
  api.clear();
  assert.deepEqual(plain(api.state()), { types: null, states: null, assignee: 'anyone', text: '', participant: null, window: null }, 'clearing Tasks means an unrestricted query');
  assert.equal(api.filtered(), false, 'and the action goes away again');
  api.set('library');
  assert.equal(api.filtered(), true, 'the shipped library filter still narrows the view');
  api.set('library', { text: 'memo' });
  assert.equal(api.filtered(), true, 'a search text narrows the Library view');
  api.clear();
  assert.deepEqual(plain(api.state()), { types: null, states: null, assignee: 'anyone', text: '', participant: null, window: null }, 'clearing the Library means anything, not the shipped default');
  assert.equal(api.filtered(), false, 'and with everything set to any, the action goes away');
  api.set('scoped');
  api.clear();
  assert.deepEqual(plain(api.state()), { types: null, states: null, assignee: 'anyone', text: '', participant: 'me', window: 'recent' }, 'clearing a filter that carries a calendar scope keeps the participant and the window');
  assert.equal(api.filtered(), false, 'the preserved calendar scope is that filter\'s clear baseline');
}

async function runUnifiedViewsCheck() {
  const api = vm.runInNewContext(`
    const ids = ['inbox', 'library'];
    const views = ids.map((id) => ({ id, title: id, nodes: id === 'library' ? [{ id: 'draftdoc:1', draft: 'task' }] : [] }));
    const types = { inbox: null, library: ['tasks'] };
    const filters = new Map(ids.map((id) => [id, { types: types[id], states: null, assignee: 'anyone', text: '' }]));
    const viewSeq = new Map(), truncated = new Set(), fresh = new Map(), calls = [], pending = [];
    const tana = { viewList: (id, filter) => { calls.push([id, filter]); return new Promise((resolve) => pending.push(resolve)); } };
    const asDoc = (node) => ({ ...node, kind: 'document', text: node.text ?? node.title ?? '', hasChildren: true });
    const render = () => {}, showError = (error) => { throw error; };
    ${functionSource('loadView')}
    ({
      ids,
      start: (id) => loadView(id),
      resolve: (index, result) => pending[index](result),
      calls: () => calls,
      rows: (id) => views.find((item) => item.id === id).nodes,
      isTruncated: (id) => truncated.has(id),
    });
  `);

  const old = api.start('library'), latest = api.start('library');
  api.resolve(1, { nodes: [{ id: 'new', title: 'New', meta: 'Mon 9:00-10:00', editable: false }], truncated: true });
  await latest;
  api.resolve(0, { nodes: [{ id: 'old', title: 'Old' }], truncated: false });
  await old;
  assert.deepEqual(plain(api.rows('library').map((node) => [node.id, node.meta, node.editable])), [
    ['draftdoc:1', null, null], ['new', 'Mon 9:00-10:00', false],
  ], 'the newest shared response wins while a local draft, meeting-style meta and read-only capability survive');
  assert.equal(api.isTruncated('library'), true, 'truncation belongs to the accepted response');

  const loads = api.ids.filter((id) => id !== 'library').map((id) => api.start(id));
  loads.forEach((_load, i) => api.resolve(i + 2, { nodes: [{ id: api.ids.filter((id) => id !== 'library')[i], title: 'row' }], truncated: false }));
  await Promise.all(loads);
  assert.deepEqual(plain(api.calls().slice(2).map(([id, filter]) => [id, filter.types && filter.types[0]])), [
    ['inbox', null],
  ], 'every view goes through the same viewList call');
  assert.doesNotMatch(source, /\b(taskF|libF|loadLibrary|loadChats|loadInbox)\b/, 'the renderer no longer carries a per-view filter or loader');
  // Tasks was the last view with a native draft kind. With it gone, Enter drafts a plain doc on every view — asserted
  // as the empty map rather than as the absence of the old one, so a half-restored version cannot pass.
  assert.match(source, /const DRAFT_KIND = \{\};/, 'no view drafts a task any more: Enter makes a doc everywhere');
  // The Meetings view is gone, and the today marker went with it: every page now opens at its top.
  // the call form, not the bare word: the note left where it was removed should not read as the thing still existing
  assert.doesNotMatch(source, /todayIndex\(/, 'the today marker was removed with the view that was its only caller');
}

// Sorting and grouping are view preferences over rows already loaded: the order and the headings come from fields the
// rows carry (title, done/stateType, assignees, tags), never from a new query.
function runSortGroupCheck() {
  // The pills now serve two kinds of page, so pillDefs asks which one it is on. These harnesses are all about views,
// so they answer "a view" — the saved search side gets its own check rather than a share of theirs.
const definitions = 'const onSearchPage = () => false, pillKey = () => view, setSearchF = () => {}, displayPref = {};\n' + sourceBetween('const STATES =', 'function renderPills');
  const api = vm.runInNewContext(`
    let view = 'tasks', groupPref = {}, sortPref = {};
    const filters = new Map([['tasks', { types: ['tasks'], states: ['open'], assignee: 'me' }]]);
    const views = [{ id: 'tasks', kind: true }, { id: 'library' }];
    let members = [{ id: 'me', title: 'Robin', me: true }, { id: 'sam', title: 'Sam' }];
    const taskMetaById = new Map([['t1', { assignees: ['sam'], watched: true }], ['t2', { assignees: ['me'] }], ['t4', { assignees: ['tana:user-profile:ghost'], watched: false }]]);
    const tana = {}, palette = { hidden: true };
    const $ = () => ({ hidden: true });
    const renderPills = () => {}, render = () => {}, showError = () => {}, setViewF = () => {};
    const localStorage = { setItem() {} };
    const isTask = (n) => n.icon === 'task';
    const visibleTags = (n) => { const tags = n.tags || []; return isTask(n) && tags.some((t) => t.label !== 'task') ? tags.filter((t) => t.label !== 'task') : tags; };
    ${definitions}
    ({ pillDefs, groupRows, groupsOf, sortRows, pageRows, SORTS, SORT_KEY, holdRow, releaseHeld, needsCleanup,
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
  assert.deepEqual(titles(rows, 'assignee'), [['Robin', ['t2']], ['Sam', ['t1']], ['tana:user-profile:ghost', ['t4']], ['Unassigned', ['t3', 'd1']]],
    'assignees sort by name, a member without a loaded name keeps its uri, the rest is Unassigned');
  assert.deepEqual(titles(rows, 'type'), [['doc', ['d1']], ['Project', ['t1']], ['task', ['t2', 't3', 't4']]],
    'type groups on the tag the row already shows as its chip');
  // The bell as a heading: watched first, everything else under one heading — including rows whose metadata has not
  // arrived, which is the same approximation grouping by assignee makes and the reason the fallback sits last.
  assert.deepEqual(titles(rows, 'notify'), [['Notifying', ['t1']], ['Not notifying', ['t2', 't3', 't4', 'd1']]],
    'Notifications groups the watched rows apart; an unwatched row and one still waiting on its answer read the same');
  assert.deepEqual(titles([{ id: 'x', tags: [] }], 'type'), [['No type', ['x']]], 'a row without tags groups under No type');
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const aged = [['u1', ago(10 * 60e3)], ['u2', ago(5 * 36e5)], ['u3', ago(3 * 864e5)], ['u4', ago(20 * 864e5)], ['u5', ago(90 * 864e5)], ['u6', undefined], ['u7', ago(20 * 60e3)]]
    .map(([id, updatedAt]) => ({ id, updatedAt, tags: [] }));
  assert.deepEqual(titles(aged, 'updated'), [['Last hour', ['u1', 'u7']], ['Last day', ['u2']], ['Last week', ['u3']], ['Last month', ['u4']], ['Older', ['u5', 'u6']]],
    'Updated groups run newest first; past a month, or without a time, a row is Older');
  assert.deepEqual(titles([{ id: 'x', icon: 'task', done: 1, stateType: 'proposed', tags: [] }], 'status'), [['Inbox', ['x']]],
    'the row state wins over the done flag, so an Inbox task never reads as Completed');
  // Stay put: a clicked Inbox task keeps its group and place until it is released. The grouping is set here rather
  // than inherited — Tasks used to default to Status, and these cases are about holding rows, not about which page
  // groups by what, so they say what they need instead of depending on a view's identity.
  api.set('tasks', 'status', 'default');
  const inboxTask = { id: 'h1', icon: 'task', done: 0, stateType: 'proposed', tags: [{ label: 'task' }] }, openTask = { id: 'h2', icon: 'task', done: 0, stateType: 'open', tags: [{ label: 'task' }] };
  const onScreen = (list) => plain(api.groupsOf(api.sortRows(list))).map((g) => [g.title, g.nodes.map((n) => n.id)]);
  assert.deepEqual(onScreen([inboxTask, openTask]), [['Inbox', ['h1']], ['In Progress', ['h2']]]);
  api.holdRow(inboxTask);
  assert.equal(api.needsCleanup([inboxTask, openTask]), false, 'a held row whose state has not moved yet needs no Clean up');
  inboxTask.stateType = 'open'; // what toggleDone does: hold first, then accept
  assert.equal(api.needsCleanup([openTask, inboxTask]), true, 'the kept row now sits where the view would not put it, so Clean up is offered');
  assert.deepEqual(onScreen([openTask, inboxTask]), [['Inbox', ['h1']], ['In Progress', ['h2']]], 'the clicked row keeps its group and every row its place, whatever order a refresh brings');
  api.releaseHeld();
  assert.deepEqual(onScreen([openTask, inboxTask]), [['In Progress', ['h2', 'h1']]], 'once the view is left, the row sits in its new group');
  assert.equal(api.needsCleanup([openTask, inboxTask]), false, 'and nothing is left to clean up');
  const order = (list) => plain(api.sortRows(list)).map((n) => n.id);
  api.set('tasks', 'none', 'title');
  assert.deepEqual(order(rows), ['t2', 't1', 't4', 't3', 'd1'], 'Title sorts the loaded rows by their own title, case-insensitively');
  api.set('tasks', 'none', 'updated');
  assert.deepEqual(order(rows), ['t3', 't1', 't4', 't2', 'd1'], 'Updated reads newest first, and a row without a time sorts last');
  api.set('tasks', 'none', 'created');
  assert.deepEqual(order(rows), ['t4', 't2', 't3', 't1', 'd1'], 'Created reads newest first too');
  api.set('tasks', 'none', 'default');
  assert.deepEqual(order(rows), ['t1', 't2', 't3', 't4', 'd1'], 'Default leaves the order the view produced alone');
  api.set('inbox', 'status', 'title');
  assert.deepEqual(order(rows), ['t2', 't1', 't4', 't3', 'd1'], 'sorting applies to every view');
  assert.equal(api.groupsOf(rows).length, 5, 'grouping applies to every view too');
  api.set('library', 'type', 'title');
  assert.equal(api.groupsOf(rows).length, 3, 'a grouped view sections its rows');
  assert.deepEqual(plain(api.prefs()), { group: 'type', sort: 'title' }, 'each view remembers its own choice');
  api.set('tasks', undefined, undefined);
  // Tasks was the one page with defaults of its own (Status / most recently updated). With it gone, every unset page
  // falls back the same way, saved searches included.
  assert.deepEqual(plain(api.prefs()), { group: 'none', sort: 'default' }, 'an unset page groups by nothing and keeps the order its query returned');
  api.set('library', undefined, undefined);
  assert.deepEqual(plain(api.prefs()), { group: 'none', sort: 'default' }, 'and any other unset view falls back to None / Default');
  api.set('library', undefined, 'updated');
  assert.equal(plain(api.prefs()).sort, 'updated', 'a page\'s own choice still wins over the fallback');
  // the guard that matters: an option may only sort on a field the row objects really carry
  for (const [id] of plain(api.SORTS).filter(([id]) => id !== 'default')) {
    const key = api.SORT_KEY[id];
    assert.ok(key, id + ' has a sort key');
    assert.notEqual(key(rows[0]), undefined, id + ' reads a field the rows carry');
  }
  // A saved search draws its rows through the same helper a view does, keyed by the search document rather than by a
  // view id. renderOutline itself needs a DOM to test, so this is the part that can be pinned: deleting the sort or
  // the grouping from the search branch leaves nothing else in the suite to notice.
  api.set('tana:search:s1', 'status', 'title');
  const shown = plain(api.pageRows(rows, ''));
  assert.deepEqual(shown.groups.map((g) => g.title), ['Inbox', 'In Progress', 'Completed', 'Later', 'No status'],
    'a saved search sections its results the way a view does, using the arrangement stored against its own id');
  assert.deepEqual(shown.list.map((n) => n.id), shown.groups.flatMap((g) => g.nodes.map((n) => n.id)),
    'and the flat list follows the sections on screen, so the keyboard order matches what is drawn');
  const narrowed = plain(api.pageRows(rows, 'alpha'));
  assert.deepEqual(narrowed.list.map((n) => n.id), ['t2'], '⌘F narrows the results before they are arranged');
  assert.equal(narrowed.hidden, rows.length - 1, 'and what it left out is counted for the line under the list');
  // Ungrouped, so the order coming back is the sort and nothing else. Grouped, it is not observable: groupRows emits
  // its sections in a fixed order whatever order it was handed, which is how dropping the sort survived a mutation.
  api.set('tana:search:s1', 'none', 'title');
  assert.deepEqual(plain(api.pageRows(rows, '')).list.map((n) => n.id), ['t2', 't1', 't4', 't3', 'd1'],
    'a saved search hands its rows back in the order its own stored sort asks for');
  api.set('tasks', 'status', 'title');
  const defs = api.pillDefs(), ids = defs.map((d) => d.id);
  assert.deepEqual(plain(ids.slice(-3)), ['sort', 'group', 'display'], 'the pills that arrange and describe the rows sit after the filters, in that order');
  const sort = defs.find((d) => d.id === 'sort'), group = defs.find((d) => d.id === 'group');
  assert.deepEqual(plain([sort.label, sort.value, group.label, group.value]), ['Sort', 'Title', 'Group', 'Status'], 'both pills read their active option');
  assert.deepEqual(plain(sort.rows().map((r) => r.label)), ['Default', 'Updated', 'Created', 'Title'], 'the Sort menu offers only orders backed by row data');
  assert.deepEqual(plain(group.rows().map((r) => r.label)), ['None', 'Status', 'Assignee', 'Notifications', 'Updated', 'Type'], 'the Group menu offers the six groupings');
  assert.ok(sort.rows().find((r) => r.label === 'Title').checked && group.rows().find((r) => r.label === 'Status').checked, 'the active option is ticked');
  assert.ok([...sort.rows(), ...group.rows()].every((r) => !r.keepOpen), 'choosing an option closes the popup, like every other single choice');
  assert.match(source, /const shown = pageRows\(docs, filterEl\.value\.trim\(\)\.toLowerCase\(\)\);/, 'a view draws its rows through pageRows, which sorts then groups them');
  assert.match(source, /groups\.flatMap\(\(g\) => \[groupHeadEl\(g\.title\)/, 'each group is introduced by a heading');
  assert.match(source, /const shown = pageRows\(list, filterEl\.value\.trim\(\)\.toLowerCase\(\)\);/, 'and so does a saved search: this is what carries its stored arrangement to the screen');
  assert.match(source, /label: 'Set status', subBase: 'Set status to'[^\n]*subAlways: true/, 'Set status folds its four statuses in for any query, like Move to …');
  assert.match(source, /label: `Set status for \$\{count\} \$\{noun\}`[^\n]*subAlways: true/, 'and so does Set status for a selection');
  // A reused row keeps whatever its checkbox shows: accepting an Inbox task changes only its state, so that must rebuild it
  const rowSig = vm.runInNewContext(`
    const taskMetaById = new Map(), taskMetaLoading = new Set(), open = new Map(), pending = new Map(), members = null;
    const sensitiveHidden = () => false;
    ${functionSource('rowSig')}
    // what a row shows is one of the things it is built from, so changing that must change the signature
    ({ sig: rowSig, display: (keys) => { globalThis.displayKeys = () => keys; } });
  `);
  const inboxRow = { id: 'r', text: 'Task', done: 0, icon: 'task', kind: 'document', stateType: 'proposed', tags: [] };
  assert.notEqual(rowSig.sig(inboxRow), rowSig.sig({ ...inboxRow, stateType: 'open' }), 'accepting an Inbox task rebuilds its row, so the box does not keep the tick the click put in it');
  // The Display pill changes every row at once while no row's own data changed, so without this the outline would
  // keep reusing rows and the choice would appear to do nothing until something else forced a rebuild.
  rowSig.display(['status', 'assigned', 'updated']);
  const beforeDisplay = rowSig.sig(inboxRow);
  rowSig.display(['status', 'assigned', 'updated', 'created']);
  assert.notEqual(rowSig.sig(inboxRow), beforeDisplay, 'changing what rows display rebuilds them, rather than leaving the old facts on screen');
  // The pills go with it: whether a row still belongs where it sits is decided while they render (needsCleanup), so a
  // render held back by the caret or a frozen selection would otherwise never be able to offer Clean up.
  assert.match(source, /renderDeferred = true; markFalling\(\); refreshRowChrome\(\); if \(!\$\('pills'\)\.hidden\) renderPills\(true\); return;/,
    'a render that waits for the caret still brings every checkbox up to date, and re-renders the pills so Clean up can appear');
  // A task's state also lives in copies (a reference in an open note, nested or not; a sidebar row): a change patches them
  const copies = vm.runInNewContext(`
    const ref = (id) => ({ id, type: 'reference', reference: { uri: 'tana:text:t1', node: { id: 'tana:text:t1', text: 'Task', title: 'Task', stateType: 'open', done: 0 } } });
    const kids = new Map([['note', [{ ...ref('b1'), children: [ref('b2')] }]], ['loading', null]]);
    const relatedBy = new Map([['hub', { pinned: [{ id: 'tana:text:t1', text: 'Task', stateType: 'open', done: 0 }], outcomes: [{ id: 'tana:text:t2', stateType: 'open', done: 0 }], notes: [] }], ['pending', null]]);
    ${functionSource('railGroups')}
    ${functionSource('patchCopies')}
    patchCopies('tana:text:t1', { stateType: 'proposed', done: 0, title: undefined });
    ({ note: kids.get('note'), related: relatedBy.get('hub') });
  `);
  assert.equal(copies.note[0].reference.node.stateType, 'proposed', 'a reference row in an open note gets the new state');
  assert.equal(copies.note[0].children[0].reference.node.stateType, 'proposed', 'a nested one too');
  assert.equal(copies.note[0].reference.node.title, 'Task', 'a value the change does not carry is left alone');
  assert.equal(copies.related.pinned[0].stateType, 'proposed', 'the sidebar row of the task gets it');
  assert.equal(copies.related.outcomes[0].stateType, 'open', 'and another task keeps its own');
}

function runCmdPillsCheck() {
  // The pills now serve two kinds of page, so pillDefs asks which one it is on. These harnesses are all about views,
// so they answer "a view" — the saved search side gets its own check rather than a share of theirs.
const definitions = 'const onSearchPage = () => false, pillKey = () => view, setSearchF = () => {}, displayPref = {};\n' + sourceBetween('const STATES =', 'function renderPills');
  const api = vm.runInNewContext(`
    let view = 'tasks';
    const filters = new Map([
      ['tasks', { types: ['tasks'], states: ['open'], assignee: 'anyone', text: '' }],
      ['inbox', { types: null, states: ['proposed'], assignee: 'anyone', text: '' }],
      ['library', { types: ['tasks'], states: ['open'], assignee: 'anyone', text: '' }],
    ]);
    // Tasks is the one kind page left: the type is its identity, not a filter (main sends the flag)
    const views = [{ id: 'inbox' }, { id: 'tasks', kind: true }, { id: 'library' }];
    let members = [{ id: 'me', title: 'Robin', me: true }], groupPref = {}, sortPref = {};
    let pillCtx = null, palMode = 'cmd', palRows = [], palIndex = 0, renders = 0;
    const taskMetaById = new Map(), tana = {}, palette = { hidden: false };
    const $ = () => ({ hidden: false }), showError = () => {}, renderPills = () => {};
    const localStorage = { setItem() {} }, render = () => { renders++; };
    const setViewF = (patch) => { filters.set(view, { ...filters.get(view), ...patch }); render(); };
    const palInput = { value: '', placeholder: '', focus() {} };
    const renderPalette = () => { renders++; };
    ${definitions}
    ${functionSource('pillRows')}
    ${functionSource('pillRowsFor')}
    ${functionSource('openPillPalette')}
    ${functionSource('openCommandPalette')}
    ({
      commands: (next) => { view = next; return pillCommandRows().map((row) => [row.id, row.label, row.hint, row.icon]); },
      open: (id) => { openPillPalette(id); return { mode: palMode, rows: pillRows('').map((row) => [row.label, row.hint]) }; },
      pick: (label) => { pillRows('').find((row) => row.label === label).run(); return { mode: palMode, filter: filters.get(view), group: groupPref[view], sort: sortPref[view] }; },
    });
  `);
  assert.deepEqual(plain(api.commands('tasks')), [
    ['pill:status', 'Filter by status', 'In Progress', 'status'], ['pill:assigned', 'Filter by assignee', 'Anyone', 'assigned'],
    ['pill:sort', 'Sort by', 'Default', 'sort'], ['pill:group', 'Group by', 'None', 'group'],
    ['pill:display', 'Display', 'Status, Assigned, Updated', 'field'],
  ], 'Cmd+K names the current Tasks view options for what they do, with the value as the hint and each its supplied icon (Tasks groups by Status until told otherwise), and Tasks is a kind page with no type to pick');
  assert.deepEqual(plain(api.open('status')), { mode: 'pill', rows: [['Any status', ''], ['Inbox', ''], ['In Progress', '✓'], ['Completed', ''], ['Later', '']] },
    'a command opens the same Status rows and active tick as the pill');
  assert.equal(api.pick('Inbox').mode, 'pill', 'a multi-select filter stays in its pill sublevel');
  api.open('sort');
  assert.deepEqual(plain(api.pick('Title')), { mode: 'cmd', filter: { types: ['tasks'], states: ['proposed', 'open'], assignee: 'anyone', text: '' }, sort: 'title' },
    'a single Sort choice applies the shared row action and returns to commands');
  api.open('group');
  assert.equal(api.pick('Assignee').group, 'assignee', 'Group uses the same shared action too');
  // A kind page is that kind: Tasks, Meetings, Chats and People do not offer a type to pick, so the page cannot be
  // turned into a different one; the Library picks its kinds, and so does the Inbox, which is a state, not a kind.
  assert.deepEqual(plain(api.commands('library').map(([id]) => id)), ['pill:type', 'pill:status', 'pill:assigned', 'pill:sort', 'pill:group', 'pill:display'],
    'Library includes its Type filter plus the other applicable pills');
  assert.deepEqual(plain(api.commands('inbox').map(([id]) => id)), ['pill:type', 'pill:status', 'pill:assigned', 'pill:sort', 'pill:group', 'pill:display'],
    'the Inbox is a state rather than a kind, so it still picks types');
  // Right on a pill steps to the next one; past the last (Group) it goes down to the first node, the way Up from
  // that node reaches the last pill (focusAbove).
  const pillArrows = vm.runInNewContext(`
    let menu = null, caret = null, focused = null;
    const renderPills = () => {}, texts = () => ['first node'], setCaret = (el, offset) => { caret = [el, offset]; };
    ${functionSource('pillKeys')}
    const pill = (hasNext) => ({ previousElementSibling: null, nextElementSibling: hasNext ? { focus: () => { focused = 'next pill'; } } : null });
    ({ right: (hasNext) => { caret = focused = null; pillKeys({ key: 'ArrowRight', preventDefault() {} }, { rows: () => [] }, pill(hasNext)); return { caret, focused }; } });
  `);
  assert.deepEqual(plain(pillArrows.right(true)), { caret: null, focused: 'next pill' }, 'Right moves along the pills');
  assert.deepEqual(plain(pillArrows.right(false)), { caret: ['first node', 0], focused: null }, 'and from the last pill to the first node');
  assert.match(functionSource('backPalette'), /palMode === 'pill'[\s\S]*openCommandPalette\(\)/, 'Escape from a pill returns one palette level');
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
    const hasKids = (item) => !!item.node.hasChildren || !!item.node.children?.length;
    const canEditItem = () => editable;
    const isSpace = (n) => n.id.startsWith('tana:space:');
    const isSearchDoc = (n) => n.id.startsWith('tana:search:');
    ${sourceBetween('const canInsertChild =', 'const canExpand =')}
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
  // A saved search stays editable so its title can be renamed, so editability cannot be what keeps the draft row away:
  // without its own exclusion, typing there would write outline content onto a document created with none.
  assert.deepEqual(ids(api.tail([], { key: 'q', docId: 'q', node: { id: 'tana:search:1', kind: 'document' } })), [], 'a saved search lists the rows its query returns, so it has no draft child');
  const block = { key: 'doc/b', docId: 'doc', node: { id: 'b', kind: 'block', block: 'paragraph' } };
  assert.deepEqual(ids(api.tail([], block)), ['draft:doc/b'], 'an empty block opens on a draft child');
  const child = row('c', 'child'), parentWithChild = { ...block, node: { ...block.node, hasChildren: true, children: [child] } };
  assert.deepEqual(ids(api.tail([child], parentWithChild)), ['c', 'draft:doc/b'], 'a block with children gets a draft that appends after its last child');
  assert.deepEqual(ids(api.tail([], { ...block, node: { ...block.node, block: 'heading2' } })), [], 'a bare heading does not offer a child its Tana schema cannot store');
  assert.deepEqual(ids(api.tail([], { ...block, node: { ...block.node, block: 'bullet', heading: 2 } })), ['draft:doc/b'], 'a heading inside a list item can still add children');
  api.set(false, true);
  assert.deepEqual(ids(api.tail([], doc)), [], 'a read-only document (every chat) never offers a row to type in');
  api.set(true, false);
  assert.deepEqual(ids(api.tail([], doc)), [], 'children that are still loading are not an empty document');
  assert.match(source, /caretOnOpen = false;\n\s+const last = list\.at\(-1\)/, 'the caret lands in that row once per open, not on every render');
  assert.match(source, /flushAll\(\); dropDrafts\(\); caretOnOpen = true;/, 'both routes into a node (zoomTo, openDoc) ask for it');
  assert.match(source, /el\.focus\(\{ preventScroll: true \}\); setCaret\(el, 0\); scrollOnType = true;/,
    'the caret is parked in the draft tail without scrolling the open to the bottom of a long node');
  assert.match(source, /if \(caretOnOpen\) outline\.parentElement\.scrollTop = 0;/,
    'and the open itself lands at the top, through both the "Loading…" render and the one the children arrive on');
}

// Opening a node puts the caret in the draft tail at the bottom while the page stays at the top; the first character
// typed is what scrolls down to it, once.
function runCaretOnOpenScrollCheck() {
  const api = vm.runInNewContext(`
    let scrollOnType = false, scrolls = [];
    const chipOnly = () => false;
    const item = { key: 'doc/b', busy: false, node: { kind: 'block', draft: false } };
    const items = new Map([[item.key, item]]);
    const keyOfEl = () => item.key;
    let editable = true;
    const canEditText = () => editable;
    const scheduleSave = () => {}, readSegs = () => [], materialise = () => {}, openSlash = () => {};
    const palette = { hidden: true };
    const el = {
      textContent: 'a', classList: { toggle: () => {} },
      closest: (sel) => (sel === '.text' ? el : null),
      scrollIntoView: (opts) => { scrolls.push(opts); },
    };
    let handler = null;
    const outline = { addEventListener: (name, fn) => { if (name === 'input') handler = fn; } };
    ${sourceBetween("outline.addEventListener('input'", "outline.addEventListener('focusout'")}
    ({
      open: () => { scrollOnType = true; },
      type: () => { handler({ target: el }); return { scrolls: scrolls.slice(), armed: scrollOnType }; },
      setEditable: (value) => { editable = value; },
      reset: () => { scrolls = []; scrollOnType = false; },
    });
  `);

  api.open();
  assert.deepEqual(plain(api.type()), { scrolls: [{ block: 'nearest' }], armed: false },
    'the first character typed scrolls the parked row into view, by the smallest move that shows it');
  assert.deepEqual(plain(api.type()), { scrolls: [{ block: 'nearest' }], armed: false },
    'and only that one: later keystrokes in the same row never scroll again');
  api.reset();
  assert.deepEqual(plain(api.type()), { scrolls: [], armed: false },
    'typing in a node that was not just opened scrolls nothing');
  api.reset();
  api.open();
  api.setEditable(false);
  assert.deepEqual(plain(api.type()), { scrolls: [], armed: true },
    'a read-only row is not typing, so it neither scrolls nor spends the one-shot the real row is still waiting on');
}

// Every list row says who can see it, not only task rows, and the metadata request waits for the row to be on screen.
function runRowAudienceCheck() {
  const api = vm.runInNewContext(`
    const items = new Map(), open = new Map(), pending = new Map();
    const docOf = () => ({ editable: true });
    const blurSensitive = () => {};
    const keyFor = (docId, node) => node.kind === 'document' ? docId : docId + '/' + node.id;
    const mkItem = (docId, node, parent) => { const item = { key: keyFor(docId, node), docId, node, parent }; items.set(item.key, item); return item; };
    const hasKids = () => false, isOpen = () => false, setOpen = () => {}, zoomTo = () => {}, ensureLoaded = () => {}, childrenOf = () => [], isSpace = () => false, draftNode = () => ({ id: 'draft', kind: 'block', text: '', draft: true });
    const renderSegs = () => {}, segsOf = () => [], asDoc = (node) => ({ ...node, kind: 'document', text: node.text ?? node.title ?? '' });
    const isImage = () => false, chipEl = () => ({ className: 'chip' }), iconSvg = (icon) => '<svg data-icon="' + icon + '"></svg>';
    const iconNode = (icon) => { const svg = document.createElement('svg'); svg.attrs['data-icon'] = icon; return svg; }; // a cloned template in the app; here the name is what matters
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
    // which facts a row shows. withShims defaults this; here the harness drives it, so the sub-line can be checked
    // both with Lives in on and with it off. Assigned through globalThis because the shim's displayOn reads it there.
    let displayNow = ['status', 'assigned', 'updated'];
    globalThis.displayKeys = () => displayNow;
    ({
      row: (node, meta) => {
        fetched.length = 0; observed.length = 0; taskMetaById.clear();
        if (meta) taskMetaById.set(node.id, meta);
        const el = nodeEl(node, node.id, null);
        const body = el.children[0].children.find((child) => child.className === 'body');
        const info = body.children.find((child) => child.className.split(' ')[0] === 'meta');
        return { icons: info ? info.children.map((icon) => icon.attrs['aria-label'] || (icon.children[0] || { attrs: {} }).attrs['data-icon']) : null, gaps: info ? info.children.map((icon) => (icon.style.cssText.match(/margin-left:([^;]+)/) || [])[1] || null) : null, pending: info ? info.className.includes('pending') : null, sub: (body.children.find((child) => child.className === 'subtext') || {}).value || null, chips: body.children.filter((child) => child.className === 'chip').length, fetched: [...fetched], observed: observed.map((watched) => watched.dataset.metaFor) };
      },
      onScreen: () => { watching(observed.map((target) => ({ isIntersecting: true, target }))); return [...fetched]; },
      display: (keys) => { displayNow = keys; },
    });
  `, { structuredClone });
  const doc = { id: 'tana:text:doc1', kind: 'document', text: 'Charter', icon: 'doc', hasChildren: true, editable: true };
  const meeting = { id: 'tana:event:m1', kind: 'document', text: 'Platform Guild', icon: 'meeting', hasChildren: true, editable: true };
  const task = { id: 'tana:text:t1', kind: 'document', text: 'Renew the agreement', icon: 'task', hasChildren: true, editable: true };
  const spaceMeta = { assignees: [], audience: { scope: 'space' }, audienceSpace: { title: 'Studio LT' } };
  const row = (node, meta) => plain(api.row(node, meta));
  assert.deepEqual(row(doc, spaceMeta).icons, ['Visible to members of Studio LT'], 'a doc row carries the audience icon, the way a task row does');
  assert.deepEqual(row(meeting, { assignees: [], audience: 'only-me' }).icons, ['Visible only to you'], 'a meeting row carries it too');
  assert.deepEqual(row(doc, { assignees: [], audience: 'everyone', linkShared: true }).icons, ['Visible to everyone', 'Anyone with the link'], 'link sharing stays a separate icon on a doc row');
  assert.deepEqual(row(task, { assignees: ['tana:user-profile:sam'], audience: 'only-me' }).icons, ['Visible only to you'], 'a task row is unchanged');
  assert.deepEqual(row(task, { assignees: ['tana:user-profile:sam'], audience: 'only-me' }).gaps, ['6px'], 'an icon after an assignee name keeps its 6px');
  assert.deepEqual(row(doc, spaceMeta).gaps, ['0'], 'a row with no name in front of the icon does not add a second gap on top of the one the meta span carries');
  assert.deepEqual(row(doc, { assignees: [], audience: 'everyone', linkShared: true }).gaps, ['0', '6px'], 'the icons still stand apart from each other');
  // The space sub-line used to be unconditional; it is now the Display pill's "Lives in", which ships off. Both
  // directions are pinned: wiring it back to always-on would otherwise pass every test in this file.
  assert.equal(row(doc, spaceMeta).sub, null, 'with Lives in off, a space audience does not name the space under the title');
  api.display(['status', 'assigned', 'updated', 'space']);
  assert.equal(row(doc, spaceMeta).sub, 'Studio LT', 'turning Lives in on names it again, the way the row always did');
  api.display(['status', 'assigned', 'updated']);
  assert.equal(row(doc, spaceMeta).sub, null, 'and turning it off takes the line away again');
  // Type is the same shape: the chips are a fact about the row, shown only while the pill asks for them.
  const tagged = { ...doc, tags: [{ label: 'Charter' }] };
  api.display(['status', 'assigned', 'updated', 'type']);
  assert.equal(row(tagged, spaceMeta).chips, 1, 'with Type on, a row shows its type chip');
  api.display(['status', 'assigned', 'updated']);
  assert.equal(row(tagged, spaceMeta).chips, 0, 'with Type off, it does not');
  assert.equal(row(doc, { assignees: [], audience: 'unknown' }).icons, null, 'a document with nothing shareable shows nothing at all');
  // A watched node says so on the row: the bell is the only place outside Cmd+K that tells you changes reach you.
  assert.deepEqual(row(doc, { ...spaceMeta, watched: true }).icons, ['Visible to members of Studio LT', 'Notifying on changes'], 'a watched row carries a bell after its audience icon');
  assert.deepEqual(row(task, { assignees: ['tana:user-profile:sam'], audience: 'only-me', watched: true }).icons, ['Visible only to you', 'Notifying on changes'], 'a task row carries it too');
  assert.deepEqual(row(doc, { assignees: [], audience: 'unknown', watched: true }).icons, ['Notifying on changes'], 'and a document with nothing shareable still shows the bell rather than nothing');
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
    const isTask = () => false, canEditNode = () => true, iconSvg = () => '', appendTags = () => {}, goTo = () => {}, railKey = () => {}, blurSensitive = () => {};
    ${functionSource('railRow')}
    (lines) => {
      const row = railRow({ id: 'tana:event:m1', text: 'Platform Guild', icon: 'meeting' });
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

// A view that gains and loses rows between two renders: arrivals flash, departures go back where they were.
function runRowChangeAnimationCheck() {
  // The zoomed branch of render() replaces every row without going through animateRows, so the harness models it —
  // but only clears animView when the real source does, or the round-trip test below would pass whatever the code says.
  const clearsOnZoom = /animView = null; \/\/ a zoom replaced every row/.test(source);
  const api = vm.runInNewContext(`
    const mk = (key, draft) => { const c = new Set(draft ? ['node', 'draft'] : ['node']);
      return { dataset: { key }, querySelectorAll: () => [],
        classList: { add: (n) => c.add(n), remove: (...n) => n.forEach((x) => c.delete(x)), contains: (n) => c.has(n) },
        remove() { outline.children = outline.children.filter((el) => el !== this); } }; };
    let view = 'tasks', animView = null;
    const CLEARS_ON_ZOOM = ${clearsOnZoom};
    const timers = [], setTimeout = (fn) => timers.push(fn);
    const outline = { children: [], insertBefore(el, ref) { outline.children.splice(ref ? outline.children.indexOf(ref) : outline.children.length, 0, el); } };
    const nodeElOf = (key) => outline.children.find((el) => el.dataset.key === key) || null;
    ${functionSource('animateRows')}
    ({
      render: (keys) => {
        const before = new Map(outline.children.filter((el) => el.classList.contains('node')).map((el) => [el.dataset.key, el]));
        outline.children = keys.map((k) => mk(k.replace('*', ''), k.endsWith('*')));
        animateRows(before);
        return outline.children.map((el) => el.dataset.key + (el.classList.contains('entering') ? '+' : '') + (el.classList.contains('leaving') ? '-' : ''));
      },
      zoom: (keys) => { outline.children = keys.map((k) => mk(k)); if (CLEARS_ON_ZOOM) animView = null; },
      switchView: (next) => { view = next; },
      expire: () => { timers.splice(0).forEach((fn) => fn()); return outline.children.map((el) => el.dataset.key); },
    });
  `);
  assert.deepEqual(plain(api.render(['a', 'b', 'c'])), ['a', 'b', 'c'], 'the first paint of a view flashes nothing');
  assert.deepEqual(plain(api.render(['a', 'x', 'b', 'c'])), ['a', 'x+', 'b', 'c'], 'only the row that arrived is marked as arriving');
  assert.deepEqual(plain(api.render(['a', 'c'])), ['a', 'x-', 'b-', 'c'], 'rows that left are put back in their old places, on their way out');
  assert.deepEqual(plain(api.render(['a', 'c'])), ['a', 'x-', 'b-', 'c'], 'and the renders that keep coming leave them there, still on their way out');
  assert.deepEqual(plain(api.expire()), ['a', 'c'], 'and are gone once the animation has had its time');
  assert.deepEqual(plain(api.render(['a', 'c', 'n*'])), ['a', 'c', 'n'], 'a draft row is no arrival: it is local until it is typed into');
  api.switchView('library');
  assert.deepEqual(plain(api.render(['p', 'q'])), ['p', 'q'], 'switching views replaces every row and must not flash');
  assert.match(source, /animateRows\(before\)/, 'and the view render hands it the rows that were on screen before it');
  const many = Array.from({ length: 40 }, (_, i) => 'r' + i);
  api.switchView('bulk'); api.render(many); // settle a big list, then replace it wholesale
  assert.deepEqual(plain(api.render(['one'])), ['one'], 'a wholesale change is the list changing, not forty rows falling away one by one');
  // loadView resolves after the render that asked for it (renderer/nodes.js), so opening a view that has never been
  // loaded paints zero rows first. That empty paint must not spend the first-paint guard, or the render the rows
  // actually arrive on sees an empty `before` and flashes the whole view green.
  api.switchView('slow');
  assert.deepEqual(plain(api.render([])), [], 'a view whose rows have not arrived yet paints nothing');
  assert.deepEqual(plain(api.render(['s1', 's2', 's3'])), ['s1', 's2', 's3'],
    'and the rows that then arrive are that view appearing, not three arrivals');
  // Zooming replaces every row without going through animateRows, and a zoomed block row is keyed docId/nodeId while
  // a view row is keyed by its document id, so on the way back nothing in `before` matched and every row looked new.
  api.switchView('zoomed');
  assert.deepEqual(plain(api.render(['z1', 'z2'])), ['z1', 'z2'], 'the view settles before the zoom');
  api.zoom(['z1/b1', 'z1/b2']);
  assert.deepEqual(plain(api.render(['z1', 'z2'])), ['z1', 'z2'],
    'and coming back from a zoom flashes nothing: those rows never went anywhere');
}

// The row you are typing in can stop belonging to the view (complete the task you are editing). It stays, dimmed.
function runFallingRowCheck() {
  const api = vm.runInNewContext(`
    let zoom = null, focusedKey = 'a', nodes = [];
    const classes = new Set(), outline = {};
    const el = { parentElement: outline, dataset: { get key() { return focusedKey; } }, classList: { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); } } };
    const focused = () => (focusedKey ? { key: focusedKey } : null);
    const nodeElOf = (key) => (key === focusedKey ? el : null);
    const viewOf = () => ({ nodes });
    ${sourceBetween('const keyFor =', 'const mkItem')}
    ${functionSource('markFalling')}
    ({ run: (key, list) => { focusedKey = key; nodes = list.map((id) => ({ id, kind: 'document' })); markFalling(); return [...classes]; } });
  `);
  assert.deepEqual(plain(api.run('a', ['a', 'b'])), [], 'a row the view still lists is not dimmed');
  assert.deepEqual(plain(api.run('a', ['b'])), ['falling'], 'the row you are typing in dims once the view no longer lists it');
  assert.deepEqual(plain(api.run('a', ['a', 'b'])), [], 'and undims if it comes back before the caret leaves');
  assert.match(source, /renderDeferred = true; markFalling\(\)/, 'the deferred render is where the dimming is decided');
}

// Arrowing off an empty draft drops it, and the drop must wait for the caret's new home to take focus:
// A recorded row keeps what it looked like when it was opened, and a meeting's meta ages: "Fri 13:00" for a meeting
// that has since passed. When the node is loaded now, the palette shows what it says today.
function runRecentRowsCheck() {
  const api = vm.runInNewContext(`
    const stored = [
      { id: 'meeting', title: 'AEGIS update', icon: 'meeting', meta: 'Fri 13:00–13:30', tags: [] },
      { id: 'gone', title: 'Old note', icon: 'doc', meta: 'Mon 9:00', tags: [], hue: 205 },
    ];
    const localStorage = { getItem: () => JSON.stringify(stored) };
    const asDoc = (node) => ({ ...node, kind: 'document', text: node.text ?? node.title ?? '' });
    const docOf = (id) => (id === 'meeting' ? { id, text: 'AEGIS update', meta: 'Fri 11 Sep 13:00–13:30', hue: 77 } : null);
    ${sourceBetween('const recent =', 'function recordRecent')}
    ${sourceBetween('const recentRows =', 'async function loadRoots')}
    recentRows;
  `);
  assert.deepEqual(plain(api().map((row) => [row.text, row.meta, row.hue])), [
    ['AEGIS update', 'Fri 11 Sep 13:00–13:30', 77],
    ['Old note', 'Mon 9:00', 205],
  ], 'a loaded row is shown as it reads now, hue included; one the app has not loaded keeps what was recorded');
}

// Arrowing off an empty draft drops it, and the drop must wait for the caret's new home to take focus:
// a re-render while nothing is focused throws the caret away, which is what "I cannot arrow up from the draft" was.
async function runDraftBlurOrderCheck() {
  const api = vm.runInNewContext(`
    const queueMicrotask = (fn) => Promise.resolve().then(fn);
    const item = { key: 'doc/draft:doc', node: { draft: true } };
    const el = { textContent: '', isConnected: true, classList: { contains: () => true }, closest: () => ({ dataset: { key: item.key } }) };
    const above = { row: 'above' };
    const items = new Map([[item.key, item]]);
    const document = { activeElement: el };
    const keyOfEl = () => item.key, flush = () => {};
    let rendering = false, drops = 0, activeAtDrop = 'none';
    const dropDraft = () => { drops++; activeAtDrop = document.activeElement === above ? 'above' : document.activeElement === el ? 'draft' : 'nothing'; };
    let handler = null;
    const outline = { addEventListener: (name, fn) => { if (name === 'focusout') handler = fn; } };
    ${sourceBetween("outline.addEventListener('focusout'", "outline.addEventListener('mousedown'")}
    ({
      blurTo: async (target) => { document.activeElement = null; handler({ target: el }); document.activeElement = target === 'above' ? above : target === 'draft' ? el : null; await Promise.resolve(); await Promise.resolve(); return { drops, activeAtDrop }; },
      reset: () => { drops = 0; activeAtDrop = 'none'; document.activeElement = el; },
    });
  `);

  const moved = plain(await api.blurTo('above'));
  assert.deepEqual(moved, { drops: 1, activeAtDrop: 'above' }, 'the draft is dropped only once the row the caret moved to holds focus, so the re-render can keep it there');
  api.reset();
  const stayed = plain(await api.blurTo('draft'));
  assert.deepEqual(stayed, { drops: 0, activeAtDrop: 'none' }, 'focus bouncing back to the draft itself leaves it alone');
  api.reset();
  const left = plain(await api.blurTo(null));
  assert.deepEqual(left, { drops: 1, activeAtDrop: 'nothing' }, 'an empty draft the user simply left is still dropped');
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
  const filled = plain(await api.load([{ id: 'tana:user-profile:andre', title: 'Robin Vega' }]));
  assert.equal(filled.attempts, 3, 'it keeps asking until someone is in the list');
  assert.equal(api.name('tana:user-profile:andre'), 'Robin Vega', 'and once it answers, names resolve');
  const settled = plain(await api.load(null));
  assert.equal(settled.attempts, 3, 'a list with people in it is loaded for good: no further calls');
  api.reset(Date.now());
  const throttled = plain(await api.load([]));
  assert.equal(throttled.attempts, 3, 'a slow start cannot turn renders into a request loop: a fresh ask is throttled');
}

// Saved searches are places to go, so Cmd+K lists them under their own heading, each opening its document via goTo.
function runSearchesGroupCheck() {
  // Anchored to the boot statement itself (not just any mention of tana.searches() in the file) so this keeps
  // failing if the call is ever deleted rather than merely moved, per the final review's Minor #4.
  assert.match(source, /if \(tana\.searches\) tana\.searches\(\)/, 'the renderer loads saved searches from the read-only channel');
  const paletteRows = functionSource('paletteRows');
  // A minimal paletteRows harness, matching the one above (runSyncShortcutCheck): only `searches` and `goTo` vary,
  // so a row from the new group and the effect of running it are both observed, not merely a string in the source.
  const harness = (searchesLiteral) => vm.runInNewContext(`
    const calls = [];
    const goTo = (uri) => calls.push(uri);
    const searches = ${searchesLiteral};
    const views = [], pinTree = [], pinRows = () => [], selectionRows = () => [];
    const pillCommandRows = () => [];
    const taskActionRows = () => [];
    const tana = { refresh: async () => {} }, run = () => {};
    const authed = true, authChecking = false, signedOut = false, pinInfo = null, palDoc = null, hotkeys = {}, theme = 'light';
    const localDate = () => '2026-09-13', setTheme = () => {};
    const docRow = () => ({}), sectionOf = () => null;
    const zoom = null, railEl = { hidden: true }, navBack = [], navForward = [];
    const railToggle = { hidden: false }, railHidden = false; // the sidebar toggle row: available, so paletteRows builds it
    ${paletteRows}
    const rows = paletteRows('').filter((r) => r.group === 'Searches');
    ({ rows: rows.map((r) => ({ id: r.id, label: r.label })), open: (i) => { rows[i].run(); return calls; } });
  `);
  // The fixture carries only `title` (no `text`), the shape the in-file mock's info() actually returns
  // (renderer/mock.js), so this also exercises the `s.text || s.title` label fallback, not just the `s.text` path.
  const populated = harness("[{ id: 'tana:search:01j0search0000000000000000', title: 'Weekly review' }]");
  assert.deepEqual(plain(populated.rows), [{ id: 'search:tana:search:01j0search0000000000000000', label: 'Weekly review' }],
    'a saved search is listed under Searches, labelled from the document');
  assert.deepEqual(plain(populated.open(0)), ['tana:search:01j0search0000000000000000'], 'selecting it opens the search document via goTo');

  const empty = harness('[]');
  assert.deepEqual(plain(empty.rows), [], 'no saved searches means no Searches group at all');
}

// The sidebar can be put away by hand, and that preference outlives any document: hiding wins over
// content, so a sidebar you closed does not reopen because the next node happens to have pins.
function runRailToggleCheck() {
  const api = vm.runInNewContext(`
    const store = new Map();
    const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
    let renders = 0;
    const render = () => { renders++; };
    let railHidden = localStorage.getItem('railHidden') === '1';
    ${functionSource('railOff')}
    ${functionSource('toggleRail')}
    ({
      state: () => ({ hidden: railHidden, stored: store.has('railHidden') ? store.get('railHidden') : null, renders }),
      off: (empty) => railOff(empty),
      toggle: () => { toggleRail(); },
    });
  `);
  assert.equal(api.off(false), false, 'a sidebar with something in it is shown by default');
  assert.equal(api.off(true), true, 'an empty sidebar stays hidden whatever the preference says');
  assert.deepEqual(plain(api.state()), { hidden: false, stored: null, renders: 0 }, 'and nothing is persisted until the user asks for it');
  api.toggle();
  assert.deepEqual(plain(api.state()), { hidden: true, stored: '1', renders: 1 }, 'hiding it persists the preference and repaints once');
  assert.equal(api.off(false), true, 'hiding wins over content: a document with pins does not reopen it');
  api.toggle();
  assert.deepEqual(plain(api.state()), { hidden: false, stored: '0', renders: 2 }, 'showing it again persists that too');
  assert.equal(api.off(false), false, 'and the sidebar is back');
  // The harness above proves railOff composes correctly, but it never touches renderRail — so nothing in it
  // would notice the call site being reverted to the bare content test, leaving the preference wired to nothing.
  // (Verified: reverting that one line left the whole suite green.) Faking the rail DOM for one boolean is a poor
  // trade, so the wiring gets a source anchor instead, specific enough to fail on deletion rather than movement —
  // the same instrument runSearchesGroupCheck uses for the boot statement it cannot reach.
  assert.match(source, /railEl\.hidden = railGrip\.hidden = railOff\(empty\);/,
    'renderRail actually asks railOff, so the preference reaches the sidebar rather than sitting in a helper nobody calls');
}

// A saved search is a query you can edit, so the pills serve it too, keyed by the document rather than the view.
// What makes it different from a view is that its edits are staged and saved deliberately, so that is what this pins:
// the right filter is read, the right pills are offered, and an edit reaches neither the view behind it nor the
// document until Save. The other pill harnesses all answer "a view", so without this the search side has no cover.
function runSearchPillsCheck() {
  const api = vm.runInNewContext(`
    let view = 'tasks';
    let zoom = { docId: 'tana:search:s1', nodeId: null };
    const displayPref = {}; // state.js declares it, which is outside the slices this harness takes
    const filters = new Map([
      ['tasks', { types: ['tasks'], states: ['open'], assignee: 'anyone', text: '' }],
      ['tana:search:s1', { types: ['tasks'], states: ['proposed'], assignee: 'me', text: '' }],
    ]);
    // 'tasks' is a kind page, so the type pill is withheld on the view; a saved search must still offer it
    const views = [{ id: 'tasks', kind: true }];
    let members = [{ id: 'me', title: 'Robin', me: true }], groupPref = {}, sortPref = {};
    let pillCtx = null, palMode = 'cmd', palRows = [], palIndex = 0, renders = 0;
    const taskMetaById = new Map(), tana = {}, palette = { hidden: false };
    const $ = () => ({ hidden: false }), showError = () => {}, renderPills = () => {};
    const stored = {}; // what reached the browser's preference blobs, so the test can tell document from localStorage
    const localStorage = { setItem: (k, v) => { stored[k] = v; } }, render = () => { renders++; };
    // an edit on a saved search must not write the view waiting behind it: fail loudly rather than quietly
    const setViewF = () => { throw new Error('a saved search edit reached setViewF'); };
    const palInput = { value: '', placeholder: '', focus() {} };
    const renderPalette = () => { renders++; };
    ${sourceBetween('const SEARCH_ID =', 'const childrenOf =')}
    ${sourceBetween('const sameList =', 'function viewFiltered')}
    ${sourceBetween('const pillKey =', 'function loadSearchFilter')}
    ${sourceBetween('const STATES =', 'function renderPills')}
    ({
      key: () => pillKey(),
      ids: () => pillDefs().map((def) => def.id),
      applies: () => pillsApply(),
      dirty: () => searchDirty(),
      loaded: () => { searchFilters.set(zoom.docId, { filter: filters.get(zoom.docId), sort: sortBy(), group: groupBy(), display: displayKeys() }); },
      edit: (patch) => { setSearchF(patch); return filters.get(zoom.docId); },
      arrange: (sort, group) => { if (sort) setSortBy(sort); if (group) setGroupBy(group); return { sort: sortBy(), group: groupBy() }; },
      show: (id) => { setDisplay(id); return displayKeys(); },
      stored: () => stored,
      behind: () => filters.get('tasks'),
      leave: () => { zoom = null; },
    });
  `);
  assert.equal(api.key(), 'tana:search:s1', 'the pills on a saved search read that document, not the view waiting behind it');
  assert.equal(api.applies(), true, 'so they apply there at all');
  // A saved search is never a kind page: choosing what it lists is the whole point of it. Sort and Group are view
  // layout, and the page a search draws neither sorts nor groups, so offering them would offer something that does nothing.
  assert.deepEqual(plain(api.ids()), ['type', 'status', 'assigned', 'sort', 'group', 'display'], 'a saved search offers the query pills and the arrangement ones, which it stores in its own document');
  api.loaded();
  assert.equal(api.dirty(), false, 'freshly loaded from the document, there is nothing to save');
  assert.deepEqual(plain(api.edit({ states: ['open'] })), { types: ['tasks'], states: ['open'], assignee: 'me', text: '' },
    'an edit stages onto the search document filter');
  assert.deepEqual(plain(api.behind()), { types: ['tasks'], states: ['open'], assignee: 'anyone', text: '' },
    'and leaves the view behind it exactly as it was');
  assert.equal(api.dirty(), true, 'a staged edit is something to save');
  // How a saved search arranges its rows is part of what it stores, so changing that is something to save too — and
  // it belongs in the document rather than in this browser, or the search would look different to everyone else.
  api.loaded();
  assert.equal(api.dirty(), false, 'saving re-baselines: nothing left over from the edit above');
  assert.deepEqual(plain(api.arrange('title', 'status')), { sort: 'title', group: 'status' }, 'a saved search takes a sort and a grouping of its own');
  assert.equal(api.dirty(), true, 'and changing the arrangement is something to save, exactly like changing the query');
  assert.ok(!JSON.stringify(plain(api.stored())).includes('tana:search:'),
    'a saved search keeps its arrangement in its document: its key never reaches the preference blob the views persist to');
  // What its rows show is stored beside the query and the arrangement, so changing it is the same kind of edit: if it
  // did not count as unsaved, the Save pill would not appear and the choice would be lost on the way out.
  api.loaded();
  assert.equal(api.dirty(), false, 'freshly loaded, the display it was saved with is not an edit');
  assert.deepEqual(plain(api.show('created')), ['status', 'assigned', 'updated', 'created'], 'a saved search takes a display of its own');
  assert.equal(api.dirty(), true, 'and changing what its rows show is something to save, like the query and the arrangement');
  api.leave();
  assert.equal(api.key(), 'tasks', 'and off the search page the pills belong to the view again');
}

// The app reopens where you left off. Every render records the place (noteNavigation), so whatever took you there —
// a bullet, a mention, a crumb, a search, a pin — is remembered the same way; boot puts it back once the views load.
async function runRestorePlaceCheck() {
  const api = vm.runInNewContext(`
    let view = 'inbox', zoom = null, rendered = 0, fetches = 0, nodeResolve = null, nodeMode = 'auto', docs = [], savedPlace = null, connected = true;
    const storage = new Map();
    const localStorage = {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    };
    const extra = new Map(), summaries = [];
    const allDocs = () => docs;
    const render = () => { rendered++; };
    const followSummary = (docId) => summaries.push(docId);
    // Answers at once unless a case parks it: a fetch that never settles would hang the check, and an unsettled
    // check empties the event loop and exits silently rather than failing.
    const tana = { node: () => { fetches++;
      if (nodeMode === 'fail') return Promise.reject(new Error('no longer readable'));
      if (nodeMode === 'park') return new Promise((resolve) => { nodeResolve = () => resolve({ title: 'Fetched' }); });
      return Promise.resolve({ title: 'Fetched' }); } };
    ${sourceBetween('const isRealId =', '\n')}
    ${sourceBetween('const navBack = [], navForward = [];', 'function noteNavigation')}
    ${functionSource('readStoredPlace')}
    ${functionSource('restorePlace')}
    ({
      remember: (z) => { zoom = z; rememberPlace(); return storage.has('place') ? storage.get('place') : null; },
      store: (value) => { storage.set('place', value); savedPlace = readStoredPlace(); }, // left by the last session, read at load
      clear: () => { storage.delete('place'); savedPlace = readStoredPlace(); },
      firstPaint: () => { zoom = null; rememberPlace(); }, // what the boot render records: the view it drew, with no zoom
      seed: (list) => { docs = list; },
      reset: () => { zoom = null; rendered = 0; fetches = 0; nodeMode = 'auto'; connected = true; extra.clear(); summaries.length = 0; },
      fail: () => { nodeMode = 'fail'; },
      park: () => { nodeMode = 'park'; },
      offline: () => { connected = false; }, online: () => { connected = true; },
      start: () => restorePlace(),
      settle: () => nodeResolve && nodeResolve(),
      goto: (v, z) => { view = v; zoom = z; },
      state: () => ({ docId: (zoom && zoom.docId) || null, nodeId: (zoom && zoom.nodeId) || null, from: (zoom && zoom.from) || null,
                      rendered, fetches, fetched: extra.has('tana:text:far'), summaries: summaries.length }),
    });
  `);
  assert.equal(api.remember({ docId: 'tana:text:a', nodeId: 'n1', from: 'Search' }), JSON.stringify({ docId: 'tana:text:a', nodeId: 'n1', from: 'Search' }),
    'the node you are looking at is remembered as the place to reopen');
  assert.equal(api.remember(null), null, 'a view is not a zoom: the stored place is cleared rather than left stale');
  api.remember({ docId: 'tana:text:a', nodeId: null });
  assert.equal(api.remember({ docId: 'draft:7', nodeId: null }), null, 'a draft id would mean nothing after a restart, so it replaces nothing');

  api.reset(); api.seed([{ id: 'tana:text:a' }]);
  api.store(JSON.stringify({ docId: 'tana:text:a', nodeId: 'n1', from: 'Search' }));
  await api.start();
  assert.deepEqual(plain(api.state()), { docId: 'tana:text:a', nodeId: 'n1', from: 'Search', rendered: 1, fetches: 0, fetched: false, summaries: 1 },
    'the last place reopens down to the node, and one already in a view is not fetched again');

  // The boot render draws the view before the restore runs, and recording that view clears the stored place. Reopening
  // has to survive its own first paint, or every launch lands on the view — which is exactly what it did.
  api.reset(); api.seed([{ id: 'tana:text:a' }]);
  api.store(JSON.stringify({ docId: 'tana:text:a', nodeId: 'n1' }));
  api.firstPaint();
  await api.start();
  assert.equal(api.state().docId, 'tana:text:a', 'the first paint records the view it drew, which must not erase the place being reopened');

  // Boot reaches the restore with the cached roots already drawn, before the sync client exists. Reopening a page then
  // asks for its children with nothing to ask, so the place waits instead of being spent on a launch that cannot serve it.
  api.reset(); api.seed([{ id: 'tana:text:a' }]); api.offline();
  api.store(JSON.stringify({ docId: 'tana:text:a', nodeId: 'n1' }));
  await api.start();
  assert.equal(api.state().docId, null, 'with no connection yet, the last place is not reopened');
  api.online();
  await api.start();
  assert.equal(api.state().docId, 'tana:text:a', 'and it is still there to reopen once the connection arrives');

  api.reset(); api.seed([]);
  api.store(JSON.stringify({ docId: 'tana:text:far', nodeId: null }));
  const pending = api.start(); api.settle(); await pending;
  assert.deepEqual(plain(api.state()), { docId: 'tana:text:far', nodeId: null, from: null, rendered: 1, fetches: 1, fetched: true, summaries: 1 },
    'a place reached through a mention or a search is pulled back in, the way goTo does it');

  api.reset(); api.seed([]); api.fail();
  api.store(JSON.stringify({ docId: 'tana:text:gone', nodeId: null }));
  await api.start();
  assert.deepEqual(plain(api.state()), { docId: null, nodeId: null, from: null, rendered: 0, fetches: 1, fetched: false, summaries: 0 },
    'a node that was deleted or is no longer yours leaves you on the view, with no error to greet the launch');

  api.reset(); api.seed([]); api.park();
  api.store(JSON.stringify({ docId: 'tana:text:far', nodeId: null }));
  const slow = api.start();
  api.goto('library', { docId: 'tana:text:elsewhere', nodeId: null });
  api.settle(); await slow;
  assert.equal(api.state().docId, 'tana:text:elsewhere', 'you went somewhere while it loaded, so you stay where you went');

  api.reset(); api.seed([{ id: 'tana:text:a' }]);
  api.store(JSON.stringify({ docId: 'tana:text:a', nodeId: 'n1' }));
  api.goto('library', { docId: 'tana:text:already', nodeId: null });
  await api.start();
  assert.equal(api.state().docId, 'tana:text:already', 'a page opened during boot — a link, a notification — is not overruled by the stored place');

  api.reset(); api.clear();
  await api.start();
  assert.equal(api.state().docId, null, 'a first launch with nothing stored opens the view');
  api.reset(); api.store('{ not json');
  await api.start();
  assert.equal(api.state().docId, null, 'and a corrupt entry is simply not a place, rather than a broken launch');
  assert.match(source, /loadRoots\(\)\.then\(render, showError\)\.then\(restorePlace\)/,
    'and boot reopens that place once the views have loaded, so the restore has somewhere to land');
  assert.match(source, /if \(connected && !wasConnected\) \{ taskMetaFailed\.clear\(\); loadView\(\); loadSearches\(\); restorePlace\(\); \}/,
    'and the connection coming up runs the restore that boot was too early for, beside the other refetches that wait on it');
}

// With nothing selected, Cmd+K acts on "the current node". Child rows carry the id of the document they live in, so a
// task referenced from a date page used to resolve to the date — which has no status — and Set status vanished from
// the palette entirely. What the caret is on wins over the page holding it, unless the row is nothing on its own.
function runCurrentNodeStatusCheck() {
  const api = vm.runInNewContext(`
    let zoom = null, palDoc = null, focusedKey = null, docs = [];
    const items = new Map(), extra = new Map();
    const allDocs = () => docs;
    const focused = () => (focusedKey ? { key: focusedKey, offset: 0 } : null);
    const asDoc = (n) => n;
    ${sourceBetween('const referenceTarget =', '\n')}
    ${sourceBetween('const isTask =', '\n')}
    ${sourceBetween('const canEditNode =', '\n')}
    const selKeys = () => [];  // nothing selected: the palette is about the current node, not a selection
    const STATES = [['proposed', 'Inbox'], ['open', 'In Progress'], ['closed', 'Completed'], ['not_now', 'Later']];
    const stateOf = () => 'proposed';
    const openStatusPalette = () => {}, statusRows = () => [];
    const tana = { setState: async () => {} }; // only the status row can be built, so the rows read as what this is about
    ${functionSource('currentDoc')}
    ${functionSource('taskActionContext')}
    ${functionSource('taskActionRows')}
    ({ at: (scene) => {
        zoom = scene.zoom || null; docs = scene.docs || [];
        items.clear(); for (const [key, item] of scene.items) items.set(key, item);
        focusedKey = scene.focusedKey;
        palDoc = currentDoc();
        return { on: (palDoc && palDoc.id) || null, rows: taskActionRows().map((row) => row.label) };
      } });
  `);
  const TASK = { id: 'tana:text:task1', kind: 'document', icon: 'task', text: 'Buy milk', stateType: 'proposed' };
  const DATE = { id: 'tana:text:day', kind: 'document', icon: 'calendar', text: '2026-09-17' };
  const row = (node, docId) => ({ key: 'k', node, docId });

  assert.deepEqual(plain(api.at({ docs: [TASK], items: [['k', row(TASK, TASK.id)]], focusedKey: 'k' })),
    { on: TASK.id, rows: ['Set status'] }, 'a task listed in a view is the current node when the caret is in it');
  assert.deepEqual(plain(api.at({ zoom: { docId: DATE.id, nodeId: null }, docs: [DATE, TASK],
      items: [['k', row({ id: 'n1', text: '', reference: { node: TASK } }, DATE.id)]], focusedKey: 'k' })),
    { on: TASK.id, rows: ['Set status'] }, 'and so is a task referenced from a date page: the row, not the date holding it');
  assert.deepEqual(plain(api.at({ zoom: { docId: DATE.id, nodeId: null }, docs: [DATE],
      items: [['k', row({ id: 'n3', text: '', reference: { node: TASK } }, DATE.id)]], focusedKey: 'k' })),
    { on: TASK.id, rows: ['Set status'] }, 'even when that task sits in no view: a referenced document need not be one the app has listed');
  assert.deepEqual(plain(api.at({ zoom: { docId: DATE.id, nodeId: null }, docs: [DATE],
      items: [['k', row({ id: 'n2', text: 'just a note' }, DATE.id)]], focusedKey: 'k' })),
    { on: DATE.id, rows: [] }, 'while a plain note is nothing on its own, so it stays the page it belongs to, which has no status');
}
// A saved search page lists documents the way a view does, but its rows live in kids rather than in any view's nodes.
// Three things used to stop at that boundary and leave the rows as they were first drawn: a live change to one of
// them, a deletion, and the Clean up pill's idea of what is on screen.
async function runSearchPageRowUpdateCheck() {
  const SEARCH = 'tana:search:01j0search00000000000000';
  const TASK = 'tana:text:01j0searchrow00000000000';
  const helpers = [functionSource('forgetRecent'), functionSource('invalidatePinCaches'), functionSource('invalidateNode')].join('\n');
  const context = {};
  vm.runInNewContext(`
    const SEARCH = '${SEARCH}', TASK = '${TASK}';
    let views = [{ id: 'library', nodes: [] }], palRows = [], palDoc = null, pinInfo = null, view = 'library';
    let zoom = { docId: SEARCH, nodeId: null };
    const kids = new Map([[SEARCH, [{ id: TASK, kind: 'document', icon: 'task', text: 'old title', done: 0, stateType: 'proposed' }]]]);
    const extra = new Map(), paths = new Map(), fresh = new Map(), taskMetaById = new Map(), relatedBy = new Map();
    const railGroups = () => [], localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const isTask = (node) => node.kind === 'document' && node.icon === 'task';
    const asDoc = (node) => ({ ...node, text: node.text ?? node.title ?? '', kind: 'document' });
    let rootsLoads = 0;
    const loadRoots = async () => { rootsLoads++; };
    const tana = { node: async () => ({ id: TASK, title: 'new title', kind: 'document', icon: 'task', done: 1, stateType: 'closed' }) };
    // what shownDocs reads besides the rows: which page is in front of you, and the (empty) ⌘F box
    const onSearchPage = () => !!zoom && !zoom.nodeId && String(zoom.docId || '').startsWith('tana:search:');
    const viewOf = () => views.find((section) => section.id === view);
    const filterEl = { value: '' };
    ${functionSource('patchCopies')}
    ${functionSource('patchDoc')}
    ${helpers}
    ${sourceBetween('// The rows the page in front of you shows', 'function setGroupBy')}
    Object.assign(globalThis, {
      patch: () => patchDoc(TASK),
      drop: () => invalidateNode(TASK),
      rows: () => (kids.get(SEARCH) || []).map((node) => [node.id, node.text, node.stateType]),
      shown: () => shownDocs().map((node) => node.id),
      shownInView: () => { zoom = null; return shownDocs().map((node) => node.id); },
      loads: () => rootsLoads,
    });
  `, context);
  await context.patch();
  assert.deepEqual(plain(context.rows()), [[TASK, 'new title', 'closed']], 'a change to a document a saved search lists patches the row that page is showing');
  assert.equal(context.loads(), 0, 'and the row was found there, so nothing falls back to reloading every view');
  assert.deepEqual(plain(context.shown()), [TASK], 'Clean up asks what is on screen: on a search page that is the rows its query returned');
  context.drop();
  assert.deepEqual(plain(context.rows()), [], 'a deleted document leaves the saved search that listed it');
  assert.deepEqual(plain(context.shownInView()), [], "back on a view, the same helper answers with the view's own rows");
}



// Turning the bell on or off has to show on the row, and the palette hands the caret back to the row it was opened
// from — where a render is deferred until the caret leaves. So the toggle patches the row itself; a regression to
// the frame-coalesced render would leave the bell exactly as it was, which is how this was reported.
function runNotifyToggleCheck() {
  const harness = (on) => vm.runInNewContext(`
    const DOC = 'tana:text:01examplea0000000000000000';
    const patched = [];
    const patchMeta = (id) => patched.push(id);
    const renderSoon = () => patched.push('deferred render');
    const renderPalette = () => {};
    const run = (fn) => fn();
    const loadNotify = () => {};
    const isRealId = (id) => String(id).startsWith('tana:');
    const notifyById = new Map([[DOC, { on: ${on}, default: false, explicit: true }]]);
    const taskMetaById = new Map([[DOC, { assignees: [], audience: 'only-me', watched: ${on} }]]);
    const palDoc = { id: DOC, text: 'Contract', kind: 'document', icon: 'doc' };
    let asked = null;
    const tana = { notifyState: async () => ({}), setNotify: async (id, next) => { asked = next; return { on: next, default: false, explicit: true }; } };
    const views = [], pinTree = [], pinRows = () => [], selectionRows = () => [];
    const pillCommandRows = () => [], taskActionRows = () => [], searches = [], goTo = () => {};
    const authed = true, authChecking = false, signedOut = false, pinInfo = null, hotkeys = {}, theme = 'light';
    const localDate = () => '2026-09-13', setTheme = () => {};
    const docRow = () => ({}), sectionOf = () => null;
    const zoom = null, railEl = { hidden: true }, navBack = [], navForward = [];
    const railToggle = { hidden: false }, railHidden = false;
    ${functionSource('paletteRows')}
    const row = paletteRows('').find((r) => r.rank === 'notify');
    ({ label: row.label, press: async () => { await row.run(); return { patched, asked, watched: taskMetaById.get(DOC).watched }; } });
  `);
  return Promise.all([harness(true), harness(false)].map(async (api, i) => {
    const on = i === 0;
    assert.equal(api.label, on ? 'Stop notifying' : 'Notify on changes', 'the row says what pressing it does');
    const after = plain(await api.press());
    assert.equal(after.asked, !on, 'pressing it asks main for the opposite of what is set');
    assert.equal(after.watched, !on, 'and the cached metadata the bell is drawn from follows, rather than waiting for a re-read');
    assert.deepEqual(after.patched, ['tana:text:01examplea0000000000000000'],
      'the row itself is patched: a deferred render would leave the bell as it was, whichever way it was turned');
  }));
}


const checks = [runNotifyToggleCheck, runCurrentNodeStatusCheck, runRestorePlaceCheck, runSearchPillsCheck, runDraftTailCheck,runRailToggleCheck, runCaretOnOpenScrollCheck, runTypingRenderStabilityCheck, runDraftMaterialiseFocusCheck, runDraftBlurOrderCheck, runRecentRowsCheck, runRowChangeAnimationCheck, runFallingRowCheck, runZoomedBlockTitleSaveCheck, runSensitiveBlurCheck, runSelectionChecks, runMultiTaskPaletteCheck, runAssignedDropdown, runEditabilityCheck, runCheckboxCheck, runCheckboxInheritanceCheck, runTaskChildCheckboxScopeCheck, runStalePaletteInvalidationCheck, runReferenceEmbedRenderCheck, runRowAlignmentCheck, runRowAudienceCheck, runHiddenItemsCheck, runMemberLoadCheck, runVisibilityPickerCheck, runLinkPaletteCheck, runAuthPaletteCheck, runSyncShortcutCheck, runReservedComboCheck, runHistoryCheck, runZoomShortcutCheck, runZoomDeleteCheck, runAssigneeCloseCheck, runPendingSplitDraftCheck, runTaskMetaRetryCheck, runPaletteSkipCheck, runFormattingChecks, runSlashMenuCheck, runFilterMenuCloseCheck, runSidebarRowsCheck, runRailPinCheck, runSidebarHoverCheck, runSidebarAlignmentCheck, runClearFiltersCheck, runUnifiedViewsCheck, runSortGroupCheck, runCmdPillsCheck, runSearchesGroupCheck, runSearchPageRowUpdateCheck];
// Red until the checks actually settle: an async check left awaiting something that never resolves empties the event
// loop, and node would exit 0 without a word — a silent pass for a check that never finished.
process.exitCode = 1;
Promise.allSettled(checks.map((check) => Promise.resolve().then(check))).then((results) => {
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map((failure) => failure.message).join('\n'));
  console.log('renderer behavior check passed');
  process.exitCode = 0;
});

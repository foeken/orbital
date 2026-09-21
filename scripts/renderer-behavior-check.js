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
      nodeType: 1, tagName, nodeName: tagName.toUpperCase(), childNodes: [], dataset: {}, style: { setProperty() {} },
      attributes: {}, setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
      classList: { add: (...names) => names.forEach((name) => classes.add(name)), contains: (name) => classes.has(name), toggle() {} },
      get className() { return [...classes].join(' '); },
      set className(value) { classes.clear(); for (const name of String(value).split(' ')) if (name) classes.add(name); },
      // A string appended to a real element becomes a text node, and crumbs and rows append their labels that way:
      // without this the fake element kept the bare string and read as having no text at all.
      append(...kids) { this.childNodes.push(...kids.map((kid) => (typeof kid === 'string' ? textNode(kid) : kid))); },
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
// The caret anchor before a leading mention chip: one definition, sliced rather than restated, since every offset
// helper and the keydown handler count it as nothing.
const ANCHOR_SRC = source.match(/const CARET_ANCHOR = [^\n]*\nconst unanchored = [^\n]*/)[0].replace(/const (\w+) =/g, 'globalThis.$1 ??=');
// What a row shows instead of text — an image, a divider — decides whether it can be edited, expanded or given a
// marker, so the real three go in rather than a restatement of them; a harness with its own keeps its own.
const ATOMIC_SRC = source.match(/const isImage = [^\n]*\nconst isDivider = [^\n]*\nconst isAtomic = [^\n]*/)[0].replace(/const (\w+) =/g, 'globalThis.$1 ??=');
const RENDER_SHIM = 'globalThis.renderSoon ??= (...a) => render(...a); globalThis.patchMeta ??= () => render(); globalThis.iconNode ??= () => null;\n'
  + `globalThis.DEFAULT_HOTKEYS ??= ${DEFAULT_HOTKEYS_SRC}; globalThis.hk ??= () => (typeof hotkeys === 'object' ? hotkeys : {}); globalThis.hotkeyFor ??= (id) => (Object.hasOwn(hk(), id) ? hk()[id] : DEFAULT_HOTKEYS[id]); globalThis.hotkeyIds ??= () => [...new Set([...Object.keys(DEFAULT_HOTKEYS), ...Object.keys(hk())])]; globalThis.comboOf ??= () => '';\n`;
const withShims = (src) => {
  // Row listeners are bound to both roots the app has (the outline and the fields under the title, which are
  // outlines too). A harness exercises one root, so the binding becomes the plain listener it was.
  src = src.replace(/onRows\('([a-z]+)', /g, "outline.addEventListener('$1', ");
  // a row knows whether it is drawn in a field from the id it is addressed with (renderer/nodes.js)
  if (/\binField\(/.test(src) && !/const inField =/.test(src)) src = sourceLine('const inField') + '\n' + src;
  // the rows a row lives among: its own container's, which in a harness with one container is texts()
  if (/\browsBeside\(/.test(src) && !/const rowsBeside =/.test(src)) src = 'globalThis.rowsBeside ??= (el) => texts();\n' + src;
  // the fields container, for the helpers that paint or leave a selection in both places rows live
  if (/\$\('fields'\)/.test(src) && !/const \$ =/.test(src)) src = "globalThis.$ ??= () => ({ contains: () => false, querySelectorAll: () => [], hidden: true });\n" + src;
  // finding a row: in a harness there is one place rows are drawn, so the family answers for the outline alone
  if (/\binRows\(/.test(src) && !/const inRows =/.test(src)) src = 'globalThis.inRows ??= (el) => !!el && outline.contains(el);\n' + src;
  if (/\beachRow\(/.test(src) && !/const eachRow =/.test(src)) src = "globalThis.eachRow ??= (selector) => [...outline.querySelectorAll(selector)];\n" + src;
  if (/\bqueryRow\(/.test(src) && !/const queryRow =/.test(src)) src = 'globalThis.queryRow ??= (selector) => outline.querySelector(selector);\n' + src;
  // a document's outlines: its page and its fields, which in a harness with no fields is whatever kids holds for it
  if (/\boutlinesOf\(/.test(src) && !/const outlinesOf =/.test(src)) src = 'globalThis.outlinesOf ??= (docId) => (kids.has(docId) ? [docId] : []);\n' + src;
  if (/\bfuzzyMatch\b/.test(src) && !/function fuzzyMatch\(/.test(src)) src = functionSource('fuzzyMatch') + '\n' + src; // the real matcher: a harness that lists palette rows filters through it
  if (/\bchipOnly\(/.test(src) && !/const chipOnly =/.test(src)) src = 'globalThis.chipOnly ??= (el) => { const kids = [...(el.childNodes || [])].filter((n) => n.nodeType !== 3 || unanchored(n.data)); return kids.length === 1 && kids[0].nodeType === 1 && !!kids[0].classList?.contains(\'mention\'); };\n' + src; // a harness that renders rows marks the chip-only ones too (the real one is asserted in runSelectionChecks)
  // where a row's grey facts sit is decided from real layout, which no fake DOM has; the harnesses that test it
  // slice the real function in themselves, and the rest are only calling it because render() does
  if (/\bfitRowMeta\(/.test(src) && !/function fitRowMeta\(/.test(src)) src = 'globalThis.fitRowMeta ??= () => {};\n' + src;
  // "this page has pills" (renderer/pills.js), which a folded row no longer answers for: a harness that is not about
  // folding gets the page it always had, so the calls guarded by it still run.
  if (/\bpillsDrawn\b/.test(src) && !/let pillsDrawn =/.test(src)) src = 'globalThis.pillsDrawn ??= true;\n' + src;
  // the glyphs types were given (renderer/nodes.js): a harness that is not about type icons draws every task with its box
  if (/\btypeGlyphs\b/.test(src) && !/const typeGlyphs =/.test(src)) src = 'globalThis.typeGlyphs ??= new Map();\n' + src;
  // what has a page of its own (renderer/nodes.js): a harness that is not about members or types keeps every document zoomable
  if (/\bzoomable\(/.test(src) && !/const zoomable =/.test(src)) src = 'globalThis.zoomable ??= (node) => !!node;\n' + src;
  // a related answer draws the page's fields and sidebar at once when a render would wait (renderer/rail.js loadRelated): a harness with no page has nothing to draw
  if (/\bloadRelated\b/.test(src) && !/let zoom\b/.test(src) && !/const zoom\b/.test(src)) src = 'globalThis.zoom ??= null;\n' + src;
  // Deleted nodes (renderer/nodes.js) are one Set the whole app shares. A harness that is not about deletion gets
  // "nothing is gone", with markGone still answering main's own mark, so rows and chips draw as they always did;
  // the real helpers are sliced in by runDeletedNodeCheck.
  if (/\bdeletedIds\b/.test(src) && !/const deletedIds =/.test(src)) src = 'globalThis.deletedIds ??= new Set();\n' + src;
  // the just-completed ids (renderer/state.js) and the flourish a render plays for them (render.js playTicks): a
  // harness that is not about that sees none and plays nothing
  if (/\bjustDone\b/.test(src) && !/const justDone =/.test(src)) src = 'globalThis.justDone ??= new Map();\n' + src;
  if (/\bplayTicks\(/.test(src) && !/function playTicks\(/.test(src)) src = 'globalThis.playTicks ??= () => {};\n' + src;
  if (/\b(isGone|markGone|noteGone)\(/.test(src) && !/const isGone =/.test(src)) src = 'globalThis.isGone ??= () => false; globalThis.markGone ??= (_uri, deleted) => !!deleted; globalThis.noteGone ??= () => false;\n' + src;
  if (/\bunanchored\(/.test(src) && !/const unanchored =/.test(src)) src = ANCHOR_SRC + '\n' + src; // the real helper, not a restatement of it
  if (/\bisAtomic\(/.test(src) && !/const isAtomic =/.test(src)) src = ATOMIC_SRC + '\n' + src;
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
  // Same for the set of nodes assigned to the local Codex agent: a slice that renders a row reads it to decide on the
  // badge, and a slice that declares its own is left alone.
  if (/\bcodexIds\b/.test(src) && !/(const|let) codexIds/.test(src)) src = 'globalThis.codexIds ??= new Set();\n' + src;
  // The badge reads the linked task's state; a slice that only renders a row gets the real labels and the shipped
  // fallback, which is pending — the state an assigned node has until its Codex task registers itself.
  if (/\bagentStateOf\b|\bAGENT_BADGE\b/.test(src) && !/const agentStateOf =/.test(src)) src = "globalThis.agentStates ??= new Map(); globalThis.agentTaskHosts ??= new Map(); globalThis.agentHosts ??= []; globalThis.agentHost ??= 'local'; globalThis.loadAgentStates ??= () => {}; globalThis.openAgentPrompt ??= () => {}; globalThis.nodeRank ??= () => 0; globalThis.AGENT_BADGE ??= { pending: { label: 'Agent pending', title: 'Assignment requested; no Codex task yet' } }; globalThis.agentStateOf ??= () => 'pending';\n" + src;
  if (/\bagentModels?\b/.test(src) && !/(const|let) agentModels/.test(src)) src = "globalThis.agentModels ??= []; globalThis.agentModel ??= '';\n" + src; // the page's model list: empty means Codex default alone
  // And for the sections a page has folded away: state.js reads them from localStorage at load, so a slice that only
  // groups rows gets an empty set rather than failing for want of the declaration.
  if (/\bcollapsedGroups\b/.test(src) && !/(const|let) collapsedGroups/.test(src)) src = 'globalThis.collapsedGroups ??= new Set();\n' + src;
  // The palette swaps its field for the agent prompt editor; a slice that only opens or closes a level does not care.
  if (/\bpromptEditor\b/.test(src) && !/function promptEditor\(/.test(src)) src = 'globalThis.promptEditor ??= () => {};\n' + src;
  // Anything that asks the backend checks the connection first: a launch draws the page it is reopening before the
  // sync client exists (renderer/edit.js). A slice that is not about that gets a connected app.
  if (/\bconnected\b/.test(src) && !/\bconnected =/.test(src)) src = 'globalThis.connected ??= true;\n' + src;
  // The row behind a document id, which rememberPlace reads for the title and glyph it stores. A slice that cares
  // about either declares its own; the rest are only storing a place.
  if (/\bdocOf\(/.test(src) && !/const docOf =/.test(src)) src = 'globalThis.docOf ??= () => null;\n' + src;
  // The Home anchor (renderer/nodes.js): the palette's Go back row reads it, Set as Home offers itself from it, and
  // navigate lands on it. A slice that is not about Home gets the shipped default — the Library, and you are on it —
  // so nothing it asserts depends on a choice it never made; the Home harness slices the real ones instead.
  if (/\b(atHome|homeId|homeTarget|homeName|repairHome|setHome|goHome)\b/.test(src) && !/const homeId =/.test(src)) src = "globalThis.atHome ??= () => true; globalThis.homeId ??= () => 'library'; globalThis.homeName ??= () => 'Library'; globalThis.homeTarget ??= () => null; globalThis.repairHome ??= () => {}; globalThis.setHome ??= () => {}; globalThis.goHome ??= () => {};\n" + src;
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
// One declaration, by its opening words: for the small shared rules a harness needs the real version of.
function sourceLine(declaration) {
  const found = source.match(new RegExp('^' + declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*$', 'm'));
  assert.ok(found, declaration + ' is present');
  return withShims(found[0]);
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
  { // a task wears its type's glyph, the way a typed document does; Later's own glyph still says what it is doing
    const line = (name) => { const m = source.match(new RegExp('^const ' + name + ' = .*$', 'm')); assert.ok(m, 'renderer const ' + name + ' is present'); return m[0]; };
    const iconOf = vm.runInNewContext(`
      const typeGlyphs = new Map([['tana:type:t1', 'rocket']]);
      ${line('isTask')}
      ${line('iconOf')}
      iconOf;
    `);
    const task = (extra) => ({ kind: 'document', icon: 'task', tags: [{ label: 'task' }, { label: 'Discussion Task', uri: 'tana:type:t1' }], ...extra });
    assert.equal(iconOf(task({})), 'rocket', 'a typed task draws its type\'s glyph');
    assert.equal(iconOf(task({ tags: [{ label: 'task' }] })), 'task', 'an untyped task keeps its box');
    assert.equal(iconOf(task({ tags: [{ label: 'task' }, { label: 'Project', uri: 'tana:type:none' }] })), 'task', 'a type without a glyph changes nothing');
    assert.equal(iconOf(task({ stateType: 'not_now' })), 'later', 'Later wins over the type glyph');
    assert.equal(iconOf({ kind: 'document', icon: 'doc', tags: [{ label: 'x', uri: 'tana:type:t1' }] }), 'doc', 'only tasks are decided here; a document already carries the glyph from main');
  }
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

  // And the choice outlives the session: state.js reads it at load and the toggle writes it back, in localStorage
  // rather than in the preferences that follow you between machines.
  const restart = (stored) => vm.runInNewContext(`
    const store = ${JSON.stringify(stored)};
    const localStorage = { getItem: (key) => (key in store ? store[key] : null), setItem: (key, value) => { store[key] = String(value); } };
    ${sourceBetween('let sensitiveIds = null', '\n')}
    const refreshSensitive = () => {}, renderSensitiveBtn = () => {};
    ${functionSource('toggleSensitiveVisibility')}
    ({ shown: () => sensitiveVisible, toggle: () => { toggleSensitiveVisibility(); return { ...store }; } })
  `);
  assert.equal(plain(restart({}).shown()), false, 'a machine that was never told starts blurred, as it always did');
  assert.deepEqual(plain(restart({}).toggle()), { sensitiveVisible: '1' }, 'showing them is written down');
  assert.equal(plain(restart({ sensitiveVisible: '1' }).shown()), true, 'so the next launch opens with them shown');
  assert.deepEqual(plain(restart({ sensitiveVisible: '1' }).toggle()), { sensitiveVisible: '0' }, 'and hiding them again is written down too');
  assert.equal(plain(restart({ sensitiveVisible: '0' }).shown()), false, 'which the launch after that honours');

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
    ${sourceBetween("onRows('click'", "filterEl.addEventListener('input'")}
    ${sourceBetween("onRows('mousedown'", "onRows('focusin'")}
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
      let sel = null, caret, rendered = 0, selectionFrozen = false, renderDeferred = false, error = null, lastEnter = null;
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
      const hasKids = (item) => !!(childrenOf(item) || []).length;
      ${functionSource('closeIfEmpty')}
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
  // Enter on one selected row starts editing it, the way a second click on it does. placeCaret is called without an
  // offset, which is its "end of the row" case, so the caret lands after the text rather than in front of it.
  const enterKey = { key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false };
  const enter = makeHarness();
  enter.set({ keys: ['b'], anchor: 'b', focus: 'b' });
  assert.equal(enter.selKey(enterKey), true, 'Enter on one selected row is the selection to answer');
  assert.deepEqual(plain(enter.state().sel), null, 'it lets the selection go');
  assert.equal(plain(enter.state().caret), 'b', 'and puts the caret in that row, at its end');
  const enterMany = makeHarness();
  enterMany.set({ anchor: 'b', focus: 'c' });
  assert.equal(enterMany.selKey(enterKey), false, 'with more than one row selected there is no one row to edit, so Enter is left alone');
  const enterReadOnly = makeHarness(true);
  enterReadOnly.set({ keys: ['b'], anchor: 'b', focus: 'b' });
  assert.equal(enterReadOnly.selKey(enterKey), false, 'and a row with nothing to edit is left alone too');
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
      todayNode: async (offset = 0) => { calls.push(['todayNode', offset]); return offset ? 'next-day' : 'day'; }, weekNode: async () => { calls.push(['weekNode']); return 'week'; },
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
      addTo: async (keys, target) => { calls.length = 0; selected = keys; await selectionRows().find((row) => row.id === { today: 'addToday', tomorrow: 'addTomorrow', week: 'addWeek' }[target]).run(); return calls; },
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
    ['Selection', 'Add 4 items to Tomorrow'],
    ['Selection', 'Add 4 items to This Week'],
    ['Selection', 'Mark 4 items as sensitive'],
    ['Selection', 'Delete 3 items'],
  ], 'a selection offers sensitivity for everything in it and the task actions for the tasks in it');
  assert.deepEqual(plain(context.selection(['t2'])), [['Selection', 'Set status'], ['Selection', 'Edit assignees'], ['Selection', 'Assign to …'], ['Selection', 'Add 1 item to Today'], ['Selection', 'Add 1 item to Tomorrow'], ['Selection', 'Add 1 item to This Week'], ['Selection', 'Unmark 1 item as sensitive'], ['Selection', 'Delete 1 item']],
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
    ['Current node', 'Add to Tomorrow', '', false],
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
  assert.deepEqual(plain(context.selection(['t1', 't2'])).map((row) => row[0]), Array(7).fill('Selection'), 'a real selection keeps its own heading');
  assert.deepEqual(plain(context.markAll()), [['t1', 'meeting', 'locked', 't2'], true], 'marking applies to every selected document at once');
  // Adding to the day's or the week's node references the selection there: one appended block per row, its text
  // replaced by a mention of that node, so nothing is copied and nothing is moved.
  assert.deepEqual(plain(await context.addTo(['t1', 'meeting'], 'today')), [
    ['todayNode', 0],
    ['insertAfter', 'day', null, ''], ['setText', 'day', 'block', JSON.stringify([{ mention: { uri: 't1', label: '' } }])],
    ['insertAfter', 'day', null, ''], ['setText', 'day', 'block', JSON.stringify([{ mention: { uri: 'meeting', label: '' } }])],
    ['note', 'Added 2 items to Today'],
  ], 'every selected row becomes a mention at the end of today\'s node');
  assert.deepEqual(plain(await context.addTo(['t1'], 'tomorrow')), [
    ['todayNode', 1],
    ['insertAfter', 'next-day', null, ''], ['setText', 'next-day', 'block', JSON.stringify([{ mention: { uri: 't1', label: '' } }])],
    ['note', 'Added 1 item to Tomorrow'],
  ], 'and Tomorrow asks for the next day\'s node instead, with the same mention');
  assert.deepEqual(plain(await context.addTo(['t1'], 'week')).map((call) => call[0]), ['weekNode', 'insertAfter', 'setText', 'note'], 'and the week row writes into the week node instead');
  // Cmd+Shift+K records a hotkey per row id and refuses a row without one, so every selection action carries a
  // stable id even though its label counts the selection.
  const selIds = plain(context.ids(['t1', 'meeting', 'locked', 't2']));
  assert.deepEqual(selIds, ['status', 'assign', 'addToday', 'addTomorrow', 'addWeek', 'sensitive', 'delete'], 'every selection action can be given a keyboard shortcut');
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

  const start = source.indexOf("onRows('keydown', (e) => {");
  const end = source.indexOf("onRows('input'", start);
  assert.notEqual(start, -1, 'outline editing keyboard handler is present');
  const runKey = (editable, key = 'Enter', reference = false, meta = false) => {
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
    const event = { key, metaKey: meta, ctrlKey: false, shiftKey: false, target: { closest: () => ({ textContent: 'Row' }) }, preventDefault: () => { context.prevented = true; } };
    context.listener(event);
    return { ...context.state(), prevented: !!context.prevented };
  };
  assert.equal(runKey(false).mutation, 0, 'read-only member keyboard input cannot create or mutate a node');
  assert.equal(runKey(true).mutation, 1, 'editable document keyboard input still uses the editor');
  // A focused read-only row cannot be typed into, so Space is free to zoom into it; a reference opens its target.
  assert.deepEqual(plain(runKey(false, ' ')), { mutation: 0, zoomed: 1, opened: 0, prevented: true }, 'Space on a focused read-only row zooms into it');
  assert.deepEqual(plain(runKey(false, ' ', true)), { mutation: 0, zoomed: 0, opened: 1, prevented: true }, 'Space on a focused reference opens what it points at');
  assert.deepEqual(plain(runKey(true, ' ')).zoomed, 0, 'and an editable row keeps Space for typing');
  // A read-only row swallowed every ⌘ combo but ⌘K and ⌘S, so ⌘F (and ⌘Z, ⌘C, ⌘[) did nothing while the caret sat
  // on one and started working again after a click elsewhere. The shortcuts are the document handler's to run.
  assert.equal(runKey(false, 'f', false, true).prevented, false, '⌘F on a read-only row reaches the document handler');
  assert.equal(runKey(false, 'z', false, true).prevented, false, 'and so does every other ⌘ combo');
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
  const draftNode = vm.runInNewContext(source.match(/const siblingBlock = .*;/)[0] + '\n' + functionSource('draftNode') + '; draftNode');
  const makeHarness = (asChild) => vm.runInNewContext(`
    const asChild = ${JSON.stringify(asChild)};
    const calls = [];
    const node = { id: 'checkbox', kind: 'block', text: 'Checkbox', done: 1, children: ${asChild ? "[{ id: 'existing', kind: 'block', text: 'Existing' }]" : '[]'} };
    const nodes = [node];
    const item = { key: 'doc/checkbox', docId: 'doc', node, parent: {} };
    const kids = new Map([['doc', nodes]]), open = new Map(), items = new Map();
    const textEl = () => null;
    const canEditItem = () => true;
    const locate = ${functionSource('locate')};
    const readSegs = () => [{ text: 'Checkbox' }], splitSegs = (segs) => [segs, []], plainOf = (segs) => segs.map((s) => s.text || '').join('');
    const segsOf = (value) => [{ text: value.text }], saveValue = (value) => value;
    const hasKids = () => ${asChild}, isOpen = () => ${asChild};
    ${source.match(/const siblingBlock = .*/)[0]}
    const dropPending = () => {}, reload = async () => {}, render = () => {}, placeCaret = () => {};
    const run = async (fn) => fn();
    let seq = 0;
    const tana = {
      setText: async () => { calls.push('setText'); },
      split: async (_docId, _id, _before, _after, asChild) => {
        const child = { id: 'new' + (++seq), kind: 'block', text: '', done: 0 };
        if (asChild) node.children.push(child); else nodes.push(child);
        calls.push(asChild ? 'split:child' : 'split:sibling');
        return child.id;
      },
    };
    ${inheritCheckbox}
    ${splitNode}
    ({ split: () => splitNode(item, {}, 'Checkbox'.length), state: () => ({ calls, child: asChild ? node.children.at(-1) : nodes.at(-1) }) });
  `);
  const after = makeHarness(false);
  await after.split();
  assert.deepEqual(plain(after.state()), {
    calls: ['split:sibling'], child: { id: 'new1', kind: 'block', text: '', done: 0 },
  }, 'Enter after a checkbox keeps the new sibling as an unchecked native checkbox');
  const under = makeHarness(true);
  await under.split();
  assert.deepEqual(plain(under.state()), {
    calls: ['split:child'], child: { id: 'new1', kind: 'block', text: '', done: 0 },
  }, 'Enter under a checkbox converts the new child to an unchecked native checkbox');
  assert.deepEqual(plain(draftNode({ key: 'doc/checkbox', node: { kind: 'block', done: 1 } })), { id: 'draft:doc/checkbox', text: '', kind: 'block', block: 'bullet', done: 0, draft: true }, 'empty checkbox draft is unchecked and local-only until input materialises it, and is drawn in the default mode');
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
    const searchId = 'tana:search:01j0search000000000000000';
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
    let searches = [{ id: searchId, title: 'saved' }, { id: keptId, title: 'beta' }];
    let zoom = { docId: keptId };
    const taskMetaById = new Map(), kids = new Map(), extra = new Map(), paths = new Map(), fresh = new Map();
    const loadRoots = async () => {};
    const reload = async () => {};
    const loadPins = async () => { pinInfo = null; };
    const loadView = () => {};
    const render = () => {};
    const renderSoon = () => {};
    const isTask = (node) => node.kind === 'document' && node.icon === 'task', relatedBy = new Map(), railGroups = () => [];
    const refreshed = [], refreshRelated = (id) => refreshed.push(id); // the sidebar is re-read, not dropped
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
      edit: (id) => listener(id, { meta: false }),
      refreshed: () => refreshed,
      removed: (id) => removeListener(id),
      unpinned: (id) => unpinListener(id),
      searchIds: () => searches.map((s) => s.id),
      state: () => ({ recent: recent().map((node) => node.id), zoom: zoom && zoom.docId }),
    });
  `, context);
  context.update('tana:text:01j0keep00000000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state()), {
    recent: ['tana:text:01j0stale0000000000000000', 'tana:text:01j0keep00000000000000000'],
    zoom: 'tana:text:01j0keep00000000000000000',
  }, 'an ordinary string update retains Cmd+K pins, recently viewed rows, and zoom state');

  // The sidebar is a page's relations, not its text: typing in a document changes none of its sections, and dropping
  // the payload for every keystroke is what made the whole rail blank and come back while a row was being added.
  assert.deepEqual(plain(context.refreshed()), ['tana:text:01j0keep00000000000000000'],
    'a change main could not say was text-only re-reads the sidebar');
  context.edit('tana:text:01j0keep00000000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.refreshed()), ['tana:text:01j0keep00000000000000000'],
    'an ordinary edit leaves the sidebar exactly as it is: no re-read, nothing to blank');

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

  context.removed('tana:search:01j0search000000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.searchIds()), ['tana:text:01j0keep00000000000000000'], 'a deleted saved search leaves the Cmd+K Searches group');
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
    const setOpen = () => {}, blurSensitive = () => {}, isSpace = () => false, draftNode = () => ({ id: 'draft', kind: 'block', draft: true });
    const kids = new Map();
    let loaded = null, opened = null;
    const ensureLoaded = (item) => { loaded = item.docId; };
    const zoomTo = () => { opened = 'zoomed the block'; };
    const openReference = (node) => { opened = 'opened ' + node.reference.uri; };
    // the real ones: what a row shows below it, and whether it is open, is the whole point of the reference case
    ${sourceBetween('const childrenOf =', 'const canInsertChild =')}
    ${sourceBetween('const childEl =', '\n')}
    const rendered = new Map();
    const renderSegs = (el, segs) => { rendered.set(el, segs); }, segsOf = (node) => node.segments || (node.text ? [{ text: node.text }] : []);
    const isDivider = () => false;
    ${sourceBetween('// Block types (api.setBlockType)', 'const images = new Map()')}
    const asDoc = (node) => ({ ...node, kind: 'document', text: node.text ?? node.title ?? '' });
    const isImage = () => false, taskSummary = () => null, chipEl = () => ({}), iconSvg = () => '';
    const documentSummary = () => null, observeMeta = () => {};
    const displayOn = (what) => what === 'status'; // the box a task row draws; tags and the grey facts are other harnesses
    const tana = {};
    let toggled = null;
    const toggleReference = (node) => { toggled = 'reference:' + node.reference.uri; };
    const toggleDone = () => { toggled = 'own task'; }, toggleCheckbox = () => { toggled = 'own checkbox'; };
    const document = { createElement: (tagName) => {
      const classes = new Set();
      return { tagName, children: [], dataset: {}, classes, style: { setProperty() {} }, classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      }, append(...children) { this.children.push(...children); } };
    } };
    ${referenceDisplay}
    ${presentation}
    ${canExpand}
    ${functionSource('nodeEl')}
    const parentItem = { node: { kind: 'document', editable: true } };
    const built = (node, scene = {}) => {
      kids.clear(); open.clear(); items.clear(); loaded = null; opened = null;
      if (scene.kids) kids.set(scene.kids[0], scene.kids[1]);
      if (scene.open) open.set('tana:doc:01j0container000000000000/' + node.id, true);
      const el = nodeEl(node, 'tana:doc:01j0container000000000000', parentItem);
      const line = el.children[0], text = line.children.at(-1).children[0], wrap = el.children[1];
      const check = line.children.find((kid) => kid.tagName === 'input');
      return { className: el.className, editable: text.contentEditable === 'plaintext-only', rendered: rendered.get(text),
        checked: check ? !!check.checked : null, disabled: check ? !!check.disabled : null, toggles: check && check.onclick ? (check.onclick(), toggled) : null,
        selectsOnClick: typeof line.onmousedown === 'function', bullet: (line.children[1].onclick(), opened), loadedFrom: loaded,
        bulletIcon: [...line.children[1].classes].find((name) => name !== 'icon' && name !== 'hue') || null,
        kidKeys: wrap ? wrap.children.map((kid) => kid.dataset.key) : null };
    };
    ({ embed: (targetEditable) => {
      const embedded = {
        id: 'block-identity', kind: 'block', type: 'reference', editable: false,
        text: 'native embed text', segments: [{ text: 'native embed text' }],
        reference: { uri: 'tana:text:01j0target000000000000000', label: 'Fallback label', node: { id: 'tana:text:01j0target000000000000000', text: 'Resolved target', kind: 'document', editable: targetEditable } },
      };
      const el = nodeEl(embedded, 'tana:doc:01j0container000000000000', { node: { kind: 'document', editable: true } });
      const text = el.children[0].children.at(-1).children[0];
      return { key: el.dataset.key, editable: text.contentEditable === 'plaintext-only', rendered: rendered.get(text) };
    }, built });
  `);
  assert.deepEqual(plain(api.embed(true)), {
    key: 'tana:doc:01j0container000000000000/block-identity',
    editable: true,
    rendered: [{ text: 'Resolved target' }],
  }, 'a resolved reference embed displays its target and edits that target, keeping the original block identity');
  assert.deepEqual(plain(api.embed(false)), {
    key: 'tana:doc:01j0container000000000000/block-identity',
    editable: false,
    rendered: [{ text: 'Resolved target' }],
  }, 'a reference to a read-only target stays read-only');

  // A line whose whole content is one mention is Tana's full-reference presentation: the row is the task it points
  // at, box and all, while the block keeps its own identity and its editable text.
  const TARGET = { id: 'tana:text:01j0task00000000000000000', text: 'Ship the thing', kind: 'document', icon: 'task', done: 0, stateType: 'open', editable: true };
  const mention = { mention: { label: 'Stale label', uri: TARGET.id } };
  const line = (segments, resolved = true) => ({ id: 'n1', kind: 'block', block: 'bullet', text: segments.map((s) => s.text ?? s.mention.label).join(''), segments,
    reference: { uri: TARGET.id, label: 'Stale label', ...(resolved ? { node: TARGET } : {}) } });

  const full = plain(api.built(line([mention])));
  assert.ok(full.className.includes('fullref'), 'the row says it stands in for the node it points at, so the selection can be drawn around all of it');
  assert.deepEqual(full.rendered, [{ mention: { uri: TARGET.id, label: 'Ship the thing' } }], 'and reads its label from the target, so a rename in Tana shows through');
  assert.deepEqual([full.checked, full.disabled, full.toggles], [false, false, 'reference:' + TARGET.id], 'its box is the target task\'s, so the task can be checked off from the line referencing it');
  assert.equal(full.editable, true, 'the text stays editable: typing beside the chip is what turns the row back into an ordinary line');

  const beside = plain(api.built(line([mention, { text: ' by Friday' }])));
  assert.ok(!beside.className.includes('fullref'), 'text beside the reference makes it an ordinary line with a link again');
  assert.deepEqual([beside.rendered, beside.checked], [[mention, { text: ' by Friday' }], null], 'which shows the stored segments and no box of its own');

  const unresolved = plain(api.built(line([mention], false)));
  assert.ok(!unresolved.className.includes('fullref'), 'a reference whose target could not be read stays the plain chip it was');
  assert.deepEqual(unresolved.rendered, [mention], 'with the label the block stored');
  assert.deepEqual([unresolved.className.includes('gone'), unresolved.bulletIcon], [false, null],
    'and it is not crossed out: unreadable is not deleted, and the target may well still be there');

  // A reference to something that has been deleted. Main marks it (main/documents.js resolveReferences) or a refused
  // read did, and the row keeps the label it was written with — struck through, behind a trash bullet — instead of
  // reading as a live link to a page that answers nothing.
  const deletedRow = plain(api.built({ ...line([mention], false), reference: { uri: TARGET.id, label: 'Stale label', deleted: true } }));
  assert.ok(deletedRow.className.includes('gone'), 'a deleted target makes the row say so, which is what strikes its text through');
  assert.equal(deletedRow.bulletIcon, 'trash', 'and its bullet is the trash glyph rather than the kind it used to be');
  assert.ok(!deletedRow.className.includes('fullref'), 'it cannot stand in for a node that is not there any more');
  assert.deepEqual([deletedRow.checked, deletedRow.bullet], [null, 'zoomed the block'],
    'there is no box to tick, and the bullet zooms into the block that holds the dead reference rather than following it anywhere');
  // The row may still be holding the copy of the target it was resolved with, from before the deletion. Drawing that
  // copy put the node's own glyph on the line beside the trash on the chip, as though it were both there and not.
  const staleRow = plain(api.built({ ...line([mention]), reference: { uri: TARGET.id, label: 'Stale label', node: TARGET, deleted: true } }));
  assert.ok(staleRow.className.includes('gone'), 'knowing it is gone beats the copy the row was drawn with');
  assert.equal(staleRow.bulletIcon, 'trash', 'so the line carries the trash, not the glyph of the node that is no longer there');
  assert.deepEqual([staleRow.checked, staleRow.className.includes('fullref')], [null, false], 'and it neither stands in for that node nor offers its box');

  assert.deepEqual([full.selectsOnClick, full.bullet], [true, 'opened ' + TARGET.id],
    'clicking the row selects it instead of following a link out of it, and its bullet is the way into the node');
  assert.deepEqual([beside.selectsOnClick, beside.bullet], [false, 'zoomed the block'],
    'while an ordinary line with a link keeps the plain caret click and zooms into itself');

  // A row with an outline of its own is never a full reference, because expanding one opens the outline of the node
  // it points at, which would leave the block's own with nowhere to go.
  const parentRow = plain(api.built({ ...line([mention]), hasChildren: true, children: [{ id: 'own', kind: 'block', text: 'a child of the block itself' }] }));
  assert.ok(!parentRow.className.includes('fullref'), 'a block that already has children stays an ordinary line with a link');
  assert.deepEqual(parentRow.rendered, [mention], 'and shows the chip it stores');

  const closed = plain(api.built(line([mention])));
  assert.deepEqual([closed.kidKeys, closed.loadedFrom], [null, null], 'a full reference starts closed and reads nothing until it is opened');
  const alreadyLoaded = plain(api.built(line([mention]), { kids: [TARGET.id, [{ id: 'kid1', kind: 'block', text: 'a step of the task' }]] }));
  assert.deepEqual([alreadyLoaded.kidKeys, alreadyLoaded.loadedFrom], [null, null],
    'and stays closed even when that document is already loaded, so a pasted reference arrives collapsed rather than opened by the block default');
  const loading = plain(api.built(line([mention]), { open: true }));
  assert.deepEqual([loading.kidKeys, loading.loadedFrom], [[], TARGET.id], 'opening it loads the target document, not the one the block lives in');
  const withKids = plain(api.built(line([mention]), { open: true, kids: [TARGET.id, [{ id: 'kid1', kind: 'block', text: 'a step of the task' }]] }));
  assert.deepEqual([withKids.kidKeys, withKids.loadedFrom], [[TARGET.id + '/kid1'], null],
    'and the rows below it are the target\'s own blocks, so editing one edits that document');

  assert.match(source, /mention && !mention\.closest\('\.fullref'\)/, 'a chip on such a row does not navigate: the row itself answers the click');
  assert.match(source, /if \(selKeys\(\)\.includes\(item\.key\) && canEditText\(item\)\) \{ if \(fullref\) \{ e\.preventDefault\(\); setCaret\(text, text\.textContent\.length\); \} return; \}/,
    'and a click on the row once it is selected starts editing it, caret at the end, since its text is one chip with nothing to click into');

  const styles = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
  assert.match(styles, /\.node\.fullref :is\(\.text, \.fvalue\) \.mention \{[^}]*color: inherit[^}]*text-decoration: none/,
    'and the row that is the node reads as a title: the blue underlined link is for a reference sitting among text');
  assert.match(styles, /\.node\.fullref > \.children \{[^}]*border-left-style: dashed/,
    'what hangs under it is another document, so its guide line is dashed');
  assert.doesNotMatch(styles, /\.node\.fullref > \.children \{[^}]*linear-gradient/,
    'and it is the border itself, not a background column, which renders a pixel wider and lighter than every other guide');
  assert.match(styles, /\.node\.fullref > \.line:focus-within/,
    'and the ring follows the caret on the reference itself, not one in the rows it opened');
  assert.doesNotMatch(styles, /\.node\.fullref:focus-within/,
    'which is what :focus-within on the row would have got wrong');
  assert.match(styles, /\.node\.gone > \.line \.text \{[^}]*text-decoration: line-through/,
    'a row whose reference is gone reads as gone: its text is struck through');
  assert.match(styles, /\.node\.gone > \.line :is\(\.text, \.fvalue\) \.mention\.gone svg \{[^}]*display: none/,
    'and it shows one trash glyph — the bullet — rather than a second one on the chip that is the whole of its text');

  // A task put off is drawn asleep. It is still a task — same box, same status — so only the glyph changes.
  const task = (stateType) => plain(api.built({ id: 'tana:text:01j0task00000000000000000', kind: 'document', icon: 'task', stateType, text: 'a task', editable: true }));
  assert.deepEqual([task('not_now').bulletIcon, task('not_now').checked], ['later', false],
    'a Later task is drawn with the zzz glyph instead of the task one, and keeps its box');
  assert.deepEqual([task('open').bulletIcon, task('proposed').bulletIcon, task('closed').bulletIcon], ['task', 'task', 'task'],
    'while every other state keeps the task glyph');
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
  assert.deepEqual(plain(await folded.rows('s')), ['Sync', 'Search Tana', 'Smaller text', 'Hide sidebar', 'Reset text size', 'Set status', 'Filter rows by text'],
    'one letter: the first level only, the groups whose best row starts with it first (the shortest such row leading), a letter inside a word last');
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
    const views = [{ id: 'library', title: 'Library', icon: 'library', nodes: [] }, { id: 'inbox', title: 'Inbox', icon: 'inbox', nodes: [] }], pinTree = [], pinRows = () => [];
    // the Library page, so Set as Home is offered: the real helpers decide whether it is already Home
    let home = 'library', searches = [], view = 'library';
    const searchesLoaded = true, localStorage = { setItem() {} }, onSearchPage = () => false;
    const selectionRows = () => [{ id: 'delete', group: 'Current node', label: 'Delete' }, { id: 'sensitive', group: 'Current node', label: 'Mark as sensitive' }, { id: 'zoomIn', group: 'Current node', label: 'Zoom in' }, { id: 'status', group: 'Current node', label: 'Set status' }];
    const pillCommandRows = () => [{ id: 'pill:type', group: 'View options', label: 'Filter by type' }], taskActionRows = () => [];
    const tana = { refresh: async () => {}, todayNode: async () => {}, weekNode: async () => {}, nodeLink: async () => {}, accessOptions: async () => {}, filters: {}, sensitiveIds: () => {}, creationOptions: async () => {}, discussWith: async () => {} }, run = () => {};
    const openDiscussPalette = () => {};
    const authed = true, authChecking = false, signedOut = true, theme = 'light', hotkeys = {}, themePref = 'light';
    const palDoc = { id: 'tana:text:01j0doc000000000000000000' }, pinInfo = { docId: palDoc.id, sidebar: false, dates: [] };
    const accessById = new Map([[palDoc.id, { sharing: true, move: true, ownerUri: 'tana:space:01j0space00000000000000000' }]]), loadAccess = () => {}, isRealId = () => true;
    const localDate = (offset = 0) => (offset ? '2026-09-14' : '2026-09-13'), setTheme = () => {}, docRow = () => ({}), sectionOf = () => null;
    const palette = { hidden: false }, palMode = 'cmd', renderPalette = () => {}, showError = () => {};
    const zoom = null, railEl = { hidden: false }, navBack = [], navForward = [], sensitiveVisible = false;
    const railToggle = { hidden: false }, railHidden = false; // sidebar visible here, so both the focus row and the toggle row are built
    const went = []; // Go to Home runs the real goHome, so where it sends you is observable here
    const pinCalls = []; // what a date-pin row asks of api.pin/api.unpin: the op, the target and the day
    const openCreationPalette = () => {}, openHiddenPalette = () => {}, toggleSensitiveVisibility = () => {}, followSystem = () => {}, openVisibilityPalette = () => {}, openMovePalette = () => {}, pinAction = (...args) => pinCalls.push(args), copyText = () => {}, togglePalette = () => {}, navigate = () => {}, history = () => {}, focusRail = () => {}, setZoom = () => {}, goTo = (id) => went.push(id), setView = (id) => went.push('view:' + id), openDoc = () => {}, filterEl = {}, render = () => {}, zoomFactor = 1, BASE_ZOOM = 1;
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    const visibilityRows = () => [], moveTargets = async () => [], previewMoveToSpace = () => {};
    ${functionSource('paletteRows')}
    ({ labels: (q) => paletteRows(q).map((row) => row.group + ': ' + row.label),
       row: (id) => paletteRows('').find((r) => r.id === id),
       datePin: (rank) => { const row = paletteRows('').find((r) => r.rank === rank); pinCalls.length = 0; row.run(); return [row.label, ...pinCalls[0]]; },
       pinnedOn: (dates) => { pinInfo.dates.length = 0; pinInfo.dates.push(...dates); },
       went: () => { const out = [...went]; went.length = 0; return out; },
       choose: (id, list) => { home = id; searches = list || []; } });
  `);
  assert.deepEqual(plain(order.labels('')), [
    'Current node: Zoom in', 'Current node: Set status', 'Current node: Discuss with …', 'Current node: Pin to today', 'Current node: Pin to tomorrow', 'Current node: Move to …', 'Current node: Move to Library',
    'Current node: Edit visibility', 'Current node: Mark as sensitive', 'Current node: Copy link', 'Current node: Delete',
    'Views: Inbox', 'Views: Today', 'Views: This week', 'Views: Library',
    'View options: Filter by type', 'View options: Filter rows by text',
    'Actions: Log in to Tana', 'Actions: Create new…', 'Actions: Search Tana', 'Actions: Go back', 'Actions: Go forward', 'Actions: Go to Home', 'Actions: Focus the sidebar', 'Actions: Hide sidebar', 'Actions: Set as Home',
    'Actions: Undo', 'Actions: Redo', 'Actions: Sync', 'Actions: Reload', 'Actions: Edit hidden items', 'Actions: Toggle sensitive visibility',
    'Actions: Larger text', 'Actions: Smaller text', 'Actions: Reset text size', 'Actions: Toggle dark mode',
  ], 'the palette lists its rows in one fixed, meaningful order');
  // The two date pins differ only in the day they name: today's row passes no date (main defaults to today), the
  // tomorrow row passes the next local day, and each label follows whether that day is already pinned.
  assert.deepEqual(plain(order.datePin('pinToday')), ['Pin to today', 'pin', 'today'], 'Pin to today pins the default day');
  assert.deepEqual(plain(order.datePin('pinTomorrow')), ['Pin to tomorrow', 'pin', 'today', '2026-09-14'], 'Pin to tomorrow pins the next local day');
  order.pinnedOn(['2026-09-14']);
  assert.deepEqual(plain(order.datePin('pinTomorrow')), ['Unpin from tomorrow', 'unpin', 'today', '2026-09-14'], 'and unpins that same day once it is pinned');
  assert.deepEqual(plain(order.datePin('pinToday')), ['Pin to today', 'pin', 'today'], 'while a pin on tomorrow leaves today\'s row offering to pin');
  order.pinnedOn([]);
  // Nothing matched: one row that carries the query into Cmd+S, under the "No results" heading.
  assert.deepEqual(plain(order.labels('zzqq')), ['No results: Search Tana for \u201Czzqq\u201D'],
    'a query nothing matches offers the Tana search with what was typed');
  // Set as Home is honest about the page it is on: on the page that already is Home it stays, saying so and doing
  // nothing, rather than disappearing or pretending to act.
  const SAVED = 'tana:search:01j0myt00000000000000000';
  assert.deepEqual(plain([order.row('setHome').hint, order.row('setHome').disabled]), ['Current', true],
    'the Library offering itself as Home while it already is Home says Current and cannot be run');
  order.choose(SAVED, [{ id: SAVED, text: 'My Tasks' }]);
  assert.deepEqual(plain([order.row('setHome').hint, order.row('setHome').disabled]), ['', false],
    'and once Home is somewhere else the same row is live again');
  // Go to Home is the other half: always listed, honest about where it goes, and disabled only where it would do nothing.
  assert.deepEqual(plain([order.row('goHome').hint, order.row('goHome').disabled]), ['My Tasks', false],
    'Go to Home names the Home it would open, read live from the saved search');
  order.row('goHome').run();
  assert.deepEqual(plain(order.went()), [SAVED], 'and it opens it through the one goHome every route Home uses');
  order.choose('library', []);
  assert.deepEqual(plain([order.row('goHome').hint, order.row('goHome').disabled]), ['Current', true],
    'standing on Home the row stays, disabled and saying so, rather than disappearing from the list it can be recorded from');
  order.choose('tana:search:01j0gone0000000000000000', []);
  assert.deepEqual(plain([order.row('goHome').hint, order.row('goHome').disabled]), ['Current', true],
    'and a Home whose search nothing lists any more is the Library, which is the page this is: it falls back rather than offering a dead target');
  assert.equal(order.row('goHome').id, 'goHome', 'and it keeps its id while disabled, which is what ⇧⌘K records a key against');
  // With a query the best match leads, whichever group it is in: Inbox starts with "in", Zoom in only has it as a word.
  const inRows = plain(order.labels('in'));
  assert.equal(inRows[0], 'Views: Inbox', 'a label that starts with the query comes first');
  assert.ok(inRows.indexOf('Current node: Zoom in') > 0, 'and a later word after it');
  assert.equal(plain(order.labels('mtl'))[0], 'Current node: Move to Library', 'the first letters of the words reach the row');
  // Tied on tier, the shorter label wins across groups: Views' Set status is a shorter word hit for "status" than the
  // Current node's Set status … no — "text": View options' Filter rows by text is longer than Actions' Larger text.
  assert.equal(plain(order.labels('text'))[0], 'Actions: Larger text', 'a shorter label wins a tie on tier, whichever group comes first');

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

  // A row that is only a mention chip — Tana's full-reference presentation. Chromium will not delete the chip, so
  // the row is marked .chiponly (its focus is drawn around it) and Backspace or Delete removes the row, like an
  // image. The caret anchor renderSegs puts before a leading chip is a placeholder, not text beside it.
  const chip = vm.runInNewContext(`${sourceBetween('const chipOnly', 'function focused')}; ({ chipOnly })`);
  const mention = { nodeType: 1, classList: { contains: (c) => c === 'mention' } }, words = { nodeType: 3, data: 'words' };
  const caretAnchor = { nodeType: 3, data: '\u200b' };
  assert.equal(chip.chipOnly({ childNodes: [mention], firstChild: mention }), true, 'one chip and nothing else is a chip-only row');
  assert.equal(chip.chipOnly({ childNodes: [caretAnchor, mention], firstChild: caretAnchor }), true, 'and the caret position before it does not change that');
  assert.equal(chip.chipOnly({ childNodes: [caretAnchor, mention, words], firstChild: caretAnchor }), false, 'text typed before the chip does: an inline reference is an ordinary row');
  assert.equal(chip.chipOnly({ childNodes: [mention, words], firstChild: mention }), false, 'text typed beside it makes it an ordinary row again');
  assert.equal(chip.chipOnly({ childNodes: [words], firstChild: words }), false, 'plain text is not');
  assert.match(source, /\(e\.key === 'Backspace' \|\| e\.key === 'Delete'\) && chipOnly\(el\)\) \{ e\.preventDefault\(\); return removeNode\(item, el\); \}/, 'Backspace on a chip-only row removes it');
  assert.match(source, /text\.classList\.toggle\('chiponly', chipOnly\(text\)\)/, 'a rendered row knows it is chip-only');
  assert.match(source, /el\.classList\.toggle\('chiponly', chip\)/, 'and typing beside the chip updates that');

  // Becoming an ordinary line is the row's own answer, not the save's: a full reference typed into keeps the other
  // node's segments until the debounced write lands, so drawing it from those left the box, the tags and the
  // strikethrough standing for the length of the round trip. liveTarget reads the edit in flight instead.
  const live = vm.runInNewContext(`
    ${sourceBetween('const segsOf =', 'const plainOf =')}
    const nodeIcon = () => 'task';
    ${sourceBetween('const asDoc = (n)', '// api.node')}
    ${sourceBetween('const isReference = (node)', 'const referenceLabel =')}
    ({ liveTarget, oneMention });
  `);
  const chipSegs = [{ mention: { uri: 'tana:text:t1', label: 'Ship it' } }];
  const full = { kind: 'block', segments: chipSegs, reference: { uri: 'tana:text:t1', node: { id: 'tana:text:t1', title: 'Ship it', done: 1 } } };
  assert.equal(live.liveTarget(full, undefined)?.id, 'tana:text:t1', 'a block whose only content is a mention stands in for that node');
  assert.equal(live.liveTarget(full, { segs: chipSegs })?.id, 'tana:text:t1', 'an edit that is still just the chip leaves it standing in');
  assert.equal(live.liveTarget(full, { segs: [...chipSegs, { text: ' ' }] }), null, 'a space typed after the chip makes it an ordinary line at once, before the save goes out');
  const inline = { kind: 'block', type: 'reference', segments: [{ text: 'Ship it' }], reference: { uri: 'tana:text:t1', node: { id: 'tana:text:t1', title: 'Ship it' } } };
  assert.equal(live.liveTarget(inline, { segs: [{ text: 'Ship it now' }] })?.id, 'tana:text:t1', 'typing in an inline reference edits the target title, so it keeps pointing at it');
  assert.match(source, /const target = gone \|\| field \? null : liveTarget\(node, pending\.get\(item\.key\)\)/,
    'the row is drawn from the live answer, except in a field, where a reference stays a chip in the line');
  assert.match(source, /!e\.isComposing &&[\s\S]{0,120}row\.classList\.contains\('fullref'\) !== chip\) render\(true\)/,
    'and the keystroke that flips it redraws the row then, not when the save returns — except mid-composition, where rebuilding the row would drop what the IME holds');

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
  // Enter at the very start of a node: the empty row goes in front and takes the caret, the node keeps its text,
  // and undoing that Enter hands the caret back to the node it ran on — the row below, not the nearest one above.
  const context0 = {};
  vm.runInNewContext(`
    const source = { id: 'source', kind: 'block', text: 'Hardware Depreciation Risk', segments: [{ text: 'Hardware Depreciation Risk' }], children: [{ id: 'kid', kind: 'block', text: '170+ machines', children: [] }] };
    const above = { id: 'above', kind: 'block', text: 'Hardware capacity need unclear', children: [] };
    let serverRows = [above, source], rows = serverRows.slice();
    const kids = new Map([['doc', rows]]), items = new Map();
    const item = { key: 'doc/source', docId: 'doc', node: source, parent: { node: { kind: 'document' } } };
    const calls = [];
    let focus, lastEnter = null;
    const canEditItem = () => true, hasKids = () => true, isOpen = () => true;
    const readSegs = () => [{ text: 'Hardware Depreciation Risk' }];
    const splitSegs = (segs, offset) => [[], segs];
    const plainOf = (segs) => segs.map((segment) => segment.text).join('');
    const dropPending = () => {}, saveValue = (value) => value, renderSegs = () => {}, scheduleSave = () => {};
    const textEl = (key) => (rows.some((node) => 'doc/' + node.id === key) ? { key } : null);
    const caretOffset = () => 0;
    const render = () => { for (const node of rows) items.set('doc/' + node.id, { key: 'doc/' + node.id, docId: 'doc', node }); };
    const placeCaret = (key, offset) => { focus = { key, offset }; };
    const reload = async () => { rows = serverRows.slice(); kids.set('doc', rows); };
    const run = (fn) => fn();
    const flushAll = () => {}, loadRoots = async () => {}, patchDoc = async () => {};
    const focused = () => (focus && textEl(focus.key) ? { key: focus.key, offset: focus.offset } : null);
    const texts = () => rows.map((node) => ({ key: 'doc/' + node.id }));
    const keyOfEl = (el) => el.key;
    const caretNear = (keys, i) => { focus = { key: 'nearest:' + (keys[i] || ''), offset: null }; }; // the old behaviour, so a fallback is visible
    const tana = {
      insertBefore: async (docId, id, text) => { calls.push(['insertBefore', id, text]); serverRows = [above, { id: 'fresh', kind: 'block', text: '', children: [] }, source]; return 'fresh'; },
      split: async () => { throw new Error('Enter at offset 0 must not split the node'); },
      undo: async () => { calls.push(['undo']); serverRows = [above, source]; return 'doc'; },
    };
    ${functionSource('splitNode')}
    ${functionSource('history')}
    Object.assign(globalThis, {
      start: () => splitNode(item, {}, 0),
      undo: () => history('undo'),
      state: () => ({ rows: rows.map((node) => ({ id: node.id, text: node.text })), calls, focus, kids: source.children.length }),
    });
  `, context0);
  await context0.start();
  assert.deepEqual(plain(context0.state()), {
    rows: [{ id: 'above', text: 'Hardware capacity need unclear' }, { id: 'fresh', text: '' }, { id: 'source', text: 'Hardware Depreciation Risk' }],
    calls: [['insertBefore', 'source', '']],
    focus: { key: 'doc/fresh', offset: 0 },
    kids: 1,
  }, 'Enter at the start of a node adds an empty sibling in front, keeps the node and its children, and takes the caret there');
  await context0.undo();
  assert.deepEqual(plain(context0.state()), {
    rows: [{ id: 'above', text: 'Hardware capacity need unclear' }, { id: 'source', text: 'Hardware Depreciation Risk' }],
    calls: [['insertBefore', 'source', ''], ['undo']],
    focus: { key: 'doc/source', offset: 0 },
    kids: 1,
  }, 'undoing that Enter puts the caret back in the node it ran on, at the offset it ran at');

  const splitNode = functionSource('splitNode');
  const context = {};
  vm.runInNewContext(`
    const source = { id: 'source', kind: 'block', block: 'paragraph', text: 'left-right', segments: [{ text: 'left-right' }], children: [] };
    const item = { key: 'doc/source', docId: 'doc', node: source, parent: { node: { kind: 'document' } } };
    let rows = [source], draftEl, releaseInsert, focus;
    const insertGate = new Promise((resolve) => { releaseInsert = resolve; });
    const kids = new Map([['doc', rows]]), items = new Map();
    const sourceEl = { segs: [{ text: 'left-right' }] };
    const calls = [], saves = [];
    const canEditItem = () => true, hasKids = () => false, isOpen = () => false;
    ${source.match(/const siblingBlock = .*/)[0]}
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
    const reload = async () => { rows = [source, { id: 'inserted', kind: 'block', block: 'paragraph', text: '-right', segments: [{ text: '-right' }], children: [] }]; kids.set('doc', rows); };
    const run = (fn) => fn();
    const tana = {
      setText: async (_docId, id) => { calls.push(['setText', id]); },
      split: async (_docId, id) => { calls.push(['split', id]); await insertGate; return 'inserted'; },
    };
    ${splitNode}
    Object.assign(globalThis, {
      start: () => splitNode(item, sourceEl, 4),
      type: (text) => { draftEl.segs = [{ text }]; draftEl.offset = text.length; },
      release: () => releaseInsert(),
      state: () => ({ rows: rows.map((node) => ({ id: node.id, block: node.block, draft: !!node.draft, pendingSplit: !!node.pendingSplit, text: node.text })), calls, saves, focus }),
    });
  `, context);
  const split = context.start();
  await Promise.resolve();
  assert.deepEqual(plain(context.state().rows), [
    { id: 'source', block: 'paragraph', draft: false, pendingSplit: false, text: 'left' },
    { id: context.state().rows[1].id, block: 'paragraph', draft: true, pendingSplit: true, text: '-right' },
  ], 'Enter immediately renders a pending draft while the split insertion is in flight, as the kind of row the write will make — splitting plain text must not flash a bullet under the caret');
  context.type('typed during insert');
  context.release();
  await split;
  assert.deepEqual(plain(context.state()), {
    rows: [
      { id: 'source', block: 'paragraph', draft: false, pendingSplit: false, text: 'left' },
      { id: 'inserted', block: 'paragraph', draft: false, pendingSplit: false, text: '-right' },
    ],
    calls: [['split', 'source']],
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
    const iconNode = (icon) => { const el = document.createElement('svg'); el.dataset.icon = icon; return el; };
    const deletedIds = new Set();
    ${sourceBetween('const isGone = (uri)', 'function noteGone')}
    ${segments}
    ({ renderSegs, readSegs, markRange, hasMark, saveValue, blank: () => document.createElement('span'),
       known: (uri) => deletedIds.has(uri),
       iconOf: (el) => { let found; (function walk(n) { for (const kid of n.childNodes || []) { if (kid.nodeName === 'SVG' && kid.dataset) found ??= kid.dataset.icon; walk(kid); } })(el); return found; },
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

  // A reference written inside a line says what it points at: its target's icon in front of the label (main
  // resolves it, renderer/segments.js draws it), with the label in a span of its own so the underline runs under
  // the words rather than under the icon.
  const iconed = [{ text: 'I like the ' }, { mention: { label: 'Nedap Retail', uri: 'tana:text:01examplet0000000000000000', icon: 'member' } }, { text: ' team' }];
  const withIcon = api.blank();
  api.renderSegs(withIcon, iconed);
  assert.deepEqual(plain(api.tags(withIcon)), ['A.mention', 'SVG', 'SPAN.mlabel'], 'the icon is drawn in front of the label, inside the link');
  assert.equal(withIcon.textContent, 'I like the Nedap Retail team', 'and it is not text: the line still reads as its words');
  assert.deepEqual(plain(api.readSegs(withIcon)), iconed, 'the icon travels back with the mention, so typing beside one does not drop it');
  // its type's colour rides along the same way: --hue on the link for the CSS, and back into the segment on read
  const hued = [{ mention: { label: 'Tuxis', uri: 'tana:text:01examplet0000000000000000', icon: 'nc-rocket', hue: 259 } }];
  const withHue = api.blank(); api.renderSegs(withHue, hued);
  assert.deepEqual(plain(api.readSegs(withHue)), hued, 'the hue travels back with the mention like the icon');
  const plainRef = api.blank();
  api.renderSegs(plainRef, [{ mention: { label: 'Unresolved', uri: 'tana:text:01exampleu0000000000000000' } }]);
  assert.deepEqual(plain(api.tags(plainRef)), ['A.mention'], 'a reference whose target could not be read stays an ordinary link');
  assert.deepEqual(plain(api.readSegs(plainRef)), [{ mention: { label: 'Unresolved', uri: 'tana:text:01exampleu0000000000000000' } }], 'and reads back without an icon field at all');

  // A mention of something deleted is drawn as what it is: the words that were written, struck through behind the
  // trash glyph (styles.css), and remembered in deletedIds so nothing opens it. The kind icon it may have had is not
  // what goes back into the document, so the round trip carries the mention, not the state it was found in.
  const goneUri = 'tana:text:01exampled0000000000000000';
  const goneChip = api.blank();
  api.renderSegs(goneChip, [{ text: 'blocked by ' }, { mention: { label: 'Old plan', uri: goneUri, icon: 'task', deleted: true } }]);
  assert.deepEqual(plain(api.tags(goneChip)), ['A.mention gone', 'SVG', 'SPAN.mlabel'],
    'a deleted mention still draws a glyph and a label, and says it is gone — which is what strikes it through and takes the link colour off it (styles.css)');
  assert.equal(api.iconOf(goneChip), 'trash', 'and the glyph is the trash one, not the kind it used to be');
  assert.equal(api.known(goneUri), true, "main's answer is remembered, so the guards that refuse to open it know too");
  assert.deepEqual(plain(api.readSegs(goneChip)), [{ text: 'blocked by ' }, { mention: { label: 'Old plan', uri: goneUri, icon: 'task' } }],
    'and what is read back is the mention as written: the trash glyph is this launch\'s answer about the target, not content');
  const knownGone = api.blank();
  api.renderSegs(knownGone, [{ mention: { label: 'Old plan', uri: goneUri } }]);
  assert.deepEqual(plain(api.tags(knownGone)), ['A.mention gone', 'SVG', 'SPAN.mlabel'], 'every later copy of it is drawn the same way, mark or no mark');

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
// ⌘F opens the filter field and puts the caret in it, whatever the caret was doing before. The render that shows the
// field is deferred while the caret is in a row or a selection is frozen, and focusing a hidden input does nothing —
// the press then looked ignored until a click elsewhere let the deferred render through.
function runFilterShortcutFocusCheck() {
  const api = vm.runInNewContext(`
    let filterShown = false, focused = 0, deferred = true;
    const rows = [], zoom = null;
    const filterRow = { hidden: true, classList: { toggle: () => {} } };
    const filterEl = { value: '', focus: () => { if (!filterRow.hidden) focused++; } };
    const onSearchPage = () => false;
    const render = () => { if (deferred) return; filterRow.hidden = !(filterShown || filterEl.value); }; // render.js: deferred while a row is being edited
    ${sourceBetween("if (!zoom || onSearchPage()) rows.push({ id: 'filter'", '\n')}
    ({ press: () => rows.find((r) => r.id === 'filter').run(), settle: () => { deferred = false; render(); }, state: () => ({ focused, hidden: filterRow.hidden }) });
  `);
  api.press();
  assert.deepEqual(plain(api.state()), { focused: 1, hidden: false }, '⌘F focuses the filter field even while the render that would show it is deferred');
  api.settle();
  assert.deepEqual(plain(api.state()), { focused: 1, hidden: false }, 'and the deferred render leaves it open');
}
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
    const pinnedHere = new Set();
    const isPinned = (id) => pinnedHere.has(id);
    const openPinsPalette = (doc) => calls.push(['pins', doc.id]);
    const loadAccess = () => {}, loadTaskMeta = () => {};
    const run = (fn) => fn();
    const tana = { taskMeta: async () => ({}), setAssignees: async () => {}, accessOptions: async () => ({}), pinState: async () => ({}), nodeLink: async (id) => 'https://home.tana.inc/l/' + id, openExternal: async (url) => calls.push(['open', url]) };
    ${functionSource('railCallRow')}
    ${functionSource('railMetaRows')}
    ${functionSource('openVisibility')}
    ${functionSource('banSvg')}
    ${functionSource('visibilityRows')}
    ({ rows: (node, value, accessNode) => { summary = value; return railMetaRows(node, accessNode); }, call: (data) => railCallRow(data), calls: () => calls,
       pin: (id) => { pinnedHere.add(id); },
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
  // A pinned node says so in Details too, and that row opens the page its pins are taken off from
  api.pin('pinnedDoc');
  const pinnedRows = api.rows({ id: 'pinnedDoc' }, { assignees: '', audience: { icon: 'lock', label: 'Visible only to you' } });
  assert.deepEqual(plain(pinnedRows.map((row) => [row.id, row.icon, row.label])),
    [['visibility', 'lock', 'Visible only to you'], ['pinned', 'pinned', 'Pinned'], ['showInTana', 'tana', 'Show in Tana']], 'a pinned node carries the tack beside its audience');
  pinnedRows[1].run();
  assert.deepEqual(plain(api.calls().at(-1)), ['pins', 'pinnedDoc'], 'and that row opens Edit pins for it');
  assert.ok(!api.rows({ id: 'doc' }, { assignees: '', audience: { icon: 'lock', label: 'Visible only to you' } }).some((row) => row.id === 'pinned'), 'an unpinned node has no such row');
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
  assert.deepEqual(plain(groups({ pinned: [], outcomes: [], notes: [], backlinks: [{ label: 'Project › Owner', rows: [{ id: 'field' }] }, { label: 'Mentioned in', rows: [{ id: 'doc' }] }] })),
    [['Project › Owner', [{ id: 'field' }]], ['Mentioned in', [{ id: 'doc' }]]], 'backlinks arrive grouped: a section per typed field, then the mentions');

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
    const relatedStale = new Set(), connected = true, isRealId = () => true, renderSoon = () => {};
    const tana = { pinTo: async (...args) => calls.push(args), related: async () => ({ pinned: [] }) }, run = (fn) => fn();
    let renders = 0; const render = () => { renders++; };
    ${functionSource('loadRelated')}
    ${functionSource('refreshRelated')}
    ${functionSource('pinResult')}
    ({ pin: () => pinResult({ pinHub: 'event', docId: 'doc' }, { id: 'chosen' }), state: () => ({ calls, keys: [...relatedBy.keys()], kept: [...relatedBy.values()].every((value) => value !== null), renders }) });
  `);
  await refresh.pin();
  assert.deepEqual(plain(refresh.state()), { calls: [['event', 'chosen']], keys: ['event', 'doc'], kept: true, renders: 1 },
    'pinning re-reads the hub and the open document without taking their sidebars down');
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
    ${sourceBetween('const COMPLETED =', 'const TYPES =')} // the completed window reads as part of the filter
    ${functionSource('setViewF')}
    ${sourceBetween('const clearFilter =', 'function ensureLoaded')}
    ({ set: (next, patch) => { view = next; if (patch) filters.set(view, { ...filters.get(view), ...patch }); },
       filtered: () => viewFiltered(), clear: () => clearFilters(), state: () => filters.get(view), same: (a, b) => sameFilter(a, b) });
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
  // A saved search is dirty when its pills differ from what it stored, so the completed window has to be part of
  // that comparison — and an unset one is the default rather than a different filter.
  const base = { types: ['tasks'], states: ['closed'], assignee: 'anyone', text: '' };
  assert.equal(api.same(base, { ...base, completedWithin: 7 }), true, 'a filter that has never been given a window is the 7 days one that has');
  assert.equal(api.same({ ...base, completedWithin: 7 }, { ...base, completedWithin: 30 }), false, 'and changing the window is a change, so Save is offered for it');
  assert.equal(api.same({ ...base, completedWithin: 'all' }, { ...base, completedWithin: 'all' }), true, 'while the same window twice is not');
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
    // a view whose stored grouping is Responsibility: loadView widens its query through the real helper
    const groupPref = { grouped: 'responsibility', plain: 'assignee' };
    ${sourceBetween('const needsAnyone =', '// Group by Updated')}
    for (const id of ['grouped', 'plain']) {
      views.push({ id, title: id, nodes: [] });
      filters.set(id, { types: ['tasks'], states: ['open'], assignee: 'me', text: 'memo' });
    }
    ${functionSource('loadView')}
    ({
      ids,
      start: (id) => loadView(id),
      resolve: (index, result) => pending[index](result),
      calls: () => calls,
      filter: (id) => filters.get(id),
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

  // A view that comes back grouped by Responsibility (a stored preference at launch, or switching to it) is widened
  // before its rows are asked for: two of the four sections are about rows "Assigned to you" never returns, so the
  // grouping would otherwise section an incomplete list. Only the assignee moves — the rest of the query stands.
  for (const id of ['grouped', 'plain']) {
    const load = api.start(id);
    api.resolve(api.calls().length - 1, { nodes: [], truncated: false });
    await load;
  }
  assert.deepEqual(plain(api.calls().slice(-2).map(([id, filter]) => [id, filter.assignee])), [['grouped', 'anyone'], ['plain', 'me']],
    'Group by Responsibility cannot sit on a view filtered to one assignee: its query asks for anyone, while any other grouping asks exactly what the view stored');
  assert.deepEqual(plain(api.filter('grouped')), { types: ['tasks'], states: ['open'], assignee: 'anyone', text: 'memo' },
    'the widened filter is what the view now holds, so the Assigned to pill agrees with the rows — and the status, type and text filters are untouched');
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
  // Built twice: once for the session, and once more seeded with what the first one wrote, which is a relaunch.
  const makeApi = (stored) => vm.runInNewContext(`
    let view = 'tasks', groupPref = {}, sortPref = {};
    ${FAKE_DOM}
    const filters = new Map([['tasks', { types: ['tasks'], states: ['open'], assignee: 'me' }]]);
    const views = [{ id: 'tasks', kind: true }, { id: 'library' }];
    let members = [{ id: 'me', title: 'Robin', me: true }, { id: 'sam', title: 'Sam' }];
    // the four tr rows are handed to Sam and still watched, so they land in Tracking and the section can be trimmed
    const taskMetaById = new Map([['t1', { assignees: ['sam'], watched: true }], ['t2', { assignees: ['me'] }], ['t4', { assignees: ['tana:user-profile:ghost'], watched: false }], ['t5', { assignees: ['me'] }], ['t6', { assignees: [] }], ['t7', { assignees: [] }], ['t8', { assignees: ['me'] }], ['t9', { assignees: ['me'] }], ['t10', { assignees: ['me'] }], ['t11', { assignees: ['sam'], watched: false }], ['ta1', { assignees: ['tana:user-profile:ghost'] }], ['ta2', { assignees: ['me'] }], ['tr1', { assignees: ['sam'], watched: true }], ['tr2', { assignees: ['sam'], watched: true }], ['tr3', { assignees: ['sam'], watched: true }], ['tr4', { assignees: ['sam'], watched: true }]]);
    // the app-local agent marks the badge is drawn from (renderer/state.js), not Tana assignees
    const codexIds = new Set(['ta1', 'ta2', 'ta3']);
    // loadTaskMeta is the real one (renderer/tasks.js): Responsibility asks for the metadata it is missing, since a
    // row it filters out never reaches the screen to ask for itself
    const asked = [], taskMetaFailed = new Map(), taskMetaLoading = new Set(), connected = true, isRealId = () => true;
    const tana = { taskMeta: (id) => { asked.push(id); return new Promise(() => {}); } }, palette = { hidden: true };
    const $ = () => ({ hidden: true });
    const renderPills = () => {}, render = () => {}, showError = () => {};
    // the real write path is renderer/nodes.js (persist, then re-ask); here it is recorded and applied in place
    let savedPatch = null;
    const setViewF = (patch) => { savedPatch = patch; filters.set(view, { ...filters.get(view), ...patch }); };
    const store = ${JSON.stringify(stored || {})};
   const localStorage = { getItem: (key) => (key in store ? store[key] : null), setItem: (key, value) => { store[key] = String(value); } };
    // the preferences that follow you between machines (renderer/prefs.js), where the folded sections live now
    const prefs = store.prefs || {}; const pref = (k, fb) => (k in prefs ? prefs[k] : fb); const setPref = (k, v) => { prefs[k] = v; store.prefs = prefs; store[k] = JSON.stringify(v); };
    // the real declaration from renderer/state.js: what a launch reads back before its first render
    const collapsedGroups = new Set(pref('collapsedGroups', []));
    const isTask = (n) => n.icon === 'task';
    const visibleTags = (n) => { const tags = n.tags || []; return isTask(n) && tags.some((t) => t.label !== 'task') ? tags.filter((t) => t.label !== 'task') : tags; };
    ${definitions}
    ({ pillDefs, groupRows, groupsOf, sortRows, pageRows, SORTS, SORT_KEY, holdRow, releaseHeld, needsCleanup,
       setGroupBy, toggleGroup, groupHeadEl, groupMoreEl, widenFilter, savedPatch: () => savedPatch, filter: () => filters.get(view),
       RESPONSIBILITY,
       asked: () => asked,
       stored: () => ({ ...store }),
       rename: (id, title) => { members = members.map((m) => (m.id === id ? { ...m, title } : m)); },
       stage: (f) => { savedPatch = null; filters.set(view, f); },
       set: (next, by, order) => { view = next; groupPref[next] = by; sortPref[next] = order; },
       prefs: () => ({ group: groupBy(), sort: sortBy() }) });
  `);
  const api = makeApi(null);
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
  // Responsibility: what the row is to you, from who made it and who it is on. The four rules exactly, plus the rows
  // it has no section for — somebody else's task on somebody else, their unassigned one, and a row whose assignees
  // have not arrived yet — which are left out rather than piled under a heading of leftovers.
  const daysAgo = (days) => new Date(Date.now() - days * 864e5).toISOString();
  const responsibility = [
    { ...rows[1], createdBy: 'me' },        // t2: you made it, you have it
    { id: 't8', tags: [], stateType: 'proposed', createdBy: 'me' }, // you made it and have it, still in your Inbox
    { id: 't10', tags: [], stateType: 'open', createdBy: 'me' },    // you made it and have it, under way
    { id: 't9', tags: [], stateType: 'not_now', createdBy: 'me' },  // you made it and have it, and put it off
    { ...rows[0], createdBy: 'me', updatedAt: daysAgo(1) }, // t1: you made it, Sam has it, and it moved yesterday
    // (Tracking opens on what moved in the last three days — below — so a stale row here would sit behind the link)
    { id: 't11', tags: [], createdBy: 'me' }, // you made it and Sam has it, but you turned notifications off
    { id: 't6', tags: [], createdBy: 'me' },  // you made it, nobody has it
    { id: 't7', tags: [], createdBy: 'sam' }, // Sam made it, nobody has it: no business of yours
    { id: 't5', tags: [], createdBy: 'sam' }, // Sam made it, you have it
    { ...rows[3], createdBy: 'sam' },       // t4: Sam made it, a third person has it
    { ...rows[2], createdBy: 'me' },        // t3: yours, but its metadata has not arrived
    rows[4],                                // no creator at all
  ];
  // Handed to the local agent: Sam's task on a third person (this grouping would not list it at all), your own task
  // under way (it would be Mine), and one with no metadata to classify by.
  const agents = [
    { id: 'ta1', tags: [], createdBy: 'sam' },
    { id: 'ta2', tags: [], stateType: 'open', createdBy: 'me' },
    { id: 'ta3', tags: [], createdBy: 'sam' },
  ];
  assert.deepEqual(titles([...responsibility, ...agents], 'responsibility'),
    [['Unassigned', ['t6']], ['Tracking', ['t1']], ['Agent', ['ta1', 'ta2', 'ta3']], ['My inbox', ['t8']], ['Mine', ['t10']], ['My completed', ['t2']], ['My later', ['t9']], ['Assigned by others', ['t5']]],
    'Responsibility runs Unassigned, Tracking, Agent, then your own work by its state — My inbox, Mine, My completed, My later — and ends with what somebody else handed you');
  assert.deepEqual(titles(agents, 'responsibility'), [['Agent', ['ta1', 'ta2', 'ta3']]],
    'a node handed to the local agent is in the Agent section and in no other: whoever Tana has it assigned to, and even with no metadata read yet — asking for it by name is enough to list it');
  assert.deepEqual(titles(responsibility, 'responsibility'),
    [['Unassigned', ['t6']], ['Tracking', ['t1']], ['My inbox', ['t8']], ['Mine', ['t10']], ['My completed', ['t2']], ['My later', ['t9']], ['Assigned by others', ['t5']]],
    'and with nothing handed to the agent the other sections are exactly as they were');
  // Tracking follows the bell, not the hand-off: silencing a task you gave away takes it out of the section, the
  // same watch state (an explicit choice, else the default rule) the row's own bell is drawn from.
  assert.deepEqual(titles([{ ...rows[0], id: 't11', createdBy: 'me' }], 'responsibility'), [],
    'a task you made and handed over with notifications off is not Tracking, and is left out like anything else this grouping has no section for');
  const owned = (extra) => titles([{ id: 't2', tags: [], createdBy: 'me', ...extra }], 'responsibility')[0][0];
  assert.deepEqual(['proposed', 'open', 'closed', 'not_now'].map((stateType) => owned({ stateType })), ['My inbox', 'Mine', 'My completed', 'My later'],
    'a task you made and hold sits in exactly one of the four state sections, in the order the Status menu lists them');
  assert.deepEqual([owned({ done: 1 }), owned({ done: 0 }), owned({})], ['My completed', 'Mine', 'Mine'],
    'and a row carrying only the older done flag reads the same way, while one with no state at all is under way');
  assert.deepEqual(titles([...responsibility, ...agents], 'responsibility').map(([title]) => title), plain(api.RESPONSIBILITY),
    'and nothing else is filed: a row you neither made nor hold, and one whose assignees have not arrived, are left out rather than collected under a heading');
  // Every section holds rows: the grouping's leftovers are not listed at all, under no heading and with no note.
  api.set('tasks', 'responsibility', 'default');
  const sections = plain(api.groupsOf(responsibility));
  assert.deepEqual(sections.map((g) => [g.title, g.nodes.map((n) => n.id)]),
    [['Unassigned', ['t6']], ['Tracking', ['t1']], ['My inbox', ['t8']], ['Mine', ['t10']], ['My completed', ['t2']], ['My later', ['t9']], ['Assigned by others', ['t5']]],
    'the sections run Unassigned, Tracking, My inbox, Mine, My completed, My later, Assigned by others, and end there');
  assert.ok(sections.every((g) => g.nodes.length && g.note === undefined),
    'no section is drawn empty, and none carries a line of its own');
  assert.equal(plain(api.pageRows(responsibility, '')).list.length, 7,
    'and the rows the grouping leaves out stay out of the keyboard order too');
  api.set('tasks', 'status', 'default');
  assert.ok(plain(api.groupsOf(rows)).every((g) => g.note === undefined && g.nodes.length),
    'no grouping gains an empty section or a note');
  assert.deepEqual(plain(api.asked()).filter((id) => ['t3', 'd1'].includes(id)).sort(), ['d1', 't3'],
    'and the rows it left out for want of metadata are asked for, since a row that is not drawn never asks for itself');
  // Tracking, and only Tracking, opens on what has moved: the rows updated in the last three days, with the rest
  // behind one link. Folding the section forgets that the link was pressed, so it opens short the next time.
  api.set('tasks', 'responsibility', 'default');
  const tracking = [
    { id: 'tr1', tags: [], createdBy: 'me', updatedAt: daysAgo(0.5) },
    { id: 'tr2', tags: [], createdBy: 'me', updatedAt: daysAgo(2.9) },
    { id: 'tr3', tags: [], createdBy: 'me', updatedAt: daysAgo(9) },
    { id: 'tr4', tags: [], createdBy: 'me' }, // no update time to read at all
  ];
  const track = () => plain(api.groupsOf(tracking))[0];
  assert.deepEqual(track().nodes.map((n) => n.id), ['tr1', 'tr2'], 'a Tracking section opens on the rows updated in the last three days');
  assert.equal(track().more, 2, 'and counts the rest, a row with no update time among them');
  assert.deepEqual(plain(api.pageRows(tracking, '')).list.map((n) => n.id), ['tr1', 'tr2'],
    'the tail is out of the keyboard order as well, like the rows of a folded section');
  const link = api.groupMoreEl(track());
  assert.equal(link.tagName, 'button', 'the link is a real button, so Tab reaches it and Enter or Space presses it');
  assert.equal(link.textContent, 'Show 2 more tasks', 'and it says how many rows it is holding back');
  link.onclick();
  assert.deepEqual(track().nodes.map((n) => n.id), ['tr1', 'tr2', 'tr3', 'tr4'], 'pressing it shows the whole section');
  assert.equal(track().more, undefined, 'and leaves no link behind');
  assert.equal(api.groupMoreEl({ ...track(), more: 1 }).textContent, 'Show 1 more task', 'one row left is a task, not tasks');
  api.toggleGroup('Tracking');
  api.toggleGroup('Tracking');
  assert.deepEqual(track().nodes.map((n) => n.id), ['tr1', 'tr2'], 'and folding the section away and opening it again opens it short');
  const stale = [{ id: 't10', tags: [], stateType: 'open', createdBy: 'me', updatedAt: daysAgo(40) }, { id: 't6', tags: [], createdBy: 'me', updatedAt: daysAgo(40) }];
  assert.deepEqual(plain(api.groupsOf(stale)).map((g) => [g.title, g.nodes.length, g.more]), [['Unassigned', 1, undefined], ['Mine', 1, undefined]],
    'no other section is trimmed: work with your name on it is exactly where a row that has not moved is the one to see');
  // Two of those sections are about rows a page filtered to "Assigned to you" never returns, so the grouping cannot
  // sit on top of that filter: choosing it widens the assignee filter to Anyone and leaves the rest of the query alone.
  api.set('tasks', 'none', 'default');
  api.stage({ types: ['tasks'], states: ['open'], assignee: 'me', text: 'memo' });
  api.setGroupBy('responsibility');
  assert.deepEqual(plain(api.savedPatch()), { assignee: 'anyone' }, 'choosing Responsibility writes the assignee filter the sections need');
  assert.deepEqual(plain(api.filter()), { types: ['tasks'], states: ['open'], assignee: 'anyone', text: 'memo' }, 'and changes nothing else: the status, type and text filters stand');
  api.stage({ types: ['tasks'], states: ['open'], assignee: 'me', text: '' });
  api.setGroupBy('assignee');
  assert.equal(api.savedPatch(), null, 'every other grouping leaves the view\'s filter alone');
  // Restored from a stored preference, the widening happens before the rows are asked for (loadView, renderer/nodes.js)
  const stored = { types: ['tasks'], states: ['open'], assignee: 'me', text: '' };
  api.set('tasks', 'responsibility', 'default');
  assert.deepEqual(plain(api.widenFilter('tasks', stored)), { types: ['tasks'], states: ['open'], assignee: 'anyone', text: '' },
    'a view that comes back grouped by Responsibility queries for Anyone, rather than sectioning a list two of its headings cannot appear in');
  assert.equal(api.widenFilter('tasks', { ...stored, assignee: 'anyone' }).assignee, 'anyone', 'a filter that already asks for anyone is handed back as it is');
  api.set('tasks', 'status', 'default');
  assert.equal(api.widenFilter('tasks', stored), stored, 'and no other grouping touches the query');
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
  api.set('tasks', 'none', 'status');
  assert.deepEqual(order(rows), ['t3', 't1', 't2', 't4', 'd1'],
    'Status sorts by the workflow — Inbox, In Progress, Completed, Later — and a row with no task state keeps its place at the end');
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
  assert.deepEqual(plain(sort.rows().map((r) => r.label)), ['Default', 'Status', 'Updated', 'Created', 'Title'], 'the Sort menu offers only orders backed by row data');
  assert.deepEqual(plain(group.rows().map((r) => r.label)), ['None', 'Status', 'Assignee', 'Responsibility', 'Updated', 'Type'], 'the Group menu offers the six groupings');
  assert.ok(sort.rows().find((r) => r.label === 'Title').checked && group.rows().find((r) => r.label === 'Status').checked, 'the active option is ticked');
  assert.ok([...sort.rows(), ...group.rows()].every((r) => !r.keepOpen), 'choosing an option closes the popup, like every other single choice');
  // The completed window sits beside the Status filter and only while Completed is in it: Status decides whether
  // completed tasks appear at all, this decides how old they may be. Taking Completed out hides the pill and keeps
  // the value, so putting it back reads the same as before.
  const completedPill = () => api.pillDefs().find((d) => d.id === 'completed');
  api.stage({ types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '' });
  assert.equal(completedPill(), undefined, 'with Completed out of the Status filter there is no window to choose');
  api.stage({ types: ['tasks'], states: ['proposed', 'closed'], assignee: 'me', text: '' });
  assert.deepEqual(plain([completedPill().label, completedPill().value]), ['Completed', '7 days'],
    'letting Completed in offers the window, defaulting to 7 days the first time it is asked for');
  assert.deepEqual(plain(completedPill().rows().map((r) => [r.label, !!r.checked])), [['7 days', true], ['30 days', false], ['All', false]],
    'the choices are the three the rule knows, with the active one ticked and no way to turn completed tasks off here');
  assert.deepEqual(plain(api.pillDefs().map((d) => d.id)), ['status', 'completed', 'assigned', 'sort', 'group', 'display'],
    'and it sits with the filters, right after the Status pill it belongs to');
  completedPill().rows().find((r) => r.label === '30 days').run();
  assert.deepEqual(plain(api.savedPatch()), { completedWithin: 30 }, 'choosing one writes the window and touches nothing else about the filter');
  assert.equal(completedPill().value, '30 days', 'which the pill then reads');
  api.stage({ types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '', completedWithin: 30 });
  assert.equal(completedPill(), undefined, 'taking Completed back out hides it again');
  api.stage({ types: ['tasks'], states: ['proposed', 'open', 'closed'], assignee: 'me', text: '', completedWithin: 30 });
  assert.equal(completedPill().value, '30 days', 'and the value it was given survives that, rather than falling back to the default');
  api.stage({ types: ['tasks'], states: null, assignee: 'me', text: '' });
  assert.equal(completedPill().value, '7 days', 'Any status lets completed tasks in too, so the window is offered there as well');
  api.stage({ types: ['docs'], states: null, assignee: 'me', text: '' });
  assert.equal(completedPill(), undefined, 'and a page listing no tasks has no completed tasks to age out');
  api.stage({ types: ['tasks'], states: ['open'], assignee: 'me', text: '' });
  // Folding a section away: the heading stays, its own rows go, and every other section is left alone. The state is
  // kept by page, grouping and section, so it outlives a render, does not leak to another page, and survives a relaunch.
  api.set('tasks', 'status', 'default');
  const drawn = () => plain(api.pageRows(rows, '')).list.map((n) => n.id);
  const heads = () => api.groupsOf(rows).map((g) => api.groupHeadEl(g));
  assert.deepEqual(drawn(), ['t3', 't1', 't2', 't4', 'd1'], 'every section starts open');
  assert.ok(heads().every((el) => el.tagName === 'button' && el.className === 'ghead' && el.getAttribute('aria-expanded') === 'true'),
    'each heading is a button that says its section is expanded');
  heads()[0].onclick(); // Inbox
  assert.deepEqual(drawn(), ['t1', 't2', 't4', 'd1'], 'a folded section leaves its rows out, so the keyboard cannot walk into rows nobody can see');
  assert.deepEqual(plain(api.pageRows(rows, '')).groups.map((g) => [g.title, g.collapsed]),
    [['Inbox', true], ['In Progress', false], ['Completed', false], ['Later', false], ['No status', false]],
    'and the heading itself stays, as the one section that is folded');
  assert.deepEqual([...heads().map((el) => el.getAttribute('aria-expanded'))], ['false', 'true', 'true', 'true', 'true'], 'which is what aria-expanded reads');
  assert.deepEqual([...heads().map((el) => el.textContent)], ['Inbox', 'In Progress', 'Completed', 'Later', 'No status'], 'a heading still names its section, folded or not');
  assert.equal(heads()[0].title, 'Expand', 'and offers the word for what a click would do');
  heads()[1].onclick(); // In Progress, while Inbox is still folded
  assert.deepEqual(drawn(), ['t2', 't4', 'd1'], 'sections fold one at a time, independently');
  heads()[0].onclick(); // Inbox back
  assert.deepEqual(drawn(), ['t3', 't2', 't4', 'd1'], 'and unfolding one brings its rows back without touching the other');
  api.set('library', 'status', 'default');
  assert.deepEqual(drawn(), ['t3', 't1', 't2', 't4', 'd1'], 'another page with a heading of the same name is not folded by it');
  api.set('tasks', 'type', 'default');
  assert.equal(plain(api.pageRows(rows, '')).list.length, rows.length, 'and neither is another grouping of the same page');
  api.set('tasks', 'status', 'default');
  assert.deepEqual(drawn(), ['t3', 't2', 't4', 'd1'], 'coming back, the section folded on this page is still folded: the state outlives every render in between');
  heads()[1].onclick(); // leave the page as it was found
  assert.deepEqual(drawn(), ['t3', 't1', 't2', 't4', 'd1']);
  // Remembered across launches: what the session wrote is what the next launch reads, folded sections only.
  heads()[0].onclick(); // Inbox, again
  assert.deepEqual(JSON.parse(plain(api.stored()).collapsedGroups), ['tasks\nstatus\nInbox'],
    'the page, its grouping and the section are what is written, and only the folded ones are');
  const relaunched = makeApi(plain(api.stored()));
  relaunched.set('tasks', 'status', 'default');
  assert.deepEqual(plain(relaunched.pageRows(rows, '')).groups.map((g) => [g.title, g.collapsed]),
    [['Inbox', true], ['In Progress', false], ['Completed', false], ['Later', false], ['No status', false]],
    'a fresh launch reads the folded sections back before its first render, and every section it has not seen folded opens');
  assert.deepEqual(plain(relaunched.pageRows(rows, '')).list.map((n) => n.id), ['t1', 't2', 't4', 'd1'],
    'and a section that comes back folded keeps its rows out of the keyboard order too');
  heads()[0].onclick(); // Inbox open again
  assert.deepEqual(JSON.parse(plain(api.stored()).collapsedGroups), [], 'unfolding drops the entry, so nothing accumulates but what is folded');
  // A section is remembered by what the row carries, not by the words in the heading: an assignee's name arrives late
  // and can change, a saved search can be renamed, and neither may unfold a section.
  api.set('tasks', 'assignee', 'default');
  const byAssignee = () => plain(api.groupsOf(rows)).map((g) => [g.title, g.id, g.collapsed]);
  assert.deepEqual(byAssignee().map((g) => g.slice(0, 2)), [['Robin', 'me'], ['Sam', 'sam'], ['tana:user-profile:ghost', 'tana:user-profile:ghost'], ['Unassigned', 'Unassigned']],
    'an assignee section is keyed by the member uri the row carries, whatever its heading reads');
  api.toggleGroup('sam');
  api.rename('sam', 'Samantha');
  assert.deepEqual(byAssignee().find((g) => g[1] === 'sam'), ['Samantha', 'sam', true], 'so renaming the member renames the heading and leaves it folded');
  api.toggleGroup('sam');
  api.set('tana:search:s1', 'status', 'default');
  api.toggleGroup('Inbox');
  assert.deepEqual(JSON.parse(plain(api.stored()).collapsedGroups), ['tana:search:s1\nstatus\nInbox'],
    'and a saved search folds against its document id, which a rename does not touch');
  api.toggleGroup('Inbox');
  api.set('tasks', 'status', 'title');
  assert.match(source, /const shown = pageRows\(docs, filterEl\.value\.trim\(\)\.toLowerCase\(\)\);/, 'a view draws its rows through pageRows, which sorts then groups them');
  assert.match(source, /groups\.flatMap\(\(g\) => \[groupHeadEl\(g\), \.\.\.\(g\.collapsed \? \[\] :/, 'each group is introduced by a heading, and a folded one draws nothing under it');
  assert.match(source, /const shown = pageRows\(list, filterEl\.value\.trim\(\)\.toLowerCase\(\)\);/, 'and so does a saved search: this is what carries its stored arrangement to the screen');
  assert.match(source, /label: 'Set status', subBase: 'Set status to'[^\n]*subAlways: true/, 'Set status folds its four statuses in for any query, like Move to …');
  assert.match(source, /label: `Set status for \$\{count\} \$\{noun\}`[^\n]*subAlways: true/, 'and so does Set status for a selection');
  // A reused row keeps whatever its checkbox shows: accepting an Inbox task changes only its state, so that must rebuild it
  const rowSig = vm.runInNewContext(`
    const taskMetaById = new Map(), taskMetaLoading = new Set(), open = new Map(), pending = new Map(), members = null;
    const sensitiveHidden = () => false;
    const isPinned = () => false;
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
  assert.match(source, /renderDeferred = true; markFalling\(\); refreshRowChrome\(\); if \(pillsDrawn\) renderPills\(true\); return;/,
    'a render that waits for the caret still brings every checkbox up to date, and re-renders the pills so Clean up can appear — by the page it is on, not by whether the row is folded away');
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

// Pin to current meeting / Pin to meeting: the two Cmd+K rows that put a node on a meeting. The first finds the
// meeting itself (tana.currentMeeting -> main/quickadd.currentMeeting, sdk/calls); the second opens a page of
// meetings to choose from (tana.searchPreview over the meetings filter). Both end in the one shared event pin
// (tana.pinTo -> pins.nodePin), so what is checked here is the rows, the page, and that the pin is the same write.
async function runPinToMeetingCheck() {
  const EVENT = 'tana:event:01j0event00000000000000000', OTHER = 'tana:event:01j0event10000000000000000';
  const DOC = 'tana:text:01j0doc000000000000000000';
  const NOW = Date.now(); // the page orders against the clock, so the fixtures are built from one
  const api = vm.runInNewContext(`
    const views = [], pinTree = [], pinRows = () => [], searches = [], searchesLoaded = true;
    let home = 'library', view = 'library';
    const localStorage = { setItem() {} }, onSearchPage = () => false;
    const selectionRows = () => [], pillCommandRows = () => [], taskActionRows = () => [];
    const palDoc = { id: '${DOC}' }, pinInfo = null, isRealId = () => true;
    const accessById = new Map(), loadAccess = () => {}, localDate = () => '2026-09-18', setTheme = () => {};
    const sectionOf = () => null, visibleTags = () => [];
    const palette = { hidden: false }; let palMode = 'cmd', palRows = [], palIndex = 0;
    const palInput = { placeholder: '', value: '', focus() {} };
    const zoom = null, railEl = { hidden: false }, navBack = [], navForward = [], sensitiveVisible = false;
    const railToggle = { hidden: false }, railHidden = false;
    const authed = true, authChecking = false, signedOut = false, theme = 'light', hotkeys = {}, themePref = 'light';
    const openCreationPalette = () => {}, openHiddenPalette = () => {}, toggleSensitiveVisibility = () => {}, followSystem = () => {};
    const openVisibilityPalette = () => {}, openMovePalette = () => {}, pinAction = () => {}, copyText = () => {};
    const togglePalette = () => {}, navigate = () => {}, history = () => {}, focusRail = () => {}, setZoom = () => {};
    const goTo = () => {}, setView = () => {}, openDoc = () => {}, filterEl = {}, zoomFactor = 1, BASE_ZOOM = 1;
    const visibilityRows = () => [], moveTargets = async () => [], previewMoveToSpace = () => {};
    let renderedPages = 0; const renderPalette = () => { renderedPages++; };
    let closed = 0; const closePalette = () => { closed++; }, promptEditor = () => {};
    const openCommandPalette = () => { palMode = 'cmd'; palRows = []; palIndex = 0; };
    // the real error sink and the real run (renderer/nodes.js): a failure inside either row lands where every other
    // action's failure lands, which is what an honest recoverable error has to mean here
    const errors = []; let queue = Promise.resolve(), renders = 0;
    const showError = (e) => { if (e) errors.push((e && e.message) || String(e)); };
    const run = (fn) => (queue = queue.then(fn).then((v) => { showError(null); return v; }, showError));
    const render = () => { renders++; };
    const relatedBy = new Map();
    const relatedStale = new Set(), connected = true, renderSoon = () => {};
    let answer = null, calls = 0, list = [], listFails = null, previews = [];
    const pins = [];
    const tana = { refresh: async () => {}, filters: {}, sensitiveIds: () => {}, pinTo: async (hub, id) => { pins.push([hub, id]); },
      related: async () => ({ pinned: [] }), // the sidebar re-read a pin asks for
      currentMeeting: async () => { calls++; if (answer && answer.fail) throw new Error(answer.fail); return answer; },
      searchPreview: async (filter) => { previews.push(filter); if (listFails) throw new Error(listFails); return list; } };
    ${functionSource('loadRelated')}
    ${functionSource('refreshRelated')}
    ${sourceBetween('const docRow =', 'const NODE_ROW_ORDER')}
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    ${functionSource('paletteRows')}
    ${functionSource('loadMeeting')}
    ${functionSource('pinToMeeting')}
    ${functionSource('pinDocToMeeting')}
    ${sourceBetween('const MEETING_GROUP', 'function openMeetingPicker')}
    ${functionSource('openMeetingPicker')}
    ${functionSource('backPalette')}
    ({ row: (id) => paletteRows('').find((r) => r.id === id),
       open: (next) => { meetingNow = undefined; answer = next; },   // togglePalette('cmd') clears it on every open
       set: (next) => { answer = next; },
       meetings: (rows, fails) => { list = rows; listFails = fails || null; },
       page: (q) => meetingPickRows(q || ''),
       mode: () => palMode,
       escape: () => backPalette(),
       settle: async () => { await queue; await Promise.resolve(); await Promise.resolve(); },
       state: () => ({ pins: [...pins], errors: [...errors], calls, renders, related: [...relatedBy.keys()], stale: [...relatedStale], previews: [...previews], placeholder: palInput.placeholder }),
       track: (hub) => { relatedBy.set(hub, {}); relatedBy.set('${DOC}', {}); } });
  `);

  // 1. The row that finds the meeting itself is now called Pin to current meeting, and keeps the id a recorded key
  //    belongs to.
  api.open({ id: EVENT, title: 'Bingo' });
  assert.deepEqual(plain([api.row('pinToMeeting').label, api.row('pinToMeeting').hint, api.row('pinToMeeting').disabled]), ['Pin to current meeting', 'Checking…', true],
    'it is listed while the lookup is still out, under its new label and its unchanged id');
  await api.settle();
  assert.deepEqual(plain([api.row('pinToMeeting').hint, api.row('pinToMeeting').disabled, api.row('pinToMeeting').icon]), ['Bingo', false, 'pin'], 'once the meeting is known the row names it and is live');
  api.track(EVENT);
  api.row('pinToMeeting').run();
  await api.settle();
  const pinned = api.state();
  assert.deepEqual(plain(pinned.pins), [[EVENT, DOC]], 'it pins the current node on the meeting through the one shared event pin');
  assert.deepEqual(plain(pinned.errors), [], 'and reports nothing wrong');
  assert.deepEqual(plain([pinned.related, pinned.stale]), [[EVENT, DOC], []],
    'the meeting and the node keep their sidebar payloads and are re-read in place, so Pinned lands without the sidebar blanking');
  assert.ok(pinned.renders > 0, 'and the page is redrawn');
  assert.equal(pinned.calls, 2, 'the meeting is looked up again at the press, not taken from the list the row was drawn with');

  // 2. No meeting, and a lookup that failed, read differently — and neither takes the row out of the list a key is
  //    recorded from.
  api.open(null);
  api.row('pinToMeeting');
  await api.settle();
  assert.deepEqual(plain([api.row('pinToMeeting').hint, api.row('pinToMeeting').disabled, api.row('pinToMeeting').id]), ['No active meeting', true, 'pinToMeeting'],
    'with no meeting the row is greyed with the reason rather than vanishing');
  api.open({ fail: 'Not connected to Tana' }); // thrown inside the context: an Error made out here is not one in there
  api.row('pinToMeeting');
  await api.settle();
  assert.deepEqual(plain([api.row('pinToMeeting').hint, api.row('pinToMeeting').disabled]), ['Not connected to Tana', true], 'a broken lookup shows its reason instead of claiming there is no meeting');

  // 3. The meeting ended between opening the palette and pressing: nothing is pinned, and the press says why.
  api.open({ id: EVENT, title: 'Bingo' });
  api.row('pinToMeeting');
  await api.settle();
  const before = api.state().pins.length;
  api.set(null);
  api.row('pinToMeeting').run();
  await api.settle();
  const after = api.state();
  assert.equal(after.pins.length, before, 'a meeting that ended while the palette was open pins nothing');
  assert.deepEqual(plain(after.errors), ['No active meeting to pin to'], 'and the press says so, recoverably');

  // 4. Pin to meeting is the second row: a page of meetings, searchable, ending in the same pin.
  // The page is ordered against the clock, so the list is built from it: a meeting on now, two starting at the same
  // minute, one further out, and two that are over — handed over in an order none of them belongs in.
  const at = (mins, len = 30) => ({ start: new Date(NOW + mins * 60e3).toISOString(), end: new Date(NOW + (mins + len) * 60e3).toISOString() });
  api.meetings([{ id: OTHER, text: 'Bingo', icon: 'meeting', meta: 'Mon 15 Sep 09:00–10:00', ...at(-1560) },        // yesterday, over
    { id: 'tana:event:01j0event20000000000000000', text: 'NTP Sync', icon: 'meeting', meta: 'Fri 11:00–12:00', ...at(30, 60) },
    { id: 'tana:event:01j0event30000000000000000', text: 'Lunch', icon: 'meeting', meta: 'Fri 11:00–12:00', ...at(30, 60) }, // same minute as NTP Sync
    { id: 'tana:event:01j0event40000000000000000', text: 'Foundry weekly', icon: 'meeting', meta: 'Mon 22 Sep 09:00–10:00', ...at(4320) },
    { id: EVENT, text: 'Bingo', icon: 'meeting', meta: 'Fri 08:20–08:30', ...at(-10, 30) },                          // started ten minutes ago, still on
    { id: 'tana:event:01j0event50000000000000000', text: 'Standup', icon: 'meeting', meta: 'Fri 09:00–09:15', ...at(-120, 60) }]);
  const picker = api.row('pinToSelectedMeeting');
  assert.deepEqual(plain([picker.label, picker.hint, picker.keepOpen, picker.disabled]), ['Pin to meeting', 'Choose a meeting', true, null],
    'the second row is named for what it asks and needs no live meeting, so it is never disabled');
  picker.run();
  assert.deepEqual(plain([api.mode(), api.page().map((r) => [r.label, r.disabled])]), ['pinMeeting', [['Loading…', true]]], 'it opens a page of its own, which says it is loading until the list lands');
  await api.settle();
  assert.deepEqual(plain(api.state().previews), [{ types: ['meetings'], participant: 'me', window: 'recent' }],
    'the list is the meetings I take part in from a week back to a week ahead, read through the existing preview path');
  assert.deepEqual(plain(api.page().map((r) => r.label)), ['Bingo', 'NTP Sync', 'Lunch', 'Foundry weekly', 'Standup', 'Bingo'],
    'the meeting on now leads, then the soonest to start (two at the same minute keeping the order they came in) and the one further out, then what is over, most recent first');
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.hint])).slice(0, 2), [['Bingo', 'Fri 08:20–08:30'], ['NTP Sync', 'Fri 11:00–12:00']],
    'and every row still carries the meeting own date and time, which is what tells two meetings of the same name apart');
  assert.deepEqual(plain(api.page('ntp').map((r) => r.label)), ['NTP Sync'], 'typing filters the page with the palette own matcher, without asking again');
  assert.deepEqual(plain(api.page('bingo').map((r) => r.node.id)), [EVENT, OTHER], 'and a query filters that order rather than making one of its own: the live Bingo still leads the one that is over');
  assert.deepEqual(plain(api.page('nothinglikethis')), [], 'a query that matches nothing leaves the palette own No results line to say so');
  api.track(OTHER);
  const reported = api.state().errors.length; // the failed press above left one, and this one must add none
  api.page().find((r) => r.node.id === OTHER).run();
  await api.settle();
  const picked = api.state();
  assert.deepEqual(plain(picked.pins.slice(-1)), [[OTHER, DOC]], 'choosing a meeting pins the node on it through the same shared event pin');
  assert.deepEqual(plain([picked.related.includes(OTHER), picked.stale]), [true, []], 'and re-reads the same two sidebars in place, as the current-meeting row does');
  assert.equal(picked.errors.length, reported, 'with nothing new reported wrong');

  // 5. Escape steps back to the command page rather than closing the palette, and the empty and broken lists say so.
  api.row('pinToSelectedMeeting').run();
  api.escape();
  assert.equal(api.mode(), 'cmd', 'escape on the meeting page goes back to the command page');
  api.meetings([]);
  api.row('pinToSelectedMeeting').run();
  await api.settle();
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.disabled])), [['No meetings in the last week or the week ahead', true]],
    'a workspace with no meetings in the window says that, rather than showing an empty page');
  api.meetings([], 'Not connected to Tana');
  api.row('pinToSelectedMeeting').run();
  await api.settle();
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.disabled])), [['Not connected to Tana', true]], 'and a list that could not be read says why instead of reading as no meetings');
  console.log('ok  Pin to current meeting names the live meeting and re-reads it at the press; Pin to meeting opens a page ordered next-first from the event windows, filtered without reordering, pinning through the same shared write, stepping back on escape and honest when empty or broken');
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
    const localStorage = { setItem() {} }, setPref = () => {}, pref = (k, fb) => fb, render = () => { renders++; };
    // what the page in front of you is showing, for the Clean up row's own condition (shownDocs)
    let shown = [];
    const filterEl = { value: '' }, zoom = null, visibleTags = () => [], viewOf = () => ({ nodes: shown });
    const closePalette = () => {}; // the real runRow closes the palette before it runs a row
    const setViewF = (patch) => { filters.set(view, { ...filters.get(view), ...patch }); render(); };
    const palInput = { value: '', placeholder: '', focus() {} };
    const renderPalette = () => { renders++; };
    ${definitions}
    ${functionSource('pillRows')}
    ${functionSource('pillRowsFor')}
    ${functionSource('openPillPalette')}
    ${functionSource('openCommandPalette')}
    ${functionSource('runRow')}
    ({
      commands: (next) => { view = next; return pillCommandRows().map((row) => [row.id, row.label, row.hint, row.icon]); },
      open: (id) => { openPillPalette(id); return { mode: palMode, rows: pillRows('').map((row) => [row.label, row.hint]) }; },
      pick: (label) => { pillRows('').find((row) => row.label === label).run(); return { mode: palMode, filter: filters.get(view), group: groupPref[view], sort: sortPref[view] }; },
      group: (by) => { groupPref[view] = by; },
      hold: (n) => { holdRow(n); },
      ids: (list) => { shown = list; return pillCommandRows().map((row) => row.id); },
      rows: (list) => { shown = list; return pillCommandRows().map(({ id, label, icon, group, disabled, hint }) => ({ id, label, icon, group, disabled: !!disabled, hint: hint || '' })); },
      press: (list) => { shown = list; const before = renders; runRow(pillCommandRows().find((r) => r.id === 'cleanup')); return renders > before; },
    });
  `);
  assert.deepEqual(plain(api.commands('tasks')), [
    ['pill:status', 'Filter by status', 'In Progress', 'status'], ['pill:assigned', 'Filter by assignee', 'Anyone', 'assigned'],
    ['pill:sort', 'Sort by', 'Default', 'sort'], ['pill:group', 'Group by', 'None', 'group'],
    ['pill:display', 'Display', 'Status, Assigned, Updated', 'field'],
    ['cleanup', 'Clean up', 'Nothing to clean up', 'cleanup'], // always listed, off until a row is held in place
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
  assert.deepEqual(plain(api.commands('library').map(([id]) => id)), ['pill:type', 'pill:status', 'pill:assigned', 'pill:sort', 'pill:group', 'pill:display', 'cleanup'],
    'Library includes its Type filter plus the other applicable pills');
  assert.deepEqual(plain(api.commands('inbox').map(([id]) => id)), ['pill:type', 'pill:status', 'pill:assigned', 'pill:sort', 'pill:group', 'pill:display', 'cleanup'],
    'the Inbox is a state rather than a kind, so it still picks types');
  // Clean up is the header pill as a command row, always listed and greyed out while there is nothing to clean up,
  // running the same action under a fixed id when there is — so a shortcut can be recorded for it beforehand.
  api.commands('tasks'); api.group('status');
  const kept = { id: 'h1', icon: 'task', done: 0, stateType: 'proposed', tags: [] }, going = { id: 'h2', icon: 'task', done: 0, stateType: 'open', tags: [] };
  const cleanupRow = (list) => plain(api.rows(list)).at(-1);
  assert.deepEqual(cleanupRow([kept, going]), { id: 'cleanup', label: 'Clean up', icon: 'cleanup', group: 'View options', disabled: true, hint: 'Nothing to clean up' },
    'Clean up closes the View options rows whatever the page is doing: with no row held in place it is off, and says why');
  assert.equal(api.press([kept, going]), false, 'and running it there does nothing — no release, no redraw');
  api.hold(kept);
  kept.stateType = 'open'; // the status change the row was held across
  assert.deepEqual(cleanupRow([going, kept]), { id: 'cleanup', label: 'Clean up', icon: 'cleanup', group: 'View options', disabled: false, hint: '' },
    'once a kept row sits where the view would not put it, the same row is live and drops the hint');
  assert.equal(api.press([going, kept]), true, 'running it then goes through the shared cleanup path and redraws the page');
  assert.equal(cleanupRow([going, kept]).disabled, true, 'and it let go of the held rows, exactly as pressing the pill does, so the row is grey again');
  // The recorder records against the highlighted row, so a row nothing can land on cannot be given a key. Disabled
  // rows are stepped over — unless they carry a stable id, which is what lets Clean up be given one before it is
  // ever needed. Pressing it is still refused above, so reachable is not runnable.
  const nextPalIndex = vm.runInNewContext(functionSource('nextPalIndex') + '; nextPalIndex;');
  const listed = plain(api.rows([kept, going]));
  assert.equal(listed.at(-1).disabled, true, 'the row is off');
  assert.equal(nextPalIndex(listed, listed.length - 2, 1), listed.length - 1, 'and Down still lands on it, so Cmd+Shift+K has a row to record against');
  assert.equal(nextPalIndex([{ disabled: true }, { disabled: true }], 0, 1), 0, 'while a row with no id and nothing to run is still stepped over');
  api.group('none');
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
    ${source.match(/const siblingBlock = .*/)[0]}
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
  assert.deepEqual(ids(api.tail([row('a', 'written')], doc)), ['a'], 'a document with content ends at its last row: the draft row is somewhere to type, not a blank line kept for show');
  assert.deepEqual(ids(api.tail([row('a', 'written'), row('b', '')], doc)), ['a', 'b'], 'and an empty last row is already somewhere to type');
  assert.deepEqual(ids(api.tail([{ id: 'img', kind: 'block', type: 'image' }], doc)), ['img', 'draft:doc'], 'an image, divider or reference row is not somewhere to type, so that document still gets one');
  assert.deepEqual(ids(api.tail([], { key: 's', docId: 's', node: { id: 'tana:space:1', kind: 'document' } })), [], 'a space lists documents, so it has no draft child');
  // A saved search stays editable so its title can be renamed, so editability cannot be what keeps the draft row away:
  // without its own exclusion, typing there would write outline content onto a document created with none.
  assert.deepEqual(ids(api.tail([], { key: 'q', docId: 'q', node: { id: 'tana:search:1', kind: 'document' } })), [], 'a saved search lists the rows its query returns, so it has no draft child');
  const block = { key: 'doc/b', docId: 'doc', node: { id: 'b', kind: 'block', block: 'paragraph' } };
  assert.deepEqual(ids(api.tail([], block)), ['draft:doc/b'], 'an empty block opens on a draft child');
  const child = row('c', 'child'), parentWithChild = { ...block, node: { ...block.node, hasChildren: true, children: [child] } };
  assert.deepEqual(ids(api.tail([child], parentWithChild)), ['c'], 'a block with children ends at its last child too');
  assert.deepEqual(ids(api.tail([], { ...block, node: { ...block.node, block: 'heading2' } })), [], 'a bare heading does not offer a child its Tana schema cannot store');
  assert.deepEqual(ids(api.tail([], { ...block, node: { ...block.node, block: 'bullet', heading: 2 } })), ['draft:doc/b'], 'a heading inside a list item can still add children');
  // The draft row is drawn as what typing into it will write (materialise), so nothing changes shape under the
  // caret on the first character: after a row, whatever that row makes of a sibling; as a document's first row,
  // plain text; as a block's child, a bullet, since a child is a listItem in Tana's schema.
  const tailBlock = (list, parent) => plain(api.tail(list, parent)).at(-1).block;
  assert.equal(tailBlock([], doc), 'paragraph', 'the first row of a document, with nothing to follow, is plain text');
  assert.equal(tailBlock([{ id: 'img', kind: 'block', type: 'image', block: 'bullet' }], doc), 'bullet',
    'and a row offered after an image is what that row makes of a sibling');
  assert.equal(tailBlock([], block), 'bullet', "a block's child is a listItem whatever its parent is");
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
    const caretOffset = () => 0, startSl = null, startsList = () => false, rebullet = () => {}; // the dash shortcut has its own check
    const palette = { hidden: true };
    const el = {
      textContent: 'a', classList: { toggle: () => {} },
      closest: (sel) => (sel === '.text' ? el : null),
      scrollIntoView: (opts) => { scrolls.push(opts); },
    };
    let handler = null;
    const outline = { addEventListener: (name, fn) => { if (name === 'input') handler = fn; } };
    ${sourceBetween("onRows('input'", "onRows('focusout'")}
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
    const isPinned = () => false; // the pin mark has its own check; here the audience icons are the subject
    const loadMembers = () => {}, memberName = (uri) => (uri === 'tana:user-profile:sam' ? 'Sam' : uri); // the real one answers with the uri until the member list lands
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
        const icons = info ? info.children.filter((icon) => icon.attrs['aria-label'] || icon.attrs['aria-hidden']) : null; // the assignee name span is not an icon
        return { icons: icons ? icons.map((icon) => icon.attrs['aria-label'] || (icon.children[0] || { attrs: {} }).attrs['data-icon']) : null, gaps: icons ? icons.map((icon) => (icon.style.cssText.match(/margin-left:([^;]+)/) || [])[1] || null) : null, pending: info ? info.className.includes('pending') : null, sub: (body.children.find((child) => child.className === 'subtext') || {}).value || null, chips: body.children.filter((child) => child.className === 'chip').length, fetched: [...fetched], observed: observed.map((watched) => watched.dataset.metaFor) };
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
  // Created by: a name on the same sub-line, joined to the creation time rather than repeating the word.
  const made = { ...doc, createdBy: 'tana:user-profile:sam', createdAt: new Date(Date.now() - 2 * 864e5).toISOString() };
  api.display(['status', 'assigned', 'updated', 'creator']);
  assert.equal(row(made, spaceMeta).sub, 'Created by Sam', 'Created by names the maker even when Created is off');
  api.display(['status', 'assigned', 'updated', 'created', 'creator']);
  assert.equal(row(made, spaceMeta).sub, 'Created 2 days ago by Sam', 'and with Created on it is one phrase, not two');
  assert.equal(row(doc, spaceMeta).sub, null, 'a row the graph gave no creator for says nothing at all');
  api.display(['status', 'assigned', 'updated']);
  // Type is the same shape: the chips are a fact about the row, shown only while the pill asks for them.
  const tagged = { ...doc, tags: [{ label: 'Charter' }] };
  api.display(['status', 'assigned', 'updated', 'type']);
  assert.equal(row(tagged, spaceMeta).chips, 1, 'with Type on, a row shows its type chip');
  api.display(['status', 'assigned', 'updated']);
  assert.equal(row(tagged, spaceMeta).chips, 0, 'with Type off, it does not');
  assert.equal(row(doc, { assignees: [], audience: 'unknown' }).icons, null, 'a document with nothing shareable shows nothing at all');
  // A watched node says so on the row: the bell is the only place outside Cmd+K that tells you changes reach you.
  assert.deepEqual(row(doc, { ...spaceMeta, watched: true }).icons, ['Visible to members of Studio LT', 'Stop notifying'], 'a watched row carries a bell after its audience icon');
  assert.deepEqual(row(task, { assignees: ['tana:user-profile:sam'], audience: 'only-me', watched: true }).icons, ['Visible only to you', 'Stop notifying'], 'a task row carries it too');
  assert.deepEqual(row(doc, { assignees: [], audience: 'unknown', watched: true }).icons, ['Stop notifying'], 'and a document with nothing shareable still shows the bell rather than nothing');
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

// Edit pins: the page that says where this document is pinned and takes those pins off again, and the marks every
// row draws from one api.pinIds read (renderer/document.js, renderer/nodes.js).
async function runEditPinsCheck() {
  const api = vm.runInNewContext(`
    const calls = [];
    let state = { sidebar: false, dates: [] }, ids = ['doc'];
    let pinInfo = null, pinnedIds = null, pinnedLoading = null;
    let palDoc = { id: 'doc' }, palMode = 'cmd', palRows = [], palIndex = 3;
    const palette = { hidden: true }, palInput = { value: '', placeholder: '', focus() {} };
    const renderPalette = () => {}, showError = () => {}, run = (fn) => fn();
    const render = () => {}; // the shimmed renderSoon a refreshed mark set asks for
    const tana = {
      pinState: async (id) => { calls.push(['pinState', id]); return state; },
      pinIds: async () => { calls.push(['pinIds']); return [...ids]; },
      pin: async (id, target, date) => { calls.push(['pin', id, target, date]); },
      unpin: async (id, target, date) => { calls.push(['unpin', id, target, date]); },
    };
    ${sourceLine('const localDate =')}
    ${functionSource('fuzzyMatch')}
    ${functionSource('loadPins')}
    ${functionSource('loadPinned')}
    ${functionSource('pinAction')}
    ${sourceBetween('const PIN_GROUP =', 'function openPinsPalette')}
    ${functionSource('openPinsPalette')}
    ({
      open: async (pins, marks) => { state = pins; ids = marks || ids; calls.length = 0; openPinsPalette({ id: 'doc' }); await new Promise(setImmediate); return { palMode, placeholder: palInput.placeholder, hidden: palette.hidden, calls: [...calls] }; },
      page: (q) => editPinRows(q || ''),
      press: async (q, index) => { calls.length = 0; editPinRows(q || '')[index].run(); await new Promise(setImmediate); await new Promise(setImmediate); return [...calls]; },
      marks: () => (pinnedIds ? [...pinnedIds] : null),
      today: () => localDate(),
    });
  `, { setImmediate, Date, Promise });

  const today = api.today();
  const opened = plain(await api.open({ sidebar: true, dates: [today, '2099-01-01'] }, ['doc', 'other']));
  assert.deepEqual([opened.palMode, opened.hidden, opened.placeholder], ['pins', false, 'Edit pins'], 'the page opens in its own mode');
  assert.deepEqual(opened.calls, [['pinIds'], ['pinState', 'doc']], 'it re-reads the marks and asks where this one is pinned');
  assert.deepEqual(plain(api.marks()), ['doc', 'other'], 'the marks every row draws come from that one list');
  assert.deepEqual(plain(api.page().map((r) => [r.icon, r.label, !!r.keepOpen])),
    [['pinned', 'Sidebar', true], ['pinDate', 'Today · ' + today, true], ['pinDate', '2099-01-01', true]],
    'every pin is a row, dates in order and today named');
  assert.deepEqual(plain(api.page().map((r) => r.group)).filter((g, i, all) => all.indexOf(g) === i), ['Pinned · ↩ unpins'], 'one header, which says what Enter does');
  assert.deepEqual(plain(api.page('side').map((r) => r.label)), ['Sidebar'], 'typing narrows the list');
  assert.deepEqual(plain(await api.press('', 0)), [['unpin', 'doc', 'sidebar', null], ['pinIds'], ['pinState', 'doc']], 'the sidebar row unpins and the page re-reads itself');
  assert.deepEqual(plain(await api.press('', 2)), [['unpin', 'doc', 'today', '2099-01-01'], ['pinIds'], ['pinState', 'doc']], 'and a date row unpins that date, not today');

  const none = plain(await api.open({ sidebar: false, dates: [] }, []));
  assert.equal(none.palMode, 'pins');
  assert.deepEqual(plain(api.page().map((r) => [r.label, !!r.disabled])),
    [['Not pinned anywhere', true], ['Pin to sidebar', false], ['Pin to today', false]], 'a node pinned nowhere says so, and the two pins can be made from here');
  assert.deepEqual(plain(await api.press('', 1)), [['pin', 'doc', 'sidebar', null], ['pinIds'], ['pinState', 'doc']], 'the sidebar pin is written from this page');
  assert.deepEqual(plain(api.page('nothing here').map((r) => r.label)), ['Not pinned anywhere', 'Pin to sidebar', 'Pin to today'], 'a query that matches nothing still leaves the page usable');
  assert.match(source, /id: 'editPins'[^}]*'Edit pins'/, 'Cmd+K carries the command that opens it');
  assert.match(source, /palMode === 'pins'/, 'and the palette renders and types in that mode like any other');
  console.log('ok  Edit pins: the page opens with this document\u2019s pins, names today, unpins each of them, offers the two that can be made, and the row marks come from one list');
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
    ${sourceBetween("onRows('focusout'", "onRows('mousedown'")}
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

// The two header arrows are only as good as the state they draw: a Forward that looks live with nothing ahead, or a
// Back that greys out on Home's neighbours, is a button that lies. The moves themselves are runHistoryCheck's.
function runNavButtonsCheck() {
  const api = vm.runInNewContext(`
    ${FAKE_DOM}
    const moves = [];
    const navigate = (dir) => moves.push(dir);
    const iconNode = (name) => makeEl('svg-' + name);
    const hotkeys = {};
    const backBtn = makeEl('button'), fwdBtn = makeEl('button');
    let navBack = [], navForward = [], home = false;
    const atHome = () => home;
    ${RENDER_SHIM}
    ${functionSource('renderNav')}
    ({
      draw: (state) => { navBack = state.back; navForward = state.forward; home = state.home; renderNav(); return [backBtn, fwdBtn].map((el) => ({ disabled: el.disabled, title: el.title, label: el.getAttribute('aria-label'), icons: el.childNodes.length })); },
    });
  `);
  const away = plain(api.draw({ back: [], forward: [], home: false }));
  assert.deepEqual(away.map((b) => b.disabled), [false, true], 'away from Home, Back is live with an empty stack (it lands on Home) and Forward is not');
  assert.deepEqual(away.map((b) => b.label), ['Go back', 'Go forward'], 'each says what it is');
  assert.deepEqual(away.map((b) => b.title), ['Go back ⌘[', 'Go forward ⌘]'], 'and carries the combo that does the same thing');
  assert.deepEqual(away.map((b) => b.icons), [1, 1], 'each is drawn with its arrow');
  const atHome = plain(api.draw({ back: [], forward: [], home: true }));
  assert.deepEqual(atHome.map((b) => b.disabled), [true, true], 'on Home with nothing either way, neither arrow pretends to move');
  const both = plain(api.draw({ back: [{}], forward: [{}], home: true }));
  assert.deepEqual(both.map((b) => b.disabled), [false, false], 'a history in both directions lights both, Home or not');
  assert.deepEqual(both.map((b) => b.icons), [1, 1], 'and a redraw does not stack a second glyph in the button');
}

// The sidebar can be put away by hand, and that preference outlives any document: hiding wins over
// content, so a sidebar you closed does not reopen because the next node happens to have pins.
function runRailToggleCheck() {
  const api = vm.runInNewContext(`
    const store = new Map();
    const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
    const prefs = {}; const pref = (k, fb) => (k in prefs ? prefs[k] : fb); const setPref = (k, v) => { prefs[k] = v; store.set(k, JSON.stringify(v)); };
    let renders = 0;
    let forced = null;
    const render = (force) => { renders++; forced = force === true; };
    let railHidden = pref('railHidden', false) === true;
    ${functionSource('railOff')}
    ${functionSource('toggleRail')}
    ({
      state: () => ({ hidden: railHidden, stored: store.has('railHidden') ? store.get('railHidden') : null, renders, forced }),
      off: (empty) => railOff(empty),
      toggle: () => { toggleRail(); },
    });
  `);
  assert.equal(api.off(false), false, 'a sidebar with something in it is shown by default');
  assert.equal(api.off(true), true, 'an empty sidebar stays hidden whatever the preference says');
  assert.deepEqual(plain(api.state()), { hidden: false, stored: null, renders: 0, forced: null }, 'and nothing is persisted until the user asks for it');
  api.toggle();
  // Cmd+K runs the row after closePalette has put the caret back in the edited row, so a deferrable render would
  // only land when the caret next left: the repaint has to be the forced one.
  assert.deepEqual(plain(api.state()), { hidden: true, stored: 'true', renders: 1, forced: true }, 'hiding it persists the preference and repaints once, forced past the caret');
  assert.equal(api.off(false), true, 'hiding wins over content: a document with pins does not reopen it');
  api.toggle();
  assert.deepEqual(plain(api.state()), { hidden: false, stored: 'false', renders: 2, forced: true }, 'showing it again persists that too');
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
    const stored = {}; // what reached the preference store, so the test can tell a document's own arrangement from a preference
    const localStorage = { setItem: (k, v) => { stored[k] = v; } }, render = () => { renders++; };
    const setPref = (k, v) => { stored[k] = JSON.stringify(v); }, pref = (k, fb) => (k in stored ? JSON.parse(stored[k]) : fb);
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
  // The boot seed (renderer/edit.js), driven as it ships: the page drawn from the stored title before the first paint.
  const seed = source.match(/if \(savedPlace && isRealId\(savedPlace\.docId\)[\s\S]*?\n\}/);
  assert.ok(seed, 'a launch draws the page it is reopening before anything is fetched');
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
    const docOf = (id) => docs.find((d) => d.id === id) || extra.get(id) || null; // what rememberPlace reads the title and glyph off
    const asDoc = (n) => ({ ...n, kind: 'document', text: n.text ?? n.title ?? '', hasChildren: true, icon: n.icon });
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
      seedPlace: () => { ${seed[0]} },
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
      page: () => { const d = zoom && docOf(zoom.docId); return { docId: (zoom && zoom.docId) || null, title: d ? d.text : null, icon: d ? d.icon || null : null }; },
      state: () => ({ docId: (zoom && zoom.docId) || null, nodeId: (zoom && zoom.nodeId) || null, from: (zoom && zoom.from) || null,
                      rendered, fetches, fetched: extra.has('tana:text:far'), summaries: summaries.length }),
    });
  `);
  assert.equal(api.remember({ docId: 'tana:text:a', nodeId: 'n1', from: 'Search' }), JSON.stringify({ docId: 'tana:text:a', nodeId: 'n1', from: 'Search' }),
    'the node you are looking at is remembered as the place to reopen');
  assert.equal(api.remember(null), null, 'a view is not a zoom: the stored place is cleared rather than left stale');
  api.remember({ docId: 'tana:text:a', nodeId: null });
  assert.equal(api.remember({ docId: 'draft:7', nodeId: null }), null, 'a draft id would mean nothing after a restart, so it replaces nothing');
  api.seed([{ id: 'tana:text:a', text: 'Weekly notes', icon: 'doc' }]);
  assert.equal(api.remember({ docId: 'tana:text:a', nodeId: null }), JSON.stringify({ docId: 'tana:text:a', nodeId: null, title: 'Weekly notes', icon: 'doc' }),
    'the page\'s own title and glyph ride along, which is what lets the next launch draw it before anything is fetched');

  // The flash: a launch drew the view behind the place it was about to reopen, then replaced it once the connection
  // came up. The stored title is enough to draw the page itself first, with no connection needed.
  api.reset(); api.seed([]); api.offline();
  api.store(JSON.stringify({ docId: 'tana:text:far', nodeId: null, title: 'Weekly notes', icon: 'doc' }));
  api.seedPlace();
  assert.deepEqual(plain(api.page()), { docId: 'tana:text:far', title: 'Weekly notes', icon: 'doc' },
    'a launch opens on the page it is reopening, drawn from the stored title, before there is a connection to ask');
  await api.start();
  assert.deepEqual(plain(api.page()), { docId: 'tana:text:far', title: 'Weekly notes', icon: 'doc' },
    'and stays there while the connection is still coming up');
  api.online();
  await api.start();
  assert.deepEqual(plain(api.page()), { docId: 'tana:text:far', title: 'Fetched', icon: null },
    'then the real node is read over the stub — the stub is a title, not a document, so extra holding one proves nothing');

  api.reset(); api.seed([]); api.fail();
  api.store(JSON.stringify({ docId: 'tana:text:gone', nodeId: null, title: 'Deleted since' }));
  api.seedPlace();
  await api.start();
  assert.equal(api.state().docId, null, 'a page deleted since the last session takes its stub down again and the launch lands on the view');

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
  assert.match(source, /if \(connected && !wasConnected\) \{ taskMetaFailed\.clear\(\); loadSearches\(\); loadPinned\(true\); restorePlace\(\)\.finally\(\(\) => loadView\(\)\); \}/,
    'the connection coming up runs the restore that boot was too early for, and the view behind it is fetched after that page, not ahead of it');
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
    const segsOf = (n) => (n.segments || (n.text ? [{ text: n.text }] : []));
    ${sourceBetween('const isReference =', 'const referenceLabel =')}
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
  // how the app itself puts a task on a date page (renderer/tasks.js): a block whose whole content is one mention,
  // resolved by main into the same reference a native embed carries
  const refRow = (id) => ({ id, kind: 'block', text: 'Buy milk', segments: [{ mention: { uri: TASK.id, label: 'Buy milk' } }], reference: { uri: TASK.id, node: TASK } });

  assert.deepEqual(plain(api.at({ docs: [TASK], items: [['k', row(TASK, TASK.id)]], focusedKey: 'k' })),
    { on: TASK.id, rows: ['Set status'] }, 'a task listed in a view is the current node when the caret is in it');
  assert.deepEqual(plain(api.at({ zoom: { docId: DATE.id, nodeId: null }, docs: [DATE, TASK],
      items: [['k', row(refRow('n1'), DATE.id)]], focusedKey: 'k' })),
    { on: TASK.id, rows: ['Set status'] }, 'and so is a task referenced from a date page: the row, not the date holding it');
  assert.deepEqual(plain(api.at({ zoom: { docId: DATE.id, nodeId: null }, docs: [DATE],
      items: [['k', row(refRow('n3'), DATE.id)]], focusedKey: 'k' })),
    { on: TASK.id, rows: ['Set status'] }, 'even when that task sits in no view: a referenced document need not be one the app has listed');
  assert.deepEqual(plain(api.at({ zoom: { docId: DATE.id, nodeId: null }, docs: [DATE],
      items: [['k', row({ id: 'n2', kind: 'block', text: 'just a note' }, DATE.id)]], focusedKey: 'k' })),
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
  const harness = (on, group = 'none') => vm.runInNewContext(`
    const DOC = 'tana:text:01examplea0000000000000000';
    const patched = [];
    const patchMeta = (id) => patched.push(id);
    const renderSoon = () => patched.push('deferred render');
    const renderPalette = () => {};
    const groupBy = () => '${group}';
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
    ${functionSource('setNodeNotify')}
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
  })).then(async () => {
    // The one grouping that files a row by its watch state: turning the bell off has to move the row out of
    // Tracking, which the patch alone cannot do, so it is followed by one coalesced render.
    const after = plain(await harness(true, 'responsibility').press());
    assert.deepEqual(after.patched, ['tana:text:01examplea0000000000000000', 'deferred render'],
      'under Group by Responsibility the row is patched and then re-grouped, so a silenced task leaves the Tracking section');
  });
}


// The bell on the row is the second way to turn a watch off: pressing it goes through the same setNodeNotify the
// palette row does, so the node stops notifying without opening Cmd+K. A plain icon span would swallow the press
// into the row's own click and open the node instead, which is how this was reported.
function runNotifyBellCheck() {
  const api = vm.runInNewContext(`
    const DOC = 'tana:text:01examplea0000000000000000';
    const patched = [];
    const patchMeta = (id) => patched.push(id);
    const renderPalette = () => {};
    const groupBy = () => 'none';
    const run = (fn) => fn();
    const notifyById = new Map();
    const taskMetaById = new Map([[DOC, { assignees: [], audience: 'only-me', watched: true }]]);
    let asked = null;
    const tana = { setNotify: async (id, next) => { asked = [id, next]; return { on: next, default: false, explicit: true }; } };
    const iconNode = () => ({ setAttribute() {} });
    const document = { createElement: (tagName) => ({ tagName: tagName.toUpperCase(), children: [], attrs: {}, style: { cssText: '' },
      setAttribute(key, value) { this.attrs[key] = value; },
      append(...kids) { this.children.push(...kids); }, prepend(...kids) { this.children.unshift(...kids); },
      set textContent(value) { this.value = value; }, get textContent() { return this.value || ''; } }) };
    ${functionSource('taskMetaEl')}
    ${functionSource('setNodeNotify')}
    const el = taskMetaEl({ assignees: '', audience: { icon: 'lock', label: 'Visible only to you' }, watched: true }, DOC);
    const bell = el.children[el.children.length - 1];
    let bubbled = 0;
    ({ tag: bell.tagName, label: bell.attrs['aria-label'], role: bell.attrs['role'],
       press: async () => { bell.onclick({ stopPropagation: () => bubbled++ }); await Promise.resolve(); await Promise.resolve();
         return { asked, bubbled, patched, watched: taskMetaById.get(DOC).watched }; } });
  `);
  return (async () => {
    assert.equal(api.tag, 'BUTTON', 'the bell is a button, so it can be pressed and reached from the keyboard');
    assert.equal(api.label, 'Stop notifying', 'and says what pressing it does, rather than only what is true now');
    const after = plain(await api.press());
    assert.deepEqual(after.asked, ['tana:text:01examplea0000000000000000', false], 'pressing it turns the watch off for that node');
    assert.equal(after.bubbled, 1, 'the press does not reach the row underneath, which would open the node instead');
    assert.equal(after.watched, false, 'the cached metadata follows, so the bell goes away');
    assert.deepEqual(after.patched, ['tana:text:01examplea0000000000000000'], 'and the row is patched in place, the way the palette toggle is');
  })();
}


// Handing a node to the local agent from Cmd+K. "Assign to Agent" does not assign: it opens a prompt page inside
// the palette, and only ⌘↩ on something non-blank writes anything. The mark is kept locally, the badge is put on the
// row itself — a deferred render would leave the row as it was, the way the bell did — and taking it back drops the
// prompt with the assignment.
const CODEX_DOC = 'tana:text:01examplea0000000000000000';
function runCodexAssignCheck() {
  const api = vm.runInNewContext(`
    const DOC = '${CODEX_DOC}';
    const codexIds = new Set();
    const rendered = [], sent = [];
    const renderSoon = () => rendered.push('deferred render');
    const renderPalette = () => {};
    const errors = [];
    const showError = (e) => { if (e) errors.push(String(e.message || e)); };
    const run = (fn) => Promise.resolve().then(fn).then(() => showError(null), showError); // the real one (renderer/nodes.js)
    const isRealId = (id) => String(id).startsWith('tana:');
    const palDoc = { id: DOC, text: 'Draft the release notes', kind: 'document', icon: 'task' };
    let refuse = false;
    // main's half, as far as the renderer can see it: the assignment, and the Agent context block it writes on the
    // document — one heading, its children replaced when the node is assigned again.
    const OTHER = 'tana:text:01exampleb0000000000000000';
    const served = new Map([[DOC, [{ id: 'b1', text: 'Something already written', children: [] }]], [OTHER, [{ id: 'b9', text: 'Another page', children: [] }]]]);
    const agentStates = new Map();
    const agentTaskHosts = new Map();
    let agentHosts = [];
    const openedTasks = [];
    const tana = { openCodexTask: async (id) => { openedTasks.push(id); return true; }, setCodex: async (id, on, prompt) => {
      sent.push([id, on, prompt]);
      if (refuse) throw new Error('This node is read-only in the outliner');
      if (on && typeof prompt === 'string' && prompt.trim()) {
        const rows = served.get(id) || [];
        const lines = prompt.trim().split('\\n').map((line) => line.trim()).filter(Boolean).map((text, i) => ({ id: 'ctx' + i, text, children: [] }));
        const head = rows.find((n) => n.text === 'Agent context');
        if (head) head.children = lines; else rows.push({ id: 'head', text: 'Agent context', children: lines });
        served.set(id, rows);
      }
      return !!on;
    } };
    // the palette's own furniture: the single-line field, the editor that replaces it on the prompt page, and the card
    const palette = { hidden: true };
    const palInput = { hidden: false, value: '', focus() {} };
    const focused = { el: null };
    const palText = { name: 'editor', hidden: true, value: '', focus() { focused.el = palText; } };
    const palList = { name: 'rows', tabIndex: 0, focus() { focused.el = palList; } };
    const document_activeElement = () => focused.el;
    const agentModels = ['gpt-5.6-sol', 'anthropic/claude-opus-5'];
    let agentModel = '';
    const runRow = (r) => { if (r && !r.disabled) r.run(); };
    const nextPalIndex = (rows, index, step) => { const n = rows.length; for (let i = 1; i <= n; i++) { const next = ((index + step * i) % n + n) % n; if (!rows[next].disabled) return next; } return index; };
    let palMode = 'cmd', palRows = [], palIndex = 0;
    const closed = [];
    const closePalette = () => { palette.hidden = true; promptEditor(false); closed.push('close'); };
    const openCommandPalette = () => { promptEditor(false); palMode = 'cmd'; closed.push('back to commands'); };
    const openVisibilityPalette = () => { closed.push('visibility'); };
    // enough of a row to patch: one line that holds the badge, and the signature a fresh render would give it
    const line = { children: [], append(...kids) { this.children.push(...kids); },
      querySelector() { const el = this.children.find((kid) => String(kid.className).startsWith('cbadge')); return el ? { ...el, remove: () => { line.children = line.children.filter((kid) => kid !== el); } } : null; } };
    const row = { dataset: { key: DOC, sig: 'sig:false' }, querySelector: () => line };
    const outline = { querySelectorAll: () => [row] };
    const items = new Map([[DOC, { node: { id: DOC, kind: 'document' } }]]);
    const referenceTarget = () => null, rowSig = (n) => 'sig:' + codexIds.has(n.id);
    const docOf = (id) => (id === DOC ? palDoc : null); // the badge reads the node's own state to know the task is finished
    let zoom = null;
    // the zoomed page: the title's own header box, the children cache behind it, and a second document's cache that
    // nothing here may touch
    const head = { children: [], append(...kids) { this.children.push(...kids); },
      querySelector() { const el = this.children.find((kid) => String(kid.className).startsWith('cbadge')); return el ? { ...el, remove: () => { head.children = head.children.filter((kid) => kid !== el); } } : null; } };
    const titleEl = { parentElement: head };
    const copy = (rows) => JSON.parse(JSON.stringify(rows || []));
    const kids = new Map([...served].map(([id, rows]) => [id, copy(rows)])); // the page is already open, with its children cached
    const renders = [];
    const render = (force) => renders.push(force === true ? 'forced' : 'deferred');
    const reload = async (id) => { kids.set(id, copy(served.get(id))); }; // what main answers with now
    const iconNode = () => ({ setAttribute() {} });
    const document = { documentElement: { dataset: {} }, get activeElement() { return focused.el; }, createElement: (tagName) => ({ tagName, attrs: {}, children: [], className: '',
      setAttribute(name, value) { this.attrs[name] = value; }, append(...kids) { this.children.push(...kids); } }) };
    const views = [], pinRows = () => [], selectionRows = () => [];
    const pillCommandRows = () => [], searches = [], goTo = () => {};
    const authed = true, authChecking = false, signedOut = false, pinInfo = null, hotkeys = {};
    const localDate = () => '2026-09-18', setTheme = () => {};
    const docRow = () => ({});
    const railEl = { hidden: true }, navBack = [], navForward = [];
    const railToggle = { hidden: false }, railHidden = false;
    const onSearchPage = () => false; // zoomed into an ordinary document, not a saved search
    // holdRow is renderer/views.js: the row keeps its place, which is what lets the Clean up pill offer the redraw
    const held = [], holdRow = (n) => held.push(n.id);
    const pills = [], renderPills = () => pills.push('pills'); // where Clean up is decided (renderer/pills.js)
    ${functionSource('codexBadgeEl')}
    ${functionSource('codexHeader')}
    ${functionSource('patchCodex')}
    ${sourceBetween('const AGENT_GROUP =', 'function promptEditor(')}
    ${functionSource('promptEditor')}
    ${functionSource('openAgentPrompt')}
    ${functionSource('agentPromptRows')}
    ${functionSource('submitAgentPrompt')}
    ${functionSource('agentPromptKey')}
    ${functionSource('focusModelRows')}
    ${functionSource('agentRowsKey')}
    ${functionSource('backPalette')}
    ${functionSource('paletteRows')}
    const key = (name, mod) => { let stopped = false; return { key: name, metaKey: !!mod, preventDefault() {}, stopPropagation() { stopped = true; }, get stopped() { return stopped; } }; };
    const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); }; // run() is a promise chain, like the real one
    const state = () => ({ mode: palMode, open: !palette.hidden, editor: !palText.hidden, field: !palInput.hidden, prompt: palText.value,
      assigned: codexIds.has(DOC), badges: line.children.filter((kid) => String(kid.className).startsWith('cbadge')).map((kid) => kid.attrs),
      sig: row.dataset.sig, sent: [...sent], rendered: [...rendered], closed: [...closed], errors: [...errors],
      held: [...held], pills: [...pills],
      renders: [...renders], header: head.children.filter((kid) => String(kid.className).startsWith('cbadge')).map((kid) => kid.attrs),
      children: (kids.get(DOC) || []).map((n) => n.text + (n.children.length ? '(' + n.children.map((c) => c.text).join(',') + ')' : '')),
      other: (kids.get(OTHER) || []).map((n) => n.text) });
    ({
      label: () => paletteRows('').find((r) => r.rank === 'codex').label,
      pressRow: async () => { sent.length = 0; closed.length = 0; errors.length = 0; await paletteRows('').find((r) => r.rank === 'codex').run(); await tick(); return state(); },
      type: (text) => { palText.value = text; },
      submitKey: async (name, mod) => { sent.length = 0; errors.length = 0; const e = key(name, mod); const handled = agentPromptKey(e); await tick(); return { handled, stopped: e.stopped, ...state() }; },
      promptRow: () => { const r = agentPromptRows()[0]; return { group: r.group, label: r.label, hint: r.hint, disabled: !!r.disabled }; },
      // the row that sends has to name the machine: the tick is inside a list ⌘↩ from the editor never visits
      runsOn: () => { agentHosts = [{ id: 'local', title: 'This Mac' }, { id: 'h1', title: 'Donut' }];
        const here = agentPromptRows()[0].label;
        agentPromptRows().find((r) => r.label === 'Donut').run();
        const there = agentPromptRows()[0].label;
        agentHost = 'local'; // put the page back as it was, so the assignment below is the one the rest expects
        return { here, there }; },
      refuse: (value) => { refuse = value; },
      // the badge as a way in: linked opens that node's task, pending has nowhere to go
      badge: (linked) => { if (linked) agentStates.set(DOC, 'working'); else agentStates.delete(DOC); const el = codexBadgeEl(DOC); return { role: el.attrs.role, label: el.attrs['aria-label'], tabIndex: el.tabIndex, hasClick: typeof el.onclick === 'function' }; },
      // a finished task still shows its thread, but quietly: the badge class says so, and the stylesheet greys it out
      badgeWhenDone: (done) => { const el = codexBadgeEl(DOC, done); return { className: el.className, label: el.attrs['aria-label'], role: el.attrs.role, hasClick: typeof el.onclick === 'function' }; },
      // the row it is drawn beside is the source: a view cache elsewhere must not decide what this row shows
      badgeFromStaleCache: (done) => { palDoc.done = done ? 1 : 0; const el = codexBadgeEl(DOC, false); palDoc.done = 0; return el.className; },
      // "Go to Agent task" is offered only where both halves hold: assigned now, and a task id known for it
      goRow: (assigned, linked) => { if (assigned) codexIds.add(DOC); else codexIds.delete(DOC); if (linked) agentStates.set(DOC, 'working'); else agentStates.delete(DOC); const r = paletteRows('').find((row) => row.rank === 'codexOpen'); return r ? r.label : null; },
      // where the task runs decides whether there is a way in at all
      onHost: (host) => { codexIds.add(DOC); agentStates.set(DOC, 'working'); if (host) agentTaskHosts.set(DOC, host); else agentTaskHosts.delete(DOC); agentHosts = [{ id: 'h1', title: 'Donut' }];
        const row = paletteRows('').find((r) => r.rank === 'codexOpen'); const el = codexBadgeEl(DOC);
        return { row: row ? row.label : null, disabled: !!(row && row.disabled), role: el.attrs.role, label: el.attrs['aria-label'] }; },
      pressBadge: async (viaKey) => { openedTasks.length = 0; const el = codexBadgeEl(DOC); const e = { key: 'Enter', preventDefault() {}, stopPropagation() {} }; if (viaKey) el.onkeydown(e); else el.onclick(e); await tick(); return [...openedTasks]; },
      // ⇥ from the editor to the model rows and back, with the rows driven by the keys the list answers to
      where: () => (focused.el ? focused.el.name : null),
      tab: () => { palRows = agentPromptRows(); agentPromptKey(key('Tab')); return { focus: focused.el && focused.el.name, group: palRows[palIndex] && palRows[palIndex].group, label: palRows[palIndex] && palRows[palIndex].label }; },
      rows: (name) => { const handled = agentRowsKey(key(name)); return { handled, focus: focused.el && focused.el.name, label: palRows[palIndex] && palRows[palIndex].label, model: agentModel }; },
      zoomInto: (id) => { zoom = id ? { docId: id, nodeId: null } : null; renders.length = 0; codexHeader(); return state(); },
    });
  `);
  return (async () => {
    assert.equal(api.label(), 'Assign to Agent', 'an unassigned node offers to hand itself to the agent');
    const opened = plain(await api.pressRow());
    assert.equal(opened.mode, 'agentPrompt', 'choosing it advances to the prompt page inside the palette');
    assert.deepEqual(opened.sent, [], 'and assigns nothing yet: the page is the question, not the answer');
    assert.equal(opened.assigned, false, 'so the node is not marked while it is being asked about');
    assert.equal(opened.editor, true, 'the multiline editor takes the place of the palette field');
    assert.equal(opened.field, false, 'which is hidden while it does');
    const blank = plain(api.promptRow());
    assert.match(blank.group, /Assign to Agent/, 'the page names itself');
    assert.match(blank.group, /⌘↩ assigns/, 'and says how to send, where the palette puts the line that wraps');
    assert.equal(blank.disabled, true, 'an empty prompt cannot be sent');
    api.type('   \n  ');
    assert.equal(plain(api.promptRow()).disabled, true, 'nor can whitespace');
    const blankSubmit = plain(await api.submitKey('Enter', true));
    assert.deepEqual(blankSubmit.sent, [], '⌘↩ on whitespace assigns nothing');
    api.type('  Draft the release notes\nthen tell me  ');
    assert.equal(plain(api.promptRow()).disabled, false, 'with something to send, the row is live');
    // Reported: a task meant for Donut ran on this Mac. The choice was only ever a tick beside a host row, and ⌘↩
    // from the editor never went near that list, so the destination was invisible at the moment of sending.
    const where = plain(api.runsOn());
    assert.equal(where.here, 'Assign to Agent on This Mac', 'the row that sends names the machine that will take it');
    assert.equal(where.there, 'Assign to Agent on Donut', 'and follows the chosen host, so the destination is read where the press happens');
    const newline = plain(await api.submitKey('Enter', false));
    assert.equal(newline.handled, false, 'a plain ↩ is left to the editor, so it adds a line');
    assert.deepEqual(newline.sent, [], 'and sends nothing');
    const sent = plain(await api.submitKey('Enter', true));
    assert.deepEqual(sent.sent, [[CODEX_DOC, true, 'Draft the release notes\nthen tell me']],
      '⌘↩ stores the prompt, trimmed at the ends and otherwise as typed, and assigns in the same call');
    assert.equal(sent.assigned, true, 'the local mark follows at once rather than waiting for a re-read');
    assert.equal(sent.badges.length, 1, 'the row gains one badge');
    // An assignment whose Codex task has not registered itself yet is pending, in words as well as in colour: the
    // green sweep it used to show claimed a delegation that did not exist.
    assert.equal(sent.badges[0]['aria-label'], 'Agent pending', 'the badge says pending until a task has registered itself');
    assert.equal(sent.badges[0].role, 'img', 'and announced as an image rather than as stray text');
    assert.equal(sent.sig, 'sig:true', 'the row now matches what a fresh render would build');
    // Reported: after assigning, the list was stale — under Group by Responsibility the row belonged in Agent and
    // was still drawn where it was — and no Clean up pill appeared to redraw it. Nothing held the row, so there was
    // nothing to clean up, and nothing asked the pills to look again.
    assert.deepEqual(sent.held, [CODEX_DOC], 'the row is held where it sits, so it does not jump away from the pointer');
    assert.equal(sent.pills.length, 1, 'and the pills are asked again, which is where Clean up decides to appear');
    // The context block is content main wrote by itself, on a page that is already open with its children cached.
    // The live change does say so, but the palette hands the caret back and that render is deferred — so this was
    // invisible until the page was reopened, which is how it was reported.
    assert.deepEqual(sent.children, ['Something already written', 'Agent context(Draft the release notes,then tell me)'],
      'the open page is re-asked, so the context is on it, once, with the prompt under it');
    assert.deepEqual(sent.other, ['Another page'], 'and no other page was thrown away to get it');
    assert.equal(sent.renders.at(-1), 'forced', 'drawn rather than deferred: a caret in a row must not hide the answer');
   assert.deepEqual(sent.rendered, [], 'the row itself is patched: a deferred render would leave the badge off until the caret left');
    assert.deepEqual(sent.closed, ['close'], 'and the palette closes, as every other action that finishes does');
    assert.equal(sent.editor, false, 'the editor is put away');
    assert.equal(sent.prompt, '', 'and emptied, so the next node is asked about from scratch');
    // Escape on the prompt page: back to the commands, with nothing written
    assert.equal(api.label(), 'Unassign from Agent', 'the row now says how to take it back');
    const back = plain(await api.pressRow());
    // the third argument is the prompt, absent here and null by the time it comes back through JSON
    assert.deepEqual(back.sent, [[CODEX_DOC, false, null]], 'and taking it back needs nothing typed');
    assert.equal(back.assigned, false, 'the mark is dropped');
    assert.equal(back.badges.length, 0, 'and the badge goes with it');
    const reopened = plain(await api.pressRow());
    assert.equal(reopened.mode, 'agentPrompt', 'assigning again asks again');
    api.type('never mind');
    const escaped = plain(await api.submitKey('Escape', false));
    assert.equal(escaped.handled, true, 'Escape is the page\'s own key');
    assert.deepEqual(escaped.sent, [], 'and leaves without assigning');
    assert.deepEqual(escaped.closed, ['close'], 'it cancels the whole assignment: the palette closes rather than stepping back a level');
    assert.equal(escaped.open, false, 'so Cmd+K is gone, not showing the commands again');
    assert.equal(escaped.prompt, '', 'the typed prompt is dropped with the page');
    assert.equal(escaped.assigned, false, 'and nothing was stored');
    // The context goes into the Tana document before anything local is written, so a refused write must leave no
    // badge behind: a node would otherwise look handed over while carrying nothing about it.
    api.refuse(true);
    const reopen = plain(await api.pressRow());
    assert.equal(reopen.mode, 'agentPrompt');
    api.type('Write the release notes');
    const refused = plain(await api.submitKey('Enter', true));
    assert.equal(refused.assigned, false, 'a write the document refuses assigns nothing');
    assert.equal(refused.badges.length, 0, 'and leaves no badge claiming a handoff that did not happen');
    assert.deepEqual(refused.errors, ['This node is read-only in the outliner'], 'the reason is shown rather than swallowed');
    // ⇥ reaches the model picker without leaving the keyboard, and ⇥ again gives the caret back.
    api.refuse(false);
    await api.pressRow();
    api.type('Summarise this');
    const crossed = plain(api.tab());
    assert.equal(crossed.focus, 'rows', 'Tab moves from the editor to the model rows');
    assert.equal(crossed.group, 'Model for this task', 'landing on the models rather than the submit row');
    assert.equal(crossed.label, 'Codex default', 'starting at the default');
    const moved = plain(api.rows('ArrowDown'));
    assert.equal(moved.handled, true, 'the rows answer the arrows themselves');
    assert.equal(moved.label, 'gpt-5.6-sol', 'so a model can be reached');
    const chosen = plain(api.rows('Enter'));
    assert.equal(chosen.model, 'gpt-5.6-sol', 'Enter chooses it for this assignment');
    assert.equal(chosen.focus, 'rows', 'and the list keeps the keyboard, so another can be tried');
    const returned = plain(api.rows('Tab'));
    assert.equal(returned.focus, 'editor', 'Tab again goes back to what you were writing');
    // The badge is the way into the task it stands for — everywhere it is drawn, since both places build it here.
    const pending = plain(api.badge(false));
    assert.equal(pending.role, 'img', 'a pending badge is not a button: there is no task to open yet');
    assert.equal(pending.tabIndex, undefined, 'so the keyboard does not stop on it');
    assert.equal(pending.hasClick, false, 'and pressing it does nothing');
    const live = plain(api.badge(true));
    assert.equal(live.role, 'button', 'a linked badge is a button');
    // the state itself comes from the task (sdk-check pins that table); what matters here is that the way in is named
    assert.match(live.label, /^Agent .*, open the Codex task$/, 'and says so, for anyone not seeing the colour');
    assert.equal(live.tabIndex, 0, 'reachable by keyboard');
    assert.deepEqual(plain(await api.pressBadge(false)), [CODEX_DOC], 'clicking it opens that node\'s own task');
    assert.deepEqual(plain(await api.pressBadge(true)), [CODEX_DOC], 'and Enter does the same');
    // Asked for: a completed task's thread should stop shouting. The badge stays, and stays a way in, but the class
    // that greys it out is on it.
    const finished = plain(api.badgeWhenDone(true));
    assert.match(finished.className, /\bcbadge\b.*\bclosed\b/, 'a completed task greys its badge down to an outline');
    assert.equal(finished.role, 'button', 'it is still the way into the task');
    assert.doesNotMatch(plain(api.badgeWhenDone(false)).className, /\bclosed\b/, 'an open task keeps the colour of its state');
    // Reported: completed rows stayed green. The badge asked docOf, which answers with the first copy of the node in
    // any view's cache — a view that had not refreshed still held it open — so the row it sits on decides instead.
    assert.doesNotMatch(plain(api.badgeFromStaleCache(true)), /\bclosed\b/, 'the row it is drawn beside outranks any cached copy of the node');
    // The row used to read a snapshot alone, so an unassigned node kept offering it until the next status read.
    assert.equal(api.goRow(true, true), 'Go to Agent task', 'an assigned node with a task offers the way in');
    assert.equal(api.goRow(false, true), null, 'an unassigned node does not, however stale the status map is');
    assert.equal(api.goRow(true, false), null, 'nor does an assigned node whose task is not known yet');
    assert.equal(api.goRow(false, false), null, 'and a node with neither says nothing');
    // A task on this machine can be opened; one on another machine says where it is instead of pretending.
    const here = plain(api.onHost('local'));
    assert.equal(here.row, 'Go to Agent task', 'a local task offers the way in');
    assert.equal(here.disabled, false);
    assert.equal(here.role, 'button', 'and its badge is a button');
    const away = plain(api.onHost('h1'));
    assert.equal(away.row, 'Agent task is on Donut', 'a task elsewhere names its machine');
    assert.equal(away.disabled, true, 'and cannot be run, because there is no route from here');
    assert.equal(away.role, 'img', 'its badge is not a button either');
    assert.match(away.label, /on Donut$/, 'but it says where the work is, for anyone not seeing the colour');
    // Zoomed into the node itself: the same badge, from the same element, beside the title. It goes on and comes off
    // as the assignment does, patched in place for the same reason the row's badge is.
    api.refuse(false);
    const opened2 = plain(await api.pressRow());
    assert.equal(opened2.mode, 'agentPrompt');
    api.type('Summarise the thread\nand draft a reply');
    const assignedAgain = plain(await api.submitKey('Enter', true));
    assert.deepEqual(assignedAgain.children, ['Something already written', 'Agent context(Summarise the thread,and draft a reply)'],
      'assigning again replaces the context block\'s children rather than adding a second block');
    const zoomed = plain(api.zoomInto(CODEX_DOC));
    assert.equal(zoomed.header.length, 1, 'opening an assigned node shows the badge beside its title');
    assert.match(zoomed.header[0]['aria-label'], /^Agent pending/, 'with the same wording the row\'s badge carries');
    const zoomedElsewhere = plain(api.zoomInto('tana:text:01exampleb0000000000000000'));
    assert.equal(zoomedElsewhere.header.length, 0, 'a page nobody handed to the agent says nothing');
    api.zoomInto(CODEX_DOC);
    const takenBack = plain(await api.pressRow());
    assert.equal(takenBack.assigned, false);
    assert.equal(takenBack.header.length, 0, 'unassigning while the page is open takes the badge off it at once');
    assert.deepEqual(takenBack.renders, [], 'and does so by patching the header, not by redrawing the page');
    assert.deepEqual(takenBack.held.slice(-1), [CODEX_DOC], 'taking it back holds the row too: it leaves Agent the same way it arrived');
    assert.ok(takenBack.pills.length > sent.pills.length, 'and asks the pills again, so Clean up follows either direction');
    const backOn = plain(await api.pressRow());
    assert.equal(backOn.mode, 'agentPrompt');
    api.type('Once more');
    const again = plain(await api.submitKey('Enter', true));
    assert.equal(again.header.length, 1, 'and assigning while it is open puts it back on without reopening anything');
  })();
}

// The Refresh pill answers a press before its query does: one turn of the glyph, through the pill's own refresh
// path rather than a second one, restartable, and — the part that was reported as "I can hardly see it" — not cut
// off by its own answer. The redraw builds a new pill, so an answer that lands in 80 ms used to replace the icon a
// tenth of the way round. The query still goes out first; only the redraw waits.
// ---- a saved search folds its pills away behind the header button (renderer/pills.js) ----
// Two things here are worth a check rather than an eye: the row may only go once the last pill has finished leaving,
// and unsaved edits have to hold it open whatever the button was last set to, or Save would be out of reach.
function runPillsFoldCheck() {
  const api = vm.runInNewContext(`
    let dirty = false, redrawn = 0, reduced = false;
    const log = [];
    const matchMedia = (query) => ({ matches: reduced && query.includes('reduce') });
    const mkEl = (id) => {
      const classes = new Set(), handlers = [];
      return { id, hidden: false, childNodes: [], children: [], attrs: {}, style: { setProperty() {} },
        classList: { add: (...n) => { n.forEach((x) => classes.add(x)); log.push(id + ' add ' + n.join(' ')); },
          remove: (...n) => { n.forEach((x) => classes.delete(x)); log.push(id + ' remove ' + n.join(' ')); },
          contains: (n) => classes.has(n) },
        get offsetWidth() { log.push(id + ' reflow'); return 0; },
        get lastElementChild() { return this.children[this.children.length - 1] || null; },
        addEventListener: (type, fn, opts) => handlers.push({ type, fn, once: !!(opts && opts.once) }),
        removeEventListener: (type, fn) => { const at = handlers.findIndex((h) => h.type === type && h.fn === fn); if (at >= 0) handlers.splice(at, 1); },
        fire: (type, event) => { for (const h of handlers.filter((h) => h.type === type)) { if (h.once) handlers.splice(handlers.indexOf(h), 1); h.fn(event); } },
        setAttribute(name, value) { this.attrs[name] = String(value); },
        append(...kids) { this.childNodes.push(...kids); },
        replaceChildren(...kids) { this.childNodes = kids; this.children = kids; } };
    };
    const box = mkEl('pills'), toggleEl = mkEl('pillsToggle'), cleanupEl = mkEl('navCleanup');
    cleanupEl.hidden = true; // index.html ships it hidden, and whether it was is how it knows it has just turned up
    const fill = (n) => { box.replaceChildren(...Array.from({ length: n }, () => mkEl('pill'))); box.hidden = false; };
    fill(3);
    const stored = {};
    const pref = (k, fb) => (k in stored ? stored[k] : fb), setPref = (k, v) => { stored[k] = v; };
    const \$ = (id) => (id === 'pills' ? box : id === 'navCleanup' ? cleanupEl : toggleEl);
    const renderPills = () => { redrawn++; };
    const iconNode = () => mkEl('svg');
    const searchDirty = () => dirty;
    const cleanupNow = () => {};
    let menu = { id: 'status', index: 0 };
    ${sourceBetween('const stillPreferred =', 'function playOnce(')}
    ${functionSource('playOnce')}
    ${sourceBetween('const pillsToggle =', 'function unfoldPills')}
    ${functionSource('unfoldPills')}
    ${functionSource('foldPills')}
    ${functionSource('afterSlide')}
    ${sourceBetween('const cleanupBtn =', 'function menuRows')}
    const state = () => ({ log: [...log], hidden: box.hidden, out: box.classList.contains('out'),
      sliding: box.classList.contains('sliding'), folding: box.classList.contains('folding'),
      rows: box.children.length, menu: !!menu, label: toggleEl.attrs['aria-label'], pressed: toggleEl.attrs['aria-pressed'], stored: { ...stored } });
    ({
      open: () => pillsShown(),
      press: () => { log.length = 0; toggleEl.onclick(); return { redrawn, shown: pillsShown() }; },
      toggleFor: (available) => { renderPillsToggle(available); return { ...state(), button: toggleEl.hidden }; },
      fold: (pressed = true) => { log.length = 0; pillsPressed = pressed; foldPills(box); pillsPressed = false; return state(); },
      unfold: () => { log.length = 0; fill(3); unfoldPills(box); return state(); },
      end: () => { const last = box.lastElementChild; if (last) last.fire('animationend'); return state(); },
      settle: (property) => { box.fire('transitionend', { propertyName: property || 'height' }); return state(); },
      reopen: () => { box.classList.remove('out'); return state(); },
      cleanup: (available) => { renderCleanupBtn(available); return { hidden: cleanupEl.hidden, in: cleanupEl.classList.contains('in'), out: cleanupEl.classList.contains('out'), glyphs: cleanupEl.childNodes.length, label: cleanupEl.attrs['aria-label'] }; },
      cleanupEnd: () => { cleanupEl.fire('animationend'); return { hidden: cleanupEl.hidden, in: cleanupEl.classList.contains('in'), out: cleanupEl.classList.contains('out') }; },
      setDirty: (value) => { dirty = value; },
      setReduced: (value) => { reduced = value; },
    });
  `);
  assert.equal(api.open(), false, 'a saved search opens with its pills folded away: the query is already its title');
  assert.equal(plain(api.toggleFor(true)).label, 'Show search options', 'and the button beside back and forward says what it will do');
  assert.equal(plain(api.toggleFor(false)).button, true, 'off a saved search there is nothing to fold, so the button is not there');
  // Closing: the pills leave one after another and the row goes only when the last of them is gone. Hiding it on the
  // press would take the animation off screen halfway through.
  const folding = plain(api.fold());
  assert.equal(folding.out, true, 'the press starts them leaving');
  assert.equal(folding.hidden, false, 'and the row is still there while they do');
  assert.equal(folding.menu, false, 'an open pill menu closes with them');
  // The row's height is the last thing to move: hiding it the moment the pills were gone took a whole line of the
  // outline out from under the page in one frame, which is what read as a jump.
  const empty = plain(api.end());
  assert.deepEqual([empty.hidden, empty.folding], [false, true], 'with the last pill gone the row closes its own height, still on screen while it does');
  assert.equal(plain(api.settle('margin-bottom')).hidden, false, 'and the margin travelling with it does not answer for it: it is the height that says when this is over');
  const gone = plain(api.settle());
  assert.deepEqual([gone.hidden, gone.out, gone.sliding, gone.rows], [true, false, false, 0], 'only once the height is down does the row go, taking nothing visible with it');
  // Re-opened while they were leaving: the row is on screen and staying, so the close it interrupted must not hide it
  // underneath the pills that have just been drawn back into it.
  api.unfold(); api.settle(); api.fold();
  api.reopen();
  api.end();
  assert.equal(plain(api.settle()).hidden, false, 'a row re-opened mid-flight is not hidden by the close it interrupted');
  const arriving = plain(api.unfold());
  assert.deepEqual(arriving.log.filter((line) => line.startsWith('pills ')),
    ['pills remove sliding folding', 'pills add sliding folding', 'pills reflow', 'pills remove folding'],
    'opening lays the row out closed and then lets it go, so the height grows from nought rather than appearing');
  assert.deepEqual([arriving.sliding, arriving.folding], [true, false], 'so the row is moving, and moving open');
  assert.equal(plain(api.settle()).sliding, false, 'the clipping comes off at the end, or a pill menu could not hang out of the row');
  // Unsaved edits: the Save pill lives in this row, so a staged change holds it open and the button offers to hide
  // rather than to show. Pressing it there is still a request to fold, which a Save makes good on.
  api.setDirty(true);
  assert.equal(api.open(), true, 'a staged edit keeps the pills open: Save is one of them');
  assert.equal(plain(api.toggleFor(true)).pressed, 'true', 'and the button reads as open, because it is');
  assert.equal(api.press().shown, true, 'pressing it there cannot take Save off the screen: the edit still holds the row open');
  api.setDirty(false);
  assert.equal(api.open(), false, 'but the press was recorded, so the row folds away the moment the edit is saved');
  assert.equal(plain(api.toggleFor(true)).stored.pillsOpen, false, 'the choice is a preference, so it follows you between machines');
  // Reduced motion: nothing animates, so nothing is waited for either.
  api.setReduced(true);
  api.unfold();
  assert.equal(plain(api.fold()).hidden, true, 'under reduced motion the row is hidden on the press rather than waiting for an animation that never runs');
  // A reload, a link, the Library: the page is drawn as it stands. Only the press moves the row, which is what the
  // movement is there to answer.
  api.setReduced(false);
  api.unfold();
  assert.equal(plain(api.fold(false)).hidden, true, 'a fold nobody pressed is drawn folded, not played out');
  // Clean up is a header button that comes and goes with the rows a status change keeps in place, so it arrives with
  // a pop and shrinks away again. Hiding it on the way out is what the animation is waiting for; a button that
  // becomes wanted again while it is leaving has to stay, and the animation still running must not take it away.
  api.setReduced(false);
  cleanupEl_start: {
    const up = plain(api.cleanup(true));
    assert.deepEqual([up.hidden, up.in, up.glyphs, up.label], [false, true, 1, 'Clean up'], 'a row kept in place brings the button in with a pop');
    const staying = plain(api.cleanup(true));
    assert.equal(staying.in, true, 'and the renders that merely keep it there leave that alone');
    const going = plain(api.cleanup(false));
    assert.deepEqual([going.hidden, going.out, going.in], [false, true, false], 'nothing left to clean up: it leaves, and is still on screen while it does');
    const gone = plain(api.cleanupEnd());
    assert.deepEqual([gone.hidden, gone.out], [true, false], 'and is hidden only once that has played');
    api.cleanup(true);
    api.cleanup(false);
    const back = plain(api.cleanup(true));
    assert.deepEqual([back.hidden, back.out, back.in], [false, false, true], 'wanted again while it was leaving, it stays and pops back');
    assert.equal(plain(api.cleanupEnd()).hidden, false, 'and the animation it interrupted cannot hide it afterwards');
  }
  api.setReduced(true);
  api.cleanup(true);
  assert.equal(plain(api.cleanup(false)).hidden, true, 'under reduced motion it goes at once rather than waiting for an animation that never runs');
  api.setReduced(false);
}

function runRefreshSpinCheck() {
  const api = vm.runInNewContext(`
    const DOC = 'tana:search:01exampleq0000000000000000';
    const asked = [], log = [];
    let reduced = false, available = true, staged = false;
    const matchMedia = (query) => ({ matches: reduced && query.includes('reduce') });
    const mkEl = (tagName) => {
      const classes = new Set();
      return { tagName, hidden: false, childNodes: [], attrs: {},
        classList: { add: (...names) => { names.forEach((name) => classes.add(name)); log.push('add ' + names.join(' ')); },
          remove: (...names) => { names.forEach((name) => classes.delete(name)); log.push('remove ' + names.join(' ')); },
          contains: (name) => classes.has(name) },
        get offsetWidth() { log.push('reflow'); return 0; },
        setAttribute(name, value) { this.attrs[name] = String(value); },
        append(...kids) { this.childNodes.push(...kids); },
        get firstChild() { return this.childNodes[0] || null; } };
    };
    const button = mkEl('button');
    const \$ = () => button;
    const iconNode = () => mkEl('svg');
    const zoom = { docId: DOC };
    const releaseHeld = () => asked.push('release');
    const run = (fn) => fn();
    const reload = async (id) => asked.push('reload ' + id); // the fastest answer there is: back within the same tick
    const render = (force) => asked.push('render ' + force);
    ${sourceBetween('const stillPreferred =', 'function playOnce(')}
    ${functionSource('playOnce')}
    ${sourceBetween('const refreshBtn =', '// Clean up: let go of the rows')}
    const state = () => ({ log: [...log], asked: [...asked], hidden: button.hidden, glyphs: button.childNodes.length,
      label: button.attrs['aria-label'], spinning: !!button.firstChild && button.firstChild.classList.contains('spin') });
    ({
      draw: (offered) => { log.length = 0; renderRefreshBtn(offered); return state(); },
      press: async () => { log.length = 0; asked.length = 0; button.onclick(); for (let i = 0; i < 5; i++) await Promise.resolve(); return state(); },
      setReduced: (value) => { reduced = value; },
    });
  `, { Promise });
  return (async () => {
    const drawn = plain(api.draw(true));
    assert.deepEqual([drawn.hidden, drawn.glyphs, drawn.label], [false, 1, 'Refresh'], 'a saved search is offered Refresh beside the fold button, as a named glyph');
    assert.equal(plain(api.draw(true)).glyphs, 1, 'and a redraw keeps the glyph it already has, so a turn in progress is not thrown away');
    assert.equal(plain(api.draw(false)).hidden, true, 'a page with nothing to re-ask is not offered it');
    api.draw(true);
    const pressed = plain(await api.press());
    assert.equal(pressed.spinning, true, 'pressing Refresh turns the glyph');
    assert.deepEqual(pressed.asked, ['release', 'reload tana:search:01exampleq0000000000000000', 'render true'],
      'the rows kept in place are let go, the query goes out, and the page is drawn the moment it answers — the turn finishes on its own, on a button no redraw rebuilds');
    const again = plain(await api.press());
    assert.deepEqual(again.log, ['remove spin', 'reflow', 'add spin'],
      'a second press restarts the turn: dropped, laid out again, re-added — without the reflow in between the class never leaves and nothing moves');
    api.setReduced(true);
    const still = plain(await api.press());
    assert.equal(still.spinning, false, 'under reduced motion nothing turns');
    assert.deepEqual(still.asked, ['release', 'reload tana:search:01exampleq0000000000000000', 'render true'],
      'and the refresh is drawn as soon as it answers, exactly as it is with the turn');
  })();
}

// ---- ⌘K → Create Task: the draft page has to be drawn, or nothing is created ----
// The palette hands the caret back to the row it was opened from (closePalette → returnFocus), and render() defers
// while a row holds the caret. startCreation used the deferring one, so the draft page was never drawn: the caret
// never reached its title, the characters typed next went to the old row, and the local empty draft sat in the view
// looking like a node that had been created. Nothing reached Tana, so nothing refreshed either.
async function runCreateTaskFlowCheck() {
  const makeHarness = () => {
    const context = {};
    vm.runInNewContext(`
      const listeners = {}, created = [], saved = [];
      const rowEl = { isContentEditable: true, dataset: { key: 'tana:text:01j0row000000000000000000' }, textContent: 'existing' };
      const titleEl = { isContentEditable: false, dataset: { key: '' }, textContent: '', classList: { remove: () => {} },
        addEventListener: (name, fn) => { listeners[name] = fn; } };
      const outline = { contains: (el) => el === rowEl };
      const palInput = { blur: () => { document.activeElement = null; } };
      const document = { activeElement: palInput }; // the palette field has the keys while a row is run
      const views = [{ id: 'library', title: 'Library', nodes: [{ id: rowEl.dataset.key, kind: 'document', text: 'existing' }] }];
      const items = new Map(), kids = new Map(), fresh = new Map(), open = new Map();
      const localStorage = { setItem: () => {}, getItem: () => null };
      let view = 'library', zoom = null, palette = { hidden: false }, palTimer = null, pinCtx = null, pillCtx = null;
      let palReturn = { key: rowEl.dataset.key, offset: 8 }; // ⌘K was opened with the caret in that row
      let renderDeferred = false, rendering = false, selectionFrozen = false, renders = 0, draftSeq = 0, slashCtx = null;
      const clearTimeout = () => {}, cancelLink = () => {}, promptEditor = () => {}, loadView = () => {};
      const markFalling = () => {}, refreshRowChrome = () => {}, renderPills = () => {}, \$ = () => ({ hidden: true });
      const showError = () => {}, flush = () => {};
      const run = (fn) => fn();
      const tana = { createDocument: async (title, opts) => { created.push([title, opts.kind]); return { id: 'tana:text:01j0made00000000000000000', title, icon: 'task', done: 0 }; } };
      const sectionOf = (docId) => views.find((s) => s.nodes.some((n) => n.id === docId));
      const viewOf = () => views.find((s) => s.id === view) || views[0];
      const scheduleSave = (item, segs) => { saved.push([item.key, segs]); };
      const render = (force) => renderReal(force);
      // What the page draw means for this flow: the zoomed document becomes the item behind the editable title.
      const renderOutline = () => {
        renders++;
        const parent = zoom && views.flatMap((s) => s.nodes).find((n) => n.id === zoom.docId);
        if (!parent) { titleEl.isContentEditable = false; titleEl.dataset.key = ''; return; }
        items.set(parent.id, items.get(parent.id) || { key: parent.id, docId: parent.id, node: parent });
        items.get(parent.id).node = parent;
        titleEl.isContentEditable = true; titleEl.dataset.key = parent.id; titleEl.textContent = parent.text;
      };
      const focused = () => { const el = document.activeElement;
        if (el === titleEl && titleEl.isContentEditable) return { key: titleEl.dataset.key, offset: 0 };
        return el === rowEl ? { key: rowEl.dataset.key, offset: 0 } : null; };
      const placeCaret = (key) => { if (key === rowEl.dataset.key) document.activeElement = rowEl; else if (key && key === titleEl.dataset.key && titleEl.isContentEditable) document.activeElement = titleEl; };
      const setCaret = (el) => { if (el.isContentEditable) document.activeElement = el; }; // focus() on a non-editable element moves nothing
      ${functionSource('editingRow')}
      ${functionSource('render').replace('function render(', 'function renderReal(')}
      ${functionSource('returnFocus')}
      ${functionSource('closePalette')}
      ${sourceBetween('function draftDocNode(', '// a tag chip')}
      ${functionSource('creationSection')}
      ${functionSource('startCreation')}
      ${functionSource('dropDraft')}
      ${functionSource('materialise')}
      ${sourceBetween("titleEl.addEventListener('input'", "titleEl.addEventListener('keydown'")}
      Object.assign(globalThis, {
        create: () => startCreation({ id: 'task', kind: 'task', title: 'Task', icon: 'task', selectable: true }),
        type: (text) => { if (document.activeElement !== titleEl) return false; titleEl.textContent += text; listeners.input(); return true; },
        leave: () => { document.activeElement = null; listeners.blur(); },
        state: () => ({ renders, deferred: renderDeferred, titleKey: titleEl.dataset.key, caretInTitle: document.activeElement === titleEl,
          created, saved, fresh: [...fresh.keys()],
          rows: views[0].nodes.map((n) => ({ id: n.id, text: n.text || '', draft: !!n.draft })) }),
      });
    `, context);
    return context;
  };

  const typed = makeHarness();
  typed.create();
  const opened = plain(typed.state());
  assert.equal(opened.renders, 1, 'Create Task draws its page even though the palette just put the caret back in a row');
  assert.equal(opened.deferred, false, 'the page draw is not deferred behind the caret it is about to move');
  assert.equal(opened.caretInTitle, true, 'and the caret lands in the new page title, where the next character is meant to go');
  assert.equal(opened.rows[0].draft, true, 'the draft is in the view, local until it has a title');
  assert.equal(opened.titleKey, opened.rows[0].id, 'the title edits the draft, not the page that was open before');

  assert.equal(typed.type('S'), true, 'the first character reaches the draft title');
  await new Promise(setImmediate);
  const made = plain(typed.state());
  assert.deepEqual(made.created, [['S', 'task']], 'that character creates the task, once, with the kind that was chosen');
  assert.deepEqual(made.rows.map((r) => [r.id, r.draft]), [['tana:text:01j0made00000000000000000', false], ['tana:text:01j0row000000000000000000', false]],
    'the created task takes the draft\'s place in the view: no empty node is left behind');
  assert.deepEqual(made.fresh, ['tana:text:01j0made00000000000000000'], 'and it is held in place until the roots query lists it, so the view shows it without waiting for the index');
  typed.type('hip it');
  assert.deepEqual(plain(typed.state()).saved, [['tana:text:01j0made00000000000000000', [{ text: 'Ship it' }]]],
    'the rest of the title is saved against the created document, not the draft');

  const cancelled = makeHarness();
  cancelled.create();
  cancelled.leave();
  const gone = plain(cancelled.state());
  assert.deepEqual(gone.created, [], 'leaving the title empty creates nothing');
  assert.deepEqual(gone.rows.map((r) => r.id), ['tana:text:01j0row000000000000000000'], 'and leaves no empty row behind');
}

// ⇧⌘⌫ on a draft: it has no Tana id, and main reads a local one as "not connected to Tana", so asking whether it may
// be deleted put a connection error in front of the user for a node that was never created.
async function runDraftDocumentDeleteCheck() {
  const context = {};
  vm.runInNewContext(`
    const calls = [];
    const draft = { id: 'draftdoc:1', kind: 'document', text: '', draft: 'task' };
    const real = { id: 'tana:text:01j0real00000000000000000', kind: 'document', text: 'Ship it' };
    const views = [{ id: 'library', nodes: [draft, real] }];
    const open = new Map();
    const sectionOf = (docId) => views.find((s) => s.nodes.some((n) => n.id === docId));
    const canEditItem = () => true;
    const tana = { deleteDocument: async (id) => { calls.push(['deleteDocument', id]); },
      accessOptions: async (id) => { calls.push(['accessOptions', id]); return { deletable: true }; } };
    const run = (fn) => fn();
    const flush = () => {}, invalidateNode = (id) => calls.push(['invalidateNode', id]), loadRoots = async () => {}, render = () => {};
    ${functionSource('dropDraft')}
    ${functionSource('removeDocument')}
    Object.assign(globalThis, {
      removeDraft: () => removeDocument({ key: draft.id, docId: draft.id, node: draft }),
      removeReal: () => removeDocument({ key: real.id, docId: real.id, node: real }),
      state: () => ({ calls, rows: views[0].nodes.map((n) => n.id) }),
    });
  `, context);
  await context.removeDraft();
  assert.deepEqual(plain(context.state()), { calls: [], rows: ['tana:text:01j0real00000000000000000'] },
    'deleting a draft asks Tana nothing and simply drops the local row');
  await context.removeReal();
  assert.deepEqual(plain(context.state()).calls,
    [['accessOptions', 'tana:text:01j0real00000000000000000'], ['deleteDocument', 'tana:text:01j0real00000000000000000'], ['invalidateNode', 'tana:text:01j0real00000000000000000']],
    'a real document is still asked about before it is deleted');
}

// Access options follow the readiness rule loadTaskMeta already has: never against a client that is not up, never
// against a local draft id — both answer "not connected to Tana" — and a real refusal is still shown.
async function runAccessReadinessCheck() {
  const context = {};
  vm.runInNewContext(`
    const asked = [], errors = [];
    const accessById = new Map(), accessLoading = new Set();
    const palette = { hidden: true };
    let connected = false, palDoc = null;
    const renderPalette = () => {};
    const showError = (e) => { errors.push(String(e.message || e)); };
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
    const tana = { accessOptions: async (id) => { asked.push(id); if (id.endsWith('deny')) throw new Error('This document cannot be read'); return { sharing: true }; } };
    ${functionSource('loadAccess')}
    Object.assign(globalThis, { ask: (id) => loadAccess(id), connect: () => { connected = true; },
      state: () => ({ asked, errors, cached: [...accessById.keys()] }) });
  `, context);
  context.ask('tana:text:01j0task0000000000000000');
  assert.deepEqual(plain(context.state()), { asked: [], errors: [], cached: [] }, 'nothing is asked before the sync client is up');
  context.connect();
  context.ask('draftdoc:2');
  assert.deepEqual(plain(context.state().asked), [], 'and a local draft id is never asked about at all');
  context.ask('tana:text:01j0task0000000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state()), { asked: ['tana:text:01j0task0000000000000000'], errors: [], cached: ['tana:text:01j0task0000000000000000'] },
    'a connected client is asked once, and the answer is kept');
  context.ask('tana:text:01j0denydenydenydenydeny');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state().errors), ['This document cannot be read'], 'a genuine refusal still reaches the user');
}

// The rail's api.related read follows the same readiness rule as loadAccess: nothing is asked before the sync client
// exists (main answers a read then with "not connected to Tana" and logs the throw), a local draft id is never asked
// about, and a connected client is asked once per document.
async function runRailReadinessCheck() {
  const context = {};
  vm.runInNewContext(`
    const asked = [], relatedBy = new Map();
    const relatedStale = new Set();
    let connected = false;
    const renderSoon = () => {};
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
    const tana = { related: async (id) => { asked.push(id); return { pinned: [] }; } };
    ${functionSource('loadRelated')}
    ${functionSource('refreshRelated')}
    Object.assign(globalThis, { ask: (id) => loadRelated(id), refresh: (id) => refreshRelated(id), connect: () => { connected = true; },
      state: () => ({ asked, cached: [...relatedBy.keys()], payload: relatedBy.get('tana:text:01j0task0000000000000000') || null }) });
  `, context);
  context.ask('tana:text:01j0task0000000000000000');
  assert.deepEqual(plain(context.state()), { asked: [], cached: [], payload: null }, 'the rail asks nothing before the sync client is up');
  context.connect();
  context.ask('draftdoc:2');
  assert.deepEqual(plain(context.state().asked), [], 'and never about a local draft id');
  context.ask('tana:text:01j0task0000000000000000');
  context.ask('tana:text:01j0task0000000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state()), { asked: ['tana:text:01j0task0000000000000000'], cached: ['tana:text:01j0task0000000000000000'], payload: { pinned: [] } },
    'a connected client is asked once, and the answer is kept');
  // A re-read (a pin, a metadata change) must not take the sidebar down while it is out: the payload stays on
  // screen and is replaced when the new one lands, which is what stopped the rail blanking on every edit.
  context.refresh('tana:text:01j0task0000000000000000');
  assert.deepEqual(plain(context.state().payload), { pinned: [] }, 'a re-read leaves the old payload on screen while it is out');
  context.ask('tana:text:01j0task0000000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state().asked), ['tana:text:01j0task0000000000000000', 'tana:text:01j0task0000000000000000'],
    'the re-read happens once: a render during it does not ask a third time');
  // The same rule for a saved search's stored query: main reads it through op(), so asking before the connection
  // threw "not connected to Tana" — and this one put it on screen as well as in the log. Boot reaches it because
  // restorePlace draws the reopened page before connecting.
  const search = {};
  vm.runInNewContext(`
    const asked = [], errors = [], searchFilters = new Map(), filters = new Map();
    const sortPref = {}, groupPref = {}, displayPref = {};
    let connected = false;
    const render = () => {};
    const showError = (e) => { errors.push(String(e.message || e)); };
    const tana = { searchFilter: async (id) => { asked.push(id); if (id.endsWith('deny')) throw new Error('This search cannot be read'); return { filter: { text: 'x' }, sort: 'due' }; } };
    ${functionSource('loadSearchFilter')}
    Object.assign(globalThis, { ask: (id) => loadSearchFilter(id), connect: () => { connected = true; },
      state: () => ({ asked, errors, sort: sortPref, cached: [...searchFilters.keys()] }) });
  `, search);
  search.ask('tana:search:01j0search00000000000000');
  assert.deepEqual(plain(search.state()), { asked: [], errors: [], sort: {}, cached: [] }, 'a saved search asks nothing before the sync client is up');
  search.connect();
  search.ask('tana:search:01j0search00000000000000');
  await new Promise(setImmediate);
  assert.deepEqual(plain(search.state()), { asked: ['tana:search:01j0search00000000000000'], errors: [], sort: { 'tana:search:01j0search00000000000000': 'due' },
    cached: ['tana:search:01j0search00000000000000'] }, 'once connected it is read once, and the stored arrangement is applied');
  search.ask('tana:search:01j0denydenydenydenydeny');
  await new Promise(setImmediate);
  assert.deepEqual(plain(search.state().errors), ['This search cannot be read'], 'a genuine refusal still reaches the user');
}

// Pasting a Tana node link (#271): the parser takes only one whole node link, and a paste of one puts the reference
// where the caret is — the surrounding text kept, the url never stored beside it, the caret after the chip.
async function runPasteLinkCheck() {
  const segments = sourceBetween('// accepts segments, a plain string, or a Node', 'const tana = window.api');
  const context = {};
  vm.runInNewContext(`
    ${FAKE_DOM}
    ${segments}
    const node = { id: 'block', kind: 'block', text: 'see  now', segments: [{ text: 'see  now' }] };
    const item = { key: 'doc/block', docId: 'tana:text:01j0doc000000000000000000', node };
    const items = new Map([[item.key, item]]);
    const writes = [], errors = [], flushed = [];
    let caret = null, renders = 0, prevented = false, collapsed = true, offset = 4, sel = null;
    let handler = null;
    const outline = { addEventListener: (name, fn) => { if (name === 'paste') handler = fn; } };
    const el = document.createElement('div');
    const keyOfEl = () => item.key;
    const canEditText = () => true, isAtomic = () => false, isReference = () => false;
    const getSelection = () => ({ isCollapsed: collapsed });
    const caretOffset = () => offset;
    const selectionOffsets = () => sel;
    const flush = (key) => flushed.push(key);
    const reload = async () => {}, render = () => { renders++; };
    const placeCaret = (key, at) => { caret = [key, at]; };
    const run = (fn) => fn();
    const showError = (e) => { errors.push(String(e.message || e)); };
    const titles = { 'tana:text:01j0aegis00000000000000000': 'Project AEGIS' };
    const tana = {
      node: async (uri) => { const title = titles[uri]; if (!title) throw new Error('This document cannot be read'); return { id: uri, title }; },
      setText: async (docId, id, value) => { writes.push([docId, id, value]); },
    };
    ${functionSource('linkTo')}
    ${sourceBetween("onRows('paste'", "onRows('focusout'")}
    Object.assign(globalThis, {
      uriOf: (text) => tanaNodeUri(text),
      paste: (text, range) => {
        node.text = 'see  now'; node.segments = [{ text: 'see  now' }]; // every case starts from the same row
        renderSegs(el, node.segments);
        prevented = false;
        collapsed = !range; sel = range || null; offset = range ? range[0] : 4;
        handler({ target: { closest: () => el }, clipboardData: { getData: () => text }, preventDefault: () => { prevented = true; } });
        return prevented;
      },
      draft: () => { node.draft = true; },
      state: () => ({ writes, errors, caret, renders, flushed, text: node.text, segments: node.segments }),
    });
  `, context);

  const link = 'https://home.tana.inc/o/01j0org000000000000000000/l/tana%3Atext%3A01j0aegis00000000000000000';
  assert.deepEqual([
    context.uriOf(link),
    context.uriOf(' ' + link + ' '),
    context.uriOf(link + '?from=share'),
    context.uriOf('https://home.tana.inc/o/01j0org000000000000000000/l/tana:event:01j0aegis00000000000000000'),
    context.uriOf('tana:text:01j0aegis00000000000000000'),
  ], [
    'tana:text:01j0aegis00000000000000000', 'tana:text:01j0aegis00000000000000000', 'tana:text:01j0aegis00000000000000000',
    'tana:event:01j0aegis00000000000000000', 'tana:text:01j0aegis00000000000000000',
  ], 'every link the app itself hands out reads back as its node uri');
  assert.deepEqual([
    context.uriOf('see ' + link),
    context.uriOf('https://example.com/o/x/l/tana%3Atext%3A01j0aegis00000000000000000'),
    context.uriOf('http://home.tana.inc/o/x/l/tana%3Atext%3A01j0aegis00000000000000000'),
    context.uriOf('https://home.tana.inc/o/x/l/tana%3Atext%3Anot-a-ulid'),
    context.uriOf('https://home.tana.inc/o/x/l/tana%3Atext%3A01j0aegis0000000000000000'),
    context.uriOf('plain words'),
    context.uriOf(''),
  ], [null, null, null, null, null, null, null], 'prose around a link, another host, a broken id and ordinary text are not node links');

  assert.equal(context.paste('see ' + link), false, 'a url inside prose pastes the way the browser would');
  assert.equal(context.paste('https://example.com/a'), false, 'and so does a foreign url');
  assert.deepEqual(plain(context.state().writes), [], 'neither wrote anything to the node');

  assert.equal(context.paste(link), true, 'a node link on its own is taken over');
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  const after = plain(context.state());
  assert.deepEqual(after.writes, [['tana:text:01j0doc000000000000000000', 'block',
    [{ text: 'see ' }, { mention: { label: 'Project AEGIS', uri: 'tana:text:01j0aegis00000000000000000' } }, { text: ' now' }]]],
    'one write: the reference at the caret, the text around it untouched and no url stored beside it');
  assert.equal(after.text, 'see Project AEGIS now', 'the row reads as its words plus the chip label');
  assert.deepEqual(after.caret, ['doc/block', 17], 'the caret lands after the chip');
  assert.deepEqual(after.flushed, ['doc/block'], 'a pending edit of the row is saved first');

  assert.equal(context.paste(link, [4, 8]), true, 'a selected range is replaced, not added to');
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(plain(context.state()).writes.at(-1)[2],
    [{ text: 'see ' }, { mention: { label: 'Project AEGIS', uri: 'tana:text:01j0aegis00000000000000000' } }],
    'the selection is gone and the reference stands in its place');

  const gone = 'https://home.tana.inc/o/01j0org000000000000000000/l/tana%3Atext%3A01j0gone000000000000000000';
  const before = plain(context.state());
  assert.equal(context.paste(gone), true, 'a link to a node that cannot be read is still taken over');
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  const failed = plain(context.state());
  assert.equal(failed.writes.length, before.writes.length, 'but nothing is written when the title cannot be read');
  assert.deepEqual(failed.errors, ['This document cannot be read'], 'and the error shows where errors show');

  // A draft row converts too, through materialise: runPasteDraftCheck owns that path.
}

// A Tana node link pasted into a draft row (#272): the draft is created first, by the same materialise the first
// typed character uses, and the reference is written into the row it became — one create, one write, no url text.
async function runPasteDraftCheck() {
  const segments = sourceBetween('// accepts segments, a plain string, or a Node', 'const tana = window.api');
  const make = (fail) => {
    const context = {};
    vm.runInNewContext(`
      ${FAKE_DOM}
      ${segments}
      const parentNode = { id: 'tana:text:01j0doc000000000000000000', kind: 'document' };
      const parent = { key: parentNode.id, docId: parentNode.id, node: parentNode };
      const node = { id: 'draft:1', kind: 'block', text: '', draft: true };
      const item = { key: parentNode.id + '/draft:1', docId: parentNode.id, node, parent };
      const items = new Map([[item.key, item], [parent.key, parent]]);
      const kids = new Map([[parentNode.id, []]]);
      const calls = [], errors = [];
      let caret = null, renders = 0, prevented = false, renderDeferred = false, slashCtx = null, zoom = null, handler = null;
      const fresh = new Map();
      const titleEl = {};
      const outline = { addEventListener: (name, fn) => { if (name === 'paste') handler = fn; } };
      const row = { dataset: { key: item.key }, classList: { remove: () => {} } };
      const el = document.createElement('div');
      el.closest = () => row;
      const keyOfEl = () => item.key;
      const canEditText = () => true, isAtomic = () => false, isReference = () => false;
      const getSelection = () => ({ isCollapsed: true });
      const caretOffset = () => 0;
      const selectionOffsets = () => null;
      const flush = () => {};
      const render = () => { renders++; };
      const placeCaret = (key, at) => { caret = [key, at]; };
      const showError = (e) => { errors.push(String(e && e.message || e)); };
      let queue = Promise.resolve();
      const run = (fn) => (queue = queue.then(fn).then((v) => v, showError)); // the real one: a failure is reported, not thrown on
      const reload = async (docId) => { calls.push(['reload', docId]); };
      const childrenOf = (candidate) => (candidate.node.kind === 'document' ? kids.get(candidate.docId) : candidate.node.children || []);
      const inheritCheckbox = async () => {};
      const locate = (rows, id) => { const found = rows.find((r) => r.id === id); return found && { node: found }; };
      const sectionOf = () => null;
      const scheduleSave = (_item, segs) => { calls.push(['scheduleSave', segs]); };
      const tana = {
        node: async (uri) => { calls.push(['node', uri]); return { id: uri, title: 'Project AEGIS' }; },
        insertAfter: async (docId, after, text) => {
          calls.push(['insertAfter', docId, after, text]);
          if (${fail ? 'true' : 'false'}) throw new Error('This outline row could not be created');
          kids.set(docId, [{ id: 'real', kind: 'block', text, segments: text ? [{ text }] : [] }]);
          return 'real';
        },
        insertChild: async (docId, id, text) => { calls.push(['insertChild', docId, id, text]); return 'real'; },
        setText: async (docId, id, value) => { calls.push(['setText', docId, id, value]); },
      };
      ${functionSource('materialise')}
      ${functionSource('linkTo')}
      ${sourceBetween("onRows('paste'", "onRows('focusout'")}
      Object.assign(globalThis, {
        paste: (text) => {
          prevented = false;
          handler({ target: { closest: () => el }, clipboardData: { getData: () => text }, preventDefault: () => { prevented = true; } });
          return prevented;
        },
        busy: () => { item.busy = true; },
        state: () => ({ calls, errors, caret, key: item.key, draft: !!item.node.draft, busy: !!item.busy,
          rowKey: row.dataset.key, text: item.node.text, rows: (kids.get(parentNode.id) || []).map((r) => r.id) }),
      });
    `, context);
    return context;
  };
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
  const link = 'https://home.tana.inc/o/01j0org000000000000000000/l/tana%3Atext%3A01j0aegis00000000000000000';
  const mention = { mention: { label: 'Project AEGIS', uri: 'tana:text:01j0aegis00000000000000000' } };

  const ok = make(false);
  assert.equal(ok.paste(link), true, 'a node link pasted into a draft row is taken over, draft or not');
  await settle();
  const after = plain(ok.state());
  assert.deepEqual(after.calls, [
    ['node', 'tana:text:01j0aegis00000000000000000'],
    ['insertAfter', 'tana:text:01j0doc000000000000000000', null, ''],
    ['reload', 'tana:text:01j0doc000000000000000000'],
    ['setText', 'tana:text:01j0doc000000000000000000', 'real', [mention]],
    ['reload', 'tana:text:01j0doc000000000000000000'],
  ], 'the title is read, the draft is created once, and the reference is the only thing written into it');
  assert.deepEqual(after.rows, ['real'], 'one row exists: no second create and no phantom left behind');
  assert.equal(after.calls.filter((c) => c[0] === 'insertAfter' || c[0] === 'insertChild').length, 1, 'created exactly once');
  assert.equal(after.calls.some((c) => JSON.stringify(c).includes('home.tana.inc')), false, 'the url is never stored, not even for a moment');
  assert.deepEqual([after.draft, after.busy, after.key, after.rowKey], [false, false, 'tana:text:01j0doc000000000000000000/real', 'tana:text:01j0doc000000000000000000/real'],
    'the row is a real node afterwards and the rendered row follows it');
  assert.equal(after.text, 'Project AEGIS', 'and reads as the reference label');
  assert.deepEqual(after.caret, ['tana:text:01j0doc000000000000000000/real', 13], 'the caret lands after the chip, as it does in an ordinary row');
  assert.deepEqual(after.errors, [], 'nothing was reported as an error');

  const bad = make(true);
  assert.equal(bad.paste(link), true, 'a failing create still takes the paste over rather than typing a url');
  await settle();
  const failed = plain(bad.state());
  assert.deepEqual(failed.calls.filter((c) => c[0] === 'setText'), [], 'nothing is written when the draft could not be created');
  assert.deepEqual([failed.draft, failed.busy, failed.key], [true, false, 'tana:text:01j0doc000000000000000000/draft:1'], 'the row is still an untouched draft');
  assert.deepEqual(failed.errors, ['This outline row could not be created'], 'and the create reported its own failure once');

  const racing = make(false);
  racing.busy();
  assert.equal(racing.paste(link), false, 'a draft already being created is left to the ordinary paste, so it cannot be created twice');
  await settle();
  assert.deepEqual(plain(racing.state()).calls, [], 'and nothing is asked or written for it');
}

// The caret around a lone reference (#272): a block whose only content is a reference is Tana's full-reference
// presentation, and Chromium holds no caret before a non-editable inline that starts the field. renderSegs anchors
// one there, so the caret can be placed before the chip and typing prepends text — which is the same block stored
// as text plus a mention, Tana's inline presentation.
function runReferenceCaretCheck() {
  const segments = sourceBetween('// accepts segments, a plain string, or a Node', 'const tana = window.api');
  const api = vm.runInNewContext(`
    ${FAKE_DOM}
    // Enough of a Range, TreeWalker and Selection to exercise the plain-text offset mapping.
    const texts = (el) => { const out = []; (function walk(n) { for (const kid of n.childNodes || []) { if (kid.nodeType === 3) out.push(kid); else walk(kid); } })(el); return out; };
    const upTo = (root, node, offset) => { let s = ''; for (const t of texts(root)) { if (t === node) return s + t.data.slice(0, offset); s += t.data; } return s; };
    const NodeFilter = { SHOW_TEXT: 4 };
    let placed = null, focus = null;
    document.createTreeWalker = (el) => { const list = texts(el); let i = -1; return { nextNode: () => (++i < list.length ? list[i] : null) }; };
    document.createRange = () => ({
      root: null, end: null,
      selectNodeContents(n) { this.root = n; },
      setEnd(n, o) { this.end = [n, o]; },
      setStart(n, o) { placed = ['setStart', n, o]; },
      setStartBefore(n) { placed = ['setStartBefore', n]; },
      setStartAfter(n) { placed = ['setStartAfter', n]; },
      collapse() {},
      toString() { return this.end ? upTo(this.root, this.end[0], this.end[1]) : ''; },
    });
    const getSelection = () => ({ rangeCount: focus ? 1 : 0, focusNode: focus && focus[0], focusOffset: focus && focus[1], isCollapsed: true, removeAllRanges() {}, addRange() {} });
    ${segments}
    ${sourceBetween('function caretOffset', 'function focused')}
    const build = (segs) => {
      const el = document.createElement('div');
      el.focus = () => {}; el.contains = () => true;
      renderSegs(el, segs);
      for (const kid of el.childNodes) { // FAKE_DOM does not link parents; setCaret needs them to avoid landing inside a chip
        kid.parentNode = el;
        if (kid.nodeType === 1) { kid.closest = (q) => (q === '.mention' && kid.classList.contains('mention') ? kid : null); for (const inner of kid.childNodes) inner.parentNode = kid; }
      }
      return el;
    };
    ({ build, readSegs, chipOnly, plainOf,
       firstOf: (el) => (el.childNodes[0].nodeType === 3 ? ['text', el.childNodes[0].data] : ['element', el.childNodes[0].className]),
       lastOf: (el) => { const n = el.childNodes.at(-1); return n.nodeType === 3 ? ['text', n.data] : ['element', n.className]; },
       chipOf: (el) => el.childNodes.find((n) => n.nodeType === 1),
       place: (el, offset) => { placed = null; setCaret(el, offset); const at = placed[1]; return [placed[0], at.nodeType === 3 ? (at.data === '\u200b' ? 'anchor' : at.data) : 'chip', placed[2]]; },
       offsetAt: (el, node, at) => { focus = [node, at]; return caretOffset(el); },
       type: (el, str) => { const first = el.childNodes[0]; first.data = str + first.data; }, // what an insertText at the anchor does
    });
  `);
  const ANCHOR = '\u200b';
  const mention = { mention: { label: 'Project AEGIS', uri: 'tana:text:01j0aegis00000000000000000' } };

  const sole = api.build([mention]);
  assert.deepEqual(plain(api.firstOf(sole)), ['text', ANCHOR], 'a block that is only a reference gets a caret position before the chip');
  assert.deepEqual(plain(api.lastOf(sole)), ['text', ANCHOR], 'and one after it: Chromium paints no caret after a non-editable inline that ends the field either');
  assert.deepEqual(plain(api.readSegs(sole)), [mention], 'and the anchor is not content: the block still stores one mention and no text');
  assert.equal(api.chipOnly(sole), true, 'the row is still the full-reference presentation');
  assert.deepEqual(plain(api.place(sole, 0)), ['setStart', 'anchor', 0],
    'offset 0 is a real text position before the chip, not a range before a non-editable inline (which Chromium drops)');
  assert.equal(api.offsetAt(sole, sole.childNodes[0], 1), 0, 'the caret sitting there reads back as offset 0, so typing prepends');
  assert.deepEqual(plain(api.place(sole, 13)), ['setStartAfter', 'chip', null], 'the end of the row is still after the chip');
  assert.equal(api.offsetAt(sole, api.chipOf(sole).childNodes[0], 13), 13, 'and reads back as the label length, so typing there appends');

  api.type(sole, 'Blocked by ');
  assert.deepEqual(plain(api.readSegs(sole)), [{ text: 'Blocked by ' }, mention],
    'typing before it prepends ordinary text and leaves an inline reference behind');
  assert.equal(api.chipOnly(sole), false, 'so the row is an ordinary one again');
  assert.equal(api.plainOf(api.readSegs(sole)), 'Blocked by Project AEGIS', 'and reads as the text plus the label');

  const trailing = api.build([{ text: 'see ' }, mention]);
  assert.deepEqual(plain(api.firstOf(trailing)), ['text', 'see '], 'a row that starts with text needs no anchor and gets none');
  assert.deepEqual(plain(api.lastOf(trailing)), ['text', ANCHOR], 'a row that ends with a chip is anchored after it, so the caret shows at the end of the line');
  assert.deepEqual(plain(api.readSegs(trailing)), [{ text: 'see ' }, mention], 'and is stored exactly as before');
  // A leading chip with text after it: the anchor sits before the chip, so every offset past it has to be counted
  // without it or the caret lands one character short of where it was asked for.
  const leading = api.build([mention, { text: ' now' }]);
  assert.deepEqual(plain(api.lastOf(leading)), ['text', ' now'], 'a row ending in text needs no anchor there');
  assert.deepEqual(plain(api.readSegs(leading)), [mention, { text: ' now' }], 'the anchor is no part of what such a row stores');
  assert.deepEqual(plain(api.place(leading, 17)), ['setStart', ' now', 4], 'the end of the row is the end of its text');
  assert.deepEqual(plain(api.place(leading, 13)), ['setStartAfter', 'chip', null], 'and the position between the chip and the text is still after the chip');
  const empty = api.build([]);
  assert.deepEqual(plain(empty.childNodes), [], 'an empty row stays empty');
}

// The sidebar's Changes section (#273): the node's own history, newest first, each entry reading
// "action · who · when" under what it is about. Read-only, and it never claims what the graph did not say.
function runRailChangesCheck() {
  const api = vm.runInNewContext(`
    ${FAKE_DOM}
    const names = { 'tana:user-profile:ana': 'Ana Ruiz' };
    const memberName = (uri) => names[uri] || uri;
    let membersAsked = 0;
    const loadMembers = () => { membersAsked++; };
    const blurSensitive = () => {};
    const railMove = () => false;
    const drawnIcons = [];
    const iconNode = (name) => { drawnIcons.push(name); return name === undefined ? null : { nodeType: 1, glyph: name, textContent: '' }; };
    const CHEV = '<svg></svg>';
    const railClosed = new Set();
    const appended = [];
    const railEl = { append: (...els) => appended.push(...els) };
    const toggled = [];
    const toggleRailSection = (label) => { toggled.push(label); };
    ${functionSource('agoText')}
    ${sourceBetween('const CHANGE_ICON =', 'function railChangeEl')}
    ${functionSource('railChangeEl')}
    const draw = (changes, parent, docId) => {
      appended.length = 0;
      const sectionHeadSrc = 0;
      ${sourceBetween('  const sectionHead = (label) => {', '  if (meta.length && sectionHead')}
      ${sourceBetween("  // Last section: the node's history", '  if (keep)')}
      const flat = (el) => [el, ...(el.childNodes || []).filter((k) => k && k.nodeType === 1).flatMap(flat)];
      const partOf = (el, cls) => flat(el).filter((k) => k.className === cls)[0];
      return appended.map((el) => ({
        tag: el.nodeName, cls: el.className, text: el.childNodes.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''),
        expanded: el.getAttribute ? el.getAttribute('aria-expanded') : null,
        section: el.dataset.section, id: el.dataset.id, clickable: !!el.onclick,
        title: partOf(el, 'rtitle') && partOf(el, 'rtitle').textContent,
        sub: partOf(el, 'rsub') && partOf(el, 'rsub').textContent,
        note: el.title,
        glyph: partOf(el, 'ricon') && (partOf(el, 'ricon').childNodes[0] || {}).glyph,
        says: partOf(el, 'ricon') && partOf(el, 'ricon').getAttribute('aria-label'),
      }));
    };
    ({ draw, railClosed, toggled, press: (el) => el.onclick && el.onclick(), asked: () => membersAsked });
  `);
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const parent = { node: { text: 'Send reply to Works Council' } };
  const changes = [
    { action: 'Updated', by: 'tana:user-profile:ana', at: ago(2 * 36e5) },
    { action: 'Updated', by: 'tana:user-profile:ben', at: ago(3 * 864e5) },
    { action: 'Created', by: 'tana:user-profile:ana', at: ago(30 * 864e5) },
  ];
  const drawn = plain(api.draw(changes, parent, 'tana:text:doc'));
  assert.deepEqual(drawn.map((r) => r.cls), ['rhead', 'rrow rchange', 'rrow rchange', 'rrow rchange'], 'one collapsible head, then one row per entry');
  assert.deepEqual([drawn[0].tag, drawn[0].text, drawn[0].expanded], ['BUTTON', 'Changes', 'true'], 'the head is a button labelled Changes and says it is open');
  assert.deepEqual(drawn.slice(1).map((r) => r.sub), ['Ana Ruiz · 2 hours ago', 'tana:user-profile:ben · 3 days ago', 'Ana Ruiz · 1 month ago'],
    'each entry reads who and when, in the order the payload gives — newest first, and an unknown member is not renamed');
  assert.deepEqual(drawn.slice(1).map((r) => [r.glyph, r.says]), [['updated', 'Updated'], ['updated', 'Updated'], ['created', 'Created']],
    'the kind of change is the glyph, which names itself for the pointer and for assistive tech rather than being spelled out in the line');
  assert.deepEqual(new Set(drawn.slice(1).map((r) => r.title)), new Set(['Send reply to Works Council']), 'with nothing written about the change, the entry falls back to the node it is about');

  // What the history service answers: a sentence per change, plus a longer description for the pointer.
  const written = plain(api.draw([
    { action: 'Updated', by: 'tana:user-profile:ana', others: 2, at: ago(21 * 60e3), title: 'Reviewers added', note: 'Two reviewers joined the document.' },
    { action: 'Created', by: 'tana:user-profile:ana', at: ago(49 * 60e3), title: 'Draft written' },
  ], parent, 'tana:text:doc'));
  assert.deepEqual(written.slice(1).map((r) => r.title), ['Reviewers added', 'Draft written'], 'a written summary is the entry, not the node title repeated down the section');
  assert.deepEqual(written.slice(1).map((r) => r.sub), ['Ana Ruiz +2 · 21 minutes ago', 'Ana Ruiz · 49 minutes ago'], 'the people who are not named are counted, never dropped in silence');
  assert.deepEqual(written.slice(1).map((r) => r.note), ['Two reviewers joined the document.', undefined], 'the longer description is there for the pointer and does not crowd the row');
  assert.deepEqual(drawn.slice(1).map((r) => r.section), ['Changes', 'Changes', 'Changes'], 'the rows belong to the section, so ←/→ fold it like any other');
  assert.equal(drawn.slice(1).some((r) => r.clickable), false, 'a history row opens nothing: this is display only');
  assert.equal(new Set(drawn.slice(1).map((r) => r.id)).size, 3, 'each row is identified by its own entry, so focus survives a redraw');

  const partial = plain(api.draw([
    { action: 'Updated', at: ago(2 * 36e5) },
    { action: 'Created', by: 'tana:user-profile:ana' },
    { action: 'Deleted' },
    { action: 'Restored', by: 'tana:user-profile:ana' },
  ], parent, 'tana:text:doc'));
  assert.deepEqual(partial.slice(1).map((r) => r.sub), ['2 hours ago', 'Ana Ruiz', '', 'Restored · Ana Ruiz'],
    'a missing actor or time leaves that part out — none of it is guessed — and a deletion is the glyph alone');
  assert.deepEqual(partial.slice(1).map((r) => r.glyph), ['updated', 'created', 'trash', undefined],
    'each kind has its own glyph, and a kind with none falls back to saying itself rather than going unsaid');

  api.railClosed.add('Changes');
  const closed = plain(api.draw(changes, parent, 'tana:text:doc'));
  assert.deepEqual(closed.map((r) => r.cls), ['rhead closed'], 'a folded section draws its head and no rows');
  assert.equal(closed[0].expanded, 'false', 'and says it is folded');
  api.railClosed.delete('Changes');
  assert.deepEqual(plain(api.draw([], parent, 'tana:text:doc')), [], 'a node with no history has no section at all');
  assert.ok(api.asked() > 0, 'the member list is asked for, so the names arrive and the rail redraws with them');
}





// ---- Home: the Library or a saved search, as the anchor a zoomed page crumbs back to and where Back lands ----
// Stored as the target's own id, so a rename in Tana shows through and a deletion is something the app can see.
async function runHomeCheck() {
  const homeInit = source.match(/let home = pref\('home', 'library'\);/)[0];
  const seed = source.match(/if \(!savedPlace && isRealId\(home\)\) savedPlace = [^\n]*/)[0];
  const api = vm.runInNewContext(FAKE_DOM + `
    const stored = {};
    const localStorage = { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = v; }, removeItem: (k) => { delete stored[k]; } };
    const prefs = {}; const pref = (k, fb) => (k in prefs ? prefs[k] : fb); const setPref = (k, v) => { prefs[k] = v; stored[k] = v; };
    ${homeInit}
    let view = 'library', zoom = null, searches = [], searchesLoaded = false, connected = true, went = [], renders = 0;
    let navBack = [], navForward = [], navHere = null, navigating = false, caretOnOpen = false, savedPlace = null;
    const SEARCH_ID = 'tana:search:';
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
    const onSearchPage = () => !!zoom && !zoom.nodeId && String(zoom.docId || '').startsWith(SEARCH_ID);
    const render = () => { renders++; }, renderSoon = render, flushAll = () => {}, dropDrafts = () => {};
    const goTo = (id) => { went.push(id); zoom = { docId: id, nodeId: null }; };
    const setView = (id) => { went.push('view:' + id); view = id; zoom = null; };
    const iconNode = (icon) => { const el = document.createElement('svg'); el.dataset.icon = icon; return el; };
    let listed = [];
    const tana = { searches: () => Promise.resolve(listed) };
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    ${functionSource('homeCrumb')}
    ${functionSource('renderCrumbs')}
    const bar = document.createElement('nav');
    const $ = () => bar;
    const paths = new Map();
    const crumbWhen = () => null, blurSensitive = () => {}, iconSvg = () => '', zoomTo = () => {};
    const viewOf = () => ({ title: 'Library' }), docOf = () => null;
    const OTHER_DOC = 'tana:text:01j0note0000000000000000';
    ${functionSource('navigate')}
    ${functionSource('loadSearches')}
    ({
      id: () => homeId(), name: () => homeName(), at: () => atHome(), target: () => homeTarget(),
      stored: () => ({ ...stored }), set: (id) => setHome(id), went: () => { const out = [...went]; went.length = 0; return out; },
      list: (rows, online = true) => { listed = rows; connected = online; return loadSearches(); },
      drop: (id) => { searches = searches.filter((s) => s.id !== id); repairHome(); },
      go: (place) => { zoom = place; }, view: (id) => { view = id; zoom = null; },
      home: () => goHome(),
      crumb: () => { const el = homeCrumb(); return el && { text: el.textContent, label: el.getAttribute('aria-label'), icon: el.childNodes[0].childNodes[0].dataset.icon, click: el.onclick }; },
      // the whole crumb bar, as it reads: the Home anchor, the separators and the location behind them
      crumbs: (location, docId = OTHER_DOC) => {
        zoom = { docId, nodeId: null };
        paths.set(docId, location);
        renderCrumbs([{ docId, node: { text: 'Note' } }]);
        return bar.childNodes.map((kid) => kid.textContent).join(' ');
      },
      back: () => navigate(-1), push: (place) => { navBack.push(place); navHere = { view, zoom, key: 'here' }; },
      seed: (place) => { savedPlace = place; ${seed} return savedPlace; },
    });
  `);

  const SEARCH = 'tana:search:01j0myt00000000000000000', OTHER = 'tana:text:01j0note0000000000000000';
  // Nothing chosen: the Library, and nothing written to say so
  assert.deepEqual([api.id(), api.name(), plain(api.stored())], ['library', 'Library', {}], 'with no preference Home is the Library, and nothing is stored until something is chosen');
  await api.list([{ id: SEARCH, text: 'My Tasks' }]);
  assert.equal(api.target(), 'library', 'the Library page offers itself as Home');
  api.set(SEARCH);
  assert.deepEqual(plain(api.stored()), { home: SEARCH }, 'choosing a saved search stores its id, not its name, so renaming it in Tana cannot lose the choice');
  assert.deepEqual([api.id(), api.name()], [SEARCH, 'My Tasks'], 'and Home reads as that search');
  // The launch race: main creates the window before S.client exists, so the boot call comes back empty for
  // everyone. An empty list from a client that could not list anything is not proof that the search is gone.
  await api.list([], false);
  assert.deepEqual([api.id(), api.stored().home], [SEARCH, SEARCH],
    'a searches answer from before the connection is up leaves the stored Home alone, rather than wiping the choice on every launch');
  await api.list([{ id: SEARCH, text: 'Everything of mine' }]);
  assert.equal(api.name(), 'Everything of mine', 'a renamed search shows its current name');

  // The crumb: icon and name in one link, which is the whole target, and it goes Home
  api.go({ docId: OTHER, nodeId: null });
  const crumb = api.crumb();
  assert.deepEqual([crumb.text, crumb.label, crumb.icon], ['Home', 'Go to Home: Everything of mine', 'home'],
    'a zoomed page starts with the Home anchor: the house glyph and the word Home, in one link whose label says where it goes');
  crumb.click();
  assert.deepEqual(plain(api.went()), [SEARCH], 'and pressing it opens Home');
  assert.equal(api.crumb().text, 'Home', 'the anchor stays on Home itself: one fixed way back, always in the same place');
  api.go({ docId: OTHER, nodeId: null });
  assert.equal(api.target(), null, 'a note is not a place to come back to, so it does not offer itself as Home');

  // The location behind the anchor: with a Home of the user's own, the Library is not a page they use, so it is
  // left out of it — and a document that sits in the Library keeps the anchor alone, with no trailing separator.
  const LIB = { id: 'library', title: 'Library', icon: 'library' }, SPACE = { id: 'tana:space:01j0space000000000000000', title: 'Foundry', icon: 'space' };
  assert.equal(api.crumbs([LIB, SPACE]), 'Home • Foundry',
    'with a saved search as Home the location starts at the space: the Library crumb is dropped, and the • still separates the anchor from what follows');
  assert.equal(api.crumbs([LIB]), 'Home',
    'a document that lives in the Library shows the anchor alone, rather than a • with nothing after it');

  // Back with nothing to go back to lands on Home; a real prior place still wins
  api.back();
  assert.deepEqual(plain(api.went()), [SEARCH], 'Back from a note with no history goes Home rather than to whichever view is behind it');
  api.go({ docId: OTHER, nodeId: null });
  api.push({ view: 'inbox', zoom: null, key: 'inbox' });
  api.back();
  assert.deepEqual(plain(api.went()), [], 'with a real prior place, Back is the history it always was');

  // A launch with nothing to restore opens Home; an explicit place wins
  assert.deepEqual(plain(api.seed(null)), { docId: SEARCH, nodeId: null }, 'a launch with no place to restore opens Home');
  assert.deepEqual(plain(api.seed({ docId: OTHER, nodeId: null })), { docId: OTHER, nodeId: null }, 'and a place to restore is left alone');

  // One route Home, whatever page asks for it: the anchor crumb, Back with no history and the Cmd+K row all call this.
  api.view('library');
  api.home();
  assert.deepEqual(plain(api.went()), [SEARCH], 'from a view, Home opens the saved search');
  api.go({ docId: OTHER, nodeId: null });
  api.home();
  assert.deepEqual(plain(api.went()), [SEARCH], 'and so does a zoomed note');

  // Gone: repaired to the Library rather than left pointing at something nothing can open
  api.drop(SEARCH);
  assert.deepEqual([api.id(), api.name(), api.stored().home], ['library', 'Library', 'library'],
    'a deleted Home falls back to the Library and the stale preference is repaired, not left behind');
  api.view('library');
  assert.equal(api.crumb().text, 'Home', 'and with the Library as Home the anchor still shows, rather than disappearing with the choice');
  assert.equal(api.crumbs([LIB, SPACE]), 'Home • Library › Foundry',
    'and with no Home of their own the Library is still the start of the location, unchanged');
  // A view page has no location, so the bar used to be hidden outright; the anchor alone is enough to show it.
  assert.match(source, /nav\.hidden = !trail && !homeEl;\n\s*if \(homeEl\) nav\.append\(homeEl\);/,
    'the crumb bar is shown for the Home anchor alone, so a view page (the Library, Inbox, Tasks) keeps it too');
  assert.equal(api.seed(null), null, 'a Library Home needs no restore target: it is the view a launch already opens');
  api.view('inbox');
  api.home();
  assert.deepEqual(plain(api.went()), ['view:library'], 'and once it has fallen back, Home is the Library view — no dead saved search is opened');
}


// The quick-add panel (quick-add.js) is its own window's script, not part of the outliner's shared scope, so it runs
// here whole in a fake DOM with a fake preload bridge — the same two things quick-add.html gives it.
async function runQuickAddPanelCheck() {
  const src = fs.readFileSync(require.resolve('../quick-add.js'), 'utf8');
  // The panel's markup is the other half of the panel: the ids it reaches for and which parts start hidden are read
  // from quick-add.html rather than restated here, so the script and its window cannot drift apart unnoticed.
  const html = fs.readFileSync(__dirname + '/../quick-add.html', 'utf8');
  const markupIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const hiddenAtStart = new Set([...html.matchAll(/id="([^"]+)"[^>]*\shidden/g)].map((m) => m[1]));
  assert.ok(hiddenAtStart.has('qchooser') && hiddenAtStart.has('qerror'), 'the chooser and the error line start hidden in the markup');
  assert.match(html, /<script src="icons\.js">/, 'the panel loads the app icon set rather than drawing glyphs of its own');
  // The stylesheet is the other half of this panel and a fake DOM has no CSS engine, so the rules that failed in use
  // are asserted here against the real file. Two of them looked like broken behaviour and were pure styling: the
  // finder stayed on screen after a pick had already been committed, and a long member list grew the form out of the
  // window.
  const css = fs.readFileSync(__dirname + '/../quick-add.css', 'utf8');
  const appCss = fs.readFileSync(__dirname + '/../styles.css', 'utf8');
  const hiddenWorks = /\[hidden\]\s*\{[^}]*display:\s*none/.test(css);
  for (const id of hiddenAtStart) {
    const tag = html.match(new RegExp('<[^>]*id="' + id + '"[^>]*>'))[0];
    const classes = ((tag.match(/class="([^"]+)"/) || ['', ''])[1]).split(' ').filter(Boolean);
    const ownDisplay = ['#' + id, ...classes.map((name) => '.' + name)]
      .some((selector) => new RegExp(selector.replace('.', '\\.') + '\\s*\\{[^}]*display:').test(css));
    assert.ok(!ownDisplay || hiddenWorks,
      id + ' starts hidden and the panel stylesheet gives it a display of its own, so the hidden property alone leaves it on screen');
  }
  assert.match(css, /\.qlist\s*\{[^}]*overflow-y:\s*auto/, 'the member list scrolls on its own');
  assert.match(css, /\.qlist\s*\{[^}]*min-height:\s*0/, 'and may shrink, or a long list pushes the form out of the window');
  assert.match(css, /\.qchooser\s*\{[^}]*min-height:\s*0/, 'as may the chooser around it');
  // The panel is one window of one app: its accent is the app's, not a second blue that only appears here.
  for (const accent of ['#e8f1fb', '#2b6fcf', '#b7d2f5']) {
    assert.ok(css.includes(accent), 'the panel uses the app accent ' + accent + ' for its chosen and focused states');
    assert.ok(appCss.includes(accent), accent + ' is the accent the rest of the app already uses');
  }
  for (const [hex] of css.matchAll(/#([0-9a-f]{6})\b/g)) {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    if (b - Math.max(r, g) < 24) continue; // greys and near-greys: only a decidedly blue colour is an accent
    assert.ok(appCss.includes(hex), hex + ' is a blue the panel invents; reuse one the app already has');
  }

  const MEETING = { id: 'tana:event:01example60000000000000000', title: 'Platform Sync', joinedAt: 111 };
  const PEOPLE = [{ id: 'tana:user-profile:01examplei0000000000000000', title: 'Andre', me: true },
    { id: 'tana:user-profile:01examplek0000000000000000', title: 'Renate' }];
  const settled = (value) => () => Promise.resolve(value);
  const tick = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

  function panel({ context = settled({ meeting: MEETING, members: PEOPLE, me: PEOPLE[0].id }), create, models = ['gpt-5-codex'] } = {}) {
    const els = new Map(), keydown = [], created = [], closed = [], asked = [];
    let focused = null, reopen = null;
    const makeEl = (id) => {
      const classes = new Set(), listeners = {};
      const self = {
        id, value: '', hidden: hiddenAtStart.has(id), dataset: {}, childNodes: [], text: '',
        classList: { add: (...names) => names.forEach((name) => classes.add(name)), contains: (name) => classes.has(name) },
        get className() { return [...classes].join(' '); },
        set className(value) { classes.clear(); for (const name of String(value).split(' ')) if (name) classes.add(name); },
        // children win over a directly set string, the way a real element reads back what was appended to it
        get textContent() { return self.childNodes.length ? self.childNodes.map((kid) => (typeof kid === 'string' ? kid : kid.textContent)).join('') : self.text; },
        set textContent(value) { self.text = String(value); self.childNodes = []; },
        focus() { focused = id; },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        fire(type, event) { for (const fn of listeners[type] || []) fn(event || {}); },
        replaceChildren(...kids) { self.childNodes = kids; },
        cloneNode() { const copy = makeEl(self.id); copy.dataset = { ...self.dataset }; copy.text = self.text; return copy; },
        // enough of a <template> for the icon helper: the markup in, its one element out
        set innerHTML(markup) { const icon = (String(markup).match(/data-icon="([^"]+)"/) || [])[1];
          const node = icon ? makeEl('svg') : null; if (node) node.dataset.icon = icon;
          self.content = { firstElementChild: node }; },
      };
      return self;
    };
    const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
    const api = {
      quickContext: () => { asked.push(true); return context(); },
      quickCreate: (input) => { created.push(input); return create ? create(input) : Promise.resolve({ node: { id: 'tana:text:01examplez0000000000000000' }, assigned: input.assigneeUri, linked: input.meetingId }); },
      quickClose: () => { closed.push(true); },
      onQuickOpen: (fn) => { reopen = fn; },
      codexModels: () => Promise.resolve(models),
      codexHosts: async () => [{ id: 'local', title: 'This Mac' }, { id: 'donut-id', title: 'Donut' }],
    };
    const ctx = {
      api, console,
      // the real icons.js sets exactly this global; the markup is stubbed so a glyph can be told apart by name
      ICONS: { member: '<svg data-icon="member"></svg>', robot: '<svg data-icon="robot"></svg>', brain: '<svg data-icon="brain"></svg>' },
      localStorage: { getItem: () => 'light' },
      matchMedia: () => ({ matches: false }),
      document: {
        documentElement: { dataset: {} },
        getElementById: el,
        createElement: (tag) => makeEl(tag === 'template' ? 'template' : 'row'),
        addEventListener: (type, fn) => { if (type === 'keydown') keydown.push(fn); },
      },
    };
    vm.runInNewContext(src, ctx);
    for (const id of els.keys()) assert.ok(markupIds.has(id) || ['template', 'row', 'svg'].includes(id), 'quick-add.js reaches for #' + id + ', which quick-add.html does not have');
    const key = (k, opts = {}) => { let prevented = false;
      const event = { key: k, metaKey: !!opts.meta, target: opts.in ? el(opts.in) : el('qtitle'), preventDefault: () => { prevented = true; } };
      for (const fn of keydown) fn(event); return prevented; };
    const iconOf = (element) => { const glyph = element.childNodes.find((kid) => kid && kid.dataset && kid.dataset.icon); return glyph ? glyph.dataset.icon : null; };
    return { el, key, created, closed, asked, iconOf, focus: () => focused, reopen: () => reopen && reopen(),
      rows: () => el('qlist').childNodes.map((row) => row.textContent),
      rowIcons: () => el('qlist').childNodes.map(iconOf) };
  }

  // A meeting the user is in: named, and sent as an id. Typing during the lookup survives it.
  {
    const p = panel();
    assert.equal(p.focus(), 'qtitle', 'the caret starts in the title, before anything is fetched');
    assert.equal(p.el('qmeeting').textContent, 'Checking for an active meeting…');
    p.el('qtitle').value = 'Draft the agenda';
    await tick();
    assert.equal(p.el('qmeeting').textContent, 'Adding to Platform Sync');
    assert.ok(p.el('qmeeting').classList.contains('live'));
    assert.equal(p.el('qtitle').value, 'Draft the agenda', 'a slow meeting lookup never touches what is being typed');
    assert.ok(p.key('Enter'), 'Enter is the panel\'s own key, not the browser\'s');
    await tick();
    assert.deepEqual(plain(p.created), [{ title: 'Draft the agenda', assigneeUri: null, meetingId: MEETING.id, agent: null }],
      'the meeting goes over as its id, so main pins the task to the event itself');
    assert.deepEqual(p.closed, [true], 'a created task closes the panel');
    assert.equal(p.el('qtitle').value, '');
  }
  // No meeting, and a lookup that failed: both say so, and neither invents a link.
  {
    const none = panel({ context: settled({ meeting: null, members: PEOPLE }) });
    await tick();
    assert.equal(none.el('qmeeting').textContent, 'No active meeting');
    none.el('qtitle').value = 'Solo task';
    none.key('Enter');
    await tick();
    assert.equal(plain(none.created)[0].meetingId, null, 'an unlinked task is still created');
    const broken = panel({ context: () => Promise.reject(new Error('graph unavailable')) });
    await tick();
    assert.equal(broken.el('qmeeting').textContent, 'Could not check meetings');
    broken.el('qtitle').value = 'Still usable';
    broken.key('Enter');
    await tick();
    assert.equal(plain(broken.created)[0].meetingId, null, 'and a failed lookup links nothing rather than guessing');
  }
  // Nothing empty, and nothing twice.
  {
    const p = panel({ create: () => new Promise(() => {}) });
    await tick();
    p.key('Enter');
    await tick();
    assert.deepEqual(p.created, [], 'an empty title creates nothing');
    assert.deepEqual([p.el('qerror').textContent, p.el('qerror').hidden], ['A task needs a title', false]);
    p.el('qtitle').value = 'One task';
    p.key('Enter');
    p.key('Enter');
    await tick();
    assert.equal(p.created.length, 1, 'a second Enter while the write is in flight creates no second task');
    assert.deepEqual(p.closed, [], 'and nothing closes until the write comes back');
  }
  // A failed create is recoverable: the text stays, the reason shows, the next Enter retries.
  {
    let failing = true;
    const p = panel({ create: () => (failing ? Promise.reject(new Error('Write permission is unknown or unavailable')) : Promise.resolve({ node: { id: 'tana:text:01examplez0000000000000000' } })) });
    await tick();
    p.el('qtitle').value = 'Keep me';
    p.key('Enter');
    await tick();
    assert.equal(p.el('qtitle').value, 'Keep me', 'a failed create keeps every character');
    assert.equal(p.el('qerror').textContent, 'Write permission is unknown or unavailable');
    assert.deepEqual(p.closed, [], 'and the panel stays open to try again');
    failing = false;
    p.key('Enter');
    await tick();
    assert.deepEqual([p.created.length, p.closed.length], [2, 1], 'the retry is the same one path, and it closes');
  }
  // The assignee chooser is reachable, filterable and dismissable without a mouse, and yields a real uri.
  {
    const p = panel();
    await tick();
    assert.equal(p.el('qchooser').hidden, true);
    p.key('Tab');
    assert.deepEqual([p.el('qchooser').hidden, p.focus()], [false, 'qfilter']);
    assert.deepEqual(p.rows(), ['Agent', 'Andre', 'Renate'], 'the agent is offered alongside the people');
    p.el('qfilter').value = 'ren';
    p.el('qfilter').fire('input');
    assert.deepEqual(p.rows(), ['Renate'], 'the list filters as the name is typed');
    p.key('Enter');
    assert.deepEqual([p.el('qassignee').textContent, p.el('qchooser').hidden, p.focus()], ['Renate', true, 'qtitle'],
      'picking returns the caret to the title');
    assert.equal(p.iconOf(p.el('qassignee')), 'member', 'a person is shown with the app\'s member glyph');
    assert.ok(p.el('qassignee').classList.contains('set'));
    p.el('qtitle').value = 'Assigned task';
    p.key('Enter');
    await tick();
    assert.equal(plain(p.created)[0].assigneeUri, PEOPLE[1].id, 'the assignee is a member uri, never a typed name');
  }
  // Arrow keys move the highlight, and picking the chosen person again clears the choice.
  {
    const p = panel();
    await tick();
    p.key('ArrowDown');
    assert.equal(p.el('qchooser').hidden, false, 'Down opens the chooser from the title');
    p.key('ArrowDown');
    p.key('ArrowDown');
    p.key('Enter');
    assert.equal(p.el('qassignee').textContent, 'Renate');
    p.key('Tab'); p.key('ArrowDown'); p.key('ArrowDown'); p.key('Enter');
    assert.equal(p.el('qassignee').textContent, 'Assign to…', 'choosing the same person again clears the assignment');
    assert.equal(p.iconOf(p.el('qassignee')), null, 'and the pill goes back to carrying no glyph');
  }
  // Escape unwinds one level at a time.
  {
    const p = panel();
    await tick();
    p.key('Tab');
    p.key('Escape');
    assert.deepEqual([p.el('qchooser').hidden, p.closed.length], [true, 0], 'Escape closes the chooser first');
    p.key('Escape');
    assert.deepEqual(p.closed, [true], 'and then the panel');
  }
  // Every press of the shortcut re-reads the meeting and keeps the half-typed title.
  {
    let meeting = MEETING;
    const p = panel({ context: () => Promise.resolve({ meeting, members: PEOPLE }) });
    await tick();
    assert.equal(p.asked.length, 1);
    p.el('qtitle').value = 'Half typed';
    meeting = null;
    p.reopen();
    await tick();
    assert.equal(p.asked.length, 2, 'the meeting is read again on every open, not cached from the first');
    assert.deepEqual([p.el('qmeeting').textContent, p.el('qtitle').value, p.focus()], ['No active meeting', 'Half typed', 'qtitle']);
  }
  // A workspace with a long member list: bounded by the stylesheet, never by dropping people, and the search and the
  // keyboard work exactly as they do with two.
  {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: 'tana:user-profile:' + String(i).padStart(26, '0'), title: 'Person ' + i }));
    const p = panel({ context: settled({ meeting: MEETING, members: many }) });
    await tick();
    p.key('Tab');
    assert.equal(p.rows().length, 201, 'every member is listed behind the agent row; the list scrolls rather than being truncated');
    p.key('ArrowUp');
    p.key('Enter');
    assert.equal(p.el('qassignee').textContent, 'Person 199', 'Up from the first row wraps to the last of a long list');
    p.key('Tab');
    p.el('qfilter').value = 'person 17';
    p.el('qfilter').fire('input');
    assert.deepEqual(p.rows().slice(0, 2), ['Person 17', 'Person 170'], 'and the search still narrows it');
    p.key('Enter');
    assert.deepEqual([p.el('qchooser').hidden, p.focus()], [true, 'qtitle'],
      'a pick from a long list dismisses the finder and puts the caret back in the title');
    p.el('qtitle').value = 'Long list task';
    p.key('Enter');
    await tick();
    assert.equal(plain(p.created)[0].assigneeUri, many[17].id, 'and it is the person that was highlighted');
  }
  // The agent is an option in the same finder, and it is not a person: no Tana assignee is ever sent for it.
  {
    const p = panel();
    await tick();
    p.key('Tab');
    assert.deepEqual([p.rows()[0], p.rowIcons()[0]], ['Agent', 'robot'], 'the agent leads the list, with its own glyph');
    p.el('qfilter').value = 'age';
    p.el('qfilter').fire('input');
    assert.deepEqual(p.rows(), ['Agent'], 'and it is found by typing like any other row');
    p.key('Enter');
    assert.deepEqual([p.el('qassignee').textContent, p.iconOf(p.el('qassignee'))], ['Agent', 'robot']);
    assert.deepEqual([p.el('qchooser').hidden, p.el('qprompt').hidden, p.focus()], [true, false, 'qprompt'],
      'the finder closes and the caret lands in the prompt the agent needs');
    p.el('qtitle').value = 'Ship the release notes';
    p.key('Enter', { in: 'qprompt' });
    assert.deepEqual(p.created, [], 'a bare Enter in the prompt is a newline, not a submit');
    p.key('Enter');
    await tick();
    assert.deepEqual([p.created.length, p.el('qerror').textContent], [0, 'Tell the agent what to do'],
      'and the agent is never handed a task with no instruction');
    p.el('qprompt').value = 'Draft them from the changelog';
    p.key('Enter', { in: 'qprompt', meta: true });
    await tick();
    assert.deepEqual(plain(p.created), [{ title: 'Ship the release notes', assigneeUri: null, meetingId: MEETING.id, agent: { prompt: 'Draft them from the changelog', model: '', host: 'local' } }],
      'the agent goes over as a prompt and a model, never as a user uri');
    assert.deepEqual([p.closed, p.el('qprompt').hidden, p.el('qassignee').textContent], [[true], true, 'Assign to…'],
      'and the panel resets to a plain task afterwards');
  }
  // The model for this one assignment, from Codex's own list, in the same chooser.
  {
    const p = panel({ models: ['gpt-5-codex', 'o4-mini'] });
    await tick();
    p.key('Tab'); p.key('Enter'); // Agent
    p.key('Tab');
    await tick();
    assert.deepEqual(p.rows(), ['Assign to someone else…', 'Codex default', 'gpt-5-codex', 'o4-mini', 'Run on…'],
      'with the agent chosen, the same finder offers the models, a way back to the people, and the machines last');
    p.key('ArrowDown'); p.key('ArrowDown'); p.key('Enter');
    assert.deepEqual([p.el('qassignee').textContent, p.focus()], ['Agent · gpt-5-codex', 'qprompt'],
      'the choice shows on the pill and the caret goes back to the prompt');
    // Where it runs travels with the rest: "Run on…" is the last row of the model list, the machines behind it come
    // from the registry, and the payload carries the opaque id. The default is this Mac for every new panel session,
    // which is what the submit above asserts.
    p.el('qtitle').value = 'Model task';
    p.el('qprompt').value = 'Do the thing';
    p.key('Enter', { meta: true, in: 'qassignee' });
    await tick();
    assert.equal(plain(p.created)[0].agent.model, 'gpt-5-codex', 'and it is sent with the assignment');
  }
  // Going back to a person from the agent, and the other way: one of them holds the task, never both.
  {
    const p = panel();
    await tick();
    p.key('Tab'); p.key('Enter'); // Agent
    p.el('qprompt').value = 'something';
    p.key('Tab'); // the model list
    await tick();
    p.key('Enter'); // "Assign to someone else…"
    assert.deepEqual(p.rows(), ['Agent', 'Andre', 'Renate'], 'the back row returns the finder to the people');
    p.key('ArrowDown'); p.key('ArrowDown'); p.key('Enter');
    assert.deepEqual([p.el('qassignee').textContent, p.iconOf(p.el('qassignee')), p.el('qprompt').hidden, p.el('qprompt').value],
      ['Renate', 'member', true, ''], 'choosing a person takes the task off the agent, prompt and all');
    p.el('qtitle').value = 'Back to a person';
    p.key('Enter');
    await tick();
    assert.deepEqual([plain(p.created)[0].agent, plain(p.created)[0].assigneeUri], [null, PEOPLE[1].id]);
  }
  // Cmd+Enter creates from anywhere, through the same guarded submit: the finder must not swallow it, and it is
  // refused for an empty title exactly as a bare Enter is.
  {
    const p = panel({ create: () => new Promise(() => {}) });
    await tick();
    p.key('Enter', { meta: true });
    assert.deepEqual([p.created.length, p.el('qerror').textContent], [0, 'A task needs a title'], 'the empty guard still holds');
    p.el('qtitle').value = 'From the finder';
    p.key('Tab');
    assert.equal(p.el('qchooser').hidden, false);
    assert.ok(p.key('Enter', { meta: true, in: 'qfilter' }), 'Cmd+Enter is answered by the panel, not left to the field');
    await tick();
    assert.equal(p.created.length, 1, 'with the finder open, Cmd+Enter creates rather than picking a row');
    p.key('Enter', { meta: true, in: 'qfilter' });
    await tick();
    assert.equal(p.created.length, 1, 'and the in-flight guard covers it too');
  }
  console.log('ok  quick add panel: meeting states, empty/duplicate/Cmd+Enter submit, the agent with its prompt and model, member and robot glyphs, keyboard assignee, escape, retry, re-open and a long member list');
}

// A reload used to leave every linked task grey: the status read was gated on the set of assigned ids, which is
// filled asynchronously and is still empty when the first load runs. Main knows the links; the renderer must ask.
function runAgentStatusBootCheck() {
  const api = vm.runInNewContext(`
    const asked = [];
    const codexIds = new Set(); // still empty: loadCodex has not answered yet, which is the boot order
    const agentStates = new Map(), agentTaskHosts = new Map();
    const renderSoon = () => {};
    const showError = () => {};
    const tana = {
      codexStatus: async () => { asked.push('status'); return { 'tana:text:01examplea0000000000000000': 'working' }; },
      codexTaskHosts: async () => { asked.push('hosts'); return { 'tana:text:01examplea0000000000000000': 'local' }; },
    };
    ${functionSource('loadAgentStates')}
    ({ boot: async () => { loadAgentStates(); for (let i = 0; i < 5; i++) await Promise.resolve(); return { asked: [...asked], states: [...agentStates], hosts: [...agentTaskHosts] }; } });
  `);
  return (async () => {
    const after = plain(await api.boot());
    assert.deepEqual(after.asked, ['status', 'hosts'], 'the status is asked for on load, even before the assigned ids have arrived');
    assert.deepEqual(after.states, [['tana:text:01examplea0000000000000000', 'working']], 'so a linked task is not grey after a reload');
    assert.deepEqual(after.hosts, [['tana:text:01examplea0000000000000000', 'local']], 'and the machine it runs on is known with it');
  })();
}

// A task row's grey facts sit after the title and wrap onto a line of their own when it fills the line, where they
// read as a second title. fitRowMeta moves them onto the subtext instead. Layout is the input, so the geometry is
// given rather than measured: what is tested is the decision, and that it is the same one whichever side the facts
// are currently on, which is what keeps a row from flipping back and forth.
function runRowMetaFitCheck() {
  const api = vm.runInNewContext(`
    const parse = (sel) => {
      const scoped = sel.startsWith(':scope > ');
      const rest = scoped ? sel.slice(9) : sel;
      const not = /:not\\(\\.([\\w-]+)\\)/.exec(rest);
      const names = rest.replace(/:not\\([^)]*\\)/, '').split('.').filter(Boolean);
      return { scoped, ok: (node) => names.every((name) => node.classList.contains(name)) && (!not || !node.classList.contains(not[1])) };
    };
    const find = (root, sel) => {
      const { scoped, ok } = parse(sel);
      const walk = (node, depth) => {
        for (const kid of node.children) {
          if (ok(kid) && (!scoped || depth === 0)) return kid;
          if (!scoped) { const hit = walk(kid, depth + 1); if (hit) return hit; }
        }
        return null;
      };
      return walk(root, 0);
    };
    const make = (cls, extra = {}) => {
      const classes = new Set(String(cls).split(' ').filter(Boolean));
      const el = {
        children: [], parentElement: null, textContent: '',
        classList: { contains: (name) => classes.has(name) },
        get className() { return [...classes].join(' '); },
        set className(value) { classes.clear(); for (const name of String(value).split(' ')) if (name) classes.add(name); },
        append(...kids) { for (const kid of kids) { if (kid.parentElement) kid.remove(); kid.parentElement = el; el.children.push(kid); } },
        insertBefore(kid, ref) { if (kid.parentElement) kid.remove(); kid.parentElement = el; const i = ref ? el.children.indexOf(ref) : -1; if (i < 0) el.children.push(kid); else el.children.splice(i, 0, kid); return kid; },
        remove() { const p = el.parentElement; if (p) { p.children.splice(p.children.indexOf(el), 1); el.parentElement = null; } },
        querySelector: (sel) => find(el, sel),
        getClientRects: () => extra.rects || [],
        getBoundingClientRect: () => extra.box || { right: 0 },
        offsetWidth: extra.width || 0,
      };
      return el;
    };
    const document = { createElement: () => make('') };
    let bodies = [];
    const outline = { querySelectorAll: () => bodies };
    ${functionSource('fitRowMeta')}
    ${source.match(/const META_SEP = [^\n]*\nconst META_GAP = [^\n]*/)[0]}
    ({
      row: ({ width, lastRight, metaWidth, subtext = 'Updated 2 days ago', time, chip, below = false }) => {
        const body = make('body', { box: { right: width } });
        const text = make('text', { rects: time ? [{ right: 40 }] : [{ right: lastRight }] });
        const meta = make('meta tmeta', { width: metaWidth });
        body.append(text);
        if (time) body.append(make('meta', { rects: [{ right: lastRight }] }));
        body.append(meta);
        if (chip) body.append(make('chip'));
        if (subtext !== null) { const sub = make('subtext'); sub.textContent = subtext; body.append(sub); }
        if (below) { const sub = body.querySelector(':scope > .subtext'); const sep = make('metasep'); sep.textContent = META_SEP; sub.append(sep, meta); }
        bodies = [body];
        return body;
      },
      fit: () => fitRowMeta(),
      shape: (body) => body.children.map((kid) => kid.className + (kid.children.length ? '[' + kid.children.map((k) => k.className).join(',') + ']' : '')),
      sep: (body) => { const s = body.querySelector('.metasep'); return s ? s.textContent : null; },
    });
  `);

  const roomy = api.row({ width: 600, lastRight: 300, metaWidth: 200 });
  api.fit();
  assert.deepEqual(plain(api.shape(roomy)), ['text', 'meta tmeta', 'subtext'], 'facts that fit after the title stay on it');

  const tight = api.row({ width: 600, lastRight: 500, metaWidth: 200 });
  api.fit();
  assert.deepEqual(plain(api.shape(tight)), ['text', 'subtext[metasep,meta tmeta]'], 'facts with no room join the subtext');
  assert.equal(api.sep(tight), ' · ', 'separated from it the way its own parts are');

  const edge = api.row({ width: 600, lastRight: 392, metaWidth: 200 });
  api.fit();
  assert.deepEqual(plain(api.shape(edge)), ['text', 'meta tmeta', 'subtext'], 'the gap the facts carry counts as room they need');
  const overEdge = api.row({ width: 600, lastRight: 393, metaWidth: 200 });
  api.fit();
  assert.deepEqual(plain(api.shape(overEdge)), ['text', 'subtext[metasep,meta tmeta]'], 'one pixel past it and they move');

  const widened = api.row({ width: 600, lastRight: 300, metaWidth: 200, below: true });
  api.fit();
  assert.deepEqual(plain(api.shape(widened)), ['text', 'meta tmeta', 'subtext'], 'and they come back up when the row is wide enough again');
  assert.equal(api.sep(widened), null, 'taking the separator with them');

  const tagged = api.row({ width: 600, lastRight: 300, metaWidth: 200, chip: true, below: true });
  api.fit();
  assert.deepEqual(plain(api.shape(tagged)), ['text', 'meta tmeta', 'chip', 'subtext'], 'back in front of the tags, where a fresh render puts them');

  const settled = api.row({ width: 600, lastRight: 500, metaWidth: 200 });
  api.fit(); const once = plain(api.shape(settled));
  api.fit();
  assert.deepEqual(plain(api.shape(settled)), once, 'a second pass over the same row moves nothing: the decision does not depend on where they sit');

  const timed = api.row({ width: 600, lastRight: 500, metaWidth: 200, time: true });
  api.fit();
  assert.deepEqual(plain(api.shape(timed)), ['text', 'meta', 'subtext[metasep,meta tmeta]'],
    'a meeting row is measured from the time after its title, not from the title');

  const bare = api.row({ width: 600, lastRight: 500, metaWidth: 200, subtext: null });
  api.fit();
  assert.deepEqual(plain(api.shape(bare)), ['text', 'meta tmeta'], 'with no subtext there is nowhere to move them, so they are left alone');

  const styles = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
  assert.match(styles, /\.meta \{[^}]*margin-left: 8px/, 'META_GAP is that margin, and the two must not drift apart');
  assert.match(styles, /\.subtext \.tmeta \{[^}]*margin-left: 0/, 'which comes back off once they are on the subtext line');
}



// The default mode: new rows are written as bullets or as plain text (main decides), and Backspace at the start of
// a row takes its bullet off rather than deleting the row.
async function runDefaultModeCheck() {
  const blockTypes = sourceBetween('// Block types (api.setBlockType)', 'const images = new Map()');
  const api = vm.runInNewContext(`
    const calls = [];
    ${blockTypes}
    const iconSvg = () => '<svg></svg>';
    let editable = true;
    const canEditItem = () => editable;
    const hasKids = (item) => !!item.node.hasChildren || !!item.node.children?.length;
    const flush = (key) => calls.push(['flush', key]);
    const render = () => calls.push(['render']);
    const reload = async (docId) => { calls.push(['reload', docId]); };
    const placeCaret = (key, offset) => calls.push(['caret', key, offset]);
    const run = async (fn) => fn();
    const dropPending = (key) => calls.push(['dropPending', key]);
    // the shared "- " rule and the words it leaves behind (renderer/segments.js), with the DOM stubbed around them
    const plainOf = (segs) => segs.map((s) => ('text' in s ? s.text : s.mention.label)).join('');
    const saveValue = (segs) => segs;
    const readSegs = (el) => (el && el.segs) || [];
    const caretOffset = (el) => (el && el.off) || 0;
    ${functionSource('splitSegs')}
    ${sourceLine('const startsList')}
    ${sourceLine('const listRest')}
    const tana = {
      setBlockType: async (docId, id, type) => calls.push(['setBlockType', docId, id, type]),
      setText: async (docId, id, value) => calls.push(['setText', docId, id, value]),
      indent: async (docId, id) => calls.push(['indent', docId, id]),
    };
    ${functionSource('unbullet')}
    ${functionSource('rebullet')}
    ${functionSource('bulletOrIndent')}
    const childrenOf = (item) => (item && item.rows) || [];
    const keyFor = (docId, node) => docId + '/' + node.id;
    const open = new Map();
    ({
      press: async (node, canEdit = true, parent = null) => {
        calls.length = 0; editable = canEdit;
        const took = unbullet({ key: 'doc/b', docId: 'doc', node, parent });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        return { took, calls: calls.slice() };
      },
      dash: async (node, canEdit = true) => {
        calls.length = 0; editable = canEdit;
        node = { text: '- ', segments: [{ text: '- ' }], ...node };
        const took = rebullet({ key: 'doc/b', docId: 'doc', node });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        return { took, calls: calls.slice(), text: node.text };
      },
      shiftTab: async (node, parent = null) => {
        calls.length = 0; editable = true;
        const took = unbullet({ key: 'doc/b', docId: 'doc', node, parent });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        return { took, calls: calls.slice() };
      },
      tab: async (node, above) => {
        calls.length = 0; editable = true; open.clear();
        const rows = above ? [above, node] : [node];
        const took = bulletOrIndent({ key: 'doc/b', docId: 'doc', node, parent: { rows } }, { segs: node.segments || [], off: 0 });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        return { took, calls: calls.slice(), opened: [...open.keys()] };
      },
    });
  `);
  const bullet = await api.press({ id: 'b', kind: 'block', block: 'bullet' });
  assert.deepEqual(plain(bullet), { took: true, calls: [['flush', 'doc/b'], ['setBlockType', 'doc', 'b', 'paragraph'], ['reload', 'doc'], ['render'], ['caret', 'doc/b', 0]] },
    'Backspace at the start of a bullet row turns it into plain text, leaving the caret where it was');
  assert.equal((await api.press({ id: 'b', kind: 'block', block: 'numbered' })).took, true, 'a numbered row loses its number the same way');
  // ⇧Tab at the start is the same step Backspace takes there: the marker comes off a top-level bullet, while a row
  // that still sits inside something is left to the outdent Tab has always done.
  assert.deepEqual(plain(await api.shiftTab({ id: 'b', kind: 'block', block: 'bullet' })),
    { took: true, calls: [['flush', 'doc/b'], ['setBlockType', 'doc', 'b', 'paragraph'], ['reload', 'doc'], ['render'], ['caret', 'doc/b', 0]] },
    '⇧Tab at the start of a top-level bullet turns it into plain text');
  assert.equal(plain((await api.shiftTab({ id: 'b', kind: 'block', block: 'bullet' }, { node: { kind: 'block' } })).took), false,
    'a row inside another keeps ⇧Tab as the outdent it always was');
  assert.equal(plain((await api.shiftTab({ id: 'b', kind: 'block', block: 'paragraph' })).took), false, 'and a plain line has no marker to lose');
  // Tab on a plain line: a bullet, and a child of the row above when that row is a list row — a paragraph above
  // owns nothing in Tana's schema, so it is never turned into a parent.
  const underBullet = plain(await api.tab({ id: 'b', kind: 'block', block: 'paragraph' }, { id: 'a', kind: 'block', block: 'bullet' }));
  assert.deepEqual(underBullet.calls.filter((c) => c[0] === 'indent'), [['indent', 'doc', 'b']], 'a bullet above takes the new one as its child');
  assert.deepEqual(underBullet.opened, ['doc/a'], 'and is opened, so the child it just took is visible');
  const underText = plain(await api.tab({ id: 'b', kind: 'block', block: 'paragraph' }, { id: 'a', kind: 'block', block: 'paragraph' }));
  assert.deepEqual([underText.took, underText.calls.some((c) => c[0] === 'indent'), underText.calls.some((c) => c[0] === 'setBlockType')], [true, false, true],
    'a plain line above is left alone: the line becomes a bullet and stays where it is');
  const first = plain(await api.tab({ id: 'b', kind: 'block', block: 'paragraph' }, null));
  assert.equal(first.calls.some((c) => c[0] === 'indent'), false, 'and the first row of all has nothing to join');
  for (const [node, why] of [
    [{ id: 'b', kind: 'block', block: 'paragraph' }, 'a plain row has no bullet to take off, so the row itself goes'],
    [{ id: 'b', kind: 'block', block: 'heading2' }, 'a heading is not a list row'],
    [{ id: 'b', kind: 'block', block: 'bullet', hasChildren: true }, 'a row with children keeps its bullet: a plain paragraph cannot own an outline'],
    [{ id: 'b', kind: 'block', block: 'bullet', draft: true }, 'a draft row is not in Tana yet'],
    [{ id: 'b', kind: 'document' }, 'a document row is not a block'],
  ]) {
    const result = await api.press(node);
    assert.deepEqual(plain(result), { took: false, calls: [] }, why);
  }
  assert.deepEqual(plain(await api.press({ id: 'b', kind: 'block', block: 'bullet' }, false)), { took: false, calls: [] }, 'a read-only row is left alone');
  // a child node cannot be plain text at all: Tana keeps children inside their parent's listItem, which has no
  // place for a bare paragraph, so the bullet stays and Backspace falls through to the rules below it
  assert.deepEqual(plain(await api.press({ id: 'b', kind: 'block', block: 'bullet' }, true, { node: { kind: 'block' } })), { took: false, calls: [] },
    'a child node keeps its bullet');
  assert.deepEqual(plain(await api.press({ id: 'b', kind: 'block', block: 'bullet' }, true, { node: { kind: 'document' } })), { took: true, calls: [['flush', 'doc/b'], ['setBlockType', 'doc', 'b', 'paragraph'], ['reload', 'doc'], ['render'], ['caret', 'doc/b', 0]] },
    "but a document's own row still loses its bullet");
  assert.match(functionSource('styleMenuEl'), /blockedType\(item, type\)\) row\.classList\.add\('disabled'\)/, 'and Text is not offered to a child node in the style menu');
  assert.match(source, /BLOCK_TYPES\[toolMenu\.index\]\[0\]; if \(!blockedType\(toolItem\(\), type\)\) applyBlockType\(type\);/, 'nor run from the keyboard there');

  // "- " typed into a plain row goes the other way: the dash is the command, so it is dropped rather than saved
  const dash = await api.dash({ id: 'b', kind: 'block', block: 'paragraph' });
  assert.deepEqual(plain(dash), { took: true, text: '',
    calls: [['dropPending', 'doc/b'], ['setText', 'doc', 'b', []], ['setBlockType', 'doc', 'b', 'bullet'], ['reload', 'doc'], ['render'], ['caret', 'doc/b', 0]] },
    '"- " in a row with no marker starts a list there and leaves the caret in the row');
  assert.equal((await api.dash({ id: 'b', kind: 'block', block: 'heading2' })).took, true, 'a heading takes it too');
  for (const [node, why] of [
    [{ id: 'b', kind: 'block', block: 'bullet' }, 'a row that is already a bullet types the dash as text'],
    [{ id: 'b', kind: 'block', block: 'code' }, 'a code block is content, not prose: "- " stays "- "'],
    [{ id: 'b', kind: 'block', block: 'paragraph', draft: true }, 'a draft row is not in Tana yet'],
  ]) assert.deepEqual(plain(await api.dash(node)), { took: false, calls: [], text: '- ' }, why);
  assert.deepEqual(plain(await api.dash({ id: 'b', kind: 'block', block: 'paragraph' }, false)), { took: false, calls: [], text: '- ' }, 'and a read-only row is left alone');

  // the keydown branch that reaches it: the bullet comes off first and the row goes on the next press
  const keydown = sourceBetween("onRows('keydown'", "onRows('input'");
  assert.match(keydown, /e\.key === 'Backspace' && off === 0 && collapsed\) \{\s*e\.preventDefault\(\);\s*if \(isDoc \|\| unbullet\(item\)\) return;\s*if \(len === 0\) removeNode\(item, el\); else removeEmptyAbove\(item, el\);/,
    'Backspace at the start of a row unbullets it, then removes the row when it is empty, then the empty row above it');
  // three harnesses inject this one by line, so a reformat would reach them as a SyntaxError rather than a message
  assert.match(source, /\nconst siblingBlock = .*;\n/, 'siblingBlock stays on one line');
  const typing = sourceBetween("onRows('input'", "onRows('paste'");
  assert.match(typing, /startsList\(el\.textContent\.slice\(0, caretOffset\(el\) \?\? 0\)\)\) rebullet\(item, el\)/, 'and typing "- " at the start of a row reaches the other direction, whatever else the row holds');

  // only a list row draws a marker, and the dot is hidden rather than removed so the gutter keeps its width
  const styles = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
  assert.match(styles, /\.node\.block:not\(\.t-bullet\):not\(\.t-numbered\):not\(\.collapsed\) > \.line > \.bullet::before \{ visibility: hidden; \}/,
    'text, headings, quotes and code draw no bullet');
  assert.doesNotMatch(styles, /:not\(\.t-numbered\)[^\n]*:hover[^\n]*\.bullet::before \{ visibility: visible/,
    'and hovering one does not bring the bullet back: a heading reads as a heading whatever the mouse is over');
  assert.match(styles, /\.menu \.mrow\.disabled \{/, 'a menu row that cannot run looks different from one that can');
  // an inline reference's icon takes the link's colour (it inherits, rather than setting one of its own) and the
  // underline moves onto the label so it does not run under the icon
  assert.match(styles, /:is\(\.text, \.fvalue\) \.mention svg \{[^}]*width: 1em/, 'a reference icon is drawn at the size of the text it sits in');
  assert.doesNotMatch(styles, /:is\(\.text, \.fvalue\) \.mention svg \{[^}]*color:/, 'and takes the link colour rather than one of its own');
  assert.match(styles, /:is\(\.text, \.fvalue\) \.mention:has\(svg\) \{ text-decoration: none; \}/, 'the link itself stops underlining once it carries an icon');
  assert.match(styles, /:is\(\.text, \.fvalue\) \.mention \.mlabel \{ text-decoration: underline/, 'and the label carries the underline instead');

  // and a row with no marker is not indented for one: its text starts exactly where the document title starts.
  // The three paddings and the narrowed gutter have to add up, so a change to any of them fails here rather than
  // quietly leaving headings a few pixels off the title.
  const px = (re, why) => { const m = styles.match(re); assert.ok(m, why); return Number(m[1]); };
  const titleLeft = px(/\.titlebar \{ padding: \d+px (\d+)px \d+px;/, 'the titlebar reserves a left margin');
  const outlineLeft = px(/\.scroll \{[^}]*padding:[^;]*\s(\d+)px;/, 'the outline column has a left padding');
  const bodyLeft = px(/\.body \{[^}]*padding-left: (\d+)px;/, 'the body sits a little right of the gutter');
  const gutter = px(/:not\(\.has\) > \.line > \.bullet \{ width: (\d+)px; \}/, 'a marker-less row narrows its bullet gutter');
  assert.equal(outlineLeft + gutter + bodyLeft, titleLeft, 'an outdented row lines its text up with the document title');
  assert.match(styles, /:not\(\.has\) > \.line:hover > \.chev \{ width: 0; visibility: hidden; \}/, 'and its chevron takes no width and never paints over the text');

  // a heading opens a section: air above it, a little under it, none on the first row of a page
  for (const level of ['h1', 'h2', 'h3']) assert.match(styles, new RegExp('\\.node\\.' + level + ' \\{ margin-top: (\\d+)px; \\}'), level + ' carries space above it');
  assert.match(styles, /\.node\.h1, \.node\.h2, \.node\.h3 \{ margin-bottom: \d+px; \}/, 'and a little space under it');
  assert.match(styles, /#outline > \.node:first-child, \.children > \.node:first-child \{ margin-top: 0; \}/, 'the first row of a page takes none: the title above it is the space');
  // prose carries air under it that a list row does not, and still less than the air a heading opens with
  const prosePad = px(/\.node\.t-paragraph \{ margin-bottom: (\d+)px; \}/, 'a plain row has room under it');
  const headPad = px(/\.node\.h2 \{ margin-top: (\d+)px; \}/, 'and a heading has more above it');
  assert.ok(prosePad > 0 && prosePad < headPad, 'a paragraph sits apart from the row under it without competing with a heading: ' + prosePad + ' against ' + headPad);

  // and it carries the page: a heading is the near-black the title is, the prose a step back from it. Sampled from
  // the same document in Tana (body rgb 73,75,79, heading rgb 28,32,36), so what is pinned here is the relation
  // between the two rather than the exact greys, in both themes.
  const hex = (re, why) => { const m = styles.match(re); assert.ok(m, why); return m[1]; };
  const lum = (c) => [1, 3, 5].reduce((sum, at, i) => sum + parseInt(c.slice(at, at + 2), 16) * [0.2126, 0.7152, 0.0722][i], 0);
  const prose = hex(/\n\.text \{[^}]*color: (#[0-9a-f]{6})/, 'row text has a colour of its own');
  const heading = hex(/\.h1 > \.line \.text, \.h2 > \.line \.text, \.h3 > \.line \.text \{ color: (#[0-9a-f]{6})/, 'and headings have one of theirs');
  assert.ok(lum(prose) > lum(heading) + 20, 'normal text is greyer than a heading: ' + prose + ' against ' + heading);
  const darkProse = hex(/\[data-theme="dark"\] \.text \{ color: (#[0-9a-f]{6})/, 'the dark theme sets row text too');
  const darkHeading = hex(/\[data-theme="dark"\] \.titlebar h1,[^{]*\{ color: (#[0-9a-f]{6})/, 'and its headings with the title');
  assert.ok(lum(darkHeading) > lum(darkProse) + 20, 'and dimmer than one in the dark theme: ' + darkProse + ' against ' + darkHeading);

  // the underline is a tint of the link, not the link colour: it marks the words without competing with them,
  // which in the dark theme means dimmer rather than paler
  const linkColour = hex(/:is\(\.text, \.fvalue\) \.mention \{ color: (#[0-9a-f]{6})/, 'an inline reference has a link colour');
  const underline = hex(/:is\(\.text, \.fvalue\) \.mention, :is\(\.text, \.fvalue\) \.mention \.mlabel \{ text-decoration-color: (#[0-9a-f]{6})/, 'and an underline colour of its own');
  assert.ok(lum(underline) > lum(linkColour) + 20, 'the underline is lighter than the words above it: ' + underline + ' against ' + linkColour);
  const darkLink = hex(/\[data-theme="dark"\] :is\(\.text, \.fvalue\) \.mention \{ color: (#[0-9a-f]{6})/, 'the dark theme has one too');
  const darkUnderline = hex(/\[data-theme="dark"\] :is\(\.text, \.fvalue\) \.mention, \[data-theme="dark"\] :is\(\.text, \.fvalue\) \.mention \.mlabel \{ text-decoration-color: (#[0-9a-f]{6})/, 'and its own underline');
  assert.ok(lum(darkUnderline) < lum(darkLink) - 20, 'and dimmer than them in the dark theme: ' + darkUnderline + ' against ' + darkLink);


}


// Backspace at the start of a row takes the empty row above it away. A plain empty row draws nothing now, so it
// cannot be clicked into: the row below is the only way to reach one.
async function runEmptyRowAboveCheck() {
  const api = vm.runInNewContext(`
    const calls = [];
    let rows = [], editable = true;
    const items = new Map();
    const texts = () => rows.slice();
    const keyOfEl = (el) => el.key;
    const isAtomic = (n) => n.type === 'image' || n.block === 'divider';
    const isReference = (n) => n.type === 'reference';
    const hasKids = (item) => !!(item.node.children && item.node.children.length);
    const unanchored = (s) => s;
    const plainOf = (n) => n.text || '';
    const canEditStructure = () => editable;
    const dropPending = (key) => calls.push(['dropPending', key]);
    const render = () => calls.push(['render']);
    const reload = async (docId) => { calls.push(['reload', docId]); };
    const placeCaret = (key, offset) => calls.push(['caret', key, offset]);
    const run = async (fn) => fn();
    const tana = { remove: async (docId, id) => calls.push(['remove', docId, id]) };
    const open = new Map([['doc/p', true]]);
    ${functionSource('closeIfEmpty')}
    ${functionSource('removeEmptyAbove')}
    ({
      press: async (above, canEdit = true) => {
        calls.length = 0; editable = canEdit; rows = []; items.clear();
        if (above) {
          const item = { key: 'doc/a', docId: above.docId || 'doc', node: { id: 'a', kind: 'block', text: '', ...above.node } };
          items.set('doc/a', item);
          rows.push({ key: 'doc/a', textContent: item.node.text });
        }
        const cur = { key: 'doc/b', docId: 'doc', node: { id: 'b', kind: 'block', text: 'Meeting update' } };
        const el = { key: 'doc/b', textContent: cur.node.text };
        items.set('doc/b', cur); rows.push(el);
        const took = removeEmptyAbove(cur, el);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        return { took, calls: calls.slice() };
      },
    });
  `);
  assert.deepEqual(plain(await api.press({})), { took: true,
    calls: [['dropPending', 'doc/a'], ['remove', 'doc', 'a'], ['reload', 'doc'], ['render'], ['caret', 'doc/b', 0]] },
    'the empty row above goes, and the caret stays where it was, at the start of the row being typed in');
  for (const [above, why] of [
    [null, 'the first row of a page has nothing above it'],
    [{ node: { text: 'Winning by Design' } }, 'a row with text is not an empty row'],
    [{ node: { children: [{ id: 'c' }] } }, 'a row with children would take its outline with it'],
    [{ node: { hasChildren: true } }, 'children that are not loaded yet count too'],
    [{ node: { type: 'image' } }, 'an image is not an empty text row'],
    [{ node: { block: 'divider' } }, 'and neither is a divider'],
    [{ node: { type: 'reference' } }, 'a reference stands for another node'],
    [{ node: { draft: true } }, 'a draft row is not in Tana yet'],
    [{ node: { kind: 'document' } }, 'a document row is not a block'],
    [{ docId: 'tana:text:other' }, 'a row an opened reference borrows belongs to another document'],
  ]) assert.deepEqual(plain(await api.press(above)), { took: false, calls: [] }, why);
  assert.deepEqual(plain(await api.press({}, false)), { took: false, calls: [] }, 'a row that cannot be restructured is left alone');

  // Removing the last child closes the node it was in. An empty node shows a draft row only while it is
  // explicitly expanded, and that expansion was made to hold the child that has just gone — leaving it on left a
  // draft row standing where the child used to be.
  const close = vm.runInNewContext(`
    let kids = [];
    const open = new Map();
    const hasKids = () => kids.length > 0;
    ${functionSource('closeIfEmpty')}
    ({ run: (children, expanded) => {
      kids = children; open.clear(); if (expanded) open.set('doc/p', true);
      closeIfEmpty({ key: 'doc/p' });
      return { expanded: open.get('doc/p') ?? null, known: open.has('doc/p') };
    } });
  `);
  assert.deepEqual(plain(close.run([], true)), { expanded: null, known: false }, 'the last child going takes the expansion with it, so no draft row is left behind');
  assert.deepEqual(plain(close.run(['a'], true)), { expanded: true, known: true }, 'a node that still has children stays open');
  assert.deepEqual(plain(close.run([], false)), { expanded: null, known: false }, 'and a node nobody expanded is left alone');
  assert.match(functionSource('closeIfEmpty'), /open\.delete\(/, 'the expansion is dropped rather than set false, so children arriving again show without being expanded a second time');
  assert.match(functionSource('removeNode'), /closeIfEmpty\(item\.parent\);\n\s*render\(true\)/, 'removeNode closes an emptied parent before it draws');
  assert.match(functionSource('removeEmptyAbove'), /closeIfEmpty\(above\.parent\)/, 'so does the removal of the empty row above');
  assert.match(functionSource('removeSel'), /for \(const it of its\) closeIfEmpty\(it\.parent\)/, 'and a selection, which can empty more than one node');
  // An outdent is a removal as far as the parent is concerned: the row leaves it, and a parent left with nothing
  // must not stay expanded over a draft row where the child was.
  assert.match(functionSource('shiftNode'), /const leaving = op === 'outdent' \? item\.parent : null;/, 'an outdent remembers the row it leaves');
  assert.match(functionSource('shiftNode'), /if \(leaving\) closeIfEmpty\(leaving\);\n\s*render\(true\)/, 'and closes it when it is emptied, before it draws');
}


// The style menu hangs under its button, so near the bottom of a page it used to run off the window with rows
// that scrolling could not reach. Layout is the input here: the geometry is given rather than measured.
function runStyleMenuFitCheck() {
  const menuFit = vm.runInNewContext(functionSource('menuFit') + '; menuFit');
  assert.deepEqual(plain(menuFit(500, 300, 260)), { up: false, maxHeight: 400 }, 'with room under the button the menu opens down, capped at its own maximum');
  assert.deepEqual(plain(menuFit(300, 200, 260)), { up: false, maxHeight: 300 }, 'it stays down while it fits, even with less room than the cap');
  assert.deepEqual(plain(menuFit(120, 600, 260)), { up: true, maxHeight: 400 }, 'a toolbar near the bottom opens the menu upwards');
  assert.deepEqual(plain(menuFit(120, 300, 260)), { up: true, maxHeight: 300 }, 'and takes the room that side has');
  assert.deepEqual(plain(menuFit(120, 80, 260)), { up: false, maxHeight: 120 }, 'when neither side fits it uses the roomier one and scrolls inside it');
  assert.deepEqual(plain(menuFit(20, 10, 260)), { up: false, maxHeight: 96 }, 'and never collapses to nothing');
  const source2 = functionSource('fitMenu');
  assert.match(source2, /menu\.style\.maxHeight = maxHeight \+ 'px'/, 'the measured room becomes the menu\'s own maximum, so overflow-y can scroll it');
  assert.match(source2, /classList\.toggle\('up', up\)/, 'and the side it opens on is a class the stylesheet places');
  assert.match(source2, /\.mrow\.active'\)\?\.scrollIntoView/, 'arrowing past the fold brings the active row into view');
  assert.match(functionSource('placeToolbar'), /fitMenu\(\);/, 'the fit runs after the toolbar is placed, when the button is where it will stay');
  const styles = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
  assert.match(styles, /\.menu\.up \{ top: auto; bottom: calc\(100% \+ 6px\); \}/, 'the stylesheet puts an upward menu above its button');
  assert.match(styles, /\.menu \{[^}]*overflow-y: auto/, 'and a menu scrolls once it is capped');
}


// A picture is not a line of text: Space on the row, or a click on it, opens a full view of it. The overlay is
// built when it is asked for and taken away again, so nothing about it can fall out of step while it is closed.
async function runImageViewCheck() {
  const api = vm.runInNewContext(`
    ${FAKE_DOM}
    const create = document.createElement;
    document.createElement = (tag) => Object.assign(create(tag), { focus() {}, remove() { const i = body.childNodes.indexOf(this); if (i >= 0) body.childNodes.splice(i, 1); } });
    const body = document.createElement('body');
    let active = { id: 'row', focused: 0, focus() { this.focused++; } };
    const errors = [];
    const showError = (e) => errors.push(String(e && e.message));
    const images = new Map([['tana:image:01examplev0000000000000000', 'data:image/png;base64,AAA']]);
    const tana = { image: async () => 'data:image/png;base64,FETCHED' };
    document.body = body;
    document.querySelector = (sel) => (sel === '.lightbox' ? body.childNodes.find((n) => n.classList.contains('lightbox')) || null : null);
    Object.defineProperty(document, 'activeElement', { get: () => active });
    ${functionSource('openImage')}
    ({
      open: async (uri) => { openImage({ image: { uri } }); await Promise.resolve(); await Promise.resolve(); return box(); },
      box: () => box(),
      press: (key) => { const b = box(); b.onkeydown({ key, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }); return box(); },
      click: () => { box().onclick(); return box(); },
      focused: () => active.focused,
      errors: () => errors,
    });
    function box() { const b = body.childNodes.find((n) => n.classList && n.classList.contains('lightbox')); return b || null; }
  `);
  const shown = await api.open('tana:image:01examplev0000000000000000');
  assert.ok(shown, 'Space on an image row puts a full view over the page');
  assert.equal(shown.childNodes[0].attributes.src ?? shown.childNodes[0].src, 'data:image/png;base64,AAA', 'showing the picture the row already has, so opening one costs no fetch');
  assert.equal(api.focused(), 0, 'the row it came from has not been touched yet');
  api.press('Escape');
  assert.equal(api.box(), null, 'Escape takes it away again');
  assert.equal(api.focused(), 1, 'and the focus goes back to the row it came from');
  await api.open('tana:image:01examplev0000000000000000');
  api.press(' ');
  assert.equal(api.box(), null, 'Space closes it too, since Space is what opened it');
  await api.open('tana:image:01examplev0000000000000000');
  api.click();
  assert.equal(api.box(), null, 'and a click anywhere on it');
  const fetched = await api.open('tana:image:01exampley0000000000000000');
  assert.equal(fetched.childNodes[0].attributes.src ?? fetched.childNodes[0].src, 'data:image/png;base64,FETCHED', 'a picture not in the cache yet is asked for');
  api.press('Escape');

  // the two ways in, and that an image draws a marker only where a list row would
  const keydown = sourceBetween("onRows('keydown'", "onRows('input'");
  assert.match(keydown, /e\.key === ' ' && isImage\(item\.node\)\) openImage\(item\.node\)/, 'Space on an image row opens it');
  assert.match(source, /img\.onclick = \(e\) => \{ e\.stopPropagation\(\); openImage\(node\); \}/, 'and so does a click on the picture');
  assert.match(source, /isDivider\(node\) \? 'divider' : isImage\(node\) \? \(node\.block \|\| 'image'\) : blockTypeOf\(node\)/,
    'an image takes the marker of the list row it sits in, and none when it sits on its own');
  const styles = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
  assert.match(styles, /\.lightbox \{ position: fixed; inset: 0;/, 'the full view covers the page');
  assert.match(styles, /\.lightbox img \{[^}]*max-width: 92vw; max-height: 92vh/, 'and fits the picture to the window rather than cropping it');
}

// The preference store itself (renderer/prefs.js), driven over the object the bridge actually hands it:
// contextBridge freezes everything it exposes, so a store that writes straight into that object throws on the
// first choice made — and it throws *before* the line that redraws, which is how folding a group heading stopped
// doing anything and why nothing was kept between launches.
function runPrefsStoreCheck() {
  const src = fs.readFileSync(require.resolve('../renderer/prefs.js'), 'utf8');
  const writes = [];
  const bridged = Object.freeze({ home: 'library', collapsedGroups: ['library\ntype\nDoc'] }); // as contextBridge hands it over
  const context = vm.createContext({ window: { api: { prefs: bridged, setPref: (key, value) => writes.push([key, value]) } } });
  const store = vm.runInContext(src + '\n({ pref, setPref, mergePrefs })', context);
  assert.equal(store.pref('home', 'x'), 'library', 'a preference reads from the snapshot the bridge handed over');
  assert.equal(store.pref('theme', 'light'), 'light', 'and one that is not in it reads its fallback');
  store.setPref('collapsedGroups', ['library\ntype\nDoc', 'library\ntype\nTask']); // folding a second section
  assert.deepEqual(plain(store.pref('collapsedGroups', [])), ['library\ntype\nDoc', 'library\ntype\nTask'], 'a written preference answers the next read here');
  assert.deepEqual(plain(writes), [['collapsedGroups', ['library\ntype\nDoc', 'library\ntype\nTask']]], 'and is handed to main exactly once');
  assert.deepEqual(plain(bridged.collapsedGroups), ['library\ntype\nDoc'], "the bridge's own frozen object is left as it was");
  store.setPref('home', undefined);
  assert.equal(store.pref('home', 'library'), 'library', 'clearing one puts its fallback back');
  store.mergePrefs({ theme: 'dark' }); // another machine changed something
  assert.equal(store.pref('theme', 'light'), 'dark', 'a set from another machine replaces what this one holds');
  assert.equal(store.pref('collapsedGroups', 'gone'), 'gone', 'wholly: a key the new set does not have is not kept');
  console.log('ok  preferences: the store writes into its own copy, not the frozen bridge object, so a choice sticks, reaches main and lets what follows it run');
}


// A click that misses the words still belongs to the row, and a row is bigger than its text: the padding around
// it, and the blank line a soft break leaves inside it. Layout is the input here, so the geometry and the
// browser's answer are given rather than measured.
function runCaretAtPointCheck() {
  const api = vm.runInNewContext(`
    ${ANCHOR_SRC}
    const TEXT = 'Document the risk.\\na\\nPotentially 7 mio';
    let asked = [], answer = () => null;
    const node = { data: TEXT };
    const text = {
      textContent: TEXT,
      getBoundingClientRect: () => box,
      contains: (n) => n === node,
    };
    let box = { left: 100, right: 500, top: 200, bottom: 290, width: 400, height: 90 };
    const document = {
      caretRangeFromPoint: (x, y) => { asked.push([x, y]); return answer(x, y); },
      createRange: () => ({ selectNodeContents() {}, setEnd(container, offset) { this.offset = offset; }, toString() { return TEXT.slice(0, this.offset); } }),
    };
    ${functionSource('caretAt')}
    ({
      at: (x, y, reply, rect) => { asked = []; answer = reply; if (rect) box = rect; return { offset: caretAt(text, x, y), asked }; },
      node: () => node,
      inText: (offset) => () => ({ startContainer: node, startOffset: offset }),
      elsewhere: () => ({ startContainer: { other: true }, startOffset: 0 }),
    });
  `);
  const node = api.node();
  const hit = api.inText(9);
  const inside = api.at(300, 240, hit);
  assert.equal(inside.offset, 9, 'a click the browser can read lands where it was read');
  assert.deepEqual(plain(inside.asked), [[300, 240]], 'and the point is asked for as it was clicked, since it is already inside the text');

  const beside = api.at(40, 240, hit);
  assert.deepEqual(plain(beside.asked[0]), [101, 240], 'a click in the padding beside a line is pulled onto that line, not down to the end of the row');
  const below = api.at(300, 600, hit);
  assert.deepEqual(plain(below.asked[0]), [300, 289], 'and one below the last line onto the last line');
  const above = api.at(300, 10, hit);
  assert.deepEqual(plain(above.asked[0]), [300, 201], 'one above the first onto the first');

  // the blank line a soft break leaves: the point is inside the row but over no words, so the browser may answer
  // with something outside this text; the left edge of the line is asked before the row falls back to its end
  let calls = 0;
  const retried = api.at(300, 240, (x) => (++calls === 1 ? { startContainer: { other: true }, startOffset: 0 } : { startContainer: node, startOffset: 19 }));
  assert.equal(retried.offset, 19, 'an answer from outside the text is retried at the start of the line');
  assert.deepEqual(plain(retried.asked.map(([x]) => x)), [300, 101], 'which is the only second place worth asking');
  const refused = api.at(300, 240, () => ({ startContainer: { other: true }, startOffset: 0 }));
  assert.equal(refused.offset, 38, 'and a row the browser will not read a position from still answers with its end, as it always did');
  const empty = api.at(300, 240, () => null, { left: 100, right: 100, top: 200, bottom: 200, width: 0, height: 0 });
  assert.equal(empty.offset, 38, 'a row with nothing rendered has nothing to aim at');
  assert.deepEqual(plain(empty.asked), [], 'and is not asked about');

  assert.match(functionSource('nodeEl'), /setCaret\(text, caretAt\(text, e\.clientX, e\.clientY\)\)/, 'the row places the caret where the click was');
  // expanding a row asks it for sub-items, so the row it opens onto is a bullet — and the write is told, so the
  // row does not change shape on the first keystroke
  assert.match(functionSource('nodeEl'), /nodeEl\(\{ \.\.\.draftNode\(item\), block: 'bullet' \}, docId, item\)/, 'an expanded row opens onto a bullet');
  assert.match(functionSource('materialise'), /tana\.insertAfter\(parent\.docId, last\?\.id \|\| null, text, node\.block\)/, 'and the draft is written as the kind it was drawn as');
}

const checks = [runCaretAtPointCheck, runPrefsStoreCheck, runImageViewCheck, runRailReadinessCheck, runDeletedNodeCheck, runRecentlyDeletedCheck, runEditPinsCheck, runSetIconCheck, runDiscussWithCheck, runSetHueCheck, runLiveUpdateBurstCheck, runSetTypeCheck, runZoomTypeChipCheck, runStyleMenuFitCheck, runEmptyRowAboveCheck, runDefaultModeCheck, runNavButtonsCheck, runRowMetaFitCheck, runPinToMeetingCheck, runAgentStatusBootCheck, runQuickAddPanelCheck, runRailChangesCheck, runPasteLinkCheck, runPasteDraftCheck, runReferenceCaretCheck, runCreateTaskFlowCheck, runDraftDocumentDeleteCheck, runAccessReadinessCheck, runRefreshSpinCheck, runCodexAssignCheck, runNotifyToggleCheck, runNotifyBellCheck, runCurrentNodeStatusCheck, runRestorePlaceCheck, runSearchPillsCheck, runPillsFoldCheck, runDraftTailCheck,runRailToggleCheck, runCaretOnOpenScrollCheck, runTypingRenderStabilityCheck, runDraftMaterialiseFocusCheck, runDraftBlurOrderCheck, runRecentRowsCheck, runRowChangeAnimationCheck, runFallingRowCheck, runZoomedBlockTitleSaveCheck, runSensitiveBlurCheck, runSelectionChecks, runMultiTaskPaletteCheck, runAssignedDropdown, runEditabilityCheck, runCheckboxCheck, runCheckboxInheritanceCheck, runTaskChildCheckboxScopeCheck, runStalePaletteInvalidationCheck, runReferenceEmbedRenderCheck, runRowAlignmentCheck, runRowAudienceCheck, runHiddenItemsCheck, runMemberLoadCheck, runVisibilityPickerCheck, runLinkPaletteCheck, runAuthPaletteCheck, runSyncShortcutCheck, runReservedComboCheck, runHistoryCheck, runZoomShortcutCheck, runZoomDeleteCheck, runAssigneeCloseCheck, runPendingSplitDraftCheck, runTaskMetaRetryCheck, runPaletteSkipCheck, runFormattingChecks, runSlashMenuCheck, runFilterShortcutFocusCheck, runFilterMenuCloseCheck, runSidebarRowsCheck, runRailPinCheck, runSidebarHoverCheck, runSidebarAlignmentCheck, runClearFiltersCheck, runUnifiedViewsCheck, runSortGroupCheck, runCmdPillsCheck, runSearchesGroupCheck, runSearchPageRowUpdateCheck, runHomeCheck];
// The chips under a zoomed title, driven through the shipped line itself: a typed document shows its type whatever
// kind it is, and the kind chip (task, doc, meeting, space, chat…) stays out of the header, as it always did for a task.
function runZoomTypeChipCheck() {
  const chips = vm.runInNewContext(sourceBetween('const isTask = (node)', 'const canEditNode =')
    + '\n(parent) => ' + source.match(/const titleTags = ([^\n]+);\n/)[1]);
  const zoomed = (icon, tags) => ({ node: { kind: 'document', icon, tags, hue: 200 } });
  const labels = (parent) => plain(chips(parent)).map((tag) => tag.label);
  const type = { label: 'Organization', uri: 'tana:type:org', hue: 200 };
  assert.deepEqual(labels(zoomed('type', [type])), ['Organization'], 'a typed plain document shows its type when zoomed into');
  assert.deepEqual(labels(zoomed('task', [{ label: 'task', color: 'gold' }, type])), ['Organization'], 'a typed task still shows its type alone');
  assert.deepEqual(labels(zoomed('meeting', [{ label: 'meeting', color: 'gold' }, type])), ['Organization'], 'and so does a typed meeting');
  for (const kind of ['doc', 'task', 'meeting', 'space', 'chat', 'member'])
    assert.deepEqual(labels(zoomed(kind, [{ label: kind, color: 'grey' }])), [], 'an untyped ' + kind + ' shows no chip: its kind is already the glyph beside the title');
  assert.deepEqual(labels({ node: { kind: 'block', text: 'a line' } }), [], 'a zoomed block has no chips');
  assert.deepEqual(plain(chips(null)), [], 'a view page has no zoomed node to read');
}

// Cmd+K "Set type": the row on the current node, and the page it opens. Which types a document may be given is main's
// answer (main/documents.js typeChoices); what is checked here is that the row is only offered to a document or a
// meeting, that the page shows main's answer honestly — the one it has ticked, the ones it cannot have greyed with
// the space they live in — that "No type" appears only when there is a type to remove, and that choosing writes
// exactly one call.
async function runSetTypeCheck() {
  const DOC = 'tana:text:01j0doc000000000000000000', BLOCK = 'b12', TYPE_A = 'tana:type:01j0type00000000000000000', TYPE_B = 'tana:type:01j0type10000000000000000';
  const api = vm.runInNewContext(`
    const views = [], pinTree = [], pinRows = () => [], searches = [], searchesLoaded = true;
    let home = 'library', view = 'library';
    const localStorage = { setItem() {} }, onSearchPage = () => false;
    const selectionRows = () => [], pillCommandRows = () => [], taskActionRows = () => [];
    let palDoc = { id: '${DOC}', tags: [{ label: 'task', color: 'grey' }] };
    const pinInfo = null, isRealId = () => true;
    const accessById = new Map(), loadAccess = () => {}, localDate = () => '2026-09-18', setTheme = () => {};
    const sectionOf = () => null, visibleTags = () => [];
    const palette = { hidden: false }; let palMode = 'cmd', palRows = [], palIndex = 0;
    const palInput = { placeholder: '', value: '', focus() {} };
    const zoom = null, railEl = { hidden: false }, navBack = [], navForward = [], sensitiveVisible = false;
    const railToggle = { hidden: false }, railHidden = false;
    const authed = true, authChecking = false, signedOut = false, theme = 'light', hotkeys = {}, themePref = 'light';
    const openCreationPalette = () => {}, openHiddenPalette = () => {}, toggleSensitiveVisibility = () => {}, followSystem = () => {};
    const openVisibilityPalette = () => {}, openMovePalette = () => {}, pinAction = () => {}, copyText = () => {};
    const togglePalette = () => {}, navigate = () => {}, history = () => {}, focusRail = () => {}, setZoom = () => {};
    const goTo = () => {}, setView = () => {}, openDoc = () => {}, filterEl = {}, zoomFactor = 1, BASE_ZOOM = 1;
    const visibilityRows = () => [], moveTargets = async () => [], previewMoveToSpace = () => {};
    let renderedPages = 0; const renderPalette = () => { renderedPages++; };
    let closed = 0; const closePalette = () => { closed++; }, promptEditor = () => {};
    const openCommandPalette = () => { palMode = 'cmd'; palRows = []; palIndex = 0; };
    const errors = []; let queue = Promise.resolve();
    const showError = (e) => { if (e) errors.push((e && e.message) || String(e)); };
    const run = (fn) => (queue = queue.then(fn).then((v) => { showError(null); return v; }, showError));
    const render = () => {};
    let answer = { current: null, options: [] }, listFails = null; const written = [];
    const tana = { refresh: async () => {}, filters: {}, sensitiveIds: () => {},
      docTypes: async () => { if (listFails) throw new Error(listFails); return answer; },
      setType: async (id, uri) => { written.push([id, uri]); return uri; } };
    ${sourceBetween('const docRow =', 'const NODE_ROW_ORDER')}
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    ${functionSource('paletteRows')}
    ${sourceBetween('const TYPE_GROUP', 'function openTypePalette')}
    ${functionSource('openTypePalette')}
    ${functionSource('applyType')}
    ${functionSource('backPalette')}
    ({ row: () => paletteRows('').find((r) => r.id === 'setType'),
       node: (next) => { palDoc = next; },
       list: (next, fails) => { answer = next; listFails = fails || null; },
       page: (q) => typeRows(q || ''),
       mode: () => palMode,
       escape: () => backPalette(),
       settle: async () => { await queue; await Promise.resolve(); await Promise.resolve(); },
       state: () => ({ written: [...written], errors: [...errors], closed, placeholder: palInput.placeholder }) });
  `);

  // 1. The row is offered to a document and to a meeting, and to nothing else: a block, a space or a member carries
  //    no type at all.
  assert.deepEqual(plain([api.row().label, api.row().keepOpen, api.row().icon]), ['Set type', true, 'type'], 'the current node offers one row, kept open for the page behind it');
  assert.equal(api.row().hint, 'No type', 'an untyped document says so rather than showing nothing');
  api.node({ id: DOC, tags: [{ label: 'task', color: 'grey' }, { label: 'Decision Record', uri: TYPE_A, hue: 30 }] });
  assert.equal(api.row().hint, 'Decision Record', 'and a typed one names the type it has, from the chip the row already shows');
  api.node({ id: 'tana:event:01j0event00000000000000000', tags: [] });
  assert.ok(api.row(), 'a meeting carries a type too');
  for (const id of [BLOCK, 'tana:space:01j0space00000000000000000', 'tana:user-profile:01j0user00000000000000000', 'tana:chat:01j0chat00000000000000000']) {
    api.node({ id, tags: [] });
    assert.equal(api.row(), undefined, (id.split(':')[1] || 'a block') + ' is not offered a type');
  }

  // 2. The page says what main said: the current type ticked and not offerable again, an out-of-scope type greyed
  //    with the space it lives in rather than left out, and "No type" only when there is one to remove.
  api.node({ id: DOC, tags: [{ label: 'task', color: 'grey' }, { label: 'Decision Record', uri: TYPE_A, hue: 30 }] });
  api.row().run();
  assert.deepEqual(plain([api.mode(), api.page().map((r) => [r.label, r.disabled])]), ['setType', [['Loading…', true]]], 'the page says it is loading until main answers');
  assert.equal(api.state().placeholder, 'Set type to…');
  api.list({ current: TYPE_A, options: [
    { uri: TYPE_A, title: 'Decision Record', hue: 30, selectable: true },
    { uri: TYPE_B, title: 'Organization', hue: 200, selectable: false, reason: 'Lives in Foundry' },
  ] });
  api.row().run();
  await api.settle();
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.hint, r.disabled, r.icon])),
    [['No type', 'Removes the type', null, 'none'], ['Decision Record', '✓', true, 'type'], ['Organization', 'Lives in Foundry', true, 'type']],
    'the type it has is ticked and not offered again, the one it cannot have says which space it belongs to, and removal leads, under the struck-through circle');
  assert.deepEqual(plain(api.page('org').map((r) => r.label)), ['Organization'], 'typing filters the page with the palette own matcher');

  // 3. Choosing writes once and closes; "No type" writes null. Neither is offered on a document that has no type.
  api.page().find((r) => r.label === 'No type').run();
  await api.settle();
  assert.deepEqual(plain(api.state().written), [[DOC, null]], '"No type" removes the type with the same one call');
  assert.equal(api.state().closed, 1, 'and the palette closes behind it');
  api.list({ current: null, options: [{ uri: TYPE_B, title: 'Organization', hue: 200, selectable: true }] });
  api.row().run();
  await api.settle();
  assert.deepEqual(plain(api.page().map((r) => r.label)), ['Organization'], 'an untyped document is not offered "No type": there is nothing to remove');
  api.page()[0].run();
  await api.settle();
  assert.deepEqual(plain(api.state().written.slice(-1)), [[DOC, TYPE_B]], 'choosing a type sets exactly that one');
  assert.deepEqual(plain(api.state().errors), [], 'and nothing is reported wrong');

  // 4. Escape steps back to the command page, and a list that could not be read says why instead of reading as
  //    "no types".
  api.row().run();
  api.escape();
  assert.equal(api.mode(), 'cmd', 'escape on the type page goes back to the command page');
  api.list({ current: null, options: [] }, 'not connected to Tana');
  api.row().run();
  await api.settle();
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.disabled])), [['not connected to Tana', true]], 'a list that failed says why');
  api.list({ current: null, options: [] });
  api.row().run();
  await api.settle();
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.disabled])), [['No types for this kind of document', true]], 'and an empty answer says that rather than showing an empty page');
  console.log('ok  Set type: offered to documents and meetings only, the page shows main\u2019s answer, "No type" removes, and each choice is one call');
}

// Live updates arrive in bursts: a view keeps the head of its list live (LIVE_ROWS, main/state.js) and each of those
// documents announces its first bootstrap, so the handler's forced redraw ran once per announcement — a whole
// several-hundred-row outline each time, which is what made a wide Library crawl as it opened. The force now rides
// renderSoon's frame instead of skipping the queue.
async function runLiveUpdateBurstCheck() {
  const queued = source.match(/let renderQueued = false, renderQueuedForce = false;/);
  assert.ok(queued, 'renderSoon keeps the pending force beside the pending frame');
  const api = vm.runInNewContext(`
    ${queued[0]}
    const frames = [], renders = [];
    const requestAnimationFrame = (fn) => frames.push(fn);
    const render = (force) => renders.push(force === true);
    ${functionSource('renderSoon')}
    let listener;
    const taskMetaById = new Map(), taskMetaFailed = new Map(), relatedBy = new Map(), kids = new Map();
    const patchDoc = async () => {}, reload = async () => {}, loadPins = () => {}, refreshRelated = () => {};
    const loadRoots = async () => 'rows'; // a resolved value, which is what .then(renderSoon) hands the queue
    const showError = (error) => { throw error; };
    const tana = { onChanged: (fn) => { listener = fn; } };
    ${sourceBetween('tana.onChanged((docId, info) => {', '// A task is also drawn from copies')}
    ({
      change: (id) => listener(id),
      flush: () => { for (const fn of frames.splice(0)) fn(); },
      drawn: () => renders.splice(0),
    });
  `);

  for (let i = 0; i < 50; i++) api.change('tana:text:01j0burst' + String(i).padStart(16, '0'));
  await new Promise(setImmediate);
  assert.deepEqual(plain(api.drawn()), [], 'nothing is drawn between the announcements themselves');
  api.flush();
  assert.deepEqual(plain(api.drawn()), [true], 'fifty documents announcing themselves at once redraw the outline once, and forced');

  api.change(null);
  await new Promise(setImmediate);
  api.flush();
  assert.deepEqual(plain(api.drawn()), [false], 'a global refresh renders unforced: the rows .then(renderSoon) hands it are not a force');

  api.change('tana:text:01j0burst0000000000000000');
  api.change(null);
  await new Promise(setImmediate);
  api.flush();
  assert.deepEqual(plain(api.drawn()), [true], 'a live update and a refresh in the same frame settle as one forced redraw rather than two');

  api.change(null);
  await new Promise(setImmediate);
  api.flush();
  assert.deepEqual(plain(api.drawn()), [false], 'and the force does not leak into the frame after it');
}

// Cmd+K "Discuss with …": the row on a document, and the page that asks who. Main owns both writes (the Discussion
// Task type and the field); what is checked here is that the row is offered to documents only, that the page takes
// the words as they are typed — the field holds text, not a member reference, and a real value as often names a
// team or two people as one colleague — and that one answer is one call.
async function runDiscussWithCheck() {
  const DOC = 'tana:text:01j0doc000000000000000000';
  const api = vm.runInNewContext(`
    const views = [], pinTree = [], pinRows = () => [], searches = [], searchesLoaded = true;
    let home = 'library', view = 'library';
    const localStorage = { setItem() {} }, onSearchPage = () => false;
    const selectionRows = () => [], pillCommandRows = () => [], taskActionRows = () => [];
    let palDoc = { id: '${DOC}', text: 'Discuss this with Stan and Peter', tags: [] };
    const pinInfo = null, isRealId = () => true;
    const accessById = new Map(), loadAccess = () => {}, localDate = () => '2026-09-20', setTheme = () => {};
    const sectionOf = () => null, visibleTags = () => [], docRow = () => ({});
    const palette = { hidden: false }; let palMode = 'cmd', palRows = [], palIndex = 0, palBusy = false, palSeq = 0, palTimer = null;
    const palInput = { placeholder: '', value: '', focus() {} };
    const zoom = null, railEl = { hidden: false }, navBack = [], navForward = [], sensitiveVisible = false;
    const railToggle = { hidden: false }, railHidden = false;
    const authed = true, authChecking = false, signedOut = false, theme = 'light', hotkeys = {}, themePref = 'light';
    const openCreationPalette = () => {}, openHiddenPalette = () => {}, toggleSensitiveVisibility = () => {}, followSystem = () => {};
    const openVisibilityPalette = () => {}, openMovePalette = () => {}, pinAction = () => {}, copyText = () => {};
    const togglePalette = () => {}, navigate = () => {}, history = () => {}, focusRail = () => {}, setZoom = () => {};
    const goTo = () => {}, setView = () => {}, openDoc = () => {}, filterEl = {}, zoomFactor = 1, BASE_ZOOM = 1;
    const visibilityRows = () => [], moveTargets = async () => [], previewMoveToSpace = () => {};
    const openTypePalette = () => {}, typesLoaded = async () => {}, typeRows = () => [], typeNameOf = () => '';
    let renders = 0; const renderPalette = () => { renders++; };
    let closed = 0; const closePalette = () => { closed++; }, promptEditor = () => {};
    const openCommandPalette = () => { palMode = 'cmd'; palRows = []; palIndex = 0; };
    const errors = []; let queue = Promise.resolve();
    const showError = (e) => { if (e) errors.push((e && e.message) || String(e)); };
    const run = (fn) => (queue = queue.then(fn).then((v) => { showError(null); return v; }, showError));
    const render = () => {};
    const written = []; let writeFails = null;
    // the model behind the page: what it was asked, and an answer this check settles when it chooses to
    const asked = []; let settle = null, suggestFails = null;
    const tana = { refresh: async () => {}, filters: {}, sensitiveIds: () => {},
      discussWith: async (id, who) => { if (writeFails) throw new Error(writeFails); written.push([id, who]); return { typeUri: 'tana:type:01j0t', who }; },
      suggestDiscussWith: (title) => new Promise((resolve, reject) => { asked.push(title); settle = () => (suggestFails ? reject(new Error(suggestFails)) : resolve(settle.value)); }) };
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    ${functionSource('paletteRows')}
    ${sourceBetween('const DISCUSS_GROUP', '// ---- Set icon')}
    ${functionSource('backPalette')}
    ({ row: () => { const r = paletteRows('').find((x) => x.id === 'discussWith'); return r && { label: r.label, hint: r.hint, icon: r.icon, keepOpen: r.keepOpen }; },
       open: () => paletteRows('').find((x) => x.id === 'discussWith').run(),
       node: (next) => { palDoc = next; },
       page: (q) => { palInput.value = q || ''; return discussRows(q || '').map((r) => [r.label, r.hint || '', r.icon || '', !!r.disabled]); },
       landing: (q) => { palInput.value = q || ''; return discussRows(q || '').map((r) => !!r.arrive); },
       choose: (q, i = 0) => { palInput.value = q || ''; discussRows(q || '')[i].run(); },
       fails: (message) => { writeFails = message || null; },
       suggest: async (value, fails) => { suggestFails = fails || null; settle.value = value; settle(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); },
       asked: () => [...asked],
       renders: () => renders,
       mode: () => palMode,
       escape: () => backPalette(),
       settle: async () => { await queue; await Promise.resolve(); await Promise.resolve(); },
       state: () => ({ written: [...written], errors: [...errors], closed, placeholder: palInput.placeholder }) });
  `);

  // 1. A document is offered the row; a meeting is not, because the type applies to documents.
  assert.deepEqual(plain(api.row()), { label: 'Discuss with \u2026', hint: 'Discussion Task', icon: 'member', keepOpen: true },
    'the row says what it will do: the name, and the type the document gets');
  for (const id of ['tana:event:01j0event00000000000000000', 'tana:type:01j0type000000000000000000', 'tana:space:01j0space00000000000000000', 'b12']) {
    api.node({ id, tags: [] });
    assert.equal(api.row(), undefined, (id.split(':')[1] || 'a block') + ' is not a document: no discussion task to make of it');
  }
  api.node({ id: DOC, tags: [] });

  // 2. The page is the palette's own field: what is typed is the answer, whether it names a person or a team.
  api.open();
  assert.deepEqual(plain([api.mode(), api.state().placeholder]), ['discuss', 'Discuss with\u2026'], 'it opens a page of its own');
  assert.deepEqual(plain(api.page('')), [['Type who this is for', '', 'member', true]],
    'with nothing typed there is nothing to run yet, under the glyph the row will keep');
  assert.deepEqual(plain(api.page('Peter Leppers')), [['\u201CPeter Leppers\u201D', '\u21A9', 'member', false]], 'a name is one row, quoting what will be written');
  assert.deepEqual(plain(api.page('Heads of Technology')), [['\u201CHeads of Technology\u201D', '\u21A9', 'member', false]],
    'and a team is as good an answer: the field holds text, not a member reference');

  // 3. One answer is one call, and it closes the page.
  api.choose('Peter Leppers');
  await api.settle();
  assert.deepEqual(plain(api.state()), { written: [[DOC, 'Peter Leppers']], errors: [], closed: 1, placeholder: 'Discuss with\u2026' },
    'the words are written once, as they stand');
  api.choose('  Heads of Technology  ');
  await api.settle();
  assert.deepEqual(plain(api.state().written[1]), [DOC, 'Heads of Technology'], 'trimmed, so stray spaces are not part of the name');

  // 4. A refused write says why and leaves the page up, so the answer can be given again.
  api.fails('Write permission is unknown or unavailable');
  api.choose('Someone else');
  await api.settle();
  assert.deepEqual(plain([api.state().errors, api.state().closed, api.state().written.length]), [['Write permission is unknown or unavailable'], 2, 2],
    'a refusal is reported and the page stays open');
  api.fails(null);

  // 5. Escape steps back a level rather than closing the palette outright.
  api.escape();
  assert.equal(plain(api.mode()), 'cmd', 'Escape goes back to the command page, like every other second level');

  // 6. The model reads the title while you type. It is asked once per open, with the title and nothing else, and
  // says it is working rather than leaving the page looking finished.
  api.node({ id: DOC, text: 'Discuss this with Stan and Peter', tags: [] });
  api.open();
  assert.deepEqual(plain(api.asked()), ['Discuss this with Stan and Peter'], 'opening the page asks the model about the title, once');
  assert.deepEqual(plain(api.page('')), [['Type who this is for', '', 'member', true], ['Reading the title\u2026', '', 'sparkle', true]],
    'and says it is reading while it waits, under the row you would type into');
  assert.equal(plain(api.page('')[1][3]), true, 'the waiting row cannot be run');
  await api.suggest('Stan and Peter');
  assert.deepEqual(plain(api.page('')), [['Type who this is for', '', 'member', true], ['\u201CStan and Peter\u201D', 'From the title', 'sparkle', false]],
    'the answer replaces the waiting row in place, still below your own answer, so Enter is never the model\u2019s');
  assert.deepEqual(plain(api.page('Stan')), [['\u201CStan\u201D', '\u21A9', 'member', false], ['\u201CStan and Peter\u201D', 'From the title', 'sparkle', false]],
    'typing narrows nothing here: the suggestion is an alternative to what you typed, one arrow key down');
  api.choose('Stan', 1);
  await api.settle();
  assert.deepEqual(plain(api.state().written.at(-1)), [DOC, 'Stan and Peter'], 'choosing it writes the suggestion, not the letters');

  // 7. A suggestion equal to what is typed is not offered twice, a title naming nobody adds nothing, and a call
  // that failed says why rather than looking like a title that named nobody.
  api.open();
  await api.suggest('Stan');
  // The landing is played once, on the build that follows the answer: the row comes out of the spin instead of
  // being swapped for a still one, and the letters typed after it rebuild the row without replaying that.
  assert.deepEqual(plain(api.landing('')), [false, true], 'the row the answer arrives in is the one that settles');
  assert.deepEqual(plain(api.landing('')), [false, false], 'and every build after it is an ordinary row');
  assert.deepEqual(plain(api.page('Stan')), [['\u201CStan\u201D', '\u21A9', 'member', false]], 'the same name twice is one row');
  api.open();
  await api.suggest(null);
  assert.deepEqual(plain(api.page('anyone')), [['\u201Canyone\u201D', '\u21A9', 'member', false]], 'a title naming nobody leaves the page as it was');
  api.open();
  await api.suggest(null, 'OpenAI answered 401: check the API key');
  assert.deepEqual(plain(api.page('')), [['Type who this is for', '', 'member', true], ['OpenAI answered 401: check the API key', '', 'sparkle', true]],
    'a refused key is said out loud, and the page still takes a name typed by hand');
  console.log('ok  Discuss with: offered to documents only, the page writes the words as typed, the model reads the title beside it, and refusals keep it open');
}

// Cmd+K "Set icon": the row on a type, and the page that searches the Nucleo set built into the app. The set itself
// is main's (main/icons.js) — what is checked here is that the row is offered to a type and nothing else, that the
// page draws what main answers and registers those glyphs so the rows can show them, that the type it already wears
// is ticked and can be taken off, and that choosing is one call.
async function runSetIconCheck() {
  const TYPE = 'tana:type:01j0type000000000000000000', DOC = 'tana:text:01j0doc000000000000000000';
  const api = vm.runInNewContext(`
    const views = [], pinTree = [], pinRows = () => [], searches = [], searchesLoaded = true;
    let home = 'library', view = 'library';
    const localStorage = { setItem() {} }, onSearchPage = () => false;
    const selectionRows = () => [], pillCommandRows = () => [], taskActionRows = () => [];
    let palDoc = { id: '${TYPE}', tags: [] };
    const pinInfo = null, isRealId = () => true;
    const accessById = new Map(), loadAccess = () => {}, localDate = () => '2026-09-18', setTheme = () => {};
    const sectionOf = () => null, visibleTags = () => [];
    const palette = { hidden: false }; let palMode = 'cmd', palRows = [], palIndex = 0, palBusy = false, palSeq = 0, palTimer = null;
    const palInput = { placeholder: '', value: '', focus() {} };
    const zoom = null, railEl = { hidden: false }, navBack = [], navForward = [], sensitiveVisible = false;
    const railToggle = { hidden: false }, railHidden = false;
    const authed = true, authChecking = false, signedOut = false, theme = 'light', hotkeys = {}, themePref = 'light';
    const openCreationPalette = () => {}, openHiddenPalette = () => {}, toggleSensitiveVisibility = () => {}, followSystem = () => {};
    const openVisibilityPalette = () => {}, openMovePalette = () => {}, pinAction = () => {}, copyText = () => {};
    const togglePalette = () => {}, navigate = () => {}, history = () => {}, focusRail = () => {}, setZoom = () => {};
    const goTo = () => {}, setView = () => {}, openDoc = () => {}, filterEl = {}, zoomFactor = 1, BASE_ZOOM = 1;
    const visibilityRows = () => [], moveTargets = async () => [], previewMoveToSpace = () => {};
    const openTypePalette = () => {}, typesLoaded = async () => {}, typeRows = () => [], typeNameOf = () => '';
    let renderedPages = 0; const renderPalette = () => { renderedPages++; };
    let closed = 0; const closePalette = () => { closed++; }, promptEditor = () => {};
    const openCommandPalette = () => { palMode = 'cmd'; palRows = []; palIndex = 0; };
    const errors = []; let queue = Promise.resolve();
    const showError = (e) => { if (e) errors.push((e && e.message) || String(e)); };
    const run = (fn) => (queue = queue.then(fn).then((v) => { showError(null); return v; }, showError));
    const render = () => {};
    const iconTemplates = new Map(); // the registry drops parsed copies here when markup is replaced
    ${sourceBetween('const customIcons = new Map()', 'const iconSvg = (icon)')}
    const glyph = (name) => ({ name, label: name.slice(3), svg: '<svg viewBox="0 0 18 18"><path d="M1 1"></path></svg>' });
    let answer = [glyph('nc-rocket'), glyph('nc-flask')], searchFails = null; const asked = [], written = [];
    const tana = { refresh: async () => {}, filters: {}, sensitiveIds: () => {},
      searchIcons: async (q) => { asked.push(q); if (searchFails) throw new Error(searchFails); return answer; },
      setTypeIcon: async (uri, name) => { written.push([uri, name]); return name ? { uri, ...glyph(name) } : null; } };
    ${sourceBetween('const docRow =', 'const NODE_ROW_ORDER')}
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    ${functionSource('paletteRows')}
    ${sourceBetween('const ICON_GROUP', 'function openIconPalette')}
    ${functionSource('openIconPalette')}
    ${functionSource('applyIcon')}
    ${functionSource('backPalette')}
    ({ row: () => paletteRows('').find((r) => r.id === 'setIcon'),
       node: (next) => { palDoc = next; },
       wearing: (uri, name) => { if (name) typeGlyphs.set(uri, name); else typeGlyphs.delete(uri); },
       answer: (next, fails) => { answer = next === null ? [] : next; searchFails = fails || null; },
       search: (q) => { palInput.value = q; searchIconsNow(); },
       page: () => iconPickRows(),
       mode: () => palMode,
       escape: () => backPalette(),
       known: (name) => customIcons.has(name),
       settle: async () => { await queue; await Promise.resolve(); await Promise.resolve(); },
       state: () => ({ asked: [...asked], written: [...written], errors: [...errors], closed, placeholder: palInput.placeholder }) });
  `);

  // 1. The row belongs to a type: not a document, not a meeting, not a block.
  assert.deepEqual(plain([api.row().label, api.row().hint, api.row().icon, api.row().keepOpen]), ['Set icon', 'The generic glyph', 'type', true],
    'a type with no glyph of its own offers the row under the generic one');
  api.wearing(TYPE, 'nc-rocket');
  assert.deepEqual(plain([api.row().hint, api.row().icon]), ['Chosen', 'nc-rocket'], 'and once one is chosen the row wears it');
  api.wearing(TYPE, null);
  for (const id of [DOC, 'tana:event:01j0event00000000000000000', 'tana:space:01j0space00000000000000000', 'b12']) {
    api.node({ id, tags: [] });
    assert.equal(api.row(), undefined, (id.split(':')[1] || 'a block') + ' has no icon to set: the glyph belongs to a type');
  }
  api.node({ id: TYPE, tags: [] });

  // 2. The page asks main and draws the answer, registering the glyphs so the rows can show them.
  api.row().run();
  assert.deepEqual(plain([api.mode(), api.state().placeholder, api.page().map((r) => [r.label, r.disabled])]), ['setIcon', 'Search icons…', [['Loading…', true]]],
    'it opens a page of its own, which says it is loading until main answers');
  await api.settle();
  assert.deepEqual(plain(api.state().asked), [''], 'the page opens on the set itself rather than an empty list');
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.icon])), [['rocket', 'nc-rocket'], ['flask', 'nc-flask']], 'every row draws its own glyph, by name');
  assert.deepEqual(plain([api.known('nc-rocket'), api.known('nc-flask')]), [true, true], 'which the renderer only knows because the page registered what main sent');
  api.search('launch');
  await api.settle();
  assert.deepEqual(plain(api.state().asked), ['', 'launch'], 'typing asks main again: the set is there, not here');

  // 3. What it wears is ticked, and can be taken off — but only when there is one to take off.
  assert.equal(api.page().some((r) => r.label === 'No type' || r.label === 'No icon'), false, 'a type with no glyph is not offered "No icon"');
  api.wearing(TYPE, 'nc-rocket');
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.hint])), [['No icon', 'Back to the generic glyph'], ['rocket', '✓'], ['flask', '']],
    'with one chosen, removal leads and the current glyph is ticked');
  api.page().find((r) => r.label === 'No icon').run();
  await api.settle();
  assert.deepEqual(plain(api.state().written), [[TYPE, null]], '"No icon" clears it with one call');
  assert.equal(api.page().some((r) => r.label === 'No icon'), false, 'and the row goes with it');
  api.page().find((r) => r.label === 'flask').run();
  await api.settle();
  assert.deepEqual(plain(api.state().written.slice(-1)), [[TYPE, 'nc-flask']], 'choosing one writes exactly that name');
  assert.equal(api.state().closed, 2, 'and the palette closes behind each choice');
  assert.deepEqual(plain(api.state().errors), [], 'with nothing reported wrong');

  // 4. Escape steps back to the command page, and a set that could not be read says why.
  api.row().run();
  api.escape();
  assert.equal(api.mode(), 'cmd', 'escape on the icon page goes back to the command page');
  api.wearing(TYPE, null); // back to the generic glyph, so the empty pages below are only about the search
  api.answer(null, 'not connected');
  api.row().run();
  await api.settle();
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.disabled])), [['No icon matches', true]], 'a failed search leaves the page honest rather than blank');
  api.answer([]);
  api.row().run();
  await api.settle();
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.disabled])), [['No icon matches', true]], 'and a query that matches nothing says so');
  console.log('ok  Set icon: offered on a type, the page searches main\u2019s set and registers what it draws, the current glyph is ticked and removable, one call per choice');
}

// Cmd+K "Set colour": the hue Tana keeps on a type (appearance.hue). The row is offered to a type and nothing else,
// the page previews every colour with the glyph the type wears, a typed number picks a hue the list does not hold,
// the current colour is ticked and removable, and each choice is one call.
async function runSetHueCheck() {
  const TYPE = 'tana:type:01j0type000000000000000000', DOC = 'tana:text:01j0doc000000000000000000';
  const api = vm.runInNewContext(`
    const views = [], pinTree = [], pinRows = () => [], searches = [], searchesLoaded = true;
    let home = 'library', view = 'library';
    const localStorage = { setItem() {} }, onSearchPage = () => false;
    const selectionRows = () => [], pillCommandRows = () => [], taskActionRows = () => [];
    let palDoc = { id: '${TYPE}', tags: [] };
    const pinInfo = null, isRealId = () => true;
    const accessById = new Map(), loadAccess = () => {}, localDate = () => '2026-09-18', setTheme = () => {};
    const sectionOf = () => null, visibleTags = () => [];
    const palette = { hidden: false }; let palMode = 'cmd', palRows = [], palIndex = 0, palBusy = false, palSeq = 0, palTimer = null;
    const palInput = { placeholder: '', value: '', focus() {} };
    const zoom = null, railEl = { hidden: false }, navBack = [], navForward = [], sensitiveVisible = false;
    const railToggle = { hidden: false }, railHidden = false;
    const authed = true, authChecking = false, signedOut = false, theme = 'light', hotkeys = {}, themePref = 'light';
    const openCreationPalette = () => {}, openHiddenPalette = () => {}, toggleSensitiveVisibility = () => {}, followSystem = () => {};
    const openVisibilityPalette = () => {}, openMovePalette = () => {}, pinAction = () => {}, copyText = () => {};
    const togglePalette = () => {}, navigate = () => {}, history = () => {}, focusRail = () => {}, setZoom = () => {};
    const goTo = () => {}, setView = () => {}, openDoc = () => {}, filterEl = {}, zoomFactor = 1, BASE_ZOOM = 1;
    const visibilityRows = () => [], moveTargets = async () => [], previewMoveToSpace = () => {};
    const openTypePalette = () => {}, typesLoaded = async () => {}, typeRows = () => [], typeNameOf = () => '';
    const openIconPalette = () => {};
    const typeGlyphs = new Map();
    const TYPE_NODE = /^tana:type:[0-9a-z]{26}$/;
    let renderedPages = 0; const renderPalette = () => { renderedPages++; };
    let closed = 0; const closePalette = () => { closed++; }, promptEditor = () => {};
    const openCommandPalette = () => { palMode = 'cmd'; palRows = []; palIndex = 0; };
    const errors = []; let queue = Promise.resolve();
    const showError = (e) => { if (e) errors.push((e && e.message) || String(e)); };
    const run = (fn) => (queue = queue.then(fn).then((v) => { showError(null); return v; }, showError));
    const render = () => {};
    const written = [];
    const tana = { refresh: async () => {}, filters: {}, sensitiveIds: () => {},
      setTypeHue: async (uri, hue) => { written.push([uri, hue]); return hue; } };
    ${sourceBetween('const docRow =', 'const NODE_ROW_ORDER')}
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    ${functionSource('paletteRows')}
    ${sourceBetween('const HUE_GROUP', 'function openHuePalette')}
    ${functionSource('openHuePalette')}
    ${functionSource('applyHue')}
    ${functionSource('backPalette')}
    ({ row: () => paletteRows('').find((r) => r.id === 'setHue'),
       node: (next) => { palDoc = next; },
       wearing: (uri, name) => { if (name) typeGlyphs.set(uri, name); else typeGlyphs.delete(uri); },
       page: (q) => huePickRows(q || ''),
       mode: () => palMode,
       escape: () => backPalette(),
       settle: async () => { await queue; await Promise.resolve(); },
       state: () => ({ written: [...written], errors: [...errors], closed, placeholder: palInput.placeholder }) });
  `);

  // 1. The row belongs to a type, and says what colour it is now.
  assert.deepEqual(plain([api.row().label, api.row().hint, api.row().icon, api.row().hue]), ['Set colour', 'Grey', 'type', null],
    'an uncoloured type offers the row in grey');
  api.node({ id: TYPE, tags: [], hue: 268 });
  api.wearing(TYPE, 'nc-rocket');
  assert.deepEqual(plain([api.row().hint, api.row().icon, api.row().hue]), ['Hue 268', 'nc-rocket', 268], 'and a coloured one wears its own glyph and colour');
  for (const id of [DOC, 'tana:event:01j0event00000000000000000', 'tana:space:01j0space00000000000000000', 'b12']) {
    api.node({ id, tags: [] });
    assert.equal(api.row(), undefined, (id.split(':')[1] || 'a block') + ' has no type colour to set');
  }

  // 2. The page is the picker: every colour drawn with the glyph the type wears, in the colour it would become.
  api.node({ id: TYPE, tags: [], hue: 240 });
  api.row().run();
  assert.deepEqual(plain([api.mode(), api.state().placeholder]), ['setHue', 'Choose a colour or type a hue…'], 'it opens a page of its own');
  const page = api.page();
  assert.deepEqual(plain([page.length, page[0].label, page[0].hue, page[0].icon]), [14, 'Red', 0, 'nc-rocket'], 'twelve colours, grey, and the way back to Tana\u2019s colour, each previewing the type\u2019s own glyph');
  assert.deepEqual(plain(page.filter((r) => r.hint === '✓').map((r) => r.label)), ['Blue'], 'the colour it already has is ticked');
  assert.deepEqual(plain(page.slice(-2).map((r) => [r.label, r.hint])), [['Grey', 'No tint, whatever Tana says'], ["Tana's colour", 'Forget the override']], 'it can be grey here whatever Tana says, and the override can be forgotten');

  // 3. Typing narrows by name, and a number picks a hue the list of twelve does not hold.
  assert.deepEqual(plain(api.page('green').map((r) => r.label)), ['Green'], 'typing a name narrows the list');
  assert.deepEqual(plain(api.page('268').map((r) => [r.label, r.hue])), [['Hue 268', 268]], 'a number is the hue itself, so all 360 are reachable');
  assert.deepEqual(plain(api.page('240').map((r) => r.label)), ['Blue'], 'one the list already holds is that row, not a duplicate');
  assert.deepEqual(plain(api.page('400').map((r) => [r.label, r.disabled])), [['No colour matches', true]], 'and a hue that is not one says so');

  // 4. Choosing is one call, and the palette closes behind it.
  api.page().find((r) => r.label === 'Violet').run();
  await api.settle();
  assert.deepEqual(plain(api.state().written), [[TYPE, 270]], 'choosing writes exactly that hue');
  api.page('268')[0].run();
  await api.settle();
  api.page().find((r) => r.label === 'Grey').run();
  await api.settle();
  api.page().find((r) => r.label === "Tana's colour").run();
  await api.settle();
  assert.deepEqual(plain(api.state().written.slice(1)), [[TYPE, 268], [TYPE, 'grey'], [TYPE, null]], 'a typed hue, grey and "Tana\u2019s colour" go the same way: a number, the word, and null to forget');
  assert.deepEqual(plain([api.state().closed, api.state().errors]), [4, []], 'each choice closes the palette, with nothing reported wrong');

  // 5. Escape steps back to the command page.
  api.row().run();
  api.escape();
  assert.equal(api.mode(), 'cmd', 'escape on the colour page goes back to the command page');
  console.log('ok  Set colour: offered on a type, the page previews every hue with the type\u2019s glyph, a typed number reaches all 360, the current one is ticked and removable, one call per choice');
}



// A node can be gone while a copy of it is still on screen — a mention in a note, a reference row, a page in the Back
// stack. Main says so three ways (outline:removed, a reference resolved as deleted, "Node has been deleted" from any
// read) and the renderer keeps one set of them: nothing opens a gone node, and nothing asks about it again. Before
// this, a deleted page opened as an empty outline whose metadata read failed on every backoff, for the whole session.
async function runDeletedNodeCheck() {
  const api = vm.runInNewContext(`
    const deletedIds = new Set();
    let zoom = null, view = 'library', caretOnOpen = false;
    let renders = 0;
    const errors = [], asked = [], opened = [];
    const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const extra = new Map(), kids = new Map(), taskMetaById = new Map(), taskMetaLoading = new Set(), taskMetaFailed = new Map();
    ${source.match(/const META_RETRY_MS = \d+, META_RETRY_MAX = \d+;/)[0]}
    const connected = true, palette = { hidden: true }, palDoc = null;
    const tana = {
      node: async (uri) => { asked.push('node ' + uri); return { id: uri, title: 'still here' }; },
      taskMeta: async (id) => { asked.push('taskMeta ' + id); throw new Error('Node has been deleted'); },
    };
    const showError = (e) => errors.push(String((e && e.message) || e));
    const render = () => { renders++; }, renderSoon = () => { renders++; }, patchMeta = () => {}, renderPalette = () => {};
    const flushAll = () => {}, dropDrafts = () => {}, releaseHeld = () => {}, recordRecent = () => {};
    const sectionOf = () => null, allDocs = () => [], docOf = () => null, followSummary = (id) => opened.push(id);
    const atHome = () => false, goHome = () => { view = 'home'; };
    const setTimeout = () => 0;
    ${sourceBetween('const isRealId = (id)', '// ---- Home ----')}
    ${functionSource('openDoc')}
    ${functionSource('goTo')}
    ${functionSource('loadTaskMeta')}
    ${sourceBetween('const navBack = [], navForward = []', '// The same two moves as a pair of buttons')}
    ({
      state: () => ({ zoom: zoom && zoom.docId, view, errors: [...errors], asked: [...asked], gone: [...deletedIds] }),
      openDoc: (id) => openDoc(id),
      goTo: (uri) => goTo(uri),
      meta: (id) => loadTaskMeta(id),
      note: (id, message) => noteGone(id, new Error(message)),
      mark: (uri, deleted) => markGone(uri, deleted),
      visit: (docId) => { zoom = { docId, nodeId: null }; noteNavigation(); },
      back: () => navigate(-1),
      clear: () => { errors.length = 0; asked.length = 0; },
    });
  `);
  const live = 'tana:text:01livenode0000000000000000', gone = 'tana:text:01gonenode0000000000000000';

  // 1. Learning it is gone. Main's message is the signal; any other failure is not.
  api.note(live, 'not connected');
  assert.deepEqual(plain(api.state().gone), [], 'an ordinary failure says nothing about whether the node is there');
  api.visit(gone);
  assert.equal(api.note(gone, "Error invoking remote method 'doc:info': Error: Node has been deleted"), true, 'main’s refusal is recognised through the IPC wrapper');
  assert.deepEqual(plain(api.state().gone), [gone], 'and remembered once');
  assert.equal(api.state().zoom, null, 'the page it refused to answer for is left rather than sat on');
  assert.equal(api.note(gone, 'Node has been deleted'), false, 'saying it twice changes nothing');

  // 2. Nothing opens it, by any route, and no read goes out to find that out.
  api.clear();
  api.openDoc(gone);
  assert.equal(api.state().zoom, null, 'a row, a pin, the rail or a crumb cannot open a deleted node');
  assert.deepEqual(plain(api.state().errors), ['That node has been deleted'], 'it says why instead of opening a page that answers nothing');
  await api.goTo(gone);
  assert.deepEqual(plain(api.state().asked), [], 'and a link into it asks main nothing: the answer is already known');
  api.clear();
  await api.goTo(live);
  assert.equal(api.state().zoom, live, 'a node that is still there opens as it always did');

  // 3. The Back stack walks past the pages that have gone since.
  api.clear();
  api.visit('tana:text:01keepnode0000000000000000');
  api.visit(gone);
  api.visit(live);
  api.back();
  assert.equal(api.state().zoom, 'tana:text:01keepnode0000000000000000', 'Back steps over the deleted page rather than reopening it');

  // 4. And it is never asked about again: the metadata backoff doubles but never gives up, which is what put
  //    "Node has been deleted" in the log once per retry for the rest of the session.
  api.clear();
  api.meta(gone);
  assert.deepEqual(plain(api.state().asked), [], 'a gone node is not asked for its metadata');
  api.meta(live);
  assert.deepEqual(plain(api.state().asked), ['taskMeta ' + live], 'a live one still is');

  // 5. Main's own mark — a reference it resolved as deleted — lands in the same set, which is how a chip drawn as
  //    gone is also a chip that cannot be opened.
  const marked = 'tana:text:01markednode000000000000';
  assert.equal(api.mark(marked, true), true, 'a reference main marked deleted reads as gone');
  assert.equal(api.mark('tana:text:01othernode000000000000000', false), false, 'and an ordinary one does not');
  api.clear();
  api.openDoc(marked);
  assert.deepEqual(plain(api.state().errors), ['That node has been deleted'], 'so the guards refuse it too');
  // Deletion is undoable, and a restored node answers again — which is where the set is emptied, so its rows stop
  // being struck through and it opens as it did before.
  assert.match(source, /deletedIds\.delete\(docId\)/, 'a node that answers a read again is no longer gone');
  console.log('ok  deleted nodes: main’s answers land in one set, nothing opens them, Back walks past them and nothing asks again');
}

// Cmd+K "Recently deleted": once a document is deleted the graph stops naming it, so this page is the only way back
// to one. It has to offer the row beside Undo, read main’s list, restore exactly what was chosen and open it, and
// be honest while the list is in flight or empty.
async function runRecentlyDeletedCheck() {
  const GONE = 'tana:text:01j0gone000000000000000000';
  const api = vm.runInNewContext(`
    const views = [], pinTree = [], pinRows = () => [], searches = [], searchesLoaded = true;
    let home = 'library', view = 'library';
    const localStorage = { setItem() {} }, onSearchPage = () => false;
    const selectionRows = () => [], pillCommandRows = () => [], taskActionRows = () => [];
    let palDoc = null;
    const pinInfo = null, isRealId = () => true;
    const accessById = new Map(), loadAccess = () => {}, localDate = () => '2026-09-18', setTheme = () => {};
    const sectionOf = () => null, visibleTags = () => [];
    const palette = { hidden: false }; let palMode = 'cmd', palRows = [], palIndex = 0, palBusy = false, palSeq = 0, palTimer = null;
    const palInput = { placeholder: '', value: '', focus() {} };
    const zoom = null, railEl = { hidden: false }, navBack = [], navForward = [], sensitiveVisible = false;
    const railToggle = { hidden: false }, railHidden = false;
    const authed = true, authChecking = false, signedOut = false, theme = 'light', hotkeys = {}, themePref = 'light';
    const openCreationPalette = () => {}, openHiddenPalette = () => {}, toggleSensitiveVisibility = () => {}, followSystem = () => {};
    const openVisibilityPalette = () => {}, openMovePalette = () => {}, pinAction = () => {}, copyText = () => {};
    const togglePalette = () => {}, navigate = () => {}, history = () => {}, focusRail = () => {}, setZoom = () => {};
    const setView = () => {}, openDoc = () => {}, filterEl = {}, zoomFactor = 1, BASE_ZOOM = 1;
    const visibilityRows = () => [], moveTargets = async () => [], previewMoveToSpace = () => {};
    const openTypePalette = () => {}, typesLoaded = async () => {}, typeRows = () => [], typeNameOf = () => '';
    const openIconPalette = () => {}, openHostsPalette = () => {}, openOpenAIKeyPalette = () => {};
    const typeGlyphs = new Map();
    const TYPE_NODE = /^tana:type:[0-9a-z]{26}$/;
    let renderedPages = 0; const renderPalette = () => { renderedPages++; };
    let closed = 0; const closePalette = () => { closed++; }, promptEditor = () => {};
    const openCommandPalette = () => { palMode = 'cmd'; palRows = []; palIndex = 0; };
    const errors = []; let queue = Promise.resolve();
    const showError = (e) => { if (e) errors.push((e && e.message) || String(e)); };
    const run = (fn) => (queue = queue.then(fn).then((v) => { showError(null); return v; }, showError));
    const render = () => {};
    const opened = [], restored = [];
    const goTo = (id) => { opened.push(id); };
    let answer = async () => [
      { id: '${GONE}', title: 'Weekly plan', deletedAt: new Date(Date.now() - 2 * 36e5).toISOString() },
      { id: 'tana:text:01j0gone100000000000000000', title: 'Scratch note', deletedAt: new Date(Date.now() - 3 * 864e5).toISOString() },
    ];
    const tana = { refresh: async () => {}, filters: {}, sensitiveIds: () => {},
      deletedList: () => answer(), restoreDocument: async (id) => { restored.push(id); } };
    ${functionSource('fuzzyMatch')}
    ${functionSource('agoText')}
    ${sourceBetween('const docRow =', 'const NODE_ROW_ORDER')}
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    ${functionSource('paletteRows')}
    ${sourceBetween('const TRASH_GROUP', 'function openTrashPalette')}
    ${functionSource('openTrashPalette')}
    ${functionSource('backPalette')}
    ({ row: () => paletteRows('').find((r) => r.id === 'recentlyDeleted'),
       page: (q) => trashRows(q || ''),
       mode: () => palMode,
       escape: () => backPalette(),
       empty: () => { answer = async () => []; },
       settle: async () => { await queue; await Promise.resolve(); },
       state: () => ({ restored: [...restored], opened: [...opened], errors: [...errors], closed, placeholder: palInput.placeholder }) });
  `);

  // 1. The row sits with the other app actions, and carries an id, so a key can be recorded against it.
  assert.deepEqual(plain([api.row().label, api.row().group, api.row().icon]), ['Recently deleted', 'Actions', 'trash'], 'the row is offered');

  // 2. Until the list lands the page says so rather than "nothing was deleted", which is a different answer.
  api.row().run();
  assert.deepEqual(plain([api.mode(), api.state().placeholder]), ['trash', 'Restore something deleted'], 'it opens a page of its own');
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.disabled])), [['Loading…', true]], 'a list still in flight is not an empty one');
  await api.settle();

  // 3. What main recorded, newest first, each row dated by how long ago it went.
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.hint])), [['Weekly plan', '2 hours ago'], ['Scratch note', '3 days ago']], 'the list reads back with its ages');
  assert.deepEqual(plain(api.page('scr').map((r) => r.label)), ['Scratch note'], 'typing narrows it by title');

  // 4. Enter restores that one document and goes to it, and the palette closes behind it.
  api.page()[0].run();
  await api.settle();
  assert.deepEqual(plain([api.state().restored, api.state().opened, api.state().errors]), [[GONE], [GONE], []], 'the chosen document is restored and opened');
  assert.equal(api.state().closed, 1, 'and the palette closes behind it');

  // 5. Nothing deleted recently is said in the page, not left blank; escape steps back to the command page.
  api.empty();
  api.row().run();
  await api.settle();
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.disabled])), [['Nothing deleted recently', true]], 'an empty list says so');
  api.escape();
  assert.equal(api.mode(), 'cmd', 'escape on the page goes back to the command page');
  console.log('ok  Recently deleted: the row is offered, the page reads main\u2019s list with its ages, restores and opens what is chosen, and is honest while loading or empty');
}

// Red until the checks actually settle: an async check left awaiting something that never resolves empties the event
// loop, and node would exit 0 without a word — a silent pass for a check that never finished.
process.exitCode = 1;
Promise.allSettled(checks.map((check) => Promise.resolve().then(check))).then((results) => {
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map((failure) => failure.message).join('\n'));
  console.log('renderer behavior check passed');
  process.exitCode = 0;
});

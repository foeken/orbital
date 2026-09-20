'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const { source, files } = require('./renderer-source');
// The renderer is classic scripts sharing one global scope, loaded in the order index.html lists them. Two things
// break that silently at load time: a name declared twice (a SyntaxError that stops the second file), and a
// top-level statement that runs immediately and reaches for something a later file declares (a ReferenceError).
// Statements that only register callbacks are fine: those run after every file has loaded.
{
  const declared = (text) => [...text.matchAll(/^(?:const|let|async function|function) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const perFile = files.map((f) => ({ f, text: fs.readFileSync(require.resolve('../' + f), 'utf8') }));
  const seen = new Map();
  for (const { f, text } of perFile) for (const name of declared(text)) {
    assert.ok(!seen.has(name), name + ' is declared in both ' + seen.get(name) + ' and ' + f);
    seen.set(name, f);
  }
  perFile.forEach(({ f, text }, i) => {
    const later = new Set(perFile.slice(i + 1).flatMap(({ text }) => declared(text)));
    for (const line of text.split('\n')) {
      if (!/^[A-Za-z_$\[(]/.test(line) || /^(?:const|let|async function|function|class) /.test(line) || /=>|function/.test(line)) continue;
      for (const [, name] of line.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) assert.ok(!later.has(name), f + ' runs "' + line.slice(0, 60) + '" before ' + seen.get(name) + ' has loaded');
    }
  });
}
const match = source.match(/function authView\(s\) \{[\s\S]*?\n\}/);
assert.ok(match, 'renderer auth view helper is present');
const authView = vm.runInNewContext(match[0] + '; authView');

const state = (input) => JSON.parse(JSON.stringify(authView(input)));

assert.deepEqual(state({ authenticated: false, authChecking: true, error: 'temporary failure' }), {
  checking: true, authenticated: false, signedOut: false, showLogin: false, showOutline: true, error: null,
});
assert.deepEqual(state({ authenticated: true, authChecking: false, error: null }), {
  checking: false, authenticated: true, signedOut: false, showLogin: false, showOutline: true, error: null,
});
assert.deepEqual(state({ authenticated: false, authChecking: false, error: null }), {
  checking: false, authenticated: false, signedOut: true, showLogin: true, showOutline: false, error: null,
});
assert.deepEqual(state({ authenticated: null, authChecking: false, error: 'temporary failure' }), {
  checking: false, authenticated: false, signedOut: false, showLogin: false, showOutline: true, error: 'temporary failure',
});
assert.match(source, /if \(signedOut\) rows\.push\(\{ id: 'login'/);
assert.match(source, /s\.authChecking === false && s\.authenticated === false/);
assert.match(source, /if \(hotkeys\.sync\) \{ delete hotkeys\.sync;/);
assert.doesNotMatch(source, /id: 'sync', group: 'Actions', icon: 'sync', label: 'Sync', kbd:/);
assert.doesNotMatch(source, /mod && e\.key === 'r'/);
assert.match(source, /t\.hue != null \? t\.hue : nodeHue/);
assert.match(source, /display\.hue != null/);
assert.match(source, /const rowHue = r\.node \? r\.node\.hue : r\.hue;/);
// a recently viewed row keeps the hue it was recorded with, so its icon is the colour it is everywhere else
assert.match(source, /const entry = \{ id: n\.id,[^}]*hue: n\.hue \}/);
assert.match(source, /if \(rowHue != null\) \{ icon\.classList\.add\('hue'\)/);
assert.match(source, /if \(display\.hue != null\) \{ bullet\.classList\.add\('hue'\)/);
// Per-node icons are still gone: no node carries markup of its own and nothing is dropped onto a row. What came
// back is narrower — a glyph chosen for a *type*, kept app-local as a name (main/icons.js), which every document of
// that type is then drawn with. So the old shape stays out, and what the renderer keeps is a name, never an SVG.
assert.doesNotMatch(source, /iconSvg:|\.iconSvg\b|startDrop/, 'per-node icons and the drop target are gone');
assert.match(source, /customIcons\.set\(icon\.name, icon\.svg\)/, 'the renderer registers glyphs main hands it, by name');
assert.match(source, /typeGlyphs\.set\(icon\.uri, icon\.name\)/, 'and remembers which type wears which, so the picker knows what it has');
assert.match(source, /scrollIntoView\(\{ block: 'nearest', inline: 'nearest', container: 'nearest' \}\)/);
// Meetings, Chats and People are no longer views: each was a fixed query over one kind, which is what a saved search
// is. The kinds stay, so those lists are a search away rather than gone with the pages.
assert.doesNotMatch(source, /id: 'meetings', title: 'Meetings'|id: 'chats', title: 'Chats'|id: 'people', title: 'People'|id: 'tasks', title: 'Tasks'/,
  'the removed views are not served as roots any more');
assert.match(source, /id: 'library', title: 'Library', icon: 'library'/);
assert.match(source, /value: names\(TYPES, f\.types\) \|\| 'Any type', icon: one \? one\[2\] : 'any'/);
assert.match(source, /icon: s\.id === 'library' \? 'library' : s\.icon/);
// every view is the same screen: one loader, one filter per view id (docs/VIEWS.md)
// widenFilter: a view restored with Group by Responsibility asks for Anyone, so the grouping never sections a list
// that cannot hold two of its four headings (renderer/views.js)
assert.match(source, /function loadView\(id = view\) \{\n[\s\S]*?  const filter = widenFilter\(id, filters\.get\(id\)\);\n  if \(filter !== filters\.get\(id\)\) filters\.set\(id, filter\);/);
// a late metadata answer can put a row on screen that was not there (Group by Responsibility), so patchMeta falls
// back to a render when it patched nothing
assert.match(source, /row\.dataset\.sig = rowSig\(item\.node\);[\s\S]*?patched = true;\n  \}\n[\s\S]*?  if \(!patched\) renderSoon\(\);/);
// every section on a grouped page holds rows: no empty heading, and no note under one
assert.doesNotMatch(source, /groupNoteEl|RESPONSIBILITY_NOTE/, 'a section that explains itself instead of holding rows is gone');
// folded sections are read back at load (state.js) and written the moment one is folded or unfolded, so a launch
// draws them folded without a first render that shows the rows and takes them away again
assert.match(source, /const collapsedGroups = new Set\(pref\('collapsedGroups', \[\]\)\);/, 'the folded sections are restored at load, from the preferences that follow you');
assert.match(source, /if \(!collapsedGroups\.delete\(key\)\) collapsedGroups\.add\(key\);\n(?:[^\n]*\n)?  setPref\('collapsedGroups', \[\.\.\.collapsedGroups\]\);/, 'and written on every toggle');
// a page whose sections are all folded away is not an empty page: its headings are drawn, so neither the zoomed
// "No content" nor a view's "Nothing here yet" may appear under them
assert.match(source, /if \(parent && !list\.length && !outline\.children\.length\) \{/, 'the zoomed empty note goes by what was drawn, not by the row count');
assert.match(source, /if \(!parent && !list\.length && !outline\.children\.length && !loading && !filterEl\.value\) \{/, 'and so does a view\'s');
assert.doesNotMatch(source, /loadLibrary|loadChats|loadInbox|taskFilter|libraryFilter/);
assert.match(source, /const chatIcon = \(n\) => n\.icon \|\| \(\(n\.tags \|\| \[\]\)\.some\(\(t\) => t\.label === 'chat'\) \? 'chat' : undefined\);/);
assert.match(source, /const nodeIcon = \(n\) => chatIcon\(n\) \|\| \(\(n\.tags \|\| \[\]\)\.some\(\(t\) => t\.label === 'agent'\) \? 'agent' : undefined\);/);
assert.doesNotMatch(source, /pinTree|pinRows/, 'the sidebar pin sections are gone from Cmd+K; only the pin state of the current document is read');
assert.match(source, /\{ create: true, label: 'Create “' \+ title/);
// linking preselects a result only when its title starts with the typed text; otherwise "Create" stays selected
assert.match(source, /const starts = nodes\.findIndex\(\(n\) => \(n\.title \?\? n\.text \?\? ''\)\.toLowerCase\(\)\.startsWith\(q\.toLowerCase\(\)\)\);/);
assert.match(source, /palIndex = linkCtx \? \(starts < 0 \? 0 : starts \+ \(palRows\[0\] && palRows\[0\]\.create \? 1 : 0\)\) : 0;/);
assert.match(source, /palRows\.find\(\(row\) => row\.create\)/);
assert.match(source, /tana\.toggleCheckbox\(item\.docId, item\.node\.id\)/);
assert.match(source, /else toggleCheckbox\(item\)/);
assert.match(source, /const isCheckboxBlock = \(node\) => node\?\.kind === 'block' && node\.done != null/);
assert.match(source, /function visibleTags\(node\) \{/);
assert.match(source, /tags\.some\(\(tag\) => tag\.label !== 'task'\) \? tags\.filter\(\(tag\) => tag\.label !== 'task'\) : tags/);
assert.match(source, /const docRow = \(n, hint, run\) => \(\{ node: n, icon: n\.icon, label: n\.text \?\? n\.title, tags: visibleTags\(n\)/);
assert.match(source, /parent\.node\?\.kind !== 'document' && parent\.node\?\.done != null \? 0 : undefined/);
assert.match(source, /f && f\.node\.kind === 'block' && f\.node\.done != null \? 0 : undefined/);
assert.match(source, /f\.node\.kind === 'block' && f\.node\.done != null \? 0 : undefined/);
// both still get a box, but a task's box is its status and the Display pill can hide it; a checkbox block is outline
// content the user typed rather than a fact about the row, so it is never hidden
assert.match(source, /if \(\(isTask\(display\) && displayOn\('status'\)\) \|\| \(!isTask\(display\) && isCheckboxBlock\(display\)\)\)/);
assert.match(source, /function inheritCheckbox\(parent, nodeId\)/);
assert.match(source, /const canEditNode = \(node\) => !!node && node\.editable !== false;/);
// a resolved reference (native embed or full-line) checks its target off; an ordinary row checks itself
assert.match(source, /check\.disabled = target \? !canEditNode\(display\) : !canEditItem\(item\);/);
assert.match(source, /if \(!canEditItem\(item\)\) \{/);
assert.match(source, /tana\.taskMeta\(docId\)/);
assert.match(source, /const taskMetaById = new Map\(\), taskMetaLoading = new Set\(\), taskMetaFailed = new Map\(\);/);
assert.match(source, /if \(!connected \|\| !tana\.taskMeta \|\| !isRealId\(docId\) \|\| isGone\(docId\) \|\| taskMetaById\.has\(docId\) \|\| taskMetaLoading\.has\(docId\) \|\| \(backoff && Date\.now\(\) < backoff\.until\)\) return;/);
assert.match(source, /const isRealId = \(id\) => typeof id === 'string' && id\.startsWith\('tana:'\);/);
// Tana titles are plain text: the @ picker must not open there, so the key types an ordinary character (#53)
assert.doesNotMatch(source.slice(source.indexOf("titleEl.addEventListener('keydown'"), source.indexOf('// the document Cmd+K context actions')), /startLink/, 'the title keydown handler never opens the link picker');
assert.match(source, /taskMetaFailed\.set\(docId, \{ until: Date\.now\(\) \+ wait, wait \}\);/);
// a new connection clears the metadata backoff and refetches the active view and the saved-search list, both of
// which can fetch before the client existed and neither of which is retried on its own (searchesReconnectCheck
// in renderer-check.js exercises the searches half of this behaviorally)
assert.match(source, /const wasConnected = connected;[\s\S]*?if \(connected && !wasConnected\) \{ taskMetaFailed\.clear\(\); loadSearches\(\); restorePlace\(\)\.finally\(\(\) => loadView\(\)\); \}/);
// a global change (a refresh, a pin, a filter) reloads the cached rows, which the refresh loop wrote before saying so;
// it must not run the active view's query a second time, and a single document's change patches its row alone
assert.match(source, /loadRoots\(\)\.then\(renderSoon, showError\)/);
assert.doesNotMatch(source.slice(source.indexOf('tana.onChanged((docId, info) => {'), source.indexOf('function removeStale')), /loadView\(\)/, 'no second query per refresh');
assert.match(source, /const work = \[patchDoc\(docId\)\];/);
// Forced, so a zoom whose parked caret defers an ordinary render still redraws — and coalesced, because a view
// announces one of these per document it subscribes and each forced redraw is a whole outline.
assert.match(source, /Promise\.all\(work\)\.then\(\(\) => renderSoon\(true\), showError\)/, 'a live document update redraws a zoom even while its parked caret would defer an ordinary render');
assert.match(source, /const loading = !parent && !outline\.children\.length/);
assert.match(source, /tana\.setAssignees\(doc\.id, assignees\)/);
assert.match(source, /const AUDIENCES = \{/);
assert.match(source, /'only-me': \{ icon: 'lock', label: 'Visible only to you' \}/);
assert.match(source, /people: \{ icon: 'userLock', label: 'Visible to selected people' \}/);
assert.match(source, /space: \{ icon: 'houseLock', label: 'Visible to space members' \}/);
assert.match(source, /function audienceInfo\(audience, audienceSpace\) \{/);
assert.match(source, /const title = audience\?\.title \|\| audienceSpace\?\.title/);
assert.match(source, /label: 'Visible to members of ' \+ title/);
assert.match(source, /everyone: \{ icon: 'users', label: 'Visible to everyone' \}/);
assert.match(source, /el\.textContent = summary\.assignees/);
assert.match(source, /summary\.assignees === 'Unassigned'/);
assert.match(source, /iconNode\('unassigned'\)/);
assert.match(source, /icon: 'unassigned', label: 'Unassigned'/);
assert.doesNotMatch(source, /return 'Assigned to ' \+ assignees/);
assert.match(source, /label: 'Edit assignees'/);
assert.match(source, /palMode === 'assignees'/);
assert.match(source, /e\.key === 'Backspace' && \(!mod \|\| e\.shiftKey\)/);
assert.match(source, /tana\.removeMany\(its\[0\]\.docId, its\.map\(\(it\) => it\.node\.id\)\)/);
assert.match(source, /tana\.moveMany\(its\[0\]\.docId, its\.map\(\(it\) => it\.node\.id\), dir\)/);
assert.match(source, /if \(palBusy && \(palMode === 'spaces' \|\| palMode === 'search'\)\) \{ palEnter = create \? 'create' : 'pick'; return; \}/, 'an Enter during a running search is kept, not dropped');
assert.match(source, /else if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\);/);
assert.match(source, /function openCreationPalette\(\)/);
assert.match(source, /id: 'create', group: 'Actions', icon: 'createNew', label: 'Create new…'/);
assert.match(source, /tana\.creationOptions\(\)/);
assert.match(source, /function startCreation\(choice\)/);
assert.match(source, /draftDocNode\(choice\.kind, \{ typeUri: choice\.typeUri, icon: choice\.icon, tags \}\)/);
assert.match(source, /tana\.createDocument\(text, node\.createOptions \|\| \{ kind: node\.draft \}\)/);
// one fetch path for every view: its rows replace that view's list, and its truncation is remembered per view
assert.match(source, /if \(result\.truncated\) truncated\.add\(id\); else truncated\.delete\(id\);/);
assert.match(source, /truncated\.has\(view\) \? 'Showing the first 1,000 results' : ''/);
assert.match(source, /function blockSelection\(keys, contiguous, action\)/);
assert.match(source, /tana\.setStateMany\(ctx\.docs\.map\(\(doc\) => doc\.id\), state\)/);
assert.match(source, /tana\.setAssigneesMany\(ctx\.docs\.map\(\(doc\) => doc\.id\), uris\)/);
assert.match(source, /const rows = \[\.\.\.selection\];/, 'what acts on the selection comes before everything else in Cmd+K');
// the current document's own actions (pins, link, icon, visibility, location) follow under the same heading, before the views
assert.ok(source.indexOf("const docGroup = selection.length && selection[0].group === 'Selection' ? 'Actions' : 'Current node';") < source.indexOf("const viewRows = views.map((s) => ({ id: 'view:'"), 'the document actions join the Current node group ahead of the views');
assert.match(source, /function invalidatePinCaches\(id, includeRecent = true\)/);
assert.match(source, /function unpinStale\(id\) \{\s*invalidatePinCaches\(id, false\);/);
assert.match(source, /if \(tana\.onRemoved\) tana\.onRemoved\(removeStale\);/);
assert.match(source, /if \(tana\.onUnpinned\) tana\.onUnpinned\(unpinStale\);/);
assert.doesNotMatch(source, /typeof change === 'string'\) return \[change\]/);
assert.match(source, /const isReference = \(node\) => node\.type === 'reference';/);
assert.match(source, /referenceTarget\(node\)\?\.text \|\| node\.reference\?\.label \|\| node\.text/);
assert.match(source, /function toggleReference\(node\)/);
assert.match(source, /function openReference\(node\)/);
assert.match(source, /delete document\.documentElement\.dataset\.theme/);
assert.match(source, /id: 'theme', group: 'Actions', icon: 'darkLight', label: 'Toggle ' \+ \(dark \? 'light' : 'dark'\) \+ ' mode'/);
assert.match(source, /e\.key === '0' \|\| \(e\.shiftKey/);
assert.match(source, /pendingSplit: true/);
assert.match(source, /readSplitDraft\(\);/);
assert.match(source, /const canExpand = \(item\) => hasKids\(item\) \|\| \(!item\.node\.draft && canEditItem\(item\)\);/);
assert.match(source, /chev\.classList\.toggle\('off', !expandable\)/); // the gutter stays in the layout; see runRowAlignmentCheck
assert.match(source, /if \(value && !canExpand\(item\)\) return/);
assert.match(source, /rules\.has\('inherit'\).*token: access\.sharingToken/s);
assert.match(source, /tana\.previewMove\(doc\.id, space\.id\)/);
assert.match(source, /tana\.moveToSpace\(doc\.id, space\.id, token\)/);
assert.match(source, /function removeZoomedBlock\(\) \{[\s\S]*removeNode\(item\)/);
assert.match(source, /async function removeDocument\(item\) \{[\s\S]*tana\.deleteDocument\(item\.docId\)/);
assert.match(source, /const access = await tana\.accessOptions\(item\.docId\);[\s\S]*access\?\.deletable/);
assert.match(source, /onRemoved: \(cb\) => removed\.push\(cb\)/);
assert.match(source, /e\.key === 'Backspace' && \(e\.metaKey \|\| e\.ctrlKey\) && e\.shiftKey\) \{ e\.preventDefault\(\); removeDocument\(item\); \}/);
assert.match(source, /e\.key === 'Backspace' && document\.activeElement === document\.body && zoom\) \{ e\.preventDefault\(\); removeZoomedBlock\(\); \}/);

// The extracted function may call the frame-coalesced render or the row patcher; a harness that stubs render alone
// gets both routed to its stub, a harness that defines them keeps its own (assignment, so no redeclaration).
const RENDER_SHIM = 'globalThis.renderSoon ??= (...a) => render(...a); globalThis.patchMeta ??= () => render(); globalThis.iconNode ??= () => null;\n';
const withShims = (src) => (/\b(renderSoon|patchMeta|iconNode)\b/.test(src) ? RENDER_SHIM + src : src);
function functionSource(name) {
  const asyncStart = source.indexOf('async function ' + name + '(');
  const start = asyncStart >= 0 ? asyncStart : source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'renderer function ' + name + ' is present');
  let depth = 0;
  for (let end = start; end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}' && --depth === 0) return withShims(source.slice(start, end + 1));
  }
  assert.fail('renderer function ' + name + ' is complete');
}

const visibleTags = vm.runInNewContext(`
  const isTask = (node) => node.kind === 'document' && node.icon === 'task';
  ${functionSource('visibleTags')}
  visibleTags;
`);
assert.deepEqual(JSON.parse(JSON.stringify(visibleTags({ kind: 'document', icon: 'task', tags: [{ label: 'task', color: 'grey' }, { label: 'Project', hue: 268 }] }))), [{ label: 'Project', hue: 268 }], 'a typed task keeps its custom tag and hides #task');
assert.deepEqual(JSON.parse(JSON.stringify(visibleTags({ kind: 'document', icon: 'task', tags: [{ label: 'task', color: 'grey' }] }))), [{ label: 'task', color: 'grey' }], 'an untyped task retains #task');

const audienceInfo = vm.runInNewContext(`
  const AUDIENCES = {
    'only-me': { icon: 'lock', label: 'Visible only to you' },
    people: { icon: 'userLock', label: 'Visible to selected people' },
    space: { icon: 'houseLock', label: 'Visible to space members' },
    everyone: { icon: 'users', label: 'Visible to everyone' },
  };
  ${functionSource('audienceInfo')}
  audienceInfo;
`);
assert.deepEqual(JSON.parse(JSON.stringify(audienceInfo('space', { uri: 'tana:space:foundry', title: 'Studio LT' }))), { icon: 'houseLock', label: 'Visible to members of Studio LT', space: 'Studio LT' }, 'a resolved space audience names the space in its tooltip and beside the assignee');
assert.deepEqual(JSON.parse(JSON.stringify(audienceInfo('space'))), { icon: 'houseLock', label: 'Visible to space members' }, 'a missing space title keeps the generic fallback');
assert.equal(audienceInfo('unknown'), null, 'unknown visibility keeps the existing fallback path');

async function splitTypingCheck() {
  const context = {};
  vm.runInNewContext(`
    const checkbox = { id: 'checkbox', kind: 'block', text: 'Checkbox', done: 0, children: [] };
    const kids = new Map([['doc', [checkbox]]]), open = new Map(), items = new Map();
    const item = { key: 'doc/checkbox', docId: 'doc', node: checkbox, parent: {} };
    let draftEl, realEl = { segs: [] }, focused, saved, resolveInsert;
    const canEditItem = () => true;
    const readSegs = (el) => el.segs;
    const splitSegs = (segs) => [segs, []];
    const plainOf = (segs) => segs.map((s) => s.text || '').join('');
    const segsOf = (node) => node.segments || (node.text ? [{ text: node.text }] : []);
    const saveValue = (segs) => segs;
    const hasKids = () => false, isOpen = () => false, dropPending = () => {};
    ${source.match(/const siblingBlock = .*/)[0]}
    const textEl = (key) => key.includes('draft:split:') ? draftEl : realEl;
    const caretOffset = (el) => el.offset;
    const placeCaret = (key, offset) => { focused = { key, offset }; };
    const render = () => {
      const draft = kids.get('doc').find((node) => node.pendingSplit);
      if (draft) draftEl ||= { segs: draft.segments, offset: 0 };
      const real = kids.get('doc').find((node) => node.id === 'new');
      if (real) items.set('doc/new', { key: 'doc/new', docId: 'doc', node: real });
    };
    const renderSegs = (el, segs) => { el.segs = segs; };
    const scheduleSave = (_item, segs) => { saved = segs; };
    const reload = async () => { kids.set('doc', [{ id: 'new', kind: 'block', text: '', done: 0, children: [] }]); };
    const run = async (fn) => fn();
    const tana = {
      setText: async () => {},
      split: async (_docId, _id, _before, _after, asChild) => { if (asChild) throw new Error('unexpected child insert'); return new Promise((resolve) => { resolveInsert = resolve; }); },
    };
    ${functionSource('splitNode')}
    Object.assign(globalThis, {
      start: () => splitNode(item, { segs: [{ text: 'Checkbox' }], offset: 8 }, 8),
      type: (text) => { draftEl.segs = [{ text }]; draftEl.offset = text.length; },
      finish: () => resolveInsert('new'),
      state: () => ({ saved, text: realEl.segs, focused }),
    });
  `, context);
  const pendingSplit = context.start();
  await Promise.resolve();
  context.type('Checkbox sibling test');
  context.finish();
  await pendingSplit;
  assert.deepEqual(JSON.parse(JSON.stringify(context.state())), {
    saved: [{ text: 'Checkbox sibling test' }],
    text: [{ text: 'Checkbox sibling test' }],
    focused: { key: 'doc/new', offset: 21 },
  }, 'rapid typing into an Enter-created sibling survives the async insert and reload');
}

async function cachedBootMetadataCheck() {
  const context = { setTimeout, clearTimeout, Date };
  vm.runInNewContext(`
    let authed = false, authChecking = true, signedOut = false, connected = false, calls = 0, renders = 0, outcome = 'fail';
    const taskMetaById = new Map(), taskMetaLoading = new Set(), taskMetaFailed = new Map();
    ${source.match(/const META_RETRY_MS = \d+, META_RETRY_MAX = \d+;/)[0]}
    const tana = { taskMeta: () => {
      calls++;
      return outcome === 'fail' ? Promise.reject(new Error('not connected')) : Promise.resolve({ assignees: [] });
    } };
    const palette = { hidden: true }, palDoc = null, outline = {};
    const $ = () => ({}), showError = () => {}, loadView = () => {}, loadSearches = () => {}, restorePlace = async () => {};
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
    const isGone = () => false, noteGone = () => false; // the deleted-node set is exercised in renderer-behavior-check
    const render = () => { renders++; };
    ${functionSource('authView')}
    ${functionSource('showStatus')}
    ${functionSource('loadTaskMeta')}
    Object.assign(globalThis, {
      load: () => loadTaskMeta('tana:text:01j0cached000000000000000'),
      status: (isConnected) => showStatus({ authenticated: true, authChecking: false, connected: isConnected }),
      succeed: () => { outcome = 'success'; },
      state: () => ({ calls, renders, loading: taskMetaLoading.size, failed: taskMetaFailed.has('tana:text:01j0cached000000000000000'), cached: taskMetaById.has('tana:text:01j0cached000000000000000') }),
    });
  `, context);
  context.load();
  assert.deepEqual(JSON.parse(JSON.stringify(context.state())), { calls: 0, renders: 0, loading: 0, failed: false, cached: false }, 'cached boot does not request metadata before sync connects');
  context.status(true); context.load();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(context.state())), { calls: 1, renders: 1, loading: 0, failed: true, cached: false }, 'a failed metadata request backs off instead of retrying on every render');
  context.load();
  assert.equal(context.state().calls, 1, 'the failed metadata request stays quiet for the length of its backoff');
  context.status(false); context.status(true); context.succeed(); context.load();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(context.state())), { calls: 2, renders: 4, loading: 0, failed: false, cached: true }, 'connection recovery retries metadata once and preserves cached boot content');
}

// main.js creates the window before S.client is assigned (await start() runs after), so the boot-time
// tana.searches() call in renderer/app.js almost always races the connection and comes back to an empty
// searchList — see the final review, Important #1. showStatus's connect edge (connected: false -> true) must
// re-run it, the same edge that already reloads the active view for the same reason.
async function searchesReconnectCheck() {
  const context = { setTimeout, clearTimeout, Date };
  vm.runInNewContext(`
    let authed = false, authChecking = true, signedOut = false, connected = false, searches = [], attempts = 0, searchesLoaded = false;
    const repairHome = () => {}; // the Home repair has its own check; this one is about the reconnect edge
    const taskMetaFailed = new Map();
    const outline = {}, palette = { hidden: true };
    const $ = () => ({}), showError = () => {}, loadView = () => {}, render = () => {}, renderSoon = () => {}, restorePlace = async () => {};
    const tana = { searches: () => { attempts++; return Promise.resolve([{ id: 'tana:search:x' }]); } };
    ${functionSource('authView')}
    ${functionSource('showStatus')}
    ${functionSource('loadSearches')}
    Object.assign(globalThis, {
      boot: () => loadSearches(),
      status: (isConnected) => showStatus({ authenticated: true, authChecking: false, connected: isConnected }),
      state: () => ({ attempts, searches: searches.length }),
    });
  `, context);
  // Boot alone (no connect-edge transition) still asks once, so a session that is already connected when app.js
  // loads (e.g. a reload) does not sit waiting for a transition that will not happen.
  context.boot();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(context.state())), { attempts: 1, searches: 1 }, 'boot loads searches once on its own');
  // The race the review found: boot's call already lost (client not up yet), and nothing retried it until now.
  context.status(false); context.status(true);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(context.state().attempts, 2, 'the connect edge reloads saved searches, same as it does the active view');
  context.status(true);
  await Promise.resolve();
  assert.equal(context.state().attempts, 2, 'staying connected does not reload again');
}

async function mockCreationPermissionCheck() {
  const mockApi = vm.runInNewContext(`
    const plainOf = (value) => typeof value === 'string' ? value : (value || []).map((segment) => segment.text || '').join('');
    const segsOf = (value) => typeof value === 'string' ? [{ text: value }] : value || [];
    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const localDate = () => '2026-09-13';
    ${functionSource('mockApi')}
    mockApi;
  `);
  const api = mockApi();
  const created = await api.createDocument('Created task', { kind: 'task' });
  assert.equal(created.editable, true, 'a materialized mock document reports the editable capability');
  assert.equal((await api.accessOptions(created.id)).deletable, true, 'a materialized mock document can be deleted like a native editable document');
}

// ---- formatting: marks, block types, the selection toolbar and the "/" menu ----
assert.match(source, /const MARK_TAGS = \{ code: 'code', strike: 's', italic: 'em', bold: 'strong' \}/);
assert.match(source, /function markRange\(segs, start, end, mark, value\)/);
assert.match(source, /const saveValue = \(segs\) => \(segs\.some\(\(s\) => 'mention' in s \|\| hasMarks\(s\.marks\)\)/); // a marked run is never flattened to a string
assert.match(source, /const blockTypeOf = \(node\) => \(BLOCK_LABEL\.has\(node\.block\)/); // readOutline carries the type as node.block
assert.match(source, /document\.addEventListener\('selectionchange', updateToolbar\)/);
assert.match(source, /const MARK_KEYS = \{ b: 'bold', i: 'italic', e: 'code' \}/);
assert.match(source, /e\.key === 'Escape' && !toolbarEl\.hidden\) \{ e\.preventDefault\(\); returnToSelection\(\); \}/); // Escape dismisses without losing the selection
assert.match(source, /await tana\.setBlockType\(item\.docId, item\.node\.id, type\)/);
assert.match(source, /await tana\.insertDivider\(docId, node\.id\)/);
assert.match(source, /el\.textContent === '\/' && palette\.hidden\) openSlash\(item\)/);
assert.match(source, /e\.target\.closest\('a\.url, a\.link'\)/); // a link mark opens like a bare URL
// a live update must not eat the selection — and putting it back must not scroll the page to it, or clicking a task's
// box while another row holds the caret jumps the view to that other row
assert.match(source, /if \(saved && savedSel\) selectRange\(saved\.key, savedSel\[0\], savedSel\[1\], true\)/);
// ---- filter menus, sidebar rows, empty state ----
assert.match(source, /function pickMenuRow\(r, pick\) \{/);
assert.match(source, /if \(!r\.keepOpen\) menu = null;/);
assert.match(source, /\['References', data\.notes\]/);
assert.doesNotMatch(source, /\['Notes', data\.notes\]/);
assert.match(source, /function railCallRow\(data\) \{/);
assert.match(source, /taskInfoEl\.hidden = !titleTags\.length/); // assignees/visibility moved into the sidebar
// every zoomed document shows its type, not only a task: only the kind chip (label === the row's icon) is dropped
assert.match(source, /const titleTags = parent \? visibleTags\(parent\.node\)\.filter\(\(tag\) => tag\.label !== parent\.node\.icon\) : \[\];/);
assert.match(source, /if \(viewFiltered\(\)\) \{/);
// ⌘F on a saved search page: the key arrives as runAction('filter'), which only fires for a row that exists right
// now, so the row has to be offered there — and the row it opens has to stay on screen and actually narrow the list.
assert.match(source, /if \(!zoom \|\| onSearchPage\(\)\) rows\.push\(\{ id: 'filter'/, 'a saved search page offers the filter row, so ⌘F reaches it');
// A key recorded for a row that is listed but off (Clean up with nothing held, Go back with no history) is answered
// by doing nothing, rather than falling through to whatever else the combo might mean: one command, one meaning.
assert.match(source, /if \(row\) \{ if \(!row\.disabled\) row\.run\(\); return true; \}/, 'a hotkey for a disabled row is a no-op the app still owns');
// and the palette's own arrows land on such a row, which is the only way Cmd+Shift+K can record a shortcut for it
assert.match(source, /if \(!rows\[next\]\.disabled \|\| rows\[next\]\.id\) return next;/, 'Up/Down reach a disabled row that has a stable id, so it can be given a key before it goes live');
assert.match(source, /filterRow\.hidden = \(!!parent && !isSearchDoc\(parent\.node\)\)/, 'the filter row stays on screen on a saved search page');
assert.match(source, /if \(isSearchDoc\(parent\.node\)\) \{/, 'the zoomed branch narrows a saved search the way a view narrows its rows');
// the Library keeps the query it is showing as a saved search; main owns the filter→query translation
assert.match(source, /if \(defs\.length && tana\.createSearch && !onSearchPage\(\)\) box\.append\(saveSearchPill\(\)\)/, 'a view with pills offers to save its query as a search, and a saved search does not: it already is one');
// Clean up is a header button beside the fold one, offered wherever the pills are — folded or not, on a view as
// well — because a row kept in place is exactly when it is wanted.
assert.match(source, /renderCleanupBtn\(!!show && needsCleanup\(shownDocs\(\)\)\)/, 'Clean up is decided while the pills render, whether or not the row is on screen');
// It is pressed straight after a status change, so the caret is still in that row and a render is waiting on it.
// Without this the mousedown moved the focus, ran that render, and the mouseup landed on what it had drawn: the
// first press did nothing at all.
assert.match(source, /cleanupBtn\.onmousedown = \(e\) => e\.preventDefault\(\);\ncleanupBtn\.onclick = cleanupNow;/, 'Clean up keeps the focus where it is, so the press is not lost to the render it would otherwise trigger');
// It comes and goes with the rows being held, so it arrives with a pop rather than appearing between two frames —
// through the same one-shot helper the Refresh turn uses, which is what makes a second arrival play again.
assert.match(source, /const arriving = cleanupBtn\.hidden \|\| cleanupBtn\.classList\.contains\('out'\);/, 'Clean up knows when it has turned up, including while it was leaving');
assert.match(source, /if \(arriving\) playOnce\(cleanupBtn, 'in'\);/, 'and pops in then, rather than on every render that keeps it');
// Leaving waits for the animation, and a button wanted again while it is going stays: the render that keeps it
// takes the class off, and the animation still running then ends on an element that is staying put.
assert.match(source, /if \(!cleanupBtn\.classList\.contains\('out'\)\) return;\n    cleanupBtn\.classList\.remove\('out'\);\n    cleanupBtn\.hidden = true;/, 'and it is hidden only at the end of a leave nothing interrupted');
// A view re-asks its query every half minute; a saved search is asked once, when it is opened, so it needs a button.
// It is a header button beside the fold one, not a pill: folding the pills away must not take it with them.
assert.match(source, /renderRefreshBtn\(search && !searchRows\.has\(zoom\.docId\)\)/, 'a saved search offers Refresh, and not while a staged filter preview owns its rows');
assert.match(source, /function renderRefreshBtn\(available\) \{[\s\S]{0,320}iconNode\('reload'\)/, 'the Refresh button carries the reload glyph');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
assert.match(html, /<div id="toolbar" class="toolbar" role="toolbar"/);
const styleSheet = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
// #taskInfo .chip:first-child — the chip under a zoomed title starts where the title starts: the 6px a chip carries
// is its gap from what precedes it, and at the start of that line nothing does.
for (const rule of [/\.toolbar \{/, /\.tbtn \{/, /\.text code \{/, /\.text a\.link \{/, /\.node\.t-numbered \{/, /\.node\.t-code > \.line \.text \{/, /\.node\.t-quote > \.line \.text \{/, /\.text\.divider hr \{/, /\.clearfilters \{/, /#taskInfo \.chip:first-child \{ margin-left: 0; \}/]) {
  assert.match(styleSheet, rule, 'styles.css carries ' + rule.source);
}
// a closed palette must hide even while it still carries the @ dropdown class (#240): same weight, later rule wins
assert.doesNotMatch(styleSheet, /\.palette\.anchored \{/, 'the @ dropdown layout must not outweigh .palette[hidden]');
assert.match(styleSheet, /\.palette\.anchored:not\(\[hidden\]\) \{/, 'the @ dropdown layout applies only while the palette is shown');
// The agent prompt page is an editor, not a list to search: it never says "No results" under its one row, and the
// query that found "Assign to Agent" is cleared on the way in, or its letters would show as bold in that row.
assert.match(source, /palMode !== 'agentPrompt' && \(palMode === 'cmd'/, 'the no-results line skips the prompt page');
assert.match(source, /function openAgentPrompt\(doc\) \{[\s\S]{0,400}palInput\.value = '';/, 'opening the prompt page clears the query behind it');
// The agent badge sits at the end of the row — after the body, which is the flexible part of the line — and its
// sweep is opt-in: a reduced-motion setting leaves it still, like every other animation here.
assert.match(source, /line\.append\(body\);[\s\S]{0,240}if \(codexIds\.has\(display\.id\)\) line\.append\(codexBadgeEl\(display\.id, display\.done\)\)/,
  'the agent badge is appended after the body, so it ends the row, and is told whether that row is finished');
// The badge is a status, so it can never be drawn without one: every call names the node whose state it shows, and
// the state falls back to pending rather than to the green it used to be.
assert.doesNotMatch(source, /codexBadgeEl\(\)/, 'no badge is drawn without the node whose task status it reports');
// A badge with a task behind it opens it; a pending one has nowhere to go and must not pretend otherwise.
assert.match(source, /el\.setAttribute\('role', linked \? 'button' : 'img'\)/, 'only a linked badge is a button');
assert.match(source, /tana\.openCodexTask\(id\)/, 'and it opens that node\'s own task, by node, never by a url the renderer builds');
assert.match(source, /if \(e\.key === 'Enter' \|\| e\.key === ' '\)/, 'reachable from the keyboard, not the mouse alone');
assert.match(source, /const agentStateOf = \(id\) => \(AGENT_BADGE\[agentStates\.get\(id\)\] \? agentStates\.get\(id\) : 'pending'\)/,
  'an assigned node with no linked task reads as pending');
for (const [state, label] of [['pending', 'Agent pending'], ['working', 'Agent working'], ['waiting', 'Agent waiting for you'], ['done', 'Agent completed'], ['broken', 'Agent needs attention']]) {
  assert.match(source, new RegExp(state + ": \\{ label: '" + label + "'"), state + ' says "' + label + '" in words, so the colour is never the only signal');
}
// The sheen is a pseudo-element, so nothing about the badge itself moves, and it exists only where motion is welcome:
// under reduced motion the rule is not even declared, which leaves the plain green tag.
const sheen = styleSheet.match(/@media \(prefers-reduced-motion: no-preference\) \{ \.cbadge\.working::after \{[^\n]*\}/);
assert.ok(sheen, 'the scan sweep is drawn on .cbadge::after, behind the reduced-motion gate');
// and on working alone: every other state is still, whatever the colour says
for (const state of ['pending', 'waiting', 'done', 'broken']) {
  assert.doesNotMatch(styleSheet, new RegExp('\\.cbadge\\.' + state + '[^\\n]*animation:'), state + ' does not animate');
}
assert.match(sheen[0], /animation: cbadge-sweep (2\.[5-9]|3(\.0)?)s/, 'it crosses the badge every two and a half to three seconds');
assert.match(styleSheet, /\.cbadge \{[^\n]*overflow: hidden/, 'and is clipped to the badge, so it reads as a sweep across it rather than a streak over the row');
// Transform only: a sweep that moved the badge, resized it or faded the whole tag would be the thing this replaced.
const sweep = styleSheet.match(/@keyframes cbadge-sweep \{[\s\S]*?\n/)[0];
assert.match(sweep, /transform: translateX\(-?\d+%\)/, 'the sheen travels sideways');
for (const property of ['width', 'height', 'margin', 'padding', 'font-size', 'opacity', 'scale']) {
  assert.doesNotMatch(sweep, new RegExp('(^|[^-])' + property + ':'), 'the sweep must not animate ' + property);
}
assert.doesNotMatch(styleSheet, /\.cbadge \{[^\n]*animation:/, 'the badge itself never animates: only the sheen inside it does');
// The Refresh button's single turn is opt-in the same way: under reduced motion the rule the class selects is not
// declared, so the glyph stays where it is. Transform only, so a turning icon cannot move anything around it.
assert.match(styleSheet, /@media \(prefers-reduced-motion: no-preference\) \{ \.navbtn svg\.spin \{ animation: pill-spin/,
  'the Refresh icon turns only where motion is welcome');
const turn = styleSheet.match(/@keyframes pill-spin \{[^\n]*\}/)[0];
assert.match(turn, /transform: rotate\(360deg\)/, 'and it is one full turn');
// A header button that is offered on some pages and not others has to be able to disappear: .navbtn sets its own
// display, which wins over the browser's rule for [hidden] and left Refresh and the fold button as blank slots.
assert.match(styleSheet, /\.navbtn\[hidden\] \{ display: none; \}/, 'a withheld header button is gone rather than empty');
// Clean up arrives with a pop and shrinks away again rather than appearing and disappearing between two frames,
// and both are opt-in: under reduced motion neither rule is declared and pills.js hides it on the spot.
const btnMotion = styleSheet.match(/@media \(prefers-reduced-motion: no-preference\) \{\n  \.navbtn\.in \{[^}]*\}\n  \.navbtn\.out \{[^}]*\}\n\}/);
assert.ok(btnMotion, 'a header button that comes and goes pops in and shrinks away, only where motion is welcome');
assert.match(btnMotion[0], /animation: btn-in [\d.]+s/, 'the arrival is one shot');
assert.match(btnMotion[0], /animation: btn-out [\d.]+s[^;]*forwards/, 'and the departure holds where it ends, so nothing flashes back before it is hidden');
// Every render builds the pills again, so the arrival is marked on each pill rather than on the row: with it on the
// row, a redraw landing while they were still coming in handed the mark to the new pills and played it all again.
assert.match(source, /el\.style\.setProperty\('--i', i\); if \(arriving\) el\.classList\.add\('in'\)/, 'a pill knows it is arriving; the row does not');
assert.match(styleSheet, /\.pills > \.pill\.in \{ animation: pill-in/, 'and that is what the entrance is drawn from');
// Only the press moves the row: a view's pills are the view, and a page just arrived at — a reload, a link, the
// Library — is drawn as it stands rather than assembling itself in front of you.
assert.match(source, /const arriving = search && pillsPressed && \(box\.hidden \|\| box\.classList\.contains\('out'\)\)/, 'only a pressed fold animates the pills in');
assert.match(source, /const last = stillPreferred\(\) \|\| !pillsPressed \? null : box\.lastElementChild;/, 'and only a pressed fold plays them out');
// Nothing waits for that turn any more: the button is drawn once and outlives the redraw its answer brings, so the
// rows land when they arrive and the glyph finishes turning on its own.
assert.doesNotMatch(source, /SPIN_MS|await Promise\.all\(\[answered, turning\]\)/, 'the redraw no longer waits for the turn, and no duration is kept in step with the stylesheet');
// a declaration, not prose about one: the selector and the brace have to be on the line before the property
// The Nucleo set built into the app is the one exception, and it is the opposite of an exception in spirit: those
// glyphs carry `stroke-width: var(--nucleo-stroke-width, 1.5)` of their own, so the app supplies the variable to put
// them on the same weight as everything else rather than leaving them a half-step heavier.
const nucleoWeight = styleSheet.match(/--nucleo-stroke-width: ([\d.]+)/);
assert.ok(nucleoWeight && Number(nucleoWeight[1]) === 1, 'the built-in Nucleo set is drawn at the icon set\'s own weight');
for (const rule of styleSheet.split('\n').filter((line) => /\{[^}]*[^-]stroke-width:/.test(line))) {
  assert.match(rule, /\.pill\.refresh/, 'only the Refresh pill changes an icon\'s weight: ' + rule.trim());
}
const icons = {};
new Function('window', fs.readFileSync(require.resolve('../icons.js'), 'utf8'))(icons);
assert.match(icons.ICONS.reload, /stroke-width="1"/, 'the generated glyph is untouched, so it is the icon set\'s weight everywhere else');
// The machine a task runs on has its own glyph, from the icon build like every other one — not drawn here.
assert.match(source, /group: HOST_GROUP, icon: 'host'/, 'the Run on rows carry the host glyph');
assert.ok(icons.ICONS.host && icons.ICONS.host.includes('currentColor'), 'which is built into icons.js and takes the palette\'s colour');
assert.doesNotMatch(icons.ICONS.host, /<script|<foreignObject|on[a-z]+=/i, 'and carries nothing executable');
for (const property of ['width', 'height', 'margin', 'padding', 'top', 'left']) {
  assert.doesNotMatch(turn, new RegExp('(^|[^-])' + property + ':'), 'the turn must not animate ' + property + ': that would move the pill');
}

Promise.all([splitTypingCheck(), cachedBootMetadataCheck(), mockCreationPermissionCheck(), searchesReconnectCheck()]).then(() => console.log('renderer auth check passed'));
// a mention lands in the row the caret is in (an @ at the caret, or over a selection): the render must not defer
assert.match(functionSource('linkTo'), /render\(true\);[^\n]*\n\s*placeCaret\(/, 'linkTo forces the render before placing the caret after the mention');

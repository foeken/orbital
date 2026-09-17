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
assert.doesNotMatch(source, /iconSvg:|\.iconSvg\b|setIcon|startDrop/, 'app-local custom icons are gone');
assert.match(source, /scrollIntoView\(\{ block: 'nearest', inline: 'nearest', container: 'nearest' \}\)/);
assert.match(source, /id: 'people', title: 'People', icon: 'member'/);
assert.match(source, /title: s\.id === 'people' \? 'People' : s\.title/);
assert.match(source, /id: 'library', title: 'Library', icon: 'library'/);
assert.match(source, /value: names\(TYPES, f\.types\) \|\| 'Any type', icon: one \? one\[2\] : 'any'/);
assert.match(source, /icon: s\.id === 'library' \? 'library' : s\.icon/);
// every view is the same screen: one loader, one filter per view id (docs/VIEWS.md)
assert.match(source, /function loadView\(id = view\) \{\n  const filter = filters\.get\(id\);/);
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
assert.match(source, /if \(isTask\(display\) \|\| isCheckboxBlock\(display\)\)/);
assert.match(source, /function inheritCheckbox\(parent, nodeId\)/);
assert.match(source, /const canEditNode = \(node\) => !!node && node\.editable !== false;/);
assert.match(source, /check\.disabled = reference \? !canEditNode\(display\) : !canEditItem\(item\);/);
assert.match(source, /if \(!canEditItem\(item\)\) \{/);
assert.match(source, /tana\.taskMeta\(docId\)/);
assert.match(source, /const taskMetaById = new Map\(\), taskMetaLoading = new Set\(\), taskMetaFailed = new Map\(\);/);
assert.match(source, /if \(!connected \|\| !tana\.taskMeta \|\| !isRealId\(docId\) \|\| taskMetaById\.has\(docId\) \|\| taskMetaLoading\.has\(docId\) \|\| \(backoff && Date\.now\(\) < backoff\.until\)\) return;/);
assert.match(source, /const isRealId = \(id\) => typeof id === 'string' && id\.startsWith\('tana:'\);/);
// Tana titles are plain text: the @ picker must not open there, so the key types an ordinary character (#53)
assert.doesNotMatch(source.slice(source.indexOf("titleEl.addEventListener('keydown'"), source.indexOf('// the document Cmd+K context actions')), /startLink/, 'the title keydown handler never opens the link picker');
assert.match(source, /taskMetaFailed\.set\(docId, \{ until: Date\.now\(\) \+ wait, wait \}\);/);
// a new connection clears the metadata backoff and refetches the active view and the saved-search list, both of
// which can fetch before the client existed and neither of which is retried on its own (searchesReconnectCheck
// in renderer-check.js exercises the searches half of this behaviorally)
assert.match(source, /const wasConnected = connected;[\s\S]*?if \(connected && !wasConnected\) \{ taskMetaFailed\.clear\(\); loadView\(\); loadSearches\(\); \}/);
// a global change (a refresh, a pin, a filter) reloads the cached rows, which the refresh loop wrote before saying so;
// it must not run the active view's query a second time, and a single document's change patches its row alone
assert.match(source, /loadRoots\(\)\.then\(renderSoon, showError\)/);
assert.doesNotMatch(source.slice(source.indexOf('tana.onChanged((docId, info) => {'), source.indexOf('function removeStale')), /loadView\(\)/, 'no second query per refresh');
assert.match(source, /const work = \[patchDoc\(docId\)\];/);
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
      insertAfter: async () => new Promise((resolve) => { resolveInsert = resolve; }),
      insertChild: async () => { throw new Error('unexpected child insert'); },
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
    const $ = () => ({}), showError = () => {}, loadView = () => {}, loadSearches = () => {};
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
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
    let authed = false, authChecking = true, signedOut = false, connected = false, searches = [], attempts = 0;
    const taskMetaFailed = new Map();
    const outline = {}, palette = { hidden: true };
    const $ = () => ({}), showError = () => {}, loadView = () => {}, render = () => {}, renderSoon = () => {};
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
assert.match(source, /if \(saved && savedSel\) selectRange\(saved\.key, savedSel\[0\], savedSel\[1\]\)/); // a live update must not eat the selection
// ---- filter menus, sidebar rows, empty state ----
assert.match(source, /function pickMenuRow\(r, pick\) \{/);
assert.match(source, /if \(!r\.keepOpen\) menu = null;/);
assert.match(source, /\['References', data\.notes\]/);
assert.doesNotMatch(source, /\['Notes', data\.notes\]/);
assert.match(source, /function railCallRow\(data\) \{/);
assert.match(source, /taskInfoEl\.hidden = !titleTags/); // assignees/visibility moved into the sidebar
assert.match(source, /if \(viewFiltered\(\)\) \{/);
// ⌘F on a saved search page: the key arrives as runAction('filter'), which only fires for a row that exists right
// now, so the row has to be offered there — and the row it opens has to stay on screen and actually narrow the list.
assert.match(source, /if \(!zoom \|\| onSearchPage\(\)\) rows\.push\(\{ id: 'filter'/, 'a saved search page offers the filter row, so ⌘F reaches it');
assert.match(source, /filterRow\.hidden = \(!!parent && !isSearchDoc\(parent\.node\)\)/, 'the filter row stays on screen on a saved search page');
assert.match(source, /if \(isSearchDoc\(parent\.node\)\) \{/, 'the zoomed branch narrows a saved search the way a view narrows its rows');
// the Library keeps the query it is showing as a saved search; main owns the filter→query translation
assert.match(source, /if \(defs\.length && tana\.createSearch && !onSearchPage\(\)\) box\.append\(saveSearchPill\(\)\)/, 'a view with pills offers to save its query as a search, and a saved search does not: it already is one');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
assert.match(html, /<div id="toolbar" class="toolbar" role="toolbar"/);
const styleSheet = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
for (const rule of [/\.toolbar \{/, /\.tbtn \{/, /\.text code \{/, /\.text a\.link \{/, /\.node\.t-numbered \{/, /\.node\.t-code > \.line \.text \{/, /\.node\.t-quote > \.line \.text \{/, /\.text\.divider hr \{/, /\.clearfilters \{/]) {
  assert.match(styleSheet, rule, 'styles.css carries ' + rule.source);
}
// a closed palette must hide even while it still carries the @ dropdown class (#240): same weight, later rule wins
assert.doesNotMatch(styleSheet, /\.palette\.anchored \{/, 'the @ dropdown layout must not outweigh .palette[hidden]');
assert.match(styleSheet, /\.palette\.anchored:not\(\[hidden\]\) \{/, 'the @ dropdown layout applies only while the palette is shown');

Promise.all([splitTypingCheck(), cachedBootMetadataCheck(), mockCreationPermissionCheck(), searchesReconnectCheck()]).then(() => console.log('renderer auth check passed'));
// a mention lands in the row the caret is in (an @ at the caret, or over a selection): the render must not defer
assert.match(functionSource('linkTo'), /render\(true\);[^\n]*\n\s*placeCaret\(/, 'linkTo forces the render before placing the caret after the mention');

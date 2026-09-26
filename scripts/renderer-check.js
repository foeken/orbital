'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const { source, tops } = require('./renderer-source');
// The renderer is classic scripts sharing one global scope, loaded in the order index.html lists them. Two things
// break that silently at load time: a name declared twice (a SyntaxError that stops the second file), and a
// top-level statement that runs immediately and reaches for something a later file declares (a ReferenceError).
// What a function body reaches is fine: it runs after every file has loaded. Both are read off the parsed files, the
// second through eslint's scope analysis, so a loop variable or catch parameter named like a later global is its own.
{
  const seen = new Map();
  for (const { file, names } of tops) for (const name of names) {
    assert.ok(!seen.has(name), name + ' is declared in both ' + seen.get(name) + ' and ' + file);
    seen.set(name, file);
  }
  // a reference runs later only inside a function; a class field is not exempt, since a static one runs at load
  const deferred = (scope) => { for (let s = scope; s; s = s.upper) if (s.type === 'function') return true; return false; };
  tops.forEach(({ file, scope }, i) => {
    const later = new Set(tops.slice(i + 1).flatMap((t) => t.names));
    // through: the references this file does not resolve itself, which is every name another file declares
    for (const { identifier: id, from } of scope.through) {
      assert.ok(!later.has(id.name) || deferred(from), file + ':' + id.loc.start.line + ' reaches "' + id.name + '" at load, before ' + seen.get(id.name) + ' has loaded');
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
assert.doesNotMatch(source, /id: 'sync', group: 'Actions', icon: 'sync', label: 'Sync', kbd:/);
assert.match(source, /id: 'openaiKey', group: 'Settings', icon: 'openaiKey', label: 'Set OpenAI API key'/);
assert.match(source, /id: 'chatgpt', group: 'Settings', icon: 'chatgpt', label: chatgptAuth/);
assert.match(source, /function openOpenAIKeyPalette\(\)[\s\S]*palInput\.type = 'password'/);
assert.match(source, /function openAIKeyRows\(\)[\s\S]*tana\.setOpenAIKey\(key\)/);
assert.doesNotMatch(source, /mod && e\.key === 'r'/);
assert.match(source, /t\.hue != null \? t\.hue : nodeHue/);
assert.match(source, /display\.hue != null/);
// Cmd+K glyphs are monochrome: only a row that sets its own hue (the Set colour page) is tinted, never a node's type colour
assert.match(source, /const rowHue = r\.hue;/);
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
assert.match(source, /value: \[names\(TYPES, kinds\), \.\.\.typed\.map\(typeName\)\]\.filter\(Boolean\)\.join\(', '\) \|\| 'Any type', icon: one \? one\[2\] : /);
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
// A pinned node says so where its audience does, and the mark, the sidebar row and the Cmd+K row all open the one
// page that lists this document's pins and takes them off (api.pinIds for the mark, api.pinState for the page).
assert.match(source, /const isPinned = \(id\) => !!pinnedIds && pinnedIds\.has\(id\);/);
assert.match(source, /function loadPinned\(force\)[\s\S]*tana\.pinIds\(\)/);
assert.match(source, /if \(summary\.pinned && node && isRealId\(node\.id\)\)[\s\S]*openPinsPalette\(node\)/, 'the row mark opens Edit pins');
assert.match(source, /if \(isPinned\(node\.id\)\) rows\.push\(\{ id: 'pinned', icon: 'pinned', label: 'Pinned'/, 'and the sidebar carries the same fact');
assert.match(source, /id: 'editPins', group: docGroup, icon: 'pinned', label: 'Edit pins'/);
assert.match(source, /function editPinRows\(q\)[\s\S]*pinAction\('unpin', 'sidebar'\)[\s\S]*pinAction\('unpin', 'today', date\)/, 'every pin the page lists can be taken off');
assert.match(source, /isPinned\(n\.id\)/, 'a reused row is rebuilt when its pin state changes (rowSig)');
assert.match(source, /\{ create: true, label: 'Create “' \+ title/);
// linking preselects a result only when its title starts with the typed text; otherwise "Create" stays selected
assert.match(source, /const starts = nodes\.findIndex\(\(n\) => \(n\.title \?\? n\.text \?\? ''\)\.toLowerCase\(\)\.startsWith\(q\.toLowerCase\(\)\)\);/);
assert.match(source, /palIndex = linkCtx && starts >= 0 && !\(palRows\[0\] && palRows\[0\]\.date\) \? starts \+ palRows\.filter\(\(r\) => r\.create\)\.length : 0;/);
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
// ...or, read-only but checkable, a task listed on the Timeline (main/timeline.js)
assert.match(source, /const ticks = canEditItem\(item\) \|\| \(!!node\.checkable && isTask\(node\)\);/);
assert.match(source, /check\.disabled = target \? !canEditNode\(display\) : !ticks;/);
assert.match(source, /if \(!canEditItem\(item\) \|\| opensOnClick\(item\)\) \{/);
assert.match(source, /tana\.taskMeta\(docId\)/);
assert.match(source, /const taskMetaById = new Map\(\), taskMetaLoading = new Set\(\), taskMetaFailed = new Map\(\);/);
assert.match(source, /if \(!connected \|\| !tana\.taskMeta \|\| !isRealId\(docId\) \|\| isGone\(docId\) \|\| taskMetaById\.has\(docId\) \|\| taskMetaLoading\.has\(docId\) \|\| \(backoff && Date\.now\(\) < backoff\.until\)\) return;/);
assert.match(source, /const isRealId = \(id\) => typeof id === 'string' && id\.startsWith\('tana:'\);/);
// Tana titles are plain text: the @ picker must not open there, so the key types an ordinary character (#53)
assert.doesNotMatch(source.slice(source.indexOf("titleEl.addEventListener('keydown'"), source.indexOf('// the document Cmd+K context actions')), /startLink/, 'the title keydown handler never opens the link picker');
assert.match(source, /taskMetaFailed\.set\(docId, entry\);/);
assert.match(source, /entry\.until = 0; renderSoon\(\);/, 'the retry timer opens the backoff gate itself rather than racing Date.now()');
// a new connection clears the metadata backoff and refetches the active view and the saved-search list, both of
// which can fetch before the client existed and neither of which is retried on its own (searchesReconnectCheck
// in renderer-check.js exercises the searches half of this behaviorally)
assert.match(source, /const wasConnected = connected;[\s\S]*?if \(connected && !wasConnected\) \{ taskMetaFailed\.clear\(\); loadSearches\(\); loadWorkspaceTypes\(\); loadPinned\(true\); restorePlace\(\)\.finally\(\(\) => \{ placed = true; loadView\(\); renderSoon\(\); \}\); \}/);
// a global change (a refresh, a pin, a filter) reloads the cached rows, which the refresh loop wrote before saying so;
// it must not run the active view's query a second time, and a single document's change patches its row alone
assert.match(source, /const work = \[loadRoots\(\)\];[\s\S]*?Promise\.all\(work\)\.then\(renderSoon, showError\)/);
assert.match(source, /if \(zoom\?\.docId === TIMELINE_PAGE\) work\.push\(reload\(TIMELINE_PAGE\)\)/, 'global pin changes reload the Timeline page when it is open');
assert.doesNotMatch(source.slice(source.indexOf('tana.onChanged((docId, info) => {'), source.indexOf('function removeStale')), /loadView\(\)/, 'no second query per refresh');
assert.match(source, /const work = \[patchDoc\(docId\)\];/);
// Forced, so a zoom whose parked caret defers an ordinary render still redraws — and coalesced, because a view
// announces one of these per document it subscribes and each forced redraw is a whole outline.
assert.match(source, /Promise\.all\(work\)\.then\(\(\) => renderSoon\(true\), showError\)/, 'a live document update redraws a zoom even while its parked caret would defer an ordinary render');
// a zoomed page with no answer yet shows the same animation a view does, rather than a line saying "Loading…"
assert.match(source, /const loading = asking \|\| \(!parent && !outline\.children\.length/);
assert.match(source, /tana\.setAssignees\(doc\.id, assignees\)/);
assert.match(source, /const AUDIENCES = \{/);
assert.match(source, /'only-me': \{ icon: 'lock', label: 'Visible only to you' \}/);
assert.match(source, /people: \{ icon: 'userLock', label: 'Visible to selected people' \}/);
assert.match(source, /space: \{ icon: 'houseLock', label: 'Visible to space members' \}/);
assert.match(source, /function audienceInfo\(audience, audienceSpace\) \{/);
assert.match(source, /const title = audience\?\.title \|\| audienceSpace\?\.title/);
assert.match(source, /label: 'Visible to members of ' \+ named/);
assert.match(source, /everyone: \{ icon: 'users', label: 'Visible to everyone' \}/);
assert.match(source, /who\.textContent = summary\.assignees/);
assert.match(source, /clickable\(who, \(\) => openAssigneePalette\(node\)\)/);
assert.match(source, /clickable\(icon, \(\) => openVisibility\(node, summary\.scope\)\)/);
assert.match(source, /summary\.assignees === 'Unassigned'/);
assert.match(source, /iconNode\('unassigned'\)/);
assert.match(source, /icon: 'unassigned', label: 'Unassigned'/);
assert.doesNotMatch(source, /return 'Assigned to ' \+ assignees/);
assert.match(source, /label: 'Edit assignees'/);
assert.match(source, /palMode === 'assignees'/);
assert.match(source, /e\.key === 'Backspace' && \(!mod \|\| e\.shiftKey\)/);
assert.match(source, /tana\.removeMany\(its\[0\]\.docId, its\.map\(\(it\) => it\.node\.id\)\)/);
assert.match(source, /tana\.moveMany\(its\[0\]\.docId, its\.map\(\(it\) => it\.node\.id\), dir\)/);
assert.match(source, /if \(palBusy && \(palMode === 'spaces' \|\| palMode === 'search' \|\| palMode === 'pinToday'\)\) \{ palEnter = create \? 'create' : 'pick'; return; \}/, 'an Enter during a running search is kept, not dropped');
assert.match(source, /if \(palMode === 'pinToday'\) \{ palSeq\+\+; palBusy = true; clearTimeout\(palTimer\); palTimer = setTimeout\(todayPickerSearchNow, 150\); return; \}/, 'typing invalidates an older today-pin search immediately');
assert.match(source, /else if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\);/);
assert.match(source, /function openCreationPalette\(\)/);
assert.match(source, /id: 'create', group: 'Actions', icon: 'createNew', label: 'Create new …'/);
assert.match(source, /tana\.creationOptions\(\)/);
assert.match(source, /function startCreation\(choice\)/);
assert.match(source, /draftDocNode\(choice\.kind, \{ typeUri: choice\.typeUri, icon: choice\.icon, tags \}\)/);
assert.match(source, /tana\.createDocument\(text, node\.createOptions \|\| \{ kind: node\.draft \}\)/);
// one fetch path for every view: its rows replace that view's list, and its truncation is remembered per view
assert.match(source, /if \(result\.truncated\) truncated\.add\(id\); else truncated\.delete\(id\);/);
assert.match(source, /const cut = parent \? onTypePage\(\) && \(kids\.get\(zoom\.docId\) \|\| \[\]\)\.length >= 1000 : truncated\.has\(view\);/, 'a view says when it was cut, and so does a full type page');
assert.match(source, /cut \? 'Showing the first 1,000 results' : ''/);
assert.match(source, /function blockSelection\(keys, contiguous, action, siblings = true\)/);
// Removing a selection does not need siblings: a set of rows across levels is an ordinary thing to delete, and
// the write takes it (sdk/content.js removeMany). Moving, indenting and outdenting still do.
assert.match(source, /blockSelection\(keys, false, 'Remove', false\)/, 'a selection is removed whatever levels its rows sit on');
assert.match(source, /blockSelection\(keys, true, 'Move'\)/, 'while moving it still asks for a contiguous run of siblings');
assert.match(source, /tana\.setStateMany\(ctx\.docs\.map\(\(doc\) => doc\.id\), state\)/);
assert.match(source, /tana\.setAssigneesMany\(ctx\.docs\.map\(\(doc\) => doc\.id\), uris\)/);
assert.match(source, /const rows = \[\.\.\.selection\];/, 'what acts on the selection comes before everything else in Cmd+K');
assert.match(source, /id: 'sendToAgent'[\s\S]*?tana\.openExternal\('https:\/\/chatgpt\.com\/codex\/open-app\?q=' \+ encodeURIComponent\(link \+ '\\n'\)\)/, 'Send to agent opens a new Codex thread with the current node link and a trailing newline');
// the current document's own actions (pins, link, icon, visibility, location) follow under the same heading, before the views
assert.ok(source.indexOf("const docGroup = selection.length && selection[0].group === 'Selection' ? 'Current page' : 'Current node';") < source.indexOf("const viewRows = views.map((s) => ({ id: 'view:'"), 'the document actions join the Current node group ahead of the views');
assert.match(source, /if \(tana\.onRemoved\) tana\.onRemoved\(removeStale\);/);
assert.doesNotMatch(source, /typeof change === 'string'\) return \[change\]/);
assert.match(source, /const isReference = \(node\) => node\.type === 'reference';/);
assert.match(source, /referenceTarget\(node\)\?\.text \|\| node\.reference\?\.label \|\| node\.text/);
assert.match(source, /function toggleReference\(node\)/);
assert.match(source, /function openReference\(node\)/);
assert.match(source, /delete document\.documentElement\.dataset\.theme/);
assert.match(source, /id: 'theme', group: 'Settings', icon: 'darkLight', label: 'Toggle ' \+ \(dark \? 'light' : 'dark'\) \+ ' mode'/);
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
// ⌘K opens through togglePalette('cmd'), not openCommandPalette: without this read the row said "Checking sign-in" forever
assert.match(functionSource('togglePalette'), /if \(mode === 'cmd'\) \{[^\n]*refreshChatGPTStatus\(\);/, 'opening Cmd+K reads the ChatGPT sign-in status');

const visibleTags = vm.runInNewContext(`
  const isTask = (node) => node.kind === 'document' && node.icon === 'task';
  ${functionSource('visibleTags')}
  visibleTags;
`);
assert.deepEqual(JSON.parse(JSON.stringify(visibleTags({ kind: 'document', icon: 'task', tags: [{ label: 'task', color: 'grey' }, { label: 'Project', hue: 268 }] }))), [{ label: 'Project', hue: 268 }], 'a typed task keeps its custom tag and hides #task');
assert.deepEqual(JSON.parse(JSON.stringify(visibleTags({ kind: 'document', icon: 'task', tags: [{ label: 'task', color: 'grey' }] }))), [{ label: 'task', color: 'grey' }], 'an untyped task retains #task');

const audienceInfo = vm.runInNewContext(`
  const demoText = (value) => value; // demo mode off
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
    let authed = false, authChecking = true, signedOut = false, connected = false, placed = false, calls = 0, renders = 0, outcome = 'fail';
    const taskMetaById = new Map(), taskMetaLoading = new Set(), taskMetaFailed = new Map();
    ${source.match(/const META_RETRY_MS = \d+, META_RETRY_MAX = \d+;/)[0]}
    const tana = { taskMeta: () => {
      calls++;
      return outcome === 'fail' ? Promise.reject(new Error('not connected')) : Promise.resolve({ assignees: [] });
    } };
    const palette = { hidden: true }, palDoc = null, outline = {};
    const $ = () => ({}), showError = () => {}, loadView = () => {}, renderSoon = () => {}, loadSearches = () => {}, loadWorkspaceTypes = () => {}, loadPinned = () => {}, restorePlace = async () => {};
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
    const $ = () => ({}), showError = () => {}, loadView = () => {}, render = () => {}, renderSoon = () => {}, loadWorkspaceTypes = () => {}, loadPinned = () => {}, restorePlace = async () => {};
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
assert.match(source, /const MARK_TAGS = \{ code: 'code', strike: 's', underline: 'u', italic: 'em', bold: 'strong' \}/);
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
assert.match(source, /if \(!zoom \|\| onSearchPage\(\) \|\| onTypePage\(\)\) rows\.push\(\{ id: 'filter'/, 'a saved search page and a type page offer the filter row, so ⌘F reaches them');
// A key recorded for a row that is listed but off (Clean up with nothing held, Go back with no history) is answered
// by doing nothing, rather than falling through to whatever else the combo might mean: one command, one meaning.
assert.match(source, /if \(row\) \{ if \(!row\.disabled\) row\.run\(\); return true; \}/, 'a hotkey for a disabled row is a no-op the app still owns');
// and the palette's own arrows land on such a row, which is the only way Cmd+Shift+K can record a shortcut for it
assert.match(source, /if \(!rows\[next\]\.disabled \|\| rows\[next\]\.id\) return next;/, 'Up/Down reach a disabled row that has a stable id, so it can be given a key before it goes live');
// (shown and hidden through showHide, which opens and closes it in place: renderer/motion.js)
assert.match(source, /(filterRow\.hidden = |showHide\(filterRow, !\()\(!!parent && !isSearchDoc\(parent\.node\) && !isTypeDoc\(parent\.node\)\)/, 'the filter row stays on screen on a saved search page and a type page');
assert.match(source, /if \(isSearchDoc\(parent\.node\) \|\| isTypeDoc\(parent\.node\)\) \{/, 'the zoomed branch narrows a saved search and a type page the way a view narrows its rows');
// the Library keeps the query it is showing as a saved search; main owns the filter→query translation
assert.match(source, /if \(defs\.length && tana\.createSearch && !onSearchPage\(\) && !onTypePage\(\)\) box\.append\(saveSearchPill\(\)\)/, 'a view with pills offers to save its query as a search, and a saved search does not: it already is one');
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
// a closed palette must hide even while it still carries the @ dropdown class (#240): same weight, later rule wins. The
// dropdown's missing scrim may hold while it fades out (#185), but a display of its own would outweigh .palette[hidden].
assert.doesNotMatch(styleSheet, /\.palette\.anchored \{[^}]*display/, 'the @ dropdown layout must not outweigh .palette[hidden]');
// A type's colour is an OKLCH hue in Tana (Organization's 232 is #58aad2 = oklch(0.7 0.1 232)); as an HSL angle the
// same number is 42° away and half as light. And it must be written into the rule: a custom property substitutes
// its own var() where it is declared, so `--hue-color: oklch(… var(--hue))` on <html> — which has no --hue —
// computes invalid and leaves every hued thing on the page with no colour at all.
assert.doesNotMatch(styleSheet, /hsl\(var\(--hue\)/, 'hued rules draw in OKLCH, not HSL: the same number is a different colour');
assert.doesNotMatch(styleSheet, /--[\w-]+\s*:[^;}]*var\(--hue\)/, 'a custom property must not hold the hue colour: it resolves where it is declared, not where it is used');
assert.match(styleSheet, /\.bullet\.icon\.hue svg[^{]*\{ color: oklch\(0\.7 0\.1 var\(--hue\)\); \}/, 'a hued glyph is Tana\u2019s own colour for that hue');
assert.match(styleSheet, /\.palette\.anchored:not\(\[hidden\]\) \{/, 'the @ dropdown layout applies only while the palette is shown');
// The agent prompt page is an editor, not a list to search: it never says "No results" under its one row, and the
// query that found "Assign to Agent" is cleared on the way in, or its letters would show as bold in that row.
// "Discuss with …" is the same shape — what is typed *is* the row — so it is skipped too, or every name typed
// would be answered with "No results" under the row offering to write it. The field pages (renderer/fields.js) say
// what they found, or why they have nothing, in rows of their own.
assert.match(source, /palMode !== 'agentPrompt' && palMode !== 'discuss' && palMode !== 'field' && \(palMode === 'cmd'/, 'the no-results line skips the pages whose row is what was typed');
assert.match(source, /function openAgentPrompt\(doc\) \{[\s\S]{0,400}showPage\('agentPrompt', ''\);/, 'opening the prompt page clears the query behind it');
assert.match(source, /function showPage\(mode, placeholder, value = ''\) \{[^}]*palInput\.value = value;/, 'a page starts with the field holding only what it was opened with');
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
// and on working alone: every other state is still, whatever the colour says. A state that has just changed may mark
// the moment once (styles.css .cbadge.done.shine, renderer/motion.js badgeMoved) — what it may not do is keep moving.
for (const state of ['pending', 'waiting', 'done', 'broken']) {
  assert.doesNotMatch(styleSheet, new RegExp('\\.cbadge\\.' + state + '[^\\n]*animation:[^\\n]*infinite'), state + ' does not keep animating');
}
// the sweep is paced by the Ambient rhythm (styles.css --dur-loop), twice over
const loop = Number((styleSheet.match(/--dur-loop: (\d+)ms/) || [])[1]);
assert.match(sheen[0], /animation: cbadge-sweep calc\(var\(--dur-loop\) \* 2\)/, 'the sweep keeps the ambient rhythm');
assert.ok(loop * 2 >= 2500 && loop * 2 <= 3000, 'it crosses the badge every two and a half to three seconds');
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
// Clean up arrives with a pop and shrinks away again rather than appearing and disappearing between two frames: the
// shared Pop keyframes, whose durations reduced motion sets to nought (styles.css :root), while pills.js hides it on the spot.
const btnMotion = styleSheet.match(/\.navbtn\.in \{[^}]*\}\n\.navbtn\.out \{[^}]*\}/);
assert.ok(btnMotion, 'a header button that comes and goes pops in and shrinks away');
assert.match(btnMotion[0], /animation: pop-in var\(--dur-[a-z]+\)[^;]*backwards/, 'the arrival is one shot');
assert.match(btnMotion[0], /animation: pop-out var\(--dur-[a-z]+\)[^;]*forwards/, 'and the departure holds where it ends, so nothing flashes back before it is hidden');
assert.match(styleSheet, /@media \(prefers-reduced-motion: reduce\) \{ :root \{ --dur-quick: 0ms; --dur-base: 0ms;/, 'and where motion is not welcome every duration is nought');
// Every render builds the pills again, so the arrival is marked on each pill rather than on the row: with it on the
// row, a redraw landing while they were still coming in handed the mark to the new pills and played it all again.
assert.match(source, /el\.style\.setProperty\('--i', i\); if \(arriving\) el\.classList\.add\('in'\)/, 'a pill knows it is arriving; the row does not');
assert.match(styleSheet, /\.pills > \.pill\.in \{ animation: pop-in/, 'and that is what the entrance is drawn from');
// Only the press moves the row: a view's pills are the view, and a page just arrived at — a reload, a link, the
// Library — is drawn as it stands rather than assembling itself in front of you.
assert.match(source, /const arriving = pillsPressed && \(box\.hidden \|\| box\.classList\.contains\('out'\)\)/, 'only a pressed fold animates the pills in');
assert.match(source, /renderPillsToggle\(!!show\)/, 'every page with pills offers the button that folds them, not only a saved search');
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
  // ...and the Timeline's completed marker, whose white check is drawn at 12px inside a filled circle and asked to be heavier
  assert.match(rule, /\.pill\.refresh|\.node\.tl-done > \.line > \.bullet\.icon svg g/, 'only the Refresh pill and the Timeline\'s completed check change an icon\'s weight: ' + rule.trim());
}
const icons = {};
new Function('window', fs.readFileSync(require.resolve('../icons.js'), 'utf8'))(icons);
assert.match(icons.ICONS.reload, /stroke-width="1"/, 'the generated glyph is untouched, so it is the icon set\'s weight everywhere else');
assert.ok(icons.ICONS.openaiKey && icons.ICONS.openaiKey.includes('currentColor'), 'the OpenAI key row uses the supplied generated glyph');
assert.ok(icons.ICONS.chatgpt && icons.ICONS.chatgpt.includes('currentColor'), 'the ChatGPT sign-in row uses its generated vector mark');
// What a model suggested is drawn with its own glyph, so a row the app worked out is never mistaken for one you
// typed or one Tana knows, and the glyph breathes only where motion is welcome.
assert.ok(icons.ICONS.sparkle && icons.ICONS.sparkle.includes('currentColor'), 'the suggestion row uses the supplied sparkle glyph');
assert.match(styleSheet, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.palette \.ricon\.thinking svg \{ animation: sparkle-orbit/, 'the waiting glyph turns behind the reduced-motion gate');
assert.match(styleSheet, /\.palette \.ricon\.thinking svg path \{ transform-origin: 50% 50%; transform-box: fill-box;/, 'and each star twinkles around its own centre, not the icon\u2019s');
// The answer takes that glyph's place rather than replacing it between two frames: the row it arrives in settles
// out of the spin, and the row carries the class that says so.
assert.match(styleSheet, /\.palette \.row\.arrive \.ricon svg \{ animation: sparkle-settle/, 'the arriving row settles behind the reduced-motion gate');
assert.match(source, /\(r\.arrive \? ' arrive' : ''\)/, 'and only the row that marks itself as arriving gets it');
assert.match(source, /icon: 'sparkle', spin: true, label: 'Reading the title/, 'and the waiting row is the one that spins');
// A field value is an outline of its own and is drawn by the outline's own rows: the same items, the same keys,
// the same keyboard, so "- ", Tab, Enter, references and checkboxes are the page's behaviour rather than a second
// implementation of it. Its id is the document and the field together, which is the only thing that differs.
assert.match(source, /const hostId = parent\.docId \+ '\|' \+ field\.key;\s*const host = mkItem\(hostId, \{/, 'a field value is an outline addressed by document and field');
assert.match(source, /values\.replaceChildren\(\.\.\.withDraftTail\(rows, host\)\.map\(\(n\) => childEl\(n, host\)\)\)/,
  'and its rows are the page\u2019s rows, under the page\u2019s own rule for the empty row to type into');
assert.match(source, /ensureLoaded\(host\);/, 'read through the same children call every outline uses');
// A row in a field is not a page: its bullet opens nothing, and a reference in it is opened by the chip itself.
assert.match(source, /const opens = reference \|\| fullref \|\| \(zoomable\(node\) && !field\);/,
  'a field row does not zoom; only a reference in it opens anything');
assert.match(styleSheet, /\.fields \.fvalues \.node\.block:not\(\.t-bullet\):not\(\.t-numbered\) > \.line > \.bullet::before \{ visibility: hidden; \}/,
  'and a plain row in a field shows no marker in any state, hover and collapsed included');
assert.doesNotMatch(source, /function fieldLine\(/, 'and there is no second line editor left beside it');
// "- " is one rule for rows and, now, for the field rows that are the same code (renderer/segments.js).
assert.match(source, /const startsList = \(before\) => before === '- ';/, 'the list shortcut is the dash *and* the space, in one place');
assert.match(source, /const listRest = \(segs, offset\) => splitSegs\(segs, offset \|\| 0\)\[1\];/, 'and so does what the line keeps when the marker goes');
// Tab at the start of a plain line is the same gesture as "- ", and ⇧Tab there is the same as Backspace: the
// marker comes off when there is nothing left to outdent into. Anywhere else Tab is the indent it always was.
assert.match(source, /e\.key === 'Tab' && off === 0 && collapsed && !isDoc && \(e\.shiftKey \? unbullet\(item\) : bulletOrIndent\(item, el\)\)/,
  'Tab at the start of a line starts a list there, and ⇧Tab takes the marker off');
assert.match(source, /const under = !!above && \['bullet', 'numbered'\]\.includes\(blockTypeOf\(above\)\);/,
  'and the new bullet joins the row above only when that row is a list row, so a paragraph is never made a parent');
// And every row listener is bound to both places rows live, so a field row has the same keyboard as a page row
// rather than a second one written for it.
assert.match(source, /const onRows = \(type, handler\) => \{ for \(const root of \[outline, \$\('fields'\)\]\) root\.addEventListener\(type, handler\); \};/,
  'row listeners are bound to the outline and to the fields');
assert.doesNotMatch(source, /outline\.addEventListener\('keydown'/, 'and not to the outline alone');
// A row in a field that is one reference stays a line with a link in it: turning into the node it points at gives
// that line a glyph, a status and a grey subline, and a list of names where every second line is twice the height.
assert.match(source, /const field = inField\(docId\);[\s\S]{0,1200}?const target = gone \|\| field \? null : liveTarget\(node, pending\.get\(item\.key\)\)/,
  'references in a field are drawn inline, not as the node they point at');
assert.match(source, /const inField = \(docId\) => typeof docId === 'string' && docId\.includes\('\|tana:type:'\);/, 'and a field row is known by the id it is addressed with');
// Two lists, deliberately: the caret walks the whole page, while anything that changes what a row belongs to stays
// in the list that row lives in. Merging them made Backspace at the top of the page reach into the field above it.
assert.match(source, /const texts = \(\) => rowsIn\(outline\)\.filter\(\(el\) => !el\.closest\('\.fvalues'\)\);/, 'the outline\u2019s rows are their own list');
assert.match(source, /const caretRows = \(\) => \[\.\.\.\(titleEl\.isContentEditable \? \[titleEl\] : \[\]\), \.\.\.fieldValues\(\), \.\.\.rowsIn\(outline\)\];/,
  'and the caret walks title, fields, outline in reading order');
assert.match(source, /const all = caretRows\(\), target = all\[all\.indexOf\(el\) \+ dir\];/, 'Up and Down move through every stop on the page');
// ⌘A escalates: the row's words, then the rows of the editor the caret is in — the page's, or the field's.
assert.match(source, /if \(range && range\[0\] === 0 && range\[1\] === len\) selectAllRows\(el\); else selectRange\(item\.key, 0, len\);/,
  'a second ⌘A selects the rows themselves');
assert.match(source, /const keys = rowsBeside\(el\)\.map\(keyOfEl\)\.filter\(Boolean\);/, 'and it takes the rows of that editor alone');
// Finding a row is one thing, wherever it is drawn: the page's outline and the fields under the title. These three
// are the family every "it works on the page but not in a field" bug came through.
assert.match(source, /const rowRoots = \(\) => \[outline, \$\('fields'\)\];/, 'rows live in two places, named once');
assert.match(source, /const nodeElOf = \(key\) => queryRow\(/, 'a row is found in either of them');
assert.match(source, /for \(const n of eachRow\('\.node\.selected'\)\) n\.classList\.remove\('selected'\);/, 'a selection is painted and cleared in both');
assert.match(source, /return el && el\.classList\.contains\('text'\) && inRows\(el\) \? \{ key: keyOfEl\(el\), offset: caretOffset\(el\) \} : null;/,
  'and the focused row is the focused row in either of them');
assert.match(source, /const all = rowsBeside\(el\), prev = all\[all\.indexOf\(el\) - 1\], above = prev && items\.get\(keyOfEl\(prev\)\);/,
  'while merging into the row above stays inside the list the row lives in');
// Clicking the empty space under a list carries on where its words end, each zone answering for its own rows.
assert.match(source, /for \(const \[zone, rows\] of \[\[\$\('fields'\), \(\) => fieldValues\(\)\], \[outline\.parentElement, \(\) => texts\(\)\]\]\)/,
  'the fields and the page each answer for the space under their own rows');
assert.match(source, /const target = all\.filter\(\(row\) => row\.getBoundingClientRect\(\)\.top <= e\.clientY\)\.at\(-1\) \|\| all\[0\];/,
  'a click in a gap belongs to the row above it, and one below everything to the last row');
assert.match(source, /setCaret\(target, e\.clientY <= box\.bottom \? caretAt\(target, e\.clientX, e\.clientY\) : target\.textContent\.length\);/,
  'beside the words the caret lands where it was clicked, below them at the end of the line');
// The glyph, the label and the value all begin at the top of the field's first line: a baseline cannot align them
// now that the value is rows rather than one line box, which left the label sitting below the name beside it.
assert.match(styleSheet, /\.fields \{[^}]*align-items: start; \}/, 'the three columns of a field start together');
assert.match(styleSheet, /\.fields \.flabel \{ color: #888; line-height: 20px; \}/, 'and the label carries a row\u2019s line height, so its first line is a row\u2019s first line');
assert.match(styleSheet, /\.fields \.fvalues \.chev, \.fields \.fvalues \.bullet \{ height: 22px; \}/, 'a field row is as tall as its words, bullet included');
// The space above a row is padding, not margin: a margin on the first row inside a children container collapses
// through it, which left exactly one row — the first child — sitting flush under its parent.
assert.match(styleSheet, /\.fields \.fvalues \.node > \.line \{ padding: 8px 0 0; line-height: 22px; \}/,
  'every row of a field carries the same space above it, as padding, so no row can collapse it away');
assert.match(styleSheet, /\.fields \.fvalues > \.node:first-child > \.line \{ padding-top: 0; \}/, 'except the first, which the block already spaces');
assert.match(styleSheet, /\.fields \.fvalues \.node \{ margin-top: 0; margin-bottom: 0; \}/, 'and no margin decides the rhythm here');
// a list marker and a full-reference icon share the left edge of a plain row's words
assert.match(styleSheet, /\.node\.block\.t-bullet > \.line, \.node\.block\.t-numbered > \.line, \.node\.block\.fullref > \.line \{ margin-left: -10px; \}/,
  'list rows and full references use the marker column');
assert.match(styleSheet, /\.node\.block:not\(\.t-bullet\):not\(\.t-numbered\):not\(\.fullref\):not\(\.has\) > \.line > \.bullet \{ width: 11px; \}/,
  'a full reference keeps the list gutter whatever block holds it');
assert.match(styleSheet, /\.node\.block\.t-bullet > \.children, \.node\.block\.t-numbered > \.children, \.node\.block\.fullref > \.children \{ margin-left: 23px; \}/,
  'and its guide line comes with it, 33px less the 10px the row moved, so it still runs under the bullet');
assert.match(styleSheet, /\.fields \.fvalues \{ display: flex; flex-direction: column; row-gap: 0; min-width: 0; padding-left: 2px; \}/, 'the rows keep their gutter, so the expand caret is not drawn over the label');
assert.match(styleSheet, /\.fields \.ricon \{ width: 14px; height: 14px; color: #8a8a8a; align-self: start;/, 'the field glyph stays on the first line rather than drifting to the middle of a long value');
assert.match(styleSheet, /\.fields \.fvalue:only-child:empty::before \{ content: '…'/, 'the empty-field placeholder is for a field with nothing in it, not for every line added to one');
assert.match(styleSheet, /\.fields \.fvalues \{ display: flex; flex-direction: column;/, 'the lines stack in the value column');
// A render while the caret is in a field would rebuild the block and drop the caret mid-word, which every live
// update, the refresh loop and the field's own save coming back all cause. The redraw waits for the blur instead.
assert.match(source, /function renderFields\(parent, force = false, el = \$\('fields'\)\) \{[\s\S]{0,900}?if \(!force && el\.contains\(document\.activeElement\)\) \{ fieldsDeferred = true; return; \}/,
  'the fields block is not rebuilt while the caret is in it');
assert.match(source, /if \(\(renderDeferred \|\| fieldsDeferred\) && !editingRow\(\) && !selectionFrozen\) render\(\);/, 'and the render it held back runs when the caret leaves');
assert.match(source, /if \(!force && el\.contains\(document\.activeElement\)\) \{ fieldsDeferred = true; return; \}/,
  'while a forced render — the answer to what the user just did in the field — draws it straight away');
assert.match(source, /return !!\(el && el\.isContentEditable && \(el === titleEl \|\| inRows\(el\)\)\);/,
  'a caret in a field row defers a render the way a caret in an outline row does');
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
// A document's fields are outlines of that document: re-reading its rows has to re-read theirs, or an undo and a
// live update land on the page and not in the field beside it.
assert.match(source, /const outlinesOf = \(docId\) => \[\.\.\.kids\.keys\(\)\]\.filter\(\(id\) => id === docId \|\| id\.startsWith\(docId \+ '\|'\)\);/,
  'a document\u2019s outlines are its page and its fields');
assert.match(source, /for \(const id of docId \? outlinesOf\(docId\) : \[\]\) await reload\(id\);/, 'undo re-reads all of them');
assert.match(source, /for \(const id of outlinesOf\(docId\)\) work\.push\(reload\(id\)\);/, 'and so does a live update');

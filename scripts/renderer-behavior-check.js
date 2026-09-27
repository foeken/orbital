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
  + 'globalThis.addIcon ??= ' + source.match(/^function addIcon\(.*$/m)[0] + ';\n' // the real one, over whichever iconNode the harness has
  + `globalThis.DEFAULT_HOTKEYS ??= ${DEFAULT_HOTKEYS_SRC}; globalThis.hk ??= () => (typeof hotkeys === 'object' ? hotkeys : {}); globalThis.hotkeyFor ??= (id) => (Object.hasOwn(hk(), id) ? hk()[id] : DEFAULT_HOTKEYS[id]); globalThis.hotkeyIds ??= () => [...new Set([...Object.keys(DEFAULT_HOTKEYS), ...Object.keys(hk())])]; globalThis.comboOf ??= () => '';\n`
  + 'globalThis.keyTitle ??= ' + source.match(/^function keyTitle\(.*?^\}/ms)[0] + ';\n'; // the real one: a header button's tooltip names its key
const withShims = (src) => {
  // Row listeners are bound to both roots the app has (the outline and the fields under the title, which are
  // outlines too). A harness exercises one root, so the binding becomes the plain listener it was.
  src = src.replace(/onRows\('([a-z]+)', /g, "outline.addEventListener('$1', ");
  // demo mode (renderer/segments.js) is off in every harness: the helpers hand text back as it is
  if (/\bdemo(Mode|Text|Segments|PersonName|WordCount|Meta)\b/.test(src) && !/let demoMode =/.test(src)) src = 'globalThis.demoMode ??= false; globalThis.demoText ??= (value) => value; globalThis.demoSegments ??= (segs) => segs; globalThis.demoPersonName ??= (id) => id; globalThis.demoWordCount ??= () => 2; globalThis.demoMeta ??= (node, meta) => meta;\n' + src;
  // a row knows whether it is drawn in a field from the id it is addressed with (renderer/nodes.js)
  if (/\binField\(/.test(src) && !/const inField =/.test(src)) src = sourceLine('const inField') + '\n' + src;
  // a date mention's day (renderer/segments.js): the real one, since chips and clicks both ask it
  if (/\bdayOfUri\(/.test(src) && !/const dayOfUri =/.test(src)) src = sourceLine('const dayOfUri').replace('const dayOfUri =', 'globalThis.dayOfUri ??=') + '\n' + src;
  // how many rows changing at once is a new list rather than an edit (renderer/motion.js): the real number
  if (/\bBULK\b/.test(src) && !/const BULK =/.test(src)) src = sourceLine('const BULK').replace('const BULK =', 'globalThis.BULK ??=') + '\n' + src;
  if (/\brenderFields\(/.test(src) && !/function renderFields\(|const renderFields =/.test(src)) src = 'globalThis.renderFields ??= () => {};\n' + src;
  if (/\bloadRelated\(/.test(src) && !/function loadRelated\(|const loadRelated =/.test(src)) src = 'globalThis.loadRelated ??= () => {};\n' + src;
  // Cmd+K's meeting rows and pages (renderer/meeting.js): a palette harness without that file offers none
  if (/\bmeetingRows\(/.test(src) && !/function meetingRows\(/.test(src)) src = 'globalThis.meetingRows ??= () => [];\n' + src;
  // the shell's word on this page's window (renderer/state.js): one page, unless the harness says otherwise
  if (/\bwindowPanes\b/.test(src) && !/let windowPanes =/.test(src)) src = 'globalThis.windowPanes ??= { pages: 1 };\n' + src;
  if (/\bMEETING_PAGES\b/.test(src) && !/const MEETING_PAGES =/.test(src)) src = 'globalThis.MEETING_PAGES ??= {};\n' + src;
  // Every palette page opens through showPage (renderer/palette.js, #275): the real one, over whatever of the palette's
  // state the harness declares (its own lets win; the rest start empty here).
  // A page that lists one read from main (renderer/palette.js, #362): the real reader and the real rows around it
  if (/\b(listRows|loadList)\(/.test(src) && !/function listRows\(/.test(src)) src = 'globalThis.palette ??= { hidden: false }; globalThis.renderPalette ??= () => {};\n' + 'globalThis.listReads ??= new Map(); globalThis.queue ??= Promise.resolve();\n' + source.match(/^function loadList\(.*?^\}/ms)[0].replace('function loadList', 'globalThis.loadList ??= function loadList') + ';\n' + source.match(/^function listRows\(.*?^\}/ms)[0].replace('function listRows', 'globalThis.listRows ??= function listRows') + ';\n' + src;
  // A page carries its rows and back step (palPage), and openPage is showPage drawn and focused.
  if (/\b(showPage|openPage|backPalette)\(/.test(src) && !/function showPage\(/.test(src)) {
    src = 'globalThis.clearTimeout ??= () => {}; globalThis.palTimer ??= null; globalThis.palSeq ??= 0; globalThis.palEnter ??= null; globalThis.palBusy ??= false; globalThis.palRows ??= []; globalThis.palIndex ??= 0; globalThis.palMode ??= "cmd"; globalThis.palPage ??= {}; globalThis.palReturn ??= null; globalThis.focused ??= () => null; globalThis.returnTarget ??= () => focused();'
      + ' globalThis.promptEditor ??= () => {}; globalThis.palette ??= { hidden: true }; globalThis.palInput ??= { value: "", placeholder: "", focus() {} }; globalThis.renderPalette ??= () => {};\n'
      + 'globalThis.showPage ??= ' + source.match(/^function showPage\(.*?^\}/ms)[0] + ';\n'
      + 'globalThis.openPage ??= ' + source.match(/^function openPage\(.*$/m)[0] + ';\n'
      + 'globalThis.BACK_TO_COMMANDS ??= () => openCommandPalette();\n' + src;
  }
  // the palette's own lookups run only while it is shown (#274): a harness that never declares it has it open
  if (/\bpalette\.hidden\b/.test(src)) src = 'globalThis.palette ??= { hidden: false };\n' + src;
  // a key waiting on main notes the palette generation it was pressed in (runAction, #274)
  if (/\bpalSeq\b/.test(src)) src = 'globalThis.palSeq ??= 0;\n' + src;
  // fields that hold choices or links (renderer/fields.js): a palette harness without that file has no field focused
  if (/\bfieldRows\(/.test(src) && !/function fieldRows\(/.test(src)) src = 'globalThis.fieldRows ??= () => [];\n' + src;
  if (/\b(fieldReturn|fieldLinkCtx|palField|fieldAt|focusField)\b/.test(src) && !/let fieldReturn\b/.test(src)) src = 'globalThis.fieldReturn ??= null; globalThis.fieldLinkCtx ??= null; globalThis.palField ??= null; globalThis.fieldAt ??= () => null; globalThis.focusField ??= () => {};\n' + src;
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
  // how a type is drawn in a list (renderer/nodes.js): the glyph it was given, else the generic one. Added before the
  // typeGlyphs line below, which then supplies the map to a harness that does not declare its own.
  if (/\btypeGlyph\(/.test(src) && !/const typeGlyph =/.test(src)) src = "globalThis.typeGlyph ??= (uri) => typeGlyphs.get(uri) || 'type';\n" + src;
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
  // subtextEl (renderer/views.js) builds that line with the row's field values ahead of it; sliced in before the
  // subtextOf guard below, which then supplies what it calls.
  if (/\bsubtextEl\(/.test(src) && !/function subtextEl\(/.test(src)) src = functionSource('subtextEl') + '\nglobalThis.shownFieldValues ??= (node) => (node.fields ? displayKeys().flatMap((k) => node.fields[k] || []) : []);\n' + src;
  // a type's page (renderer/nodes.js): a harness that is not about one is never on one
  if (/\bfieldType\(/.test(src) && !/const fieldType =/.test(src)) src = 'globalThis.fieldType ??= () => (onTypePage() ? zoom.docId : null);\n' + src; // nor on a page narrowed to one type
  if (/\b(isTypeDoc|onTypePage|isTypeId|opensOnClick)\b/.test(src) && !/const isTypeId =/.test(src)) src = "globalThis.isTypeId ??= (id) => /^tana:type:[^|?]+$/.test(String(id || '')); globalThis.isTypeDoc ??= (node) => !!node && isTypeId(node.id); globalThis.onTypePage ??= () => false; globalThis.opensOnClick ??= (item) => isTypeDoc(item.node) && !String(item.docId || '').includes('|tana:type:');\n" + src;
  if (/\bSEARCH_ID\b/.test(src) && !/const SEARCH_ID =/.test(src)) src = "globalThis.SEARCH_ID ??= 'tana:search:';\n" + src;
  if (/\beditingType\b/.test(src) && !/let editingType\b/.test(src)) src = 'globalThis.editingType ??= null;\n' + src; // no type's fields being edited
  if (/\btableView\(/.test(src) && !/const tableView =/.test(src)) src = 'globalThis.tableView ??= () => false;\n' + src; // no page shown as a table
  if (/\btableRow\(/.test(src) && !/const tableRow =/.test(src)) src = 'globalThis.tableRow ??= () => false;\n' + src; // and so no row drawn as one
  if (/\b(displayOn|displayKeys|subtextOf)\b/.test(src) && !/const displayKeys =/.test(src) && !/function subtextOf\(/.test(src)) {
    src = functionSource('agoText') + '\n' + functionSource('subtextOf') + '\n' + src;
    // pinnedOn needs the grouping (views.js) and the date pins (state.js); no row here is in a Pinned section
    src = "globalThis.displayKeys ??= () => ['status', 'assigned', 'updated']; globalThis.displayOn ??= (id) => globalThis.displayKeys().includes(id); globalThis.pinnedOn ??= () => ''; globalThis.me ??= () => (globalThis.members || []).find((m) => m.me);\n" + src;
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
  // Opening or closing a page lays the page over both halves of a split (issue #409); runCoverCheck slices the real one.
  if (/\bcoverWindow\(/.test(src) && !/function coverWindow\(/.test(src)) src = 'globalThis.coverWindow ??= () => {};\n' + src;
  if (/\brefreshChatGPTStatus\(/.test(src) && !/function refreshChatGPTStatus\(/.test(src)) src = 'globalThis.refreshChatGPTStatus ??= () => {};\n' + src;
  // Anything that asks the backend checks the connection first: a launch draws the page it is reopening before the
  // sync client exists (renderer/edit.js). A slice that is not about that gets a connected app.
  if (/\bconnected\b/.test(src) && !/\bconnected =/.test(src)) src = 'globalThis.connected ??= true;\n' + src;
  // The row behind a document id, which rememberPlace reads for the title and glyph it stores. A slice that cares
  // about either declares its own; the rest are only storing a place.
  if (/\bdocOf\(/.test(src) && !/const docOf =/.test(src)) src = 'globalThis.docOf ??= () => null;\n' + src;
  // Whether a row can be picked up (renderer/drag.js). A harness that draws rows is not about dragging, so its
  // rows are simply not draggable; the drop harness slices the real rules in instead.
  if (/\bcanDragItem\(/.test(src) && !/const canDragItem =/.test(src)) src = 'globalThis.canDragItem ??= () => false;\n' + src;
  // The Home anchor (renderer/nodes.js): the palette's Go back row reads it, Set as Home offers itself from it, and
  // navigate lands on it. A slice that is not about Home gets the shipped default — the Library, and you are on it —
  // so nothing it asserts depends on a choice it never made; the Home harness slices the real ones instead.
  if (/\b(atHome|homeId|homeName|repairHome|setHome|goHome)\b/.test(src) && !/const homeId =/.test(src)) src = "globalThis.atHome ??= () => true; globalThis.homeId ??= () => 'library'; globalThis.homeName ??= () => 'Library'; globalThis.repairHome ??= () => {}; globalThis.setHome ??= () => {}; globalThis.goHome ??= () => {};\n" + src;
  // Motion (renderer/motion.js) is what no harness looks at: a slice that calls it gets moves that change nothing, and
  // the state change a move wraps runs at once, exactly as it does under reduced motion.
  if (/\b(turnPage|foldRow|foldSection|showHide|rowsQuiet|dismissRow|settleEmpty|settling|slideRail|motionBefore|motionAfter|armGlide|flash|flashAt|playOnce|rowFor|badgeMoved|popRead|popMention|swapPanel|menuMotion|crossfade|growFrom|play|MOTION|motionOK|stillPreferred)\b/.test(src) && !/function motionAfter\(/.test(src)) src = MOTION_SHIM + src;
  return /\b(renderSoon|patchMeta|iconNode|addIcon|hotkeyFor|hotkeyIds|comboOf|keyTitle|settleEnter)\b/.test(src) ? RENDER_SHIM + 'globalThis.settleEnter ??= () => {};\n' + src : src;
};
const MOTION_SHIM = 'globalThis.turnPage ??= (dir, update) => update(); globalThis.foldRow ??= (key, opening, done) => done(); globalThis.foldSection ??= (head, toggle) => toggle(); '
  + "globalThis.showHide ??= (el, show) => { el.hidden = !show; }; globalThis.rowsQuiet ??= false; "
  + 'globalThis.dismissRow ??= (el, kind, done) => done(); globalThis.settleEmpty ??= () => {}; globalThis.slideRail ??= (opening, update) => update(); globalThis.crossfade ??= (update) => update(); globalThis.motionBefore ??= () => null; globalThis.motionAfter ??= () => {}; '
  + 'globalThis.armGlide ??= () => {}; globalThis.flash ??= () => {}; globalThis.flashAt ??= () => {}; globalThis.playOnce ??= () => {}; globalThis.rowFor ??= () => null; globalThis.badgeMoved ??= () => {}; '
  + 'globalThis.popRead ??= () => {}; globalThis.popMention ??= () => {}; globalThis.swapPanel ??= () => {}; globalThis.menuMotion ??= () => {}; globalThis.growFrom ??= async () => {}; globalThis.play ??= async () => {}; '
  + 'globalThis.settling ??= () => 0; globalThis.MOTION ??= {}; globalThis.motionOK ??= () => false; globalThis.stillPreferred ??= () => true;\n';
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
    const addSearch = () => {}; // searches made here (#141) have their own check
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
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
    ${functionSource('sensitiveHidden')}
    ${functionSource('blurSensitive')}
    ${functionSource('refreshSensitive')}
    // the page: what refreshSensitive can reach is what is on it, found by the ids blurSensitive left on each element
    const page = new Set();
    const document = { querySelectorAll: (selector) => (selector === '[data-sensitive]' ? [...page].filter((el) => 'sensitive' in el.dataset) : []) };
    const makeEl = () => { const classes = new Set(); const el = { dataset: {}, classes, classList: {
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    } }; page.add(el); return el; };
    const secret = makeEl(), ordinary = makeEl(), reused = makeEl();
    ({
      mount: () => { blurSensitive(secret, 'tana:text:secret'); blurSensitive(ordinary, 'library', 'tana:text:public'); },
      blurred: () => ({ secret: secret.classes.has('sensitive'), ordinary: ordinary.classes.has('sensitive') }),
      load: (ids) => { sensitiveIds = new Set(ids); },
      show: (on) => { sensitiveVisible = on; refreshSensitive(); },
      refresh: refreshSensitive,
      detach: () => page.delete(secret),
      reuse: () => { blurSensitive(reused, 'tana:text:secret'); blurSensitive(reused, 'library'); },
      reusedBlurred: () => reused.classes.has('sensitive'),
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
  // Nothing is kept beside the page (#262): a row a render threw away is not reached by the next toggle, and an
  // element drawn again for something else (the page title) drops the ids it carried.
  api.detach();
  api.show(true);
  assert.deepEqual(plain(api.blurred()), { secret: true, ordinary: false }, 'a detached row is not held or touched by a toggle');
  api.show(false);
  api.reuse();
  assert.equal(api.reusedBlurred(), false, 'an element redrawn with no document ids is not blurred');
  api.refresh();
  assert.equal(api.reusedBlurred(), false, 'and a refresh does not blur it by the ids it carried before');

  // And the choice outlives the session: state.js reads it at load and the toggle writes it back, in localStorage
  // rather than in the preferences that follow you between machines.
  const restart = (stored) => vm.runInNewContext(`
    const store = ${JSON.stringify(stored)};
    const localStorage = { getItem: (key) => (key in store ? store[key] : null), setItem: (key, value) => { store[key] = String(value); } };
    ${sourceBetween('let sensitiveIds = null', '\n')}
    const refreshSensitive = () => {};
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
  const contextFns = [functionSource('taskActionContext'), functionSource('taskActionRows'), functionSource('selectionRows'), functionSource('removeSelection'), functionSource('archiveType'), functionSource('addToDateNode')].join('\n');
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
    // a type page (#36): archived, never deleted; kept out of rows so the selections above do not change
    items.set('tana:type:01j0type000000000000000000', { key: 'tana:type:01j0type000000000000000000', docId: 'tana:type:01j0type000000000000000000', node: { id: 'tana:type:01j0type000000000000000000', kind: 'document', icon: 'type', editable: false } });
    const TYPE_NODE = /^tana:type:[0-9a-z]{26}$/;
    let selected = rows.map((item) => item.key), palDoc = task('palette-task');
    const selKeys = () => selected;
    const isTask = (node) => node.kind === 'document' && node.icon === 'task';
    const canEditNode = (node) => node.editable !== false;
    const stateOf = (node) => node.stateType;
    const STATES = [['proposed', 'Inbox'], ['open', 'In Progress'], ['closed', 'Completed'], ['not_now', 'Later']];
    const taskMetaById = new Map(), loadTaskMeta = () => {}, memberName = (id) => id;
    const calls = [];
    const tana = { setState() {}, setStateMany() {}, taskMeta() {}, setAssignees() {}, setAssigneesMany() {}, setSensitive() {},
      deleteDocument: async (id) => { calls.push(['delete', id]); }, accessOptions: async (id) => ({ deletable: !TYPE_NODE.test(id), archivable: TYPE_NODE.test(id) }),
      archiveDocument: async (id) => { calls.push(['archive', id]); },
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
      archive: async (id) => { calls.length = 0; selected = []; palDoc = items.get(id).node; await selectionRows().find((row) => row.id === 'archive').run(); return calls; },
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
  // #36: a type offers Archive (Tana's own type page offers nothing else); it asks main whether it may, then archives
  assert.deepEqual(plain(context.current('tana:type:01j0type000000000000000000')).filter((row) => ['Archive type', 'Delete'].includes(row[1])),
    [['Current node', 'Delete', 'Read-only', true], ['Current node', 'Archive type', '', false]], 'a type is archived, not deleted');
  assert.deepEqual(plain(await context.archive('tana:type:01j0type000000000000000000')), [['archive', 'tana:type:01j0type000000000000000000']], 'Archive type archives that type');

  const applyFns = [functionSource('taskResult'), functionSource('applyTaskChange'), functionSource('statusRows'), functionSource('memberRows'), functionSource('manyAssigneeRows')].join('\n');
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
  const runKey = (editable, key = 'Enter', reference = false, meta = false, id = 'tana:text:row') => {
    const context = { listener: undefined };
    vm.runInNewContext(`
      let mutation = 0, zoomed = 0, opened = 0, prevented = 0;
      const editable = ${JSON.stringify(editable)};
      const outline = { addEventListener: (_name, fn) => { listener = fn; } };
      const item = { key: 'row', docId: 'row', node: { id: ${JSON.stringify(id)}, kind: 'document', editable, text: 'Row' } };
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
  // A type row opens on a click, so the keys do the same, even though the type itself can be edited (on its page)
  for (const key of ['Enter', ' ']) assert.deepEqual(plain(runKey(true, key, false, false, 'tana:type:01j0goal000000000000000000')), { mutation: 0, zoomed: 1, opened: 0, prevented: true }, JSON.stringify(key) + ' on a type row opens it and creates nothing');
  assert.deepEqual(plain(runKey(true, 'Enter', false, true, 'tana:type:01j0goal000000000000000000')), { mutation: 0, zoomed: 0, opened: 0, prevented: false }, 'while ⌘Enter on it is left to a recorded shortcut');
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
    let listener, removeListener;
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
    const TIMELINE_PAGE = 'orbital:timeline';
    let zoom = { docId: keptId };
    const agentStates = new Map(), agentTaskHosts = new Map(), loadAgentStates = () => {};
    const listPage = () => false; // a document is zoomed here, never a list page
    const taskMetaById = new Map(), kids = new Map(), extra = new Map(), fresh = new Map();
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
      node: async () => tanaNode,
    };
    ${helpers}
    ${liveUpdates}
    Object.assign(globalThis, {
      update: (id) => listener(id),
      edit: (id) => listener(id, { meta: false }),
      refreshed: () => refreshed,
      removed: (id) => removeListener(id),
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
        lineClick: (opened = null, line.onclick({ target: { closest: () => null } }), opened),
        opensClass: el.classes.has('opens'),
        bulletIcon: [...line.children[1].classes].find((name) => name !== 'icon' && name !== 'hue') || null,
        kidKeys: wrap ? wrap.children.filter((kid) => kid.dataset?.key).map((kid) => kid.dataset.key) : null };
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
  assert.equal(beside.lineClick, null, 'a click on its line places a caret and opens nothing');

  // A type row (the Types view) opens on a click on its title: its name is renamed on its own page.
  const typeRow = plain(api.built({ id: 'tana:type:01j0goal000000000000000000', kind: 'document', icon: 'type', text: 'Goal', editable: true }));
  assert.deepEqual([typeRow.editable, typeRow.lineClick, typeRow.opensClass], [false, 'zoomed the block', true],
    'a type row is not a caret: a click on its title zooms into the type');

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
    // the two pages as their openers define them (renderer/access.js): where Escape goes is theirs to say
    const PAGES = { visibilityPeople: ${source.match(/openPage\('visibilityPeople', 'Select people', (\{[^\n]*\})\);/)[1]}, visibility: ${source.match(/openPage\('visibility', 'Choose visibility', (\{[^\n]*\})\);/)[1]} };
    let palPage = PAGES.visibilityPeople;
    ${functionSource('backPalette')}
    ${applySharing}
    ${visibilityPeopleRows}
    ({
      rows: () => visibilityPeopleRows(''),
      back: () => backPalette(),
      mode: (next) => { palMode = next; palPage = PAGES[next]; closed = false; },
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
    const parseDay = () => null; // no typed day here: the date row has its own case below
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
  // "@" also offers a date when the words read as a day: the real day reader and the real date helpers
  const DAY_SRC = sourceBetween('const WEEKDAYS =', 'const PIN_DATE_GROUP') + source.match(/const localDate = [^\n]*/)[0] + '\n' + source.match(/const dayOfUri = [^\n]*\nconst dayUri = [^\n]*\nconst DAY_LABEL = [^\n]*\nconst dayLabel = [^\n]*/)[0];
  const caret = vm.runInNewContext(`
    ${DAY_SRC}
    let linkCtx = { text: '', item: {}, segs: [], start: 3, end: 3 }, pinCtx = null;
    let palRows = [], palIndex = 0, palBusy = false, palSeq = 0, palTimer = null, palMode = 'search';
    let searchResolve, created = null, linked = null;
    const palInput = { value: '' };
    const tana = { search: () => new Promise((resolve) => { searchResolve = resolve; }) };
    const asDoc = (node) => ({ ...node, text: node.text || node.title, kind: 'document' });
    const docRow = (node, hint, run) => ({ label: node.text, node, hint, run });
    const createAndLink = (ctx, title) => { created = title; }, linkTo = (ctx, mention) => { linked = mention; }, openResult = () => {};
    const renderPalette = () => {}, showError = (error) => { throw error; }, recentRows = () => [{ id: 'r', title: 'Recent' }];
    ${resultRows}
    ${functionSource('titleHits')}
    ${searchNow}
    ({ type: (q) => { palInput.value = q; searchNow(); }, resolve: (rows) => searchResolve(rows), state: () => ({ palIndex, rows: palRows.map((row) => row.label) }), groups: () => palRows.map((row) => row.group || null), bold: () => palRows.map((row) => (row.match ? row.match.map((i) => row.label[i]).join('') : null)), create: () => { palRows[0].run(); return created; },
      pick: () => { palRows[palIndex].run(); return linked; }, tomorrow: () => ({ label: dayLabel(localDate(1)), uri: dayUri(localDate(1)) }) });
  `);
  // Search hits: the titles holding the most typed words lead, whatever order Tana answered in, and only those words are bold
  caret.type('try 1');
  caret.resolve([{ id: 'a', title: 'Finding the Balance' }, { id: 'b', title: 'Test OmniCharge and reply on Tue 1 Sep' }, { id: 'c', title: 'Try the 1-day framework' }, { id: 'd', title: 'Entry 12' }]);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(plain(caret.state().rows), ['Create “try 1”', 'Try the 1-day framework', 'Entry 12', 'Test OmniCharge and reply on Tue 1 Sep', 'Finding the Balance'],
    'both words, both starting a word, first; both words inside words next; one word after; the body-only hit last');
  assert.deepEqual(plain(caret.bold()).slice(1), ['Try1', 'try1', '1', ''], 'the typed words are bold, nothing else');
  // Related results (#20) keep their place after the text hits, under their own heading, with no second Create row
  caret.type('try 1');
  caret.resolve([{ id: 'r', title: 'Try 1 thing', related: true }, { id: 'e', title: 'Entry 12' }]);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(plain(caret.state().rows), ['Create “try 1”', 'Entry 12', 'Try 1 thing'], 'a related hit stays last however well its title matches');
  assert.deepEqual(plain(caret.groups()), [null, null, 'RELATED'], 'and sits under its own heading');
  caret.type('');
  assert.deepEqual(plain(caret.state()), { palIndex: 0, rows: ['Recent'] }, 'an empty caret palette lists recent nodes with no Create row');
  caret.type('Dan'); caret.resolve([{ id: 'x', title: 'Dana Brooks' }]); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(plain(caret.state()), { palIndex: 1, rows: ['Create “Dan”', 'Dana Brooks'] }, 'typing offers to create what was typed and still selects the matching result');
  assert.equal(caret.create(), 'Dan', 'and Create uses the typed title');
  caret.type('tomorrow'); caret.resolve([{ id: 'p', title: 'Tomorrow plan' }]); await Promise.resolve(); await Promise.resolve();
  const tomorrow = plain(caret.tomorrow());
  assert.deepEqual(plain(caret.state()), { palIndex: 0, rows: [tomorrow.label, 'Create “tomorrow”', 'Tomorrow plan'] }, 'a typed day is offered first, and selected over a title that starts with the word');
  assert.deepEqual(plain(caret.pick()), tomorrow, 'Enter links the day as Tana writes it: a tana:plaindate: mention with its short label');
  assert.match(tomorrow.uri, /^tana:plaindate:\d{4}-\d{2}-\d{2}$/);
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
    const loginBox = {}, filtered = {}, pagehead = {};
    const outline = {};
    const $ = (id) => id === 'loginBox' ? loginBox : id === 'filtered' ? filtered : id === 'pagehead' ? pagehead : {};
    const showError = () => {};
    const render = () => {};
    const views = [], searches = [], typeListCache = null;
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
    ({ showStatus, paletteRows, state: () => ({ authed, authChecking, signedOut, loginHidden: loginBox.hidden, headHidden: pagehead.hidden }) });
  `);
  api.showStatus({ authenticated: null, authChecking: false, error: new Error('probe failed') });
  assert.deepEqual(plain(api.state()), { authed: false, authChecking: false, signedOut: false, loginHidden: true, headHidden: false }, 'failed session probe keeps the login button hidden');
  assert.equal(api.paletteRows('').some((row) => row.id === 'login'), false, 'failed session probe has no Cmd+K login action');
  api.showStatus({ authenticated: false, authChecking: false });
  assert.deepEqual([api.state().loginHidden, api.state().headHidden], [false, true], 'signed out, the login shows with no view title above it');
  api.showStatus({ authenticated: true, authChecking: false });
  assert.equal(api.state().headHidden, false, 'and the title comes back once signed in');
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
    const views = [], searches = [], typeListCache = null, pinTree = [], pinRows = () => [], pillCommandRows = () => [], taskActionRows = () => [];
    let loads = 0;
    const ran = [], run = (fn) => fn(), goTo = () => {};
    const selectionRows = () => [{ id: 'status', group: 'Current node', label: 'Set status', subBase: 'Set status to', keepOpen: true, run: () => {}, sub: () => { loads++; return [{ label: 'Inbox', run: () => ran.push('Inbox') }, { label: 'In Progress', run: () => ran.push('In Progress') }, { label: 'Later', disabled: true, run: () => {} }]; } }];
    const tana = { refresh: async () => {} };
    const authed = true, authChecking = false, signedOut = false, theme = 'light', hotkeys = {}, themePref = 'light', pinInfo = null, palDoc = null;
    const localDate = () => '2026-09-13', setTheme = () => {}, docRow = () => ({}), sectionOf = () => null;
    const zoom = null, railEl = { hidden: true }, navBack = [], navForward = [], sensitiveVisible = false;
    const railToggle = { hidden: false }, railHidden = false; // the sidebar toggle row: available, so paletteRows builds it
    const showError = () => {}, palette = { hidden: false }, palMode = 'cmd', renderPalette = () => {};
    const setZoom = () => {}, navigate = () => {}, history = () => {}, togglePalette = () => {}, focusRail = () => {}, setView = () => {}, openDoc = () => {}, filterEl = {}, render = () => {}, zoomFactor = 1, BASE_ZOOM = 1;
    const visibilityRows = () => [], moveTargets = async () => [], previewMoveToSpace = () => {};
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${functionSource('paletteRows')}
    ${functionSource('runAction')}
    ({ rows: async (q) => { paletteRows(q); await Promise.resolve(); await Promise.resolve(); return paletteRows(q).map((r) => r.label); }, loads: () => loads,
       ids: (q) => paletteRows(q).map((r) => r.id), press: async (id) => { const hit = runAction(id); await Promise.resolve(); return [hit, ran.splice(0)]; } });
  `);
  assert.deepEqual(plain(await folded.rows('s')), ['Sync', 'Search Tana', 'Set status', 'Smaller text', 'Reset text size', 'Hide sidebar', 'Filter rows by text'],
    'one letter: the first level only, the groups whose best row starts with it first (the shortest such row leading), a letter inside a word last');
  assert.deepEqual(plain(await folded.rows('sesp')), ['Set status to In Progress'], 'two letters in: the level below is folded in and the query reaches into it');
  assert.deepEqual(plain(await folded.rows('seinb')), ['Set status to Inbox'], 'a disabled choice is left out, the others are single rows');
  assert.deepEqual(plain(await folded.rows('ssin')), ['Set status to Inbox', 'Set status to In Progress'], 'the initials of the row open its level too');
  assert.equal(folded.loads(), 1, 'the level is loaded once per palette');
  // A folded choice has an id of its own (its parent's plus its label), so ⇧⌘K can record a key against it, and the key
  // runs it with nothing folded: runAction asks the parent row for its choices.
  assert.deepEqual(plain(folded.ids('ssin')), ['status>Inbox', 'status>In Progress'], 'folded choices carry recordable ids');
  assert.deepEqual(plain(await folded.press('status>In Progress')), [true, ['In Progress']], 'a key on a folded choice runs that choice');
  assert.deepEqual(plain(await folded.press('status>Later')), [true, []], 'a choice that is off right now does nothing, and still owns its key');
  assert.deepEqual(plain(await folded.press('assign>Robin')), [false, []], 'a folded id whose parent is absent leaves the key alone');

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
    let home = 'library', searches = [], typeListCache = null, view = 'library';
    const searchesLoaded = true, localStorage = { setItem() {} }, onSearchPage = () => false;
    const selectionRows = () => [{ id: 'delete', group: 'Current node', label: 'Delete' }, { id: 'sensitive', group: 'Current node', label: 'Mark as sensitive' }, { id: 'zoomIn', group: 'Current node', label: 'Zoom in' }, { id: 'status', group: 'Current node', label: 'Set status' }];
    const pillCommandRows = () => [{ id: 'pill:type', group: 'View options', label: 'Filter by type' }], taskActionRows = () => [];
    const tana = { refresh: async () => {}, todayNode: async () => {}, weekNode: async () => {}, nodeLink: async () => {}, accessOptions: async () => {}, filters: {}, sensitiveIds: () => {}, creationOptions: async () => {}, discussWith: async () => {}, pin: async () => {}, pinState: async () => ({}) }, run = () => {};
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
    const posted = [], window = { frameElement: {}, parent: { postMessage: (m) => posted.push(m) } }; // the shell this page asks (shellRun)
    const openCreationPalette = () => {}, openHiddenPalette = () => {}, toggleSensitiveVisibility = () => {}, followSystem = () => {}, openVisibilityPalette = () => {}, openMovePalette = () => {}, toggleDatePin = (doc, date) => pinCalls.push([doc.id, date]), copyText = () => {}, togglePalette = () => {}, navigate = () => {}, history = () => {}, focusRail = () => {}, setZoom = () => {}, goTo = (id) => went.push(id), setView = (id) => went.push('view:' + id), openDoc = () => {}, filterEl = {}, render = () => {}, zoomFactor = 1, BASE_ZOOM = 1;
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${sourceBetween('const PANE_ROWS', 'const shellRun')}${sourceLine('const shellRun')}
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    const visibilityRows = () => [], moveTargets = async () => [], previewMoveToSpace = () => {};
    ${functionSource('paletteRows')}
    ({ labels: (q) => paletteRows(q).map((row) => row.group + ': ' + row.label),
       row: (id) => paletteRows('').find((r) => r.id === id),
       datePin: (rank) => { const row = paletteRows('').find((r) => r.rank === rank); pinCalls.length = 0; row.run(); return [row.label, ...pinCalls[0]]; },
       pinnedOn: (dates) => { pinInfo.dates.length = 0; pinInfo.dates.push(...dates); },
       went: () => { const out = [...went]; went.length = 0; return out; },
       choose: (id, list) => { home = id; searches = list || []; },
       panes: (next) => { windowPanes = next; }, posted: () => posted.splice(0) });
  `);
  assert.deepEqual(plain(order.labels('')), [
    'Current node: Zoom in', 'Current node: Set status', 'Current node: Discuss with …', 'Current node: Pin to today', 'Current node: Pin to tomorrow', 'Current node: Pin to date …', 'Current node: Edit pins', 'Current node: Move to …', 'Current node: Move to Library',
    'Current node: Mark as sensitive', 'Current node: Edit visibility', 'Current node: Copy link', 'Current node: Delete',
    'Get started: Log in to Tana', // signed out there is no current node, so this is the first row
    'Views: Today', 'Views: This week', 'Views: Inbox', 'Views: Library',
    'View options: Filter by type', 'View options: Filter rows by text',
    'Actions: Create new …', 'Actions: Search Tana', 'Actions: Undo', 'Actions: Redo', 'Actions: Sync',
    'Navigate: Go back', 'Navigate: Go forward', 'Navigate: Go to Home', 'Navigate: Focus the sidebar',
    'Window: New window', 'Window: New pane', 'Window: New tab', 'Window: New floating pane', 'Window: Hide sidebar', 'Window: Reload',
    'Settings: Larger text', 'Settings: Smaller text', 'Settings: Reset text size', 'Settings: Toggle dark mode', 'Settings: Edit hidden items', 'Settings: Toggle sensitive visibility', 'Settings: Toggle demo mode',
    'Help: Help',
  ], 'the palette lists its rows in one fixed, meaningful order');
  // A window of more pages (the shell's word, renderer/app.js) offers the workspace's moves, each a key's row asking
  // the shell to run Trellis's command.
  order.panes({ pages: 3 });
  assert.deepEqual(plain(order.labels('').filter((l) => l.startsWith('Window: ')).slice(4, -2)), ['Window: Next pane', 'Window: Previous pane', 'Window: Next tab', 'Window: Previous tab',
    'Window: Maximize or restore pane', 'Window: Show all panes', 'Window: Zoom back', 'Window: Zoom forward', 'Window: Close pane'], 'more pages: the pane rows');
  order.row('maximizePane').run(); order.row('otherPane').run(); order.row('overview').run();
  assert.deepEqual(plain(order.posted()), [{ orbital: 'run', command: 'frame.toggle' }, { orbital: 'run', command: 'panel.next' }, { orbital: 'run', command: 'navigation.overview' }], 'each asks the shell to run its command');
  order.panes({ pages: 1 });
  // The two date pins differ only in the day they name, and each label follows whether that day is already pinned;
  // the press toggles that day (toggleDatePin, which reads the pins again: runClosedPaletteKeysCheck).
  const DOC_ID = 'tana:text:01j0doc000000000000000000';
  assert.deepEqual(plain(order.datePin('pinToday')), ['Pin to today', DOC_ID, '2026-09-13'], 'Pin to today toggles today\'s pin on this node');
  assert.deepEqual(plain(order.datePin('pinTomorrow')), ['Pin to tomorrow', DOC_ID, '2026-09-14'], 'Pin to tomorrow toggles the next local day');
  order.pinnedOn(['2026-09-14']);
  assert.deepEqual(plain(order.datePin('pinTomorrow')), ['Unpin from tomorrow', DOC_ID, '2026-09-14'], 'and says unpin once that day is pinned');
  assert.deepEqual(plain(order.datePin('pinToday')), ['Pin to today', DOC_ID, '2026-09-13'], 'while a pin on tomorrow leaves today\'s row offering to pin');
  order.pinnedOn([]);
  // Nothing matched: one row that carries the query into Cmd+S, under the "No results" heading.
  assert.deepEqual(plain(order.labels('zzqq')), ['No results: Search Tana for \u201Czzqq\u201D'],
    'a query nothing matches offers the Tana search with what was typed');
  const SAVED = 'tana:search:01j0myt00000000000000000';
  order.choose(SAVED, [{ id: SAVED, text: 'My Tasks' }]);
  // Go to Home is the other half: always listed, honest about where it goes, and disabled only where it would do nothing.
  assert.deepEqual(plain([order.row('goHome').hint, order.row('goHome').disabled]), ['My Tasks', false],
    'Go to Home names the Home it would open, read live from the saved search');
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
  assert.equal(plain(order.labels('text'))[0], 'Settings: Larger text', 'a shorter label wins a tie on tier, whichever group comes first');

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
    const views = [], searches = [], typeListCache = null, pinTree = [], pinRows = () => [], selectionRows = () => [];
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
    const hotkeys = { 'view:tasks': '⇧⌘T', 'doc:tana:text:abc': '⌃⌥N', 'status>Later': '⌃⌥L' };
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
  assert.match(api.taken('⌃⌥L', 'addToday'), /"Later"/, 'and a folded choice, absent right now, by its label');
  assert.equal(api.taken('⇧⌘T', 'view:tasks'), '', 'a row may keep its own combo');
  assert.equal(api.taken('⇧⌘U', 'addToday'), '', 'and a free combo passes');
  // The pane keys (renderer/state.js): ⌥ and ⇧ change what a bracket or \ types, so the key pressed is what counts
  const keys = vm.runInNewContext(`${sourceLine('const KEYNAMES')}\n${sourceLine('const KEYCODES')}\n${functionSource('comboOf')}\n({ comboOf })`);
  const combo = (key, code, mods) => keys.comboOf({ key, code, metaKey: true, ...mods });
  assert.deepEqual([combo('“', 'BracketLeft', { altKey: true }), combo('|', 'Backslash', { shiftKey: true }), combo('?', 'Slash', { shiftKey: true }), combo('[', 'BracketLeft'), combo('ArrowDown', 'ArrowDown', { altKey: true })],
    ['⌥⌘[', '⇧⌘\\', '⇧⌘/', '⌘[', '⌥⌘↓'], 'a bracket, \\ or / reads as the key pressed, whatever ⌥ or ⇧ makes it type, so the pane keys can match');
  const defaults = Object.values(vm.runInNewContext('(' + source.match(/const DEFAULT_HOTKEYS = (\{[^\n]*\});/)[1] + ')'));
  assert.equal(new Set(defaults).size, defaults.length, 'no two built-in keys share a combo');
  assert.deepEqual(defaults.filter((c) => api.taken(c, 'none').includes(' already ') && !/shortcut for/.test(api.taken(c, 'none'))), [], 'and none is one the handlers keep fixed');
}
// Cmd+[ and Cmd+] walk the places rendered so far: view switches and zooms, recorded by the render itself, so every
// way of navigating counts; going back then somewhere new drops the forward places, like a browser.
function runHistoryCheck() {
  const api = vm.runInNewContext(`
    const SIDE = ''; // renderer/state.js: a page on its own, not the right half of a split
    let view = 'tasks', zoom = null, caretOnOpen = false, rendered = 0;
    const INBOX_PAGE = 'orbital:notifications', PROPOSALS_PAGE = 'orbital:proposals', TIMELINE_PAGE = 'orbital:timeline';
    let notificationLeaves = 0;
    const markAllNotificationsRead = () => { notificationLeaves++; };
    const localStorage = { setItem() {}, removeItem() {} };
    ${sourceBetween('const isRealId =', '\n')}
    const flushAll = () => {}, dropDrafts = () => {}, releaseHeld = () => {};
    const kids = new Map(), searchRows = new Map(), refreshed = [], previews = [];
    const isSearchDoc = (node) => node.id?.startsWith('tana:search:');
    const run = (fn) => fn(), reload = async (id) => { refreshed.push(id); }, renderSoon = () => {};
    const previewRows = (id) => { previews.push(id); searchRows.set(id, 'unsaved'); };

    const render = () => { rendered++; noteNavigation(); }; // what renderOutline does at its end
    ${sourceBetween('const navBack = [], navForward = [];', 'function noteNavigation')}
    ${functionSource('noteNavigation')}
    ${functionSource('navigate')}
    ({
      go: (v, z) => { view = v; zoom = z; render(); },
      hop: (v, z) => { navReplace = true; view = v; zoom = z; render(); }, // a meeting forwarding to its write-up
      back: () => navigate(-1), forward: () => navigate(1),
      cache: (id, preview = false) => { kids.set(id, []); if (preview) searchRows.set(id, 'unsaved'); },
      refreshes: () => [refreshed, previews],
      where: () => [view, zoom && zoom.docId, navBack.length, navForward.length],
      notificationLeaves: () => notificationLeaves,
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
  const search = 'tana:search:example';
  api.go('library', { docId: search });
  assert.deepEqual(plain(api.refreshes()), [[], []], 'an uncached search uses the normal initial loader');
  api.cache(search);
  api.go('library', { docId: 'tana:text:result' });
  api.back();
  assert.deepEqual(plain(api.refreshes()), [[search], []], 'Back reruns a cached saved search');
  api.go('library', { docId: search });
  assert.equal(api.refreshes()[0].length, 1, 'redrawing the same search does not rerun it');
  api.back(); api.forward();
  assert.equal(api.refreshes()[0].length, 2, 'Forward refreshes the saved search too');
  api.go('library', { docId: 'tana:text:result' });
  api.go('library', { docId: search });
  assert.equal(api.refreshes()[0].length, 3, 'ordinary navigation such as a breadcrumb refreshes too');
  api.cache(search, true);
  api.go('library', { docId: 'tana:text:result' });
  api.back();
  assert.deepEqual(plain(api.refreshes()), [[search, search, search], [search]], 'returning to unsaved filters refreshes their preview instead of the stored query');
  api.go('library', { docId: 'orbital:notifications' }); api.go('library', { docId: 'orbital:notifications' });
  assert.equal(api.notificationLeaves(), 0, 'redrawing the Notifications page does not mark it read');
  api.go('tasks', null);
  assert.equal(api.notificationLeaves(), 1, 'switching views away from Notifications marks all as read');
  api.back(); api.forward();
  assert.equal(api.notificationLeaves(), 2, 'Forward away from Notifications marks all as read');
  api.go('library', { docId: 'orbital:notifications' }); api.go('library', { docId: 'tana:text:outside' });
  assert.equal(api.notificationLeaves(), 3, 'opening another document from Notifications marks all as read');

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
      const taskMetaById = new Map([[doc.id, { assignees: [], hiddenFrom: ['tana:user-profile:01j0old00000000000000000'] }]]);
      const tana = { setAssignees: async (id, assignees) => { calls.push([id, assignees]); if (${JSON.stringify(fails)}) throw new Error('assignment denied'); },
        taskMeta: async () => ({ assignees: ['tana:user-profile:01j0member0000000000000'] }) }; // main's fresh answer: nobody left out
      const showError = (value) => { error = value.message; };
      const run = (fn) => Promise.resolve().then(fn).catch(showError);
      const render = () => {}, renderPalette = () => {}, closePalette = () => { closed++; palette.hidden = true; };
      ${setTaskAssignees}
      Object.assign(globalThis, { choose: () => setTaskAssignees(doc, ['tana:user-profile:01j0member0000000000000']), state: () => ({ calls, closed, error }), meta: () => taskMetaById.get(doc.id) });
    `, context);
    return context;
  };
  const success = makeHarness(false);
  success.choose();
  await new Promise((resolve) => setTimeout(resolve));
  assert.deepEqual(plain(success.state()), {
    calls: [['tana:text:01j0task0000000000000000', ['tana:user-profile:01j0member0000000000000']]], closed: 1, error: null,
  }, 'a successful assignee update closes the picker');
  assert.deepEqual(plain(success.meta()), { assignees: ['tana:user-profile:01j0member0000000000000'] },
    'and the metadata is read again, so a warning about the old assignee goes with them');

  const failure = makeHarness(true);
  failure.choose();
  await new Promise((resolve) => setTimeout(resolve));
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
    const renderFields = (parent, force, el) => { el.fieldDoc = parent.docId; };
    const loadRelated = () => {};
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
    (node, children) => { kids = children || []; const el = nodeEl(node, 'doc', { node: { kind: 'document', editable: true } }); const chev = el.children[0].children[0]; return { first: chev.tagName, hidden: chev.hidden === true, off: chev.classList.contains('off'), fields: el.children[1]?.children[0]?.fieldDoc }; };
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
  assert.equal(rowChevron(states['expanded with children'][0], states['expanded with children'][1]).fields, 'doc', 'expanded documents draw their fields before body children');
  const styles = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
  const chevRules = styles.split('\n').filter((line) => /(^|[\s,>])\.chev\b/.test(line) && !line.trim().startsWith('/*'));
  assert.ok(chevRules.length, 'styles.css styles the chevron');
  for (const rule of chevRules) assert.doesNotMatch(rule, /display:\s*none/, 'no stylesheet rule takes the chevron out of the layout: ' + rule.trim());
  assert.match(styles, /\.chev \{[^}]*width: 24px/, 'the chevron reserves a fixed gutter');
}

// A metadata read that fails while a brand-new document is still settling must be retried, not blacklisted for the session.
function runInlineFieldsCheck() {
  const api = vm.runInNewContext(`
    ${FAKE_DOM}
    const page = makeEl('div'), inline = makeEl('div'), $ = () => page;
    const relatedBy = new Map([['doc', { fields: [{ key: 'tana:type:test?attribute=who', label: 'Discuss with', segments: [{ text: 'Rob Schuurman' }] }] }]]);
    const kids = new Map(), loaded = [], built = [];
    let fieldsDeferred = false;
    const iconSvg = () => '', blurSensitive = () => {}, canEditItem = (item) => item.node.editable !== false;
    const mkItem = (docId, node, parent) => ({ docId, node, parent });
    const ensureLoaded = (host) => loaded.push(host.docId);
    const renderSegs = (el, segments) => { el.textContent = segments.map(s => s.text).join(''); };
    const withDraftTail = (rows) => rows;
    const childEl = (node, host) => { built.push({ id: host.docId, editable: host.node.editable }); const el = makeEl('div'); el.textContent = node.text; return el; };
    ${functionSource('renderFields')}
    const parent = { docId: 'doc', node: { kind: 'document', editable: true } };
    ({ draw: () => renderFields(parent, true, inline), state: () => ({ text: inline.textContent, page: page.textContent, loaded, built }),
       ready: () => kids.set('doc|tana:type:test?attribute=who', [{ text: 'Updated value' }]),
       readonly: () => { parent.node.editable = false; } });
  `);
  api.draw();
  assert.equal(api.state().text, 'Discuss withRob Schuurman', 'inline fields show their labels and cached values while loading');
  assert.equal(api.state().page, '', 'drawing inline fields leaves the zoomed page fields untouched');
  assert.equal(api.state().loaded[0], 'doc|tana:type:test?attribute=who', 'field editing uses the existing document-field address');
  api.ready(); api.readonly(); api.draw();
  assert.equal(api.state().text, 'Discuss withUpdated value', 'loaded field rows replace the cached value');
  assert.equal(api.state().built[0].editable, false, 'inline field editors inherit document write permission');
  const navigation = vm.runInNewContext(`
    const body = { closest: () => null }, fieldRow = { closest: () => field }, field = {};
    const outline = {}, titleEl = { isContentEditable: false }, $ = () => ({ hidden: true });
    const rowsIn = (el) => el === field ? [fieldRow] : [body, fieldRow];
    ${sourceLine('const texts')}
    ${sourceLine('const fieldValues')}
    ${sourceLine('const rowsBeside')}
    ${sourceLine('const caretRows')}
    ({ structural: rowsBeside(body).length, field: rowsBeside(fieldRow).length, vertical: caretRows().length });
  `);
  assert.deepEqual(plain(navigation), { structural: 1, field: 1, vertical: 2 }, 'structural edits stay inside each outline while vertical movement includes inline fields');
}

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
  // An empty list page says what would fill it (the Work View a new account opens on is two of them), a document
  // says it has no content, and a list of tasks names the key that makes one: the one that is recorded now.
  const emptyText = vm.runInNewContext(`
    const TIMELINE_PAGE = 'orbital:timeline', INBOX_PAGE = 'orbital:notifications', PROPOSALS_PAGE = 'orbital:proposals', SEARCH_ID = 'tana:search:';
    const isTypeDoc = (n) => n.id.startsWith('tana:type:'), hotkeys = {}, DEFAULT_HOTKEYS = { createTask: '⇧⌘Space' };
    const filters = new Map([['tana:search:mine', { types: ['tasks'] }], ['tana:search:meet', { types: ['meetings'] }]]);
    ${sourceLine('const isSearchDoc =')}
    ${sourceLine('const isChatPage =')}
    ${sourceLine('const hotkeyFor =')}
    ${sourceLine('const tasksInFilter =')}
    ${functionSource('emptyText')}
    ({ text: (id) => emptyText({ docId: id, node: { id } }), record: (k) => { hotkeys.createTask = k; } });
  `);
  assert.match(emptyText.text('orbital:timeline'), /^Nothing yet\./, 'an empty Timeline says what shows up there');
  assert.equal(emptyText.text('tana:search:mine'), 'Nothing matches. ⇧⌘Space creates a task.', 'an empty My Tasks names the key that makes one');
  assert.equal(emptyText.text('tana:search:meet'), 'Nothing matches.', 'a search that lists no tasks does not');
  assert.equal(emptyText.text('tana:text:doc'), 'No content', 'a document still has no content');
  assert.match(emptyText.text('tana:chat:c'), /^No messages yet\./, 'an empty chat points at its composer');
  emptyText.record('⌃⌥T');
  assert.equal(emptyText.text('tana:search:mine'), 'Nothing matches. ⌃⌥T creates a task.', 'the key named is the one recorded');
  emptyText.record('');
  assert.equal(emptyText.text('tana:search:mine'), 'Nothing matches.', 'and with none, no key is promised');
  const saved = vm.runInNewContext(`
    const hotkeys = { createTask: '⌃⌥T' }, stored = [];
    let renders = 0;
    const setPref = (key, value) => stored.push([key, value]), renderSoon = () => { renders++; };
    ${sourceLine('const saveHotkeys =')}
    saveHotkeys();
    ({ stored, renders });
  `);
  assert.deepEqual([saved.stored.length, saved.renders], [1, 1], 'a key recorded or reset redraws the page, so the empty note names the key as it is now');
  const nextPalIndex = vm.runInNewContext(functionSource('nextPalIndex') + '; nextPalIndex;');
  const rows = [{ disabled: true }, { label: 'a' }, { disabled: true }, { label: 'b' }];
  assert.equal(nextPalIndex(rows, 1, 1), 3, 'Down skips a disabled row');
  assert.equal(nextPalIndex(rows, 3, 1), 1, 'Down wraps past a disabled first row');
  assert.equal(nextPalIndex(rows, 1, -1), 3, 'Up wraps backwards to the last runnable row');
  assert.equal(nextPalIndex([{ disabled: true }, { disabled: true }], 0, 1), 0, 'a list with nothing runnable stays put');
  const styles = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
  assert.match(styles, /\.palette \.row\.disabled \{/, 'a palette row that cannot run looks different from a runnable one');

  // ↑/↓ move the highlight over the rows already drawn (#272): no row is built again, in the palette or a pill menu.
  const moves = vm.runInNewContext(`
    const el = () => { const cls = new Set(); return { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c) }, scrolled: 0, scrollIntoView() { this.scrolled++; } }; };
    let drawn = [], renders = 0, pillRenders = 0, palIndex = 0, menu = { index: 0 };
    let palRows = [{ label: 'a' }, { disabled: true }, { label: 'b' }];
    const palList = { querySelectorAll: () => drawn };
    const renderPalette = () => { renders++; drawn = palRows.map(el); };
    const renderPills = () => { pillRenders++; };
    const pill = { querySelectorAll: () => drawn };
    ${functionSource('nextPalIndex')}
    ${functionSource('movePalIndex')}
    ${functionSource('moveMenuIndex')}
    renderPalette(); renders = 0;
    const active = () => drawn.findIndex((row) => row.classList.has('active'));
    ({ key: (step) => { movePalIndex(step); return { palIndex, active: active(), renders, scrolled: drawn[palIndex].scrolled }; },
       drop: () => { palRows = palRows.slice(1); }, // a row taken out of palRows without a redraw (invalidateNode)
       menu: (count, step) => { menu.index = 0; drawn = Array.from({ length: 3 }, el); moveMenuIndex(pill, count, step); return { index: menu.index, active: active(), pillRenders }; } });
  `);
  assert.deepEqual(plain(moves.key(1)), { palIndex: 2, active: 2, renders: 0, scrolled: 1 }, 'Down moves the highlight past a dead row without drawing the list again');
  assert.deepEqual(plain(moves.key(1)), { palIndex: 0, active: 0, renders: 0, scrolled: 1 }, 'and wraps, still without a redraw');
  moves.drop();
  assert.equal(moves.key(1).renders, 1, 'rows changed under the drawn list: it is drawn again rather than highlighting the wrong row');
  assert.deepEqual(plain(moves.menu(3, -1)), { index: 2, active: 2, pillRenders: 0 }, 'Up in a pill menu wraps to its last row without drawing the pills again');
  assert.equal(moves.menu(2, 1).pillRenders, 1, 'a menu drawn from another list is drawn afresh');

  // Typing on a page redraws it from the words, unless main finds its rows (#297): Pin to date used to ignore every
  // key and send a Tana search nobody read.
  const typing = vm.runInNewContext(`
    let palMode = 'cmd', palIndex = 3, palEnter = 'pick', palBusy = false, palSeq = 0, palTimer = null, renders = 0;
    const asked = [], setTimeout = (fn) => { asked.push(fn.name); return 1; }, clearTimeout = () => {};
    const renderPalette = () => { renders++; }, searchNow = function searchNow() {}, searchIconsNow = function searchIconsNow() {};
    const searchSpacesNow = function searchSpacesNow() {}, todayPickerSearchNow = function todayPickerSearchNow() {};
    let listener; const palInput = { addEventListener: (type, fn) => { if (type === 'input') listener = fn; } };
    ${sourceBetween("palInput.addEventListener('input'", "palInput.addEventListener('keydown'")}
    const typeOn = (mode) => { palMode = mode; renders = 0; asked.length = 0; listener(); return { renders, asked: [...asked], palIndex, palEnter }; };
    typeOn.seq = () => palSeq;
    typeOn;
  `);
  for (const mode of ['pinDate', 'moveConfirm', 'cmd', 'field', 'meetingTime']) {
    assert.deepEqual(plain(typing(mode)), { renders: 1, asked: [], palIndex: 0, palEnter: null }, mode + ': typing redraws the page from the words and asks main nothing');
  }
  assert.deepEqual(plain(typing('search')), { renders: 0, asked: ['searchNow'], palIndex: 0, palEnter: null }, 'the document search asks Tana, debounced');
  assert.deepEqual(plain(typing('setIcon').asked), ['searchIconsNow'], 'and Set icon asks main for its glyphs');
  for (const mode of ['search', 'spaces', 'setIcon', 'pinToday']) {
    const seq = typing.seq();
    typing(mode);
    assert.ok(typing.seq() > seq, mode + ': typing retires the answer to the words before, so it cannot settle an Enter meant for these (#397)');
  }

  // Every page opens through showPage (#275), so none inherits what the last one left running: Escape from Set icon
  // with an icon search still debounced used to land on the command page with the timer live and busy still set.
  const page = vm.runInNewContext(`
    let palTimer = 7, palSeq = 3, palEnter = 'pick', palBusy = true, palRows = [{}], palIndex = 2, palMode = 'setIcon', pillCtx = 'x';
    const cleared = [], clearTimeout = (id) => cleared.push(id), promptEditor = () => {}, palette = { hidden: false }, palInput = { value: 'st', placeholder: '', focus() {} };
    const refreshChatGPTStatus = () => {}, renderPalette = () => {}, paletteRows = () => [];
    ${functionSource('showPage')}
    ${functionSource('openCommandPalette')}
    openCommandPalette();
    ({ cleared, palTimer, palSeq, palEnter, palBusy, palRows, palIndex, palMode, pillCtx, value: palInput.value, placeholder: palInput.placeholder });
  `);
  assert.deepEqual(plain(page), { cleared: [7], palTimer: null, palSeq: 4, palEnter: null, palBusy: false, palRows: [], palIndex: 0, palMode: 'cmd', pillCtx: null, value: '', placeholder: 'Run a command' },
    'a page starts clean: the last page\'s timer cleared, its answers outdated, nothing busy or waiting on Enter');
  // A page that opens the palette itself (a recorded key on Set status, a row's meta) remembers the caret, as ⌘K does,
  // so closing it puts the caret back instead of leaving the focus on the page body (#376). An open palette keeps its own.
  const opens = (hidden, had, caret = true) => vm.runInNewContext(`
    let palTimer = null, palSeq = 0, palEnter = null, palBusy = false, palRows = [], palIndex = 0, palMode = 'cmd', palPage = {}, palReturn = ${JSON.stringify(had)};
    const clearTimeout = () => {}, promptEditor = () => {}, palette = { hidden: ${hidden} }, palInput = { value: '', placeholder: '' }, focused = () => (${caret} ? { key: 'row', offset: 2 } : null);
    const railRow = { dataset: { id: 'meta:assignees' } }, railEl = { contains: (el) => el === railRow }, document = { activeElement: railRow };
    ${sourceLine('const returnTarget')}
    ${functionSource('showPage')}
    showPage('status', 'Set status to…', {});
    palReturn;
  `);
  assert.deepEqual(plain(opens(true, null)), { key: 'row', offset: 2 }, 'a page opened with the palette closed remembers where the caret was');
  assert.deepEqual(plain(opens(false, { key: 'first' })), { key: 'first' }, 'a page opened from the palette keeps the place ⌘K remembered');
  assert.deepEqual(plain(opens(true, null, false)), { rail: 'meta:assignees' }, 'and one opened from a sidebar row (Edit assignees, visibility) goes back to that row');
  assert.doesNotMatch(functionSource('openVisibility'), /palette\.hidden = false/, 'openVisibility leaves opening the palette to showPage, which must see it closed');
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
    const CSS = { escape: (s) => s }, queryRow = (sel) => ({ sel }), setCaret = (el, offset) => calls.push(['cell', el.sel, offset]);
    const reload = async () => { calls.push(['reload']); };
    const run = async (fn) => fn();
    const startCreation = (choice) => calls.push(['startCreation', choice.kind, choice.title]);
    const tana = {
      setText: async (docId, id, value) => calls.push(['setText', docId, id, value]),
      setBlockType: async (docId, id, type) => calls.push(['setBlockType', docId, id, type]),
      insertDivider: async (docId, id) => calls.push(['insertDivider', docId, id]),
      insertTable: async (docId, id) => { calls.push(['insertTable', docId, id]); return 'c1'; },
      remove: async (docId, id) => calls.push(['remove', docId, id]),
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
    ['Heading 1', 'Heading 2', 'Heading 3', 'Bullet List', 'Numbered List', 'Code Block', 'Quote', 'Divider', 'Table', 'Image', 'Create Doc', 'Create Task', 'Create Project'],
    'the "/" menu offers every block type, a divider, a table, an image and the create choices');
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

  const table = makeSlashHarness();
  await table.rows('').find((row) => row.label === 'Table').run();
  assert.deepEqual(plain(table.calls()), [['setText', 'doc', 'block', []], ['insertTable', 'doc', 'block'], ['remove', 'doc', 'block'], ['reload'], ['cell', '.cell[data-cell="c1"]', 0]],
    'Table takes the place of the empty "/" row and puts the caret in its first cell');

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
    const onSearchPage = () => false, onTypePage = () => false;
    const render = () => { if (deferred) return; filterRow.hidden = !(filterShown || filterEl.value); }; // render.js: deferred while a row is being edited
    ${sourceBetween("if (!zoom || onSearchPage() || onTypePage()) rows.push({ id: 'filter'", '\n')}
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
  assert.deepEqual(plain(anyType), { open: false, filter: { types: null, states: ['open'], assignee: 'me', fields: null } },
    '"Any type" is a single choice: it applies and closes, and lets go of the last type\'s field filters');
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
  assert.deepEqual(plain(api.rows({ id: 'doc' }, { assignees: 'Sam', hiddenFrom: 'Sam', audience: { icon: 'lock', label: 'Visible only to you' } }).slice(0, 3).map((row) => [row.id, row.icon, row.label])),
    [['assignees', 'member', 'Assigned to Sam'], ['hiddenFrom', 'userAlert', 'Not visible to Sam'], ['visibility', 'lock', 'Visible only to you']], 'an assignee who cannot see the node is warned about under the assignees');
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
    let releases = 0; const releasedDocs = new Map(), releasedSince = () => false; // what main let go of (app.js forgetReleased): nothing, here
    const relatedBy = new Map([['event', {}], ['doc', {}]]), calls = [];
    const queryRow = () => null, CSS = { escape: (id) => id }, selectionFrozen = false;
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
  assert.deepEqual(plain(api.state()), { types: null, states: null, assignee: 'anyone', text: '', fields: null, audience: null, participant: null, window: null }, 'clearing Tasks means an unrestricted query');
  assert.equal(api.filtered(), false, 'and the action goes away again');
  api.set('library');
  assert.equal(api.filtered(), true, 'the shipped library filter still narrows the view');
  api.set('library', { text: 'memo' });
  assert.equal(api.filtered(), true, 'a search text narrows the Library view');
  api.clear();
  assert.deepEqual(plain(api.state()), { types: null, states: null, assignee: 'anyone', text: '', fields: null, audience: null, participant: null, window: null }, 'clearing the Library means anything, not the shipped default');
  assert.equal(api.filtered(), false, 'and with everything set to any, the action goes away');
  api.set('library', { types: ['tana:type:01m1e3nthqj48b8drqb1fmma9d'], fields: { 'tana:type:01m1e3nthqj48b8drqb1fmma9d?attribute=hpgqd4jv': { textMatches: [{ value: 'High' }] } } });
  assert.equal(api.filtered(), true, 'a field filter narrows the Library');
  api.clear();
  assert.equal(api.state().fields, null, 'and Clear filters lets go of it, rather than merging over it');
  assert.equal(api.filtered(), false, 'so the action goes away');
  api.set('scoped');
  api.clear();
  assert.deepEqual(plain(api.state()), { types: null, states: null, assignee: 'anyone', text: '', fields: null, audience: null, participant: 'me', window: 'recent' }, 'clearing a filter that carries a calendar scope keeps the participant and the window');
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
    ${sourceBetween('const GROUPS =', 'const FALLBACK =')}${sourceBetween('const VIEW_ARRANGEMENT =', 'const groupBy =')}
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
  // as the literal kind rather than as the absence of the old map, so a half-restored version cannot pass.
  assert.match(source, /const node = draftDocNode\('doc'\);/, 'no view drafts a task any more: Enter makes a doc everywhere');
  assert.doesNotMatch(source, /DRAFT_KIND/, 'and the per-view kind map is gone with it');
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
    let taskDragging = false; // renderer/drag.js: a task dragged over the pane draws the empty sections too
    ${FAKE_DOM}
    const filters = new Map([['tasks', { types: ['tasks'], states: ['open'], assignee: 'me' }]]);
    const views = [{ id: 'tasks', kind: true }, { id: 'library' }];
    let members = [{ id: 'me', title: 'Robin', me: true }, { id: 'sam', title: 'Sam' }];
    // the four tr rows are handed to Sam and still watched, so they land in Tracking and the section can be trimmed
    const taskMetaById = new Map([['t1', { assignees: ['sam'], watched: true }], ['t2', { assignees: ['me'] }], ['t4', { assignees: ['tana:user-profile:ghost'], watched: false }], ['t5', { assignees: ['me'] }], ['t6', { assignees: [] }], ['t7', { assignees: [] }], ['t8', { assignees: ['me'] }], ['t9', { assignees: ['me'] }], ['t10', { assignees: ['me'] }], ['t11', { assignees: ['sam'], watched: false }], ['ta1', { assignees: ['tana:user-profile:ghost'] }], ['ta2', { assignees: ['me'] }], ['tr1', { assignees: ['sam'], watched: true }], ['tr2', { assignees: ['sam'], watched: true }], ['tr3', { assignees: ['sam'], watched: true }], ['tr4', { assignees: ['sam'], watched: true }]]);
    // the app-local agent marks the badge is drawn from (renderer/state.js), not Tana assignees
    const codexIds = new Set(['ta1', 'ta2', 'ta3']);
    // your date pins (renderer/state.js, api.pinDates): tp1 is Sam's task on a third person, pinned to a day
    ${sourceLine('const localDate =')}
    // tq*: pinned relative to today, for the Pinned section opening on the coming week
    const datePinsById = new Map([['tp1', ['2026-09-23']], ['tp2', ['2026-09-20', '2026-10-01']], ['tp3', ['2026-09-25']],
      ['tq1', [localDate(3)]], ['tq2', [localDate(10)]], ['tq3', [localDate(-1)]], ['tq4', [localDate(9), localDate(7)]], ['tq5', [localDate(8)]]]);
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
       dragging: (on) => { taskDragging = on; },
       asked: () => asked,
       meta: (id, m) => taskMetaById.set(id, m),
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
    [['Unassigned', ['t6']], ['Agent', ['ta1', 'ta2', 'ta3']], ['My inbox', ['t8']], ['Mine', ['t10']], ['Tracking', ['t1']], ['My later', ['t9']], ['My completed', ['t2']], ['Assigned by others', ['t5']]],
    'Responsibility runs Unassigned, Agent, My inbox, Mine, then Tracking under your own work, then My later and My completed, and ends with what somebody else handed you');
  assert.deepEqual(titles(agents, 'responsibility'), [['Agent', ['ta1', 'ta2', 'ta3']]],
    'a node handed to the local agent is in the Agent section and in no other: whoever Tana has it assigned to, and even with no metadata read yet — asking for it by name is enough to list it');
  api.dragging(true);
  assert.deepEqual(titles(agents, 'responsibility').map(([title]) => title), ['Unassigned', 'Agent', 'My inbox', 'Pinned', 'Mine', 'Tracking', 'My later', 'My completed'],
    'while a task is dragged, every section a drop can land in is drawn, empty or not');
  api.dragging(false);
  const pinnedTask = { id: 'tp1', icon: 'task', tags: [], createdBy: 'sam' };
  assert.deepEqual(titles([...responsibility, pinnedTask], 'responsibility').map(([title, ids]) => title + ':' + ids.join()).slice(1, 4),
    ['My inbox:t8', 'Pinned:tp1', 'Mine:t10'],
    'a task pinned to a day sits in Pinned, under My inbox and above Mine, whoever has it and with no metadata read');
  assert.deepEqual(titles(responsibility, 'responsibility'),
    [['Unassigned', ['t6']], ['My inbox', ['t8']], ['Mine', ['t10']], ['Tracking', ['t1']], ['My later', ['t9']], ['My completed', ['t2']], ['Assigned by others', ['t5']]],
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
  assert.deepEqual(titles([...responsibility, ...agents, pinnedTask], 'responsibility').map(([title]) => title), plain(api.RESPONSIBILITY),
    'and nothing else is filed: a row you neither made nor hold, and one whose assignees have not arrived, are left out rather than collected under a heading');
  // Every section holds rows: the grouping's leftovers are not listed at all, under no heading and with no note.
  api.set('tasks', 'responsibility', 'default');
  const sections = plain(api.groupsOf(responsibility));
  const pinnedOrder = plain(api.groupsOf(['tp1', 'tp2', 'tp3'].map((id) => ({ id, icon: 'task', tags: [], createdBy: 'sam' })))).map((g) => [g.title, g.nodes.map((n) => n.id)]);
  assert.deepEqual(pinnedOrder, [['Pinned', ['tp2', 'tp3', 'tp1']]], 'Pinned runs by the latest day each task is pinned to, latest on top');
  assert.deepEqual(plain(api.groupsOf([{ id: 'tp1', icon: 'task', tags: [], createdBy: 'sam', stateType: 'closed' }])).map((g) => [g.title, g.nodes.map((n) => n.id)]),
    [['My completed', ['tp1']]], 'a completed pinned task leaves Pinned for My completed, pin and all');
  const soon = plain(api.groupsOf(['tq1', 'tq2', 'tq3', 'tq4', 'tq5'].map((id) => ({ id, icon: 'task', tags: [], createdBy: 'sam' }))))[0];
  assert.deepEqual([soon.nodes.map((n) => n.id).sort(), soon.more], [['tq1', 'tq3', 'tq4'], 2],
    'Pinned opens on what is pinned within the coming week or already past, and a task pinned only further ahead waits behind the link');
  assert.deepEqual(sections.map((g) => [g.title, g.nodes.map((n) => n.id)]),
    [['Unassigned', ['t6']], ['My inbox', ['t8']], ['Mine', ['t10']], ['Tracking', ['t1']], ['My later', ['t9']], ['My completed', ['t2']], ['Assigned by others', ['t5']]],
    'the sections run Unassigned, My inbox, Mine, Tracking, My later, My completed, Assigned by others, and end there');
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
  // First boot: My Tasks sorts by Updated, so the bootstrap each subscribed row announces holds it — mostly before its
  // metadata is back. That early answer (no Responsibility section, or Unassigned) is not a group to keep the row in.
  api.set('tana:search:s1', 'responsibility', 'updated');
  const early = { id: 'boot1', icon: 'task', stateType: 'open', createdBy: 'me', tags: [{ label: 'task' }] };
  api.holdRow(early);
  api.meta('boot1', { assignees: ['me'] });
  assert.deepEqual(onScreen([early]), [['Mine', ['boot1']]], 'a row held before its metadata arrived takes its section once it does, without Clean up');
  api.releaseHeld();
  api.set('tana:search:s1', 'assignee', 'updated');
  const unread = { id: 'boot2', icon: 'task', stateType: 'open', tags: [{ label: 'task' }] };
  api.holdRow(unread);
  api.meta('boot2', { assignees: ['sam'] });
  assert.deepEqual(onScreen([unread]), [['Sam', ['boot2']]], 'and grouped by Assignee it leaves Unassigned for its assignee the same way');
  api.releaseHeld();
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
  assert.deepEqual(plain(api.prefs()), { group: 'responsibility', sort: 'updated' }, 'an unset Library starts as the My Tasks saved search: by Responsibility, newest change first (#113)');
  api.set('library', 'none', 'title');
  assert.deepEqual(plain(api.prefs()), { group: 'none', sort: 'title' }, 'a page\'s own choice still wins over its starting arrangement');
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
  assert.deepEqual(plain(completedPill().rows().map((r) => [r.label, !!r.checked])), [['3 days', false], ['7 days', true], ['30 days', false], ['All', false]],
    'the choices are the four the rule knows, with the active one ticked and no way to turn completed tasks off here');
  assert.deepEqual(plain(api.pillDefs().map((d) => d.id)), ['status', 'completed', 'assigned', 'audience', 'sort', 'group', 'display'],
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
    const taskMetaById = new Map(), taskMetaLoading = new Set(), open = new Map(), pending = new Map(), members = null, outline = { dataset: { key: '' } };
    const sensitiveHidden = () => false;
    const isPinned = () => false;
    const pinnedOn = () => '';
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
  // A type or saved-search page reuses its unchanged rows the way a view does (#415): it rebuilt all 1,000 on every
  // render. The real row-drawing block of renderOutline, over a page of three rows drawn twice.
  const page = vm.runInNewContext(`
    let built = 0, kept = [];
    const outline = { dataset: {}, parentElement: {}, get children() { return kept; }, replaceChildren(...els) { kept = els; } };
    const kids = new Map(), filterEl = { value: '' }, tana = {}, PROPOSALS_PAGE = 'proposals', TIMELINE_PAGE = 'timeline';
    let animView = null, caretOnOpen = false;
    const ensureLoaded = () => {}, loadSearchFilter = () => {}, previewRows = () => {}, withDraftTail = (list) => list, mkItem = () => {};
    const isSearchDoc = () => false, isTypeDoc = (n) => n.id.startsWith('tana:type:');
    const isChatPage = () => false, chatAfterRender = () => {}; // renderer/chat.js: none of these pages is a chat
    let writable = true; const canEditNode = () => writable;
    const childrenOf = (item) => kids.get(item.docId), pageRows = (list) => ({ list, groups: null, hidden: 0 });
    const rowSig = (n) => n.text + '|' + outline.dataset.key;
    const nodeEl = (n, docId) => { built++; return { dataset: { key: docId }, classList: { contains: (c) => c === 'node' }, querySelector: () => null }; };
    ${sourceLine('const childEl')}
    function draw(parent) { outline.dataset.key = parent.key; ${sourceBetween('  let list, hidden = 0;', "  outline.classList.toggle('table-view'")} }
    const page = (id, list) => { kids.set(id, list); return { key: id, docId: id, node: { id, kind: 'document' } }; };
    ({ draw: (id, list) => { draw(page(id, list)); return { built, els: [...kept] }; }, lock: () => { writable = false; } });
  `);
  const three = ['a', 'b', 'c'].map((id) => ({ id: 'tana:text:' + id, text: id, kind: 'document' }));
  const first = page.draw('tana:type:t', three), again = page.draw('tana:type:t', three);
  assert.equal(again.built - first.built, 0, 'a type page redrawn with nothing changed rebuilds none of its rows');
  assert.ok(again.els.every((el, i) => el === first.els[i]), 'it puts the same row elements back');
  assert.equal(page.draw('tana:type:t', [{ ...three[0], text: 'renamed' }, ...three.slice(1)]).built - again.built, 1, 'a changed row is the only one rebuilt');
  const renamed = [{ ...three[0], text: 'renamed' }, ...three.slice(1)], edits = page.draw('tana:type:t', renamed).built;
  page.lock();
  assert.equal(page.draw('tana:type:t', renamed).built - edits, 3, 'a page that can no longer be edited rebuilds its rows, so none keeps its old editor');
  assert.match(functionSource('rowSig'), /\bdemoMode\b/, 'a switch to demo mode rebuilds every reused row, so none keeps a real title on screen');
  assert.match(functionSource('rowSig'), /typeDefs\(\)/, 'and a table row is rebuilt when a field definition its cells pick from changes');
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
// meeting itself (tana.currentMeeting -> main/meetings.currentMeeting, sdk/calls); the second opens a page of
// meetings to choose from (tana.searchPreview over the meetings filter). Both end in the one shared event pin
// (tana.pinTo -> pins.nodePin), so what is checked here is the rows, the page, and that the pin is the same write.
async function runPinToMeetingCheck() {
  const EVENT = 'tana:event:01j0event00000000000000000', OTHER = 'tana:event:01j0event10000000000000000';
  const DOC = 'tana:text:01j0doc000000000000000000';
  const NOW = Date.now(); // the page orders against the clock, so the fixtures are built from one
  const api = vm.runInNewContext(`
    let releases = 0; const releasedDocs = new Map(), releasedSince = () => false; // what main let go of (app.js forgetReleased): nothing, here
    const views = [], pinTree = [], pinRows = () => [], searches = [], typeListCache = null, searchesLoaded = true;
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
    const queryRow = () => null, CSS = { escape: (id) => id }, selectionFrozen = false;
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
  assert.deepEqual(plain([api.row('pinToMeeting').hint, api.row('pinToMeeting').disabled, api.row('pinToMeeting').icon]), ['Bingo', false, 'meetingPin'], 'once the meeting is known the row names it and is live');
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
  assert.deepEqual(plain([picker.label, picker.hint, picker.keepOpen, picker.disabled]), ['Pin to meeting …', 'Choose a meeting', true, null],
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
// A key recorded against a Cmd+K row fires with the palette closed (#273, #274): the date pins and Pin to current
// meeting act on the node under the caret with state read at the press, and the lookups only the open palette's
// hints and unkeyable rows need (the current call, sharing, watch state) are not made for a key.
async function runClosedPaletteKeysCheck() {
  const DOC = 'tana:text:01j0doc000000000000000000', OTHER = 'tana:text:01j0doc100000000000000000', EVENT = 'tana:event:01j0event00000000000000000';
  const api = vm.runInNewContext(`
    let releases = 0; const releasedDocs = new Map(), releasedSince = () => false; // what main let go of (app.js forgetReleased): nothing, here
    const views = [], pinTree = [], pinRows = () => [], searches = [], typeListCache = null, searchesLoaded = true;
    let home = 'library', view = 'library';
    const localStorage = { setItem() {} }, onSearchPage = () => false;
    const selectionRows = () => [], pillCommandRows = () => [], taskActionRows = () => [];
    const palette = { hidden: true };
    let palDoc = null, palField = null, meetingNow;
    let pinInfo = { docId: '${OTHER}', sidebar: false, dates: [] }; // the node Cmd+K was last opened on
    let palSeq = 0, openOnMeta = false, focus = '${DOC}', focusIcon, moveFocus = false; const currentDoc = () => ({ id: focus, icon: focusIcon }), fieldAt = () => null, document = { activeElement: null, documentElement: { dataset: {} } };
    let meetingCtx = null, infos = 0; const demoText = (s) => s, openMeetingPage = (mode) => { writes.push(['page', mode]); };
    const isRealId = () => true, localDate = (offset = 0) => (offset ? '2026-09-19' : '2026-09-18'), setTheme = () => {};
    const sectionOf = () => null, visibleTags = () => [], goTo = () => {}, setView = () => {}, openDoc = () => {};
    let palMode = 'cmd', palRows = [], palIndex = 0;
    const palInput = { placeholder: '', value: '', focus() {} };
    const zoom = null, railEl = { hidden: false }, navBack = [], navForward = [], sensitiveVisible = false;
    const railToggle = { hidden: false }, railHidden = false;
    const authed = true, authChecking = false, signedOut = false, theme = 'light', hotkeys = {}, themePref = 'light';
    const openCreationPalette = () => {}, openHiddenPalette = () => {}, toggleSensitiveVisibility = () => {}, followSystem = () => {};
    const openVisibilityPalette = () => {}, openMovePalette = () => {}, copyText = () => {};
    const togglePalette = () => {}, navigate = () => {}, history = () => {}, focusRail = () => {}, setZoom = () => {};
    const filterEl = {}, zoomFactor = 1, BASE_ZOOM = 1, previewMoveToSpace = () => {}, taskMetaById = new Map();
    // Selected people … is greyed until the participants are in, as the real page is (renderer/access.js)
    const visibilityRows = (q, doc = palDoc) => [{ label: 'Selected people …', disabled: !taskMetaById.has(doc.id), run: () => { writes.push(['people', doc.id]); openVisibilityPeople(doc); } }];
    let visibilityPeople = null, visibilityRoles = null; const me = () => null, loadMembers = () => {}, visibilityPeopleRows = () => [];
    const moveTargets = async (doc) => [{ label: 'Studio', run: () => writes.push(['move', doc.id, 'Studio']) }];
    const renderPalette = () => {}, closePalette = () => {}, promptEditor = () => {}, loadPinned = () => {};
    let pinFailed = null, pinRead = 0; // loadPins keeps a failed read here, and which read is the latest (renderer/state.js)
    const groupBy = () => 'none', holdRow = () => {}, isTask = () => true;
    const errors = []; let queue = Promise.resolve();
    const showError = (e) => { if (e) errors.push((e && e.message) || String(e)); };
    const run = (fn) => (queue = queue.then(fn).then((v) => { showError(null); return v; }, showError));
    const render = () => {}, relatedBy = new Map(), relatedStale = new Set(), queryRow = () => null, CSS = { escape: (id) => id }, selectionFrozen = false, renderSoon = () => {};
    const connected = true, accessById = new Map(), accessLoading = new Set(), notifyById = new Map(), notifyLoading = new Set();
    const calls = { current: 0, access: 0, notify: 0 }, writes = [], pinned = new Set();
    let answer = null;
    const tana = { refresh: async () => {}, filters: {}, related: async () => ({ pinned: [] }),
      currentMeeting: async () => { calls.current++; return answer; },
      pinTo: async (hub, id) => { writes.push(['pinTo', hub, id]); },
      accessOptions: async () => { calls.access++; return { move: true, sharing: true }; },
      taskMeta: async () => { calls.meta = (calls.meta || 0) + 1; if (openOnMeta) { palSeq++; palMode = 'cmd'; palette.hidden = openOnMeta === 'closed'; } if (moveFocus) { focus = '${OTHER}'; palDoc = { id: focus }; } return { participants: [] }; },
      notifyState: async () => { calls.notify++; return { on: false }; },
      meetingInfo: async () => { infos++; return { editable: true, allDay: false, location: '', attendees: [] }; }, editMeeting: async () => ({}),
      pinState: async () => ({ sidebar: false, dates: [...pinned] }),
      pin: async (id, target, date) => { writes.push(['pin', id, date]); pinned.add(date); },
      unpin: async (id, target, date) => { writes.push(['unpin', id, date]); pinned.delete(date); } };
    ${functionSource('loadRelated')}
    ${functionSource('refreshRelated')}
    ${sourceBetween('const docRow =', 'const NODE_ROW_ORDER')}
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    ${functionSource('paletteRows')}
    ${functionSource('runAction')}
    ${functionSource('loadMeeting')}
    ${functionSource('pinToMeeting')}
    ${functionSource('pinDocToMeeting')}
    ${functionSource('loadAccess')}
    ${functionSource('loadNotify')}
    ${functionSource('holdDatePin')}
    ${functionSource('toggleDatePin')}
    ${functionSource('loadPins')}
    ${functionSource('openVisibilityPeople')}
    ${functionSource('meetingOf')}
    ${functionSource('loadMeetingCtx')}
    ${functionSource('meetingRows')}
    ({ key: async (id) => { const handled = runAction(id); for (let i = 0; i < 6; i++) await Promise.resolve(); await queue; return handled; },
       meeting: (next) => { answer = next; },
       open: () => { palette.hidden = false; palDoc = currentDoc(); meetingNow = undefined; paletteRows(''); palette.hidden = true; },
       state: () => ({ writes: [...writes], errors: [...errors], calls: { ...calls } }),
       page: () => ({ open: !palette.hidden, mode: palMode, doc: palDoc && palDoc.id }),
       opens: (on) => { openOnMeta = on; palette.hidden = true; palMode = 'cmd'; },
       race: (on) => { moveFocus = on; palette.hidden = true; focus = '${DOC}'; },
       onMeeting: (on) => { focusIcon = on ? 'meeting' : undefined; },
       infos: () => infos,
       reset: () => { writes.length = 0; errors.length = 0; calls.current = calls.access = calls.notify = 0; accessById.clear(); notifyById.clear(); taskMetaById.clear(); delete calls.meta; meetingCtx = null; infos = 0; } });
  `);

  // 1. The date pins: on a node Cmd+K was never opened on, the key pins that node, and pressed again takes it off.
  assert.equal(await api.key('pinToday'), true, 'Pin to today has a row for a key on any real node, not only the one Cmd+K last read');
  assert.deepEqual(plain(api.state().writes), [['pin', DOC, '2026-09-18']], 'and pins the node under the caret to today');
  await api.key('pinToday');
  assert.deepEqual(plain(api.state().writes.at(-1)), ['unpin', DOC, '2026-09-18'], 'a second press reads the pins again and takes today off');
  await api.key('pinTomorrow');
  assert.deepEqual(plain(api.state().writes.at(-1)), ['pin', DOC, '2026-09-19'], 'Pin to tomorrow pins the next local day');

  // 2. Pin to current meeting before Cmd+K ever looked for a meeting: the press looks, and pins.
  api.reset();
  api.meeting({ id: EVENT, title: 'Bingo' });
  assert.equal(await api.key('pinToMeeting'), true, 'the key finds its row');
  assert.deepEqual(plain(api.state()), { writes: [['pinTo', EVENT, DOC]], errors: [], calls: { current: 1, access: 0, notify: 0 } },
    'and pins the node on the meeting it looks up at the press, the only lookup made');
  // 3. After Cmd+K was opened outside a meeting, the key still works once you are in one.
  api.meeting(null); api.open(); api.meeting({ id: EVENT, title: 'Bingo' }); api.reset();
  await api.key('pinToMeeting');
  assert.deepEqual(plain(api.state().writes), [['pinTo', EVENT, DOC]], 'a stale "no meeting" from the last palette does not swallow the key');
  api.meeting(null); api.reset();
  await api.key('pinToMeeting');
  assert.deepEqual(plain([api.state().writes, api.state().errors]), [[], ['No active meeting to pin to']], 'and with no meeting the press says so');

  // 4. Any other key asks nothing of Tana on the palette's behalf; the open palette still asks for its hints.
  api.reset();
  await api.key('back');
  assert.deepEqual(plain(api.state().calls), { current: 0, access: 0, notify: 0 }, 'a key with the palette closed looks up no call, sharing or watch state');
  api.open();
  assert.deepEqual(plain(api.state().calls), { current: 1, access: 1, notify: 1 }, 'the open palette does, for the rows and hints it draws');
  // 5. A key on a choice folded under Move to … asks for this node's access itself, once, and then moves it.
  api.reset();
  assert.equal(await api.key('move>Studio'), true, 'a folded Move to key is answered while the access is asked for');
  assert.deepEqual(plain(api.state().writes), [['move', DOC, 'Studio']], 'and moves the node once the access is in');
  assert.equal(api.state().calls.access, 1, 'asking for it once, for this key');
  api.reset();
  await api.key('visibility>Selected people …');
  assert.deepEqual(plain([api.state().writes, api.state().calls.access, api.state().calls.meta]), [[['people', DOC]], 1, 1],
    'a folded visibility key waits for the access and the participants its choice needs, then runs on its first press');
  assert.deepEqual(plain(api.page()), { open: true, mode: 'visibilityPeople', doc: DOC }, 'and the people page it opens is shown, not drawn into the closed palette');
  // Focus moves to another node while the participants are asked: the key still acts on the node it was pressed on.
  api.reset(); api.race(true);
  await api.key('visibility>Selected people …');
  api.race(false);
  assert.deepEqual(plain([api.state().writes, api.page().doc]), [[['people', DOC]], DOC], 'the choice is the one built for the node the key was pressed on, whatever has the focus when the answer lands');
  // Cmd+K opened while the participants are asked: the key lets its choice go rather than taking the palette over.
  api.reset(); api.opens(true);
  await api.key('visibility>Selected people …');
  api.opens(false);
  assert.deepEqual(plain([api.state().writes, api.page().mode]), [[], 'cmd'], 'a palette opened meanwhile keeps its page');
  api.reset(); api.opens('closed');
  await api.key('visibility>Selected people …');
  api.opens(false);
  assert.deepEqual(plain([api.state().writes, api.page().open]), [[], false], 'and a palette opened and closed again meanwhile is not reopened by the key');
  // 6. A meeting's own rows (Change time, Change location, Add attendee) wait on main saying it may be changed: with the
  // palette closed, a key on one asks that once and opens its page on the first press; any other key asks nothing (#391).
  api.reset(); api.onMeeting(true);
  await api.key('pinToday');
  assert.equal(api.infos(), 0, 'another key pressed on a meeting makes no meeting lookup');
  api.reset();
  assert.equal(await api.key('meetingTime'), true, 'a Change time key is answered on its first press, not left to the browser');
  assert.deepEqual(plain([api.state().writes, api.infos()]), [[['page', 'meetingTime']], 1], 'and opens the page once main has said this meeting may be changed, asking once');
  api.onMeeting(false);
  console.log('ok  keys with the palette closed: date pins and Pin to current meeting act on the node under the caret with state read at the press, and no palette-only lookup is made');
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
    const renderPalette = () => { renders++; }, paletteRows = () => [];
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
    ['pill:status', 'Filter by status', 'In Progress', 'filter'], ['pill:assigned', 'Filter by assignee', 'Anyone', 'filter'],
    ['pill:audience', 'Filter by visibility', 'Any', 'filter'],
    ['pill:sort', 'Sort by', 'Default', 'sort'], ['pill:group', 'Group by', 'None', 'group'],
    ['pill:display', 'Display', 'Status, Assigned, …', 'field'],
    ['cleanup', 'Clean up', 'Nothing to clean up', 'cleanup'], // always listed, off until a row is held in place
    ['tableView', 'Switch to table', null, 'table'], // the header's Outliner/Table switch, on every page with pills
  ], 'Cmd+K names the current Tasks view options for what they do, with the value as the hint the filters with the filter icon and the rest their own (Tasks groups by Status until told otherwise), and Tasks is a kind page with no type to pick');
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
  assert.deepEqual(plain(api.commands('library').map(([id]) => id)), ['pill:type', 'pill:status', 'pill:assigned', 'pill:audience', 'pill:sort', 'pill:group', 'pill:display', 'cleanup', 'tableView'],
    'Library includes its Type filter plus the other applicable pills');
  assert.deepEqual(plain(api.commands('inbox').map(([id]) => id)), ['pill:type', 'pill:status', 'pill:assigned', 'pill:audience', 'pill:sort', 'pill:group', 'pill:display', 'cleanup', 'tableView'],
    'the Inbox is a state rather than a kind, so it still picks types');
  // Clean up is the header pill as a command row, always listed and greyed out while there is nothing to clean up,
  // running the same action under a fixed id when there is — so a shortcut can be recorded for it beforehand.
  api.commands('tasks'); api.group('status');
  const kept = { id: 'h1', icon: 'task', done: 0, stateType: 'proposed', tags: [] }, going = { id: 'h2', icon: 'task', done: 0, stateType: 'open', tags: [] };
  const cleanupRow = (list) => plain(api.rows(list)).find((row) => row.id === 'cleanup');
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
  const at = listed.findIndex((row) => row.id === 'cleanup');
  assert.equal(listed[at].disabled, true, 'the row is off');
  assert.equal(nextPalIndex(listed, at - 1, 1), at, 'and Down still lands on it, so Cmd+Shift+K has a row to record against');
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
  assert.match(functionSource('openPillPalette'), /openPage\('pill', 'Choose ' \+ id, \{ rows: pillRows, back: BACK_TO_COMMANDS \}\)/, 'Escape from a pill returns one palette level');
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
  assert.match(source, /if \(caretOnOpen && !chat\) outline\.parentElement\.scrollTop = 0;/,
    'and the open itself lands at the top, through both the "Loading…" render and the one the children arrive on (a chat at its end, renderer/chat.js)');
}

// Opening a node puts the caret in the draft tail at the bottom while the page stays at the top; the first character
// typed is what scrolls down to it, once.
function runCaretOnOpenScrollCheck() {
  const api = vm.runInNewContext(`
    let scrollOnType = false, scrolls = [];
    const chipOnly = () => false;
    const item = { key: 'doc/b', busy: false, node: { kind: 'block', draft: false } };
    const items = new Map([[item.key, item]]);
    const keyOfEl = () => item.key, imageFiles = () => [];
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
    const ME_URI = 'tana:user-profile:me', me = () => ({ id: ME_URI }); // you, as the member list marks you (renderer/tasks.js)
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
        // the gap is styles.css's .tmeta > .ticon:not(:first-child) (renderer-check pins the rule): 6px after anything
        return { icons: icons ? icons.map((icon) => icon.attrs['aria-label'] || (icon.children[0] || { attrs: {} }).attrs['data-icon']) : null, gaps: icons ? icons.map((icon) => (icon.className === 'ticon' ? (info.children.indexOf(icon) ? '6px' : '0') : null)) : null, pending: info ? info.className.includes('pending') : null, sub: (body.children.find((child) => child.className === 'subtext') || {}).value || null, chips: body.children.filter((child) => child.className === 'chip').length, fetched: [...fetched], observed: observed.map((watched) => watched.dataset.metaFor) };
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
  assert.equal(row({ ...made, createdBy: 'tana:user-profile:me' }, spaceMeta).sub, 'Created 2 days ago', 'and made by you it says no name: your own work needs no byline');
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
      rows: (list, q) => { hiddenList = list; palInput.value = q; return hiddenRows(q.toLowerCase(), q); },
      runRow: async (list, q, index) => { hiddenList = list; stored = [...list]; palInput.value = q; const row = hiddenRows(q.toLowerCase(), q)[index]; calls.length = 0; await row.run(); return { calls: [...calls], list: hiddenList, typed: palInput.value }; },
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
  // Pin to date reads the typed words with parseDay (renderer/document.js), from a fixed Tuesday 22 September 2026
  const parseDay = vm.runInNewContext(sourceBetween('const WEEKDAYS =', 'const PIN_DATE_GROUP') + '; parseDay');
  const tuesday = new Date(2026, 8, 22, 12);
  const read = (text) => parseDay(text, tuesday);
  assert.deepEqual(['today', 'Tomorrow', 'sunday', 'next Sunday', 'sun', 'tuesday', 'in 3 days', '2w', 'next week'].map(read),
    ['2026-09-22', '2026-09-23', '2026-09-27', '2026-09-27', '2026-09-27', '2026-09-29', '2026-09-25', '2026-10-06', '2026-09-28'],
    'a weekday is the next one after today, so the day it is today reads as a week on; next week is the coming Monday');
  assert.deepEqual(['12 oct', 'oct 12th', '12/10', '12-10-2027', '22 sep', '15 sep', '1 jan', '2026-12-01'].map(read),
    ['2026-10-12', '2026-10-12', '2026-10-12', '2027-10-12', '2026-09-22', '2027-09-15', '2027-01-01', '2026-12-01'],
    'a day and month are read day first, and without a year it is the next time that day comes round');
  assert.deepEqual(['', 'blah', '31/2', '13/13', 'tu'].map(read), [null, null, null, null, null], 'anything that is not a day reads as none');
  assert.equal(parseDay('in 1 month', new Date(2027, 0, 31, 12)), '2027-02-28', 'a month on from the 31st lands on the last day of a shorter month');
  const api = vm.runInNewContext(`
    const calls = [];
    let state = { sidebar: false, dates: [] }, ids = ['doc'];
    let pinInfo = null, pinFailed = null, pinRead = 0, pinnedIds = null, pinnedLoading = null;
    let palDoc = { id: 'doc' }, palMode = 'cmd', palRows = [], palIndex = 3;
    const palette = { hidden: true }, palInput = { value: '', placeholder: '', focus() {} };
    const renderPalette = () => {}, showError = () => {}, run = (fn) => fn();
    const render = () => {}; // the shimmed renderSoon a refreshed mark set asks for
    const tana = {
      pinState: async (id) => { calls.push(['pinState', id]); const st = states.get(id) || state; if (id === 'A' && slowA) { const wait = slowA; slowA = null; await wait; } if (st && st.fail) throw new Error(st.fail); return st; },
      pinIds: async () => { calls.push(['pinIds']); return [...ids]; },
      pin: async (id, target, date) => { calls.push(['pin', id, target, date]); },
      unpin: async (id, target, date) => { calls.push(['unpin', id, target, date]); },
      unpinFrom: async (hubId, id) => { calls.push(['unpinFrom', hubId, id]); },
      searchPreview: async () => [], pinTo: async () => {}, // enough for the meeting row to be offered
    };
    const refreshRelated = (id) => { calls.push(['refreshRelated', id]); };
    const isRealId = (id) => typeof id === 'string';
    let picker = null; // the meeting picker is its own page with its own check; here what matters is what opens it
    let slowA = null; const states = new Map(); // a read of one document that answers late, and answers per document
    const openMeetingPicker = (doc, back) => { picker = { doc: doc.id, back }; };
    ${sourceLine('const localDate =')}
    ${functionSource('fuzzyMatch')}
    ${functionSource('loadPins')}
    ${functionSource('loadPinned')}
    ${functionSource('pinAction')}
    ${functionSource('unpinFromHub')}
    ${sourceBetween('const PIN_GROUP =', 'function openPinsPalette')}
    ${functionSource('openPinsPalette')}
    ({
      open: async (pins, marks) => { state = pins; ids = marks || ids; calls.length = 0; openPinsPalette({ id: 'doc' }); await new Promise(setImmediate); return { palMode, placeholder: palInput.placeholder, hidden: palette.hidden, calls: [...calls] }; },
      page: (q) => editPinRows(q || ''),
      press: async (q, index) => { calls.length = 0; editPinRows(q || '')[index].run(); await new Promise(setImmediate); await new Promise(setImmediate); return [...calls]; },
      marks: () => (pinnedIds ? [...pinnedIds] : null),
      today: () => localDate(),
      tomorrow: () => localDate(1),
      picker: () => (picker ? { doc: picker.doc, back: typeof picker.back } : null),
      escape: () => { picker.back(); return palMode; },
      openFor: (id, answer) => { states.set(id, answer); openPinsPalette({ id }); },
      answer: (next) => { state = next; },
      slow: () => { let go; slowA = new Promise((resolve) => { go = resolve; }); return () => go(); }, // the next read of A answers when released
    });
  `, { setImmediate, Date, Promise });

  const today = api.today();
  const HUBS = [{ id: 'tana:event:m1', title: 'Leadership sync', kind: 'event' }, { id: 'tana:space:s1', title: 'Studio', kind: 'space' }];
  const opened = plain(await api.open({ sidebar: true, dates: [today, '2099-01-01'], hubs: HUBS }, ['doc', 'other']));
  assert.deepEqual([opened.palMode, opened.hidden, opened.placeholder], ['pins', false, 'Edit pins'], 'the page opens in its own mode');
  assert.deepEqual(opened.calls, [['pinIds'], ['pinState', 'doc']], 'it re-reads the marks and asks where this one is pinned');
  assert.deepEqual(plain(api.marks()), ['doc', 'other'], 'the marks every row draws come from that one list');
  assert.deepEqual(plain(api.page().map((r) => [r.icon, r.label, !!r.keepOpen])),
    [['pinned', 'Sidebar', true], ['pinDate', 'Today · ' + today, true], ['pinDate', '2099-01-01', true],
      ['meeting', 'Leadership sync', true], ['space', 'Studio', true], ['pinDate', 'Pin to tomorrow', true], ['meetingPin', 'Pin to meeting …', true]],
    'every pin is a row — sidebar, dates in order with today named, then the meetings and spaces it hangs on — and under them only the pins that can still be made: not today, which is already on, but tomorrow and another meeting');
  assert.deepEqual(plain(api.page().map((r) => r.hint)).slice(3, 5), ['Meeting', 'Space'], 'a hub pin says which kind it is, since its title alone does not');
  assert.deepEqual(plain(api.page().map((r) => r.group)).filter((g, i, all) => all.indexOf(g) === i), ['Pinned · ↩ unpins', 'Pin it'], 'the pins under one header that says what Enter does, what can still be pinned under another');
  assert.deepEqual(plain(api.page('side').map((r) => r.label)), ['Sidebar'], 'one query narrows both halves: the pins it lists and the ones that can still be made');
  assert.deepEqual(plain(await api.press('', 0)), [['unpin', 'doc', 'sidebar', null], ['pinIds'], ['pinState', 'doc']], 'the sidebar row unpins and the page re-reads itself');
  assert.deepEqual(plain(await api.press('', 2)), [['unpin', 'doc', 'today', '2099-01-01'], ['pinIds'], ['pinState', 'doc']], 'and a date row unpins that date, not today');
  // A meeting pin lives on the meeting, so it is taken off with api.unpinFrom and both sidebars are re-read: the
  // item leaves a section of the hub's page as it goes.
  assert.deepEqual(plain(await api.press('', 3)),
    [['unpinFrom', 'tana:event:m1', 'doc'], ['refreshRelated', 'tana:event:m1'], ['refreshRelated', 'doc'], ['pinIds'], ['pinState', 'doc']],
    'the meeting row unpins the document from that meeting');

  const none = plain(await api.open({ sidebar: false, dates: [] }, []));
  assert.equal(none.palMode, 'pins');
  assert.deepEqual(plain(api.page().map((r) => [r.label, !!r.disabled])),
    [['Not pinned anywhere', true], ['Pin to sidebar', false], ['Pin to today', false], ['Pin to tomorrow', false], ['Pin to meeting …', false]], 'a node pinned nowhere says so, and every pin that can be made is offered');
  assert.deepEqual(plain(await api.press('', 1)), [['pin', 'doc', 'sidebar', null], ['pinIds'], ['pinState', 'doc']], 'the sidebar pin is written from this page');
  assert.deepEqual(plain(await api.press('', 3)), [['pin', 'doc', 'today', api.tomorrow()], ['pinIds'], ['pinState', 'doc']], 'and tomorrow is written as that date, the way the ⌘K row does it');
  assert.deepEqual(plain(api.page('nothing here').map((r) => r.label)), ['Not pinned anywhere'], 'a query that matches nothing says so rather than listing rows that do not match it');
  // A meeting pin lives on the meeting's own document, so the page hands that one to the picker ⌘K already opens —
  // and tells it to come back here, rather than to the command page, when Escape leaves it.
  api.page().find((r) => r.label === 'Pin to meeting …').run();
  assert.deepEqual(plain(api.picker()), { doc: 'doc', back: 'function' }, 'the meeting row opens the picker for this document');
  assert.equal(api.escape(), 'pins', 'and escaping the picker comes back to Edit pins');
  assert.match(source, /id: 'editPins'[^}]*'Edit pins'/, 'Cmd+K carries the command that opens it');
  assert.match(source, /palMode === 'pins'/, 'and the palette renders and types in that mode like any other');
  // A read that fails says why on the page, rather than Loading… for as long as the page is open (#394).
  await new Promise(setImmediate); // the page escape reopened has had its answer
  await api.open({ fail: 'Not connected' });
  assert.deepEqual(plain(api.page().map((r) => [r.label, !!r.disabled, !!r.note])), [['Not connected', true, true]], 'a failed read of the pins is the page\u2019s one line');
  // A read for the page before that answers late does not wipe this page's failure back to Loading….
  const resume = api.slow();
  api.openFor('A', { sidebar: false, dates: [] });
  api.openFor('B', { fail: 'Not connected' });
  await new Promise(setImmediate);
  resume();
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.deepEqual(plain(api.page().map((r) => r.label)), ['Not connected'], 'a late answer for another document leaves this one\u2019s failure standing');
  const later = api.slow();
  api.openFor('A', { sidebar: true, dates: [] });
  api.openFor('A', { fail: 'Not connected' });
  await new Promise(setImmediate);
  later();
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.deepEqual(plain(api.page().map((r) => r.label)), ['Not connected'], 'and so does a late answer from an earlier read of the same document: only the latest read counts');
  // A re-read after a pin is written (pinAction) that fails replaces the rows it read before with the failure.
  await api.open({ sidebar: true, dates: [] });
  api.answer({ fail: 'Not connected' });
  await api.press('', 0); // unpins the sidebar, then reads the pins again
  assert.deepEqual(plain(api.page().map((r) => r.label)), ['Not connected'], 'a failed re-read shows the failure, not the pins read before it');
  console.log('ok  Edit pins: the page opens with this document\u2019s pins, names today, unpins each of them, offers the sidebar, date and meeting pins that can be made, and the row marks come from one list');
}

// Link to types lists the workspace's types from one read (renderer/fields.js): while it is out the Type pill's copy,
// or Loading…; a failed read says why rather than Loading… for as long as the page is open (#394).
async function runLinkTargetsLoadCheck() {
  const api = vm.runInNewContext(withShims(`
    let fieldCtx = null, palMode = 'cmd', typeListCache = null, answer = null;
    const openCommandPalette = () => {}, typeGlyph = () => 'type', saveDefinition = () => {};
    let drawn = null; const openFieldPage = (ctx) => { fieldCtx = ctx; palMode = 'field'; drawn = targetRows('').map((r) => r.label); }; // the page draws as it opens
    const tana = { typeList: async () => { if (answer && answer.fail) throw new Error(answer.fail); return answer; } };
    ${functionSource('fuzzyMatch')}
    ${sourceLine('const plainDef =')}
    ${sourceBetween('let targetTypes', 'function targetRows')}
    ${functionSource('targetRows')}
    ({ rows: (q) => targetRows(q).map((r) => r.label),
      open: async (next, cached = null) => { answer = next; typeListCache = cached; openTargetsPage({ def: { title: 'Client', to: [] } }); const first = drawn;
      for (let i = 0; i < 4; i++) await Promise.resolve(); return [first, targetRows('').map((r) => r.label)]; } })
  `), { Promise });
  assert.deepEqual(plain(await api.open([{ uri: 'tana:type:a', title: 'Person' }])), [['Loading…'], ['Person']], 'the page says Loading… until the types are in');
  assert.deepEqual(plain(await api.open([{ uri: 'tana:type:b', title: 'Company' }], [{ uri: 'tana:type:a', title: 'Person' }])), [['Person'], ['Company']], 'the Type pill\u2019s copy shows while the read is out');
  assert.deepEqual(plain(api.rows('zzqx')), ['No types match'], 'a query that matches no type says so: the page is typed, so the palette draws no No results under it');
  assert.deepEqual(plain(await api.open({ fail: 'Not connected' })), [['Loading…'], ['Not connected']], 'and a failed read says why');
  assert.deepEqual(plain(await api.open([{ uri: 'tana:type:b', title: 'Company' }], [{ uri: 'tana:type:a', title: 'Person' }])), [['Person'], ['Company']],
    'reopened after a failure, the page is drawn from the pill\u2019s copy rather than the last failure');
  console.log('ok  Link to types: Loading…, the types, or why they could not be read');
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
  const harness = (searchesLiteral, typesLiteral) => vm.runInNewContext(`
    const calls = [];
    const goTo = (uri) => calls.push(uri);
    const searches = ${searchesLiteral}, typeListCache = ${typesLiteral || "null"}, typeGlyph = (uri) => uri.endsWith("risk") ? "nc-shield" : "type";
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
    const types = paletteRows('').filter((r) => r.group === 'Types');
    ({ rows: rows.map((r) => ({ id: r.id, label: r.label })), open: (i) => { rows[i].run(); return calls; },
       types: types.map((r) => ({ icon: r.icon, hue: r.hue, label: r.label })), openType: (i) => { types[i].run(); return calls; } });
  `);
  // The fixture carries only `title` (no `text`), the shape the in-file mock's info() actually returns
  // (renderer/mock.js), so this also exercises the `s.text || s.title` label fallback, not just the `s.text` path.
  const populated = harness("[{ id: 'tana:search:01j0search0000000000000000', title: 'Weekly review' }]");
  assert.deepEqual(plain(populated.rows), [{ id: 'search:tana:search:01j0search0000000000000000', label: 'Weekly review' }],
    'a saved search is listed under Searches, labelled from the document');
  assert.deepEqual(plain(populated.open(0)), ['tana:search:01j0search0000000000000000'], 'selecting it opens the search document via goTo');

  const empty = harness('[]');
  assert.deepEqual(plain(empty.rows), [], 'no saved searches means no Searches group at all');

  // Every workspace type is a place too: its own glyph, never its hue, and its page on a press.
  const typed = harness('[]', "[{ uri: 'tana:type:risk', title: 'Risk', hue: 20 }, { uri: 'tana:type:note', title: 'Note' }]");
  assert.deepEqual(plain(typed.types), [{ icon: 'nc-shield', label: 'Risk' }, { icon: 'type', label: 'Note' }],
    'each workspace type is a Types row in its own glyph, monochrome');
  assert.deepEqual(plain(typed.openType(0)), ['tana:type:risk'], 'choosing a type opens its page via goTo');
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
  assert.deepEqual(away.map((b) => b.disabled), [true, true], 'with nothing behind or ahead, neither arrow is live, Home or not: Back does not go Home (a whole window, issue #444)');
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
    const railNarrow = () => false; // a pane wide enough for it (renderer/rail.js)
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
  // A saved search is a list: the same anchor keeps it without a sidebar, and so without the button that shows one.
  assert.match(source, /!String\(parent\.docId\)\.startsWith\(SEARCH_ID\) \? parent\.docId : null;/,
    'renderRail gives a saved search no sidebar and no sidebar button');
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
  assert.deepEqual(plain(api.ids()), ['type', 'status', 'assigned', 'audience', 'sort', 'group', 'display'], 'a saved search offers the query pills and the arrangement ones, which it stores in its own document');
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
  const seed = source.match(/if \(savedPlace && isPlaceId\(savedPlace\.docId\)[\s\S]*?\n\}/);
  assert.ok(seed, 'a launch draws the page it is reopening before anything is fetched');
  const api = vm.runInNewContext(`
    const SIDE = ''; // renderer/state.js: a page on its own, not the right half of a split
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
    let asked = 0, added = [];
    const addSearch = (n) => added.push(n.id);
    const tana = { myTasks: () => { asked++; return Promise.resolve({ id: 'tana:search:mine', text: 'My Tasks' }); }, node: () => { fetches++;
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
      firstRight: () => { savedPlace = { myTasks: true }; }, // renderer/edit.js: a first launch's right half
      myTasks: () => ({ asked, added: [...added] }),
      seedPlace: () => { ${seed[0]} },
      clear: () => { storage.delete('place'); savedPlace = readStoredPlace(); },
      firstPaint: () => { zoom = null; rememberPlace(); }, // what the boot render records: the view it drew, with no zoom
      seed: (list) => { docs = list; },
      reset: () => { zoom = null; rendered = 0; fetches = 0; nodeMode = 'auto'; connected = true; extra.clear(); summaries.length = 0; },
      fail: () => { nodeMode = 'fail'; },
      park: () => { nodeMode = 'park'; },
      offline: () => { connected = false; }, online: () => { connected = true; },
      appPage: (id, title) => { extra.set(id, { id, text: title, title, kind: 'document', hasChildren: true, appPage: true }); }, // renderer/timeline.js and friends, at load
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
  assert.equal(api.remember(null), '{}', 'a view with nothing zoomed is a place too: stored as {}, so a reload stays on it instead of opening Home');
  api.remember({ docId: 'tana:text:a', nodeId: null });
  assert.equal(api.remember({ docId: 'draft:7', nodeId: null }), '{}', 'a draft id would mean nothing after a restart, so it stores the view behind it');
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

  // A page of the app's own (Timeline, Notifications, Proposals) is a place too: Cmd+R on it used to land somewhere else,
  // because only a tana: id was remembered. It is known from load, so it reopens without asking Tana for anything.
  api.reset(); api.seed([]); api.appPage('orbital:timeline', 'Timeline');
  assert.equal(JSON.parse(api.remember({ docId: 'orbital:timeline', nodeId: null })).docId, 'orbital:timeline', 'an app page is remembered as the place to reopen');
  api.store(api.remember({ docId: 'orbital:timeline', nodeId: null }));
  api.seedPlace();
  api.appPage('orbital:timeline', 'Timeline'); // in load order: edit.js seeds the stub, renderer/timeline.js then puts its page in its place
  await api.start();
  assert.deepEqual(plain([api.state().docId, api.state().fetches]), ['orbital:timeline', 0], 'and a reload lands back on it, with nothing fetched for a page Tana does not have');

  api.reset(); api.seed([]); api.fail();
  api.store(JSON.stringify({ docId: 'tana:text:gone', nodeId: null, title: 'Deleted since' }));
  api.seedPlace();
  await api.start();
  assert.equal(api.state().docId, null, 'a page deleted since the last session takes its stub down again and the launch lands on the view');

  // A first launch's right half is My Tasks, which has no id until main has found or made it: it asks once connected
  api.reset(); api.seed([]); api.offline(); api.firstRight();
  await api.start();
  assert.deepEqual(plain([api.state().docId, api.myTasks().asked]), [null, 0], 'the right half of a first launch waits for the connection before asking for My Tasks');
  api.online();
  await api.start();
  assert.deepEqual(plain([api.state().docId, api.myTasks()]), ['tana:search:mine', { asked: 1, added: ['tana:search:mine'] }],
    'then opens the search main found or made, listed in Cmd+K at once');
  await api.start();
  assert.equal(api.myTasks().asked, 1, 'once per launch');

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
  assert.match(source, /if \(connected && !wasConnected\) \{ taskMetaFailed\.clear\(\); loadSearches\(\); loadWorkspaceTypes\(\); loadPinned\(true\); restorePlace\(\)\.finally\(\(\) => \{ placed = true; loadView\(\); renderSoon\(\); helpOnce\(\); \}\); \}/,
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
    const NOTE = 'tana:text:01j0note000000000000000000';
    const kids = new Map([[SEARCH, [{ id: TASK, kind: 'document', icon: 'task', text: 'old title', done: 0, stateType: 'proposed' }]],
      ['tana:text:01j0host000000000000000000', [{ id: 'b1', kind: 'block', reference: { uri: NOTE, node: { id: NOTE, kind: 'document', icon: 'doc', text: 'old name', title: 'old name' } } }]]]);
    const extra = new Map(), fresh = new Map(), taskMetaById = new Map(), relatedBy = new Map();
    const railGroups = () => [], localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const isTask = (node) => node.kind === 'document' && node.icon === 'task';
    const asDoc = (node) => ({ ...node, text: node.text ?? node.title ?? '', kind: 'document' });
    let rootsLoads = 0;
    const loadRoots = async () => { rootsLoads++; };
    const tana = { node: async (id) => (id === NOTE ? { id: NOTE, title: 'new name', kind: 'document', icon: 'doc' } : { id: TASK, title: 'new title', kind: 'document', icon: 'task', done: 1, stateType: 'closed' }) };
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
      patchUnlisted: () => patchDoc('tana:text:01j0unlisted00000000000000'),
      patchNote: () => patchDoc(NOTE),
      noteRef: () => kids.get('tana:text:01j0host000000000000000000')[0].reference.node.text,
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
  await context.patchUnlisted();
  assert.equal(context.loads(), 0, 'a document no list shows reloads nothing either: a list it joins is reloaded by the global refresh its live query brings');
  await context.patchNote();
  assert.equal(context.noteRef(), 'new name', 'a rename of a plain document reaches a reference row that draws its title, not only a task (#413)');
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
    const pillCommandRows = () => [], taskActionRows = () => [], searches = [], typeListCache = null, goTo = () => {};
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
    const focusedEl = { el: null }; // where the fake focus is (not the app's focused(), which showPage asks)
    const palText = { name: 'editor', hidden: true, value: '', focus() { focusedEl.el = palText; } };
    const palList = { name: 'rows', tabIndex: 0, focus() { focusedEl.el = palList; }, querySelectorAll: () => [] };
    const document_activeElement = () => focusedEl.el;
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
    const document = { documentElement: { dataset: {} }, get activeElement() { return focusedEl.el; }, createElement: (tagName) => ({ tagName, attrs: {}, children: [], className: '',
      setAttribute(name, value) { this.attrs[name] = value; }, append(...kids) { this.children.push(...kids); } }) };
    const views = [], pinRows = () => [], selectionRows = () => [];
    const pillCommandRows = () => [], searches = [], typeListCache = null, goTo = () => {};
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
    ${functionSource('movePalIndex')}
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
      where: () => (focusedEl.el ? focusedEl.el.name : null),
      tab: () => { palRows = agentPromptRows(); agentPromptKey(key('Tab')); return { focus: focusedEl.el && focusedEl.el.name, group: palRows[palIndex] && palRows[palIndex].group, label: palRows[palIndex] && palRows[palIndex].label }; },
      rows: (name) => { const handled = agentRowsKey(key(name)); return { handled, focus: focusedEl.el && focusedEl.el.name, label: palRows[palIndex] && palRows[palIndex].label, model: agentModel }; },
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
// ---- every page with pills folds them away behind the header button (renderer/pills.js) ----
// Two things here are worth a check rather than an eye: the row may only go once the last pill has finished leaving,
// and unsaved edits have to hold it open whatever the button was last set to, or Save would be out of reach.
function runPillsFoldCheck() {
  const api = vm.runInNewContext(`
    let dirty = false, redrawn = 0, reduced = false, page = 'tana:search:x';
    const pillKey = () => page, onSearchPage = () => page.startsWith('tana:search:'), onTypePage = () => page.startsWith('tana:type:');
    const log = [];
    const matchMedia = (query) => ({ matches: reduced && query.includes('reduce') });
    const mkEl = (id) => {
      const classes = new Set(), handlers = [];
      return { id, hidden: false, childNodes: [], children: [], attrs: {}, dataset: {}, style: { setProperty() {} },
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
    const $ = (id) => (id === 'pills' ? box : id === 'navCleanup' ? cleanupEl : toggleEl);
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
      setPage: (value) => { page = value; },
    });
  `);
  assert.equal(api.open(), false, 'a saved search opens with its pills folded away: the query is already its title');
  assert.equal(plain(api.toggleFor(true)).label, 'Show view options', 'and the button beside back and forward says what it will do');
  assert.equal(plain(api.toggleFor(false)).button, true, 'a page without pills has nothing to fold, so the button is not there');
  api.setPage('tana:type:x');
  assert.equal(api.open(), false, 'a type page opens with its pills folded too');
  api.setPage('library');
  assert.equal(api.open(), true, 'a view opens with its pills shown: they are how it is aimed');
  assert.equal(api.press().shown, false, 'and the button folds them there as well');
  api.setPage('inbox');
  assert.equal(api.open(), true, 'each page keeps its own choice, so folding the Library leaves the Inbox as it was');
  api.setPage('library');
  assert.equal(api.open(), false, 'and the Library stays folded when you come back to it');
  api.press();
  api.setPage('tana:search:x');
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
  assert.deepEqual(plain(api.toggleFor(true)).stored.openPills, { library: true, 'tana:search:x': false }, 'the choice is a preference, so it follows you between machines');
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
  { // cleanupEl
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
    const $ = () => button;
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
  const makeHarness = (delayed = false) => {
    let release;
    const context = { creationGate: delayed ? new Promise((resolve) => { release = resolve; }) : Promise.resolve() };
    vm.runInNewContext(`
    const SIDE = ''; // renderer/state.js: a page on its own, not the right half of a split
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
      const markFalling = () => {}, refreshRowChrome = () => {}, renderPills = () => {}, $ = () => ({ hidden: true });
      const showError = () => {}, flush = () => {};
      const run = (fn) => fn();
      const tana = { createDocument: async (title, opts) => { created.push([title, opts.kind]); await creationGate; return { id: 'tana:text:01j0made00000000000000000', title, icon: 'task', done: 0 }; } };
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
      const addSearch = () => {}; // searches made here (#141) have their own check
    ${functionSource('materialise')}
      ${sourceBetween("titleEl.addEventListener('input'", "titleEl.addEventListener('keydown'")}
      Object.assign(globalThis, {
        redraw: () => render(true),
        create: () => startCreation({ id: 'task', kind: 'task', title: 'Task', icon: 'task', selectable: true }),
        type: (text) => { if (document.activeElement !== titleEl) return false; titleEl.textContent += text; listeners.input(); return true; },
        leave: () => { document.activeElement = null; listeners.blur(); },
        state: () => ({ title: titleEl.textContent, renders, deferred: renderDeferred, titleKey: titleEl.dataset.key, caretInTitle: document.activeElement === titleEl,
          created, saved, fresh: [...fresh.keys()],
          rows: views[0].nodes.map((n) => ({ id: n.id, text: n.text || '', draft: !!n.draft })) }),
      });
    `, context);
    context.release = release;
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

  const delayed = makeHarness(true);
  delayed.create();
  delayed.type('S');
  delayed.redraw();
  assert.equal(delayed.state().title, 'S', 'a forced live redraw preserves the first character while creation is pending');
  delayed.type('hip');
  delayed.redraw();
  assert.equal(delayed.state().title, 'Ship', 'subsequent draft keystrokes survive another forced redraw');
  delayed.release();
  await new Promise(setImmediate);
  assert.deepEqual(plain(delayed.state()).created, [['S', 'task']], 'redrawing the draft does not create it twice');
  assert.deepEqual(plain(delayed.state()).saved, [['tana:text:01j0made00000000000000000', [{ text: 'Ship' }]]],
    'all characters typed during creation are saved to the real document');

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
    let releases = 0; const releasedDocs = new Map(), releasedSince = () => false; // what main let go of (app.js forgetReleased): nothing, here
    const asked = [], relatedBy = new Map();
    const relatedStale = new Set();
    let connected = false;
    const renderSoon = () => {};
    const queryRow = () => null, CSS = { escape: (id) => id }, selectionFrozen = false;
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
    const tana = { related: async (id) => { asked.push(id); return { pinned: [] }; } };
    ${functionSource('loadRelated')}
    ${functionSource('refreshRelated')}
    Object.assign(globalThis, { ask: (id) => loadRelated(id), refresh: (id, always) => refreshRelated(id, always), connect: () => { connected = true; },
      state: () => ({ asked, cached: [...relatedBy.keys()], payload: relatedBy.get('tana:text:01j0task0000000000000000') || null }) });
  `, context);
  context.ask('tana:text:01j0task0000000000000000');
  assert.deepEqual(plain(context.state()), { asked: [], cached: [], payload: null }, 'the rail asks nothing before the sync client is up');

  // The sidebar kept live (renderer/rail.js watchRail, issue #21): main is told which page the sidebar is for, once,
  // after the connection, again when it refused, null when there is no page; and what it pushes re-reads that page.
  const live = {};
  vm.runInNewContext(`
    const calls = [], refreshed = [];
    let connected = false, answer = false, listener = null;
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
    const refreshRelated = (id) => refreshed.push(id);
    const tana = { relatedWatch: async (id) => { calls.push(id); return id ? answer : false; }, onRelatedChanged: (fn) => { listener = fn; } };
    ${sourceBetween('let railWatched = null', 'function railRow(')}
    Object.assign(globalThis, { watch: (id) => watchRail(id), connect: () => { connected = true; }, accept: () => { answer = true; }, push: (id) => listener(id),
      state: () => ({ calls, refreshed }) });
  `, live);
  const P1 = 'tana:text:01j0page1000000000000000', P2 = 'tana:text:01j0page2000000000000000';
  live.watch(P1);
  assert.deepEqual(plain(live.state().calls), [], 'nothing is watched before the connection');
  live.connect();
  live.watch(P1); await new Promise(setImmediate);
  live.watch(P1); await new Promise(setImmediate);
  assert.deepEqual(plain(live.state().calls), [P1, P1], 'a refusal is asked again at the next render');
  live.accept();
  live.watch(P1); await new Promise(setImmediate);
  live.watch(P1); live.watch('draftdoc:3'); live.watch(P2); await new Promise(setImmediate);
  live.watch(P2); live.watch(null); live.watch(null);
  assert.deepEqual(plain(live.state().calls), [P1, P1, P1, null, P2, null], 'once taken, once per page; a draft is no page; null once when the page goes');
  live.push(P2);
  assert.deepEqual(plain(live.state().refreshed), [P2], 'a push re-reads that page\'s sidebar');
  context.connect();
  context.ask('draftdoc:2');
  assert.deepEqual(plain(context.state().asked), [], 'and never about a local draft id');
  // A change to a document whose sidebar this page never read (every document a view subscribes announces its first
  // bootstrap as one) asks nothing: at boot that was 188 related reads, ~700 ListNodes, before anything was opened.
  context.refresh('tana:text:01j0never00000000000000000');
  assert.deepEqual(plain(context.state().asked), [], 'a change re-reads only a sidebar this page has read');
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
  // main's push is about the page on screen, whose first read may have failed and left nothing cached: it reads anyway
  context.refresh('tana:text:01j0never00000000000000000', true);
  await new Promise(setImmediate);
  assert.ok(context.state().asked.includes('tana:text:01j0never00000000000000000'), 'a push about the watched page reads it even with nothing cached');
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
    const keyOfEl = () => item.key, imageFiles = () => [];
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
        handler({ target: { closest: () => el }, clipboardData: { getData: () => text, files: [] }, preventDefault: () => { prevented = true; } });
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

// A pasted image (#28): uploaded through the bridge and inserted after the row it was pasted into, several in
// clipboard order; from the empty draft row after the last real row; never from an empty child row, and a
// clipboard without an image pastes as before.
async function runPasteImageCheck() {
  const segments = sourceBetween('// accepts segments, a plain string, or a Node', 'const tana = window.api');
  const upload = fs.readFileSync(require.resolve('../renderer/upload.js'), 'utf8');
  const context = { setImmediate };
  vm.runInNewContext(`
    ${FAKE_DOM}
    ${segments}
    const DOC = 'tana:text:01j0doc000000000000000000';
    const page = { key: DOC, docId: DOC, node: { id: DOC, kind: 'document' } };
    const rows = [{ id: 'r1', kind: 'block' }, { id: 'r2', kind: 'block' }];
    const kids = new Map([[DOC, rows]]);
    const real = { key: DOC + '/r1', docId: DOC, node: rows[0], parent: page };
    const draft = { key: DOC + '/draft:1', docId: DOC, node: { id: 'draft:1', kind: 'block', text: '', draft: true }, parent: page };
    const child = { key: DOC + '/draft:2', docId: DOC, node: { id: 'draft:2', kind: 'block', text: '', draft: true }, parent: real };
    const items = new Map([real, draft, child].map((i) => [i.key, i]));
    const calls = [], errors = [], flushed = [], carets = [], cancelled = [], read = [];
    let target = real, prevented = false, renders = 0, fail = null, handler = null;
    const outline = { addEventListener: (name, fn) => { if (name === 'paste') handler = fn; } };
    const el = document.createElement('div');
    document.activeElement = null;
    const keyOfEl = () => target.key, inRows = () => false, keyFor = (d, n) => d + '/' + n.id;
    const canEditText = () => true, isAtomic = () => false, isReference = () => false;
    const flush = (key) => flushed.push(key);
    const render = () => { renders++; };
    const moveTo = () => {};
    const placeCaret = (key) => carets.push(key);
    const reload = async (docId) => { calls.push(['reload', docId]); syncUploads(docId); };
    const showError = (e) => { errors.push(String(e && e.message || e)); };
    const childrenOf = (i) => (i.node.kind === 'document' ? rows : i.node.children || []);
    let n = 0;
    const tana = {
      node: async () => { throw new Error('no link here'); },
      insertImage: async (docId, after, file, uploadId) => {
        calls.push(['insertImage', docId, after, { bytes: Array.from(file.bytes), filename: file.filename, mimeType: file.mimeType }]);
        await new Promise(setImmediate);
        if (cancelled.includes(uploadId)) throw new Error('upload cancelled');
        if (fail === file.filename) throw new Error('upload ' + fail + ': Unsupported file');
        return 'img' + (++n);
      },
      cancelUpload: (id) => { cancelled.push(id); },
    };
    const file = (name, type, size = 2) => ({ name, type, size, arrayBuffer: async () => { read.push(name); return new Uint8Array([1, 2]).buffer; } });
    ${upload}
    ${sourceBetween("onRows('paste'", "onRows('focusout'")}
    Object.assign(globalThis, {
      paste: (on, files, failing = null) => {
        target = { real, draft, child }[on]; prevented = false; fail = failing;
        for (const a of [calls, errors, carets, read]) a.length = 0;
        handler({ target: { closest: () => el }, clipboardData: { getData: () => '', files: files.map((f) => file(...f)) }, preventDefault: () => { prevented = true; } });
        return prevented;
      },
      cancel: (i) => { const node = rows.filter((r) => r.upload)[i]; cancelUpload({ node, docId: DOC }, el); },
      state: () => ({ calls, errors, renders, flushed, carets, cancelled, read, rows: rows.map((r) => (r.upload ? 'up:' + r.text : r.id)) }),
    });
  `, context);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };
  const DOC = 'tana:text:01j0doc000000000000000000', png = { bytes: [1, 2], filename: 'a.png', mimeType: 'image/png' };
  const uploaded = () => plain(context.state()).calls.filter((c) => c[0] === 'insertImage');

  assert.equal(context.paste('real', [['a.png', 'image/png'], ['b.gif', 'image/gif']]), true, 'an image paste is taken over');
  assert.deepEqual(plain(context.state()).rows, ['r1', 'up:a.png', 'up:b.gif', 'r2'], 'a placeholder for each file shows at once, behind the row, in clipboard order');
  await settle();
  let s = plain(context.state());
  assert.deepEqual(s.calls, [
    ['insertImage', DOC, 'r1', png], ['reload', DOC],
    ['insertImage', DOC, 'img1', { ...png, filename: 'b.gif', mimeType: 'image/gif' }], ['reload', DOC],
  ], 'one at a time: each image after the row, the second after the first, each swapped in as it lands');
  assert.deepEqual([s.rows, s.flushed, s.carets], [['r1', 'r2'], [DOC + '/r1'], [DOC + '/img2']], 'the placeholders are gone, a pending edit was saved first, and the caret is on the last image');

  assert.equal(context.paste('draft', [['a.png', 'image/png']]), true);
  await settle();
  assert.deepEqual(uploaded()[0], ['insertImage', DOC, 'r2', png], 'from the empty draft row it lands after the last real row, where the draft stands');

  assert.equal(context.paste('child', [['a.png', 'image/png']]), false, 'an empty child row has no row to follow: nothing is taken over');
  assert.equal(context.paste('real', [['a.pdf', 'application/pdf']]), false, 'a clipboard without an image pastes as before');
  assert.equal(context.paste('real', [['shot.HEIC', '']]), true, 'a Tana image extension counts without a type');
  await settle();
  assert.equal(uploaded()[0][3].filename, 'shot.HEIC');

  context.paste('real', [['a.png', 'image/png'], ['b.png', 'image/png']], 'a.png');
  await settle();
  s = plain(context.state());
  assert.deepEqual([s.errors, uploaded().map((c) => c[2]), s.rows], [['upload a.png: Unsupported file'], ['r1', 'r1'], ['r1', 'r2']],
    'a refused upload shows its reason, writes nothing, and the next file still goes, behind the same row');

  context.paste('real', [['big.png', 'image/png', 52428801], ['a.png', 'image/png']]);
  await settle();
  s = plain(context.state());
  assert.deepEqual([s.errors, s.read, uploaded().length], [['File is too large (max 50 MB)'], ['a.png'], 1], 'over 50 MB is refused before its bytes are read');

  context.paste('real', [['a.png', 'image/png'], ['b.png', 'image/png']]);
  context.cancel(1);
  assert.deepEqual(plain(context.state()).rows, ['r1', 'up:a.png', 'r2'], 'Esc takes its placeholder away at once');
  await settle();
  assert.deepEqual([uploaded().length, plain(context.state()).errors], [1, []], 'a file cancelled before its turn is never sent');

  context.paste('real', [['a.png', 'image/png']]);
  for (let i = 0; i < 6 && !uploaded().length; i++) await new Promise(setImmediate);
  context.cancel(0);
  await settle();
  s = plain(context.state());
  assert.deepEqual([s.cancelled.length, s.errors, s.carets, s.rows], [2, [], [], ['r1', 'r2']], 'a running upload is aborted in main, quietly, and the caret stays put');
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
      const keyOfEl = () => item.key, imageFiles = () => [];
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
      const addSearch = () => {}; // searches made here (#141) have their own check
    ${functionSource('materialise')}
      ${functionSource('linkTo')}
      ${sourceBetween("onRows('paste'", "onRows('focusout'")}
      Object.assign(globalThis, {
        paste: (text) => {
          prevented = false;
          handler({ target: { closest: () => el }, clipboardData: { getData: () => text, files: [] }, preventDefault: () => { prevented = true; } });
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
  const homeInit = source.match(/let home = pref\('home', 'workView'\);/)[0];
  const seed = source.match(/if \(!savedPlace\) savedPlace = SIDE [^\n]*/)[0];
  const api = vm.runInNewContext(FAKE_DOM + `
    const SIDE = ''; // renderer/state.js: a page on its own, not the right half of a split
    const stored = {};
    const localStorage = { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = v; }, removeItem: (k) => { delete stored[k]; } };
    const prefs = {}; const pref = (k, fb) => (k in prefs ? prefs[k] : fb); const setPref = (k, v) => { prefs[k] = v; stored[k] = v; };
    ${homeInit}
    let view = 'library', zoom = null, searches = [], typeListCache = null, searchesLoaded = false, connected = true, went = [], renders = 0;
    let navBack = [], navForward = [], navHere = null, navigating = false, caretOnOpen = false, savedPlace = null;
    const SEARCH_ID = 'tana:search:';
    const TIMELINE_PAGE = 'orbital:timeline', run = (fn) => fn(), openWorkView = () => { went.push('workView'); }; // renderer/timeline.js
    const WORK_VIEW = { id: 'workView', name: 'Work View', doc: 'workView', keys: {} }; // renderer/timeline.js
    let savedList = [], opened = null; const savedViews = () => (savedList.some((v) => v.id === WORK_VIEW.id) ? savedList : [WORK_VIEW, ...savedList]), openSavedView = (v) => { opened = v; went.push('view ' + v.name); }; // renderer/palette.js
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
    const onSearchPage = () => !!zoom && !zoom.nodeId && String(zoom.docId || '').startsWith(SEARCH_ID);
    const render = () => { renders++; }, renderSoon = render, flushAll = () => {}, dropDrafts = () => {};
    const goTo = (id) => { went.push(id); zoom = { docId: id, nodeId: null }; };
    const setView = (id) => { went.push('view:' + id); view = id; zoom = null; };
    const iconNode = (icon) => { const el = document.createElement('svg'); el.dataset.icon = icon; return el; };
    let listed = [];
    const tana = { searches: () => Promise.resolve(listed) };
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    const bar = document.createElement('nav');
    const $ = (id) => (id === 'crumbs' ? bar : null);
    const blurSensitive = () => {}, iconSvg = () => '', zoomTo = () => {};
    const viewOf = () => ({ title: 'Library' }), docOf = () => null;
    const OTHER_DOC = 'tana:text:01j0note0000000000000000';
    ${functionSource('navigate')}
    ${functionSource('loadSearches')}
    ({
      id: () => homeId(), name: () => homeName(), at: () => atHome(), views: (list) => { savedList = list; },
      stored: () => ({ ...stored }), set: (id) => setHome(id), went: () => { const out = [...went]; went.length = 0; return out; },
      list: (rows, online = true) => { listed = rows; connected = online; return loadSearches(); },
      drop: (id) => { searches = searches.filter((s) => s.id !== id); repairHome(); },
      go: (place) => { zoom = place; }, view: (id) => { view = id; zoom = null; },
      home: () => goHome(), opened: () => opened && opened.keys,
      back: () => navigate(-1), push: (place) => { navBack.push(place); navHere = { view, zoom, key: 'here' }; },
      seed: (place) => { savedPlace = place; ${seed} return savedPlace; },
    });
  `);

  const SEARCH = 'tana:search:01j0myt00000000000000000', OTHER = 'tana:text:01j0note0000000000000000';
  // Nothing chosen: the Work View, and nothing written to say so
  assert.deepEqual([api.id(), api.name(), plain(api.stored())], ['workView', 'Work View', {}], 'with no preference Home is the Work View, and nothing is stored until something is chosen');
  api.home();
  assert.deepEqual(plain(api.went()), ['workView'], 'going Home opens the Work View, as its Cmd+K row does');
  api.go({ docId: 'orbital:timeline', nodeId: null });
  assert.equal(api.at(), true, 'and the left half is Home on the Timeline');
  api.go({ docId: OTHER, nodeId: null });
  assert.equal(api.at(), false, 'and not anywhere else');
  // The Work View updated from Save view is judged by the place it now keeps for this page
  api.views([{ id: 'workView', name: 'Work View', doc: { schema: 1 }, keys: { place: JSON.stringify({ docId: OTHER, nodeId: null }) } }]);
  assert.equal(api.at(), true, 'an updated Work View is Home on the place it keeps');
  api.go({ docId: 'orbital:timeline', nodeId: null });
  assert.equal(api.at(), false, 'and no longer on the Timeline it replaced');
  api.views([]);
  api.view('library');
  await api.list([{ id: SEARCH, text: 'My Tasks' }]);
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

  api.go({ docId: OTHER, nodeId: null });

  // Back with nothing to go back to stays put: one pane's Back must not replace the whole window with Home
  api.back();
  assert.deepEqual(plain(api.went()), [], 'Back from a note with no history does nothing');
  api.go({ docId: OTHER, nodeId: null });
  api.push({ view: 'inbox', zoom: null, key: 'inbox' });
  api.back();
  assert.deepEqual(plain(api.went()), [], 'with a real prior place, Back is the history it always was');

  // A first launch (nothing stored) opens on the Work View's Timeline, whatever Home is; an explicit place wins
  const TIMELINE = { docId: 'orbital:timeline', nodeId: null, title: 'Timeline', icon: 'timeline' };
  assert.deepEqual(plain(api.seed(null)), TIMELINE, 'a launch with no place to restore opens the Work View: the Timeline in the left half');
  assert.deepEqual(plain(api.seed({ docId: OTHER, nodeId: null })), { docId: OTHER, nodeId: null }, 'and a place to restore is left alone');
  assert.deepEqual(plain(api.seed({})), {}, 'and a view left unzoomed (the Library, Types) reopens as that view, not Home');

  // A saved-search Home chosen before Home was a window opens as one: a window of one pane on that search
  api.view('library');
  api.home();
  assert.deepEqual([plain(api.went()), plain(api.opened())], [['view Everything of mine'], { view: 'library', place: JSON.stringify({ docId: SEARCH, nodeId: null }) }],
    'a saved-search Home is a window of one pane on that search, like every Home');

  // Gone: repaired to the Library rather than left pointing at something nothing can open
  api.drop(SEARCH);
  assert.deepEqual([api.id(), api.name(), api.stored().home], ['library', 'Library', 'library'],
    'a deleted Home falls back to the Library and the stale preference is repaired, not left behind');
  api.view('library');
  assert.deepEqual(plain(api.seed(null)), TIMELINE, 'a Library Home changes nothing about a first launch either');
  api.view('inbox');
  api.home();
  assert.deepEqual([plain(api.went()), plain(api.opened())], [['view Library'], { view: 'library', place: '{}' }], 'and once it has fallen back, Home is a window on the Library view — no dead saved search is opened');

  // Set as Home keeps the window as it is: the saved view 'homeView', opened as saved views are; a page is Home on the
  // place that view keeps for it; removed from the list, Home is the Work View again
  api.views([{ id: 'homeView', name: 'Home', doc: null, keys: { place: JSON.stringify({ docId: OTHER, nodeId: null }), view: 'library' } }]);
  api.set('homeView');
  assert.deepEqual([api.id(), api.name()], ['homeView', 'Home'], 'Home reads as the window kept');
  api.go({ docId: OTHER, nodeId: null });
  assert.equal(api.at(), true, 'a page on the place Home keeps for it is Home');
  api.go({ docId: SEARCH, nodeId: null });
  assert.equal(api.at(), false, 'and anywhere else it is not');
  api.home();
  assert.deepEqual(plain(api.went()), ['view Home'], 'going Home opens the window it keeps');
  api.views([]);
  assert.deepEqual([api.id(), api.name()], ['workView', 'Work View'], 'a Home window removed from the list leaves the Work View as Home');
}


// A reload used to leave every linked task grey: the status read was gated on the set of assigned ids, which is
// filled asynchronously and is still empty when the first load runs. Main knows the links; the renderer must ask.
function runAgentStatusBootCheck() {
  // Asked at boot, not per list reload: reloads come in bursts, and each status read starts a Codex app-server child
  assert.match(source, /^loadAgentStates\(\);/m, 'the page asks what each linked Codex task is doing once as it loads');
  assert.doesNotMatch(functionSource('loadRoots'), /loadAgentStates/, 'and a reload of the lists does not ask again');
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
  assert.match(keydown, /e\.key === 'Backspace' && off === 0 && collapsed\) \{\s*e\.preventDefault\(\);\s*if \(isDoc \|\| unbullet\(item\)\) return;\s*if \(len === 0\) removeNode\(item, el\); else removeEmptyAbove\(item, el\) \|\| joinAbove\(item, el\);/,
    'Backspace at the start of a row unbullets it, then removes the row when it is empty, then the empty row above it, and otherwise joins its words to the row above');
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


// Backspace at the start of a row with words in it joins them to the row above (#125): the reverse of Enter
// mid-text, one write in main, and the caret where the two meet.
async function runJoinAboveCheck() {
  const api = vm.runInNewContext(`
    const calls = [];
    let rows = [], editable = true;
    const items = new Map();
    const rowsBeside = () => rows.slice();
    const keyOfEl = (el) => el.key;
    const isAtomic = (n) => n.type === 'image' || n.block === 'divider' || !!n.table;
    const isReference = (n) => n.type === 'reference';
    const hasKids = (item) => !!(item.node.children && item.node.children.length);
    const canEditItem = () => editable;
    const readSegs = (el) => el.segs;
    const plainOf = (segs) => segs.map((s) => ('text' in s ? s.text : s.mention.label)).join('');
    const saveValue = (segs) => segs;
    const dropPending = (key) => calls.push(['dropPending', key]);
    const render = () => calls.push(['render']);
    const reload = async (docId) => { calls.push(['reload', docId]); };
    const placeCaret = (key, offset) => calls.push(['caret', key, offset]);
    const run = async (fn) => fn();
    const tana = { join: async (docId, id, intoId, value) => calls.push(['join', docId, id, intoId, value]) };
    ${functionSource('joinAbove')}
    ({
      press: async (above, cur = {}, canEdit = true) => {
        calls.length = 0; editable = canEdit; rows = []; items.clear();
        if (above) {
          const item = { key: 'doc/a', docId: above.docId || 'doc', node: { id: 'a', kind: 'block', ...above.node } };
          items.set('doc/a', item); rows.push({ key: 'doc/a', segs: [{ text: 'Discuss with ' }] });
        }
        const item = { key: 'doc/b', docId: 'doc', node: { id: 'b', kind: 'block', ...cur } };
        const el = { key: 'doc/b', segs: [{ mention: { uri: 'tana:user-profile:stan', label: 'Stan' } }, { text: ' and Peter' }] };
        items.set('doc/b', item); rows.push(el);
        const took = joinAbove(item, el);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        return { took, calls: calls.slice() };
      },
    });
  `);
  assert.deepEqual(plain(await api.press({})), { took: true, calls: [['dropPending', 'doc/b'], ['dropPending', 'doc/a'],
    ['join', 'doc', 'b', 'a', [{ text: 'Discuss with ' }, { mention: { uri: 'tana:user-profile:stan', label: 'Stan' } }, { text: ' and Peter' }]],
    ['reload', 'doc'], ['render'], ['caret', 'doc/a', 13]] },
    'the words join the row above in one write, the mention with them, and the caret lands where the two meet');
  for (const [above, cur, why] of [
    [null, {}, 'the first row has nothing above it'],
    [{}, { children: [{ id: 'c' }] }, 'a row with children stays: joining would have to move them'],
    [{}, { hasChildren: true }, 'children that are not loaded yet count too'],
    [{ node: { type: 'image' } }, {}, 'an image takes no words'],
    [{ node: { block: 'divider' } }, {}, 'nor does a divider'],
    [{ node: { table: {} } }, {}, 'nor a table'],
    [{ node: { type: 'reference' } }, {}, 'a reference stands for another node'],
    [{ node: { draft: true } }, {}, 'a draft row above is not in Tana yet'],
    [{}, { draft: true }, 'and neither is a draft row being typed in'],
    [{ node: { kind: 'document' } }, {}, 'a document row is not a block'],
    [{ docId: 'tana:text:other' }, {}, 'a row an opened reference borrows belongs to another document'],
  ]) assert.deepEqual(plain(await api.press(above, cur)), { took: false, calls: [] }, why);
  assert.deepEqual(plain(await api.press({}, {}, false)), { took: false, calls: [] }, 'a read-only row is left alone');
  console.log('ok  Backspace join: a row\u2019s words join the row above in one write, the caret at the seam; rows with children, atomic rows, drafts and borrowed rows stay');
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

// Another page stored a view filter, a watch choice or an agent mark (main/settings.js tellOthers): this page's copies
// follow. A page left with the old filter drew stale pills and wrote that filter back over the new one with its next pill.
async function runSettingsElsewhereCheck() {
  const api = vm.runInNewContext(`
    let handler = null, home = null, themePref = 'light', sensitiveLoading = null, mcpHidden = false, codexLoading = null, zoom = null, view = 'library';
    let listed = 0, codexReads = 0, stateReads = 0, stored = {}, codexIds = new Set(), marks = [], hosts = {};
    const agentTaskHosts = new Map();
    const tana = { onSettings: (cb) => { handler = cb; }, viewFilter: async (id) => stored[id], codexTaskHosts: async () => hosts };
    const views = [{ id: 'library' }, { id: 'inbox' }];
    const filters = new Map([['library', { states: ['open'] }], ['inbox', { states: ['proposed'] }]]);
    const notifyById = new Map([['tana:text:a', { on: false }]]);
    const hotkeys = {}, groupPref = {}, sortPref = {}, displayPref = {}, collapsedGroups = new Set(), SEARCH_ID = 'tana:search:';
    const onTypePage = () => false, isTypeId = () => false, typeFilter = () => ({}), reload = async () => {}, mergePrefs = () => {}, pref = (k, d) => d;
    const renderSoon = () => {}, showError = (e) => { throw e; }, showTheme = () => {}, loadSensitive = async () => {}, refreshSensitive = () => {};
    const widenFilter = (id, f) => f, loadView = () => { listed++; };
    let railHidden = false; const railClosed = new Set(); // the sidebar's, which applySettings reads again too
    const loadCodex = () => { codexReads++; codexIds = new Set(marks); return (codexLoading = Promise.resolve()); };
    const loadAgentStates = () => { stateReads++; agentTaskHosts.clear(); for (const [id, host] of Object.entries(hosts)) agentTaskHosts.set(id, host); };
    ${functionSource('loadFilters')}
    ${functionSource('applySettings')} // the handler is a named function since the page also calls it after catchUpSettings
    ${sourceBetween('if (tana.onSettings) tana.onSettings(', 'if (tana.onSystemTheme)')}
    ({
      change: async (next, agents = marks, tasks = hosts) => { stored = next; marks = agents; hosts = tasks; handler({}); for (let i = 0; i < 8; i++) await Promise.resolve(); },
      state: () => ({ library: filters.get('library'), listed, codexReads, stateReads, watch: notifyById.size }),
    });
  `);
  await api.change({ library: { states: ['closed'] }, inbox: { states: ['proposed'] } }, ['tana:text:a']);
  assert.deepEqual(plain(api.state()), { library: { states: ['closed'] }, listed: 1, codexReads: 1, stateReads: 1, watch: 0 },
    'the filter another page stored replaces this page’s copy and lists the view again; the agent marks, a new mark’s task state and the watch states are read afresh');
  await api.change({ library: { states: ['closed'] }, inbox: { states: ['proposed'] } });
  assert.deepEqual([api.state().listed, api.state().stateReads], [1, 1], 'a settings change that leaves this view’s filter and the marks alone lists nothing and starts no Codex read');
  // Another machine writes the mark first and the task it became later: the second change moves only the task
  await api.change({ library: { states: ['closed'] }, inbox: { states: ['proposed'] } }, ['tana:text:a'], { 'tana:text:a': 'local' });
  assert.equal(api.state().stateReads, 2, 'a task that arrives after its mark reads the state again');
  console.log('ok  settings from another page: view filters, agent marks and watch states follow, and the view is listed again only when its filter moved');
}

// A saved search re-read from its stored query (a global change, a return, Clean up, its live query) while the pills
// get staged: the preview installs its rows first, and the stored answer landing after must not replace them.
async function runStagedSearchReloadCheck() {
  const api = vm.runInNewContext(`
    const TIMELINE_PAGE = 'orbital:timeline', SEARCH_ID = 'tana:search:'; let timelinePartial = false;
    const kids = new Map(), searchRows = new Map(), filters = new Map(), searchFilters = new Map();
    const errors = [], isTypeId = (id) => String(id).startsWith('tana:type:'), syncUploads = (id, rows) => rows, render = () => {}, showError = (e) => errors.push(String(e.message || e));
    const typeFilter = (id) => { if (!filters.has(id)) filters.set(id, { types: [id] }); return filters.get(id); };
    const sameFilter = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const answers = []; // every read still out, stored query or preview, in the order it was asked
    const ask = () => new Promise((resolve) => answers.push(resolve));
    const tana = { children: ask, searchPreview: ask };
    let releases = 0; const releasedDocs = new Map(), renderSoon = () => {}; // what main let go of (app.js forgetReleased): nothing, here
    ${sourceBetween('const reloadSeq =', 'async function reload(')}
    ${functionSource('reload')}
    ${functionSource('previewRows')}
    ({
      reload,
      stage: (id, states = ['closed']) => { searchFilters.set(id, { filter: { states: ['open'] } }); filters.set(id, { states }); searchRows.delete(id); previewRows(id); },
      save: (id) => { searchFilters.set(id, { filter: { states: ['closed'] } }); searchRows.delete(id); return reload(id); }, // what Save does (renderer/pills.js)
      answer: async (i, rows) => { answers[i](rows); for (let n = 0; n < 5; n++) await Promise.resolve(); },
      rows: (id) => kids.get(id),
      staged: (id) => searchRows.has(id),
      unstage: (id) => { searchRows.delete(id); filters.set(id, searchFilters.get(id).filter); },
      errors: () => errors.splice(0),
    });
  `);
  const id = 'tana:search:01j0staged000000000000000';
  const old = api.reload(id); // 0
  api.stage(id); await api.answer(1, ['preview']);
  await api.answer(0, ['old']); await old;
  assert.deepEqual(plain(api.rows(id)), ['preview'], 'a stored-query answer that lands after the pills were staged leaves the preview rows');
  // Clean, staged, saved: the page is clean again when the first read lands, and that read is still from before the Save
  const other = 'tana:search:01j0saved0000000000000000';
  const before = api.reload(other); // 2
  api.stage(other); await api.answer(3, ['preview']);
  const saved = api.save(other); // 4
  await api.answer(4, ['saved']); await saved; await api.answer(2, ['before the save']); await before;
  assert.deepEqual(plain(api.rows(other)), ['saved'], 'and a read from before a Save that lands after it does not put the old rows back');
  // A preview asked again (a global change) while the first is out: the first answer, landing last, is not the page's
  const third = 'tana:search:01j0twice0000000000000000';
  api.stage(third); api.stage(third); // 5, 6
  await api.answer(6, ['fresh preview']); await api.answer(5, ['stale preview']);
  assert.deepEqual(plain(api.rows(third)), ['fresh preview'], 'an older preview landing after a newer one leaves the newer rows');
  // Any other page takes each answer as it lands: the Timeline's paging waits on its reload and counts the rows after
  const first = api.reload('orbital:timeline'), second = api.reload('orbital:timeline'); // 7, 8
  await api.answer(7, ['older page']); await first;
  assert.deepEqual(plain(api.rows('orbital:timeline')), ['older page'], 'a page that is no saved search installs an answer even while a newer read is out');
  await api.answer(8, ['newer page']); await second;
  // A type page's two reads of one unchanged filter: the older answering last does not replace the newer rows
  const type = 'tana:type:01j0type000000000000000000';
  const typeFirst = api.reload(type), typeSecond = api.reload(type); // 9, 10
  await api.answer(10, ['newer type rows']); await typeSecond; await api.answer(9, ['older type rows']); await typeFirst;
  assert.deepEqual(plain(api.rows(type)), ['newer type rows'], 'an older read of a type page answering last leaves the newer rows');
  // A preview asked twice for the same pills (a global change) whose second ask fails first: the first answer still lands
  const dup = 'tana:search:01j0dup00000000000000000000';
  api.stage(dup); api.stage(dup); // 11, 12
  await api.answer(12, Promise.reject(new Error('unavailable'))); await api.answer(11, ['preview']);
  assert.deepEqual([plain(api.rows(dup)), api.staged(dup)], [['preview'], true], 'a preview whose newer duplicate failed still lands, staged');
  assert.deepEqual(plain(api.errors()), ['unavailable'], 'and the failure is said once');
  // The pills moved on (A, then B) before A's preview answered: A's rows are not installed under B's pills
  const moved = 'tana:search:01j0moved0000000000000000';
  api.stage(moved, ['closed']); api.stage(moved, ['not_now']); // 13, 14
  await api.answer(13, ['rows for A']);
  assert.equal(api.rows(moved), undefined, 'a preview for pills that have since changed is not installed');
  await api.answer(14, ['rows for B']);
  assert.deepEqual(plain(api.rows(moved)), ['rows for B'], 'the preview for the pills on screen is');
  // Stored A read out, staged B's preview fails, Save writes B and its read fails too: A's answer is not B's rows
  const ab = 'tana:search:01j0abab0000000000000000';
  api.stage(ab); api.unstage(ab); // saved A on the page, nothing staged
  const aRead = api.reload(ab); // 16 (15 was the stage's preview)
  api.stage(ab, ['closed']); // 17
  await api.answer(17, Promise.reject(new Error('unavailable')));
  const bSave = api.save(ab); // 18
  await api.answer(18, Promise.reject(new Error('unavailable'))); await bSave.catch(() => {});
  await api.answer(16, ['rows for A']); await aRead;
  assert.notDeepEqual(plain(api.rows(ab) || null), ['rows for A'], 'a stored answer for the filter a Save replaced is not installed under the saved pills');
  api.errors();
  // The first preview answers, then its newer duplicate fails: the page keeps its preview, still staged, and says nothing
  const retry = 'tana:search:01j0retry000000000000000';
  api.stage(retry); api.stage(retry); // 19, 20
  await api.answer(19, ['preview']); await api.answer(20, Promise.reject(new Error('unavailable')));
  assert.deepEqual([plain(api.rows(retry)), api.staged(retry), plain(api.errors())], [['preview'], true, []], 'a failed retry of a preview that already answered leaves it staged and quiet');
  console.log('ok  a saved search keeps the rows of its newest read: staged pills, a second preview and a Save all retire the reads still out');
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

// Notices and action errors are a toast that fades on its own (#123). The line under the title is the relogin state
// alone: writing into it replaced #errorText and the relogin button, so the next write there threw and the queue
// behind run() stopped. The fake #error does what the DOM does when its text is set: its children go.
async function runToastCheck() {
  const nodes = new Map(), timers = [];
  for (const id of ['error', 'errorText', 'errorLogin', 'toast']) {
    const n = { id, hidden: id !== 'toast', classes: new Set() };
    n.classList = { add: (c) => n.classes.add(c), remove: (c) => n.classes.delete(c), toggle: (c, on) => (on ? n.classes.add(c) : n.classes.delete(c)) };
    let text = '';
    Object.defineProperty(n, 'textContent', { get: () => text, set: (v) => { text = String(v); if (id === 'error') { nodes.delete('errorText'); nodes.delete('errorLogin'); } } });
    nodes.set(id, n);
  }
  const api = vm.runInNewContext(`
    const $ = (id) => nodes.get(id) || null;
    ${sourceBetween('let toastTimer', 'const run =')}
    ({ showNote, showError });
  `, { nodes, setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; }, clearTimeout: (i) => { if (timers[i - 1]) timers[i - 1].live = false; } });
  api.showNote('Link copied');
  assert.deepEqual([nodes.get('toast').textContent, nodes.get('toast').classes.has('show')], ['Link copied', true], 'a notice is the toast');
  assert.ok(nodes.has('errorText') && nodes.has('errorLogin') && nodes.get('error').hidden, 'and leaves the error line, with its login button, hidden and whole');
  api.showError(new Error('[permission_denied] permission denied'));
  assert.deepEqual([nodes.get('toast').textContent, nodes.get('toast').classes.has('error'), timers[1].ms], ['[permission_denied] permission denied', true, 6000], 'an error is a red toast that stays longer');
  assert.ok(nodes.has('errorText') && nodes.get('error').hidden, 'and stays out of the line under the title');
  api.showError(null);
  assert.equal(nodes.get('toast').textContent, '[permission_denied] permission denied', 'a later success does not wipe the error away');
  api.showNote('Classified as Project (91%)');
  assert.ok(!timers[1].live && !nodes.get('toast').classes.has('error'), 'a newer notice restarts the clock and is no longer red');
  for (const t of timers.filter((t) => t.live)) t.fn();
  assert.deepEqual([nodes.get('toast').textContent, nodes.get('toast').classes.has('show')], ['Classified as Project (91%)', false], 'and the toast fades on its own');
  console.log('ok  toast: notices and errors fade at the foot of the window and leave the relogin line alone');
}

// Main lets go of documents it no longer keeps live (#289) and says which (#389): the page forgets the outlines it keeps
// for them, a field's outline with its document's, and reads again at once the one it is drawing.
async function runReleasedOutlineCheck() {
  const api = await vm.runInNewContext(`
    // B|…: a choice field of B, drawn as chips (no rows, no children wrapper) while B is expanded
    // Q holds a copy of A (a reference): stale with it, and not on screen, so forgotten; S cites nothing released
    const kids = new Map([['A', ['old']], ['A|tana:type:t?attribute=x', ['field']], ['B', ['on screen']], ['B|tana:type:t?attribute=c', ['chip']], ['C', ['still live']], ['D', ['collapsed']], ['R', ['referenced']], ['E', []],
      ['Q', [{ id: 'q1', children: [{ id: 'q2', reference: { uri: 'A', node: { id: 'A', title: 'old title' } } }] }]], ['S', [{ id: 's1', reference: { uri: 'C' } }]],
      ['SP', [{ id: 'A', kind: 'document', text: 'old title' }]], // a space listing A as a row of its own: stale with it
      // saved searches listing A: one on screen with unsaved pill edits (its preview is asked again), one off screen (its
      // arrival runs the query again anyway, so it is left alone)
      ['tana:search:s', [{ id: 'A' }]], ['tana:search:off', [{ id: 'A' }]]]);
    const searchRows = new Map([['tana:search:s', '{"types":["x"]}']]), previewed = [];
    const previewRows = (id) => { previewed.push(id); }, isSearchDoc = (n) => n.id.startsWith('tana:search:'), isTypeDoc = (n) => n.id.startsWith('tana:type:');
    let releases = 0; const releasedDocs = new Map();
    // E is the target of an expanded full reference with no rows: drawn open, empty (render.js marks the children)
    const outline = { querySelectorAll: (sel) => (sel === '.children[data-outline]' ? [{ dataset: { outline: 'E' } }] : []) };
    const zoom = null, reloaded = [];
    // B is a document row drawn expanded (a row of its outline is drawn); D is listed too, but collapsed; R is the target
    // of an expanded full reference, whose rows are built against R from a block of another page (render.js childHost)
    const items = new Map([['k1', { key: 'k1', docId: 'B', node: { kind: 'document', id: 'B' } }], ['k1b', { key: 'k1b', docId: 'B', node: { kind: 'block', id: 'b1' } }],
      ['k2', { key: 'k2', docId: 'D', node: { kind: 'document', id: 'D' } }], ['k3', { key: 'k3', docId: 'P', node: { kind: 'block', id: 'ref' } }], ['k3r', { key: 'k3r', docId: 'R', node: { kind: 'block', id: 'r1' } }],
      ['k4', { key: 'k4', docId: 'tana:search:s', node: { kind: 'document', id: 'A' } }]]); // the search's row, drawn
    const open = new Map([['k1', true], ['k3', true]]); // B's row and the reference are open
    const relatedBy = new Map([['A', { fields: [] }], ['notes', { pinHub: 'H' }], ['C', { pinHub: 'X' }], ['lists', { notes: [{ id: 'N' }] }]]), relatedStale = new Set();
    const forced = [], reload = async (id) => { reloaded.push(id); if (id === 'E') throw new Error('not connected'); }, renderSoon = (force) => { forced.push(!!force); }; // E's read fails
    ${sourceLine('const outlinesOf =')}
    ${functionSource('railGroups')}
    ${functionSource('forgetReleased')}
    forgetReleased(['A', 'B', 'D', 'R', 'E', 'H', 'N']);
    Promise.resolve().then(() => null).then(() => ({ kids: [...kids.keys()], reloaded, previewed, stale: [...relatedStale], forced: forced.some(Boolean) }));
  `);
  assert.deepEqual(plain(api), { kids: ['B', 'B|tana:type:t?attribute=c', 'C', 'R', 'S', 'tana:search:s', 'tana:search:off'], reloaded: ['B', 'B|tana:type:t?attribute=c', 'R', 'E'], previewed: ['tana:search:s'], stale: ['A', 'notes', 'lists'], forced: false },
    'a released document\u2019s outlines are forgotten, an expanded one (a row, a full reference, an empty one) is read again with its fields and a collapsed one is not, one whose read fails is forgotten so the loading path asks again, the rest are kept; its sidebar, that of a page whose meeting was released and one listing it, are read again on the next visit');
  assert.match(source, /tana\.onReleased\(forgetReleased\)/, 'and the page listens for what main lets go of');
  // A read that began before the release and answers after it does not put the forgotten rows back (renderer/nodes.js reload).
  const late = await vm.runInNewContext(`
    const kids = new Map(), isTypeId = () => false, TIMELINE_PAGE = 'orbital:timeline', syncUploads = (id, rows) => rows, releasedDocs = new Map();
    let releases = 0, timelinePartial = false, redraws = 0; const answers = [], calls = [], renderSoon = () => { redraws++; };
    // the five reads below are answered by hand; a read again after them answers at once with what the document holds now
    const now = { Y: [{ id: 'fresh' }], W: [{ id: 'w1' }, { id: 'w2', reference: { uri: 'A2' } }] };
    const tana = { children: (id) => { calls.push(id); return calls.length <= 5 ? new Promise((resolve) => { answers.push(resolve); }) : Promise.resolve(now[id]); } };
    const SEARCH_ID = 'tana:search:', searchRows = new Map(), searchFilters = new Map();
    ${sourceBetween('const reloadSeq = new Map();', '// Whether a read begun at release')}
    ${functionSource('releasedSince')}
    ${sourceLine('const rowIds =')}
    ${functionSource('reload')}
    // forgotten: X's read was out when main let go of it, and the page forgot it
    const reading = reload('X');
    releases++; releasedDocs.set('X', releases); kids.delete('X');
    answers[0](['stale']);
    // drawn: Y keeps its rows and is read again at once; the fresh read answers first, the older one after it
    kids.set('Y', [{ id: 'y1' }]);
    const older = reload('Y');
    releases++; releasedDocs.set('Y', releases);
    const fresh = reload('Y');
    answers[2]([{ id: 'fresh' }]); answers[1]([{ id: 'stale' }]);
    // loading: Z's first read is out when A, which Z references, is let go; its answer is not cached and loading asks again
    kids.set('Z', null);
    const loading = reload('Z');
    releases++; releasedDocs.set('A', releases);
    answers[3]([{ id: 'z1', reference: { uri: 'A', node: { id: 'A' } } }]);
    // cached: W's update adds a reference to A2, let go while it is read; W is read again and the update lands
    kids.set('W', [{ id: 'w1' }]);
    const updating = reload('W');
    releases++; releasedDocs.set('A2', releases);
    answers[4]([{ id: 'w1' }, { id: 'w2', reference: { uri: 'A2' } }]);
    Promise.all([reading, older, fresh, loading, updating]).then(() => [kids.has('X'), kids.get('Y').map((r) => r.id), kids.has('Z'), redraws > 0, calls.slice(5), kids.get('W').length]);
  `);
  assert.deepEqual(plain(late), [false, ['fresh'], false, true, ['Y', 'W'], 2], 'a read begun before the release does not cache rows that name a released document, forgotten, drawn or still loading; loading asks again, and cached rows are read again so the update lands');
  // The other writes of read rows check their answer the same way: a staged search preview asks again, and a sidebar
  // read (a refresh of one already shown included) is marked to be read again at the next draw.
  const writes = await vm.runInNewContext(`
    const kids = new Map(), releasedDocs = new Map(), searchRows = new Map(), relatedBy = new Map([['page', { notes: [] }]]), relatedStale = new Set();
    let releases = 0; const previews = [], relateds = [];
    const searchFilters = new Map([['S', { filter: { types: ['a'] } }]]), filters = new Map([['S', { types: ['b'] }]]), sameFilter = () => false;
    const tana = { searchPreview: () => new Promise((resolve) => { previews.push(resolve); }), related: () => new Promise((resolve) => { relateds.push(resolve); }) };
    const render = () => {}, showError = () => {}, reload = async () => {}, connected = true, isRealId = () => true, zoom = null, items = new Map();
    const editingRow = () => false, selectionFrozen = false, renderFields = () => {}, renderRail = () => {}, renderSoon = () => {}, queryRow = () => null, CSS = { escape: (s) => s };
    ${sourceBetween('const reloadSeq = new Map();', '// Whether a read begun at release')}
    ${functionSource('releasedSince')}
    ${sourceLine('const rowIds =')}
    ${functionSource('previewRows')}
    ${functionSource('railGroups')}
    ${functionSource('loadRelated')}
    previewRows('S');
    relatedStale.add('page'); loadRelated('page'); // a refresh of a sidebar already shown
    releases++; releasedDocs.set('A', releases); // main lets A go while both are out
    previews[0]([{ id: 'A' }]); relateds[0]({ notes: [{ id: 'A' }] });
    Promise.resolve().then(() => null).then(() => [previews.length, kids.has('S'), relatedStale.has('page')]);
  `);
  assert.deepEqual(plain(writes), [2, false, true], 'a preview naming a released document is asked again rather than cached, and a sidebar read naming one is read again at the next draw');
  console.log('ok  released documents: the page forgets their outlines and reads again the one it draws, so none stays stale');
}
const checks = [runReleasedOutlineCheck, runToastCheck, runInlineFieldsCheck, runCaretAtPointCheck, runPrefsStoreCheck, runSettingsElsewhereCheck, runImageViewCheck, runRailReadinessCheck, runDeletedNodeCheck, runRecentlyDeletedCheck, runEditPinsCheck, runLinkTargetsLoadCheck, runSetIconCheck, runDiscussWithCheck, runClassifyTypeCheck, runSetHueCheck, runLiveUpdateBurstCheck, runSetTypeCheck, runZoomTypeChipCheck, runStyleMenuFitCheck, runEmptyRowAboveCheck, runJoinAboveCheck, runDefaultModeCheck, runNavButtonsCheck, runRowMetaFitCheck, runPinToMeetingCheck, runClosedPaletteKeysCheck, runAgentStatusBootCheck, runRailChangesCheck, runPasteLinkCheck, runPasteImageCheck, runPasteDraftCheck, runReferenceCaretCheck, runCreateTaskFlowCheck, runDraftDocumentDeleteCheck, runAccessReadinessCheck, runRefreshSpinCheck, runCodexAssignCheck, runNotifyToggleCheck, runNotifyBellCheck, runCurrentNodeStatusCheck, runRestorePlaceCheck, runSearchPillsCheck, runPillsFoldCheck, runDraftTailCheck, runRailToggleCheck, runCaretOnOpenScrollCheck, runTypingRenderStabilityCheck, runDraftMaterialiseFocusCheck, runDraftBlurOrderCheck, runRecentRowsCheck, runRowChangeAnimationCheck, runFallingRowCheck, runZoomedBlockTitleSaveCheck, runSensitiveBlurCheck, runSelectionChecks, runMultiTaskPaletteCheck, runAssignedDropdown, runEditabilityCheck, runCheckboxCheck, runCheckboxInheritanceCheck, runTaskChildCheckboxScopeCheck, runStalePaletteInvalidationCheck, runReferenceEmbedRenderCheck, runRowAlignmentCheck, runRowAudienceCheck, runHiddenItemsCheck, runMemberLoadCheck, runVisibilityPickerCheck, runLinkPaletteCheck, runAuthPaletteCheck, runSyncShortcutCheck, runReservedComboCheck, runHistoryCheck, runZoomShortcutCheck, runZoomDeleteCheck, runAssigneeCloseCheck, runPendingSplitDraftCheck, runTaskMetaRetryCheck, runPaletteSkipCheck, runFormattingChecks, runSlashMenuCheck, runFilterShortcutFocusCheck, runFilterMenuCloseCheck, runSidebarRowsCheck, runRailPinCheck, runSidebarHoverCheck, runSidebarAlignmentCheck, runClearFiltersCheck, runUnifiedViewsCheck, runSortGroupCheck, runCmdPillsCheck, runSearchesGroupCheck, runSearchPageRowUpdateCheck, runHomeCheck, runStagedSearchReloadCheck];
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
    const views = [], pinTree = [], pinRows = () => [], searches = [], typeListCache = null, searchesLoaded = true;
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
    ({ row: () => paletteRows('').find((r) => r.id === 'setType'), removeRow: () => paletteRows('').find((r) => r.id === 'removeType'),
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
  // 5. Remove type: one row, only where there is a type to take off, and the same one write as "No type".
  api.node({ id: DOC, tags: [{ label: 'task', color: 'grey' }] });
  assert.equal(api.removeRow(), undefined, 'an untyped document has nothing to remove');
  api.node({ id: DOC, tags: [{ label: 'task', color: 'grey' }, { label: 'Discussion Task', uri: TYPE_B, hue: 200 }] });
  assert.deepEqual(plain([api.removeRow().label, api.removeRow().hint, api.removeRow().icon]), ['Remove type', 'Discussion Task', 'none'], 'a typed one is offered it, named after the type it takes off');
  const closedBefore = api.state().closed;
  api.removeRow().run();
  await api.settle();
  assert.deepEqual(plain([api.state().written.slice(-1), api.state().closed]), [[[DOC, null]], closedBefore + 1], 'one write of no type, and the palette closes');
  api.node({ id: BLOCK, tags: [{ label: 'Discussion Task', uri: TYPE_B }] });
  assert.equal(api.removeRow(), undefined, 'a block carries no type to remove');
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
    const frames = [], renders = [], reloaded = [], patched = [];
    const requestAnimationFrame = (fn) => frames.push(fn);
    const render = (force) => renders.push(force === true);
    ${functionSource('renderSoon')}
    let listener;
    const TIMELINE_PAGE = 'orbital:timeline';
    let zoom = { docId: TIMELINE_PAGE };
    const SEARCH_ID = 'tana:search:', isTypeId = (id) => String(id).startsWith('tana:type:');
    const searchRows = new Map(), previewed = [], previewRows = (id) => { previewed.push(id); };
    ${sourceLine('const onSearchPage =')}
    ${sourceLine('const onTypePage =')}
    ${sourceLine('const listPage =')}
    const taskMetaById = new Map(), taskMetaFailed = new Map(), relatedBy = new Map(), kids = new Map();
    const outlinesOf = (docId) => [...kids.keys()].filter((id) => id === docId || id.startsWith(docId + '|'));
    const patchDoc = async (id) => { patched.push(id); }, reload = async (id) => { reloaded.push(id); }, loadPins = () => {}, refreshRelated = () => {};
    const agentStates = new Map([['tana:text:01j0agent000000000000000000', 'working']]), agentTaskHosts = new Map(), statusReads = [], loadAgentStates = () => statusReads.push(1);
    const loadRoots = async () => 'rows'; // a resolved value, which is what .then(renderSoon) hands the queue
    const showError = (error) => { throw error; };
    const tana = { onChanged: (fn) => { listener = fn; } };
    ${sourceBetween('tana.onChanged((docId, info) => {', '// A document is also drawn from copies')}
    ({
      change: (id, info) => listener(id, info),
      flush: () => { for (const fn of frames.splice(0)) fn(); },
      drawn: () => renders.splice(0),
      reloaded: () => reloaded.splice(0),
      patched: () => patched.splice(0),
      open: (id) => { kids.set(id, []); kids.set(id + '|tana:type:t?attribute=a', []); },
      page: (id) => { zoom = { docId: id }; },
      statusReads: () => statusReads.splice(0).length,
      stage: (id) => { searchRows.set(id, '{}'); },
      previewed: () => previewed.splice(0),
    });
  `);

  for (let i = 0; i < 50; i++) api.change('tana:text:01j0burst' + String(i).padStart(16, '0'));
  await new Promise(setImmediate);
  assert.deepEqual(plain(api.drawn()), [], 'nothing is drawn between the announcements themselves');
  api.flush();
  assert.deepEqual(plain(api.drawn()), [true], 'fifty documents announcing themselves at once redraw the outline once, and forced');

  api.change(null);
  await new Promise(setImmediate);
  assert.deepEqual(plain(api.reloaded()), ['orbital:timeline'], 'a global date-pin change reloads the open Timeline snapshot');
  api.flush();
  assert.deepEqual(plain(api.drawn()), [false], 'a global refresh renders unforced: the rows .then(renderSoon) hands it are not a force');

  api.change('tana:text:01j0burst0000000000000000');
  api.change(null);
  await new Promise(setImmediate);
  assert.deepEqual(plain(api.reloaded()), ['orbital:timeline'], 'a pin change still reloads Timeline when batched with a task update');
  api.flush();
  assert.deepEqual(plain(api.drawn()), [true], 'a live update and a refresh in the same frame settle as one forced redraw rather than two');

  api.change(null);
  await new Promise(setImmediate);
  assert.deepEqual(plain(api.reloaded()), ['orbital:timeline']);
  api.flush();
  assert.deepEqual(plain(api.drawn()), [false], 'and the force does not leak into the frame after it');
  // A node linked to an agent task whose metadata moved (another page relinked it) asks what its task is doing now;
  // any other node's metadata, or a linked node's plain edit, starts no status read
  api.change('tana:text:01j0agent000000000000000000', { meta: true }); api.change('tana:text:01j0other000000000000000000', { meta: true });
  api.change('tana:text:01j0agent000000000000000000', { meta: false });
  assert.equal(api.statusReads(), 1, 'a linked node\u2019s metadata change reads its task\u2019s status, and nothing else does');
  await new Promise(setImmediate); api.flush(); api.drawn(); api.reloaded(); api.patched();

  // A saved search or a type's page is a list of its own the same way: a hidden title or the MCP switch changes its rows
  for (const page of ['tana:search:01j0search0000000000000000', 'tana:type:01j0type000000000000000000']) {
    api.page(page); api.change(null);
    await new Promise(setImmediate);
    assert.deepEqual(plain(api.reloaded()), [page], 'a global change reloads an open ' + page.split(':')[1] + ' page, whose rows loadRoots does not reach');
    api.flush(); api.drawn();
  }
  // A saved search with unsaved pill edits shows their preview: that is what is asked again, not the stored query
  api.page('tana:search:01j0search0000000000000000'); api.stage('tana:search:01j0search0000000000000000'); api.change(null);
  await new Promise(setImmediate);
  assert.deepEqual([plain(api.reloaded()), plain(api.previewed())], [[], ['tana:search:01j0search0000000000000000']], 'a staged saved search is previewed again rather than overwritten with its stored rows');
  api.flush(); api.drawn();
  api.page('tana:text:01j0note000000000000000000'); api.change(null);
  await new Promise(setImmediate);
  assert.deepEqual(plain(api.reloaded()), [], 'a document page is not a list: its outline is left to its own changes');
  api.flush(); api.drawn();
  api.page('library'); api.change(null);
  await new Promise(setImmediate);
  assert.deepEqual(plain(api.reloaded()), [], 'global changes leave the timeline query alone while another page is open');
  api.flush();

  // The echo of this page's own typing (#265): the page and its fields are not read again and nothing is forced under
  // the caret, while the document's copies elsewhere still take the new title. Anyone else's change reads as before.
  const PAGE = 'tana:text:01j0typed000000000000000000';
  api.page(PAGE); api.open(PAGE); api.drawn(); api.patched();
  api.change(PAGE, { meta: false, own: true });
  await new Promise(setImmediate);
  assert.deepEqual(plain(api.reloaded()), [], 'its own typing does not re-read the page or its fields');
  assert.deepEqual(plain(api.patched()), [PAGE], 'the row copies of the document are still patched');
  api.flush();
  assert.deepEqual(plain(api.drawn()), [false], 'and drawn unforced, so a caret in a row keeps the render waiting');
  api.change(PAGE, { meta: false });
  await new Promise(setImmediate);
  assert.deepEqual(plain(api.reloaded()), [PAGE, PAGE + '|tana:type:t?attribute=a'], 'the same change from another page or machine re-reads the page and its fields');
  api.flush();
  assert.deepEqual(plain(api.drawn()), [true], 'and is forced onto the screen');
  api.change(PAGE, { meta: true, own: true });
  await new Promise(setImmediate);
  assert.deepEqual(plain(api.reloaded()), [PAGE, PAGE + '|tana:type:t?attribute=a'], 'own typing that moved metadata (a field value) still re-reads, as that needs');
  api.flush(); api.drawn(); api.patched();
  console.log('ok  global pin changes refresh Timeline only while it is open');
}

// Cmd+K "Discuss with …": the row on a document, and the page that asks who. Main owns both writes (the Discussion
// Task type and the field); what is checked here is that the row is offered to documents only, that the page takes
// the words as they are typed — the field holds text, not a member reference, and a real value as often names a
// team or two people as one colleague — and that one answer is one call.
async function runDiscussWithCheck() {
  const DOC = 'tana:text:01j0doc000000000000000000';
  const api = vm.runInNewContext(`
    const views = [], pinTree = [], pinRows = () => [], searches = [], typeListCache = null, searchesLoaded = true;
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
       page: (q) => { palInput.value = q || ''; return discussRows((q || '').toLowerCase(), q || '').map((r) => [r.label, r.hint || '', r.icon || '', !!r.disabled]); },
       landing: (q) => { palInput.value = q || ''; return discussRows((q || '').toLowerCase(), q || '').map((r) => !!r.arrive); },
       choose: (q, i = 0) => { palInput.value = q || ''; discussRows((q || '').toLowerCase(), q || '')[i].run(); },
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
  assert.deepEqual(plain(api.row()), { label: 'Discuss with \u2026', hint: 'Discussion Task', icon: 'discuss', keepOpen: true },
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

// Cmd+K "Classify type": the model weighs the types Set type would offer. A type it is sure of is applied at once; a
// less sure answer is the list, every option with its odds and "No type" among them, and the choice is yours.
async function runClassifyTypeCheck() {
  const DOC = 'tana:text:01j0doc000000000000000000', TYPE_A = 'tana:type:01j0typea00000000000000000', TYPE_B = 'tana:type:01j0typeb00000000000000000';
  const api = vm.runInNewContext(`
    const views = [], pinTree = [], pinRows = () => [], searches = [], typeListCache = null, searchesLoaded = true;
    let home = 'library', view = 'library';
    const localStorage = { setItem() {} }, onSearchPage = () => false;
    const selectionRows = () => [], pillCommandRows = () => [], taskActionRows = () => [];
    let palDoc = { id: '${DOC}', text: 'Postgres over Mongo', tags: [] };
    const pinInfo = null, isRealId = () => true;
    const accessById = new Map(), loadAccess = () => {}, localDate = () => '2026-09-24', setTheme = () => {};
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
    const visibilityRows = () => [], moveTargets = async () => [], previewMoveToSpace = () => {}, openTypePalette = () => {};
    const typeGlyphs = new Map([['${TYPE_A}', 'nc-gavel']]); // the one type here that was given an icon
    let renders = 0; const renderPalette = () => { renders++; };
    let closed = 0; const closePalette = () => { closed++; }, promptEditor = () => {};
    const openCommandPalette = () => { palMode = 'cmd'; palRows = []; palIndex = 0; };
    const errors = [], notes = []; let queue = Promise.resolve();
    const showError = (e) => { if (e) errors.push((e && e.message) || String(e)); }, showNote = (n) => notes.push(n);
    const run = (fn) => (queue = queue.then(fn).then((v) => { showError(null); return v; }, showError));
    const render = () => {};
    // the model behind the page: which documents it was asked about, and an answer this check settles when it chooses
    const written = [], asked = []; let settle = null;
    const tana = { refresh: async () => {}, filters: {}, sensitiveIds: () => {},
      setType: async (id, uri) => { written.push([id, uri]); return uri; },
      classifyType: (id) => new Promise((resolve, reject) => { asked.push(id); settle = (answer, fails) => (fails ? reject(new Error(fails)) : resolve(answer)); }) };
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    ${functionSource('paletteRows')}
    ${sourceBetween('const TYPE_GROUP', 'function openTypePalette')}
    ${sourceBetween('const CLASSIFY_GROUP', '// ---- Discuss with')}
    ${functionSource('applyType')}
    ${functionSource('backPalette')}
    ({ row: () => { const r = paletteRows('').find((x) => x.id === 'classifyType'); return r && { label: r.label, icon: r.icon, keepOpen: r.keepOpen }; },
       open: () => paletteRows('').find((x) => x.id === 'classifyType').run(),
       node: (next) => { palDoc = next; },
       page: (q) => classifyRows(q || '').map((r) => [r.label, r.hint || '', r.icon || '', !!r.disabled]),
       choose: (label) => classifyRows('').find((r) => r.label === label).run(),
       answer: async (value, fails) => { settle(value, fails); for (let i = 0; i < 6; i++) await Promise.resolve(); await queue; },
       asked: () => [...asked],
       mode: () => palMode,
       escape: () => backPalette(),
       settle: async () => { await queue; await Promise.resolve(); },
       state: () => ({ written: [...written], notes: [...notes], errors: [...errors], closed, renders, placeholder: palInput.placeholder }) });
  `);
  const sure = { current: null, choices: [{ uri: TYPE_A, title: 'Decision Record', hue: 143, p: 0.91 }, { uri: null, title: 'No type', p: 0.06 }, { uri: TYPE_B, title: 'Project', hue: 268, p: 0.03 }] };

  // 1. Offered where a type can go — a document or a meeting — and nowhere else.
  assert.deepEqual(plain(api.row()), { label: 'Classify type', icon: 'sparkle', keepOpen: true }, 'the row wears the glyph of what the model works out');
  api.node({ id: 'tana:event:01j0event00000000000000000', tags: [] });
  assert.ok(api.row(), 'a meeting carries a type too');
  for (const id of ['b12', 'tana:space:01j0space00000000000000000', TYPE_A]) {
    api.node({ id, tags: [] });
    assert.equal(api.row(), undefined, (id.split(':')[1] || 'a block') + ' is not offered it');
  }

  // 2. Opening asks once and says it is reading; a sure answer is applied, closed and said.
  api.node({ id: DOC, tags: [] });
  api.open();
  assert.deepEqual(plain([api.mode(), api.state().placeholder, api.asked()]), ['classify', 'Classify type\u2026', [DOC]], 'a page of its own, and one question about this document');
  assert.deepEqual(plain(api.page()), [['Reading the document\u2026', '', 'sparkle', true]], 'which says it is working rather than looking finished');
  await api.answer(sure);
  assert.deepEqual(plain([api.state().written, api.state().closed, api.state().notes]), [[[DOC, TYPE_A]], 1, ['Classified as Decision Record (91%)']],
    'a type the model is sure of is set at once, the palette closes, and the note says what and how sure');

  // 3. Sure of the type it already has: nothing to write.
  api.open();
  await api.answer({ ...sure, current: TYPE_A });
  assert.deepEqual(plain([api.state().written.length, api.state().closed, api.state().notes.at(-1)]), [1, 2, 'Already Decision Record (91%)'], 'the same type is not written again');

  // 4. Less sure: every option with its odds, the current one ticked, and the choice is yours — "No type" included.
  api.open();
  await api.answer({ current: TYPE_B, choices: [{ uri: TYPE_A, title: 'Decision Record', hue: 143, p: 0.55 }, { uri: TYPE_B, title: 'Project', hue: 268, p: 0.3 }, { uri: null, title: 'No type', p: 0.15 }] });
  assert.deepEqual(plain([api.state().written.length, api.state().closed, api.mode()]), [1, 2, 'classify'], 'nothing is applied and the page stays up');
  assert.deepEqual(plain(api.page()), [['Decision Record', '55%', 'nc-gavel', false], ['Project', '30% \u2713', 'type', true], ['No type', '15%', 'none', false]],
    'most likely first, with the odds beside each, each type in its own icon (the generic one when it has none); the type it has is ticked and not offered again');
  assert.deepEqual(plain(api.page('proj')), [['Project', '30% \u2713', 'type', true]], 'typing narrows the list');
  api.choose('No type');
  await api.settle();
  assert.deepEqual(plain([api.state().written.at(-1), api.state().closed]), [[DOC, null], 3], '"No type" takes the type off, like it does on Set type');

  // 5. Sure that nothing fits: said, never applied — a model does not take a type off on its own.
  api.open();
  await api.answer({ current: TYPE_B, choices: [{ uri: null, title: 'No type', p: 0.9 }, { uri: TYPE_B, title: 'Project', hue: 268, p: 0.1 }] });
  assert.deepEqual(plain([api.state().written.length, api.page()[0]]), [2, ['No type', '90%', 'none', false]], '"No type" leads the list and waits to be chosen');

  // 6. A failed call says why; an answer to a page already left writes nothing and draws nothing.
  api.open();
  await api.answer(null, 'Sign in with ChatGPT or add an OpenAI API key to classify');
  assert.deepEqual(plain(api.page()), [['Sign in with ChatGPT or add an OpenAI API key to classify', '', 'sparkle', true]], 'the reason is on the page');
  api.open();
  api.escape();
  const renders = api.state().renders;
  await api.answer(sure);
  assert.deepEqual(plain([api.mode(), api.state().written.length, api.state().renders]), ['cmd', 2, renders], 'Escape steps back, and the late answer is dropped');
  console.log('ok  Classify type: offered where a type goes, a sure answer applied and said, otherwise every option with its odds, "No type" never applied on its own');
}

// Cmd+K "Set icon": the row on a type, and the page that searches the Nucleo set built into the app. The set itself
// is main's (main/icons.js) — what is checked here is that the row is offered to a type and nothing else, that the
// page draws what main answers and registers those glyphs so the rows can show them, that the type it already wears
// is ticked and can be taken off, and that choosing is one call.
async function runSetIconCheck() {
  const TYPE = 'tana:type:01j0type000000000000000000', DOC = 'tana:text:01j0doc000000000000000000';
  const api = vm.runInNewContext(`
    const views = [], pinTree = [], pinRows = () => [], searches = [], typeListCache = null, searchesLoaded = true;
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
    let renderedPages = 0, palEnter = null; const renderPalette = () => { renderedPages++; if (palMode === 'setIcon') palRows = iconPickRows(palInput.value); }; // the rows Enter runs are the ones drawn
    const runRow = (row) => row.run();
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
    ${functionSource('chooseRow')}
    ${functionSource('settleEnter')}
    ({ row: () => paletteRows('').find((r) => r.id === 'setIcon'),
       node: (next) => { palDoc = next; },
       wearing: (uri, name) => { if (name) typeGlyphs.set(uri, name); else typeGlyphs.delete(uri); },
       answer: (next, fails) => { answer = next === null ? [] : next; searchFails = fails || null; },
       search: (q) => { palInput.value = q; searchIconsNow(); },
       // what typing does (the input listener): busy at once, main asked after the debounce; Enter pressed in between
       typeThenEnter: (q) => { palInput.value = q; palIndex = 0; palBusy = true; chooseRow(false); searchIconsNow(); },
       page: (q) => iconPickRows(q),
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

  // 5. Enter right after typing runs the row for what was typed, not the one drawn for the words before (#392).
  const svg = '<svg viewBox="0 0 18 18"><path d="M1 1"></path></svg>';
  api.answer([{ name: 'nc-rocket', label: 'rocket', svg }]);
  api.row().run();
  await api.settle();
  const before = api.state().written.length;
  api.answer([{ name: 'nc-calendar', label: 'calendar', svg }]);
  api.typeThenEnter('calendar');
  await api.settle();
  assert.deepEqual(plain(api.state().written.slice(before)), [[TYPE, 'nc-calendar']], 'Enter while main is still answering waits, and applies the icon that was typed');
  // A type that wears one leads with "No icon", but only for words that could mean it: typed "calendar", Enter applies calendar.
  api.wearing(TYPE, 'nc-rocket');
  api.answer([{ name: 'nc-calendar', label: 'calendar', svg }]);
  api.typeThenEnter('calendar');
  await api.settle();
  assert.deepEqual(plain(api.state().written.at(-1)), [TYPE, 'nc-calendar'], 'on a type that wears an icon, Enter after typing applies the typed one rather than taking it off');
  assert.deepEqual(plain(api.page('no').map((r) => r.label)), ['No icon', 'calendar'], 'and "No icon" still answers to its own name');
  api.wearing(TYPE, null);
  console.log('ok  Set icon: offered on a type, the page searches main\u2019s set and registers what it draws, the current glyph is ticked and removable, one call per choice');
}

// Cmd+K "Set colour": the hue Tana keeps on a type (appearance.hue). The row is offered to a type and nothing else,
// the page previews every colour with the glyph the type wears, a typed number picks a hue the list does not hold,
// the current colour is ticked and removable, and each choice is one call.
async function runSetHueCheck() {
  const TYPE = 'tana:type:01j0type000000000000000000', DOC = 'tana:text:01j0doc000000000000000000';
  const api = vm.runInNewContext(`
    const views = [], pinTree = [], pinRows = () => [], searches = [], typeListCache = null, searchesLoaded = true;
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
  assert.deepEqual(plain([api.row().hint, api.row().icon, api.row().hue]), ['Hue 268', 'nc-rocket', null], 'and a coloured one wears its own glyph, monochrome, its colour named in the hint');
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
  assert.deepEqual(plain(api.page('400')), [], 'and a hue that is not one leaves the list empty, for the palette\'s one "No results" line (#362)');

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
    const SIDE = ''; // renderer/state.js: a page on its own, not the right half of a split
    const deletedIds = new Set();
    const INBOX_PAGE = 'orbital:notifications', PROPOSALS_PAGE = 'orbital:proposals', TIMELINE_PAGE = 'orbital:timeline';
    const markAllNotificationsRead = () => {};
    const isSearchDoc = (node) => node.id?.startsWith('tana:search:');
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
    const views = [], pinTree = [], pinRows = () => [], searches = [], typeListCache = null, searchesLoaded = true;
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
    const opened = [], restored = [], order = [];
    const goTo = (id) => { opened.push(id); };
    let answer = async () => [
      { id: '${GONE}', title: 'Weekly plan', deletedAt: new Date(Date.now() - 2 * 36e5).toISOString() },
      { id: 'tana:text:01j0gone100000000000000000', title: 'Scratch note', deletedAt: new Date(Date.now() - 3 * 864e5).toISOString() },
    ];
    const tana = { refresh: async () => {}, filters: {}, sensitiveIds: () => {},
      deletedList: () => { order.push('read'); return answer(); }, restoreDocument: async (id) => { restored.push(id); },
      archivedTypes: async () => [{ id: 'tana:type:01j0arch000000000000000000', title: 'Old project', archivedAt: new Date(Date.now() - 864e5).toISOString() }],
      unarchiveDocument: async (id) => { restored.push(id); } };
    ${functionSource('fuzzyMatch')}
    ${functionSource('agoText')}
    ${sourceBetween('const docRow =', 'const NODE_ROW_ORDER')}
    ${sourceBetween('const NODE_ROW_ORDER', 'function paletteRows')}
    ${sourceBetween('const homeSearch =', 'function sensitiveHidden')}
    ${functionSource('paletteRows')}
    ${sourceBetween('const TRASH_GROUP', 'function openTrashPalette')}
    ${functionSource('openTrashPalette')}
    ${sourceBetween('const ARCHIVED_GROUP', 'function openArchivedPalette')}
    ${functionSource('openArchivedPalette')}
    ${functionSource('backPalette')}
    ({ row: () => paletteRows('').find((r) => r.id === 'recentlyDeleted'),
       archivedRow: () => paletteRows('').find((r) => r.id === 'archivedTypes'),
       archivedPage: (q) => archivedRows(q || ''),
       page: (q) => trashRows(q || ''),
       mode: () => palMode,
       escape: () => backPalette(),
       empty: () => { answer = async () => []; },
       fail: () => { answer = async () => { throw new Error('Not connected'); }; },
       writeThenOpen: async () => { order.length = 0; run(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); order.push('write'); }); paletteRows('').find((r) => r.id === 'recentlyDeleted').run(); await queue; for (let i = 0; i < 6; i++) await Promise.resolve(); return [...order]; },
       hold: () => { const held = []; answer = () => new Promise((resolve) => held.push((title) => resolve([{ id: '${GONE}', title, deletedAt: new Date().toISOString() }]))); return held; },
       settle: async () => { await queue; for (let i = 0; i < 6; i++) await Promise.resolve(); },
       state: () => ({ restored: [...restored], opened: [...opened], errors: [...errors], closed, placeholder: palInput.placeholder }) });
  `);

  // 1. The row sits with the other places to go, and carries an id, so a key can be recorded against it.
  assert.deepEqual(plain([api.row().label, api.row().group, api.row().icon]), ['Recently deleted', 'Navigate', 'trash'], 'the row is offered');

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
  assert.deepEqual(plain(api.page('zz')), [], 'a query leaves the answer to the palette\'s one "No results" line, not a second line saying the list is empty (#362)');
  api.fail();
  api.row().run();
  await api.settle();
  assert.deepEqual(plain(api.page().map((r) => [r.label, r.disabled])), [['Not connected', true]], 'a read that failed says why, instead of Loading… for as long as the page is open (#362)');
  assert.deepEqual(plain(api.page('zz').map((r) => [r.label, r.note])), [['Not connected', true]], 'with a query too, as a note, which keeps the palette\'s "No results" from appearing under it');
  assert.match(source, /\|\| r\.node \|\| r\.note\) && !palPage\.typed/, 'renderPalette draws no "No results" under a note');
  assert.deepEqual(plain(await api.writeThenOpen()), ['write', 'read'], 'a delete or restore still queued lands before the page reads its list');
  const held = api.hold();
  api.row().run(); api.row().run(); await api.settle(); // opened again before the first read answered
  held[1]('Newer'); await api.settle();
  held[0]('Older'); await api.settle();
  assert.deepEqual(plain(api.page().map((r) => r.label)), ['Newer'], 'an older read that lands last is dropped: the page keeps the answer to its latest open');
  api.empty(); api.row().run(); await api.settle();
  api.escape();
  assert.equal(api.mode(), 'cmd', 'escape on the page goes back to the command page');
  // #36 Cmd+K "Archived types": the same page shape over main's includeArchived query; Enter unarchives and opens it
  api.archivedRow().run();
  assert.deepEqual(plain([api.mode(), api.state().placeholder, api.archivedPage()[0].label]), ['archived', 'Unarchive a type', 'Loading…'], 'the archived page is honest while loading');
  await api.settle();
  assert.deepEqual(plain(api.archivedPage().map((r) => [r.label, r.hint])), [['Old project', '1 day ago']], 'archived types with their ages');
  api.archivedPage()[0].run();
  await api.settle();
  assert.deepEqual(plain([api.state().restored.at(-1), api.state().opened.at(-1)]), ['tana:type:01j0arch000000000000000000', 'tana:type:01j0arch000000000000000000'], 'Enter unarchives the type and opens it');
  api.escape(); api.archivedRow().run(); api.escape();
  assert.equal(api.mode(), 'cmd', 'escape steps back from the archived page too');
  console.log('ok  Recently deleted: the row is offered, the page reads main\u2019s list with its ages, restores and opens what is chosen, and is honest while loading or empty');
}

// Dragging a row (renderer/drag.js): what a pointer over a gap asks for, where it asks for nothing, and whether
// what lands is the row itself or a reference to it. Geometry is all a real window would add here, so the rows are
// laid out by hand — 24px lines, one level every 33px — and the plan is read back as the write it would make.
function runDropPlanCheck() {
  const api = vm.runInNewContext(`
    const el = (cls) => {
      const node = {
        cls: new Set(cls), dataset: {}, children: [], parentElement: null, rect: { top: 0, bottom: 0, height: 0, left: 16, right: 600 },
        classList: { contains: (name) => node.cls.has(name) },
        getBoundingClientRect: () => node.rect,
        append(...kids) { for (const kid of kids) { kid.parentElement = node; node.children.push(kid); } },
        all() { return node.children.flatMap((kid) => [kid, ...kid.all()]); },
        querySelectorAll(selector) { return node.all().filter((kid) => selector.slice(1).split('.').every((name) => kid.cls.has(name))); },
        querySelector(selector) { const want = selector.includes('children') ? 'children' : 'line'; return node.children.find((kid) => kid.cls.has(want)) || null; },
        contains(other) { for (let p = other; p; p = p.parentElement) if (p === node) return true; return false; },
        closest(selector) { for (let p = node; p; p = p.parentElement) if (p.cls.has(selector.slice(1))) return p; return null; },
      };
      return node;
    };
    const FIELD = 'd1|tana:type:01j0typ0000000000000000000?attribute=n5e1hgxz';
    const scroll = el(['scroll']), outline = el(['outline']), fieldEl = el(['fvalues']);
    scroll.append(outline);
    const items = new Map(), elByKey = new Map();
    const host = (key, docId, node) => { const item = { key, docId, node: node || { id: docId, kind: 'document', editable: true, children: [] } }; items.set(key, item); return item; };
    let dragKey = null;
    // [key, level, block type, options] in reading order: one 24px line each, a level 33px in (23 under a list row,
    // whose marker hangs in the space the level would otherwise use), exactly as styles.css draws them.
    const build = (root, rows, rootItem, x0 = 16) => {
      let y = 0;
      const stack = [{ el: root, item: rootItem, left: x0 }];
      for (const [key, depth, block, opts = {}] of rows) {
        const owner = stack[depth], left = owner.left, listRow = block === 'bullet' || block === 'numbered';
        const row = el(['node', opts.kind === 'document' ? 'document' : 'block', 't-' + block, ...(opts.draft ? ['draft'] : [])]);
        row.dataset.key = key;
        row.rect = { top: y, bottom: y + 24, height: 24, left, right: x0 + 584 };
        const line = el(['line']);
        line.rect = { ...row.rect, left: left - (listRow ? 10 : 0) };
        row.append(line);
        y += 24;
        stack.length = depth + 1;
        if (owner.el === root) root.append(row);
        else {
          let kids = owner.el.children.find((c) => c.cls.has('children'));
          if (!kids) { kids = el(['children']); kids.rect = { top: y, bottom: y, height: 0, left, right: x0 + 584 }; owner.el.append(kids); }
          kids.append(row);
        }
        const node = opts.kind === 'document'
          ? { id: opts.id || 'tana:text:01docrow00000000000000000', kind: 'document', text: opts.text ?? key, editable: true, children: [] }
          : { id: key, kind: 'block', block, text: opts.text ?? key, editable: opts.editable !== false, children: [], ...(opts.ref ? { reference: { uri: opts.ref } } : {}) };
        const item = { key, docId: opts.docId || 'd1', node, parent: owner.item };
        if (owner.item && owner.item.node.children) owner.item.node.children.push(node);
        items.set(key, item); elByKey.set(key, row);
        stack[depth + 1] = { el: row, item, left: left + (listRow ? 23 : 33) };
      }
      root.rect = { top: 0, bottom: y, height: y, left: x0, right: x0 + 584 };
    };
    outline.dataset.key = 'page'; fieldEl.dataset.key = 'field';
    build(outline, [['a', 0, 'paragraph'], ['b', 0, 'bullet'], ['c', 1, 'bullet'], ['d', 0, 'paragraph'],
      ['e', 0, 'bullet', { editable: false }], ['x', 0, 'bullet', { docId: 'd2' }], ['h', 0, 'heading2'],
      ['blank', 0, 'paragraph', { text: '' }], ['link', 0, 'bullet', { ref: 'tana:text:01target000000000000000000' }],
      ['row-doc', 0, 'bullet', { kind: 'document', id: 'tana:text:01docrow00000000000000000' }]], host('page', 'd1'));
    // the fields sit beside the outline in this harness, so a point says which of the two outlines it is in
    build(fieldEl, [['f', 0, 'paragraph', { docId: FIELD }], ['fdraft', 0, 'bullet', { docId: FIELD, draft: true }]], host('field', FIELD), 1016);
    const document = { elementFromPoint: (x) => (x >= 1000 ? fieldEl : outline) };
    const nodeElOf = (key) => elByKey.get(key) || null;
    const canEditStructure = (item) => !!item && item.node.editable !== false, canEditItem = canEditStructure;
    const hasKids = (item) => (item.node.children || []).length > 0;
    const childrenOf = (item) => item.node.children || [];
    const referenceTarget = (node) => (node.reference ? { id: node.reference.uri, text: 'Target' } : null);
    const isSearchDoc = (node) => String((node || {}).id || '').startsWith('tana:search:');
    const isSpace = (node) => String((node || {}).id || '').startsWith('tana:space:');
    const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
    const isGone = () => false;
    const tana = { moveTo: async () => {}, insertMention: async () => {} };
    ${sourceLine('const DRAG_STEP =')}
    ${sourceLine('const DRAG_STEP_LIST =')}
    ${sourceLine('const DRAG_GUTTER =')}
    ${sourceBetween('const BLOCK_TYPES = [', 'const BLOCK_GLYPH')}
    ${sourceLine('const blockTypeOf =')}
    ${sourceLine('const canInsertChild =')}
    ${sourceLine('const dragBase =')}
    ${sourceLine('const dragListable =')}
    ${sourceLine('const dragEmpty =')}
    ${sourceBetween('const canDragItem =', 'const dragLine =')}
    ${sourceLine('const dragLine =')}
    ${sourceLine('const rowDepth =')}
    ${functionSource('dropHost')}
    ${functionSource('dropDepth')}
    ${functionSource('dropPlan')}
    ({ plan: (key, x, y) => { dragKey = key; const plan = dropPlan(x, y); return plan && { docId: plan.docId, parentId: plan.parentId, afterId: plan.afterId, ref: plan.ref || null, left: plan.left, top: plan.top }; },
       canDrag: (key) => canDragItem(items.get(key)),
       inView: () => { outline.dataset.key = ''; } });
  `);

  // 1. One gap is several places, and the pointer's x says which: out to the level it was dragged to, behind the
  //    row that sits there, or one level inside the row above it. The line starts where that level's words start —
  //    the row's own column plus the gutter it keeps for a marker — so the top level lines up with ordinary text
  //    rather than with a bullet hanging left of it.
  assert.deepEqual(plain(api.plan('a', 6, 80)), { docId: 'd1', parentId: null, afterId: 'b', ref: null, left: 32, top: 72 }, 'far left: out of the list, behind the row that owns it');
  assert.deepEqual(plain(api.plan('a', 30, 80)), { docId: 'd1', parentId: null, afterId: 'c', ref: null, left: 55, top: 72 }, 'one level in: behind the row it was dropped under');
  assert.deepEqual(plain(api.plan('a', 60, 80)), { docId: 'd1', parentId: 'c', afterId: null, ref: null, left: 78, top: 72 }, 'further right: the first row inside it');

  // 2. The gap between a row and its own first child can only mean one thing, whatever x says, and the line is
  //    drawn against the children box that is already on screen.
  assert.deepEqual(plain(api.plan('a', 6, 40)), { docId: 'd1', parentId: 'b', afterId: null, ref: null, left: 55, top: 48 }, 'above a row\u2019s first child there is one level to land on');
  assert.equal(plain(api.plan('a', 400, 40)).parentId, 'b');

  // 3. Above every row is the top of the outline it is drawn in — the page, or a field, which is an outline of the
  //    same document. A view has no top to land on: its rows are documents, and a block is not one.
  assert.deepEqual(plain(api.plan('a', 20, 5)), { docId: 'd1', parentId: null, afterId: null, ref: null, left: 32, top: 0 }, 'the top of the page');
  assert.deepEqual(plain(api.plan('a', 1020, 5)).docId, 'd1|tana:type:01j0typ0000000000000000000?attribute=n5e1hgxz', 'and the top of a field, which is where a row dragged out of the page lands');
  // The empty row a field keeps to type in is not in the document yet, so nothing can land behind it: a drop aimed
  // at it lands behind the last row that is really there.
  assert.equal(plain(api.plan('a', 1020, 60)).afterId, 'f', 'a draft row is not a place to land');

  // 4. Nothing lands on a read-only row, in another document, or inside the row being dragged.
  assert.equal(api.plan('a', 20, 112), null, 'a read-only row is nobody\u2019s neighbour');
  assert.equal(api.plan('a', 20, 136), null, 'and a row of another document is not a place: a block belongs to the node that holds it');
  assert.deepEqual(plain(api.plan('b', 6, 60)), { docId: 'd1', parentId: null, afterId: 'a', ref: null, left: 32, top: 24 }, 'the row being dragged, and everything under it, is not a target');

  // 5. A heading cannot be a list row, so it is not offered a place inside one; beside one it is, and the write
  //    splits the list there (sdk/content.js place).
  assert.equal(api.plan('h', 60, 80), null, 'a heading is not offered as somebody\u2019s child');
  assert.equal(plain(api.plan('h', 30, 80)).afterId, 'c', 'but beside a list row it is');

  // 6. A view, where the top level is documents rather than rows of one.
  api.inView();
  assert.equal(api.plan('a', 20, 5), null, 'the top of a view is not a place for a block');

  // 7. What can be picked up: a writable block with something in it, and any real document row — never a
  //    read-only row, and never an empty line, which has nothing to take hold of.
  assert.deepEqual([api.canDrag('a'), api.canDrag('h'), api.canDrag('row-doc'), api.canDrag('e'), api.canDrag('blank')], [true, true, true, false, false],
    'a read-only row and an empty line are not dragged; a document row is');
  assert.match(source, /if \(canDragItem\(item\)\) \(parent\?\.node\?\.timeline\?\.today \? line : bullet\)\.draggable = true;/, 'and it is the row\u2019s own marker that carries it, or the line of a task under Today\u2019s Tasks');
  // Chromium begins a drag from the mousedown default, so the marker that can be dragged must not prevent it —
  // this is the line that decides whether a drag starts at all.
  assert.match(source, /bullet\.onmousedown = \(e\) => \{ if \(!bullet\.draggable\) e\.preventDefault\(\); \};/, 'a draggable marker lets the press through');

  // 8. A document row never moves into an outline — it lives in Tana, not inside this node — so what lands is a
  //    reference to it, and it may land in another document, which a move may not.
  const linked = plain(api.plan('row-doc', 30, 80));
  assert.deepEqual(linked.ref, { uri: 'tana:text:01docrow00000000000000000', label: 'row-doc' }, 'a dragged document lands as a reference to itself');
  assert.equal(linked.afterId, 'c');
  assert.equal(plain(api.plan('row-doc', 20, 136)).docId, 'd2', 'and a reference may land in another document');
  assert.equal(api.plan('a', 100, 236), null, 'nothing lands inside a document row until it is expanded');

  // 9. What was picked up decides the write, and nothing else does: a block moves even when it is a row that
  //    points at a document, because the row is the thing being dragged.
  assert.equal(plain(api.plan('link', 30, 80)).ref, null, 'a row that points at a document still moves: it is a block like any other');
  assert.equal(plain(api.plan('link', 30, 80)).afterId, 'c');
  console.log('ok  drag and drop: one gap reads as several places, x chooses the level and the line marks it, documents land as references, blocks move, and nothing lands read-only, empty, in another document, in a view or inside itself');
}

// A task dropped on a group (renderer/drag.js groupDropWrites, #169): the writes that put it there, read off the task.
function runGroupDropCheck() {
  const writes = vm.runInNewContext(`${sourceLine('const GROUP_STATES =')}\n${functionSource('groupDropWrites')}\ngroupDropWrites`);
  const ME = 'me', OTHER = 'other', DAY = '2026-09-26';
  const task = (o) => ({ createdBy: ME, assignees: [], watched: false, dates: [], agent: false, stateType: 'open', ...o });
  const at = (target, o) => plain(writes(target, task(o), ME, DAY));
  const tracked = { assignees: [OTHER], watched: true };
  assert.deepEqual(at('Pinned', tracked), [['pin', DAY]], 'watched to Pinned pins it to today and keeps the watch');
  assert.deepEqual(at('Mine', tracked), [['assign', [ME]], ['watch', null]], 'watched to Mine takes it over and forgets the watch');
  assert.deepEqual(at('Mine', { assignees: [ME], dates: ['2026-09-30', DAY], agent: true }), [['agent', false], ['unpin', '2026-09-30'], ['unpin', DAY]], 'leaving Pinned or Agent lets go of every pin and the agent');
  assert.deepEqual(at('My completed', { assignees: [ME] }), [['state', 'closed']], 'a status group sets the status');
  assert.deepEqual(at('Pinned', { dates: [DAY], stateType: 'closed' }), [['state', 'open']], 'a completed pinned task dropped on Pinned reopens');
  assert.deepEqual(at('Pinned', { agent: true }), [['agent', false], ['pin', DAY]], 'and one with the agent leaves it, since Agent comes first');
  assert.deepEqual(at('Tracking', { assignees: [OTHER] }), [['watch', true]], 'Tracking watches a task you handed over');
  assert.equal(at('Tracking', { assignees: [ME] }), null, 'but cannot say who to hand yours to');
  assert.deepEqual(at('Unassigned', { assignees: [ME] }), [['assign', []]], 'Unassigned clears the assignees');
  assert.equal(at('Mine', { createdBy: OTHER, assignees: [ME] }), null, 'a task someone else made stays under Assigned by others');
  assert.deepEqual(at('Today', { dates: ['2026-09-20'] }), [], 'Today leaves a task already on it alone');
  assert.deepEqual(at('Today', { dates: ['2026-09-20'], stateType: 'closed' }), [['pin', DAY]], 'but pins a completed one that has aged off it');
  assert.deepEqual(at('Agent', {}), [['agent', true]], 'Agent asks for a prompt');
  assert.deepEqual(at('Mine', { assignees: [ME] }), [], 'a drop in its own group writes nothing');
  console.log('ok  group drop: each group writes what puts a task there, lets go of what held it elsewhere, and refuses what a drop cannot say');
}

// Tables (renderer/table.js): a table row draws Tana's grid — header cells, spans, a resized width — with each cell's
// first paragraph editable only where the document is, written once over api.setCell, and keys that walk the cells.
async function runTableCheck() {
  const src = ['tableEl', 'cellInput', 'saveCell', 'tableGrid', 'cellBeside', 'cellKey', 'cellImage', 'cellPaste', 'tableRows', 'tableAction'].map(functionSource).join('\n') + '\n' + sourceLine('const cellPending') + '\n' + sourceBetween('const TABLE_ROWS', 'function tableRows');
  const api = vm.runInNewContext(`
    let focusedEl = null, caret = null, moved = null;
    const writes = [], timers = [];
    const mk = (tag) => ({
      tagName: tag.toUpperCase(), childNodes: [], dataset: {}, listeners: {}, parentElement: null,
      style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
      classList: { set: new Set(), add(...n) { n.forEach((x) => this.set.add(x)); }, contains(n) { return this.set.has(n); } },
      get className() { return [...this.classList.set].join(' '); }, set className(v) { this.classList.set = new Set(String(v).split(' ').filter(Boolean)); },
      get isContentEditable() { return this.contentEditable === 'plaintext-only'; },
      get textContent() { return (this.segs || []).map((s) => s.text).join(''); }, set textContent(v) { this.segs = [{ text: v }]; },
      append(...kids) { for (const c of kids) { c.parentElement = this; this.childNodes.push(c); } },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      querySelectorAll(sel) { const out = [], walk = (e) => { for (const c of e.childNodes) { if (c.classList.contains('cell') && (sel === '.cell' || c.isContentEditable)) out.push(c); walk(c); } }; walk(this); return out; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      closest(sel) { for (let e = this; e; e = e.parentElement) if (sel === '.cell' ? e.classList.contains('cell') : e.tagName === 'TABLE') return e; return null; },
      get rows() { return this.childNodes; }, get cells() { return this.childNodes; },
      get rowIndex() { return this.parentElement.childNodes.indexOf(this); }, get cellIndex() { return this.parentElement.childNodes.indexOf(this); },
      focus() { focusedEl = this; },
    });
    const document = { createElement: mk };
    const ops = [], inserted = [], opened = [], placed = [], images = new Map();
    let palReturn = null;
    const items = new Map(), openImage = (n) => opened.push(n.id), showError = (e) => { throw e; }, placeCell = (...a) => placed.push(a);
    const tana = { setCell: async (...a) => { writes.push(a); }, tableOp: async (...a) => { ops.push(a); return 'new1'; }, insertImage: async (...a) => { inserted.push([a[0], a[1], a[2].mimeType]); }, image: async (uri) => 'data:' + uri };
    const canEditStructure = (item) => item.writable;
    const renderSegs = (el, segs) => { el.segs = segs; }, readSegs = (el) => el.segs, plainOf = (segs) => segs.map((s) => s.text).join(''), saveValue = plainOf;
    const run = (fn) => fn(), reload = async () => {}, render = () => {}, unanchored = (s) => s;
    const setTimeout = (fn) => timers.push(fn), clearTimeout = () => {};
    const caretOffset = () => 0, getSelection = () => ({ isCollapsed: true }), atEdge = () => true;
    const setCaret = (el, off) => { caret = [el, off]; }, moveTo = (el, dir, off) => { moved = [el, dir, off]; };
    ${src}
    const cell = (id, text, extra = {}) => ({ id, header: false, colspan: 1, rowspan: 1, colwidth: null, paragraph: id && id + 'p', segments: text ? [{ text }] : [], text, blocks: [{ id: id && id + 'p', text }], ...extra });
    const item = (writable) => ({ docId: 'd1', key: 'd1/t', writable, node: { table: { rows: [
      [cell('h1', 'Owner', { header: true, colwidth: [80, 40] }), cell('h2', 'Status', { header: true })],
      [cell('c1', 'Robin', { colspan: 2, blocks: [{ id: 'c1p', text: 'Robin' }, { id: 'x', text: 'second paragraph' }] })],
      [cell(undefined, 'no id'), cell('c3', '')],
    ] } } });
    const draw = (writable) => { const it = item(writable), row = mk('span'), table = tableEl(it); row.append(table); return { it, row, table }; };
    const key = (table, target, k, mods = {}) => { let prevented = false; caret = moved = focusedEl = null; table.listeners.keydown({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods, target, preventDefault: () => { prevented = true; } }); return { prevented, caret, moved, focused: focusedEl }; };
    const drawRows = (rows, writable = true) => { const it = { docId: 'd1', key: 'd1/t', writable, node: { table: { rows } } }, row = mk('span'), table = tableEl(it); row.append(table); items.set(it.key, it); return { it, row, table }; };
    const rowsAt = (cellId) => { palReturn = { key: 'd1/t', cell: cellId }; return tableRows().map((r) => [r.id, r.disabled]); };
    const tick = async () => { for (let i = 0; i < 10; i++) await null; };
    ({ draw, drawRows, cell, key, writes, timers, ops, inserted, opened, placed, rowsAt, tick, run: (id) => { palReturn = { key: 'd1/t', cell: id }; return tableRows(); }, cellsOf: (table) => table.querySelectorAll('.cell') });
  `);
  const { table, row } = api.draw(true), cells = api.cellsOf(table);
  const [h1, h2, c1, , c3] = cells;
  assert.deepEqual(plain(table.childNodes.map((tr) => tr.childNodes.map((td) => td.tagName))), [['TH', 'TH'], ['TD'], ['TD', 'TD']], 'header cells are th, data cells td');
  assert.equal(c1.parentElement.colSpan, 2, 'a colspan carries over');
  assert.equal(h1.parentElement.style.props.width, '120px', 'a resized cell keeps its width: one per column it spans');
  assert.deepEqual(plain(cells.map((c) => c.isContentEditable)), [true, true, true, false, true], 'every cell with an id is editable in a writable document');
  assert.deepEqual(plain(c1.parentElement.childNodes.slice(1).map((n) => [n.className, n.textContent, n.isContentEditable])), [['more', 'second paragraph', false]], 'the rest of a cell shows, read-only');
  assert.deepEqual(plain(api.cellsOf(api.draw(false).table).map((c) => c.isContentEditable)), [false, false, false, false, false], 'a read-only document draws a table with nothing to edit');

  // typing is saved once, debounced, and only when it changed something
  c1.segs = [{ text: 'Robin Vega' }];
  table.listeners.input({ target: c1 });
  assert.equal(api.writes.length, 0, 'nothing is written on the keystroke');
  api.timers.shift()();
  assert.deepEqual(plain(api.writes), [['d1', 'c1', 'Robin Vega', true]], 'the cell is written by its own id, as typed here (#265)');
  table.listeners.input({ target: c1 }); api.timers.shift()();
  table.listeners.focusout({ target: c1 });
  assert.equal(api.writes.length, 1, 'the same text is not written twice');

  // keys: Tab walks the editable cells, arrows cross rows by column, the edges leave the table, Escape returns to the row
  assert.equal(api.key(table, h1, 'Tab').caret[0], h2, 'Tab: the next cell');
  assert.equal(api.key(table, h2, 'Tab').caret[0], c1, 'across the row end');
  assert.equal(api.key(table, h1, 'Tab', { shiftKey: true }).focused, row, 'Shift+Tab before the first cell: back to the table row');
  assert.equal(api.key(table, c3, 'Tab').focused, row, 'and Tab past the last one');
  assert.equal(api.key(table, h2, 'ArrowDown').caret[0], c1, 'Down: the same column, clamped to a shorter row');
  assert.deepEqual(plain(api.key(table, c3, 'ArrowDown').moved.slice(1)), [1, 0], 'Down from the last row: out to the outline row below');
  assert.equal(api.key(table, c1, 'ArrowUp').caret[0], h1, 'Up: the row above');
  const esc = api.key(table, c1, 'Escape');
  assert.equal(esc.focused, row); assert.equal(esc.prevented, true, 'Escape: the table row, which moves and deletes like an image');
  const enter = api.key(table, c1, 'Enter');
  assert.deepEqual([enter.prevented, enter.caret, enter.moved], [true, null, null], 'Enter adds nothing: a cell is one paragraph');
  assert.equal(api.key(table, c1, 'k', { metaKey: true }).prevented, false, '⌘ keys go on to the document handler');
  assert.match(source, /if \(!el \|\| e\.target\.classList\?\.contains\('cell'\)\) return;/, 'the row handler leaves a cell\u2019s keys alone');
  assert.match(source, /e\.key === 'Enter' && item\.node\.table\) enterTable\(el\)/, 'Enter on the table row goes into its first cell');
  // merged cells: Up/Down follow the column you see, not the cell's place in its row (a rowspan above shifts it)
  const merged = api.drawRows([[api.cell('a', 'A', { rowspan: 2 }), api.cell('b', 'B')], [api.cell('c', 'C')], [api.cell('d', 'D'), api.cell('e', 'E')]]);
  const [ma, mb, mc, md, me] = api.cellsOf(merged.table);
  assert.equal(api.key(merged.table, mb, 'ArrowDown').caret[0], mc, 'Down from the right column lands in the right column');
  assert.equal(api.key(merged.table, mc, 'ArrowDown').caret[0], me, 'and stays there past the merged cell, where a count of cells would land left');
  assert.equal(api.key(merged.table, ma, 'ArrowDown').caret[0], md, 'Down from a cell two rows tall: the row after both');
  assert.equal(api.key(merged.table, me, 'ArrowUp').caret[0], mc, 'Up: the same column');
  assert.equal(api.key(merged.table, md, 'ArrowUp').caret[0], ma, 'Up into a merged cell');
  // an image in a cell is drawn after its text, and opens like an image row
  const pic = api.drawRows([[api.cell('p', 'Pic', { blocks: [{ id: 'pp', text: 'Pic' }, { id: 'img1', type: 'image', image: { uri: 'tana:image:x' } }] })]]);
  const img = pic.table.childNodes[0].childNodes[0].childNodes[1];
  assert.equal(img.className, 'cellimg'); await api.tick(); assert.equal(img.src, 'data:tana:image:x', 'the picture, through api.image');
  img.onclick({ stopPropagation() {} }); assert.deepEqual(plain(api.opened), ['img1'], 'a click opens it');
  // pasting an image into a cell uploads it into that cell; a paste without one is left to the text
  let prevented = false; const file = { type: 'image/png', name: 'a.png', arrayBuffer: async () => new ArrayBuffer(2) };
  pic.table.listeners.paste({ target: api.cellsOf(pic.table)[0], clipboardData: { files: [file] }, preventDefault: () => { prevented = true; } });
  await api.tick(); await api.tick();
  assert.deepEqual([prevented, plain(api.inserted)], [true, [['d1', 'p', 'image/png']]], 'into the cell, by its id');
  prevented = false; pic.table.listeners.paste({ target: api.cellsOf(pic.table)[0], clipboardData: { files: [] }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'text pastes as text');
  // Cmd+K in a cell: rows and columns around it, disabled where Tana's table menu would not offer them
  api.drawRows([[api.cell('h', 'H', { header: true }), api.cell('h2', 'H2', { header: true })], [api.cell('r1', 'x'), api.cell('r2', 'y')]]);
  const at = (id) => Object.fromEntries(api.rowsAt(id).map(([k, off]) => [k.replace('table:', ''), off]));
  assert.deepEqual(at('h'), { rowBefore: true, rowAfter: false, rowUp: true, rowDown: true, deleteRow: true, columnBefore: false, columnAfter: false, columnLeft: true, columnRight: false, deleteColumn: false },
    'the header row: no row above it, and it is not moved or deleted');
  assert.deepEqual([at('r1').deleteRow, at('r1').rowUp, at('r2').columnRight, at('r2').columnLeft], [true, true, true, false], 'the last body row stays; a body row does not go above the header; edges');
  api.run('r1').find((r) => r.id === 'table:columnAfter').run(); await api.tick();
  assert.deepEqual(plain([api.ops, api.placed]), [[['d1', 'r1', 'columnAfter']], [['d1/t', 'new1', 0]]], 'one api.tableOp, and the caret goes to the cell it names');
  assert.equal(api.drawRows([[api.cell('z', 'z')]], false) && api.run('z').length, 0, 'nothing is offered in a document you cannot write');
  console.log('ok  tables: th/td, spans and widths, cells editable only where the document is, one debounced write per change, keys walk the cells by the grid, images and pasted images in cells, Cmd+K rows and columns');
}

// Red until the checks actually settle: an async check left awaiting something that never resolves empties the event
// loop, and node would exit 0 without a word — a silent pass for a check that never finished.
checks.push(runDropPlanCheck);
checks.push(runGroupDropCheck);
// Notifications (issue #18; renderer/inbox.js). A row is Tana's own: a click opens what it is about and marks it read,
// the way Tana's list does; its bullet and Cmd+K flip read and unread for the rows you are on; Mark all as read
// clears the page. Every change is drawn before main answers, and the count follows it. A source with no page here
// (a type) opens in Tana instead of an empty page.
function runNotificationsCheck() {
  const api = vm.runInNewContext(`
    const INBOX_PAGE = 'orbital:notifications';
    const calls = [], went = [];
    let inboxUnread = 2, rendered = 0;
    const renderSoon = () => { rendered++; };
    const run = (fn) => fn();
    const goTo = (uri) => went.push(uri);
    const zoomable = (node) => !/^tana:(user-profile|type):/.test(node.id || '');
    const tana = {
      inboxSetRead: async (id, read) => { calls.push(['setRead', id, read]); return 7; },
      inboxMarkAll: async () => { calls.push(['markAll']); return 0; },
      nodeLink: async (uri) => 'https://home.tana.inc/x/' + uri, openExternal: async (url) => { went.push(url); },
    };
    const note = (id, unread, type, sourceUri) => ({ id, kind: 'block', unread, notification: { type, sourceUri } });
    const rows = [note('n0', true, 'task-assignment', 'tana:text:01task00000000000000000000'), note('n1', true, 'event-access', 'tana:event:01event0000000000000000000'),
      note('n2', false, 'type-archived', 'tana:type:01type00000000000000000000')];
    const kids = new Map([[INBOX_PAGE, rows]]);
    const items = new Map(rows.map((n) => [n.id, { key: n.id, node: n }]));
    let selected = [], palReturn = null;
    const selKeys = () => selected, focused = () => null;
    ${functionSource("setNotificationRead")}
    ${functionSource("markAllNotificationsRead")}
    ${functionSource("openNotification")}
    ${functionSource("notificationRows")}
    const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
    ({
      rows, calls, went, count: () => inboxUnread, rendered: () => rendered,
      open: async (i) => { openNotification(rows[i]); await settle(); },
      bullet: async (i) => { setNotificationRead(rows[i], !!rows[i].unread); await settle(); },
      palette: (keys, at) => { selected = keys; palReturn = at ? { key: at } : null; return notificationRows().map((r) => [r.group, r.label]); },
      press: async (keys, label) => { selected = keys; notificationRows().find((r) => r.label === label).run(); await settle(); },
      all: async () => { markAllNotificationsRead(); await settle(); },
    });
  `);
  return (async () => {
    await api.open(0);
    assert.deepEqual(plain(api.calls), [['setRead', 'n0', true]], 'opening an unread notification marks it read, as Tana does');
    assert.deepEqual(plain(api.went), ['tana:text:01task00000000000000000000'], 'and goes to what it is about');
    assert.equal(api.rows[0].unread, false, 'the row is drawn read before main answers');
    assert.equal(api.count(), 7, 'and the count is main\'s answer once it comes');
    await api.open(2);
    assert.equal(api.calls.length, 1, 'a read notification is opened without another write');
    assert.equal(api.went.at(-1), 'https://home.tana.inc/x/tana:type:01type00000000000000000000', 'a type has no page here, so it opens in Tana');
    await api.bullet(0);
    assert.deepEqual(plain(api.calls.at(-1)), ['setRead', 'n0', false], 'the bullet of a read row marks it unread');
    assert.equal(api.rows[0].unread, true);
    assert.deepEqual(plain(api.palette([], 'n1')), [['Current node', 'Mark as read']], 'Cmd+K offers what the row the caret was on can become');
    assert.deepEqual(plain(api.palette([], 'n2')), [['Current node', 'Mark as unread']]);
    assert.deepEqual(plain(api.palette(['n1', 'n2'], null)), [['Selection', 'Mark as read'], ['Selection', 'Mark as unread']], 'a mixed selection is offered both');
    assert.deepEqual(plain(api.palette([], null)), [], 'and nothing when no notification is under the caret');
    const before = api.calls.length;
    await api.press(['n0', 'n1', 'n2'], 'Mark as read');
    assert.deepEqual(plain(api.calls.slice(before)), [['setRead', 'n0', true], ['setRead', 'n1', true]], 'Mark as read writes only the rows that were unread');
    api.rows[1].unread = true;
    await api.all();
    assert.deepEqual(plain(api.calls.at(-1)), ['markAll'], 'Mark all as read is one write');
    assert.deepEqual(plain(api.rows.map((n) => n.unread)), [false, false, false], 'and every row is drawn read at once');
    assert.equal(api.count(), 0);
    console.log('ok  notifications: opening reads and navigates, the bullet and Cmd+K flip read state, Mark all as read clears the page');
  })();
}
checks.push(runNotificationsCheck);

// Proposals (issue #19; renderer/proposals.js): approving or rejecting takes the row off the page before main answers, a
// refusal reads the page back and says why, a rejection's leftovers are reported, and Approve is only live where
// Orbital can approve — elsewhere it stays listed, disabled, saying where to do it.
function runProposalsCheck() {
  const api = vm.runInNewContext(`
    const PROPOSALS_PAGE = 'orbital:proposals';
    const calls = [], errors = [];
    let refuse = null;
    const renderSoon = () => {};
    const run = (fn) => fn().catch((e) => { errors.push(e.message); });
    const showError = (e) => { if (e) errors.push(e.message); };
    const row = (id, operation) => ({ id, kind: 'document', editable: false, proposal: { chatUri: 'tana:chat:c', proposedUri: id, operation, approvable: operation === 'create' } });
    const rows = [row('p0', 'create'), row('p1', 'create'), row('p2', 'update')];
    const kids = new Map([[PROPOSALS_PAGE, rows.slice()]]);
    const reload = async (id) => { calls.push(['reload']); kids.set(id, rows.slice()); };
    const tana = { proposalAnswer: async (chatUri, proposedUri, approve) => {
      calls.push([approve ? 'approve' : 'reject', proposedUri]);
      if (refuse) throw new Error(refuse);
      return proposedUri === 'p1' ? ['Could not delete p1'] : [];
    } };
    const items = new Map(rows.map((n) => [n.id, { key: n.id, node: n }]));
    let selected = [], palReturn = null;
    const selKeys = () => selected, focused = () => null;
    ${functionSource("answerProposal")}
    ${functionSource("proposalRows")}
    const collapsedGroups = new Set(), prefs = [], render = () => {};
    const setPref = (key, value) => prefs.push([key, value]);
    ${sourceLine('const PROPOSAL_GROUPS')}
    ${sourceLine('const PROPOSAL_FOLDED')}
    ${sourceLine('const proposalFoldKey')}
    ${functionSource("proposalGroups")}
    ${functionSource("toggleProposalGroup")}
    const filed = (id, group) => ({ id, proposal: { group } });
    const sections = (list) => proposalGroups(list).map((g) => [g.title, g.nodes.map((n) => n.id), g.collapsed]);
    const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const page = () => (kids.get(PROPOSALS_PAGE) || []).map((n) => n.id);
    ({
      calls, errors, page, prefs, filed, sections, fold: (title) => proposalGroups([filed('x', title)])[0].toggle(),
      answer: async (i, approve, why) => { refuse = why || null; answerProposal(rows[i], approve); const shown = page(); await settle(); return shown; },
      palette: (keys, at) => { selected = keys; palReturn = at ? { key: at } : null; return proposalRows().map((r) => [r.group, r.label, !!r.disabled]); },
      press: async (keys, label) => { refuse = null; selected = keys; proposalRows().find((r) => r.label === label).run(); await settle(); },
    });
  `);
  return (async () => {
    assert.deepEqual(plain(await api.answer(0, true)), ['p1', 'p2'], 'an approved row leaves the page before main answers');
    assert.deepEqual(plain(api.calls), [['approve', 'p0']]);
    await api.answer(2, true);
    assert.equal(api.calls.length, 1, 'a proposal Orbital cannot approve is never sent');
    assert.deepEqual(plain(await api.answer(1, false)), ['p2'], 'a rejected row leaves the page too');
    assert.deepEqual(plain(api.errors), ['Could not delete p1'], 'and what could not be cleaned up is said');
    assert.deepEqual(plain(await api.answer(2, false, 'That chat is gone')), [], 'the row leaves at once');
    assert.deepEqual(plain(api.calls.slice(-2)), [['reject', 'p2'], ['reload']], 'and when main refuses, the page is read back');
    assert.deepEqual(plain(api.page()), ['p0', 'p1', 'p2']);
    assert.equal(api.errors.at(-1), 'That chat is gone', 'with the reason on screen');
    assert.deepEqual(plain(api.palette([], 'p2')), [['Current node', 'Approve proposal', true], ['Current node', 'Reject proposal', false]],
      'Cmd+K lists Approve disabled on a change Tana merges, so its key still has a row');
    assert.deepEqual(plain(api.palette(['p0', 'p2'], null)), [['Selection', 'Approve proposal', false], ['Selection', 'Reject proposal', false]]);
    assert.deepEqual(plain(api.palette([], null)), [], 'and nothing when no proposal is under the caret');
    const before = api.calls.length;
    await api.press(['p0', 'p2'], 'Approve proposal');
    assert.deepEqual(plain(api.calls.slice(before)), [['approve', 'p0']], 'approving a selection sends only the ones Orbital can approve');
    // The page's parts (issues #104, #107): yours first with no heading, then From others, folded until you open it
    // and remembered under the page's own key.
    const list = [api.filed('o1', 'others'), api.filed('m1', 'mine'), api.filed('o2', 'others')];
    assert.deepEqual(plain(api.sections(list)), [['', ['m1'], false], ['From others', ['o1', 'o2'], true]],
      'yours comes first without a heading, each part keeps the page\'s order, and From others starts folded');
    assert.deepEqual(plain(api.sections([api.filed('o1', 'others')]).map((g) => g[0])), ['From others'], 'an empty part is not drawn');
    api.fold('others');
    assert.deepEqual(plain(api.sections(list).map((g) => g[2])), [false, false], 'From others opens');
    assert.deepEqual(plain(api.prefs.at(-1)), ['collapsedGroups', ['orbital:proposals\nopen\nothers']], 'and is remembered under the Proposals page, whichever view is behind it');
    api.fold('others');
    assert.deepEqual(plain(api.sections(list).map((g) => g[2])), [false, true]);
    console.log('ok  proposals: approve and reject leave the page at once, a refusal reads it back with the reason, Cmd+K approves only what Orbital can, sections fold under the page');
  })();
}
checks.push(runProposalsCheck);

// Change time / Change location / Add attendee (renderer/meeting.js): offered on a meeting only once main says it
// may be changed, and each page's one row is what Enter writes through api.editMeeting.
async function runMeetingEditCheck() {
  const api = vm.runInNewContext(`
    const calls = [];
    let palMode = 'cmd', palRows = [], palIndex = 0, palBusy = false, members = null, closed = 0, renders = 0;
    const palette = { hidden: false }, palInput = { value: '', placeholder: '', focus() {} };
    const renderPalette = () => { renders++; }, closePalette = () => { closed++; palette.hidden = true; }, run = (fn) => fn();
    const MEET = 'tana:event:m';
    const start = new Date(2026, 8, 22, 10).getTime();
    // a write-up page names its meeting through the sidebar's hub; a space hub is not a meeting
    const relatedBy = new Map([['tana:text:w', { pinHub: MEET }], ['tana:text:s', { pinHub: 'tana:space:s' }]]);
    let editable = true, allDay = false, info = () => ({ id: MEET, editable, start, end: start + 18e5, allDay, location: 'Room 4',
      participants: ['tana:user-profile:me', 'tana:user-profile:sam'], attendees: [{ key: 'email:kim@x.nl', email: 'kim@x.nl' }] });
    const tana = {
      meetingInfo: async (id) => { calls.push(['info', id]); return info(); },
      editMeeting: async (id, change) => { calls.push(['edit', id, change]); const now = info(); return { ...now, participants: [...now.participants, ...(change.attendees || []).map((p) => p.userUri).filter(Boolean)] }; },
      attendeeSuggestions: async () => [{ email: 'sam@x.nl', displayName: 'Sam', identityUri: 'tana:user-profile:sam' }, { email: 'KIM@x.nl', displayName: 'Kim' },
        { email: 'dana@partner.nl', displayName: 'Dana' }, { email: 'priya@x.nl', displayName: 'Priya', identityUri: 'tana:user-profile:priya' }],
    };
    const membersLoaded = async () => { members = [{ id: 'tana:user-profile:me', title: 'Me', me: true }, { id: 'tana:user-profile:priya', title: 'Priya' }, { id: 'tana:user-profile:tomas', title: 'Tomas' }]; };
    const localDate = () => '2026-09-22', WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const demoMode = false, demoPersonName = (id) => id, demoText = (value) => value, memberName = (uri) => ((members || []).find((m) => m.id === uri) || {}).title || uri;
    ${functionSource('fuzzyMatch')}
    ${sourceBetween('const WEEKDAYS =', 'const PIN_DATE_GROUP')}
    ${withShims(fs.readFileSync(require.resolve('../renderer/meeting.js'), 'utf8').replace("'use strict';", ''))}
    const tick = () => new Promise(setImmediate);
    ({
      cmd: async (doc, canEdit = true, wholeDay = false) => { editable = canEdit; allDay = wholeDay; meetingCtx = null; calls.length = 0; meetingRows(doc, 'Current node'); await tick(); await tick(); return meetingRows(doc, 'Current node').map((r) => [r.id, r.label, r.hint]); },
      asked: () => JSON.parse(JSON.stringify(calls)),
      parse: (text) => { const t = parseMeetingTime(text, start, 18e5, new Date(2026, 8, 22, 12)); return t && [new Date(t.start).toString().slice(0, 21), (t.end - t.start) / 6e4]; },
      open: async (mode) => { openMeetingPage(mode, 'x'); await tick(); await tick(); return palMode; },
      rows: (typed) => palPage.rows(typed.toLowerCase(), typed).map((r) => [r.label, r.hint || '', !!r.disabled]),
      press: async (typed, i) => { calls.length = 0; closed = 0; palette.hidden = false; const r = palPage.rows(typed.toLowerCase(), typed)[i]; if (!r.keepOpen) closePalette(); r.run(); await tick(); await tick(); return { calls: JSON.parse(JSON.stringify(calls)), closed }; },
    });
  `, { setImmediate, Date, Promise });

  assert.deepEqual(plain(await api.cmd({ id: 'tana:text:t', icon: 'task' })), [], 'nothing on a document that is not a meeting');
  assert.deepEqual(plain(await api.cmd({ id: 'tana:event:m', icon: 'meeting' }, false)), [], 'nor on a meeting this user may not change');
  const rows = plain(await api.cmd({ id: 'tana:event:m', icon: 'meeting' }));
  assert.deepEqual(rows.map((r) => r[0]), ['meetingTime', 'meetingLocation', 'meetingAttendee'], 'three rows, each with an id so ⇧⌘K can give it a key');
  assert.deepEqual(rows.map((r) => r[2]), ['Tue 22 Sep 10:00\u201310:30', 'Room 4', '1 attendee'], 'each says what the meeting has now');
  assert.deepEqual(plain(await api.cmd({ id: 'tana:text:w', icon: 'doc' })).map((r) => r[0]), ['meetingTime', 'meetingLocation', 'meetingAttendee'],
    'a meeting opens at its write-up, and the rows follow it there');
  assert.deepEqual(plain(api.asked()), [['info', 'tana:event:m']], 'asking about the meeting the write-up lives in, not the write-up');
  assert.deepEqual(plain(await api.cmd({ id: 'tana:text:s', icon: 'doc' })), [], 'a document in a space is not in a meeting');
  assert.deepEqual(plain(await api.cmd({ id: 'tana:event:m', icon: 'meeting' }, true, true)).map((r) => r[0]), ['meetingLocation', 'meetingAttendee'],
    'an all-day meeting keeps its place and people, but its time is changed in its calendar');
  await api.cmd({ id: 'tana:event:m', icon: 'meeting' });

  // Tuesday 22 September 2026, 10:00–10:30: a day in Pin to date's words and/or a clock time
  assert.deepEqual(plain(['14:00', 'tomorrow 9:30', 'fri 10:00-11:30', 'tomorrow', '12 oct 8.15 to 9'].map(api.parse)), [
    ['Tue Sep 22 2026 14:00', 30], ['Wed Sep 23 2026 09:30', 30], ['Fri Sep 25 2026 10:00', 90], ['Wed Sep 23 2026 10:00', 30], ['Mon Oct 12 2026 08:15', 45]],
    'a start alone keeps the length, a day alone keeps the time of day');
  assert.deepEqual(plain(['', 'blah', '25:00', '14:00-13:00', 'blah 14:00'].map(api.parse)), [null, null, null, null, null], 'anything else reads as no time');

  assert.equal(await api.open('meetingTime'), 'meetingTime');
  assert.deepEqual(plain(api.rows('')), [['Type a day and/or a time: 14:00, tomorrow 9:30, fri 10:00-11:30', '', true]]);
  assert.deepEqual(plain(api.rows('xyz')), [['No time in \u201Cxyz\u201D', '', true]]);
  assert.deepEqual(plain(api.rows('14:00')), [['Tue 22 Sep 14:00\u201314:30', '\u21A9', false]], 'the row shows what Enter will write');
  const moved = plain(await api.press('14:00', 0));
  assert.deepEqual(moved.calls, [['edit', 'tana:event:m', { start: new Date(2026, 8, 22, 14).getTime(), end: new Date(2026, 8, 22, 14, 30).getTime() }]]);
  assert.equal(moved.closed, 1, 'and the palette closes');

  await api.open('meetingLocation');
  assert.deepEqual(plain(api.rows('')), [['Room 4', 'Current', true], ['Remove location', '', false]]);
  assert.deepEqual(plain((await api.press('Zoom', 0)).calls), [['edit', 'tana:event:m', { location: 'Zoom' }]]);
  assert.deepEqual(plain((await api.press('', 1)).calls), [['edit', 'tana:event:m', { location: '' }]], 'Remove location writes an empty one');

  await api.open('meetingAttendee');
  assert.deepEqual(plain(api.rows('')), [['Dana', 'dana@partner.nl', false], ['Priya', 'priya@x.nl', false], ['Tomas', 'Member', false]],
    'suggestions first, then members they do not name; nobody already there (by grant or by email), and not me');
  assert.deepEqual(plain(api.rows('partner')), [['Dana', 'dana@partner.nl', false]], 'an email matches too');
  assert.deepEqual(plain(api.rows('new@x.nl')), [['Add new@x.nl', '\u21A9', false]], 'a typed address is offered as itself');
  assert.deepEqual(plain(api.rows('zzz')), [['No one matches \u2014 type an email address to add it', '', true]]);
  const added = plain(await api.press('', 1));
  assert.deepEqual(added.calls, [['edit', 'tana:event:m', { attendees: [{ email: 'priya@x.nl', userUri: 'tana:user-profile:priya' }] }]]);
  assert.equal(added.closed, 0, 'the page stays open for the next person');
  assert.deepEqual(plain(api.rows('')).map((r) => r[0]), ['Dana', 'Tomas'], 'and whoever was just added leaves the list');

  assert.match(source, /rows\.push\(\.\.\.meetingRows\(palDoc, docGroup\)\)/, 'Cmd+K lists the rows');
  assert.match(source, /if \(palPage\.rows\) palRows = palPage\.rows\(q\.toLowerCase\(\), q\);/, 'renders the pages');
  assert.match(source, /meetingCtx = null; loadPins\(\)/, 'and asks again each time it opens');
  console.log('ok  meeting edits: rows only when editable, typed time and place, attendee suggestions and members');
}
checks.push(runMeetingEditCheck);
checks.push(runTableCheck);

// Fields that hold choices or links (renderer/fields.js, issue #33): what a pick writes. An options field holds one
// label unless it says multiple and a link field several unless it says single; a label the type no longer offers is
// listed so it can be taken off, and never written back, since Tana would refuse the whole value.
async function runFieldChoiceCheck() {
  const api = vm.runInNewContext(`
    const kids = new Map(), written = [];
    const tana = { setField: async (docId, key, lines) => { written.push(lines); } };
    const run = (fn) => fn(), reload = async () => {}, render = () => {}, palette = { hidden: true }, palMode = 'cmd', renderPalette = () => {};
    const segsOf = (v) => (Array.isArray(v) ? v : [{ text: String(v ?? '') }]);
    ${sourceLine('const plainOf')}
    ${sourceLine('const sameLabel')}
    ${sourceLine('const offered')}
    ${sourceLine('const holdsMany')}
    ${functionSource('choiceValues')}
    ${functionSource('writeChoice')}
    ${functionSource('optionRows')}
    ${functionSource('pickLink')}
    ${functionSource('openCellChooser')}
    const openChooser = (ctx) => { fieldCtx = ctx; };
    let fieldCtx = null;
    const ctxOf = (field, values) => { kids.set('host', values.map((segments) => ({ segments }))); return { docId: 'doc', hostId: 'host', key: 'k', field: { key: 'tana:type:t?attribute=a', ...field } }; };
    ({
      rows: (field, values) => { fieldCtx = ctxOf(field, values); return optionRows('').map((r) => [r.label, r.hint || '', !!r.keepOpen]); },
      pick: async (label) => { const row = optionRows('').find((r) => r.label === label); written.length = 0; await row.run(); return written[0]; },
      link: async (field, values, n) => { written.length = 0; await pickLink(ctxOf(field, values), n); return written[0]; },
      cell: async (node, label) => {
        openCellChooser(node, 'tana:type:t?attribute=a', { title: 'Level', type: 'options', options: [{ label: 'High' }, { label: 'Low' }] });
        const ticked = optionRows('').filter((r) => r.hint === '✓').map((r) => r.label);
        written.length = 0; await optionRows('').find((r) => r.label === label).run();
        return { ticked, written: written[0], fields: node.fields };
      },
    });
  `);
  const level = { type: 'options', label: 'Level', options: [{ label: 'High' }, { label: 'Low' }] };
  assert.deepEqual(plain(api.rows(level, [[{ text: 'Gone' }]])), [['Clear value', '', false], ['High', '', false], ['Low', '', false], ['Gone', 'No longer offered · ↩ removes it', false]],
    'the declared labels, then a stored one the type dropped');
  assert.deepEqual(plain(await api.pick('High')), ['High'], 'a single pick replaces the value, and the dropped label goes with it');
  api.rows({ ...level, cardinality: 'multiple' }, [[{ text: 'High' }]]);
  assert.deepEqual(plain(await api.pick('Low')), ['High', 'Low'], 'multiple: a pick adds');
  assert.deepEqual(plain(await api.pick('High')), [], 'and picking a ticked label takes it off');
  assert.deepEqual(plain(await api.pick('Clear value')), [], 'Clear value empties it');
  const a = [{ mention: { label: 'A', uri: 'tana:text:a', icon: 'doc', type: 'tana:type:x' } }], b = { id: 'tana:text:b', title: 'B' };
  assert.deepEqual(plain(await api.link({ type: 'link', cardinality: 'single' }, [a], b)), [[{ mention: { label: 'B', uri: 'tana:text:b' } }]], 'a single link is replaced');
  assert.deepEqual(plain(await api.link({ type: 'link' }, [a], b)), [[{ mention: { label: 'A', uri: 'tana:text:a' } }], [{ mention: { label: 'B', uri: 'tana:text:b' } }]],
    'unset allows several: one more line, written as a bare reference');
  assert.deepEqual(plain(await api.link({ type: 'member' }, [a], { id: 'tana:text:a', title: 'A' })), [[{ mention: { label: 'A', uri: 'tana:text:a' } }]], 'linking what is there already adds nothing');
  assert.deepEqual(plain(await api.cell({ id: 'tana:text:r', fields: { 'tana:type:t?attribute=a': ['High'] } }, 'Low')),
    { ticked: ['High'], written: ['Low'], fields: { 'tana:type:t?attribute=a': ['Low'] } }, 'a table cell picks from its row’s value, and the row shows the new one at once');
  console.log('ok  field choices: options pick one or toggle many, a dropped label is shown but never written, links replace or add');
}
checks.push(runFieldChoiceCheck);
// A deferred render still brings every checkbox up to date (refreshRowChrome), from the rows the views hold now: the
// first copy of a document wins, as it always did, and the lookup is one table per call rather than a rebuild of every
// view's rows per row on screen (#263).
function runRowChromeCheck() {
  const api = vm.runInNewContext(`
    const el = (key) => { const classes = new Set(); return { dataset: { key }, classes, classList: { toggle: (n, on) => (on ? classes.add(n) : classes.delete(n)) } }; };
    const rowOf = (key) => { const row = el(key), check = el(); row.check = check; row.querySelector = () => check; return row; };
    const rows = [rowOf('tana:text:a'), rowOf('tana:text:b')];
    const outline = { querySelectorAll: () => rows };
    const railEl = { querySelectorAll: () => [] };
    const stale = (id) => ({ id, kind: 'document', done: 0, stateType: 'open' });
    const items = new Map(rows.map((r) => [r.dataset.key, { node: stale(r.dataset.key) }]));
    let built = 0;
    const views = [{ nodes: [{ ...stale('tana:text:a'), done: 1, stateType: 'closed' }, stale('tana:text:b')] }, { nodes: [stale('tana:text:a')] }];
    const allDocs = () => { built++; return views.flatMap((s) => s.nodes); };
    const extra = new Map(), relatedBy = new Map(), zoom = null, titleCheck = { hidden: true };
    const referenceTarget = () => null, isTask = () => true, acceptsFirst = () => false, railGroups = () => [], playTicks = () => {};
    ${functionSource('refreshRowChrome')}
    refreshRowChrome();
    ({ checked: rows.map((r) => r.check.checked), done: rows.map((r) => r.classes.has('done')), built });
  `);
  assert.deepEqual(plain(api.checked), [true, false], 'the box follows the fresh row, the first copy found winning over a later, stale one');
  assert.deepEqual(plain(api.done), [true, false], 'and so does the struck-through row');
  assert.equal(api.built, 1, 'every view\'s rows are gathered once per call, not once per row on screen');
  console.log('ok  deferred render: row chrome from one lookup of the fresh rows');
}
checks.push(runRowChromeCheck);
// A burst of metadata answers patches one row each, and each asks for the fit: it runs once in the next frame for all
// of them, not once per answer, which forced a layout of the whole outline every time (#264).
// A settings:changed sent before the page listened is lost (the first connect's read of the settings document can land
// while the page loads), so the page asks for the preferences once more after it starts listening.
async function runLateSettingsCheck() {
  const run = (snapshot, now, meanwhile) => vm.runInNewContext(`
    const prefs = ${JSON.stringify(snapshot)}, applied = [];
    const applySettings = (next) => applied.push(next);
    const tana = { prefsNow: async () => { Object.assign(prefs, ${JSON.stringify(meanwhile || {})}); return ${JSON.stringify(now)}; } };
    ${functionSource('catchUpSettings')}
    catchUpSettings();
    ({ applied: async () => { await null; await null; return applied; } });
  `);
  assert.deepEqual(plain(await run({}, { theme: 'dark', home: 'library' }).applied()), [{ theme: 'dark', home: 'library' }], 'a new machine\u2019s choices, read after the page loaded, are applied');
  assert.deepEqual(plain(await run({ theme: 'dark' }, { theme: 'dark' }).applied()), [], 'and nothing is applied when nothing changed');
  assert.deepEqual(plain(await run({ theme: 'light' }, { theme: 'light', home: 'library' }, { theme: 'dark' }).applied()), [{ theme: 'dark', home: 'library' }],
    'a choice made while the answer was on its way is newer, so it keeps its value, and the rest of the answer still applies');
  assert.match(source, /if \(tana\.onSettings\) tana\.onSettings\(applySettings\);\nif \(tana\.prefsNow\) catchUpSettings\(\);/, 'it asks after it starts listening, so no change can fall between the two');
  assert.match(functionSource('applySettings'), /railHidden = pref\('railHidden', false\) === true; railClosed\.clear\(\); for \(const key of pref\('railClosed', \[\]\)\) railClosed\.add\(key\);/,
    'and what it applies reaches the sidebar too, whose shown state and folded sections were copied at load');
  console.log('ok  settings: a change sent before the page listened is still applied');
}
checks.push(runLateSettingsCheck);
function runFitSoonCheck() {
  const api = vm.runInNewContext(`
    let fits = 0;
    const frames = [];
    const requestAnimationFrame = (fn) => frames.push(fn);
    const fitRowMeta = () => { fits++; };
    ${source.match(/let fitQueued = false;\nfunction fitRowMetaSoon\(\) \{[\s\S]*?\n\}/)[0]}
    ({ ask: () => fitRowMetaSoon(), frame: () => { const due = frames.splice(0); for (const fn of due) fn(); }, fits: () => fits });
  `);
  for (let i = 0; i < 40; i++) api.ask();
  assert.equal(api.fits(), 0, 'nothing is measured while the answers are still landing');
  api.frame();
  assert.equal(api.fits(), 1, 'forty answers in one frame cost one fit');
  api.ask(); api.frame();
  assert.equal(api.fits(), 2, 'and an answer in a later frame is fitted again');
  assert.match(source, /if \(patched\) fitRowMetaSoon\(\);/, 'patchMeta asks for the frame\'s fit rather than fitting at once');
  console.log('ok  metadata answers: one row-meta fit per frame');
}
checks.push(runFitSoonCheck);
// The Help tour's first start (renderer/overlays.js helpOnce): not over the login, and not by this machine's empty copy
// of the preferences when the settings document in Tana says it was seen elsewhere.
async function runHelpOnceCheck() {
  // each page has its own copy of the preferences; main's claim (main.js help:claim, checked in sdk-check) is shared,
  // and it is main that opens the tour, in the same step
  const pane = (claimHelp, side = '', connected = true) => vm.runInNewContext(`
    const SIDE = ${JSON.stringify(side)}, connected = ${connected}, prefs = {}, theme = 'light';
    let opened = 0;
    const pref = (key, fallback) => (key in prefs ? prefs[key] : fallback);
    const setPref = (key, value) => { prefs[key] = value; };
    const openHelp = () => { opened++; prefs.helpSeen = true; };
    const palette = { hidden: false }; let closedPalette = 0; const closePalette = () => { closedPalette++; palette.hidden = true; };
    ${functionSource('helpOnce')}
    ({ go: async () => { await helpOnce(); await helpOnce(); return { opened, seen: !!prefs.helpSeen }; }, closedPalette: () => closedPalette });
  `, { tana: claimHelp ? { claimHelp } : {} });
  const main = (seen) => { let asked = 0, shown = 0; const claim = async () => { asked++; await null; if (seen) return false; seen = true; shown++; return true; }; claim.asked = () => asked; claim.shown = () => shown; return claim; };
  const fresh = main(false), panes = [pane(fresh), pane(fresh)], both = await Promise.all(panes.map((p) => p.go()));
  assert.equal(fresh.shown(), 1, 'two windows coming up at once: main shows the tour in one of them');
  assert.deepEqual(both.map((b) => b.opened), [0, 0], 'and no page opens one of its own beside it');
  assert.equal(both.filter((b) => b.seen).length, 1, 'the page it was shown over notes it as seen');
  assert.deepEqual(panes.map((p) => p.closedPalette()), both.map((b) => (b.seen ? 1 : 0)), 'and closes a palette it had open, as opening the tour itself would');
  const seen = main(true); await pane(seen).go();
  assert.equal(seen.shown(), 0, 'seen on another machine: main says no, so a new one does not show it again');
  assert.deepEqual(plain(await pane(async () => { throw new Error('gone'); }).go()), { opened: 0, seen: false }, 'a claim that fails shows nothing and spends nothing: the next launch asks again');
  assert.deepEqual(plain(await pane(null).go()), { opened: 1, seen: true }, 'with no main to ask (the in-file mock) the page opens it itself');
  const quiet = main(false);
  assert.deepEqual(plain(await pane(quiet, ':2').go()), { opened: 0, seen: false }, 'the right half of the Work View stays quiet');
  assert.equal(quiet.asked(), 0, 'and does not claim it from the main half');
  assert.deepEqual(plain(await pane(quiet, '', false).go()), { opened: 0, seen: false }, 'signed out or not yet connected: no tour, over the login');
  assert.equal(quiet.asked(), 0, 'and no claim, which main could only answer from this machine\u2019s own copy');
  assert.doesNotMatch(source, /tana\.onOverlayClosed\(\(result\) => \{[^\n]*helpOnce\(\)/, 'a first start that found Create task open is main\u2019s to finish (closeOverlay), not the half that hears the close');
  assert.doesNotMatch(source, /then\(restorePlace\)\.then\(helpOnce\)/, 'boot no longer opens it before there is a connection, over the login');
  assert.match(source, /restorePlace\(\)\.finally\(\(\) => \{ placed = true; loadView\(\); renderSoon\(\); helpOnce\(\); \}\)/, 'it opens once connected, over the page the launch came back to');
  console.log('ok  Help tour first start: after login, once across windows, and not again on a machine that has not read your settings yet');
}
checks.push(runHelpOnceCheck);
// The palette over both halves of a split (issue #409): opening a centred page asks the shell to lay this page's iframe
// over the window, once; the page moves itself into its half only once it is wider than that half, so no frame is
// drawn out of place; the @ and / menus stay in the half; closing lets go once the scrim has faded, unless it opens
// again first. The half is the box Trellis gives the iframe (its parent), in the shell's pixels.
function runCoverCheck() {
  const pane = (half, framed = true) => vm.runInNewContext(`
    const asked = [], timers = [], classes = new Set(), vars = {};
    let box = { ...half }, innerWidth = half.width, innerHeight = half.height;
    const MOTION = { quick: 160 }, setTimeout = (fn) => { timers.push(fn); return timers.length; }, clearTimeout = (id) => { if (id) timers[id - 1] = null; };
    const document = { documentElement: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) }, style: { setProperty: (k, v) => { vars[k] = v; } } } };
    const anchored = new Set(), palette = { classList: { contains: (c) => anchored.has(c) } };
    const frameElement = { parentElement: { getBoundingClientRect: () => half }, getBoundingClientRect: () => box };
    const window = { frameElement: framed ? frameElement : null, parent: { postMessage: (m) => asked.push(m.orbital === 'cover' && m.on) } };
    ${functionSource('placeCover')}
    ${sourceLine('let covering = false')}
    ${sourceLine('const tellCover = ')}
    ${functionSource('coverWindow')}
    ({ coverWindow, placeCover, asked, vars, anchored, covered: () => classes.has('cover'),
       shell: (next, w, h = next.height) => { box = next; innerWidth = w; innerHeight = h; placeCover(); }, fade: () => { const due = timers.splice(0).filter(Boolean); due.forEach((fn) => fn()); return due.length; } });
  `, { half, framed });
  const whole = { left: 0, top: 0, width: 1000, height: 700 };
  const right = pane({ left: 600, top: 0, width: 400, height: 700 });
  right.coverWindow('cmd');
  assert.deepEqual([...right.asked], [true], '⌘K in the right half asks the shell to cover the window');
  assert.equal(right.covered(), false, 'and draws nothing differently until the page really is the whole window');
  right.shell(whole, 1000);
  assert.deepEqual([right.covered(), right.vars['--pane-x'], right.vars['--pane-w']], [true, '600px', '400px'], 'then it draws itself in its own half');
  right.coverWindow('search');
  assert.deepEqual([...right.asked], [true], 'another page of the same palette asks nothing more');
  right.coverWindow(null);
  assert.deepEqual([...right.asked, right.covered()], [true, true], 'closing keeps the window covered while the scrim fades');
  right.coverWindow('cmd');
  assert.equal(right.fade(), 0, 'opened again before that: nothing lets go');
  right.coverWindow(null); right.fade();
  assert.deepEqual([...right.asked, right.covered()], [true, false, true], 'faded: it lets go, and stays drawn in its half until the shell has made it that again');
  right.shell({ left: 600, top: 0, width: 400, height: 700 }, 400);
  assert.equal(right.covered(), false, 'back to its half: drawn as a page again');
  right.anchored.add('anchored'); right.coverWindow('search'); right.anchored.clear(); right.coverWindow('slash');
  assert.equal(right.asked.length, 2, 'the @ link search and the / menu stay in the half they belong to');
  const alone = pane(whole);
  alone.coverWindow('cmd'); alone.shell(whole, 1000); alone.coverWindow(null); alone.fade();
  assert.deepEqual([[...alone.asked], alone.covered()], [[true, false], false], 'a page alone in its window: asked and let go (the shell drops its drag strip under the scrim), drawn as it was');
  const zoomed = pane({ left: 500, top: 0, width: 500, height: 700 });
  zoomed.coverWindow('cmd'); zoomed.shell(whole, 800, 560);
  assert.deepEqual([zoomed.covered(), zoomed.vars['--pane-x'], zoomed.vars['--pane-w']], [true, '400px', '400px'], 'a page zoomed apart from the shell: the half in the page\u2019s own pixels');
  const tabbed = pane({ left: 250, top: 130, width: 560, height: 362 });
  tabbed.coverWindow('cmd'); tabbed.shell(whole, 1000, 700);
  assert.deepEqual([tabbed.covered(), ...['x', 'y', 'w', 'h'].map((k) => tabbed.vars['--pane-' + k])], [true, '250px', '130px', '560px', '362px'], 'a pane under a tab bar or floating: placed on both axes');
  const below = pane({ left: 0, top: 38, width: 1000, height: 662 });
  below.coverWindow('cmd'); below.shell(whole, 1000, 700);
  assert.equal(below.vars['--pane-y'], '38px', 'a pane as wide as the window but under a tab bar is covered too');
  const mock = pane(whole, false);
  mock.coverWindow('cmd');
  assert.deepEqual([...mock.asked], [], 'outside the shell (the mock) there is nothing to ask');
  assert.match(source, /function showPage\([^]*?coverWindow\(mode\);\n\}/, 'every page of the palette decides it: showPage');
  assert.match(source, /function closePalette\(\) \{[^}]*coverWindow\(null\);/, 'and every close lets go');
  assert.match(source, /function leavePage\(\) \{[^}]*if \(covering\) \{ covering = false; tellCover\(false\); \}/, 'a page going away gives the window back at once');
  console.log('ok  palette over both halves: asked once, drawn in its half only at the whole window\u2019s size, let go after the fade; @ and / stay in the half');
}
checks.push(runCoverCheck);
// A row someone else changed lights up once; a render that changes many at once is the page landing, and flashing
// each of them forced a layout per row (639 rows: about a second of script before the Library showed).
function runLandingFlashCheck() {
  const flashed = (changed) => vm.runInNewContext(`
    const flashed = [], view = 'library', zoom = null, performance = { now: () => 1e6 };
    const revealOpened = () => {}, motionOK = () => true, acted = () => false, curtain = () => {}, flash = (el) => flashed.push(el.dataset.key);
    const rows = Array.from({ length: 40 }, (_, i) => ({ dataset: { key: 'k' + i, body: i < ${changed} ? 'new' : 'old' }, classList: { contains: () => false } }));
    const root = { dataset: { key: 'root' }, querySelectorAll: (s) => (s === '.node[data-key]' ? rows : []), querySelector: () => null };
    let rowsLeftAt = -Infinity;
    ${sourceLine('const BULK')}
    ${functionSource('motionAfter')}
    motionAfter(root, { page: 'root|library', bodies: new Map(rows.map((el) => [el.dataset.key, 'old'])), fieldsWaiting: new Set(), rects: null });
    flashed;
  `);
  assert.deepEqual([...flashed(1)], ['k0'], 'an edit elsewhere to one row lights that row up');
  assert.deepEqual([...flashed(26)], [], 'more than BULK rows changed at once is a landing: none flashes');
  console.log('ok  landing: one changed row flashes, a whole list changed at once does not');
}
checks.push(runLandingFlashCheck);
process.exitCode = 1;
Promise.allSettled(checks.map((check) => Promise.resolve().then(check))).then((results) => {
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map((failure) => failure.message).join('\n'));
  console.log('renderer behavior check passed');
  process.exitCode = 0;
});

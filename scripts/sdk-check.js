#!/usr/bin/env node
'use strict';
// Offline self-check for the SDK core: no network, no Electron. Run: node scripts/sdk-check.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { create, toBinary, fromBinary, toJson, fromJson } = require('@bufbuild/protobuf');
const { createRouterTransport, ConnectError, Code } = require('@connectrpc/connect');
const { message, SyncService } = require('../sdk/proto/descriptors');
const { createTransport, SyncConnection, Document, derivePeerId } = require('../sdk');
const { readNode, setTitle, setState, workflowStates, taskMeta, setAssignees, setSearchQuery, contentText, ulid, initDocument, STATE_TYPES } = require('../sdk/node');
const outline = require('../sdk/content');
const { fetchImage, uploadFile, initImage, UPLOAD_LIMIT } = require('../sdk/assets');
const { LoroMap, LoroList, LoroText } = require('loro-crdt');
const { liveTrigger, parseQuery, searchParams, needsTypes, viewParams, searchQueryParams, filterToSearchQuery, searchQueryToFilter, validViewFilter, VIEW_PRESETS, hideRules, isHidden, completedInWindow, completedWindow } = require('../sdk/query');
const pins = require('../sdk/pins');

const ORG = 'org_01EXAMPLE00000000000000000', DOC = 'tana:text:01exampleh0000000000000000', ME = 'tana:user-profile:01examplei0000000000000000';
const snapshot = Buffer.from(fs.readFileSync(require('node:path').join(__dirname, 'fixtures', 'task-snapshot.b64'), 'utf8').trim(), 'base64');
const b64 = (u8) => Buffer.from(u8).toString('base64');
// build/icon.png is the dev Dock icon, and main.js's app.dock.setIcon decodes it on main before the first window: at
// 2048 px that blocked 244 ms and kept 147 MB, at 512 px it is 22 ms and 12 MB (#418). The PNG width is at byte 16.
assert.ok(fs.readFileSync(require('node:path').join(__dirname, '..', 'build', 'icon.png')).readUInt32BE(16) <= 512, 'the dev Dock icon is at most 512 px');
// Waits for what a test is waiting for rather than for a fixed time, which is what most of this file's run time was.
async function until(ready, what, ms = 10000) {
  for (const end = Date.now() + ms; !ready(); await new Promise((r) => setTimeout(r, 5))) if (Date.now() > end) throw new Error('timed out waiting for ' + what);
}

// Load the real main-process helpers without Electron startup or a Tana connection: main.js and everything under
// main/ run in one sandboxed context (one realm, stubbed timers, a fake electron), the rest through the real require.
// `childProcess` stands in for node:child_process, so the agent's real spawn/teardown path can be driven without an
// app-server: the writer lifecycle is exactly what the lock bug lives in, and it is unreachable any other way.
function mainHelpers(childProcess) {
  const nodePath = require('node:path'), root = nodePath.join(__dirname, '..');
  const handlers = new Map();
  // opened: every url main asked the OS to open, so a check can see whether assigning actually handed the work over
  const opened = [];
  const timers = []; // every timer main set, never run on its own: a check can look at when one is due and run it by hand
  const electron = { app: { getPath: () => require('node:os').tmpdir() }, BrowserWindow: function (options) { electron.windows.push(this); this.options = options; const on = {}; this.webContents = { on: (name, fn) => { on[name] = fn; }, handlers: on, css: [], getUserAgent: () => 'Mozilla/5.0 Orbital/1.0 Chrome/140.0 Electron/44.0.0 Safari/537.36', setUserAgent: (ua) => { this.userAgent = ua; }, insertCSS: (css) => { this.webContents.css.push(css); }, setWindowOpenHandler: (fn) => { this.openHandler = fn; } }; this.on = (name, fn) => { on['window:' + name] = fn; }; this.isDestroyed = () => !!this.destroyed; this.destroy = () => { this.destroyed = true; on["window:closed"]?.(); }; this.focus = () => { this.focused = (this.focused || 0) + 1; }; this.loadURL = (url) => { this.url = url; }; }, windows: [], WebContentsView: function () { this.webContents = { once() {}, loadFile() {}, focus() {}, isDestroyed: () => false, close() {} }; this.setBackgroundColor = () => {}; this.setBounds = () => {}; }, Menu: {}, ipcMain: { handle: (name, fn) => { if (handlers.has(name)) throw new Error('a second handler for ' + name); handlers.set(name, fn); }, on: (name, fn) => handlers.set(name, fn) }, // Electron refuses a second handle too
    shell: { openExternal: async (url) => { if (electron.shell.refuse) throw new Error('no handler for codex://'); opened.push(url); } },
    clipboard: { items: [], read: async () => electron.clipboard.items } }; // items: what a check puts on it, as clipboard.read() hands them over
  const context = vm.createContext({
    Buffer, console, URL, // URL is a global in Electron's main process
    setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => {}, // no refresh/network timers in offline main helpers
    process: { env: { ...process.env, TANA_MAIN_TEST: '1' } },
  });
  const cache = new Map(), ours = (file) => file === nodePath.join(root, 'main.js') || file.startsWith(nodePath.join(root, 'main') + nodePath.sep);
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    const req = createRequire(file);
    const localRequire = (id) => { if (id === 'electron') return electron; if (id === 'node:child_process' && childProcess) return childProcess;
      const resolved = id.startsWith('.') ? req.resolve(id) : id; return ours(resolved) ? load(resolved) : req(id); };
    const wrapped = vm.runInContext('(function (require, module, exports, __dirname, __filename) {' + fs.readFileSync(file, 'utf8') + '\n})', context, { filename: file });
    wrapped(localRequire, mod, mod.exports, nodePath.dirname(file), file);
    return mod.exports;
  };
  // the agent module itself as well: creating a task spawns a real app-server, which a check stubs out by replacing
  // that one function on the module main.js holds
  return { ...load(nodePath.join(root, 'main.js')), handlers, opened, timers, electron, agent: load(nodePath.join(root, 'main', 'agent.js')) };
}

async function main() {
  {
    // Every channel preload.js calls has a handler in main, and every handler a caller in preload.js. A handler lives
    // in main.js or in its module's ipc table (main.js registers those), so a move or a rename on one side only would
    // otherwise surface as "No handler registered" the first time a page asks.
    const backend = mainHelpers();
    const called = [...fs.readFileSync(require.resolve('../preload'), 'utf8').matchAll(/ipcRenderer\.(?:invoke|send|sendSync)\('([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(called.filter((c) => !backend.handlers.has(c)).sort(), [], 'preload.js calls channels main does not answer');
    assert.deepEqual([...backend.handlers.keys()].filter((c) => !called.includes(c)).sort(), [], 'main answers channels preload.js never calls');
    console.log('ok  ipc: every preload channel has one handler in main, and every handler a caller');
  }
  {
    // A created saved search must match a real one, byte shape for byte shape. The reference is a raw container
    // dump of an actual Tana saved search (2026-09-17): data{type,createdAt,title,restricted,participants} and
    // the query and view roots — with NO ownerUri (a Library-level search has no owner) and NO sharedPinDates,
    // which initDocument writes for every other kind. Those two absences are the easiest thing to get silently
    // wrong, so they are asserted rather than assumed.
    const q = { types: ['text'], stateTypes: ['proposed', 'open'], assignedToViewer: true };
    const d = new Document('tana:search:' + ulid());
    d.transact((l) => initDocument(l, 'My Tasks', ME, { kind: 'search', now: 1789584742091, query: q }));
    const data = d.data.toJSON();
    assert.equal(data.type, 'search', 'a saved search declares its own kind');
    assert.equal(data.title, 'My Tasks');
    assert.equal(data.createdAt, 1789584742091);
    assert.equal(data.restricted, true);
    assert.deepEqual(data.participants, { [ME]: { type: 'user', role: 'admin' } }, 'the creator is an admin participant, which is what editable() reads to allow a rename');
    assert.equal(data.sharedPinDates, undefined, 'a real saved search carries no sharedPinDates');
    assert.equal(data.ownerUri, undefined, 'and no ownerUri: a Library-level search has no owner');
    const stored = d.loro.getMap('query').toJSON();
    assert.deepEqual(stored.types, ['text'], 'the query is written at creation, not left empty');
    assert.deepEqual(stored.stateTypes, ['proposed', 'open']);
    assert.equal(stored.assignedToViewer, true, 'viewer-relative flags survive the write');
    assert.deepEqual(stored.assignedTo, [], 'every list key is present, empty when unset, as a real one is');
    assert.deepEqual(stored.attributes, {});
    assert.ok(Object.keys(stored).length > 0, 'never an empty query map: searchChildren reads that as unreadable and refuses to run it');
    assert.deepEqual(d.loro.toJSON().view, {}, 'a view root exists, empty until the user groups or sorts');
    // Replacing, not patching: Tana assigns every key on write, so a filter the user removed cannot linger.
    setSearchQuery(d, { types: ['event'] });
    const after = d.loro.getMap('query').toJSON();
    assert.deepEqual(after.types, ['event']);
    assert.deepEqual(after.stateTypes, [], 'the states from the previous query are gone, not merged');
    assert.equal(after.assignedToViewer, undefined, 'and so is the viewer flag');
    // Same lingering-filter risk as the flags: a cleared date window must go, not survive the rewrite.
    setSearchQuery(d, { types: ['event'], eventTime: { min: 1, max: 2 } });
    assert.deepEqual(d.loro.getMap('query').toJSON().eventTime, { min: 1, max: 2 }, 'a date window is stored');
    setSearchQuery(d, { types: ['event'] });
    assert.equal(d.loro.getMap('query').toJSON().eventTime, undefined, 'and clearing it removes the window rather than leaving it filtering');
    // Tana declares workflow states and attribute values as Loro maps (Fc.list(Fc.map), Fc.record(Fc.map)), their
    // lists and date as containers too: a rewrite must keep that shape, and read back through toJSON() unchanged.
    const shaped = { types: ['text'], workflowStates: [{ workflowUri: 'tana:workflow:01examples0000000000000000', workflowStateId: 'review' }],
      attributes: { 'tana:type:x?attribute=y': { refs: ['tana:text:01examples0000000000000000'], date: { preset: 'past' }, textMatches: [{ value: 'a', mode: 'prefix' }], numberRanges: [{ min: 1 }] } } };
    setSearchQuery(d, shaped);
    const qm = d.loro.getMap('query'), attr = qm.get('attributes').get('tana:type:x?attribute=y');
    assert.equal(qm.get('workflowStates').get(0).kind(), 'Map', 'a workflow state is a map, as Tana writes it');
    assert.deepEqual([attr.kind(), attr.get('refs').kind(), attr.get('date').kind(), attr.get('textMatches').get(0).kind(), attr.get('numberRanges').get(0).kind()],
      ['Map', 'List', 'Map', 'Map', 'Map'], 'an attribute is a map of containers, down to each match and range');
    const back = qm.toJSON();
    assert.deepEqual([back.workflowStates, back.attributes], [shaped.workflowStates, shaped.attributes], 'and toJSON() reads it back exactly as given');
    // view: Tana reads sortBy as field (ascending) or -field, and display as a record of key -> { shown, order }
    const nodeSdk = require('../sdk/node');
    nodeSdk.setSearchView(d, { sortBy: 'updated', groupBy: 'status', display: ['status', 'updated'] });
    const view = d.loro.getMap('view').toJSON();
    assert.equal(view.sortBy, '-updated', "Orbital's Updated is newest first, which Tana spells -updated");
    assert.deepEqual(view.display, { status: { shown: true, order: 0 }, updated: { shown: true, order: 1 } });
    assert.deepEqual([nodeSdk.searchSort(view.sortBy), nodeSdk.searchDisplay(view.display), nodeSdk.searchDisplay('type,space')], ['updated', ['status', 'updated'], ['type', 'space']]);
    nodeSdk.setSearchView(d, { sortBy: 'title' });
    assert.equal(d.loro.getMap('view').toJSON().sortBy, 'title', 'A to Z is Tana\'s ascending title');
    assert.deepEqual(nodeSdk.readSearch(d), { query: d.loro.getMap('query').toJSON(), view: { sortBy: 'title' } }, 'readSearch hands back what the two writers stored');
    assert.deepEqual(nodeSdk.readSearch(new Document('tana:search:' + ulid())), { query: {}, view: {} }, 'and an unreadable search reads as an empty query, which searchChildren refuses');
    const notASearch = new Document(DOC);
    notASearch.transact((l) => initDocument(l, 'plain', ME));
    assert.throws(() => setSearchQuery(notASearch, { types: ['text'] }), /not a saved search/, 'the query container is only written on a search');
    console.log('ok  a created saved search matches a real one: no ownerUri, no sharedPinDates, query written at birth');
  }
  {
    const access = require('../sdk/access'), docs = new Map();
    const make = (kind, title = kind) => { const d = new Document('tana:' + kind + ':' + ulid()); d.transact(l => { initDocument(l,title,ME); l.getMap('data').set('type',kind); }); docs.set(d.id,d); return d; };
    const source = make('text'), target = make('space'), otherSpace = make('space'), org = make('org');
    org.transact(l => l.getMap('data').set('memberUserProfileDocUris',{test:ME}));
    const ctx = {orgDocUri:org.id,sync:{subscribe:async id=>{if(!docs.has(id)) throw new Error('unavailable'); return docs.get(id);}},graph:{listNodes:async()=>({nodes:[],totalCount:0})}};
    const child = outline.insertAfter(source,null,'keep child'), beforeContent=source.content.toJSON();
    const mirror = new Document(source.id,{peerId:'991'}); mirror.applyRemote([source.exportSince()]); source.on('local-update',u=>mirror.applyRemote([u]));
    assert.equal((await access.capabilities(source,ME,ctx)).move,true);
    await access.moveToSpace(source,target,ME,ctx);
    assert.equal(readNode(source).ownerUri,target.id); assert.equal(readNode(source).restricted,true);
    assert.ok(outline.readOutline(source).some(n=>n.id===child));
    const stranger='tana:user-profile:'+ulid();
    const publicDoc=make('text'), artifact=make('artifact');
    assert.equal((await access.capabilities(publicDoc,ME,ctx)).linkSharing,true,'text links default on when org policy is absent');
    await access.setLinkSharing(publicDoc,ME,true,ctx);
    assert.deepEqual(publicDoc.loro.getMap('linkSharing').toJSON(),{mode:'view'});
    assert.equal(readNode(publicDoc).hasBeenPublic,true);
    await access.setLinkSharing(publicDoc,ME,false,ctx);
    assert.deepEqual(publicDoc.loro.getMap('linkSharing').toJSON(),{});
    assert.equal(readNode(publicDoc).hasBeenPublic,true,'revoking a link preserves the public-history flag');
    assert.equal((await access.capabilities(artifact,ME,ctx)).linkSharing,true,'artifacts support public links');
    await assert.rejects(access.setLinkSharing(target,ME,true,ctx),/unavailable/,'spaces cannot be publicly shared');
    await assert.rejects(access.setLinkSharing(publicDoc,stranger,true,ctx),/unavailable/,'public links require write access');
    await assert.rejects(access.setSharing(source,stranger,{rule:'inherit'},ctx));
    await assert.rejects(access.setSharing(source,ME,{rule:'people',participants:[{uri:stranger,role:'viewer'}]},ctx));
    await access.setSharing(source,ME,{rule:'people',participants:[{uri:stranger,role:'editor'}]},ctx);
    assert.equal(source.loro.getMap('data').get('participants').get(stranger).get('changedBy'), ME, 'an invite records who made it (native addParticipant)');
    await access.setSharing(source,ME,{rule:'me'},ctx);
    assert.deepEqual(Object.keys(readNode(source).participants),[ME]);
    await assert.rejects(access.setSharing(source,ME,{rule:'inherit'},ctx),/audience disclosure/);
    await access.setSharing(source,ME,{rule:'inherit',token:(await access.capabilities(source,ME,ctx)).sharingToken},ctx);
    assert.equal(readNode(source).restricted,undefined);
    otherSpace.transact(l=>{const p=l.getMap('data').get('participants').setContainer(stranger,new LoroMap());p.set('type','user');p.set('role','editor');});
    const preview=await access.previewMove(source,otherSpace,ME,ctx);
    assert.equal(preview.allowed,true); assert.equal(preview.requiresConfirmation,true);
    assert.equal(preview.before.scope,'only-me'); assert.equal(preview.after.scope,'space');
    await assert.rejects(access.moveToSpace(source,otherSpace,ME,ctx),/explicitly confirm/);
    otherSpace.transact(l=>l.getMap('data').get('participants').get(stranger).set('role','admin'));
    await assert.rejects(access.moveToSpace(source,otherSpace,ME,ctx,preview.token),/explicitly confirm/);
    const refreshedPreview=await access.previewMove(source,otherSpace,ME,ctx);
    await access.moveToSpace(source,otherSpace,ME,ctx,refreshedPreview.token);
    assert.equal(readNode(source).restricted,undefined);
    await assert.rejects(access.moveToSpace(source,target,ME,ctx,preview.token),/explicitly confirm/);
    const typed=make('type'); source.transact(l=>l.getMap('data').set('entityTypeUri',typed.id));
    assert.equal((await access.previewMove(source,target,ME,ctx)).allowed,true,'global type permits move');
    typed.transact(l=>l.getMap('data').set('ownerUri',otherSpace.id));
    assert.equal((await access.previewMove(source,target,ME,ctx)).allowed,false,'space-scoped type blocks crossing');
    assert.equal((await access.previewMove(source,otherSpace,ME,ctx)).allowed,true);
    ctx.graph.listNodes=async q=>({nodes:[],totalCount:q.ownerIds ? 0 : 1});
    assert.equal((await access.previewMove(typed,target,ME,ctx)).allowed,false,'type instance outside target');
    ctx.graph.listNodes=async()=>({nodes:[]});
    assert.equal((await access.previewMove(typed,target,ME,ctx)).allowed,false,'missing instance count remains disabled');
    ctx.graph.listNodes=async()=>({nodes:[],totalCount:1500});
    assert.equal((await access.previewMove(typed,target,ME,ctx)).allowed,true);
    { // typed fields: values live in the document's own data map, in the layout observed on a real typed node
      const fields = require('../sdk/fields');
      const typed = make('text');
      const key = 'tana:type:' + ulid() + '?attribute=gcx3bvn5';
      assert.deepEqual(fields.readFields(typed), [], 'a document without fields reports none');
      fields.setFieldText(typed, key, 'Oriënterend/verkennend');
      const value = typed.data.toJSON().attributes[key];
      assert.equal(value.nodeName, 'doc');
      assert.equal(value.children[0].nodeName, 'paragraph');
      assert.equal(typeof value.children[0].attributes.blockId, 'string');
      assert.deepEqual(value.children[0].children, ['Oriënterend/verkennend']);
      assert.deepEqual(fields.readFields(typed).map((f) => [f.attribute, f.text]), [['gcx3bvn5', 'Oriënterend/verkennend']]);
      fields.setFieldText(typed, key, 'Onderhandeling');
      assert.deepEqual(fields.readFields(typed).map((f) => f.text), ['Onderhandeling'], 'a second write replaces the text in place');
      assert.equal(typed.data.toJSON().attributes[key].children.length, 1, 'without adding paragraphs');
      const typeDoc = make('type');
      typeDoc.transact((l) => l.getMap('data').set('template', { attributes: [{ key: 'gcx3bvn5', title: 'Fase' }] }));
      assert.deepEqual(fields.templateTitles(typeDoc), { gcx3bvn5: 'Fase' }, 'field names come from the type template');
      assert.deepEqual(fields.definitions(typeDoc), [{ key: 'gcx3bvn5', title: 'Fase' }], 'and so do the definitions main lists on a type page');
      assert.deepEqual(fields.definitions(make('type')), [], 'a type without a template defines nothing');
      { // defining a field: one more map in template.attributes, in the container layout a real type carries
        const real = make('type');
        const key = fields.addField(real, { title: 'Discuss with', type: 'member', cardinality: 'single' });
        assert.match(key, /^[a-z0-9]{8}$/, 'a Tana-style key');
        const plain = fields.addField(real, { title: 'Notes' });
        const tpl = real.data.get('template');
        assert.equal(tpl.get('attributes').kind(), 'MovableList', 'the list Tana keeps its field definitions in');
        assert.deepEqual(tpl.toJSON().attributes, [{ key, title: 'Discuss with', type: 'member', cardinality: 'single' }, { key: plain, title: 'Notes' }]);
        assert.deepEqual(fields.templateTitles(real), { [key]: 'Discuss with', [plain]: 'Notes' });
        assert.throws(() => fields.addField(real, { title: ' ' }), /title required/);
        assert.throws(() => fields.addField(real, { title: 'x', cardinality: 'many' }), /single or multiple/);
        assert.throws(() => fields.addField(real, { title: 'x', type: 'number' }), /field type must be one of/);
        // options and link targets, by Tana's rules (sl/cl/due; configureAsOptions/configureAsLink)
        const level = fields.addField(real, { title: 'Level', type: 'options', options: [' Low ', { label: 'High' }, 'low'] });
        const levelDef = tpl.get('attributes').get(2);
        assert.equal(levelDef.get('options').kind(), 'List', 'options are a plain list of maps, as Tana\'s schema has them');
        assert.deepEqual(fields.fieldDefinition(real, level), { key: level, title: 'Level', type: 'options', options: [{ label: 'Low' }, { label: 'High' }] }, 'trimmed, and a label differing only in case is dropped');
        assert.deepEqual(fields.fieldDefinition(real, fields.addField(real, { title: 'Empty', type: 'options' })).options, [], 'an options field always has its list');
        assert.throws(() => fields.addField(real, { title: 'x', type: 'options', options: [' '] }), /Invalid option label \(empty\)/);
        assert.throws(() => fields.addField(real, { title: 'x', type: 'options', options: ['a\nb'] }), /contains-separator/);
        assert.throws(() => fields.addField(real, { title: 'x', type: 'options', options: ['x'.repeat(61)] }), /too-long/);
        fields.addField(real, { title: 'Sixty', type: 'options', options: ['x'.repeat(60)] }); // 60 is allowed
        assert.throws(() => fields.addField(real, { title: 'x', type: 'link', options: ['a'] }), /takes no options/);
        const typeA = 'tana:type:' + ulid(), typeB = 'tana:type:' + ulid();
        const source = fields.addField(real, { title: 'Source', type: 'link', cardinality: 'single', to: [typeA, { uri: typeA }, { uri: typeB, title: 'Backlink' }] });
        assert.deepEqual(fields.fieldDefinition(real, source).to, [{ uri: typeA }, { uri: typeB, title: 'Backlink' }], 'one entry per type');
        assert.throws(() => fields.addField(real, { title: 'x', type: 'member', to: [typeA] }), /takes no link targets/);
        assert.throws(() => fields.addField(real, { title: 'x', type: 'link', to: ['tana:text:' + ulid()] }), /must be a type uri/);
        assert.deepEqual(fields.setFieldOptions(real, level, ['High', 'Medium', 'HIGH']), ['High', 'Medium'], 'an edit replaces the choices');
        assert.deepEqual(fields.fieldDefinition(real, level).options, [{ label: 'High' }, { label: 'Medium' }]);
        assert.throws(() => fields.setFieldOptions(real, source, ['a']), /not an options field/);
        assert.throws(() => fields.setFieldOptions(real, 'zzzzzzzz', ['a']), /no field/);
        fields.setFieldTargets(real, source, [typeB]);
        assert.deepEqual(fields.fieldDefinition(real, source).to, [{ uri: typeB }]);
        assert.throws(() => fields.setFieldTargets(real, level, [typeA]), /not a link field/);
        { // changing a field's kind keeps only what that kind uses
          const kind = fields.addField(real, { title: 'Kind', type: 'link', to: [typeA] });
          assert.deepEqual(fields.setFieldKind(real, kind, { type: 'options', cardinality: 'multiple' }), { key: kind, title: 'Kind', type: 'options', cardinality: 'multiple', options: [] }, 'a link turned options loses its targets and gains its list');
          fields.setFieldOptions(real, kind, ['A']);
          assert.deepEqual(fields.setFieldKind(real, kind, { cardinality: 'single' }).options, [{ label: 'A' }], 'the number of values alone leaves the choices');
          assert.deepEqual(fields.setFieldKind(real, kind, { type: null }), { key: kind, title: 'Kind', cardinality: 'single' }, 'plain text keeps neither');
          assert.throws(() => fields.setFieldKind(real, kind, { type: 'number' }), /field type must be one of/);
        }
        // a value checked against its definition before it is written (XL; Ove.getValidationErrors; validateTargetTypes)
        const item = make('text'), keyOf = (attr) => real.id + '?attribute=' + attr;
        const levelField = fields.fieldDefinition(real, level);
        fields.setFieldText(item, keyOf(level), ['medium'], { field: levelField });
        assert.deepEqual(fields.readFields(item)[0].lines, [{ segments: [{ text: 'Medium' }], block: 'bullet' }], 'written as declared, one bullet per label');
        assert.throws(() => fields.setFieldText(item, keyOf(level), ['High', 'Medium'], { field: levelField }), /holds a single value, but 2 were given/);
        assert.throws(() => fields.setFieldText(item, keyOf(level), ['Urgent'], { field: levelField }), /only accepts its declared values. Rejected: "Urgent". Available: "High" \| "Medium"/);
        assert.equal(fields.readFields(item)[0].text, 'Medium', 'a refused value writes nothing');
        fields.setFieldText(item, keyOf(level), ['High', 'high', 'Medium'], { field: { ...levelField, cardinality: 'multiple' } });
        assert.deepEqual(fields.readFields(item)[0].lines.map((l) => l.segments[0].text), ['High', 'Medium'], 'multiple: every label, repeats dropped');
        fields.setFieldText(item, keyOf(level), '', { field: levelField });
        assert.deepEqual(fields.readFields(item)[0].lines, [{ segments: [], block: 'paragraph' }], 'emptied: one empty paragraph');
        assert.throws(() => fields.setFieldText(item, keyOf(level), 'x', { field: { key: level, type: 'options', options: [] } }), /no values defined yet/);
        const sourceField = fields.fieldDefinition(real, source), a = 'tana:text:' + ulid(), b = 'tana:text:' + ulid();
        const link = (uri, label) => [{ mention: { uri, label } }];
        const typeOf = (uri) => ({ [a]: typeB, [b]: typeA })[uri];
        fields.setFieldText(item, keyOf(source), [link(a, 'Brief')], { field: sourceField, typeOf });
        assert.deepEqual(fields.readFields(item).find((f) => f.attribute === source).segments, [{ mention: { uri: a, label: 'Brief' } }]);
        assert.throws(() => fields.setFieldText(item, keyOf(source), [link(a, 'Brief'), link(b, 'Other')], { field: sourceField, typeOf }), /Multiple values not allowed \(found 2\)/);
        assert.throws(() => fields.setFieldText(item, keyOf(source), [[{ text: 'see ' }, ...link(a, 'Brief')]], { field: sourceField }), /Contains non-link content/);
        assert.throws(() => fields.setFieldText(item, keyOf(source), [link(b, 'Other')], { field: sourceField, typeOf }), new RegExp('"Other" has wrong type \\(expected one of: ' + typeB + '\\)'));
        fields.setFieldText(item, keyOf(source), [link(b + 'x', 'Unknown')], { field: sourceField, typeOf }); // a type nobody knows passes, as in Tana
        fields.setFieldText(item, keyOf(source), [link(a, 'Brief'), link(b, 'Other')], { field: { ...sourceField, cardinality: undefined, to: [] } }); // unset cardinality allows several
      }
      // a reference value is a mention node: its label is its text, not an empty string
      typed.transact((l) => {
        const runs = l.getMap('data').get('attributes').get(key).get('children').get(0).get('children');
        runs.insertContainer(1, new LoroMap()).set('nodeName', 'mention');
        runs.get(1).setContainer('attributes', new LoroMap()).set('label', ' / Example Corp');
      });
      assert.deepEqual(fields.readFields(typed).map((f) => f.text), ['Onderhandeling / Example Corp'], 'a mention reads as its label');
      // a value with a reference in it: written as segments through the same code a line uses, read back as segments
      const who = 'tana:text:' + ulid();
      fields.setFieldText(typed, key, [{ text: 'Discuss with ' }, { mention: { label: 'Sam Okafor', uri: who } }, { text: ' first' }]);
      const runs = typed.data.toJSON().attributes[key].children[0].children;
      assert.deepEqual([runs.length, runs[1].nodeName, runs[1].attributes.tanaUri], [3, 'mention', who], 'the mention is the map Tana expects, between the text runs');
      assert.deepEqual(fields.readFields(typed)[0].segments, [{ text: 'Discuss with ' }, { mention: { label: 'Sam Okafor', uri: who } }, { text: ' first' }], 'and reads back as segments');
      assert.equal(fields.readFields(typed)[0].text, 'Discuss with Sam Okafor first', 'with the plain text still the label');
      fields.setFieldText(typed, key, 'plain again');
      assert.deepEqual(fields.readFields(typed)[0].segments, [{ text: 'plain again' }], 'a string replaces the whole value');
      { // A field value is a content tree like a page's, so the outline editor drives it: same functions, same ids,
        // same undo. This is what keeps one editor in the app rather than two that drift apart.
        const view = fields.fieldView(typed, key, { create: true });
        assert.deepEqual(outline.readOutline(view).map((n) => n.segments.map((s) => ('text' in s ? s.text : s.mention.label)).join('')), ['plain again'], 'the value reads as an outline');
        const [first] = outline.readOutline(view);
        outline.insertAfter(view, first.id, 'a second row');
        outline.insertChild(view, first.id, 'a child of the first');
        const rows = outline.readOutline(view);
        assert.deepEqual(rows.map((n) => n.segments.map((s) => ('text' in s ? s.text : s.mention.label)).join('')), ['plain again', 'a second row'], 'rows are added the way they are on a page');
        assert.deepEqual(rows[0].children.map((n) => n.segments.map((s) => ('text' in s ? s.text : s.mention.label)).join('')), ['a child of the first'], 'and a row can hold children, which a field value could not before');
        outline.setBlockType(view, rows[1].id, 'bullet');
        assert.equal(outline.readOutline(view)[1].block, 'bullet', 'block types are the page\'s own');
        outline.setText(view, rows[1].id, [{ text: 'with a reference to ' }, { mention: { label: 'Sam Okafor', uri: who } }]);
        assert.deepEqual(outline.readOutline(view)[1].segments.at(-1), { mention: { label: 'Sam Okafor', uri: who } }, 'and so are references');
        // The flat reading still answers for everything that only wants the words (search, backlinks, the
        // "Discuss with" write): a child is one of the lines, like any other row.
        assert.deepEqual(fields.readFields(typed)[0].lines.map((line) => line.segments.map((s) => ('text' in s ? s.text : s.mention.label)).join('')),
          ['plain again', 'a child of the first', 'with a reference to Sam Okafor'], 'the flat reading lists every row, children included');
        // nothing of this reaches the document's own outline: a field value is a tree beside it, not part of it
        assert.equal(outline.readOutline(typed).some((n) => (n.segments || []).some((s) => (s.text || '').includes('second row'))), false,
          'the document\'s own outline is untouched');
        // a read of a field that has no value must not write one: opening a typed page would fill in every empty field
        const empty = fields.fieldView(typed, 'tana:type:01j0typ000000000000000000?attribute=zzzzzzzz');
        assert.deepEqual(outline.readOutline(empty), [], 'an absent value reads as an empty outline');
        assert.equal(Object.keys(typed.data.toJSON().attributes).length, 1, 'and is not created by reading it');
      }
      // A field holds what a node holds: several blocks, and the block types a line can have. Every block that
      // carries words is one line, whatever it is nested in, and a write keeps each block as it found it.
      fields.setFieldText(typed, key, ['First line', [{ text: 'and ' }, { mention: { label: 'Sam Okafor', uri: who } }]]);
      assert.deepEqual(fields.readFields(typed)[0].lines, [
        { segments: [{ text: 'First line' }], block: 'paragraph' },
        { segments: [{ text: 'and ' }, { mention: { label: 'Sam Okafor', uri: who } }], block: 'paragraph' },
      ], 'an array of lines is a block each, and a line says what kind of block it is');
      assert.equal(typed.data.toJSON().attributes[key].children.length, 2, 'written as two blocks, not one line with a newline in it');
      assert.equal(fields.readFields(typed)[0].text, 'First line\nand Sam Okafor', 'the plain text joins them with a newline');
      assert.deepEqual(fields.readFields(typed)[0].segments, [{ text: 'First line' }], 'and segments stays the first line, which is all a single-line value has');
      fields.setFieldText(typed, key, ['Only this']);
      assert.equal(typed.data.toJSON().attributes[key].children.length, 1, 'a line taken away takes its block with it');
      assert.deepEqual(fields.readFields(typed)[0].lines, [{ segments: [{ text: 'Only this' }], block: 'paragraph' }]);
      // "- " in the field editor: the line becomes a bullet, which is a shape change, so the value is written again
      // as the bulletList/listItem/paragraph layout a value Tana bulleted already has.
      fields.setFieldText(typed, key, [{ segments: 'Only this', block: 'paragraph' }, { segments: 'and a bullet', block: 'bullet' }]);
      const shaped = typed.data.toJSON().attributes[key].children;
      assert.deepEqual([shaped.length, shaped[0].nodeName, shaped[1].nodeName, shaped[1].children[0].nodeName], [2, 'paragraph', 'bulletList', 'listItem'],
        'a bullet after a paragraph is a list of its own, in Tana\u2019s layout');
      assert.deepEqual(fields.readFields(typed)[0].lines, [{ segments: [{ text: 'Only this' }], block: 'paragraph' }, { segments: [{ text: 'and a bullet' }], block: 'bullet' }],
        'and reads back as the two kinds of line it is');
      fields.setFieldText(typed, key, [{ segments: 'Only this', block: 'paragraph' }, { segments: 'plain again', block: 'paragraph' }]);
      assert.deepEqual(fields.readFields(typed)[0].lines.map((line) => line.block), ['paragraph', 'paragraph'], 'and a bullet taken off goes back to a paragraph');
      { // a value Tana wrote as bullets: read one line per bullet, and still bullets after an edit
        const bullets = make('text');
        bullets.transact((l) => {
          const value = l.getMap('data').setContainer('attributes', new LoroMap()).setContainer(key, new LoroMap());
          value.set('nodeName', 'doc');
          const kids = value.setContainer('children', new LoroList());
          const list = kids.insertContainer(0, new LoroMap());
          list.set('nodeName', 'bulletList');
          const items = list.setContainer('children', new LoroList());
          for (const words of ['Ask Stan', 'Then Peter']) {
            const item = items.insertContainer(items.length, new LoroMap());
            item.set('nodeName', 'listItem');
            const paragraphs = item.setContainer('children', new LoroList());
            const paragraph = paragraphs.insertContainer(0, new LoroMap());
            paragraph.set('nodeName', 'paragraph');
            paragraph.setContainer('children', new LoroList()).insertContainer(0, new LoroText()).insert(0, words);
          }
        });
        assert.deepEqual(fields.readFields(bullets)[0].lines, [{ segments: [{ text: 'Ask Stan' }], block: 'bullet' }, { segments: [{ text: 'Then Peter' }], block: 'bullet' }],
          'a bulleted value is one line per bullet, however deep it is nested, and each says it is a bullet');
        fields.setFieldText(bullets, key, [{ segments: 'Ask Stan first', block: 'bullet' }, { segments: 'Then Peter', block: 'bullet' }]);
        const tree = bullets.data.toJSON().attributes[key].children;
        assert.deepEqual([tree.length, tree[0].nodeName, tree[0].children.length], [1, 'bulletList', 2], 'editing a line leaves the value bulleted rather than flattening it');
        assert.deepEqual(fields.readFields(bullets)[0].lines, [{ segments: [{ text: 'Ask Stan first' }], block: 'bullet' }, { segments: [{ text: 'Then Peter' }], block: 'bullet' }]);
        fields.setFieldText(bullets, key, [{ segments: 'Ask Stan first', block: 'bullet' }]);
        assert.deepEqual(fields.readFields(bullets)[0].lines, [{ segments: [{ text: 'Ask Stan first' }], block: 'bullet' }], 'a bullet removed leaves one');
        fields.setFieldText(bullets, key, []);
        assert.deepEqual(fields.readFields(bullets)[0].lines, [{ segments: [], block: 'paragraph' }], 'and emptying the value altogether leaves one empty plain line, not a bullet with nothing in it');
      }
    }
    { // Library = no owner: the key goes away, the audience follows the participants, and a type still needs a space
      const loose=make('text'); loose.transact(l=>l.getMap('data').set('ownerUri',target.id));
      const toLibrary=await access.previewMove(loose,access.LIBRARY,ME,ctx);
      assert.equal(toLibrary.allowed,true,'a writable document can move to the Library');
      assert.equal(toLibrary.target.id,null); assert.equal(toLibrary.target.title,'Library');
      await access.moveToSpace(loose,access.LIBRARY,ME,ctx,toLibrary.requiresConfirmation?toLibrary.token:undefined);
      assert.equal(readNode(loose).ownerUri,undefined,'ownerUri is removed rather than set to null');
      assert.equal((await access.previewMove(typed,access.LIBRARY,ME,ctx)).reason,'Move a type to a space, not the Library');
    }
    const inherited=make('chat'); inherited.transact(l=>{const d=l.getMap('data'); d.delete('participants');d.delete('restricted');d.set('ownerUri',target.id);});
    assert.equal((await access.capabilities(inherited,ME,ctx)).sharing,true,'inherited editor/admin grant');
    await access.setSharing(inherited,ME,{rule:'people',participants:[{uri:stranger,role:'editor'}]},ctx);
    assert.equal(readNode(inherited).participants[stranger].role,'editor','missing participants map created natively');
    const open=make('canvas');open.transact(l=>{l.getMap('data').delete('restricted');l.getMap('data').delete('participants');});
    assert.equal((await access.capabilities(open,ME,ctx)).sharing,true,'verified organization membership');
    assert.equal((await access.capabilities(open,stranger,ctx)).sharing,false);
    const event=make('event');event.transact(l=>{const d=l.getMap('data');d.set('externalId','calendar-event');d.get('participants').get(ME).set('role','attendee');});
    assert.equal((await access.capabilities(event,ME,ctx)).sharing,false,'calendar attendee cannot change sharing');
    event.transact(l=>l.getMap('data').get('participants').get(ME).set('role','editor'));
    assert.equal((await access.capabilities(event,ME,ctx)).sharing,true,'native editor is organizer');
    await access.setSharing(event,ME,{rule:'people',participants:[{uri:stranger,role:'attendee'}]},ctx);
    assert.equal(readNode(event).participants[ME].role,'editor','people selection preserves actor role');
    event.transact(l=>{const d=l.getMap('data');d.delete('externalId');d.get('participants').get(ME).set('role','attendee');d.get('participants').get(stranger).set('role','editor');});
    const eventBefore=event.toJSON();
    await assert.rejects(access.setSharing(event,ME,{rule:'people',participants:[{uri:stranger,role:'attendee'}]},ctx),/at least one organizer/);
    assert.deepEqual(event.toJSON(),eventBefore,'rejected organizer removal leaves ACL untouched');

    const agent=make('agent');org.transact(l=>{const p=l.getMap('featurePolicy');p.set('memberOrgWideCreation',false);p.set('linkSharing',false);});
    assert.equal((await access.capabilities(agent,ME,ctx)).rules.includes('inherit'),false,'org policy');
    assert.equal((await access.capabilities(agent,ME,{...ctx,orgAdmin:true})).rules.includes('inherit'),true);
    assert.equal((await access.capabilities(publicDoc,ME,ctx)).linkSharing,false,'org policy disables public links');
    await assert.rejects(access.setLinkSharing(publicDoc,ME,true,ctx),/unavailable/,'org policy blocks the write');
    // A saved search is created by this app and owned by its creator, so it must be writable and deletable
    // like any other document kind; leaving it out of the access kinds said "write permission unknown" instead.
    const search=make('search');
    assert.equal((await access.capabilities(search,ME,ctx)).deletable,true,'a saved search you own can be deleted');
    assert.equal(await access.canDelete(search,ME,ctx),true);
    target.transact(l=>l.getMap('data').set('ownerUri',otherSpace.id));
    assert.equal((await access.previewMove(otherSpace,target,ME,ctx)).allowed,false,'ownership cycle');
    assert.deepEqual(source.content.toJSON(),beforeContent);assert.deepEqual(source.toJSON(),mirror.toJSON());
    console.log('ok  native sharing/move: effective grants, org membership/policy, event organizer, type scope, preview confirmation and content preservation');
  }
  {
    // Sync exposes a Document handle immediately, before its bootstrap promise is ready.
    const backend=mainHelpers(), halfLoaded=new Document(DOC);
    let finish, reads=0;
    const ready=new Promise(resolve=>{finish=resolve;});
    backend.testRuntime({me:{userUri:ME},client:{sync:{getDocument:()=>halfLoaded,subscribe:()=>ready}}});
    const result=backend.op(DOC, async doc=>{reads++; return require('../sdk/node').audience(doc,ME);});
    await Promise.resolve(); await Promise.resolve();
    assert.equal(reads,0,'metadata IPC must not read an unbootstrapped handle');
    halfLoaded.transact(l=>initDocument(l,'send',ME,{kind:'task'}));
    setState(halfLoaded,'closed',ME); finish(halfLoaded);
    assert.equal(await result,'only-me','completed private task resolves after real metadata arrives');
    console.log('ok  metadata IPC waits for bootstrap rather than caching an unknown audience');
  }
  {
    const backend=mainHelpers(), cache=require('../db');cache.open(':memory:');
    const serverDoc=new Document(DOC,{peerId:'411'}), local=new Document(DOC,{peerId:'412'});
    serverDoc.transact(l=>initDocument(l,'reversible delete',ME,{kind:'task'}));
    outline.insertAfter(serverDoc,null,'preserved content'); local.applyRemote([serverDoc.exportSince()]);
    const original=local.toJSON(), calls=[], events=[]; let failRestore=false;
    const apply=async action=>{
      calls.push(action);if(action==='restore' && failRestore) throw new Error('mock restore failed');
      serverDoc.transact(l=>{const d=l.getMap('data');if(action==='softDelete')d.set('deletedAt',123);else{d.delete('deletedAt');d.delete('retentionPurgeAfter');}});
      local.applyRemote([serverDoc.exportSince(local.loro.oplogVersion())]);
      return {responseUnion:{case:'documentActionResponse'}};
    };
    backend.testRuntime({me:{userUri:ME,orgId:ORG},session:{getAccessToken:async()=> 'x.'+Buffer.from(JSON.stringify({org_id:ORG,role:'member'})).toString('base64url')+'.x'},client:{sync:{getDocument:()=>local,subscribe:async()=>local,softDelete:()=>apply('softDelete'),restore:()=>apply('restore')}},win:{isDestroyed:()=>false,webContents:{send:(...args)=>events.push(args)}}});
    local.on('change',()=>backend.onChange(DOC));
    cache.upsert({id:DOC,title:'reversible delete',section:'tasks'});
    assert.equal(await backend.documentAction(DOC,'softDelete'),DOC);
    assert.equal(cache.get(DOC),undefined);assert.ok(events.some(([channel])=>channel==='outline:removed'));
    failRestore=true;await assert.rejects(backend.undo(),/mock restore failed/);failRestore=false;
    events.length=0;
    assert.equal(await backend.undo(),DOC,'failed undo stays available for retry');
    assert.ok(events.some(([channel,id])=>channel==='outline:changed'&&id===null),'a restore tells every page to reload its lists, which is how the row comes back');
    assert.deepEqual(local.toJSON(),original,'restore preserves original identity, content and ACL');
    await backend.redo();assert.equal(readNode(local).deletedAt,123);
    await backend.documentAction(DOC,'restore');assert.deepEqual(local.toJSON(),original);
    await backend.undo();assert.equal(readNode(local).deletedAt,123);
    await backend.redo();assert.deepEqual(local.toJSON(),original);
    assert.deepEqual(calls,['softDelete','restore','restore','softDelete','restore','softDelete','restore']);
    console.log('ok  document soft-delete/restore IPC, retryable undo/redo and remote cache invalidation');
  }
  {
    // #36 archive: a type goes through the same document_action path as a delete, gated by Tana's archive kinds
    // (types only) plus write access; undo unarchives, redo archives again, and the page lists what the graph
    // returns behind includeArchived, newest first.
    const backend=mainHelpers(), access=require('../sdk/access'), { setArchived }=require('../sdk/node');
    const org=new Document('tana:org:'+ulid()), type=new Document('tana:type:'+ulid()), text=new Document(DOC,{peerId:'413'});
    org.transact(l=>l.getMap('data').set('memberUserProfileDocUris',{test:ME}));
    type.transact(l=>initDocument(l,'Project',ME,{kind:'type'})); text.transact(l=>initDocument(l,'not a type',ME));
    const docs=new Map([[org.id,org],[type.id,type],[text.id,text]]), calls=[], listed=[];
    const apply=async(action,id)=>{calls.push(action);docs.get(id).transact(l=>l.getMap('data').set('archivedAt',action==='archive'?123:0));return {responseUnion:{case:'documentActionResponse'}};};
    const ctx={orgDocUri:org.id,sync:{subscribe:async id=>docs.get(id)}};
    assert.deepEqual([(await access.capabilities(type,ME,ctx)).archivable,(await access.capabilities(type,ME,ctx)).deletable],[true,false],'a type is archived, never soft-deleted');
    assert.equal((await access.capabilities(text,ME,ctx)).archivable,false,'Tana archives types only');
    assert.equal(await access.canArchive(type,'tana:user-profile:'+ulid(),ctx),false,'no write access, no archive');
    backend.testRuntime({me:{userUri:ME,orgId:ORG,orgDocUri:org.id},session:{getAccessToken:async()=> 'x.'+Buffer.from(JSON.stringify({org_id:ORG,role:'member'})).toString('base64url')+'.x'},
      client:{sync:{getDocument:id=>docs.get(id),subscribe:async id=>docs.get(id),archive:id=>apply('archive',id),unarchive:id=>apply('unarchive',id)},
        graph:{listNodes:async p=>{listed.push(p);return {nodes:[{id:'tana:type:a',title:'Old',archivedAt:'2026-09-01T00:00:00Z'},{id:'tana:type:b',title:'',archivedAt:'2026-09-20T00:00:00Z'},{id:'tana:type:c',title:'Live'}]};}}},
      win:{isDestroyed:()=>false,webContents:{send:()=>{}}}});
    assert.equal(await backend.documentAction(type.id,'archive'),type.id);assert.equal(readNode(type).archivedAt,123);
    await backend.undo();assert.equal(readNode(type).archivedAt,0,'undo unarchives');
    await backend.redo();assert.equal(readNode(type).archivedAt,123,'redo archives again');
    await assert.rejects(backend.documentAction(text.id,'archive'),/Archive permission/);
    await assert.rejects(backend.documentAction(type.id,'purge'),/Unknown document action/);
    assert.deepEqual(calls,['archive','unarchive','archive']);
    assert.deepEqual(JSON.parse(JSON.stringify(await backend.archivedTypes())),[{id:'tana:type:b',title:'Untitled',archivedAt:'2026-09-20T00:00:00Z'},{id:'tana:type:a',title:'Old',archivedAt:'2026-09-01T00:00:00Z'}]);
    assert.equal(listed[0].includeArchived,true,'only includeArchived brings an archived type back');
    // Tana's loaded-document path: archivedAt stamped with the time and the actor; unarchive writes 0, not a delete
    const loaded=new Document('tana:type:'+ulid()); loaded.transact(l=>initDocument(l,'Loaded',ME,{kind:'type'}));
    setArchived(loaded,true,ME,456); assert.deepEqual([readNode(loaded).archivedAt,readNode(loaded).archivedBy],[456,ME]);
    setArchived(loaded,false,ME); assert.deepEqual([readNode(loaded).archivedAt,readNode(loaded).archivedBy],[0,ME]);
    assert.throws(()=>setArchived(loaded,true,'tana:org:x'),/archivedBy/);
    console.log('ok  archive: types only with write access, document_action with undo/redo, includeArchived listing, loaded-doc data write');
  }
  {
    const backend=mainHelpers(), cache=require('../db');cache.open(':memory:');
    const docs=new Map(), created=[];
    const make=(kind,title,extra={})=>{const d=new Document('tana:'+kind+':'+ulid());d.transact(l=>{initDocument(l,title,ME);const data=l.getMap('data');data.set('type',kind);for(const [k,v] of Object.entries(extra))data.set(k,v);});docs.set(d.id,d);return d;};
    const space=make('space','Type home'), textType=make('type','Project',{ownerUri:space.id}), eventType=make('type','Workshop',{appliesTo:'events'}), unknownType=make('type','Unknown',{appliesTo:'future'});
    const typeNodes=[textType,eventType,unknownType].map(d=>({id:d.id,title:readNode(d).title}));
    backend.testRuntime({me:{userUri:ME,orgId:ORG},session:{getAccessToken:async()=> 'x.'+Buffer.from(JSON.stringify({org_id:ORG,role:'member'})).toString('base64url')+'.x'},client:{graph:{listNodes:async()=>({nodes:typeNodes,totalCount:3})},sync:{subscribe:async(id,init)=>{if(init){const d=new Document(id);d.transact(init);docs.set(id,d);created.push(d);return d;}if(!docs.has(id))throw new Error('unavailable');return docs.get(id);}}}});
    await assert.rejects(backend.createDocument('   ',{kind:'chat'}),/empty draft/);
    assert.equal(created.length,0,'empty chooser draft does not start a create');
    const choices=await backend.creationOptions();assert.equal(choices.complete,true);
    assert.deepEqual(Array.from(choices.options.slice(0,4),o=>o.kind),['doc','task','meeting','chat']);
    const plainDoc=await backend.createDocument('Plain note',{kind:'doc'});
    assert.equal(plainDoc.icon,'doc');assert.ok(plainDoc.id.startsWith('tana:text:'));
    assert.equal(choices.options.find(o=>o.typeUri===unknownType.id).selectable,false);
    assert.equal(choices.options.find(o=>o.typeUri===textType.id).icon,'type','a type is offered with the glyph its documents wear, so its draft does not start as a plain doc');
    const chat=await backend.createDocument('New conversation',{kind:'chat'});
    assert.equal(chat.icon,'chat');assert.ok(chat.id.startsWith('tana:chat:'));
    const chatData=readNode(docs.get(chat.id));assert.deepEqual(chatData.messages,[]);assert.deepEqual(chatData.participantUris,[]);
    assert.equal(docs.get(chat.id).content.get('nodeName'),undefined,'chat has no invented outline');
    const typed=await backend.createDocument('New project',{kind:'custom',typeUri:textType.id});
    assert.equal(readNode(docs.get(typed.id)).entityTypeUri,textType.id);
    assert.equal(readNode(docs.get(typed.id)).ownerUri,space.id);assert.equal(readNode(docs.get(typed.id)).restricted,true);
    const event=await backend.createDocument('Working session',{kind:'custom',typeUri:eventType.id});
    assert.ok(event.id.startsWith('tana:event:'));assert.equal(readNode(docs.get(event.id)).entityTypeUri,eventType.id);
    assert.equal(readNode(docs.get(event.id)).origin,'tana');assert.equal(created.length,4);
    // A saved search is created from a query, never from a bare title. Both directions are refused, and neither
    // leaves a half-made document behind: a search born with an empty query map would be unopenable, since
    // searchChildren reads that as unreadable and fails closed.
    await assert.rejects(backend.createDocument('No query',{kind:'search'}),/needs a query/);
    await assert.rejects(backend.createDocument('Not a search',{kind:'doc',query:{types:['text']}}),/Only a saved search carries a query/);
    assert.equal(created.length,4,'a refused search creates nothing');
    const search=await backend.createDocument('My Tasks',{kind:'search',query:{types:['text'],assignedToViewer:true}});
    assert.ok(search.id.startsWith('tana:search:'),'a saved search gets its own id kind');
    const searchDoc=docs.get(search.id);
    assert.equal(readNode(searchDoc).type,'search');
    assert.deepEqual(searchDoc.loro.getMap('query').toJSON().types,['text'],'the query survives the real create path, not just initDocument');
    assert.equal(searchDoc.loro.getMap('query').toJSON().assignedToViewer,true);
    assert.equal(readNode(searchDoc).sharedPinDates,undefined,'and it still carries none of the fields a real one lacks');
    assert.equal(created.length,5);
    // "Save this query as a search" goes through main, not the renderer: the renderer sends a view id, main
    // translates the filter it already owns. An unknown view must be refused by viewFilter before anything exists.
    await assert.rejects(backend.searchCreate('nope'),/unknown view/);
    assert.equal(created.length,5,'a bad view id creates nothing');
    const fromLibrary=await backend.searchCreate('library');
    assert.ok(fromLibrary.id.startsWith('tana:search:'));
    const libQuery=docs.get(fromLibrary.id).loro.getMap('query').toJSON();
    // The stored query is the *written* form of the spec, not the spec itself: writeSearchQuery materialises every
    // key so a filter the user removes cannot linger, while filterToSearchQuery returns only what carries a value.
    // So the spec's keys must all be present and equal, and the rest must be present and empty.
    const libSpec=filterToSearchQuery(backend.viewFilter('library'),ME);
    for(const [k,v] of Object.entries(libSpec)) assert.deepEqual(libQuery[k],v,'stored query keeps '+k+' as the view asked');
    assert.deepEqual(libQuery.assignedTo,[],'and every other list key is written empty rather than left out');
    assert.deepEqual(libQuery.entityTypeUris,[]);
    assert.deepEqual(libQuery.workflowStates,[]);
    assert.deepEqual(libQuery.attributes,{});
    assert.deepEqual(libQuery.types,['text'],'and it is in the document vocabulary, not the UI one');
    // The Library preset is the My Tasks saved search (#113), so saving it writes that query back: every state, anyone.
    assert.deepEqual(libQuery.stateTypes,['proposed','open','closed','not_now'],'the Library preset saves every task state');
    assert.notEqual(libQuery.assignedToViewer,true,'and nobody in particular as the assignee');
    // Named from the filter rather than "Untitled", and an explicit title wins.
    assert.equal(backend.searchTitle('library',{states:['open'],assignee:'me'}),'Library — open · mine');
    assert.equal(backend.searchTitle('library',{}),'Library','a bare filter still names its view');
    assert.equal(backend.searchTitle('library',{text:'  dpa  '}),'Library — "dpa"');
    const named=await backend.searchCreate('library','Quarterly review');
    assert.equal(readNode(docs.get(named.id)).title,'Quarterly review','an explicit title beats the derived one');
    assert.equal(created.length,7);
    space.transact(l=>l.getMap('data').get('participants').get(ME).set('role','viewer'));
    await assert.rejects(backend.createDocument('Blocked',{kind:'custom',typeUri:textType.id}),/permission/);
    await assert.rejects(backend.createDocument('Invalid',{kind:'custom',typeUri:unknownType.id}),/Unsupported type target/);
    assert.equal(created.length,7,'invalid scope/types do not create partial documents'); // 7: three legitimate saved searches are created above
    console.log('ok  creation chooser: native chats, actual typed docs/events, home-space validation and unsaved blank drafts');
  }
  // Setting a document's type (Cmd+K "Set type"), by Tana's own two rules (their shared bundle, read 2026-09-20):
  // a type applies to documents or to meetings, and a type that lives in a space only goes on a document already in
  // that space — exactly that space, not a sub-space — while a type with no home space goes on anything.
  {
    const backend=mainHelpers(), cache=require('../db');cache.open(':memory:');
    const docs=new Map();
    const make=(kind,title,extra={})=>{const d=new Document('tana:'+kind+':'+ulid());d.transact(l=>{initDocument(l,title,ME,kind==='event'?{kind:'meeting'}:{});const data=l.getMap('data');data.set('type',kind);for(const [k,v] of Object.entries(extra))data.set(k,v);});docs.set(d.id,d);return d;};
    const home=make('space','Foundry'), elsewhere=make('space','CTO');
    const homed=make('type','Decision Record',{ownerUri:home.id});
    const anywhere=make('type','Co-Worker');
    const forMeetings=make('type','Progress Meeting',{appliesTo:'events'});
    const workflowed=make('type','Pipeline',{workflowUri:'tana:workflow:'+ulid()});
    const inSpace=make('text','Tuxis',{ownerUri:home.id}), loose=make('text','Loose note'), elsewhereDoc=make('text','Other',{ownerUri:elsewhere.id});
    const meeting=make('event','Weekly');
    // what the index answers for a type: its home space, and appliesTo inside typeDef (absent = documents)
    const typeNode=(d)=>{const n=readNode(d);return {id:d.id,title:n.title,...(n.ownerUri?{ownerUri:n.ownerUri}:{}),...(n.appliesTo?{typeDef:{appliesTo:n.appliesTo}}:{})};};
    const typeNodes=[homed,anywhere,forMeetings,workflowed].map(typeNode);
    const byId=new Map([...typeNodes.map(n=>[n.id,n]),[home.id,{id:home.id,title:'Foundry'}],[elsewhere.id,{id:elsewhere.id,title:'CTO'}]]);
    backend.testRuntime({me:{userUri:ME},win:null,client:{
      graph:{listNodes:async(p)=>(p.nodeIds?{nodes:p.nodeIds.map(id=>byId.get(id)).filter(Boolean)}:{nodes:typeNodes,totalCount:typeNodes.length})},
      sync:{subscribe:async(id)=>{if(!docs.has(id))throw new Error('unavailable');return docs.get(id);},getDocument:(id)=>docs.get(id),unsubscribe:async()=>{}},
    }});
    await assert.rejects(backend.typeChoices(home.id),/documents and meetings/,'a space carries no type, so it is not offered the list');
    const inHome=await backend.typeChoices(inSpace.id);
    assert.deepEqual(inHome.options.map(o=>o.title),['Co-Worker','Decision Record','Pipeline'],'a meeting type is not offered to a document, and the list is by title');
    assert.deepEqual(inHome.options.filter(o=>o.selectable).map(o=>o.title),['Co-Worker','Decision Record','Pipeline'],'its own space\u2019s type and the homeless ones fit');
    const outside=await backend.typeChoices(loose.id);
    const record=outside.options.find(o=>o.title==='Decision Record');
    assert.equal(record.selectable,false,'a space\u2019s type does not fit a document outside it');
    assert.equal(record.reason,'Lives in Foundry','and the row says which space it belongs to rather than vanishing');
    assert.equal(outside.options.find(o=>o.title==='Co-Worker').selectable,true,'a Library type fits everything');
    assert.deepEqual((await backend.typeChoices(meeting.id)).options.map(o=>o.title),['Progress Meeting'],'a meeting is offered meeting types only');
    await assert.rejects(backend.setType(loose.id,homed.id),/Lives in Foundry|lives in Foundry/,'the write applies the same scope rule as the list');
    await assert.rejects(backend.setType(elsewhereDoc.id,homed.id),/Foundry/,'another space is no closer than none');
    await assert.rejects(backend.setType(inSpace.id,forMeetings.id),/applies to meetings/);
    await assert.rejects(backend.setType(meeting.id,homed.id),/applies to documents/);
    assert.equal(readNode(inSpace).entityTypeUri,undefined,'a refusal writes nothing');
    await backend.setType(inSpace.id,homed.id);
    assert.equal(readNode(inSpace).entityTypeUri,homed.id);
    assert.equal((await backend.typeChoices(inSpace.id)).current,homed.id,'the list says which one it has now');
    // The type a document already has can be replaced outright: Tana's setEntityType refuses that and points at
    // retype, which is what this command is.
    await backend.setType(inSpace.id,anywhere.id);
    assert.equal(readNode(inSpace).entityTypeUri,anywhere.id);
    await backend.undo();
    assert.equal(readNode(inSpace).entityTypeUri,homed.id,'a retype is one undo step, like every other mutation');
    await backend.redo();
    assert.equal(readNode(inSpace).entityTypeUri,anywhere.id);
    assert.equal(await backend.setType(inSpace.id,null),null);
    assert.equal(readNode(inSpace).entityTypeUri,undefined,'"No type" removes the key rather than emptying it');
    // A type that defines a workflow expects its documents to be in it, so an untyped document enters the first state.
    await backend.setType(loose.id,workflowed.id);
    assert.equal(readNode(loose).stateType,'proposed','a workflow type starts its document in the workflow');
    assert.equal(readNode(loose).stateChangedBy,ME);
    await backend.setType(loose.id,anywhere.id);
    assert.equal(readNode(loose).stateType,'proposed','and a later retype leaves the state where it is');
    assert.equal(readNode(loose).stateWorkflowUri,undefined,'while the workflow state keys leave with the type that defined them');
    // The row a list cached carries the chip it was built with, so a retype has to rebuild it rather than patch it.
    cache.upsert({...backend.graphRow({id:inSpace.id,title:'Tuxis',updateTime:new Date().toISOString()}),section:'library'});
    await backend.setType(inSpace.id,homed.id);
    const patched=await backend.handlers.get('doc:info')(null,inSpace.id);
    assert.equal((patched.tags||[]).some(t=>t.uri===homed.id),true,'doc:info rebuilds a row whose type moved on');
    console.log('ok  set type: what a type applies to, the space it keeps its documents in, removal, undo and the row that follows');
  }
  // "Discuss with …" (Cmd+K): one answer types the document and fills the one field that type exists for. The type
  // and the field are matched by title because a workspace that has never seen either has nothing else to match on,
  // and Tana's field keys are eight characters generated per workspace. The field holds plain text: every instance
  // of the real type read on 2026-09-20 does, and several name a team rather than a person.
  {
    const backend=mainHelpers(), cache=require('../db');cache.open(':memory:');
    const fieldsSdk=require('../sdk/fields');
    const docs=new Map(), created=[], events=[];
    const make=(kind,title,extra={})=>{const d=new Document('tana:'+kind+':'+ulid());d.transact(l=>{initDocument(l,title,ME);const data=l.getMap('data');data.set('type',kind);for(const [k,v] of Object.entries(extra))data.set(k,v);});docs.set(d.id,d);return d;};
    const target=make('text','Roadmap gap'), other=make('text','Second one');
    // the workspace's people: two Stans, so a first name alone is ambiguous for them and not for anyone else
    const people=[['Stan Engbers'],['Stan Vermeer'],['Peter Leppers'],['Martijn van de Wiel'],['Steven Rekk\u00e9']].map(([title])=>({id:'tana:user-profile:'+ulid(),title,userProfile:{name:title}}));
    const node=(d)=>{const n=readNode(d);return {id:d.id,title:n.title,...(n.ownerUri?{ownerUri:n.ownerUri}:{})};};
    const typeNodes=()=>[...docs.values()].filter(d=>readNode(d).type==='type').map(node);
    const runtime=()=>backend.testRuntime({me:{userUri:ME},win:{isDestroyed:()=>false,webContents:{send:(...args)=>events.push(args)}},client:{
      graph:{listNodes:async(p)=>(p.nodeIds?{nodes:[...docs.values()].filter(d=>p.nodeIds.includes(d.id)).map(node)}
        :(p.nodeTypes||[]).includes('user-profile')?{nodes:people}
        :{nodes:typeNodes(),totalCount:typeNodes().length})},
      sync:{subscribe:async(id,init)=>{if(init){const d=new Document(id);d.transact(init);docs.set(id,d);created.push(d);return d;}if(!docs.has(id))throw new Error('unavailable');return docs.get(id);},getDocument:(id)=>docs.get(id),unsubscribe:async()=>{}},
    }});
    runtime();
    await assert.rejects(backend.discussWith(target.id,'   '),/discussed with/);
    await assert.rejects(backend.discussWith('tana:event:'+ulid(),'Someone'),/document/,'a meeting cannot be a discussion task: the type applies to documents');
    assert.equal(created.length,0,'a refusal creates no type');
    const first=await backend.discussWith(target.id,'Peter Leppers');
    assert.equal(created.length,1,'the workspace had no such type, so one was made');
    const type=created[0], typeJson=type.loro.toJSON();
    assert.ok(type.id.startsWith('tana:type:'));
    assert.deepEqual(Object.keys(typeJson.data).sort(),['sharedPinDates','template','title','type'],'a type carries what a real one carries, and none of what a document carries');
    assert.deepEqual([typeJson.data.title,typeJson.data.type,typeJson.data.ownerUri],['Discussion Task','type',undefined],'titled, a type, and in the Library so it fits a document in any space');
    const attrs=typeJson.data.template.attributes;
    assert.deepEqual(attrs.map(a=>[a.title,a.cardinality]),[['Discuss with','multiple']],'born with the field it exists for');
    assert.equal(first.key,type.id+'?attribute='+attrs[0].key,'the key is the type\u2019s own, not one this app invented');
    assert.equal(readNode(target).entityTypeUri,type.id,'the document wears the type');
    assert.deepEqual(fieldsSdk.readFields(docs.get(target.id)).map(f=>[f.key,f.text]),[[first.key,'Peter Leppers']],'and the name is in its field');
    const second=await backend.discussWith(other.id,'Heads of Technology');
    assert.equal(created.length,1,'the next one finds the type instead of making a second');
    assert.equal(second.key,first.key,'and the same field, found by title');
    assert.deepEqual(fieldsSdk.readFields(docs.get(other.id)).map(f=>f.text),['Heads of Technology'],'a team is a name like any other: the field is plain text');
    await backend.discussWith(target.id,'Martijn van de Wiel');
    assert.deepEqual(fieldsSdk.readFields(docs.get(target.id)).map(f=>f.text),['Martijn van de Wiel'],'a second answer replaces the first rather than adding to it');
    assert.equal(created.length,1);
    // A workspace where the type was made by hand and carries no such field: the field is added to it, rather than
    // a second type appearing beside the one that is already there.
    docs.clear(); created.length=0;
    const handmade=make('type','discussion task'), plain=make('text','Handmade workspace');
    runtime();
    const third=await backend.discussWith(plain.id,'Olaf van Zandwijk');
    assert.equal(created.length,0,'the existing type is used, whatever its capitals');
    assert.equal(third.typeUri,handmade.id);
    assert.deepEqual(readNode(handmade).template.attributes.map(a=>[a.title,a.cardinality]),[['Discuss with','multiple']],'and it gains the field');
    assert.deepEqual(fieldsSdk.readFields(docs.get(plain.id)).map(f=>f.text),['Olaf van Zandwijk']);
    // The people in that answer become references to their profiles, and the rest stays words.
    const seg=(id)=>fieldsSdk.readFields(docs.get(id))[0].segments;
    const uriOf=(title)=>people.find(p=>p.title===title).id;
    const both=await backend.discussWith(plain.id,'Stan Engbers and Ria');
    assert.deepEqual(seg(plain.id),[{mention:{label:'Stan Engbers',uri:uriOf('Stan Engbers')}},{text:' and Ria'}],
      'a member is an inline reference to their profile; someone who is not stays words');
    assert.deepEqual([...both.mentions],[uriOf('Stan Engbers')],'and the call says who it referenced');
    await backend.discussWith(plain.id,'Peter Leppers and Martijn van de Wiel');
    assert.deepEqual(seg(plain.id),[{mention:{label:'Peter Leppers',uri:uriOf('Peter Leppers')}},{text:' and '},{mention:{label:'Martijn van de Wiel',uri:uriOf('Martijn van de Wiel')}}],
      'two people are two references, with the words between them kept');
    await backend.discussWith(plain.id,'Steven Rekk\u00e9');
    assert.deepEqual(seg(plain.id),[{mention:{label:'Steven Rekk\u00e9',uri:uriOf('Steven Rekk\u00e9')}}],'a name ending in a letter \\b does not know still ends');
    await backend.discussWith(plain.id,'Peter');
    assert.deepEqual(seg(plain.id),[{mention:{label:'Peter',uri:uriOf('Peter Leppers')}}],'a first name alone is enough when only one person has it, and the words typed stay the label');
    await backend.discussWith(plain.id,'Peter Schuurman');
    assert.deepEqual(seg(plain.id),[{text:'Peter Schuurman'}],'an unknown full name must not link to a different person with the same first name');
    await backend.discussWith(plain.id,'Peter Schuurman and Peter');
    assert.deepEqual(seg(plain.id),[{text:'Peter Schuurman and '},{mention:{label:'Peter',uri:uriOf('Peter Leppers')}}],'only the standalone first name matches, even after an unknown full name');
    await backend.discussWith(plain.id,'Peter en Martijn');
    assert.deepEqual(seg(plain.id),[{mention:{label:'Peter',uri:uriOf('Peter Leppers')}},{text:' en '},{mention:{label:'Martijn',uri:uriOf('Martijn van de Wiel')}}],'separate first names still match');
    await backend.discussWith(plain.id,'Stan');
    assert.deepEqual(seg(plain.id),[{text:'Stan'}],'but not when two people share it: an ambiguous first name is words, not a guess at one of them');
    await backend.discussWith(plain.id,'Standard procedure with Peterson');
    assert.deepEqual(seg(plain.id),[{text:'Standard procedure with Peterson'}],'and a name inside a longer word is not that name');
    const twice=await backend.discussWith(plain.id,'Peter Leppers and Peter Leppers');
    assert.deepEqual(seg(plain.id),[{mention:{label:'Peter Leppers',uri:uriOf('Peter Leppers')}},{text:' and Peter Leppers'}],'nobody is referenced twice in one answer');
    assert.equal(twice.mentions.length,1);
    await backend.discussWith(plain.id,'Heads of Technology');
    assert.deepEqual(seg(plain.id),[{text:'Heads of Technology'}],'a team nobody here is named after is written as it was typed');
    // What Classify type sends (main/documents.js typeCandidates): each type the document may have, with the
    // description and AI instructions read off the type's own document, since the graph carries neither.
    const described=make('type','Decision Record',{description:'One decision',instructions:'Return exactly one decision'});
    make('type','Space only',{ownerUri:'tana:space:'+ulid()});
    assert.deepEqual(JSON.parse(JSON.stringify(await backend.typeCandidates(plain.id))),{title:'Handmade workspace',text:'',current:handmade.id,types:[
      {uri:described.id,title:'Decision Record',description:'One decision',instructions:'Return exactly one decision'},{uri:handmade.id,title:'discussion task'}]},
      'the types Set type would offer, each with its own words, and none that lives in another space');
    // Undo is not only the write going back: the page has to hear about it, or it keeps showing the name that was
    // undone until something else refreshes it. Both directions announce a field change — not a metadata one, which
    // throws the page's assignees and audience away (Visible to vanished while a field was edited) — and the zoomed
    // page re-reads its fields.
    docs.get(plain.id).on('change',()=>backend.onChange(plain.id));
    const metaOf=()=>events.filter(([channel,id])=>channel==='outline:changed'&&id===plain.id).map(e=>e[2]&&[e[2].meta,e[2].fields]);
    await backend.discussWith(plain.id,'Peter Leppers');
    await backend.discussWith(plain.id,'Stan Engbers');
    events.length=0;
    assert.equal(await backend.undo(),plain.id);
    assert.deepEqual(fieldsSdk.readFields(docs.get(plain.id)).map(f=>f.text),['Peter Leppers'],'undo puts the previous name back');
    assert.deepEqual(metaOf(),[[false,true]],'and announces it as a field change, which redraws the field and keeps the metadata');
    events.length=0;
    await backend.redo();
    assert.deepEqual(fieldsSdk.readFields(docs.get(plain.id)).map(f=>f.text),['Stan Engbers'],'redo brings it forward again');
    assert.deepEqual(metaOf(),[[false,true]],'and says so the same way');
    console.log('ok  discuss with: the type found by title or created in the Library with its field, the document typed and the name written');
  }
  // A field value edited through main, by the id the page uses: "<document>|<type>?attribute=<key>". Every block:
  // handler takes it, because document() hands back the field view and the rest is the same code as a page.
  {
    const backend=mainHelpers(), cache=require('../db');cache.open(':memory:');
    const fieldsSdk=require('../sdk/fields'), outlineSdk=require('../sdk/content');
    const docs=new Map();
    const doc=new Document('tana:text:'+ulid());doc.transact(l=>initDocument(l,'Typed',ME));docs.set(doc.id,doc);
    const key='tana:type:'+ulid()+'?attribute=n5e1hgxz', fieldId=doc.id+'|'+key;
    backend.testRuntime({me:{userUri:ME},win:{isDestroyed:()=>false,webContents:{send:()=>{}}},client:{
      graph:{listNodes:async()=>({nodes:[]})},
      sync:{subscribe:async(id)=>{if(!docs.has(id))throw new Error('unavailable');return docs.get(id);},getDocument:(id)=>docs.get(id),unsubscribe:async()=>{}},
    }});
    const handler=(name)=>backend.handlers.get(name);
    const flat=(value)=>JSON.parse(JSON.stringify(value));
    assert.deepEqual(flat(await handler('outline:children')(null,fieldId)),[],'a field with no value reads as no rows');
    assert.deepEqual(Object.keys(doc.data.toJSON().attributes||{}),[],'and reading it wrote nothing: opening a typed page must not fill in its empty fields');
    const first=await handler('block:insertAfter')(null,fieldId,null,'Rob Schuurman'); // the new block's id, as on a page
    await handler('block:insertAfter')(null,fieldId,first,'Rianne Jans');
    await handler('block:insertChild')(null,fieldId,first,'a note under Rob');
    const rows=flat(await handler('outline:children')(null,fieldId));
    assert.deepEqual(rows.map(r=>r.segments.map(s=>s.text).join('')),['Rob Schuurman','Rianne Jans'],'rows are written into the field, by the same handler a page uses');
    assert.deepEqual(rows[0].children.map(r=>r.segments.map(s=>s.text).join('')),['a note under Rob'],'and a row in a field can hold children');
    await handler('block:setText')(null,fieldId,rows[1].id,'Rianne Jans ');
    assert.equal(fieldsSdk.readFields(doc)[0].text.split('\n')[1].trim(),'a note under Rob','the value is one field of the document, not a second document');
    assert.equal(outlineSdk.readOutline(doc).some(r=>(r.segments||[]).some(s=>(s.text||'').includes('Rob'))),false,'and none of it reached the document\u2019s own outline');
    // undo belongs to the document that carries the field, so ⌘Z on a field row is the same stack as everything else
    assert.equal(await backend.undo(),doc.id,'the undo step is the document, not the field id');
    assert.deepEqual(flat(await handler('outline:children')(null,fieldId))[1].segments.map(s=>s.text).join(''),'Rianne Jans','and it puts the row back');
    await assert.rejects(handler('outline:children')(null,doc.id+'|not-a-field'),/./,'an id that is not a field is not a document either');
    console.log('ok  field values are outlines: every block handler takes "<document>|<field>", children and all, on the document\u2019s own undo stack');
  }
  // An image lives in the file cache, not in main's memory (issue #271): two asks at once share one fetch, and once
  // it has settled nothing in memory answers for it any more.
  {
    const images = require('../main/images'), { S } = require('../main/state'), nodePath = require('node:path');
    const dir = fs.mkdtempSync(nodePath.join(require('node:os').tmpdir(), 'orbital-images-'));
    const saved = { fetch: globalThis.fetch, session: S.session, userData: S.userData };
    let fetches = 0;
    globalThis.fetch = async (url) => { fetches++; return String(url).includes('/images/by-uri/')
      ? { status: 302, headers: { getSetCookie: () => [], get: () => 'https://images.example/x' } }
      : { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
    S.session = { getAccessToken: async () => 'token' }; S.userData = dir;
    try {
      const uri = 'tana:image:' + ulid();
      const [a, b] = await Promise.all([images.image(uri), images.image(uri)]);
      assert.deepEqual([a, b], ['data:image/png;base64,AQID', 'data:image/png;base64,AQID']);
      assert.equal(fetches, 2, 'two asks at once are one load: the locate and the CDN read');
      assert.equal(await images.image(uri), a, 'a later ask is answered');
      assert.equal(fetches, 2, 'by the file');
      fs.rmSync(nodePath.join(dir, 'images'), { recursive: true });
      assert.equal(await images.image(uri), a);
      assert.equal(fetches, 4, 'and with the file gone it is fetched again: no map kept the image in memory');
    } finally { globalThis.fetch = saved.fetch; S.session = saved.session; S.userData = saved.userData; fs.rmSync(dir, { recursive: true, force: true }); }
    console.log('ok  images: one fetch per load in flight, then the file cache, nothing held in memory');
  }
  // The suggestion behind that page (main/ai.js): the one call this app makes to a model. A title goes out and a
  // name comes back; nothing is sent without a key, and the key never leaves this machine. fetch is injected, so
  // this check is offline like every other one here.
  {
    const ai=require('../main/ai'), settings=require('../main/settings'), cache=require('../db');
    cache.open(':memory:'); settings.reset();
    const calls=[];
    const answer=(text)=>({ok:true,status:200,json:async()=>({output:[{type:'message',content:[{type:'output_text',text}]}]})});
    const fetchWith=(result)=>async(url,init)=>{calls.push({url,init:{...init,body:JSON.parse(init.body)}});return typeof result==='function'?result():result;};
    assert.equal(await ai.suggestDiscussWith('Discuss this with Stan',fetchWith(answer('Stan'))),null,'no key on this machine means no suggestion, and nothing sent');
    assert.equal(calls.length,0);
    await assert.rejects(ai.classifyType({title:'t',text:'',types:[{uri:'tana:type:a',title:'A'}]},fetchWith(answer('{"1":1}'))),/OpenAI API key/,'classifying without one says how to get one');
    assert.equal(calls.length,0,'and sends nothing either');
    assert.deepEqual(await ai.translate(['Open vraag over het budget'],'English',fetchWith(answer('[]')),undefined,{detect:null}),[null],'nor does translating: the words are shown as written (#547)');
    assert.equal(calls.length,0);
    settings.set('openaiApiKey','sk-local-only');
    assert.equal(await ai.suggestDiscussWith('   ',fetchWith(answer('Stan'))),null,'an untitled document has nothing to read');
    assert.equal(calls.length,0,'and still nothing is sent');
    assert.equal(await ai.suggestDiscussWith('Discuss this with Stan',fetchWith(answer('Stan'))),'Stan');
    assert.deepEqual([calls[0].url,calls[0].init.headers.authorization],[ai.ENDPOINT,'Bearer sk-local-only']);
    assert.deepEqual([calls[0].init.body.model,calls[0].init.body.reasoning.effort],[ai.DEFAULT_MODEL,ai.DEFAULT_EFFORT]);
    assert.deepEqual([ai.DEFAULT_MODEL,ai.DEFAULT_EFFORT],['gpt-5.6-terra','low'],'the fast AI: Terra with a little reasoning, measured no slower than Luna and right where Luna was sure and wrong');
    assert.deepEqual([calls[0].init.body.input,calls[0].init.body.instructions],['Discuss this with Stan',ai.INSTRUCTIONS],'the title is the input; the rule is the instructions, so a title cannot be one');
    assert.equal(Object.keys(calls[0].init.body).length,4,'the title and nothing else about the document goes out');
    settings.set('aiModel','gpt-5.6-sol'); settings.set('aiEffort','high');
    await ai.suggestDiscussWith('Discuss this with Stan',fetchWith(answer('Stan')));
    assert.deepEqual([calls[1].init.body.model,calls[1].init.body.reasoning.effort],['gpt-5.6-sol','high'],'both are settings, changeable without a release');
    assert.equal(settings.isSynced('aiModel')&&settings.isSynced('aiEffort'),true,'and they follow you, unlike the key that pays for them');
    assert.equal(settings.isSynced('openaiApiKey'),false,'which never leaves this machine');
    settings.set('aiModel',undefined); settings.set('aiEffort',undefined);
    // What comes back, in the shapes the Responses API answers in, and the answers that are not a name.
    assert.equal(await ai.suggestDiscussWith('t',fetchWith({ok:true,status:200,json:async()=>({output_text:'Heads of Tech'})})),'Heads of Tech','the convenience field is read too');
    assert.equal(await ai.suggestDiscussWith('t',fetchWith(answer('  \u201CStan and Peter\u201D  '))),'Stan and Peter','trimmed, and the quotes a model likes to add are taken off');
    assert.equal(await ai.suggestDiscussWith('t',fetchWith(answer(''))),null,'a title naming nobody is an empty answer, not a guess');
    // The boot icon pick (issue #250): every icon name and the type titles go out, and the answer maps back to uris.
    const picked=await ai.pickTypeIcons([{uri:'tana:type:a',title:'Meeting'},{uri:'tana:type:b',title:'Person'}],['calendar','user'],fetchWith(answer('Sure: {"1": " calendar ", "2": 7}')));
    assert.deepEqual(picked,{'tana:type:a':'calendar','tana:type:b':null},'a name is read per type number, trimmed, and anything else is no pick');
    assert.deepEqual([calls.at(-1).init.body.input,calls.at(-1).init.body.instructions],['Icons: calendar, user\n\n1: Meeting\n2: Person',ai.ICON_INSTRUCTIONS],'the names and the titles are the input, and nothing else about a type');
    assert.equal(await ai.suggestDiscussWith('t',fetchWith(answer('This title does not name anyone to discuss it with, so there is nobody to suggest here.'))),null,'a sentence is the model explaining itself: not a name');
    assert.equal(await ai.suggestDiscussWith('t',fetchWith(answer('Stan\nPeter'))),null,'nor is a list of lines');
    await assert.rejects(ai.suggestDiscussWith('t',fetchWith({ok:false,status:401,json:async()=>({})})),/401: check the API key/,'a rejected key says so rather than looking like an empty title');
    await assert.rejects(ai.suggestDiscussWith('t',fetchWith({ok:false,status:500,json:async()=>({})})),/OpenAI answered 500/);
    // Classify type: the same call, the types described by their own words beside the document, every option back with odds.
    const types=[{uri:'tana:type:a',title:'Decision Record',hue:143,description:'',instructions:'Return exactly one decision'},{uri:'tana:type:b',title:'Project',description:'A piece of work with an end'}];
    const typed={title:'Postgres over Mongo',text:'Agreed: we use Postgres',current:'tana:type:b',types};
    const classified=await ai.classifyType(typed,fetchWith(answer('\u0060\u0060\u0060json\n{"1": 0.85, "2": 0.05, "none": 0.1}\n\u0060\u0060\u0060')));
    assert.deepEqual(classified.choices.map((c)=>[c.uri,c.title,Math.round(c.p*100)]),[['tana:type:a','Decision Record',85],[null,'No type',10],['tana:type:b','Project',5]],
      'every option comes back with its odds, "No type" among them, most likely first, even from inside a code fence');
    assert.equal(classified.current,'tana:type:b','beside the type the document has now');
    const sent=calls.at(-1).init.body;
    assert.ok(['Type 1: Decision Record','AI instructions: Return exactly one decision','Type 2: Project','Description: A piece of work with an end','Postgres over Mongo','Agreed: we use Postgres'].every((s)=>sent.input.includes(s)),
      'each type is described by its own description and AI instructions, beside the document title and text');
    assert.deepEqual([sent.instructions,sent.model,sent.reasoning.effort],[ai.CLASSIFY_INSTRUCTIONS,ai.DEFAULT_MODEL,ai.DEFAULT_EFFORT],'the rules go as instructions, to the same fast AI the suggestion uses');
    assert.deepEqual((await ai.classifyType(typed,fetchWith(answer('{"is": "a decision already taken", "odds": {"1": 0.9, "none": 0.1}}')))).choices.map((c)=>[c.title,c.p]),[['Decision Record',0.9],['No type',0.1],['Project',0]],'the odds are read after what the model says the document is');
    assert.deepEqual((await ai.classifyType(typed,fetchWith(answer('{"2": 60, "none": 20, "7": 99}')))).choices.map((c)=>c.p),[0.75,0.25,0],
      'percentages are scaled to odds, and a type the list does not have is ignored');
    await assert.rejects(ai.classifyType(typed,fetchWith(answer('Decision Record'))),/probabilities/,'an answer without odds is an error, not a guess');
    // Translate (#547): one question for the batch, each text with its id, each answer read by its id under a JSON Schema the model must follow
    const tr=(t,to,f,only={detect:null})=>ai.translate(t,to,f,undefined,only); // detect: null, the model judges every text; the Mac's detector is asserted below
    const said=(...t)=>answer(JSON.stringify({translations:t.map(([id,lang,text])=>({id,lang,text}))}));
    const before=calls.length;
    const translated=await tr(['Open vraag: wie beheert het budget?','Review the contract','Plan de pilots'],'English',fetchWith(said([1,'Dutch','Open question: who manages the budget?'],[2,null,null],[3,'English','Plan the pilots'])));
    assert.deepEqual(translated,[{lang:'Dutch',text:'Open question: who manages the budget?'},null,null],'a translation per text, null for English and for an answer that calls itself English');
    assert.deepEqual([calls.length-before,JSON.parse(calls.at(-1).init.body.input)],[1,[{id:1,text:'Open vraag: wie beheert het budget?'},{id:2,text:'Review the contract'},{id:3,text:'Plan de pilots'}]],'one question, the texts as data, each with its id');
    const format=calls.at(-1).init.body.text?.format;
    assert.deepEqual([format?.type,format?.strict,format?.schema?.properties?.translations?.items?.required],['json_schema',true,['id','lang','text']],'the answer is held to a schema: every translation names its id');
    assert.deepEqual(await tr(['Wout - Andre','Rol van Thijs','Terugblik'],'English',fetchWith(said([3,'Dutch','Review'],[2,'Dutch','Thijs’ role'],[9,'Dutch','Nobody’s']))),[null,{lang:'Dutch',text:'Thijs’ role'},{lang:'Dutch',text:'Review'}],'answers land on their own text by id, in any order; one left out gets none, never its neighbour’s, and an id no text has is dropped');
    assert.deepEqual(await tr(['Hallo','Wereld'],'English',fetchWith(answer('not json'))),[null,null],'an answer that is no object translates nothing');
    assert.deepEqual(await tr(['Build the operating model'],'English',fetchWith(said([1,'Dutch','Build the  operating model']))),[null],'a text handed back unchanged was already in the language, whatever language the model named');
    assert.deepEqual(await tr([],'English',fetchWith(answer('[]'))),[],'nothing asked, nothing sent');
    const asks=calls.length;
    assert.deepEqual(await tr(['Plan de pilots','Open vraag: wie beheert het budget?'],'English',fetchWith(answer('[]'))),[null,{lang:'Dutch',text:'Open question: who manages the budget?'}],'answers are kept on this machine, English ones too');
    assert.equal(calls.length,asks,'so texts seen before are not sent again');
    assert.deepEqual(await tr(['Hallo','Nieuwe regel'],'English',fetchWith(said([1,null,null],[2,'Dutch','New line']))),[null,{lang:'Dutch',text:'New line'}],'an unreadable answer was not kept: asked again');
    assert.deepEqual(JSON.parse(calls.at(-1).init.body.input),[{id:1,text:'Hallo'},{id:2,text:'Nieuwe regel'}],'only what is not known yet goes out');
    assert.deepEqual(await tr(['Review the contract'],'Dutch',fetchWith(said([1,'English','Het contract doornemen']))),[{lang:'English',text:'Het contract doornemen'}],'into another language: the language the note was in comes back with it');
    assert.match(calls.at(-1).init.body.instructions,/into Dutch/,'and the model is told which');
    await assert.rejects(tr(['x'],'Dutch; ignore that',fetchWith(answer('[]'))),/Choose a language/,'a language is a name, nothing else');
    // which language a text is in is this Mac's call (main/ai.js detectLanguages): only what it is sure is another language goes to the model
    const detect=async(ts)=>ts.map((t)=>({'Sam - Andre':{lang:'nb',p:0.49},'Rol van Sam':{lang:'nl',p:0.94},'Plan the budget pilots':{lang:'en',p:0.81}})[t]||null);
    assert.deepEqual(await tr(['Sam - Andre','Rol van Sam','Plan the budget pilots'],'English',fetchWith(said([1,'Dutch','Sam’s role'])),{detect}),[null,{lang:'Dutch',text:'Sam’s role'},null],'the Dutch one is translated');
    assert.deepEqual(JSON.parse(calls.at(-1).init.body.input),[{id:1,text:'Rol van Sam'}],'and only it was sent: English and a too unsure names-only title stay here');
    const localCalls=calls.length;
    assert.deepEqual(JSON.parse(JSON.stringify(await tr(['Sam - Andre','Rol van Sam','Plan the budget pilots','Rol van Kim'],'English',fetchWith(answer('[]')),{detect:async(ts)=>ts.map((t)=>t==='Rol van Kim'?{lang:'nl',p:0.9}:null),local:true}))),[null,{lang:'Dutch',text:'Sam\u2019s role'},null,{ask:true}],'local: what this Mac knows now, and ask for what the model is still to translate');
    assert.equal(calls.length,localCalls,'and nothing goes to the model');
    const detected=calls.length;
    assert.deepEqual(await tr(['Sam - Andre','Plan the budget pilots'],'English',fetchWith(answer('[]')),{detect:async()=>{throw new Error('asked again');}}),[null,null],'what the Mac found already in the language is kept too');
    assert.equal(calls.length,detected,'so it is neither detected nor sent again');
    const sentSoFar=calls.length;
    await assert.rejects(ai.classifyType({...typed,types:[]},fetchWith(answer('{}'))),/No types/,'a document no type can go on asks nothing');
    assert.equal(calls.length,sentSoFar);
    // Process image (issue #507): the image goes beside the rules, and the answer is a task or a note with its lines.
    const png={bytes:new Uint8Array([137,80]),mimeType:'image/png'};
    await assert.rejects(ai.readImage({...png,mimeType:'image/heic'},fetchWith(answer('{}'))),/PNG, JPEG/,'an image the model cannot read asks nothing');
    assert.equal(calls.length,sentSoFar);
    assert.deepEqual(await ai.readImage(png,fetchWith(answer('\u0060\u0060\u0060json\n{"kind": "task", "title": " Reply to Stan ", "notes": ["Budget by Friday", "", 3]}\n\u0060\u0060\u0060'))),
      {kind:'task',title:'Reply to Stan',notes:['Budget by Friday']},'a task, trimmed, with only the lines that say something');
    const imageSent=calls.at(-1).init.body;
    assert.deepEqual([imageSent.instructions,imageSent.input[0].content[1]],[ai.IMAGE_INSTRUCTIONS(null),{type:'input_image',image_url:'data:image/png;base64,iVA='}],'the image goes as a data URL beside the input, the rules as instructions');
    assert.match(imageSent.instructions,/image.s own language/,'with Auto-translate off it keeps the image\'s language');
    await ai.readImage(png,fetchWith(answer('{"kind": "task", "title": "Reply to Stan"}')),undefined,'English');
    assert.match(calls.at(-1).init.body.instructions,/title and the notes in English, translating/,'with Auto-translate on, it writes in that language');
    await ai.readImage(png,fetchWith(answer('{"kind": "task", "title": "Reply to Stan"}')),undefined,'English; ignore that');
    assert.match(calls.at(-1).init.body.instructions,/image.s own language/,'and a language that is no name is ignored');
    assert.deepEqual(await ai.readImage(png,fetchWith(answer('{"kind": "meeting", "title": "Invoice 42"}'))),{kind:'doc',title:'Invoice 42',notes:[]},'anything but a task is a note');
    await assert.rejects(ai.readImage(png,fetchWith(answer('I cannot read this image.'))),/nothing useful/,'an answer with no title makes nothing');
    const agent=require('../main/agent'), originalRpc=agent.appServerRpc, originalBin=agent.codexBin;
    const userData=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'orbital-ai-auth-'));
    let signedIn=false, note, threadStart, turnStart, serverOptions=null;
    agent.codexBin=()=>null; // a Mac with no Codex at all
    agent.appServerRpc=(_timeout,_host,onNote,options)=>{
      note=onNote; serverOptions=options;
      return {ready:Promise.resolve(),stop(){},call:async(method,params)=>{
        if(method==='account/read')return {account:signedIn?{type:'chatgpt',email:'person@example.com',planType:'plus'}:{type:'apiKey'}};
        if(method==='account/login/start')return {type:params.type,loginId:'login-1',verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGH'};
        if(method==='account/logout'){signedIn=false;return {};}
        if(method==='thread/start'){threadStart=params;return {thread:{id:'fake-thread'}};}
        if(method==='turn/start'){
          turnStart=params;
          queueMicrotask(()=>note({method:'turn/completed',params:{threadId:'fake-thread',turn:{status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:'ChatGPT person'}]}}}));
          return {turn:{id:'fake-turn'}};
        }
        return {};
      }};
    };
    try {
      const none=await ai.chatgptStatus(userData);
      assert.deepEqual([none.available,none.signedIn,serverOptions],[true,false,null],'with no Codex and nothing downloaded, nobody is signed in here: an answer, not "sign-in unavailable", and nothing is spawned');
      assert.equal((await ai.logoutChatGPT(userData)).signedIn,false,'and signing out of nothing is nothing');
      const own=require('node:path').join(userData,'codex-app-server');
      fs.writeFileSync(own,''); // stands in for the signed server the first sign-in downloads
      const login=await ai.startChatGPTLogin(userData);
      assert.equal(serverOptions.bin,own,'the downloaded server runs sign-in when this Mac has no Codex');
      assert.deepEqual([login.userCode,login.verificationUrl],['ABCD-EFGH','https://auth.openai.com/codex/device'],'sign-in starts the device flow and returns only its code and verification URL');
      let signIns=0; ai.onSignedIn=()=>signIns++;
      signedIn=true; note({method:'account/login/completed',params:{loginId:'login-1',success:true}});
      ai.onSignedIn=null;
      assert.equal(signIns,1,'a completed sign-in tells main, which runs the type icon pick then rather than at the next boot');
      const status=await ai.chatgptStatus(userData);
      assert.deepEqual([status.signedIn,status.email,status.planType],[true,'person@example.com','plus'],'the app reads back the signed-in account status');
      assert.equal(Object.hasOwn(status,'accessToken'),false,'credentials never enter the status sent to the renderer');
      const before=calls.length, fallback=fetchWith(answer('API fallback'));
      assert.equal(await ai.suggestDiscussWith('Discuss with ChatGPT person',fallback,userData),'ChatGPT person','ChatGPT is used while signed in even when an API key is set');
      assert.equal(calls.length,before,'the API key fallback is not called while ChatGPT is signed in');
      assert.deepEqual([threadStart.ephemeral,threadStart.approvalPolicy,threadStart.sandbox,turnStart.sandboxPolicy.networkAccess],[true,'never','read-only',false],'the temporary ChatGPT request is ephemeral, read-only, and has no network access');
      assert.equal(Object.hasOwn(threadStart,'allowProviderModelFallback'),false,'thread/start uses fields accepted by older Codex CLI app-servers too');
      assert.equal(Object.hasOwn(threadStart,'runtimeWorkspaceRoots'),false,'and none the app-server gates behind the experimentalApi capability, which Orbital does not ask for');
      assert.deepEqual([turnStart.input.length,turnStart.input[0].text],[1,'Discuss with ChatGPT person'],'only the title is sent');
      await assert.rejects(ai.readImage({bytes:new Uint8Array([137,80]),mimeType:'image/png'},fallback,userData),/nothing useful/);
      assert.deepEqual(turnStart.input[1],{type:'image',url:'data:image/png;base64,iVA='},'a dropped image goes along the ChatGPT turn as well');
      const signedOut=await ai.logoutChatGPT(userData);
      assert.equal(signedOut.signedIn,false,'sign-out clears ChatGPT account status');
      { // a sign-in whose completion notification never arrives still ends: the next account read finds it done
        await ai.startChatGPTLogin(userData);
        let again=0; ai.onSignedIn=()=>again++;
        signedIn=true;
        const read=await ai.chatgptStatus(userData);
        assert.deepEqual([read.signedIn,read.loggingIn,read.userCode,again],[true,false,null,1],'a read that finds the account signed in ends the open sign-in and tells main once');
        note({method:'account/login/completed',params:{loginId:'login-1',success:true}});
        assert.equal(again,1,'and the notification arriving late changes nothing');
        ai.onSignedIn=null;
        await ai.logoutChatGPT(userData);
      }
      assert.equal(await ai.suggestDiscussWith('Discuss with API fallback',fallback,userData),'API fallback','the local API key works again after sign-out');
      assert.equal(calls.length,before+1,'only the signed-out request reaches the API-key endpoint');
    } finally { ai.stop(); agent.appServerRpc=originalRpc; agent.codexBin=originalBin; fs.rmSync(userData,{recursive:true,force:true}); }
    settings.set('openaiApiKey',undefined); settings.reset();
    console.log('ok  discuss suggestion: nothing sent without a key or a title, model and effort are settings, and only a name comes back');
  }
  // A type's own glyph. The Nucleo UI set is built into the app (build/nucleo-ui.json.gz) and stays in main; the
  // choice is app-local, because Tana has nowhere to keep an icon and an SVG does not belong in its CRDT.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const icons = backend.icons; icons.forgetTypeIcons();
    const TYPE = 'tana:type:' + ulid(), OTHER = 'tana:type:' + ulid();
    const all = icons.searchIcons('', 1e9);
    assert.ok(all.length > 3000, 'the whole UI family is built in, not a sample: ' + all.length);
    assert.ok(all.every((i) => /^nc-[\w.-]+$/.test(i.name)), 'every name is prefixed, so none can collide with the app\u2019s own glyphs, and all of them are usable as a CSS class');
    assert.ok(all.every((i) => i.svg.startsWith('<svg') && i.svg.endsWith('</svg>')), 'and each one is a whole 18x18 document rather than the inner markup the library stores');
    assert.equal(all.some((i) => /<script|<foreignObject|\son[a-z]+=/i.test(i.svg)), false, 'with nothing executable in any of them');
    // Four of the 3503 are drawn entirely from filled dots and carry no stroke at all; every other one keeps the
    // library's own `var(--nucleo-stroke-width, 1.5)`, which is what one CSS line matches to the app's weight.
    assert.ok(all.filter((i) => i.svg.includes('--nucleo-stroke-width')).length > all.length - 10, 'the library\u2019s own stroke variable is kept rather than rewritten per glyph');
    // Ranked in main because the set is in main: the name first, then the tags, so "launch" still finds the rocket.
    assert.equal(icons.searchIcons('rocket')[0].label, 'rocket', 'an exact name leads');
    assert.equal(icons.searchIcons('calendar-che')[0].label, 'calendar-check', 'then a name that starts with the query');
    assert.ok(icons.searchIcons('launch').some((i) => i.label === 'rocket'), 'and a tag finds an icon whose name says nothing about it');
    assert.equal(icons.searchIcons('nothinglikethis').length, 0, 'a query that matches nothing answers nothing');
    assert.ok(icons.searchIcons('user').length <= 60, 'a page at a time: the renderer never receives the set');
    // The choice, and what wears it.
    assert.equal(icons.typeIcons().length, 0, 'nothing is chosen to begin with');
    assert.equal(icons.typeIconName(TYPE), null);
    assert.throws(() => icons.setTypeIcon('tana:text:' + ulid(), 'nc-rocket'), /set on a type/, 'an icon belongs to a type, not to one document');
    assert.throws(() => icons.setTypeIcon(TYPE, 'nc-nothinglikethis'), /No icon called/, 'and it has to be one of the glyphs built in');
    const chosen = icons.setTypeIcon(TYPE, 'nc-rocket');
    assert.equal([chosen.uri, chosen.name, chosen.svg.startsWith('<svg')].join('|'), [TYPE, 'nc-rocket', true].join('|'), 'choosing answers with the glyph, so the renderer can draw it without asking again');
    assert.equal(icons.typeIconName(TYPE), 'nc-rocket');
    assert.equal(JSON.stringify(cache.setting('typeIcons')), JSON.stringify({ [TYPE]: 'rocket' }), 'what is stored is a name, never markup');
    // Every surface reads the row's icon, so the name has to arrive on the row itself.
    const typed = backend.graphRow({ id: 'tana:text:' + ulid(), title: 'Tuxis', entityType: TYPE, updateTime: '2026-09-20T10:00:00Z' });
    assert.equal(typed.icon, 'nc-rocket', 'a document of that type is drawn with it');
    assert.equal(backend.graphRow({ id: 'tana:text:' + ulid(), title: 'Other', entityType: OTHER, updateTime: '2026-09-20T10:00:00Z' }).icon, 'type', 'and a type with no glyph keeps the generic one');
    assert.equal(JSON.stringify(backend.toNode(backend.graphRow({ id: 'tana:text:' + ulid(), title: 'Goal', entityType: OTHER, attributes: { [OTHER + '?attribute=a']: { text: 'On track', listItems: ['On track'] }, [OTHER + '?attribute=b']: { text: '' } } })).fields),
      JSON.stringify({ [OTHER + "?attribute=a"]: ["On track"] }), 'a row carries the field values the graph lists with it, and no empty ones');
    assert.equal(backend.toNode({ id: TYPE, title: 'Organization', icon: 'type', tags: [] }).icon, 'nc-rocket', 'the type itself wears it too, which is where it is chosen');
    assert.equal(backend.toNode({ id: 'tana:chat:' + ulid(), title: 'Chat', icon: 'chat', tags: [] }).icon, 'chat', 'no other kind is touched');
    assert.equal(icons.setTypeIcon(TYPE, null), null, 'clearing answers with nothing to draw');
    assert.equal(icons.typeIcons().length, 0, 'and the type goes back to the generic glyph');
    assert.equal(JSON.stringify(cache.setting('typeIcons')), JSON.stringify({ [TYPE]: null }), 'which is kept as a choice, so the boot pick leaves it alone');
    // The boot pick (issue #250): only types with no choice at all are asked about, and only names in the set stick.
    {
      const THIRD = 'tana:type:' + ulid(), asked = [];
      const pick = async (missing, labels) => { asked.push(missing.map((t) => t.uri), labels.includes('rocket')); return { [TYPE]: 'rocket', [OTHER]: 'rocket', [THIRD]: 'nothinglikethis' }; };
      assert.equal(await icons.fillTypeIcons([{ uri: TYPE, title: 'A' }, { uri: OTHER, title: 'B' }, { uri: THIRD, title: 'C' }], pick), 1, 'one type picked for');
      assert.deepEqual(asked, [[OTHER, THIRD], true], 'the type set back to the generic glyph is not asked about, and the whole set is offered');
      assert.deepEqual([icons.typeIconName(TYPE), icons.typeIconName(OTHER), icons.typeIconName(THIRD)], [null, 'nc-rocket', null], 'a name outside the set is dropped');
      assert.equal(await icons.fillTypeIcons([{ uri: OTHER, title: 'B' }], async () => { throw new Error('asked again'); }), 0, 'a picked type is never asked about again');
      icons.setTypeIcon(OTHER, null);
    }
    { // a saved search takes one too, for itself (#521)
      const SEARCH = 'tana:search:' + ulid();
      assert.equal(icons.setTypeIcon(SEARCH, 'nc-rocket').name, 'nc-rocket', 'a saved search takes an icon');
      assert.equal(backend.toNode({ id: SEARCH, title: 'Open deals', icon: 'search', tags: [] }).icon, 'nc-rocket', 'and its row is drawn with it');
      icons.setTypeIcon(SEARCH, null);
      assert.equal(backend.toNode({ id: SEARCH, title: 'Open deals', icon: 'search', tags: [] }).icon, 'search', 'No icon puts the search glyph back');
    }
    { // and a type's field, under its own key, sent with the rest of the glyphs (#606)
      const FIELD = TYPE + '?attribute=ab12cd34';
      assert.equal(icons.setTypeIcon(FIELD, 'nc-rocket').name, 'nc-rocket', 'a field takes an icon');
      assert.ok(icons.typeIcons().some((i) => i.uri === FIELD && i.name === 'nc-rocket'), 'and the renderer is told it with the type glyphs');
      assert.throws(() => icons.setTypeIcon('tana:text:' + ulid() + '?attribute=ab12cd34', 'nc-rocket'), /set on a type/, 'only a type has fields');
      icons.setTypeIcon(FIELD, null);
    }
    { // the boot pick asks about fields too, as "Type › Field", and not about a type already chosen for (#606)
      const typeDoc = new Document(TYPE);
      typeDoc.transact((l) => l.getMap('data').set('template', { attributes: [{ key: 'gcx3bvn5', title: 'Fase' }, { key: 'ab12cd34', title: ' ' }] }));
      let listed = 0;
      backend.testRuntime({ me: { userUri: 'tana:user-profile:' + ulid() }, client: { graph: { listNodes: async (p) => { if ((p.nodeTypes || [])[0] !== 'type') return { nodes: [] }; listed++; return { nodes: [{ id: TYPE, title: 'Project' }] }; } }, sync: { subscribe: async (id) => { if (id !== TYPE) throw new Error('unavailable'); return typeDoc; }, getDocument: () => null } } });
      const pick = backend.ai.pickTypeIcons, status = backend.ai.chatgptStatus, asked = [];
      backend.ai.pickTypeIcons = async (missing) => { asked.push(...missing); return {}; };
      backend.ai.chatgptStatus = async () => ({ signedIn: false }); // the real one starts a Codex app-server
      await backend.autoTypeIcons();
      assert.deepEqual([asked.length, listed], [0, 0], 'without a sign-in or a key nothing is asked, and no type is listed or read');
      const get = backend.settings.get; backend.settings.get = (key) => (key === 'openaiApiKey' ? 'sk-test' : get(key)); // a key, and nothing else about the settings changed
      try { await backend.autoTypeIcons(); } finally { backend.ai.pickTypeIcons = pick; backend.ai.chatgptStatus = status; backend.settings.get = get; }
      assert.deepEqual(JSON.parse(JSON.stringify(asked)), [{ uri: TYPE + '?attribute=gcx3bvn5', title: 'Project › Fase' }], 'a titled field with no icon is asked about under its type\u2019s name; the type, chosen for, and an untitled field are not');
    }
    console.log('ok  type icons: the built-in Nucleo set searched in main, the choice stored as a name, and every row of that type drawn with it');
    // The colour the same way: a hue of our own, or grey, kept beside the glyph in the settings; Tana's own hue on
    // the type shows through when there is no entry, and is never written.
    {
      const HUED = 'tana:type:' + ulid();
      backend.rememberType({ id: HUED, title: 'Hued', appearance: { hue: 259 } }); // what the graph says the type is
      const row = () => backend.graphRow({ id: 'tana:text:' + ulid(), title: 'Tuxis', entityType: HUED, updateTime: '2026-09-20T10:00:00Z' });
      assert.deepEqual([row().hue, row().tags[0].hue], [259, 259], 'with no override a document of the type takes Tana\u2019s hue');
      await backend.setTypeHue(HUED, 120);
      assert.deepEqual([row().hue, row().tags[0].hue], [120, 120], 'our own hue replaces it on every row of the type');
      assert.equal(JSON.stringify(cache.setting('typeHues')), JSON.stringify({ [HUED]: 120 }), 'stored under the type, in the settings that follow you');
      await backend.setTypeHue(HUED, 'grey');
      assert.deepEqual([row().hue, row().tags[0].color], [undefined, 'grey'], 'grey is a colour of ours Tana cannot express: no tint at all');
      await backend.setTypeHue(HUED, null);
      assert.deepEqual([row().hue, JSON.stringify(cache.setting('typeHues'))], [259, '{}'], 'forgetting the override brings Tana\u2019s hue back');
      await assert.rejects(backend.setTypeHue(HUED, 400), /0-360, or grey/);
      console.log('ok  type colours: our own hue or grey per type in the settings, Tana\u2019s hue underneath and never written');
    }
  }
  // The app's own settings document: one document in Tana carrying the choices this app makes about your content,
  // so a machine that has never seen them opens with them. SQLite stays as the mirror the app boots from.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const settings = backend.settings; settings.reset();
    const docs = new Map(), created = [];
    let listed = [];
    const sync = {
      subscribe: async (id, init) => {
        if (!docs.has(id)) { if (!init) return Promise.reject(new Error('unavailable')); const d = new Document(id); d.transact(init); docs.set(id, d); created.push(d); }
        return docs.get(id);
      },
      getDocument: (id) => docs.get(id), unsubscribe: async () => {},
    };
    backend.testRuntime({ me: { userUri: ME }, win: null, client: { sync, graph: { listNodes: async (p) => ({ nodes: p.textQuery ? listed : [] }) } } });
    settings.set('hiddenTitles', ['Lunch']);
    await settings.flush();
    assert.equal(created.length, 1, 'the first synced setting is what makes the document');
    const doc = created[0];
    assert.equal(readNode(doc).title, settings.TITLE, 'it is an ordinary document with a name you can find');
    assert.equal(readNode(doc).type, 'text', 'and an ordinary kind, so Tana shows it like any other note');
    assert.match(require('../sdk/node').contentText(doc), /follow you between machines/, 'and it says what it is, for whoever opens it in Tana');
    const stored = () => doc.loro.getMap(settings.ROOT).toJSON();
    assert.equal(settings.ROOT, 'ext:orbital', 'our keys sit under a root marked as an extension\u2019s, clear of any root Tana may add');
    assert.equal(JSON.parse(stored().hiddenTitles).join(), 'Lunch', 'the value lives in a container of its own, as JSON under its own key');
    assert.equal(cache.setting('hiddenTitles').join(), 'Lunch', 'and in SQLite, which is what the app opens with before the network is there');
    assert.equal(cache.setting(settings.POINTER), doc.id, 'this machine notes which document that is, so it costs one lookup per machine');
    // What cannot follow you stays where it is: a window size belongs to the screen it was sized on.
    settings.set('window', { width: 900 });
    settings.setPref('home', 'tana:search:' + ulid());
    await settings.flush();
    assert.equal(Object.hasOwn(stored(), 'window'), false, 'a machine-local setting never reaches the document');
    settings.set('codexTask', { 'tana:text:x': { host: 'local', threadId: '00000000-0000-4000-8000-000000000000' } });
    await settings.flush();
    assert.ok(Object.hasOwn(stored(), 'codexTask'), 'an agent task does: the thread id is global, and the record names the machine it runs on');
    assert.ok(Object.hasOwn(stored(), 'pref:home'), 'a renderer preference does, under the prefix the renderer reads back');
    assert.equal(Object.keys(settings.prefs()).join(), 'home', 'which is what the renderer receives, with the prefix off');
    // A second machine: its own empty database, the same document, found by name.
    const first = { ...settings.prefs() };
    cache.open(':memory:');
    settings.reset();
    assert.equal(settings.get('hiddenTitles'), undefined, 'the new machine knows nothing yet');
    listed = [{ id: doc.id, title: settings.TITLE, createTime: '2026-09-20T10:00:00Z' }];
    await settings.hydrate();
    assert.equal(settings.get('hiddenTitles').join(), 'Lunch', 'and finds the document by name, without being told which it is');
    assert.equal(JSON.stringify(settings.prefs()), JSON.stringify(first), 'so its preferences are the ones you set on the other machine');
    assert.equal(cache.setting(settings.POINTER), doc.id, 'and it notes the document for next time');
    assert.equal(created.length, 1, 'rather than making a second one');
    // A setting only this machine has is pushed up, which is what makes the first run a migration and needs no step
    // of its own; a key the document has wins over what this machine remembered.
    settings.set('typeIcons', { 'tana:type:local': 'rocket' });
    await settings.flush();
    assert.equal(JSON.parse(stored().typeIcons)['tana:type:local'], 'rocket');
    doc.transact((loro) => loro.getMap(settings.ROOT).set('hiddenTitles', JSON.stringify(['Standup'])));
    await settings.hydrate();
    assert.equal(settings.get('hiddenTitles').join(), 'Standup', 'the document decides what a key means');
    assert.equal(cache.setting('hiddenTitles').join(), 'Standup', 'and the mirror follows it');
    // A document an older build wrote keeps its keys under the old "settings" root: the next hydrate moves them.
    doc.transact((loro) => { const old = loro.getMap('settings'); old.set('hiddenTitles', JSON.stringify(['Old'])); old.set('aiEffort', JSON.stringify('low')); });
    await settings.hydrate();
    assert.equal(settings.get('aiEffort'), 'low', 'a key only the old root had moves across');
    assert.equal(settings.get('hiddenTitles').join(), 'Standup', 'the new root wins where both have the key');
    assert.deepEqual(doc.loro.getMap('settings').toJSON(), {}, 'and the old root is left empty');
    settings.set('aiEffort', undefined); await settings.flush();
    // A sensitive mark is one of these settings, and the list the renderer loads at startup has to read the same
    // place the mark is written: it once read db's legacy table, so every mark was gone after a restart.
    const marked = 'tana:text:' + ulid();
    assert.equal(await backend.handlers.get('sensitive:set')(null, marked, true), true);
    assert.equal((await backend.handlers.get('sensitive:list')(null)).join(), marked, 'the mark is read back from where it was written');
    assert.equal(await backend.handlers.get('sensitive:set')(null, marked, false), false);
    assert.equal((await backend.handlers.get('sensitive:list')(null)).join(), '', 'and unmarking takes it out again');
    // A setting one page writes reaches the other page of a split and every other window at once, since the write
    // coming back from Tana is nothing new to main; the page that wrote it hears nothing (issue #228).
    const heard = [], pane = (name) => ({ frame: {}, isDestroyed: () => false, send: (channel, synced) => heard.push([name, channel, typeof synced === 'string' ? synced : synced && synced.theme]) });
    const left = pane('left'), right = pane('right'), other = pane('other');
    backend.S.windows.add({ isDestroyed: () => false, panes: [left, right] }).add({ isDestroyed: () => false, panes: [other] });
    await backend.handlers.get('prefs:set')({ senderFrame: left.frame }, 'theme', 'dark');
    assert.deepEqual(heard, [['right', 'settings:changed', 'dark'], ['other', 'settings:changed', 'dark']]);
    heard.length = 0;
    await backend.handlers.get('sensitive:set')({ senderFrame: right.frame }, marked, false);
    assert.deepEqual(heard.map(([name]) => name), ['left', 'other'], 'a sensitive mark tells the other pages too');
    // So does every other setting a page keeps a copy of: a view's filter (a page left with the old one drew stale
    // pills and wrote it back with its next one), a watch choice, whose document the others read again for its bell,
    // and an agent mark, which draws the badge and the Agent section.
    const others = () => heard.splice(0).filter(([, channel]) => channel !== 'sync:status'); // the failed state read reports its status
    others(); // what the sensitive mark sent
    await backend.handlers.get('view:setFilter')({ senderFrame: left.frame }, 'library', { states: ['closed'] });
    assert.deepEqual(others().map(([name, channel]) => name + ' ' + channel), ['right settings:changed', 'other settings:changed'], 'a view filter tells the other pages');
    const watchedDoc = 'tana:text:' + ulid();
    await backend.handlers.get('notify:set')({ senderFrame: right.frame }, watchedDoc, true).catch(() => {}); // the state read after the write needs a document this runtime lacks
    assert.deepEqual(others().map(([name, channel, value]) => [name, channel === 'outline:changed' ? value : channel]), [['left', 'settings:changed'], ['left', watchedDoc], ['other', 'settings:changed'], ['other', watchedDoc]],
      'a watch choice tells the other pages, and has them read that document’s metadata again');
    await backend.handlers.get('codex:link')({ senderFrame: left.frame }, watchedDoc, '00000000-0000-4000-8000-000000000000');
    assert.deepEqual(others().map(([name, channel]) => name + ' ' + channel), ['right settings:changed', 'right outline:changed', 'other settings:changed', 'other outline:changed'],
      'an agent mark tells the other pages too, with the node, since a relink moves only its task');
    // A watch choice another machine made reaches every page as that document's metadata change, as a local one does.
    const remoteWatch = 'tana:text:' + ulid(), settingsDoc = docs.get(settings.settingsDocId());
    await settings.flush(); // this machine's writes are in the document before another machine's land on top
    settingsDoc.transact((loro) => loro.getMap(settings.ROOT).set('notify', JSON.stringify({ ...settings.get('notify'), [remoteWatch]: true })));
    await settings.applyRemote(settingsDoc.id);
    assert.deepEqual(others().filter(([, channel]) => channel === 'outline:changed').map(([name, , value]) => [name, value]), [['left', remoteWatch], ['right', remoteWatch], ['other', remoteWatch]],
      'a watch choice from another machine has every page read that document again');
    // So does an agent task another machine linked or relinked: the mark and the host can stay the same while the task moves.
    settingsDoc.transact((loro) => loro.getMap(settings.ROOT).set('codexTask', JSON.stringify({ ...settings.get('codexTask'), [watchedDoc]: { host: 'local', threadId: '00000000-0000-4000-8000-000000000001' } })));
    await settings.applyRemote(settingsDoc.id);
    assert.deepEqual(others().filter(([, channel]) => channel === 'outline:changed').map(([name, , value]) => [name, value]), [['left', watchedDoc], ['right', watchedDoc], ['other', watchedDoc]],
      'an agent task relinked on another machine has every page read that node again');
    for (const key of ['viewFilter:library', 'notify', 'codex', 'codexPrompt', 'codexTask']) settings.set(key, undefined);
    backend.S.windows.clear(); settings.setPref('theme', undefined); await settings.flush();
    // A window is one shell (shell.html) laying its pages out with Trellis; a page is an iframe of it, registered by its
    // frame when its preload asks window:getSide, by the id its url names ('' the first, then '2', '3', ...). The shell
    // reports its layout (the document and the page ids in it); main saves it and forgets pages gone. Commands go to the shell.
    const own = (v) => JSON.parse(JSON.stringify(v ?? null)); // main runs in its own vm context: its objects, compared as data
    const toShell = [], told = [];
    const shellWc = { isDestroyed: () => false, focus() {}, send: (channel, cmd, arg) => toShell.push([cmd, own(arg)]) };
    const shown = { isDestroyed: () => false, shell: { webContents: shellWc }, panes: [], pages: ['', '2'], doc: null, saveSoon() {}, close() { this.closed = true; } };
    backend.S.windows.add(shown);
    const frame = (name, side) => ({ processId: 1, frameToken: name, url: 'file:///orbital/index.html?side=' + side, parent: {}, detached: false, isDestroyed: () => false, send: (channel, ...args) => told.push([name, channel, ...own(args)]) });
    const ask = (channel, f, ...args) => { const e = { sender: shellWc, senderFrame: f }; const out = backend.handlers.get(channel)(e, ...args); return own(e.returnValue !== undefined ? e.returnValue : out); };
    const leftPage = frame('left', ''), rightPage = frame('right', '2'), thirdPage = frame('third', '3');
    assert.deepEqual(ask('window:getSide', rightPage), { side: '2' }, 'a restored page that loads first keeps its own id');
    assert.deepEqual(ask('window:getSide', leftPage), { side: '' });
    assert.deepEqual(ask('window:getSide', { ...leftPage, frameToken: 'shell', parent: null }), { side: '' }, 'a main frame (the shell, an overlay) is no page');
    assert.equal(shown.panes.length, 2);
    assert.equal(ask('window:getSide', frame('twin', '2')).side, '3', 'an id already taken gets the smallest free one');
    shown.panes.pop();
    // ⌘N: a new page to the right of the one that asked, with an id main gives and the keys. It starts where the asking
    // page is: main hands it that view and place with its id, for its preload to store before the page reads them.
    assert.equal(ask('window:split', rightPage, 'right', { view: 'library', place: '{}', other: 'x' }), '3');
    assert.deepEqual(toShell.splice(0), [['open', { id: '3', where: 'right', from: '2', focus: true }]]);
    assert.equal(ask('window:split', leftPage, 'tab'), '4', 'a New tab is the next free id, even before the first has loaded');
    assert.deepEqual(toShell.splice(0), [['open', { id: '4', where: 'tab', from: '', focus: true }]]);
    assert.deepEqual(ask('window:getSide', thirdPage), { side: '3', start: { view: 'library', place: '{}' } }, 'a new page gets its start with its id');
    assert.deepEqual(ask('window:getSide', thirdPage), { side: '3' }, 'once');
    assert.notEqual(backend.S.pane && backend.S.pane.frame, thirdPage, 'only the page asked for last takes the keys');
    const fourth = frame('fourth', '4');
    assert.deepEqual(ask('window:getSide', fourth), { side: '4', start: { view: null, place: null } }, 'a page opened with no start keeps nothing of a closed page with its id');
    assert.equal(backend.S.pane && backend.S.pane.frame, fourth, 'the page \u2325\u2318N opened is the one \u2318W and a notification click aim at');
    assert.equal(ask('window:split', leftPage, 'links', { view: 'library', place: '{}' }), '5');
    assert.deepEqual(toShell.splice(0), [['open', { id: '5', where: 'links', from: '', focus: false }]], 'Show graph: the Graph pane opens beside the page that asked, which keeps the keys (issue #462)');
    const linksFrame = { ...frame('linksPane', '5'), url: 'file:///orbital/index.html?side=5&links=1' };
    ask('window:getSide', linksFrame);
    const activeBefore = backend.S.activeView, otherView = activeBefore === 'inbox' ? 'library' : 'inbox';
    const linksRows = own(await backend.handlers.get('view:list')({ sender: shellWc, senderFrame: linksFrame }, otherView));
    assert.deepEqual([linksRows, backend.S.windowViews.has('1:linksPane'), backend.S.activeView], [{ nodes: [], truncated: false }, false, activeBefore],
      'the Graph pane shows no list: nothing is queried, it is no open view and the refresh keeps its view (#463 review)');
    const layoutDoc = { schema: 1, root: { kind: 'panel', views: ['page', 'page2', 'page3'] }, views: {} };
    ask('shell:layout', null, { doc: layoutDoc, pages: ['', '3', '2'] });
    assert.deepEqual([shown.panes.map((p) => p.side).sort(), shown.doc], [['', '2', '3'], layoutDoc], 'a page not in the report is forgotten, and the layout saved');
    const pageFor = (f) => shown.panes.find((p) => p.frame === f);
    backend.closeFront(shown, pageFor(thirdPage));
    assert.deepEqual([toShell.splice(0), shown.pages], [[['close', '3'], ['focus', '2']], ['', '2']], '\u2318W: a page closes in the shell and the next in the layout\u2019s order takes the keys');
    { // #462: the Graph pane follows a page and cannot stand alone, so \u2318W on the last page beside it closes the window
      const sent = [], linksWin = { closed: false, close() { this.closed = true; }, shell: { webContents: { isDestroyed: () => false, send: (...args) => sent.push(args.slice(1)) } },
        pages: ['', '5'], panes: [{ side: '', links: false, focus() {} }, { side: '5', links: true, focus() {} }] };
      for (const p of linksWin.panes) p.win = linksWin;
      backend.closeFront(linksWin, linksWin.panes[1]);
      assert.deepEqual([linksWin.closed, sent], [false, [['close', '5']]], '\u2318W in the Graph pane closes only it');
      backend.closeFront(linksWin, linksWin.panes[0]);
      assert.equal(linksWin.closed, true, 'and on the last page beside it, the window');
    }
    ask('shell:layout', null, { doc: layoutDoc, pages: ['', '2'] });
    told.splice(0);
    // Cmd+K Saved views: the layout this window has, and one to put it back to, saved and reloaded into. 'workView' is
    // the Work View's own, '' beside '2'; a layout without a page is refused and changes nothing.
    const reloads = () => toShell.splice(0).filter(([cmd]) => cmd === 'reload').length; shown.saveBounds = () => {};
    assert.deepEqual(ask('window:layout', leftPage), layoutDoc);
    assert.equal(ask('window:setLayout', leftPage, { schema: 1, views: {} }), false, 'a layout with no page is refused');
    assert.deepEqual([reloads(), shown.doc], [0, layoutDoc]);
    assert.equal(ask('window:setLayout', leftPage, 'workView'), true);
    assert.deepEqual([reloads(), own(shown.pages), Object.keys(shown.doc.views), own(shown.doc.root.weights)], [1, ['', '2'], ['page', 'page2'], [0.6, 0.4]], 'the Work View: 60/40, saved and reloaded into (the shell flushes every page first)');
    ask('shell:layout', null, { doc: layoutDoc, pages: [''] });
    assert.deepEqual(own(shown.pages), ['', '2'], 'what the shell reports before its reload is the old layout, and is not saved');
    ask('shell:state', null);
    // A saved view's page id open in another window: the view's page takes a free id, with its keys and its start
    const elsewhere = { isDestroyed: () => false, panes: [], pages: ['2'] };
    backend.S.windows.add(elsewhere);
    assert.equal(ask('window:setLayout', leftPage, 'workView', { place: 'timeline', 'place:2': 'mine', view: 5 }), true);
    const moved = own(shown.doc);
    assert.deepEqual([own(shown.pages), Object.keys(moved.views), moved.views.page3.params.side, moved.root.children[1].views, moved.root.children[1].selected], [['', '3'], ['page', 'page3'], '3', ['page3'], 'page3'],
      'a page id another window has open is not reused');
    assert.deepEqual([ask('window:getSide', leftPage), ask('window:getSide', frame('moved', '3'))], [{ side: '', start: { place: 'timeline' } }, { side: '3', start: { place: 'mine', as: '2' } }], 'each page starts on its own keys, a moved one knowing its id in the view');
    ask('shell:state', null); toShell.splice(0);
    backend.S.windows.delete(elsewhere); shown.panes = shown.panes.filter((p) => p.frame.frameToken !== 'moved');
    delete shown.saveBounds;
    ask('shell:layout', null, { doc: layoutDoc, pages: [''] });
    shown.close = () => { shown.closed = true; };
    backend.closeFront(shown, pageFor(leftPage));
    assert.deepEqual([toShell.splice(0), shown.closed], [[], true], '\u2318W on the last page closes the window rather than the page');
    delete shown.close; delete shown.closed;
    // The saved layout: a first launch opens the Work View, and a v1 split (before the workspace) becomes '' beside '2'.
    const { savedDoc } = backend, row = (d) => d && [d.root.kind, d.root.weights, Object.keys(d.views)];
    assert.deepEqual(row(own(savedDoc(null))), ['split', [0.6, 0.4], ['page', 'page2']], 'first launch: the Work View, 60/40');
    assert.deepEqual(row(own(savedDoc({ width: 900, split: true, splitAt: 0.3 }))), ['split', [0.3, 0.7], ['page', 'page2']], 'a saved split keeps its divider');
    assert.equal(savedDoc({ width: 900, split: false }), null, 'a window saved alone opens alone');
    assert.equal(savedDoc({ width: 900, doc: layoutDoc }), layoutDoc, 'a saved layout comes back as it was');
    // Signed out, every page is the same login button: the shell shows one, and the saved layout waits for the login.
    const auth = { ...backend.S.status };
    shown.doc = layoutDoc;
    Object.assign(backend.S.status, { authChecking: false, authenticated: false });
    const state = ask('shell:state', null);
    assert.deepEqual([state.doc, state.signedOut, own(shown.pages)], [layoutDoc, true, ['']], 'signed out: the shell is told so, with the layout to keep aside');
    ask('shell:layout', null, { doc: { schema: 1, views: {} }, pages: [''] });
    assert.equal(shown.doc, layoutDoc, 'and the layout stays saved for after the login');
    ask('window:split', leftPage);
    assert.deepEqual(toShell.splice(0), [], 'no new page while signed out');
    Object.assign(backend.S.status, auth);
    backend.S.windows.delete(shown);
    // A node's link opens it in Tana on the route Tana itself picks for its kind (issue #88).
    backend.testRuntime({ me: { orgDocUri: 'tana:org:01ks7rqsrqjn7vwyjhx75r6jg0' } });
    const link = (kind) => backend.handlers.get('doc:link')(null, 'tana:' + kind + ':01m2nrv0v6qj2brghq04t8wv87');
    assert.deepEqual(['text', 'type', 'user-profile', 'event', 'space', 'chat'].map((k) => link(k).split('/')[5]), ['l', 't', 'u', 'e', 's', 'l'], 'a type opens its type page, not the document route');
    assert.equal(link('type'), 'https://home.tana.inc/o/01ks7rqsrqjn7vwyjhx75r6jg0/t/tana%3Atype%3A01m2nrv0v6qj2brghq04t8wv87');
    // A canvas opens in a window of its own, on the page Tana opens for it and in the Tana session (issue #611).
    const canvas = 'tana:canvas:01m2nrv0v6qj2brghq04t8wv87', openCanvas = backend.handlers.get('canvas:open'), made = backend.electron.windows;
    await openCanvas(null, canvas);
    const [cw] = made;
    assert.equal(cw.url, link('canvas'), 'on the page Tana itself opens for it');
    assert.equal(cw.options.webPreferences.partition, 'persist:tana', 'signed in with the session Orbital already has');
    assert.match(cw.options.webPreferences.preload, /canvas-preload\.js$/, 'with a preload of its own, never the one that hands a page window.api');
    assert.ok(!/Electron/.test(cw.userAgent), 'not taken for Tana\'s desktop app');
    cw.webContents.handlers['dom-ready']();
    assert.match(cw.webContents.css[0], /body:has\(\.tl-container\) \*/, 'with everything but the board hidden, once the board is there');
    assert.equal(cw.openHandler({ url: 'https://example.com/' }).action, 'deny', 'no Tana pop-up window of its own');
    assert.equal(backend.opened.at(-1), 'https://example.com/', 'a link out of it goes to the browser');
    await openCanvas(null, canvas);
    assert.deepEqual([made.length, cw.focused], [1, 1], 'opening it again brings that window forward');
    cw.webContents.handlers['window:closed']();
    await openCanvas(null, canvas);
    assert.equal(made.length, 2, 'and a closed one opens anew');
    await assert.rejects(async () => openCanvas(null, 'tana:text:01m2nrv0v6qj2brghq04t8wv87'), /Not a canvas/, 'nothing but a canvas opens there');
    backend.testRuntime({ me: { orgDocUri: 'tana:org:01ks7rqsrqjn7vwyjhx75r6jg0' }, session: { logout: async () => {} } });
    await backend.handlers.get('sync:logout')();
    assert.ok(made.at(-1).isDestroyed(), 'signing out closes every open canvas window, so no board outlives its session');
    await openCanvas(null, canvas);
    assert.equal(made.length, 3, 'and the canvas opens anew after the next sign-in');
    // It is app plumbing rather than a note, so no list or search offers it.
    backend.testRuntime({ me: { userUri: ME }, win: null, client: { sync, graph: { listNodes: async (p) => (p.nodeIds ? { nodes: [] } : { nodes: [{ id: doc.id, title: settings.TITLE, updateTime: '2026-09-20T10:00:00Z' }, { id: 'tana:text:' + ulid(), title: 'A real note', updateTime: '2026-09-20T10:00:00Z' }] }) } } });
    const rows = await backend.handlers.get('view:list')(null, 'library', { types: ['docs'], states: null, assignee: 'anyone' });
    assert.deepEqual(rows.nodes.map((n) => n.title), ['A real note'], 'the settings document is kept out of every list, like a hidden title');
    console.log('ok  settings document: created or found by name, JSON per key, machine-local settings left behind, and a new machine opens with your choices');
  }
  // My Tasks, the Work View's right half, is one saved search that the synced settings remember by id. A rename, a hidden
  // title, a colleague's search of the same name or a second machine starting at the same moment must not make a
  // second one or pick the wrong one; only a deletion makes a fresh one.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const settings = backend.settings; settings.reset();
    const docs = new Map(), searches = [];
    let settingsListed = [];
    let clock = Date.parse('2026-09-26T08:00:00Z');
    const sync = {
      subscribe: async (id, init) => {
        if (!docs.has(id)) {
          if (!init) throw new Error('unavailable');
          const d = new Document(id); d.transact(init); docs.set(id, d);
          if (id.startsWith('tana:search:')) searches.push({ id, title: readNode(d).title, createdBy: ME, createTime: new Date(clock += 1000).toISOString() });
        }
        return docs.get(id);
      },
      getDocument: (id) => docs.get(id), unsubscribe: async () => {},
    };
    const listNodes = async (p) => {
      if (p.nodeIds) return { nodes: searches.filter((n) => p.nodeIds.includes(n.id)) };
      if (p.textQuery === settings.TITLE) return { nodes: settingsListed };
      if (p.nodeTypes && p.nodeTypes.join() === 'search') return { nodes: [...searches].reverse().filter((n) => !p.createdBy || p.createdBy.includes(n.createdBy)) }; // newest first, as the graph sorts by default
      return { nodes: [] };
    };
    const launch = () => { backend.testRuntime({ me: { userUri: ME }, win: null, client: { sync, graph: { listNodes } } }); return backend.handlers.get('search:myTasks')(null, false); };
    const first = await launch();
    assert.equal(searches.length, 1, 'a first launch makes My Tasks');
    await settings.flush();
    assert.equal((await launch()).id, first.id, 'and the next launch finds it');
    searches[0].title = 'Mine';
    assert.equal((await launch()).id, first.id, 'renamed in Tana, it is still the Work View\u2019s search');
    assert.equal(searches.length, 1, 'and no second My Tasks is made beside it');
    await settings.flush();
    settingsListed = [{ id: settings.settingsDocId(), title: settings.TITLE, createTime: '2026-09-26T07:00:00Z' }];
    cache.open(':memory:'); settings.reset(); // a new machine, asking the moment sync connects, before start() has read the settings document
    assert.equal((await launch()).id, first.id, 'a new machine reads which one it is from the settings document before it looks by title');
    assert.equal(searches.length, 1, 'rather than making another beside the renamed one');
    searches[0].title = 'My Tasks';
    settings.set('myTasks', undefined); // a machine that has not heard which one it is yet
    settings.set('hiddenTitles', ['My Tasks']);
    assert.equal((await launch()).id, first.id, 'a hidden title keeps it out of the lists, not out of the Work View');
    assert.equal(searches.length, 1, 'so hiding it makes no copy on every launch');
    settings.set('hiddenTitles', []);
    settings.set('myTasks', undefined);
    searches.push({ id: 'tana:search:' + ulid(), title: 'My Tasks', createdBy: ME, createTime: new Date(clock += 1000).toISOString() });
    assert.equal((await launch()).id, first.id, 'two made at once by two machines: both settle on the oldest');
    settings.set('myTasks', undefined);
    searches.splice(1); searches.unshift({ id: 'tana:search:' + ulid(), title: 'My Tasks', createdBy: 'tana:user-profile:01examplej0000000000000000', createTime: '2026-09-01T00:00:00Z' });
    assert.equal((await launch()).id, first.id, 'a colleague\u2019s My Tasks is theirs, not the Work View\u2019s');
    searches.shift();
    searches[0].deletedAt = Date.now();
    const fresh = await launch();
    assert.notEqual(fresh.id, first.id, 'deleted in Tana: the next Work View makes a fresh one');
    assert.equal(settings.get('myTasks'), fresh.id, 'and remembers that one');
    settings.set('myTasks', undefined);
    await settings.flush(); // before the next block's database: a write still on its way would land its pointer there
    console.log('ok  My Tasks is remembered by id: a rename, a hidden title, a colleague\u2019s or a second machine\u2019s copy never makes or picks another');
  }
  // The Help tour's first start is opened by main (help:claim): once, over the first page that asks, only after this
  // session read the settings document, and marked seen only when it really opened (renderer/overlays.js).
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const settings = backend.settings; settings.reset();
    const claim = backend.handlers.get('help:claim');
    const pageOf = (overlay = null) => {
      const wc = { destroyed: false, frame: {}, isDestroyed() { return this.destroyed; }, focus() {}, send() {} }; // a page handle (main.js addPage)
      const win = wc.win = { panes: [wc], overlay, isDestroyed: () => false, getContentBounds: () => ({ width: 800, height: 600 }), contentView: { addChildView() {}, removeChildView() {} } };
      backend.S.windows.add(win);
      return { wc, win, ask: () => claim({ senderFrame: wc.frame }, 'light') };
    };
    const early = pageOf();
    assert.equal(await early.ask(), false, 'no settings document read this session (signed out, or the read failed): no tour');
    assert.deepEqual([settings.prefs().helpSeen, early.win.overlay], [undefined, null], 'and nothing shown or spent: this machine\u2019s own copy is not an answer');
    const docs = new Map();
    const sync = { subscribe: async (id, init) => { if (!docs.has(id)) { if (!init) throw new Error('unavailable'); const d = new Document(id); d.transact(init); docs.set(id, d); } return docs.get(id); }, getDocument: (id) => docs.get(id), unsubscribe: async () => {} };
    backend.testRuntime({ me: { userUri: ME }, win: null, client: { sync, graph: { listNodes: async () => ({ nodes: [] }) } } });
    await settings.hydrate();
    const gone = pageOf();
    const asking = gone.ask(); gone.wc.destroyed = true; backend.S.windows.delete(gone.win);
    assert.equal(await asking, false, 'a page that closed while main waited for the settings cannot show it');
    assert.equal(settings.prefs().helpSeen, undefined, 'so it is not spent on it');
    assert.equal(await claim(null, 'light'), false, 'nor on a call with no page behind it');
    early.win.overlay = null; const two = pageOf();
    assert.deepEqual(await Promise.all([early.ask(), two.ask()]), [true, false], 'two pages asking at once: one gets the tour');
    assert.ok(early.win.overlay && !two.win.overlay, 'opened by main over that window, in the same step as the claim');
    assert.equal(settings.prefs().helpSeen, true, 'and marked as the synced helpSeen preference');
    assert.equal(await two.ask(), false, 'and nobody after them');
    for (const p of [early, two]) backend.S.windows.delete(p.win);
    // Quick Add Task open from the right half of a split while the left half asks: the close is told only to the right
    // half, so main keeps the ask and opens the tour itself once there is room.
    settings.setPref('helpSeen', undefined);
    const told = [], right = { isDestroyed: () => false, focus() {}, send: (channel) => told.push(channel) };
    const task = { webContents: { isDestroyed: () => false, close() {} }, opener: right };
    const covered = pageOf(task);
    assert.equal(await covered.ask(), false, 'a window with Quick Add Task open cannot show it yet');
    assert.equal(settings.prefs().helpSeen, undefined, 'so nothing is marked');
    const survivor = { isDestroyed: () => false, focus() {}, send() {}, win: covered.win };
    covered.win.panes = [survivor]; // the half that asked closed under Quick Add Task (⌘W): the other is the main half now
    const heard = [];
    right.send = (channel, result) => { told.push(channel); heard.push(result); };
    await backend.handlers.get('overlay:close')({ sender: task.webContents }, { palette: true, note: 'Task created' }); // made a task, closed with ⌘K
    assert.deepEqual(told, ['overlay:closed'], 'Quick Add Task\u2019s half hears it closed');
    assert.equal(heard[0].palette, false, 'without the palette its ⌘K asked for: the tour opens instead, and nothing is left open under it');
    assert.equal(heard[0].note, undefined, 'and without its toast yet, which would be gone under the tour before the tour is');
    assert.ok(covered.win.overlay && covered.win.overlay !== task, 'and main opens the tour over the window at once');
    assert.equal(covered.win.overlay.opener, survivor, 'for the page that is the main half now, even though the one that asked has gone');
    assert.equal(settings.prefs().helpSeen, true, 'marked in that same step');
    await backend.handlers.get('overlay:close')({ sender: covered.win.overlay.webContents }, {});
    assert.equal(heard.at(-1).note, 'Task created', 'the toast comes when the tour closes, to the half that made the task');
    backend.S.windows.delete(covered.win);
    await settings.flush(); // before the next block's database: a write still on its way would land its pointer there
    console.log('ok  help:claim: the first-start tour goes to one page, once');
  }
  // Two machines that each made a settings document before either could find the other's, and a document deleted in
  // Tana: the next launch settles on the oldest one standing, merges this machine's choices into it and tells the page.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const settings = backend.settings; settings.reset();
    const docs = new Map(), sent = [], live = new Set(), released = [], tried = [];
    let listed = [];
    const sync = {
      subscribe: async (id, init) => { tried.push(id); if (!docs.has(id)) { if (!init) throw new Error('unavailable'); const d = new Document(id); d.transact(init); docs.set(id, d); } live.add(id); return docs.get(id); },
      getDocument: (id) => (live.has(id) ? docs.get(id) : undefined), unsubscribe: async (id) => { live.delete(id); released.push(id); },
    };
    const win = { isDestroyed: () => false, webContents: { send: (channel, value) => sent.push([channel, value]) } };
    let asked = null;
    const connect = () => { settings.reset(); live.clear(); backend.testRuntime({ me: { userUri: ME, orgDocUri: 'tana:org:01examplek0000000000000000' }, win, client: { sync, graph: { listNodes: async (p) => { if (p.textQuery === settings.TITLE) asked = p; return { nodes: p.textQuery === settings.TITLE ? listed : [] }; } } } }); }; // a launch: a new client, nothing subscribed yet
    const theirs = new Document('tana:text:' + ulid()); // the other machine's, made a second earlier
    const third = 'tana:text:' + ulid(); // one a third machine already gave up to it
    theirs.transact((l) => { initDocument(l, settings.TITLE, ME); l.getMap(settings.ROOT).set('pref:theme', JSON.stringify('dark')); l.getMap('ext:orbital:old').set(third, true); });
    docs.set(theirs.id, theirs);
    const note = new Document('tana:text:' + ulid()); // a note of yours that happens to be called Orbital, older than both
    note.transact((l) => initDocument(l, settings.TITLE, ME));
    docs.set(note.id, note);
    const shared = new Document('tana:text:' + ulid()); // one called Orbital, marked, but where others can read it: somebody with edit rights made it look like ours
    shared.transact((l) => { initDocument(l, settings.TITLE, ME); l.getMap('ext:orbital:doc').set('app', 'orbital'); l.getMap('data').set('restricted', false); });
    docs.set(shared.id, shared);
    const linked = new Document('tana:text:' + ulid()); // private to you, marked, but readable by anyone with its public link, which only the graph node says
    linked.transact((l) => { initDocument(l, settings.TITLE, ME); l.getMap('ext:orbital:doc').set('app', 'orbital'); });
    docs.set(linked.id, linked);
    connect();
    settings.setPref('home', 'library');
    await settings.hydrate(); await settings.flush();
    const mine = settings.settingsDocId();
    assert.ok(mine && mine !== theirs.id, 'the index did not list theirs yet, so this machine made its own');
    listed = [{ id: mine, title: settings.TITLE, createTime: '2026-09-26T09:00:01Z' }, { id: theirs.id, title: settings.TITLE, createTime: '2026-09-26T09:00:00Z' },
      { id: note.id, title: settings.TITLE, createTime: '2026-01-01T00:00:00Z' }, { id: shared.id, title: settings.TITLE, createTime: '2025-12-01T00:00:00Z' },
      { id: linked.id, title: settings.TITLE, createTime: '2025-11-01T00:00:00Z', linkSharing: { mode: 'view' } }];
    // while this machine was away, another one that also uses this machine's document wrote to it
    docs.get(mine).transact((l) => { const m = l.getMap(settings.ROOT); m.set('hiddenTitles', JSON.stringify(['Lunch'])); m.set('pref:theme', JSON.stringify('light')); });
    connect(); sent.length = 0;
    await settings.hydrate(); await settings.flush();
    assert.equal(settings.settingsDocId(), theirs.id, 'the next launch settles on the oldest, pointer or not, so the two machines stop drifting apart');
    assert.deepEqual([asked.limit, asked.sortOptions[0].field, asked.sortOptions[0].direction], [1000, 'SORT_FIELD_CREATE_TIME', 'SORT_DIRECTION_ASCENDING'],
      'asked of the graph oldest first and as many as a list takes: the title is a full-text query, so other notes that mention it share the answer');
    assert.equal(settings.get('pref:theme'), 'dark', 'it takes the choices made on the other machine');
    assert.deepEqual(JSON.parse(JSON.stringify(settings.get('hiddenTitles'))), ['Lunch'], 'and keeps what was written to the one it gave up while it was away, where the winner has nothing of its own');
    assert.equal(JSON.parse(theirs.loro.getMap(settings.ROOT).get('pref:home')), 'library', 'and pushes up the ones only this machine had');
    assert.ok(sent.some(([channel, prefs]) => channel === 'settings:changed' && prefs.theme === 'dark'), 'and the open page is told, rather than keeping the defaults until the next launch');
    assert.deepEqual(note.loro.getMap(settings.ROOT).toJSON(), {}, 'an older note that only shares the title is never taken over');
    assert.deepEqual(shared.loro.getMap(settings.ROOT).toJSON(), {}, 'nor one others can read, mark or not: no synced key is ever written where somebody else sees it');
    assert.deepEqual(linked.loro.getMap(settings.ROOT).toJSON(), {}, 'nor one with a public link, private as its audience is');
    assert.deepEqual([shared.id, note.id].filter((id) => released.includes(id) && !live.has(id)), [shared.id, note.id], 'and each one looked at and turned down is let go again');
    assert.ok(!tried.includes(linked.id), 'one the graph says has a public link is turned down without even being opened');
    assert.ok(!tried.some((id) => id.startsWith('tana:org:')), 'and an open one is turned down on its own flag, without loading the org or an owner chain to ask about it');
    assert.ok(released.includes(mine) && !live.has(mine) && live.has(theirs.id), 'as is the one this machine gave up, while the one it took stays live');
    assert.deepEqual(Object.keys(theirs.loro.getMap('ext:orbital:old').toJSON()).sort(), [third, mine].sort(), 'the document this machine gave up is noted in the one it took, one key each beside the one another machine gave up, so concurrent notes merge');
    assert.deepEqual(JSON.parse(JSON.stringify(settings.appDocIds())).sort(), [theirs.id, third, mine].sort(), 'and every one of them is an app document the lists leave out');
    const shown = await backend.S.client.graph.listNodes({ nodeTypes: ['text'], textQuery: settings.TITLE });
    assert.deepEqual(JSON.parse(JSON.stringify(shown.nodes.map((n) => n.id))), [note.id, shared.id, linked.id], 'so neither settings document is listed anywhere, while the notes that are only called Orbital are');
    theirs.transact((l) => l.getMap('data').set('deletedAt', 123));
    connect();
    await settings.hydrate(); await settings.flush();
    const next = settings.settingsDocId();
    assert.ok(next && next !== theirs.id && next !== mine, 'deleted in Tana: a document in the trash is not written to, nor a copy it took over (it holds what was true before): a new one is made');
    assert.ok(!live.has(theirs.id), 'and the deleted one is not kept live');
    assert.equal(JSON.parse(docs.get(next).loro.getMap(settings.ROOT).get('pref:theme')), 'dark', 'written from what this machine remembers');
    assert.equal(docs.get(mine).loro.getMap(settings.ROOT).get('pref:theme'), JSON.stringify('light'), 'the copy given up earlier is left as it was');
    assert.deepEqual(Object.keys(docs.get(next).loro.getMap('ext:orbital:old').toJSON()).sort(), [third, mine].sort(), 'and what the deleted one had taken over goes along, so those copies stay out of the lists');
    // A machine with nothing to say yet makes a document with no key in it; another machine must still take it for ours.
    cache.open(':memory:'); listed = [];
    connect(); await settings.hydrate(); await settings.flush();
    const bare = settings.settingsDocId();
    assert.ok(bare && bare !== next && !Object.keys(docs.get(bare).loro.getMap(settings.ROOT).toJSON()).length, 'a new install with no choices makes a document that holds no key');
    cache.open(':memory:'); listed = [{ id: bare, title: settings.TITLE, createTime: '2026-09-26T10:00:00Z' }];
    connect(); await settings.hydrate();
    assert.equal(settings.settingsDocId(), bare, 'and the next machine takes that one rather than making a second');
    // An older build's document, made before any key was written: no key, no mark. The machine that knows it marks it.
    const legacy = new Document('tana:text:' + ulid());
    legacy.transact((l) => initDocument(l, settings.TITLE, ME));
    docs.set(legacy.id, legacy);
    cache.open(':memory:'); cache.setSetting(settings.POINTER, legacy.id); listed = [];
    connect(); await settings.hydrate();
    assert.equal(settings.settingsDocId(), legacy.id, 'the machine that made it keeps using it');
    assert.ok(Object.keys(legacy.loro.getMap('ext:orbital:doc').toJSON()).length, 'and marks it, so the next machine takes it for ours rather than for a note');
    console.log('ok  settings document: two machines settle on the oldest, a deleted one is replaced, the page hears what the document changed');
  }
  // What stayed of quick add when the panel went (issue #232): the meeting this user has joined (⌘K Pin to current
  // meeting), a task from its title alone (⌘K Quick Add Task), and the one agent handoff, driven through its real path.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    // main/ runs in its own vm realm, so what comes back is built from that realm's prototypes: normalise before deepEqual.
    const plainJson = (value) => JSON.parse(JSON.stringify(value));
    const docs = new Map();
    const make = (kind, title) => {
      const d = new Document('tana:' + kind + ':' + ulid());
      d.transact((l) => { initDocument(l, title, ME); l.getMap('data').set('type', kind); });
      docs.set(d.id, d); return d;
    };
    const meeting = make('event', 'Platform Sync');
    const callDoc = new Document('tana:call:' + ulid());
    const joinCall = (live) => callDoc.transact((l) => {
      l.getMap('data').set('ownerUri', meeting.id);
      const sessions = l.getMap('sessions');
      if (live) sessions.set(ME + ':aa11bb22', { userUri: ME, joinedAt: 111 });
      else for (const key of sessions.keys()) sessions.delete(key);
    });
    joinCall(true);
    docs.set(callDoc.id, callDoc);
    // Three types for Quick Add Task's picker: a workflow type for documents, a plain type, and a workflow type for meetings
    const typeDoc = (title, extra) => { const d = new Document('tana:type:' + ulid()); d.transact((l) => { const data = l.getMap('data'); data.set('type', 'type'); data.set('title', title); for (const [k, v] of Object.entries(extra)) data.set(k, v); }); docs.set(d.id, d); return d; };
    const bug = typeDoc('Bug', { workflowUri: 'tana:workflow:' + ulid() }), note = typeDoc('Note', {}), agenda = typeDoc('Agenda', { workflowUri: 'tana:workflow:' + ulid(), appliesTo: 'events' });
    backend.testRuntime({
      me: { userUri: ME, orgId: ORG },
      win: { isDestroyed: () => false, webContents: { send: () => {} } },
      session: { getAccessToken: async () => 'x.' + Buffer.from(JSON.stringify({ org_id: ORG, role: 'member' })).toString('base64url') + '.x' },
      client: {
        graph: { listNodes: async (p) => {
          if ((p.nodeTypes || [])[0] === 'call') return { nodes: [{ id: callDoc.id }] };
          if ((p.nodeTypes || [])[0] === 'type') return { nodes: [bug, note, agenda].map((d) => ({ id: d.id, title: readNode(d).title })) };
          if (p.nodeIds) return { nodes: p.nodeIds.map((id) => ({ id, title: docs.has(id) ? readNode(docs.get(id)).title : null })) };
          return { nodes: [] };
        } },
        sync: { subscribe: async (id, init) => { if (init) { const d = new Document(id); d.transact(init); docs.set(id, d); return d; } if (!docs.has(id)) throw new Error(id + ' unavailable'); return docs.get(id); },
          getDocument: (id) => docs.get(id) || null }, // a document already open, which is how the handoff reads a title without subscribing again
      },
    });
    const current = () => backend.handlers.get('meeting:current')(null);
    const joined = await current();
    assert.deepEqual({ id: joined.id, title: joined.title }, { id: meeting.id, title: 'Platform Sync' }, 'the current meeting is the one whose call this user has joined');
    joinCall(false); // the call ended between two asks
    assert.equal(await current(), null, 'and it is read at every ask, never cached from the last one');
    joinCall(true);
    const added = await backend.createDocument('Draft the agenda', { kind: 'task' });
    const task = readNode(docs.get(added.id));
    assert.deepEqual([task.title, task.stateType, plainJson(task.assignedToUris)], ['Draft the agenda', 'open', [ME]], 'a task from its title alone is open and assigned to its creator');
    // Quick Add Task's picker (issue #237): workflow types for documents only, and a task of one keeps being an open task of yours
    assert.deepEqual(plainJson(await backend.handlers.get('doc:taskTypes')(null)).map((t) => t.title), ['Bug'], 'Quick Add Task offers only the workflow types for documents');
    const typed = readNode(docs.get((await backend.createDocument('Login fails', { kind: 'task', typeUri: bug.id })).id));
    assert.deepEqual([typed.entityTypeUri, typed.stateType, plainJson(typed.assignedToUris)], [bug.id, 'open', [ME]], 'a task of a type is an open task of yours, with the type');
    await assert.rejects(backend.createDocument('Standup', { kind: 'task', typeUri: agenda.id }), /applies to meetings/, 'a type for meetings makes no task');
    // Create new … with a workflow type (#534): the same open task of yours, not a document with the type and no state
    const chosen = readNode(docs.get((await backend.createDocument('Crash on save', { kind: 'custom', typeUri: bug.id })).id));
    assert.deepEqual([chosen.entityTypeUri, chosen.stateType, plainJson(chosen.assignedToUris)], [bug.id, 'open', [ME]], 'Create new with a workflow type makes a task of that type');
    const noted = readNode(docs.get((await backend.createDocument('Meeting notes', { kind: 'custom', typeUri: note.id })).id));
    assert.deepEqual([noted.entityTypeUri, noted.stateType ?? null], [note.id, null], 'and a type without a workflow still makes a document');
    // The handoff names the task after its node title, so Codex names the thread after the work.
    const handed = [];
    backend.agent.createTask = async (opts) => { handed.push(opts); return '01a0b3a3-c000-70b0-896e-08e86986ca0e'; };
    const risk = make('text', 'Review the Q3 risk log');
    await backend.assignToAgent(risk.id, 'Summarise it', undefined, undefined);
    assert.equal(String(handed[0].prompt).split('\n')[0], 'Tana: Review the Q3 risk log', 'the agent is told the node title first');
    // A node whose task already runs on another machine is refused before anything is written: the context and the
    // stored prompt used to be rewritten first, for a handoff that then never happened.
    const elsewhere = 'tana:text:01j0elsewhere000000000000';
    const attic = backend.agent.addHost({ title: 'Attic', ssh: 'attic.local', bin: '/opt/codex' });
    backend.agent.setCodexTask(elsewhere, '01a0b3a3-c000-70b0-896e-08e86986ca0f', attic.id);
    await assert.rejects(backend.assignToAgent(elsewhere, 'Do it', 'm', 'local'), /runs on Attic/, 'a remote task is refused by name');
    assert.equal((backend.settings.get('codexPrompt') || {})[elsewhere], undefined, 'and its prompt was not rewritten on the way');
    console.log('ok  current meeting read fresh, a task from its title alone or of a workflow type, and the agent handoff by name and by machine');
  }
  {
    const backend=mainHelpers(), d=new Document(DOC);
    d.transact(l=>initDocument(l,'batch bridge',ME));
    const first=outline.readOutline(d)[0].id; outline.setText(d,first,'A');
    const ids=[first,...['B','C'].map(text=>outline.insertAfter(d,null,text))];
    backend.testRuntime({me:{userUri:ME},client:{sync:{subscribe:async()=>d,getDocument:()=>d}}});
    await backend.handlers.get('block:removeMany')(null,DOC,ids.slice(0,2));
    assert.deepEqual(outline.readOutline(d).map(n=>n.text),['C']);
    await backend.undo();assert.deepEqual(outline.readOutline(d).map(n=>n.text),['A','B','C']);
    assert.equal(await backend.undo(),null,'one main history entry for batch remove');
    await backend.handlers.get('block:moveMany')(null,DOC,ids.slice(0,2),'down');
    assert.deepEqual(outline.readOutline(d).map(n=>n.text),['C','A','B']);
    await backend.undo();assert.deepEqual(outline.readOutline(d).map(n=>n.text),['A','B','C']);
    assert.equal(await backend.undo(),null,'one main history entry for batch move');
    await backend.handlers.get('block:indentMany')(null,DOC,ids.slice(1));
    assert.deepEqual(outline.readOutline(d).map(n=>n.text),['A']);
    assert.deepEqual(outline.readOutline(d)[0].children.map(n=>n.text),['B','C'],'B and C became children of A');
    await backend.undo();assert.deepEqual(outline.readOutline(d).map(n=>n.text),['A','B','C']);
    assert.equal(await backend.undo(),null,'one main history entry for batch indent');
    // a drag: the place, not a direction, and the field it may land in is the same document seen through another root
    await backend.handlers.get('block:moveTo')(null,DOC,ids[2],DOC,ids[0],null);
    assert.deepEqual(outline.readOutline(d).map(n=>n.text),['A','B'],'C left the top level');
    assert.deepEqual(outline.readOutline(d)[0].children.map(n=>n.text),['C'],'and is the first row inside A');
    await backend.undo();assert.deepEqual(outline.readOutline(d).map(n=>n.text),['A','B','C']);
    assert.equal(await backend.undo(),null,'one main history entry for a drag');
    const FIELD=DOC+'|tana:type:01j0typ0000000000000000000?attribute=n5e1hgxz';
    await backend.handlers.get('block:moveTo')(null,DOC,ids[2],FIELD,null,null);
    assert.deepEqual(outline.readOutline(d).map(n=>n.text),['A','B'],'a row dragged into a field leaves the page');
    assert.deepEqual(require('../sdk/fields').readFields(d).map(f=>f.text),['C'],'and is what the field now says');
    await backend.undo();assert.deepEqual(outline.readOutline(d).map(n=>n.text),['A','B','C'],'in one step, because a page and its fields are one document');
    await assert.rejects(backend.handlers.get('block:moveTo')(null,'tana:text:01examplew0000000000000000',ids[2],DOC,null,null),/within its own document/,'and a block cannot be dragged into another document');
    await backend.handlers.get('block:insertMention')(null,DOC,'tana:text:01examplew0000000000000000','Elsewhere',null,ids[0]);
    assert.deepEqual(outline.readOutline(d).map(n=>n.text),['A','Elsewhere','B','C'],'a document dropped into an outline lands as a reference to it');
    await backend.undo();assert.deepEqual(outline.readOutline(d).map(n=>n.text),['A','B','C'],'in one step');
    console.log('ok  removeMany/moveMany/indentMany/moveTo IPC bridges each record exactly one undo step');
  }
  {
    const backend=mainHelpers(), docs=new Map();
    const task=(id,title)=>{const d=new Document(id);d.transact(l=>initDocument(l,title,ME));setState(d,'open',ME);docs.set(id,d);return d;};
    const first=task(DOC,'First'), second=task('tana:text:'+ulid(),'Second');
    const plain=new Document('tana:text:'+ulid());plain.transact(l=>initDocument(l,'Plain',ME));docs.set(plain.id,plain);
    backend.testRuntime({me:{userUri:ME},client:{sync:{subscribe:async(id)=>docs.get(id),getDocument:(id)=>docs.get(id)}}});
    await assert.rejects(backend.handlers.get('doc:setStateMany')(null,[first.id,plain.id],'closed'),/only be changed on tasks/);
    assert.equal(readNode(first).stateType,'open','batch preflight prevents a partial status change');
    assert.equal(await backend.handlers.get('doc:setStateMany')(null,[first.id,second.id],'closed'),2);
    assert.deepEqual([readNode(first).stateType,readNode(second).stateType],['closed','closed']);
    await backend.undo();assert.deepEqual([readNode(first).stateType,readNode(second).stateType],['open','open']);
    assert.equal(await backend.undo(),null,'one main history entry for batch status');
    assert.equal(await backend.handlers.get('doc:setAssigneesMany')(null,[first.id,second.id],[ME]),2);
    assert.deepEqual([taskMeta(first).assignees,taskMeta(second).assignees],[[ME],[ME]]);
    await backend.undo();assert.deepEqual([taskMeta(first).assignees,taskMeta(second).assignees],[[],[]]);
    assert.equal(await backend.undo(),null,'one main history entry for batch assignees');
    console.log('ok  task status/assignee batches preflight all documents and record one undo step');
  }
  // 1. Request messages: binary round-trip and protobuf-JSON shape from PLATFORM-PROTOCOL.md §1.1/§2
  const Req = message('sync', 'ServerSyncRequest'), Cmd = message('sync', 'ServerSyncCommandRequest');
  const peerId = derivePeerId('01examplei0000000000000000');
  assert.equal(BigInt(peerId) >> 16n, 265604616632439n, 'peerId user hash');
  const req = create(Req, { orgId: ORG, peer: { peerId, ephemeral: true, storageId: '' } });
  assert.deepEqual(toJson(Req, fromBinary(Req, toBinary(Req, req))), { orgId: ORG, peer: { peerId, ephemeral: true, storageId: '' } });
  const vvBytes = new Uint8Array([1, 2, 3]);
  const cmds = {
    beginDocumentSync: { documentId: DOC, clientVv: vvBytes, ephemeral: false },
    applyBootstrapUpdates: { documentId: DOC, sessionId: 's1', baseServerVv: new Uint8Array(), updates: vvBytes },
    liveDocumentUpdate: { documentId: DOC, sessionId: 's1', updates: [vvBytes, vvBytes] },
    unsubscribeDocument: { documentId: DOC, sessionId: 's1' },
  };
  for (const [kind, value] of Object.entries(cmds)) {
    const m = create(Cmd, { orgId: ORG, peerId, commandUnion: { case: kind, value } });
    const back = fromBinary(Cmd, toBinary(Cmd, m));
    assert.equal(back.commandUnion.case, kind);
    assert.deepEqual(toJson(Cmd, back), toJson(Cmd, m));
  }
  assert.deepEqual(toJson(Cmd, create(Cmd, { orgId: ORG, peerId, commandUnion: { case: 'beginDocumentSync', value: cmds.beginDocumentSync } })),
    { orgId: ORG, peerId, beginDocumentSync: { documentId: DOC, clientVv: 'AQID', ephemeral: false } });
  const Resp = message('sync', 'ServerSyncCommandResponse');
  const resp = fromJson(Resp, { bootstrapResponse: { sessionId: 's1', status: 'BOOTSTRAP_STATUS_EXISTING', serverVv: 'AQID', serverUpdates: '' } });
  assert.equal(resp.responseUnion.case, 'bootstrapResponse');
  assert.equal(resp.responseUnion.value.status, 1);
  const ListReq = message('graph', 'ListNodesRequest');
  const list = fromJson(ListReq, { nodeTypes: ['text'], assignedTo: [ME], stateTypes: ['open'], limit: 500, sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] });
  assert.equal(list.sortOptions[0].field, 2);
  console.log('ok  proto round-trips');

  {
    const { audience, audienceMetadata } = require('../sdk/node');
    const doc = (restricted, participants) => ({ id: DOC, data: { toJSON: () => ({ restricted, participants }) } });
    const meOnly = { [ME]: { type: 'user', role: 'admin' } };
    const shared = { ...meOnly, ['tana:user-profile:01examplem0000000000000000']: { type: 'user', role: 'viewer' } };
    assert.equal(await audience(doc(true, meOnly), ME), 'only-me');
    assert.equal(await audience(doc(true, shared), ME), 'people');
    assert.equal(await audience(doc(true, { space: { type: 'group' } }), ME), 'unknown');
    assert.equal(await audience(doc(undefined, meOnly), ME), 'unknown');
    assert.equal(await audience(doc(false, meOnly), ME, { getOwnerChain: async () => ({ effectivelyRestricted: false }) }), 'everyone');
    assert.equal(await audience(doc(false, meOnly), ME, { getOwnerChain: async () => ({}) }), 'unknown');
    const graph = { getOwnerChain: async () => ({ entries: [{ uri: 'tana:space:boundary', restricted: true }] }) };
    assert.equal(await audience(doc(false, meOnly), ME, graph, { subscribe: async () => doc(true, shared) }), 'space');
    assert.equal(await audience(doc(undefined, meOnly), ME, graph, { subscribe: async () => doc(true, shared) }), 'space');
    assert.equal(await audience(doc(false, meOnly), ME, graph, { subscribe: async () => doc(true, meOnly) }), 'only-me');
    const namedSpace = {id:'tana:space:boundary',data:{toJSON:()=>({title:'Studio LT',restricted:true,participants:shared})}};
    const SAMU = 'tana:user-profile:01examplem0000000000000000'; // shared's other person
    assert.deepEqual(await audienceMetadata(doc(false,meOnly),ME,graph,{subscribe:async()=>namedSpace}), {audience:'space',audienceSpace:{uri:'tana:space:boundary',title:'Studio LT'},people:[ME,SAMU]});
    assert.deepEqual(await audienceMetadata(doc(false,meOnly),ME,graph,{subscribe:async()=>doc(true,shared)}), {audience:'space',audienceSpace:{uri:'tana:space:boundary'},people:[ME,SAMU]});
    assert.deepEqual(await audienceMetadata(doc(true,meOnly),ME), {audience:'only-me',people:[ME]});
    assert.deepEqual(await audienceMetadata(doc(false,meOnly),ME,graph,{subscribe:async()=>{throw new Error('unavailable');}}), {audience:'unknown'});
    // #93: an inherited boundary is as determinate as a direct one. Verified against real data: tasks inside a
    // private meeting, meetings with an external guest, and documents whose only boundary is the organization.
    const EVENT = 'tana:event:01examplen0000000000000000', ORGDOC = 'tana:org:01examplel0000000000000000';
    const boundaryOf = (uri) => ({ getOwnerChain: async () => ({ entries: [{ uri, restricted: true, accessible: true }], effectivelyRestricted: true }) });
    const orgDoc = (members) => ({ id: ORGDOC, data: { toJSON: () => ({ memberUserProfileDocUris: members }) } });
    assert.deepEqual(await audienceMetadata(doc(undefined, {}), ME, boundaryOf(EVENT), { subscribe: async () => doc(true, shared) }),
      { audience: 'people', people: [ME, SAMU] }, 'a task inside a meeting shared with several people is selected people, not unknown');
    assert.deepEqual(await audienceMetadata(doc(true, { ...meOnly, 'tana:guest-profile:01exampleo0000000000000000': { type: 'user', role: 'attendee' } }), ME),
      { audience: 'people', people: [ME, 'tana:guest-profile:01exampleo0000000000000000'] }, 'an external guest participant is a person, not an unresolved grant');
    assert.deepEqual(await audienceMetadata(doc(undefined, {}), ME, boundaryOf(ORGDOC), { subscribe: async () => orgDoc({ u: ME }) }),
      { audience: 'everyone', people: [ME] }, 'the organization root is a members-only boundary: everyone in the organization, named by its membership map');
    const GUEST = 'tana:guest-profile:01exampleo0000000000000000';
    assert.deepEqual(await audienceMetadata(doc(undefined, { [GUEST]: { type: 'user', role: 'viewer' } }), ME, boundaryOf(ORGDOC), { subscribe: async () => orgDoc({ u: ME }) }),
      { audience: 'everyone', people: [ME, GUEST] }, 'and a guest shared on the document itself, who can open it too');
    assert.deepEqual(await audienceMetadata(doc(undefined, {}), ME, boundaryOf(ORGDOC), { subscribe: async () => orgDoc({}) }), { audience: 'unknown' });
    assert.deepEqual(await audienceMetadata(doc(undefined, {}), ME, boundaryOf(EVENT), { subscribe: async () => doc(true, {}) }),
      { audience: 'unknown' }, 'a boundary with no participants stays unknown');
    assert.deepEqual(await audienceMetadata(doc(undefined, {}), ME, boundaryOf(EVENT), { subscribe: async () => doc(true, { 'tana:group:x': { type: 'group' } }) }),
      { audience: 'unknown' }, 'an inherited group grant stays unknown');
    // #100: an assignee outside a restricted audience is named, so the row can warn that they cannot see it
    const SAM = 'tana:user-profile:01examplem0000000000000000', OTHER = 'tana:user-profile:01examplep0000000000000000';
    const assigned = (restricted, participants) => ({ id: DOC, data: { toJSON: () => ({ restricted, participants, assignedToUris: [SAM] }) } });
    assert.deepEqual(await audienceMetadata(assigned(true, meOnly), ME), { audience: 'only-me', people: [ME], hiddenFrom: [SAM] }, 'assigned to Sam, visible only to me');
    assert.deepEqual(await audienceMetadata(assigned(true, shared), ME), { audience: 'people', people: [ME, SAM] }, 'Sam is among the people it is shared with');
    assert.deepEqual(await audienceMetadata(assigned(undefined, {}), ME, boundaryOf(EVENT), { subscribe: async () => doc(true, { ...meOnly, [OTHER]: { type: 'user', role: 'attendee' } }) }),
      { audience: 'people', people: [ME, OTHER], hiddenFrom: [SAM] }, 'inside a meeting Sam is not invited to');
    assert.deepEqual(await audienceMetadata(assigned(undefined, { [SAM]: { type: 'user', role: 'editor' } }), ME, boundaryOf(EVENT), { subscribe: async () => doc(true, shared) }),
      { audience: 'people', people: [SAM, ME] }, 'a grant on the document itself counts beside the boundary');
    // a grant on an owner between the document and its boundary counts too (access.js audienceOf), once per person
    const FOLDER = 'tana:text:01examplef0000000000000000';
    const viaFolder = { getOwnerChain: async () => ({ entries: [{ uri: FOLDER, accessible: true }, { uri: EVENT, restricted: true, accessible: true }], effectivelyRestricted: true }) };
    const folderGrants = (grants) => ({ subscribe: async (uri) => (uri === FOLDER ? doc(undefined, grants) : doc(true, meOnly)) });
    assert.deepEqual(await audienceMetadata(assigned(undefined, {}), ME, viaFolder, folderGrants({ [SAM]: { type: 'user', role: 'editor' } })),
      { audience: 'people', people: [SAM, ME] }, 'Sam, granted on the folder in between, can see it');
    assert.deepEqual(await audienceMetadata(assigned(undefined, {}), ME, viaFolder, folderGrants(meOnly)),
      { audience: 'only-me', people: [ME], hiddenFrom: [SAM] }, 'the same person granted twice is still only me');
    console.log('ok  audience: direct/inherited restrictions, everyone and unresolved groups');
  }

  {
    const d = new Document(DOC, { peerId: '71' }), mirror = new Document(DOC, { peerId: '72' });
    d.on('local-update', u => mirror.applyRemote([u]));
    const id = outline.insertAfter(d, null, 'Keep me');
    outline.setText(d, id, [{ text: 'Keep ' }, { mention: { label: 'Member', uri: ME } }]);
    const original = outline.readOutline(d)[0];
    outline.toggleCheckbox(d, id);
    assert.deepEqual(outline.readOutline(d)[0], { ...original, done: 0, block: 'bullet' }, 'a checkbox node is a listItem, so it reads as a bullet');
    outline.insertChild(d, id, 'Child');
    const nested = outline.readOutline(d)[0];
    outline.toggleCheckbox(d, id);
    assert.deepEqual(outline.readOutline(d)[0], { ...nested, done: 1 });
    outline.toggleCheckbox(d, id);
    assert.deepEqual(outline.readOutline(d)[0], nested);
    assert.deepEqual(mirror.content.toJSON(), d.content.toJSON());
    assert.equal(d.data.get('stateType'), undefined, 'block checkbox never turns its document into a task');
    assert.equal(d.undo(), true);
    assert.equal(outline.readOutline(d)[0].done, 1);
    console.log('ok  native block checkbox conversion/toggle preserves id, mentions, children and converges');
  }

  {
    const d = new Document(DOC, { peerId: '73' });
    const parent = outline.insertAfter(d, null, 'Parent');
    outline.toggleCheckbox(d, parent);
    for (const checked of [0, 1]) {
      const sibling = outline.insertAfter(d, parent, 'Sibling');
      const child = outline.insertChild(d, parent, 'Child');
      const tree = outline.readOutline(d);
      assert.equal(tree[0].done, checked, 'insertion preserves parent state');
      assert.equal(tree.find(n => n.id === sibling).done, 0);
      assert.equal(tree[0].children.find(n => n.id === child).done, undefined, 'children do not inherit checkbox state');
      outline.toggleCheckbox(d, parent);
    }
    const plain = outline.insertAfter(d, null, 'Plain');
    const sibling = outline.insertAfter(d, plain, 'Plain sibling');
    const child = outline.insertChild(d, plain, 'Plain child');
    const tree = outline.readOutline(d);
    assert.equal(tree.find(n => n.id === sibling).done, undefined);
    assert.equal(tree.find(n => n.id === plain).children.find(n => n.id === child).done, undefined);
    setState(d, 'open', ME);
    const taskChild = outline.insertAfter(d, null, 'Task child');
    const nestedChild = outline.insertChild(d, taskChild, 'Nested task child');
    const taskTree = outline.readOutline(d);
    const childNode = taskTree.find(n => n.id === taskChild);
    assert.equal(childNode.done, undefined, 'document task state never marks content as a checkbox');
    assert.equal(childNode.children.find(n => n.id === nestedChild).done, undefined);
    console.log('ok  checkbox inheritance only for explicit checkbox siblings; task/plain children stay plain');
  }

  {
    const d = new Document(DOC, { peerId: '74' });
    const heading = outline.insertAfter(d, null, 'component');
    outline.setBlockType(d, heading, 'heading2');
    outline.toggleCheckbox(d, heading); // a listItem can carry a heading and nested blocks
    const first = outline.insertChild(d, heading, 'First child');
    outline.setText(d, heading, 'component edited');
    const second = outline.insertChild(d, heading, 'Second child');
    const node = outline.readOutline(d)[0];
    assert.equal(node.heading, 2);
    assert.equal(node.text, 'component edited');
    assert.deepEqual(node.children.map((child) => child.id), [second, first]);
    console.log('ok  heading in a list item edits and accepts children');
  }

  {
    const { editable } = require('../sdk/node');
    const node = (kind, role) => ({ id: 'tana:' + kind + ':example', participants: { [ME]: { type: 'user', role } } });
    assert.equal(editable(node('user-profile', 'admin'), ME), false);
    assert.equal(editable(node('text', 'editor'), ME), true);
    assert.equal(editable(node('text', 'admin'), ME), true);
    assert.equal(editable(node('text', 'viewer'), ME), false);
    assert.equal(editable({ id: DOC, ownerUri: ME }, ME), null, 'ownership does not grant editing');
    assert.equal(editable(node('event', 'admin'), ME), false, 'calendar protected fields need separate capability');
    assert.equal(editable(node('chat', 'editor'), ME), false);
    assert.equal(editable(node('chat', 'admin'), ME, true), true, 'a chat you administer can be renamed (#540)');
    assert.equal(editable(node('chat', 'viewer'), ME, true), false, 'a viewer still cannot rename it');
    assert.equal(editable(node('skill', 'admin'), ME, true), true, 'nor an agent or skill you made');
    assert.equal(editable({ id: 'tana:skill:builtin' }, ME, true), null, 'a built-in skill has no role to rename it with');
    assert.equal(editable({ id: 'tana:type:example' }, ME, true), true, 'a type title is Tana\'s to refuse, like its fields');
    assert.equal(editable(node('event', 'admin'), ME, true), false, 'a meeting title stays calendar protected');
    assert.equal(editable(node('type', 'admin'), ME), false, 'and without title a type stays read-only');
    // A saved search is a document the user owns and renames, so its kind must reach the ACL logic rather than
    // being refused outright — but only its kind: the roles still decide, exactly as they do for text.
    assert.equal(editable(node('search', 'editor'), ME), true, 'a saved search you can edit is renamable');
    assert.equal(editable(node('search', 'admin'), ME), true);
    assert.equal(editable(node('search', 'viewer'), ME), false, 'a viewer still cannot rename it');
    assert.equal(editable({ id: 'tana:search:example', ownerUri: ME }, ME), null,
      'and with no participants entry the answer is unknown, not yes — owning it is not the same as being granted a role');
    // The kinds that stay refused outright are unchanged by that: canvas, agent, skill and type remain read-only.
    for (const kind of ['canvas', 'agent', 'skill', 'type']) {
      assert.equal(editable(node(kind, 'admin'), ME), false, kind + ' stays read-only in the outliner');
    }
    console.log('ok  outline editability: profiles, ACL roles, unknown ownership, protected events, renamable searches');
  }

  // Main startup status and node appearance are pure helpers: no Electron app, network, or Tana data.
  {
    const { resolveInitialAuth, graphRow, cachedNodeHue, VIEWS } = mainHelpers();
    assert.equal((await resolveInitialAuth({ isAuthenticated: async () => true })).authenticated, true);
    assert.equal((await resolveInitialAuth({ isAuthenticated: async () => false })).authenticated, false);
    const error = new Error('offline');
    const failed = await resolveInitialAuth({ isAuthenticated: async () => { throw error; } });
    assert.equal(failed.authenticated, null);
    assert.equal(failed.error, error);
    const space = graphRow({ id: 'tana:space:01examplep0000000000000000', title: 'Space', appearance: { hue: 0 } });
    assert.equal(space.hue, 0);
    assert.equal(space.tags[0].hue, 0);
    const plain = graphRow({ id: 'tana:text:01exampleq0000000000000000', title: 'Plain' });
    assert.equal(plain.hue, undefined);
    assert.equal(plain.tags[0].hue, undefined);
    assert.equal(cachedNodeHue(space), 0, 'own hue survives the cached kind tag');
    assert.equal(cachedNodeHue({ id: plain.id, icon: null, tags: [{ label: 'Type', hue: 0 }] }), undefined, 'type hue is not a node hue');
    assert.equal(graphRow({ id: 'tana:chat:01exampler0000000000000000', title: 'Chat' }).icon, 'chat');
    assert.ok(VIEWS.some((s) => s.id === 'inbox' && s.title === 'Inbox' && s.icon === 'inbox'));
    // A weekday on its own reads as the week ahead, so a past meeting has to carry its date: "Fri" for last Friday
    // in a list that also holds this Friday is the one thing a meeting row must never say.
    const at = (days, hour) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days); d.setHours(hour); return d.toISOString(); };
    const metaOf = (days) => graphRow({ id: 'tana:event:01examples0000000000000000', title: 'Meeting', calendarEvent: { startTime: at(days, 13), endTime: at(days, 14) } }).meta;
    assert.match(metaOf(-3), /\d/, 'a meeting in the past carries its day of the month');
    assert.match(metaOf(9), /\d{1,2} [A-Z]/, 'and so does one further out than the week ahead');
    assert.doesNotMatch(metaOf(0), /\d{1,2} [A-Z][a-z]{2}/, 'today is just a weekday and a time');
    assert.doesNotMatch(metaOf(3), /\d{1,2} [A-Z][a-z]{2}/, 'and so is a day later this week');
    console.log('ok  initial auth states and node appearance hue');
  }

  // #63: appearance.hue exists on graph nodes only (verified read-only: spaces and typed documents never carry it in
  // their Loro data map), so reading a document must not erase a hue and a pinned space must still get its colour.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const spaceId = 'tana:space:' + ulid(), spaceDoc = new Document(spaceId);
    spaceDoc.transact((l) => { initDocument(l, 'Studio LT', ME); l.getMap('data').set('type', 'space'); });
    const lookups = [];
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      sync: { subscribe: async () => spaceDoc, getDocument: () => spaceDoc },
      graph: { listNodes: async (p) => { lookups.push(p.nodeIds); return { nodes: [{ id: spaceId, title: 'Studio LT', appearance: { hue: 193 } }] }; } },
    } });
    const node = await backend.handlers.get('doc:info')(null, spaceId);
    assert.equal(node.hue, 193, 'a space opened from a pin keeps the hue only the graph knows');
    assert.equal(node.tags[0].hue, 193, 'the space tag is coloured too');
    assert.equal(JSON.stringify(lookups), JSON.stringify([[spaceId]]));
    assert.equal((await backend.handlers.get('doc:info')(null, spaceId)).hue, 193);
    assert.equal(lookups.length, 1, 'the appearance lookup is cached per document');
    assert.equal(backend.rememberNodeHue({ id: spaceId, title: 'Studio LT' }), false, 'a data-map read carries no appearance and changes nothing');
    assert.equal((await backend.handlers.get('doc:info')(null, spaceId)).hue, 193, 'reading the document never erases the graph hue');
    console.log('ok  appearance hue survives Loro reads and reaches documents opened without a cached row');
  }

  // Sort/group data on a row: updatedAt and createdAt (ISO) and the task's stateType, including for a cached
  // SQLite row, whose table has no column for either time or state.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {} });
    const taskId = 'tana:text:' + ulid(), docId = 'tana:text:' + ulid(), eventId = 'tana:event:' + ulid();
    const task = { id: taskId, title: 'Review the sample agreement', createTime: '2026-09-09T15:19:49.638Z', updateTime: '2026-09-13T15:12:43Z', state: { type: 'open' } };
    const plain = { id: docId, title: 'Notes', createTime: '2026-09-01T09:00:00.000Z', updateTime: '2026-09-02T09:00:00.000Z' };
    const event = { id: eventId, title: 'Studio Offsite', createTime: '2026-09-03T09:00:00.000Z', updateTime: '2026-09-04T09:00:00.000Z', calendarEvent: { startTime: '2026-09-10T07:00:00.000Z' } };
    [task, plain, event].forEach(backend.rememberNodeHue);
    const rows = [task, plain, event].map((n) => backend.toNode(backend.graphRow(n)));
    assert.deepEqual(rows.map((r) => r.createdAt), [task.createTime, plain.createTime, event.createTime]);
    assert.deepEqual(rows.map((r) => r.updatedAt), [task.updateTime, plain.updateTime, event.updateTime]);
    assert.deepEqual(rows.map((r) => r.stateType), ['open', undefined, undefined], 'only a task carries a state');
    assert.deepEqual(rows.map((r) => r.done), [0, undefined, undefined], 'done keeps its own meaning');
    // a view renders db rows: they keep updatedAt, and the rest comes back from the graph cache
    cache.upsert({ ...backend.graphRow(task), section: 'library' });
    const cached = backend.toNode(cache.get(task.id));
    assert.equal(cached.updatedAt, task.updateTime);
    assert.equal(cached.createdAt, task.createTime);
    assert.equal(cached.stateType, 'open');
    // a Loro data map instead of a graph node: createdAt is milliseconds there, and the state can have moved on
    const doc = new Document(taskId);
    doc.transact((l) => initDocument(l, 'Review the sample agreement', ME, { kind: 'task', now: 1788262342702 }));
    setState(doc, 'closed', ME);
    backend.rememberNodeHue(readNode(doc));
    assert.equal(backend.toNode({ id: taskId, title: 'x', icon: 'task', done: 1, tags: [] }).createdAt, new Date(1788262342702).toISOString());
    assert.equal(backend.toNode({ id: taskId, title: 'x', icon: 'task', done: 1, tags: [] }).stateType, 'closed');
    // A row with no cached view row behind it — a saved search's rows, and the doc:info answer a live update patches
    // one with — used to come back with no updatedAt at all, so its "Updated ..." line simply vanished while its
    // siblings (which a view had cached) kept theirs. The graph's updateTime is the one authority; reading the
    // document must not erase it, and no current time is invented in its place.
    assert.equal(backend.toNode({ id: taskId, title: 'x', icon: 'task', done: 1, tags: [] }).updatedAt, task.updateTime, 'a row without its own time falls back to what the graph last said');
    const uncached = 'tana:text:' + ulid(), uncachedDoc = new Document(uncached);
    uncachedDoc.transact((l) => initDocument(l, 'Add self-service temporary budget limit adjustment feature to Penny', ME, { kind: 'task' }));
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      sync: { subscribe: async () => uncachedDoc, getDocument: () => uncachedDoc },
      graph: { listNodes: async () => ({ nodes: [] }) },
    } });
    backend.rememberNodeHue({ id: uncached, title: 'Add self-service temporary budget limit adjustment feature to Penny', createTime: '2026-09-17T14:33:36.288Z', updateTime: '2026-09-17T17:48:39Z', state: { type: 'proposed' } });
    const info = await backend.handlers.get('doc:info')(null, uncached);
    assert.equal(info.updatedAt, '2026-09-17T17:48:39Z', 'doc:info keeps the update time for a task no view has cached');
    // ...and for a plain document: expanding a Type page's row subscribes it, the bootstrap is patched in through
    // doc:info, and an invented current time put the row on top of a list sorted by last update.
    uncachedDoc.data.delete('stateType');
    assert.equal((await backend.handlers.get('doc:info')(null, uncached)).updatedAt, '2026-09-17T17:48:39Z', 'doc:info keeps the update time for a plain document too');
    // A real edit is still news: the bootstrap's change is the baseline, and a change after it that moved the document
    // stamps the row, which the graph's own updateTime replaces once it has caught up.
    backend.onChange(uncached, { origin: 'remote' });
    assert.equal((await backend.handlers.get('doc:info')(null, uncached)).updatedAt, '2026-09-17T17:48:39Z', 'the first change is the bootstrap, a read');
    uncachedDoc.transact((l) => l.getMap('data').set('title', 'Edited elsewhere'));
    backend.onChange(uncached, { origin: 'remote' });
    assert.ok((await backend.handlers.get('doc:info')(null, uncached)).updatedAt > '2026-09-17T17:48:39Z', 'an edit after it moves the update time');
    backend.rememberNodeHue({ id: uncached, title: 'Edited elsewhere', updateTime: '2026-09-17T17:48:39Z' }); // a lagging graph row
    assert.ok((await backend.handlers.get('doc:info')(null, uncached)).updatedAt > '2026-09-17T17:48:39Z', 'a lagging graph answer does not take the edit back');
    assert.ok(backend.toNode({ id: uncached, title: 'x', tags: [], updatedAt: '2026-09-17T17:48:39Z' }).updatedAt > '2026-09-17T17:48:39Z', 'nor does a row built with the graph\'s older time');
    // A document just made here has no graph row yet: its creation time stands in, so a list sorted by update keeps it on top.
    const made = 'tana:text:' + ulid(), madeDoc = new Document(made);
    madeDoc.transact((l) => initDocument(l, 'Just made', ME, { now: 1790000000000 }));
    backend.testRuntime({ me: { userUri: ME }, win: null, client: { sync: { subscribe: async () => madeDoc, getDocument: () => madeDoc }, graph: { listNodes: async () => ({ nodes: [] }) } } });
    assert.equal((await backend.handlers.get('doc:info')(null, made)).updatedAt, new Date(1790000000000).toISOString(), 'a new document is as new as it was made');
    // A discard-local resync empties the document and bootstraps it again: a read, not an edit.
    const reset = 'tana:text:' + ulid(), resetDoc = new Document(reset);
    resetDoc.transact((l) => initDocument(l, 'Reset', ME, {}));
    backend.testRuntime({ me: { userUri: ME }, win: null, client: { sync: { subscribe: async () => resetDoc, getDocument: () => resetDoc }, graph: { listNodes: async () => ({ nodes: [] }) } } });
    backend.rememberNodeHue({ id: reset, title: 'Reset', updateTime: '2026-09-01T10:00:00Z' });
    backend.onChange(reset, { origin: 'remote' });
    const snapshot = resetDoc.exportSince();
    resetDoc.reset(); backend.onChange(reset, { origin: 'remote' });
    resetDoc.applyRemote([snapshot]); backend.onChange(reset, { origin: 'remote' });
    assert.equal((await backend.handlers.get('doc:info')(null, reset)).updatedAt, '2026-09-01T10:00:00Z', 'a reset and its bootstrap are no edit');
    // Nor is a reconnect's catch-up: edits made while away arrive during the bootstrap, and the graph knows when they were made.
    backend.testRuntime({ me: { userUri: ME }, win: null, client: { sync: { subscribe: async () => resetDoc, getDocument: () => resetDoc, stateOf: () => 'bootstrapping' }, graph: { listNodes: async () => ({ nodes: [] }) } } });
    resetDoc.transact((l) => l.getMap('data').set('title', 'Edited while away')); backend.onChange(reset, { origin: 'remote' });
    assert.equal((await backend.handlers.get('doc:info')(null, reset)).updatedAt, '2026-09-01T10:00:00Z', 'a catch-up import keeps the graph time');
    // An edit made here is one whatever state the document is in; and a reset that discards it takes its time back too.
    resetDoc.transact((l) => l.getMap('data').set('title', 'Edited offline')); backend.onChange(reset, { origin: 'local' });
    assert.ok((await backend.handlers.get('doc:info')(null, reset)).updatedAt > '2026-09-01T10:00:00Z', 'a local edit is stamped while the document bootstraps');
    resetDoc.reset(); backend.onChange(reset, { origin: 'remote' });
    resetDoc.applyRemote([snapshot]); backend.onChange(reset, { origin: 'remote' });
    assert.equal((await backend.handlers.get('doc:info')(null, reset)).updatedAt, '2026-09-01T10:00:00Z', 'a reset that discards the edit discards its time');
    console.log('ok  rows carry updatedAt/createdAt/stateType, from the graph and from cached view rows');
  }

  // The window reopens with its last frame, unless that frame is gone from every display or is not a frame at all.
  {
    const { restoredBounds } = mainHelpers(), plainJson = (v) => JSON.parse(JSON.stringify(v));
    const laptop = { x: 0, y: 25, width: 1512, height: 920 }, external = { x: 1512, y: 0, width: 2560, height: 1415 };
    assert.deepEqual(plainJson(restoredBounds(null, [laptop])), { width: 900, height: 700 }, 'first start: the default size, centred');
    assert.deepEqual(plainJson(restoredBounds({ x: 120, y: 60, width: 1100, height: 820, maximized: false }, [laptop])), { x: 120, y: 60, width: 1100, height: 820 }, 'the saved frame comes back');
    assert.deepEqual(plainJson(restoredBounds({ x: 1800, y: 100, width: 1400, height: 1000 }, [laptop, external])), { x: 1800, y: 100, width: 1400, height: 1000 }, 'also on a second display');
    assert.deepEqual(plainJson(restoredBounds({ x: 1800, y: 100, width: 1400, height: 1000 }, [laptop])), { width: 900, height: 700 }, 'a frame left on an unplugged display falls back to the default');
    assert.deepEqual(plainJson(restoredBounds({ x: 100, y: 2000, width: 800, height: 600 }, [laptop])), { width: 900, height: 700 }, 'so does a title bar below every display');
    assert.deepEqual(plainJson(restoredBounds({ x: 'a', width: 0 }, [laptop])), { width: 900, height: 700 }, 'and a setting that is not a frame');
    console.log('ok  window frame is restored only where a display still shows it');
  }

  // The sidebar's Changes section (#273): the node's own history, exactly as the graph keeps it. `editors` is one
  // entry per person with that person's last edit; create and archive times stand on their own. Nothing is invented:
  // a deletion has no actor in the graph, so it has none here either.
  {
    const { changesOf } = mainHelpers(), plainJson = (v) => JSON.parse(JSON.stringify(v));
    const ANA = 'tana:user-profile:01exampleana00000000000000', BEN = 'tana:user-profile:01exampleben00000000000000';
    const node = {
      id: DOC, title: 'Send reply', createTime: '2026-09-18T06:04:45.181Z', createdBy: ANA, updateTime: '2026-09-18T09:32:55Z',
      editors: { [ANA]: { peerUserHash: '159370730943085', editTime: '2026-09-18T06:32:55Z' }, [BEN]: { peerUserHash: '2', editTime: '2026-09-18T09:32:55Z' } },
    };
    assert.deepEqual(plainJson(changesOf(node)), [
      { action: 'Updated', by: BEN, at: '2026-09-18T09:32:55Z' },
      { action: 'Updated', by: ANA, at: '2026-09-18T06:32:55Z' },
      { action: 'Created', by: ANA, at: '2026-09-18T06:04:45.181Z' },
    ], 'every editor is an entry, newest first, and the creation is the oldest one');
    assert.deepEqual(plainJson(changesOf({ ...node, archivedAt: '2026-09-18T10:00:00Z' })[0]), { action: 'Archived', at: '2026-09-18T10:00:00Z' },
      'an archived node leads with its archiving, and claims no actor the graph does not name');
    assert.deepEqual(plainJson(changesOf({ createTime: '2026-09-18T06:04:45.181Z', updateTime: '2026-09-18T09:32:55Z' })), [
      { action: 'Updated', at: '2026-09-18T09:32:55Z' },
      { action: 'Created', at: '2026-09-18T06:04:45.181Z' },
    ], 'with no editors listed the update time still says when, and nobody is named for it');
    assert.deepEqual(plainJson(changesOf({ createTime: '2026-09-18T06:04:45.181Z', updateTime: '2026-09-18T06:04:45.181Z' })), [{ action: 'Created', at: '2026-09-18T06:04:45.181Z' }],
      'a node nobody has touched since it was made shows one entry, not an edit that never happened');
    assert.deepEqual(plainJson(changesOf({ createdBy: ANA })), [{ action: 'Created', by: ANA }], 'a creation with no time keeps the actor and says nothing about when');
    assert.deepEqual(plainJson(changesOf({})), [], 'a node the graph knows nothing about has no history to show');
    assert.deepEqual(plainJson(changesOf(undefined)), [], 'and neither has a node that could not be read');
    console.log('ok  node history: editors, creation and archival, newest first, nothing invented');
  }

  // The written summaries Tana's own Changes panel shows (tana.history.v1alpha1). The service has answered in both
  // orders and leaves the default enum out of its JSON, which is exactly where a mapping like this goes wrong.
  {
    const { summaryChanges } = mainHelpers(), plainJson = (v) => JSON.parse(JSON.stringify(v));
    const ANA = 'tana:user-profile:01exampleana00000000000000', BEN = 'tana:user-profile:01exampleben00000000000000';
    const answered = [
      { id: 'a', level: 'CHANGE_SUMMARY_LEVEL_MINUTES', startTime: '2026-09-18T06:04:45Z', endTime: '2026-09-18T06:04:45Z', title: 'Draft written', description: 'A first draft was written.', authors: [ANA], changeType: 'CHANGE_SUMMARY_TYPE_CREATED' },
      { id: 'b', level: 'CHANGE_SUMMARY_LEVEL_MINUTES', startTime: '2026-09-18T06:17:22Z', endTime: '2026-09-18T06:32:55Z', title: 'Reviewers added', description: 'Two reviewers joined the document.', authors: [ANA, BEN] },
    ];
    assert.deepEqual(plainJson(summaryChanges(answered)), [
      { action: 'Updated', by: ANA, others: 1, at: '2026-09-18T06:32:55Z', title: 'Reviewers added', note: 'Two reviewers joined the document.' },
      { action: 'Created', by: ANA, at: '2026-09-18T06:04:45Z', title: 'Draft written', note: 'A first draft was written.' },
    ], 'summaries come back newest first, dated by when the window closed, and a summary with no changeType is an update (the enum default protobuf JSON omits)');
    assert.deepEqual(plainJson(summaryChanges([...answered].reverse())).map((c) => c.title), ['Reviewers added', 'Draft written'],
      'and newest first whichever order the service answered in: the times decide, not the position');
    assert.deepEqual(plainJson(summaryChanges([{ id: 'c', startTime: '2026-09-18T06:00:00Z', title: '  ', authors: [], changeType: 'CHANGE_SUMMARY_TYPE_DELETED' }])),
      [{ action: 'Deleted', at: '2026-09-18T06:00:00Z' }], 'an empty title, no author and no end time leave those parts out rather than filling them in');
    assert.deepEqual(plainJson(summaryChanges([])), [], 'nothing answered is nothing shown');
    assert.deepEqual(plainJson(summaryChanges(undefined)), [], 'and a service that answered nothing at all is not an error here');
    console.log('ok  change summaries: newest first, enum default, extra authors counted, empty parts left out');
  }



  // #97: before the session and sync stream are ready, every view/metadata/permission call fails the same benign
  // way. Boot must stay quiet: no error status, no work fired against a client that does not exist yet.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const sent = [];
    backend.testRuntime({ client: null, me: null, session: null, win: { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } } });
    for (const name of ['doc:info', 'doc:taskMeta', 'doc:accessOptions', 'outline:children', 'pins:state', 'doc:setTitle', 'doc:create']) {
      const failure = await backend.handlers.get(name)(null, DOC, 'title').then(() => null, (e) => String(e.message || e));
      assert.equal(failure, 'not connected to Tana', name + ' must fail benignly before the connection is ready');
    }
    assert.equal((await backend.handlers.get('search')(null, 'anything')).length, 0);
    const emptyLibrary = await backend.handlers.get('view:list')(null, 'library');
    assert.equal(emptyLibrary.nodes.length, 0);
    assert.equal(emptyLibrary.truncated, false);
    const space = await backend.handlers.get('outline:children')(null, 'tana:space:' + ulid()).then(() => null, (e) => String(e.message || e));
    assert.equal(space, 'not connected to Tana', 'listing a space before the connection is a startup state too');
    assert.equal(backend.statusSnapshot().error, null, 'a startup call is a state, not an error to show');
    assert.deepEqual(sent.filter(([channel, payload]) => channel === 'sync:status' && payload && payload.error), [], 'no error status reaches the renderer during startup');
    console.log('ok  startup: metadata, permission and view calls before the connection stay quiet');
  }

  // searchChildren (main/related.js), through the real outline:children routing (main.js's isSearch branch):
  // a readable query runs the query, and an unreadable one fails closed rather than falling back to "every kind,
  // most recently updated" (Important #2 of the final review).
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const searchId = 'tana:search:' + ulid();
    const goodDoc = new Document(searchId);
    goodDoc.transact((l) => {
      initDocument(l, 'My Tasks', ME); l.getMap('data').set('type', 'search');
      l.getMap('query').set('assignedToViewer', true);
      l.getMap('query').setContainer('types', new LoroList()).push('text');
    });
    const listCalls = [], subscribes = [];
    const found = [{ id: 'tana:text:' + ulid(), title: 'One' }, { id: 'tana:text:' + ulid(), title: 'Two' }];
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      sync: { subscribe: async (id) => { subscribes.push(id); return goodDoc; } },
      graph: { listNodes: async (p) => { listCalls.push(p); return { nodes: found }; } },
    } });
    const listed = await backend.handlers.get('outline:children')(null, searchId);
    assert.equal(listCalls.length, 1);
    assert.deepEqual(listCalls[0].nodeTypes, ['text'], 'a readable query runs the graph query it describes');
    assert.deepEqual(listCalls[0].assignedTo, [ME]);
    assert.deepEqual(listed.map((n) => n.id), found.map((n) => n.id), 'and answers with the rows it found');
    // A view subscribes every row it lists, which is what makes an edit someone else makes appear in it. These rows
    // are listed the same way and were left unsubscribed, so a saved search showed only what its query said on open.
    assert.deepEqual(found.map((n) => subscribes.includes(n.id)), [true, true], 'a saved search subscribes the rows it lists, so a change made elsewhere reaches them');
    // Two reads of one search out at once (a refresh and a Save): the older one answering last must not take the head
    const answers = [], older = [{ id: 'tana:text:' + ulid(), title: 'Before the save' }], newer = [{ id: 'tana:text:' + ulid(), title: 'Saved' }];
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      sync: { subscribe: async (id) => { subscribes.push(id); return goodDoc; } },
      graph: { listNodes: () => new Promise((resolve) => answers.push(resolve)) },
    } });
    const first = backend.handlers.get('outline:children')(null, searchId), second = backend.handlers.get('outline:children')(null, searchId);
    while (answers.length < 2) await new Promise(setImmediate);
    answers[1]({ nodes: newer }); await second; answers[0]({ nodes: older }); await first;
    await new Promise(setImmediate);
    assert.deepEqual([subscribes.includes(newer[0].id), subscribes.includes(older[0].id)], [true, false], 'an older read of a search answering after a newer one leaves the newer head live');
    // ...but a newer read that fails decides nothing: an older one that answered still keeps its head live
    const kept = [{ id: 'tana:text:' + ulid(), title: 'Answered' }];
    const third = backend.handlers.get('outline:children')(null, searchId), fourth = backend.handlers.get('outline:children')(null, searchId);
    while (answers.length < 4) await new Promise(setImmediate);
    answers[3](Promise.reject(new Error('unavailable'))); await fourth.catch(() => {}); answers[2]({ nodes: kept }); await third;
    await new Promise(setImmediate);
    assert.equal(subscribes.includes(kept[0].id), true, 'a newer read that failed leaves an older answered read to keep its head live');
    // One search open in two windows: each keeps the head its own newest read answered, whichever window asked last
    const inA = [{ id: 'tana:text:' + ulid(), title: 'A' }], inB = [{ id: 'tana:text:' + ulid(), title: 'B' }];
    const reader = (id) => { const page = { id, frame: {}, isDestroyed: () => false, send() {} }; backend.S.windows.add({ isDestroyed: () => false, panes: [page] }); return { senderFrame: page.frame }; }; // a page handle per window (main.js addPage)
    const readA = backend.handlers.get('outline:children')(reader(101), searchId), readB = backend.handlers.get('outline:children')(reader(102), searchId);
    while (answers.length < 6) await new Promise(setImmediate);
    answers[5]({ nodes: inB }); await readB; answers[4]({ nodes: inA }); await readA;
    await new Promise(setImmediate);
    assert.deepEqual([subscribes.includes(inA[0].id), subscribes.includes(inB[0].id)], [true, true], 'two windows showing one search each keep their own head live');
    // A read from before a Save answering after the Save's own read failed: it asked the old query, so it keeps no head
    const beforeSave = [{ id: 'tana:text:' + ulid(), title: 'Old query' }];
    const oldRead = backend.handlers.get('outline:children')(null, searchId);
    while (answers.length < 7) await new Promise(setImmediate);
    goodDoc.transact((l) => l.getMap('query').set('assignedToViewer', false)); // the Save
    const savedRead = backend.handlers.get('outline:children')(null, searchId);
    while (answers.length < 8) await new Promise(setImmediate);
    answers[7](Promise.reject(new Error('unavailable'))); await savedRead.catch(() => {}); answers[6]({ nodes: beforeSave }); await oldRead;
    await new Promise(setImmediate);
    assert.equal(subscribes.includes(beforeSave[0].id), false, 'a read of the query from before a Save keeps no head, even when the read after it failed');
    // The same when the Save changed only the completed window, which lives beside the query in the view map
    const beforeWindow = [{ id: 'tana:text:' + ulid(), title: 'Old window' }];
    const windowRead = backend.handlers.get('outline:children')(null, searchId);
    while (answers.length < 9) await new Promise(setImmediate);
    goodDoc.transact((l) => l.getMap('view').set('completedWithin', 7));
    const windowSaved = backend.handlers.get('outline:children')(null, searchId);
    while (answers.length < 10) await new Promise(setImmediate);
    answers[9](Promise.reject(new Error('unavailable'))); await windowSaved.catch(() => {}); answers[8]({ nodes: beforeWindow }); await windowRead;
    await new Promise(setImmediate);
    assert.equal(subscribes.includes(beforeWindow[0].id), false, 'nor does a read from before a Save that changed only the completed window');
    // A page that closes with a read still out: the read's answer recreates no head for it
    const closing = [{ id: 'tana:text:' + ulid(), title: 'Closed pane' }];
    const lateRead = backend.handlers.get('outline:children')(reader(301), searchId);
    while (answers.length < 11) await new Promise(setImmediate);
    backend.dropSearchHeads(301); // main.js dropPage
    answers[10]({ nodes: closing }); await lateRead;
    await new Promise(setImmediate);
    assert.equal(subscribes.includes(closing[0].id), false, 'a read answering after its page closed keeps no head');
    backend.S.windows.clear();

    const brokenDoc = new Document('tana:search:' + ulid());
    brokenDoc.transact((l) => initDocument(l, 'Broken search', ME)); // no query container at all
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      sync: { subscribe: async () => brokenDoc },
      graph: { listNodes: async (p) => { listCalls.push(p); return { nodes: [] }; } }, // must not be reached
    } });
    const failure = await backend.handlers.get('outline:children')(null, brokenDoc.id).then(() => null, (e) => String(e.message || e));
    assert.match(failure || '', /no readable query/, 'an unreadable query fails closed instead of listing everything');
    assert.equal(listCalls.length, 1, 'the graph is never queried once the read is known to be unusable');
    console.log('ok  searchChildren: a readable query runs, an unreadable one fails closed instead of listing everything');
  }
  // Search (main/views.js): a member's name loses the relevance race to every document mentioning it, so the
  // people come from a query of their own and are merged in; a #member search is that query and nothing else.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const calls = [];
    const sam = { id: 'tana:user-profile:' + ulid(), title: 'Sam Okafor', userProfile: { name: 'Sam Okafor' }, updateTime: '2026-09-20T10:00:00Z' };
    const doc = { id: 'tana:text:' + ulid(), title: 'Notes with Sam', updateTime: '2026-09-20T10:00:00Z' };
    backend.testRuntime({ me: { userUri: ME }, win: null, client: { graph: { listNodes: async (p) => { calls.push(p); return { nodes: p.nodeTypes.length === 1 && p.nodeTypes[0] === 'user-profile' ? [sam] : [doc] }; } } } });
    const plain = JSON.parse(JSON.stringify(await backend.search('Sam')));
    assert.deepEqual(plain.map((n) => n.id), [sam.id, doc.id], 'a plain search lists the member beside the documents, the name match first');
    assert.deepEqual(calls.map((p) => p.nodeTypes.join()), ['text,event,user-profile,space,search', 'user-profile'], 'one query for everything, one for the people');
    calls.length = 0;
    await backend.search('Sam #member');
    assert.deepEqual(calls.map((p) => p.nodeTypes.join()), ['user-profile'], 'a #member search is the people query alone');
    console.log('ok  search: members are fetched beside the full-text hits, so "@" finds a person by name');
  }
  // Related results (#20): Tana's search page adds what only a semantic search found, fetched by id under the
  // search's own filters and listed after the text hits. A failure is no related results, not a failed search.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const hit = { id: 'tana:text:' + ulid(), title: 'Budget 2027' }, near = { id: 'tana:text:' + ulid(), title: 'Cost forecast' };
    const hidden = { id: 'tana:text:' + ulid(), title: 'Lunch' }, semanticCalls = [], byId = [];
    let answer = [hit, near, hidden, { id: 'not-a-uri' }, near].map((n) => ({ documentId: n.id }));
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      graph: { listNodes: async (p) => { if (p.nodeIds) { byId.push(p); return { nodes: [hidden, near].filter((n) => p.nodeIds.includes(n.id)) }; } return { nodes: p.nodeTypes.join() === 'user-profile' ? [] : [hit] }; } },
      search: { semanticSearch: async (p) => { semanticCalls.push(p); if (answer instanceof Error) throw answer; return answer; } },
    } });
    const settings = require('../main/settings'); settings.set('hiddenTitles', ['Lunch']);
    const rows = JSON.parse(JSON.stringify(await backend.search('budget #task')));
    assert.deepEqual(rows.map((n) => [n.id, !!n.related]), [[hit.id, false], [near.id, true]], 'the semantic-only hit comes last, marked related; a text hit, a hidden title and a bad id do not');
    assert.deepEqual(JSON.parse(JSON.stringify(semanticCalls)), [{ query: 'budget', limit: 20 }], 'the words are asked, not the #filter');
    assert.deepEqual(JSON.parse(JSON.stringify([byId[0].nodeIds, byId[0].nodeTypes, !!byId[0].stateTypes, 'textQuery' in byId[0], 'sortOptions' in byId[0]])), [[near.id, hidden.id], ['text'], true, false, false], 'fetched by id, once each, under the #task filter');
    semanticCalls.length = 0;
    await backend.search('bud');
    assert.equal(semanticCalls.length, 0, 'under four characters there is no semantic search, as in Tana');
    answer = new Error('FailedPrecondition');
    assert.deepEqual(JSON.parse(JSON.stringify(await backend.search('budget'))).map((n) => n.id), [hit.id], 'a refused semantic search leaves the text results');
    settings.set('hiddenTitles', []);
    console.log('ok  search: related results are the semantic-only hits, under the same filters, after the rest');
  }

  // Backlinks (main/related.js): the sidebar's "Mentioned in" and the typed fields this node sits in, grouped the way
  // Tana's own Backlinks panel groups them — a field section per attribute, the plain mentions last.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const docId = 'tana:text:' + ulid(), mentionId = 'tana:text:' + ulid(), fieldDocId = 'tana:text:' + ulid();
    const typeUri = 'tana:type:' + ulid(), attributeUri = typeUri + '?attribute=n5e1hgxz';
    const typeDoc = { data: { get: (key) => (key === 'template' ? { attributes: [{ key: 'n5e1hgxz', title: 'Discuss with' }] } : undefined) } };
    const nodes = {
      [docId]: { id: docId, title: 'Tuxis' },
      [mentionId]: { id: mentionId, title: 'Risks Foundry' },
      [fieldDocId]: { id: fieldDocId, title: 'Discussion Point' },
      [typeUri]: { id: typeUri, title: 'Discussion Point' },
    };
    const edgeCalls = [];
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      sync: { subscribe: async (id) => (id === typeUri ? typeDoc : { data: { get: () => undefined } }) },
      graph: {
        listNodes: async (p) => ({ nodes: (p.nodeIds || []).map((id) => nodes[id]).filter(Boolean) }),
        listEdges: async (p) => {
          edgeCalls.push(p);
          if (p.fromNodeIds) return { edges: [] }; // no pins
          return { edges: [
            { fromNodeId: mentionId, toNodeId: docId, type: 'EDGE_TYPE_LINKS_TO', properties: { label: 'Tuxis' } },
            { fromNodeId: fieldDocId, toNodeId: docId, type: 'EDGE_TYPE_ATTRIBUTE_LINKS_TO', properties: { attributeUri } },
            { fromNodeId: fieldDocId, toNodeId: docId, type: 'EDGE_TYPE_ATTRIBUTE_LINKS_TO', properties: { attributeUri } }, // the same field twice
            { fromNodeId: docId, toNodeId: docId, type: 'EDGE_TYPE_LINKS_TO' }, // a node never lists itself
            { fromNodeId: 'tana:text:' + ulid(), toNodeId: docId, type: 'EDGE_TYPE_LINKS_TO' }, // unreadable target
          ] };
        },
        getOwnerChain: async () => ({ entries: [] }),
      },
    } });
    const lite = await backend.related(docId, { lite: true });
    assert.deepEqual([lite.lite, edgeCalls.length, 'backlinks' in lite, Array.isArray(lite.fields)], [true, 0, false, true], 'a list row\'s fields: no ListEdges, no sidebar (#579)');
    const answered = await backend.related(docId);
    const incoming = edgeCalls.find((p) => p.toNodeIds);
    const asked = JSON.parse(JSON.stringify(incoming)); // main runs in its own vm context, so compare plain values
    assert.deepEqual(asked.edgeTypes, ['EDGE_TYPE_LINKS_TO', 'EDGE_TYPE_ATTRIBUTE_LINKS_TO'], 'both kinds of backlink are asked for: mentions and field references');
    assert.deepEqual(asked.toNodeIds, [docId], 'and for the zoomed node itself');
    assert.deepEqual(JSON.parse(JSON.stringify(answered.backlinks.map((g) => g.label))), ['Discussion Point › Discuss with', 'Mentioned in'],
      'a field reference is named "<Type> › <Field>" and the plain mentions come last, as Tana orders them');
    assert.deepEqual(JSON.parse(JSON.stringify(answered.backlinks.map((g) => g.rows.map((n) => n.title)))), [['Discussion Point'], ['Risks Foundry']],
      'each group lists its documents once, whatever it is unreadable or self-referential edges say');

    // A field whose title cannot be read is not given an invented section name.
    const otherAttribute = 'tana:type:' + ulid() + '?attribute=zz1abcde'; // a type this session has never read
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      sync: { subscribe: async () => { throw new Error('unreadable'); } },
      graph: {
        listNodes: async (p) => ({ nodes: (p.nodeIds || []).map((id) => nodes[id]).filter(Boolean) }),
        listEdges: async (p) => (p.fromNodeIds ? { edges: [] } : { edges: [{ fromNodeId: fieldDocId, toNodeId: docId, type: 'EDGE_TYPE_ATTRIBUTE_LINKS_TO', properties: { attributeUri: otherAttribute } }] }),
        getOwnerChain: async () => ({ entries: [] }),
      },
    } });
    const unnamed = await backend.related(docId);
    assert.deepEqual(JSON.parse(JSON.stringify(unnamed.backlinks.map((g) => g.label))), ['Mentioned in'], 'a field whose title cannot be read joins the mentions rather than naming a section after a key');
    console.log('ok  backlinks: mentions and field references, grouped by field with the mentions last');
  }
  // Date mentions (sdk/dates.js, issue #22): Tana's two date uri kinds, a mention of one in text, chat and a date
  // field, and a day page whose backlinks include whatever mentions its date.
  {
    const dates = require('../sdk/dates'), fields = require('../sdk/fields'), chat = require('../sdk/chat');
    assert.deepEqual(dates.parseDateUri('tana:plaindate:2026-09-30'), { type: 'plaindate', date: '2026-09-30' });
    assert.deepEqual(dates.parseDateUri('tana:zoneddate:2026-09-30T14:00[Europe/Amsterdam]'), { type: 'zoneddate', date: '2026-09-30', time: '14:00', timezone: 'Europe/Amsterdam' });
    assert.deepEqual(dates.parseDateUri('tana:zoneddate:2026-09-30[America/Argentina/Buenos_Aires]'), { type: 'zoneddate', date: '2026-09-30', timezone: 'America/Argentina/Buenos_Aires' });
    for (const bad of ['tana:plaindate:2026-13-01', 'tana:plaindate:2026-9-30', 'tana:zoneddate:2026-09-30T14:00', 'tana:text:' + ulid(), undefined]) assert.equal(dates.parseDateUri(bad), undefined, String(bad));
    assert.equal(dates.dateUri('2026-09-30'), 'tana:plaindate:2026-09-30');
    assert.throws(() => dates.dateUri('30-09-2026'), /not a YYYY-MM-DD date/);
    assert.equal(dates.dateLabel('tana:plaindate:2026-09-30'), new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(2026, 8, 30)), 'labelled as Tana labels one');
    const day = { label: 'Sep 30, 2026', uri: 'tana:plaindate:2026-09-30' };
    // in text: an ordinary mention map, so it is written and read back like any other
    const page = new Document('tana:text:' + ulid());
    outline.insertMention(page, day);
    const [row] = outline.readOutline(page);
    outline.setText(page, row.id, [{ text: 'due ' }, { mention: day }]);
    assert.deepEqual(JSON.parse(JSON.stringify(outline.readOutline(page)[0].segments)), [{ text: 'due ' }, { mention: day }], 'a date mention round-trips through setText and readOutline');
    // in a chat: [label](uri) like a document link
    const zoned = 'tana:zoneddate:2026-09-30T14:00[Europe/Amsterdam]';
    assert.deepEqual(chat.segments('by [Sep 30, 2026](tana:plaindate:2026-09-30) at [2 PM](' + zoned + ')').filter((s) => s.mention), [{ mention: day }, { mention: { label: '2 PM', uri: zoned } }], 'a chat mentions dates as it mentions documents');
    // in a date field: one date per line, held the way a link field holds its links
    const typed = new Document('tana:text:' + ulid()), key = 'tana:type:' + ulid() + '?attribute=d4tef1ld', dateField = { key: 'd4tef1ld', title: 'Due', type: 'date', cardinality: 'single' };
    fields.setFieldText(typed, key, [[{ mention: day }]], { field: dateField });
    assert.deepEqual(JSON.parse(JSON.stringify(fields.readFields(typed)[0].segments)), [{ mention: day }]);
    assert.throws(() => fields.setFieldText(typed, key, [[{ mention: { label: 'Tuxis', uri: 'tana:text:' + ulid() } }]], { field: dateField }), /"Tuxis" is not a date/);
    assert.throws(() => fields.setFieldText(typed, key, [[{ mention: day }], [{ mention: { ...day, uri: 'tana:plaindate:2026-10-01' } }]], { field: dateField }), /Multiple values not allowed/);
    assert.throws(() => fields.setFieldText(typed, key, 'next friday', { field: dateField }), /Contains non-link content/);
    // a day page: the document titled with the date also lists what mentions the date
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const dayPage = 'tana:text:' + ulid(), asked = [];
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      sync: { subscribe: async () => ({ data: { get: () => undefined } }) },
      graph: { listNodes: async (p) => ({ nodes: (p.nodeIds || []).includes(dayPage) ? [{ id: dayPage, title: '2026-09-30' }] : [] }), listEdges: async (p) => { asked.push(p); return { edges: [] }; }, getOwnerChain: async () => ({ entries: [] }) },
    } });
    await backend.related(dayPage);
    assert.deepEqual(JSON.parse(JSON.stringify(asked.find((p) => p.toNodeIds).toNodeIds)), [dayPage, 'tana:plaindate:2026-09-30'], 'a day page asks for its own backlinks and its date\'s');
    console.log('ok  date mentions: plaindate/zoneddate uris, in text, chats and date fields, and a day page listing what mentions its date');
  }
  // The sidebar kept live (main/related.js watchRelated, issue #21): the page on screen gets Tana's edge live queries —
  // its backlinks, and its meeting's pins — and an edge added or taken away tells the renderer to read related() again.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const page = 'tana:text:' + ulid(), event = 'tana:event:' + ulid(), other = 'tana:text:' + ulid();
    const docs = new Map(), closed = [], sent = [];
    const answer = (id, edges) => docs.get(id).transact((loro) => {
      const data = loro.getMap('data'), list = data.get('result').setContainer('edges', new LoroList());
      for (const e of edges) list.push(e);
      data.set('state', 'ready'); data.set('resultForVersion', 1);
    });
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }, client: {
      sync: { subscribe: async (id, init) => { const d = new Document(id); d.transact(init); docs.set(id, d); return d; }, unsubscribe: async (id) => { closed.push(id); } },
      graph: { listNodes: async (p) => ({ nodes: p.nodeIds[0] === page ? [{ id: page, ownerUri: event }] : [{ id: p.nodeIds[0] }] }) },
    } });
    assert.equal(await backend.watchRelated(page), true);
    await new Promise(setImmediate);
    const [backlinks, pinsQuery] = [...docs.keys()];
    const plain = (id) => JSON.parse(JSON.stringify(docs.get(id).data.toJSON().query));
    assert.deepEqual([plain(backlinks).object.uris, plain(backlinks).predicate], [[page], { edgeTypes: [1, 4] }], 'backlinks: LINKS_TO and ATTRIBUTE_LINKS_TO into the page');
    assert.deepEqual([plain(pinsQuery).subject.uris, plain(pinsQuery).predicate], [[event], { edgeTypes: [14] }], 'pins: HAS_PIN out of the meeting the page lives in');
    const mention = (from, label) => ({ fromNode: from, toNode: page, type: 'EDGE_TYPE_LINKS_TO', properties: { label } });
    answer(backlinks, [mention('tana:text:a', 'x')]);
    answer(pinsQuery, [{ fromNode: event, toNode: 'tana:text:p', type: 'EDGE_TYPE_HAS_PIN' }]);
    answer(backlinks, [mention('tana:text:a', 'edited around')]);
    assert.deepEqual(sent, [], 'the first answers are what related() just read, and a mention edited in place moves no section');
    answer(backlinks, [mention('tana:text:a', 'edited around'), mention('tana:text:b', 'x')]);
    answer(pinsQuery, []);
    assert.deepEqual(sent, [['related:changed', page], ['related:changed', page]], 'a new mention and a pin taken off each re-read the page\'s sidebar');
    assert.equal(await backend.watchRelated(page), true);
    assert.equal(docs.size, 2, 'the same page again opens nothing new');
    assert.equal(await backend.watchRelated(other), true);
    await new Promise(setImmediate);
    assert.deepEqual(closed, [backlinks, pinsQuery], 'a new page closes the last one\'s queries');
    assert.equal(docs.size, 3, 'and a page outside a meeting or space has no pins to watch');
    sent.length = 0;
    answer(backlinks, []);
    assert.deepEqual(sent, [], 'a closed query says nothing');
    assert.equal(await backend.watchRelated(null), false);
    await new Promise(setImmediate);
    assert.deepEqual(closed.length, 3, 'no page, no queries');
    // a window each: two pages watched at once, and one window's page change leaves the other's alone (issue #137)
    assert.equal(await backend.watchRelated(page, 'w1'), true);
    assert.equal(await backend.watchRelated(other, 'w2'), true);
    await new Promise(setImmediate);
    assert.equal(closed.length, 3, 'a second window\'s page closes nothing of the first\'s');
    assert.equal(await backend.watchRelated(null, 'w1'), false);
    await new Promise(setImmediate);
    assert.equal(closed.length, 5, 'and closing one window\'s watch closes only its own two queries');
    await backend.watchRelated(null, 'w2');
    console.log('ok  live sidebar: backlinks and meeting pins as edge live queries for the page on screen, one set at a time');
  }

  // Two windows (issue #137): each window's view is refreshed and stays live, and a view's rows are let go only when no
  // window shows it any more. Each window keeps its own sidebar watch.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const inboxTask = 'tana:text:' + ulid(), aType = 'tana:type:' + ulid();
    const subscribedIds = [], unsubscribed = [], asked = [];
    const listNodes = async (p) => {
      if (p.createdBy || p.nodeIds) return { nodes: [] };
      if ((p.nodeTypes || []).includes('user-profile')) return { nodes: [] };
      if ((p.nodeTypes || []).includes('type')) { asked.push('types'); return { nodes: [{ id: aType, title: 'Decision' }] }; }
      if (JSON.stringify(p.stateTypes) === '["proposed"]') { asked.push('inbox'); return { nodes: [{ id: inboxTask, title: 'Answer Jules', state: { type: 'proposed' } }] }; }
      return { nodes: [] };
    };
    const win = () => ({ isDestroyed: () => false, webContents: { send: () => {} } });
    backend.testRuntime({ me: { userUri: ME }, activeView: 'inbox', win: win(), client: {
      sync: { subscribe: async (id) => { subscribedIds.push(id); return null; }, getDocument: () => null, unsubscribe: async (id) => { unsubscribed.push(id); } },
      graph: { listNodes, getOwnerChain: async () => ({ entries: [] }) },
    } });
    backend.S.windows = new Set([win(), win()]);
    backend.S.windowViews = new Map([[1, { id: 'inbox' }], [2, { id: 'types' }]]);
    await backend.refresh();
    assert.deepEqual([...new Set(asked)].sort(), ['inbox', 'types'], 'the refresh reads every open window\'s view');
    assert.ok(subscribedIds.includes(inboxTask) && subscribedIds.includes(aType), 'and keeps the rows of both live');
    assert.deepEqual(unsubscribed, [], 'one window\'s view does not sweep the other\'s rows away');
    backend.S.windowViews.delete(2); // the Types window closed
    await backend.refresh();
    assert.deepEqual(unsubscribed, [aType], 'a view no window shows lets its rows go');
    backend.S.windows = new Set(); backend.S.windowViews = new Map();
    console.log('ok  two windows: each window\'s view refreshed and kept live, let go when its window closes');
  }

  // The fields a page shows (main/related.js fieldsOf): every field the type defines, empty or filled — an empty one
  // used to be left out, so there was nothing to fill in — then any value left under another type.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const docId = 'tana:text:' + ulid(), typeUri = 'tana:type:' + ulid(), otherKey = 'tana:type:' + ulid() + '?attribute=q1q1q1q1';
    const filled = typeUri + '?attribute=n5e1hgxz';
    const typed = { data: { get: (key) => (key === 'entityTypeUri' ? typeUri : key === 'attributes' ? { [filled]: { nodeName: 'doc', children: [{ nodeName: 'paragraph', children: ['Sam'] }] }, [otherKey]: 'old' } : undefined) } };
    const typeDoc = { data: { get: (key) => (key === 'template' ? { attributes: [{ key: 'n5e1hgxz', title: 'Discuss with' }, { key: 'dd1dd1dd', title: 'Due' }] } : undefined) } };
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      sync: { subscribe: async (id) => { if (id === typeUri) return typeDoc; if (id === docId) return typed; throw new Error('unreadable'); } },
      graph: { listNodes: async () => ({ nodes: [] }), listEdges: async () => ({ edges: [] }), getOwnerChain: async () => ({ entries: [] }) },
    } });
    const shown = JSON.parse(JSON.stringify((await backend.related(docId)).fields));
    assert.deepEqual(shown, [
      { key: filled, label: 'Discuss with', text: 'Sam', lines: [{ segments: [{ text: 'Sam' }], block: 'paragraph' }], segments: [{ text: 'Sam' }] },
      { key: typeUri + '?attribute=dd1dd1dd', label: 'Due', text: '', lines: [], segments: [] },
      { key: otherKey, text: 'old', lines: [{ segments: [{ text: 'old' }], block: 'paragraph' }], segments: [{ text: 'old' }] },
    ], 'the type\'s fields in template order, the empty one included, then the stray value — each with its lines, and the first of them as segments');
    console.log('ok  fields: a type\'s empty field is listed so it can be filled in');
  }

  // A saved search carries its own completed window, stored in the `view` map beside its sort and grouping rather
  // than inside Tana's query vocabulary, and read back the same way: opening the search shows what it was saved with.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const DAY = 864e5, ago = (days) => new Date(Date.now() - days * DAY).toISOString();
    const searchId = 'tana:search:' + ulid(), searchDoc = new Document(searchId);
    searchDoc.transact((l) => {
      initDocument(l, 'Recently completed', ME); l.getMap('data').set('type', 'search');
      l.getMap('query').setContainer('types', new LoroList()).push('text');
      l.getMap('query').setContainer('stateTypes', new LoroList()).push('closed');
    });
    const fresh = { id: 'tana:text:' + ulid(), title: 'Done yesterday', state: { type: 'closed', enteredAt: ago(1) } };
    const older = { id: 'tana:text:' + ulid(), title: 'Done three weeks ago', state: { type: 'closed', enteredAt: ago(21) } };
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      sync: { subscribe: async () => searchDoc },
      graph: { listNodes: async () => ({ nodes: [fresh, older] }) },
    } });
    const opened = async () => (await backend.handlers.get('outline:children')(null, searchId)).map((n) => n.title);
    assert.deepEqual(await opened(), ['Done yesterday'], 'a search with no window stored opens on the same 7 days a view does');
    await backend.handlers.get('search:setFilter')(null, searchId, { types: ['tasks'], states: ['closed'], assignee: 'anyone', completedWithin: 30 }, 'updated', 'status', ['status']);
    assert.equal(searchDoc.loro.getMap('view').toJSON().completedWithin, 30, 'saving writes the window beside the arrangement, not into the query');
    assert.equal(searchDoc.loro.getMap('query').toJSON().completedWithin, undefined, 'so no key Tana does not know gets into its own vocabulary');
    assert.deepEqual(await opened(), ['Done yesterday', 'Done three weeks ago'], 'and opening the search again shows the window it was saved with');
    assert.equal((await backend.handlers.get('search:filter')(null, searchId)).filter.completedWithin, 30, 'which is what the pills read back, so the pill shows what the rows are');
    await backend.handlers.get('search:setFilter')(null, searchId, { types: ['tasks'], states: ['proposed', 'open'], assignee: 'anyone', completedWithin: 30 }, 'updated', 'status', ['status']);
    assert.equal(searchDoc.loro.getMap('view').toJSON().completedWithin, 30, 'taking Completed out of the Status filter keeps the window, so putting it back reads the same as before');
    await backend.handlers.get('search:setFilter')(null, searchId, { types: ['tasks'], states: ['closed'], assignee: 'anyone', completedWithin: 3 }, 'updated', 'status', ['status']);
    assert.equal((await backend.handlers.get('search:filter')(null, searchId)).filter.completedWithin, 3, 'every window the pill offers survives a save, 3 days included');
    await backend.handlers.get('search:setFilter')(null, searchId, { types: ['tasks'], states: ['closed'], assignee: 'anyone', completedWithin: 3, audience: 'everyone' }, 'updated', 'status', ['status']);
    assert.equal(searchDoc.loro.getMap('view').toJSON().audience, 'everyone', 'Visible to everyone is kept beside the query, like the window (#253)');
    assert.equal(searchDoc.loro.getMap('query').toJSON().visibility, 'open', 'while the query says Tana\'s nearest, Open, so Tana lists the superset');
    assert.equal((await backend.handlers.get('search:filter')(null, searchId)).filter.audience, 'everyone', 'and the pill reads it back');
    console.log('ok  a saved search stores and reapplies its own completed window, beside the query rather than inside it');
  }

  // Visible to everyone (#253): the graph's restricted: false is Tana's "Open" (the node's own flag only), so the
  // answer is narrowed by owner chains, one per distinct owner. The org root is restricted to its members: everyone.
  {
    const { everyoneOnly } = require('../sdk/access');
    const ORG = 'tana:org:01jorg00000000000000000000', OPEN = 'tana:space:01jopen0000000000000000000', LOCKED = 'tana:space:01jlocked000000000000000000';
    const chains = { [OPEN]: [{ uri: OPEN }, { uri: ORG, restricted: true }], [LOCKED]: [{ uri: LOCKED, restricted: true }, { uri: ORG, restricted: true }] };
    let asked = 0;
    const graph = { getOwnerChain: async (id) => { asked++; if (!chains[id]) throw new Error('not found'); return { entries: chains[id] }; } };
    const nodes = [{ id: 'library' }, { id: 'open1', ownerUri: OPEN }, { id: 'open2', ownerUri: OPEN }, { id: 'locked', ownerUri: LOCKED },
      { id: 'own', restricted: true }, { id: 'unreadable', ownerUri: 'tana:space:01jgone00000000000000000000' }];
    assert.deepEqual((await everyoneOnly(graph, nodes)).map((n) => n.id), ['library', 'open1', 'open2'], 'unowned or under open owners only; a failed chain is not everyone');
    assert.equal(asked, 3, 'one owner chain per distinct owner, not per row');
    assert.equal(viewParams({ audience: 'everyone' }, ME).restricted, false, 'asked as Open, then narrowed');
    assert.equal(filterToSearchQuery({ audience: 'everyone' }, ME).visibility, 'open');
    assert.deepEqual(['everyone', null, 'open'].map((audience) => validViewFilter({ audience })), [true, true, false]);
    console.log('ok  Visible to everyone: Open narrowed to what no restricted owner holds');
  }

  // A view is one graph query, then docs-without-tasks/hidden post-filters, row mapping and its own cache.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const event = { id: 'tana:event:' + ulid(), title: 'Meeting', calendarEvent: { startTime: '2026-09-14T10:00:00Z' } };
    const hidden = { id: 'tana:text:' + ulid(), title: 'Hidden doc', updateTime: '2026-09-13T10:00:00Z' };
    const doc = { id: 'tana:text:' + ulid(), title: 'Doc', updateTime: '2026-09-13T11:00:00Z' };
    const task = { id: 'tana:text:' + ulid(), title: 'Task disguised as doc', state: { type: 'open' }, updateTime: '2026-09-13T12:00:00Z' };
    const mcp = { id: 'tana:chat:' + ulid(), title: 'MCP: helper', invocationContext: { intent: 'mcp' } };
    const meetingChat = { id: 'tana:chat:' + ulid(), title: 'Private AI chat for Meeting', ownerUri: event.id, invocationContext: { intent: 'meeting' }, updateTime: '2026-09-13T11:30:00Z' };
    const requests = [];
    let totalCount = 6;
    cache.setSetting('hiddenTitles', ['Hidden doc']);
    backend.testRuntime({ me: { userUri: ME }, win: null, client: { graph: { listNodes: async (p) => {
      requests.push(p);
      if (p.nodeIds) return { nodes: [] };
      if (p.includeOwnedChats) return { nodes: [meetingChat], totalCount: 1 };
      return totalCount == null ? { nodes: [event, hidden, doc, task, mcp], truncated: true } : { nodes: [event, hidden, doc, task, mcp], totalCount };
    } }, search: { semanticSearch: async () => [] }, sync: { subscribe: async () => null, unsubscribe: async () => {} } } });
    const payload = await backend.handlers.get('view:list')(null, 'library', { types: ['meetings', 'docs', 'chats'], states: null, assignee: 'anyone' });
    assert.equal(requests.length, 2, 'one view fetch makes one graph query, and one more for the meeting chats when it lists chats');
    // as JSON: main/ runs in the check's vm context, so the request it builds has that context's Object prototype
    assert.deepEqual(JSON.parse(JSON.stringify(requests[1])), { ...requests[0], nodeTypes: ['chat'], includeOwnedChats: true, chatInvocationIntents: ['meeting'] }, 'asked under the view\'s own filters');
    assert.deepEqual(payload.nodes.map((n) => n.title).sort(), ['Doc', 'MCP: helper', 'Meeting', 'Private AI chat for Meeting'], 'docs without tasks and hidden titles are post-filtered, MCP chats only when the switch is on');
    assert.deepEqual(payload.nodes.slice(0, 2).map((n) => n.title), ['Private AI chat for Meeting', 'Doc'], 'meeting chats are merged in by update time, the order the view asked for');
    await backend.handlers.get('mcp:setHidden')(null, true);
    assert.equal(await backend.handlers.get('mcp:hidden')(), true, 'the MCP switch is remembered like any other setting');
    assert.deepEqual((await backend.handlers.get('view:list')(null, 'library', { types: ['meetings', 'docs', 'chats'], states: null, assignee: 'anyone' })).nodes.map((n) => n.title).sort(),
      ['Doc', 'Meeting', 'Private AI chat for Meeting'], 'with it on, MCP chats leave every list and search');
    assert.equal((await backend.handlers.get('search')(null, 'helper')).some((n) => n.title === 'MCP: helper'), false, 'search is filtered by the same switch, not only the views');
    await backend.handlers.get('mcp:setHidden')(null, false);
    assert.equal((await backend.handlers.get('search')(null, 'helper')).some((n) => n.title === 'MCP: helper'), true, 'and they come back when it is off');
    assert.equal(payload.truncated, true);
    assert.equal('iconSvg' in payload.nodes.find((n) => n.id === doc.id), false, 'rows carry no app-local icon');
    assert.deepEqual(Object.keys(cache.list()), ['library'], 'the fetched rows use the view id as their cache section');
    totalCount = null;
    assert.equal((await backend.handlers.get('view:list')(null, 'library', { types: ['meetings', 'docs'], states: null, assignee: 'anyone' })).truncated, true, 'the response truncation flag survives without a count');
    totalCount = 5;
    assert.equal((await backend.handlers.get('view:list')(null, 'library', { types: ['meetings', 'docs'], states: null, assignee: 'anyone' })).truncated, false,
      'local post-filters do not create a false truncation warning');
    requests.length = 0;
    await backend.handlers.get('view:list')(null, 'inbox');
    assert.equal(requests.length, 1, 'a state filter rules chats out, so the Inbox asks nothing more');
    console.log('ok  one view fetch queries, post-filters, maps and caches rows');
  }

  // The Types view: one query over type nodes, each row carrying the space it lives in.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const spaceUri = 'tana:space:' + ulid();
    const inSpace = { id: 'tana:type:' + ulid(), title: 'Decision Record', spaceUri, updateTime: '2026-09-17T09:00:00Z' };
    const loose = { id: 'tana:type:' + ulid(), title: 'Co-Worker', updateTime: '2026-09-17T08:00:00Z' };
    const requests = [];
    backend.testRuntime({ me: { userUri: ME }, win: null, client: { graph: { listNodes: async (p) => {
      requests.push(p);
      return p.nodeIds ? { nodes: [{ id: spaceUri, title: 'Studio LT' }] } : { nodes: [inSpace, loose] };
    } }, sync: { subscribe: async () => null, unsubscribe: async () => {} } } });
    const { nodes } = await backend.handlers.get('view:list')(null, 'types');
    assert.deepEqual(requests[0].nodeTypes, ['type'], 'the Types view asks the graph for type nodes and nothing else');
    assert.deepEqual(nodes.map((n) => [n.title, n.meta]), [['Decision Record', 'Studio LT'], ['Co-Worker', 'Library']],
      'each type is listed with the space it lives in, and one with no space reads as Library');
    assert.equal(requests.filter((p) => p.nodeIds).length, 1, 'the space titles are one nodeIds lookup, not an owner chain per row');
    console.log('ok  the Types view lists every type with its space');
  }

  // The completed window over a real view fetch: one more post-filter beside hidden titles, applied to the answer
  // because the graph has no field to ask for it. It composes rather than competes — the assignee filter still
  // reaches the query, and nothing but completed tasks is touched.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const DAY = 864e5, ago = (days) => new Date(Date.now() - days * DAY).toISOString();
    const open = { id: 'tana:text:' + ulid(), title: 'Still going', state: { type: 'open', enteredAt: ago(400) }, updateTime: ago(1) };
    const fresh = { id: 'tana:text:' + ulid(), title: 'Done yesterday', state: { type: 'closed', enteredAt: ago(1) }, updateTime: ago(1) };
    const older = { id: 'tana:text:' + ulid(), title: 'Done three weeks ago', state: { type: 'closed', enteredAt: ago(21) }, updateTime: ago(1) };
    const ancient = { id: 'tana:text:' + ulid(), title: 'Done last year', state: { type: 'closed', enteredAt: ago(300) }, updateTime: ago(1) };
    const requests = [];
    backend.testRuntime({ me: { userUri: ME }, win: null, client: { graph: { listNodes: async (p) => {
      requests.push(p);
      return p.nodeIds ? { nodes: [] } : { nodes: [open, fresh, older, ancient], totalCount: 4 };
    } }, sync: { subscribe: async () => null, unsubscribe: async () => {} } } });
    const listed = async (completedWithin) => (await backend.handlers.get('view:list')(null, 'library',
      { types: ['tasks'], states: ['open', 'closed'], assignee: 'me', completedWithin })).nodes.map((n) => n.title);
    assert.deepEqual(await listed(7), ['Still going', 'Done yesterday'], '7 days lists this week\'s completed work and leaves the rest behind');
    assert.deepEqual(await listed(30), ['Still going', 'Done yesterday', 'Done three weeks ago'], '30 days reaches further back');
    assert.deepEqual(await listed('all'), ['Still going', 'Done yesterday', 'Done three weeks ago', 'Done last year'], 'All keeps every completed task there is');
    assert.deepEqual(await listed(undefined), ['Still going', 'Done yesterday'], 'and a filter that has never been given one reads as 7 days');
    assert.deepEqual(requests.at(-1).stateTypes, ['open', 'closed'], 'the Status filter still decides what is asked for');
    assert.deepEqual(requests.at(-1).assignedTo, [ME], 'and the assignee filter still reaches the query, so the window composes with it');
    assert.equal('completedWithin' in requests.at(-1), false, 'the window itself is asked for nowhere: the graph has no field for it');
    console.log('ok  the completed window ages completed rows out of a view and leaves every other row alone');
  }

  // The index can trail a write: a task this app holds live keeps its live state on every row built from the index,
  // or the refresh two seconds after "Set status to Inbox" puts In Progress back.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const taskId = 'tana:text:' + ulid(), live = new Document(taskId);
    live.transact((l) => initDocument(l, 'Accepted task', ME, { kind: 'task' }));
    setState(live, 'proposed', ME); // just set to Inbox here; the index still says In Progress
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      graph: { listNodes: async (p) => (p.nodeIds ? { nodes: [] } : { nodes: [{ id: taskId, title: 'Accepted task', state: { type: 'open' }, updateTime: '2026-09-15T12:00:00Z' }], totalCount: 1 }) },
      sync: { subscribe: async () => null, unsubscribe: async () => {}, getDocument: (id) => (id === taskId ? live : undefined) },
    } });
    const row = (await backend.handlers.get('view:list')(null, 'library')).nodes.find((n) => n.id === taskId);
    assert.equal(row.stateType, 'proposed', 'the listed row takes the live state over the lagging index');
    assert.equal(row.done, 0);
    const cached = (await backend.handlers.get('outline:roots')()).find((v) => v.id === 'library').nodes.find((n) => n.id === taskId);
    assert.equal(cached.stateType, 'proposed', 'and so does the cached row the next roots read hands the renderer');
    console.log('ok  a list refresh keeps the live state of a task over a lagging index');
  }

  // The same write, but sync has no handle to hand back — a task changed from a list is not always one it still holds.
  // The document is still the newest answer about its own state, and a refresh arriving before anything reads it must
  // not restore what the index still believes: that is "Set status to Inbox", In Progress again two seconds later.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const taskId = 'tana:text:' + ulid(), live = new Document(taskId);
    live.transact((l) => initDocument(l, 'Buy milk', ME, { kind: 'task' })); // starts out In Progress
    backend.testRuntime({ me: { userUri: ME }, win: null, activeView: 'library', client: {
      graph: { listNodes: async (p) => (p.nodeIds ? { nodes: [] } : { nodes: [{ id: taskId, title: 'Buy milk', state: { type: 'open' }, updateTime: '2026-09-17T12:00:00Z' }], totalCount: 1 }) },
      sync: { subscribe: async () => live, unsubscribe: async () => {}, getDocument: () => undefined }, // nothing to ask
    } });
    await backend.handlers.get('doc:setState')(null, taskId, 'proposed');
    const listed = (await backend.handlers.get('view:list')(null, 'library')).nodes.find((n) => n.id === taskId);
    assert.equal(listed.stateType, 'proposed', 'a status write outlives the refresh even when sync hands back no document');
    assert.equal(listed.icon, 'task', 'and the row is still a task, rather than a stateless index row without a box');
    console.log('ok  a status write outlives a lagging index with no live document to consult');
  }

  // What is remembered must never outlive its truth. The point of the record is to beat a lagging index, not to beat
  // Tana: once the document itself has moved on — somebody else completed the task — reading it replaces what we
  // remembered. Without that, a status set here would override a status set anywhere else, for good.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const taskId = 'tana:text:' + ulid(), live = new Document(taskId);
    live.transact((l) => initDocument(l, 'Buy milk', ME, { kind: 'task' }));
    backend.testRuntime({ me: { userUri: ME }, win: null, activeView: 'library', client: {
      graph: { listNodes: async (p) => (p.nodeIds ? { nodes: [] } : { nodes: [{ id: taskId, title: 'Buy milk', state: { type: 'open' }, updateTime: '2026-09-17T12:00:00Z' }], totalCount: 1 }) },
      sync: { subscribe: async () => live, unsubscribe: async () => {}, getDocument: () => undefined },
    } });
    const rowState = async () => ((await backend.handlers.get('view:list')(null, 'library')).nodes.find((n) => n.id === taskId) || {}).stateType;
    await backend.handlers.get('doc:setState')(null, taskId, 'proposed');
    assert.equal(await rowState(), 'proposed', 'the status just written is what the refresh reports');
    setState(live, 'closed', ME); // completed in Tana by someone else; the renderer reads the row again through doc:info
    await backend.handlers.get('doc:info')(null, taskId);
    assert.equal(await rowState(), 'closed', 'a change from elsewhere replaces what was remembered, instead of being overridden by it');
    console.log('ok  the remembered state gives way to the document once the document has moved on');
  }

  // The real IPC handlers put every preset through that path; roots is cache-only and refresh repeats only the
  // last listed view.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const requests = [];
    const ids = { event: 'tana:event:', text: 'tana:text:', chat: 'tana:chat:', 'user-profile': 'tana:user-profile:' };
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: () => {} } }, client: {
      graph: { listNodes: async (p) => {
        requests.push(p);
        const kind = p.nodeTypes[0], id = (ids[kind] || 'tana:' + kind + ':') + ulid();
        return { nodes: [{ id, title: 'row ' + requests.length, state: kind === 'text' ? { type: 'open' } : undefined, calendarEvent: kind === 'event' ? { startTime: '2026-09-14T10:00:00Z' } : undefined }], truncated: false };
      } },
      sync: { subscribe: async () => null, unsubscribe: async () => {} },
    } });
    for (const view of backend.VIEWS) {
      const result = await backend.handlers.get('view:list')(null, view.id);
      assert.equal(result.nodes.length, 1, view.id + ' fetched through view:list');
    }
    assert.equal(requests.length, backend.VIEWS.length, 'each view makes one single query');
    const roots = await backend.handlers.get('outline:roots')();
    assert.equal(requests.length, backend.VIEWS.length, 'roots reads SQLite without fetching');
    assert.ok(roots.every((view) => view.nodes.length === 1), 'every view loads from its own cache section');
    await backend.refresh();
    assert.equal(requests.length, backend.VIEWS.length + 2, 'a refresh asks two questions: the rows of the view, and the tasks the watch rule follows');
    // The watch query is what makes the default watch mean anything: the tasks it is about are in no view's rows.
    const watchAsk = requests.find((p) => p.createdBy); // joined rather than compared as an array: built in the main vm
    assert.equal(watchAsk.createdBy.join(), ME, 'it asks for the tasks you made');
    assert.equal(watchAsk.stateTypes.includes('closed'), true, 'and asks for completions made while the app was away');
    // the last view listed above is now Types, whose preset lists type nodes
    assert.deepEqual(requests.at(-1).nodeTypes, ['type'], 'refresh repeats only the last listed view');
    const custom = await backend.handlers.get('view:setFilter')(null, 'library', { types: ['chats'], text: 'urgent' });
    assert.equal(custom.text, 'urgent');
    assert.equal(cache.setting('viewFilter:library').text, 'urgent');
    const reset = await backend.handlers.get('view:setFilter')(null, 'library', { types: ['unknown'] });
    assert.equal(reset.types.join(','), 'tasks', 'invalid writes store the preset');
    // the Library preset ships an empty text of its own, where the Chats preset this case used to run against had
    // none at all: either way the stored 'urgent' is gone, which is what the case is about
    assert.equal(reset.text, '', 'and drops the custom fields a prior valid write stored');
    // No view is a kind page any more — Tasks was the last one — so a view keeps whatever kinds it is given and a
    // stored filter is no longer overridden on the way back out.
    assert.deepEqual((await backend.handlers.get('view:setFilter')(null, 'library', { types: ['meetings', 'tasks'] })).types, ['meetings', 'tasks'], 'a view keeps the kinds it is given');
    assert.deepEqual((await backend.handlers.get('view:setFilter')(null, 'library', { types: ['meetings'] })).types, ['meetings'], 'the Library still picks its kinds');
    assert.equal(roots.filter((view) => view.kind).length, 0, 'and no view is a kind page any more, so none is marked as one');
    console.log('ok  two view handlers share fetch/cache, roots stays offline, and refresh follows the active view');
  }

  // The badge on the app icon: how many nodes are waiting in the Inbox. It rides the refresh the views already do.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const asked = [];
    let count = 7;
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: () => {} } }, client: {
      graph: { listNodes: async (p) => { asked.push(p); return { nodes: [], totalCount: count }; } },
      sync: { subscribe: async () => null, unsubscribe: async () => {} },
    } });
    assert.equal(await backend.inboxCount(), 7, 'the badge number is the graph count, not the rows fetched');
    // The query matters as much as the number: counting the wrong thing would satisfy an assertion on the count alone.
    const q = asked.at(-1);
    assert.deepEqual(q.stateTypes, ['proposed'], 'it counts what the Inbox lists: nodes waiting in Inbox');
    assert.equal(q.limit, 1, 'and asks for a count rather than a page of rows');
    assert.equal(q.mode, 'LIST_NODES_MODE_WITH_COUNT', 'so totalCount comes back at all');
    assert.deepEqual(q.assignedTo, [ME], 'and only what is waiting on you: a badge counts your own nodes, not everyone\'s');
    // A refresh carries the number to whatever owns the icon; main.js gives S.badge the electron end of it.
    const badged = [];
    backend.S.badge = (n) => badged.push(n);
    count = 3;
    await backend.refresh();
    assert.deepEqual(badged.at(-1), 3, 'a refresh updates the badge with the count it just read');
    // A count that fails must not make a refresh that worked look broken — so only the count fails here. Failing
    // every query would exercise a refresh that broke for its own reasons and prove nothing about the badge.
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: () => {} } }, client: {
      graph: { listNodes: async (p) => { if (p.limit === 1) throw new Error('unavailable'); return { nodes: [] }; } },
      sync: { subscribe: async () => null, unsubscribe: async () => {} },
    } });
    backend.S.badge = (n) => badged.push(n);
    const badgedBefore = badged.length;
    await backend.refresh();
    assert.equal(backend.statusSnapshot().syncing, false, 'the refresh still finishes');
    assert.equal(backend.statusSnapshot().error, null, 'and reports nothing wrong, because for the views nothing was');
    assert.equal(badged.length, badgedBefore, 'the badge simply keeps the number it already had');
    console.log('ok  the Inbox badge counts through the graph and rides the view refresh');
  }

  // The notifications inbox (issue #18): sdk/inbox.js against a document shaped like the live one (roots data and
  // notifications, one LoroMap per item, keys as Tana's npe schema has them), then main's page and writes over it.
  {
    const inbox = require('../sdk/inbox');
    assert.equal(inbox.inboxUri(ME), 'tana:user-inbox:01examplei0000000000000000', 'the inbox is named by the user-profile ULID (gy)');
    const doc = new Document(inbox.inboxUri(ME));
    const TASK = 'tana:text:01examplet0000000000000000', TYPE = 'tana:type:01exampley0000000000000000';
    doc.transact((l) => {
      l.getMap('data').set('type', 'user-inbox'); l.getMap('data').set('updatedAt', 1);
      const add = (id, fields) => { const m = l.getMap('notifications').setContainer(id, new LoroMap()); m.set('id', id); for (const [k, v] of Object.entries(fields)) m.set(k, v); };
      add('a', { notificationType: 'task-assignment', sourceUri: TASK, createdAt: 3000, actorUri: ME, title: 'Ship **it**!', body: 'ignored' });
      add('b', { notificationType: 'document-access', sourceUri: TASK, createdAt: 2000, title: 'Plan' });
      add('c', { notificationType: 'type-archived', sourceUri: TYPE, createdAt: 1000, actorUri: ME, title: 'Old name', readAt: 1500 });
    });
    const updated = () => doc.data.get('updatedAt');
    assert.deepEqual(inbox.items(doc).map((n) => n.id), ['a', 'b', 'c'], 'newest first, as Tana lists them');
    assert.equal(inbox.unreadCount(doc), 2);
    assert.equal(inbox.markAsRead(doc, 'c'), false, 'reading a read one changes nothing');
    assert.equal(updated(), 1, 'and leaves updatedAt alone, as Tana does');
    assert.equal(inbox.markAsRead(doc, 'a'), true);
    assert.ok(updated() > 1 && inbox.items(doc)[0].readAt === updated(), 'readAt and updatedAt are the same moment');
    assert.equal(inbox.markAsUnread(doc, 'a'), true);
    assert.equal(inbox.items(doc)[0].readAt, undefined, 'unread deletes readAt rather than clearing it');
    assert.equal(inbox.markAsReadBySourceUri(doc, TASK), true, 'by source: every unread notification about that document');
    assert.equal(inbox.unreadCount(doc), 0);
    assert.equal(inbox.markAllAsRead(doc), false, 'nothing left to read is no write');
    assert.equal(inbox.markAsUnread(doc, 'nope'), false, 'an unknown id is no write either');
    // Tana's sentences (Wqt) and the line after them (Gqt)
    const say = (n, actor, title) => inbox.phrase(n, actor, title).map((p) => (p.emphasis ? '*' + p.text + '*' : p.text)).join('');
    assert.equal(say({ notificationType: 'document-access', title: 'Plan' }, 'Sam'), '*Sam* added you to *Plan*');
    assert.equal(say({ notificationType: 'event-access' }), 'You were added to a meeting');
    assert.equal(say({ notificationType: 'task-assignment', title: 'x' }, 'Sam'), '*Sam* assigned you to a task');
    assert.equal(say({ notificationType: 'comment-mention', title: 'Plan' }), 'You were mentioned in *Plan*');
    assert.equal(say({ notificationType: 'comment-reply' }, 'Sam'), '*Sam* replied to a comment');
    assert.equal(say({ notificationType: 'incoming-call' }), 'Someone is waiting for you in a meeting');
    assert.equal(say({ notificationType: 'type-archived', title: 'Old' }, null, 'New'), '*New* was archived', 'a type is named by its current title');
    assert.equal(say({ notificationType: 'type-unarchived' }, 'Sam'), '*Sam* unarchived a type');
    assert.equal(say({ notificationType: 'chat-message', title: 'Hello' }), 'Hello');
    // which parts are the notification's own words (demo mode masks those and keeps Tana's sentence)
    const titled = (n, actor) => inbox.phrase(n, actor).filter((p) => p.title).map((p) => p.text);
    assert.deepEqual([titled({ notificationType: 'document-access', title: 'Plan' }, 'Sam'), titled({ notificationType: 'incoming-call', title: 'Board sync' }),
      titled({ notificationType: 'chat-message', title: 'Hello' }), titled({ notificationType: 'chat-message' }), titled({ notificationType: 'comment-reply' }, 'Sam')],
    [['Plan'], ['Board sync'], ['Hello'], [], []], 'a title standing in for the sentence is marked as the notification\'s own words, the fallback sentence is not');
    assert.equal(say({ notificationType: 'ai-usage-warning' }, 'Sam'), '*Sam* sent you a message', 'anything else reads as a message');
    assert.equal(inbox.detail({ notificationType: 'task-assignment', title: 'Ship **it**!', body: 'b' }), 'Ship it', 'a task shows its title, markdown and end punctuation gone');
    assert.equal(inbox.detail({ notificationType: 'comment-reply', body: '[Plan](tana:x) looks _good_.' }), 'Plan looks good');
    assert.equal(inbox.detail({ notificationType: 'type-archived', body: 'x' }), '', 'a type change has no second line');
    // Comment reminders (issue #160; rg and ng in Tana's bundle): hidden until due, a plain time local, a zoned one its own
    {
      const R = (due, more) => ({ notificationType: 'comment-reminder', due, ...more });
      const nine = Date.UTC(2026, 8, 25, 7); // 09:00 in Amsterdam, summer time
      const zoned = R({ type: 'zoned', datetime: '2026-09-25T09:00', timezone: 'Europe/Amsterdam' });
      assert.deepEqual([inbox.shown(zoned, nine - 60000), inbox.shown(zoned, nine)], [false, true], 'a zoned reminder is due at that time in its own timezone');
      const at = (datetime, timezone) => inbox.when(R({ type: 'zoned', datetime, timezone }));
      assert.deepEqual([at('2026-03-08T02:30', 'America/New_York'), at('2026-10-04T02:15', 'Australia/Lord_Howe'), at('2026-10-25T02:30', 'Europe/Amsterdam')],
        [Date.UTC(2026, 2, 8, 7, 30), Date.UTC(2026, 9, 3, 15, 45), Date.UTC(2026, 9, 25, 0, 30)], 'Temporal compatible: a skipped time moves forward by the gap, a repeated one is the earlier');
      const local = new Date(2026, 8, 25, 9).getTime(), plain = R({ type: 'plain', datetime: '2026-09-25T09:00' });
      assert.deepEqual([inbox.shown(plain, local - 60000), inbox.shown(plain, local)], [false, true], 'a plain one in the local timezone');
      assert.ok(inbox.shown(R({ type: 'zoned', datetime: '2026-09-25T09:00', timezone: 'Mars/Olympus' }), 0) && inbox.shown(R({ type: 'plain', datetime: 'soon' }), 0) && inbox.shown(R(undefined), 0),
        'an unreadable due time shows at once');
      assert.ok(inbox.shown(R({ type: 'plain', datetime: '2999-01-01T09:00' }, { firedAt: 5 }), 0) && inbox.shown({ notificationType: 'comment-mention' }, 0), 'fired, or no reminder at all: shown');
      assert.equal(inbox.when(zoned), nine, 'placed at its due time');
      const later = new Document(inbox.inboxUri(ME));
      later.transact((l) => {
        const add = (id, fields) => { const m = l.getMap('notifications').setContainer(id, new LoroMap()); for (const [k, v] of Object.entries({ id, ...fields })) { if (k === 'due') m.setContainer(k, new LoroMap()).set('datetime', v); else m.set(k, v); } };
        add('due', { notificationType: 'comment-reminder', sourceUri: TASK, createdAt: 1, due: '2000-01-01T09:00', title: 'Plan' });
        add('waiting', { notificationType: 'comment-reminder', sourceUri: TASK, createdAt: 2, due: '2999-01-01T09:00' });
        add('mention', { notificationType: 'comment-mention', sourceUri: TASK, createdAt: 3 });
      });
      assert.deepEqual([inbox.items(later).map((n) => n.id), inbox.unreadCount(later)], [['due', 'mention'], 2], 'a reminder not yet due is in neither the list nor the count, a due one sits at its due time');
      assert.equal(inbox.nextDue(later), new Date(2999, 0, 1, 9).getTime(), 'and is the next moment to look again');
      inbox.markAllAsRead(later);
      assert.equal(later.loro.getMap('notifications').get('waiting').get('readAt'), undefined, 'mark all leaves it unread for when it comes due');
      assert.deepEqual([say({ notificationType: 'comment-reminder', title: 'Plan' }), say({ notificationType: 'comment-reminder' })], ['Reminder — *Plan*', 'Reminder']);
    }

    // main: the page is outline:children of its own id, the writes answer with the count, and a change to the inbox
    // reaches the renderer as inbox:changed rather than as a document change
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const sent = [], listeners = [];
    const LIVE_QUERY = 'tana:liveQuery:' + ulid();
    doc.transact((l) => { l.getMap('notifications').get('a').delete('readAt'); });
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } },
      client: {
        sync: { on: (event, fn) => { if (event === 'change') listeners.push(fn); }, subscribe: async (id) => { assert.equal(id, doc.id); return doc; }, getDocument: (id) => (id === doc.id || id === LIVE_QUERY ? doc : null) },
        graph: { listNodes: async ({ nodeTypes, nodeIds }) => ({ nodes: nodeTypes ? [{ id: ME, title: 'Robin Vega', userProfile: {} }] : (nodeIds || []).includes(TYPE) ? [{ id: TYPE, title: 'Renamed' }] : [] }) },
      } });
    const rows = await backend.handlers.get('outline:children')(null, 'orbital:notifications');
    assert.deepEqual(JSON.parse(JSON.stringify(rows.map((r) => r.text))), ['Robin Vega assigned you to a task. Ship it.', 'You were added to Plan', 'Robin Vega archived Renamed'],
      'each row is Tana\'s sentence, the actor named from the members and a type by its current title');
    assert.deepEqual(JSON.parse(JSON.stringify(rows[0].segments[0])), { text: 'Robin Vega', marks: { bold: true }, person: true }, 'what Tana emphasises is bold, and the actor is marked as a name for demo mode');
    assert.deepEqual(JSON.parse(JSON.stringify(rows.map((r) => r.unread))), [true, false, false]);
    assert.ok(rows.every((r) => r.editable === false && r.notification.sourceUri), 'read-only rows that know what they are about');
    assert.equal(await backend.handlers.get('inbox:unread')(), 1);
    assert.equal(await backend.handlers.get('inbox:setRead')(null, 'b', false), 2, 'a write answers with the count after it');
    assert.equal(await backend.handlers.get('inbox:markAll')(), 0);
    listeners.forEach((fn) => fn(doc.id));
    assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), ['inbox:changed', 0], 'a change to the inbox is told as its unread count');
    const before = sent.length;
    backend.onChange(doc.id, { origin: 'remote' });
    assert.equal(sent.length, before, 'and it is no row\'s change');
    backend.onChange(LIVE_QUERY, { origin: 'remote' });
    assert.equal(sent.length, before, 'nor is a live query\'s update: the renderer would ask doc:info for an id that is no document');
    console.log('ok  notifications inbox: Tana\'s reads, writes and sentences, and main\'s page over them');
  }

  // Watching a node for changes: what is announced, what is deliberately not, and who decides.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const docs = new Map(), creators = new Map(), notified = [];
    // The decision to announce may need a creator lookup, so onChange takes the signature now and answers on its
    // own. Each change is given a turn of the loop before what it announced is read.
    // An edit banner also waits 4 s for the typing to stop; main's timers are held (mainHelpers), so they are run here.
    const settle = async (helpers = backend) => {
      await new Promise(setImmediate);
      for (const t of helpers.timers) if (t.ms === 4000 && !t.ran) { t.ran = true; t.fn(); }
    };
    const watched = new Document('tana:text:' + ulid());
    watched.transact((l) => initDocument(l, 'Contract', ME, { kind: 'task' }));
    setAssignees(watched, [], ME); // stated rather than assumed: the rule turns on whether it is assigned
    // OTHER is declared much further down this file, so this names its own collaborator; it only has to be a
    // user-profile uri that is not ME.
    const COLLEAGUE = 'tana:user-profile:01examplew0000000000000000';
    docs.set(watched.id, watched);
    creators.set(watched.id, ME); // who made it is the graph's answer, not the document's
    // What Tana's own Changes panel would say about each node, by uri: the banner reads the same service.
    const summaries = new Map();
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: () => {} } },
      client: {
        sync: { getDocument: (id) => docs.get(id), subscribe: async (id) => docs.get(id) },
        // A Loro document carries no creator, so the rule asks the graph. A node nobody made is a node nobody
        // created: the lookup answers with nothing rather than throwing.
        graph: { listNodes: async ({ nodeIds }) => ({ nodes: (nodeIds || []).filter((id) => creators.has(id)).map((id) => ({ id, createdBy: creators.get(id) })) }) },
        history: { listChanges: async ({ uri }) => ({ summaries: summaries.get(uri) || [] }) },
      } });
    backend.S.notify = (id, title, body, kind, subtitle) => notified.push([id, title, body, kind, subtitle]);

    // A task you made that nobody is assigned to: the case the rule is for.
    assert.equal((await backend.handlers.get('notify:state')(null, watched.id)).default, true,
      'a task you created with no assignee is watched without being asked');
    backend.onChange(watched.id, { origin: 'remote' });
    await settle();
    assert.deepEqual(notified, [], 'the first sight of a node is a baseline, not a change to announce');
    // ...and it got there by returning, not by throwing. onChange catches everything it raises, so "nothing was
    // announced" is also exactly what a crash looks like from out here — without this, dropping the baseline guard
    // passes, because the missing `before` makes it throw on the way to saying nothing.
    assert.equal(backend.statusSnapshot().error, null, 'and the baseline is taken cleanly rather than by erroring');
    setTitle(watched, 'Contract v2');
    backend.onChange(watched.id, { origin: 'remote' });
    await settle();
    assert.deepEqual(notified.map((n) => [n[0], n[2]]), [[watched.id, 'Renamed from “Contract”']], 'a remote edit to a watched node is announced, saying what it did');
    assert.equal(notified.length, 1, 'once');
    // The whole feature rests on this: onChange fires for your own typing too, and being told about your own edits
    // would make it unusable. sdk/document.js marks every change local or remote; this is what reads that mark.
    setTitle(watched, 'Contract v3');
    backend.onChange(watched.id, { origin: 'local' });
    await settle();
    assert.equal(notified.length, 1, 'your own edits are never announced back to you');
    // From here the change-summary service has something to say about this node, the way it does in the sidebar.
    const RECENT = (ms) => new Date(Date.now() - ms).toISOString();
    summaries.set(watched.id, [
      { title: 'Renamed to Contract v3', endTime: RECENT(4 * 60 * 1000) },
      { title: 'Added dependency on Finish reply document', endTime: RECENT(1000) }, // newest, whatever order it arrives in
    ]);
    setState(watched, 'closed', ME);
    backend.onChange(watched.id, { origin: 'remote' });
    await settle();
    assert.equal(notified.at(-1)[2], 'Now Completed', 'a status change says what the status became, not the sentence a summary wrote about it');
    // An edit is an edit: a body rewritten elsewhere moves neither title nor state, and a watched node nobody ever
    // hears from is the same as an unwatched one. The document's own ops are what says something happened.
    watched.transact((l) => l.getMap('content').set('rev', 1));
    backend.onChange(watched.id, { origin: 'remote' });
    await settle();
    assert.equal(notified.length, 3, 'a change to the body alone is announced too');
    assert.deepEqual([notified.at(-1)[2], notified.at(-1)[3]], ['Edited', 'edit'],
      'as an edit banner, "Edited" when no line of text moved: Tana writes its sentence minutes later, and followSummary brings it in then');
    watched.transact((l) => l.getMap('content').set('rev', 2));
    backend.onChange(watched.id, { origin: 'remote' });
    await settle();
    assert.equal(notified.length, 3, 'and the rest of that burst is quiet: remote typing arrives op by op');
    // Somebody typing: one banner once the ops stop, saying what the whole burst wrote, read from the document's history.
    const typed = new Document('tana:text:' + ulid());
    typed.transact((l) => initDocument(l, 'Notes', ME, { kind: 'task' }));
    setAssignees(typed, [], ME);
    docs.set(typed.id, typed); creators.set(typed.id, ME);
    backend.onChange(typed.id, { origin: 'remote' }); // baseline
    await settle();
    const beforeTyping = notified.length, row = outline.insertAfter(typed, null, 'Bu');
    backend.onChange(typed.id, { origin: 'remote' });
    outline.setText(typed, row, 'Budget moves to Q3');
    backend.onChange(typed.id, { origin: 'remote' });
    await settle();
    assert.deepEqual(notified.slice(beforeTyping).map((n) => [n[0], n[2], n[3]]), [[typed.id, 'Added “Budget moves to Q3”', 'edit']],
      'the words typed, not "Edited" nor the first two letters');
    // What the edit was arrives later (issue #131): followSummary waits for a sentence Changes did not have at the
    // time of the edit and replaces the banner with it. The waits are driven by hand here; the app waits 30 s each.
    const stale = new Document('tana:text:' + ulid());
    stale.transact((l) => initDocument(l, 'Old news', ME, { kind: 'task' }));
    setAssignees(stale, [], ME);
    docs.set(stale.id, stale); creators.set(stale.id, ME);
    const older = { id: 's1', title: 'Added a heading', endTime: RECENT(60 * 60 * 1000) };
    summaries.set(stale.id, [older]);
    backend.onChange(stale.id, { origin: 'remote' }); // baseline
    await settle();
    stale.transact((l) => l.getMap('content').set('rev', 1));
    backend.onChange(stale.id, { origin: 'remote' });
    await settle();
    assert.deepEqual(notified.at(-1).slice(0, 4), [stale.id, 'Old news', 'Edited', 'edit'],
      'a summary already there before the edit is not announced as it');
    const summaryFor = (id) => notified.filter((n) => n[0] === id && n[3] === 'summary');
    let polls = 0;
    await backend.followSummary(stale.id, 'Old news', async () => { polls++; });
    assert.equal(summaryFor(stale.id).length, 0, 'with nothing new written, the banner keeps saying "Edited"');
    assert.equal(polls, 16, 'and the follow-up gives up after its eight minutes');
    polls = 0;
    await backend.followSummary(stale.id, 'Old news', async () => {
      if (++polls === 2) summaries.set(stale.id, [older,
        { id: 's3', title: 'Renamed a heading', endTime: RECENT(5000) },
        { id: 's2', title: 'news', description: 'Added the Q4 numbers from Rob', endTime: RECENT(1000) }]);
    });
    assert.deepEqual(summaryFor(stale.id).map((n) => n[2]), ['Added the Q4 numbers from Rob'],
      'the newest new summary replaces it, in its description when its title only repeats the node\'s');
    assert.equal(polls, 2, 'as soon as it is there');
    // A newer edit banner takes the follow-up over: the older one never replaces what the newer one says.
    let release;
    const first = backend.followSummary(stale.id, 'Old news', () => new Promise((resolve) => { release = resolve; }));
    await settle();
    backend.followSummary(stale.id, 'Old news', () => new Promise(() => {})); // never waits out: it only takes over
    await settle();
    summaries.set(stale.id, [older, { id: 's4', title: 'Removed the budget line', endTime: RECENT(0) }]);
    release();
    await first;
    assert.equal(summaryFor(stale.id).length, 1, 'a follow-up that was taken over says nothing');
    // A summary with a title and a longer description: what changed as the subtitle, Tana's words for it as the body
    await backend.followSummary(stale.id, 'Old news', async () => {
      summaries.set(stale.id, [older, { id: 's5', title: 'Added a document link', description: 'A link to the Risk Register document on Slite was appended to the task.', endTime: RECENT(0) }]);
    });
    assert.deepEqual(summaryFor(stale.id).at(-1).slice(2), ['A link to the Risk Register document on Slite was appended to the task.', 'summary', 'Added a document link'],
      'the banner says what changed and then what it was, as the Timeline does');
    // A second node is announced from here on, so what this one said is counted rather than the whole list.
    const aboutWatched = () => notified.filter((n) => n[0] === watched.id).length;
    // Nothing moved at all — a re-imported snapshot after a resync — is not an edit either.
    backend.onChange(watched.id, { origin: 'remote' });
    await settle();
    assert.equal(aboutWatched(), 3, 'and re-seeing ops already seen announces nothing');
    // An explicit no beats a default yes, and clearing it returns to the rule rather than to off.
    await backend.handlers.get('notify:set')(null, watched.id, false);
    // Field by field: these objects are built inside the main-process vm, so a whole-object compare under
    // node:assert/strict trips on the realm's prototype rather than on anything about the values.
    const off = await backend.handlers.get('notify:state')(null, watched.id);
    assert.equal(off.on, false, 'turning it off takes effect');
    assert.equal(off.default, true, 'without changing what the rule would say');
    assert.equal(off.explicit, true, 'and it is remembered as a choice rather than as the default');
    setTitle(watched, 'Contract v4');
    backend.onChange(watched.id, { origin: 'remote' });
    await settle();
    assert.equal(aboutWatched(), 3, 'and nothing is announced while it is off');
    await backend.handlers.get('notify:set')(null, watched.id, null);
    const cleared = await backend.handlers.get('notify:state')(null, watched.id);
    assert.equal(cleared.explicit, false, 'clearing the choice forgets it');
    assert.equal(cleared.on, true, 'and returns to the rule rather than leaving it off');
    // Assigned to you: you are already looking at your own work, so it is not watched unless you ask.
    const mine = new Document('tana:text:' + ulid());
    mine.transact((l) => initDocument(l, 'My task', ME, { kind: 'task' }));
    setAssignees(mine, [ME], ME);
    docs.set(mine.id, mine);
    creators.set(mine.id, ME); // yours, so assignment is the only thing keeping this one off
    assert.equal((await backend.handlers.get('notify:state')(null, mine.id)).default, false,
      'a node assigned to you is not watched by default: the assignee is already looking at it');
    // Handed to somebody else: still yours to hear about, which is the other half of "not assigned to you" and the
    // one an unassigned-only reading would get wrong.
    const delegated = new Document('tana:text:' + ulid());
    delegated.transact((l) => initDocument(l, 'Their task', ME, { kind: 'task' }));
    setAssignees(delegated, [COLLEAGUE], ME);
    docs.set(delegated.id, delegated);
    creators.set(delegated.id, ME);
    assert.equal((await backend.handlers.get('notify:state')(null, delegated.id)).default, true,
      'a task you created and gave to somebody else is watched: that is where its news comes from');
    // Somebody else's task, shared with you: theirs to follow.
    const theirs = new Document('tana:text:' + ulid());
    theirs.transact((l) => initDocument(l, 'Their own task', ME, { kind: 'task' }));
    setAssignees(theirs, [], ME);
    docs.set(theirs.id, theirs);
    creators.set(theirs.id, COLLEAGUE);
    assert.equal((await backend.handlers.get('notify:state')(null, theirs.id)).default, false,
      'a task somebody else created is not watched, however visible it is');
    // A document you made is not a task: no stateType, so the rule leaves it alone. Meeting notes are these.
    const note = new Document('tana:text:' + ulid());
    note.transact((l) => initDocument(l, 'A note', ME, { kind: 'doc' }));
    docs.set(note.id, note);
    creators.set(note.id, ME);
    assert.equal(readNode(note).stateType, undefined, 'the fixture really is a document rather than a task');
    assert.equal((await backend.handlers.get('notify:state')(null, note.id)).default, false,
      'a document you created is not watched: the rule is about tasks');
    // A node the graph does not answer for cannot be yours, and asking must not throw.
    const orphan = new Document('tana:text:' + ulid());
    orphan.transact((l) => initDocument(l, 'Unknown origin', ME, { kind: 'task' }));
    setAssignees(orphan, [], ME);
    docs.set(orphan.id, orphan);
    assert.equal((await backend.handlers.get('notify:state')(null, orphan.id)).default, false,
      'a node with no creator in the graph is not watched');
    // Completed while the app was not running. This is the reported case: a task closed at 09:01 by somebody else,
    // an app started at 09:27. A second backend over the same settings is that restart — its own notifySigs start
    // empty, so only the stored pair can tell it that anything moved.
    const runtime = { me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: () => {} } },
      client: {
        sync: { getDocument: (id) => docs.get(id), subscribe: async (id) => docs.get(id) },
        graph: { listNodes: async ({ nodeIds }) => ({ nodes: (nodeIds || []).filter((id) => creators.has(id)).map((id) => ({ id, createdBy: creators.get(id) })) }) },
      } };
    assert.deepEqual(cache.setting('notifySeen')[watched.id], ['Contract v4', 'closed'],
      'what a node looked like when it was last seen outlives the process that saw it');
    const away = new Document('tana:text:' + ulid());
    away.transact((l) => initDocument(l, 'Talk to Peter', ME, { kind: 'task' }));
    setAssignees(away, [COLLEAGUE], ME); // created by you, given to somebody else: the rule watches it
    docs.set(away.id, away); creators.set(away.id, ME);
    cache.setSetting('notifySeen', { ...cache.setting('notifySeen'), [away.id]: ['Talk to Peter', 'open'] });
    setState(away, 'closed', COLLEAGUE); // they finished it while the app was closed
    // The same shape, silenced by hand. The rule would take it — made by you, given away, still open — so this is
    // the one place an explicit no has to reach: without it the node stays subscribed and keeps its place in
    // anything reading the watch set, which is how "I turned notifications off and it is still tracked" happens.
    const hushed = new Document('tana:text:' + ulid());
    hushed.transact((l) => initDocument(l, 'Quiet one', ME, { kind: 'task' }));
    setAssignees(hushed, [COLLEAGUE], ME);
    docs.set(hushed.id, hushed); creators.set(hushed.id, ME);
    cache.setSetting('notify', { ...cache.setting('notify'), [hushed.id]: false });
    const subscribedAfterRestart = [], discovery = [];
    runtime.client.sync.subscribe = async (id) => { subscribedAfterRestart.push(id); return docs.get(id); };
    runtime.client.sync.unsubscribe = async () => {};
    runtime.client.graph.listNodes = async (p) => {
      if (p.createdBy) { discovery.push(p); return { nodes: [{ id: away.id, assignedTo: [COLLEAGUE], state: { type: 'closed' } }, { id: hushed.id, assignedTo: [COLLEAGUE], state: { type: 'open' } }] }; }
      if (p.nodeIds) return { nodes: p.nodeIds.filter((id) => creators.has(id)).map((id) => ({ id, createdBy: creators.get(id) })) };
      if ((p.nodeTypes || []).includes('user-profile')) return { nodes: [{ id: COLLEAGUE, title: 'Sam Rivera', userProfile: {} }, { id: ME, title: 'Robin Vega', userProfile: {} }] };
      return { nodes: [], totalCount: 0 };
    };
    const restarted = mainHelpers(); restarted.testRuntime(runtime);
    const afterRestart = []; restarted.S.notify = (id, title, body) => afterRestart.push([id, title, body]);
    await restarted.refresh();
    assert.ok(discovery[0].stateTypes.includes('closed'), 'watch discovery includes a task completed while the app was away');
    assert.ok(subscribedAfterRestart.includes(away.id), 'and subscribes it so its bootstrap can reach catch-up notification');
    assert.ok(!subscribedAfterRestart.includes(hushed.id), 'a task you silenced is not picked up by the watch rule, however exactly it fits it');
    restarted.onChange(away.id, { origin: 'remote' }); // the bootstrap, which used to be a silent baseline
    await settle();
    assert.deepEqual(afterRestart.map((n) => [n[0], n[2]]), [[away.id, 'Now Completed by Sam Rivera']],
      'a task somebody else completed while the app was closed is announced on the way back, with who completed it');
    restarted.onChange(away.id, { origin: 'remote' });
    await settle();
    assert.equal(afterRestart.length, 1, 'once: the stored pair is caught up the moment it is read');
    // Your own completion, and a status that did not move, stay silent across a restart the same as they do within one.
    const byMe = new Document('tana:text:' + ulid());
    byMe.transact((l) => initDocument(l, 'My own', ME, { kind: 'task' }));
    setAssignees(byMe, [COLLEAGUE], ME);
    docs.set(byMe.id, byMe); creators.set(byMe.id, ME);
    cache.setSetting('notifySeen', { ...cache.setting('notifySeen'), [byMe.id]: ['My own', 'open'] });
    setState(byMe, 'closed', ME);
    const mine2 = mainHelpers(); mine2.testRuntime(runtime);
    const afterMine = []; mine2.S.notify = (id, title, body) => afterMine.push([id, title, body]);
    mine2.onChange(byMe.id, { origin: 'remote' });
    await settle();
    assert.deepEqual(afterMine, [], 'a task you completed yourself before quitting is not announced back to you');
    // Issue #427: at launch the first document to bootstrap — the app's own settings document, before the views have
    // subscribed anything — pruned the stored pairs down to itself, so the watched tasks behind it had nothing to be
    // compared with and their catch-up banners never fired.
    const task = (title, state) => {
      const d = new Document('tana:text:' + ulid());
      d.transact((l) => initDocument(l, title, ME, { kind: 'task' }));
      setAssignees(d, [COLLEAGUE], ME);
      docs.set(d.id, d); creators.set(d.id, ME);
      cache.setSetting('notifySeen', { ...cache.setting('notifySeen'), [d.id]: [title, 'open'] });
      if (state) setState(d, state, COLLEAGUE);
      return d;
    };
    const finished = task('Review the budget', 'closed'), idle = task('Still open');
    const byHand = 'tana:text:' + ulid(), forgotten = 'tana:text:' + ulid(); // watched by hand, listed nowhere; followed by nothing
    cache.setSetting('notifySeen', { ...cache.setting('notifySeen'), [byHand]: ['Mine to watch', 'open'], [forgotten]: ['Long gone', 'open'] });
    cache.setSetting('notify', { ...cache.setting('notify'), [byHand]: true });
    const appDoc = new Document('tana:text:' + ulid());
    appDoc.transact((l) => initDocument(l, 'Orbital', ME, { kind: 'doc' }));
    docs.set(appDoc.id, appDoc);
    const graphBefore = runtime.client.graph.listNodes;
    runtime.client.graph.listNodes = async (p) => (p.createdBy
      ? { nodes: [{ id: finished.id, assignedTo: [COLLEAGUE], state: { type: 'closed' } }, { id: idle.id, assignedTo: [COLLEAGUE], state: { type: 'open' } }] }
      : graphBefore(p));
    const warm = mainHelpers(); warm.testRuntime(runtime);
    const warmBanners = []; warm.S.notify = (id, title, body) => warmBanners.push([id, body]);
    const kept = (...ids) => ids.filter((id) => id in cache.setting('notifySeen'));
    warm.onChange(appDoc.id, { origin: 'remote' }); // arrives before the first refresh has subscribed anything
    await settle();
    assert.deepEqual(kept(finished.id, idle.id, byHand, forgotten), [finished.id, idle.id, byHand, forgotten],
      'the first document to arrive at launch prunes none of the stored pairs');
    await warm.refresh();
    warm.onChange(finished.id, { origin: 'remote' });
    warm.onChange(idle.id, { origin: 'remote' });
    await settle();
    assert.deepEqual(warmBanners, [[finished.id, 'Now Completed by Sam Rivera']],
      'the watched task completed while the app was closed is announced once, the unchanged one not at all');
    assert.deepEqual(kept(finished.id, idle.id, byHand, forgotten), [finished.id, idle.id, byHand],
      'the refresh prunes only what nothing follows any more: a node watched by hand keeps its pair');
    warm.onChange(finished.id, { origin: 'remote' });
    await warm.refresh(); // announced and closed, the rule lets it go now, and the prune with it
    await settle();
    assert.equal(warmBanners.length, 1, 'and not again');
    // A watched task whose subscribe fails keeps its stored pair: the watch rule still follows it and retries, and a
    // prune by `subscribed` alone left that retry nothing to compare with, so the completion went unannounced.
    // Its own instance: warm holds the pairs in memory from before this task existed, and has spent a catch-up banner.
    const flaky = task('Send the invoice', 'closed');
    const graphWarm = runtime.client.graph.listNodes, subscribeBefore = runtime.client.sync.subscribe;
    runtime.client.graph.listNodes = async (p) => (p.createdBy
      ? { nodes: [...(await graphWarm(p)).nodes, { id: flaky.id, assignedTo: [COLLEAGUE], state: { type: 'closed' } }] }
      : graphWarm(p));
    let flakyTries = 0;
    runtime.client.sync.subscribe = async (id) => {
      if (id === flaky.id && ++flakyTries === 1) throw new Error('connection reset'); // the first try only
      return subscribeBefore(id);
    };
    const retry = mainHelpers(); retry.testRuntime(runtime);
    const retryBanners = []; retry.S.notify = (id, title, body) => retryBanners.push([id, body]);
    await retry.refresh();
    await settle();
    assert.equal(flakyTries, 1, 'the watch rule tried to subscribe it, and that failed');
    assert.deepEqual(kept(flaky.id), [flaky.id], 'a task the watch rule follows keeps its stored pair when its subscribe fails');
    await retry.refresh();
    retry.onChange(flaky.id, { origin: 'remote' }); // the retry's bootstrap
    await settle();
    assert.equal(flakyTries, 2, 'the next refresh subscribes it again');
    assert.deepEqual(retryBanners, [[flaky.id, 'Now Completed by Sam Rivera']],
      'and the completion made while the app was closed is announced once that subscribe works');
    runtime.client.sync.subscribe = subscribeBefore;
    runtime.client.graph.listNodes = graphBefore;
    // Another tab from the same user has a different nonce but the same user hash in its peer id.
    const ownPeer = '65536', otherOwnPeer = '65537', colleaguePeer = '131072';
    const remoteTask = new Document('tana:text:' + ulid(), { peerId: ownPeer });
    remoteTask.transact((l) => initDocument(l, 'Remote edits', ME, { kind: 'task' }));
    setAssignees(remoteTask, [], ME);
    docs.set(remoteTask.id, remoteTask); creators.set(remoteTask.id, ME);
    runtime.client.sync.peerId = ownPeer;
    const peerWatch = mainHelpers(); peerWatch.testRuntime(runtime);
    const peerNotified = []; peerWatch.S.notify = (id, title, body) => peerNotified.push([id, title, body]);
    peerWatch.onChange(remoteTask.id, { origin: 'remote' }); // baseline
    await settle();
    const editFromMyOtherTab = new Document(remoteTask.id, { peerId: otherOwnPeer });
    editFromMyOtherTab.loro.import(remoteTask.loro.export({ mode: 'snapshot' }));
    const beforeOwnEdit = remoteTask.loro.oplogVersion();
    setTitle(editFromMyOtherTab, 'My edit from another tab');
    remoteTask.applyRemote([editFromMyOtherTab.exportSince(beforeOwnEdit)]);
    peerWatch.onChange(remoteTask.id, { origin: 'remote' });
    await settle();
    assert.deepEqual(peerNotified, [], 'an edit from your other Tana tab stays quiet');
    const editFromColleague = new Document(remoteTask.id, { peerId: colleaguePeer });
    editFromColleague.loro.import(remoteTask.loro.export({ mode: 'snapshot' }));
    const beforeColleagueEdit = remoteTask.loro.oplogVersion();
    setTitle(editFromColleague, 'Sam’s edit');
    remoteTask.applyRemote([editFromColleague.exportSince(beforeColleagueEdit)]);
    peerWatch.onChange(remoteTask.id, { origin: 'remote' });
    await settle(peerWatch);
    assert.equal(peerNotified.length, 1, 'another user’s edit still announces');
    console.log('ok  watched-node edits from another tab by the same user stay quiet');
    console.log('ok  watching a node: the default is a task you made and did not keep, only remote changes announce, an explicit choice wins');
    console.log('ok  a status that moved while the app was closed is announced once on the way back, not replayed');
  }

  // New tasks in your Inbox (issue #133): announced unless you made them by hand. A mail agent writing through Tana's
  // MCP with your login is "you" to createdBy; the MCP chat the task was created in is what says otherwise.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const COLLEAGUE = 'tana:user-profile:01examplex0000000000000000';
    // a live query row (sdk/livequery.js): no creator, which the graph answers, and no creating chat, which the document does
    const task = (title, createdBy, createdInUri, msAgo = 60000) => ({ uri: 'tana:text:' + ulid(), title, createdAt: Date.now() - msAgo, createdBy, createdInUri });
    const rows = () => inbox.map(({ uri, title, createdAt }) => ({ uri, title, createdAt }));
    const MCP_CHAT = 'tana:chat:' + ulid(), MEETING_CHAT = 'tana:chat:' + ulid();
    const chats = new Map([[MCP_CHAT, { id: MCP_CHAT, title: 'MCP: Nedap Compliance', invocationContext: { intent: 'mcp' } }],
      [MEETING_CHAT, { id: MEETING_CHAT, title: 'Chat for Weekly', invocationContext: { intent: 'meeting' } }]]);
    let inbox = [task('Already there', ME, MCP_CHAT)];
    const notified = [];
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: () => {} } },
      client: {
        graph: { listNodes: async (p) => {
          if (p.nodeIds) return { nodes: p.nodeIds.map((id) => chats.get(id) || inbox.filter((n) => n.uri === id).map((n) => ({ id, createdBy: n.createdBy }))[0]).filter(Boolean) };
          if ((p.nodeTypes || []).includes('user-profile')) return { nodes: [{ id: COLLEAGUE, title: 'Rob Jansen', userProfile: {} }] };
          throw new Error('the Inbox is a live query, not a listing: ' + JSON.stringify(p));
        } },
        sync: { getDocument: () => null, subscribe: async (id) => ({ id, data: new Map([['createdInUri', (inbox.find((n) => n.uri === id) || {}).createdInUri]]) }) },
      } });
    backend.S.notify = (id, title, body) => notified.push([title, body]);
    await backend.announceNewInbox(rows());
    assert.deepEqual(notified, [], 'the first look is a baseline, whatever made what is already there');
    inbox = [...inbox, task('Complete InsiderLog items', ME, MCP_CHAT), task('Share the budget', ME, undefined),
      task('Review the contract', COLLEAGUE, undefined), task('Send the transcript', ME, MEETING_CHAT), task('Last month', COLLEAGUE, undefined, 40 * 24 * 60 * 60 * 1000)];
    await backend.announceNewInbox(rows());
    assert.deepEqual(notified, [
      ['Complete InsiderLog items', 'New in Inbox · Via MCP: Nedap Compliance'],
      ['Review the contract', 'New in Inbox · From Rob Jansen'],
      ["Send the transcript", "New in Inbox · From Tana's AI"],
    ], 'your agent, a colleague and Tana\'s AI are announced; what you made by hand and an old task back in the Inbox are not');
    await backend.announceNewInbox(rows());
    assert.equal(notified.length, 3, 'and each once');
    inbox = [...inbox, ...[1, 2, 3, 4].map((i) => task('Mail ' + i, COLLEAGUE, undefined))];
    await backend.announceNewInbox(rows());
    assert.equal(notified.length, 6, 'a burst is capped at three banners');
    console.log('ok  new Inbox tasks: announced when someone else, an MCP agent or Tana\'s AI made them; yours by hand stay quiet');
  }

  // The Timeline (issue #135): watched-node summaries others wrote and tasks others (or an MCP client, or Tana's AI)
  // put in your Inbox, one list, newest first, rebuilt from Tana on every read.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const COLLEAGUE = 'tana:user-profile:01exampley0000000000000000';
    cache.setSetting('hideMcp', true); // hides MCP chats from lists, not what agents did from the Timeline
    const ago = (ms) => new Date(Date.now() - ms).toISOString(), H = 36e5;
    const id = () => 'tana:text:' + ulid();
    const pinnedEditable = { id: id(), title: 'Pinned and editable', participants: { [ME]: { type: 'user', role: 'admin' } }, state: { type: 'open' } };
    const pinnedReadOnly = { id: id(), title: 'Pinned but read-only', participants: { [ME]: { type: 'user', role: 'viewer' } }, state: { type: 'open' } };
    const pinnedInherited = { id: id(), title: 'Pinned, access inherited', state: { type: 'open' } }; // no participants entry: editability unknown (#545)
    const completedOverdue = { id: id(), title: 'Completed yesterday', state: { type: 'open' } };
    const completedDoc = new Document(completedOverdue.id);
    completedDoc.transact((l) => initDocument(l, completedOverdue.title, ME, { kind: 'task' })); setState(completedDoc, 'closed', COLLEAGUE);
    const liveDocs = new Map([[completedOverdue.id, completedDoc]]);
    const pinMapUri = 'tana:pin-map:' + ulid(), today = new Date().toLocaleDateString('sv-SE');
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const profile = { data: { get: (key) => key === 'pinMapUri' ? pinMapUri : undefined } };
    const pinMap = { loro: { getMap: () => ({ toJSON: () => Object.fromEntries([[pinnedEditable, today], [pinnedReadOnly, today], [pinnedInherited, today], [completedOverdue, yesterday.toLocaleDateString('sv-SE')]].map(([n, datetime]) => [n.id, { pins: [{ type: 'plain', datetime }] }])) }) } };
    const watched = { id: id(), title: 'Contract renewal', createdBy: ME, createTime: ago(0.6 * H), assignedTo: [COLLEAGUE], state: { type: 'closed', enteredAt: ago(0.1 * H), changedBy: COLLEAGUE } };
    const kept = { id: id(), title: 'Mine to do', createdBy: ME, assignedTo: [ME], state: { type: 'open' } }; // assigned to you: not watched
    const MCP_CHAT = 'tana:chat:' + ulid(), AI_CHAT = 'tana:chat:' + ulid();
    // an agent writes with your login: its completion is yours on the node, and an approved proposal in its chat at that moment
    const byAgent = { id: id(), title: 'Order more canisters', createdBy: ME, assignedTo: [ME], state: { type: 'closed', enteredAt: ago(0.15 * H), changedBy: ME } };
    const doneThenEdited = { id: id(), title: 'Finished it myself', createdBy: ME, assignedTo: [ME], state: { type: 'closed', enteredAt: ago(2 * H), changedBy: ME } }; // the agent only edited it later
    const agentChat = { id: 'tana:chat:' + ulid(), title: 'MCP: Task Completion Status', invocationContext: { intent: 'mcp' }, chat: { proposals: [
      { proposedUri: id(), baseUri: byAgent.id, operation: 'update', status: 'approved', proposedAt: String(Date.parse(byAgent.state.enteredAt) + 1) },
      { proposedUri: id(), baseUri: doneThenEdited.id, operation: 'update', status: 'approved', proposedAt: String(Date.now() - 0.3 * H) }] } };
    const fromRob = { id: id(), title: 'Review the vendor contract', createdBy: COLLEAGUE, createTime: ago(2 * H) };
    const viaMcp = { id: id(), title: 'Answer Jules', createdBy: ME, createTime: ago(1 * H) };
    const viaMcpToo = { id: id(), title: 'Plan the pilot', createdBy: ME, createTime: ago(1.2 * H) }; // the same agent, just before: one entry
    const viaAi = { id: id(), title: 'Share the transcript', createdBy: ME, createTime: ago(30 * H) };
    const byHand = { id: id(), title: 'Typed it myself', createdBy: ME, createTime: ago(0.5 * H) };
    const old = { id: id(), title: 'Last month', createdBy: COLLEAGUE, createTime: ago(40 * 24 * H) };
    const person = (displayName, extra = {}) => ({ displayName, email: displayName.split(' ')[0].toLowerCase() + '@example.com', role: 'required', ...extra });
    const meeting = { id: 'tana:event:' + ulid(), title: 'Leadership sync ', /* a calendar's trailing space, drawn without it */ calendarEvent: { startTime: ago(3 * H), endTime: ago(2.5 * H), roster: [
      person('Me Myself', { identityUri: ME }), person('Board Room', { role: 'resource' }), person('Groenlo Room', { cutype: 'room' }), person('Ann Bakker'), person('Bo Smit'), person('Cas de Vries'), person('Dee Jansen'), person('Eva Mol')] } };
    const allDay = { id: 'tana:event:' + ulid(), title: 'Offsite', calendarEvent: { startTime: ago(6 * H), endTime: ago(-18 * H), allDay: true } };
    const going = { id: 'tana:event:' + ulid(), title: 'Board prep', calendarEvent: { startTime: ago(3.5 * H), endTime: ago(-1 * H), actionUrl: 'https://teams.example/join/1' } }; // still going: as it is
    const summed = { id: 'tana:event:' + ulid(), title: 'Weekly', calendarEvent: { startTime: ago(4.5 * H), endTime: ago(4 * H), summary: 'The roadmap was agreed.' } }; // Tana's summary on the event, wherever its write-up now lives
    // still to come today (a second from now, so the end of the day cannot overtake it), shown only once asked for below
    const soon = { id: 'tana:event:' + ulid(), title: 'Standup', calendarEvent: { startTime: new Date(Date.now() + 1000).toISOString(), endTime: new Date(Date.now() + 1000 + 15 * 6e4).toISOString(), roster: [person('Ann Bakker')], location: 'https://meet.example/abc; Room 5', actionUrl: 'https://teams.example/join/2' } };
    let meetingsAsked = null, soonToo = false;
    let liveDoc = null, callsLive = null; const sent = [], historyAsks = [], syncHeard = [];
    // the call Board prep owns (#recording): a recording under way, as Tana's call schema keeps it
    const CALL = 'tana:call:' + ulid(), callDoc = new Document(CALL);
    const recordingStatus = (status) => callDoc.transact((l) => { const m = l.getMap('recordings').setContainer('r1', new LoroMap()); m.set('recordingId', 'r1'); m.set('status', status); });
    recordingStatus('recording');
    const summaries = new Map([[watched.id, [
      { title: 'Task status changed to Completed', authors: [COLLEAGUE], endTime: ago(0.05 * H) }, // the same move the node's state already tells
      { title: 'Added the Q4 numbers from Rob', authors: [COLLEAGUE], endTime: ago(0.2 * H) },
      { title: 'Task status updated from Inbox to In Progress', authors: [COLLEAGUE], endTime: ago(4 * H) },
      { title: 'Renamed a heading', authors: [ME], endTime: ago(3 * H) }, // yours alone: not news
      { title: 'Contract renewal', description: 'Moved the deadline to Friday', authors: [ME, COLLEAGUE], endTime: ago(5 * H) }, // title repeats the node's
      { title: 'Ancient change', authors: [COLLEAGUE], endTime: ago(30 * 24 * H) },
    ]]]);
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } },
      client: {
        graph: {
          listNodes: async (p) => {
            if ((p.nodeTypes || []).includes('user-profile')) return { nodes: [{ id: COLLEAGUE, title: 'Rob Jansen', userProfile: {} }] };
            if (p.nodeIds && (p.nodeTypes || []).includes('chat')) return { nodes: [{ id: MCP_CHAT, title: 'MCP: Nedap Compliance', invocationContext: { intent: 'mcp' } }, { id: AI_CHAT, title: 'Chat for Weekly', invocationContext: { intent: 'meeting' } }].filter((c) => p.nodeIds.includes(c.id)) };
            if ((p.nodeTypes || []).includes('chat')) return { nodes: [agentChat] };
            if (p.nodeIds && (p.nodeTypes || []).includes('text')) return { nodes: [pinnedEditable, pinnedReadOnly, pinnedInherited, completedOverdue, byAgent, doneThenEdited].filter((n) => p.nodeIds.includes(n.id)) };
            if (p.nodeIds) return { nodes: [] };
            if ((p.nodeTypes || []).includes('event')) { meetingsAsked = p; return { nodes: [...(soonToo ? [soon] : []), going, meeting, summed, allDay] }; }
            if ((p.createdBy || []).includes(ME)) return { nodes: [watched, kept] };
            if ((p.assignedTo || []).includes(ME)) return { nodes: [byHand, viaMcp, viaMcpToo, fromRob, viaAi, old] };
            return { nodes: [] };
          },
          listEdges: async ({ fromNodeIds }) => ({ edges: [[viaMcp.id, MCP_CHAT], [viaMcpToo.id, MCP_CHAT], [viaAi.id, AI_CHAT]].filter(([f]) => fromNodeIds.includes(f)).map(([fromNodeId, toNodeId]) => ({ fromNodeId, toNodeId, type: 'EDGE_TYPE_CREATED_IN' })) }),
        },
        history: { listChanges: async ({ uri }) => { historyAsks.push(uri); return { summaries: summaries.get(uri) || [] }; } },
        sync: { getDocument: (uri) => liveDocs.get(uri) || null, unsubscribe: async () => {}, on: (event, fn) => syncHeard.push(fn),
          subscribe: async (uri, init) => {
            if (uri.startsWith('tana:liveQuery:')) { const d = new Document(uri); d.transact(init); if (d.data.toJSON().query.types.includes('call')) callsLive = d; else liveDoc = d; return d; }
            if (uri === CALL) { liveDocs.set(CALL, callDoc); return callDoc; }
            return uri === ME ? profile : uri === pinMapUri ? pinMap : null;
          } },
      } });
    // through JSON: rows are built in the main-process vm, whose arrays fail a deep compare on their prototype alone
    const read = async () => JSON.parse(JSON.stringify((await backend.timelinePage.rows()).map((r) => [r.text, r.timeline.change || r.timeline.note, r.icon || null, r.timeline.tone, r.unread, r.children.map((c) => c.text)])));
    assert.deepEqual(await read(), [
      ["Today's Tasks", null, 'todayTasks', 'new', false, ['Pinned and editable', 'Pinned but read-only', 'Pinned, access inherited']],
      ['Rob Jansen completed Contract renewal', null, 'apply', 'done', false, []],
      ['An AI agent completed Order more canisters', null, 'apply', 'done', false, []],
      ['Rob Jansen edited Contract renewal', 'Added the Q4 numbers from Rob', 'updated', 'edit', false, []],
      ['You added 2 tasks', null, 'tlNew', 'new', false, ['Typed it myself', 'Contract renewal']], // yours by hand, for you and for Rob: added, not put in your Inbox, and no news
      ['An AI agent added 2 tasks to your Inbox', null, 'robot', 'new', false, ['Answer Jules', 'Plan the pilot']],
      ['Rob Jansen added a task to your Inbox', null, 'tlNew', 'new', false, ['Review the vendor contract']],
      ['Leadership sync', '30 min', 'meeting', 'faint', false, []],
      ['Board prep', '4 h 30 min', 'meeting', 'meeting', false, []],
      ['Rob Jansen accepted Contract renewal', null, 'tlAccepted', 'accepted', false, []],
      ['Weekly', '30 min', 'meeting', 'meeting', false, []],
      ['Rob Jansen edited Contract renewal', 'Moved the deadline to Friday', 'updated', 'edit', false, []],
      ["Tana's AI added a task to your Inbox", null, 'tana', 'new', false, ['Share the transcript']],
    ], 'a timeline, newest first: who, then what they did, then the node; an edit\'s change quoted under it; new tasks from one source in a row are one quiet entry; a completion told once, from the node\'s own state; a meeting at its start time, quiet once it is over with no summary, all-day ones left out; what you added yourself told as yours; weeks old stays out');
    {
      // every pane asking at once: one build, and one after it for all who asked while it ran (#579)
      const g = backend.S.client.graph, edgesOf = g.listEdges; let builds = 0;
      g.listEdges = (p) => { builds++; return edgesOf(p); };
      const shared = await Promise.all([backend.timelinePage.rows(), backend.timelinePage.rows(), backend.timelinePage.rows()]);
      g.listEdges = edgesOf;
      assert.deepEqual([builds, shared[1] === shared[2], shared[0].length === shared[1].length], [2, true, true], 'three asks, two builds');
    }
    const sync = (await backend.timelinePage.rows()).find((r) => r.timeline.uri === meeting.id);
    assert.deepEqual(JSON.parse(JSON.stringify(sync.people)), ['Ann Bakker', 'Bo Smit', 'Cas de Vries', 'Dee Jansen', 'Eva Mol'].map((name) => ({ uri: name.split(' ')[0].toLowerCase() + '@example.com', name })),
      'a meeting\'s people ride beside its time for the faces, without you, its resources or its rooms');
    assert.deepEqual(JSON.parse(JSON.stringify([meetingsAsked.hasParticipantUris, Date.parse(meetingsAsked.eventStartTimeMax) === (() => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); })(), Date.parse(meetingsAsked.eventStartTimeMin) === (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 2); return d.getTime(); })()])), [[ME], true, true],
      'the meetings asked for are yours, from the start of the day before yesterday to the end of today');
    // Join: a meeting under way carries its call link, one that is over does not
    const joins = new Map((await backend.timelinePage.rows()).map((r) => [r.timeline.uri, r.join]));
    assert.deepEqual([joins.get(going.id), joins.get(meeting.id)], [going.id, undefined], 'a meeting under way is joined from Tana (its own id, opened there), one that is over is not');
    // Kept current (#210): the read left a live query open over your meetings; the server's answers re-read the page
    // when a meeting's title or time moves, or one comes or goes, and not when only something else about it changed
    const liveQuery = liveDoc.data.toJSON().query;
    assert.deepEqual(JSON.parse(JSON.stringify([liveQuery.types, liveQuery.hasParticipantUris, liveQuery.eventStartTimeMin === (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 2); return d.getTime(); })(), liveQuery.eventStartTimeMax > Date.now()])), [['event'], [ME], true, true],
      'the live query is your meetings from the start of the day before yesterday to the end of today');
    const answerLive = (rows, version) => liveDoc.transact((loro) => {
      const data = loro.getMap('data'), nodes = data.get('result').setContainer('nodes', new LoroList());
      for (const row of rows) nodes.push(row);
      data.set('state', 'ready'); data.set('resultForVersion', version);
    });
    const liveRow = (title, updatedAt) => ({ uri: meeting.id, type: 'event', title, calendarEvent: meeting.calendarEvent, updatedAt });
    const pageSends = () => sent.filter(([channel, id]) => channel === 'outline:changed' && id === 'orbital:timeline').length;
    answerLive([liveRow('Leadership sync', 1)], 1); answerLive([liveRow('Leadership sync', 2)], 2);
    assert.equal(pageSends(), 0, 'the first answer and an edit that moves nothing the page shows re-read nothing');
    answerLive([liveRow('Leadership offsite', 3)], 3);
    assert.equal(pageSends(), 1, 'a renamed meeting re-reads the page');
    answerLive([], 4);
    assert.equal(pageSends(), 2, 'and so does a meeting that is gone');
    // Recording: the read also asked for the calls the meetings under way own; a call recording now marks its meeting
    const callQuery = callsLive.data.toJSON().query;
    assert.deepEqual(JSON.parse(JSON.stringify([callQuery.types, callQuery.ownerUris])), [['call'], [going.id]], 'the calls asked for are the ones the meetings under way own');
    const recordingOf = async () => (await backend.timelinePage.rows()).find((r) => r.timeline.uri === going.id).timeline.recording === true;
    assert.equal(await recordingOf(), false, 'no call yet, nothing recording');
    callsLive.transact((loro) => { const data = loro.getMap('data'), nodes = data.get('result').setContainer('nodes', new LoroList()); nodes.push({ uri: CALL, type: 'call', ownerUri: going.id, updatedAt: 1 }); data.set('state', 'ready'); data.set('resultForVersion', 1); });
    await new Promise((r) => setImmediate(r));
    assert.equal(pageSends(), 3, 'a call that is recording re-reads the page');
    assert.equal(await recordingOf(), true, 'and its meeting is drawn recording');
    recordingStatus('processing'); for (const fn of syncHeard) fn(CALL);
    assert.equal(pageSends(), 4, 'the recording stopping re-reads it again');
    assert.equal(await recordingOf(), false, 'and the mark goes');
    // a Tana Meet call is transcribed, not video-recorded: somebody in it and on the record is what lights it
    callDoc.transact((l) => { const s = l.getMap('sessions').setContainer('s1', new LoroMap()); s.set('userUri', ME); s.set('joinedAt', 1); }); for (const fn of syncHeard) fn(CALL);
    assert.equal(await recordingOf(), true, 'a call somebody is in, being transcribed, marks its meeting');
    callDoc.transact((l) => l.getMap('data').set('transcriptionPaused', true)); for (const fn of syncHeard) fn(CALL);
    assert.equal(await recordingOf(), false, 'off the record, it does not');
    callDoc.transact((l) => { l.getMap('data').set('transcriptionPaused', false); l.getMap('sessions').delete('s1'); }); for (const fn of syncHeard) fn(CALL);
    assert.equal(await recordingOf(), false, 'nor once everyone has left');
    assert.deepEqual(JSON.parse(JSON.stringify((await backend.timelinePage.rows())[1].segments)), [{ text: 'Rob Jansen ', person: true }, { text: 'completed', marks: { bold: true } }, { text: ' ' }, { text: 'Contract renewal', content: true, marks: { strike: true } }],
      'the person plain, the verb bold, and a finished node struck through; demo mode masks the name and title and keeps the verb');
    const rows = await backend.timelinePage.rows();
    for (const [text, state] of [['Task status changed from In Progress to Inbox', 'proposed'], ['Task marked as completed and a note added', 'closed'], ['Task status updated to In Progress', 'open'], ['Added a document link', undefined]])
      assert.equal(backend.timelinePage.statusOf(text) || undefined, state, 'a summary says which state it went to: ' + text);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'a node changed twice is two rows with ids of their own');
    assert.equal(rows[1].timeline.uri, watched.id, 'and each row opens the node it is about');
    assert.equal(rows[5].timeline.uri, null, 'except a group, whose tasks open themselves');
    assert.deepEqual(JSON.parse(JSON.stringify(rows[0].children.map((c) => [c.editable, c.checkable]))), [[false, true], [false, false], [false, true]], 'timeline task text is read-only, and a box ticks unless the task is known read-only: unknown access ticks, as everywhere else (#545)');
    assert.deepEqual(JSON.parse(JSON.stringify(rows[5].children.map((c) => [c.editable, c.checkable]))), [[false, true], [false, true]], 'inbox task words are read-only there and their boxes tick');
    summaries.get(watched.id).push({ title: 'Signed by both parties', authors: [COLLEAGUE], endTime: ago(-1000) });
    const next = await read();
    assert.deepEqual(next.filter((r) => r[4]).map((r) => r[1]), ['Signed by both parties'], 'what came after your last visit is marked new, and only that');
    { // #536: an edit a banner announced shows though Tana wrote no summary of it; one a summary from then covers shows once
      const lone = id();
      backend.rememberEdit(lone, 'Quiet change'); backend.rememberEdit(watched.id, 'Contract renewal');
      const texts = (await read()).map((r) => r[0]);
      assert.equal(texts.filter((t) => t === 'Someone edited Quiet change').length, 1, 'the announced edit is on the Timeline, by Someone, as nobody here knows who');
      assert.equal(texts.filter((t) => t.endsWith('edited Contract renewal')).length, next.filter((r) => r[0].endsWith('edited Contract renewal')).length, 'and one Tana has summarised from around then is not told twice');
    }
    // Today's meetings still to come: a block of their own under Today's Tasks, earliest first, each saying when and who
    soonToo = true;
    const timersBefore = backend.timers.length;
    const withSoon = await backend.timelinePage.rows();
    // and when it starts it moves into the timeline on its own: a timer for just after its start reads the page again
    const due = backend.timers.slice(timersBefore).filter((t) => t.ms > 1000 && t.ms <= 2000);
    assert.equal(due.length, 1, 'a timer is set for a second after the next meeting starts');
    const sendsBefore = pageSends(); due[0].fn();
    assert.equal(pageSends(), sendsBefore + 1, 'and when it goes off the Timeline is read again, which moves the meeting out of Upcoming meetings');
    const hm = (ms) => { const d = new Date(ms); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); };
    assert.deepEqual(JSON.parse(JSON.stringify([withSoon[1].text, withSoon[1].timeline.time, withSoon[1].timeline.upcoming, withSoon[1].children.map((c) => [c.id, c.text, c.icon, c.subtext])])),
      ['Upcoming meetings', '', true, [[soon.id, 'Standup', 'meeting', hm(Date.parse(soon.calendarEvent.startTime)) + '–' + hm(Date.parse(soon.calendarEvent.endTime))]]],
      'a meeting later today sits under Upcoming meetings, after Today\'s Tasks, saying when and who');
    assert.deepEqual(JSON.parse(JSON.stringify(withSoon[1].children[0].people)), [{ uri: 'ann@example.com', name: 'Ann Bakker' }], 'and who, as faces');
    assert.equal(withSoon[1].children[0].join, soon.id, 'and is joined from Tana too');
    assert.ok(!withSoon.slice(2).some((r) => r.timeline.uri === soon.id), 'and not among what happened');
    soonToo = false;
    assert.ok(!(await backend.timelinePage.rows()).some((r) => r.timeline.upcoming), 'with none to come the block is not drawn');
    // Three days a page: four days back is not on the first one, and one page older brings it in
    summaries.get(watched.id).push({ title: 'Renamed the task', authors: [COLLEAGUE], endTime: ago(4 * 24 * H) });
    assert.ok(!(await read()).some((r) => r[1] === 'Renamed the task'), 'the Timeline opens on today and the two days before');
    assert.equal(backend.timelinePage.setPages(2), 2, 'three days older');
    assert.ok((await read()).some((r) => r[1] === 'Renamed the task'), 'brings the three days before it in');
    backend.timelinePage.setPages(1);
    // A node nobody has touched since the window opened is not asked for its history: that was most of the page's time
    watched.updateTime = ago(5 * 24 * H);
    historyAsks.length = 0; await read();
    assert.ok(!historyAsks.includes(watched.id), 'a watched node last updated before the window is not asked for its changes');
    watched.updateTime = ago(0.1 * H); historyAsks.length = 0; await read();
    assert.ok(historyAsks.includes(watched.id), 'and one updated inside it is');
    console.log('ok  timeline: what changed and what finished first, new Inbox tasks grouped and quiet, newest first, new since the last visit');
  }



  {
    // Every page asks for the Codex statuses on every refresh, and each read starts an app-server per host: the pages
    // asking while one read runs share it, and the next refresh reads afresh (issue #267).
    const backend = mainHelpers(); require('../db').open(':memory:');
    let reads = 0, finish;
    backend.agent.codexTasks = () => ({ 'tana:text:01examplea0000000000000000': 'thread' });
    backend.agent.readAgentStatuses = () => { reads++; return new Promise((done) => { finish = done; }); };
    const status = backend.handlers.get('codex:status');
    const left = status(), right = status();
    assert.equal(reads, 1, 'two pages asking at once start one read');
    finish({ n: 'working' });
    assert.deepEqual([(await left).n, (await right).n], ['working', 'working'], 'and both get its answer');
    status();
    assert.equal(reads, 2, 'a read that has settled is not reused: the next refresh asks again');
    finish({});
    console.log('ok  codex status: one read shared by every page asking at once');
  }
  // Handing a node to the local Codex agent: an app-local mark in the settings table, never a Tana assignee, and one
  // the view refresh's unsubscribe sweep is not allowed to drop.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const subscribed = [];
    const task = new Document('tana:text:' + ulid());
    task.transact((l) => initDocument(l, 'Draft the release notes', ME, { kind: 'task' }));
    const assigneesOf = () => (readNode(task).assignedToUris || []).join(',');
    const before = assigneesOf();
    backend.testRuntime({ me: { userUri: ME }, win: null,
      // only this one document exists: an id nothing answers for is how a write that cannot land is tested
      client: { sync: { getDocument: (id) => (id === task.id ? task : null),
        subscribe: async (id) => { if (id !== task.id) throw new Error('unavailable'); subscribed.push(id); return task; } } } });
    // the handlers answer from inside the vm, so their arrays are compared as text rather than by identity
    const assigned = async () => (await backend.handlers.get('codex:list')(null)).join(',');
    // Creating the task is a real app-server child; here it answers with an id, so the rest of the flow is checked.
    const created = [];
    backend.agent.createTask = async (opts) => { created.push(opts); return '01a0b379-afbc-74c3-a191-c419e6543bcc'; };
    assert.equal(await assigned(), '', 'nothing is handed to the agent to begin with');
    assert.equal(await backend.handlers.get('codex:set')(null, task.id, true), true);
    assert.equal(await assigned(), task.id, 'assigning stores the id');
    assert.equal((cache.setting('codex') || []).join(','), task.id, 'in the settings table, so it survives a restart');
    // The acceptance case: confirming an assignment hands the work over. Before this, assigning marked the node and
    // opened nothing, so the badge claimed a delegation that did not exist anywhere.
    // Created here and opened directly: the app's own workspace, the chosen model, and an id up front — so the
    // task is linked the moment it exists and Codex opens it without a trip through the browser.
    assert.equal(created.length, 1, 'assigning creates the task through the app-server');
    assert.equal(created[0].nodeUri, task.id, 'for this node');
    assert.notEqual(created[0].userData, undefined, 'in the app\'s own workspace, not the last project and not this repo');
    // Reported from a screenshot (#553): a folder per node made every task a project of its own in Codex.
    const dataDir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'orbital-ws-'));
    const ws = backend.agent.agentWorkspace(dataDir);
    assert.equal(ws, require('node:path').join(dataDir, 'agent-workspaces', 'Tana'), 'the workspace is one folder, named for Codex to list as Tana');
    assert.equal(fs.statSync(ws).isDirectory(), true, 'made on demand');
    assert.equal(backend.agent.agentWorkspace(dataDir, 'tana:chat:other'), ws, 'and every task shares it, whichever node it came from');
    fs.rmSync(dataDir, { recursive: true, force: true });
    // Reported from a screenshot: every task was called after this prompt's opening sentence, so the list read as a
    // column of identical names. The first line is the node's own title now, and Codex titles a task from it.
    assert.equal(String(created[0].prompt).split('\n')[0], 'Tana: Draft the release notes',
      'a task assigned from Cmd+K opens with its node title');
    // That title is text from the graph, so it is handled as data: one line, no control characters, capped without
    // splitting a character in half, and a node with no usable title still gets a name of its own.
    const firstLine = (t) => String(backend.agent.agentPrompt(task.id, '/repo', t)).split('\n')[0];
    assert.equal(firstLine('Create specific risk around network risk'), 'Tana: Create specific risk around network risk',
      'an ordinary title is carried through as it is');
    assert.equal(firstLine('  Two\nlines\tand\u0007a bell  '), 'Tana: Two lines and a bell',
      'newlines, tabs and control characters collapse into one readable line');
    assert.equal(firstLine('Café ☕ 🇳🇱 naïve'), 'Tana: Café ☕ 🇳🇱 naïve', 'and ordinary Unicode survives untouched');
    assert.equal([...firstLine('x'.repeat(200))].length, 'Tana: '.length + 81, 'an overlong title is capped, with an ellipsis for what was cut');
    assert.equal(firstLine('🙂'.repeat(200)), 'Tana: ' + '🙂'.repeat(80) + '…',
      'and the cap counts code points, so a cut never leaves half a character behind');
    assert.equal(firstLine('   '), 'Tana task', 'a node with no usable title is still named, rather than falling back to the old opening sentence');
    assert.equal(firstLine(undefined), 'Tana task', 'and so is one whose title could not be read at all');
    assert.equal(backend.opened.length, 1, 'and opens it');
    assert.equal(backend.opened[0], 'codex://threads/01a0b379-afbc-74c3-a191-c419e6543bcc', 'by id, directly');
    assert.equal(/chatgpt\.com/.test(backend.opened[0]), false, 'with no browser route for creation');
    assert.equal((await backend.handlers.get('codex:list')(null)).join(','), task.id, 'and the node is linked at once');
    assert.equal(assigneesOf(), before,
      'and the document is untouched: Tana assignees are user profiles, so an agent cannot be one');
    assert.equal(subscribed.join(','), task.id, 'an assigned node is subscribed at once, so changes to it keep arriving');
    // The prompt the agent was given rides along in a map of its own, so the id list every other reader walks is
    // unchanged. It is stored trimmed, and only ever beside an assignment.
    await backend.handlers.get('codex:set')(null, task.id, true, '  Draft the release notes\nthen tell me  ');
    assert.equal((cache.setting('codexPrompt') || {})[task.id], 'Draft the release notes\nthen tell me',
      'the prompt is stored under the node, trimmed at the ends and otherwise as typed');
    assert.equal(await assigned(), task.id, 'and the node is still assigned exactly once');
    // ...and it is written into the node itself, where somebody reading it in Tana can see what the agent was handed.
    const context = () => outline.readOutline(task).filter((n) => (n.text || '').trim() === 'Agent context');
    assert.equal(context().length, 1, 'one "Agent context" block is added to the document');
    assert.deepEqual(context()[0].children.map((n) => n.text), ['Draft the release notes', 'then tell me'],
      'with the prompt nested under it, one block per line and in the order it was typed');
    // Assigning again is the same decision made twice, not two contexts: the block is found by its title and rewritten.
    await backend.handlers.get('codex:set')(null, task.id, true, 'One line only\n\n  and a third  ');
    assert.equal(context().length, 1, 'reassigning reuses the block rather than adding a second one');
    assert.deepEqual(context()[0].children.map((n) => n.text), ['One line only', 'and a third'],
      'its children are replaced by the new prompt, and a blank line is not an empty row');
    // A document that cannot be written must leave nothing behind locally: a badge would claim a handoff the node
    // knows nothing about. The visible half goes first, so there is nothing to roll back.
    const unreachable = 'tana:text:' + ulid();
    await assert.rejects(() => backend.handlers.get('codex:set')(null, unreachable, true, 'Do the thing'),
      'a document that cannot take the context fails the assignment');
    assert.equal((await backend.handlers.get('codex:list')(null)).includes(unreachable), false, 'and is not marked as assigned');
    assert.equal((cache.setting('codexPrompt') || {})[unreachable], undefined, 'nor is its prompt kept');
    await backend.handlers.get('codex:set')(null, task.id, true);
    assert.equal(await assigned(), task.id, 'assigning twice is still one entry');
    assert.equal(await backend.handlers.get('codex:set')(null, task.id, false), false);
    assert.equal(await assigned(), '', 'unassigning takes it back out');
    assert.deepEqual(Object.keys(cache.setting('codexPrompt') || {}), [], 'and takes the prompt with it: the two are one decision');
    assert.equal(context().length, 1, 'but the context stays in the document: by then it is ordinary content somebody may have edited');
    // A handoff that cannot be opened is not a handoff: the call fails, so the renderer shows why rather than
    // drawing a badge for a task nobody opened.
    backend.electron.shell.refuse = true;
    await assert.rejects(() => backend.handlers.get('codex:set')(null, task.id, true, 'Try again'),
      'an assignment that cannot open Codex fails rather than claiming delegation');
    // ...and leaves no mark behind: the mark is a synced setting, so another machine and the next launch would show a
    // pending badge for a handoff the page that asked reported as failed.
    assert.equal(await assigned(), '', 'a failed handoff takes back the mark it made');
    assert.equal(backend.agent.codexTaskFor(task.id), null, 'and the task link');
    backend.electron.shell.refuse = false;
    // Unassigning opens nothing at all: it takes the assignment away and leaves the task and the context alone.
    const openedBefore = backend.opened.length;
    await backend.handlers.get('codex:set')(null, task.id, false);
    assert.equal(backend.opened.length, openedBefore, 'unassigning opens nothing');
    // The link goes with the assignment: a later one is a new task rather than a return to the old one. The Codex
    // task itself is untouched — nothing here archives or deletes it.
    assert.equal(backend.agent.codexTaskFor(task.id), null, 'and lets go of the task id');
    created.length = 0;
    await backend.handlers.get('codex:set')(null, task.id, true, 'Have another go');
    assert.equal(created.length, 1, 'so assigning again creates a fresh task rather than reopening the old one');
    // An assignment with nothing typed writes nothing into the document — there is no context to add.
    const beforeBlocks = outline.readOutline(task).length, beforeContext = context()[0].children.map((n) => n.text).join('|');
    await backend.handlers.get('codex:set')(null, task.id, true);
    assert.equal(outline.readOutline(task).length, beforeBlocks, 'assigning with no prompt leaves the document alone');
    assert.equal(context().length, 1, 'and adds no second heading of its own');
    assert.equal(context()[0].children.map((n) => n.text).join('|'), beforeContext, 'and does not touch the context already there');
    await backend.handlers.get('codex:set')(null, task.id, false);
    cache.setSetting('codex', 'nonsense'); // an older build or a bad write
    assert.equal(await assigned(), '', 'and an unreadable list is no assignment, not a crash');
    console.log('ok  local Codex assignment: stored in settings, off the document, subscribed while assigned');
  }

  // Linking a node to the Codex task that handles it. The task registers itself (scripts/agent-link.js reads
  // CODEX_THREAD_ID), so the only thing decided here is which url opens the work and what is said to it.
  {
    const agent = require('../main/agent'), cache = require('../db'); cache.open(':memory:');
    const NODE = 'tana:text:' + ulid(), THREAD = '01a0b355-2197-7311-b576-ff4bd9c8901e';
    const first = agent.handoff(NODE, 'Draft the release notes', '/repo');
    assert.equal(first.kind, 'create', 'a node with no task opens a new one');
    assert.equal(first.threadId, null, 'and has no id yet, which is what keeps it pending rather than delegated');
    // The supported external entry point, which the app translates into its own codex://threads/new route. Handing
    // it that internal route directly is what silently did nothing in the running app.
    const open = new URL(first.url);
    assert.equal(open.protocol, 'https:', 'a new task is opened through the https entry point');
    assert.equal(open.hostname, 'chatgpt.com');
    assert.equal(open.pathname, '/codex/open-app', 'the path the app actually listens on');
    const prompt = open.searchParams.get('q');
    assert.ok(prompt, 'with the prompt in q, the parameter that entry point reads');
    assert.match(prompt, /agent-link\.js --node tana:text:[0-9a-z]{26} --thread "\$CODEX_THREAD_ID"/,
      'whose first concrete action is the task registering itself, by the id its own shell carries');
    // "first action" is the claim, so the first command in the prompt is the one that has to be the callback:
    // comparing it only against the fetch would pass a prompt that asks for the work first and the link later.
    const commands = prompt.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('node '));
    assert.match(commands[0], /^node scripts\/agent-link\.js /, 'registering is the first thing the task is asked to run');
    assert.ok(prompt.includes('node uri: ' + NODE), 'then it fetches that exact node, by uri');
    assert.match(prompt, /through your Tana connection/, 'through the Tana connection it already has, choosing its own tool');
    assert.equal(/platform-cli/.test(prompt), false, 'and not through a local CLI: retrieval is the MCP\'s job');
    assert.match(prompt, /no Tana connection[\s\S]*say so and stop/, 'an unreachable Tana is reported, not worked around with this stale copy');
    assert.ok(prompt.includes('Agent context'), 'and is told that block is the work request');
    assert.equal(prompt.includes('tana:user-profile'), false, 'nothing else about the graph travels with it');
    // Once the task has registered itself, the same assignment reopens it and says what changed.
    assert.equal(agent.setCodexTask(NODE, THREAD), THREAD);
    assert.equal(agent.setCodexTask(NODE, THREAD), THREAD, 'registering twice is the same link, not a second one');
    const again = agent.handoff(NODE, 'Now also tell me when it ships', '/repo');
    assert.equal(again.kind, 'reuse', 'a linked node reopens its task');
    assert.equal(again.url, 'codex://threads/' + THREAD, 'by id, so no duplicate is created');
    assert.equal(again.queue, 'Now also tell me when it ships', 'and the current request is queued to it');
    assert.equal(agent.setCodexTask(NODE, 'not-a-thread-id'), null, 'a malformed id is no link');
    // and one that got into the settings some other way (an older build, a hand edit) is not trusted on the way out
    cache.setSetting('codexTask', { [NODE]: 'not-a-thread-id' });
    assert.equal(agent.codexTaskFor(NODE), null, 'a stored id that is not a thread id is no link either');
    assert.equal(agent.handoff(NODE, 'retry', '/repo').kind, 'create', 'so it opens a new task rather than a broken url');
    agent.setCodexTask(NODE, THREAD);
    agent.clearCodexTask(NODE);
    assert.equal(agent.codexTaskFor(NODE), null, 'a broken link is dropped');
    assert.equal(agent.handoff(NODE, 'retry', '/repo').kind, 'create', 'and the retry opens a new composer, replacing nothing until it registers');
    // A link let go of deliberately must not come back: recovery creates, it never resurrects.
    agent.setCodexTask(NODE, THREAD);
    agent.clearCodexTask(NODE);
    assert.equal(agent.codexTasks()[NODE], undefined, 'a cleared link leaves nothing behind in the map');
    assert.equal(agent.handoff(NODE, 'again', '/repo').threadId, null, 'so the next assignment carries no id from the old task');
    // Which machine holds the task travels with the id, because a thread's rollout only exists where it was made.
    // Machines are records the user adds, not names in the source. The local one is the only built-in.
    assert.deepEqual(agent.hosts().map((h) => h.id), ['local'], 'only this machine is built in');
    const added = agent.addHost({ title: 'Donut', ssh: 'donut.example.ts.net', bin: '/Users/someone/.local/bin/codex' });
    assert.match(added.id, /^h[a-z0-9]+$/, 'a new machine gets an opaque id of ours');
    assert.deepEqual(agent.hosts().map((h) => h.title), ['This Mac', 'Donut'], 'and joins the list the choosers read');
    assert.equal(agent.hostRecord(added.id).ssh, 'donut.example.ts.net', 'its address is kept in main, never in the renderer');
    for (const bad of [{ title: '', ssh: 'a', bin: '/x' }, { title: 'x', ssh: 'a b; rm -rf /', bin: '/x' }, { title: 'x', ssh: 'a', bin: 'codex' }, { title: 'x', ssh: 'a', bin: '/x; rm -rf /' }]) {
      assert.throws(() => agent.addHost(bad), 'a record that is not a name, a hostname and one absolute path is refused: ' + JSON.stringify(bad));
    }
    // Which machine travels with the id, because a thread's rollout only exists where it was made.
    agent.setCodexTask(NODE, THREAD, added.id);
    assert.deepEqual(agent.taskLink(NODE), { host: added.id, threadId: THREAD }, 'the host is stored beside the id');
    // Forgetting a machine leaves its tasks alone: the link keeps pointing at a host nobody knows, which is what
    // makes it read as unavailable rather than being run against this one.
    agent.removeHost(added.id);
    assert.equal(agent.hostRecord(added.id), null, 'a removed machine is unknown');
    assert.equal(agent.taskLink(NODE).host, added.id, 'but its tasks still say where they are, never "local"');
    assert.equal(agent.hostId(added.id), null, 'and nothing will run against it');
    // A mapping written before hosts existed is a task on this machine: that is where it was created.
    // …and the shapes an older build left behind, through the store the app reads (main/settings.js) rather than
    // past it: what is being tested is the shape, not who wrote it.
    require('../main/settings').set('codexTask', { [NODE]: THREAD });
    assert.deepEqual(agent.taskLink(NODE), { host: 'local', threadId: THREAD }, 'an old id-only mapping still works, as a laptop task');
    assert.equal(agent.codexTaskFor(NODE), THREAD, 'and still answers with its id');
    require('../main/settings').set('codexTask', { [NODE]: { host: 'local', threadId: 'not-a-thread' } });
    assert.equal(agent.taskLink(NODE), null, 'a malformed id is no link, whatever host it claims');
    console.log('ok  Codex task link: self-registration prompt, reuse by id, stale recovery');
  }

  // What the badge is allowed to say: the linked task's own status, one read for every linked node.
  {
    const agent = require('../main/agent');
    const thread = (id, status, flags) => ({ id, status: flags ? { type: status, activeFlags: flags } : { type: status } });
    const state = (status, flags, turn, live) => agent.agentState(status === null ? null : thread('t', status, flags), turn, live);
    assert.equal(state('active'), 'working', 'a running task is working');
    assert.equal(state('active', ['waitingOnApproval']), 'waiting', 'one waiting on approval is paused, not failed');
    assert.equal(state('active', ['waitingOnUserInput']), 'waiting', 'and so is one waiting on the user');
    // Both boundaries, from the live cases. The turns are the authority: the loaded flag proves nothing either way,
    // and asking the thread directly is impossible while the app holds it ("already has an active writer").
    assert.equal(state('idle', null, 'completed'), 'done', 'a task whose turn completed is finished');
    assert.equal(state('notLoaded', null, 'completed'), 'done', 'and being unloaded does not keep it spinning');
    assert.equal(state('notLoaded', null, 'inProgress'), 'working', 'a turn still running is still working, loaded or not');
    assert.equal(state('notLoaded', null, null), 'pending', 'and a task that exists but has never run is pending, never finished');
    assert.equal(state('idle', null, 'inProgress'), 'working', 'a quiet thread with a turn still running is working');
    assert.equal(state('idle', null, 'failed'), 'broken', 'a failed turn needs attention');
    // An interrupted turn is a run that was cut, not a task that broke: the launcher starts the bootstrap turn and
    // Codex takes the thread over, which records exactly this shape while the work carries on.
    assert.equal(state('notLoaded', null, 'interrupted'), 'working', 'an interrupted turn is a handover, not a failure');
    assert.equal(state('idle', null, null), 'pending', 'a task that has never run is pending, not finished');
    assert.equal(state('notLoaded', null, 'completed', { type: 'idle' }), 'done', 'not being loaded says nothing about the work, but a live idle answer does');
    assert.equal(state('systemError'), 'broken', 'a system error needs attention');
    assert.equal(state(null), 'broken', 'and an id the app cannot account for is a stale link, which is recoverable');
    // One thread/list for all of them, and the latest turn only for the quiet ones.
    const asked = [];
    const rpc = async (method, params) => {
      asked.push(method + (params.threadId ? ' ' + params.threadId : ''));
      if (method === 'thread/list') return { data: [thread('t-run', 'active'), thread('t-quiet', 'idle'), thread('t-err', 'systemError')] };
      assert.equal(params.limit, 1, 'the latest turn is one turn, not a page of them');
      return { data: [{ status: params.threadId === 't-quiet' ? 'completed' : 'failed' }] };
    };
    const links = { n1: 't-run', n2: 't-quiet', n3: 't-err', n4: 't-gone' };
    assert.deepEqual(await agent.agentStatuses(links, rpc), { n1: 'working', n2: 'done', n3: 'broken', n4: 'broken' },
      'every linked node is answered from one read');
    assert.deepEqual(asked, ['thread/list', 'thread/turns/list t-quiet'],
      'the turn call is made only where the thread is quiet: a running, failed or missing one already knows its state');
    assert.deepEqual(await agent.agentStatuses({}, async () => assert.fail('nothing linked, nothing asked')), {},
      'and with no linked nodes there is no read at all');
    // A reader that cannot answer — no app-server, a timeout — is red for everything, never a quiet green.
    const dead = async () => { throw new Error('timed out'); };
    assert.deepEqual(await agent.agentStatuses(links, dead), { n1: 'broken', n2: 'broken', n3: 'broken', n4: 'broken' },
      'an unreachable app-server needs attention rather than claiming anything finished');
    // A thread whose turns cannot be read is pending: it is there, but nothing says the work is done.
    const halfDead = async (method) => { if (method === 'thread/list') return { data: [thread('t-quiet', 'idle')] }; throw new Error('no turns'); };
    assert.deepEqual(await agent.agentStatuses({ n2: 't-quiet' }, halfDead), { n2: 'pending' }, 'an unreadable turn is not a completed one');
    // A link naming a machine the user has since forgotten is that machine's problem alone. Opening the connection
    // to an unknown host refuses outright, and refusing used to happen outside the try that turns a machine that is
    // away into 'unavailable' — so one forgotten host left every badge, on every machine, unanswered.
    const GONE = 'tana:text:01examplen0000000000000000', GONE_THREAD = '01a0b355-2197-7311-b576-ff4bd9c8901e';
    require('../main/settings').set('codexTask', { [GONE]: { host: 'h-forgotten', threadId: GONE_THREAD } });
    assert.deepEqual(await agent.readAgentStatuses({ [GONE]: GONE_THREAD }), { [GONE]: 'unavailable' },
      'a task on a machine the app no longer knows reads as unavailable, rather than taking every other badge down with it');
    console.log('ok  Agent badge state comes from the task: one read, quiet threads ask for their latest turn');
  }

  // The week node is a plain "Week <n> (<year>)" document beside the day nodes: ISO-8601 week numbers, created once
  // and reused by every other day in the same week.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const docs = new Map();
    const creators = new Map(), lagging = new Set(); let searchFails = false; // who made each document; made but not in the text index yet
    const sync = {
      subscribe: async (id, init) => { if (!docs.has(id)) { const d = new Document(id); if (init) d.transact(init); docs.set(id, d); creators.set(id, ME); } return docs.get(id); },
      getDocument: (id) => docs.get(id),
    };
    const titleOf = (d) => readNode(d).title || '';
    const listNodes = async (p) => {
      if (p.nodeIds) return { nodes: p.nodeIds.map((id) => docs.has(id) ? { id, title: titleOf(docs.get(id)) } : { id }) };
      if (searchFails) throw new Error('deadline exceeded');
      const q = String(p.textQuery || '').toLowerCase();
      return { nodes: [...docs.values()].filter((d) => titleOf(d).toLowerCase().includes(q) && !lagging.has(d.id) && (!p.createdBy || p.createdBy.includes(creators.get(d.id))))
        .map((d) => ({ id: d.id, title: titleOf(d) })) };
    };
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: () => {} } }, client: { sync, graph: { listNodes } } });

    assert.equal(backend.weekTitle(new Date(2026, 8, 14)), 'Week 38 (2026)', 'the Monday of week 38');
    assert.equal(backend.weekTitle(new Date(2026, 11, 31)), 'Week 53 (2026)', 'a December day belongs to the year holding its Thursday');
    assert.equal(backend.weekTitle(new Date(2027, 0, 1)), 'Week 53 (2026)', 'and so a new year can still open in the old one');
    assert.equal(backend.weekTitle(new Date(2027, 8, 14)), 'Week 37 (2027)', 'and the year in the title keeps next year apart from this one');
    // The day node's title: today, or N days on ("Add to Tomorrow" asks for 1), as a local YYYY-MM-DD.
    assert.match(backend.today(), /^\d{4}-\d{2}-\d{2}$/, 'the day node title is a local date');
    assert.equal(backend.today(), backend.today(0), 'no argument is the same as no offset');
    assert.equal(Date.parse(backend.today(1)) - Date.parse(backend.today()), 864e5, 'and an offset of one is the next day');

    const first = await backend.weekNode(new Date(2026, 8, 14));
    assert.equal(titleOf(docs.get(first.id)), 'Week 38 (2026)', 'the missing week node is created');
    const again = await backend.weekNode(new Date(2026, 8, 17));
    assert.equal(again.id, first.id, 'another day in the same week reuses it');
    assert.equal(docs.size, 1, 'and creates nothing');
    const next = await backend.weekNode(new Date(2026, 8, 21));
    assert.equal(titleOf(docs.get(next.id)), 'Week 39 (2026)', 'the next week gets its own node');
    assert.equal(docs.size, 2, 'and nothing else is created along the way');
    const nextYear = await backend.weekNode(new Date(2027, 8, 20)); // week 38 again, a year later
    assert.equal(titleOf(docs.get(nextYear.id)), 'Week 38 (2027)', 'and next year\'s week 38 is a node of its own');
    // demo mode asks for a lookup only (renderer/state.js readOnlyInDemo): the week that exists, and a refusal for one that does not
    assert.equal((await backend.weekNode(new Date(2026, 8, 16), true)).id, first.id, 'a lookup finds the existing week node');
    await assert.rejects(backend.weekNode(new Date(2028, 0, 12), true), /Demo mode is on/, 'and refuses a missing one');
    assert.equal(docs.size, 3, 'without creating it');
    // Yours only, and never a second one (#393): a colleague's node with the title is theirs; a search that fails is an
    // error, not "there is none"; and one made here a moment ago is found before the text index lists it.
    const theirs = new Document('tana:text:' + ulid()); theirs.transact((l) => initDocument(l, 'Week 40 (2026)', 'tana:user-profile:colleague'));
    docs.set(theirs.id, theirs); creators.set(theirs.id, 'tana:user-profile:colleague');
    const mine40 = await backend.weekNode(new Date(2026, 8, 28));
    assert.notEqual(mine40.id, theirs.id, 'a colleague\u2019s week node with the same title is not taken for yours');
    searchFails = true;
    const before = docs.size;
    await assert.rejects(backend.weekNode(new Date(2026, 9, 5)), /deadline exceeded/, 'a failed search fails the week node');
    await assert.rejects(backend.handlers.get('doc:todayNode')(null, '2026-10-05', false), /deadline exceeded/, 'and the day node');
    assert.equal(docs.size, before, 'and neither makes one');
    searchFails = false;
    const made = await backend.weekNode(new Date(2026, 9, 5));
    lagging.add(made.id); // not in the text index yet
    assert.equal((await backend.weekNode(new Date(2026, 9, 6))).id, made.id, 'a week node made moments ago is found before the index lists it');
    setTitle(docs.get(made.id), 'Holiday plans'); // renamed while still unindexed: no longer this week's node
    assert.notEqual((await backend.weekNode(new Date(2026, 9, 6))).id, made.id, 'but not once it has been renamed');
    console.log('ok  week node: one plain document per ISO week, reused by every day in it');
  }

  // Subscriptions, caches and stored filters around the refresh loop: a document opened on demand (zoom, pin, search
  // result) is not a view row, so the refresh must leave it subscribed; an answer the backend does not have yet must
  // not be cached as an answer; and one failing query must not take a whole view down.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const openId = 'tana:text:' + ulid(), taskId = 'tana:text:' + ulid(), spaceId = 'tana:space:' + ulid();
    const eventId = 'tana:event:' + ulid(), writeUpId = 'tana:text:' + ulid();
    const opened = new Document(openId); opened.transact((l) => initDocument(l, 'Opened from a pin', ME));
    const documents = new Map([[openId, opened]]);
    const unsubscribed = [], subscribedIds = [], queries = [];
    let tasks = [{ id: taskId, title: 'Task', state: { type: 'open' }, updateTime: '2026-09-13T10:00:00Z' }];
    // The shape of the reported bug: a task you created and handed to somebody else. No view lists it — Inbox and
    // Library are both about your own work — so before the watch query nothing ever subscribed it, and the other
    // person completing it reached onChange never and announced nothing.
    const delegatedId = 'tana:text:' + ulid(), OTHER_USER = 'tana:user-profile:01examplek0000000000000000';
    const delegated = new Document(delegatedId); delegated.transact((l) => initDocument(l, 'Talk to Peter', ME, { kind: 'task' }));
    documents.set(delegatedId, delegated);
    let watchedTasks = [{ id: delegatedId, title: 'Talk to Peter', state: { type: 'open' }, assignedTo: [OTHER_USER], createdBy: ME }];
    let writeUp = [], ownerQueries = 0;
    const movedEventId = 'tana:event:' + ulid(), movedId = 'tana:text:' + ulid(), MOVED = 'The one where we reset the conversation';
    const twiceEventId = 'tana:event:' + ulid(), TWICE = 'Weekly sync notes';
    const listNodes = async (p) => {
      if (p.ownerIds) { ownerQueries++; return { nodes: p.ownerIds[0] === eventId ? writeUp : [] }; }
      // a write-up moved into a space: its meeting owns it no longer, and only its title (the tagline) still points at it
      if (p.textQuery === TWICE) return { nodes: [{ id: 'tana:text:' + ulid(), title: TWICE }, { id: 'tana:text:' + ulid(), title: TWICE }] }; // a recurring meeting's name, twice
      if (p.textQuery === MOVED) return { nodes: [{ id: 'tana:text:' + ulid(), title: 'Sketched, but some other page', appearance: { imageUri: 'tana:image:x' } }, { id: movedId, title: MOVED, ownerUri: spaceId }] };
      if (p.nodeIds) return { nodes: p.nodeIds.map((id) => (id === eventId ? { id, calendarEvent: { tagline: 'Notes' } } : id === movedEventId ? { id, calendarEvent: { tagline: MOVED } } : id === twiceEventId ? { id, calendarEvent: { tagline: TWICE } } : { id, title: id === spaceId ? 'Deal' : 'Node', ...(id === spaceId ? { appearance: { hue: 200 } } : {}) })) };
      if (p.createdBy) return { nodes: watchedTasks }; // the watch query, which asks by maker rather than by view
      const [kind] = p.nodeTypes || [];
      if (kind === 'user-profile') return { nodes: [] };
      if (kind === 'event' || kind === 'type') return { nodes: [] };
      queries.push(p);
      return { nodes: tasks };
    };
    // This block is about subscriptions and caching around the refresh loop, not about one view's semantics, so it
    // names the view it refreshes: the fixture's task is In Progress, which the Inbox preset would filter out.
    backend.testRuntime({ me: { userUri: ME }, activeView: 'library', win: { isDestroyed: () => false, webContents: { send: () => {} } }, client: {
      sync: { subscribe: async (id) => { subscribedIds.push(id); return documents.get(id); }, getDocument: (id) => documents.get(id), unsubscribe: async (id) => { unsubscribed.push(id); } },
      graph: { listNodes, getOwnerChain: async () => ({ entries: [{ uri: spaceId }] }) },
    } });

    assert.equal((await backend.handlers.get('doc:info')(null, openId)).id, openId, 'a document can be opened without being listed');
    assert.equal(await backend.handlers.get('doc:create')(null, 'Title', { kind: 'constructor' }).then(() => null, (e) => e.message), 'Unsupported creation kind');
    await backend.refresh();
    assert.ok(cache.get(taskId), 'the refresh caches the listed task');
    assert.ok(subscribedIds.includes(delegatedId), 'a task you created and gave away is subscribed although no view lists it: without this the watch rule can never fire');
    assert.deepEqual(unsubscribed, [], 'the refresh leaves a document it never listed subscribed, with its live updates and undo history');
    const sections = await backend.handlers.get('outline:roots')();
    assert.equal(sections.map((s) => s.id).join(','), backend.VIEWS.map((s) => s.id).join(','));
    // the refresh above listed the view this block names, so that is the section holding a cached row
    assert.equal(sections.find((s) => s.id === 'library').nodes.length, 1, 'roots reads the view cache without another graph query');
    assert.equal(sections.find((s) => s.id === 'inbox').nodes.length, 0, 'and a view with nothing cached reads as empty rather than missing');
    tasks = [];
    await backend.handlers.get('view:list')(null, 'library', { types: ['meetings', 'tasks', 'docs'], states: null, assignee: 'anyone' });
    assert.deepEqual(unsubscribed, [taskId], 'a row that left the view is still unsubscribed');
    assert.equal(unsubscribed.includes(delegatedId), false, 'but a watched task is exempt from that sweep, whatever view is in front of you');
    // Assignment is the whole difference: the same task, taken back, is your own work to look at.
    watchedTasks = [{ ...watchedTasks[0], assignedTo: [ME] }];
    subscribedIds.length = 0; unsubscribed.length = 0;
    await backend.refresh();
    await backend.handlers.get('view:list')(null, 'library', { types: ['meetings', 'tasks', 'docs'], states: null, assignee: 'anyone' });
    assert.deepEqual(unsubscribed, [delegatedId], 'a task assigned back to you leaves the watch set, and with it the subscription');
    tasks = [{ id: taskId, title: 'Task', state: { type: 'open' }, updateTime: '2026-09-13T10:00:00Z' }];
    // Back to the view's own filter first. The explicit one above asks for kinds this fixture answers empty, and it
    // stays on S.activeFilter, so a refresh would re-ask that same empty query. What this case is about is a refresh
    // re-caching a task the graph has again — not whether a hand-written filter still matches it.
    await backend.handlers.get('view:list')(null, 'library');
    await backend.refresh();
    assert.ok(cache.get(taskId), 'a later refresh replaces the stale cache with a newly discovered task');

    queries.length = 0;
    assert.equal((await backend.handlers.get('search')(null, '#deal')).length, 0, 'a space sharing a type title is not a type filter');
    assert.deepEqual(queries, [], 'an unknown #type runs no query at all');

    // Tana writes a meeting's summary after the meeting: "none yet" is a state to re-check, not an answer to cache.
    assert.equal(await backend.handlers.get('doc:summaryUri')(null, eventId), null);
    writeUp = [{ id: writeUpId, title: 'Notes' }];
    assert.equal(await backend.handlers.get('doc:summaryUri')(null, eventId), writeUpId, 'a summary written after the first look is still found');
    const settled = ownerQueries;
    assert.equal(await backend.handlers.get('doc:summaryUri')(null, eventId), writeUpId);
    assert.equal(ownerQueries, settled, 'the write-up it did find is cached');
    assert.equal(await backend.handlers.get('doc:summaryUri')(null, movedEventId), movedId,
      'a write-up moved out of its meeting into a space is found by its title, the tagline, and a sketched page with another title is not it');
    assert.equal(await backend.handlers.get('doc:summaryUri')(null, twiceEventId), null, 'and with two pages of that title there is no telling which: none');

    cache.setSetting('viewFilter:inbox', { states: ['open', 'nonsense'], assignee: 'sam' });
    const stored = await backend.handlers.get('view:filter')(null, 'inbox');
    assert.equal(stored.states.join(','), 'proposed', 'a stored filter that is not a query falls back to the preset');
    assert.equal(stored.assignee, 'anyone');
    cache.setSetting('viewFilter:library', { types: ['tasks', 'wat'], states: [], assignee: 'anyone', text: 7 });
    const library = await backend.handlers.get('view:filter')(null, 'library');
    assert.equal(library.types.join(','), 'tasks', 'an unknown kind cannot keep the view throwing');
    assert.equal(library.states.join(','), 'proposed,open,closed,not_now');
    assert.equal(library.assignee, 'anyone');
    assert.equal(library.text, '');
    assert.equal(backend.statusSnapshot().error, null, 'none of this is an error to show');
    console.log('ok  refresh keeps on-demand subscriptions, survives a failing query, and caches only real answers');
  }

  // A wide list keeps its head live, not all of it. A subscription is a bootstrap RPC and a LoroDoc each, and every
  // bootstrap announces itself to the renderer, so a Library of several hundred rows used to open with a subscription
  // storm on the one sync connection: the page lagged and whatever you opened next waited behind it.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const { LIVE_ROWS } = require('../main/state');
    const rows = Array.from({ length: LIVE_ROWS + 50 }, (_, i) => ({ id: 'tana:text:' + ulid(), title: 'Row ' + i, updateTime: '2026-09-13T10:00:00Z' }));
    const subscribedIds = [], unsubscribed = [];
    backend.testRuntime({ me: { userUri: ME }, activeView: 'library', win: null, client: {
      sync: { subscribe: async (id) => { subscribedIds.push(id); return null; }, getDocument: () => null, unsubscribe: async (id) => { unsubscribed.push(id); } },
      graph: { listNodes: async (p) => (p.nodeIds || (p.nodeTypes || []).some((k) => k !== 'text') ? { nodes: [] } : { nodes: rows }) },
    } });
    const listed = await backend.handlers.get('view:list')(null, 'library', { types: ['tasks', 'docs'], states: null, assignee: 'anyone' });
    assert.equal(listed.nodes.length, rows.length, 'every row is still listed, cached and drawn');
    // the view's own live query is a subscription too (watchViews, #148); the rows are what this counts
    assert.equal(subscribedIds.filter((id) => !id.startsWith('tana:liveQuery:')).length, LIVE_ROWS, 'but only the head of the list is subscribed');
    assert.equal(subscribedIds.filter((id) => id.startsWith('tana:liveQuery:')).length, 1, 'and the view gets its live query as it is read');
    assert.deepEqual([subscribedIds.includes(rows[0].id), subscribedIds.includes(rows.at(-1).id)], [true, false],
      'the rows at the top are the live ones; the tail rides the next refresh like the rest of the list');
    // And the cap is a set the sweep agrees with: a row that drops out of the head is let go on the next list.
    rows.unshift({ id: 'tana:text:' + ulid(), title: 'Newest', updateTime: '2026-09-14T10:00:00Z' });
    const pushedOut = rows[LIVE_ROWS].id;
    await backend.handlers.get('view:list')(null, 'library', { types: ['tasks', 'docs'], states: null, assignee: 'anyone' });
    assert.deepEqual(unsubscribed, [pushedOut], 'a row pushed past the cap is unsubscribed, so the live set stays bounded');
    console.log('ok  a wide view subscribes the head of its list, not every row in it');
  }

  // A document that joins a view (created, moved or reassigned, here or anywhere) moves that view's live query; main
  // answers with a refresh and the global outline:changed(null), which reloads every page's lists. The renderer counts
  // on this: it no longer reloads every list for each changed document no list shows yet (renderer/app.js patchDoc).
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const rows = [{ id: 'tana:text:' + ulid(), title: 'Listed', updateTime: '2026-09-13T10:00:00Z' }];
    const joined = { id: 'tana:text:' + ulid(), title: 'Joined', updateTime: '2026-09-14T10:00:00Z' };
    const live = [], sent = [];
    backend.testRuntime({ me: { userUri: ME }, activeView: 'library', win: { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }, client: {
      sync: { subscribe: async (id, init) => { if (!init) return null; const d = new Document(id); d.transact(init); live.push(d); return d; }, getDocument: () => null, unsubscribe: async () => {} },
      graph: { listNodes: async (p) => (p.nodeIds || p.createdBy || (p.nodeTypes || []).some((k) => k !== 'text') ? { nodes: [] } : { nodes: rows }) },
    } });
    await backend.handlers.get('view:list')(null, 'library', { types: ['tasks', 'docs'], states: null, assignee: 'anyone' });
    await new Promise(setImmediate);
    assert.equal(live.length, 1, 'the view is read with its live query');
    rows.unshift(joined);
    const before = backend.timers.length;
    live[0].transact((loro) => { const data = loro.getMap('data'), nodes = data.get('result').setContainer('nodes', new LoroList()); nodes.push({ uri: joined.id, title: joined.title }); data.set('state', 'ready'); data.set('resultForVersion', 1); });
    const due = backend.timers.slice(before).filter((t) => t.ms === 500); // main lets a burst of answers settle first
    assert.equal(due.length, 1, 'its answer schedules one refresh');
    await due[0].fn();
    assert.ok(sent.some(([channel, id]) => channel === 'outline:changed' && id === null), 'its answer refreshes the lists and tells every page');
    assert.ok(cache.get(joined.id), 'with the row that joined in them');
    console.log('ok  a document joining a view reaches every page as the global refresh');
  }

  // Reads subscribe too — a zoom, doc:info, each row's doc:taskMeta as it scrolls into view — and they used to hold
  // their documents for the session: a long list scrolled once stayed subscribed for good, and was bootstrapped again
  // on every reconnect (issue #269). The refresh lets go of the oldest reads past LIVE_ROWS, and never of the page on
  // screen or of a document an undo step still points at.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const { LIVE_ROWS } = require('../main/state');
    const docs = new Map(), unsubscribed = [];
    const make = (title) => { const d = new Document('tana:text:' + ulid()); d.transact((l) => initDocument(l, title, ME)); docs.set(d.id, d); return d.id; };
    const onScreen = make('On screen'), edited = make('Edited');
    // a saved search open in the other half: its page keeps the head of its rows live (main/related.js searchChildren)
    const hits = Array.from({ length: 5 }, (_, i) => make('Hit ' + i));
    const search = new Document('tana:search:' + ulid());
    search.transact((l) => initDocument(l, 'Hits', ME, { kind: 'search', query: { types: ['text'], textQuery: 'hits' } }));
    docs.set(search.id, search);
    const read = Array.from({ length: LIVE_ROWS + 20 }, (_, i) => make('Row ' + i));
    const told = []; // what the pages hear: the ids main let go of (#389)
    backend.testRuntime({ me: { userUri: ME }, activeView: 'library', win: { isDestroyed: () => false, webContents: { send: (channel, ids) => { if (channel === 'outline:released') told.push(...ids); } } }, client: {
      sync: { subscribe: async (id, init) => { if (init) { const d = new Document(id); d.transact(init); return d; } return docs.get(id) || null; },
        getDocument: (id) => docs.get(id), unsubscribe: async (id) => { unsubscribed.push(id); } },
      graph: { listNodes: async (p) => ({ nodes: p.nodeIds ? p.nodeIds.map((id) => ({ id })) : p.textQuery === 'hits' ? hits.map((id) => ({ id, title: 'Hit' })) : [] }) },
    } });
    await backend.handlers.get('doc:info')(null, onScreen);
    assert.equal(await backend.watchRelated(onScreen), true, 'the page on screen, with its sidebar watched');
    assert.equal((await backend.handlers.get('outline:children')(null, search.id)).length, hits.length);
    assert.equal(await backend.watchRelated(search.id, 'right'), true, 'and a saved search in the other half');
    await new Promise(setImmediate);
    await backend.handlers.get('doc:setTitle')(null, edited, 'Edited again');
    for (const id of read) await backend.handlers.get('doc:info')(null, id);
    await backend.handlers.get('doc:info')(null, read[0]); // read again: the newest read now, not the oldest
    await backend.handlers.get('view:list')(null, 'library');
    const released = () => unsubscribed.filter((id) => !id.startsWith('tana:liveQuery:'));
    assert.deepEqual(released(), read.slice(1, 29), 'the oldest reads past LIVE_ROWS are let go, oldest first');
    assert.deepEqual(told, read.slice(1, 29), 'and the pages are told which, so none keeps an outline that hears no more changes');
    assert.deepEqual([released().includes(onScreen), released().includes(edited), released().includes(search.id), hits.some((id) => released().includes(id))], [false, false, false, false],
      'but not the page on screen, a document with an undo step, or a saved search on screen and the head of its rows');
    await backend.handlers.get('view:list')(null, 'library');
    assert.equal(released().length, 28, 'and at the cap the next refresh lets go of nothing more');
    await backend.watchRelated(null, 'right'); // the search's half moves on
    for (let i = 0; i <= hits.length; i++) await backend.handlers.get('doc:info')(null, make('Newer ' + i)); // newer reads
    await backend.handlers.get('view:list')(null, 'library');
    assert.deepEqual(released().slice(28).sort(), [search.id, ...hits].sort(), 'off screen, the search and its rows are reads like any other, and the oldest now');
    console.log('ok  reads past LIVE_ROWS are let go oldest first, never the page on screen or an undoable one');
  }

  // A row's audience (#461): the owners doc:taskMeta reads are reads on demand, let go like any other, and the answer
  // carries four people and a count, never the organization's whole membership per row.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const { LIVE_ROWS } = require('../main/state');
    const docs = new Map(), unsubscribed = [];
    const make = (title) => { const d = new Document('tana:text:' + ulid()); d.transact((l) => initDocument(l, title, ME)); docs.set(d.id, d); return d.id; };
    const org = new Document('tana:org:' + ulid()), people = [ME, ...Array.from({ length: 5 }, () => 'tana:user-profile:' + ulid())];
    org.transact((l) => l.getMap('data').set('memberUserProfileDocUris', Object.fromEntries(people.map((uri, i) => ['m' + i, uri]))));
    docs.set(org.id, org);
    const row = make('Everyone sees it');
    docs.get(row).transact((l) => l.getMap('data').delete('restricted')); // inherits: the organization is its boundary
    backend.testRuntime({ me: { userUri: ME }, activeView: 'library', win: null, client: {
      sync: { subscribe: async (id) => docs.get(id) || null, getDocument: (id) => docs.get(id), unsubscribe: async (id) => { unsubscribed.push(id); } },
      graph: { listNodes: async (p) => ({ nodes: p.nodeIds ? p.nodeIds.map((id) => ({ id })) : [] }),
        getOwnerChain: async () => ({ entries: [{ uri: row, restricted: false, accessible: true }, { uri: org.id, restricted: true, accessible: true }], effectivelyRestricted: true }) },
    } });
    const asked = backend.handlers.get('doc:taskMeta')(null, row);
    while (!backend.timers.length) await new Promise(setImmediate); // the link-share lookup is batched on a timer, run here by hand
    backend.timers.shift().fn();
    const meta = await asked;
    assert.deepEqual([meta.audience, meta.people.length, meta.people.every((uri) => people.includes(uri)), meta.peopleCount], ['everyone', 4, true, 6], 'four people and how many');
    for (let i = 0; i <= LIVE_ROWS; i++) await backend.handlers.get('doc:info')(null, make('Row ' + i));
    await backend.handlers.get('view:list')(null, 'library');
    assert.ok(unsubscribed.includes(org.id), 'the organization it read is let go with the older reads');
    console.log('ok  a row\'s audience: four people and a count, and the owners it read are reads on demand');
  }

  // A change to what the rows are built from — a type's icon or colour — refreshes after it. A refresh already running
  // may have built its rows before the change, and answering the change with that run left the old icon in the cache
  // the page then reloads from (#390).
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const TYPE = 'tana:type:' + ulid(), row = { id: 'tana:text:' + ulid(), title: 'Typed', entityType: TYPE, updateTime: '2026-09-26T10:00:00Z' };
    let hold = null, counting = null;
    backend.testRuntime({ me: { userUri: ME }, activeView: 'library', win: null, client: {
      sync: { subscribe: async (id, init) => { if (!init) return null; const d = new Document(id); d.transact(init); return d; }, getDocument: () => undefined, unsubscribe: async () => {} },
      graph: { listNodes: async (p) => {
        if (p.limit === 1 && !p.nodeIds) { if (hold) { const wait = hold; hold = null; counting(); await wait; } return { totalCount: 0, nodes: [] }; } // the badge: the refresh's last read
        return { nodes: p.nodeIds ? [] : [row] };
      }, listEdges: async () => ({ edges: [] }) },
    } });
    backend.S.badge = () => {}; // as main.js sets it at launch
    await backend.handlers.get('view:list')(null, 'library');
    let release; hold = new Promise((resolve) => { release = resolve; });
    const counted = new Promise((resolve) => { counting = resolve; });
    const running = backend.refresh(); // a refresh that has built its rows and waits on the badge
    await counted;
    const chosen = backend.handlers.get('icons:setType')(null, TYPE, 'nc-rocket');
    release();
    await running; await chosen;
    assert.equal(cache.get(row.id).icon, 'nc-rocket', 'an icon chosen while a refresh runs is on the cached rows once the choice is answered');
    console.log('ok  a change to what rows are built from refreshes after itself, not with the run already under way');
  }

  // The sidebar read (related) subscribes the page and its hub — a write-up's meeting, a space itself — which nothing
  // else reads: those are reads too, let go past LIVE_ROWS, or every meeting and space opened stayed live (#395).
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const { LIVE_ROWS } = require('../main/state');
    const docs = new Map(), unsubscribed = [];
    const add = (id, title) => { const d = new Document(id); d.transact((l) => initDocument(l, title, ME)); docs.set(id, d); return id; };
    const space = add('tana:space:' + ulid(), 'A space'), meeting = add('tana:event:' + ulid(), 'A meeting');
    const writeUp = add('tana:text:' + ulid(), 'Notes');
    const read = Array.from({ length: LIVE_ROWS + 5 }, (_, i) => add('tana:text:' + ulid(), 'Row ' + i));
    const node = (id) => ({ id, title: readNode(docs.get(id)).title, ...(id === writeUp ? { ownerUri: meeting } : {}) });
    backend.testRuntime({ me: { userUri: ME }, activeView: 'library', win: null, client: {
      sync: { subscribe: async (id) => docs.get(id) || null, getDocument: (id) => docs.get(id), unsubscribe: async (id) => { unsubscribed.push(id); } },
      graph: { listNodes: async (p) => ({ nodes: (p.nodeIds || []).filter((id) => docs.has(id)).map(node) }), listEdges: async () => ({ edges: [] }), getOwnerChain: async () => ({ entries: [] }) },
    } });
    await backend.handlers.get('doc:related')(null, space);
    await backend.handlers.get('doc:related')(null, writeUp);
    for (const id of read) await backend.handlers.get('doc:info')(null, id);
    await backend.handlers.get('view:list')(null, 'library');
    assert.deepEqual([space, meeting].map((id) => unsubscribed.includes(id)), [true, true], 'a space and a write-up\u2019s meeting read by the sidebar are let go with the oldest reads');
    console.log('ok  the sidebar\'s reads of a page and its meeting or space are let go past LIVE_ROWS');
  }

  // A read in flight holds its document. The refresh sweep lets go of the rows a view no longer lists, and letting go
  // of a bootstrap somebody is waiting for rejects it as 'unsubscribed <id>' under the reader — which is exactly what
  // a doc:info for a row of the view you just left reported, in red, whenever a view change raced it.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const eventId = 'tana:event:' + ulid();
    const doc = new Document(eventId); doc.transact((l) => initDocument(l, 'Leadership sync', ME, { kind: 'meeting' }));
    const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
    let bootstrap = deferred();
    const unsubscribed = [];
    let rows = [{ id: eventId, title: 'Leadership sync', calendarEvent: { startTime: '2026-09-14T10:00:00Z' }, updateTime: '2026-09-13T10:00:00Z' }];
    const sync = {
      subscribe: (id) => (id === eventId ? bootstrap.promise : Promise.resolve(null)),
      getDocument: () => null,
      // the real one (sdk/sync.js): unsubscribing rejects a bootstrap that has not landed yet
      unsubscribe: async (id) => { unsubscribed.push(id); if (id === eventId) bootstrap.reject(new Error('unsubscribed ' + id)); },
    };
    backend.testRuntime({ me: { userUri: ME }, win: null, activeView: 'library', client: { sync, graph: { listNodes: async (p) => (p.nodeIds ? { nodes: [] } : { nodes: rows }) } } });
    await backend.handlers.get('view:list')(null, 'library'); // the meeting is a row here, so the refresh follows it
    const reading = backend.handlers.get('doc:info')(null, eventId); // opened while its bootstrap is still in flight
    await Promise.resolve();
    rows = [];
    await backend.handlers.get('view:list')(null, 'library'); // …and the view it was listed in is left
    assert.deepEqual(unsubscribed, [], 'a document a read is waiting for is not swept out from under it');
    bootstrap.resolve(doc);
    assert.equal((await reading).title, 'Leadership sync', 'so the read answers instead of failing as unsubscribed');
    assert.equal(backend.statusSnapshot().error, null, 'and nothing red is shown');
    bootstrap = deferred(); bootstrap.resolve(doc); // the read is over: the next sweep is free to let go
    await backend.handlers.get('view:list')(null, 'library');
    assert.deepEqual(unsubscribed, [eventId], 'once it has answered, the row leaves the subscription set as before');
    console.log('ok  a document being read is held through a view change, and let go on the next one');
  }

  // Checking a task is what takes it off the Tasks list, and the refresh that follows used to unsubscribe it: the
  // Document went with it, and its Loro undo history with that, so Cmd+Z could not uncheck the task and silently
  // undid an older step in another document instead.
  {
    // Text a page has just typed comes back to it as a change like any other, and used to cost that page a re-read and
    // a rebuild on every save. The typing page hears it as its own; the other half of a split hears it as before, and
    // a write the page did not mark as typed (Cmd+K, a slash command) is nobody's own (#265).
    const backend = mainHelpers(); require('../db').open(':memory:');
    const id = 'tana:text:' + ulid(), doc = new Document(id);
    doc.transact((l) => initDocument(l, 'Page', ME));
    doc.on('change', (info) => backend.onChange(id, info));
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: () => {} } }, client: {
      sync: { subscribe: async () => doc, getDocument: () => doc }, graph: { listNodes: async () => ({ nodes: [] }), getOwnerChain: async () => ({ entries: [] }) },
    } });
    const heard = [], pane = (name) => ({ frame: {}, isDestroyed: () => false, send: (channel, docId, info) => { if (channel === 'outline:changed' && docId === id) heard.push([name, info && info.own === true]); } });
    const left = pane('left'), right = pane('right');
    backend.S.windows.add({ isDestroyed: () => false, panes: [left, right] });
    const setTitle = backend.handlers.get('doc:setTitle');
    await setTitle({ senderFrame: left.frame }, id, 'Typed on the left', true);
    assert.deepEqual(heard, [['left', true], ['right', false]], 'the page that typed it hears its own echo; the other half is told as before');
    heard.length = 0;
    await setTitle({ senderFrame: left.frame }, id, 'From Cmd+K');
    assert.deepEqual(heard, [['left', false], ['right', false]], 'a write not marked as typed is nobody\'s own');
    heard.length = 0;
    await assert.rejects(backend.handlers.get('block:setText')({ senderFrame: right.frame }, id, 'no-such-row', 'x', true));
    assert.equal(backend.S.writer, null, 'a write that fails leaves no writer behind');
    doc.transact((l) => l.getMap('data').set('title', 'Edited elsewhere'));
    assert.deepEqual(heard, [['left', false], ['right', false]], 'so the next change, from anywhere, is nobody\'s own either');
    backend.S.windows.clear();
    console.log('ok  typed text: the typing page hears its own echo, every other page the change');
  }
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const taskId = 'tana:text:' + ulid(), otherId = 'tana:text:' + ulid();
    const task = new Document(taskId); task.transact((l) => { initDocument(l, 'Task', ME); l.getMap('data').set('stateType', 'open'); });
    const other = new Document(otherId); other.transact((l) => initDocument(l, 'Other', ME));
    const documents = new Map([[taskId, task], [otherId, other]]);
    const unsubscribed = [];
    let tasks = [{ id: taskId, title: 'Task', state: { type: 'open' }, updateTime: '2026-09-14T10:00:00Z' }];
    const listNodes = async (p) => {
      const [kind] = p.nodeTypes || [];
      return { nodes: kind && kind !== 'text' ? [] : tasks };
    };
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: () => {} } }, client: {
      sync: { subscribe: async (id) => documents.get(id), getDocument: (id) => documents.get(id), unsubscribe: async (id) => { unsubscribed.push(id); } },
      graph: { listNodes, getOwnerChain: async () => ({ entries: [] }) },
    } });
    await backend.refresh();
    await backend.handlers.get('doc:setTitle')(null, otherId, 'Edited elsewhere'); // the older step, on another document
    await backend.handlers.get('doc:setDone')(null, taskId, true);
    assert.equal(readNode(task).stateType, 'closed', 'checking the task closes it');
    tasks = [];
    await backend.refresh(); // the closed task is no longer one of the rows the view lists
    assert.deepEqual(unsubscribed, [], 'a document the undo history still needs keeps its subscription when it leaves the view');
    assert.equal(await backend.undo(), taskId, 'so undo reaches the checkbox step');
    assert.equal(readNode(task).stateType, 'open', 'and unchecks the task');
    assert.equal(readNode(other).title, 'Edited elsewhere', 'rather than silently undoing an older step somewhere else');
    assert.equal(await backend.redo(), taskId, 'redo checks it again');
    assert.equal(readNode(task).stateType, 'closed');
    assert.equal(await backend.undo(), taskId, 'and undo takes it back off');
    assert.equal(await backend.undo(), otherId, 'only then does the history move on to the older step');
    assert.equal(readNode(other).title, 'Other');
    console.log('ok  a checked task keeps its undo history when it leaves the list');
  }

  // Hidden titles: one user-maintained list of patterns keeps matching nodes out of every list and every search,
  // including the rows already cached in SQLite, while the node itself still opens.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const block = 'tana:event:' + ulid(), lunch = 'tana:event:' + ulid(), wfh = 'tana:event:' + ulid(), roster = 'tana:text:' + ulid();
    const all = [
      { id: block, title: 'Block (Really)', calendarEvent: { startTime: '2026-09-14T08:00:00Z' } },
      { id: lunch, title: 'Lunch', calendarEvent: { startTime: '2026-09-14T11:00:00Z' } },
      { id: wfh, title: 'Remote / WFH (non-blocking)', calendarEvent: { startTime: '2026-09-14T06:00:00Z' } },
      { id: roster, title: 'Lunch roster', state: { type: 'open' }, updateTime: '2026-09-13T10:00:00Z' },
    ];
    const byId = [];
    const listNodes = async (p) => {
      if (p.nodeIds) { byId.push(...p.nodeIds); return { nodes: all.filter((n) => p.nodeIds.includes(n.id)) }; }
      if (p.textQuery) return { nodes: all }; // the search query, whatever its text
      if (p.nodeTypes.includes('event') && p.nodeTypes.includes('text')) return { nodes: all };
      const [kind] = p.nodeTypes || [];
      if (kind === 'event') return { nodes: all.filter((n) => n.calendarEvent) };
      if (kind === 'text') return { nodes: all.filter((n) => !n.calendarEvent) };
      return { nodes: [] };
    };
    const open = new Document(lunch); open.transact((l) => initDocument(l, 'Lunch', ME));
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: () => {} } }, client: {
      sync: { subscribe: async (id) => (id === lunch ? open : null), getDocument: (id) => (id === lunch ? open : null), unsubscribe: async () => {} },
      graph: { listNodes }, search: { semanticSearch: async () => [] },
    } });
    // strings, not arrays: an array built inside the main.js vm realm is never reference-equal to one built here
    const listed = async () => [...(await backend.handlers.get('outline:roots')())].flatMap((s) => s.nodes.map((n) => n.title)).sort().join(' | ');
    const found = async (q) => [...(await backend.handlers.get('search')(null, q))].map((n) => n.title).sort().join(' | ');
    const rules = async (name, arg) => [...(await backend.handlers.get(name)(null, arg))].join(' | ');
    await backend.handlers.get('view:list')(null, 'library', { types: ['meetings', 'tasks', 'docs'], states: null, assignee: 'anyone' });
    const ALL = 'Block (Really) | Lunch | Lunch roster | Remote / WFH (non-blocking)';
    assert.equal(await listed(), ALL);

    assert.equal(await rules('filters:add', ' Block* '), 'Block*', 'a pattern is trimmed');
    assert.equal(await rules('filters:add', 'lunch'), 'Block* | lunch');
    assert.equal(await rules('filters:add', 'BLOCK*'), 'Block* | lunch', 'and one already there, in any case, is not added twice');
    assert.equal(cache.setting('hiddenTitles').join(' | '), 'Block* | lunch', 'the list is persisted, so it survives a restart');
    assert.equal(await listed(), 'Lunch roster | Remote / WFH (non-blocking)', 'exact stays exact: "Lunch roster" is not "Lunch"');
    assert.equal(cache.get(block), undefined, 'a hidden row cannot come back from the SQLite cache');
    assert.equal(await found('lunch'), 'Lunch roster | Remote / WFH (non-blocking)', 'and it is out of the search results too');

    assert.equal(await rules('filters:add', 'Remote / WFH (non-blocking)'), 'Block* | lunch | Remote / WFH (non-blocking)');
    assert.equal(await listed(), 'Lunch roster', 'a full title needs no pattern syntax');
    assert.equal(await found('wfh'), 'Lunch roster');

    // Hiding is about lists: the node keeps its identity, so opening it (a link, a pin, a mention) still works.
    byId.length = 0;
    assert.equal((await backend.handlers.get('doc:info')(null, lunch)).title, 'Lunch', 'a hidden node still opens');
    assert.ok(byId.includes(lunch), 'the by-id lookup behind it is not filtered');

    assert.equal(await rules('filters:remove', ' LUNCH '), 'Block* | Remote / WFH (non-blocking)', 'removal matches case-insensitively');
    assert.equal(await listed(), 'Lunch | Lunch roster', 'unhiding brings the row back on the next refresh');
    cache.setSetting('hiddenTitles', 'Block'); // an older build or a bad renderer call, found at startup
    backend.settings.reset(); // …which is to say: read at launch, not written past the settings cache while running
    assert.equal(await rules('filters:list'), '', 'a stored list that is not a list hides nothing');
    await backend.refresh();
    assert.equal(await listed(), ALL);
    console.log('ok  hidden titles stay out of lists, searches and the row cache, and still open');
  }

  // 2. Document: transact/export/import between two documents, both directions
  const a = new Document(DOC, { peerId: '1' }), b = new Document(DOC, { peerId: '2' });
  const aUpdates = [], events = [];
  a.on('local-update', (u) => aUpdates.push(u));
  a.on('change', (i) => events.push('a:' + i.origin));
  b.on('change', (i) => events.push('b:' + i.origin));
  a.transact((d) => d.getMap('data').set('title', 'hello'));
  assert.equal(aUpdates.length, 1);
  assert.equal(b.applyRemote(aUpdates), false);
  assert.equal(b.data.get('title'), 'hello');
  a.transact(() => {}); // no ops -> no update
  assert.equal(aUpdates.length, 1);
  b.transact((d) => d.getMap('data').set('stateType', 'open'));
  b.once('local-update', () => {});
  const bU = b.exportSince(a.loro.oplogVersion());
  a.applyRemote([bU]);
  assert.deepEqual(a.toJSON().data, { title: 'hello', stateType: 'open' });
  a.transact((d) => d.getMap('data').set('x', 1));
  const again = new Document(DOC, { peerId: '3' });
  again.applyRemote([aUpdates[1]]);
  assert.equal(again.data.get('title'), undefined, 'update after remote import contains only local ops');
  assert.deepEqual(events, ['a:local', 'b:remote', 'b:local', 'a:remote', 'a:local']);
  console.log('ok  Document transact/export/import');

  // 3. Node accessors on the real task snapshot
  const doc = new Document(DOC, { peerId: peerId });
  doc.applyRemote([snapshot]);
  const n = readNode(doc);
  assert.equal(n.id, DOC);
  assert.equal(n.title, 'Review the sample agreement');
  assert.equal(n.stateType, 'open');
  assert.equal(n.type, 'text');
  assert.deepEqual(n.assignedToUris, [ME]);
  assert.equal(typeof n.createdAt, 'number');
  const text = contentText(doc);
  assert.match(text, /^Imported from Tana Outliner on 2026-09-09\.\nOutliner ID: EXAMPLE12345\nResearch context — 10 September 2026\nThe sample agreement review names a reviewer/);
  const before = doc.loro.oplogVersion();
  const sent = [];
  doc.on('local-update', (u) => sent.push(u));
  setTitle(doc, n.title); // the no-op title edit: same title (deduped by Loro) + delete titleAutoGenerated
  assert.equal(sent.length, 1);
  assert.equal(readNode(doc).title, n.title);
  setState(doc, 'closed', ME);
  assert.equal(readNode(doc).stateType, 'closed');
  assert.equal(readNode(doc).stateChangedBy, ME);
  assert.throws(() => setState(doc, 'done', ME));
  // A workflow state is In Progress plus the column (Tana's transitionTo); a plain state clears the column again.
  const column = { workflowUri: 'tana:workflow:01examplew0000000000000000', workflowStateId: 'ab48c504-bebb-4e0c-a6c6-c066e91ce689' };
  setState(doc, column, ME);
  assert.deepEqual([readNode(doc).stateType, readNode(doc).stateWorkflowUri, readNode(doc).stateWorkflowStateId], ['open', column.workflowUri, column.workflowStateId]);
  assert.throws(() => setState(doc, { workflowUri: 'tana:type:01examplew0000000000000000', workflowStateId: 'x' }, ME), /unknown stateType/);
  setState(doc, 'closed', ME);
  assert.deepEqual([readNode(doc).stateWorkflowUri, readNode(doc).stateWorkflowStateId], [undefined, undefined]);
  {
    const wf = new Document(column.workflowUri, { peerId: '9' });
    wf.transact((l) => { const states = l.getMap('data').setContainer('states', new LoroList()); for (const [id, name] of [['a', 'Doing'], ['b', 'Review'], ['a', 'Doing again']]) { const m = states.insertContainer(states.length, new LoroMap()); m.set('id', id); m.set('name', name); } });
    assert.deepEqual(workflowStates(wf), [{ id: 'a', name: 'Doing' }, { id: 'b', name: 'Review' }], 'board order, a duplicated id kept once as Tana does');
    assert.deepEqual(workflowStates(new Document(column.workflowUri)), [], 'no states yet');
  }
  const other = new Document(DOC, { peerId: '9' });
  other.applyRemote([snapshot]);
  other.applyRemote(sent);
  assert.equal(readNode(other).stateType, 'closed');
  assert.equal(new Document(DOC).loro.oplogVersion().length(), 0, 'fresh doc = cold start');
  assert.notEqual(before.compare(doc.loro.oplogVersion()), 0);
  const assigned = new Document(DOC, { peerId: '8' });
  assigned.applyRemote([snapshot]);
  const otherAssignee = 'tana:user-profile:01examplem0000000000000000';
  const assignmentUpdates = [];
  assigned.on('local-update', (u) => assignmentUpdates.push(u));
  assert.deepEqual(taskMeta(assigned), { assignees: [ME], restricted: true, participants: [{ uri: ME, type: 'user', role: 'admin' }] });
  assert.deepEqual(setAssignees(assigned, [otherAssignee, ME, otherAssignee], ME), [otherAssignee, ME]);
  assert.deepEqual(taskMeta(assigned).assignees, [otherAssignee, ME]);
  assert.ok(assigned.data.get('assignedToUris') instanceof LoroList, 'assignees remain a LoroList');
  assert.throws(() => setAssignees(assigned, 'bad', ME), /assignees must be an array/);
  assert.throws(() => setAssignees(assigned, [ME], 'bad'), /assignedToUrisChangedBy/);
  const remoteAssignees = new Document(DOC, { peerId: '10' });
  remoteAssignees.applyRemote([snapshot]); remoteAssignees.applyRemote(assignmentUpdates);
  assert.deepEqual(taskMeta(remoteAssignees).assignees, [otherAssignee, ME]);
  console.log('ok  readNode/setTitle/setState/taskMeta/setAssignees/contentText');

  // 3a. Search query parsing (#task / #meeting / #Type) and the new-document seed
  {
    assert.deepEqual(parseQuery('sam #task'), { text: 'sam', tags: ['task'] });
    assert.deepEqual(parseQuery('#Project  sam #meeting'), { text: 'sam', tags: ['Project', 'meeting'] });
    assert.deepEqual(parseQuery('  #  '), { text: '#', tags: [] }, 'a bare # is text');
    assert.deepEqual(parseQuery('a#b'), { text: 'a#b', tags: [] }, 'only word-initial #');
    const types = new Map([['project', 'tana:type:p']]);
    assert.equal(searchParams(parseQuery(''), types), null);
    assert.deepEqual(searchParams(parseQuery('sam'), types), { nodeTypes: ['text', 'event', 'user-profile', 'space', 'search'], textQuery: 'sam', limit: 20, sortOptions: [{ field: 'SORT_FIELD_TEXT_RANK', direction: 'SORT_DIRECTION_DESCENDING' }] });
    const task = searchParams(parseQuery('sam #task'), types);
    assert.deepEqual([task.nodeTypes, task.stateTypes, task.textQuery], [['text'], STATE_TYPES, 'sam']);
    assert.deepEqual(searchParams(parseQuery('#meeting'), types).nodeTypes, ['event']);
    assert.equal(searchParams(parseQuery('#meeting'), types).textQuery, undefined);
    assert.deepEqual(searchParams(parseQuery('#PROJECT'), types).entityTypes, ['tana:type:p'], 'type title matched case-insensitively');
    assert.equal(searchParams(parseQuery('x #Nope'), types), null, 'unknown type = no results');
    assert.deepEqual([needsTypes(parseQuery('#task #meeting')), needsTypes(parseQuery('#Project'))], [false, true]);
    assert.deepEqual(searchParams(parseQuery('#member'), types).nodeTypes, ['user-profile']);

    // Hidden titles: exact by default, prefix when the pattern ends with '*', case-insensitive.
    const rules = hideRules([' Block* ', 'lunch', 'BLOCK*', '', 5, '*', 'Remote / WFH (non-blocking)']);
    assert.deepEqual(rules, ['Block*', 'lunch', 'Remote / WFH (non-blocking)'], 'trimmed, deduped case-insensitively, non-strings and a bare * dropped');
    assert.deepEqual(['Block', 'Block (Really)', 'Lunch', ' remote / wfh (non-blocking) '].map((t) => isHidden(t, rules)), [true, true, true, true]);
    assert.deepEqual(['Lunch roster', 'Deep work', '', null].map((t) => isHidden(t, rules)), [false, false, false, false], 'exact stays exact');
    assert.equal(isHidden('Blocked out', rules), true, 'a prefix pattern hides everything under it');
    assert.deepEqual(['Block (Really)', 'Blockchain'].map((t) => isHidden(t, ['Block *'])), [true, false], 'the space is part of the prefix');
    assert.equal(isHidden('anything', hideRules(['*'])), false, 'a bare * cannot empty every view');
    assert.equal(isHidden('anything', undefined), false);
    // Every preset uses the same view query (docs/VIEWS.md section 3).
    const UPD = [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }];
    const COUNT = 'LIST_NODES_MODE_WITH_COUNT';
    assert.deepEqual(viewParams(VIEW_PRESETS.inbox, ME), { nodeTypes: ['event', 'text', 'chat', 'canvas', 'agent', 'skill', 'search'], stateTypes: ['proposed'], limit: 1000, sortOptions: UPD, mode: COUNT });
    // Tasks is no longer a preset, but the query it asked for is still one a filter can name, so what that shape
    // sends the graph still matters.
    assert.deepEqual(viewParams({ types: ['tasks'], states: ['proposed', 'open', 'not_now'], assignee: 'me' }, ME), { nodeTypes: ['text'], stateTypes: ['proposed', 'open', 'not_now'], assignedTo: [ME], limit: 1000, sortOptions: UPD, mode: COUNT });
    assert.deepEqual(viewParams(VIEW_PRESETS.library, ME), { nodeTypes: ['text'], stateTypes: ['proposed', 'open', 'closed', 'not_now'], limit: 1000, sortOptions: UPD, mode: COUNT });
    // Meetings, Chats and People are no longer presets, but they are still kinds a filter can name, so what they ask
    // the graph for still matters: a saved search aimed at them must reach it the same way those pages used to.
    assert.deepEqual(viewParams({ types: ['chats'] }, ME), { nodeTypes: ['chat'], limit: 1000, sortOptions: UPD, mode: COUNT });
    assert.deepEqual(viewParams({ types: ['people'] }, ME), { nodeTypes: ['user-profile'], limit: 1000, sortOptions: UPD, mode: COUNT });
    const localDay = (offset) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d; };
    const BY_START = (direction) => [{ field: 'SORT_FIELD_EVENT_START_TIME', direction: 'SORT_DIRECTION_' + direction }];
    assert.deepEqual(viewParams({ types: ['meetings'], participant: 'me', window: 'week' }, ME), {
      nodeTypes: ['event'], limit: 1000, hasParticipantUris: [ME], eventStartTimeMin: localDay(-7).toISOString(),
      eventStartTimeMax: localDay(7).toISOString(), sortOptions: BY_START('DESCENDING'), mode: COUNT,
    }, 'the meeting picker: a week either side of today');
    // the When pill (#492): Tana's presets, soonest first only for what is still to come
    const whenParams = (window) => viewParams({ types: ['meetings'], window }, ME);
    assert.deepEqual([whenParams('today').eventStartTimeMin, whenParams('today').eventStartTimeMax], [localDay(0).toISOString(), new Date(localDay(1) - 1).toISOString()], 'today is today');
    assert.deepEqual([whenParams('recent').eventStartTimeMin, whenParams('recent').eventStartTimeMax], [undefined, new Date(localDay(2) - 1).toISOString()], 'recent runs to the end of tomorrow');
    assert.ok(whenParams('upcoming').eventStartTimeMin && !whenParams('upcoming').eventStartTimeMax, 'upcoming starts now');
    assert.ok(whenParams('past').eventStartTimeMax && !whenParams('past').eventStartTimeMin, 'past ends now');
    assert.deepEqual(['upcoming', 'today', 'recent', 'past', null].map((w) => whenParams(w).sortOptions[0].direction.slice(15)), ['ASCENDING', 'ASCENDING', 'DESCENDING', 'DESCENDING', 'DESCENDING'], 'soonest first for what is to come, latest first otherwise');
    assert.equal(viewParams({ types: ['meetings', 'tasks'], window: 'past' }, ME).eventStartTimeMax, undefined, 'a window only narrows meetings listed alone, like a state only narrows tasks');
    assert.equal(validViewFilter({ window: 'tomorrow' }), false, 'and only the presets and the picker\'s week are windows');
    const OTHER = 'tana:user-profile:01examples0000000000000000';
    assert.deepEqual(viewParams({ types: null, assignee: OTHER }, ME).assignedTo, [OTHER], 'any type includes tasks');
    assert.deepEqual(viewParams({ types: ['tasks', 'meetings'], assignee: 'unassigned' }, ME).unassigned, true);
    assert.equal(viewParams({ types: ['tasks'], assignee: 'anyone' }, ME).assignedTo, undefined);
    assert.equal(viewParams({ types: ['meetings', 'docs'], assignee: OTHER }, ME).assignedTo, undefined, 'assignee is ignored without tasks');
    // The Library keeps a status and an assignee saved while their pills are hidden; applying them to a kind that
    // cannot carry a state emptied the list (picking People returned nothing at all).
    assert.equal(viewParams({ types: ['people'], states: ['proposed', 'open'], assignee: 'me' }, ME).stateTypes, undefined, 'a state means nothing without tasks, so it is not asked for');
    assert.deepEqual(viewParams({ types: ['tasks', 'meetings'], states: ['closed'] }, ME).stateTypes, ['closed'], 'and still applies as soon as tasks are in the selection');
    assert.deepEqual(viewParams({ types: ['tasks', 'docs'] }, ME).nodeTypes, ['text'], 'duplicate graph kinds collapse into one query');
    // #139: a workspace type in the Type pill. Every kind it can be, its uri as entityTypes, and none of the Library's
    // saved task filters: a risk has no state, so "every state" would have listed none of them.
    const RISK = 'tana:type:01m1e3nthqj48b8drqb1fmma9d';
    assert.deepEqual(viewParams({ ...VIEW_PRESETS.library, types: [RISK], assignee: 'me' }, ME), { nodeTypes: ['event', 'text', 'chat', 'canvas', 'agent', 'skill', 'search'], entityTypes: [RISK], limit: 1000, sortOptions: UPD, mode: COUNT });
    assert.equal(validViewFilter({ types: ['tana:type:nope'] }), false, 'only a real type uri joins the kinds');
    assert.deepEqual(filterToSearchQuery({ ...VIEW_PRESETS.library, types: [RISK] }, ME), { entityTypeUris: [RISK] }, 'a saved search stores it the way Tana does, without the task filters');
    // A type page's field pills (#type-page): Tana's stored attributes, run as the attributeFilters verified live on Goal.
    const STATUS = RISK + '?attribute=hpgqd4jv', fielded = { types: [RISK], fields: { [STATUS]: { textMatches: [{ value: 'On track' }, { value: 'Unknown' }] } } };
    assert.equal(validViewFilter(fielded), true);
    assert.equal(validViewFilter({ types: [RISK], fields: { 'tana:type:nope?attribute=x': {} } }), false, 'a field key is a real type uri and attribute');
    assert.deepEqual(searchQueryParams(filterToSearchQuery(fielded, ME), ME).attributeFilters, { [STATUS]: { textMatches: [{ value: 'On track', mode: 'MODE_EQUALS' }, { value: 'Unknown', mode: 'MODE_EQUALS' }] } },
      'the pills reach the graph as one field with its labels ORed');
    assert.deepEqual(searchQueryToFilter({ entityTypeUris: [RISK] }, ME).types, [RISK], 'and reads it back into the pill');
    // The Library and a saved search narrowed to that one type get its field pills too: the view asks for them, a
    // saved query keeps them both ways, and beside another type (or a kind) they apply to nothing.
    assert.deepEqual(viewParams({ ...VIEW_PRESETS.library, ...fielded }, ME).attributeFilters, searchQueryParams(filterToSearchQuery(fielded, ME), ME).attributeFilters);
    assert.deepEqual(searchQueryToFilter(filterToSearchQuery(fielded, ME), ME).fields, fielded.fields);
    assert.equal(viewParams({ ...fielded, types: [RISK, 'tasks'] }, ME).attributeFilters, undefined);
    assert.equal(filterToSearchQuery({ ...fielded, types: [RISK, 'tana:type:01m1e3nthqj48b8drqb1fmma9e'] }, ME).attributes, undefined);
    // #148: the live query that re-reads an open saved search covers what it lists: kinds, type, state and assignee
    // carried over, text and owners dropped (a live query cannot say them), newest change first.
    assert.deepEqual(liveTrigger(searchQueryParams({ types: ['text'], entityTypeUris: [RISK], stateTypes: ['open'], assignedToViewer: true, textQuery: 'db', ownerUris: ['tana:space:01jspace000000000000000000'] }, ME)),
      { types: ['text'], orderBy: ['-updatedAt'], limit: 100, entityTypeUris: [RISK], stateTypes: ['open'], assignedTo: [ME] });
    assert.equal(viewParams({ types: ['docs'], text: ' dpa ' }, ME, 25).textQuery, 'dpa');
    assert.equal(viewParams({ types: ['docs'], text: ' dpa ' }, ME, 25).limit, 25);
    assert.equal(validViewFilter({ types: ['docs'], states: null, assignee: 'anyone', text: '', participant: null, window: null }), true);
    assert.equal(validViewFilter({ types: ['nope'] }), false);
    assert.equal(validViewFilter({ types: ['tasks'], extra: true }), false);
    // The completed window: how old a completed task may be and still be listed. Whether completed tasks are asked
    // for at all is the Status filter (stateTypes), so this never has an "off" — and the graph has no field to ask
    // it for, so it is applied to the answer. The clock is the task's own state.enteredAt, not update time.
    const DAY = 864e5, now = Date.UTC(2026, 8, 18, 12), closedAt = (ms) => ({ id: 'tana:text:x', state: { type: 'closed', enteredAt: new Date(ms).toISOString() } });
    assert.deepEqual([7, 30, 'all'].map((w) => completedInWindow(closedAt(now - 10 * DAY), w, now)), [false, true, true],
      'a task completed ten days ago is out of 7 days, inside 30, and always inside All');
    assert.equal(completedInWindow(closedAt(now - 7 * DAY), 7, now), true, 'the boundary is inclusive and exact: seven times twenty-four hours back still counts');
    assert.equal(completedInWindow(closedAt(now - 7 * DAY - 1), 7, now), false, 'and one millisecond older does not, so there is no day-bucket to argue about');
    assert.equal(completedInWindow(closedAt(now - 10 * DAY), undefined, now), false, 'an unset window is 7 days, the default the pill shows when Completed is first asked for');
    assert.equal(completedWindow(undefined), 7, 'which is what an unset value reads as everywhere');
    assert.equal(completedWindow(14), 7, 'and so does a value no pill can produce');
    for (const type of ['proposed', 'open', 'not_now']) assert.equal(completedInWindow({ state: { type, enteredAt: new Date(now - 400 * DAY).toISOString() } }, 7, now), true,
      'the window is about completed tasks only: an Inbox, In Progress or Later task is left alone however old its state is');
    assert.equal(completedInWindow({ id: 'tana:event:x', updateTime: new Date(now - 400 * DAY).toISOString() }, 7, now), true, 'and a node with no task state at all is not a completed task');
    assert.equal(completedInWindow({ state: { type: 'closed' } }, 7, now), false, 'a completed task with no completion time cannot be shown to be recent, so a window leaves it out');
    assert.equal(completedInWindow({ state: { type: 'closed' } }, 'all', now), true, 'while All has no clock to fail: it keeps every completed task');
    assert.deepEqual([3, 7, 30, 'all', 14, '7', true, null].map((w) => validViewFilter({ completedWithin: w })), [true, true, true, true, false, false, false, false],
      'only the four the pill offers are a valid filter value');
    assert.equal(viewParams({ types: ['tasks'], states: ['closed'], completedWithin: 7 }, ME).limit, 1000, 'and the window asks the graph for nothing: there is no request field for it');
    assert.throws(() => viewParams({ types: ['nope'] }, ME), /invalid view filter/);
    // Unticking the last kind must not become an unconstrained query: the graph would answer with images, calls and
    // transcripts, which no view can render and which wedged the app when it tried.
    assert.deepEqual(viewParams({ types: [] }, ME).nodeTypes, viewParams({ types: null }, ME).nodeTypes, 'no kinds selected is every kind a view lists, never nodeTypes: []');
    // Spaces are findable by name: a kind in the Library and a #space filter in search, but not part of "any type",
    // which is about content rather than the containers it lives in.
    assert.deepEqual(viewParams({ types: ['spaces'] }, ME).nodeTypes, ['space'], 'the Library can list spaces');
    assert.equal(viewParams({ types: null }, ME).nodeTypes.includes('space'), false, 'and any type stays content');
    // A saved search is a document, not a container: Tana's own client groups `search` with text, event and chat as a
    // document kind, so unlike spaces it belongs in "any type" — which is what makes one show up in the Library at all.
    assert.deepEqual(viewParams({ types: ['searches'] }, ME).nodeTypes, ['search'], 'saved searches are a kind the Library can list');
    assert.equal(viewParams({ types: null }, ME).nodeTypes.includes('search'), true, 'and they are part of any type, unlike spaces');
    assert.equal(searchParams(parseQuery('quarterly'), new Map()).nodeTypes.includes('search'), true, 'Cmd+S finds them too');
    assert.deepEqual(searchParams(parseQuery('foundry #space'), new Map()).nodeTypes, ['space'], '#space narrows a search to spaces');
    assert.equal(searchParams(parseQuery('foundry'), new Map()).nodeTypes.includes('space'), true, 'and a plain search finds them among everything else');
    // A saved search's stored query (docs/superpowers/specs/2026-09-16-saved-searches-design.md §2), verified
    // against the real "My Tasks" document: optional keys are absent rather than empty.
    const myTasks = { types: ['text'], entityTypeUris: [], ownerUris: [], createdBy: [], assignedTo: [],
      assignedToViewer: true, participantUris: [], stateTypes: ['proposed', 'open', 'closed', 'not_now'],
      workflowStates: [], attributes: {} };
    assert.deepEqual(searchQueryParams(myTasks, ME), {
      limit: 1000, sortOptions: UPD, mode: COUNT, nodeTypes: ['text'],
      stateTypes: ['proposed', 'open', 'closed', 'not_now'], assignedTo: [ME],
    }, 'the real "My Tasks" search becomes a task query assigned to the viewer');
    const anyKindNodeTypes = searchQueryParams({ types: [] }, ME).nodeTypes;
    assert.ok(anyKindNodeTypes.length > 0 && !anyKindNodeTypes.includes('space'),
      'an unconstrained saved search still asks only for kinds a view can render, never nodeTypes: []');
    assert.deepEqual(searchQueryParams({ types: ['event'], participantUris: ['tana:user-profile:01examples0000000000000000'] }, ME).hasParticipantUris,
      ['tana:user-profile:01examples0000000000000000'], 'participantUris is the graph\'s hasParticipantUris');
    assert.deepEqual(searchQueryParams({ ownerUris: ['tana:space:01examples0000000000000000'] }, ME).ownerIds,
      ['tana:space:01examples0000000000000000'], 'ownerUris scopes by owner');
    // A scoped space covers every space beneath it, at any depth, as in Tana (C$e/oy): the org's spaces are passed in.
    const sp = (n) => 'tana:space:01examplesp' + String(n).padStart(15, '0'), doc1 = 'tana:text:01examples0000000000000000';
    const tree = [{ id: sp(1) }, { id: sp(2), ownerUri: sp(1) }, { id: sp(3), ownerUri: sp(2) }, { id: sp(4), ownerUri: sp(1), archivedAt: '2026-09-01T00:00:00Z' },
      { id: sp(5), ownerUri: sp(4) }, { id: sp(6) }, { id: sp(7), ownerUri: sp(6) }];
    assert.deepEqual(searchQueryParams({ ownerUris: [sp(1)] }, ME, 200, undefined, tree).ownerIds, [sp(1), sp(2), sp(3)],
      'a parent space widens to its sub-spaces and theirs; an archived one is cut off with what sits under it');
    assert.deepEqual(searchQueryParams({ ownerUris: [sp(2), sp(1), doc1, sp(6), sp(2), 'junk'] }, ME, 200, undefined, tree).ownerIds, [sp(2), sp(3), sp(1), doc1, sp(6), sp(7)],
      'every owner once: an overlapping scope adds nothing twice, a non-space owner stays as itself, a non-uri is dropped');
    assert.deepEqual(searchQueryParams({ ownerUris: [sp(4)] }, ME, 200, undefined, tree).ownerIds, [sp(4)], 'a scoped archived space still stays itself');
    assert.equal(searchQueryParams({ createdByViewer: true }, ME).createdBy[0], ME, 'createdByViewer resolves to the signed-in user');
    assert.equal(searchQueryParams({ textQuery: '  dpa  ' }, ME).textQuery, 'dpa', 'text is trimmed');
    assert.equal(searchQueryParams({ textQuery: '   ' }, ME).textQuery, undefined, 'blank text is not a filter');
    assert.equal(searchQueryParams({ unassigned: true }, ME).unassigned, true);
    // visibility, workflowStates and attributes run the way Tana's own client runs a saved search (C$ in shared-*.js).
    const pick = (p, ...keys) => Object.fromEntries(keys.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
    assert.deepEqual(pick(searchQueryParams({ visibility: 'private' }, ME), 'restricted', 'exactParticipantUris', 'visibility'), { restricted: true, exactParticipantUris: [ME] },
      'private is restricted with the viewer as the only participant');
    assert.deepEqual(searchQueryParams({ visibility: 'shared', participantUris: [OTHER] }, ME).hasParticipantUris, [OTHER, ME], 'shared adds the viewer to the participants');
    assert.equal(searchQueryParams({ visibility: 'open' }, ME).restricted, false, 'open is an explicit restricted: false');
    assert.equal(searchQueryParams({ visibility: 'link' }, ME).linkShared, true);
    const flow = { workflowUri: 'tana:workflow:01examples0000000000000000', workflowStateId: 'review' };
    const wf = searchQueryParams({ types: ['text'], stateTypes: ['closed'], workflowStates: [flow, flow] }, ME);
    assert.deepEqual(wf.stateSelectors, [{ type: 'closed' }, { type: 'open', ...flow }], 'a workflow state is an open-state selector beside the plain states, once');
    assert.deepEqual(wf.stateTypes, ['closed', 'open']);
    assert.deepEqual(searchQueryParams({ attributes: { 'tana:type:x?attribute=y': { refs: ['tana:text:01examples0000000000000000', 'junk'], date: { min: 5 },
      textMatches: [{ value: 'a' }, { value: 'b', mode: 'prefix' }, { value: ' ' }, { value: 'c', mode: 'constructor' }], numberRanges: [{ min: 1 }, {}] }, 'tana:type:x?attribute=z': 'high' } }, ME).attributeFilters,
    { 'tana:type:x?attribute=y': { refs: ['tana:text:01examples0000000000000000'], dateRanges: [{ min: 5 }], textMatches: [{ value: 'a', mode: 'MODE_EQUALS' }, { value: 'b', mode: 'MODE_PREFIX' }], numberRanges: [{ min: 1 }] } },
    'attributes become attributeFilters, dropping what Tana drops');
    assert.equal(searchQueryParams({ unassigned: true, assignedToViewer: true }, ME).assignedTo, undefined, 'unassigned wins over an assignee');
    assert.equal(searchQueryParams({ textQuery: 'dpa' }, ME).sortOptions, undefined, 'a text search is left to the server ranking');
    const noon = new Date(2026, 8, 22, 12).getTime();
    const upcoming = searchQueryParams({ types: ['event'], eventTime: { preset: 'upcoming' } }, ME, 200, noon);
    assert.equal(upcoming.eventStartTimeMin, new Date(noon).toISOString(), 'upcoming starts now');
    assert.equal(upcoming.sortOptions[0].direction, 'SORT_DIRECTION_ASCENDING', 'and lists the soonest first');
    const recent = searchQueryParams({ types: ['event'], eventTime: { preset: 'recent' } }, ME, 200, noon);
    assert.equal(recent.eventStartTimeMax, new Date(new Date(2026, 8, 24).getTime() - 1).toISOString(), 'recent runs to the end of tomorrow');
    assert.deepEqual(recent.sortOptions, [{ field: 'SORT_FIELD_EVENT_START_TIME', direction: 'SORT_DIRECTION_DESCENDING' }], 'newest first');
    // "Save this query as a search" is the inverse of the above, so the pair round-trips: what the pills show
    // becomes a stored query, and that stored query asks the graph the same thing the view was asking.
    const libFilter = { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: ' dpa ' };
    const saved = filterToSearchQuery(libFilter, ME);
    assert.deepEqual(saved, { types: ['text'], stateTypes: ['proposed', 'open'], textQuery: 'dpa', assignedToViewer: true },
      'a Library filter becomes a stored query in the document vocabulary, not the UI one');
    const roundTrip = searchQueryParams(saved, ME);
    assert.deepEqual(roundTrip.nodeTypes, ['text'], 'and asking the graph with it means the same thing');
    assert.deepEqual(roundTrip.stateTypes, ['proposed', 'open']);
    assert.deepEqual(roundTrip.assignedTo, [ME], 'assignedToViewer resolves back to the signed-in user');
    assert.equal(roundTrip.textQuery, 'dpa');
    assert.deepEqual(filterToSearchQuery({ types: ['tasks', 'docs'] }, ME).types, ['text'],
      'two UI kinds that share a graph kind collapse to one, as viewParams does');
    assert.equal(filterToSearchQuery({ assignee: 'unassigned' }, ME).unassigned, true);
    assert.deepEqual(filterToSearchQuery({ assignee: OTHER }, ME).assignedTo, [OTHER], 'a named assignee is stored as that uri');
    assert.equal(filterToSearchQuery({ assignee: 'anyone' }, ME).assignedTo, undefined, 'and "anyone" stores no assignee at all');
    // 'me' with nobody signed in must store nothing: writing the literal string 'me' as a user-profile uri would
    // match no one and read as a real assignee filter for the life of the document.
    const noUser = filterToSearchQuery({ types: ['tasks'], assignee: 'me' }, undefined);
    assert.equal(noUser.assignedTo, undefined, 'no signed-in user means no assignee uri, not the string "me"');
    assert.equal(noUser.assignedToViewer, undefined, 'and no viewer flag either, since there is no viewer to resolve');
    assert.deepEqual(noUser.types, ['text'], 'the rest of the filter still translates');
    assert.equal(filterToSearchQuery({ text: '   ' }, ME).textQuery, undefined, 'blank text is not a filter on the way in either');
    // The two documented asymmetries: neither has a viewer-relative form in the stored schema.
    assert.deepEqual(filterToSearchQuery({ participant: 'me' }, ME).participantUris, [ME],
      'participant has no viewer-relative flag, so a saved search names the user rather than the viewer');
    const windowed = filterToSearchQuery({ types: ['meetings'], window: 'week' }, ME);
    assert.deepEqual(windowed.eventTime, { min: localDay(-7).getTime(), max: localDay(7).getTime() }, 'the picker\'s week is no Tana preset, so it is saved as the range it is');
    // The When pill's presets are Tana's own, so they are stored as Tana stores them and come back as the same pill (#492)
    for (const window of ['recent', 'today', 'upcoming', 'past']) {
      const q = filterToSearchQuery({ types: ['meetings'], window }, ME);
      assert.deepEqual(q.eventTime, { preset: window }, window + ' is stored as Tana\'s preset');
      assert.equal(searchQueryToFilter(q, ME).window, window, 'and reads back as the same pill');
    }
    assert.equal(filterToSearchQuery({ types: ['tasks'], window: 'past' }, ME).eventTime, undefined, 'a window hidden with the pill is not stored either');
    // The pills edit a saved search through the same filter vocabulary they edit a view with, so the stored query has
    // to come back the other way too. This is the pair the Save button rests on: read a query, show it as pills, write
    // it back. A filter that does not round-trip would quietly rewrite the user's search the first time they saved it.
    assert.deepEqual(searchQueryToFilter(saved, ME), { types: ['tasks'], states: ['proposed', 'open'], text: 'dpa', assignee: 'me', participant: null, window: null },
      'the stored query reads back as the Library filter it was saved from');
    assert.deepEqual(searchQueryToFilter(myTasks, ME), { types: ['tasks'], states: ['proposed', 'open', 'closed', 'not_now'], text: '', assignee: 'me', participant: null, window: null },
      'and so does the real "My Tasks" document, which is what the pills will actually open on');
    assert.ok(validViewFilter(searchQueryToFilter(myTasks, ME)), 'what comes back is a filter the pills and viewParams already accept');
    // The documented lossy edge: tasks and docs share the node type `text`, so task state is what tells them apart.
    assert.deepEqual(searchQueryToFilter({ types: ['text'] }, ME).types, ['docs'], 'a text query with no task state is documents');
    assert.deepEqual(searchQueryToFilter({ types: ['text'], stateTypes: ['open'] }, ME).types, ['tasks'], 'the same query constrained by task state is tasks');
    // Every kind survives a save and a read, so a kind added to KIND_NODE_TYPE is a saved-search type both ways.
    const { VIEW_KINDS } = require('../sdk/query');
    assert.deepEqual(VIEW_KINDS, ['meetings', 'tasks', 'docs', 'chats', 'canvases', 'agents', 'skills', 'searches', 'spaces', 'people', 'types'], 'the kinds, in the order the pills list them');
    // Whoever needs a kind's node type asks this table; platform-cli's assignee probe kept a copy that lacked searches
    // and types, so those two probe rows sent no node type and were refused (#249).
    const cli = fs.readFileSync(require('node:path').join(__dirname, 'platform-cli.js'), 'utf8');
    assert.doesNotMatch(cli, /\{\s*meetings:\s*'event'/, 'platform-cli reads kinds from sdk/query.js KIND_NODE_TYPE, not a copy of its own');
    assert.ok(VIEW_KINDS.every((kind) => require('../sdk/query').KIND_NODE_TYPE[kind]), 'and that table names a node type for every kind');
    for (const kind of VIEW_KINDS) assert.deepEqual(searchQueryToFilter(filterToSearchQuery({ types: [kind], states: ['open'] }, ME), ME).types, [kind], kind + ' round-trips through a saved search');
    // Reading an assignee: the viewer flag and the viewer's own uri both mean "You" to a pill, which is the one thing
    // that lets an assignee survive a save — it goes back out as assignedToViewer either way.
    assert.equal(searchQueryToFilter({ assignedTo: [ME] }, ME).assignee, 'me', 'the signed-in user as a named assignee still reads as "You"');
    assert.equal(filterToSearchQuery(searchQueryToFilter({ assignedTo: [ME] }, ME), ME).assignedToViewer, true, 'and saves back as the viewer-relative flag');
    assert.equal(searchQueryToFilter({ assignedTo: [OTHER] }, ME).assignee, OTHER, 'someone else stays that person');
    assert.equal(searchQueryToFilter({ unassigned: true }, ME).assignee, 'unassigned');
    assert.equal(searchQueryToFilter({}, ME).assignee, 'anyone', 'a query with no assignee at all is "Anyone", not "You"');
    assert.equal(searchQueryToFilter({ types: ['event'], participantUris: [ME] }, ME).participant, 'me', 'the viewer among the participants is the Meetings filter');
    assert.equal(searchQueryToFilter({ types: ['event'], participantUris: [OTHER] }, ME).participant, null, 'someone else among them is not a filter the pills can show');
    assert.equal(searchQueryToFilter({ types: ['event'], eventTime: { min: 1, max: 2 } }, ME).window, 'week', 'a stored range (the week, or an older save) reads as the week');
    // The vocabulary no pill can express is dropped rather than guessed at, and must not leak into the filter or
    // break its validity — saving then rewrites the query from the pills alone, which is why saving is explicit.
    const rich = searchQueryToFilter({ types: ['text'], stateTypes: ['open'], attributes: { 'tana:type:x?attribute=y': ['z'] }, workflowStates: ['w'], visibility: 'private' }, ME);
    assert.ok(validViewFilter(rich), 'a query carrying things the pills cannot show still reads back as a valid filter');
    assert.deepEqual(Object.keys(rich).sort(), ['assignee', 'participant', 'states', 'text', 'types', 'window'], 'and carries none of them into the filter');
    const id = ulid();
    assert.match(id, /^[0-9a-hjkmnp-tv-z]{26}$/);
    assert.equal(ulid(0).slice(0, 10), '0000000000');
    assert.notEqual(ulid(), id);
    const fresh = new Document('tana:text:' + id, { peerId: '5' });
    fresh.transact((l) => initDocument(l, 'New doc', ME));
    const j = fresh.toJSON();
    assert.deepEqual(Object.keys(j.data).sort(), ['assignedToUris', 'attributes', 'createdAt', 'participants', 'restricted', 'sharedPinDates', 'title', 'type']);
    assert.deepEqual(j.data.participants, { [ME]: { type: 'user', role: 'admin' } });
    assert.deepEqual(j.content, { nodeName: 'doc', attributes: {}, children: [{nodeName:'paragraph',attributes:{blockId:j.content.children[0].attributes.blockId},children:[]}] });
    assert.match(j.content.children[0].attributes.blockId,/^[0-9a-z]{8}$/);
    assert.deepEqual(j.data.assignedToUris,[]);
    assert.ok(fresh.data.get('assignedToUris') instanceof LoroList);
    assert.equal(outline.insertAfter(fresh, null, 'first').length, 8, 'content skeleton is writable');
    // kinds: task = open state assigned to me; meeting = Tana-native event layout (next half hour, 30 min)
    const T0 = Date.UTC(2026, 8, 13, 10, 7); // 10:07 -> 10:30
    const td = new Document('tana:text:' + ulid(), { peerId: '5' });
    td.transact((l) => initDocument(l, 'New task', ME, { kind: 'task', now: T0 }));
    const t = td.toJSON().data;
    assert.deepEqual([t.type, t.stateType, t.stateEnteredAt, t.stateChangedBy, t.assignedToUris, t.assignedToUrisChangedAt, t.assignedToUrisChangedBy, t.createdAt], ['text', 'open', T0, ME, [ME], T0, ME, T0]);
    assert.ok(td.data.get('assignedToUris') instanceof require('loro-crdt').LoroList, 'assignedToUris is a list container');
    const ev = new Document('tana:event:' + ulid(), { peerId: '5' });
    ev.transact((l) => initDocument(l, 'New meeting', ME, { kind: 'meeting', now: T0 }));
    const e = ev.toJSON().data;
    assert.deepEqual(Object.keys(e).sort(), ['attendees', 'attributes', 'createdAt', 'endTime', 'organizer', 'origin', 'participants', 'restricted', 'sharedPinDates', 'startTime', 'timezone', 'title', 'type']);
    assert.deepEqual([e.type, e.origin, e.startTime, e.endTime, e.attendees, e.timezone], ['event', 'tana', Date.UTC(2026, 8, 13, 10, 30), Date.UTC(2026, 8, 13, 11, 0), [], Intl.DateTimeFormat().resolvedOptions().timeZone]);
    assert.equal(e.stateType, undefined);
    assert.deepEqual(ev.toJSON().content, {});
    assert.deepEqual(ev.toJSON().pinnedItems, []);
    assert.equal(ev.loro.getMovableList('pinnedItems').kind(), 'MovableList');
    assert.ok(ev.data.get('organizer') instanceof LoroMap);
    assert.deepEqual(e.organizer, {});
    assert.throws(() => fresh.transact((l) => initDocument(l, 'x', ME, { kind: 'note' })), /unknown kind/);
    console.log('ok  query parsing, ulid, initDocument (doc/task/meeting)');
  }

  // Saved search query (T4-a): the one Loro mechanic phase 1 left unverified. A `query` root container, built with
  // container-typed fields the way Tana's own client would (a LoroList of types, a nested LoroMap of attributes and
  // of eventTime), exported as a snapshot and applyRemote'd into the app's own Document exactly as sync bootstrap
  // does, then read back the way main/related.js's searchChildren reads it: doc.loro.getMap('query').toJSON().
  // Also closes T3-a: entityTypeUris -> entityTypes and the eventTime.min/max guards had no dedicated assertion.
  {
    const searchId = 'tana:search:' + ulid();
    const source = new Document(searchId, { peerId: '21' });
    source.transact((l) => {
      initDocument(l, 'My Tasks', ME);
      l.getMap('data').set('type', 'search');
      const q = l.getMap('query');
      q.set('assignedToViewer', true);
      q.setContainer('types', new LoroList()).push('text');
      q.setContainer('stateTypes', new LoroList()).push('proposed');
      q.setContainer('entityTypeUris', new LoroList()).push('tana:type:project');
      q.setContainer('attributes', new LoroMap()).set('tana:type:project?attribute=priority', 'high');
      const eventTime = q.setContainer('eventTime', new LoroMap());
      eventTime.set('min', Date.UTC(2026, 8, 1));
      eventTime.set('max', Date.UTC(2026, 8, 15));
    });
    const searchSnapshot = source.exportSince();
    const target = new Document(searchId, { peerId: '22' });
    let localOps = 0;
    target.on('local-update', () => localOps++);
    assert.equal(target.applyRemote([searchSnapshot]), false, 'a full snapshot leaves nothing missing');
    const afterImport = target.loro.oplogVersion();
    const query = target.loro.getMap('query').toJSON();
    assert.deepEqual(query, {
      assignedToViewer: true, types: ['text'], stateTypes: ['proposed'],
      entityTypeUris: ['tana:type:project'],
      attributes: { 'tana:type:project?attribute=priority': 'high' },
      eventTime: { min: Date.UTC(2026, 8, 1), max: Date.UTC(2026, 8, 15) },
    }, 'container-typed and plain fields both arrive through toJSON() in the shape searchQueryParams expects');
    assert.equal(localOps, 0, 'reading the query container emits no local ops: the phase is read-only');
    assert.equal(target.loro.oplogVersion().compare(afterImport), 0, 'reading the query container leaves the version vector unchanged');
    assert.equal(Object.hasOwn(readNode(target), 'query'), false, 'the query container is invisible to the data map, exactly as searchChildren\'s comment claims');
    const params = searchQueryParams(query, ME);
    assert.deepEqual(params.nodeTypes, ['text']);
    assert.deepEqual(params.stateTypes, ['proposed']);
    assert.deepEqual(params.entityTypes, ['tana:type:project'], 'entityTypeUris -> entityTypes (T3-a)');
    assert.deepEqual(params.assignedTo, [ME]);
    assert.equal(params.eventStartTimeMin, undefined, 'Tana applies eventTime only to a search for events alone');
    const events = searchQueryParams({ ...query, types: ['event'] }, ME);
    assert.equal(events.eventStartTimeMin, new Date(Date.UTC(2026, 8, 1)).toISOString(), 'eventTime.min -> eventStartTimeMin (T3-a)');
    assert.equal(events.eventStartTimeMax, new Date(Date.UTC(2026, 8, 15)).toISOString(), 'eventTime.max -> eventStartTimeMax (T3-a)');
    // Finding 2 (searchChildren, main/related.js): a document with no query container reads back as {}, not an
    // error, which is why searchChildren must treat an empty read as a failure rather than as an unconstrained search.
    const broken = new Document('tana:search:' + ulid(), { peerId: '23' });
    broken.transact((l) => initDocument(l, 'Broken search', ME));
    assert.deepEqual(broken.loro.getMap('query').toJSON(), {}, 'a document with no query container reads back empty, not an error');
    console.log('ok  saved search query: Loro read mechanics (container + plain fields, zero local ops), entityTypeUris/eventTime');
  }

  // 3b. Outline ops on the content tree (docs/OUTLINER.md): every op is checked on readOutline, on the raw Loro
  // structure, and by replaying its local-update into a second Document.
  const c1 = new Document(DOC, { peerId: '11' }), c2 = new Document(DOC, { peerId: '12' });
  c1.applyRemote([snapshot]); c2.applyRemote([snapshot]);
  c1.on('local-update', (u) => c2.applyRemote([u]));
  const raw = () => c1.content.toJSON().children;
  const flat = (ns) => ns.map((n) => n.text.split('\n')[0].slice(0, 12) + (n.children.length ? '(' + flat(n.children) + ')' : '')).join(',');
  const wellFormed = (blocks) => { // listItem starts with a paragraph, lists only hold non-empty listItems, ids are 8 lowercase alphanumerics
    for (const b of blocks) {
      if (typeof b === 'string' || b.nodeName === 'mention' || b.nodeName === 'hardBreak') continue; // inline nodes carry no blockId
      assert.match(b.attributes.blockId, /^[a-z0-9]{8}$/, 'blockId on ' + b.nodeName);
      if (['bulletList', 'orderedList'].includes(b.nodeName)) { assert.ok(b.children.length, 'empty list'); assert.ok(b.children.every((i) => i.nodeName === 'listItem')); }
      if (b.nodeName === 'listItem') assert.equal(b.children[0] && b.children[0].nodeName, 'paragraph', 'listItem must start with a paragraph');
      wellFormed(b.children || []);
    }
  };
  const step = (fn) => { const r = fn(); wellFormed(raw()); assert.deepEqual(outline.readOutline(c2), outline.readOutline(c1), 'second document converges'); return r; };
  const o0 = outline.readOutline(c1);
  assert.equal(o0.length, 3);
  assert.deepEqual(o0.map((n) => [n.id, n.kind, n.heading, n.hasChildren]), [['6s8vb70s', 'block', undefined, false], ['dv8c4sp7', 'block', 2, false], ['r4hz3a0b', 'block', undefined, false]]);
  assert.equal(o0[1].text, 'Research context — 10 September 2026');
  assert.match(o0[2].text, /^The sample agreement review names a reviewer/, 'mention rendered as its label');
  // segments: text runs and mentions, in order; a run is the inline container at that index
  const run = (block, i) => c1.content.get('children').get(block).get('children').get(i);
  const MENTION = { mention: { label: 'sample agreement review', uri: 'tana:text:01examplet0000000000000000' } };
  assert.equal(o0[2].segments.length, 3);
  assert.deepEqual(o0[2].segments.slice(0, 2), [{ text: 'The ' }, MENTION]);
  assert.equal(o0[2].segments.map((s) => s.text ?? s.mention.label).join(''), o0[2].text, 'segments join to text');
  assert.deepEqual(o0[1].segments, [{ text: o0[1].text }]);
  // setText with segments: same mention container kept, text runs updated in place, other segments replaced
  const mentionId = run(2, 1).id, tailId = run(2, 2).id;
  step(() => outline.setText(c1, 'r4hz3a0b', [{ text: 'The ' }, MENTION, { text: ' is edited.' }]));
  assert.deepEqual(outline.readOutline(c1)[2].segments, [{ text: 'The ' }, MENTION, { text: ' is edited.' }]);
  assert.equal(outline.readOutline(c1)[2].text, 'The sample agreement review is edited.');
  assert.ok(run(2, 1).id === mentionId && run(2, 2).id === tailId, 'mention and text run containers kept');
  step(() => outline.setText(c1, 'r4hz3a0b', [{ text: 'See ' }, { mention: { label: 'Other', uri: 'tana:text:other' } }, { text: '' }]));
  assert.deepEqual(outline.readOutline(c1)[2].segments, [{ text: 'See ' }, { mention: { label: 'Other', uri: 'tana:text:other' } }], 'empty text dropped');
  assert.notEqual(run(2, 1).id, mentionId, 'different uri = new mention');
  assert.equal(raw()[2].children[1].attributes.tanaUri, 'tana:text:other');
  step(() => outline.setText(c1, 'r4hz3a0b', 'plain'));
  assert.deepEqual(raw()[2].children, ['plain'], 'a string drops the mention');
  step(() => outline.setText(c1, 'r4hz3a0b', o0[2].segments)); // restore
  assert.deepEqual(outline.readOutline(c1)[2].segments, o0[2].segments);
  // marks survive an in-place text update (the first paragraph carries a link mark)
  assert.ok(run(0, 0).toDelta().some((d) => d.attributes && d.attributes.link), 'fixture has a link mark');
  step(() => outline.setText(c1, '6s8vb70s', o0[0].text + '!'));
  assert.ok(run(0, 0).toDelta().some((d) => d.attributes && d.attributes.link), 'link mark kept');
  assert.equal(outline.readOutline(c1)[0].text, o0[0].text + '!');
  step(() => outline.setText(c1, '6s8vb70s', 'Hello'));
  assert.equal(outline.readOutline(c1)[0].text, 'Hello');
  assert.deepEqual(raw()[0].children, ['Hello'], 'single text run');
  step(() => outline.setText(c1, '6s8vb70s', ''));
  assert.deepEqual(raw()[0].children, [], 'empty paragraph has no runs');
  step(() => outline.setText(c1, '6s8vb70s', 'Hello'));
  assert.throws(() => outline.setText(c1, 'nope0000', 'x'));
  const end = step(() => outline.insertAfter(c1, null, 'End'));
  const second = step(() => outline.insertAfter(c1, '6s8vb70s', 'Second'));
  assert.match(end + second, /^[a-z0-9]{16}$/);
  assert.equal(flat(outline.readOutline(c1)), 'Hello,Second,Research con,The sample a,End');
  const child = step(() => outline.insertChild(c1, '6s8vb70s', 'Child'));
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child),Second,Research con,The sample a,End');
  assert.equal(raw()[0].nodeName, 'bulletList');
  assert.deepEqual(raw()[0].children[0].children.map((b) => b.nodeName), ['paragraph', 'bulletList'], 'paragraph wrapped into listItem with a nested list');
  assert.equal(raw()[0].children[0].children[0].attributes.blockId, '6s8vb70s', 'node id survives wrapping');
  assert.throws(() => outline.insertChild(c1, 'dv8c4sp7', 'x'), /cannot contain child nodes/, 'bare headings cannot own children');
  assert.throws(() => outline.setText(c1, null, 'x'), /node id must be a string/);
  step(() => outline.indent(c1, second));
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child,Second),Research con,The sample a,End');
  assert.equal(raw()[0].children.length, 1, 'one listItem in the top list');
  step(() => outline.outdent(c1, second));
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child),Second,Research con,The sample a,End');
  assert.equal(raw()[0].children.length, 2, 'outdented node is a sibling listItem');
  step(() => outline.indent(c1, '6s8vb70s')); // first node: no previous sibling
  step(() => outline.outdent(c1, 'r4hz3a0b')); // top level: no-op
  step(() => outline.indent(c1, 'r4hz3a0b')); // previous sibling is a heading: no-op
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child),Second,Research con,The sample a,End');
  const grand = step(() => outline.insertChild(c1, child, 'Grand'));
  step(() => outline.indent(c1, end)); // becomes last child of the mention paragraph (wrapped)
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child(Grand)),Second,Research con,The sample a(End)');
  assert.equal(raw()[2].children[0].children[0].children[1].nodeName, 'mention', 'mention kept through wrapping');
  const end2 = step(() => outline.insertAfter(c1, end, 'End2'));
  step(() => outline.outdent(c1, grand));
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child,Grand),Second,Research con,The sample a(End,End2)');
  // move: no-op at the edges, swaps in the middle (listItems within their list, top-level blocks with their neighbour block)
  const beforeMoves = outline.readOutline(c1);
  step(() => outline.move(c1, end, 'up')); // first in its nested list
  step(() => outline.move(c1, '6s8vb70s', 'up')); // first in the top list
  step(() => outline.move(c1, end2, 'down')); // last in its nested list
  step(() => outline.move(c1, 'r4hz3a0b', 'down')); // last block of the doc
  assert.deepEqual(outline.readOutline(c1), beforeMoves, 'edges are no-ops');
  step(() => outline.move(c1, end, 'down'));
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child,Grand),Second,Research con,The sample a(End2,End)');
  step(() => outline.move(c1, end, 'up'));
  step(() => outline.move(c1, second, 'up'));
  assert.equal(flat(outline.readOutline(c1)), 'Second,Hello(Child,Grand),Research con,The sample a(End,End2)');
  step(() => outline.move(c1, second, 'down'));
  step(() => outline.move(c1, 'dv8c4sp7', 'up')); // heading swaps with the whole preceding list
  assert.equal(flat(outline.readOutline(c1)), 'Research con,Hello(Child,Grand),Second,The sample a(End,End2)');
  step(() => outline.move(c1, 'dv8c4sp7', 'down'));
  assert.deepEqual(outline.readOutline(c1), beforeMoves, 'moves round-trip (ids and children kept)');
  assert.deepEqual(c2.content.toJSON(), c1.content.toJSON(), 'raw structure converges after moves');
  step(() => outline.remove(c1, grand));
  step(() => outline.remove(c1, end));
  step(() => outline.remove(c1, end2));
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child),Second,Research con,The sample a');
  assert.equal(raw()[2].nodeName, 'bulletList');
  assert.equal(raw()[2].children[0].children.length, 1, 'emptied nested list removed from the listItem');
  step(() => outline.remove(c1, child));
  step(() => outline.remove(c1, second));
  step(() => outline.remove(c1, '6s8vb70s'));
  assert.equal(raw()[0].nodeName, 'heading', 'emptied top-level list removed');
  assert.equal(flat(outline.readOutline(c1)), 'Research con,The sample a');
  assert.deepEqual(c2.content.toJSON(), c1.content.toJSON(), 'raw structure converges');
  console.log('ok  outline read/segments/setText/insertAfter/insertChild/indent/outdent/move/remove');
  { // blocks with no blockId (Tana's agent writes some): given one on read, once, so the rows can be edited at all
    const bare = new Document('tana:text:' + ulid());
    bare.transact((l) => {
      const data = l.getMap('data'); data.set('type', 'text'); data.set('title', 'Agent-written');
      const c = l.getMap('content'); c.set('nodeName', 'doc'); c.setContainer('attributes', new LoroMap());
      const children = c.setContainer('children', new LoroList());
      const p = children.insertContainer(0, new LoroMap()); p.set('nodeName', 'paragraph'); p.setContainer('attributes', new LoroMap()); p.setContainer('children', new LoroList()).insertContainer(0, new LoroText()).insert(0, 'no id here');
      const list = children.insertContainer(1, new LoroMap()); list.set('nodeName', 'bulletList'); list.setContainer('attributes', new LoroMap());
      const li = list.setContainer('children', new LoroList()).insertContainer(0, new LoroMap()); li.set('nodeName', 'listItem'); li.setContainer('attributes', new LoroMap());
      const q = li.setContainer('children', new LoroList()).insertContainer(0, new LoroMap()); q.set('nodeName', 'paragraph'); q.setContainer('attributes', new LoroMap()); q.setContainer('children', new LoroList()).insertContainer(0, new LoroText()).insert(0, 'nor here');
    });
    assert.deepEqual(outline.readOutline(bare).map((n) => n.id), [undefined, undefined], 'read as they are, the rows have no id');
    assert.equal(outline.assignBlockIds(bare), 2, 'both blocks are given one');
    const ids = outline.readOutline(bare).map((n) => n.id);
    assert.ok(ids.every((id) => /^[a-z0-9]{8}$/.test(id)), 'in the shape Tana uses: ' + ids.join());
    assert.equal(outline.assignBlockIds(bare), 0, 'and a second pass writes nothing');
    outline.setText(bare, ids[1], 'edited by id'); // the point of it: the row can now be written to
    assert.equal(outline.readOutline(bare)[1].text, 'edited by id');
    console.log('ok  outline: blocks with no blockId get one on read, so agent-written rows can be edited');
  }
  // Marks and block types (Tana's own ProseMirror schema: bold/italic/strike/code/link, paragraph/heading/
  // bulletList/orderedList/codeBlock/blockquote/horizontalRule). Two peers so every conversion has to converge.
  {
    const a = new Document(DOC, { peerId: '851' }), b = new Document(DOC, { peerId: '852' });
    a.applyRemote([snapshot]); b.applyRemote([a.exportSince()]);
    a.on('local-update', (u) => b.applyRemote([u]));
    const raw = () => a.content.toJSON().children;
    const read = (id) => outline.readOutline(a).flatMap(function walk(n) { return [n, ...n.children.flatMap(walk)]; }).find((n) => n.id === id);
    const step = (fn) => { const r = fn(); assert.deepEqual(outline.readOutline(b), outline.readOutline(a), 'peer converges'); return r; };
    const runs = (block, i = 0) => a.content.get('children').get(block).get('children').get(i).toDelta();

    // read: a LoroText delta splits into one segment per mark run; a link segment carries its href
    assert.deepEqual(read('6s8vb70s').segments, [
      { text: 'Imported from ' },
      { text: 'Tana Outliner', marks: { link: 'tana:EXAMPLE12345' } },
      { text: ' on 2026-09-09.\nOutliner ID: EXAMPLE12345' },
    ], 'marks are read from the text delta');
    assert.equal(read('6s8vb70s').block, 'paragraph');
    assert.equal(read('dv8c4sp7').block, 'heading2');

    // write: marks are applied without touching the text, so the run containers and a mention survive
    const container = a.content.get('children').get(2).get('children').get(0).id;
    const mentionId = a.content.get('children').get(2).get('children').get(1).id;
    const withMarks = [{ text: 'The ', marks: { bold: true } }, { mention: { label: 'sample agreement review', uri: 'tana:text:01examplet0000000000000000' } }, { text: ' tail', marks: { italic: true, link: 'https://example.test' } }];
    step(() => outline.setText(a, 'r4hz3a0b', withMarks));
    assert.deepEqual(read('r4hz3a0b').segments, withMarks, 'marks round-trip through setText');
    assert.equal(a.content.get('children').get(2).get('children').get(0).id, container, 'text container updated in place');
    assert.equal(a.content.get('children').get(2).get('children').get(1).id, mentionId, 'mention kept');
    assert.deepEqual(runs(2)[0].attributes, { bold: {} }, 'Tana stores a plain mark as an empty object');
    assert.deepEqual(runs(2, 2)[0].attributes.link, { href: 'https://example.test' }, 'a link stores its ProseMirror attrs');
    step(() => outline.setText(a, 'r4hz3a0b', [{ text: 'The ' }, withMarks[1], { text: ' tail', marks: { italic: true, link: 'https://example.test' } }]));
    assert.deepEqual(read('r4hz3a0b').segments[0], { text: 'The ' }, 'dropping a mark unmarks that run only');
    assert.deepEqual(read('r4hz3a0b').segments[2].marks, { italic: true, link: 'https://example.test' }, 'other marks untouched');
    // an edit that only changes text keeps the marks of the characters it did not touch
    step(() => outline.setText(a, '6s8vb70s', read('6s8vb70s').text + '!'));
    assert.ok(runs(0).some((d) => d.attributes && d.attributes.link), 'link survives a plain-string edit');

    // block types: each one is a container plus a leaf, and the blockId and inline content survive every hop
    const child = outline.insertChild(a, 'r4hz3a0b', 'Child');
    assert.equal(read('r4hz3a0b').block, 'bullet', 'a listItem paragraph reads as a bullet');
    step(() => outline.setBlockType(a, 'r4hz3a0b', 'numbered'));
    assert.equal(raw()[2].nodeName, 'orderedList');
    assert.equal(read('r4hz3a0b').block, 'numbered');
    assert.deepEqual(read('r4hz3a0b').children.map((n) => n.id), [child], 'a numbered item keeps its children');
    step(() => outline.setBlockType(a, 'r4hz3a0b', 'heading1'));
    assert.equal(read('r4hz3a0b').block, 'heading1');
    assert.equal(read('r4hz3a0b').heading, 1);
    assert.equal(raw()[2].nodeName, 'heading', 'a heading is a bare block');
    assert.equal(read(child).block, 'bullet', 'children a heading cannot own are outdented, not lost');
    step(() => outline.setBlockType(a, 'r4hz3a0b', 'quote'));
    assert.equal(raw()[2].nodeName, 'blockquote');
    assert.equal(raw()[2].children[0].attributes.blockId, 'r4hz3a0b', 'the node keeps its id inside the quote');
    assert.equal(read('r4hz3a0b').block, 'quote');
    assert.equal(read('r4hz3a0b').heading, undefined, 'the heading level is cleared');
    assert.deepEqual(read('r4hz3a0b').segments[1], withMarks[1], 'the mention survives the conversions');
    step(() => outline.setBlockType(a, 'r4hz3a0b', 'code'));
    assert.equal(raw()[2].nodeName, 'codeBlock', 'a code block leaves the quote behind');
    assert.deepEqual(raw()[2].children, ['The sample agreement review tail'], 'code holds plain text only');
    assert.deepEqual(read('r4hz3a0b').segments, [{ text: 'The sample agreement review tail' }], 'no marks inside code');
    step(() => outline.setBlockType(a, 'r4hz3a0b', 'paragraph'));
    assert.equal(read('r4hz3a0b').block, 'paragraph');
    assert.throws(() => outline.setBlockType(a, 'r4hz3a0b', 'heading4'), /Unknown block type/);
    assert.throws(() => outline.setBlockType(a, 'nope0000', 'quote'), /no outline node/);

    // What a new row is: the row it comes from, on either side of it. A document's own first row has nothing to
    // follow, so it is plain text, and every row after it inherits — which is what makes a document plain text
    // until a "- " starts a list in it.
    {
      const walk = (list) => list.flatMap((n) => [n, ...walk(n.children || [])]);
      const typeOf = (doc, id) => (walk(outline.readOutline(doc)).find((n) => n.id === id) || {}).block;
      const d = new Document('tana:text:' + ulid(), { peerId: '7' });
      const first = outline.insertAfter(d, null, 'First');
      assert.equal(typeOf(d, first), 'paragraph', 'the first row of a document is plain text');
      // unless the caller asks for a list row: expanding a row is asking it to hold sub-items, and the draft the
      // renderer shows for that is a bullet, so the write has to be one too or the row changes shape when typed into
      assert.equal(typeOf(d, outline.insertAfter(d, null, 'Asked for', false, 'bullet')), 'bullet', 'a row asked to open onto a list gets one');
      assert.equal(typeOf(d, outline.insertAfter(d, null, 'Not asked', false, null)), 'paragraph', 'and nothing else changes');
      assert.equal(typeOf(d, outline.insertAfter(d, first, 'Next')), 'paragraph', 'and so is the row after it');
      const listed = outline.insertAfter(d, null, 'Listed');
      outline.setBlockType(d, listed, 'bullet');
      assert.equal(typeOf(d, outline.insertAfter(d, listed, 'Also listed')), 'bullet', 'a bullet makes another bullet');
      assert.equal(typeOf(d, outline.insertBefore(d, listed, 'Above it')), 'bullet', 'on either side of it');
      const numbered = outline.insertAfter(d, null, 'One');
      outline.setBlockType(d, numbered, 'numbered');
      assert.equal(typeOf(d, outline.insertAfter(d, numbered, 'Two')), 'numbered', 'and a numbered item stays numbered');
      const quoted = outline.insertAfter(d, null, 'Quoted');
      outline.setBlockType(d, quoted, 'quote');
      assert.equal(typeOf(d, outline.insertAfter(d, quoted, 'Still quoted')), 'quote', 'Enter inside a quote stays in the quote');
      const head = outline.insertAfter(d, null, 'A heading');
      outline.setBlockType(d, head, 'heading2');
      assert.equal(typeOf(d, outline.insertAfter(d, head, 'Under a heading')), 'paragraph', 'a heading continues as the plain text that follows one');
      assert.equal(typeOf(d, outline.insertBefore(d, head, '')), 'paragraph', 'and a row pushed in front of one is plain text too');
      assert.equal(typeOf(d, head), 'heading2', 'the heading itself is untouched');
      const outliner = d; // the rest of this block reads the same document

      // Only a document's own row can be plain text: a child lives inside its parent's listItem, where a bare
      // paragraph is not a row Tana reads back, and the conversion would move it out of the list its parent keeps
      // its children in.
      const parent = outline.insertAfter(outliner, null, 'Parent', { bullet: true });
      const kid = outline.insertChild(outliner, parent, 'Child');
      const untouched = JSON.stringify(outliner.content.toJSON());
      assert.throws(() => outline.setBlockType(outliner, kid, 'paragraph'), /child node cannot be plain text/, 'a child node refuses plain text');
      assert.equal(JSON.stringify(outliner.content.toJSON()), untouched, 'and the refusal leaves the outline exactly as it was');
      outline.setBlockType(outliner, kid, 'numbered');
      assert.equal(typeOf(outliner, kid), 'numbered', 'a child can still change between list kinds');
      assert.deepEqual(walk(outline.readOutline(outliner)).find((n) => n.id === parent).children.map((n) => n.id), [kid], 'and it is still its parent\'s child');
      outline.setBlockType(outliner, parent, 'paragraph');
      assert.equal(typeOf(outliner, parent), 'paragraph', "a document's own row is still free to be plain text");
    }

    // A child row that is a bare block — a heading among its parent's children rather than a listItem — takes its
    // holder from the grandparent list, so an index in its own list means nothing to the code that splits that
    // list: changing its kind used to move it out to the document root, a divider asked for beside it landed there
    // too, and making it a bullet left it a bare paragraph, the one shape a child row may not be.
    {
      const bare = new Document('tana:text:01examplem0000000000000000', { peerId: '748' });
      const parent = outline.insertAfter(bare, null, 'A');
      const child = outline.insertChild(bare, parent, 'H');
      outline.setBlockType(bare, child, 'heading1');
      const childrenOf = () => (outline.readOutline(bare)[0].children || []).map((n) => n.id);
      assert.deepEqual(childrenOf(), [child], 'a child made a heading is still a child');
      for (const type of ['numbered', 'quote', 'code']) {
        outline.setBlockType(bare, child, type);
        assert.deepEqual(childrenOf(), [child], 'a bare child row stays its parent\'s child when it becomes ' + type);
        assert.equal(outline.readOutline(bare)[0].children[0].block, type);
      }
      outline.setBlockType(bare, child, 'bullet');
      assert.equal(bare.content.toJSON().children[0].children[0].children[1].nodeName, 'bulletList', 'and becomes a real list row rather than a bare paragraph beside its parent');
      outline.setBlockType(bare, child, 'heading1');
      const beside = outline.insertDivider(bare, child);
      assert.deepEqual(childrenOf(), [child, beside], 'a divider beside a bare child row lands beside it, not at the document root');
    }

    // divider: Tana's childless horizontalRule; a list holds listItems only, so it splits the list
    const second = outline.insertAfter(a, child, 'Second');
    const rule = step(() => outline.insertDivider(a, child));
    const rules = raw().filter((x) => x.nodeName === 'horizontalRule');
    assert.equal(rules.length, 1);
    assert.equal(rules[0].attributes.blockId, rule);
    assert.equal(rules[0].children, undefined, 'an atom has no children list');
    assert.deepEqual(outline.readOutline(a).map((n) => n.id).slice(-3), [child, rule, second], 'the rule sits between the two items');
    const divider = read(rule);
    assert.equal(divider.block, 'divider');
    assert.equal(divider.editable, false);
    assert.equal(divider.text, '');
    // a hardBreak is an inline line break: it must not cost the block its marks and mentions
    {
      const para = a.content.get('children').get(0).get('children');
      a.transact(() => { const br = para.insertContainer(1, new LoroMap()); br.set('nodeName', 'hardBreak'); br.setContainer('attributes', new LoroMap()); });
      const segs = read('6s8vb70s').segments;
      assert.ok(segs.some((s) => s.text === '\n'), 'the break reads as a newline segment');
      assert.ok(segs.some((s) => s.marks && s.marks.link), 'marks survive a hardBreak in the block');
    }
    assert.deepEqual(b.content.toJSON(), a.content.toJSON(), 'both peers hold the same content');
    console.log('ok  outline marks/setBlockType/insertDivider');
  }
  // main: the formatting mutations are reachable over IPC and validated there
  {
    const { handlers } = mainHelpers();
    for (const channel of ['block:setBlockType', 'block:insertDivider']) assert.ok(handlers.has(channel), channel + ' is registered');
  }
  // A meeting's call link for the sidebar: the join url out of a calendar location that may also name a room.
  {
    const { callOf, writeUpOf } = require('../sdk/events');
    assert.deepEqual({ ...callOf({ location: 'https://meet.tana.inc/abc-defg-hij' }) }, { url: 'https://meet.tana.inc/abc-defg-hij', label: 'meet.tana.inc/abc-defg-hij' });
    assert.equal(callOf({ location: 'https://meet.google.com/klm-nopq-rst/' }).label, 'meet.google.com/klm-nopq-rst');
    const zoom = callOf({ location: '+Main Building 6.1a-R1 Presentationroom; https://example.zoom.us/j/653?pwd=AR8&from=addon' });
    assert.equal(zoom.url, 'https://example.zoom.us/j/653?pwd=AR8&from=addon', 'the passcode stays in the url');
    assert.equal(zoom.label, 'example.zoom.us/j/653', 'the room note and the query stay out of the label');
    assert.equal(callOf({ location: 'Main Campus, Building B, Room 12' }), undefined, 'a room is not a call');
    assert.equal(callOf({}), undefined, 'no location, no call');
    const teams = callOf({ location: 'Teams meeting', actionUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_' + 'z'.repeat(140) + '%40thread.v2/0' });
    assert.equal(teams.label, 'teams.microsoft.com', 'a join path of ids is not a label');
    assert.match(teams.url, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//, 'the provider link is kept whole');
    assert.equal(callOf({ location: 'https://meet.tana.inc/a-b-c', actionUrl: 'https://zoom.us/j/1' }).label, 'meet.tana.inc/a-b-c', 'the location wins over the action');
    // the write-up: the owned page titled with the tagline, else the owned page with Tana's sketch; never a task
    const page = (id, title, extra) => ({ id: 'tana:text:' + id.padEnd(26, '0'), title, ...extra });
    const tagged = page('a', 'Plan', {}), sketched = page('b', 'Other', { appearance: { imageUri: 'tana:image:x' } }), task = page('c', 'Plan', { state: { type: 'open' } });
    const event = { calendarEvent: { tagline: 'Plan' } };
    assert.equal(writeUpOf(event, [task, sketched, tagged]), tagged, 'the tagline names the write-up, and a task of that title is not it');
    assert.equal(writeUpOf({}, [task, sketched, tagged]), sketched, 'without a tagline the sketch does');
    assert.equal(writeUpOf(event, [task, page('d', 'Plan elsewhere', {})]), null, 'and with neither signal there is none');
    assert.equal(writeUpOf(event, [{ id: 'tana:event:' + '0'.repeat(26), title: 'Plan' }]), null, 'only a text document is a write-up');
  }
  // A multi-select is one user action: one undo/redo step restores/reapplies its complete range.
  {
    // A document read from Tana has no UndoManager until its first local edit (sdk/document.js transact): one that
    // exists during the snapshot import makes Loro decode the whole document there. The first edit after such an
    // import is still one undo step, written under this document's own peer id, and the import itself is not undoable.
    const tana = new Document(DOC, { peerId: '739' });
    const row = outline.insertAfter(tana, null, 'From Tana');
    const read = new Document(DOC, { peerId: '740' });
    read.applyRemote([tana.exportSince()]);
    assert.equal(read.undoManager, null, 'reading a document makes no UndoManager');
    assert.deepEqual([read.canUndo(), read.canRedo(), read.undo(), read.redo()], [false, false, false, false], 'and there is nothing to undo');
    outline.setText(read, row, 'Edited here');
    assert.equal(read.loro.peerIdStr, '740', 'the edit is written under the peer id set before the UndoManager existed');
    assert.equal(read.undo(), true);
    assert.deepEqual(outline.readOutline(read).map((n) => n.text), ['From Tana'], 'the first edit after a lazy import undoes');
    assert.equal(read.canUndo(), false, 'and the import is not an undo step');
    assert.equal(read.redo(), true);
    assert.deepEqual(outline.readOutline(read).map((n) => n.text), ['Edited here']);

    const d = new Document(DOC, { peerId: '741' });
    const a = outline.insertAfter(d, null, 'Detail A');
    const b = outline.insertAfter(d, a, 'Detail B');
    outline.removeMany(d, [a, b]);
    assert.deepEqual(outline.readOutline(d), []);
    assert.equal(d.undo(), true);
    assert.deepEqual(outline.readOutline(d).map((n) => n.text), ['Detail A', 'Detail B']);
    assert.equal(d.redo(), true);
    assert.deepEqual(outline.readOutline(d), []);
    // A selection to delete is a set of rows, whatever levels they sit on: selecting a row and something inside
    // it, or rows under two different parents, is an ordinary thing to do, and refusing it left the rows gone
    // from the screen and still in the document.
    {
      const doc = new Document(DOC, { peerId: '743' });
      const top = outline.insertAfter(doc, null, 'sdfdfsg');
      const child = outline.insertChild(doc, top, 'dsfsdgsfd');
      const second = outline.insertAfter(doc, top, 'second');
      const under = outline.insertChild(doc, second, 'under second');
      outline.removeMany(doc, [top, child]); // a row and something inside it
      assert.deepEqual(outline.readOutline(doc).map((n) => n.text), ['second'], 'the row goes, and what was inside it goes with it');
      assert.equal(doc.undo(), true);
      assert.deepEqual(outline.readOutline(doc).map((n) => n.text), ['sdfdfsg', 'second'], 'and one undo brings the whole selection back');
      assert.deepEqual(outline.readOutline(doc)[0].children.map((n) => n.text), ['dsfsdgsfd']);
      const rows = outline.readOutline(doc);
      outline.removeMany(doc, [rows[0].children[0].id, under]); // rows under two different parents
      assert.deepEqual(outline.readOutline(doc).map((n) => [n.text, (n.children || []).length]), [['sdfdfsg', 0], ['second', 0]],
        'and a selection spanning two parents takes one row out of each');
      assert.equal(doc.undo(), true);
      assert.deepEqual(outline.readOutline(doc).map((n) => (n.children || []).map((c) => c.text)), [['dsfsdgsfd'], ['under second']], 'as one step');
      // moving, indenting and outdenting still carry the rows as one block, so those do need siblings
      assert.throws(() => outline.moveMany(doc, [outline.readOutline(doc)[0].id, outline.readOutline(doc)[0].children[0].id], 'down'), /siblings/);
      assert.throws(() => outline.indentMany(doc, [outline.readOutline(doc)[0].id, outline.readOutline(doc)[0].children[0].id]), /siblings/);
    }

    const m = new Document(DOC, { peerId: '742' });
    const first = outline.insertAfter(m, null, 'A');
    const second = outline.insertAfter(m, first, 'B');
    const third = outline.insertAfter(m, second, 'C');
    outline.insertAfter(m, third, 'D');
    outline.moveMany(m, [second, third], 'down');
    assert.deepEqual(outline.readOutline(m).map((n) => n.text), ['A', 'D', 'B', 'C']);
    assert.equal(m.undo(), true);
    assert.deepEqual(outline.readOutline(m).map((n) => n.text), ['A', 'B', 'C', 'D']);
    assert.equal(m.redo(), true);
    assert.deepEqual(outline.readOutline(m).map((n) => n.text), ['A', 'D', 'B', 'C']);
    console.log('ok  atomic multi-remove/move undo and redo');
  }
  // Enter is one user action too: the truncation and the new node are one transaction, and Enter at the very
  // start of a node puts the empty row in front instead of moving the text out of the node.
  {
    const d = new Document(DOC, { peerId: '744' });
    const a = outline.insertAfter(d, null, 'left-right');
    const rest = outline.split(d, a, 'left', [{ text: '-right' }, { mention: { uri: 'tana:text:x', label: 'Ref' } }]);
    assert.deepEqual(outline.readOutline(d).map((n) => n.text), ['left', '-rightRef'], 'the caret splits the node in two');
    assert.equal(d.undo(), true);
    assert.deepEqual(outline.readOutline(d).map((n) => n.text), ['left-right'], 'one undo restores both halves');
    assert.equal(d.redo(), true);
    assert.deepEqual(outline.readOutline(d).map((n) => n.text), ['left', '-rightRef']);
    const child = outline.split(d, rest, '-rightRef', 'tail', true);
    assert.deepEqual(outline.readOutline(d).at(-1).children.map((n) => n.text), ['tail'], 'an open node takes the rest as its first child');
    assert.equal(d.undo(), true);
    assert.deepEqual(outline.readOutline(d).at(-1).children, [], 'and undoes in one step as well');
    assert.ok(child);
    // Backspace at the start of a row reverses it: the row above takes the words, and one undo brings the row back.
    outline.join(d, rest, a, [{ text: 'left-right' }, { mention: { uri: 'tana:text:x', label: 'Ref' } }]);
    assert.deepEqual(outline.readOutline(d).map((n) => n.text), ['left-rightRef'], 'join puts the words back in the row above and the row goes');
    assert.equal(outline.readOutline(d)[0].segments.at(-1).mention.uri, 'tana:text:x', 'mentions and all');
    assert.equal(d.undo(), true);
    assert.deepEqual(outline.readOutline(d).map((n) => n.text), ['left', '-rightRef'], 'one undo brings the row back whole');
    const parent = outline.insertAfter(d, rest, 'parent');
    outline.insertChild(d, parent, 'kept');
    assert.throws(() => outline.join(d, parent, rest, '-rightRefparent'), /children/, 'a row with children is not joined: its children would go with it');
    assert.deepEqual(outline.readOutline(d).map((n) => n.text), ['left', '-rightRef', 'parent'], 'and nothing is written');
    d.undo(); d.undo();

    outline.insertBefore(d, a, '');
    const rows = outline.readOutline(d);
    assert.deepEqual(rows.map((n) => n.text), ['', 'left', '-rightRef'], 'Enter at the start leaves the node and its children alone');
    assert.equal(d.undo(), true);
    assert.deepEqual(outline.readOutline(d).map((n) => n.text), ['left', '-rightRef']);
    console.log('ok  atomic split undo/redo and insert-before');
  }
  // The same for a whole indented range: one transaction, so Tab on a selection is one undo step, not one per row.
  {
    const d = new Document(DOC, { peerId: '743' });
    const a = outline.insertAfter(d, null, 'A');
    const b = outline.insertAfter(d, a, 'B');
    const c = outline.insertAfter(d, b, 'C');
    const depth = (rows, want, level = 0) => rows.flatMap((n) => [[n.text, level], ...depth(n.children || [], want, level + 1)]);
    outline.indentMany(d, [b, c]);
    assert.deepEqual(depth(outline.readOutline(d)), [['A', 0], ['B', 1], ['C', 1]], 'each row follows the one above it');
    assert.equal(d.undo(), true);
    assert.deepEqual(depth(outline.readOutline(d)), [['A', 0], ['B', 0], ['C', 0]], 'one undo step for the whole range');
    assert.equal(d.redo(), true);
    assert.deepEqual(depth(outline.readOutline(d)), [['A', 0], ['B', 1], ['C', 1]]);
    outline.outdentMany(d, [b, c]);
    assert.deepEqual(depth(outline.readOutline(d)), [['A', 0], ['B', 0], ['C', 0]]);
    assert.equal(d.undo(), true);
    assert.deepEqual(depth(outline.readOutline(d)), [['A', 0], ['B', 1], ['C', 1]], 'one undo step for the whole outdent');
    assert.throws(() => outline.indentMany(d, [b, b]), /duplicate or invalid/);
    assert.throws(() => outline.outdentMany(d, []), /at least one node/);
    console.log('ok  atomic multi-indent/outdent undo and redo');
  }
  // A drag names the place outright (docs/OUTLINER.md): behind a row, at the top of a row's children, or at the
  // top of an outline — and the outline it lands in may be a field of the same document, which is a second root
  // of the same Loro document rather than a second document.
  {
    const fieldsSdk = require('../sdk/fields');
    const d = new Document(DOC, { peerId: '746' });
    const shape = (rows, level = 0) => rows.flatMap((n) => [[n.text, level], ...shape(n.children || [], level + 1)]);
    const a = outline.insertAfter(d, null, 'A');
    const b = outline.insertAfter(d, a, 'B');
    const c = outline.insertChild(d, b, 'C');
    assert.deepEqual(shape(outline.readOutline(d)), [['A', 0], ['B', 0], ['C', 1]]);
    outline.moveTo(d, b, {}); // neither: the top of the outline, with its child
    assert.deepEqual(shape(outline.readOutline(d)), [['B', 0], ['C', 1], ['A', 0]], 'a row moves with everything under it');
    assert.equal(d.undo(), true);
    assert.deepEqual(shape(outline.readOutline(d)), [['A', 0], ['B', 0], ['C', 1]], 'one undo step for the whole move');
    outline.moveTo(d, c, { afterId: a }); // out of B, behind a bare paragraph: a list row brings a list with it
    assert.deepEqual(shape(outline.readOutline(d)), [['A', 0], ['C', 0], ['B', 0]], 'a child dropped at the top level lands behind the row it was dropped on');
    assert.equal(d.content.toJSON().children.length, 2, 'and joins the list already there rather than starting a second one');
    outline.moveTo(d, c, { parentId: b }); // and back in, as B's first row
    assert.deepEqual(shape(outline.readOutline(d)), [['A', 0], ['B', 0], ['C', 1]]);
    assert.throws(() => outline.moveTo(d, b, { parentId: c }), /inside itself/, 'a row cannot be dropped into its own subtree');
    assert.throws(() => outline.moveTo(d, b, { afterId: b }), /inside itself/);
    const heading = outline.insertAfter(d, null, 'Heading');
    outline.setBlockType(d, heading, 'heading2');
    const before = JSON.stringify(d.content.toJSON());
    assert.throws(() => outline.moveTo(d, heading, { parentId: b }), /list item/, 'a heading cannot become a list row');
    assert.equal(JSON.stringify(d.content.toJSON()), before, 'and the refusal leaves the outline exactly as it was');
    outline.moveTo(d, heading, { afterId: c }); // beside a list row it is fine: the list splits and the heading stands after it
    assert.deepEqual(shape(outline.readOutline(d)), [['A', 0], ['B', 0], ['C', 1], ['Heading', 1]], 'a heading dropped beside a list row splits the list instead of joining it');
    assert.equal(d.undo(), true);
    assert.deepEqual(shape(outline.readOutline(d)), [['A', 0], ['B', 0], ['C', 1], ['Heading', 0]]);
    // the page and one of its fields, in both directions: one document, so one transaction and one undo step
    const KEY = 'tana:type:01j0typ000000000000000000?attribute=n5e1hgxz';
    const field = fieldsSdk.fieldView(d, KEY, { create: true });
    const line = outline.insertAfter(field, null, 'Stan Engbers');
    outline.moveTo(field, a, { afterId: line, from: d });
    assert.deepEqual(outline.readOutline(field).map((n) => n.text), ['Stan Engbers', 'A'], 'a page row dropped in a field lands in the field');
    assert.ok(!outline.readOutline(d).some((n) => n.text === 'A'), 'and leaves the page');
    assert.equal(d.undo(), true);
    assert.deepEqual([outline.readOutline(field).map((n) => n.text), outline.readOutline(d)[0].text], [['Stan Engbers'], 'A'], 'one undo puts it back');
    outline.moveTo(d, line, { parentId: b, from: field });
    assert.deepEqual(shape(outline.readOutline(d)).slice(0, 4), [['A', 0], ['B', 0], ['Stan Engbers', 1], ['C', 1]], 'and a field row can be dropped into the page');
    assert.deepEqual(outline.readOutline(field).map((n) => n.text), [], 'the field keeps only what is left of it');
    // A row dropped out of somebody's children onto the level above: the list it lands in is split open to take it,
    // and that split carries the very item the row is living inside, so a copy-then-remove left the row in the
    // outline twice and threw on the container it had just deleted.
    {
      const nested = new Document('tana:text:01examplen0000000000000000', { peerId: '749' });
      const y = outline.insertAfter(nested, null, 'Y');
      outline.setBlockType(nested, y, 'bullet');
      const x = outline.insertAfter(nested, y, 'X');
      const p = outline.insertChild(nested, x, 'P');
      outline.setBlockType(nested, p, 'heading1');
      assert.deepEqual(shape(outline.readOutline(nested)), [['Y', 0], ['X', 0], ['P', 1]]);
      outline.moveTo(nested, p, { afterId: y });
      assert.deepEqual(shape(outline.readOutline(nested)), [['Y', 0], ['P', 0], ['X', 0]], 'a bare child row dropped beside its parent lands there once, and leaves its parent');
    }
    console.log('ok  moveTo: a row lands where a drag says, with its children, across a page and its fields, in one undo step');
  }
  // What a row is decides what it stays. Text dropped among a document's own rows is still text — the list splits
  // around it rather than swallowing it — while a child is a list row whatever it was, because that is the only
  // child Tana's schema has. And a document dropped into an outline lands as a reference to itself.
  {
    const d = new Document(DOC, { peerId: '747' });
    const kinds = () => outline.readOutline(d).map((n) => [n.text, n.block]);
    const one = outline.insertAfter(d, null, 'one');
    const first = outline.insertAfter(d, one, 'bullet A');
    outline.setBlockType(d, first, 'bullet');
    outline.insertAfter(d, first, 'bullet B');
    const text = outline.insertAfter(d, null, 'text');
    outline.moveTo(d, text, { afterId: first }); // between the two bullets, at the document's own level
    assert.deepEqual(kinds(), [['one', 'paragraph'], ['bullet A', 'bullet'], ['text', 'paragraph'], ['bullet B', 'bullet']],
      'a text row dropped between two bullets stays text, and the list splits around it');
    outline.moveTo(d, text, { parentId: first });
    assert.deepEqual(outline.readOutline(d)[1].children.map((n) => [n.text, n.block]), [['text', 'bullet']],
      'dropped inside a row it is a list row, which is the only child this schema has');
    const ref = outline.insertMention(d, { uri: 'tana:text:01examplet0000000000000000', label: 'Sample' }, { afterId: one });
    const row = outline.readOutline(d)[1];
    assert.equal(row.id, ref);
    assert.deepEqual(row.segments, [{ mention: { label: 'Sample', uri: 'tana:text:01examplet0000000000000000' } }], 'a reference is one row whose whole content is a mention');
    assert.equal(row.text, 'Sample', 'which reads as the label it was written with');
    assert.equal(d.undo(), true);
    assert.equal(outline.readOutline(d).length, 3, 'and it is one undo step of its own');
    console.log('ok  a dropped text row keeps its kind, a dropped child becomes a list row, and a dropped document lands as a reference');
  }
  // 3c. Image blocks (docs/OUTLINER.md §5): { nodeName 'image', attributes { blockId, tanaUri, displayWidth?, displayHeight? }, children [] }
  //     as seen in tana:text:01exampleu0000000000000000; read as { type 'image', image }, removable and movable like any block.
  {
    const IMG = 'tana:image:01examplev0000000000000000';
    const first = outline.insertAfter(c1, null, 'Before image');
    c1.transact(() => {
      const list = c1.content.get('children');
      const m = list.insertContainer(list.length, new LoroMap());
      m.set('nodeName', 'image');
      const a = m.setContainer('attributes', new LoroMap());
      a.set('blockId', 'img00001'); a.set('tanaUri', IMG); a.set('displayWidth', 640);
      m.setContainer('children', new LoroList());
    });
    const o = outline.readOutline(c1), img = o[o.length - 1];
    assert.deepEqual(img, { id: 'img00001', text: '', kind: 'block', hasChildren: false, children: [], segments: [], type: 'image', image: { uri: IMG, alt: null, width: 640, height: null } });
    assert.equal(o[o.length - 2].type, undefined, 'paragraphs carry no type');
    assert.equal(img.block, undefined, 'an image on its own has no block type, so it draws no marker: it is the picture and nothing else');
    // a list row is a list row whatever it holds, which is what says whether it draws one: the same picture
    // inside a listItem reads as a bullet, so a child keeps the marker its siblings have
    {
      const listed = new Document('tana:text:' + ulid());
      const rowId = outline.insertAfter(listed, null, '');
      outline.setBlockType(listed, rowId, 'bullet');
      listed.transact(() => {
        const inner = listed.content.get('children').get(0).get('children').get(0).get('children').get(0); // bulletList > listItem > paragraph
        inner.set('nodeName', 'image');
        inner.get('attributes').set('tanaUri', IMG);
      });
      const row = outline.readOutline(listed)[0];
      assert.equal(row.type, 'image', 'the row is the picture');
      assert.equal(row.block, 'bullet', 'and reads as the list row it is, so it keeps its marker');
    }
    step(() => outline.move(c1, 'img00001', 'up'));
    assert.deepEqual(outline.readOutline(c1).slice(-2).map((n) => n.id), ['img00001', first]);
    step(() => outline.remove(c1, 'img00001'));
    step(() => outline.remove(c1, first));
    assert.equal(outline.readOutline(c1).some((n) => n.type === 'image'), false);
    console.log('ok  image blocks (readOutline/move/remove)');
  }
  // 3d. Asset fetch: bearer GET /images/by-uri -> 302 + Cloud-CDN-Cookie -> signed URL with that cookie (sdk/assets.js)
  {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push([url, init.headers]);
      if (url.startsWith('https://api.test/images/by-uri/')) {
        if (init.headers.authorization === 'Bearer stale') return new Response(null, { status: 401 });
        return new Response(null, { status: 302, headers: { location: 'https://cdn.test/signed', 'set-cookie': 'Cloud-CDN-Cookie=abc:Expires=1; Path=/; Secure' } });
      }
      if (init.headers.cookie !== 'Cloud-CDN-Cookie=abc:Expires=1') return new Response('403', { status: 403 });
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } });
    };
    let tokens = ['stale', 'fresh'];
    const { mime, bytes } = await fetchImage('tana:image:01examplev0000000000000000', { baseUrl: 'https://api.test', fetch: fakeFetch, getAccessToken: async ({ refresh }) => (refresh ? 'fresh' : tokens[0]) });
    assert.equal(mime, 'image/png');
    assert.equal(bytes.toString('hex'), '89504e47');
    assert.equal(calls.length, 3, '401 retried with a refreshed token, then the CDN');
    assert.equal(calls[0][0], 'https://api.test/images/by-uri/tana%3Aimage%3A01examplev0000000000000000');
    await assert.rejects(fetchImage('tana:text:01examplew0000000000000000', { fetch: fakeFetch, getAccessToken: async () => 'x' }), /not a tana:image uri/);
    console.log('ok  image asset fetch (redirect + CDN cookie)');
  }
  // 3e. Upload (#28): multipart field `file` to /files/upload with the bearer token, one retry on 401, over 50 MB refused
  //     before sending; the tana:image: data map as LoroImage.create writes it; the image block beside a row, as its kind.
  {
    const sent = [];
    const fakeFetch = async (url, init) => {
      const f = init.body.get('file');
      sent.push([url, init.method, init.headers.authorization, f.name, f.type, Buffer.from(await f.arrayBuffer()).toString('hex')]);
      if (init.headers.authorization === 'Bearer stale') return new Response(null, { status: 401 });
      if (f.name === 'bad.png') return new Response(JSON.stringify({ error: 'Unsupported file' }), { status: 400 });
      return Response.json({ cid: 'c1d', size: 4, width: 2, height: 2, blurhash: 'LEHV6n' });
    };
    const opts = { mimeType: 'image/png', baseUrl: 'https://api.test', fetch: fakeFetch, getAccessToken: async ({ refresh }) => (refresh ? 'fresh' : 'stale') };
    assert.deepEqual(await uploadFile(Buffer.from('89504e47', 'hex'), { ...opts, filename: 'a.png' }), { cid: 'c1d', size: 4, width: 2, height: 2, blurhash: 'LEHV6n' });
    assert.deepEqual(sent, [
      ['https://api.test/files/upload', 'POST', 'Bearer stale', 'a.png', 'image/png', '89504e47'],
      ['https://api.test/files/upload', 'POST', 'Bearer fresh', 'a.png', 'image/png', '89504e47'],
    ], 'the bytes go as form field file with their name and type; a 401 is retried once with a refreshed token');
    await assert.rejects(uploadFile(Buffer.from([1]), { ...opts, filename: 'bad.png', getAccessToken: async () => 'ok' }), /Unsupported file/, "the server's reason is the error");
    const before = sent.length;
    await assert.rejects(uploadFile({ length: UPLOAD_LIMIT + 1 }, { ...opts, filename: 'big.png' }), /max 50 MB/);
    assert.equal(sent.length, before, 'a file over the limit never leaves the machine');
    await assert.rejects(uploadFile(Buffer.from([1]), { ...opts, filename: 'a.png', getAccessToken: async () => 'stale' }), /signed out/, 'a token refused twice is a signed-out session, in Tana\'s words');
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(uploadFile(Buffer.from([1]), { ...opts, filename: 'a.png', signal: ctrl.signal, fetch: (url, init) => fetch(url, init) }), /abort/i, 'the signal reaches the request, so Esc stops an upload in flight');

    const OWNER = 'tana:text:01examplew0000000000000000', img = new Document('tana:image:' + ulid());
    img.transact(() => initImage(img.loro, { ownerUri: OWNER, cid: 'c1d', width: 2, height: 2, blurhash: 'LEHV6n', filename: 'a.png', mimeType: 'image/png', fileSize: 4, now: 1 }));
    assert.deepEqual(img.data.toJSON(), { type: 'image', createdAt: 1, ownerUri: OWNER, width: 2, height: 2, cid: 'c1d', filename: 'a.png', mimeType: 'image/png', blurhash: 'LEHV6n', fileSize: 4, createdInUri: OWNER });
    assert.throws(() => initImage(new Document('tana:image:' + ulid()).loro, { cid: 'c1d' }), /belongs to/, 'no ownerless image: Tana refuses to mint one');

    const IMG = 'tana:image:01examplev0000000000000000', d = new Document('tana:text:' + ulid());
    const para = outline.insertAfter(d, null, 'Para');
    const bare = outline.insertImage(d, para, IMG);
    const row = outline.insertAfter(d, bare, 'Item');
    outline.setBlockType(d, row, 'bullet');
    const listed = outline.insertImage(d, row, IMG);
    const last = outline.insertImage(d, null, IMG);
    assert.deepEqual(outline.readOutline(d).map((n) => [n.id, n.type || n.block]), [[para, 'paragraph'], [bare, 'image'], [row, 'bullet'], [listed, 'image'], [last, 'image']]);
    assert.equal(outline.readOutline(d)[3].block, 'bullet', 'after a list row the image is a list row of its own');
    const raw = d.content.get('children').get(1).toJSON();
    assert.deepEqual(raw, { nodeName: 'image', attributes: { blockId: bare, tanaUri: IMG } }, 'written as Tana writes an atom: no children, no display size');
    assert.throws(() => outline.insertImage(d, para, 'tana:text:01examplew0000000000000000'), /not a tana:image uri/);
    const first = outline.insertTable(d, para), t = outline.readOutline(d)[1];
    assert.equal(t.type, 'table', '"/" Table lands after its row');
    assert.deepEqual(t.table.rows.map((r) => r.map((c) => c.header)), [[true, true, true], [false, false, false], [false, false, false]], "Tana's 3x3 with a header row");
    assert.equal(first, t.table.rows[0][0].id, 'the caret goes to the first header cell');
    outline.insertTable(d, row);
    assert.equal(outline.readOutline(d)[5].block, 'bullet', 'after a list row the table is a list row of its own');
    console.log('ok  image upload, image document and image block (#28)');
  }
  // ---- undo/redo: local-only, ops flow out like any local change, the other document converges ----
  {
    const a = new Document('tana:text:undo', { peerId: '1' }), b = new Document('tana:text:undo', { peerId: '2' });
    a.on('local-update', (u) => b.applyRemote([u]));
    b.on('local-update', (u) => a.applyRemote([u]));
    a.transact((l) => { l.getMap('data').set('title', 'one'); });
    assert.equal(a.canUndo(), true);
    setTitle(a, 'two');
    outline.insertAfter(a, null, 'para', { bullet: true }); // list + item + paragraph, one undo step
    assert.equal(outline.readOutline(a).length, 1);
    assert.equal(a.undo(), true);
    assert.equal(outline.readOutline(a).length, 0);
    assert.equal(outline.readOutline(b).length, 0);
    assert.equal(a.undo(), true);
    assert.equal(a.data.get('title'), 'one');
    assert.equal(b.data.get('title'), 'one');
    b.transact((l) => { l.getMap('data').set('other', 'remote'); });
    assert.equal(a.redo(), true);
    assert.equal(a.data.get('title'), 'two');
    assert.equal(a.data.get('other'), 'remote');
    assert.equal(b.undo(), true);
    assert.equal(a.data.get('other'), undefined);
    assert.equal(a.redo(), true);
    assert.equal(outline.readOutline(b).length, 1);
    console.log('ok  undo/redo (local only, converges, survives concurrent edits)');
  }
  // 3c. Pins (docs/PINNING.md) over a fake sync: profile -> collection (LoroTree) + pin-map (entries map); every
  // mutation is replayed into a mirror Document so the shape the server sees is the shape we read back.
  {
    const { LoroMap } = require('loro-crdt');
    const COL = 'tana:collection:c1', PM = 'tana:pin-map:p1', A = 'tana:text:a', B = 'tana:text:b';
    const plainDatesOf = (pm, uri, key) => (pm.loro.getMap('entries').get(uri).toJSON()[key] || []).map((p) => p.datetime);
    const docs = {}, mirror = {};
    for (const id of [ME, COL, PM]) { docs[id] = new Document(id, { peerId: '21' }); mirror[id] = new Document(id, { peerId: '22' }); docs[id].on('local-update', (u) => mirror[id].applyRemote([u])); }
    const sync = { subscribed: [], subscribe: async (id) => { sync.subscribed.push(id); if (!docs[id]) throw new Error('document not found: ' + id); return docs[id]; } };
    await assert.rejects(pins.listSidebar(sync, ME), /no pinnedCollectionUri/, 'no lazy creation');
    docs[ME].transact((l) => { l.getMap('data').set('pinnedCollectionUri', COL); l.getMap('data').set('pinMapUri', PM); });
    // web-client layout: a pin, then a folder holding a pin
    docs[COL].transact((l) => { const t = l.getTree('tree'); t.createNode().data.set('uri', B); const f = t.createNode(); f.data.set('label', 'Folder'); t.createNode(f.id).data.set('uri', 'tana:space:s'); });
    const withoutIds = (nodes) => nodes.map(({ id, children, ...n }) => (assert.equal(typeof id, 'string'), { ...n, children: withoutIds(children) }));
    assert.deepEqual(withoutIds(await pins.sidebarTree(sync, ME)), [{ uri: B, children: [] }, { label: 'Folder', children: [{ uri: 'tana:space:s', children: [] }] }]);
    assert.deepEqual(await pins.listSidebar(sync, ME), [B, 'tana:space:s']);
    await pins.pinSidebar(sync, ME, A);
    await pins.pinSidebar(sync, ME, A); // dedup
    assert.deepEqual(await pins.listSidebar(sync, ME), [B, 'tana:space:s', A], 'appended at the end, in tree order');
    assert.deepEqual(mirror[COL].loro.getTree('tree').toJSON().map((n) => n.meta), [{ uri: B }, { label: 'Folder' }, { uri: A }]);
    await pins.unpinSidebar(sync, ME, B);
    await pins.unpinSidebar(sync, ME, 'tana:text:nope'); // no-op
    assert.deepEqual(await pins.listSidebar(sync, ME), ['tana:space:s', A]);
    assert.equal(mirror[COL].loro.getTree('tree').toJSON().length, 2, 'deleted node gone from the mirror tree');
    // Sections (#29), as Tana's placePin/addSection/renameSection/removeSection leave the tree the server sees.
    const served = () => { const f = (ns) => ns.map((n) => (n.meta.label !== undefined ? n.meta.label + '[' + f(n.children).join(',') + ']' : n.meta.uri)); return f(mirror[COL].loro.getTree('tree').toJSON()); };
    const [folder, pinA] = await pins.sidebarTree(sync, ME);
    const later = await pins.addSection(sync, ME, 'Later', { index: 0 });
    assert.deepEqual(served(), ['Later[]', 'Folder[tana:space:s]', A]);
    assert.equal(await pins.placePin(sync, ME, A, { section: later }), pinA.id, 'a pinned document moves, and keeps its node');
    await pins.placePin(sync, ME, B, { section: folder.id, index: 0 });
    assert.deepEqual(served(), ['Later[' + A + ']', 'Folder[' + B + ',tana:space:s]'], 'a new pin goes in at its position');
    await pins.placePin(sync, ME, B, { section: folder.id, index: 9 });
    assert.deepEqual(served(), ['Later[' + A + ']', 'Folder[tana:space:s,' + B + ']'], 'past the end is the end');
    await pins.placePin(sync, ME, B, { index: 0 });
    assert.deepEqual(served(), [B, 'Later[' + A + ']', 'Folder[tana:space:s]'], 'no section is the top level');
    await pins.renameSection(sync, ME, later, 'Soon');
    assert.equal(served()[1], 'Soon[' + A + ']');
    await assert.rejects(pins.renameSection(sync, ME, pinA.id, 'x'), /not a sidebar section/, 'a pin is not a section');
    await assert.rejects(pins.removeSection(sync, ME, null), /not a sidebar section/);
    await assert.rejects(pins.placePin(sync, ME, A, { section: '404@1' }), /not a sidebar section/);
    await assert.rejects(pins.placePin(sync, ME, A, { index: -1 }), /whole number/);
    await pins.removeSection(sync, ME, later);
    assert.deepEqual(served(), [B, 'Folder[tana:space:s]'], 'a removed section takes its pins with it');
    console.log('ok  sidebar sections: add, rename, remove, and pins placed or moved into them at a position');
    assert.deepEqual(await pins.dates(sync, ME, A), [], 'no entry yet');
    await assert.rejects(pins.pinDate(sync, ME, A, '2026-9-1'), /YYYY-MM-DD/);
    await pins.pinDate(sync, ME, A, '2026-09-13');
    await pins.pinDate(sync, ME, A, '2026-09-13'); // dedup
    await pins.pinDate(sync, ME, A, '2026-09-14');
    assert.deepEqual(await pins.dates(sync, ME, A), ['2026-09-13', '2026-09-14']);
    const entry = mirror[PM].loro.getMap('entries').get(A);
    assert.ok(entry instanceof LoroMap && entry.get('pins').get(0) instanceof LoroMap, 'entry and pins are containers, like the web client');
    assert.deepEqual(Object.keys(entry.toJSON()).sort(), ['mutedPins', 'pins']);
    assert.deepEqual(entry.toJSON().pins.map((p) => [p.type, p.datetime, typeof p.pinnedAt]), [['plain', '2026-09-13', 'number'], ['plain', '2026-09-14', 'number']]);
    // a muted date gets unmuted by pinning it
    docs[PM].transact((l) => { const m = l.getMap('entries').get(A).get('mutedPins').pushContainer(new LoroMap()); m.set('type', 'plain'); m.set('datetime', '2026-09-15'); });
    await pins.pinDate(sync, ME, A, '2026-09-15');
    assert.deepEqual(mirror[PM].loro.getMap('entries').get(A).toJSON().mutedPins, []);
    await pins.unpinDate(sync, ME, A, '2026-09-14');
    await pins.unpinDate(sync, ME, B, '2026-09-14'); // no entry: no-op
    assert.deepEqual(await pins.dates(sync, ME, A), ['2026-09-13', '2026-09-15']);
    // the same map read the other way round: which documents carry a date pin at all, for the pin mark on a row
    assert.deepEqual(await pins.datePinned(sync, ME), [A]);
    await pins.unpinDate(sync, ME, A, '2026-09-13');
    await pins.unpinDate(sync, ME, A, '2026-09-15');
    assert.deepEqual(await pins.datePinned(sync, ME), [], 'an entry left behind by its last unpin is not a pin');
    await pins.pinDate(sync, ME, A, '2026-09-13');
    assert.deepEqual(mirror[PM].toJSON(), docs[PM].toJSON());
    // Muted and shared dates (Tana's getEffectivePins): dates() is shared + personal - muted; datePins/datePinned are
    // the Today list (getEntitiesWithPinsInRange): personal - muted, no shared.
    docs[A] = new Document(A, { peerId: '23' }); mirror[A] = new Document(A, { peerId: '24' }); docs[A].on('local-update', (u) => mirror[A].applyRemote([u]));
    docs[A].transact((l) => initDocument(l, 'shared', ME));
    pins.pinSharedDate(docs[A], '2026-09-20');
    pins.pinSharedDate(docs[A], '2026-09-20'); // dedup
    assert.throws(() => pins.pinSharedDate(docs[A], 'today'), /YYYY-MM-DD/);
    assert.ok(mirror[A].loro.getMap('data').get('sharedPinDates').get(0) instanceof LoroMap, 'a shared pin is a map container, like the web client');
    assert.deepEqual(pins.sharedDates(mirror[A]), ['2026-09-20']);
    assert.deepEqual(await pins.dates(sync, ME, A), ['2026-09-13', '2026-09-20'], 'shared and personal, sorted');
    assert.deepEqual(await pins.datePins(sync, ME), { [A]: ['2026-09-13'] }, 'a shared date is not in the Today list');
    await pins.muteDate(sync, ME, A, '2026-09-20');
    await pins.muteDate(sync, ME, A, '2026-09-13');
    await pins.muteDate(sync, ME, A, '2026-09-13'); // dedup
    assert.deepEqual(mirror[PM].loro.getMap('entries').get(A).toJSON().mutedPins.map((p) => [p.type, p.datetime, typeof p.pinnedAt]), [['plain', '2026-09-20', 'number'], ['plain', '2026-09-13', 'number']]);
    assert.deepEqual(await pins.dates(sync, ME, A), [], 'muted hides shared and personal alike');
    assert.deepEqual(await pins.datePinned(sync, ME), [], 'a muted personal pin is off the Today list');
    await pins.unmuteDate(sync, ME, A, '2026-09-20');
    assert.deepEqual(await pins.dates(sync, ME, A), ['2026-09-20']);
    await pins.muteDate(sync, ME, B, '2026-09-20'); // a mute on a document with no entry creates the entry, as mutePin does
    assert.deepEqual(mirror[PM].loro.getMap('entries').get(B).toJSON().pins, []);
    pins.unpinSharedDate(docs[A], '2026-09-20');
    pins.unpinSharedDate(docs[A], '2026-09-21'); // no-op
    assert.deepEqual(pins.sharedDates(mirror[A]), []);
    // main's unpin: the personal pin goes, and a date the document still shares is muted for this user only
    const backend = mainHelpers();
    backend.testRuntime({ me: { userUri: ME }, client: { sync }, win: { isDestroyed: () => false, webContents: { send: () => {} } } });
    pins.pinSharedDate(docs[A], '2026-09-22');
    await pins.pinDate(sync, ME, A, '2026-09-22');
    await pins.pinDate(sync, ME, A, '2026-09-23');
    await backend.handlers.get('pins:unpin')(null, A, 'today', '2026-09-22');
    await backend.handlers.get('pins:unpin')(null, A, 'today', '2026-09-23');
    assert.deepEqual(await pins.dates(sync, ME, A), [], 'both unpinned days are gone from this user\'s view (the 13th is still muted)');
    assert.deepEqual(pins.sharedDates(mirror[A]), ['2026-09-22'], 'the shared pin stays for everyone else');
    assert.deepEqual(plainDatesOf(mirror[PM], A, 'mutedPins'), ['2026-09-13', '2026-09-22'], 'of the two, only the shared day is muted');
    await backend.handlers.get('pins:pin')(null, A, 'today', '2026-09-22');
    assert.deepEqual(plainDatesOf(mirror[PM], A, 'mutedPins'), ['2026-09-13'], 'pinning it again unmutes it');
    await backend.handlers.get('pins:unpin')(null, A, 'today', '2026-09-22');
    pins.unpinSharedDate(docs[A], '2026-09-22');
    assert.deepEqual(await pins.dates(sync, ME, B), [], 'an unreadable document has no shared dates');
    assert.deepEqual(mirror[PM].toJSON(), docs[PM].toJSON());
    assert.deepEqual([...new Set(sync.subscribed)].sort(), [ME, COL, PM, A, B].sort(), 'the profile, the two pointed documents, and the documents whose shared dates were read');
    console.log('ok  pins (sidebar tree, personal, muted and shared date pins, converge)');
  }
  // 3d. Items pinned *on* a meeting or a space: the hub's own pinnedItems MovableList (docs/PINNING.md section 4),
  // and main's nodePin gate around it. This is not the sidebar/date pins above.
  {
    const access = require('../sdk/access');
    const hubId = 'tana:event:' + ulid(), otherId = 'tana:space:' + ulid(), docId = 'tana:text:' + ulid();
    const hub = new Document(hubId, { peerId: '31' }), mirror = new Document(hubId, { peerId: '32' });
    hub.on('local-update', (u) => mirror.applyRemote([u]));
    hub.transact((l) => {
      initDocument(l, 'Rehearsal meeting', ME);
      const data = l.getMap('data');
      data.set('type', 'event'); data.set('restricted', true);
      const p = data.get('participants').setContainer(ME, new LoroMap()); p.set('type', 'user'); p.set('role', 'attendee');
    });
    assert.deepEqual(pins.items(hub), []);
    pins.pinItem(hub, docId);
    pins.pinItem(hub, docId); // dedup on uri, like the web client's jm()
    pins.pinItem(hub, otherId, 'embed');
    assert.deepEqual(pins.items(hub), [{ uri: docId }, { uri: otherId, mode: 'embed' }]);
    assert.ok(mirror.loro.getMovableList('pinnedItems').get(0) instanceof LoroMap, 'elements are map containers, like every schema element the web client writes');
    assert.deepEqual(mirror.loro.getMovableList('pinnedItems').toJSON(), pins.items(hub), 'converges');
    pins.unpinItem(hub, docId);
    pins.unpinItem(hub, 'tana:text:nope'); // no-op
    assert.deepEqual(pins.items(hub), [{ uri: otherId, mode: 'embed' }]);
    pins.pinItem(hub, otherId, 'document'); // native jm: a re-pin with a mode updates it in place
    assert.deepEqual(pins.items(hub), [{ uri: otherId, mode: 'document' }]);
    hub.transact((l) => { l.getMovableList('pinnedItems').pushContainer(new LoroMap()).set('uri', otherId); });
    assert.deepEqual(pins.items(hub), [{ uri: otherId, mode: 'document' }], 'a duplicate reads as its first copy (native Tue)');
    pins.unpinItem(hub, otherId); // native Mm drops every copy
    assert.deepEqual(pins.items(hub), []);
    pins.pinItem(hub, otherId, 'embed');
    // An attendee may write the event even though its title is read-only: editable() answers for the body, access
    // answers for the document. That gap is exactly what made the sidebar visibility row inert on a meeting.
    const ctx = { orgDocUri: 'tana:org:' + ulid(), sync: { subscribe: async () => { throw new Error('unavailable'); } }, graph: {} };
    assert.equal(await access.canWrite(readNode(hub), ME, ctx), true);
    assert.equal(require('../sdk/node').editable(readNode(hub), ME), false, 'an event body stays read-only');

    const backend = mainHelpers(), events = [];
    const stranger = 'tana:user-profile:' + ulid();
    const closed = new Document('tana:event:' + ulid());
    closed.transact((l) => { initDocument(l, 'someone else’s meeting', stranger); l.getMap('data').set('type', 'event'); l.getMap('data').set('restricted', true); });
    const plain = new Document(docId);
    plain.transact((l) => initDocument(l, 'a document, not a hub', ME));
    const documents = new Map([[hubId, hub], [closed.id, closed], [docId, plain]]);
    const claims = Buffer.from(JSON.stringify({ org_id: ORG, role: 'member' })).toString('base64url');
    backend.testRuntime({
      me: { userUri: ME, orgId: ORG, orgDocUri: ctx.orgDocUri },
      client: { sync: { getDocument: (id) => documents.get(id), subscribe: async (id) => { if (!documents.has(id)) throw new Error('not found'); return documents.get(id); } } },
      session: { getAccessToken: async () => 'head.' + claims + '.sig' },
      win: { isDestroyed: () => false, webContents: { send: (channel, id) => events.push([channel, id]) } },
    });
    await assert.rejects(backend.nodePin(docId, hubId, true), /meeting or a space/, 'only an event or a space has pinnedItems');
    await assert.rejects(backend.nodePin(hubId, 'not-a-uri', true), /Tana document id/);
    await assert.rejects(backend.nodePin(hubId, hubId, true), /cannot pin itself/);
    await assert.rejects(backend.nodePin(closed.id, docId, true), /Write permission/, 'no participant grant, no pin');
    assert.deepEqual(await backend.nodePin(hubId, docId, true), [otherId, docId]);
    assert.ok(events.some(([channel, id]) => channel === 'outline:changed' && id === hubId), 'the hub refreshes so the sidebar reloads its pins');
    assert.deepEqual(await backend.nodePin(hubId, docId, false), [otherId]);
    assert.deepEqual(pins.items(hub), [{ uri: otherId, mode: 'embed' }]);
    console.log('ok  pinned items on an event/space (dedup, converge, write-capability gate, not body editability)');
  }
  // 3e. Editing a meeting (sdk/events.js): Tana's event-wrapper writes, its organizer gate (access.canEditEvent), the
  // roster seeded from a calendar event's legacy attendees, GraphService.ListAttendeeSuggestions, and main's meeting:* IPC.
  {
    const access = require('../sdk/access'), events = require('../sdk/events');
    const { GraphClient } = require('../sdk'), { GraphService } = require('../sdk/proto/descriptors');
    const id = 'tana:event:' + ulid(), ev = new Document(id, { peerId: '41' }), mirror = new Document(id, { peerId: '42' });
    ev.on('local-update', (u) => mirror.applyRemote([u]));
    ev.transact((l) => {
      initDocument(l, 'Calendar meeting', ME, { kind: 'meeting', now: 0 });
      const d = l.getMap('data'); d.set('allDay', true); d.set('origin', 'provider');
      // a calendar-synced event lists its people in data.attendees and data.organizer until a roster is written
      const a = d.get('attendees').insertContainer(0, new LoroMap()); a.set('email', 'Sam@Example.com'); a.set('name', 'Sam'); a.set('partstat', 'accepted');
      d.get('organizer').set('email', 'me@example.com');
    });
    events.setTime(ev, 36e5, 72e5);
    assert.deepEqual([readNode(ev).startTime, readNode(ev).endTime, readNode(ev).allDay], [36e5, 72e5, undefined], 'a time write drops allDay, as Tana\'s setStartTime/setEndTime do');
    assert.throws(() => events.setTime(ev, 72e5, 36e5), /start before its end/);
    events.setLocation(ev, 'Room 4'); events.setTimezone(ev, 'Europe/Amsterdam'); events.setDescription(ev, 'agenda');
    assert.deepEqual([readNode(mirror).location, readNode(mirror).timezone, readNode(mirror).description], ['Room 4', 'Europe/Amsterdam', 'agenda'], 'converges');
    events.setLocation(ev, undefined);
    assert.equal('location' in readNode(ev), false, 'no location is no key, not an empty one');
    const other = 'tana:user-profile:' + ulid(), sam = 'tana:user-profile:' + ulid(), contact = 'tana:contact:' + ulid();
    assert.throws(() => events.addAttendees(ev, [{ email: 'x@y.z' }, {}], ME), /email or a profile/);
    assert.equal(ev.loro.getMap('attendees').size, 0, 'a refused list writes nobody, not the ones before the bad entry');
    events.addAttendees(ev, [{ email: ' Dana@X.com ' }, { userUri: other }, { email: 'sam@example.com', userUri: sam }, { email: 'c@d.e', userUri: contact }, { userUri: ME }], ME);
    const roster = ev.loro.getMap('attendees').toJSON();
    assert.deepEqual(roster['email:sam@example.com'], { source: 'tana', providerConfirmed: true, email: 'sam@example.com', name: 'Sam', partstat: 'accepted' }, 'the calendar\'s own line is seeded first and then merged into');
    assert.deepEqual(roster['email:me@example.com'], { source: 'provider', role: 'required', cutype: 'individual', email: 'me@example.com' }, 'the organizer is seeded too');
    assert.deepEqual(roster['email:dana@x.com'], { role: 'required', cutype: 'individual', source: 'tana', email: 'Dana@X.com' }, 'a new line is a required individual keyed by its lowercased email');
    const tanaLines = Object.entries(roster).filter(([k]) => k.startsWith('tana:'));
    assert.deepEqual(tanaLines.map(([k, v]) => [/^tana:[0-9a-z]{26}$/.test(k), v.identityUri]).sort(), [[true, other], [true, ME]].sort(), 'someone without an email gets a tana: line naming their profile');
    const grants = readNode(ev).participants;
    assert.deepEqual([grants[other], grants[sam]], [{ type: 'user', role: 'attendee', changedBy: ME }, { type: 'user', role: 'attendee', changedBy: ME }], 'a member is also given access as an attendee');
    assert.deepEqual([grants[ME], grants[contact]], [{ type: 'user', role: 'admin' }, undefined], 'an existing grant is kept, and a contact is on the roster only');
    assert.equal(events.attendees(ev).length, 6);
    assert.deepEqual(mirror.loro.getMap('attendees').toJSON(), roster);
    // the gate: Tana's Dk — unrestricted, or an organizer (admin/editor) — on top of being allowed to write at all
    const org = new Document('tana:org:' + ulid()); org.transact((l) => l.getMap('data').set('memberUserProfileDocUris', { me: ME }));
    const ctx = { orgDocUri: org.id, sync: { subscribe: async (x) => { if (x === org.id) return org; throw new Error('unavailable'); } } };
    assert.equal(await access.canEditEvent(ev, ME, ctx), true, 'the organizer may');
    assert.equal(await access.canEditEvent(ev, other, ctx), false, 'an attendee of a restricted meeting may not');
    assert.equal(await access.canEditEvent(ev, 'tana:user-profile:' + ulid(), ctx), false, 'nor may someone without a grant');
    ev.transact((l) => l.getMap('data').delete('restricted'));
    assert.equal(await access.canEditEvent(ev, other, ctx), true, 'an unrestricted meeting is open to anyone who may write it');
    ev.transact((l) => l.getMap('data').set('restricted', true));
    // Tana's updateEvent (Rwt): a synced event read from an attendee's calendar cannot take the change back
    ev.transact((l) => l.getMap('data').set('externalId', 'AAMk-provider-id'));
    assert.equal(await access.canEditEvent(ev, ME, ctx), false, 'a calendar copy that is not the organizer\u2019s is not changed here');
    ev.transact((l) => l.getMap('data').set('ownerIsOrganizer', true));
    assert.equal(await access.canEditEvent(ev, ME, ctx), true, 'the organizer\u2019s own calendar copy is');
    ev.transact((l) => { l.getMap('data').delete('externalId'); l.getMap('data').delete('ownerIsOrganizer'); });
    assert.deepEqual([events.lineKey(' Kim@X.nl\n'), events.lineKey('Élan@x.nl')], ['email:kim@x.nl', 'email:Élan@x.nl'], 'Tana lowercases A-Z only, so the keys match its own');
    const text = new Document('tana:text:' + ulid()); text.transact((l) => initDocument(l, 'not a meeting', ME));
    assert.equal(await access.canEditEvent(text, ME, ctx), false);
    // GraphService.ListAttendeeSuggestions, mapped the way Tana's own client maps it
    let asked;
    const graph = new GraphClient(createRouterTransport(({ service }) => service(GraphService, {
      listAttendeeSuggestions(req) { asked = req.limit; return { suggestions: [{ email: 'sam@example.com', displayName: 'Sam', lastSeenAt: 5n, eventCount: 3, nextMeetingAt: 0n, identityUri: sam }, { email: 'x@y.z' }] }; },
    })));
    assert.deepEqual(await graph.listAttendeeSuggestions({ limit: 2 }), [
      { email: 'sam@example.com', displayName: 'Sam', lastSeenAt: 5, eventCount: 3, nextMeetingAt: 0, identityUri: sam },
      { email: 'x@y.z', displayName: undefined, lastSeenAt: 0, eventCount: 0, nextMeetingAt: 0, identityUri: undefined }]);
    assert.equal(asked, 2);
    {
      // What this app may ask of GraphService (#579): the limits, one answer shared by identical calls, ListEdges kept
      // for ten seconds until forget(), and Tana's "too busy" waited out, on a check's clock
      const { bucket } = require('../sdk/graph');
      let t = 0; const take = bucket(5, 10, () => t);
      assert.deepEqual(Array.from({ length: 12 }, () => take()), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200, 400], 'ten at once, then one each fifth of a second');
      t = 5000; assert.equal(take(), 0, 'and the burst is back after a pause');
      const wire = [], slept = []; let clock = 0, busyFor = 0;
      const g = new GraphClient(createRouterTransport(() => {}), { now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; },
        call: async (name, params) => {
          wire.push(name);
          if (busyFor > 0) { busyFor--; throw new ConnectError('slow down', Code.ResourceExhausted); }
          if (params.fail) throw new ConnectError('no', Code.PermissionDenied);
          return name === 'listEdges' ? { edges: [{ fromNodeId: 'a' }] } : { nodes: [{ id: 'n' }] };
        } });
      const [a, b] = await Promise.all([g.listNodes({ nodeIds: ['n'] }), g.listNodes({ nodeIds: ['n'] })]);
      assert.deepEqual([wire.length, a.nodes[0].id], [1, 'n'], 'two identical calls at once: one on the wire');
      a.nodes.push({ id: 'mine' }); assert.equal(b.nodes.length, 1, 'each caller has its own copy');
      await g.listEdges({ toNodeIds: ['x'] }); await g.listEdges({ toNodeIds: ['x'] });
      assert.equal(wire.filter((n) => n === 'listEdges').length, 1, 'ListEdges asked again within ten seconds is the kept answer');
      g.forget(); await g.listEdges({ toNodeIds: ['x'] });
      assert.equal(wire.filter((n) => n === 'listEdges').length, 2, 'forget (a write of ours, an edge live query) reads it again');
      clock += 10000; await g.listEdges({ toNodeIds: ['x'] });
      assert.equal(wire.filter((n) => n === 'listEdges').length, 3, 'and so do ten seconds');
      wire.length = 0; slept.length = 0; busyFor = 2;
      assert.equal((await g.listNodes({ nodeIds: ['m'] })).nodes[0].id, 'n', 'Tana busy twice, answered the third time');
      assert.deepEqual([wire.length, slept], [3, [1000, 2000]], 'after waiting one second, then two');
      busyFor = 9; wire.length = 0;
      await assert.rejects(g.listNodes({ nodeIds: ['z'] }), /slow down/, 'six busy answers give up');
      assert.equal(wire.length, 6);
      busyFor = 0; wire.length = 0;
      await assert.rejects(g.listNodes({ nodeIds: ['q'], fail: true }), /no/, 'any other refusal is not asked again');
      assert.equal(wire.length, 1);
      console.log('ok  GraphService: limits, shared answers, ListEdges kept until forget, busy waited out');
    }
    // main: meeting:info / meeting:edit / meeting:suggestions, gated by the same rule
    const backend = mainHelpers(), stranger = 'tana:user-profile:' + ulid();
    const closed = new Document('tana:event:' + ulid()); closed.transact((l) => initDocument(l, 'someone else\u2019s meeting', stranger, { kind: 'meeting' }));
    const documents = new Map([[id, ev], [closed.id, closed], [org.id, org]]);
    const claims = Buffer.from(JSON.stringify({ org_id: ORG, role: 'member' })).toString('base64url');
    backend.testRuntime({
      me: { userUri: ME, orgId: ORG, orgDocUri: org.id },
      client: { sync: { getDocument: (x) => documents.get(x), subscribe: async (x) => { if (!documents.has(x)) throw new Error('not found'); return documents.get(x); } },
        graph: { listNodes: async () => ({ nodes: [] }), listAttendeeSuggestions: async ({ limit }) => [{ email: 'sam@example.com', limit }] } },
      session: { getAccessToken: async () => 'head.' + claims + '.sig' },
      win: { isDestroyed: () => false, webContents: { send: () => {} } },
    });
    const call = (name, ...a) => backend.handlers.get(name)({}, ...a);
    const info = await call('meeting:info', id);
    assert.deepEqual([info.editable, info.start, info.end, info.allDay, info.location, info.attendees.length], [true, 36e5, 72e5, false, '', 6]);
    assert.equal((await call('meeting:edit', id, { location: '  Room 4  ' })).location, 'Room 4', 'trimmed');
    assert.equal((await call('meeting:edit', id, { location: '' })).location, '', 'and an empty one removes it');
    assert.equal('location' in readNode(ev), false);
    const moved = await call('meeting:edit', id, { start: 9e6, end: 108e5 });
    assert.deepEqual([moved.start, moved.end], [9e6, 108e5]);
    await assert.rejects(call('meeting:edit', closed.id, { location: 'x' }), /Only the event organizer/, 'someone else\'s meeting is refused in main too');
    ev.transact((l) => l.getMap('data').set('allDay', true));
    await assert.rejects(call('meeting:edit', id, { start: 9e6, end: 108e5 }), /all-day/, 'an all-day meeting is not rescheduled from here');
    assert.equal((await call('meeting:edit', id, { location: 'Room 5' })).location, 'Room 5', 'though its place still is');
    ev.transact((l) => l.getMap('data').delete('allDay'));
    assert.equal((await call('meeting:info', closed.id)).editable, false);
    await assert.rejects(call('meeting:edit', text.id, { location: 'x' }), /Not a meeting/);
    assert.deepEqual(await call('meeting:suggestions'), [{ email: 'sam@example.com', limit: 20 }]);
    console.log('ok  editing a meeting (time, place, roster, organizer gate, attendee suggestions, meeting:* IPC)');
  }
  {
    const backend = mainHelpers(), cache = require('../db');
    cache.open(':memory:');
    const colId = 'tana:collection:' + ulid(), pinId = 'tana:text:' + ulid();
    const profile = new Document(ME), collection = new Document(colId), remoteCollection = new Document(colId, {peerId:'888'}), pinDoc = new Document(pinId);
    profile.transact(l => l.getMap('data').set('pinnedCollectionUri', colId));
    collection.transact(l => l.getTree('tree').createNode().data.set('uri', pinId));
    remoteCollection.applyRemote([collection.exportSince()]);
    pinDoc.transact(l => initDocument(l, 'arbitrary deleted node', ME));
    cache.upsert({id:pinId, section:'tasks', title:'cached node'});
    const documents = new Map([[ME,profile],[colId,collection],[pinId,pinDoc]]), events = [];
    backend.testRuntime({me:{userUri:ME}, client:{sync:{getDocument:id=>documents.get(id), subscribe:async id=>documents.get(id)}}, win:{isDestroyed:()=>false,webContents:{send:(...args)=>events.push(args)}}});
    collection.on('change', () => backend.onChange(colId));
    remoteCollection.on('local-update', u => collection.applyRemote([u]));
    assert.equal((await backend.pinTree()).length, 1);
    const coldDeletedId = 'tana:text:' + ulid(), coldDeleted = new Document(coldDeletedId);
    coldDeleted.transact(l => { initDocument(l, 'deleted before subscribing', ME); l.getMap('data').set('deletedAt', 100); });
    documents.set(coldDeletedId, coldDeleted);
    remoteCollection.transact(l => l.getTree('tree').createNode().data.set('uri', coldDeletedId));
    assert.equal((await backend.pinTree()).length, 1, 'already-deleted snapshot pin is suppressed before any live notification');
    // Nothing has announced this one: it was deleted elsewhere and this app never subscribed it, so no change event
    // ever ran. A read is where it is found out, and that read has to say so — otherwise the renderer kept the row,
    // went on asking for its metadata on every backoff, and would still open the page.
    const unseenId = 'tana:text:' + ulid(), unseen = new Document(unseenId);
    unseen.transact(l => { initDocument(l, 'deleted elsewhere, never announced here', ME); l.getMap('data').set('deletedAt', 100); });
    documents.set(unseenId, unseen);
    events.length = 0;
    await assert.rejects(backend.op(unseenId, () => 'read anyway'), /has been deleted/, 'a read of a deleted node is refused');
    assert.ok(events.some(([channel, id]) => channel === 'outline:removed' && id === unseenId), 'and the refusal tells the renderer, which is what stops it asking again');
    events.length = 0;
    await assert.rejects(backend.op(unseenId, () => 'read anyway'), /has been deleted/);
    assert.equal(events.filter(([channel]) => channel === 'outline:removed').length, 0, 'said once: the tombstone is remembered, so every later read is quiet');

    remoteCollection.transact(l => l.getTree('tree').delete(l.getTree('tree').nodes().find(n => n.data.get('uri') === pinId).id));
    assert.ok(events.some(([channel,id]) => channel === 'outline:changed' && id === null), 'remote unpin invalidates palette globally despite no cached collection row');
    assert.equal((await backend.pinTree()).length, 0);
    assert.ok(cache.get(pinId), 'unpin does not delete the document');
    // A change event says whether the document's metadata moved: a title edit keeps the renderer's cached
    // assignees/audience, an assignee change drops them. Only the fields that feed doc:taskMeta count.
    {
      pinDoc.on('change', () => backend.onChange(pinId));
      const metaEvents = () => events.filter(([channel, id]) => channel === 'outline:changed' && id === pinId).map((e) => e[2] && e[2].meta);
      const fieldEvents = () => events.filter(([channel, id]) => channel === 'outline:changed' && id === pinId).map((e) => e[2] && e[2].fields);
      events.length = 0;
      setTitle(pinDoc, 'first title'); // the first change after boot has no signature to compare with: conservative
      assert.deepEqual(metaEvents(), [true], 'an unseen document invalidates once');
      events.length = 0;
      setTitle(pinDoc, 'second title');
      assert.deepEqual([metaEvents(), fieldEvents()], [[false], [false]], 'a title edit leaves the metadata alone, and is no field change');
      events.length = 0;
      pinDoc.transact((l) => { l.getMap('data').set('stateType', 'open'); }); // a task now, so assignees can change
      events.length = 0;
      setAssignees(pinDoc, [ME], ME);
      assert.deepEqual(metaEvents(), [true], 'an assignee change invalidates it');
      events.length = 0;
      pinDoc.transact((l) => { l.getMap('data').set('entityTypeUri', 'tana:type:' + ulid()); });
      assert.deepEqual(metaEvents(), [true], 'so does a type change: the page\'s fields come with the sidebar it refreshes');
      events.length = 0;
      require('../sdk/fields').setFieldText(pinDoc, 'tana:type:01j0typ000000000000000000?attribute=n5e1hgxz', 'Stan Engbers');
      assert.deepEqual([metaEvents(), fieldEvents()], [[false], [true]], 'a value written into one of those fields is a field change, not metadata: the page re-reads its fields (or shows the value empty until something else refreshes it) and keeps its assignees and audience (Visible to vanished while a field was edited)');
      pinDoc.removeAllListeners('change');
    }
    const remotePin = new Document(pinId, {peerId:'889'});
    remotePin.applyRemote([pinDoc.exportSince()]);
    pinDoc.on('change', () => backend.onChange(pinId));
    remotePin.on('local-update', u => pinDoc.applyRemote([u]));
    remotePin.transact(l => l.getMap('data').set('deletedAt', Date.now()));
    assert.equal(cache.get(pinId), undefined);
    remoteCollection.transact(l => l.getTree('tree').createNode().data.set('uri', pinId));
    assert.equal((await backend.pinTree()).length, 0, 'a stale native pin reference cannot display a deleted node');
    assert.ok(events.some(([channel,id]) => channel === 'outline:removed' && id === pinId));
    assert.equal(backend.visibleGraphNodes([{id:pinId,title:'stale graph row'}]).length, 0);
    assert.equal(backend.visibleGraphNodes([{id:'another',deletedAt:123}]).length, 0);
    // Nothing server-side lists a deleted document, so the deletion is written down here, under the title it had
    // while the document was still open — that list is all Cmd+K "Recently deleted" has to offer.
    assert.equal((cache.deletedList().find((d) => d.id === pinId) || {}).title, 'second title', 'a deletion is remembered with its title');
    remotePin.transact(l => l.getMap('data').delete('deletedAt'));
    assert.equal(backend.visibleGraphNodes([{id:pinId}]).length, 1, 'native restore clears tombstone');
    assert.equal(cache.deletedList().some((d) => d.id === pinId), false, 'and a restore takes it off that list again');
    assert.equal(backend.VIEWS.find(s => s.id === 'library').icon, 'library');
    const agentId = 'tana:agent:' + ulid();
    assert.equal(backend.graphRow({id:agentId,title:'Agent'}).icon, 'agent');
    assert.equal(backend.toNode({id:agentId,title:'cached',icon:'doc'}).icon, 'agent');
    console.log('ok  remote unpin/deletion invalidation, stale graph suppression, restore and agent cache icon');
  }
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const host = new Document(DOC), targetUri = 'tana:text:01examplek0000000000000000';
    host.transact(l => initDocument(l, 'reference host', ME));
    const blockId = outline.readOutline(host)[0].id;
    host.transact(l => {
      const embed = l.getMap('content').get('children').get(0);
      embed.set('nodeName', 'embed'); embed.get('attributes').set('tanaUri', targetUri);
    });
    const headingId = outline.insertAfter(host, blockId, 'Strategic Goals 2026-2027');
    const before = host.toJSON();
    const raw = outline.readOutline(host)[0];
    assert.equal(raw.id, blockId); assert.equal(raw.type, 'reference'); assert.equal(raw.editable, false);
    assert.deepEqual(raw.reference, {uri:targetUri});
    assert.throws(() => outline.setText(host, blockId, 'overwrite'), /Reference blocks/);
    assert.deepEqual(host.toJSON(), before, 'reads and rejected text writes preserve the native embed');
    const requests = [], live = [], sync = {subscribe:async (id) => { live.push(id); return {}; }, unsubscribe:async () => {}};
    backend.testRuntime({me:{userUri:ME},client:{sync,graph:{listNodes:async q => { requests.push(q); return {nodes:[{id:targetUri,title:'Actual embedded task',state:{type:'open'},appearance:{hue:0}}]}; }}}});
    const resolved = await backend.outlineWithReferences(host);
    // the row draws a copy of its target's title: only a subscribed target tells main it was renamed (#413)
    assert.deepEqual(live, [targetUri], 'a resolved reference keeps its target live, so a rename reaches the row');
    const chatUri = 'tana:chat:' + ulid(); live.length = 0;
    backend.testRuntime({me:{userUri:ME},client:{sync,graph:{listNodes:async () => ({nodes:[{id:chatUri,title:'A sub-agent chat'}]})}}});
    const embedTo = (uri) => host.transact(l => l.getMap('content').get('children').get(0).get('attributes').set('tanaUri', uri));
    embedTo(chatUri); await backend.outlineWithReferences(host); embedTo(targetUri);
    assert.ok(!live.includes(chatUri), 'but not a chat: it bootstraps to megabytes of messages, too much for a title');
    const many = new Document('tana:text:' + ulid()), manyUris = [];
    many.transact(l => initDocument(l, 'many references', ME));
    let last = outline.readOutline(many)[0].id;
    for (let i = 1; i < 60; i++) last = outline.insertAfter(many, last, 'r' + i);
    many.transact(l => { const rows = l.getMap('content').get('children'); for (let i = 0; i < rows.length; i++) { const uri = 'tana:text:' + ulid(); manyUris.push(uri); rows.get(i).set('nodeName', 'embed'); rows.get(i).get('attributes').set('tanaUri', uri); } });
    const refClient = {sync,graph:{listNodes:async (q) => ({nodes:(q.nodeIds || []).map((id) => ({id, title:id}))})}}; // one client: a new one starts afresh
    backend.testRuntime({me:{userUri:ME},client:refClient});
    await backend.outlineWithReferences(many);
    assert.deepEqual([manyUris.length, live.filter((uri) => manyUris.includes(uri)).length], [60, 50], 'a page of 60 references keeps its first 50 live');
    // Read again, a page subscribes nothing twice; the next page's references are kept live and push the oldest out
    const gone = []; sync.unsubscribe = async (id) => { gone.push(id); };
    live.length = 0; await backend.outlineWithReferences(many);
    assert.deepEqual(live, [], 'reading a page again subscribes none of its references a second time');
    gone.length = 0;
    const other = new Document('tana:text:' + ulid()), otherUris = [];
    other.transact(l => { initDocument(l, 'more references', ME); });
    other.transact(l => { const rows = l.getMap('content').get('children'); const uri = 'tana:text:' + ulid(); otherUris.push(uri); rows.get(0).set('nodeName', 'embed'); rows.get(0).get('attributes').set('tanaUri', uri); });
    live.length = 0; await backend.outlineWithReferences(other);
    assert.deepEqual([live, gone], [otherUris, [manyUris[0]]], 'the next page\u2019s reference is kept live and the oldest let go: no page is turned away, and none is read again for it');
    // Pushed out while still loading, a target is let go once its bootstrap settles, so none outlives the cap
    const slow = new Document('tana:text:' + ulid()), slowUri = 'tana:text:' + ulid();
    slow.transact(l => { initDocument(l, 'slow reference', ME); });
    slow.transact(l => { const row = l.getMap('content').get('children').get(0); row.set('nodeName', 'embed'); row.get('attributes').set('tanaUri', slowUri); });
    let settle; const plain = sync.subscribe;
    sync.subscribe = (id) => (id === slowUri ? new Promise((r) => { settle = r; }) : plain(id));
    await backend.outlineWithReferences(slow);
    await backend.outlineWithReferences(many); // 50 newer ones: the slow target is pushed out while it loads
    gone.length = 0; settle({}); await new Promise((r) => setImmediate(r));
    assert.ok(gone.includes(slowUri), 'a target pushed out while it loaded is let go once it settles');
    // A bootstrap that failed is tried again on the next read, and a new login (a new client) subscribes afresh
    sync.subscribe = async (id) => { live.push(id); return id === otherUris[0] ? null : {}; };
    live.length = 0; await backend.outlineWithReferences(other); await new Promise((r) => setImmediate(r));
    live.length = 0; await backend.outlineWithReferences(other);
    assert.deepEqual(live, otherUris, 'a target whose bootstrap failed is subscribed again on the next read');
    sync.subscribe = plain;
    backend.testRuntime({me:{userUri:ME},client:{...refClient}});
    await backend.outlineWithReferences(many); live.length = 0; await backend.outlineWithReferences(many); // all 50 live on this client
    const liveBefore = live.length;
    backend.testRuntime({me:{userUri:ME},client:{...refClient}});
    live.length = 0; backend.reliveRefs(); // what start() does once the new client exists, before any outline is read again
    const onNew = live.length; live.length = 0; await backend.outlineWithReferences(many);
    assert.deepEqual([liveBefore, onNew, live.length], [0, 50, 0], 'a new login subscribes the targets live on the old client on the new one, with no outline read again');
    // A node watched by hand keeps its subscription when it leaves the list: letting it go would end its notifications
    backend.settings.set('notify', { ...(backend.settings.get('notify') || {}), [manyUris[0]]: true });
    gone.length = 0; sync.unsubscribe = async (id) => { gone.push(id); };
    await backend.outlineWithReferences(other); await new Promise((r) => setImmediate(r));
    assert.ok(!gone.includes(manyUris[0]), 'a reference target watched by hand is not unsubscribed when the list lets it go');
    // An old login's bootstrap answering after a new login changes nothing: the target stays for the new client
    let late; sync.subscribe = (id) => { live.push(id); return id === slowUri ? new Promise((r) => { late = r; }) : Promise.resolve({}); };
    await backend.outlineWithReferences(slow);
    backend.testRuntime({me:{userUri:ME},client:{...refClient}});
    late(null); await new Promise((r) => setImmediate(r));
    live.length = 0; backend.reliveRefs();
    assert.ok(live.includes(slowUri), 'a target whose old-client bootstrap failed after a new login is still subscribed on the new client');
    // Its change read back by the renderer (patchDoc: doc:info, patch) is no on-demand read: pushed out, it is let go (#438)
    const patched = new Document('tana:text:' + ulid()), patchedUri = 'tana:text:' + ulid(), patchedDoc = new Document(patchedUri);
    patchedDoc.transact(l => initDocument(l, 'patched target', ME));
    patched.transact(l => { initDocument(l, 'patched reference', ME); const row = l.getMap('content').get('children').get(0); row.set('nodeName', 'embed'); row.get('attributes').set('tanaUri', patchedUri); });
    sync.subscribe = async (id) => (id === patchedUri ? patchedDoc : {});
    await backend.outlineWithReferences(patched); await new Promise((r) => setImmediate(r));
    assert.equal((await backend.handlers.get('doc:info')(null, patchedUri, true)).title, 'patched target');
    gone.length = 0; await backend.outlineWithReferences(many); await new Promise((r) => setImmediate(r));
    assert.ok(gone.includes(patchedUri), 'a reference target whose change was read back is still let go when the list pushes it out');
    // ...and read back after it was pushed out (its change was already on its way), it is not kept: let go once read
    gone.length = 0; assert.equal((await backend.handlers.get('doc:info')(null, patchedUri, true)).title, 'patched target');
    assert.ok(gone.includes(patchedUri), 'a change read back for a target already let go does not subscribe it again for good');
    // A document live for another holder dropRef cannot see (the settings, the inbox, a hub) keeps its subscription
    sync.getDocument = (id) => (id === patchedUri ? patchedDoc : undefined);
    gone.length = 0; await backend.handlers.get('doc:info')(null, patchedUri, true);
    assert.deepEqual(gone, [], 'a change read back of a document already live is never let go by the read');
    delete sync.getDocument;
    // Two panes reading the same change back at once: the one that subscribed it may finish first; the last one lets go
    const opened = new Set(); let settleBoth; const both = new Promise((r) => { settleBoth = () => r(patchedDoc); });
    sync.getDocument = (id) => (opened.has(id) ? patchedDoc : undefined);
    sync.subscribe = (id) => { opened.add(id); return both; };
    gone.length = 0;
    const first = backend.handlers.get('doc:info')(null, patchedUri, true), second = backend.handlers.get('doc:info')(null, patchedUri, true);
    settleBoth(); await Promise.all([first, second]);
    assert.deepEqual(gone, [patchedUri], 'two reads back of the same change let go once, when the last is done');
    delete sync.getDocument;
    // A read back that starts while its target is still a live reference, which is pushed out before the read is done:
    // the let-go the read held up is tried again when it finishes
    sync.subscribe = async (id) => (id === patchedUri ? patchedDoc : {});
    await backend.outlineWithReferences(patched); await new Promise((r) => setImmediate(r)); // live, and the oldest
    let settleRead; const reread = new Promise((r) => { settleRead = () => r(patchedDoc); });
    sync.getDocument = (id) => (id === patchedUri ? patchedDoc : undefined);
    sync.subscribe = (id) => (id === patchedUri ? reread : Promise.resolve({}));
    const inFlight = backend.handlers.get('doc:info')(null, patchedUri, true);
    gone.length = 0; await backend.outlineWithReferences(many); await new Promise((r) => setImmediate(r)); // pushed out meanwhile
    const whileRead = gone.includes(patchedUri);
    settleRead(); await inFlight;
    assert.deepEqual([whileRead, gone.includes(patchedUri)], [false, true], 'a target pushed out while its change was read back is let go once the read is done');
    // ...and one whose let-go had already started (unsubscribe waiting on local updates) when its change was read back:
    // the read's subscribe cancels that let-go, so the read lets it go again once done
    sync.isLive = () => false; sync.subscribe = async () => patchedDoc;
    gone.length = 0; await backend.handlers.get('doc:info')(null, patchedUri, true);
    assert.ok(gone.includes(patchedUri), 'a change read back while its document was being let go lets it go again once read');
    delete sync.isLive;
    delete sync.getDocument;
    sync.unsubscribe = async () => {};
    sync.subscribe = plain;
    sync.unsubscribe = async () => {};
    backend.testRuntime({me:{userUri:ME},client:{sync,graph:{listNodes:async q => { requests.push(q); return {nodes:[{id:targetUri,title:'Actual embedded task',state:{type:'open'},appearance:{hue:0}}]}; }}}});
    assert.equal(resolved[0].id, blockId); assert.equal(resolved[0].reference.node.id, targetUri);
    assert.equal(resolved[0].reference.node.icon, 'task'); assert.equal(resolved[0].reference.node.done, 0);
    assert.equal(resolved[0].reference.node.hue, 0); assert.equal(resolved[1].id, headingId);
    assert.deepEqual(Array.from(requests[0].nodeIds), [targetUri]);
    assert.deepEqual(host.toJSON(), before, 'resolution never copies target data into the CRDT');
    backend.testRuntime({me:{userUri:ME},client:{graph:{listNodes:async()=>{throw new Error('unavailable');}}}});
    const unresolved = await backend.outlineWithReferences(host);
    assert.deepEqual(unresolved[0].reference, {uri:targetUri});
    // A line whose whole content is one mention is Tana's full-reference presentation: resolved like a native embed,
    // while staying an ordinary editable block, and only for as long as nothing else is on the line.
    const mentionUri = 'tana:text:01examplem0000000000000000';
    const mention = {mention:{uri:mentionUri,label:'Stale label'}};
    backend.testRuntime({me:{userUri:ME},client:{sync,graph:{listNodes:async()=>({nodes:[{id:mentionUri,title:'Mentioned task',state:{type:'open'}}]})}}});
    outline.setText(host, headingId, [mention]);
    const full = (await backend.outlineWithReferences(host))[1];
    assert.equal(full.id, headingId); assert.equal(full.type, undefined, 'the block keeps its own identity rather than becoming a native embed');
    assert.equal(full.reference.uri, mentionUri); assert.equal(full.reference.label, 'Stale label');
    assert.equal(full.reference.node.icon, 'task'); assert.equal(full.reference.node.done, 0, 'the row can show the task it points at, and check it off');
    outline.setText(host, headingId, [mention, {text:' by Friday'}]);
    assert.equal((await backend.outlineWithReferences(host))[1].reference, undefined, 'text beside it makes it an ordinary line with an inline link');
    // A target that is gone is not the same as one that cannot be read: the renderer strikes a deleted reference
    // through behind a trash glyph and refuses to open it, and an unreadable one stays an ordinary link, so the
    // resolution has to tell them apart rather than dropping both.
    backend.testRuntime({me:{userUri:ME},client:{graph:{listNodes:async()=>({nodes:[{id:mentionUri,title:'Deleted task',deletedAt:Date.now()}]})}}});
    outline.setText(host, headingId, [mention]);
    const deletedFull = (await backend.outlineWithReferences(host))[1];
    assert.equal(deletedFull.reference.node, undefined, 'a deleted target is not drawn as the node it was');
    assert.equal(deletedFull.reference.deleted, true, 'but the row is told it is gone rather than merely unreadable');
    outline.setText(host, headingId, [{text:'follows '}, mention]);
    const deletedInline = (await backend.outlineWithReferences(host))[1];
    assert.equal(deletedInline.segments[1].mention.deleted, true, 'and so is a mention written inside a line');
    assert.equal(deletedInline.segments[1].mention.icon, undefined, 'which takes no kind icon: the renderer gives it the trash glyph');
    // An answer that leaves a uri out says nothing: no permission, an index that has not caught up, a broken id. Only
    // a tombstone marks a reference as gone, which is why the two are separate answers rather than one "not resolved".
    const unreadableUri = 'tana:text:01exampleu0000000000000000';
    outline.setText(host, headingId, [{text:'follows '}, {mention:{uri:unreadableUri,label:'Somebody else’s note'}}]);
    backend.testRuntime({me:{userUri:ME},client:{graph:{listNodes:async()=>({nodes:[]})}}});
    assert.equal((await backend.outlineWithReferences(host))[1].segments[1].mention.deleted, undefined, 'a target that simply did not come back is unreadable, not deleted');
    outline.setText(host, headingId, [mention]);
    const ownKid = outline.insertChild(host, headingId, 'a step of its own');
    assert.equal((await backend.outlineWithReferences(host))[1].reference, undefined, 'and neither is a block with children of its own, since expanding one opens the target instead');
    outline.remove(host, ownKid);
    outline.setText(host, headingId, 'Strategic Goals 2026-2027');
    assert.throws(() => outline.move(host, blockId, 'sideways'), /up or down/, 'a bad direction is refused, never silently down');
    outline.move(host, blockId, 'down');
    assert.equal(outline.readOutline(host)[1].reference.uri, targetUri);
    outline.remove(host, blockId);
    assert.equal(outline.readOutline(host).length, 1);
    console.log('ok  native embed identity, task resolution, unavailable fallback and non-destructive outline operations');
  }

  // Who holds the thread, and when it is let go. The child that starts a turn is that thread's writer for as long as
  // it lives, and Codex refuses to open a thread another writer holds — the "This is open in another app" card. The
  // child used to be closed on a fixed 15-minute timer, so a task that finished in one minute stayed locked for
  // fourteen. Driven through a stand-in for node:child_process: nothing is spawned, and what is asserted is the real
  // spawn arguments and the real teardown.
  {
    const nodePath = require('node:path'), os = require('node:os');
    const userData = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tana-agent-'));
    const NODES = ['tana:text:01examplea0000000000000000', 'tana:text:01exampleb0000000000000000', 'tana:text:01examplec0000000000000000'];
    const THREADS = ['01a0b3a3-c000-70b0-896e-08e86986ca0e', '01a0b3bc-6b77-74a3-ae33-dcc82967896f', '01a0b3c1-1111-7000-8000-000000000000'];
    const spawned = [];
    // Answers every request the moment it is written, the way a real app-server does, and hands back the thread id
    // this connection was given. Notifications are pushed in by the check itself.
    const childProcess = { spawn(cmd, args, options) {
      const child = { cmd, args, options, killed: 0, sent: [], onData: null, kill() { child.killed++; }, on() {},
        stdout: { on: (ev, fn) => { if (ev === 'data') child.onData = fn; } },
        stdin: { write(line) {
          const m = JSON.parse(line); child.sent.push(m);
          const result = m.method === 'thread/start' ? { thread: { id: THREADS[spawned.indexOf(child)] } } : {};
          Promise.resolve().then(() => child.onData(JSON.stringify({ id: m.id, result }) + '\n'));
        } } };
      spawned.push(child); return child; } };
    // A codex first on PATH, so the check does not depend on this machine's own install (CI has none).
    const fakeBin = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tana-codex-')), fakeCodex = nodePath.join(fakeBin, 'codex'), realPath = process.env.PATH;
    fs.writeFileSync(fakeCodex, '', { mode: 0o755 });
    process.env.PATH = fakeBin + ':' + realPath;
    const backend = mainHelpers(childProcess), cache = require('../db'); cache.open(':memory:');
    process.env.PATH = realPath;
    const agent = backend.agent;
    const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    const notify = async (child, method, params) => { child.onData(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); await tick(); };
    const methods = (child) => child.sent.map((m) => m.method);

    const local = await agent.createTask({ nodeUri: NODES[0], prompt: 'Draft it', userData, host: 'local' });
    assert.equal(local, THREADS[0], 'the task is created and its id comes back');
    assert.equal(spawned[0].cmd, fakeCodex, 'on this machine the app-server is run directly, by the codex PATH finds');
    assert.equal([...spawned[0].args].join(' '), 'app-server', 'with no shell line and nothing else on the command');
    assert.equal(spawned[0].killed, 0, 'and the child is left alive while the turn runs: the work is not cut off to free a lock');
    // Someone else's turn ending says nothing about this one. Without the thread id being compared, one finished
    // task would release every writer the app holds.
    await notify(spawned[0], 'turn/completed', { threadId: THREADS[1], turn: { status: 'completed' } });
    assert.equal(spawned[0].killed, 0, 'another thread finishing does not release this one');
    assert.equal(methods(spawned[0]).includes('thread/unsubscribe'), false, 'and hands nothing back on its behalf');

    await notify(spawned[0], 'turn/completed', { threadId: THREADS[0], turn: { status: 'completed' } });
    assert.equal(JSON.stringify(spawned[0].sent.filter((m) => m.method === 'thread/unsubscribe').map((m) => m.params)),
      JSON.stringify([{ threadId: THREADS[0] }]), 'the finished thread is handed back through the protocol, by id');
    assert.equal(spawned[0].killed, 1, 'and only then is the writer closed, so Codex can open the task normally');

    // The same lifecycle over SSH, with the address and the binary as separate arguments — never joined into a line
    // a shell could read — and a release that closes this connection alone.
    const donut = agent.addHost({ title: 'Donut', ssh: 'donut.example.ts.net', bin: '/Users/someone/.local/bin/codex' });
    const remote = await agent.createTask({ nodeUri: NODES[1], prompt: 'Draft it there', userData, host: donut.id });
    assert.equal(remote, THREADS[1], 'a task on another machine is created the same way');
    assert.equal(spawned[1].cmd, 'ssh', 'reached over the user\'s own SSH');
    assert.equal([...spawned[1].args].join(' '), '-o BatchMode=yes -o ConnectTimeout=8 donut.example.ts.net /Users/someone/.local/bin/codex app-server',
      'with the host and the absolute binary as arguments of their own');
    assert.equal(spawned[1].killed, 0, 'and it too runs until its work is done');
    await notify(spawned[1], 'turn/completed', { threadId: THREADS[1], turn: { status: 'failed' } });
    assert.equal(spawned[1].killed, 1, 'a turn that failed is still a turn that ended, so the SSH child is closed rather than left running');
    assert.equal(spawned[0].killed, 1, 'and releasing one machine leaves the other exactly as it was');

    // Quitting cannot wait for a round trip, so the children this app is still holding are simply closed. Only those:
    // it is a list of what was spawned here, not a search for processes that look like ours.
    await agent.createTask({ nodeUri: NODES[2], prompt: 'Still running', userData, host: 'local' });
    assert.equal(spawned[2].killed, 0, 'a task still running is still owned');
    agent.stopOwnedTasks();
    assert.equal(spawned[2].killed, 1, 'and is closed when the app goes away, so no writer outlives it');
    const isolatedHome=nodePath.join(userData,'chatgpt-auth'), isolated=agent.appServerRpc(20000,undefined,undefined,{codexHome:isolatedHome});
    await isolated.ready;
    assert.equal(JSON.stringify(spawned[3].args),JSON.stringify(['-c','cli_auth_credentials_store="file"','app-server']),'ChatGPT uses file-backed credentials in its dedicated Codex home');
    assert.equal(spawned[3].options.env.CODEX_HOME,isolatedHome,'the app-server cannot read the user\'s regular Codex home');
    assert.equal(['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN'].some((key)=>Object.hasOwn(spawned[3].options.env,key)),false,'API tokens from the app environment are not inherited');
    isolated.stop();
    const standalone = agent.appServerRpc(20000, undefined, undefined, { bin: '/x/codex-app-server' }); await standalone.ready; standalone.stop();
    assert.deepEqual([spawned[4].cmd, spawned[4].args.length], ['/x/codex-app-server', 0], 'the standalone server ChatGPT sign-in downloads is run as named, with no subcommand');
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
    console.log('ok  agent writer lifecycle: released on the turn that ends it, scoped by thread and by machine, closed on quit');
  }
  // A chat has no outline: its conversation is data.messages, rendered as read-only rows (docs/CHATS.md).
  {
    const backend = mainHelpers();
    const chatUri = 'tana:chat:01example10000000000000000', doc = new Document(chatUri);
    const noteUri = 'tana:text:01example30000000000000000', fileUri = 'tana:text:01example40000000000000000';
    const proposedUri = 'tana:text:01example50000000000000000', subUri = 'tana:chat:01examplex0000000000000000';
    doc.transact((l) => {
      initDocument(l, 'Studio Offsite Goals Extraction', ME, { kind: 'chat' });
      const messages = l.getMap('data').get('messages');
      messages.push({ id: 'pre0', type: 'message', fromUserType: 'human', hiddenFromChat: true, isStatusUpdate: true, content: { text: 'it is now Thursday' }, sentAt: 1788262342702 });
      messages.push({ id: 'ctx0', type: 'context', fromUserType: 'human', content: { text: 'injected context' }, sentAt: 1788262342702 });
      messages.push({ id: '0ymc325f', type: 'message', fromUserType: 'human', fromUserUri: ME, sentAt: 1788262342702, content: { text: 'From [Notes](' + noteUri + '), extract the goals.' }, attachmentUris: [fileUri] });
      messages.push({ id: '1j3cr829', type: 'message', fromUserType: 'ai', sentAt: 1788262342702, completedAt: 1788262392412,
        content: { text: '## Goals\n\n- **short** term\n- long term\n\n```js\nlet a = **1**\n```' },
        proposals: [{ operation: 'create', proposedUri, proposedAt: 1788262392412, approvedAt: 1788262400000 }],
        toolCalls: [{ id: 'call_1', name: 'extractOutcome', subagentChatUri: subUri, status: 'completed' }] });
    });
    const graphed = [];
    backend.testRuntime({ me: { userUri: ME }, client: { sync: { subscribe: async () => null }, graph: { listNodes: async (q) => {
      graphed.push(q);
      if (q.nodeTypes && q.nodeTypes[0] === 'user-profile') return { nodes: [{ id: ME, title: 'Robin Vega' }] };
      return { nodes: Array.from(q.nodeIds || []).map((id) => ({ id, title: 'Target ' + id.split(':')[1] })) };
    } } } });
    const rows = await backend.chatOutline(doc);
    assert.deepEqual(rows.map((r) => r.text), ['Robin Vega', 'Tana AI'], 'hidden and context messages are skipped, list order kept');
    assert.deepEqual(rows.map((r) => r.id), ['m2', 'm3'], 'row ids follow the message list, not the visible order');
    const readOnly = (ns) => ns.every((n) => n.editable === false && readOnly(n.children || []));
    assert.ok(readOnly(rows), 'no chat row is editable');
    const [human, ai] = rows;
    assert.equal(human.icon, 'member'); assert.equal(ai.icon, 'chat');
    assert.deepEqual(human.children[0].segments, [{ text: 'From ' }, { mention: { label: 'Notes', uri: noteUri, icon: 'doc' } }, { text: ', extract the goals.' }],
      'a reference written inside a line carries its target\'s icon, resolved in the same batch the rows use');
    const attachment = human.children[1];
    assert.equal(attachment.type, 'reference'); assert.equal(attachment.reference.uri, fileUri);
    assert.equal(attachment.reference.node.id, fileUri, 'attachment titles resolve through the shared reference lookup');
    assert.equal(ai.children[0].text, 'Thought for 50 seconds');
    assert.deepEqual(ai.children.slice(1, 5).map((n) => [n.block, n.text]), [['heading2', 'Goals'], ['bullet', 'short term'], ['bullet', 'long term'], ['code', 'let a = **1**']]);
    assert.deepEqual(ai.children[2].segments, [{ text: 'short', marks: { bold: true } }, { text: ' term' }], 'inline markdown becomes marks, and text is the plain rendering');
    assert.equal(ai.children[5].text, 'create · approved');
    assert.deepEqual((({ proposedUri: u, state, title, chatUri, approvable }) => ({ u, state, title, chatUri, approvable }))(ai.children[5].proposal),
      { u: proposedUri, state: 'approved', title: 'Target ' + proposedUri.split(':')[1], chatUri: doc.id, approvable: false },
      'a proposal is a card: its document\'s name read with includeProposals, in its chat, and nothing to approve once approved');
    assert.ok(graphed.some((q) => q.includeProposals && Array.from(q.nodeIds).includes(proposedUri)), 'a draft is only listed with includeProposals');
    assert.equal(ai.children[6].reference.uri, subUri, 'a subagent tool call links its own chat');
    // A mention carries its own label, so nothing is looked up to render the words. Its target is asked for all
    // the same — one batch for the reference rows and every inline mention together, deduplicated by uri — because
    // that is what tells a reference which icon it is.
    assert.deepEqual(Array.from(graphed.find((q) => !q.includeProposals && Array.from(q.nodeIds || []).includes(fileUri)).nodeIds).sort(), [fileUri, noteUri, subUri].sort());
    assert.deepEqual(doc.toJSON().content, {}, 'reading a chat never writes an outline into it');
    console.log('ok  chat rows: hidden/context skipped, list order, read-only rows, mentions, attachments, proposals and subagent links');
  }
  // AI proposals (issue #19; sdk/proposals.js, main/proposals.js): the graph lists the pending ones, approve takes a
  // proposed document out of proposal the way Tana does, reject removes the proposal and deletes its draft, and every
  // proposal Tana would do more for is refused without a write.
  {
    const proposals = require('../sdk/proposals'), { chatRows } = require('../sdk/chat');
    const OTHER = 'tana:user-profile:01examplej0000000000000000', REOWN = '[{"type":"reown-embedded-media","family":"media"}]';
    const docs = new Map(), deleted = [];
    const sync = { subscribe: async (id) => { if (!docs.has(id)) throw new Error('document not found: ' + id); return docs.get(id); }, softDelete: async (id) => { deleted.push(id); } };
    const make = (prefix, fn) => { const d = new Document(prefix + ulid()); d.transact(fn); docs.set(d.id, d); return d; };
    const proposed = (title, extra = {}) => make('tana:text:', (l) => { initDocument(l, title, ME); const data = l.getMap('data'); data.set('isProposal', true); for (const [k, v] of Object.entries(extra)) data.set(k, v); });
    const space = 'tana:space:' + ulid();
    const task = make('tana:text:', (l) => { initDocument(l, 'Proposed task', ME, { kind: 'task' }); const data = l.getMap('data'); data.set('isProposal', true); data.delete('stateChangedBy'); data.delete('assignedToUrisChangedBy'); });
    const note = proposed('Proposed note'), odd = proposed('Odd intent'), base = proposed('Base'), draft = proposed('Draft of base');
    const type = make('tana:type:', (l) => { initDocument(l, 'Project', ME, { kind: 'type', ownerUri: space }); });
    const typed = proposed('Typed elsewhere', { entityTypeUri: type.id, ownerUri: 'tana:event:' + ulid() });
    const pictured = proposed('With a picture');
    pictured.transact((l) => { const img = l.getMap('content').get('children').insertContainer(0, new LoroMap()); img.set('nodeName', 'image'); img.setContainer('attributes', new LoroMap()).set('tanaUri', 'tana:image:' + ulid()); });
    const chat = make('tana:chat:', (l) => {
      initDocument(l, 'Planning chat', ME, { kind: 'chat' });
      const m = l.getMap('data').get('messages').insertContainer(0, new LoroMap());
      m.set('id', 'ai000001'); m.set('type', 'message'); m.set('fromUserType', 'ai'); m.set('sentAt', 1788262342702);
      m.setContainer('content', new LoroMap()).setContainer('text', new LoroText()).insert(0, 'Here are the tasks.');
      const list = m.setContainer('proposals', new LoroList());
      const add = (operation, proposedUri, intents, baseUri) => {
        const p = list.insertContainer(list.length, new LoroMap());
        p.set('operation', operation); p.set('proposedUri', proposedUri); p.set('proposedAt', 1788262392412 + list.length);
        if (baseUri) p.set('baseUri', baseUri);
        const meta = p.setContainer('metadata', new LoroMap());
        if (intents) meta.set('intents', intents);
      };
      add('create', task.id, REOWN); add('create', note.id); add('create', odd.id, '[{"type":"place-at-owner","targetOwnerUri":"' + space + '"}]');
      add('update', draft.id, REOWN, base.id); add('create', typed.id, REOWN); add('create', pictured.id, REOWN);
    });
    const before = JSON.stringify(chat.toJSON());
    await assert.rejects(proposals.approve(sync, { chatUri: chat.id, proposedUri: draft.id, byUri: OTHER }), /merges a change/, 'an update is Tana\'s to merge');
    await assert.rejects(proposals.approve(sync, { chatUri: chat.id, proposedUri: odd.id, byUri: OTHER }), /only Tana can run/, 'an intent other than re-owning media is refused');
    await assert.rejects(proposals.approve(sync, { chatUri: chat.id, proposedUri: pictured.id, byUri: OTHER }), /images/, 're-owning media that is there to re-own is refused');
    await assert.rejects(proposals.approve(sync, { chatUri: chat.id, proposedUri: typed.id, byUri: OTHER }), /type's space/, 'a document Tana would move into its type\'s space is refused');
    await assert.rejects(proposals.approve(sync, { chatUri: chat.id, proposedUri: task.id, byUri: 'someone' }), /user-profile/);
    assert.equal(JSON.stringify(chat.toJSON()), before, 'a refusal writes nothing to the chat');
    assert.equal(pictured.data.get('isProposal'), true, 'nor to the document');

    await proposals.approve(sync, { chatUri: chat.id, proposedUri: task.id, byUri: OTHER });
    const entry = (uri) => proposals.entries(chat).find((e) => e.p.proposedUri === uri);
    assert.equal(typeof entry(task.id).p.approvedAt, 'number', 'the chat\'s entry is stamped approved');
    assert.equal(entry(note.id).p.approvedAt, undefined, 'and no other');
    const t = task.data.toJSON();
    assert.deepEqual([t.isProposal, t.createdInUri, t.stateChangedBy, t.assignedToUrisChangedBy, typeof t.assignedToUrisChangedAt], [false, chat.id, OTHER, OTHER, 'number'],
      'the document leaves proposal, was created in the chat, and a task names who accepted its state and assignment');
    const messages = chat.data.get('messages').toJSON(), status = messages.at(-1);
    assert.deepEqual([status.fromUserType, status.fromUserUri, status.content.text, status.attachmentUris, status.isStatusUpdate, status.excludeFromAIContext],
      ['human', OTHER, 'accepted 1 change', [task.id], true, true], 'the chat says who accepted what, as Tana does');
    assert.match(status.id, /^[0-9a-hjkmnp-tv-z]{8}$/, 'with a message id in Tana\'s alphabet');
    assert.equal(chatRows(messages).at(-1).children.at(-1).reference.uri, task.id, 'and the conversation shows it like Tana\'s own');
    await assert.rejects(proposals.approve(sync, { chatUri: chat.id, proposedUri: task.id, byUri: OTHER }), /no longer pending/, 'an answered proposal is not answered twice');
    await proposals.approve(sync, { chatUri: chat.id, proposedUri: note.id, byUri: OTHER });
    assert.equal(note.data.get('stateChangedBy'), undefined, 'a plain document gets no task attribution');

    // An action proposal runs on Tana's server first (its "Send to Slite"), and only then counts as approved; a run
    // refused writes nothing.
    {
      const action = make('tana:action:', (l) => { initDocument(l, 'Sync to Slite', ME); const data = l.getMap('data'); data.set('type', 'action'); data.set('isProposal', true); });
      const actionChat = make('tana:chat:', (l) => {
        initDocument(l, 'Slite chat', ME, { kind: 'chat' });
        const m = l.getMap('data').get('messages').insertContainer(0, new LoroMap());
        m.set('id', 'ai000002'); m.set('type', 'message'); m.set('fromUserType', 'ai'); m.set('sentAt', 1788262342702);
        const pr = m.setContainer('proposals', new LoroList()).insertContainer(0, new LoroMap());
        pr.set('operation', 'create'); pr.set('proposedUri', action.id); pr.set('proposedAt', 1788262392412); pr.setContainer('metadata', new LoroMap()).set('type', 'action');
      });
      const untouched = JSON.stringify(actionChat.toJSON()), args = { chatUri: actionChat.id, proposedUri: action.id, byUri: OTHER };
      await assert.rejects(proposals.approve(sync, args), /in Tana/, 'without a way to run it, an action is not approved');
      await assert.rejects(proposals.approve(sync, { ...args, execute: async () => { throw new Error('Slite is not connected'); } }), /Slite is not connected/, 'Tana\'s refusal comes back as it is');
      assert.deepEqual([JSON.stringify(actionChat.toJSON()), action.data.get('isProposal')], [untouched, true], 'and a run refused writes nothing');
      const ran = [];
      await proposals.approve(sync, { ...args, execute: async (a) => { ran.push(a); return { success: true }; } });
      assert.deepEqual(ran, [{ chatUri: actionChat.id, actionUri: action.id }], 'the action is run once, from its chat');
      const last = actionChat.data.get('messages').toJSON().at(-1);
      assert.deepEqual([typeof proposals.entries(actionChat)[0].p.approvedAt, action.data.get('isProposal'), action.data.get('createdInUri'), last.content.text, last.excludeFromAIContext],
        ['number', false, actionChat.id, 'accepted 1 change', false], 'then approved as Tana does, its acceptance kept in the AI\'s context');
      const calls = [], answers = [{ status: 401 }, { status: 200, json: { success: true, executorChatUri: 'tana:chat:x' } }, { status: 409, json: { success: false, error: 'Connect Slite first' } }];
      const fetch = async (url, init) => { calls.push([url, JSON.parse(init.body), init.headers.authorization]); const a = answers.shift(); return { status: a.status, ok: a.status < 300, json: async () => a.json || {} }; };
      const getAccessToken = async ({ refresh }) => (refresh ? 'fresh' : 'stale');
      const ok = await proposals.executeAction({ chatUri: 'tana:chat:c', actionUri: 'tana:action:a', getAccessToken, fetch, timezone: 'Europe/Amsterdam' });
      assert.deepEqual([ok.success, calls.map((c) => c[2]), calls[0][0], calls[0][1]], [true, ['Bearer stale', 'Bearer fresh'], 'https://home.tana.inc/api/ai/actions/execute', { chatUri: 'tana:chat:c', actionUri: 'tana:action:a', timezone: 'Europe/Amsterdam' }],
        'execute posts what Tana\'s client posts, and asks once more with a fresh token after a 401');
      await assert.rejects(proposals.executeAction({ chatUri: 'tana:chat:c', actionUri: 'tana:action:a', getAccessToken, fetch }), /Connect Slite first/, 'a refusal is Tana\'s own sentence');
      docs.delete(action.id); docs.delete(actionChat.id);
    }

    const { warnings } = await proposals.reject(sync, { chatUri: chat.id, proposedUri: draft.id });
    assert.deepEqual(warnings, []);
    assert.equal(entry(draft.id), undefined, 'a rejected proposal leaves the chat');
    assert.deepEqual(deleted, [draft.id], 'and its draft is deleted, the document it would have changed is not');
    assert.equal(proposals.entries(chat).length, 5, 'the other proposals stay');

    // The page: the graph's pending proposals as the proposed documents, filed by where they came from (issue #104), and an
    // answered one kept off it until the graph agrees.
    const backend = mainHelpers();
    const myMeeting = 'tana:event:' + ulid(), meeting = 'tana:event:' + ulid(), gone = 'tana:text:' + ulid();
    const meetingChat = 'tana:chat:' + ulid(), subChat = 'tana:chat:' + ulid(), looseChat = 'tana:chat:' + ulid();
    const spaceChat = 'tana:chat:' + ulid(), theirChat = 'tana:chat:' + ulid(), inSpace = 'tana:text:' + ulid(), theirs = 'tana:text:' + ulid();
    let listed = [
      { proposedUri: odd.id, operation: 'create', status: 'pending', proposedAt: '1788262392413' },
      { proposedUri: draft.id, baseUri: base.id, operation: 'update', status: 'pending', proposedAt: '1788262392414' },
      { proposedUri: note.id, operation: 'create', status: 'approved', proposedAt: '1788262392412' },
      { proposedUri: typed.id, operation: 'create', status: 'pending', proposedAt: '1788262392411' },
    ];
    const pendingIn = (proposedUri, at) => ({ proposals: [{ proposedUri, operation: 'create', status: 'pending', proposedAt: at }] });
    const chats = () => [
      { id: chat.id, title: 'Planning chat', ownerUri: myMeeting, chat: { proposals: listed } }, // a meeting you were in
      { id: meetingChat, title: '', ownerUri: meeting, chat: pendingIn(gone, '1788262392500') }, // one you see through its space
      { id: subChat, title: 'extractOutcome', ownerUri: meetingChat, chat: pendingIn(pictured.id, '1788262392450') }, // a subagent of that meeting's chat
      { id: looseChat, title: 'Routine', chat: pendingIn(note.id, '1788262392300') }, // no meeting at all
      { id: spaceChat, title: 'Space chat', ownerUri: 'tana:space:' + ulid(), chat: pendingIn(inSpace, '1788262392200') }, // a chat a space owns
      { id: theirChat, title: 'Their routine', ownerUri: OTHER, chat: pendingIn(theirs, '1788262392100') }, // a colleague's agent routine (#107)
    ];
    const known = new Map([[myMeeting, { id: myMeeting, title: 'Weekly' }], [meeting, { id: meeting, title: 'Studio Offsite ' }], [meetingChat, { id: meetingChat, title: '', ownerUri: meeting }]]);
    const node = (id) => known.get(id) || (docs.has(id) ? { id, title: docs.get(id).data.get('title'), entityType: docs.get(id).data.get('entityTypeUri'), ownerUri: docs.get(id).data.get('ownerUri') } : null);
    const participantQueries = [];
    const graph = { listNodes: async (q) => {
      if (q.nodeTypes) return { nodes: chats() };
      if (q.hasParticipantUris) { participantQueries.push(q); return { nodes: q.hasParticipantUris.includes(ME) ? [...q.nodeIds].filter((id) => id === myMeeting).map(node) : [] }; }
      return { nodes: [...(q.nodeIds || [])].map(node).filter(Boolean) };
    } };
    backend.testRuntime({ me: { userUri: ME }, client: { graph, sync } });
    const page = () => backend.handlers.get('outline:children')(null, 'orbital:proposals');
    const rows = await page();
    assert.deepEqual(rows.map((r) => [r.id, r.text, r.editable, r.proposal.approvable, r.proposal.group, r.proposal.note]), [
      [gone, 'Missing document', false, false, 'others', 'Proposed in Studio Offsite · its document is gone'],
      [pictured.id, 'With a picture', null, true, 'others', 'Proposed in extractOutcome'],
      [draft.id, 'Draft of base', null, false, 'mine', 'Change proposed in Planning chat · approve in Tana'],
      [odd.id, 'Odd intent', null, true, 'mine', 'Proposed in Planning chat'],
      [typed.id, 'Typed elsewhere', null, false, 'mine', 'Proposed in Planning chat · approve in Tana'],
      [note.id, 'Proposed note', null, true, 'mine', 'Proposed in Routine'],
      [inSpace, 'Missing document', false, false, 'others', 'Proposed in Space chat · its document is gone'],
      [theirs, 'Missing document', false, false, 'others', 'Proposed in Their routine · its document is gone'],
    ], 'pending only, newest first, as editable as the document is (unknown here: the fake graph lists no participants) and a missing one read-only, named by the chat or its meeting, filed by whether you were in that meeting and whose chat it is, approvable where Orbital can');
    assert.deepEqual(participantQueries.map((q) => [[...q.nodeIds].sort(), [...q.hasParticipantUris]]), [[[myMeeting, meeting].sort(), [ME]]],
      'whether you were in a meeting is one graph question for all of them, a subagent chat answering for its parent\'s meeting');
    assert.match(rows.find((r) => r.id === typed.id).proposal.reason, /type's space/, 'and the reason says why not');
    await assert.rejects(backend.handlers.get('proposals:answer')(null, 'tana:text:' + ulid(), odd.id, true), /Not a proposal/);
    await assert.rejects(backend.handlers.get('proposals:answer')(null, chat.id, odd.id, true), /only Tana can run/, 'the page hands the refusal back');
    await backend.handlers.get('proposals:answer')(null, chat.id, odd.id, false);
    const ids = [gone, pictured.id, draft.id, typed.id, note.id, inSpace, theirs];
    assert.deepEqual((await page()).map((r) => r.id), ids, 'a rejected proposal stays off the page while the graph still lists it');
    listed = listed.filter((p) => p.proposedUri !== odd.id);
    assert.deepEqual((await page()).map((r) => r.id), ids);
    console.log('ok  proposals: the graph lists pending ones, approve and reject write what Tana writes, and what Tana would do more for is refused untouched');
  }

  // Sending through main (chat:send): the chat's own agent is asked to answer, and a reply that cannot be asked for comes
  // back beside the saved message instead of failing the send, which the renderer would offer to send again (#447).
  {
    const backend = mainHelpers();
    const agent = 'tana:agent:' + ulid(), chatDoc = new Document('tana:chat:' + ulid());
    chatDoc.transact((l) => { initDocument(l, 'Agent chat', ME, { kind: 'chat' }); l.getMap('data').set('agentId', agent); });
    const sync = { subscribe: async (id) => { if (id !== chatDoc.id) throw new Error('document not found: ' + id); return chatDoc; } };
    const SAM = 'tana:user-profile:01examplesam00000000000000'; // a workspace member, for the invite below
    backend.testRuntime({ me: { userUri: ME }, client: { graph: { listNodes: async (q) => ({ nodes: (q.nodeTypes || []).includes('user-profile') ? [{ id: SAM, title: 'Sam Okafor' }] : [] }) }, sync }, session: { getAccessToken: async () => 'x.' + Buffer.from(JSON.stringify({ org_id: 'org', role: 'member' })).toString('base64url') + '.y' } });
    const bodies = [], realFetch = globalThis.fetch;
    let answer = { status: 200, body: { success: true, messageId: 'ai000009' } };
    globalThis.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return { status: answer.status, ok: answer.status === 200, json: async () => answer.body }; };
    try {
      const send = backend.handlers.get('chat:send');
      assert.equal((await send(null, chatDoc.id, 'Hello agent')).responding, true);
      assert.equal(bodies[0].agentId, agent, "the chat's own agent answers, not Tana's default assistant");
      answer = { status: 429, body: { success: false, error: 'ai_cap_exceeded' } };
      const failed = await send(null, chatDoc.id, 'Again');
      assert.deepEqual([failed.responding, /AI limit/.test(failed.replyError)], [false, true], 'a failed trigger is reported, not thrown');
      assert.deepEqual(chatDoc.data.get('messages').toJSON().filter((m) => !m.hiddenFromChat).map((m) => m.content.text), ['Hello agent', 'Again'], 'and the message it was for stays sent, once');
      // the composer's mode (Tab): To the chat asks nobody and marks the message the way Tana does; To Tana always asks
      assert.deepEqual({ ...await backend.handlers.get('chat:answers')(null, chatDoc.id) }, { ai: true, canWrite: true }, 'alone in your own chat, the composer starts at To Tana');
      const asked = bodies.length, quiet = await send(null, chatDoc.id, 'Just a note', [], { ai: false });
      assert.deepEqual([quiet.responding, bodies.length, chatDoc.data.get('messages').toJSON().at(-1).skipAutoResponse], [false, asked, true], 'To the chat asks nobody, and says so');
      answer = { status: 200, body: { success: true, messageId: 'ai000010' } };
      assert.deepEqual([(await send(null, chatDoc.id, 'Over to you', [], { ai: true })).responding, bodies.length], [true, asked + 1], 'To Tana asks');
      await assert.rejects(send(null, chatDoc.id, 'x', ['not a uri']), /Attachments are Tana documents/);
      // inviting: the member joins as an editor through the sharing rules, and the chat says so, as Tana's does
      await assert.rejects(backend.handlers.get('chat:invite')(null, chatDoc.id, 'tana:user-profile:01examplestranger000000000'), /member of this workspace/, 'nobody outside the workspace, and nothing written');
      assert.equal(chatDoc.data.get('participants').toJSON()['tana:user-profile:01examplestranger000000000'], undefined);
      assert.deepEqual({ ...await backend.handlers.get('chat:invite')(null, chatDoc.id, SAM) }, { name: 'Sam Okafor' });
      const joined = chatDoc.data.get('participants').toJSON()[SAM], lines = chatDoc.data.get('messages').toJSON().slice(-2);
      assert.deepEqual([joined.role, joined.type, joined.changedBy, chatDoc.data.get('participants').toJSON()[ME].role], ['editor', 'user', ME, 'admin']);
      assert.deepEqual(lines.map((m) => [m.content.text, m.isStatusUpdate, m.fromUserType]), [['Sam Okafor was added to the chat.', true, 'ai'], ['This chat now has multiple participants. Mention @Tana to trigger AI.', true, 'ai']]);
      await assert.rejects(backend.handlers.get('chat:invite')(null, chatDoc.id, SAM), /already in this chat/);
      // a group grant is never dropped: such a chat is refused, untouched
      chatDoc.transact((l) => { const g = l.getMap('data').get('participants').setContainer('tana:group:01examplegroup0000000000000', new LoroMap()); g.set('type', 'group'); g.set('role', 'editor'); });
      const before = JSON.stringify(chatDoc.data.get('participants').toJSON());
      chatDoc.transact((l) => l.getMap('data').get('participants').delete(SAM));
      await assert.rejects(backend.handlers.get('chat:invite')(null, chatDoc.id, SAM), /shared with a group/);
      assert.equal(chatDoc.data.get('participants').toJSON()['tana:group:01examplegroup0000000000000'].type, 'group');
      chatDoc.transact((l) => { const p = l.getMap('data').get('participants'); p.delete('tana:group:01examplegroup0000000000000'); const s = p.setContainer(SAM, new LoroMap()); for (const [k, v] of Object.entries(JSON.parse(before)[SAM])) s.set(k, v); });
      // answering Tana's questions asks it to go on from the relay
      chatDoc.transact((l) => {
        const m = l.getMap('data').get('messages').insertContainer(l.getMap('data').get('messages').length, new LoroMap());
        m.set('id', 'askmain1'); m.set('type', 'message'); m.set('fromUserType', 'ai');
        m.setContainer('toolCalls', new LoroList()).insertContainer(0, new LoroMap()).set('name', 'askUserQuestion'); m.get('toolCalls').get(0).set('status', 'awaiting_user_input');
        const q = m.setContainer('questionsData', new LoroMap()).setContainer('questions', new LoroList()).insertContainer(0, new LoroMap());
        q.set('id', 'q1'); q.set('question', 'Go?'); q.set('multiSelect', false); q.setContainer('options', new LoroList()).insertContainer(0, new LoroMap()).set('label', 'Yes');
      });
      const answered = await backend.handlers.get('chat:answer')(null, chatDoc.id, 'askmain1', { q1: { selected: ['Yes'] } });
      assert.deepEqual([answered.responding, bodies.at(-1).triggerMessageId], [true, answered.messageId], 'Tana goes on from the relay');
      // a chat you can only read takes nothing: refused before a message is written that would never reach Tana
      chatDoc.transact((l) => l.getMap('data').get('participants').get(ME).set('role', 'viewer'));
      const count = chatDoc.data.get('messages').length;
      await assert.rejects(send(null, chatDoc.id, 'Let me in'), /read this chat but not write/);
      assert.deepEqual([chatDoc.data.get('messages').length, (await backend.handlers.get('chat:answers')(null, chatDoc.id)).canWrite], [count, false]);
    } finally { globalThis.fetch = realFetch; }
    console.log("ok  chat:send asks the chat's own agent and keeps a sent message sent when the reply cannot be asked for");
  }

  // Asking an agent from a chat (main/chatagents.js, #468), with Codex, the only agent: nothing is written to the chat, the
  // task gets the question with the whole chat and the rules, the question stays on this device, and the answer is read
  // back and kept.
  {
    const backend = mainHelpers();
    const chatDoc = new Document('tana:chat:' + ulid());
    chatDoc.transact((l) => initDocument(l, 'Team chat', ME, { kind: 'chat' }));
    const sync = { subscribe: async (id) => { if (id !== chatDoc.id) throw new Error('document not found: ' + id); return chatDoc; } };
    backend.testRuntime({ me: { userUri: ME }, client: { graph: { listNodes: async (q) => ({ nodes: (q.nodeTypes || []).includes('user-profile') ? [{ id: ME, title: 'Robin Vega' }] : [] }) }, sync }, userData: '/tmp/orbital-chatagents-check', session: { getAccessToken: async () => 'x.' + Buffer.from(JSON.stringify({ org_id: 'org', role: 'member' })).toString('base64url') + '.y' } });
    const realFetch = globalThis.fetch, created = [];
    let fetched = 0;
    globalThis.fetch = async () => { fetched++; return { status: 200, ok: true, json: async () => ({ success: true }) }; };
    const realCreate = backend.agent.createTask, realRpc = backend.agent.appServerRpc;
    backend.agent.createTask = async (opts) => { created.push(opts); return '01a0b3a3-c000-70b0-896e-08e86986ca10'; };
    try {
      const askAgent = backend.handlers.get('chatAgent:ask'), ask = (e, id, text) => askAgent(e, id, 'codex', text), replies = backend.handlers.get('chatAgent:replies');
      // offered only where it can run
      const realBin = backend.agent.codexBin;
      backend.agent.codexBin = () => null;
      assert.deepEqual([...await backend.handlers.get('chatAgent:list')(null)], [], 'no Codex on this device, no agent to offer');
      backend.agent.codexBin = () => '/usr/local/bin/codex';
      assert.deepEqual([...await backend.handlers.get('chatAgent:list')(null)].map((a) => ({ ...a })), [{ id: 'codex', label: 'Codex', icon: 'robot' }]);
      backend.agent.codexBin = realBin;
      await assert.rejects(askAgent(null, chatDoc.id, 'claude', '@Claude hi'), /No such agent/, 'only the agents in the table');
      await backend.handlers.get('chat:send')(null, chatDoc.id, 'The actions are in', [], { ai: false });
      await assert.rejects(ask(null, chatDoc.id, 'no mention here'), /Mention @Codex/);
      const before = chatDoc.data.get('messages').toJSON().length;
      const { id } = await ask(null, chatDoc.id, '@Codex turn these into issues');
      assert.deepEqual([chatDoc.data.get('messages').toJSON().length, fetched], [before, 0], 'nothing is written to the chat, and Tana is not asked');
      assert.deepEqual([created.length, created[0].nodeUri, created[0].host], [1, chatDoc.id, 'local'], 'one Codex task on this Mac');
      assert.match(created[0].prompt, /^turn these into issues\n[\s\S]*Robin Vega: The actions are in$/, 'the task gets the question and the whole chat, oldest first');
      assert.match(created[0].instructions, /Neither is saved to Tana/, 'and the rules for the whole thread');
      assert.equal(backend.settings.isSynced('chatAsks'), false, 'the question and its task stay on this Mac');
      // the answer: the latest turn's final answer, read once and then kept
      let spawned = 0, turn = { status: 'interrupted', items: [{ type: 'agentMessage', phase: 'commentary', text: 'Looking' }] };
      backend.agent.appServerRpc = () => { spawned++; return { ready: Promise.resolve(), call: async (m) => { assert.equal(m, 'thread/turns/list'); return { data: [turn] }; }, stop() {} }; };
      assert.deepEqual([...await replies(null, chatDoc.id)].map((a) => [a.id, a.question, a.state]), [[id, '@Codex turn these into issues', 'working']], 'a turn still running elsewhere reads as interrupted, and progress is not the answer');
      turn = { status: 'completed', items: [{ type: 'agentMessage', phase: 'commentary', text: 'Looking' }, { type: 'agentMessage', phase: 'final_answer', text: 'Made three issues' }] };
      assert.deepEqual([...await replies(null, chatDoc.id)].map((a) => [a.state, a.text]), [['done', 'Made three issues']]);
      assert.deepEqual([(await replies(null, chatDoc.id))[0].text, spawned], ['Made three issues', 2], 'a finished answer is not read again');
      // kept on this Mac: read again from the database, as after a restart
      backend.settings.reset();
      assert.deepEqual([...await replies(null, chatDoc.id)].map((a) => [a.id, a.question, a.text]), [[id, '@Codex turn these into issues', 'Made three issues']], 'the question and its answer are still there after a restart');
      // an ask from the build that wrote its question to the chat: its words are read back from the chat once
      const said = chatDoc.data.get('messages').toJSON().find((m) => m.content && m.content.text === 'The actions are in');
      const kept = backend.settings.get('chatAsks');
      backend.settings.set('chatAsks', { ...kept, [chatDoc.id]: [...kept[chatDoc.id], { messageId: said.id, agent: 'codex', taskId: 't-old', at: 1, state: 'done', text: 'Old answer' }] });
      assert.deepEqual([...await replies(null, chatDoc.id)].map((a) => [a.id, a.question]), [[id, '@Codex turn these into issues'], [said.id, 'The actions are in']], 'an older ask gets its question back');
      // forgotten: gone from this device, the chat untouched
      await backend.handlers.get('chatAgent:delete')(null, chatDoc.id, said.id);
      assert.deepEqual([...await replies(null, chatDoc.id)].map((a) => a.id), [id]);
      // your own message deleted from the chat, as Tana's Delete message does; the AI's is refused
      const del = backend.handlers.get('chat:delete');
      chatDoc.transact((l) => require('../sdk/chat').pushMessage(l, { fromUserType: 'ai', sentAt: 2 }, 'Tana says hi'));
      await assert.rejects(del(null, chatDoc.id, chatDoc.data.get('messages').toJSON().at(-1).id), /Only your own/);
      await del(null, chatDoc.id, said.id);
      assert.deepEqual(chatDoc.data.get('messages').toJSON().filter((m) => !m.hiddenFromChat).map((m) => m.content.text), ['Tana says hi'], 'your message is gone, the rest stays');
      await assert.rejects(del(null, chatDoc.id, said.id), /not in this chat/);
      assert.deepEqual([...await replies(null, 'not a chat')], []);
      // the task behind a question opens in Codex by its id; anything unknown opens nothing
      assert.equal(await backend.handlers.get('chatAgent:open')(null, chatDoc.id, id), true);
      assert.equal(backend.opened.at(-1), 'codex://threads/01a0b3a3-c000-70b0-896e-08e86986ca10', 'the task this question started');
      assert.equal(await backend.handlers.get('chatAgent:open')(null, chatDoc.id, 'nosuchid'), false);
      // a task that cannot start leaves nothing behind: no message, no question kept
      backend.agent.createTask = async () => { throw new Error('Codex is not installed on this Mac'); };
      await assert.rejects(ask(null, chatDoc.id, 'again @codex'), /not installed/);
      assert.deepEqual([chatDoc.data.get('messages').toJSON().length, (await replies(null, chatDoc.id)).length], [before, 1]);
    } finally { globalThis.fetch = realFetch; backend.agent.createTask = realCreate; backend.agent.appServerRpc = realRpc; }
    console.log('ok  chatAgent:ask keeps the question and its answer on this Mac across a restart, hands the whole chat to a local Codex task, reads its answer back once; chat:delete deletes only your own messages');
  }



  // What the web client shows of a conversation, and how it words the thinking line (docs/CHATS.md §4).
  {
    const chat = require('../sdk/chat');
    const rows = chat.chatRows([
      { type: 'message', fromUserType: 'human', fromUserUri: ME, isStatusUpdate: true, content: { text: 'renamed the chat' }, sentAt: 1 },
      { type: 'message', fromUserType: 'human', fromUserUri: ME, isAIInterviewRelay: true, content: { text: 'relayed' }, sentAt: 1 },
      { type: 'message', fromUserType: 'human', fromUserUri: ME, isStatusUpdate: true, content: { text: 'accepted 1 change' }, sentAt: 1, editedAt: 2 },
      { type: 'message', fromUserType: 'ai', content: { text: '1. one\n#### deep *it* ~~gone~~' }, sentAt: 0, completedAt: 125000 },
      { type: 'message', fromUserType: 'ai', content: { text: 'x' }, sentAt: 0, completedAt: 120000, toolCalls: [{ id: 'c', name: 'readItems', status: 'completed' }] },
    ]);
    assert.deepEqual(rows.map((r) => r.id), ['m0', 'm2', 'm3', 'm4'], 'interview relays are hidden, as Tana\'s chat panel hides them');
    assert.deepEqual([rows[0].text, rows[0].chat.status], ['renamed the chat', true], 'any other status update is a line of its own');
    assert.ok(rows[1].meta.endsWith(' (edited)'));
    assert.deepEqual(rows[2].children.map((n) => n.block), ['numbered', 'heading3'], 'no thinking line without tool calls; deep headings read as the third level');
    assert.deepEqual(rows[2].children[1].segments, [{ text: 'deep ' }, { text: 'it', marks: { italic: true } }, { text: ' ' }, { text: 'gone', marks: { strike: true } }]);
    assert.equal(rows[3].children[0].text, 'Thought for 2 minutes');
    assert.equal(rows[3].children[0].thinking, undefined, 'a finished line is still');
    assert.equal(chat.chatRows([{ fromUserType: 'ai', toolCalls: [{ status: 'running' }] }])[0].children[0].thinking, true, 'a running call makes the line shimmer');
    const between = chat.chatRows([{ id: 'str00001', fromUserType: 'ai', sentAt: 1, completedAt: 2, toolCalls: [{ status: 'completed' }] }], { streamingId: 'str00001' })[0].children[0];
    assert.deepEqual([between.text, between.thinking], ['Thinking...', true], 'between calls, still streaming: thinking, as the web client says, not finished');
    const states = chat.chatRows([
      { fromUserType: 'ai', status: 'cancelled' },
      { fromUserType: 'ai', status: 'error', errorMessage: 'Provider failed' },
      { fromUserType: 'ai', status: 'limit_exceeded' },
      { id: 'ask00001', fromUserType: 'ai', toolCalls: [{ name: 'askUserQuestion', status: 'awaiting_user_input' }], questionsData: {
        answered: false, skipped: false, questions: [{ id: 'q1', question: 'Choose a plan', multiSelect: true, options: [{ label: 'Basic', description: 'For a small team' }, { label: 'Pro' }] }],
      } },
    ]);
    assert.deepEqual(states.slice(0, 3).map((r) => r.children[0].text), ['Cancelled', 'Error: Provider failed', 'Limit exceeded']);
    const waiting = states[3];
    assert.deepEqual(waiting.children.map((r) => r.text), ['Waiting for your input'], 'the questions are no outline rows');
    assert.equal(waiting.children[0].thinking, undefined, 'waiting on you is not thinking');
    assert.deepEqual(JSON.parse(JSON.stringify(waiting.chat.questions)), { messageId: 'ask00001', items: [{ id: 'q1', question: 'Choose a plan', multiSelect: true, options: [{ label: 'Basic', description: 'For a small team' }, { label: 'Pro' }] }] }, 'they go to the question card');
    const readOnly = (nodes) => nodes.every((n) => n.editable === false && readOnly(n.children || []));
    assert.ok(readOnly(states), 'status and pending-question rows are read-only');
    console.log('ok  chat visibility and the thinking line follow the web client');
  }
  // Sending (#chat): a message written as Tana's addHumanMessageWithTimeContext writes it, and the trigger asking its AI
  // to answer, retried the way the web client retries a chat the server has not seen yet (docs/CHATS.md §10).
  {
    const chat = require('../sdk/chat');
    const doc = new Document('tana:chat:01exampleq0000000000000000');
    const at = Date.UTC(2026, 8, 27, 9, 52);
    let first, second;
    doc.transact((l) => { first = chat.addMessage(l, { text: 'Hello Tana', byUri: ME, senderName: 'Robin Vega', timezone: 'Europe/Amsterdam', now: at }); });
    doc.transact((l) => { second = chat.addMessage(l, { text: 'And again', byUri: ME, senderName: 'Robin Vega', timezone: 'Europe/Amsterdam', now: at + 6e4 }); });
    const messages = doc.data.get('messages').toJSON();
    assert.equal(messages.length, 3, 'the hidden preamble goes before the first message of a day only');
    assert.deepEqual([messages[0].hiddenFromChat, messages[0].isStatusUpdate, messages[0].content.text], [true, true, 'Robin Vega — it is now Sunday, September 27, 2026 at 11:52 AM (Europe/Amsterdam).']);
    assert.deepEqual({ ...messages[1], id: undefined }, { type: 'message', id: undefined, sentAt: at, fromUserUri: ME, fromUserType: 'human', content: { text: 'Hello Tana' },
      attachmentUris: [], proposals: [], toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, model: '', cost: 0 } }, 'a message has the lists and zeroed usage Tana writes');
    assert.deepEqual([messages[1].id, messages[2].id], [first, second]);
    assert.deepEqual(doc.loro.getMap('participantTimeContext').toJSON(), { [ME]: { timezone: 'Europe/Amsterdam', lastLocalDate: '2026-09-27' } });
    assert.throws(() => doc.transact((l) => chat.addMessage(l, { text: '  ', byUri: ME })), /Nothing to send/);
    // Tana's questions answered as its question panel answers them (docs/CHATS.md §11)
    const ask = (id) => doc.transact((l) => {
      const m = l.getMap('data').get('messages').insertContainer(l.getMap('data').get('messages').length, new LoroMap());
      m.set('id', id); m.set('type', 'message'); m.set('fromUserType', 'ai'); m.set('sentAt', at); m.set('completedAt', at + 1);
      m.setContainer('toolCalls', new LoroList()).insertContainer(0, new LoroMap()).set('name', 'askUserQuestion');
      m.get('toolCalls').get(0).set('id', 'call_1'); m.get('toolCalls').get(0).set('status', 'awaiting_user_input');
      const qs = m.setContainer('questionsData', new LoroMap()).setContainer('questions', new LoroList());
      for (const [qid, question, multi] of [['q1', 'Which plan?', false], ['q2', 'Which extras?\nPick any', true]]) {
        const q = qs.insertContainer(qs.length, new LoroMap()); q.set('id', qid); q.set('question', question); q.set('multiSelect', multi);
        const os = q.setContainer('options', new LoroList());
        for (const label of multi ? ['Support', 'Backups'] : ['Basic', 'Pro']) os.insertContainer(os.length, new LoroMap()).set('label', label);
        q.setContainer('selectedOptions', new LoroList()); q.setContainer('customAnswer', new LoroText());
      }
    });
    ask('ask00002');
    let relay;
    doc.transact((l) => { relay = chat.answerQuestions(l, { messageId: 'ask00002', answers: { q1: { selected: ['Pro', 'Basic'], custom: '' }, q2: { selected: ['Backups', 'Nope'], custom: 'weekly' } }, byUri: ME, now: at + 5 }); });
    const after = doc.data.get('messages').toJSON(), asked = after.find((m) => m.id === 'ask00002'), sent = after.at(-1);
    const summary = '[User answered AI questions]\n- Which plan?: Pro\n- Which extras? […]: Backups; Custom: weekly';
    assert.deepEqual(asked.questionsData.questions.map((q) => [q.selectedOptions, q.customAnswer]), [[['Pro'], ''], [['Backups', '__custom__'], 'weekly']], 'one choice for a single answer, only offered labels, the free answer marked the way Tana marks it');
    assert.deepEqual([asked.questionsData.answered, asked.questionsData.skipped, asked.questionsData.answeredByUri, asked.toolCalls[0].status, asked.toolCalls[0].output], [true, false, ME, 'completed', summary]);
    assert.deepEqual([sent.id, sent.isAIInterviewRelay, sent.excludeFromAIContext, sent.content.text], [relay, true, true, summary], 'the relay carries what Tana is told');
    assert.equal(chat.chatRows(after).some((r) => r.chat.questions || r.chat.id === relay), false, 'answered, the card goes and the relay stays hidden');
    assert.throws(() => doc.transact((l) => chat.answerQuestions(l, { messageId: 'ask00002', answers: {}, byUri: ME })), /no longer waiting/);
    ask('ask00003');
    doc.transact((l) => chat.answerQuestions(l, { messageId: 'ask00003', answers: null, byUri: ME }));
    assert.equal(doc.data.get('messages').toJSON().at(-1).content.text, '[User skipped AI questions]\nPlease continue with sensible defaults and note assumptions briefly.', 'Dismiss tells Tana to go on with defaults');
    // a skill run from "/" rides along as the message's attachment, as Tana's runSkill sends it
    doc.transact((l) => chat.addMessage(l, { text: 'Run [Diagram](tana:skill:01examples0000000000000000)', byUri: ME, senderName: 'Robin Vega', attachments: ['tana:skill:01examplet0000000000000000'], timezone: 'Europe/Amsterdam', now: at + 12e4 }));
    assert.deepEqual(doc.data.get('messages').toJSON().at(-1).attachmentUris, ['tana:skill:01examplet0000000000000000']);
    doc.data.get('messages').delete(doc.data.get('messages').length - 1, 1);
    const rows = chat.chatRows([...messages, { id: 'ai000001', type: 'message', fromUserType: 'ai', content: { text: '' }, sentAt: at + 7e4 }], { me: ME, streamingId: 'ai000001' });
    assert.deepEqual(rows.map((r) => [r.chat.mine, !!r.chat.streaming]), [[true, false], [true, false], [false, true]], 'the preamble is hidden; the bubbles know whose they are and which one Tana is writing');
    // Tana answers by itself while you are alone in a chat, when mentioned with others in it, and never when switched off
    const OTHER = 'tana:user-profile:01exampler0000000000000000', alone = { participants: { [ME]: {} } }, together = { participants: { [ME]: {}, [OTHER]: {} } };
    assert.deepEqual([chat.autoResponds(alone), chat.autoResponds(together), chat.autoResponds(together, 'what do you think @Tana?'), chat.autoResponds({ ...alone, aiAutoResponds: false })], [true, false, true, false]);
    // the composer's "@" mentions Tana as a link to its agent, which Tana's own rule (its v$) counts as asking it
    assert.equal(chat.autoResponds(together, 'what do you think [Tana](' + chat.TANA_AGENT + ')?'), true);
    assert.ok(fs.readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'chat.js'), 'utf8').includes("TANA_AGENT_URI = '" + chat.TANA_AGENT + "'"), 'the renderer mentions the same agent');
    assert.equal(chat.TANA_AGENT, 'tana:agent:' + chat.deterministicId('system:tana'));
    assert.match(chat.TANA_AGENT, /^tana:agent:[0-9a-hjkmnp-tv-z]{26}$/);
    // the trigger: 401 refreshes the token once, 404 is retried, and Tana's error comes back in words
    const calls = [], answers = [{ status: 401 }, { status: 404 }, { status: 200, body: { success: true, messageId: 'ai000002' } }];
    const fetch = async (url, init) => { calls.push({ url, init }); const a = answers.shift(); return { status: a.status, ok: a.status === 200, json: async () => a.body || {} }; };
    const tokens = [];
    const answer = await chat.triggerReply({ chatUri: doc.id, messageId: first, timezone: 'Europe/Amsterdam', fetch, wait: async () => {}, getAccessToken: async ({ refresh }) => { tokens.push(refresh); return 't'; } });
    assert.equal(answer.messageId, 'ai000002');
    assert.deepEqual(tokens, [false, true, false], 'a refused token is refreshed once');
    assert.equal(calls[0].url, 'https://home.tana.inc/api/ai/chat/trigger');
    assert.deepEqual(JSON.parse(calls[0].init.body), { chatUri: doc.id, agentId: chat.TANA_AGENT, triggerMessageId: first, timezone: 'Europe/Amsterdam' });
    await assert.rejects(chat.triggerReply({ chatUri: doc.id, messageId: first, wait: async () => {}, getAccessToken: async () => 't',
      fetch: async () => ({ status: 429, ok: false, json: async () => ({ success: false, error: 'ai_cap_exceeded' }) }) }), /Tana AI limit/);
    console.log('ok  chat sending writes what Tana writes and asks its AI to answer');
  }
  // What a call left behind (#31) and its transcript (#24), in the shapes the live documents had on 2026-09-23.
  {
    const { callState, readTranscript } = require('../sdk/calls');
    const OTHER = 'tana:user-profile:01examplej0000000000000000', GUEST = 'tana:guest-profile:01examplek0000000000000000';
    const SUMMARY = 'tana:text:01examplem0000000000000000', PRESENTED = 'tana:text:01examplen0000000000000000';
    const call = new Document('tana:call:01examplep0000000000000000');
    const record = (root, key, fields) => { const m = root.setContainer(key, new LoroMap()); for (const [k, v] of Object.entries(fields)) m.set(k, v); };
    call.transact((l) => {
      const d = l.getMap('data');
      d.set('summaryUri', SUMMARY); d.set('transcriptionPaused', true); d.set('videoRoomSecret', 'room-secret');
      const hands = d.setContainer('callParticipantState', new LoroMap());
      record(hands, OTHER, { handRaisedAt: 10, handRaiseSeq: 3 }); // an earlier clock, a later place in the queue
      record(hands, ME, { handRaisedAt: 20, handRaiseSeq: 2 });
      record(l.getMap('recordings'), 'r2', { recordingId: 'r2', provider: 'livekit', status: 'ready', startedAt: 200, startedByUri: ME });
      record(l.getMap('recordings'), 'r1', { recordingId: 'r1', provider: 'livekit', status: 'failed', startedAt: 100, startedByUri: ME });
      record(l.getMap('documentPresentations'), 'p1', { presentationId: 'p1', documentUri: PRESENTED, startedAt: 50, startedByUri: OTHER });
      record(l.getMap('guestProfiles'), GUEST, { displayName: 'Boardroom - Teams' });
      record(l.getMap('reactions'), ME + ':+1:0', { emoji: '+1', senderUri: ME, bucketStart: 0, count: 2 });
      l.getMap('wrapUp').set('summaryCompletedAt', 5);
    });
    const state = callState(call);
    assert.equal(state.summaryUri, SUMMARY); assert.deepEqual(state.wrapUp, { summaryCompletedAt: 5 }); assert.equal(state.offTheRecord, true);
    assert.deepEqual(state.recordings.map((r) => [r.recordingId, r.status]), [['r1', 'failed'], ['r2', 'ready']], 'recordings oldest first');
    assert.deepEqual(state.presentations.map((p) => [p.documentUri, p.endedAt]), [[PRESENTED, undefined]], 'still on screen');
    assert.deepEqual(state.guests, [{ uri: GUEST, displayName: 'Boardroom - Teams' }]);
    assert.deepEqual(state.raisedHands, [{ userUri: ME, handRaisedAt: 20 }, { userUri: OTHER, handRaisedAt: 10 }], 'the queue follows handRaiseSeq, not the clock');
    assert.deepEqual(state.reactions, [{ emoji: '+1', senderUri: ME, bucketStart: 0, count: 2 }]);
    assert.ok(!JSON.stringify(state).includes('room-secret'), 'the room secret is never returned');
    assert.deepEqual(callState(new Document('tana:call:01exampleq0000000000000000')), { summaryUri: null, wrapUp: {}, offTheRecord: false, recordings: [], presentations: [], guests: [], raisedHands: [], reactions: [] });

    const transcript = new Document('tana:transcript:01examplep0000000000000000');
    transcript.transact((l) => {
      const d = l.getMap('data'), segments = d.setContainer('segments', new LoroList());
      d.set('summary', 'We agreed on the budget.');
      for (const [id, start, text] of [['s2', 5.5, 'second'], ['s1', 1.25, 'first'], ['s2', 9, 'a later copy of s2']]) {
        const m = segments.pushContainer(new LoroMap());
        for (const [k, v] of Object.entries({ id, start_sec: start, end_sec: start + 1, text, speaker: 'Robin', speakerUri: ME, confidence: 1 })) m.set(k, v);
        m.setContainer('words', new LoroList()); m.setContainer('alternatives', new LoroList());
      }
      const tree = l.getTree('sections'), node = (parent, meta) => { const n = tree.createNode(parent); for (const [k, v] of Object.entries(meta)) n.data.set(k, v); return n; };
      const budget = node(undefined, { title: 'Budget', recap: JSON.stringify({ line: 'Budget agreed', start: 0, end: 60 }), start_sec: 0, end_sec: 60 });
      node(budget.id, { title: 'Numbers', start_sec: 0, end_sec: 30 });
      node(undefined, { title: 'Hiring', recap: 'not json', recapTitle: 'Hiring plan', start_sec: 60, end_sec: 120 });
    });
    // a transcript is read container by container: the whole document is never turned into JSON
    transcript.toJSON = transcript.loro.toJSON = () => assert.fail('readTranscript serialised the whole transcript');
    const read = readTranscript(transcript);
    assert.deepEqual(read.segments.map((s) => s.text), ['first', 'second'], 'sorted by start_sec, the first copy of an id kept');
    assert.deepEqual(Object.keys(read.segments[0]).sort(), ['alternatives', 'confidence', 'end_sec', 'id', 'speaker', 'speakerUri', 'start_sec', 'text', 'words']);
    assert.equal(read.summary, 'We agreed on the budget.');
    assert.deepEqual(read.sections.map((s) => s.label), ['Budget agreed', 'Hiring plan'], "Tana's label: the recap's line, else recapTitle, else title");
    assert.deepEqual(read.sections[0].recap, { line: 'Budget agreed', start: 0, end: 60 });
    assert.equal(read.sections[1].recap, undefined, 'a recap that is not JSON is left out');
    assert.deepEqual(read.sections[0].children.map((s) => [s.label, s.start_sec, s.end_sec, s.children.length]), [['Numbers', 0, 30, 0]]);
    assert.deepEqual(readTranscript(new Document('tana:transcript:01exampleq0000000000000000')), { summary: '', segments: [], sections: [] });
    console.log('ok  call state (recordings, presentations, guests, raised hands, reactions, summary) and the transcript reader');
  }
  // Tana's schema: 8-character ids are Crockford base32, underline is a mark, and a table holds no editable text.
  {
    for (let i = 0; i < 200; i++) assert.match(outline.newId(), /^[0-9a-hjkmnp-tv-z]{8}$/);
    const d = new Document(DOC);
    d.transact((l) => {
      const c = l.getMap('content'); c.set('nodeName', 'doc'); c.setContainer('attributes', new LoroMap());
      const kids = c.setContainer('children', new LoroList());
      const p = kids.insertContainer(0, new LoroMap()); p.set('nodeName', 'paragraph');
      p.setContainer('attributes', new LoroMap()).set('blockId', 'p0000000');
      p.setContainer('children', new LoroList()).insertContainer(0, new LoroText()).insert(0, 'under');
      const t = kids.insertContainer(1, new LoroMap()); t.set('nodeName', 'table');
      t.setContainer('attributes', new LoroMap()).set('blockId', 't0000000');
      const row = t.setContainer('children', new LoroList()).insertContainer(0, new LoroMap()); row.set('nodeName', 'tableRow');
      row.setContainer('attributes', new LoroMap()); row.setContainer('children', new LoroList());
    });
    outline.setText(d, 'p0000000', [{ text: 'under', marks: { underline: true } }]);
    assert.deepEqual(outline.readOutline(d)[0].segments, [{ text: 'under', marks: { underline: true } }]);
    assert.equal(outline.readOutline(d)[1].editable, false, 'a table is read-only here');
    assert.throws(() => outline.setText(d, 't0000000', 'x'), /cannot contain editable text/);
    assert.throws(() => outline.setBlockType(d, 't0000000', 'paragraph'), /cannot change type/);
    console.log('ok  content schema: Crockford ids, underline mark, tables left alone');
  }
  // #35: a line break is Tana's inline hardBreak node, in the shape its editor writes (loro-prosemirror: a map with an
  // attributes map and a children list, both empty), splitting the text into two runs; orderedList.start and
  // codeBlock.language are kept, read and cleared where they stop meaning anything.
  {
    const d = new Document(DOC);
    const HB = { nodeName: 'hardBreak', attributes: {}, children: [] };
    const para = (list, i, id, words) => { const p = list.insertContainer(i, new LoroMap()); p.set('nodeName', 'paragraph'); p.setContainer('attributes', new LoroMap()).set('blockId', id); const c = p.setContainer('children', new LoroList()); if (words) c.insertContainer(0, new LoroText()).insert(0, words); return c; };
    d.transact((l) => {
      const c = l.getMap('content'); c.set('nodeName', 'doc'); c.setContainer('attributes', new LoroMap());
      const kids = c.setContainer('children', new LoroList());
      const pc = para(kids, 0, 'p1000000', 'ab');
      const hb = pc.insertContainer(1, new LoroMap()); hb.set('nodeName', 'hardBreak'); hb.setContainer('attributes', new LoroMap()); hb.setContainer('children', new LoroList());
      pc.insertContainer(2, new LoroText()).insert(0, 'cd');
      const ol = kids.insertContainer(1, new LoroMap()); ol.set('nodeName', 'orderedList');
      const oa = ol.setContainer('attributes', new LoroMap()); oa.set('blockId', 'o1000000'); oa.set('start', 3);
      const items = ol.setContainer('children', new LoroList());
      ['n1000000', 'n2000000'].forEach((id, i) => { const li = items.insertContainer(i, new LoroMap()); li.set('nodeName', 'listItem'); li.setContainer('attributes', new LoroMap()).set('blockId', 'l' + id.slice(1)); para(li.setContainer('children', new LoroList()), 0, id, 'item' + i); });
      const code = kids.insertContainer(2, new LoroMap()); code.set('nodeName', 'codeBlock');
      const ca = code.setContainer('attributes', new LoroMap()); ca.set('blockId', 'c1000000'); ca.set('language', 'js');
      code.setContainer('children', new LoroList()).insertContainer(0, new LoroText()).insert(0, 'a\nb');
    });
    const raw = () => d.content.toJSON().children;
    // read: one newline for the break, in text and segments alike
    const [p1, n1, n2, c1] = outline.readOutline(d);
    assert.equal(p1.text, 'ab\ncd', 'contentText reads a hardBreak as one newline, not a block boundary');
    assert.deepEqual(p1.segments, [{ text: 'ab' }, { text: '\n' }, { text: 'cd' }]);
    assert.deepEqual([n1.start, n2.start, c1.block], [3, undefined, 'code'], 'a numbered list that starts at 3 says so on its first row');
    // offsets: the break is one character and one ProseMirror position; a caret after it is on the second run
    assert.deepEqual([outline.charOffset(d, 'p1000000', 3), outline.blockOffset(d, 'p1000000', 3), outline.charOffset(d, 'p1000000', 2)], [3, 3, 2]);
    assert.deepEqual(outline.cursorOffset(d, outline.cursorAt(d, 'p1000000', 3)), { blockId: 'p1000000', offset: 3 });
    assert.deepEqual(outline.cursorOffset(d, outline.cursorAt(d, 'p1000000', 2)), { blockId: 'p1000000', offset: 2 });
    // edit: the existing break stays the same container, with segments and with a plain string
    const breakId = d.content.get('children').get(0).get('children').get(1).id;
    outline.setText(d, 'p1000000', [{ text: 'abX' }, { text: '\n' }, { text: 'cd', marks: { bold: true } }]);
    assert.deepEqual(raw()[0].children, ['abX', HB, 'cd']);
    outline.setText(d, 'p1000000', 'abX\ncdY');
    assert.equal(d.content.get('children').get(0).get('children').get(1).id, breakId, 'editing a line keeps its hardBreak');
    assert.deepEqual(outline.readOutline(d)[0].segments, [{ text: 'abX' }, { text: '\n' }, { text: 'cd', marks: { bold: true } }, { text: 'Y' }], 'a string keeps the marks there were (bold does not expand)');
    // write: a newline becomes a break, marks go on both runs, and a new row written with one gets one too
    outline.setText(d, 'n2000000', [{ text: 'x\ny', marks: { bold: true } }]);
    assert.deepEqual(outline.readOutline(d)[2].segments, [{ text: 'x', marks: { bold: true } }, { text: '\n' }, { text: 'y', marks: { bold: true } }]);
    const fresh = outline.insertAfter(d, 'p1000000', 'one\ntwo');
    assert.deepEqual(raw()[1].children, ['one', HB, 'two']);
    assert.equal(raw()[1].attributes.blockId, fresh);
    // a code block keeps newlines as text (content text*) and keeps its language while it is one
    outline.setText(d, 'c1000000', 'x\ny');
    assert.deepEqual([raw()[3].children, raw()[3].attributes.language], [['x\ny'], 'js']);
    outline.setBlockType(d, 'c1000000', 'paragraph');
    assert.deepEqual([raw()[3].nodeName, raw()[3].attributes.language, raw()[3].children], ['paragraph', undefined, ['x', HB, 'y']], 'out of a code block the language goes and newlines become breaks');
    // start survives a text edit, and goes when the list stops being numbered
    outline.setText(d, 'n1000000', 'first');
    assert.equal(raw()[2].attributes.start, 3);
    outline.setBlockType(d, 'n2000000', 'bullet');
    outline.setBlockType(d, 'n1000000', 'bullet');
    assert.deepEqual([raw()[2].nodeName, raw()[2].attributes.start], ['bulletList', undefined], 'a bullet list carries no start');
    console.log('ok  line breaks as hardBreak nodes (read, kept, written, offsets) and orderedList start / codeBlock language');
  }
  // Tables (issue #32): Tana's table > tableRow > tableHeader|tableCell > block+, read as rows x cells, and one cell's
  // text written the way its updateCell does, into the cell's first paragraph, leaving an image in the cell alone.
  {
    const d = new Document(DOC);
    const block = (list, i, nodeName, attrs = {}) => {
      const m = list.insertContainer(i, new LoroMap()); m.set('nodeName', nodeName);
      const a = m.setContainer('attributes', new LoroMap()); for (const [k, v] of Object.entries(attrs)) a.set(k, v);
      return m;
    };
    const para = (list, i, id, words) => { const p = block(list, i, 'paragraph', id ? { blockId: id } : {}); const c = p.setContainer('children', new LoroList()); if (words) c.insertContainer(0, new LoroText()).insert(0, words); return p; };
    d.transact((l) => {
      const c = l.getMap('content'); c.set('nodeName', 'doc'); c.setContainer('attributes', new LoroMap());
      const t = block(c.setContainer('children', new LoroList()), 0, 'table', { blockId: 't0000000' });
      const rows = t.setContainer('children', new LoroList());
      const head = block(rows, 0, 'tableRow', { blockId: 'r0000000' }).setContainer('children', new LoroList());
      para(block(head, 0, 'tableHeader', { blockId: 'h0000000', colspan: 1, rowspan: 1 }).setContainer('children', new LoroList()), 0, 'hp000000', 'Owner');
      para(block(head, 1, 'tableHeader', { blockId: 'h1000000', colspan: 1, rowspan: 1, colwidth: [120] }).setContainer('children', new LoroList()), 0, 'hp100000', 'Status');
      const body = block(rows, 1, 'tableRow', {}).setContainer('children', new LoroList()); // no blockId: Tana's agent writes these too
      const imgCell = block(body, 0, 'tableCell', { blockId: 'c0000000', colspan: 2, rowspan: 1 }).setContainer('children', new LoroList());
      block(imgCell, 0, 'image', { blockId: 'i0000000', tanaUri: 'tana:image:01examplei0000000000000000' });
      para(imgCell, 1, 'cp000000', 'Ingrid');
      block(body, 1, 'tableCell', {}).setContainer('children', new LoroList()); // no id, no paragraph
    });
    const table = outline.readTable(d, 't0000000');
    assert.equal(table.rowCount, 2); assert.equal(table.columnCount, 2);
    assert.deepEqual(table.rows[0].map((c) => [c.id, c.header, c.text, c.colwidth]), [['h0000000', true, 'Owner', null], ['h1000000', true, 'Status', [120]]]);
    assert.deepEqual([table.rows[1][0].colspan, table.rows[1][0].paragraph, table.rows[1][0].text], [2, 'cp000000', 'Ingrid'], 'the text is the first paragraph, past the image');
    assert.deepEqual(table.rows[1][0].blocks.map((b) => b.type || b.block), ['image', 'paragraph'], 'each cell keeps all of its blocks');
    const row = outline.readOutline(d)[0];
    assert.equal(row.type, 'table'); assert.equal(row.editable, false); assert.deepEqual(row.table, table, 'the outline row carries the same grid');
    outline.setCellText(d, 'c0000000', [{ text: 'Ingrid', marks: { bold: true } }, { text: ' and ' }, { mention: { label: 'Kim', uri: ME } }]);
    const cell = outline.readTable(d, 't0000000').rows[1][0];
    assert.deepEqual(cell.segments, [{ text: 'Ingrid', marks: { bold: true } }, { text: ' and ' }, { mention: { label: 'Kim', uri: ME } }]);
    assert.deepEqual(cell.blocks.map((b) => b.type || b.block), ['image', 'paragraph'], 'the image stays in the cell');
    assert.equal(outline.assignBlockIds(d), 2, 'the unnamed row and cell get ids');
    const empty = outline.readTable(d, 't0000000').rows[1][1];
    assert.match(empty.id, /^[0-9a-hjkmnp-tv-z]{8}$/); assert.equal(empty.paragraph, undefined);
    outline.setCellText(d, empty.id, 'Done');
    const filled = outline.readTable(d, 't0000000').rows[1][1];
    assert.equal(filled.text, 'Done'); assert.match(filled.paragraph, /^[0-9a-hjkmnp-tv-z]{8}$/, 'a cell with no paragraph gets one, with an id');
    assert.throws(() => outline.setCellText(d, 'hp000000', 'x'), /no table cell/, 'a paragraph id is not a cell id');
    assert.throws(() => outline.setText(d, 't0000000', 'x'), /cannot contain editable text/, 'the whole table is still never overwritten as text');
    assert.throws(() => outline.readTable(d, 'nope0000'), /no table/);
    // and through main, the way the renderer writes one (preload setCell -> block:setCell), on the document's undo stack
    const backend = mainHelpers(); require('../db').open(':memory:');
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: () => {} } }, client: {
      graph: { listNodes: async () => ({ nodes: [] }) }, sync: { subscribe: async () => d, getDocument: () => d, unsubscribe: async () => {} } } });
    await backend.handlers.get('block:setCell')(null, d.id, 'h1000000', 'State');
    assert.equal(outline.readTable(d, 't0000000').rows[0][1].text, 'State', 'block:setCell writes one cell');
    assert.equal(await backend.undo(), d.id, 'as one step of that document');
    assert.equal(outline.readTable(d, 't0000000').rows[0][1].text, 'Status', 'which undo puts back');
    // rows and columns: Tana's manipulateTable writers (ave/ove/sve/cve/lve/uve), with the limits of its table menu
    const g = new Document('tana:text:' + ulid());
    g.transact((l) => {
      const c = l.getMap('content'); c.set('nodeName', 'doc'); c.setContainer('attributes', new LoroMap());
      const rows = block(c.setContainer('children', new LoroList()), 0, 'table', { blockId: 'u0000000' }).setContainer('children', new LoroList());
      [['h', true, ['A', 'B']], ['r', false, ['a1', 'b1']], ['s', false, ['a2', 'b2']]].forEach(([p, header, words], y) => {
        const cells = block(rows, y, 'tableRow', { blockId: p + 'row0000' }).setContainer('children', new LoroList());
        words.forEach((w, x) => para(block(cells, x, header ? 'tableHeader' : 'tableCell', { blockId: p + x + '000000', colspan: 1, rowspan: 1 }).setContainer('children', new LoroList()), 0, p + x + 'p00000', w));
      });
    });
    const grid = () => outline.readTable(g, 'u0000000').rows.map((r) => r.map((x) => (x.header ? '#' : '') + (x.text || '.')).join(' ')).join(' | ');
    assert.throws(() => outline.tableOp(g, 'h0000000', 'rowBefore'), /above the header/);
    assert.throws(() => outline.tableOp(g, 'h0000000', 'deleteRow'), /header row cannot be deleted/);
    assert.throws(() => outline.tableOp(g, 'r0000000', 'rowUp'), /header row stays on top/);
    assert.throws(() => outline.tableOp(g, 'r0000000', 'sideways'), /unknown table operation/);
    const fresh = outline.tableOp(g, 'r1000000', 'rowAfter');
    assert.equal(grid(), '#A #B | a1 b1 | . . | a2 b2', 'a new row of empty cells after this one');
    const newRow = outline.readTable(g, 'u0000000').rows[2];
    assert.equal(fresh, newRow[1].id, 'the caret goes to the new cell in the same column');
    assert.ok(newRow.every((x) => !x.header && /^[0-9a-hjkmnp-tv-z]{8}$/.test(x.id) && /^[0-9a-hjkmnp-tv-z]{8}$/.test(x.paragraph)), 'data cells, each with an id and an empty paragraph with one');
    assert.equal(outline.tableOp(g, 's0000000', 'rowUp'), 's0000000'); assert.equal(grid(), '#A #B | a1 b1 | a2 b2 | . .', 'moved, and the cell keeps its id');
    outline.tableOp(g, 'h0000000', 'columnAfter');
    assert.equal(grid(), '#A #. #B | a1 . b1 | a2 . b2 | . . .', 'a column is a new cell in every row, a header cell in the header row');
    outline.tableOp(g, 'h1000000', 'columnLeft');
    assert.equal(grid(), '#A #B #. | a1 b1 . | a2 b2 . | . . .', 'a column moves in every row');
    assert.equal(outline.readTable(g, 'u0000000').rows[1][1].id, 'r1000000');
    assert.throws(() => outline.tableOp(g, 'h0000000', 'columnLeft'), /leftmost/);
    outline.tableOp(g, 'h1000000', 'deleteColumn'); outline.tableOp(g, 'h0000000', 'deleteColumn');
    assert.equal(grid(), '#. | . | . | .');
    assert.throws(() => outline.tableOp(g, outline.readTable(g, 'u0000000').rows[0][0].id, 'deleteColumn'), /only column/);
    for (const row of outline.readTable(g, 'u0000000').rows.slice(2)) outline.tableOp(g, row[0].id, 'deleteRow');
    assert.throws(() => outline.tableOp(g, outline.readTable(g, 'u0000000').rows[1][0].id, 'deleteRow'), /only row/, 'the last body row stays');
    // an image into a cell goes after its text (Tana's addImageToCell); a caret in a cell is on its paragraph
    const left = outline.readTable(g, 'u0000000').rows[1][0].id; // the one body cell still standing
    outline.insertImage(g, left, 'tana:image:01examplei0000000000000001');
    assert.deepEqual(outline.readTable(g, 'u0000000').rows[1][0].blocks.map((b) => b.type || b.block), ['paragraph', 'image']);
    outline.setCellText(g, left, 'hello');
    const inCell = outline.readTable(g, 'u0000000').rows[1][0].paragraph;
    assert.deepEqual([outline.charOffset(g, inCell, 2), outline.blockOffset(g, inCell, 2), outline.cursorOffset(g, outline.cursorAt(g, inCell, 3).encode())],
      [2, 2, { blockId: inCell, offset: 3 }], 'the presence helpers reach a paragraph inside a cell');
    // and through main, one step of the document's undo
    await backend.handlers.get('block:tableOp')(null, d.id, 'c0000000', 'rowAfter');
    assert.equal(outline.readTable(d, 't0000000').rowCount, 3, 'block:tableOp adds the row');
    assert.equal(await backend.undo(), d.id);
    assert.equal(outline.readTable(d, 't0000000').rowCount, 2, 'which undo takes away');
    console.log('ok  tables: rows x cells, spans and widths, cell text written into the first paragraph, rows and columns added, moved and deleted, images and carets in cells');
  }
  {
    // Process image from clipboard: Chromium's image/png, or macOS's own PNG type, all a copied image file offers (main.js clipboardPng)
    const backend = mainHelpers(), has = async (...types) => { backend.electron.clipboard.items = [{ types, getType: async () => new Blob([]) }]; return backend.handlers.get('clipboard:hasImage')(); };
    assert.equal(await has('image/png'), true, 'a copied bitmap');
    assert.equal(await has('text/uri-list', 'electron application/osclipboard;format="Apple PNG pasteboard type"'), true, 'a copied image file (Finder, CleanShot): no image/png, the PNG under macOS\'s own type');
    assert.equal(await has('text/plain'), false, 'no image, no row');
    console.log('ok  clipboard image: a copied bitmap or a copied image file');
  }
  {
    // A task from a meeting links back to it (main/rows.js meetingOf): Tana's AI files it under the event (ownerUri); the
    // meeting's title and start come from one lookup for the list, and a meeting seen before is not asked again
    const backend = mainHelpers(), EV = 'tana:event:' + ulid(), SPACE = 'tana:space:' + ulid(), asked = [];
    const fromMeeting = { id: 'tana:text:' + ulid(), title: 'Send the deck', ownerUri: EV, state: { type: 'open' }, updateTime: '2026-09-29T10:00:00Z' };
    const note = { id: 'tana:text:' + ulid(), title: 'Minutes', ownerUri: EV, updateTime: '2026-09-29T10:00:00Z' }; // a note in the meeting is no task
    const plainTask = { id: 'tana:text:' + ulid(), title: 'Water the plants', ownerUri: SPACE, state: { type: 'open' }, updateTime: '2026-09-29T10:00:00Z' };
    backend.testRuntime({ me: { userUri: ME }, win: null, client: { sync: { subscribe: async () => null }, graph: {
      listNodes: async (p) => { if (p.nodeIds) { asked.push(p.nodeIds); return { nodes: [{ id: EV, title: 'Leadership sync ', calendarEvent: { startTime: '2026-09-28T07:00:00Z' } }].filter((n) => p.nodeIds.includes(n.id)) }; } return { nodes: [fromMeeting, note, plainTask] }; },
    } } });
    const rows = JSON.parse(JSON.stringify(await backend.spaceChildren(SPACE)));
    assert.deepEqual(rows.map((r) => r.meeting || null), [{ id: EV, title: 'Leadership sync', start: '2026-09-28T07:00:00Z' }, null, null], 'the task from the meeting names it; a note in it and a task elsewhere do not');
    assert.deepEqual(JSON.parse(JSON.stringify(asked)), [[EV]], 'one lookup for the list');
    await backend.spaceChildren(SPACE);
    assert.equal(asked.length, 1, 'and none the next time');
    console.log('ok  a task from a meeting names the meeting it came from');
  }
  // 4. Transport: headers and the 401 -> refresh -> retry-once rule, with a fake fetch
  const calls = [];
  let tokens = 0;
  const SnapResp = message('sync', 'GetDocumentSnapshotResponse');
  const fakeFetch = async (url, init) => {
    calls.push({ url, auth: init.headers.get('authorization'), rid: init.headers.get('x-request-id'), name: init.headers.get('x-client-name'), ct: init.headers.get('content-type'), body: init.body });
    if (calls.length === 1) return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    return new Response(toBinary(SnapResp, create(SnapResp, { snapshot: vvBytes, versionVector: vvBytes })), { status: 200, headers: { 'content-type': 'application/proto' } });
  };
  const transport = createTransport({ getAccessToken: async ({ refresh }) => 'tok' + (refresh ? ++tokens : tokens), fetch: fakeFetch, clientName: 'sdk-check' });
  const { createClient } = require('@connectrpc/connect');
  const snap = await createClient(SyncService, transport).getDocumentSnapshot({ documentId: DOC }, { timeoutMs: 1234 });
  assert.deepEqual([...snap.snapshot], [1, 2, 3]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://home.tana.inc/platform/tana.sync.v1alpha1.SyncService/GetDocumentSnapshot');
  assert.deepEqual([calls[0].auth, calls[1].auth], ['Bearer tok0', 'Bearer tok1']);
  assert.ok(calls[0].rid && calls[0].name === 'sdk-check' && calls[0].ct === 'application/proto');
  assert.ok(calls[1].body instanceof Uint8Array && calls[1].body.length === calls[0].body.length, 'body resent after refresh');
  console.log('ok  transport auth + 401 retry');

  // 5. Sync lifecycle against an in-process fake SyncService (bootstrap -> live -> updates out/in -> resync -> unsubscribe)
  const Resp2 = message('sync', 'ServerSyncResponse');
  const server = { frames: [], wake: null, commands: [], serverDoc: new Document(DOC, { peerId: '4242' }), session: 0, created: new Map(), unavailable: new Set(), denied: new Set(), begins: [] };
  server.serverDoc.applyRemote([snapshot]);
  const push = (json) => { server.frames.push(fromJson(Resp2, json)); if (server.wake) server.wake(); };
  const router = createRouterTransport(({ service }) => service(SyncService, {
    async *serverSync(req, ctx) {
      assert.equal(req.orgId, ORG); assert.equal(req.peer.peerId, peerId); assert.equal(req.peer.ephemeral, true);
      yield fromJson(Resp2, { peer: { peerId: 'server', heartbeatIntervalMs: 50 } });
      while (!ctx.signal.aborted) {
        while (server.frames.length) yield server.frames.shift();
        await new Promise((r) => { server.wake = r; setTimeout(r, 40); });
        if (server.stall) { await new Promise((r) => ctx.signal.addEventListener('abort', r)); return; }
        yield fromJson(Resp2, { heartbeat: {} });
      }
    },
    async serverSyncCommand(req) {
      const { case: kind, value } = req.commandUnion;
      server.commands.push(kind);
      assert.equal(req.peerId, peerId);
      if (kind === 'beginDocumentSync') {
        const sessionId = 's' + (++server.session);
        server.begins.push(value.documentId);
        if (server.fail503 > 0) { server.fail503--; throw new ConnectError('HTTP 503', Code.Unavailable); } // Tana shedding load
        if (server.noStream > 0) { server.noStream--; throw new ConnectError('no active streams for peer "1"', Code.FailedPrecondition); }
        if (server.unavailable.has(value.documentId)) { server.onUnavailable(); return fromJson(message('sync', 'ServerSyncCommandResponse'), { bootstrapResponse: { sessionId, status: 'BOOTSTRAP_STATUS_UNAVAILABLE' } }); }
        const cold = value.clientVv.length === 0;
        if (value.documentId !== DOC && !server.created.has(value.documentId)) { // unknown id: MISSING, nothing to send (§2.1)
          return fromJson(message('sync', 'ServerSyncCommandResponse'), { bootstrapResponse: { sessionId, status: 'BOOTSTRAP_STATUS_MISSING', serverVv: '', serverUpdates: '' } });
        }
        const sdoc = server.created.get(value.documentId) || server.serverDoc;
        return fromJson(message('sync', 'ServerSyncCommandResponse'), { bootstrapResponse: { sessionId, status: 'BOOTSTRAP_STATUS_EXISTING',
          serverVv: b64(sdoc.loro.oplogVersion().encode()), serverUpdates: cold ? b64(sdoc.loro.export({ mode: 'snapshot' })) : '' } });
      }
      if (kind === 'applyBootstrapUpdates') {
        if (server.denied.has(value.documentId) && value.updates.length) throw new ConnectError('write denied', Code.PermissionDenied);
        if (value.documentId !== DOC && !server.created.has(value.documentId)) { // a create: the catch-up must be a full snapshot of a doc the server never saw
          assert.ok(value.updates.length, 'create sends a non-empty catch-up');
          const d = new Document(value.documentId, { peerId: '4242' });
          d.applyRemote([value.updates]);
          server.created.set(value.documentId, d);
        } else if (value.updates.length) (server.created.get(value.documentId) || server.serverDoc).applyRemote([value.updates]);
        setTimeout(() => push({ bootstrapComplete: { documentId: value.documentId, sessionId: value.sessionId, barrierVv: '' } }), 5);
        return {};
      }
      if (kind === 'liveDocumentUpdate') {
        if (value.sessionId !== 's' + server.session) throw new ConnectError('stale session', Code.FailedPrecondition);
        if (server.denied.has(value.documentId)) throw new ConnectError('write denied', Code.PermissionDenied);
        (server.created.get(value.documentId) || server.serverDoc).applyRemote(value.updates);
        return {};
      }
      if (kind === 'documentAction') { assert.ok(['softDelete','restore','archive','unarchive'].includes(value.action.case)); server.lastAction = value.action.case; return fromJson(message('sync', 'ServerSyncCommandResponse'), { documentActionResponse: {} }); }
      return {};
    },
  }));
  const warns = [];
  const log = { warn: (m) => warns.push(m), error: (m) => console.error(m), info: () => {} };
  const sync = new SyncConnection({ transport: router, orgId: ORG, peerId, logger: log });
  // The retry and reconnect backoffs (sdk/sync.js jitter: 250 ms to 5 s) run at once here: what this checks is that a
  // retry happens and what it sends, never how long it waited. The watchdog (3 x 50 ms heartbeats) and the fake
  // server's own 5 and 40 ms timers are shorter than the cut, so they keep their real timing.
  const backoffTimeout = setTimeout;
  global.setTimeout = (fn, ms, ...a) => backoffTimeout(fn, ms >= 200 && ms < 6000 ? 0 : ms, ...a);
  const changes = [];
  sync.on('change', (id, info) => changes.push(info.origin));
  sync.on('error', (e) => { throw e; });
  let connected = 0; sync.on('connected', () => connected++);
  await sync.connect();
  assert.equal(connected, 1);
  const d = await sync.subscribe(DOC);
  assert.equal(d, sync.getDocument(DOC));
  assert.equal(readNode(d).title, 'Review the sample agreement');
  assert.deepEqual(server.commands, ['beginDocumentSync', 'applyBootstrapUpdates']);
  assert.equal(await sync.subscribe(DOC), d, 'subscribe is idempotent');
  // local -> server, batched into one liveDocumentUpdate
  setTitle(d, 'Review the sample agreement');
  setState(d, 'closed', ME);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(server.commands.slice(2), ['liveDocumentUpdate']);
  assert.equal(readNode(server.serverDoc).stateType, 'closed');
  // server -> local
  const remote = [];
  server.serverDoc.on('local-update', (u) => remote.push(u));
  server.serverDoc.transact((l) => l.getMap('data').set('title', 'renamed by server'));
  push({ liveDocumentUpdate: { documentId: DOC, sessionId: 's1', updates: remote.map(b64) } });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(readNode(d).title, 'renamed by server');
  // frames for another session are dropped: an update only this stray peer has must not reach the document
  const stray = new Document(DOC, { peerId: '4343' }), strayUpdates = [];
  stray.applyRemote([server.serverDoc.loro.export({ mode: 'snapshot' })]);
  stray.on('local-update', (u) => strayUpdates.push(u));
  stray.transact((l) => l.getMap('data').set('title', 'written on a stale session'));
  push({ liveDocumentUpdate: { documentId: DOC, sessionId: 'old', updates: strayUpdates.map(b64) } });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(readNode(d).title, 'renamed by server', 'a frame for another session is ignored');
  // resync_required -> new bootstrap (warm start: empty serverUpdates, catch-up sent), session id changes
  push({ resyncRequired: { documentId: DOC, sessionId: 's1', reason: 'test', recovery: 'RECOVERY_STRATEGY_RETRY' } });
  await until(() => server.commands.length >= 5, 'the re-bootstrap after resync_required');
  assert.deepEqual(server.commands.slice(3), ['beginDocumentSync', 'applyBootstrapUpdates']);
  assert.equal(server.session, 2);
  setTitle(d, 'after resync');
  await until(() => readNode(server.serverDoc).title === 'after resync', 'the edit after the resync');
  assert.equal(readNode(server.serverDoc).title, 'after resync');
  // watchdog: server goes silent (no heartbeats) -> 3x interval -> reconnect -> same Document re-bootstrapped
  let disconnected = 0; sync.on('disconnected', () => disconnected++);
  server.stall = true;
  await until(() => disconnected >= 1, 'the watchdog to drop the silent stream');
  server.stall = false;
  await until(() => connected >= 2 && server.session >= 3, 'the reconnect and its re-bootstrap');
  assert.ok(disconnected >= 1 && connected >= 2, 'reconnected after watchdog: ' + disconnected + '/' + connected);
  assert.equal(sync.getDocument(DOC), d);
  assert.ok(server.session >= 3, 'document re-bootstrapped after reconnect');
  assert.equal(readNode(d).title, 'after resync');
  setTitle(d, 'after reconnect');
  await until(() => readNode(server.serverDoc).title === 'after reconnect', 'the edit after the reconnect');
  assert.equal(readNode(server.serverDoc).title, 'after reconnect');
  // create: subscribe(id, init) on an unknown id -> MISSING -> full snapshot as catch-up -> live; later edits flow as usual
  const NEW = 'tana:text:' + ulid();
  const created = await sync.subscribe(NEW, (l) => initDocument(l, 'created offline', ME));
  assert.equal(server.commands.slice(-2).join(), 'beginDocumentSync,applyBootstrapUpdates');
  assert.equal(readNode(server.created.get(NEW)).title, 'created offline');
  assert.deepEqual(readNode(server.created.get(NEW)).participants, { [ME]: { type: 'user', role: 'admin' } });
  assert.equal(server.created.get(NEW).content.get('nodeName'), 'doc');
  outline.setText(created, outline.readOutline(created)[0].id, 'hello');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(contentText(server.created.get(NEW)), 'hello');
  assert.equal((await sync.softDelete(NEW)).responseUnion.case, 'documentActionResponse');
  assert.equal(server.commands.at(-1), 'documentAction');
  assert.equal((await sync.restore(NEW)).responseUnion.case, 'documentActionResponse');
  assert.equal(server.commands.at(-1), 'documentAction');
  // #36: archive and unarchive are the same command, DocumentAction fields 4 and 5, decoded here off the wire
  for (const action of ['archive', 'unarchive']) {
    assert.equal((await sync[action](NEW)).responseUnion.case, 'documentActionResponse');
    assert.deepEqual([server.commands.at(-1), server.lastAction], ['documentAction', action]);
  }
  // [unavailable] on bootstrap is retried, so a single one is not worth saying: it reads as a failure that needs
  // acting on when the next attempt has already taken it. Two in a row is an outage, and that is still said.
  server.fail503 = 2;
  const FLAKY = 'tana:text:' + ulid();
  const flaky = await sync.subscribe(FLAKY, (l) => initDocument(l, 'survived a 503', ME));
  assert.equal(readNode(flaky).title, 'survived a 503', 'a 503 on bootstrap is retried until it lands');
  const said = warns.filter((w) => w.startsWith('sync: bootstrap ' + FLAKY));
  assert.equal(said.length, 1, 'the first [unavailable] stays quiet, the second is reported: ' + JSON.stringify(said));
  assert.match(said[0], /failed \(attempt 2\): .*503/);
  // "no active streams" for one document on a stream that has loaded others: that document is retried on its own, and
  // the stream stays up. Tearing it down each time looped for ever when Tana kept saying it for one document.
  server.noStream = 3;
  const connectedBefore = connected, NOSTREAM = 'tana:text:' + ulid();
  const lone = await sync.subscribe(NOSTREAM, (l) => initDocument(l, 'loaded after three refusals', ME));
  assert.equal(readNode(lone).title, 'loaded after three refusals', 'the document is retried until it loads');
  assert.equal(connected, connectedBefore, 'and the stream was not reconnected for it');
  // Drain on release (Tana's "Entering drain mode"): a document created and let go while its bootstrap is still running
  // finishes that bootstrap, so the catch-up carrying its content reaches the server, and only then is unsubscribed.
  const DRAINED = 'tana:text:' + ulid();
  const draining = sync.subscribe(DRAINED, (l) => initDocument(l, 'created and released at once', ME));
  await sync.unsubscribe(DRAINED);
  assert.equal(readNode(await draining).title, 'created and released at once', 'the subscribe still answers');
  assert.equal(readNode(server.created.get(DRAINED)).title, 'created and released at once', 'the queued create reached the server');
  assert.equal(server.commands.at(-1), 'unsubscribeDocument', 'and the document was released afterwards');
  assert.equal(sync.getDocument(DRAINED), undefined);
  // Asked for again while its release still waits on a send: the release lets it be. It used to go on and detach the
  // document the second subscribe had just been handed, so it heard nothing more and its next edits went nowhere.
  const KEPT = 'tana:text:' + ulid();
  const kept = await sync.subscribe(KEPT, (l) => initDocument(l, 'kept', ME));
  setTitle(kept, 'released while sending');
  const releasing = sync.unsubscribe(KEPT);
  assert.equal(await sync.subscribe(KEPT), kept, 'the release is still flushing, so the same document answers');
  await releasing;
  assert.equal(sync.getDocument(KEPT), kept, 'and it stays subscribed');
  setTitle(kept, 'edited after the release');
  for (let i = 0; i < 40 && readNode(server.created.get(KEPT)).title !== 'edited after the release'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(readNode(server.created.get(KEPT)).title, 'edited after the release', 'its edits still reach the server');
  // ...and asked for again while its release drains a bootstrap, it leaves drain mode: a bootstrap that fails once is
  // retried as usual instead of stopping after the one attempt a drain allows, and the subscribe answers.
  const REDRAIN = 'tana:text:' + ulid();
  server.fail503 = 1;
  const firstAsk = sync.subscribe(REDRAIN, (l) => initDocument(l, 'created, released and wanted again', ME));
  const released = sync.unsubscribe(REDRAIN);
  const secondAsk = sync.subscribe(REDRAIN);
  await released;
  // it used to hang here: without a retry the subscribe never answers, so a hang fails as a message instead
  const back = await Promise.race([secondAsk, new Promise((_, no) => setTimeout(() => no(new Error('the second subscribe never answered')), 10000).unref())]);
  assert.equal(back, await firstAsk);
  assert.equal(sync.getDocument(REDRAIN), back, 'still subscribed');
  assert.equal(readNode(server.created.get(REDRAIN)).title, 'created, released and wanted again', 'the retried create reached the server');
  // Write denied (Tana's access-revoked -> "write denied"): a refused live send re-bootstraps to probe read access; the
  // probe's catch-up is refused too, so the document stays open and readable, marked, and sends nothing more.
  const DENIED = 'tana:text:' + ulid();
  const denied = await sync.subscribe(DENIED, (l) => initDocument(l, 'shared with me', ME));
  const deniedIds = []; sync.on('write-denied', (id) => deniedIds.push(id));
  server.denied.add(DENIED);
  setTitle(denied, 'my edit');
  for (let i = 0; i < 40 && !deniedIds.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(deniedIds, [DENIED], 'the write-denied event names the document');
  assert.equal(sync.getDocument(DENIED), denied, 'the document stays open (not detached, no error event)');
  assert.equal(denied.writeDenied, true);
  assert.equal(require('../sdk/node').editable(readNode(denied), ME), false, 'and reads as not editable');
  const sentBefore = server.commands.length;
  setTitle(denied, 'another edit');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(server.commands.length, sentBefore, 'no further sends');
  assert.equal(readNode(server.created.get(DENIED)).title, 'shared with me');
  // Warm-bootstrap budget (Tana's #J): unavailable is retried while under 60 s or 5 attempts, then the session pauses
  // instead of retrying forever; asking for it again resumes it. The clock jumps 20 s per attempt and the retry sleeps
  // are cut to nothing (the backoff cut above), so this takes milliseconds.
  const UNAV = 'tana:text:' + ulid(), realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  server.onUnavailable = () => { skew += 20000; };
  server.unavailable.add(UNAV);
  try {
    const pending = sync.subscribe(UNAV, (l) => initDocument(l, 'waiting for the server', ME));
    await new Promise((r) => backoffTimeout(r, 300));
    const tries = () => server.begins.filter((id) => id === UNAV).length;
    assert.equal(tries(), 5, 'five attempts over 60 s, then no more');
    await new Promise((r) => backoffTimeout(r, 200));
    assert.equal(tries(), 5, 'paused, not retrying');
    assert.ok(warns.some((w) => w.includes(UNAV) && /paused/.test(w)));
    server.unavailable.delete(UNAV);
    sync.subscribe(UNAV);
    assert.equal(readNode(await pending).title, 'waiting for the server', 'a subscribe resumes the paused document');
    // A warm create that still gets MISSING is not "document not found": queued local state means the create path
    // still has something to send, so Tana keeps retrying instead of exhausting the cold-missing budget.
    const WARM = 'tana:text:' + ulid();
    const warmEntry = { id: WARM, document: new Document(WARM, { peerId: '4252' }), sessionId: null, state: 'new', gen: 0, queue: [new Uint8Array([1])], inflight: false, timer: null, resyncs: 0, liveSince: 0, ready: { resolve() {}, reject() {} }, complete: null };
    const savedBootstrapOnce = sync._bootstrapOnce;
    let warmTries = 0;
    sync.docs.set(WARM, warmEntry);
    try {
      sync.connected = true;
      sync._bootstrapOnce = async () => { warmTries++; skew += 20000; if (warmTries >= 6) sync.connected = false; return 'missing'; };
      await sync._bootstrap(warmEntry);
      assert.equal(warmTries, 6, 'a warm missing keeps retrying past the cold budget');
      assert.equal(sync.docs.get(WARM), warmEntry, 'and is not detached as document not found');
      assert.equal(warmEntry.state, 'retrying');
    } finally {
      sync._bootstrapOnce = savedBootstrapOnce;
      sync.connected = true;
      sync.docs.delete(WARM);
    }
    // Cold unavailable is not the recoverable warm-session pause: without local state to protect, a subscribe keeps
    // retrying instead of parking in paused until somebody asks again.
    const COLD = 'tana:text:' + ulid();
    const coldEntry = { id: COLD, document: new Document(COLD, { peerId: '4253' }), sessionId: null, state: 'new', gen: 0, queue: [], inflight: false, timer: null, resyncs: 0, liveSince: 0, ready: { resolve() {}, reject() {} }, complete: null };
    let coldTries = 0;
    sync.docs.set(COLD, coldEntry);
    try {
      sync.connected = true;
      sync._bootstrapOnce = async () => { coldTries++; skew += 20000; if (coldTries >= 6) sync.connected = false; return 'unavailable'; };
      await sync._bootstrap(coldEntry);
      assert.equal(coldTries, 6, 'a cold unavailable keeps retrying past one budget window');
      assert.equal(coldEntry.state, 'retrying', 'and never parks itself in paused');
    } finally {
      sync._bootstrapOnce = savedBootstrapOnce;
      sync.connected = true;
      sync.docs.delete(COLD);
    }
    // "no active streams" for one document on a stream that serves the rest (Tana's answer for one deleted there): given
    // up after the same budget, so whoever asked hears it failed instead of it being asked for every few seconds for ever.
    const GONE = 'tana:text:' + ulid();
    let goneTries = 0, goneError = null;
    const goneEntry = { id: GONE, document: new Document(GONE, { peerId: '4254' }), sessionId: null, state: 'new', gen: 0, queue: [], inflight: false, timer: null, resyncs: 0, liveSince: 0, ready: { resolve() {}, reject(e) { goneError = e; } }, complete: null, onChange() {}, onLocal() {} };
    sync.docs.set(GONE, goneEntry);
    try {
      sync.connected = true; sync.streamLoaded = true;
      sync._bootstrapOnce = async () => { goneTries++; skew += 20000; if (goneTries >= 20) sync.connected = false; throw new ConnectError('no active streams for peer "1"', Code.FailedPrecondition); };
      await sync._bootstrap(goneEntry);
      assert.equal(goneTries, 5, 'five refusals over 60 s, then no more');
      assert.match(String(goneError && goneError.message), /document unavailable/, 'and the subscribe is told it failed');
    } finally {
      sync._bootstrapOnce = savedBootstrapOnce;
      sync.connected = true;
      sync.docs.delete(GONE);
    }
  } finally {
    Date.now = realNow;
  }
  await sync.close();
  global.setTimeout = backoffTimeout;
  assert.equal(sync.connected, false);
  assert.ok(server.commands.includes('unsubscribeDocument'), 'unsubscribe sent on close');
  assert.ok(changes.includes('local') && changes.includes('remote'));
  console.log('ok  sync lifecycle (connect, bootstrap, live out/in, session check, resync, drain on release, write denied, unavailable budget, close)');
}

main().then(() => console.log('all checks passed'), (e) => { console.error(e); process.exit(1); });

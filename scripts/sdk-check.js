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
const { createTransport, GraphClient, SyncConnection, Document, derivePeerId, readNode, setTitle, setState, taskMeta, setAssignees, contentText, ulid, initDocument, STATE_TYPES } = require('../sdk');
const outline = require('../sdk/content');
const { fetchImage } = require('../sdk/assets');
const { LoroMap, LoroList } = require('loro-crdt');
const { parseQuery, searchParams, needsTypes, taskParams, libraryQueries, DEFAULT_TASK_FILTER, DEFAULT_LIBRARY_FILTER } = require('../sdk/query');
const pins = require('../sdk/pins');

const ORG = 'org_01KS7RQSWW68H489ZZZ1NNC40T', DOC = 'tana:text:01m23c1z45gceayt2zjk09k63c', ME = 'tana:user-profile:01m0f1aqd8p23qhwntbewmpfz2';
const snapshot = Buffer.from(fs.readFileSync(require('node:path').join(__dirname, 'fixtures', 'task-snapshot.b64'), 'utf8').trim(), 'base64');
const b64 = (u8) => Buffer.from(u8).toString('base64');

// Load the real main-process helpers without Electron startup or a Tana connection.
function mainHelpers() {
  const file = require('node:path').join(__dirname, '..', 'main.js');
  const mod = { exports: {} };
  const handlers = new Map();
  const electron = { app: {}, BrowserWindow: function () {}, Menu: {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: (id) => id === 'electron' ? electron : createRequire(file)(id), module: mod, exports: mod.exports,
    __dirname: require('node:path').dirname(file), __filename: file, Buffer, console, URL, // URL is a global in Electron's main process
    setTimeout: () => 0, clearTimeout: () => {}, // no refresh/network timers in offline main helpers
    process: { env: { ...process.env, TANA_MAIN_TEST: '1' } },
  }, { filename: file });
  return {...mod.exports, handlers};
}

async function main() {
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
    await assert.rejects(access.setSharing(source,stranger,{rule:'inherit'},ctx));
    await assert.rejects(access.setSharing(source,ME,{rule:'people',participants:[{uri:stranger,role:'viewer'}]},ctx));
    await access.setSharing(source,ME,{rule:'people',participants:[{uri:stranger,role:'editor'}]},ctx);
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
      // a reference value is a mention node: its label is its text, not an empty string
      typed.transact((l) => {
        const runs = l.getMap('data').get('attributes').get(key).get('children').get(0).get('children');
        runs.insertContainer(1, new LoroMap()).set('nodeName', 'mention');
        runs.get(1).setContainer('attributes', new LoroMap()).set('label', ' / Nedap');
      });
      assert.deepEqual(fields.readFields(typed).map((f) => f.text), ['Onderhandeling / Nedap'], 'a mention reads as its label');
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

    const agent=make('agent');org.transact(l=>l.getMap('featurePolicy').set('memberOrgWideCreation',false));
    assert.equal((await access.capabilities(agent,ME,ctx)).rules.includes('inherit'),false,'org policy');
    assert.equal((await access.capabilities(agent,ME,{...ctx,orgAdmin:true})).rules.includes('inherit'),true);
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
    backend.testRuntime({me:{userUri:ME,orgId:ORG},session:{getAccessToken:async()=> 'x.'+Buffer.from(JSON.stringify({org_id:ORG,role:'member'})).toString('base64url')+'.x'},client:{sync:{getDocument:()=>local,subscribe:async()=>local,softDelete:()=>apply('softDelete'),restore:()=>apply('restore')}},win:{isDestroyed:()=>false,webContents:{send:(channel,id)=>events.push([channel,id])}}});
    local.on('change',()=>backend.onChange(DOC));
    cache.upsert({id:DOC,title:'reversible delete',section:'tasks'});
    assert.equal(await backend.documentAction(DOC,'softDelete'),DOC);
    assert.equal(cache.get(DOC),undefined);assert.ok(events.some(([channel])=>channel==='outline:removed'));
    failRestore=true;await assert.rejects(backend.undo(),/mock restore failed/);failRestore=false;
    assert.equal(await backend.undo(),DOC,'failed undo stays available for retry');
    assert.deepEqual(local.toJSON(),original,'restore preserves original identity, content and ACL');
    await backend.redo();assert.equal(readNode(local).deletedAt,123);
    await backend.documentAction(DOC,'restore');assert.deepEqual(local.toJSON(),original);
    await backend.undo();assert.equal(readNode(local).deletedAt,123);
    await backend.redo();assert.deepEqual(local.toJSON(),original);
    assert.deepEqual(calls,['softDelete','restore','restore','softDelete','restore','softDelete','restore']);
    console.log('ok  document soft-delete/restore IPC, retryable undo/redo and remote cache invalidation');
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
    assert.deepEqual(Array.from(choices.options.slice(0,3),o=>o.kind),['task','meeting','chat']);
    assert.equal(choices.options.find(o=>o.typeUri===unknownType.id).selectable,false);
    const chat=await backend.createDocument('New conversation',{kind:'chat'});
    assert.equal(chat.icon,'chat');assert.ok(chat.id.startsWith('tana:chat:'));
    const chatData=readNode(docs.get(chat.id));assert.deepEqual(chatData.messages,[]);assert.deepEqual(chatData.participantUris,[]);
    assert.equal(docs.get(chat.id).content.get('nodeName'),undefined,'chat has no invented outline');
    const typed=await backend.createDocument('New project',{kind:'custom',typeUri:textType.id});
    assert.equal(readNode(docs.get(typed.id)).entityTypeUri,textType.id);
    assert.equal(readNode(docs.get(typed.id)).ownerUri,space.id);assert.equal(readNode(docs.get(typed.id)).restricted,true);
    const event=await backend.createDocument('Working session',{kind:'custom',typeUri:eventType.id});
    assert.ok(event.id.startsWith('tana:event:'));assert.equal(readNode(docs.get(event.id)).entityTypeUri,eventType.id);
    assert.equal(readNode(docs.get(event.id)).origin,'tana');assert.equal(created.length,3);
    space.transact(l=>l.getMap('data').get('participants').get(ME).set('role','viewer'));
    await assert.rejects(backend.createDocument('Blocked',{kind:'custom',typeUri:textType.id}),/permission/);
    await assert.rejects(backend.createDocument('Invalid',{kind:'custom',typeUri:unknownType.id}),/Unsupported type target/);
    assert.equal(created.length,3,'invalid scope/types do not create partial documents');
    console.log('ok  creation chooser: native chats, actual typed docs/events, home-space validation and unsaved blank drafts');
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
    console.log('ok  removeMany/moveMany IPC bridge each records exactly one undo step');
  }
  // 1. Request messages: binary round-trip and protobuf-JSON shape from PLATFORM-PROTOCOL.md §1.1/§2
  const Req = message('sync', 'ServerSyncRequest'), Cmd = message('sync', 'ServerSyncCommandRequest');
  const peerId = derivePeerId('01m0f1aqd8p23qhwntbewmpfz2');
  assert.equal(BigInt(peerId) >> 16n, 159370730943085n, 'peerId user hash');
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
    const shared = { ...meOnly, ['tana:user-profile:01m0f1aqd8p23qhwntbewmpfz3']: { type: 'user', role: 'viewer' } };
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
    const namedSpace = {id:'tana:space:boundary',data:{toJSON:()=>({title:'Foundry LT',restricted:true,participants:shared})}};
    assert.deepEqual(await audienceMetadata(doc(false,meOnly),ME,graph,{subscribe:async()=>namedSpace}), {audience:'space',audienceSpace:{uri:'tana:space:boundary',title:'Foundry LT'}});
    assert.deepEqual(await audienceMetadata(doc(false,meOnly),ME,graph,{subscribe:async()=>doc(true,shared)}), {audience:'space',audienceSpace:{uri:'tana:space:boundary'}});
    assert.deepEqual(await audienceMetadata(doc(true,meOnly),ME), {audience:'only-me'});
    assert.deepEqual(await audienceMetadata(doc(false,meOnly),ME,graph,{subscribe:async()=>{throw new Error('unavailable');}}), {audience:'unknown'});
    // #93: an inherited boundary is as determinate as a direct one. Verified against real data: tasks inside a
    // private meeting, meetings with an external guest, and documents whose only boundary is the organization.
    const EVENT = 'tana:event:01m0f1aqd8p23qhwntbewmpfz2', ORGDOC = 'tana:org:01ks7rqsrqjn7vwyjhx75r6jg0';
    const boundaryOf = (uri) => ({ getOwnerChain: async () => ({ entries: [{ uri, restricted: true, accessible: true }], effectivelyRestricted: true }) });
    const orgDoc = (members) => ({ id: ORGDOC, data: { toJSON: () => ({ memberUserProfileDocUris: members }) } });
    assert.deepEqual(await audienceMetadata(doc(undefined, {}), ME, boundaryOf(EVENT), { subscribe: async () => doc(true, shared) }),
      { audience: 'people' }, 'a task inside a meeting shared with several people is selected people, not unknown');
    assert.deepEqual(await audienceMetadata(doc(true, { ...meOnly, 'tana:guest-profile:01kmtdaenscxzhnvcfyz3eth8n': { type: 'user', role: 'attendee' } }), ME),
      { audience: 'people' }, 'an external guest participant is a person, not an unresolved grant');
    assert.deepEqual(await audienceMetadata(doc(undefined, {}), ME, boundaryOf(ORGDOC), { subscribe: async () => orgDoc({ u: ME }) }),
      { audience: 'everyone' }, 'the organization root is a members-only boundary: everyone in the organization');
    assert.deepEqual(await audienceMetadata(doc(undefined, {}), ME, boundaryOf(ORGDOC), { subscribe: async () => orgDoc({}) }), { audience: 'unknown' });
    assert.deepEqual(await audienceMetadata(doc(undefined, {}), ME, boundaryOf(EVENT), { subscribe: async () => doc(true, {}) }),
      { audience: 'unknown' }, 'a boundary with no participants stays unknown');
    assert.deepEqual(await audienceMetadata(doc(undefined, {}), ME, boundaryOf(EVENT), { subscribe: async () => doc(true, { 'tana:group:x': { type: 'group' } }) }),
      { audience: 'unknown' }, 'an inherited group grant stays unknown');
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
    const { editable } = require('../sdk/node');
    const node = (kind, role) => ({ id: 'tana:' + kind + ':example', participants: { [ME]: { type: 'user', role } } });
    assert.equal(editable(node('user-profile', 'admin'), ME), false);
    assert.equal(editable(node('text', 'editor'), ME), true);
    assert.equal(editable(node('text', 'admin'), ME), true);
    assert.equal(editable(node('text', 'viewer'), ME), false);
    assert.equal(editable({ id: DOC, ownerUri: ME }, ME), null, 'ownership does not grant editing');
    assert.equal(editable(node('event', 'admin'), ME), false, 'calendar protected fields need separate capability');
    assert.equal(editable(node('chat', 'editor'), ME), false);
    console.log('ok  outline editability: profiles, ACL roles, unknown ownership, protected events');
  }

  // Main startup status and node appearance are pure helpers: no Electron app, network, or Tana data.
  {
    const { resolveInitialAuth, graphRow, cachedNodeHue, SECTIONS } = mainHelpers();
    assert.equal((await resolveInitialAuth({ isAuthenticated: async () => true })).authenticated, true);
    assert.equal((await resolveInitialAuth({ isAuthenticated: async () => false })).authenticated, false);
    const error = new Error('offline');
    const failed = await resolveInitialAuth({ isAuthenticated: async () => { throw error; } });
    assert.equal(failed.authenticated, null);
    assert.equal(failed.error, error);
    const space = graphRow({ id: 'tana:space:01m0f1aqd8p23qhwntbewmpfz2', title: 'Space', appearance: { hue: 0 } });
    assert.equal(space.hue, 0);
    assert.equal(space.tags[0].hue, 0);
    const plain = graphRow({ id: 'tana:text:01m0f1aqd8p23qhwntbewmpfz2', title: 'Plain' });
    assert.equal(plain.hue, undefined);
    assert.equal(plain.tags[0].hue, undefined);
    assert.equal(cachedNodeHue(space), 0, 'own hue survives the cached kind tag');
    assert.equal(cachedNodeHue({ id: plain.id, icon: null, tags: [{ label: 'Type', hue: 0 }] }), undefined, 'type hue is not a node hue');
    assert.equal(graphRow({ id: 'tana:chat:01m0f1aqd8p23qhwntbewmpfz2', title: 'Chat' }).icon, 'chat');
    assert.ok(SECTIONS.some((s) => s.id === 'members' && s.icon === 'member'));
    console.log('ok  initial auth states and node appearance hue');
  }

  // #63: appearance.hue exists on graph nodes only (verified read-only: spaces and typed documents never carry it in
  // their Loro data map), so reading a document must not erase a hue and a pinned space must still get its colour.
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const spaceId = 'tana:space:' + ulid(), spaceDoc = new Document(spaceId);
    spaceDoc.transact((l) => { initDocument(l, 'Foundry LT', ME); l.getMap('data').set('type', 'space'); });
    const lookups = [];
    backend.testRuntime({ me: { userUri: ME }, win: null, client: {
      sync: { subscribe: async () => spaceDoc, getDocument: () => spaceDoc },
      graph: { listNodes: async (p) => { lookups.push(p.nodeIds); return { nodes: [{ id: spaceId, title: 'Foundry LT', appearance: { hue: 193 } }] }; } },
    } });
    const node = await backend.handlers.get('doc:info')(null, spaceId);
    assert.equal(node.hue, 193, 'a space opened from a pin keeps the hue only the graph knows');
    assert.equal(node.tags[0].hue, 193, 'the space tag is coloured too');
    assert.equal(JSON.stringify(lookups), JSON.stringify([[spaceId]]));
    assert.equal((await backend.handlers.get('doc:info')(null, spaceId)).hue, 193);
    assert.equal(lookups.length, 1, 'the appearance lookup is cached per document');
    assert.equal(backend.rememberNodeHue({ id: spaceId, title: 'Foundry LT' }), false, 'a data-map read carries no appearance and changes nothing');
    assert.equal((await backend.handlers.get('doc:info')(null, spaceId)).hue, 193, 'reading the document never erases the graph hue');
    console.log('ok  appearance hue survives Loro reads and reaches documents opened without a cached row');
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
    assert.equal((await backend.handlers.get('doc:path')(null, DOC)).length, 0, 'the location falls back to its cache');
    assert.equal((await backend.handlers.get('search')(null, 'anything')).length, 0);
    assert.equal((await backend.handlers.get('library:list')(null, {})).length, 0);
    const space = await backend.handlers.get('outline:children')(null, 'tana:space:' + ulid()).then(() => null, (e) => String(e.message || e));
    assert.equal(space, 'not connected to Tana', 'listing a space before the connection is a startup state too');
    assert.equal(backend.statusSnapshot().error, null, 'a startup call is a state, not an error to show');
    assert.deepEqual(sent.filter(([channel, payload]) => channel === 'sync:status' && payload && payload.error), [], 'no error status reaches the renderer during startup');
    console.log('ok  startup: metadata, permission and view calls before the connection stay quiet');
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
    const unsubscribed = [], queries = [];
    let tasks = [{ id: taskId, title: 'Task', state: { type: 'open' }, updateTime: '2026-09-13T10:00:00Z' }];
    let writeUp = [], membersFail = false, ownerQueries = 0;
    const listNodes = async (p) => {
      if (p.ownerIds) { ownerQueries++; return { nodes: p.ownerIds[0] === eventId ? writeUp : [] }; }
      if (p.nodeIds) return { nodes: p.nodeIds.map((id) => (id === eventId ? { id, calendarEvent: { tagline: 'Notes' } } : { id, title: id === spaceId ? 'Deal' : 'Node' })) };
      const [kind] = p.nodeTypes || [];
      if (kind === 'user-profile') { if (membersFail) throw new Error('graph unavailable'); return { nodes: [] }; }
      if (kind === 'event' || kind === 'type') return { nodes: [] };
      queries.push(p);
      return { nodes: tasks };
    };
    backend.testRuntime({ me: { userUri: ME }, win: { isDestroyed: () => false, webContents: { send: () => {} } }, client: {
      sync: { subscribe: async (id) => documents.get(id), getDocument: (id) => documents.get(id), unsubscribe: async (id) => { unsubscribed.push(id); } },
      graph: { listNodes, getOwnerChain: async () => ({ entries: [{ uri: spaceId }] }) },
    } });

    assert.equal((await backend.handlers.get('doc:info')(null, openId)).id, openId, 'a document can be opened without being listed');
    assert.equal(await backend.handlers.get('doc:create')(null, 'Title', { kind: 'constructor' }).then(() => null, (e) => e.message), 'Unsupported creation kind');
    await backend.refresh();
    assert.ok(cache.get(taskId), 'the refresh caches the listed task');
    assert.deepEqual(unsubscribed, [], 'the refresh leaves a document it never listed subscribed, with its live updates and undo history');
    membersFail = true;
    const sections = await backend.handlers.get('outline:roots')();
    assert.equal(sections.map((s) => s.id).join(','), backend.SECTIONS.map((s) => s.id).join(','));
    assert.equal(sections.find((s) => s.id === 'tasks').nodes.length, 1, 'a failing member query cannot empty the cached views');
    assert.equal(sections.find((s) => s.id === 'members').nodes.length, 0);
    membersFail = false;
    tasks = [];
    await backend.refresh();
    assert.deepEqual(unsubscribed, [taskId], 'a row that left the view is still unsubscribed');

    // typeTitles is one id -> title cache: the space in this document's location must not become a searchable type.
    assert.equal((await backend.handlers.get('doc:path')(null, openId)).map((c) => c.title).join(' > '), 'Library > Deal');
    tasks = [{ id: taskId, title: 'Task', state: { type: 'open' }, updateTime: '2026-09-13T10:00:00Z' }];
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

    cache.setSetting('taskFilter', { states: ['open', 'nonsense'], assignee: 'sam' });
    const stored = await backend.handlers.get('tasks:filter')();
    assert.equal(stored.states, null, 'a stored filter that is not a query falls back to the default');
    assert.equal(stored.assignee, 'me');
    cache.setSetting('libraryFilter', { types: ['tasks', 'wat'], states: [], assignee: 'anyone', text: 7 });
    const library = await backend.handlers.get('library:filter')();
    assert.equal(library.types.join(','), 'tasks', 'an unknown library kind cannot keep the view throwing');
    assert.equal(library.states, null);
    assert.equal(library.assignee, 'anyone');
    assert.equal(library.text, '');
    assert.equal(backend.statusSnapshot().error, null, 'none of this is an error to show');
    console.log('ok  refresh keeps on-demand subscriptions, survives a failing query, and caches only real answers');
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
  assert.equal(n.title, 'Ask and tell about Tana DPA');
  assert.equal(n.stateType, 'open');
  assert.equal(n.type, 'text');
  assert.deepEqual(n.assignedToUris, [ME]);
  assert.equal(typeof n.createdAt, 'number');
  const text = contentText(doc);
  assert.match(text, /^Imported from Tana Outliner on 2026-09-09\.\nOutliner ID: 1n74S7NZRMAS\nResearch context — 10 September 2026\nThe personal note-taking compliance task names Nina Boerman/);
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
  const other = new Document(DOC, { peerId: '9' });
  other.applyRemote([snapshot]);
  other.applyRemote(sent);
  assert.equal(readNode(other).stateType, 'closed');
  assert.equal(new Document(DOC).loro.oplogVersion().length(), 0, 'fresh doc = cold start');
  assert.notEqual(before.compare(doc.loro.oplogVersion()), 0);
  const assigned = new Document(DOC, { peerId: '8' });
  assigned.applyRemote([snapshot]);
  const otherAssignee = 'tana:user-profile:01m0f1aqd8p23qhwntbewmpfz3';
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
    assert.deepEqual(parseQuery('lex #task'), { text: 'lex', tags: ['task'] });
    assert.deepEqual(parseQuery('#Project  lex #meeting'), { text: 'lex', tags: ['Project', 'meeting'] });
    assert.deepEqual(parseQuery('  #  '), { text: '#', tags: [] }, 'a bare # is text');
    assert.deepEqual(parseQuery('a#b'), { text: 'a#b', tags: [] }, 'only word-initial #');
    const types = new Map([['project', 'tana:type:p']]);
    assert.equal(searchParams(parseQuery(''), types), null);
    assert.deepEqual(searchParams(parseQuery('lex'), types), { nodeTypes: ['text', 'event', 'user-profile'], textQuery: 'lex', limit: 20, sortOptions: [{ field: 'SORT_FIELD_TEXT_RANK', direction: 'SORT_DIRECTION_DESCENDING' }] });
    const task = searchParams(parseQuery('lex #task'), types);
    assert.deepEqual([task.nodeTypes, task.stateTypes, task.textQuery], [['text'], STATE_TYPES, 'lex']);
    assert.deepEqual(searchParams(parseQuery('#meeting'), types).nodeTypes, ['event']);
    assert.equal(searchParams(parseQuery('#meeting'), types).textQuery, undefined);
    assert.deepEqual(searchParams(parseQuery('#PROJECT'), types).entityTypes, ['tana:type:p'], 'type title matched case-insensitively');
    assert.equal(searchParams(parseQuery('x #Nope'), types), null, 'unknown type = no results');
    assert.deepEqual([needsTypes(parseQuery('#task #meeting')), needsTypes(parseQuery('#Project'))], [false, true]);
    assert.deepEqual(searchParams(parseQuery('#member'), types).nodeTypes, ['user-profile']);
    // Tasks/Library filters -> listNodes params (Addendum 10/11)
    const UPD = [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }];
    assert.deepEqual(taskParams(DEFAULT_TASK_FILTER, ME), { nodeTypes: ['text'], stateTypes: ['proposed', 'open'], assignedTo: [ME], limit: 500, sortOptions: UPD });
    assert.deepEqual(taskParams({ states: null, assignee: 'anyone' }, ME), { nodeTypes: ['text'], stateTypes: STATE_TYPES, limit: 500, sortOptions: UPD });
    assert.equal(taskParams({ states: ['closed'], assignee: 'unassigned' }, ME).unassigned, true);
    assert.deepEqual(taskParams({ states: ['closed'], assignee: 'tana:user-profile:x' }, ME).assignedTo, ['tana:user-profile:x']);
    assert.deepEqual(libraryQueries(DEFAULT_LIBRARY_FILTER, ME), [{ kind: 'tasks', params: taskParams(DEFAULT_LIBRARY_FILTER, ME, 100) }]);
    const lq = libraryQueries({ types: ['meetings', 'docs', 'chats'], text: ' dpa ' }, ME);
    assert.deepEqual(lq.map((q) => [q.kind, q.params.nodeTypes[0], q.params.textQuery]), [['meetings', 'event', 'dpa'], ['docs', 'text', 'dpa'], ['chats', 'chat', 'dpa']]);
    assert.equal(lq[1].params.stateTypes, undefined, 'docs are filtered client-side');
    assert.equal(libraryQueries({ types: null }, ME).length, 7, 'null types = every kind');
    assert.throws(() => libraryQueries({ types: ['nope'] }, ME), /unknown library type/);
    // An assignee filter must never leave a kind unfiltered: the graph filters every node type by assignedTo, and
    // kinds that carry no assignee then return nothing rather than their whole contents.
    const OTHER = 'tana:user-profile:01m1bg7kfhsxfejsxs0j1ydgnb';
    const mixed = libraryQueries({ types: ['tasks', 'meetings', 'docs', 'chats'], states: ['open'], assignee: OTHER }, ME);
    assert.deepEqual(mixed.map((q) => q.params.assignedTo), Array(4).fill([OTHER]), 'every selected kind asks for that person');
    assert.deepEqual(mixed.map((q) => q.params.stateTypes), [['open'], undefined, undefined, undefined], 'states stay a task filter');
    assert.deepEqual(libraryQueries({ types: null, assignee: OTHER }, ME).map((q) => q.params.assignedTo), Array(7).fill([OTHER]), 'any type = every kind');
    assert.deepEqual(libraryQueries({ types: ['tasks', 'meetings'], assignee: 'unassigned' }, ME).map((q) => q.params.unassigned), [true, true]);
    assert.ok(libraryQueries({ types: ['tasks', 'meetings'], assignee: 'anyone' }, ME).every((q) => !q.params.assignedTo && !q.params.unassigned), 'anyone filters nothing');
    assert.ok(libraryQueries({ types: ['meetings', 'chats'], assignee: OTHER }, ME).every((q) => !q.params.assignedTo), 'without tasks the Assigned pill is hidden, so it does not filter');
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

  // 3b. Outline ops on the content tree (docs/OUTLINER.md): every op is checked on readOutline, on the raw Loro
  // structure, and by replaying its local-update into a second Document.
  const c1 = new Document(DOC, { peerId: '11' }), c2 = new Document(DOC, { peerId: '12' });
  c1.applyRemote([snapshot]); c2.applyRemote([snapshot]);
  c1.on('local-update', (u) => c2.applyRemote([u]));
  const raw = () => c1.content.toJSON().children;
  const flat = (ns) => ns.map((n) => n.text.split('\n')[0].slice(0, 12) + (n.children.length ? '(' + flat(n.children) + ')' : '')).join(',');
  const wellFormed = (blocks) => { // listItem starts with a paragraph, lists only hold non-empty listItems, ids are 8 lowercase alphanumerics
    for (const b of blocks) {
      if (typeof b === 'string' || b.nodeName === 'mention') continue;
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
  assert.match(o0[2].text, /^The personal note-taking compliance task names Nina Boerman/, 'mention rendered as its label');
  // segments: text runs and mentions, in order; a run is the inline container at that index
  const run = (block, i) => c1.content.get('children').get(block).get('children').get(i);
  const MENTION = { mention: { label: 'personal note-taking compliance task', uri: 'tana:text:01m23c1zd6d4arqzr36a7s54nb' } };
  assert.equal(o0[2].segments.length, 3);
  assert.deepEqual(o0[2].segments.slice(0, 2), [{ text: 'The ' }, MENTION]);
  assert.equal(o0[2].segments.map((s) => s.text ?? s.mention.label).join(''), o0[2].text, 'segments join to text');
  assert.deepEqual(o0[1].segments, [{ text: o0[1].text }]);
  // setText with segments: same mention container kept, text runs updated in place, other segments replaced
  const mentionId = run(2, 1).id, tailId = run(2, 2).id;
  step(() => outline.setText(c1, 'r4hz3a0b', [{ text: 'The ' }, MENTION, { text: ' is edited.' }]));
  assert.deepEqual(outline.readOutline(c1)[2].segments, [{ text: 'The ' }, MENTION, { text: ' is edited.' }]);
  assert.equal(outline.readOutline(c1)[2].text, 'The personal note-taking compliance task is edited.');
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
  assert.equal(flat(outline.readOutline(c1)), 'Hello,Second,Research con,The personal,End');
  const child = step(() => outline.insertChild(c1, '6s8vb70s', 'Child'));
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child),Second,Research con,The personal,End');
  assert.equal(raw()[0].nodeName, 'bulletList');
  assert.deepEqual(raw()[0].children[0].children.map((b) => b.nodeName), ['paragraph', 'bulletList'], 'paragraph wrapped into listItem with a nested list');
  assert.equal(raw()[0].children[0].children[0].attributes.blockId, '6s8vb70s', 'node id survives wrapping');
  assert.equal(outline.insertChild(c1, 'dv8c4sp7', 'x'), null, 'headings cannot own children');
  step(() => outline.indent(c1, second));
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child,Second),Research con,The personal,End');
  assert.equal(raw()[0].children.length, 1, 'one listItem in the top list');
  step(() => outline.outdent(c1, second));
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child),Second,Research con,The personal,End');
  assert.equal(raw()[0].children.length, 2, 'outdented node is a sibling listItem');
  step(() => outline.indent(c1, '6s8vb70s')); // first node: no previous sibling
  step(() => outline.outdent(c1, 'r4hz3a0b')); // top level: no-op
  step(() => outline.indent(c1, 'r4hz3a0b')); // previous sibling is a heading: no-op
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child),Second,Research con,The personal,End');
  const grand = step(() => outline.insertChild(c1, child, 'Grand'));
  step(() => outline.indent(c1, end)); // becomes last child of the mention paragraph (wrapped)
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child(Grand)),Second,Research con,The personal(End)');
  assert.equal(raw()[2].children[0].children[0].children[1].nodeName, 'mention', 'mention kept through wrapping');
  const end2 = step(() => outline.insertAfter(c1, end, 'End2'));
  step(() => outline.outdent(c1, grand));
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child,Grand),Second,Research con,The personal(End,End2)');
  // move: no-op at the edges, swaps in the middle (listItems within their list, top-level blocks with their neighbour block)
  const beforeMoves = outline.readOutline(c1);
  step(() => outline.move(c1, end, 'up')); // first in its nested list
  step(() => outline.move(c1, '6s8vb70s', 'up')); // first in the top list
  step(() => outline.move(c1, end2, 'down')); // last in its nested list
  step(() => outline.move(c1, 'r4hz3a0b', 'down')); // last block of the doc
  assert.deepEqual(outline.readOutline(c1), beforeMoves, 'edges are no-ops');
  step(() => outline.move(c1, end, 'down'));
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child,Grand),Second,Research con,The personal(End2,End)');
  step(() => outline.move(c1, end, 'up'));
  step(() => outline.move(c1, second, 'up'));
  assert.equal(flat(outline.readOutline(c1)), 'Second,Hello(Child,Grand),Research con,The personal(End,End2)');
  step(() => outline.move(c1, second, 'down'));
  step(() => outline.move(c1, 'dv8c4sp7', 'up')); // heading swaps with the whole preceding list
  assert.equal(flat(outline.readOutline(c1)), 'Research con,Hello(Child,Grand),Second,The personal(End,End2)');
  step(() => outline.move(c1, 'dv8c4sp7', 'down'));
  assert.deepEqual(outline.readOutline(c1), beforeMoves, 'moves round-trip (ids and children kept)');
  assert.deepEqual(c2.content.toJSON(), c1.content.toJSON(), 'raw structure converges after moves');
  step(() => outline.remove(c1, grand));
  step(() => outline.remove(c1, end));
  step(() => outline.remove(c1, end2));
  assert.equal(flat(outline.readOutline(c1)), 'Hello(Child),Second,Research con,The personal');
  assert.equal(raw()[2].nodeName, 'bulletList');
  assert.equal(raw()[2].children[0].children.length, 1, 'emptied nested list removed from the listItem');
  step(() => outline.remove(c1, child));
  step(() => outline.remove(c1, second));
  step(() => outline.remove(c1, '6s8vb70s'));
  assert.equal(raw()[0].nodeName, 'heading', 'emptied top-level list removed');
  assert.equal(flat(outline.readOutline(c1)), 'Research con,The personal');
  assert.deepEqual(c2.content.toJSON(), c1.content.toJSON(), 'raw structure converges');
  console.log('ok  outline read/segments/setText/insertAfter/insertChild/indent/outdent/move/remove');
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
      { text: 'Tana Outliner', marks: { link: 'tana:1n74S7NZRMAS' } },
      { text: ' on 2026-09-09.\nOutliner ID: 1n74S7NZRMAS' },
    ], 'marks are read from the text delta');
    assert.equal(read('6s8vb70s').block, 'paragraph');
    assert.equal(read('dv8c4sp7').block, 'heading2');

    // write: marks are applied without touching the text, so the run containers and a mention survive
    const container = a.content.get('children').get(2).get('children').get(0).id;
    const mentionId = a.content.get('children').get(2).get('children').get(1).id;
    const withMarks = [{ text: 'The ', marks: { bold: true } }, { mention: { label: 'personal note-taking compliance task', uri: 'tana:text:01m23c1zd6d4arqzr36a7s54nb' } }, { text: ' tail', marks: { italic: true, link: 'https://example.test' } }];
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
    assert.deepEqual(raw()[2].children, ['The personal note-taking compliance task tail'], 'code holds plain text only');
    assert.deepEqual(read('r4hz3a0b').segments, [{ text: 'The personal note-taking compliance task tail' }], 'no marks inside code');
    step(() => outline.setBlockType(a, 'r4hz3a0b', 'paragraph'));
    assert.equal(read('r4hz3a0b').block, 'paragraph');
    assert.throws(() => outline.setBlockType(a, 'r4hz3a0b', 'heading4'), /Unknown block type/);
    assert.throws(() => outline.setBlockType(a, 'nope0000', 'quote'), /no outline node/);

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
    const { callOf } = mainHelpers();
    // spread: the helper runs in its own vm realm, so compare plain values rather than cross-realm objects
    assert.deepEqual({ ...callOf({ location: 'https://meet.tana.inc/rkx-bpmx-ksf' }) }, { url: 'https://meet.tana.inc/rkx-bpmx-ksf', label: 'meet.tana.inc/rkx-bpmx-ksf' });
    assert.equal(callOf({ location: 'https://meet.google.com/ipt-utoj-srr/' }).label, 'meet.google.com/ipt-utoj-srr');
    const zoom = callOf({ location: '+Groenlo Building 6.1a-R1 Presentationroom; https://nedap.zoom.us/j/653?pwd=AR8&from=addon' });
    assert.equal(zoom.url, 'https://nedap.zoom.us/j/653?pwd=AR8&from=addon', 'the passcode stays in the url');
    assert.equal(zoom.label, 'nedap.zoom.us/j/653', 'the room note and the query stay out of the label');
    assert.equal(callOf({ location: 'Groenlo, Healthcare, The Crooks' }), undefined, 'a room is not a call');
    assert.equal(callOf({}), undefined, 'no location, no call');
    const teams = callOf({ location: 'Teams meeting', actionUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_' + 'z'.repeat(140) + '%40thread.v2/0' });
    assert.equal(teams.label, 'teams.microsoft.com', 'a join path of ids is not a label');
    assert.match(teams.url, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//, 'the provider link is kept whole');
    assert.equal(callOf({ location: 'https://meet.tana.inc/a-b-c', actionUrl: 'https://zoom.us/j/1' }).label, 'meet.tana.inc/a-b-c', 'the location wins over the action');
  }
  // A multi-select is one user action: one undo/redo step restores/reapplies its complete range.
  {
    const d = new Document(DOC, { peerId: '741' });
    const a = outline.insertAfter(d, null, 'Detail A');
    const b = outline.insertAfter(d, a, 'Detail B');
    outline.removeMany(d, [a, b]);
    assert.deepEqual(outline.readOutline(d), []);
    assert.equal(d.undo(), true);
    assert.deepEqual(outline.readOutline(d).map((n) => n.text), ['Detail A', 'Detail B']);
    assert.equal(d.redo(), true);
    assert.deepEqual(outline.readOutline(d), []);

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
  // 3c. Image blocks (addendum 12): { nodeName 'image', attributes { blockId, tanaUri, displayWidth?, displayHeight? }, children [] }
  //     as seen in tana:text:01m2839s1xa7mejzavmaqv2ck9; read as { type 'image', image }, removable and movable like any block.
  {
    const IMG = 'tana:image:01m2839s0wws9j9zt18vmqqwp7';
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
    const { mime, bytes } = await fetchImage('tana:image:01m2839s0wws9j9zt18vmqqwp7', { baseUrl: 'https://api.test', fetch: fakeFetch, getAccessToken: async ({ refresh }) => (refresh ? 'fresh' : tokens[0]) });
    assert.equal(mime, 'image/png');
    assert.equal(bytes.toString('hex'), '89504e47');
    assert.equal(calls.length, 3, '401 retried with a refreshed token, then the CDN');
    assert.equal(calls[0][0], 'https://api.test/images/by-uri/tana%3Aimage%3A01m2839s0wws9j9zt18vmqqwp7');
    await assert.rejects(fetchImage('tana:text:01m2839s0wws9j9zt18vmqqwp7', { fetch: fakeFetch, getAccessToken: async () => 'x' }), /not a tana:image uri/);
    console.log('ok  image asset fetch (redirect + CDN cookie)');
  }
  // ---- undo/redo: local-only, ops flow out like any local change, the other document converges ----
  {
    const a = new Document('tana:text:undo', { peerId: '1' }), b = new Document('tana:text:undo', { peerId: '2' });
    a.on('local-update', (u) => b.applyRemote([u]));
    b.on('local-update', (u) => a.applyRemote([u]));
    a.transact((l) => { l.getMap('data').set('title', 'one'); });
    assert.equal(a.canUndo(), true);
    setTitle(a, 'two');
    outline.insertAfter(a, null, 'para');
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
    const docs = {}, mirror = {};
    for (const id of [ME, COL, PM]) { docs[id] = new Document(id, { peerId: '21' }); mirror[id] = new Document(id, { peerId: '22' }); docs[id].on('local-update', (u) => mirror[id].applyRemote([u])); }
    const sync = { subscribed: [], subscribe: async (id) => { sync.subscribed.push(id); if (!docs[id]) throw new Error('document not found: ' + id); return docs[id]; } };
    await assert.rejects(pins.listSidebar(sync, ME), /no pinnedCollectionUri/, 'no lazy creation');
    docs[ME].transact((l) => { l.getMap('data').set('pinnedCollectionUri', COL); l.getMap('data').set('pinMapUri', PM); });
    // web-client layout: a pin, then a folder holding a pin
    docs[COL].transact((l) => { const t = l.getTree('tree'); t.createNode().data.set('uri', B); const f = t.createNode(); f.data.set('label', 'Folder'); t.createNode(f.id).data.set('uri', 'tana:space:s'); });
    assert.deepEqual(await pins.sidebarTree(sync, ME), [{ uri: B, children: [] }, { label: 'Folder', children: [{ uri: 'tana:space:s', children: [] }] }]);
    assert.deepEqual(await pins.listSidebar(sync, ME), [B, 'tana:space:s']);
    await pins.pinSidebar(sync, ME, A);
    await pins.pinSidebar(sync, ME, A); // dedup
    assert.deepEqual(await pins.listSidebar(sync, ME), [B, 'tana:space:s', A], 'appended at the end, in tree order');
    assert.deepEqual(mirror[COL].loro.getTree('tree').toJSON().map((n) => n.meta), [{ uri: B }, { label: 'Folder' }, { uri: A }]);
    await pins.unpinSidebar(sync, ME, B);
    await pins.unpinSidebar(sync, ME, 'tana:text:nope'); // no-op
    assert.deepEqual(await pins.listSidebar(sync, ME), ['tana:space:s', A]);
    assert.equal(mirror[COL].loro.getTree('tree').toJSON().length, 2, 'deleted node gone from the mirror tree');
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
    assert.deepEqual(mirror[PM].toJSON(), docs[PM].toJSON());
    assert.deepEqual([...new Set(sync.subscribed)], [ME, COL, PM], 'only the profile and the two pointed documents are subscribed');
    console.log('ok  pins (sidebar tree, personal date pins, converge)');
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
    backend.testRuntime({me:{userUri:ME}, client:{sync:{getDocument:id=>documents.get(id), subscribe:async id=>documents.get(id)}}, win:{isDestroyed:()=>false,webContents:{send:(channel,id)=>events.push([channel,id])}}});
    collection.on('change', () => backend.onChange(colId));
    remoteCollection.on('local-update', u => collection.applyRemote([u]));
    assert.equal((await backend.pinTree()).length, 1);
    const coldDeletedId = 'tana:text:' + ulid(), coldDeleted = new Document(coldDeletedId);
    coldDeleted.transact(l => { initDocument(l, 'deleted before subscribing', ME); l.getMap('data').set('deletedAt', 100); });
    documents.set(coldDeletedId, coldDeleted);
    remoteCollection.transact(l => l.getTree('tree').createNode().data.set('uri', coldDeletedId));
    assert.equal((await backend.pinTree()).length, 1, 'already-deleted snapshot pin is suppressed before any live notification');

    remoteCollection.transact(l => l.getTree('tree').delete(l.getTree('tree').nodes().find(n => n.data.get('uri') === pinId).id));
    assert.ok(events.some(([channel,id]) => channel === 'outline:changed' && id === null), 'remote unpin invalidates palette globally despite no cached collection row');
    assert.equal((await backend.pinTree()).length, 0);
    assert.ok(cache.get(pinId), 'unpin does not delete the document');
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
    remotePin.transact(l => l.getMap('data').delete('deletedAt'));
    assert.equal(backend.visibleGraphNodes([{id:pinId}]).length, 1, 'native restore clears tombstone');
    assert.equal(backend.SECTIONS.find(s => s.id === 'library').icon, 'library');
    const agentId = 'tana:agent:' + ulid();
    assert.equal(backend.graphRow({id:agentId,title:'Agent'}).icon, 'agent');
    assert.equal(backend.toNode({id:agentId,title:'cached',icon:'doc'}).icon, 'agent');
    console.log('ok  remote unpin/deletion invalidation, stale graph suppression, restore and agent cache icon');
  }
  {
    const backend = mainHelpers(), cache = require('../db'); cache.open(':memory:');
    const host = new Document(DOC), targetUri = 'tana:text:01m2524x1ewvjfvxp68ym77ht1';
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
    const requests = [];
    backend.testRuntime({me:{userUri:ME},client:{graph:{listNodes:async q => { requests.push(q); return {nodes:[{id:targetUri,title:'Actual embedded task',state:{type:'open'},appearance:{hue:0}}]}; }}}});
    const resolved = await backend.outlineWithReferences(host);
    assert.equal(resolved[0].id, blockId); assert.equal(resolved[0].reference.node.id, targetUri);
    assert.equal(resolved[0].reference.node.icon, 'task'); assert.equal(resolved[0].reference.node.done, 0);
    assert.equal(resolved[0].reference.node.hue, 0); assert.equal(resolved[1].id, headingId);
    assert.deepEqual(Array.from(requests[0].nodeIds), [targetUri]);
    assert.deepEqual(host.toJSON(), before, 'resolution never copies target data into the CRDT');
    backend.testRuntime({me:{userUri:ME},client:{graph:{listNodes:async()=>{throw new Error('unavailable');}}}});
    const unresolved = await backend.outlineWithReferences(host);
    assert.deepEqual(unresolved[0].reference, {uri:targetUri});
    assert.throws(() => outline.move(host, blockId, 'sideways'), /up or down/, 'a bad direction is refused, never silently down');
    outline.move(host, blockId, 'down');
    assert.equal(outline.readOutline(host)[1].reference.uri, targetUri);
    outline.remove(host, blockId);
    assert.equal(outline.readOutline(host).length, 1);
    console.log('ok  native embed identity, task resolution, unavailable fallback and non-destructive outline operations');
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
  const server = { frames: [], wake: null, commands: [], serverDoc: new Document(DOC, { peerId: '4242' }), session: 0, created: new Map() };
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
        const cold = value.clientVv.length === 0;
        if (value.documentId !== DOC && !server.created.has(value.documentId)) { // unknown id: MISSING, nothing to send (§2.1)
          return fromJson(message('sync', 'ServerSyncCommandResponse'), { bootstrapResponse: { sessionId, status: 'BOOTSTRAP_STATUS_MISSING', serverVv: '', serverUpdates: '' } });
        }
        return fromJson(message('sync', 'ServerSyncCommandResponse'), { bootstrapResponse: { sessionId, status: 'BOOTSTRAP_STATUS_EXISTING',
          serverVv: b64(server.serverDoc.loro.oplogVersion().encode()), serverUpdates: cold ? b64(server.serverDoc.loro.export({ mode: 'snapshot' })) : '' } });
      }
      if (kind === 'applyBootstrapUpdates') {
        if (value.documentId !== DOC) { // a create: the catch-up must be a full snapshot of a doc the server never saw
          assert.ok(value.updates.length, 'create sends a non-empty catch-up');
          const d = new Document(value.documentId, { peerId: '4242' });
          d.applyRemote([value.updates]);
          server.created.set(value.documentId, d);
        } else if (value.updates.length) server.serverDoc.applyRemote([value.updates]);
        setTimeout(() => push({ bootstrapComplete: { documentId: value.documentId, sessionId: value.sessionId, barrierVv: '' } }), 5);
        return {};
      }
      if (kind === 'liveDocumentUpdate') {
        if (value.sessionId !== 's' + server.session) throw new ConnectError('stale session', Code.FailedPrecondition);
        (server.created.get(value.documentId) || server.serverDoc).applyRemote(value.updates);
        return {};
      }
      if (kind === 'documentAction') { assert.ok(['softDelete','restore'].includes(value.action.case)); return fromJson(message('sync', 'ServerSyncCommandResponse'), { documentActionResponse: {} }); }
      return {};
    },
  }));
  const log = { warn: () => {}, error: (m) => console.error(m), info: () => {} };
  const sync = new SyncConnection({ transport: router, orgId: ORG, peerId, logger: log });
  const changes = [];
  sync.on('change', (id, info) => changes.push(info.origin));
  sync.on('error', (e) => { throw e; });
  let connected = 0; sync.on('connected', () => connected++);
  await sync.connect();
  assert.equal(connected, 1);
  const d = await sync.subscribe(DOC);
  assert.equal(d, sync.getDocument(DOC));
  assert.equal(readNode(d).title, 'Ask and tell about Tana DPA');
  assert.deepEqual(server.commands, ['beginDocumentSync', 'applyBootstrapUpdates']);
  assert.equal(await sync.subscribe(DOC), d, 'subscribe is idempotent');
  // local -> server, batched into one liveDocumentUpdate
  setTitle(d, 'Ask and tell about Tana DPA');
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
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(server.commands.slice(3), ['beginDocumentSync', 'applyBootstrapUpdates']);
  assert.equal(server.session, 2);
  setTitle(d, 'after resync');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(readNode(server.serverDoc).title, 'after resync');
  // watchdog: server goes silent (no heartbeats) -> 3x interval -> reconnect -> same Document re-bootstrapped
  let disconnected = 0; sync.on('disconnected', () => disconnected++);
  server.stall = true;
  await new Promise((r) => setTimeout(r, 1500));
  server.stall = false;
  await new Promise((r) => setTimeout(r, 3000));
  assert.ok(disconnected >= 1 && connected >= 2, 'reconnected after watchdog: ' + disconnected + '/' + connected);
  assert.equal(sync.getDocument(DOC), d);
  assert.ok(server.session >= 3, 'document re-bootstrapped after reconnect');
  assert.equal(readNode(d).title, 'after resync');
  setTitle(d, 'after reconnect');
  await new Promise((r) => setTimeout(r, 30));
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
  await sync.close();
  assert.equal(sync.connected, false);
  assert.ok(server.commands.includes('unsubscribeDocument'), 'unsubscribe sent on close');
  assert.ok(changes.includes('local') && changes.includes('remote'));
  console.log('ok  sync lifecycle (connect, bootstrap, live out/in, session check, resync, close)');
}

main().then(() => console.log('all checks passed'), (e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
'use strict';
// Offline self-check for the SDK core: no network, no Electron. Run: node scripts/sdk-check.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { create, toBinary, fromBinary, toJson, fromJson } = require('@bufbuild/protobuf');
const { createRouterTransport, ConnectError, Code } = require('@connectrpc/connect');
const { message, SyncService } = require('../sdk/proto/descriptors');
const { createTransport, GraphClient, SyncConnection, Document, derivePeerId, readNode, setTitle, setState, contentText } = require('../sdk');
const outline = require('../sdk/content');

const ORG = 'org_01KS7RQSWW68H489ZZZ1NNC40T', DOC = 'tana:text:01m23c1z45gceayt2zjk09k63c', ME = 'tana:user-profile:01m0f1aqd8p23qhwntbewmpfz2';
const snapshot = Buffer.from(fs.readFileSync(require('node:path').join(__dirname, 'fixtures', 'task-snapshot.b64'), 'utf8').trim(), 'base64');
const b64 = (u8) => Buffer.from(u8).toString('base64');

async function main() {
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
  assert.equal(doc.version().length, doc.loro.oplogVersion().encode().length);
  assert.equal(new Document(DOC).loro.oplogVersion().length(), 0, 'fresh doc = cold start');
  assert.notEqual(before.compare(doc.loro.oplogVersion()), 0);
  console.log('ok  readNode/setTitle/setState/contentText');

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
  const server = { frames: [], wake: null, commands: [], serverDoc: new Document(DOC, { peerId: '4242' }), session: 0 };
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
        return fromJson(message('sync', 'ServerSyncCommandResponse'), { bootstrapResponse: { sessionId, status: 'BOOTSTRAP_STATUS_EXISTING',
          serverVv: b64(server.serverDoc.loro.oplogVersion().encode()), serverUpdates: cold ? b64(server.serverDoc.loro.export({ mode: 'snapshot' })) : '' } });
      }
      if (kind === 'applyBootstrapUpdates') {
        if (value.updates.length) server.serverDoc.applyRemote([value.updates]);
        setTimeout(() => push({ bootstrapComplete: { documentId: DOC, sessionId: value.sessionId, barrierVv: '' } }), 5);
        return {};
      }
      if (kind === 'liveDocumentUpdate') {
        if (value.sessionId !== 's' + server.session) throw new ConnectError('stale session', Code.FailedPrecondition);
        server.serverDoc.applyRemote(value.updates);
        return {};
      }
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
  // frames for another session are dropped
  push({ liveDocumentUpdate: { documentId: DOC, sessionId: 'old', updates: remote.map(b64) } });
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
  await sync.close();
  assert.equal(sync.connected, false);
  assert.ok(server.commands.includes('unsubscribeDocument'), 'unsubscribe sent on close');
  assert.ok(changes.includes('local') && changes.includes('remote'));
  console.log('ok  sync lifecycle (connect, bootstrap, live out/in, session check, resync, close)');
}

main().then(() => console.log('all checks passed'), (e) => { console.error(e); process.exit(1); });

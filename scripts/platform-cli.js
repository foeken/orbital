#!/usr/bin/env node
'use strict';
// CLI for the platform SDK: node scripts/platform-cli.js <cmd>
// Run it with node, not with ./node_modules/.bin/electron: inside an agent sandbox LaunchServices is
// unreachable, so Electron's GUI process aborts in AppKit before this file loads (docs/ELECTRON-SANDBOX.md).
// Under node this file is only a launcher: it refuses inside a sandbox and re-execs the Electron binary outside one.
const path = require('node:path');
if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {
  if (process.env.CODEX_SANDBOX) {
    console.error('platform-cli needs GUI Electron, which cannot start inside the sandbox (CODEX_SANDBOX=' +
      process.env.CODEX_SANDBOX + '): macOS aborts it in _RegisterApplication. Re-run with escalated/unsandboxed ' +
      'permissions. See docs/ELECTRON-SANDBOX.md.');
    process.exit(3);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronBin = path.join(__dirname, '..', 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  const { status } = require('node:child_process').spawnSync(electronBin, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(status == null ? 1 : status);
}
const { app } = require('electron');
const { createTanaSession, peerIdentity } = require('../tana-session');
let createTanaClient, readNode, setTitle, setState, workflowStates, STATE_TYPES, contentText, readOutline, ulid, initDocument, query, pins, audienceMetadata; // loaded lazily: login/whoami work without the SDK

// Share the cookie partition and peer.json with the real app, including the move to the app's current name.
app.setPath('userData', require('../userdata').userDataDir(app.getPath('appData'), { migrate: true }));
if (app.dock) app.dock.hide();

const [cmd, ...args] = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

let session, client;

async function connect() {
  ({ createTanaClient } = require('../sdk'));
  ({ readNode, setTitle, setState, workflowStates, STATE_TYPES, contentText, ulid, initDocument, audienceMetadata } = require('../sdk/node'));
  ({ readOutline } = require('../sdk/content'));
  query = require('../sdk/query');
  pins = require('../sdk/pins');
  const me = await session.info();
  const peer = peerIdentity({ file: path.join(app.getPath('userData'), 'peer.json'), userExternalId: me.userExternalId });
  client = createTanaClient({ getAccessToken: (o) => session.getAccessToken(o), orgId: me.orgId, ...peer, logger: console, clientName: 'orbital-cli', userAgent: 'Orbital-CLI/' + require('../package.json').version }); // told apart from the app in Tana's logs
  return me;
}

const summary = (doc) => { const n = readNode(doc); return { id: doc.id, title: n.title, stateType: n.stateType, assignedToUris: n.assignedToUris }; };
// The workflow of a type, or of a task: its own stateWorkflowUri, else its type's workflowUri (Tana's A_ hook).
const workflowOf = async (doc) => {
  const n = readNode(doc);
  const uri = n.type === 'type' ? n.workflowUri : n.stateWorkflowUri || (n.entityTypeUri && readNode(await client.sync.subscribe(n.entityTypeUri)).workflowUri);
  return uri ? { uri, states: workflowStates(await client.sync.subscribe(uri)) } : null;
};
const today = () => new Date().toLocaleDateString('sv-SE');
// pin <id> <sidebar|today|shared|mute> / unpin: mutate, let the live update go out, print the doc's pin state. shared is
// the document's own sharedPinDates (everyone sees it); pin … mute hides today for you, unpin … mute shows it again.
async function setPin(on) {
  const [id, target] = positional;
  if (!id || !['sidebar', 'today', 'shared', 'mute'].includes(target)) throw new Error('usage: ' + (on ? 'pin' : 'unpin') + ' <id> <sidebar|today|shared|mute>');
  const me = await connect();
  await client.sync.connect();
  if (target === 'sidebar') await (on ? pins.pinSidebar : pins.unpinSidebar)(client.sync, me.userUri, id);
  else if (target === 'today') await (on ? pins.pinDate : pins.unpinDate)(client.sync, me.userUri, id, today());
  else if (target === 'mute') await (on ? pins.muteDate : pins.unmuteDate)(client.sync, me.userUri, id, today());
  else (on ? pins.pinSharedDate : pins.unpinSharedDate)(await client.sync.subscribe(id), today());
  await new Promise((r) => setTimeout(r, 1500));
  out({ id, sidebar: (await pins.listSidebar(client.sync, me.userUri)).includes(id), dates: await pins.dates(client.sync, me.userUri, id), shared: pins.sharedDates(await client.sync.subscribe(id)) });
}

const commands = {
  async login() {
    if (!(await session.login())) return out('login cancelled');
    out('logged in as ' + ((await session.info()).user || {}).email);
  },
  async whoami() {
    out(await session.info());
  },
  // fields: every type that defines attributes, with their keys and titles
  async fields() {
    await connect();
    if (positional[0]) { // fields <type-uri>: that type's instances and their attribute values
      const { nodes } = await client.graph.listNodes({ entityTypes: [positional[0]], limit: 20 });
      for (const n of nodes) out(n.id + ' ' + (n.title || '') + ' attributes=' + JSON.stringify(n.attributes || {}));
      return out(nodes.length + ' instances');
    }
    const { nodes } = await client.graph.listNodes({ nodeTypes: ['type'], limit: 300 });
    for (const n of nodes) {
      const defs = (n.typeDef && n.typeDef.attributes) || [];
      if (defs.length) out(n.id + '  ' + (n.title || '') + ': ' + defs.map((d) => d.key + ' (' + (d.title || '') + ', ' + (d.type || '') + (d.cardinality ? ', ' + d.cardinality : '') + ')').join(' | '));
    }
    out(nodes.length + ' types scanned');
  },
  // livequery [--minutes 60] [--seconds 20] [--state proposed|open|closed|not_now]: open a live query (sdk/livequery.js)
  // for text nodes created in the last N minutes, or that entered a state in that window, and print every change the
  // server pushes. Read-only: the only thing it writes is its own throwaway query document.
  // With --to <id> and/or --from <id> it is an edge query instead: the edges into / out of that node, of the types
  // --edge-types names (default LINKS_TO,ATTRIBUTE_LINKS_TO, the backlinks), printed as from -type-> to {properties}.
  async livequery() {
    await connect();
    await client.sync.connect();
    const { openLiveQuery, openEdgeQuery, EDGE_TYPES } = require('../sdk/livequery');
    const to = flag('to'), from = flag('from');
    if (to || from) {
      const edgeTypes = String(flag('edge-types', 'LINKS_TO,ATTRIBUTE_LINKS_TO')).split(',').map((t) => EDGE_TYPES[t.trim()]);
      if (edgeTypes.some((t) => t === undefined)) throw new Error('--edge-types: one of ' + Object.keys(EDGE_TYPES).join(', '));
      const live = await openEdgeQuery(client.sync, { ...(from ? { subject: { uris: [from] } } : {}), predicate: { edgeTypes }, ...(to ? { object: { uris: [to] } } : {}) }, { label: 'orbital probe' });
      const edge = (e) => e.fromNode + ' -' + e.type + '-> ' + e.toNode + (e.properties ? ' ' + JSON.stringify(e.properties) : '');
      out(live.id + '\t' + live.state().status);
      live.on('error', (e) => out('error\t' + e.message));
      live.on('rows', ({ added, removed, changed, initial }) => out((initial ? 'initial' : 'update') + [...added.map((e) => '\n  + ' + edge(e)), ...changed.map((e) => '\n  ~ ' + edge(e)), ...removed.map((e) => '\n  - ' + edge(e))].join('')));
      await new Promise((r) => setTimeout(r, Number(flag('seconds', 20)) * 1000));
      return live.close();
    }
    const since = Date.now() - Number(flag('minutes', 60)) * 6e4, state = flag('state');
    const q = state ? { types: ['text'], stateTypes: [state], stateEnteredAtMin: since, limit: 50 } : { types: ['text'], createdAtMin: since, orderBy: ['-createdAt'], limit: 50 };
    const live = await openLiveQuery(client.sync, q, { label: 'orbital probe' });
    const row = (r) => r.uri + ':' + ((r.state && r.state.type) || '-');
    out(live.id + '\t' + live.state().status);
    live.on('error', (e) => out('error\t' + e.message));
    live.on('rows', ({ added, removed, changed, initial }) => out((initial ? 'initial' : 'update') + '\t+' + added.map(row).join(' +') + (changed.length ? '\t~' + changed.map(row).join(' ~') : '') + (removed.length ? '\t-' + removed.join(' -') : '')));
    await new Promise((r) => setTimeout(r, Number(flag('seconds', 20)) * 1000));
    await live.close();
  },
  // presence <document id> [--seconds 30] [--announce <name>] [--block <blockId>]: open the document's presence channel
  // (sdk/presence.js), print everyone in it and every change, and with --announce be in it yourself under that name
  // (a caret at --block when given). Read-only: presence is never stored.
  async presence() {
    const me = await connect();
    await client.sync.connect();
    const id = positional[0];
    if (!id) throw new Error('usage: presence <document id> [--seconds 30] [--announce <name>] [--block <blockId>]');
    const { openPresence } = require('../sdk/presence');
    const room = await openPresence(client.sync, id, { viewing: true });
    const mine = require('../sdk/presence').userHashOf(client.sync.peerId);
    const who = (p) => p.peer + (p.userHash === mine ? '(me)' : '') + ':' + ((p.user && p.user.name) || '?') + (p.hasCursor ? '@' + ((p.anchorBlock && p.anchorBlock.blockId) || 'cursor') : '');
    out('peer ' + room.peerId + '\t' + (me.displayName || me.userUri));
    if (flag('announce')) room.setLocal({ user: { name: flag('announce'), color: 'blue' }, anchorBlock: flag('block') ? { blockId: flag('block'), offset: 0 } : null });
    const show = (why) => out(why + '\t' + (room.peers().map(who).join(' ') || '(nobody else)'));
    show('now');
    room.on('change', ({ by }) => show('change/' + by));
    await new Promise((r) => setTimeout(r, Number(flag('seconds', 30)) * 1000));
    await room.close();
  },
  // graphnode <id>: the raw graph Node JSON, including attributes and any typed links
  async graphnode() {
    await connect();
    const id = positional[0];
    if (!id) throw new Error('usage: graphnode <id>');
    const { nodes } = await client.graph.listNodes({ nodeIds: [id], limit: 1 });
    out(JSON.stringify(nodes[0] || null, null, 1));
  },
  // edges <id>: raw ListEdges both ways, for learning how Tana links things (pinned items, outcomes, sources)
  async edges() {
    await connect();
    const id = positional[0];
    if (!id) throw new Error('usage: edges <id>');
    for (const dir of ['from', 'to']) {
      const params = dir === 'from' ? { fromNodeIds: [id] } : { toNodeIds: [id] };
      try { out(dir + ': ' + JSON.stringify(await client.graph.listEdges(params), null, 1)); }
      catch (e) { out(dir + ' failed: ' + (e && e.message)); }
    }
  },
  // changes <id> [--within <summary id>] [--limit 20]: the written change summaries Tana's own Changes panel shows,
  // straight from tana.history.v1alpha1 (sdk/history.js). --within opens an expandable summary.
  async changes() {
    await connect();
    const id = positional[0];
    if (!id) throw new Error('usage: changes <id> [--within <summary id>] [--limit 20]');
    const { parent, summaries } = await client.history.listChanges({ uri: id, withinId: flag('within', ''), limit: Number(flag('limit', 20)) });
    if (parent) out('parent: ' + JSON.stringify(parent));
    out(summaries.length + ' summaries (oldest first, as the service answers)');
    for (const s of summaries) out(JSON.stringify(s));
  },
  async list() {
    const me = await connect();
    const state = flag('state', 'open');
    // the same builder the Tasks view uses (sdk/query.js), so the CLI cannot drift from the app
    const { nodes } = await client.graph.listNodes(query.viewParams({ types: ['tasks'], states: state === 'all' ? null : [state], assignee: 'me' }, me.userUri));
    for (const n of nodes) out(n.id + '\t' + ((n.state && n.state.type) || '-') + '\t' + (n.title || ''));
    out(nodes.length + ' nodes'); // totalCount needs mode LIST_NODES_MODE_WITH_COUNT
  },
  async search() {
    // --link <type-uri,…> | --link members: main's search as a link field asks it (issue #33), narrowed to those types
    if (flag('link')) {
      const main = backend(await connect());
      const scope = flag('link') === 'members' ? { members: true } : { types: flag('link').split(',').filter(Boolean) };
      const found = await main.search(positional.join(' '), scope);
      for (const n of found) out(n.id + '  ' + (n.title || n.text || '') + '  ' + JSON.stringify((n.tags || []).map((t) => t.label)));
      return out(found.length + ' results');
    }
    await connect();
    const parsed = query.parseQuery(positional.join(' '));
    let types = new Map();
    if (query.needsTypes(parsed)) types = new Map((await client.graph.listNodes({ nodeTypes: ['type'], limit: 200 })).nodes.map((n) => [(n.title || '').toLowerCase(), n.id]));
    const params = query.searchParams(parsed, types);
    if (!params) return out('no results (empty query or unknown #type)');
    const { nodes } = await client.graph.listNodes({ ...params, limit: Number(flag('limit') || params.limit || 40) });
    const when = (ev) => (ev ? new Date(ev.startTime).toLocaleString('sv-SE').slice(0, 16) + ' ' : '');
    for (const n of nodes) out(n.id + '  ' + (n.calendarEvent ? '[meeting] ' + when(n.calendarEvent) : n.state ? '[task:' + n.state.type + '] ' : n.entityType ? '[typed] ' : '') + (n.title || ''));
    out(nodes.length + ' results');
  },
  async types() {
    await connect();
    // --archived 1 asks with includeArchived, which is the only way an archived type comes back
    const includeArchived = flag('archived', '0') === '1';
    for (const n of (await client.graph.listNodes({ nodeTypes: ['type'], limit: 200, includeArchived })).nodes) out(n.id + '\t' + (n.title || '') + '\thue=' + (n.appearance && n.appearance.hue != null ? n.appearance.hue : '-') + (n.archivedAt ? '\tarchivedAt=' + n.archivedAt : ''));
  },
  // Read-only sweep: the audience label the app would show for every task/document, to find 'unknown' cases.
  async audiences() {
    const me = await connect();
    await client.sync.connect();
    const state = flag('state', 'all'), params = {
      nodeTypes: [flag('kind', 'text')], limit: Number(flag('limit', 80)),
      sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }],
    };
    if (flag('mine', '1') === '1') params.assignedTo = [me.userUri];
    if (state !== 'all') params.stateTypes = [state];
    const { nodes } = await client.graph.listNodes(params);
    const counts = {};
    for (const n of nodes) {
      const doc = await client.sync.subscribe(n.id).catch((e) => ({ error: String(e.message || e) }));
      const meta = doc.id ? await audienceMetadata(doc, me.userUri, client.graph, client.sync) : { audience: 'subscribe-failed: ' + doc.error };
      counts[meta.audience] = (counts[meta.audience] || 0) + 1;
      const data = doc.id ? readNode(doc) : {};
      out([meta.audience, n.id, JSON.stringify(n.title || '').slice(0, 60),
        'restricted=' + data.restricted, 'owner=' + (data.ownerUri || '-'),
        'participants=' + JSON.stringify(Object.entries(data.participants || {}).map(([u, p]) => u.split(':')[1] + '/' + p.role + '/' + p.type)),
        meta.audienceSpace ? 'space=' + JSON.stringify(meta.audienceSpace) : ''].join('\t'));
    }
    out(counts);
  },
  async inspect() {
    if (!positional.length) throw new Error('usage: inspect <id...>');
    const me = await connect();
    await client.sync.connect();
    for (const id of positional) {
      const [graph, chain] = await Promise.all([
        client.graph.listNodes({ nodeIds: [id], limit: 1 }).then((r) => r.nodes[0] || null, (e) => ({ error: String(e.message || e) })),
        client.graph.getOwnerChain(id).catch((e) => ({ error: String(e.message || e) })),
      ]);
      const doc = await client.sync.subscribe(id).catch((e) => ({ error: String(e.message || e) }));
      const data = doc.id ? readNode(doc) : doc;
      out({
        id,
        graph: graph && { title: graph.title, entityType: graph.entityType, appearance: graph.appearance, state: graph.state, ownerUri: graph.ownerUri, restricted: graph.restricted, deletedAt: graph.deletedAt },
        ownerChain: chain.entries || chain,
        effectivelyRestricted: chain.effectivelyRestricted,
        data: doc.id ? { type: data.type, restricted: data.restricted, participants: data.participants, ownerUri: data.ownerUri, entityTypeUri: data.entityTypeUri, appearance: data.appearance } : data,
        audience: doc.id ? await audienceMetadata(doc, me.userUri, client.graph, client.sync) : null,
      });
    }
  },
  async image() {
    if (!positional[0]) throw new Error('usage: image <tana:image:...>');
    const { fetchImage } = require('../sdk/assets');
    const { mime, bytes } = await fetchImage(positional[0], { getAccessToken: (o) => session.getAccessToken(o) });
    out(mime + '\t' + bytes.length + ' bytes');
  },
  async create() {
    const kind = flag('kind', 'doc');
    if (!positional[0] || !['doc', 'task', 'meeting', 'type'].includes(kind)) throw new Error('usage: create <title> [--kind task|meeting|doc|type]');
    const me = await connect();
    await client.sync.connect();
    const id = (kind === 'meeting' ? 'tana:event:' : kind === 'type' ? 'tana:type:' : 'tana:text:') + ulid();
    const doc = await client.sync.subscribe(id, (loro) => initDocument(loro, positional[0], me.userUri, { kind }));
    const n = readNode(doc);
    out({ ...summary(doc), type: n.type, startTime: n.startTime, endTime: n.endTime });
  },
  // upload <image file> <doc id> [--after <block id>]: WRITES. The bytes to Tana's file store, a tana:image: document
  // owned by <doc id>, and an image block after --after (default: at the end) — what a paste does (main/images.js)
  async upload() {
    const [file, docId] = positional;
    if (!file || !docId) throw new Error('usage: upload <image file> <doc id> [--after <block id>]');
    const { uploadFile, initImage } = require('../sdk/assets');
    const bytes = require('node:fs').readFileSync(file), filename = path.basename(file);
    const mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
    await connect();
    await client.sync.connect();
    const up = await uploadFile(bytes, { filename, mimeType, getAccessToken: (o) => session.getAccessToken(o) });
    const uri = 'tana:image:' + ulid();
    const image = await client.sync.subscribe(uri, (loro) => initImage(loro, { ownerUri: docId, cid: up.cid, width: up.width, height: up.height, blurhash: up.blurhash, filename, mimeType, fileSize: bytes.length }));
    const blockId = require('../sdk/content').insertImage(await client.sync.subscribe(docId), flag('after', null), uri);
    await new Promise((r) => setTimeout(r, 1500)); // let the live updates go out
    out({ upload: up, image: uri, data: image.data.toJSON(), blockId });
  },
  async delete() {
    if (!positional[0]) throw new Error('usage: delete <id>  (document_action soft_delete)');
    await connect();
    await client.sync.connect();
    out(await client.sync.softDelete(positional[0]));
  },
  // The other half of delete: a soft-deleted document keeps everything and comes back by id alone, which is what
  // Cmd+K "Recently deleted" does with the ids the app wrote down.
  async restore() {
    if (!positional[0]) throw new Error('usage: restore <id>  (document_action restore)');
    await connect();
    await client.sync.connect();
    out(await client.sync.restore(positional[0]));
  },
  // Tana archives types (docs/PLATFORM-PROTOCOL.md §2.5): the type leaves every list unless asked for with includeArchived.
  async archive() {
    if (!positional[0]) throw new Error('usage: archive <id>  (document_action archive)');
    await connect();
    await client.sync.connect();
    out(await client.sync.archive(positional[0]));
  },
  async unarchive() {
    if (!positional[0]) throw new Error('usage: unarchive <id>  (document_action unarchive)');
    await connect();
    await client.sync.connect();
    out(await client.sync.unarchive(positional[0]));
  },
  async meetings() {
    const me = await connect();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const { nodes } = await client.graph.listNodes({
      nodeTypes: ['event'], hasParticipantUris: [me.userUri], limit: 200,
      eventStartTimeMin: start.toISOString(), eventStartTimeMax: new Date(start.getTime() + Number(flag('days', 7)) * 864e5).toISOString(),
      sortOptions: [{ field: 'SORT_FIELD_EVENT_START_TIME', direction: 'SORT_DIRECTION_ASCENDING' }],
    });
    const local = (t) => new Date(t).toLocaleString('sv-SE'); // YYYY-MM-DD HH:MM:SS in local time
    const span = (s, e) => ((new Date(e) - new Date(s)) % 864e5 === 0 && new Date(s).getUTCHours() === 0 ? 'all day' : local(s).slice(11, 16) + '–' + local(e).slice(11, 16));
    for (const n of nodes) {
      const ev = n.calendarEvent || {};
      out(n.id + '\t' + local(ev.startTime).slice(0, 10) + ' ' + span(ev.startTime, ev.endTime) + '\t' + (n.title || ''));
    }
    out(nodes.length + ' events');
  },
  async get() {
    if (!positional[0]) throw new Error('usage: get <id>');
    await connect();
    await client.sync.connect();
    const doc = await client.sync.subscribe(positional[0]);
    if (args.includes('--raw')) return out(doc.loro.toJSON()); // every root container, not just data (appearance lives outside it)
    out({ ...readNode(doc), content: contentText(doc) });
  },
  async outline() {
    if (flag('vocab')) { // every block nodeName and text mark across a sample, so the renderer knows what to support
      await connect();
      await client.sync.connect();
      const { nodes } = await client.graph.listNodes({ nodeTypes: ['text'], limit: Number(flag('limit') || 60), sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] });
      const names = new Map(), marks = new Map();
      const walk = (map) => {
        const name = map.get('nodeName');
        names.set(name, (names.get(name) || 0) + 1);
        const kids = map.get('children');
        for (let i = 0; kids && i < kids.length; i++) {
          const child = kids.get(i);
          if (child && child.kind && child.kind() === 'Text') {
            for (const run of child.toDelta()) for (const key of Object.keys(run.attributes || {})) marks.set(key, (marks.get(key) || 0) + 1);
          } else if (child && typeof child.get === 'function') walk(child);
        }
      };
      for (const n of nodes) { try { walk((await client.sync.subscribe(n.id)).content); } catch { /* skip unreadable */ } }
      out('blocks: ' + [...names].map(([k, v]) => k + ' ' + v).join(', '));
      out('marks: ' + ([...marks].map(([k, v]) => k + ' ' + v).join(', ') || 'none'));
      // and what readOutline makes of the same documents: every block type it reports, the marks it carries out
      // on segments, and any document it cannot read at all
      const types = new Map(), segMarks = new Map(), failed = [];
      for (const n of nodes) {
        try {
          const count = (map, key) => map.set(key, (map.get(key) || 0) + 1);
          const visit = (rows) => rows.forEach((r) => {
            count(types, r.block || r.type || 'untyped');
            for (const s of r.segments || []) for (const key of Object.keys(s.marks || {})) count(segMarks, key);
            visit(r.children || []);
          });
          visit(readOutline(await client.sync.subscribe(n.id)));
        } catch (e) { failed.push(n.id + ' ' + ((e && e.message) || e)); }
      }
      out('readOutline blocks: ' + [...types].map(([k, v]) => k + ' ' + v).join(', '));
      out('readOutline marks: ' + ([...segMarks].map(([k, v]) => k + ' ' + v).join(', ') || 'none'));
      return out(failed.length ? 'FAILED: ' + failed.join('; ') : 'readOutline read every document');
    }
    if (flag('raw')) { // raw content tree with text deltas, for learning how marks and block types are stored
      await connect();
      await client.sync.connect();
      const doc = await client.sync.subscribe(positional[0]);
      const walk = (map) => {
        const kids = map.get('children');
        const children = kids && kids.length ? [...Array(kids.length).keys()].map((i) => {
          const child = kids.get(i);
          if (child && typeof child.toDelta === 'function' && child.kind && child.kind() === 'Text') return child.toDelta();
          if (child && typeof child.get === 'function') return walk(child);
          return child;
        }) : [];
        return { nodeName: map.get('nodeName'), attributes: map.get('attributes') && map.get('attributes').toJSON(), children };
      };
      return out(JSON.stringify(walk(doc.content), null, 1));
    }
    if (!positional[0]) throw new Error('usage: outline <id>');
    await connect();
    await client.sync.connect();
    const doc = await client.sync.subscribe(positional[0]);
    out(readNode(doc).title + '  [' + doc.id + ']');
    const tree = (nodes, depth) => nodes.forEach((n) => {
      const pad = '  '.repeat(depth);
      const text = n.type === 'image' ? '[image ' + n.image.uri + ']'
        : n.type === 'reference' ? '[embed ' + n.reference.uri + (n.reference.label ? ' "' + n.reference.label + '"' : '') + ']'
        : n.segments.map((s) => (s.mention ? '[' + s.mention.label + ']' : s.text)).join('');
      out(pad + '• ' + (n.heading ? '#'.repeat(n.heading) + ' ' : '') + text.replace(/\n/g, '\n' + pad + '  ') + '  [' + n.id + ']');
      tree(n.children || [], depth + 1);
    });
    tree(readOutline(doc), 1);
  },
  async watch() {
    if (!positional.length) throw new Error('usage: watch <id...>');
    await connect();
    const log = (...a) => console.log(new Date().toISOString(), ...a);
    for (const ev of ['connected', 'disconnected', 'heartbeat']) client.sync.on(ev, (x) => log(ev, x === undefined ? '' : x));
    client.sync.on('error', (e) => log('error', (e && e.message) || e));
    client.sync.on('change', (id, info) => { const d = client.sync.getDocument(id); log('change', (info || {}).origin, d ? summary(d) : id); });
    await client.sync.connect();
    for (const id of positional) log('subscribed', summary(await client.sync.subscribe(id)));
    await new Promise((resolve) => process.once('SIGINT', resolve));
  },
  async 'set-title'() {
    const [id, title] = positional;
    if (!id || title == null) throw new Error('usage: set-title <id> <title> | set-state <id> <state>');
    await connect();
    await client.sync.connect();
    const doc = await client.sync.subscribe(id);
    setTitle(doc, title);
    await new Promise((r) => setTimeout(r, 1500)); // let the live update go out
    out(summary(doc));
  },
  async 'set-state'() {
    const [id, stateType] = positional;
    if (!id || !stateType) throw new Error('usage: set-state <id> <proposed|open|closed|not_now|workflow state name or id>');
    const me = await connect();
    await client.sync.connect();
    const doc = await client.sync.subscribe(id);
    let state = stateType;
    if (!STATE_TYPES.includes(stateType)) {
      const wf = await workflowOf(doc);
      const column = wf && wf.states.find((s) => s.id === stateType || s.name === stateType);
      if (!column) throw new Error(`${stateType} is not a state of this task's workflow: ${wf ? wf.states.map((s) => s.name).join(', ') : 'it has none'}`);
      state = { workflowUri: wf.uri, workflowStateId: column.id };
    }
    setState(doc, state, me.userUri);
    await new Promise((r) => setTimeout(r, 1500));
    const n = readNode(doc);
    out({ ...summary(doc), stateWorkflowUri: n.stateWorkflowUri, stateWorkflowStateId: n.stateWorkflowStateId });
  },
  // workflow <type or task id>: the type's board columns (tana:workflow: data.states), and a task's column (read-only)
  async workflow() {
    const [id] = positional;
    if (!id) throw new Error('usage: workflow <tana:type:...|task id>');
    await connect();
    await client.sync.connect();
    const doc = await client.sync.subscribe(id);
    const n = readNode(doc);
    out({ ...(await workflowOf(doc)), ...(n.type === 'type' ? {} : { stateType: n.stateType, stateWorkflowStateId: n.stateWorkflowStateId }) });
  },
  // addfield <type uri> <title> [--type member|date|link|options] [--multiple] [--options "A|B"] [--to <type uri>,…]:
  // define a field on a type (sdk/fields.js)
  async addfield() {
    const [typeUri, title] = positional;
    if (!typeUri || !title) throw new Error('usage: addfield <tana:type:...> <title> [--type member|date|link|options] [--multiple] [--options "A|B"] [--to tana:type:...,...]');
    await connect();
    await client.sync.connect();
    const doc = await client.sync.subscribe(typeUri);
    if (doc.data.get('type') !== 'type') throw new Error(typeUri + ' is not a type');
    const sdkFields = require('../sdk/fields');
    const key = sdkFields.addField(doc, { title, type: flag('type') || undefined, cardinality: args.includes('--multiple') ? 'multiple' : 'single',
      options: flag('options') !== undefined ? flag('options').split('|') : undefined, to: flag('to') !== undefined ? flag('to').split(',') : undefined });
    await new Promise((r) => setTimeout(r, 1500)); // let the live update go out
    out(key + ' ' + JSON.stringify(sdkFields.definitions(doc)));
  },
  // set-hue <type uri> <0-360|none>: the type colour Cmd+K writes, through main's own path (appearance root map)
  async 'set-hue'() {
    const [typeUri, value] = positional;
    if (!typeUri || value == null) throw new Error('usage: set-hue <tana:type:...> <0-360|none>');
    const main = backend(await connect());
    await client.sync.connect();
    out(await main.setTypeHue(typeUri, value === 'none' ? null : Number(value)));
    await new Promise((r) => setTimeout(r, 1500)); // let the live update go out
  },
  async pins() {
    const me = await connect();
    await client.sync.connect();
    for (const uri of await pins.listSidebar(client.sync, me.userUri)) {
      const doc = await client.sync.subscribe(uri).catch(() => null);
      out(uri + '\t' + (doc ? readNode(doc).title || '' : '(unavailable)') + (doc && args.includes('--dates') ? '\t' + (await pins.dates(client.sync, me.userUri, uri)).join(',') : ''));
    }
  },
  pin: () => setPin(true),
  unpin: () => setPin(false),
};

// suggestions [--limit 10]: read-only, the people GraphService.ListAttendeeSuggestions offers for a meeting.
commands.suggestions = async () => {
  await connect();
  out(await client.graph.listAttendeeSuggestions({ limit: Number(flag('limit', 10)) }));
};
// meetingedit: WRITES, but only to a scratch meeting it creates and deletes in the same run. Creates it, checks
// canEditEvent, moves it an hour on, sets timezone/location/description, adds this user by profile (no email, so
// nobody is invited), waits for the server, prints what it kept (syncStatus included) and soft-deletes it.
commands.meetingedit = async () => {
  const me = await connect();
  const events = require('../sdk/events'), access = require('../sdk/access');
  await client.sync.connect();
  const id = 'tana:event:' + ulid();
  const doc = await client.sync.subscribe(id, (loro) => initDocument(loro, 'Orbital scratch meeting (delete me)', me.userUri, { kind: 'meeting' }));
  try {
    const ctx = { sync: client.sync, orgDocUri: me.orgDocUri };
    const editable = await access.canEditEvent(doc, me.userUri, ctx);
    const { startTime } = readNode(doc);
    events.setTime(doc, startTime + 36e5, startTime + 54e5);
    events.setTimezone(doc, 'Europe/Amsterdam');
    events.setLocation(doc, 'Scratch room');
    events.setDescription(doc, 'written by platform-cli meetingedit');
    events.addAttendees(doc, [{ userUri: me.userUri }], me.userUri);
    await new Promise((r) => setTimeout(r, Number(flag('settle', 6000))));
    const n = readNode(doc);
    const { nodes: [graph] = [] } = await client.graph.listNodes({ nodeIds: [id], limit: 1 });
    out({ id, editable, data: { startTime: n.startTime, endTime: n.endTime, allDay: n.allDay, timezone: n.timezone, location: n.location, description: n.description, origin: n.origin, syncStatus: n.syncStatus, syncError: n.syncError, participants: n.participants },
      roster: events.attendees(doc), graph: graph && { title: graph.title, calendarEvent: graph.calendarEvent } });
  } finally {
    await client.sync.softDelete(id).catch((e) => out('delete failed: ' + e.message));
    out('deleted ' + id);
  }
};

// datemention [--date 2099-12-31] [--settle ms]: WRITES, but only to a scratch document it creates and deletes in the
// same run. Mentions the date in it (sdk/dates.js), then asks what mentions that date — listEdges and the edge live
// query the sidebar keeps — and prints the outline read back, so the whole date-mention path is checked live.
commands.datemention = async () => {
  const me = await connect();
  const dates = require('../sdk/dates'), { insertMention } = require('../sdk/content'), { openEdgeQuery, EDGE_TYPES } = require('../sdk/livequery');
  await client.sync.connect();
  const uri = dates.dateUri(flag('date', '2099-12-31')), id = 'tana:text:' + ulid();
  const doc = await client.sync.subscribe(id, (loro) => initDocument(loro, 'Orbital scratch date mention (delete me)', me.userUri, { kind: 'doc' }));
  try {
    insertMention(doc, { uri, label: dates.dateLabel(uri) });
    await new Promise((r) => setTimeout(r, Number(flag('settle', 6000))));
    const { edges = [] } = await client.graph.listEdges({ toNodeIds: [uri], edgeTypes: ['EDGE_TYPE_LINKS_TO', 'EDGE_TYPE_ATTRIBUTE_LINKS_TO'] });
    const live = await openEdgeQuery(client.sync, { object: { uris: [uri] }, predicate: { edgeTypes: [EDGE_TYPES.LINKS_TO, EDGE_TYPES.ATTRIBUTE_LINKS_TO] } }, { label: 'orbital probe' });
    const initial = await new Promise((resolve) => { live.on('rows', (r) => resolve(r.added)); live.on('error', (e) => resolve('error: ' + e.message)); setTimeout(() => resolve('no answer in 15 s'), 15000); });
    await live.close();
    out({ id, uri, outline: readOutline(doc).map((n) => n.segments), listEdges: edges.map((e) => ({ from: e.fromNodeId, type: e.type, properties: e.properties })), liveQuery: Array.isArray(initial) ? initial.map((e) => ({ from: e.fromNode, type: e.type })) : initial });
  } finally {
    await client.sync.softDelete(id).catch((e) => out('delete failed: ' + e.message));
    out('deleted ' + id);
  }
};

// Real main-process code paths against real data, read-only: exactly what the renderer receives.
function backend(me) {
  process.env.TANA_MAIN_TEST = '1';
  require('../db').open(path.join(app.getPath('temp'), 'tana-cli-check.sqlite'));
  const main = require('../main');
  main.testRuntime({ client, me, win: null, session });
  return main;
}
// assignee [<user-profile uri>]: read-only audit of the Library's per-kind queries. Prints what each kind asks the
// graph for and how many of the rows it returns are actually assigned to that person, which is how an unfiltered
// kind shows up (nodes 40, assigned 0).
commands.assignee = async () => {
  const me = await connect();
  const who = positional[0] || me.userUri;
  const { nodes: profiles } = await client.graph.listNodes({ nodeTypes: ['user-profile'], limit: 200 });
  const named = profiles.find((p) => p.id === who || (p.title || '').toLowerCase().includes(String(who).toLowerCase()));
  const uri = named ? named.id : who;
  out('assignee ' + uri + ' ' + ((named && named.title) || ''));
  const kinds = query.VIEW_KINDS.filter((k) => k !== 'people' && k !== 'spaces');
  for (const kind of kinds) { // one kind at a time, through the view builder: the assignee applies only when tasks are among the kinds
    const params = query.viewParams({ types: [kind], states: null, assignee: uri }, me.userUri);
    const { nodes } = await client.graph.listNodes(params);
    const mine = nodes.filter((n) => (n.assignedTo || []).includes(uri));
    out(kind.padEnd(10) + ' sends=' + JSON.stringify({ ...params, sortOptions: undefined, limit: undefined, mode: undefined }) + ' nodes=' + nodes.length + ' assigned=' + mine.length);
  }
  const { nodes: tasks } = await client.graph.listNodes(query.viewParams({ types: ['tasks'], states: null, assignee: uri }, me.userUri));
  out('Tasks view (all states) = ' + tasks.length + ', of those assigned = ' + tasks.filter((n) => (n.assignedTo || []).includes(uri)).length);
  out('-- direct per-node-type probes: which node types the graph filters by assignedTo / unassigned --');
  for (const kind of kinds) {
    const params = { nodeTypes: [query.KIND_NODE_TYPE[kind]], assignedTo: [uri], limit: 100 }; // the SDK's one table: a copy here had no searches or types (#249)
    try {
      const { nodes } = await client.graph.listNodes(params);
      const { assignedTo, ...rest } = params; // the proto encoder rejects an undefined repeated field, so drop the key
      const un = await client.graph.listNodes({ ...rest, unassigned: true });
      out(kind.padEnd(10) + ' assignedTo -> nodes=' + nodes.length + ' really assigned=' + nodes.filter((n) => (n.assignedTo || []).includes(uri)).length + ' | unassigned -> nodes=' + un.nodes.length);
    } catch (e) { out(kind.padEnd(10) + ' rejected: ' + ((e && e.message) || e)); }
  }
};

// calls [--days 14] [--limit 6]: read-only check of the call link the meeting hub hands the sidebar. Prints the raw
// calendar location beside related().call, so a Tana Meet, a Google Meet and a room-only meeting can be compared.
commands.calls = async () => {
  const { callOf } = require('../sdk/events');
  const main = backend(await connect());
  await client.sync.connect(); // related() reads the zoomed node's fields, which needs a subscription
  if (positional[0]) { const { call } = await main.related(positional[0]); return out('related(' + positional[0] + ').call = ' + JSON.stringify(call)); }
  const days = Number(flag('days', 14)), now = Date.now();
  const { nodes } = await client.graph.listNodes({ nodeTypes: ['event'], eventStartTimeMin: new Date(now - days * 864e5).toISOString(), eventStartTimeMax: new Date(now + days * 864e5).toISOString(), limit: 300 });
  const withLocation = nodes.filter((n) => (n.calendarEvent || {}).location);
  out(withLocation.length + ' of ' + nodes.length + ' events carry a location');
  const hosts = new Map();
  for (const n of withLocation) { const c = callOf(n.calendarEvent); const key = c ? c.label.split('/')[0] : 'no link (room or address)'; hosts.set(key, (hosts.get(key) || 0) + 1); }
  out([...hosts].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(', '));
  // events an online meeting only through the provider action: the location names a room, the join url is elsewhere
  const hidden = nodes.filter((n) => (n.calendarEvent || {}).actionUrl && !/https?:\/\//i.test(n.calendarEvent.location || ''));
  out('events with a join link only in calendarEvent.actionUrl: ' + hidden.length);
  const actionHosts = new Map();
  for (const n of hidden) { let h = 'unparsable'; try { h = new URL(n.calendarEvent.actionUrl).host; } catch { /* keep */ } actionHosts.set(h, (actionHosts.get(h) || 0) + 1); }
  out('  actionUrl hosts: ' + [...actionHosts].map(([k, v]) => k + ' ' + v).join(', '));
  for (const n of nodes.filter((n) => /meet\.google\.com|meet\.tana\.inc/i.test((n.calendarEvent || {}).location || '')).slice(0, 3)) out('  link     ' + n.id + ' ' + (n.title || '').slice(0, 22).padEnd(24) + JSON.stringify((await main.related(n.id)).call));
  for (const n of withLocation.slice(0, Number(flag('limit', 6)))) {
    const { call } = await main.related(n.id);
    out((n.title || '').slice(0, 34).padEnd(36) + 'location=' + JSON.stringify(n.calendarEvent.location) + ' call=' + JSON.stringify(call));
  }
};

commands.refs = async () => {
  if (!positional[0]) throw new Error('usage: refs <id>');
  const main = backend(await connect());
  await client.sync.connect();
  const rows = await main.outlineWithReferences(await client.sync.subscribe(positional[0]));
  const found = [];
  const visit = (ns) => ns.forEach((n) => {
    if (n.type === 'reference') found.push({ block: n.id, uri: n.reference.uri, label: n.reference.label, resolved: n.reference.node || null });
    visit(n.children || []);
  });
  visit(rows);
  out(found.length ? found : 'no embed blocks in ' + positional[0]);
};
commands.rows = async () => {
  if (!positional.length) throw new Error('usage: rows <search query>  (Nodes exactly as the renderer receives them)');
  const main = backend(await connect());
  out(await main.search(positional.join(' ')));
};
// children <id>: a document's outline rows as main hands them to the renderer: readOutline with the references
// resolved, as outline:children does for a document (main/documents.js outlineWithReferences), minus the block ids that
// helper writes onto blocks arriving without one, so this stays read-only. Each row's depth, id, kind, checkbox and
// text. Chats, spaces and saved searches take other routes in outline:children (main.js) and are refused here.
commands.children = async () => {
  const id = positional[0];
  if (!id || /^tana:(chat|space|search):/.test(id)) throw new Error('usage: children <document id>  (a document\'s outline rows, read-only; not a chat, space or saved search)');
  const main = backend(await connect());
  await client.sync.connect();
  const { resolveReferences } = require('../main/documents');
  const walk = (rows, depth = 0) => rows.flatMap((n) => [[depth, n.id, n.block || n.type || n.kind, n.done ?? '-', String(n.text || '').slice(0, 60)].join('  '), ...walk(n.children || [], depth + 1)]);
  out(walk(await main.op(id, (doc) => (doc.content.get('children') ? resolveReferences(readOutline(doc)) : []))).join('\n'));
};
// settings [<key> <json>]: the app's own settings document (main/settings.js) — which document it is and what it
// carries. Read-only without arguments; with a key and a JSON value it writes one setting the way the app does.
commands.settings = async () => {
  const main = backend(await connect());
  await client.sync.connect();
  const hydrated = await main.settings.hydrate().catch((e) => { out('hydrate failed: ' + (e && e.message || e)); return null; });
  if (hydrated === null) out('status: ' + JSON.stringify(main.statusSnapshot()));
  const [key, value] = positional;
  if (key) { main.settings.set(key, value === undefined ? undefined : JSON.parse(value)); await main.settings.flush(); }
  out('document: ' + (main.settings.settingsDocId() || 'none'));
  for (const [k, v] of Object.entries(main.settings.synced()).sort()) out('  ' + k + ' = ' + JSON.stringify(v).slice(0, 120));
  await new Promise((r) => setTimeout(r, 1500)); // whatever opening wrote — the explanatory line, a pushed setting — leaves with the stream
};
// settype <id> [<tana:type:…|none>]: the Cmd+K "Set type" command through main's own rules. With no target it only
// lists what the document may be given and why the rest is out (read-only); with one it writes, which is a WRITE.
commands.settype = async () => {
  const [id, target] = positional;
  if (!id) throw new Error('usage: settype <id> [<tana:type:...|none>]  (listing is read-only; a target WRITES)');
  const main = backend(await connect());
  await client.sync.connect();
  const choices = await main.typeChoices(id);
  out('current: ' + (choices.current || 'no type'));
  for (const o of choices.options) out((o.selectable ? '  ' : '✗ ') + o.uri + '\t' + o.title + (o.reason ? '\t' + o.reason : ''));
  if (!target) return;
  await main.setType(id, target === 'none' ? null : target);
  await new Promise((r) => setTimeout(r, 1500)); // the local update leaves with the stream, like the other write commands
  out('now: ' + JSON.stringify(readNode(await client.sync.subscribe(id)).entityTypeUri ?? null));
};
// classify <id...>: the Cmd+K "Auto-pick type" answer for each document — what the model is sent (the types with their
// description and AI instructions) and the odds it gives each. Read-only in Tana; the documents' text goes to the model.
commands.classify = async () => {
  if (!positional.length) throw new Error('usage: classify <id...>  (read-only; sends each document and its candidate types to the model)');
  const main = backend(await connect());
  await client.sync.connect();
  for (const id of positional) {
    const input = await main.typeCandidates(id);
    const { current, choices } = await main.ai.classifyType(input, globalThis.fetch, app.getPath('userData'));
    out(id + '  ' + input.title + '  (now: ' + (input.types.find((t) => t.uri === current)?.title || (current ? current : 'no type')) + ')');
    out('   ' + choices.map((c) => c.title + ' ' + Math.round(c.p * 100) + '%').join(', '));
  }
};
// chatsend <chat id|new> <text…> [--attach <uri>]: send a message the way the chat page does (--attach: a skill to run, as "/" in the composer attaches one; main/documents.js chat:new, chat:send) and
// readimage <file>: what Process image (issue #507) reads from an image — the kind, title and lines the task or note
// would get — and how long the model took. Read-only in Tana; the image goes to the model.
commands.readimage = async () => {
  const file = positional[0], mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(file || '').toLowerCase()];
  if (!file) throw new Error('usage: readimage <file>  (read-only; sends the image to the model)');
  const main = backend(await connect());
  await client.sync.connect();
  const status = await main.ai.chatgptStatus(app.getPath('userData'), true);
  out('ChatGPT: ' + (status.signedIn ? 'signed in' : 'not signed in' + (status.error ? ' (' + status.error + ')' : '')));
  const started = Date.now(), read = await main.ai.readImage({ bytes: require('node:fs').readFileSync(file), mimeType }, globalThis.fetch, app.getPath('userData'));
  out(read); out((Date.now() - started) + ' ms');
};
// translate [--to English] [--model m] [--effort e] [--fresh] [text…] (--fresh: past the cache): what Auto-translate (issue #547) gets back and how long the model takes, for one text
// and then all of them as one batch (the Dutch sample note when no text is given). Read-only; the texts go to the model.
commands.translate = async () => {
  const texts = positional.length ? positional : ['We hebben besloten om Studio als werkwijze te behandelen, niet als entiteit.', 'Twee pilots starten in oktober, met Sam en Dana als trekkers.', 'Open vraag: wie beheert het budget na Q1?', 'Terugblik offsite Studio'];
  const main = backend(await connect()), to = flag('to') || 'English', userData = app.getPath('userData');
  let t = Date.now(); const status = await main.ai.chatgptStatus(userData, true);
  out('ChatGPT: ' + (status.signedIn ? 'signed in' : 'not signed in' + (status.error ? ' (' + status.error + ')' : '')) + ', sign-in check with refresh ' + (Date.now() - t) + ' ms');
  t = Date.now(); await main.ai.chatgptStatus(userData, false); out('sign-in check without refresh ' + (Date.now() - t) + ' ms');
  for (const batch of [texts.slice(0, 1), texts]) {
    const started = Date.now(), answers = await main.ai.translate(batch, to, globalThis.fetch, userData, { model: flag('model') || undefined, effort: flag('effort') || undefined, fresh: !!flag('fresh') });
    out(batch.length + (batch.length === 1 ? ' text: ' : ' texts: ') + (Date.now() - started) + ' ms');
    answers.forEach((a, i) => out('  ' + (a ? a.lang + ' → ' + a.text : 'unchanged: ' + batch[i])));
  }
};
// print the conversation once Tana's answer has finished streaming (docs/CHATS.md §10). WRITES: a message, and a new
// chat with "new".
commands.chatsend = async () => {
  const [target, ...rest] = positional;
  const text = rest.join(' ');
  if (!target || !text) throw new Error('usage: chatsend <chat id|new> <text…>  (WRITES: a message in the chat, which Tana answers)');
  backend(await connect());
  await client.sync.connect();
  const { ipc } = require('../main/documents');
  const id = target === 'new' ? (await ipc['chat:new']()).id : target;
  out('chat ' + id);
  const sent = await ipc['chat:send'](null, id, text, flag('attach') ? [flag('attach')] : []);
  out(sent);
  const doc = await client.sync.subscribe(id);
  // Tana's finished answer after the message just sent, wherever it is: in a group chat somebody may write after it
  const done = () => { const ms = doc.data.toJSON().messages || [], at = ms.findIndex((m) => m.id === sent.messageId); return at >= 0 && ms.slice(at + 1).some((m) => m.fromUserType === 'ai' && m.completedAt); };
  for (let s = 0; sent.responding && s < 120 && !done(); s++) await new Promise((r) => setTimeout(r, 1000)); // up to two minutes for an answer asked for
  const d = doc.data.toJSON();
  out({ title: d.title, titleAutoGenerated: d.titleAutoGenerated, answered: !!done() });
  for (const m of d.messages || []) out((m.hiddenFromChat ? '(hidden) ' : '') + m.fromUserType + ': ' + ((m.content && m.content.text) || '').slice(0, 400));
};

// chatanswer <chat id> <option label…> [--custom <text>] | --skip: answer the questions Tana is waiting on in a chat the
// way the question card does (main/documents.js chat:answer; the first question gets the options named, any others
// none), and print the conversation once Tana has gone on (docs/CHATS.md §11). WRITES.
commands.chatanswer = async () => {
  const [id, ...labels] = positional;
  if (!id) throw new Error('usage: chatanswer <chat id> <option label…> [--custom <text>] | --skip  (WRITES)');
  backend(await connect());
  await client.sync.connect();
  const { ipc } = require('../main/documents');
  const chatSdk = require('../sdk/chat');
  const doc = await client.sync.subscribe(id);
  const asking = (doc.data.get('messages').toJSON() || []).map(chatSdk.pendingQuestions).filter(Boolean).at(-1);
  if (!asking) throw new Error('Tana is not waiting on any questions in ' + id);
  out(asking);
  const first = asking.items[0];
  const answers = args.includes('--skip') ? null : { [first.id]: { selected: labels.length ? [labels.join(' ')] : [], custom: flag('custom') || '' } };
  const sent = await ipc['chat:answer'](null, id, asking.messageId, answers);
  out(sent);
  const done = () => { const ms = doc.data.toJSON().messages || [], at = ms.findIndex((m) => m.id === sent.messageId); return at >= 0 && ms.slice(at + 1).some((m) => m.fromUserType === 'ai' && m.completedAt); };
  for (let s = 0; sent.responding && s < 120 && !done(); s++) await new Promise((r) => setTimeout(r, 1000));
  const asked = (doc.data.get('messages').toJSON() || []).find((m) => m.id === asking.messageId);
  out({ answered: asked.questionsData.answered, skipped: asked.questionsData.skipped, tool: asked.toolCalls.find((c) => c.name === 'askUserQuestion').status, replied: !!done() });
  for (const m of doc.data.toJSON().messages || []) out((m.hiddenFromChat ? '(hidden) ' : m.isAIInterviewRelay ? '(relay) ' : '') + m.fromUserType + ': ' + ((m.content && m.content.text) || '').slice(0, 300));
};

// discusswith <id> <who…>: the Cmd+K "Discuss with …" command through main — the Discussion Task type (found by
// title, or created in the Library with its field when the workspace has none) and the name in that field. WRITES.
commands.discusswith = async () => {
  const [id, ...rest] = positional;
  const who = rest.join(' ');
  if (!id || !who) throw new Error('usage: discusswith <id> <who…>  (WRITES: types the document and fills its field)');
  const main = backend(await connect());
  await client.sync.connect();
  out(await main.discussWith(id, who));
  await new Promise((r) => setTimeout(r, 1500)); // the local update leaves with the stream, like the other write commands
  const doc = await client.sync.subscribe(id);
  out('type: ' + (readNode(doc).entityTypeUri || 'none'));
  out(require('../sdk/fields').readFields(doc));
};
// setstate <state> <id…>: Set status through main, for one task or several — proposed, open, closed, not_now, or waiting
// (the Waiting workflow, made on first use and kept in the settings document, main/documents.js waitingState). WRITES.
commands.setstate = async () => {
  const [state, ...ids] = positional;
  if (!state || !ids.length) throw new Error('usage: setstate <proposed|open|closed|not_now|waiting> <id…>  (WRITES)');
  const main = backend(await connect());
  await client.sync.connect();
  await main.settings.hydrate(); // the Waiting workflow another machine made, before one is made here
  out(await require('../main/documents').ipc['doc:setStateMany'](null, ids, state) + ' changed');
  await main.settings.flush();
  await new Promise((r) => setTimeout(r, 1500)); // the local updates leave with the stream
  out('waiting: ' + JSON.stringify(main.settings.get('waiting') || null));
  for (const id of ids) { const doc = await client.sync.subscribe(id); out({ id, ...(await workflowOf(doc)), stateType: readNode(doc).stateType, stateWorkflowStateId: readNode(doc).stateWorkflowStateId }); }
};
// setfield <id> <type-uri?attribute=key> <line…>: write a field value, one argument per line, the way the page's
// field editor does (sdk/fields.js). A line written as "- words" is a bullet, as typing "- " in the page makes one.
// A line written as "[label](tana:…)" is a reference. The value is checked against the field's definition first, as
// Tana does (options, cardinality, link targets), and a refusal writes nothing. WRITES.
commands.setfield = async () => {
  const [id, key, ...lines] = positional;
  if (!id || !key || !lines.length) throw new Error('usage: setfield <id> <tana:type:...?attribute=key> <line> [<line>...]  (WRITES)');
  const main = backend(await connect());
  await client.sync.connect();
  const sdkFields = require('../sdk/fields');
  const { typeUri, attribute } = sdkFields.parseKey(key);
  const field = sdkFields.fieldDefinition(await client.sync.subscribe(typeUri), attribute);
  const ref = (line) => { const m = /^\[(.*)\]\((tana:[^)]+)\)$/.exec(line); return m ? [{ mention: { label: m[1], uri: m[2] } }] : line; };
  const value = lines.map((line) => (line.startsWith('- ') ? { segments: ref(line.slice(2)), block: 'bullet' } : { segments: ref(line), block: 'paragraph' }));
  const types = {}; // what each referenced document is typed as, for the link-target check
  for (const line of value) for (const s of Array.isArray(line.segments) ? line.segments : []) types[s.mention.uri] = (await client.sync.subscribe(s.mention.uri)).data.get('entityTypeUri');
  await main.op(id, (doc) => sdkFields.setFieldText(doc, key, value, { field, typeOf: (uri) => types[uri] }));
  await new Promise((r) => setTimeout(r, 1500)); // the local update leaves with the stream, like the other write commands
  out(sdkFields.readFields(await client.sync.subscribe(id)));
};
// libraryprobe: one cold Library load through main.js, including conversion to the exact IPC payload.
commands.libraryprobe = async () => {
  const me = await connect();
  const calls = [], listNodes = client.graph.listNodes.bind(client.graph);
  client.graph.listNodes = async (params) => {
    const result = await listNodes(params);
    if (params.mode === 'LIST_NODES_MODE_WITH_COUNT' && params.nodeTypes?.length === 1) {
      calls.push({ nodeType: params.nodeTypes[0], limit: params.limit, returned: result.nodes.length, totalCount: result.totalCount });
    }
    return result;
  };
  const main = backend(me);
  const filter = { types: null, states: null, assignee: 'anyone', text: '' }; // every listable kind, nothing narrowed
  const started = Date.now();
  const payload = await main.viewRows('library', filter);
  const nodes = Array.isArray(payload) ? payload : payload.nodes;
  out({ ms: Date.now() - started, bytes: Buffer.byteLength(JSON.stringify(payload)), nodes: nodes.length,
    truncated: Array.isArray(payload) ? undefined : payload.truncated, calls });
};
// chatlist [--limit 200] [--owned]: every chat newest first with its invocationContext. search() has no chat kind
// (query.js searchParams lists text/event/user-profile only), so this is how a chat is found by title. --owned adds the
// chats that live on something (a meeting, a chat, an action), which the graph leaves out unless asked (docs/CHATS.md).
// listkind <nodeType> [--limit 50]: does the graph answer for a kind we have never listed? nodeTypes is a free-form
// listnodes '<ListNodesRequest json>': the graph's raw answer, one node per line (id, title, attributes). Read-only.
commands.listnodes = async () => {
  await connect();
  const { nodes, totalCount } = await client.graph.listNodes({ limit: 50, mode: 'LIST_NODES_MODE_WITH_COUNT', ...JSON.parse(positional[0] || '{}') });
  for (const n of nodes) out(flag('full') ? JSON.stringify(n) : n.id + '\t' + JSON.stringify(n.title || '') + '\t' + JSON.stringify(n.attributes || {})); // --full 1: the whole node
  out(nodes.length + ' nodes (totalCount ' + totalCount + ')');
};
// string list on the wire (scalar, not an enum — fromJson accepts any string, including nonsense), so asking the
// server is the only way to learn what a kind string actually returns. Read-only.
commands.listkind = async () => {
  if (!positional[0]) throw new Error('usage: listkind <nodeType> [--limit 50]  (e.g. listkind search)');
  await connect();
  const { nodes, totalCount } = await client.graph.listNodes({
    nodeTypes: [positional[0]], limit: Number(flag('limit', 50)), mode: 'LIST_NODES_MODE_WITH_COUNT',
    sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }],
  });
  for (const n of nodes) out(n.id + '\t' + JSON.stringify(n.title || '') + '\towner=' + (n.ownerUri || '-'));
  out(nodes.length + ' nodes of kind ' + JSON.stringify(positional[0]) + (totalCount === undefined ? '' : ' (totalCount ' + totalCount + ')'));
};
commands.chatlist = async () => {
  await connect();
  const { nodes } = await client.graph.listNodes({ nodeTypes: ['chat'], includeOwnedChats: args.includes('--owned'), limit: Number(flag('limit', 200)), sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] });
  for (const n of nodes) out(n.id + '\t' + JSON.stringify(n.title || '') + '\t' + JSON.stringify(n.invocationContext || {}) + '\towner=' + (n.ownerUri || '-'));
  out(nodes.length + ' chats');
};
// proposals [--limit 500] [--detail] [--rows]: the AI proposals waiting on someone (sdk/proposals.js), newest first, from
// the chat graph nodes; --detail opens each chat and its proposed document and prints what approve would decide from,
// --rows prints the Proposals page as main/proposals.js builds it. Read-only. approve / reject <chat id> <proposed id>
// are the writes (below, under WRITES).
commands.proposals = async () => {
  const me = await connect();
  if (args.includes('--rows')) {
    process.env.TANA_MAIN_TEST = '1';
    require('../db').open(path.join(app.getPath('temp'), 'tana-cli-proposals.sqlite'));
    require('../main').testRuntime({ session, client, me, win: null });
    const started = Date.now(), rows = await require('../main/proposals').rows();
    for (const r of rows) out([r.proposal.group, r.proposal.approvable ? 'approve' : 'in Tana', r.icon, r.id, JSON.stringify(r.text), r.proposal.note].join('\t'));
    return out(rows.length + ' rows in ' + (Date.now() - started) + ' ms');
  }
  const proposals = require('../sdk/proposals');
  const list = await proposals.pending(client.graph, { limit: Number(flag('limit', 500)) });
  const counts = {};
  for (const p of list) counts[p.operation + '/' + p.kind] = (counts[p.operation + '/' + p.kind] || 0) + 1;
  if (args.includes('--detail')) await client.sync.connect();
  for (const p of list) {
    out(new Date(p.proposedAt).toISOString().slice(0, 16) + '\t' + p.operation + '/' + p.kind + '\t' + p.proposedUri + (p.baseUri ? ' -> ' + p.baseUri : '') + '\tin ' + p.chatUri + ' ' + JSON.stringify(p.chatTitle));
    if (!args.includes('--detail')) continue;
    const chat = await client.sync.subscribe(p.chatUri);
    const e = proposals.entries(chat).filter((x) => x.p.proposedUri === p.proposedUri).map((x) => x.p);
    const doc = await client.sync.subscribe(p.proposedUri).catch((err) => ({ error: err.message }));
    const d = doc.data ? doc.data.toJSON() : doc;
    out('\t\tentries ' + JSON.stringify(e.map((x) => ({ op: x.operation, at: x.proposedAt, approvedAt: x.approvedAt, rejectedAt: x.rejectedAt, metadata: x.metadata, iteration: x.iterationChatUri }))));
    out('\t\tdoc ' + JSON.stringify({ title: d.title, isProposal: d.isProposal, ownerUri: d.ownerUri, entityTypeUri: d.entityTypeUri, stateType: d.stateType, deletedAt: d.deletedAt, createdInUri: d.createdInUri, error: d.error })
      + '\trefusal ' + JSON.stringify(e.length ? proposals.refusal(e.sort((a, b) => b.proposedAt - a.proposedAt)[0]) : 'no chat entry'));
  }
  out(list.length + ' pending ' + JSON.stringify(counts) + ' for ' + (me.displayName || me.userUri));
};
// approve / reject <chat id> <proposed id>: accept or turn down one pending proposal as Tana does (sdk/proposals.js).
// WRITES: approve takes the document out of proposal and posts "accepted 1 change" in the chat; reject removes the
// proposal from the chat and soft-deletes the document it proposed.
for (const action of ['approve', 'reject']) {
  commands[action] = async () => {
    const me = await connect();
    await client.sync.connect();
    const [chatUri, proposedUri] = positional;
    if (!chatUri || !proposedUri) throw new Error('usage: ' + action + ' <chat id> <proposed id>');
    out(await require('../sdk/proposals')[action](client.sync, { chatUri, proposedUri, byUri: me.userUri }));
    await new Promise((r) => setTimeout(r, 1500)); // let the live updates go out
  };
}
// proposalcycle: a scratch chat proposing two new scratch documents, one approved and one rejected through
// sdk/proposals.js, each step read back from the graph (what the Proposals page lists) and from a fresh bootstrap (what
// Tana's own client will read), then all of it deleted. WRITES scratch documents only.
commands.proposalcycle = async () => {
  const me = await connect();
  await client.sync.connect();
  const proposals = require('../sdk/proposals');
  const { LoroMap, LoroList, LoroText } = require('loro-crdt');
  const chatUri = 'tana:chat:' + ulid(), keep = 'tana:text:' + ulid(), drop = 'tana:text:' + ulid();
  for (const [uri, title, kind] of [[keep, 'Orbital scratch: approve me', 'task'], [drop, 'Orbital scratch: reject me', 'doc']]) {
    await client.sync.subscribe(uri, (l) => { initDocument(l, title, me.userUri, { kind }); l.getMap('data').set('isProposal', true); });
  }
  await client.sync.subscribe(chatUri, (l) => {
    initDocument(l, 'Orbital scratch proposals', me.userUri, { kind: 'chat' });
    const m = l.getMap('data').get('messages').insertContainer(0, new LoroMap());
    for (const [k, v] of Object.entries({ id: 'orbscr01', type: 'message', fromUserType: 'ai', sentAt: Date.now(), completedAt: Date.now() })) m.set(k, v);
    m.setContainer('content', new LoroMap()).setContainer('text', new LoroText()).insert(0, 'Two scratch proposals from Orbital\'s proposalcycle.');
    const list = m.setContainer('proposals', new LoroList());
    for (const uri of [keep, drop]) {
      const p = list.insertContainer(list.length, new LoroMap());
      p.set('operation', 'create'); p.set('proposedUri', uri); p.set('proposedAt', Date.now());
      p.setContainer('metadata', new LoroMap()).set('intents', '[{"type":"reown-embedded-media","family":"media"}]');
    }
  });
  // what the chat's graph node says, polled until it says what is expected (the index trails the write by seconds)
  const graph = async (want) => {
    for (let i = 0; ; i++) {
      const { nodes } = await client.graph.listNodes({ nodeIds: [chatUri], limit: 1 });
      const seen = ((nodes[0] && nodes[0].chat && nodes[0].chat.proposals) || []).map((p) => p.proposedUri.slice(-6) + ':' + p.status).sort().join(' ');
      if (seen === want || i >= 30) return seen + ' after ' + i + 's';
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  const fresh = async (uri) => { await client.sync.unsubscribe(uri); return (await client.sync.subscribe(uri)).data.toJSON(); };
  const listed = async () => (await proposals.pending(client.graph)).filter((p) => p.chatUri === chatUri).map((p) => p.proposedUri.slice(-6)).sort().join(' ');
  try {
    out({ step: 'proposed', graph: await graph([keep, drop].map((u) => u.slice(-6) + ':pending').sort().join(' ')), pendingLists: await listed() });
    out({ step: 'approve', result: await proposals.approve(client.sync, { chatUri, proposedUri: keep, byUri: me.userUri }) });
    out({ step: 'reject', result: await proposals.reject(client.sync, { chatUri, proposedUri: drop }) });
    await new Promise((r) => setTimeout(r, 1500)); // let the live updates go out before reading back
    out({ step: 'graph after', graph: await graph(keep.slice(-6) + ':approved'), pendingLists: await listed() });
    const k = await fresh(keep), c = await fresh(chatUri), last = c.messages.at(-1);
    out({ step: 'fresh read', approved: { isProposal: k.isProposal, createdInUri: k.createdInUri === chatUri },
      chatEntries: c.messages[0].proposals.map((p) => ({ uri: p.proposedUri.slice(-6), approvedAt: !!p.approvedAt })),
      status: { text: last.content.text, attachments: last.attachmentUris, by: last.fromUserUri === me.userUri, isStatusUpdate: last.isStatusUpdate } });
    out({ step: 'rejected draft', read: await fresh(drop).then((d) => ({ deletedAt: d.deletedAt }), (e) => e.message) });
  } finally {
    for (const uri of [keep, chatUri]) await client.sync.softDelete(uri).then(() => out('deleted ' + uri), (e) => out('could not delete ' + uri + ': ' + e.message));
  }
};


// rawdoc <id>: the complete Loro document JSON — every root container, not just data + content. For learning an
// undocumented schema (chats). Read-only: bootstrap carries no local ops.
// inbox [--limit 20] [--watch seconds]: your notifications (sdk/inbox.js), newest first, as Tana phrases them, with the
// unread count and how many of each kind; --watch prints the count again on every live change. Read-only.
commands.inbox = async () => {
  const me = await connect();
  await client.sync.connect();
  const inbox = require('../sdk/inbox');
  const doc = await inbox.open(client.sync, me.userUri);
  const all = inbox.items(doc), kinds = {};
  for (const n of all) kinds[n.notificationType] = (kinds[n.notificationType] || 0) + 1;
  out({ uri: doc.id, roots: Object.keys(doc.toJSON()), count: all.length, unread: inbox.unreadCount(doc), updatedAt: doc.data.get('updatedAt'), kinds,
    keys: [...new Set(all.flatMap((n) => Object.keys(n)))].sort() });
  for (const n of all.slice(0, Number(flag('limit', 20)))) {
    const words = inbox.phrase(n, n.actorUri ? '@' + n.actorUri.slice(-6) : undefined).map((p) => p.text).join('') + (inbox.detail(n) ? '. ' + inbox.detail(n) + '.' : '');
    out((n.readAt ? '  ' : '* ') + new Date(n.createdAt).toISOString().slice(0, 16) + '  ' + n.notificationType.padEnd(16) + words.slice(0, 110) + '  -> ' + n.sourceUri);
  }
  if (!flag('watch')) return;
  doc.on('change', ({ origin }) => out('change/' + origin + '  unread ' + inbox.unreadCount(doc) + ' of ' + inbox.items(doc).length));
  await new Promise((r) => setTimeout(r, Number(flag('watch')) * 1000));
};
commands.rawdoc = async () => {
  if (!positional[0]) throw new Error('usage: rawdoc <id>');
  await connect();
  await client.sync.connect();
  const doc = await client.sync.subscribe(positional[0]);
  // --containers 1: same tree, but every container is named by its kind and text keeps its marks (toJSON drops them).
  if (flag('containers')) {
    const dump = (v) => {
      if (!v || typeof v.kind !== 'function') return v;
      const kind = v.kind();
      if (kind === 'Text') return { '@Text': v.toDelta() };
      if (kind === 'Map') return { '@Map': Object.fromEntries(v.keys().map((k) => [k, dump(v.get(k))])) };
      if (kind === 'List' || kind === 'MovableList') return { ['@' + kind]: [...Array(v.length).keys()].map((i) => dump(v.get(i))) };
      return { ['@' + kind]: v.toJSON() };
    };
    const json = doc.loro.toJSON(); // the only public listing of root containers
    const roots = {};
    // getShallowValue names every root with its real container type ("cid:root-pinnedItems:MovableList"); getMap(key)
    // silently hands back a fresh empty map for a non-map root, which used to print pinnedItems as {"@Map":{}}.
    for (const [key, cid] of Object.entries(doc.loro.getShallowValue())) {
      const container = doc.loro.getContainerById(cid);
      roots[key] = container ? dump(container) : json[key];
    }
    return out(JSON.stringify(roots, null, 1));
  }
  out(JSON.stringify(doc.toJSON(), null, 1));
};
// incall: the meeting the signed-in user is in *right now*, through sdk/calls.js — an entry in the call document's
// `sessions` root is the only server-side proof of "joined"; the event node proves invitation and schedule, never
// attendance (docs/MEETINGS.md). Read-only.
commands.incall = async () => {
  const me = await connect();
  await client.sync.connect();
  const limit = Number(flag('limit', 5));
  const live = await require('../sdk/calls').currentCalls(client, me.userUri, { limit });
  out(live.length ? live.map((c) => ({ ...c, joinedAt: c.joinedAt && new Date(c.joinedAt).toLocaleString('sv-SE') }))
    : 'not in a call (checked the ' + limit + ' most recently updated call documents)');
};
// callstate <tana:call:…>: what the call left behind (sdk/calls.js callState) and its transcript as readTranscript reads
// it — counts, whether the segments came back in time order, and the section labels Tana shows. Read-only.
commands.callstate = async () => {
  if (!positional[0]) throw new Error('usage: callstate <tana:call:…>');
  await connect();
  await client.sync.connect();
  const calls = require('../sdk/calls');
  const doc = await client.sync.subscribe(positional[0]), { transcriptUri } = calls.callSessions(doc);
  const t = transcriptUri ? calls.readTranscript(await client.sync.subscribe(transcriptUri)) : null;
  out({ ...calls.callState(doc), transcript: t && { uri: transcriptUri, segments: t.segments.length, inTimeOrder: t.segments.every((s, i) => !i || t.segments[i - 1].start_sec <= s.start_sec),
    summary: t.summary.length + ' characters', sections: t.sections.map((s) => s.label + (s.children.length ? ' (' + s.children.length + ' parts)' : '')) } });
};
// Sidebar pins as the renderer receives them: the only path where spaces reach a row (#63).
commands.pinrows = async () => {
  const main = backend(await connect());
  await client.sync.connect();
  out(await main.pinTree());
};
// related <id>: exactly what the sidebar receives for a zoomed node (pinHub, pinned, outcomes, notes, fields).
commands.related = async () => {
  if (!positional[0]) throw new Error('usage: related <id>');
  const main = backend(await connect());
  await client.sync.connect();
  out(await main.related(positional[0]));
};
// caps <id...>: the access capabilities the app computes for a node — what the sidebar visibility row and the
// Cmd+K "Edit visibility" / "Move to space" rows are gated on. Read-only; it uses main's own accessContext so the
// CLI cannot drift from the app.
commands.caps = async () => {
  if (!positional.length) throw new Error('usage: caps <id...>');
  const me = await connect();
  const main = backend(me);
  await client.sync.connect();
  const access = require('../sdk/access');
  const ctx = await main.accessContext();
  for (const id of positional) {
    const doc = await client.sync.subscribe(id);
    out({ id, title: readNode(doc).title, ...await access.capabilities(doc, me.userUri, ctx) });
  }
};
// WRITES. pinto <hub> <uri> / unpinfrom <hub> <uri>: pin a document on a meeting or a space, through the app's own
// path (main nodePin), so the native write-capability gate is exercised too. Prints the hub's pinned uris after.
async function setNodePin(on) {
  const [hub, uri] = positional;
  if (!hub || !uri) throw new Error('usage: ' + (on ? 'pinto' : 'unpinfrom') + ' <event|space id> <document id>');
  const main = backend(await connect());
  await client.sync.connect();
  const pinnedUris = await main.nodePin(hub, uri, on);
  await new Promise((r) => setTimeout(r, 1500)); // let the live update reach the server before we exit
  out({ hub, pinnedItems: pinnedUris });
}
commands.pinto = () => setNodePin(true);
commands.unpinfrom = () => setNodePin(false);
// pageprobe: read-only GraphService pagination/limit experiment against real data.
commands.pageprobe = async () => {
  const me = await connect();
  const sortOptions = [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }];
  const probe = async (nodeTypes, limits = [100, 200, 500, 1000]) => {
    const rows = [];
    for (const limit of limits) {
      const started = Date.now();
      const result = await client.graph.listNodes({ ...(nodeTypes ? { nodeTypes } : {}), limit, mode: 'LIST_NODES_MODE_WITH_COUNT', sortOptions });
      const ids = result.nodes.map((n) => n.id);
      rows.push({ limit, returned: ids.length, totalCount: result.totalCount, unique: new Set(ids).size,
        first: ids[0], last: ids.at(-1), ms: Date.now() - started, ids });
    }
    const baseline = rows[0].ids;
    return rows.map(({ ids, ...s }) => ({ ...s, prefixMatches100: baseline.every((id, i) => ids[i] === id) }));
  };
  const [textNodes, eventNodes, allNodes, defaultLimit] = await Promise.all([
    probe(['text']), probe(['event']), probe(null, [100, 200, 500, 1000, 2000, 10000, 2147483647]),
    client.graph.listNodes({ mode: 'LIST_NODES_MODE_WITH_COUNT', sortOptions }),
  ]);
  out({ listNodes: { default: { returned: defaultLimit.nodes.length, totalCount: defaultLimit.totalCount }, text: textNodes, event: eventNodes, all: allNodes } });

  const allFull = await client.graph.listNodes({ limit: 10000, sortOptions });
  const biggest = { ids: allFull.nodes.map((n) => n.id) };
  const owners = new Map();
  for (const n of allFull.nodes) {
    if (n.ownerUri) owners.set(n.ownerUri, (owners.get(n.ownerUri) || 0) + 1);
  }
  const ownerId = [...owners].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (ownerId) {
    const ownerResults = [];
    for (const limit of [100, 200, 500, 1000]) {
      const result = await client.graph.listNodes({ ownerIds: [ownerId], limit, mode: 'LIST_NODES_MODE_WITH_COUNT', sortOptions });
      ownerResults.push({ limit, returned: result.nodes.length, totalCount: result.totalCount, unique: new Set(result.nodes.map((n) => n.id)).size });
    }
    out({ ownerChildren: { ownerId, sampleOccurrences: owners.get(ownerId), results: ownerResults } });
  }

  const eventBase = { nodeTypes: ['event'], mode: 'LIST_NODES_MODE_WITH_COUNT',
    sortOptions: [{ field: 'SORT_FIELD_EVENT_START_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] };
  const first = await client.graph.listNodes({ ...eventBase, limit: 100 });
  const boundary = first.nodes.at(-1)?.calendarEvent?.startTime;
  if (boundary) {
    const before = new Date(new Date(boundary).getTime() - 1).toISOString();
    const [newer, exact, older, second] = await Promise.all([
      client.graph.listNodes({ ...eventBase, eventStartTimeMin: boundary, limit: 1, mode: 'LIST_NODES_MODE_COUNT_ONLY' }),
      client.graph.listNodes({ ...eventBase, eventStartTimeMin: boundary, eventStartTimeMax: boundary, limit: 1, mode: 'LIST_NODES_MODE_COUNT_ONLY' }),
      client.graph.listNodes({ ...eventBase, eventStartTimeMax: before, limit: 1, mode: 'LIST_NODES_MODE_COUNT_ONLY' }),
      client.graph.listNodes({ ...eventBase, eventStartTimeMax: before, limit: 100 }),
    ]);
    const firstIds = new Set(first.nodes.map((n) => n.id));
    out({ eventKeyset: { totalCount: first.totalCount, firstReturned: first.nodes.length, boundary,
      boundaryRowsInFirst: first.nodes.filter((n) => n.calendarEvent?.startTime === boundary).length,
      exactBoundaryCount: exact.totalCount, newerOrEqualCount: newer.totalCount, olderCount: older.totalCount,
      partitionsTotal: (newer.totalCount || 0) + (older.totalCount || 0), secondReturned: second.nodes.length,
      secondFirst: second.nodes[0]?.calendarEvent?.startTime, secondLast: second.nodes.at(-1)?.calendarEvent?.startTime,
      overlap: second.nodes.filter((n) => firstIds.has(n.id)).length } });
  }

  const hub = first.nodes[0]?.id || biggest.ids[0];
  if (hub) {
    const edgeTypes = require('../sdk/proto/descriptors').files.graph.enums.find((e) => e.name === 'EdgeType').values.slice(1).map((v) => v.name);
    const [from, to, chain, profileFrom, profileTo] = await Promise.all([
      client.graph.listEdges({ fromNodeIds: [hub] }), client.graph.listEdges({ toNodeIds: [hub] }), client.graph.getOwnerChain(hub),
      client.graph.listEdges({ fromNodeIds: [me.userUri] }), client.graph.listEdges({ toNodeIds: [me.userUri] }),
    ]);
    const traversed = [], profileUp = [], profileDown = [];
    for await (const row of client.graph.traverse({ startNodeId: hub, maxDepth: 2, direction: 'DIRECTION_DOWN', edgeTypes })) traversed.push(row);
    for await (const row of client.graph.traverse({ startNodeId: me.userUri, maxDepth: 1, direction: 'DIRECTION_UP', edgeTypes })) profileUp.push(row);
    for await (const row of client.graph.traverse({ startNodeId: me.userUri, maxDepth: 1, direction: 'DIRECTION_DOWN', edgeTypes })) profileDown.push(row);
    out({ otherGraphCalls: { hub, listEdgesFrom: from.edges?.length || 0, listEdgesTo: to.edges?.length || 0,
      ownerChainEntries: chain.entries?.length || 0, traverseRows: traversed.length,
      traverseUniqueNodes: new Set(traversed.map((r) => r.node?.id).filter(Boolean)).size,
      traverseMaxDepth: Math.max(0, ...traversed.map((r) => r.depth || 0)), profile: {
        listEdgesFrom: profileFrom.edges?.length || 0, listEdgesTo: profileTo.edges?.length || 0,
        traverseUp: profileUp.length, traverseDown: profileDown.length,
      } } });
  }
};
// The real startup path (session -> client -> sync -> first refresh), with every warning and error the app would log
// on boot (#97). Bootstrap and catch-up carry no local ops, so the only thing it can write is the app's own settings
// document, which starting is what creates or finds (main/settings.js) — in its own temporary database, so the
// pointer it notes is thrown away and the real app finds the same document by name.
commands.boot = async () => {
  process.env.TANA_MAIN_TEST = '1';
  require('../db').open(path.join(app.getPath('temp'), 'tana-cli-boot.sqlite'));
  const main = require('../main');
  main.testRuntime({ session, win: null, userData: app.getPath('temp') }); // start() keeps its peer.json there
  const noise = [], real = { warn: console.warn, error: console.error };
  for (const level of ['warn', 'error']) console[level] = (...a) => noise.push(level + ': ' + a.map(String).join(' ').slice(0, 300));
  const started = Date.now();
  let failure = null;
  try { await main.start(); } catch (e) { failure = String(e.message || e); }
  await new Promise((r) => setTimeout(r, Number(flag('settle', 8000)))); // let document bootstraps finish
  console.warn = real.warn; console.error = real.error;
  out({ startMs: Date.now() - started, failure, status: main.statusSnapshot(), noise: noise.length ? noise : 'none' });
};

// Grouped so a future agent can see at a glance which commands touch the user's real data.
const USAGE = [
  'usage: node scripts/platform-cli.js <command>   (not ./node_modules/.bin/electron: docs/ELECTRON-SANDBOX.md)',
  '  session    login | whoami',
  '  read       list [--state open|all] | search <query> [#task|#meeting|#member|#Type] | types | fields [<type uri>] |',
  '             meetings [--days 7] | chatlist [--limit 200] | proposals [--limit 500] [--detail] | get <id> [--raw] | outline <id> | rawdoc <id> [--containers 1] | workflow <type|task id> |',
  '             graphnode <id> | edges <id> | listkind <nodeType> [--limit 50] | image <tana:image:uri> | pins [--dates] |',
  '             changes <id> [--within <summary id>] [--limit 20] | inbox [--limit 20] [--watch seconds] |',
  '             settings   (with a key and a JSON value it writes)',
  '  diagnose   inspect <id...> | audiences [--limit 80] [--mine 0] [--kind text] | refs <id> | rows <query> | children <document id> | pinrows |',
  '             settype <id>   (listing only; with a target it writes) | classify <id>   (the document goes to the model) | translate [--to English] [text…]   (the texts go to the model)',
  '             caps <id...> | related <id> | incall [--limit 5] | callstate <call id> | suggestions [--limit 10] | pageprobe | libraryprobe | boot [--settle ms]',
  '  live       watch <id...>',
  '  LIVE       livequery [--minutes 60] [--seconds 20] [--state <stateType>] | livequery --to <id> [--from <id>] [--edge-types LINKS_TO,…] |',
  '             presence <id> [--seconds 30] [--announce <name>] [--block <blockId>]',
  '  WRITES     create <title> [--kind doc|task|meeting|type] | delete <id> | restore <id> | archive <id> | unarchive <id> |',
  '             set-title <id> <title> |',
  '             upload <image file> <doc id> [--after <block id>] |',
  '             meetingedit   (a scratch meeting it creates, edits and deletes; the server puts it in your calendar meanwhile) |',
  '             datemention [--date YYYY-MM-DD]   (a scratch document mentioning the date, read back and deleted) |',
  '             proposalcycle   (a scratch chat proposing two scratch documents, one approved and one rejected, read back and deleted) |',
  '             approve <chat id> <proposed id> | reject <chat id> <proposed id>   (an AI proposal: accepted, or removed and its draft deleted) |',
  '             addfield <type uri> <title> [--type member|date|link|options] [--options "A|B"] [--to <type uri>,…] [--multiple] |',
  '             set-state <id> <proposed|open|closed|not_now|workflow state> | pin <id> <sidebar|today|shared|mute> | unpin <id> <…same> |',
  '             pinto <event|space id> <id> | unpinfrom <event|space id> <id> | settype <id> <tana:type:...|none> |',
  '             set-hue <type uri> <0-360|none> | discusswith <id> <who…> | setfield <id> <type uri?attribute=key> <line…> |',
  '             chatsend <chat id|new> <text…> [--attach <uri>]   (a message sent as the chat page sends it, and Tana\'s answer)|',
  '             chatanswer <chat id> <option label…> [--custom <text>] | --skip   (Tana\'s waiting questions answered as the card does)',
].join('\n');

app.whenReady().then(async () => {
  if (!commands[cmd]) { console.error(USAGE); app.exit(2); return; }
  session = createTanaSession();
  let code = 0;
  try { await commands[cmd](); } catch (e) { console.error(e && e.stack || e); code = 1; }
  if (client) await client.close().catch(() => {});
  app.exit(code);
});

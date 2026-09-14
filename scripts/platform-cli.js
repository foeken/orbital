#!/usr/bin/env ./node_modules/.bin/electron
'use strict';
// Electron-run CLI for the platform SDK: ./node_modules/.bin/electron scripts/platform-cli.js <cmd>
const { app } = require('electron');
const path = require('node:path');
const { createTanaSession, peerIdentity } = require('../tana-session');
let createTanaClient, readNode, setTitle, setState, contentText, readOutline, ulid, initDocument, query, pins, audienceMetadata; // loaded lazily: login/whoami work without the SDK

// Share the cookie partition and peer.json with the real app.
app.setPath('userData', path.join(app.getPath('appData'), 'tana-tasks'));
if (app.dock) app.dock.hide();

const [cmd, ...args] = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

let session, client;

async function connect() {
  ({ createTanaClient } = require('../sdk'));
  ({ readNode, setTitle, setState, contentText, ulid, initDocument, audienceMetadata } = require('../sdk/node'));
  ({ readOutline } = require('../sdk/content'));
  query = require('../sdk/query');
  pins = require('../sdk/pins');
  const me = await session.info();
  const peer = peerIdentity({ file: path.join(app.getPath('userData'), 'peer.json'), userExternalId: me.userExternalId });
  client = createTanaClient({ getAccessToken: (o) => session.getAccessToken(o), orgId: me.orgId, ...peer, logger: console });
  return me;
}

const summary = (doc) => { const n = readNode(doc); return { id: doc.id, title: n.title, stateType: n.stateType, assignedToUris: n.assignedToUris }; };
const today = () => new Date().toLocaleDateString('sv-SE');
// pin <id> <sidebar|today> / unpin: mutate, let the live update go out, print the doc's pin state
async function setPin(on) {
  const [id, target] = positional;
  if (!id || !['sidebar', 'today'].includes(target)) throw new Error('usage: ' + (on ? 'pin' : 'unpin') + ' <id> <sidebar|today>');
  const me = await connect();
  await client.sync.connect();
  if (target === 'sidebar') await (on ? pins.pinSidebar : pins.unpinSidebar)(client.sync, me.userUri, id);
  else await (on ? pins.pinDate : pins.unpinDate)(client.sync, me.userUri, id, today());
  await new Promise((r) => setTimeout(r, 1500));
  out({ id, sidebar: (await pins.listSidebar(client.sync, me.userUri)).includes(id), dates: await pins.dates(client.sync, me.userUri, id) });
}

const commands = {
  async login() {
    await session.login();
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
  async list() {
    const me = await connect();
    const state = flag('state', 'open');
    // the same builder the Tasks view uses (sdk/query.js), so the CLI cannot drift from the app
    const { nodes } = await client.graph.listNodes(query.taskParams({ states: state === 'all' ? null : [state], assignee: 'me' }, me.userUri));
    for (const n of nodes) out(n.id + '\t' + ((n.state && n.state.type) || '-') + '\t' + (n.title || ''));
    out(nodes.length + ' nodes'); // totalCount needs mode LIST_NODES_MODE_WITH_COUNT
  },
  async search() {
    await connect();
    const parsed = query.parseQuery(positional.join(' '));
    let types = new Map();
    if (query.needsTypes(parsed)) types = new Map((await client.graph.listNodes({ nodeTypes: ['type'], limit: 200 })).nodes.map((n) => [(n.title || '').toLowerCase(), n.id]));
    const params = query.searchParams(parsed, types);
    if (!params) return out('no results (empty query or unknown #type)');
    const { nodes } = await client.graph.listNodes(params);
    const when = (ev) => (ev ? new Date(ev.startTime).toLocaleString('sv-SE').slice(0, 16) + ' ' : '');
    for (const n of nodes) out(n.id + '  ' + (n.calendarEvent ? '[meeting] ' + when(n.calendarEvent) : n.state ? '[task:' + n.state.type + '] ' : n.entityType ? '[typed] ' : '') + (n.title || ''));
    out(nodes.length + ' results');
  },
  async types() {
    await connect();
    for (const n of (await client.graph.listNodes({ nodeTypes: ['type'], limit: 200 })).nodes) out(n.id + '\t' + (n.title || '') + '\thue=' + (n.appearance && n.appearance.hue != null ? n.appearance.hue : '-'));
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
    if (!positional[0] || !['doc', 'task', 'meeting'].includes(kind)) throw new Error('usage: create <title> [--kind task|meeting|doc]');
    const me = await connect();
    await client.sync.connect();
    const id = (kind === 'meeting' ? 'tana:event:' : 'tana:text:') + ulid();
    const doc = await client.sync.subscribe(id, (loro) => initDocument(loro, positional[0], me.userUri, { kind }));
    const n = readNode(doc);
    out({ ...summary(doc), type: n.type, startTime: n.startTime, endTime: n.endTime });
  },
  async delete() {
    if (!positional[0]) throw new Error('usage: delete <id>  (document_action soft_delete)');
    await connect();
    await client.sync.connect();
    out(await client.sync.softDelete(positional[0]));
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
    if (!id || !stateType) throw new Error('usage: set-state <id> <proposed|open|closed|not_now>');
    const me = await connect();
    await client.sync.connect();
    const doc = await client.sync.subscribe(id);
    setState(doc, stateType, me.userUri);
    await new Promise((r) => setTimeout(r, 1500));
    out(summary(doc));
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
  const filter = { ...query.DEFAULT_LIBRARY_FILTER, types: query.LIBRARY_KINDS, assignee: uri };
  for (const { kind, params } of query.libraryQueries(filter, me.userUri)) {
    const { nodes } = await client.graph.listNodes(params);
    const rows = kind === 'docs' ? nodes.filter((n) => !(n.state && n.state.type)) : nodes;
    const mine = rows.filter((n) => (n.assignedTo || []).includes(uri));
    out(kind.padEnd(10) + ' sends=' + JSON.stringify({ ...params, sortOptions: undefined, limit: undefined }) + ' nodes=' + rows.length + ' assigned=' + mine.length);
  }
  const { nodes: tasks } = await client.graph.listNodes(query.taskParams({ states: null, assignee: uri }, me.userUri));
  out('Tasks view (all states) = ' + tasks.length + ', of those assigned = ' + tasks.filter((n) => (n.assignedTo || []).includes(uri)).length);
  out('-- direct per-node-type probes: which node types the graph filters by assignedTo / unassigned --');
  for (const kind of query.LIBRARY_KINDS) {
    const params = { nodeTypes: [{ meetings: 'event', tasks: 'text', docs: 'text', chats: 'chat', canvases: 'canvas', agents: 'agent', skills: 'skill' }[kind]], assignedTo: [uri], limit: 100 };
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
  const main = backend(await connect());
  await client.sync.connect(); // related() reads the zoomed node's fields, which needs a subscription
  if (positional[0]) { const { call } = await main.related(positional[0]); return out('related(' + positional[0] + ').call = ' + JSON.stringify(call)); }
  const days = Number(flag('days', 14)), now = Date.now();
  const { nodes } = await client.graph.listNodes({ nodeTypes: ['event'], eventStartTimeMin: new Date(now - days * 864e5).toISOString(), eventStartTimeMax: new Date(now + days * 864e5).toISOString(), limit: 300 });
  const withLocation = nodes.filter((n) => (n.calendarEvent || {}).location);
  out(withLocation.length + ' of ' + nodes.length + ' events carry a location');
  const hosts = new Map();
  for (const n of withLocation) { const c = main.callOf(n.calendarEvent); const key = c ? c.label.split('/')[0] : 'no link (room or address)'; hosts.set(key, (hosts.get(key) || 0) + 1); }
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
// Sidebar pins as the renderer receives them: the only path where spaces reach a row (#63).
commands.pinrows = async () => {
  const main = backend(await connect());
  await client.sync.connect();
  out(await main.pinTree());
};
// The real startup path (session -> client -> sync -> first refresh), read-only, with every warning and error
// the app would log on boot (#97). Nothing is written to Tana: bootstrap and catch-up carry no local ops.
commands.boot = async () => {
  process.env.TANA_MAIN_TEST = '1';
  require('../db').open(path.join(app.getPath('temp'), 'tana-cli-boot.sqlite'));
  const main = require('../main');
  main.testRuntime({ session, win: null });
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
  'usage: ./node_modules/.bin/electron scripts/platform-cli.js <command>',
  '  session    login | whoami',
  '  read       list [--state open|all] | search <query> [#task|#meeting|#member|#Type] | types | fields [<type uri>] |',
  '             meetings [--days 7] | get <id> | outline <id> | graphnode <id> | edges <id> | image <tana:image:uri> | pins [--dates]',
  '  diagnose   inspect <id...> | audiences [--limit 80] [--mine 0] [--kind text] | refs <id> | rows <query> | pinrows | boot [--settle ms]',
  '  live       watch <id...>',
  '  WRITES     create <title> [--kind doc|task|meeting] | delete <id> | set-title <id> <title> |',
  '             set-state <id> <proposed|open|closed|not_now> | pin <id> <sidebar|today> | unpin <id> <sidebar|today>',
].join('\n');

app.whenReady().then(async () => {
  if (!commands[cmd]) { console.error(USAGE); app.exit(2); return; }
  session = createTanaSession();
  let code = 0;
  try { await commands[cmd](); } catch (e) { console.error(e && e.stack || e); code = 1; }
  if (client) await client.close().catch(() => {});
  app.exit(code);
});

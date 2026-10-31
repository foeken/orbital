#!/usr/bin/env node
'use strict';
// The Orbital daemon (docs/DAEMON.md): one Tana connection kept open in the background, and the MCP server over it
// (daemon/server.js). A headless Electron process, because Tana signs in only in a browser (tana-session.js), with its
// own sign-in and peer, apart from the app's (~/Library/Application Support/Orbital Daemon), so the two never refresh
// one session's cookies against each other.
//   node daemon/main.js login     sign this daemon in to Tana (a window)
//   node daemon/main.js whoami    who it is signed in as
//   node daemon/main.js key       make the setup key in the Keychain if there is none (never prints it)
//   node daemon/main.js selftest  against your Tana, in a private scratch note made and deleted for it: metadata written,
//                                 read back from Tana, and a state change heard as an event (no webhook leaves the machine)
//   node daemon/main.js           run: the MCP server on 127.0.0.1:$ORBITAL_DAEMON_PORT (23390)
// ORBITAL_DAEMON_USERDATA and ORBITAL_DAEMON_DB move its folder and its database (a check against the app's own sign-in).
// Run with node: this file then re-execs Electron, as scripts/platform-cli.js does (docs/ELECTRON-SANDBOX.md).
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {
  if (process.env.CODEX_SANDBOX) { console.error('The daemon needs GUI Electron, which cannot start inside the sandbox: run it unsandboxed (docs/ELECTRON-SANDBOX.md).'); process.exit(3); }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronBin = path.join(__dirname, '..', 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  const { status } = require('node:child_process').spawnSync(electronBin, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(status == null ? 1 : status);
}

const http = require('node:http');
const crypto = require('node:crypto');
const { app } = require('electron');
const { createTanaSession, peerIdentity } = require('../tana-session');

const KEYCHAIN = 'orbital-daemon-key';
const PORT = Number(process.env.ORBITAL_DAEMON_PORT) || 23390;
const PUBLIC_URL = process.env.ORBITAL_DAEMON_PUBLIC_URL || 'https://donut.taila4148b.ts.net/tana';
app.setPath('userData', process.env.ORBITAL_DAEMON_USERDATA || path.join(app.getPath('appData'), 'Orbital Daemon'));
const DB = process.env.ORBITAL_DAEMON_DB || path.join(app.getPath('userData'), 'daemon.db');
if (app.dock) app.dock.hide();
app.on('window-all-closed', () => {}); // the login window closing is not the end of the daemon

const keychain = () => { try { return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const setupKey = () => process.env.ORBITAL_DAEMON_KEY || keychain();

// What the server needs of Tana: a node's metadata, read and written over its document, and live queries
function tanaFor(client) {
  const metadata = require('./metadata');
  const { openLiveQuery, openEdgeQuery } = require('../sdk/livequery');
  // uri -> how many calls are using a document these tools opened; let go when none is. One something else had open stays
  // open: sync.unsubscribe is not counted, so letting it go would cut that holder off (its writes never reaching Tana).
  const held = new Map();
  async function withDoc(uri, fn) {
    metadata.checkUri(uri);
    if (!held.has(uri) && client.sync.getDocument(uri)) {
      const doc = await client.sync.subscribe(uri);
      if (Number(doc.data.get('deletedAt')) > 0) throw metadata.refuse('That node is deleted');
      return fn(doc);
    }
    held.set(uri, (held.get(uri) || 0) + 1);
    try {
      const doc = await client.sync.subscribe(uri).catch((e) => { throw metadata.refuse('Tana has no node ' + uri + ' you can open (' + String(e.message || e).slice(0, 120) + ')'); });
      if (Number(doc.data.get('deletedAt')) > 0) throw metadata.refuse('That node is deleted');
      return await fn(doc);
    } finally {
      const left = held.get(uri) - 1;
      if (left) held.set(uri, left); else { held.delete(uri); client.sync.unsubscribe(uri).catch(() => {}); }
    }
  }
  return {
    read: (uri, keys) => withDoc(uri, (doc) => metadata.read(doc, keys)),
    write: (uri, set, del) => withDoc(uri, async (doc) => {
      if (doc.writeDenied) throw metadata.refuse('You cannot edit that node');
      const out = metadata.write(doc, set, del);
      await client.sync.flushed(uri);
      if (doc.writeDenied) throw metadata.refuse('Tana refused the write: you cannot edit that node');
      return out;
    }),
    open: (kind, query, onRows) => (kind === 'edges' ? openEdgeQuery : openLiveQuery)(client.sync, query, { label: 'orbital-daemon', onRows }),
    status: () => ({ connected: !!client.sync.connected }),
  };
}

async function connect(session) {
  const me = await session.info().catch(() => null);
  if (!me) throw new Error('Not signed in to Tana: run node daemon/main.js login first');
  const { createTanaClient } = require('../sdk');
  const peer = peerIdentity({ file: path.join(app.getPath('userData'), 'peer.json'), userExternalId: me.userExternalId });
  const client = createTanaClient({ getAccessToken: (o) => session.getAccessToken(o), orgId: me.orgId, ...peer, logger: console, clientName: 'orbital-daemon', userAgent: require('../source').userAgent('Orbital-Daemon') });
  return { me, client };
}

async function run(session) {
  const key = setupKey();
  if (!key) throw new Error('No setup key: run node daemon/main.js key first');
  const { me, client } = await connect(session);
  const { createDaemon, sqlite } = require('./server');
  const daemon = createDaemon({ tana: tanaFor(client), store: sqlite(DB), publicUrl: PUBLIC_URL, setupKey: key });
  const server = http.createServer(daemon.handle);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log('Orbital daemon for ' + ((me.user && me.user.email) || me.userUri) + ' at http://127.0.0.1:' + PORT + '/mcp (' + PUBLIC_URL + '/mcp)');
  await client.sync.connect();
  await daemon.resume();
  const stop = () => { server.close(); daemon.close(); client.close().catch(() => {}).finally(() => app.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

// The whole path against the real Tana, over the real MCP endpoint on a loopback port, with webhooks caught in process
async function selftest(session) {
  const { me, client } = await connect(session);
  const { createDaemon, sqlite } = require('./server');
  const { initDocument, setState, ulid } = require('../sdk/node');
  const key = crypto.randomBytes(32).toString('base64url'), heard = [];
  const post = async (url, headers, body) => { const b = JSON.parse(body); if (b.type !== 'verification') heard.push(b); return { status: 200, text: b.type === 'verification' ? JSON.stringify({ challenge: b.challenge }) : '' }; };
  // what the live query says, to wait for the note to be in it before changing it (a new note takes Tana a moment to index)
  const tana = tanaFor(client), seen = [];
  const open = tana.open;
  tana.open = (kind, query, onRows) => open(kind, query, (change) => { seen.push({ initial: change.initial, added: change.added.map((r) => r.uri), changed: change.changed.map((r) => r.uri + ' ' + (r.state && r.state.type)), removed: change.removed }); onRows(change); });
  const daemon = createDaemon({ tana, store: sqlite(), publicUrl: 'http://127.0.0.1', setupKey: key, post });
  const server = http.createServer(daemon.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const rpc = async (method, params) => (await fetch('http://127.0.0.1:' + server.address().port + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  const tool = async (name, args) => { const r = (await rpc('tools/call', { name, arguments: args })).result; if (r.isError) throw new Error(name + ': ' + r.content[0].text); return r.structuredContent; };
  const wait = async (what, ok, ms = 30e3) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await new Promise((r) => setTimeout(r, 250)); } };
  await client.sync.connect();
  const id = 'tana:text:' + ulid(), steps = [];
  const note = await client.sync.subscribe(id, (loro) => initDocument(loro, 'Orbital daemon self-test (deleted when it is done)', me.userUri, { kind: 'task' }));
  try {
    if (note.data.get('restricted') !== true) throw new Error('the scratch note is not private');
    await client.sync.flushed(id);
    steps.push('made a private scratch note ' + id);
    const set = { selftest: { at: new Date().toISOString(), ok: true }, label: 'daemon' };
    steps.push('write_metadata: ' + JSON.stringify((await tool('write_metadata', { node: id, set })).metadata));
    const back = await tool('read_metadata', { node: id });
    if (JSON.stringify(back.metadata) !== JSON.stringify(set)) throw new Error('read back ' + JSON.stringify(back.metadata));
    // and from Tana itself: a second connection, a peer of its own, that has never seen the note
    const reader = (await connect(session)).client;
    try {
      await reader.sync.connect();
      const fromTana = require('./metadata').read(await reader.sync.subscribe(id));
      if (JSON.stringify(fromTana) !== JSON.stringify(set)) throw new Error('Tana has ' + JSON.stringify(fromTana));
    } finally { await reader.close().catch(() => {}); }
    steps.push('read_metadata, and a second connection to Tana: the same');
    const settings = (await client.graph.listNodes({ nodeTypes: ['text'], textQuery: 'Orbital', createdBy: [me.userUri], limit: 50 })).nodes.find((n) => (n.title || '').trim() === 'Orbital');
    if (settings) {
      const r = (await rpc('tools/call', { name: 'read_metadata', arguments: { node: settings.id } })).result;
      if (!r.isError) throw new Error('the settings document was readable');
      steps.push('the settings document refused: ' + r.content[0].text);
    }
    const sub = await rpc('events/subscribe', { name: 'tana.task.state_changed', arguments: { uris: [id] }, delivery: { mode: 'webhook', url: 'https://selftest.invalid/hook', secret: 'whsec_' + crypto.randomBytes(32).toString('base64') } });
    if (!sub.result) throw new Error('subscribe: ' + JSON.stringify(sub.error));
    steps.push('subscribed: ' + sub.result.id);
    // the note as it is comes into the live query (its first answer, or added once Tana has indexed it) and is remembered
    await wait('the note in the live query', () => seen.some((c) => c.added.includes(id)), 90e3);
    steps.push('the live query has the note (' + seen.length + ' answer' + (seen.length === 1 ? '' : 's') + ')');
    setState(note, 'closed', me.userUri);
    await client.sync.flushed(id);
    await wait('the state change event', () => heard.some((e) => e.name === 'tana.task.state_changed'), 60e3);
    const e = heard.find((x) => x.name === 'tana.task.state_changed');
    steps.push('heard ' + e.name + ': ' + e.data.from + ' -> ' + e.data.to + ' for ' + e.data.node.uri);
  } catch (e) {
    steps.push('live query answers: ' + JSON.stringify(seen).slice(0, 1500));
    throw e;
  } finally {
    await client.sync.softDelete(id).catch((e) => steps.push('could not delete the scratch note: ' + e.message));
    steps.push('deleted the scratch note');
    server.close(); daemon.close(); await client.close().catch(() => {});
    console.log(steps.map((s) => '- ' + s).join('\n'));
  }
}

app.whenReady().then(async () => {
  const [cmd = 'run'] = process.argv.slice(2).filter((a) => !a.startsWith('-') && a !== __filename && !a.endsWith('main.js'));
  const session = createTanaSession();
  try {
    if (cmd === 'login') { console.log((await session.login()) ? 'Signed in as ' + ((await session.info()).user || {}).email : 'Sign-in cancelled'); return app.exit(0); }
    if (cmd === 'whoami') { const me = await session.info().catch(() => null); console.log(me ? (me.user && me.user.email) || me.userUri : 'Not signed in'); return app.exit(me ? 0 : 1); }
    if (cmd === 'key') {
      if (keychain()) { console.log('The setup key is in the Keychain (' + KEYCHAIN + ')'); return app.exit(0); }
      execFileSync('security', ['add-generic-password', '-s', KEYCHAIN, '-a', 'orbital-daemon', '-w', crypto.randomBytes(32).toString('base64url')], { stdio: 'ignore' });
      console.log('Made the setup key in the Keychain (' + KEYCHAIN + ')');
      return app.exit(0);
    }
    if (cmd === 'selftest') { await selftest(session); console.log('selftest: ok'); return app.exit(0); }
    if (cmd !== 'run') { console.error('usage: node daemon/main.js [login | whoami | key | selftest | run]'); return app.exit(2); }
    await run(session);
  } catch (e) {
    console.error(e && e.message);
    app.exit(1);
  }
});

#!/usr/bin/env ./node_modules/.bin/electron
'use strict';
// Electron-run CLI for the platform SDK: ./node_modules/.bin/electron scripts/platform-cli.js <cmd>
const { app } = require('electron');
const path = require('node:path');
const { createTanaSession, peerIdentity } = require('../tana-session');
let createTanaClient, readNode, setTitle, contentText; // loaded lazily: login/whoami work without the SDK

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
  ({ readNode, setTitle, contentText } = require('../sdk/node'));
  const me = await session.info();
  const peer = peerIdentity({ file: path.join(app.getPath('userData'), 'peer.json'), userExternalId: me.userExternalId });
  client = createTanaClient({ getAccessToken: (o) => session.getAccessToken(o), orgId: me.orgId, ...peer, logger: console });
  return me;
}

const summary = (doc) => { const n = readNode(doc); return { id: doc.id, title: n.title, stateType: n.stateType, assignedToUris: n.assignedToUris }; };

const commands = {
  async login() {
    await session.login();
    out('logged in as ' + ((await session.info()).user || {}).email);
  },
  async whoami() {
    out(await session.info());
  },
  async list() {
    const me = await connect();
    const state = flag('state', 'open');
    const { nodes, totalCount } = await client.graph.listNodes({
      nodeTypes: ['text'], assignedTo: [me.userUri], stateTypes: state === 'all' ? undefined : [state], limit: 500,
      sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }],
    });
    for (const n of nodes) out(n.id + '\t' + ((n.state && n.state.type) || '-') + '\t' + (n.title || ''));
    out(nodes.length + ' nodes (totalCount ' + totalCount + ')');
  },
  async get() {
    if (!positional[0]) throw new Error('usage: get <id>');
    await connect();
    await client.sync.connect();
    const doc = await client.sync.subscribe(positional[0]);
    out({ ...readNode(doc), content: contentText(doc) });
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
    if (!id || title == null) throw new Error('usage: set-title <id> <title>');
    await connect();
    await client.sync.connect();
    const doc = await client.sync.subscribe(id);
    setTitle(doc, title);
    await new Promise((r) => setTimeout(r, 1500)); // let the live update go out
    out(summary(doc));
  },
};

app.whenReady().then(async () => {
  if (!commands[cmd]) { console.error('usage: platform-cli login | whoami | list [--state open] | get <id> | watch <id...> | set-title <id> <title>'); app.exit(2); return; }
  session = createTanaSession();
  let code = 0;
  try { await commands[cmd](); } catch (e) { console.error(e && e.stack || e); code = 1; }
  if (client) await client.close().catch(() => {});
  app.exit(code);
});

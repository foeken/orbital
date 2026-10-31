'use strict';
// The daemon (daemon/, docs/DAEMON.md) without Tana: the metadata rules on real Loro documents, the events a live
// query's changes become, and the whole MCP server over HTTP on a loopback port: sign-in with the setup key and with
// OAuth, the two metadata tools, a subscription challenged, fed by a fake live query and delivered signed, shared and
// let go, and taken up again by a restarted server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Document } = require('../sdk/document');
const metadata = require('../daemon/metadata');
const { queryOf, createWatch, EVENTS } = require('../daemon/events');
const { createDaemon, sqlite } = require('../daemon/server');
const { signature } = require('../mcp-server/server');

const id = (kind, n) => 'tana:' + kind + ':' + String(n).padStart(26, '0');
function makeDoc(uri, title, more) {
  const doc = new Document(uri);
  doc.transact((loro) => { const d = loro.getMap('data'); d.set('title', title); d.set('stateType', 'open'); loro.getMap('appearance').set('hue', 120); if (more) more(loro); });
  return doc;
}
// every root but ours, empty ones left out (reading a root names it in toJSON without writing anything: see unwritten)
const roots = (doc) => JSON.stringify(Object.entries(doc.toJSON()).filter(([k, v]) => k !== 'ext:orbital' && !(v && typeof v === 'object' && !Object.keys(v).length)));
const unwritten = (doc, fn) => { const before = doc.loro.oplogVersion(); fn(); assert.equal(doc.loro.oplogVersion().compare(before), 0, 'a read writes nothing to the document'); };

// ---- metadata: ext:orbital only, never the settings document ----
assert.match(fs.readFileSync(path.join(__dirname, '../main/settings.js'), 'utf8'), /const ROOT = 'ext:orbital';/, 'the same root as the settings document');
assert.equal(metadata.ROOT, 'ext:orbital');
{
  const doc = makeDoc(id('text', 1), 'Plan'), before = roots(doc);
  assert.deepEqual(metadata.write(doc, { status: 'triaged', score: 3, tags: ['a', 'b'] }, []), { changed: 3 });
  assert.deepEqual(metadata.read(doc), { status: 'triaged', score: 3, tags: ['a', 'b'] });
  assert.deepEqual(metadata.read(doc, ['score', 'missing']), { score: 3 });
  unwritten(doc, () => metadata.read(doc));
  assert.equal(roots(doc), before, 'nothing outside ext:orbital changes');
  assert.equal(doc.loro.getMap('ext:orbital').get('score'), '3', 'one JSON string per key, as the settings document keeps them');
  assert.deepEqual(metadata.write(doc, { score: 3 }, ['tags']), { changed: 1 }, 'an unchanged value is not written again');
  assert.deepEqual(metadata.read(doc), { status: 'triaged', score: 3 });
  for (const [set, del, why] of [[{ '1bad': 1 }, [], /Key/], [{ 'a b': 1 }, [], /Key/], [{ relayKey: 'x' }, [], /reserved/], [{ x: null }, [], /delete/],
    [{ x: 'y'.repeat(9000) }, [], /8 KB/], [[], [], /object/], [{}, 'x', /list/]]) {
    assert.throws(() => metadata.write(doc, set, del), why);
  }
  assert.deepEqual(metadata.read(doc), { status: 'triaged', score: 3 }, 'a refused change writes nothing');
  assert.throws(() => metadata.write(doc, Object.fromEntries(Array.from({ length: 201 }, (_, i) => ['k' + i, i])), []), /at most 200/);
}
for (const [doc, why] of [
  [makeDoc(id('text', 2), 'Notes', (l) => l.getMap('ext:orbital:doc').set('app', 'orbital')), 'its mark'],
  [makeDoc(id('text', 3), 'Renamed', (l) => l.getMap('ext:orbital').set('relayKey', '"k"')), 'its relay key'],
  [makeDoc(id('text', 4), ' Orbital ', null), 'its title'],
  [makeDoc(id('text', 5), 'Tana Companion', null), 'its old title'],
  [makeDoc(id('text', 6), 'Old', (l) => l.getMap('settings').set('x', '1')), 'its old root'],
]) {
  assert.throws(() => metadata.read(doc), /settings document/, 'the settings document is refused by ' + why);
  assert.throws(() => metadata.write(doc, { a: 1 }, []), /settings document/);
}
for (const bad of ['tana:user-profile:' + '0'.repeat(26), 'tana:pin-map:' + '0'.repeat(26), 'tana:text:short', 'x', 7]) assert.throws(() => metadata.checkUri(bad));
metadata.checkUri(id('event', 1));

// ---- events: a filter is a live query; its changes become events ----
assert.throws(() => queryOf('tana.node.added', {}), /at least one list/, 'never the whole workspace');
assert.throws(() => queryOf('tana.edge.added', { edgeTypes: ['LINKS_TO'] }), /from or to/);
assert.throws(() => queryOf('tana.node.added', { bogus: [] }), /no argument bogus/);
assert.throws(() => queryOf('tana.nope', {}), /No event/);
assert.throws(() => queryOf('tana.task.state_changed', { stateTypes: ['open'], to: ['done'] }), /to:/);
assert.deepEqual(queryOf('tana.edge.added', { edgeTypes: ['COMMENTS_ON'], to: { uris: [id('text', 1)] } }).query, { predicate: { edgeTypes: [18] }, object: { uris: [id('text', 1)] } });
assert.deepEqual(queryOf('tana.node.added', { assignedTo: ['b', 'a', 'a'], unassigned: false }).query, { assignedTo: ['a', 'b'], unassigned: false }, 'lists sorted and deduplicated, so one filter is one query');
assert.ok(EVENTS.every((e) => e.inputSchema && e.payloadSchema && e.delivery[0] === 'webhook'));

const row = (n, more = {}) => ({ uri: id('text', n), title: 'Task ' + n, type: 'text', state: { type: 'open' }, assignedTo: [], updatedAt: 1, ...more });
function fakeTana(docs = new Map()) {
  const queries = [];
  const doc = (uri) => { metadata.checkUri(uri); if (!docs.has(uri)) throw metadata.refuse('No node ' + uri); return docs.get(uri); };
  return {
    docs, queries,
    read: async (uri, keys) => metadata.read(doc(uri), keys),
    write: async (uri, set, del) => metadata.write(doc(uri), set, del),
    open: async (kind, query, onRows) => { const q = { kind, query, onRows, closed: false }; queries.push(q); return { close: async () => { q.closed = true; } }; },
  };
}
(async () => {
  {
    const tana = fakeTana(), heard = [];
    let quietUri = null;
    const watch = createWatch({ open: tana.open, emit: (sub, data) => heard.push([sub.id, sub.name, data]), quiet: (uri) => uri === quietUri });
    await watch.add({ id: 's1', name: 'tana.task.state_changed', args: { stateTypes: ['open', 'closed'], to: ['closed'] } });
    await watch.add({ id: 's2', name: 'tana.node.changed', args: { stateTypes: ['closed', 'open'] } });
    await watch.add({ id: 's3', name: 'tana.task.assigned', args: { stateTypes: ['open', 'closed'], assignee: 'tana:user-profile:me' } });
    await watch.add({ id: 's4', name: 'tana.node.removed', args: { stateTypes: ['open', 'closed'] } });
    assert.equal(tana.queries.length, 1, 'one filter, one live query, however many events listen to it');
    const q = tana.queries[0];
    q.onRows({ initial: true, added: [row(1), row(2)], changed: [], removed: [] });
    assert.equal(heard.length, 0, 'what is there already is not announced');
    q.onRows({ initial: false, added: [], changed: [row(1, { state: { type: 'closed' }, updatedAt: 2 })], removed: [] });
    assert.deepEqual(heard.map(([s, n]) => s + ' ' + n), ['s1 tana.task.state_changed', 's2 tana.node.changed']);
    assert.equal(heard[0][2].from, 'open'); assert.equal(heard[0][2].to, 'closed'); assert.deepEqual(heard[1][2].fields, ['state']);
    heard.length = 0;
    q.onRows({ initial: false, added: [], changed: [row(2, { state: { type: 'not_now' } })], removed: [] });
    assert.deepEqual(heard.map(([s]) => s), ['s2'], 'a state change into Later is not one to closed');
    heard.length = 0;
    q.onRows({ initial: false, added: [row(3, { assignedTo: ['tana:user-profile:me'] })], changed: [row(2, { state: { type: 'not_now' }, assignedTo: ['tana:user-profile:other'] })], removed: [] });
    assert.deepEqual(heard.map(([s, n, d]) => s + ' ' + (d.assigned || d.fields)).sort(), ['s2 assignedTo', 's3 tana:user-profile:me'], 'only the assignee asked for');
    heard.length = 0;
    quietUri = id('text', 3);
    q.onRows({ initial: false, added: [], changed: [row(3, { assignedTo: ['tana:user-profile:me'], updatedAt: 9 })], removed: [id('text', 1)] });
    assert.deepEqual(heard.map(([s]) => s), ['s4'], 'the daemon\'s own metadata write is not a change; a removal names the node');
    assert.equal(heard[0][2].node, id('text', 1)); assert.equal(heard[0][2].last.state, 'closed');
    watch.remove('s1'); watch.remove('s2'); watch.remove('s3');
    assert.equal(q.closed, false, 'still listened to');
    watch.remove('s4');
    await new Promise((r) => setImmediate(r));
    assert.equal(q.closed, true, 'the last one gone closes the live query');
  }

  // ---- the server over HTTP ----
  const KEY = crypto.randomBytes(32).toString('base64url');
  const tana = fakeTana(), posted = [];
  tana.docs.set(id('text', 10), makeDoc(id('text', 10), 'Plan'));
  tana.docs.set(id('text', 11), makeDoc(id('text', 11), 'Orbital', (l) => l.getMap('ext:orbital:doc').set('app', 'orbital')));
  let answer = (body) => { const b = JSON.parse(body); return { status: 200, text: b.type === 'verification' ? JSON.stringify({ challenge: b.challenge }) : '' }; };
  const post = async (url, headers, body) => { posted.push({ url, headers, body }); return answer(body); };
  const dbFile = path.join(require('node:os').tmpdir(), 'daemon-check-' + process.pid + '.db');
  const daemon = createDaemon({ tana, store: sqlite(dbFile), publicUrl: 'https://host/tana', setupKey: KEY, post, report: (e) => { throw e; } });
  const server = http.createServer(daemon.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (p, { body, auth, form, method } = {}) => {
    const res = await fetch(base + p, { method: method || (body || form ? 'POST' : 'GET'), redirect: 'manual',
      headers: { ...(auth ? { authorization: 'Bearer ' + auth } : {}), 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(form).toString() : body && JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  let n = 0;
  const rpc = (method, params, auth = KEY) => call('/mcp', { body: { jsonrpc: '2.0', id: ++n, method, params }, auth });

  assert.deepEqual((await rpc('tools/list', {}, null)).json.result.tools.map((t) => t.name), ['read_metadata', 'write_metadata'], 'only the two metadata tools, listed before sign-in');
  assert.equal((await rpc('events/list', {}, null)).json.result.events.length, 7);
  assert.equal((await rpc('server/discover', {}, null)).json.result.resultType, 'complete');
  const locked = await rpc('tools/call', { name: 'read_metadata', arguments: { node: id('text', 10) } }, null);
  assert.equal(locked.status, 401); assert.match(locked.headers.get('www-authenticate'), /resource_metadata="https:\/\/host\/tana\/.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal((await rpc('tools/call', { name: 'read_metadata', arguments: { node: id('text', 10) } }, 'x'.repeat(43))).status, 401, 'a wrong key');

  const tool = async (name, args, auth) => (await rpc('tools/call', { name, arguments: args }, auth)).json.result;
  let out = await tool('write_metadata', { node: id('text', 10), set: { triage: 'urgent', owner: 'Echo' } });
  assert.equal(out.isError, undefined); assert.deepEqual(out.structuredContent.metadata, { triage: 'urgent', owner: 'Echo' });
  out = await tool('write_metadata', { node: id('text', 10), delete: ['owner'] });
  assert.deepEqual(out.structuredContent.metadata, { triage: 'urgent' });
  assert.deepEqual((await tool('read_metadata', { node: id('text', 10) })).structuredContent.metadata, { triage: 'urgent' });
  out = await tool('read_metadata', { node: id('text', 11) });
  assert.equal(out.isError, true); assert.match(out.content[0].text, /settings document/, 'the settings document refused, as a result the agent can read');
  assert.equal((await tool('write_metadata', { node: id('text', 10) })).isError, true, 'neither set nor delete');
  assert.equal((await tool('read_metadata', { node: 'tana:user-profile:' + '1'.repeat(26) })).isError, true);
  assert.equal((await rpc('tools/call', { name: 'run_saved_search', arguments: {} })).json.error.code, -32602, 'no other tool');

  // subscribe: challenged first, then fed by the live query, delivered signed
  const secret = 'whsec_' + crypto.randomBytes(32).toString('base64');
  const subParams = { name: 'tana.task.state_changed', arguments: { assignedTo: [id('user-profile', 1)], to: ['closed'] }, delivery: { mode: 'webhook', url: 'https://agent.example/hook', secret } };
  assert.equal((await rpc('events/subscribe', { ...subParams, arguments: {} })).json.error.code, -32602, 'a filter is required');
  answer = () => ({ status: 200, text: '{}' });
  assert.equal((await rpc('events/subscribe', subParams)).json.error.code, -32015, 'a callback that does not answer its challenge');
  answer = (body) => { const b = JSON.parse(body); return { status: 200, text: b.type === 'verification' ? JSON.stringify({ challenge: b.challenge }) : '' }; };
  const sub = (await rpc('events/subscribe', subParams)).json.result;
  assert.match(sub.id, /^sub_/); assert.ok(Date.parse(sub.refreshBefore) > Date.now());
  assert.equal((await rpc('events/subscribe', subParams)).json.result.id, sub.id, 'subscribing again refreshes the same one');
  assert.equal(tana.queries.length, 1);
  const q = tana.queries[0];
  assert.deepEqual(q.query, { assignedTo: [id('user-profile', 1)] });
  q.onRows({ initial: true, added: [row(20)], changed: [], removed: [] });
  posted.length = 0;
  q.onRows({ initial: false, added: [], changed: [row(20, { state: { type: 'closed' } })], removed: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posted.length, 1);
  const { headers, body } = posted[0], event = JSON.parse(body);
  assert.equal(event.name, 'tana.task.state_changed'); assert.equal(event.data.node.uri, id('text', 20)); assert.equal(event.data.to, 'closed');
  assert.equal(headers['x-mcp-subscription-id'], sub.id);
  assert.equal(headers['webhook-signature'], signature(secret, headers['webhook-id'], headers['webhook-timestamp'], body), 'Standard Webhooks signature');

  // a restarted server picks its subscriptions up again, and an unsubscribe lets the live query go
  server.close(); daemon.close();
  const tana2 = fakeTana(tana.docs);
  const again = createDaemon({ tana: tana2, store: sqlite(dbFile), publicUrl: 'https://host/tana', setupKey: KEY, post, report: (e) => { throw e; } });
  await again.resume();
  assert.deepEqual(tana2.queries.map((x) => x.query), [{ assignedTo: [id('user-profile', 1)] }], 'taken up again after a restart');
  const server2 = http.createServer(again.handle);
  await new Promise((r) => server2.listen(0, '127.0.0.1', r));
  const base2 = 'http://127.0.0.1:' + server2.address().port;
  const rpc2 = async (method, params, auth = KEY) => (await fetch(base2 + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  await rpc2('events/unsubscribe', { name: subParams.name, arguments: subParams.arguments, delivery: { mode: 'webhook', url: subParams.delivery.url } });
  await new Promise((r) => setImmediate(r));
  assert.equal(tana2.queries[0].closed, true);

  // OAuth: a client registered, approved with the setup key, its token used
  const reg = await fetch(base2 + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }) }).then((r) => r.json());
  assert.ok(reg.client_id);
  assert.equal((await fetch(base2 + '/register', { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) })).status, 400);
  const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const form = { client_id: reg.client_id, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st' };
  const approve = (key) => fetch(base2 + '/authorize', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...form, setup_key: key }).toString() });
  assert.equal((await fetch(base2 + '/authorize?' + new URLSearchParams(form))).status, 200);
  assert.equal((await approve('wrong')).status, 401);
  const ok = await approve(KEY);
  assert.equal(ok.status, 302);
  const back = new URL(ok.headers.get('location'));
  assert.equal(back.searchParams.get('state'), 'st');
  const tokenOf = (verify) => fetch(base2 + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), client_id: reg.client_id, redirect_uri: form.redirect_uri, code_verifier: verify }).toString() });
  const tok = await (await tokenOf(verifier)).json();
  assert.ok(tok.access_token && tok.refresh_token);
  assert.equal((await tokenOf(verifier)).status, 400, 'a code works once');
  const viaOauth = await rpc2('tools/call', { name: 'read_metadata', arguments: { node: id('text', 10) } }, tok.access_token);
  assert.equal(viaOauth.result.isError, undefined, 'the OAuth token signs in');

  server2.close(); again.close();
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
  console.log('daemon-check: ok');
})().catch((e) => { console.error(e); process.exit(1); });

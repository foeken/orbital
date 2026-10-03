'use strict';
// The agent relay end to end (relay/server.js, docs/AGENT-RELAY.md): an Orbital and two agents over real HTTP on a
// loopback port, the relay's clock in the check's hands. Sign-in (OAuth with PKCE), linking with a code, a task (a node
// id and an action) out to one agent and a status back, and what must fail: a used or expired code, a wrong secret,
// a task that is not ids, another agent's task, an unlinked agent, a task kept past its day. Last, no secret and no
// token is in the database as itself.
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createRelay, postgresStore, TTL, isPublicAddress } = require('../relay/server');

let clock = Date.UTC(2026, 9, 3, 12);
// RELAY_CHECK_DATABASE_URL runs the same check on PostgreSQL (an empty database: it makes its tables), as a host would
const store = process.env.RELAY_CHECK_DATABASE_URL ? postgresStore(process.env.RELAY_CHECK_DATABASE_URL) : undefined;
// the agents' event callbacks (MCP Events): every POST the relay makes is kept here, and answered as a receiver would
const posted = [];
const echo = (body) => ({ status: 200, text: JSON.parse(body).type === 'verification' ? JSON.stringify({ challenge: JSON.parse(body).challenge }) : '' });
let answer = echo;
const post = async (url, headers, body) => { posted.push({ url, headers, body }); return answer(body); };
const relay = createRelay({ store, publicUrl: 'http://127.0.0.1', now: () => clock, post });
const server = http.createServer(relay.handle);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, { body, auth, form } = {}) => {
    const headers = {};
    if (auth) headers.authorization = auth;
    if (body !== undefined) headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    const res = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };

  // ---- an agent's MCP connection signs in on its own ----
  const meta = await call('GET', '/.well-known/oauth-authorization-server/mcp');
  assert.equal(meta.json.issuer, 'http://127.0.0.1/mcp');
  assert.deepEqual(meta.json.code_challenge_methods_supported, ['S256']);
  assert.equal(meta.json.authorization_response_iss_parameter_supported, true, 'every redirect back names the issuer');
  // ChatGPT lists the tools before it signs in, so hello and the list need no token (it found none when they did)
  const hello = await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ChatGPT', version: '1' } } } });
  assert.equal(hello.status, 200, 'hello needs no sign-in');
  assert.deepEqual(hello.json.result.capabilities, { tools: {}, events: {} }, 'tools, and the task.assigned event');
  const open = await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  assert.deepEqual(open.json.result.tools.map((t) => t.name), ['link_orbital', 'get_tasks', 'update_task'], 'nor does the list');
  assert.ok(open.json.result.tools.every((t) => t.securitySchemes[0].type === 'oauth2' && t._meta.securitySchemes[0].type === 'oauth2'), 'and each tool says it needs a sign-in');
  for (const auth of [undefined, 'Bearer not-a-token']) {
    const unauth = await call('POST', '/mcp', { auth, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_tasks', arguments: {} } } });
    assert.equal(unauth.status, 401, 'calling a tool needs a token');
    assert.match(unauth.headers.get('www-authenticate'), /resource_metadata="http:\/\/127\.0\.0\.1\/\.well-known\/oauth-protected-resource\/mcp"/, 'and says where to sign in');
    assert.match(unauth.json.result._meta['mcp/www_authenticate'][0], /resource_metadata=.*error="invalid_token".*error_description=/, 'in the result too, as ChatGPT reads it');
  }
  assert.equal((await call('POST', '/mcp/oauth/register', { body: { redirect_uris: ['javascript:alert(1)'] } })).status, 400, 'no script redirects');
  assert.equal((await call('POST', '/mcp/oauth/register', { body: { redirect_uris: ['http://evil.example/cb'] } })).status, 400, 'plain http only to loopback');

  async function signIn(app) {
    const redirect = 'https://agents.example/' + app + '/callback';
    const client = (await call('POST', '/mcp/oauth/register', { body: { redirect_uris: [redirect], client_name: app } })).json.client_id;
    const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const auth = await call('GET', '/mcp/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's1' }));
    assert.equal(auth.status, 302, 'authorize answers with the code at once');
    const back = new URL(auth.headers.get('location'));
    assert.equal(back.searchParams.get('state'), 's1');
    const code = back.searchParams.get('code');
    const wrong = await call('POST', '/mcp/oauth/token', { form: true, body: { grant_type: 'authorization_code', code, client_id: client, redirect_uri: redirect, code_verifier: 'x'.repeat(43) } });
    assert.equal(wrong.json.error, 'invalid_grant', 'a verifier that does not match is refused');
    const reused = await call('POST', '/mcp/oauth/token', { form: true, body: { grant_type: 'authorization_code', code, client_id: client, redirect_uri: redirect, code_verifier: verifier } });
    assert.equal(reused.status, 400, 'and the code was spent by that try: a code works once');
    const again = new URL((await call('GET', '/mcp/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256' }))).headers.get('location')).searchParams.get('code');
    const tokens = (await call('POST', '/mcp/oauth/token', { form: true, body: { grant_type: 'authorization_code', code: again, client_id: client, redirect_uri: redirect, code_verifier: verifier } })).json;
    assert.ok(tokens.access_token && tokens.refresh_token);
    let n = 0;
    const agent = { client, tokens,
      rpc: async (method, params = {}) => (await call('POST', '/mcp', { auth: 'Bearer ' + agent.tokens.access_token, body: { jsonrpc: '2.0', id: ++n, method, params } })).json,
      tool: async (name, args = {}) => { const r = (await agent.rpc('tools/call', { name, arguments: args })).result; return { error: !!r.isError, text: r.content[0].text }; } };
    const init = await agent.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: app, version: '1' }, capabilities: {} });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    return agent;
  }
  const grok = await signIn('Grok');
  const listed = (await grok.rpc('tools/list')).result.tools;
  assert.deepEqual(listed.map((t) => t.name), ['link_orbital', 'get_tasks', 'update_task']);
  assert.deepEqual(listed.map((t) => [t.annotations.readOnlyHint, t.annotations.destructiveHint, t.annotations.openWorldHint]), [[false, false, false], [true, false, false], [false, false, false]],
    'each says whether it writes, can destroy or reaches beyond Orbital (ChatGPT wants all three): only get_tasks reads, none destroys');
  assert.match((await grok.tool('get_tasks')).text, /Not linked/, 'an agent with no link is told how to get one');

  // a refresh token turns once: the new pair works, the old refresh token does not
  const refreshed = (await call('POST', '/mcp/oauth/token', { form: true, body: { grant_type: 'refresh_token', refresh_token: grok.tokens.refresh_token, client_id: grok.client } })).json;
  assert.equal((await call('POST', '/mcp/oauth/token', { form: true, body: { grant_type: 'refresh_token', refresh_token: grok.tokens.refresh_token, client_id: grok.client } })).status, 400);
  grok.tokens = refreshed;

  // ---- an Orbital: one random key, made into an Orbital the first time it asks for a link code ----
  const newKey = () => crypto.randomBytes(32).toString('base64url');
  const orbital = { key: newKey() }, firstKey = orbital.key, stranger = { key: newKey() };
  const as = (o) => 'Orbital ' + o.key;
  assert.equal((await call('GET', '/mcp/orbital/agents', { auth: as(orbital) })).status, 401, 'an unknown key is refused');
  const { code, expiresAt } = (await call('POST', '/mcp/orbital/codes', { auth: as(orbital) })).json;
  assert.equal(expiresAt - clock, 15 * 60e3, 'a code works for fifteen minutes');
  assert.deepEqual((await call('GET', '/mcp/orbital/agents', { auth: as(orbital) })).json.agents, [], 'until it asks for a link code: then it is an Orbital, with no agents yet');
  assert.equal((await call('GET', '/mcp/orbital/codes/' + code, { auth: as(stranger) })).status, 401, 'another key reads nothing of it');
  assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal((await call('GET', '/mcp/orbital/codes/' + code, { auth: as(orbital) })).json.state, 'waiting');
  assert.equal((await grok.tool('link_orbital', { code: 'AAAA-AAAA', name: 'GrokBot' })).error, true, 'an unknown code links nothing');
  assert.match((await grok.tool('link_orbital', { code: code.toLowerCase(), name: '  GrokBot ' })).text, /Linked to Orbital as GrokBot/, 'a code, typed in any case');
  const linked = (await call('GET', '/mcp/orbital/codes/' + code, { auth: as(orbital) })).json;
  assert.equal(linked.state, 'linked');
  assert.equal(linked.agent.name, 'GrokBot', 'the agent named itself');
  assert.equal(linked.agent.app, 'Grok', 'and the app it came through is known');
  const dot = await signIn('ChatGPT');
  assert.equal((await dot.tool('link_orbital', { code, name: 'Dot' })).error, true, 'a used code does not link a second agent');
  const code2 = (await call('POST', '/mcp/orbital/codes', { auth: as(orbital) })).json.code;
  await dot.tool('link_orbital', { code: code2, name: 'Dot' });
  const agents = (await call('GET', '/mcp/orbital/agents', { auth: as(orbital) })).json.agents;
  assert.deepEqual(agents.map((a) => a.name), ['GrokBot', 'Dot'], 'one Orbital, as many agents as link to it');
  const [G, D] = agents;

  // ---- a task: a node's id and an action, the request and the words staying in Tana for the agent to read there ----
  const send = (agent, id, node, action = 'assign') => call('POST', '/mcp/orbital/agents/' + agent.id + '/messages', { auth: as(orbital), body: { id, node, action } });
  const NODE = 'tana:text:01jzq8k3m5p7r9t1v3x5z7b9d1', OTHER = 'tana:text:01jzq8k3m5p7r9t1v3x5z7b9d2';
  const t1 = crypto.randomUUID();
  assert.equal((await send(G, t1, 'Draft the pilot brief')).status, 400, 'a task is a node id, not words');
  assert.equal((await send(G, t1, NODE, 'delete everything')).status, 400, 'and an action Orbital knows');
  assert.equal((await send(G, t1, NODE)).status, 202);
  assert.equal((await send(G, t1, OTHER)).status, 200, 'sending the same task twice queues it once');
  assert.equal((await send(D, t1, NODE)).status, 409, 'and its id cannot be reused for another agent');
  const first = JSON.parse((await grok.tool('get_tasks')).text), got = first.tasks;
  assert.match(first.how, /Tana's MCP server, https:\/\/home\.tana\.inc\/mcp/, 'the agent is told to read each node with Tana\'s MCP server');
  assert.equal(got.length, 1);
  assert.deepEqual(Object.keys(got[0]).sort(), ['action', 'node', 'sent_at', 'task_id'], 'a task is ids, an action and a time, nothing more');
  assert.deepEqual([got[0].node, got[0].action], [NODE, 'assign'], 'the agent reads which node, and what to do with it');
  assert.equal(got[0].task_id, t1);
  assert.match((await grok.tool('get_tasks')).text, /No tasks/, 'a fetched task is held for ten minutes, not handed out twice');
  assert.match((await dot.tool('get_tasks')).text, /No tasks/, 'and another agent never sees it');

  // a task for one agent is that agent's alone
  const t3 = crypto.randomUUID();
  await send(D, t3, OTHER);
  assert.match((await grok.tool('get_tasks')).text, /No tasks/, 'Grok does not see a task for Dot');
  assert.equal(JSON.parse((await dot.tool('get_tasks')).text).tasks[0].task_id, t3, 'Dot does');
  assert.equal((await grok.tool('update_task', { task_id: t3, status: 'completed' })).error, true, 'and Grok cannot report on it');

  // ---- the status: read back by Orbital, then gone ----
  assert.equal((await grok.tool('update_task', { task_id: crypto.randomUUID(), status: 'completed' })).error, true, 'no answer to a task it was never sent');
  assert.equal((await dot.tool('update_task', { task_id: t1, status: 'completed' })).error, true, 'nor to another agent\'s');
  assert.equal((await grok.tool('update_task', { task_id: t1, status: 'done' })).error, true, 'statuses are working, completed or failed');
  await grok.tool('update_task', { task_id: t1, status: 'working' });
  await grok.tool('update_task', { task_id: t1, status: 'completed', note: 'Words have nowhere to go: notes belong in the node' });
  const updates = (await call('GET', '/mcp/orbital/updates', { auth: as(orbital) })).json.updates;
  assert.deepEqual(updates.map((u) => [u.agent, u.task, u.status, u.note]), [[G.id, t1, 'working', undefined], [G.id, t1, 'completed', undefined]], 'an update is a task id and a status: a note sent along is dropped');
  assert.equal((await call('GET', '/mcp/orbital/updates', { auth: as(stranger) })).status, 401, 'nobody without the key reads them');
  assert.equal((await call('GET', '/mcp/orbital/updates', { auth: as(orbital) })).json.updates.length, 0, 'answers being read by one device are not handed to another');
  assert.equal((await call('POST', '/mcp/orbital/updates/ack', { auth: as(orbital), body: { ids: updates.map((u) => u.id) } })).status, 204);
  clock += TTL.updateLease + 1;
  assert.equal((await call('GET', '/mcp/orbital/updates', { auth: as(orbital) })).json.updates.length, 0, 'an acknowledged answer is gone');
  clock += TTL.lease;
  assert.match((await grok.tool('get_tasks')).text, /No tasks/, 'an answered task left the queue');

  // ---- a day at most ----
  const t4 = crypto.randomUUID();
  await send(G, t4, NODE);
  const late = (await call('POST', '/mcp/orbital/codes', { auth: as(orbital) })).json.code;
  clock += TTL.message + 1;
  await relay.sweep();
  assert.match((await grok.rpc('tools/call', { name: 'get_tasks', arguments: {} })).result._meta['mcp/www_authenticate'][0], /invalid_token/, 'a day on, the hour-long access token has run out');
  for (const a of [grok, dot]) a.tokens = (await call('POST', '/mcp/oauth/token', { form: true, body: { grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token, client_id: a.client } })).json;
  assert.match((await grok.tool('get_tasks')).text, /No tasks/, 'a task nobody fetched for a day is gone');
  assert.equal((await call('GET', '/mcp/orbital/codes/' + late, { auth: as(orbital) })).status, 404, 'and so is a code nobody used');

  // ---- rename, unlink, and a new key ----
  assert.equal((await call('PATCH', '/mcp/orbital/agents/' + D.id, { auth: as(orbital), body: { name: 'My dot' } })).json.name, 'My dot');
  assert.equal((await call('DELETE', '/mcp/orbital/agents/' + G.id, { auth: as(orbital) })).status, 204);
  assert.match((await grok.tool('get_tasks')).text, /Not linked/, 'an unlinked agent is told so');
  assert.equal((await send(G, crypto.randomUUID(), NODE)).status, 404, 'and nothing more can be sent to it');
  const fresh = newKey();
  assert.equal((await call('POST', '/mcp/orbital/rotate', { auth: as(orbital), body: { key: fresh } })).status, 204);
  assert.equal((await call('GET', '/mcp/orbital/agents', { auth: as(orbital) })).status, 401, 'the old key stops working');
  orbital.key = fresh;
  assert.deepEqual((await call('GET', '/mcp/orbital/agents', { auth: as(orbital) })).json.agents.map((a) => a.name), ['My dot'], 'and the agents stay linked');

  // ---- MCP Events (2026-07-28): the Dot subscribes to task.assigned, and a task for it is POSTed to its callback, signed ----
  const modern = (method, params = {}, auth) => call('POST', '/mcp', { auth, body: { jsonrpc: '2.0', id: 9, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } } });
  const disc = await modern('server/discover');
  assert.deepEqual([disc.status, disc.json.result.resultType, disc.json.result.supportedVersions[0], disc.json.result.capabilities], [200, 'complete', '2026-07-28', { tools: {}, events: {} }],
    'server/discover needs no sign-in, and says Orbital has events');
  assert.equal(disc.json.result._meta['io.modelcontextprotocol/serverInfo'].name, 'orbital', 'and who answered');
  const old = await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } } });
  assert.deepEqual([old.json.error.code, old.json.error.data.supported[0]], [-32022, '2026-07-28'], 'a version Orbital does not speak is refused, naming those it does');
  const listedTools = (await modern('tools/list')).json.result;
  assert.deepEqual([listedTools.resultType, listedTools.cacheScope, typeof listedTools.ttlMs, listedTools.tools.length], ['complete', 'public', 'number', 3], 'the tools, cacheable, in the new shape');
  const events = (await modern('events/list')).json.result.events;
  assert.deepEqual(events.map((e) => [e.name, e.delivery, e.payloadSchema.required]), [['task.assigned', ['webhook'], ['task_id', 'node', 'action']]], 'one event, by webhook, carrying ids only');
  const SECRET = 'whsec_' + crypto.randomBytes(32).toString('base64'), CB = 'https://receiver.example/mcp-events/cb1';
  const want = { name: 'task.assigned', arguments: {}, delivery: { mode: 'webhook', url: CB, secret: SECRET }, cursor: null };
  const sub = (params, agent = dot) => modern('events/subscribe', params, 'Bearer ' + agent.tokens.access_token);
  assert.equal((await modern('events/subscribe', want)).status, 401, 'subscribing needs the sign-in');
  assert.equal((await sub({ ...want, name: 'comment.created' })).json.error.code, -32602, 'only task.assigned');
  assert.equal((await sub({ ...want, arguments: { node: 'x' } })).json.error.code, -32602, 'which takes no arguments');
  assert.equal((await sub({ ...want, delivery: { ...want.delivery, secret: 'whsec_c2hvcnQ=' } })).json.error.code, -32602, 'a secret of 24 to 64 bytes');
  assert.equal((await sub({ ...want, delivery: { ...want.delivery, url: 'http://receiver.example/cb' } })).json.error.code, -32602, 'an https callback');
  answer = () => ({ status: 200, text: '{"challenge":"not-it"}' });
  const refused = (await sub(want)).json.error;
  assert.deepEqual([refused.code, refused.data.reason], [-32015, 'challenge_failed'], 'a callback that does not echo the challenge is refused');
  answer = echo; posted.length = 0;
  const made = (await sub(want)).json.result;
  assert.deepEqual([made.resultType, made.cursor, made.truncated, made.refreshBefore], ['complete', null, false, new Date(clock + TTL.subscription).toISOString()], 'subscribed, for a week');
  // Standard Webhooks, worked out here rather than with the relay's own function
  const signs = (p) => p.headers['webhook-signature'] === 'v1,' + crypto.createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(p.headers['webhook-id'] + '.' + p.headers['webhook-timestamp'] + '.' + p.body).digest('base64');
  const [check] = posted;
  assert.deepEqual([JSON.parse(check.body).type, /^msg_verification_/.test(check.headers['webhook-id']), check.headers['x-mcp-subscription-id'], signs(check)], ['verification', true, made.id, true], 'the callback was challenged first, signed');
  const refreshedSub = (await sub({ ...want, arguments: undefined, ttlMs: 3 * TTL.message })).json.result;
  assert.deepEqual([refreshedSub.id, posted.length, refreshedSub.refreshBefore], [made.id, 1, new Date(clock + 3 * TTL.message).toISOString()], 'asked again it is the same subscription, as long as asked, not challenged again');
  // grok, signed in but linked to nothing, listens too: it hears nothing of the Dot's tasks
  assert.ok((await sub({ ...want, delivery: { ...want.delivery, url: 'https://receiver.example/grok' } }, grok)).json.result.id);
  posted.length = 0;
  const tEvent = crypto.randomUUID();
  assert.equal((await send(D, tEvent, NODE)).status, 202);
  assert.equal(posted.length, 1, 'a task for the Dot is POSTed once, to its callback alone');
  const [delivery] = posted, event = JSON.parse(delivery.body);
  assert.deepEqual(event, { eventId: 'evt_' + tEvent, name: 'task.assigned', timestamp: new Date(clock).toISOString(), data: { task_id: tEvent, node: NODE, action: 'assign' }, cursor: null }, 'the event: ids and the action, nothing more');
  assert.deepEqual([delivery.url, delivery.headers['webhook-id'], delivery.headers['x-mcp-subscription-id'], signs(delivery)], [CB, event.eventId, made.id, true], 'signed, its webhook-id the event id');
  assert.equal(JSON.parse((await dot.tool('get_tasks')).text).tasks[0].task_id, tEvent, 'and the task waits in get_tasks, where the event sends it');
  // a receiver that is gone (410) ends the subscription; unsubscribing ends one too
  answer = () => ({ status: 410, text: '' }); posted.length = 0;
  await send(D, crypto.randomUUID(), NODE);
  answer = echo; posted.length = 0;
  await send(D, crypto.randomUUID(), NODE);
  assert.equal(posted.length, 0, 'after a 410 nothing more is sent there');
  await sub(want);
  assert.deepEqual((await modern('events/unsubscribe', { name: 'task.assigned', arguments: {}, delivery: { mode: 'webhook', url: CB } }, 'Bearer ' + dot.tokens.access_token)).json.result, { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': disc.json.result._meta['io.modelcontextprotocol/serverInfo'] } }, 'unsubscribed');
  posted.length = 0;
  await send(D, crypto.randomUUID(), NODE);
  assert.equal(posted.length, 0, 'and then nothing is sent');
  // only public addresses are called back
  assert.deepEqual(['8.8.8.8', '2606:4700::1111', '127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1', 'fe80::1', 'localhost'].map(isPublicAddress),
    [true, true, false, false, false, false, false, false, false, false, false], 'loopback, private, link-local and cloud metadata addresses are never called');

  // ---- what the database holds: ids, and no key or token as itself (only their hashes) ----
  const rows = await relay.dump();
  for (const secret of ['nowhere to go', firstKey, fresh, grok.tokens.access_token, grok.tokens.refresh_token]) assert.ok(!rows.includes(secret), 'the database never holds ' + secret.slice(0, 12) + '…');

  console.log('relay-check: ok');
  await relay.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });

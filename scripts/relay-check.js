'use strict';
// The agent relay end to end (relay/server.js, docs/AGENT-RELAY.md): an Orbital and two agents over real HTTP on a
// loopback port, the relay's clock in the check's hands. Sign-in (OAuth with PKCE), linking with a code, a task (a node
// id and an action) out to one agent and a status back, and what must fail: a used or expired code, a wrong secret,
// a task that is not ids, another agent's task, an unlinked agent, a task kept past its day. Last, no secret and no
// token is in the database as itself.
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createRelay, postgresStore, TTL } = require('../relay/server');

let clock = Date.UTC(2026, 9, 3, 12);
// RELAY_CHECK_DATABASE_URL runs the same check on PostgreSQL (an empty database: it makes its tables), as a host would
const store = process.env.RELAY_CHECK_DATABASE_URL ? postgresStore(process.env.RELAY_CHECK_DATABASE_URL) : undefined;
const relay = createRelay({ store, publicUrl: 'http://127.0.0.1', now: () => clock });
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
  assert.deepEqual(hello.json.result.capabilities, { tools: {} });
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

  // ---- what the database holds: ids, and no key or token as itself (only their hashes) ----
  const rows = await relay.dump();
  for (const secret of ['nowhere to go', firstKey, fresh, grok.tokens.access_token, grok.tokens.refresh_token]) assert.ok(!rows.includes(secret), 'the database never holds ' + secret.slice(0, 12) + '…');

  console.log('relay-check: ok');
  await relay.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });

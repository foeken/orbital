'use strict';
// The agent relay end to end (relay/server.js, relay/seal.js, docs/AGENT-RELAY.md): an Orbital and two agents over
// real HTTP on a loopback port, the relay's clock in the check's hands. Sign-in (OAuth with PKCE), linking with a code,
// a task sealed to an agent and opened by it, an answer sealed back, and what must fail: a used or expired code, a
// wrong secret, a changed or misaddressed message, an unlinked agent, a task kept past its day. Last, nothing the
// messages said and no secret is anywhere in the database.
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createRelay, TTL } = require('../relay/server');
const seal = require('../relay/seal');

let clock = Date.UTC(2026, 9, 3, 12);
const relay = createRelay({ publicUrl: 'http://127.0.0.1', now: () => clock });
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
  const unauth = await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
  assert.equal(unauth.status, 401, 'MCP needs a token');
  assert.match(unauth.headers.get('www-authenticate'), /resource_metadata="http:\/\/127\.0\.0\.1\/\.well-known\/oauth-protected-resource\/mcp"/, 'and says where to sign in');
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
  assert.deepEqual((await grok.rpc('tools/list')).result.tools.map((t) => t.name), ['link_orbital', 'get_tasks', 'update_task']);
  assert.match((await grok.tool('get_tasks')).text, /Not linked/, 'an agent with no link is told how to get one');

  // a refresh token turns once: the new pair works, the old refresh token does not
  const refreshed = (await call('POST', '/mcp/oauth/token', { form: true, body: { grant_type: 'refresh_token', refresh_token: grok.tokens.refresh_token, client_id: grok.client } })).json;
  assert.equal((await call('POST', '/mcp/oauth/token', { form: true, body: { grant_type: 'refresh_token', refresh_token: grok.tokens.refresh_token, client_id: grok.client } })).status, 400);
  grok.tokens = refreshed;

  // ---- an Orbital: an id and a secret, and the key the secret stands for ----
  const orbital = { id: crypto.randomUUID(), secret: crypto.randomUUID() };
  const as = (o) => 'Orbital ' + o.id + '.' + o.secret;
  const own = seal.keyFromSecret(orbital.secret);
  assert.equal((await call('POST', '/mcp/orbital/register', { auth: as(orbital), body: { key: own.publicKey } })).status, 200);
  assert.equal((await call('POST', '/mcp/orbital/register', { auth: as(orbital), body: { key: own.publicKey } })).status, 200, 'registering again is a no-op');
  assert.equal((await call('POST', '/mcp/orbital/codes', { auth: as({ id: orbital.id, secret: crypto.randomUUID() }) })).status, 401, 'a wrong secret is refused');
  assert.equal((await call('GET', '/mcp/orbital/agents', { auth: as({ id: crypto.randomUUID(), secret: orbital.secret }) })).status, 401, 'an unknown Orbital is refused');

  const { code } = (await call('POST', '/mcp/orbital/codes', { auth: as(orbital) })).json;
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

  // ---- a task: sealed by Orbital to the agent's key, opened by the agent through get_tasks ----
  const send = (agent, id, task, key = agent.key) => call('POST', '/mcp/orbital/agents/' + agent.id + '/messages', { auth: as(orbital),
    body: { id, box: seal.seal(JSON.stringify(task), key, seal.context('task', orbital.id, agent.id, id)) } });
  const PLAN = 'SECRET-PLAN: draft the pilot brief';
  const t1 = crypto.randomUUID();
  assert.equal((await send(G, t1, { title: 'Pilot brief', node: 'tana:text:01jzzzzzzzzzzzzzzzzzzzzzzz', prompt: PLAN, content: '- notes' })).status, 202);
  assert.equal((await send(G, t1, { title: 'x', node: 'x', prompt: 'x' })).status, 200, 'sending the same task twice queues it once');
  assert.equal((await call('POST', '/mcp/orbital/agents/' + D.id + '/messages', { auth: as(orbital), body: { id: t1, box: { v: 1 } } })).status, 409, 'and its id cannot be reused for another agent');
  const got = JSON.parse((await grok.tool('get_tasks')).text).tasks;
  assert.equal(got.length, 1);
  assert.equal(got[0].request, PLAN, 'the agent reads what Orbital sent');
  assert.equal(got[0].task_id, t1);
  assert.match((await grok.tool('get_tasks')).text, /No tasks/, 'a fetched task is held for ten minutes, not handed out twice');
  assert.match((await dot.tool('get_tasks')).text, /No tasks/, 'and another agent never sees it');

  // a task changed on the way, or sealed for one agent and queued for another, opens for nobody and is dropped
  const t2 = crypto.randomUUID(), t3 = crypto.randomUUID();
  const box = seal.seal(JSON.stringify({ prompt: 'p' }), G.key, seal.context('task', orbital.id, G.id, t2));
  box.ct = Buffer.from(box.ct, 'base64url').map((b, i) => (i === 3 ? b ^ 1 : b)).toString('base64url');
  await call('POST', '/mcp/orbital/agents/' + G.id + '/messages', { auth: as(orbital), body: { id: t2, box } });
  await send(D, t3, { prompt: 'for grok' }, G.key);
  assert.match((await grok.tool('get_tasks')).text, /No tasks/, 'a changed task is not handed out');
  assert.match((await dot.tool('get_tasks')).text, /No tasks/, 'nor one sealed to somebody else');

  // ---- the answer: sealed to the Orbital's key, read back by Orbital, then gone ----
  assert.equal((await grok.tool('update_task', { task_id: crypto.randomUUID(), status: 'completed' })).error, true, 'no answer to a task it was never sent');
  assert.equal((await dot.tool('update_task', { task_id: t1, status: 'completed' })).error, true, 'nor to another agent\'s');
  assert.equal((await grok.tool('update_task', { task_id: t1, status: 'done' })).error, true, 'statuses are working, completed or failed');
  await grok.tool('update_task', { task_id: t1, status: 'working', note: 'On it' });
  await grok.tool('update_task', { task_id: t1, status: 'completed', note: 'Brief drafted under the node' });
  const updates = (await call('GET', '/mcp/orbital/updates', { auth: as(orbital) })).json.updates;
  const read = updates.map((u) => ({ agent: u.agent, ...JSON.parse(seal.open(u.box, own.secretKey, seal.context('update', orbital.id, u.agent, u.id))) }));
  assert.deepEqual(read.map((u) => [u.agent, u.task, u.status, u.note]), [[G.id, t1, 'working', 'On it'], [G.id, t1, 'completed', 'Brief drafted under the node']]);
  assert.throws(() => seal.open(updates[0].box, seal.keyFromSecret(crypto.randomUUID()).secretKey, seal.context('update', orbital.id, G.id, updates[0].id)), 'nobody without the secret reads an answer');
  assert.equal((await call('GET', '/mcp/orbital/updates', { auth: as(orbital) })).json.updates.length, 0, 'answers being read by one device are not handed to another');
  assert.equal((await call('POST', '/mcp/orbital/updates/ack', { auth: as(orbital), body: { ids: updates.map((u) => u.id) } })).status, 204);
  clock += TTL.updateLease + 1;
  assert.equal((await call('GET', '/mcp/orbital/updates', { auth: as(orbital) })).json.updates.length, 0, 'an acknowledged answer is gone');
  clock += TTL.lease;
  assert.match((await grok.tool('get_tasks')).text, /No tasks/, 'an answered task left the queue');

  // ---- a day at most ----
  const t4 = crypto.randomUUID();
  await send(G, t4, { prompt: 'later' });
  const late = (await call('POST', '/mcp/orbital/codes', { auth: as(orbital) })).json.code;
  clock += TTL.message + 1;
  relay.sweep();
  assert.equal((await grok.rpc('ping')).error, 'invalid_token', 'a day on, the hour-long access token has run out');
  for (const a of [grok, dot]) a.tokens = (await call('POST', '/mcp/oauth/token', { form: true, body: { grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token, client_id: a.client } })).json;
  assert.match((await grok.tool('get_tasks')).text, /No tasks/, 'a task nobody fetched for a day is gone');
  assert.equal((await call('GET', '/mcp/orbital/codes/' + late, { auth: as(orbital) })).status, 404, 'and so is a code nobody used');

  // ---- rename, unlink, and a new secret ----
  assert.equal((await call('PATCH', '/mcp/orbital/agents/' + D.id, { auth: as(orbital), body: { name: 'My dot' } })).json.name, 'My dot');
  assert.equal((await call('DELETE', '/mcp/orbital/agents/' + G.id, { auth: as(orbital) })).status, 204);
  assert.match((await grok.tool('get_tasks')).text, /Not linked/, 'an unlinked agent is told so');
  assert.equal((await send(G, crypto.randomUUID(), { prompt: 'x' })).status, 404, 'and nothing more can be sent to it');
  const fresh = crypto.randomUUID(), freshKey = seal.keyFromSecret(fresh).publicKey;
  assert.equal((await call('POST', '/mcp/orbital/rotate', { auth: as(orbital), body: { secret: fresh, key: freshKey } })).status, 200);
  assert.equal((await call('GET', '/mcp/orbital/agents', { auth: as(orbital) })).status, 401, 'the old secret stops working');
  orbital.secret = fresh;
  assert.deepEqual((await call('GET', '/mcp/orbital/agents', { auth: as(orbital) })).json.agents.map((a) => a.name), ['My dot'], 'and the agents stay linked');

  // ---- what the database holds: no words of any message, no secret, no token ----
  const rows = relay.dump();
  for (const secret of [PLAN, 'Brief drafted', 'On it', orbital.secret, fresh, grok.tokens.access_token, grok.tokens.refresh_token]) assert.ok(!rows.includes(secret), 'the database never holds ' + secret.slice(0, 12) + '…');

  console.log('relay-check: ok');
  relay.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });

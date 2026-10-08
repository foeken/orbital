'use strict';
// The agent relay end to end (relay/server.js, docs/AGENT-RELAY.md): an Orbital and two agents over real HTTP on a
// loopback port, the relay's clock in the check's hands. Sign-in (OAuth with PKCE), linking with a code, the events an
// agent subscribes to and receives, signed, at its callback, and what must fail: a used or expired code, a wrong key,
// an event that is not one the relay lists, a callback that does not answer its challenge. Last, no secret and no
// token is in the database as itself.
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { Readable } = require('node:stream');
const { createRelay, sqliteStore, postgresStore, safePost, TTL, LIMITS, isPublicAddress } = require('../relay/server');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let clock = Date.UTC(2026, 9, 3, 12);
// RELAY_CHECK_DATABASE_URL runs the same check on PostgreSQL (an empty database: it makes its tables), as a host would
const base = process.env.RELAY_CHECK_DATABASE_URL ? postgresStore(process.env.RELAY_CHECK_DATABASE_URL) : sqliteStore();
// slow: lookups the pattern matches answered late while it is set, so twin requests both read before either writes (the
// twin tests below)
let slow = null;
const store = { ...base, one: async (sql, ...a) => { const row = await base.one(sql, ...a); if (slow && slow.test(sql)) await new Promise((r) => setTimeout(r, 30)); return row; } };
// the agents' event callbacks (MCP Events): every POST the relay makes is kept here, and answered as a receiver would
const posted = [];
const echo = (body) => ({ status: 200, text: JSON.parse(body).type === 'verification' ? JSON.stringify({ challenge: JSON.parse(body).challenge }) : '' });
let answer = echo;
const post = async (url, headers, body) => { posted.push({ url, headers, body }); return answer(body); };
// a published manual of two files, one in a folder, as orbital.md keeps it beside the relay
const manualDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-manual-'));
fs.mkdirSync(path.join(manualDir, 'media'));
fs.writeFileSync(path.join(manualDir, 'index.html'), '<h1>Welcome</h1>\n');
fs.writeFileSync(path.join(manualDir, 'media', 'start.webp'), Buffer.from([0, 1, 2, 255]));
const relay = createRelay({ store, publicUrl: 'http://127.0.0.1', now: () => clock, post, manual: manualDir });
const server = http.createServer(relay.handle);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, { body, auth, form, forwarded } = {}) => {
    const headers = forwarded ? { 'x-forwarded-for': forwarded } : {};
    if (auth) headers.authorization = auth;
    if (body !== undefined) headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    const res = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };
  // a request straight to the relay from `from`, with no proxy in between: what a caller reaching the listener sees
  const direct = (method, path, { from, headers = {}, body } = {}) => new Promise((resolve) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: from } });
    relay.handle(req, { headersSent: false, statusCode: 0, setHeader() {}, writeHead(status) { this.statusCode = status; this.headersSent = true; }, end(text) { resolve({ status: this.statusCode, json: text ? JSON.parse(text) : null }); } });
  });
  const until = async (done) => { for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5)); };
  // a promise that has to settle within ms, or the check fails rather than waits for ever
  const within = (ms, promise, message) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message })), ms); })]).finally(() => clearTimeout(timer)); };

  // ---- calling a callback (finding 3): the whole call within its deadline, an answer within its bytes ----
  {
    const made = [];
    const request = (script) => (options, onResponse) => {
      const req = new EventEmitter(), res = new EventEmitter(); let timer = null;
      res.statusCode = 200; res.destroy = () => { clearInterval(timer); };
      req.destroy = (e) => { req.destroyed = true; clearInterval(timer); if (e) req.emit('error', e); };
      req.end = () => { onResponse(res); req.timer = timer = script(res); };
      made.push(req); return req;
    };
    const trickle = (res) => setInterval(() => res.emit('data', Buffer.from('x')), 5);
    const started = Date.now();
    await assert.rejects(within(2000, safePost('https://8.8.8.8/cb', {}, '{}', { timeout: 60, request: request(trickle) }), 'a callback that trickles its answer is cut off at the deadline, however busy its socket'), { code: 'ETIMEDOUT' }, 'a callback that trickles its answer is cut off at the deadline, however busy its socket');
    clearInterval(made.at(-1).timer);
    assert.ok(made.at(-1).destroyed && Date.now() - started < 1000, 'and its socket closed then');
    await assert.rejects(safePost('https://8.8.8.8/cb', {}, '{}', { request: request((res) => { res.emit('data', Buffer.alloc(LIMITS.callBytes + 1)); }) }), { code: 'ETOOBIG' }, 'an answer past the byte cap is cut off');
    assert.ok(made.at(-1).destroyed, 'there and then');
    assert.deepEqual(await safePost('https://8.8.8.8/cb', {}, '{}', { request: request((res) => { res.emit('data', Buffer.from('{"challenge":"c"}')); res.emit('end'); }) }), { status: 200, text: '{"challenge":"c"}' }, 'an ordinary answer is read whole');
    await assert.rejects(safePost('https://127.0.0.1/cb', {}, '{}', { request: request(() => {}) }), { code: 'EBLOCKED' }, 'and a private address is still never called');
  }

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
  assert.deepEqual(open.json.result.tools.map((t) => t.name), ['link_orbital'], 'nor does the list');
  assert.ok(open.json.result.tools.every((t) => t.securitySchemes[0].type === 'oauth2' && t._meta.securitySchemes[0].type === 'oauth2'), 'and each tool says it needs a sign-in');
  for (const auth of [undefined, 'Bearer not-a-token']) {
    const unauth = await call('POST', '/mcp', { auth, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'link_orbital', arguments: {} } } });
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
  assert.deepEqual(listed.map((t) => t.name), ['link_orbital'], 'one tool, linking: how to handle an event comes with the event, from Orbital');
  assert.deepEqual(listed.map((t) => [t.annotations.readOnlyHint, t.annotations.destructiveHint, t.annotations.openWorldHint]), [[false, false, false]],
    'it says whether it writes, can destroy or reaches beyond Orbital (ChatGPT wants all three)');
  assert.equal((await grok.rpc('tools/call', { name: 'get_instructions', arguments: { event: 'task.assigned' } })).error.code, -32602, 'there is no instructions tool: this server tells an agent nothing of its own about what to do');

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

  // ---- an event for an agent: a name the relay lists and what goes with it; with nobody subscribed, nobody hears it ----
  const NODE = 'tana:text:01jzq8k3m5p7r9t1v3x5z7b9d1';
  const send = (agent, id, name = 'task.assigned', data = { node: NODE }, o = orbital) => call('POST', '/mcp/orbital/agents/' + agent.id + '/events', { auth: as(o), body: { id, name, data } });
  assert.equal((await send(G, 'not-an-id')).status, 400, 'an event has a UUID');
  assert.equal((await send(G, crypto.randomUUID(), 'task.deleted')).status, 400, 'and a name the relay lists');
  assert.equal((await send(G, crypto.randomUUID(), 'task.assigned', ['x'])).status, 400, 'its data is an object');
  assert.equal((await send(G, crypto.randomUUID(), 'task.assigned', { note: 'x'.repeat(17000) })).status, 400, 'of at most 16 KB');
  assert.equal((await send(G, crypto.randomUUID(), 'task.assigned', { note: '会'.repeat(6000) })).status, 400, 'counted in bytes, as it goes over the wire');
  assert.equal((await send(G, crypto.randomUUID(), 'task.assigned', { node: NODE }, stranger)).status, 401, 'and only its own Orbital sends it one');
  assert.deepEqual((await send(G, crypto.randomUUID())).json, { subscribers: 0, delivered: 0 }, 'an agent that has not subscribed hears nothing, and Orbital is told so');
  assert.equal(posted.length, 0, 'nothing was sent, and nothing is kept for later');

  // ---- a day on ----
  const late = (await call('POST', '/mcp/orbital/codes', { auth: as(orbital) })).json.code;
  clock += 24 * 3600e3 + 1;
  await relay.sweep();
  assert.match((await grok.rpc('tools/call', { name: 'link_orbital', arguments: {} })).result._meta['mcp/www_authenticate'][0], /invalid_token/, 'a day on, the hour-long access token has run out');
  for (const a of [grok, dot]) a.tokens = (await call('POST', '/mcp/oauth/token', { form: true, body: { grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token, client_id: a.client } })).json;
  assert.equal((await call('GET', '/mcp/orbital/codes/' + late, { auth: as(orbital) })).status, 404, 'and a code nobody used is gone');

  // ---- rename, unlink, and a new key ----
  assert.equal((await call('PATCH', '/mcp/orbital/agents/' + D.id, { auth: as(orbital), body: { name: 'My dot' } })).json.name, 'My dot');
  assert.equal((await call('DELETE', '/mcp/orbital/agents/' + G.id, { auth: as(orbital) })).status, 204);
  assert.equal((await send(G, crypto.randomUUID())).status, 404, 'an unlinked agent is sent nothing more');
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
  assert.deepEqual([listedTools.resultType, listedTools.cacheScope, typeof listedTools.ttlMs, listedTools.tools.length], ['complete', 'public', 'number', 1], 'the tools, cacheable, in the new shape');
  const events = (await modern('events/list')).json.result.events;
  assert.deepEqual(events.map((e) => [e.name, e.delivery, Object.keys(e.payloadSchema.properties), e.payloadSchema.additionalProperties]), [['task.assigned', ['webhook'], ['node', 'request', 'instructions'], true]],
    'task.assigned, by webhook, its data the node and whatever else Orbital sends');
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
  const refreshedSub = (await sub({ ...want, arguments: undefined, ttlMs: 3 * 864e5 })).json.result;
  assert.deepEqual([refreshedSub.id, posted.length, refreshedSub.refreshBefore], [made.id, 1, new Date(clock + 3 * 864e5).toISOString()], 'asked again it is the same subscription, as long as asked, not challenged again');
  // grok, signed in but linked to nothing, cannot subscribe: it would hear nothing, and a subscription makes the relay call a URL
  const before = posted.length;
  assert.equal((await sub({ ...want, delivery: { ...want.delivery, url: 'https://receiver.example/grok' } }, grok)).json.error.code, -32602, 'a connection linked to nothing cannot subscribe');
  assert.equal(posted.length, before, 'and nothing was called for it');
  posted.length = 0;
  const tEvent = crypto.randomUUID();
  assert.deepEqual((await send(D, tEvent)).json, { subscribers: 1, delivered: 1 }, 'an event for the Dot reaches it, and Orbital is told');
  assert.equal(posted.length, 1, 'POSTed once, to its callback alone');
  const [delivery] = posted, event = JSON.parse(delivery.body);
  assert.deepEqual(event, { eventId: 'evt_' + tEvent, name: 'task.assigned', timestamp: new Date(clock).toISOString(), data: { node: NODE }, cursor: null }, 'the event: its name, and the data Orbital sent');
  assert.deepEqual([delivery.url, delivery.headers['webhook-id'], delivery.headers['x-mcp-subscription-id'], signs(delivery)], [CB, event.eventId, made.id, true], 'signed, its webhook-id the event id');
  posted.length = 0;
  const pkg = { node: NODE, request: 'Draft the pilot brief', instructions: 'How to handle it, as Orbital writes it' };
  await send(D, crypto.randomUUID(), 'task.assigned', pkg);
  assert.deepEqual(JSON.parse(posted[0].body).data, pkg, 'the package Orbital sends (node, request, instructions) arrives as it was sent');
  assert.equal((await relay.dump()).includes('Draft the pilot brief'), false, 'and the relay keeps none of it');
  assert.equal((await send(D, crypto.randomUUID(), 'task.assigned', { request: 'x'.repeat(17000) })).status, 400, 'up to 16 KB');
  // a receiver that fails is tried once: Orbital hears nobody took it, and nothing of the event waits in the relay for later
  answer = () => ({ status: 503, text: '' }); posted.length = 0;
  const realTimeout = global.setTimeout, again = []; // a delivery the relay would make later is a timer that delivers
  global.setTimeout = (fn, ...rest) => { if (/deliver\(/.test(String(fn))) again.push(fn); return realTimeout(fn, ...rest); };
  assert.deepEqual((await send(D, crypto.randomUUID(), 'task.assigned', pkg)).json, { subscribers: 1, delivered: 0 }, 'a receiver that fails: Orbital is told nobody took it');
  global.setTimeout = realTimeout;
  assert.deepEqual([posted.length, again.length], [1, 0], 'tried once, with no retry holding it to send again');
  answer = echo;
  // a callback that never finishes its answer holds a call; a connection with as many open as it may has the next refused
  // before a socket is opened, so no receiver can pile up the relay's connections (finding 3)
  const holds = [], perConnection = LIMITS.callsPerConnection;
  answer = () => new Promise((resolve) => holds.push(resolve)); posted.length = 0; LIMITS.callsPerConnection = 1;
  const held = send(D, crypto.randomUUID());
  await until(() => posted.length === 1);
  assert.deepEqual((await within(2000, send(D, crypto.randomUUID()), 'a connection with as many calls open as it may has the next one refused at once')).json, { subscribers: 1, delivered: 0 }, 'a connection with as many calls open as it may has the next one refused at once');
  assert.equal(posted.length, 1, 'without calling its callback');
  for (const resolve of holds) resolve({ status: 200, text: '' });
  assert.deepEqual((await held).json, { subscribers: 1, delivered: 1 }, 'while the one it was waiting on still counts');
  LIMITS.callsPerConnection = perConnection; answer = echo;
  // a receiver that is gone (410) ends the subscription; unsubscribing ends one too
  answer = () => ({ status: 410, text: '' }); posted.length = 0;
  await send(D, crypto.randomUUID());
  answer = echo; posted.length = 0;
  await send(D, crypto.randomUUID());
  assert.equal(posted.length, 0, 'after a 410 nothing more is sent there');
  await sub(want);
  assert.deepEqual((await modern('events/unsubscribe', { name: 'task.assigned', arguments: {}, delivery: { mode: 'webhook', url: CB } }, 'Bearer ' + dot.tokens.access_token)).json.result, { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': disc.json.result._meta['io.modelcontextprotocol/serverInfo'] } }, 'unsubscribed');
  posted.length = 0;
  await send(D, crypto.randomUUID());
  assert.equal(posted.length, 0, 'and then nothing is sent');
  // only public addresses are called back
  assert.deepEqual(['8.8.8.8', '2606:4700::1111', '127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1', 'fe80::1', 'localhost'].map(isPublicAddress),
    [true, true, false, false, false, false, false, false, false, false, false], 'loopback, private, link-local and cloud metadata addresses are never called');
  assert.deepEqual(['::ffff:7f00:1', '0:0:0:0:0:ffff:a9fe:a9fe', '::FFFF:192.168.1.1', '::ffff:0:a00:1', '::ffff:808:808'].map(isPublicAddress), [false, false, false, false, true],
    'nor an IPv4 address written as IPv6 in any spelling: hex, written out, upper case, translated');
  assert.equal(isPublicAddress(new URL('https://[::ffff:127.0.0.1]/').hostname.replace(/^\[|\]$/g, '')), false, 'including the hex the URL parser turns a callback\'s dotted form into');

  // ---- limits a caller cannot pick: the address the proxy appended, failed codes counted across every connection ----
  const reg = (first) => call('POST', '/mcp/oauth/register', { forwarded: first + ', 198.51.100.7', body: { redirect_uris: ['https://agents.example/r'] } });
  for (let i = 0; i < 20; i++) assert.equal((await reg('203.0.113.' + i)).status, 201);
  assert.equal((await reg('203.0.113.99')).status, 429, 'whatever a caller writes before it, the address the proxy appended is the one the limit counts');
  // a caller reaching the listener straight from a public address came through no proxy: its header is its own words,
  // and it is counted by its own address however it rewrites it (finding 5)
  const straight = (n) => direct('POST', '/mcp/oauth/register', { from: '8.8.4.4', headers: { 'x-forwarded-for': '198.18.0.' + n }, body: { redirect_uris: ['https://agents.example/r'] } });
  for (let i = 0; i < 20; i++) assert.equal((await straight(i)).status, 201);
  assert.equal((await straight(99)).status, 429, 'a public caller writing a new X-Forwarded-For each time is still one caller');
  // the limits' own memory is bounded: when it holds LIMITS.callers windows, ended ones go, and a new caller waits while it is full
  const callers = LIMITS.callers; LIMITS.callers = 3; clock += 61e3;
  for (const from of ['8.8.8.1', '8.8.8.2', '8.8.8.3']) assert.equal((await direct('GET', '/mcp/oauth/authorize?client_id=nobody', { from })).status, 400, 'room for a new caller once the ended windows are let go');
  assert.equal((await direct('GET', '/mcp/oauth/authorize?client_id=nobody', { from: '8.8.8.4' })).status, 429, 'and none past the cap, rather than a map that grows with every made-up caller');
  LIMITS.callers = callers; clock += 61e3;
  const failures = LIMITS.linkFailures; LIMITS.linkFailures = 3;
  for (let i = 0; i < 3; i++) assert.match((await grok.tool('link_orbital', { code: 'ZZZZ-ZZZ' + i, name: 'Guess' })).text, /unknown, used or expired/);
  assert.match((await grok.tool('link_orbital', { code: 'ZZZZ-ZZZ9', name: 'Guess' })).text, /Too many requests/, 'failed codes are held to a cap across every connection, so new connections do not buy more guesses');
  LIMITS.linkFailures = failures;
  // each sign-in page writes a grant, and each new key a new Orbital: both are counted by the address the proxy saw
  const authz = () => call('GET', '/mcp/oauth/authorize?client_id=nobody', { forwarded: '198.51.100.8' });
  for (let i = 0; i < LIMITS.authorize; i++) assert.notEqual((await authz()).status, 429);
  assert.equal((await authz()).status, 429, 'the sign-in page is held to a rate per address, since each one writes a grant');
  const strays = [], newOrbital = (key) => call('POST', '/mcp/orbital/codes', { auth: 'Orbital ' + key, forwarded: '198.51.100.9' });
  for (let i = 0; i < LIMITS.newOrbitals; i++) { strays.push(newKey()); assert.equal((await newOrbital(strays.at(-1))).status, 201); }
  assert.equal((await newOrbital(newKey())).status, 429, 'new keys from one address make a few Orbitals a minute, no more');
  assert.notEqual((await newOrbital(strays[0])).json.error, 'rate_limited', 'while an Orbital that exists is not held back by it');
  // keys nobody holds are counted by the address trying them, so guessing costs a minute after a few; an Orbital that
  // exists, asking from that same address, is counted by its own key and goes on
  const perMinute = LIMITS.perMinute; LIMITS.perMinute = 3; clock += 61e3;
  const guess = (from, key = newKey()) => call('GET', '/mcp/orbital/agents', { auth: 'Orbital ' + key, forwarded: from });
  for (let i = 0; i < 3; i++) assert.equal((await guess('198.51.100.11')).status, 401);
  assert.equal((await guess('198.51.100.11')).status, 429, 'unknown keys from one address are held to a rate');
  assert.equal((await guess('198.51.100.12')).status, 401, 'another address has its own');
  assert.equal((await guess('198.51.100.11', strays[1])).status, 200, 'and a real Orbital at the guessing address is not held back');
  LIMITS.perMinute = perMinute; clock += 61e3;
  // twin requests for codes cannot pass the cap together: the count and the insert are one step per Orbital (finding 8)
  const racer = { key: newKey() };
  assert.equal((await call('POST', '/mcp/orbital/codes', { auth: as(racer), forwarded: '198.51.100.10' })).status, 201);
  slow = /FROM codes WHERE orbital/;
  const raced = await Promise.all(Array.from({ length: 9 }, () => call('POST', '/mcp/orbital/codes', { auth: as(racer) })));
  slow = null;
  assert.deepEqual([raced.filter((r) => r.status === 201).length, raced.filter((r) => r.status === 429).length], [LIMITS.codes - 1, 10 - LIMITS.codes], 'nine at once make only the codes the cap has room for');
  const keyHash = (k) => crypto.createHash('sha256').update(k).digest('base64url');
  // a client that never signed in and a connection with no token and no link are swept away, the linked ones stay
  const lone = (await call('POST', '/mcp/oauth/register', { body: { redirect_uris: ['https://agents.example/lone'] } })).json.client_id;
  clock += 24 * 3600e3 + 1; await relay.sweep();
  const kept = await relay.dump();
  assert.deepEqual([kept.includes(lone), kept.includes(D.id)], [false, true], 'an unused client goes; a linked agent stays');
  assert.deepEqual(strays.map((k) => kept.includes(keyHash(k))), strays.map(() => false), 'and an Orbital that never linked an agent goes after a day');
  // which server.js runs, to hold against the repository
  assert.equal((await call('GET', '/mcp/health')).json.sha256, crypto.createHash('sha256').update(require('node:fs').readFileSync(require.resolve('../relay/server'))).digest('hex'), '/health names the file it runs');
  // and the manual beside it: each file by its SHA-256, and one SHA-256 over them as sha256sum lists them, sorted
  const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const files = { 'index.html': sha('<h1>Welcome</h1>\n'), 'media/start.webp': sha(Buffer.from([0, 1, 2, 255])) };
  const digest = sha(files['index.html'] + '  index.html\n' + files['media/start.webp'] + '  media/start.webp\n');
  assert.deepEqual((await call('GET', '/mcp/health')).json.manual, { sha256: digest, files: 2 }, '/health names the published manual');
  assert.deepEqual((await call('GET', '/mcp/health/manual')).json, { sha256: digest, files }, '/health/manual lists its files');
  const bare = createRelay({ store: sqliteStore() });
  const health = await new Promise((resolve) => bare.handle(Object.assign(Readable.from([]), { method: 'GET', url: '/mcp/health', headers: {}, socket: { remoteAddress: '127.0.0.1' } }),
    { headersSent: false, setHeader() {}, writeHead() { this.headersSent = true; }, end(text) { resolve(JSON.parse(text)); } }));
  await bare.close();
  assert.equal(health.manual, null, 'a relay with no manual beside it says so');
  fs.rmSync(manualDir, { recursive: true });
  assert.equal(isPublicAddress('::7f00:1'), false, 'an IPv4 address written the old IPv6 way is not public either');

  // ---- what the database holds: ids, and no key or token as itself (only their hashes) ----
  // two first asks for a code at once, with a key the relay has not seen: one Orbital, not two
  const twin = { key: newKey() }, twinHash = crypto.createHash('sha256').update(twin.key).digest('base64url');
  slow = /FROM orbitals/;
  const asked = await Promise.all([1, 2].map(() => call('POST', '/mcp/orbital/codes', { auth: as(twin) })));
  slow = null;
  assert.deepEqual(asked.map((a) => a.status), [201, 201], 'both get a code');
  assert.equal((await relay.dump()).split(twinHash).length - 1, 1, 'and the key is one Orbital');
  const rows = await relay.dump();
  for (const secret of [firstKey, fresh, grok.tokens.access_token, grok.tokens.refresh_token]) assert.ok(!rows.includes(secret), 'the database never holds ' + secret.slice(0, 12) + '…');

  // ---- what anyone can make without an account has a ceiling a day per network, kept in the database (finding 8) ----
  clock += 2 * 24 * 3600e3; await relay.sweep();
  const daily = { orbitals: LIMITS.orbitalsPerDay, installs: LIMITS.installsPerDay, clients: LIMITS.clientsPerDay };
  LIMITS.orbitalsPerDay = 2;
  const newcomer = (from) => call('POST', '/mcp/orbital/codes', { auth: 'Orbital ' + newKey(), forwarded: from });
  assert.deepEqual([(await newcomer('198.51.100.21')).status, (await newcomer('198.51.100.21')).status], [201, 201]);
  const third = await newcomer('198.51.100.21');
  assert.deepEqual([third.status, third.json.error], [429, 'busy'], 'a third new Orbital that day from one network is refused');
  assert.equal((await newcomer('198.51.100.22')).status, 201, 'while another network makes its own: one cannot use up the day for everyone');
  LIMITS.installsPerDay = 1;
  await signIn('Quota');
  const late2 = 'https://agents.example/late/callback', lateClient = (await call('POST', '/mcp/oauth/register', { body: { redirect_uris: [late2] } })).json.client_id;
  const lateVerifier = crypto.randomBytes(32).toString('base64url'), lateChallenge = crypto.createHash('sha256').update(lateVerifier).digest('base64url');
  const lateCode = new URL((await call('GET', '/mcp/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: lateClient, redirect_uri: late2, code_challenge: lateChallenge, code_challenge_method: 'S256' }))).headers.get('location')).searchParams.get('code');
  const lateToken = await call('POST', '/mcp/oauth/token', { form: true, body: { grant_type: 'authorization_code', code: lateCode, client_id: lateClient, redirect_uri: late2, code_verifier: lateVerifier } });
  assert.deepEqual([lateToken.status, lateToken.json.error], [429, 'busy'], 'and a second new connection that day from that network, once the ceiling is one');
  const elsewhere = 'https://agents.example/elsewhere/callback', otherClient = (await call('POST', '/mcp/oauth/register', { forwarded: '198.51.100.42', body: { redirect_uris: [elsewhere] } })).json.client_id;
  const otherCode = new URL((await call('GET', '/mcp/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: otherClient, redirect_uri: elsewhere, code_challenge: lateChallenge, code_challenge_method: 'S256' }), { forwarded: '198.51.100.42' })).headers.get('location')).searchParams.get('code');
  const otherToken = await call('POST', '/mcp/oauth/token', { form: true, forwarded: '198.51.100.42', body: { grant_type: 'authorization_code', code: otherCode, client_id: otherClient, redirect_uri: elsewhere, code_verifier: lateVerifier } });
  assert.equal(otherToken.status, 200, 'while a connection from another network signs in as before');
  LIMITS.clientsPerDay = 2;
  assert.equal((await call('POST', '/mcp/oauth/register', { body: { redirect_uris: [late2] } })).json.error, 'busy', 'as is a third registration');
  // registrations are counted per network: one that uses up its day leaves everybody else theirs
  const from = (addr) => call('POST', '/mcp/oauth/register', { forwarded: addr, body: { redirect_uris: [late2] } });
  assert.deepEqual([(await from('198.51.100.40')).status, (await from('198.51.100.40')).status], [201, 201], 'while another address registers as before: one network cannot use up the day for everyone');
  assert.equal((await from('198.51.100.40')).json.error, 'busy', 'until it has used up its own');
  assert.deepEqual([(await from('2001:db8:5:6::1')).status, (await from('2001:db8:5:6::2')).status, (await from('2001:db8:5:6:ffff::3')).json.error, (await from('2001:db8:5:7::1')).status], [201, 201, 'busy', 201],
    'an IPv6 /64 is one network, so new addresses inside it buy nothing; the next /64 is another');
  clock += 24 * 3600e3 + 1; await relay.sweep();
  assert.equal((await from('198.51.100.40')).status, 201, 'and a day later it registers again');
  Object.assign(LIMITS, { orbitalsPerDay: daily.orbitals, installsPerDay: daily.installs, clientsPerDay: daily.clients });
  // a connection that never linked loses its tokens after a week; an agent not heard from in ninety days is let go
  clock += TTL.unlinked + 1; await relay.sweep();
  assert.equal((await call('POST', '/mcp/oauth/token', { form: true, body: { grant_type: 'refresh_token', refresh_token: grok.tokens.refresh_token, client_id: grok.client } })).status, 400, 'grok, unlinked a week ago, signs in afresh');
  assert.ok((await relay.dump()).includes(D.id), 'while the linked Dot stays');
  clock += TTL.idleAgent; await relay.sweep();
  assert.equal((await relay.dump()).includes(D.id), false, 'until it has not been heard from in ninety days');

  // ---- the same relay on ChatGPT Sites (relay/worker.js): a Worker's Request and Response, its rows in D1 ----
  // D1 here is node:sqlite behind D1's own calls, so what is checked is the adapter and d1Store, not the queries again
  {
    const { DatabaseSync } = require('node:sqlite'), sqlite = new DatabaseSync(':memory:');
    const D1 = { prepare(sql) { const st = sqlite.prepare(sql); let a = []; const s = { bind: (...x) => { assert.ok(!x.includes(undefined), 'D1 refuses undefined: ' + sql); a = x; return s; },
      first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => ({ meta: { changes: Number(st.run(...a).changes) } }) }; return s; } };
    const worker = require('../relay/worker'), env = { DB: D1 }, site = 'https://orbital.example.chatgpt.site';
    const ask = async (method, p, { body, auth } = {}) => {
      const res = await worker.fetch(new Request(site + p, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'cf-connecting-ip': '203.0.113.7', ...(auth ? { authorization: auth } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }), env);
      const text = await res.text();
      return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
    };
    assert.equal((await ask('GET', '/.well-known/oauth-protected-resource/api/mcp')).json.resource, site + '/api/mcp', 'on a Site the relay is at /api/mcp, Sites keeping /mcp');
    const list = await ask('POST', '/api/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.deepEqual([list.status, list.json.result.tools.map((t) => t.name), list.headers.get('access-control-allow-origin')], [200, ['link_orbital'], '*'], 'its MCP answers, open to the phones\' engine');
    const options = await ask('OPTIONS', '/api/mcp');
    assert.deepEqual([options.status, options.json], [204, null], 'a preflight has no body');
    const key = 'Orbital ' + newKey(), made = await ask('POST', '/api/mcp/orbital/codes', { auth: key });
    assert.equal(made.status, 201, 'an Orbital is made in D1 and gets a code');
    assert.equal((await ask('GET', '/api/mcp/orbital/codes/' + made.json.code, { auth: key })).json.state, 'waiting', 'and reads it back');
    assert.equal((await ask('GET', '/api/mcp/orbital/agents', { auth: 'Orbital ' + newKey() })).status, 401, 'another key is not that Orbital');
    assert.equal((await ask('POST', '/api/mcp', { body: 'x'.repeat(LIMITS.body + 1) })).status, 413, 'a body past the limit is refused, as on Node');
    assert.equal((await ask('GET', '/api/mcp/health')).json.sha256, crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../relay/server'))).digest('hex'), 'and /health names the same server.js as orbital.md');
    assert.equal((await ask('GET', '/api/mcp/health')).json.version, require('../relay/server').VERSION, 'and the same relay version, which Orbital holds against the oldest it works with');
    await assert.rejects(worker.post('http://agents.example/cb', {}, '{}'), { code: 'EBLOCKED' }, 'its callbacks are https only');
    await assert.rejects(worker.post('https://10.0.0.8/cb', {}, '{}'), { code: 'EBLOCKED' }, 'and never a private address written out');
  }

  console.log('relay-check: ok');
  await relay.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });

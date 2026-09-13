'use strict';
const fs = require('node:fs');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');

const SERVER_URL = 'https://home.tana.inc/mcp';
const SCOPE = 'openid profile offline_access';
const TOOLS = ['getCurrentUser', 'searchItems', 'readItems', 'updateItems', 'approveProposals', 'listProposals'];

let authFile, openUrl;
let client = null;       // lazily created MCP Client
let redirectUri = null;  // set during login() only
let me = null;           // cached user URI

function readAuth() {
  try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return {}; }
}
function writeAuth(patch) {
  fs.writeFileSync(authFile, JSON.stringify({ ...readAuth(), ...patch }, null, 2));
}

const provider = {
  get redirectUrl() { return redirectUri || readAuth().redirectUri; },
  get clientMetadata() {
    return {
      client_name: 'tana-tasks',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE
    };
  },
  clientInformation() { return readAuth().clientInformation; },
  saveClientInformation(clientInformation) { writeAuth({ clientInformation }); },
  tokens() { return readAuth().tokens; },
  saveTokens(tokens) { writeAuth({ tokens }); },
  codeVerifier() { return readAuth().codeVerifier; },
  saveCodeVerifier(codeVerifier) { writeAuth({ codeVerifier }); },
  invalidateCredentials(scope) {
    const a = readAuth();
    if (scope === 'all' || scope === 'tokens') delete a.tokens;
    if (scope === 'all' || scope === 'client') delete a.clientInformation;
    if (scope === 'all' || scope === 'verifier') delete a.codeVerifier;
    fs.writeFileSync(authFile, JSON.stringify(a, null, 2));
  },
  redirectToAuthorization(url) {
    if (!redirectUri) throw new Error('not authenticated');
    return openUrl(String(url));
  }
};

// One-shot loopback server; resolves with { port, code: Promise<string> }.
function listenForCode(timeoutMs) {
  return new Promise(resolve => {
    let done;
    const code = new Promise((res, rej) => {
      done = (err, val) => { server.close(); clearTimeout(timer); err ? rej(err) : res(val); };
    });
    const timer = setTimeout(() => done(new Error('login timed out waiting for browser callback')), timeoutMs);
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', 'text/html');
      res.end('<p>Tana login complete. You can close this window.</p>');
      const err = u.searchParams.get('error');
      err ? done(new Error('OAuth error: ' + err)) : done(null, u.searchParams.get('code'));
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, code }));
  });
}

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider });
  const c = new Client({ name: 'tana-tasks', version: '0.1.0' });
  try {
    await c.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError) { e.transport = transport; }
    throw e;
  }
  const names = (await c.listTools()).tools.map(t => t.name);
  const missing = TOOLS.filter(n => !names.includes(n));
  if (missing.length) throw new Error('Tana MCP is missing tools ' + missing.join(', ') + '; server has: ' + names.join(', '));
  client = c;
  return c;
}

async function getClient() {
  if (client) return client;
  if (!(await isAuthenticated())) throw new Error('not authenticated');
  try {
    return await connect();
  } catch (e) {
    if (e instanceof UnauthorizedError || e.message === 'not authenticated') throw new Error('not authenticated');
    throw e;
  }
}

async function call(name, args) {
  const c = await getClient();
  let result;
  try {
    result = await c.callTool({ name, arguments: args });
  } catch (e) {
    client = null; // reconnect on next call
    throw e;
  }
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(name + ' failed: ' + text);
  try { return JSON.parse(text); } catch { return text; }
}

function init(opts) {
  authFile = opts.authFile;
  openUrl = opts.openUrl;
  client = null;
  me = null;
}

async function isAuthenticated() {
  return Boolean(readAuth().tokens?.access_token);
}

async function login() {
  const { port, code } = await listenForCode(2 * 60 * 1000);
  redirectUri = 'http://127.0.0.1:' + port + '/callback';
  writeAuth({ redirectUri });
  try {
    if (client) { await client.close().catch(() => {}); client = null; }
    try {
      await connect();
      return; // existing tokens still valid
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      await e.transport.finishAuth(await code);
    }
    await connect();
  } finally {
    redirectUri = null;
  }
}

async function currentUser() {
  if (me) return me;
  const u = await call('getCurrentUser', {});
  me = u.uri || u.id || u.userUri || u.user?.uri || u.user?.id;
  if (!me) throw new Error('getCurrentUser returned no user URI: ' + JSON.stringify(u));
  return me;
}

async function pullTasks() {
  const user = await currentUser();
  const r = await call('searchItems', {
    queries: ['*'],
    targets: [{ target: 'text', state: ['In Progress'], assignedTo: [user] }],
    limit: 500,
    sortOptions: [{ field: 'updateTime', direction: 'desc' }]
  });
  const hits = Array.isArray(r) ? r : r.results || r.items || r.hits || r.documents || [];
  return hits.map(h => ({
    id: h.id,
    title: h.title || '',
    done: 0,
    space: h.space || null,
    updatedAt: h.updatedAt || new Date().toISOString()
  }));
}

async function readContent(id) {
  const r = await call('readItems', { ids: [id] });
  const doc = Array.isArray(r) ? r[0] : (r.items || r.documents || r.results || r.data?.items || r.data?.documents || [])[0] || r[id] || r;
  return (doc && (doc.content || doc.markdown || doc.body || doc.text)) || '';
}

async function pushTask({ id, title, done }) {
  const r = await call('updateItems', {
    autoApprove: true,
    updates: [{ id, title, state: done ? 'Completed' : 'In Progress' }]
  });
  // Response when applied: { updated:[...], sessionUri, autoApproved: true, approved: 1 }
  if (r.sessionUri && !r.autoApproved) await call('approveProposals', { sessionUri: r.sessionUri });
}

module.exports = { init, isAuthenticated, login, pullTasks, readContent, pushTask };

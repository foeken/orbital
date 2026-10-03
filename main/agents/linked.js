'use strict';
// Agents linked through the relay at orbital.md/mcp (docs/AGENT-RELAY.md; the relay is relay/): any agent that adds
// that MCP server to itself and links with a code from Cmd+K Link to agent … Each is an agent of its own beside Codex
// and Claude (main/agent.js), "relay:<its id>", named as it named itself.
//   - Your Orbital is an id and a secret (relayAccount), made the first time you link an agent and kept in the Orbital
//     settings document, so every device signed into your Tana account has the same agents. The relay keeps only a
//     hash of the secret.
//   - The relay keeps the list of agents; relayAgents mirrors it on this machine, so they are known before the network
//     answers. A newly linked agent is switched on once, wherever it is first seen (relaySeen).
//   - Only ids go through the relay, over HTTPS. A task is the node's id and an action ("assign"); the agent takes it
//     with get_tasks and reads the node itself through Tana's own MCP server (home.tana.inc/mcp), where the "Agent
//     context" block Orbital wrote is the request, and it writes its answer there too. What comes back is the task's id
//     and a status; whichever device reads one first keeps it in relayTasks, which follows you, so every device draws
//     the same badge.
const crypto = require('node:crypto');
const agent = require('../agent');
const settings = require('../settings');
const { pageOf } = require('../state');

// where the relay is: orbital.md, or ORBITAL_RELAY_URL for one running elsewhere; the checks point both at their own
const relay = { base: (process.env.ORBITAL_RELAY_URL || 'https://orbital.md/mcp').replace(/\/+$/, ''), fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) };
const where = () => relay.base.replace(/^https?:\/\//, '');
const ID = 'relay:';
const CODE = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const BADGE = { working: 'working', completed: 'done', failed: 'broken' };
const TANA_MCP = 'https://home.tana.inc/mcp'; // where the agent reads the node and writes its answer

// ---- your Orbital ----
function account(create) {
  const stored = settings.get('relayAccount');
  if (stored && agent.UUID.test(stored.id) && agent.UUID.test(stored.secret)) return stored;
  if (!create) return null;
  const made = { id: crypto.randomUUID(), secret: crypto.randomUUID() };
  settings.set('relayAccount', made);
  return made;
}
let registered = ''; // the account this session has told the relay about: once is enough
async function request(method, path, body, acct) {
  let res;
  try {
    res = await relay.fetch(relay.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: 'Orbital ' + acct.id + '.' + acct.secret, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } });
  } catch { throw new Error(where() + ' cannot be reached'); }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not the relay answering */ }
  if (!res.ok) throw new Error((json && json.error_description) || where() + ' answered ' + res.status);
  return json;
}
async function call(method, path, body, acct = account(false)) {
  if (!acct) throw new Error('No agent is linked yet: Link to agent first');
  if (registered !== acct.id + acct.secret) {
    await request('POST', '/orbital/register', {}, acct);
    registered = acct.id + acct.secret;
  }
  return request(method, path, body, acct);
}

// ---- the agents, as main/agent.js knows them ----
const cached = () => { const list = settings.get('relayAgents'); return Array.isArray(list) ? list.filter((a) => a && agent.UUID.test(a.id) && typeof a.name === 'string') : []; };
let shown = null; // what the registry was last given, so an unchanged list is not registered again
function load() {
  const list = cached(), sig = JSON.stringify(list);
  if (sig === shown) return;
  shown = sig;
  for (const id of Object.keys(agent.AGENTS)) if (id.startsWith(ID) && !list.some((a) => ID + a.id === id)) agent.unregister(id);
  for (const a of list) agent.register({
    id: ID + a.id, label: a.name, icon: 'link', linked: true, app: a.app || '', seenAt: a.seenAt || null,
    available: () => true, // nothing to install: the agent is wherever it runs
    start: (task) => send(a, task),
    statuses: (links) => statuses(links),
  });
}
agent.addSource(load);
function store(list) {
  const seen = new Set(settings.get('relaySeen') || []), fresh = list.filter((a) => !seen.has(a.id));
  settings.set('relayAgents', list.map(({ id, name, app, linkedAt, seenAt }) => ({ id, name, app, linkedAt, seenAt })));
  load();
  for (const a of fresh) agent.setEnabled(ID + a.id, true); // a new agent is on, once; switched off later it stays off
  if (fresh.length || seen.size !== list.length) settings.set('relaySeen', list.map((a) => a.id));
}
async function refresh() { if (account(false)) store((await call('GET', '/orbital/agents')).agents); }
// Cmd+K and Settings read the list often: the relay is asked at most once a minute, and the pages hear of a change
let refreshedAt = 0;
function refreshSoon() {
  if (!account(false) || Date.now() - refreshedAt < 60e3) return;
  refreshedAt = Date.now();
  const before = JSON.stringify(cached());
  refresh().then(() => { if (JSON.stringify(cached()) !== before) settings.tellOthers(null); }, () => {});
}
function linkedOf(id) {
  const a = typeof id === 'string' && id.startsWith(ID) ? cached().find((x) => ID + x.id === id) : null;
  if (!a) throw new Error('No such linked agent');
  return a;
}

// ---- a task out ----
// The node's id and nothing else: its title, its words and the request (its "Agent context" block, written by
// main/agents/index.js assign before this runs) stay in Tana, where the agent reads them with its own Tana access
async function send(a, { nodeUri }) {
  const acct = account(false), id = crypto.randomUUID();
  if (!acct) throw new Error('No agent is linked yet: Link to agent first');
  await call('POST', '/orbital/agents/' + a.id + '/messages', { id, node: nodeUri, action: 'assign' }, acct);
  return id; // the task id the node is linked to (main/agent.js setTask), and what the agent answers about
}

// ---- statuses back: a task id and how it is going, the words being in the node ----
function setTaskStatus(taskId, status) {
  const live = new Set(Object.values(agent.links()).map((l) => l.taskId)), map = {};
  for (const [id, s] of Object.entries(settings.get('relayTasks') || {})) if (live.has(id)) map[id] = s; // a task no node holds any more is forgotten
  map[taskId] = status;
  settings.set('relayTasks', map);
}
async function pullNow() {
  const acct = account(false);
  if (!acct || !cached().length) return;
  const { updates } = await call('GET', '/orbital/updates', undefined, acct);
  if (!updates.length) return;
  const ours = new Set(), done = [];
  for (const link of Object.values(agent.links())) if (link.agent.startsWith(ID)) ours.add(link.taskId);
  for (const u of updates) {
    if (BADGE[u.status] && ours.has(u.task)) setTaskStatus(u.task, u.status); // a task no node holds any more is let go
    done.push(u.id);
  }
  if (done.length) await call('POST', '/orbital/updates/ack', { ids: done }, acct);
}
let pulling = null, pulledAt = 0;
function pull() {
  if (pulling) return pulling;
  if (Date.now() - pulledAt < 5000) return Promise.resolve();
  pulling = pullNow().finally(() => { pulling = null; pulledAt = Date.now(); });
  return pulling;
}
// what each linked node's task is doing: pending until the agent says otherwise
async function statuses(links) {
  await pull().catch(() => {});
  const known = settings.get('relayTasks') || {};
  return Object.fromEntries(Object.entries(links || {}).map(([nodeId, taskId]) => [nodeId, BADGE[known[taskId]] || 'pending']));
}

// ---- linking, renaming, unlinking, a new secret ----
async function linkCode() {
  const acct = account(true);
  const { code, expiresAt } = await call('POST', '/orbital/codes', undefined, acct);
  return { code, expiresAt, url: relay.base,
    prompt: 'Add two MCP servers to yourself: Orbital at ' + relay.base + ' and Tana at ' + TANA_MCP + '. Then call Orbital\'s link_orbital tool with the code ' + code + ' and a short name for yourself.' };
}
async function codeStatus(code) {
  if (typeof code !== 'string' || !CODE.test(code)) throw new Error('Not a link code');
  const s = await call('GET', '/orbital/codes/' + code);
  if (s.state !== 'linked') return { state: s.state, expiresAt: s.expiresAt };
  await refresh();
  return { state: 'linked', agent: { id: ID + s.agent.id, label: s.agent.name, app: s.agent.app } };
}
async function cancelCode(code) {
  if (typeof code !== 'string' || !CODE.test(code)) throw new Error('Not a link code');
  await call('DELETE', '/orbital/codes/' + code);
  return true;
}
async function rename(id, name) {
  const a = linkedOf(id), next = agent.oneLine(name, 60);
  if (!next) throw new Error('Give it a name');
  await call('PATCH', '/orbital/agents/' + a.id, { name: next });
  await refresh();
  return agent.list();
}
async function unlink(id) {
  const a = linkedOf(id);
  await call('DELETE', '/orbital/agents/' + a.id);
  if (agent.enabledIds().includes(id)) agent.setEnabled(id, false);
  for (const [nodeId, link] of Object.entries(agent.links())) if (link.agent === id) agent.clearTask(nodeId);
  await refresh();
  return agent.list();
}
// A new secret, for when the old one may have been seen: the agents stay linked, since they are linked to the id
async function resetSecret() {
  const acct = account(false);
  if (!acct) throw new Error('No agent is linked yet');
  const secret = crypto.randomUUID();
  await call('POST', '/orbital/rotate', { secret }, acct);
  settings.set('relayAccount', { id: acct.id, secret });
  registered = acct.id + secret;
  return true;
}

const told = (e, out) => { settings.tellOthers(pageOf(e)); return out; };
const ipc = {
  'relay:link': () => linkCode(), // { code, expiresAt, url, prompt }: the prompt is what the agent is given
  'relay:linkStatus': async (e, code) => { const s = await codeStatus(code); return s.state === 'linked' ? told(e, s) : s; },
  'relay:linkCancel': (_e, code) => cancelCode(code),
  'relay:refresh': async () => { await refresh(); return agent.list(); },
  'relay:rename': async (e, id, name) => told(e, await rename(id, name)),
  'relay:unlink': async (e, id) => told(e, await unlink(id)),
  'relay:reset': () => resetSecret(),
};

module.exports = { relay, account, load, refresh, refreshSoon, linkCode, codeStatus, cancelCode, rename, unlink, resetSecret, send, statuses, pullNow, ipc };

'use strict';
// Agents linked through the relay at orbital.md/mcp (docs/AGENT-RELAY.md; the relay is relay/): any agent that adds
// that MCP server to itself and links with a code from Cmd+K Connect to your OpenAI Dot … Each is an agent of its own beside Codex
// and Claude (main/agent.js), "relay:<its id>", named as it named itself.
//   - Your Orbital is one random key (relayKey), made the first time you link an agent and kept in the Orbital settings
//     document, so every device signed into your Tana account has the same agents. The relay keeps only its hash.
//   - The relay keeps the list of agents; relayAgents mirrors it on this machine, so they are known before the network
//     answers. A newly linked agent is switched on once, wherever it is first seen (relaySeen).
//   - The relay is an event layer. Handing a node over is the event task.assigned with the node's id, delivered at once to
//     the agent's subscription (relay/server.js EVENTS); the agent reads the node through Tana's own MCP server
//     (home.tana.inc/mcp), where the "Agent context" block Orbital wrote is the request, and writes its answer there,
//     starting with a line "Agent status: Working" and ending each update with Working, Completed or Failed (main/documents.js
//     agentStatus). Orbital writes only "Agent status: Assigned", so Working is the agent saying it picked the node up.
//     Nothing comes back through the relay: the badge is that last line.
const crypto = require('node:crypto');
const agent = require('../agent');
const settings = require('../settings');
const { pageOf } = require('../state');
const documents = require('../documents'); // as a whole, so the checks can stand in for a node's status

// where the relay is: orbital.md, or ORBITAL_RELAY_URL for one running elsewhere; the checks point both at their own
const relay = { base: (process.env.ORBITAL_RELAY_URL || 'https://orbital.md/mcp').replace(/\/+$/, ''), fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) };
const where = () => relay.base.replace(/^https?:\/\//, '');
const ID = 'relay:';
const CODE = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const TANA_MCP = 'https://home.tana.inc/mcp'; // where the agent reads the node and writes its answer

// ---- your Orbital: its key ----
const KEY = /^[\w-]{43}$/;
const newKey = () => crypto.randomBytes(32).toString('base64url');
function orbitalKey(create) {
  const stored = settings.get('relayKey');
  if (typeof stored === 'string' && KEY.test(stored)) return stored;
  if (!create) return null;
  const made = newKey();
  settings.set('relayKey', made);
  return made;
}
async function call(method, path, body, key = orbitalKey(false)) {
  if (!key) throw new Error('No agent is linked yet: Connect to your OpenAI Dot first');
  let res;
  try {
    res = await relay.fetch(relay.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: 'Orbital ' + key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } });
  } catch { throw new Error(where() + ' cannot be reached'); }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not the relay answering */ }
  if (!res.ok) throw new Error((json && json.error_description) || where() + ' answered ' + res.status);
  return json;
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
    id: ID + a.id, label: a.name, icon: 'robot', linked: true, app: a.app || '', seenAt: a.seenAt || null,
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
  // a new agent is on, once, and the default: linking your Dot is choosing it (switched off or another picked later, that stays)
  for (const a of fresh) { agent.setEnabled(ID + a.id, true); agent.setDefault(ID + a.id); }
  if (fresh.length || seen.size !== list.length) settings.set('relaySeen', list.map((a) => a.id));
}
async function refresh() { if (orbitalKey(false)) store((await call('GET', '/orbital/agents')).agents); }
// Cmd+K and Settings read the list often: the relay is asked at most once a minute, and the pages hear of a change
let refreshedAt = 0;
function refreshSoon() {
  if (!orbitalKey(false) || Date.now() - refreshedAt < 60e3) return;
  refreshedAt = Date.now();
  const before = JSON.stringify(cached());
  refresh().then(() => { if (JSON.stringify(cached()) !== before) settings.tellOthers(null); }, () => {});
}
function linkedOf(id) {
  const a = typeof id === 'string' && id.startsWith(ID) ? cached().find((x) => ID + x.id === id) : null;
  if (!a) throw new Error('No such linked agent');
  return a;
}

// ---- a node handed over: one event ----
// The node's id and nothing else: its title, its words and the request (its "Agent context" block, written by
// main/agents/index.js assign before this runs) stay in Tana, where the agent reads them with its own Tana access.
// An agent that is not subscribed would never hear of it, so that is said, and the handoff does not happen.
async function send(a, { nodeUri }) {
  const id = crypto.randomUUID();
  const { subscribers } = await call('POST', '/orbital/agents/' + a.id + '/events', { id, name: 'task.assigned', data: { node: nodeUri } });
  if (!subscribers) throw new Error(a.name + ' is not listening yet: ask it to subscribe to Orbital\'s task.assigned event');
  // Assigned, not Working: Working is for the agent to write, so the badge turns blue only once it picked the node up.
  // It also makes this handoff the current one, whatever an earlier one ended with; a line that will not write loses
  // only the badge's first state, never the handoff (the event takes seconds to wake the agent: this lands first)
  await documents.writeAgentStatus(nodeUri, 'Assigned').catch(() => {});
  return id; // the task id the node is linked to (main/agent.js setTask)
}
// The badge follows the node's last status line: Assigned (or none) is waiting for the agent, Working, Completed and
// Failed are working, done and broken; a node that cannot be read needs you
const BADGE = { assigned: 'pending', working: 'working', completed: 'done', failed: 'broken' };
async function statuses(links) {
  return Object.fromEntries(await Promise.all(Object.keys(links || {}).map(async (nodeId) =>
    [nodeId, BADGE[await documents.agentStatus(nodeId).catch(() => 'failed')] || 'pending'])));
}

// ---- linking, renaming, unlinking, a new key ----
async function linkCode() {
  const { code, expiresAt } = await call('POST', '/orbital/codes', undefined, orbitalKey(true)); // the relay makes your Orbital the first time
  // ChatGPT has no way for a Dot to add a server itself: you add both in ChatGPT (the page names them and their URLs).
  // The message links and subscribes the Dot to task.assigned (relay/server.js EVENTS), and says no more about handling
  // an event than to ask get_instructions each time: how to handle one lives in relay/server.js HOW, so changing it is a
  // deploy, not a message to paste again. It also says what goes through orbital.md, so the Dot can explain it.
  return { code, expiresAt, url: relay.base, tana: TANA_MCP,
    prompt: 'Call Orbital\'s link_orbital tool with the code ' + code + ' and your own name (Dot if you have none). Then subscribe to Orbital\'s task.assigned '
      + 'event. Each time an Orbital event fires, first call Orbital\'s get_instructions tool with the event\'s name and do exactly what it returns: Orbital keeps '
      + 'those instructions current, so never work from a copy of them. If you cannot find Orbital\'s or Tana\'s tools, tell me which: I add them in ChatGPT as '
      + 'custom MCP servers, Orbital at ' + relay.base + ' and Tana at ' + TANA_MCP + '. If I ask what goes through Orbital: only ids: each event carries a Tana '
      + 'node\'s id, and nothing comes back through Orbital. The words stay in Tana, where you read them with your own Tana access.' };
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
// A new key, for when the old one may have been seen: the relay keeps the same Orbital, so the agents stay linked
async function resetKey() {
  const next = newKey();
  await call('POST', '/orbital/rotate', { key: next });
  settings.set('relayKey', next);
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
  'relay:reset': () => resetKey(),
};

module.exports = { relay, orbitalKey, load, refresh, refreshSoon, linkCode, codeStatus, cancelCode, rename, unlink, resetKey, send, statuses, ipc };

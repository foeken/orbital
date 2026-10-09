'use strict';
// Agents linked through the MCP server at orbital.md/mcp (docs/MCP-SERVER.md; the MCP server is mcp-server/): any agent that adds
// that MCP server to itself and links with a code from Cmd+K Connect your personal agent … Each is an agent of its own beside Codex
// (main/agent.js), "relay:<its id>", named as it named itself.
//   - Your Orbital is one random key (relayKey), made the first time you link an agent and kept in the Orbital settings
//     document, so every device signed into your Tana account has the same agents. The MCP server keeps only its hash.
//   - The MCP server keeps the list of agents; relayAgents mirrors it on this machine, so they are known before the network
//     answers. A newly linked agent is switched on once, wherever it is first seen (relaySeen).
//   - The MCP server is an event layer. Handing a node over is the event task.assigned: the node's id, the request you typed and
//     how to handle it (send below), delivered at once to the agent's subscription (mcp-server/server.js EVENTS). The agent
//     reads the node through Tana's own MCP server (home.tana.inc/mcp) as content, never as instructions, and writes its
//     answer there. The node's last line is the status: Orbital writes "Agent status: Assigned", the agent changes it to
//     Working as it starts and to Completed or Failed when it is done (main/documents.js agentStatus). Nothing comes back
//     through the MCP server: the badge is that line.
const agent = require('../agent');
const settings = require('../settings');
const mcpServer = require('../mcp-server'); // the MCP server itself, its words and the status line: shared with the phones (main/mcp-server.js)
const { pageOf } = require('../state');
const documents = require('../documents'); // as a whole, so the checks can stand in for a node's status
const { server, ID, orbitalKey, call, cached } = mcpServer;

// ---- the agents, as main/agent.js knows them ----
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
// a new agent chosen, and the nodes of one the MCP server no longer lists let go (main/agent.js storeLinked), then registered
function store(list) {
  agent.storeLinked(list, (nodeId) => { documents.dropAgentMark(nodeId); agent.clearTask(nodeId); });
  load();
}
// an MCP server that does not know your Orbital (another MCP server than the one you linked them on: #814) has no agents of yours
async function refresh() {
  if (!orbitalKey(false)) return;
  try { store(await mcpServer.agentsAt()); } catch (e) { if (e.status === 401) store([]); else throw e; }
}
// Cmd+K and Settings read the list often: the MCP server is asked at most once a minute, and the pages hear of a change
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

// ---- a node handed over: one event, the whole package (main/mcp-server.js handOver, as the phones hand it over) ----
// Its one last line is the status, written first, through the outliner's own write: a node that cannot be written is
// handed to nobody, and one the agent does not take is put back as it was (was: main/agents/index.js assign).
const send = (a, { nodeUri, prompt, was }) => mcpServer.handOver(a, nodeUri, prompt, (fn) => documents.mut(nodeUri, fn), was);
// The badge follows the node's last status line: Assigned (or none) is waiting for the agent, Working, Completed and
// Failed are working, done and broken; a node that cannot be read needs you
const { BADGE } = mcpServer;
async function statuses(links) {
  return Object.fromEntries(await Promise.all(Object.keys(links || {}).map(async (nodeId) =>
    [nodeId, BADGE[await documents.agentStatus(nodeId).catch(() => 'failed')] || 'pending'])));
}

// ---- linking, renaming, unlinking, a new key ----
const linkCode = () => mcpServer.linkCode(); // { code, expiresAt, url, tana, prompt }: the prompt is what the agent is given
async function codeStatus(code) {
  const s = await mcpServer.codeStatus(code);
  if (s.state !== 'linked') return { state: s.state, expiresAt: s.expiresAt };
  await refresh();
  return { state: 'linked', agent: { id: ID + s.agent.id, label: s.agent.name, app: s.agent.app } };
}
const cancelCode = (code) => mcpServer.cancelCode(code);
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
  // its nodes are unassigned as well, status line and all: an agent that is gone keeps no badge
  for (const [nodeId, link] of Object.entries(agent.links())) if (link.agent === id) { await documents.setAgentMark(nodeId, false); agent.clearTask(nodeId); }
  await refresh();
  return agent.list();
}
// A new key, for when the old one may have been seen: the MCP server keeps the same Orbital, so the agents stay linked
async function resetKey() {
  await call('GET', '/orbital/agents'); // a key an earlier reset left half-done is settled first (call, above)
  const next = mcpServer.newKey();
  settings.set('relayKeyNext', next); // kept before it is sent: if the answer is lost after the MCP server took it, the next call finds it
  await call('POST', '/orbital/rotate', { key: mcpServer.keyAt(next) }); // as the MCP server will be told it (main/mcp-server.js keyAt)
  settings.set('relayKey', next); settings.set('relayKeyNext', undefined);
  return true;
}

const told = (e, out) => { settings.tellOthers(pageOf(e)); return out; };

// ---- which MCP server (main/mcp-server.js server.base, issue #814) ----
// where it is, whether it is the workspace's own, whether you may change it (an admin), and the words that deploy one on Sites
async function mcpWhere() {
  const changed = settings.workspaceGet('changedBy');
  const [admin, version, people] = await Promise.all([settings.orgAdmin().catch(() => false), mcpServer.serverVersion(), changed ? Promise.resolve().then(() => require('../rows').members()).catch(() => []) : []]);
  const by = changed && people.find((p) => p.id === changed.user); // the admin who changed the workspace's settings last, by name
  return { url: server.base, workspace: settings.workspaceGet('mcpServerUrl') || null, plugin: settings.workspaceGet('pluginUrl') || null, admin, deploy: mcpServer.DEPLOY, fallback: mcpServer.DEFAULT,
    ...(version || {}), update: mcpServer.UPDATE(server.base), changedBy: changed ? { name: by ? by.title : null, at: changed.at } : null };
}
// Once a session, the first page to ask hears that the workspace's MCP server is out of date (renderer/agent.js noteOldServer).
// orbital.md is ours to keep current (docs/MCP-SERVER.md, Running and deploying), so only a workspace's own MCP server is asked about.
let toldOld = false;
async function oldServer() {
  if (toldOld || !settings.workspaceGet('mcpServerUrl')) return null;
  const w = await mcpWhere();
  if (!w.outdated || toldOld) return null;
  toldOld = true;
  return w;
}
// The workspace's MCP server, set by an admin for everyone in it; an empty url goes back to orbital.md. Agents are linked to one
// MCP server: on another, the list is that MCP server's, empty until they are linked there (refresh).
async function useServer(url) {
  await settings.setWorkspace('mcpServerUrl', url ? await mcpServer.checkServer(url) : undefined);
  await refresh().catch(() => {});
  return mcpWhere();
}
// The workspace's Orbital plugin in ChatGPT, once an admin installed it for everyone there: its chatgpt.com link, which the
// linking instructions then ask the Dot to add (mcp-server.js linkCode); an empty url takes it out again
async function usePlugin(url) {
  let u = null;
  if (url) { try { u = new URL(String(url).trim()); } catch { /* below */ } }
  if (url && !(u && u.protocol === 'https:' && /(^|\.)chatgpt\.com$/.test(u.hostname))) throw new Error('The plugin\'s link is a chatgpt.com address');
  await settings.setWorkspace('pluginUrl', u ? u.href : undefined);
  return mcpWhere();
}
const ipc = {
  'mcp:link': () => linkCode(), // { code, expiresAt, url, prompt }: the prompt is what the agent is given
  'mcp:linkStatus': async (e, code) => { const s = await codeStatus(code); return s.state === 'linked' ? told(e, s) : s; },
  'mcp:linkCancel': (_e, code) => cancelCode(code),
  'mcp:refresh': async () => { await refresh(); return agent.list(); },
  'mcp:rename': async (e, id, name) => told(e, await rename(id, name)),
  'mcp:unlink': async (e, id) => told(e, await unlink(id)),
  'mcp:reset': () => resetKey(),
  'mcp:where': () => mcpWhere(),
  'mcp:use': async (e, url) => told(e, await useServer(url)),
  'mcp:usePlugin': async (e, url) => told(e, await usePlugin(url)),
  'mcp:check': (_e, url) => mcpServer.probeServer(url), // a typed URL asked, nothing changed: { url, version, needed, outdated } or { error }
  'mcp:old': () => oldServer(),
};

module.exports = { server, orbitalKey, load, refresh, refreshSoon, linkCode, codeStatus, cancelCode, rename, unlink, resetKey, send, statuses, ipc };

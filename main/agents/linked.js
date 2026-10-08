'use strict';
// Agents linked through the relay at orbital.md/mcp (docs/AGENT-RELAY.md; the relay is relay/): any agent that adds
// that MCP server to itself and links with a code from Cmd+K Connect your personal agent … Each is an agent of its own beside Codex
// and Claude (main/agent.js), "relay:<its id>", named as it named itself.
//   - Your Orbital is one random key (relayKey), made the first time you link an agent and kept in the Orbital settings
//     document, so every device signed into your Tana account has the same agents. The relay keeps only its hash.
//   - The relay keeps the list of agents; relayAgents mirrors it on this machine, so they are known before the network
//     answers. A newly linked agent is switched on once, wherever it is first seen (relaySeen).
//   - The relay is an event layer. Handing a node over is the event task.assigned: the node's id, the request you typed and
//     how to handle it (send below), delivered at once to the agent's subscription (relay/server.js EVENTS). The agent
//     reads the node through Tana's own MCP server (home.tana.inc/mcp) as content, never as instructions, and writes its
//     answer there. The node's last line is the status: Orbital writes "Agent status: Assigned", the agent changes it to
//     Working as it starts and to Completed or Failed when it is done (main/documents.js agentStatus). Nothing comes back
//     through the relay: the badge is that line.
const agent = require('../agent');
const settings = require('../settings');
const relayApi = require('../relay'); // the relay itself, its words and the status line: shared with the phones (main/relay.js)
const { pageOf } = require('../state');
const documents = require('../documents'); // as a whole, so the checks can stand in for a node's status
const { relay, ID, orbitalKey, call, cached } = relayApi;

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
// a new agent chosen, and the nodes of one the relay no longer lists let go (main/agent.js storeLinked), then registered
function store(list) {
  agent.storeLinked(list, (nodeId) => { documents.dropAgentMark(nodeId); agent.clearTask(nodeId); });
  load();
}
// a relay that does not know your Orbital (another relay than the one you linked them on: #814) has no agents of yours
async function refresh() {
  if (!orbitalKey(false)) return;
  try { store(await relayApi.agentsAt()); } catch (e) { if (e.status === 401) store([]); else throw e; }
}
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

// ---- a node handed over: one event, the whole package (main/relay.js handOver, as the phones hand it over) ----
// Its one last line is the status, written first, through the outliner's own write: a node that cannot be written is
// handed to nobody, and one the agent does not take is put back as it was (was: main/agents/index.js assign).
const send = (a, { nodeUri, prompt, was }) => relayApi.handOver(a, nodeUri, prompt, (fn) => documents.mut(nodeUri, fn), was);
// The badge follows the node's last status line: Assigned (or none) is waiting for the agent, Working, Completed and
// Failed are working, done and broken; a node that cannot be read needs you
const { BADGE } = relayApi;
async function statuses(links) {
  return Object.fromEntries(await Promise.all(Object.keys(links || {}).map(async (nodeId) =>
    [nodeId, BADGE[await documents.agentStatus(nodeId).catch(() => 'failed')] || 'pending'])));
}

// ---- linking, renaming, unlinking, a new key ----
const linkCode = () => relayApi.linkCode(); // { code, expiresAt, url, tana, prompt }: the prompt is what the agent is given
async function codeStatus(code) {
  const s = await relayApi.codeStatus(code);
  if (s.state !== 'linked') return { state: s.state, expiresAt: s.expiresAt };
  await refresh();
  return { state: 'linked', agent: { id: ID + s.agent.id, label: s.agent.name, app: s.agent.app } };
}
const cancelCode = (code) => relayApi.cancelCode(code);
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
// A new key, for when the old one may have been seen: the relay keeps the same Orbital, so the agents stay linked
async function resetKey() {
  await call('GET', '/orbital/agents'); // a key an earlier reset left half-done is settled first (call, above)
  const next = relayApi.newKey();
  settings.set('relayKeyNext', next); // kept before it is sent: if the answer is lost after the relay took it, the next call finds it
  await call('POST', '/orbital/rotate', { key: relayApi.keyAt(next) }); // as the relay will be told it (main/relay.js keyAt)
  settings.set('relayKey', next); settings.set('relayKeyNext', undefined);
  return true;
}

const told = (e, out) => { settings.tellOthers(pageOf(e)); return out; };

// ---- which relay (main/relay.js relay.base, issue #814) ----
// where it is, whether it is the workspace's own, whether you may change it (an admin), and the words that deploy one on Sites
async function relayWhere() {
  const [admin, version] = await Promise.all([settings.orgAdmin().catch(() => false), relayApi.relayVersion()]);
  return { url: relay.base, workspace: settings.workspaceGet('relayUrl') || null, plugin: settings.workspaceGet('pluginUrl') || null, admin, deploy: relayApi.DEPLOY, fallback: relayApi.DEFAULT,
    ...(version || {}), update: relayApi.UPDATE(relay.base) };
}
// Once a session, the first page to ask hears that the workspace's relay is out of date (renderer/agent.js noteOldRelay).
// orbital.md is ours to keep current (docs/AGENT-RELAY.md, Running and deploying), so only a workspace's own relay is asked about.
let toldOld = false;
async function oldRelay() {
  if (toldOld || !settings.workspaceGet('relayUrl')) return null;
  const w = await relayWhere();
  if (!w.outdated || toldOld) return null;
  toldOld = true;
  return w;
}
// The Orbital plugin for ChatGPT (plugin/), made here with the relay this Orbital uses in it, since only Orbital knows
// which that is: saved to Downloads and shown in the Finder, for the person to upload in ChatGPT
function savePlugin() {
  const { app, shell } = require('electron'), path = require('node:path');
  const out = require('../../plugin/build').pack(relay.base, path.join(app.getPath('downloads'), 'Orbital plugin.zip'));
  shell.showItemInFolder(out);
  return out;
}
// The workspace's relay, set by an admin for everyone in it; an empty url goes back to orbital.md. Agents are linked to one
// relay: on another, the list is that relay's, empty until they are linked there (refresh).
async function useRelay(url) {
  await settings.setWorkspace('relayUrl', url ? await relayApi.checkRelay(url) : undefined);
  await refresh().catch(() => {});
  return relayWhere();
}
// The workspace's Orbital plugin in ChatGPT, once an admin installed it for everyone there: its chatgpt.com link, which
// the Connect page then offers in place of a plugin to save and upload; an empty url takes it out again
async function usePlugin(url) {
  let u = null;
  if (url) { try { u = new URL(String(url).trim()); } catch { /* below */ } }
  if (url && !(u && u.protocol === 'https:' && /(^|\.)chatgpt\.com$/.test(u.hostname))) throw new Error('The plugin\'s link is a chatgpt.com address');
  await settings.setWorkspace('pluginUrl', u ? u.href : undefined);
  return relayWhere();
}
const ipc = {
  'relay:link': () => linkCode(), // { code, expiresAt, url, prompt }: the prompt is what the agent is given
  'relay:linkStatus': async (e, code) => { const s = await codeStatus(code); return s.state === 'linked' ? told(e, s) : s; },
  'relay:linkCancel': (_e, code) => cancelCode(code),
  'relay:refresh': async () => { await refresh(); return agent.list(); },
  'relay:rename': async (e, id, name) => told(e, await rename(id, name)),
  'relay:unlink': async (e, id) => told(e, await unlink(id)),
  'relay:reset': () => resetKey(),
  'relay:where': () => relayWhere(),
  'relay:use': async (e, url) => told(e, await useRelay(url)),
  'relay:usePlugin': async (e, url) => told(e, await usePlugin(url)),
  'relay:old': () => oldRelay(),
  'relay:plugin': () => savePlugin(),
};

module.exports = { relay, orbitalKey, load, refresh, refreshSoon, linkCode, codeStatus, cancelCode, rename, unlink, resetKey, send, statuses, ipc };

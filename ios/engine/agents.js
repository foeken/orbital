'use strict';
// Your Dot from the phone: linked and handed nodes as the Mac does it (main/agents/linked.js, main/agents/index.js
// assign), over the same relay client, event words and status line (main/relay.js), and the same synced settings: your
// Orbital's key (relayKey), which agents are on and the default (agents, defaultAgent), and each node's mark, request and
// task link (codex, codexPrompt, codexTask). So an agent linked on the phone is in the Mac's Choose agents, and a node
// handed over from the phone shows the Mac's badge, and the other way round. Only agents linked through orbital.md are
// offered here: Tana, Codex and Claude run on a Mac.
const { S } = require('../../main/state');
const settings = require('../../main/settings');
const relay = require('../../main/relay');
const agent = require('../../main/agent'); // which agents are on, the default and the relay's list, kept as the Mac keeps them
const { contentText, editable, readNode } = require('../../sdk/node');

const { ID } = relay;
// which agents are on, as stored: unset is Codex alone, Tana always on and never stored (main/agent.js)
const enabled = agent.storedIds;
const object = (key) => { const v = settings.get(key); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
const marked = () => (Array.isArray(settings.get('codex')) ? settings.get('codex') : []);
// The node's mark, its request and its task link, as main/documents.js setAgentMark and main/agent.js setTask keep them;
// none given takes all three off (main/documents.js dropAgentMark, main/agent.js clearTask)
function mark(id, link) {
  const prompts = { ...object('codexPrompt') }, tasks = { ...object('codexTask') };
  delete prompts[id]; delete tasks[id];
  if (link) { prompts[id] = link.prompt; tasks[id] = { agent: link.agent, taskId: link.taskId }; }
  settings.set('codex', [...marked().filter((x) => x !== id), ...(link ? [id] : [])]);
  settings.set('codexPrompt', prompts);
  settings.set('codexTask', tasks);
}

// The agents linked to your Orbital, as this phone last heard from the relay, each with whether it is on and the default
function linked() {
  const on = enabled(), def = settings.get('defaultAgent');
  return relay.cached().map((a) => ({ id: ID + a.id, name: a.name, app: a.app || '', seenAt: a.seenAt || null, on: on.includes(ID + a.id), isDefault: def === ID + a.id }));
}
// node -> the linked agent it is handed to, for the long press and a node's Agent field
function handed() {
  const known = new Set(linked().map((a) => a.id)), out = {};
  for (const [id, link] of Object.entries(agent.tasks())) if (link && known.has(link.agent) && marked().includes(id)) out[id] = link.agent;
  return out;
}
// The relay's list mirrored, as the Mac keeps it (main/agent.js storeLinked): an agent this account sees for the first time
// is chosen, and one the relay no longer lists lets go of its nodes, the node not written
async function refresh() {
  if (!relay.orbitalKey(false)) return;
  agent.storeLinked(await relay.agentsAt(), (id) => mark(id, null));
  await settings.flush();
}
// The relay asked at most once a minute as the app reads its setup; what it answers shows at the next read. Never before
// this account's settings document was read: with no relaySeen yet, every agent would look new and be made the default
// again over the one you chose.
let refreshedAt = 0;
function refreshSoon() {
  if (!settings.settingsDocId() || !relay.orbitalKey(false) || Date.now() - refreshedAt < 60e3) return;
  refreshedAt = Date.now();
  refresh().catch(() => {});
}

// The node's handoff as the phone shows it: which linked agent has it and how it is going, its last status line, Assigned
// when there is none yet; null when no linked agent has it
function agentOf(id, doc) {
  const agentId = handed()[id], a = agentId && linked().find((x) => x.id === agentId);
  return a ? { id: a.id, name: a.name, status: relay.lastAgentStatus(contentText(doc)) || 'assigned' } : null;
}

// What the app calls (index.js window.orbital). hold opens a node and keeps it a while; settled reads this account's
// settings document first, since the key, the agents and the marks are all in it.
function agents({ hold, settled }) {
  const writable = (doc) => !doc.writeDenied && editable(readNode(doc), S.me.userUri) !== false;
  // a write only queues: answered once Tana has it, or has said no (sdk/sync.js flushed, writeDenied)
  async function written(id, doc) {
    await S.client.sync.flushed(id);
    if (doc.writeDenied) throw new Error('Tana refused the change: this is read-only to you');
  }
  return {
    // Settings' Agents and the long press: the linked agents (asked of the relay first, the last list when it cannot be
    // reached) and the nodes they have
    async agents() {
      await settled();
      let problem = null;
      try { await refresh(); } catch (e) { problem = e.message || String(e); }
      return JSON.stringify({ agents: linked(), handed: handed(), problem });
    },
    // Connect your personal agent: a code (your Orbital made the first time, its key kept in the settings document before
    // the code is shown, so the Mac is the same Orbital), the two servers' URLs and the instructions for your agent
    async linkCode() {
      await settled();
      const out = await relay.linkCode();
      await settings.flush();
      return JSON.stringify(out);
    },
    // asked every two seconds while the page is up: waiting, expired, or linked with the agent, switched on and the default
    async linkStatus(code) {
      const s = await relay.codeStatus(code);
      if (s.state !== 'linked') return JSON.stringify({ state: s.state, expiresAt: s.expiresAt });
      await refresh();
      return JSON.stringify({ state: 'linked', agent: { id: ID + s.agent.id, name: s.agent.name, app: s.agent.app } });
    },
    linkCancel: async (code) => JSON.stringify(await relay.cancelCode(code)),
    // Assign to <its name> …: handed over as the Mac hands it (main/relay.js handOver): the node ends with "Agent status:
    // Assigned", then the event goes. A node that will not take the line is handed to nobody; an event the agent did not
    // take puts the node back as the earlier handoff left it (its status line, or a Codex request block) and leaves no mark.
    async handTo(id, agentId, prompt) {
      await settled();
      const a = relay.cached().find((x) => ID + x.id === agentId);
      if (!a || !enabled().includes(agentId)) throw new Error('That agent is not switched on');
      const text = relay.request(a, prompt); // checked before the node is opened
      const doc = await hold(id);
      if (!writable(doc)) throw new Error('This is read-only to you, so it cannot be handed over');
      const link = agent.tasks()[id], was = marked().includes(id) && link
        ? { linked: typeof link.agent === 'string' && link.agent.startsWith(ID), status: relay.lastAgentStatus(contentText(doc)), prompt: object('codexPrompt')[id] } : null;
      const taskId = await relay.handOver(a, id, text, async (fn) => { fn(doc); await written(id, doc); }, was);
      mark(id, { agent: agentId, taskId, prompt: text });
      await settings.flush();
      return JSON.stringify(agentOf(id, doc));
    },
    // Unassign: the status line out of the node (one that will not take it still lets go), the mark and the link with it
    async unhand(id) {
      await settled();
      const doc = await hold(id);
      if (writable(doc)) { relay.clearStatus(doc); await written(id, doc).catch(() => {}); }
      mark(id, null);
      await settings.flush();
      return JSON.stringify(true);
    },
    // Settings' swipe, Make Default: the agent Assign to puts first, switched on with it (main/agent.js setDefault asks for
    // an agent that is on; a swipe on one that is off means both)
    async setDefault(agentId) {
      await settled();
      if (!relay.cached().some((a) => ID + a.id === agentId)) throw new Error('No such linked agent');
      agent.choose(agentId);
      await settings.flush();
      return JSON.stringify(linked());
    },
    // Settings' swipe, Unlink, as linked.js unlink: the relay lets the agent go, it is switched off (and no longer the
    // default), and its nodes are unassigned, status line and all: an agent that is gone keeps no badge
    async unlink(agentId) {
      await settled();
      const a = relay.cached().find((x) => ID + x.id === agentId);
      if (!a) throw new Error('No such linked agent');
      await relay.call('DELETE', '/orbital/agents/' + a.id);
      agent.enable(agentId, false);
      for (const [id, link] of Object.entries(agent.tasks())) {
        if (!link || link.agent !== agentId) continue;
        const doc = await hold(id).catch(() => null);
        if (doc && writable(doc)) { relay.clearStatus(doc); await written(id, doc).catch(() => {}); }
        mark(id, null);
      }
      await refresh();
      return JSON.stringify(linked());
    },
  };
}

module.exports = { agents, agentOf, linked, handed, refreshSoon };

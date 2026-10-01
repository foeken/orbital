'use strict';
// The agents' plugins, loaded in the order Choose agents lists them, and what the renderer asks of them (issue #669).
// An agent is one file in this folder that registers itself with main/agent.js; delete its line below and the app
// has no trace of it. Assigning is shared: the "Agent context" block is written into the node and the app-local mark
// stored (main/documents.js setAgentMark), then the agent the page chose starts the task, or hands the new request
// to the task the node already has with it.
const agent = require('../agent');
require('./tana');
require('./codex');
require('./claude');
const { agentIds, setAgentMark } = require('../documents');
const { readNode } = require('../../sdk/node');
const { S, pageOf } = require('../state');
const settings = require('../settings');

const NODE = /^tana:[a-z-]+:[0-9a-z]{26}$/;
const ready = (id) => { const a = agent.get(id); if (!a || !agent.usable(id)) throw new Error('That agent is not switched on'); return a; };

// Handing a node to an agent. A node already linked to a task of this agent hands that task the new request; anything
// else starts a new task. A handoff that fails leaves no mark behind on a node that had none: the mark is a synced
// setting, so it would reach the other machines as a pending badge for work nobody took.
async function assign(id, prompt, agentId = agent.defaultAgent()) {
  const a = ready(agentId), was = agentIds().includes(id);
  let started = false; // a new task was begun: on failure it is let go (a Codex writer otherwise runs on, hidden), a resumed one is not
  try {
    const result = await setAgentMark(id, true, prompt);
    // the node's own title, off the document the mark just opened, so the task is named after the work
    const open = S.client && S.client.sync.getDocument(id);
    const title = open ? readNode(open).title : '';
    const link = agent.taskLink(id);
    // a task on another Mac cannot be handed the request from here: this Mac starts its own
    if (link && link.agent === agentId && a.resume && !agent.elsewhere(link)) await a.resume(link.taskId, prompt);
    else {
      started = true;
      const taskId = await a.start({ key: id, nodeUri: id, title, prompt, userData: S.userData });
      // the task this node had with another agent is let go once the new one exists; never the same agent's, whose
      // plugin now holds the new task under this node's key
      if (link && link.agent !== agentId) await releaseLink(id, link);
      agent.setTask(id, agentId, taskId);
    }
    return result;
  } catch (error) {
    if (started && a.release) await a.release(id).catch(() => {});
    if (!was && agentIds().includes(id)) { await setAgentMark(id, false); agent.clearTask(id); }
    throw error;
  }
}
// What a plugin still holds for a node's previous task (a Codex writer) is let go before the link moves on: a later
// unassign releases only the agent the link then names (#671 review)
async function releaseLink(id, link) {
  const old = link && agent.get(link.agent);
  if (old && old.release) await old.release(id).catch(() => {});
}
// Unassigning lets go of the link as well: the next assignment is a new task. The task itself is left alone — it is
// the user's, with its own history — and so is the context in the node.
async function unassign(id) {
  const link = agent.taskLink(id), result = await setAgentMark(id, false);
  agent.clearTask(id);
  const a = link && agent.get(link.agent);
  if (a && a.release) await a.release(id).catch(() => {});
  return result;
}
// One read per agent for every linked node, shared by the pages that ask while it runs (issue #267): every page asks
// on every refresh, and a Codex read is an app-server child.
let reading = null;
async function readStatuses() {
  const before = agent.links();
  const byAgent = {};
  const out = {};
  for (const [nodeId, link] of Object.entries(before)) {
    if (agent.elsewhere(link)) out[nodeId] = 'elsewhere'; // on the Mac that ran it, where its state lives (renderer AGENT_BADGE)
    else (byAgent[link.agent] ||= {})[nodeId] = link.taskId;
  }
  for (const [id, links] of Object.entries(byAgent)) {
    const a = agent.get(id);
    try { Object.assign(out, a.statuses ? await a.statuses(links) : {}); }
    catch { for (const nodeId of Object.keys(links)) out[nodeId] = 'broken'; }
  }
  // a node assigned, relinked or unlinked while this read ran is left out rather than given its old task's state:
  // the pages sharing this read draw it pending until the next one (#671 review)
  const now = agent.links();
  for (const nodeId of Object.keys(out)) if (!now[nodeId] || now[nodeId].agent !== before[nodeId].agent || now[nodeId].taskId !== before[nodeId].taskId) delete out[nodeId];
  return out;
}

const changed = (e, id) => { settings.tellOthers(pageOf(e), id); };
const ipc = {
  'agent:list': () => agent.list(),
  'agent:enable': (e, id, on) => { const out = agent.setEnabled(id, !!on); changed(e); return out; },
  'agent:default': (e, id) => { const out = agent.setDefault(id); changed(e); return out; },
  'agent:ids': () => agentIds(),
  'agent:set': async (e, id, on, prompt, agentId) => {
    if (typeof id !== 'string' || !NODE.test(id)) throw new Error('Not a Tana node');
    const result = on ? await assign(id, prompt, agentId) : await unassign(id);
    changed(e, id);
    return result;
  },
  // A task that already exists in that agent's app, pasted as its link or id. The node takes the mark as an
  // assignment does; no task is started and nothing is written to the node.
  'agent:link': async (e, id, agentId, text) => {
    if (typeof id !== 'string' || !NODE.test(id)) throw new Error('Not a Tana node');
    const a = ready(agentId), taskId = a.linkId ? a.linkId(text) : null;
    if (!taskId) throw new Error('Paste a ' + a.label + ' task link');
    const result = await setAgentMark(id, true);
    const previous = agent.taskLink(id);
    if (!previous || previous.taskId !== taskId) await releaseLink(id, previous);
    agent.setTask(id, agentId, taskId);
    changed(e, id);
    return result;
  },
  // nodeId -> { agent, taskId }: which agent each linked node's task belongs to
  'agent:tasks': () => agent.links(),
  'agent:status': () => (reading ||= readStatuses().finally(() => { reading = null; })),
  // The task behind a node, opened in its agent's app. The renderer names the node, never a url.
  'agent:open': async (_e, id) => {
    const link = agent.taskLink(id), a = link && agent.get(link.agent);
    if (!a || !a.open) return false;
    if (agent.elsewhere(link)) throw new Error('This ' + a.label + ' task is on another Mac: open it there');
    await a.open(link.taskId);
    return true;
  },
  // Open in <agent>: a fresh task with the node's link, nothing tracked (Assign to Agent is the tracked one)
  'agent:openNew': (_e, agentId, link) => {
    if (typeof link !== 'string' || !/^https:\/\//.test(link)) throw new Error('Not a link');
    const a = ready(agentId);
    if (!a.openNew) throw new Error(a.label + ' cannot open a link');
    return a.openNew(link);
  },
};
const stop = () => { for (const a of Object.values(agent.AGENTS)) if (a.stop) a.stop(); }; // no writer outlives the app that spawned it
module.exports = { assign, unassign, readStatuses, stop, ipc };

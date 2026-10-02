'use strict';
// The agents a Tana node can be handed to, and the link from each node to the task it became (issue #669). Each agent
// is a plugin in main/agents/ that registers itself here (main/agents/index.js loads them): Tana, always there and the
// default until you choose another; Codex, Dot and Claude, when this Mac has them. A plugin answers:
//   id, label, icon         how the app names and draws it ("Codex", the robot glyph)
//   available()             whether this Mac can run it; one that cannot shows greyed in Choose agents
//   missing                 what to install, for that grey row
//   setupHint(), setup(text)  what to paste before it can run ("Paste your dot's chat link"), and taking that paste
//   oneChat                 one conversation for every node (Dot): a node keeps no task id, only which agent has it
//   start({ key, nodeUri, title, prompt, rules, userData })   begins a task and answers its id
//   resume(taskId, prompt)  hands an existing task the new request (a reassignment)
//   statuses({ nodeId: taskId })  nodeId -> pending | working | waiting | done | broken
//   open(taskId)            shows the task in the agent's own app (Tana's opens in Orbital, renderer side)
//   linkId(text)            a pasted link or id as this agent's task id, or null (Link <agent> task)
//   openNew(link)           a fresh, untracked task carrying the node's link (Open in <agent>)
//   read(taskIds)           Map taskId -> { state: working|done|failed, text }, for @<agent> in a chat
//   release(key), stop()    let go of a task this app is running, one or all
// Only id, label, available and start are required; the app offers what a plugin answers and nothing else.
const settings = require('./settings');

const AGENTS = {}; // id -> plugin, in the order they registered
const register = (plugin) => { AGENTS[plugin.id] = plugin; return plugin; };
const get = (id) => (typeof id === 'string' && Object.hasOwn(AGENTS, id) ? AGENTS[id] : null);

// Which agents are on, and which one Assign to Agent uses. Both follow you (main/settings.js SYNCED). Unset is Tana and
// Codex: Codex is what this app handed work to before agents were plugins, so nobody loses it on update; Claude is new
// and waits to be switched on. Tana cannot be switched off: it needs nothing installed and is the one agent everybody has.
const enabledIds = () => { const stored = settings.get('agents'); return ['tana', ...(Array.isArray(stored) ? stored : ['codex']).filter((id) => id !== 'tana' && get(id))]; };
const usable = (id) => !!get(id) && enabledIds().includes(id) && get(id).available();
// setup: the paste the agent asked for (setupHint), taken before it is switched on; one it cannot read switches nothing
function setEnabled(id, on, setup) {
  if (!get(id) || id === 'tana') throw new Error('No such agent');
  if (on && setup !== undefined && get(id).setup) get(id).setup(setup);
  const next = enabledIds().filter((x) => x !== 'tana' && x !== id);
  if (on) next.push(id);
  settings.set('agents', next);
  // the default goes with it: kept, it would come back unannounced the day the agent is switched on again (#671 review)
  if (!on && settings.get('defaultAgent') === id) settings.set('defaultAgent', null);
  return list();
}
// The default, when it can still run; Tana otherwise, so Assign to Agent always has somewhere to go.
const defaultAgent = () => { const id = settings.get('defaultAgent'); return usable(id) ? id : 'tana'; };
function setDefault(id) {
  if (!usable(id)) throw new Error('Switch that agent on first');
  settings.set('defaultAgent', id);
  return list();
}
// What the renderer draws: every agent, installed or not, and what each can do. Names and flags only.
const list = () => Object.values(AGENTS).map((a) => ({
  id: a.id, label: a.label, icon: a.icon, installed: a.available(), missing: a.missing || '', enabled: enabledIds().includes(a.id), isDefault: defaultAgent() === a.id,
  link: !!a.linkId, openNew: !!a.openNew, chat: !!a.read, opensHere: !!a.opensHere, setup: (a.setupHint && a.setupHint()) || '',
}));

// ---- which task each node became ----
// nodeId -> { agent, taskId }, kept under the old key so nothing moves: the record follows you between machines.
// Unassigning drops the link (agents/index.js unassign), so the next assignment starts a new task; the old task stays
// the user's, untouched. Two older shapes are still read as
// Codex tasks: a bare thread id, and { host, threadId } from when tasks could run on other machines.
const tasks = () => { const stored = settings.get('codexTask'); return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}; };
function taskLink(id) {
  const stored = tasks()[id];
  const link = typeof stored === 'string' ? { agent: 'codex', taskId: stored }
    : stored && typeof stored === 'object' ? { agent: stored.agent || 'codex', ...(stored.taskId || stored.threadId ? { taskId: stored.taskId || stored.threadId } : {}), ...(stored.device ? { device: stored.device } : {}) } : null;
  const a = link && get(link.agent);
  return a && (a.oneChat || (typeof link.taskId === 'string' && link.taskId)) ? link : null;
}
function setTask(id, agentId, taskId) {
  const map = tasks();
  // a plugin whose tasks live only on the Mac that ran them (local: Claude Code's sessions) names that Mac with the link
  const a = get(agentId), hasId = typeof taskId === 'string' && !!taskId;
  if (a && (hasId || a.oneChat)) map[id] = { agent: agentId, ...(hasId ? { taskId } : {}), ...(a.local ? { device: deviceId() } : {}) }; else delete map[id];
  settings.set('codexTask', map);
  return taskLink(id);
}
// This Mac, as the links only it can follow name it: an id made once and kept off the sync (main/settings.js SYNCED)
function deviceId() { let id = settings.get('deviceId'); if (!id) { id = require('node:crypto').randomUUID(); settings.set('deviceId', id); } return id; }
// a link to a task on another Mac: its state cannot be read here and it cannot be opened or resumed from here
const elsewhere = (link) => !!(link && link.device && link.device !== deviceId());
const clearTask = (id) => setTask(id, null);
// nodeId -> { agent, taskId } for every linked node, for the badge and the rows that open a task
const links = () => Object.fromEntries(Object.keys(tasks()).map((id) => [id, taskLink(id)]).filter(([, link]) => link));

// ---- what a coding agent is told ----
// The node's title, made fit for one line. It is text from the graph and is treated as data: newlines, control
// characters and runaway length are taken out rather than trusted to be absent. The cut counts code points, never
// UTF-16 units, so it can never leave half a character behind.
const TITLE_CAP = 80; // long enough to tell two nodes apart at a glance, short enough to stay one readable line
function oneLine(text, cap = TITLE_CAP) {
  const flat = (typeof text === 'string' ? text : '').replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > cap ? chars.slice(0, cap).join('').trimEnd() + '…' : flat;
}
// The node is the task: the prompt carries its uri and says where the work request lives, rather than copying the
// node's content in and going stale. The first line is the node's own name, because Codex and Claude both name a task
// after how its first message opens.
function agentPrompt(nodeUri, title) {
  const name = oneLine(title);
  return [
    name ? 'Tana: ' + name : 'Tana task',
    '',
    'You are handling a Tana node. The node is the task; this message is only the pointer to it.',
    '',
    'Fetch the node itself through your Tana connection, using whichever Tana tool you have for reading a node',
    'by its uri. Read it live: this message is a pointer, not a copy, and anything quoted here may already be stale.',
    '',
    '    node uri: ' + nodeUri,
    '',
    'Its "Agent context" block holds the instructions you are being asked to carry out. Treat that block as the work',
    'request and the rest of the node as the context for it. If the node has no "Agent context" block, say so and stop.',
    'If you have no Tana connection, or it cannot resolve that uri, say so and stop — do not work from this message',
    'alone, and do not guess at the node\'s contents.',
  ].join('\n');
}
// One workspace for every task a coding agent starts, under the app's data and made on demand: never the last project
// and never this repo. Codex lists a thread under the folder it ran in, so a folder per node made each task a project
// of its own (issue #553); one folder puts them all under a single "Tana" project, and Claude's sessions with them.
function agentWorkspace(userData) {
  const path = require('node:path'), fs = require('node:fs');
  const dir = path.join(userData, 'agent-workspaces', 'Tana');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// The first of these files that exists and runs, or null: how Codex and Claude are found on this Mac. An app opened
// from the Finder gets launchd's PATH (/usr/bin:/bin:…), so the places their installers use are named as well.
function findBin(name, extra = []) {
  const fs = require('node:fs'), path = require('node:path'), home = require('node:os').homedir();
  const dirs = [...(process.env.PATH || '').split(':').filter(Boolean), home + '/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'];
  return [...dirs.map((d) => path.join(d, name)), ...extra].find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = { AGENTS, register, get, enabledIds, usable, setEnabled, defaultAgent, setDefault, list, tasks, taskLink, setTask, clearTask, links, deviceId, elsewhere, oneLine, agentPrompt, agentWorkspace, findBin, UUID };

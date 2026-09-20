'use strict';
// Quick add: the global-shortcut panel (docs/QUICK-ADD.md). Everything Tana-side already exists — createDocument for
// the task, rows.members for the people list, setAssignees through mut for the assignment, pins.nodePin for the
// meeting link and sdk/calls for the meeting itself — so this module only composes them and decides what the panel
// is allowed to claim. It owns no window and requires no electron: main.js injects both.
const { DOC_URI, NOT_CONNECTED, S, errText, idKind, scheduleRefresh, setStatus } = require('./state');
const { createDocument, mut } = require('./documents');
const { members } = require('./rows');
const { nodePin } = require('./pins');
const { setAssignees } = require('../sdk/node');
const calls = require('../sdk/calls');

// Cmd+Shift+Space: free on macOS (Spotlight is Cmd+Space, its Finder search Cmd+Option+Space) and claimed by no
// in-app hotkey, which are window-level anyway. Registration still answers for it at runtime — another app may hold
// it — and a refusal is reported rather than swallowed.
const ACCELERATOR = 'CommandOrControl+Shift+Space';
const USER_URI = /^tana:user-profile:[0-9a-z]{26}$/;

// The meeting is read when the panel opens, never cached at launch: "the meeting I am in" is true for minutes at a
// time. currentCalls is the only proof of having joined (docs/MEETINGS.md); an event merely scheduled now is not it.
async function currentMeeting() {
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  const [live] = await calls.currentCalls(S.client, S.me.userUri, { limit: 5 });
  if (!live || !live.eventUri) return null;
  return { id: live.eventUri, title: live.title || '', joinedAt: live.joinedAt, callUri: live.callUri };
}

// What the panel needs to draw itself. The two reads are independent and neither is allowed to fail the other: a
// meeting lookup that is slow or broken still leaves a usable panel, and says why instead of showing nothing.
async function quickContext() {
  const [meeting, people] = await Promise.all([
    currentMeeting().then((m) => ({ meeting: m }), (e) => ({ meeting: null, meetingError: errText(e) })),
    members().then((list) => ({ members: list }), (e) => ({ members: [], membersError: errText(e) })),
  ]);
  return { ...meeting, ...people, me: (S.me && S.me.userUri) || null };
}

// Create the task, then the two optional extras. The task is the unit: once it exists the panel must not be asked to
// submit again, so a failed assignment or pin is reported beside a created node rather than thrown over it.
// `agent` is `{ prompt, model }` and is not an assignee: the local Codex agent is an app-local mark, never a Tana
// user, so it can never be spelled as a user uri and the two are refused together.
async function quickCreate({ title, assigneeUri, meetingId, agent } = {}, { assignToAgent, hostReady } = {}) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('A task needs a title');
  if (assigneeUri != null && !USER_URI.test(assigneeUri)) throw new Error('Pick an assignee from the member list');
  if (meetingId != null && !(DOC_URI.test(meetingId) && idKind(meetingId) === 'event')) throw new Error('Not a meeting');
  if (agent && assigneeUri) throw new Error('A task goes to the agent or to a person, not both');
  if (agent && !(agent.prompt || '').trim()) throw new Error('Tell the agent what to do');
  if (agent && typeof assignToAgent !== 'function') throw new Error('The agent is unavailable from here');
  // A machine that is not there is found out before anything is created, so the panel keeps the title, the prompt,
  // the model, the host and the meeting, and the press can simply be repeated once it wakes up.
  if (agent && typeof hostReady === 'function' && !(await hostReady(agent.host))) throw new Error('That machine cannot be reached right now');
  const node = await createDocument(title.trim(), { kind: 'task' });
  const result = { node, assigned: null, linked: null, agent: false };
  // createDocument assigns a new task to its creator; an explicit choice replaces that, through the same write the
  // outliner's assignee picker uses.
  if (assigneeUri) {
    try { await mut(node.id, (doc) => setAssignees(doc, [assigneeUri], S.me.userUri)); result.assigned = assigneeUri; }
    catch (e) { result.assignedError = errText(e); }
  }
  // The meeting link is a pin on the event's own pinnedItems list (EDGE_TYPE_HAS_PIN), which is what Tana itself
  // shows with a meeting and what the sidebar already reads; nodePin refuses when this user may not write the event.
  if (meetingId) {
    try { await nodePin(meetingId, node.id, true); result.linked = meetingId; }
    catch (e) { result.linkError = errText(e); }
  }
  // The agent handoff is main.js's own (the same one Cmd+K uses), injected above. Like the pin, a refusal is carried
  // beside a task that exists rather than thrown over it: the Codex end can fail long after Tana has the task.
  if (agent) {
    try { await assignToAgent(node.id, String(agent.prompt).trim(), agent.model || undefined, agent.host); result.agent = true; }
    catch (e) { result.agentError = errText(e); }
  }
  if (result.assignedError || result.linkError || result.agentError) setStatus({ error: result.assignedError || result.linkError || result.agentError });
  scheduleRefresh(1500); // the new row appears once GraphService has indexed it; createDocument already asked once
  return result;
}

// One panel window, reused. The first press builds it, a press while it has focus hides it again, and a press while
// it is open but behind something raises it — never a second window, and never a rebuild that would throw away what
// the user has typed. The caller holds the window, so this stays a plain function.
function togglePanel(state, create) {
  if (!state.win || state.win.isDestroyed()) state.win = create();
  const win = state.win;
  if (win.isVisible() && win.isFocused()) { win.hide(); return { action: 'hidden', win }; }
  win.show();
  win.focus();
  win.webContents.send('quick:open'); // every open re-reads the meeting; the panel keeps whatever was typed
  return { action: 'shown', win };
}

// Registration can fail two ways — another app holds the combo (false) or electron refuses it (throw) — and both
// would otherwise be invisible. The result lands in the status the renderer already shows, so a dead shortcut is
// diagnosable instead of looking like a broken keyboard.
function registerShortcut(globalShortcut, onPress, { accelerator = ACCELERATOR } = {}) {
  let registered = false, error = null;
  try { registered = globalShortcut.register(accelerator, onPress) === true; }
  catch (e) { error = errText(e); }
  if (!registered && !error) error = accelerator + ' is held by another app';
  setStatus({ quickAdd: { accelerator, registered, error }, ...(registered ? {} : { error: 'Quick add shortcut unavailable: ' + error }) });
  return { accelerator, registered, error };
}

const panelState = { win: null };

module.exports = { ACCELERATOR, currentMeeting, quickContext, quickCreate, togglePanel, registerShortcut, panelState };

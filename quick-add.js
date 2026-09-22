'use strict';
// The quick-add panel: a standalone classic script for quick-add.html, summoned by the global shortcut
// (docs/QUICK-ADD.md). It is not part of the outliner's shared scope — index.html does not load it — and it owns no
// Tana knowledge: main/quickadd.js answers quickContext and quickCreate, this file only types, chooses and submits.

const qapi = globalThis.api || null;
const qel = (id) => document.getElementById(id);
const qtitle = qel('qtitle'), qmeeting = qel('qmeeting'), qassignee = qel('qassignee'), qprompt = qel('qprompt');
const qerror = qel('qerror'), qchooser = qel('qchooser'), qfilter = qel('qfilter'), qlist = qel('qlist');

// The app's own icon set (icons.js), parsed once and cloned per use — the same thing the outliner's iconNode does,
// so the member and robot glyphs here are the ones every other list shows.
const qicons = new Map();
function qicon(name) {
  if (!qicons.has(name)) {
    const tpl = document.createElement('template');
    tpl.innerHTML = (globalThis.ICONS && globalThis.ICONS[name]) || '';
    qicons.set(name, (tpl.content && tpl.content.firstElementChild) || null);
  }
  const template = qicons.get(name);
  return template ? template.cloneNode(true) : null;
}

// same contract as the outliner (renderer/theme.js): the preference travels with the rest of them, read from the
// bridge's synchronous snapshot, and dark is a data attribute
function qtheme() {
  const pref = (qapi && qapi.prefs && qapi.prefs.theme) || null;
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}

let qctx = { meeting: null, members: [], me: null }; // last answer from main
let qmeetingState = 'loading'; // loading | live | none | error
let qassigned = null; // { id, title } a person chosen by the user; null means the default (the creator)
// The local Codex agent is an app-local mark, never a Tana member (main/documents.js), so it is held apart from
// qassigned and can never be spelled as a user uri. { model } is the choice for this one assignment: '' is Codex's
// own default, exactly as the outliner's Assign to Agent page treats it.
let qagent = null;
let qmodels = [];
let qhosts = [];
let qmode = 'people'; // which list the one chooser is showing: people | model | host
let qopen = false, qhi = 0, qrows = [], qbusy = false;

const AGENT_ROW = { agent: true, title: 'Agent' };
const BACK_ROW = { people: true, title: 'Assign to someone else…' };
const HOSTS_ROW = { hosts: true, title: 'Run on…' }; // from the model list into the machines
const MODELS_ROW = { models: true, title: 'Choose a model…' }; // and back again
const qtext = (e) => String((e && e.message) || e || '');
function qsetError(text) { qerror.textContent = text || ''; qerror.hidden = !text; }

// The meeting line is the panel's one claim about Tana, so it never guesses: it says it is still looking, names the
// meeting the user has actually joined, says there is none, or says why it could not tell.
function qshowMeeting() {
  const m = qctx.meeting;
  qmeeting.className = 'qmeeting' + (qmeetingState === 'live' ? ' live' : qmeetingState === 'none' ? ' none' : '');
  qmeeting.textContent = qmeetingState === 'live' ? 'Adding to ' + (m.title || 'this meeting')
    : qmeetingState === 'none' ? 'No active meeting'
    : qmeetingState === 'error' ? 'Could not check meetings'
    : 'Checking for an active meeting…';
}
// Who has the task, as a pill: the app's member glyph for a person, its robot for the agent, and the agent's model
// beside it when one was chosen. The prompt field belongs to the agent and appears with it.
function qshowAssignee() {
  // The pill names the machine only when it is not this one: "Agent · Donut", or "Agent · model · Donut".
  const qhostName = qagent && qagent.host && qagent.host !== 'local' ? (qhosts.find((h) => h.id === qagent.host) || {}).title || qagent.host : '';
  const label = qagent ? 'Agent' + (qagent.model ? ' · ' + qagent.model : '') + (qhostName ? ' · ' + qhostName : '')
    : qassigned ? (qassigned.title || 'Assigned') : 'Assign to…';
  const glyph = qagent ? qicon('robot') : qassigned ? qicon('member') : null;
  qassignee.replaceChildren(...(glyph ? [glyph, label] : [label]));
  qassignee.className = 'qassignee' + (qagent || qassigned ? ' set' : '');
  qprompt.hidden = !qagent;
}

// One list, two things to pick from: people (with the agent at the top) or, once the agent has the task, the model
// for this assignment with a way back to the people.
function qchoices() {
  if (qmode === 'host') return [MODELS_ROW, ...qhosts.map((h) => ({ host: h.id, title: h.title }))];
  // "Run on…" sits last so the models keep the places they had: reaching one is the same keypresses as before.
  if (qmode === 'model') return [BACK_ROW, { model: '', title: 'Codex default' }, ...qmodels.map((id) => ({ model: id, title: id })), HOSTS_ROW];
  return [AGENT_ROW, ...(qctx.members || [])];
}
const qmatches = () => {
  const needle = (qfilter.value || '').trim().toLowerCase();
  const all = qchoices();
  return needle ? all.filter((row) => (row.title || '').toLowerCase().includes(needle)) : all;
};
const qpicked = (row) => (row.agent ? !!qagent && qmode === 'people' : row.host !== undefined ? !!qagent && (qagent.host || 'local') === row.host
  : row.model !== undefined ? !!qagent && qagent.model === row.model
  : !!qassigned && qassigned.id === row.id);
function qdraw() {
  qrows = qmatches();
  if (qhi >= qrows.length) qhi = Math.max(0, qrows.length - 1);
  const kids = qrows.map((row, i) => {
    const el = document.createElement('div');
    const glyph = row.agent ? qicon('robot') : row.people ? qicon('member') : row.hosts || row.host !== undefined ? qicon('host')
      : row.models || row.model !== undefined ? qicon('brain') : qicon('member');
    el.replaceChildren(...(glyph ? [glyph, row.title || row.id] : [row.title || row.id]));
    el.dataset.id = row.id || row.title;
    if (i === qhi) el.classList.add('on');
    if (qpicked(row)) el.classList.add('picked');
    el.onclick = () => qpick(row);
    return el;
  });
  if (!kids.length) {
    const empty = document.createElement('div');
    empty.className = 'qempty';
    empty.textContent = qctx.membersError ? 'Members unavailable' : 'No one found';
    kids.push(empty);
  }
  qlist.replaceChildren(...kids);
}
function qopenChooser(mode) {
  qmode = mode === 'model' || mode === 'host' ? mode : 'people';
  qopen = true; qchooser.hidden = false; qhi = 0; qfilter.value = '';
  if (qmode === 'model' && !qmodels.length && qapi && qapi.codexModels) {
    qapi.codexModels().then((list) => { qmodels = Array.isArray(list) ? list : []; if (qopen && qmode === 'model') qdraw(); }, () => {});
  }
  if (qmode === 'host' && !qhosts.length && qapi && qapi.codexHosts) {
    qapi.codexHosts().then((list) => { qhosts = Array.isArray(list) ? list : []; if (qopen && qmode === 'host') qdraw(); }, () => {});
  }
  qdraw();
  qfilter.focus();
}
// Leaving the chooser puts the caret where the work is: the prompt while the agent has the task, otherwise the title.
function qcloseChooser() { qopen = false; qchooser.hidden = true; qfilter.value = ''; (qagent ? qprompt : qtitle).focus(); }
// Picking what is already picked clears it, so the default (the task's creator) is one keypress away.
function qpick(row) {
  if (!row) return;
  if (row.people) { qopenChooser('people'); return; } // back to the members from the model list
  if (row.hosts) { qopenChooser('host'); return; } // from the model list into the machines
  if (row.models) { qopenChooser('model'); return; } // and back
  if (row.host !== undefined) {
    if (!qagent) return;
    qagent = { ...qagent, host: row.host }; // the machine it runs on, carried as the registry's opaque id
    qshowAssignee();
    qcloseChooser();
    return;
  }
  if (row.agent) {
    qagent = qagent ? null : { model: '', host: 'local' }; // this machine until the Run on list says otherwise
    if (qagent) qassigned = null; else qprompt.value = '';
  } else if (row.model !== undefined) {
    if (!qagent) return;
    qagent = { ...qagent, model: qagent.model === row.model ? '' : row.model };
  } else {
    if (!row.id) return;
    qassigned = qassigned && qassigned.id === row.id ? null : { id: row.id, title: row.title || '' };
    if (qassigned) { qagent = null; qprompt.value = ''; }
  }
  qshowAssignee();
  qcloseChooser();
}

// Read at every open, never cached: the meeting must be the one being attended now. It runs after the field is
// already focused and never touches the title, so a slow or failing lookup cannot swallow what is being typed.
async function qloadContext() {
  if (!qapi || !qapi.quickContext) { qmeetingState = 'error'; qshowMeeting(); return; }
  qmeetingState = 'loading';
  qshowMeeting();
  try {
    const next = await qapi.quickContext();
    qctx = next || { meeting: null, members: [] };
    qmeetingState = qctx.meetingError ? 'error' : qctx.meeting ? 'live' : 'none';
  } catch (e) {
    qctx = { ...qctx, meeting: null, meetingError: qtext(e) };
    qmeetingState = 'error';
  }
  qshowMeeting();
  if (qassigned && !(qctx.members || []).some((p) => p.id === qassigned.id)) { qassigned = null; qshowAssignee(); }
  if (qopen) qdraw();
}

// One submit at a time, and one path: every way of asking for the task — ↵ in the title, ⌘↵ anywhere — comes through
// here, so the empty and in-flight guards cannot be walked around. A failure keeps the title exactly as typed and
// says why; only a created task clears and closes the panel.
async function qsubmit() {
  const title = (qtitle.value || '').trim();
  if (!title) { qsetError('A task needs a title'); return null; }
  const prompt = qagent ? (qprompt.value || '').trim() : '';
  if (qagent && !prompt) { qsetError('Tell the agent what to do'); qprompt.focus(); return null; }
  if (qbusy) return null;
  if (!qapi || !qapi.quickCreate) { qsetError('Not connected to Tana'); return null; }
  qbusy = true;
  qsetError('');
  try {
    const result = await qapi.quickCreate({
      title,
      assigneeUri: qassigned ? qassigned.id : null,
      meetingId: qmeetingState === 'live' && qctx.meeting ? qctx.meeting.id : null,
      agent: qagent ? { prompt, model: qagent.model || '', host: qagent.host || 'local' } : null,
    });
    qtitle.value = '';
    qprompt.value = '';
    qassigned = null;
    qagent = null;
    qshowAssignee();
    if (qopen) qcloseChooser();
    if (qapi.quickClose) qapi.quickClose();
    return result;
  } catch (e) {
    qsetError(qtext(e));
    return null;
  } finally {
    qbusy = false;
  }
}

// Keyboard first, and the whole panel answers: the keys mean the same wherever focus sits, which is what lets the
// chooser and the prompt be reached and left without a mouse.
function qkey(e) {
  const key = e && e.key;
  const mod = !!(e && (e.metaKey || e.ctrlKey));
  const inPrompt = !!(e && e.target && e.target.id === 'qprompt');
  const stop = () => { if (e && e.preventDefault) e.preventDefault(); };
  // ⌘↵ creates from anywhere in the panel. It is answered before the chooser and before the prompt's own newline, so
  // neither swallows it, and it runs the same guarded submit as ↵ in the title.
  if (key === 'Enter' && mod) { stop(); qsubmit(); return; }
  if (key === 'Escape') {
    stop();
    if (qopen) qcloseChooser();
    else if (qapi && qapi.quickClose) qapi.quickClose();
    return;
  }
  if (key === 'Enter') {
    if (qopen) { stop(); qpick(qrows[qhi]); return; }
    if (inPrompt) return; // the agent's prompt is several lines: a bare ↵ is a newline, ⌘↵ above creates
    stop();
    qsubmit();
    return;
  }
  if (key === 'Tab') { stop(); if (qopen) qcloseChooser(); else qopenChooser(qagent ? 'model' : 'people'); return; }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (!qopen) { if (key === 'ArrowDown' && !inPrompt) { stop(); qopenChooser(qagent ? 'model' : 'people'); } return; }
    stop();
    if (qrows.length) qhi = (qhi + (key === 'ArrowDown' ? 1 : qrows.length - 1)) % qrows.length;
    qdraw();
  }
}

qtheme();
qshowMeeting();
qshowAssignee();
document.addEventListener('keydown', qkey);
qfilter.addEventListener('input', () => { qhi = 0; qdraw(); });
qassignee.addEventListener('click', () => (qopen ? qcloseChooser() : qopenChooser(qagent ? 'model' : 'people')));
qtitle.focus();
qloadContext();
// Every press of the shortcut re-opens on the same window: focus the title again and re-read the meeting, keeping
// whatever was typed before.
if (qapi && qapi.onQuickOpen) qapi.onQuickOpen(() => { qsetError(''); qtitle.focus(); qloadContext(); });

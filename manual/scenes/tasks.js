'use strict';
// Chapter 6, Tasks (manual/tasks.html). A task list is the Library narrowed to tasks, grouped by status and filtered to
// "ag" (four tasks, one per state, set up below); the two tasks with Tana-shaped ids (tana:text:mockpin0/1) carry the
// facts a real node gets: assignee, faces, bell, agent badge.
const W = { wait: 1500 }; // the page's scripts settle before the first step
// the words narrowing the list stay out of the picture: the filter row is hidden, the list is what matters
const HIDE_FILTER = "document.head.append(Object.assign(document.createElement('style'), { textContent: '#filterRow { display: none !important; }' }))";
const list = (words) => [W, { js: "setView('library')" }, { wait: 300 },
  { js: "Promise.all([tana.setState('mockspacedoc1', 'proposed'), tana.setState('mockdoc7', 'not_now')])" },
  { js: "setViewF({ types: ['tasks'], states: null, assignee: 'anyone', completedWithin: 7 })" }, { wait: 500 },
  { js: "setPref('openPills', { ...pref('openPills', {}), library: false }); setGroupBy('status'); filterEl.value = " + JSON.stringify(words) + "; render(true)" },
  { js: HIDE_FILTER },
  { js: "tana.setAgent('tana:text:mockpin1', true).then(() => { agentLoading = null; return loadAgentIds(); })" }, { wait: 900 }];
const pinTask = (id) => [W, { js: "goTo('tana:text:" + id + "')" }, { wait: 900 }];
// Quick Add Task is a page main lays over the window (main.js openOverlay): here an iframe of task.html does the same
const quickAdd = "(() => { const f = document.createElement('iframe'); f.src = 'task.html?theme=' + (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');"
  + " f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:9999;background:transparent'; document.body.append(f);"
  + " return new Promise((r) => { f.onload = () => setTimeout(() => { f.contentWindow.eval(QA_DATA); f.contentWindow.focus(); f.contentDocument.getElementById('taskTitle').focus(); r(); }, 300); }); })()";
// what main would hand the card: the members, you first, and two workflow types beside plain Task (task.js)
const qaData = "people = [['robin', 'Robin Vega', true], ['sam', 'Sam Okafor'], ['priya', 'Priya Raman'], ['tomas', 'Tomas Ilves']].map(([k, title, me]) => ({ id: 'tana:user-profile:' + k, title, me: !!me }));"
  + " taskTypes = [taskTypes[0], { uri: 'tana:type:bug', title: 'Bug', hue: 20 }, { uri: 'tana:type:hire', title: 'Hiring step', hue: 150 }]; draw();";
const top = [0, 0, 1280, 440];
module.exports = [
  { name: 'tasks-states', setup: list('ag'), clip: [0, 0, 1280, 440] },
  { name: 'tasks-tick', video: true, setup: list('ag'), clip: top, steps: [
    { click: '.node .text', text: 'Prepare the offsite agenda', at: [0.9, 0.5] }, { wait: 300 }, { key: '⌘↩' }, { wait: 1300 },
    { caption: 'The row stays put until you clean up' }, { wait: 1400 }, { caption: '' }, { key: '⌘K' }, { type: 'clean up' }, { wait: 400 }, { key: '↩' }, { wait: 1000 }] },
  { name: 'tasks-status', video: true, setup: list('ag'), clip: top, steps: [
    { click: '.node .text', text: 'Draft the LT agenda', at: [0.9, 0.5] }, { wait: 400 }, { key: '⌘K' }, { type: 'set status' }, { wait: 300 }, { key: '↩' },
    { wait: 300 }, { type: 'progress' }, { wait: 400 }, { key: '↩' }, { wait: 1200 }] },
  { name: 'tasks-facts', setup: list('offsite'), clip: [0, 100, 1280, 160] },
  { name: 'tasks-notify', setup: pinTask('mockpin0'), steps: [{ key: '⌘K' }, { type: 'notif' }, { wait: 600 }], clip: { sel: '#palette .card', pad: 20 } },
  { name: 'tasks-quickadd', video: true, setup: [W, { js: "goTo('orbital:timeline')" }, { wait: 800 }, { js: 'window.QA_DATA = ' + JSON.stringify(qaData) + '; ' + quickAdd, page: 'shell' }], clip: [220, 40, 840, 330], steps: [
    { type: 'Send the venue options to Sam', delay: 40 }, { wait: 500 }, { key: '↓' }, { wait: 600 }, { key: '⇥' }, { wait: 300 },
    { type: 'sam' }, { wait: 400 }, { key: '↩' }, { wait: 1400 }] },
  { name: 'tasks-select', video: true, setup: list('ag'), clip: top, steps: [
    { click: '.node .text', text: 'Draft the LT agenda', at: [0.9, 0.5] }, { wait: 400 }, { key: '⇧↓' }, { wait: 300 }, { key: '⌘K' }, { wait: 800 },
    { key: '↩' }, { wait: 300 }, { type: 'comp' }, { wait: 300 }, { key: '↩' }, { wait: 300 }] },
  { name: 'tasks-assign', video: true, setup: pinTask('mockpin0'), clip: [0, 0, 1280, 400], steps: [
    { key: '⌘K' }, { type: 'edit assignees' }, { wait: 300 }, { key: '↩' }, { wait: 500 },
    { type: 'priya' }, { wait: 400 }, { key: '↩' }, { wait: 900 }, { key: 'esc' }, { wait: 1400 }] },
];




'use strict';
// Chapter 4, Finding your way: node manual/scenes/run.js manual/scenes/navigating.js
const H = { js: "window.T = (s) => [...document.querySelectorAll('.node .text')].find((e) => e.textContent.includes(s)); 1" };
const doc0 = [H, { js: "goTo('mockdoc0')" }, { wait: 700 }];
const scrollTo = (words, dy = 90) => ({ js: "T(" + JSON.stringify(words) + ").scrollIntoView({ block: 'start' }); document.querySelector('.scroll').scrollTop -= " + dy + "; 1" });
// a row's bullet sits just left of its words: at is a fraction of the words' box
const bullet = (words, fx) => ({ click: '.node .text', text: words, at: [fx, 0.5] });
// the meeting button and the Graph switch are drawn only for real Tana ids (renderer/rail.js), so the mock's task gets them here
const staged = { js: "for (const [b, icon] of [[meetingBtn, 'meeting'], [linksBtn, 'graph']]) { b.hidden = false; if (!b.childNodes.length) addIcon(b, icon); } meetingBtn.dataset.meeting = 'mockmeeting0'; meetingBtn.title = 'From Studio LT weekly'; 1" };
// the Work View as main.js pair() lays it out: the Timeline beside My Tasks
const work = [{ js: "goTo('orbital:timeline')" }, { js: 'tana.myTasks().then((n) => goTo(n.id))', page: '2' }, { wait: 900 }];
const tabs = { schema: 1, root: { kind: 'panel', id: 'panel-t', views: ['page', 'page2'], selected: 'page2' }, floating: [], hidden: [],
  views: { page: { type: 'page', params: { side: '' } }, page2: { type: 'page', params: { side: '2' } } } };

module.exports = [
  // a bullet zooms in, ⌘[ comes back, ⌘] goes forward again
  { name: 'navigating-zoom', video: true, size: '640x440', setup: [...doc0, scrollTo('Agenda', 30)], steps: [
    bullet('Walk through both', -0.07), { wait: 1300 }, { key: '⌘[' }, { wait: 1100 }, { key: '⌘]' }, { wait: 700 },
  ], clip: { page: '' } },
  // the page's own buttons and the window's, on a task filed under a meeting
  { name: 'navigating-header', size: '1100x640', setup: [...doc0, { js: "tana.createDocument('Offsite plan').then((n) => goTo(n.id))" }, { wait: 900 }, staged], steps: [{ hover: '#title' }, { wait: 500 }], clip: [600, 0, 500, 96] },
  // the meeting button opens the meeting, which opens at its write-up
  { name: 'navigating-meeting', video: true, size: '640x480', setup: [...doc0, { js: "goTo('mockdoc1')" }, { wait: 900 }, staged], steps: [
    { hover: '#title' }, { wait: 400 }, { hover: 'button[data-for="navMeeting"]', page: 'shell' }, { wait: 700 }, { click: 'button[data-for="navMeeting"]', page: 'shell' }, { wait: 1200 },
  ], clip: [0, 0, 640, 480] },
  // Home in ⌘K
  { name: 'navigating-home', size: '1000x700', setup: doc0, steps: [{ key: '⌘K' }, { type: 'home' }, { wait: 400 }], clip: { sel: '#palette .card', pad: 0 } },
  // the Work View: Home, unless you set another
  { name: 'navigating-workview', size: '1440x900', panes: 2, setup: work, clip: [0, 0, 1440, 900] },
  // ⌘S with nothing typed: the places you opened last
  { name: 'navigating-recent', size: '1000x700', setup: [...doc0, { js: "goTo('mockdoc3')" }, { wait: 400 }, { js: "goTo('mockmeeting2')" }, { wait: 400 }, { js: "goTo('mockdoc1')" }, { wait: 500 }],
    steps: [{ key: '⌘S' }, { wait: 600 }], clip: { sel: '#palette .card', pad: 0 } },
  // two pages as tabs of one pane
  { name: 'navigating-tabs', size: '1200x640', layout: tabs, setup: [{ js: "goTo('mockdoc0')" }, { js: "goTo('mockdoc1')", page: '2' }, { wait: 900 }], clip: [0, 0, 1200, 360] },
];








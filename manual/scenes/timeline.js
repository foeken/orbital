'use strict';
// Chapter 5, Timeline, notifications & proposals (manual/timeline.html): the three pages of the app's own
// (orbital:timeline, orbital:notifications, orbital:proposals) on the mock's busy morning.
const W = { wait: 1500 }; // the page's scripts settle before the first step
const open = (id) => [W, { js: "goTo('" + id + "')" }, { wait: 900 }];
// a stable handle on one button inside a row, for the pointer to travel to
const tag = (rowText, sel, id) => ({ js: "[...document.querySelectorAll('.node')].find((n) => n.textContent.includes(" + JSON.stringify(rowText) + ")).querySelector(" + JSON.stringify(sel) + ").id = " + JSON.stringify(id) });
// a day with no meetings left: the mock's Timeline read without its free time and Upcoming meetings, as main sends it then
const NO_MEETINGS = { js: "const all = tana.children; tana.children = async (id) => { const r = await all(id); return id === 'orbital:timeline' ? r.filter((n) => !n.timeline?.free && !n.timeline?.upcoming) : r; }; 1" };
module.exports = [
  { name: 'timeline-now', setup: open('orbital:timeline'), clip: [0, 40, 1280, 560] },
  { name: 'timeline-nomeetings', setup: [W, NO_MEETINGS, ...open('orbital:timeline'), { js: "reload('orbital:timeline').then(() => render(true))" }, { wait: 900 }], clip: [0, 40, 1280, 470] },
  // its meetings include Travel to Utrecht, drawn with the route marker (main/timeline.js meetingIcon)
  { name: 'timeline-history', size: '1280x1500', setup: open('orbital:timeline'), clip: [0, 600, 1280, 880] },
  { name: 'timeline-end', size: '1280x2000', setup: open('orbital:timeline'), clip: [0, 1480, 1280, 170] },
  { name: 'timeline-addmore', setup: open('orbital:timeline'), steps: [{ click: '.tl-add' }, { wait: 300 }, { type: 'board' }, { wait: 900 }],
    clip: { sel: '#palette .card', pad: 20 } },
  { name: 'timeline-read', video: true, setup: open('orbital:notifications'), clip: [0, 40, 1280, 260], steps: [
    { click: '.node.unread > .line > .bullet' }, { wait: 1000 }, { key: '⌘K' }, { type: 'mark all' }, { wait: 500 }, { key: '↩' }, { wait: 1200 }] },
  { name: 'timeline-proposals', setup: open('orbital:proposals'), steps: [{ click: '.group-head, .ghead, .node', text: 'From others' }, { wait: 500 }], clip: [0, 40, 1280, 420] },
  { name: 'timeline-approve', video: true, setup: [...open('orbital:proposals'), tag('Check out the new editor', '.pbutton.approve', 'mc-approve')], clip: [0, 40, 1280, 360], steps: [
    { hover: '.node .text', text: 'Check out the new editor' }, { wait: 500 }, { click: '#mc-approve' }, { wait: 1500 }] },
];

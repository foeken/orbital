'use strict';
// Chapter 8, Pins & dates (manual/pins.html). The pin rows in Cmd+K are offered on real nodes only, so the pictures use
// the mock's two tasks with Tana-shaped ids (tana:text:mockpin0 "Prepare the offsite agenda", mockpin1 "Book a room").
const W = { wait: 1500 }; // the page's scripts settle before the first step
const A = 'tana:text:mockpin0', B = 'tana:text:mockpin1';
const open = (id) => [W, { js: "goTo('" + id + "')" }, { wait: 900 }];
// pinned to the sidebar, to today and on Leadership sync, so every kind of pin has something to show
const pinned = { js: "Promise.all([tana.pin('" + A + "', 'sidebar'), tana.pin('" + A + "', 'today', localDate()), tana.pinTo('mockmeeting2', '" + A + "')]).then(() => loadPinned(true))" };
const HIDE_FILTER = "document.head.append(Object.assign(document.createElement('style'), { textContent: '#filterRow { display: none !important; }' }))";
const list = (words, by = 'status') => [W, { js: "setView('library')" }, { wait: 300 }, pinned,
  { js: "setViewF({ types: ['tasks'], states: null, assignee: 'anyone', completedWithin: 7 })" }, { wait: 500 },
  { js: "setPref('openPills', { ...pref('openPills', {}), library: false }); setGroupBy('" + by + "'); filterEl.value = " + JSON.stringify(words) + "; render(true)" },
  { js: HIDE_FILTER }, { wait: 900 }];
const card = { sel: '#palette .card', pad: 20 };
module.exports = [
  { name: 'pins-palette', setup: open(A), steps: [{ key: '⌘K' }, { type: 'pin' }, { wait: 700 }], clip: card },
  { name: 'pins-date', video: true, setup: open(A), clip: [220, 40, 840, 330], steps: [{ key: '⌘K' }, { type: 'pin to date' }, { wait: 300 }, { key: '↩' }, { wait: 400 },
    { type: 'fri' }, { wait: 1100 }, { js: 'palInput.select()' }, { type: 'in 3 days' }, { wait: 1100 }, { js: 'palInput.select()' }, { type: '12 oct' }, { wait: 1100 },
    { js: 'palInput.select()' }, { type: 'next week' }, { wait: 1200 }] },
  { name: 'pins-edit', setup: [...open(A), pinned, { wait: 400 }], steps: [{ key: '⌘K' }, { type: 'edit pins' }, { wait: 300 }, { key: '↩' }, { wait: 900 }], clip: card },
  // the window's sidebar: Search, Home, Timeline and Today, the pins outside a section and each section's (kit.js SIDEBAR_PINS), then Agent chats (SIDEBAR_CHATS)
  { name: 'pins-sidebar', setup: [W, { js: "goTo('mockdoc2')" }, { wait: 900 }], clip: [0, 0, 620, 470] },
  // Pin to sidebar … asks which section: Pinned, a section of yours, or a new one named as you type
  { name: 'pins-sidebar-section', setup: open(A), steps: [{ key: '⌘K' }, { type: 'pin to sidebar' }, { wait: 300 }, { key: '↩' }, { wait: 600 }], clip: card },
  { name: 'pins-meeting', setup: open(A), steps: [{ key: '⌘K' }, { type: 'pin to meeting' }, { wait: 300 }, { key: '↩' }, { wait: 900 }], clip: card },
  { name: 'pins-mark', setup: list('offsite'), clip: [0, 100, 1280, 150] },
  { name: 'pins-pinned', setup: list('', 'responsibility'), clip: [0, 40, 1280, 300] },
  { name: 'pins-addtoday', video: true, setup: list('offsite'), clip: [0, 0, 1280, 440], steps: [
    { click: '.node .text', text: 'Book a room for the offsite', at: [0.9, 0.5] }, { wait: 400 }, { key: '⌘K' }, { type: 'add to today' }, { wait: 400 }, { key: '↩' }, { wait: 900 },
    { key: '⌃⇧D' }, { wait: 1500 }] },
  { name: 'pins-mention', video: true, setup: open(B), clip: [0, 0, 1280, 600], steps: [
    { js: "[...document.querySelectorAll('.node .text')].at(-1).id = 'mc-last'" }, { click: '#mc-last', at: [0.99, 0.5] }, { wait: 300 }, { key: '↩' }, { type: 'Call the venue ' }, { type: '@' }, { wait: 400 },
    { type: 'friday' }, { wait: 900 }, { key: '↩' }, { wait: 1300 }] },
];

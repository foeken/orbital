'use strict';
// Chapter 14, Sharing & privacy (manual/sharing.html): node manual/scenes/run.js manual/scenes/sharing.js
// tana:text:mockpin0 "Prepare the offsite agenda" (Robin, Sam and Priya can see it, Sam has it) and tana:text:mockpin1
// "Book a room for the offsite" (Everyone) have Tana-shaped ids, which the access rows (Edit visibility, Move to …) need.
const AGENDA = 'tana:text:mockpin0', ROOM = 'tana:text:mockpin1';
const open = (id) => ({ js: 'goTo(' + JSON.stringify(id) + ')' });
const pal = { sel: '#palette .card', pad: 14 };
const blank = { js: "(() => { const s = document.createElement('style'); s.textContent = 'body > :not(#palette) { visibility: hidden !important; }'; document.head.append(s); })()" };
const NARROW = '1000x640';
// the access rows wait for the node's options (renderer/access.js loadAccess): read them before the palette opens
const access = (id) => ({ js: 'loadAccess(' + JSON.stringify(id) + '); new Promise((r) => setTimeout(r, 400))' });

module.exports = [
  // ---- who can see it ----
  { name: 'sharing-visible', size: NARROW, setup: [open(AGENDA), { wait: 1200 }], clip: [0, 30, 1000, 250] },
  { name: 'sharing-rows', size: '900x560', setup: [{ js: "setView('library')" }, { wait: 1200 }], clip: [0, 215, 900, 225] },
  { name: 'sharing-edit', video: true, size: '1000x700', setup: [open(AGENDA), { wait: 1200 }, access(AGENDA), { click: '#title' }], steps: [
    { key: '⌘K' }, { type: 'edit visibility', delay: 55 }, { wait: 400 }, { key: '↩' }, { wait: 900 }, { click: '#palette .row', text: 'Selected people' }, { wait: 800 },
    { click: '#palette .row', text: 'Tomas Ilves' }, { wait: 600 }, { click: '#palette .row', text: 'Apply selected people' }, { wait: 1600 }], clip: [0, 0, 1000, 480] },
  { name: 'sharing-options', setup: [open(AGENDA), { wait: 1200 }, access(AGENDA), { click: '#title' }], steps: [{ key: '⌘K' }, { type: 'edit visibility' }, { wait: 300 }, { key: '↩' }, { wait: 700 }, blank], clip: pal },
  { name: 'sharing-ask', setup: [open(AGENDA), { wait: 1200 }, access(AGENDA), { click: '#title' }], steps: [{ key: '⌘K' }, { type: 'edit assignees' }, { wait: 300 }, { key: '↩' }, { wait: 700 }, { type: 'tomas' }, { wait: 300 }, { key: '↩' }, { wait: 1200 }, blank], clip: pal },
  { name: 'sharing-ghost', size: NARROW, setup: [open(AGENDA), { wait: 1200 }, access(AGENDA), { click: '#title' }], steps: [{ key: '⌘K' }, { type: 'edit assignees' }, { wait: 300 }, { key: '↩' }, { wait: 700 }, { type: 'tomas' }, { wait: 300 }, { key: '↩' }, { wait: 1200 }, { key: 'esc' }, { wait: 900 }], clip: [0, 30, 1000, 250] },
  // ---- where it lives ----
  { name: 'sharing-move', setup: [open(ROOM), { wait: 1200 }, access(ROOM), { click: '#title' }], steps: [{ key: '⌘K' }, { type: 'move to studio' }, { wait: 600 }, { key: '↩' }, { wait: 900 }, blank], clip: pal },
  { name: 'sharing-delete', video: true, size: NARROW, setup: [{ js: "setView('library')" }, { wait: 900 }, open(ROOM), { wait: 1200 }, access(ROOM), { click: '#title' }], steps: [
    { key: '⌘K' }, { type: 'delete', delay: 70 }, { wait: 400 }, { key: '↩' }, { wait: 1400 },
    { key: '⌘K' }, { type: 'recently deleted', delay: 45 }, { wait: 300 }, { key: '↩' }, { wait: 1000 }, { caption: '↩ restores it and opens it' }, { wait: 1600 }, { caption: '' }], clip: [0, 0, 1000, 420] },
  { name: 'sharing-archived', setup: [open(ROOM), { wait: 800 }], steps: [{ key: '⌘K' }, { type: 'archived types' }, { wait: 300 }, { key: '↩' }, { wait: 700 }, blank], clip: pal },
  { name: 'sharing-link', setup: [open(AGENDA), { wait: 1000 }, access(AGENDA), { click: '#title' }], steps: [{ key: '⌘K' }, { type: 'link' }, { wait: 500 }, blank], clip: pal },
  // ---- privacy on screen ----
  { name: 'sharing-sensitive', video: true, size: '900x560', setup: [{ js: "setView('library')" }, { wait: 1200 }, { click: '.node .text', text: 'Book a room' }], steps: [
    { key: '⌘K' }, { type: 'mark as sensitive', delay: 50 }, { wait: 400 }, { key: '↩' }, { wait: 1300 },
    { click: '#headSensitive', page: 'shell' }, { wait: 1300 }, { click: '#headSensitive', page: 'shell' }, { wait: 1000 }] },
  { name: 'sharing-demo', video: true, size: NARROW, setup: [open('mockdoc0'), { wait: 1000 }, { click: '#title' }], steps: [
    { key: '⌘K' }, { type: 'demo', delay: 80 }, { wait: 400 }, { key: '↩' }, { wait: 2200 }, { key: '⌘K' }, { type: 'demo', delay: 80 }, { wait: 300 }, { key: '↩' }, { wait: 1200 }], clip: [0, 0, 1000, 560] },
  { name: 'sharing-hidden', setup: [open('mockdoc0'), { wait: 800 }], steps: [{ key: '⌘K' }, { type: 'edit hidden' }, { wait: 300 }, { key: '↩' }, { wait: 600 }, { type: 'Lunch*' }, { wait: 400 }, blank], clip: pal },
  { name: 'sharing-page', url: 'manual/sharing.html', full: true, size: '1440x900' },
];


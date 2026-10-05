'use strict';
// Chapter 9, Meetings: node manual/scenes/run.js manual/scenes/meetings.js
// The mock's meetings and tasks have ids the renderer does not take for Tana's own (isRealId: 'tana:…'), and the
// features of a real node (Join call, Pin to current meeting, the Graph pane, the header's meeting button) are only
// drawn for those. REAL wraps a page's api so mockmeeting2 reads as tana:event:mockmeeting2 and mockdoc1 as
// tana:text:mockdoc1, both ways; it runs in every page before anything is opened.
const REAL = `(() => { if (tana.__real) return; tana.__real = true;
  const local = (v) => typeof v === 'string' ? v.replace(/tana:(?:event|text):(mock(?:meeting|doc)\\d+)/g, '$1') : v;
  const real = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v).replace(/"(mockmeeting\\d+)(?=["|])/g, '"tana:event:$1').replace(/"(mockdoc\\d+)(?=["|])/g, '"tana:text:$1'));
  for (const k of Object.keys(tana)) { const f = tana[k]; if (typeof f !== 'function') continue;
    tana[k] = /^on[A-Z]/.test(k) ? (cb) => f((...a) => cb(...a.map(real))) : (...a) => { const r = f(...a.map(local)); return r && r.then ? r.then(real) : r; }; } })()`;
// the Timeline's Leadership sync as a meeting under way whose call is on the record (main/timeline.js watchCalls)
const REC = `(() => { const f = tana.children; tana.children = async (id) => { const rows = await f(id);
  if (id === 'orbital:timeline') for (const r of rows) if (r.timeline && r.timeline.tone === 'meeting') { r.timeline.recording = true; r.join = r.timeline.uri; }
  return rows; }; })()`;
const real = (panes = 1) => (panes > 1 ? [{ js: REAL }, { js: REAL, page: '2' }] : [{ js: REAL }]);
const open = (id) => ({ js: "goTo('" + id + "')" });
const M = 'tana:event:mockmeeting2';
// 1-1 with Sam: a meeting as Tana keeps one (an event with no content of its own) with a write-up, so its page is your
// notes with Notes | Summary over them; the notes are written before the shot (main makes them on the first word)
const W = 'tana:event:mockmeeting4';
const notes = { js: "tana.meetingNotes('" + W + "', true, 'Ask Sam how the synthetic pilot went').then((n) => tana.insertAfter(n.id, n.blockId, 'Agree on a date for the next review'))" };
const pal = { sel: '#palette .box, #palette > div', pad: 14 };
module.exports = [
  // the meeting page: its details, then your notes, with the Graph pane beside it
  { name: 'meetings-page', graph: true, size: '1440x900', setup: [...real(2), notes, { wait: 500 }, open(W), { wait: 1500 }, { click: '.notes-switch button', text: 'Notes' }, { wait: 1000 }] },
  // it opens on the write-up; Notes shows your notes, then Summary again (with no notes there is no switch)
  { name: 'meetings-notes', video: true, setup: [...real(), notes, { wait: 500 }, open(W), { wait: 1400 }], clip: [0, 0, 1280, 560],
    steps: [{ wait: 1200 }, { click: '.notes-switch button', text: 'Notes' }, { wait: 2000 }, { click: '.notes-switch button', text: 'Summary' }, { wait: 1600 }] },
  // Attendees: five lines, then And 3 more
  { name: 'meetings-attendees', video: true, setup: [...real(), open(M), { wait: 1200 }], clip: [0, 30, 720, 420],
    steps: [{ wait: 600 }, { click: '.fmore' }, { js: "document.querySelector('.fmore')?.click()" }, { wait: 800 }] },
  // Cmd+K on a meeting: the rows that change it
  { name: 'meetings-cmdk', setup: [...real(), open(M), { wait: 900 }, { key: '⌘K' }, { wait: 800 }], clip: pal },
  { name: 'meetings-join', setup: [...real(), open(M), { wait: 900 }, { key: '⌘K' }, { wait: 600 }, { type: 'join' }, { wait: 400 }], clip: pal },
  { name: 'meetings-time', video: true, setup: [...real(), open(M), { wait: 1000 }], clip: [0, 0, 1280, 560],
    steps: [{ key: '⌘K' }, { wait: 500 }, { type: 'change time' }, { wait: 500 }, { key: '↩' }, { wait: 700 }, { type: 'tomorrow 9:30', delay: 90 }, { wait: 1400 }, { key: '↩' }, { wait: 500 }, { key: '⌘K' }, { wait: 600 }, { type: 'change time' }, { wait: 300 }] },
  { name: 'meetings-location', setup: [...real(), open(M), { wait: 900 }, { key: '⌘K' }, { wait: 500 }, { type: 'change location' }, { key: '↩' }, { wait: 500 }, { type: 'meet.example.com/leadership' }, { wait: 400 }], clip: pal },
  // Edit meeting details: the words read by the (mock) AI and shown as the row to press, beside the time it has now
  { name: 'meetings-details', setup: [...real(), open(M), { wait: 900 }, { key: '⌘K' }, { wait: 500 }, { type: 'edit meeting details' }, { wait: 300 }, { key: '↩' }, { wait: 500 }, { type: 'tomorrow from 3-5' }, { wait: 300 }, { key: '↩' }, { wait: 1200 }], clip: pal },
  { name: 'meetings-attendee', setup: [...real(), open(M), { wait: 900 }, { key: '⌘K' }, { wait: 500 }, { type: 'add attendee' }, { key: '↩' }, { wait: 900 }], clip: pal },
  // pinning a task to the meeting you are in, or to one you pick
  { name: 'meetings-pin', setup: [...real(), open('tana:text:mockdoc3'), { wait: 900 }, { key: '⌘K' }, { wait: 600 }, { type: 'meeting' }, { wait: 500 }], clip: { ...pal, pad: 0 } },
  { name: 'meetings-picker', setup: [...real(), open('tana:text:mockdoc3'), { wait: 900 }, { key: '⌘K' }, { wait: 500 }, { type: 'pin to meeting' }, { wait: 300 }, { key: '↩' }, { wait: 900 }], clip: { ...pal, pad: 0 } },
  // a task from a meeting: the glyph among its facts, and the header's meeting button
  { name: 'meetings-tasklink', setup: [...real(), { js: "setView('library')" }, { wait: 1200 }, { hover: '.node .text', text: 'Discuss the two open' }, { wait: 500 }], clip: [0, 180, 720, 230] },
  { name: 'meetings-header', video: true, setup: [...real(), open('tana:text:mockdoc1'), { wait: 1400 }], clip: [0, 0, 1280, 520],
    steps: [{ move: [640, 400] }, { wait: 500 }, { hover: 'button[data-for="navMeeting"]', page: 'shell' }, { wait: 700 }, { click: 'button[data-for="navMeeting"]', page: 'shell' }, { wait: 1200 }] },
  // the Timeline: today's meetings to come, and one under way whose call is on the record
  { name: 'meetings-upcoming', size: '820x800', setup: [...real(), open('orbital:timeline'), { wait: 1400 }], clip: { sel: '.node.tl-upcoming', pad: 18 } },
  { name: 'meetings-recording', size: '560x800', setup: [...real(), { js: REC }, open('orbital:timeline'), { wait: 1000 }, { js: "reload('orbital:timeline').then(() => render(true))" }, { wait: 1200 },
    { js: "document.querySelector('.tl-recording').scrollIntoView({ block: 'center' })" }, { wait: 900 }], clip: { sel: '.node.tl-recording', pad: 40 } },
  // the chapter, drawn whole
  { name: 'meetings-page-check', url: 'manual/meetings.html', full: true, size: '1440x900' },
  // the diagrams mid-loop, to check them
  { name: 'meetings-mg-a', url: 'manual/meetings.html', size: '1440x900', steps: [{ wait: 1400 }] },
  { name: 'meetings-mg-b', url: 'manual/meetings.html', size: '1440x900', steps: [{ wait: 5600 }] },
  { name: 'meetings-mg-c', url: 'manual/meetings.html', size: '1440x900', steps: [{ js: "document.querySelector('.hero .mg').replaceWith(document.querySelector('.mt-pin'))", page: 'shell' }, { wait: 2300 }] },
  { name: 'meetings-mg-d', url: 'manual/meetings.html', size: '1440x900', steps: [{ js: "document.querySelector('.hero .mg').replaceWith(document.querySelector('.mt-pin'))", page: 'shell' }, { wait: 3900 }] },
  { name: 'meetings-mg-e', url: 'manual/meetings.html', size: '1440x900', steps: [{ js: "document.querySelector('.hero .mg').replaceWith(document.querySelector('.mt-pin'))", page: 'shell' }, { wait: 5500 }] },
];

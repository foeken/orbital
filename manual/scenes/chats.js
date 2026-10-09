'use strict';
// Chapter 12, Chats: node manual/scenes/run.js manual/scenes/chats.js
// A clip ends on a change the renderer paints: a page whose only motion is a CSS animation (the dots, the thinking
// shimmer) records no frames in headless Chromium, so what follows a wait is shown in a still (chats-answered).
const open = (id) => ({ js: "goTo('" + id + "')" });
const C = 'tana:chat:mockchat0', Q = 'tana:chat:mockchat4', A = 'orbital:agent-chat:0198c0de-0000-7000-8000-000000000001';
const pal = { sel: '#palette .box, #palette > div', pad: 14 };
// the Library with its type filter on chats
const chatLibrary = [{ js: "setView('library')" }, { wait: 800 }, { js: "setViewF({ types: ['chats'], states: null })" }];
module.exports = [
  { name: 'chats-library', setup: [...chatLibrary, { wait: 1500 }], clip: [0, 0, 1280, 420] },
  { name: 'chats-conversation', size: '1280x1240', setup: [open(C), { wait: 1500 }] },
  { name: 'chats-send', video: true, hold: 1800, setup: [open(C), { wait: 1500 }], clip: [190, 330, 900, 470],
    steps: [{ click: '#composerText' }, { type: 'Can you add one line about the budget?', delay: 45 }, { wait: 300 }, { key: '↩' }, { wait: 4800 }] },
  { name: 'chats-mode', video: true, setup: [open(C), { wait: 1500 }], clip: [190, 650, 900, 150],
    steps: [{ click: '#composerText' }, { wait: 900 }, { key: '⇥' }, { wait: 1400 }, { key: '⇥' }, { wait: 900 }] },
  { name: 'chats-mention', setup: [open(C), { wait: 1500 }, { click: '#composerText' }, { type: 'Ask @' }, { wait: 700 }], clip: [190, 400, 900, 400] },
  { name: 'chats-skill', setup: [open(C), { wait: 1500 }, { click: '#composerText' }, { type: '/' }, { wait: 900 }], clip: pal },
  { name: 'chats-proposal', setup: [open(C), { wait: 1500 }], clip: { sel: '.chat-msg.theirs', text: 'Here is a first draft', pad: 18 } },
  { name: 'chats-thought', video: true, setup: [open(C), { wait: 1500 }, { js: 'outline.parentElement.scrollTop = 0' }, { wait: 400 }], clip: [190, 60, 900, 520],
    steps: [{ wait: 500 }, { click: '.chat-thought-head', text: 'Thought for' }, { wait: 1200 }] },
  { name: 'chats-questions', video: true, hold: 1600, size: '1280x860', setup: [open(Q), { wait: 1500 }], clip: [190, 330, 900, 530],
    steps: [{ wait: 600 }, { key: '↓' }, { wait: 400 }, { key: '↩' }, { wait: 900 }, { key: 'Space' }, { wait: 400 }, { key: '↓' }, { key: '↓' }, { wait: 300 }, { key: 'Space' }, { wait: 700 }] },
  { name: 'chats-answered', size: '1280x860', setup: [open(Q), { wait: 1500 }, { key: '↓' }, { key: '↩' }, { wait: 500 }, { key: 'Space' }, { key: '↓' }, { key: '↓' }, { key: 'Space' }, { key: '↩' }, { wait: 3500 }], clip: [190, 400, 900, 460] },
  { name: 'chats-new', setup: [open(C), { wait: 1200 }, { key: '⌘K' }, { wait: 500 }, { type: 'new chat' }, { wait: 500 }], clip: pal },
  { name: 'chats-addto', setup: [open('tana:space:mock'), { wait: 1000 }, { key: '⌘K' }, { wait: 400 }, { type: 'add to chat' }, { key: '↩' }, { wait: 700 }], clip: pal },
  { name: 'chats-invite', video: true, hold: 1800, size: '1280x620', setup: [open('tana:chat:mockchat2'), { wait: 1500 }], clip: [190, 40, 900, 580],
    steps: [{ key: '⌘K' }, { wait: 400 }, { type: 'invite' }, { wait: 400 }, { key: '↩' }, { wait: 800 }, { type: 'sam' }, { wait: 500 }, { key: '↩' }, { wait: 1200 }] },
  { name: 'chats-delete', video: true, setup: [open(C), { wait: 1500 }], clip: [190, 250, 900, 550],
    steps: [{ click: '#composerText' }, { wait: 400 }, { key: '↑' }, { wait: 700 }, { key: '↑' }, { wait: 1100 }, { key: '⇧⌘⌫' }, { wait: 1200 }] },
  // the mock applies Toggle MCP chats to search, as main does to every list: ⌘S #chat before and after
  { name: 'chats-mcp', video: true, setup: [open(C), { wait: 1200 }], clip: [160, 40, 960, 460],
    steps: [{ key: '⌘S' }, { wait: 300 }, { type: '#chat' }, { wait: 1300 }, { key: 'esc' }, { wait: 300 }, { key: '⌘K' }, { wait: 300 }, { type: 'mcp' }, { wait: 800 }, { key: '↩' }, { wait: 500 }, { key: '⌘S' }, { wait: 300 }, { type: '#chat' }, { wait: 1200 }] },
  { name: 'chats-codex', video: true, hold: 1800, setup: [open(C), { wait: 1500 }], clip: [190, 250, 900, 550],
    steps: [{ click: '#composerText' }, { type: '@' }, { wait: 700 }, { key: '↓' }, { wait: 400 }, { key: '↩' }, { type: ' what changed since the first draft?', delay: 40 }, { wait: 300 }, { key: '↩' }, { wait: 5200 }] },
  { name: 'chats-agent', size: '1280x800', setup: [open(A), { wait: 1500 }, { js: 'outline.parentElement.scrollTop = 0' }, { wait: 300 }] },
  { name: 'chats-agent-list', setup: [open('orbital:agent-chats'), { wait: 1200 }], clip: [0, 0, 1280, 360] },
  // the chapter, drawn whole
  { name: 'chats-page-check', url: 'manual/chats.html', full: true, size: '1440x900' },
  // the diagrams mid-loop, to check them
  { name: 'chats-mg-a', url: 'manual/chats.html', size: '1440x900', steps: [{ wait: 1300 }] },
  { name: 'chats-mg-b', url: 'manual/chats.html', size: '1440x900', steps: [{ wait: 3800 }] },
  { name: 'chats-mg-c', url: 'manual/chats.html', size: '1440x900', steps: [{ wait: 7600 }] },
  { name: 'chats-mg-d', url: 'manual/chats.html', size: '1440x900', steps: [{ js: "document.querySelector('.hero .mg').replaceWith(document.querySelector('.ch-codex'))", page: 'shell' }, { wait: 1600 }] },
  { name: 'chats-mg-e', url: 'manual/chats.html', size: '1440x900', steps: [{ js: "document.querySelector('.hero .mg').replaceWith(document.querySelector('.ch-codex'))", page: 'shell' }, { wait: 6000 }] },
];

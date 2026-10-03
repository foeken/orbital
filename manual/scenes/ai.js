'use strict';
// Chapter 11, AI & agents (manual/ai.html): the model (ChatGPT sign-in, API key, Discuss with, Auto-pick type, Process
// image, translation) and the agents (Choose agents, Assign to Agent, the badge's states, Link / Go to / Open in an agent,
// @Codex in a chat). tana:text:mockai0 is a note with a Tana-shaped id: the AI and agent rows need a real node.
const pal = { sel: '#palette .card', pad: 14 };
const NOTE = 'tana:text:mockai0';
const open = (id) => ({ js: 'goTo(' + JSON.stringify(id) + ')' });
const translateOn = { js: "setPref('translateTo', 'English'); render(true)" };
const translateOff = { js: "setPref('translateTo', undefined); render(true)" };
// the agent's states, set on the renderer's own maps: the mock has no task to ask
const agent = (pairs) => ({ js: 'for (const [id, s] of ' + JSON.stringify(pairs) + ') { agentIds.add(id); agentTasks.set(id, { agent: "codex", taskId: "3f2a9c1e-7b44-4d0e-9a51-2c8e6f0b7d13" }); if (s === "pending") agentStates.delete(id); else agentStates.set(id, s); } render(true)' });
const top = [0, 0, 1000, 330];
const tall = [0, 0, 1000, 460];
// a palette still shows the card alone: whatever the page has behind it would be cut off by the crop
const blank = { js: "(() => { const s = document.createElement('style'); s.textContent = 'body > :not(#palette) { visibility: hidden !important; }'; document.head.append(s); })()" }; // the note-based clips run in a 1000x640 window, so the words read at the manual's width
const NARROW = '1000x640';
// a file dragged over Create new, then dropped (shell.js): the events a Finder drag sends
const drag = (type) => ({ page: 'shell', js: "(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'receipt.png', { type: 'image/png' })); document.getElementById('create').dispatchEvent(new DragEvent('" + type + "', { dataTransfer: dt, bubbles: true, cancelable: true })); })()" });

module.exports = [
  // ---- signing in ----
  { name: 'ai-signin', setup: [translateOff, open(NOTE), { wait: 400 }], steps: [{ key: '⌘K' }, { type: 'sign in with chatgpt' }, { wait: 300 }, { key: '↩' }, { wait: 600 }, blank], clip: pal },
  // ---- the model on a node ----
  { name: 'ai-discuss', video: true, size: NARROW, setup: [translateOff, open(NOTE), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'discuss', delay: 70 }, { wait: 300 }, { key: '↩' }, { wait: 1500 }, { key: '↓' }, { wait: 500 }, { key: '↩' }, { wait: 900 }], clip: top },
  { name: 'ai-classify', video: true, size: NARROW, setup: [translateOff, open(NOTE), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'auto-pick', delay: 70 }, { wait: 300 }, { key: '↩' }, { wait: 1600 }, { key: '↓' }, { wait: 500 }, { key: '↩' }, { wait: 900 }], clip: top },
  { name: 'ai-process-clip', video: true, size: '760x480', setup: [translateOff, open(NOTE), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'process image', delay: 60 }, { wait: 400 }, { key: '↩' }, { wait: 2600 }] },
  { name: 'ai-process-drop', video: true, size: '760x480', setup: [translateOff, open(NOTE), { wait: 600 }], steps: [{ hover: '#create', page: 'shell', at: [0.14, 0.8] }, { caption: 'receipt.png, dragged from the Finder' }, drag('dragenter'), drag('dragover'), { wait: 1400 }, drag('drop'), { caption: '' }, { wait: 2600 }] },
  // ---- translation ----
  { name: 'ai-autotranslate', setup: [translateOn, open(NOTE), { wait: 400 }], steps: [{ key: '⌘K' }, { type: 'auto-translate' }, { wait: 300 }, { key: '↩' }, { wait: 400 }, blank], clip: pal },
  { name: 'ai-translate', video: true, size: NARROW, setup: [translateOn, open(NOTE), { wait: 600 }], steps: [open('mocknl0'), { wait: 2600 }, { click: '#translated button' }, { wait: 1300 }, { click: '#translated button' }, { wait: 600 }], clip: [0, 0, 1000, 300] },
  { name: 'ai-translate-list', size: '900x560', setup: [translateOn, open('tana:space:mock'), { wait: 2600 }], clip: [0, 30, 620, 190] },
  { name: 'ai-replace', setup: [translateOn, open('mocknl0'), { wait: 2600 }], steps: [{ key: '⌘K' }, { type: 'translation' }, { wait: 400 }, blank], clip: pal },
  { name: 'ai-translate-into', video: true, size: NARROW, setup: [translateOff, open(NOTE), { wait: 600 }], steps: [{ click: '.node .text', text: 'Open vraag' }, { key: '⌘K' }, { type: 'translate into', delay: 60 }, { wait: 300 }, { key: '↩' }, { wait: 2400 }, { move: [700, 400] }, { wait: 300 }], clip: top },
  // ---- the agent ----
  { name: 'ai-assign', video: true, size: NARROW, setup: [translateOff, open(NOTE), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'assign to agent', delay: 55 }, { wait: 300 }, { key: '↩' }, { wait: 400 }, { type: 'Draft a one-page brief for each pilot from the notes', delay: 35 }, { wait: 500 }, { key: '⌘↩' }, { wait: 1500 }, agent([[NOTE, 'working']]), { wait: 2400 }], clip: tall },
  { name: 'ai-prompt', setup: [translateOff, open(NOTE), { wait: 400 }], steps: [{ key: '⌘K' }, { type: 'assign to agent' }, { wait: 300 }, { key: '↩' }, { wait: 400 }, { type: 'Draft a one-page brief for each pilot from the notes' }, { wait: 400 }, blank], clip: pal },
  { name: 'ai-badges', size: '900x560', setup: [translateOff, { js: "setView('library')" }, { wait: 800 }, agent([['mockdoc1', 'pending'], ['mockdoc2', 'working'], ['mockdoc3', 'waiting'], ['mockdoc4', 'done'], ['mockdoc5', 'broken'], ['mockdoc12', 'done']]), { wait: 600 }], clip: [0, 215, 900, 225] },
  { name: 'ai-agents', setup: [translateOff, open(NOTE), { wait: 400 }], steps: [{ key: '⌘K' }, { type: 'choose agents' }, { wait: 300 }, { key: '↩' }, { wait: 400 }, blank], clip: pal },
  // the fallback: a Mac whose ChatGPT app has no dot, where Dot asks for the link (main/agents/dot.js setupHint)
  { name: 'ai-dot-link', setup: [translateOff, open(NOTE), { wait: 400 }, { js: "(() => { const list = tana.agentList; tana.agentList = async () => (await list()).map((a) => (a.id === 'dot' ? { ...a, setup: 'No dot in the ChatGPT app: paste its chat link' } : a)); return 1; })()" }],
    steps: [{ key: '⌘K' }, { type: 'choose agents' }, { wait: 300 }, { key: '↩' }, { wait: 400 }, { type: 'dot' }, { wait: 300 }, { key: '↩' }, { wait: 300 }, { type: 'codex://threads/6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f' }, { wait: 300 }, blank], clip: pal },
  { name: 'ai-codex-rows', setup: [translateOff, open(NOTE), { wait: 400 }, agent([[NOTE, 'working']])], steps: [{ key: '⌘K' }, { type: 'codex' }, { wait: 400 }, blank], clip: pal },
  { name: 'ai-link', setup: [translateOff, open(NOTE), { wait: 400 }], steps: [{ key: '⌘K' }, { type: 'link codex' }, { wait: 300 }, { key: '↩' }, { wait: 300 }, { type: 'codex://threads/3f2a9c1e-7b44-4d0e-9a51-2c8e6f0b7d13' }, { wait: 300 }, blank], clip: pal },
  { name: 'ai-chat-codex', video: true, size: '1000x700', setup: [translateOff, open('tana:chat:mockchat0'), { wait: 900 }], steps: [{ click: '#composerText' }, { type: '@Codex', delay: 80 }, { wait: 500 }, { key: '↓' }, { wait: 300 }, { key: '↩' }, { type: ' what did we decide about the pilots?', delay: 35 }, { wait: 300 }, { key: '↩' }, { wait: 3400 }], hold: 1800, clip: { page: '' } },
];

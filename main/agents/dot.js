'use strict';
// The Dot agent (main/agent.js): a node handed to your dot, OpenAI's always-on personal agent, as a message in your one
// conversation with it. Nothing about it runs on this Mac and there is no API for it: the ChatGPT app is the way in.
//   - Your dot is one conversation for everything, linked once: Choose agents → Dot asks for its link (the app's Copy
//     link, codex://threads/<id>), kept as dotChat and following you to your other Macs.
//   - A task is a message: the app's own link opens that conversation with the message typed in, and ↩ is pressed in it
//     (System Events, which asks for Accessibility the first time). Sent from its composer it reaches the dot exactly as
//     a message you typed would, tagged as from ChatGPT, and the dot answers where it always does.
//   - What it does next lives in that conversation, out of this Mac's reach: the badge says it was sent, and opens it.
const fs = require('node:fs');
const agent = require('../agent');
const settings = require('../settings');

const APP = 'com.openai.codex'; // the ChatGPT desktop app, which answers codex:// links
// ponytail: every dot seen so far lives on this host, and the app's Copy link leaves it out; read it from the link if a dot ever lives elsewhere
const HOST = 'durable';
// ponytail: a fixed wait for the app to open the conversation and fill its composer (3 s was ample on a warm app);
// ↩ is pressed only once ChatGPT is in front, so a slow start fails loudly rather than pressing ↩ in another app
const SEND_AFTER = 3000;

const chatId = () => { const id = settings.get('dotChat'); return agent.UUID.test(String(id)) ? id : null; };
const appInstalled = () => ['/Applications/ChatGPT.app', require('node:os').homedir() + '/Applications/ChatGPT.app'].some((p) => fs.existsSync(p));
const chatUrl = (id, text) => 'codex://threads/' + id + '?hostId=' + HOST + (text ? '&prompt=' + encodeURIComponent(text) : '');
// codex://threads/<id>, with or without its query, or the bare id
const linkId = (text) => { const m = String(text || '').trim().match(/^(?:codex:\/\/threads\/)?([0-9a-f-]{36})\/?(?:\?.*)?$/i); return m && agent.UUID.test(m[1]) ? m[1] : null; };
// What the dot reads: what to do, then the node, by name and by the uri its Tana connection reads.
const message = (prompt, nodeUri, title) => [prompt || 'Help me with this.', '', 'Tana: ' + (agent.oneLine(title) || 'this node') + ' (' + nodeUri + ')'].join('\n');

const openUrl = (url) => require('electron').shell.openExternal(url);
// ↩ in the frontmost app, only when that is ChatGPT
const PRESS = 'tell application "System Events"\n' +
  '  if bundle identifier of first application process whose frontmost is true is not "' + APP + '" then error "ChatGPT is not in front"\n' +
  '  key code 36\n' +
  'end tell';
const press = () => new Promise((resolve, reject) => require('node:child_process').execFile('osascript', ['-e', PRESS], { timeout: 10000 }, (error) => {
  if (error) reject(new Error('Your message is typed in ChatGPT: press ↩ there to send it. To let Orbital send it, allow Orbital under Privacy & Security → Accessibility'));
  else resolve();
}));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(text) {
  const id = chatId();
  if (!id) throw new Error('Link your dot first: Choose agents → Dot');
  await openUrl(chatUrl(id, text));
  await wait(dot.sendAfter);
  await dot.press();
  return id;
}

const dot = agent.register({
  id: 'dot', label: 'Dot', icon: 'chatgpt', missing: 'Install the ChatGPT app',
  // usable once the app is here and the conversation is linked; until it is linked, Choose agents asks for the link
  available: () => appInstalled() && !!chatId(),
  setupHint: () => (appInstalled() && !chatId() ? 'Paste your dot\'s chat link' : ''),
  setup(text) { const id = linkId(text); if (!id) throw new Error('Paste your dot\'s chat link: codex://threads/…'); settings.set('dotChat', id); },
  start: ({ nodeUri, title, prompt }) => send(message(prompt, nodeUri, title)),
  // every node handed over is a message in the one conversation: sent, and from here on the dot's
  statuses: async (links) => Object.fromEntries(Object.keys(links || {}).map((nodeId) => [nodeId, 'sent'])),
  open: (taskId) => openUrl(chatUrl(linkId(taskId) || chatId())),
  sendAfter: SEND_AFTER, press, // replaced by the checks
});

module.exports = { dot, linkId, chatUrl, message };

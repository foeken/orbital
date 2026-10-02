'use strict';
// The Dot agent (main/agent.js): a node handed to your dot, OpenAI's always-on personal agent, as a message in your one
// conversation with it. Nothing about it runs on this Mac and there is no API for it: the ChatGPT app is the way in.
//   - Your dot is one conversation for everything, linked once: Choose agents → Dot asks for its link (the app's Copy
//     link, codex://threads/<id>), kept as dotChat and following you to your other Macs.
//   - A task is a message: the app's own link opens that conversation with the message typed in, and ↩ is pressed in it
//     (System Events, which asks for Accessibility the first time). Sent from its composer it reaches the dot exactly as
//     a message you typed would, tagged as from ChatGPT, and the dot answers where it always does.
//   - What it does next lives in that conversation, out of this Mac's reach, so it reports in the node: Orbital adds
//     "Agent status: Working" at the end once the message is sent, the dot ends each update with Working, Completed or
//     Failed, and the badge follows the last one (main/documents.js agentStatus). The badge opens the conversation.
//   - One conversation for every node (oneChat): a node keeps no task id, only that Dot has it; the conversation is dotChat.
const fs = require('node:fs');
const agent = require('../agent');
const settings = require('../settings');
const documents = require('../documents'); // as a whole, so the checks can stand in for a node's status

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
// What the dot reads: what to do, the node by name and by the uri its Tana connection reads, and how to report back
// there. It leaves the task's own status alone: that stays yours, and Agent completed is not you having completed it.
const message = (prompt, nodeUri, title) => [prompt || 'Help me with this.', '', 'Tana: ' + (agent.oneLine(title) || 'this node') + ' (' + nodeUri + ')',
  'Keep this Tana task updated: add your updates at the end of it, and end each update with a line "Agent status: Working", '
  + 'or "Agent status: Completed" when you are done, or "Agent status: Failed" if you cannot finish. Leave the task\'s own status as it is.'].join('\n');
const BADGE = { working: 'working', completed: 'done', failed: 'broken' };

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

function linked() { const id = chatId(); if (!id) throw new Error('Link your dot first: Choose agents → Dot'); return id; }
async function send(text) {
  await openUrl(chatUrl(linked(), text));
  await wait(dot.sendAfter);
  await dot.press();
}

const dot = agent.register({
  id: 'dot', label: 'Dot', icon: 'chatgpt', missing: 'Install the ChatGPT app', oneChat: true,
  // usable once the app is here and the conversation is linked; until it is linked, Choose agents asks for the link
  available: () => appInstalled() && !!chatId(),
  setupHint: () => (appInstalled() && !chatId() ? 'Paste your dot\'s chat link' : ''),
  setup(text) { const id = linkId(text); if (!id) throw new Error('Paste your dot\'s chat link: codex://threads/…'); settings.set('dotChat', id); },
  async start({ nodeUri, title, prompt }) {
    await send(message(prompt, nodeUri, title));
    // the dot has it once the message is sent; a line that will not write loses only the badge's first state, never the handoff
    await documents.writeAgentStatus(nodeUri, 'Working').catch(() => {});
  },
  // the last status line in each node; none (written away) is still with the dot, and a node that cannot be read needs you
  statuses: async (links) => Object.fromEntries(await Promise.all(Object.keys(links || {}).map(async (nodeId) =>
    [nodeId, BADGE[await documents.agentStatus(nodeId).catch(() => 'failed')] || 'working']))),
  open: () => openUrl(chatUrl(linked())),
  sendAfter: SEND_AFTER, press, // replaced by the checks
});

module.exports = { dot, linkId, chatUrl, message };

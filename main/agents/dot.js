'use strict';
// The Dot agent (main/agent.js): a node handed to your dot, OpenAI's always-on personal agent, as a message in your one
// conversation with it. Nothing about it runs on this Mac and there is no API for it: the ChatGPT app is the way in.
//   - Your dot is one conversation for everything, found in the ChatGPT app on this Mac (appDot below), kept as dotChat
//     and following you to your other Macs. Only when the app has no dot does Choose agents → Dot ask for its link (the
//     app's Copy link, codex://threads/<id>).
//   - A task is a message: the app's own link opens that conversation with the message typed in, and you press ↩ to
//     send it. Orbital presses no keys (no System Events, no Accessibility): sent from the composer it reaches the dot
//     exactly as a message you typed would, and the dot answers where it always does.
//   - What it does next lives in that conversation, out of this Mac's reach, so it reports in the node: Orbital adds
//     no status of its own, since it cannot tell whether you sent it; the dot ends each update with Working, Completed
//     or Failed, and the badge follows the last one (main/documents.js agentStatus), working until there is one. The
//     badge opens the conversation.
//   - One conversation for every node (oneChat): a node keeps no task id, only that Dot has it; the conversation is dotChat.
const fs = require('node:fs');
const agent = require('../agent');
const settings = require('../settings');
const documents = require('../documents'); // as a whole, so the checks can stand in for a node's status

// ponytail: every dot seen so far lives on this host, and the app's Copy link leaves it out; read it from the link if a dot ever lives elsewhere
const HOST = 'durable';

// Your dot as the ChatGPT app on this Mac knows it: the dot it picked for your account ("primary-aeon-selection-v1" in
// its state file, its root conversation), read again only once that file has changed. ponytail: the app's own state
// file, not an API; should it move, this finds nothing and Dot asks for the link as before.
let seen = { file: null, mtime: 0, id: null };
function appDot() {
  try {
    const file = dot.stateFile, mtime = fs.statSync(file).mtimeMs;
    if (file !== seen.file || mtime !== seen.mtime) {
      const pick = JSON.parse(fs.readFileSync(file, 'utf8'))['electron-persisted-atom-state']?.['primary-aeon-selection-v1']?.response;
      const id = pick?.profile?.active_root_thread_id || pick?.selection?.thread_id;
      seen = { file, mtime, id: pick?.selection?.available !== false && agent.UUID.test(String(id)) ? id : null };
    }
    return seen.id;
  } catch { return null; } // no app state here, or one being rewritten: what is stored stands
}
// the app's dot wins and is stored, so a dot made anew is followed and another Mac without the app knows it too
function chatId() {
  const found = appDot(), stored = settings.get('dotChat');
  if (found && found !== stored) settings.set('dotChat', found);
  const id = found || stored;
  return agent.UUID.test(String(id)) ? id : null;
}
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

function linked() { const id = chatId(); if (!id) throw new Error('Link your dot first: Choose agents → Dot'); return id; }

const dot = agent.register({
  id: 'dot', label: 'Dot', icon: 'chatgpt', missing: 'Install the ChatGPT app', oneChat: true,
  // usable once the app is here and the conversation is linked; until it is linked, Choose agents asks for the link
  available: () => appInstalled() && !!chatId(),
  setupHint: () => (appInstalled() && !chatId() ? 'No dot in the ChatGPT app: paste its chat link' : ''),
  setup(text) { const id = linkId(text); if (!id) throw new Error('Paste your dot\'s chat link: codex://threads/…'); settings.set('dotChat', id); },
  async start({ nodeUri, title, prompt }) {
    // typed in, for you to send: the conversation is in front, with the message in its composer
    await openUrl(chatUrl(linked(), message(prompt, nodeUri, title)));
  },
  // the last status line in each node; none (written away) is still with the dot, and a node that cannot be read needs you
  statuses: async (links) => Object.fromEntries(await Promise.all(Object.keys(links || {}).map(async (nodeId) =>
    [nodeId, BADGE[await documents.agentStatus(nodeId).catch(() => 'failed')] || 'working']))),
  open: () => openUrl(chatUrl(linked())),
  stateFile: require('node:path').join(require('node:os').homedir(), '.codex', '.codex-global-state.json'), // the ChatGPT app's; replaced by the checks
});

module.exports = { dot, linkId, chatUrl, message };

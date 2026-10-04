'use strict';
// The Claude agent (main/agent.js): a node handed to Claude Code on this Mac, through the user's own `claude` and its
// own sign-in. Orbital never signs in to Anthropic and never sees a Claude token: it starts `claude -p` as the user
// would in a terminal, which is what Anthropic's terms allow a third-party app to do.
//   - A task is a non-interactive run (`claude -p`) with a session id chosen here, in the shared Tana workspace. -p
//     skips the workspace trust prompt that `claude --bg` stops on, and the id is known before the run starts.
//   - It runs detached, so the work carries on when Orbital quits, and nothing here has to hand a writer back.
//   - What it is doing is read from its transcript (~/.claude/projects/<workspace>/<id>.jsonl), the record Claude Code
//     resumes from: a run that ended its turn is done, one that ended on an error is broken, anything else is working.
//   - Go to Claude task opens Terminal on `claude --resume <id>` in that workspace, where the session lives.
// The model is Claude Code's own default, as Codex's is.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agent = require('../agent');
const { S } = require('../state');

const claudeBin = () => agent.findBin('claude', [path.join(os.homedir(), '.claude', 'local', 'claude')]);
// the binary, or an Orbital error: a synced Claude link can be opened on a Mac without Claude Code
function needClaude() { const bin = claudeBin(); if (!bin) throw new Error('Claude Code is not installed on this Mac'); return bin; }
const workspace = () => agent.agentWorkspace(S.userData);

// One detached run of `claude -p`. The prompt follows `--`, so words that start with a dash stay words. It resolves once
// the process has started and rejects when it could not be, so a handoff that never ran is refused, not left pending.
function runDetached(args, prompt) {
  const child = require('node:child_process').spawn(needClaude(), ['-p', ...args, '--', prompt], { cwd: workspace(), detached: true, stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    child.once('spawn', () => { child.unref(); resolve(); });
    child.once('error', (error) => reject(new Error('Claude Code could not be started: ' + error.message)));
  });
}

// ---- reading a session back ----
// ponytail: the projects folder is scanned for the file rather than its name worked out from the workspace path,
// because Claude Code's own encoding of that path (realpath, "/" and "." as "-") is not documented; a scan of a few
// folders, once per session (`found` keeps the file). Work it out if the folder count ever makes this slow.
// Read without blocking and only the end of the file: the status poll runs every 30 s in the main process, where a
// whole long session read synchronously stalled every window (#671 review). The last turn is all a state needs.
// ponytail: a last turn bigger than TAIL (one huge tool output) is cut off and reads as working; read more if it bites.
const found = new Map(), TAIL = 256 * 1024;
async function transcriptFile(id) {
  if (found.has(id)) return found.get(id);
  if (!agent.UUID.test(String(id))) return null;
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = await fs.promises.readdir(root); } catch { return null; }
  for (const dir of dirs) {
    const file = path.join(root, dir, id + '.jsonl');
    try { await fs.promises.access(file); found.set(id, file); return file; } catch {}
  }
  return null; // not written yet: looked for again next time
}
async function transcript(id) {
  const file = await transcriptFile(id);
  if (!file) return null;
  let handle;
  try {
    handle = await fs.promises.open(file);
    const { size } = await handle.stat(), start = Math.max(0, size - TAIL), bytes = Buffer.alloc(size - start);
    await handle.read(bytes, 0, bytes.length, start);
    let text = bytes.toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1); // the first line read from the middle is a partial one
    return text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { found.delete(id); return null; } finally { await handle?.close(); }
}
// Where a session stands, from its last turn: the last user or assistant message in the main thread decides.
// ponytail: a run killed half way (a reboot) ends on neither and reads as working for ever; reassigning starts afresh.
function sessionState(entries) {
  if (!entries) return { state: 'pending', text: '' };
  const said = entries.filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain && !e.isMeta && e.message);
  const last = said.at(-1);
  if (!last || last.type !== 'assistant' || !['end_turn', 'stop_sequence'].includes(last.message.stop_reason)) return { state: 'working', text: '' };
  const text = (Array.isArray(last.message.content) ? last.message.content : []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
  // an error Claude Code reports instead of an answer (a refused login, a usage limit) is a synthetic message
  return last.message.model === '<synthetic>' ? { state: 'broken', text } : { state: 'done', text };
}

// A Terminal window running one command: a .command file opened by the OS, which needs no Automation permission.
const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
async function inTerminal(command) {
  const file = path.join(os.tmpdir(), 'orbital-claude-' + Date.now().toString(36) + '.command');
  fs.writeFileSync(file, '#!/bin/sh\ncd ' + quote(workspace()) + ' && exec ' + command + '\n', { mode: 0o700 });
  const failed = await require('electron').shell.openPath(file);
  if (failed) throw new Error(failed);
}

// A task that only answers (a chat question) runs without the tools that change anything on this Mac, refused by
// Claude Code itself whatever the user's own settings allow.
const CHANGES = ['Bash', 'Edit', 'Write', 'NotebookEdit'];
const claude = agent.register({
  // local: a session lives in this Mac's ~/.claude only, so its link names this Mac (main/agent.js setTask)
  id: 'claude', label: 'Claude', icon: 'robot', missing: 'Install Claude Code', local: true,
  available: () => !!claudeBin(),
  async start({ nodeUri, title, prompt, rules, readOnly }) {
    const id = require('node:crypto').randomUUID();
    const name = agent.oneLine(title, 60);
    await runDetached(['--session-id', id, ...(name ? ['-n', 'Tana: ' + name] : []), ...(rules ? ['--append-system-prompt', rules] : []), ...(readOnly ? ['--disallowedTools', ...CHANGES] : [])], nodeUri ? agent.agentPrompt(nodeUri, title, prompt) : prompt);
    return id;
  },
  async resume(taskId, prompt) { if (prompt) await runDetached(['--resume', taskId], prompt); },
  statuses: async (links) => Object.fromEntries(await Promise.all(Object.entries(links || {}).map(async ([nodeId, id]) => [nodeId, sessionState(await transcript(id)).state]))),
  open: async (taskId) => { if (!agent.UUID.test(String(taskId))) throw new Error('Not a Claude session'); return inTerminal(quote(needClaude()) + ' --resume ' + taskId); },
  // A session id, as `claude --resume` takes it, or the command itself pasted whole.
  linkId: (text) => { const m = String(text || '').trim().match(/^(?:claude\s+(?:--resume|-r)\s+)?([0-9a-f-]{36})$/i); return m && agent.UUID.test(m[1]) ? m[1] : null; },
  openNew: async (link) => inTerminal(quote(needClaude()) + ' -- ' + quote(link)),
  read: async (taskIds) => new Map(await Promise.all(taskIds.map(async (id) => {
    const { state, text } = sessionState(await transcript(id));
    return [id, { state: state === 'done' && text ? 'done' : state === 'broken' ? 'failed' : 'working', text }];
  }))),
});

module.exports = { claude, claudeBin, sessionState, transcript };

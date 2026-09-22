'use strict';
// Records "this Tana node is handled by this Codex task" in the app's own settings, for a Codex task to call on
// itself. The task knows its own id from CODEX_THREAD_ID (set in every agent shell by the Codex runtime), so the
// link is authoritative from the inside and nothing has to guess which thread was just created.
//
//   node scripts/agent-link.js --node tana:text:<ulid> --thread <uuid>
//   node scripts/agent-link.js --node tana:text:<ulid>            # print the linked task, if any
//
// It writes through main/agent.js, the same map the app reads and the same record shape — host beside the thread id —
// so there is one implementation of the link and no second store. SQLite takes the write while the app is running;
// the app reads the setting fresh on every use.
const path = require('node:path');
const db = require('../db');
const NODE_URI = /^tana:[a-z-]+:[0-9a-z]{26}$/; // a Tana document uri — the same shape main/state.js calls DOC_URI

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
// The app keeps its database in its Electron userData (userdata.js: appData/Orbital/tasks.sqlite, or the older
// tana-tasks folder until the app moves it). The env var is for the checks, which run against a temporary file.
function dbPath() {
  if (process.env.ORBITAL_DB) return process.env.ORBITAL_DB;
  return path.join(require('../userdata').userDataDir(), 'tasks.sqlite'); // reads where the app is; moving it is the app's job
}

function main() {
  const node = arg('node'), thread = arg('thread');
  if (!NODE_URI.test(String(node))) { console.error('agent-link: --node must be a Tana node uri, e.g. tana:text:01h0000000000000000000000'); return 2; }
  db.open(dbPath());
  const agent = require('../main/agent'); // after db.open: the settings store it reads is this database
  if (thread === undefined) { const known = agent.codexTaskFor(node); console.log(known || ''); return known ? 0 : 1; }
  if (!agent.THREAD_ID.test(String(thread))) { console.error('agent-link: --thread must be a Codex thread id (uuid), normally "$CODEX_THREAD_ID"'); return 2; }
  const link = agent.taskLink(node);
  if (link && link.threadId === thread) { console.log('already linked ' + node + ' -> ' + thread); return 0; } // running twice is not an error
  agent.setCodexTask(node, thread, link && link.host); // the machine the app recorded stays on the record
  console.log('linked ' + node + ' -> ' + thread);
  return 0;
}
process.exitCode = main();

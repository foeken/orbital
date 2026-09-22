'use strict';
// Records "this Tana node is handled by this Codex task" in the app's own settings, for a Codex task to call on
// itself. The task knows its own id from CODEX_THREAD_ID (set in every agent shell by the Codex runtime), so the
// link is authoritative from the inside and nothing has to guess which thread was just created.
//
//   node scripts/agent-link.js --node tana:text:<ulid> --thread <uuid>
//   node scripts/agent-link.js --node tana:text:<ulid>            # print the linked task, if any
//
// It writes through db.js, the same settings table the app reads, so there is one implementation of the map and no
// second store. SQLite takes the write while the app is running; the app reads the setting fresh on every use.
const path = require('node:path');
const db = require('../db');
const NODE_URI = /^tana:[a-z-]+:[0-9a-z]{26}$/; // a Tana document uri — the same shape main/state.js calls DOC_URI
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // a Codex thread/session uuid

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
// The app keeps its database in its Electron userData (userdata.js: appData/Orbital/tasks.sqlite, or the older
// tana-tasks folder until the app moves it). The env var is for the checks, which run against a temporary file.
function dbPath() {
  if (process.env.TANA_TASKS_DB) return process.env.TANA_TASKS_DB;
  return path.join(require('../userdata').userDataDir(), 'tasks.sqlite'); // reads where the app is; moving it is the app's job
}
const tasks = () => { const stored = db.setting('codexTask'); return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}; };

function main() {
  const node = arg('node'), thread = arg('thread');
  if (!NODE_URI.test(String(node))) { console.error('agent-link: --node must be a Tana node uri, e.g. tana:text:01h0000000000000000000000'); return 2; }
  db.open(dbPath());
  if (thread === undefined) { const known = tasks()[node]; console.log(known || ''); return known ? 0 : 1; }
  if (!THREAD_ID.test(String(thread))) { console.error('agent-link: --thread must be a Codex thread id (uuid), normally "$CODEX_THREAD_ID"'); return 2; }
  const map = tasks();
  if (map[node] === thread) { console.log('already linked ' + node + ' -> ' + thread); return 0; } // running twice is not an error
  map[node] = thread;
  db.setSetting('codexTask', map);
  console.log('linked ' + node + ' -> ' + thread);
  return 0;
}
process.exitCode = main();

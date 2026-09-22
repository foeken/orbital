'use strict';
// Add or remove a Codex host in the app's own settings, for the one-time setup a person does by hand. The app's
// Cmd+K pages do the same thing; this exists so a machine can be configured without opening the window, and so a
// record is user data rather than a default baked into the source.
//
//   node scripts/codex-host.js --add --name Donut --ssh donut.example.ts.net --bin /Users/you/.local/bin/codex
//   node scripts/codex-host.js --list
//   node scripts/codex-host.js --remove <id>
//
// Adding is idempotent on the address: the same machine twice is one record, updated in place.
const path = require('node:path');
const db = require('../db');

const arg = (name) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (name) => process.argv.includes('--' + name);
function dbPath() {
  if (process.env.ORBITAL_DB) return process.env.ORBITAL_DB;
  return path.join(require('../userdata').userDataDir(), 'tasks.sqlite'); // appData/Orbital, or the older tana-tasks folder
}
function main() {
  db.open(dbPath());
  const agent = require('../main/agent');
  if (has('list')) { for (const h of agent.hosts()) console.log(h.id + '  ' + h.title); return 0; }
  if (has('remove')) { agent.removeHost(arg('remove')); console.log('removed ' + arg('remove')); return 0; }
  if (!has('add')) { console.error('codex-host: --add, --list or --remove <id>'); return 2; }
  const ssh = arg('ssh');
  const already = agent.hosts().map((h) => agent.hostRecord(h.id)).find((h) => h && h.ssh === ssh);
  if (already) { console.log('already configured ' + already.id + '  ' + already.title); return 0; } // running it twice is not an error
  const record = agent.addHost({ title: arg('name'), ssh, bin: arg('bin') });
  console.log('added ' + record.id + '  ' + record.title);
  return 0;
}
process.exitCode = main();

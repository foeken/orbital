#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const tana = require('../tana');

tana.init({ authFile: '/tmp/tana-tasks-auth.json', openUrl: url => { spawn('open', [url], { stdio: 'ignore', detached: true }).unref(); } });

const [cmd, ...a] = process.argv.slice(2);
const cmds = {
  login: () => tana.login().then(() => 'logged in'),
  pull: () => tana.pullTasks(),
  content: () => tana.readContent(a[0]),
  push: () => tana.pushTask({ id: a[0], title: a[1], done: Number(a[2]) }).then(() => 'pushed')
};
if (!cmds[cmd]) { console.error('usage: tana-cli login | pull | content <id> | push <id> <title> <done>'); process.exit(2); }
cmds[cmd]().then(r => { console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2)); process.exit(0); },
  e => { console.error(e.stack || e); process.exit(1); });


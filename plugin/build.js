'use strict';
// The Orbital plugin for ChatGPT (plugin/): Orbital's relay and Tana's MCP server in one, and the setup skill that links.
// A workspace with its own relay (docs/AGENT-RELAY.md) gets the same plugin with its relay in it:
//   node plugin/build.js                                                        -> dist/plugins/orbital.zip (orbital.md)
//   node plugin/build.js https://orbital.nedap.chatgpt.site/api/mcp Nedap       -> dist/plugins/orbital-nedap.zip
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [relay, workspace] = process.argv.slice(2);
if (relay && (!/^https:\/\/\S+$/.test(relay) || !workspace)) throw new Error('usage: node plugin/build.js [<relay https URL> <workspace name>]');
const slug = workspace ? 'orbital-' + workspace.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'orbital';
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-plugin-')), dir = path.join(stage, slug);
fs.cpSync(__dirname, dir, { recursive: true, filter: (f) => path.basename(f) !== 'build.js' });
if (relay) {
  const edit = (file, fn) => { const p = path.join(dir, file); fs.writeFileSync(p, JSON.stringify(fn(JSON.parse(fs.readFileSync(p, 'utf8'))), null, 2) + '\n'); };
  edit('mcp.json', (m) => { m.mcpServers.orbital.url = relay; return m; });
  edit('plugin.json', (p) => { p.name = slug; p.extensions['com.openai'].interface.displayName = 'Orbital for ' + workspace; return p; });
}
const out = path.join(__dirname, '..', 'dist', 'plugins', slug + '.zip');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync('zip', ['-qr', out, slug], { cwd: stage });
fs.rmSync(stage, { recursive: true });
console.log(out);

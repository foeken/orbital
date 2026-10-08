'use strict';
// The Orbital plugin for ChatGPT (plugin/): Orbital's relay and Tana's MCP server in one, and the setup skill that links.
// Which relay is not in the repo: it is the workspace's (docs/AGENT-RELAY.md), so the zip is made where that is known,
// by Orbital itself (main/agents/linked.js, the Connect page's Save the Orbital plugin), or here:
//   node plugin/build.js                                                 -> dist/plugins/orbital.zip, for orbital.md
//   node plugin/build.js https://orbital.nedap.chatgpt.site/api/mcp      -> the same plugin with that relay in it
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The plugin with relay in its mcp.json, zipped to out (macOS's own zip; the folder inside is named as the plugin is)
function pack(relay, out) {
  if (!/^https:\/\/\S+$/.test(relay) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(relay)) throw new Error('A relay is at an https:// URL');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-plugin-')), dir = path.join(stage, 'orbital');
  try {
    fs.cpSync(__dirname, dir, { recursive: true, filter: (f) => path.basename(f) !== 'build.js' });
    const mcp = path.join(dir, 'mcp.json'), json = JSON.parse(fs.readFileSync(mcp, 'utf8'));
    json.mcpServers.orbital.url = relay;
    fs.writeFileSync(mcp, JSON.stringify(json, null, 2) + '\n');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.rmSync(out, { force: true });
    execFileSync('zip', ['-qr', out, 'orbital'], { cwd: stage });
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  return out;
}

if (require.main === module) console.log(pack(process.argv[2] || 'https://orbital.md/mcp', path.join(__dirname, '..', 'dist', 'plugins', 'orbital.zip')));
module.exports = { pack };

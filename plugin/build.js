'use strict';
// The Orbital plugin for ChatGPT (plugin/): Orbital's MCP server and Tana's MCP server in one, and the setup skill that links.
// Which MCP server is not in the repo: it is the workspace's (docs/MCP-SERVER.md), so the zip is made where that is known,
// by Orbital itself (main/agents/linked.js, the Connect page's Save the Orbital plugin), or here:
//   node plugin/build.js                                                 -> dist/plugins/orbital.zip, for orbital.md
//   node plugin/build.js https://orbital.acme.chatgpt.site/api/mcp      -> the same plugin with that MCP server in it
//   node plugin/build.js <url> asdk_app_…                                -> Tana by the workspace's own Tana app in ChatGPT
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// A ChatGPT app's id, as .app.json names one (asdk_app_<hex>, or connector_<name> for one of OpenAI's own)
const APP_ID = /\b(asdk_app_[0-9a-f]{32}|connector_[0-9a-z_]+)\b/;
// The plugin with MCP server in its mcp.json, zipped to out (macOS's own zip; the folder inside is named as the plugin is).
// tanaApp: the Tana app the ChatGPT workspace already has; the plugin then requires that app (.app.json) instead of
// bringing Tana's MCP server a second time, which would be a second Tana connection with its own sign-in and tools.
function pack(url, out, tanaApp) {
  if (!/^https:\/\/\S+$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('A relay URL is https:// URL');
  if (tanaApp && !APP_ID.test(tanaApp)) throw new Error('A ChatGPT app id looks like asdk_app_…');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-plugin-')), dir = path.join(stage, 'orbital');
  try {
    fs.cpSync(__dirname, dir, { recursive: true, filter: (f) => path.basename(f) !== 'build.js' });
    const mcp = path.join(dir, 'mcp.json'), json = JSON.parse(fs.readFileSync(mcp, 'utf8'));
    json.mcpServers.orbital.url = url;
    if (tanaApp) {
      delete json.mcpServers.tana;
      fs.writeFileSync(path.join(dir, '.app.json'), JSON.stringify({ apps: { tana: { id: tanaApp.match(APP_ID)[1], required: true } } }, null, 2) + '\n');
      const manifest = path.join(dir, 'plugin.json'), plugin = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      plugin.extensions['com.openai'].apps = './.app.json';
      fs.writeFileSync(manifest, JSON.stringify(plugin, null, 2) + '\n');
    }
    fs.writeFileSync(mcp, JSON.stringify(json, null, 2) + '\n');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.rmSync(out, { force: true });
    execFileSync('zip', ['-qr', out, 'orbital'], { cwd: stage });
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  return out;
}

if (require.main === module) console.log(pack(process.argv[2] || 'https://orbital.md/mcp', path.join(__dirname, '..', 'dist', 'plugins', 'orbital.zip'), process.argv[3]));
module.exports = { pack };

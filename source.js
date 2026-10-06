'use strict';
// Which repo and commit this copy was built from, in the user agent Orbital sends Tana (main/views.js, the CLI), so
// Tana can tell a fork's traffic from this repo's. A checkout asks git; the package has no .git, so `npm run package`
// writes source.json beside this file first (package.json prepackage) and the app reads that.
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const FILE = path.join(__dirname, 'source.json');
// git@github.com:owner/repo.git, https://user@github.com/owner/repo/ → owner/repo
const repoOf = (url) => url.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).slice(-2).join('/');
const git = (...args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function read() {
  // the package never runs git: on a Mac without it, /usr/bin/git opens the developer tools installer
  if (!fs.existsSync(path.join(__dirname, '.git'))) { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } }
  try { return { repo: repoOf(git('remote', 'get-url', 'origin')), hash: git('rev-parse', '--short', 'HEAD') }; } catch { return null; }
}
let source;
// 'Orbital' → 'Orbital/0.11.0 (foeken/orbital@36b494ee)'
const userAgent = (product) => {
  if (source === undefined) source = read();
  return product + '/' + require('./package.json').version + (source ? ` (${source.repo}@${source.hash})` : '');
};
if (require.main === module) fs.writeFileSync(FILE, JSON.stringify(read()) + '\n');
module.exports = { userAgent, repoOf };

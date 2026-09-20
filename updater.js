// Updates, without Squirrel. Squirrel.Mac verifies that the incoming bundle's signature matches the running one and
// re-launches through its own helper; swapping the bundle after we quit is a dozen lines and `ditto` keeps both the
// Developer ID signature and the stapled ticket intact. Releases live in their own public repo (the source repo is
// private), so the check is an unauthenticated GitHub API call: no token, no gh CLI, and anyone can update.
// scripts/release.sh publishes exactly what this downloads.
const { app, dialog } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const os = require('node:os');
const path = require('node:path');

const REPO = 'foeken/tana-companion-releases';
const run = promisify(execFile);

// Release tags are npm versions ("v0.2.10"), which is all release.sh ever writes, so three integers decide it.
function isNewer(latest, current) {
  const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parts(latest), parts(current)];
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for the latest release`);
  return res.json();
}

// manual = the menu item, which reports "up to date" and failures; the launch and daily checks stay silent.
async function check({ manual = false } = {}) {
  try {
    if (!app.isPackaged) {
      if (manual) await dialog.showMessageBox({ message: 'This is a development run.', detail: 'Updates only apply to the packaged app.' });
      return;
    }
    const release = await latestRelease();
    if (!isNewer(release.tag_name, app.getVersion())) {
      if (manual) await dialog.showMessageBox({ message: `Orbital ${app.getVersion()} is up to date.` });
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: `Orbital ${release.tag_name.replace(/^v/, '')} is available.`,
      detail: `You have ${app.getVersion()}. The app restarts to finish updating.`,
      buttons: ['Update and Restart', 'Later'], defaultId: 0, cancelId: 1,
    });
    if (response === 0) await install(release);
  } catch (e) {
    if (manual) dialog.showErrorBox('Could not check for updates', String((e && e.message) || e));
  }
}

async function install(release) {
  const asset = (release.assets || []).find((a) => a.name.endsWith('.zip'));
  if (!asset) throw new Error(`Release ${release.tag_name} has no .zip asset`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tana-update-'));
  const zip = path.join(dir, asset.name);
  const res = await fetch(asset.browser_download_url); // redirects to the asset CDN; fetch follows them
  if (!res.ok) throw new Error(`Download failed with ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip)); // streamed: the bundle is well over 100 MB
  await run('/usr/bin/ditto', ['-xk', zip, dir]);
  const fresh = path.join(dir, 'Orbital.app');
  await fs.access(path.join(fresh, 'Contents', 'Info.plist')); // a half-downloaded zip must not reach the rm below
  const target = path.resolve(app.getPath('exe'), '../../..'); // …/Orbital.app/Contents/MacOS/<exe>
  if (!target.endsWith('.app')) throw new Error('Cannot locate the running app bundle');
  // The zip came over https from GitHub; before anything is replaced, codesign confirms the bundle inside it is
  // intact and signed by the team that signed the running copy. A tampered, truncated or ad-hoc build fails here,
  // while the running app is still in place.
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', fresh]);
  const team = async (bundle) => teamOf((await run('/usr/bin/codesign', ['-dv', '--verbose=2', bundle])).stderr);
  const [mine, theirs] = await Promise.all([team(target), team(fresh)]);
  if (!theirs || theirs !== mine) throw new Error(`The download is signed by ${theirs || 'nobody'}, this app by ${mine || 'nobody'}`);
  // The running bundle cannot be replaced underneath itself: hand the swap to a detached shell that waits for
  // this process to exit, then reopens the new copy.
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const swap = `while /bin/kill -0 ${process.pid} 2>/dev/null; do /bin/sleep 0.5; done; /bin/rm -rf ${q(target)} && /usr/bin/ditto ${q(fresh)} ${q(target)} && /usr/bin/open ${q(target)}; /bin/rm -rf ${q(dir)}`;
  spawn('/bin/sh', ['-c', swap], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

// The team behind a Developer ID signature, from codesign -dv output; null for an ad-hoc signature ("not set").
function teamOf(codesignOutput) {
  const id = String(codesignOutput).match(/^TeamIdentifier=(.+)$/m)?.[1];
  return id && id !== 'not set' ? id : null;
}

module.exports = { check, isNewer, teamOf };

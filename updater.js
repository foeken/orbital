// Updates, without Squirrel. Squirrel.Mac refuses a bundle whose code signature does not match the running one,
// and our builds are ad-hoc signed (a new cdhash every time), so the supported path is closed; swapping the bundle
// after we quit is a dozen lines. Releases live in a private repo, so instead of shipping a token the check borrows
// the gh CLI's existing login. scripts/release.sh publishes exactly what this downloads.
const { app, dialog } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = 'foeken/tana-companion';
const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']; // a GUI app inherits none of the shell's PATH
const run = promisify(execFile);

// Release tags are npm versions ("v0.2.10"), which is all release.sh ever writes, so three integers decide it.
function isNewer(latest, current) {
  const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parts(latest), parts(current)];
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

async function gh(args) {
  for (const bin of GH) {
    try { return (await run(bin, args)).stdout; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error('GitHub CLI not found. Install it with: brew install gh');
}

// manual = the menu item, which reports "up to date" and failures; the launch and daily checks stay silent.
async function check({ manual = false } = {}) {
  try {
    if (!app.isPackaged) {
      if (manual) await dialog.showMessageBox({ message: 'This is a development run.', detail: 'Updates only apply to the packaged app.' });
      return;
    }
    const release = JSON.parse(await gh(['release', 'view', '--repo', REPO, '--json', 'tagName']));
    if (!isNewer(release.tagName, app.getVersion())) {
      if (manual) await dialog.showMessageBox({ message: `Tana Companion ${app.getVersion()} is up to date.` });
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: `Tana Companion ${release.tagName.replace(/^v/, '')} is available.`,
      detail: `You have ${app.getVersion()}. The app restarts to finish updating.`,
      buttons: ['Update and Restart', 'Later'], defaultId: 0, cancelId: 1,
    });
    if (response === 0) await install(release.tagName);
  } catch (e) {
    if (manual) dialog.showErrorBox('Could not check for updates', String((e && e.message) || e));
  }
}

async function install(tag) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tana-update-'));
  await gh(['release', 'download', tag, '--repo', REPO, '--pattern', '*.zip', '--dir', dir]);
  const zip = (await fs.readdir(dir)).find((f) => f.endsWith('.zip'));
  if (!zip) throw new Error(`Release ${tag} has no .zip asset`);
  await run('/usr/bin/ditto', ['-xk', path.join(dir, zip), dir]);
  const fresh = path.join(dir, 'Tana Companion.app');
  await fs.access(path.join(fresh, 'Contents', 'Info.plist')); // a half-downloaded zip must not reach the rm below
  const target = path.resolve(app.getPath('exe'), '../../..'); // …/Tana Companion.app/Contents/MacOS/<exe>
  if (!target.endsWith('.app')) throw new Error('Cannot locate the running app bundle');
  // The running bundle cannot be replaced underneath itself: hand the swap to a detached shell that waits for
  // this process to exit, then reopens the new copy.
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const swap = `while /bin/kill -0 ${process.pid} 2>/dev/null; do /bin/sleep 0.5; done; /bin/rm -rf ${q(target)} && /usr/bin/ditto ${q(fresh)} ${q(target)} && /usr/bin/open ${q(target)}; /bin/rm -rf ${q(dir)}`;
  spawn('/bin/sh', ['-c', swap], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

module.exports = { check, isNewer };

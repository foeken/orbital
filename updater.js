// Updates, without Squirrel. Squirrel.Mac verifies that the incoming bundle's signature matches the running one and
// re-launches through its own helper; swapping the bundle after we quit is a dozen lines and `ditto` keeps both the
// Developer ID signature and the stapled ticket intact. Releases live in this public repo, so the check is an
// unauthenticated GitHub API call: no token, no gh CLI, and anyone can update. scripts/release.sh publishes exactly
// what this downloads. Copies up to 0.9.1 read foeken/orbital-releases instead, where release.sh mirrors each release
// until they have all moved: one update from there brings them to a copy that reads this repo.
// What a check finds is shown on the update card (update.html, #667): the notes of every release since this one, then
// a progress bar while the newest downloads and is checked, until the app quits to swap itself.
const { app, dialog } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createWriteStream, constants } = require('node:fs');
const fs = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const os = require('node:os');
const path = require('node:path');
const { blocks, segments } = require('./sdk/chat'); // the markdown the chat draws: release notes are the same kind

const REPO = 'foeken/orbital';
const run = promisify(execFile);
// What a download may be before anything has checked whose signature it carries (security review finding 4): the zip,
// what it unpacks to, and how long fetching and unpacking may take. A release is a few hundred MB packed (release.sh);
// these are far past that, so they bound a hostile archive and never a real one.
const BOUNDS = { zip: 1024 ** 3, unpacked: 4 * 1024 ** 3, files: 200000, download: 30 * 60e3, unpack: 10 * 60e3 };

// Release tags are npm versions ("v0.2.10"), which is all release.sh ever writes, so three integers decide it.
function isNewer(latest, current) {
  const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parts(latest), parts(current)];
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

// The published releases newer than `current`, newest first: [0] is what installs, all of them are the notes.
const newer = (releases, current) => releases.filter((r) => r && !r.draft && !r.prerelease && isNewer(r.tag_name, current))
  .sort((a, b) => (isNewer(a.tag_name, b.tag_name) ? -1 : 1));
// ponytail: the last 30 releases; a copy further behind than that sees only their notes, and still gets the newest
async function newerReleases() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for the releases`);
  return newer(await res.json(), app.getVersion());
}

// A release's notes as the card draws them: markdown blocks with their inline marks, without release.sh's opening line
// ("Orbital 0.9.1 for Apple Silicon. Signed and notarized; unzip …"), which is for a download by hand.
const notes = (body) => blocks(body)
  .filter((b, i) => !(i === 0 && b.block === 'paragraph' && /notarized/i.test(b.text)))
  .map((b) => ({ block: b.block, ...(b.depth ? { depth: b.depth } : {}), segments: b.verbatim ? [{ text: b.text }] : segments(b.text) }));

// The download's step in its pipeline: every chunk passes through, and progress hears each new whole percent of total.
// Past max bytes the download stops there, whatever the server said it would send.
const counting = (total, progress, max = Infinity) => async function* (chunks) {
  let got = 0, told = -1;
  for await (const chunk of chunks) {
    got += chunk.length;
    if (got > max) throw new Error('The download is larger than it should be');
    const pct = total ? Math.floor((got * 100) / total) : 0;
    if (pct !== told) { told = pct; progress({ got, total }); }
    yield chunk;
  }
};
// What a zip says it unpacks to, from its own directory (unzip -Zt), before a byte of it is unpacked
async function unpacked(zip) {
  const m = /(\d+) files?, (\d+) bytes uncompressed/.exec(await run('/usr/bin/unzip', ['-Zt', zip], { timeout: 60e3 }).then((r) => r.stdout, () => ''));
  if (!m) throw new Error('The download is not a zip that can be read');
  return { files: Number(m[1]), bytes: Number(m[2]) };
}
// The release fetched and unpacked into a folder of its own, within BOUNDS, and handed to verify: { dir, fresh } (the
// Orbital.app inside). Whatever fails on the way, the folder goes with it; on success the swap removes it.
async function stage(asset, progress = () => {}, verify = async () => {}, get = fetch) {
  if (asset.size > BOUNDS.zip) throw new Error('The download is larger than an Orbital release can be');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-update-'));
  try {
    const zip = path.join(dir, path.basename(asset.name));
    const res = await get(asset.browser_download_url, { signal: AbortSignal.timeout(BOUNDS.download) }); // redirects to the asset CDN; fetch follows them
    if (!res.ok) throw new Error(`Download failed with ${res.status}`);
    // streamed: the bundle is well over 100 MB; never more than the release says it is
    await pipeline(Readable.fromWeb(res.body), counting(asset.size || Number(res.headers.get('content-length')) || 0, progress, Math.min(asset.size || BOUNDS.zip, BOUNDS.zip)), createWriteStream(zip));
    progress({ verifying: true });
    const { files, bytes } = await unpacked(zip);
    if (files > BOUNDS.files || bytes > BOUNDS.unpacked) throw new Error('The download unpacks to more than an Orbital release can be');
    await run('/usr/bin/ditto', ['-xk', zip, dir], { timeout: BOUNDS.unpack });
    const fresh = path.join(dir, 'Orbital.app');
    await fs.access(path.join(fresh, 'Contents', 'Info.plist')); // a half-downloaded zip must not reach the rm below
    await verify(fresh);
    return { dir, fresh };
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

let offer = null, installing = null; // the releases the card shows; the one install under way, whichever card asked

// The Android app (scripts/release.sh attaches it to a release as ANDROID_APK): the Help tour's phone page offers it,
// with a code for the latest release's download address, only while the latest release has one (help.html), and says
// coming soon otherwise. { version } or null; asked of GitHub once an hour at most, however many pages ask.
const ANDROID_APK = 'Orbital-android.apk';
const androidIn = (release) => (release && !release.draft && (release.assets || []).some((a) => a.name === ANDROID_APK) ? { version: String(release.tag_name).replace(/^v/, '') } : null);
let android = null; // { at, answer }: a promise, so pages asking at once share one request
function androidRelease() {
  if (!android || Date.now() - android.at > 3600e3) {
    const answer = fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10e3) })
      .then((res) => { if (!res.ok) throw new Error(`GitHub returned ${res.status} for the latest release`); return res.json(); }).then(androidIn);
    android = { at: Date.now(), answer };
    answer.catch(() => { if (android && android.answer === answer) android = null; }); // a failure is asked again next time
  }
  return android.answer;
}

// manual = the menu item or Cmd+K, which report "up to date" and failures; the launch and daily checks stay silent.
// show() lays the update card over a window (main.js), false when it cannot (no window, or an overlay already there).
async function check({ manual = false, show = () => false } = {}) {
  try {
    if (!app.isPackaged) {
      if (manual) await dialog.showMessageBox({ message: 'This is a development run.', detail: 'Updates only apply to the packaged app.' });
      return;
    }
    const releases = await newerReleases();
    if (!releases.length) {
      if (manual) await dialog.showMessageBox({ message: `Orbital ${app.getVersion()} is up to date.` });
      return;
    }
    if (installing) return;
    offer = releases;
    if (!show() && manual) await dialog.showMessageBox({ message: `Orbital ${releases[0].tag_name.replace(/^v/, '')} is available.`, detail: 'Close what is open over the window and check for updates again.' });
  } catch (e) {
    if (manual) dialog.showErrorBox('Could not check for updates', String((e && e.message) || e));
  }
}

// The card's two calls (preload.js updateInfo, installUpdate). A failure goes back to the card, which says it and
// offers the button again; success never answers, because the app quits.
const ipc = {
  'update:info': () => offer && { current: app.getVersion(), releases: offer.map((r) => ({ version: r.tag_name.replace(/^v/, ''), date: r.published_at, notes: notes(r.body) })) },
  'update:android': () => androidRelease().catch(() => null),
  'update:install': (e) => {
    if (!offer) throw new Error('There is no update to install');
    const tell = (p) => { if (!e.sender.isDestroyed()) e.sender.send('update:progress', p); };
    return (installing ||= install(offer[0], tell).finally(() => { installing = null; }));
  },
};

// progress({ got, total }) while the zip downloads, { verifying: true } once it is unpacked and checked
async function install(release, progress = () => {}) {
  const target = path.resolve(app.getPath('exe'), '../../..'); // …/Orbital.app/Contents/MacOS/<exe>
  if (!target.endsWith('.app')) throw new Error('Cannot locate the running app bundle');
  // A copy opened straight from Downloads runs from macOS's read-only App Translocation mount, and one in a folder
  // this user cannot write is no better: the swap below runs after quit, its rm fails, and the app never comes back.
  if (!(await canReplace(target))) throw new Error('Orbital cannot replace itself where it is running from. Move Orbital to your Applications folder in Finder, open it from there and check for updates again.');
  const asset = (release.assets || []).find((a) => a.name.endsWith('.zip'));
  if (!asset) throw new Error(`Release ${release.tag_name} has no .zip asset`);
  // The zip came over https from GitHub; before anything is replaced, codesign confirms the bundle inside it is
  // intact and carries a Developer ID signature, chained to Apple, of the team that signed the running copy. A
  // tampered, truncated, ad-hoc or self-signed build fails here, while the running app is still in place.
  const { dir, fresh } = await stage(asset, progress, async (bundle) => {
    const mine = teamOf((await run('/usr/bin/codesign', ['-dv', '--verbose=2', target])).stderr);
    if (!mine) throw new Error('This copy of Orbital is not signed, so an update cannot be checked against it');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', signedBy(mine), bundle])
      .catch(() => { throw new Error('The download is not signed by the team that signed this app'); });
  });
  // The running bundle cannot be replaced underneath itself: hand the swap to a detached shell that waits for
  // this process to exit, then reopens the new copy.
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const swap = `while /bin/kill -0 ${process.pid} 2>/dev/null; do /bin/sleep 0.5; done; /bin/rm -rf ${q(target)} && /usr/bin/ditto ${q(fresh)} ${q(target)} && /usr/bin/open ${q(target)}; /bin/rm -rf ${q(dir)}`;
  spawn('/bin/sh', ['-c', swap], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

// The swap removes the bundle and writes a new one beside it, so both the bundle and its folder must be writable.
async function canReplace(bundle) {
  try {
    await fs.access(bundle, constants.W_OK);
    await fs.access(path.dirname(bundle), constants.W_OK);
    return true;
  } catch { return false; }
}

// The team behind a Developer ID signature, from codesign -dv output; null for an ad-hoc signature ("not set").
function teamOf(codesignOutput) {
  const id = String(codesignOutput).match(/^TeamIdentifier=(.+)$/m)?.[1];
  return id && id !== 'not set' ? id : null;
}

// The code requirement for "a Developer ID Application signature of `team`, chained to Apple's root", for
// `codesign --verify -R`. --verify alone accepts any consistent signature, and -dv only repeats what the certificate
// claims, so a self-signed certificate naming the right team passes both; this requirement does not.
const signedBy = (team) => {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error('Not a team identifier: ' + team);
  return `=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${team}"`;
};

module.exports = { check, ipc, isNewer, newer, notes, counting, unpacked, stage, BOUNDS, teamOf, signedBy, canReplace, androidIn, ANDROID_APK };

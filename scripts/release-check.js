'use strict';
// scripts/release.sh, run for real in a scratch folder with everything it reaches outside replaced by stubs that write
// down how they were called (git, npm, gh, xcrun, security, spctl, ditto, and scripts/android-release.sh, which
// scripts/phones.sh tests on its own): the Android key is checked with the Mac's credentials before the version moves,
// the APK goes to this repo's release beside the zip and never to the mirror, and ORBITAL_ANDROID=0 releases the Mac
// alone. Nothing here signs, builds or publishes anything.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function release(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-release-check-'));
  try {
    const bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
    fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(bin);
    fs.copyFileSync(path.join(__dirname, 'release.sh'), path.join(dir, 'scripts', 'release.sh'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'orbital', version: '0.10.0' }));
    const stub = (file, body = '') => fs.writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$(basename "$0") $*" >> "$RELEASE_LOG"\n' + body, { mode: 0o755 });
    stub(path.join(bin, 'git'), '[ "$1" = status ] && exit 0\nexit 0\n');
    stub(path.join(bin, 'security'), 'echo \'  1) ABC "Developer ID Application: Orbital (TEAM)"\'\n');
    for (const name of ['xcrun', 'spctl']) stub(path.join(bin, name));
    // MAIN_RED: the scheduled checks on main are failing (an open "Scheduled checks failed", checks.yml)
    stub(path.join(bin, 'gh'), '[ "$1 $2" = "issue list" ] && [ -n "$MAIN_RED" ] && echo "Scheduled checks failed"\nexit 0\n');
    stub(path.join(bin, 'npm'), '[ "$1" = version ] && node -e "const f = \'package.json\', p = JSON.parse(require(\'fs\').readFileSync(f)); p.version = \'0.10.1\'; require(\'fs\').writeFileSync(f, JSON.stringify(p))"\n[ "$1" = run ] && mkdir -p dist/Orbital-darwin-arm64/Orbital.app\nexit 0\n');
    stub(path.join(bin, 'ditto'), 'for last; do :; done; touch "$last"\n');
    stub(path.join(dir, 'scripts', 'android-release.sh'), '[ "$1" = --check ] && { [ -z "$ANDROID_REFUSES" ] || exit 1; exit 0; }\ntouch "$1"\n');
    const run = spawnSync('sh', [path.join(dir, 'scripts', 'release.sh'), 'patch'], { cwd: dir, encoding: 'utf8',
      env: { ...process.env, ORBITAL_ANDROID: '', ANDROID_REFUSES: '', MAIN_RED: '', ...env, PATH: bin + path.delimiter + process.env.PATH, RELEASE_LOG: log } });
    return { status: run.status, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const at = (calls, start) => calls.findIndex((c) => c.startsWith(start));
const releases = (calls, repo) => calls.filter((c) => c.startsWith('gh release create') && c.includes('--repo ' + repo));

{
  const { status, calls } = release();
  assert.equal(status, 0, 'a release with Android runs to the end');
  assert.ok(at(calls, 'android-release.sh --check') > at(calls, 'xcrun notarytool history') && at(calls, 'android-release.sh --check') < at(calls, 'npm version'),
    'the Android key is checked with the Mac credentials, before the version is bumped');
  assert.ok(at(calls, 'npm run phones') > at(calls, 'android-release.sh --check') && at(calls, 'npm run phones') < at(calls, 'npm version'),
    'both phones are tested on this Mac before the version is bumped');
  const build = at(calls, 'android-release.sh dist/Orbital-android.apk');
  assert.ok(build > at(calls, 'npm run package') && build < at(calls, 'git push'), 'the APK is built from the bumped commit, before anything is pushed');
  const [main] = releases(calls, 'foeken/orbital ');
  assert.ok(main.startsWith('gh release create v0.10.1 dist/Orbital-0.10.1-arm64.zip dist/Orbital-android.apk '), 'this repo\u2019s release carries the zip and the APK');
  assert.match(main, /Signed and notarized; unzip and move it to Applications\. For Android 10 or later: add https:\/\/github\.com\/foeken\/orbital to Obtainium/, 'its notes open with the Mac line and the Android one, in the one paragraph the update card leaves out');
  const [mirror] = releases(calls, 'foeken/orbital-releases');
  assert.ok(mirror.startsWith('gh release create v0.10.1 dist/Orbital-0.10.1-arm64.zip --repo') && !/apk|Android/i.test(mirror), 'the mirror, for old Mac copies, gets the zip alone');
}
{
  const { status, calls } = release({ ORBITAL_ANDROID: '0' });
  assert.equal(status, 0, 'ORBITAL_ANDROID=0 releases the Mac alone');
  assert.equal(at(calls, 'android-release.sh'), -1, 'and asks nothing of Android');
  assert.ok(releases(calls, 'foeken/orbital ')[0].startsWith('gh release create v0.10.1 dist/Orbital-0.10.1-arm64.zip --repo') && !/apk|Android/i.test(releases(calls, 'foeken/orbital ')[0]), 'with the zip alone and no Android line');
}
{
  const { status, calls } = release({ ANDROID_REFUSES: '1' });
  assert.notEqual(status, 0, 'a release key that is missing, unpinned or a debug key stops the release');
  assert.equal(at(calls, 'npm version'), -1, 'before the version is bumped, so there is nothing to undo');
}
{
  const { status, calls } = release({ MAIN_RED: '1' });
  assert.notEqual(status, 0, 'the scheduled checks failing on main hold the release');
  assert.equal(at(calls, 'security'), -1, 'asked first, before the credentials, the bump or the build');
}
{
  const { calls } = release();
  assert.ok(at(calls, 'gh pr checks --required --watch') > at(calls, 'gh pr create') && at(calls, 'gh pr checks --required --watch') < at(calls, 'gh pr merge'),
    'the bump merges once the checks main requires have passed (main-green.yml)');
}
console.log('release ok');

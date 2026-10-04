'use strict';
// scripts/release.sh, run for real in a scratch folder with everything it reaches outside replaced by stubs that write
// down how they were called (git, npm, gh, xcrun, security, spctl, ditto, scripts/promote.js, which promote-check.js
// tests on its own, and scripts/android-release.sh, which scripts/phones.sh tests on its own). A release is tested main:
// it takes no version and bumps nothing, tags only through promote.js after every credential is checked, builds nothing
// from a tag promote.js does not pass, builds from the tag checked out, and publishes on that tag only. The APK goes to
// this repo's release beside the zip and never to the mirror, and ORBITAL_ANDROID=0 releases the Mac alone. Nothing
// here signs, builds or publishes anything.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TAGGED = 'a'.repeat(40);
function release(env = {}, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-release-check-'));
  try {
    const bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
    fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(bin);
    fs.copyFileSync(path.join(__dirname, 'release.sh'), path.join(dir, 'scripts', 'release.sh'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'orbital', version: '0.10.1' }));
    const stub = (file, body = '') => fs.writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$(basename "$0") $*" >> "$RELEASE_LOG"\n' + body, { mode: 0o755 });
    // git: a clean tree, main's package.json, a tag there or not (TAG_EXISTS), HEAD the tagged commit unless MOVED
    stub(path.join(bin, 'git'), [
      'case "$1" in',
      '  status) exit 0;;',
      '  show) cat package.json;;',
      '  symbolic-ref) echo main;;',
      '  rev-parse) case "$*" in *--verify*) [ -n "$TAG_EXISTS" ] || exit 1;; "rev-parse HEAD") echo "${MOVED:-' + TAGGED + '}";; *) echo ' + TAGGED + ';; esac;;',
      'esac', 'exit 0', ''].join('\n'));
    stub(path.join(bin, 'security'), 'echo \'  1) ABC "Developer ID Application: Orbital (TEAM)"\'\n');
    for (const name of ['xcrun', 'spctl', 'gh']) stub(path.join(bin, name));
    stub(path.join(bin, 'npm'), '[ "$1" = ls ] && { [ -z "$MODULES_DIFFER" ] || exit 1; }\n[ "$1" = run ] && mkdir -p dist/Orbital-darwin-arm64/Orbital.app\nexit 0\n');
    stub(path.join(bin, 'ditto'), 'for last; do :; done; touch "$last"\n');
    // promote.js through node: tag and verify-tag, each refusing when the test says so
    fs.writeFileSync(path.join(dir, 'scripts', 'promote.js'), 'const fs = require("fs"); fs.appendFileSync(process.env.RELEASE_LOG, "promote.js " + process.argv.slice(2).join(" ") + "\\n"); if ((process.env.PROMOTE_REFUSES || "").split(",").includes(process.argv[2])) process.exit(1);\n');
    stub(path.join(dir, 'scripts', 'android-release.sh'), '[ "$1" = --check ] && { [ -z "$ANDROID_REFUSES" ] || exit 1; exit 0; }\ntouch "$1"\n');
    const run = spawnSync('sh', [path.join(dir, 'scripts', 'release.sh'), ...args], { cwd: dir, encoding: 'utf8',
      env: { ...process.env, ORBITAL_ANDROID: '', ANDROID_REFUSES: '', TAG_EXISTS: '', MOVED: '', MODULES_DIFFER: '', PROMOTE_REFUSES: '', ...env, PATH: bin + path.delimiter + process.env.PATH, RELEASE_LOG: log } });
    return { status: run.status, out: run.stdout + run.stderr, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const at = (calls, start) => calls.findIndex((c) => c.startsWith(start));
const releases = (calls, repo) => calls.filter((c) => c.startsWith('gh release create') && c.includes('--repo ' + repo));
const nothingBuilt = (calls, why) => {
  assert.equal(at(calls, 'npm run package'), -1, why + ': nothing is built');
  assert.equal(at(calls, 'gh release'), -1, why + ': nothing is published');
};

{
  const { status, calls } = release();
  assert.equal(status, 0, 'a release with Android runs to the end');
  assert.equal(at(calls, 'npm version'), -1, 'it bumps nothing: the bump went through the gate');
  assert.equal(at(calls, 'gh pr'), -1, 'it opens and merges no pull request');
  assert.equal(at(calls, 'git push'), -1, 'it pushes nothing itself: promote.js pushes the tag');
  const tag = at(calls, 'promote.js tag');
  assert.ok(tag > at(calls, 'android-release.sh --check') && tag > at(calls, 'xcrun notarytool history'), 'every credential is checked before main is tagged');
  assert.ok(at(calls, 'promote.js verify-tag v0.10.1') > tag, 'the tag is held to the gate before anything is built');
  const checkout = at(calls, 'git switch -q --detach ' + TAGGED);
  assert.ok(checkout > at(calls, 'promote.js verify-tag') && checkout < at(calls, 'npm run package'), 'the build is of the tagged commit, checked out');
  assert.ok(at(calls, 'npm ls') < at(calls, 'npm run package'), 'with node_modules that match it');
  const build = at(calls, 'android-release.sh dist/Orbital-android.apk');
  assert.ok(build > at(calls, 'npm run package') && build < at(calls, 'gh release create'), 'the APK is built from the same commit, before anything is published');
  const [main] = releases(calls, 'foeken/orbital ');
  assert.ok(main.startsWith('gh release create v0.10.1 dist/Orbital-0.10.1-arm64.zip dist/Orbital-android.apk '), 'this repo\u2019s release carries the zip and the APK');
  assert.match(main, /--verify-tag/, 'on the tag promote.js made, never a new one');
  assert.match(main, /Signed and notarized; unzip and move it to Applications\. For Android 10 or later: open Orbital-android\.apk/, 'its notes open with the Mac line and the Android one, in the one paragraph the update card leaves out');
  const [mirror] = releases(calls, 'foeken/orbital-releases');
  assert.ok(mirror.startsWith('gh release create v0.10.1 dist/Orbital-0.10.1-arm64.zip --repo') && !/apk|Android/i.test(mirror), 'the mirror, for old Mac copies, gets the zip alone');
  assert.equal(calls[calls.length - 1], 'git switch -q main', 'and the checkout is back where it was');
}
{
  const { status, calls } = release({ TAG_EXISTS: '1' });
  assert.equal(status, 0, 'a version already tagged is released from that tag');
  assert.equal(at(calls, 'promote.js tag'), -1, 'with no second tag');
  assert.ok(at(calls, 'promote.js verify-tag v0.10.1') >= 0, 'and held to the gate all the same');
}
{
  const { status, calls, out } = release({}, ['patch']);
  assert.notEqual(status, 0, 'a version on the command line is refused');
  assert.match(out, /promote\.js bump patch/);
  assert.deepEqual(calls, [], 'before it touches anything');
}
{
  const { status, calls } = release({ PROMOTE_REFUSES: 'tag' });
  assert.notEqual(status, 0, 'main that is not a tested merge is not tagged, and not released');
  nothingBuilt(calls, 'an untested main');
}
{
  const { status, calls } = release({ TAG_EXISTS: '1', PROMOTE_REFUSES: 'verify-tag' });
  assert.notEqual(status, 0, 'a tag on a commit the gate did not pass is not released');
  nothingBuilt(calls, 'an untested tag');
}
{
  const { status, calls } = release({ MODULES_DIFFER: '1' });
  assert.notEqual(status, 0, 'node_modules that do not match the tag stop it');
  nothingBuilt(calls, 'stale node_modules');
  assert.equal(calls[calls.length - 1], 'git switch -q main', 'and the checkout goes back');
}
{
  const { status, calls } = release({ MOVED: 'b'.repeat(40) });
  assert.notEqual(status, 0, 'a checkout that moved during the build stops it');
  assert.equal(at(calls, 'gh release'), -1, 'before anything is published');
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
  assert.equal(at(calls, 'promote.js tag'), -1, 'before main is tagged, so there is nothing to undo');
  nothingBuilt(calls, 'a refused key');
}
console.log('release ok');

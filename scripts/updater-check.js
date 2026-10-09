// The two branches in the updater: which release counts as newer than the running build, and whose signature a
// downloaded bundle carries (an ad-hoc signature is nobody's, so it can never replace a signed app).
const assert = require('node:assert');
const { isNewer, newer, notes, counting, teamOf, signedBy, canReplace, androidIn, ANDROID_APK } = require('../updater');

assert.equal(isNewer('v0.2.1', '0.2.0'), true);
assert.equal(isNewer('v0.2.0', '0.2.0'), false);
assert.equal(isNewer('v0.1.9', '0.2.0'), false, 'a higher patch in a lower minor is not newer');
assert.equal(isNewer('v0.2.10', '0.2.9'), true, 'versions are numbers, not strings');
assert.equal(isNewer('v1.0.0', '0.9.9'), true);
assert.equal(isNewer('0.2.1', '0.2.0'), true, 'the v prefix is optional');
// The update card (#667): every published release since this one, newest first, and its notes as markdown blocks
assert.deepEqual(newer([{ tag_name: 'v0.9.1' }, { tag_name: 'v0.10.0' }, { tag_name: 'v0.9.0' }, { tag_name: 'v0.11.0', draft: true }, { tag_name: 'v0.12.0', prerelease: true }], '0.9.0').map((r) => r.tag_name),
  ['v0.10.0', 'v0.9.1'], 'newer, published, newest first');
assert.deepEqual(notes('Orbital 0.9.1 for Apple Silicon. Signed and notarized; unzip and move it to Applications.\n\n## Editing\n- **Markdown** typed (#601).'),
  [{ block: 'heading2', segments: [{ text: 'Editing' }] }, { block: 'bullet', segments: [{ text: 'Markdown', marks: { bold: true } }, { text: ' typed (#601).' }] }],
  'release.sh\'s download line goes, headings and marks stay');
assert.deepEqual(notes('- Chat\n  - **Thinking** shimmers').map((b) => b.depth), [undefined, 1], 'a sub-bullet keeps its depth');
// The Android app is offered only by a latest release that has it, under the one name release.sh gives it and the Help
// tour's code downloads (help.html #helpAndroidLink): a Mac-only release, or an APK under another name, is coming soon
const zip = { name: 'Orbital-0.10.0-arm64.zip' };
assert.deepEqual(androidIn({ tag_name: 'v0.10.0', assets: [zip, { name: ANDROID_APK }] }), { version: '0.10.0' }, 'the latest release with the APK');
assert.equal(androidIn({ tag_name: 'v0.10.0', assets: [zip] }), null, 'a Mac-only release');
assert.equal(androidIn({ tag_name: 'v0.10.0', assets: [zip, { name: 'Orbital-0.10.0.apk' }] }), null, 'an APK under another name than the code downloads');
assert.equal(androidIn({ message: 'Not Found' }), null, 'no release at all');
{
  const read = (f) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', f), 'utf8');
  assert.ok(read('scripts/release.sh').includes('dist/' + ANDROID_APK), 'release.sh attaches the APK under the name the updater looks for');
  assert.ok(read('help.html').includes('href="https://github.com/foeken/orbital/releases/latest/download/' + ANDROID_APK + '"'), 'the Help tour downloads that name from the latest release of this repo');
}
// The download's progress: each new whole percent once, the bytes all passed on
(async () => {
  const { Readable, Writable } = require('node:stream'), { pipeline } = require('node:stream/promises');
  const seen = []; let bytes = 0;
  await pipeline(Readable.from([Buffer.alloc(3), Buffer.alloc(3), Buffer.alloc(10), Buffer.alloc(984)]), counting(1000, (p) => seen.push(p.got)),
    new Writable({ write(c, _e, cb) { bytes += c.length; cb(); } }));
  assert.deepEqual(seen, [3, 16, 1000], '0%, then 1%, then 100%: the second 0% chunk says nothing');
  assert.equal(bytes, 1000, 'every byte reaches the file');
  // and stops past the bytes it may have, whatever the server said it would send (security review finding 4)
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), counting(0, () => {}, 10), new Writable({ write(c, _e, cb) { cb(); } })), /larger than it should be/);
})().catch((e) => { console.error(e); process.exit(1); });
// A release download is staged within bounds before its signature is looked at, and nothing of a failed try stays behind
(async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync } = require('node:child_process');
  const { stage, unpacked, BOUNDS } = require('../updater');
  const staging = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('orbital-update-')).sort().join();
  const before = staging();
  const serve = (chunks, length) => async () => ({ ok: true, status: 200, headers: { get: () => (length == null ? null : String(length)) }, body: ReadableStream.from(chunks) });
  await assert.rejects(stage({ name: 'Orbital.zip', size: BOUNDS.zip + 1 }, () => {}, undefined, serve([])), /larger than an Orbital release/, 'a release that says it is too big is not fetched');
  await assert.rejects(stage({ name: 'Orbital.zip', size: 10 }, () => {}, undefined, serve([new Uint8Array(8), new Uint8Array(8)])), /larger than it should be/, 'a body longer than the release says is stopped there');
  await assert.rejects(stage({ name: 'Orbital.zip', size: 0 }, () => {}, undefined, serve([new Uint8Array(4)])), /not a zip/, 'bytes that are no zip go no further');
  if (process.platform === 'darwin') { // ditto is Apple's, and CI runs on Linux
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-zip-'));
    try {
      fs.mkdirSync(path.join(src, 'Orbital.app', 'Contents'), { recursive: true });
      fs.writeFileSync(path.join(src, 'Orbital.app', 'Contents', 'Info.plist'), 'x'.repeat(1000));
      execFileSync('/usr/bin/ditto', ['-ck', '--keepParent', path.join(src, 'Orbital.app'), path.join(src, 'o.zip')]);
      const zip = fs.readFileSync(path.join(src, 'o.zip'));
      assert.ok((await unpacked(path.join(src, 'o.zip'))).bytes >= 1000, 'what a zip unpacks to is read from its own directory');
      let seen = null;
      await assert.rejects(stage({ name: 'Orbital.zip', size: zip.length }, () => {}, async (fresh) => { seen = fs.existsSync(path.join(fresh, 'Contents', 'Info.plist')); throw new Error('not signed'); }, serve([zip])), /not signed/, 'a bundle its check refuses');
      assert.equal(seen, true, 'is checked unpacked');
      const unpackedBound = BOUNDS.unpacked; BOUNDS.unpacked = 999;
      await assert.rejects(stage({ name: 'Orbital.zip', size: zip.length }, () => {}, undefined, serve([zip])), /unpacks to more/, 'and one that would unpack past the bound is not unpacked');
      BOUNDS.unpacked = unpackedBound;
      const { dir } = await stage({ name: 'Orbital.zip', size: zip.length }, () => {}, async () => {}, serve([zip]));
      assert.ok(fs.existsSync(path.join(dir, 'Orbital.app')), 'a good one is left staged for the swap');
      fs.rmSync(dir, { recursive: true, force: true });
    } finally { fs.rmSync(src, { recursive: true, force: true }); }
  }
  assert.equal(staging(), before, 'and no failed try leaves its staging folder behind');
})().catch((e) => { console.error(e); process.exit(1); });
assert.equal(teamOf('Executable=/x\nIdentifier=com.dreetje.orbital\nTeamIdentifier=ABCDE12345\nSealed Resources=none'), 'ABCDE12345');
assert.equal(teamOf('Identifier=com.dreetje.orbital\nSignature=adhoc\nTeamIdentifier=not set'), null, 'an ad-hoc build belongs to no team');
assert.equal(teamOf('Identifier=com.dreetje.orbital'), null, 'and no line at all is no team either');
assert.throws(() => signedBy('ABC" or true'), /team identifier/, 'a team is ten letters or digits, never requirement syntax');
// A bundle in a folder this user cannot write (or on the read-only App Translocation mount) is refused before quit.
(async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-rw-')), app = path.join(dir, 'Orbital.app');
  try {
    fs.mkdirSync(app);
    assert.equal(await canReplace(app), true, 'a bundle in a writable folder can be swapped');
    fs.chmodSync(dir, 0o555);
    if (process.getuid && process.getuid() !== 0) assert.equal(await canReplace(app), false, 'one in a read-only folder cannot');
  } finally { fs.chmodSync(dir, 0o755); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
// The hole this closes (#260): an ad-hoc signature passes `codesign --verify --strict`, so that alone proves nothing
// about who signed a download. Only on a Mac: codesign is Apple's, and CI runs on Linux.
if (process.platform === 'darwin') {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-sig-')), bin = path.join(dir, 'ls');
  const ok = (...args) => { try { execFileSync('/usr/bin/codesign', args, { stdio: 'ignore' }); return true; } catch { return false; } };
  try {
    fs.copyFileSync('/bin/ls', bin);
    assert.ok(ok('--force', '--sign', '-', bin), 'the copy is signed ad hoc');
    assert.equal(ok('--verify', '--strict', bin), true, 'an ad-hoc signature is consistent, which is all --verify checks');
    assert.equal(ok('--verify', '--strict', '-R', signedBy('2DC432GLL2'), bin), false, 'and it is refused once the signature must chain to a Developer ID of the team');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// What the package leaves out (package.json's --ignore, #417): loro-crdt's four builds other than the one node
// requires (16 MB of the 26 MB asar) and the offline checks, while everything the app reads at runtime stays in.
{
  const path = require('node:path'), root = path.join(__dirname, '..');
  const ignore = new RegExp(require('../package.json').scripts.package.match(/--ignore='([^']+)'/)[1]);
  const shipped = (file) => !ignore.test('/' + path.relative(root, file).split(path.sep).join('/'));
  for (const file of [require.resolve('loro-crdt'), path.join(path.dirname(require.resolve('loro-crdt')), 'loro_wasm_bg.wasm'),
    'main.js', 'preload.js', 'canvas-preload.js', 'index.html', 'update.html', 'update.js', 'settings.html', 'settings.js', 'settings.css', 'shell.html', 'shell.js', 'shell.css', 'node_modules/@danfessler/trellis/dist/index.js',
    'node_modules/@danfessler/trellis/dist/style.css', 'node_modules/@danfessler/trellis/LICENSE.md', 'build/nucleo-ui.json.gz', 'main/agents/index.js', 'main/agents/tana.js', 'main/agents/codex.js', 'scripts/platform-cli.js', 'source.js', 'source.json']) {
    assert.ok(shipped(path.resolve(root, file)), file + ' is shipped: the app requires or runs it');
  }
  for (const file of ['node_modules/loro-crdt/web/index.js', 'node_modules/loro-crdt/base64', 'node_modules/loro-crdt/bundler/loro_wasm_bg.wasm',
    'node_modules/loro-crdt/browser', 'scripts/sdk-check.js', 'scripts/fixtures/task-snapshot.b64', 'ios/Orbital/Engine.swift', 'ios/engine/index.js']) {
    assert.ok(!shipped(path.resolve(root, file)), file + ' is left out of the package');
  }
}
// The repo and commit in the user agent (source.js): a fork's own origin, and in the package the source.json baked by prepackage.
{
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { repoOf } = require('../source');
  for (const url of ['git@github.com:someone/orbital.git', 'https://github.com/someone/orbital', 'https://x:tok@github.com/someone/orbital.git/\n']) assert.equal(repoOf(url), 'someone/orbital', url);
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'source-'));
  fs.copyFileSync(path.join(__dirname, '../source.js'), path.join(app, 'source.js'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  fs.writeFileSync(path.join(app, 'source.json'), JSON.stringify({ repo: 'someone/orbital', hash: 'abc1234' }));
  assert.equal(require(path.join(app, 'source.js')).userAgent('Orbital'), 'Orbital/1.2.3 (someone/orbital@abc1234)', 'the package reads source.json');
  assert.match(require('../source').userAgent('Orbital'), /^Orbital\/[\d.]+ \([^/ ]+\/[^@ ]+@[0-9a-f]{7,}\)$/, 'a checkout asks git');
  fs.rmSync(app, { recursive: true });
}
console.log('updater ok');

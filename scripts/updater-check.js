// The two branches in the updater: which release counts as newer than the running build, and whose signature a
// downloaded bundle carries (an ad-hoc signature is nobody's, so it can never replace a signed app).
const assert = require('node:assert');
const { isNewer, teamOf, signedBy } = require('../updater');

assert.equal(isNewer('v0.2.1', '0.2.0'), true);
assert.equal(isNewer('v0.2.0', '0.2.0'), false);
assert.equal(isNewer('v0.1.9', '0.2.0'), false, 'a higher patch in a lower minor is not newer');
assert.equal(isNewer('v0.2.10', '0.2.9'), true, 'versions are numbers, not strings');
assert.equal(isNewer('v1.0.0', '0.9.9'), true);
assert.equal(isNewer('0.2.1', '0.2.0'), true, 'the v prefix is optional');
assert.equal(teamOf('Executable=/x\nIdentifier=com.dreetje.orbital\nTeamIdentifier=ABCDE12345\nSealed Resources=none'), 'ABCDE12345');
assert.equal(teamOf('Identifier=com.dreetje.orbital\nSignature=adhoc\nTeamIdentifier=not set'), null, 'an ad-hoc build belongs to no team');
assert.equal(teamOf('Identifier=com.dreetje.orbital'), null, 'and no line at all is no team either');
assert.throws(() => signedBy('ABC" or true'), /team identifier/, 'a team is ten letters or digits, never requirement syntax');
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
    'main.js', 'preload.js', 'index.html', 'shell.html', 'shell.js', 'shell.css', 'vendor/trellis/index.js',
    'vendor/trellis/style.css', 'vendor/trellis/LICENSE.md', 'build/nucleo-ui.json.gz', 'scripts/agent-link.js', 'scripts/codex-host.js', 'scripts/platform-cli.js']) {
    assert.ok(shipped(path.resolve(root, file)), file + ' is shipped: the app requires or runs it');
  }
  for (const file of ['node_modules/loro-crdt/web/index.js', 'node_modules/loro-crdt/base64', 'node_modules/loro-crdt/bundler/loro_wasm_bg.wasm',
    'node_modules/loro-crdt/browser', 'scripts/sdk-check.js', 'scripts/fixtures/task-snapshot.b64']) {
    assert.ok(!shipped(path.resolve(root, file)), file + ' is left out of the package');
  }
}
console.log('updater ok');

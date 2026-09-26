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
console.log('updater ok');

// The two branches in the updater: which release counts as newer than the running build, and whose signature a
// downloaded bundle carries (an ad-hoc signature is nobody's, so it can never replace a signed app).
const assert = require('node:assert');
const { isNewer, teamOf } = require('../updater');

assert.equal(isNewer('v0.2.1', '0.2.0'), true);
assert.equal(isNewer('v0.2.0', '0.2.0'), false);
assert.equal(isNewer('v0.1.9', '0.2.0'), false, 'a higher patch in a lower minor is not newer');
assert.equal(isNewer('v0.2.10', '0.2.9'), true, 'versions are numbers, not strings');
assert.equal(isNewer('v1.0.0', '0.9.9'), true);
assert.equal(isNewer('0.2.1', '0.2.0'), true, 'the v prefix is optional');
assert.equal(teamOf('Executable=/x\nIdentifier=inc.tana.companion\nTeamIdentifier=ABCDE12345\nSealed Resources=none'), 'ABCDE12345');
assert.equal(teamOf('Identifier=inc.tana.companion\nSignature=adhoc\nTeamIdentifier=not set'), null, 'an ad-hoc build belongs to no team');
assert.equal(teamOf('Identifier=inc.tana.companion'), null, 'and no line at all is no team either');
console.log('updater ok');

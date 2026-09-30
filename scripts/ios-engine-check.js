'use strict';
// The phone engine's own logic that no other check covers (ios/engine/stand-ins.js): the synchronous sha256 the page
// uses in place of node:crypto, which names Tana's agent (sdk/chat.js deterministicId), against Node's own, across the
// padding edges (55, 56 and 64 bytes) and a multi-block input; and createHash's hex and byte digests.
const assert = require('node:assert');
const crypto = require('node:crypto');
const standIns = require('../ios/engine/stand-ins.js');

for (const text of ['', 'abc', 'system:tana', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'é'.repeat(300)]) {
  const want = crypto.createHash('sha256').update(text).digest('hex');
  assert.strictEqual(Buffer.from(standIns.sha256(new TextEncoder().encode(text))).toString('hex'), want, 'sha256 of ' + text.length + ' chars');
  assert.strictEqual(standIns.createHash('sha256').update(text.slice(0, 7)).update(text.slice(7)).digest('hex'), want, 'createHash in two parts');
}
assert.deepStrictEqual([...standIns.createHash('sha256').update('abc').digest()], [...crypto.createHash('sha256').update('abc').digest()]);
assert.throws(() => standIns.createHash('sha1'), /not on the phone/);
console.log('ios engine check ok');

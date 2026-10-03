'use strict';
// Sealing for the agent relay (docs/AGENT-RELAY.md), shared by the relay (relay/server.js) and Orbital
// (main/agents/linked.js). A message is sealed to an X25519 public key the way ECIES and HPKE's base mode do it, from
// Node's own crypto and nothing else: a fresh X25519 key per message, HKDF-SHA256 over the shared secret, AES-256-GCM.
// The context (what the message is, whose, which one) is bound in as additional data, so a sealed message moved to
// another agent, another Orbital or another id does not open. Keys travel as 32 raw bytes in base64url, which is
// what CryptoKit's Curve25519 and every other X25519 library read and write.
const crypto = require('node:crypto');

const SPKI = Buffer.from('302a300506032b656e032100', 'hex'); // the DER that wraps a raw X25519 public key
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex'); // and a raw X25519 private key
const VERSION = 'orbital-relay/v1';
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const raw = (text, size) => {
  const bytes = Buffer.from(String(text || ''), 'base64url');
  if (bytes.length !== size) throw new Error('Not a key');
  return bytes;
};
const publicKeyOf = (text) => crypto.createPublicKey({ key: Buffer.concat([SPKI, raw(text, 32)]), format: 'der', type: 'spki' });
const privateKeyOf = (text) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, raw(text, 32)]), format: 'der', type: 'pkcs8' });
const rawPublic = (key) => b64(crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(SPKI.length));
const rawPrivate = (key) => b64(key.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8.length));

// A new key pair: { secretKey, publicKey }, both base64url.
function keyPair() {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  return { secretKey: rawPrivate(privateKey), publicKey: rawPublic(privateKey) };
}
// The key pair a secret stands for: an Orbital's own, so every device that holds the secret holds the same key and the
// relay, which never sees the secret, cannot make it. Any 32 bytes are an X25519 private key.
function keyFromSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Not a secret');
  const seed = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), VERSION + ' orbital key', 32));
  return { secretKey: b64(seed), publicKey: rawPublic(privateKeyOf(b64(seed))) };
}
const keyFor = (shared, epk, recipient, context) => {
  // an all-zero secret means a low-order public key: nothing secret came of it
  if (!shared.some((byte) => byte !== 0)) throw new Error('Not a key');
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([raw(epk, 32), raw(recipient, 32)]), VERSION + ' ' + context, 32));
};
// The words of a message, sealed to one public key: { v, epk, iv, ct }, every part base64url.
function seal(text, recipient, context) {
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = rawPublic(eph.privateKey);
  const key = keyFor(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyOf(recipient) }), epk, recipient, context);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(VERSION + ' ' + context, 'utf8'));
  const ct = Buffer.concat([cipher.update(Buffer.from(String(text), 'utf8')), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, epk, iv: b64(iv), ct: b64(ct) };
}
// The words back, with the recipient's private key and the same context; throws on anything that is not exactly what
// was sealed for them.
function open(box, secretKey, context) {
  if (!box || box.v !== 1) throw new Error('Not a sealed message');
  const own = privateKeyOf(secretKey);
  const key = keyFor(crypto.diffieHellman({ privateKey: own, publicKey: publicKeyOf(box.epk) }), box.epk, rawPublic(own), context);
  const iv = raw(box.iv, 12), body = Buffer.from(String(box.ct || ''), 'base64url');
  if (body.length < 16) throw new Error('Not a sealed message');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(VERSION + ' ' + context, 'utf8'));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8');
}
// What a message is bound to: a task Orbital sends an agent, or an update an agent sends back
const context = (kind, orbital, agent, id) => [kind, orbital, agent, id].join('|');

module.exports = { keyPair, keyFromSecret, seal, open, context, b64 };


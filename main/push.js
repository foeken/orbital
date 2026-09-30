'use strict';
// Push to the iPhone app (issue #663): every banner this Mac shows (main.js S.notify) also goes to each phone that wrote
// its APNs device token into the settings document, as push:<token> → { environment, name, at } (ios/engine/index.js
// registerPush). Sent over HTTP/2 to Apple, signed with an ES256 JWT from node:crypto, as Cookie Monster's sender does
// (~/Code/cookie-monster/cli/src/apns.ts). The key is the team's APNs auth key, good for every app of the team, named in
// ~/.config/orbital/apns.json { teamId, keyId, keyPath }; Cookie Monster's apns.json is read when that one is missing.
// A phone Apple no longer knows (410, BadDeviceToken) is taken out of the document.
// ponytail: every Mac running Orbital sends its own pushes; one Mac per person is the case today.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http2 = require('node:http2');
const { createSign } = require('node:crypto');
const settings = require('./settings');

const TOPIC = 'com.dreetje.orbital';
const b64url = (x) => Buffer.from(x).toString('base64url');

function config() {
  for (const app of ['orbital', 'cookie-monster']) {
    const dir = path.join(os.homedir(), '.config', app);
    try { const c = JSON.parse(fs.readFileSync(path.join(dir, 'apns.json'), 'utf8')); return { ...c, keyPath: path.resolve(dir, c.keyPath) }; } catch { /* the next one */ }
  }
  return null;
}
// Apple takes a token up to an hour old and refuses one renewed more than every 20 minutes: kept for 40
let jwt = null;
function bearer(c) {
  const now = Math.floor(Date.now() / 1000);
  if (jwt && jwt.kid === c.keyId && now - jwt.iat < 2400) return jwt.token;
  const input = b64url(JSON.stringify({ alg: 'ES256', kid: c.keyId })) + '.' + b64url(JSON.stringify({ iss: c.teamId, iat: now }));
  const sign = createSign('sha256').update(input);
  jwt = { kid: c.keyId, iat: now, token: input + '.' + b64url(sign.sign({ key: fs.readFileSync(c.keyPath), dsaEncoding: 'ieee-p1363' })) };
  return jwt.token;
}
// One push: Apple's status and its reason
function post(environment, token, headers, payload) {
  const client = http2.connect('https://' + (environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'));
  return new Promise((resolve, reject) => {
    client.once('error', reject);
    const req = client.request({ ':method': 'POST', ':path': '/3/device/' + token, 'content-type': 'application/json', ...headers });
    let status = 0, body = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = Number(h[':status']); });
    req.on('data', (d) => { body += d; });
    req.on('end', () => { let reason; try { reason = JSON.parse(body).reason; } catch { /* no body on success */ } resolve({ status, reason }); });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  }).finally(() => client.close());
}

// The phones, from the settings document
const devices = () => Object.entries(settings.synced()).filter(([key, v]) => key.startsWith('push:') && v && /^[0-9a-f]{64,}$/i.test(key.slice(5)));

// A banner, as main.js shows it: the node it is about (a tap opens it on the phone), its words, and whether it replaces
// an edit banner in place (collapse, the same macOS id) and so arrives silently.
async function send({ docId, title, subtitle, body, collapse, silent }) {
  const phones = devices(), c = phones.length && config();
  if (!c) return 0;
  const headers = { authorization: 'bearer ' + bearer(c), 'apns-topic': TOPIC, 'apns-push-type': 'alert', 'apns-priority': silent ? '5' : '10', ...(collapse ? { 'apns-collapse-id': collapse.slice(0, 64) } : {}) };
  const payload = { aps: { alert: { title, ...(subtitle ? { subtitle } : {}), ...(body ? { body } : {}) }, ...(silent ? {} : { sound: 'default' }), 'thread-id': docId }, id: docId };
  let sent = 0;
  for (const [key, device] of phones) {
    const { status, reason } = await post(device.environment, key.slice(5), headers, payload);
    if (status === 200) sent++;
    else if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') settings.set(key, undefined);
    else throw new Error('APNs refused a push: HTTP ' + status + (reason ? ' (' + reason + ')' : ''));
  }
  return sent;
}

module.exports = { send, devices };

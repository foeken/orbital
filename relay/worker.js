'use strict';
// The relay on ChatGPT Sites (a Cloudflare Worker): the same server.js, its rows in the Site's D1 database, its requests
// handed to the Node-style handler it already has. relay/build.js bundles this into dist/server/index.js; README.md says
// how to deploy it. Sites keeps /mcp for itself, so the relay answers at /api/mcp (RELAY_PATH to change it).
const { createRelay, d1Store, isPublicAddress, LIMITS } = require('./server');

// A callback POST over fetch: what safePost does with Node's https and a checked DNS lookup, here with what a Worker has.
// A Worker reaches no private network, so the address check is left to the platform but for addresses written out.
async function post(url, headers, body, { timeout = 10e3, maxBytes = LIMITS.callBytes } = {}) {
  const u = new URL(url), host = u.hostname.replace(/^\[|\]$/g, '');
  const blocked = (code) => Object.assign(new Error(code), { code });
  if (u.protocol !== 'https:') throw blocked('EBLOCKED');
  if (/^[\d.]+$|:/.test(host) && !isPublicAddress(host)) throw blocked('EBLOCKED');
  let res;
  try { res = await fetch(u, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeout) }); } catch (e) { throw blocked(e.name === 'TimeoutError' ? 'ETIMEDOUT' : 'ECONNRESET'); }
  const reader = res.body ? res.body.getReader() : null, parts = [];
  for (let size = 0; reader;) {
    const { done, value } = await reader.read();
    if (done) break;
    if ((size += value.length) > maxBytes) { reader.cancel().catch(() => {}); throw blocked('ETOOBIG'); }
    parts.push(value);
  }
  return { status: res.status, text: Buffer.concat(parts).toString('utf8') };
}

// A Request as the handler reads one (method, url, headers, the caller's address, the body as one chunk), and a Response
// from what it writes.
function serve(handle, request) {
  const url = new URL(request.url), headers = {}, listeners = {};
  for (const [k, v] of request.headers) headers[k] = v;
  const req = { method: request.method, url: url.pathname + url.search, headers, socket: { remoteAddress: headers['cf-connecting-ip'] || '' },
    on(event, fn) { (listeners[event] ||= []).push(fn); return req; }, destroy() {} };
  const emit = (event, value) => (listeners[event] || []).forEach((fn) => fn(value));
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) queueMicrotask(() => emit('end'));
  else request.arrayBuffer().then((b) => { if (b.byteLength) emit('data', Buffer.from(b)); emit('end'); }, (e) => emit('error', e));
  return new Promise((resolve) => {
    const out = new Headers();
    const res = { statusCode: 200, headersSent: false,
      setHeader(k, v) { out.set(k, String(v)); },
      writeHead(status, extra = {}) { res.statusCode = status; res.headersSent = true; for (const [k, v] of Object.entries(extra)) out.set(k, String(v)); return res; },
      end(text) { resolve(new Response([204, 304].includes(res.statusCode) ? null : text || null, { status: res.statusCode, headers: out })); } };
    handle(req, res);
  });
}

let relay = null; // one per isolate: its rows are in D1, so another isolate's relay is the same relay
module.exports = {
  fetch(request, env) {
    relay ||= createRelay({ store: d1Store(env.DB), publicUrl: env.RELAY_PUBLIC_URL || new URL(request.url).origin, path: env.RELAY_PATH || '/api/mcp', post,
      // the plugin's views and each person's Tana sign-in (issue #817), only where the Site is set to: RELAY_TANA=on
      tana: env.RELAY_TANA === 'on' ? { issuer: 'https://home.tana.inc', mcp: 'https://home.tana.inc/mcp' } : null });
    return serve(relay.handle, request);
  },
  post, // for scripts/relay-check.js; a Worker calls only fetch
};

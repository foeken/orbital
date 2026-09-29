'use strict';
// Connect transport for home.tana.inc/platform: bearer auth, request ids, one retry after a 401 (protocol doc §4),
// and `unary`, the one way a service client makes a unary read.
const { randomUUID } = require('node:crypto');
const { createConnectTransport } = require('@connectrpc/connect-web');
const { fromJson, toJson } = require('@bufbuild/protobuf');

// clientName and userAgent say who is calling, so Tana can tell this app's traffic from any other Node.js client's
function createTransport({ baseUrl = 'https://home.tana.inc/platform', getAccessToken, clientName = 'orbital', userAgent, fetch = globalThis.fetch } = {}) {
  if (typeof getAccessToken !== 'function') throw new Error('createTransport: getAccessToken is required');
  const authFetch = async (url, init) => {
    const send = async (refresh) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', 'Bearer ' + await getAccessToken({ refresh }));
      headers.set('x-client-name', clientName);
      if (userAgent) headers.set('user-agent', userAgent);
      if (!headers.has('x-request-id')) headers.set('x-request-id', randomUUID());
      return fetch(url, { ...init, headers });
    };
    // Bodies are byte arrays (connect-web serialises the whole request up front), so a resend is safe.
    // A 401 on the ServerSync stream arrives before any frame, so this covers the streaming rule too.
    const res = await send(false);
    return res.status === 401 ? send(true) : res;
  };
  return createConnectTransport({ baseUrl, useBinaryFormat: true, fetch: authFetch });
}

// Every unary call made, by method ('ListEdges' → count), until takeCalls() hands them over and starts again: what
// main logs once a minute, so the load this app puts on Tana can be read back (main/views.js logCalls).
const calls = new Map();
const takeCalls = () => { const out = Object.fromEntries(calls); calls.clear(); return out; };
// One unary read on Tana's services: protobuf JSON in, protobuf JSON out (sdk/graph.js, history.js, search.js).
const unary = async (client, service, name, params) => {
  const m = service.methods.find((x) => x.localName === name);
  calls.set(m.name, (calls.get(m.name) || 0) + 1);
  const call = () => client[name](fromJson(m.input, params || {}));
  let response;
  try { response = await call(); }
  catch (e) {
    if (e.rawMessage !== 'fetch failed') throw e;
    // ponytail: one 250 ms retry handles short resets; add backoff only if unary reads show longer outages.
    await new Promise((resolve) => setTimeout(resolve, 250));
    response = await call();
  }
  return toJson(m.output, response);
};

module.exports = { createTransport, unary, takeCalls };

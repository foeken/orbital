'use strict';
// Connect transport for home.tana.inc/platform: bearer auth, request ids, one retry after a 401 (protocol doc §4).
const { randomUUID } = require('node:crypto');
const { createConnectTransport } = require('@connectrpc/connect-web');

function createTransport({ baseUrl = 'https://home.tana.inc/platform', getAccessToken, clientName = 'tana-tasks', fetch = globalThis.fetch } = {}) {
  if (typeof getAccessToken !== 'function') throw new Error('createTransport: getAccessToken is required');
  const authFetch = async (url, init) => {
    const send = async (refresh) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', 'Bearer ' + await getAccessToken({ refresh }));
      headers.set('x-client-name', clientName);
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

module.exports = { createTransport };

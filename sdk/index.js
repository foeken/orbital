'use strict';
// The client and its parts. Every helper that works on a Document, a graph node or the sync connection is required
// from its own module (sdk/node, sdk/content, sdk/livequery, …), which is what every caller does.
const { createTransport, takeCalls } = require('./transport');
const { GraphClient } = require('./graph');
const { HistoryClient } = require('./history');
const { SearchClient } = require('./search');
const { SyncConnection, derivePeerId } = require('./sync');
const { Document } = require('./document');

function createTanaClient({ baseUrl, getAccessToken, orgId, peerId, storageId, logger = console, clientName, userAgent } = {}) {
  if (!orgId || !peerId) throw new Error('createTanaClient: orgId and peerId are required');
  const transport = createTransport({ baseUrl, getAccessToken, clientName, userAgent });
  const graph = new GraphClient(transport);
  const history = new HistoryClient(transport); // change summaries (sdk/history.js); read-only
  const search = new SearchClient(transport); // semantic search (sdk/search.js); read-only
  const sync = new SyncConnection({ transport, orgId, peerId, storageId, logger });
  // a write of ours can add or take away an edge (a pin, a mention): the edges kept for a few seconds are read again
  sync.on('change', (_id, info) => { if (info && info.origin === 'local') graph.forget(); });
  return { transport, graph, history, search, sync, close: () => sync.close() };
}

module.exports = { createTanaClient, createTransport, takeCalls, GraphClient, HistoryClient, SearchClient, SyncConnection, Document, derivePeerId };

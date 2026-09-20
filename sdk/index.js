'use strict';
const { createTransport } = require('./transport');
const { GraphClient } = require('./graph');
const { HistoryClient } = require('./history');
const { SyncConnection, derivePeerId } = require('./sync');
const { Document } = require('./document');
const node = require('./node');

function createTanaClient({ baseUrl, getAccessToken, orgId, peerId, storageId, logger = console, clientName } = {}) {
  if (!orgId || !peerId) throw new Error('createTanaClient: orgId and peerId are required');
  const transport = createTransport({ baseUrl, getAccessToken, clientName });
  const graph = new GraphClient(transport);
  const history = new HistoryClient(transport); // change summaries (sdk/history.js); read-only
  const sync = new SyncConnection({ transport, orgId, peerId, storageId, logger });
  return { transport, graph, history, sync, close: () => sync.close() };
}

module.exports = { createTanaClient, createTransport, GraphClient, HistoryClient, SyncConnection, Document, derivePeerId, ...node, access: require('./access'), calls: require('./calls') };

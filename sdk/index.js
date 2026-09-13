'use strict';
const { createTransport } = require('./transport');
const { GraphClient } = require('./graph');
const { SyncConnection, derivePeerId } = require('./sync');
const { Document } = require('./document');
const node = require('./node');

function createTanaClient({ baseUrl, getAccessToken, orgId, peerId, storageId, logger = console, clientName } = {}) {
  if (!orgId || !peerId) throw new Error('createTanaClient: orgId and peerId are required');
  const transport = createTransport({ baseUrl, getAccessToken, clientName });
  const graph = new GraphClient(transport);
  const sync = new SyncConnection({ transport, orgId, peerId, storageId, logger });
  return { transport, graph, sync, close: () => sync.close() };
}

module.exports = { createTanaClient, createTransport, GraphClient, SyncConnection, Document, derivePeerId, ...node, access: require('./access') };

'use strict';
// tana.history.v1alpha1.ChangeSummaryService: the change summaries Tana's own "Changes" panel shows for a node.
// ListChanges({ uri, withinId?, limit? }) answers { parent?, summaries[] }, each summary a window of edits with a
// written title ("Added dependency on …"), its authors, its start and end, and a type (created/updated/deleted).
// `withinId` asks for the summaries *inside* an expandable one; nothing here writes.
const { createClient } = require('@connectrpc/connect');
const { ChangeSummaryService } = require('./proto/descriptors');
const { unary } = require('./transport');

class HistoryClient {
  constructor(transport) {
    this.client = createClient(ChangeSummaryService, transport);
  }
  // protobuf JSON omits empty repeated fields: always return a summaries array
  async listChanges(params) {
    const r = await unary(this.client, ChangeSummaryService, 'listChanges', params);
    r.summaries ||= [];
    return r;
  }
}

module.exports = { HistoryClient };

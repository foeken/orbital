'use strict';
// tana.search.v1alpha1.SearchService, the one call Tana's own UI makes on it: semanticSearch. Its search page runs it
// beside the ListNodes text search and lists the documents only it found as related results, using nothing but their
// ids (search and hybridSearch serve Tana's AI agent alone; issue #20). FailedPrecondition means not enabled.
const { createClient } = require('@connectrpc/connect');
const { SearchService } = require('./proto/descriptors');
const { unary } = require('./graph');

class SearchClient {
  constructor(transport) {
    this.client = createClient(SearchService, transport);
  }
  // { query, limit?, spaceUris?, entityTypeUris? } -> [{ documentId, title, snippet, score, vectorDistance }], best first
  async semanticSearch(params) {
    return (await unary(this.client, SearchService, 'semanticSearch', params)).results || [];
  }
}

module.exports = { SearchClient };

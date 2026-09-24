'use strict';
// Thin generic wrapper over tana.graph.v1alpha1.GraphService. Params and results are protobuf JSON
// (lowerCamelCase fields, enums by name, timestamps as RFC 3339 strings).
const { createClient } = require('@connectrpc/connect');
const { fromJson, toJson } = require('@bufbuild/protobuf');
const { GraphService } = require('./proto/descriptors');

const method = (name) => GraphService.methods.find((m) => m.localName === name);

// One unary read on Tana's services: protobuf JSON in, protobuf JSON out (sdk/history.js and search.js too).
const unary = async (client, service, name, params) => {
  const m = service.methods.find((x) => x.localName === name);
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

class GraphClient {
  constructor(transport) {
    this.client = createClient(GraphService, transport);
  }
  // protobuf JSON omits empty repeated fields: always return a nodes array
  async listNodes(params) { const r = await this._unary('listNodes', params); r.nodes ||= []; return r; }
  listEdges(params) { return this._unary('listEdges', params); }
  getEdge(params) { return this._unary('getEdge', params); }
  getOwnerChain(nodeId) { return this._unary('getOwnerChain', { nodeId }); }
  // People this user meets, for an attendee picker; the shape Tana's own client maps the response to (int64 as numbers).
  async listAttendeeSuggestions({ limit } = {}) {
    const { suggestions = [] } = await this._unary('listAttendeeSuggestions', limit == null ? {} : { limit });
    return suggestions.map((s) => ({ email: s.email || '', displayName: s.displayName || undefined, lastSeenAt: Number(s.lastSeenAt || 0),
      eventCount: s.eventCount || 0, nextMeetingAt: Number(s.nextMeetingAt || 0), identityUri: /^tana:[a-z-]+:[0-9a-z]{26}$/.test(s.identityUri || '') ? s.identityUri : undefined }));
  }
  async *traverse(params) {
    const m = method('traverse');
    for await (const res of this.client.traverse(fromJson(m.input, params))) yield toJson(m.output, res);
  }
  _unary(name, params) {
    return unary(this.client, GraphService, name, params);
  }
}

module.exports = { GraphClient, unary };

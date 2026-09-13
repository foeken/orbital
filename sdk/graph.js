'use strict';
// Thin generic wrapper over tana.graph.v1alpha1.GraphService. Params and results are protobuf JSON
// (lowerCamelCase fields, enums by name, timestamps as RFC 3339 strings).
const { createClient } = require('@connectrpc/connect');
const { fromJson, toJson } = require('@bufbuild/protobuf');
const { GraphService } = require('./proto/descriptors');

const method = (name) => GraphService.methods.find((m) => m.localName === name);

class GraphClient {
  constructor(transport) {
    this.client = createClient(GraphService, transport);
  }
  // protobuf JSON omits empty repeated fields: always return a nodes array
  async listNodes(params) { const r = await this._unary('listNodes', params); r.nodes ||= []; return r; }
  listEdges(params) { return this._unary('listEdges', params); }
  getEdge(params) { return this._unary('getEdge', params); }
  getOwnerChain(nodeId) { return this._unary('getOwnerChain', { nodeId }); }
  async *traverse(params) {
    const m = method('traverse');
    for await (const res of this.client.traverse(fromJson(m.input, params))) yield toJson(m.output, res);
  }
  async _unary(name, params) {
    const m = method(name);
    return toJson(m.output, await this.client[name](fromJson(m.input, params || {})));
  }
}

module.exports = { GraphClient };

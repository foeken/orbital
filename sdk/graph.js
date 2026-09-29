'use strict';
// Thin generic wrapper over tana.graph.v1alpha1.GraphService. Params and results are protobuf JSON
// (lowerCamelCase fields, enums by name, timestamps as RFC 3339 strings).
const { createClient } = require('@connectrpc/connect');
const { fromJson, toJson } = require('@bufbuild/protobuf');
const { GraphService } = require('./proto/descriptors');
const { unary } = require('./transport');

// What this app may ask of GraphService, agreed with Tana after one week of ListEdges bursts of ~117/s (#579): a token
// bucket per limit, calls per second and the burst allowed above it. A call past a limit waits its turn; none fails.
// all: a safety net sized for a start, which asks ~550 GraphService calls in its first seconds (tana-calls.log, 2026-09-29:
// ListNodes 472, GetOwnerChain 74, ListEdges 7); at 20/s that start took half a minute
const LIMITS = { all: [50, 500], listEdges: [5, 10] };
const EDGES_TTL = 10000; // ms an identical ListEdges answer is reused; our own writes and edge live queries clear it (forget)
// A token bucket that lends ahead: each call takes a token, and a call that finds none waits until its token is due.
function bucket(rate, burst, now = Date.now) {
  let tokens = burst, at = now();
  return () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - at) * rate) / 1000) - 1; at = t;
    return tokens < 0 ? (-tokens * 1000) / rate : 0;
  };
}
// Tana saying slow down: RESOURCE_EXHAUSTED, or an HTTP 429 (which Connect reads as unavailable)
const busy = (e) => !!e && (e.code === 8 || /\b429\b/.test(String(e.rawMessage || e.message || '')));
const retryAfter = (e) => { const s = Number(e && e.metadata && e.metadata.get && e.metadata.get('retry-after')); return s > 0 ? Math.min(60000, s * 1000) : null; };

class GraphClient {
  // sleep and now: a check's clock; call: a check's stand-in for the wire
  constructor(transport, { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, call } = {}) {
    this.client = createClient(GraphService, transport);
    this.sleep = sleep; this.now = now;
    this.call = call || ((name, params) => unary(this.client, GraphService, name, params));
    this.limits = Object.fromEntries(Object.entries(LIMITS).map(([k, [rate, burst]]) => [k, bucket(rate, burst, now)]));
    this.pending = new Map(); // key -> the answer on its way: an identical call made meanwhile shares it
    this.edges = new Map(); // key -> { at, answer }: ListEdges answers, reused for EDGES_TTL
  }
  forget() { this.edges.clear(); } // an edge may have moved: our own write, or an edge live query's answer
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
    const m = GraphService.methods.find((x) => x.localName === 'traverse');
    for await (const res of this.client.traverse(fromJson(m.input, params))) yield toJson(m.output, res);
  }
  _unary(name, params) {
    const key = name + '\n' + JSON.stringify(params || {}), kept = this.edges.get(key);
    if (kept && this.now() - kept.at < EDGES_TTL) return kept.answer.then(structuredClone);
    let answer = this.pending.get(key);
    if (!answer) {
      answer = this._send(name, params).finally(() => this.pending.delete(key));
      this.pending.set(key, answer);
      if (name === 'listEdges') {
        const entry = { at: this.now(), answer };
        this.edges.set(key, entry);
        answer.catch(() => { if (this.edges.get(key) === entry) this.edges.delete(key); }); // a failure is asked again
      }
    }
    return answer.then(structuredClone); // every caller its own copy: a shared answer is never changed under another
  }
  // one call, in its turn under the limits, and again after 1, 2, 4, 8 and 16 s (or when Tana says) while Tana is busy
  async _send(name, params) {
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(this.limits.all(), this.limits[name] ? this.limits[name]() : 0);
      if (wait) await this.sleep(wait);
      try { return await this.call(name, params); }
      catch (e) {
        if (!busy(e) || attempt >= 5) throw e;
        await this.sleep(retryAfter(e) ?? Math.min(30000, 1000 * 2 ** attempt));
      }
    }
  }
}

module.exports = { GraphClient, bucket, LIMITS };

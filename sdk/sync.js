'use strict';
// ServerSync stream + document sessions (protocol doc §1, §2). One stream per connection, one session per document.
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createClient, ConnectError, Code } = require('@connectrpc/connect');
const { create } = require('@bufbuild/protobuf');
const { VersionVector } = require('loro-crdt');
const { SyncService, message } = require('./proto/descriptors');
const { Document } = require('./document');

const RequestSchema = message('sync', 'ServerSyncRequest');
const CommandSchema = message('sync', 'ServerSyncCommandRequest');
// tana.sync.v1alpha1.BootstrapStatus / RecoveryStrategy
const STATUS = { EXISTING: 1, MISSING: 2, UNAVAILABLE: 3 };
const DISCARD_LOCAL = 2;
const EMPTY = new Uint8Array();
const HANDSHAKE_MS = 15000, BOOTSTRAP_MS = 30000, STABLE_MS = 15000, BATCH_MS = 5, OUTBOUND_BUDGET = 262144;
// A bootstrap answering unavailable is retried while under 60 s or under 5 attempts, as Tana's (#J); then it stops.
const UNAVAILABLE_MS = 60000, UNAVAILABLE_ATTEMPTS = 5;

const code = (e) => ConnectError.from(e).code;
const jitter = (initial, max, factor, attempt) => { const n = Math.min(initial * factor ** attempt, max); return n / 2 + (n / 2) * Math.random(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());
const timeout = (promise, ms, msg) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(msg)), ms);
  promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
function deferred() {
  const d = { settled: false };
  d.promise = new Promise((res, rej) => {
    d.resolve = (v) => { d.settled = true; res(v); };
    d.reject = (e) => { d.settled = true; rej(e); };
  });
  d.promise.catch(() => {});
  return d;
}

// peerId = (first 48 bits of sha256(userExternalId) << 16) | a random nonce, as a decimal string (§1.1).
// The nonce is 15 bits (0..32767): the server only reads the top 48 bits as peerUserHash, the rest is per-process entropy.
function derivePeerId(userExternalId) {
  const userHash = createHash('sha256').update(userExternalId.trim().toLowerCase()).digest().readBigUInt64BE(0) >> 16n;
  return ((userHash << 16n) | BigInt(Math.floor(Math.random() * 32768))).toString(10);
}

// "fetch failed" says nothing on its own: the reason (ECONNRESET, a timeout, DNS) is the innermost cause.
const causeOf = (e) => { let c = e && e.cause; while (c && c.cause) c = c.cause; const why = c && (c.code || c.message); return why ? ' (' + why + ')' : ''; };
// Presence commands are many and small (a room per listed row, a caret move every 150 ms): at most this many in
// flight, so a list opening 40 rooms does not open 40 requests beside the bootstraps.
const LIGHT_IN_FLIGHT = 4;

class SyncConnection extends EventEmitter {
  constructor({ transport, orgId, peerId, storageId, logger = console }) {
    super();
    this.orgId = orgId;
    this.peerId = peerId;
    this.storageId = storageId || '';
    this.logger = logger;
    this.client = createClient(SyncService, transport);
    this.docs = new Map();
    this.channels = new Map(); // ephemeral channel id -> how many holders (subscribeEphemeralChannel)
    this._light = []; this._lightBusy = 0; // queued presence commands (_lightCommand)
    this.connected = false;
    this.closed = true;
    this.abort = null;
  }

  // Resolves after the first 'peer' frame; keeps reconnecting in the background until close().
  connect() {
    if (!this.closed) return this._first.promise;
    this.closed = false;
    this._first = deferred();
    this._loop = this._run().finally(() => this._first.reject(new Error('sync connection closed')));
    return this._first.promise;
  }

  // ---- ephemeral channels (presence, docs/PLATFORM-PROTOCOL.md 2.8) ----
  // A channel is named by a document uri. Counted per channel as Tana's client does, so two presence handles on one
  // document share one subscription; resent after every reconnect (_run), since a subscription belongs to the stream.
  async subscribeEphemeralChannel(channelId) {
    const n = (this.channels.get(channelId) || 0) + 1;
    this.channels.set(channelId, n);
    if (n === 1 && this.connected) await this._lightCommand({ case: 'subscribeEphemeralChannel', value: { channelId } });
  }
  async unsubscribeEphemeralChannel(channelId) {
    const n = (this.channels.get(channelId) || 0) - 1;
    if (n > 0) return void this.channels.set(channelId, n);
    this.channels.delete(channelId);
    if (this.connected) await this._lightCommand({ case: 'unsubscribeEphemeralChannel', value: { channelId } }).catch(() => {});
  }
  // Best effort, like Tana's: presence that fails to send is simply not seen, never an error. Resolves to whether it went.
  sendEphemeral(documentId, data) {
    if (!this.connected) return Promise.resolve(false);
    return this._lightCommand({ case: 'ephemeral', value: { documentId, data } }).then(() => true, () => false);
  }
  // "I have this document open": Tana's client sends it every 10 s while the tab is visible and the user active.
  viewingHeartbeat(documentId) {
    if (!this.connected) return Promise.resolve(false);
    return this._lightCommand({ case: 'viewingHeartbeat', value: { documentId } }).then(() => true, () => false);
  }

  getDocument(id) { const e = this.docs.get(id); return e && e.document; }

  // `init(loro)` seeds a new document before bootstrap: the warm start turns MISSING into a create, the full
  // snapshot is the catch-up (§2.1). Without it, an unknown id fails with 'document not found'.
  subscribe(id, init) {
    let entry = this.docs.get(id);
    if (!entry) {
      const document = new Document(id, { peerId: this.peerId });
      entry = { id, document, sessionId: null, state: 'new', gen: 0, queue: [], inflight: false, timer: null, resyncs: 0, liveSince: 0, ready: deferred(), complete: null };
      entry.onChange = (info) => this._safe(() => this.emit('change', id, info));
      entry.onLocal = (bytes) => this._safe(() => this._queue(entry, bytes));
      document.on('change', entry.onChange);
      document.on('local-update', entry.onLocal);
      this.docs.set(id, entry);
      if (init) document.transact(init);
      if (this.connected) this._bootstrap(entry);
    } else if (entry.state === 'paused' && this.connected) this._bootstrap(entry); // asking again resumes, like Tana's retryRequest
    return entry.ready.promise;
  }

  // document_action soft_delete (§2.5); needs the stream open. The document's session, if any, is left to the server.
  softDelete(id) {
    return this._command({ case: 'documentAction', value: { documentId: id, action: { case: 'softDelete', value: {} } } });
  }

  restore(id) {
    return this._command({ case: 'documentAction', value: { documentId: id, action: { case: 'restore', value: {} } } });
  }

  // document_action archive / unarchive (DocumentAction fields 4 and 5): what Tana's client sends for a document it
  // does not have loaded; a loaded one gets node.setArchived instead (docs/PLATFORM-PROTOCOL.md §2.5).
  archive(id) {
    return this._command({ case: 'documentAction', value: { documentId: id, action: { case: 'archive', value: {} } } });
  }

  unarchive(id) {
    return this._command({ case: 'documentAction', value: { documentId: id, action: { case: 'unarchive', value: {} } } });
  }

  async unsubscribe(id) {
    const entry = this.docs.get(id);
    if (!entry) return;
    // Tana's release flushes the batch and waits for sends already on the wire before it unsubscribes: an unsubscribe
    // racing a live update could otherwise reach the server first and the edit would be dropped.
    clearTimeout(entry.timer);
    entry.timer = null;
    // Tana's drain mode: released while bootstrapping with local edits queued, the document finishes that one bootstrap
    // (whose catch-up carries the edits) and goes live before it is let go. A document created and released at once
    // lost its content without this. The drain ends with the bootstrap, however it ends: a failure is not retried.
    if (entry.state === 'bootstrapping' && entry.queue.length) { entry.drain = deferred(); await entry.drain.promise; }
    while (entry.state === 'live' && (entry.inflight || entry.queue.length)) await (entry.inflight || this._flush(entry));
    if (this.docs.get(id) !== entry) return;
    const { sessionId } = entry;
    this._detach(entry, new Error('unsubscribed ' + id), false);
    if (sessionId && this.connected) {
      await this._command({ case: 'unsubscribeDocument', value: { documentId: id, sessionId } }).catch(() => {});
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.docs.keys()].map((id) => this.unsubscribe(id)));
    if (this.abort) this.abort.abort();
    if (this._wake) this._wake();
    await this._loop;
  }

  // ---- stream lifecycle ----

  async _run() {
    let attempt = 0, everConnected = false;
    while (!this.closed) {
      const ac = new AbortController();
      this.abort = ac;
      let watchdog = null, connectedAt = 0;
      try {
        const req = create(RequestSchema, { orgId: this.orgId, peer: { peerId: this.peerId, ephemeral: !this.storageId, storageId: this.storageId } });
        const it = this.client.serverSync(req, { signal: ac.signal })[Symbol.asyncIterator]();
        const first = await timeout(it.next(), HANDSHAKE_MS, 'sync connect handshake timed out');
        if (first.done || first.value.responseUnion.case !== 'peer') throw new Error('Expected peer info as first ServerSync frame');
        const hb = first.value.responseUnion.value.heartbeatIntervalMs;
        const arm = () => {
          clearTimeout(watchdog);
          if (hb > 0) watchdog = setTimeout(() => { this.logger.warn('sync: stream watchdog elapsed, forcing reconnect'); ac.abort(); }, hb * 3);
        };
        arm();
        connectedAt = Date.now();
        everConnected = true;
        this.connected = true;
        this._first.resolve();
        this._safe(() => this.emit('connected', { heartbeatIntervalMs: hb }));
        for (const entry of this.docs.values()) if (!entry.document.writeDenied) this._bootstrap(entry);
        for (const channelId of this.channels.keys()) this._lightCommand({ case: 'subscribeEphemeralChannel', value: { channelId } }).catch(() => {});
        for (;;) {
          const { done, value } = await it.next();
          if (done) throw new Error('sync stream closed by server');
          arm();
          this._safe(() => this._onFrame(value));
        }
      } catch (e) {
        if (this.closed) break;
        const c = code(e);
        this.logger.warn('sync: stream error: ' + (e.message || e));
        if (c === Code.PermissionDenied || (c === Code.Unauthenticated && !connectedAt)) {
          this.closed = true;
          for (const entry of this.docs.values()) this._detach(entry, e);
          this._first.reject(e);
          this._error(e);
          break;
        }
      } finally {
        clearTimeout(watchdog);
        ac.abort();
        if (this.connected) {
          this.connected = false;
          for (const entry of this.docs.values()) this._dropSession(entry);
          this._safe(() => this.emit('disconnected'));
        }
      }
      attempt = connectedAt && Date.now() - connectedAt > STABLE_MS ? 0 : attempt + 1;
      const delay = everConnected ? jitter(1000, 30000, 2, attempt - 1) : jitter(250, 5000, 2, attempt - 1);
      await new Promise((r) => { const t = setTimeout(r, delay); this._wake = () => { clearTimeout(t); r(); }; });
    }
    this.abort = null;
  }

  _onFrame(frame) {
    const { case: kind, value } = frame.responseUnion;
    if (kind === 'heartbeat') return void this.emit('heartbeat');
    if (!value) return;
    if (kind === 'ephemeral') return void this.emit('ephemeral', value.documentId, value.data);
    const entry = this.docs.get(value.documentId);
    if (!entry || entry.sessionId !== value.sessionId) return; // stale session (§1.3)
    if (kind === 'bootstrapComplete') {
      if (entry.complete) entry.complete.resolve();
    } else if (kind === 'liveDocumentUpdate') {
      if (entry.state !== 'live') return;
      // Tana re-bootstraps on any failed live import (e.g. 'not included in the shallow history'), not only on pending ops.
      let pending;
      try { pending = entry.document.applyRemote(value.updates); } catch (e) { return this._resync(entry, 'live import failed: ' + (e.message || e)); }
      if (pending) this._resync(entry, 'pending ops after live import');
    } else if (kind === 'resyncRequired') {
      this.logger.warn('sync: resync required for ' + entry.id + ': ' + value.reason);
      if (value.recovery === DISCARD_LOCAL) entry.document.reset();
      this._resync(entry, value.reason);
    }
  }

  // ---- document sessions ----

  _dropSession(entry) {
    entry.gen++;
    entry.sessionId = null;
    entry.state = 'disconnected';
    clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.complete) entry.complete.reject(new Error('session dropped'));
    entry.complete = null;
    if (entry.drain) entry.drain.resolve();
  }

  _detach(entry, err, failure = true) {
    this.docs.delete(entry.id);
    this._dropSession(entry);
    entry.state = 'closed';
    entry.document.off('change', entry.onChange);
    entry.document.off('local-update', entry.onLocal);
    if (!entry.ready.settled) entry.ready.reject(err); else if (failure) this._error(err);
  }

  // Tana's write denied: the server refused this peer's edits (a live send, or the catch-up of the bootstrap that probes
  // read access afterwards) but still lets it read. The document stays open with what it has, sends nothing more and is
  // not re-bootstrapped; `document.writeDenied` and the 'write-denied' event let the app show it read-only. A document
  // that was never live has nothing to read yet, so its subscribe fails as before.
  _denyWrites(entry, err) {
    if (!entry.ready.settled) return this._detach(entry, err);
    const { id, sessionId } = entry;
    this._dropSession(entry);
    entry.state = 'write-denied';
    entry.revoked = false;
    entry.queue.length = 0;
    entry.document.writeDenied = true;
    this.logger.warn('sync: write denied for ' + id + ', keeping it read-only');
    if (sessionId && this.connected) this._command({ case: 'unsubscribeDocument', value: { documentId: id, sessionId } }).catch(() => {});
    this._safe(() => this.emit('write-denied', id));
  }

  _resync(entry, reason) {
    // 15 s of healthy live resets the backoff counter (§2.3). A document nobody edits never flushes, so this
    // is the only place that can see how long the last live period lasted.
    if (entry.liveSince && Date.now() - entry.liveSince > STABLE_MS) entry.resyncs = 0;
    entry.liveSince = 0;
    entry.resyncs++;
    entry.sessionId = null;
    entry.state = 'resyncing';
    this.logger.warn('sync: re-bootstrapping ' + entry.id + ' (' + reason + ')');
    this._bootstrap(entry, true);
  }

  async _bootstrap(entry, delayed = false) {
    const gen = ++entry.gen;
    const stale = () => gen !== entry.gen || this.closed || !this.connected;
    let misses = 0, firstMiss = 0;
    try {
      for (let attempt = delayed ? 1 : 0; ; attempt++) {
        if (attempt > 0 && entry.drain) return; // a draining document gets one bootstrap, no retry
        if (attempt > 0) await sleep(entry.resyncs >= 6 ? 30000 : jitter(500, 5000, 2, attempt - 1));
        if (stale()) return;
        entry.state = 'bootstrapping';
        entry.sessionId = null;
        try {
          const status = await this._bootstrapOnce(entry, gen);
          if (status !== 'missing' && status !== 'unavailable') return;
          // A MISSING document with local state is a warm create path: keep retrying until the server accepts it,
          // rather than concluding that the id will never exist. Only a truly empty document becomes not found.
          if (status === 'missing' && (entry.queue.length || entry.document.loro.oplogVersion().length())) {
            entry.state = 'retrying';
            continue;
          }
          firstMiss = firstMiss || Date.now();
          if (++misses >= UNAVAILABLE_ATTEMPTS && Date.now() - firstMiss >= UNAVAILABLE_MS) {
            // Cold MISSING: the id does not exist. Warm UNAVAILABLE: Tana pauses until the transport reconnects (or, here, a subscribe).
            if (status === 'missing') return this._detach(entry, new Error('document not found: ' + entry.id));
            if (!entry.document.loro.oplogVersion().length() && !entry.queue.length) {
              firstMiss = 0; misses = 0; entry.state = 'retrying';
              continue;
            }
            entry.state = 'paused';
            return this.logger.warn('sync: ' + entry.id + ' still unavailable after ' + misses + ' attempts, paused until the next connection');
          }
          entry.state = 'retrying';
        } catch (e) {
          if (stale()) return;
          const c = code(e), msg = String(e.message || e);
          if (c === Code.PermissionDenied) return this._detach(entry, e);
          if (c === Code.FailedPrecondition && /no active streams|is not assigned to this pod/.test(msg)) return this.abort.abort();
          if (c === Code.FailedPrecondition && /system-doc-discard-local/.test(msg)) entry.document.reset();
          // A single [unavailable] is Tana shedding load, and the retry below takes it: logging it looked like a
          // failure that needed acting on when nothing had gone wrong. It is said from the second attempt on, so a
          // real outage is still visible — and every other code is still said the first time.
          if (attempt > 0 || c !== Code.Unavailable) this.logger.warn('sync: bootstrap ' + entry.id + ' failed (attempt ' + (attempt + 1) + '): ' + msg + causeOf(e));
          entry.state = 'retrying';
        }
      }
    } finally {
      if (entry.drain && gen === entry.gen) entry.drain.resolve();
    }
  }

  async _bootstrapOnce(entry, gen) {
    const { id, document } = entry;
    const loro = document.loro;
    const vv = loro.oplogVersion();
    const cold = vv.length() === 0;
    const res = await this._command({ case: 'beginDocumentSync', value: { documentId: id, clientVv: cold ? EMPTY : vv.encode(), ephemeral: id.startsWith('tana:liveQuery:') } }, BOOTSTRAP_MS);
    if (gen !== entry.gen) return 'stale';
    if (res.responseUnion.case !== 'bootstrapResponse') throw new Error('unexpected ServerSyncCommand response: ' + res.responseUnion.case);
    const { sessionId, status, serverVv, serverUpdates } = res.responseUnion.value;
    if (status === STATUS.MISSING && cold) return 'missing';
    if (status !== STATUS.EXISTING && status !== STATUS.MISSING) return 'unavailable';
    entry.sessionId = sessionId;
    entry.complete = deferred();
    if (serverUpdates.length && document.applyRemote([serverUpdates])) throw new Error('bootstrap import left pending ops');
    let catchup = EMPTY;
    if (!serverVv.length) catchup = document.exportSince();
    else {
      const server = VersionVector.decode(serverVv);
      if (loro.oplogVersion().compare(server) !== 0) catchup = document.exportSince(server);
      else document.exportSince(loro.oplogVersion());
    }
    entry.queue.length = 0; // the catch-up export already contains anything queued (§2.2)
    try {
      await this._command({ case: 'applyBootstrapUpdates', value: { documentId: id, sessionId, baseServerVv: EMPTY, updates: catchup } }, BOOTSTRAP_MS);
    } catch (e) {
      if (gen !== entry.gen || code(e) !== Code.PermissionDenied) throw e;
      this._denyWrites(entry, e); // readable, but the catch-up was refused (§2.2 write-permission-denied)
      return 'denied';
    }
    if (gen !== entry.gen) return 'stale';
    await timeout(entry.complete.promise, BOOTSTRAP_MS, 'Bootstrap timeout exceeded');
    entry.complete = null;
    if (gen !== entry.gen) return 'stale';
    if (entry.revoked) { this._denyWrites(entry, new Error('write denied: ' + id)); return 'denied'; } // the probe could read
    entry.state = 'live';
    entry.liveSince = Date.now();
    entry.ready.resolve(document);
    this._flush(entry);
    return 'live';
  }

  // ---- outbound live updates: 5 ms trailing batch, one in-flight send per document (§2.4) ----

  _queue(entry, bytes) {
    if (entry.document.writeDenied) return; // Tana would refuse it; the edit stays local
    entry.queue.push(bytes);
    if (entry.state === 'live' && !entry.timer) {
      entry.timer = setTimeout(() => { entry.timer = null; this._flush(entry); }, BATCH_MS);
    }
  }

  async _flush(entry) {
    if (entry.inflight || !entry.queue.length || entry.state !== 'live') return;
    const updates = entry.queue.splice(0);
    if (updates.reduce((n, u) => n + u.length, 0) > OUTBOUND_BUDGET) return this._resync(entry, 'outbound buffer overflow');
    const { id, sessionId } = entry;
    const send = this._command({ case: 'liveDocumentUpdate', value: { documentId: id, sessionId, updates } });
    entry.inflight = send.then(() => {}, () => {}); // what unsubscribe waits on
    try {
      await send;
    } catch (e) {
      if (entry.sessionId !== sessionId) return;
      const c = code(e);
      // Tana's access-revoked: re-bootstrap to probe read access, ending read-only (_denyWrites) or evicted if not even that.
      if (c === Code.PermissionDenied) { entry.revoked = true; return this._resync(entry, 'write permission denied'); }
      if (c !== Code.Canceled) this._resync(entry, 'live update failed: ' + (e.message || e));
      return;
    } finally {
      entry.inflight = null;
    }
    if (entry.queue.length) this._flush(entry);
  }

  _lightCommand(commandUnion) {
    return new Promise((ok, no) => { this._light.push({ commandUnion, ok, no }); this._pumpLight(); });
  }
  _pumpLight() {
    while (this._lightBusy < LIGHT_IN_FLIGHT && this._light.length) {
      const job = this._light.shift();
      this._lightBusy++;
      this._command(job.commandUnion).then(job.ok, job.no).finally(() => { this._lightBusy--; this._pumpLight(); });
    }
  }

  _command(commandUnion, timeoutMs = 15000) {
    return this.client.serverSyncCommand(create(CommandSchema, { orgId: this.orgId, peerId: this.peerId, commandUnion }), { timeoutMs });
  }

  _safe(fn) { try { fn(); } catch (e) { this._error(e); } }

  _error(e) {
    this.logger.error('sync: ' + (e && e.stack || e));
    if (this.listenerCount('error')) this.emit('error', e);
  }
}

module.exports = { SyncConnection, derivePeerId };

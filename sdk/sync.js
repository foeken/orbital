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

// peerId = (first 48 bits of sha256(userExternalId) << 16) | random 16-bit nonce, as a decimal string (§1.1).
function derivePeerId(userExternalId) {
  const userHash = createHash('sha256').update(userExternalId.trim().toLowerCase()).digest().readBigUInt64BE(0) >> 16n;
  return ((userHash << 16n) | BigInt(Math.floor(Math.random() * 32768))).toString(10);
}

class SyncConnection extends EventEmitter {
  constructor({ transport, orgId, peerId, storageId, logger = console }) {
    super();
    this.orgId = orgId;
    this.peerId = peerId;
    this.storageId = storageId || '';
    this.logger = logger;
    this.client = createClient(SyncService, transport);
    this.docs = new Map();
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

  getDocument(id) { const e = this.docs.get(id); return e && e.document; }

  subscribe(id) {
    let entry = this.docs.get(id);
    if (!entry) {
      const document = new Document(id, { peerId: this.peerId });
      entry = { id, document, sessionId: null, state: 'new', gen: 0, queue: [], inflight: false, timer: null, resyncs: 0, liveSince: 0, ready: deferred(), complete: null };
      entry.onChange = (info) => this._safe(() => this.emit('change', id, info));
      entry.onLocal = (bytes) => this._safe(() => this._queue(entry, bytes));
      document.on('change', entry.onChange);
      document.on('local-update', entry.onLocal);
      this.docs.set(id, entry);
      if (this.connected) this._bootstrap(entry);
    }
    return entry.ready.promise;
  }

  async unsubscribe(id) {
    const entry = this.docs.get(id);
    if (!entry) return;
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
        for (const entry of this.docs.values()) this._bootstrap(entry);
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
      if (entry.document.applyRemote(value.updates)) this._resync(entry, 'pending ops after live import');
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
  }

  _detach(entry, err, failure = true) {
    this.docs.delete(entry.id);
    this._dropSession(entry);
    entry.state = 'closed';
    entry.document.off('change', entry.onChange);
    entry.document.off('local-update', entry.onLocal);
    if (!entry.ready.settled) entry.ready.reject(err); else if (failure) this._error(err);
  }

  _resync(entry, reason) {
    entry.resyncs++;
    entry.sessionId = null;
    entry.state = 'resyncing';
    this.logger.warn('sync: re-bootstrapping ' + entry.id + ' (' + reason + ')');
    this._bootstrap(entry, true);
  }

  async _bootstrap(entry, delayed = false) {
    const gen = ++entry.gen;
    const stale = () => gen !== entry.gen || this.closed || !this.connected;
    const startedAt = Date.now();
    for (let attempt = delayed ? 1 : 0; ; attempt++) {
      if (attempt > 0) await sleep(entry.resyncs >= 6 ? 30000 : jitter(500, 5000, 2, attempt - 1));
      if (stale()) return;
      entry.state = 'bootstrapping';
      entry.sessionId = null;
      try {
        const status = await this._bootstrapOnce(entry, gen);
        if (status === 'live' || status === 'stale') return;
        // 'missing' cold start: give up after 60 s and 5 attempts; 'unavailable': keep retrying
        if (status === 'missing' && attempt >= 4 && Date.now() - startedAt >= 60000) {
          return this._detach(entry, new Error('document not found: ' + entry.id));
        }
        entry.state = 'retrying';
      } catch (e) {
        if (stale()) return;
        const c = code(e), msg = String(e.message || e);
        if (c === Code.PermissionDenied) return this._detach(entry, e);
        if (c === Code.FailedPrecondition && /no active streams|is not assigned to this pod/.test(msg)) return this.abort.abort();
        if (c === Code.FailedPrecondition && /system-doc-discard-local/.test(msg)) entry.document.reset();
        this.logger.warn('sync: bootstrap ' + entry.id + ' failed (attempt ' + (attempt + 1) + '): ' + msg);
        entry.state = 'retrying';
      }
    }
  }

  async _bootstrapOnce(entry, gen) {
    const { id, document } = entry;
    const loro = document.loro;
    const vv = loro.oplogVersion();
    const cold = vv.length() === 0;
    const res = await this._command({ case: 'beginDocumentSync', value: { documentId: id, clientVv: cold ? EMPTY : vv.encode(), ephemeral: false } }, BOOTSTRAP_MS);
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
    await this._command({ case: 'applyBootstrapUpdates', value: { documentId: id, sessionId, baseServerVv: EMPTY, updates: catchup } }, BOOTSTRAP_MS);
    if (gen !== entry.gen) return 'stale';
    await timeout(entry.complete.promise, BOOTSTRAP_MS, 'Bootstrap timeout exceeded');
    entry.complete = null;
    if (gen !== entry.gen) return 'stale';
    entry.state = 'live';
    entry.liveSince = Date.now();
    entry.ready.resolve(document);
    this._flush(entry);
    return 'live';
  }

  // ---- outbound live updates: 5 ms trailing batch, one in-flight send per document (§2.4) ----

  _queue(entry, bytes) {
    entry.queue.push(bytes);
    if (entry.state === 'live' && !entry.timer) {
      entry.timer = setTimeout(() => { entry.timer = null; this._flush(entry); }, BATCH_MS);
    }
  }

  async _flush(entry) {
    if (entry.inflight || !entry.queue.length || entry.state !== 'live') return;
    if (entry.liveSince && Date.now() - entry.liveSince > STABLE_MS) entry.resyncs = 0;
    const updates = entry.queue.splice(0);
    if (updates.reduce((n, u) => n + u.length, 0) > OUTBOUND_BUDGET) return this._resync(entry, 'outbound buffer overflow');
    const { id, sessionId } = entry;
    entry.inflight = true;
    try {
      await this._command({ case: 'liveDocumentUpdate', value: { documentId: id, sessionId, updates } });
    } catch (e) {
      if (entry.sessionId !== sessionId) return;
      const c = code(e);
      if (c === Code.PermissionDenied) return this._detach(entry, e);
      if (c !== Code.Canceled) this._resync(entry, 'live update failed: ' + (e.message || e));
      return;
    } finally {
      entry.inflight = false;
    }
    if (entry.queue.length) this._flush(entry);
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

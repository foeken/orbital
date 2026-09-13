'use strict';
// A subscribed Loro document (generic over Tana document types), configured like the web client (protocol doc §3, §4).
const { EventEmitter } = require('node:events');
const { LoroDoc, UndoManager } = require('loro-crdt');

class Document extends EventEmitter {
  constructor(id, { peerId } = {}) {
    super();
    this.id = id;
    this.peerId = peerId;
    this._init(new LoroDoc());
  }

  _init(loro) {
    if (this.peerId) loro.setPeerId(this.peerId);
    loro.setRecordTimestamp(true);
    loro.setChangeMergeInterval(60);
    this.loro = loro;
    this.data = loro.getMap('data');
    this.content = loro.getMap('content');
    this._exported = loro.oplogVersion();
    // Local-only, CRDT-aware undo: remote changes are never undone, concurrent edits are transformed against.
    this.undoManager = new UndoManager(loro, { mergeInterval: 0, maxUndoSteps: 200 }) // one step per transact; typing is already grouped by the caller;
  }

  toJSON() { return this.loro.toJSON(); }

  // Current oplog version vector, encoded (for begin_document_sync).
  version() { return this.loro.oplogVersion().encode(); }

  // Run local mutations, commit, and emit the update since the last exported version.
  transact(fn) {
    fn(this.loro);
    this.loro.commit();
    this._flushLocal();
  }

  undo() { const did = this.undoManager.undo(); if (did) this._flushLocal(); return did; }
  redo() { const did = this.undoManager.redo(); if (did) this._flushLocal(); return did; }
  canUndo() { return this.undoManager.canUndo(); }
  canRedo() { return this.undoManager.canRedo(); }

  // Export whatever local ops were committed since the last export and announce them.
  _flushLocal() {
    const now = this.loro.oplogVersion();
    if (now.compare(this._exported) === 0) return;
    const bytes = this.exportSince(this._exported);
    this.emit('local-update', bytes);
    this.emit('change', { origin: 'local' });
  }

  // Export ops since `vv` (a VersionVector), or a full snapshot when `vv` is omitted; marks everything as exported.
  exportSince(vv) {
    const bytes = vv ? this.loro.export({ mode: 'update', from: vv }) : this.loro.export({ mode: 'snapshot' });
    this._exported = this.loro.oplogVersion();
    return bytes;
  }

  // Import update/snapshot blobs from the server. Returns true when an import left ops pending (missing deps).
  applyRemote(updates) {
    let pending = false;
    for (const u of updates) if (this.loro.import(u).pending) pending = true;
    this._exported = this.loro.oplogVersion();
    this.emit('change', { origin: 'remote' });
    return pending;
  }

  // Discard local state (resync_required with DISCARD_LOCAL).
  reset() {
    this._init(new LoroDoc());
    this.emit('change', { origin: 'remote' });
  }
}

module.exports = { Document };

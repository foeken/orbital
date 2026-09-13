# sdk/ — Tana platform SDK (Connect-RPC + Loro)

Generic client for Tana's platform services; nothing here knows about "tasks". See docs/SDK.md for the contract and
docs/PLATFORM-PROTOCOL.md for the wire protocol.

    const { createTanaClient, readNode, setTitle, setState, contentText, derivePeerId } = require('./sdk');
    const client = createTanaClient({ getAccessToken, orgId, peerId, storageId, logger });
    const { nodes } = await client.graph.listNodes({ nodeTypes: ['text'], assignedTo: [me], stateTypes: ['open'], limit: 500 });
    await client.sync.connect();                       // resolves after the server 'peer' frame; reconnects in the background
    const doc = await client.sync.subscribe(id);       // Document, live after bootstrap
    readNode(doc).title; contentText(doc);
    setTitle(doc, 'New title');                        // sent as live_document_update within 5 ms
    client.sync.on('change', (id, { origin }) => ...); // origin: 'remote' | 'local'
    await client.close();

Modules: transport.js (auth headers, one retry after a 401), graph.js (GraphService in protobuf-JSON form),
sync.js (ServerSync stream, watchdog, backoff, per-document bootstrap/live/resync, batching), document.js (LoroDoc wrapper),
node.js (data-map accessors and content rendering).

Notes
- peerId: derivePeerId(userExternalId) gives a fresh nonce per process; pass storageId (persisted UUID) for a non-ephemeral peer, omit it for ephemeral.
- sync events: connected, disconnected, heartbeat, change, error, ephemeral. Errors inside handlers are logged and re-emitted as 'error', never thrown.
- subscribe() before connect() waits until the stream is up. Documents are re-bootstrapped after every reconnect; the same Document object is kept.
- listNodes only returns totalCount when the request uses mode LIST_NODES_MODE_WITH_COUNT.
- Offline self-check: node scripts/sdk-check.js (uses scripts/fixtures/task-snapshot.b64).

